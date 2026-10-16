import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  SubagentDetachedError,
  SubagentTerminalAmbiguousError,
  spawnSubagent,
  type AgentProfile,
  type SubagentResult,
} from "../substrate";
import type {
  CancelResult,
  FailureCategory,
  JsonValue,
  ResumeRequest,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEvent,
  WorkerInspection,
  WorkerPublication,
  WorkerRequest,
} from "./types";
import { HashWorkspaceObserver, type WorkspaceObserver, type WorkspaceSnapshot } from "./workspace-observer";

export interface PiSubprocessWorkerOptions {
  agents: Map<string, AgentProfile>;
  allowLocalModel: boolean;
  inheritedModel?: { provider?: string; model?: string };
  onProgress?: (message: string) => void;
  workspaceObserver?: WorkspaceObserver;
  /** Host-owned durable run directory for survivor manifests/results. */
  runDirectory?: string;
}

/** Real Pi JSON-subprocess adapter behind the v2 WorkerAdapter boundary. */
export class PiSubprocessWorkerAdapter implements WorkerAdapter {
  readonly #options: PiSubprocessWorkerOptions;
  readonly #observer: WorkspaceObserver;
  readonly #inspections = new Map<string, WorkerInspection>();
  readonly #workerDirectory?: string;

  constructor(options: PiSubprocessWorkerOptions) {
    this.#options = options;
    this.#observer = options.workspaceObserver ?? new HashWorkspaceObserver({
      maxEntries: 50_000,
      maxBytes: 1024 * 1024 * 1024,
    });
    if (options.runDirectory) {
      this.#workerDirectory = path.resolve(options.runDirectory, "workers");
      mkdirSync(this.#workerDirectory, { recursive: true });
    }
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return {
      adapter: "pi-json-subprocess-v2",
      phaseKinds: ["agent"],
      accessModes: ["read-only", "workspace-write"],
      structuredOutput: true,
      inspect: true,
      cancel: false,
    };
  }

  async *start(request: WorkerRequest): AsyncIterable<WorkerEvent> {
    const agent = request.phase.agent;
    if (!agent || request.phase.kind !== "agent") {
      yield { type: "failed", category: "capability-mismatch", message: "Pi adapter requires an agent phase contract" };
      return;
    }

    let before: WorkspaceSnapshot | undefined;
    if (request.phase.access === "workspace-write") {
      before = this.#observer.capture(request.workspaceRoot);
      if (!before.ok) {
        this.#record(request.workerRunId, "failed", { status: "unsupported", mutations: [] });
        yield { type: "failed", category: "effects-unobservable", message: before.error };
        return;
      }
    }

    const publication = this.#publicationFor(request.workerRunId);
    yield { type: "started", workerRunId: request.workerRunId };
    const routes = [
      { provider: agent.provider, model: agent.model },
      ...(agent.fallbacks ?? []).map((route) => ({
        provider: route.provider ?? agent.provider,
        model: route.model ?? agent.model,
      })),
    ];
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      try {
        const result = await spawnSubagent(
          agent.name,
          buildPiPhasePrompt(request),
          {
            agents: phaseAgentProfiles(this.#options.agents, agent.name, request.phase.access),
            cwd: request.workspaceRoot,
            allowLocalModel: this.#options.allowLocalModel,
            signal: request.signal,
            inheritedModel: this.#options.inheritedModel,
            modelOverride: {
              ...(route.provider ? { provider: route.provider } : {}),
              ...(route.model ? { model: route.model } : {}),
            },
            onProgress: this.#options.onProgress,
            phaseMutates: request.phase.access === "workspace-write",
            ...(publication ? {
              abortSurvival: {
                resultFile: publication.resultFile,
                manifestFile: publication.manifestFile,
                phaseName: request.phase.id,
                phaseIndex: request.attempt,
                shouldDetach: (reason: unknown) => isParentAbortReason(reason),
              },
            } : {}),
          },
        );

        const effects = this.#observeAfter(request, before);
        this.#record(request.workerRunId, "completed", effects, { exitCode: result.exitCode, ...(publication ? { publication } : {}) });
        for (const effect of effects.mutations) yield { type: "effect", effect };
        if (effects.status === "unsupported") {
          yield { type: "failed", category: "effects-unobservable", message: "Pi worker completed but post-run workspace effects could not be observed", exitCode: result.exitCode };
          return;
        }

        const parsed = parseStructuredWorkerOutput(result.text);
        if (!parsed.ok) {
          this.#record(request.workerRunId, "failed", effects, { exitCode: result.exitCode, ...(publication ? { publication } : {}), error: parsed.error });
          yield { type: "failed", category: "protocol-failure", message: parsed.error, exitCode: result.exitCode };
          return;
        }
        this.#inspections.set(request.workerRunId, {
          workerRunId: request.workerRunId,
          state: result.exitCode === 0 ? "completed" : "failed",
          effects,
          output: parsed.output,
          exitCode: result.exitCode,
          ...(publication ? { publication } : {}),
        });
        yield { type: "result", output: parsed.output, exitCode: result.exitCode ?? 0, ...(publication ? { publication } : {}) };
        return;
      } catch (error) {
        const effects = this.#observeAfter(request, before);
        if (error instanceof SubagentDetachedError) {
          const detachedPublication: WorkerPublication = {
            manifestFile: publication?.manifestFile ?? "",
            resultFile: error.manifest.resultFile,
            ...(error.manifest.pid === undefined ? {} : { pid: error.manifest.pid }),
          };
          this.#record(request.workerRunId, "running", effects, { publication: detachedPublication });
          for (const effect of effects.mutations) yield { type: "effect", effect };
          yield { type: "failed", category: "detached-survivor", message: error.message, publication: detachedPublication };
          return;
        }
        if (error instanceof SubagentTerminalAmbiguousError) {
          let candidate: JsonValue | undefined;
          if (error.info.candidate?.text) {
            const parsed = parseStructuredWorkerOutput(error.info.candidate.text);
            if (parsed.ok) candidate = parsed.output;
            if (publication?.candidateFile) writeJsonAtomic(publication.candidateFile, error.info.candidate);
          }
          this.#inspections.set(request.workerRunId, {
            workerRunId: request.workerRunId,
            state: "failed",
            effects,
            ...(candidate === undefined ? {} : { output: candidate }),
            exitCode: error.info.exitCode,
            ...(publication ? { publication } : {}),
            error: error.message,
          });
          for (const effect of effects.mutations) yield { type: "effect", effect };
          yield {
            type: "failed",
            category: "candidate-result-preserved",
            message: error.message,
            exitCode: error.info.exitCode,
            ...(publication ? { publication } : {}),
            ...(candidate === undefined ? {} : { candidate }),
          };
          return;
        }
        const classified = classifyPiWorkerError(error, request.signal);
        const safeFallback = effects.status === "none"
          && (classified.category === "provider-transient" || classified.category === "capability-mismatch")
          && routeIndex + 1 < routes.length;
        if (safeFallback) {
          const nextRoute = routes[routeIndex + 1];
          this.#options.onProgress?.(
            `Pi worker ${request.phase.id}: route ${formatRoute(route)} failed (${classified.category}); falling back to ${formatRoute(nextRoute)}.`,
          );
          continue;
        }
        this.#record(request.workerRunId, "failed", effects, { ...(publication ? { publication } : {}), error: classified.message });
        for (const effect of effects.mutations) yield { type: "effect", effect };
        yield { type: "failed", category: classified.category, message: classified.message, ...(publication ? { publication } : {}) };
        return;
      }
    }
  }

  async *resume(request: ResumeRequest): AsyncIterable<WorkerEvent> {
    const inspection = await this.inspect(request.workerRunId);
    if (inspection.state === "completed" && inspection.output !== undefined && Number.isInteger(inspection.exitCode)) {
      yield {
        type: "result",
        output: inspection.output,
        exitCode: inspection.exitCode!,
        ...(inspection.signal ? { signal: inspection.signal } : {}),
        ...(inspection.publication ? { publication: inspection.publication } : {}),
      };
      return;
    }
    yield {
      type: "failed",
      category: inspection.state === "running" ? "result-file-pending" : "protocol-failure",
      message: `Pi worker ${request.workerRunId} cannot yet be resumed (${inspection.state})`,
      ...(inspection.publication ? { publication: inspection.publication } : {}),
    };
  }

  async cancel(workerRunId: string): Promise<CancelResult> {
    return { workerRunId, cancelled: false };
  }

  async inspect(workerRunId: string): Promise<WorkerInspection> {
    const publication = this.#publicationFor(workerRunId);
    if (publication?.resultFile && existsSync(publication.resultFile)) {
      try {
        if (!existsSync(publication.manifestFile)) throw new Error("published result has no survivor manifest");
        const manifest = readSurvivorManifest(publication);
        if (statSync(publication.resultFile).size > 16 * 1024 * 1024) throw new Error("published result exceeds 16 MiB");
        const result = JSON.parse(readFileSync(publication.resultFile, "utf8")) as Partial<SubagentResult>;
        if (typeof result.text !== "string" || !(result.exitCode === null || Number.isInteger(result.exitCode))) {
          throw new Error("published result does not match SubagentResult");
        }
        const parsed = parseStructuredWorkerOutput(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        const memory = this.#inspections.get(workerRunId);
        return {
          workerRunId,
          state: "completed",
          effects: memory?.effects ?? { status: "unsupported", mutations: [] },
          output: parsed.output,
          exitCode: result.exitCode,
          publication: { ...publication, pid: manifest.pid },
        };
      } catch (error) {
        return {
          workerRunId,
          state: "failed",
          effects: this.#inspections.get(workerRunId)?.effects ?? { status: "unsupported", mutations: [] },
          publication,
          error: `invalid durable Pi result: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (publication?.candidateFile && existsSync(publication.candidateFile)) {
      try {
        if (statSync(publication.candidateFile).size > 16 * 1024 * 1024) throw new Error("preserved candidate exceeds 16 MiB");
        const candidate = JSON.parse(readFileSync(publication.candidateFile, "utf8")) as Partial<SubagentResult>;
        if (typeof candidate.text !== "string" || !(candidate.exitCode === null || Number.isInteger(candidate.exitCode))) {
          throw new Error("preserved candidate does not match SubagentResult");
        }
        const parsed = parseStructuredWorkerOutput(candidate.text);
        return {
          workerRunId,
          state: "failed",
          effects: this.#inspections.get(workerRunId)?.effects ?? { status: "unsupported", mutations: [] },
          ...(parsed.ok ? { output: parsed.output } : {}),
          exitCode: candidate.exitCode,
          publication,
          error: parsed.ok ? "ambiguous candidate preserved for inspection; automatic promotion is forbidden" : parsed.error,
        };
      } catch (error) {
        return {
          workerRunId,
          state: "failed",
          effects: this.#inspections.get(workerRunId)?.effects ?? { status: "unsupported", mutations: [] },
          publication,
          error: `invalid preserved candidate: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (publication?.manifestFile && existsSync(publication.manifestFile)) {
      try {
        const manifest = readSurvivorManifest(publication);
        const withPid = { ...publication, pid: manifest.pid };
        if (processIsAlive(manifest.pid)) {
          return {
            workerRunId,
            state: "running",
            effects: this.#inspections.get(workerRunId)?.effects ?? { status: "unsupported", mutations: [] },
            publication: withPid,
          };
        }
        return {
          workerRunId,
          state: "failed",
          effects: this.#inspections.get(workerRunId)?.effects ?? { status: "unsupported", mutations: [] },
          publication: withPid,
          error: "survivor process exited without publishing a durable result",
        };
      } catch (error) {
        return {
          workerRunId,
          state: "failed",
          effects: { status: "unsupported", mutations: [] },
          publication,
          error: `invalid survivor manifest: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return this.#inspections.get(workerRunId) ?? {
      workerRunId,
      state: "unknown",
      effects: { status: "unsupported", mutations: [] },
      ...(publication ? { publication } : {}),
    };
  }

  #publicationFor(workerRunId: string): WorkerPublication | undefined {
    if (!this.#workerDirectory) return undefined;
    const key = createHash("sha256").update(workerRunId).digest("hex");
    const directory = path.join(this.#workerDirectory, key);
    mkdirSync(directory, { recursive: true });
    return {
      manifestFile: path.join(directory, "survivor.manifest.json"),
      resultFile: path.join(directory, "result.json"),
      candidateFile: path.join(directory, "candidate.json"),
    };
  }

  #observeAfter(request: WorkerRequest, before: WorkspaceSnapshot | undefined): WorkerInspection["effects"] {
    if (request.phase.access === "read-only") return { status: "none", mutations: [] };
    if (!before?.ok) return { status: "unsupported", mutations: [] };
    const after = this.#observer.capture(request.workspaceRoot);
    if (!after.ok) return { status: "unsupported", mutations: [] };
    const mutations = this.#observer.diff(before, after);
    return mutations.length ? { status: "observed", mutations } : { status: "none", mutations: [] };
  }

  #record(
    workerRunId: string,
    state: WorkerInspection["state"],
    effects: WorkerInspection["effects"],
    extra: Partial<Omit<WorkerInspection, "workerRunId" | "state" | "effects">> = {},
  ): void {
    this.#inspections.set(workerRunId, { workerRunId, state, effects, ...extra });
  }
}

export type StructuredParseResult =
  | { ok: true; output: JsonValue }
  | { ok: false; error: string };

/** One strict parser for every Pi worker terminal response. */
export function parseStructuredWorkerOutput(text: string): StructuredParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Pi worker returned an empty terminal response" };
  let output: unknown;
  try {
    output = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: `Pi worker terminal response is not exact JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (output === undefined || typeof output === "function" || typeof output === "symbol" || typeof output === "bigint") {
    return { ok: false, error: "Pi worker terminal response is not a JSON value" };
  }
  return { ok: true, output: output as JsonValue };
}

function phaseAgentProfiles(
  source: Map<string, AgentProfile>,
  agentName: string,
  access: "read-only" | "workspace-write",
): Map<string, AgentProfile> {
  const profiles = new Map(source);
  const existing = profiles.get(agentName) ?? { name: agentName };
  profiles.set(agentName, {
    ...existing,
    // Read-only means no tool capability, not merely an instruction in prose.
    ...(access === "read-only" ? { tools: [], skills: [] } : {}),
  });
  return profiles;
}

function buildPiPhasePrompt(request: WorkerRequest): string {
  return [
    `ORCHESTRATOR NEXT V2 PHASE: ${request.phase.id}`,
    `Role: ${request.phase.role ?? request.phase.agent?.name ?? "worker"}`,
    `Access: ${request.phase.access}`,
    `Workspace mode: ${request.phase.workspace.mode}`,
    "Complete only this phase. Do not invoke orchestration or delegate to another agent.",
    request.phase.access === "read-only"
      ? "You have no tools. Reason only from the supplied typed input. Do not claim to have inspected anything not present in that input."
      : request.phase.workspace.mode === "isolated"
        ? "Use the available tools to complete product work in this disposable candidate copy. Do not access parent paths. The host will integrate conflict-checked changes only after your phase succeeds."
        : "Use the available tools to complete the requested product work in the current workspace before producing your terminal result.",
    `Typed phase input:\n${JSON.stringify(request.input, null, 2)}`,
    outputContract(request.phase.outputSchema),
    "Your final assistant message MUST contain exactly one JSON value and nothing else: no Markdown fence, preface, or trailing commentary.",
  ].join("\n\n");
}

function outputContract(schema: string): string {
  switch (schema) {
    case "informational-v1":
      return 'Output schema informational-v1: {"summary":"non-empty string","data":{}}. `data` may be any JSON value.';
    case "plan-v1":
      return 'Output schema plan-v1: {"summary":"string","steps":["actionable step"]}.';
    case "implementation-v1":
      return 'Output schema implementation-v1: {"summary":"string","files":["relative/path"],"tests":["command/result"]}.';
    case "verification-v1":
      return 'Output schema verification-v1: {"status":"pass|fail","summary":"string","checks":[{"id":"string","status":"pass|fail","evidence":["specific evidence"]}],"remaining":["unresolved item"]}. Use status=fail if evidence is insufficient.';
    default:
      return `Return strict JSON satisfying registered schema ${schema}.`;
  }
}

function formatRoute(route: { provider?: string; model?: string }): string {
  return `${route.provider ?? "default"}/${route.model ?? "default"}`;
}

export function classifyPiWorkerError(error: unknown, signal?: AbortSignal): { category: FailureCategory; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SubagentDetachedError) return { category: "detached-survivor", message };
  if (error instanceof SubagentTerminalAmbiguousError) return { category: "candidate-result-preserved", message };
  if (signal?.aborted || /\baborted\b|\bcancelled\b/i.test(message)) return { category: "cancelled", message };
  if (/\b402\b|insufficient balance|payment required|billing/i.test(message)) {
    return { category: "capability-mismatch", message };
  }
  if (/\b429\b|rate.?limit|overload|temporar|fetch failed|ECONNRESET|ETIMEDOUT|WebSocket/i.test(message)) {
    return { category: "provider-transient", message };
  }
  if (/\bspawn\b|ENOENT|EPERM|EACCES|did not launch|first_json_timeout/i.test(message)) {
    return { category: "launch-failure", message };
  }
  return { category: "protocol-failure", message };
}

function isParentAbortReason(reason: unknown): boolean {
  return Boolean(reason) && typeof reason === "object" && (reason as { code?: unknown }).code === "ORCN_PARENT_ABORT";
}

function readSurvivorManifest(publication: WorkerPublication): { pid: number } {
  const manifest = JSON.parse(readFileSync(publication.manifestFile, "utf8")) as { pid?: unknown; resultFile?: unknown };
  if (!Number.isInteger(manifest.pid) || (manifest.pid as number) < 1 || manifest.resultFile !== publication.resultFile) {
    throw new Error("invalid survivor manifest identity");
  }
  return { pid: manifest.pid as number };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}
