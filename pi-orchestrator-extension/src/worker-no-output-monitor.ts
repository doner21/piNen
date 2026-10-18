import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  appendFileSync, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, rmSync, statSync, truncateSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactActionText } from "./action-evidence";
import { sanitizeWorkerText } from "./streaming-redactor.cjs";
import { CommandTelemetryOwner, type CommandTelemetryOwnerConfiguration } from "./command-telemetry-owner.cjs";

export const NO_OUTPUT_MONITOR_READY_MARKER = "NO_OUTPUT_MONITOR_READY:v1";
const SUPERVISOR_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "no-output-test-supervisor.cjs");
const IO_OBSERVER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "no-output-io-observer.cjs");
const WINDOWS_IO_SAMPLER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "windows-process-io-sampler.ps1");
const MAX_EVENT_READ_BYTES_PER_POLL = 256 * 1024;
const MAX_COUNTER_NATIVE_RESPONSE_BYTES_PER_CYCLE = 64 * 1024;
const MAX_EVENT_SOURCE_BYTES_PER_CYCLE = 56 * 1024;
const MAX_EVENT_REMAINDER_BYTES = 256 * 1024;
const MAX_CANCELLATIONS_PER_COMMAND = 200;

type Policy = {
  minimumObservationMs: number;
  alarmAfterMs: number;
  cancelAfterMs: number;
  minimumAlarmLeadMs: number;
  pollMs: number;
};
type SupervisorEvent = {
  schemaVersion: 1; commandId: string; invocationId: string; sequence: number;
  wallTime: string; type: string; auth: string; [key: string]: unknown;
};
type CancellationArtifact = {
  schemaVersion: 1;
  outcome: "cancelled_no_output";
  commandId: string;
  invocationId: string;
  summary: string;
  noOutputMs: number;
  totalElapsedMs: number;
  alarmMonotonicMs: number;
  alarmAcknowledgedMonotonicMs: number;
  cancelledMonotonicMs: number;
  cancellationRequested: true;
  cancellationAccepted: true;
  cancellationConfirmed: true;
  confirmationBasis: "terminal_signal_after_owned_handle_action";
  terminalExitCode: null;
  terminalSignal: "SIGTERM";
  cancellationTarget: "retained-direct-test-child-handle";
  eligibility: "authenticated_run_owned_test_child";
  observedSources: string[];
  observationErrors: string[];
  partialLog: string;
  invocationDescriptor?: Record<string, unknown>;
  declaredFileCapture?: Array<Record<string, unknown>>;
};
export interface NoOutputCancellationEvidence extends CancellationArtifact {
  artifactPath: string;
  artifactSha256: string;
  artifactBytes: number;
  artifactIntegrity: "verified" | "unavailable_or_changed";
}
type NoOutputDetails = BashToolDetails & {
  noOutput?: NoOutputCancellationEvidence & {
    cancellations: NoOutputCancellationEvidence[];
    minimumObservationMs: number;
    minimumAlarmLeadMs: number;
    cancellationCount: number;
    cancellationJournalPath: string;
    cancellationJournalSha256: string;
    inlineCancellationOmissions: number;
  };
  noOutputObservation?: { mode: "automatic_test_child" | "observe_only"; reason: string };
  noOutputAlarm?: Record<string, unknown>;
  noOutputCancellation?: NoOutputCancellationEvidence;
  monitorIo?: {
    eventBytesRead: number; eventFileBytes: number; maxBufferedEventBytes: number;
    maxActualReadAndDeliveryBytesPerCycle: number;
    corruptEventRecords: number;
    unavailableEventSourceDispositions: number;
    unavailableCounterErrorDispositions: number;
    retainedCounterServiceFailure?: { name: string; message: string };
    // HR3-EXTEND-SETTLEMENT-DIAGNOSTIC: every other settleResources step failure, reported beside the
    // command's own real outcome instead of becoming it (hard rule 3). nativeSettlement is only
    // ever "witnessed" for counter-service-close, and only when getTransportStats().nativeClosed was
    // true once settlement finished; every other step, and an unwitnessed counter-service-close, is
    // "not-established" -- an attempted close/drain/finalize does not by itself establish settlement.
    telemetrySettlementFailures?: Array<{ step: string; name: string; message: string; nativeSettlement: "witnessed" | "not-established" }>;
  };
  observationMetrics?: { processCounterActivity: number; counterUncertainty: number; queryOnlyBindings: number };
  declaredFileCapture?: Array<Record<string, unknown>>;
  telemetryAccounting?: {
    measurementStatus: "measured" | "unavailable";
    peakDiskBytes: number | null; peakFiles: number | null; peakCounterBytes: number | null;
    peakFileObservationBytes: number | null; peakEventBytes: number | null;
    peakControlBytes: number | null; peakTerminalBytes: number | null;
    maxQueuedBytes: number; maxInFlight: number; maxPollBytes: number;
  };
  invocationTelemetry?: Array<Record<string, unknown>>;
  commandOwnerAccounting?: Record<string, unknown>;
};

const DEFAULT_POLICY: Policy = Object.freeze({
  minimumObservationMs: 2 * 60_000,
  alarmAfterMs: 5 * 60_000,
  cancelAfterMs: 10 * 60_000,
  minimumAlarmLeadMs: 30_000,
  pollMs: 1_000,
});
function policyFromEnvironment(): Policy {
  let configured: Partial<Policy> = {};
  if (process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY) configured = JSON.parse(process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY) as Partial<Policy>;
  const policy = { ...DEFAULT_POLICY, ...configured };
  for (const key of Object.keys(DEFAULT_POLICY) as Array<keyof Policy>) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new Error(`Invalid no-output policy ${key}`);
  }
  if (policy.minimumObservationMs > policy.alarmAfterMs || policy.alarmAfterMs >= policy.cancelAfterMs) throw new Error("No-output policy requires minimumObservation <= alarm < cancellation");
  return policy;
}
function quotePosix(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function shellPath(value: string): string { return process.platform === "win32" ? value.replace(/\\/g, "/") : value; }
function canonicalSigned(value: Record<string, unknown>): string { const copy = { ...value }; delete copy.auth; return JSON.stringify(copy); }
function sign(value: Record<string, unknown>, key: string): string { return createHmac("sha256", key).update(canonicalSigned(value)).digest("hex"); }
function authenticate(event: SupervisorEvent, key: string, commandId: string): boolean {
  if (event.schemaVersion !== 1 || event.commandId !== commandId || typeof event.auth !== "string") return false;
  const expected = Buffer.from(sign(event, key), "hex");
  let actual: Buffer;
  try { actual = Buffer.from(event.auth, "hex"); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
function boundedFirstTail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const half = Math.floor(maxBytes / 2);
  return `${utf8Prefix(value, half)}\n[...sealed middle omitted...]\n${utf8Tail(value, maxBytes - half)}`;
}
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type OwnerReadPermission = {
  permission: NonNullable<ReturnType<CommandTelemetryOwner["reserveHostWork"]>>;
  grantId?: string;
  totalActualBytes: number;
  cycleActualBytes: number;
  descriptorTransferred?: boolean;
};
type FileReadReservation = { ownerPermission?: OwnerReadPermission };
export type FileReadWithinCycleOutcome =
  | { kind: "read"; bytes: Buffer }
  | { kind: "deferred" }
  | { kind: "unavailable" };

/** One fair read/delivery cycle shared by every telemetry source. Reservations happen before I/O. */
export class SharedReadBudget {
  private currentCycleBytes = 0;
  private maxCycleBytes = 0;
  private currentActualBytes = 0;
  private maxActualBytes = 0;
  private sourceBytes = new Map<string, number>();
  private actualSourceBytes = new Map<string, number>();
  private outstandingHelperReads = new Map<string, { bytes: number; invocationId?: string }>();
  private ownerPermissions: OwnerReadPermission[] = [];
  constructor(readonly limitBytes = MAX_EVENT_READ_BYTES_PER_POLL, private readonly commandOwner?: CommandTelemetryOwner) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error("INVALID_SHARED_READ_BUDGET");
  }
  beginCycle(): void {
    this.finalizeCycle();
    const outstanding = [...this.outstandingHelperReads.values()].reduce((sum, grant) => sum + grant.bytes, 0);
    if (outstanding > this.limitBytes) throw new Error("OUTSTANDING_HELPER_READ_GRANTS_EXCEED_GLOBAL_LIMIT");
    this.currentCycleBytes = outstanding; this.currentActualBytes = 0;
    this.sourceBytes.clear(); this.actualSourceBytes.clear();
    if (outstanding > 0) this.sourceBytes.set("outstanding-helper-read-grants", outstanding);
    this.maxCycleBytes = Math.max(this.maxCycleBytes, this.currentCycleBytes);
  }
  reserveBeforeRead(requestedBytes: number, source: string): number {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) throw new Error("INVALID_SHARED_READ_RESERVATION");
    const granted = Math.min(requestedBytes, this.limitBytes - this.currentCycleBytes);
    if (granted <= 0) return 0;
    if (this.commandOwner) {
      const permission = this.commandOwner.reserveHostWork("__command__", "ordinary", granted);
      if (!permission) return 0;
      this.ownerPermissions.push({ permission, totalActualBytes: 0, cycleActualBytes: 0 });
    }
    this.currentCycleBytes += granted;
    this.maxCycleBytes = Math.max(this.maxCycleBytes, this.currentCycleBytes);
    this.sourceBytes.set(source, (this.sourceBytes.get(source) ?? 0) + granted);
    return granted;
  }
  reserveExactBeforeRead(requestedBytes: number, source: string): boolean {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) throw new Error("INVALID_SHARED_READ_RESERVATION");
    if (this.currentCycleBytes + requestedBytes > this.limitBytes) return false;
    return this.reserveBeforeRead(requestedBytes, source) === requestedBytes;
  }
  beginFileRead(requestedBytes: number, source: string): FileReadReservation | undefined {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) throw new Error("INVALID_SHARED_READ_RESERVATION");
    // A zero-byte file still allocates a native descriptor. One byte of the
    // existing allowance conservatively owns that handle until close settles.
    const reservedBytes = Math.max(1, requestedBytes);
    if (this.currentCycleBytes + reservedBytes > this.limitBytes) return undefined;
    let ownerPermission: OwnerReadPermission | undefined;
    if (this.commandOwner) {
      const permission = this.commandOwner.reserveHostReaderWork("__command__", "ordinary", reservedBytes);
      if (!permission) return undefined;
      ownerPermission = { permission, totalActualBytes: 0, cycleActualBytes: 0 };
      this.ownerPermissions.push(ownerPermission);
    }
    this.currentCycleBytes += reservedBytes;
    this.maxCycleBytes = Math.max(this.maxCycleBytes, this.currentCycleBytes);
    this.sourceBytes.set(source, (this.sourceBytes.get(source) ?? 0) + reservedBytes);
    return { ownerPermission };
  }
  /** Existing owner committed-reader admission, queried after the owner's own reconcile of retained descriptors. */
  readerAdmissionAvailable(): boolean {
    return this.commandOwner ? this.commandOwner.committedReaderAdmissionAvailable() : true;
  }
  consumeFileRead(reservation: FileReadReservation, bytes: number, source: string): void {
    this.consumeActual(bytes, source);
    if (reservation.ownerPermission) {
      reservation.ownerPermission.totalActualBytes += bytes;
      reservation.ownerPermission.cycleActualBytes += bytes;
    }
  }
  closeFileRead(reservation: FileReadReservation, descriptor: number, source: string): boolean {
    try { closeSync(descriptor); return true; }
    catch (error) {
      let conclusivelyClosed = false;
      try { fstatSync(descriptor); }
      catch (probeError) { conclusivelyClosed = (probeError as NodeJS.ErrnoException)?.code === "EBADF"; }
      if (conclusivelyClosed) return true;
      const ownerPermission = reservation.ownerPermission;
      if (ownerPermission && this.commandOwner) {
        this.commandOwner.retainHostReaderDescriptor(
          descriptor,
          ownerPermission.permission,
          ownerPermission.totalActualBytes,
          { source, reason: String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error) },
        );
        ownerPermission.descriptorTransferred = true;
      }
      return false;
    }
  }
  grantHelperRead(bytes: number, source: string, grantId: string, invocationId?: string): void {
    if (!grantId || !Number.isSafeInteger(bytes) || bytes <= 0 || this.outstandingHelperReads.has(grantId)) {
      throw new Error("DUPLICATE_OR_INVALID_HELPER_READ_GRANT");
    }
    if (!this.reserveExactBeforeRead(bytes * 2, source)) throw new Error("GLOBAL_POLL_DELIVERY_CREDIT_EXCEEDED");
    this.consumeActual(bytes, `${source}:delivery`);
    const ownerPermission = this.commandOwner ? this.ownerPermissions[this.ownerPermissions.length - 1] : undefined;
    if (ownerPermission) {
      ownerPermission.grantId = grantId;
      ownerPermission.totalActualBytes += bytes;
      ownerPermission.cycleActualBytes += bytes;
    }
    this.outstandingHelperReads.set(grantId, { bytes, invocationId });
  }
  consumeHelperReadGrant(grantId: string, bytes: number, invocationId?: string): boolean {
    const grant = this.outstandingHelperReads.get(grantId);
    if (!grant || grant.bytes !== bytes || (grant.invocationId && invocationId && grant.invocationId !== invocationId)) return false;
    this.consumeActual(bytes, "helper-read-consumed");
    const ownerPermission = this.ownerPermissions.find((entry) => entry.grantId === grantId);
    if (ownerPermission) {
      ownerPermission.totalActualBytes += bytes;
      ownerPermission.cycleActualBytes += bytes;
    }
    this.outstandingHelperReads.delete(grantId);
    return true;
  }
  abandonHelperReadGrants(invocationId: string): void {
    for (const [grantId, grant] of this.outstandingHelperReads) if (grant.invocationId === invocationId) this.outstandingHelperReads.delete(grantId);
  }
  consumeActual(bytes: number, source: string): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.currentActualBytes + bytes > this.currentCycleBytes) {
      throw new Error("ACTUAL_READ_OR_DELIVERY_EXCEEDED_RESERVED_CREDITS");
    }
    this.currentActualBytes += bytes;
    this.maxActualBytes = Math.max(this.maxActualBytes, this.currentActualBytes);
    this.actualSourceBytes.set(source, (this.actualSourceBytes.get(source) ?? 0) + bytes);
  }
  finalizeCycle(): void {
    if (!this.commandOwner) { this.ownerPermissions = []; this.currentActualBytes = 0; return; }
    let actualRemaining = this.currentActualBytes
      - this.ownerPermissions.reduce((sum, entry) => sum + entry.cycleActualBytes, 0);
    if (actualRemaining < 0) throw new Error("OWNER_PERMISSION_ACTUAL_ACCOUNTING_INVALID");
    const retained: typeof this.ownerPermissions = [];
    for (const entry of this.ownerPermissions) {
      if (entry.descriptorTransferred) continue;
      if (entry.grantId && this.outstandingHelperReads.has(entry.grantId)) {
        entry.cycleActualBytes = 0;
        retained.push(entry);
        continue;
      }
      const unassignedCapacity = entry.permission.maxBytes - entry.totalActualBytes;
      const assigned = Math.min(unassignedCapacity, actualRemaining);
      entry.totalActualBytes += assigned;
      actualRemaining -= assigned;
      this.commandOwner?.completeHostWork(entry.permission, entry.totalActualBytes);
    }
    if (actualRemaining !== 0) throw new Error("OWNER_PERMISSION_ACTUAL_ACCOUNTING_INVALID");
    this.ownerPermissions = retained;
    this.currentActualBytes = 0;
  }
  accounting(): {
    currentCycleBytes: number; maxCycleBytes: number; currentActualBytes: number; maxActualBytes: number;
    sourceBytes: Record<string, number>; actualSourceBytes: Record<string, number>; outstandingHelperReadBytes: number;
  } {
    return {
      currentCycleBytes: this.currentCycleBytes, maxCycleBytes: this.maxCycleBytes,
      currentActualBytes: this.currentActualBytes, maxActualBytes: this.maxActualBytes,
      sourceBytes: Object.fromEntries(this.sourceBytes), actualSourceBytes: Object.fromEntries(this.actualSourceBytes),
      outstandingHelperReadBytes: [...this.outstandingHelperReads.values()].reduce((sum, grant) => sum + grant.bytes, 0),
    };
  }
}

type EventSourceState = { offset: number; remainder: string; decoder: TextDecoder;
  retirement?: "pending" | "unavailable"; sealedSize?: number; sealReported?: boolean; readerBlocked?: boolean };

/** Incremental event reader: each byte is read at most once and only a partial line is buffered. */
export class EventReader {
  private readonly states = new Map<string, EventSourceState>();
  eventBytesRead = 0;
  corruptEventRecords = 0;
  /** Reader-owned count of retained-unavailable event-source dispositions, one per source. */
  unavailableEventSourceDispositions = 0;
  maxBufferedEventBytes = 0;
  eventFileBytes = 0;
  maxPollBytes = 0;
  private retiredFileBytes = 0;
  private fairCursor = 0;
  private currentPollBytes = 0;
  private currentExternalDeliveryBytes = 0;
  readonly sharedBudget: SharedReadBudget;
  constructor(
    private readonly directory: string,
    sharedBudget?: SharedReadBudget,
    private readonly cycleReserveBytes = 0,
  ) { this.sharedBudget = sharedBudget ?? new SharedReadBudget(); }
  private removeConclusive(file: string): boolean {
    try { rmSync(file, { force: true }); } catch {}
    try { lstatSync(file); return false; }
    catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
  }
  retire(invocationId: string, _transportId?: string): boolean {
    let settled = true;
    for (const file of [path.join(this.directory, `${invocationId}.jsonl`),
      path.join(this.directory, `${invocationId}.terminal.json`)]) {
      let size = 0;
      try { size = statSync(file).size; } catch {}
      if (this.removeConclusive(file)) {
        this.retiredFileBytes += size;
        this.states.delete(file);
      } else {
        settled = false;
        const state = this.states.get(file) ?? { offset: 0, remainder: "", decoder: new TextDecoder() };
        state.retirement = "unavailable";
        if (!state.sealReported) {
          state.sealReported = true;
          this.unavailableEventSourceDispositions += 1;
        }
        this.states.set(file, state);
      }
    }
    this.eventFileBytes = Math.max(this.eventFileBytes, this.retiredFileBytes);
    return settled;
  }
  chargeExternal(bytes: number, source = "external-delivery-and-helper-read", grantId?: string, invocationId?: string): void {
    const completeWork = bytes * 2; // host publication plus exactly one signed helper read grant
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(completeWork)) throw new Error("GLOBAL_POLL_DELIVERY_CREDIT_EXCEEDED");
    if (grantId) this.sharedBudget.grantHelperRead(bytes, source, grantId, invocationId);
    else {
      if (!this.sharedBudget.reserveExactBeforeRead(completeWork, source)) throw new Error("GLOBAL_POLL_DELIVERY_CREDIT_EXCEEDED");
      this.sharedBudget.consumeActual(completeWork, source);
    }
    this.currentExternalDeliveryBytes += completeWork;
    this.maxPollBytes = Math.max(this.maxPollBytes, this.sharedBudget.accounting().currentCycleBytes);
  }
  recordSharedPeak(): void { this.maxPollBytes = Math.max(this.maxPollBytes, this.sharedBudget.accounting().currentCycleBytes); }
  readFileWithinCycleOutcome(file: string, maxBytes: number, source: string, containmentRoot?: string): FileReadWithinCycleOutcome {
    let descriptor: number | undefined;
    let reservation: FileReadReservation | undefined;
    let outcome: FileReadWithinCycleOutcome = { kind: "unavailable" };
    try {
      const before = lstatSync(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)
        || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return outcome;
      const openedSize = Number(before.size);
      const canonical = realpathSync(file);
      if (containmentRoot && !isWithin(realpathSync(containmentRoot), canonical)) return outcome;
      reservation = this.sharedBudget.beginFileRead(openedSize, source);
      if (!reservation) return { kind: "deferred" };
      descriptor = openSync(canonical, "r");
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return outcome;
      const bytes = Buffer.alloc(openedSize);
      const read = openedSize > 0 ? readSync(descriptor, bytes, 0, openedSize, 0) : 0;
      this.sharedBudget.consumeFileRead(reservation, read, source);
      if (read !== openedSize) return outcome;
      const afterHandle = fstatSync(descriptor, { bigint: true });
      const afterPath = lstatSync(file, { bigint: true });
      if (!afterPath.isFile() || afterPath.isSymbolicLink()
        || afterHandle.dev !== opened.dev || afterHandle.ino !== opened.ino || afterHandle.size !== opened.size
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size
        || realpathSync(file) !== canonical) return outcome;
      this.maxPollBytes = Math.max(this.maxPollBytes, this.sharedBudget.accounting().currentCycleBytes);
      outcome = { kind: "read", bytes };
    } catch { outcome = { kind: "unavailable" }; }
    finally {
      if (descriptor !== undefined && reservation && !this.sharedBudget.closeFileRead(reservation, descriptor, source)) {
        outcome = { kind: "unavailable" };
      }
    }
    return outcome;
  }
  readFileWithinCycle(file: string, maxBytes: number, source: string, containmentRoot?: string): Buffer | undefined {
    const outcome = this.readFileWithinCycleOutcome(file, maxBytes, source, containmentRoot);
    return outcome.kind === "read" ? outcome.bytes : undefined;
  }
  hasPending(): boolean {
    let names: string[];
    try { names = readdirSync(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error; // inaccessible metadata cannot prove an empty source set
    }
    let readerAdmission: boolean | undefined;
    for (const name of names) {
      const file = path.join(this.directory, name);
      if (name.endsWith(".jsonl") || name.endsWith(".terminal.json")) {
        const state = this.states.get(file);
        try {
          const size = statSync(file).size;
          if (!state || (state.retirement !== "unavailable" && (size > state.offset || state.retirement === "pending"))) return true;
          // A source blocked only by a still-owned native reader descriptor is a
          // reported retained-unavailable obligation while owner reader admission
          // stays unavailable. The admission query re-attempts that native close,
          // so the same caller resumes once it settles.
          if (state.readerBlocked && size > state.offset) {
            if (readerAdmission === undefined) readerAdmission = this.sharedBudget.readerAdmissionAvailable();
            if (readerAdmission) return true;
          }
        } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && state?.retirement !== "unavailable") return true; }
      }
    }
    return false;
  }
  poll(_final = false): SupervisorEvent[] {
    this.currentPollBytes = 0; this.currentExternalDeliveryBytes = 0; this.sharedBudget.beginCycle();
    if (this.cycleReserveBytes > 0 && !this.sharedBudget.reserveExactBeforeRead(this.cycleReserveBytes, "counter-native-response-grant")) {
      throw new Error("COUNTER_NATIVE_RESPONSE_GRANT_UNAVAILABLE");
    }
    const pollStartBytes = this.eventBytesRead;
    const events: SupervisorEvent[] = [];
    let names: string[];
    try { names = readdirSync(this.directory).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return events;
      throw error;
    }
    // A prior source unlink may have settled while its seal unlink did not.
    // The same reader state owns that remaining obligation even though the
    // source no longer appears in directory enumeration.
    for (const [file, state] of this.states) {
      if (state.sealedSize === undefined || names.includes(path.basename(file))) continue;
      try { lstatSync(file); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") continue; }
      if (this.removeConclusive(`${file}.sealed`)) {
        this.retiredFileBytes += state.sealedSize + Buffer.byteLength(String(state.sealedSize));
        this.states.delete(file);
      } else state.retirement = "unavailable";
    }
    const sources = names
      .filter((name) => name.endsWith(".jsonl") || name.endsWith(".terminal.json"))
      .map((name) => ({ name, file: path.join(this.directory, name), stream: true }));
    if (sources.length === 0) return events;
    let budget = MAX_EVENT_SOURCE_BYTES_PER_CYCLE; // leave shared credits for native responses, helper grants, artifacts and capture
    let totalFileBytes = 0;
    for (const source of sources) { try { totalFileBytes += statSync(source.file).size; } catch {} }
    let idleVisits = 0;
    const unavailableThisPoll = new Set<string>();
    const retiredThisPoll = new Set<string>();
    // A source whose read cannot settle because a native reader descriptor is
    // still owned keeps its offset; it is reported once and left for recovery.
    const retainReaderBlocked = (file: string, state: EventSourceState, reason: string): void => {
      state.retirement = "unavailable";
      state.readerBlocked = true;
      if (!state.sealReported) {
        events.push({ schemaVersion: 1, commandId: "", invocationId: "", sequence: 0,
          wallTime: new Date().toISOString(), type: "observation_error", auth: "unavailable",
          observationError: reason });
        state.sealReported = true;
        this.unavailableEventSourceDispositions += 1;
      }
      this.states.set(file, state);
      unavailableThisPoll.add(file);
    };
    let index = this.fairCursor % sources.length;
    while (budget > 0 && idleVisits < sources.length) {
      const source = sources[index];
      if (retiredThisPoll.has(source.file)) {
        idleVisits += 1;
        index = (index + 1) % sources.length;
        continue;
      }
      let consumed = 0;
      if (source.stream) {
        const state = this.states.get(source.file) ?? { offset: 0, remainder: "", decoder: new TextDecoder() };
        let size: number | undefined;
        try { size = statSync(source.file).size; }
        catch {
          state.retirement = "unavailable";
          if (!state.sealReported) {
            events.push({ schemaVersion: 1, commandId: "", invocationId: "", sequence: 0,
              wallTime: new Date().toISOString(), type: "observation_error", auth: "unavailable",
              observationError: "event source metadata unavailable" });
            state.sealReported = true;
            this.unavailableEventSourceDispositions += 1;
          }
          this.states.set(source.file, state);
          unavailableThisPoll.add(source.file);
        }
        if (size !== undefined && state.offset < size) {
          const readSource = source.name.endsWith(".terminal.json") ? "terminal" : "events";
          const requested = Math.min(16 * 1024, size - state.offset, budget);
          const reservation = this.sharedBudget.beginFileRead(requested, readSource);
          if (!reservation) {
            // Credit refusal is progressable next cycle and stays pending. Refusal
            // because an owned reader descriptor blocks owner admission is not.
            if (this.sharedBudget.readerAdmissionAvailable()) break;
            retainReaderBlocked(source.file, state, "event source reader admission unavailable");
            idleVisits += 1;
            index = (index + 1) % sources.length;
            continue;
          }
          let descriptor: number | undefined;
          let buffer: Buffer | undefined;
          let read = 0;
          let closed = true;
          try {
            descriptor = openSync(source.file, "r");
            buffer = Buffer.allocUnsafe(requested);
            read = readSync(descriptor, buffer, 0, requested, state.offset);
            this.sharedBudget.consumeFileRead(reservation, read, readSource);
          } finally {
            if (descriptor !== undefined) closed = this.sharedBudget.closeFileRead(reservation, descriptor, readSource);
          }
          if (!closed) {
            // The owner now owns the unresolved descriptor. Keep the offset so
            // public recovery re-reads and delivers these bytes exactly once.
            retainReaderBlocked(source.file, state, "event source close unavailable");
            idleVisits += 1;
            index = (index + 1) % sources.length;
            continue;
          }
          state.readerBlocked = undefined;
          if (read === 0 && requested > 0) {
            state.retirement = "unavailable";
            if (!state.sealReported) {
              events.push({ schemaVersion: 1, commandId: "", invocationId: "", sequence: 0,
                wallTime: new Date().toISOString(), type: "observation_error", auth: "unavailable",
                observationError: "event source read unavailable" });
              state.sealReported = true;
              this.unavailableEventSourceDispositions += 1;
            }
          }
          if (read > 0 && buffer) {
            state.retirement = undefined;
            state.offset += read; consumed = read; budget -= read; this.eventBytesRead += read;
            const combined = state.remainder + state.decoder.decode(buffer.subarray(0, read), { stream: true });
            const lines = combined.split(/\r?\n/); state.remainder = lines.pop() ?? "";
            if (Buffer.byteLength(state.remainder, "utf8") > MAX_EVENT_REMAINDER_BYTES) throw new Error("NO_OUTPUT_EVENT_LINE_TOO_LARGE");
            this.maxBufferedEventBytes = Math.max(this.maxBufferedEventBytes, Buffer.byteLength(state.remainder, "utf8"));
            for (const line of lines) if (line) {
              try { events.push(JSON.parse(line) as SupervisorEvent); }
              catch {
                // A consumed complete record cannot become silent absence.
                // This diagnostic has no authentication or cancellation authority.
                this.corruptEventRecords += 1;
                events.push({ schemaVersion: 1, commandId: "", invocationId: "", sequence: 0,
                  wallTime: new Date().toISOString(), type: "observation_error", auth: "unavailable",
                  observationError: "malformed complete event JSON" });
              }
            }
          }
        }
        this.states.set(source.file, state);
        if (size !== undefined && /\.(?:events|controls)\.\d+\.jsonl$/.test(source.name)
          && state.offset >= size && state.remainder.length === 0) {
          const seal = `${source.file}.sealed`;
          if (state.sealedSize === undefined && !unavailableThisPoll.has(source.file)) {
            const sealOutcome = this.readFileWithinCycleOutcome(seal, 64, "event-seal", this.directory);
            if (sealOutcome.kind === "deferred") state.retirement = "pending";
            else if (sealOutcome.kind === "read") {
              const text = sealOutcome.bytes.toString("utf8").trim();
              if (/^(0|[1-9][0-9]*)$/.test(text) && Number(text) === size) state.sealedSize = size;
              else state.retirement = "unavailable";
            } else {
              try { lstatSync(seal); state.retirement = "unavailable"; }
              catch (error) { state.retirement = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : "unavailable"; }
            }
          }
          if (state.sealedSize !== undefined) {
            // Remove the source first; a no-op or uncertain removal retains its
            // seal and offset. Never reread/redeliver it within this poll.
            if (this.removeConclusive(source.file) && this.removeConclusive(seal)) {
              this.retiredFileBytes += size + Buffer.byteLength(String(size));
              this.states.delete(source.file);
              retiredThisPoll.add(source.file);
            } else state.retirement = "unavailable";
          }
          // A valid seal whose conclusive source/seal removal failed is also a
          // retained-unavailable obligation; sealedSize and offset are kept so
          // a later public poll retires it without redelivery.
          if (state.retirement === "unavailable" && !state.remainder
            && state.offset >= size && !state.sealReported) {
            events.push({ schemaVersion: 1, commandId: "", invocationId: "", sequence: 0,
              wallTime: new Date().toISOString(), type: "observation_error", auth: "unavailable",
              observationError: state.sealedSize === undefined ? "event source seal unavailable" : "event source retirement unavailable" });
            state.sealReported = true;
            this.unavailableEventSourceDispositions += 1;
          }
          if (state.retirement === "unavailable") unavailableThisPoll.add(source.file);
          if (this.states.has(source.file)) this.states.set(source.file, state);
        }
      }
      idleVisits = consumed > 0 ? 0 : idleVisits + 1;
      index = (index + 1) % sources.length;
    }
    this.fairCursor = index;
    this.eventFileBytes = Math.max(this.eventFileBytes, this.retiredFileBytes + totalFileBytes);
    this.currentPollBytes = this.eventBytesRead - pollStartBytes;
    this.currentExternalDeliveryBytes = 0;
    this.maxPollBytes = Math.max(this.maxPollBytes, this.sharedBudget.accounting().currentCycleBytes);
    events.sort((left, right) => {
      if (left.transportId && left.transportId === right.transportId) return Number(left.transportGeneration ?? 0) - Number(right.transportGeneration ?? 0);
      return 0;
    });
    return events;
  }
}

/** Native request submission disposition: only a submitted request can receive a native response. */
export type NativeRequestDisposition = "submitted" | "coalesced" | "unsubmitted";

/** @internal Exported for isolated production-path protocol regressions. */
export class WindowsIoCounterService {
  private child: ChildProcessWithoutNullStreams | undefined;
  private childClosed: Promise<void> | undefined;
  private nativeClosed = false;
  private readonly active = new Map<string, {
    invocationId: string;
    bindingGeneration: string;
    inFlightRequestId?: string;
    lastRequestGeneration: number;
    transportGeneration: number;
    registered?: boolean;
    unregistering?: boolean;
  }>();
  private readonly latestCounterStates = new Map<string, Record<string, unknown>>();
  private readonly counterStateWaiters = new Map<string, Array<{ afterGeneration: number; resolve: (state: Record<string, unknown>) => void; reject: (error: Error) => void }>>();
  private decoder = new StringDecoder("utf8");
  private remainder = "";
  private closing = false;
  private ready = false;
  private stderrTail = "";
  private readonly readyListeners = new Set<() => void>();
  private readonly sendQueue: string[] = [];
  private sendQueueBytes = 0;
  private maxQueuedBytes = 0;
  private writeBlocked = false;
  private readonly maxQueueBytes = 64 * 1024;
  private transportFailure: Error | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly queueCloseWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private nativeResponseBytesThisCycle = 0;
  private prepaidNativeResponseBytes = 0;
  private nativeResponsePaused = false;
  private suppressNativeResponses = false;

  constructor(
    private readonly _eventDir: string,
    private readonly authKey: string,
    private readonly commandId: string,
    private readonly sharedReadBudget?: SharedReadBudget,
    private readonly stateSink?: (invocationId: string, state: Record<string, unknown>, bytes: Buffer, nativeFrameBytes: number) => void,
  ) {}

  start(): Promise<void> {
    // Startup owns one native sampler for the lifetime of this service. A
    // second caller joins its readiness/failure instead of overwriting child.
    if (!this.startPromise) this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (process.platform !== "win32") throw new Error("WINDOWS_IO_COUNTER_BACKEND_UNSUPPORTED");
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error("WINDOWS_IO_COUNTER_SYSTEMROOT_UNAVAILABLE");
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!existsSync(powershell) || !existsSync(WINDOWS_IO_SAMPLER_PATH)) throw new Error("WINDOWS_IO_COUNTER_SAMPLER_UNAVAILABLE");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_IO_SAMPLER_PATH];
    if (process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_READY === "1") args.push("-ExitAfterReady");
    const exitAfterSamples = Number(process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_SAMPLES);
    if (Number.isSafeInteger(exitAfterSamples) && exitAfterSamples > 0) args.push("-ExitAfterSamples", String(exitAfterSamples));
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    this.child = spawn(powershell, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false });
    // Install the native terminal witness before readiness or any close call.
    // An exit code is not proof that inherited stdout/stderr have closed.
    const spawned = this.child;
    this.nativeClosed = false;
    this.childClosed = new Promise<void>((resolve) => spawned.once("close", () => {
      this.nativeClosed = true;
      resolve();
    }));
    this.child.stderr.on("data", (chunk) => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4096); });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stdin.on("drain", () => { this.writeBlocked = false; this.flushQueue(); this.settleQueueWaiters(); });
    this.child.stdin.on("error", (error) => this.failTransport(error instanceof Error ? error : new Error(String(error))));
    const ready = new Promise<void>((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = (code: number | null) => { cleanup(); reject(new Error(`WINDOWS_IO_COUNTER_SAMPLER_START_FAILED code=${String(code)} ${this.stderrTail}`)); };
      const cleanup = () => { this.child?.off("error", onError); this.child?.off("close", onClose); this.readyListeners.delete(onReady); };
      this.readyListeners.add(onReady); this.child?.once("error", onError); this.child?.once("close", onClose);
    });
    this.child.once("close", () => {
      if (!this.closing) for (const [transportId, state] of this.active) this.writeState(transportId, state, { type: "counter_error", message: "counter sampler exited unexpectedly" });
      if (!this.closing) this.failTransport(new Error("WINDOWS_IO_COUNTER_SAMPLER_TRANSPORT_CLOSED"));
      this.active.clear();
      const closeError = new Error("WINDOWS_STATE_SERVICE_CLOSED");
      this.settleAllCounterWaiters(closeError);
      this.latestCounterStates.clear();
    });
    await ready;
  }

  register(event: SupervisorEvent): NativeRequestDisposition {
    if (!this.ready || !this.child?.stdin.writable) throw new Error("WINDOWS_IO_COUNTER_SAMPLER_NOT_READY");
    const transportId = String(event.transportId ?? "");
    const bindingGeneration = String(event.bindingGeneration ?? "");
    if (!/^[a-f0-9]{32}$/.test(transportId) || !/^[a-f0-9]{32}$/.test(bindingGeneration)) throw new Error("WINDOWS_IO_COUNTER_REGISTRATION_ID_INVALID");
    if (this.active.has(transportId)) throw new Error("WINDOWS_IO_COUNTER_DUPLICATE_REGISTRATION");
    if (this.active.size >= 200) throw new Error("WINDOWS_IO_COUNTER_ACTIVE_REGISTRATION_LIMIT");
    const state = { invocationId: event.invocationId, bindingGeneration, lastRequestGeneration: 0, transportGeneration: 0 };
    this.active.set(transportId, state);
    // A send throw happens before native submission: roll back only this
    // request's binding, then report the failure to the caller.
    try { this.send({ action: "register", transportId, bindingGeneration, pid: event.pid, expectedExecutable: event.expectedExecutable, earliestCreationUnixMs: event.earliestCreationUnixMs, latestCreationUnixMs: event.latestCreationUnixMs }); }
    catch (error) { this.active.delete(transportId); throw error; }
    return "submitted";
  }
  sample(event: SupervisorEvent): NativeRequestDisposition {
    const transportId = String(event.transportId ?? "");
    const state = this.active.get(transportId);
    if (!state || state.unregistering) return "unsubmitted";
    const requestId = String(event.requestId ?? "");
    const requestGeneration = Number(event.requestGeneration);
    if (event.bindingGeneration !== state.bindingGeneration || !/^[a-f0-9]{32}$/.test(requestId) || !Number.isSafeInteger(requestGeneration)) {
      this.writeState(transportId, state, { type: "counter_error", message: "counter request identity invalid" }); return "unsubmitted";
    }
    if (state.inFlightRequestId || requestGeneration <= state.lastRequestGeneration) return "coalesced"; // duplicate/missed opportunity: no native request
    const previousInFlight = state.inFlightRequestId;
    const previousGeneration = state.lastRequestGeneration;
    state.inFlightRequestId = requestId;
    state.lastRequestGeneration = requestGeneration;
    try { this.send({ action: "sample", transportId, bindingGeneration: state.bindingGeneration, requestId, requestGeneration }); }
    catch (error) {
      state.inFlightRequestId = previousInFlight;
      state.lastRequestGeneration = previousGeneration;
      throw error;
    }
    return "submitted";
  }
  waitForCounterState(transportId: string, afterGeneration = 0): Promise<Record<string, unknown>> {
    const current = this.latestCounterStates.get(transportId);
    if (current && Number(current.transportGeneration) > afterGeneration) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiters = this.counterStateWaiters.get(transportId) ?? [];
      if (waiters.length >= 64) { reject(new Error("WINDOWS_COUNTER_STATE_WAITER_LIMIT")); return; }
      waiters.push({ afterGeneration, resolve, reject }); this.counterStateWaiters.set(transportId, waiters);
    });
  }
  unregister(invocationId: string): void {
    const found = [...this.active.entries()].find(([, state]) => state.invocationId === invocationId && !state.unregistering);
    if (!found) return;
    const [transportId, state] = found;
    // The binding stays owned, marked unregistering, until the sampler's
    // matching 'unregistered' or 'error' frame or native service close settles
    // it. An unsubmitted unregister leaves the binding for a public retry.
    state.unregistering = true;
    try { this.send({ action: "unregister", transportId, bindingGeneration: state.bindingGeneration }); }
    catch (error) { state.unregistering = false; throw error; }
    this.latestCounterStates.delete(transportId);
    const error = new Error("WINDOWS_COUNTER_STATE_UNREGISTERED");
    for (const waiter of this.counterStateWaiters.get(transportId) ?? []) waiter.reject(error);
    this.counterStateWaiters.delete(transportId);
  }
  resolveInvocation(transportId: string): string | undefined { return this.active.get(transportId)?.invocationId; }
  beginReadCycle(): void {
    if (!this.sharedReadBudget) return;
    this.nativeResponseBytesThisCycle = 0;
    if (this.nativeResponsePaused) { this.nativeResponsePaused = false; this.child?.stdout.resume(); }
  }
  getTransportStats(): { queuedBytes: number; maxQueuedBytes: number; inFlight: number; nativeClosed: boolean; transportFailure: Error | undefined } {
    return { queuedBytes: this.sendQueueBytes + (this.child?.stdin.writableLength ?? 0), maxQueuedBytes: this.maxQueuedBytes, inFlight: [...this.active.values()].filter((state) => state.inFlightRequestId).length, nativeClosed: this.nativeClosed, transportFailure: this.transportFailure };
  }
  async failAndClose(message: string): Promise<void> {
    this.suppressNativeResponses = true;
    this.closing = true;
    for (const [transportId, state] of this.active) this.writeState(transportId, state, { type: "counter_error", message });
    await this.close();
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const attempt = this.closeInternal();
    this.closePromise = attempt;
    // A failed attempt is not terminal settlement: retain the child and let
    // a subsequent public close retry after the failing operation is repaired.
    void attempt.catch(() => { if (this.closePromise === attempt) this.closePromise = undefined; });
    return attempt;
  }
  private async closeInternal(): Promise<void> {
    if (!this.child) return;
    this.closing = true;
    const child = this.child;
    let failure: unknown;
    try {
      this.flushQueue();
      // A sampler that naturally closed before shutdown is already terminal;
      // its observation failure was sent to the registered invocation. Do not
      // turn that sensor loss into a failure of the legitimate bash command.
      if (this.transportFailure && !this.nativeClosed) throw this.transportFailure;
      if (!this.nativeClosed && (this.sendQueue.length > 0 || this.writeBlocked || child.stdin.writableLength > 0)) {
        await new Promise<void>((resolve, reject) => {
          this.queueCloseWaiters.push({ resolve, reject });
          this.settleQueueWaiters();
        });
      }
      if (this.transportFailure && !this.nativeClosed) throw this.transportFailure;
    } catch (error) { failure = error; }
    // Even on a failed flush, naturally finish the sampler's stdin and wait
    // for its actual close. An unsent control frame is an explicit failure,
    // never a reason to strand the native child or report healthy delivery.
    try {
      if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end();
      await this.childClosed;
    } catch (error) { if (!failure) failure = error; }
    const closeError = new Error("WINDOWS_STATE_SERVICE_CLOSED");
    this.settleAllCounterWaiters(closeError);
    this.latestCounterStates.clear();
    this.child = undefined;
    this.childClosed = undefined;
    if (failure) throw failure;
  }
  private settleAllCounterWaiters(error: Error): void {
    for (const waiters of this.counterStateWaiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.counterStateWaiters.clear();
  }
  private failTransport(error: Error): void {
    if (!this.transportFailure) this.transportFailure = error;
    while (this.queueCloseWaiters.length > 0) this.queueCloseWaiters.shift()!.reject(this.transportFailure);
    this.settleAllCounterWaiters(this.transportFailure);
  }
  private settleQueueWaiters(): void {
    if (this.transportFailure) {
      while (this.queueCloseWaiters.length > 0) this.queueCloseWaiters.shift()!.reject(this.transportFailure);
      return;
    }
    if (this.sendQueue.length === 0 && !this.writeBlocked && (this.child?.stdin.writableLength ?? 0) === 0) {
      while (this.queueCloseWaiters.length > 0) this.queueCloseWaiters.shift()!.resolve();
    }
  }
  private send(value: Record<string, unknown>): void {
    const frame = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > 4096) throw new Error("WINDOWS_IO_COUNTER_CONTROL_FRAME_TOO_LARGE");
    // A retained transport failure is final for submission: a later request is
    // refused explicitly with that failure (the caller's existing rollback
    // reports it), never accepted as submitted behind the failed delivery.
    if (this.transportFailure) throw this.transportFailure;
    const nativeQueued = this.child?.stdin.writableLength ?? 0;
    if (nativeQueued + this.sendQueueBytes + bytes > this.maxQueueBytes) throw new Error("WINDOWS_IO_COUNTER_CONTROL_QUEUE_OVERFLOW");
    if (this.writeBlocked || this.sendQueue.length > 0) {
      if (this.sendQueueBytes + bytes > this.maxQueueBytes) throw new Error("WINDOWS_IO_COUNTER_CONTROL_QUEUE_OVERFLOW");
      this.sendQueue.push(frame); this.sendQueueBytes += bytes; this.maxQueuedBytes = Math.max(this.maxQueuedBytes, this.sendQueueBytes); return;
    }
    if (!this.child?.stdin.writable) throw new Error("WINDOWS_IO_COUNTER_SAMPLER_TRANSPORT_CLOSED");
    this.writeFrame(frame);
  }
  private flushQueue(): void {
    // A frame whose submission threw is a failed delivery retained with that
    // throw (transportFailure plus the queue head). No drain, write callback or
    // close re-submits it: re-submission would be a new retry path.
    if (!this.child?.stdin.writable || this.writeBlocked || this.transportFailure) return;
    while (this.sendQueue.length > 0 && !this.writeBlocked) {
      // The queued frame stays owned at the head until its native submission
      // is accepted. A synchronous submission throw is a retained transport
      // failure, never a silently removed frame.
      const frame = this.sendQueue[0];
      let submitted: boolean;
      try { submitted = this.writeFrame(frame); }
      catch (error) {
        this.failTransport(error instanceof Error ? error : new Error(String(error)));
        break;
      }
      if (!submitted) break;
      this.sendQueue.shift();
      this.sendQueueBytes -= Buffer.byteLength(frame, "utf8");
    }
    this.settleQueueWaiters();
  }
  private writeFrame(frame: string): boolean {
    if (!this.child?.stdin.writable) { this.failTransport(new Error("WINDOWS_IO_COUNTER_SAMPLER_TRANSPORT_CLOSED")); return false; }
    let accepted = true;
    accepted = this.child.stdin.write(frame, () => {
      // Small successful writes do not emit `drain`; completion is the release signal.
      if (!this.writeBlocked) this.flushQueue();
      this.settleQueueWaiters();
    });
    if (!accepted) this.writeBlocked = true;
    this.maxQueuedBytes = Math.max(this.maxQueuedBytes, this.sendQueueBytes + this.child.stdin.writableLength);
    return true;
  }
  private onData(chunk: Buffer): void {
    if (this.sharedReadBudget) {
      this.child?.stdout.pause(); this.nativeResponsePaused = true;
      const prepaidFromChunk = Math.min(this.prepaidNativeResponseBytes, chunk.length);
      this.prepaidNativeResponseBytes -= prepaidFromChunk;
      const newlyDeliveredChunk = chunk.length - prepaidFromChunk;
      const buffered = this.child?.stdout.readableLength ?? 0;
      const newlyBuffered = Math.max(0, buffered - this.prepaidNativeResponseBytes);
      const newlyArrived = newlyDeliveredChunk + newlyBuffered;
      if (newlyArrived > MAX_COUNTER_NATIVE_RESPONSE_BYTES_PER_CYCLE
        || this.nativeResponseBytesThisCycle + newlyArrived > MAX_COUNTER_NATIVE_RESPONSE_BYTES_PER_CYCLE) {
        this.failTransport(new Error("WINDOWS_IO_COUNTER_NATIVE_RESPONSE_CREDIT_EXCEEDED"));
        return;
      }
      try { this.sharedReadBudget.consumeActual(newlyArrived, "counter-native-response"); }
      catch (error) { this.failTransport(error instanceof Error ? error : new Error(String(error))); return; }
      this.nativeResponseBytesThisCycle += newlyArrived;
      this.prepaidNativeResponseBytes += newlyBuffered;
    }
    if (this.suppressNativeResponses) return;
    const combined = this.remainder + this.decoder.write(chunk);
    const lines = combined.split(/\r?\n/); this.remainder = lines.pop() ?? "";
    // P-NDATA-SERVICE-FAILURE-BOUNDARY: an oversized partial frame is discarded
    // and enters the retained service failure inside this native callback;
    // the complete lines of the same chunk are still decoded.
    if (Buffer.byteLength(this.remainder, "utf8") > 4096) { this.remainder = ""; this.failTransport(new Error("WINDOWS_IO_COUNTER_FRAME_TOO_LARGE")); }
    for (const line of lines) {
      if (!line) continue;
      const nativeFrameBytes = Buffer.byteLength(line, "utf8") + 1;
      if (nativeFrameBytes > 4096) { for (const [transportId, state] of this.active) this.writeState(transportId, state, { type: "counter_error", message: "counter sampler frame exceeded bound" }); continue; }
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(line) as Record<string, unknown>; }
      catch {
        // P-NDATA-SERVICE-FAILURE-BOUNDARY: request ownership is ambiguous, so the
        // failure is retained first, then each binding gets its explicit error.
        this.failTransport(new Error("WINDOWS_IO_COUNTER_MALFORMED_RESPONSE"));
        for (const [transportId, state] of this.active) this.writeState(transportId, state, { type: "counter_error", message: "counter sampler emitted malformed JSON" });
        continue;
      }
      if (frame.type === "service_ready") {
        if (frame.desiredAccess !== 4096) throw new Error("WINDOWS_IO_COUNTER_QUERY_ONLY_PERMISSION_MISMATCH");
        this.ready = true; for (const listener of this.readyListeners) listener(); this.readyListeners.clear(); continue;
      }
      const transportId = typeof frame.transportId === "string" ? frame.transportId : "";
      const state = this.active.get(transportId);
      if (!state || frame.bindingGeneration !== state.bindingGeneration) continue;
      if (frame.type === "unregistered") {
        if (state.unregistering) this.active.delete(transportId);
        continue;
      }
      if (frame.type === "registered") { state.registered = true; this.writeState(transportId, state, { ...frame, type: "counter_registered" }, nativeFrameBytes); }
      else if (frame.type === "sample") {
        if (frame.requestId !== state.inFlightRequestId) {
          // P-NDATA-SERVICE-FAILURE-BOUNDARY: the retained service failure comes
          // first; the original in-flight request then settles as failed with its
          // own identity through its own admitted response permission.
          const originalRequestId = state.inFlightRequestId;
          this.failTransport(new Error("WINDOWS_IO_COUNTER_MISMATCHED_RESPONSE"));
          state.inFlightRequestId = undefined;
          this.writeState(transportId, state, { type: "counter_error", message: "unsolicited or mismatched counter response", ...(originalRequestId ? { requestId: originalRequestId } : {}) }, nativeFrameBytes);
          continue;
        }
        state.inFlightRequestId = undefined;
        this.writeState(transportId, state, { ...frame, type: "counter_sample" }, nativeFrameBytes);
      } else if (frame.type === "error") {
        state.inFlightRequestId = undefined;
        // Carry the native request identity so the admitted response
        // permission for that request is the one this response settles.
        const nativeRequestId = typeof frame.requestId === "string" && /^[a-f0-9]{32}$/.test(frame.requestId) ? frame.requestId : undefined;
        const responseTo = nativeRequestId ? { requestId: nativeRequestId } : !state.registered && !state.unregistering ? { nativeResponse: "register" } : {};
        this.writeState(transportId, state, { type: "counter_error", message: String(frame.message ?? "counter sampler error"), ...responseTo }, nativeFrameBytes);
        if (state.unregistering && !nativeRequestId) this.active.delete(transportId);
      }
    }
  }
  private writeState(transportId: string, stateInfo: { invocationId: string; bindingGeneration: string; transportGeneration: number }, payload: Record<string, unknown>, nativeFrameBytes = 0): void {
    stateInfo.transportGeneration += 1;
    const state = { schemaVersion: 1, commandId: this.commandId, invocationId: stateInfo.invocationId, transportId, bindingGeneration: stateInfo.bindingGeneration, transportGeneration: stateInfo.transportGeneration, wallTime: new Date().toISOString(), ...payload } as Record<string, unknown>;
    state.auth = sign(state, this.authKey);
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    // P-NDATA-SERVICE-FAILURE-BOUNDARY: an over-bound state frame enters the
    // retained service failure instead of leaving a native callback.
    if (bytes.length > 4096) { this.failTransport(new Error("WINDOWS_IO_COUNTER_STATE_FRAME_TOO_LARGE")); return; }
    // P-NDATA-SERVICE-FAILURE-BOUNDARY: a sink exception is the retained service
    // failure. The undelivered state is not published and resolves no waiter,
    // and the failing sink is never called again for it.
    try { this.stateSink?.(stateInfo.invocationId, state, bytes, nativeFrameBytes); }
    catch (error) { this.failTransport(error instanceof Error ? error : new Error(String(error))); return; }
    this.latestCounterStates.set(transportId, state);
    const generation = Number(state.transportGeneration);
    const pending = this.counterStateWaiters.get(transportId) ?? [];
    const remaining = [];
    for (const waiter of pending) {
      if (generation > waiter.afterGeneration) waiter.resolve(state);
      else remaining.push(waiter);
    }
    if (remaining.length > 0) this.counterStateWaiters.set(transportId, remaining);
    else this.counterStateWaiters.delete(transportId);
  }
}

function writeShim(input: {
  directory: string; eventDir: string; evidenceRoot: string; authKey: string; commandId: string;
  policy: Policy; authorizationFile: string; authorizationSha256: string;
  ownerConfiguration: CommandTelemetryOwnerConfiguration;
}): void {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const args = [
    quotePosix(shellPath(process.execPath)), quotePosix(shellPath(SUPERVISOR_PATH)),
    "--event-dir", quotePosix(shellPath(input.eventDir)), "--evidence-root", quotePosix(shellPath(input.evidenceRoot)),
    "--command-id", quotePosix(input.commandId), "--policy", quotePosix(JSON.stringify(input.policy)),
    "--authorization-file", quotePosix(shellPath(input.authorizationFile)), "--authorization-sha256", quotePosix(input.authorizationSha256),
    "--io-observer", quotePosix(shellPath(IO_OBSERVER_PATH)), "--host-managed-capture", "true",
    "--owner-config", quotePosix(JSON.stringify(input.ownerConfiguration)), "--",
  ].join(" ");
  const script = `#!/bin/sh\nPI_ORC_NO_OUTPUT_ORIGINAL_PATH=\"$PATH\" PI_ORC_USER_NODE_OPTIONS=\"$NODE_OPTIONS\" NODE_OPTIONS='' PI_ORC_NO_OUTPUT_AUTH=${quotePosix(input.authKey)} exec ${args} \"$@\"\n`;
  const shim = path.join(input.directory, "node");
  writeFileSync(shim, script, { encoding: "utf8", mode: 0o700 });
  chmodSync(shim, 0o700);
  const cmdArgs = [
    `"${process.execPath}"`, `"${SUPERVISOR_PATH}"`, "--event-dir", `"${input.eventDir}"`, "--evidence-root", `"${input.evidenceRoot}"`,
    "--command-id", `"${input.commandId}"`, "--policy", `"${JSON.stringify(input.policy).replace(/"/g, '\\"')}"`,
    "--authorization-file", `"${input.authorizationFile}"`, "--authorization-sha256", input.authorizationSha256,
    "--io-observer", `"${IO_OBSERVER_PATH}"`, "--host-managed-capture", "true",
    "--owner-config", `"${JSON.stringify(input.ownerConfiguration).replace(/"/g, '\\"')}"`, "--", "%*",
  ].join(" ");
  writeFileSync(path.join(input.directory, "node.cmd"), `@set PI_ORC_NO_OUTPUT_ORIGINAL_PATH=%PATH%\r\n@set PI_ORC_USER_NODE_OPTIONS=%NODE_OPTIONS%\r\n@set NODE_OPTIONS=\r\n@set PI_ORC_NO_OUTPUT_AUTH=${input.authKey}\r\n@${cmdArgs}\r\n`, { encoding: "utf8", mode: 0o700 });
}
type ArtifactLoadResult = { artifact?: CancellationArtifact; retry: boolean };

/**
 * Owns cancellation terminals whose artifact read is temporarily deferred.
 * Authentication remains the caller's responsibility; this queue only keeps
 * the already-authenticated terminal pending until its finite artifact
 * resolution can either verify evidence or settle the canonical fallback.
 */
export class ArtifactTerminalSettlementQueue {
  private readonly pending = new Map<string, SupervisorEvent>();

  settle(
    event: SupervisorEvent,
    load: () => ArtifactLoadResult,
    commit: (artifact: CancellationArtifact | undefined) => void,
  ): boolean {
    const loaded = load();
    if (loaded.retry) {
      this.pending.set(event.invocationId, event);
      return false;
    }
    commit(loaded.artifact);
    this.pending.delete(event.invocationId);
    return true;
  }

  firstPending(): SupervisorEvent | undefined { return this.pending.values().next().value as SupervisorEvent | undefined; }
  hasPending(): boolean { return this.pending.size > 0; }
  get size(): number { return this.pending.size; }
}

export function loadArtifact(
  file: string,
  evidenceRoot: string,
  commandId: string,
  invocationId: string,
  expectedSha256: string,
  expectedBytes: number,
  reader: EventReader,
): ArtifactLoadResult {
  try {
    const root = realpathSync(evidenceRoot);
    const canonical = realpathSync(file);
    const stat = statSync(canonical);
    if (!isWithin(root, canonical) || stat.size !== expectedBytes || stat.size > 256 * 1024) return { retry: false };
    const readOutcome = reader.readFileWithinCycleOutcome(canonical, 256 * 1024, "cancellation-artifact", evidenceRoot);
    if (readOutcome.kind === "deferred") return { retry: true };
    if (readOutcome.kind === "unavailable") return { retry: false };
    const bytes = readOutcome.bytes;
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) return { retry: false };
    const artifact = JSON.parse(bytes.toString("utf8")) as CancellationArtifact;
    if (artifact.schemaVersion !== 1 || artifact.outcome !== "cancelled_no_output" || artifact.commandId !== commandId || artifact.invocationId !== invocationId) return { retry: false };
    if (artifact.cancellationConfirmed !== true || artifact.confirmationBasis !== "terminal_signal_after_owned_handle_action" || artifact.terminalExitCode !== null || artifact.terminalSignal !== "SIGTERM") return { retry: false };
    return { artifact: { ...artifact, partialLog: utf8Prefix(redactActionText(artifact.partialLog), 64 * 1024) }, retry: false };
  } catch { return { retry: false }; }
}

function fitSerializedEvidence(value: string, maxSerializedBytes: number): string {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maxSerializedBytes) return value;
  let low = 0; let high = Buffer.byteLength(value, "utf8"); let best = "[truncated]";
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    const candidate = `${utf8Prefix(value, Math.floor(retained / 2))}\n[...captured evidence omitted; non-contiguous boundary...]\n${utf8Tail(value, retained - Math.floor(retained / 2))}`;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxSerializedBytes) { best = candidate; low = retained + 1; }
    else high = retained - 1;
  }
  return best;
}

type HostCaptureSpec = {
  path: string; error?: string; parentRealPath?: string;
  parentDevice?: string | number; parentInode?: string | number;
};
type HostCaptureResult = {
  results: Array<Record<string, unknown>>;
  bytesRead: number;
  budgetBytes: number;
  stateScanBudgetBytes: number;
};
type HostCaptureJob = {
  invocationId: string;
  workspaceRealPath: string;
  specs: HostCaptureSpec[];
  maxTotalBytes: number;
  capture?: HostCaptureResult;
};
export type HostCaptureSettlement =
  | { kind: "terminal"; invocationId: string; terminal: SupervisorEvent; capture: HostCaptureResult }
  | { kind: "unavailable"; invocationId: string; reason: "COMMAND_TELEMETRY_TERMINAL_UNAVAILABLE_AFTER_PRODUCER_CLOSE"; capture: HostCaptureResult }
  | { kind: "unadmitted"; invocationId: string; terminal: SupervisorEvent; reason: "HOST_CAPTURE_REQUEST_NOT_ADMITTED" };

/**
 * Matches post-settlement file captures to their durable invocation terminal.
 * This class is the production queue, exported only so finite regressions can
 * drive the same state transitions without entering the host's drain loop.
 */
export class HostCaptureSettlementQueue {
  private readonly jobs: HostCaptureJob[] = [];
  private readonly jobIds = new Set<string>();
  private readonly terminals = new Map<string, SupervisorEvent>();

  constructor(private readonly producerState: (invocationId: string) => "open" | "closed") {}

  addRequest(event: SupervisorEvent): boolean {
    if (this.jobIds.has(event.invocationId)) return false;
    const specs = Array.isArray(event.specs)
      ? event.specs.filter((item): item is HostCaptureSpec => Boolean(item) && typeof item === "object" && typeof (item as HostCaptureSpec).path === "string").slice(0, 32)
      : [];
    const workspaceRealPath = typeof event.workspaceRealPath === "string" ? event.workspaceRealPath : "";
    const maxTotalBytes = Math.min(64 * 1024, Number(event.maxTotalBytes) || 0);
    if (!workspaceRealPath || maxTotalBytes <= 0) return false;
    this.jobIds.add(event.invocationId);
    this.jobs.push({ invocationId: event.invocationId, workspaceRealPath, specs, maxTotalBytes });
    return true;
  }

  hasJob(invocationId: string): boolean { return this.jobIds.has(invocationId); }

  addTerminal(event: SupervisorEvent): void { this.terminals.set(event.invocationId, event); }

  settleNext(
    capture: (job: Readonly<HostCaptureJob>) => HostCaptureResult | undefined,
    commit: (invocationId: string, terminal: SupervisorEvent) => boolean,
  ): HostCaptureSettlement | undefined {
    const job = this.jobs[0];
    if (!job) {
      // P-CAPQUEUE-UNADMITTED-TERMINAL: with no admitted job, every retained
      // terminal claims host capture without an admitted request. It waits
      // behind the same producer gate as a job without its terminal, then
      // settles explicitly so the caller finishes it without a capture.
      const first = this.terminals.entries().next();
      if (first.done) return undefined;
      const [invocationId, terminal] = first.value;
      if (this.producerState(invocationId) === "open") return undefined;
      this.terminals.delete(invocationId);
      return { kind: "unadmitted", invocationId, terminal, reason: "HOST_CAPTURE_REQUEST_NOT_ADMITTED" };
    }
    if (!job.capture) job.capture = capture(job);
    if (!job.capture) return undefined;
    const terminal = this.terminals.get(job.invocationId);
    if (!terminal) {
      if (this.producerState(job.invocationId) === "open") return undefined;
      this.jobs.shift();
      this.jobIds.delete(job.invocationId);
      return {
        kind: "unavailable",
        invocationId: job.invocationId,
        reason: "COMMAND_TELEMETRY_TERMINAL_UNAVAILABLE_AFTER_PRODUCER_CLOSE",
        capture: job.capture,
      };
    }
    terminal.declaredFileCapture = job.capture;
    if (!commit(job.invocationId, terminal)) return undefined;
    this.jobs.shift();
    this.jobIds.delete(job.invocationId);
    this.terminals.delete(job.invocationId);
    return { kind: "terminal", invocationId: job.invocationId, terminal, capture: job.capture };
  }

  hasPending(): boolean { return this.jobs.length > 0 || this.terminals.size > 0; }
  pendingInvocationIds(): string[] {
    return [
      ...this.jobs.map((job) => job.invocationId),
      ...[...this.terminals.keys()].filter((invocationId) => !this.jobIds.has(invocationId)),
    ];
  }
}

export function captureSettledFilesWithSharedCredits(
  specs: HostCaptureSpec[], workspaceRealPath: string, reader: EventReader, maxTotalBytes: number,
): { results: Array<Record<string, unknown>>; bytesRead: number; budgetBytes: number; stateScanBudgetBytes: number } | undefined {
  const stateScanBudgetBytes = 192 * 1024;
  const plans: Array<{ spec: HostCaptureSpec; openedSize: number; readBytes: number; completeLexicalScan: boolean }> = [];
  const planningErrors = new Map<string, string>();
  const conclusivelyMissing = new Set<string>();
  let scanRemaining = stateScanBudgetBytes;
  let requested = 0;
  for (const spec of specs.slice(0, 32)) {
    if (spec.error || !scanRemaining) continue;
    try {
      if (!existsSync(spec.path)) {
        // A false existence probe may mean inaccessible metadata. Only the
        // no-follow metadata result can positively establish absence.
        try { lstatSync(spec.path, { bigint: true }); planningErrors.set(spec.path, "capture existence observation inconclusive"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") conclusivelyMissing.add(spec.path);
          else planningErrors.set(spec.path, `capture metadata unavailable: ${String((error as Error)?.message ?? error)}`);
        }
        continue;
      }
      const leaf = lstatSync(spec.path, { bigint: true });
      if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        planningErrors.set(spec.path, "capture leaf identity unavailable"); continue;
      }
      const leafSize = Number(leaf.size);
      const readBytes = Math.min(leafSize, scanRemaining);
      plans.push({ spec, openedSize: leafSize, readBytes, completeLexicalScan: readBytes === leafSize });
      requested += readBytes; scanRemaining -= readBytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") conclusivelyMissing.add(spec.path);
      else planningErrors.set(spec.path, `capture metadata unavailable: ${String((error as Error)?.message ?? error)}`);
    }
  }
  const readReservation = reader.sharedBudget.beginFileRead(requested, "declared-file-capture");
  if (!readReservation) return undefined;
  const results: Array<Record<string, unknown>> = [];
  let bytesRead = 0; let serializedRemaining = 48 * 1024;
  let readPermissionTransferred = false;
  const byPath = new Map(plans.map((plan) => [plan.spec.path, plan]));
  for (const spec of specs.slice(0, 32)) {
    const base = { path: redactActionText(String(spec.path)), historicalContent: "not_retained_during_execution" };
    if (spec.error) { results.push({ ...base, status: "unavailable", error: redactActionText(String(spec.error)) }); continue; }
    const plan = byPath.get(spec.path);
    if (!plan) {
      results.push({ ...base, status: conclusivelyMissing.has(spec.path) ? "missing" : "unavailable",
        error: conclusivelyMissing.has(spec.path) ? undefined : redactActionText(planningErrors.get(spec.path) ?? "lexical-state scan budget exhausted") });
      continue;
    }
    if (readPermissionTransferred) {
      results.push({ ...base, status: "unavailable", error: "capture read permission retained by an unresolved descriptor" });
      continue;
    }
    let descriptor: number | undefined;
    let descriptorClosed = true;
    try {
      const parent = realpathSync(path.dirname(spec.path));
      if (parent !== spec.parentRealPath || !isWithin(workspaceRealPath, parent)) throw new Error("capture parent identity or containment changed");
      const parentStat = lstatSync(parent, { bigint: true });
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
        || parentStat.dev.toString() !== String(spec.parentDevice)
        || parentStat.ino.toString() !== String(spec.parentInode)) throw new Error("capture parent identity changed");
      const beforeLeaf = lstatSync(spec.path, { bigint: true });
      if (beforeLeaf.isSymbolicLink() || !beforeLeaf.isFile()) throw new Error("capture leaf is linked or non-regular");
      const canonical = realpathSync(spec.path);
      if (!isWithin(workspaceRealPath, canonical)) throw new Error("capture leaf escapes workspace");
      descriptor = openSync(spec.path, "r");
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== beforeLeaf.dev || opened.ino !== beforeLeaf.ino
        || opened.size !== BigInt(plan.openedSize)) throw new Error("capture opened-handle identity mismatch");
      const captured = Buffer.alloc(plan.readBytes);
      const actualRead = plan.readBytes ? readSync(descriptor, captured, 0, plan.readBytes, 0) : 0;
      reader.sharedBudget.consumeFileRead(readReservation, actualRead, "declared-file-capture");
      if (actualRead !== plan.readBytes) throw new Error("capture read was torn or incomplete");
      const afterHandle = fstatSync(descriptor, { bigint: true });
      const afterLeaf = lstatSync(spec.path, { bigint: true });
      if (afterLeaf.isSymbolicLink() || afterHandle.dev !== opened.dev || afterHandle.ino !== opened.ino
        || afterHandle.size !== opened.size || afterLeaf.dev !== opened.dev || afterLeaf.ino !== opened.ino
        || afterLeaf.size !== opened.size || realpathSync(spec.path) !== canonical) throw new Error("capture identity changed during read");
      bytesRead += actualRead;
      const unavailableTail = plan.completeLexicalScan ? "" : "\n[tail unavailable: complete lexical-state scan exceeded bounded read budget]\n";
      const sanitized = redactActionText(captured.toString("utf8")) + unavailableTail;
      const excerpt = fitSerializedEvidence(sanitized, Math.max(64, serializedRemaining));
      serializedRemaining = Math.max(0, serializedRemaining - Buffer.byteLength(JSON.stringify(excerpt), "utf8"));
      const truncated = !plan.completeLexicalScan || plan.openedSize > maxTotalBytes || excerpt !== sanitized;
      results.push({ ...base, status: truncated ? "truncated" : "captured", size: plan.openedSize, bytesRead: actualRead,
        contentLayout: plan.completeLexicalScan ? "sanitized_complete_current_generation" : "sanitized_prefix_tail_explicitly_unavailable",
        lexicalStateScanComplete: plan.completeLexicalScan,
        contentTruncatedForEnvelope: excerpt !== sanitized, head: excerpt, tail: "" });
    } catch (error) {
      results.push({ ...base, status: "unavailable", error: redactActionText(error instanceof Error ? error.message : String(error)) });
    } finally {
      if (descriptor !== undefined) {
        descriptorClosed = reader.sharedBudget.closeFileRead(readReservation, descriptor, "declared-file-capture");
      }
    }
    if (!descriptorClosed) {
      // The single permission now belongs to the retained descriptor. Do not
      // open another planned file with that transferred permission.
      readPermissionTransferred = true;
      results[results.length - 1] = { ...base, status: "unavailable", error: "capture descriptor close unavailable" };
    }
  }
  return { results, bytesRead, budgetBytes: Math.min(64 * 1024, maxTotalBytes), stateScanBudgetBytes };
}

export function selectCancellationPartialLog(
  event: Record<string, unknown>, artifact: CancellationArtifact | undefined, captureLog = "",
): string {
  return utf8Prefix(redactActionText([
    artifact?.partialLog
      ?? [event.partialLogHead, event.partialLogTail].filter((item): item is string => typeof item === "string" && item.length > 0).join("\n[...sealed middle omitted...]\n"),
    captureLog,
  ].filter(Boolean).join("\n")), 64 * 1024);
}

function sanitizeRetainedEvidence(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[unavailable: evidence nesting limit]";
  if (typeof value === "string") return redactActionText(value);
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitizeRetainedEvidence(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 128)
    .map(([key, item]) => [key, sanitizeRetainedEvidence(item, depth + 1)]));
}

/**
 * @internal P-JOURNAL-COMMIT-BOUNDARY: one authenticated terminal commits one canonical
 * journal record. The pre-append boundary is the caller-retained committedBytes, or (when
 * absent) the current file size; when the journal is longer than that boundary -- bytes an
 * earlier failed append left behind -- it is truncated back to the boundary before
 * appending. The append call, and the hash/count/publish order once it succeeds, are the
 * original extraction, unchanged. If the append itself throws, the same reconcile runs
 * again (truncate back to the boundary) and the original append error is rethrown
 * unchanged; if that reconcile also throws, both errors are retained in an AggregateError.
 * On any throw the hash and count are not touched. A publishUpdate throw after a durable
 * commit is never rethrown -- it is returned as notificationFailure so a caller can report
 * it as a separate diagnostic without reclassifying the durable record as uncommitted or
 * inviting a duplicate retry append.
 */
export function commitCancellationJournalEntry(input: {
  commandJournalPath: string;
  line: string;
  commandJournalHash: ReturnType<typeof createHash>;
  recordCommitted: () => void;
  publishUpdate: () => void;
  committedBytes?: number;
}): { notificationFailure?: unknown } {
  const boundary = typeof input.committedBytes === "number"
    ? input.committedBytes
    : (statSync(input.commandJournalPath, { throwIfNoEntry: false })?.size ?? 0);
  const observedSize = statSync(input.commandJournalPath, { throwIfNoEntry: false })?.size ?? 0;
  if (observedSize > boundary) {
    truncateSync(input.commandJournalPath, boundary);
  }
  try {
    appendFileSync(input.commandJournalPath, input.line, { encoding: "utf8", mode: 0o600 });
  } catch (appendError) {
    const sizeAfterFailure = statSync(input.commandJournalPath, { throwIfNoEntry: false })?.size ?? 0;
    if (sizeAfterFailure > boundary) {
      try {
        truncateSync(input.commandJournalPath, boundary);
      } catch (reconcileError) {
        throw new AggregateError([appendError, reconcileError]);
      }
    }
    throw appendError;
  }
  input.commandJournalHash.update(Buffer.from(input.line, "utf8"));
  input.recordCommitted();
  try {
    input.publishUpdate();
  } catch (notificationFailure) {
    return { notificationFailure };
  }
  return {};
}

/** @internal Current native-response permission matching, extracted unchanged for finite production-path regressions. */
export function deliverNativeCounterState(input: {
  nativeResponsePermissions: Map<string, ReturnType<CommandTelemetryOwner["reserveHostWork"]>>;
  telemetryOwner: CommandTelemetryOwner;
  invocationId: string;
  state: Record<string, unknown>;
  nativeFrameBytes: number;
  recordUnavailable?: (invocationId: string, requestId?: string) => void;
}): void {
  const key = input.state.type === "counter_registered" || input.state.nativeResponse === "register" ? `register:${input.invocationId}`
    : typeof input.state.requestId === "string" ? `sample:${input.state.requestId}` : `control:${input.invocationId}`;
  // P-NREQUEST-REM(i) response-map disposition order: a matched permission
  // leaves the response map only after its delivery disposition is recorded.
  // On a throw before that, a mapped permission stays mapped for public
  // recovery and a fallback permission reserved in this call is settled
  // through the existing owner.
  const mapped = input.nativeResponsePermissions.get(key);
  const permission = mapped ?? input.telemetryOwner.reserveHostWork(input.invocationId, "counter", 16 * 1024);
  if (!permission) {
    // M1087-UNAVAILABLE-RECORD-ROUTING: an arrival with no admitted permission
    // whose fallback admission is refused holds no reservation, so nothing
    // becomes outstanding; it is handed to the caller's bounded
    // per-invocation unavailable record instead of being silently skipped.
    input.recordUnavailable?.(input.invocationId, typeof input.state.requestId === "string" && /^[a-f0-9]{32}$/.test(input.state.requestId) ? input.state.requestId : undefined);
    return;
  }
  try {
    const deliveryBytes = input.telemetryOwner.hostDeliveryBytes(input.state, "counter");
    const delivered = input.telemetryOwner.sendToInvocation(input.invocationId, input.state, "counter", permission, input.nativeFrameBytes);
    input.telemetryOwner.completeHostWork(permission, input.nativeFrameBytes + (delivered ? deliveryBytes : 0));
  } catch (error) {
    if (!mapped) input.telemetryOwner.abandonHostWork(permission);
    throw error;
  }
  if (mapped && input.nativeResponsePermissions.get(key) === mapped) input.nativeResponsePermissions.delete(key);
}

/** @internal Current native request admission order, extracted unchanged for finite production-path regressions. */
export function admitNativeCounterRequest(input: {
  nativeResponsePermissions: Map<string, ReturnType<CommandTelemetryOwner["reserveHostWork"]>>;
  telemetryOwner: CommandTelemetryOwner;
  invocationId: string;
  key: string;
  submit: () => NativeRequestDisposition | void;
}): void {
  const permission = input.telemetryOwner.reserveHostWork(input.invocationId, "counter", 16 * 1024);
  if (!permission) throw new Error("COUNTER_NATIVE_RESPONSE_GRANT_UNAVAILABLE");
  input.nativeResponsePermissions.set(input.key, permission);
  // A coalesced or conclusively unsubmitted request never receives a native
  // response; its mapped permission is abandoned through the existing owner.
  const release = () => {
    if (input.nativeResponsePermissions.get(input.key) === permission) input.nativeResponsePermissions.delete(input.key);
    input.telemetryOwner.abandonHostWork(permission);
  };
  let disposition: NativeRequestDisposition | void;
  try { disposition = input.submit(); }
  catch (error) { release(); throw error; }
  if (disposition === "coalesced" || disposition === "unsubmitted") release();
}

/** @internal Current ACK delivery turn, extracted unchanged for finite production-path regressions. */
export function deliverHostAcknowledgementsTurn(input: {
  pendingHostAcknowledgements: Map<string, { requestId: string; ackToken: unknown }>;
  hostAlarmAckRoot: string;
  commandId: string;
  authKey: string;
  telemetryOwner: CommandTelemetryOwner;
  afterDelivered?: () => void;
}): void {
  for (const [invocationId, pending] of input.pendingHostAcknowledgements) {
    const receipt = path.join(input.hostAlarmAckRoot, `${pending.requestId}.ack`);
    if (!existsSync(receipt)) continue;
    const ack = { schemaVersion: 1, commandId: input.commandId, invocationId, type: "alarm_ack", ackToken: pending.ackToken, acknowledgedAt: new Date().toISOString() } as Record<string, unknown>;
    ack.auth = sign(ack, input.authKey);
    const ackPermission = input.telemetryOwner.reserveHostWork(invocationId, "control", 4096);
    if (!ackPermission) continue;
    const deliveryBytes = input.telemetryOwner.hostDeliveryBytes(ack, "control");
    const delivered = input.telemetryOwner.sendToInvocation(invocationId, ack, "control", ackPermission);
    input.telemetryOwner.completeHostWork(ackPermission, delivered ? deliveryBytes : 0);
    input.pendingHostAcknowledgements.delete(invocationId);
    try { rmSync(receipt, { force: true }); } catch {}
    input.afterDelivered?.();
  }
}

type CleanupOutcome = { settled: boolean; reason?: string };

/** Conclusive retirement only; unknown readers cannot authorize owner retirement. */
export function retireSettledEvidence(
  reader: Pick<EventReader, "retire">,
  telemetryOwner: Pick<CommandTelemetryOwner, "retireCommitted">,
  invocationId: string,
  transportId?: string,
): CleanupOutcome {
  try {
    if (reader.retire(invocationId, transportId) !== true) {
      return { settled: false, reason: "EVIDENCE_READER_RETIREMENT_UNESTABLISHED" };
    }
    return telemetryOwner.retireCommitted(invocationId) === true
      ? { settled: true }
      : { settled: false, reason: "EVIDENCE_OWNER_RETIREMENT_UNESTABLISHED" };
  } catch {
    // Fixed diagnostic codes expose failure without leaking paths or raw error secrets.
    return { settled: false, reason: "EVIDENCE_RETIREMENT_FAILED" };
  }
}

/** Removal is not confirmed until an ENOENT observation; no-op/unknown is not success. */
export function cleanupCommandRoot(directory: string): CleanupOutcome {
  try { rmSync(directory, { recursive: true, force: true }); }
  catch { return { settled: false, reason: "COMMAND_ROOT_REMOVAL_FAILED" }; }
  try { lstatSync(directory); return { settled: false, reason: "COMMAND_ROOT_RETAINED" }; }
  catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { settled: true }
      : { settled: false, reason: "COMMAND_ROOT_REMOVAL_UNESTABLISHED" };
  }
}

/** Feed the existing caller-visible settlement diagnostics, not a new command-outcome gate. */
export function recordCleanupOutcome(
  outcome: CleanupOutcome,
  step: "evidence-retirement-caller" | "command-root-cleanup",
  records: Array<{ step: string; error: unknown }>,
): void {
  if (!outcome.settled) records.push({ step, error: new Error(outcome.reason ?? "CLEANUP_UNESTABLISHED") });
}

/** @internal Current final-drain predicate, extracted unchanged for finite production-path regressions. */
export function monitorDrainPending(
  reader: Pick<EventReader, "hasPending">,
  captureSettlements: Pick<HostCaptureSettlementQueue, "hasPending">,
  artifactTerminals: Pick<ArtifactTerminalSettlementQueue, "hasPending">,
): boolean {
  return reader.hasPending() || captureSettlements.hasPending() || artifactTerminals.hasPending();
}

/** @internal Current single final-drain turn, extracted without changing classification or scheduling. */
export function processMonitorDrainTurn(
  processEvents: () => void,
  reader: Pick<EventReader, "hasPending">,
  captureSettlements: Pick<HostCaptureSettlementQueue, "hasPending">,
  artifactTerminals: Pick<ArtifactTerminalSettlementQueue, "hasPending">,
): boolean {
  processEvents();
  return monitorDrainPending(reader, captureSettlements, artifactTerminals);
}

export default function workerNoOutputMonitor(pi: ExtensionAPI): void {
  const authorizationFile = process.env.PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE;
  const authorizationSha256 = process.env.PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256;
  const evidenceRoot = process.env.PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT;
  const hostAlarmAckRoot = process.env.PI_ORCHESTRATOR_ALARM_ACK_ROOT;
  if (process.env.PI_ORCHESTRATOR_WORKER_ID) process.stderr.write(`${NO_OUTPUT_MONITOR_READY_MARKER}\n`);
  const registered = createBashToolDefinition(process.cwd());
  const finalPatches = new Map<string, { details: NoOutputDetails; text: string; cleanup: string[] }>();

  pi.registerTool({
    ...registered,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const policy = policyFromEnvironment();
      const authKey = randomBytes(32).toString("hex");
      const commandId = `${process.env.PI_ORCHESTRATOR_WORKER_ID ?? "worker"}:${toolCallId}:${randomBytes(8).toString("hex")}`;
      const commandRoot = path.join(os.tmpdir(), `pi-orchestrator-command-${createHash("sha256").update(commandId).digest("hex").slice(0, 24)}`);
      const eventDir = path.join(commandRoot, "events");
      const shimDir = path.join(commandRoot, "shim");
      mkdirSync(eventDir, { recursive: true, mode: 0o700 });
      if (!authorizationFile || !authorizationSha256 || !evidenceRoot || !hostAlarmAckRoot) throw new Error("NO_OUTPUT_MONITOR_AUTHORIZATION_UNAVAILABLE");
      const telemetryOwner = new CommandTelemetryOwner({ commandRoot, evidenceDirectory: eventDir, commandId });
      let counterServiceForCleanup: WindowsIoCounterService | undefined;
      let commandReadBudgetForCleanup: SharedReadBudget | undefined;
      let drainEventsForCleanup: (() => Promise<void>) | undefined;
      let cleanupAttempted = false;
      // HR3-EXTEND-SETTLEMENT-DIAGNOSTIC: one record per failed settlement attempt, independent of
      // how `failures` below is thrown (a single error or an AggregateError). This is what lets every
      // settlement-step failure -- not only HR3's own retained counter-service-close case -- be
      // reported as a diagnostic instead of becoming the command's result.
      const settlementFailureRecords: Array<{ step: string; error: unknown }> = [];
      const settleResources = async () => {
        if (cleanupAttempted) return;
        cleanupAttempted = true;
        const failures: unknown[] = [];
        const attempt = async (step: string, operation: () => void | Promise<void>) => {
          try { await operation(); } catch (error) { failures.push(error); settlementFailureRecords.push({ step, error }); }
        };
        // Each admitted obligation gets its own settlement attempt even if an
        // earlier drain or native close failed. Never equate closed admission
        // or a caught exception with a closed child/server.
        if (drainEventsForCleanup) await attempt("event-drain", drainEventsForCleanup);
        if (counterServiceForCleanup) await attempt("counter-service-close", () => counterServiceForCleanup!.close());
        if (drainEventsForCleanup) await attempt("event-final-drain", drainEventsForCleanup);
        if (commandReadBudgetForCleanup) await attempt("read-budget-finalize", () => commandReadBudgetForCleanup!.finalizeCycle());
        await attempt("telemetry-owner-close", () => telemetryOwner.close());
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "NO_OUTPUT_MONITOR_RESOURCE_SETTLEMENT_FAILED");
      };
      let primaryError: unknown;
      try {
      await telemetryOwner.start();
      writeShim({
        directory: shimDir, eventDir, evidenceRoot, authKey, commandId, policy, authorizationFile, authorizationSha256,
        ownerConfiguration: telemetryOwner.configuration(),
      });
      const commandReadBudget = new SharedReadBudget(MAX_EVENT_READ_BYTES_PER_POLL, telemetryOwner);
      commandReadBudgetForCleanup = commandReadBudget;
      const nativeResponsePermissions = new Map<string, ReturnType<CommandTelemetryOwner["reserveHostWork"]>>();
      // P-NREQUEST-REM(ii) counter-error identity and bounded outcome: a
      // monitor counter error for a failed native sample request carries that
      // request's identity. Without delivery credit it leaves one bounded
      // unavailable outcome per invocation (folded into invocationTelemetry)
      // and makes no further fallback reservation for that invocation.
      const counterErrorUnavailable = new Map<string, { status: "unavailable"; requestId?: string; count: number }>();
      let counterErrorUnavailableOmitted = 0;
      // M1087-UNAVAILABLE-RECORD-ROUTING: the one writer of that bounded
      // record, shared by writeCounterError and the native state sink (a
      // native arrival whose fallback admission is refused). Every disposition
      // is counted into details.monitorIo.
      let counterErrorUnavailableDispositions = 0;
      const recordCounterErrorUnavailable = (invocationId: string, requestId?: string) => {
        counterErrorUnavailableDispositions += 1;
        const unavailable = counterErrorUnavailable.get(invocationId);
        if (unavailable) { unavailable.count += 1; return; }
        // Bounded by the owner's 200-registration limit; an overflow is counted, never dropped silently.
        if (counterErrorUnavailable.size < 200) counterErrorUnavailable.set(invocationId, { status: "unavailable", ...(requestId ? { requestId } : {}), count: 1 });
        else counterErrorUnavailableOmitted += 1;
      };
      const counterService = new WindowsIoCounterService(
        eventDir, authKey, commandId, undefined,
        (invocationId, state, _bytes, nativeFrameBytes) => deliverNativeCounterState({
          nativeResponsePermissions,
          telemetryOwner,
          invocationId,
          state,
          nativeFrameBytes,
          recordUnavailable: recordCounterErrorUnavailable,
        }),
      );
      counterServiceForCleanup = counterService;
      let counterServiceError: Error | undefined;
      try { await counterService.start(); }
      catch (error) { counterServiceError = error instanceof Error ? error : new Error(String(error)); }
      const writeCounterError = (invocationId: string, message: string, requestId?: string) => {
        if (counterErrorUnavailable.has(invocationId)) { recordCounterErrorUnavailable(invocationId, requestId); return; }
        const transportId = createHash("sha256").update(`${commandId}\0${invocationId}`, "utf8").digest("hex").slice(0, 32);
        const state = { schemaVersion: 1, commandId, invocationId, transportId, wallTime: new Date().toISOString(), type: "counter_error", message, ...(requestId ? { requestId } : {}) } as Record<string, unknown>;
        state.auth = sign(state, authKey);
        const permission = telemetryOwner.reserveHostWork(invocationId, "counter", 16 * 1024);
        if (!permission) { recordCounterErrorUnavailable(invocationId, requestId); return; }
        const deliveryBytes = telemetryOwner.hostDeliveryBytes(state, "counter");
        const delivered = telemetryOwner.sendToInvocation(invocationId, state, "counter", permission);
        telemetryOwner.completeHostWork(permission, delivered ? deliveryBytes : 0);
      };
      const reader = new EventReader(eventDir, commandReadBudget);
      const telemetryPeak = { peakDiskBytes: 0, peakFiles: 0, peakCounterBytes: 0, peakFileObservationBytes: 0, peakEventBytes: 0, peakControlBytes: 0, peakTerminalBytes: 0, maxQueuedBytes: 0, maxInFlight: 0 };
      let telemetryMeasurementUnavailable = false;
      const measureTelemetry = () => {
        let disk = 0; let files = 0; let counters = 0; let fileObservation = 0; let events = 0; let controls = 0; let terminal = 0;
        let names: string[];
        try {
          if (!existsSync(eventDir)) { telemetryMeasurementUnavailable = true; return; }
          names = readdirSync(eventDir);
        } catch { telemetryMeasurementUnavailable = true; return; }
        for (const name of names) {
          const file = path.join(eventDir, name);
          let stat; try { stat = lstatSync(file); }
          catch { telemetryMeasurementUnavailable = true; continue; }
          if (!stat.isFile()) continue;
          files += 1; disk += stat.size;
          if (/\.file\.|file\.observation/.test(name)) fileObservation += stat.size;
          else if (/counter|(?<!file\.)observation\.mailbox/.test(name)) counters += stat.size;
          else if (/controls|ack/.test(name)) controls += stat.size;
          else if (/terminal/.test(name)) terminal += stat.size;
          else events += stat.size;
        }
        const queue = counterService.getTransportStats();
        telemetryPeak.peakDiskBytes = Math.max(telemetryPeak.peakDiskBytes, disk);
        telemetryPeak.peakFiles = Math.max(telemetryPeak.peakFiles, files);
        telemetryPeak.peakCounterBytes = Math.max(telemetryPeak.peakCounterBytes, counters);
        telemetryPeak.peakFileObservationBytes = Math.max(telemetryPeak.peakFileObservationBytes, fileObservation);
        telemetryPeak.peakEventBytes = Math.max(telemetryPeak.peakEventBytes, events);
        telemetryPeak.peakControlBytes = Math.max(telemetryPeak.peakControlBytes, controls);
        telemetryPeak.peakTerminalBytes = Math.max(telemetryPeak.peakTerminalBytes, terminal);
        telemetryPeak.maxQueuedBytes = Math.max(telemetryPeak.maxQueuedBytes, queue.maxQueuedBytes);
        telemetryPeak.maxInFlight = Math.max(telemetryPeak.maxInFlight, queue.inFlight);
      };
      let cancellationCount = 0;
      const firstCancellations: NoOutputCancellationEvidence[] = [];
      const lastCancellations: NoOutputCancellationEvidence[] = [];
      const commandJournalPath = path.join(evidenceRoot, `${createHash("sha256").update(commandId).digest("hex")}.command-cancellations.jsonl`);
      const commandJournalHash = createHash("sha256");
      // P-JOURNAL-COMMIT-BOUNDARY: the committed-offset boundary retained across commits of
      // this command's journal, incremented only inside recordCommitted (i.e. only after an
      // append actually succeeded), and passed back in as committedBytes on the next commit.
      let commandJournalCommittedBytes = 0;
      const acknowledgedInvocations = new Set<string>();
      const transportIdsByInvocation = new Map<string, string>();
      const pendingHostAcknowledgements = new Map<string, { requestId: string; ackToken: unknown }>();
      let latestUpdate: Parameters<NonNullable<typeof onUpdate>>[0] | undefined;
      let started = performance.now();
      let lastOutput = started;
      let fallbackAlarmSent = false;
      let helperSeen = false;
      let terminalObservationReason = "";
      const declaredFileCapture: Array<Record<string, unknown>> = [];
      const invocationTelemetry: Array<Record<string, unknown>> = [];
      let testActiveLossTriggered = false;
      let processCounterActivity = 0;
      let counterUncertainty = 0;
      let queryOnlyBindings = 0;
      const captureSettlements = new HostCaptureSettlementQueue(
        (invocationId) => telemetryOwner.invocationProducerState(invocationId),
      );
      const artifactTerminals = new ArtifactTerminalSettlementQueue();
      const deliverHostAcknowledgements = () => deliverHostAcknowledgementsTurn({
        pendingHostAcknowledgements,
        hostAlarmAckRoot,
        commandId,
        authKey,
        telemetryOwner,
        afterDelivered() {
          if (!testActiveLossTriggered && process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_LOSS_AFTER_ACK === "1") {
            testActiveLossTriggered = true;
            void counterService.failAndClose("counter sampler completed after acknowledged alarm by finite test protocol")
              .catch((error) => { counterServiceError = error instanceof Error ? error : new Error(String(error)); });
          }
        },
      });
      const sealCancellation = (event: SupervisorEvent): boolean => {
        if (
          event.outcome !== "cancelled_no_output" || event.cancellationConfirmed !== true
          || event.confirmationBasis !== "terminal_signal_after_owned_handle_action"
          || event.exitCode !== null || event.signal !== "SIGTERM" || typeof event.summary !== "string"
        ) return true;
        const summary = event.summary;
        const hasArtifactReference = typeof event.artifactPath === "string" && typeof event.artifactSha256 === "string" && typeof event.artifactBytes === "number";
        return artifactTerminals.settle(event, () => hasArtifactReference
          ? loadArtifact(event.artifactPath as string, evidenceRoot, commandId, event.invocationId, event.artifactSha256 as string, event.artifactBytes as number, reader)
          : { retry: false }, (artifact) => {
          const captureResults = event.declaredFileCapture && typeof event.declaredFileCapture === "object" && Array.isArray((event.declaredFileCapture as { results?: unknown }).results)
            ? (event.declaredFileCapture as { results: unknown[] }).results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").map((item) => sanitizeRetainedEvidence(item) as Record<string, unknown>)
            : [];
          const captureLog = captureResults.map((item) => `[post-settlement-file:${String(item.path ?? "unknown")}:${String(item.status ?? "unavailable")}]\n${String(item.head ?? "")}${String(item.tail ?? "")}`).join("\n");
          const evidence: NoOutputCancellationEvidence = {
            schemaVersion: 1,
            outcome: "cancelled_no_output",
            commandId,
            invocationId: event.invocationId,
            summary: redactActionText(summary).slice(0, 512),
            noOutputMs: Number(event.noOutputMs) || 0,
            totalElapsedMs: Number(event.totalElapsedMs) || 0,
            alarmMonotonicMs: Number(event.alarmMonotonicMs) || 0,
            alarmAcknowledgedMonotonicMs: Number(event.alarmAcknowledgedMonotonicMs) || 0,
            cancelledMonotonicMs: Number(event.cancelledMonotonicMs) || 0,
            cancellationRequested: true,
            cancellationAccepted: true,
            cancellationConfirmed: true,
            confirmationBasis: "terminal_signal_after_owned_handle_action",
            terminalExitCode: null,
            terminalSignal: "SIGTERM",
            cancellationTarget: "retained-direct-test-child-handle",
            eligibility: "authenticated_run_owned_test_child",
            observedSources: Array.isArray(event.observedSources) ? event.observedSources.filter((item): item is string => typeof item === "string").slice(0, 64) : [],
            observationErrors: Array.isArray(event.observationErrors) ? event.observationErrors.filter((item): item is string => typeof item === "string").slice(0, 32) : [],
            partialLog: selectCancellationPartialLog(event, artifact, captureLog),
            invocationDescriptor: event.invocationDescriptor && typeof event.invocationDescriptor === "object" ? event.invocationDescriptor as Record<string, unknown> : undefined,
            declaredFileCapture: captureResults,
            artifactPath: hasArtifactReference ? event.artifactPath as string : commandJournalPath,
            artifactSha256: hasArtifactReference ? event.artifactSha256 as string : "",
            artifactBytes: hasArtifactReference ? event.artifactBytes as number : 0,
            artifactIntegrity: artifact ? "verified" : "unavailable_or_changed",
          };
          const line = `${JSON.stringify(evidence)}\n`;
          const journalCommit = commitCancellationJournalEntry({
            commandJournalPath,
            line,
            commandJournalHash,
            committedBytes: commandJournalCommittedBytes,
            recordCommitted() {
              cancellationCount += 1;
              commandJournalCommittedBytes += Buffer.byteLength(line, "utf8");
              if (firstCancellations.length < 100) firstCancellations.push(evidence);
              else {
                lastCancellations.push(evidence);
                if (lastCancellations.length > 100) lastCancellations.shift();
              }
            },
            publishUpdate() {
              onUpdate?.({ content: latestUpdate?.content ?? [], details: {
                ...(latestUpdate?.details as Record<string, unknown> | undefined),
                noOutputCancellation: evidence,
              } as NoOutputDetails });
            },
          });
          // P-JOURNAL-COMMIT-BOUNDARY / decision 4: the cancellation evidence above stays
          // the result; a retained notification failure is reported alongside it as a
          // separate diagnostic, through the existing HR3-EXTEND settlement-failure mapping.
          if (journalCommit.notificationFailure !== undefined) {
            settlementFailureRecords.push({ step: "journal-publish-update", error: journalCommit.notificationFailure });
          }
        });
      };
      const finishTerminal = (event: SupervisorEvent) => {
        let evidenceSettled = true;
        if (event.outcome === "cancelled_no_output" && acknowledgedInvocations.has(event.invocationId)) {
          evidenceSettled = sealCancellation(event);
        } else {
          terminalObservationReason = `terminal outcome=${String(event.outcome)} requested=${String(event.cancellationRequested)} accepted=${String(event.cancellationAccepted)} exit=${String(event.exitCode)} signal=${String(event.signal)} observation=${String(event.observationError ?? "none")}`;
        }
        acknowledgedInvocations.delete(event.invocationId);
        pendingHostAcknowledgements.delete(event.invocationId);
        transportIdsByInvocation.delete(event.invocationId);
        commandReadBudget.abandonHelperReadGrants(event.invocationId);
        try { counterService.unregister(event.invocationId); } catch {}
        telemetryOwner.finalizeInvocation(event.invocationId);
        if (evidenceSettled) {
          recordCleanupOutcome(retireSettledEvidence(
            reader,
            telemetryOwner,
            event.invocationId,
            typeof event.transportId === "string" ? event.transportId : undefined,
          ), "evidence-retirement-caller", settlementFailureRecords);
        }
      };
      const processEvents = (final = false) => {
        measureTelemetry();
        const polledEvents = [...reader.poll(final), ...telemetryOwner.drainEvents() as SupervisorEvent[]];
        counterService.beginReadCycle();
        for (const event of polledEvents) {
          if (!authenticate(event, authKey, commandId)) continue;
          if (event.type === "invocation_started") helperSeen = true;
          if (event.type === "counter_registration") {
            if (typeof event.transportId === "string") transportIdsByInvocation.set(event.invocationId, event.transportId);
            try {
              if (counterServiceError) throw counterServiceError;
              admitNativeCounterRequest({
                nativeResponsePermissions,
                telemetryOwner,
                invocationId: event.invocationId,
                key: `register:${event.invocationId}`,
                submit: () => counterService.register(event),
              });
            } catch (error) { writeCounterError(event.invocationId, error instanceof Error ? error.message : String(error)); }
          }
          if (event.type === "counter_sample_request") {
            try {
              admitNativeCounterRequest({
                nativeResponsePermissions,
                telemetryOwner,
                invocationId: event.invocationId,
                key: `sample:${String(event.requestId ?? "")}`,
                submit: () => counterService.sample(event),
              });
            } catch (error) {
              const failedRequestId = typeof event.requestId === "string" && /^[a-f0-9]{32}$/.test(event.requestId) ? event.requestId : undefined;
              writeCounterError(event.invocationId, error instanceof Error ? error.message : String(error), failedRequestId);
            }
          }
          if (event.type === "output_activity") lastOutput = performance.now();
          if (event.type === "declared_file_capture_request") captureSettlements.addRequest(event);
          if (event.type === "no_output_alarm") {
            const ackRequestId = randomBytes(16).toString("hex");
            onUpdate?.({ content: latestUpdate?.content ?? [], details: {
              ...(latestUpdate?.details as Record<string, unknown> | undefined),
              noOutputAlarm: { schemaVersion: 1, type: "command_no_output_alarm", commandId, invocationId: event.invocationId, ackRequestId, wallTime: event.wallTime, elapsedMs: event.elapsedMs, noOutputMs: event.noOutputMs, monotonicMs: event.monotonicMs, eligibility: event.eligibility },
            } as NoOutputDetails });
            if (acknowledgedInvocations.size < MAX_CANCELLATIONS_PER_COMMAND) {
              acknowledgedInvocations.add(event.invocationId);
              pendingHostAcknowledgements.set(event.invocationId, { requestId: ackRequestId, ackToken: event.ackToken });
            }
          }
          if (event.type === "invocation_terminal") {
            const ownerAccounting = telemetryOwner.accounting();
            const producer = event.producerAccounting && typeof event.producerAccounting === "object"
              ? event.producerAccounting as Record<string, unknown> : {
                peakDiskBytes: Number(ownerAccounting.maxRetainedBytes) || Number(ownerAccounting.retainedBytes) || 0,
                peakFiles: Number(ownerAccounting.maxRetainedFiles) || Number(ownerAccounting.retainedGenerations) || 0,
                peakReservedBytes: Number(ownerAccounting.maxOutstandingBytes) || 0,
                peakEventBytes: 0,
                peakControlBytes: 0,
                peakTerminalBytes: Number(ownerAccounting.maxRetainedBytes) || Number(ownerAccounting.retainedBytes) || 0,
                cumulativeBytes: Number(ownerAccounting.cumulativeActualBytes) || 0,
              };
            const sharedReads = event.sharedReadAccounting && typeof event.sharedReadAccounting === "object"
              ? event.sharedReadAccounting as Record<string, unknown> : {};
            const counterErrorDelivery = counterErrorUnavailable.get(event.invocationId);
            counterErrorUnavailable.delete(event.invocationId);
            invocationTelemetry.push({ invocationId: event.invocationId, ...producer, sharedReadAccounting: sharedReads, ...(counterErrorDelivery ? { counterErrorDelivery } : {}) });
            if (event.declaredFileCapture && typeof event.declaredFileCapture === "object" && Array.isArray((event.declaredFileCapture as { results?: unknown }).results)) {
              for (const result of (event.declaredFileCapture as { results: unknown[] }).results) if (result && typeof result === "object") declaredFileCapture.push(sanitizeRetainedEvidence(result) as Record<string, unknown>);
            }
            processCounterActivity += Number(event.counterWriteActivityCount) || 0;
            counterUncertainty += Number(event.counterUncertaintyCount) || 0;
            if (event.counterBindingValidated === true) queryOnlyBindings += 1;
            const hostCapturePending = event.declaredFileCapture && typeof event.declaredFileCapture === "object"
              && (event.declaredFileCapture as { status?: unknown }).status === "host_capture_requested";
            if (captureSettlements.hasJob(event.invocationId) || hostCapturePending) captureSettlements.addTerminal(event);
            else finishTerminal(event);
          }
        }
        deliverHostAcknowledgements();
        const captureSettlement = captureSettlements.settleNext((job) => {
          const capture = captureSettledFilesWithSharedCredits(job.specs, job.workspaceRealPath, reader, job.maxTotalBytes);
          if (capture) {
            for (const result of capture.results) declaredFileCapture.push(sanitizeRetainedEvidence(result) as Record<string, unknown>);
            reader.recordSharedPeak();
            const invocationAccounting = invocationTelemetry.find((item) => item.invocationId === job.invocationId);
            if (invocationAccounting) invocationAccounting.hostSharedReadAccounting = reader.sharedBudget.accounting();
            // The bounded read is complete before the owner admits durable
            // publication of the enriched terminal. This releases its read
            // permission without creating a helper-local budget.
            commandReadBudget.finalizeCycle();
          }
          return capture;
        }, (invocationId, terminal) => telemetryOwner.commitHostEvidence(invocationId, terminal));
        if (captureSettlement?.kind === "terminal") finishTerminal(captureSettlement.terminal);
        if (captureSettlement?.kind === "unavailable") {
          const reason = captureSettlement.reason;
          terminalObservationReason = `terminal evidence unavailable: ${reason}`;
          invocationTelemetry.push({
            invocationId: captureSettlement.invocationId,
            terminalEvidence: "unavailable",
            terminalUnavailableReason: reason,
            declaredFileCapture: captureSettlement.capture.results.map((item) => sanitizeRetainedEvidence(item)),
            hostSharedReadAccounting: reader.sharedBudget.accounting(),
          });
          acknowledgedInvocations.delete(captureSettlement.invocationId);
          pendingHostAcknowledgements.delete(captureSettlement.invocationId);
          const transportId = transportIdsByInvocation.get(captureSettlement.invocationId);
          transportIdsByInvocation.delete(captureSettlement.invocationId);
          commandReadBudget.abandonHelperReadGrants(captureSettlement.invocationId);
          try { counterService.unregister(captureSettlement.invocationId); } catch {}
          reader.retire(captureSettlement.invocationId, transportId);
          // No terminal generation is retired here: an earlier committed
          // generation remains authoritative evidence rather than being erased
          // merely because its successor could not be published.
        }
        if (captureSettlement?.kind === "unadmitted") {
          // P-CAPQUEUE-UNADMITTED-TERMINAL: the producer's own committed
          // terminal remains the durable evidence. Its capture is recorded as
          // unavailable and the terminal takes the non-capture path.
          invocationTelemetry.push({
            invocationId: captureSettlement.invocationId,
            declaredFileCaptureEvidence: "unavailable",
            declaredFileCaptureUnavailableReason: captureSettlement.reason,
          });
          finishTerminal(captureSettlement.terminal);
        }
        const pendingArtifact = artifactTerminals.firstPending();
        if (pendingArtifact && sealCancellation(pendingArtifact)) {
          recordCleanupOutcome(retireSettledEvidence(
            reader,
            telemetryOwner,
            pendingArtifact.invocationId,
            typeof pendingArtifact.transportId === "string" ? pendingArtifact.transportId : undefined,
          ), "evidence-retirement-caller", settlementFailureRecords);
        }
        measureTelemetry();
      };
      const drainEvents = async () => {
        do {
          if (processMonitorDrainTurn(processEvents, reader, captureSettlements, artifactTerminals)) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } while (monitorDrainPending(reader, captureSettlements, artifactTerminals));
      };
      drainEventsForCleanup = drainEvents;
      const local = createLocalBashOperations();
      // Native bash owns truncation/full-output references. Feed it the complete
      // sanitized command result at settlement, never unsafe partial echoes.
      const completeOutput: Buffer[] = [];
      const operations = {
        exec: async (command: string, cwd: string, options: Parameters<typeof local.exec>[2]) => {
          // P-INTERVAL-RETAINED-FAILURE (decision 4 / hard rule 3): an exception inside this interval
          // callback (processEvents, or the fallback alarm onUpdate) previously escaped the registered
          // execution as a process-level uncaught exception -- neither retained nor reported beside the
          // child's real outcome. The callback body is unchanged; only the try/catch around it is new.
          // On the first caught failure only, it is pushed into the existing settlementFailureRecords
          // (the same array HR3-EXTEND's settleResources() already reports from), so the existing
          // reporting emits it as a {step:"interval-poll", nativeSettlement:"not-established"}
          // diagnostic beside the child's own outcome, exactly like every other settlement-step entry.
          // Named deviation from the family plan's "stop that interval" text: the interval keeps
          // running. CommandTelemetryOwner.drainEvents() feeds pumpRequests, so stopping the interval on
          // a caught failure could hold producer grants until settlement, and settlement waits for the
          // child -- see the item report. No new field, timer or retry; pollMs is unchanged.
          let intervalFailureRecorded = false;
          const poll = setInterval(() => {
            try {
              processEvents();
              const now = performance.now();
              if (!fallbackAlarmSent && now - started >= policy.minimumObservationMs && now - lastOutput >= policy.alarmAfterMs) {
                fallbackAlarmSent = true;
                onUpdate?.({ content: latestUpdate?.content ?? [], details: {
                  ...(latestUpdate?.details as Record<string, unknown> | undefined),
                  noOutputAlarm: { schemaVersion: 1, type: "command_no_output_alarm", commandId, wallTime: new Date().toISOString(), elapsedMs: now - started, noOutputMs: now - lastOutput, monotonicMs: now, eligibility: { eligible: false, reason: helperSeen ? "command-level observe-only fallback" : "no contracted test child observed" } },
                } as NoOutputDetails });
              }
            } catch (error) {
              if (!intervalFailureRecorded) {
                intervalFailureRecorded = true;
                settlementFailureRecords.push({ step: "interval-poll", error });
              }
            }
          }, policy.pollMs);
          poll.unref?.();
          let outputComplete = false;
          try {
            const effectivePath = options.env?.PATH ?? options.env?.Path ?? process.env.PATH ?? "";
            const outcome = await local.exec(command, cwd, { ...options, env: {
              ...(options.env ?? {}),
              PATH: `${shimDir}${path.delimiter}${effectivePath}`,
              PI_ORC_NO_OUTPUT_ORIGINAL_PATH: effectivePath,
            }, onData(data) {
              lastOutput = performance.now(); fallbackAlarmSent = false;
              completeOutput.push(Buffer.from(data));
            } });
            outputComplete = true;
            return outcome;
          } finally {
            try {
              const safe = outputComplete ? sanitizeWorkerText(Buffer.concat(completeOutput).toString("utf8"))
                : completeOutput.length ? "[incomplete command output withheld]\n" : "";
              completeOutput.length = 0;
              if (safe.length > 0) options.onData(Buffer.from(safe, "utf8"));
            } finally { clearInterval(poll); }
          }
        },
      };
      const inner = createBashToolDefinition(ctx.cwd, { operations });
      const wrappedUpdate = onUpdate ? (update: Parameters<NonNullable<typeof onUpdate>>[0]) => { latestUpdate = update; onUpdate(update); } : undefined;
      let result: Awaited<ReturnType<typeof inner.execute>> | undefined;
      let thrown: unknown;
      let retainedCounterServiceFailure: { name: string; message: string } | undefined;
      try { result = await inner.execute(toolCallId, params, signal, wrappedUpdate, ctx); } catch (error) { thrown = error; }
      try { await settleResources(); }
      catch (error) {
        // HR3-RETAINED-TELEMETRY-DIAGNOSTIC: a settlement failure that is
        // exactly the counter service's own retained transport failure, whose
        // native close the close itself already witnessed, is the service's
        // own retained diagnostic, not a falsification of the command's real
        // outcome (hard rule 3). It is reported separately in monitorIo.
        const counterTransport = counterService.getTransportStats();
        if (error instanceof Error && error === counterTransport.transportFailure && counterTransport.nativeClosed === true) {
          retainedCounterServiceFailure = { name: error.name, message: redactActionText(error.message).slice(0, 512) };
        }
        // HR3-EXTEND-SETTLEMENT-DIAGNOSTIC (decision 4 / finding 6, hard rule 3): every settlement
        // failure recorded above -- not only HR3's own retained case -- is reported as a diagnostic
        // instead of being folded into `thrown`. The command's outcome stays whatever inner.execute
        // itself already produced (fulfilled or its own rejection), never the settlement failure.
      }
      for (const [invocationId, counterErrorDelivery] of counterErrorUnavailable) invocationTelemetry.push({ invocationId, counterErrorDelivery });
      counterErrorUnavailable.clear();
      if (counterErrorUnavailableOmitted > 0) invocationTelemetry.push({ counterErrorDeliveryOmitted: counterErrorUnavailableOmitted });
      const cancellations = cancellationCount <= 200
        ? [...firstCancellations, ...lastCancellations]
        : [...firstCancellations, ...lastCancellations.slice(-100)];
      const cancellationJournalSha256 = cancellationCount > 0 ? commandJournalHash.digest("hex") : "";
      measureTelemetry();
      const queueStats = counterService.getTransportStats();
      telemetryPeak.maxQueuedBytes = Math.max(telemetryPeak.maxQueuedBytes, queueStats.maxQueuedBytes);
      telemetryPeak.maxInFlight = Math.max(telemetryPeak.maxInFlight, queueStats.inFlight);
      const sharedReadAccounting = commandReadBudget.accounting();
      const commandOwnerAccounting = telemetryOwner.accounting();
      const telemetryAccounting = {
        ...telemetryPeak,
        measurementStatus: telemetryMeasurementUnavailable ? "unavailable" as const : "measured" as const,
        ...(telemetryMeasurementUnavailable ? {
          peakDiskBytes: null, peakFiles: null, peakCounterBytes: null, peakFileObservationBytes: null,
          peakEventBytes: null, peakControlBytes: null, peakTerminalBytes: null,
        } : {}),
        maxQueuedBytes: Math.max(telemetryPeak.maxQueuedBytes, Number(commandOwnerAccounting.maxQueuedBytes) || 0),
        maxPollBytes: Math.max(reader.maxPollBytes, sharedReadAccounting.maxCycleBytes, Number(commandOwnerAccounting.maxOutstandingBytes) || 0),
      };
      // CEILING-DIAGNOSTIC (owner decision of 30 September 2026, applying decision 4 / hard rule 3):
      // a telemetry ceiling breach is discovered only after settlement, after the child's real outcome
      // is already known. Throwing here would discard that real outcome (fulfilled or its own
      // rejection) and every detail already computed (telemetryAccounting, monitorIo, HR3 and
      // HR3-EXTEND diagnostics), and would skip finalPatches.set below, leaving the command root
      // uncleaned. The seven comparisons and messages stay byte-identical and in the same order; each
      // is now retained instead of thrown, and reported in telemetrySettlementFailures alongside the
      // settlement-step entries below. No ceiling value changes and no new field is added.
      const telemetryCeilingFailures: string[] = [];
      if (telemetryPeak.peakCounterBytes > 16 * 1024) telemetryCeilingFailures.push("COUNTER_TELEMETRY_PEAK_EXCEEDED");
      if (telemetryPeak.peakEventBytes > 512 * 1024) telemetryCeilingFailures.push("EVENT_TELEMETRY_PEAK_EXCEEDED");
      if (telemetryPeak.peakControlBytes > 64 * 1024) telemetryCeilingFailures.push("CONTROL_TELEMETRY_PEAK_EXCEEDED");
      if (telemetryPeak.peakTerminalBytes > 256 * 1024) telemetryCeilingFailures.push("TERMINAL_TELEMETRY_PEAK_EXCEEDED");
      if (telemetryPeak.peakDiskBytes > 1024 * 1024) telemetryCeilingFailures.push("INVOCATION_TELEMETRY_PEAK_EXCEEDED");
      if (telemetryAccounting.maxQueuedBytes > 64 * 1024) telemetryCeilingFailures.push("CONTROL_QUEUE_PEAK_EXCEEDED");
      if (telemetryAccounting.maxPollBytes > 256 * 1024) telemetryCeilingFailures.push("GLOBAL_POLL_PEAK_EXCEEDED");
      // HR3-EXTEND-SETTLEMENT-DIAGNOSTIC: one entry per recorded settlement-step failure, in step
      // order. nativeSettlement is only "witnessed" for counter-service-close when the transport's
      // own getTransportStats().nativeClosed is true by the time settlement finished; every other
      // step defaults to "not-established" (hard rule 3: an attempted close/drain/finalize does not
      // by itself establish native settlement). CEILING-DIAGNOSTIC then appends one
      // step:"telemetry-ceiling" entry per exceeded ceiling, in the same fixed check order as above;
      // the key is absent (undefined) only when neither list has any entries.
      const telemetrySettlementFailures = (settlementFailureRecords.length > 0 || telemetryCeilingFailures.length > 0)
        ? [
            ...settlementFailureRecords.map(({ step, error }) => ({
              step,
              name: error instanceof Error ? error.name : "Error",
              message: redactActionText(error instanceof Error ? error.message : String(error)).slice(0, 512),
              nativeSettlement: (step === "counter-service-close" && counterService.getTransportStats().nativeClosed === true)
                ? "witnessed" as const : "not-established" as const,
            })),
            ...telemetryCeilingFailures.map((message) => ({
              step: "telemetry-ceiling",
              name: "Error",
              message,
              nativeSettlement: "not-established" as const,
            })),
          ]
        : undefined;
      const monitorIo = {
        eventBytesRead: reader.eventBytesRead,
        eventFileBytes: reader.eventFileBytes,
        maxBufferedEventBytes: reader.maxBufferedEventBytes,
        maxActualReadAndDeliveryBytesPerCycle: Number(commandOwnerAccounting.maxCombinedActualBytes) || 0,
        corruptEventRecords: reader.corruptEventRecords,
        unavailableEventSourceDispositions: reader.unavailableEventSourceDispositions,
        unavailableCounterErrorDispositions: counterErrorUnavailableDispositions,
        ...(retainedCounterServiceFailure ? { retainedCounterServiceFailure } : {}),
        ...(telemetrySettlementFailures ? { telemetrySettlementFailures } : {}),
      };
      if (cancellationCount > 0 && cancellations.length > 0) {
        const first = cancellations[0];
        const summary = cancellations.length === 1
          ? first.summary
          : `${cancellationCount} tests were cancelled after producing no output. First: ${first.summary}`;
        const inline = cancellations.map((item) => `[${item.invocationId}] ${boundedFirstTail(item.partialLog, 4096)}`).join("\n");
        const details: NoOutputDetails = { ...(result?.details ?? {}), noOutput: {
          ...first, summary, partialLog: inline, cancellations,
          minimumObservationMs: policy.minimumObservationMs, minimumAlarmLeadMs: policy.minimumAlarmLeadMs,
          cancellationCount,
          cancellationJournalPath: commandJournalPath,
          cancellationJournalSha256,
          inlineCancellationOmissions: Math.max(0, cancellationCount - cancellations.length),
        }, noOutputObservation: { mode: "automatic_test_child", reason: "host-contracted child reached a matching terminal signal after the owned-handle action" }, monitorIo,
        observationMetrics: { processCounterActivity, counterUncertainty, queryOnlyBindings }, declaredFileCapture, telemetryAccounting, invocationTelemetry, commandOwnerAccounting };
        finalPatches.set(toolCallId, { details, text: `${summary}\nPartial test logs:\n${inline || "(empty)"}`, cleanup: [commandRoot] });
      } else {
        finalPatches.set(toolCallId, { details: { ...(result?.details ?? {}), noOutputObservation: { mode: "observe_only", reason: helperSeen ? (terminalObservationReason || "no confirmed contracted-child cancellation") : "no host-contracted test child executed" }, monitorIo,
          observationMetrics: { processCounterActivity, counterUncertainty, queryOnlyBindings }, declaredFileCapture, telemetryAccounting, invocationTelemetry, commandOwnerAccounting }, text: "", cleanup: [commandRoot] });
      }
      if (thrown) throw thrown;
      return result!;
      } catch (error) { primaryError = error; throw error; }
      finally {
        try { await settleResources(); }
        catch (error) {
          if (primaryError) throw new AggregateError([primaryError, error], "NO_OUTPUT_MONITOR_COMMAND_AND_CLEANUP_FAILED");
          throw error;
        }
      }
    },
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return undefined;
    const patch = finalPatches.get(event.toolCallId);
    if (!patch) return undefined;
    finalPatches.delete(event.toolCallId);
    const existing = redactActionText(event.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
    const text = patch.text ? `${existing ? `${existing}\n\n` : ""}${patch.text}` : existing;
    for (const directory of patch.cleanup) {
      // Retained/unknown evidence must not be deleted through the enclosing root.
      const retainedEvidence = patch.details.monitorIo?.telemetrySettlementFailures?.some((entry) => entry.step === "evidence-retirement-caller");
      const outcome = retainedEvidence
        ? { settled: false, reason: "COMMAND_ROOT_RETAINED_FOR_UNSETTLED_EVIDENCE" }
        : cleanupCommandRoot(directory);
      const records: Array<{ step: string; error: unknown }> = [];
      recordCleanupOutcome(outcome, "command-root-cleanup", records);
      if (records.length && patch.details.monitorIo) {
        patch.details.monitorIo.telemetrySettlementFailures ??= [];
        patch.details.monitorIo.telemetrySettlementFailures.push(...records.map(({ step, error }) => ({
          step, name: "Error", message: (error as Error).message, nativeSettlement: "not-established" as const,
        })));
      }
    }
    return { content: [{ type: "text", text }], details: patch.details, ...(patch.details.noOutput ? { isError: true } : {}) };
  });
  pi.events.emit("orchestrator:no-output-monitor-ready", { version: 1 });
}
