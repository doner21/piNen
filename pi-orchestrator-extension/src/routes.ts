/**
 * Shared route resolution — substrate-level helper (NOT a shape).
 * ================================================================
 * Single source of truth for honoring per-role executor/verifier/planner
 * route override params (executorModel/executorProvider, verifierModel/
 * verifierProvider, plannerModel/plannerProvider) across every shape.
 *
 * History: the dual-plan-synthesis-execute-verify shape hardcoded
 * EXECUTOR_ROUTE / VERIFIER_ROUTE constants and silently IGNORED the override
 * params for four production runs
 * (bug 2026-07-02-dual-plan-shape-silently-ignores-executor-verifier-route-overrides.md).
 * The fix (`resolveRoutes(params)`) is promoted here VERBATIM so every shape
 * shares identical semantics and the silent-route-override bug class is closed.
 *
 * SEMANTICS (byte-identical to dual-plan's prior production behavior):
 *   resolveRouteWithFallback(model, provider, fallback) =
 *     (model || provider)
 *       ? { provider: provider ?? fallback.provider, model: model ?? fallback.model }
 *       : fallback
 * i.e. if EITHER the model or provider override is present, the resolved route
 * fills the missing side from the role's default; otherwise the full default
 * constant is returned unchanged.
 */

/** A fully-resolved role route (both sides present). */
export interface ResolvedRoute {
  provider: string;
  model: string;
}

/**
 * Resolve a role route against a hardcoded fallback, honoring per-field
 * overrides. Semantics are IDENTICAL to dual-plan's original resolveRoutes
 * (see module header). Used by shapes that own a default route constant for a
 * role (e.g. dual-plan's EXECUTOR_ROUTE / VERIFIER_ROUTE).
 */
export function resolveRouteWithFallback(
  model: string | undefined,
  provider: string | undefined,
  fallback: ResolvedRoute,
): ResolvedRoute {
  return model || provider
    ? { provider: provider ?? fallback.provider, model: model ?? fallback.model }
    : fallback;
}

/**
 * Resolve a role route for shapes WITHOUT a hardcoded default (they inherit
 * the session/agent model when no override is given). Returns the explicit
 * override object, or undefined to mean "inherit". This mirrors the long-used
 * per-shape `toModelOverride` helpers so behavior is unchanged, but centralizes
 * it so the report Routes line can derive from the SAME resolved value passed
 * to the spawn.
 */
export function resolveRouteOverride(
  model: string | undefined,
  provider: string | undefined,
): { model?: string; provider?: string } | undefined {
  if (!model && !provider) return undefined;
  return { model, provider };
}

/**
 * Human-readable label for a resolved route, for the report `Routes:` line.
 * An undefined/empty route renders as inherited so the report never invents a
 * provider/model that was not actually resolved.
 */
export function formatRouteLabel(
  route: { provider?: string; model?: string } | undefined,
): string {
  if (!route || (!route.provider && !route.model)) return "inherited (session default)";
  return `${route.provider ?? "(inherited)"}/${route.model ?? "(inherited)"}`;
}

/**
 * Minimal parameter surface needed to route a phase in a custom/generated
 * shape. Keeping this structural avoids a routes.ts -> types.ts dependency.
 */
export interface ShapeRoleRoutingParams {
  plannerAgent: string;
  executorAgent: string;
  verifierAgent: string;
  plannerModel?: string;
  plannerProvider?: string;
  executorModel?: string;
  executorProvider?: string;
  verifierModel?: string;
  verifierProvider?: string;
}

export type CoreShapeRole = "planner" | "executor" | "verifier";

/**
 * Canonicalize a generated phase's semantic role. Aggregators are verifier
 * work: they judge prior outputs and must never fall through to a session
 * default when an explicit verifier route was supplied.
 */
export function canonicalShapeRole(
  role: string,
  agentName: string,
  params: ShapeRoleRoutingParams,
): CoreShapeRole | undefined {
  const normalized = role.trim().toLowerCase();
  if (normalized === "planner" || agentName === params.plannerAgent) return "planner";
  if (normalized === "executor" || agentName === params.executorAgent) return "executor";
  if (
    normalized === "verifier" ||
    normalized === "reviewer" ||
    normalized === "aggregator" ||
    agentName === params.verifierAgent
  ) return "verifier";
  return undefined;
}

/**
 * Resolve explicit core-role controls for a custom/generated shape phase.
 * This is the shared dispatch boundary that prevents bespoke shapes from
 * silently selecting a default provider while built-in PEV honors overrides.
 */
export function resolveShapePhaseRoute(
  role: string,
  agentName: string,
  params: ShapeRoleRoutingParams,
): { model?: string; provider?: string } | undefined {
  switch (canonicalShapeRole(role, agentName, params)) {
    case "planner":
      return resolveRouteOverride(params.plannerModel, params.plannerProvider);
    case "executor":
      return resolveRouteOverride(params.executorModel, params.executorProvider);
    case "verifier":
      return resolveRouteOverride(params.verifierModel, params.verifierProvider);
    default:
      return undefined;
  }
}
