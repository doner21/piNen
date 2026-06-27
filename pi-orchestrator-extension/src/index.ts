import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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

// ── Shape imports (orchestration paradigms) ───────────────────────────
import { composablePipelineShape } from "./shapes/composable-pipeline";
import { multiVerifyVoteShape } from "./shapes/multi-verify-vote";
import { planExecuteVerifyShape } from "./shapes/plan-execute-verify";
import { verifyOnlyShape } from "./shapes/verify-only";
import { safeGithubPublishShape } from "./shapes/safe-github-publish";
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

import { preflightProviderHealth } from "./substrate";

// ── Shape registry (maps paradigm names to orchestration shapes) ─────
const shapeRegistry = new Map<string, OrchestrationShape>([
  ["plan-execute-verify", planExecuteVerifyShape],
  ["multi-verify-vote", multiVerifyVoteShape],
  ["composable-pipeline", composablePipelineShape],
  ["verify-only", verifyOnlyShape],
  ["safe-github-publish", safeGithubPublishShape],
]);

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
}

interface ResolvedPiCommand {
  command: string;
  argsPrefix: string[];
  shell?: boolean;
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
  verifierModel?: string;
  verifierProvider?: string;
  concurrency: number;
  maxRetries: number;
  maxRetriesExplicit: boolean;
  maxSubagents: number;
  maxSubagentsExplicit: boolean;
  cwd: string;
  allowLocalModel: boolean;
  orchestrationControls: NaturalLanguageOrchestrationControls;
  paradigm?: string;
  /** Hard-gate mode (F1). Default "advisory". */
  hardGates: HardGatesMode;
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
  executorOutputs: ExecutorOutput[];
  verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string } | null;
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
    executorOutputs: ExecutorOutput[];
    verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string };
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
  task: Type.String({ description: "Task for deterministic multi-agent orchestration." }),
  plannerAgent: Type.Optional(Type.String({ default: "planner" })),
  executorAgent: Type.Optional(Type.String({ default: "coder" })),
  verifierAgent: Type.Optional(Type.String({ default: "reviewer" })),
  concurrency: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 8 })),
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
  paradigm: Type.Optional(Type.String({ description: "Explicitly select the orchestration paradigm/shape. Valid values: plan-execute-verify, multi-verify-vote, composable-pipeline, verify-only. When omitted, the paradigm is inferred from task keywords." })),
  hardGates: Type.Optional(Type.String({ description: 'Hard-gate mode: "strict" | "advisory" | "off". Default "advisory": text-shape heuristics are demoted to warnings, the verifier verdict gates, and only effect-based contradictions (zero observed mutations for implementation work) can force FAIL.' })),
  preflight: Type.Optional(Type.Boolean({ description: "Run a 1-token provider health ping for each routed provider/model before spawning any subagent (default true). Failures produce a structured machine-readable error and a partial report." })),
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
    const normalized = normalizeParams(params, ctx?.cwd ?? process.cwd());
    const inheritedModel = ctx?.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined;
    return runOrchestration(normalized, signal, onUpdate, inheritedModel);
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
    description: "Run deterministic planner/executor/verifier orchestration. Flags: --max-subagents N, --max-retries N, --concurrency N, --planner-model, --executor-model, --verifier-model, --planner-fallback-model (comma-sep chain), etc.",
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
        throw new Error(`Unknown flag --${flag}. Supported flags: --max-subagents, --max-retries, --concurrency, --planner-agent, --executor-agent, --verifier-agent, --cwd, --allow-local-model, --paradigm, --hard-gates, --preflight/--no-preflight, --planner-model, --planner-provider, --executor-model, --executor-provider, --verifier-model, --verifier-provider, --planner-fallback-model, --planner-fallback-provider, --executor-fallback-model, --executor-fallback-provider, --verifier-fallback-model, --verifier-fallback-provider. Fallback params accept comma-separated chains (e.g. --planner-fallback-model opus,deepseek-v4-pro,deepseek-v4-flash).`);
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
  const inferredRouting = inferModelRoutingFromTask(task);
  const orchestrationControls = inferOrchestrationControlsFromTask(task, params, inferredRouting);

  return {
    task,
    plannerAgent: stringParam(params.plannerAgent, "planner"),
    executorAgent: stringParam(params.executorAgent, "coder"),
    verifierAgent: stringParam(params.verifierAgent, "reviewer"),
    concurrency: clampInt(params.concurrency ?? orchestrationControls.concurrency, 2, 1, 16),
    maxRetries: clampInt(params.maxRetries ?? orchestrationControls.maxRetries ?? (orchestrationControls.maxAttempts !== undefined ? orchestrationControls.maxAttempts - 1 : undefined), 2, 0, 5),
    maxRetriesExplicit: params.maxRetries !== undefined || orchestrationControls.maxAttempts !== undefined || orchestrationControls.maxRetries !== undefined,
    maxSubagents: clampInt(params.maxSubagents ?? orchestrationControls.maxSubagents, DEFAULT_MAX_SUBAGENTS, 3, MAX_SUBAGENTS_LIMIT),
    maxSubagentsExplicit: params.maxSubagents !== undefined || orchestrationControls.maxSubagents !== undefined,
    cwd: stringParam(params.cwd, defaultCwd),
    allowLocalModel: typeof params.allowLocalModel === "boolean" ? params.allowLocalModel : false,
    plannerModel: optionalString(params.plannerModel) ?? inferredRouting.planner?.model,
    plannerProvider: optionalString(params.plannerProvider) ?? inferredRouting.planner?.provider,
    executorModel: optionalString(params.executorModel) ?? inferredRouting.executor?.model,
    executorProvider: optionalString(params.executorProvider) ?? inferredRouting.executor?.provider,
    verifierModel: optionalString(params.verifierModel) ?? inferredRouting.verifier?.model,
    verifierProvider: optionalString(params.verifierProvider) ?? inferredRouting.verifier?.provider,
    orchestrationControls,
    paradigm: typeof params.paradigm === "string" ? params.paradigm : undefined,
    hardGates: normalizeHardGatesMode(params.hardGates),
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
) {
  const agents = await loadAgents();

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
    runId: `orc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
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
  emit(`Run ${state.runId}: paradigm=${paradigm}, hardGates=${params.hardGates}, preflight=${params.preflight}.`);

  try {
  // ── Pre-flight provider health checks (F5) ──────────────────────────
  if (params.preflight) {
    await runProviderPreflight(params, agents, inheritedModel, signal, emit);
  }

  // ── Shape-based orchestration dispatch ────────────────────────────────
  if (paradigm !== "plan-execute-verify") {
    const shape = shapeRegistry.get(paradigm);
    if (!shape) {
      throw new Error(
        `Unknown orchestration paradigm "${paradigm}". Available paradigms: ${[...shapeRegistry.keys()].join(", ")}.`,
      );
    }

    const inferredModelRouting = inferModelRoutingFromTask(params.task);
    const context: OrchestrationShapeContext = {
      params,
      signal,
      onUpdate,
      inheritedModel,
      agents,
      inferredModelRouting,
    };

    const emit = (text: string) => {
      onUpdate?.({ content: [{ type: "text", text }] });
    };
    emit(`[orchestrate] Dispatching to "${paradigm}" shape…`);

    const result: OrchestrationShapeResult = await shape.run(context);
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    state.attempt = attempt;
    emit(`Orchestration attempt ${attempt}/${maxAttempts}: planning...`);
    const preAttemptHead = gitHeadHash(params.cwd);

    const completedTasks = [...state.taskLedger.values()].filter((entry) => entry.verdict === "passed");
    const plannerPrompt = buildPlanningPrompt(state.intake, attempt, state.failureReasons, completedTasks);
    const planner = await spawnChecked(state, params, agents, params.plannerAgent, plannerPrompt, signal, emit, inheritedModel, toModelOverride(params.plannerModel, params.plannerProvider));
    state.planText = planner.text;
    let plan = parsePlan(planner.text, params.task);
    plan = enforceTaskSizeCap(plan, computeAdaptiveTaskSizeCap(params.executorModel));
    const executionWaves = buildExecutionWaves(plan);
    state.plan = plan;

    const taskAssignments = plan.tasks.map((t) => `${t.id}=${t.description}`).join("; ");
    emit(`Plan tasks: ${taskAssignments}`);

    const requiredBudget = computeRequiredSubagentBudget(state.spawnedCount, plan.tasks.length, attempt, maxAttempts);
    if (!params.maxSubagentsExplicit && requiredBudget > params.maxSubagents) {
      const previous = params.maxSubagents;
      params.maxSubagents = Math.min(requiredBudget, MAX_SUBAGENTS_LIMIT);
      emit(
        `Auto-raised maxSubagents from ${previous} to ${params.maxSubagents} based on plan size (${plan.tasks.length} executor task(s)) and retry budget (${maxAttempts} attempt(s)).`,
      );
      if (requiredBudget > MAX_SUBAGENTS_LIMIT) {
        emit(`Required subagent budget ${requiredBudget} exceeds hard safety limit ${MAX_SUBAGENTS_LIMIT}; orchestration may still stop if the ceiling is reached.`);
      }
    } else if (params.maxSubagentsExplicit) {
      emit(`Using explicit maxSubagents=${params.maxSubagents}; auto-raise is disabled for this run.`);
    }

    const remainingAfterPlan = params.maxSubagents - state.spawnedCount;
    const neededForExecutionAndVerify = plan.tasks.length + 1;
    if (neededForExecutionAndVerify > remainingAfterPlan) {
      throw new Error(
        `Subagent ceiling exceeded after planning: need ${neededForExecutionAndVerify} more spawn(s), remaining ${remainingAfterPlan}, maxSubagents=${params.maxSubagents}. Try /orchestrate --max-subagents ${requiredBudget} ... or reduce --max-retries.`,
      );
    }

    emit(`Attempt ${attempt}: executing ${plan.tasks.length} task(s) across ${executionWaves.length} dependency wave(s) with concurrency ${params.concurrency}...`);
    const executorOutputs = await runExecutorTasksInWaves(
      executionWaves,
      params.concurrency,
      signal,
      async (task, _index, workerSignal) => {
        return executeExecutorTaskWithRecovery(
          state, params, agents, task, plan, workerSignal, emit, inheritedModel,
        );
      },
    );
    state.executorOutputs = executorOutputs;

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
      state.attempts.push({ attempt, plan, plannerText: planner.text, executorOutputs, verifierResult });
      state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
      updateTaskLedgerFromFailure(state, plan, executorOutputs, verifierResult.reasons, attempt, emit);

      if (attempt >= maxAttempts) break;
      if (state.spawnedCount >= params.maxSubagents) {
        throw new Error(`Subagent ceiling reached before retry: spawned ${state.spawnedCount}/${params.maxSubagents}.`);
      }
      continue;
    }

    emit(`Attempt ${attempt}: verifying executor outputs...`);
    const verifierPrompt = buildVerificationPrompt(state.intake!, plan, executorOutputs, buildRoutingEvidenceForVerifier(params, state), artifactEvidence.summary);
    const verifier = await spawnChecked(state, params, agents, params.verifierAgent, verifierPrompt, signal, emit, inheritedModel, toModelOverride(params.verifierModel, params.verifierProvider));
    const verifierResult = parseVerifierResult(verifier.text);
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

    state.attempts.push({ attempt, plan, plannerText: planner.text, executorOutputs, verifierResult });

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
    const providerError =
      (error as { providerError?: ProviderHealthError }).providerError ??
      parseProviderError(message);
    state.abortReason = message;
    state.failureReasons.push(`Run aborted: ${message}`);
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
async function runProviderPreflight(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  inheritedModel: { provider?: string; model?: string } | undefined,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
): Promise<void> {
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
    { cwd: params.cwd, allowLocalModel: params.allowLocalModel, signal, onProgress: emit },
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
            { cwd: params.cwd, allowLocalModel: params.allowLocalModel, signal, onProgress: emit },
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

function computeRequiredSubagentBudget(spawnedThroughCurrentPlanner: number, executorTaskCount: number, currentAttempt: number, maxAttempts: number): number {
  const finishCurrentAttempt = executorTaskCount + 1; // executors + verifier; current planner already spawned.
  const remainingAttempts = Math.max(0, maxAttempts - currentAttempt);
  const fullFutureAttempt = executorTaskCount + 2; // planner + executors + verifier.
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
async function executeExecutorTaskWithRecovery(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  task: PlanTask,
  plan: Plan,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
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
    );
  } catch (err) {
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
  });
}

async function loadAgents(): Promise<Map<string, AgentProfile>> {
  const agents = new Map<string, AgentProfile>();
  for (const agent of DEFAULT_AGENTS) agents.set(agent.name, agent);

  const agentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
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

  let stderr = "";
  let lastAssistantText = "";
  let eventCount = 0;
  let killedByAbort = false;
  const assistantFailures: string[] = [];
  const toolCalls = emptyToolCallSummary();

  const child = spawn(command.command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: command.shell,
  });

  // Pipe the task via stdin when it exceeds the safe arg limit
  if (pipeStdin && child.stdin) {
    child.stdin.write(task);
    child.stdin.end();
  }

  const abortHandler = () => {
    killedByAbort = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
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
      eventCount++;
      const progress = describeJsonEvent(profile.name, event);
      if (progress) options.onProgress?.(progress);
      // Effect-evidence telemetry: count tool executions by tool name (F1).
      if (event?.type === "tool_execution_start") {
        const toolName = optionalString((event as Record<string, unknown>).toolName);
        if (toolName) recordToolCall(toolCalls, toolName);
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
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

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  }).finally(async () => {
    if (options.signal) options.signal.removeEventListener("abort", abortHandler);
    stdoutReader.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  if (killedByAbort) throw new Error(`Subagent ${agentName} aborted.`);
  if (exitCode !== 0) {
    throw new Error(`Subagent ${agentName} exited with code ${exitCode}. stderr: ${truncateWithNotice(stderr.trim(), 2000, "stderr")}`);
  }
  if (assistantFailures.length > 0) {
    const stderrSuffix = stderr.trim() ? ` stderr: ${truncateWithNotice(stderr.trim(), 1000, "stderr")}` : "";
    throw new Error(
      `Subagent ${agentName} reported assistant failure despite exit code 0: ${truncateWithNotice(assistantFailures.join("; "), 2000, "assistant failure details")}.${stderrSuffix}`,
    );
  }

  return {
    agentName: profile.name,
    task,
    text: lastAssistantText.trim(),
    stderr: stderr.trim(),
    exitCode,
    durationMs: Date.now() - startedAt,
    events: eventCount,
    toolCalls,
  };
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
  const inferredFromTask = inferModelRoutingFromTask(params.task);
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
      return { role: role.role, agentName: role.agentName, provider, model, essential: role.explicit || source === "natural_language", source };
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
    const needed = req.role === "executor" ? Math.max(1, state.executorOutputs.length) : 1;
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

function normalizeRoutingText(text: string): string {
  return text
    .replace(/deep[\s-]*seek|deepseak/gi, "deepseek")
    .replace(/codecs?/gi, "codex")
    .toLowerCase();
}

function modelAliasFromText(text: string): RoleModelOverride | undefined {
  const normalized = normalizeRoutingText(text);
  // GPT 5.5 Fast must be checked BEFORE generic GPT 5.5 so "gpt 5.5 fast"
  // doesn't match the broader pattern first and return gpt-5.5.
  if (/\bgpt[-\s]*5(?:\.5)?\b.{0,20}\bfast\b|\bfast\b.{0,20}\bgpt[-\s]*5(?:\.5)?\b/.test(normalized)) return { provider: "openai-codex", model: "gpt-5.5-fast" };
  if (/\bgpt[-\s]*5(?:\.5)?\b/.test(normalized) || /\bcodex\b/.test(normalized)) return { provider: "openai-codex", model: "gpt-5.5" };
  if (/\bdeepseek\b/.test(normalized) && /\bv?4\b/.test(normalized) && /\bpro\b/.test(normalized)) return { provider: "deepseek", model: "deepseek-v4-pro" };
  if (/\bdeepseek\b/.test(normalized) && /\bv?4\b/.test(normalized) && /\bflash\b/.test(normalized)) return { provider: "deepseek", model: "deepseek-v4-flash" };
  // Anthropic model aliases — prompt-based routing flexibility.
  if (/\bopus\b.{0,20}\b4\.?8\b|\b4\.?8\b.{0,20}\bopus\b|\bclaude\b.{0,20}\bopus\b/i.test(normalized)) return { provider: "anthropic", model: "claude-opus-4-20250514" };
  if (/\bsonnet\b|\bclaude\s+sonnet\b/i.test(normalized)) return { provider: "anthropic", model: "claude-sonnet-4-20250514" };
  if (/\bhaiku\b|\bclaude\s+haiku\b/i.test(normalized)) return { provider: "anthropic", model: "claude-3-5-haiku-20241022" };
  if (/\bfable\b|\bclaude\s+fable\b/i.test(normalized)) return { provider: "anthropic", model: "fable" };
  return undefined;
}

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
  const providerModel = cleaned.match(/^provider\s+([a-z0-9_.-]+)\s+(?:model\s+)?(.+)$/i);
  if (providerModel) return { provider: providerModel[1].trim(), model: providerModel[2].trim() };
  if (!cleaned || cleaned.split(/\s+/).length > 8) return undefined;
  if (!/[a-z0-9]/i.test(cleaned)) return undefined;
  const slash = cleaned.indexOf("/");
  if (slash > 0) {
    const provider = cleaned.slice(0, slash).trim();
    const model = cleaned.slice(slash + 1).trim();
    if (provider && model) return { provider, model };
  }
  return { model: cleaned };
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

function buildPlanningPrompt(intake: Intake, attempt: number, failureReasons: string[], completedTasks: TaskLedgerEntry[] = []): string {
  const retryBlock = failureReasons.length
    ? `\nPrevious verifier failure reasons to address deterministically:\n${failureReasons.map((reason) => `- ${reason}`).join("\n")}\n`
    : "";
  // F2: completed tasks from prior attempts must NOT be re-created. The
  // orchestrator reuses their outputs and routes them to re-verification.
  const completedBlock = completedTasks.length
    ? `\nTasks ALREADY COMPLETED successfully in a previous attempt (their artifacts exist on disk). Keep their IDs stable, do NOT instruct executors to re-create or re-do their work, and plan only the remaining/failed work. The orchestrator will reuse their results automatically:\n${completedTasks.map((entry) => `- ${entry.taskId}: ${entry.description}`).join("\n")}\n`
    : "";
  return `Plan the following task for executor subagents. Return JSON if possible, exactly shaped as:\n{"tasks":[{"id":"...","description":"...","dependsOn":[]}],"notes":"..."}\n\nINTAKE CONTRACT:\n${formatIntakeForPrompt(intake)}\n\nRules:\n- Keep task IDs stable and simple (task-1, task-2, ...).\n- Make each description self-contained.\n- Do not execute the task.\n- Carry forward all intake constraints, invariants, success criteria, failure criteria, and executor output contract into the task descriptions/notes.\n- If model routing requirements exist in intake, treat them as essential orchestrator constraints, not executor work.\n- If the task cannot be safely split, return one task.\n- **Task-size cap**: each executor task description MUST be under ~200 words. Tasks exceeding this should be split into multiple smaller tasks. Small tasks ensure executor subagents have enough context budget to use write/edit/bash tools and produce actual file artifacts rather than text reports.\n- An executor task that only describes/analyzes and never touches files is NOT sufficient for CREATE or IMPLEMENT work — the verifier will check for actual file artifacts.\n\nAttempt: ${attempt}${completedBlock}${retryBlock}`;
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
    return { command: process.execPath, argsPrefix: [currentCliScript] };
  }

  const cliScript = process.argv.find((arg) => isExistingPiCliScript(arg));
  if (cliScript) return { command: process.execPath, argsPrefix: [cliScript] };

  const installedCliScript = resolveInstalledPiCliScript();
  if (installedCliScript) return { command: process.execPath, argsPrefix: [installedCliScript] };

  return process.platform === "win32"
    ? { command: "pi.cmd", argsPrefix: [], shell: true }
    : { command: "pi", argsPrefix: [] };
}

function resolvePiCliPath(cliPath: string, envName: string): ResolvedPiCommand {
  if (!existsSync(cliPath)) throw new Error(`${envName} points to a missing Pi CLI path: ${cliPath}`);
  const ext = path.extname(cliPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { command: process.execPath, argsPrefix: [cliPath] };
  return { command: cliPath, argsPrefix: [], shell: shouldUseWindowsShell(cliPath) };
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
    concurrencySource: params.concurrency !== undefined ? "parameter" : concurrency ? "natural_language" : "default",
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
