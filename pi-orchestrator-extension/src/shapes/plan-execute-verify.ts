/**
 * Shape: plan-execute-verify
 * ===========================
 * The default orchestration shape. Implements the classic
 * planner → executor waves → verifier control flow.
 *
 * This shape is a sibling: it stands on the substrate and does NOT
 * import, extend, or call any other shape. It uses only substrate
 * primitives (spawnSubagent, runBoundedPool, buildExecutionWaves,
 * runWorkGraph, SpawnGuard, SUBSTRATE_CAPS, etc.).
 *
 * Behavior preserved from the original /orchestrate:
 * - planner → executor waves → verifier
 * - normalized loop controls drive max attempts (default maxRetries=2 → 3 attempts)
 * - failureReasons fed back into the next planning prompt
 * - deterministic model routing check in the shape
 * - auto-raise spawn ceiling when plan size demands it
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import {
  SpawnGuard,
  SUBSTRATE_CAPS,
  clampIterations,
  spawnSubagent,
  runWorkGraph,
  buildExecutionWaves,
  formatRoutedModel,
  truncateWithNotice,
  throwIfAborted,
  type AgentProfile,
  type SubagentResult,
} from "../substrate";

import {
  computeAdaptiveTaskSizeCap,
  estimateExecutorContextBudget,
  type ContextBudget,
} from "../executor-recovery/budget-estimator";

import {
  injectContinuationGuardrail,
  buildExecutorContinuationPrompt,
  type ExecutorContinuationContract,
} from "../executor-recovery/contract-types";

import {
  splitTaskOnFailure,
  buildSubtaskExecutorPrompt,
  chainExecutorOutputs,
} from "../executor-recovery/splitter";

import { buildRecoveryMetadata } from "../executor-recovery/metadata";

import {
  resolveGateDecision,
  buildZeroEffectFindings,
  detectFalsePassContradiction,
  formatToolCallSummary,
  type GateFinding,
  type TaskEffectEvidence,
  type ToolCallSummary,
} from "../judgment";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NormalizedParams,
  InferredModelRouting,
  NaturalLanguageOrchestrationControls,
} from "../types";

// ── PEV-specific types ─────────────────────────────────────────────────────

/**
 * A task in the plan, as output by the planner.
 *
 * Way 1 (planner-named runtime roles): the planner may optionally specify
 * per-task `agent`, `role`, `model`, and `provider`. Unknown agent names
 * fall back to the default executor. Per-task model/provider overrides
 * still flow through the substrate's local-model rejection and spawn ceiling.
 *
 * `role` is a semantic hint for documentation/debugging; the shape uses
 * `agent` for actual spawn routing.
 */
interface PlanTask {
  id: string;
  description: string;
  dependsOn: string[];
  /** Way 1: optional agent name override for this task. Unknown agents fall back to the default executor. */
  agent?: string;
  /** Way 1: optional semantic role hint (e.g. "code-reviewer", "architect"). */
  role?: string;
  /** Way 1: optional per-task model override (clamped through substrate). */
  model?: string;
  /** Way 1: optional per-task provider override (subject to local-model rejection). */
  provider?: string;
  /** Output type classification set by the planner. Enforced pre-verifier. */
  outputType?: TaskOutputType;
}

interface Plan {
  tasks: PlanTask[];
  notes: string;
  raw?: unknown;
}

interface ExecutorOutput {
  taskId: string;
  description: string;
  agentName: string;
  output: string;
  stderr?: string;
  exitCode: number | null;
  durationMs: number;
  contextBudget?: ContextBudget;
  truncated?: boolean;
  contextExhaustionSignal?: boolean;
  /** Pre-execution git snapshot captured before this executor was spawned. */
  preExecSnapshot?: GitSnapshot;
  /** Parsed output suffix contract from the executor response (Change 3). */
  outputSuffix?: ExecutorOutputSuffix;
  /** Effect evidence: tool-call telemetry for this task's subagent(s) (F1). */
  toolCalls?: ToolCallSummary;
  /** Effect evidence: worktree files changed during this task's window (F1). */
  filesChanged?: number;
  changedFiles?: string[];
}

/**
 * Pre-execution git snapshot captured before an executor spawn.
 * Used as the baseline for post-execution diff comparison to
 * determine exactly what the executor changed on disk.
 */
interface GitSnapshot {
  /** Whether git is available and the snapshot was captured successfully. */
  success: boolean;
  /** ISO-8601 timestamp of the snapshot capture. */
  timestamp: string;
  /** Parsed git status entries (status code + relative path). */
  files: Array<{ status: string; path: string }>;
  /** Raw git status --short output for debugging / fallback. */
  rawStatus: string;
}

/**
 * Post-execution diff computed against a pre-execution GitSnapshot.
 * Represents files the executor created, modified, or deleted.
 */
interface GitDiff {
  /** Total number of files that changed (new + modified + deleted). */
  filesChanged: number;
  /** Files that appear in the post-snapshot but not in the pre-snapshot. */
  newFiles: string[];
  /** Files whose status changed between pre- and post-snapshot. */
  modifiedFiles: string[];
  /** Files that were in the pre-snapshot but are gone in the post-snapshot. */
  deletedFiles: string[];
}

/**
 * Task output type classification.
 *
 * Declared by the planner before dispatch and enforced pre-verifier:
 * - "file_change": task MUST produce disk artifacts (write, edit, create files).
 * - "validation": task checks/inspects existing state — no file changes expected.
 * - "analysis": task produces analysis/reasoning only — no file changes expected.
 */
type TaskOutputType = "file_change" | "validation" | "analysis";

/**
 * Executor output suffix contract — a machine-parseable self-report
 * that the executor MUST append to their response. Cross-referenced
 * with git ground truth for lie detection.
 */
interface ExecutorOutputSuffix {
  /** Files the executor claims to have created (absolute or relative paths). */
  files_created: string[];
  /** Files the executor claims to have modified (absolute or relative paths). */
  files_modified: string[];
  /** Commands the executor claims to have run. */
  commands_run: string[];
  /** Whether tests passed (if any were run). */
  tests_passed: boolean;
  /** Exit code of the last command or the executor's proposed exit code. */
  exit_code: number;
}

/**
 * Structured post-execution artifact evidence collected by the orchestrator.
 * Replaces the previous flat string summary with machine-readable fields
 * that enable hard enforcement gates (not prompt-text warnings).
 */
interface ArtifactEvidence {
  /** Human-readable summary for inclusion in verifier prompt. */
  summary: string;
  /** True if any executed task was flagged as an implementation task. */
  hasImplementationTask: boolean;
  /** git status --short output or fallback description when git is unavailable. */
  diskStatus: string;
  /** Filenames parsed from git status --short (ground-truth disk files). */
  diskFiles: string[];
  /** Filenames extracted from executor output text via regex. */
  fileClaims: string[];
  /** Hard gate failure reasons — any non-empty array means the task should auto-fail. */
  hardGateFailures: string[];
  /** Output type contract violations detected post-execution. */
  outputTypeViolations: string[];
  /** Escape clause violations detected in executor output prose (Change 5 integration). */
  escapeClauseViolations: string[];
}

interface RoleModelOverride {
  model?: string;
  provider?: string;
}

interface RoutingRequirement {
  role: "planner" | "executor" | "verifier" | string;
  agentName: string;
  provider?: string;
  model?: string;
  essential: boolean;
  source: "explicit_flag" | "natural_language" | "agent_profile" | "inherited";
  /** Required evidence count for runtime roles such as researcher. */
  count?: number;
}

interface Intake {
  originalTask: string;
  taskSummary: string;
  taskType: string;
  userIntent: string;
  goalAttractor: string;
  taskScope: string;
  constraints: string[];
  invariants: string[];
  successCriteria: string[];
  failureCriteria: string[];
  nonGoals: string[];
  ambiguities: string[];
  routingDecision: string;
  routingRequirements: RoutingRequirement[];
  orchestrationControls: NaturalLanguageOrchestrationControls;
  executorOutputContract?: string;
}

interface RoutingCheck {
  status: "pass" | "fail";
  reasons: string[];
}

interface RoutingEvidence {
  phaseRole: "planner" | "executor" | "verifier";
  agentName: string;
  provider?: string;
  model?: string;
  taskId?: string;
  semanticRole?: string;
  evidence: string;
}

interface OrchestrationState {
  attempt: number;
  spawnGuard: SpawnGuard;
  plan: Plan | null;
  planText: string;
  executorOutputs: ExecutorOutput[];
  verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string } | null;
  failureReasons: string[];
  finalResult: string;
  progressLog: string[];
  intake: Intake | null;
  routingEvidence: RoutingEvidence[];
  routingCheck: RoutingCheck | null;
  attempts: Array<{
    attempt: number;
    plan: Plan;
    plannerText: string;
    executorOutputs: ExecutorOutput[];
    verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string };
  }>;
  recoveryLog: string[];
  recoveryDepth: number;
  maxRecoveryDepth: number;
  /** Demoted text-shape findings carried in the report (F1). */
  gateWarnings: string[];
}

// ── Termination policy (Phase 4) ───────────────────────────────────────────

/**
 * Termination policy that the planner may propose in the plan JSON.
 * The shape reads this from the plan and applies it through the
 * precedence chain described in resolveMaxAttempts().
 *
 * BOUNDED GUARANTEE (substrate): any final maxAttempts value is
 * clamped through clampIterations() to ABSOLUTE_MAX_ITERATIONS.
 * The *meaning* of termination (what maxAttempts represents) is
 * entirely shape-owned.
 */
interface TerminationPolicy {
  /** Maximum total attempts (including initial + retries). */
  maxAttempts?: number;
}

// ── Constants (shape-owned) ────────────────────────────────────────────────

const MAX_FINAL_MARKDOWN_CHARS = 20_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_EXECUTOR_MARKDOWN_CHARS = 6_000;
const DEFAULT_MAX_SUBAGENTS = 12;
/** Shape-level cap is clamped through the substrate. */
const MAX_SUBAGENTS_LIMIT = SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS;

// ── Shape export ───────────────────────────────────────────────────────────

export const planExecuteVerifyShape: OrchestrationShape = {
  name: "plan-execute-verify",
  description:
    "Classic planner → executor waves → verifier control flow. " +
    "Default paradigm for /orchestrate. Supports retries with failure feedback, " +
    "deterministic model routing checks, and auto-raised spawn ceilings.",
  run: runPlanExecuteVerify,
};

// ── Main orchestration loop ────────────────────────────────────────────────

/**
 * Runs the plan-execute-verify loop.
 *
 * Guarantees:
 * - Planner spawn, then executor waves (via substrate buildExecutionWaves +
 *   runWorkGraph), then verifier spawn.
 * - total attempts follow normalized loop controls, with maxRetries + 1 as the default.
 * - failureReasons from each failed verification are fed back into the next
 *   planning prompt.
 * - Deterministic model routing check runs after verifier completion.
 * - All spawns are bounded by the substrate SpawnGuard.
 */
async function runPlanExecuteVerify(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents, inferredModelRouting } = context;
  const state: OrchestrationState = {
    attempt: 0,
    spawnGuard: new SpawnGuard(params.maxSubagents),
    plan: null,
    planText: "",
    executorOutputs: [],
    verifierResult: null,
    failureReasons: [],
    finalResult: "",
    progressLog: [],
    intake: null,
    routingEvidence: [],
    routingCheck: null,
    attempts: [],
    recoveryLog: [],
    recoveryDepth: 0,
    maxRecoveryDepth: 3,
    gateWarnings: [],
  };

  const emit = (text: string) => {
    const line = `[${new Date().toISOString()}] ${text}`;
    state.progressLog.push(line);
    onUpdate?.({ content: [{ type: "text", text }] });
  };

  state.intake = buildIntake(params, agents, inheritedModel, inferredModelRouting);
  emit(`Intake complete: ${state.intake.taskSummary}`);
  if (state.intake.routingRequirements.length) {
    emit(
      `Intake marked model routing essential: ${state.intake.routingRequirements
        .map((req) => `${req.role}=${formatRoutedModel(req.provider, req.model)}`)
        .join(", ")}`,
    );
  }

  // Phase 4: termination policy is resolved after the first planner run.
  // Normalized intake/orchestrationControls are the source of truth for
  // natural-language loop terms. The planner may propose
  // terminationPolicy.maxAttempts in the plan JSON. Until resolved, use
  // the default (maxRetries + 1) as a baseline.
  let resolvedMaxAttempts: number | undefined;

  for (
    let attempt = 1;
    attempt <= (resolvedMaxAttempts ?? params.maxRetries + 1);
    attempt++
  ) {
    throwIfAborted(signal);
    state.attempt = attempt;
    emit(
      `Orchestration attempt ${attempt}/${resolvedMaxAttempts ?? params.maxRetries + 1}: planning...`,
    );

    const plannerPrompt = buildPlanningPrompt(state.intake, attempt, state.failureReasons);
    const planner = await spawnChecked(
      state,
      params,
      agents,
      params.plannerAgent,
      "planner",
      plannerPrompt,
      signal,
      emit,
      inheritedModel,
      toModelOverride(params.plannerModel, params.plannerProvider),
    );
    state.planText = planner.text;
    const plan = enforceTaskSizeCap(parsePlan(planner.text, params.task), computeAdaptiveTaskSizeCap(params.executorModel));
    const executionWaves = buildExecutionWaves(plan.tasks);
    state.plan = plan;

    // ── Phase 4: termination policy resolution (first iteration only) ────
    // Resolved once after the planner produces a plan. Precedence:
    //   explicit maxRetries/max-retries param >
    //   normalized natural-language orchestrationControls maxAttempts/maxRetries >
    //   planner-proposed terminationPolicy.maxAttempts >
    //   default (maxRetries: 2 → 3 attempts).
    // Final value is clamped through substrate clampIterations().
    if (resolvedMaxAttempts === undefined) {
      const plannerTerminationPolicy = parseTerminationPolicyFromPlan(plan);
      resolvedMaxAttempts = clampIterations(
        resolveMaxAttempts(params, plannerTerminationPolicy),
      );
      emit(
        `Termination policy resolved: maxAttempts=${resolvedMaxAttempts} ` +
          `(source: ${describeTerminationSource(params, plannerTerminationPolicy)}).`,
      );
    }

    const maxAttemptsForBudget = resolvedMaxAttempts ?? params.maxRetries + 1;

    const requiredBudget = computeRequiredSubagentBudget(
      state.spawnGuard.spawned,
      plan.tasks.length,
      attempt,
      maxAttemptsForBudget,
    );
    if (!params.maxSubagentsExplicit && requiredBudget > params.maxSubagents) {
      const previous = params.maxSubagents;
      params.maxSubagents = Math.min(requiredBudget, MAX_SUBAGENTS_LIMIT);
      // Keep the SpawnGuard cap in sync; raiseCeiling is monotonic and clamped by substrate.
      state.spawnGuard.raiseCeiling(params.maxSubagents);
      emit(
        `Auto-raised maxSubagents from ${previous} to ${params.maxSubagents} based on plan size (${plan.tasks.length} executor task(s)) and retry budget (${maxAttemptsForBudget} attempt(s)).`,
      );
      if (requiredBudget > MAX_SUBAGENTS_LIMIT) {
        emit(
          `Required subagent budget ${requiredBudget} exceeds hard safety limit ${MAX_SUBAGENTS_LIMIT}; orchestration may still stop if the ceiling is reached.`,
        );
      }
    } else if (params.maxSubagentsExplicit) {
      emit(
        `Using explicit maxSubagents=${params.maxSubagents}; auto-raise is disabled for this run.`,
      );
    }

    const remainingAfterPlan = state.spawnGuard.remaining;
    const neededForExecutionAndVerify = plan.tasks.length + 1;
    if (neededForExecutionAndVerify > remainingAfterPlan) {
      throw new Error(
        `Subagent ceiling exceeded after planning: need ${neededForExecutionAndVerify} more spawn(s), remaining ${remainingAfterPlan}, maxSubagents=${params.maxSubagents}. Try /orchestrate --max-subagents ${requiredBudget} ... or reduce --max-retries.`,
      );
    }

    emit(
      `Attempt ${attempt}: executing ${plan.tasks.length} task(s) across ${executionWaves.length} dependency wave(s) with concurrency ${params.concurrency}...`,
    );
    const executorOutputs = await runWorkGraph(
      executionWaves,
      params.concurrency,
      signal,
      async (task, _index, _workerSignal) => {
        return executeExecutorTaskWithRecovery(
          state, params, agents, task, plan, signal, emit,
          inheritedModel, inferredModelRouting,
        );
      },
    );
    state.executorOutputs = executorOutputs;

    emit(`Attempt ${attempt}: collecting artifact evidence...`);
    // Build a map of taskId → preExecSnapshot for per-task diff comparison
    const preExecSnapshotMap = new Map<string, GitSnapshot>();
    for (const output of executorOutputs) {
      if (output.preExecSnapshot?.success) {
        preExecSnapshotMap.set(output.taskId, output.preExecSnapshot);
      }
    }
    const outputTypes = new Map<string, TaskOutputType>();
    for (const task of plan.tasks) {
      const ot = task.outputType ?? classifyTaskOutputType(task);
      if (ot) outputTypes.set(task.id, ot);
    }
    const artifactEvidence = collectArtifactEvidence(
      params.cwd,
      executorOutputs,
      {
        preExecSnapshots: preExecSnapshotMap.size > 0 ? preExecSnapshotMap : undefined,
        outputTypes: outputTypes.size > 0 ? outputTypes : undefined,
      },
    );
    const qualityFailures = detectExecutorOutputQualityFailures(executorOutputs, artifactEvidence);

    // ── Judgment layer (F1): classify findings, demote text-shape heuristics ─
    const effectEvidenceByTask = new Map<string, TaskEffectEvidence>();
    for (const output of executorOutputs) {
      effectEvidenceByTask.set(output.taskId, {
        taskId: output.taskId,
        isImplementationTask: isImplementationTask(output),
        mutatingToolCalls: output.toolCalls?.mutating ?? 0,
        totalToolCalls: output.toolCalls?.total ?? 0,
        filesChanged: output.filesChanged,
      });
    }
    const isEffectFinding = (message: string) =>
      /EXECUTOR DIFF GATE FAILURE|POST-EXECUTION GATE FAILURE|SUFFIX-GIT CROSS-REFERENCE FAILURE/.test(message);
    const findingTaskId = (message: string) => {
      const match = message.match(/\b(task[-_][\w.-]+)/i);
      return match && executorOutputs.some((o) => o.taskId === match[1]) ? match[1] : undefined;
    };
    const textShapeFindings: GateFinding[] = [];
    const effectFindingList: GateFinding[] = [];
    for (const message of [...(artifactEvidence?.hardGateFailures ?? []), ...qualityFailures]) {
      const finding: GateFinding = { message, kind: isEffectFinding(message) ? "effect" : "text-shape" };
      const taskId = findingTaskId(message);
      if (taskId) finding.taskId = taskId;
      (finding.kind === "effect" ? effectFindingList : textShapeFindings).push(finding);
    }
    for (const finding of buildZeroEffectFindings(effectEvidenceByTask)) {
      if (!effectFindingList.some((existing) => existing.taskId === finding.taskId)) {
        effectFindingList.push(finding);
      }
    }
    const gateDecision = resolveGateDecision({
      mode: params.hardGates,
      textShapeFindings,
      effectFindings: effectFindingList,
      effectEvidenceByTask,
    });
    if (gateDecision.warnings.length > 0) {
      state.gateWarnings.push(...gateDecision.warnings.map((warning) => `Attempt ${attempt}: ${warning}`));
      emit(`Attempt ${attempt}: ${gateDecision.warnings.length} gate warning(s) recorded (advisory — never verdict-determining on their own).`);
    }
    const allHardFailures = gateDecision.preVerifierFailures;

    if (allHardFailures.length > 0) {
      emit(`Attempt ${attempt}: HARD GATE failures (mode=strict) detected before verification — ${allHardFailures.length} failure(s): ${allHardFailures.join("; ")}`);
      const verifierResult = {
        status: "fail" as const,
        reasons: allHardFailures.map((f) => `Post-execution hard gate: ${f}`),
        raw: JSON.stringify({ status: "fail", reasons: allHardFailures }),
      };
      state.routingCheck = checkRequiredModelRouting(params, state);
      if (state.routingCheck.status === "fail") {
        verifierResult.reasons.push(
          ...state.routingCheck.reasons.map((reason) => `Deterministic model routing check failed: ${reason}`),
        );
      }
      state.verifierResult = verifierResult;
      state.attempts.push({
        attempt,
        plan,
        plannerText: planner.text,
        executorOutputs,
        verifierResult,
      });
      const reasons = verifierResult.reasons.length
        ? verifierResult.reasons
        : ["Post-execution hard gate triggered but no reasons captured."];
      state.failureReasons.push(...reasons.map((reason) => `Attempt ${attempt}: ${reason}`));

      if (attempt >= maxAttemptsForBudget) break;
      if (!state.spawnGuard.wouldFit(1)) {
        throw new Error(
          `Subagent ceiling reached before retry: spawned ${state.spawnGuard.spawned}/${state.spawnGuard.cap}.`,
        );
      }
      continue;
    }

    emit(`Attempt ${attempt}: verifying executor outputs...`);
    const verifierPrompt = buildVerificationPrompt(
      state.intake!,
      plan,
      executorOutputs,
      buildRoutingEvidenceForVerifier(params, state),
      artifactEvidence?.summary,
    );
    const verifier = await spawnChecked(
      state,
      params,
      agents,
      params.verifierAgent,
      "verifier",
      verifierPrompt,
      signal,
      emit,
      inheritedModel,
      toModelOverride(params.verifierModel, params.verifierProvider),
    );
    const verifierResult = parseVerifierResult(verifier.text);
    state.routingCheck = checkRequiredModelRouting(params, state);
    if (verifierResult.status === "pass" && state.routingCheck.status === "fail") {
      verifierResult.status = "fail";
      verifierResult.reasons.push(
        ...state.routingCheck.reasons.map(
          (reason) => `Deterministic model routing check failed: ${reason}`,
        ),
      );
    }

    // ── False-PASS guard (F1 #3 / 2026-06-03 case): hard gates may only
    //    escalate on effect-based contradictions. ────────────────────────
    if (verifierResult.status === "pass" && params.hardGates !== "off") {
      const escalations = [...gateDecision.escalations];
      if (escalations.length === 0) {
        const contradiction = detectFalsePassContradiction({
          hasImplementationTask: artifactEvidence?.hasImplementationTask ?? false,
          anyMutatingToolCalls: executorOutputs.some((o) => (o.toolCalls?.mutating ?? 0) > 0),
          anyFilesChanged: executorOutputs.some((o) => (o.filesChanged ?? 0) > 0),
          gitAvailable: !((artifactEvidence?.diskStatus ?? "").startsWith("(git")),
        });
        if (contradiction) escalations.push(contradiction);
      }
      if (escalations.length > 0) {
        verifierResult.status = "fail";
        verifierResult.reasons.push(
          ...escalations.map((e) => `Post-verification effect contradiction (false-PASS guard): ${e}`),
        );
        emit(`Attempt ${attempt}: verifier returned PASS but effect evidence contradicts it — forcing FAIL (${escalations.length} contradiction(s)).`);
      }
    }
    state.verifierResult = verifierResult;

    state.attempts.push({
      attempt,
      plan,
      plannerText: planner.text,
      executorOutputs,
      verifierResult,
    });

    if (verifierResult.status === "pass") {
      state.finalResult = buildFinalResult("pass", params, state);
      return {
        markdown: state.finalResult,
        details: buildDetails("pass", params, state),
      };
    }

    const reasons = verifierResult.reasons.length
      ? verifierResult.reasons
      : ["Verifier did not return a pass result."];
    state.failureReasons.push(...reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
    emit(`Attempt ${attempt}: verification failed (${reasons.join("; ")}).`);

    if (attempt >= maxAttemptsForBudget) break;
    if (!state.spawnGuard.wouldFit(1)) {
      throw new Error(
        `Subagent ceiling reached before retry: spawned ${state.spawnGuard.spawned}/${state.spawnGuard.cap}.`,
      );
    }
  }

  state.finalResult = buildFinalResult("fail", params, state);
  return {
    markdown: state.finalResult,
    details: buildDetails("fail", params, state),
  };
}

// ── Intake building ────────────────────────────────────────────────────────

function buildIntake(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
): Intake {
  const constraints = extractConstraintLines(params.task);
  const executorOutputContract = extractExecutorOutputContract(params.task);
  const orchestrationControls = params.orchestrationControls;
  const routingRequirements = buildRoutingRequirements(
    params,
    agents,
    inheritedModel,
    inferredModelRouting,
  );
  const essentialRoutingRequirements = routingRequirements.filter((req) => req.essential);
  const successCriteria = extractSuccessCriteria(params.task);
  if (essentialRoutingRequirements.length) {
    successCriteria.unshift(
      ...essentialRoutingRequirements.map(
        (req) =>
          `Model routing evidence must show ${req.role} (${req.agentName}) used ${formatRoutedModel(req.provider, req.model)}.`,
      ),
    );
  }
  if (executorOutputContract)
    successCriteria.push(
      `Executor outputs must satisfy this output contract: ${executorOutputContract}`,
    );
  if (orchestrationControls.maxSubagents !== undefined)
    successCriteria.push(
      `Orchestrator must honor the natural-language maxSubagents ceiling: ${orchestrationControls.maxSubagents}.`,
    );
  if (orchestrationControls.concurrency !== undefined)
    successCriteria.push(
      `Orchestrator must honor the natural-language executor concurrency: ${orchestrationControls.concurrency}.`,
    );
  if (orchestrationControls.maxAttempts !== undefined)
    successCriteria.push(
      `Looping/termination policy must honor at most ${orchestrationControls.maxAttempts} total attempt(s).`,
    );
  if (orchestrationControls.maxRetries !== undefined)
    successCriteria.push(
      `Looping/termination policy must honor at most ${orchestrationControls.maxRetries} retry/retries.`,
    );
  if (orchestrationControls.researcherCount !== undefined)
    successCriteria.push(
      `Planner/execution must include ${orchestrationControls.researcherCount} researcher subagent task(s).`,
    );
  if (orchestrationControls.perspectiveCount !== undefined)
    successCriteria.push(
      `Researcher work must cover ${orchestrationControls.perspectiveCount} distinct perspective(s).`,
    );

  const failureCriteria = extractFailureCriteria(params.task);
  if (essentialRoutingRequirements.length)
    failureCriteria.push(
      "Any required model routing mismatch is a deterministic FAIL, even if task outputs are otherwise correct.",
    );
  if (executorOutputContract)
    failureCriteria.push(
      "Executor output that violates the output contract is a FAIL, even if semantically correct.",
    );

  return {
    originalTask: params.task,
    taskSummary: summarizeTask(params.task),
    taskType: "deterministic planner/executor/verifier orchestration",
    userIntent: inferIntent(params.task),
    goalAttractor:
      "A PASS result with executor outputs matching the requested work and all essential constraints visibly satisfied.",
    taskScope:
      "Only the work described in the original task and normalized intake contract is in scope.",
    constraints,
    invariants: [
      "Do not reinterpret explicit user constraints as optional preferences.",
      "Do not treat model routing requirements as executor work; they are orchestrator-level requirements.",
      "Preserve explicit output-format requirements exactly when provided.",
    ],
    successCriteria: successCriteria.length
      ? successCriteria
      : ["Verifier can observe that executor outputs satisfy the original task."],
    failureCriteria,
    nonGoals: extractNonGoals(params.task),
    ambiguities: [],
    routingDecision: essentialRoutingRequirements.length
      ? "Model routing is essential and must be satisfied by orchestrator subprocess configuration."
      : "No explicit or inferred essential model routing was requested; use profile/inherited/default routing.",
    routingRequirements,
    orchestrationControls,
    executorOutputContract,
  };
}

function formatIntakeForPrompt(intake: Intake): string {
  return JSON.stringify(
    {
      task_summary: intake.taskSummary,
      task_type: intake.taskType,
      user_intent: intake.userIntent,
      goal_attractor: intake.goalAttractor,
      task_scope: intake.taskScope,
      constraints: intake.constraints,
      invariants: intake.invariants,
      success_criteria: intake.successCriteria,
      failure_criteria: intake.failureCriteria,
      non_goals: intake.nonGoals,
      ambiguities: intake.ambiguities,
      routing_decision: intake.routingDecision,
      routing_requirements: intake.routingRequirements,
      orchestration_controls: intake.orchestrationControls,
      executor_output_contract: intake.executorOutputContract,
      original_task: intake.originalTask,
    },
    null,
    2,
  );
}

/**
 * Produce an executor-relevant minified version of the intake contract.
 *
 * Strips orchestrator-level fields (routing requirements, routing decision,
 * orchestration controls, non_goals, ambiguities) that are irrelevant to
 * executor subagents. Preserves only the fields the executor MUST respect:
 * constraints, invariants, success_criteria, failure_criteria,
 * executor_output_contract, and original_task.
 *
 * This reduces prompt bloat, keeping precious context budget for the actual
 * implementation work rather than intake metadata the executor cannot act on.
 */
function promptMinification(intake: Intake): string {
  return JSON.stringify(
    {
      task_summary: intake.taskSummary,
      task_type: intake.taskType,
      user_intent: intake.userIntent,
      goal_attractor: intake.goalAttractor,
      task_scope: intake.taskScope,
      constraints: intake.constraints,
      invariants: intake.invariants,
      success_criteria: intake.successCriteria,
      failure_criteria: intake.failureCriteria,
      executor_output_contract: intake.executorOutputContract,
      original_task: intake.originalTask,
    },
    null,
    2,
  );
}

// ── Routing (shape-owned) ──────────────────────────────────────────────────

function buildRoutingRequirements(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredFromTask: InferredModelRouting,
): RoutingRequirement[] {
  const roles: Array<{
    role: RoutingRequirement["role"];
    agentName: string;
    provider?: string;
    model?: string;
    explicit: boolean;
    inferred?: { model?: string; provider?: string };
  }> = [
    {
      role: "planner",
      agentName: params.plannerAgent,
      provider: params.plannerProvider,
      model: params.plannerModel,
      explicit: Boolean(params.plannerProvider || params.plannerModel),
      inferred: inferredFromTask.planner,
    },
    {
      role: "executor",
      agentName: params.executorAgent,
      provider: params.executorProvider,
      model: params.executorModel,
      explicit: Boolean(params.executorProvider || params.executorModel),
      inferred: inferredFromTask.executor,
    },
    {
      role: "verifier",
      agentName: params.verifierAgent,
      provider: params.verifierProvider,
      model: params.verifierModel,
      explicit: Boolean(params.verifierProvider || params.verifierModel),
      inferred: inferredFromTask.verifier,
    },
  ];
  const requirements = roles
    .map((role) => {
      const profile = agents.get(role.agentName);
      const provider = role.provider ?? role.inferred?.provider ?? profile?.provider ?? inheritedModel?.provider;
      const model = role.model ?? role.inferred?.model ?? profile?.model ?? inheritedModel?.model;
      if (!provider && !model) return null;
      const inferredMatch = Boolean(
        role.inferred &&
          role.inferred.provider === provider &&
          role.inferred.model === model,
      );
      const source: RoutingRequirement["source"] = inferredMatch
        ? "natural_language"
        : role.explicit
          ? "explicit_flag"
          : profile?.provider || profile?.model
            ? "agent_profile"
            : "inherited";
      const result: RoutingRequirement = {
        role: role.role,
        agentName: role.agentName,
        essential: role.explicit || source === "natural_language",
        source,
      };
      if (provider) result.provider = provider;
      if (model) result.model = model;
      return result;
    })
    .filter((req): req is RoutingRequirement => Boolean(req));

  for (const runtimeRole of params.orchestrationControls.runtimeRoles) {
    const hint = inferredFromTask.runtimeRoles?.[runtimeRole.role] ?? runtimeRole;
    if (!hint.provider && !hint.model) continue;
    const requirement: RoutingRequirement = {
      role: runtimeRole.role,
      agentName: runtimeRole.agentName,
      essential: true,
      source: "natural_language",
    };
    if (hint.provider) requirement.provider = hint.provider;
    if (hint.model) requirement.model = hint.model;
    if (runtimeRole.count) requirement.count = runtimeRole.count;
    requirements.push(requirement);
  }

  return requirements;
}

function buildRoutingEvidenceForVerifier(
  params: NormalizedParams,
  state: OrchestrationState,
): string {
  const expected = state.intake?.routingRequirements ?? [];
  const currentVerifier = expected.find((req) => req.role === "verifier");
  return JSON.stringify(
    {
      expected_routing_requirements: expected,
      observed_structured_spawn_evidence_so_far: state.routingEvidence,
      observed_progress_lines_so_far: state.progressLog.filter((line) => /Subagent \S+: using /.test(line)),
      verifier_spawn_configuration_for_this_verifier: currentVerifier
        ? `${currentVerifier.agentName} will be spawned with ${formatRoutedModel(currentVerifier.provider, currentVerifier.model)}`
        : `verifier agent ${params.verifierAgent} has no explicit routing requirement`,
      note: "Treat expected_routing_requirements plus structured spawn evidence plus verifier_spawn_configuration_for_this_verifier as concrete model routing evidence for this verification. Do not require the final report, because it is created after verification. TypeScript also performs a deterministic routing check after verifier completion.",
    },
    null,
    2,
  );
}

function checkRequiredModelRouting(
  params: NormalizedParams,
  state: OrchestrationState,
): RoutingCheck {
  const requirements = (state.intake?.routingRequirements ?? []).filter(
    (req) => req.essential,
  );
  const reasons: string[] = [];
  for (const req of requirements) {
    const matches = state.routingEvidence.filter((evidence) =>
      routingEvidenceMatchesRequirement(evidence, req),
    );
    const runtimeRole = !isCoreRoutingRole(req.role);
    const runtimeOutputCount = runtimeRole
      ? state.executorOutputs.filter((output) => output.agentName === req.agentName).length
      : 0;
    const needed = req.role === "executor"
      ? Math.max(1, state.executorOutputs.length)
      : runtimeRole
        ? Math.max(1, req.count ?? runtimeOutputCount)
        : 1;
    if (matches.length < needed) {
      const observed = state.routingEvidence.length
        ? state.routingEvidence.map(formatRoutingEvidence).join("; ")
        : "no structured routing evidence recorded";
      reasons.push(
        `${req.role} expected ${needed} spawn evidence item(s) for ${req.agentName} using ${formatRoutedModel(req.provider, req.model)}, found ${matches.length}. Observed: ${observed}.`,
      );
    }
  }
  return { status: reasons.length ? "fail" : "pass", reasons };
}

function routingEvidenceMatchesRequirement(
  evidence: RoutingEvidence,
  req: RoutingRequirement,
): boolean {
  if (isCoreRoutingRole(req.role)) {
    // Core roles (planner/executor/verifier): match by phaseRole.
    // Agent name variance is tolerated — a spawn to agent "researcher" during
    // the executor phase counts as valid executor routing evidence as long as
    // provider/model match. This allows the planner to assign semantic agent
    // names (e.g., "researcher", "coder", "reviewer") without breaking
    // deterministic routing verification.
    if (evidence.phaseRole !== req.role) return false;
  } else {
    // Runtime roles (e.g., "researcher"): match by agentName or semanticRole.
    if (evidence.agentName !== req.agentName && evidence.semanticRole !== req.role) return false;
  }
  if (req.provider && evidence.provider !== req.provider) return false;
  if (req.model && evidence.model !== req.model) return false;
  return true;
}

function isCoreRoutingRole(role: string): role is "planner" | "executor" | "verifier" {
  return role === "planner" || role === "executor" || role === "verifier";
}

function formatRoutingEvidence(evidence: RoutingEvidence): string {
  return [
    `${evidence.phaseRole}=${evidence.agentName}/${formatRoutedModel(evidence.provider, evidence.model)}`,
    evidence.taskId ? `task=${evidence.taskId}` : "",
    evidence.semanticRole ? `semanticRole=${evidence.semanticRole}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// ── Prompt builders ─────────────────────────────────────────────────────────

function buildPlanningPrompt(
  intake: Intake,
  attempt: number,
  failureReasons: string[],
): string {
  const retryBlock = failureReasons.length
    ? `\nPrevious verifier failure reasons to address deterministically:\n${failureReasons.map((reason) => `- ${reason}`).join("\n")}\n`
    : "";
  return `Plan the following task for executor subagents. Return JSON if possible, exactly shaped as:\n{"tasks":[{"id":"...","description":"...","dependsOn":[],"agent":"coder","role":"...","model":"...","provider":"...","outputType":"file_change|validation|analysis"}],"notes":"..."}\n\nINTAKE CONTRACT:\n${formatIntakeForPrompt(intake)}\n\nRules:\n- Keep task IDs stable and simple (task-1, task-2, ...).\n- Make each description self-contained.\n- Do not execute the task.\n- Carry forward all intake constraints, invariants, success criteria, failure criteria, and executor output contract into the task descriptions/notes.\n- If model routing requirements exist in intake, treat them as essential orchestrator constraints, not executor work.\n- Honor intake.orchestration_controls from natural language: maxSubagents/concurrency/looping are already normalized by the orchestrator, while requested runtime-role counts and perspectives must shape the plan.\n- If orchestration_controls.researcherCount is set, create that many research tasks assigned to agent "researcher" unless doing so would violate a hard constraint. Give each researcher a distinct perspective when perspectiveCount/perspectives are present.\n- If routing_requirements contains a runtime role such as "researcher", matching tasks must use agent "researcher" and may include the exact model/provider fields from that routing requirement for clarity. These are routing hints for the orchestrator, not work for the executor to perform.\n- If the task cannot be safely split and no runtime-role count is requested, return one task.\n- **Task-size cap**: each executor task description MUST be under ~200 words. Tasks exceeding this should be split into multiple smaller tasks. Small tasks ensure executor subagents have enough context budget to use write/edit/bash tools and produce actual file artifacts rather than text reports.\n- An executor task that only describes/analyzes and never touches files is NOT sufficient for CREATE or IMPLEMENT work — the verifier will check for actual file artifacts.\n- **OUTPUT TYPE CLASSIFICATION (REQUIRED)**: Every task MUST include an "outputType" field set to one of: "file_change" (task must produce disk artifacts — use write/edit/bash), "validation" (task checks/inspects existing state), or "analysis" (task produces reasoning only). The orchestrator enforces this contract pre-verifier. Tasks containing CREATE, IMPLEMENT, BUILD, MODIFY, ADD, WRITE, GENERATE, EDIT, CHANGE, FIX, or REFACTOR keywords MUST use "file_change". Tasks containing VERIFY, VALIDATE, CHECK, CONFIRM, TEST, ASSESS, INSPECT, or AUDIT keywords should use "validation". All others should use "analysis".\n- **ANTI-ESCAPE-CLAUSE RULE**: Task descriptions MUST NOT contain escape clauses such as "or repair", "or verify", "or validate", "or confirm", "if already done", "check if exists", "already implemented", "just check", "simply check", or "no changes needed". These phrases give executors permission to skip actual work. An implementation task that says "implement or repair X" will cause the executor to check if X exists and report "already done." Instead, write: "implement X" or "repair X" — never both with "or." If two distinct actions are needed, use two separate tasks. Do not use conditional language ("if", "already", "check if") in file_change task descriptions — be imperative and unconditional.\n\nPlanner-named runtime roles (Way 1):\n- Each task can optionally specify "agent" (the agent name to spawn for this task), "role" (a semantic hint like "code-reviewer" or "architect"), "model" (per-task model override), and "provider" (per-task provider override).\n- If "agent" names an unknown agent (not loaded from defaults or ~/.pi/agent/agents), the orchestrator falls back to the default executor agent silently.\n- Per-task "model"/"provider" are subject to the same local-model rejection and spawn ceiling as role-level overrides. They take precedence over the role-level executorModel/executorProvider but are still clamped through substrate caps.\n- Use "role" only as a hint — the orchestrator routes tasks by "agent", not by "role".\n- Omit "agent", "role", "model", and "provider" when the default executor and role-level configuration are sufficient.\n\nAttempt: ${attempt}${retryBlock}`;
}

function buildExecutorPrompt(intake: Intake, plan: Plan, task: PlanTask, gitForcingBlock?: string): string {
  // ── Escape-clause scanning & rewriting (Change 4) ────────────────
  // Scan the task description for escape routes and rewrite them before
  // the executor ever sees the weak phrasing. This prevents the planner
  // from seeding escape clauses that executors exploit to avoid work.
  const escapeClauses = scanEscapeClauses(task.description);
  let sanitizedDescription = task.description;
  if (escapeClauses.length > 0) {
    sanitizedDescription = rewriteEscapeClauses(task.description);
  }

  // Build a sanitized task copy with the rewritten description
  const sanitizedTask: PlanTask = {
    ...task,
    description: sanitizedDescription,
  };

  const outputRule = intake.executorOutputContract
    ? `Executor output contract (highest priority):\n${intake.executorOutputContract}\n\nDo not add generic report sections. Do not add Markdown unless the contract explicitly requires it.`
    : "Return a concise report with changes/findings, files touched, commands/tests run, and remaining issues or uncertainty.";
  const gitForcingSection = gitForcingBlock ? `\n${gitForcingBlock}\n` : "";
  const outputType = classifyTaskOutputType(task);
  const outputTypeBlock = outputType === "file_change"
    ? `\n\nOUTPUT TYPE CONTRACT: This task is classified as "file_change". You MUST use write, edit, or bash tools to produce actual file artifacts on disk. A text-only response that describes what you would do without creating or modifying any files is a CONTRACT VIOLATION and will be rejected pre-verifier. No exceptions — the orchestrator will check git status after your response.`
    : outputType === "validation"
      ? `\n\nOUTPUT TYPE CONTRACT: This task is classified as "validation". You are checking or inspecting existing state — no file changes are expected, but you MUST provide concrete evidence (file reads, command output, test results) in your response.`
      : `\n\nOUTPUT TYPE CONTRACT: This task is classified as "analysis". You are producing reasoning or analysis — no file changes are expected, but your response must be substantive and evidence-backed.`;
  const suffixBlock = buildStructuredOutputSuffix(outputType);
  return `You are executing one task from a deterministic orchestration.\n\nIMPORTANT: If your task is to CREATE, IMPLEMENT, BUILD, or MODIFY code/files, you MUST use write/edit/bash tools to produce actual file artifacts. A text-only response that describes what you would do — without creating or modifying any files — is a FAILURE. Always produce concrete artifacts for implementation tasks.${gitForcingSection}\n\nINTAKE CONTRACT:\n${promptMinification(intake)}\n\nFull plan:\n${JSON.stringify(plan, null, 2)}\n\nAssigned executor task:\n${JSON.stringify(sanitizedTask, null, 2)}${outputTypeBlock}\n\nComplete only the assigned task. Use Pi tools only if needed and allowed by the intake constraints.\n${injectContinuationGuardrail(task.id)}\n\n${outputRule}${suffixBlock}`;
}

function buildVerificationPrompt(
  intake: Intake,
  plan: Plan,
  outputs: ExecutorOutput[],
  routingEvidence: string,
  artifactEvidence?: ArtifactEvidence | string,
): string {
  const artifactText =
    typeof artifactEvidence === "string"
      ? artifactEvidence
      : artifactEvidence?.summary;
  const artifactBlock = artifactText
    ? `\n\n${artifactText}`
    : "";
  return `Verify the orchestration result against the intake contract.\n\nINTAKE CONTRACT:\n${formatIntakeForPrompt(intake)}\n\nPlan:\n${JSON.stringify(plan, null, 2)}\n\nExecutor outputs:\n${JSON.stringify(outputs, null, 2)}\n\nModel routing evidence/configuration supplied by orchestrator:\n${routingEvidence}${artifactBlock}\n\nReturn JSON exactly and only in this shape:\n{"status":"pass"|"fail","reasons":["..."]}\n\nUse status "pass" only if the plan, outputs, and supplied routing evidence/configuration satisfy the intake success criteria and do not violate any constraints, invariants, or failure criteria. Use "fail" with concrete reasons for missing, unclear, or incorrect work.\n\nFILE ARTIFACT VERIFICATION RULE: If any executor task description contains CREATE, IMPLEMENT, BUILD, MODIFY, ADD, WRITE, or GENERATE (case-insensitive), the executor output MUST reference actual file artifacts (files created, modified, or edited). A text-only response that describes what was done without mentioning any specific files created/modified is INSUFFICIENT — treat it as FAIL with reason "no file artifacts produced for implementation task". The ARTIFACT EVIDENCE block (if present) shows what files actually changed on disk — use it as ground truth, overriding any text claims.`;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parsePlan(text: string, originalTask: string): Plan {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    if (Array.isArray(raw.tasks)) {
      const tasks = raw.tasks
        .map((item, index) => normalizePlanTask(item, index))
        .filter((task): task is PlanTask => Boolean(task));
      if (tasks.length > 0) {
        return { tasks, notes: optionalString(raw.notes) ?? "", raw: parsed };
      }
    }
  }

  const fallback = text.trim() || originalTask;
  return {
    tasks: [{ id: "task-1", description: fallback, dependsOn: [] }],
    notes:
      "Planner output was not parseable as plan JSON; fell back to one executor task containing the planner output.",
    raw: text,
  };
}

function normalizePlanTask(item: unknown, index: number): PlanTask | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const description = optionalString(raw.description)?.trim();
  if (!description) return null;
  const id = optionalString(raw.id)?.trim() || `task-${index + 1}`;
  const rawOutputType = optionalString(raw.outputType);
  const outputType: TaskOutputType | undefined =
    rawOutputType === "file_change" ||
    rawOutputType === "validation" ||
    rawOutputType === "analysis"
      ? rawOutputType
      : undefined;

  return {
    id,
    description,
    dependsOn: stringArray(raw.dependsOn) ?? [],
    agent: optionalString(raw.agent),
    role: optionalString(raw.role),
    model: optionalString(raw.model),
    provider: optionalString(raw.provider),
    outputType,
  };
}

function parseVerifierResult(text: string): {
  status: "pass" | "fail";
  reasons: string[];
  raw: string;
} {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    const status = String(raw.status ?? "").toLowerCase();
    if (status === "pass" || status === "fail") {
      return { status, reasons: stringArray(raw.reasons) ?? [], raw: text };
    }
  }
  return {
    status: "fail",
    reasons: ["Verifier output was not parseable as the required JSON."],
    raw: text,
  };
}

// ── JSON extraction (shape-owned utilities) ─────────────────────────────────

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  for (const candidate of [
    trimmed,
    ...extractFenceContents(trimmed),
    extractBalancedObject(trimmed),
  ].filter(Boolean) as string[]) {
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

// ── Intake text analysis helpers ────────────────────────────────────────────

function summarizeTask(task: string): string {
  return truncateWithNotice(task.replace(/\s+/g, " ").trim(), 240, "task summary");
}

function inferIntent(task: string): string {
  // F6: classify as a smoke/mock validation run only when the task literally
  // asks for one — the mere presence of "mock"/"smoke" somewhere in a real
  // task must not reclassify the user's intent.
  if (
    /^\s*(?:smoke|mock)\s+test\b/i.test(task) ||
    /\b(?:run|perform|execute|do|this is)\s+(?:a\s+|an\s+)?(?:low[-\s]?cost\s+)?(?:smoke|mock)\s+test\b/i.test(task)
  ) {
    return "Validate orchestration behavior with a low-cost mock/smoke task.";
  }
  return "Complete the user task while preserving explicit constraints and success criteria.";
}

function extractConstraintLines(task: string): string[] {
  const constraints: string[] = [];
  const patterns = [
    [/do not edit files?/i, "Do not edit files."],
    [/do not run commands?/i, "Do not run commands."],
    [
      /do not run commands? unless absolutely necessary/i,
      "Do not run commands unless absolutely necessary.",
    ],
    [/keep every response (?:very )?short|minimal/i, "Keep responses minimal."],
    [
      /exactly one (?:plain-text )?line/i,
      "Executor outputs must be exactly one plain-text line when requested.",
    ],
    [/no markdown/i, "No Markdown in constrained executor outputs."],
    [/no bold/i, "No bold formatting in constrained executor outputs."],
    [/no bullets/i, "No bullets in constrained executor outputs."],
    [/no explanations/i, "No explanations in constrained executor outputs."],
    [/no headings/i, "No headings in constrained executor outputs."],
    [/no separator lines/i, "No separator lines in constrained executor outputs."],
  ] as Array<[RegExp, string]>;
  for (const [regex, text] of patterns)
    if (regex.test(task) && !constraints.includes(text)) constraints.push(text);
  return constraints.length
    ? constraints
    : ["Preserve all explicit instructions in the original task."];
}

function extractSuccessCriteria(task: string): string[] {
  const criteria: string[] = [];
  const exactResults = task.match(/RESULT\s+task-\d+\s*:\s*[^\n\r]+/gi) ?? [];
  for (const result of exactResults)
    criteria.push(`Executor output includes exact line: ${result.trim()}`);
  if (/dependsOn\s*:\s*\[\]/i.test(task) || /independent executor tasks/i.test(task))
    criteria.push("Planner creates independent executor tasks with dependsOn: [].");
  if (/pass only if/i.test(task))
    criteria.push("Verifier follows the explicit PASS-only-if criteria from the original task.");
  return [...new Set(criteria)];
}

function extractFailureCriteria(task: string): string[] {
  const criteria: string[] = [];
  if (/no markdown|no bold|no bullets|no headings|no separator/i.test(task))
    criteria.push(
      "Markdown, bold, bullets, headings, separator lines, or extra sections violate strict executor output requirements.",
    );
  if (/exactly one/i.test(task))
    criteria.push("More than one executor output line violates strict output requirements.");
  return criteria;
}

function extractNonGoals(task: string): string[] {
  const nonGoals: string[] = [];
  if (/do not edit files?/i.test(task)) nonGoals.push("File modification is out of scope.");
  if (/do not run commands?/i.test(task))
    nonGoals.push("Command execution is out of scope unless explicitly allowed by the task.");
  return nonGoals;
}

function extractExecutorOutputContract(task: string): string | undefined {
  if (!/RESULT\s+task-N|RESULT\s+task-\d+|exactly one/i.test(task)) return undefined;
  const rules: string[] = [];
  if (/exactly one (?:plain-text )?line/i.test(task) || /one short line/i.test(task))
    rules.push("Each executor must output exactly one plain-text line and nothing else.");
  if (/format must be exactly/i.test(task)) rules.push("Use the exact requested RESULT task-N format.");
  if (/no markdown/i.test(task)) rules.push("No Markdown.");
  if (/no bold/i.test(task)) rules.push("No bold formatting.");
  if (/no bullets/i.test(task)) rules.push("No bullets.");
  if (/no explanations/i.test(task)) rules.push("No explanations.");
  if (/no headings/i.test(task)) rules.push("No headings.");
  if (/no separator lines/i.test(task)) rules.push("No separator lines.");
  if (/files touched|commands run|remaining issues/i.test(task))
    rules.push(
      "Do not include files touched, commands run, remaining issues, or other report sections unless explicitly required as the single answer line.",
    );
  return rules.length
    ? rules.join(" ")
    : "Each executor must follow the explicit output format in the original task.";
}

// ── Spawn helpers ───────────────────────────────────────────────────────────

/**
 * Way 1: Resolve the agent to spawn for a given task.
 *
 * - If the task specifies an `agent` and it exists in the loaded agents map,
 *   that agent is used (planner-named runtime role).
 * - If the task specifies an `agent` but it is NOT found in the agents map,
 *   fall back to the default executor agent silently.
 * - If the task does NOT specify an agent, use the default executor agent.
 */
function resolveTaskAgent(
  task: PlanTask,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
): string {
  const requested = task.agent?.trim();
  if (!requested) return params.executorAgent;
  if (agents.has(requested)) return requested;
  // Unknown agent name: fall back to default executor (no error thrown).
  return params.executorAgent;
}

/**
 * Way 1: Merge per-task model/provider overrides with role-level overrides.
 *
 * Precedence: per-task values take priority over role-level values.
 * Both are subject to substrate local-model rejection and spawn ceiling
 * in spawnSubagent (via rejectLocalModelIfNeeded) and SpawnGuard.reserve().
 */
function inferredRuntimeModelForTask(
  task: PlanTask,
  resolvedAgent: string,
  inferredModelRouting: InferredModelRouting,
): RoleModelOverride | undefined {
  const runtimeRoles = inferredModelRouting.runtimeRoles ?? {};
  const candidates = [
    resolvedAgent,
    task.agent,
    task.role,
  ]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  if (candidates.some((value) => /\bresearch/.test(value))) {
    candidates.push("researcher");
  }
  for (const candidate of candidates) {
    const override = runtimeRoles[candidate];
    if (override?.model || override?.provider) return override;
  }
  return undefined;
}

function mergeModelOverrides(
  roleLevel: RoleModelOverride | undefined,
  taskLevel: { model?: string; provider?: string } | undefined,
): RoleModelOverride | undefined {
  const role = roleLevel ?? {};
  const task = taskLevel ?? {};
  const model = task.model ?? role.model;
  const provider = task.provider ?? role.provider;
  if (!model && !provider) return undefined;
  return { model, provider };
}

function toModelOverride(
  model?: string,
  provider?: string,
): RoleModelOverride | undefined {
  if (!model && !provider) return undefined;
  return { model, provider };
}

async function spawnChecked(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  agentName: string,
  routingRole: RoutingEvidence["phaseRole"],
  task: string,
  signal: AbortSignal | undefined,
  onProgress: ((text: string) => void) | undefined,
  inheritedModel: { provider?: string; model?: string } | undefined,
  modelOverride: RoleModelOverride | undefined,
  evidenceContext?: { taskId?: string; semanticRole?: string },
): Promise<SubagentResult> {
  // Substrate guarantee: SpawnGuard enforces the monotonic ceiling.
  const spawned = state.spawnGuard.reserve();
  onProgress?.(
    `Spawning subagent ${agentName} (${spawned}/${state.spawnGuard.cap}) in ${params.cwd}`,
  );
  const result = await spawnSubagent(agentName, task, {
    agents,
    cwd: params.cwd,
    allowLocalModel: params.allowLocalModel,
    signal,
    inheritedModel,
    onProgress,
    modelOverride,
  });
  const routingEvidence: RoutingEvidence = {
    phaseRole: routingRole,
    agentName: result.agentName,
    evidence: `Subagent ${result.agentName}: ${routingRole} spawn used ${formatRoutedModel(result.provider, result.model)}${evidenceContext?.taskId ? ` for ${evidenceContext.taskId}` : ""}.`,
  };
  if (result.provider) routingEvidence.provider = result.provider;
  if (result.model) routingEvidence.model = result.model;
  if (evidenceContext?.taskId) routingEvidence.taskId = evidenceContext.taskId;
  if (evidenceContext?.semanticRole) routingEvidence.semanticRole = evidenceContext.semanticRole;
  state.routingEvidence.push(routingEvidence);
  return result;
}

function computeRequiredSubagentBudget(
  spawnedThroughCurrentPlanner: number,
  executorTaskCount: number,
  currentAttempt: number,
  maxAttempts: number,
): number {
  const finishCurrentAttempt = executorTaskCount + 1; // executors + verifier; current planner already spawned.
  const remainingAttempts = Math.max(0, maxAttempts - currentAttempt);
  const fullFutureAttempt = executorTaskCount + 2; // planner + executors + verifier.
  return spawnedThroughCurrentPlanner + finishCurrentAttempt + remainingAttempts * fullFutureAttempt;
}

// ── Result builders ────────────────────────────────────────────────────────

function buildFinalResult(
  status: "pass" | "fail",
  params: NormalizedParams,
  state: OrchestrationState,
): string {
  const verifier = state.verifierResult;
  const modelRoutingEvidence = state.routingEvidence.map(formatRoutingEvidence);
  const lines = [
    `# Orchestration Result: ${status.toUpperCase()}`,
    "",
    `**Task:** ${params.task}`,
    `**Attempts:** ${state.attempt}`,
    `**Subagents spawned:** ${state.spawnGuard.spawned}/${state.spawnGuard.cap}`,
    "",
    "## Intake contract",
    state.intake
      ? "```json\n" + JSON.stringify(compactIntake(state.intake), null, 2) + "\n```"
      : "No intake produced.",
    "",
    "## Model routing evidence",
    ...(modelRoutingEvidence.length
      ? modelRoutingEvidence.map((line) => `- ${line}`)
      : ["- No structured model routing evidence was recorded."]),
    "",
    "## Deterministic model routing check",
    state.routingCheck
      ? `Status: **${state.routingCheck.status}**`
      : "No deterministic routing check was run.",
    state.routingCheck?.reasons.length
      ? state.routingCheck.reasons.map((reason) => `- ${reason}`).join("\n")
      : "- All essential routing requirements were satisfied or no essential routing was requested.",
    "",
    "## Final verifier result",
    verifier ? `Status: **${verifier.status}**` : "No verifier result.",
    verifier?.reasons?.length
      ? verifier.reasons.map((reason) => `- ${reason}`).join("\n")
      : "- No verifier reasons provided.",
    "",
    "## Plan",
    state.plan
      ? "```json\n" + JSON.stringify(compactPlan(state.plan), null, 2) + "\n```"
      : "No plan produced.",
    "",
    "## Executor outputs",
    ...state.executorOutputs.map((output) =>
      [
        `### ${output.taskId}: ${output.description}`,
        "",
        output.output
          ? truncateWithNotice(
              output.output,
              MAX_EXECUTOR_MARKDOWN_CHARS,
              `executor output ${output.taskId}`,
            )
          : "_(No assistant text captured.)_",
        output.stderr
          ? `\n_stderr:_\n\`\`\`\n${truncateWithNotice(output.stderr, 2000, `stderr ${output.taskId}`)}\n\`\`\``
          : "",
      ].join("\n"),
    ),
  ];

  if (state.failureReasons.length) {
    lines.push(
      "",
      "## Failure reasons across attempts",
      ...state.failureReasons.map((reason) => `- ${reason}`),
    );
  }

  if (state.gateWarnings.length) {
    lines.push(
      "",
      "## Gate warnings (advisory — not verdict-determining)",
      ...state.gateWarnings.map((warning) => `- ${warning}`),
    );
  }

  if (state.progressLog.length) {
    lines.push(
      "",
      "## Progress evidence",
      ...state.progressLog.slice(-40).map((line) => `- ${line}`),
    );
  }

  if (state.recoveryLog.length) {
    lines.push(
      "",
      `## Recovery log (depth ${state.recoveryDepth}/${state.maxRecoveryDepth})`,
      ...state.recoveryLog.map((entry) => `- ${entry}`),
    );
  }

  if (state.executorOutputs.some((o) => o.contextBudget)) {
    lines.push("", "## Context budget summary", "");
    lines.push("| Task | Saturation | Risk | Recommendation |");
    lines.push("|------|------------|------|----------------|");
    for (const output of state.executorOutputs) {
      if (!output.contextBudget) continue;
      lines.push(
        `| ${output.taskId} | ${output.contextBudget.saturationPercent}% | ${output.contextBudget.risk} | ${output.contextBudget.recommendation} |`,
      );
    }
  }

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_MARKDOWN_CHARS, "final orchestration report");
}

function buildDetails(
  status: "pass" | "fail",
  params: NormalizedParams,
  state: OrchestrationState,
) {
  return {
    status,
    params: { ...params, task: truncateWithNotice(params.task, MAX_DETAIL_TEXT_CHARS, "task") },
    hardGates: params.hardGates,
    gateWarnings: state.gateWarnings.map((warning) =>
      truncateWithNotice(warning, MAX_DETAIL_TEXT_CHARS, "gate warning"),
    ),
    deterministicState: {
      attempt: state.attempt,
      spawnedCount: state.spawnGuard.spawned,
      intake: state.intake ? compactIntake(state.intake) : null,
      routingEvidence: state.routingEvidence,
      routingCheck: state.routingCheck,
      plan: compactPlan(state.plan),
      planText: truncateWithNotice(state.planText, MAX_DETAIL_TEXT_CHARS, "planner output"),
      executorOutputs: state.executorOutputs.map(compactExecutorOutput),
      verifierResult: compactVerifierResult(state.verifierResult),
      failureReasons: state.failureReasons.map((reason) =>
        truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "failure reason"),
      ),
      progressLog: state.progressLog.map((line) =>
        truncateWithNotice(line, MAX_DETAIL_TEXT_CHARS, "progress log line"),
      ),
      finalResult: truncateWithNotice(
        state.finalResult,
        MAX_DETAIL_TEXT_CHARS,
        "final result",
      ),
      recoveryLog: state.recoveryLog.map((entry) =>
        truncateWithNotice(entry, MAX_DETAIL_TEXT_CHARS, "recovery log entry"),
      ),
      recoveryDepth: state.recoveryDepth,
      maxRecoveryDepth: state.maxRecoveryDepth,
    },
    attempts: state.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      plan: compactPlan(attempt.plan),
      plannerText: truncateWithNotice(
        attempt.plannerText,
        MAX_DETAIL_TEXT_CHARS,
        "planner output",
      ),
      executorOutputs: attempt.executorOutputs.map(compactExecutorOutput),
      verifierResult: compactVerifierResult(attempt.verifierResult),
    })),
  };
}

// ── Compaction helpers ─────────────────────────────────────────────────────

function compactIntake(intake: Intake): Intake {
  return {
    ...intake,
    originalTask: truncateWithNotice(
      intake.originalTask,
      MAX_DETAIL_TEXT_CHARS,
      "intake original task",
    ),
    taskSummary: truncateWithNotice(
      intake.taskSummary,
      MAX_DETAIL_TEXT_CHARS,
      "intake task summary",
    ),
    userIntent: truncateWithNotice(
      intake.userIntent,
      MAX_DETAIL_TEXT_CHARS,
      "intake user intent",
    ),
    goalAttractor: truncateWithNotice(
      intake.goalAttractor,
      MAX_DETAIL_TEXT_CHARS,
      "intake goal attractor",
    ),
    taskScope: truncateWithNotice(
      intake.taskScope,
      MAX_DETAIL_TEXT_CHARS,
      "intake task scope",
    ),
    constraints: intake.constraints.map((item) =>
      truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake constraint"),
    ),
    invariants: intake.invariants.map((item) =>
      truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake invariant"),
    ),
    successCriteria: intake.successCriteria.map((item) =>
      truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake success criterion"),
    ),
    failureCriteria: intake.failureCriteria.map((item) =>
      truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake failure criterion"),
    ),
    nonGoals: intake.nonGoals.map((item) =>
      truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake non-goal"),
    ),
    ambiguities: intake.ambiguities.map((item) =>
      truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake ambiguity"),
    ),
    routingDecision: truncateWithNotice(
      intake.routingDecision,
      MAX_DETAIL_TEXT_CHARS,
      "intake routing decision",
    ),
    executorOutputContract: intake.executorOutputContract
      ? truncateWithNotice(
          intake.executorOutputContract,
          MAX_DETAIL_TEXT_CHARS,
          "intake executor output contract",
        )
      : undefined,
  };
}

function compactPlan(plan: Plan | null): Plan | null {
  if (!plan) return null;
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      description: truncateWithNotice(
        task.description,
        MAX_DETAIL_TEXT_CHARS,
        `task description ${task.id}`,
      ),
    })),
    notes: truncateWithNotice(plan.notes, MAX_DETAIL_TEXT_CHARS, "plan notes"),
    raw: compactUnknown(plan.raw, "plan raw"),
  };
}

function compactUnknown(value: unknown, label: string): unknown {
  if (typeof value === "string")
    return truncateWithNotice(value, MAX_DETAIL_TEXT_CHARS, label);
  if (value === undefined || value === null) return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_DETAIL_TEXT_CHARS) return value;
    return truncateWithNotice(serialized, MAX_DETAIL_TEXT_CHARS, label);
  } catch {
    return truncateWithNotice(String(value), MAX_DETAIL_TEXT_CHARS, label);
  }
}

function compactExecutorOutput(output: ExecutorOutput): ExecutorOutput {
  return {
    ...output,
    output: truncateWithNotice(
      output.output,
      MAX_DETAIL_TEXT_CHARS,
      `executor output ${output.taskId}`,
    ),
    stderr: output.stderr
      ? truncateWithNotice(output.stderr, 2000, `stderr ${output.taskId}`)
      : undefined,
  };
}

function compactVerifierResult(result: OrchestrationState["verifierResult"]) {
  if (!result) return null;
  return {
    ...result,
    reasons: result.reasons.map((reason) =>
      truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "verifier reason"),
    ),
    raw: truncateWithNotice(result.raw, MAX_DETAIL_TEXT_CHARS, "verifier output"),
  };
}

// ── Phase 4: termination policy functions ───────────────────────────────────

/**
 * Extract terminationPolicy from the raw plan JSON the planner returned.
 * The planner may propose e.g. {"terminationPolicy": {"maxAttempts": 5}}.
 */
function parseTerminationPolicyFromPlan(plan: Plan): TerminationPolicy {
  if (!plan.raw || typeof plan.raw !== "object") return {};
  const raw = plan.raw as Record<string, unknown>;
  const tp = raw.terminationPolicy;
  if (!tp || typeof tp !== "object") return {};
  const obj = tp as Record<string, unknown>;
  const maxAttempts = typeof obj.maxAttempts === "number" && Number.isFinite(obj.maxAttempts)
    ? Math.trunc(obj.maxAttempts)
    : undefined;
  return maxAttempts !== undefined && maxAttempts > 0 ? { maxAttempts } : {};
}

/**
 * Resolve the maximum number of attempts using the precedence chain:
 *
 *   1. explicit human param (--max-retries / maxRetries)       → params.maxRetries + 1
 *   2. normalized NL maxAttempts in orchestrationControls      → maxAttempts
 *   3. normalized NL maxRetries in orchestrationControls       → maxRetries + 1
 *   4. planner-proposed terminationPolicy.maxAttempts          → plannerTP.maxAttempts
 *   5. existing default (maxRetries: 2 → 3 attempts)           → params.maxRetries + 1
 *
 * The caller MUST then clamp the result through clampIterations()
 * to enforce the substrate bounded/cannot-run-forever guarantee.
 */
function resolveMaxAttempts(
  params: NormalizedParams,
  plannerTP: TerminationPolicy,
): number {
  // Level 1: explicit human param
  if (params.maxRetriesExplicit) {
    return params.maxRetries + 1;
  }

  // Level 2/3: normalized natural-language loop controls from intake.
  // These fields are produced during normalization, support word numbers
  // such as "one", and are the source of truth for NL loop terms.
  const controls = params.orchestrationControls;
  if (controls.maxAttempts !== undefined && controls.maxAttempts > 0) {
    return controls.maxAttempts;
  }
  if (controls.maxRetries !== undefined && controls.maxRetries >= 0) {
    return controls.maxRetries + 1;
  }

  // Level 4: planner-proposed termination policy
  if (plannerTP.maxAttempts !== undefined && plannerTP.maxAttempts > 0) {
    return plannerTP.maxAttempts;
  }

  // Level 5: default
  return params.maxRetries + 1;
}

/**
 * Human-readable description of which precedence level was used,
 * for logging/emit purposes.
 */
function describeTerminationSource(
  params: NormalizedParams,
  plannerTP: TerminationPolicy,
): string {
  if (params.maxRetriesExplicit) return "explicit param (--max-retries/maxRetries)";
  const controls = params.orchestrationControls;
  if (controls.maxAttempts !== undefined && controls.maxAttempts > 0)
    return "natural-language orchestrationControls.maxAttempts";
  if (controls.maxRetries !== undefined && controls.maxRetries >= 0)
    return "natural-language orchestrationControls.maxRetries";
  if (plannerTP.maxAttempts !== undefined && plannerTP.maxAttempts > 0)
    return "planner-proposed terminationPolicy";
  return `default (maxRetries=${params.maxRetries} → ${params.maxRetries + 1} attempts)`;
}

// ── Git snapshot + diff enforcement (Change 1) ────────────────────────────

/**
 * Capture a git status snapshot before the executor spawns.
 * This snapshot acts as the baseline for post-execution diff comparison.
 *
 * Returns a GitSnapshot with success=false when git is unavailable;
 * callers should skip git-dependent gates gracefully in that case.
 */
function capturePreExecutionGitSnapshot(cwd: string): GitSnapshot {
  const timestamp = new Date().toISOString();
  try {
    const result = spawnSync("git", ["-C", cwd, "status", "--short"], {
      timeout: 10000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
      return {
        success: false,
        timestamp,
        files: [],
        rawStatus: `git status failed (exit ${result.status ?? "error"}): ${result.stderr?.trim() ?? result.error?.message ?? "unknown"}`,
      };
    }
    const rawStatus = result.stdout?.trim() ?? "";
    const files: Array<{ status: string; path: string }> = [];
    if (rawStatus) {
      for (const line of rawStatus.split("\n").filter(Boolean)) {
        // git status --short format: "XY filename" (2-char status, space, path)
        const status = line.slice(0, 2).trim() || "??";
        const path = line.slice(3).trim();
        if (path) files.push({ status, path });
      }
    }
    return { success: true, timestamp, files, rawStatus };
  } catch (err) {
    return {
      success: false,
      timestamp,
      files: [],
      rawStatus: `git capture error: ${String(err)}`,
    };
  }
}

/**
 * Compute a structured diff between a pre-execution and post-execution
 * git snapshot. Only files appearing or changing after the pre-snapshot
 * count as executor changes.
 *
 * Pre-existing dirty state (files already modified before spawn) is
 * captured in the pre-snapshot and excluded from the executor diff.
 */
function computePostExecutionDiff(
  before: GitSnapshot,
  after: GitSnapshot,
): GitDiff {
  if (!before.success || !after.success) {
    return { filesChanged: 0, newFiles: [], modifiedFiles: [], deletedFiles: [] };
  }

  const beforePaths = new Set(before.files.map((f) => f.path));
  const afterPaths = new Set(after.files.map((f) => f.path));
  const beforeMap = new Map(before.files.map((f) => [f.path, f.status]));
  const afterMap = new Map(after.files.map((f) => [f.path, f.status]));

  const newFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const path of afterPaths) {
    if (!beforePaths.has(path)) {
      newFiles.push(path);
    } else if (beforeMap.get(path) !== afterMap.get(path)) {
      modifiedFiles.push(path);
    }
  }
  for (const path of beforePaths) {
    if (!afterPaths.has(path)) {
      deletedFiles.push(path);
    }
  }

  return {
    filesChanged: newFiles.length + modifiedFiles.length + deletedFiles.length,
    newFiles,
    modifiedFiles,
    deletedFiles,
  };
}

/**
 * Build a git forcing block to inject into the executor prompt.
 *
 * Tells the executor that the orchestrator WILL compare git state
 * before and after their work. If no files change for an implementation
 * task, the response will be rejected — this is a mechanical external
 * forcing function the executor cannot reason around.
 */
function buildGitDiffForcingBlock(snapshot: GitSnapshot): string {
  if (!snapshot.success) return "";

  const preExisting =
    snapshot.files.length > 0
      ? `\n**Pre-existing working-tree state before your spawn:**\n${snapshot.rawStatus.replace(/^/gm, "  ")}`
      : "\n**Pre-existing working-tree state before your spawn:** (working tree clean)";

  return `
┌─────────────────────────────────────────────────────────────┐
│ GIT GROUND-TRUTH ENFORCEMENT (mechanical, un-evadable) │
├─────────────────────────────────────────────────────────────┤
│ The orchestrator captured a git status snapshot BEFORE │
│ dispatching this task. After your response, it will run │
│ git status --short again and compute an exact diff. │
│ │
│ If your task is an implementation task and the post-spawn │
│ diff shows ZERO file changes, your response will be │
│ rejected immediately — no verifier needed. No amount of │
│ prose or explanation can defeat a mechanical git diff. │
│ │
│ You MUST create, modify, or delete files on disk. The │
│ orchestrator will see every file you touch. │${preExisting}
│ │
│ Snapshot timestamp: ${snapshot.timestamp} │
└─────────────────────────────────────────────────────────────┘`;
}

// ── Task output type classification (Change 2) ────────────────────────────

/**
 * Classify a PlanTask's output type. Uses the planner-declared outputType
 * field when present; otherwise infers from the task description using
 * keyword heuristics as a safety net.
 */
function classifyTaskOutputType(task: PlanTask): TaskOutputType {
  if (task.outputType) return task.outputType;
  return inferOutputTypeFromDescription(task.description);
}

/**
 * Infer the output type from a task description using keyword heuristics.
 *
 * - "file_change": contains CREATE, IMPLEMENT, BUILD, MODIFY, ADD, WRITE,
 *   GENERATE, EDIT, CHANGE keywords.
 * - "validation": contains VERIFY, VALIDATE, CHECK, CONFIRM, TEST, ASSESS,
 *   INSPECT, AUDIT keywords.
 * - "analysis": fallback for anything else (research, analyze, review, etc.).
 */
function inferOutputTypeFromDescription(description: string): TaskOutputType {
  const implPattern = /\b(CREATE|IMPLEMENT|BUILD|MODIFY|ADD|WRITE|GENERATE|EDIT|CHANGE|FIX|REFACTOR)\b/i;
  const validationPattern = /\b(VERIFY|VALIDATE|CHECK|CONFIRM|TEST|ASSESS|INSPECT|AUDIT|EXAMINE)\b/i;

  if (implPattern.test(description)) return "file_change";
  if (validationPattern.test(description)) return "validation";
  return "analysis";
}

/**
 * Validate that the executor's output satisfies its declared output type
 * contract. Returns an array of violation strings (empty = no violations).
 *
 * - "file_change": must have disk evidence, file claims, or git diff changes.
 *   Zero changes = contract violation.
 * - "validation" / "analysis": no file-change requirement enforced.
 */
function validateOutputTypeContract(
  outputType: TaskOutputType,
  evidence?: ArtifactEvidence,
): string[] {
  const violations: string[] = [];

  if (outputType === "file_change") {
    const hasDiskEvidence = (evidence?.diskFiles?.length ?? 0) > 0;
    const hasFileClaims = (evidence?.fileClaims?.length ?? 0) > 0;
    if (!hasDiskEvidence && !hasFileClaims) {
      violations.push(
        `OUTPUT TYPE CONTRACT VIOLATION: task declared outputType="file_change" ` +
        `but produced zero disk evidence and zero file claims. ` +
        `Implementation tasks MUST produce file artifacts.`,
      );
    }
  }

  return violations;
}

// ── Structured output suffix contract (Change 3) ───────────────────────────

/**
 * Build a structured output suffix block to append to the executor prompt.
 *
 * The suffix demands the executor self-report what files it created/modified,
 * what commands it ran, and whether tests passed. This self-report is
 * cross-referenced with git ground truth for lie detection.
 *
 * The format varies by output type:
 * - "file_change": MUST include files_created/files_modified arrays.
 * - "validation": SHOULD include commands_run and tests_passed.
 * - "analysis": suffix is optional but recommended for evidence traceability.
 */
function buildStructuredOutputSuffix(outputType: TaskOutputType): string {
  const contractNote =
    outputType === "file_change"
      ? `This task is classified as "file_change". Both files_created and files_modified arrays are MANDATORY. If both are empty, the orchestrator will REJECT your response — no verifier needed.`
      : outputType === "validation"
        ? `This task is classified as "validation". Include commands_run and tests_passed for evidence traceability.`
        : `This task is classified as "analysis". The suffix is optional but helps the orchestrator track your work.`;

  const suffixJson = JSON.stringify(
    {
      files_created: outputType === "file_change" ? ["REQUIRED: list paths here"] : [],
      files_modified: outputType === "file_change" ? ["REQUIRED: list paths here"] : [],
      commands_run: ["REQUIRED: list commands here"],
      tests_passed: false,
      exit_code: -1,
    },
    null,
    2,
  );

  return `

── REQUIRED OUTPUT SUFFIX ──
\`\`\`json
OUTPUT_CONTRACT
${suffixJson}
OUTPUT_CONTRACT
\`\`\`
── END REQUIRED SUFFIX ──

${contractNote}

YOUR FINAL RESPONSE MUST INCLUDE THE OUTPUT_CONTRACT BLOCK ABOVE (enclosed in \`\`\`json fences) with YOUR actual values replacing the placeholder arrays. Do not omit this block — it is machine-parsed by the orchestrator.`;
}

/**
 * Parse an executor's output text to extract the OUTPUT_CONTRACT suffix.
 *
 * Looks for the JSON block between OUTPUT_CONTRACT markers (case-sensitive).
 * Returns null if no suffix is found or if the JSON is malformed.
 */
function parseExecutorOutputSuffix(text: string): ExecutorOutputSuffix | null {
  if (!text) return null;

  // Match the OUTPUT_CONTRACT block: ```json ... OUTPUT_CONTRACT {json} OUTPUT_CONTRACT ```
  const contractRegex = /OUTPUT_CONTRACT\s*\n([\s\S]*?)\nOUTPUT_CONTRACT/;
  const match = contractRegex.exec(text);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (!parsed || typeof parsed !== "object") return null;

    return {
      files_created: Array.isArray(parsed.files_created)
        ? parsed.files_created.map(String)
        : [],
      files_modified: Array.isArray(parsed.files_modified)
        ? parsed.files_modified.map(String)
        : [],
      commands_run: Array.isArray(parsed.commands_run)
        ? parsed.commands_run.map(String)
        : [],
      tests_passed: typeof parsed.tests_passed === "boolean"
        ? parsed.tests_passed
        : false,
      exit_code: typeof parsed.exit_code === "number"
        ? parsed.exit_code
        : -1,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a parsed output suffix against the expected output type contract.
 *
 * Returns an array of violation strings (empty = contract satisfied).
 *
 * - "file_change" tasks: both files_created and files_modified must
 *   not both be empty (at least one file must be created or modified).
 * - "validation" / "analysis": no hard enforcement on suffix fields.
 */
function validateOutputSuffixAgainstType(
  suffix: ExecutorOutputSuffix,
  outputType: TaskOutputType,
): string[] {
  const violations: string[] = [];

  if (outputType === "file_change") {
    const hasCreatedFiles = suffix.files_created.some(
      (f) => f && !f.startsWith("REQUIRED:"),
    );
    const hasModifiedFiles = suffix.files_modified.some(
      (f) => f && !f.startsWith("REQUIRED:"),
    );
    const hasCommands = suffix.commands_run.some(
      (c) => c && !c.startsWith("REQUIRED:"),
    );

    if (!hasCreatedFiles && !hasModifiedFiles && !hasCommands) {
      violations.push(
        `OUTPUT SUFFIX VIOLATION: file_change task produced a suffix with ` +
        `zero concrete files_created, zero concrete files_modified, and zero ` +
        `concrete commands_run. The executor self-reports producing nothing.`,
      );
    }
  }

  // Exit code consistency check (applies to all types)
  if (
    suffix.tests_passed === true &&
    suffix.exit_code !== 0 &&
    suffix.exit_code !== -1
  ) {
    violations.push(
      `OUTPUT SUFFIX INCONSISTENCY: tests_passed=true but exit_code=${suffix.exit_code}. ` +
        `These values are contradictory.`,
    );
  }

  return violations;
}

/**
 * Check whether executor output prose contains file artifact claims.
 *
 * Used as a fallback when the structured OUTPUT_CONTRACT suffix is missing
 * — the orchestrator can still detect that the executor *claimed* to produce
 * files even if it skipped the machine-parseable format.
 *
 * Unlike extractFileArtifactClaimsFromText(), this returns a simple boolean
 * and uses a broader set of patterns designed for natural-language executor
 * prose rather than structured evidence extraction.
 */
function hasFileClaimsInProse(text: string): boolean {
  if (!text) return false;

  const proseClaimPatterns: RegExp[] = [
    /\b(?:created?|wrote?|added?|modified?|edited?|updated?|changed?|generated?)\s+(?:file|the\s+)?\s*[`"']?([^\s`"',;]+\.[a-z]{1,8})[`"']?/i,
    /\b(?:touched?|changed?)\s+(?:files?\s+)?[`"']?([^\s`"',;]+\.[a-z]{1,8})[`"']?/i,
    /\bFiles?\s+(?:created|modified|changed|touched)\s*:/i,
    /\b(?:created|modified|changed|touched)\s+files?\s*:/i,
    /\bFiles?\s+(?:I|we)\s+(?:created|modified|changed|wrote|edited|updated)[:.]/i,
  ];

  for (const pattern of proseClaimPatterns) {
    if (pattern.test(text)) return true;
  }

  return false;
}

// ── Escape-clause scanner & rewriter (Change 4) ────────────────────────────

/**
 * Detected escape clause in a task description.
 *
 * Escape clauses are language patterns that signal an executor can choose
 * a lighter path ("or repair" = just check, "if already done" = do nothing).
 * These patterns dramatically increase the probability of text-only responses
 * because they give the executor permission to skip file creation.
 */
interface EscapeClause {
  /** The regex pattern that matched. */
  pattern: string;
  /** Classification of the escape type. */
  type: "or_fallback" | "validation_as_primary" | "conditional_skip";
  /** The exact text that matched the pattern. */
  match: string;
  /** Character index where the match starts in the description. */
  index: number;
}

/**
 * Known escape-clause patterns that weaken executor task descriptions.
 *
 * These regexes use \b (word boundary) anchors to avoid false positives
 * on file paths like "src/or/repair.ts" — only natural-language "or repair"
 * at word boundaries triggers detection.
 */
const ESCAPE_CLAUSE_PATTERNS: Array<{ regex: RegExp; type: EscapeClause["type"] }> = [
  { regex: /\bor\s+repair\b/i,                  type: "or_fallback" },
  { regex: /\bor\s+verify\b/i,                  type: "or_fallback" },
  { regex: /\bor\s+validate\b/i,                type: "validation_as_primary" },
  { regex: /\bif\s+(?:already\s+)?(?:done|exists|present)\b/i, type: "conditional_skip" },
  { regex: /\bcheck\s+if\s+(?:already\s+)?(?:exists|done|present)\b/i, type: "conditional_skip" },
  { regex: /\balready\s+(?:implemented|done|created|exists)\b/i, type: "conditional_skip" },
  { regex: /\b(?:just|simply|only)\s+check\b/i, type: "validation_as_primary" },
  { regex: /\bor\s+(?:confirm|ensure|make sure)\b/i, type: "or_fallback" },
  { regex: /\bno\s+changes?\s*(?:needed|required)\b/i, type: "conditional_skip" },
  { regex: /\b(?:implement|create|build|write|add|modify)\s+or\s+(?:confirm|check|verify)\b/i, type: "or_fallback" },
];

/**
 * Scan a task description for escape-clause patterns.
 *
 * Returns all matched clauses sorted by position in the description.
 * Empty array means the description is clean — no escape routes found.
 */
function scanEscapeClauses(description: string): EscapeClause[] {
  const found: EscapeClause[] = [];
  for (const { regex, type } of ESCAPE_CLAUSE_PATTERNS) {
    // Reset lastIndex for regexes that might carry state across the loop
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(description)) !== null) {
      found.push({
        pattern: regex.source,
        type,
        match: match[0],
        index: match.index,
      });
    }
  }
  // Sort by position for deterministic ordering
  found.sort((a, b) => a.index - b.index);
  return found;
}

/**
 * Rewrite a task description to close escape clauses.
 *
 * Applies type-specific rewrite rules:
 * - "or_fallback":  "or repair" → "and then repair (MANDATORY: do not skip)"
 * - "validation_as_primary": "just check" → "comprehensively inspect and report on"
 * - "conditional_skip": "if already done" → "ensuring completion of all steps"
 *
 * Returns the original description unchanged if no escape clauses are found.
 */
function rewriteEscapeClauses(description: string): string {
  const clauses = scanEscapeClauses(description);
  if (clauses.length === 0) return description;

  let rewritten = description;

  // Collect rewrites first, then apply from end to start to preserve indices
  const rewrites: Array<{ match: string; replacement: string }> = [];

  for (const clause of clauses) {
    switch (clause.type) {
      case "or_fallback": {
        // "or repair" / "or verify" / "or confirm" / "or ensure" / "or make sure"
        // Rewrite: "or X" → "and then X (MANDATORY: you MUST perform this step — do not skip)"
        const imperative = clause.match.replace(/\bor\s+/i, "and then ");
        rewrites.push({
          match: clause.match,
          replacement: `${imperative} (MANDATORY: you MUST perform this step — do not skip)`,
        });
        break;
      }
      case "validation_as_primary": {
        // "just check" / "simply check" / "only check" / "or validate"
        if (/\b(?:just|simply|only)\s+check\b/i.test(clause.match)) {
          rewrites.push({
            match: clause.match,
            replacement: clause.match.replace(
              /\b(?:just|simply|only)\s+check\b/i,
              "comprehensively inspect and report on",
            ),
          });
        } else {
          // "or validate" → "and then validate with concrete evidence"
          rewrites.push({
            match: clause.match,
            replacement:
              clause.match.replace(/\bor\s+/i, "and then ") +
              " with concrete evidence",
          });
        }
        break;
      }
      case "conditional_skip": {
        // "if already done/exists/present" / "check if exists" / "already implemented" / "no changes needed"
        if (/\bno\s+changes?\s*(?:needed|required)/i.test(clause.match)) {
          rewrites.push({
            match: clause.match,
            replacement: "all required changes must be produced",
          });
        } else if (/\bcheck\s+if\s+/i.test(clause.match)) {
          rewrites.push({
            match: clause.match,
            replacement:
              clause.match.replace(/\bcheck\s+if\s+/i, "ensure ") +
              " (create if missing, verify if present)",
          });
        } else if (
          /\bif\s+(?:already\s+)?(?:done|exists|present)\b/i.test(
            clause.match,
          )
        ) {
          rewrites.push({
            match: clause.match,
            replacement: "ensuring completion of all steps",
          });
        } else if (/\balready\s+/i.test(clause.match)) {
          rewrites.push({
            match: clause.match,
            replacement:
              clause.match.replace(/\balready\s+/i, "fully ") +
              " (verify nothing was skipped)",
          });
        } else {
          rewrites.push({
            match: clause.match,
            replacement:
              clause.match +
              " (MANDATORY: produce concrete output, do not skip)",
          });
        }
        break;
      }
    }
  }

  // Apply rewrites from end to start to preserve character indices
  for (const { match, replacement } of rewrites.reverse()) {
    // Replace only the first occurrence of each unique match
    rewritten = rewritten.replace(match, replacement);
  }

  return rewritten;
}

// ── Post-execution artifact evidence collection ─────────────────────────────

/**
 * Collects post-execution artifact evidence for the verifier as a structured
 * object (not a flat string). This enables hard enforcement gates — the
 * orchestrator can auto-fail a task when no file artifacts exist for
 * implementation work, rather than forwarding a soft warning.
 *
 * Unified pipeline (Change 5):
 *   git snapshot → per-task diff → output type validation →
 *   suffix cross-reference → escape scan → unified evidence
 *
 * - Accepts a Map<taskId, GitSnapshot> for per-task diff comparison.
 * - Attempts git status --short to detect modified/untracked files on disk.
 * - Falls back to executor output file claims when git is unavailable.
 * - Cross-references structured output suffix claims (files_created,
 *   files_modified) against git ground truth for each task.
 * - Validates output type contract per task (Change 2).
 * - Detects implementation tasks via isImplementationTask() and triggers hard
 *   gate failures when no disk evidence or file claims are found.
 * - Returns structured ArtifactEvidence for downstream gating logic.
 */
function collectArtifactEvidence(
  cwd: string,
  executorOutputs: ExecutorOutput[],
  options?: {
    preExecSnapshots?: Map<string, GitSnapshot>;
    outputTypes?: Map<string, TaskOutputType>;
  },
): ArtifactEvidence | undefined {
  const preExecSnapshots = options?.preExecSnapshots;
  const outputTypes = options?.outputTypes;
  let diskStatus = "";
  const diskFiles: string[] = [];
  let gitAvailable = false;
  const perTaskDiffs = new Map<string, GitDiff>();

  // ── git status --short (disk-level ground truth) ──────────────────────
  try {
    const gitResult = spawnSync("git", ["-C", cwd, "status", "--short"], {
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (gitResult.status === 0) {
      gitAvailable = true;
      const statusLines =
        gitResult.stdout?.trim().split("\n").filter(Boolean) ?? [];
      if (statusLines.length > 0) {
        diskStatus = statusLines.join("\n");
        for (const line of statusLines) {
          // git status --short format: "XY filename" (X=staging, Y=working-tree)
          const file = line.slice(3).trim();
          if (file && !diskFiles.includes(file)) diskFiles.push(file);
        }
      } else {
        diskStatus = "(working tree clean — no modified or untracked files)";
      }
    } else {
      diskStatus = `(git status returned exit code ${gitResult.status} — may not be a git repo)`;
    }
  } catch (_err) {
    diskStatus = "(git not available or command failed)";
  }

  // ── Per-task git diff against pre-execution snapshots (Change 1 + 5) ──
  if (preExecSnapshots && preExecSnapshots.size > 0 && gitAvailable) {
    const postSnapshotFiles: Array<{ status: string; path: string }> = [];
    const postStatus = diskStatus;
    if (postStatus && !postStatus.startsWith("(")) {
      for (const line of postStatus.split("\n").filter(Boolean)) {
        const status = line.slice(0, 2).trim() || "??";
        const path = line.slice(3).trim();
        if (path) postSnapshotFiles.push({ status, path });
      }
    }
    for (const [taskId, preSnapshot] of preExecSnapshots) {
      if (!preSnapshot.success) continue;
      const diff = computePostExecutionDiff(preSnapshot, {
        success: true,
        timestamp: new Date().toISOString(),
        files: postSnapshotFiles,
        rawStatus: postStatus,
      });
      perTaskDiffs.set(taskId, diff);
    }
  }

  // ── Combined executor diff (aggregate across all pre-snapshots) ──────
  let combinedDiff: GitDiff = { filesChanged: 0, newFiles: [], modifiedFiles: [], deletedFiles: [] };
  if (perTaskDiffs.size > 0) {
    const allNew = new Set<string>();
    const allMod = new Set<string>();
    const allDel = new Set<string>();
    for (const diff of perTaskDiffs.values()) {
      for (const f of diff.newFiles) allNew.add(f);
      for (const f of diff.modifiedFiles) allMod.add(f);
      for (const f of diff.deletedFiles) allDel.add(f);
    }
    combinedDiff = {
      filesChanged: allNew.size + allMod.size + allDel.size,
      newFiles: [...allNew],
      modifiedFiles: [...allMod],
      deletedFiles: [...allDel],
    };
  }

  // ── File-artifact claims from executor output text (regex-based) ──────
  const fileArtifactPatterns = [
    /\b(?:created?|wrote?|added?|modified?|edited?|updated?|changed?|generated?)\s+(?:file|the\s+)?\s*[`"']?([^\s`"',;]+[.][a-z]{1,6})[`"']?/gi,
  ];
  const fileClaims: string[] = [];
  for (const output of executorOutputs) {
    for (const pattern of fileArtifactPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(output.output)) !== null) {
        const claim = match[1];
        if (claim && !fileClaims.includes(claim)) fileClaims.push(claim);
      }
    }
  }

  // ── Git-unavailable fallback via executor file claims ─────────────────
  if (!gitAvailable && fileClaims.length > 0) {
    diskStatus = `(git not available; falling back to executor file claims: ${fileClaims.join(", ")})`;
  }

  // ── Implementation task detection ─────────────────────────────────────
  const hasImplementationTask = executorOutputs.some((output) =>
    isImplementationTask(output),
  );

  // ── Hard gate: no file artifacts for implementation work ───────────────
  const hardGateFailures: string[] = [];
  if (hasImplementationTask && diskFiles.length === 0 && fileClaims.length === 0) {
    hardGateFailures.push(
      "POST-EXECUTION GATE FAILURE: Implementation task(s) detected but no file artifacts found on disk " +
        "(git status --short shows no changes) and no file claims in executor outputs. " +
        "Text-only response for implementation task — auto-failing and triggering re-planning.",
    );
  }

  // ── Output type contract validation per-task (Change 2 + 5) ──────────
  const outputTypeViolations: string[] = [];
  for (const output of executorOutputs) {
    const resolvedType =
      outputTypes?.get(output.taskId) ??
      inferOutputTypeFromDescription(output.description);
    const violations = validateOutputTypeContract(resolvedType, {
      summary: "",
      hasImplementationTask: false,
      diskStatus: "",
      diskFiles,
      fileClaims,
      hardGateFailures: [],
      outputTypeViolations: [],
    });
    for (const v of violations) {
      outputTypeViolations.push(`Task ${output.taskId}: ${v}`);
    }
  }
  // Promote outputType violations to hard gate failures
  if (outputTypeViolations.length > 0) {
    hardGateFailures.push(
      `OUTPUT TYPE CONTRACT VIOLATIONS: ${outputTypeViolations.join("; ")}`,
    );
  }

  // ── Structured output suffix cross-reference against git ground truth ──
  // (Change 3 + 5): For each executor that provided an OUTPUT_CONTRACT
  // suffix, compare files_created/files_modified against the per-task git
  // diff. Flag discrepancies — the suffix is a self-report, git diff is
  // ground truth.
  for (const output of executorOutputs) {
    if (!output.outputSuffix) continue;
    const suffix = output.outputSuffix;
    const resolvedType =
      outputTypes?.get(output.taskId) ??
      inferOutputTypeFromDescription(output.description);
    const taskDiff = perTaskDiffs.get(output.taskId);

    // Validate suffix against expected output type
    const suffixViolations = validateOutputSuffixAgainstType(suffix, resolvedType);
    for (const v of suffixViolations) {
      outputTypeViolations.push(`Task ${output.taskId}: ${v}`);
    }

    // Cross-reference suffix file claims against git ground truth
    if (taskDiff && gitAvailable) {
      const gitDiffFiles = [
        ...taskDiff.newFiles.map((f) => f.toLowerCase()),
        ...taskDiff.modifiedFiles.map((f) => f.toLowerCase()),
      ];
      const suffixFileClaims = [
        ...suffix.files_created.filter((f) => f && !f.startsWith("REQUIRED:")),
        ...suffix.files_modified.filter((f) => f && !f.startsWith("REQUIRED:")),
      ];

      if (resolvedType === "file_change") {
        // Suffix claims files but git diff shows none — possible fabrication
        const hasConcreteSuffixClaims = suffixFileClaims.length > 0;
        const hasConcreteCommands = suffix.commands_run.some(
          (c) => c && !c.startsWith("REQUIRED:"),
        );

        if (hasConcreteSuffixClaims && taskDiff.filesChanged === 0) {
          hardGateFailures.push(
            `SUFFIX-GIT CROSS-REFERENCE FAILURE (Task ${output.taskId}): ` +
            `executor suffix claims ${suffixFileClaims.length} file(s) (${suffixFileClaims.join(", ")}) ` +
            `but git diff shows ZERO file changes. The executor may be fabricating file claims.`,
          );
        }

        if (!hasConcreteSuffixClaims && !hasConcreteCommands && taskDiff.filesChanged === 0) {
          hardGateFailures.push(
            `SUFFIX-GIT CROSS-REFERENCE FAILURE (Task ${output.taskId}): ` +
            `executor suffix declares zero files_created, zero files_modified, ` +
            `and zero commands_run — AND git diff confirms zero file changes. ` +
            `The executor self-reports producing nothing for a file_change task.`,
          );
        }

        // Check suffix claims that don't appear in git diff (unverified claims)
        const unverifiedSuffixClaims: string[] = [];
        for (const claim of suffixFileClaims) {
          const normalized = claim.toLowerCase().replace(/\\/g, "/");
          const found = gitDiffFiles.some(
            (gf) =>
              gf === normalized ||
              gf.endsWith("/" + normalized) ||
              normalized.endsWith("/" + gf),
          );
          if (!found) unverifiedSuffixClaims.push(claim);
        }
        if (unverifiedSuffixClaims.length > 0 && taskDiff.filesChanged > 0) {
          // Suffix claims files that aren't in the diff — possible fabrication or
          // files were created outside the task's time window. Log as info, not a
          // hard failure (the diff may capture changes from a different task window).
          outputTypeViolations.push(
            `Task ${output.taskId}: SUFFIX CROSS-REFERENCE NOTE — ${unverifiedSuffixClaims.length} suffix-claimed ` +
            `file(s) not found in per-task git diff: ${unverifiedSuffixClaims.join(", ")}. ` +
            `Git diff shows: ${gitDiffFiles.join(", ") || "(none)"}.`,
          );
        }
      }
    }

    // Cross-reference suffix exit_code/tests_passed internal consistency
    if (suffix.tests_passed === true && suffix.exit_code !== 0 && suffix.exit_code !== -1) {
      outputTypeViolations.push(
        `Task ${output.taskId}: SUFFIX INCONSISTENCY — tests_passed=true but exit_code=${suffix.exit_code}.`,
      );
    }
  }

  // ── Escape clause scan in executor output prose (Change 5 integration) ──
  // Scan each executor's output for escape-clause language. This catches
  // executors that used conditional-skip or or_fallback patterns to justify
  // producing nothing. Part of the unified prevention pipeline.
  const escapeClauseViolations: string[] = [];
  for (const output of executorOutputs) {
    if (!output.output) continue;
    const escapeClauses = scanEscapeClauses(output.output);
    for (const clause of escapeClauses) {
      if (clause.type === "conditional_skip") {
        escapeClauseViolations.push(
          `Task ${output.taskId}: ESCAPE CLAUSE IN OUTPUT — "${clause.match}" (${clause.type}) — ` +
          `executor used conditional-skip language, suggesting it chose to avoid producing artifacts.`,
        );
      }
    }
  }

  // Promote any new outputType violations to hard gate failures
  for (const v of outputTypeViolations) {
    if (!hardGateFailures.some((f) => f.includes(v))) {
      if (v.includes("VIOLATION") || v.includes("FAILURE")) {
        if (!hardGateFailures.includes(v)) hardGateFailures.push(v);
      }
    }
  }

  // Promote escapeClause violations to hard gate failures for implementation tasks
  for (const v of escapeClauseViolations) {
    if (!hardGateFailures.includes(v) && hasImplementationTask) {
      hardGateFailures.push(v);
    }
  }

  // Always return an evidence object when we have executor outputs
  // (even empty ones) so downstream gating has machine-readable data.
  if (executorOutputs.length === 0) return undefined;

  // ── Build human-readable unified summary ─────────────────────────────
  // Pipeline order: git snapshot → diff → output type → suffix → escape scan → unified evidence
  const parts: string[] = [];
  parts.push("## Artifact Evidence (unified prevention pipeline)");
  parts.push("");
  parts.push("**Pipeline:** git snapshot → diff → output type → suffix → escape scan → unified evidence");
  parts.push("");

  // ── STAGE 1: Has implementation tasks? ──────────────────────────────────
  parts.push(`- Has implementation task: ${hasImplementationTask}`);

  // ── STAGE 2: Git snapshot + diff (mechanical ground truth) ──────────────
  parts.push(`- Git available: ${gitAvailable}`);
  parts.push(`- Disk status:\n  ${diskStatus.replace(/\n/g, "\n  ")}`);
  if (perTaskDiffs.size > 0) {
    parts.push(`- Per-task git diff (${perTaskDiffs.size} task(s) with pre-spawn snapshots):`);
    for (const [taskId, diff] of perTaskDiffs) {
      parts.push(
        `  - ${taskId}: ${diff.filesChanged} file(s) changed ` +
        `(new=${diff.newFiles.length}, mod=${diff.modifiedFiles.length}, del=${diff.deletedFiles.length})`,
      );
      if (diff.newFiles.length > 0) {
        parts.push(`    - New: ${diff.newFiles.join(", ")}`);
      }
      if (diff.modifiedFiles.length > 0) {
        parts.push(`    - Modified: ${diff.modifiedFiles.join(", ")}`);
      }
      if (diff.deletedFiles.length > 0) {
        parts.push(`    - Deleted: ${diff.deletedFiles.join(", ")}`);
      }
    }

    // Combined diff summary
    if (perTaskDiffs.size > 1) {
      parts.push(
        `- Combined diff (deduplicated): ${combinedDiff.filesChanged} unique file(s) changed ` +
        `(new=${combinedDiff.newFiles.length}, mod=${combinedDiff.modifiedFiles.length}, del=${combinedDiff.deletedFiles.length})`,
      );
    }
  } else if (combinedDiff.filesChanged > 0) {
    parts.push(
      `- Executor-specific diff: ${combinedDiff.filesChanged} file(s) changed ` +
      `(new=${combinedDiff.newFiles.length}, mod=${combinedDiff.modifiedFiles.length}, del=${combinedDiff.deletedFiles.length})`,
    );
  }

  // ── STAGE 3: Output type classification (semantic contract) ────────────
  if (outputTypes && outputTypes.size > 0) {
    parts.push(`- Task output type classification:`);
    for (const [taskId, ot] of outputTypes) {
      parts.push(`  - ${taskId}: ${ot}`);
    }
  }

  // ── STAGE 4: Structured output suffix (executor self-report) ────────────
  const tasksWithSuffix = executorOutputs.filter((o) => o.outputSuffix);
  if (tasksWithSuffix.length > 0) {
    parts.push(`- Structured output suffix evidence (${tasksWithSuffix.length} task(s)):`);
    for (const output of tasksWithSuffix) {
      const s = output.outputSuffix!;
      const concreteCreated = s.files_created.filter((f) => f && !f.startsWith("REQUIRED:"));
      const concreteModified = s.files_modified.filter((f) => f && !f.startsWith("REQUIRED:"));
      const concreteCommands = s.commands_run.filter((c) => c && !c.startsWith("REQUIRED:"));
      parts.push(
        `  - ${output.taskId}: files_created=${concreteCreated.length} (${concreteCreated.join(", ") || "none"}), ` +
        `files_modified=${concreteModified.length} (${concreteModified.join(", ") || "none"}), ` +
        `commands=${concreteCommands.length} (${concreteCommands.join(", ") || "none"}), ` +
        `tests_passed=${s.tests_passed}, exit_code=${s.exit_code}`,
      );
    }
  }

  if (fileClaims.length > 0) {
    parts.push(`- Regex file claims from executor outputs: ${fileClaims.join(", ")}`);
  }

  // ── STAGE 5: Escape clause scan (prevention against text-only evasion) ──
  if (escapeClauseViolations.length > 0) {
    parts.push(`- **ESCAPE CLAUSE VIOLATIONS:**\n  ${escapeClauseViolations.join("\n  ")}`);
  } else {
    parts.push(`- Escape clause violations: none`);
  }

  // ── STAGE 6: Violations summary (output type + other contract breaches) ──
  if (outputTypeViolations.length > 0) {
    parts.push(`- **Output type / suffix violations:**\n  ${outputTypeViolations.join("\n  ")}`);
  }

  if (hardGateFailures.length > 0) {
    parts.push(`- **HARD GATE FAILURES:**\n  ${hardGateFailures.join("\n  ")}`);
  }

  // ── Aggregate git diff gate for implementation tasks ─────────────
  // Check combined diff (or per-task diffs) for zero changes
  const anyDiffChanges = perTaskDiffs.size > 0
    ? [...perTaskDiffs.values()].some((d) => d.filesChanged > 0)
    : combinedDiff.filesChanged > 0;

  if (hasImplementationTask && !anyDiffChanges) {
    if (!hardGateFailures.some((f) => f.includes("git diff"))) {
      hardGateFailures.push(
        "EXECUTOR DIFF GATE FAILURE: Pre/post-spawn git diff shows ZERO executor-attributable file changes " +
        "for an implementation task. The executor did not create, modify, or delete any files on disk. " +
        "This is a mechanical ground-truth check — no amount of prose can defeat git diff.",
      );
    }
  }

  return {
    summary: parts.join("\n"),
    hasImplementationTask,
    diskStatus,
    diskFiles,
    fileClaims,
    hardGateFailures,
    outputTypeViolations,
    escapeClauseViolations,
  };
}

// ── Executor output quality & task-size enforcement helpers ─────────────────

/**
 * Detects whether a task description or executor output describes
 * implementation work (CREATE, IMPLEMENT, BUILD, MODIFY, ADD, WRITE,
 * GENERATE keywords, case-insensitive).
 */
function isImplementationTask(task: PlanTask | ExecutorOutput): boolean {
  const implPattern = /\b(CREATE|IMPLEMENT|BUILD|MODIFY|ADD|WRITE|GENERATE)\b/i;
  return implPattern.test(task.description);
}

/**
 * Scans executor outputs for quality failures: truncation signals,
 * mid-sentence cutoffs, unclosed JSON blocks/objects, text-only
 * responses for implementation tasks, file-claim verification against
 * git ground truth, and internal consistency checks.
 *
 * MUTATES ExecutorOutput objects: sets truncated=true and
 * contextExhaustionSignal=true on any output where truncation or
 * context-exhaustion patterns are detected post-hoc.
 *
 * Returns human-readable failure reasons that the orchestrator loop
 * uses to decide auto-retry/replanning (Hypothesis C).
 */
function detectExecutorOutputQualityFailures(
  executorOutputs: ExecutorOutput[],
  artifactEvidence?: ArtifactEvidence,
): string[] {
  const failures: string[] = [];

  for (const output of executorOutputs) {
    const text = output.output?.trim() ?? "";
    if (!text) {
      failures.push(
        `${output.taskId}: empty executor output — no content returned.`,
      );
      output.truncated = true;
      output.contextExhaustionSignal = true;
      continue;
    }

    // ── Truncation signals ────────────────────────────────────────────
    const truncationSignals: RegExp[] = [
      /\b(?:truncated|cut off|too long|exceeded)\b/i,
      /\.\.\.\s*$/m, // trailing ellipsis at end of output (mid-sentence cutoff)
      /(?:content|output|response)\s+(?:has been|was)\s+truncated/i,
    ];
    let hasTruncationSignal = false;
    for (const signal of truncationSignals) {
      if (signal.test(text)) {
        failures.push(
          `${output.taskId}: truncation signal detected — "${text.slice(-120).replace(/\n/g, "\\n")}".`,
        );
        output.truncated = true;
        output.contextExhaustionSignal = true;
        hasTruncationSignal = true;
        break;
      }
    }
    if (hasTruncationSignal) continue;

    // ── Mid-sentence cutoff (no sentence terminator at end) ────────────
    const sentenceEnders = /[.?!}\])"'\n]/;
    if (!sentenceEnders.test(text.slice(-1)) && text.length > 100) {
      failures.push(
        `${output.taskId}: possible mid-sentence cutoff — output ends with "${text.slice(-80).replace(/\n/g, "\\n")}".`,
      );
      output.truncated = true;
    }

    // ── Unclosed JSON code fences ─────────────────────────────────────
    const jsonFenceCount = (text.match(/```json/g) ?? []).length;
    const closeFenceCount = (text.match(/```/g) ?? []).length;
    if (jsonFenceCount > 0 && closeFenceCount < jsonFenceCount * 2) {
      failures.push(
        `${output.taskId}: unclosed JSON code fence — likely truncated.`,
      );
      output.truncated = true;
    }

    // ── Unclosed JSON object/array near end ────────────────────────────
    const lastOpenBrace = text.lastIndexOf("{");
    const lastCloseBrace = text.lastIndexOf("}");
    const lastOpenBracket = text.lastIndexOf("[");
    const lastCloseBracket = text.lastIndexOf("]");
    if (
      lastOpenBrace > lastCloseBrace &&
      lastOpenBrace > text.length - 300
    ) {
      failures.push(
        `${output.taskId}: unclosed JSON object near end of output — likely truncated.`,
      );
      output.truncated = true;
    }
    if (
      lastOpenBracket > lastCloseBracket &&
      lastOpenBracket > text.length - 300
    ) {
      failures.push(
        `${output.taskId}: unclosed JSON array near end of output — likely truncated.`,
      );
      output.truncated = true;
    }

    // ── Text-only response for implementation task ─────────────────────
    if (isImplementationTask(output)) {
      const toolUsagePattern = /write|edit|bash|read|grep|find|ls|mkdir/i;
      if (!toolUsagePattern.test(text)) {
        failures.push(
          `${output.taskId}: implementation task returned text-only response with no evidence ` +
            "of tool usage (write/edit/bash) — likely a text report describing what *would* be " +
            "done rather than actual file creation.",
        );
      }
    }

    // ── Escape-clause usage in output (Change 4) ──────────────────────
    // Scan executor output for escape-clause language. If the executor
    // uses phrases like "or repair", "no changes needed", "if already
    // done", or "already exists" in their response, they are signaling
    // that they chose the escape route rather than producing artifacts.
    const escapeClausesInOutput = scanEscapeClauses(text);
    for (const clause of escapeClausesInOutput) {
      // Only flag if the escape clause appears as a justification pattern
      // (e.g., "no changes were needed" — executor is claiming they didn't
      // need to do anything, which is an escape from file_change obligations).
      if (clause.type === "conditional_skip") {
        failures.push(
          `${output.taskId}: ESCAPE CLAUSE IN OUTPUT — "${clause.match}" (${clause.type}): ` +
            "executor used conditional-skip language in response, suggesting it chose to avoid " +
            "producing artifacts. Pattern: " + clause.pattern,
        );
      }
    }
    // If the output has or_fallback patterns for implementation tasks, flag it
    if (isImplementationTask(output)) {
      const orFallbackInOutput = escapeClausesInOutput.filter(
        (c) => c.type === "or_fallback",
      );
      if (orFallbackInOutput.length > 0) {
        failures.push(
          `${output.taskId}: ESCAPE CLAUSE IN OUTPUT — ${orFallbackInOutput.length} "or_fallback" pattern(s) ` +
            `detected: ${orFallbackInOutput.map((c) => `"${c.match}"`).join(", ")}. ` +
            "Implementation task output should not contain fallback language — this indicates the executor " +
            "chose the lighter path rather than completing the implementation.",
        );
      }
    }

    // ── Internal consistency checks ───────────────────────────────────
    // Contradiction: claims "all tests passed" but exit code is non-zero
    if (output.exitCode !== null && output.exitCode !== 0) {
      const passedPattern = /\b(?:all tests passed|tests pass|everything (?:is )?ok|no failures|success(?:fully)?)\b/i;
      if (passedPattern.test(text)) {
        failures.push(
          `${output.taskId}: internal inconsistency — output claims success/tests-pass ` +
            `but exit code is ${output.exitCode}.`,
        );
      }
    }

    // Contradiction: claims "no files changed" but file-claim evidence exists
    const noChangesPattern = /\b(?:no (?:files? (?:were )?(?:changed|modified|created|edited|touched))|no changes? (?:were )?made)\b/i;
    if (noChangesPattern.test(text)) {
      const claimCount = extractFileArtifactClaimsFromText(text).length;
      if (claimCount > 0) {
        failures.push(
          `${output.taskId}: internal inconsistency — output claims no files changed ` +
            `but mentions ${claimCount} file artifact(s).`,
        );
      }
    }

    // Contradiction: output mentions editing files but exit code indicates failure
    if (output.exitCode !== null && output.exitCode !== 0) {
      const fileClaims = extractFileArtifactClaimsFromText(text);
      if (fileClaims.length > 0 && !hasTruncationSignal) {
        failures.push(
          `${output.taskId}: internal inconsistency — output claims files edited ` +
            `(${fileClaims.join(", ")}) but exit code is ${output.exitCode}.`,
        );
      }
    }

    // Suspicious: very short response for a complex implementation task
    const minImplWords = 30;
    if (isImplementationTask(output) && text.split(/\s+/).length < minImplWords) {
      failures.push(
        `${output.taskId}: implementation task returned suspiciously short output ` +
          `(${text.split(/\s+/).length} words) — likely truncated or empty execution.`,
      );
      output.truncated = true;
    }
  }

  // ── File-claim verification via git ground truth ──────────────────────
  // Cross-reference executor file claims against actual disk files from git.
  // When git is available, claims not matching ground truth are failures.
  if (artifactEvidence && artifactEvidence.fileClaims.length > 0) {
    const diskFilesLower = artifactEvidence.diskFiles.map((f) => f.toLowerCase());
    const isGitAvailable = artifactEvidence.diskStatus.length > 0 &&
      !artifactEvidence.diskStatus.startsWith("(git not available");

    if (isGitAvailable && artifactEvidence.diskFiles.length > 0) {
      // Git is available and shows changes — verify each claim
      const unverifiedClaims: string[] = [];
      for (const claim of artifactEvidence.fileClaims) {
        // Normalize: trim quotes, resolve relative paths
        const normalized = claim.replace(/^[`"']+|[`"']+$/g, "").replace(/\\/g, "/");
        const isOnDisk = diskFilesLower.some((diskFile) => {
          return diskFile === normalized.toLowerCase() ||
            diskFile.endsWith("/" + normalized.toLowerCase()) ||
            normalized.toLowerCase().endsWith("/" + diskFile);
        });
        if (!isOnDisk) {
          unverifiedClaims.push(claim);
        }
      }
      if (unverifiedClaims.length > 0) {
        failures.push(
          `FILE-CLAIM VERIFICATION FAILURE: ${unverifiedClaims.length} file claim(s) ` +
            `not found in git ground truth — ${unverifiedClaims.join(", ")}. ` +
            `Disk files: ${artifactEvidence.diskFiles.join(", ") || "(none)"}.`,
        );
      }
    } else if (!isGitAvailable && artifactEvidence.fileClaims.length > 0) {
      // Git unavailable — can't verify, but note it
      // Check if claims look like plausible relative paths
      const implausibleClaims = artifactEvidence.fileClaims.filter((claim) => {
        const normalized = claim.replace(/^[`"']+|[`"']+$/g, "");
        return !/^[a-zA-Z0-9_./\\-]+$/.test(normalized) || normalized.includes("..");
      });
      if (implausibleClaims.length > 0) {
        failures.push(
          `FILE-CLAIM VERIFICATION WARNING: ${implausibleClaims.length} implausible file claim(s) ` +
            `detected — ${implausibleClaims.join(", ")}. (Git unavailable for ground-truth verification.)`,
        );
      }
    }

    // Cross-check: if hasImplementationTask but no diskFiles and no fileClaims
    if (
      artifactEvidence.hasImplementationTask &&
      artifactEvidence.diskFiles.length === 0 &&
      artifactEvidence.fileClaims.length === 0 &&
      isGitAvailable
    ) {
      failures.push(
        "CONSISTENCY GATE FAILURE: Implementation task(s) detected but " +
          "zero file claims in executor outputs AND zero files on disk. " +
          "No evidence any implementation work was performed.",
      );
    }
  }

  // ── Cross-output consistency: deduplicate contradictory claims ────────
  // If two outputs claim to have created/modified the same file, flag it
  if (executorOutputs.length > 1) {
    const fileClaimMap = new Map<string, string[]>(); // file → taskIds that claim it
    for (const output of executorOutputs) {
      const claims = extractFileArtifactClaimsFromText(output.output ?? "");
      for (const claim of claims) {
        const existing = fileClaimMap.get(claim.toLowerCase()) ?? [];
        existing.push(output.taskId);
        fileClaimMap.set(claim.toLowerCase(), existing);
      }
    }
    for (const [file, taskIds] of fileClaimMap) {
      if (taskIds.length > 1) {
        failures.push(
          `CROSS-OUTPUT CONSISTENCY: file "${file}" claimed by multiple tasks ` +
            `(${taskIds.join(", ")}) — potential conflict or duplicate work.`,
        );
      }
    }
  }

  return failures;
}

/**
 * Extract file artifact claims from a single executor output text.
 * Matches patterns like "created file X", "edited X", "wrote to X", "modified X".
 */
function extractFileArtifactClaimsFromText(text: string): string[] {
  const claims: string[] = [];
  const patterns: RegExp[] = [
    /\b(?:created?|wrote?|added?|modified?|edited?|updated?|changed?|generated?)\s+(?:file|the\s+)?\s*[`"']?([^\s`"',;]+[.][a-z]{1,8})[`"']?/gi,
    /\b(?:touched?|changed?)\s+(?:files?\s+)?[`"']?([^\s`"',;]+[.][a-z]{1,8})[`"']?/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const claim = match[1];
      if (claim && !claims.includes(claim)) claims.push(claim);
    }
  }
  return claims;
}

/**
 * Enforces a task-size cap by splitting large task descriptions into
 * chained subtasks (Hypothesis B). Preserves dependency chains so
 * execution ordering is correct.
 *
 * Strategy:
 * - Tasks with descriptions ≤ maxWords pass through unchanged.
 * - Tasks exceeding maxWords are split into subtasks of ≤ (maxWords - 20) words.
 * - Subtasks are chained: part-N depends on part-(N-1).
 * - Other tasks that depended on the original task are remapped to depend
 *   on the LAST subtask in the chain.
 *
 * @param plan The plan to cap.
 * @param maxWords Maximum words per task description (default 200).
 * @returns A new Plan with tasks split as needed.
 */
function enforceTaskSizeCap(plan: Plan, maxWords: number = 200): Plan {
  const splitMaxWords = Math.max(40, maxWords - 20);
  const newTasks: PlanTask[] = [];

  for (const task of plan.tasks) {
    const wordCount = task.description.split(/\s+/).length;
    if (wordCount <= maxWords) {
      newTasks.push(task);
      continue;
    }

    // Split description into sentences or clauses
    const sentences = task.description.split(/(?<=[.!?])\s+/).filter(Boolean);
    const subtaskDescriptions: string[] = [];
    let current = "";
    let currentWords = 0;

    for (const sentence of sentences) {
      const sentenceWords = sentence.split(/\s+/).length;
      if (currentWords + sentenceWords > splitMaxWords && currentWords > 0) {
        subtaskDescriptions.push(current.trim());
        current = sentence;
        currentWords = sentenceWords;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
        currentWords += sentenceWords;
      }
    }
    if (current.trim()) {
      subtaskDescriptions.push(current.trim());
    }

    // If splitting didn't help, keep original
    if (subtaskDescriptions.length <= 1) {
      newTasks.push(task);
      continue;
    }

    // Create chained subtasks
    const baseId = task.id;
    for (let i = 0; i < subtaskDescriptions.length; i++) {
      const subtaskId = `${baseId}-part${i + 1}`;
      const deps: string[] =
        i === 0 ? [...task.dependsOn] : [`${baseId}-part${i}`];
      newTasks.push({
        id: subtaskId,
        description: subtaskDescriptions[i],
        dependsOn: deps,
        agent: task.agent,
        role: task.role,
        model: task.model,
        provider: task.provider,
        outputType: task.outputType,
      });
    }
  }

  // ── Remap dependencies: tasks that depended on a split task now
  //     depend on its LAST subtask ─────────────────────────────────────
  const splitBaseIds = new Set(
    newTasks
      .filter((t) => t.id.includes("-part"))
      .map((t) => t.id.replace(/-part\d+$/, "")),
  );

  for (const task of newTasks) {
    const remapped: string[] = [];
    for (const dep of task.dependsOn) {
      if (splitBaseIds.has(dep)) {
        const lastPart = newTasks
          .filter((t) => t.id.startsWith(`${dep}-part`))
          .sort()
          .pop();
        remapped.push(lastPart?.id ?? dep);
      } else {
        remapped.push(dep);
      }
    }
    task.dependsOn = [...new Set(remapped)];
  }

  return { ...plan, tasks: newTasks };
}

// ── Shared utility functions (local to this shape) ──────────────────────────

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tiered Executor Recovery — backbone escalation: pre-spawn → continue → split → replan
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a single executor task with tiered recovery escalation.
 *
 * Backbone escalation (in order):
 *   Tier 0 — Pre-spawn budget estimation: if prompt exceeds safe budget,
 *           proactively split the task before dispatch.
 *   Tier 1 — Normal spawn: dispatch the executor task as usual.
 *   Tier 2 — Handoff continuation (CONTINUE): if context exhaustion is
 *           detected, look for a continuation contract or derive metadata
 *           from partial output, and spawn a continuation executor.
 *   Tier 3 — Split-and-respawn (SPLIT): if handoff fails or isn't possible,
 *           split the task into ≤150-word chained subtasks.
 *   Tier 4 — Replan-with-learning (REPLAN): if all else fails, add recovery
 *           metadata to failureReasons so the next planner attempt can adapt.
 *
 * Respects SpawnGuard.wouldFit() before every spawn.
 */
async function executeExecutorTaskWithRecovery(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  task: PlanTask,
  plan: Plan,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
): Promise<ExecutorOutput> {
  const resolvedAgent = resolveTaskAgent(task, params, agents);
  const mergedOverride = mergeModelOverrides(
    mergeModelOverrides(
      toModelOverride(params.executorModel, params.executorProvider),
      inferredRuntimeModelForTask(task, resolvedAgent, inferredModelRouting),
    ),
    { model: task.model, provider: task.provider },
  );

  if (resolvedAgent !== params.executorAgent) {
    emit(
      `Task ${task.id}: assigned to agent "${resolvedAgent}" (planner-named runtime role: ${task.role ?? "(no role hint)"}).`,
    );
  }

  // ── Pre-execution git snapshot (Change 1 foundation) ─────────────
  const preExecSnapshot = capturePreExecutionGitSnapshot(params.cwd);
  const gitForcingBlock = buildGitDiffForcingBlock(preExecSnapshot);
  if (preExecSnapshot.success) {
    emit(
      `Task ${task.id}: pre-exec git snapshot captured (${preExecSnapshot.files.length} pre-existing file(s) in working tree).`,
    );
  } else {
    emit(
      `Task ${task.id}: git snapshot unavailable — skipping git forcing block.`,
    );
  }

  const prompt = buildExecutorPrompt(state.intake!, plan, task, gitForcingBlock);

  // ── Tier 0: Pre-spawn budget estimation ────────────────────────────
  const budget = estimateExecutorContextBudget(
    prompt.length,
    mergedOverride?.model ?? params.executorModel,
    { criticalThreshold: 60 },
  );

  emit(
    `Task ${task.id}: pre-spawn budget: ${budget.saturationPercent}% sat ` +
    `(${budget.risk}), rec: ${budget.recommendation}`,
  );

  const maxDepth = state.maxRecoveryDepth;

  // ── Proactive split before dispatch ────────────────────────────────
  if (
    budget.recommendation === "SPLIT_BEFORE_SPAWN" &&
    state.recoveryDepth < maxDepth &&
    state.spawnGuard.wouldFit(1)
  ) {
    emit(`Task ${task.id}: SPLIT_BEFORE_SPAWN — splitting proactively.`);
    return splitAndExecuteTask(
      state, params, agents, task, plan, "",
      signal, emit, inheritedModel, inferredModelRouting,
      resolvedAgent, mergedOverride, budget,
    );
  }

  // ── Tier 1: Normal spawn ───────────────────────────────────────────
  if (!state.spawnGuard.wouldFit(1)) {
    emit(`Task ${task.id}: spawn ceiling exhausted before dispatch.`);
    return {
      taskId: task.id,
      description: task.description,
      agentName: resolvedAgent,
      output: `Spawn ceiling exhausted before ${task.id} could be dispatched.`,
      exitCode: 1,
      durationMs: 0,
      contextBudget: budget,
    };
  }

  let result: SubagentResult;
  try {
    result = await spawnChecked(
      state, params, agents, resolvedAgent, "executor",
      prompt, signal, emit, inheritedModel, mergedOverride,
      { taskId: task.id, semanticRole: task.role },
    );
  } catch (err) {
    emit(`Task ${task.id}: spawn failed — ${String(err)}`);
    return {
      taskId: task.id,
      description: task.description,
      agentName: resolvedAgent,
      output: `Spawn error: ${String(err)}`,
      stderr: String(err),
      exitCode: 1,
      durationMs: 0,
      contextBudget: budget,
    };
  }

  // ── Parse structured output suffix (Change 3) ────────────────────
  const outputSuffix = parseExecutorOutputSuffix(result.text);
  if (outputSuffix) {
    const outputType = classifyTaskOutputType(task);
    const suffixViolations = validateOutputSuffixAgainstType(outputSuffix, outputType);
    if (suffixViolations.length > 0) {
      emit(
        `Task ${task.id}: OUTPUT SUFFIX VIOLATIONS — ${suffixViolations.join("; ")}`,
      );
    } else {
      emit(
        `Task ${task.id}: output suffix parsed — ` +
        `files_created=${outputSuffix.files_created.length}, ` +
        `files_modified=${outputSuffix.files_modified.length}, ` +
        `commands_run=${outputSuffix.commands_run.length}, ` +
        `tests_passed=${outputSuffix.tests_passed}, ` +
        `exit_code=${outputSuffix.exit_code}`,
      );
    }
  } else {
    // Fallback: check if the output has file claims in prose
    const taskOutputType = classifyTaskOutputType(task);
    if (taskOutputType === "file_change" && !hasFileClaimsInProse(result.text)) {
      emit(
        `Task ${task.id}: WARNING — no output suffix found AND no file claims in prose for file_change task. ` +
        `The executor may have produced a text-only response.`,
      );
    } else if (!outputSuffix) {
      emit(
        `Task ${task.id}: no structured output suffix found in executor response ` +
        `(outputType=${taskOutputType}).`,
      );
    }
  }

  const output: ExecutorOutput = {
    taskId: task.id,
    description: task.description,
    agentName: result.agentName,
    output: result.text,
    stderr: result.stderr || undefined,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    contextBudget: budget,
    truncated: result.truncated,
    contextExhaustionSignal: result.contextExhaustionSignal,
    preExecSnapshot,
    outputSuffix: outputSuffix ?? undefined,
    toolCalls: result.toolCalls,
  };

  // ── Post-execution git diff (Change 1) ───────────────────────────
  if (preExecSnapshot.success) {
    const postSnapshot = capturePreExecutionGitSnapshot(params.cwd);
    const diff = computePostExecutionDiff(preExecSnapshot, postSnapshot);
    output.filesChanged = diff.filesChanged;
    output.changedFiles = [...diff.newFiles, ...diff.modifiedFiles, ...diff.deletedFiles];
    emit(
      `Task ${task.id}: post-exec git diff — ${diff.filesChanged} file(s) changed ` +
      `(new=${diff.newFiles.length}, mod=${diff.modifiedFiles.length}, del=${diff.deletedFiles.length}); ` +
      `tool calls ${formatToolCallSummary(result.toolCalls)}.`,
    );
    if (diff.filesChanged === 0 && isImplementationTask(task)) {
      emit(
        `Task ${task.id}: WARNING — implementation task produced zero git-detectable file changes.`,
      );
    }
  }

  // ── Post-spawn: check for context exhaustion ────────────────────────
  if (!checkContextExhaustion(result)) return output;

  emit(
    `Task ${task.id}: context exhaustion detected (trunc=${result.truncated}, ` +
    `signal=${result.contextExhaustionSignal}) — entering recovery.`,
  );
  state.recoveryLog.push(
    `[RECOVERY] ${task.id} a${state.attempt}: context exhaustion detected. Starting escalation.`,
  );

  // ── Tier 2: Handoff continuation (CONTINUE) ────────────────────────
  if (state.recoveryDepth < maxDepth && state.spawnGuard.wouldFit(1)) {
    emit(`Task ${task.id}: attempting handoff continuation (CONTINUE)...`);

    const contract = tryReadContinuationContract(task.id, params.cwd);
    const continuationPrompt = buildExecutorContinuationPrompt({
      taskId: task.id,
      taskDescription: task.description,
      contract: contract ?? undefined,
      priorOutput: result.text,
    });

    let continueResult: SubagentResult;
    try {
      continueResult = await spawnChecked(
        state, params, agents, resolvedAgent, "executor",
        continuationPrompt, signal, emit, inheritedModel, mergedOverride,
        { taskId: `${task.id}-continue`, semanticRole: task.role },
      );
    } catch {
      emit(`Task ${task.id}: handoff continuation spawn failed — escalating to split.`);
      state.recoveryLog.push(
        `[RECOVERY] ${task.id}: CONTINUE spawn failed — escalating to SPLIT.`,
      );
      // Fall through to Tier 3
      return trySplitAndExecute(
        state, params, agents, task, plan, result.text,
        signal, emit, inheritedModel, inferredModelRouting,
        resolvedAgent, mergedOverride, budget, maxDepth,
      );
    }

    if (!checkContextExhaustion(continueResult)) {
      emit(`Task ${task.id}: handoff continuation succeeded.`);
      state.recoveryLog.push(
        `[RECOVERY] ${task.id}: CONTINUE tier succeeded.`,
      );
      return mergeExecutorOutputs(output, {
        taskId: task.id,
        description: task.description,
        agentName: continueResult.agentName,
        output: `## CONTINUATION\n${continueResult.text}`,
        exitCode: continueResult.exitCode,
        durationMs: continueResult.durationMs,
        contextBudget: budget,
        truncated: continueResult.truncated,
        contextExhaustionSignal: continueResult.contextExhaustionSignal,
      });
    }

    emit(`Task ${task.id}: handoff continuation also exhausted — escalating to split.`);
    state.recoveryLog.push(
      `[RECOVERY] ${task.id}: CONTINUE exhausted — escalating to SPLIT.`,
    );
  }

  return trySplitAndExecute(
    state, params, agents, task, plan, result.text,
    signal, emit, inheritedModel, inferredModelRouting,
    resolvedAgent, mergedOverride, budget, maxDepth,
  );
}

/**
 * Try Tier 3 (SPLIT) and fall through to Tier 4 (REPLAN) if needed.
 */
async function trySplitAndExecute(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  task: PlanTask,
  plan: Plan,
  partialOutput: string,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
  resolvedAgent: string,
  mergedOverride: RoleModelOverride | undefined,
  budget: ContextBudget,
  maxDepth: number,
): Promise<ExecutorOutput> {
  // ── Tier 3: Split-and-respawn (SPLIT) ──────────────────────────────
  if (state.recoveryDepth < maxDepth && state.spawnGuard.wouldFit(1)) {
    emit(`Task ${task.id}: attempting split-and-respawn (SPLIT)...`);
    return splitAndExecuteTask(
      state, params, agents, task, plan, partialOutput,
      signal, emit, inheritedModel, inferredModelRouting,
      resolvedAgent, mergedOverride, budget,
    );
  }

  // ── Tier 4: Replan-with-learning (REPLAN) ──────────────────────────
  return escalateToReplan(state, task, partialOutput, resolvedAgent, budget);
}

/**
 * Split a task into chained subtasks and execute them sequentially.
 * Shared between Tier 0 (proactive pre-spawn split) and Tier 3 (split-and-respawn).
 */
async function splitAndExecuteTask(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  task: PlanTask,
  _plan: Plan,
  partialOutput: string,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  _inferredModelRouting: InferredModelRouting,
  resolvedAgent: string,
  mergedOverride: RoleModelOverride | undefined,
  budget: ContextBudget,
): Promise<ExecutorOutput> {
  const split = splitTaskOnFailure(
    task.id,
    task.description,
    partialOutput,
    state.recoveryDepth,
    { preserveDependsOn: task.dependsOn },
  );

  state.recoveryDepth = split.newDepth;

  emit(
    `Task ${task.id}: split into ${split.subtasks.length} subtask(s) ` +
    `(depth ${state.recoveryDepth}/${state.maxRecoveryDepth})`,
  );

  const subtaskOutputs: ExecutorOutput[] = [];

  for (const subtask of split.subtasks) {
    if (!state.spawnGuard.wouldFit(1)) {
      emit(
        `Task ${task.id}: spawn ceiling reached mid-split (${state.spawnGuard.spawned}/${state.spawnGuard.cap}) — stopping subtask chain.`,
      );
      break;
    }

    const subtaskPrompt = buildSubtaskExecutorPrompt(
      subtask,
      task.description,
      partialOutput,
      split.metadata,
    );

    let subtaskResult: SubagentResult;
    try {
      subtaskResult = await spawnChecked(
        state, params, agents, resolvedAgent, "executor",
        subtaskPrompt, signal, emit, inheritedModel, mergedOverride,
        { taskId: subtask.id, semanticRole: task.role },
      );
    } catch (err) {
      emit(`Task ${task.id}: subtask ${subtask.id} spawn failed — ${String(err)}`);
      subtaskOutputs.push({
        taskId: subtask.id,
        description: subtask.description,
        agentName: resolvedAgent,
        output: `Subtask spawn failed: ${String(err)}`,
        exitCode: 1,
        durationMs: 0,
        contextBudget: budget,
      });
      continue;
    }

    subtaskOutputs.push({
      taskId: subtask.id,
      description: subtask.description,
      agentName: subtaskResult.agentName,
      output: subtaskResult.text,
      stderr: subtaskResult.stderr || undefined,
      exitCode: subtaskResult.exitCode,
      durationMs: subtaskResult.durationMs,
      contextBudget: budget,
      truncated: subtaskResult.truncated,
      contextExhaustionSignal: subtaskResult.contextExhaustionSignal,
    });

    // If this subtask also shows exhaustion, stop spawning more
    if (checkContextExhaustion(subtaskResult)) {
      emit(`Task ${task.id}: subtask ${subtask.id} also exhausted — stopping chain.`);
      break;
    }
  }

  // Chain outputs into one ExecutorOutput
  if (subtaskOutputs.length === 0) {
    return escalateToReplan(state, task, partialOutput, resolvedAgent, budget);
  }

  const chainedOutput = chainExecutorOutputs(
    subtaskOutputs,
    task.description,
    task.id,
  );

  const totalDuration = subtaskOutputs.reduce((sum, o) => sum + o.durationMs, 0);
  const allClean = subtaskOutputs.every((o) => o.exitCode === 0);

  state.recoveryLog.push(
    `[RECOVERY] ${task.id}: SPLIT tier completed — ${subtaskOutputs.length} subtask(s), all_clean=${allClean}`,
  );

  return {
    taskId: task.id,
    description: task.description,
    agentName: resolvedAgent,
    output: chainedOutput,
    exitCode: allClean ? 0 : 1,
    durationMs: totalDuration,
    contextBudget: budget,
  };
}

/**
 * Escalate to Tier 4: add recovery metadata to failureReasons for
 * replan-with-learning on the next planning attempt.
 */
function escalateToReplan(
  state: OrchestrationState,
  task: PlanTask,
  partialOutput: string,
  agentName: string,
  budget: ContextBudget,
): ExecutorOutput {
  const metadata = buildRecoveryMetadata(
    task.id,
    task.description,
    [{
      taskId: task.id,
      description: task.description,
      agentName,
      output: partialOutput,
      exitCode: 1,
      durationMs: 0,
    }],
    "REPLAN",
    state.recoveryDepth,
    {
      priorPartialOutput: partialOutput,
      triggerReason: "Context exhaustion recovery exhausted all tiers — replanning needed.",
    },
  );

  state.failureReasons.push(
    `Task ${task.id}: recovery all tiers exhausted at depth ${state.recoveryDepth}. ` +
    `Completed: ${metadata.completedObjectives.join("; ") || "none"}. ` +
    `Remaining: ${metadata.remainingObjectives.join("; ")}. ` +
    `Files: ${metadata.filesMentioned.join(", ") || "none"}.`,
  );

  state.recoveryLog.push(
    `[RECOVERY] ${task.id}: escalated to REPLAN — metadata added to failureReasons.`,
  );

  return {
    taskId: task.id,
    description: task.description,
    agentName,
    output: partialOutput || `Task ${task.id}: recovery exhausted — escalated to replan.`,
    exitCode: 1,
    durationMs: 0,
    contextBudget: budget,
    contextExhaustionSignal: true,
  };
}

/**
 * Check whether a subagent result shows signs of context exhaustion.
 * Uses both the structured flags (truncated, contextExhaustionSignal) from
 * SubagentResult and heuristic text patterns in the output.
 */
function checkContextExhaustion(result: SubagentResult): boolean {
  if (result.truncated || result.contextExhaustionSignal) return true;

  const text = result.text ?? "";
  if (!text.trim()) return false;

  // Heuristic truncation patterns
  const truncationSignals: RegExp[] = [
    /\b(?:truncated|cut off|too long|exceeded)\b/i,
    /\.\.\.\s*$/m,
    /(?:content|output|response)\s+(?:has been|was)\s+truncated/i,
  ];

  for (const signal of truncationSignals) {
    if (signal.test(text)) return true;
  }

  // Unclosed JSON code fences at end
  const jsonFenceCount = (text.match(/```json/g) ?? []).length;
  const closeFenceCount = (text.match(/```/g) ?? []).length;
  if (jsonFenceCount > 0 && closeFenceCount < jsonFenceCount * 2) return true;

  return false;
}

/**
 * Try to read an executor continuation contract from disk.
 * The continuation guardrail instructs executors to write their contract to
 * `continuation-{taskId}.md` (or in cwd).
 */
function tryReadContinuationContract(
  taskId: string,
  cwd: string,
): ExecutorContinuationContract | null {
  const candidates = [
    `${cwd}/continuation-${taskId}.md`,
    `continuation-${taskId}.md`,
  ];

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf-8");
      // Extract JSON from markdown or raw text
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonText = jsonMatch?.[1]?.trim() ?? raw.trim();
      if (!jsonText.startsWith("{")) continue;
      const parsed = JSON.parse(jsonText);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).artifactType === "EXECUTOR_CONTINUATION_CONTRACT"
      ) {
        return parsed as ExecutorContinuationContract;
      }
    } catch {
      // File doesn't exist, isn't JSON, or isn't a valid contract — skip
    }
  }

  return null;
}

/**
 * Merge two ExecutorOutput objects into one, combining output text.
 */
function mergeExecutorOutputs(
  first: ExecutorOutput,
  second: ExecutorOutput,
): ExecutorOutput {
  return {
    taskId: first.taskId,
    description: first.description,
    agentName: first.agentName,
    output: [first.output, second.output].filter(Boolean).join("\n\n"),
    stderr: [first.stderr, second.stderr].filter(Boolean).join("\n") || undefined,
    exitCode: first.exitCode === 0 ? second.exitCode : first.exitCode,
    durationMs: first.durationMs + second.durationMs,
    contextBudget: first.contextBudget,
    truncated: second.truncated ?? first.truncated,
    contextExhaustionSignal: second.contextExhaustionSignal ?? first.contextExhaustionSignal,
  };
}
