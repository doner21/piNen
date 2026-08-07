/**
 * Layer B — Orchestration Shape Interface
 * ========================================
 * Defines the contract every orchestration shape must satisfy.
 *
 * Shapes are siblings: they stand on the substrate, and they never build on
 * each other. A shape receives only normalized parameters and substrate
 * capabilities (spawnSubagent, runBoundedPool, buildExecutionWaves,
 * runWorkGraph, SpawnGuard, SUBSTRATE_CAPS, etc.).
 *
 * ONE-LINE RULE: Shapes are siblings, they stand on the substrate, they
 * never build on each other.
 */

import type { AgentProfile } from "./substrate";
import type { HardGatesMode } from "./judgment";
import type { LoadedRunState } from "./run-state";

// ── OrchestrationShape interface ───────────────────────────────────────────

/**
 * Every orchestration shape must implement this interface.
 *
 * Shapes are registered in the shape registry and selected via the
 * --paradigm flag (or the `paradigm` tool parameter). The default
 * paradigm is `plan-execute-verify`.
 */
export interface OrchestrationShape {
  /** Unique identifier for the shape (used with --paradigm). */
  name: string;
  /** Human-readable description shown when listing available shapes. */
  description: string;
  /** Execute the orchestration using only substrate primitives. */
  run(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult>;
}

/** Context passed to every OrchestrationShape.run() invocation. */
export interface OrchestrationShapeContext {
  /** Normalized parameters from the tool/command invocation. */
  params: NormalizedParams;
  /** AbortSignal to cancel the entire orchestration. */
  signal?: AbortSignal;
  /** Progress callback — shapes emit text updates through this channel. */
  onUpdate?: (update: unknown) => void;
  /** Model/provider inherited from the parent Pi call context. */
  inheritedModel?: { provider?: string; model?: string };
  /** Loaded agent profiles (defaults + custom agents from ~/.pi/agent/agents). */
  agents: Map<string, AgentProfile>;
  /** Pre-computed model routing inference from the task text.
   *  This is computed during normalization before the shape is invoked
   *  so shapes do not need to re-parse routing from natural language. */
  inferredModelRouting: InferredModelRouting;
  /** Stable run identifier (used for checkpoint/resume state). */
  runId?: string;
  /** Loaded state when this dispatch is a resume of a previous run
   *  (ABORT-RESUME-DESIGN.md). Shapes that support resume restore completed
   *  phases from checkpoints and re-attach or respawn detached phases. */
  resumeState?: LoadedRunState;
}

/** Result returned by a shape after orchestration completes. */
export interface OrchestrationShapeResult {
  markdown: string;
  details: unknown;
}

// ── Shared parameter types ─────────────────────────────────────────────────

/** Normalized parameters, produced before any shape is invoked. */
export interface NormalizedParams {
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
  /** Number of planner subagents to run in parallel when requested. */
  plannerCount: number;
  /** Number of verifier subagents to run in parallel when requested. */
  verifierCount: number;
  maxRetries: number;
  /** Whether maxRetries was explicitly set by the user (--max-retries / maxRetries param).
   *  Used by the termination-policy precedence in plan-execute-verify:
   *  explicit maxRetries param > normalized natural-language loop controls > planner-proposed > default. */
  maxRetriesExplicit: boolean;
  maxSubagents: number;
  maxSubagentsExplicit: boolean;
  cwd: string;
  allowLocalModel: boolean;
  /** Natural-language orchestration controls detected from the task text. */
  orchestrationControls: NaturalLanguageOrchestrationControls;
  /** Orchestration paradigm to use (defaults to plan-execute-verify). */
  paradigm?: string;
  /**
   * Hard-gate mode (F1): "advisory" (default) demotes text-shape heuristics
   * to warnings and lets the verifier verdict gate, escalating only on
   * effect-based contradictions; "strict" restores pre-verifier hard gates
   * (still immune for tasks with positive effect evidence); "off" disables
   * gates entirely (warnings only).
   */
  hardGates: HardGatesMode;
  /** Run 1-token provider health pings before spawning subagents (F5). */
  preflight: boolean;
  /** Optional per-role fallback routes for graceful degradation (F5). */
  plannerFallbackModel?: string;
  plannerFallbackProvider?: string;
  executorFallbackModel?: string;
  executorFallbackProvider?: string;
  verifierFallbackModel?: string;
  verifierFallbackProvider?: string;
  /** Comma-separated or array of file paths the contract allows the executor to mutate.
   *  Used by discovery-only mode and write-set enforcement (predict-then-write). */
  predictedWriteSet?: string[];
  /** When true, run planners and synthesis only; return the predicted write set
   *  without spawning any executor or verifier subagents. */
  discoveryOnly: boolean;
}

export interface RoleModelHint {
  model?: string;
  provider?: string;
}

export interface RuntimeRoleRoutingHint extends RoleModelHint {
  /** Canonical runtime role / agent name, e.g. "researcher". */
  role: string;
  agentName: string;
  /** Optional requested number of matching runtime-role spawns. */
  count?: number;
  /** Optional requested number of distinct perspectives for this role. */
  perspectiveCount?: number;
  /** Optional named perspectives, if the prompt supplied names. */
  perspectives?: string[];
}

export interface NaturalLanguageOrchestrationControls {
  maxSubagents?: number;
  maxSubagentsSource?: "natural_language" | "parameter" | "default";
  concurrency?: number;
  concurrencySource?: "natural_language" | "parameter" | "default";
  executorConcurrency?: number;
  executorCount?: number;
  plannerCount?: number;
  verifierCount?: number;
  roleConcurrencySource?: "natural_language" | "parameter" | "planner" | "default";
  maxAttempts?: number;
  maxRetries?: number;
  loopingSource?: "natural_language" | "parameter" | "default";
  researcherCount?: number;
  perspectiveCount?: number;
  perspectives?: string[];
  runtimeRoles: RuntimeRoleRoutingHint[];
  rawMatches: string[];
}

/**
 * Model routing inferred from natural language in the task text.
 * Produced during normalization so shapes receive it ready-made.
 */
export interface InferredModelRouting {
  planner?: RoleModelHint;
  executor?: RoleModelHint;
  verifier?: RoleModelHint;
  /** Runtime-role model hints such as "use DeepSeek V4 Pro for researchers". */
  runtimeRoles?: Record<string, RoleModelHint>;
}
