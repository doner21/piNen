/**
 * Shape: multi-verify-vote
 * ========================
 * A sibling orchestration shape that spawns multiple verifiers and uses
 * majority voting to decide pass/fail.
 *
 * Flow: planner → executor waves → N verifiers (odd, default 3) → majority vote.
 *
 * ONE-LINE RULE: Shapes are siblings, they stand on the substrate, they
 * never build on each other.
 *
 * This shape stands directly on the substrate (spawnSubagent, runBoundedPool,
 * buildExecutionWaves, runWorkGraph, SpawnGuard, SUBSTRATE_CAPS), and does
 * NOT import, extend, or call the plan-execute-verify shape or any other shape.
 */

import {
  SpawnGuard,
  SUBSTRATE_CAPS,
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
import { resolveRouteOverride, formatRouteLabel } from "../routes";

// ── Multi-verify-vote specific types ───────────────────────────────────────

/** A planned task, same shape used by the planner prompt. */
interface PlanTask {
  id: string;
  description: string;
  dependsOn: string[];
  agent?: string;
  role?: string;
  model?: string;
  provider?: string;
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
}

interface VerifierVote {
  verifierIndex: number;
  agentName: string;
  status: "pass" | "fail";
  reasons: string[];
  raw: string;
  durationMs: number;
}

// ── Constants (shape-owned) ────────────────────────────────────────────────

/** Default number of verifiers (odd number ensures no ties). */
const DEFAULT_VERIFIER_COUNT = 3;
/** Maximum verifier count allowed. */
const MAX_VERIFIER_COUNT = 7;
/** Default concurrency for verifier pool. */
const DEFAULT_VERIFIER_CONCURRENCY = 3;

const MAX_FINAL_MARKDOWN_CHARS = 20_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_EXECUTOR_MARKDOWN_CHARS = 6_000;

// ── Shape export ───────────────────────────────────────────────────────────

export const multiVerifyVoteShape: OrchestrationShape = {
  name: "multi-verify-vote",
  description:
    "Planner → executor waves → multiple verifiers (odd count) → majority vote. " +
    "Each verifier independently judges pass/fail; majority determines the outcome. " +
    "Uses only substrate primitives — a sibling to plan-execute-verify, not a wrapper.",
  run: runMultiVerifyVote,
};

// ── Main orchestration loop ────────────────────────────────────────────────

async function runMultiVerifyVote(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents, inferredModelRouting } = context;

  const emit = (text: string) => {
    onUpdate?.({ content: [{ type: "text", text }] });
  };

  // Substrate guarantee: all spawns are bounded by the SpawnGuard.
  const spawnGuard = new SpawnGuard(params.maxSubagents);

  // Determine verifier count from the task text or use default.
  const verifierCount = inferVerifierCount(params.task);
  emit(`Multi-verify-vote: using ${verifierCount} verifier(s) (odd count to prevent ties).`);

  // ── Phase 1: Plan ──────────────────────────────────────────────────
  throwIfAborted(signal);
  emit("Phase 1: Planning...");

  const plan = await planPhase(
    params,
    agents,
    spawnGuard,
    signal,
    emit,
    inheritedModel,
    inferredModelRouting,
  );
  emit(`Plan produced: ${plan.tasks.length} task(s), ${buildExecutionWaves(plan.tasks).length} wave(s).`);

  // ── Phase 2: Execute ────────────────────────────────────────────────
  throwIfAborted(signal);
  emit(`Phase 2: Executing ${plan.tasks.length} task(s)...`);

  const executorOutputs = await executePhase(
    params,
    plan,
    agents,
    spawnGuard,
    signal,
    emit,
    inheritedModel,
    inferredModelRouting,
  );

  emit(`Execution complete: ${executorOutputs.length} output(s) collected.`);

  // ── Phase 3: Multi-Verify Vote ──────────────────────────────────────
  throwIfAborted(signal);
  emit(`Phase 3: Spawning ${verifierCount} verifier(s) for majority vote...`);

  const voteResult = await verifyVotePhase(
    params,
    plan,
    executorOutputs,
    verifierCount,
    agents,
    spawnGuard,
    signal,
    emit,
    inheritedModel,
    inferredModelRouting,
  );

  // ── Result ──────────────────────────────────────────────────────────
  const status = voteResult.passes > voteResult.fails ? "pass" : "fail";
  const details = buildDetails(status, params, spawnGuard, plan, executorOutputs, voteResult);
  const markdown = buildFinalResult(status, params, spawnGuard, plan, executorOutputs, voteResult);

  return { markdown, details };
}

// ── Phase 1: Plan ──────────────────────────────────────────────────────────

async function planPhase(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
): Promise<Plan> {
  const plannerPrompt = buildPlannerPrompt(params, inferredModelRouting);
  const result = await spawnChecked(
    spawnGuard,
    params,
    agents,
    params.plannerAgent,
    plannerPrompt,
    signal,
    emit,
    inheritedModel,
    toModelOverride(params.plannerModel, params.plannerProvider),
  );
  return parsePlan(result.text, params.task);
}

function buildPlannerPrompt(
  params: NormalizedParams,
  inferredModelRouting: InferredModelRouting,
): string {
  const routingNote = inferredModelRouting.planner
    ? `\nModel routing hint: use ${formatRoutedModel(inferredModelRouting.planner.provider, inferredModelRouting.planner.model)} for planning (inferred from task text).`
    : "";
  return `Plan the following task for executor subagents in a multi-verify-vote orchestration.
The orchestration will spawn multiple independent verifiers that vote on pass/fail.
Return JSON exactly shaped as:
{"tasks":[{"id":"...","description":"...","dependsOn":[],"agent":"coder","role":"...","model":"...","provider":"..."}],"notes":"..."}

Task:
${params.task}
${routingNote}

Natural-language orchestration controls detected by the orchestrator:
${JSON.stringify(params.orchestrationControls, null, 2)}

Rules:
- Keep task IDs stable and simple (task-1, task-2, ...).
- Make each description self-contained and detailed.
- Do not execute the task.
- If orchestration_controls.researcherCount is set, create that many tasks assigned to agent "researcher" with distinct perspectives when requested.
- Each task can optionally specify "agent" (agent name to spawn), "role" (semantic hint), "model", and "provider".
- Unknown agent names will fall back to the default executor agent.`;
}

// ── Phase 2: Execute ───────────────────────────────────────────────────────

async function executePhase(
  params: NormalizedParams,
  plan: Plan,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
): Promise<ExecutorOutput[]> {
  const waves = buildExecutionWaves(plan.tasks);

  return runWorkGraph(waves, params.concurrency, signal, async (task, _index, workerSignal) => {
    const prompt = buildExecutorPrompt(params.task, plan, task);
    const resolvedAgent = task.agent?.trim() && agents.has(task.agent.trim())
      ? task.agent.trim()
      : params.executorAgent;

    if (resolvedAgent !== params.executorAgent) {
      emit(`Task ${task.id}: assigned to agent "${resolvedAgent}" (role: ${task.role ?? "(none)"}).`);
    }

    const runtimeOverride = inferredRuntimeModelForTask(task, resolvedAgent, inferredModelRouting);
    const override = mergeModelOverrides(
      mergeModelOverrides(toModelOverride(params.executorModel, params.executorProvider), runtimeOverride),
      { model: task.model, provider: task.provider },
    );

    const result = await spawnChecked(
      spawnGuard,
      params,
      agents,
      resolvedAgent,
      prompt,
      workerSignal,
      emit,
      inheritedModel,
      override,
    );

    return {
      taskId: task.id,
      description: task.description,
      agentName: result.agentName,
      output: result.text,
      stderr: result.stderr || undefined,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  });
}

function buildExecutorPrompt(originalTask: string, plan: Plan, task: PlanTask): string {
  return `You are executing one task from a deterministic multi-verify-vote orchestration.

Original task:
${originalTask}

Full plan:
${JSON.stringify(plan, null, 2)}

Assigned executor task:
${JSON.stringify(task, null, 2)}

Complete only the assigned task. Use Pi tools only if needed and allowed by the task constraints.

Return a concise report with changes/findings, files touched, commands/tests run, and remaining issues or uncertainty.`;
}

// ── Phase 3: Multi-Verify Vote ─────────────────────────────────────────────

async function verifyVotePhase(
  params: NormalizedParams,
  plan: Plan,
  executorOutputs: ExecutorOutput[],
  verifierCount: number,
  agents: Map<string, AgentProfile>,
  spawnGuard: SpawnGuard,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  inferredModelRouting: InferredModelRouting,
): Promise<{ votes: VerifierVote[]; passes: number; fails: number }> {
  const verifiers = Array.from({ length: verifierCount }, (_, i) => ({
    index: i + 1,
    agentName: params.verifierAgent,
    prompt: buildVerifierPrompt(i + 1, verifierCount, params.task, plan, executorOutputs, inferredModelRouting),
    override: toModelOverride(params.verifierModel, params.verifierProvider),
  }));

  const votes = await runBoundedPool(
    verifiers,
    Math.min(DEFAULT_VERIFIER_CONCURRENCY, verifierCount),
    signal,
    async (verifier, _index, workerSignal) => {
      emit(`Verifier ${verifier.index}/${verifierCount} starting...`);
      const startedAt = Date.now();
      const result = await spawnChecked(
        spawnGuard,
        params,
        agents,
        verifier.agentName,
        verifier.prompt,
        workerSignal,
        emit,
        inheritedModel,
        verifier.override,
      );
      const parsed = parseVerifierResult(result.text);
      emit(
        `Verifier ${verifier.index}/${verifierCount}: ${parsed.status.toUpperCase()} ` +
          `(${parsed.reasons.join("; ") || "no reasons provided"}).`,
      );
      return {
        verifierIndex: verifier.index,
        agentName: result.agentName,
        status: parsed.status,
        reasons: parsed.reasons,
        raw: result.text,
        durationMs: Date.now() - startedAt,
      };
    },
  );

  const passes = votes.filter((v) => v.status === "pass").length;
  const fails = votes.filter((v) => v.status === "fail").length;

  emit(
    `Majority vote: ${passes} PASS, ${fails} FAIL — ` +
      `outcome: ${passes > fails ? "PASS" : "FAIL"}.`,
  );

  return { votes, passes, fails };
}

function buildVerifierPrompt(
  verifierIndex: number,
  totalVerifiers: number,
  originalTask: string,
  plan: Plan,
  executorOutputs: ExecutorOutput[],
  inferredModelRouting: InferredModelRouting,
): string {
  const routingNote = inferredModelRouting.verifier
    ? `\nYou should be running as ${formatRoutedModel(inferredModelRouting.verifier.provider, inferredModelRouting.verifier.model)}.`
    : "";
  return `You are verifier ${verifierIndex} of ${totalVerifiers} in a multi-verify-vote orchestration.
Judge whether the executor outputs satisfy the original task. Your vote will be combined
with ${totalVerifiers - 1} other independent verifier(s) via majority vote.

Original task:
${originalTask}
${routingNote}

Plan:
${JSON.stringify(plan, null, 2)}

Executor outputs:
${JSON.stringify(executorOutputs, null, 2)}

Return JSON exactly and only in this shape:
{"status":"pass"|"fail","reasons":["..."]}

Rules:
- Vote independently — do not assume what other verifiers will decide.
- Use status "pass" only if all executor outputs clearly satisfy the original task.
- Use "fail" with concrete, specific reasons for missing, unclear, or incorrect work.
- Be strict: if any part of the original task is not demonstrably completed, vote "fail".`;
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
    notes: "Planner output was not parseable as plan JSON; fell back to one executor task.",
    raw: text,
  };
}

function normalizePlanTask(item: unknown, index: number): PlanTask | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const description = optionalString(raw.description)?.trim();
  if (!description) return null;
  const id = optionalString(raw.id)?.trim() || `task-${index + 1}`;
  return {
    id,
    description,
    dependsOn: stringArray(raw.dependsOn) ?? [],
    agent: optionalString(raw.agent),
    role: optionalString(raw.role),
    model: optionalString(raw.model),
    provider: optionalString(raw.provider),
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

// ── JSON extraction (standalone, no cross-shape imports) ────────────────────

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

// ── Verifier count inference ────────────────────────────────────────────────

function inferVerifierCount(task: string): number {
  const lower = task.toLowerCase();
  // Explicit count in task text
  const explicitMatch = lower.match(/\b(\d+)\s*verifier/i);
  if (explicitMatch) {
    const count = parseInt(explicitMatch[1], 10);
    if (count >= 1 && count <= MAX_VERIFIER_COUNT && count % 2 === 1) return count;
    if (count >= 1 && count <= MAX_VERIFIER_COUNT) return count % 2 === 1 ? count : count + 1;
  }
  return DEFAULT_VERIFIER_COUNT;
}

// ── Spawn helpers ───────────────────────────────────────────────────────────

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
): Promise<SubagentResult> {
  const spawned = spawnGuard.reserve();
  onProgress?.(
    `Spawning subagent ${agentName} (${spawned}/${spawnGuard.cap}) in ${params.cwd}`,
  );
  return spawnSubagent(agentName, task, {
    agents,
    cwd: params.cwd,
    allowLocalModel: params.allowLocalModel,
    signal,
    inheritedModel,
    onProgress,
    modelOverride,
  });
}

function inferredRuntimeModelForTask(
  task: PlanTask,
  resolvedAgent: string,
  inferredModelRouting: InferredModelRouting,
): { model?: string; provider?: string } | undefined {
  const runtimeRoles = inferredModelRouting.runtimeRoles ?? {};
  const candidates = [resolvedAgent, task.agent, task.role]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  if (candidates.some((value) => /\bresearch/.test(value))) candidates.push("researcher");
  for (const candidate of candidates) {
    const override = runtimeRoles[candidate];
    if (override?.model || override?.provider) return override;
  }
  return undefined;
}

function mergeModelOverrides(
  roleLevel: { model?: string; provider?: string } | undefined,
  taskLevel: { model?: string; provider?: string } | undefined,
): { model?: string; provider?: string } | undefined {
  const role = roleLevel ?? {};
  const task = taskLevel ?? {};
  const model = task.model ?? role.model;
  const provider = task.provider ?? role.provider;
  if (!model && !provider) return undefined;
  return { model, provider };
}

// Route override resolution is delegated to the shared helper (src/routes.ts)
// so spawn routing and the report Routes line derive from identical values,
// closing the silent-route-override bug class (2026-07-02).
function toModelOverride(
  model?: string,
  provider?: string,
): { model?: string; provider?: string } | undefined {
  return resolveRouteOverride(model, provider);
}

// ── Result builders ────────────────────────────────────────────────────────

function buildFinalResult(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  plan: Plan,
  executorOutputs: ExecutorOutput[],
  voteResult: { votes: VerifierVote[]; passes: number; fails: number },
): string {
  const lines = [
    `# Multi-Verify-Vote Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${params.task}`,
    `**Paradigm:** multi-verify-vote`,
    // Routes line derives from the SAME resolved override values passed to the
    // planner/executor/verifier spawns (via toModelOverride → resolveRouteOverride).
    `**Routes:** Planner=${formatRouteLabel(toModelOverride(params.plannerModel, params.plannerProvider))}; ` +
      `Executor=${formatRouteLabel(toModelOverride(params.executorModel, params.executorProvider))}; ` +
      `Verifier=${formatRouteLabel(toModelOverride(params.verifierModel, params.verifierProvider))}`,
    `**Verifiers:** ${voteResult.votes.length} (${voteResult.passes} PASS, ${voteResult.fails} FAIL)`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    "## Majority vote result",
    `- PASS votes: ${voteResult.passes}`,
    `- FAIL votes: ${voteResult.fails}`,
    `- Outcome: **${status.toUpperCase()}** (majority rule)`,
    "",
    "## Plan",
    "```json",
    JSON.stringify(
      { tasks: plan.tasks, notes: plan.notes },
      null,
      2,
    ),
    "```",
    "",
    "## Executor outputs",
    ...executorOutputs.map((output) =>
      [
        `### ${output.taskId}: ${output.description} (${output.agentName}, ${output.durationMs}ms)`,
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
    "",
    "## Verifier votes",
    ...voteResult.votes.map((vote) =>
      [
        `### Verifier ${vote.verifierIndex}: ${vote.status.toUpperCase()} (${vote.agentName}, ${vote.durationMs}ms)`,
        vote.reasons.length
          ? vote.reasons.map((reason) => `- ${reason}`).join("\n")
          : "- No reasons provided.",
      ].join("\n"),
    ),
  ];

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_MARKDOWN_CHARS, "final orchestration report");
}

function buildDetails(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  plan: Plan,
  executorOutputs: ExecutorOutput[],
  voteResult: { votes: VerifierVote[]; passes: number; fails: number },
): Record<string, unknown> {
  return {
    status,
    paradigm: "multi-verify-vote",
    params: { ...params, task: truncateWithNotice(params.task, MAX_DETAIL_TEXT_CHARS, "task") },
    spawnedCount: spawnGuard.spawned,
    spawnedCap: spawnGuard.cap,
    verifierCount: voteResult.votes.length,
    majorityVote: { passes: voteResult.passes, fails: voteResult.fails },
    plan: {
      tasks: plan.tasks.map((t) => ({
        ...t,
        description: truncateWithNotice(t.description, MAX_DETAIL_TEXT_CHARS, `task ${t.id}`),
      })),
      notes: truncateWithNotice(plan.notes, MAX_DETAIL_TEXT_CHARS, "plan notes"),
    },
    executorOutputs: executorOutputs.map((output) => ({
      ...output,
      output: truncateWithNotice(output.output, MAX_DETAIL_TEXT_CHARS, `output ${output.taskId}`),
    })),
    votes: voteResult.votes.map((vote) => ({
      ...vote,
      reasons: vote.reasons.map((r) => truncateWithNotice(r, MAX_DETAIL_TEXT_CHARS, "verifier reason")),
      raw: truncateWithNotice(vote.raw, MAX_DETAIL_TEXT_CHARS, "verifier raw output"),
    })),
  };
}

// ── Utility helpers (local to this shape) ───────────────────────────────────

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}
