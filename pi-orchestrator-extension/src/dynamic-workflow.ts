/**
 * Invocation-time declarative workflow registry and runner.
 *
 * Workflow documents are data, never executable modules. The coordinator only
 * reads a bounded JSON artifact and delegates phase work through substrate
 * primitives; documents cannot request shell commands, filesystem operations,
 * dynamic imports, network access, or recursive orchestration.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SpawnGuard,
  SubagentDetachedError,
  buildExecutionWaves,
  runBoundedPool,
  spawnSubagent,
  throwIfAborted,
  truncateWithNotice,
  type SubagentResult,
} from "./substrate";
import { RunStateStore, collectSurvivorResult, type LoadedRunState } from "./run-state";
import type { OrchestrationShapeContext, OrchestrationShapeResult } from "./types";

export const DYNAMIC_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const DYNAMIC_WORKFLOW_FILE_SUFFIX = ".workflow.json";
export const DYNAMIC_WORKFLOW_LIMITS = Object.freeze({
  MAX_ARTIFACT_BYTES: 256 * 1024,
  MAX_NAME_CHARS: 64,
  MAX_DESCRIPTION_CHARS: 2_000,
  MAX_PHASES: 32,
  MAX_ITERATIONS: 10,
  MAX_TOTAL_SPAWNS: 64,
  MAX_CONCURRENCY: 16,
  MAX_PROMPT_CHARS: 16_000,
  MAX_EXPECTED_OUTPUT_CHARS: 4_000,
  MAX_REPORT_CHARS: 20_000,
  MAX_PHASE_OUTPUT_CHARS: 4_000,
});

const SAFE_KEBAB_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_TOKEN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WORKFLOW_KEYS = new Set([
  "schemaVersion", "name", "description", "phases", "maxSubagents",
  "maxConcurrency", "maxIterations", "continueOnFailure",
  "terminationCondition", "evidenceModel", "failureBehavior", "userFacingExplanation",
]);
const PHASE_KEYS = new Set([
  "id", "role", "agentName", "prompt", "expectedOutput", "dependsOn", "route",
]);
const ROUTE_KEYS = new Set(["role", "provider", "model"]);
const PROVENANCE_KEYS = new Set([
  "sourcePath", "scope", "schemaVersion", "contentHash", "snapshotHash", "validatedSnapshot",
]);

export type DynamicWorkflowScope = "user" | "project" | "pinned";
export type DynamicRouteRole = "inherit" | "planner" | "executor" | "verifier";

export interface DynamicWorkflowRoute {
  role: DynamicRouteRole;
  provider?: string;
  model?: string;
}

export interface DynamicWorkflowPhase {
  id: string;
  role: string;
  agentName: string;
  prompt: string;
  expectedOutput: string;
  dependsOn: string[];
  route: DynamicWorkflowRoute;
}

/** Fully defaulted, finite intermediate representation. */
export interface DynamicWorkflowIR {
  schemaVersion: typeof DYNAMIC_WORKFLOW_SCHEMA_VERSION;
  name: string;
  description: string;
  phases: DynamicWorkflowPhase[];
  maxSubagents: number;
  maxConcurrency: number;
  maxIterations: number;
  continueOnFailure: boolean;
  terminationCondition: string;
  evidenceModel: string;
  failureBehavior: string;
  userFacingExplanation: string;
}

export interface DynamicWorkflowProvenance {
  sourcePath: string;
  scope: DynamicWorkflowScope;
  schemaVersion: number;
  contentHash: string;
  snapshotHash: string;
  /** Exact, fully validated IR used by this run. */
  validatedSnapshot: DynamicWorkflowIR;
}

export interface ResolvedDynamicWorkflow {
  workflow: DynamicWorkflowIR;
  provenance: DynamicWorkflowProvenance;
}

export interface WorkflowRoots {
  user: string;
  project: string;
}

export class DynamicWorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "DynamicWorkflowError";
    this.code = code;
  }
}

/** Defaults are user-owned and project-owned, and therefore survive Pi updates. */
export function dynamicWorkflowRoots(cwd: string): WorkflowRoots {
  const userOverride = process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT?.trim();
  const projectOverride = process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT?.trim();
  return {
    user: path.resolve(userOverride || path.join(os.homedir(), ".pi", "orchestrator-workflows")),
    project: path.resolve(projectOverride || path.join(cwd, ".pi", "orchestrator-workflows")),
  };
}

export function workflowArtifactPath(root: string, name: string): string {
  assertSafeWorkflowName(name);
  return path.join(path.resolve(root), `${name}${DYNAMIC_WORKFLOW_FILE_SUFFIX}`);
}

export function assertSafeWorkflowName(name: string): void {
  if (!SAFE_KEBAB_NAME.test(name) || name.length > DYNAMIC_WORKFLOW_LIMITS.MAX_NAME_CHARS) {
    throw new DynamicWorkflowError(
      "UNSAFE_WORKFLOW_NAME",
      `Workflow names must be lowercase kebab-case, start with a letter, and be at most ${DYNAMIC_WORKFLOW_LIMITS.MAX_NAME_CHARS} characters (got ${JSON.stringify(name)}).`,
    );
  }
}

/**
 * Resolve a requested name on every invocation. Project scope has precedence
 * over user scope. A present-but-invalid project artifact fails closed rather
 * than silently falling back to a user artifact.
 */
export function resolveDynamicWorkflow(
  name: string,
  options: { cwd: string; nativeNames: ReadonlySet<string>; roots?: Partial<WorkflowRoots> },
): ResolvedDynamicWorkflow | undefined {
  assertSafeWorkflowName(name);
  if (options.nativeNames.has(name)) {
    throw new DynamicWorkflowError(
      "NATIVE_WORKFLOW_COLLISION",
      `Declarative workflow ${JSON.stringify(name)} cannot shadow a built-in/native orchestration shape.`,
    );
  }
  const defaults = dynamicWorkflowRoots(options.cwd);
  const roots: WorkflowRoots = {
    user: path.resolve(options.roots?.user ?? defaults.user),
    project: path.resolve(options.roots?.project ?? defaults.project),
  };

  const projectPath = workflowArtifactPath(roots.project, name);
  if (pathEntryExists(projectPath)) {
    return loadDynamicWorkflowArtifact(projectPath, roots.project, "project", name, options.nativeNames);
  }
  const userPath = workflowArtifactPath(roots.user, name);
  if (pathEntryExists(userPath)) {
    return loadDynamicWorkflowArtifact(userPath, roots.user, "user", name, options.nativeNames);
  }
  return undefined;
}

/** Load one artifact while enforcing realpath containment and bounded size. */
export function loadDynamicWorkflowArtifact(
  artifactPath: string,
  trustedRoot: string,
  scope: Exclude<DynamicWorkflowScope, "pinned">,
  expectedName?: string,
  nativeNames: ReadonlySet<string> = new Set(),
): ResolvedDynamicWorkflow {
  const sourcePath = assertRealPathContained(artifactPath, trustedRoot);
  const stat = lstatSync(sourcePath);
  if (!stat.isFile()) {
    throw new DynamicWorkflowError("WORKFLOW_NOT_FILE", `Workflow artifact is not a regular file: ${sourcePath}`);
  }
  if (stat.size > DYNAMIC_WORKFLOW_LIMITS.MAX_ARTIFACT_BYTES) {
    throw new DynamicWorkflowError(
      "WORKFLOW_TOO_LARGE",
      `Workflow artifact is ${stat.size} bytes; maximum is ${DYNAMIC_WORKFLOW_LIMITS.MAX_ARTIFACT_BYTES}.`,
    );
  }
  const bytes = readFileSync(sourcePath);
  if (bytes.length > DYNAMIC_WORKFLOW_LIMITS.MAX_ARTIFACT_BYTES) {
    throw new DynamicWorkflowError("WORKFLOW_TOO_LARGE", "Workflow artifact exceeded the size cap while reading.");
  }
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new DynamicWorkflowError("MALFORMED_WORKFLOW_JSON", error instanceof Error ? error.message : String(error));
  }
  const workflow = validateDynamicWorkflow(document, { expectedName, nativeNames });
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const validatedSnapshot = cloneSnapshot(workflow);
  return {
    workflow: validatedSnapshot,
    provenance: {
      sourcePath,
      scope,
      schemaVersion: workflow.schemaVersion,
      contentHash,
      snapshotHash: hashSnapshot(validatedSnapshot),
      validatedSnapshot,
    },
  };
}

/**
 * Realpath containment catches symlink/junction escapes. The trusted root is
 * canonicalized first; the artifact's canonical path must remain beneath it.
 */
export function assertRealPathContained(candidate: string, trustedRoot: string): string {
  const absoluteRoot = path.resolve(trustedRoot);
  if (!existsSync(absoluteRoot)) {
    throw new DynamicWorkflowError("WORKFLOW_ROOT_MISSING", `Trusted workflow root does not exist: ${absoluteRoot}`);
  }
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = realpathSync.native(absoluteRoot);
    canonicalCandidate = realpathSync.native(path.resolve(candidate));
  } catch (error) {
    throw new DynamicWorkflowError(
      "WORKFLOW_PATH_UNRESOLVABLE",
      `Workflow path could not be resolved safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new DynamicWorkflowError(
      "WORKFLOW_PATH_ESCAPE",
      `Workflow artifact resolves outside its trusted root: ${canonicalCandidate} (root ${canonicalRoot}).`,
    );
  }
  return canonicalCandidate;
}

export function validateDynamicWorkflow(
  value: unknown,
  options: { expectedName?: string; nativeNames?: ReadonlySet<string> } = {},
): DynamicWorkflowIR {
  const doc = expectRecord(value, "workflow");
  rejectUnknownKeys(doc, WORKFLOW_KEYS, "workflow");
  if (doc.schemaVersion !== DYNAMIC_WORKFLOW_SCHEMA_VERSION) {
    throw new DynamicWorkflowError(
      "UNSUPPORTED_WORKFLOW_SCHEMA",
      `schemaVersion must be ${DYNAMIC_WORKFLOW_SCHEMA_VERSION} (got ${JSON.stringify(doc.schemaVersion)}).`,
    );
  }
  const name = expectString(doc.name, "name", DYNAMIC_WORKFLOW_LIMITS.MAX_NAME_CHARS);
  assertSafeWorkflowName(name);
  if (options.expectedName && name !== options.expectedName) {
    throw new DynamicWorkflowError("WORKFLOW_NAME_MISMATCH", `Artifact name ${JSON.stringify(name)} does not match requested name ${JSON.stringify(options.expectedName)}.`);
  }
  if (options.nativeNames?.has(name)) {
    throw new DynamicWorkflowError("NATIVE_WORKFLOW_COLLISION", `Workflow ${JSON.stringify(name)} collides with a native shape.`);
  }
  const description = expectString(doc.description, "description", DYNAMIC_WORKFLOW_LIMITS.MAX_DESCRIPTION_CHARS);
  if (!Array.isArray(doc.phases) || doc.phases.length < 1 || doc.phases.length > DYNAMIC_WORKFLOW_LIMITS.MAX_PHASES) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_PHASES", `phases must contain 1-${DYNAMIC_WORKFLOW_LIMITS.MAX_PHASES} entries.`);
  }
  const phases = doc.phases.map((phase, index) => validatePhase(phase, index));
  // Validate duplicate/missing/cyclic dependencies before anything can spawn.
  try {
    buildExecutionWaves(phases);
  } catch (error) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_GRAPH", error instanceof Error ? error.message : String(error));
  }

  const maxIterations = finiteInteger(doc.maxIterations, "maxIterations", 1, DYNAMIC_WORKFLOW_LIMITS.MAX_ITERATIONS, 1);
  const requiredSpawns = phases.length * maxIterations;
  if (requiredSpawns > DYNAMIC_WORKFLOW_LIMITS.MAX_TOTAL_SPAWNS) {
    throw new DynamicWorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `${phases.length} phase(s) × ${maxIterations} iteration(s) require ${requiredSpawns} spawns; maximum is ${DYNAMIC_WORKFLOW_LIMITS.MAX_TOTAL_SPAWNS}.`,
    );
  }
  const maxSubagents = finiteInteger(
    doc.maxSubagents,
    "maxSubagents",
    requiredSpawns,
    DYNAMIC_WORKFLOW_LIMITS.MAX_TOTAL_SPAWNS,
    requiredSpawns,
  );
  if (requiredSpawns > maxSubagents) {
    throw new DynamicWorkflowError(
      "WORKFLOW_SPAWN_CAP_TOO_SMALL",
      `${phases.length} phase(s) × ${maxIterations} iteration(s) require ${requiredSpawns} spawns, exceeding maxSubagents=${maxSubagents}.`,
    );
  }
  const maxConcurrency = finiteInteger(
    doc.maxConcurrency,
    "maxConcurrency",
    1,
    DYNAMIC_WORKFLOW_LIMITS.MAX_CONCURRENCY,
    Math.min(4, phases.length),
  );

  const workflow: DynamicWorkflowIR = {
    schemaVersion: DYNAMIC_WORKFLOW_SCHEMA_VERSION,
    name,
    description,
    phases,
    maxSubagents,
    maxConcurrency,
    maxIterations,
    continueOnFailure: doc.continueOnFailure === undefined ? false : expectBoolean(doc.continueOnFailure, "continueOnFailure"),
    terminationCondition: optionalBoundedString(doc.terminationCondition, "terminationCondition", 2_000),
    evidenceModel: optionalBoundedString(doc.evidenceModel, "evidenceModel", 2_000),
    failureBehavior: optionalBoundedString(doc.failureBehavior, "failureBehavior", 2_000),
    userFacingExplanation: optionalBoundedString(doc.userFacingExplanation, "userFacingExplanation", 4_000),
  };
  return cloneSnapshot(workflow);
}

/** Rehydrate a resume exclusively from its pinned validated snapshot. */
export function resolvePinnedDynamicWorkflow(
  pinned: unknown,
  expectedName: string,
  nativeNames: ReadonlySet<string>,
): ResolvedDynamicWorkflow {
  const metadata = expectRecord(pinned, "pinned workflow metadata");
  rejectUnknownKeys(metadata, PROVENANCE_KEYS, "pinned workflow metadata");
  const sourcePath = expectString(metadata.sourcePath, "sourcePath", 32_768);
  const originalScope = expectString(metadata.scope, "scope", 16);
  if (originalScope !== "user" && originalScope !== "project") {
    throw new DynamicWorkflowError("INVALID_PINNED_WORKFLOW", "Pinned source scope must be user or project.");
  }
  const contentHash = expectString(metadata.contentHash, "contentHash", 64);
  const snapshotHash = expectString(metadata.snapshotHash, "snapshotHash", 64);
  if (!SHA256.test(contentHash) || !SHA256.test(snapshotHash)) {
    throw new DynamicWorkflowError("INVALID_PINNED_WORKFLOW", "Pinned content/snapshot hashes must be lowercase SHA-256 values.");
  }
  const workflow = validateDynamicWorkflow(metadata.validatedSnapshot, { expectedName, nativeNames });
  const actualSnapshotHash = hashSnapshot(workflow);
  if (actualSnapshotHash !== snapshotHash) {
    throw new DynamicWorkflowError("PINNED_WORKFLOW_MISMATCH", `Pinned validated snapshot hash mismatch for ${expectedName}; refusing to load current source.`);
  }
  if (metadata.schemaVersion !== workflow.schemaVersion) {
    throw new DynamicWorkflowError("PINNED_WORKFLOW_MISMATCH", "Pinned schemaVersion does not match the validated snapshot.");
  }
  return {
    workflow,
    provenance: {
      sourcePath,
      scope: "pinned",
      schemaVersion: workflow.schemaVersion,
      contentHash,
      snapshotHash,
      validatedSnapshot: cloneSnapshot(workflow),
    },
  };
}

/** Deterministic validation/plan canary. It never calls spawnSubagent. */
export function runDynamicWorkflowCanary(resolved: ResolvedDynamicWorkflow): OrchestrationShapeResult {
  const workflow = assertResolvedWorkflowIntegrity(resolved);
  const waves = buildExecutionWaves(workflow.phases).map((wave) => wave.map((phase) => phase.id));
  return {
    markdown: [
      `# ${workflow.name} Declarative Workflow Canary: PASS`,
      "",
      "Deterministic validation completed with zero subagent spawns.",
      `- schemaVersion: ${workflow.schemaVersion}`,
      `- phases: ${workflow.phases.length}`,
      `- waves: ${waves.length}`,
      `- maximum spawns: ${workflow.maxSubagents}`,
      `- content SHA-256: ${resolved.provenance.contentHash}`,
    ].join("\n"),
    details: {
      status: "pass",
      paradigm: workflow.name,
      canary: true,
      deterministic: true,
      spawnedCount: 0,
      waves,
      workflow: cloneProvenance(resolved.provenance),
    },
  };
}

/** Execute a validated declarative workflow using only bounded substrate APIs. */
export async function runDynamicWorkflow(
  resolved: ResolvedDynamicWorkflow,
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const workflow = assertResolvedWorkflowIntegrity(resolved);
  if (context.params.task.trim() === "SHAPE_CANARY") return runDynamicWorkflowCanary(resolved);

  if (context.resumeState) validateDynamicResumeState(workflow, context.resumeState, context.runId);
  const runId = context.runId ?? `orc-${Date.now().toString(36)}-dynamic`;
  const phaseNames = phaseCheckpointNames(workflow);
  const store = context.resumeState
    ? RunStateStore.open(context.resumeState.state.runId)
    : RunStateStore.create(
        runId,
        workflow.name,
        context.params.task,
        serializableParams(context.params),
        phaseNames,
        cloneProvenance(resolved.provenance) as unknown as Record<string, unknown>,
      );
  const phaseStateByName = new Map((context.resumeState?.state.phases ?? []).map((entry) => [entry.name, entry]));
  const spawnGuard = new SpawnGuard(Math.min(workflow.maxSubagents, context.params.maxSubagents));
  const concurrency = Math.max(1, Math.min(workflow.maxConcurrency, context.params.concurrency, DYNAMIC_WORKFLOW_LIMITS.MAX_CONCURRENCY));
  const outputs = new Map<string, SubagentResult>();
  const orderedOutputs: Array<{ iteration: number; phaseId: string; result: SubagentResult; restored: boolean }> = [];
  const emit = (text: string) => context.onUpdate?.({ content: [{ type: "text", text }] });
  const waves = buildExecutionWaves(workflow.phases);

  emit(`Declarative workflow ${workflow.name}: schema v${workflow.schemaVersion}, hash=${resolved.provenance.contentHash}, concurrency=${concurrency}.`);
  for (let iteration = 1; iteration <= workflow.maxIterations; iteration++) {
    for (const wave of waves) {
      throwIfAborted(context.signal);
      const waveResults = await runBoundedPool(wave, concurrency, context.signal, async (phase) => {
        const checkpointName = phaseCheckpointName(iteration, phase.id);
        const phaseState = phaseStateByName.get(checkpointName);
        const checkpointIndex = phaseState?.index ?? phaseNames.indexOf(checkpointName);
        let restored: SubagentResult | undefined;
        if (phaseState?.status === "done") {
          restored = context.resumeState?.checkpoints.get(checkpointIndex);
          if (!restored) {
            throw new DynamicWorkflowError("MISSING_DYNAMIC_CHECKPOINT", `Completed phase ${checkpointName} has no readable checkpoint.`);
          }
          validateCheckpointResult(restored, phase, checkpointName);
        } else if (phaseState?.status === "detached") {
          const survivor = context.resumeState?.survivors.get(checkpointIndex);
          if (survivor) {
            restored = await collectSurvivorResult<SubagentResult>(survivor, emit, context.signal, workflow.name);
            if (restored) {
              validateCheckpointResult(restored, phase, checkpointName);
              store.checkpointPhase(checkpointIndex, checkpointName, restored);
            }
          }
        }
        if (restored) return { phase, result: restored, restored: true };

        const spawnNumber = spawnGuard.reserve();
        const route = resolvePhaseRoute(phase.route, context);
        emit(`${workflow.name}: iteration ${iteration}/${workflow.maxIterations}, phase ${phase.id} spawning ${phase.agentName} (${spawnNumber}/${spawnGuard.cap}).`);
        try {
          const result = await spawnSubagent(
            phase.agentName,
            buildPhasePrompt(workflow, phase, context.params.task, outputs, iteration),
            {
              agents: context.agents,
              cwd: context.params.cwd,
              allowLocalModel: context.params.allowLocalModel,
              signal: context.signal,
              inheritedModel: route.inheritedModel,
              modelOverride: route.modelOverride,
              onProgress: emit,
              phaseMutates: true,
              abortSurvival: {
                resultFile: store.survivorResultPath(checkpointIndex, checkpointName),
                manifestFile: store.survivorManifestPath(checkpointIndex, checkpointName),
                phaseName: checkpointName,
                phaseIndex: checkpointIndex,
              },
            },
          );
          store.checkpointPhase(checkpointIndex, checkpointName, result);
          return { phase, result, restored: false };
        } catch (error) {
          if (error instanceof SubagentDetachedError) store.markDetached(checkpointIndex, checkpointName, error.manifest);
          throw error;
        }
      });

      for (const item of waveResults) {
        outputs.set(outputKey(iteration, item.phase.id), item.result);
        orderedOutputs.push({ iteration, phaseId: item.phase.id, result: item.result, restored: item.restored });
      }
      if (!workflow.continueOnFailure && waveResults.some((item) => item.result.exitCode !== 0)) break;
    }
    if (!workflow.continueOnFailure && orderedOutputs.some((item) => item.iteration === iteration && item.result.exitCode !== 0)) break;
  }

  const expectedRuns = workflow.phases.length * workflow.maxIterations;
  const status: "pass" | "fail" = orderedOutputs.length === expectedRuns && orderedOutputs.every((item) => item.result.exitCode === 0)
    ? "pass"
    : "fail";
  const details = {
    status,
    paradigm: workflow.name,
    dynamicWorkflow: true,
    runId: store.runId,
    spawnedCount: spawnGuard.spawned,
    restoredCount: orderedOutputs.filter((item) => item.restored).length,
    concurrency,
    iterationsCompleted: new Set(orderedOutputs.map((item) => item.iteration)).size,
    workflow: cloneProvenance(resolved.provenance),
    outputs: orderedOutputs.map((item) => ({
      iteration: item.iteration,
      phaseId: item.phaseId,
      agentName: item.result.agentName,
      provider: item.result.provider,
      model: item.result.model,
      exitCode: item.result.exitCode,
      durationMs: item.result.durationMs,
      restored: item.restored,
      text: truncateWithNotice(item.result.text, DYNAMIC_WORKFLOW_LIMITS.MAX_PHASE_OUTPUT_CHARS, "dynamic phase output"),
    })),
  };
  const markdown = truncateWithNotice(buildReport(workflow, status, details.outputs, resolved.provenance), DYNAMIC_WORKFLOW_LIMITS.MAX_REPORT_CHARS, "dynamic workflow report");
  return { markdown, details };
}

function validatePhase(value: unknown, index: number): DynamicWorkflowPhase {
  const phase = expectRecord(value, `phases[${index}]`);
  rejectUnknownKeys(phase, PHASE_KEYS, `phases[${index}]`);
  const id = expectString(phase.id, `phases[${index}].id`, 64);
  if (!SAFE_KEBAB_NAME.test(id)) throw new DynamicWorkflowError("INVALID_PHASE_ID", `Phase id must be safe kebab-case: ${JSON.stringify(id)}.`);
  const role = expectString(phase.role, `phases[${index}].role`, 64);
  const agentName = expectString(phase.agentName, `phases[${index}].agentName`, 128);
  if (!SAFE_TOKEN.test(agentName) || !SAFE_TOKEN.test(role)) {
    throw new DynamicWorkflowError("INVALID_PHASE_ROLE", `Phase role and agentName must be bounded identifier tokens (phase ${id}).`);
  }
  const prompt = expectString(phase.prompt, `phases[${index}].prompt`, DYNAMIC_WORKFLOW_LIMITS.MAX_PROMPT_CHARS);
  const expectedOutput = optionalBoundedString(phase.expectedOutput, `phases[${index}].expectedOutput`, DYNAMIC_WORKFLOW_LIMITS.MAX_EXPECTED_OUTPUT_CHARS);
  const dependsOn = phase.dependsOn === undefined ? [] : expectStringArray(phase.dependsOn, `phases[${index}].dependsOn`, DYNAMIC_WORKFLOW_LIMITS.MAX_PHASES, 64);
  if (new Set(dependsOn).size !== dependsOn.length) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_GRAPH", `Phase ${id} contains duplicate dependency ids.`);
  }
  const route = validateRoute(phase.route, index);
  return { id, role, agentName, prompt, expectedOutput, dependsOn, route };
}

function validateRoute(value: unknown, phaseIndex: number): DynamicWorkflowRoute {
  if (value === undefined) return { role: "inherit" };
  const route = expectRecord(value, `phases[${phaseIndex}].route`);
  rejectUnknownKeys(route, ROUTE_KEYS, `phases[${phaseIndex}].route`);
  const role = route.role === undefined ? "inherit" : expectString(route.role, "route.role", 16);
  if (!(["inherit", "planner", "executor", "verifier"] as string[]).includes(role)) {
    throw new DynamicWorkflowError("INVALID_PHASE_ROUTE", `route.role must be inherit, planner, executor, or verifier (got ${JSON.stringify(role)}).`);
  }
  const provider = route.provider === undefined ? undefined : expectString(route.provider, "route.provider", 128);
  const model = route.model === undefined ? undefined : expectString(route.model, "route.model", 256);
  if (provider && !SAFE_TOKEN.test(provider)) throw new DynamicWorkflowError("INVALID_PHASE_ROUTE", `Unsafe provider token: ${provider}.`);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) throw new DynamicWorkflowError("INVALID_PHASE_ROUTE", `Unsafe model token: ${model}.`);
  return { role: role as DynamicRouteRole, ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

function resolvePhaseRoute(route: DynamicWorkflowRoute, context: OrchestrationShapeContext): {
  inheritedModel?: { provider?: string; model?: string };
  modelOverride?: { provider?: string; model?: string };
} {
  const roleRoute = route.role === "planner"
    ? { provider: context.params.plannerProvider, model: context.params.plannerModel }
    : route.role === "executor"
      ? { provider: context.params.executorProvider, model: context.params.executorModel }
      : route.role === "verifier"
        ? { provider: context.params.verifierProvider, model: context.params.verifierModel }
        : undefined;
  const modelOverride = {
    provider: route.provider ?? roleRoute?.provider,
    model: route.model ?? roleRoute?.model,
  };
  return {
    inheritedModel: route.role === "inherit" ? context.inheritedModel : undefined,
    modelOverride: modelOverride.provider || modelOverride.model ? modelOverride : undefined,
  };
}

function buildPhasePrompt(
  workflow: DynamicWorkflowIR,
  phase: DynamicWorkflowPhase,
  originalTask: string,
  outputs: Map<string, SubagentResult>,
  iteration: number,
): string {
  const dependencies = phase.dependsOn.map((id) => outputs.get(outputKey(iteration, id))).filter((item): item is SubagentResult => Boolean(item));
  return [
    `You are executing declarative workflow ${JSON.stringify(workflow.name)}, phase ${JSON.stringify(phase.id)} (role ${phase.role}), iteration ${iteration}/${workflow.maxIterations}.`,
    "Do not invoke recursive orchestration. Complete only this phase.",
    `Original task:\n${truncateWithNotice(originalTask, 12_000, "original task")}`,
    dependencies.length
      ? `Dependency outputs:\n${dependencies.map((item) => `${item.agentName}: ${truncateWithNotice(item.text, 4_000, "dependency output")}`).join("\n\n")}`
      : "Dependency outputs: none.",
    `Phase instructions:\n${phase.prompt}`,
    phase.expectedOutput ? `Expected output:\n${phase.expectedOutput}` : "",
  ].filter(Boolean).join("\n\n");
}

function buildReport(
  workflow: DynamicWorkflowIR,
  status: "pass" | "fail",
  outputs: Array<{ iteration: number; phaseId: string; agentName: string; exitCode: number | null; text: string }>,
  provenance: DynamicWorkflowProvenance,
): string {
  const lines = [
    `# ${workflow.name} Declarative Workflow: ${status.toUpperCase()}`,
    "",
    workflow.description,
    "",
    `- Schema version: ${workflow.schemaVersion}`,
    `- Source: ${provenance.sourcePath}`,
    `- Content SHA-256: ${provenance.contentHash}`,
    `- Pinned snapshot SHA-256: ${provenance.snapshotHash}`,
    "",
    "## Phase outputs",
  ];
  for (const output of outputs) {
    lines.push("", `### Iteration ${output.iteration} / ${output.phaseId} (${output.agentName}, exit ${String(output.exitCode)})`, output.text);
  }
  if (workflow.userFacingExplanation) lines.push("", "## Orchestration Used", workflow.userFacingExplanation);
  return lines.join("\n");
}

function phaseCheckpointName(iteration: number, phaseId: string): string {
  return `iteration-${iteration}-${phaseId}`;
}

function phaseCheckpointNames(workflow: DynamicWorkflowIR): string[] {
  const names: string[] = [];
  for (let iteration = 1; iteration <= workflow.maxIterations; iteration++) {
    for (const phase of workflow.phases) names.push(phaseCheckpointName(iteration, phase.id));
  }
  return names;
}

function outputKey(iteration: number, phaseId: string): string {
  return `${iteration}:${phaseId}`;
}

function hashSnapshot(snapshot: DynamicWorkflowIR): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** Verify that the executable IR still exactly matches its pinned provenance. */
function assertResolvedWorkflowIntegrity(resolved: ResolvedDynamicWorkflow): DynamicWorkflowIR {
  const workflow = validateDynamicWorkflow(resolved.workflow, { expectedName: resolved.workflow?.name });
  const provenance = expectRecord(resolved.provenance, "workflow provenance");
  rejectUnknownKeys(provenance, PROVENANCE_KEYS, "workflow provenance");
  const contentHash = expectString(provenance.contentHash, "provenance.contentHash", 64);
  const snapshotHash = expectString(provenance.snapshotHash, "provenance.snapshotHash", 64);
  if (!SHA256.test(contentHash) || !SHA256.test(snapshotHash)) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_PROVENANCE", "Workflow provenance hashes must be lowercase SHA-256 values.");
  }
  if (provenance.schemaVersion !== workflow.schemaVersion) {
    throw new DynamicWorkflowError("WORKFLOW_PROVENANCE_MISMATCH", "Provenance schemaVersion does not match the executable workflow.");
  }
  if (provenance.scope !== "user" && provenance.scope !== "project" && provenance.scope !== "pinned") {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_PROVENANCE", "Workflow provenance scope must be user, project, or pinned.");
  }
  expectString(provenance.sourcePath, "provenance.sourcePath", 32_768);
  const snapshot = validateDynamicWorkflow(provenance.validatedSnapshot, { expectedName: workflow.name });
  if (hashSnapshot(snapshot) !== snapshotHash || JSON.stringify(snapshot) !== JSON.stringify(workflow)) {
    throw new DynamicWorkflowError(
      "WORKFLOW_PROVENANCE_MISMATCH",
      `Executable workflow ${workflow.name} does not exactly match its validated provenance snapshot.`,
    );
  }
  return workflow;
}

/** Dynamic runs create the complete checkpoint manifest up front; resumes must match it exactly. */
function validateDynamicResumeState(
  workflow: DynamicWorkflowIR,
  loaded: LoadedRunState,
  contextRunId: string | undefined,
): void {
  const state = loaded.state;
  if (state.paradigm !== workflow.name) {
    throw new DynamicWorkflowError("DYNAMIC_RESUME_MISMATCH", `Run state paradigm ${JSON.stringify(state.paradigm)} does not match ${JSON.stringify(workflow.name)}.`);
  }
  if (contextRunId !== undefined && state.runId !== contextRunId) {
    throw new DynamicWorkflowError("DYNAMIC_RESUME_MISMATCH", "Context run id does not match the loaded run state.");
  }
  const expected = phaseCheckpointNames(workflow);
  if (state.phases.length !== expected.length) {
    throw new DynamicWorkflowError("DYNAMIC_RESUME_MISMATCH", `Checkpoint manifest has ${state.phases.length} phases; expected ${expected.length}.`);
  }
  for (let index = 0; index < expected.length; index++) {
    const phase = state.phases[index];
    if (phase.index !== index || phase.name !== expected[index]) {
      throw new DynamicWorkflowError("DYNAMIC_RESUME_MISMATCH", `Checkpoint manifest entry ${index} does not match ${expected[index]}.`);
    }
  }
}

function validateCheckpointResult(result: unknown, phase: DynamicWorkflowPhase, checkpointName: string): asserts result is SubagentResult {
  const record = expectRecord(result, `checkpoint ${checkpointName}`);
  if (record.agentName !== phase.agentName || typeof record.task !== "string" || typeof record.text !== "string" || typeof record.stderr !== "string") {
    throw new DynamicWorkflowError("INVALID_DYNAMIC_CHECKPOINT", `Checkpoint ${checkpointName} does not match phase agent ${phase.agentName}.`);
  }
  if (record.exitCode !== null && (!Number.isInteger(record.exitCode) || !Number.isFinite(record.exitCode))) {
    throw new DynamicWorkflowError("INVALID_DYNAMIC_CHECKPOINT", `Checkpoint ${checkpointName} has an invalid exitCode.`);
  }
  for (const field of ["durationMs", "events"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field]) || record[field] < 0) {
      throw new DynamicWorkflowError("INVALID_DYNAMIC_CHECKPOINT", `Checkpoint ${checkpointName} has an invalid ${field}.`);
    }
  }
}

/** lstat observes dangling links so a present invalid project entry cannot silently fall back to user scope. */
function pathEntryExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new DynamicWorkflowError("WORKFLOW_PATH_UNRESOLVABLE", `Workflow path could not be inspected safely: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cloneSnapshot(workflow: DynamicWorkflowIR): DynamicWorkflowIR {
  return JSON.parse(JSON.stringify(workflow)) as DynamicWorkflowIR;
}

function cloneProvenance(provenance: DynamicWorkflowProvenance): DynamicWorkflowProvenance {
  return JSON.parse(JSON.stringify(provenance)) as DynamicWorkflowProvenance;
}

function serializableParams(params: OrchestrationShapeContext["params"]): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_SCHEMA", `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new DynamicWorkflowError("UNKNOWN_WORKFLOW_FIELD", `${label} contains unknown field(s): ${unknown.join(", ")}.`);
}

function expectString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_SCHEMA", `${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function optionalBoundedString(value: unknown, label: string, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_SCHEMA", `${label} must be a string of at most ${max} characters.`);
  }
  return value.trim();
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new DynamicWorkflowError("INVALID_WORKFLOW_SCHEMA", `${label} must be boolean.`);
  return value;
}

function expectStringArray(value: unknown, label: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DynamicWorkflowError("INVALID_WORKFLOW_SCHEMA", `${label} must be an array with at most ${maxItems} items.`);
  }
  return value.map((item, index) => expectString(item, `${label}[${index}]`, maxChars));
}

function finiteInteger(value: unknown, label: string, min: number, max: number, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new DynamicWorkflowError("WORKFLOW_LIMIT_EXCEEDED", `${label} must be a finite integer from ${min} through ${max} (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/** Used by shape-builder to create the trusted root without duplicating policy. */
export function ensureDynamicWorkflowRoot(root: string): string {
  const absolute = path.resolve(root);
  mkdirSync(absolute, { recursive: true });
  return realpathSync.native(absolute);
}
