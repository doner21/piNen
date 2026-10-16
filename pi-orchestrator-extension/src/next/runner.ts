import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentProfile } from "../substrate";
import { CommandWorkerAdapter } from "./command-worker";
import { compileWorkflow, stableStringify } from "./compiler";
import { FileEventStore, projectRun } from "./event-store";
import { RunKernel } from "./kernel";
import { readOnlyFanoutJoinPilot, singleWriterPevWorkflow } from "./pilots";
import { PiSubprocessWorkerAdapter } from "./pi-worker";
import type { CompiledWorkflow, KernelResult, RunEvent, RunProjection, WorkflowSpec, WorkerInspection } from "./types";
import { SnapshotWorkspaceManager } from "./workspace-manager";

export type OrchestratorNextWorkflow = "read-only-fanout-join" | "single-writer-pev";
export type OrchestratorNextAction = "run" | "resume" | "inspect";

export interface OrchestratorNextRunParams {
  action?: OrchestratorNextAction;
  task?: string;
  workflow?: OrchestratorNextWorkflow;
  cwd?: string;
  runId?: string;
  /** Compatibility alias for action=resume. */
  resume?: boolean;
  runsRoot?: string;
  allowLocalModel?: boolean;
  concurrency?: number;
  plannerAgent?: string;
  executorAgent?: string;
  verifierAgent?: string;
  plannerProvider?: string;
  plannerModel?: string;
  plannerFallbackProvider?: string;
  plannerFallbackModel?: string;
  executorProvider?: string;
  executorModel?: string;
  executorFallbackProvider?: string;
  executorFallbackModel?: string;
  verifierProvider?: string;
  verifierModel?: string;
  verifierFallbackProvider?: string;
  verifierFallbackModel?: string;
  /** Required only for internal initial single-writer-pev calls. */
  testExecutable?: string;
  testArgs?: string[];
  testCwd?: string;
  testTimeoutMs?: number;
}

export interface OrchestratorNextRunDependencies {
  agents: Map<string, AgentProfile>;
  inheritedModel?: { provider?: string; model?: string };
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onEvent?: (event: unknown) => void;
}

export interface OrchestratorNextRunResult {
  markdown: string;
  details: KernelResult & {
    workflow: OrchestratorNextWorkflow;
    runDirectory: string;
    eventLog: string;
  };
}

export interface OrchestratorNextInspectResult {
  markdown: string;
  details: {
    action: "inspect";
    runId: string;
    status: RunProjection["status"];
    workflow: OrchestratorNextWorkflow;
    workflowHash: string;
    runDirectory: string;
    eventLog: string;
    projection: RunProjection;
    workers: Record<string, WorkerInspection>;
  };
}

export type OrchestratorNextResult = OrchestratorNextRunResult | OrchestratorNextInspectResult;

/** Runnable v2 entry point used by the Pi tool and direct integration tests. */
export async function runOrchestratorNext(
  params: OrchestratorNextRunParams,
  dependencies: OrchestratorNextRunDependencies,
): Promise<OrchestratorNextResult> {
  const action: OrchestratorNextAction = params.action ?? (params.resume ? "resume" : "run");
  const runsRoot = path.resolve(
    params.runsRoot
      ?? process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT?.trim()
      ?? defaultNextRunsRoot(),
  );

  if (action === "inspect") return inspectOrchestratorNext(params, dependencies, runsRoot);

  let runId: string;
  let task: string;
  let workflow: OrchestratorNextWorkflow;
  let cwd: string;
  let compiled: CompiledWorkflow;
  let store: FileEventStore;
  let runtimePolicy: Record<string, import("./types").JsonValue>;
  let effectiveInheritedModel = dependencies.inheritedModel;
  let effectiveAllowLocalModel = params.allowLocalModel ?? false;

  if (action === "resume") {
    runId = requireRunId(params.runId);
    const pinned = loadPinnedRun(runsRoot, runId);
    task = pinned.task;
    workflow = pinned.workflow;
    cwd = pinned.cwd;
    compiled = pinned.compiled;
    assertResumeOverridesMatch(params, pinned);
    assertRunsRootOutsideWorkspace(cwd, runsRoot);
    effectiveAllowLocalModel = typeof pinned.runtimePolicy.allowLocalModel === "boolean" ? pinned.runtimePolicy.allowLocalModel : false;
    effectiveInheritedModel = {
      ...(typeof pinned.runtimePolicy.inheritedProvider === "string" && pinned.runtimePolicy.inheritedProvider ? { provider: pinned.runtimePolicy.inheritedProvider } : {}),
      ...(typeof pinned.runtimePolicy.inheritedModel === "string" && pinned.runtimePolicy.inheritedModel ? { model: pinned.runtimePolicy.inheritedModel } : {}),
    };
    runtimePolicy = Object.keys(pinned.runtimePolicy).length
      ? runtimePolicyFor(compiled, dependencies.agents, effectiveAllowLocalModel, effectiveInheritedModel)
      : {};
    store = FileEventStore.open(runsRoot, runId);
  } else {
    task = String(params.task ?? "").trim();
    if (!task) throw new Error("orchestrate_next run requires a non-empty task");
    if (!params.workflow) throw new Error("orchestrate_next run requires workflow");
    workflow = params.workflow;
    cwd = path.resolve(params.cwd ?? process.cwd());
    runId = params.runId?.trim() || nextRunId();
    assertRunsRootOutsideWorkspace(cwd, runsRoot);
    const source = buildWorkflow(params, workflow);
    applyRoutesAndAgents(source, params);
    resolveAgentRoutes(source, dependencies.agents, dependencies.inheritedModel);
    if (params.concurrency !== undefined) {
      if (!Number.isInteger(params.concurrency) || params.concurrency < 1 || params.concurrency > 16) {
        throw new Error("orchestrate_next concurrency must be an integer from 1 through 16");
      }
      source.limits = { ...(source.limits ?? {}), maxConcurrency: params.concurrency };
    }
    compiled = compileWorkflow(source);
    runtimePolicy = runtimePolicyFor(compiled, dependencies.agents, effectiveAllowLocalModel, effectiveInheritedModel);
    store = FileEventStore.create(runsRoot, runId);
  }

  try {
    const runDirectory = path.dirname(store.filePath);
    const pinnedValidator = workflow === "single-writer-pev"
      ? preparePinnedValidator(compiled, cwd, runDirectory, action === "resume")
      : undefined;
    if (pinnedValidator) runtimePolicy.validatorSha256 = pinnedValidator.sha256;
    const agentAdapter = new PiSubprocessWorkerAdapter({
      agents: dependencies.agents,
      allowLocalModel: effectiveAllowLocalModel,
      inheritedModel: effectiveInheritedModel,
      onProgress: dependencies.onProgress,
      runDirectory,
    });
    const commandAdapter = workflow === "single-writer-pev"
      ? commandAdapterForCompiled(compiled, pinnedValidator!)
      : undefined;
    const workspaceManager = new SnapshotWorkspaceManager({ runDirectory });
    const kernel = new RunKernel();
    const result = await kernel.run(compiled, {
      runId,
      workspaceRoot: cwd,
      input: { task },
      runtimePolicy,
      eventStore: store,
      agentAdapter,
      ...(commandAdapter ? { commandAdapter } : {}),
      workspaceManager,
      signal: dependencies.signal,
      onEvent: (event) => {
        dependencies.onEvent?.(event);
        dependencies.onProgress?.(formatEventProgress(event));
      },
    });
    const details: OrchestratorNextRunResult["details"] = {
      ...result,
      workflow,
      runDirectory,
      eventLog: store.filePath,
    };
    return { markdown: renderNextResult(details), details };
  } finally {
    store.close();
  }
}

async function inspectOrchestratorNext(
  params: OrchestratorNextRunParams,
  dependencies: OrchestratorNextRunDependencies,
  runsRoot: string,
): Promise<OrchestratorNextInspectResult> {
  const runId = requireRunId(params.runId);
  const pinned = loadPinnedRun(runsRoot, runId);
  assertResumeOverridesMatch(params, pinned);
  const view = FileEventStore.read(runsRoot, runId);
  const projection = projectRun(view.events);
  const adapter = new PiSubprocessWorkerAdapter({
    agents: dependencies.agents,
    allowLocalModel: params.allowLocalModel ?? false,
    inheritedModel: dependencies.inheritedModel,
    runDirectory: path.dirname(view.filePath),
  });
  const workerIds = [...new Set(view.events
    .filter((event) => event.type === "phase.attempt.started" && typeof event.data.workerRunId === "string")
    .map((event) => event.data.workerRunId as string))].sort();
  const workers: Record<string, WorkerInspection> = {};
  for (const id of workerIds) workers[id] = await adapter.inspect(id);
  const details: OrchestratorNextInspectResult["details"] = {
    action: "inspect",
    runId,
    status: projection.status,
    workflow: pinned.workflow,
    workflowHash: pinned.compiled.hash,
    runDirectory: path.dirname(view.filePath),
    eventLog: view.filePath,
    projection,
    workers,
  };
  return { markdown: renderInspectResult(details), details };
}

interface PinnedRun {
  task: string;
  workflow: OrchestratorNextWorkflow;
  cwd: string;
  compiled: CompiledWorkflow;
  runtimePolicy: Record<string, import("./types").JsonValue>;
  events: RunEvent[];
}

function loadPinnedRun(runsRoot: string, runId: string): PinnedRun {
  const view = FileEventStore.read(runsRoot, runId);
  const created = view.events.find((event) => event.type === "run.created");
  const workflowEvent = view.events.find((event) => event.type === "workflow.compiled");
  if (!created || !workflowEvent) throw new Error(`Orchestrator Next run ${runId} is missing pinned creation/compiler events`);
  const task = isRecord(created.data.input) && typeof created.data.input.task === "string" ? created.data.input.task : undefined;
  const cwdValue = typeof created.data.workspaceRoot === "string" ? created.data.workspaceRoot : undefined;
  const canonicalJson = typeof workflowEvent.data.canonicalJson === "string" ? workflowEvent.data.canonicalJson : undefined;
  const storedHash = typeof workflowEvent.data.workflowHash === "string" ? workflowEvent.data.workflowHash : undefined;
  if (!task || !cwdValue || !canonicalJson || !storedHash) throw new Error(`Orchestrator Next run ${runId} has incomplete pinned inputs`);
  let source: unknown;
  try {
    source = JSON.parse(canonicalJson);
  } catch (error) {
    throw new Error(`Pinned workflow JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const compiled = compileWorkflow(source);
  if (compiled.hash !== storedHash) throw new Error(`Pinned workflow hash mismatch for ${runId}`);
  const workflow = publicWorkflowFromName(compiled.ir.name);
  const cwd = realpathSync(path.resolve(cwdValue));
  const runtimePolicy = isRecord(created.data.runtimePolicy)
    ? JSON.parse(JSON.stringify(created.data.runtimePolicy)) as Record<string, import("./types").JsonValue>
    : {};
  return { task, workflow, cwd, compiled, runtimePolicy, events: view.events };
}

function assertResumeOverridesMatch(params: OrchestratorNextRunParams, pinned: PinnedRun): void {
  if (params.task !== undefined && params.task.trim() && params.task.trim() !== pinned.task) {
    throw new Error("Resume task differs from the pinned run input");
  }
  if (params.workflow !== undefined && params.workflow !== pinned.workflow) {
    throw new Error("Resume workflow differs from the pinned workflow");
  }
  if (params.cwd !== undefined && realpathSync(path.resolve(params.cwd)) !== pinned.cwd) {
    throw new Error("Resume cwd differs from the pinned product workspace");
  }
  if (params.allowLocalModel !== undefined
    && typeof pinned.runtimePolicy.allowLocalModel === "boolean"
    && params.allowLocalModel !== pinned.runtimePolicy.allowLocalModel) {
    throw new Error("Resume allowLocalModel differs from the pinned runtime policy");
  }
  const changedControl = [
    "concurrency", "plannerAgent", "executorAgent", "verifierAgent",
    "plannerProvider", "plannerModel", "plannerFallbackProvider", "plannerFallbackModel",
    "executorProvider", "executorModel", "executorFallbackProvider", "executorFallbackModel",
    "verifierProvider", "verifierModel", "verifierFallbackProvider", "verifierFallbackModel",
    "testExecutable", "testArgs", "testCwd", "testTimeoutMs",
  ].find((key) => (params as Record<string, unknown>)[key] !== undefined);
  if (changedControl) throw new Error(`Resume controls are workflow-pinned; omit ${changedControl}`);
}

function buildWorkflow(params: OrchestratorNextRunParams, workflow: OrchestratorNextWorkflow): WorkflowSpec {
  if (workflow === "read-only-fanout-join") return readOnlyFanoutJoinPilot();
  if (workflow !== "single-writer-pev") throw new Error(`Unsupported Orchestrator Next workflow: ${String(workflow)}`);
  if (!params.testExecutable || !path.isAbsolute(params.testExecutable)) {
    throw new Error("single-writer-pev requires testExecutable as an absolute host-authorized executable path");
  }
  if (realpathSync(params.testExecutable) !== realpathSync(process.execPath)) {
    throw new Error("The public v2 pilot currently permits only the host Node.js executable for deterministic tests");
  }
  if (!Array.isArray(params.testArgs) || params.testArgs.length < 1 || !params.testArgs.every((arg) => typeof arg === "string")) {
    throw new Error("single-writer-pev requires a non-empty testArgs string array");
  }
  assertContainedTestScript(params.cwd ?? process.cwd(), params.testCwd ?? ".", params.testArgs[0]);
  return singleWriterPevWorkflow({
    executable: "test",
    args: [...params.testArgs],
    cwd: params.testCwd ?? ".",
    timeoutMs: params.testTimeoutMs ?? 10 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
  });
}

function preparePinnedValidator(
  compiled: CompiledWorkflow,
  cwd: string,
  runDirectory: string,
  resume: boolean,
): { file: string; sha256: string; source: Buffer } {
  const commandPhase = compiled.ir.phases.find((phase) => phase.kind === "deterministic-command");
  if (!commandPhase?.command || commandPhase.command.executable !== "test" || commandPhase.command.args.length < 1) {
    throw new Error("Pinned single-writer-pev workflow has no host-fixed test command");
  }
  const hostInputs = path.join(runDirectory, "host-inputs");
  const file = path.join(hostInputs, "validator.cjs");
  const metadataFile = path.join(hostInputs, "validator.json");
  if (resume) {
    if (!existsSync(file) || !existsSync(metadataFile) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
      throw new Error("Pinned host validator is missing or unsafe");
    }
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as { version?: unknown; sha256?: unknown };
    const bytes = readFileSync(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (metadata.version !== 1 || metadata.sha256 !== sha256) throw new Error("Pinned host validator hash mismatch");
    return { file: realpathSync(file), sha256, source: bytes };
  }
  assertContainedTestScript(cwd, commandPhase.command.cwd ?? ".", commandPhase.command.args[0]);
  const source = realpathSync(path.resolve(cwd, commandPhase.command.cwd ?? ".", commandPhase.command.args[0]));
  const bytes = readFileSync(source);
  if (bytes.length > 1024 * 1024) throw new Error("Host validator exceeds 1 MiB");
  if (existsSync(hostInputs)) throw new Error("Host validator inputs already exist for a new run");
  mkdirSync(hostInputs, { recursive: false });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileAtomic(file, bytes);
  writeFileAtomic(metadataFile, Buffer.from(`${JSON.stringify({ version: 1, sha256, source: commandPhase.command.args[0] }, null, 2)}\n`, "utf8"));
  return { file: realpathSync(file), sha256, source: Buffer.from(bytes) };
}

function commandAdapterForCompiled(compiled: CompiledWorkflow, pinnedValidator: { file: string; source: Buffer }): CommandWorkerAdapter {
  const commandPhase = compiled.ir.phases.find((phase) => phase.kind === "deterministic-command");
  if (!commandPhase?.command || commandPhase.command.executable !== "test" || commandPhase.command.args.length < 1) {
    throw new Error("Pinned single-writer-pev workflow has no host-fixed test command");
  }
  return new CommandWorkerAdapter({
    executables: { test: process.execPath },
    fixedArgs: { test: ["-", ...commandPhase.command.args.slice(1)] },
    fixedStdin: { test: pinnedValidator.source },
  });
}

function applyRoutesAndAgents(source: WorkflowSpec, params: OrchestratorNextRunParams): void {
  for (const phase of source.phases) {
    if (phase.kind !== "agent" || !phase.agent) continue;
    if (phase.role === "planner") {
      phase.agent.name = params.plannerAgent?.trim() || phase.agent.name;
      if (params.plannerProvider) phase.agent.provider = params.plannerProvider;
      if (params.plannerModel) phase.agent.model = params.plannerModel;
      phase.agent.fallbacks = pairedFallbacks(params.plannerFallbackProvider, params.plannerFallbackModel);
    } else if (phase.role === "executor") {
      phase.agent.name = params.executorAgent?.trim() || phase.agent.name;
      if (params.executorProvider) phase.agent.provider = params.executorProvider;
      if (params.executorModel) phase.agent.model = params.executorModel;
      phase.agent.fallbacks = pairedFallbacks(params.executorFallbackProvider, params.executorFallbackModel);
    } else {
      phase.agent.name = params.verifierAgent?.trim() || phase.agent.name;
      if (params.verifierProvider) phase.agent.provider = params.verifierProvider;
      if (params.verifierModel) phase.agent.model = params.verifierModel;
      phase.agent.fallbacks = pairedFallbacks(params.verifierFallbackProvider, params.verifierFallbackModel);
    }
    if (!phase.agent.fallbacks?.length) delete phase.agent.fallbacks;
  }
}

function resolveAgentRoutes(
  source: WorkflowSpec,
  agents: Map<string, AgentProfile>,
  inheritedModel?: { provider?: string; model?: string },
): void {
  for (const phase of source.phases) {
    if (phase.kind !== "agent" || !phase.agent) continue;
    const profile = agents.get(phase.agent.name);
    if (!phase.agent.provider) phase.agent.provider = profile?.provider ?? inheritedModel?.provider;
    if (!phase.agent.model) phase.agent.model = profile?.model ?? inheritedModel?.model;
    if (!phase.agent.provider) delete phase.agent.provider;
    if (!phase.agent.model) delete phase.agent.model;
  }
}

function runtimePolicyFor(
  compiled: CompiledWorkflow,
  agents: Map<string, AgentProfile>,
  allowLocalModel: boolean,
  inheritedModel?: { provider?: string; model?: string },
): Record<string, import("./types").JsonValue> {
  const profileHashes: Record<string, string> = {};
  const names = [...new Set(compiled.ir.phases
    .filter((phase) => phase.kind === "agent" && phase.agent)
    .map((phase) => phase.agent!.name))].sort();
  for (const name of names) {
    const profile = agents.get(name) ?? { name };
    const normalized = {
      name,
      description: profile.description ?? "",
      systemPrompt: profile.systemPrompt ?? "",
      provider: profile.provider ?? "",
      model: profile.model ?? "",
      tools: [...(profile.tools ?? [])].map(String).sort(),
      skills: [...(profile.skills ?? [])].map(String).sort(),
      agencyLevel: profile.agencyLevel === undefined ? "" : String(profile.agencyLevel),
    };
    profileHashes[name] = createHash("sha256").update(stableStringify(normalized)).digest("hex");
  }
  return {
    adapter: "pi-json-subprocess-v2",
    allowLocalModel,
    inheritedProvider: inheritedModel?.provider ?? "",
    inheritedModel: inheritedModel?.model ?? "",
    profileHashes,
  };
}

function pairedFallbacks(providerText?: string, modelText?: string): Array<{ provider?: string; model?: string }> {
  const providers = String(providerText ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const models = String(modelText ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const count = Math.max(providers.length, models.length);
  if (!count) return [];
  if (count > 5) throw new Error("Orchestrator Next supports at most five fallback routes per role");
  const routes: Array<{ provider?: string; model?: string }> = [];
  for (let index = 0; index < count; index++) {
    const provider = providers[index] ?? providers[providers.length === 1 ? 0 : index];
    const model = models[index] ?? models[models.length === 1 ? 0 : index];
    if (!provider && !model) throw new Error(`Fallback route ${index + 1} has neither provider nor model`);
    routes.push({ ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
  }
  return routes;
}

export function defaultNextRunsRoot(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Pi", "orchestrator-next-runs");
  }
  const stateHome = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "pi", "orchestrator-next-runs");
}

function assertRunsRootOutsideWorkspace(cwd: string, runsRoot: string): void {
  const workspace = existsSync(cwd) ? realpathSync(cwd) : path.resolve(cwd);
  const runtimeRoot = existsSync(runsRoot) ? realpathSync(runsRoot) : path.resolve(runsRoot);
  const relative = path.relative(workspace, runtimeRoot);
  const isInside = relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (isInside) throw new Error("Orchestrator Next runsRoot must be outside the product workspace");
}

function assertContainedTestScript(cwd: string, testCwd: string, scriptArg: string): void {
  if (!scriptArg || scriptArg.startsWith("-") || path.isAbsolute(scriptArg) || scriptArg.split(/[\\/]+/).includes("..")) {
    throw new Error("The first testArgs entry must be a workspace-contained relative Node.js script path");
  }
  const workspace = realpathSync(path.resolve(cwd));
  const script = path.resolve(workspace, testCwd, scriptArg);
  if (!existsSync(script) || !statSync(script).isFile()) throw new Error(`Deterministic test script does not exist: ${scriptArg}`);
  const canonicalScript = realpathSync(script);
  const relative = path.relative(workspace, canonicalScript);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Deterministic test script escapes the product workspace");
  }
}

function publicWorkflowFromName(name: string): OrchestratorNextWorkflow {
  if (name === "next-read-only-fanout-join") return "read-only-fanout-join";
  if (name === "next-single-writer-pev") return "single-writer-pev";
  throw new Error(`Pinned workflow is not an enabled public pilot: ${name}`);
}

function requireRunId(runId?: string): string {
  const value = runId?.trim();
  if (!value) throw new Error("Orchestrator Next resume/inspect requires runId");
  return value;
}

function nextRunId(): string {
  return `orcn-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function formatEventProgress(event: { type: string; phaseId?: string; attempt?: number; data?: Record<string, unknown> }): string {
  const phase = event.phaseId ? ` ${event.phaseId}` : "";
  const attempt = event.attempt ? ` attempt ${event.attempt}` : "";
  const category = typeof event.data?.category === "string" ? ` (${event.data.category})` : "";
  return `Orchestrator Next:${phase}${attempt} ${event.type}${category}`;
}

function renderNextResult(details: OrchestratorNextRunResult["details"]): string {
  const lines = [
    `# Orchestrator Next: ${details.status.toUpperCase()}`,
    "",
    `- Run: ${details.runId}`,
    `- Workflow: ${details.workflow}`,
    `- Workflow hash: ${details.workflowHash}`,
    `- Event log: ${details.eventLog}`,
    "",
    "## Phases",
  ];
  for (const [id, outcome] of Object.entries(details.phaseOutcomes)) {
    lines.push(
      `- ${id}: ${outcome.status}`
        + `${outcome.category ? ` (${outcome.category})` : ""}`
        + `; process=${String(outcome.process.exitCode)}`
        + `; protocol=${outcome.protocol.status}`
        + `; semantic=${outcome.semantic.status}`
        + `; effects=${outcome.effects.status}:${outcome.effects.mutations.length}`
        + `${outcome.workspace ? `; workspace=${outcome.workspace.mode}` : ""}`,
    );
  }
  return lines.join("\n");
}

function renderInspectResult(details: OrchestratorNextInspectResult["details"]): string {
  const lines = [
    `# Orchestrator Next Inspection: ${details.status.toUpperCase()}`,
    "",
    `- Run: ${details.runId}`,
    `- Workflow: ${details.workflow}`,
    `- Workflow hash: ${details.workflowHash}`,
    `- Event log: ${details.eventLog}`,
    "",
    "## Phases",
  ];
  for (const [id, phase] of Object.entries(details.projection.phases)) {
    lines.push(`- ${id}: ${phase.status}; attempts=${phase.attempts}; effects=${phase.effects.status}:${phase.effects.mutations.length}`);
  }
  if (Object.keys(details.workers).length) {
    lines.push("", "## Workers");
    for (const [id, worker] of Object.entries(details.workers)) lines.push(`- ${id}: ${worker.state}`);
  }
  return lines.join("\n");
}

function writeFileAtomic(file: string, bytes: Buffer): void {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
