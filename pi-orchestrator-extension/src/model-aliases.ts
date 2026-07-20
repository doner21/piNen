/**
 * Shared model-alias resolution + id normalization — substrate leaf module.
 * =========================================================================
 * A DEPENDENCY-FREE leaf module (imports only types) that hosts the
 * known-models alias resolver (`modelAliasFromText`) plus two Wave-3 helpers
 * for composed-phase model routing (`normalizeAnthropicModelId`,
 * `resolveComposedPhaseModel`).
 *
 * WHY A SEPARATE MODULE (WAVE3-SPEC ITEM C): `src/shapes/composable-pipeline.ts`
 * needs the alias resolver, but importing it from `src/index.ts` would create a
 * circular import (index.ts imports composable-pipeline). Hosting the resolver
 * here — and re-exporting it from index.ts for callsite stability — breaks the
 * cycle. The move is BEHAVIOR-PRESERVING: `modelAliasFromText` /
 * `normalizeRoutingText` are copied verbatim from index.ts.
 *
 * `normalizeAnthropicModelId` fixes the malformed dotted anthropic id bug
 * (bug note composable-pipeline-composed-phase-malformed-sonnet-model-id.md):
 * "claude-sonnet-4.5" (a dot, which 404s) becomes "claude-sonnet-4-5" (dashes).
 * HARD INVARIANT: it is gated to `provider === "anthropic"` so it can NEVER
 * corrupt a valid non-anthropic id such as `openai-codex/gpt-5.5`.
 */

/** A model route override (both sides optional; undefined means inherit). */
export interface ModelRoute {
  model?: string;
  provider?: string;
}

// ── Alias resolver (moved verbatim from index.ts; behavior-preserving) ─────

/**
 * Normalize free-text routing tokens (deep-seek/deepseak → deepseek, codecs →
 * codex, lowercase) before alias matching. VERBATIM from index.ts.
 */
export function normalizeRoutingText(text: string): string {
  return text
    .replace(/deep[\s-]*seek|deepseak/gi, "deepseek")
    .replace(/codecs?/gi, "codex")
    .toLowerCase();
}

/**
 * Resolve a human-style model label to a canonical (provider, model) route
 * from the known-models registry, or undefined if unrecognized. VERBATIM from
 * index.ts (single source of truth for the alias registry).
 */
export function modelAliasFromText(text: string): ModelRoute | undefined {
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

// ── Wave-3 composed-phase routing helpers ──────────────────────────────────

/**
 * Defense-in-depth: convert dots to dashes in a constructed ANTHROPIC model id.
 * "claude-sonnet-4.5" (a dot, which 404s) → "claude-sonnet-4-5" (valid dashes).
 *
 * HARD INVARIANT: gated to `provider === "anthropic"`. A non-anthropic route
 * (e.g. `openai-codex/gpt-5.5`, `deepseek/deepseek-v4-flash`) is returned
 * UNCHANGED — the dot in `gpt-5.5` is a valid part of that id and must never be
 * altered. An undefined route (inherit) is returned unchanged.
 */
export function normalizeAnthropicModelId<T extends ModelRoute | undefined>(route: T): T {
  if (!route || route.provider !== "anthropic" || typeof route.model !== "string" || !route.model.includes(".")) {
    return route;
  }
  return { ...route, model: route.model.replace(/\./g, "-") } as T;
}

/** True when a route actually carries a model or provider (i.e. not "inherit"). */
function isRouted(route: ModelRoute | undefined): route is ModelRoute {
  return Boolean(route && (route.model || route.provider));
}

/**
 * Resolve the model route for a composed middle phase (synthesize/critique/
 * merge/redteam) that is NOT reachable by the planner/executor/verifier role
 * override params (WAVE3-SPEC ITEM C).
 *
 * Precedence:
 *   1. An explicit runtime-role hint (`inferredModelRouting.runtimeRoles[role]`)
 *      if present — normalized.
 *   2. Otherwise INHERIT an explicitly-routed valid role default: the executor
 *      route first, then the planner route.
 *   3. Otherwise undefined (inherit the session/agent model).
 *
 * The returned route is always run through `normalizeAnthropicModelId`, so a
 * dotted anthropic id can never escape — only a dashed/valid id or inherit.
 */
export function resolveComposedPhaseModel(args: {
  runtimeRole?: ModelRoute;
  executorRoute?: ModelRoute;
  plannerRoute?: ModelRoute;
}): ModelRoute | undefined {
  const { runtimeRole, executorRoute, plannerRoute } = args;
  if (isRouted(runtimeRole)) return normalizeAnthropicModelId(runtimeRole);
  if (isRouted(executorRoute)) return normalizeAnthropicModelId(executorRoute);
  if (isRouted(plannerRoute)) return normalizeAnthropicModelId(plannerRoute);
  return undefined;
}
