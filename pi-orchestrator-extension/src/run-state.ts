/**
 * Run-state store — persistent checkpoint/resume state for orchestration runs.
 * ============================================================================
 * Substrate-level module (NOT a shape). Provides durable per-run state under
 * ~/.pi/pi-orchestrator-extension/runs/<runId>/ so that a run whose tool-call
 * AbortSignal fires mid-phase (observed: Pi core aborts hour-long silent tool
 * calls at ~44-57 min) can be resumed with `orchestrate({ resume: "<runId>" })`
 * instead of being discarded.
 *
 * See ABORT-RESUME-DESIGN.md for the full design.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SubagentResult } from "./substrate";
import { refreshLiveStatus, type LiveStatusOptions } from "./live-status";
import { observeHostPublication } from "./host-publications";

// ── Types ──────────────────────────────────────────────────────────────────

export type PhaseStatus = "done" | "detached" | "pending" | "ambiguous-completion";

/** Shared durable cursor used by generic host-owned task-boundary adapters. */
export type GenericSupervisionStage = "plan" | "executor-task" | "verifier" | "terminal";

export interface GenericSupervisionProtocolIdentity {
  protocolId: "host-task-boundary-v1";
  adapterId: string;
  adapterVersion: 1;
}

export interface GenericSupervisionCursor {
  schemaVersion: 1;
  identity: GenericSupervisionProtocolIdentity;
  stage: GenericSupervisionStage;
  /** Zero-based task position to dispatch after the next host approval. */
  nextTaskIndex: number;
  completedTaskIds: string[];
  currentTaskId?: string;
  lastCheckpointId?: string;
}

/**
 * Optional binding on historical run state. Its absence is intentionally
 * accepted for backward compatibility, but is never evidence that a resumed
 * executor-bearing shape is safe to run without an explicit policy decision.
 */
export interface HistoricalSupervisionBinding {
  schemaVersion: 1;
  mode: "visible-main" | "off";
  classification: "read-only" | "executor-bearing" | "mutating";
  identity?: GenericSupervisionProtocolIdentity;
  cursor?: GenericSupervisionCursor;
}

export type TerminalNoRetryCode =
  | "AMBIGUOUS_COMPLETION"
  | "RESULT_LOST_AFTER_MUTATION"
  | "WRITE_SET_VIOLATION"
  | "WRITE_SET_UNOBSERVABLE";

export interface TerminalNoRetryState {
  code: TerminalNoRetryCode;
  retryAllowed: false;
  resultLost: boolean;
  phaseName: string;
  phaseIndex: number;
  recordedAt: string;
  errorMessage: string;
  agentName?: string;
  exitCode?: number | null;
  spawnedCount?: number;
  verifierSpawned?: boolean;
  observed?: string[];
  violations?: string[];
  unobservableScopes?: string[];
  candidateResultFile?: string;
  runId?: string;
}

export interface PhaseStateEntry {
  index: number;
  name: string;
  status: PhaseStatus;
}

export interface RunStateFile {
  runId: string;
  paradigm: string;
  task: string;
  createdAt: string;
  /** Serializable subset of NormalizedParams needed to re-dispatch the run. */
  params: Record<string, unknown>;
  phases: PhaseStateEntry[];
  /**
   * Optional declarative-workflow provenance. Older/native run-state files do
   * not contain this field and continue to load unchanged. Dynamic resumes
   * require it and use its pinned validated snapshot instead of re-reading a
   * possibly changed source artifact.
   */
  dynamicWorkflow?: Record<string, unknown>;
  /** Durable supervision identity/cursor for generic and historical resume. */
  supervision?: HistoricalSupervisionBinding;
}

export interface SurvivorManifest {
  pid: number | undefined;
  agentName: string;
  phaseName: string;
  phaseIndex: number;
  startedAt: number;
  detachedAt: string;
  resultFile: string;
}

export interface LoadedRunState {
  state: RunStateFile;
  /** Checkpointed results keyed by phase index. */
  checkpoints: Map<number, SubagentResult>;
  /** Survivor manifests keyed by phase index. */
  survivors: Map<number, SurvivorManifest>;
  /** Terminal no-retry states keyed by phase index (ambiguous mutating completion / result lost). */
  terminalStates: Map<number, TerminalNoRetryState>;
  /** Absolute run directory. */
  runDir: string;
}

// ── Store ──────────────────────────────────────────────────────────────────

export function runsRootDir(): string {
  const override = process.env.PI_ORCHESTRATOR_RUNS_ROOT?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".pi", "pi-orchestrator-extension", "runs-state");
}

export function runDirFor(runId: string): string {
  // Fail closed instead of sanitizing: replacement aliases (and especially
  // the formerly accepted "." / "..") can select a different directory.
  if (
    typeof runId !== "string" ||
    runId.length < 1 ||
    runId.length > 128 ||
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_-])?$/.test(runId) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId)
  ) {
    throw new Error("Invalid orchestration run id: expected a portable 1-128 character identifier beginning with a letter or digit and not ending in a dot.");
  }
  return path.join(runsRootDir(), runId);
}

function safePhaseName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "subagent";
}

function phaseFileName(index: number, name: string): string {
  return `phase-${index}-${safePhaseName(name)}.json`;
}

/** Raw streaming stdout/stderr evidence for a phase, written before settlement. */
export function phaseLogPathFor(runId: string, index: number, name: string): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Phase log index must be a non-negative safe integer.");
  return path.join(runDirFor(runId), `phase-${index}-${safePhaseName(name)}.log`);
}

/** Incremental heartbeat and terminal-result sidecar for a launched phase. */
export function phaseResultPathFor(runId: string, index: number, name: string): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Phase result index must be a non-negative safe integer.");
  return path.join(runDirFor(runId), `phase-${index}-${safePhaseName(name)}.result.json`);
}

function survivorFileName(index: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `survivor-${index}-${safe}.json`;
}

function terminalStateFileName(index: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `terminal-no-retry-${index}-${safe}.json`;
}

function terminalCandidateFileName(index: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `terminal-no-retry-${index}-${safe}.candidate.json`;
}

/**
 * Durably replace a JSON file without exposing a partially written checkpoint.
 * The sibling temporary file is flushed before rename; directory fsync is best
 * effort because Windows does not permit opening every directory as a file.
 */
export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  observeHostPublication([filePath], () => atomicWriteJsonUnobserved(filePath, value));
}

function atomicWriteJsonUnobserved(filePath: string, value: unknown): void {
  const target = path.resolve(filePath);
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error(`Cannot atomically write non-JSON value to ${target}.`);
  const bytes = `${serialized}\n`;
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(fileDescriptor, bytes, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, target);
    try {
      const directoryDescriptor = openSync(parent, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      // Best effort on platforms (notably Windows) that reject directory fsync.
    }
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try { closeSync(fileDescriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function survivorResultFileName(index: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `survivor-${index}-${safe}.result.json`;
}

export class RunStateStore {
  readonly runDir: string;
  private state: RunStateFile;

  private constructor(runDir: string, state: RunStateFile) {
    this.runDir = runDir;
    this.state = state;
  }

  /** Create (or overwrite) the store for a fresh run. */
  static create(
    runId: string,
    paradigm: string,
    task: string,
    params: Record<string, unknown>,
    phaseNames: string[],
    dynamicWorkflow?: Record<string, unknown>,
    supervision?: HistoricalSupervisionBinding,
  ): RunStateStore {
    const runDir = runDirFor(runId);
    mkdirSync(runDir, { recursive: true });
    if (supervision) validateHistoricalSupervisionBinding(supervision, `run ${runId}`);
    const state: RunStateFile = {
      runId,
      paradigm,
      task,
      createdAt: new Date().toISOString(),
      params,
      phases: phaseNames.map((name, index) => ({ index, name, status: "pending" as PhaseStatus })),
      ...(dynamicWorkflow ? { dynamicWorkflow } : {}),
      ...(supervision ? { supervision: structuredClone(supervision) } : {}),
    };
    const store = new RunStateStore(runDir, state);
    store.persist();
    return store;
  }

  /** Load a previously persisted run (throws with a clear message when absent). */
  static load(runId: string, options: LiveStatusOptions = {}): LoadedRunState {
    const runDir = runDirFor(runId);
    const stateFile = path.join(runDir, "state.json");
    if (!existsSync(stateFile)) {
      if (existsSync(runDir)) { try { refreshLiveStatus(runDir, { ...options, observationError: "state.json: missing" }); } catch {} }
      throw new Error(
        `Resume state not found for run "${runId}" (expected ${stateFile}). ` +
          `Known runs: ${listKnownRuns().slice(0, 10).join(", ") || "(none)"}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch (error) {
      try { refreshLiveStatus(runDir, { ...options, observationError: `state.json: ${error instanceof Error ? error.message : String(error)}` }); } catch {}
      throw new Error(`Run state ${stateFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    let state: RunStateFile;
    try { state = validateLoadedRunState(parsed, runId, stateFile); }
    catch (error) {
      try { refreshLiveStatus(runDir, { ...options, observationError: `state.json: ${error instanceof Error ? error.message : String(error)}` }); } catch {}
      throw error;
    }
    const checkpoints = new Map<number, SubagentResult>();
    const survivors = new Map<number, SurvivorManifest>();
    const terminalStates = new Map<number, TerminalNoRetryState>();
    for (const phase of state.phases) {
      const checkpointPath = path.join(runDir, phaseFileName(phase.index, phase.name));
      if (existsSync(checkpointPath)) {
        try {
          checkpoints.set(phase.index, JSON.parse(readFileSync(checkpointPath, "utf8")) as SubagentResult);
        } catch {}
      }
      const survivorPath = path.join(runDir, survivorFileName(phase.index, phase.name));
      if (existsSync(survivorPath)) {
        try {
          survivors.set(phase.index, JSON.parse(readFileSync(survivorPath, "utf8")) as SurvivorManifest);
        } catch {}
      }
      const terminalPath = path.join(runDir, terminalStateFileName(phase.index, phase.name));
      if (existsSync(terminalPath)) {
        try {
          terminalStates.set(phase.index, JSON.parse(readFileSync(terminalPath, "utf8")) as TerminalNoRetryState);
        } catch {}
      }
    }
    refreshLiveStatus(runDir, options);
    return { state, checkpoints, survivors, terminalStates, runDir };
  }

  /** Re-open an existing store to continue appending checkpoints during resume. */
  static open(runId: string): RunStateStore {
    const loaded = RunStateStore.load(runId);
    return new RunStateStore(loaded.runDir, loaded.state);
  }

  get runId(): string {
    return this.state.runId;
  }

  /** Atomically pin or advance the supervision binding on an existing run. */
  bindSupervision(binding: HistoricalSupervisionBinding): void {
    validateHistoricalSupervisionBinding(binding, `run ${this.state.runId}`);
    const existing = this.state.supervision;
    if (existing) {
      if (existing.mode !== binding.mode || existing.classification !== binding.classification) {
        throw new Error("Refusing to change the supervision mode/classification of an existing run.");
      }
      if (Boolean(existing.identity) !== Boolean(binding.identity) || (existing.identity && binding.identity && (
        existing.identity.protocolId !== binding.identity.protocolId ||
        existing.identity.adapterId !== binding.identity.adapterId ||
        existing.identity.adapterVersion !== binding.identity.adapterVersion
      ))) {
        throw new Error("Refusing to change the supervision protocol/adapter identity of an existing run.");
      }
      if (existing.cursor && binding.cursor) {
        if (binding.cursor.nextTaskIndex < existing.cursor.nextTaskIndex) {
          throw new Error("Refusing to move the generic supervision cursor backwards.");
        }
        const completed = new Set(binding.cursor.completedTaskIds);
        if (existing.cursor.completedTaskIds.some((taskId) => !completed.has(taskId))) {
          throw new Error("Refusing to remove completed tasks from the generic supervision cursor.");
        }
      }
    }
    this.state.supervision = structuredClone(binding);
    this.persist();
  }

  checkpointPhase(index: number, name: string, result: SubagentResult): void {
    atomicWriteJsonSync(path.join(this.runDir, phaseFileName(index, name)), result);
    this.setStatus(index, name, "done");
  }

  markDetached(index: number, name: string, manifest: SurvivorManifest): void {
    atomicWriteJsonSync(path.join(this.runDir, survivorFileName(index, name)), manifest);
    this.setStatus(index, name, "detached");
  }

  markTerminalNoRetry(index: number, name: string, state: TerminalNoRetryState, candidate?: SubagentResult): TerminalNoRetryState {
    let candidateResultFile = state.candidateResultFile;
    if (candidate) {
      candidateResultFile = candidateResultFile ?? this.terminalCandidatePath(index, name);
      atomicWriteJsonSync(candidateResultFile, candidate);
    }
    const payload: TerminalNoRetryState = {
      ...state,
      phaseName: name,
      phaseIndex: index,
      retryAllowed: false,
      runId: this.state.runId,
      ...(candidateResultFile ? { candidateResultFile } : {}),
    };
    atomicWriteJsonSync(path.join(this.runDir, terminalStateFileName(index, name)), payload);
    this.setStatus(index, name, "ambiguous-completion");
    return payload;
  }

  survivorResultPath(index: number, name: string): string {
    return path.join(this.runDir, survivorResultFileName(index, name));
  }

  survivorManifestPath(index: number, name: string): string {
    return path.join(this.runDir, survivorFileName(index, name));
  }

  terminalStatePath(index: number, name: string): string {
    return path.join(this.runDir, terminalStateFileName(index, name));
  }

  terminalCandidatePath(index: number, name: string): string {
    return path.join(this.runDir, terminalCandidateFileName(index, name));
  }

  private setStatus(index: number, name: string, status: PhaseStatus): void {
    const existing = this.state.phases.find((phase) => phase.index === index);
    if (existing) {
      existing.status = status;
      existing.name = name;
    } else {
      this.state.phases.push({ index, name, status });
      this.state.phases.sort((a, b) => a.index - b.index);
    }
    this.persist();
  }

  private persist(): void {
    mkdirSync(this.runDir, { recursive: true });
    atomicWriteJsonSync(path.join(this.runDir, "state.json"), this.state);
    refreshLiveStatus(this.runDir);
  }
}

function validateLoadedRunState(value: unknown, expectedRunId: string, stateFile: string): RunStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Run state ${stateFile} must be a JSON object.`);
  }
  const state = value as Partial<RunStateFile>;
  if (state.runId !== expectedRunId) {
    throw new Error(`Run state id mismatch: requested ${JSON.stringify(expectedRunId)}, stored ${JSON.stringify(state.runId)}.`);
  }
  if (typeof state.paradigm !== "string" || !state.paradigm.trim() || typeof state.task !== "string" || typeof state.createdAt !== "string") {
    throw new Error(`Run state ${stateFile} is missing required string metadata.`);
  }
  if (!state.params || typeof state.params !== "object" || Array.isArray(state.params)) {
    throw new Error(`Run state ${stateFile} has invalid params metadata.`);
  }
  if (!Array.isArray(state.phases) || state.phases.length > 10_000) {
    throw new Error(`Run state ${stateFile} has an invalid or excessive phase manifest.`);
  }
  const indices = new Set<number>();
  const names = new Set<string>();
  const statuses = new Set<PhaseStatus>(["done", "detached", "pending", "ambiguous-completion"]);
  for (const [position, phase] of state.phases.entries()) {
    if (
      !phase ||
      typeof phase !== "object" ||
      !Number.isInteger(phase.index) ||
      phase.index < 0 ||
      typeof phase.name !== "string" ||
      !phase.name ||
      phase.name.length > 512 ||
      !statuses.has(phase.status)
    ) {
      throw new Error(`Run state ${stateFile} has an invalid phase entry at position ${position}.`);
    }
    if (indices.has(phase.index) || names.has(phase.name)) {
      throw new Error(`Run state ${stateFile} has duplicate phase indices or names.`);
    }
    indices.add(phase.index);
    names.add(phase.name);
  }
  if (state.dynamicWorkflow !== undefined && (!state.dynamicWorkflow || typeof state.dynamicWorkflow !== "object" || Array.isArray(state.dynamicWorkflow))) {
    throw new Error(`Run state ${stateFile} has invalid dynamic workflow provenance.`);
  }
  if (state.supervision !== undefined) validateHistoricalSupervisionBinding(state.supervision, stateFile);
  return state as RunStateFile;
}

function validateHistoricalSupervisionBinding(value: unknown, label: string): asserts value is HistoricalSupervisionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Run state ${label} has invalid supervision metadata.`);
  const binding = value as Partial<HistoricalSupervisionBinding>;
  if (
    binding.schemaVersion !== 1 ||
    (binding.mode !== "visible-main" && binding.mode !== "off") ||
    !new Set(["read-only", "executor-bearing", "mutating"]).has(String(binding.classification))
  ) {
    throw new Error(`Run state ${label} has invalid supervision metadata.`);
  }
  if (binding.identity !== undefined) validateProtocolIdentity(binding.identity, label);
  if (binding.cursor !== undefined) {
    const cursor = binding.cursor as Partial<GenericSupervisionCursor>;
    if (
      !cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
      cursor.schemaVersion !== 1 ||
      !new Set(["plan", "executor-task", "verifier", "terminal"]).has(String(cursor.stage)) ||
      !Number.isSafeInteger(cursor.nextTaskIndex) || Number(cursor.nextTaskIndex) < 0 ||
      !Array.isArray(cursor.completedTaskIds) || cursor.completedTaskIds.some((id) => typeof id !== "string" || !id.trim()) ||
      new Set(cursor.completedTaskIds).size !== cursor.completedTaskIds.length ||
      (cursor.currentTaskId !== undefined && (typeof cursor.currentTaskId !== "string" || !cursor.currentTaskId.trim())) ||
      (cursor.lastCheckpointId !== undefined && (typeof cursor.lastCheckpointId !== "string" || !cursor.lastCheckpointId.trim()))
    ) {
      throw new Error(`Run state ${label} has an invalid generic supervision cursor.`);
    }
    validateProtocolIdentity(cursor.identity, label);
    if (binding.identity && JSON.stringify(binding.identity) !== JSON.stringify(cursor.identity)) {
      throw new Error(`Run state ${label} has mismatched supervision cursor identity.`);
    }
  }
}

function validateProtocolIdentity(value: unknown, label: string): asserts value is GenericSupervisionProtocolIdentity {
  const identity = value as Partial<GenericSupervisionProtocolIdentity> | undefined;
  if (
    !identity || typeof identity !== "object" || Array.isArray(identity) ||
    identity.protocolId !== "host-task-boundary-v1" ||
    identity.adapterVersion !== 1 ||
    typeof identity.adapterId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(identity.adapterId)
  ) {
    throw new Error(`Run state ${label} has an invalid supervision protocol identity.`);
  }
}

export function listKnownRuns(): string[] {
  const root = runsRootDir();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((entry) => existsSync(path.join(root, entry, "state.json")))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** True when the given PID refers to a live process. */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to obtain the result of a detached survivor phase: read its result file
 * if present; otherwise, while its PID is alive, poll for the result file
 * (10 s interval, bounded at 25 min to stay inside the observed ~40 min
 * tool-call abort window). Returns undefined when the survivor is dead with
 * no result (caller respawns the phase). Throws when the polling budget is
 * exhausted while the survivor still runs (caller should resume again later).
 */
export async function collectSurvivorResult<TResult>(
  survivor: { pid: number | undefined; resultFile: string; phaseName: string },
  emit: (text: string) => void,
  signal: AbortSignal | undefined,
  label: string,
): Promise<TResult | undefined> {
  const POLL_INTERVAL_MS = 10_000;
  const POLL_BUDGET_MS = 25 * 60_000;
  const deadline = Date.now() + POLL_BUDGET_MS;

  const readResult = (): TResult | undefined => {
    if (!existsSync(survivor.resultFile)) return undefined;
    try {
      return JSON.parse(readFileSync(survivor.resultFile, "utf8")) as TResult;
    } catch {
      return undefined;
    }
  };

  const immediate = readResult();
  if (immediate) {
    emit(`${label}: survivor phase ${survivor.phaseName} result collected from ${survivor.resultFile}.`);
    return immediate;
  }
  if (!isPidAlive(survivor.pid)) return undefined;

  emit(`${label}: survivor phase ${survivor.phaseName} still running (pid=${survivor.pid}); polling for its result (up to 25 min).`);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Orchestration aborted.");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const result = readResult();
    if (result) {
      emit(`${label}: survivor phase ${survivor.phaseName} completed while polling.`);
      return result;
    }
    if (!isPidAlive(survivor.pid)) {
      // Give the background writer one grace beat, then final read.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return readResult();
    }
  }
  throw new Error(
    `Survivor phase ${survivor.phaseName} (pid=${survivor.pid}) is still running after the 25 min polling budget. ` +
      `Re-invoke resume later to continue waiting.`,
  );
}
