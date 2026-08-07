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

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SubagentResult } from "./substrate";

// ── Types ──────────────────────────────────────────────────────────────────

export type PhaseStatus = "done" | "detached" | "pending" | "ambiguous-completion";

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

function phaseFileName(index: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `phase-${index}-${safe}.json`;
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
  ): RunStateStore {
    const runDir = runDirFor(runId);
    mkdirSync(runDir, { recursive: true });
    const state: RunStateFile = {
      runId,
      paradigm,
      task,
      createdAt: new Date().toISOString(),
      params,
      phases: phaseNames.map((name, index) => ({ index, name, status: "pending" as PhaseStatus })),
      ...(dynamicWorkflow ? { dynamicWorkflow } : {}),
    };
    const store = new RunStateStore(runDir, state);
    store.persist();
    return store;
  }

  /** Load a previously persisted run (throws with a clear message when absent). */
  static load(runId: string): LoadedRunState {
    const runDir = runDirFor(runId);
    const stateFile = path.join(runDir, "state.json");
    if (!existsSync(stateFile)) {
      throw new Error(
        `Resume state not found for run "${runId}" (expected ${stateFile}). ` +
          `Known runs: ${listKnownRuns().slice(0, 10).join(", ") || "(none)"}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch (error) {
      throw new Error(`Run state ${stateFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = validateLoadedRunState(parsed, runId, stateFile);
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

  checkpointPhase(index: number, name: string, result: SubagentResult): void {
    writeFileSync(path.join(this.runDir, phaseFileName(index, name)), JSON.stringify(result, null, 2), "utf8");
    this.setStatus(index, name, "done");
  }

  markDetached(index: number, name: string, manifest: SurvivorManifest): void {
    writeFileSync(path.join(this.runDir, survivorFileName(index, name)), JSON.stringify(manifest, null, 2), "utf8");
    this.setStatus(index, name, "detached");
  }

  markTerminalNoRetry(index: number, name: string, state: TerminalNoRetryState, candidate?: SubagentResult): TerminalNoRetryState {
    let candidateResultFile = state.candidateResultFile;
    if (candidate) {
      candidateResultFile = candidateResultFile ?? this.terminalCandidatePath(index, name);
      writeFileSync(candidateResultFile, JSON.stringify(candidate, null, 2), "utf8");
    }
    const payload: TerminalNoRetryState = {
      ...state,
      phaseName: name,
      phaseIndex: index,
      retryAllowed: false,
      runId: this.state.runId,
      ...(candidateResultFile ? { candidateResultFile } : {}),
    };
    writeFileSync(path.join(this.runDir, terminalStateFileName(index, name)), JSON.stringify(payload, null, 2), "utf8");
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
    writeFileSync(path.join(this.runDir, "state.json"), JSON.stringify(this.state, null, 2), "utf8");
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
  return state as RunStateFile;
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
