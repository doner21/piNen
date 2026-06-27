/**
 * Shape: composable-pipeline
 * ===========================
 * A composable orchestration shape that supports dynamic pipeline composition
 * via natural language. Supports hypothesize, critique, synthesize, plan,
 * execute, and verify phases with configurable concurrency per phase.
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
import { spawnSync } from "node:child_process";
import { estimateExecutorContextBudget } from "../executor-recovery/budget-estimator";
import { injectContinuationGuardrail } from "../executor-recovery/contract-types";

// ── Types ──────────────────────────────────────────────────────────────────

export type PhaseKind = "hypothesize" | "critique" | "synthesize" | "plan" | "execute" | "verify";

const PHASE_ORDER: readonly PhaseKind[] = [
  "hypothesize", "critique", "synthesize", "plan", "execute", "verify",
];

export interface PipelinePhase {
  kind: PhaseKind;
  count: number;
  agentName: string;
  promptBuilder: (index: number) => string;
}

export interface PipelineConfig { phases: PipelinePhase[] }

interface Hypothesis { index: number; agentName: string; text: string }
interface Critique { index: number; agentName: string; text: string }
interface Synthesis { index: number; agentName: string; text: string }

interface PlanTask {
  id: string; description: string; dependsOn: string[];
  agent?: string; role?: string; model?: string; provider?: string;
}

interface Plan { tasks: PlanTask[]; notes: string; raw?: unknown }

interface ExecutorOutput {
  taskId: string; description: string; agentName: string;
  output: string; stderr?: string; exitCode: number | null; durationMs: number;
}

interface VerifierVote {
  verifierIndex: number; agentName: string; status: "pass" | "fail";
  reasons: string[]; raw: string; durationMs: number;
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

const PHASE_FALLBACK_MODEL = { provider: "deepseek", model: "deepseek-v4-pro" };

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
  /** Regex for extracting count ("3 hypothesizers"). */
  countRe: RegExp;
  /** Regex for negating this phase. */
  negateRe: RegExp;
}

// negateRe patterns share a common prefix: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)/
// then each appends the phase-specific word list with plural forms and optional trailing 's'.
const PHASE_META: PhaseMeta[] = [
  { kind: "hypothesize", detect: /\bhypothesiz(?:er|e)|hypothesis\b/i, countRe: /(\d+)\s*(?:hypothesiz(?:ers?)|hypothesis)/i, negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:hypothesiz(?:ers?|e[ds]?|ing)|hypothes(?:is|es))\b/i },
  { kind: "critique",     detect: /\bcritic(?:al)?|critique|review(?:er)?\b/i,      countRe: /(\d+)\s*(?:critics?|critique)/i,                  negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:critics?|critiques?|reviews?|reviewers?)\b/i },
  { kind: "synthesize",   detect: /\bsynthesiz(?:er|e)|synthesis\b/i,            countRe: /(\d+)\s*(?:synthesiz(?:ers?)|synthesis)/i,          negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:synthesiz(?:ers?|e[ds]?|ing)|synthes(?:is|es))\b/i },
  { kind: "plan",         detect: /\bplanner|plan(?:ning)?|strategiz(?:e|ing)\b/i,  countRe: /(\d+)\s*(?:planners?|planning)/i,                  negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:planners?|plan(?:ning|s)?|strategiz(?:e[ds]?|ing))\b/i },
  { kind: "execute",      detect: /\bexecutor?|execut(?:e|ion|ing)|implement(?:er|ing)?|build(?:er|ing)?\b/i, countRe: /(\d+)\s*(?:executors?|execut(?:ions?)|implement(?:ers?|ations?))/i, negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:execut(?:ors?|e[ds]?|ions?|ing)|implement(?:s|ers?|ings?|ations?)?|build(?:s|ers?|ings?)?)\b/i },
  { kind: "verify",       detect: /\bverif(?:ier|y|ication)|check(?:er|ing)?|validat(?:or|e|ion)\b/i, countRe: /(\d+)\s*(?:verif(?:iers?|ications?)|check(?:ers?)|validat(?:ors?))/i, negateRe: /\b(?:no\s+(?:need\s+(?:for|to)\s+)?|without\s+|skip\s+(?:the\s+)?)(?:verif(?:iers?|y|ications?|ying)|check(?:ers?|ing)?|validat(?:ors?|e[ds]?|ions?|ing))\b/i },
];

function getMeta(kind: PhaseKind): PhaseMeta {
  return PHASE_META.find((m) => m.kind === kind)!;
}

/** Resolve per-phase model override from inferredModelRouting.runtimeRoles or fall back to core role models. */
function getPhaseModelOverride(phaseKind: PhaseKind, params: NormalizedParams, inferred: InferredModelRouting): { model?: string; provider?: string } | undefined {
  const roleMap: Record<string, string> = { hypothesize: "hypothesizer", critique: "critic", synthesize: "synthesizer" };
  const roleName = roleMap[phaseKind];
  if (roleName && inferred.runtimeRoles?.[roleName]) {
    return inferred.runtimeRoles[roleName];
  }
  if (phaseKind === "plan") return { model: params.plannerModel, provider: params.plannerProvider };
  if (phaseKind === "verify") return { model: params.verifierModel, provider: params.verifierProvider };
  return { model: params.executorModel, provider: params.executorProvider };
}

// ── Shape export ───────────────────────────────────────────────────────────

export const composablePipelineShape: OrchestrationShape = {
  name: "composable-pipeline",
  description:
    "Dynamic pipeline composition via natural language. Supports hypothesize, critique, " +
    "synthesize, plan, execute, and verify phases with configurable concurrency per phase.",
  run: runComposablePipeline,
};

// ── Main orchestration loop ────────────────────────────────────────────────

async function runComposablePipeline(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents, inferredModelRouting } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const spawnGuard = new SpawnGuard(params.maxSubagents);

  // Parse pipeline from NL
  emit("Composable pipeline: parsing configuration...");
  const rawConfig = parsePipelineConfig(params.task);
  const phases = resolvePipelineConfig(rawConfig, params);
  emit(`Pipeline: ${phases.map((p) => `${p.kind}×${p.count}`).join(" → ") || "(empty)"}`);

  // Accumulated phase results
  let hypotheses: Hypothesis[] = [];
  let critiques: Critique[] = [];
  let syntheses: Synthesis[] = [];
  let plan: Plan | null = null;
  let executorOutputs: ExecutorOutput[] = [];
  let voteResult: { votes: VerifierVote[]; passes: number; fails: number } | null = null;

  // Execute phases sequentially
  for (const phase of phases) {
    throwIfAborted(signal);
    emit(`Phase ${phase.kind.toUpperCase()}: spawning ${phase.count} agent(s)...`);

    switch (phase.kind) {
      case "hypothesize":
        hypotheses = await runPhase("hypothesize", phase, params, agents, spawnGuard, signal,
          emit, inheritedModel, inferredModelRouting,
          getPhaseModelOverride("hypothesize", params, inferredModelRouting),
          (idx, total) => buildPhasePrompt("hypothesize", idx, total, params.task, inferredModelRouting));
        break;
      case "critique":
        critiques = await runPhase("critique", phase, params, agents, spawnGuard, signal,
          emit, inheritedModel, inferredModelRouting,
          getPhaseModelOverride("critique", params, inferredModelRouting),
          (idx, total) => buildPhasePrompt("critique", idx, total, params.task, inferredModelRouting, hypotheses));
        break;
      case "synthesize":
        syntheses = await runPhase("synthesize", phase, params, agents, spawnGuard, signal,
          emit, inheritedModel, inferredModelRouting,
          getPhaseModelOverride("synthesize", params, inferredModelRouting),
          (idx, total) => buildPhasePrompt("synthesize", idx, total, params.task, inferredModelRouting, hypotheses, critiques));
        break;
      case "plan": {
        const prompt = buildPlanPrompt(params.task, hypotheses, critiques, syntheses, inferredModelRouting);
        const result = await spawnChecked(spawnGuard, params, agents, phase.agentName, prompt,
          signal, emit, inheritedModel, toMO(params.plannerModel, params.plannerProvider));
        plan = parsePlan(result.text, params.task);
        emit(`Plan: ${plan.tasks.length} task(s), ${buildExecutionWaves(plan.tasks).length} wave(s).`);
        break;
      }
      case "execute":
        executorOutputs = await runExecutePhase(params, agents, spawnGuard, signal, emit,
          inheritedModel, inferredModelRouting, plan);
        break;
      case "verify":
        voteResult = await runVerifyPhase(params, agents, spawnGuard, signal, emit,
          inheritedModel, inferredModelRouting, phase, plan, executorOutputs,
          hypotheses, critiques, syntheses);
        break;
    }
  }

  // Determine final status
  let status: "pass" | "fail" = "pass";
  if (voteResult) status = voteResult.passes > voteResult.fails ? "pass" : "fail";

  const details = buildDetails(status, params, spawnGuard, phases, {
    hypotheses, critiques, syntheses, plan, executorOutputs, voteResult,
  });
  const markdown = buildFinalResult(status, params, spawnGuard, phases, {
    hypotheses, critiques, syntheses, plan, executorOutputs, voteResult,
  });
  return { markdown, details };
}

// ── Generic phase runner (hypothesize / critique / synthesize) ─────────────

async function runPhase<T extends { index: number; agentName: string; text: string }>(
  _kind: PhaseKind,
  phase: PipelinePhase,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
  perPhaseModel: { model?: string; provider?: string } | undefined,
  buildPrompt: (index: number, total: number) => string,
): Promise<T[]> {
  const effectiveModel = perPhaseModel ?? toMO(params.executorModel, params.executorProvider);
  const items = Array.from({ length: phase.count }, (_, i) => i);
  const results = await runBoundedPool(items, MAX_PHASE_CONCURRENCY, signal, async (index, _pi, ws) => {
    const prompt = buildPrompt(index, phase.count);

    // Spawn with fallback model support
    let result: SubagentResult;
    try {
      result = await spawnChecked(spawnGuard, params, agents, phase.agentName, prompt,
        ws, emit, inheritedModel, effectiveModel);
    } catch (firstErr) {
      emit(`WARNING: Phase ${phase.kind} agent ${index + 1} spawn failed with primary model, retrying with fallback (${PHASE_FALLBACK_MODEL.provider}/${PHASE_FALLBACK_MODEL.model})...`);
      try {
        result = await spawnChecked(spawnGuard, params, agents, phase.agentName, prompt,
          ws, emit, inheritedModel, PHASE_FALLBACK_MODEL);
      } catch {
        throw firstErr;
      }
    }

    // Budget estimation
    const budgetModel = effectiveModel?.model ?? params.executorModel;
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
  inferredModelRouting: InferredModelRouting,
  plan: Plan | null,
): Promise<ExecutorOutput[]> {
  const effective = (plan && plan.tasks.length > 0) ? plan : {
    tasks: [{ id: "task-1", description: params.task, dependsOn: [] }],
    notes: "No plan was produced; falling back to single executor task.",
  };

  // Task-size cap enforcement
  for (const task of effective.tasks) {
    const words = task.description.split(/\s+/).length;
    if (words > MAX_TASK_WORDS) {
      emit(`Task ${task.id}: WARNING — description is ${words} words (cap: ${MAX_TASK_WORDS}). Consider splitting.`);
      task.description = task.description.split(/\s+/).slice(0, MAX_TASK_WORDS).join(" ") + "...";
    }
  }

  const waves = buildExecutionWaves(effective.tasks);

  const results = await runWorkGraph(waves, DEFAULT_EXEC_CONCURRENCY, signal, async (task, _idx, ws) => {
    const prompt = buildExecutorPrompt(params.task, effective, task);
    const resolvedAgent = task.agent?.trim() && agents.has(task.agent.trim())
      ? task.agent.trim() : params.executorAgent;
    if (resolvedAgent !== params.executorAgent) {
      emit(`Task ${task.id}: assigned to "${resolvedAgent}" (role: ${task.role ?? "(none)"}).`);
    }
    const runtimeOv = inferredRuntimeModelForTask(task, resolvedAgent, inferredModelRouting);
    const override = mergeOverrides(
      mergeOverrides(toMO(params.executorModel, params.executorProvider), runtimeOv),
      { model: task.model, provider: task.provider },
    );
    const result = await spawnChecked(spawnGuard, params, agents, resolvedAgent, prompt,
      ws, emit, inheritedModel, override);

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

// ── Verify phase (N verifiers → majority vote) ────────────────────────────

async function runVerifyPhase(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
  phase: PipelinePhase,
  plan: Plan | null,
  executorOutputs: ExecutorOutput[],
  hypotheses: Hypothesis[],
  critiques: Critique[],
  syntheses: Synthesis[],
): Promise<{ votes: VerifierVote[]; passes: number; fails: number }> {
  const count = Math.min(phase.count, MAX_VERIFIER_COUNT);
  const verifiers = Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    agentName: params.verifierAgent,
    prompt: buildVerifierPrompt(i + 1, count, params.task, plan, executorOutputs,
      hypotheses, critiques, syntheses, inferredModelRouting),
    override: toMO(params.verifierModel, params.verifierProvider),
  }));

  const votes = await runBoundedPool(verifiers, Math.min(MAX_PHASE_CONCURRENCY, count), signal,
    async (verifier, _pi, ws) => {
      emit(`Verifier ${verifier.index}/${count} starting...`);
      const startedAt = Date.now();
      const result = await spawnChecked(spawnGuard, params, agents, verifier.agentName,
        verifier.prompt, ws, emit, inheritedModel, verifier.override);
      const parsed = parseVerifierResult(result.text);
      emit(`Verifier ${verifier.index}/${count}: ${parsed.status.toUpperCase()} (${parsed.reasons.join("; ") || "no reasons"}).`);
      return {
        verifierIndex: verifier.index, agentName: result.agentName,
        status: parsed.status, reasons: parsed.reasons, raw: result.text,
        durationMs: Date.now() - startedAt,
      };
    },
  );

  const passes = votes.filter((v) => v.status === "pass").length;
  const fails = votes.length - passes;
  emit(`Majority vote: ${passes} PASS, ${fails} FAIL → ${passes > fails ? "PASS" : "FAIL"}.`);
  return { votes, passes, fails };
}

// ── Prompt builders ────────────────────────────────────────────────────────

function routingNote(role: string | undefined, inferred: InferredModelRouting): string {
  return inferred[role as keyof InferredModelRouting]
    ? `\nModel routing hint: prefer ${formatRoutedModel((inferred as any)[role].provider, (inferred as any)[role].model)}.`
    : "";
}

function buildPhasePrompt(
  kind: "hypothesize" | "critique" | "synthesize",
  index: number,
  total: number,
  originalTask: string,
  inferred: InferredModelRouting,
  hypotheses?: Hypothesis[],
  critiques?: Critique[],
): string {
  const labels: Record<string, string> = {
    hypothesize: `hypothesizer ${index + 1} of ${total}`,
    critique: `critic ${index + 1} of ${total}`,
    synthesize: `synthesizer ${index + 1} of ${total}`,
  };
  const instructions: Record<string, string> = {
    hypothesize: "Generate hypotheses, approaches, or interpretations. Be creative — do NOT execute.",
    critique: "Critically review the hypotheses for weaknesses, gaps, risks, and assumptions. Be thorough — do NOT execute.",
    synthesize: "Synthesize hypotheses and critiques into a coherent, actionable understanding. Do NOT execute.",
  };
  const rn = routingNote("executor", inferred);
  let extra = "";
  if (hypotheses && hypotheses.length > 0) {
    const truncated = hypotheses.map((h) =>
      `### H${h.index + 1} (${h.agentName})\n${truncateWithNotice(h.text, MAX_PHASE_CHARS, `hypothesis H${h.index + 1}`)}`
    ).join("\n\n");
    extra += "\n## Hypotheses\n" + truncateWithNotice(truncated, MAX_PHASE_CHARS * 3 / 2, "all hypotheses");
  }
  if (critiques && critiques.length > 0) {
    const truncated = critiques.map((c) =>
      `### C${c.index + 1} (${c.agentName})\n${truncateWithNotice(c.text, MAX_PHASE_CHARS, `critique C${c.index + 1}`)}`
    ).join("\n\n");
    extra += "\n\n## Critiques\n" + truncateWithNotice(truncated, MAX_PHASE_CHARS * 3 / 2, "all critiques");
  }
  return `You are ${labels[kind]} in a composable orchestration pipeline.\n${instructions[kind]}\n${rn}\n\nOriginal task:\n${originalTask}${extra}\n\nReturn your response as structured text.`;
}

function buildPlanPrompt(
  originalTask: string,
  hypotheses: Hypothesis[],
  critiques: Critique[],
  syntheses: Synthesis[],
  inferred: InferredModelRouting,
): string {
  const rn = inferred.planner
    ? `\nModel routing hint: use ${formatRoutedModel(inferred.planner.provider, inferred.planner.model)} for planning.`
    : "";
  const synRaw = syntheses.length > 0
    ? syntheses.map((s) => `## Synthesis ${s.index + 1} (${s.agentName})\n${truncateWithNotice(s.text, MAX_PHASE_CHARS, `synthesis ${s.index + 1}`)}`).join("\n\n")
    : "_No synthesis produced._";
  const synText = truncateWithNotice(synRaw, MAX_PHASE_CHARS * 2, "all syntheses");
  return `You are the planner in a composable orchestration pipeline. Based on the original task and synthesis, produce a structured execution plan. Return JSON:\n{"tasks":[{"id":"...","description":"...","dependsOn":[],"agent":"coder","role":"...","model":"...","provider":"..."}],"notes":"..."}\n\nOriginal task:\n${originalTask}${rn}\n\nSynthesis:\n${synText}\n\nRules: Keep task IDs stable (task-1, task-2...). Make descriptions self-contained. Do not execute. Each task may optionally specify agent, role, model, provider.`;
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
  inferred: InferredModelRouting,
): string {
  const rn = inferred.verifier
    ? `\nYou should be running as ${formatRoutedModel(inferred.verifier.provider, inferred.verifier.model)}.`
    : "";
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
  return `You are verifier ${verifierIndex} of ${totalVerifiers} in a composable orchestration.\nJudge whether executor outputs satisfy the original task via majority vote.\n\nOriginal task:\n${originalTask}${rn}\n\nPlan:\n${planJson}\n\nExecutor outputs:\n${outputsJson}\n\nReturn JSON: {"status":"pass"|"fail","reasons":["..."]}\n\nVote independently. Use "pass" only if all outputs clearly satisfy the task. Be strict.`;
}

// ── Natural language pipeline parser ───────────────────────────────────────

/**
 * Parse NL task text → PipelineConfig.
 * "full wave" → all 6 phases. "just hypothesize and plan" → limits to those.
 * "no verifier" / "skip critique" → removes phases. "3 hypothesizers" → count.
 */
function parsePipelineConfig(task: string): PipelineConfig {
  const lower = task.toLowerCase();

  // "just/only" mode: limit to explicitly detected phases from full text.
  // Previous regex-based scope extraction was brittle with em-dashes, semicolons,
  // and multi-clause sentences. Now we simply detect presence and filter from the
  // entire task text — "just hypothesize and plan" in a long task still limits to
  // exactly those phases because only their detect patterns will match.
  const justMode = /\b(?:just|only)\b/.test(lower);

  // Negated phases
  const negated: Set<PhaseKind> = new Set();
  for (const meta of PHASE_META) {
    if (meta.negateRe.test(lower)) negated.add(meta.kind);
  }

  // Per-phase counts
  const counts = new Map<PhaseKind, number>();
  for (const meta of PHASE_META) {
    const m = lower.match(meta.countRe);
    if (m) { const c = parseInt(m[1], 10); if (c > 0) counts.set(meta.kind, c); }
  }

  // Determine active phases
  let active: PhaseKind[];
  const fullMatch = /\b(?:full(?:\s+wave)?|all(?:\s+phases|\s+stages)?)\b/i.test(lower);
  if (justMode) {
    // "just/only" present → limit to phases whose detect regex matches the full
    // task text. Full-wave shortcut is ignored in just-mode.
    active = PHASE_ORDER.filter((p) => !negated.has(p) && getMeta(p).detect.test(lower));
  } else if (fullMatch) {
    active = PHASE_ORDER.filter((p) => !negated.has(p));
  } else {
    active = PHASE_ORDER.filter((p) => !negated.has(p) && getMeta(p).detect.test(lower));
  }

  const phases: PipelinePhase[] = active.map((kind) => ({
    kind,
    count: counts.get(kind) ?? DEFAULT_COUNT,
    agentName: getDefaultAgent(kind, "planner", "coder", "reviewer"),
    promptBuilder: (_idx: number) => "", // filled at runtime by resolvePipelineConfig
  }));

  return { phases };
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
    case "plan": return planner;
    case "verify": return verifier;
    default: return executor;
  }
}

export { resolvePipelineConfig };

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
  modelOverride: { model?: string; provider?: string } | undefined,
): Promise<SubagentResult> {
  const spawned = spawnGuard.reserve();
  onProgress?.(`Spawning ${agentName} (${spawned}/${spawnGuard.cap}) in ${params.cwd}`);
  return spawnSubagent(agentName, task, {
    agents, cwd: params.cwd, allowLocalModel: params.allowLocalModel,
    signal, inheritedModel, onProgress, modelOverride,
  });
}

function inferredRuntimeModelForTask(
  task: PlanTask, resolvedAgent: string, inferred: InferredModelRouting,
): { model?: string; provider?: string } | undefined {
  const rt = inferred.runtimeRoles ?? {};
  const candidates = [resolvedAgent, task.agent, task.role]
    .map((v) => v?.trim().toLowerCase()).filter((v): v is string => Boolean(v));
  if (candidates.some((v) => /\bresearch/.test(v))) candidates.push("researcher");
  for (const c of candidates) { const ov = rt[c]; if (ov?.model || ov?.provider) return ov; }
  return undefined;
}

function mergeOverrides(
  a: { model?: string; provider?: string } | undefined,
  b: { model?: string; provider?: string } | undefined,
): { model?: string; provider?: string } | undefined {
  const m = b?.model ?? a?.model;
  const p = b?.provider ?? a?.provider;
  return (m || p) ? { model: m, provider: p } : undefined;
}

function toMO(model?: string, provider?: string): { model?: string; provider?: string } | undefined {
  return (model || provider) ? { model, provider } : undefined;
}

// ── Result builders ────────────────────────────────────────────────────────

interface PhaseArtifacts {
  hypotheses: Hypothesis[];
  critiques: Critique[];
  syntheses: Synthesis[];
  plan: Plan | null;
  executorOutputs: ExecutorOutput[];
  voteResult: { votes: VerifierVote[]; passes: number; fails: number } | null;
}

function buildFinalResult(
  status: "pass" | "fail", params: NormalizedParams, spawnGuard: SpawnGuard,
  phases: PipelinePhase[], a: PhaseArtifacts,
): string {
  const { hypotheses, critiques, syntheses, plan, executorOutputs, voteResult } = a;
  const lines: string[] = [
    `# Composable Pipeline: ${status.toUpperCase()}`,
    "",
    `**Task:** ${params.task}`,
    `**Pipeline:** ${phases.map((p) => `${p.kind}×${p.count}`).join(" → ") || "(empty)"}`,
    `**Subagents:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
  ];

  if (plan) {
    lines.push("", "## Plan", "```json",
      JSON.stringify({ tasks: plan.tasks, notes: plan.notes }, null, 2), "```");
  }

  if (voteResult) {
    lines.push("", "## Majority Vote",
      `- PASS: ${voteResult.passes} | FAIL: ${voteResult.fails}`,
      `- Outcome: **${status.toUpperCase()}**`);
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
  const { hypotheses, critiques, syntheses, plan, executorOutputs, voteResult } = a;
  return {
    status, paradigm: "composable-pipeline",
    hypotheses: hypotheses.map((h) => ({ index: h.index, agentName: h.agentName, text: truncateWithNotice(h.text, MAX_DETAIL_CHARS, `hypothesis H${h.index + 1}`) })),
    critiques: critiques.map((c) => ({ index: c.index, agentName: c.agentName, text: truncateWithNotice(c.text, MAX_DETAIL_CHARS, `critique C${c.index + 1}`) })),
    syntheses: syntheses.map((s) => ({ index: s.index, agentName: s.agentName, text: truncateWithNotice(s.text, MAX_DETAIL_CHARS, `synthesis S${s.index + 1}`) })),
    pipeline: phases.map((p) => ({ kind: p.kind, count: p.count })),
    params: { ...params, task: truncateWithNotice(params.task, MAX_DETAIL_CHARS, "task") },
    spawnedCount: spawnGuard.spawned, spawnedCap: spawnGuard.cap,
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
  };
}

// ── Utility helpers ────────────────────────────────────────────────────────

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strArr(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((i) => String(i).trim()).filter(Boolean) : undefined;
}
