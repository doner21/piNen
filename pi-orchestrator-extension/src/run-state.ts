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

export type PhaseStatus = "done" | "detached" | "pending";

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
  /** Absolute run directory. */
  runDir: string;
}

// ── Store ──────────────────────────────────────────────────────────────────

export function runsRootDir(): string {
  return path.join(os.homedir(), ".pi", "pi-orchestrator-extension", "runs-state");
}

export function runDirFor(runId: string): string {
  // Defensive: forbid path traversal in externally-supplied resume ids.
  const safe = String(runId).replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(runsRootDir(), safe);
}

function phaseFileName(index: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `phase-${index}-${safe}.json`;
}

function survivorFileName(index: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `survivor-${index}-${safe}.json`;
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
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as RunStateFile;
    const checkpoints = new Map<number, SubagentResult>();
    const survivors = new Map<number, SurvivorManifest>();
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
    }
    return { state, checkpoints, survivors, runDir };
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

  survivorResultPath(index: number, name: string): string {
    return path.join(this.runDir, survivorResultFileName(index, name));
  }

  survivorManifestPath(index: number, name: string): string {
    return path.join(this.runDir, survivorFileName(index, name));
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
