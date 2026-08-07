import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Recovery module imports (shared with plan-execute-verify shape) ───
import {
  computeAdaptiveTaskSizeCap,
  estimateExecutorContextBudget,
  type ContextBudget,
} from "./executor-recovery/budget-estimator";

import {
  injectContinuationGuardrail,
  buildExecutorContinuationPrompt,
  type ExecutorContinuationContract,
} from "./executor-recovery/contract-types";

import {
  splitTaskOnFailure,
  buildSubtaskExecutorPrompt,
  chainExecutorOutputs,
} from "./executor-recovery/splitter";

import { buildRecoveryMetadata } from "./executor-recovery/metadata";
import { RunStateStore, collectSurvivorResult, type LoadedRunState, type TerminalNoRetryState } from "./run-state";
import {
  parseWriteSetInput,
  planEntriesOutsideContract,
  captureWriteSetSnapshot,
  evaluateWriteSetObservation,
  type WriteSetObservationEvaluation,
  type WriteSetSnapshot,
} from "./write-set";
// Alias registry moved to a leaf module to break the composable-pipeline ->
// index.ts circular import (WAVE3-SPEC ITEM C). Re-exported below for external
// callsite stability.
import { modelAliasFromText, normalizeRoutingText } from "./model-aliases";
export { modelAliasFromText } from "./model-aliases";

// ── Shape imports (orchestration paradigms) ───────────────────────────
import { composablePipelineShape } from "./shapes/composable-pipeline";
import { dualPlanSynthesisExecuteVerifyShape } from "./shapes/dual-plan-synthesis-execute-verify";
import { evidenceAuditShape } from "./shapes/evidence-audit";
import { frozenGateFixLoopShape } from "./shapes/frozen-gate-fix-loop";
import { independentReplicationShape } from "./shapes/independent-replication";
import { multiVerifyVoteShape } from "./shapes/multi-verify-vote";
import { paradigmCreatorShape } from "./shapes/paradigm-creator";
import { planExecuteVerifyShape } from "./shapes/plan-execute-verify";
// shape-builder generated imports:start
import { venueRescueSynthesisShape } from "./shapes/venue-rescue-synthesis";
import { preregisteredConcurrencySpikeShape } from "./shapes/preregistered-concurrency-spike";
import { m66ExplicitRoutingProofShape } from "./shapes/m66-explicit-routing-proof";
import { ssiSingleWriterExclusiveLaneShape } from "./shapes/ssi-single-writer-exclusive-lane";
// shape-builder generated imports:end
import { shapeBuilderShape } from "./shapes/shape-builder";
import { verifyOnlyShape } from "./shapes/verify-only";
import { winConsoleSpawnRootCauseShape } from "./shapes/win-console-spawn-root-cause";
import { winLifecycleProcessTraceShape } from "./shapes/win-lifecycle-process-trace";
import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NaturalLanguageOrchestrationControls,
} from "./types";

// ── Judgment-layer imports (effect-based verdicts; F1/F2/F5/F6) ───────
import {
  normalizeHardGatesMode,
  emptyToolCallSummary,
  recordToolCall,
  formatToolCallSummary,
  resolveGateDecision,
  buildZeroEffectFindings,
  detectFalsePassContradiction,
  parseProviderError,
  formatProviderError,
  extractReferencedTaskIds,
  type HardGatesMode,
  type ToolCallSummary,
  type GateFinding,
  type TaskEffectEvidence,
  type ProviderHealthError,
} from "./judgment";

import {
  buildWindowsEpermEvidence,
  buildWindowsEpermSpawnAttempts,
  formatSpawnAttempt,
  formatSpawnFailure,
  isWindowsSpawnEperm,
  preflightProviderHealth,
  writeWindowsEpermEvidence,
  SubagentDetachedError,
  SubagentTerminalAmbiguousError,
} from "./substrate";
import { getPiChildFirstJsonTimeoutMs, isPiJsonProtocolEvent, killOwnedProcessTree, resolvePiChildCommand } from "./child-launch.ts";
import {
  resolveDynamicWorkflow,
  resolvePinnedDynamicWorkflow,
  runDynamicWorkflow,
  type ResolvedDynamicWorkflow,
} from "./dynamic-workflow";

// ── Orchestration paradigm names (kept in sync with shapeRegistry) ───
const ORCHESTRATION_PARADIGM_NAMES: readonly string[] = [
  "plan-execute-verify",
  "multi-verify-vote",
  "composable-pipeline",
  "dual-plan-synthesis-execute-verify",
  "verify-only",
  "paradigm-creator",
  "shape-builder",
  "win-console-spawn-root-cause",
  "win-lifecycle-process-trace",
  "frozen-gate-fix-loop",
  "evidence-audit",
  "independent-replication",
  // shape-builder generated paradigm names:start
    "venue-rescue-synthesis",
  "preregistered-concurrency-spike",
  "m66-explicit-routing-proof",
  "ssi-single-writer-exclusive-lane",
// shape-builder generated paradigm names:end
];

// ── Shape registry (maps paradigm names to orchestration shapes) ─────
const shapeRegistry = new Map<string, OrchestrationShape>([
  ["plan-execute-verify", planExecuteVerifyShape],
  ["multi-verify-vote", multiVerifyVoteShape],
  ["composable-pipeline", composablePipelineShape],
  ["dual-plan-synthesis-execute-verify", dualPlanSynthesisExecuteVerifyShape],
  ["verify-only", verifyOnlyShape],
  ["paradigm-creator", paradigmCreatorShape],
  ["win-console-spawn-root-cause", winConsoleSpawnRootCauseShape],
  ["win-lifecycle-process-trace", winLifecycleProcessTraceShape],
  ["frozen-gate-fix-loop", frozenGateFixLoopShape],
  ["evidence-audit", evidenceAuditShape],
  ["independent-replication", independentReplicationShape],
  // shape-builder generated registry entries:start
    ["venue-rescue-synthesis", venueRescueSynthesisShape],
  ["preregistered-concurrency-spike", preregisteredConcurrencySpikeShape],
  ["m66-explicit-routing-proof", m66ExplicitRoutingProofShape],
  ["ssi-single-writer-exclusive-lane", ssiSingleWriterExclusiveLaneShape],
// shape-builder generated registry entries:end
  ["shape-builder", shapeBuilderShape],
]);

/** Native names are reserved: declarative artifacts can never shadow them. */
export const NATIVE_SHAPE_NAMES: ReadonlySet<string> = new Set(shapeRegistry.keys());

interface AgentProfile {
  name: string;
  description?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  agencyLevel?: string | number;
}

interface PlanTask {
  id: string;
  description: string;
  dependsOn: string[];
}

interface Plan {
  tasks: PlanTask[];
  notes: string;
  raw?: unknown;
  /** Planner-declared exact files/prefixes the tasks will create or modify (predict-then-write). */
  predictedWriteSet?: string[];
}

interface SubagentResult {
  agentName: string;
  task: string;
  text: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  events: number;
  /** Effect-evidence telemetry: tool executions observed in the child stream. */
  toolCalls?: ToolCallSummary;
  /** Resolved route that produced this result (residual 2b, mirrors substrate.ts). */
  provider?: string;
  model?: string;
}

interface ResolvedPiCommand {
  command: string;
  argsPrefix: string[];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  launchRuntime?: string;
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
  /** Effect evidence: tool-call telemetry for this task's subagent(s). */
  toolCalls?: ToolCallSummary;
  /** Effect evidence: worktree files changed during this task's window. */
  filesChanged?: number;
  changedFiles?: string[];
  /** Set when the output was reused from a prior attempt (F2 retry targeting). */
  reusedFromAttempt?: number;
}

interface ArtifactEvidence {
  summary: string;
  hasImplementationTask: boolean;
  diskStatus: string;
  diskFiles: string[];
  fileClaims: string[];
  hardGateFailures: string[];
  /** Whether git ground truth was available for this evidence collection. */
  gitAvailable: boolean;
}

/** Per-task pass/fail state persisted across attempts (F2 retry targeting). */
interface TaskLedgerEntry {
  taskId: string;
  description: string;
  verdict: "passed" | "failed";
  attempt: number;
  output: ExecutorOutput;
}

interface RoleModelOverride {
  model?: string;
  provider?: string;
}

interface RoutingRequirement {
  role: "planner" | "executor" | "verifier";
  agentName: string;
  provider?: string;
  model?: string;
  essential: boolean;
  source: "explicit_flag" | "natural_language" | "agent_profile" | "inherited";
  /** Required spawn evidence count for multi-instance core roles. */
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
  /** Provenance of the executor output contract (F6). */
  executorOutputContractSource?: "explicit" | "inferred";
  /**
   * Inferred advisory criteria (F6): synthesized hints that may produce
   * warnings but MUST NOT cause a FAIL on their own.
   */
  inferredAdvisoryCriteria: string[];
  /** Provenance tags for every derived criterion (F6). */
  criteriaProvenance: Array<{ text: string; kind: "success" | "failure"; source: "explicit" | "inferred" }>;
}

interface RoutingCheck {
  status: "pass" | "fail";
  reasons: string[];
}

interface InferredModelRouting {
  planner?: RoleModelOverride;
  executor?: RoleModelOverride;
  verifier?: RoleModelOverride;
}

interface NormalizedParams {
  task: string;
  plannerAgent: string;
  executorAgent: string;
  verifierAgent: string;
  plannerModel?: string;
  plannerProvider?: string;
  executorModel?: string;
  executorProvider?: string;
  /** Alias for executor wave concurrency requested by role-specific controls. */
  executorConcurrency?: number;
  verifierModel?: string;
  verifierProvider?: string;
  concurrency: number;
  /** Number of planner subagents to run in parallel before selecting a deterministic plan. */
  plannerCount: number;
  /** Number of verifier subagents to run in parallel before deterministic verdict aggregation. */
  verifierCount: number;
  maxRetries: number;
  maxRetriesExplicit: boolean;
  maxSubagents: number;
  maxSubagentsExplicit: boolean;
  cwd: string;
  allowLocalModel: boolean;
  orchestrationControls: NaturalLanguageOrchestrationControls;
  /**
   * NL model routing inferred from the task text, AFTER per-role suppression.
   * Computed exactly once in normalizeParams: any role carrying an explicit
   * route param has its NL-inferred route dropped here. Every downstream
   * consumer (buildRoutingRequirements, the shape context) reuses THIS object
   * instead of re-running inferModelRoutingFromTask, so a suppressed NL model
   * can never be recombined with an explicit provider-only override.
   */
  inferredRouting: InferredModelRouting;
  paradigm?: string;
  /** Hard-gate mode (F1). Default "advisory". */
  hardGates: HardGatesMode;
  /** Contract-granted write scope (predict-then-write). Deterministically enforced when set. */
  predictedWriteSet?: string[];
  /** Run intake + planning only; spawn no executors/verifiers; return the discovery manifest. */
  discoveryOnly: boolean;
  /** Run provider health pings before spawning subagents (F5). Default true. */
  preflight: boolean;
  plannerFallbackModel?: string;
  plannerFallbackProvider?: string;
  executorFallbackModel?: string;
  executorFallbackProvider?: string;
  verifierFallbackModel?: string;
  verifierFallbackProvider?: string;
}

interface OrchestrationState {
  attempt: number;
  spawnedCount: number;
  plan: Plan | null;
  planText: string;
  /** All planner outputs for the latest attempt when plannerCount > 1. */
  plannerOutputs?: SubagentResult[];
  executorOutputs: ExecutorOutput[];
  verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string } | null;
  /** Individual verifier outputs for the latest attempt when verifierCount > 1. */
  verifierResults?: Array<{ agentName: string; status: "pass" | "fail"; reasons: string[]; raw: string }>;
  failureReasons: string[];
  finalResult: string;
  progressLog: string[];
  intake: Intake | null;
  routingCheck: RoutingCheck | null;
  /** Unique run identifier included in reports and commit evidence (F7). */
  runId: string;
  /** Demoted text-shape findings carried in the report (F1). */
  gateWarnings: string[];
  /** Per-task pass/fail state across attempts (F2). */
  taskLedger: Map<string, TaskLedgerEntry>;
  /** Pre/post-execution commit hashes per attempt (F7). */
  commitEvidence: Array<{ attempt: number; preHash: string | null; postHash: string | null }>;
  /** Set when the run aborted and a partial report was emitted (F5). */
  abortReason?: string;
  attempts: Array<{
    attempt: number;
    plan: Plan;
    plannerText: string;
    plannerOutputs?: SubagentResult[];
    executorOutputs: ExecutorOutput[];
    verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string };
    verifierResults?: Array<{ agentName: string; status: "pass" | "fail"; reasons: string[]; raw: string }>;
  }>;
  recoveryLog: string[];
  recoveryDepth: number;
  maxRecoveryDepth: number;
}

interface DashboardState {
  task: string;
  maxSubagents: number;
  maxRetries: number;
  concurrency: number;
  paradigm: string;
  plannerModel: string;
  executorModel: string;
  verifierModel: string;
  taskAssignments: Array<{ id: string; description: string }>;
  activeSubagents: number;
  spawnedCount: number;
  phase: string;
  contextUsage: string;
  startTime: number;
}

const DEFAULT_AGENTS: AgentProfile[] = [
  {
    name: "planner",
    description: "Breaks a task into deterministic executor work items.",
    systemPrompt:
      "You are a planning subagent. Return concise, actionable plans. Prefer strict JSON when asked. Do not execute implementation work.",
    tools: [],
  },
  {
    name: "coder",
    description: "Executes assigned coding tasks.",
    systemPrompt:
      "You are an executor subagent. Complete only the assigned task, report exactly what changed, and note any uncertainty. Do not spawn orchestrations.",
    tools: ["read", "bash", "edit", "write"],
  },
  {
    name: "reviewer",
    description: "Verifies executor outputs against the original task.",
    systemPrompt:
      "You are a verifier subagent. Judge whether the executor outputs satisfy the original task. Prefer strict JSON when asked. Do not fix issues unless explicitly assigned.",
    tools: [],
  },
];

const MAX_FINAL_MARKDOWN_CHARS = 20_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_EXECUTOR_MARKDOWN_CHARS = 6_000;
const DEFAULT_MAX_SUBAGENTS = 12;
const MAX_SUBAGENTS_LIMIT = 100;

const orchestrateParamsSchema = Type.Object({
  task: Type.Optional(Type.String({ description: "Task for deterministic multi-agent orchestration. Optional when `resume` is provided (the stored task is reused)." })),
  resume: Type.Optional(Type.String({ description: "Resume a previously aborted run by its run id (e.g. orc-mr3hsj4y-6j3b). Restores checkpointed phases, re-attaches detached survivor subagents, and continues from the first incomplete phase (ABORT-RESUME-DESIGN.md). Supported paradigms: plan-execute-verify, preregistered-concurrency-spike, dual-plan-synthesis-execute-verify, frozen-gate-fix-loop, evidence-audit, independent-replication." })),
  plannerAgent: Type.Optional(Type.String({ default: "planner" })),
  executorAgent: Type.Optional(Type.String({ default: "coder" })),
  verifierAgent: Type.Optional(Type.String({ default: "reviewer" })),
  concurrency: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 16, description: "Executor concurrency per dependency wave (legacy alias for executorConcurrency)." })),
  executorConcurrency: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 16, description: "Executor concurrency per dependency wave; supports up to 16 simultaneous independent executors." })),
  executorCount: Type.Optional(Type.Number({ minimum: 1, maximum: 16, description: "Natural alias for executorConcurrency / available executor slots." })),
  plannerCount: Type.Optional(Type.Number({ default: 1, minimum: 1, maximum: 16, description: "Number of planner subagents to run simultaneously before deterministic plan selection." })),
  verifierCount: Type.Optional(Type.Number({ default: 1, minimum: 1, maximum: 16, description: "Number of verifier subagents to run simultaneously before deterministic strict aggregation." })),
  maxRetries: Type.Optional(Type.Number({ default: 2, minimum: 0, maximum: 5 })),
  maxSubagents: Type.Optional(Type.Number({ default: DEFAULT_MAX_SUBAGENTS, minimum: 3, maximum: MAX_SUBAGENTS_LIMIT })),
  cwd: Type.Optional(Type.String({ description: "Working directory for spawned Pi subprocesses." })),
  allowLocalModel: Type.Optional(Type.Boolean({ default: false })),
  plannerModel: Type.Optional(Type.String({ description: "Override model for the planner agent (e.g. gpt-5.5 for reasoning-heavy tasks)." })),
  plannerProvider: Type.Optional(Type.String({ description: "Override provider for the planner agent (e.g. openai-codex)." })),
  executorModel: Type.Optional(Type.String({ description: "Override model for executor agent(s) (e.g. deepseek-v4-pro for fast code generation)." })),
  executorProvider: Type.Optional(Type.String({ description: "Override provider for executor agent(s) (e.g. deepseek)." })),
  verifierModel: Type.Optional(Type.String({ description: "Override model for the verifier agent (e.g. gpt-5.5 for thorough review)." })),
  verifierProvider: Type.Optional(Type.String({ description: "Override provider for the verifier agent (e.g. openai-codex)." })),
  paradigm: Type.Optional(Type.String({ description: `Explicitly select an orchestration paradigm/shape. Built-ins: ${ORCHESTRATION_PARADIGM_NAMES.join(", ")}. A safe kebab-case declarative workflow name discovered from a trusted user/project workflow root is also accepted immediately, without reload. When omitted, a built-in paradigm is inferred from task keywords.` })),
  hardGates: Type.Optional(Type.String({ description: 'Hard-gate mode: "strict" | "advisory" | "off". Default "advisory": text-shape heuristics are demoted to warnings, the verifier verdict gates, and only effect-based contradictions (zero observed mutations for implementation work) can force FAIL.' })),
  preflight: Type.Optional(Type.Boolean({ description: "Run a 1-token provider health ping for each routed provider/model before spawning any subagent (default true). Failures produce a structured machine-readable error and a partial report." })),
  predictedWriteSet: Type.Optional(Type.String({ description: 'Contract-granted predicted write set: comma- or newline-separated repo-relative paths ("docs/a.md"), directory prefixes ("docs/"), or simple globs ("tools/*.mjs"). When set, per-task worktree deltas are checked deterministically after execution — any file mutated outside the set forces FAIL with WRITE_SET_VIOLATION naming the file, before verifier spawn. A plan whose predicted_write_set exceeds this scope fails before any executor spawns.' })),
  discoveryOnly: Type.Optional(Type.Boolean({ description: "Discovery-only mode (predict-then-write): run intake and planning, return the plan plus predicted write set as a manifest, and spawn no executors or verifiers. Use it to review/authorize scope cheaply before any mutation." })),
  plannerFallbackModel: Type.Optional(Type.String({ description: "Fallback model(s) for the planner when its primary route fails pre-flight. Comma-separated for a chain (e.g. 'claude-opus-4-20250514,deepseek-v4-pro,deepseek-v4-flash')." })),
  plannerFallbackProvider: Type.Optional(Type.String({ description: "Fallback provider(s) for the planner when its primary route fails pre-flight. Comma-separated, paired positionally with plannerFallbackModel." })),
  executorFallbackModel: Type.Optional(Type.String({ description: "Fallback model(s) for executors when their primary route fails pre-flight. Comma-separated for a chain." })),
  executorFallbackProvider: Type.Optional(Type.String({ description: "Fallback provider(s) for executors when their primary route fails pre-flight. Comma-separated, paired positionally with executorFallbackModel." })),
  verifierFallbackModel: Type.Optional(Type.String({ description: "Fallback model(s) for the verifier when its primary route fails pre-flight. Comma-separated for a chain." })),
  verifierFallbackProvider: Type.Optional(Type.String({ description: "Fallback provider(s) for the verifier when its primary route fails pre-flight. Comma-separated, paired positionally with verifierFallbackModel." })),
});

export default function (pi: ExtensionAPI) {
  async function runFromParams(
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: { cwd?: string; model?: { provider?: string; id?: string } },
  ) {
    // Resume dispatch (ABORT-RESUME-DESIGN.md): reload the stored run state
    // and re-dispatch the SAME paradigm with the stored task/params. Caller
    // params (other than resume) act as overrides.
    const resumeId = typeof params.resume === "string" && params.resume.trim() ? params.resume.trim() : undefined;
    let resumeState: LoadedRunState | undefined;
    if (resumeId) {
      resumeState = RunStateStore.load(resumeId);
      const { resume: _resume, ...overrides } = params;
      params = {
        ...resumeState.state.params,
        ...overrides,
        task: resumeState.state.task,
        paradigm: resumeState.state.paradigm,
      };
    } else if (typeof params.task !== "string" || !params.task.trim()) {
      throw new Error("orchestrate requires `task` (or `resume` with a stored run id).");
    }
    const normalized = normalizeParams(params, ctx?.cwd ?? process.cwd());
    const inheritedModel = ctx?.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined;
    return runOrchestration(normalized, signal, onUpdate, inheritedModel, resumeState);
  }

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Run deterministic planner/executor/verifier orchestration using isolated Pi JSON-mode subprocesses.",
    promptSnippet: "Deterministically orchestrate a task through planner, executor, and verifier Pi subprocesses.",
    promptGuidelines: [
      "Use orchestrate for bounded multi-agent task decomposition when the user asks for deterministic orchestration or planner/executor/verifier workflow.",
      "When the user asks for different models per role (e.g. 'plan with GPT 5.5, execute with DeepSeek V4'), pass plannerModel/plannerProvider, executorModel/executorProvider, or verifierModel/verifierProvider. If the user does not specify a model for a role, omit those parameters so the subagent inherits its configured default.",
    ],
    parameters: orchestrateParamsSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runFromParams(params as Record<string, unknown>, signal, onUpdate, ctx);
      return {
        content: [{ type: "text", text: result.markdown }],
        details: result.details,
      };
    },
  });

  pi.registerCommand("orchestrate", {
    description: "Run deterministic planner/executor/verifier orchestration. Flags: --max-subagents N, --max-retries N, --concurrency/--executor-concurrency N, --planner-count N, --verifier-count N, --planner-model, --executor-model, --verifier-model, --planner-fallback-model (comma-sep chain), --write-set paths (deterministic write-scope enforcement), --discovery-only (plan without executing), etc.",
    handler: async (args, ctx) => {
      let commandParams: Record<string, unknown>;
      try {
        commandParams = parseOrchestrateCommandArgs(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid /orchestrate arguments: ${message}`, "error");
        return;
      }

      let task = String(commandParams.task ?? "").trim();
      if (!task) {
        const entered = await ctx.ui.input("Task to orchestrate", "Describe the task...");
        task = entered?.trim() ?? "";
        commandParams.task = task;
      }
      if (!task) {
        ctx.ui.notify("/orchestrate cancelled: no task provided.", "warning");
        return;
      }

      // ── Initialize dashboard state ───────────────────────────────
      const dashboardState = createOrchestrateDashboard(task);
      try {
        const normalized = normalizeParams(commandParams, ctx.cwd ?? process.cwd());
        dashboardState.maxSubagents = normalized.maxSubagents;
        dashboardState.maxRetries = normalized.maxRetries;
        dashboardState.concurrency = normalized.concurrency;
        dashboardState.paradigm = inferOrchestrationParadigm(normalized);
        dashboardState.plannerModel = formatRoutedModel(normalized.plannerProvider, normalized.plannerModel);
        dashboardState.executorModel = formatRoutedModel(normalized.executorProvider, normalized.executorModel);
        dashboardState.verifierModel = formatRoutedModel(normalized.verifierProvider, normalized.verifierModel);
        ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState));
        ctx.ui.setStatus?.("orchestrate", dashboardStatusLine(dashboardState));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/orchestrate parameter error: ${message}`, "error");
        return;
      }

      // ── Run orchestration with live dashboard updates ────────────
      try {
        const result = await runFromParams(commandParams, ctx.signal, (update) => {
          const text = extractProgressText(update);
          if (text) {
            updateDashboardFromProgress(dashboardState, text);
            ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState));
            ctx.ui.setStatus?.("orchestrate", dashboardStatusLine(dashboardState));
            pi.sendMessage({
              customType: "orchestrate-progress",
              content: text,
              display: true,
              details: { phase: "progress", message: text },
            });
          }
        }, ctx);

        // Show final dashboard on success
        dashboardState.phase = "complete";
        ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState, `✅ Orchestration ${result.details.status}`));
        ctx.ui.setStatus?.("orchestrate", `✅ Orchestration complete: ${result.details.status}`);
        ctx.ui.notify(`Orchestration complete: ${result.details.status}`, result.details.status === "pass" ? "info" : "warning");
        pi.sendMessage({
          customType: "orchestrate-result",
          content: result.markdown,
          display: true,
          details: result.details,
        });
        if (ctx.hasUI) ctx.ui.setEditorText(result.markdown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dashboardState.phase = "failed";
        ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState, `❌ ${message}`));
        ctx.ui.setStatus?.("orchestrate", `❌ Orchestration failed: ${message}`);
        ctx.ui.notify(`Orchestration failed: ${message}`, "error");
        throw error;
      } finally {
        ctx.ui.setWidget?.("orchestrate", undefined);
        ctx.ui.setStatus?.("orchestrate", undefined);
      }
    },
  });
}

function extractProgressText(update: unknown): string {
  if (typeof update === "string") return update;
  if (!update || typeof update !== "object") return "";
  const content = (update as { content?: unknown }).content;
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

function parseOrchestrateCommandArgs(args: string): Record<string, unknown> {
  const tokens = splitCommandLine(args.trim());
  const params: Record<string, unknown> = {};
  const taskParts: string[] = [];

  const takeValue = (index: number, flag: string, inlineValue?: string): { value: string; nextIndex: number } => {
    if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return { value, nextIndex: index + 1 };
  };
  const parseNumberFlag = (flag: string, value: string): number => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${flag} requires a numeric value, got ${JSON.stringify(value)}.`);
    return number;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      taskParts.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      taskParts.push(token);
      continue;
    }

    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    const normalized = flag.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());

    if (normalized === "allowLocalModel" || normalized === "allowLocal") {
      params.allowLocalModel = true;
      continue;
    }
    if (normalized === "noAllowLocalModel" || normalized === "noAllowLocal") {
      params.allowLocalModel = false;
      continue;
    }
    if (normalized === "preflight") {
      params.preflight = true;
      continue;
    }
    if (normalized === "noPreflight") {
      params.preflight = false;
      continue;
    }
    if (normalized === "discoveryOnly" || normalized === "discovery") {
      params.discoveryOnly = true;
      continue;
    }

    const { value, nextIndex } = takeValue(i, `--${flag}`, inlineValue);
    i = nextIndex;
    switch (normalized) {
      case "maxSubagents":
        params.maxSubagents = parseNumberFlag(`--${flag}`, value);
        break;
      case "maxRetries":
        params.maxRetries = parseNumberFlag(`--${flag}`, value);
        break;
      case "concurrency":
        params.concurrency = parseNumberFlag(`--${flag}`, value);
        break;
      case "executorConcurrency":
        params.executorConcurrency = parseNumberFlag(`--${flag}`, value);
        break;
      case "executorCount":
        params.executorCount = parseNumberFlag(`--${flag}`, value);
        break;
      case "plannerCount":
      case "plannerConcurrency":
        params.plannerCount = parseNumberFlag(`--${flag}`, value);
        break;
      case "verifierCount":
      case "verifierConcurrency":
        params.verifierCount = parseNumberFlag(`--${flag}`, value);
        break;
      case "plannerAgent":
        params.plannerAgent = value;
        break;
      case "executorAgent":
        params.executorAgent = value;
        break;
      case "verifierAgent":
        params.verifierAgent = value;
        break;
      case "cwd":
        params.cwd = value;
        break;
      case "plannerModel":
        params.plannerModel = value;
        break;
      case "plannerProvider":
        params.plannerProvider = value;
        break;
      case "executorModel":
        params.executorModel = value;
        break;
      case "executorProvider":
        params.executorProvider = value;
        break;
      case "verifierModel":
        params.verifierModel = value;
        break;
      case "verifierProvider":
        params.verifierProvider = value;
        break;
      case "paradigm":
        params.paradigm = value;
        break;
      case "hardGates":
        params.hardGates = value;
        break;
      case "writeSet":
      case "predictedWriteSet":
        params.predictedWriteSet = value;
        break;
      case "plannerFallbackModel":
        params.plannerFallbackModel = value;
        break;
      case "plannerFallbackProvider":
        params.plannerFallbackProvider = value;
        break;
      case "executorFallbackModel":
        params.executorFallbackModel = value;
        break;
      case "executorFallbackProvider":
        params.executorFallbackProvider = value;
        break;
      case "verifierFallbackModel":
        params.verifierFallbackModel = value;
        break;
      case "verifierFallbackProvider":
        params.verifierFallbackProvider = value;
        break;
      default:
        throw new Error(`Unknown flag --${flag}. Supported flags: --max-subagents, --max-retries, --concurrency, --executor-concurrency, --executor-count, --planner-count, --planner-concurrency, --verifier-count, --verifier-concurrency, --planner-agent, --executor-agent, --verifier-agent, --cwd, --allow-local-model, --paradigm, --hard-gates, --write-set, --discovery-only, --preflight/--no-preflight, --planner-model, --planner-provider, --executor-model, --executor-provider, --verifier-model, --verifier-provider, --planner-fallback-model, --planner-fallback-provider, --executor-fallback-model, --executor-fallback-provider, --verifier-fallback-model, --verifier-fallback-provider. Fallback params accept comma-separated chains (e.g. --planner-fallback-model opus,deepseek-v4-pro,deepseek-v4-flash). --write-set takes comma-separated repo-relative paths/prefixes and enables deterministic write-set enforcement; --discovery-only plans without executing.`);
    }
  }

  params.task = taskParts.join(" ").trim();
  return params;
}

function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error(`Unclosed ${quote} quote.`);
  if (current) tokens.push(current);
  return tokens;
}

function normalizeParams(params: Record<string, unknown>, defaultCwd: string): NormalizedParams {
  const task = String(params.task ?? "").trim();
  if (!task) throw new Error("orchestrate requires a non-empty task.");
  const inferredRoutingRaw = inferModelRoutingFromTask(task);
  const orchestrationControls = inferOrchestrationControlsFromTask(task, params, inferredRoutingRaw);

  // BUG FIX (2026-07-02, natural-language-route-parser-hijacks-roles-from-task-prose.md):
  // When ANY explicit route param is present for a role, natural-language route
  // extraction is fully SUPPRESSED for that role — explicit params always win,
  // and prose can never fill the un-set side of an explicitly-routed role.
  //
  // The suppression is applied ONCE here and stored on NormalizedParams
  // (`inferredRouting`) so buildRoutingRequirements and the shape context reuse
  // the SAME filtered object. Previously buildRoutingRequirements re-ran
  // inferModelRoutingFromTask and could recombine a suppressed NL model with an
  // explicit provider-only override (e.g. executorProvider set + prose model),
  // producing a false routing requirement / 404 preflight.
  const plannerExplicit = optionalString(params.plannerModel) !== undefined || optionalString(params.plannerProvider) !== undefined;
  const executorExplicit = optionalString(params.executorModel) !== undefined || optionalString(params.executorProvider) !== undefined;
  const verifierExplicit = optionalString(params.verifierModel) !== undefined || optionalString(params.verifierProvider) !== undefined;
  const inferredRouting: InferredModelRouting = {
    ...inferredRoutingRaw,
    planner: plannerExplicit ? undefined : inferredRoutingRaw.planner,
    executor: executorExplicit ? undefined : inferredRoutingRaw.executor,
    verifier: verifierExplicit ? undefined : inferredRoutingRaw.verifier,
  };
  const nlPlanner = inferredRouting.planner;
  const nlExecutor = inferredRouting.executor;
  const nlVerifier = inferredRouting.verifier;

  return {
    task,
    plannerAgent: stringParam(params.plannerAgent, "planner"),
    executorAgent: stringParam(params.executorAgent, "coder"),
    verifierAgent: stringParam(params.verifierAgent, "reviewer"),
    concurrency: clampInt(params.executorConcurrency ?? params.executorCount ?? params.concurrency ?? orchestrationControls.executorConcurrency ?? orchestrationControls.executorCount ?? orchestrationControls.concurrency, 2, 1, 16),
    plannerCount: clampInt(params.plannerCount ?? orchestrationControls.plannerCount, 1, 1, 16),
    verifierCount: clampInt(params.verifierCount ?? orchestrationControls.verifierCount, 1, 1, 16),
    maxRetries: clampInt(params.maxRetries ?? orchestrationControls.maxRetries ?? (orchestrationControls.maxAttempts !== undefined ? orchestrationControls.maxAttempts - 1 : undefined), 2, 0, 5),
    maxRetriesExplicit: params.maxRetries !== undefined || orchestrationControls.maxAttempts !== undefined || orchestrationControls.maxRetries !== undefined,
    maxSubagents: clampInt(params.maxSubagents ?? orchestrationControls.maxSubagents, DEFAULT_MAX_SUBAGENTS, 3, MAX_SUBAGENTS_LIMIT),
    maxSubagentsExplicit: params.maxSubagents !== undefined || orchestrationControls.maxSubagents !== undefined,
    cwd: stringParam(params.cwd, defaultCwd),
    allowLocalModel: typeof params.allowLocalModel === "boolean" ? params.allowLocalModel : false,
    plannerModel: optionalString(params.plannerModel) ?? nlPlanner?.model,
    plannerProvider: optionalString(params.plannerProvider) ?? nlPlanner?.provider,
    executorModel: optionalString(params.executorModel) ?? nlExecutor?.model,
    executorProvider: optionalString(params.executorProvider) ?? nlExecutor?.provider,
    verifierModel: optionalString(params.verifierModel) ?? nlVerifier?.model,
    verifierProvider: optionalString(params.verifierProvider) ?? nlVerifier?.provider,
    orchestrationControls,
    inferredRouting,
    paradigm: typeof params.paradigm === "string" ? params.paradigm : undefined,
    hardGates: normalizeHardGatesMode(params.hardGates),
    predictedWriteSet: parseWriteSetInput(params.predictedWriteSet),
    discoveryOnly: typeof params.discoveryOnly === "boolean" ? params.discoveryOnly : false,
    preflight: typeof params.preflight === "boolean" ? params.preflight : true,
    plannerFallbackModel: optionalString(params.plannerFallbackModel),
    plannerFallbackProvider: optionalString(params.plannerFallbackProvider),
    executorFallbackModel: optionalString(params.executorFallbackModel),
    executorFallbackProvider: optionalString(params.executorFallbackProvider),
    verifierFallbackModel: optionalString(params.verifierFallbackModel),
    verifierFallbackProvider: optionalString(params.verifierFallbackProvider),
  };
}

async function runOrchestration(
  params: NormalizedParams,
  signal?: AbortSignal,
  onUpdate?: (update: unknown) => void,
  inheritedModel?: { provider?: string; model?: string },
  resumeState?: LoadedRunState,
) {
  const agents = await loadAgents();
  // Named orchestration roles resolve from their agent profile and the current
  // Pi default route. They must not silently inherit the conversational model.
  resolveConfiguredRoleDefaults(params, agents);
  inheritedModel = undefined;

  // ── Run/judgment state is created up-front so even early failures
  //    (pre-flight, planning) ALWAYS yield a partial report (F5). ────────
  const state: OrchestrationState = {
    attempt: 0,
    spawnedCount: 0,
    plan: null,
    planText: "",
    executorOutputs: [],
    verifierResult: null,
    failureReasons: [],
    finalResult: "",
    progressLog: [],
    intake: null,
    routingCheck: null,
    runId: resumeState?.state.runId ?? `orc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    gateWarnings: [],
    taskLedger: new Map(),
    commitEvidence: [],
    attempts: [],
    recoveryLog: [],
    recoveryDepth: 0,
    maxRecoveryDepth: 3,
  };

  const emit = (text: string) => {
    const line = `[${new Date().toISOString()}] ${text}`;
    state.progressLog.push(line);
    onUpdate?.({ content: [{ type: "text", text }] });
  };

  const paradigm = inferOrchestrationParadigm(params);
  let resolvedDynamicWorkflow: ResolvedDynamicWorkflow | undefined;
  if (!shapeRegistry.has(paradigm)) {
    // Invocation-time resolution is deliberately uncached: a workflow created
    // earlier in this same Pi process is immediately visible without reload.
    // Resume never re-reads mutable source; it validates and uses the exact
    // snapshot pinned in the original run state.
    resolvedDynamicWorkflow = resumeState
      ? resolvePinnedDynamicWorkflow(
          resumeState.state.dynamicWorkflow,
          paradigm,
          NATIVE_SHAPE_NAMES,
        )
      : resolveDynamicWorkflow(paradigm, {
          cwd: params.cwd,
          nativeNames: NATIVE_SHAPE_NAMES,
        });
  }
  emit(`Run ${state.runId}: paradigm=${paradigm}, hardGates=${params.hardGates}, preflight=${params.preflight}.`);
  const plannerSelected = resolveNamedRoleRoute(agents, params.plannerAgent, params.plannerModel, params.plannerProvider);
  const executorSelected = resolveNamedRoleRoute(agents, params.executorAgent, params.executorModel, params.executorProvider);
  const verifierSelected = resolveNamedRoleRoute(agents, params.verifierAgent, params.verifierModel, params.verifierProvider);
  emit(
    `Selected routes before preflight: planner=${formatRoutedModel(plannerSelected.provider, plannerSelected.model)}, ` +
      `executor=${formatRoutedModel(executorSelected.provider, executorSelected.model)}, ` +
      `verifier=${formatRoutedModel(verifierSelected.provider, verifierSelected.model)}.`,
  );

  if (paradigm === "plan-execute-verify") {
    const terminalResume = firstPevTerminalNoRetry(resumeState);
    if (terminalResume) {
      state.intake = buildIntake(params, agents, inheritedModel);
      state.attempt = attemptFromTerminalPhase(terminalResume) ?? 0;
      emit(
        `RESUME of run ${state.runId}: terminal no-retry state ${terminalResume.code} already persisted; ` +
          `returning without planner/executor/verifier respawn.`,
      );
      return finalizePevTerminalResult(params, state, terminalResume);
    }
  }

  try {
  // ── Pre-flight provider health checks (F5) ──────────────────────────
  const deterministicDynamicCanary = Boolean(resolvedDynamicWorkflow) && params.task.trim() === "SHAPE_CANARY";
  // composable-pipeline owns role-safe route resolution because its composed
  // planner seats do not map one-to-one to named agent profiles. Let the shape
  // reject forbidden routes and preflight every actually-used role before any
  // work spawn; generic named-profile preflight would ping the wrong route.
  const shapeOwnsPreflight = paradigm === "composable-pipeline";
  if (params.preflight && !deterministicDynamicCanary && !shapeOwnsPreflight) {
    await runProviderPreflight(params, agents, inheritedModel, signal, emit);
  } else if (shapeOwnsPreflight && params.preflight) {
    emit("Preflight delegated to composable-pipeline role-safe route resolution.");
  } else if (deterministicDynamicCanary && params.preflight) {
    emit("Dynamic workflow canary: skipping provider preflight to preserve the deterministic zero-process contract.");
  }

  // ── Shape-based orchestration dispatch ────────────────────────────────
  if (paradigm !== "plan-execute-verify") {
    const shape = shapeRegistry.get(paradigm);
    if (!shape && !resolvedDynamicWorkflow) {
      throw new Error(
        `Unknown orchestration paradigm "${paradigm}". Available paradigms: ${[...shapeRegistry.keys()].join(", ")}. ` +
          `No ${paradigm}.workflow.json artifact was found in the trusted project or user workflow roots.`,
      );
    }

    // Reuse the suppressed routing from normalizeParams so shapes never see an
    // NL route for a role that carried an explicit override param.
    const inferredModelRouting = params.inferredRouting ?? inferModelRoutingFromTask(params.task);
    const context: OrchestrationShapeContext = {
      params,
      signal,
      onUpdate,
      inheritedModel,
      agents,
      inferredModelRouting,
      runId: state.runId,
      resumeState,
    };

    const emitShape = (text: string) => {
      onUpdate?.({ content: [{ type: "text", text }] });
    };
    if (resumeState) {
      emitShape(`[orchestrate] RESUME of run ${resumeState.state.runId}: ` +
        `${resumeState.state.phases.filter((p) => p.status === "done").length} phase(s) checkpointed, ` +
        `${resumeState.state.phases.filter((p) => p.status === "detached").length} detached survivor(s).`);
    }
    emitShape(`[orchestrate] Dispatching to "${paradigm}" shape…`);

    const result: OrchestrationShapeResult = resolvedDynamicWorkflow
      ? await runDynamicWorkflow(resolvedDynamicWorkflow, context)
      : await shape!.run(context);
    emit(`[orchestrate] "${paradigm}" shape completed.`);

    return {
      markdown: result.markdown,
      details: result.details,
    };
  }

  // ── Default inline plan-execute-verify orchestration ─────────────────
  state.intake = buildIntake(params, agents, inheritedModel);
  emit(`Intake complete: ${state.intake.taskSummary}`);
  if (state.intake.routingRequirements.length) {
    emit(`Intake marked model routing essential: ${state.intake.routingRequirements.map((req) => `${req.role}=${formatRoutedModel(req.provider, req.model)}`).join(", ")}`);
  }
  const maxAttempts = params.maxRetries + 1;

  // ── Checkpoint/resume wiring (ABORT-RESUME-DESIGN.md) ───────────────────
  // Phases are NAME-keyed so the executor phase can be split PER TASK
  // (attempt-N-executor-<taskId>), each spawned in abort-survivor mode and each
  // checkpointed with its resolved provider/model. Planner and verifier remain
  // single per-attempt phases (attempt-N-planner / attempt-N-verifier). Phase
  // indices are allocated deterministically in first-touch order; on resume they
  // are recovered by NAME from the persisted state.json so they line up with the
  // checkpoints/survivors already on disk (even the pre-any-phase abort edge,
  // production run orc-mr3x90b5-00iz). On resume, completed phases are RESTORED
  // (not re-spawned) and a detached survivor is re-attached via bounded polling.
  const pevStore = resumeState
    ? RunStateStore.open(resumeState.state.runId)
    : RunStateStore.create(state.runId, "plan-execute-verify", params.task, JSON.parse(JSON.stringify(params)) as Record<string, unknown>, []);
  const pevPhaseIndex = new Map<string, number>();
  let pevNextIndex = 0;
  for (const phase of resumeState?.state.phases ?? []) {
    pevPhaseIndex.set(phase.name, phase.index);
    pevNextIndex = Math.max(pevNextIndex, phase.index + 1);
  }
  const pevIndexOf = (name: string): number => {
    let idx = pevPhaseIndex.get(name);
    if (idx === undefined) { idx = pevNextIndex++; pevPhaseIndex.set(name, idx); }
    return idx;
  };
  const pevRestore = <T,>(name: string): T | undefined => {
    const idx = pevPhaseIndex.get(name);
    return idx === undefined ? undefined : (resumeState?.checkpoints.get(idx) as unknown as T | undefined);
  };
  const pevCheckpoint = (name: string, result: unknown, route?: { provider?: string; model?: string }): void => {
    // Every checkpointed result carries its resolved provider/model so a resumed
    // run can see exactly which route produced each phase. This applies to BOTH
    // single-spawn/per-task objects AND verifier ARRAY checkpoints (residual 2a);
    // the route is only ever ADDED, never allowed to overwrite an already-resolved
    // provider/model with undefined (empty {} routes must not strip metadata).
    const stamp = (item: unknown): unknown =>
      item && typeof item === "object" && !Array.isArray(item)
        ? {
            ...(item as Record<string, unknown>),
            provider: route?.provider ?? (item as { provider?: unknown }).provider,
            model: route?.model ?? (item as { model?: unknown }).model,
          }
        : item;
    const payload = Array.isArray(result)
      ? result.map(stamp)
      : result
        ? stamp(result)
        : result;
    pevStore.checkpointPhase(pevIndexOf(name), name, payload as unknown as SubagentResult);
  };
  const pevSurvival = (name: string) => {
    const idx = pevIndexOf(name);
    return {
      resultFile: pevStore.survivorResultPath(idx, name),
      manifestFile: pevStore.survivorManifestPath(idx, name),
      phaseName: name,
      phaseIndex: idx,
    };
  };
  const pevCollectSurvivor = async <T,>(name: string): Promise<T | undefined> => {
    const idx = pevPhaseIndex.get(name);
    if (idx === undefined) return undefined;
    const survivor = resumeState?.survivors.get(idx);
    if (!survivor) return undefined;
    const collected = await collectSurvivorResult<T>(survivor, emit, signal, "plan-execute-verify");
    if (collected) pevCheckpoint(name, collected);
    return collected;
  };
  // Executor-task survivor: the abort-survivor writer persists a raw SubagentResult,
  // so collect it WITHOUT auto-checkpointing (the generic collector stores the raw
  // object), convert to an ExecutorOutput, then checkpoint that with the route.
  const pevCollectExecutorSurvivor = async (name: string, task: PlanTask): Promise<ExecutorOutput | undefined> => {
    const idx = pevPhaseIndex.get(name);
    if (idx === undefined) return undefined;
    const survivor = resumeState?.survivors.get(idx);
    if (!survivor) return undefined;
    const collected = await collectSurvivorResult<SubagentResult>(survivor, emit, signal, "plan-execute-verify");
    if (!collected) return undefined;
    const out = executorOutputFromSubagent(task, collected);
    pevCheckpoint(name, out, toModelOverride(params.executorModel, params.executorProvider));
    return out;
  };
  const pevDetachGuard = (name: string, error: unknown): never => {
    if (error instanceof SubagentDetachedError) {
      pevStore.markDetached(pevIndexOf(name), name, error.manifest);
      throw new Error(
        `Orchestration aborted mid-phase but the ${name} subagent (pid=${error.manifest.pid}) ` +
          `continues in the background. Resume this run by re-invoking the orchestrate tool with { resume: "${pevStore.runId}" }. ` +
          `Completed phases are checkpointed and will not be re-executed.`,
      );
    }
    throw error as Error;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    state.attempt = attempt;
    emit(`Orchestration attempt ${attempt}/${maxAttempts}: planning...`);
    const preAttemptHead = gitHeadHash(params.cwd);
    const plannerName = `attempt-${attempt}-planner`;
    const verifierName = `attempt-${attempt}-verifier`;
    const executorTaskName = (taskId: string) => `attempt-${attempt}-executor-${taskId}`;

    const completedTasks = [...state.taskLedger.values()].filter((entry) => entry.verdict === "passed");
    const plannerPrompt = buildPlanningPrompt(state.intake, attempt, state.failureReasons, completedTasks, params.predictedWriteSet);
    const plannerRoute = toModelOverride(params.plannerModel, params.plannerProvider);
    let plannerOutputs: SubagentResult[];
    let planner: SubagentResult;
    let selectedPlannerIndex = 0;
    const restoredPlanner = pevRestore<SubagentResult>(plannerName) ?? (await pevCollectSurvivor<SubagentResult>(plannerName));
    if (restoredPlanner) {
      emit(`Attempt ${attempt}: planner phase restored from checkpoint (resume) — skipping re-spawn.`);
      planner = restoredPlanner;
      plannerOutputs = [planner];
      state.plannerOutputs = plannerOutputs;
    } else {
      emit(`Attempt ${attempt}: spawning ${params.plannerCount} planner subagent(s) in parallel...`);
      const plannerJobs = Array.from({ length: params.plannerCount }, (_unused, index) => index);
      // Per-child survivor/checkpoint names so a mid-phase abort during a
      // MULTI-planner phase (plannerCount>1) can detach and later re-attach each
      // individual planner survivor. For plannerCount===1 the child name collapses
      // to the phase name, preserving the single-spawn checkpoint semantics.
      const plannerChildName = (i: number) => (params.plannerCount === 1 ? plannerName : `${plannerName}-${i}`);
      try {
        plannerOutputs = await runBoundedPool(plannerJobs, params.plannerCount, signal, async (plannerIndex, _index, workerSignal) => {
          const childName = plannerChildName(plannerIndex);
          // Resume path 1: completed per-child checkpoint — restore without re-spawn.
          const restoredChild = pevRestore<SubagentResult>(childName);
          if (restoredChild && !Array.isArray(restoredChild)) {
            emit(`Attempt ${attempt}: planner instance ${plannerIndex + 1}/${params.plannerCount} restored from checkpoint (resume) — skipping re-spawn.`);
            return restoredChild;
          }
          // Resume path 2: detached survivor for this planner child — collect or respawn.
          const survivorChild = await pevCollectSurvivor<SubagentResult>(childName);
          if (survivorChild) {
            emit(`Attempt ${attempt}: planner instance ${plannerIndex + 1}/${params.plannerCount} survivor collected (resume) — skipping re-spawn.`);
            return survivorChild;
          }
          const prompt = params.plannerCount > 1
            ? `${plannerPrompt}\n\nPlanner instance ${plannerIndex + 1}/${params.plannerCount}: produce an independent tiny plan. The orchestrator will deterministically select the lowest-index parseable plan; do not coordinate with other planners.`
            : plannerPrompt;
          let out: SubagentResult;
          try {
            out = await spawnChecked(state, params, agents, params.plannerAgent, prompt, workerSignal, emit, inheritedModel, plannerRoute, pevSurvival(childName));
          } catch (error) {
            pevDetachGuard(childName, error);
            throw error;
          }
          pevCheckpoint(childName, out, plannerRoute);
          return out;
        });
      } catch (error) {
        pevDetachGuard(plannerName, error);
        throw error;
      }
      state.plannerOutputs = plannerOutputs;
      selectedPlannerIndex = selectPlannerOutputIndex(plannerOutputs, params.task);
      planner = plannerOutputs[selectedPlannerIndex];
      pevCheckpoint(plannerName, planner, plannerRoute ?? {});
    }
    state.planText = planner.text;
    let plan = parsePlan(planner.text, params.task);
    plan = enforceTaskSizeCap(plan, computeAdaptiveTaskSizeCap(params.executorModel));
    const planRoleControls = extractPlanRoleControls(plan);
    const executorConcurrency = clampInt(planRoleControls.executorConcurrency ?? params.concurrency, params.concurrency, 1, 16);
    const verifierCount = clampInt(planRoleControls.verifierCount ?? params.verifierCount, params.verifierCount, 1, 16);
    const executionWaves = buildExecutionWaves(plan);
    state.plan = plan;

    if (params.plannerCount > 1) {
      emit(`Attempt ${attempt}: selected planner ${selectedPlannerIndex + 1}/${plannerOutputs.length} by deterministic lowest-index parseable-plan rule.`);
    }
    if (planRoleControls.executorConcurrency || planRoleControls.verifierCount) {
      emit(`Planner-supplied role controls applied: executorConcurrency=${executorConcurrency}, verifierCount=${verifierCount}.`);
    }
    const taskAssignments = plan.tasks.map((t) => `${t.id}=${t.description}`).join("; ");
    emit(`Plan tasks: ${taskAssignments}`);

    // ── Predict-then-write (AGENTS.md: Discovery before mutation) ────────
    // The contract-granted set wins; a planner-declared set is enforced when
    // no contract set was supplied. Enforcement is deterministic — no model
    // judgment is involved in detecting an out-of-set mutation.
    const contractWriteSet = params.predictedWriteSet;
    const effectiveWriteSet = contractWriteSet ?? plan.predictedWriteSet;
    if (plan.predictedWriteSet?.length) {
      emit(`Planner predicted write set (${plan.predictedWriteSet.length} entrie(s)): ${plan.predictedWriteSet.join(", ")}`);
    }
    if (contractWriteSet && plan.predictedWriteSet?.length) {
      const outsideContract = planEntriesOutsideContract(plan.predictedWriteSet, contractWriteSet);
      if (outsideContract.length > 0) {
        // Pre-execution satisfiability failure: the plan already declares
        // out-of-scope mutations. This is terminal for the current discovery:
        // fail BEFORE any executor spawns and do not retry inside the same run.
        emit(`Attempt ${attempt}: plan predicts ${outsideContract.length} mutation(s) outside the contracted write set — failing before execution: ${outsideContract.join(", ")}`);
        const terminalState = persistPevWriteSetTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-write-set-pre-execution`,
          "WRITE_SET_VIOLATION",
          state,
          undefined,
          outsideContract,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.executorOutputs = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        return finalizePevTerminalResult(params, state, terminalState);
      }
    }

    if (params.discoveryOnly) {
      const writeSetLabel = contractWriteSet ? "contract-granted" : plan.predictedWriteSet?.length ? "planner-predicted" : "none declared";
      const manifestLines = [
        `# Discovery manifest (run ${state.runId})`,
        "",
        "Discovery-only mode: no executor or verifier subagents were spawned; this run mutated no files.",
        "",
        `## Plan (${plan.tasks.length} task(s))`,
        ...plan.tasks.map((t) => `- ${t.id}: ${t.description}${t.dependsOn.length ? ` (depends on ${t.dependsOn.join(", ")})` : ""}`),
      ];
      if (plan.notes) manifestLines.push("", `Notes: ${plan.notes}`);
      manifestLines.push(
        "",
        `## Predicted write set (${writeSetLabel})`,
        ...(effectiveWriteSet?.length ? effectiveWriteSet.map((entry) => `- ${entry}`) : ["(none declared)"]),
        "",
        "To execute under deterministic write-set enforcement, re-run without discoveryOnly and pass the approved list as predictedWriteSet.",
      );
      const manifest = manifestLines.join("\n");
      emit(`Discovery-only run complete: ${plan.tasks.length} task(s) planned, ${effectiveWriteSet?.length ?? 0} write-set entrie(s); no executors spawned.`);
      state.finalResult = manifest;
      return {
        markdown: manifest,
        details: {
          runId: state.runId,
          mode: "discovery-only",
          plan: { tasks: plan.tasks, notes: plan.notes },
          predictedWriteSet: effectiveWriteSet ?? [],
          writeSetSource: writeSetLabel,
          progressLog: state.progressLog,
        },
      };
    }

    const requiredBudget = computeRequiredSubagentBudget(state.spawnedCount, plan.tasks.length, attempt, maxAttempts, params.plannerCount, verifierCount);
    if (!params.maxSubagentsExplicit && requiredBudget > params.maxSubagents) {
      const previous = params.maxSubagents;
      params.maxSubagents = Math.min(requiredBudget, MAX_SUBAGENTS_LIMIT);
      emit(
        `Auto-raised maxSubagents from ${previous} to ${params.maxSubagents} based on plan size (${plan.tasks.length} executor task(s)), plannerCount=${params.plannerCount}, verifierCount=${verifierCount}, and retry budget (${maxAttempts} attempt(s)).`,
      );
      if (requiredBudget > MAX_SUBAGENTS_LIMIT) {
        emit(`Required subagent budget ${requiredBudget} exceeds hard safety limit ${MAX_SUBAGENTS_LIMIT}; orchestration may still stop if the ceiling is reached.`);
      }
    } else if (params.maxSubagentsExplicit) {
      emit(`Using explicit maxSubagents=${params.maxSubagents}; auto-raise is disabled for this run.`);
    }

    const remainingAfterPlan = params.maxSubagents - state.spawnedCount;
    const neededForExecutionAndVerify = plan.tasks.length + verifierCount;
    if (neededForExecutionAndVerify > remainingAfterPlan) {
      throw new Error(
        `Subagent ceiling exceeded after planning: need ${neededForExecutionAndVerify} more spawn(s), remaining ${remainingAfterPlan}, maxSubagents=${params.maxSubagents}. Try /orchestrate --max-subagents ${requiredBudget} ... or reduce --max-retries.`,
      );
    }

    let writeSetObservationSummary = "";
    let writeSetBefore: WriteSetSnapshot | undefined;
    if (effectiveWriteSet?.length) {
      writeSetBefore = captureWriteSetSnapshot(params.cwd, effectiveWriteSet);
      if (writeSetBefore.unobservableScopes.length) {
        emit(
          `Attempt ${attempt}: write-set observation is unobservable before executor spawn — ` +
            `${writeSetBefore.unobservableScopes.join(", ")}; failing closed with no executor/verifier spawn.`,
        );
        const terminalState = persistPevWriteSetTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-write-set-pre-executor`,
          "WRITE_SET_UNOBSERVABLE",
          state,
          undefined,
          writeSetBefore.unobservableScopes,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.executorOutputs = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        return finalizePevTerminalResult(params, state, terminalState);
      }
    }

    // Executor phase is checkpointed PER TASK (attempt-N-executor-<taskId>). Each
    // task spawn runs in abort-survivor mode and its output is checkpointed with the
    // resolved executor provider/model, so a mid-execution abort can resume without
    // re-running already-completed tasks and without losing detached survivors.
    const executorRoute = toModelOverride(params.executorModel, params.executorProvider);
    emit(`Attempt ${attempt}: executing ${plan.tasks.length} task(s) across ${executionWaves.length} dependency wave(s) with executor concurrency ${executorConcurrency}...`);
    let executorOutputs: ExecutorOutput[] = [];
    try {
      executorOutputs = await runExecutorTasksInWaves(
        executionWaves,
        executorConcurrency,
        signal,
        async (task, _index, workerSignal) => {
          const taskName = executorTaskName(task.id);
          // Resume path 1: completed per-task checkpoint — restore without re-execution.
          const restoredTask = pevRestore<ExecutorOutput>(taskName);
          if (restoredTask && !Array.isArray(restoredTask)) {
            emit(`Attempt ${attempt}: executor task ${task.id} restored from checkpoint (resume) — skipping re-execution.`);
            return restoredTask;
          }
          // Resume path 2: detached survivor for this task — collect or respawn.
          const survivorOut = await pevCollectExecutorSurvivor(taskName, task);
          if (survivorOut) {
            emit(`Attempt ${attempt}: executor task ${task.id} survivor collected (resume) — skipping re-execution.`);
            return survivorOut;
          }
          let out: ExecutorOutput;
          try {
            out = await executeExecutorTaskWithRecovery(
              state, params, agents, task, plan, workerSignal, emit, inheritedModel, pevSurvival(taskName),
            );
          } catch (error) {
            pevDetachGuard(taskName, error);
            throw error;
          }
          pevCheckpoint(taskName, out, executorRoute);
          return out;
        },
      );
    } catch (error) {
      if (error instanceof SubagentTerminalAmbiguousError) {
        if (writeSetBefore && effectiveWriteSet?.length) {
          const writeSetAfter = captureWriteSetSnapshot(params.cwd, effectiveWriteSet);
          const terminalEval = evaluateWriteSetObservation(writeSetBefore, writeSetAfter, effectiveWriteSet);
          emit(`Attempt ${attempt}: terminal executor transport state observed; post-executor write-set snapshot: ${formatPevWriteSetObservation(terminalEval)}`);
          if (terminalEval.unobservableScopes.length || terminalEval.violations.length) {
            const code = terminalEval.unobservableScopes.length ? "WRITE_SET_UNOBSERVABLE" : "WRITE_SET_VIOLATION";
            const terminalState = persistPevWriteSetTerminal(
              pevStore,
              pevIndexOf,
              `attempt-${attempt}-executor-terminal-write-set`,
              code,
              state,
              terminalEval,
            );
            const verifierResult = makePevTerminalVerifierResult(terminalState);
            state.verifierResult = verifierResult;
            state.verifierResults = [];
            state.executorOutputs = [];
            state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
            state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
            return finalizePevTerminalResult(params, state, terminalState);
          }
        }
        const terminalState = persistPevAmbiguousTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-executor-terminal`,
          error,
          state,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.executorOutputs = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        return finalizePevTerminalResult(params, state, terminalState);
      }
      throw error;
    }
    state.executorOutputs = executorOutputs;

    if (writeSetBefore && effectiveWriteSet?.length) {
      const writeSetAfter = captureWriteSetSnapshot(params.cwd, effectiveWriteSet);
      const writeSetEval = evaluateWriteSetObservation(writeSetBefore, writeSetAfter, effectiveWriteSet);
      writeSetObservationSummary =
        `Write-set observation (${contractWriteSet ? "contract-granted" : "planner-predicted"} scope, ${effectiveWriteSet.length} entrie(s)): ` +
        `${writeSetEval.observed.length} observed mutation(s), ${writeSetEval.violations.length} violation(s), ` +
        `${writeSetEval.unobservableScopes.length} unobservable scope(s).`;
      if (writeSetEval.unobservableScopes.length || writeSetEval.violations.length) {
        const code = writeSetEval.unobservableScopes.length ? "WRITE_SET_UNOBSERVABLE" : "WRITE_SET_VIOLATION";
        emit(
          `Attempt ${attempt}: write-set enforcement failed before verification; ` +
            `${formatPevWriteSetObservation(writeSetEval)} This is terminal for the current discovery.`,
        );
        const terminalState = persistPevWriteSetTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-write-set-post-executor`,
          code,
          state,
          writeSetEval,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs, verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        updateTaskLedgerFromFailure(state, plan, executorOutputs, verifierResult.reasons, attempt, emit);
        return finalizePevTerminalResult(params, state, terminalState);
      }
    }

    // ── Commit evidence (F7): pre/post-execution HEAD hashes per attempt ──
    const postExecHead = gitHeadHash(params.cwd);
    state.commitEvidence.push({ attempt, preHash: preAttemptHead, postHash: postExecHead });
    if (preAttemptHead || postExecHead) {
      emit(`Attempt ${attempt}: commit evidence (run ${state.runId}) — pre=${preAttemptHead ?? "(none)"} post=${postExecHead ?? "(none)"}.`);
    }

    // ── Judgment layer (F1): effect evidence first, text shape demoted ───
    emit(`Attempt ${attempt}: collecting effect evidence (git deltas + tool-call telemetry)...`);
    const artifactEvidence = collectArtifactEvidence(params.cwd, executorOutputs);
    const textFindings = detectExecutorOutputQualityFindings(executorOutputs, artifactEvidence);
    const effectEvidenceByTask = buildTaskEffectEvidenceMap(executorOutputs);
    const effectFindings = buildZeroEffectFindings(effectEvidenceByTask);
    const gateDecision = resolveGateDecision({
      mode: params.hardGates,
      textShapeFindings: textFindings,
      effectFindings,
      effectEvidenceByTask,
    });
    if (gateDecision.warnings.length > 0) {
      state.gateWarnings.push(...gateDecision.warnings.map((warning) => `Attempt ${attempt}: ${warning}`));
      emit(`Attempt ${attempt}: ${gateDecision.warnings.length} gate warning(s) recorded (advisory — never verdict-determining on their own).`);
    }

    if (writeSetObservationSummary) {
      artifactEvidence.summary += `\n${writeSetObservationSummary}`;
    }

    if (gateDecision.preVerifierFailures.length > 0) {
      // hardGates="strict" only: effect-based findings (and non-immune
      // text-shape findings) abort the attempt before the verifier spawn.
      const allHardFailures = gateDecision.preVerifierFailures;
      emit(`Attempt ${attempt}: HARD GATE failures (mode=strict) detected before verification — ${allHardFailures.length} failure(s): ${allHardFailures.join("; ")}`);
      const verifierResult = {
        status: "fail" as const,
        reasons: allHardFailures.map((f) => `Post-execution hard gate: ${f}`),
        raw: JSON.stringify({ status: "fail", reasons: allHardFailures }),
      };
      state.routingCheck = checkRequiredModelRouting(params, state);
      if (state.routingCheck.status === "fail") {
        verifierResult.reasons.push(...state.routingCheck.reasons.map((reason) => `Deterministic model routing check failed: ${reason}`));
      }
      state.verifierResult = verifierResult;
      state.verifierResults = [];
      state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs, verifierResult, verifierResults: [] });
      state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
      updateTaskLedgerFromFailure(state, plan, executorOutputs, verifierResult.reasons, attempt, emit);

      if (attempt >= maxAttempts) break;
      if (state.spawnedCount >= params.maxSubagents) {
        throw new Error(`Subagent ceiling reached before retry: spawned ${state.spawnedCount}/${params.maxSubagents}.`);
      }
      continue;
    }

    const verifierRoute = toModelOverride(params.verifierModel, params.verifierProvider);
    let verifierOutputs: SubagentResult[];
    const restoredVerifier = pevRestore<SubagentResult[]>(verifierName);
    if (restoredVerifier && Array.isArray(restoredVerifier)) {
      emit(`Attempt ${attempt}: verifier phase restored from checkpoint (resume) — skipping re-spawn.`);
      verifierOutputs = restoredVerifier;
    } else {
      emit(`Attempt ${attempt}: verifying executor outputs with ${verifierCount} verifier subagent(s) in parallel...`);
      const verifierPrompt = buildVerificationPrompt(state.intake!, plan, executorOutputs, buildRoutingEvidenceForVerifier(params, state), artifactEvidence.summary);
      const verifierJobs = Array.from({ length: verifierCount }, (_unused, index) => index);
      // Per-child survivor/checkpoint names so a mid-phase abort during a
      // MULTI-verifier phase (verifierCount>1) can detach and re-attach each
      // individual verifier survivor. For verifierCount===1 the child name
      // collapses to the phase name; the phase-level checkpoint (an array,
      // written after the pool) then overwrites it, preserving prior semantics.
      const verifierChildName = (i: number) => (verifierCount === 1 ? verifierName : `${verifierName}-${i}`);
      try {
        verifierOutputs = await runBoundedPool(verifierJobs, verifierCount, signal, async (verifierIndex, _index, workerSignal) => {
          const childName = verifierChildName(verifierIndex);
          // Resume path 1: completed per-child checkpoint — restore without re-spawn.
          const restoredChild = pevRestore<SubagentResult>(childName);
          if (restoredChild && !Array.isArray(restoredChild)) {
            emit(`Attempt ${attempt}: verifier instance ${verifierIndex + 1}/${verifierCount} restored from checkpoint (resume) — skipping re-spawn.`);
            return restoredChild;
          }
          // Resume path 2: detached survivor for this verifier child — collect or respawn.
          const survivorChild = await pevCollectSurvivor<SubagentResult>(childName);
          if (survivorChild) {
            emit(`Attempt ${attempt}: verifier instance ${verifierIndex + 1}/${verifierCount} survivor collected (resume) — skipping re-spawn.`);
            return survivorChild;
          }
          const prompt = verifierCount > 1
            ? `${verifierPrompt}\n\nVerifier instance ${verifierIndex + 1}/${verifierCount}: independently verify. The orchestrator aggregates with strict consensus: any FAIL makes the aggregate FAIL.`
            : verifierPrompt;
          let out: SubagentResult;
          try {
            out = await spawnChecked(state, params, agents, params.verifierAgent, prompt, workerSignal, emit, inheritedModel, verifierRoute, pevSurvival(childName));
          } catch (error) {
            pevDetachGuard(childName, error);
            throw error;
          }
          pevCheckpoint(childName, out, verifierRoute);
          return out;
        });
      } catch (error) {
        pevDetachGuard(verifierName, error);
        throw error;
      }
      pevCheckpoint(verifierName, verifierOutputs, verifierRoute ?? {});
    }
    const verifierResults = verifierOutputs.map((verifierOutput, index) => ({
      agentName: verifierOutput.agentName,
      ...parseVerifierResult(verifierOutput.text),
      raw: verifierOutput.text,
      reasons: parseVerifierResult(verifierOutput.text).reasons.map((reason) => verifierCount > 1 ? `verifier-${index + 1}: ${reason}` : reason),
    }));
    state.verifierResults = verifierResults;
    const verifierResult = aggregateVerifierResults(verifierResults);
    state.routingCheck = checkRequiredModelRouting(params, state);
    if (verifierResult.status === "pass" && state.routingCheck.status === "fail") {
      verifierResult.status = "fail";
      verifierResult.reasons.push(...state.routingCheck.reasons.map((reason) => `Deterministic model routing check failed: ${reason}`));
    }

    // ── False-PASS guard (F1 #3 / 2026-06-03 case): the verifier verdict is
    //    the gate, but hard gates escalate on effect-based contradictions. ──
    if (verifierResult.status === "pass" && params.hardGates !== "off") {
      const escalations = [...gateDecision.escalations];
      if (escalations.length === 0) {
        const contradiction = detectFalsePassContradiction({
          hasImplementationTask: artifactEvidence.hasImplementationTask,
          anyMutatingToolCalls: executorOutputs.some((o) => (o.toolCalls?.mutating ?? 0) > 0),
          anyFilesChanged: executorOutputs.some((o) => (o.filesChanged ?? 0) > 0),
          gitAvailable: artifactEvidence.gitAvailable,
        });
        if (contradiction) escalations.push(contradiction);
      }
      if (escalations.length > 0) {
        verifierResult.status = "fail";
        verifierResult.reasons.push(...escalations.map((e) => `Post-verification effect contradiction (false-PASS guard): ${e}`));
        emit(`Attempt ${attempt}: verifier returned PASS but effect evidence contradicts it — forcing FAIL (${escalations.length} contradiction(s)).`);
      }
    }
    state.verifierResult = verifierResult;

    state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs, verifierResult, verifierResults });

    if (verifierResult.status === "pass") {
      for (const output of executorOutputs) {
        state.taskLedger.set(output.taskId, { taskId: output.taskId, description: output.description, verdict: "passed", attempt, output });
      }
      state.finalResult = buildFinalResult("pass", params, state);
      return {
        markdown: state.finalResult,
        details: buildDetails("pass", params, state),
      };
    }

    const reasons = verifierResult.reasons.length ? verifierResult.reasons : ["Verifier did not return a pass result."];
    state.failureReasons.push(...reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
    emit(`Attempt ${attempt}: verification failed (${reasons.join("; ")}).`);
    updateTaskLedgerFromFailure(state, plan, executorOutputs, reasons, attempt, emit);

    if (attempt >= maxAttempts) break;
    if (state.spawnedCount >= params.maxSubagents) {
      throw new Error(`Subagent ceiling reached before retry: spawned ${state.spawnedCount}/${params.maxSubagents}.`);
    }
  }

  state.finalResult = buildFinalResult("fail", params, state);
  return {
    markdown: state.finalResult,
    details: buildDetails("fail", params, state),
  };
  } catch (error) {
    // ── ALWAYS emit a partial report on abort (F5) ──────────────────────
    const message = error instanceof Error ? error.message : String(error);
    const terminalNoRetry = error instanceof SubagentTerminalAmbiguousError ? error.info : undefined;
    const composableResumeUnsupported = paradigm === "composable-pipeline";
    const resumeUnsupportedReason = composableResumeUnsupported
      ? "This composable-pipeline run is non-resumable: the paradigm does not persist RunStateStore checkpoints. " +
        "The run ID is diagnostic only; inspect possible mutations before starting a new orchestration."
      : undefined;
    const providerError =
      (error as { providerError?: ProviderHealthError }).providerError ??
      parseProviderError(message);
    state.abortReason = message;
    state.failureReasons.push(`Run aborted: ${message}`);
    if (terminalNoRetry) {
      state.failureReasons.push(`Terminal no-retry state: ${terminalNoRetry.code}; retryAllowed=false; resultLost=${terminalNoRetry.resultLost}.`);
    }
    if (resumeUnsupportedReason) state.failureReasons.push(resumeUnsupportedReason);
    emit(
      `Orchestration aborted — emitting partial report. Structured error: ${formatProviderError(providerError)}`,
    );
    state.finalResult = buildFinalResult("fail", params, state);
    return {
      markdown: state.finalResult,
      details: {
        ...buildDetails("fail", params, state),
        aborted: true,
        abortReason: message,
        providerError,
        paradigm,
        ...(terminalNoRetry ? { terminalNoRetry, retryAllowed: false, code: terminalNoRetry.code } : {}),
        ...(resumeUnsupportedReason ? {
          resumeSupported: false,
          resumable: false,
          resumeHint: {
            supported: false,
            paradigm,
            reason: resumeUnsupportedReason,
            runIdPurpose: "diagnostic-only",
          },
        } : {}),
      },
    };
  }
}

/**
 * Pre-flight provider health checks (F5): a 1-token ping per unique routed
 * provider/model pair, run BEFORE any work subagent is spawned. On primary
 * failure, per-role fallback routes are tried; remaining failures abort the
 * run with a structured machine-readable error (and a partial report).
 * Pings do not count against the maxSubagents budget.
 */
const PREFLIGHT_PING_TIMEOUT_MS = 20_000;
const PREFLIGHT_TOTAL_TIMEOUT_MS = 75_000;

function preflightBoundFromEnv(name: string, productionDefault: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : productionDefault;
}

async function runProviderPreflight(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  inheritedModel: { provider?: string; model?: string } | undefined,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
): Promise<void> {
  const perPingTimeoutMs = preflightBoundFromEnv("ORCHESTRATE_PREFLIGHT_TIMEOUT_MS", PREFLIGHT_PING_TIMEOUT_MS);
  const totalTimeoutMs = preflightBoundFromEnv("ORCHESTRATE_PREFLIGHT_TOTAL_TIMEOUT_MS", PREFLIGHT_TOTAL_TIMEOUT_MS);
  const deadline = Date.now() + totalTimeoutMs;
  const remainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`PREFLIGHT TOTAL TIMEOUT after ${totalTimeoutMs}ms (primary/fallback budget exhausted).`);
    return Math.min(perPingTimeoutMs, remaining);
  };

  const resolveRoute = (agentName: string, model?: string, provider?: string) => {
    const profile = agents.get(agentName);
    return {
      provider: provider ?? profile?.provider ?? inheritedModel?.provider,
      model: model ?? profile?.model ?? inheritedModel?.model,
    };
  };

  /** Parse comma-separated fallback chain — backward-compatible with single-value params. */
  const parseFallbackChain = (models?: string, providers?: string): Array<{ model?: string; provider?: string }> => {
    const modelList = (models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const providerList = (providers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const maxLen = Math.max(modelList.length, providerList.length);
    if (maxLen === 0) return [];
    const chain: Array<{ model?: string; provider?: string }> = [];
    for (let i = 0; i < maxLen; i++) {
      chain.push({
        model: modelList[i] || modelList[modelList.length - 1] || undefined,
        provider: providerList[i] || providerList[providerList.length - 1] || undefined,
      });
    }
    return chain;
  };

  const roles = [
    {
      role: "planner" as const,
      ...resolveRoute(params.plannerAgent, params.plannerModel, params.plannerProvider),
      fallbackChain: parseFallbackChain(params.plannerFallbackModel, params.plannerFallbackProvider),
      applyFallback: (model?: string, provider?: string) => {
        if (model) params.plannerModel = model;
        if (provider) params.plannerProvider = provider;
      },
    },
    {
      role: "executor" as const,
      ...resolveRoute(params.executorAgent, params.executorModel, params.executorProvider),
      fallbackChain: parseFallbackChain(params.executorFallbackModel, params.executorFallbackProvider),
      applyFallback: (model?: string, provider?: string) => {
        if (model) params.executorModel = model;
        if (provider) params.executorProvider = provider;
      },
    },
    {
      role: "verifier" as const,
      ...resolveRoute(params.verifierAgent, params.verifierModel, params.verifierProvider),
      fallbackChain: parseFallbackChain(params.verifierFallbackModel, params.verifierFallbackProvider),
      applyFallback: (model?: string, provider?: string) => {
        if (model) params.verifierModel = model;
        if (provider) params.verifierProvider = provider;
      },
    },
  ].filter((role) => role.provider || role.model);

  if (roles.length === 0) {
    emit("Preflight: no explicitly routed provider/model pairs — skipping health pings.");
    return;
  }

  const results = await preflightProviderHealth(
    roles.map((role) => ({ roles: [role.role], provider: role.provider, model: role.model })),
    {
      cwd: params.cwd,
      allowLocalModel: params.allowLocalModel,
      signal,
      onProgress: emit,
      timeoutMs: remainingTimeout(),
    },
  );

  const unrecovered: ProviderHealthError[] = [];
  for (const result of results.filter((r) => !r.ok)) {
    for (const roleName of result.roles) {
      const role = roles.find((r) => r.role === roleName);
      if (!role) continue;

      // F4 companion: multi-step fallback chain — try each fallback in order
      // until one succeeds or all are exhausted.
      let recovered = false;
      const chain = role.fallbackChain;
      if (chain.length > 0) {
        emit(
          `Preflight: ${roleName} primary route ${formatRoutedModel(role.provider, role.model)} failed — ` +
          `${chain.length} fallback(s) configured.`,
        );
        for (let i = 0; i < chain.length; i++) {
          const fb = chain[i];
          const fbLabel = formatRoutedModel(fb.provider, fb.model);
          emit(`Preflight: ${roleName} trying fallback ${i + 1}/${chain.length}: ${fbLabel}...`);
          const fbResults = await preflightProviderHealth(
            [{ roles: [roleName], provider: fb.provider, model: fb.model }],
            {
              cwd: params.cwd,
              allowLocalModel: params.allowLocalModel,
              signal,
              onProgress: emit,
              timeoutMs: remainingTimeout(),
            },
          );
          if (fbResults[0]?.ok) {
            role.applyFallback(fb.model, fb.provider);
            recovered = true;
            emit(
              `Preflight: ${roleName} re-routed to fallback ${i + 1} ${fbLabel} (graceful degradation).`,
            );
            break;
          }
          if (fbResults[0]?.error) {
            emit(
              `Preflight: ${roleName} fallback ${i + 1} ${fbLabel} also failed: ${formatProviderError(fbResults[0].error)}`,
            );
          }
        }
      }

      if (!recovered) {
        if (result.error) unrecovered.push(result.error);
        // Collect errors from all failed fallbacks too, for diagnostic richness.
        for (const fb of chain) {
          // We already logged each failure; don't double-count in unrecovered.
        }
      }
    }
  }

  if (unrecovered.length > 0) {
    const error = new Error(
      `PREFLIGHT FAILURE — provider health check failed before any subagent was spawned: ${unrecovered
        .map((e) => formatProviderError(e))
        .join(" | ")}`,
    ) as Error & { providerError?: ProviderHealthError };
    error.providerError = unrecovered[0];
    throw error;
  }

  emit(`Preflight: all ${roles.length} routed role route(s) healthy.`);
}

function computeRequiredSubagentBudget(
  spawnedThroughCurrentPlanner: number,
  executorTaskCount: number,
  currentAttempt: number,
  maxAttempts: number,
  plannerCount = 1,
  verifierCount = 1,
): number {
  const finishCurrentAttempt = executorTaskCount + verifierCount; // current planner batch already spawned.
  const remainingAttempts = Math.max(0, maxAttempts - currentAttempt);
  const fullFutureAttempt = plannerCount + executorTaskCount + verifierCount;
  return spawnedThroughCurrentPlanner + finishCurrentAttempt + remainingAttempts * fullFutureAttempt;
}

// ── Judgment-layer helpers (effect evidence, ledger, commit evidence) ─────

/** Current git HEAD hash, or null when git/HEAD is unavailable (F7). */
function gitHeadHash(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) return (result.stdout ?? "").trim() || null;
  } catch {
    // git unavailable
  }
  return null;
}

/** Snapshot of `git status --short` lines, or null when git is unavailable. */
function captureGitStatusEntries(cwd: string): Set<string> | null {
  try {
    const result = spawnSync("git", ["-C", cwd, "status", "--short"], {
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return new Set(
      (result.stdout ?? "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

/** Paths that appear/changed in `after` relative to `before` (per-task delta). */
function diffGitStatusEntries(before: Set<string> | null, after: Set<string> | null): string[] | undefined {
  if (!before || !after) return undefined;
  const changed: string[] = [];
  for (const entry of after) {
    if (!before.has(entry)) {
      const file = entry.slice(3).trim() || entry.trim();
      if (file && !changed.includes(file)) changed.push(file);
    }
  }
  return changed;
}

/** Build the per-task effect-evidence map consumed by the judgment layer. */
function buildTaskEffectEvidenceMap(executorOutputs: ExecutorOutput[]): Map<string, TaskEffectEvidence> {
  const map = new Map<string, TaskEffectEvidence>();
  for (const output of executorOutputs) {
    map.set(output.taskId, {
      taskId: output.taskId,
      isImplementationTask: isImplementationTask(output.description),
      mutatingToolCalls: output.toolCalls?.mutating ?? 0,
      totalToolCalls: output.toolCalls?.total ?? 0,
      filesChanged: output.filesChanged,
    });
  }
  return map;
}

/**
 * F2: persist per-task pass/fail state across attempts. Tasks referenced in
 * failure reasons are marked failed; the rest are carried forward and reused
 * (re-verified, not regenerated) on the next attempt. When no per-task
 * attribution is possible, all tasks are conservatively retried.
 */
function updateTaskLedgerFromFailure(
  state: OrchestrationState,
  plan: Plan,
  executorOutputs: ExecutorOutput[],
  reasons: string[],
  attempt: number,
  emit: (text: string) => void,
): void {
  const failedIds = extractReferencedTaskIds(reasons, plan.tasks.map((task) => task.id));
  const failAll = failedIds.size === 0;
  const passed: string[] = [];
  const failed: string[] = [];
  for (const output of executorOutputs) {
    const verdict: TaskLedgerEntry["verdict"] = failAll || failedIds.has(output.taskId) ? "failed" : "passed";
    state.taskLedger.set(output.taskId, {
      taskId: output.taskId,
      description: output.description,
      verdict,
      attempt,
      output,
    });
    (verdict === "passed" ? passed : failed).push(output.taskId);
  }
  if (passed.length > 0) {
    emit(
      `Retry targeting (F2): failed=[${failed.join(", ") || "(none)"}]; carried forward=[${passed.join(", ")}] — carried-forward tasks will be reused and re-verified, not re-executed.`,
    );
  } else if (failed.length > 0) {
    emit(
      `Retry targeting (F2): no per-task attribution found in failure reasons — all ${failed.length} task(s) will be retried.`,
    );
  }
}

/** Check that a previously-passed task's artifacts still exist on disk. */
function ledgerArtifactsStillPresent(entry: TaskLedgerEntry, cwd: string): boolean {
  const files = entry.output.changedFiles ?? [];
  if (files.length === 0) return true;
  return files.some((file) => existsSync(path.isAbsolute(file) ? file : path.join(cwd, file)));
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
 *           detected, look for a continuation contract and spawn a continuation.
 *   Tier 3 — Split-and-respawn (SPLIT): if handoff fails, split into
 *           <=150-word chained subtasks.
 *   Tier 4 — Replan-with-learning (REPLAN): add recovery metadata to
 *           failureReasons so the next planner attempt can adapt.
 */
/**
 * Build a minimal ExecutorOutput from a raw SubagentResult. Used when a detached
 * executor-task survivor is collected on resume (the abort-survivor writer only
 * persists the raw SubagentResult, not the wrapped ExecutorOutput).
 */
function executorOutputFromSubagent(task: PlanTask, result: SubagentResult): ExecutorOutput {
  return {
    taskId: task.id,
    description: task.description,
    agentName: result.agentName,
    output: result.text,
    stderr: result.stderr || undefined,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    contextExhaustionSignal: result.contextExhaustionSignal,
    toolCalls: result.toolCalls,
  };
}

async function executeExecutorTaskWithRecovery(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  task: PlanTask,
  plan: Plan,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  survival?: {
    resultFile: string;
    manifestFile: string;
    phaseName?: string;
    phaseIndex?: number;
  },
): Promise<ExecutorOutput> {
  // ── F2 retry targeting: reuse previously-passed task outputs ──────────
  const ledgerEntry = state.taskLedger.get(task.id);
  if (ledgerEntry?.verdict === "passed" && ledgerArtifactsStillPresent(ledgerEntry, params.cwd)) {
    emit(
      "Task " + task.id + ": previously completed on attempt " + ledgerEntry.attempt +
      " and artifacts are still present — reusing prior output and routing to re-verification instead of regeneration (F2).",
    );
    return {
      ...ledgerEntry.output,
      reusedFromAttempt: ledgerEntry.attempt,
      output:
        ledgerEntry.output.output +
        "\n\n[orchestrator note: output reused from attempt " + ledgerEntry.attempt +
        "; task previously passed and its artifacts are still present — re-verification only]",
    };
  }

  const prompt = buildExecutorPrompt(state.intake!, plan, task);

  // Tier 0: Pre-spawn budget estimation
  const budget = estimateExecutorContextBudget(
    prompt.length,
    params.executorModel,
    { criticalThreshold: 60 },
  );

  emit(
    "Task " + task.id + ": pre-spawn budget: " + budget.saturationPercent + "% sat " +
    "(" + budget.risk + "), rec: " + budget.recommendation,
  );

  const maxDepth = state.maxRecoveryDepth;

  // Proactive split before dispatch
  if (
    budget.recommendation === "SPLIT_BEFORE_SPAWN" &&
    state.recoveryDepth < maxDepth &&
    state.spawnedCount < params.maxSubagents
  ) {
    emit("Task " + task.id + ": SPLIT_BEFORE_SPAWN — splitting proactively.");
    return splitAndExecuteTask(
      state, params, agents, task, plan, "",
      signal, emit, inheritedModel, budget,
    );
  }

  // Tier 1: Normal spawn
  if (state.spawnedCount >= params.maxSubagents) {
    emit("Task " + task.id + ": spawn ceiling exhausted before dispatch.");
    return {
      taskId: task.id,
      description: task.description,
      agentName: params.executorAgent,
      output: "Spawn ceiling exhausted before " + task.id + " could be dispatched.",
      exitCode: 1,
      durationMs: 0,
      contextBudget: budget,
    };
  }

  // ── Effect evidence: per-task worktree snapshot before dispatch (F1) ──
  const preStatusEntries = captureGitStatusEntries(params.cwd);

  let result: SubagentResult;
  try {
    result = await spawnChecked(
      state, params, agents, params.executorAgent, prompt, signal, emit,
      inheritedModel, toModelOverride(params.executorModel, params.executorProvider),
      survival,
      true,
    );
  } catch (err) {
    // A mid-phase abort in abort-survivor mode detaches the child and rejects
    // with SubagentDetachedError. This MUST propagate so the caller can persist
    // the survivor manifest and surface the resume hint — never swallow it into
    // an ordinary task failure.
    if (err instanceof SubagentDetachedError) throw err;
    if (err instanceof SubagentTerminalAmbiguousError) throw err;
    emit("Task " + task.id + ": spawn failed — " + String(err));
    return {
      taskId: task.id,
      description: task.description,
      agentName: params.executorAgent,
      output: "Spawn error: " + String(err),
      stderr: String(err),
      exitCode: 1,
      durationMs: 0,
      contextBudget: budget,
      toolCalls: emptyToolCallSummary(),
    };
  }

  // ── Effect evidence: per-task worktree delta + tool-call telemetry ────
  const changedFiles = diffGitStatusEntries(preStatusEntries, captureGitStatusEntries(params.cwd));
  if (result.toolCalls || changedFiles) {
    emit(
      "Task " + task.id + ": effect evidence — tool calls " + formatToolCallSummary(result.toolCalls) +
      "; worktree delta " + (changedFiles ? changedFiles.length + " file(s)" + (changedFiles.length ? " (" + changedFiles.join(", ") + ")" : "") : "unknown (git unavailable)") + ".",
    );
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
    toolCalls: result.toolCalls,
    filesChanged: changedFiles ? changedFiles.length : undefined,
    changedFiles,
  };

  // Post-spawn: check for context exhaustion
  if (!checkContextExhaustion(result)) return output;

  emit(
    "Task " + task.id + ": context exhaustion detected (trunc=" + result.truncated + ", " +
    "signal=" + result.contextExhaustionSignal + ") — entering recovery.",
  );
  state.recoveryLog.push(
    "[RECOVERY] " + task.id + " a" + state.attempt + ": context exhaustion detected. Starting escalation.",
  );

  // Tier 2: Handoff continuation (CONTINUE)
  if (state.recoveryDepth < maxDepth && state.spawnedCount < params.maxSubagents) {
    emit("Task " + task.id + ": attempting handoff continuation (CONTINUE)...");

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
        state, params, agents, params.executorAgent,
        continuationPrompt, signal, emit, inheritedModel,
        toModelOverride(params.executorModel, params.executorProvider),
        undefined,
        true,
      );
    } catch {
      emit("Task " + task.id + ": handoff continuation spawn failed — escalating to split.");
      state.recoveryLog.push(
        "[RECOVERY] " + task.id + ": CONTINUE spawn failed — escalating to SPLIT.",
      );
      return trySplitAndExecute(
        state, params, agents, task, plan, result.text,
        signal, emit, inheritedModel, budget, maxDepth,
      );
    }

    if (!checkContextExhaustion(continueResult)) {
      emit("Task " + task.id + ": handoff continuation succeeded.");
      state.recoveryLog.push(
        "[RECOVERY] " + task.id + ": CONTINUE tier succeeded.",
      );
      return mergeExecutorOutputs(output, {
        taskId: task.id,
        description: task.description,
        agentName: continueResult.agentName,
        output: "## CONTINUATION\n" + continueResult.text,
        exitCode: continueResult.exitCode,
        durationMs: continueResult.durationMs,
        contextBudget: budget,
        truncated: continueResult.truncated,
        contextExhaustionSignal: continueResult.contextExhaustionSignal,
      });
    }

    emit("Task " + task.id + ": handoff continuation also exhausted — escalating to split.");
    state.recoveryLog.push(
      "[RECOVERY] " + task.id + ": CONTINUE exhausted — escalating to SPLIT.",
    );
  }

  return trySplitAndExecute(
    state, params, agents, task, plan, result.text,
    signal, emit, inheritedModel, budget, maxDepth,
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
  budget: ContextBudget,
  maxDepth: number,
): Promise<ExecutorOutput> {
  if (state.recoveryDepth < maxDepth && state.spawnedCount < params.maxSubagents) {
    emit("Task " + task.id + ": attempting split-and-respawn (SPLIT)...");
    return splitAndExecuteTask(
      state, params, agents, task, plan, partialOutput,
      signal, emit, inheritedModel, budget,
    );
  }

  return escalateToReplan(state, task, partialOutput, params.executorAgent, budget);
}

/**
 * Split a task into chained subtasks and execute them sequentially.
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
    "Task " + task.id + ": split into " + split.subtasks.length + " subtask(s) " +
    "(depth " + state.recoveryDepth + "/" + state.maxRecoveryDepth + ")",
  );

  const subtaskOutputs: ExecutorOutput[] = [];

  for (const subtask of split.subtasks) {
    if (state.spawnedCount >= params.maxSubagents) {
      emit(
        "Task " + task.id + ": spawn ceiling reached mid-split (" +
        state.spawnedCount + "/" + params.maxSubagents + ") — stopping subtask chain.",
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
        state, params, agents, params.executorAgent,
        subtaskPrompt, signal, emit, inheritedModel,
        toModelOverride(params.executorModel, params.executorProvider),
        undefined,
        true,
      );
    } catch (err) {
      emit("Task " + task.id + ": subtask " + subtask.id + " spawn failed — " + String(err));
      subtaskOutputs.push({
        taskId: subtask.id,
        description: subtask.description,
        agentName: params.executorAgent,
        output: "Subtask spawn failed: " + String(err),
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

    if (checkContextExhaustion(subtaskResult)) {
      emit("Task " + task.id + ": subtask " + subtask.id + " also exhausted — stopping chain.");
      break;
    }
  }

  if (subtaskOutputs.length === 0) {
    return escalateToReplan(state, task, partialOutput, params.executorAgent, budget);
  }

  const chainedOutput = chainExecutorOutputs(
    subtaskOutputs,
    task.description,
    task.id,
  );

  const totalDuration = subtaskOutputs.reduce(function(sum, o) { return sum + o.durationMs; }, 0);
  const allClean = subtaskOutputs.every(function(o) { return o.exitCode === 0; });

  state.recoveryLog.push(
    "[RECOVERY] " + task.id + ": SPLIT tier completed — " +
    subtaskOutputs.length + " subtask(s), all_clean=" + allClean,
  );

  return {
    taskId: task.id,
    description: task.description,
    agentName: params.executorAgent,
    output: chainedOutput,
    exitCode: allClean ? 0 : 1,
    durationMs: totalDuration,
    contextBudget: budget,
  };
}

/**
 * Escalate to Tier 4: add recovery metadata to failureReasons.
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
    "Task " + task.id + ": recovery all tiers exhausted at depth " + state.recoveryDepth + ". " +
    "Completed: " + (metadata.completedObjectives.join("; ") || "none") + ". " +
    "Remaining: " + metadata.remainingObjectives.join("; ") + ". " +
    "Files: " + (metadata.filesMentioned.join(", ") || "none") + ".",
  );

  state.recoveryLog.push(
    "[RECOVERY] " + task.id + ": escalated to REPLAN — metadata added to failureReasons.",
  );

  return {
    taskId: task.id,
    description: task.description,
    agentName,
    output: partialOutput || "Task " + task.id + ": recovery exhausted — escalated to replan.",
    exitCode: 1,
    durationMs: 0,
    contextBudget: budget,
    contextExhaustionSignal: true,
  };
}

/**
 * Check whether a subagent result shows signs of context exhaustion.
 */
function checkContextExhaustion(result: SubagentResult): boolean {
  if (result.truncated || result.contextExhaustionSignal) return true;

  const text = result.text ?? "";
  if (!text.trim()) return false;

  const truncationSignals: RegExp[] = [
    /\b(?:truncated|cut off|too long|exceeded)\b/i,
    /\.\.\.\s*$/m,
    /(?:content|output|response)\s+(?:has been|was)\s+truncated/i,
  ];

  for (const signal of truncationSignals) {
    if (signal.test(text)) return true;
  }

  const JSON_FENCE = "```";
  const jsonFenceCount = (text.match(new RegExp(JSON_FENCE + "json", "g")) ?? []).length;
  const closeFenceCount = (text.match(new RegExp(JSON_FENCE, "g")) ?? []).length;
  if (jsonFenceCount > 0 && closeFenceCount < jsonFenceCount * 2) return true;

  return false;
}

/**
 * Try to read an executor continuation contract from disk.
 */
function tryReadContinuationContract(
  taskId: string,
  cwd: string,
): ExecutorContinuationContract | null {
  const candidates = [
    cwd + "/continuation-" + taskId + ".md",
    "continuation-" + taskId + ".md",
  ];

  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, "utf-8");
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
      // File doesn't exist, isn't JSON, or isn't a valid contract
    }
  }

  return null;
}

/**
 * Merge two ExecutorOutput objects into one.
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
    toolCalls: sumToolCallSummaries(first.toolCalls, second.toolCalls),
    filesChanged: first.filesChanged === undefined && second.filesChanged === undefined
      ? undefined
      : (first.filesChanged ?? 0) + (second.filesChanged ?? 0),
    changedFiles: first.changedFiles || second.changedFiles
      ? [...new Set([...(first.changedFiles ?? []), ...(second.changedFiles ?? [])])]
      : undefined,
  };
}

function sumToolCallSummaries(
  first: ToolCallSummary | undefined,
  second: ToolCallSummary | undefined,
): ToolCallSummary | undefined {
  if (!first) return second;
  if (!second) return first;
  const byTool: Record<string, number> = { ...first.byTool };
  for (const [tool, count] of Object.entries(second.byTool)) {
    byTool[tool] = (byTool[tool] ?? 0) + count;
  }
  return {
    total: first.total + second.total,
    mutating: first.mutating + second.mutating,
    byTool,
  };
}

function toModelOverride(model?: string, provider?: string): RoleModelOverride | undefined {
  if (!model && !provider) return undefined;
  return { model, provider };
}

async function spawnChecked(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  agentName: string,
  task: string,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
  inheritedModel?: { provider?: string; model?: string },
  modelOverride?: RoleModelOverride,
  abortSurvival?: {
    resultFile: string;
    manifestFile: string;
    phaseName?: string;
    phaseIndex?: number;
  },
  phaseMutates = false,
): Promise<SubagentResult> {
  if (state.spawnedCount >= params.maxSubagents) {
    throw new Error(`Subagent ceiling exceeded: already spawned ${state.spawnedCount}/${params.maxSubagents}.`);
  }
  state.spawnedCount++;
  onProgress?.(`Spawning subagent ${agentName} (${state.spawnedCount}/${params.maxSubagents}) in ${params.cwd}`);
  return runSubagent(agentName, task, {
    agents,
    cwd: params.cwd,
    allowLocalModel: params.allowLocalModel,
    signal,
    inheritedModel,
    onProgress,
    modelOverride,
    ...(abortSurvival ? { abortSurvival } : {}),
    phaseMutates,
  });
}

function resolveNamedRoleRoute(
  agents: Map<string, AgentProfile>,
  agentName: string,
  model?: string,
  provider?: string,
): { model?: string; provider?: string } {
  const profile = agents.get(agentName);
  return {
    model: model ?? profile?.model,
    provider: provider ?? profile?.provider,
  };
}

function resolveConfiguredRoleDefaults(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
): void {
  const agentRoot = process.env.PI_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  let piDefault: { provider?: string; model?: string } = {};
  try {
    const settings = JSON.parse(readFileSync(path.join(agentRoot, "settings.json"), "utf8")) as Record<string, unknown>;
    piDefault = {
      provider: optionalString(settings.defaultProvider),
      model: optionalString(settings.defaultModel),
    };
  } catch {
    // Pi itself will use its configured default when no explicit CLI route is available.
  }

  // Put current Pi defaults on the named role profiles rather than params.
  // Params remain true explicit/NL overrides, so shapes with their own fixed
  // route defaults are not accidentally overridden by the global Pi route.
  for (const agentName of new Set([params.plannerAgent, params.executorAgent, params.verifierAgent])) {
    const profile = agents.get(agentName) ?? { name: agentName };
    agents.set(agentName, {
      ...profile,
      model: profile.model ?? piDefault.model,
      provider: profile.provider ?? piDefault.provider,
    });
  }
}

async function loadAgents(): Promise<Map<string, AgentProfile>> {
  const agents = new Map<string, AgentProfile>();
  for (const agent of DEFAULT_AGENTS) agents.set(agent.name, agent);

  const agentRoot = process.env.PI_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  const agentsDir = path.join(agentRoot, "agents");
  if (!existsSync(agentsDir)) return agents;

  const entries = await readdir(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(agentsDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    try {
      if (ext === ".json") {
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const agent = normalizeAgent(item, path.basename(entry.name, ext));
          if (agent) agents.set(agent.name, agent);
        }
      } else if (ext === ".md") {
        const content = await readFile(filePath, "utf8");
        const agent = parseMarkdownAgent(content, path.basename(entry.name, ext));
        if (agent) agents.set(agent.name, agent);
      }
    } catch (error) {
      // Keep orchestration robust: malformed optional agent files do not prevent default agents.
      // The offending profile simply is not loaded.
    }
  }

  return agents;
}

function normalizeAgent(value: unknown, fallbackName: string): AgentProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const name = stringParam(raw.name, fallbackName).trim();
  if (!name) return null;
  return {
    name,
    description: optionalString(raw.description),
    systemPrompt: optionalString(raw.systemPrompt),
    provider: optionalString(raw.provider),
    model: optionalString(raw.model),
    tools: stringArray(raw.tools),
    skills: stringArray(raw.skills),
    agencyLevel: typeof raw.agencyLevel === "string" || typeof raw.agencyLevel === "number" ? raw.agencyLevel : undefined,
  };
}

function parseMarkdownAgent(content: string, fallbackName: string): AgentProfile | null {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const frontmatter = match ? parseFrontmatter(match[1]) : {};
  const body = match ? content.slice(match[0].length).trim() : content.trim();
  const agent = normalizeAgent(
    {
      ...frontmatter,
      systemPrompt: optionalString(frontmatter.systemPrompt) ?? body,
    },
    fallbackName,
  );
  return agent;
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    result[key] = parseFrontmatterValue(value);
  }
  return result;
}

function parseFrontmatterValue(value: string): unknown {
  const unquoted = (s: string) => s.replace(/^['\"]|['\"]$/g, "").trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.slice(1, -1).split(",").map(unquoted).filter(Boolean);
    }
  }
  if (value.includes(",")) return value.split(",").map(unquoted).filter(Boolean);
  return unquoted(value);
}

async function runSubagent(
  agentName: string,
  task: string,
  options: {
    agents: Map<string, AgentProfile>;
    cwd: string;
    allowLocalModel: boolean;
    signal?: AbortSignal;
    inheritedModel?: { provider?: string; model?: string };
    onProgress?: (text: string) => void;
    modelOverride?: RoleModelOverride;
    /**
     * Abort-survivor mode (ABORT-RESUME-DESIGN.md): when the AbortSignal fires,
     * detach the child instead of killing it — persist a survivor manifest,
     * reject with SubagentDetachedError, and background-write the full result to
     * `resultFile` when the child eventually closes. Opt-in per spawn; spawns
     * without this option keep exact kill-on-abort semantics.
     */
    abortSurvival?: {
      resultFile: string;
      manifestFile: string;
      phaseName?: string;
      phaseIndex?: number;
    };
    /** See SpawnSubagentOptions.phaseMutates in substrate.ts. */
    phaseMutates?: boolean;
  },
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const loadedProfile = options.agents.get(agentName) ?? { name: agentName };
  const profile: AgentProfile = {
    ...loadedProfile,
    provider: options.modelOverride?.provider ?? loadedProfile.provider ?? options.inheritedModel?.provider,
    model: options.modelOverride?.model ?? loadedProfile.model ?? options.inheritedModel?.model,
  };
  rejectLocalModelIfNeeded(profile, options.allowLocalModel);
  options.onProgress?.(
    `Subagent ${profile.name}: using ${formatRoutedModel(profile.provider, profile.model)}.`,
  );

  const tempDir = await mkTempDir();
  const promptFile = path.join(tempDir, `${safeFileName(agentName)}-system-prompt.txt`);
  const systemPrompt = buildSubagentSystemPrompt(profile);
  await writeFile(promptFile, systemPrompt, "utf8");

  const command = resolvePiCommand();
  const args = [
    ...command.argsPrefix,
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--append-system-prompt",
    promptFile,
  ];

  if (profile.provider) args.push("--provider", profile.provider);
  if (profile.model) args.push("--model", profile.model);
  if (profile.tools) {
    const tools = profile.tools.map(String).map((tool) => tool.trim()).filter(Boolean).filter((tool) => tool !== "orchestrate");
    if (tools.length > 0) args.push("--tools", tools.join(","));
    else args.push("--no-tools");
  }
  for (const skill of profile.skills ?? []) {
    const trimmed = String(skill).trim();
    if (trimmed) args.push("--skill", trimmed);
  }

  // Pipe the task via stdin to avoid ENAMETOOLONG on Windows.
  const safeArgLen = process.platform === "win32" ? 6000 : 128_000;
  let pipeStdin = false;
  if (task.length <= safeArgLen) {
    args.push(task);
  } else {
    pipeStdin = true;
    options.onProgress?.(`Subagent ${profile.name}: prompt size ${task.length} chars exceeds safe arg limit ${safeArgLen}; piping via stdin.`);
  }

  options.onProgress?.(
    `Subagent ${profile.name}: launching ${path.basename(command.command)} ${args.includes("--no-extensions") ? "--no-extensions" : ""} --mode json in ${options.cwd}`,
  );

  const baseSpawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: command.env ?? process.env,
    stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: command.shell,
  };
  const launchAttempts = buildWindowsEpermSpawnAttempts(command.command, args, baseSpawnOptions);

  try {
    for (let attemptIndex = 0; attemptIndex < launchAttempts.length; attemptIndex++) {
      const launch = launchAttempts[attemptIndex];
      let stderr = "";
      let lastAssistantText = "";
      let eventCount = 0;
      let killedByAbort = false;
      let agentEnded = false;
      let protocolTimedOut = false;
      let firstJsonProtocolEventSeen = false;
      let firstJsonTimer: NodeJS.Timeout | undefined;
      const firstJsonTimeoutMs = getPiChildFirstJsonTimeoutMs(command.env ?? process.env);
      const markFirstJsonProtocolEvent = () => {
        if (firstJsonProtocolEventSeen) return;
        firstJsonProtocolEventSeen = true;
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
      };
      const assistantFailures: string[] = [];
      const toolCalls = emptyToolCallSummary();

      let child;
      try {
        child = spawn(launch.command, launch.args, launch.options);
        firstJsonTimer = setTimeout(() => {
          protocolTimedOut = true;
          stderr += `\nPI_CHILD_FIRST_JSON_TIMEOUT: no valid JSON protocol event within ${firstJsonTimeoutMs}ms from ${path.basename(launch.command)}; terminating owned child tree.`;
          try { child.kill("SIGTERM"); } catch {}
          killOwnedProcessTree(child.pid, "first-json-timeout");
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

      // Pipe the task via stdin when it exceeds the safe arg limit.
      if (pipeStdin && child.stdin) {
        child.stdin.write(task);
        child.stdin.end();
      }

      // Abort-survivor plumbing (ABORT-RESUME-DESIGN.md), ported from the
      // substrate spawn so the inline plan-execute-verify path can detach and
      // resume. detachReject unwinds the awaiting promise; the background
      // close-handler persists the final result.
      let detachReject: ((err: SubagentDetachedError) => void) | undefined;
      const detachPromise = new Promise<never>((_resolve, reject) => {
        detachReject = reject;
      });
      detachPromise.catch(() => {});

      const abortHandler = () => {
        const survival = options.abortSurvival;
        if (survival) {
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
            writeFileSync(survival.manifestFile, JSON.stringify(manifest, null, 2), "utf8");
          } catch {}
          child.once("close", (code) => {
            const backgroundResult: SubagentResult = {
              agentName: profile.name,
              task,
              text: lastAssistantText.trim(),
              stderr: stderr.trim(),
              exitCode: code,
              durationMs: Date.now() - startedAt,
              events: eventCount,
              toolCalls,
            };
            if (profile.provider) backgroundResult.provider = profile.provider;
            if (profile.model) backgroundResult.model = profile.model;
            try {
              writeFileSync(survival.resultFile, JSON.stringify(backgroundResult, null, 2), "utf8");
            } catch {}
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

      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed);
          if (isPiJsonProtocolEvent(event)) markFirstJsonProtocolEvent();
          eventCount++;
          const progress = describeJsonEvent(profile.name, event);
          if (progress) options.onProgress?.(progress);
          // Effect-evidence telemetry: count tool executions by tool name (F1).
          if (event?.type === "tool_execution_start") {
            const toolName = optionalString((event as Record<string, unknown>).toolName);
            if (toolName) recordToolCall(toolCalls, toolName);
          }
          if (event?.type === "agent_end") {
            agentEnded = true;
          }
          if (event?.type === "message_end" && event.message?.role === "assistant" && !agentEnded) {
            lastAssistantText = extractMessageText(event.message);
            const stopReason = optionalString(event.message.stopReason) ?? optionalString(event.stopReason);
            const errorMessage =
              optionalString(event.message.errorMessage) ??
              optionalString(event.errorMessage) ??
              optionalString(event.message.error?.message) ??
              optionalString(event.error?.message);
            const normalizedStopReason = stopReason?.toLowerCase();
            if (normalizedStopReason === "error" || normalizedStopReason === "aborted") {
              assistantFailures.push(`assistant stopReason=${stopReason}`);
            }
            if (errorMessage) assistantFailures.push(`assistant errorMessage=${errorMessage}`);
          }
        } catch {
          // JSON mode should emit JSONL; ignore any incidental non-JSON line defensively.
        }
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

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
          // Do NOT close stdoutReader: background collectors keep accumulating
          // until the orphaned child closes and writes its result file.
          options.onProgress?.(
            `Subagent ${profile.name}: DETACHED on abort (pid=${err.manifest.pid}); ` +
              `result will be persisted to ${err.manifest.resultFile}.`,
          );
          throw err;
        }
        stdoutReader.close();
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

      if (firstJsonTimer) clearTimeout(firstJsonTimer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
      stdoutReader.close();

      const buildCandidate = (): SubagentResult => {
        const result: SubagentResult = {
          agentName: profile.name,
          task,
          text: lastAssistantText.trim(),
          stderr: stderr.trim(),
          exitCode,
          durationMs: Date.now() - startedAt,
          events: eventCount,
          toolCalls,
        };
        if (profile.provider) result.provider = profile.provider;
        if (profile.model) result.model = profile.model;
        return result;
      };
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

      if (killedByAbort) throw new Error(`Subagent ${agentName} aborted.`);
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
        const stderrSuffix = stderr.trim() ? ` stderr: ${truncateWithNotice(stderr.trim(), 1000, "stderr")}` : "";
        const message =
          `Subagent ${agentName} reported assistant failure despite exit code 0: ` +
          `${truncateWithNotice(assistantFailures.join("; "), 2000, "assistant failure details")}.${stderrSuffix}`;
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }

      return buildCandidate();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  throw new Error(`Subagent ${agentName} did not launch: no spawn attempts were available.`);
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
  const assistantEvent = raw.assistantMessageEvent && typeof raw.assistantMessageEvent === "object"
    ? raw.assistantMessageEvent as Record<string, unknown>
    : undefined;
  const innerType = optionalString(assistantEvent?.type) ?? eventType;

  if (innerType === "tool_call_start") {
    const toolName = optionalString(assistantEvent?.toolName) ?? optionalString(raw.toolName) ?? "unknown-tool";
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

function buildIntake(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  inheritedModel?: { provider?: string; model?: string },
): Intake {
  const constraints = extractConstraintLines(params.task);
  // F6: contract extraction carries provenance — only literal task markers
  // produce an explicit (verdict-determining) contract; generic synthesis is
  // demoted to an inferred advisory criterion that can warn but never fail.
  const contractInfo = extractExecutorOutputContract(params.task);
  const executorOutputContract = contractInfo?.contract;
  const executorOutputContractSource = contractInfo?.source;
  const inferredAdvisoryCriteria: string[] = [];
  const criteriaProvenance: Intake["criteriaProvenance"] = [];
  const routingRequirements = buildRoutingRequirements(params, agents, inheritedModel);
  const essentialRoutingRequirements = routingRequirements.filter((req) => req.essential);
  const successCriteria = extractSuccessCriteria(params.task);
  for (const criterion of successCriteria) criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  if (essentialRoutingRequirements.length) {
    const routingCriteria = essentialRoutingRequirements.map((req) => `Model routing evidence must show ${req.role} (${req.agentName}) used ${formatRoutedModel(req.provider, req.model)}.`);
    successCriteria.unshift(...routingCriteria);
    for (const criterion of routingCriteria) criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  }
  if (executorOutputContract && executorOutputContractSource === "explicit") {
    const criterion = `Executor outputs must satisfy this output contract: ${executorOutputContract}`;
    successCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  } else if (executorOutputContract) {
    inferredAdvisoryCriteria.push(`(inferred) Executor outputs should follow the output format implied by the task: ${executorOutputContract} — advisory only; violations are warnings, never failures.`);
  }
  if (params.concurrency > 1) {
    const criterion = `Executor dependency waves may run up to ${params.concurrency} executor subagent(s) concurrently when dependencies allow.`;
    successCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  }
  if (params.plannerCount > 1) {
    const criterion = `Orchestrator must run ${params.plannerCount} planner subagent(s) in parallel before deterministic plan selection.`;
    successCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  }
  if (params.verifierCount > 1) {
    const criterion = `Orchestrator must run ${params.verifierCount} verifier subagent(s) in parallel before deterministic verdict aggregation.`;
    successCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  }

  const failureCriteria = extractFailureCriteria(params.task);
  for (const criterion of failureCriteria) criteriaProvenance.push({ text: criterion, kind: "failure", source: "explicit" });
  if (essentialRoutingRequirements.length) {
    const criterion = "Any required model routing mismatch is a deterministic FAIL, even if task outputs are otherwise correct.";
    failureCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "failure", source: "explicit" });
  }
  if (executorOutputContract && executorOutputContractSource === "explicit") {
    const criterion = "Executor output that violates the output contract is a FAIL, even if semantically correct.";
    failureCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "failure", source: "explicit" });
  }

  return {
    originalTask: params.task,
    taskSummary: summarizeTask(params.task),
    taskType: "deterministic planner/executor/verifier orchestration",
    userIntent: inferIntent(params.task),
    goalAttractor: "A PASS result with executor outputs matching the requested work and all essential constraints visibly satisfied.",
    taskScope: "Only the work described in the original task and normalized intake contract is in scope.",
    constraints,
    invariants: [
      "Do not reinterpret explicit user constraints as optional preferences.",
      "Do not treat model routing requirements as executor work; they are orchestrator-level requirements.",
      "Preserve explicit output-format requirements exactly when provided.",
    ],
    successCriteria: successCriteria.length ? successCriteria : ["Verifier can observe that executor outputs satisfy the original task."],
    failureCriteria,
    nonGoals: extractNonGoals(params.task),
    ambiguities: [],
    routingDecision: essentialRoutingRequirements.length
      ? "Model routing is essential and must be satisfied by orchestrator subprocess configuration."
      : "No explicit or inferred essential model routing was requested; use profile/inherited/default routing.",
    routingRequirements,
    orchestrationControls: params.orchestrationControls,
    executorOutputContract,
    executorOutputContractSource,
    inferredAdvisoryCriteria,
    criteriaProvenance,
  };
}

function formatIntakeForPrompt(intake: Intake): string {
  return JSON.stringify({
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
    executor_output_contract_source: intake.executorOutputContractSource,
    inferred_advisory_criteria: intake.inferredAdvisoryCriteria,
    criteria_provenance: intake.criteriaProvenance,
    original_task: intake.originalTask,
  }, null, 2);
}

/**
 * Produce an executor-relevant minified version of the intake contract.
 * Strips orchestrator-level fields that are irrelevant to executor subagents,
 * reducing prompt bloat and preserving context budget for actual work.
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

function buildRoutingRequirements(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  inheritedModel?: { provider?: string; model?: string },
): RoutingRequirement[] {
  // Reuse the already-suppressed routing computed in normalizeParams. Re-running
  // inferModelRoutingFromTask here would reintroduce NL routes for roles that
  // carry an explicit param, letting a provider-only override recombine with a
  // suppressed NL model (bug: natural-language-route-parser-hijacks-roles-from-task-prose.md).
  const inferredFromTask = params.inferredRouting ?? {};
  const roles: Array<{ role: RoutingRequirement["role"]; agentName: string; provider?: string; model?: string; explicit: boolean; inferred?: RoleModelOverride }> = [
    { role: "planner", agentName: params.plannerAgent, provider: params.plannerProvider, model: params.plannerModel, explicit: Boolean(params.plannerProvider || params.plannerModel), inferred: inferredFromTask.planner },
    { role: "executor", agentName: params.executorAgent, provider: params.executorProvider, model: params.executorModel, explicit: Boolean(params.executorProvider || params.executorModel), inferred: inferredFromTask.executor },
    { role: "verifier", agentName: params.verifierAgent, provider: params.verifierProvider, model: params.verifierModel, explicit: Boolean(params.verifierProvider || params.verifierModel), inferred: inferredFromTask.verifier },
  ];
  return roles
    .map((role) => {
      const profile = agents.get(role.agentName);
      const provider = role.provider ?? role.inferred?.provider ?? profile?.provider ?? inheritedModel?.provider;
      const model = role.model ?? role.inferred?.model ?? profile?.model ?? inheritedModel?.model;
      if (!provider && !model) return null;
      const inferredMatch = Boolean(role.inferred && role.inferred.provider === provider && role.inferred.model === model);
      const source: RoutingRequirement["source"] = inferredMatch
        ? "natural_language"
        : role.explicit
          ? "explicit_flag"
          : profile?.provider || profile?.model
            ? "agent_profile"
            : "inherited";
      const requirement: RoutingRequirement = { role: role.role, agentName: role.agentName, provider, model, essential: role.explicit || source === "natural_language", source };
      if (role.role === "planner" && params.plannerCount > 1) requirement.count = params.plannerCount;
      if (role.role === "verifier" && params.verifierCount > 1) requirement.count = params.verifierCount;
      if (role.role === "executor" && params.concurrency > 1) requirement.count = params.concurrency;
      return requirement;
    })
    .filter((req): req is RoutingRequirement => Boolean(req));
}

function buildRoutingEvidenceForVerifier(params: NormalizedParams, state: OrchestrationState): string {
  const observed = state.progressLog.filter((line) => /Subagent \S+: using /.test(line));
  const expected = state.intake?.routingRequirements ?? [];
  const currentVerifier = expected.find((req) => req.role === "verifier");
  return JSON.stringify({
    expected_routing_requirements: expected,
    observed_spawn_evidence_so_far: observed,
    verifier_spawn_configuration_for_this_verifier: currentVerifier
      ? `${currentVerifier.agentName} will be spawned with ${formatRoutedModel(currentVerifier.provider, currentVerifier.model)}`
      : `verifier agent ${params.verifierAgent} has no explicit routing requirement`,
    note: "Treat expected_routing_requirements plus observed_spawn_evidence_so_far plus verifier_spawn_configuration_for_this_verifier as concrete model routing evidence for this verification. Do not require the final report, because it is created after verification. TypeScript also performs a deterministic routing check after verifier completion.",
  }, null, 2);
}

function checkRequiredModelRouting(params: NormalizedParams, state: OrchestrationState): RoutingCheck {
  const requirements = (state.intake?.routingRequirements ?? []).filter((req) => req.essential);
  const evidence = state.progressLog.filter((line) => /Subagent \S+: using /.test(line));
  const reasons: string[] = [];
  for (const req of requirements) {
    const isCore = req.role === "planner" || req.role === "executor" || req.role === "verifier";
    const matches = evidence.filter((line) => {
      if (isCore) {
        // Core roles: match by provider/model only, tolerating agent-name variance.
        // A spawn to agent "researcher" with the correct model during the executor
        // phase counts as valid executor routing evidence.
        return line.includes(req.provider ?? "") && line.includes(req.model ?? "");
      }
      // Runtime roles: match by agentName + provider/model.
      const expected = `Subagent ${req.agentName}: using ${formatRoutedModel(req.provider, req.model)}.`;
      return line.includes(expected);
    });
    const needed = req.role === "executor"
      ? Math.max(1, req.count ?? state.executorOutputs.length)
      : req.role === "planner"
        ? Math.max(1, req.count ?? params.plannerCount)
        : req.role === "verifier"
          ? Math.max(1, req.count ?? params.verifierCount)
          : 1;
    if (matches.length < needed) {
      reasons.push(`${req.role} expected ${needed} spawn evidence item(s) for ${req.agentName} using ${formatRoutedModel(req.provider, req.model)}, found ${matches.length}.`);
    }
  }
  return { status: reasons.length ? "fail" : "pass", reasons };
}

// ── Implementation task detection ─────────────────────────────────────────

/**
 * Returns true if the task description indicates an implementation task
 * (one that should produce file artifacts via write/edit/bash tools).
 */
function isImplementationTask(description: string): boolean {
  return /\b(CREATE|IMPLEMENT|BUILD|MODIFY|ADD|WRITE|GENERATE|EDIT|CHANGE)\b/i.test(description);
}

// ── Post-execution artifact evidence ──────────────────────────────────────

/**
 * Collects structured post-execution artifact evidence.
 *
 * - Runs `git status --short` to detect modified and untracked files.
 * - Falls back to executor output file claims if git is unavailable.
 * - Returns structured ArtifactEvidence with hard-gate failures for
 *   implementation tasks that produced no detectable file artifacts.
 */
function collectArtifactEvidence(
  cwd: string,
  executorOutputs: ExecutorOutput[],
): ArtifactEvidence {
  const summaryLines: string[] = [];
  const hardGateFailures: string[] = [];
  let gitAvailable = false;
  let diskStatus = "";
  const diskFiles: string[] = [];

  // Attempt git status --short to detect modified + untracked files
  try {
    const gitResult = spawnSync("git", ["-C", cwd, "status", "--short"], {
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (gitResult.status === 0) {
      gitAvailable = true;
      const statusLines = (gitResult.stdout ?? "").trim().split("\n").filter(Boolean);
      if (statusLines.length > 0) {
        diskStatus = statusLines.join("\n");
        for (const line of statusLines) {
          const file = line.slice(3).trim();
          if (file && !diskFiles.includes(file)) diskFiles.push(file);
        }
        summaryLines.push("git status --short (modified/untracked files):");
        summaryLines.push(diskStatus);
      } else {
        diskStatus = "(working tree clean — no modified or untracked files)";
        summaryLines.push("git status --short: " + diskStatus);
      }
    } else if (gitResult.status === 128) {
      // exit code 128 = not a git repo
      diskStatus = "(not a git repository)";
      summaryLines.push("git status --short: not a git repository (exit code 128)");
    } else {
      diskStatus = "(git returned status " + gitResult.status + ")";
      summaryLines.push("git status --short: command returned status " + gitResult.status);
    }
  } catch (_err) {
    diskStatus = "(git not available or command failed)";
    summaryLines.push("git status: git not available or command failed");
  }

  // Extract file-artifact claims from executor output text
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
  if (fileClaims.length) {
    summaryLines.push("Files mentioned in executor outputs: " + fileClaims.join(", "));
  }

  // ── Per-task effect telemetry (F1): tool calls + worktree deltas ───────
  summaryLines.push("Per-task effect evidence (mechanical ground truth):");
  for (const output of executorOutputs) {
    const delta = output.filesChanged === undefined
      ? "worktree delta unknown"
      : `${output.filesChanged} file(s) changed${output.changedFiles?.length ? ` (${output.changedFiles.join(", ")})` : ""}`;
    summaryLines.push(`- ${output.taskId}: tool calls ${formatToolCallSummary(output.toolCalls)}; ${delta}${output.reusedFromAttempt ? `; reused from attempt ${output.reusedFromAttempt}` : ""}`);
  }

  // Determine implementation tasks
  const hasImplementationTask = executorOutputs.some((output) => isImplementationTask(output.description));

  // NOTE (F1 hardening): this collector no longer produces verdict-determining
  // hard-gate failures. Zero-effect findings for implementation tasks are
  // computed by the judgment layer (buildZeroEffectFindings) from tool-call
  // telemetry + per-task worktree deltas, and applied per the hardGates mode.
  if (hasImplementationTask) {
    const hasGitChanges = gitAvailable && /\S/.test(diskStatus) && !/\(working tree clean\)/.test(diskStatus) && !/\(not a git repository\)/.test(diskStatus);
    if (!hasGitChanges && fileClaims.length > 0) {
      summaryLines.push("CAUTION: Implementation task(s) detected with file claims in text but no git changes on disk.");
    }
  }

  return {
    summary: summaryLines.length ? summaryLines.join("\n") : "No artifact evidence collected.",
    hasImplementationTask,
    diskStatus,
    diskFiles,
    fileClaims,
    hardGateFailures,
    gitAvailable,
  };
}

/**
 * Wrap the legacy reply-text quality scan as TEXT-SHAPE findings (F1).
 * Every finding from this scanner is heuristic and is therefore demoted by
 * the judgment layer: warnings in "advisory"/"off" modes, and verdict-eligible
 * only in "strict" mode for tasks WITHOUT positive effect evidence.
 */
function detectExecutorOutputQualityFindings(
  executorOutputs: ExecutorOutput[],
  artifactEvidence?: ArtifactEvidence,
): GateFinding[] {
  return detectExecutorOutputQualityFailures(executorOutputs, artifactEvidence).map((message) => {
    const match = message.match(/^([^\s:]+):\s/);
    const taskId = match && executorOutputs.some((output) => output.taskId === match[1]) ? match[1] : undefined;
    const finding: GateFinding = { message, kind: "text-shape" };
    if (taskId) finding.taskId = taskId;
    return finding;
  });
}

// ── Executor output quality detection ─────────────────────────────────────

/**
 * Detect truncation signals and text-only responses in executor outputs.
 * Returns an array of failure reason strings. Empty array = no issues.
 */
function detectExecutorOutputQualityFailures(
  executorOutputs: ExecutorOutput[],
  artifactEvidence?: ArtifactEvidence,
): string[] {
  const failures: string[] = [];
  for (const output of executorOutputs) {
    const trimmed = output.output.trim();

    // Empty output
    if (!trimmed) {
      failures.push(output.taskId + ": empty executor output (possible crash or truncation before any text)");
      output.truncated = true;
      output.contextExhaustionSignal = true;
      continue;
    }

    // Truncation signals in output text
    const truncationSignals: RegExp[] = [
      /\b(?:truncated|cut off|too long|exceeded)\b/i,
      /\.\.\.\s*$/m,
      /(?:content|output|response)\s+(?:has been|was)\s+truncated/i,
    ];
    let hasTruncationSignal = false;
    for (const signal of truncationSignals) {
      if (signal.test(trimmed)) {
        failures.push(output.taskId + ": truncation signal detected");
        output.truncated = true;
        output.contextExhaustionSignal = true;
        hasTruncationSignal = true;
        break;
      }
    }
    if (hasTruncationSignal) continue;

    // Truncation: output ends mid-sentence without terminal punctuation
    const lastLine = trimmed.split("\n").filter(Boolean).pop() ?? "";
    const lastChar = lastLine.trim().slice(-1);
    const endsProperly = /[.!?})\\>\`"]$/.test(lastChar) || /\x60\x60\x60$/.test(lastLine.trim());
    if (!endsProperly && trimmed.length > 200) {
      const endSnippet = lastLine.trim().slice(-80);
      failures.push(output.taskId + ": possible truncation");
      output.truncated = true;
    }

    // Incomplete JSON
    const openBraces = (trimmed.match(/\{/g) ?? []).length;
    const closeBraces = (trimmed.match(/\}/g) ?? []).length;
    if (openBraces > closeBraces) {
      failures.push(output.taskId + ": possible incomplete JSON");
      output.truncated = true;
    }

    // Unclosed JSON code fences
    const jsonFenceCount = (trimmed.match(/```json/g) ?? []).length;
    const closeFenceCount = (trimmed.match(/```/g) ?? []).length;
    if (jsonFenceCount > 0 && closeFenceCount < jsonFenceCount * 2) {
      failures.push(output.taskId + ": unclosed JSON code fence");
      output.truncated = true;
    }

    // Text-only response for implementation task
    if (isImplementationTask(output.description)) {
      const hasToolEvidence =
        /\b(?:write|edit|bash|spawn|read|\btool)/i.test(trimmed) ||
        /\<invoke name="/.test(trimmed) ||
        /\b(?:created?|wrote?|modified?|edited?|updated?|changed?|added?|generated?|ran?)\s+(?:file|the\s+)?\s*[`"\']?[^\s`"\',;]+[.][a-z]{1,6}/i.test(trimmed);
      if (!hasToolEvidence) {
        failures.push(output.taskId + ": text-only response for implementation task");
      }
      const minImplWords = 30;
      if (trimmed.split(/\s+/).length < minImplWords) {
        failures.push(output.taskId + ": implementation task returned suspiciously short output");
        output.truncated = true;
      }
    }

    // Internal consistency checks
    if (output.exitCode !== null && output.exitCode !== 0) {
      const passedPattern = /\b(?:all tests passed|tests pass|everything (?:is )?ok|no failures|success(?:fully)?)\b/i;
      if (passedPattern.test(trimmed)) {
        failures.push(output.taskId + ": internal inconsistency");
      }
    }
  }

  // File-claim verification via git ground truth
  if (artifactEvidence && artifactEvidence.fileClaims.length > 0) {
    const diskFilesArr: string[] = artifactEvidence.diskFiles ?? [];
    const diskFilesLower = diskFilesArr.map(function(f: string) { return f.toLowerCase(); });
    const isGitAvailable = artifactEvidence.diskStatus.length > 0 &&
      !artifactEvidence.diskStatus.startsWith("(git not available");

    if (isGitAvailable && diskFilesArr.length > 0) {
      const unverifiedClaims: string[] = [];
      for (const claim of artifactEvidence.fileClaims) {
        const normalized = claim.replace(/^[`"\']+|[`"\']+$/g, "").replace(/\\/g, "/");
        const isOnDisk = diskFilesLower.some(function(diskFile: string) {
          return diskFile === normalized.toLowerCase() ||
            diskFile.endsWith("/" + normalized.toLowerCase()) ||
            normalized.toLowerCase().endsWith("/" + diskFile);
        });
        if (!isOnDisk) unverifiedClaims.push(claim);
      }
      if (unverifiedClaims.length > 0) {
        failures.push("FILE-CLAIM VERIFICATION FAILURE: " + unverifiedClaims.length + " file claim(s) not found in git ground truth");
      }
    } else if (!isGitAvailable && artifactEvidence.fileClaims.length > 0) {
      const implausibleClaims = artifactEvidence.fileClaims.filter(function(claim: string) {
        const normalized = claim.replace(/^[`"\']+|[`"\']+$/g, "");
        return !/^[a-zA-Z0-9_./\\-]+$/.test(normalized) || normalized.includes("..");
      });
      if (implausibleClaims.length > 0) {
        failures.push("FILE-CLAIM VERIFICATION WARNING: " + implausibleClaims.length + " implausible file claim(s)");
      }
    }
  }

  // Cross-output consistency
  if (executorOutputs.length > 1) {
    const fileClaimMap = new Map<string, string[]>();
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
        failures.push("CROSS-OUTPUT CONSISTENCY: file " + file + " claimed by multiple tasks");
      }
    }
  }

  return failures;
}

function extractFileArtifactClaimsFromText(text: string): string[] {
  const claims: string[] = [];
  const patterns: RegExp[] = [
    /\b(?:created?|wrote?|added?|modified?|edited?|updated?|changed?|generated?)\s+(?:file|the\s+)?\s*[`"\']?([^\s`"\',;]+[.][a-z]{1,8})[`"\']?/gi,
    /\b(?:touched?|changed?)\s+(?:files?\s+)?[`"\']?([^\s`"\',;]+[.][a-z]{1,8})[`"\']?/gi,
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

// ── Task-size enforcement ─────────────────────────────────────────────────

/**
 * Splits >maxWords task descriptions into <=180-word chained subtasks
 * and remaps dependencies. Returns a new plan (or the same plan if all
 * tasks are within the cap).
 */
function enforceTaskSizeCap(plan: Plan, maxWords: number = 200): Plan {
  const TARGET_WORDS = 180; // subtasks capped at 180 words
  const needsSplit = plan.tasks.some((task) => wordCount(task.description) > maxWords);
  if (!needsSplit) return plan;

  const newTasks: PlanTask[] = [];
  const taskIdMap = new Map<string, string>(); // original id -> final id of first subtask
  let suffixCounter = 0;

  for (const task of plan.tasks) {
    const words = wordCount(task.description);
    if (words <= maxWords) {
      newTasks.push({ ...task });
      taskIdMap.set(task.id, task.id);
      continue;
    }

    // Split long description into sentences, then group into <=180-word chunks
    const sentences = splitIntoStatements(task.description);
    const chunks: string[] = [];
    let currentChunk = "";
    for (const sentence of sentences) {
      const candidate = currentChunk ? `${currentChunk} ${sentence}` : sentence;
      if (wordCount(candidate) <= TARGET_WORDS) {
        currentChunk = candidate;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        // If a single sentence exceeds TARGET_WORDS, split by word count
        if (wordCount(sentence) > TARGET_WORDS) {
          const sentenceWords = sentence.split(/\s+/);
          for (let i = 0; i < sentenceWords.length; i += TARGET_WORDS) {
            chunks.push(sentenceWords.slice(i, i + TARGET_WORDS).join(" "));
          }
          currentChunk = "";
        } else {
          currentChunk = sentence;
        }
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    if (chunks.length === 0) {
      // Fallback: force-split by word count
      const descWords = task.description.split(/\s+/);
      for (let i = 0; i < descWords.length; i += TARGET_WORDS) {
        chunks.push(descWords.slice(i, i + TARGET_WORDS).join(" "));
      }
    }

    // Create subtasks, chained by dependencies
    const subtaskIds: string[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      suffixCounter++;
      const subtaskId = `${task.id}-s${suffixCounter}`;
      subtaskIds.push(subtaskId);
      const prefix = chunks.length > 1 ? `[Part ${ci + 1}/${chunks.length} of ${task.id}] ` : "";
      const dependsOn: string[] = ci === 0 ? [...task.dependsOn] : [subtaskIds[ci - 1]];
      newTasks.push({
        id: subtaskId,
        description: prefix + chunks[ci],
        dependsOn,
      });
    }
    // Map original id to first subtask for downstream dependency remapping
    if (subtaskIds.length > 0) {
      taskIdMap.set(task.id, subtaskIds[0]);
    }
  }

  // Remap downstream dependencies: any task that depended on a split task
  // should now depend on the LAST subtask of the chain.
  // But if a task depended on the same split task, remap to the LAST subtask.
  // Actually, since subtasks are chained internally, depending on the first
  // subtask transitively satisfies the dependency. We map to the first subtask
  // for simplicity.
  for (const newTask of newTasks) {
    newTask.dependsOn = newTask.dependsOn.map((depId) => taskIdMap.get(depId) ?? depId);
  }

  return {
    ...plan,
    tasks: newTasks,
    notes: plan.notes
      ? `${plan.notes}\n[Task-size cap applied: split tasks >${maxWords} words into <=${TARGET_WORDS}-word subtasks.]`
      : `[Task-size cap applied: split tasks >${maxWords} words into <=${TARGET_WORDS}-word subtasks.]`,
    raw: plan.raw,
  };
}

/** Count words in a string, normalizing whitespace. */
function wordCount(text: string): number {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
}

/** Split a description into reasonable statement boundaries. */
function splitIntoStatements(text: string): string[] {
  const decimalPlaceholder = "__PI_DECIMAL_DOT__";
  return text
    .replace(/(\d)\.(\d)/g, `$1${decimalPlaceholder}$2`)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.replaceAll(decimalPlaceholder, ".").trim())
    .filter(Boolean);
}

function inferModelRoutingFromTask(task: string): InferredModelRouting {
  const inferred: InferredModelRouting = {};

  // Associate each model mention with the nearest local routing clause. This avoids
  // applying the first model in a sentence to every role when the user writes e.g.
  // "use GPT for planning, use DeepSeek Pro for execution, use DeepSeek Flash for verification".
  for (const sentence of splitRoutingSentences(task)) {
    const aliases = findModelAliases(sentence);
    for (const alias of aliases) {
      const model = { provider: alias.provider, model: alias.model };
      const localClause = localRoutingClauseForAlias(sentence, alias.index);
      let roles = routingRolesInText(localClause);
      let runtimeRoles = runtimeRoutingRolesInText(localClause);
      if (roles.length === 0 && runtimeRoles.length === 0) {
        const broaderText = surroundingText(sentence, alias.index, 80);
        const broaderRoles = routingRolesInText(broaderText);
        const broaderRuntimeRoles = runtimeRoutingRolesInText(broaderText);
        if (broaderRoles.length + broaderRuntimeRoles.length === 1) {
          roles = broaderRoles;
          runtimeRoles = broaderRuntimeRoles;
        }
      }
      applyRoutingAlias(inferred, roles, model);
      applyRuntimeRoutingAlias(inferred, runtimeRoles, model);
    }
  }

  // Generic/custom model parsing is intentionally conservative: only infer from a
  // sentence with exactly one role so multi-role sentences cannot cross-contaminate.
  for (const sentence of splitRoutingSentences(task)) {
    const alias = genericModelFromRoutingSentence(sentence);
    if (!alias) continue;
    const roles = routingRolesInText(sentence);
    const runtimeRoles = runtimeRoutingRolesInText(sentence);
    if (roles.length + runtimeRoles.length === 1) {
      applyRoutingAlias(inferred, roles, alias);
      applyRuntimeRoutingAlias(inferred, runtimeRoles, alias);
    }
  }

  return inferred;
}

function applyRoutingAlias(inferred: InferredModelRouting, roles: RoutingRequirement["role"][], alias: RoleModelOverride): void {
  for (const role of roles) {
    // Last-write-wins: later (more specific) role-model clauses override earlier ones.
    // This correctly handles "use X for planning, use Y for execution and Z for verification"
    // where Z's local clause may also capture earlier roles if no comma separates them.
    if (role === "planner") inferred.planner = alias;
    if (role === "executor") inferred.executor = alias;
    if (role === "verifier") inferred.verifier = alias;
  }
}

function localRoutingClauseForAlias(text: string, aliasIndex: number): string {
  const before = text.slice(0, aliasIndex);
  const after = text.slice(aliasIndex);
  const separatorsBefore = [before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf("\n"), before.lastIndexOf("!"), before.lastIndexOf("?")];
  const start = Math.max(...separatorsBefore) + 1;
  const separatorAfter = after.search(/[,;\n!?]/);
  const end = separatorAfter >= 0 ? aliasIndex + separatorAfter : text.length;
  return text.slice(start, end).trim();
}

function routingRolesInText(text: string): RoutingRequirement["role"][] {
  const roleText = normalizeRoutingText(text);
  const roles: RoutingRequirement["role"][] = [];
  if (/\b(plan|planner|planning)\b/.test(roleText)) roles.push("planner");
  if (/\b(executor|executors|execute|execution|coder|coders|subagent|sub-agent|subagents|sub-agent tasks|worker|workers)\b/.test(roleText)) roles.push("executor");
  if (/\b(verifier|verify|verification|reviewer|review)\b/.test(roleText)) roles.push("verifier");
  return roles;
}

function runtimeRoutingRolesInText(text: string): string[] {
  const roleText = normalizeRoutingText(text);
  const roles: string[] = [];
  if (/\b(research|researcher|researchers|investigator|investigators)\b/.test(roleText)) {
    roles.push("researcher");
  }
  if (/\b(hypothesizer|hypothesizers)\b/.test(roleText)) roles.push("hypothesizer");
  if (/\b(critic|critics)\b/.test(roleText)) roles.push("critic");
  if (/\b(synthesizer|synthesizers)\b/.test(roleText)) roles.push("synthesizer");
  return roles;
}

function applyRuntimeRoutingAlias(inferred: InferredModelRouting, runtimeRoles: string[], alias: RoleModelOverride): void {
  if (runtimeRoles.length === 0) return;
  inferred.runtimeRoles ??= {};
  for (const role of runtimeRoles) {
    if (!inferred.runtimeRoles[role]) inferred.runtimeRoles[role] = alias;
  }
}

function splitRoutingSentences(text: string): string[] {
  const decimalPlaceholder = "__PI_DECIMAL_DOT__";
  return text
    .replace(/(\d)\.(\d)/g, `$1${decimalPlaceholder}$2`)
    .split(/[.;\n]+/)
    .map((part) => part.replaceAll(decimalPlaceholder, ".").trim())
    .filter(Boolean);
}

// NOTE: `normalizeRoutingText` and `modelAliasFromText` were moved VERBATIM to
// src/model-aliases.ts (WAVE3-SPEC ITEM C) to break the composable-pipeline ->
// index.ts circular import. They are imported at the top of this file and
// remain the single source of truth for the known-models alias registry.

function genericModelFromRoutingSentence(sentence: string): RoleModelOverride | undefined {
  if (!/\b(use|uses|using|route|root|assign|assigned|model|provider)\b/i.test(sentence)) return undefined;
  let candidate = "";
  const patterns = [
    /\b(?:use|uses|using|assign|assigned)\s+(?:the\s+)?(?:model\s+)?(.+?)\s+for\s+(?:planning|planner|plan|execution|executor|executors|coder|subagent|subagents|verification|verifier|reviewer|review)\b/i,
    /\b(?:route|root)\s+(?:the\s+)?(?:planner|planning|plan|executor|executors|execution|coder|subagent|subagents|verifier|verification|reviewer|review)\s+(?:to|through|via|with)\s+(.+)$/i,
    /\b(?:planner|planning|plan|executor|executors|execution|coder|subagent|subagents|verifier|verification|reviewer|review)(?:\s+model)?\s*(?:should\s+)?(?:use|uses|using|be|is|:|=)\s+(.+)$/i,
    /\b(?:planner|planning|plan|executor|executors|execution|coder|subagent|subagents|verifier|verification|reviewer|review).*?\b(?:use|uses|using|model)\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = sentence.match(pattern);
    if (match?.[1]) {
      candidate = match[1];
      break;
    }
  }
  if (!candidate) return undefined;
  return parseModelCandidate(candidate);
}

/**
 * Resolve a structured NL model token ("provider <P> model <T>" / "<P>/<T>")
 * against the known-models alias registry. Returns the canonical alias when the
 * model side (or "<provider> <model>") is recognized, else undefined — so
 * unknown tokens from task prose can never become a route (residual 1).
 */
function knownAliasForStructured(provider: string, model: string): RoleModelOverride | undefined {
  return modelAliasFromText(model) ?? modelAliasFromText(`${provider} ${model}`);
}

function parseModelCandidate(candidate: string): RoleModelOverride | undefined {
  let cleaned = candidate
    .replace(/["'`]/g, "")
    .replace(/\bfor\s+(?:planning|planner|plan|execution|executor|executors|coder|subagent|subagents|verification|verifier|reviewer|review)\b.*$/i, "")
    .replace(/\b(?:for|as)\s+(?:the\s+)?(?:model|llm)\b.*$/i, "")
    .replace(/\b(?:model|llm)\b\s*$/i, "")
    .replace(/^\s*(?:the|a|an|model|llm)\s+/i, "")
    .trim();
  cleaned = cleaned.replace(/[,:]+$/g, "").trim();
  const known = modelAliasFromText(cleaned);
  if (known) return known;
  // BUG FIX (2026-07-02 residual 1): the structured "provider <P> model <T>" and
  // "<P>/<T>" forms used to be routed WITHOUT validating the model token against
  // the known-models registry, so ordinary prose ("provider anthropic model today",
  // greedy tails like "today produces NO route change") hijacked a role route.
  // Every structured form must now resolve its model side via modelAliasFromText
  // before it can become a route; unknown tokens are ignored with a logged notice.
  const providerModel = cleaned.match(/^provider\s+([a-z0-9_.-]+)\s+(?:model\s+)?(.+)$/i);
  if (providerModel) {
    const alias = knownAliasForStructured(providerModel[1].trim(), providerModel[2].trim());
    if (alias) return alias;
    noteRejectedNlRouteToken(cleaned);
    return undefined;
  }
  if (!cleaned || cleaned.split(/\s+/).length > 8) return undefined;
  if (!/[a-z0-9]/i.test(cleaned)) return undefined;
  // Structured explicit "provider/model" form: route only when the model side
  // validates against the known-models registry (residual 1).
  const slash = cleaned.indexOf("/");
  if (slash > 0) {
    const provider = cleaned.slice(0, slash).trim();
    const model = cleaned.slice(slash + 1).trim();
    if (provider && model) {
      const alias = knownAliasForStructured(provider, model);
      if (alias) return alias;
      noteRejectedNlRouteToken(cleaned);
      return undefined;
    }
  }
  // BUG FIX (2026-07-02, natural-language-route-parser-hijacks-roles-from-task-prose.md):
  // A bare single token extracted from task prose (e.g. "today", "tomorrow") is
  // NOT a model. Only route it if it validates against the known-models
  // registry (modelAliasFromText / structured provider forms above). Unknown
  // tokens are ignored with a logged notice — never routed — so ordinary prose
  // can no longer hijack a role route (production evidence: run orc-mr43a2em-dvzs,
  // planner routed to anthropic/today → preflight 404).
  noteRejectedNlRouteToken(cleaned);
  return undefined;
}

/** Log a notice that an unroutable natural-language model token was ignored. */
function noteRejectedNlRouteToken(token: string): void {
  if (!token) return;
  try {
    console.warn(`[orchestrate] Ignored unroutable natural-language model token "${token}" (not in known-models registry).`);
  } catch {}
}

function findModelAliases(task: string): Array<{ index: number; provider: string; model: string }> {
  const normalized = task
    .replace(/deep[\s-]*seek|deepseak/gi, "deepseek")
    .replace(/codecs/gi, "codex");
  const aliases: Array<{ index: number; provider: string; model: string }> = [];
  const addMatches = (regex: RegExp, provider: string, model: string) => {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(normalized))) aliases.push({ index: match.index, provider, model });
  };
  addMatches(/\b(?:openai[-\s]*)?codex\b.{0,30}\b(?:gpt|pt)[-\s]*5(?:\.5)?\b|\b(?:gpt|pt)[-\s]*5(?:\.5)?\b.{0,30}\b(?:openai[-\s]*)?codex\b|\b(?:gpt|pt)[-\s]*5\.5\b/gi, "openai-codex", "gpt-5.5");
  addMatches(/\b(?:gpt|pt)[-\s]*5(?:\.5)?\b.{0,20}\bfast\b|\bfast\b.{0,20}\b(?:gpt|pt)[-\s]*5(?:\.5)?\b/gi, "openai-codex", "gpt-5.5-fast");
  addMatches(/\bdeepseek\b[^,;\n!?]{0,40}\bv?4\b[^,;\n!?]{0,20}\bpro\b|\bv?4\b[^,;\n!?]{0,20}\bpro\b[^,;\n!?]{0,40}\bdeepseek\b/gi, "deepseek", "deepseek-v4-pro");
  addMatches(/\bdeepseek\b[^,;\n!?]{0,40}\bv?4\b[^,;\n!?]{0,20}\bflash\b|\bv?4\b[^,;\n!?]{0,20}\bflash\b[^,;\n!?]{0,40}\bdeepseek\b/gi, "deepseek", "deepseek-v4-flash");
  // Anthropic model aliases — prompt-based routing flexibility.
  addMatches(/\bopus\b.{0,20}\b4\.?8\b|\b4\.?8\b.{0,20}\bopus\b|\bclaude\b.{0,20}\bopus\b/gi, "anthropic", "claude-opus-4-20250514");
  addMatches(/\bsonnet\b/gi, "anthropic", "claude-sonnet-4-20250514");
  addMatches(/\bhaiku\b/gi, "anthropic", "claude-3-5-haiku-20241022");
  addMatches(/\bfable\b/gi, "anthropic", "fable");
  return aliases.sort((a, b) => a.index - b.index);
}

function surroundingText(text: string, index: number, radius: number): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

function surroundingClause(text: string, index: number): string {
  const before = text.slice(0, index);
  const after = text.slice(index);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf(";"), before.lastIndexOf("\n"), before.lastIndexOf("!"), before.lastIndexOf("?")) + 1;
  const endCandidates = [after.indexOf("."), after.indexOf(";"), after.indexOf("\n"), after.indexOf("!"), after.indexOf("?")]
    .filter((value) => value >= 0)
    .map((value) => index + value);
  const end = endCandidates.length ? Math.min(...endCandidates) : text.length;
  return text.slice(start, end).trim();
}

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
    [/do not run commands? unless absolutely necessary/i, "Do not run commands unless absolutely necessary."],
    [/keep every response (?:very )?short|minimal/i, "Keep responses minimal."],
    [/exactly one (?:plain-text )?line/i, "Executor outputs must be exactly one plain-text line when requested."],
    [/no markdown/i, "No Markdown in constrained executor outputs."],
    [/no bold/i, "No bold formatting in constrained executor outputs."],
    [/no bullets/i, "No bullets in constrained executor outputs."],
    [/no explanations/i, "No explanations in constrained executor outputs."],
    [/no headings/i, "No headings in constrained executor outputs."],
    [/no separator lines/i, "No separator lines in constrained executor outputs."],
  ] as Array<[RegExp, string]>;
  for (const [regex, text] of patterns) if (regex.test(task) && !constraints.includes(text)) constraints.push(text);
  return constraints.length ? constraints : ["Preserve all explicit instructions in the original task."];
}

function extractSuccessCriteria(task: string): string[] {
  const criteria: string[] = [];
  const exactResults = task.match(/RESULT\s+task-\d+\s*:\s*[^\n\r]+/gi) ?? [];
  for (const result of exactResults) criteria.push(`Executor output includes exact line: ${result.trim()}`);
  if (/dependsOn\s*:\s*\[\]/i.test(task) || /independent executor tasks/i.test(task)) criteria.push("Planner creates independent executor tasks with dependsOn: [].");
  if (/pass only if/i.test(task)) criteria.push("Verifier follows the explicit PASS-only-if criteria from the original task.");
  return [...new Set(criteria)];
}

function extractFailureCriteria(task: string): string[] {
  const criteria: string[] = [];
  if (/no markdown|no bold|no bullets|no headings|no separator/i.test(task)) criteria.push("Markdown, bold, bullets, headings, separator lines, or extra sections violate strict executor output requirements.");
  if (/exactly one/i.test(task)) criteria.push("More than one executor output line violates strict output requirements.");
  return criteria;
}

function extractNonGoals(task: string): string[] {
  const nonGoals: string[] = [];
  if (/do not edit files?/i.test(task)) nonGoals.push("File modification is out of scope.");
  if (/do not run commands?/i.test(task)) nonGoals.push("Command execution is out of scope unless explicitly allowed by the task.");
  return nonGoals;
}

function extractExecutorOutputContract(task: string): { contract: string; source: "explicit" | "inferred" } | undefined {
  if (!/RESULT\s+task-N|RESULT\s+task-\d+|exactly one/i.test(task)) return undefined;
  const rules: string[] = [];
  if (/exactly one (?:plain-text )?line/i.test(task) || /one short line/i.test(task)) rules.push("Each executor must output exactly one plain-text line and nothing else.");
  if (/format must be exactly/i.test(task)) rules.push("Use the exact requested RESULT task-N format.");
  if (/no markdown/i.test(task)) rules.push("No Markdown.");
  if (/no bold/i.test(task)) rules.push("No bold formatting.");
  if (/no bullets/i.test(task)) rules.push("No bullets.");
  if (/no explanations/i.test(task)) rules.push("No explanations.");
  if (/no headings/i.test(task)) rules.push("No headings.");
  if (/no separator lines/i.test(task)) rules.push("No separator lines.");
  if (/files touched|commands run|remaining issues/i.test(task)) rules.push("Do not include files touched, commands run, remaining issues, or other report sections unless explicitly required as the single answer line.");
  // F6: only literal markers yield an explicit (verdict-determining) contract.
  // The generic fallback is synthesized — mark it inferred so it can warn but
  // never fail.
  return rules.length
    ? { contract: rules.join(" "), source: "explicit" }
    : { contract: "Each executor must follow the explicit output format in the original task.", source: "inferred" };
}

function buildPlanningPrompt(intake: Intake, attempt: number, failureReasons: string[], completedTasks: TaskLedgerEntry[] = [], contractWriteSet?: string[]): string {
  const retryBlock = failureReasons.length
    ? `\nPrevious verifier failure reasons to address deterministically:\n${failureReasons.map((reason) => `- ${reason}`).join("\n")}\n`
    : "";
  const contractWriteSetBlock = contractWriteSet?.length
    ? `\nCONTRACTED WRITE SET (hard scope granted by the caller — deterministic enforcement):\n${contractWriteSet.map((entry) => `- ${entry}`).join("\n")}\nEvery file your tasks create or modify MUST fall within this set; any out-of-set mutation is an automatic deterministic FAIL naming the file. If required work falls outside it, do NOT plan that mutation — name the file and the reason in "notes" so the caller can widen the authorization first.\n`
    : "";
  // F2: completed tasks from prior attempts must NOT be re-created. The
  // orchestrator reuses their outputs and routes them to re-verification.
  const completedBlock = completedTasks.length
    ? `\nTasks ALREADY COMPLETED successfully in a previous attempt (their artifacts exist on disk). Keep their IDs stable, do NOT instruct executors to re-create or re-do their work, and plan only the remaining/failed work. The orchestrator will reuse their results automatically:\n${completedTasks.map((entry) => `- ${entry.taskId}: ${entry.description}`).join("\n")}\n`
    : "";
  return `Plan the following task for executor subagents. Return JSON if possible, exactly shaped as:\n{"tasks":[{"id":"...","description":"...","dependsOn":[]}],"notes":"..."}\n\nINTAKE CONTRACT:\n${formatIntakeForPrompt(intake)}\n\nRules:\n- Keep task IDs stable and simple (task-1, task-2, ...).\n- Make each description self-contained.\n- Do not execute the task.\n- Carry forward all intake constraints, invariants, success criteria, failure criteria, and executor output contract into the task descriptions/notes.\n- If model routing requirements exist in intake, treat them as essential orchestrator constraints, not executor work.\n- If the task cannot be safely split, return one task.\n- **Task-size cap**: each executor task description MUST be under ~200 words. Tasks exceeding this should be split into multiple smaller tasks. Small tasks ensure executor subagents have enough context budget to use write/edit/bash tools and produce actual file artifacts rather than text reports.\n- An executor task that only describes/analyzes and never touches files is NOT sufficient for CREATE or IMPLEMENT work — the verifier will check for actual file artifacts.\n- **Predicted write set (predict-then-write)**: if the tasks will create or modify ANY files, include "predicted_write_set": ["repo/relative/path", ...] in the plan JSON — the exact files (or narrow "dir/" prefixes) the tasks will touch. This list becomes the executors' write scope and is enforced mechanically after execution: any mutation outside it fails the attempt naming the file. Predict precisely; do not pad with directories you merely might touch.\n${contractWriteSetBlock}\nAttempt: ${attempt}${completedBlock}${retryBlock}`;
}

function buildExecutorPrompt(intake: Intake, plan: Plan, task: PlanTask): string {
  const outputRule = intake.executorOutputContract
    ? `Executor output contract (highest priority):\n${intake.executorOutputContract}\n\nDo not add generic report sections. Do not add Markdown unless the contract explicitly requires it.`
    : "Return a concise report with changes/findings, files touched, commands/tests run, and remaining issues or uncertainty.";

  const MAX_INTAKE_PLAN_CHARS = 8000;

  let intakeText = promptMinification(intake);
  let planText = JSON.stringify(plan, null, 2);

  const combinedLen = intakeText.length + planText.length;
  if (combinedLen > MAX_INTAKE_PLAN_CHARS) {
    const intakeBudget = Math.max(1000, Math.floor(MAX_INTAKE_PLAN_CHARS * intakeText.length / combinedLen));
    const planBudget = MAX_INTAKE_PLAN_CHARS - intakeBudget;
    intakeText = truncateWithNotice(intakeText, intakeBudget, "intake contract");
    planText = truncateWithNotice(planText, planBudget, "plan JSON");
  }

  return `You are executing one task from a deterministic orchestration.\n\nIMPORTANT: If your task is to CREATE, IMPLEMENT, BUILD, or MODIFY code/files, you MUST use write/edit/bash tools to produce actual file artifacts. A text-only response that merely describes what you would do — without creating or modifying any files — is a FAILURE. Always produce concrete artifacts for implementation tasks.\n\nINTAKE CONTRACT:\n${intakeText}\n\nFull plan:\n${planText}\n\nAssigned executor task:\n${JSON.stringify(task, null, 2)}\n\nComplete only the assigned task. Use Pi tools only if needed and allowed by the intake constraints.\n${injectContinuationGuardrail(task.id)}\n\n${outputRule}`;
}

function buildVerificationPrompt(intake: Intake, plan: Plan, outputs: ExecutorOutput[], routingEvidence: string, artifactEvidence?: string): string {
  const artifactBlock = artifactEvidence
    ? `\n\nARTIFACT EVIDENCE (collected post-execution by orchestrator):\n${artifactEvidence}`
    : "";
  return `Verify the orchestration result against the intake contract.\n\nINTAKE CONTRACT:\n${formatIntakeForPrompt(intake)}\n\nPlan:\n${JSON.stringify(plan, null, 2)}\n\nExecutor outputs:\n${JSON.stringify(outputs, null, 2)}\n\nModel routing evidence/configuration supplied by orchestrator:\n${routingEvidence}${artifactBlock}\n\nReturn JSON exactly and only in this shape:\n{"status":"pass"|"fail","reasons":["..."]}\n\nUse status "pass" only if the plan, outputs, and supplied routing evidence/configuration satisfy the intake success criteria and do not violate any constraints, invariants, or failure criteria. Use "fail" with concrete reasons for missing, unclear, or incorrect work.\n\nEFFECT EVIDENCE RULE: The ARTIFACT EVIDENCE block (if present) contains mechanical ground truth — per-task tool-call telemetry (write/edit/bash executions) and worktree file deltas. Judge implementation work by these OBSERVED EFFECTS, not by the shape or length of the executor's reply text. An executor that performed real tool-based file mutations and answered with a brief summary (or a table) is VALID. Conversely, prose claiming files were created is INSUFFICIENT when the effect evidence shows zero mutations — treat that as FAIL with reason "no observed effects for implementation task".\n\nADVISORY CRITERIA RULE (F6): entries under inferred_advisory_criteria (and any criterion tagged source="inferred" in criteria_provenance) are advisory only — you may mention violations as warnings inside reasons, but they MUST NOT cause status "fail" on their own.`;
}

function selectPlannerOutputIndex(outputs: SubagentResult[], originalTask: string): number {
  for (const [index, output] of outputs.entries()) {
    const plan = parsePlan(output.text, originalTask);
    if (plan.tasks.length > 0) return index;
  }
  return 0;
}

function extractPlanRoleControls(plan: Plan): { executorConcurrency?: number; verifierCount?: number } {
  const raw = plan.raw && typeof plan.raw === "object" ? plan.raw as Record<string, unknown> : undefined;
  if (!raw) return {};
  const controls = raw.orchestrationControls && typeof raw.orchestrationControls === "object"
    ? raw.orchestrationControls as Record<string, unknown>
    : raw.controls && typeof raw.controls === "object"
      ? raw.controls as Record<string, unknown>
      : undefined;
  const readNumber = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
      if (typeof value === "string") {
        const parsed = parseNaturalNumber(value);
        if (parsed !== undefined) return parsed;
      }
    }
    return undefined;
  };
  return {
    executorConcurrency: readNumber(raw.executorConcurrency, raw.executorCount, controls?.executorConcurrency, controls?.executorCount),
    verifierCount: readNumber(raw.verifierCount, raw.verifiers, controls?.verifierCount, controls?.verifiers),
  };
}

function aggregateVerifierResults(
  results: Array<{ agentName: string; status: "pass" | "fail"; reasons: string[]; raw: string }>,
): { status: "pass" | "fail"; reasons: string[]; raw: string } {
  if (results.length === 0) {
    return { status: "fail", reasons: ["No verifier results were produced."], raw: "[]" };
  }
  const failures = results.filter((result) => result.status !== "pass");
  if (failures.length > 0) {
    return {
      status: "fail",
      reasons: failures.flatMap((result, index) => result.reasons.length ? result.reasons : [`verifier-${index + 1}: verifier returned FAIL without reasons`]),
      raw: JSON.stringify(results),
    };
  }
  return {
    status: "pass",
    reasons: results.flatMap((result, index) => result.reasons.length ? result.reasons : [`verifier-${index + 1}: pass`]),
    raw: JSON.stringify(results),
  };
}

function parsePlan(text: string, originalTask: string): Plan {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    if (Array.isArray(raw.tasks)) {
      const tasks = raw.tasks
        .map((item, index) => normalizePlanTask(item, index))
        .filter((task): task is PlanTask => Boolean(task));
      if (tasks.length > 0) {
        const predictedWriteSet = parseWriteSetInput(raw.predicted_write_set ?? raw.predictedWriteSet);
        return { tasks, notes: optionalString(raw.notes) ?? "", raw: parsed, predictedWriteSet };
      }
    }
  }

  const fallback = text.trim() || originalTask;
  return {
    tasks: [{ id: "task-1", description: fallback, dependsOn: [] }],
    notes: "Planner output was not parseable as plan JSON; fell back to one executor task containing the planner output.",
    raw: text,
  };
}

function normalizePlanTask(item: unknown, index: number): PlanTask | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const description = optionalString(raw.description)?.trim();
  if (!description) return null;
  const id = optionalString(raw.id)?.trim() || `task-${index + 1}`;
  return { id, description, dependsOn: stringArray(raw.dependsOn) ?? [] };
}

function parseVerifierResult(text: string): { status: "pass" | "fail"; reasons: string[]; raw: string } {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    const status = String(raw.status ?? "").toLowerCase();
    if (status === "pass" || status === "fail") {
      return { status, reasons: stringArray(raw.reasons) ?? [], raw: text };
    }
  }
  return { status: "fail", reasons: ["Verifier output was not parseable as the required JSON."], raw: text };
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

function buildExecutionWaves(plan: Plan): PlanTask[][] {
  const taskById = new Map<string, PlanTask>();
  for (const [index, task] of plan.tasks.entries()) {
    if (!task.id.trim()) throw new Error(`Plan task at index ${index} has an empty id.`);
    if (taskById.has(task.id)) throw new Error(`Plan contains duplicate task id: ${task.id}`);
    taskById.set(task.id, task);
  }

  for (const task of plan.tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!taskById.has(dependencyId)) {
        throw new Error(`Plan task ${task.id} depends on unknown task id: ${dependencyId}`);
      }
    }
  }

  const completed = new Set<string>();
  const remaining = new Map(plan.tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const waves: PlanTask[][] = [];

  while (remaining.size > 0) {
    const readyIds = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((dependencyId) => completed.has(dependencyId)))
      .map(([id]) => id);

    if (readyIds.length === 0) {
      throw new Error(`Plan dependency cycle detected among task ids: ${[...remaining.keys()].join(", ")}`);
    }

    const wave = readyIds.map((id) => taskById.get(id)!);
    waves.push(wave);
    for (const id of readyIds) {
      remaining.delete(id);
      completed.add(id);
    }
  }

  return waves;
}

async function runExecutorTasksInWaves(
  waves: PlanTask[][],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: PlanTask, index: number, signal: AbortSignal) => Promise<ExecutorOutput>,
): Promise<ExecutorOutput[]> {
  const outputs: ExecutorOutput[] = [];
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

async function runBoundedPool<T, R>(
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

function firstPevTerminalNoRetry(resumeState?: LoadedRunState): TerminalNoRetryState | undefined {
  return [...(resumeState?.terminalStates.values() ?? [])]
    .sort((a, b) => a.phaseIndex - b.phaseIndex)
    .find((state) =>
      state.code === "WRITE_SET_VIOLATION" ||
      state.code === "WRITE_SET_UNOBSERVABLE" ||
      state.code === "AMBIGUOUS_COMPLETION" ||
      state.code === "RESULT_LOST_AFTER_MUTATION");
}

function attemptFromTerminalPhase(terminalState: TerminalNoRetryState): number | undefined {
  const match = terminalState.phaseName.match(/attempt-(\d+)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatPevWriteSetObservation(evaluation: WriteSetObservationEvaluation): string {
  const parts = [
    `${evaluation.observed.length} observed mutation(s)`,
    `${evaluation.violations.length} violation(s)`,
    `${evaluation.unobservableScopes.length} unobservable scope(s)`,
  ];
  if (evaluation.observed.length) parts.push(`observed=${evaluation.observed.join(", ")}`);
  if (evaluation.violations.length) parts.push(`violations=${evaluation.violations.join(", ")}`);
  if (evaluation.unobservableScopes.length) parts.push(`unobservable=${evaluation.unobservableScopes.join(", ")}`);
  return parts.join("; ");
}

function writeSetTerminalPaths(
  code: "WRITE_SET_VIOLATION" | "WRITE_SET_UNOBSERVABLE",
  evaluation?: WriteSetObservationEvaluation,
  fallbackPaths: string[] = [],
): string[] {
  if (!evaluation) return [...new Set(fallbackPaths)];
  return code === "WRITE_SET_UNOBSERVABLE"
    ? [...new Set(evaluation.unobservableScopes)]
    : [...new Set(evaluation.violations)];
}

function makePevTerminalVerifierResult(terminalState: TerminalNoRetryState): { status: "fail"; reasons: string[]; raw: string } {
  let reason: string;
  if (terminalState.code === "WRITE_SET_UNOBSERVABLE") {
    const scopes = terminalState.unobservableScopes?.length ? terminalState.unobservableScopes.join(", ") : "(unknown scope)";
    reason = `WRITE_SET_UNOBSERVABLE: write-set observation could not observe ${scopes}; failing closed before verifier spawn; retryAllowed=false.`;
  } else if (terminalState.code === "WRITE_SET_VIOLATION") {
    const violations = terminalState.violations?.length ? terminalState.violations.map((p) => `"${p}"`).join(", ") : "(unknown violation)";
    const label = terminalState.errorMessage.includes("WRITE_SET_VIOLATION (pre-execution)")
      ? "WRITE_SET_VIOLATION (pre-execution)"
      : "WRITE_SET_VIOLATION";
    reason = `${label}: ${violations} mutated outside the predicted write set; failing before verifier spawn; retryAllowed=false.`;
  } else {
    reason =
      `Terminal no-retry state ${terminalState.code}: retryAllowed=false; ` +
      `resultLost=${terminalState.resultLost}; verifierSpawned=false; ${terminalState.errorMessage}`;
  }
  return { status: "fail", reasons: [reason], raw: JSON.stringify({ status: "fail", reasons: [reason] }) };
}

function persistPevWriteSetTerminal(
  store: RunStateStore,
  indexOf: (name: string) => number,
  phaseName: string,
  code: "WRITE_SET_VIOLATION" | "WRITE_SET_UNOBSERVABLE",
  state: OrchestrationState,
  evaluation?: WriteSetObservationEvaluation,
  fallbackPaths: string[] = [],
): TerminalNoRetryState {
  const paths = writeSetTerminalPaths(code, evaluation, fallbackPaths);
  const phaseIndex = indexOf(phaseName);
  const violationLabel = phaseName.includes("pre-execution") ? "WRITE_SET_VIOLATION (pre-execution)" : "WRITE_SET_VIOLATION";
  const errorMessage = code === "WRITE_SET_UNOBSERVABLE"
    ? `WRITE_SET_UNOBSERVABLE before verifier spawn: ${paths.join(", ") || "(unknown scope)"}. The run is terminal for this discovery and will not retry.`
    : `${violationLabel} before verifier spawn: ${paths.map((p) => `"${p}"`).join(", ") || "(unknown violation)"}. The run is terminal for this discovery and will not retry.`;
  return store.markTerminalNoRetry(phaseIndex, phaseName, {
    code,
    retryAllowed: false,
    resultLost: false,
    phaseName,
    phaseIndex,
    recordedAt: new Date().toISOString(),
    errorMessage,
    spawnedCount: state.spawnedCount,
    verifierSpawned: false,
    observed: evaluation?.observed ?? [],
    violations: evaluation?.violations ?? (code === "WRITE_SET_VIOLATION" ? paths : []),
    unobservableScopes: evaluation?.unobservableScopes ?? (code === "WRITE_SET_UNOBSERVABLE" ? paths : []),
  });
}

function persistPevAmbiguousTerminal(
  store: RunStateStore,
  indexOf: (name: string) => number,
  phaseName: string,
  error: SubagentTerminalAmbiguousError,
  state: OrchestrationState,
): TerminalNoRetryState {
  const phaseIndex = indexOf(phaseName);
  const info = error.info;
  return store.markTerminalNoRetry(phaseIndex, phaseName, {
    code: info.code,
    retryAllowed: false,
    resultLost: info.resultLost,
    phaseName,
    phaseIndex,
    recordedAt: new Date().toISOString(),
    errorMessage: info.errorMessage,
    agentName: info.agentName,
    exitCode: info.exitCode,
    spawnedCount: state.spawnedCount,
    verifierSpawned: false,
  }, info.candidate);
}

function finalizePevTerminalResult(
  params: NormalizedParams,
  state: OrchestrationState,
  terminalState: TerminalNoRetryState,
): { markdown: string; details: Record<string, unknown> } {
  state.spawnedCount = Math.max(state.spawnedCount, terminalState.spawnedCount ?? 0);
  if (!state.verifierResult) state.verifierResult = makePevTerminalVerifierResult(terminalState);
  state.verifierResults = state.verifierResults ?? [];
  for (const reason of state.verifierResult.reasons) {
    if (!state.failureReasons.some((existing) => existing.includes(reason))) {
      state.failureReasons.push(`Terminal no-retry: ${reason}`);
    }
  }
  state.finalResult = buildFinalResult("fail", params, state);
  return {
    markdown: state.finalResult,
    details: {
      ...buildDetails("fail", params, state),
      code: terminalState.code,
      retryAllowed: false,
      resultLost: terminalState.resultLost,
      verifierSpawned: false,
      spawnedCount: state.spawnedCount,
      observed: terminalState.observed ?? [],
      violations: terminalState.violations ?? [],
      unobservableScopes: terminalState.unobservableScopes ?? [],
      terminalNoRetry: terminalState,
    },
  };
}

function buildFinalResult(status: "pass" | "fail", params: NormalizedParams, state: OrchestrationState): string {
  const verifier = state.verifierResult;
  const modelRoutingEvidence = state.progressLog.filter((line) => /Subagent \S+: using /.test(line));
  const lines = [
    `# Orchestration Result: ${status.toUpperCase()}`,
    "",
    `**Task:** ${params.task}`,
    `**Attempts:** ${state.attempt}`,
    `**Subagents spawned:** ${state.spawnedCount}/${params.maxSubagents}`,
    `**Run:** ${state.runId} | **Hard gates:** ${params.hardGates}`,
    ...(state.abortReason
      ? ["", "## Orchestration aborted (partial report)", `- ${state.abortReason}`]
      : []),
    "",
    "## Intake contract",
    state.intake ? "```json\n" + JSON.stringify(compactIntake(state.intake), null, 2) + "\n```" : "No intake produced.",
    "",
    "## Model routing evidence",
    ...(modelRoutingEvidence.length ? modelRoutingEvidence.map((line) => `- ${line}`) : ["- No explicit model routing evidence was recorded."]),
    "",
    "## Deterministic model routing check",
    state.routingCheck ? `Status: **${state.routingCheck.status}**` : "No deterministic routing check was run.",
    state.routingCheck?.reasons.length ? state.routingCheck.reasons.map((reason) => `- ${reason}`).join("\n") : "- All essential routing requirements were satisfied or no essential routing was requested.",
    "",
    "## Final verifier result",
    verifier ? `Status: **${verifier.status}**` : "No verifier result.",
    verifier?.reasons?.length ? verifier.reasons.map((reason) => `- ${reason}`).join("\n") : "- No verifier reasons provided.",
    "",
    "## Plan",
    state.plan ? "```json\n" + JSON.stringify(compactPlan(state.plan), null, 2) + "\n```" : "No plan produced.",
    "",
    "## Executor outputs",
    ...state.executorOutputs.map((output) => [
      `### ${output.taskId}: ${output.description}`,
      "",
      `_Effect evidence: tool calls ${formatToolCallSummary(output.toolCalls)}; files changed ${output.filesChanged ?? "unknown"}${output.reusedFromAttempt ? `; reused from attempt ${output.reusedFromAttempt}` : ""}_`,
      "",
      output.output ? truncateWithNotice(output.output, MAX_EXECUTOR_MARKDOWN_CHARS, `executor output ${output.taskId}`) : "_(No assistant text captured.)_",
      output.stderr ? `\n_stderr:_\n\`\`\`\n${truncateWithNotice(output.stderr, 2000, `stderr ${output.taskId}`)}\n\`\`\`` : "",
    ].join("\n")),
  ];

  if (state.failureReasons.length) {
    lines.push("", "## Failure reasons across attempts", ...state.failureReasons.map((reason) => `- ${reason}`));
  }

  if (state.gateWarnings.length) {
    lines.push("", "## Gate warnings (advisory — not verdict-determining)", ...state.gateWarnings.map((warning) => `- ${warning}`));
  }

  if (state.commitEvidence.length) {
    lines.push(
      "",
      `## Commit evidence (run ${state.runId})`,
      ...state.commitEvidence.map((entry) => {
        const diffHint = entry.preHash && entry.postHash && entry.preHash !== entry.postHash
          ? ` (diff: git diff ${entry.preHash.slice(0, 12)}..${entry.postHash.slice(0, 12)})`
          : "";
        return `- attempt ${entry.attempt}: pre=${entry.preHash ?? "(unavailable)"} post=${entry.postHash ?? "(unavailable)"}${diffHint}`;
      }),
    );
  }

  if (state.progressLog.length) {
    lines.push("", "## Progress evidence", ...state.progressLog.slice(-40).map((line) => `- ${line}`));
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

function buildDetails(status: "pass" | "fail", params: NormalizedParams, state: OrchestrationState) {
  return {
    status,
    params: { ...params, task: truncateWithNotice(params.task, MAX_DETAIL_TEXT_CHARS, "task") },
    runId: state.runId,
    hardGates: params.hardGates,
    gateWarnings: state.gateWarnings.map((warning) => truncateWithNotice(warning, MAX_DETAIL_TEXT_CHARS, "gate warning")),
    commitEvidence: state.commitEvidence,
    taskLedger: [...state.taskLedger.values()].map((entry) => ({
      taskId: entry.taskId,
      verdict: entry.verdict,
      attempt: entry.attempt,
      filesChanged: entry.output.filesChanged,
      mutatingToolCalls: entry.output.toolCalls?.mutating ?? 0,
    })),
    deterministicState: {
      attempt: state.attempt,
      spawnedCount: state.spawnedCount,
      intake: state.intake ? compactIntake(state.intake) : null,
      routingCheck: state.routingCheck,
      plan: compactPlan(state.plan),
      planText: truncateWithNotice(state.planText, MAX_DETAIL_TEXT_CHARS, "planner output"),
      executorOutputs: state.executorOutputs.map(compactExecutorOutput),
      verifierResult: compactVerifierResult(state.verifierResult),
      verifierResults: (state.verifierResults ?? []).map((result) => ({
        agentName: result.agentName,
        status: result.status,
        reasons: result.reasons.map((reason) => truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "verifier reason")),
        raw: truncateWithNotice(result.raw, MAX_DETAIL_TEXT_CHARS, "verifier raw output"),
      })),
      failureReasons: state.failureReasons.map((reason) => truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "failure reason")),
      progressLog: state.progressLog.map((line) => truncateWithNotice(line, MAX_DETAIL_TEXT_CHARS, "progress log line")),
      finalResult: truncateWithNotice(state.finalResult, MAX_DETAIL_TEXT_CHARS, "final result"),
      recoveryLog: state.recoveryLog.map((entry) => truncateWithNotice(entry, MAX_DETAIL_TEXT_CHARS, "recovery log entry")),
      recoveryDepth: state.recoveryDepth,
      maxRecoveryDepth: state.maxRecoveryDepth,
    },
    attempts: state.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      plan: compactPlan(attempt.plan),
      plannerText: truncateWithNotice(attempt.plannerText, MAX_DETAIL_TEXT_CHARS, "planner output"),
      executorOutputs: attempt.executorOutputs.map(compactExecutorOutput),
      verifierResult: compactVerifierResult(attempt.verifierResult),
      verifierResults: (attempt.verifierResults ?? []).map((result) => ({
        agentName: result.agentName,
        status: result.status,
        reasons: result.reasons.map((reason) => truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "verifier reason")),
        raw: truncateWithNotice(result.raw, MAX_DETAIL_TEXT_CHARS, "verifier raw output"),
      })),
    })),
  };
}

function compactIntake(intake: Intake): Intake {
  return {
    ...intake,
    originalTask: truncateWithNotice(intake.originalTask, MAX_DETAIL_TEXT_CHARS, "intake original task"),
    taskSummary: truncateWithNotice(intake.taskSummary, MAX_DETAIL_TEXT_CHARS, "intake task summary"),
    userIntent: truncateWithNotice(intake.userIntent, MAX_DETAIL_TEXT_CHARS, "intake user intent"),
    goalAttractor: truncateWithNotice(intake.goalAttractor, MAX_DETAIL_TEXT_CHARS, "intake goal attractor"),
    taskScope: truncateWithNotice(intake.taskScope, MAX_DETAIL_TEXT_CHARS, "intake task scope"),
    constraints: intake.constraints.map((item) => truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake constraint")),
    invariants: intake.invariants.map((item) => truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake invariant")),
    successCriteria: intake.successCriteria.map((item) => truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake success criterion")),
    failureCriteria: intake.failureCriteria.map((item) => truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake failure criterion")),
    nonGoals: intake.nonGoals.map((item) => truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake non-goal")),
    ambiguities: intake.ambiguities.map((item) => truncateWithNotice(item, MAX_DETAIL_TEXT_CHARS, "intake ambiguity")),
    routingDecision: truncateWithNotice(intake.routingDecision, MAX_DETAIL_TEXT_CHARS, "intake routing decision"),
    executorOutputContract: intake.executorOutputContract ? truncateWithNotice(intake.executorOutputContract, MAX_DETAIL_TEXT_CHARS, "intake executor output contract") : undefined,
  };
}

function compactPlan(plan: Plan | null): Plan | null {
  if (!plan) return null;
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      description: truncateWithNotice(task.description, MAX_DETAIL_TEXT_CHARS, `task description ${task.id}`),
    })),
    notes: truncateWithNotice(plan.notes, MAX_DETAIL_TEXT_CHARS, "plan notes"),
    raw: compactUnknown(plan.raw, "plan raw"),
  };
}

function compactUnknown(value: unknown, label: string): unknown {
  if (typeof value === "string") return truncateWithNotice(value, MAX_DETAIL_TEXT_CHARS, label);
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
    output: truncateWithNotice(output.output, MAX_DETAIL_TEXT_CHARS, `executor output ${output.taskId}`),
    stderr: output.stderr ? truncateWithNotice(output.stderr, 2000, `stderr ${output.taskId}`) : undefined,
  };
}

function compactVerifierResult(result: OrchestrationState["verifierResult"]) {
  if (!result) return null;
  return {
    ...result,
    reasons: result.reasons.map((reason) => truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "verifier reason")),
    raw: truncateWithNotice(result.raw, MAX_DETAIL_TEXT_CHARS, "verifier output"),
  };
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
  if (envCommand) return { command: envCommand, argsPrefix: [], shell: shouldUseWindowsShell(envCommand) };

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
  if (!existsSync(cliPath)) throw new Error(`${envName} points to a missing Pi CLI path: ${cliPath}`);
  const ext = path.extname(cliPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return resolvePiChildCommand(cliPath, envName);
  return { command: cliPath, argsPrefix: [], shell: shouldUseWindowsShell(cliPath), launchRuntime: shouldUseWindowsShell(cliPath) ? "shell" : "native" };
}

function shouldUseWindowsShell(command: string): boolean | undefined {
  if (process.platform !== "win32") return undefined;
  return /\.(cmd|bat)(?:$|\s)/i.test(command) ? true : undefined;
}

function isExistingPiCliScript(candidate: string): boolean {
  return /pi-coding-agent[\\/]dist[\\/](main|cli)\.js$/.test(candidate) && existsSync(candidate);
}

function resolveInstalledPiCliScript(): string | null {
  const candidates = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
      : "",
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    path.join(os.homedir(), ".nvm", "versions", "node", "current", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function formatRoutedModel(provider?: string, model?: string): string {
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

async function mkTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `pi-orchestrator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function stringParam(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "agent";
}

function truncateWithNotice(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  const notice = `\n\n_(${label} truncated: ${text.length - max} additional characters omitted.)_`;
  return `${text.slice(0, Math.max(0, max - notice.length))}${notice}`;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Orchestration aborted.");
}

// ── Natural-language orchestration controls ───────────────────────────────

function inferOrchestrationControlsFromTask(
  task: string,
  params: Record<string, unknown>,
  inferredRouting: InferredModelRouting,
): NaturalLanguageOrchestrationControls {
  const rawMatches: string[] = [];
  const maxSubagents = firstNumberMatch(task, [
    /\b(?:max(?:imum)?|at[\s-]*most|no[\s-]*more[\s-]*than|limit(?:ed)?[\s-]*to|cap(?:ped)?[\s-]*at|use[\s-]*up[\s-]*to)\s+([a-z0-9-]+)\s+(?:agents?|subagents?|sub-agents?|workers?|processes?)\b/i,
    /\b(?:agents?|subagents?|sub-agents?|workers?|processes?)\s+(?:max(?:imum)?|cap|ceiling|limit)\s*(?:of|to|at|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const concurrency = firstNumberMatch(task, [
    /\b(?:concurrency|parallelism)\s*(?:of|to|=|:)?\s*([a-z0-9-]+)\b/i,
    /\b(?:run|use|spawn|execute)?\s*([a-z0-9-]+)\s+(?:at[\s-]*a[\s-]*time|concurrently|concurrent|in[\s-]*parallel|parallel)\b/i,
  ], rawMatches);
  const executorCount = firstNumberMatch(task, [
    /\b(?:at[\s-]*least|up[\s-]*to|use|run|spawn|available|allow|invoke)\s+([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?executors?\b/i,
    /\b([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?executors?\b/i,
    /\b(?:executors?|executor\s+agents?|executor\s+slots?)\s*(?:count|pool|concurrency|parallelism|available|of|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const plannerCount = firstNumberMatch(task, [
    /\b(?:use|run|spawn|allow|invoke)\s+([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?planners?\b/i,
    /\b([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?planners?\b/i,
    /\b(?:planners?|planner\s+agents?)\s*(?:count|pool|concurrency|parallelism|of|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const verifierCount = firstNumberMatch(task, [
    /\b(?:use|run|spawn|allow|invoke)\s+([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?verifiers?\b/i,
    /\b([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?verifiers?\b/i,
    /\b(?:verifiers?|verifier\s+agents?)\s*(?:count|pool|concurrency|parallelism|of|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const maxAttempts = firstNumberMatch(task, [
    /\b(?:at[\s-]*most|up[\s-]*to|maximum[\s-]*of|max(?:imum)?|limit(?:ed)?[\s-]*to)\s+([a-z0-9-]+)\s+(?:attempts?|tries|runs?|passes?|loops?)\b/i,
    /\b(?:loop|iterate|try)\s+(?:at[\s-]*most|up[\s-]*to|no[\s-]*more[\s-]*than)?\s*([a-z0-9-]+)\s+(?:times?|attempts?|passes?)\b/i,
  ], rawMatches);
  const maxRetries = firstNumberMatch(task, [
    /\b(?:retry|re-try)\s+(?:at[\s-]*most|up[\s-]*to|no[\s-]*more[\s-]*than|maximum[\s-]*of)?\s*([a-z0-9-]+)\s*(?:times?|retries?)?\b/i,
    /\b(?:max(?:imum)?|limit(?:ed)?[\s-]*to)\s+([a-z0-9-]+)\s+retries?\b/i,
    /\bmax(?:imum)?\s+retries?\s*(?:of|to|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const researcherCount = firstNumberMatch(task, [
    /\b(?:run|spawn|use|assign|create)?\s*([a-z0-9-]+)\s+(?:different\s+)?researchers?\b/i,
    /\bresearchers?\s*(?:count|number|team|agents?)?\s*(?:of|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const perspectiveCount = firstNumberMatch(task, [
    /\b([a-z0-9-]+)\s+(?:different\s+)?perspectives?\b/i,
    /\bperspectives?\s*(?:count|number)?\s*(?:of|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const perspectives = extractNamedPerspectives(task);

  const runtimeRoles = Object.entries(inferredRouting.runtimeRoles ?? {}).map(
    ([role, hint]) => ({
      role,
      agentName: role,
      ...hint,
      ...(role === "researcher" && researcherCount ? { count: researcherCount } : {}),
      ...(role === "researcher" && perspectiveCount ? { perspectiveCount } : {}),
      ...(role === "researcher" && perspectives.length ? { perspectives } : {}),
    }),
  );
  if (researcherCount && !runtimeRoles.some((role) => role.role === "researcher")) {
    runtimeRoles.push({
      role: "researcher",
      agentName: "researcher",
      count: researcherCount,
      ...(perspectiveCount ? { perspectiveCount } : {}),
      ...(perspectives.length ? { perspectives } : {}),
    });
  }

  return {
    ...(maxSubagents ? { maxSubagents } : {}),
    maxSubagentsSource: params.maxSubagents !== undefined ? "parameter" : maxSubagents ? "natural_language" : "default",
    ...(concurrency ? { concurrency } : {}),
    concurrencySource: params.concurrency !== undefined || params.executorConcurrency !== undefined || params.executorCount !== undefined ? "parameter" : concurrency || executorCount ? "natural_language" : "default",
    ...(executorCount ? { executorCount, executorConcurrency: executorCount } : {}),
    ...(plannerCount ? { plannerCount } : {}),
    ...(verifierCount ? { verifierCount } : {}),
    roleConcurrencySource: params.plannerCount !== undefined || params.verifierCount !== undefined || params.executorConcurrency !== undefined || params.executorCount !== undefined ? "parameter" : executorCount || plannerCount || verifierCount ? "natural_language" : "default",
    ...(maxAttempts ? { maxAttempts } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    loopingSource: params.maxRetries !== undefined ? "parameter" : maxAttempts || maxRetries !== undefined ? "natural_language" : "default",
    ...(researcherCount ? { researcherCount } : {}),
    ...(perspectiveCount ? { perspectiveCount } : {}),
    ...(perspectives.length ? { perspectives } : {}),
    runtimeRoles,
    rawMatches,
  };
}

function firstNumberMatch(text: string, patterns: RegExp[], rawMatches: string[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const value = parseNaturalNumber(match[1]);
    if (value !== undefined) { rawMatches.push(match[0].trim()); return value; }
  }
  return undefined;
}

function parseNaturalNumber(value: string): number | undefined {
  const normalized = value.toLowerCase().replace(/-/g, " ").trim();
  if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
  const words: Record<string, number> = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20 };
  return words[normalized];
}

function extractNamedPerspectives(task: string): string[] {
  const match = task.match(/\bperspectives?\s*(?:as|:|=)\s*([^.;\n]+)/i);
  if (!match?.[1]) return [];
  return match[1].split(/,|\band\b/i).map((item) => item.trim()).filter((item) => item && !/^\d+\s+different$/i.test(item)).slice(0, 12);
}

// ── Live Orchestration Status Dashboard ────────────────────────────────────

/**
 * Initialize a new dashboard state for the given orchestration task.
 * The caller must populate controls/routing from normalized params before
 * calling buildDashboardLines.
 */
function createOrchestrateDashboard(task: string): DashboardState {
  return {
    task,
    maxSubagents: DEFAULT_MAX_SUBAGENTS,
    maxRetries: 2,
    concurrency: 2,
    paradigm: "",
    plannerModel: "default",
    executorModel: "default",
    verifierModel: "default",
    taskAssignments: [],
    activeSubagents: 0,
    spawnedCount: 0,
    phase: "starting",
    contextUsage: "",
    startTime: Date.now(),
  };
}

/**
 * Parse a progress message and update the dashboard state accordingly.
 * Recognises phase transitions, subagent spawn counts, task counts,
 * context budget info, and plan task assignments.
 */
function updateDashboardFromProgress(state: DashboardState, message: string): void {
  // Phase detection (first match wins per call, last emitted progress dominates)
  if (/\bplanning\b/i.test(message)) state.phase = "planning";
  if (/\bexecuting\b/i.test(message)) state.phase = "executing";
  if (/\bverifying\b/i.test(message)) state.phase = "verifying";

  // Subagent spawn count: "Spawning subagent X (N/M)"
  const spawnMatch = message.match(/Spawning subagent \S+ \((\d+)\/(\d+)\)/);
  if (spawnMatch) {
    state.spawnedCount = parseInt(spawnMatch[1], 10);
  }

  // Task execution count: "executing N task(s) across M dependency wave(s)..."
  const taskCountMatch = message.match(/executing (\d+) task\(s\)/);
  if (taskCountMatch) {
    state.activeSubagents = parseInt(taskCountMatch[1], 10);
  }

  // Context budget: "Task X: pre-spawn budget: Y% sat..."
  const budgetMatch = message.match(/pre-spawn budget: (\d+)%/);
  if (budgetMatch) {
    state.contextUsage = `${budgetMatch[1]}% sat`;
  }

  // Plan task assignments: "Plan tasks: id=desc; id=desc" (emitted by task-2)
  const planTasksMatch = message.match(/^Plan tasks: (.+)$/);
  if (planTasksMatch) {
    const taskPairs = planTasksMatch[1].split(";").map((s) => s.trim()).filter(Boolean);
    state.taskAssignments = taskPairs.map((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return { id: pair, description: pair };
      return { id: pair.slice(0, eqIdx).trim(), description: pair.slice(eqIdx + 1).trim() };
    });
  }
}

/**
 * Render the dashboard as an array of lines suitable for ctx.ui.setWidget.
 */
function buildDashboardLines(state: DashboardState, footer?: string): string[] {
  const lines: string[] = [];
  const phaseEmoji = phaseIcon(state.phase);
  const elapsed = formatElapsedMs(Date.now() - state.startTime);

  lines.push(`${phaseEmoji} /orchestrate — ${capitalise(state.phase)} (${elapsed})`);
  lines.push("");
  lines.push(`Controls: ${state.maxSubagents} subagents, ${state.maxRetries} retries, ${state.concurrency} concurrency`);
  lines.push(`Paradigm:  ${state.paradigm || "plan-execute-verify"}`);
  lines.push("");
  lines.push(`Planner  → ${state.plannerModel}`);
  lines.push(`Executor → ${state.executorModel}`);
  lines.push(`Verifier → ${state.verifierModel}`);
  lines.push("");

  if (state.taskAssignments.length > 0) {
    lines.push("Tasks:");
    for (const task of state.taskAssignments) {
      const desc = task.description.length > 64
        ? task.description.slice(0, 61) + "..."
        : task.description;
      lines.push(`  ${task.id}: ${desc}`);
    }
  } else {
    lines.push("Tasks: (awaiting plan)");
  }

  lines.push("");
  lines.push(`Active: ${state.spawnedCount}/${state.maxSubagents} subagents`);
  if (state.contextUsage) lines.push(`Context: ${state.contextUsage}`);
  if (footer) lines.push("", footer);

  return lines;
}

/**
 * Single-line status for ctx.ui.setStatus.
 */
function dashboardStatusLine(state: DashboardState): string {
  const emoji = phaseIcon(state.phase);
  return `${emoji} /orchestrate — ${state.spawnedCount}/${state.maxSubagents} agents — ${capitalise(state.phase)}`;
}

function phaseIcon(phase: string): string {
  switch (phase) {
    case "planning":  return "🧠";
    case "executing": return "⚙️";
    case "verifying": return "🔍";
    case "complete":  return "✅";
    case "failed":    return "❌";
    default:          return "🔄";
  }
}

function capitalise(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatElapsedMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function inferOrchestrationParadigm(params: NormalizedParams): string {
  // Explicit flag takes highest priority
  if (params.paradigm) return params.paradigm;

  const task = params.task.toLowerCase();

  // Detect verify-only keywords (F8) — checked first because generic
  // "verify" terms also appear in other paradigm triggers.
  if (/\b(?:verify[-\s]?only|verification[-\s]?only|only\s+verify|just\s+verify|re-?verif(?:y|ication))\b/i.test(task)) {
    return "verify-only";
  }

  // Detect composable-pipeline keywords
  // Phase-specific triggers (hypothesize, criticize, synthesize)
  if (/\b(?:hypothesizer|hypothesize|hypothesis|synthesizer|synthesize|synthesis|critic|critique)\b/i.test(task)) {
    return "composable-pipeline";
  }
  // Full-wave / all-phases triggers
  if (/\b(?:full\s+wave|all\s+(?:phases|stages))\b/i.test(task)) {
    return "composable-pipeline";
  }

  // Detect multi-verify-vote keywords
  if (/\b(?:multi[\s-]verify|vote|voting|majority)\b/i.test(task)) {
    return "multi-verify-vote";
  }

  return "plan-execute-verify";
}
