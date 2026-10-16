/**
 * Layer A — Substrate
 * ==================
 * Role-agnostic safety and plumbing only. This module contains no
 * shape-specific orchestration concepts. It provides the bounded
 * infrastructure that every orchestration shape builds on.
 *
 * GUARANTEE: The substrate enforces hard non-negotiable caps. No shape,
 * no matter what it requests, can run forever or spawn unbounded subagents.
 * Bounded / cannot-run-forever is a **substrate guarantee**.
 *
 * SHAPE-OWNED: The *meaning* of termination (e.g. "make 3 passes",
 * "majority vote requires at least 3 passes") is **shape-owned**. The
 * substrate only enforces that whatever iterations/spawns the shape
 * requests are clamped to safe, finite limits.
 */

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import { spawn, type SpawnOptions } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { refreshLiveStatus, reduceSilenceAlarms, type SilenceAlarm, type LiveStatusOptions } from "./live-status";
import { CommandTimesCollector, mergeCommandTimes, readRunCommandTimes, type CommandTimes, type CommandTimingClocks, type CommandTimingContext } from "./command-times";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FrozenTestAuthorizationPolicy, FrozenTestAuthorizationEntrypoint, WorkerExecutionConstraints } from "./types";
import {
  emptyToolCallSummary,
  recordToolCall,
  parseProviderError,
  formatProviderError,
  type ToolCallSummary,
  type ProviderHealthError,
} from "./judgment";
import { getPiChildFirstJsonTimeoutMs, isPiJsonProtocolEvent, killOwnedProcessTree, resolvePiChildCommand } from "./child-launch.ts";
import { atomicWriteJsonSync, phaseLogPathFor, phaseResultPathFor } from "./run-state";
import { assertWorkerPromptFitsCapacity } from "./executor-recovery/budget-estimator";
import { isRoleContextExhaustion, isRoleRecoveryHandoff, RoleContextExhaustionError, type RoleRecoveryEvidence } from "./role-recovery";
import { NO_FORCE_KILL_GUARD_READY_MARKER } from "./worker-execution-constraints";
import { NO_OUTPUT_MONITOR_READY_MARKER } from "./worker-no-output-monitor";
import { ActionEvidenceCollector as UnobservedActionEvidenceCollector, type ActionEvidenceCollectorOptions, type ActionEvidenceLedger } from "./action-evidence";
import { beginHostPublication, observeHostPublication } from "./host-publications";

/** Keep attribution at the host adapter, without changing journal authority.
 * Both legacy and substrate launchers use this collector; isolated admission
 * probes can still inject the original collector boundary unchanged. */
export class ActionEvidenceCollector extends UnobservedActionEvidenceCollector {
  private readonly publicationFile: string | undefined;

  constructor(options: ActionEvidenceCollectorOptions = {}) {
    const finishPublication = beginHostPublication([options.cancellationJournalFile]);
    try { super(options); } finally { finishPublication(); }
    this.publicationFile = options.cancellationJournalFile;
  }

  override observe(event: unknown): void {
    observeHostPublication([this.publicationFile], () => super.observe(event));
  }
}

// ── Re-exported agent profile (role-agnostic shape) ────────────────────────

export interface AgentProfile {
  name: string;
  description?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  /** Internal provenance retained when Pi settings supplied this route field. */
  providerIsPiDefault?: boolean;
  /** Internal provenance retained so saved model IDs use exact getModel semantics. */
  modelIsPiDefault?: boolean;
  tools?: string[];
  skills?: string[];
  agencyLevel?: string | number;
}

// ── Hard non-negotiable caps ───────────────────────────────────────────────

/**
 * Substrate-level hard limits. No shape can request more than these.
 * These are enforced at the substrate boundary before any work starts.
 *
 * - MAX_TOTAL_SPAWNS: absolute ceiling on subagent process spawns across
 *   the entire orchestration. Once hit, no further spawns are permitted.
 * - ABSOLUTE_MAX_ITERATIONS: absolute ceiling on the number of bounded
 *   iteration loops any shape may perform. The substrate clamps
 *   every shape-requested iteration value to this cap.
 */
export const SUBSTRATE_CAPS = {
  /** Absolute maximum subagent spawns (pipe ceiling). */
  MAX_TOTAL_SPAWNS: 200,
  /** Absolute maximum iterations any shape may request. Clamped here. */
  ABSOLUTE_MAX_ITERATIONS: 50,
} as const;

// ── Monotonic spawn-ceiling guard ──────────────────────────────────────────

/**
 * Monotonic spawn-ceiling guard.
 *
 * Guarantees:
 * - The total number of subagent spawns never exceeds `cap`.
 * - Spawns are counted monotonically (only increase).
 * - Checking and incrementing is atomic from the caller's perspective.
 *
 * The `cap` itself is clamped to SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS on
 * construction, so even a shape that passes an absurdly high value is
 * bounded by the substrate.
 */
export class SpawnGuard {
  private _spawned = 0;
  readonly cap: number;

  constructor(requestedCap: number) {
    this.cap = clampSpawnCeiling(requestedCap);
  }

  /** Total spawns recorded so far. */
  get spawned(): number {
    return this._spawned;
  }

  /** Remaining spawn slots before the ceiling is hit. */
  get remaining(): number {
    return Math.max(0, this.cap - this._spawned);
  }

  /**
   * Reserve one spawn slot. Returns the new count on success.
   * Throws if the ceiling has already been reached — the substrate
   * guarantee is that no spawn can exceed the cap.
   */
  reserve(): number {
    if (this._spawned >= this.cap) {
      throw new Error(
        `Substrate spawn ceiling exceeded: already spawned ${this._spawned}/${this.cap}. ` +
          `This is a substrate-level hard cap (MAX_TOTAL_SPAWNS=${SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS}). ` +
          `The orchestration cannot continue.`,
      );
    }
    return ++this._spawned;
  }

  /**
   * Raise the spawn ceiling. The new cap is clamped through the substrate
   * hard limit. The cap can only increase, never decrease (monotonic).
   * This supports runtime budget adjustments (e.g. auto-raise in the shape).
   */
  raiseCeiling(requestedCap: number): number {
    const clamped = clampSpawnCeiling(requestedCap);
    if (clamped > this.cap) {
      (this as { cap: number }).cap = clamped;
    }
    return this.cap;
  }

  /**
   * Check whether a given number of additional spawns would fit.
   * Does NOT reserve — use `reserve()` for that.
   */
  wouldFit(count: number): boolean {
    return this._spawned + count <= this.cap;
  }
}

// ── Clamping helpers ───────────────────────────────────────────────────────

/**
 * Clamp a shape-requested spawn ceiling through the substrate hard cap.
 * Every shape MUST pass its ceiling value through this function to
 * ensure the bounded/cannot-run-forever guarantee.
 */
export function clampSpawnCeiling(requested: number): number {
  return Math.max(1, Math.min(Math.trunc(requested), SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS));
}

/**
 * Clamp a shape-requested iteration / attempt count through the
 * substrate hard cap. Shapes own the *meaning* of iterations
 * (e.g. retries, votes, rounds), but the substrate ensures they
 * cannot request an unbounded number.
 */
export function clampIterations(requested: number): number {
  return Math.max(1, Math.min(Math.trunc(requested), SUBSTRATE_CAPS.ABSOLUTE_MAX_ITERATIONS));
}

// ── Subagent result ────────────────────────────────────────────────────────

export interface SubagentResult {
  agentName: string;
  provider?: string;
  model?: string;
  task: string;
  text: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  events: number;
  /** Substantive role recovery; partial workers never become terminal results. */
  roleRecovery?: RoleRecoveryEvidence;
  /** Set by recovery/quality layer when subagent output appears truncated. */
  truncated?: boolean;
  /** Set by recovery layer when the subagent signalled context exhaustion. */
  contextExhaustionSignal?: boolean;
  /**
   * Effect-evidence telemetry: tool executions observed in the child's
   * JSONL stream. `mutating` counts write/edit/bash-class tools.
   */
  toolCalls?: ToolCallSummary;
  /** Host-owned, chronological, secret-safe completed tool action evidence. */
  actionEvidence?: ActionEvidenceLedger;
  commandTimes?: CommandTimes;
  /** Transient assistant/transport failures cleared by the child's successful auto-retry lifecycle. */
  recoveredAssistantFailures?: string[];
  /** Provider-refusal recovery telemetry, present when one safe reworded retry occurred. */
  providerRefusal?: ProviderRefusalInfo;
}

// ── spawnSubagent ──────────────────────────────────────────────────────────

/**
 * Complete capability set for inspection-only workers. Keep this list limited
 * to Pi's non-mutating built-ins: `--tools` is an allowlist across built-in,
 * extension, and custom tools, while `--no-extensions` prevents extension
 * discovery entirely.
 */
export const READ_ONLY_EVIDENCE_TOOLS = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
] as const);

/**
 * Visible-main verifier capability fence. Bash is available for machine
 * evidence collection, while edit/write and every extension/custom tool stay
 * absent. Workspace snapshots enforce the verifier's read-only effect policy.
 */
export const VERIFIER_EVIDENCE_TOOLS = Object.freeze([
  ...READ_ONLY_EVIDENCE_TOOLS,
  "bash",
] as const);

export interface SpawnSubagentOptions {
  commandTimingClocks?: CommandTimingClocks;
  commandTimingContext?: CommandTimingContext;
  /** Host observations retained before a defensive provider retry starts. */
  commandTimingPrior?: CommandTimes;
  /** Agent profiles map for resolving agent configuration. */
  agents: Map<string, AgentProfile>;
  /** Working directory for the spawned process. */
  cwd: string;
  /** Whether to permit local-model providers (ollama, lmstudio, etc.). */
  allowLocalModel: boolean;
  /** AbortSignal to cancel the subprocess. */
  signal?: AbortSignal;
  /** Optional inherited model/provider from the parent call context. */
  inheritedModel?: { provider?: string; model?: string };
  /** Optional progress callback. */
  onProgress?: (text: string) => void;
  /** Optional per-spawn model/provider override with internal default provenance. */
  modelOverride?: {
    model?: string;
    provider?: string;
    modelIsPiDefault?: boolean;
    providerIsPiDefault?: boolean;
  };
  /** Host-owned raw stdout/stderr streaming log. */
  phaseLogFile?: string;
  /** Host-owned incremental heartbeat and terminal-result publication. */
  phaseResultFile?: string;
  /**
   * Abort-survivor mode (ABORT-RESUME-DESIGN.md): when the AbortSignal fires,
   * do NOT kill the child. Instead persist a survivor manifest, reject the
   * awaiting promise with SubagentDetachedError, keep collecting the child's
   * JSONL output in the background, and write the full SubagentResult to
   * `resultFile` when the child eventually closes. Opt-in per spawn; spawns
   * without this option keep exact kill-on-abort semantics.
   */
  abortSurvival?: {
    resultFile: string;
    manifestFile: string;
    phaseName?: string;
    phaseIndex?: number;
    /** Optional reason predicate; false keeps normal kill-on-abort behavior. */
    shouldDetach?: (reason: unknown) => boolean;
    /** Keep collecting this owned child until it settles instead of detaching on host pause. */
    settleOnAbort?: boolean;
  };
  /**
   * True for phases that may mutate files. A terminal assistant/transport error
   * after such a child was launched is ambiguous: the child may already have
   * changed disk. It must surface as a no-retry result-lost/candidate state,
   * never as permission to auto-respawn the phase.
   */
  phaseMutates?: boolean;
  /**
   * Restrict the child to READ_ONLY_EVIDENCE_TOOLS regardless of its profile.
   * This is an exact allowlist: bash, write, edit, orchestration, and all
   * mutation-capable extension/custom tools remain unavailable.
   */
  readOnly?: boolean;
  /**
   * Use the verifier evidence fence (read/grep/find/ls/bash). This does not
   * grant edit/write/extensions; callers must enforce no effects by snapshot.
   */
  verifier?: boolean;
  /** Internal recursion fence: provider refusals may be reworded at most once. */
  providerRefusalRetryAttempt?: 0 | 1;
  /** Typed context exhaustion for planner/verifier recovery, after settlement. */
  recoverableRole?: "planner" | "verifier";
  /** Health probes must surface provider policy/refusal failures immediately. */
  disableProviderRefusalRetry?: boolean;
  /** Opt-in worker policy frozen by the orchestration mission. */
  workerExecutionConstraints?: WorkerExecutionConstraints;
}

/** Absolute explicit-extension path used only by guarded worker launches. */
export const WORKER_EXECUTION_CONSTRAINTS_EXTENSION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "worker-execution-constraints.ts",
);

/**
 * Host-owned bash monitor loaded for every worker. It preserves Pi's bash
 * schema while supervising only authenticated, directly launched test children.
 */
export const WORKER_NO_OUTPUT_MONITOR_EXTENSION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "worker-no-output-monitor.ts",
);
export const WORKER_MONITOR_BOOTSTRAP_EXTENSION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "worker-monitor-bootstrap.ts",
);

/**
 * Thrown instead of "Subagent <name> aborted." when abort-survivor mode is
 * active: the child is still running and its result will be persisted to
 * `resultFile`. Callers should persist the detachment and surface a resume
 * hint rather than treating this as a plain failure.
 */
export class SubagentDetachedError extends Error {
  readonly manifest: {
    pid: number | undefined;
    agentName: string;
    phaseName: string;
    phaseIndex: number;
    startedAt: number;
    detachedAt: string;
    resultFile: string;
  };

  constructor(agentName: string, manifest: SubagentDetachedError["manifest"]) {
    super(
      `Subagent ${agentName} detached (abort-survivor mode): child pid=${manifest.pid} continues in the background; ` +
        `its result will be written to ${manifest.resultFile}.`,
    );
    this.name = "SubagentDetachedError";
    this.manifest = manifest;
  }
}

export interface SubagentTerminalAmbiguousInfo {
  code: "AMBIGUOUS_COMPLETION" | "RESULT_LOST_AFTER_MUTATION";
  retryAllowed: false;
  resultLost: boolean;
  agentName: string;
  errorMessage: string;
  exitCode: number | null;
  stderr: string;
  assistantFailures: string[];
  candidate?: SubagentResult;
}

export interface ProviderRefusalInfo {
  code: "provider_refused";
  providerMessage: string;
  retryAllowed: boolean;
  retryEligible: boolean;
  retryAttempted: boolean;
  mutationAmbiguous: boolean;
}

export class ProviderRefusalError extends Error {
  readonly info: ProviderRefusalInfo & { agentName: string };

  constructor(agentName: string, info: Omit<ProviderRefusalInfo, "code">) {
    const payload = { code: "provider_refused" as const, agentName, ...info };
    super(`Subagent ${agentName} provider refusal (code=provider_refused, retryAllowed=${payload.retryAllowed}): ${payload.providerMessage}`);
    this.name = "ProviderRefusalError";
    this.info = payload;
  }
}

/** Detect a terminal provider policy refusal without conflating context/rate/transport failures. */
export function classifyProviderRefusal(value: unknown): Pick<ProviderRefusalInfo, "code" | "providerMessage"> | undefined {
  const structured = providerRefusalMessageCandidates(value, true);
  const fallback = typeof value === "string" ? [value] : providerRefusalMessageCandidates(value, false);
  const message = [...structured, ...fallback].find(isProviderRefusalMessage);
  return message ? { code: "provider_refused", providerMessage: message.trim() } : undefined;
}

/** Capability proof used before any automatic rewording retry. */
export function isProvablyReadOnlySubagent(readOnly: boolean | undefined, tools: readonly string[] | undefined): boolean {
  if (readOnly === true) return true;
  if (!Array.isArray(tools)) return false;
  const allowed = new Set<string>(READ_ONLY_EVIDENCE_TOOLS);
  return tools.every((tool) => {
    const normalized = String(tool).trim();
    return !normalized || normalized === "orchestrate" || allowed.has(normalized);
  });
}

/** Keep frozen criteria while removing provider-triggering implementation language from a one-shot evidence review. */
export function buildProviderRefusalRetryPrompt(task: string): string {
  return [
    "EVIDENCE_ONLY_PROVIDER_REFUSAL_RETRY",
    "Perform a defensive, read-only evidence review. Do not edit files, run shell commands, write code, or provide operational misuse instructions.",
    "Preserve every frozen criterion and return only the originally requested verdict/evidence schema.",
    "BINDING ORIGINAL PROMPT (verbatim; do not reinterpret or rewrite):",
    task,
  ].join("\n\n");
}

function providerRefusalMessageCandidates(value: unknown, structuredOnly: boolean): string[] {
  if (!value || typeof value !== "object") return structuredOnly ? [] : [String(value ?? "")];
  const raw = value as Record<string, unknown>;
  const nestedMessage = raw.message && typeof raw.message === "object" ? raw.message as Record<string, unknown> : undefined;
  const nestedError = raw.error && typeof raw.error === "object" ? raw.error as Record<string, unknown> : undefined;
  const candidates = [
    raw.errorMessage,
    nestedMessage?.errorMessage,
    nestedError?.message,
    nestedMessage?.error && typeof nestedMessage.error === "object" ? (nestedMessage.error as Record<string, unknown>).message : undefined,
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (!structuredOnly && typeof raw.message === "string") candidates.push(raw.message);
  return candidates;
}

function isProviderRefusalMessage(message: string): boolean {
  return /content was flagged for possible (?:cybersecurity|security) risk/i.test(message)
    || /provider (?:policy )?refus(?:al|ed)[\s\S]{0,240}try rephrasing/i.test(message);
}

export class SubagentTerminalAmbiguousError extends Error {
  readonly info: SubagentTerminalAmbiguousInfo;

  constructor(agentName: string, info: Omit<SubagentTerminalAmbiguousInfo, "agentName" | "retryAllowed">) {
    const payload: SubagentTerminalAmbiguousInfo = {
      ...info,
      agentName,
      retryAllowed: false,
    };
    super(
      `Subagent ${agentName} ended in a terminal ambiguous mutating state ` +
        `(code=${payload.code}, retryAllowed=false): ${payload.errorMessage}`,
    );
    this.name = "SubagentTerminalAmbiguousError";
    this.info = payload;
  }
}

interface SubagentPhaseLogContext {
  runId: string;
  nextIndex: number;
}

/** Read all host phase publications, including abandoned/incomplete starts. */
export function getCommandTimesForRun(runId = subagentPhaseLogContext.getStore()?.runId): CommandTimes {
  return readRunCommandTimes(runId ? path.dirname(phaseResultPathFor(runId, 0, "timing")) : undefined);
}

interface AllocatedPhaseEvidence {
  logFile?: string;
  resultFile?: string;
}

const subagentPhaseLogContext = new AsyncLocalStorage<SubagentPhaseLogContext>();
const workerExecutionConstraintContext = new AsyncLocalStorage<WorkerExecutionConstraints>();

/** Bind opt-in constraints to every substrate spawn made by a shape callback. */
export function withWorkerExecutionConstraints<T>(
  constraints: WorkerExecutionConstraints,
  operation: () => Promise<T>,
): Promise<T> {
  const snapshot: WorkerExecutionConstraints = {
    noForceKill: constraints.noForceKill === true,
    ...(constraints.testAuthorization
      ? { testAuthorization: JSON.parse(JSON.stringify(constraints.testAuthorization)) as FrozenTestAuthorizationPolicy }
      : {}),
  };
  if (snapshot.testAuthorization) deepFreezeValue(snapshot.testAuthorization);
  return workerExecutionConstraintContext.run(Object.freeze(snapshot), operation);
}

/** Bind all substrate spawns in an orchestration dispatch to durable per-phase logs. */
export function withSubagentPhaseLogging<T>(runId: string | undefined, operation: () => Promise<T>): Promise<T> {
  if (!runId) return operation();
  return subagentPhaseLogContext.run({ runId, nextIndex: 0 }, operation);
}

function allocatePhaseEvidence(agentName: string, explicitLog?: string, explicitResult?: string): AllocatedPhaseEvidence {
  if (explicitLog || explicitResult) {
    return {
      ...(explicitLog ? { logFile: explicitLog } : {}),
      ...(explicitResult
        ? { resultFile: explicitResult }
        : explicitLog?.endsWith(".log")
          ? { resultFile: `${explicitLog.slice(0, -4)}.result.json` }
          : {}),
    };
  }
  const context = subagentPhaseLogContext.getStore();
  if (!context) return {};
  const index = context.nextIndex++;
  return {
    logFile: phaseLogPathFor(context.runId, index, agentName),
    resultFile: phaseResultPathFor(context.runId, index, agentName),
  };
}

/** Resolve the optional byte cap for streamed phase logs. Invalid/absent values preserve unbounded behavior. */
export function configuredPhaseLogMaxBytes(environment: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = environment.PI_ORCHESTRATOR_PHASE_LOG_MAX_BYTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function utf8Tail(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  let start = buffer.length - maxBytes;
  // Move past UTF-8 continuation bytes so the retained log remains valid text.
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

function replacePhaseLogWithTail(file: string, appended: Buffer, maxBytes: number): void {
  const existing = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  // Compact below the ceiling to avoid rewriting a large capped file for every
  // subsequent stream event while always preserving the newest event bytes.
  const compactTarget = Math.max(1, Math.floor(maxBytes * 0.75));
  const retainedBytes = appended.byteLength >= maxBytes ? maxBytes : compactTarget;
  const retained = utf8Tail(Buffer.concat([existing, appended]), retainedBytes);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, retained, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch {}
  }
}

export function appendSubagentPhaseLog(file: string | undefined, stream: "stdout" | "stderr" | "host", text: string): void {
  observeHostPublication([file], () => appendSubagentPhaseLogUnobserved(file, stream, text));
}

function appendSubagentPhaseLogUnobserved(file: string | undefined, stream: "stdout" | "stderr" | "host", text: string): void {
  if (!file || !text) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const normalized = text.replace(/\r?\n/g, "\n");
    const terminated = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    const tagged = terminated.split("\n").slice(0, -1).map((line) => `[${stream}] ${line}\n`).join("");
    const maxBytes = configuredPhaseLogMaxBytes();
    if (maxBytes === undefined) {
      appendFileSync(file, tagged, { encoding: "utf8", mode: 0o600 });
      return;
    }
    const appended = Buffer.from(tagged, "utf8");
    const existingBytes = existsSync(file) ? statSync(file).size : 0;
    if (existingBytes + appended.byteLength <= maxBytes) {
      appendFileSync(file, appended, { mode: 0o600 });
      return;
    }
    replacePhaseLogWithTail(file, appended, maxBytes);
  } catch {
    // Streaming evidence is best-effort and must never change child settlement.
  }
}

/** Host receipt written only after the alarm event reached the launcher progress seam. */
export function acknowledgeNoOutputAlarm(event: unknown, acknowledgementRoot: string): void {
  if (process.env.PI_ORCHESTRATOR_TEST_SUPPRESS_ALARM_ACK === "1") return;
  if (!event || typeof event !== "object") return;
  const raw = event as Record<string, unknown>;
  if (raw.type !== "tool_execution_update") return;
  const partial = raw.partialResult && typeof raw.partialResult === "object" ? raw.partialResult as Record<string, unknown> : undefined;
  const details = partial?.details && typeof partial.details === "object" ? partial.details as Record<string, unknown> : undefined;
  const alarm = details?.noOutputAlarm && typeof details.noOutputAlarm === "object" ? details.noOutputAlarm as Record<string, unknown> : undefined;
  const requestId = typeof alarm?.ackRequestId === "string" ? alarm.ackRequestId : "";
  if (!/^[a-f0-9]{32}$/.test(requestId)) return;
  try {
    mkdirSync(acknowledgementRoot, { recursive: true });
    writeFileSync(path.join(acknowledgementRoot, `${requestId}.ack`), `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return;
  }
}

export interface SubagentPhaseResultPublication {
  schemaVersion: 1;
  kind: "subagent-phase-result";
  status: "running" | "incomplete" | "complete";
  launchId: string;
  agentName: string;
  taskSha256: string;
  startedAt: string;
  heartbeatAt: string;
  heartbeatSequence: number;
  eventCount: number;
  pid?: number;
  completedAt?: string;
  incompleteReason?: string;
  transportFailuresAfterResult?: string[];
  activeSilenceAlarms?: SilenceAlarm[];
  commandTimes?: CommandTimes;
  /** Observed authority retained when the worker cannot be accepted. */
  actionEvidence?: ActionEvidenceLedger;
  result?: SubagentResult;
}

/**
 * Atomically publishes phase liveness and the last fully settled assistant
 * result. The launch binding prevents stale sidecars from an older attempt
 * being promoted. Publication failures are evidence loss only; they never
 * alter the existing conservative subprocess settlement.
 */
export class SubagentPhaseResultRecorder {
  readonly file: string | undefined;
  readonly launchId: string;
  private readonly agentName: string;
  private readonly task: string;
  private readonly taskSha256: string;
  private readonly startedAt: string;
  private heartbeatSequence = 0;
  private terminal = false;
  private latestEventCount = 0;
  private latestPid: number | undefined;
  private lastWriteAt = 0;
  private activeSilenceAlarms: SilenceAlarm[] = [];
  private commandTimes: CommandTimes | undefined;

  /** Persist starts immediately, including commands that never settle. */
  publishCommandTimes(ledger: CommandTimes): void {
    if (this.terminal) return;
    this.commandTimes = mergeCommandTimes(this.commandTimes ?? { schemaVersion: 1, entries: [] }, ledger);
    this.write({ status: "running" });
  }

  constructor(file: string | undefined, agentName: string, task: string, startedAt: number, private readonly liveStatusOptions: LiveStatusOptions = {}, commandTimingPrior?: CommandTimes) {
    this.file = file;
    this.agentName = agentName;
    this.task = task;
    this.taskSha256 = createHash("sha256").update(task).digest("hex");
    this.startedAt = new Date(startedAt).toISOString();
    this.launchId = `${process.pid}-${startedAt}-${randomBytes(8).toString("hex")}`;
    if (commandTimingPrior) this.commandTimes = mergeCommandTimes(commandTimingPrior);
    this.heartbeat(0);
  }

  heartbeat(eventCount: number, pid?: number): void {
    if (this.terminal) return;
    this.latestEventCount = Math.max(this.latestEventCount, Number.isSafeInteger(eventCount) && eventCount >= 0 ? eventCount : 0);
    const pidChanged = pid !== undefined && pid !== this.latestPid;
    if (pid !== undefined) this.latestPid = pid;
    this.heartbeatSequence += 1;
    if (pidChanged || Date.now() - this.lastWriteAt >= 1_000) this.write({ status: "running" });
  }

  /** Observe matching command output/completion; unrelated heartbeats cannot clear alarms. */
  observeEvent(event: unknown): void {
    if (this.terminal || !event || typeof event !== "object" || !["tool_execution_update", "tool_execution_end"].includes(String((event as Record<string, unknown>).type))) return;
    const next = reduceSilenceAlarms(this.activeSilenceAlarms, event);
    if (JSON.stringify(next) === JSON.stringify(this.activeSilenceAlarms)) return;
    this.activeSilenceAlarms = next;
    this.write({ status: "running" });
  }

  complete(result: SubagentResult, transportFailuresAfterResult: string[] = []): void {
    if (this.terminal || !isValidBoundPhaseResult(result, this.agentName, this.task)) return;
    this.latestEventCount = Math.max(this.latestEventCount, result.events);
    this.heartbeatSequence += 1;
    this.terminal = true;
    this.activeSilenceAlarms = [];
    if (result.commandTimes) this.commandTimes = mergeCommandTimes(result.commandTimes, this.commandTimes ?? { schemaVersion: 1, entries: [] });
    this.write({
      status: "complete",
      completedAt: new Date().toISOString(),
      ...(transportFailuresAfterResult.length > 0 ? { transportFailuresAfterResult: [...transportFailuresAfterResult] } : {}),
      result,
    });
  }

  incomplete(reason: string, actionEvidence?: ActionEvidenceLedger): void {
    if (this.terminal) return;
    this.heartbeatSequence += 1;
    this.terminal = true;
    this.activeSilenceAlarms = [];
    this.write({ status: "incomplete", completedAt: new Date().toISOString(), incompleteReason: reason, ...(actionEvidence ? { actionEvidence } : {}) });
  }

  retry(): void {
    this.terminal = false;
    this.heartbeat(this.latestEventCount, this.latestPid);
  }

  readComplete(): SubagentResult | undefined {
    if (!this.file || !existsSync(this.file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SubagentPhaseResultPublication>;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.kind !== "subagent-phase-result" ||
        parsed.status !== "complete" ||
        parsed.launchId !== this.launchId ||
        parsed.agentName !== this.agentName ||
        parsed.taskSha256 !== this.taskSha256 ||
        !isValidBoundPhaseResult(parsed.result, this.agentName, this.task)
      ) return undefined;
      return parsed.result;
    } catch {
      return undefined;
    }
  }

  private write(extra: Pick<SubagentPhaseResultPublication, "status"> & Partial<SubagentPhaseResultPublication>): void {
    if (!this.file) return;
    const heartbeatAt = new Date().toISOString();
    const publication: SubagentPhaseResultPublication = {
      schemaVersion: 1,
      kind: "subagent-phase-result",
      status: extra.status,
      launchId: this.launchId,
      agentName: this.agentName,
      taskSha256: this.taskSha256,
      startedAt: this.startedAt,
      heartbeatAt,
      heartbeatSequence: this.heartbeatSequence,
      eventCount: this.latestEventCount,
      activeSilenceAlarms: this.activeSilenceAlarms,
      ...(this.commandTimes ? { commandTimes: this.commandTimes } : {}),
      ...(this.latestPid === undefined ? {} : { pid: this.latestPid }),
      ...(extra.completedAt ? { completedAt: extra.completedAt } : {}),
      ...(extra.incompleteReason ? { incompleteReason: extra.incompleteReason } : {}),
      ...(extra.transportFailuresAfterResult ? { transportFailuresAfterResult: extra.transportFailuresAfterResult } : {}),
      ...(extra.actionEvidence ? { actionEvidence: extra.actionEvidence } : {}),
      ...(extra.result ? { result: extra.result } : {}),
    };
    try {
      atomicWriteJsonSync(this.file, publication);
      this.lastWriteAt = Date.now();
      refreshLiveStatus(path.dirname(this.file), this.liveStatusOptions);
    } catch {}
  }
}

function isValidBoundPhaseResult(value: unknown, agentName: string, task: string): value is SubagentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<SubagentResult>;
  return (
    result.agentName === agentName &&
    result.task === task &&
    typeof result.text === "string" &&
    typeof result.stderr === "string" &&
    result.exitCode === 0 &&
    typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0 &&
    Number.isSafeInteger(result.events) && Number(result.events) >= 0
  );
}

const TEST_AUTHORIZATION_NODE_OPTIONS = Object.freeze([
  "--conditions", "--enable-source-maps", "--env-file", "--import", "--loader", "--no-warnings",
  "--require", "-r", "--test", "--test-concurrency", "--test-name-pattern", "--test-only",
  "--test-reporter", "--test-reporter-destination", "--test-shard",
]);

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packageCommandWords(value: string): string[] {
  return value.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s;&|]+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
}
function supportedLiteralTestWrapper(workspace: string, entrypoint: string): boolean {
  try {
    const file = path.resolve(workspace, entrypoint);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return false;
    const source = readFileSync(file, "utf8");
    return /process\.argv\.slice\(2\)/.test(source) && /spawn\(process\.execPath\s*,/.test(source);
  } catch { return false; }
}
function packageScriptNodeCandidates(scripts: Record<string, unknown>, workspace: string): string[] {
  const candidates: string[] = [];
  const valueOptions = new Set(["--require", "-r", "--import", "--loader", "--conditions", "--env-file"]);
  for (const [name, value] of Object.entries(scripts)) {
    if (!/^test(?::|$)/i.test(name) || typeof value !== "string") continue;
    const words = packageCommandWords(value);
    for (let index = 0; index < words.length; index += 1) {
      if (!/^(?:node|node\.exe)$/i.test(path.basename(words[index]))) continue;
      let cursor = index + 1;
      while (cursor < words.length && words[cursor].startsWith("-")) {
        const option = words[cursor++].split("=", 1)[0];
        if (valueOptions.has(option) && !words[cursor - 1].includes("=")) cursor += 1;
      }
      const entrypoint = words[cursor];
      if (!entrypoint || /[$*?{}[\]]/.test(entrypoint)) continue;
      candidates.push(entrypoint);
      if (supportedLiteralTestWrapper(workspace, entrypoint)) {
        for (const operand of words.slice(cursor + 1)) {
          if (/\.(?:cjs|mjs|js)$/i.test(operand) && !/[$*?{}[\]]/.test(operand)) candidates.push(operand);
        }
      }
    }
  }
  return candidates;
}

/** Capture immutable run-scoped test authority before planner/preflight dispatch. */
function deepFreezeValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeValue(child);
  }
  return value;
}

export function freezeRunTestAuthorizationPolicy(input: {
  cwd: string;
  ownerTask: string;
  approvedTestScopes?: string[];
  historicalWithoutAuthority?: boolean;
}): FrozenTestAuthorizationPolicy {
  const workspaceRealPath = realpathSync(input.cwd);
  const ownerTaskSha256 = createHash("sha256").update(input.ownerTask).digest("hex");
  const explicitTestProhibition = /\b(?:do\s+not|don't|never|without)\b[^.\n]{0,120}\b(?:tests?|regression\s+suite|verification\s+suite)\b/i.test(input.ownerTask)
    || /\b(?:tests?|regression\s+suite)\b[^.\n]{0,120}\bdo\s+not\s+execute\s+(?:them|it)\b/i.test(input.ownerTask)
    || /\bread\s+documentation\s+only\b/i.test(input.ownerTask)
    || /\b(?:explain|describe|document|show)\b[^.\n]{0,100}\b(?:run|execute)\s+(?:the\s+)?tests?\b/i.test(input.ownerTask)
    || /\b(?:documentation|example|quotation|quoted)\b[^.\n]{0,100}[‘'\"]?run\s+tests?[’'\"]?/i.test(input.ownerTask);
  const hasOwnerTestIntent = !input.historicalWithoutAuthority
    && !explicitTestProhibition
    && /\b(?:run|execute|add|create|write|modify|fix|repair|implement|build|verify|rerun)\b[^.\n]{0,120}\b(?:test|tests|testing|verification|validator|regression|suite)\b/i.test(input.ownerTask);
  const packageFile = path.join(workspaceRealPath, "package.json");
  let packageJsonSha256: string | null = null;
  let candidatePaths: string[] = [];
  if (hasOwnerTestIntent && existsSync(packageFile)) {
    const bytes = readFileSync(packageFile);
    if (bytes.byteLength <= 1024 * 1024) {
      packageJsonSha256 = createHash("sha256").update(bytes).digest("hex");
      const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      candidatePaths = packageScriptNodeCandidates(
        parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
          ? parsed.scripts as Record<string, unknown>
          : {},
        workspaceRealPath,
      );
    }
  }
  const existingEntrypoints: FrozenTestAuthorizationEntrypoint[] = [];
  const seen = new Set<string>();
  for (const candidate of candidatePaths.slice(0, 512)) {
    let canonical: string;
    try { canonical = realpathSync(path.resolve(workspaceRealPath, candidate)); } catch { continue; }
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || !isWithinPath(workspaceRealPath, canonical) || seen.has(canonical)) continue;
    seen.add(canonical);
    existingEntrypoints.push({
      path: canonical,
      sha256: createHash("sha256").update(readFileSync(canonical)).digest("hex"),
      bytes: stat.size,
      source: "package-test-script",
    });
  }
  const approvedDynamicScopes: string[] = [];
  if (hasOwnerTestIntent) {
    const candidateParents = [...new Set(existingEntrypoints.map((entry) => path.dirname(entry.path)))];
    for (const scope of input.approvedTestScopes ?? []) {
      const absolute = path.resolve(workspaceRealPath, scope);
      if (!isWithinPath(workspaceRealPath, absolute)) continue;
      const normalized = path.normalize(absolute);
      try { if (lstatSync(normalized).isDirectory()) continue; } catch { /* a not-yet-created exact test file is allowed */ }
      if (!candidateParents.some((parent) => isWithinPath(parent, normalized))) continue;
      if (!approvedDynamicScopes.includes(normalized)) approvedDynamicScopes.push(normalized);
    }
  }
  const body = {
    schemaVersion: 1 as const,
    authority: "run-admission-owner-task" as const,
    workspaceRealPath,
    packageJsonSha256,
    ownerTaskSha256,
    existingEntrypoints: existingEntrypoints.sort((a, b) => a.path.localeCompare(b.path)),
    approvedDynamicScopes: approvedDynamicScopes.sort(),
    allowedNodeOptions: [...TEST_AUTHORIZATION_NODE_OPTIONS],
  };
  const policyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return deepFreezeValue({ ...body, policyHash });
}

/** Write an already-frozen policy for a worker; never reread mutable package state. */
export function materializeFrozenTestAuthorizationPolicy(
  policy: FrozenTestAuthorizationPolicy | undefined,
  directory: string,
  cwd: string,
): { file: string; sha256: string } {
  const workspaceRealPath = realpathSync(cwd);
  const emptyBody = {
    schemaVersion: 1 as const,
    authority: "run-admission-owner-task" as const,
    workspaceRealPath,
    packageJsonSha256: null,
    ownerTaskSha256: createHash("sha256").update("no test authority").digest("hex"),
    existingEntrypoints: [], approvedDynamicScopes: [], allowedNodeOptions: [...TEST_AUTHORIZATION_NODE_OPTIONS],
  };
  const body = policy ?? { ...emptyBody, policyHash: createHash("sha256").update(JSON.stringify(emptyBody)).digest("hex") };
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "worker-test-authorization.json");
  writeFileSync(file, serialized, { encoding: "utf8", mode: 0o600 });
  return { file, sha256: createHash("sha256").update(serialized).digest("hex") };
}

/** Resolve the exact launcher model and Pi-assembled system prompt before spawn. */
export async function resolveCompleteWorkerLaunchPrompt(input: {
  cwd: string;
  profile: AgentProfile;
  appendedSystemPrompt: string;
  workerExecutionConstraints?: WorkerExecutionConstraints;
}): Promise<{
  systemPrompt: string;
  toolSchemas: unknown;
  contextWindow: number;
  maxOutputTokens: number;
  provider: string;
  model: string;
  /** Canonical child --model argument, retaining any CLI thinking suffix. */
  modelArgument: string;
  thinkingLevel?: string;
  api: string;
  compat: unknown;
}> {
  // Use Pi's own effective launcher configuration root. PI_AGENT_DIR was an
  // orchestrator-only alias and could make admission size a different model and
  // different instructions than the child launched with PI_CODING_AGENT_DIR.
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(input.cwd, agentDir);
  const explicitProvider = input.profile.provider?.trim() || undefined;
  const explicitModel = input.profile.model?.trim() || undefined;
  const settingsDefaultProvider = settingsManager.getDefaultProvider();
  const settingsDefaultModel = settingsManager.getDefaultModel();

  // ModelRuntime.create() restores persisted catalogues by default. Network
  // refresh remains explicitly disabled, matching a normal offline CLI launch
  // without suppressing cache restoration (refreshOnCreate:false did both).
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });

  let model;
  let thinkingLevel: string | undefined;
  if (!explicitModel || input.profile.modelIsPiDefault === true) {
    // Pi restores saved defaults with exact getModel(provider, id) semantics.
    // Preserve that behavior even when upstream named-role resolution copied
    // the default value into the profile for routing/preflight visibility.
    const provider = explicitProvider ?? settingsDefaultProvider;
    const modelId = explicitModel ?? settingsDefaultModel;
    if (!provider || !modelId) {
      throw new Error("BINDING_PROMPT_CAPACITY_UNRESOLVED: the launcher model route is incomplete.");
    }
    model = modelRuntime.getModel(provider, modelId);
    if (!model) {
      throw new Error(
        `BINDING_PROMPT_CAPACITY_UNRESOLVED: saved launcher model ${provider}/${modelId} was not found exactly.`,
      );
    }
  } else {
    const resolved = resolveCliModel({
      cliProvider: explicitProvider,
      cliModel: explicitModel,
      modelRuntime,
    });
    let requestedModelId = explicitModel;
    if (resolved.thinkingLevel && requestedModelId.toLowerCase().endsWith(`:${resolved.thinkingLevel}`)) {
      requestedModelId = requestedModelId.slice(0, -(resolved.thinkingLevel.length + 1));
    }
    // An ID may literally begin with its provider (for example fixture/model).
    // Preserve an exact resolved ID before interpreting provider/model syntax.
    const requestedIsExactResolvedId = resolved.model !== undefined
      && resolved.model.id.toLowerCase() === requestedModelId.toLowerCase();
    if (
      !requestedIsExactResolvedId
      && explicitProvider
      && requestedModelId.toLowerCase().startsWith(`${explicitProvider.toLowerCase()}/`)
    ) {
      requestedModelId = requestedModelId.slice(explicitProvider.length + 1);
    }
    const resolvedMatchesRequestedRoute = resolved.model !== undefined && (explicitProvider
      ? resolved.model.provider.toLowerCase() === explicitProvider.toLowerCase()
        && (
          resolved.model.id.toLowerCase() === requestedModelId.toLowerCase()
          || `${resolved.model.provider}/${resolved.model.id}`.toLowerCase() === requestedModelId.toLowerCase()
        )
      : resolved.model.id.toLowerCase() === requestedModelId.toLowerCase()
        || `${resolved.model.provider}/${resolved.model.id}`.toLowerCase() === requestedModelId.toLowerCase());
    if (
      resolved.error
      || !resolved.model
      || !resolvedMatchesRequestedRoute
      || resolved.warning?.includes("Using custom model id")
    ) {
      const requested = explicitProvider ? `${explicitProvider}/${explicitModel}` : explicitModel;
      const detail = resolved.error
        ? `: ${resolved.error}`
        : resolved.warning
          ? `: ${resolved.warning}`
          : !resolvedMatchesRequestedRoute
            ? ": CLI matching selected a different model route."
            : ".";
      throw new Error(
        `BINDING_PROMPT_CAPACITY_UNRESOLVED: launcher model ${requested} could not be resolved through Pi CLI model resolution${detail}`,
      );
    }
    model = resolved.model;
    thinkingLevel = resolved.thinkingLevel;
  }

  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error(
      `BINDING_PROMPT_CAPACITY_UNRESOLVED: launcher model ${model.provider}/${model.id} has no valid configured contextWindow.`,
    );
  }
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 0) {
    throw new Error(
      `BINDING_PROMPT_CAPACITY_UNRESOLVED: launcher model ${model.provider}/${model.id} has no valid configured maxTokens.`,
    );
  }

  // Construct the shortest argument that the real CLI resolver proves maps
  // back to this exact model and limits. Most routes retain their bare ID.
  // Provider/model collisions may require repeated qualification (for example
  // fixture/fixture/fixture/model); the catalogue size is a finite bound on
  // the number of distinct colliding references.
  let modelReference = model.id;
  let modelArgument: string | undefined;
  const maxQualificationDepth = modelRuntime.getModels(model.provider).length + 1;
  for (let depth = 0; depth <= maxQualificationDepth; depth += 1) {
    const candidate = `${modelReference}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
    const childRoute = resolveCliModel({
      cliProvider: model.provider,
      cliModel: candidate,
      modelRuntime,
    });
    if (
      !childRoute.error
      && childRoute.model?.provider === model.provider
      && childRoute.model.id === model.id
      && childRoute.model.contextWindow === model.contextWindow
      && childRoute.model.maxTokens === model.maxTokens
      && childRoute.thinkingLevel === thinkingLevel
    ) {
      modelArgument = candidate;
      break;
    }
    modelReference = `${model.provider}/${modelReference}`;
  }
  if (!modelArgument) {
    throw new Error(
      `BINDING_PROMPT_CAPACITY_UNRESOLVED: no canonical child --model argument round-trips ` +
      `to admitted model ${model.provider}/${model.id} and its configured limits.`,
    );
  }

  const tools = input.profile.tools
    ?.map(String)
    .map((tool) => tool.trim())
    .filter(Boolean)
    .filter((tool) => tool !== "orchestrate");
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    // The timeout guard contributes no schema or prompt text. The no-output
    // monitor overrides bash, so admission must load it and measure the exact
    // tool metadata the child will expose.
    additionalExtensionPaths: [WORKER_MONITOR_BOOTSTRAP_EXTENSION, WORKER_NO_OUTPUT_MONITOR_EXTENSION],
    additionalSkillPaths: input.profile.skills,
    appendSystemPrompt: [input.appendedSystemPrompt],
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(input.cwd);
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader,
    sessionManager,
    settingsManager,
    ...(tools ? (tools.length > 0 ? { tools } : { noTools: "all" as const }) : {}),
  });
  try {
    return {
      systemPrompt: session.systemPrompt,
      toolSchemas: session.agent.state.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      provider: model.provider,
      model: model.id,
      modelArgument,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      api: model.api,
      compat: model.compat,
    };
  } finally {
    session.dispose();
  }
}

/**
 * Spawn a single isolated Pi subagent process.
 *
 * This is role-agnostic plumbing: it resolves the agent profile,
 * builds a system prompt, launches Pi in JSON mode, pipes the task,
 * collects stdout events, and returns the final assistant text.
 *
 * It does NOT know about any shape-specific semantics.
 */
export async function spawnSubagent(
  agentName: string,
  task: string,
  options: SpawnSubagentOptions,
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const phaseEvidence = allocatePhaseEvidence(agentName, options.phaseLogFile, options.phaseResultFile);
  const phaseLogFile = phaseEvidence.logFile;
  appendSubagentPhaseLog(phaseLogFile, "host", `started=${new Date(startedAt).toISOString()} agent=${agentName}`);
  const loadedProfile = options.agents.get(agentName) ?? { name: agentName };
  const profile: AgentProfile = {
    ...loadedProfile,
    provider: options.modelOverride?.provider ?? loadedProfile.provider ?? options.inheritedModel?.provider,
    model: options.modelOverride?.model ?? loadedProfile.model ?? options.inheritedModel?.model,
    providerIsPiDefault: options.modelOverride?.provider !== undefined
      ? options.modelOverride.providerIsPiDefault === true
      : loadedProfile.provider !== undefined && loadedProfile.providerIsPiDefault === true,
    modelIsPiDefault: options.modelOverride?.model !== undefined
      ? options.modelOverride.modelIsPiDefault === true
      : loadedProfile.model !== undefined && loadedProfile.modelIsPiDefault === true,
    ...(options.verifier
      ? { tools: [...VERIFIER_EVIDENCE_TOOLS] }
      : options.readOnly ? { tools: [...READ_ONLY_EVIDENCE_TOOLS] } : {}),
  };
  rejectLocalModelIfNeeded(profile, options.allowLocalModel);
  const phaseResult = new SubagentPhaseResultRecorder(phaseEvidence.resultFile, profile.name, task, startedAt, undefined, options.commandTimingPrior);
  let tempDir: string | undefined;
  let childCreated = false;
  let launchFailed = false;
  // Publication precedes admission. Cover every preparation failure without
  // taking terminal settlement away from a child that may still be alive.
  try {
    options.onProgress?.(
      `Subagent ${profile.name}: using ${formatRoutedModel(profile.provider, profile.model)}.`,
    );

    const systemPrompt = buildSubagentSystemPrompt(profile);
    const workerExecutionConstraints = options.workerExecutionConstraints ?? workerExecutionConstraintContext.getStore();
    const launchPrompt = await resolveCompleteWorkerLaunchPrompt({
      cwd: options.cwd,
      profile,
      appendedSystemPrompt: systemPrompt,
      workerExecutionConstraints,
    });
    // Use the same canonical CLI-resolved route for admission, child arguments,
    // and result evidence.
    profile.provider = launchPrompt.provider;
    profile.model = launchPrompt.model;
    assertWorkerPromptFitsCapacity({
      prompt: task,
      completeSystemPrompt: launchPrompt.systemPrompt,
      toolSchemas: launchPrompt.toolSchemas,
      contextWindow: launchPrompt.contextWindow,
      maxOutputTokens: launchPrompt.maxOutputTokens,
      modelId: `${launchPrompt.provider}/${launchPrompt.model}`,
    });
    tempDir = await mkTempDir();
    const testPolicy = materializeFrozenTestAuthorizationPolicy(workerExecutionConstraints?.testAuthorization, tempDir, options.cwd);
    const promptFile = path.join(tempDir, `${safeFileName(agentName)}-system-prompt.txt`);
    await writeFile(promptFile, systemPrompt, "utf8");

    const command = resolvePiCommand();
    const args = [
      ...command.argsPrefix,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--extension",
      WORKER_MONITOR_BOOTSTRAP_EXTENSION,
      "--extension",
      WORKER_NO_OUTPUT_MONITOR_EXTENSION,
      ...(workerExecutionConstraints?.noForceKill
        ? ["--extension", WORKER_EXECUTION_CONSTRAINTS_EXTENSION]
        : []),
      "--append-system-prompt",
      promptFile,
    ];

    if (profile.provider) args.push("--provider", profile.provider);
    args.push("--model", launchPrompt.modelArgument);
    if (profile.tools) {
      const tools = profile.tools
        .map(String)
        .map((tool) => tool.trim())
        .filter(Boolean)
        .filter((tool) => tool !== "orchestrate");
      if (tools.length > 0) args.push("--tools", tools.join(","));
      else args.push("--no-tools");
    }
    for (const skill of profile.skills ?? []) {
      const trimmed = String(skill).trim();
      if (trimmed) args.push("--skill", trimmed);
    }

    // Pipe the task via stdin to avoid ENAMETOOLONG on Windows.
    const safeArgLen = process.platform === "win32" ? 6000 : 128_000;
    // No-force-kill prompts use stdin so Pi can initialize its explicit guard
    // before model/tool dispatch while avoiding command-line prompt exposure.
    let pipeStdin = workerExecutionConstraints?.noForceKill === true;
    if (task.length <= safeArgLen && !pipeStdin) {
      args.push(task);
    } else {
      pipeStdin = true;
      options.onProgress?.(
        workerExecutionConstraints?.noForceKill
          ? `Subagent ${profile.name}: piping the prompt so Pi loads the explicit no-force-kill guard before model/tool dispatch.`
          : `Subagent ${profile.name}: prompt size ${task.length} chars exceeds safe arg limit ${safeArgLen}; piping via stdin.`,
      );
    }

    options.onProgress?.(
      `Subagent ${profile.name}: launching ${path.basename(command.command)} ${args.includes("--no-extensions") ? "--no-extensions" : ""} --mode json in ${options.cwd}`,
    );

    const workerRunId = subagentPhaseLogContext.getStore()?.runId ?? `direct-${phaseResult.launchId}`;
    const noOutputPhaseRoot = path.dirname(phaseResult.file ?? phaseLogFile ?? path.join(os.tmpdir(), phaseResult.launchId, "phase.log"));
    const noOutputAlarmAckRoot = path.join(noOutputPhaseRoot, "no-output-alarm-acks");
    const baseSpawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: {
        ...(command.env ?? process.env),
        PI_ORCHESTRATOR_RUN_ID: workerRunId,
        PI_ORCHESTRATOR_WORKER_ID: phaseResult.launchId,
        PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE: testPolicy.file,
        PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256: testPolicy.sha256,
        PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT: path.join(noOutputPhaseRoot, "no-output-evidence"),
        PI_ORCHESTRATOR_ALARM_ACK_ROOT: noOutputAlarmAckRoot,
      },
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: command.shell,
    };
    const launchAttempts = buildWindowsEpermSpawnAttempts(command.command, args, baseSpawnOptions);

    for (let attemptIndex = 0; attemptIndex < launchAttempts.length; attemptIndex++) {
      const launch = launchAttempts[attemptIndex];
      appendSubagentPhaseLog(phaseLogFile, "host", `launch-attempt=${attemptIndex + 1} command=${path.basename(launch.command)}`);
      let stderr = "";
      let lastAssistantText = "";
      let settledAssistantText: string | undefined;
      let roleContextExhausted = false;
      let eventCount = 0;
      let killedByAbort = false;
      let agentEnded = false;
      let protocolTimedOut = false;
      let workerGuardAttested = workerExecutionConstraints?.noForceKill !== true;
      let workerMonitorAttested = false;
      let guardAttestationBuffer = "";
      let taskDispatched = false;
      let firstJsonProtocolEventSeen = false;
      let firstJsonTimer: NodeJS.Timeout | undefined;
      const firstJsonTimeoutMs = getPiChildFirstJsonTimeoutMs(command.env ?? process.env);
      const markFirstJsonProtocolEvent = () => {
        if (firstJsonProtocolEventSeen) return;
        firstJsonProtocolEventSeen = true;
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
      };
      const assistantFailures: string[] = [];
      let terminalProviderRefusal: ReturnType<typeof classifyProviderRefusal>;
      // Retryable failures are parked here when Pi reports that the child will
      // retry (or that its auto-retry succeeded). They remain useful telemetry,
      // but must not poison a subsequently successful child result.
      const recoveredAssistantFailures: string[] = [];
      const toolCalls = emptyToolCallSummary();
      const actionEvidence = new ActionEvidenceCollector({
        cancellationJournalFile: path.join(noOutputPhaseRoot, `${phaseResult.launchId}.cancellations.jsonl`),
      });
      const commandTimes = new CommandTimesCollector({
        runId: subagentPhaseLogContext.getStore()?.runId ?? (phaseEvidence.resultFile ? path.dirname(phaseEvidence.resultFile) : undefined),
        role: options.recoverableRole ?? (options.verifier ? "verifier" : profile.name),
        phase: Number(/phase-(\d+)/.exec(path.basename(phaseEvidence.resultFile ?? ""))?.[1]),
        ...options.commandTimingContext, launchId: `${phaseResult.launchId}:${attemptIndex}`,
      }, options.commandTimingClocks);
      let collectorFailure: Error | undefined;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(launch.command, launch.args, launch.options);
        childCreated = true;
        phaseResult.heartbeat(eventCount, child.pid);
        firstJsonTimer = setTimeout(() => {
          protocolTimedOut = true;
          const guarded = workerExecutionConstraints?.noForceKill === true;
          const timeoutMessage = guarded
            ? `PI_CHILD_FIRST_JSON_TIMEOUT: no valid JSON protocol event within ${firstJsonTimeoutMs}ms from ${path.basename(launch.command)}; child left untouched by no-force-kill policy.`
            : `PI_CHILD_FIRST_JSON_TIMEOUT: no valid JSON protocol event within ${firstJsonTimeoutMs}ms from ${path.basename(launch.command)}; terminating owned child tree.`;
          stderr += `\n${timeoutMessage}`;
          appendSubagentPhaseLog(phaseLogFile, "host", timeoutMessage);
          if (!guarded) {
            try { child.kill("SIGTERM"); } catch {}
            killOwnedProcessTree(child.pid, "first-json-timeout");
          }
        }, firstJsonTimeoutMs);
        firstJsonTimer.unref?.();
      } catch (err) {
        if (isWindowsSpawnEperm(err) && attemptIndex < launchAttempts.length - 1) {
          const next = launchAttempts[attemptIndex + 1];
          options.onProgress?.(
            `Subagent ${profile.name}: Windows spawn EPERM from ${formatSpawnAttempt(launch)}; ` +
              `retrying with ${formatSpawnAttempt(next)}.`,
          );
          continue;
        }
        // Terminal EPERM: capture evidence before throwing.
        const evidence = buildWindowsEpermEvidence(err, launch, options.cwd);
        const evidencePath = await writeWindowsEpermEvidence(evidence);
        const evidenceSuffix = evidencePath ? ` Evidence: ${evidencePath}` : " Evidence capture skipped.";
        throw new Error(formatSpawnFailure(err, launch, options.cwd) + evidenceSuffix);
      }

      const buildResult = (code: number | null, text = lastAssistantText): SubagentResult => {
        const result: SubagentResult = {
          agentName: profile.name,
          task,
          text: text.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          durationMs: Date.now() - startedAt,
          events: eventCount,
          toolCalls,
          actionEvidence: actionEvidence.finalize(),
          commandTimes: mergeCommandTimes(options.commandTimingPrior ?? { schemaVersion: 1, entries: [] }, commandTimes.snapshot(actionEvidence.finalize())),
        };
        if (profile.provider) result.provider = profile.provider;
        if (profile.model) result.model = profile.model;
        if (recoveredAssistantFailures.length > 0) result.recoveredAssistantFailures = [...recoveredAssistantFailures];
        return result;
      };
      const heartbeatTimer = setInterval(() => phaseResult.heartbeat(eventCount, child.pid), 5_000);
      heartbeatTimer.unref?.();
      child.once("close", (code) => {
        clearInterval(heartbeatTimer);
        if (code === 0 && settledAssistantText !== undefined && !roleContextExhausted && !protocolTimedOut && !killedByAbort && !collectorFailure) {
          try { phaseResult.complete(buildResult(code, settledAssistantText), assistantFailures); }
          catch (error) {
            collectorFailure = error instanceof Error ? error : new Error(String(error));
            phaseResult.incomplete(`ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
          }
        } else {
          const reason = collectorFailure ? `ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`
            : roleContextExhausted ? "role worker exhausted context; partial output is not terminal" : code === 0
              ? "child closed without a complete assistant result"
              : `child exited with code ${String(code)}`;
          try { phaseResult.incomplete(reason, actionEvidence.finalize()); }
          catch (error) {
            // Preserve the original rejection if final evidence is also lost.
            collectorFailure ??= error instanceof Error ? error : new Error(String(error));
            phaseResult.incomplete(`ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
          }
        }
      });

      const dispatchTask = (): void => {
        if (!pipeStdin || !child.stdin || taskDispatched) return;
        taskDispatched = true;
        child.stdin.on("error", () => {});
        child.stdin.end(task);
      };

      // Abort-survivor plumbing (ABORT-RESUME-DESIGN.md): when enabled, an
      // abort detaches instead of killing. detachReject unwinds the awaiting
      // promise; the background close-handler persists the final result.
      let detachReject: ((err: SubagentDetachedError) => void) | undefined;
      const detachPromise = new Promise<never>((_resolve, reject) => {
        detachReject = reject;
      });
      // Prevent unhandled-rejection noise when the race resolves normally.
      detachPromise.catch(() => {});

      const abortHandler = () => {
        const survival = options.abortSurvival;
        if (options.recoverableRole || survival?.settleOnAbort) {
          phaseResult.heartbeat(eventCount, child.pid);
          options.onProgress?.(
            `Subagent ${profile.name}: pause requested while child pid=${child.pid} is live; waiting for durable settlement before pausing.`,
          );
          return;
        }
        if (survival && (survival.shouldDetach?.(options.signal?.reason) ?? true)) {
          const manifest = {
            pid: child.pid,
            agentName: profile.name,
            phaseName: survival.phaseName ?? "(unnamed)",
            phaseIndex: survival.phaseIndex ?? -1,
            startedAt,
            detachedAt: new Date().toISOString(),
            resultFile: survival.resultFile,
          };
          try {
            writeJsonPublicationAtomic(survival.manifestFile, manifest);
          } catch {}
          // Background completion: when the orphaned child finally closes,
          // persist the complete SubagentResult from the still-attached
          // collectors. (v1 limitation: requires this Pi process to stay
          // alive; the child's cwd artifacts are durable regardless.)
          child.once("close", (code) => {
            try {
              const backgroundResult: SubagentResult = {
                agentName: profile.name,
                task,
                text: lastAssistantText.trim(),
                stderr: stderr.trim(),
                exitCode: code,
                durationMs: Date.now() - startedAt,
                events: eventCount,
                toolCalls,
                actionEvidence: actionEvidence.finalize(),
                commandTimes: mergeCommandTimes(options.commandTimingPrior ?? { schemaVersion: 1, entries: [] }, commandTimes.snapshot(actionEvidence.finalize())),
              };
              if (profile.provider) backgroundResult.provider = profile.provider;
              if (profile.model) backgroundResult.model = profile.model;
              if (recoveredAssistantFailures.length > 0) backgroundResult.recoveredAssistantFailures = [...recoveredAssistantFailures];
              writeJsonPublicationAtomic(survival.resultFile, backgroundResult);
            } catch (error) {
              collectorFailure = error instanceof Error ? error : new Error(String(error));
              appendSubagentPhaseLog(phaseLogFile, "host", `ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
            }
          });
          detachReject?.(new SubagentDetachedError(profile.name, manifest));
          return;
        }
        killedByAbort = true;
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
        try { child.kill("SIGTERM"); } catch {}
        killOwnedProcessTree(child.pid, "abort");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          killOwnedProcessTree(child.pid, "abort-hard-kill");
        }, 2000).unref?.();
      };
      if (options.signal) {
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      if (!child.stdout) throw new Error(`Subagent ${profile.name} launched without a readable stdout pipe.`);
      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        appendSubagentPhaseLog(phaseLogFile, "stdout", line);
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed);
          if (isPiJsonProtocolEvent(event)) markFirstJsonProtocolEvent();
          eventCount++;
          // Authority must see every event before any additive timing parser or
          // publication can fail. Timing idempotence never skips validation.
          try { if (!collectorFailure) actionEvidence.observe(event); }
          catch (error) {
            collectorFailure = error instanceof Error ? error : new Error(String(error));
            appendSubagentPhaseLog(phaseLogFile, "host", `ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
          }
          let timingChanged = false;
          try { timingChanged = commandTimes.observe(event); }
          catch {
            commandTimes.markUnavailable();
            timingChanged = true;
            // Parser errors may include worker secrets; persist only safe state.
            appendSubagentPhaseLog(phaseLogFile, "host", "COMMAND_TIMES_UNAVAILABLE: timing observation failed; authoritative evidence remains required.");
          }
          if (timingChanged) phaseResult.publishCommandTimes(commandTimes.snapshot());
          phaseResult.observeEvent(event);
          const progress = describeJsonEvent(profile.name, event);
          if (progress) options.onProgress?.(progress);
          if (!collectorFailure) acknowledgeNoOutputAlarm(event, noOutputAlarmAckRoot);
          if (event?.type === "tool_execution_start") {
            const toolName = optionalString((event as Record<string, unknown>).toolName);
            if (toolName) recordToolCall(toolCalls, toolName);
          }

          // Respect Pi's child auto-retry lifecycle. An agent_end carrying
          // willRetry=true closes only the failed attempt, not the child turn.
          // Park its failures as recovered telemetry and keep accepting the
          // retry's assistant messages. A successful auto_retry_end is a
          // belt-and-braces recovery signal for protocol variants that omit or
          // reorder willRetry.
          if (options.recoverableRole && (event?.type === "agent_start" || (event?.type === "compaction_end" && event.willRetry === true))) {
            if (roleContextExhausted) recoveredAssistantFailures.push("role_context_exhaustion_auto_recovered");
            recoveredAssistantFailures.push(...assistantFailures);
            assistantFailures.length = 0;
            roleContextExhausted = false;
            agentEnded = false;
            settledAssistantText = undefined;
          }
          if (event?.type === "agent_end") {
            if ((event as { willRetry?: boolean }).willRetry === true) {
              if (roleContextExhausted) recoveredAssistantFailures.push("role_context_exhaustion_auto_recovered");
              recoveredAssistantFailures.push(...assistantFailures);
              assistantFailures.length = 0;
              roleContextExhausted = false;
              agentEnded = false;
            } else {
              agentEnded = true;
            }
          }
          if (event?.type === "auto_retry_end" && (event as { success?: boolean }).success === true) {
            if (roleContextExhausted) recoveredAssistantFailures.push("role_context_exhaustion_auto_recovered");
            recoveredAssistantFailures.push(...assistantFailures);
            assistantFailures.length = 0;
            roleContextExhausted = false;
          }

          if (
            event?.type === "message_end" &&
            event.message?.role === "assistant" &&
            !agentEnded
          ) {
            lastAssistantText = extractMessageText(event.message);
            const stopReason =
              optionalString(event.message.stopReason) ??
              optionalString(event.stopReason);
            const errorMessage =
              optionalString(event.message.errorMessage) ??
              optionalString(event.errorMessage) ??
              optionalString(event.message.error?.message) ??
              optionalString(event.error?.message);
            const normalizedStopReason = stopReason?.toLowerCase();
            if (options.recoverableRole && (isRoleContextExhaustion(stopReason, errorMessage) || isRoleRecoveryHandoff(lastAssistantText, options.recoverableRole))) roleContextExhausted = true;
            if (normalizedStopReason === "error" || normalizedStopReason === "aborted") {
              assistantFailures.push(`assistant stopReason=${stopReason}`);
            } else if (
              lastAssistantText.trim() &&
              (normalizedStopReason === "stop" || normalizedStopReason === "end_turn" || normalizedStopReason === "completed")
            ) {
              settledAssistantText = lastAssistantText;
            }
            if (errorMessage) assistantFailures.push(`assistant errorMessage=${errorMessage}`);
            terminalProviderRefusal = classifyProviderRefusal(event) ?? terminalProviderRefusal;
          }
          phaseResult.heartbeat(eventCount, child.pid);
        } catch {
          // JSON mode should emit JSONL; ignore any incidental non-JSON line defensively.
        }
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        const attestationCandidate = guardAttestationBuffer + text;
        if (!workerMonitorAttested && attestationCandidate.includes(NO_OUTPUT_MONITOR_READY_MARKER)) workerMonitorAttested = true;
        if (!workerGuardAttested && attestationCandidate.includes(NO_FORCE_KILL_GUARD_READY_MARKER)) {
          workerGuardAttested = true;
          dispatchTask();
        }
        guardAttestationBuffer = attestationCandidate.slice(-512);
        stderr += text;
        appendSubagentPhaseLog(phaseLogFile, "stderr", text);
        phaseResult.heartbeat(eventCount, child.pid);
      });

      dispatchTask();
      // Pi loads explicit extensions before model/tool dispatch. Releasing stdin
      // here avoids its prompt-before-extension-error startup deadlock; the host
      // still fails closed below unless the guard attests before child exit.

      let exitCode: number | null;
      try {
        exitCode = await Promise.race([
          new Promise<number | null>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => resolve(code));
          }),
          detachPromise,
        ]);
      } catch (err) {
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
        if (options.signal) options.signal.removeEventListener("abort", abortHandler);
        if (err instanceof SubagentDetachedError) {
          // Deliberately do NOT close the stdoutReader: the background
          // collectors keep accumulating until the orphaned child closes.
          options.onProgress?.(
            `Subagent ${profile.name}: DETACHED on abort (pid=${err.manifest.pid}); ` +
              `result will be persisted to ${err.manifest.resultFile}.`,
          );
          throw err;
        }
        stdoutReader.close();
        if (isWindowsSpawnEperm(err) && attemptIndex < launchAttempts.length - 1) {
          phaseResult.retry();
          const next = launchAttempts[attemptIndex + 1];
          options.onProgress?.(
            `Subagent ${profile.name}: Windows spawn EPERM from ${formatSpawnAttempt(launch)}; ` +
              `retrying with ${formatSpawnAttempt(next)}.`,
          );
          continue;
        }
        // Terminal EPERM: capture evidence before throwing.
        const evidence = buildWindowsEpermEvidence(err, launch, options.cwd);
        const evidencePath = await writeWindowsEpermEvidence(evidence);
        const evidenceSuffix = evidencePath ? ` Evidence: ${evidencePath}` : " Evidence capture skipped.";
        throw new Error(formatSpawnFailure(err, launch, options.cwd) + evidenceSuffix);
      }

      if (firstJsonTimer) clearTimeout(firstJsonTimer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
      stdoutReader.close();

      const buildCandidate = (): SubagentResult => buildResult(exitCode);
      const throwAmbiguousIfMutating = (errorMessage: string): void => {
        const mutatingEvidence = options.phaseMutates === true || toolCalls.mutating > 0;
        if (!mutatingEvidence) return;
        const candidate = lastAssistantText.trim() ? buildCandidate() : undefined;
        throw new SubagentTerminalAmbiguousError(profile.name, {
          code: candidate ? "AMBIGUOUS_COMPLETION" : "RESULT_LOST_AFTER_MUTATION",
          resultLost: !candidate,
          errorMessage,
          exitCode,
          stderr: stderr.trim(),
          assistantFailures: [...assistantFailures],
          ...(candidate ? { candidate } : {}),
        });
      };

      if (collectorFailure) {
        throw new Error(`ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
      }
      if (!workerMonitorAttested) {
        throw new Error(`NO_OUTPUT_MONITOR_NOT_LOADED: ${agentName} did not attest the explicitly loaded command monitor.`);
      }
      if (!workerGuardAttested) {
        throw new Error(`NO_FORCE_KILL_GUARD_NOT_LOADED: ${agentName} did not attest the explicitly loaded bash timeout interceptor.`);
      }
      if (roleContextExhausted && !killedByAbort && !protocolTimedOut) throw new RoleContextExhaustionError(buildCandidate());
      const durableResult = phaseResult.readComplete();
      if (!killedByAbort && !protocolTimedOut && durableResult) {
        if (assistantFailures.length > 0) {
          options.onProgress?.(
            `Subagent ${profile.name}: transport failed after a complete host-owned phase result; recovered ${phaseResult.file}.`,
          );
        }
        return durableResult;
      }
      if (killedByAbort) throw new Error(`Subagent ${agentName} aborted.`);
      const providerRefusal = terminalProviderRefusal
        ?? classifyProviderRefusal(assistantFailures.join("; "))
        ?? classifyProviderRefusal(stderr);
      if (providerRefusal) {
        const retryAttempt = options.providerRefusalRetryAttempt ?? 0;
        const retryEligible = isProvablyReadOnlySubagent(options.readOnly || options.verifier, profile.tools) && toolCalls.mutating === 0;
        if (!options.disableProviderRefusalRetry && retryEligible && retryAttempt === 0) {
          options.onProgress?.(`Subagent ${profile.name}: provider refused the read-only review; retrying once with defensive evidence-only wording.`);
          const retried = await spawnSubagent(agentName, buildProviderRefusalRetryPrompt(task), {
            ...options,
            providerRefusalRetryAttempt: 1,
            commandTimingPrior: mergeCommandTimes(options.commandTimingPrior ?? { schemaVersion: 1, entries: [] }, commandTimes.snapshot()),
          });
          retried.commandTimes = mergeCommandTimes(commandTimes.snapshot(actionEvidence.finalize()), retried.commandTimes);
          retried.providerRefusal = {
            ...providerRefusal,
            retryAllowed: true,
            retryEligible: true,
            retryAttempted: true,
            mutationAmbiguous: false,
          };
          return retried;
        }
        throw new ProviderRefusalError(profile.name, {
          providerMessage: providerRefusal.providerMessage,
          retryAllowed: false,
          retryEligible,
          retryAttempted: retryAttempt > 0,
          mutationAmbiguous: !retryEligible,
        });
      }
      if (protocolTimedOut) {
        const message = JSON.stringify({
          type: "pi_child_first_json_timeout",
          agent: agentName,
          timeoutMs: firstJsonTimeoutMs,
          pid: child.pid,
          cwd: options.cwd,
          commandBasename: path.basename(launch.command),
          launchRuntime: command.launchRuntime,
        });
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }
      if (exitCode !== 0) {
        const message = `Subagent ${agentName} exited with code ${exitCode}. stderr: ${truncateWithNotice(stderr.trim(), 2000, "stderr")}`;
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }
      if (assistantFailures.length > 0) {
        const stderrSuffix = stderr.trim()
          ? ` stderr: ${truncateWithNotice(stderr.trim(), 1000, "stderr")}`
          : "";
        const message =
          `Subagent ${agentName} reported assistant failure despite exit code 0: ` +
          `${truncateWithNotice(assistantFailures.join("; "), 2000, "assistant failure details")}.${stderrSuffix}`;
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }

      const result = buildCandidate();
      if (recoveredAssistantFailures.length > 0) {
        options.onProgress?.(
          `Subagent ${profile.name}: transient assistant/transport failure(s) auto-recovered by child retry: ` +
            truncateWithNotice(recoveredAssistantFailures.join("; "), 1000, "recovered failure details"),
        );
      }
      return result;
    }
    throw new Error(`Subagent ${agentName} did not launch: no spawn attempts were available.`);
  } catch (error) {
    launchFailed = true;
    if (!childCreated) phaseResult.incomplete(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (tempDir !== undefined) {
      try { await rm(tempDir, { recursive: true, force: true }); }
      catch (error) {
        // Cleanup must not replace the original refusal or launch failure.
        if (!launchFailed) throw error;
        appendSubagentPhaseLog(phaseLogFile, "host", `launch cleanup failed: ${String(error)}`);
      }
    }
  }
}

// ── Windows spawn hardening ───────────────────────────────────────────────

export interface SpawnAttemptDescriptor {
  label: string;
  command: string;
  args: string[];
  options: SpawnOptions;
}

export function buildWindowsEpermSpawnAttempts(
  command: string,
  args: string[],
  baseOptions: SpawnOptions,
): SpawnAttemptDescriptor[] {
  const attempts: SpawnAttemptDescriptor[] = [
    { label: "primary", command, args, options: baseOptions },
  ];
  if (process.platform !== "win32") return attempts;

  // Some Windows hosts return EPERM for direct hidden console-subsystem
  // CreateProcess calls from TUI/job-object contexts. Keep the normal hidden
  // launch first, then retry through cmd.exe (still hidden) before the final
  // no-CREATE_NO_WINDOW fallback.
  if (!baseOptions.shell) {
    attempts.push({
      label: "windows-shell-hidden-fallback",
      command,
      args,
      options: { ...baseOptions, shell: true, windowsHide: true, detached: false },
    });
  }

  attempts.push({
    label: "windows-visible-fallback",
    command,
    args,
    options: { ...baseOptions, windowsHide: false, detached: false },
  });
  return attempts;
}

export function isWindowsSpawnEperm(err: unknown): boolean {
  if (process.platform !== "win32") return false;
  const record = err as { code?: unknown; message?: unknown };
  return record?.code === "EPERM" || /\bspawn\b[\s\S]*\bEPERM\b/i.test(String(record?.message ?? err));
}

export function formatSpawnAttempt(attempt: SpawnAttemptDescriptor): string {
  const command = path.basename(attempt.command || "<unknown>");
  const shell = attempt.options.shell ? "shell" : "direct";
  const hidden = attempt.options.windowsHide === false ? "visible" : "hidden";
  return `${attempt.label} ${command} (${shell}, ${hidden})`;
}

export function formatSpawnFailure(err: unknown, attempt: SpawnAttemptDescriptor, cwd: string): string {
  const record = err as { code?: unknown; message?: unknown };
  const code = record?.code ? ` code=${String(record.code)}` : "";
  const message = String(record?.message ?? err);
  const hint = isWindowsSpawnEperm(err)
    ? " Hint: Windows returned EPERM while launching a Pi subagent subprocess. " +
      "Common causes are antivirus/EDR interception, a restrictive parent Job object, " +
      "or CREATE_NO_WINDOW/windowsHide interactions in a console-less TUI process. " +
      "Try launching Pi from a normal terminal, checking Defender/EDR events, or " +
      "testing node child-process creation from the same parent context."
    : "";
  return `spawn failed (${formatSpawnAttempt(attempt)}) cwd=${cwd}${code}: ${message}.${hint}`;
}

// ── Windows EPERM evidence capture ──────────────────────────────────────

/**
 * JSON-serializable evidence record written to disk when a Windows spawn
 * EPERM cannot be retried (terminal failure). Contains only safe, 
 * read-only fields — never logs API keys, prompts, full env, or task text.
 */
export interface WindowsEpermEvidence {
  schemaVersion: number;
  kind: "windows-spawn-eperm-evidence";
  timestampUtc: string;
  pid: number;
  ppid: number;
  platform: string;
  nodeVersion: string;
  execPath: {
    basename: string;
    equalsProcessExecPath: boolean;
    exists: boolean;
  };
  cwd: {
    basename: string;
    exists: boolean;
  };
  attempt: {
    label: string;
    commandBasename: string;
    argsCount: number;
    options: {
      shell: boolean;
      windowsHide: boolean;
      detached: boolean;
      stdioShape: string;
    };
  };
  envAllowlist: {
    PATH_present: boolean;
    PI_CLI_PATH_present: boolean;
    PI_CLI_present: boolean;
  };
  error: {
    code: string | null;
    message: string;
  };
  correlationWindowMinutes: number;
}

/**
 * Redacted view of a spawn attempt — never includes the full command path
 * unless it equals process.execPath, and never logs argument text.
 */
export interface SafeAttemptView {
  label: string;
  commandBasename: string;
  argsCount: number;
  shell: boolean;
  windowsHide: boolean;
  detached: boolean;
  stdioShape: string;
}

/**
 * Redact a SpawnAttemptDescriptor into a SafeAttemptView for evidence 
 * capture. Only computes basename, counts, and boolean flags.
 */
export function redactSpawnAttempt(attempt: SpawnAttemptDescriptor): SafeAttemptView {
  const configuredStdio = attempt.options?.stdio ?? ["ignore", "pipe", "pipe"];
  const stdioEntries = Array.isArray(configuredStdio) ? configuredStdio : [configuredStdio];
  return {
    label: attempt.label,
    commandBasename: path.basename(attempt.command || "<unknown>"),
    argsCount: attempt.args?.length ?? 0,
    shell: attempt.options?.shell === true,
    windowsHide: attempt.options?.windowsHide !== false,
    detached: attempt.options?.detached === true,
    stdioShape: JSON.stringify(stdioEntries.map((s: unknown) => s === "pipe" ? "pipe" : s === "ignore" ? "ignore" : "inherit")),
  };
}

/**
 * Sanitize a spawn error message to remove full command paths and other
 * potentially sensitive strings while preserving useful diagnostic info.
 */
function sanitizeSpawnErrorMessage(err: unknown, attempt: SpawnAttemptDescriptor): string {
  let sanitized = String((err as { message?: unknown })?.message ?? err);
  // Replace the full command path with its basename.
  const commandPath = attempt.command;
  if (commandPath && commandPath.length > 4) {
    const escaped = commandPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(escaped, "g"), path.basename(commandPath));
  }
  // Additional scrubbing: remove anything that looks like a Windows full path.
  sanitized = sanitized.replace(/[A-Za-z]:\\[^\s"'>;,!]{8,}/g, "[path-redacted]");
  return sanitized.slice(0, 500);
}

/**
 * Build a WindowsEpermEvidence record from the error, spawn attempt, and
 * working directory. Pure — performs no I/O.
 */
export function buildWindowsEpermEvidence(
  err: unknown,
  attempt: SpawnAttemptDescriptor,
  cwd: string,
): WindowsEpermEvidence {
  const record = err as { code?: unknown; message?: unknown };
  const safe = redactSpawnAttempt(attempt);
  return {
    schemaVersion: 1,
    kind: "windows-spawn-eperm-evidence",
    timestampUtc: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    nodeVersion: process.version,
    execPath: {
      basename: path.basename(process.execPath),
      equalsProcessExecPath: safe.commandBasename === path.basename(process.execPath),
      exists: existsSync(process.execPath),
    },
    cwd: {
      basename: path.basename(cwd),
      exists: existsSync(cwd),
    },
    attempt: {
      label: safe.label,
      commandBasename: safe.commandBasename,
      argsCount: safe.argsCount,
      options: {
        shell: safe.shell,
        windowsHide: safe.windowsHide,
        detached: safe.detached,
        stdioShape: safe.stdioShape,
      },
    },
    envAllowlist: {
      PATH_present: "PATH" in process.env,
      PI_CLI_PATH_present: "PI_CLI_PATH" in process.env,
      PI_CLI_present: "PI_CLI" in process.env,
    },
    error: {
      code: typeof record?.code === "string" ? record.code : null,
      message: sanitizeSpawnErrorMessage(err, attempt),
    },
    correlationWindowMinutes: 10,
  };
}

/**
 * Best-effort write of WindowsEpermEvidence to disk. Creates 
 * `agent/diagnostics/spawn-eperm/` if needed, writes a JSON file, and
 * returns the path. Swallows all errors silently — never throws.
 */
export async function writeWindowsEpermEvidence(
  evidence: WindowsEpermEvidence,
): Promise<string | null> {
  try {
    const dir = path.resolve(process.cwd(), "agent", "diagnostics", "spawn-eperm");
    await mkdir(dir, { recursive: true });
    const fileName = `spawn-eperm-${evidence.pid}-${Date.now()}.json`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, JSON.stringify(evidence, null, 2), "utf8");
    return filePath;
  } catch {
    return null;
  }
}

// ── Pre-flight provider health checks (F5) ────────────────────────────────

export interface PreflightRoute {
  /** Role(s) this route serves — for reporting only. */
  roles: string[];
  provider?: string;
  model?: string;
  providerIsPiDefault?: boolean;
  modelIsPiDefault?: boolean;
}

export interface PreflightResult {
  roles: string[];
  provider?: string;
  model?: string;
  ok: boolean;
  durationMs: number;
  /** Number of identical-route health probes made (never more than two). */
  attempts: number;
  /** Advisory provenance that the first transient probe failed but its one retry passed. */
  recoveredAfterRetry?: true;
  error?: ProviderHealthError;
}

/**
 * Run a 1-token health ping for each unique routed provider/model pair
 * BEFORE any work subagent is spawned (F5). Failures are returned as
 * structured, machine-readable errors (provider, type, resets_at) instead
 * of raw payload dumps. Pings do not count against orchestration budgets.
 */
export async function preflightProviderHealth(
  routes: PreflightRoute[],
  options: {
    cwd: string;
    allowLocalModel: boolean;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    /** Hard wall-clock bound for each provider/model ping. Production default: 20 seconds. */
    timeoutMs?: number;
    /** Bound for the complete batch, including the one allowed identical-route retry. */
    totalTimeoutMs?: number;
  },
): Promise<PreflightResult[]> {
  // Dedupe identical provider/model pairs, merging role labels.
  const unique = new Map<string, PreflightRoute>();
  for (const route of routes) {
    if (!route.provider && !route.model) continue;
    const key = `${route.provider ?? ""}::${route.model ?? ""}::` +
      `${route.providerIsPiDefault === true ? "default" : "explicit"}::` +
      `${route.modelIsPiDefault === true ? "default" : "explicit"}`;
    const existing = unique.get(key);
    if (existing) existing.roles.push(...route.roles.filter((r) => !existing.roles.includes(r)));
    else unique.set(key, {
      roles: [...route.roles],
      provider: route.provider,
      model: route.model,
      providerIsPiDefault: route.providerIsPiDefault,
      modelIsPiDefault: route.modelIsPiDefault,
    });
  }

  const results: PreflightResult[] = [];
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 20_000));
  const totalTimeoutMs = options.totalTimeoutMs === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.trunc(options.totalTimeoutMs));
  const deadline = Date.now() + totalTimeoutMs;
  const preflightAgents = new Map<string, AgentProfile>([
    ["preflight", { name: "preflight", description: "Provider health ping", tools: [] }],
  ]);
  const isTransient = (error: ProviderHealthError): boolean => {
    if (error.type === "timeout" || error.type === "network") return true;
    if (error.type !== "unknown") return false;
    // Unknown child/transport termination can be transient, but policy and
    // refusal wording is always a hard one-shot result.
    return !/(?:policy|refus(?:al|ed)|flagged for possible .*risk|authentication|unauthorized|forbidden)/i.test(error.message);
  };

  for (const route of unique.values()) {
    const startedAt = Date.now();
    const label = formatRoutedModel(route.provider, route.model);
    let attempts = 0;
    let firstTransientFailure = false;
    let settled = false;
    while (!settled && attempts < 2) {
      attempts += 1;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const error = parseProviderError(
          `PREFLIGHT_TIMEOUT: complete provider-health batch timed out after ${totalTimeoutMs}ms`,
          route.provider,
          route.model,
        );
        results.push({ roles: route.roles, provider: route.provider, model: route.model, ok: false, durationMs: Date.now() - startedAt, attempts: attempts - 1, error });
        options.onProgress?.(`Preflight ping FAILED: ${formatProviderError(error)}`);
        break;
      }
      const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
      options.onProgress?.(
        `Preflight ping: checking ${label} (roles: ${route.roles.join(", ")}, ` +
        `attempt=${attempts}/2, timeout=${attemptTimeoutMs}ms)...`,
      );
      const pingController = new AbortController();
      let timedOut = false;
      const outerAbort = () => pingController.abort();
      if (options.signal) {
        if (options.signal.aborted) outerAbort();
        else options.signal.addEventListener("abort", outerAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        pingController.abort();
      }, attemptTimeoutMs);
      timer.unref?.();
      try {
        const ping = await spawnSubagent("preflight", "Reply with the single word: pong", {
          agents: preflightAgents,
          cwd: options.cwd,
          allowLocalModel: options.allowLocalModel,
          signal: pingController.signal,
          // Suppress per-spawn progress so preflight lines can never be
          // mistaken for model-routing attestation evidence.
          onProgress: undefined,
          modelOverride: {
            model: route.model,
            provider: route.provider,
            modelIsPiDefault: route.modelIsPiDefault,
            providerIsPiDefault: route.providerIsPiDefault,
          },
          disableProviderRefusalRetry: true,
        });
        results.push({
          roles: route.roles,
          provider: route.provider,
          model: route.model,
          ok: true,
          durationMs: Date.now() - startedAt,
          attempts,
          ...(firstTransientFailure ? { recoveredAfterRetry: true as const } : {}),
        });
        options.onProgress?.(
          `Preflight ping: ${label} healthy (${Date.now() - startedAt}ms, ${ping.events} event(s)` +
          `${firstTransientFailure ? ", recovered on identical-route retry" : ""}).`,
        );
        settled = true;
      } catch (err) {
        if (options.signal?.aborted && !timedOut) {
          throw new Error(`PREFLIGHT ABORTED while checking ${label}.`);
        }
        const raw = timedOut
          ? `PREFLIGHT_TIMEOUT: ${label} timed out after ${attemptTimeoutMs}ms`
          : String(err);
        const error = parseProviderError(raw, route.provider, route.model);
        options.onProgress?.(`Preflight ping FAILED: ${formatProviderError(error)}`);
        if (attempts === 1 && isTransient(error) && deadline > Date.now()) {
          firstTransientFailure = true;
          options.onProgress?.(
            `Preflight ping: transient ${error.type} failure; retrying once on the identical route ${label} (advisory recovery).`,
          );
        } else {
          results.push({
            roles: route.roles,
            provider: route.provider,
            model: route.model,
            ok: false,
            durationMs: Date.now() - startedAt,
            attempts,
            error,
          });
          settled = true;
        }
      } finally {
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener("abort", outerAbort);
      }
    }
  }

  return results;
}

// ── runBoundedPool ─────────────────────────────────────────────────────────

/**
 * Run a bounded pool of concurrent workers over an array of items.
 *
 * Role-agnostic: takes any items and any worker function. By itself
 * it does NOT enforce a spawn ceiling — the caller should use a
 * SpawnGuard to bound resource usage.
 */
export async function runBoundedPool<T, R>(
  items: T[],
  concurrency: number,
  outerSignal: AbortSignal | undefined,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const controller = new AbortController();
  let nextIndex = 0;
  let firstError: unknown;

  const abortSiblings = (error?: unknown) => {
    if (error !== undefined && firstError === undefined) firstError = error;
    if (!controller.signal.aborted) controller.abort();
  };

  const outerAbortHandler = () => abortSiblings(new Error("Orchestration aborted."));
  if (outerSignal) {
    if (outerSignal.aborted) outerAbortHandler();
    else outerSignal.addEventListener("abort", outerAbortHandler, { once: true });
  }

  const workerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index, controller.signal);
      } catch (error) {
        abortSiblings(error);
        return;
      }
    }
  });

  try {
    await Promise.allSettled(runners);
  } finally {
    if (outerSignal) outerSignal.removeEventListener("abort", outerAbortHandler);
  }

  if (firstError !== undefined) throw firstError;
  throwIfAborted(outerSignal);
  return results;
}

// ── buildExecutionWaves ────────────────────────────────────────────────────

/**
 * Build a topological wave schedule from items with `id` and `dependsOn`.
 *
 * Returns an array of waves where each wave is an array of items whose
 * dependencies have all been satisfied by previous waves. Items in the
 * same wave are independent and can run concurrently.
 *
 * Throws on duplicate IDs, missing dependencies, or dependency cycles.
 *
 * This is role-agnostic — it only knows about `id` and `dependsOn` fields.
 */
export function buildExecutionWaves<T extends { id: string; dependsOn: string[] }>(
  items: T[],
): T[][] {
  const itemById = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    if (!item.id.trim()) throw new Error(`Item at index ${index} has an empty id.`);
    if (itemById.has(item.id)) throw new Error(`Duplicate item id: ${item.id}`);
    itemById.set(item.id, item);
  }

  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (!itemById.has(dependencyId)) {
        throw new Error(`Item ${item.id} depends on unknown id: ${dependencyId}`);
      }
    }
  }

  const completed = new Set<string>();
  const remaining = new Map(items.map((item) => [item.id, new Set(item.dependsOn)]));
  const waves: T[][] = [];

  while (remaining.size > 0) {
    const readyIds = [...remaining.entries()]
      .filter(([, dependencies]) =>
        [...dependencies].every((dependencyId) => completed.has(dependencyId)),
      )
      .map(([id]) => id);

    if (readyIds.length === 0) {
      throw new Error(
        `Dependency cycle detected among item ids: ${[...remaining.keys()].join(", ")}`,
      );
    }

    const wave = readyIds.map((id) => itemById.get(id)!);
    waves.push(wave);
    for (const id of readyIds) {
      remaining.delete(id);
      completed.add(id);
    }
  }

  return waves;
}

// ── runWorkGraph ───────────────────────────────────────────────────────────

/**
 * Run a work graph (array of waves) through a bounded pool.
 *
 * Each wave runs to completion (with bounded concurrency) before the next
 * wave begins. Between waves, the abort signal is checked so a long-running
 * graph can be cancelled cooperatively.
 *
 * This is role-agnostic: it takes waves and a worker, and does not know
 * what the items represent or what the worker produces.
 */
export async function runWorkGraph<T, R>(
  waves: T[][],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const outputs: R[] = [];
  for (const [waveIndex, wave] of waves.entries()) {
    throwIfAborted(signal);
    const waveOutputs = await runBoundedPool(wave, concurrency, signal, async (task, index, workerSignal) => {
      return worker(task, index, workerSignal);
    });
    outputs.push(...waveOutputs);
    if (waveIndex < waves.length - 1) throwIfAborted(signal);
  }
  return outputs;
}

// ── Utility helpers (internal plumbing) ────────────────────────────────────

interface ResolvedPiCommand {
  command: string;
  argsPrefix: string[];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  launchRuntime?: string;
}

function buildSubagentSystemPrompt(profile: AgentProfile): string {
  const parts = [
    `You are the isolated Pi subagent named ${profile.name}.`,
    profile.description ? `Description: ${profile.description}` : "",
    profile.agencyLevel !== undefined ? `Agency level: ${profile.agencyLevel}` : "",
    "You receive only the task in the user prompt. Do not assume access to parent conversation history.",
    "Do not call or request a shared blackboard. Return a final concise assistant response for the orchestrator.",
    "Do not invoke the orchestrate tool or spawn additional orchestrations.",
    profile.systemPrompt ?? "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

function describeJsonEvent(agentName: string, event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const raw = event as Record<string, unknown>;
  const eventType = optionalString(raw.type);
  const assistantEvent =
    raw.assistantMessageEvent && typeof raw.assistantMessageEvent === "object"
      ? (raw.assistantMessageEvent as Record<string, unknown>)
      : undefined;
  const innerType = optionalString(assistantEvent?.type) ?? eventType;

  if (eventType === "tool_execution_update") {
    const partial = raw.partialResult && typeof raw.partialResult === "object"
      ? raw.partialResult as Record<string, unknown>
      : undefined;
    const details = partial?.details && typeof partial.details === "object"
      ? partial.details as Record<string, unknown>
      : undefined;
    const alarm = details?.noOutputAlarm && typeof details.noOutputAlarm === "object"
      ? details.noOutputAlarm as Record<string, unknown>
      : undefined;
    if (alarm?.type === "command_no_output_alarm") {
      return `COMMAND_NO_OUTPUT_ALARM ${JSON.stringify({
        agentName,
        toolCallId: raw.toolCallId,
        commandId: alarm.commandId,
        invocationId: alarm.invocationId,
        wallTime: alarm.wallTime,
        elapsedMs: alarm.elapsedMs,
        noOutputMs: alarm.noOutputMs,
        eligibility: alarm.eligibility,
      })}`;
    }
  }

  if (innerType === "tool_call_start") {
    const toolName =
      optionalString(assistantEvent?.toolName) ?? optionalString(raw.toolName) ?? "unknown-tool";
    return `Subagent ${agentName}: tool call started (${toolName})`;
  }
  if (eventType === "tool_execution_start") {
    const toolName = optionalString(raw.toolName) ?? "unknown-tool";
    return `Subagent ${agentName}: executing tool ${toolName}`;
  }
  if (eventType === "tool_execution_end") {
    const toolName = optionalString(raw.toolName) ?? "unknown-tool";
    return `Subagent ${agentName}: tool ${toolName} finished`;
  }
  if (eventType === "message_start") return `Subagent ${agentName}: assistant response started`;
  if (eventType === "message_end") return `Subagent ${agentName}: assistant response finished`;
  if (eventType === "agent_end") return `Subagent ${agentName}: process agent_end received`;
  return null;
}

function extractMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
        return String((part as Record<string, unknown>).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function resolvePiCommand(): ResolvedPiCommand {
  const envPath = process.env.PI_CLI_PATH?.trim();
  if (envPath) return resolvePiCliPath(envPath, "PI_CLI_PATH");

  const envCommand = process.env.PI_CLI?.trim();
  if (envCommand)
    return { command: envCommand, argsPrefix: [], shell: shouldUseWindowsShell(envCommand) };

  const currentCliScript = process.argv[1];
  if (currentCliScript && isExistingPiCliScript(currentCliScript)) {
    return resolvePiChildCommand(currentCliScript, "process.argv[1]");
  }

  const cliScript = process.argv.find((arg) => isExistingPiCliScript(arg));
  if (cliScript) return resolvePiChildCommand(cliScript, "process.argv");

  const installedCliScript = resolveInstalledPiCliScript();
  if (installedCliScript) return resolvePiChildCommand(installedCliScript, "installed Pi CLI");

  return process.platform === "win32"
    ? { command: "pi.cmd", argsPrefix: [], shell: true }
    : { command: "pi", argsPrefix: [] };
}

function resolvePiCliPath(cliPath: string, envName: string): ResolvedPiCommand {
  if (!existsSync(cliPath))
    throw new Error(`${envName} points to a missing Pi CLI path: ${cliPath}`);
  const ext = path.extname(cliPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs")
    return resolvePiChildCommand(cliPath, envName);
  return { command: cliPath, argsPrefix: [], shell: shouldUseWindowsShell(cliPath), launchRuntime: shouldUseWindowsShell(cliPath) ? "shell" : "native" };
}

function shouldUseWindowsShell(command: string): boolean | undefined {
  if (process.platform !== "win32") return undefined;
  return /\.(cmd|bat)(?:$|\s)/i.test(command) ? true : undefined;
}

function isExistingPiCliScript(candidate: string): boolean {
  return (
    /pi-coding-agent[\\/]dist[\\/](main|cli)\.js$/.test(candidate) && existsSync(candidate)
  );
}

function resolveInstalledPiCliScript(): string | null {
  const candidates = [
    process.env.APPDATA
      ? path.join(
          process.env.APPDATA,
          "npm",
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        )
      : "",
    path.join(
      os.homedir(),
      ".npm-global",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
    path.join(
      os.homedir(),
      ".nvm",
      "versions",
      "node",
      "current",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Format a provider/model pair for display/logging.
 * Also exported so shapes can use it for progress messages.
 */
export function formatRoutedModel(provider?: string, model?: string): string {
  if (provider && model) return `${provider}/${model}`;
  if (model) return model;
  if (provider) return `${provider}/default`;
  return "Pi default provider/model";
}

function rejectLocalModelIfNeeded(profile: AgentProfile, allowLocalModel: boolean) {
  if (allowLocalModel) return;
  const combined = `${profile.provider ?? ""} ${profile.model ?? ""}`.toLowerCase();
  if (/\b(local|ollama|lmstudio|llama\.cpp|kobold|text-generation-webui)\b/.test(combined)) {
    throw new Error(
      `Agent ${profile.name} appears to target a local model (${profile.provider ?? ""}/${profile.model ?? ""}). Set allowLocalModel=true to permit it.`,
    );
  }
}

function writeJsonPublicationAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

async function mkTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `pi-orchestrator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "agent";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function truncateWithNotice(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  const notice = `\n\n_(${label} truncated: ${text.length - max} additional characters omitted.)_`;
  return `${text.slice(0, Math.max(0, max - notice.length))}${notice}`;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Orchestration aborted.");
}
