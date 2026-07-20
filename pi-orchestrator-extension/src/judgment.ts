/**
 * Judgment Layer — effect-based verdict substrate
 * ================================================
 * Shared by the inline orchestrator (src/index.ts) and the orchestration
 * shapes. Rebuilt per INTAKE_ORCHESTRATE_HARDENING (findings F1/F2/F5/F6 of
 * ORCHESTRATION_HARNESS_FEEDBACK_2026-06-12):
 *
 *   - Verdicts derive from OBSERVED EFFECTS (worktree mutation, tool-call
 *     records, verifier evidence), never from reply-text shape heuristics.
 *   - Text-shape heuristics (truncation signals, "text-only response",
 *     "suspiciously short output", escape clauses, file-claim regex checks)
 *     are demoted to WARNINGS. They can never determine a verdict on their
 *     own.
 *   - A task with >= 1 successful mutating tool call or >= 1 worktree file
 *     change is IMMUNE from all text-shape findings (F1 required behavior #1).
 *   - The verifier's evidenced verdict is the gate. Hard gates may only
 *     escalate (force FAIL) on effect-based contradictions — e.g. verifier
 *     claims files exist but the worktree shows none (the 2026-06-03
 *     false-PASS case).
 *   - `hardGates: "strict" | "advisory" | "off"` selects how findings are
 *     applied. Default is "advisory".
 */

// ── Hard gate modes ────────────────────────────────────────────────────────

export type HardGatesMode = "strict" | "advisory" | "off";

export const DEFAULT_HARD_GATES_MODE: HardGatesMode = "advisory";

export function normalizeHardGatesMode(value: unknown): HardGatesMode {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "strict" || lower === "advisory" || lower === "off") return lower;
    if (lower === "false" || lower === "none" || lower === "disabled") return "off";
    if (lower === "true") return "strict";
  }
  return DEFAULT_HARD_GATES_MODE;
}

// ── Tool-call evidence ─────────────────────────────────────────────────────

/**
 * Tool names whose successful execution counts as a worktree mutation.
 * bash is included because file mutations through shell commands are the
 * dominant executor pattern observed in real transcripts.
 */
export const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "multiedit",
  "multi_edit",
  "str_replace",
  "str_replace_editor",
  "apply_patch",
  "applypatch",
  "notebookedit",
]);

export interface ToolCallSummary {
  /** Total tool executions observed for this subagent. */
  total: number;
  /** Tool executions whose tool is in MUTATING_TOOLS. */
  mutating: number;
  /** Per-tool execution counts. */
  byTool: Record<string, number>;
}

export function emptyToolCallSummary(): ToolCallSummary {
  return { total: 0, mutating: 0, byTool: {} };
}

export function recordToolCall(summary: ToolCallSummary, toolName: string): void {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return;
  summary.total++;
  summary.byTool[normalized] = (summary.byTool[normalized] ?? 0) + 1;
  if (MUTATING_TOOLS.has(normalized)) summary.mutating++;
}

export function formatToolCallSummary(summary: ToolCallSummary | undefined): string {
  if (!summary) return "no tool-call telemetry";
  const byTool = Object.entries(summary.byTool)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(", ");
  return `${summary.total} total / ${summary.mutating} mutating${byTool ? ` (${byTool})` : ""}`;
}

// ── Per-task effect evidence ───────────────────────────────────────────────

export interface TaskEffectEvidence {
  taskId: string;
  isImplementationTask: boolean;
  /** Mutating tool executions recorded for this task's subagent(s). */
  mutatingToolCalls: number;
  /** Total tool executions recorded for this task's subagent(s). */
  totalToolCalls: number;
  /**
   * Worktree files attributable to this task (pre/post snapshot delta).
   * undefined = unknown (git unavailable / no snapshot).
   */
  filesChanged?: number;
}

/**
 * F1 required behavior #1: an implementation task with >= 1 successful
 * mutating tool call (or >= 1 observed worktree file change) MUST NOT be
 * failed by any text-shape heuristic.
 */
export function hasPositiveEffectEvidence(evidence: TaskEffectEvidence | undefined): boolean {
  if (!evidence) return false;
  if (evidence.mutatingToolCalls > 0) return true;
  if ((evidence.filesChanged ?? 0) > 0) return true;
  return false;
}

// ── Findings + decision ────────────────────────────────────────────────────

export interface GateFinding {
  /** Task this finding is about, when attributable. */
  taskId?: string;
  /** Human-readable evidence message. */
  message: string;
  /**
   * "text-shape": derived from reply-text heuristics (truncation regexes,
   *   word counts, file-claim prose parsing, escape-clause scans, ...).
   * "effect": derived from observed effects (git deltas, tool-call records)
   *   contradicting what the task class or executor/verifier claims.
   */
  kind: "text-shape" | "effect";
}

export interface GateDecision {
  /**
   * Failures that abort the attempt BEFORE the verifier is spawned.
   * Only populated in "strict" mode (effect findings + non-immune
   * text-shape findings). Always empty in "advisory" and "off".
   */
  preVerifierFailures: string[];
  /**
   * Effect-based contradictions that force FAIL when the verifier returns
   * PASS (the false-PASS guard). Populated in "strict" and "advisory".
   */
  escalations: string[];
  /**
   * Demoted findings carried in the report. Never verdict-determining.
   */
  warnings: string[];
}

/**
 * Central judgment-layer decision. Applies hard-gate mode semantics and the
 * per-task effect-evidence immunity rule.
 */
export function resolveGateDecision(options: {
  mode: HardGatesMode;
  textShapeFindings: GateFinding[];
  effectFindings: GateFinding[];
  effectEvidenceByTask: Map<string, TaskEffectEvidence>;
}): GateDecision {
  const { mode, textShapeFindings, effectFindings, effectEvidenceByTask } = options;
  const decision: GateDecision = { preVerifierFailures: [], escalations: [], warnings: [] };

  for (const finding of textShapeFindings) {
    const evidence = finding.taskId ? effectEvidenceByTask.get(finding.taskId) : undefined;
    const immune = hasPositiveEffectEvidence(evidence);
    if (immune) {
      decision.warnings.push(
        `[text-shape, demoted — task has positive effect evidence (${evidence!.mutatingToolCalls} mutating tool call(s), ${evidence!.filesChanged ?? "unknown"} file(s) changed)] ${finding.message}`,
      );
      continue;
    }
    if (mode === "strict") {
      decision.preVerifierFailures.push(`[text-shape] ${finding.message}`);
    } else {
      decision.warnings.push(`[text-shape, advisory] ${finding.message}`);
    }
  }

  for (const finding of effectFindings) {
    if (mode === "off") {
      decision.warnings.push(`[effect, gates off] ${finding.message}`);
      continue;
    }
    if (mode === "strict") {
      decision.preVerifierFailures.push(`[effect] ${finding.message}`);
    }
    // In both strict and advisory, effect findings are escalation
    // candidates: a verifier PASS contradicted by effects is forced to FAIL.
    decision.escalations.push(finding.message);
  }

  return decision;
}

/**
 * Build per-task effect findings for implementation tasks that show zero
 * observed effects. These are the only findings allowed to force FAIL on
 * their own (post-verifier escalation in advisory mode; pre-verifier in
 * strict mode).
 *
 * A finding is produced only when the evidence is conclusive:
 * - zero mutating tool calls recorded, AND
 * - the worktree delta is known-zero, OR the worktree state is unknown
 *   (tool-call telemetry alone is then the ground truth).
 */
export function buildZeroEffectFindings(
  evidenceByTask: Map<string, TaskEffectEvidence>,
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const evidence of evidenceByTask.values()) {
    if (!evidence.isImplementationTask) continue;
    if (hasPositiveEffectEvidence(evidence)) continue;
    const worktree =
      evidence.filesChanged === undefined
        ? "worktree delta unknown (git unavailable)"
        : `${evidence.filesChanged} worktree file change(s)`;
    findings.push({
      taskId: evidence.taskId,
      kind: "effect",
      message:
        `${evidence.taskId}: implementation task produced zero observed effects — ` +
        `${evidence.mutatingToolCalls} mutating tool call(s) of ${evidence.totalToolCalls} total, ${worktree}. ` +
        `Effect-based gate (mechanical; reply text was not consulted).`,
    });
  }
  return findings;
}

/**
 * False-PASS guard (the 2026-06-03 case): verifier returned PASS while
 * implementation tasks exist and zero effects were observed anywhere.
 * Returns the contradiction evidence string, or null when no contradiction.
 */
export function detectFalsePassContradiction(options: {
  hasImplementationTask: boolean;
  anyMutatingToolCalls: boolean;
  anyFilesChanged: boolean;
  gitAvailable: boolean;
}): string | null {
  const { hasImplementationTask, anyMutatingToolCalls, anyFilesChanged, gitAvailable } = options;
  if (!hasImplementationTask) return null;
  if (anyMutatingToolCalls || anyFilesChanged) return null;
  const worktree = gitAvailable
    ? "git worktree shows zero file changes"
    : "git unavailable; tool-call telemetry shows zero mutations";
  return (
    `verifier verdict contradicts observed effects: implementation task(s) present, ` +
    `zero mutating tool calls recorded across all executors, and ${worktree}. ` +
    `A PASS without observable artifacts is the documented false-PASS failure class (2026-06-03).`
  );
}

// ── Structured provider errors (F5) ────────────────────────────────────────

export type ProviderErrorType = "rate_limit" | "auth" | "not_found" | "network" | "timeout" | "aborted" | "unknown";

export interface ProviderHealthError {
  provider?: string;
  model?: string;
  type: ProviderErrorType;
  message: string;
  /** ISO-8601 or epoch reset time extracted from rate-limit payloads, when present. */
  resetsAt?: string;
}

/**
 * Parse raw provider/subprocess failure text into a structured,
 * machine-readable error (F5: no more raw multi-KB JSON dumps).
 */
export function parseProviderError(
  rawText: string,
  provider?: string,
  model?: string,
): ProviderHealthError {
  const text = String(rawText ?? "");
  const compact = text.replace(/\s+/g, " ").trim();

  let type: ProviderErrorType = "unknown";
  if (/preflight[^\n]*aborted|orchestration aborted|abortsignal/i.test(text)) type = "aborted";
  else if (/preflight[^\n]*time(?:d)?\s*out|preflight_timeout/i.test(text)) type = "timeout";
  else if (/\b429\b|rate[\s_-]?limit|usage[\s_-]?limit|quota/i.test(text)) type = "rate_limit";
  else if (/no api key|api key|unauthorized|\b401\b|\b403\b|invalid[\s_-]?key|expired.*(token|oauth)|oauth.*expired|authentication/i.test(text)) type = "auth";
  else if (/\b404\b|model.{0,20}not found|unknown model|no such model/i.test(text)) type = "not_found";
  else if (/econnrefused|econnreset|etimedout|enotfound|network|socket hang up|fetch failed|timed? ?out/i.test(text)) type = "network";

  let resetsAt: string | undefined;
  const resetsMatch =
    text.match(/resets?_?at["':\s]+"?([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+\-Z]+)/i) ??
    text.match(/resets?_?at["':\s]+"?([0-9]{9,13})/i) ??
    text.match(/retry[-_ ]after["':\s]+"?([0-9]+)/i);
  if (resetsMatch) resetsAt = resetsMatch[1];

  const message =
    compact.length > 400 ? `${compact.slice(0, 400)}… (raw error truncated)` : compact || "unknown provider error";

  const error: ProviderHealthError = { type, message };
  if (provider) error.provider = provider;
  if (model) error.model = model;
  if (resetsAt) error.resetsAt = resetsAt;
  return error;
}

export function formatProviderError(error: ProviderHealthError): string {
  const route = [error.provider, error.model].filter(Boolean).join("/") || "(default route)";
  const resets = error.resetsAt ? `, resets_at=${error.resetsAt}` : "";
  return `provider=${route} type=${error.type}${resets} message=${error.message}`;
}

// ── Failed-task extraction for targeted retries (F2) ───────────────────────

/**
 * Extract plan task IDs referenced in verifier reasons / gate failure
 * strings. Used to retry only the failed tasks instead of re-executing
 * the entire plan.
 */
export function extractReferencedTaskIds(
  reasons: string[],
  knownTaskIds: Iterable<string>,
): Set<string> {
  const known = new Set<string>();
  const knownLower = new Map<string, string>();
  for (const id of knownTaskIds) {
    known.add(id);
    knownLower.set(id.toLowerCase(), id);
  }
  const referenced = new Set<string>();
  const text = reasons.join("\n");
  const matches = text.match(/\btask[-_][a-z0-9][\w.-]*/gi) ?? [];
  for (const match of matches) {
    const canonical = knownLower.get(match.toLowerCase());
    if (canonical) referenced.add(canonical);
  }
  return referenced;
}
