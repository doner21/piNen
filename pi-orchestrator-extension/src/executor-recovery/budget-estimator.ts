/**
 * Layer RX-B — Pre-Spawn Budget Estimator
 * =======================================
 * Proactive context-budget estimation to prevent executor context exhaustion
 * BEFORE spawning. Shared resolveModelContextLimit() is the single source of
 * truth for model context-window sizes, consumed by both budget estimation and
 * adaptive task sizing.
 *
 * Lifecycle:
 *   1. resolveModelContextLimit()   — shared model→token-limit lookup
 *   2. estimateExecutorContextBudget() — pre-spawn saturation estimate
 *   3. computeAdaptiveTaskSizeCap() — model-aware word cap for task splitting
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Risk level produced by the pre-spawn budget estimator. */
export type BudgetRiskLevel = "SAFE" | "AT_RISK" | "CRITICAL";

/** Recommendation for the orchestrator after budget estimation. */
export type BudgetRecommendation = "PROCEED" | "SPLIT_BEFORE_SPAWN" | "REDUCE_SCOPE";

/**
 * Complete pre-spawn context budget estimate.
 *
 * Produced by estimateExecutorContextBudget() and consumed by the tiered
 * recovery system (executeExecutorTaskWithRecovery) to decide whether a
 * task can be dispatched as-is or must be split / reduced before dispatch.
 */
export interface ContextBudget {
  /** Prompt character count (task text + system prompt + intake snippet). */
  promptChars: number;
  /** Heuristic token count (chars / 3.5). */
  estimatedPromptTokens: number;
  /** The model's documented context-window limit in tokens. */
  maxAgentContextTokens: number;
  /** Saturation percent: (estimatedPromptTokens / maxAgentContextTokens) * 100. */
  saturationPercent: number;
  /** Discrete risk bucket derived from saturationPercent and thresholds. */
  risk: BudgetRiskLevel;
  /** Actionable recommendation for the orchestrator. */
  recommendation: BudgetRecommendation;
  /** Total overhead-padding tokens reserved for agent thinking + tool output. */
  reservedOverheadTokens: number;
  /** Tokens remaining after prompt and overhead reservation. */
  usableBudgetTokens: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Model Context Limit Lookup (shared single source of truth)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the documented context-window token limit for a given model or
 * provider/model string. This is the **single shared lookup** consumed by
 * both pre-spawn budget estimation and adaptive task sizing.
 *
 * Known models with explicit limits:
 *   - DeepSeek V4 / V4 Pro      → 128 000 tokens
 *   - GPT 5.5 / Codex            → 200 000 tokens
 *   - Claude 3.5 Sonnet / Opus   → 200 000 tokens
 *   - Gemma 4 (200k)             → 200 000 tokens
 *   - DeepSeek V3, R1            → 128 000 tokens
 *   - GPT-4o, GPT-4-turbo        → 128 000 tokens
 *
 * @param modelId  Optional model identifier (can be a full model string).
 *                 Falls back to 200 000 if unrecognized (conservative default).
 * @returns        Context window size in tokens.
 */
export function resolveModelContextLimit(modelId?: string): number {
  if (!modelId) return 200_000; // conservative default

  const lowered = modelId.toLowerCase();

  // ── DeepSeek family: 128k ──────────────────────────────────────────
  if (
    lowered.includes("deepseek") &&
    (lowered.includes("v4") || lowered.includes("v3") || lowered.includes("r1") || lowered.includes("chat"))
  ) {
    return 128_000;
  }
  // Legacy deepseek models — default 128k
  if (lowered.includes("deepseek")) return 128_000;

  // ── GPT 5.x / Codex: 200k ──────────────────────────────────────────
  if (lowered.includes("gpt-5") || lowered.includes("gpt5") || lowered.includes("codex")) {
    return 200_000;
  }

  // ── GPT-4 family: 128k (except gpt-4-32k which we map conservatively) ──
  if (lowered.includes("gpt-4")) {
    if (lowered.includes("32k")) return 32_000;
    return 128_000;
  }

  // ── Claude family: 200k ────────────────────────────────────────────
  if (lowered.includes("claude-3") || lowered.includes("claude-3.5") || lowered.includes("claude-4")) {
    return 200_000;
  }
  // Claude Opus / Sonnet generic
  if (lowered.includes("claude")) return 200_000;

  // ── Gemma: 200k for the 200k variant, otherwise 128k ───────────────
  if (lowered.includes("gemma")) {
    if (lowered.includes("200k")) return 200_000;
    return 128_000;
  }

  // ── Gemini: 1M+ for latest, conservative 200k for others ───────────
  if (lowered.includes("gemini")) return 200_000;

  // ── Mistral / Mixtral: 128k ────────────────────────────────────────
  if (lowered.includes("mistral") || lowered.includes("mixtral")) return 128_000;

  // ── Llama 3: 128k ──────────────────────────────────────────────────
  if (lowered.includes("llama")) return 128_000;

  // ── Pi default: 200k ───────────────────────────────────────────────
  return 200_000;
}

// ═══════════════════════════════════════════════════════════════════════════
// Budget Estimation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for estimateExecutorContextBudget().
 */
export interface BudgetEstimateOptions {
  /** Override the model context limit (uses resolveModelContextLimit by default). */
  modelContextLimit?: number;
  /**
   * Saturation threshold for AT_RISK classification (percent, default 50).
   * Above this but below criticalThreshold → AT_RISK.
   */
  riskThreshold?: number;
  /**
   * Saturation threshold for CRITICAL classification (percent, default 65).
   * Above this → CRITICAL.
   */
  criticalThreshold?: number;
  /**
   * Overhead multiplier: what fraction of the context limit to reserve for
   * agent thinking, tool output accumulation, and framework scaffolding
   * (default 0.35 = 35%).
   */
  overheadFraction?: number;
}

const DEFAULT_RISK_THRESHOLD = 50;
const DEFAULT_CRITICAL_THRESHOLD = 65;
const DEFAULT_OVERHEAD_FRACTION = 0.35;

/**
 * Estimate how much of the executor agent's context window a task prompt
 * will consume, and produce a risk/recommendation.
 *
 * This runs BEFORE the executor is spawned so the orchestrator can split
 * or reduce scope proactively instead of relying on recovery after failure.
 *
 * @param promptChars   Total character count of the prompt that will be sent
 *                      to the executor (task + system prompt + intake relevant).
 * @param modelId       Optional model/provider identifier for context-limit lookup.
 * @param options       Optional overrides for thresholds and overhead fraction.
 * @returns             A ContextBudget with risk level and recommendation.
 */
export function estimateExecutorContextBudget(
  promptChars: number,
  modelId?: string,
  options?: BudgetEstimateOptions,
): ContextBudget {
  const riskThreshold = options?.riskThreshold ?? DEFAULT_RISK_THRESHOLD;
  const criticalThreshold = options?.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
  const overheadFraction = options?.overheadFraction ?? DEFAULT_OVERHEAD_FRACTION;

  const maxAgentContextTokens =
    options?.modelContextLimit ?? resolveModelContextLimit(modelId);

  const estimatedPromptTokens = Math.ceil(promptChars / 3.5);
  const saturationPercent = Math.round(
    (estimatedPromptTokens / maxAgentContextTokens) * 100,
  );

  const reservedOverheadTokens = Math.ceil(maxAgentContextTokens * overheadFraction);
  const usableBudgetTokens = Math.max(
    0,
    maxAgentContextTokens - estimatedPromptTokens - reservedOverheadTokens,
  );

  let risk: BudgetRiskLevel;
  let recommendation: BudgetRecommendation;

  if (saturationPercent >= criticalThreshold) {
    risk = "CRITICAL";
    recommendation = "SPLIT_BEFORE_SPAWN";
  } else if (saturationPercent >= riskThreshold) {
    risk = "AT_RISK";
    recommendation = "PROCEED"; // proceed but recovery system monitors
  } else {
    risk = "SAFE";
    recommendation = "PROCEED";
  }

  return {
    promptChars,
    estimatedPromptTokens,
    maxAgentContextTokens,
    saturationPercent,
    risk,
    recommendation,
    reservedOverheadTokens,
    usableBudgetTokens,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Adaptive Task Size Cap
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for computeAdaptiveTaskSizeCap().
 */
export interface AdaptiveSizeOptions {
  /**
   * Fraction of the context limit allocated for the task description itself
   * (default 0.40 = 40%).
   */
  taskBudgetFraction?: number;
  /**
   * Minimum word count for the cap (default 60). Prevents tasks from being
   * split into trivially small fragments.
   */
  minWords?: number;
  /**
   * Maximum word count for the cap (default 500). Prevents runaway task
   * sizes even on models with huge context windows.
   */
  maxWords?: number;
}

const DEFAULT_TASK_BUDGET_FRACTION = 0.40;
const DEFAULT_MIN_WORDS = 60;
const DEFAULT_MAX_WORDS = 500;

/**
 * Compute an adaptive word cap for executor task descriptions based on the
 * actual model context limit.
 *
 * Uses resolveModelContextLimit() (the shared lookup) so both the pre-spawn
 * budget estimator and the task sizing logic derive their numbers from the
 * same source. The formula:
 *
 *   usableTokens = (contextLimit * taskBudgetFraction) - (contextLimit * 0.35)
 *   safeTokens   = max(500, usableTokens)
 *   words        = ceil(safeTokens * 0.75)
 *   clamped      = clamp(words, minWords, maxWords)
 *
 * Where 0.35 is the overhead reservation and 0.75 is the token-to-word
 * heuristic ratio.
 *
 * @param modelId   Optional model/provider identifier for context-limit lookup.
 * @param options   Optional overrides for budget fraction and word bounds.
 * @returns         Word cap for task descriptions.
 */
export function computeAdaptiveTaskSizeCap(
  modelId?: string,
  options?: AdaptiveSizeOptions,
): number {
  const limit = resolveModelContextLimit(modelId);
  const taskBudgetFraction = options?.taskBudgetFraction ?? DEFAULT_TASK_BUDGET_FRACTION;
  const minWords = options?.minWords ?? DEFAULT_MIN_WORDS;
  const maxWords = options?.maxWords ?? DEFAULT_MAX_WORDS;

  const usableTokens = Math.ceil(limit * taskBudgetFraction) - Math.ceil(limit * 0.35);
  const safeTokens = Math.max(500, usableTokens);
  const words = Math.ceil(safeTokens * 0.75);

  return Math.min(Math.max(words, minWords), maxWords);
}
