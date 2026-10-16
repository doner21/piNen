/** Observed liveness, deliberately separate from durable execution/approval state.
 * Readers and existing heartbeat/lifecycle writers all publish the same file.
 * This module reads plain JSON and never calls a store, avoiding recursive reads.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJsonSync } from "./run-state";

export type ProcessIdentityObservation =
  | { status: "dead"; evidence: string }
  | { status: "alive"; startedAt?: number }
  | { status: "unknown"; reason: string };
export type ProcessIdentityObserver = (pid: number) => ProcessIdentityObservation;

// Shared with startup reconciliation. Only ESRCH proves absence; no signals
// are sent other than the pre-existing signal-zero existence probe.
export function observeProcessIdentity(pid: number): ProcessIdentityObservation {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return { status: "unknown", reason: "invalid_pid" };
  if (pid === process.pid) return { status: "alive", startedAt: Math.round(performance.timeOrigin) };
  try {
    process.kill(pid, 0);
    return { status: "alive" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ESRCH" ? { status: "dead", evidence: "ESRCH" } : { status: "unknown", reason: code || "process_probe_failed" };
  }
}

export interface SilenceAlarm {
  commandId: string;
  invocationId?: string;
  toolCallId?: string;
  wallTime?: string;
  elapsedMs?: number;
  noOutputMs?: number;
  eligibility?: unknown;
  /** Cumulative bash content at alarm publication, not a fresh-output flag. */
  outputFingerprint?: string;
}
export interface LiveWorker {
  pid: number;
  phase: string;
  liveness: "alive" | "unknown";
  heartbeatAt?: string;
  launchId?: string;
}
export interface LiveStatus {
  schemaVersion: 1;
  runId: string;
  observedAt: string;
  going: "going" | "not going" | "unknown";
  phase: string | null;
  manifestState: "available" | "not started yet" | "unavailable";
  /** Manifest observations, including settled phases; not active-worker claims. */
  phases: Array<{ index: number; name: string; status: string }>;
  activeWorkers: LiveWorker[];
  heartbeatAt: string | null;
  activeSilenceAlarms: Array<SilenceAlarm & { phase: string }>;
  lastError: unknown;
  observationErrors: string[];
}
export interface LiveStatusOptions {
  now?: Date;
  observeProcess?: ProcessIdentityObserver;
  runDir?: string;
  /** A store validation/read failure, retained without changing its rejection. */
  observationError?: string;
}
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0x7fffffff;
const time = (value: unknown): number | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
// Three existing five-second worker heartbeats. This is a read-time freshness
// classification, not a watchdog, deadline, scheduling interval or termination.
const FRESH_HEARTBEAT_MS = 15_000;

/** Keep command/invocation identity, not human-readable historical alarm text. */
export function reduceSilenceAlarms(alarms: SilenceAlarm[], event: unknown): SilenceAlarm[] {
  if (!record(event)) return alarms;
  const partial = record(event.partialResult) ? event.partialResult : undefined;
  const details = record(partial?.details) ? partial.details : undefined;
  const alarm = record(details?.noOutputAlarm) ? details.noOutputAlarm : undefined;
  const text = Array.isArray(partial?.content) ? partial.content
    .filter((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string")
    .map((part: { text: string }) => part.text).join("") : "";
  const fingerprint = createHash("sha256").update(text).digest("hex");
  if (alarm?.type === "command_no_output_alarm" && typeof alarm.commandId === "string") {
    const value: SilenceAlarm = {
      commandId: alarm.commandId,
      ...(Array.isArray(partial?.content) ? { outputFingerprint: fingerprint } : {}),
      ...(typeof alarm.invocationId === "string" ? { invocationId: alarm.invocationId } : {}),
      ...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
      ...(typeof alarm.wallTime === "string" ? { wallTime: alarm.wallTime } : {}),
      ...(typeof alarm.elapsedMs === "number" ? { elapsedMs: alarm.elapsedMs } : {}),
      ...(typeof alarm.noOutputMs === "number" ? { noOutputMs: alarm.noOutputMs } : {}),
      ...(alarm.eligibility !== undefined ? { eligibility: alarm.eligibility } : {}),
    };
    return [...alarms.filter(item => item.commandId !== value.commandId || item.invocationId !== value.invocationId), value];
  }
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
  if (!toolCallId) return alarms;
  const matchesTool = (item: SilenceAlarm): boolean => (item.toolCallId ?? item.commandId) === toolCallId;
  // The monitor publishes latestUpdate.content again alongside cancellation.
  // That publication settles only the named, confirmed invocation, never the
  // other helper invocations within this bash call.
  const cancellation = record(details?.noOutputCancellation) ? details.noOutputCancellation : undefined;
  if (event.type === "tool_execution_update" && cancellation) {
    if (cancellation.outcome !== "cancelled_no_output" || cancellation.cancellationConfirmed !== true
      || cancellation.confirmationBasis !== "terminal_signal_after_owned_handle_action"
      || cancellation.terminalExitCode !== null || cancellation.terminalSignal !== "SIGTERM"
      || typeof cancellation.invocationId !== "string") return alarms;
    return alarms.filter(item => !(matchesTool(item) && item.commandId === cancellation.commandId && item.invocationId === cancellation.invocationId));
  }
  // A Pi tool end settles the enclosing bash call, hence all its invocations.
  if (event.type === "tool_execution_end") return alarms.filter(item => !matchesTool(item));
  if (event.type !== "tool_execution_update" || !text.length) return alarms;
  return alarms.filter(item => !matchesTool(item) || item.outputFingerprint === undefined || item.outputFingerprint === fingerprint);
}

function alarmsFromLog(text: string): SilenceAlarm[] {
  let alarms: SilenceAlarm[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf("COMMAND_NO_OUTPUT_ALARM ");
    try {
      if (marker >= 0) {
        const alarm = JSON.parse(line.slice(marker + "COMMAND_NO_OUTPUT_ALARM ".length));
        if (record(alarm)) alarms = reduceSilenceAlarms(alarms, { type: "tool_execution_update", toolCallId: alarm.toolCallId,
          partialResult: { details: { noOutputAlarm: { ...alarm, type: "command_no_output_alarm" } } } });
      } else if (line.startsWith("[stdout] ")) {
        alarms = reduceSilenceAlarms(alarms, JSON.parse(line.slice("[stdout] ".length)));
      }
    } catch { /* Partial/capped JSONL is not command completion. */ }
  }
  return alarms;
}

/** Refresh from disk (or the caller's just-validated state), never from the
 * previous live-status projection. Unknown evidence cannot prove absence.
 */
export function refreshLiveStatus(runDir: string, options: LiveStatusOptions = {}, supervisionState?: unknown): LiveStatus {
  const now = options.now ?? new Date();
  const observe = options.observeProcess ?? observeProcessIdentity;
  const errors: string[] = options.observationError ? [options.observationError] : [];
  let uncertain = Boolean(options.observationError);
  const read = (name: string, optional = false): Record<string, any> | undefined => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runDir, name), "utf8"));
      if (!record(parsed)) throw new Error("not a JSON object");
      return parsed;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      uncertain = true;
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const state = record(supervisionState) ? supervisionState : read("supervision.json", true);
  const manifest = read("state.json", true);
  const runId = path.basename(runDir);
  if ((state && state.runId !== runId) || (manifest && manifest.runId !== runId)) {
    uncertain = true;
    errors.push("durable run identity mismatch");
  }
  const preExecutor = !manifest && Boolean(state && ["plan_checkpoint", "awaiting_supervisor", "paused"].includes(state.status)
    && Array.isArray(state.checkpoints) && !state.checkpoints.some((item: any) => ["executor", "verifier"].includes(item?.kind)));
  const manifestState = manifest && Array.isArray(manifest.phases) ? "available" : preExecutor ? "not started yet" : "unavailable";
  if (manifestState === "unavailable") {
    uncertain = true;
    errors.push("state.json: phase manifest unavailable");
  }
  const fresh = (stamp: unknown): boolean => {
    const at = time(stamp);
    return at !== undefined && now.getTime() >= at && now.getTime() - at <= FRESH_HEARTBEAT_MS;
  };
  const observations = new Map<number, ProcessIdentityObservation>();
  const probe = (pid: number): ProcessIdentityObservation => {
    const previous = observations.get(pid);
    if (previous) return previous;
    let observation: ProcessIdentityObservation;
    try { observation = observe(pid); }
    catch (error) { observation = { status: "unknown", reason: error instanceof Error ? error.message : String(error) }; }
    observations.set(pid, observation);
    if (observation.status === "unknown") errors.push(`PID ${pid}: ${observation.reason}`);
    return observation;
  };
  let hostAlive = false;
  const hostId = state?.runtime?.hostInstanceId;
  if (typeof hostId === "string" && /^[1-9]\d{0,9}:[1-9]\d{0,15}$/.test(hostId)) {
    const [pid, startedAt] = hostId.split(":").map(Number);
    if (validPid(pid) && Number.isSafeInteger(startedAt)) {
      const observed = probe(pid);
      if (observed.status === "alive" && observed.startedAt !== undefined && Math.abs(observed.startedAt - startedAt) <= 2_000 && fresh(state?.updatedAt)) {
        // A live Pi host can own many stopped runs. Only fresh in-flight host
        // activity counts; cancellation never conceals an observed survivor.
        hostAlive = ["executing", "verifying"].includes(state?.status);
      } else if (observed.status !== "dead" || observed.evidence !== "ESRCH") uncertain = true;
    } else uncertain = true;
  } else uncertain = true;

  let names: string[] = [];
  try { names = fs.readdirSync(runDir).sort(); }
  catch (error) { uncertain = true; errors.push(`run directory: ${String(error)}`); }
  const candidates: Array<{ pid?: unknown; phase: string; heartbeatAt?: string; startedAt?: string; launchId?: string }> = [];
  const alarms: LiveStatus["activeSilenceAlarms"] = [];
  const observedPhaseIndices = new Set<number>();
  const observedLogs = new Set<string>();
  const audit = record(state?.audit) ? state.audit : undefined;
  if (state && (!audit || !Array.isArray(audit.activeWorkers) || !Array.isArray(audit.detachedWorkers))) {
    uncertain = true;
    errors.push("supervision.json: worker observations unavailable");
  }
  const failures = Array.isArray(audit?.infrastructureFailures) ? audit.infrastructureFailures : [];
  let lastError: unknown = failures.at(-1) ?? state?.pauseReason ?? null;
  let errorAt = lastError === null ? -Infinity : time(state?.updatedAt) ?? -Infinity;
  const retainError = (error: unknown, stamp: unknown): void => {
    const at = time(stamp) ?? -Infinity;
    if (error !== undefined && (lastError === null || at >= errorAt)) { lastError = error; errorAt = at; }
  };
  for (const worker of [...(Array.isArray(audit?.activeWorkers) ? audit.activeWorkers : []), ...(Array.isArray(audit?.detachedWorkers) ? audit.detachedWorkers : [])]) {
    if (record(worker)) candidates.push({ pid: worker.pid, phase: String(worker.phase ?? "unknown") });
    else uncertain = true;
  }
  for (const name of names.filter(name => /^phase-.*\.result\.json$/i.test(name))) {
    const result = read(name);
    if (!result) continue;
    const index = Number(/^phase-(\d+)-/.exec(name)?.[1]);
    observedPhaseIndices.add(index);
    const phaseEntry = Array.isArray(manifest?.phases) ? manifest.phases.find((entry: unknown) => record(entry) && entry.index === index) : undefined;
    const phase = typeof phaseEntry?.name === "string" ? phaseEntry.name : name.replace(/^phase-\d+-/, "").replace(/\.result\.json$/, "");
    if (result.kind !== "subagent-phase-result" || !["running", "incomplete", "complete"].includes(result.status)) { uncertain = true; continue; }
    if (validPid(result.pid) || result.status === "running") candidates.push({ pid: result.pid, phase, heartbeatAt: result.heartbeatAt, startedAt: result.startedAt, launchId: result.launchId });
    else if (result.status === "complete" || time(result.completedAt) === undefined) {
      uncertain = true;
      errors.push(`${name}: terminal worker identity/settlement unavailable`);
    }
    if (result.incompleteReason) retainError(result.incompleteReason, result.completedAt ?? result.heartbeatAt);
    // New recorder publications survive log capping. Old publications are
    // reconstructed from the actual JSONL stream, not from launch flags.
    let active: SilenceAlarm[] = [];
    const logName = name.replace(/\.result\.json$/, ".log");
    observedLogs.add(logName);
    if (Array.isArray(result.activeSilenceAlarms)) active = result.activeSilenceAlarms.filter((alarm: unknown) => record(alarm) && typeof alarm.commandId === "string");
    else if (result.status === "running") {
      try { active = alarmsFromLog(fs.readFileSync(path.join(runDir, logName), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { uncertain = true; errors.push(`${name}: alarm log unavailable`); } }
    }
    if (result.status === "running") alarms.push(...active.map(alarm => ({ ...alarm, phase })));
  }
  // Log publication can succeed even when a result sidecar cannot be read.
  // Preserve positive alarm evidence in that case, while declaring uncertainty.
  for (const name of names.filter(name => /^phase-.*\.log$/i.test(name) && !observedLogs.has(name))) {
    uncertain = true;
    try {
      const phase = name.replace(/^phase-\d+-/, "").replace(/\.log$/, "");
      alarms.push(...alarmsFromLog(fs.readFileSync(path.join(runDir, name), "utf8")).map(alarm => ({ ...alarm, phase })));
    } catch (error) { errors.push(`${name}: ${String(error)}`); }
  }
  for (const name of names.filter(name => /^survivor-.*\.json$/i.test(name) && !name.endsWith(".result.json"))) {
    const survivor = read(name);
    if (survivor) candidates.push({ pid: survivor.pid, phase: String(survivor.phaseName ?? "detached") });
  }
  for (const phase of Array.isArray(manifest?.phases) ? manifest.phases : []) {
    if (!record(phase) || !Number.isSafeInteger(phase.index) || phase.index < 0 || typeof phase.name !== "string" || !["pending", "running", "done", "detached", "ambiguous-completion"].includes(phase.status)) {
      uncertain = true;
      errors.push("state.json: unknown phase observation");
      if (record(phase) && validPid(phase.pid)) candidates.push({ pid: phase.pid, phase: "unknown" });
      continue;
    }
    if (["running", "detached"].includes(phase.status)) {
      // Sidecars carry the actual PID; missing phase metadata never cancels a
      // positive sidecar observation, nor proves an unobserved worker absent.
      if (!observedPhaseIndices.has(phase.index) && !candidates.some(candidate => candidate.phase === phase.name)) candidates.push({ pid: phase.pid, phase: String(phase.name ?? "unknown") });
    }
  }
  for (const name of names.filter(name => /^terminal-no-retry-.*\.json$/i.test(name) && !name.endsWith(".candidate.json"))) {
    const terminal = read(name);
    if (typeof terminal?.errorMessage === "string") retainError(terminal.errorMessage, terminal.recordedAt);
  }
  const activeWorkers: LiveWorker[] = [];
  for (const candidate of candidates) {
    if (!validPid(candidate.pid)) { uncertain = true; continue; }
    const observed = probe(candidate.pid);
    if (observed.status === "dead" && observed.evidence === "ESRCH") continue;
    const stamp = time(candidate.heartbeatAt);
    // A process born after the published heartbeat is a reused PID, not the
    // observed worker. Launch time is NOT process birth time.
    const launchAt = time(candidate.startedAt);
    const reused = observed.status === "alive" && observed.startedAt !== undefined && (
      (stamp !== undefined && observed.startedAt > stamp + 2_000) ||
      (launchAt !== undefined && observed.startedAt < launchAt - 2_000)
    );
    const liveness = observed.status === "alive" && !reused && fresh(candidate.heartbeatAt) ? "alive" : "unknown";
    if (liveness === "unknown") uncertain = true;
    const previous = activeWorkers.find(worker => worker.pid === candidate.pid);
    if (!previous || (previous.liveness === "unknown" && liveness === "alive")) {
      if (previous) activeWorkers.splice(activeWorkers.indexOf(previous), 1);
      activeWorkers.push({ pid: candidate.pid, phase: candidate.phase, liveness,
        ...(candidate.heartbeatAt ? { heartbeatAt: candidate.heartbeatAt } : {}), ...(candidate.launchId ? { launchId: candidate.launchId } : {}) });
    }
  }
  activeWorkers.sort((a, b) => a.pid - b.pid);
  const going = activeWorkers.some(worker => worker.liveness === "alive") || hostAlive ? "going" : uncertain ? "unknown" : "not going";
  const heartbeatAt = activeWorkers.map(worker => worker.heartbeatAt).filter((stamp): stamp is string => time(stamp) !== undefined).sort().at(-1)
    ?? (hostAlive ? state?.updatedAt : null);
  const projection: LiveStatus = {
    schemaVersion: 1, runId, observedAt: now.toISOString(), going, manifestState,
    phases: (Array.isArray(manifest?.phases) ? manifest.phases : [])
      .filter((entry: unknown) => record(entry) && Number.isSafeInteger(entry.index) && entry.index >= 0 && typeof entry.name === 'string' && ['pending', 'running', 'done', 'detached', 'ambiguous-completion'].includes(entry.status))
      .map((entry: { index: number; name: string; status: string }) => ({index: entry.index, name: entry.name, status: entry.status})),
    phase: activeWorkers.length ? [...new Set(activeWorkers.map(worker => worker.phase))].join(", ") : hostAlive ? String(state?.runtime?.cursor?.stage ?? state?.status ?? "host") : null,
    activeWorkers, heartbeatAt, activeSilenceAlarms: alarms, lastError: options.observationError ?? lastError ?? errors.at(-1) ?? null, observationErrors: errors,
  };
  atomicWriteJsonSync(path.join(runDir, "live-status.json"), projection);
  return projection;
}
