/** Host-owned, secret-safe chronological evidence derived from Pi JSON events. */

import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { redactCompleteText } from "./streaming-redactor.cjs";

export type ActionEvidenceOmissionReason =
  | "entry-count-budget"
  | "serialized-size-budget";

export interface NoOutputCancellationEvidence {
  schemaVersion: 1;
  outcome: "cancelled_no_output";
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
  artifactPath: string;
  artifactSha256: string;
  artifactBytes: number;
  artifactIntegrity: "verified" | "unavailable_or_changed";
}

export interface NoOutputActionEvidence extends NoOutputCancellationEvidence {
  minimumObservationMs: number;
  minimumAlarmLeadMs: number;
  cancellations: NoOutputCancellationEvidence[];
}

export interface CancellationJournalReference {
  path: string;
  count: number;
  finalDigest: string;
  schemaVersion: 1;
}

export interface ActionCancellationRecord {
  toolCallId: string;
  invocationId: string;
  summary: string;
  noOutputMs: number;
  artifactPath: string;
}

export interface ActionEvidenceEntry {
  sequence: number;
  toolCallId: string;
  toolName: string;
  status: "completed" | "incomplete";
  startedSequence: number;
  completedSequence: number;
  command?: string;
  target?: string;
  timeoutKeyPresent?: boolean;
  exitCode: number | null;
  outcome: "succeeded" | "failed" | "cancelled_no_output" | "unknown" | "incomplete";
  /** Sanitized tool error text when Pi emitted one. */
  error?: string;
  /** Authoritative, sanitized evidence from the authenticated test-child supervisor. */
  noOutput?: NoOutputActionEvidence;
}

export interface ActionEvidenceLedger {
  schemaVersion: 1;
  source: "host-jsonl-tool-events";
  totalEntries: number;
  totalCompletedEntries: number;
  incompleteEntries: number;
  omittedEntries: number;
  omittedCompletedEntries: number;
  /** Stable reasons explaining every whole-entry evidence omission. */
  omissionReasons: ActionEvidenceOmissionReason[];
  /** Hard UTF-8 JSON size ceiling applied by finalize/merge. */
  serializedSizeLimitBytes: number;
  /** Bounded inline index; complete records are in host-owned journals. */
  cancellations: ActionCancellationRecord[];
  omittedCancellationIndexRecords: number;
  cancellationJournals: CancellationJournalReference[];
  entries: ActionEvidenceEntry[];
}

interface PendingAction {
  sequence: number;
  toolCallId: string;
  toolName: string;
  startedSequence: number;
  command?: string;
  target?: string;
  timeoutKeyPresent?: boolean;
}

const MAX_RETAINED_ACTION_ENTRIES = 200;
const FIRST_RETAINED_ACTION_ENTRIES = 100;
export const ACTION_EVIDENCE_SERIALIZED_LIMIT_BYTES = 128 * 1024;

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
function boundedEvidencePreview(value: string, maxBytes = 2048): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const half = Math.floor(maxBytes / 2);
  return `${utf8Prefix(value, half)}\n[...sealed middle omitted...]\n${utf8Tail(value, maxBytes - half)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Shared UTF-8 streaming redactor is also used by live command retention. */
export function redactActionText(value: string): string {
  return redactCompleteText(value);
}

function eventInput(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(raw.input) ?? record(raw.args) ?? record(raw.arguments) ?? record(raw.toolInput);
}

function callId(raw: Record<string, unknown>, fallback: string): string {
  return text(raw.toolCallId) ?? text(raw.tool_call_id) ?? text(raw.callId) ?? text(raw.id) ?? fallback;
}

function nestedValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const raw = record(value);
  return raw ? Object.values(raw) : [];
}

function findStructuredExitCode(value: unknown, depth = 0, seen = new Set<object>()): number | null {
  if (depth > 8 || typeof value === "string") return null;
  if (value && typeof value === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
  }
  const raw = record(value);
  if (raw) {
    for (const key of ["exitCode", "exit_code", "statusCode", "status_code", "code"]) {
      const candidate = raw[key];
      if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
      if (typeof candidate === "string" && /^-?\d+$/.test(candidate.trim())) return Number(candidate);
    }
  }
  for (const nested of nestedValues(value)) {
    const code = findStructuredExitCode(nested, depth + 1, seen);
    if (code !== null) return code;
  }
  return null;
}

function findTextExitCode(value: unknown, depth = 0, seen = new Set<object>()): number | null {
  if (depth > 8) return null;
  if (value && typeof value === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
  }
  if (typeof value === "string") {
    // Failed tool output can quote earlier checks (for example, "exit code: 0")
    // before Pi appends its authoritative terminal summary. Only a terminal
    // suffix is eligible as fallback evidence; structured result fields still
    // take precedence in the caller.
    const match = /(?:^|\r?\n)\s*command\s+exited\s+with\s+(?:status|code)\s+(-?\d+)\s*$/i.exec(value);
    if (match) return Number(match[1]);
  }
  for (const nested of nestedValues(value)) {
    const code = findTextExitCode(nested, depth + 1, seen);
    if (code !== null) return code;
  }
  return null;
}

/** Structured tool-result status is authoritative; prose is only a fallback. */
function findCompletionStatus(value: unknown, depth = 0, seen = new Set<object>()): "succeeded" | "failed" | undefined {
  if (depth > 8) return undefined;
  if (value && typeof value === "object") {
    if (seen.has(value)) return undefined;
    seen.add(value);
  }
  const raw = record(value);
  if (raw) {
    for (const key of ["status", "state", "outcome"]) {
      const candidate = typeof raw[key] === "string" ? String(raw[key]).trim().toLowerCase() : "";
      if (/^(?:success|succeeded|completed|complete|passed|pass|ok)$/.test(candidate)) return "succeeded";
      if (/^(?:failure|failed|error|errored|rejected|cancelled|canceled|timed_out|timeout)$/.test(candidate)) return "failed";
    }
  }
  for (const nested of nestedValues(value)) {
    const status = findCompletionStatus(nested, depth + 1, seen);
    if (status) return status;
  }
  return undefined;
}

function parseCancellation(value: unknown, maxPartialBytes = 8 * 1024): NoOutputCancellationEvidence | undefined {
  const candidate = record(value);
  if (
    candidate?.schemaVersion !== 1
    || candidate.outcome !== "cancelled_no_output"
    || candidate.cancellationRequested !== true
    || candidate.cancellationAccepted !== true
    || candidate.cancellationConfirmed !== true
    || candidate.confirmationBasis !== "terminal_signal_after_owned_handle_action"
    || candidate.terminalExitCode !== null
    || candidate.terminalSignal !== "SIGTERM"
    || candidate.cancellationTarget !== "retained-direct-test-child-handle"
    || candidate.eligibility !== "authenticated_run_owned_test_child"
    || typeof candidate.invocationId !== "string"
    || typeof candidate.summary !== "string"
    || typeof candidate.partialLog !== "string"
    || typeof candidate.artifactPath !== "string"
    || typeof candidate.artifactSha256 !== "string"
    || typeof candidate.artifactBytes !== "number"
    || (candidate.artifactIntegrity !== "verified" && candidate.artifactIntegrity !== "unavailable_or_changed")
  ) return undefined;
  const finite = (key: string): number => typeof candidate[key] === "number" && Number.isFinite(candidate[key]) ? Number(candidate[key]) : 0;
  return {
    schemaVersion: 1,
    outcome: "cancelled_no_output",
    invocationId: candidate.invocationId,
    summary: redactActionText(candidate.summary).slice(0, 512),
    noOutputMs: finite("noOutputMs"),
    totalElapsedMs: finite("totalElapsedMs"),
    alarmMonotonicMs: finite("alarmMonotonicMs"),
    alarmAcknowledgedMonotonicMs: finite("alarmAcknowledgedMonotonicMs"),
    cancelledMonotonicMs: finite("cancelledMonotonicMs"),
    cancellationRequested: true,
    cancellationAccepted: true,
    cancellationConfirmed: true,
    confirmationBasis: "terminal_signal_after_owned_handle_action",
    terminalExitCode: null,
    terminalSignal: "SIGTERM",
    cancellationTarget: "retained-direct-test-child-handle",
    eligibility: "authenticated_run_owned_test_child",
    observedSources: Array.isArray(candidate.observedSources)
      ? candidate.observedSources.filter((item): item is string => typeof item === "string").slice(0, 32).map((item) => redactActionText(item).slice(0, 1024))
      : [],
    observationErrors: Array.isArray(candidate.observationErrors)
      ? candidate.observationErrors.filter((item): item is string => typeof item === "string").slice(0, 16).map((item) => redactActionText(item).slice(0, 1024))
      : [],
    partialLog: utf8Prefix(redactActionText(candidate.partialLog), maxPartialBytes),
    artifactPath: redactActionText(candidate.artifactPath),
    artifactSha256: candidate.artifactSha256,
    artifactBytes: candidate.artifactBytes,
    artifactIntegrity: candidate.artifactIntegrity,
  };
}

function findNoOutputEvidence(value: unknown, depth = 0, seen = new Set<object>()): NoOutputActionEvidence | undefined {
  if (depth > 8 || !value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const raw = record(value);
  if (raw) {
    const candidate = record(raw.noOutput);
    const first = parseCancellation(candidate);
    if (first) {
      const cancellations = Array.isArray(candidate?.cancellations)
        ? candidate.cancellations.map((item) => parseCancellation(item)).filter((item): item is NoOutputCancellationEvidence => item !== undefined)
        : [first];
      if (cancellations.length === 0) cancellations.push(first);
      return {
        ...first,
        summary: typeof candidate?.summary === "string" ? redactActionText(candidate.summary).slice(0, 512) : first.summary,
        partialLog: utf8Prefix(cancellations.map((item) => item.partialLog).join("\n"), 16 * 1024),
        minimumObservationMs: typeof candidate?.minimumObservationMs === "number" ? candidate.minimumObservationMs : 0,
        minimumAlarmLeadMs: typeof candidate?.minimumAlarmLeadMs === "number" ? candidate.minimumAlarmLeadMs : 0,
        cancellations,
      };
    }
  }
  for (const nested of nestedValues(value)) {
    const evidence = findNoOutputEvidence(nested, depth + 1, seen);
    if (evidence) return evidence;
  }
  return undefined;
}

function findErrorText(value: unknown, depth = 0, seen = new Set<object>()): string | undefined {
  if (depth > 8) return undefined;
  if (value && typeof value === "object") {
    if (seen.has(value)) return undefined;
    seen.add(value);
  }
  if (typeof value === "string" && value.trim()) return value;
  const raw = record(value);
  if (raw) {
    for (const key of ["errorMessage", "error", "message", "text", "stderr"]) {
      const candidate = text(raw[key]);
      if (candidate) return candidate;
    }
  }
  for (const nested of nestedValues(value)) {
    const candidate = findErrorText(nested, depth + 1, seen);
    if (candidate) return candidate;
  }
  return undefined;
}

function safeActionFields(
  toolName: string,
  input: Record<string, unknown> | undefined,
): Pick<PendingAction, "command" | "target" | "timeoutKeyPresent"> {
  if (!input) return {};
  if (toolName === "bash") {
    const command = text(input.command);
    return {
      ...(command ? { command: redactActionText(command) } : {}),
      timeoutKeyPresent: Object.prototype.hasOwnProperty.call(input, "timeout"),
    };
  }
  const target = text(input.path) ?? text(input.filePath) ?? text(input.file) ?? text(input.pattern);
  return target ? { target: redactActionText(target) } : {};
}

function retainByCount(entries: ActionEvidenceEntry[]): ActionEvidenceEntry[] {
  return entries.length <= MAX_RETAINED_ACTION_ENTRIES
    ? [...entries]
    : [
        ...entries.slice(0, FIRST_RETAINED_ACTION_ENTRIES),
        ...entries.slice(-(MAX_RETAINED_ACTION_ENTRIES - FIRST_RETAINED_ACTION_ENTRIES)),
      ];
}

function ledgerBytes(ledger: ActionEvidenceLedger): number {
  return Buffer.byteLength(JSON.stringify(ledger), "utf8");
}

function compactCancellationRecord(toolCallId: string, evidence: NoOutputCancellationEvidence): ActionCancellationRecord {
  return {
    toolCallId,
    invocationId: evidence.invocationId,
    summary: evidence.summary.slice(0, 160),
    noOutputMs: evidence.noOutputMs,
    artifactPath: evidence.artifactPath,
  };
}

function buildBoundedLedger(input: {
  entries: ActionEvidenceEntry[];
  totalEntries: number;
  totalCompletedEntries: number;
  inheritedReasons?: ActionEvidenceOmissionReason[];
  inheritedOmittedEntries?: number;
  inheritedCancellations?: ActionCancellationRecord[];
  cancellationJournals?: CancellationJournalReference[];
}): ActionEvidenceLedger {
  let retained = retainByCount(input.entries);
  const reasons = new Set<ActionEvidenceOmissionReason>(input.inheritedReasons ?? []);
  const inheritedOmittedEntries = Math.max(0, input.inheritedOmittedEntries ?? 0);
  const newlyCountOmitted = input.entries.length - retained.length
    + Math.max(0, input.totalEntries - input.entries.length - inheritedOmittedEntries);
  if (newlyCountOmitted > 0) reasons.add("entry-count-budget");
  const cancellationMap = new Map<string, ActionCancellationRecord>();
  for (const record of input.inheritedCancellations ?? []) {
    cancellationMap.set(`${record.toolCallId}:${record.invocationId}`, {
      toolCallId: record.toolCallId, invocationId: record.invocationId,
      summary: record.summary.slice(0, 160), noOutputMs: record.noOutputMs, artifactPath: record.artifactPath,
    });
  }
  for (const entry of input.entries) {
    for (const evidence of entry.noOutput?.cancellations ?? (entry.noOutput ? [entry.noOutput] : [])) {
      const record = compactCancellationRecord(entry.toolCallId, evidence);
      cancellationMap.set(`${record.toolCallId}:${record.invocationId}`, record);
    }
  }
  let cancellations = [...cancellationMap.values()];
  const totalCancellationRecords = Math.max(
    cancellations.length,
    (input.cancellationJournals ?? []).reduce((sum, journal) => sum + journal.count, 0),
  );
  if (cancellations.length > MAX_RETAINED_ACTION_ENTRIES) {
    cancellations = [...cancellations.slice(0, FIRST_RETAINED_ACTION_ENTRIES), ...cancellations.slice(-(MAX_RETAINED_ACTION_ENTRIES - FIRST_RETAINED_ACTION_ENTRIES))];
    reasons.add("entry-count-budget");
  }

  const materialize = (): ActionEvidenceLedger => {
    const retainedCompleted = retained.filter((entry) => entry.status === "completed").length;
    return {
      schemaVersion: 1,
      source: "host-jsonl-tool-events",
      totalEntries: input.totalEntries,
      totalCompletedEntries: input.totalCompletedEntries,
      incompleteEntries: input.totalEntries - input.totalCompletedEntries,
      omittedEntries: input.totalEntries - retained.length,
      omittedCompletedEntries: input.totalCompletedEntries - retainedCompleted,
      omissionReasons: [...reasons].sort(),
      serializedSizeLimitBytes: ACTION_EVIDENCE_SERIALIZED_LIMIT_BYTES,
      cancellations,
      omittedCancellationIndexRecords: Math.max(0, totalCancellationRecords - cancellations.length),
      cancellationJournals: input.cancellationJournals ?? [],
      entries: retained,
    };
  };

  let ledger = materialize();
  while (retained.length > 0 && ledgerBytes(ledger) > ACTION_EVIDENCE_SERIALIZED_LIMIT_BYTES) {
    reasons.add("serialized-size-budget");
    // Omit one complete entry at a time. Removing the largest projection first
    // preserves the most chronological evidence without ever slicing a field.
    let largestIndex = 0;
    let largestBytes = -1;
    for (let index = 0; index < retained.length; index += 1) {
      const bytes = Buffer.byteLength(JSON.stringify(retained[index]), "utf8");
      if (bytes > largestBytes) {
        largestBytes = bytes;
        largestIndex = index;
      }
    }
    retained.splice(largestIndex, 1);
    ledger = materialize();
  }
  while (cancellations.length > 0 && ledgerBytes(ledger) > ACTION_EVIDENCE_SERIALIZED_LIMIT_BYTES) {
    reasons.add("serialized-size-budget");
    cancellations = cancellations.slice(0, -1);
    ledger = materialize();
  }
  if (ledgerBytes(ledger) > ACTION_EVIDENCE_SERIALIZED_LIMIT_BYTES) {
    throw new Error("ACTION_EVIDENCE_JOURNAL_REFERENCES_EXCEED_BYTE_BUDGET");
  }
  return ledger;
}

export interface ActionEvidenceCollectorOptions {
  cancellationJournalFile?: string;
}

/** Incremental collector: retains sanitized projections and journals cancellations immediately. */
export class ActionEvidenceCollector {
  private eventSequence = 0;
  private entrySequence = 0;
  private readonly pending = new Map<string, PendingAction>();
  private readonly entries: ActionEvidenceEntry[] = [];
  private completedEntryCount = 0;
  private readonly sealedReceiptDigests = new Map<string, string>();
  private readonly sealedPreviews = new Map<string, NoOutputCancellationEvidence>();
  private readonly sealedKeysByCall = new Map<string, string[]>();
  private sealedPreviewBytes = 0;
  private readonly sealedPreviewByteLimit = 256 * 1024;
  private cancellationJournalCount = 0;
  private cancellationJournalDigest = "0".repeat(64);
  private readonly cancellationJournalFile: string | undefined;
  private cancellationJournalFd: number | undefined;
  private cancellationJournalDevice: number | undefined;
  private cancellationJournalInode: number | undefined;
  private cancellationJournalSize = 0;
  private finalizedLedger: ActionEvidenceLedger | undefined;

  constructor(options: ActionEvidenceCollectorOptions = {}) {
    this.cancellationJournalFile = options.cancellationJournalFile;
    if (this.cancellationJournalFile) {
      mkdirSync(path.dirname(this.cancellationJournalFile), { recursive: true });
      this.cancellationJournalFd = openSync(this.cancellationJournalFile, "a+", 0o600);
      const stat = fstatSync(this.cancellationJournalFd);
      this.cancellationJournalDevice = stat.dev;
      this.cancellationJournalInode = stat.ino;
      this.cancellationJournalSize = stat.size;
    }
  }

  private assertJournalIntegrity(): void {
    if (!this.cancellationJournalFile || this.cancellationJournalFd === undefined) return;
    const descriptorStat = fstatSync(this.cancellationJournalFd);
    const pathStat = statSync(this.cancellationJournalFile);
    if (
      descriptorStat.dev !== this.cancellationJournalDevice
      || descriptorStat.ino !== this.cancellationJournalInode
      || pathStat.dev !== descriptorStat.dev
      || pathStat.ino !== descriptorStat.ino
      || descriptorStat.size !== this.cancellationJournalSize
    ) throw new Error("ACTION_EVIDENCE_JOURNAL_INTEGRITY: journal identity, pathname, or append offset changed");
  }

  private closeJournalOnFailure(error: unknown): never {
    if (this.cancellationJournalFd !== undefined) {
      try { closeSync(this.cancellationJournalFd); } catch {}
      this.cancellationJournalFd = undefined;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  private verifyJournalContent(): void {
    if (!this.cancellationJournalFile || this.cancellationJournalFd === undefined) return;
    this.assertJournalIntegrity();
    const decoder = new TextDecoder();
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    let remainder = "";
    let count = 0;
    let previousDigest = "0".repeat(64);
    while (offset < this.cancellationJournalSize) {
      const read = readSync(this.cancellationJournalFd, buffer, 0, Math.min(buffer.length, this.cancellationJournalSize - offset), offset);
      if (read <= 0) throw new Error("ACTION_EVIDENCE_JOURNAL_INTEGRITY: unexpected EOF");
      offset += read;
      const combined = remainder + decoder.decode(buffer.subarray(0, read), { stream: true });
      const lines = combined.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      if (Buffer.byteLength(remainder, "utf8") > 1024 * 1024) throw new Error("ACTION_EVIDENCE_JOURNAL_INTEGRITY: record exceeds bound");
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        const digest = typeof record.digest === "string" ? record.digest : "";
        const { digest: _digest, ...payload } = record;
        const expected = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
        if (digest !== expected || payload.previousDigest !== previousDigest || payload.sequence !== count + 1) {
          throw new Error("ACTION_EVIDENCE_JOURNAL_INTEGRITY: content hash chain mismatch");
        }
        previousDigest = digest;
        count += 1;
      }
    }
    remainder += decoder.decode();
    if (remainder.trim()) throw new Error("ACTION_EVIDENCE_JOURNAL_INTEGRITY: partial terminal record");
    if (count !== this.cancellationJournalCount || previousDigest !== this.cancellationJournalDigest) {
      throw new Error("ACTION_EVIDENCE_JOURNAL_INTEGRITY: count or final digest mismatch");
    }
  }

  private journalCancellation(toolCallId: string, evidence: NoOutputCancellationEvidence): void {
    if (!this.cancellationJournalFile) return;
    const payload = {
      schemaVersion: 1,
      sequence: this.cancellationJournalCount + 1,
      toolCallId,
      previousDigest: this.cancellationJournalDigest,
      evidence,
    };
    const payloadText = JSON.stringify(payload);
    const digest = createHash("sha256").update(payloadText, "utf8").digest("hex");
    const line = `${JSON.stringify({ ...payload, digest })}\n`;
    if (this.cancellationJournalFd === undefined) throw new Error("ACTION_EVIDENCE_JOURNAL_NOT_OPEN");
    try {
      this.assertJournalIntegrity();
      const bytes = Buffer.from(line, "utf8");
      const written = writeSync(this.cancellationJournalFd, bytes, 0, bytes.length, null);
      if (written !== bytes.length) throw new Error("ACTION_EVIDENCE_JOURNAL_PERSISTENCE: short journal write");
      this.cancellationJournalSize += written;
      this.cancellationJournalCount += 1;
      this.cancellationJournalDigest = digest;
    } catch (error) { this.closeJournalOnFailure(error); }
  }

  observe(event: unknown): void {
    const raw = record(event);
    if (!raw) return;
    const kind = text(raw.type);
    if (kind === "tool_execution_update") {
      const partial = record(raw.partialResult);
      const details = record(partial?.details);
      const id = callId(raw, "unknown-call");
      const evidence = parseCancellation(details?.noOutputCancellation, 64 * 1024);
      if (evidence) {
        const canonicalKey = createHash("sha256").update(`${id}\0${evidence.invocationId}`, "utf8").digest("hex");
        const receiptDigest = createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex");
        const existingDigest = this.sealedReceiptDigests.get(canonicalKey);
        if (existingDigest && existingDigest !== receiptDigest) this.closeJournalOnFailure(new Error("ACTION_EVIDENCE_CANCELLATION_CONFLICT: canonical cancellation receipt changed"));
        if (!existingDigest) {
          this.sealedReceiptDigests.set(canonicalKey, receiptDigest);
          this.journalCancellation(id, evidence);
          const keys = this.sealedKeysByCall.get(id) ?? [];
          keys.push(canonicalKey);
          this.sealedKeysByCall.set(id, keys);
          const preview = { ...evidence, partialLog: boundedEvidencePreview(evidence.partialLog) };
          const previewBytes = Buffer.byteLength(JSON.stringify(preview), "utf8");
          if (this.sealedPreviewBytes + previewBytes <= this.sealedPreviewByteLimit) {
            this.sealedPreviews.set(canonicalKey, preview);
            this.sealedPreviewBytes += previewBytes;
          }
        }
      }
      return;
    }
    if (kind !== "tool_execution_start" && kind !== "tool_execution_end") return;
    const eventSequence = ++this.eventSequence;
    const toolName = text(raw.toolName) ?? text(raw.tool_name) ?? "unknown-tool";
    const fallbackId = `${toolName}-${eventSequence}`;
    const id = callId(raw, fallbackId);
    if (kind === "tool_execution_start") {
      const safe = safeActionFields(toolName, eventInput(raw));
      const pending: PendingAction = {
        sequence: ++this.entrySequence,
        toolCallId: id,
        toolName,
        startedSequence: eventSequence,
        ...safe,
      };
      this.pending.set(id, pending);
      return;
    }

    let started = this.pending.get(id);
    if (!started) started = [...this.pending.values()].find((candidate) => candidate.toolName === toolName);
    if (started) this.pending.delete(started.toolCallId);
    const base: PendingAction = started ?? {
      sequence: ++this.entrySequence,
      toolCallId: id,
      toolName,
      startedSequence: Math.max(0, eventSequence - 1),
    };
    const resultPayload = raw.result ?? raw.output ?? raw;
    const structuredNoOutput = findNoOutputEvidence(resultPayload);
    const sealedKeys = this.sealedKeysByCall.get(id) ?? [];
    this.sealedKeysByCall.delete(id);
    const sealedCancellations = sealedKeys
      .map((key) => this.sealedPreviews.get(key))
      .filter((item): item is NoOutputCancellationEvidence => item !== undefined);
    for (const key of sealedKeys) {
      const preview = this.sealedPreviews.get(key);
      if (preview) this.sealedPreviewBytes -= Buffer.byteLength(JSON.stringify(preview), "utf8");
      this.sealedPreviews.delete(key);
      this.sealedReceiptDigests.delete(key);
    }
    const canonicalCancellations = sealedCancellations.length > 0
      ? sealedCancellations
      : structuredNoOutput?.cancellations ?? [];
    const firstSealed = sealedCancellations[0];
    const noOutput: NoOutputActionEvidence | undefined = structuredNoOutput
      ? {
          ...structuredNoOutput,
          ...(firstSealed ?? {}),
          minimumObservationMs: structuredNoOutput.minimumObservationMs,
          minimumAlarmLeadMs: structuredNoOutput.minimumAlarmLeadMs,
          partialLog: utf8Prefix(canonicalCancellations.map((item) => item.partialLog).join("\n"), 16 * 1024),
          cancellations: canonicalCancellations,
        }
      : firstSealed
        ? { ...firstSealed, minimumObservationMs: 0, minimumAlarmLeadMs: 0, partialLog: utf8Prefix(canonicalCancellations.map((item) => item.partialLog).join("\n"), 16 * 1024), cancellations: canonicalCancellations }
        : undefined;
    const structuredExitCode = findStructuredExitCode(raw);
    const isError = raw.isError === true || raw.error === true || typeof raw.error === "string";
    const explicitSuccess = raw.isError === false || raw.error === false;
    const parsedStatus = findCompletionStatus(resultPayload);
    // Terminal prose is eligible only as a fallback for an independently
    // failed result, and only when it reports a non-zero command failure.
    // A diagnostic `exit code: 0` cannot overturn structured failure status.
    const parsedTerminalExitCode = structuredExitCode === null && (isError || parsedStatus === "failed")
      ? findTextExitCode(resultPayload)
      : null;
    const terminalFailureExitCode = parsedTerminalExitCode !== null && parsedTerminalExitCode !== 0
      ? parsedTerminalExitCode
      : null;
    const explicitExitCode = structuredExitCode ?? terminalFailureExitCode;
    const outcome = noOutput
      ? "cancelled_no_output"
      : isError || parsedStatus === "failed"
        ? "failed"
        : explicitExitCode !== null
          ? (explicitExitCode === 0 ? "succeeded" : "failed")
          : explicitSuccess || parsedStatus === "succeeded" ? "succeeded" : "unknown";
    const rawError = outcome === "failed"
      ? findErrorText(raw.error) ?? findErrorText(resultPayload)
      : outcome === "cancelled_no_output" ? noOutput?.summary : undefined;
    const sanitizedError = rawError ? redactActionText(rawError) : undefined;
    const completedEntry: ActionEvidenceEntry = {
      ...base,
      toolCallId: id,
      toolName,
      status: "completed",
      completedSequence: eventSequence,
      exitCode: explicitExitCode,
      outcome,
      ...(sanitizedError ? { error: sanitizedError } : {}),
      ...(noOutput ? { noOutput } : {}),
    };
    this.completedEntryCount += 1;
    if (this.entries.length < MAX_RETAINED_ACTION_ENTRIES) this.entries.push(completedEntry);
    else {
      // Keep the first 100 and most recent 100 terminal entries live.
      this.entries.splice(FIRST_RETAINED_ACTION_ENTRIES, 1);
      this.entries.push(completedEntry);
    }
  }

  finalize(): ActionEvidenceLedger {
    if (this.finalizedLedger) return this.finalizedLedger;
    try { this.verifyJournalContent(); }
    catch (error) { this.closeJournalOnFailure(error); }
    const incomplete = [...this.pending.values()].map((entry): ActionEvidenceEntry => ({
      ...entry,
      status: "incomplete",
      completedSequence: this.eventSequence + 1,
      exitCode: null,
      outcome: "incomplete",
    }));
    const all = [...this.entries, ...incomplete].sort((a, b) => a.sequence - b.sequence);
    const totalCompletedEntries = this.completedEntryCount;
    let ledger: ActionEvidenceLedger;
    try {
      ledger = buildBoundedLedger({
        entries: all,
        totalEntries: this.completedEntryCount + incomplete.length,
        totalCompletedEntries,
        cancellationJournals: this.cancellationJournalFile && this.cancellationJournalCount > 0
          ? [{
              schemaVersion: 1,
              path: this.cancellationJournalFile,
              count: this.cancellationJournalCount,
              finalDigest: this.cancellationJournalDigest,
            }]
          : [],
      });
    } catch (error) { this.closeJournalOnFailure(error); }
    if (this.cancellationJournalFd !== undefined) {
      closeSync(this.cancellationJournalFd);
      this.cancellationJournalFd = undefined;
    }
    this.finalizedLedger = ledger;
    return ledger;
  }
}

/** Preserve chronology when continuation/split results are merged. */
export function mergeActionEvidenceLedgers(
  first: ActionEvidenceLedger | undefined,
  second: ActionEvidenceLedger | undefined,
): ActionEvidenceLedger | undefined {
  if (!first) return second;
  if (!second) return first;
  const combined = [...first.entries, ...second.entries]
    .map((entry, index) => ({ ...entry, sequence: index + 1 }));
  return buildBoundedLedger({
    entries: combined,
    totalEntries: first.totalEntries + second.totalEntries,
    totalCompletedEntries: first.totalCompletedEntries + second.totalCompletedEntries,
    inheritedReasons: [...first.omissionReasons, ...second.omissionReasons],
    inheritedOmittedEntries: first.omittedEntries + second.omittedEntries,
    inheritedCancellations: [...(first.cancellations ?? []), ...(second.cancellations ?? [])],
    cancellationJournals: [...(first.cancellationJournals ?? []), ...(second.cancellationJournals ?? [])],
  });
}
