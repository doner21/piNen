/**
 * Shape: verify-only
 * ==================
 * Verification-only orchestration paradigm (F8 of the 2026-06-12 harness
 * feedback). Input: an evidence checklist + paths. Spawns verifier(s) ONLY —
 * no planner, no executors. Output: per-check verdicts with citations.
 *
 * Properties:
 * - EXEMPT from all implementation-task heuristics: verification output is
 *   legitimately text-only, so no text-shape or effect gates apply.
 * - Supports multi-model vote ("3 verifiers" in the task text) reusing the
 *   majority-vote machinery pattern from multi-verify-vote.
 * - Verifiers are granted read/bash/grep tools (cloned profile) so they can
 *   independently gather evidence and cite file:line sources.
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never
 * build on each other.
 */

import {
  SpawnGuard,
  spawnSubagent,
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
} from "../types";

// ── Types ──────────────────────────────────────────────────────────────────

interface CheckVerdict {
  id: string;
  description: string;
  status: "pass" | "fail";
  citations: string[];
}

interface VerifierRun {
  verifierIndex: number;
  agentName: string;
  provider?: string;
  model?: string;
  overall: "pass" | "fail";
  reasons: string[];
  checks: CheckVerdict[];
  raw: string;
  durationMs: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_VERIFIER_COUNT = 1;
const MAX_VERIFIER_COUNT = 7;
const MAX_VERIFIER_CONCURRENCY = 3;
const MAX_FINAL_CHARS = 20_000;
const MAX_DETAIL_CHARS = 4_000;

// ── Shape export ───────────────────────────────────────────────────────────

export const verifyOnlyShape: OrchestrationShape = {
  name: "verify-only",
  description:
    "Verification-only paradigm: input is an evidence checklist + paths; spawns " +
    "verifier(s) only (no planner, no executors); output is per-check verdicts with " +
    "citations. Supports multi-verifier majority vote. Exempt from implementation-task " +
    "heuristics — verification output is legitimately text-only.",
  run: runVerifyOnly,
};

// ── Main loop ──────────────────────────────────────────────────────────────

async function runVerifyOnly(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  const spawnGuard = new SpawnGuard(params.maxSubagents);
  const verifierCount = inferVerifierCount(params.task);
  emit(
    `Verify-only: spawning ${verifierCount} verifier(s); no planner or executor subagents will be spawned.`,
  );

  // Clone the verifier profile and grant evidence-gathering tools so the
  // verifier can independently read files / run commands for citations.
  const verifierAgents = buildVerifierAgents(agents, params.verifierAgent);

  const override = toModelOverride(params.verifierModel, params.verifierProvider);
  const items = Array.from({ length: verifierCount }, (_, i) => i + 1);

  throwIfAborted(signal);
  const runs = await runBoundedPool(
    items,
    Math.min(MAX_VERIFIER_CONCURRENCY, verifierCount),
    signal,
    async (index, _i, workerSignal) => {
      const spawned = spawnGuard.reserve();
      emit(`Spawning subagent ${params.verifierAgent} (${spawned}/${spawnGuard.cap}) in ${params.cwd}`);
      const startedAt = Date.now();
      const result: SubagentResult = await spawnSubagent(
        params.verifierAgent,
        buildVerifyOnlyPrompt(index, verifierCount, params),
        {
          agents: verifierAgents,
          cwd: params.cwd,
          allowLocalModel: params.allowLocalModel,
          signal: workerSignal,
          inheritedModel,
          onProgress: emit,
          modelOverride: override,
        },
      );
      const parsed = parseVerifyOnlyResult(result.text);
      emit(
        `Verifier ${index}/${verifierCount}: ${parsed.overall.toUpperCase()} ` +
          `(${parsed.checks.length} check verdict(s), ${parsed.reasons.join("; ") || "no reasons"}).`,
      );
      const run: VerifierRun = {
        verifierIndex: index,
        agentName: result.agentName,
        overall: parsed.overall,
        reasons: parsed.reasons,
        checks: parsed.checks,
        raw: result.text,
        durationMs: Date.now() - startedAt,
      };
      if (result.provider) run.provider = result.provider;
      if (result.model) run.model = result.model;
      return run;
    },
  );

  const passes = runs.filter((r) => r.overall === "pass").length;
  const fails = runs.length - passes;
  const status: "pass" | "fail" = passes > fails ? "pass" : "fail";
  emit(`Verify-only majority: ${passes} PASS, ${fails} FAIL → ${status.toUpperCase()}.`);

  const aggregated = aggregateChecks(runs);
  const markdown = buildFinalResult(status, params, spawnGuard, runs, aggregated, passes, fails);
  const details = buildDetails(status, params, spawnGuard, runs, aggregated, passes, fails);
  return { markdown, details };
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function buildVerifyOnlyPrompt(
  verifierIndex: number,
  totalVerifiers: number,
  params: NormalizedParams,
): string {
  const voteNote =
    totalVerifiers > 1
      ? `\nYou are verifier ${verifierIndex} of ${totalVerifiers}; verdicts are combined by majority vote. Vote independently.`
      : "";
  return `You are the verifier in a VERIFICATION-ONLY orchestration. No executors ran in this orchestration — your job is to verify EXISTING state against the evidence checklist below. Text-only output is expected and correct.${voteNote}

EVIDENCE CHECKLIST (verbatim from the caller — treat each enumerable item as a check):
${params.task}

Instructions:
- Gather evidence yourself using read/bash/grep tools when paths or commands are given.
- For EVERY check, cite concrete evidence (file:line references, command output snippets).
- Do NOT modify any files. Do NOT run mutating commands.

Return JSON exactly and only in this shape:
{"overall":"pass"|"fail","reasons":["..."],"checks":[{"id":"check-1","description":"...","status":"pass"|"fail","citations":["path/to/file:42","command output: ..."]}]}

Use overall "pass" only if every check passes. Each check verdict MUST include at least one citation.`;
}

// ── Verifier agent profile (with evidence-gathering tools) ────────────────

function buildVerifierAgents(
  agents: Map<string, AgentProfile>,
  verifierAgent: string,
): Map<string, AgentProfile> {
  const cloned = new Map(agents);
  const profile = agents.get(verifierAgent) ?? { name: verifierAgent };
  const tools = new Set((profile.tools ?? []).map((t) => String(t).trim()).filter(Boolean));
  tools.add("read");
  tools.add("bash");
  tools.add("grep");
  cloned.set(verifierAgent, { ...profile, name: verifierAgent, tools: [...tools] });
  return cloned;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parseVerifyOnlyResult(text: string): {
  overall: "pass" | "fail";
  reasons: string[];
  checks: CheckVerdict[];
} {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    const overallRaw = String(raw.overall ?? raw.status ?? "").toLowerCase();
    const overall: "pass" | "fail" = overallRaw === "pass" ? "pass" : "fail";
    const reasons = stringArray(raw.reasons) ?? [];
    const checks: CheckVerdict[] = [];
    if (Array.isArray(raw.checks)) {
      for (const [index, item] of raw.checks.entries()) {
        if (!item || typeof item !== "object") continue;
        const check = item as Record<string, unknown>;
        const statusRaw = String(check.status ?? "").toLowerCase();
        checks.push({
          id: optionalString(check.id) ?? `check-${index + 1}`,
          description: optionalString(check.description) ?? "",
          status: statusRaw === "pass" ? "pass" : "fail",
          citations: stringArray(check.citations) ?? [],
        });
      }
    }
    if (overallRaw === "pass" || overallRaw === "fail") return { overall, reasons, checks };
  }
  return {
    overall: "fail",
    reasons: ["Verifier output was not parseable as the required verify-only JSON."],
    checks: [],
  };
}

// ── Per-check aggregation (majority across verifiers) ─────────────────────

function aggregateChecks(runs: VerifierRun[]): CheckVerdict[] {
  const byId = new Map<string, { description: string; passes: number; fails: number; citations: string[] }>();
  for (const run of runs) {
    for (const check of run.checks) {
      const entry = byId.get(check.id) ?? {
        description: check.description,
        passes: 0,
        fails: 0,
        citations: [],
      };
      if (check.status === "pass") entry.passes++;
      else entry.fails++;
      for (const citation of check.citations) {
        if (!entry.citations.includes(citation)) entry.citations.push(citation);
      }
      if (!entry.description && check.description) entry.description = check.description;
      byId.set(check.id, entry);
    }
  }
  return [...byId.entries()].map(([id, entry]) => ({
    id,
    description: entry.description,
    status: entry.passes >= entry.fails ? ("pass" as const) : ("fail" as const),
    citations: entry.citations,
  }));
}

// ── Result builders ────────────────────────────────────────────────────────

function buildFinalResult(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  runs: VerifierRun[],
  aggregated: CheckVerdict[],
  passes: number,
  fails: number,
): string {
  const lines: string[] = [
    `# Verify-Only Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task (evidence checklist):** ${truncateWithNotice(params.task, 2000, "task")}`,
    `**Paradigm:** verify-only (no planner/executor subagents spawned)`,
    `**Verifiers:** ${runs.length} (${passes} PASS, ${fails} FAIL)`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    "## Per-check verdicts",
  ];

  if (aggregated.length === 0) {
    lines.push("- No structured check verdicts were returned.");
  } else {
    for (const check of aggregated) {
      lines.push(
        `- **${check.id}** [${check.status.toUpperCase()}] ${check.description}`,
        ...check.citations.map((c) => `  - evidence: ${c}`),
      );
    }
  }

  lines.push("", "## Verifier runs");
  for (const run of runs) {
    lines.push(
      `### Verifier ${run.verifierIndex}: ${run.overall.toUpperCase()} (${run.agentName}${run.provider || run.model ? `, ${formatRoutedModel(run.provider, run.model)}` : ""}, ${run.durationMs}ms)`,
      run.reasons.length ? run.reasons.map((r) => `- ${r}`).join("\n") : "- No reasons provided.",
    );
  }

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "final verify-only report");
}

function buildDetails(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  runs: VerifierRun[],
  aggregated: CheckVerdict[],
  passes: number,
  fails: number,
): Record<string, unknown> {
  return {
    status,
    paradigm: "verify-only",
    params: { ...params, task: truncateWithNotice(params.task, MAX_DETAIL_CHARS, "task") },
    spawnedCount: spawnGuard.spawned,
    spawnedCap: spawnGuard.cap,
    executorSpawns: 0,
    plannerSpawns: 0,
    majorityVote: { passes, fails },
    checks: aggregated,
    verifierRuns: runs.map((run) => ({
      ...run,
      raw: truncateWithNotice(run.raw, MAX_DETAIL_CHARS, "verifier raw output"),
      reasons: run.reasons.map((r) => truncateWithNotice(r, MAX_DETAIL_CHARS, "verifier reason")),
    })),
  };
}

// ── Local utilities ────────────────────────────────────────────────────────

function inferVerifierCount(task: string): number {
  const match = task.toLowerCase().match(/\b(\d+)\s*verifier/i);
  if (match) {
    const count = parseInt(match[1], 10);
    if (count >= 1 && count <= MAX_VERIFIER_COUNT) return count;
    if (count > MAX_VERIFIER_COUNT) return MAX_VERIFIER_COUNT;
  }
  return DEFAULT_VERIFIER_COUNT;
}

function toModelOverride(
  model?: string,
  provider?: string,
): { model?: string; provider?: string } | undefined {
  if (!model && !provider) return undefined;
  return { model, provider };
}

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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}
