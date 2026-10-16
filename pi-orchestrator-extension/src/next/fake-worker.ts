import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  CancelResult,
  EffectRecord,
  EffectStatus,
  FailureCategory,
  JsonValue,
  ResumeRequest,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEvent,
  WorkerInspection,
  WorkerRequest,
} from "./types";

export interface FakeMutation {
  path: string;
  content: string;
  kind?: "created" | "modified";
}

export interface FakeAttemptScript {
  delayMs?: number;
  /** Set false to model a launch failure before a child/worker exists. */
  emitStarted?: boolean;
  /** Effects visible only through inspect(), modeling missed stream events. */
  inspectionEffects?: EffectRecord[];
  mutations?: FakeMutation[];
  events: Array<
    | { type: "progress"; message: string }
    | { type: "effect"; effect: EffectRecord }
    | { type: "result"; output: JsonValue; exitCode: number; signal?: string }
    | { type: "failed"; category: FailureCategory; message: string; exitCode?: number | null }
  >;
}

export interface FakeWorkerStats {
  starts: number;
  active: number;
  maxActive: number;
  byPhase: Record<string, number>;
}

interface RuntimeRecord {
  state: WorkerInspection["state"];
  effects: EffectStatus;
  output?: JsonValue;
}

/** Scriptable adapter used to prove kernel behavior without an LLM process. */
export class FakeWorkerAdapter implements WorkerAdapter {
  readonly #scripts: Record<string, FakeAttemptScript[]>;
  readonly #records = new Map<string, RuntimeRecord>();
  readonly stats: FakeWorkerStats = { starts: 0, active: 0, maxActive: 0, byPhase: {} };

  constructor(scripts: Record<string, FakeAttemptScript[]>) {
    this.#scripts = scripts;
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return {
      adapter: "fake-worker-v1",
      phaseKinds: ["agent", "deterministic-command"],
      accessModes: ["read-only", "workspace-write"],
      structuredOutput: true,
      inspect: true,
      cancel: true,
    };
  }

  async *start(request: WorkerRequest): AsyncIterable<WorkerEvent> {
    const scripts = this.#scripts[request.phase.id] ?? [];
    const script = scripts[request.attempt - 1];
    if (!script) {
      yield { type: "failed", category: "internal-error", message: `No fake script for ${request.phase.id} attempt ${request.attempt}` };
      return;
    }
    this.stats.starts += 1;
    this.stats.active += 1;
    this.stats.maxActive = Math.max(this.stats.maxActive, this.stats.active);
    this.stats.byPhase[request.phase.id] = (this.stats.byPhase[request.phase.id] ?? 0) + 1;
    const hiddenEffects = script.inspectionEffects ?? [];
    const runtime: RuntimeRecord = {
      state: "running",
      effects: hiddenEffects.length
        ? { status: "observed", mutations: hiddenEffects.map((effect) => ({ ...effect })) }
        : { status: "none", mutations: [] },
    };
    this.#records.set(request.workerRunId, runtime);
    try {
      if (script.emitStarted !== false) yield { type: "started", workerRunId: request.workerRunId };
      if (script.delayMs) await abortableDelay(script.delayMs, request.signal);
      for (const mutation of script.mutations ?? []) {
        const absolute = containedPath(request.workspaceRoot, mutation.path);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, mutation.content, "utf8");
        const effect: EffectRecord = { path: mutation.path.replace(/\\/g, "/"), kind: mutation.kind ?? "created" };
        runtime.effects.status = "observed";
        runtime.effects.mutations.push(effect);
        yield { type: "effect", effect };
      }
      for (const event of script.events) {
        if (request.signal?.aborted) throw new Error("cancelled");
        if (event.type === "effect") {
          runtime.effects.status = "observed";
          runtime.effects.mutations.push(event.effect);
        } else if (event.type === "result") {
          runtime.state = event.exitCode === 0 ? "completed" : "failed";
          runtime.output = event.output;
        } else if (event.type === "failed") {
          runtime.state = "failed";
        }
        yield event as WorkerEvent;
      }
      if (runtime.state === "running") runtime.state = "failed";
    } catch (error) {
      runtime.state = "failed";
      if (request.signal?.aborted) yield { type: "failed", category: "cancelled", message: "fake worker cancelled" };
      else yield { type: "failed", category: "internal-error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.stats.active -= 1;
    }
  }

  resume(request: ResumeRequest): AsyncIterable<WorkerEvent> {
    return this.start({ ...request, input: {}, signal: request.signal });
  }

  async cancel(workerRunId: string): Promise<CancelResult> {
    const record = this.#records.get(workerRunId);
    if (record?.state === "running") record.state = "failed";
    return { workerRunId, cancelled: Boolean(record) };
  }

  async inspect(workerRunId: string): Promise<WorkerInspection> {
    const record = this.#records.get(workerRunId);
    if (!record) return { workerRunId, state: "unknown", effects: { status: "unsupported", mutations: [] } };
    return {
      workerRunId,
      state: record.state,
      effects: JSON.parse(JSON.stringify(record.effects)) as EffectStatus,
      ...(record.output === undefined ? {} : { output: JSON.parse(JSON.stringify(record.output)) as JsonValue }),
    };
  }
}

function containedPath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe fake mutation path: ${JSON.stringify(relative)}`);
  }
  const canonicalRoot = path.resolve(root);
  const candidate = path.resolve(canonicalRoot, relative);
  const relation = path.relative(canonicalRoot, candidate);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Fake mutation escapes workspace: ${relative}`);
  }
  return candidate;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    }, { once: true });
  });
}
