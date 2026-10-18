/** Host observations only. No command arguments, results, paths or raw IDs are
 * retained here; the separate redacted action ledger remains authoritative. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ActionEvidenceCollector, type ActionEvidenceLedger } from "./action-evidence";

export interface CommandTimingClocks {
  wallNow(): number;
  monotonicNow(): number;
}
export interface CommandTimingContext {
  runId?: string;
  launchId?: string;
  role?: string;
  phase?: number;
  stage?: string;
}
export interface CommandTime {
  id: string;
  runId: string;
  launchId: string;
  toolCallId: string;
  /** Safe label, not the raw shell command. Match IDs by hashing ledger IDs. */
  tool: string;
  role: "planner" | "verifier" | "executor";
  phase: number | "unknown";
  stage: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  outcome: "incomplete" | "unknown" | "succeeded" | "failed" | "cancelled_no_output";
}
export interface CommandTimes {
  schemaVersion: 1;
  entries: CommandTime[];
  /** Historical sources lacking timing are not interpreted as zero commands. */
  unavailable?: boolean;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const clocks: CommandTimingClocks = { wallNow: () => Date.now(), monotonicNow: () => performance.now() };
const tools = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const stages = new Set(["initial", "continuation", "shard", "replan", "synthesis"]);

export class CommandTimesCollector {
  private readonly entries = new Map<string, CommandTime>();
  // Never serialize monotonic samples: a reloaded host has another clock domain.
  private readonly starts = new Map<string, number>();
  private readonly observedStarts = new Set<string>();
  private readonly observedEnds = new Set<string>();
  private readonly outcomes = new Map<string, ActionEvidenceCollector>();
  private unavailable = false;
  private readonly binding: Pick<CommandTime, "runId" | "launchId" | "role" | "phase" | "stage">;
  constructor(context: CommandTimingContext, private readonly clock: CommandTimingClocks = clocks) {
    this.binding = {
      runId: hash(context.runId ?? "unassociated"), launchId: hash(context.launchId ?? "unassociated"),
      role: context.role === "planner" ? "planner" : context.role === "verifier" || context.role === "reviewer" ? "verifier" : "executor",
      phase: Number.isSafeInteger(context.phase) && Number(context.phase) >= 0 ? Number(context.phase) : "unknown",
      stage: stages.has(context.stage ?? "") ? context.stage! : "initial",
    };
  }
  /** Returns true only for newly observed starts/ends, allowing immediate
   * durable running-sidecar publication without adding a scheduler. */
  observe(value: unknown): boolean {
    try { return this.observeEvent(value); }
    catch (error) {
      this.markUnavailable();
      throw error; // Integration reports safe diagnostics; never hide lost timing.
    }
  }
  /** Keep previously observed timings, but never claim complete coverage after
   * a failed observation. Also used when an injected timing source throws. */
  markUnavailable(): void { this.unavailable = true; }

  private observeEvent(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const event = value as Record<string, unknown>;
    if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(event.type))) return false;
    if (typeof event.toolCallId !== "string" || !event.toolCallId) {
      const changed = !this.unavailable;
      this.unavailable = true;
      return changed; // Unidentifiable events are missing evidence, not zero.
    }
    const toolCallId = hash(event.toolCallId);
    const id = hash(`${this.binding.runId}:${this.binding.launchId}:${toolCallId}`);
    const previous = this.entries.get(id);
    if (event.type === "tool_execution_update") {
      // Use the existing cancellation receipt validator. Updates never imply
      // the enclosing command ended or establish its elapsed duration.
      if (this.observedEnds.has(id)) return false;
      const parser = this.outcomes.get(id) ?? new ActionEvidenceCollector();
      parser.observe(event);
      this.outcomes.set(id, parser);
      if (previous) return false;
      this.entries.set(id, { ...this.binding, id, toolCallId,
        tool: typeof event.toolName === "string" && tools.has(event.toolName) ? event.toolName : "tool", outcome: "incomplete" });
      return true; // An update without its start is still real, incomplete evidence.
    }
    if (event.type === "tool_execution_start") {
      if (this.observedStarts.has(id) || this.observedEnds.has(id)) return false;
    } else {
      if (this.observedEnds.has(id)) return false;
    }
    const wall = this.clock.wallNow(), monotonic = this.clock.monotonicNow();
    const time = Number.isFinite(wall) && Math.abs(wall) <= 8.64e15 ? new Date(wall).toISOString() : undefined;
    if (time === undefined || !Number.isFinite(monotonic)) this.unavailable = true;
    // Commit only a complete observation; parser/clock failure must not mutate
    // an already persisted start into a fabricated terminal command.
    const entry: CommandTime = previous ? { ...previous } : { ...this.binding, id, toolCallId,
      tool: typeof event.toolName === "string" && tools.has(event.toolName) ? event.toolName : "tool", outcome: "incomplete" };
    if (event.type === "tool_execution_start") {
      entry.startedAt = time;
      if (Number.isFinite(monotonic)) this.starts.set(id, monotonic);
    } else {
      entry.endedAt = time;
      const start = this.starts.get(id);
      if (start !== undefined && Number.isFinite(monotonic) && monotonic >= start) entry.durationMs = monotonic - start;
      // Reuse the authoritative outcome/redaction parser, without arguments
      // or a journal destination. Only the enum enters timing persistence.
      const parser = this.outcomes.get(id) ?? new ActionEvidenceCollector();
      parser.observe(event);
      entry.outcome = parser.finalize().entries[0]?.outcome ?? "unknown";
      this.outcomes.delete(id);
    }
    if (event.type === "tool_execution_start") this.observedStarts.add(id);
    else this.observedEnds.add(id);
    this.entries.set(id, entry);
    return true;
  }
  /** Snapshot only observed events. Worker death/refusal cannot complete a
   * command. The optional ledger is deliberately not used to infer an end. */
  snapshot(_evidence?: ActionEvidenceLedger): CommandTimes {
    return { schemaVersion: 1, entries: [...this.entries.values()].map(entry => ({ ...entry })), ...(this.unavailable ? { unavailable: true } : {}) };
  }
}

/** Decode only the safe timing fields when loading generic JSON payloads.
 * Malformed historical evidence is unavailable; it never becomes a label. */
function timingEntry(value: unknown): CommandTime | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as CommandTime;
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const timestamp = (value: unknown) => value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  if (![entry.id, entry.runId, entry.launchId, entry.toolCallId].every(digest)
    || !["planner", "verifier", "executor"].includes(entry.role)
    || (entry.phase !== "unknown" && (!Number.isSafeInteger(entry.phase) || entry.phase < 0))
    || !stages.has(entry.stage) || (!tools.has(entry.tool) && entry.tool !== "tool")
    || !["incomplete", "unknown", "succeeded", "failed", "cancelled_no_output"].includes(entry.outcome)
    || !timestamp(entry.startedAt) || !timestamp(entry.endedAt)
    || (entry.durationMs !== undefined && (!Number.isFinite(entry.durationMs) || entry.durationMs < 0))) return undefined;
  return { id: entry.id, runId: entry.runId, launchId: entry.launchId, toolCallId: entry.toolCallId,
    tool: entry.tool, role: entry.role, phase: entry.phase, stage: entry.stage, outcome: entry.outcome,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }) };
}

/** Compound IDs make replay/checkpoint/recovery merges idempotent. A terminal
 * observation enriches a prior start; no duration is inferred across hosts. */
export function mergeCommandTimes(...ledgers: Array<CommandTimes | undefined>): CommandTimes {
  const entries = new Map<string, CommandTime>();
  let unavailable = false;
  for (const ledger of ledgers) {
    if (!ledger || ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) { unavailable = true; continue; }
    unavailable ||= ledger.unavailable === true;
    for (const value of ledger.entries) {
      const entry = timingEntry(value);
      if (!entry) { unavailable = true; continue; }
      const previous = entries.get(entry.id);
      if (!previous) entries.set(entry.id, { ...entry });
      else {
        const preferred = previous.outcome === "incomplete" && entry.outcome !== "incomplete" ? entry : previous;
        // Preserve a separately persisted start, but do not infer a duration
        // by subtracting wall times or unrelated host monotonic samples.
        entries.set(entry.id, { ...preferred, ...(preferred.startedAt === undefined && (previous.startedAt ?? entry.startedAt) !== undefined ? { startedAt: previous.startedAt ?? entry.startedAt } : {}) });
      }
    }
  }
  return { schemaVersion: 1, entries: [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), ...(unavailable ? { unavailable: true } : {}) };
}
export function summarizeCommandTimes(ledger: CommandTimes | undefined) {
  const safe = ledger ? mergeCommandTimes(ledger) : undefined;
  const entries = safe?.entries ?? [];
  return {
    observed: entries.length, incomplete: entries.filter(e => e.outcome === "incomplete").length,
    missingStart: entries.filter(e => e.startedAt === undefined).length,
    durationUnavailable: entries.filter(e => e.outcome !== "incomplete" && e.durationMs === undefined).length,
    unavailable: !safe || safe.unavailable === true,
    slowest: entries.filter(e => e.durationMs !== undefined).sort((a, b) => b.durationMs! - a.durationMs! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 10),
  };
}
export function formatCommandTimes(ledger: CommandTimes | undefined): string {
  const summary = summarizeCommandTimes(ledger);
  return ["## Host command times", `Observed: ${summary.observed}; incomplete: ${summary.incomplete}; missing start: ${summary.missingStart}; duration unavailable: ${summary.durationUnavailable}${summary.unavailable ? "; some timing evidence unavailable (not zero commands)" : ""}.`,
    ...summary.slowest.map(e => `- ${e.tool} ${e.id}: ${e.durationMs}ms | ${e.startedAt ?? "start unobserved"} → ${e.endedAt ?? "end unobserved"} | ${e.role}/${e.phase}/${e.stage} | run=${e.runId} launch=${e.launchId} | ${e.outcome}`),
  ].join("\n");
}

/** Inspect only explicit host payload fields; never scan worker prose or
 * arguments looking for timings. Useful for generic checkpoints/results. */
export function readRunCommandTimes(directory: string | undefined): CommandTimes {
  if (!directory) return { schemaVersion: 1, entries: [], unavailable: true };
  const ledgers: Array<CommandTimes | undefined> = [];
  try {
    for (const file of readdirSync(directory).filter(file => /^phase-.*\.json$/.test(file) || /^checkpoint-\d+-[a-z-]+\.json$/.test(file)).sort()) {
      try {
        const publication = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
        // Phase checkpoints store a raw result; live sidecars wrap it.
        ledgers.push(publication.commandTimes ?? commandTimesFromHostResults(publication));
      } catch { ledgers.push(undefined); }
    }
  } catch { ledgers.push(undefined); }
  return ledgers.length ? mergeCommandTimes(...ledgers) : { schemaVersion: 1, entries: [], unavailable: true };
}

export function commandTimesFromHostResults(value: unknown): CommandTimes {
  const ledgers: CommandTimes[] = [];
  let unavailable = false;
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const host = item as Record<string, unknown>;
    if (host.commandTimes && typeof host.commandTimes === "object") ledgers.push(host.commandTimes as CommandTimes);
    else if (typeof host.agentName === "string" && ("events" in host || "eventCount" in host || "output" in host)) unavailable = true;
    for (const field of ["result", "payload", "output", "outputs", "executorOutputs", "plannerOutputs", "verifierOutputs", "verifierResults", "attempts", "steps", "roleRecovery", "checkpoints", "runtime", "adapterState", "phaseResults"]) visit(host[field]);
  };
  visit(value);
  return { ...mergeCommandTimes(...ledgers), ...(unavailable ? { unavailable: true } : {}) };
}
