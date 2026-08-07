/**
 * Shape: composable-pipeline
 * ===========================
 * A composable orchestration shape that supports dynamic pipeline composition
 * via natural language. Supports research, hypothesize, critique, synthesize,
 * plan, execute, and verify phases with configurable cardinality per phase.
 *   "use 3 hypothesizers then 2 critics then a synthesizer then a planner,
 *    then 3 executors, then a verifier"
 *   "just hypothesize and plan"  /  "full wave with 2 verifiers"
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never
 * build on each other.
 */

import {
  SpawnGuard,
  spawnSubagent,
  runWorkGraph,
  buildExecutionWaves,
  runBoundedPool,
  preflightProviderHealth,
  formatRoutedModel,
  truncateWithNotice,
  throwIfAborted,
  type AgentProfile,
  type SubagentResult,
} from "../substrate";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NormalizedParams,
  InferredModelRouting,
} from "../types";
import { resolveRouteWithFallback, formatRouteLabel, type ResolvedRoute } from "../routes";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateExecutorContextBudget } from "../executor-recovery/budget-estimator";
import { injectContinuationGuardrail } from "../executor-recovery/contract-types";

// ── Types ──────────────────────────────────────────────────────────────────

export type PhaseKind = "research" | "hypothesize" | "critique" | "synthesize" | "plan" | "execute" | "verify";

const PHASE_ORDER: readonly PhaseKind[] = [
  "research", "hypothesize", "critique", "synthesize", "plan", "execute", "verify",
];
/** `full wave` predates research and intentionally retains its original six phases. */
const LEGACY_FULL_WAVE_ORDER: readonly PhaseKind[] = [
  "hypothesize", "critique", "synthesize", "plan", "execute", "verify",
];

export interface PipelinePhase {
  kind: PhaseKind;
  count: number;
  agentName: string;
  promptBuilder: (index: number) => string;
}

export interface PipelineConfig {
  phases: PipelinePhase[];
  /** True only when the caller supplied an authoritative ordered declaration. */
  explicitOrdered?: boolean;
  /** True when only/just caused legacy prose to limit the selected phase list. */
  explicitLimited?: boolean;
}

interface ResearchFinding { index: number; agentName: string; text: string }
interface Hypothesis { index: number; agentName: string; text: string }
interface Critique { index: number; agentName: string; text: string }
interface Synthesis { index: number; agentName: string; text: string }

interface PlanTask {
  id: string; description: string; dependsOn: string[];
  agent?: string; role?: string; model?: string; provider?: string;
}

interface Plan { tasks: PlanTask[]; notes: string; raw?: unknown }
interface CandidatePlan { index: number; agentName: string; plan: Plan; text: string }

interface ExecutorOutput {
  taskId: string; description: string; agentName: string;
  output: string; stderr?: string; exitCode: number | null; durationMs: number;
}

interface VerifierVote {
  verifierIndex: number; agentName: string; status: "pass" | "fail";
  reasons: string[]; raw: string; durationMs: number;
}

interface PipelineAttempt {
  attempt: number;
  executorOutputs: ExecutorOutput[];
  voteResult: { votes: VerifierVote[]; passes: number; fails: number };
  status: "pass" | "fail";
}

type ComposableRole = "planner" | "executor" | "verifier";

interface RoleRoute {
  primary: ResolvedRoute;
  fallbacks: ResolvedRoute[];
}

type ComposableRoutes = Record<ComposableRole, RoleRoute>;
type SelectedRoutes = Record<ComposableRole, ResolvedRoute>;

interface RoutingEvidence {
  phase: PhaseKind;
  phaseIndex: number;
  role: ComposableRole;
  agentName: string;
  provider?: string;
  model?: string;
  evidence: string;
}

interface PreflightEvidence {
  role: ComposableRole;
  provider: string;
  model: string;
  status: "healthy" | "failed" | "skipped";
  selected: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_COUNT = 1;
const MAX_PHASE_CONCURRENCY = 5;
const MAX_VERIFIER_COUNT = 7;
const MAX_FINAL_CHARS = 20_000;
const MAX_DETAIL_CHARS = 4_000;
const MAX_PHASE_CHARS = 4_000;
const DEFAULT_EXEC_CONCURRENCY = 5;
const MAX_TASK_WORDS = 200;

const PHASE_LIMITS: Record<PhaseKind, number> = {
  research: MAX_PHASE_CONCURRENCY,
  hypothesize: MAX_PHASE_CONCURRENCY,
  critique: MAX_PHASE_CONCURRENCY,
  synthesize: MAX_PHASE_CONCURRENCY,
  plan: MAX_PHASE_CONCURRENCY,
  execute: MAX_PHASE_CONCURRENCY,
  verify: MAX_VERIFIER_COUNT,
};

// Deterministic role-safe defaults. Composable phases never derive a route
// from an agent profile or an inferred runtime-role label.
const DEFAULT_ROLE_ROUTES: Record<ComposableRole, ResolvedRoute> = {
  planner: { provider: "openai-codex", model: "gpt-5.6-sol" },
  executor: { provider: "openai-codex", model: "gpt-5.6-sol" },
  verifier: { provider: "openai-codex", model: "gpt-5.5" },
};
const DEFAULT_EXECUTOR_FALLBACK: ResolvedRoute = {
  provider: "openai-codex",
  model: "gpt-5.5",
};
const FORBIDDEN_ROUTE_RE = /(?:deepseek|openrouter)/i;

// ── Exhaustion detection ───────────────────────────────────────────────────

function detectExhaustion(text: string, maxChars: number): boolean {
  // Literal truncation markers
  if (/\b(?:truncated|cut off|too long|exceeded)\b/i.test(text)) return true;
  // Unclosed code fences
  if (((text.match(/```/g) || []).length % 2) !== 0) return true;
  // Subagent truncation markers
  if (/(?:\.\.\.|\[truncated\])\s*$/i.test(text)) return true;
  // Within 200 chars of limit and ends mid-sentence (no terminal punctuation)
  if (text.length >= maxChars - 200) {
    const lastChar = text.trimEnd().slice(-1);
    if (!/[.!?)\]}"']$/.test(lastChar)) return true;
  }
  return false;
}

// ── Phase metadata ─────────────────────────────────────────────────────────

interface PhaseMeta {
  kind: PhaseKind;
  /** Regex for detecting this phase in NL task text. */
  detect: RegExp;
  /** Regex for negating this phase. */
  negateRe: RegExp;
}

// negateRe patterns share a common prefix: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)/
// then each appends the phase-specific word list with plural forms and optional trailing 's'.
const PHASE_META: PhaseMeta[] = [
  {
    kind: "research",
    detect: /\b(?:reconnaissance|research(?:ers?|ed|ing)?|scouts?|scouting)\b/i,
    negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:reconnaissance|research(?:ers?|ing)?|scouts?|scouting)\b/i,
  },
  {
    kind: "hypothesize",
    detect: /\b(?:hypothesiz(?:ers?|e[ds]?|ing)|hypothes(?:is|es))\b/i,
    negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:hypothesiz(?:ers?|e[ds]?|ing)|hypothes(?:is|es))\b/i,
  },
  {
    kind: "critique",
    detect: /\b(?:critics?|critiques?|reviews?|reviewers?)\b/i,
    negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:critics?|critiques?|reviews?|reviewers?)\b/i,
  },
  {
    kind: "synthesize",
    detect: /\b(?:synthesiz(?:ers?|e[ds]?|ing)|synthes(?:is|es))\b/i,
    negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:synthesiz(?:ers?|e[ds]?|ing)|synthes(?:is|es))\b/i,
  },
  {
    kind: "plan",
    detect: /\b(?:planners?|plans?|planning|strategiz(?:e[ds]?|ing))\b/i,
    negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:planners?|plans?|planning|strategiz(?:e[ds]?|ing))\b/i,
  },
  {
    kind: "execute",
    detect: /\b(?:executors?|execut(?:e[ds]?|ions?|ing)|implement(?:s|ers?|ings?|ations?)?|build(?:s|ers?|ings?)?)\b/i,
    negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:executors?|execut(?:e[ds]?|ions?|ing)|implement(?:s|ers?|ings?|ations?)?|build(?:s|ers?|ings?)?)\b/i,
  },
  {
    kind: "verify",
    detect: /\b(?:verif(?:iers?|y|ies|ied|ying|ications?)|checks?|checkers?|checking|validat(?:ors?|e[ds]?|ing|ions?))\b/i,
    negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:verif(?:iers?|y|ies|ied|ying|ications?)|checks?|checkers?|checking|validat(?:ors?|e[ds]?|ing|ions?))\b/i,
  },
];

function getMeta(kind: PhaseKind): PhaseMeta {
  return PHASE_META.find((m) => m.kind === kind)!;
}

function roleForPhase(kind: PhaseKind): ComposableRole {
  if (kind === "execute") return "executor";
  if (kind === "verify") return "verifier";
  return "planner";
}

function splitFallbackRoutes(
  models: string | undefined,
  providers: string | undefined,
  roleDefault: ResolvedRoute,
): ResolvedRoute[] {
  const modelList = (models ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const providerList = (providers ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const count = Math.max(modelList.length, providerList.length);
  const routes: ResolvedRoute[] = [];
  for (let index = 0; index < count; index++) {
    routes.push(resolveRouteWithFallback(
      modelList[index] ?? modelList[modelList.length - 1],
      providerList[index] ?? providerList[providerList.length - 1],
      roleDefault,
    ));
  }
  return routes;
}

function assertAllowedRoute(role: ComposableRole, route: ResolvedRoute, source: string): void {
  if (FORBIDDEN_ROUTE_RE.test(route.provider) || FORBIDDEN_ROUTE_RE.test(route.model)) {
    throw new PipelineConfigurationError(
      "FORBIDDEN_MODEL_ROUTE",
      `${source} route for ${role} uses forbidden provider/model ${route.provider}/${route.model}.`,
      { role, source, provider: route.provider, model: route.model },
    );
  }
}

function resolveComposableRoutes(params: NormalizedParams): ComposableRoutes {
  const plannerPrimary = resolveRouteWithFallback(
    params.plannerModel, params.plannerProvider, DEFAULT_ROLE_ROUTES.planner,
  );
  const executorPrimary = resolveRouteWithFallback(
    params.executorModel, params.executorProvider, DEFAULT_ROLE_ROUTES.executor,
  );
  const verifierPrimary = resolveRouteWithFallback(
    params.verifierModel, params.verifierProvider, DEFAULT_ROLE_ROUTES.verifier,
  );
  const routes: ComposableRoutes = {
    planner: {
      primary: plannerPrimary,
      fallbacks: splitFallbackRoutes(
        params.plannerFallbackModel, params.plannerFallbackProvider, DEFAULT_ROLE_ROUTES.planner,
      ),
    },
    executor: {
      primary: executorPrimary,
      fallbacks: splitFallbackRoutes(
        params.executorFallbackModel, params.executorFallbackProvider, DEFAULT_EXECUTOR_FALLBACK,
      ),
    },
    verifier: {
      primary: verifierPrimary,
      fallbacks: splitFallbackRoutes(
        params.verifierFallbackModel, params.verifierFallbackProvider, DEFAULT_ROLE_ROUTES.verifier,
      ),
    },
  };
  if (routes.executor.fallbacks.length === 0 &&
      (executorPrimary.provider !== DEFAULT_EXECUTOR_FALLBACK.provider ||
       executorPrimary.model !== DEFAULT_EXECUTOR_FALLBACK.model)) {
    routes.executor.fallbacks.push(DEFAULT_EXECUTOR_FALLBACK);
  }
  for (const role of ["planner", "executor", "verifier"] as const) {
    assertAllowedRoute(role, routes[role].primary, "primary");
    routes[role].fallbacks.forEach((route, index) => assertAllowedRoute(role, route, `fallback ${index + 1}`));
  }
  return routes;
}

async function preflightComposableRoutes(
  routes: ComposableRoutes,
  phases: PipelinePhase[],
  params: NormalizedParams,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  evidence: PreflightEvidence[],
): Promise<SelectedRoutes> {
  const selected: SelectedRoutes = {
    planner: routes.planner.primary,
    executor: routes.executor.primary,
    verifier: routes.verifier.primary,
  };
  const usedRoles = new Set(phases.map((phase) => roleForPhase(phase.kind)));

  for (const role of ["planner", "executor", "verifier"] as const) {
    if (!usedRoles.has(role)) continue;
    const candidates = [routes[role].primary, ...routes[role].fallbacks];
    if (!params.preflight) {
      evidence.push({ role, ...candidates[0], status: "skipped", selected: true });
      continue;
    }

    let healthy: ResolvedRoute | undefined;
    for (const [index, route] of candidates.entries()) {
      const [result] = await preflightProviderHealth(
        [{ roles: [`composable-${role}`], provider: route.provider, model: route.model }],
        {
          cwd: params.cwd,
          allowLocalModel: params.allowLocalModel,
          signal,
          onProgress: emit,
          timeoutMs: 20_000,
        },
      );
      const status = result?.ok ? "healthy" : "failed";
      evidence.push({ role, ...route, status, selected: Boolean(result?.ok) });
      if (result?.ok) {
        healthy = route;
        if (index > 0) emit(`Composable ${role} route selected fallback ${index}: ${route.provider}/${route.model}.`);
        break;
      }
    }
    if (!healthy) {
      throw new PipelineConfigurationError(
        "ROUTE_PREFLIGHT_FAILED",
        `No healthy ${role} route remained after ${candidates.length} preflight attempt(s).`,
        { role, candidates },
      );
    }
    selected[role] = healthy;
  }
  return selected;
}

// ── Shape export ───────────────────────────────────────────────────────────

export const composablePipelineShape: OrchestrationShape = {
  name: "composable-pipeline",
  description:
    "Dynamic pipeline composition via natural language. Supports research, hypothesize, critique, " +
    "synthesize, plan, execute, and verify phases with configurable cardinality per phase.",
  run: runComposablePipeline,
};

// ── Main orchestration loop ────────────────────────────────────────────────

async function runComposablePipeline(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents, inferredModelRouting } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const spawnGuard = new SpawnGuard(params.maxSubagents);

  // Parse and validate the entire declared pipeline before the first spawn.
  emit("Composable pipeline: parsing configuration...");
  const rawConfig = parsePipelineConfig(params.task);
  const phases = resolvePipelineConfig(rawConfig, params);
  validatePipelineBeforeSpawn(params.task, rawConfig, phases, params, spawnGuard);
  const configuredRoutes = resolveComposableRoutes(params);
  const routingEvidence: RoutingEvidence[] = [];
  const preflightEvidence: PreflightEvidence[] = [];
  const selectedRoutes = await preflightComposableRoutes(
    configuredRoutes, phases, params, signal, emit, preflightEvidence,
  );
  emit(`Pipeline: ${phases.map((p) => `${p.kind}×${p.count}`).join(" → ") || "(empty)"}`);

  // Accumulated phase results. Candidate plans remain independent until a
  // later critique/synthesis explicitly combines them.
  let research: ResearchFinding[] = [];
  let hypotheses: Hypothesis[] = [];
  let critiques: Critique[] = [];
  let syntheses: Synthesis[] = [];
  let candidatePlans: CandidatePlan[] = [];
  let plan: Plan | null = null;
  let finalPlanSource: "planner" | "synthesis" | "fallback" | null = null;
  let executorOutputs: ExecutorOutput[] = [];
  let voteResult: { votes: VerifierVote[]; passes: number; fails: number } | null = null;
  const attempts: PipelineAttempt[] = [];
  let retryableExecutePhase: PipelinePhase | null = null;
  const expectedExecuteCount = phases.find((phase) => phase.kind === "execute")?.count ?? 1;
  const maxRetries = Number.isFinite(params.maxRetries) ? Math.max(0, Math.trunc(params.maxRetries)) : 0;

  // Declared phases run once. Only the execute→verify segment below can repeat.
  for (const phase of phases) {
    throwIfAborted(signal);
    emit(`Phase ${phase.kind.toUpperCase()}: spawning ${phase.count} agent(s)...`);

    switch (phase.kind) {
      case "research":
        research = await runPhase("research", phase, params, agents, spawnGuard, signal,
          emit, inheritedModel, selectedRoutes.planner, routingEvidence,
          (idx, total) => buildPhasePrompt("research", idx, total, params.task, inferredModelRouting));
        break;
      case "hypothesize":
        hypotheses = await runPhase("hypothesize", phase, params, agents, spawnGuard, signal,
          emit, inheritedModel, selectedRoutes.planner, routingEvidence,
          (idx, total) => buildPhasePrompt("hypothesize", idx, total, params.task, inferredModelRouting));
        break;
      case "critique":
        critiques = await runPhase("critique", phase, params, agents, spawnGuard, signal,
          emit, inheritedModel, selectedRoutes.planner, routingEvidence,
          (idx, total) => buildPhasePrompt("critique", idx, total, params.task, inferredModelRouting,
            hypotheses, undefined, candidatePlans));
        break;
      case "synthesize":
        syntheses = await runPhase("synthesize", phase, params, agents, spawnGuard, signal,
          emit, inheritedModel, selectedRoutes.planner, routingEvidence,
          (idx, total) => buildPhasePrompt("synthesize", idx, total, params.task, inferredModelRouting,
            hypotheses, critiques, candidatePlans, expectedExecuteCount));
        if (candidatePlans.length > 0 && syntheses.length > 0) {
          // The synthesis phase is the declared final-plan conversion. Its JSON
          // is parsed directly; malformed text converts deterministically to a
          // one-task plan via parsePlan (and is transparently marked fallback).
          plan = parsePlan(syntheses[0].text, params.task);
          finalPlanSource = plan.notes.includes("not parseable") ? "fallback" : "synthesis";
          emit(`Final synthesized plan: ${plan.tasks.length} task(s), ${buildExecutionWaves(plan.tasks).length} wave(s).`);
        }
        break;
      case "plan": {
        const plannerOutputs = await runPhase<{ index: number; agentName: string; text: string }>(
          "plan", phase, params, agents, spawnGuard, signal, emit, inheritedModel,
          selectedRoutes.planner, routingEvidence,
          (idx, total) => buildPlanPrompt(params.task, research, hypotheses, critiques, syntheses,
            inferredModelRouting, idx, total, expectedExecuteCount),
        );
        candidatePlans = plannerOutputs.map((output) => ({
          ...output,
          plan: parsePlan(output.text, params.task),
        }));
        plan = candidatePlans[0]?.plan ?? null;
        finalPlanSource = plan ? (plan.notes.includes("not parseable") ? "fallback" : "planner") : null;
        emit(`Plans: ${candidatePlans.length} candidate(s); selected candidate 1 pending any declared critique/synthesis.`);
        break;
      }
      case "execute":
        retryableExecutePhase = phase;
        executorOutputs = await runExecutePhase(params, agents, spawnGuard, signal, emit,
          inheritedModel, selectedRoutes.executor, routingEvidence, plan, phase);
        break;
      case "verify": {
        voteResult = await runVerifyPhase(params, agents, spawnGuard, signal, emit,
          inheritedModel, selectedRoutes.verifier, routingEvidence, inferredModelRouting,
          phase, plan, executorOutputs, hypotheses, critiques, syntheses);
        if (retryableExecutePhase) {
          attempts.push(toAttemptRecord(attempts.length + 1, executorOutputs, voteResult));
          for (let retry = 1; voteResult.passes <= voteResult.fails && retry <= maxRetries; retry++) {
            throwIfAborted(signal);
            emit(`Verifier majority FAIL: retrying execute → verify (${retry}/${maxRetries}).`);
            executorOutputs = await runExecutePhase(params, agents, spawnGuard, signal, emit,
              inheritedModel, selectedRoutes.executor, routingEvidence, plan, retryableExecutePhase);
            voteResult = await runVerifyPhase(params, agents, spawnGuard, signal, emit,
              inheritedModel, selectedRoutes.verifier, routingEvidence, inferredModelRouting,
              phase, plan, executorOutputs, hypotheses, critiques, syntheses);
            attempts.push(toAttemptRecord(attempts.length + 1, executorOutputs, voteResult));
          }
        }
        break;
      }
    }
  }

  let status: "pass" | "fail" = "pass";
  if (voteResult) status = voteResult.passes > voteResult.fails ? "pass" : "fail";

  const artifacts: PhaseArtifacts = {
    research, hypotheses, critiques, syntheses, candidatePlans, plan, finalPlanSource,
    executorOutputs, voteResult, attempts, selectedRoutes, routingEvidence, preflightEvidence,
  };
  const details = buildDetails(status, params, spawnGuard, phases, artifacts);
  const markdown = buildFinalResult(status, params, spawnGuard, phases, artifacts);
  return { markdown, details };
}

// ── Generic phase runner (hypothesize / critique / synthesize) ─────────────

async function runPhase<T extends { index: number; agentName: string; text: string }>(
  kind: PhaseKind,
  phase: PipelinePhase,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  route: ResolvedRoute,
  routingEvidence: RoutingEvidence[],
  buildPrompt: (index: number, total: number) => string,
): Promise<T[]> {
  const items = Array.from({ length: phase.count }, (_, i) => i);
  const results = await runBoundedPool(items, MAX_PHASE_CONCURRENCY, signal, async (index, _pi, ws) => {
    const prompt = buildPrompt(index, phase.count);
    const result = await spawnChecked(
      spawnGuard, params, agents, phase.agentName, prompt, ws, emit,
      inheritedModel, route, roleForPhase(kind), kind, index + 1, routingEvidence,
    );

    // Budget estimation
    const budgetModel = route.model;
    const budget = estimateExecutorContextBudget(prompt.length, budgetModel, { criticalThreshold: 60 });
    if (budget.saturationPercent > 60) {
      emit(`Phase ${phase.kind} agent ${index + 1}: pre-spawn budget ${budget.saturationPercent}% sat (${budget.risk}) — risk of context exhaustion.`);
    }

    // Context exhaustion detection
    const exhausted = detectExhaustion(result.text, MAX_PHASE_CHARS);
    if (exhausted) {
      emit(`Phase ${phase.kind} agent ${index + 1}: WARNING — context exhaustion detected in output.`);
    }

    return { index, agentName: result.agentName, text: result.text } as T;
  });

  // Phase output bug reporting
  const bugs: string[] = [];
  results.forEach((r) => {
    if (!r.text || r.text.trim().length === 0) {
      const msg = `BUG: Phase ${phase.kind} agent ${r.index + 1} returned empty output`;
      bugs.push(msg); emit(msg);
    } else {
      const errMatch = /(?:error|failed|exception|cannot|unable)/i.exec(r.text);
      if (errMatch) {
        const start = Math.max(0, errMatch.index - 50);
        const end = Math.min(r.text.length, errMatch.index + 50);
        const context = r.text.slice(start, end).substring(0, 100);
        const msg = `BUG: Phase ${phase.kind} agent ${r.index + 1} output contains potential error: ${context}`;
        bugs.push(msg); emit(msg);
      }
    }
  });
  if (bugs.length > 0) {
    emit(`Phase ${phase.kind}: ${bugs.length} bug(s) detected across ${results.length} agent(s)`);
  }

  return results;
}

// ── Execute phase (plan → waves → work graph) ─────────────────────────────

async function runExecutePhase(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  route: ResolvedRoute,
  routingEvidence: RoutingEvidence[],
  plan: Plan | null,
  phase: PipelinePhase,
): Promise<ExecutorOutput[]> {
  const effective = (plan && plan.tasks.length > 0) ? plan : {
    tasks: [{ id: "task-1", description: params.task, dependsOn: [] }],
    notes: "No plan was produced; falling back to single executor task.",
  };
  const executionTasks = buildExecutionTasks(effective, phase.count);

  // Task-size cap enforcement
  for (const task of executionTasks) {
    const words = task.description.split(/\s+/).length;
    if (words > MAX_TASK_WORDS) {
      emit(`Task ${task.id}: WARNING — description is ${words} words (cap: ${MAX_TASK_WORDS}). Consider splitting.`);
      task.description = task.description.split(/\s+/).slice(0, MAX_TASK_WORDS).join(" ") + "...";
    }
  }

  const waves = buildExecutionWaves(executionTasks);

  const results = await runWorkGraph(waves, DEFAULT_EXEC_CONCURRENCY, signal, async (task, phaseIndex, ws) => {
    const prompt = buildExecutorPrompt(params.task, effective, task);
    const resolvedAgent = task.agent?.trim() && agents.has(task.agent.trim())
      ? task.agent.trim() : params.executorAgent;
    if (resolvedAgent !== params.executorAgent) {
      emit(`Task ${task.id}: assigned to "${resolvedAgent}" (role: ${task.role ?? "(none)"}).`);
    }
    if (normalizePlannerRouteHint(task.model) || normalizePlannerRouteHint(task.provider)) {
      emit(`Task ${task.id}: ignored planner-authored route fields; using the preflighted executor route ${route.provider}/${route.model}.`);
    }
    const result = await spawnChecked(
      spawnGuard, params, agents, resolvedAgent, prompt, ws, emit, inheritedModel,
      route, "executor", "execute", phaseIndex + 1, routingEvidence, true,
    );

    // Budget estimation
    const budget = estimateExecutorContextBudget(prompt.length, params.executorModel, { criticalThreshold: 60 });
    if (budget.saturationPercent > 60) {
      emit(`Task ${task.id}: pre-spawn budget: ${budget.saturationPercent}% sat (${budget.risk}) — risk of context exhaustion.`);
    }

    // Context exhaustion detection
    const exhausted = detectExhaustion(result.text, MAX_PHASE_CHARS);
    if (exhausted) {
      emit(`Task ${task.id}: WARNING — context exhaustion detected in executor output.`);
    }

    return {
      taskId: task.id, description: task.description, agentName: result.agentName,
      output: result.text, stderr: result.stderr || undefined,
      exitCode: result.exitCode, durationMs: result.durationMs,
    };
  });

  // Artifact evidence collection
  try {
    const gitResult = spawnSync("git", ["status", "--short"], { cwd: params.cwd, encoding: "utf-8", timeout: 5000 });
    if (gitResult.status === 0 && gitResult.stdout.trim()) {
      const changedFiles = gitResult.stdout.trim().split("\n").filter(Boolean);
      emit(`Artifact evidence: ${changedFiles.length} file(s) on disk.`);
      // Check for implementation tasks with zero file changes
      const implTasks = plan?.tasks.filter(t =>
        /\b(?:CREATE|IMPLEMENT|BUILD|MODIFY|ADD|WRITE|GENERATE|EDIT|CHANGE|FIX|REFACTOR)\b/i.test(t.description)
      ) ?? [];
      if (implTasks.length > 0 && changedFiles.length === 0) {
        emit("HARD GATE WARNING: Implementation tasks exist but ZERO files changed on disk. Executors may have produced text-only responses.");
      }
    } else {
      emit("Artifact evidence: git not available or no changes detected.");
    }
  } catch { emit("Artifact evidence: git collection failed."); }

  return results;
}

/** Make the declared execute cardinality equal the number of mutating spawns. */
function buildExecutionTasks(plan: Plan, count: number): PlanTask[] {
  if (count === 1) {
    if (plan.tasks.length === 1) return plan.tasks;
    return [{
      id: "execution-1",
      description: "Execute every task in the final plan exactly once, preserving its dependency order.",
      dependsOn: [],
    }];
  }
  if (plan.tasks.length !== count) {
    throw new PipelineConfigurationError(
      "EXECUTE_CARDINALITY_MISMATCH",
      `Declared execute×${count} requires a final plan with exactly ${count} tasks; received ${plan.tasks.length}.`,
      { executeCount: count, finalPlanTaskCount: plan.tasks.length },
    );
  }
  return plan.tasks;
}

// ── Verify phase (N verifiers → majority vote) ────────────────────────────

async function runVerifyPhase(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  route: ResolvedRoute,
  routingEvidence: RoutingEvidence[],
  inferredModelRouting: InferredModelRouting,
  phase: PipelinePhase,
  plan: Plan | null,
  executorOutputs: ExecutorOutput[],
  hypotheses: Hypothesis[],
  critiques: Critique[],
  syntheses: Synthesis[],
): Promise<{ votes: VerifierVote[]; passes: number; fails: number }> {
  const count = Math.min(phase.count, MAX_VERIFIER_COUNT);
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), "pi-composable-verifier-"));
  const verifiers = Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    agentName: params.verifierAgent,
    prompt: buildVerifierPrompt(i + 1, count, params.task, plan, executorOutputs,
      hypotheses, critiques, syntheses, inferredModelRouting, artifactDir),
  }));

  let votes: VerifierVote[];
  try {
    votes = await runBoundedPool(verifiers, Math.min(MAX_PHASE_CONCURRENCY, count), signal,
      async (verifier, _pi, ws) => {
        emit(`Verifier ${verifier.index}/${count} starting...`);
        const startedAt = Date.now();
        const result = await spawnChecked(
          spawnGuard, params, agents, verifier.agentName, verifier.prompt, ws, emit,
          inheritedModel, route, "verifier", "verify", verifier.index, routingEvidence,
        );
        const parsed = parseVerifierResult(result.text);
        emit(`Verifier ${verifier.index}/${count}: ${parsed.status.toUpperCase()} (${parsed.reasons.join("; ") || "no reasons"}).`);
        return {
          verifierIndex: verifier.index, agentName: result.agentName,
          status: parsed.status, reasons: parsed.reasons, raw: result.text,
          durationMs: Date.now() - startedAt,
        };
      },
    );
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }

  const passes = votes.filter((v) => v.status === "pass").length;
  const fails = votes.length - passes;
  emit(`Majority vote: ${passes} PASS, ${fails} FAIL → ${passes > fails ? "PASS" : "FAIL"}.`);
  return { votes, passes, fails };
}

// ── Prompt builders ────────────────────────────────────────────────────────

function buildPhasePrompt(
  kind: "research" | "hypothesize" | "critique" | "synthesize",
  index: number,
  total: number,
  originalTask: string,
  inferred: InferredModelRouting,
  hypotheses?: Hypothesis[],
  critiques?: Critique[],
  candidatePlans?: CandidatePlan[],
  expectedExecuteCount = 1,
): string {
  const labels: Record<string, string> = {
    research: `researcher ${index + 1} of ${total}`,
    hypothesize: `hypothesizer ${index + 1} of ${total}`,
    critique: `critic ${index + 1} of ${total}`,
    synthesize: `synthesizer ${index + 1} of ${total}`,
  };
  const instructions: Record<string, string> = {
    research: "Perform bounded reconnaissance/research. Gather concrete evidence and constraints; do NOT plan or execute.",
    hypothesize: "Generate hypotheses, approaches, or interpretations. Be creative — do NOT execute.",
    critique: candidatePlans?.length
      ? "Critically compare every candidate plan for gaps, risks, dependency errors, and task fit. Do NOT execute."
      : "Critically review the hypotheses for weaknesses, gaps, risks, and assumptions. Be thorough — do NOT execute.",
    synthesize: candidatePlans?.length
      ? `Synthesize the candidate plans and critiques into the FINAL execution plan. Return ONLY parseable JSON with exactly ${expectedExecuteCount} task(s): {"tasks":[{"id":"task-1","description":"...","dependsOn":[]}],"notes":"..."}. Do NOT execute.`
      : "Synthesize hypotheses and critiques into a coherent, actionable understanding. Do NOT execute.",
  };
  // Routing is selected structurally before spawn; natural-language/profile
  // hints are intentionally not echoed as authority in composed-seat prompts.
  void inferred;
  let extra = "";
  if (hypotheses && hypotheses.length > 0) {
    const truncated = hypotheses.map((h) =>
      `### H${h.index + 1} (${h.agentName})\n${truncateWithNotice(h.text, MAX_PHASE_CHARS, `hypothesis H${h.index + 1}`)}`
    ).join("\n\n");
    extra += "\n## Hypotheses\n" + truncateWithNotice(truncated, MAX_PHASE_CHARS * 3 / 2, "all hypotheses");
  }
  if (candidatePlans && candidatePlans.length > 0) {
    const truncated = candidatePlans.map((candidate) =>
      `### Candidate Plan ${candidate.index + 1} (${candidate.agentName})\n${truncateWithNotice(candidate.text, MAX_PHASE_CHARS, `candidate plan ${candidate.index + 1}`)}`
    ).join("\n\n");
    extra += "\n\n## Candidate Plans\n" + truncateWithNotice(truncated, MAX_PHASE_CHARS * 2, "all candidate plans");
  }
  if (critiques && critiques.length > 0) {
    const truncated = critiques.map((c) =>
      `### C${c.index + 1} (${c.agentName})\n${truncateWithNotice(c.text, MAX_PHASE_CHARS, `critique C${c.index + 1}`)}`
    ).join("\n\n");
    extra += "\n\n## Critiques\n" + truncateWithNotice(truncated, MAX_PHASE_CHARS * 3 / 2, "all critiques");
  }
  return `You are ${labels[kind]} in a composable orchestration pipeline.\n${instructions[kind]}\n\nOriginal task:\n${originalTask}${extra}\n\n${candidatePlans?.length && kind === "synthesize" ? "Return only the final plan JSON." : "Return your response as structured text."}`;
}

function buildPlanPrompt(
  originalTask: string,
  research: ResearchFinding[],
  hypotheses: Hypothesis[],
  critiques: Critique[],
  syntheses: Synthesis[],
  inferred: InferredModelRouting,
  plannerIndex: number,
  plannerTotal: number,
  expectedExecuteCount: number,
): string {
  void inferred;
  const prior = [
    ...research.map((item) => `## Research ${item.index + 1}\n${truncateWithNotice(item.text, MAX_PHASE_CHARS, "research")}`),
    ...hypotheses.map((item) => `## Hypothesis ${item.index + 1}\n${truncateWithNotice(item.text, MAX_PHASE_CHARS, "hypothesis")}`),
    ...critiques.map((item) => `## Critique ${item.index + 1}\n${truncateWithNotice(item.text, MAX_PHASE_CHARS, "critique")}`),
    ...syntheses.map((item) => `## Synthesis ${item.index + 1}\n${truncateWithNotice(item.text, MAX_PHASE_CHARS, "synthesis")}`),
  ];
  const priorText = truncateWithNotice(prior.join("\n\n") || "_No prior phase output._", MAX_PHASE_CHARS * 3, "prior phase outputs");
  return `You are independent planner ${plannerIndex + 1} of ${plannerTotal} in a composable orchestration pipeline. Produce your own candidate execution plan; do not copy another planner. Return JSON:\n{"tasks":[{"id":"...","description":"...","dependsOn":[]}],"notes":"..."}\n\nOriginal task:\n${originalTask}\n\nPrior phase outputs:\n${priorText}\n\nRules: Return exactly ${expectedExecuteCount} task(s) so declared execute cardinality is honored. Keep task IDs stable (task-1, task-2...). Make descriptions self-contained. Do not execute. Route selection is orchestrator-owned; do not emit agent/model/provider fields.`;
}

function buildExecutorPrompt(originalTask: string, plan: Plan, task: PlanTask): string {
  // Escape clause scanning & rewriting
  const escapeClauses = scanEscapeClauses(task.description);
  let sanitizedDescription = task.description;
  let escapeNote = "";
  if (escapeClauses.length > 0) {
    sanitizedDescription = rewriteEscapeClauses(task.description);
    escapeNote = "\n\nANTI-ESCAPE NOTE: Your task description contained escape clauses (" +
      escapeClauses.join(", ") + ") which have been removed. Do the actual work — do NOT check if it already exists.";
  }
  const sanitizedTask = { ...task, description: sanitizedDescription };

  // Output type contract
  const isImpl = /\b(?:CREATE|IMPLEMENT|BUILD|MODIFY|ADD|WRITE|GENERATE|EDIT|CHANGE|FIX|REFACTOR)\b/i.test(task.description);
  const isValid = /\b(?:VERIFY|VALIDATE|CHECK|CONFIRM|TEST|ASSESS|INSPECT|AUDIT)\b/i.test(task.description);
  let outputTypeBlock = "";
  if (isImpl) {
    outputTypeBlock = "\n\nOUTPUT TYPE CONTRACT: This is a file_change task. You MUST use write, edit, or bash tools to produce actual file artifacts on disk. A text-only response without creating or modifying any files is a FAILURE.";
  } else if (isValid) {
    outputTypeBlock = "\n\nOUTPUT TYPE CONTRACT: This is a validation task. You are checking or inspecting existing state. Provide concrete evidence (file reads, command output, test results) in your response.";
  }

  const planJson = truncateWithNotice(JSON.stringify(plan, null, 2), MAX_PHASE_CHARS * 2, "full plan");
  const taskJson = JSON.stringify(sanitizedTask, null, 2);
  const guardrail = injectContinuationGuardrail(task.id);
  return `You are executing one task from a deterministic composable orchestration.\n\nOriginal task:\n${originalTask}\n\nFull plan:\n${planJson}\n\nAssigned executor task:\n${taskJson}${escapeNote}${outputTypeBlock}\n\nComplete only the assigned task. Return a concise report.\n${guardrail}`;
}

function buildVerifierPrompt(
  verifierIndex: number, totalVerifiers: number,
  originalTask: string, plan: Plan | null, executorOutputs: ExecutorOutput[],
  hypotheses: Hypothesis[], critiques: Critique[], syntheses: Synthesis[],
  inferred: InferredModelRouting, artifactDir: string,
): string {
  void inferred;
  const planJson = plan
    ? truncateWithNotice(JSON.stringify(plan, null, 2), MAX_PHASE_CHARS * 2, "plan JSON")
    : "(no plan)";
  const truncatedOutputs = executorOutputs.map((o) => ({
    ...o,
    output: truncateWithNotice(o.output, MAX_PHASE_CHARS, `output ${o.taskId}`),
    stderr: o.stderr ? truncateWithNotice(o.stderr, MAX_PHASE_CHARS, `stderr ${o.taskId}`) : undefined,
  }));
  const outputsJson = truncateWithNotice(
    JSON.stringify(truncatedOutputs, null, 2),
    MAX_PHASE_CHARS * 4,
    "executor outputs",
  );
  return `You are verifier ${verifierIndex} of ${totalVerifiers} in a composable orchestration.\nJudge whether executor outputs satisfy the original task via majority vote.\n\nOriginal task:\n${originalTask}\n\nPlan:\n${planJson}\n\nExecutor outputs:\n${outputsJson}\n\nVERIFIER ARTIFACT POLICY:\n- Return the verdict inline; never write the verdict/report into the project or arbitrary system-temp paths.\n- If a command absolutely requires temporary output, use only this run-owned directory: ${artifactDir}\n- Do not modify product/project files. The orchestrator removes the run-owned directory in a finally block.\n\nReturn JSON: {"status":"pass"|"fail","reasons":["..."]}\n\nVote independently. Use "pass" only if all outputs clearly satisfy the task. Be strict.`;
}

// ── Natural language pipeline parser ───────────────────────────────────────

/**
 * Parse NL task text → PipelineConfig.
 * "full wave" → all 6 phases. "just hypothesize and plan" → limits to those.
 * "no verifier" / "skip critique" → removes phases. "3 hypothesizers" → count.
 */
function parsePipelineConfig(task: string): PipelineConfig {
  const lower = task.toLowerCase();
  const orderedDeclaration = extractOrderedDeclaration(task);
  if (orderedDeclaration) {
    const phases = parseOrderedPhases(orderedDeclaration);
    if (phases.length === 0) {
      throw new PipelineConfigurationError(
        "EMPTY_ORDERED_PIPELINE",
        "An explicit ordered phase declaration was present but contained no recognized phases.",
        { declaration: orderedDeclaration },
      );
    }
    const seen = new Set<PhaseKind>();
    for (const phase of phases) {
      if (seen.has(phase.kind)) {
        throw new PipelineConfigurationError(
          "DUPLICATE_ORDERED_PHASE",
          `Explicit ordered pipeline repeats ${phase.kind}; repeated phase segments are not supported safely.`,
          { phase: phase.kind },
        );
      }
      seen.add(phase.kind);
      assertPhaseCountWithinBounds(phase.kind, phase.count);
    }
    return { phases, explicitOrdered: true, explicitLimited: false };
  }

  // In legacy unordered mode, only/just authoritatively limits phase detection
  // and cardinality parsing to its controlled phase-list clause. Task intent
  // outside that clause still participates in implementation safety checks.
  const limitedClause = extractLimitedPhaseClause(lower);
  const justMode = limitedClause !== null;
  const phaseScan = limitedClause ?? lower;
  const negationScan = lower.replace(
    /\bno\s+execution\s+before\s+(?:the\s+)?execute\s+phase\b/g,
    "",
  );
  const negated: Set<PhaseKind> = new Set();
  for (const meta of PHASE_META) {
    if (meta.negateRe.test(negationScan)) negated.add(meta.kind);
  }

  const counts = new Map<PhaseKind, number>();
  for (const meta of PHASE_META) {
    const count = findExplicitPhaseCount(phaseScan, meta);
    if (count !== undefined) {
      assertPhaseCountWithinBounds(meta.kind, count);
      counts.set(meta.kind, count);
    }
  }

  let active: PhaseKind[];
  const fullMatch = /\b(?:full(?:\s+wave)?|all(?:\s+phases|\s+stages)?)\b/i.test(lower);
  if (justMode) {
    active = PHASE_ORDER.filter((p) => !negated.has(p) && getMeta(p).detect.test(phaseScan));
  } else if (fullMatch) {
    active = LEGACY_FULL_WAVE_ORDER.filter((p) => !negated.has(p));
  } else {
    active = PHASE_ORDER.filter((p) => !negated.has(p) && getMeta(p).detect.test(lower));
  }

  const phases = active.map((kind) => makePipelinePhase(kind, counts.get(kind) ?? DEFAULT_COUNT));
  return { phases, explicitOrdered: false, explicitLimited: justMode };
}

/**
 * Find a syntactically explicit phase count without conflating zero with
 * "unspecified". Aliases come from the phase detector so prefix/suffix forms
 * cannot drift apart: `0 plan`, `x0 plan`, `plan x0`, and their ×/signed forms.
 */
function findExplicitPhaseCount(text: string, meta: PhaseMeta): number | undefined {
  const aliasSource = meta.detect.source.replace(/^\\b/, "").replace(/\\b$/, "");
  const countRe = new RegExp(
    `(?:^|[\\s,;:(])(?:(?:x|×)\\s*)?([+-]?(?:\\d+|infinity|inf|nan))\\s*(?:${aliasSource})\\b|` +
    `(?:${aliasSource})\\b\\s*(?:x|×)\\s*([+-]?(?:\\d+|infinity|inf|nan))\\b`,
    "i",
  );
  const match = countRe.exec(text);
  const explicit = match?.[1] ?? match?.[2];
  return explicit === undefined ? undefined : Number(explicit);
}

/**
 * Extract the contiguous phase list governed by only/just. The parser accepts
 * normal list punctuation/connectives, but stops as soon as prose resumes, so
 * phase words in earlier task intent or later explanatory clauses cannot leak
 * into the authoritative limiter.
 */
function extractLimitedPhaseClause(task: string): string | null {
  const aliasSource = PHASE_META
    .map((meta) => `(?:${meta.detect.source.replace(/^\\b/, "").replace(/\\b$/, "")})`)
    .join("|");
  const countSource = "[+-]?(?:\\d+|infinity|inf|nan)";
  const tokenRe = new RegExp(
    `(?:(?:(?:x|×)\\s*)?${countSource}\\s*)?\\b(?:${aliasSource})\\b` +
    `(?:\\s*(?:x|×)\\s*${countSource}\\b)?`,
    "gi",
  );
  const markerRe = /\b(?:only|just)\b/gi;
  let marker: RegExpExecArray | null;

  while ((marker = markerRe.exec(task))) {
    const tail = task.slice(markerRe.lastIndex);
    const tokens = [...tail.matchAll(tokenRe)];
    if (tokens.length === 0) continue;

    const first = tokens[0];
    const firstIndex = first.index ?? 0;
    const prelude = tail.slice(0, firstIndex);
    if (!isLimitedPhasePrelude(prelude)) continue;

    let end = firstIndex + first[0].length;
    for (let index = 1; index < tokens.length; index++) {
      const token = tokens[index];
      const tokenIndex = token.index ?? end;
      if (!isLimitedPhaseConnector(tail.slice(end, tokenIndex))) break;
      end = tokenIndex + token[0].length;
    }
    return tail.slice(firstIndex, end).trim();
  }
  return null;
}

function isLimitedPhasePrelude(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const allowed = new Set([
    "run", "use", "include", "perform", "do", "have", "these", "the",
    "following", "phases", "phase", "stages", "stage", "pipeline", "of",
    "with", "consisting",
  ]);
  return words.every((word) => allowed.has(word));
}

function isLimitedPhaseConnector(text: string): boolean {
  return /^[\s,:/+&]*(?:(?:and|then|plus|followed\s+by)\b[\s,:/+&]*)?(?:(?:a|an|one)\b[\s,:/+&]*)?$/i.test(text);
}

function extractOrderedDeclaration(task: string): string | null {
  const exact = task.match(/\b(?:in\s+this\s+exact\s+order|in\s+exact\s+order|exact\s+order)\s*:\s*([^\n.]+)/i);
  if (exact?.[1]) return exact[1].trim();
  if (!/(?:->|→)/.test(task)) return null;

  // Arrow declarations are structural. Select exactly one phase token from
  // each arrow-delimited segment (nearest the arrow), rather than scanning all
  // surrounding prose. This prevents "Implement X. plan -> execute" from
  // injecting an extra execute phase from the word "Implement".
  const segments = task.split(/\s*(?:->|→)\s*/);
  if (segments.length < 2) return null;
  const selected = segments.map((segment, index) =>
    selectOrderedToken(segment, index === 0 ? "last" : "first"));
  if (selected.some((token) => token === null)) return null;
  return selected.join(" -> ");
}

function selectOrderedToken(segment: string, which: "first" | "last"): string | null {
  const matches: Array<{ index: number; text: string }> = [];
  for (const meta of PHASE_META) {
    const re = new RegExp(meta.detect.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(segment))) {
      let start = match.index;
      let end = match.index + match[0].length;
      const prefix = segment.slice(0, start).match(/(?:(?:x|×)\s*)?[+-]?(?:\d+|infinity|inf|nan)\s*$/i);
      if (prefix) start -= prefix[0].length;
      const suffix = segment.slice(end).match(/^\s*(?:x|×)\s*[+-]?(?:\d+|infinity|inf|nan)\b/i);
      if (suffix) end += suffix[0].length;
      matches.push({ index: match.index, text: segment.slice(start, end).trim() });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  if (matches.length === 0) return null;
  return (which === "first" ? matches[0] : matches[matches.length - 1]).text;
}

function phaseKindFromAlias(alias: string): PhaseKind {
  const value = alias.toLowerCase();
  if (/^(?:reconnaissance|research|scout)/.test(value)) return "research";
  if (/^hypothes/.test(value)) return "hypothesize";
  if (/^(?:critic|critique|review)/.test(value)) return "critique";
  if (/^synthes/.test(value)) return "synthesize";
  if (/^(?:plan|strategiz)/.test(value)) return "plan";
  if (/^(?:execut|implement|build)/.test(value)) return "execute";
  return "verify";
}

function parseOrderedPhases(declaration: string): PipelinePhase[] {
  const tokenRe = /(?:^|[\s,;:(])(?:(?:(?:x|×)\s*)?([+-]?(?:\d+|infinity|inf|nan))\s*)?(reconnaissance|research(?:ers?|ed|ing)?|scouts?|scouting|hypothesiz(?:ers?|e[ds]?|ing)|hypothes(?:is|es)|critics?|critiques?|reviews?|reviewers?|synthesiz(?:ers?|e[ds]?|ing)|synthes(?:is|es)|planners?|plans?|planning|strategiz(?:e[ds]?|ing)|executors?|execut(?:e[ds]?|ions?|ing)|implement(?:s|ers?|ings?|ations?)?|build(?:s|ers?|ings?)?|verif(?:iers?|y|ies|ied|ying|ications?)|checks?|checkers?|checking|validat(?:ors?|e[ds]?|ing|ions?))\b(?:\s*(?:x|×)\s*([+-]?(?:\d+|infinity|inf|nan))\b)?/gi;
  const phases: PipelinePhase[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(declaration))) {
    const kind = phaseKindFromAlias(match[2]);
    const count = Number(match[1] ?? match[3] ?? DEFAULT_COUNT);
    phases.push(makePipelinePhase(kind, count));
  }
  return phases;
}

function makePipelinePhase(kind: PhaseKind, count: number): PipelinePhase {
  return {
    kind,
    count,
    agentName: getDefaultAgent(kind, "planner", "coder", "reviewer"),
    promptBuilder: (_idx: number) => "",
  };
}

function assertPhaseCountWithinBounds(kind: PhaseKind, count: number): void {
  const limit = PHASE_LIMITS[kind];
  if (!Number.isInteger(count) || count < 1 || count > limit) {
    throw new PipelineConfigurationError(
      "PHASE_COUNT_OUT_OF_BOUNDS",
      `Phase ${kind} count ${count} is invalid; supported range is 1..${limit}.`,
      { phase: kind, count, limit },
    );
  }
}

class PipelineConfigurationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(`[COMPOSABLE_PIPELINE_CONFIG:${code}] ${message}`);
    this.name = "PipelineConfigurationError";
    this.code = code;
    this.details = details;
  }
}

function isImplementationRequest(task: string): boolean {
  return /\b(?:(?:implement|fix|repair|build|create|modify|edit|write|add|change|refactor)(?:s|ed|ing)?|implementation|file\s+change|code\s+change)\b/i.test(task);
}

function hasExplicitSkipExecute(task: string): boolean {
  const scan = task.replace(
    /\bno[\s,:;_\-]*execution\s+before\s+(?:the\s+)?execute\s+phase\b/gi,
    "",
  );
  const executeNoun = "(?:execute|execution|executors?|implementation|implementing|build(?:ing)?)";
  return new RegExp(
    `\\b(?:skip|omit)(?:[\\s,:;_\\-]+)(?:the[\\s,:;_\\-]+)?${executeNoun}(?:[\\s_-]+phase)?\\b`,
    "i",
  ).test(scan) || new RegExp(
    `\\bwithout(?:[\\s,:;_\\-]+)(?:(?:an?|the)[\\s,:;_\\-]+)?${executeNoun}(?:[\\s_-]+phase)?\\b`,
    "i",
  ).test(scan) || new RegExp(
    `\\bno(?:[\\s,:;_\\-]+)(?:(?:llm|agent|subagent)[\\s,:;_\\-]+)?${executeNoun}(?:[\\s_-]+phase)?\\b`,
    "i",
  ).test(scan) || new RegExp(
    `\\b(?:(?:do|must|should)\\s+not|never)[\\s,:;_\\-]+(?:${executeNoun}|implement|build)\\b`,
    "i",
  ).test(scan) || /\b(?:execution|execute\s+phase)\s+(?:is\s+)?(?:forbidden|prohibited|disallowed)\b/i.test(scan);
}

function validatePipelineBeforeSpawn(
  task: string,
  config: PipelineConfig,
  phases: PipelinePhase[],
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
): void {
  const kinds = phases.map((phase) => phase.kind);
  if (isImplementationRequest(task)) {
    if (hasExplicitSkipExecute(task)) {
      throw new PipelineConfigurationError(
        "CONTRADICTORY_SKIP_EXECUTE",
        "Implementation work explicitly skips execute; refusing to run a non-mutating pipeline.",
        { pipeline: kinds },
      );
    }
    if ((config.explicitOrdered || config.explicitLimited) && !kinds.includes("execute")) {
      throw new PipelineConfigurationError(
        "IMPLEMENTATION_PIPELINE_OMITS_EXECUTE",
        "Implementation work explicitly limits the pipeline but omits execute.",
        { pipeline: kinds },
      );
    }
  }

  phases.forEach((phase) => assertPhaseCountWithinBounds(phase.kind, phase.count));
  const executeIndex = kinds.indexOf("execute");
  const verifyIndex = kinds.indexOf("verify");
  const retrySegmentExists = executeIndex >= 0 && verifyIndex > executeIndex;
  const baseSpawns = phases.reduce((sum, phase) => sum + phase.count, 0);
  const maxRetries = Number.isFinite(params.maxRetries) ? Math.max(0, Math.trunc(params.maxRetries)) : 0;
  const retrySpawns = retrySegmentExists
    ? maxRetries * (phases[executeIndex].count + phases[verifyIndex].count)
    : 0;
  const requiredSpawns = baseSpawns + retrySpawns;
  if (!spawnGuard.wouldFit(requiredSpawns)) {
    throw new PipelineConfigurationError(
      "SUBAGENT_BUDGET_TOO_SMALL",
      `Pipeline requires ${requiredSpawns} spawn slots but maxSubagents is ${spawnGuard.cap}.`,
      { baseSpawns, retrySpawns, requiredSpawns, maxSubagents: spawnGuard.cap },
    );
  }
}

function toAttemptRecord(
  attempt: number,
  executorOutputs: ExecutorOutput[],
  voteResult: { votes: VerifierVote[]; passes: number; fails: number },
): PipelineAttempt {
  return {
    attempt,
    executorOutputs,
    voteResult,
    status: voteResult.passes > voteResult.fails ? "pass" : "fail",
  };
}

function scanEscapeClauses(description: string): string[] {
  const patterns = [
    /\bor\s+repair\b/i, /\bor\s+verify\b/i, /\bor\s+validate\b/i,
    /\bif\s+already\s+(done|exists|implemented)\b/i, /\bjust\s+check\b/i,
    /\bsimply\s+check\b/i, /\bno\s+changes\s+needed\b/i,
    /\balready\s+(exists|implemented|done)\b/i, /\bcheck\s+if\s+exists\b/i,
  ];
  return patterns.filter(p => p.test(description)).map(p => {
    const m = description.match(p);
    return m ? m[0] : p.source;
  });
}

function rewriteEscapeClauses(description: string): string {
  return description
    .replace(/\bor\s+repair\b/gi, "")
    .replace(/\bor\s+verify\b/gi, "")
    .replace(/\bor\s+validate\b/gi, "")
    .replace(/\bif\s+already\s+(done|exists|implemented)\b/gi, "")
    .replace(/\bjust\s+check\b/gi, "")
    .replace(/\bsimply\s+check\b/gi, "")
    .replace(/\bno\s+changes\s+needed\b/gi, "")
    .replace(/\balready\s+(exists|implemented|done)\b/gi, "")
    .replace(/\bcheck\s+if\s+exists\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function resolvePipelineConfig(config: PipelineConfig, params: NormalizedParams): PipelinePhase[] {
  return config.phases.map((phase) => ({
    ...phase,
    agentName: getDefaultAgent(phase.kind, params.plannerAgent, params.executorAgent, params.verifierAgent),
    promptBuilder: (_idx: number) => "",
  }));
}

function getDefaultAgent(kind: PhaseKind, planner: string, executor: string, verifier: string): string {
  switch (kind) {
    case "research": return "researcher";
    case "plan": return planner;
    case "verify": return verifier;
    default: return executor;
  }
}

export { parsePipelineConfig, resolvePipelineConfig };

// ── Parsing helpers ────────────────────────────────────────────────────────

function parsePlan(text: string, originalTask: string): Plan {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    if (Array.isArray(raw.tasks)) {
      const tasks = (raw.tasks as unknown[])
        .map((item, index) => normalizePlanTask(item, index))
        .filter((t): t is PlanTask => Boolean(t));
      if (tasks.length > 0) return { tasks, notes: optStr(raw.notes) ?? "", raw: parsed };
    }
  }
  const fallback = text.trim() || originalTask;
  return {
    tasks: [{ id: "task-1", description: fallback, dependsOn: [] }],
    notes: "Planner output was not parseable; fell back to one executor task.",
    raw: text,
  };
}

function normalizePlanTask(item: unknown, index: number): PlanTask | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const desc = optStr(raw.description)?.trim();
  if (!desc) return null;
  return {
    id: optStr(raw.id)?.trim() || `task-${index + 1}`,
    description: desc,
    dependsOn: strArr(raw.dependsOn) ?? [],
    agent: optStr(raw.agent),
    role: optStr(raw.role),
    model: optStr(raw.model),
    provider: optStr(raw.provider),
  };
}

function parseVerifierResult(text: string): { status: "pass" | "fail"; reasons: string[]; raw: string } {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    const status = String(raw.status ?? "").toLowerCase();
    if (status === "pass" || status === "fail") return { status, reasons: strArr(raw.reasons) ?? [], raw: text };
  }
  return { status: "fail", reasons: ["Verifier output was not parseable as JSON."], raw: text };
}

// ── JSON extraction ────────────────────────────────────────────────────────

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  for (const c of [trimmed, ...extractFenceContents(trimmed), extractBalancedObject(trimmed)]) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}

function extractFenceContents(text: string): string[] {
  const res: string[] = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) res.push(m[1].trim());
  return res;
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (escape) escape = false; else if (ch === "\\") escape = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// ── Spawn helpers ───────────────────────────────────────────────────────────

async function spawnChecked(
  spawnGuard: SpawnGuard, params: NormalizedParams, agents: Map<string, AgentProfile>,
  agentName: string, task: string, signal: AbortSignal | undefined,
  onProgress: ((text: string) => void) | undefined,
  inheritedModel: { provider?: string; model?: string } | undefined,
  modelOverride: ResolvedRoute,
  role: ComposableRole,
  phase: PhaseKind,
  phaseIndex: number,
  routingEvidence: RoutingEvidence[],
  phaseMutates = false,
): Promise<SubagentResult> {
  const spawned = spawnGuard.reserve();
  onProgress?.(`Spawning ${agentName} (${spawned}/${spawnGuard.cap}) in ${params.cwd}`);
  const result = await spawnSubagent(agentName, task, {
    agents, cwd: params.cwd, allowLocalModel: params.allowLocalModel,
    signal, inheritedModel, onProgress, modelOverride, phaseMutates,
  });
  routingEvidence.push({
    phase,
    phaseIndex,
    role,
    agentName: result.agentName,
    provider: result.provider,
    model: result.model,
    evidence: `Phase ${phase} ${phaseIndex}: ${result.agentName} spawned as ${role} on ${formatRoutedModel(result.provider, result.model)}.`,
  });
  return result;
}

function normalizePlannerRouteHint(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const placeholder = trimmed.toLowerCase().replace(/[\s_()-]+/g, "");
  if (["default", "sessiondefault", "inherit", "inherited", "auto"].includes(placeholder)) {
    return undefined;
  }
  return trimmed;
}

// ── Result builders ────────────────────────────────────────────────────────

interface PhaseArtifacts {
  research: ResearchFinding[];
  hypotheses: Hypothesis[];
  critiques: Critique[];
  syntheses: Synthesis[];
  candidatePlans: CandidatePlan[];
  plan: Plan | null;
  finalPlanSource: "planner" | "synthesis" | "fallback" | null;
  executorOutputs: ExecutorOutput[];
  voteResult: { votes: VerifierVote[]; passes: number; fails: number } | null;
  attempts: PipelineAttempt[];
  selectedRoutes: SelectedRoutes;
  routingEvidence: RoutingEvidence[];
  preflightEvidence: PreflightEvidence[];
}

function buildFinalResult(
  status: "pass" | "fail", params: NormalizedParams, spawnGuard: SpawnGuard,
  phases: PipelinePhase[], a: PhaseArtifacts,
): string {
  const {
    research, hypotheses, critiques, syntheses, candidatePlans, plan, finalPlanSource,
    executorOutputs, voteResult, attempts, selectedRoutes, routingEvidence, preflightEvidence,
  } = a;
  const actualCardinality = phases.map((phase) => ({
    kind: phase.kind,
    count: routingEvidence.filter((item) => item.phase === phase.kind).length,
  }));
  const lines: string[] = [
    `# Composable Pipeline: ${status.toUpperCase()}`,
    "",
    `**Task:** ${params.task}`,
    `**Pipeline:** ${phases.map((p) => `${p.kind}×${p.count}`).join(" → ") || "(empty)"}`,
    // Routes line derives from the exact post-preflight routes passed to spawns,
    // including any selected fallback.
    `**Routes:** Planner=${formatRouteLabel(selectedRoutes.planner)}; ` +
      `Executor=${formatRouteLabel(selectedRoutes.executor)}; ` +
      `Verifier=${formatRouteLabel(selectedRoutes.verifier)}`,
    `**Actual phase spawns:** ${actualCardinality.map((item) => `${item.kind}×${item.count}`).join(" → ") || "(empty)"}`,
    `**Subagents:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    "## Model Routing Evidence",
    ...(routingEvidence.length ? routingEvidence.map((item) => `- ${item.evidence}`) : ["- No composed seats were spawned."]),
    "",
    "## Route Preflight Evidence",
    ...preflightEvidence.map((item) =>
      `- ${item.role}: ${item.provider}/${item.model} — ${item.status}${item.selected ? " (selected)" : ""}`),
  ];

  if (plan) {
    lines.push("", `## Final Plan (${finalPlanSource ?? "unknown"})`, "```json",
      JSON.stringify({ tasks: plan.tasks, notes: plan.notes }, null, 2), "```");
  }

  if (candidatePlans.length > 0) {
    lines.push("", "## Candidate Plans",
      ...candidatePlans.map((candidate) =>
        `### P${candidate.index + 1} (${candidate.agentName})\n${truncateWithNotice(candidate.text, MAX_PHASE_CHARS, `candidate plan ${candidate.index + 1}`)}`));
  }

  if (attempts.length > 0) {
    lines.push("", "## Execute / Verify Attempts",
      ...attempts.map((attempt) =>
        `- Attempt ${attempt.attempt}: ${attempt.status.toUpperCase()} (${attempt.executorOutputs.length} executor(s), ${attempt.voteResult.votes.length} verifier(s))`));
  }

  if (voteResult) {
    lines.push("", "## Majority Vote",
      `- PASS: ${voteResult.passes} | FAIL: ${voteResult.fails}`,
      `- Outcome: **${status.toUpperCase()}**`);
  }

  if (research.length > 0) {
    lines.push("", "## Research",
      ...research.map((item) => `### R${item.index + 1} (${item.agentName})\n${truncateWithNotice(item.text, MAX_PHASE_CHARS, `research R${item.index + 1}`)}`));
  }
  if (hypotheses.length > 0) {
    lines.push("", "## Hypotheses",
      ...hypotheses.map((h) => `### H${h.index + 1} (${h.agentName})\n${truncateWithNotice(h.text, MAX_PHASE_CHARS, `hypothesis H${h.index + 1}`)}`));
  }
  if (critiques.length > 0) {
    lines.push("", "## Critiques",
      ...critiques.map((c) => `### C${c.index + 1} (${c.agentName})\n${truncateWithNotice(c.text, MAX_PHASE_CHARS, `critique C${c.index + 1}`)}`));
  }
  if (syntheses.length > 0) {
    lines.push("", "## Synthesis",
      ...syntheses.map((s) => `### S${s.index + 1} (${s.agentName})\n${truncateWithNotice(s.text, MAX_PHASE_CHARS, `synthesis S${s.index + 1}`)}`));
  }

  if (executorOutputs.length > 0) {
    lines.push("", "## Executor Outputs",
      ...executorOutputs.map((o) => [
        `### ${o.taskId}: ${o.description} (${o.agentName}, ${o.durationMs}ms)`,
        "", o.output ? truncateWithNotice(o.output, MAX_PHASE_CHARS, `output ${o.taskId}`) : "_(No output captured.)_",
        o.stderr ? `\n_stderr:_\n\`\`\`\n${truncateWithNotice(o.stderr, 2000, `stderr ${o.taskId}`)}\n\`\`\`` : "",
      ].join("\n")),
    );
  }

  if (voteResult) {
    lines.push("", "## Verifier Votes",
      ...voteResult.votes.map((v) => [
        `### V${v.verifierIndex}: ${v.status.toUpperCase()} (${v.agentName}, ${v.durationMs}ms)`,
        v.reasons.length ? v.reasons.map((r) => `- ${r}`).join("\n") : "- No reasons.",
      ].join("\n")),
    );
  }

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "final report");
}

function buildDetails(
  status: "pass" | "fail", params: NormalizedParams, spawnGuard: SpawnGuard,
  phases: PipelinePhase[], a: PhaseArtifacts,
): Record<string, unknown> {
  const {
    research, hypotheses, critiques, syntheses, candidatePlans, plan, finalPlanSource,
    executorOutputs, voteResult, attempts, selectedRoutes, routingEvidence, preflightEvidence,
  } = a;
  return {
    status, paradigm: "composable-pipeline",
    selectedRoutes,
    routingEvidence,
    preflightEvidence,
    actualCardinality: phases.map((phase) => ({
      kind: phase.kind,
      declared: phase.count,
      spawned: routingEvidence.filter((item) => item.phase === phase.kind).length,
    })),
    research: research.map((item) => ({ index: item.index, agentName: item.agentName, text: truncateWithNotice(item.text, MAX_DETAIL_CHARS, `research R${item.index + 1}`) })),
    hypotheses: hypotheses.map((h) => ({ index: h.index, agentName: h.agentName, text: truncateWithNotice(h.text, MAX_DETAIL_CHARS, `hypothesis H${h.index + 1}`) })),
    critiques: critiques.map((c) => ({ index: c.index, agentName: c.agentName, text: truncateWithNotice(c.text, MAX_DETAIL_CHARS, `critique C${c.index + 1}`) })),
    syntheses: syntheses.map((s) => ({ index: s.index, agentName: s.agentName, text: truncateWithNotice(s.text, MAX_DETAIL_CHARS, `synthesis S${s.index + 1}`) })),
    pipeline: phases.map((p) => ({ kind: p.kind, count: p.count })),
    params: { ...params, task: truncateWithNotice(params.task, MAX_DETAIL_CHARS, "task") },
    spawnedCount: spawnGuard.spawned, spawnedCap: spawnGuard.cap,
    candidatePlans: candidatePlans.map((candidate) => ({
      index: candidate.index,
      agentName: candidate.agentName,
      plan: {
        tasks: candidate.plan.tasks.map((task) => ({ ...task, description: truncateWithNotice(task.description, MAX_DETAIL_CHARS, `candidate task ${task.id}`) })),
        notes: truncateWithNotice(candidate.plan.notes, MAX_DETAIL_CHARS, "candidate plan notes"),
      },
      text: truncateWithNotice(candidate.text, MAX_DETAIL_CHARS, `candidate plan ${candidate.index + 1}`),
    })),
    finalPlanSource,
    plan: plan ? {
      tasks: plan.tasks.map((t) => ({ ...t, description: truncateWithNotice(t.description, MAX_DETAIL_CHARS, `task ${t.id}`) })),
      notes: truncateWithNotice(plan.notes, MAX_DETAIL_CHARS, "plan notes"),
    } : null,
    executorOutputs: executorOutputs.map((o) => ({
      ...o, output: truncateWithNotice(o.output, MAX_DETAIL_CHARS, `output ${o.taskId}`),
    })),
    voteResult: voteResult ? {
      passes: voteResult.passes, fails: voteResult.fails,
      votes: voteResult.votes.map((v) => ({
        ...v, reasons: v.reasons.map((r) => truncateWithNotice(r, MAX_DETAIL_CHARS, "reason")),
        raw: truncateWithNotice(v.raw, MAX_DETAIL_CHARS, "verifier raw"),
      })),
    } : null,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      executorCount: attempt.executorOutputs.length,
      verifierCount: attempt.voteResult.votes.length,
      passes: attempt.voteResult.passes,
      fails: attempt.voteResult.fails,
      executorOutputs: attempt.executorOutputs.map((output) => ({
        ...output,
        output: truncateWithNotice(output.output, MAX_DETAIL_CHARS, `attempt ${attempt.attempt} output ${output.taskId}`),
      })),
      votes: attempt.voteResult.votes.map((vote) => ({
        ...vote,
        raw: truncateWithNotice(vote.raw, MAX_DETAIL_CHARS, `attempt ${attempt.attempt} verifier raw`),
      })),
    })),
  };
}

// ── Utility helpers ────────────────────────────────────────────────────────

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strArr(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((i) => String(i).trim()).filter(Boolean) : undefined;
}
