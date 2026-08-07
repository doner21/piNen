/**
 * Shape: dual-plan-synthesis-execute-verify
 * =========================================
 * Run two independently routed planning passes, synthesize one bounded plan,
 * execute that synthesized plan, then verify with direct evidence and bounded
 * executor retry feedback.
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never
 * build on each other.
 */

import {
  SpawnGuard,
  clampIterations,
  runBoundedPool,
  spawnSubagent,
  SubagentDetachedError,
  throwIfAborted,
  truncateWithNotice,
  type AgentProfile,
  type SpawnSubagentOptions,
  type SubagentResult,
} from "../substrate";
import { RunStateStore, collectSurvivorResult } from "../run-state";
import { resolveRouteWithFallback, type ResolvedRoute } from "../routes";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NormalizedParams,
} from "../types";

// ── Shape-owned constants ─────────────────────────────────────────────────

const DEFAULT_PLANNER_ROUTE = { provider: "openai-codex", model: "gpt-5.6-sol" } as const;
const DEFAULT_EXECUTOR_ROUTE = { provider: "openai-codex", model: "gpt-5.6-sol" } as const;
const DEFAULT_VERIFIER_ROUTE = { provider: "openai-codex", model: "gpt-5.5" } as const;

const PLANNER_CONCURRENCY = 2;

type DualPlanRoutes = {
  planA: ResolvedRoute;
  planB: ResolvedRoute;
  synthesis: ResolvedRoute;
  executor: ResolvedRoute;
  verifier: ResolvedRoute;
};

/**
 * Resolve every shape-owned seat from normalized role controls. Plan A, Plan B,
 * and synthesis are all planner-class work, so one planner override/preflight
 * route covers all three seats. Executor and verifier use their corresponding
 * role routes. Defaults are explicit and role-safe; agent profiles and the
 * conversational model are deliberately not consulted here.
 *
 * Preflight fallback is supported by resolving at shape-dispatch time: the
 * shared preflight layer mutates a role's normalized params only after a
 * configured fallback succeeds, and this function consumes that final route.
 */
function resolveRoutes(params: NormalizedParams): DualPlanRoutes {
  const planner = resolveRouteWithFallback(
    params.plannerModel,
    params.plannerProvider,
    DEFAULT_PLANNER_ROUTE,
  );
  return {
    planA: { ...planner },
    planB: { ...planner },
    synthesis: { ...planner },
    executor: resolveRouteWithFallback(
      params.executorModel,
      params.executorProvider,
      DEFAULT_EXECUTOR_ROUTE,
    ),
    verifier: resolveRouteWithFallback(
      params.verifierModel,
      params.verifierProvider,
      DEFAULT_VERIFIER_ROUTE,
    ),
  };
}
const DEFAULT_MAX_RETRIES = 2;
const MAX_SHAPE_RETRIES = 5;
const MAX_FINAL_MARKDOWN_CHARS = 24_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;

/** Tool allowlist for discovery-only subagents. Excludes all mutating tools. */
const DISCOVERY_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

// ── Shape export ───────────────────────────────────────────────────────────

export const dualPlanSynthesisExecuteVerifyShape: OrchestrationShape = {
  name: "dual-plan-synthesis-execute-verify",
  description:
    "Two independent routed planners → routed synthesis reviewer → routed executor → " +
    "routed direct-evidence verifier with bounded executor retry feedback.",
  run: runDualPlanSynthesisExecuteVerify,
};

// ── Shape-specific result types ────────────────────────────────────────────

interface PlannerOutput {
  label: "Plan A" | "Plan B";
  route: ResolvedRoute;
  result: SubagentResult;
}

interface ExecutionAttempt {
  attempt: number;
  executor: SubagentResult;
  verifier: SubagentResult;
  verdict: VerifierVerdict;
}

interface VerifierVerdict {
  status: "pass" | "fail";
  reasons: string[];
  feedback: string;
  evidence: string[];
  raw: string;
}

// ── Discovery-only helpers ─────────────────────────────────────────────────

/**
 * Clone the agents map and override tools to a read-only allowlist for the
 * planner and verifier (synthesis) agents.  The shared agent profile map is
 * never mutated — this is a shape-local clone.
 */
function buildDiscoveryAgents(
  agents: Map<string, AgentProfile>,
  params: NormalizedParams,
): Map<string, AgentProfile> {
  const cloned = new Map(agents);
  const restrictTools = (name: string) => {
    const original = cloned.get(name);
    if (original && original.tools !== DISCOVERY_READ_ONLY_TOOLS) {
      cloned.set(name, { ...original, tools: [...DISCOVERY_READ_ONLY_TOOLS] });
    }
  };
  restrictTools(params.plannerAgent);
  restrictTools(params.verifierAgent);
  return cloned;
}

/**
 * Fail closed when a discovery-phase subagent lacks tool-call telemetry or
 * has recorded mutating tool calls.  Uses stable named error tokens so
 * callers can detect the failure class without parsing free-form messages.
 */
function checkDiscoveryReadOnly(label: string, result: SubagentResult): void {
  if (!result.toolCalls) {
    throw new Error(
      `DISCOVERY_READ_ONLY_UNPROVEN: ${label} result lacks tool-call telemetry ` +
        `(mutating count unknown). Discovery-only requires attested read-only execution.`,
    );
  }
  if (result.toolCalls.mutating > 0) {
    throw new Error(
      `DISCOVERY_MUTATION_DETECTED: ${label} recorded ${result.toolCalls.mutating} ` +
        `mutating tool call(s) during discovery-only phase. Discovery must be strictly read-only.`,
    );
  }
}

// ── Predicted write-set block helper ───────────────────────────────────────

/**
 * Build the untruncated, clearly delimited BEGIN/END block that is injected
 * into planner and synthesis prompts.  Agents must not plan outside this set;
 * if it is insufficient they must report conflict rather than widen.
 */
function buildPredictedWriteSetBlock(writeSet: string[]): string {
  if (!writeSet || writeSet.length === 0) {
    return "BEGIN_PREDICTED_WRITE_SET\n(empty — no contract-granted writes)\nEND_PREDICTED_WRITE_SET";
  }
  return "BEGIN_PREDICTED_WRITE_SET\n" +
    writeSet.map((entry) => `- ${entry}`).join("\n") +
    "\nEND_PREDICTED_WRITE_SET";
}

// ── Main orchestration ─────────────────────────────────────────────────────

async function runDualPlanSynthesisExecuteVerify(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const spawnGuard = new SpawnGuard(params.maxSubagents);
  const maxRetries = resolveMaxRetries(params);
  const maxAttempts = clampIterations(maxRetries + 1);
  const routes = resolveRoutes(params);

  // All five shape seats map to one of the three normalized role routes that
  // the shared preflight checks before shape dispatch. Keep this mapping
  // visible so preflight coverage is auditable even when several seats share a
  // deduplicated provider/model ping.
  emit(
    `Resolved dual-plan seats (preflight roles): ` +
      `Plan A=planner:${formatRoute(routes.planA)}, ` +
      `Plan B=planner:${formatRoute(routes.planB)}, ` +
      `synthesis=planner:${formatRoute(routes.synthesis)}, ` +
      `executor=executor:${formatRoute(routes.executor)}, ` +
      `verifier=verifier:${formatRoute(routes.verifier)}.`,
  );

  // Normalize the predicted write set ONCE here so every consumer — both
  // planner prompts, the synthesis prompt, and discovery-only details —
  // sees the identical mechanically frozen array.
  const predictedWriteSet = normalizeWriteSet(params.predictedWriteSet);

  // In discovery-only mode, restrict planner/synthesis tools to a read-only
  // allowlist via a shape-local agent-map clone.  The shared profile map is
  // never mutated; normal execution is completely unaffected.
  const effectiveAgents = params.discoveryOnly
    ? buildDiscoveryAgents(agents, params)
    : agents;

  // Checkpoint/resume wiring (ABORT-RESUME-DESIGN.md). Stage indices:
  // 0=planA, 1=planB, 2=synthesis, then 3+2(k-1)=executor-k, 4+2(k-1)=verifier-k.
  const stageNames = ["planA", "planB", "synthesis"];
  for (let k = 1; k <= maxAttempts; k++) stageNames.push(`executor-${k}`, `verifier-${k}`);
  const resume = context.resumeState;
  const store = resume
    ? RunStateStore.open(resume.state.runId)
    : context.runId
      ? RunStateStore.create(context.runId, "dual-plan-synthesis-execute-verify", params.task,
          JSON.parse(JSON.stringify(params)) as Record<string, unknown>, stageNames)
      : undefined;
  const restoreStage = (index: number): SubagentResult | undefined => resume?.checkpoints.get(index);
  const checkpointStage = (index: number, result: SubagentResult): void =>
    store?.checkpointPhase(index, stageNames[index] ?? `stage-${index}`, result);
  /** Collect a detached survivor's result, or undefined to respawn the stage. */
  const collectStage = async (index: number): Promise<SubagentResult | undefined> => {
    const survivor = resume?.survivors.get(index);
    if (!survivor || !store) return undefined;
    const collected = await collectSurvivorResult<SubagentResult>(survivor, emit, signal, "dual-plan-synthesis-execute-verify");
    if (collected) checkpointStage(index, collected);
    return collected;
  };
  const survivalFor = (index: number) =>
    store
      ? {
          abortSurvival: {
            resultFile: store.survivorResultPath(index, stageNames[index] ?? `stage-${index}`),
            manifestFile: store.survivorManifestPath(index, stageNames[index] ?? `stage-${index}`),
            phaseName: stageNames[index] ?? `stage-${index}`,
            phaseIndex: index,
          },
        }
      : {};
  const detachGuard = (index: number, error: unknown): never => {
    if (error instanceof SubagentDetachedError && store) {
      store.markDetached(index, stageNames[index] ?? `stage-${index}`, error.manifest);
      throw new Error(
        `Orchestration aborted mid-stage but the ${stageNames[index]} subagent (pid=${error.manifest.pid}) ` +
          `continues in the background. Resume this run by re-invoking the orchestrate tool with { resume: "${store.runId}" }. ` +
          `Completed stages are checkpointed and will not be re-executed.`,
      );
    }
    throw error as Error;
  };

  emit(
    `dual-plan-synthesis-execute-verify: starting with ${maxRetries} retry slot(s), ` +
      `spawn ceiling ${spawnGuard.cap}${resume ? ` (RESUME of run ${resume.state.runId})` : ""}.`,
  );

  // Phase 1: run independent planners concurrently (restored on resume when checkpointed).
  throwIfAborted(signal);
  let plannerOutputs: PlannerOutput[];
  const restoredPlanA = restoreStage(0);
  const restoredPlanB = restoreStage(1);
  if (restoredPlanA && restoredPlanB) {
    emit("Phase 1: both planner outputs restored from checkpoints (resume).");
    plannerOutputs = [
      { label: "Plan A", route: routeFromResult(restoredPlanA, routes.planA), result: restoredPlanA },
      { label: "Plan B", route: routeFromResult(restoredPlanB, routes.planB), result: restoredPlanB },
    ];
  } else {
    emit("Phase 1: spawning two isolated planners concurrently on the resolved planner role route.");
    plannerOutputs = await runPlannerPhase(
      params,
      effectiveAgents,
      spawnGuard,
      signal,
      emit,
      inheritedModel,
      predictedWriteSet,
      routes,
    );
    checkpointStage(0, plannerOutputs[0].result);
    checkpointStage(1, plannerOutputs[1].result);
  }

  // Discovery-only gate: planner results must be attested read-only before
  // synthesis is spawned.  Failures here prevent any synthesis spawn.
  if (params.discoveryOnly) {
    checkDiscoveryReadOnly("Plan A", plannerOutputs[0].result);
    checkDiscoveryReadOnly("Plan B", plannerOutputs[1].result);
  }

  // Phase 2: critique and synthesize a single executable plan.
  throwIfAborted(signal);
  let synthesis = restoreStage(2);
  if (synthesis) {
    emit("Phase 2: synthesis restored from checkpoint (resume).");
  } else {
    emit("Phase 2: synthesizing planner outputs into one implementation plan.");
    synthesis = await spawnChecked(
      spawnGuard,
      params,
      effectiveAgents,
      params.verifierAgent,
      buildSynthesisPrompt(params.task, plannerOutputs, predictedWriteSet, routes.synthesis),
      signal,
      emit,
      inheritedModel,
      routes.synthesis,
    );
    checkpointStage(2, synthesis);
  }

  // Discovery-only: fail closed, then return predicted write set before any
  // executor/verifier spawn.  Checks cover both freshly-spawned and restored
  // (checkpoint-resume) synthesis results.
  if (params.discoveryOnly) {
    checkDiscoveryReadOnly("synthesis", synthesis);
    emit("Discovery-only mode: synthesis complete. Returning predicted write set without spawning executor/verifier.");
    const markdown = buildDiscoveryOnlyMarkdown(
      params,
      spawnGuard,
      plannerOutputs,
      synthesis,
      predictedWriteSet,
      routes,
    );
    const details = buildDiscoveryOnlyDetails(
      params,
      spawnGuard,
      plannerOutputs,
      synthesis,
      predictedWriteSet,
      routes,
    );
    return { markdown, details };
  }

  // Phase 3/4: bounded execute + verify loop.
  const attempts: ExecutionAttempt[] = [];
  let priorFeedback = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const executorIndex = 3 + (attempt - 1) * 2;
    const verifierIndex = executorIndex + 1;

    throwIfAborted(signal);
    let executor = restoreStage(executorIndex) ?? (await collectStage(executorIndex));
    if (executor) {
      emit(`Phase 3: execution attempt ${attempt}/${maxAttempts} restored (resume).`);
    } else {
      emit(`Phase 3: execution attempt ${attempt}/${maxAttempts}.`);
      try {
        executor = await spawnChecked(
          spawnGuard,
          params,
          agents,
          params.executorAgent,
          buildExecutionPrompt(params.task, synthesis, attempts, priorFeedback, attempt, routes.executor),
          signal,
          emit,
          inheritedModel,
          routes.executor,
          survivalFor(executorIndex),
        );
      } catch (error) {
        detachGuard(executorIndex, error);
        throw error;
      }
      checkpointStage(executorIndex, executor);
    }

    throwIfAborted(signal);
    let verifier = restoreStage(verifierIndex) ?? (await collectStage(verifierIndex));
    if (verifier) {
      emit(`Phase 4: verification attempt ${attempt}/${maxAttempts} restored (resume).`);
    } else {
      emit(`Phase 4: direct-evidence verification for attempt ${attempt}/${maxAttempts}.`);
      try {
        verifier = await spawnChecked(
          spawnGuard,
          params,
          agents,
          params.verifierAgent,
          buildVerifierPrompt(params.task, plannerOutputs, synthesis, attempts, executor, attempt, maxAttempts, routes.verifier),
          signal,
          emit,
          inheritedModel,
          routes.verifier,
          survivalFor(verifierIndex),
        );
      } catch (error) {
        detachGuard(verifierIndex, error);
        throw error;
      }
      checkpointStage(verifierIndex, verifier);
    }
    const verdict = parseVerifierVerdict(verifier.text);
    attempts.push({ attempt, executor, verifier, verdict });

    emit(
      `Verifier attempt ${attempt}/${maxAttempts}: ${verdict.status.toUpperCase()} — ` +
        `${verdict.reasons.join("; ") || "no reasons provided"}`,
    );

    if (verdict.status === "pass") break;
    priorFeedback = verdict.feedback || verdict.reasons.join("; ");
    if (!priorFeedback.trim()) priorFeedback = "Verifier failed without actionable feedback; inspect verifier output directly.";
  }

  const finalAttempt = attempts[attempts.length - 1];
  const status: "pass" | "fail" = finalAttempt?.verdict.status === "pass" ? "pass" : "fail";
  const details = buildDetails(status, params, spawnGuard, plannerOutputs, synthesis, attempts, maxRetries, routes);
  const markdown = buildFinalMarkdown(status, params, spawnGuard, plannerOutputs, synthesis, attempts, maxRetries, routes);
  return { markdown, details };
}

// ── Phases ─────────────────────────────────────────────────────────────────

async function runPlannerPhase(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  predictedWriteSet: string[],
  routes: DualPlanRoutes,
): Promise<PlannerOutput[]> {
  const plannerJobs: Array<{ label: "Plan A" | "Plan B"; route: ResolvedRoute; prompt: string }> = [
    {
      label: "Plan A",
      route: routes.planA,
      prompt: buildPlannerPrompt("Plan A", routes.planA, params.task, predictedWriteSet),
    },
    {
      label: "Plan B",
      route: routes.planB,
      prompt: buildPlannerPrompt("Plan B", routes.planB, params.task, predictedWriteSet),
    },
  ];

  return runBoundedPool(plannerJobs, PLANNER_CONCURRENCY, signal, async (job, _index, workerSignal) => {
    emit(`${job.label}: starting ${job.route.provider}/${job.route.model}.`);
    const result = await spawnChecked(
      spawnGuard,
      params,
      agents,
      params.plannerAgent,
      job.prompt,
      workerSignal,
      emit,
      inheritedModel,
      job.route,
    );
    return { label: job.label, route: job.route, result };
  });
}

function buildPlannerPrompt(
  label: "Plan A" | "Plan B",
  route: { provider: string; model: string },
  task: string,
  predictedWriteSet: string[],
): string {
  return `You are ${label} in a dual-plan-synthesis-execute-verify orchestration.
You should be running as provider=${route.provider}, model=${route.model}.

Original task:
${task}

Authoritative contract-granted write set (do not plan outside it; if insufficient, report conflict rather than widen):
${buildPredictedWriteSetBlock(predictedWriteSet)}

Produce an independent implementation plan only. Do not edit files.

Return concise markdown with:
- scope and non-goals
- target files/functions
- ordered implementation steps
- risks and edge cases
- direct verification steps

Do not assume the other planner's answer.`;
}

function buildSynthesisPrompt(
  task: string,
  plannerOutputs: PlannerOutput[],
  predictedWriteSet: string[],
  route: ResolvedRoute,
): string {
  return `You are the synthesis reviewer in a dual-plan-synthesis-execute-verify orchestration.
You should be running as provider=${route.provider}, model=${route.model}.

Original task:
${task}

Authoritative contract-granted write set (do not plan outside it; if insufficient, report conflict rather than widen):
${buildPredictedWriteSetBlock(predictedWriteSet)}

Independent planner outputs:
${plannerOutputs
  .map((output) => `## ${output.label} (${output.route.provider}/${output.route.model})\n${output.result.text}`)
  .join("\n\n")}

Critique both plans for correctness, safety, minimality, and verification coverage.
Then synthesize exactly one coherent implementation plan for the executor.

Return markdown with:
- accepted ideas
- rejected ideas, if any, and why
- final ordered implementation plan
- invariants / safety constraints
- verification criteria

The executor may implement only this synthesized plan.`;
}

function buildExecutionPrompt(
  task: string,
  synthesis: SubagentResult,
  attempts: ExecutionAttempt[],
  priorFeedback: string,
  attempt: number,
  route: { provider: string; model: string },
): string {
  const retryBlock = attempts.length
    ? `\nPrior attempt summaries and verifier feedback:\n${attempts
        .map((item) =>
          `Attempt ${item.attempt}: ${item.verdict.status.toUpperCase()}\nReasons: ${item.verdict.reasons.join("; ") || "none"}\nFeedback: ${item.verdict.feedback || "none"}`,
        )
        .join("\n\n")}\n\nCurrent retry feedback to address:\n${priorFeedback}`
    : "";

  return `You are the executor in a dual-plan-synthesis-execute-verify orchestration.
You should be running as provider=${route.provider}, model=${route.model}.

Original task:
${task}

Synthesized implementation plan (authoritative):
${synthesis.text}
${retryBlock}

Attempt: ${attempt}

Implement only the synthesized plan and, on retry, only the verifier feedback.
Keep changes minimal and scoped. Do not commit or push.

Return a report with:
- files changed
- exact changes made
- commands/tests run and results
- any unresolved issues.`;
}

function buildVerifierPrompt(
  task: string,
  plannerOutputs: PlannerOutput[],
  synthesis: SubagentResult,
  attempts: ExecutionAttempt[],
  executor: SubagentResult,
  attempt: number,
  maxAttempts: number,
  route: { provider: string; model: string },
): string {
  return `You are the direct-evidence verifier in a dual-plan-synthesis-execute-verify orchestration.
You should be running as provider=${route.provider}, model=${route.model}.

Original task:
${task}

Plan provenance:
${plannerOutputs.map((output) => `- ${output.label}: ${output.route.provider}/${output.route.model}, exitCode=${output.result.exitCode}`).join("\n")}

Synthesized implementation plan:
${synthesis.text}

Prior attempts:
${attempts.length ? attempts.map((item) => `Attempt ${item.attempt}: ${item.verdict.status.toUpperCase()} — ${item.verdict.reasons.join("; ")}`).join("\n") : "none"}

Current executor output (attempt ${attempt}/${maxAttempts}):
${executor.text}

Verify against the original task and synthesized plan using direct evidence. You may inspect files and run safe read-only or test commands if available in your agent tools.

Return JSON exactly and only in this shape:
{"status":"pass"|"fail","reasons":["..."],"feedback":"actionable retry feedback for executor if fail, otherwise empty string","evidence":["direct code/test/diff evidence"]}

Rules:
- PASS only when the implementation clearly satisfies the task and plan.
- FAIL if evidence is missing, scope expanded unsafely, code is syntactically invalid, or the bug remains possible.
- FAIL if evidence shows the visible/current orchestrator executed the main task directly instead of routing through the requested orchestration shape, or the requested shape was silently replaced.
- On FAIL, feedback must be bounded and actionable for one executor retry.`;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parseVerifierVerdict(text: string): VerifierVerdict {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    const status = String(raw.status ?? "").toLowerCase();
    if (status === "pass" || status === "fail") {
      return {
        status,
        reasons: stringArray(raw.reasons) ?? [],
        feedback: optionalString(raw.feedback) ?? "",
        evidence: stringArray(raw.evidence) ?? [],
        raw: text,
      };
    }
  }
  return {
    status: "fail",
    reasons: ["Verifier output was not parseable as the required JSON."],
    feedback: "Return the verifier response as the required JSON and include direct evidence.",
    evidence: [],
    raw: text,
  };
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  for (const candidate of [trimmed, ...extractFenceContents(trimmed), extractBalancedObject(trimmed)].filter(Boolean) as string[]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractFenceContents(text: string): string[] {
  const results: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) results.push(match[1].trim());
  return results;
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item)).filter(Boolean);
}

// ── Spawn / bounds helpers ─────────────────────────────────────────────────

async function spawnChecked(
  spawnGuard: SpawnGuard,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  agentName: string,
  task: string,
  signal: AbortSignal | undefined,
  onProgress: ((text: string) => void) | undefined,
  inheritedModel: { provider?: string; model?: string } | undefined,
  modelOverride: { model?: string; provider?: string } | undefined,
  extraOptions?: Pick<SpawnSubagentOptions, "abortSurvival"> | Record<string, never>,
): Promise<SubagentResult> {
  const spawned = spawnGuard.reserve();
  onProgress?.(`Spawning subagent ${agentName} (${spawned}/${spawnGuard.cap}) in ${params.cwd}`);
  return spawnSubagent(agentName, task, {
    agents,
    cwd: params.cwd,
    allowLocalModel: params.allowLocalModel,
    signal,
    inheritedModel,
    onProgress,
    modelOverride,
    ...(extraOptions ?? {}),
  });
}

function resolveMaxRetries(params: NormalizedParams): number {
  const requested = params.maxRetriesExplicit ? params.maxRetries : DEFAULT_MAX_RETRIES;
  return Math.max(0, Math.min(Math.trunc(requested), MAX_SHAPE_RETRIES));
}

// ── Result builders ────────────────────────────────────────────────────────

function formatRoute(route: ResolvedRoute): string {
  return `${route.provider}/${route.model}`;
}

function routeFromResult(result: SubagentResult, fallback: ResolvedRoute): ResolvedRoute {
  return {
    provider: result.provider ?? fallback.provider,
    model: result.model ?? fallback.model,
  };
}

function buildRouteResolution(params: NormalizedParams, routes: DualPlanRoutes): Array<Record<string, string>> {
  return [
    { seat: "Plan A", role: "planner", agentName: params.plannerAgent, ...routes.planA },
    { seat: "Plan B", role: "planner", agentName: params.plannerAgent, ...routes.planB },
    { seat: "synthesis", role: "planner", agentName: params.verifierAgent, ...routes.synthesis },
    { seat: "executor", role: "executor", agentName: params.executorAgent, ...routes.executor },
    { seat: "verifier", role: "verifier", agentName: params.verifierAgent, ...routes.verifier },
  ];
}

function buildRoutingEvidence(
  params: NormalizedParams,
  plannerOutputs: PlannerOutput[],
  synthesis: SubagentResult,
  attempts: ExecutionAttempt[],
  routes: DualPlanRoutes,
): Array<Record<string, string | number>> {
  const evidence: Array<Record<string, string | number>> = plannerOutputs.map((output) => ({
    seat: output.label,
    role: "planner",
    agentName: params.plannerAgent,
    ...routeFromResult(output.result, output.route),
    exitCode: output.result.exitCode ?? -1,
  }));
  evidence.push({
    seat: "synthesis",
    role: "planner",
    agentName: params.verifierAgent,
    ...routeFromResult(synthesis, routes.synthesis),
    exitCode: synthesis.exitCode ?? -1,
  });
  for (const attempt of attempts) {
    evidence.push({
      seat: `executor-${attempt.attempt}`,
      role: "executor",
      agentName: params.executorAgent,
      ...routeFromResult(attempt.executor, routes.executor),
      exitCode: attempt.executor.exitCode ?? -1,
    });
    evidence.push({
      seat: `verifier-${attempt.attempt}`,
      role: "verifier",
      agentName: params.verifierAgent,
      ...routeFromResult(attempt.verifier, routes.verifier),
      exitCode: attempt.verifier.exitCode ?? -1,
    });
  }
  return evidence;
}

function buildDetails(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  plannerOutputs: PlannerOutput[],
  synthesis: SubagentResult,
  attempts: ExecutionAttempt[],
  maxRetries: number,
  routes: DualPlanRoutes,
): Record<string, unknown> {
  return {
    status,
    paradigm: "dual-plan-synthesis-execute-verify",
    maxRetries,
    attempts: attempts.length,
    spawnedCount: spawnGuard.spawned,
    spawnedCap: spawnGuard.cap,
    routes,
    routeResolution: buildRouteResolution(params, routes),
    routingEvidence: buildRoutingEvidence(params, plannerOutputs, synthesis, attempts, routes),
    plannerOutputs: plannerOutputs.map((output) => ({
      label: output.label,
      provider: output.route.provider,
      model: output.route.model,
      exitCode: output.result.exitCode,
      durationMs: output.result.durationMs,
      text: truncateWithNotice(output.result.text, MAX_DETAIL_TEXT_CHARS, `${output.label} output`),
    })),
    synthesis: {
      ...routeFromResult(synthesis, routes.synthesis),
      exitCode: synthesis.exitCode,
      durationMs: synthesis.durationMs,
      text: truncateWithNotice(synthesis.text, MAX_DETAIL_TEXT_CHARS, "synthesis output"),
    },
    executionAttempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      executorRoute: routeFromResult(attempt.executor, routes.executor),
      verifierRoute: routeFromResult(attempt.verifier, routes.verifier),
      executorExitCode: attempt.executor.exitCode,
      verifierExitCode: attempt.verifier.exitCode,
      verdict: attempt.verdict.status,
      reasons: attempt.verdict.reasons,
      feedback: attempt.verdict.feedback,
      evidence: attempt.verdict.evidence,
      executorText: truncateWithNotice(attempt.executor.text, MAX_DETAIL_TEXT_CHARS, `attempt ${attempt.attempt} executor output`),
      verifierText: truncateWithNotice(attempt.verifier.text, MAX_DETAIL_TEXT_CHARS, `attempt ${attempt.attempt} verifier output`),
    })),
    task: params.task,
  };
}

function buildFinalMarkdown(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  plannerOutputs: PlannerOutput[],
  synthesis: SubagentResult,
  attempts: ExecutionAttempt[],
  maxRetries: number,
  routes: DualPlanRoutes,
): string {
  const lines = [
    `# Dual-Plan-Synthesis-Execute-Verify Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${params.task}`,
    "**Paradigm:** dual-plan-synthesis-execute-verify",
    `**Routes:** Plan A=${formatRoute(routes.planA)}; Plan B=${formatRoute(routes.planB)}; Synthesis=${formatRoute(routes.synthesis)}; Executor=${formatRoute(routes.executor)}; Verifier=${formatRoute(routes.verifier)}`,
    "**Preflight role coverage:** Plan A=planner; Plan B=planner; Synthesis=planner; Executor=executor; Verifier=verifier.",
    `**Retry policy:** up to ${maxRetries} executor retry slot(s); stop on verifier PASS or retry exhaustion.`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    "## Planner outputs",
    ...plannerOutputs.map(
      (output) =>
        `### ${output.label} (${output.route.provider}/${output.route.model})\n${truncateWithNotice(output.result.text, 2500, `${output.label} output`)}`,
    ),
    "",
    "## Synthesized plan",
    truncateWithNotice(synthesis.text, 3500, "synthesis output"),
    "",
    "## Execute / verify attempts",
  ];

  for (const attempt of attempts) {
    lines.push(
      `### Attempt ${attempt.attempt}: ${attempt.verdict.status.toUpperCase()}`,
      `Reasons: ${attempt.verdict.reasons.join("; ") || "none"}`,
      attempt.verdict.evidence.length ? `Evidence: ${attempt.verdict.evidence.join("; ")}` : "Evidence: none recorded",
      attempt.verdict.feedback ? `Retry feedback: ${attempt.verdict.feedback}` : "Retry feedback: none",
      "",
      "Executor summary:",
      truncateWithNotice(attempt.executor.text, 2500, `attempt ${attempt.attempt} executor output`),
      "",
      "Verifier output:",
      truncateWithNotice(attempt.verifier.text, 2500, `attempt ${attempt.attempt} verifier output`),
      "",
    );
  }

  // Build the closing narrative from observed result metadata where available;
  // restored checkpoints therefore remain truthful rather than being relabelled
  // with a later process/session default.
  const synthesisRoute = routeFromResult(synthesis, routes.synthesis);
  const finalAttempt = attempts[attempts.length - 1];
  const executorRoute = finalAttempt
    ? routeFromResult(finalAttempt.executor, routes.executor)
    : routes.executor;
  const verifierRoute = finalAttempt
    ? routeFromResult(finalAttempt.verifier, routes.verifier)
    : routes.verifier;
  lines.push(
    "## Orchestration Used",
    `Two isolated routed planners ran concurrently ` +
      `(${formatRoute(plannerOutputs[0]?.route ?? routes.planA)} and ${formatRoute(plannerOutputs[1]?.route ?? routes.planB)}), ` +
      `the synthesis reviewer (${formatRoute(synthesisRoute)}) produced the authoritative plan, ` +
      `the executor (${formatRoute(executorRoute)}) implemented it, ` +
      `and the verifier (${formatRoute(verifierRoute)}) gated completion ` +
      `with direct evidence and bounded retry feedback. Orchestrator Role Integrity: the requested shape was ` +
      `preserved; execution was routed through the executor subagent.`,
  );

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_MARKDOWN_CHARS, "final report");
}

// ── Discovery-only helpers ────────────────────────────────────────────────

function normalizeWriteSet(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    // Split comma-separated entries and trim each.
    for (const part of entry.split(",")) {
      const trimmed = part.trim().replace(/\\/g, "/");
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        normalized.push(trimmed);
      }
    }
  }
  return normalized;
}

function buildDiscoveryOnlyMarkdown(
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  plannerOutputs: PlannerOutput[],
  synthesis: SubagentResult,
  writeSet: string[],
  routes: DualPlanRoutes,
): string {
  const lines = [
    "# Discovery-only manifest",
    "",
    `**Task:** ${params.task}`,
    "**Paradigm:** dual-plan-synthesis-execute-verify",
    `**Mode:** discovery-only (no executor/verifier spawned)`,
    `**Routes:** Plan A=${formatRoute(routes.planA)}; Plan B=${formatRoute(routes.planB)}; Synthesis=${formatRoute(routes.synthesis)}`,
    "**Preflight role coverage:** Plan A=planner; Plan B=planner; Synthesis=planner.",
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    "## Predicted write set",
    ...(writeSet.length ? writeSet.map((p) => `- \`${p}\``) : ["- (empty — no files predicted)"]),
    "",
    "## Planner outputs",
    ...plannerOutputs.map(
      (output) =>
        `### ${output.label} (${output.route.provider}/${output.route.model})\n${truncateWithNotice(output.result.text, 2500, `${output.label} output`)}`,
    ),
    "",
    "## Synthesized plan",
    truncateWithNotice(synthesis.text, 3500, "synthesis output"),
  ];
  return truncateWithNotice(lines.join("\n"), MAX_FINAL_MARKDOWN_CHARS, "discovery manifest");
}

function buildDiscoveryOnlyDetails(
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  plannerOutputs: PlannerOutput[],
  synthesis: SubagentResult,
  writeSet: string[],
  routes: DualPlanRoutes,
): Record<string, unknown> {
  return {
    status: "discovery-only",
    mode: "discovery-only",
    paradigm: "dual-plan-synthesis-execute-verify",
    predictedWriteSet: writeSet,
    routes,
    routeResolution: buildRouteResolution(params, routes),
    routingEvidence: buildRoutingEvidence(params, plannerOutputs, synthesis, [], routes),
    spawnedCount: spawnGuard.spawned,
    spawnedCap: spawnGuard.cap,
    plannerOutputs: plannerOutputs.map((output) => ({
      label: output.label,
      provider: output.route.provider,
      model: output.route.model,
      exitCode: output.result.exitCode,
      durationMs: output.result.durationMs,
      text: truncateWithNotice(output.result.text, MAX_DETAIL_TEXT_CHARS, `${output.label} output`),
    })),
    synthesis: {
      ...routeFromResult(synthesis, routes.synthesis),
      exitCode: synthesis.exitCode,
      durationMs: synthesis.durationMs,
      text: truncateWithNotice(synthesis.text, MAX_DETAIL_TEXT_CHARS, "synthesis output"),
    },
    task: params.task,
  };
}
