import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Recovery module imports (shared with plan-execute-verify shape) ───
import {
  assertWorkerPromptFitsCapacity,
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
import { createRoleRecoveryRequest, runRoleWithRecovery, observeRoleReadOnlyLaunch, isRoleContextExhaustion, isRoleRecoveryHandoff, RoleContextExhaustionError, type RoleRecoveryEvidence, type RoleRecoveryStage } from "./role-recovery";
import { CommandTimesCollector, mergeCommandTimes, commandTimesFromHostResults, formatCommandTimes, summarizeCommandTimes, type CommandTimes, type CommandTimingContext, type CommandTimingClocks } from "./command-times";
import { getCommandTimesForRun } from "./substrate";
import { RunStateStore, collectSurvivorResult, phaseLogPathFor, phaseResultPathFor, runsRootDir, type LoadedRunState, type TerminalNoRetryState } from "./run-state";
import {
  parseWriteSetInput,
  planEntriesOutsideContract,
  captureWriteSetSnapshot,
  evaluateWriteSetObservation,
  canonicalizeExternalEvidenceRoots,
  captureExternalEvidenceSnapshot,
  diffExternalEvidenceSnapshots,
  captureContentSignatureSnapshot,
  diffContentSignatureSnapshots,
  type ContentSignatureChange,
  normalizeWriteSetEntry,
  type ContentSignatureSnapshot,
  type WriteSetObservationEvaluation,
  type WriteSetSnapshot,
  type ExternalEvidenceSnapshot,
} from "./write-set";
import {
  SupervisionStateStore,
  buildInspectionSnapshot,
  checkAutomaticPlanApproval,
  checkLanePaths,
  partitionLaneViolations,
  classifyInfrastructureFailure,
  classifySettledExecutorOutcome,
  createFrozenMission,
  createGenericSupervisionCursor,
  createGenericSupervisionRuntime,
  createInitialSupervisionState,
  detectBoundaryDrift,
  deadOwningHostPauseReason,
  defaultProtectedRoots,
  evaluateNumericAcceptanceGates,
  numericTargetCoverageIssues,
  restartToPaused,
  issueApprovalToken,
  resolveShapeDispatch,
  transitionSupervisionState,
  hasBlockingVerificationIssues,
  checkObservedRouteAdvisories,
  createExecutorCheckpointHostMetadata,
  isRoutingOnlyVerificationFailure,
  settleRoutingOnlyVerificationFailure,
  validateCriterionTaskPlan,
  validateFinalVerification,
  type AcceptanceCriterion,
  type ApprovalConsumptionMetadata,
  type CriterionFinding,
  type CriterionTask,
  type FrozenMission,
  type GenericSupervisionRuntime,
  type GenericVerifierBatchEvidence,
  type NumericAcceptanceGate,
  type NumericAcceptanceTarget,
  type NumericGateFinding,
  type ObservedMissionRoute,
  type ProcessIdentityObserver,
  type RunLane,
  type SupervisionAction,
  type SupervisionRunState,
  type ScopeAmendment,
  HOST_TASK_BOUNDARY_PROTOCOL_ID,
  GENERIC_SHAPE_ADAPTER_ID,
  PEV_SHAPE_ADAPTER_ID,
} from "./supervision";
// Alias registry moved to a leaf module to break the composable-pipeline ->
// index.ts circular import (WAVE3-SPEC ITEM C). Re-exported below for external
// callsite stability.
import { modelAliasFromText, normalizeRoutingText } from "./model-aliases";
import { HostPublicationObservation, withHostPublicationObservation } from "./host-publications";
export { modelAliasFromText } from "./model-aliases";
import {
  AdaptiveEnforceCanaryStore,
  AdaptiveShadowJournal,
} from "./adaptive-supervision-integration";
import { AdaptiveProductionStore } from "./adaptive-production";
import {
  applyGapEvidence,
  canonicalAdaptiveValue,
  createAdaptiveShadowObservation,
  createFrozenMissionContract,
  type CurrentStrategy,
  type FailureObservation,
  type FrozenMissionContract,
  type Gap,
  type MissionContract,
  type StrategyMaterialProfile,
  type StrategyProposal,
} from "./adaptive-supervision";
export {
  adaptiveSupervisionV1Mode,
  runAdaptiveSupervisionV1Fixture,
} from "./adaptive-supervision-integration";

// ── Shape imports (orchestration paradigms) ───────────────────────────
import { composablePipelineShape } from "./shapes/composable-pipeline";
import { dualPlanSynthesisExecuteVerifyShape } from "./shapes/dual-plan-synthesis-execute-verify";
import { evidenceAuditShape } from "./shapes/evidence-audit";
import { frozenGateFixLoopShape } from "./shapes/frozen-gate-fix-loop";
import { independentReplicationShape } from "./shapes/independent-replication";
import { multiVerifyVoteShape } from "./shapes/multi-verify-vote";
import { paradigmCreatorShape } from "./shapes/paradigm-creator";
import { planExecuteVerifyShape } from "./shapes/plan-execute-verify";
// shape-builder generated imports:start
import { venueRescueSynthesisShape } from "./shapes/venue-rescue-synthesis";
import { preregisteredConcurrencySpikeShape } from "./shapes/preregistered-concurrency-spike";
import { m66ExplicitRoutingProofShape } from "./shapes/m66-explicit-routing-proof";
import { ssiSingleWriterExclusiveLaneShape } from "./shapes/ssi-single-writer-exclusive-lane";
// shape-builder generated imports:end
import { shapeBuilderShape } from "./shapes/shape-builder";
import { verifyOnlyShape } from "./shapes/verify-only";
import { winConsoleSpawnRootCauseShape } from "./shapes/win-console-spawn-root-cause";
import { winLifecycleProcessTraceShape } from "./shapes/win-lifecycle-process-trace";
import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NaturalLanguageOrchestrationControls,
  WorkerExecutionConstraints,
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

import {
  buildWindowsEpermEvidence,
  buildWindowsEpermSpawnAttempts,
  formatSpawnAttempt,
  formatSpawnFailure,
  isWindowsSpawnEperm,
  preflightProviderHealth,
  writeWindowsEpermEvidence,
  appendSubagentPhaseLog,
  acknowledgeNoOutputAlarm,
  withSubagentPhaseLogging,
  withWorkerExecutionConstraints,
  WORKER_EXECUTION_CONSTRAINTS_EXTENSION,
  WORKER_MONITOR_BOOTSTRAP_EXTENSION,
  WORKER_NO_OUTPUT_MONITOR_EXTENSION,
  SubagentPhaseResultRecorder,
  ActionEvidenceCollector,
  SubagentDetachedError,
  SubagentTerminalAmbiguousError,
  ProviderRefusalError,
  READ_ONLY_EVIDENCE_TOOLS,
  VERIFIER_EVIDENCE_TOOLS,
  buildProviderRefusalRetryPrompt,
  classifyProviderRefusal,
  isProvablyReadOnlySubagent,
  type ProviderRefusalInfo,
  freezeRunTestAuthorizationPolicy,
  materializeFrozenTestAuthorizationPolicy,
  resolveCompleteWorkerLaunchPrompt,
} from "./substrate";
import { getPiChildFirstJsonTimeoutMs, isPiJsonProtocolEvent, killOwnedProcessTree, resolvePiChildCommand } from "./child-launch.ts";
import {
  resolveDynamicWorkflow,
  resolvePinnedDynamicWorkflow,
  runDynamicWorkflow,
  type ResolvedDynamicWorkflow,
} from "./dynamic-workflow";
import { runOrchestratorNext, type OrchestratorNextRunParams, type OrchestratorNextWorkflow } from "./next/runner";
import { NO_FORCE_KILL_GUARD_READY_MARKER } from "./worker-execution-constraints";
import { NO_OUTPUT_MONITOR_READY_MARKER } from "./worker-no-output-monitor";
import {
  mergeActionEvidenceLedgers,
  type ActionEvidenceLedger,
} from "./action-evidence";
import {
  assessRecoveredVerifierSettlement,
  normalizeVisibleMainVerifierResponse,
  parseVisibleMainVerifierResponse,
  type NormalizedVisibleMainVerifierResponse,
  type RecoveredVerifierSettlementAssessment,
} from "./verifier-response";

// ── Orchestration paradigm names (kept in sync with shapeRegistry) ───
const ORCHESTRATION_PARADIGM_NAMES: readonly string[] = [
  "plan-execute-verify",
  "multi-verify-vote",
  "composable-pipeline",
  "dual-plan-synthesis-execute-verify",
  "verify-only",
  "paradigm-creator",
  "shape-builder",
  "win-console-spawn-root-cause",
  "win-lifecycle-process-trace",
  "frozen-gate-fix-loop",
  "evidence-audit",
  "independent-replication",
  // shape-builder generated paradigm names:start
    "venue-rescue-synthesis",
  "preregistered-concurrency-spike",
  "m66-explicit-routing-proof",
  "ssi-single-writer-exclusive-lane",
// shape-builder generated paradigm names:end
];

// ── Shape registry (maps paradigm names to orchestration shapes) ─────
const shapeRegistry = new Map<string, OrchestrationShape>([
  ["plan-execute-verify", planExecuteVerifyShape],
  ["multi-verify-vote", multiVerifyVoteShape],
  ["composable-pipeline", composablePipelineShape],
  ["dual-plan-synthesis-execute-verify", dualPlanSynthesisExecuteVerifyShape],
  ["verify-only", verifyOnlyShape],
  ["paradigm-creator", paradigmCreatorShape],
  ["win-console-spawn-root-cause", winConsoleSpawnRootCauseShape],
  ["win-lifecycle-process-trace", winLifecycleProcessTraceShape],
  ["frozen-gate-fix-loop", frozenGateFixLoopShape],
  ["evidence-audit", evidenceAuditShape],
  ["independent-replication", independentReplicationShape],
  // shape-builder generated registry entries:start
    ["venue-rescue-synthesis", venueRescueSynthesisShape],
  ["preregistered-concurrency-spike", preregisteredConcurrencySpikeShape],
  ["m66-explicit-routing-proof", m66ExplicitRoutingProofShape],
  ["ssi-single-writer-exclusive-lane", ssiSingleWriterExclusiveLaneShape],
// shape-builder generated registry entries:end
  ["shape-builder", shapeBuilderShape],
]);

/** Native names are reserved: declarative artifacts can never shadow them. */
export const NATIVE_SHAPE_NAMES: ReadonlySet<string> = new Set(shapeRegistry.keys());

/**
 * Executor-bearing shapes that implement their own deterministic, read-only
 * discovery mode. Other shapes must remain behind visible-main supervision even
 * when a caller supplies discoveryOnly; treating that flag as a universal bypass
 * would let an unaware custom/declarative shape spawn or mutate unsupervised.
 */
const DISCOVERY_ONLY_COMPATIBLE_SHAPES: ReadonlySet<string> = new Set([
  "plan-execute-verify",
  "dual-plan-synthesis-execute-verify",
]);

function isDeterministicReadOnlyInvocation(
  params: Pick<NormalizedParams, "discoveryOnly" | "task">,
  paradigm: string,
  resolvedDynamicWorkflow?: ResolvedDynamicWorkflow,
): boolean {
  return (params.discoveryOnly && DISCOVERY_ONLY_COMPATIBLE_SHAPES.has(paradigm)) ||
    (Boolean(resolvedDynamicWorkflow) && params.task.trim() === "SHAPE_CANARY");
}

interface AgentProfile {
  name: string;
  description?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  /** Internal provenance: this field came from Pi's saved default route. */
  providerIsPiDefault?: boolean;
  /** Internal provenance: saved model IDs require exact getModel semantics. */
  modelIsPiDefault?: boolean;
  tools?: string[];
  skills?: string[];
  agencyLevel?: string | number;
}

interface PlanTask {
  id: string;
  description: string;
  dependsOn: string[];
  /** Planner-declared: false = validation/audit task that legitimately changes no files; true = implementation task. */
  expectsFileChange?: boolean;
}

interface Plan {
  tasks: PlanTask[];
  notes: string;
  raw?: unknown;
  /** Product criteria emitted by the planner; host-derived task criteria remain the frozen authority. */
  acceptanceCriteria?: string[];
  /** Planner-declared exact files/prefixes the tasks will create or modify (predict-then-write). */
  predictedWriteSet?: string[];
  /** External or in-worktree inputs that are inspected but never mutated. */
  readOnlyInputs?: string[];
  /** Canonical external directories available for read/evidence evaluation only. */
  externalEvidenceRoots?: string[];
}

interface PlannerPathReferenceAdvisory {
  code: "external_read_only_reference";
  path: string;
  resolvedPath: string;
  message: string;
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
  /** Host-owned chronological action evidence captured from child JSONL. */
  actionEvidence?: ActionEvidenceLedger;
  commandTimes?: CommandTimes;
  /** Resolved route that produced this result (residual 2b, mirrors substrate.ts). */
  provider?: string;
  model?: string;
  /** Structured transport evidence always outranks terminal prose. */
  truncated?: boolean;
  /** Structured provider/launcher context-exhaustion evidence. */
  contextExhaustionSignal?: boolean;
  /** Substantive role recovery, with partial results separate from acceptance. */
  roleRecovery?: RoleRecoveryEvidence;
  /** Child auto-retry failures retained as nonterminal telemetry. */
  recoveredAssistantFailures?: string[];
  /** Provider refusal metadata retained across one defensive retry. */
  providerRefusal?: ProviderRefusalInfo;
}

interface ResolvedPiCommand {
  command: string;
  argsPrefix: string[];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  launchRuntime?: string;
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
  /** Host-owned chronological action evidence captured from child JSONL. */
  actionEvidence?: ActionEvidenceLedger;
  commandTimes?: CommandTimes;
  /** Effect evidence: worktree files changed during this task's window. */
  filesChanged?: number;
  changedFiles?: string[];
  /** Host-observed byte changes retained if a later workspace read fails. */
  effectChanges?: ContentSignatureChange[];
  /** Ordered task/recovery observation boundaries; null remains unavailable. */
  effectSnapshots?: Array<{ before: ContentSignatureSnapshot | null; after: ContentSignatureSnapshot | null }>;
  /** Completeness of byte-level observation; partial counts are lower bounds. */
  effectObservation?: { status: "complete" | "partial" | "unknown"; reason?: string };
  /** Resolved launcher route retained for mechanical checkpoint evidence. */
  provider?: string;
  model?: string;
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
  modelIsPiDefault?: boolean;
  providerIsPiDefault?: boolean;
}

interface RoutingRequirement {
  role: "planner" | "executor" | "verifier";
  agentName: string;
  provider?: string;
  model?: string;
  essential: boolean;
  source: "explicit_flag" | "natural_language" | "agent_profile" | "inherited";
  /** Required spawn evidence count for multi-instance core roles. */
  count?: number;
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
  /** Affirmatively named files/artifacts that every plan must preserve. */
  deliverables: string[];
  failureCriteria: string[];
  nonGoals: string[];
  ambiguities: string[];
  routingDecision: string;
  routingRequirements: RoutingRequirement[];
  orchestrationControls: NaturalLanguageOrchestrationControls;
  executorOutputContract?: string;
  /** Provenance of the executor output contract (F6). */
  executorOutputContractSource?: "explicit" | "inferred";
  /**
   * Inferred advisory criteria (F6): synthesized hints that may produce
   * warnings but MUST NOT cause a FAIL on their own.
   */
  inferredAdvisoryCriteria: string[];
  /** Provenance tags retained for backward-compatible run inspection. */
  criteriaProvenance: Array<{ text: string; kind: "success" | "failure"; source: "explicit" | "inferred" }>;
  /** Product authority copied from the owner's task, never planner synthesis. */
  ownerCriteria: { success: string[]; failure: string[]; outputContract?: string };
  /** Host safety/process constraints; these do not invent product acceptance. */
  supervisorAddedConstraints: string[];
  /** Planner/host presentation suggestions; advisory unless the owner made the format explicit. */
  plannerInferredPresentationRules: string[];
}

interface RoutingCheck {
  status: "pass" | "fail";
  reasons: string[];
}

interface InferredModelRouting {
  planner?: RoleModelOverride;
  executor?: RoleModelOverride;
  verifier?: RoleModelOverride;
  runtimeRoles?: Record<string, RoleModelOverride>;
}

type PublicAdaptiveSupervisionMode = "off" | "shadow-v1" | "enforce-canary-v1" | "adaptive-v1";

interface NormalizedParams {
  task: string;
  plannerAgent: string;
  executorAgent: string;
  verifierAgent: string;
  plannerModel?: string;
  plannerProvider?: string;
  executorModel?: string;
  executorProvider?: string;
  /** Alias for executor wave concurrency requested by role-specific controls. */
  executorConcurrency?: number;
  verifierModel?: string;
  verifierProvider?: string;
  concurrency: number;
  /** Number of planner subagents to run in parallel before selecting a deterministic plan. */
  plannerCount: number;
  /** Number of verifier subagents to run in parallel before deterministic verdict aggregation. */
  verifierCount: number;
  maxRetries: number;
  maxRetriesExplicit: boolean;
  maxSubagents: number;
  maxSubagentsExplicit: boolean;
  cwd: string;
  allowLocalModel: boolean;
  orchestrationControls: NaturalLanguageOrchestrationControls;
  /**
   * NL model routing inferred from the task text, AFTER per-role suppression.
   * Computed exactly once in normalizeParams: any role carrying an explicit
   * route param has its NL-inferred route dropped here. Every downstream
   * consumer (buildRoutingRequirements, the shape context) reuses THIS object
   * instead of re-running inferModelRoutingFromTask, so a suppressed NL model
   * can never be recombined with an explicit provider-only override.
   */
  inferredRouting: InferredModelRouting;
  paradigm?: string;
  /** Host-owned execution policy. Omission normalizes to visible-main. */
  supervision: "visible-main" | "off";
  /** Default-off adaptive observation/enforcement on the one bounded generic PEV path. */
  adaptiveSupervision: PublicAdaptiveSupervisionMode;
  /** Hard-gate mode (F1). Default "advisory". */
  hardGates: HardGatesMode;
  /** Contract-granted write scope (predict-then-write). Deterministically enforced when set. */
  predictedWriteSet?: string[];
  /** Canonical external directories available for read/evidence evaluation only, never writes. */
  externalEvidenceRoots?: string[];
  /** Optional criterion-bound gates read and evaluated by the host at verification. */
  numericAcceptanceGates?: Array<NumericAcceptanceGate & { criterionId: string }>;
  /** Run intake + planning only; spawn no executors/verifiers; return the discovery manifest. */
  discoveryOnly: boolean;
  /** Run provider health pings before spawning subagents (F5). Default true. */
  preflight: boolean;
  /** Opt-in mission-bound policy applied before worker tool dispatch. */
  workerExecutionConstraints: WorkerExecutionConstraints;
  plannerFallbackModel?: string;
  plannerFallbackProvider?: string;
  executorFallbackModel?: string;
  executorFallbackProvider?: string;
  verifierFallbackModel?: string;
  verifierFallbackProvider?: string;
}

function numericGateFailureIssues(findings: NumericGateFinding[]) {
  return findings
    .filter((finding) => finding.status === "fail")
    .map((finding) => ({
      code: "numeric_acceptance_failed",
      message: finding.observedValue === null
        ? `${finding.criterionId} numeric gate ${finding.metric} could not read a finite observed value: ${finding.error ?? "unknown evidence error"}`
        : `${finding.criterionId} numeric gate ${finding.metric} observed ${finding.observedValue} ${finding.op} ${finding.threshold}: FAIL.`,
      criterionId: finding.criterionId,
    }));
}

interface OrchestrationState {
  attempt: number;
  spawnedCount: number;
  plan: Plan | null;
  planText: string;
  /** All planner outputs for the latest attempt when plannerCount > 1. */
  plannerOutputs?: SubagentResult[];
  executorOutputs: ExecutorOutput[];
  verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string } | null;
  /** Individual verifier outputs for the latest attempt when verifierCount > 1. */
  verifierResults?: Array<{ agentName: string; status: "pass" | "fail"; reasons: string[]; raw: string }>;
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
    plannerOutputs?: SubagentResult[];
    executorOutputs: ExecutorOutput[];
    verifierResult: { status: "pass" | "fail"; reasons: string[]; raw: string };
    verifierResults?: Array<{ agentName: string; status: "pass" | "fail"; reasons: string[]; raw: string }>;
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
  action: Type.Optional(Type.Union([
    Type.Literal("run"), Type.Literal("inspect"), Type.Literal("continue"), Type.Literal("accept"), Type.Literal("pause"), Type.Literal("cancel"),
  ], { description: "Visible-main lifecycle action. Defaults to run. awaiting_supervisor is a checkpoint, never completion." })),
  runId: Type.Optional(Type.String({ description: "Durable supervised run id; required for inspect/continue/accept/pause/cancel." })),
  approvalToken: Type.Optional(Type.String({ description: "Opaque one-use checkpoint token returned by the immediately preceding supervised checkpoint; required for continue and accept." })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Required nonempty supervisor reason for action=accept. Persisted verbatim after trimming." })),
  supervision: Type.Optional(Type.Union([Type.Literal("visible-main"), Type.Literal("off")], { description: "Host supervision mode. Standard executor-bearing plan-execute-verify runs default to visible-main; use off only for explicit bounded/headless compatibility." })),
  adaptiveSupervision: Type.Optional(Type.Union([
    Type.Literal("off"), Type.Literal("shadow-v1"), Type.Literal("enforce-canary-v1"), Type.Literal("adaptive-v1"),
  ], { description: "Default-off Adaptive Supervision v1 mode. Shadow records actual non-controlling task observations; enforce-canary retains the bounded A,A,model-B,B canary; adaptive-v1 applies goal-preserving production replanning to real generic visible-main plan-execute-verify work." })),
  lane: Type.Optional(Type.Union([Type.Literal("product"), Type.Literal("orchestrator-maintenance")], { description: "Mutation lane. Product is the default and cannot modify Pi/orchestrator/config protected roots." })),
  task: Type.Optional(Type.String({ description: "Task for deterministic multi-agent orchestration. Optional when `resume` is provided (the stored task is reused)." })),
  resume: Type.Optional(Type.String({ description: "Legacy abort-survivor compatibility API. Resume a historical run by id; remains distinct from action/runId supervision controls. Supported paradigms: plan-execute-verify, preregistered-concurrency-spike, dual-plan-synthesis-execute-verify, frozen-gate-fix-loop, evidence-audit, independent-replication." })),
  plannerAgent: Type.Optional(Type.String({ default: "planner" })),
  executorAgent: Type.Optional(Type.String({ default: "coder" })),
  verifierAgent: Type.Optional(Type.String({ default: "reviewer" })),
  concurrency: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 16, description: "Executor concurrency per dependency wave (legacy alias for executorConcurrency)." })),
  executorConcurrency: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 16, description: "Executor concurrency per dependency wave; supports up to 16 simultaneous independent executors." })),
  executorCount: Type.Optional(Type.Number({ minimum: 1, maximum: 16, description: "Natural alias for executorConcurrency / available executor slots." })),
  plannerCount: Type.Optional(Type.Number({ default: 1, minimum: 1, maximum: 16, description: "Number of planner subagents to run simultaneously before deterministic plan selection." })),
  verifierCount: Type.Optional(Type.Number({ default: 1, minimum: 1, maximum: 16, description: "Number of verifier subagents to run simultaneously before deterministic strict aggregation." })),
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
  paradigm: Type.Optional(Type.String({ description: `Explicitly select an orchestration paradigm/shape. Built-ins: ${ORCHESTRATION_PARADIGM_NAMES.join(", ")}. A safe kebab-case declarative workflow name discovered from a trusted user/project workflow root is also accepted immediately, without reload. When omitted, a built-in paradigm is inferred from task keywords.` })),
  hardGates: Type.Optional(Type.String({ description: 'Hard-gate mode: "strict" | "advisory" | "off". Default "advisory": text-shape heuristics are demoted to warnings, the verifier verdict gates, and only effect-based contradictions (zero observed mutations for implementation work) can force FAIL.' })),
  preflight: Type.Optional(Type.Boolean({ description: "Run a 1-token provider health ping for each routed provider/model before spawning any subagent (default true). Failures produce a structured machine-readable error and a partial report." })),
  automaticPlanApproval: Type.Optional(Type.Boolean({ description: "Explicit launch opt-in, default false: automatically approve only an intact initial plan after fixed host in-scope and protected-area checks. Approval is recorded; exceptions remain with the supervisor." })),
  noForceKill: Type.Optional(Type.Boolean({ description: "Opt in to a frozen per-mission worker guard that rejects every bash argument object owning a timeout key whose value is not null before command dispatch (a timeout key that is absent, or present and null, is allowed). Ordinary missions default false." })),
  predictedWriteSet: Type.Optional(Type.String({ description: 'Contract-granted predicted write set: comma- or newline-separated repo-relative paths ("docs/a.md"), directory prefixes ("docs/"), or simple globs ("tools/*.mjs"). When set, per-task worktree deltas are checked deterministically after execution — any file mutated outside the set forces FAIL with WRITE_SET_VIOLATION naming the file, before verifier spawn. A plan whose predicted_write_set exceeds this scope fails before any executor spawns.' })),
  externalEvidenceRoots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32768 }), { maxItems: 32, description: "Canonical absolute directories that executors/verifiers may read and host numeric gates may evaluate. Evidence roots grant no write authority; any observed mutation remains a hard failure." })),
  numericAcceptanceGates: Type.Optional(Type.Array(Type.Object({
    criterionId: Type.String({ description: "Stable criterion id, for example AC-01." }),
    metric: Type.String({ description: "Human-readable metric name." }),
    unit: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Unit shared by the observed value and threshold, for example ms, s, count, frames, or %." })),
    source: Type.Object({
      path: Type.String({ description: "Persisted evidence file; relative paths resolve from the frozen mission cwd." }),
      jsonPointer: Type.Optional(Type.String({ description: "RFC 6901 pointer into JSON evidence. Mutually exclusive with regex." })),
      regex: Type.Optional(Type.String({ description: "Regex whose first capture (or full match) is numeric. Mutually exclusive with jsonPointer." })),
    }),
    op: Type.Union([Type.Literal("<"), Type.Literal("<="), Type.Literal(">"), Type.Literal(">="), Type.Literal("=="), Type.Literal("!=")]),
    threshold: Type.Number(),
  }), { maxItems: 100, description: "Optional host-evaluated numeric acceptance gates. Results are persisted as numericGateFindings and cannot be overridden by verifier prose." })),
  discoveryOnly: Type.Optional(Type.Boolean({ description: "Discovery-only mode (predict-then-write): run intake and planning, return the plan plus predicted write set as a manifest, and spawn no executors or verifiers. Use it to review/authorize scope cheaply before any mutation." })),
  plannerFallbackModel: Type.Optional(Type.String({ description: "Fallback model(s) for the planner when its primary route fails pre-flight. Comma-separated for a chain (e.g. 'claude-opus-4-20250514,deepseek-v4-pro,deepseek-v4-flash')." })),
  plannerFallbackProvider: Type.Optional(Type.String({ description: "Fallback provider(s) for the planner when its primary route fails pre-flight. Comma-separated, paired positionally with plannerFallbackModel." })),
  executorFallbackModel: Type.Optional(Type.String({ description: "Fallback model(s) for executors when their primary route fails pre-flight. Comma-separated for a chain." })),
  executorFallbackProvider: Type.Optional(Type.String({ description: "Fallback provider(s) for executors when their primary route fails pre-flight. Comma-separated, paired positionally with executorFallbackModel." })),
  verifierFallbackModel: Type.Optional(Type.String({ description: "Fallback model(s) for the verifier when its primary route fails pre-flight. Comma-separated for a chain." })),
  verifierFallbackProvider: Type.Optional(Type.String({ description: "Fallback provider(s) for the verifier when its primary route fails pre-flight. Comma-separated, paired positionally with verifierFallbackModel." })),
});

const orchestrateNextParamsSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("run"),
    Type.Literal("resume"),
    Type.Literal("inspect"),
  ], { description: "Run a new workflow, resume by durable runId, or inspect without launching workers. Defaults to run (or resume=true compatibility mode)." })),
  task: Type.Optional(Type.String({ description: "Task for a new run. Resume/inspect reuse the pinned task." })),
  workflow: Type.Optional(Type.Union([
    Type.Literal("read-only-fanout-join"),
    Type.Literal("single-writer-pev"),
  ], { description: "Explicit v2 pilot workflow for a new run. Writer PEV uses the host-fixed validator profile." })),
  cwd: Type.Optional(Type.String({ description: "Product workspace. Runtime event state is stored outside this directory." })),
  concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 16 })),
  allowLocalModel: Type.Optional(Type.Boolean({ description: "Local-model permission for a new run; pinned and restored on resume." })),
  plannerAgent: Type.Optional(Type.String()),
  executorAgent: Type.Optional(Type.String()),
  verifierAgent: Type.Optional(Type.String()),
  plannerProvider: Type.Optional(Type.String()),
  plannerModel: Type.Optional(Type.String()),
  plannerFallbackProvider: Type.Optional(Type.String({ description: "Comma-separated ordered provider fallbacks." })),
  plannerFallbackModel: Type.Optional(Type.String({ description: "Comma-separated ordered model fallbacks." })),
  executorProvider: Type.Optional(Type.String()),
  executorModel: Type.Optional(Type.String()),
  executorFallbackProvider: Type.Optional(Type.String({ description: "Comma-separated ordered provider fallbacks." })),
  executorFallbackModel: Type.Optional(Type.String({ description: "Comma-separated ordered model fallbacks." })),
  verifierProvider: Type.Optional(Type.String()),
  verifierModel: Type.Optional(Type.String()),
  verifierFallbackProvider: Type.Optional(Type.String({ description: "Comma-separated ordered provider fallbacks." })),
  verifierFallbackModel: Type.Optional(Type.String({ description: "Comma-separated ordered model fallbacks." })),
  validator: Type.Optional(Type.Literal("node-workspace-validator", {
    description: "Host-owned fixed validator profile for single-writer-pev. Executes only ./validate.cjs with the current Node runtime.",
  })),
  runId: Type.Optional(Type.String()),
  resume: Type.Optional(Type.Boolean({ description: "Compatibility alias for action=resume. A runId is required; task/workflow/routes/cwd are restored from durable state." })),
});

const orchestrateMissionParamsSchema = Type.Object({
  action: Type.Optional(StringEnum(["run", "resume", "inspect"] as const, { description: "Start, durably resume, or inspect one mission. Defaults to run." })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
  fallbacks: Type.Optional(Type.Array(Type.Object({
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
  }), { maxItems: 5 })),
  wallClockMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 604_800_000 })),
  maxTurns: Type.Optional(Type.Number({ minimum: 1, maximum: 1_000 })),
  maxRestarts: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  maxTokens: Type.Optional(Type.Number({ minimum: 1, maximum: 100_000_000 })),
  validator: Type.Optional(StringEnum(["node-workspace-validator", "read-only"] as const)),
  validatorTimeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 3_600_000 })),
  validatorMaxOutputBytes: Type.Optional(Type.Number({ minimum: 1_024, maximum: 16_777_216 })),
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 64 })),
});

const SUPERVISION_HOST_INSTANCE = `${process.pid}:${Math.round(performance.timeOrigin)}`;
const COMMAND_CHECKPOINT_FOLLOWUP_PREFIX = "ORCHESTRATE_VISIBLE_MAIN_CHECKPOINT";

export interface SupervisedSettlementInfo {
  phase: string;
  agentName: string;
  pid?: number;
}

interface SupervisedSettlementControl {
  abandonSignal: AbortSignal;
  onSettling: (info: SupervisedSettlementInfo) => void;
}

export interface SupervisedPauseSnapshot extends SupervisedSettlementInfo {
  requestedAt: number;
  elapsedMs: number;
  message: string;
}

/**
 * Small host-owned state machine for the two-step Escape contract. The first
 * Escape remains Pi's normal abort signal; a settle-on-abort child calls
 * acknowledge(), which renders immediately. Only a later Escape opens the
 * explicit abandonment confirmation.
 */
export function createSupervisedPauseInteraction(options: {
  now?: () => number;
  render: (snapshot: SupervisedPauseSnapshot) => void;
  notify: (message: string) => void;
  confirm: (title: string, message: string) => Promise<boolean>;
  abandon: (info: SupervisedSettlementInfo) => void;
}) {
  const now = options.now ?? Date.now;
  let pending: (SupervisedSettlementInfo & { requestedAt: number }) | undefined;
  let confirmation: Promise<void> = Promise.resolve();
  let confirmationOpen = false;

  const snapshot = (): SupervisedPauseSnapshot | undefined => {
    if (!pending) return undefined;
    const elapsedMs = Math.max(0, now() - pending.requestedAt);
    return {
      ...pending,
      elapsedMs,
      message:
        `Pause acknowledged — active phase ${pending.phase} (${pending.agentName}${pending.pid ? ` pid=${pending.pid}` : ""}); ` +
        `settling ${(elapsedMs / 1000).toFixed(1)}s. Escape again opens Confirm and abandon; ` +
        `abandonment can leave partial files.`,
    };
  };

  return {
    acknowledge(info: SupervisedSettlementInfo): void {
      if (pending) return;
      pending = { ...info, requestedAt: now() };
      options.notify(`Pause acknowledged immediately; waiting for active phase ${info.phase} to settle durably.`);
      const current = snapshot();
      if (current) options.render(current);
    },
    refresh(): void {
      const current = snapshot();
      if (current) options.render(current);
    },
    handleTerminalInput(data: string): boolean {
      if (!pending || confirmationOpen || data !== "\x1b") return false;
      confirmationOpen = true;
      const info = { phase: pending.phase, agentName: pending.agentName, ...(pending.pid ? { pid: pending.pid } : {}) };
      confirmation = (async () => {
        try {
          const confirmed = await options.confirm(
            "Confirm and abandon active phase?",
            `Abandon ${info.phase} now? This interrupts the settling worker and can leave partial files. ` +
              `Choose No to continue waiting for durable settlement.`,
          );
          if (confirmed) options.abandon(info);
        } finally {
          confirmationOpen = false;
        }
      })();
      return true;
    },
    whenConfirmationSettled(): Promise<void> { return confirmation; },
    settled(): void { pending = undefined; },
    current(): SupervisedPauseSnapshot | undefined { return snapshot(); },
  };
}

class ConfirmedSupervisedAbandonError extends Error {
  constructor(readonly phase: string) {
    super(`Supervisor explicitly confirmed abandonment of active phase ${phase}; partial files may remain.`);
    this.name = "ConfirmedSupervisedAbandonError";
  }
}

function buildCommandCheckpointFollowup(runId: unknown, checkpointId: unknown): string | undefined {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_-])?$/.test(runId) || runId.length > 128) return undefined;
  if (typeof checkpointId !== "string" || !/^checkpoint-\d{4,}$/.test(checkpointId)) return undefined;
  return `${COMMAND_CHECKPOINT_FOLLOWUP_PREFIX}\nInspect runId=${runId} checkpointId=${checkpointId}; compare the checkpoint with the frozen mission, criteria, and effects, then choose continue, accept with a reason when eligible, pause, or cancel. Coordinate only: do not implement product work or change the product run's lane.`;
}

function commandOutcomePresentation(details: Record<string, unknown>): { label: string; level: "info" | "warning" | "error"; phase: string } {
  const status = String(details.status ?? "unknown");
  if (status === "terminal") {
    const outcome = String(details.terminalOutcome ?? "unknown").toUpperCase();
    if (outcome === "ACCEPTED_WITH_REASON") return { label: "terminal ACCEPTED_WITH_REASON", level: "warning", phase: "accepted" };
    if (outcome === "RETIRED_DEAD_HOST") return { label: "terminal RETIRED_DEAD_HOST", level: "warning", phase: "retired" };
    return { label: `terminal ${outcome}`, level: outcome === "PASS" ? "info" : "error", phase: outcome === "PASS" ? "complete" : "failed" };
  }
  if (status === "awaiting_supervisor" || status === "plan_checkpoint") return { label: "awaiting supervisor (not complete)", level: "warning", phase: "awaiting supervisor" };
  if (status === "paused") return { label: "paused", level: "warning", phase: "paused" };
  if (status === "blocked_infrastructure") return { label: "blocked infrastructure", level: "error", phase: "blocked infrastructure" };
  if (status === "cancelled") return { label: "cancelled", level: "warning", phase: "cancelled" };
  if (status === "pass") return { label: "PASS", level: "info", phase: "complete" };
  if (status === "fail") return { label: "FAIL", level: "error", phase: "failed" };
  return { label: status.replace(/_/g, " "), level: "warning", phase: status.replace(/_/g, " ") };
}

export interface PausedRunRetirementSweepResult {
  retired: string[];
  rejected: Array<{ runId: string; code: string; reason: string }>;
}

/**
 * Conservatively collect pauses left by a prior dead-host sweep. The caller may
 * inject observations and a disposable root for deterministic tests. Rejected
 * candidates are read-only, including live and inaccessible process cases.
 */
export function retireConclusivePausedRuns(options: {
  rootDir?: string;
  observeProcess?: ProcessIdentityObserver;
  now?: () => Date;
} = {}): PausedRunRetirementSweepResult {
  const root = path.resolve(options.rootDir ?? runsRootDir());
  const result: PausedRunRetirementSweepResult = { retired: [], rejected: [] };
  if (!existsSync(root)) return result;
  let runIds: string[];
  try {
    runIds = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return result;
  }
  for (const runId of runIds) {
    try {
      const store = new SupervisionStateStore(runId, root);
      if (!existsSync(store.stateFile)) continue;
      const state = store.loadReadOnly();
      if (state.status !== "paused") continue;
      const retirement = store.retirePausedIfSafe({ observeProcess: options.observeProcess, now: options.now });
      if (retirement.retired) result.retired.push(runId);
      else result.rejected.push({ runId, code: retirement.assessment.code, reason: retirement.assessment.reason });
    } catch (error) {
      result.rejected.push({
        runId,
        code: "assessment_failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function pauseSupervisedRunsAfterHostRestart(): void {
  const root = runsRootDir();
  if (!existsSync(root)) return;
  for (const runId of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    try {
      const store = new SupervisionStateStore(runId, root);
      if (!existsSync(store.stateFile)) continue;
      const state = store.loadReadOnly();
      if (state.status === "terminal" || state.status === "cancelled") continue;
      const reason = deadOwningHostPauseReason(state.runtime?.hostInstanceId);
      if (!reason) continue; // live, current, legacy or unknown: preserve every persisted byte
      if (state.status === "paused" && state.pauseReason === reason && (!state.currentApproval || state.currentApproval.invalidatedAt)) continue;
      const paused = restartToPaused(state);
      paused.pauseReason = reason;
      // Observing a dead host never transfers ownership or detaches its workers.
      store.save(paused);
    } catch { /* malformed/legacy state remains fail-closed and is surfaced on explicit access */ }
  }
}

export default function (pi: ExtensionAPI) {
  // Retirement runs before this host marks newly orphaned work paused. A run
  // therefore needs a prior dead-host pause boundary rather than being retired
  // during the same host generation that first detects the restart.
  retireConclusivePausedRuns();
  pauseSupervisedRunsAfterHostRestart();
  const deliveredCommandCheckpoints = new Set<string>();
  async function runFromParams(
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: { cwd?: string; model?: { provider?: string; id?: string } },
    settlementControl?: SupervisedSettlementControl,
  ) {
    const action = (typeof params.action === "string" ? params.action : "run") as SupervisionAction;
    if (action !== "run") return runVisibleMainLifecycle(params, action, signal, onUpdate, ctx, undefined, settlementControl);

    // Resume dispatch (ABORT-RESUME-DESIGN.md): reload the stored run state
    // and re-dispatch the SAME paradigm with the stored task/params. Caller
    // params (other than resume) act as overrides.
    const resumeId = typeof params.resume === "string" && params.resume.trim() ? params.resume.trim() : undefined;
    let resumeState: LoadedRunState | undefined;
    if (resumeId) {
      resumeState = RunStateStore.load(resumeId);
      const { resume: _resume, ...overrides } = params;
      // Review 28 finding 1 of 2 (legacy plan-execute-verify persists
      // NormalizedParams, which never carries a top-level `noForceKill`
      // field -- only the nested `workerExecutionConstraints.noForceKill`
      // does): reading only `resumeState.state.params.noForceKill` wrongly
      // treated every such legacy run as frozen-false, so resuming with the
      // SAME top-level noForceKill the mission actually froze (true) was
      // refused as drift. The frozen value is the OR of both places the
      // freeze can live, exactly as normalizeParams computes it going in.
      const frozenConstraints = resumeState.state.params.workerExecutionConstraints;
      const frozenConstraintsNoForceKill = Boolean(frozenConstraints && typeof frozenConstraints === "object"
        && (frozenConstraints as Record<string, unknown>).noForceKill === true);
      const frozenNoForceKill = resumeState.state.params.noForceKill === true || frozenConstraintsNoForceKill;
      if (overrides.noForceKill !== undefined && overrides.noForceKill !== frozenNoForceKill) {
        throw new Error(
          `Worker execution constraint drift refused for ${resumeId}: ` +
          `frozen noForceKill=${frozenNoForceKill}, requested=${String(overrides.noForceKill)}.`,
        );
      }
      // Review 28 finding 2 of 2: the top-level check above only ever saw a
      // top-level override. A caller could instead nest a differing
      // noForceKill inside workerExecutionConstraints alongside an EXACT
      // copy of the stored testAuthorization, so the testAuthorization check
      // below never fires, and silently drop the frozen guard. Refuse any
      // nested noForceKill override that disagrees with the frozen value,
      // the same drift-refusal pattern as the top-level check.
      const overrideConstraintsNoForceKill = overrides.workerExecutionConstraints
        && typeof overrides.workerExecutionConstraints === "object"
        ? (overrides.workerExecutionConstraints as Record<string, unknown>).noForceKill
        : undefined;
      if (overrideConstraintsNoForceKill !== undefined && overrideConstraintsNoForceKill !== frozenNoForceKill) {
        throw new Error(
          `Worker execution constraint drift refused for ${resumeId}: ` +
          `frozen noForceKill=${frozenNoForceKill}, requested noForceKill=${String(overrideConstraintsNoForceKill)}.`,
        );
      }
      // Unlike noForceKill (checked above), the frozen package contract must
      // never be silently replaced on resume: a caller-supplied override that
      // differs from the stored admission-frozen policy is refused with the
      // same drift pattern, not merged in.
      const frozenTestAuthorization = frozenConstraints && typeof frozenConstraints === "object"
        ? (frozenConstraints as Record<string, unknown>).testAuthorization
        : undefined;
      const overrideConstraints = overrides.workerExecutionConstraints;
      const overrideTestAuthorization = overrideConstraints && typeof overrideConstraints === "object"
        ? (overrideConstraints as Record<string, unknown>).testAuthorization
        : undefined;
      // A workerExecutionConstraints override replaces the stored object
      // wholesale on resume (no deep merge), so an override that merely
      // OMITS testAuthorization (e.g. {} or { noForceKill: false }) would
      // otherwise silently drop the frozen policy just as effectively as one
      // that names a differing policy. Refuse on the override's mere
      // presence (not only when it explicitly names a differing policy) so
      // every omission that would change or drop the stored testAuthorization
      // is refused the same way.
      if (overrideConstraints !== undefined
        && JSON.stringify(overrideTestAuthorization) !== JSON.stringify(frozenTestAuthorization)) {
        throw new Error(
          `Worker execution constraint drift refused for ${resumeId}: ` +
          `frozen testAuthorization policyHash=${String((frozenTestAuthorization as { policyHash?: unknown } | undefined)?.policyHash)}, ` +
          `requested policyHash=${String((overrideTestAuthorization as { policyHash?: unknown } | undefined)?.policyHash)}.`,
        );
      }
      params = {
        ...resumeState.state.params,
        ...overrides,
        task: resumeState.state.task,
        paradigm: resumeState.state.paradigm,
      };
      // Review 29 finding 1: neither the top-level check nor the nested
      // check above fires when the override's nested workerExecutionConstraints
      // merely OMITS noForceKill entirely (e.g. { testAuthorization: <exact
      // stored copy> }), because both checks only compare an EXPLICITLY
      // present override value against the frozen one. The wholesale
      // replacement of the stored workerExecutionConstraints at the merge
      // above then silently drops a frozen nested noForceKill: true, and the
      // resumed worker launches unguarded. Recompute the EFFECTIVE
      // noForceKill of the merged params exactly as normalizeParams derives
      // it (top-level OR nested) and refuse any merge whose effective value
      // disagrees with the frozen one. This subsumes the two explicit-value
      // checks above (which still run first, for a more specific error
      // message) and additionally catches every omission shape, nested or
      // top-level, that would otherwise drop the guard by silently merging
      // it away rather than naming a differing value.
      const mergedConstraints = params.workerExecutionConstraints;
      const mergedEffectiveNoForceKill = params.noForceKill === true
        || Boolean(mergedConstraints && typeof mergedConstraints === "object"
          && (mergedConstraints as Record<string, unknown>).noForceKill === true);
      if (mergedEffectiveNoForceKill !== frozenNoForceKill) {
        throw new Error(
          `Worker execution constraint drift refused for ${resumeId}: ` +
          `frozen noForceKill=${frozenNoForceKill}, requested effective noForceKill=${String(mergedEffectiveNoForceKill)}.`,
        );
      }
    } else if (typeof params.task !== "string" || !params.task.trim()) {
      throw new Error("orchestrate requires `task` (or `resume` with a stored run id).");
    }

    const normalized = normalizeParams(params, ctx?.cwd ?? process.cwd());
    if (!resumeState) {
      // Fresh runs never accept a caller-supplied test authorization at the
      // public tool boundary. Pi's schema validation does not strip unknown
      // keys, so a caller can otherwise substitute a self-computed policy for
      // the admission freeze below; dropping it here (rather than trusting
      // its mere presence) guarantees the freeze is the sole source of worker
      // test authority on every fresh run.
      delete normalized.workerExecutionConstraints.testAuthorization;
    }
    if (!normalized.workerExecutionConstraints.testAuthorization) {
      normalized.workerExecutionConstraints.testAuthorization = freezeRunTestAuthorizationPolicy({
        cwd: normalized.cwd,
        ownerTask: normalized.task,
        approvedTestScopes: normalized.predictedWriteSet,
        historicalWithoutAuthority: Boolean(resumeState),
      });
    }
    params = { ...params, workerExecutionConstraints: normalized.workerExecutionConstraints };
    const paradigm = inferOrchestrationParadigm(normalized);
    // Adaptive Supervision v1 is intentionally a single public canary seam.
    // Fail closed before workflow resolution, provider preflight, or workers.
    assertBoundedAdaptiveInvocation(normalized, paradigm, params);
    const nativeShape = shapeRegistry.get(paradigm);
    const resolvedDynamicWorkflow = nativeShape
      ? undefined
      : resumeState
        ? resolvePinnedDynamicWorkflow(resumeState.state.dynamicWorkflow, paradigm, NATIVE_SHAPE_NAMES)
        : resolveDynamicWorkflow(paradigm, { cwd: normalized.cwd, nativeNames: NATIVE_SHAPE_NAMES });
    const execution = nativeShape?.execution ?? resolvedDynamicWorkflow?.execution;
    if (!nativeShape && !resolvedDynamicWorkflow) {
      const abortReason =
        `Unknown orchestration paradigm "${paradigm}". Available paradigms: ${[...shapeRegistry.keys()].join(", ")}. ` +
        `No ${paradigm}.workflow.json artifact was found in the trusted project or user workflow roots.`;
      return {
        markdown: `# Orchestration: FAIL\n\n${abortReason}\n\nNo provider preflight or worker was started.`,
        details: {
          status: "fail",
          paradigm,
          abortReason,
          spawnedCount: 0,
          preflightStarted: false,
        },
      };
    }

    // This is the single pre-dispatch capability gate. It runs before provider
    // preflight and before any shape can spawn. Omitted mode means visible-main;
    // only explicit off receives the legacy unsupervised disposition.
    const dispatch = resolveShapeDispatch(execution, normalized.supervision);
    if (dispatch.disposition === "fail-closed") {
      throw new Error(
        `SHAPE_EXECUTION_CONTRACT_REFUSED: ${paradigm} ${dispatch.reason}; ` +
          `no preflight or worker was started. Only explicit supervision=off may request legacy unsupervised execution.`,
      );
    }
    const deterministicReadOnlyInvocation = isDeterministicReadOnlyInvocation(
      normalized,
      paradigm,
      resolvedDynamicWorkflow,
    );
    if (dispatch.disposition === "supervised" && !deterministicReadOnlyInvocation) {
      return runVisibleMainLifecycle(params, action, signal, onUpdate, ctx, {
        identity: dispatch.identity,
        resumeState,
        resolvedDynamicWorkflow,
      }, settlementControl);
    }

    const inheritedModel = ctx?.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined;
    return runOrchestration(normalized, signal, onUpdate, inheritedModel, resumeState, resolvedDynamicWorkflow);
  }

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Run or supervise deterministic planner/executor/verifier orchestration. A visible-main awaiting_supervisor response is a frozen checkpoint, not completion: inspect it and choose continue, accept with a persisted reason when eligible, pause, or cancel; do not implement product work directly. Adaptive Supervision is default-off and bounded to generic visible-main plan-execute-verify.",
    promptSnippet: "Deterministically orchestrate a task with durable visible-main checkpoints between the plan, every executor, and verification.",
    promptGuidelines: [
      "Use orchestrate for bounded multi-agent task decomposition when the user asks for deterministic orchestration or planner/executor/verifier workflow.",
      "awaiting_supervisor is never completion. Call inspect with runId, audit the frozen mission/checkpoint, then choose continue, eligible terminal accept with a nonempty reason, pause, or cancel using the checkpoint's one-use approvalToken. The visible agent must not implement product work itself.",
      "Standard implementation plan-execute-verify tool runs default to supervision=visible-main. Use supervision=off only when an explicit bounded/headless compatibility run is intended.",
      "When the user asks for different models per role (e.g. 'plan with GPT 5.5, execute with DeepSeek V4'), pass plannerModel/plannerProvider, executorModel/executorProvider, or verifierModel/verifierProvider. If the user does not specify a model for a role, omit those parameters so the subagent inherits its configured default.",
    ],
    parameters: orchestrateParamsSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runFromParams(
        params as Record<string, unknown>, signal,
        onUpdate as ((update: unknown) => void) | undefined,
        ctx,
      );
      return {
        content: [{ type: "text", text: result.markdown }],
        details: result.details,
      };
    },
  });

  pi.registerTool({
    name: "orchestrate_next",
    label: "Orchestrator Next",
    description: "Run, durably resume, or inspect the opt-in Orchestrator Next v2 event-sourced kernel with real Pi JSON subprocess workers.",
    promptSnippet: "Use Orchestrator Next for explicit v2 read-only fan-out or single-writer plan/execute/test/verify runs.",
    promptGuidelines: [
      "For action=run, choose workflow explicitly. single-writer-pev requires validator=node-workspace-validator; caller-controlled executable paths and argv are not accepted.",
      "For action=resume or inspect, supply only runId (and optionally action); workflow inputs and routes are restored from pinned durable state.",
      "This is the side-by-side v2 path. Use it when validating or exercising Orchestrator Next rather than legacy shapes.",
    ],
    parameters: orchestrateNextParamsSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      const agents = await loadAgents();
      const inheritedModel = ctx?.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined;
      const action = (typeof params.action === "string" ? params.action : params.resume === true ? "resume" : "run") as "run" | "resume" | "inspect";
      const workflow = typeof params.workflow === "string" ? params.workflow as OrchestratorNextWorkflow : undefined;
      const nextParams: OrchestratorNextRunParams = {
        action,
        ...(typeof params.task === "string" ? { task: params.task } : {}),
        ...(workflow ? { workflow } : {}),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : action === "run" ? { cwd: String(ctx?.cwd ?? process.cwd()) } : {}),
        ...(typeof params.concurrency === "number" ? { concurrency: params.concurrency } : {}),
        ...(typeof params.allowLocalModel === "boolean" ? { allowLocalModel: params.allowLocalModel } : {}),
        ...(typeof params.resume === "boolean" ? { resume: params.resume } : {}),
        ...copyOptionalStringParams(params, [
          "runId", "plannerAgent", "executorAgent", "verifierAgent",
          "plannerProvider", "plannerModel", "plannerFallbackProvider", "plannerFallbackModel",
          "executorProvider", "executorModel", "executorFallbackProvider", "executorFallbackModel",
          "verifierProvider", "verifierModel", "verifierFallbackProvider", "verifierFallbackModel",
        ]),
      };
      if (action === "run" && workflow === "single-writer-pev") {
        if (params.validator !== "node-workspace-validator") {
          throw new Error("single-writer-pev requires validator=node-workspace-validator");
        }
        nextParams.testExecutable = process.execPath;
        nextParams.testArgs = ["validate.cjs"];
        nextParams.testCwd = ".";
        nextParams.testTimeoutMs = 10 * 60 * 1000;
      }
      const result = await runOrchestratorNext(nextParams, {
        agents,
        inheritedModel,
        signal,
        onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
      });
      return {
        content: [{ type: "text", text: result.markdown }],
        details: result.details,
      };
    },
  });

  pi.registerCommand("orchestrate", {
    description: "Run or supervise deterministic orchestration. Forms: run|inspect|continue|accept|pause|cancel; accept requires --reason and --approval-token. Other flags: --action, --run-id, --supervision visible-main|off, --adaptive-supervision off|shadow-v1|enforce-canary-v1|adaptive-v1, --lane product|orchestrator-maintenance, --external-evidence-roots, --no-force-kill; legacy --resume remains distinct.",
    handler: async (args, ctx) => {
      let commandParams: Record<string, unknown>;
      try {
        commandParams = parseOrchestrateCommandArgs(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid /orchestrate arguments: ${message}`, "error");
        return;
      }

      const action = String(commandParams.action ?? "run") as SupervisionAction;
      const legacyResume = typeof commandParams.resume === "string" && Boolean(commandParams.resume);
      let task = String(commandParams.task ?? "").trim();
      if (action === "run" && !legacyResume && !task) {
        const entered = await ctx.ui.input("Task to orchestrate", "Describe the task...");
        task = entered?.trim() ?? "";
        if (task) commandParams.task = task;
      }
      if (action === "run" && !legacyResume && !task) {
        ctx.ui.notify("/orchestrate cancelled: no task provided.", "warning");
        return;
      }

      // Non-run lifecycle controls and legacy resume never prompt for a new
      // task. Their frozen task/routes are restored by the durable state.
      const dashboardTask = task || `${legacyResume ? "legacy resume" : action} ${String(commandParams.runId ?? commandParams.resume ?? "")}`.trim();
      const dashboardState = createOrchestrateDashboard(dashboardTask);
      try {
        if (action === "run" && !legacyResume) {
          const normalized = normalizeParams(commandParams, ctx.cwd ?? process.cwd());
          dashboardState.maxSubagents = normalized.maxSubagents;
          dashboardState.maxRetries = normalized.maxRetries;
          dashboardState.concurrency = normalized.concurrency;
          dashboardState.paradigm = inferOrchestrationParadigm(normalized);
          dashboardState.plannerModel = formatRoutedModel(normalized.plannerProvider, normalized.plannerModel);
          dashboardState.executorModel = formatRoutedModel(normalized.executorProvider, normalized.executorModel);
          dashboardState.verifierModel = formatRoutedModel(normalized.verifierProvider, normalized.verifierModel);
        } else {
          dashboardState.phase = legacyResume ? "resuming" : action;
          dashboardState.paradigm = legacyResume ? "stored legacy run" : "visible-main lifecycle";
        }
        ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState));
        ctx.ui.setStatus?.("orchestrate", dashboardStatusLine(dashboardState));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/orchestrate parameter error: ${message}`, "error");
        return;
      }

      // Compose with Pi's existing editor instead of replacing it. Raw-input
      // observation lets the first Escape keep its normal app.interrupt meaning;
      // only a later Escape during durable settlement is intercepted for an
      // explicit, risk-labelled abandonment confirmation.
      const abandonController = new AbortController();
      let settlementRefreshTimer: ReturnType<typeof setInterval> | undefined;
      const pauseInteraction = createSupervisedPauseInteraction({
        render: (snapshot) => {
          const footer = `⏸ ${snapshot.message}`;
          ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState, footer));
          ctx.ui.setStatus?.("orchestrate", `⏸ ${snapshot.phase} — settling ${(snapshot.elapsedMs / 1000).toFixed(1)}s`);
        },
        notify: (message) => ctx.ui.notify(message, "warning"),
        confirm: (title, message) => ctx.ui.confirm(title, message),
        abandon: (info) => abandonController.abort(new ConfirmedSupervisedAbandonError(info.phase)),
      });
      const settlementControl: SupervisedSettlementControl = {
        abandonSignal: abandonController.signal,
        onSettling: (info) => {
          pauseInteraction.acknowledge(info);
          if (!settlementRefreshTimer) {
            settlementRefreshTimer = setInterval(() => pauseInteraction.refresh(), 250);
            settlementRefreshTimer.unref?.();
          }
        },
      };
      const unsubscribeTerminalInput = ctx.ui.onTerminalInput?.((data) =>
        pauseInteraction.handleTerminalInput(data) ? { consume: true } : undefined,
      );

      // ── Run orchestration with live dashboard updates ────────────
      try {
        // Standard executor-bearing command PEV runs are supervised by default.
        // Non-run controls use the mode/lane frozen in durable state, while the
        // historical --resume path remains a separate compatibility API.
        if (action === "run" && !legacyResume) commandParams.supervision ??= "visible-main";
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
        }, ctx, settlementControl);

        const details = result.details as Record<string, unknown>;
        const presentation = commandOutcomePresentation(details);
        dashboardState.phase = presentation.phase;
        const icon = presentation.level === "info" ? "✅" : presentation.level === "error" ? "❌" : "⏸";
        ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState, `${icon} Orchestration ${presentation.label}`));
        ctx.ui.setStatus?.("orchestrate", `${icon} Orchestration: ${presentation.label}`);
        ctx.ui.notify(`Orchestration: ${presentation.label}`, presentation.level);
        pi.sendMessage({
          customType: "orchestrate-result",
          content: result.markdown,
          display: true,
          details,
        });
        if (ctx.hasUI && (details.status === "terminal" || details.status === "pass" || details.status === "fail")) {
          ctx.ui.setEditorText(result.markdown);
        }

        // Command-only wake-up: one fixed instruction with validated opaque
        // identifiers, queued after this handler yields. Tool calls never enter
        // this block because their caller already receives the checkpoint.
        const checkpoint = details.checkpoint as { id?: unknown; kind?: unknown } | undefined;
        const shouldWake = details.status === "awaiting_supervisor" &&
          (action === "run" || action === "continue") &&
          ["plan", "executor", "verifier"].includes(String(checkpoint?.kind ?? ""));
        const followup = shouldWake ? buildCommandCheckpointFollowup(details.runId, checkpoint?.id) : undefined;
        if (followup) {
          const key = `${String(details.runId)}:${String(checkpoint?.id)}`;
          if (!deliveredCommandCheckpoints.has(key)) {
            deliveredCommandCheckpoints.add(key);
            setTimeout(() => {
              try {
                pi.sendUserMessage(followup, { deliverAs: "followUp" });
              } catch {
                // The checkpoint/result is already durable and visible. A
                // session replacement between yield and delivery must not
                // crash the command or create a retry/feedback loop.
              }
            }, 0);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dashboardState.phase = "failed";
        ctx.ui.setWidget?.("orchestrate", buildDashboardLines(dashboardState, `❌ ${message}`));
        ctx.ui.setStatus?.("orchestrate", `❌ Orchestration failed: ${message}`);
        ctx.ui.notify(`Orchestration failed: ${message}`, "error");
        throw error;
      } finally {
        pauseInteraction.settled();
        if (settlementRefreshTimer) clearInterval(settlementRefreshTimer);
        unsubscribeTerminalInput?.();
        ctx.ui.setWidget?.("orchestrate", undefined);
        ctx.ui.setStatus?.("orchestrate", undefined);
      }
    },
  });

  // Register only a lazy public shell after both legacy tools. The optional
  // mission implementation is evaluated on first use, so an import/schema
  // failure cannot affect extension startup or legacy availability.
  try {
    pi.registerTool({
      name: "orchestrate_mission",
      label: "Durable Mission",
      description: "Run, resume, or inspect one durable single-agent coding mission with an exclusive workspace writer, exact Pi session/route recovery, fixed host validation, and fail-closed crash classification.",
      promptSnippet: "Run one long-horizon coding agent under durable crash recovery and fixed host validation.",
      promptGuidelines: [
        "Use orchestrate_mission only for an explicit durable single-agent coding mission; it is not a planner/executor/verifier workflow.",
        "For orchestrate_mission resume or inspect, pass only action and runId; all immutable inputs are restored from durable state.",
        "Treat pending and outcome-unknown as nonterminal. Inspect safeAction before deciding whether to wait, resume, or reconcile.",
      ],
      parameters: orchestrateMissionParamsSchema,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (process.env.PI_ORCHESTRATOR_TEST_FAIL_MISSION_MODULE === "1") {
          throw new Error("synthetic durable mission module load failure");
        }
        const { createDurableMissionToolDefinition } = await import("./mission/tool");
        const implementation = createDurableMissionToolDefinition(pi);
        return implementation.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    });
  } catch (error) {
    console.error(`[orchestrate_mission] registration disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function gitText(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return result.status === 0 ? String(result.stdout ?? "").trim() || null : null;
  } catch { return null; }
}

function compactSupervisionMarkdown(
  state: SupervisionRunState,
  snapshot: ReturnType<typeof buildInspectionSnapshot>,
  token?: string,
): string {
  const checkpoint = state.checkpoints[state.checkpoints.length - 1];
  const status = state.status === "terminal"
    ? `terminal ${String(state.terminalOutcome ?? "unknown").toUpperCase()}`
    : state.status.replace(/_/g, " ");
  const effects = snapshot.contentChanges?.length
    ? snapshot.contentChanges.slice(0, 12).map((change) => `${change.kind}:${change.path}`).join(", ")
    : "none";
  const lines = [
    `Supervised orchestration ${state.runId}: ${status}.`,
    formatCommandTimes(mergeCommandTimes(getCommandTimesForRun(state.runId), commandTimesFromHostResults(state))),
    `Mission: ${state.mission.missionHash} | lane=${state.lane} | paradigm=${state.mission.paradigm}`,
    `Worktree: ${state.mission.cwd} | branch=${state.mission.worktree.branch ?? "none"} | baseline=${state.mission.worktree.baseline ?? "none"}`,
    checkpoint
      ? `Checkpoint: ${checkpoint.id} | kind=${checkpoint.kind} | outcome=${checkpoint.outcome ?? "unknown"} | task=${checkpoint.taskId ?? "none"}`
      : "Checkpoint: none",
    `Checkpoint criteria: ${checkpoint?.criteria.join(", ") || "none"}`,
    `Content effects: ${effects}`,
    // Legacy compact-summary callers supply only criteria and actions.
    ...(snapshot.planSummary ? [
    `Saved plan: ${snapshot.savedArtifacts.plan ?? "genuinely missing"}`,
    `Planner-declared scope: ${snapshot.planSummary.declaredScope?.join(", ") || "not supplied (see saved plan)"}`,
    `Saved result: ${snapshot.savedArtifacts.result ?? "not started yet"}`,
    `Full details: ${snapshot.savedArtifacts.state}; checkpoint=${snapshot.savedArtifacts.checkpoint ?? "none"}`,
    `Approval: awaiting=${snapshot.checkpointState.awaitingApproval}; outstanding=${snapshot.checkpointState.approvalOutstanding}; fresh available=${snapshot.checkpointState.freshApprovalAvailable}. Request a fresh approval with continue without a token, then consume it.`,
    `Phase manifest: ${snapshot.liveStatus.manifestState}`,
    ...snapshot.planSummary.tasks.map(task => `Plan ${task.id}: ${task.description} | ACs: ${task.acceptanceCriteria.map(item => `${item.id}: ${item.text}`).join("; ") || "missing"} | scope: ${task.predictedWriteSet?.join(", ") || (task.expectsFileChange === false ? "read-only" : "missing")}`),
    ...(snapshot.planSummary.omittedTasks ? [`${snapshot.planSummary.omittedTasks} more tasks in saved plan.`] : []),
    ...(snapshot.settledResult ? [`Settled result: ${snapshot.settledResult.outcome ?? "unknown"}: ${snapshot.settledResult.text}${snapshot.settledResult.omitted ? " (full detail in saved result)" : ""}`] : []),
    ] : []),
    ...(state.pauseReason ? [`Reason: ${state.pauseReason}`] : []),
    `Criteria: completed=${snapshot.completedCriteria.join(", ") || "none"}; remaining=${snapshot.remainingCriteria.join(", ") || "none"}`,
    `Legal actions: ${snapshot.allowedNextActions.join(", ")}`,
  ];
  if (state.acceptance) lines.push(`Accepted reason: ${state.acceptance.reason}`);
  if (state.retirement) lines.push(`Retirement reason: ${state.retirement.reason}`);
  const pendingAmendment = checkpoint?.kind === "executor" && checkpoint.taskId
    ? [...snapshot.scopeAmendments].reverse().find((amendment) => amendment.taskId === checkpoint.taskId)
    : undefined;
  if (pendingAmendment) {
    lines.push(`Scope amendment: ${pendingAmendment.paths.join(", ")} were outside the frozen write set for ${pendingAmendment.taskId}; continue accepts them into scope, cancel rejects.`);
  }
  const legacyCompatibility = state.runtime?.kind === "generic-shape"
    ? state.runtime.adapterState?.legacyPevMigration as { mode?: unknown; executorRespawnAllowed?: unknown; reasons?: unknown } | undefined
    : undefined;
  if (legacyCompatibility) {
    const reasons = Array.isArray(legacyCompatibility.reasons) ? legacyCompatibility.reasons.map(String) : [];
    lines.push(
      `Legacy PEV compatibility: mode=${String(legacyCompatibility.mode ?? "unknown")} | executorRespawnAllowed=${legacyCompatibility.executorRespawnAllowed === true}.`,
    );
    if (reasons.length) lines.push(`Compatibility reasons: ${reasons.join("; ")}`);
  }
  if (state.status === "awaiting_supervisor" || state.status === "plan_checkpoint") {
    lines.push("awaiting_supervisor is not completion. Call read-only inspect, compare this checkpoint with the frozen mission, criteria, and effects, then choose continue, eligible accept with a reason, pause, or cancel.");
    lines.push("The visible agent coordinates only: do not implement product work directly and do not switch a product run into orchestrator maintenance.");
  } else if (state.status === "paused") {
    lines.push("Paused: no worker will spawn until a fresh visible-main approval is issued and consumed.");
  } else if (state.status === "blocked_infrastructure") {
    lines.push("Blocked infrastructure: product execution is stopped; inspect the infrastructure failure, then pause or cancel. Do not synthesize an orchestrator repair inside this product run.");
  } else if (state.status === "cancelled") {
    lines.push("Cancelled is irreversible; inspection remains read-only.");
  }
  if (token && snapshot.allowedNextActions.includes("continue")) {
    lines.push(`One-use continue: /orchestrate continue --run-id ${state.runId} --approval-token ${token}`);
  }
  return lines.join("\n");
}

function lifecycleResult(state: SupervisionRunState, token?: string, extra: Record<string, unknown> = {}) {
  const snapshot = buildInspectionSnapshot(state);
  const checkpoint = state.checkpoints[state.checkpoints.length - 1];
  const legacyCompatibility = state.runtime?.kind === "generic-shape"
    ? state.runtime.adapterState?.legacyPevMigration
    : undefined;
  return {
    markdown: compactSupervisionMarkdown(state, snapshot, token),
    details: {
      ...snapshot,
      commandTimes: mergeCommandTimes(getCommandTimesForRun(state.runId), commandTimesFromHostResults(state)),
      commandTimingSummary: summarizeCommandTimes(mergeCommandTimes(getCommandTimesForRun(state.runId), commandTimesFromHostResults(state))),
      lane: state.lane,
      terminalOutcome: state.terminalOutcome,
      pauseReason: state.pauseReason,
      acceptance: state.acceptance,
      checkpoint: checkpoint ? { id: checkpoint.id, kind: checkpoint.kind, taskId: checkpoint.taskId, outcome: checkpoint.outcome, criteria: checkpoint.criteria, effectChanges: checkpoint.effectChanges } : undefined,
      ...(legacyCompatibility ? { legacyCompatibility } : {}),
      ...(token ? { approvalToken: token } : {}),
      ...extra,
    },
  };
}

function lifecycleState(params: NormalizedParams, runId: string): OrchestrationState {
  return {
    attempt: 1, spawnedCount: 0, plan: null, planText: "", executorOutputs: [], verifierResult: null,
    failureReasons: [], finalResult: "", progressLog: [], intake: null, routingCheck: null, runId,
    gateWarnings: [], taskLedger: new Map(), commitEvidence: [], attempts: [], recoveryLog: [], recoveryDepth: 0, maxRecoveryDepth: 0,
  };
}

interface CurrentMissionBoundary {
  flags: ReturnType<typeof detectBoundaryDrift>;
  gitBaseline: string | null;
  contentSnapshot?: ContentSignatureSnapshot;
  contentChanges: ContentSignatureChange[];
}

function acceptedRuntimeGitBaseline(state: SupervisionRunState): string | null {
  const runtime = state.runtime;
  return runtime && Object.prototype.hasOwnProperty.call(runtime, "acceptedGitBaseline")
    ? runtime.acceptedGitBaseline ?? null
    : state.mission.worktree.baseline;
}

function currentMissionBoundary(state: SupervisionRunState): CurrentMissionBoundary {
  // A restored run owns its execution location. The visible coordinator may
  // live in another project, so observe every drift signal from the frozen
  // mission path rather than treating the tool-call context cwd as authority.
  const currentCwd = path.resolve(state.mission.cwd);
  const currentWorktreeRoot = gitText(currentCwd, ["rev-parse", "--show-toplevel"]) ?? currentCwd;
  let currentWorktreeRealRoot: string | null = null;
  try { currentWorktreeRealRoot = realpathSync.native(currentWorktreeRoot); } catch { /* reported as blocking identity drift below */ }
  const branch = gitText(currentCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitBaseline = gitText(currentCwd, ["rev-parse", "HEAD"]);
  let contentSnapshot: ContentSignatureSnapshot | undefined;
  let contentChanges: ContentSignatureChange[] = [];
  let contentInspectionError: unknown;
  if (state.runtime?.contentBaseline) {
    try {
      contentSnapshot = captureContentSignatureSnapshot(currentCwd);
      contentChanges = diffContentSignatureSnapshots(state.runtime.contentBaseline, contentSnapshot);
    } catch (error) {
      contentInspectionError = error;
    }
  }
  const acceptedBaseline = acceptedRuntimeGitBaseline(state);
  const lastEffectPaths = state.checkpoints[state.checkpoints.length - 1]?.effectChanges.map((change) => change.path) ?? [];
  const changedPaths = contentChanges.length ? contentChanges.map((change) => change.path) : lastEffectPaths;
  const flags = detectBoundaryDrift({
    mission: state.mission,
    currentMissionHash: state.mission.missionHash,
    currentCwd,
    currentWorktreeRoot,
    currentWorktreeRealRoot,
    currentBranch: branch,
    currentBaseline: gitBaseline,
    acceptedBaseline,
    baselineChangePaths: changedPaths,
    approvedTaskIds: state.approvedTaskIds,
    observedTaskIds: state.tasks.map((task) => task.id),
  });
  if (contentChanges.length) {
    flags.push({
      code: "content_baseline_changed",
      message: `Workspace byte baseline changed at ${contentChanges.length} path(s): ${contentChanges.slice(0, 10).map((change) => change.path).join(", ")}; visible supervisor continue acknowledges these external effects.`,
      blocking: false,
    });
  } else if (contentInspectionError) {
    flags.push({ code: "content_baseline_changed", message: `Accepted workspace content could not be inspected: ${contentInspectionError instanceof Error ? contentInspectionError.message : String(contentInspectionError)}.`, blocking: true });
  }
  return { flags, gitBaseline, contentSnapshot, contentChanges };
}

function currentMissionDrift(state: SupervisionRunState) {
  return currentMissionBoundary(state).flags;
}

function recordBaselineTransition(
  runtime: GenericSupervisionRuntime,
  transition: { source: "executor" | "supervisor"; from: string | null; to: string | null; paths: string[]; taskId?: string },
): void {
  const existing = Array.isArray(runtime.adapterState?.baselineTransitions)
    ? runtime.adapterState.baselineTransitions.filter((entry) => entry && typeof entry === "object").slice(-99)
    : [];
  runtime.adapterState = {
    ...(runtime.adapterState ?? {}),
    baselineTransitions: [...existing, {
      ...transition,
      paths: [...new Set(transition.paths)].slice(0, 100),
      at: new Date().toISOString(),
    }],
  };
}

function acknowledgeSupervisorBoundary(state: SupervisionRunState, boundary: CurrentMissionBoundary): void {
  const relevant = boundary.flags.some((flag) => flag.code === "baseline_changed" || flag.code === "content_baseline_changed");
  if (!relevant || !boundary.contentSnapshot) return;
  const runtime = requireGenericRuntime(state);
  const from = acceptedRuntimeGitBaseline(state);
  recordBaselineTransition(runtime, {
    source: "supervisor",
    from,
    to: boundary.gitBaseline,
    paths: boundary.contentChanges.map((change) => change.path),
  });
  runtime.acceptedGitBaseline = boundary.gitBaseline;
  runtime.contentBaseline = boundary.contentSnapshot;
}

function executorOwnsCommit(task: CriterionTask, originalTask: string, outputText: string, before: string | null, after: string | null, cwd: string): boolean {
  const taskText = `${task.description}\n${originalTask}`;
  if (/\b(?:do not|don't|never|must not|without|no)\s+(?:create|make|produce|write\s+)?(?:a\s+)?commit\b/i.test(taskText)) return false;
  if (!/\b(?:commit|commits|committed|committing)\b/i.test(taskText) || !/\b(?:commit|committed|sha)\b/i.test(outputText)) return false;
  if (!before || !after) return false;
  try {
    const ancestry = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", before, after], { timeout: 5000, windowsHide: true });
    return ancestry.status === 0;
  } catch {
    return false;
  }
}

function issueCheckpointApproval(store: SupervisionStateStore, state: SupervisionRunState): { state: SupervisionRunState; token: string } {
  const checkpoint = state.checkpoints[state.checkpoints.length - 1];
  if (!checkpoint) throw new Error("Cannot approve a run without a durable checkpoint.");
  const issued = issueApprovalToken({ runId: state.runId, missionHash: state.mission.missionHash, checkpointId: checkpoint.id, action: "continue" });
  const next = { ...state, currentApproval: issued.record };
  store.save(next);
  return { state: next, token: issued.token };
}

interface VisibleMainDispatchContext {
  identity: GenericSupervisionRuntime["identity"];
  resumeState?: LoadedRunState;
  resolvedDynamicWorkflow?: ResolvedDynamicWorkflow;
}

type BoundGenericSupervisionRuntime = Omit<GenericSupervisionRuntime, "intake" | "executorOutputs"> & {
  intake: Intake;
  executorOutputs: ExecutorOutput[];
};

function requireGenericRuntime(state: SupervisionRunState): BoundGenericSupervisionRuntime {
  if (state.runtime?.kind !== "generic-shape") {
    throw new Error("Supervised run is missing its generic mission-bound runtime payload.");
  }
  return state.runtime as BoundGenericSupervisionRuntime;
}

/** Persist the same immutable adapter identity/cursor into a historical state.json when one exists. */
function syncHistoricalSupervisionBinding(state: SupervisionRunState): void {
  const runtime = state.runtime?.kind === "generic-shape" ? state.runtime : undefined;
  if (!runtime) return;
  const historicalRunId = typeof runtime.adapterState?.historicalRunId === "string"
    ? runtime.adapterState.historicalRunId
    : state.runId;
  try {
    const historical = RunStateStore.open(historicalRunId);
    historical.bindSupervision({
      schemaVersion: 1,
      mode: "visible-main",
      classification: String(runtime.adapterState?.classification ?? "executor-bearing") as "executor-bearing" | "mutating",
      identity: runtime.identity,
      cursor: runtime.cursor,
    });
  } catch (error) {
    if (!/Resume state not found/.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}

function updateGenericCursor(
  state: SupervisionRunState,
  patch: Partial<Pick<GenericSupervisionRuntime["cursor"], "stage" | "nextTaskIndex" | "completedTaskIds" | "currentTaskId" | "lastCheckpointId">>,
): GenericSupervisionRuntime {
  const runtime = requireGenericRuntime(state);
  runtime.cursor = createGenericSupervisionCursor(runtime.identity, {
    stage: patch.stage ?? runtime.cursor.stage,
    nextTaskIndex: patch.nextTaskIndex ?? runtime.cursor.nextTaskIndex,
    completedTaskIds: patch.completedTaskIds ?? runtime.cursor.completedTaskIds,
    currentTaskId: Object.prototype.hasOwnProperty.call(patch, "currentTaskId") ? patch.currentTaskId : runtime.cursor.currentTaskId,
    lastCheckpointId: patch.lastCheckpointId ?? runtime.cursor.lastCheckpointId,
  });
  runtime.completedTaskIds = [...runtime.cursor.completedTaskIds];
  syncHistoricalSupervisionBinding(state);
  return runtime;
}

interface DynamicSupervisionTaskBinding {
  taskId: string;
  iteration: number;
  phaseId: string;
}

interface SupervisedTaskEffectContract {
  requiresContentProgress: boolean;
  source: "repair" | "dynamic-phase" | "planned-task" | "planned-task-declared";
}

const SUPERVISED_MUTATION_VERB =
  String.raw`(?:create|implement|build|modify|add|write|generate|edit|change|fix|patch|update|delete|remove|refactor|migrate|install|code|correct|apply|materialize|persist|save|replace|rename)`;
const SUPERVISED_IMPERATIVE_MUTATION = new RegExp(
  String.raw`(?:^|[.!?;]\s+|\b(?:and|then|must|shall|should|will|please|required\s+to|promises?\s+to|needs?\s+to)\s+)${SUPERVISED_MUTATION_VERB}\b`,
  "i",
);
const SUPERVISED_ANALYSIS_CONTRACT = /\b(?:analysis[- ]only|read[- ]only|non[- ]mutating|audit|verify|validate|inspect|review|analy[sz]e|assess|research|map|plan|design|critique|synthesi[sz]e|report)\b/i;
const SUPERVISED_NO_MUTATION_CONTRACT =
  /\b(?:do not|don't|must not|never)\s+(?:\w+[ -]?){0,3}(?:edit|modify|mutate|write|change)\b|\bwithout\s+(?:repository |file |content |product )?(?:edits?|modification|mutation|changes?)\b/i;
const SUPERVISED_CONDITIONAL_CORRECTION =
  /\b(?:if|when)\s+(?:it\s+is\s+)?(?:necessary|needed|required|incorrect|invalid|broken|failing|a\s+(?:defect|problem)\s+is\s+found|issues?\s+are\s+found)\b/i;

function hasImperativeMutationPromise(contract: string): boolean {
  return SUPERVISED_IMPERATIVE_MUTATION.test(contract);
}

function isConditionalNoOpContract(contract: string): boolean {
  return SUPERVISED_ANALYSIS_CONTRACT.test(contract) && SUPERVISED_CONDITIONAL_CORRECTION.test(contract);
}

/**
 * Widen the durable write set with paths a settled task touched inside the
 * worktree but outside the planner's prediction, and record the amendment in
 * the audit so inspection surfaces it. Persisted with the run state by the
 * caller's store.save.
 */
function applyScopeAmendment(
  state: SupervisionRunState,
  runtime: GenericSupervisionRuntime,
  taskId: string,
  rawPaths: string[],
): ScopeAmendment {
  const paths = [...new Set(rawPaths.map(normalizeWriteSetEntry).filter(Boolean))].sort();
  const widen = (existing: string[] | undefined): string[] => [...new Set([...(existing ?? []), ...paths])];
  runtime.plan.predictedWriteSet = widen(runtime.plan.predictedWriteSet);
  for (const task of runtime.plan.tasks) if (task.predictedWriteSet) task.predictedWriteSet = widen(task.predictedWriteSet);
  for (const task of state.tasks) if (task.predictedWriteSet) task.predictedWriteSet = widen(task.predictedWriteSet);
  const amendment: ScopeAmendment = { taskId, paths, at: new Date().toISOString() };
  state.audit.scopeAmendments = [...(state.audit.scopeAmendments ?? []), amendment];
  return amendment;
}

/**
 * Byte-level progress is mandatory only when the planner explicitly declares
 * expectsFileChange=true. Description heuristics may help choose a default
 * declaration, but they never become a hidden hard gate at settlement time.
 */
function supervisedTaskEffectContract(
  _runtime: GenericSupervisionRuntime,
  _paradigm: string,
  task: Pick<CriterionTask, "id" | "description" | "expectsFileChange">,
): SupervisedTaskEffectContract {
  return {
    requiresContentProgress: task.expectsFileChange === true,
    source: task.expectsFileChange === undefined ? "planned-task" : "planned-task-declared",
  };
}

/** Zero effects are valid only when a settled worker returned a non-failing grounded result. */
function hasSuccessfulGroundedSupervisedOutput(output: ExecutorOutput): boolean {
  if (output.exitCode !== 0 || !output.output.trim()) return false;
  const text = output.output.trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const verdict = [record.status, record.overall, record.verdict, record.result]
        .find((value) => typeof value === "string");
      if (typeof verdict === "string" && /^(?:fail|failed|error|inconclusive|unknown)$/i.test(verdict.trim())) return false;
    }
  } catch {
    // Grounded analysis may be prose; only explicit top-level failure markers
    // are rejected below. Final criterion verification remains authoritative.
  }
  return !/^(?:FINAL[_ ]VERDICT|STATUS|OVERALL|RESULT)\s*[:=-]\s*(?:FAIL|FAILED|ERROR|INCONCLUSIVE|UNKNOWN)\b/im.test(text);
}

function buildDeterministicSupervisionPlan(
  dispatch: VisibleMainDispatchContext,
  originalTask: string,
  criteria: AcceptanceCriterion[],
  scope: string[] | undefined,
): { tasks: CriterionTask[]; notes: string; adapterState: Record<string, unknown>; completedTaskIds: string[] } | undefined {
  if (dispatch.resolvedDynamicWorkflow) {
    const workflow = dispatch.resolvedDynamicWorkflow.workflow;
    const bindings: DynamicSupervisionTaskBinding[] = [];
    const tasks: CriterionTask[] = [];
    for (let iteration = 1; iteration <= workflow.maxIterations; iteration += 1) {
      for (const phase of workflow.phases) {
        const taskId = `dynamic-${iteration}-${phase.id}`;
        const dependencyIds = phase.dependsOn.map((dependency) => `dynamic-${iteration}-${dependency}`);
        if (iteration > 1) dependencyIds.push(`dynamic-${iteration - 1}-${workflow.phases[workflow.phases.length - 1].id}`);
        bindings.push({ taskId, iteration, phaseId: phase.id });
        const phaseContract = `${phase.prompt}\n${phase.expectedOutput}`;
        const phaseExpectation = hasImperativeMutationPromise(phaseContract)
          ? true
          : inferDefaultExpectsFileChange(phaseContract);
        tasks.push({
          id: taskId,
          description: [
            `Execute declarative workflow ${workflow.name}, iteration ${iteration}/${workflow.maxIterations}, phase ${phase.id} (role ${phase.role}).`,
            `Original task: ${originalTask}`,
            `Phase instructions: ${phase.prompt}`,
            phase.expectedOutput ? `Expected output: ${phase.expectedOutput}` : "",
          ].filter(Boolean).join("\n"),
          dependsOn: [...new Set(dependencyIds)],
          criteria: [criteria[(tasks.length) % criteria.length].id],
          predictedWriteSet: scope,
          ...(phaseExpectation === undefined ? {} : { expectsFileChange: phaseExpectation }),
        });
      }
    }
    for (let index = 0; index < criteria.length; index += 1) {
      if (!tasks.some((task) => task.criteria.includes(criteria[index].id))) tasks[index % tasks.length].criteria.push(criteria[index].id);
    }
    return {
      tasks,
      notes: `Host-derived deterministic plan for declarative workflow ${workflow.name}.`,
      completedTaskIds: [],
      adapterState: {
        classification: "executor-bearing",
        dynamicWorkflow: JSON.parse(JSON.stringify(dispatch.resolvedDynamicWorkflow.provenance)),
        dynamicTaskBindings: bindings,
      },
    };
  }

  const historical = dispatch.resumeState;
  if (historical?.state.phases.length) {
    const tasks = historical.state.phases.map((phase, index) => ({
      id: `historical-${phase.index}`,
      description: `Resume historical ${historical.state.paradigm} phase ${phase.name} for the frozen task.`,
      dependsOn: index === 0 ? [] : [`historical-${historical.state.phases[index - 1].index}`],
      criteria: [criteria[index % criteria.length].id],
      predictedWriteSet: scope,
    }));
    for (let index = 0; index < criteria.length; index += 1) {
      if (!tasks.some((task) => task.criteria.includes(criteria[index].id))) tasks[index % tasks.length].criteria.push(criteria[index].id);
    }
    const completedTaskIds: string[] = [];
    for (const phase of historical.state.phases) {
      if (phase.status !== "done") break;
      completedTaskIds.push(`historical-${phase.index}`);
    }
    return {
      tasks,
      notes: `Host-derived recovery plan pinned to historical run ${historical.state.runId}.`,
      completedTaskIds,
      adapterState: {
        classification: shapeRegistry.get(historical.state.paradigm)?.execution?.classification ?? "executor-bearing",
        historicalRunId: historical.state.runId,
        historicalPhases: historical.state.phases,
        ...(historical.state.dynamicWorkflow ? { dynamicWorkflow: historical.state.dynamicWorkflow } : {}),
      },
    };
  }
  return undefined;
}

function observedRouteFromResult(
  role: "planner" | "executor" | "verifier",
  result: Pick<SubagentResult, "agentName" | "provider" | "model">,
): ObservedMissionRoute | undefined {
  if (!result.provider || !result.model) return undefined;
  return {
    role,
    agentName: result.agentName,
    provider: result.provider,
    model: result.model,
    source: "launcher",
  };
}

function routeObservations(runtime: GenericSupervisionRuntime): ObservedMissionRoute[] {
  const value = runtime.adapterState?.routeObservations;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ObservedMissionRoute =>
    Boolean(item) && typeof item === "object" &&
    typeof (item as ObservedMissionRoute).role === "string" &&
    typeof (item as ObservedMissionRoute).agentName === "string" &&
    typeof (item as ObservedMissionRoute).provider === "string" &&
    typeof (item as ObservedMissionRoute).model === "string" &&
    (item as ObservedMissionRoute).source === "launcher");
}

function appendRouteObservations(
  runtime: GenericSupervisionRuntime,
  additions: Array<ObservedMissionRoute | undefined>,
): ObservedMissionRoute[] {
  const merged = [...routeObservations(runtime)];
  for (const addition of additions) {
    if (!addition) continue;
    if (!merged.some((item) => item.role === addition.role && item.agentName === addition.agentName && item.provider === addition.provider && item.model === addition.model)) {
      merged.push(addition);
    }
  }
  runtime.adapterState = { ...(runtime.adapterState ?? {}), routeObservations: merged };
  return merged;
}

const VERIFIER_WORKSPACE_EXHAUSTIVE_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * Tool-owned verifier caches are allowed to change while commands run. Keep
 * this list deliberately path-specific: the enclosing ignored directories
 * remain fully snapshotted, and every other file beneath them remains subject
 * to the hard mutation fence.
 */
const VERIFIER_TOOL_CACHE_PREFIXES = [
  "node_modules/.vite/",
] as const;

type VerifierWorkspacePathClassification = "tool-cache" | "host-runtime" | "enforced";

function normalizedVerifierPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function isVerifierToolCachePath(file: string): boolean {
  const normalized = normalizedVerifierPath(file);
  return VERIFIER_TOOL_CACHE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Host-runtime attribution requires a batch-local, observed publication chain.
 * A matching filename or configured run directory alone grants no exemption.
 */
function createVerifierWorkspacePathClassifier(
  workspaceRoot: string,
  hostRunsRoot: string,
  admittedHostPaths: Set<string> = new Set(),
): (file: string) => VerifierWorkspacePathClassification {
  const relativeRunsRoot = path.relative(path.resolve(workspaceRoot), path.resolve(hostRunsRoot));
  const runsPrefix = relativeRunsRoot
    && !path.isAbsolute(relativeRunsRoot)
    && relativeRunsRoot !== ".."
    && !relativeRunsRoot.startsWith(`..${path.sep}`)
      ? `${normalizedVerifierPath(relativeRunsRoot).replace(/\/$/, "")}/`
      : undefined;

  const admitted = new Set([...admittedHostPaths].map(normalizedVerifierPath));
  return (file: string): VerifierWorkspacePathClassification => {
    if (path.isAbsolute(file) || file.replaceAll("\\", "/").split("/").includes("..")) return "enforced";
    if (isVerifierToolCachePath(file)) return "tool-cache";
    if (!runsPrefix) return "enforced";
    const normalized = normalizedVerifierPath(file);
    if (!normalized.startsWith(runsPrefix)) return "enforced";
    return admitted.has(normalized) ? "host-runtime" : "enforced";
  };
}

/**
 * Verifier read-only enforcement must not inherit the ordinary write-set
 * snapshot exclusions or practical truncation defaults. Those defaults are
 * useful for advisory executor accounting, but would let a verifier hide a
 * mutation in (for example) node_modules or beyond the first 2,000 files.
 * MAX_SAFE_INTEGER remains a deterministic numeric bound while making every
 * physically representable workspace file part of the verifier snapshot.
 */
function captureVerifierWorkspaceSnapshot(root: string): ContentSignatureSnapshot {
  return captureContentSignatureSnapshot(root, {
    maxFiles: VERIFIER_WORKSPACE_EXHAUSTIVE_BOUND,
    maxTotalBytes: VERIFIER_WORKSPACE_EXHAUSTIVE_BOUND,
    maxFileBytes: VERIFIER_WORKSPACE_EXHAUSTIVE_BOUND,
    excludeDirectories: [],
  });
}

function verifierWorkspaceContentHash(snapshot: ContentSignatureSnapshot): string {
  const files = Object.entries(snapshot.files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, signature]) => [file, signature.size, signature.sha256]);
  return createHash("sha256").update(JSON.stringify({
    root: snapshot.root,
    files,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    truncated: snapshot.truncated,
    omitted: snapshot.omitted,
    limits: snapshot.limits,
  })).digest("hex");
}

/** Hash the exhaustive manifest after removing only explicitly advisory paths. */
function verifierWorkspaceProtectedContentHash(
  snapshot: ContentSignatureSnapshot,
  classifyPath: (file: string) => VerifierWorkspacePathClassification,
): string {
  const files = Object.entries(snapshot.files)
    .filter(([file]) => classifyPath(file) === "enforced")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, signature]) => [file, signature.size, signature.sha256] as const);
  return createHash("sha256").update(JSON.stringify({
    root: snapshot.root,
    files,
    fileCount: files.length,
    totalBytes: files.reduce((total, [, size]) => total + size, 0),
    truncated: snapshot.truncated,
    omitted: snapshot.omitted,
    limits: snapshot.limits,
  })).digest("hex");
}

function verifierWorkspaceSnapshotSummary(snapshot: ContentSignatureSnapshot) {
  return {
    root: snapshot.root,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    truncated: snapshot.truncated,
    omitted: snapshot.omitted,
    limits: snapshot.limits,
  };
}

function commandUnavailableError(message: string): Error & { code: "command_unavailable"; info: Record<string, unknown> } {
  return Object.assign(new Error(message), {
    code: "command_unavailable" as const,
    info: {
      code: "command_unavailable",
      retryAllowed: true,
      retryEligible: true,
      retryAttempted: false,
      mutationAmbiguous: false,
    },
  });
}

function executorOutputFromSupervisedResult(task: PlanTask, result: SubagentResult): ExecutorOutput {
  return {
    taskId: task.id,
    description: task.description,
    agentName: result.agentName,
    output: result.text,
    stderr: result.stderr || undefined,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    toolCalls: result.toolCalls,
    actionEvidence: result.actionEvidence,
    commandTimes: result.commandTimes,
    provider: result.provider,
    model: result.model,
  };
}

function adaptiveMissionFromVisibleMain(
  mission: SupervisionRunState["mission"],
  predictedWriteSet: string[] | undefined,
): FrozenMissionContract {
  const contract: MissionContract = {
    missionId: mission.missionHash,
    requiredOutcomes: [mission.originalTask],
    acceptanceCriteria: mission.acceptanceCriteria.map((criterion) => criterion.text),
    strategicInvariants: [
      `host-mission-hash:${mission.missionHash}`,
      `run-paradigm:${mission.paradigm}`,
      ...mission.constraints,
    ],
    nonGoals: [...mission.nonGoals],
    safetyEnvelope: {
      allowedOperations: ["inspect", "bounded-product-work", "test"],
      forbiddenOperations: ["destructive", "scope-expansion", "acceptance-weakening"],
    },
    protectedPathsAndPermissions: {
      protectedPaths: [],
      allowedMutationPaths: [...(predictedWriteSet ?? [])],
      grantedPermissions: ["workspace-read", ...(predictedWriteSet?.length ? ["bounded-write"] : [])],
    },
    resourceBudget: {
      maxTotalAttempts: 3,
      maxAttemptsPerStrategy: 2,
      maxStrategies: 2,
      maxResourceUnits: 3,
    },
    finalEnvironmentRequirements: [`frozen-worktree:${mission.worktree.realRoot}`],
  };
  return createFrozenMissionContract(contract);
}

function adaptiveCanaryGaps(includeShadowEvidence = false): Gap[] {
  return [
    {
      gapId: "G0",
      requirement: "The frozen mission identity and safety boundary remain intact.",
      status: "closed",
      admissibleEvidence: ["mission-invariant-snapshot"],
      evidenceRefs: ["initial-frozen-mission"],
    },
    {
      gapId: "G1",
      requirement: "Every strict frozen product acceptance criterion passes.",
      status: "open",
      admissibleEvidence: ["strict-product-acceptance", ...(includeShadowEvidence ? ["shadow-semantic-evidence"] : [])],
      evidenceRefs: [],
    },
  ];
}

function hostClassifyAdaptiveMaterial(strategy: CurrentStrategy): StrategyMaterialProfile {
  const operations = [...strategy.operations].map((item) => item.trim().toLowerCase()).sort();
  const mutationPaths = [...strategy.mutationPaths].map((item) => item.replace(/\\/g, "/").toLowerCase()).sort();
  return {
    mechanism: `operations:${operations.join("+") || "none"}`,
    route: mutationPaths.length ? "bounded-worktree-mutation" : "non-mutating-routed-output",
    taskScope: `gaps:${[...strategy.whichGapIds].sort().join("+")}`,
  };
}

function adaptiveStrategyA(): CurrentStrategy {
  const strategy: CurrentStrategy = {
    strategyId: "strategy-a-routed-probe",
    strategyFamily: "family-a-equivalent-no-information",
    whichGapIds: ["G1"],
    currentBeliefOrHypothesis: "Repeating the same routed inspection may reveal acceptance evidence.",
    method: "Run the same bounded non-mutating routed inspection twice.",
    materialProfile: {},
    expectedEvidence: ["strict-product-acceptance"],
    abandonmentCondition: "Two equivalent failures with no new evidence exhaust family A.",
    attemptsUsed: 0,
    resourceBudget: { maxAttempts: 2, resourceUnits: 2, resourceUnitsPerAttempt: 1 },
    operations: ["inspect"],
    requiredPermissions: ["workspace-read"],
    mutationPaths: [],
  };
  strategy.materialProfile = hostClassifyAdaptiveMaterial(strategy);
  return strategy;
}

function adaptiveProductionGapId(criterionId: string): string {
  return `G-${criterionId}`;
}

function adaptiveProductionGaps(state: SupervisionRunState): Gap[] {
  return state.mission.acceptanceCriteria.map((criterion) => ({
    gapId: adaptiveProductionGapId(criterion.id),
    requirement: criterion.text,
    status: "open" as const,
    admissibleEvidence: ["executor-progress", "criterion-verification"],
    evidenceRefs: [],
  }));
}

function adaptiveMaterialCategory(text: string, patterns: Array<[string, RegExp]>): string | undefined {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label).sort().join("+") || undefined;
}

/** Host-owned coarse semantic classifier. Model-supplied profile ids are ignored. */
function hostClassifyAdaptiveProductionMaterial(strategy: CurrentStrategy): StrategyMaterialProfile {
  const text = `${strategy.currentBeliefOrHypothesis}\n${strategy.method}`.toLowerCase();
  const base = hostClassifyAdaptiveMaterial(strategy);
  const environment = adaptiveMaterialCategory(text, [
    ["browser-ui", /\b(?:browser|renderer|playwright|visible ui|harness)\b/],
    ["electron-main", /\b(?:electron|preload|main process|ipc)\b/],
    ["owner-profile", /\b(?:owner profile|real profile|cold reopen|workspace restore)\b/],
    ["native-audio", /\b(?:native|cmajor|premix|wasapi|winmm|audio)\b/],
    ["isolated-fixture", /\b(?:fixture|temporary profile|isolated|synthetic)\b/],
  ]);
  const instrumentation = adaptiveMaterialCategory(text, [
    ["process-trace", /\b(?:process trace|pid|lifecycle|cleanup|job object)\b/],
    ["audio-metrics", /\b(?:rms|spectr|fundamental|period|modulation rate|premix)\b/],
    ["identity-diff", /\b(?:identity|digest|hash|revision|lineage)\b/],
    ["ui-observation", /\b(?:screenshot|visible|playwright|dom|cdp)\b/],
    ["source-test", /\b(?:unit test|integration test|source inspection|compile|typecheck)\b/],
  ]);
  const mechanism = adaptiveMaterialCategory(text, [
    ["observe-only", /\b(?:inspect|observe|validate|verify|audit)\b/],
    ["product-repair", /\b(?:repair|fix|patch|modify|implement|replace)\b/],
    ["dedicated-harness", /\b(?:dedicated|acceptance tool|recovery tool|test harness)\b/],
    ["ordinary-ui-edit", /\b(?:visible edit|ordinary typed|click|drag|control)\b/],
    ["cold-reopen", /\b(?:cold reopen|restart|relaunch)\b/],
  ]);
  return {
    ...base,
    ...(environment ? { environment } : {}),
    ...(instrumentation ? { instrumentation } : {}),
    ...(mechanism ? { mechanism: `${base.mechanism ?? "operations:none"}|${mechanism}` } : {}),
  };
}

function adaptiveProductionStrategy(
  state: SupervisionRunState,
  runtime: GenericSupervisionRuntime,
  task: CriterionTask,
): CurrentStrategy {
  const targetCriteria = task.criteria.length ? task.criteria : state.mission.acceptanceCriteria.map((criterion) => criterion.id);
  const mutationPaths = [...(task.predictedWriteSet ?? runtime.plan.predictedWriteSet ?? [])];
  const effectContract = supervisedTaskEffectContract(runtime, state.mission.paradigm, task);
  const operations = effectContract.requiresContentProgress
    ? ["bounded-product-work", "test"]
    : ["inspect", "test"];
  const seed = canonicalAdaptiveValue({
    description: task.description.replace(/\s+/g, " ").trim().toLowerCase(),
    targetCriteria: [...targetCriteria].sort(),
    mutationPaths: [...mutationPaths].sort(),
    operations,
    executor: state.mission.routes.find((route) => route.role === "executor"),
  });
  const family = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
  const strategy: CurrentStrategy = {
    strategyId: `strategy-a-${task.id}-${family}`,
    strategyFamily: `plan-family-${family}`,
    whichGapIds: targetCriteria.map(adaptiveProductionGapId),
    currentBeliefOrHypothesis: `The approved plan task can produce admissible evidence for ${targetCriteria.join(", ")}.`,
    method: task.description,
    materialProfile: {},
    expectedEvidence: ["executor-progress"],
    abandonmentCondition: "Abandon after the second equivalent host-classified failure without new semantic evidence.",
    attemptsUsed: 0,
    resourceBudget: { maxAttempts: 2, resourceUnits: 2, resourceUnitsPerAttempt: 1 },
    operations,
    requiredPermissions: ["workspace-read", ...(mutationPaths.length ? ["bounded-write"] : [])],
    mutationPaths,
  };
  strategy.materialProfile = hostClassifyAdaptiveProductionMaterial(strategy);
  return strategy;
}

function initializeAdaptiveShadow(
  state: SupervisionRunState,
  runtime: GenericSupervisionRuntime,
): void {
  const journal = new AdaptiveShadowJournal(path.join(new SupervisionStateStore(state.runId).runDir, "adaptive-shadow-v1.jsonl"));
  runtime.adapterState = {
    ...(runtime.adapterState ?? {}),
    adaptiveSupervision: {
      mode: "shadow-v1",
      controlledExecution: false,
      journalFile: journal.file,
      records: journal.readAll().length,
      mission: adaptiveMissionFromVisibleMain(state.mission, runtime.plan.predictedWriteSet),
      gaps: adaptiveProductionGaps(state),
      observations: [],
      attemptsUsed: 0,
    },
  };
}

function appendActualAdaptiveShadow(
  state: SupervisionRunState,
  runtime: GenericSupervisionRuntime,
  task: CriterionTask,
  output: ExecutorOutput,
  changes: ContentSignatureChange[],
): void {
  const metadata = runtime.adapterState?.adaptiveSupervision as Record<string, unknown> | undefined;
  if (metadata?.mode !== "shadow-v1" || metadata.controlledExecution !== false) return;
  const mission = metadata.mission as FrozenMissionContract;
  const beforeGaps = structuredClone(metadata.gaps as Gap[]);
  const observations = structuredClone((metadata.observations ?? []) as FailureObservation[]);
  const strategy = adaptiveProductionStrategy(state, runtime, task);
  const effectContract = supervisedTaskEffectContract(runtime, state.mission.paradigm, task);
  const grounded = hasSuccessfulGroundedSupervisedOutput(output);
  const successful = grounded && (!effectContract.requiresContentProgress || changes.length > 0);
  let afterGaps = structuredClone(beforeGaps);
  const evidence = successful
    ? strategy.whichGapIds.map((gapId) => ({
        evidenceRef: `${state.runId}:shadow:${task.id}:${gapId}:${Number(metadata.attemptsUsed ?? 0) + 1}`,
        evidenceKind: "executor-progress",
        gapId,
        effect: "strengthen" as const,
        acceptanceEligible: false,
      }))
    : [];
  for (const item of evidence) afterGaps = applyGapEvidence(afterGaps, item);
  const signature = successful ? undefined : adaptiveProductionFailureSignature(output, effectContract.requiresContentProgress, changes.length);
  const currentFailure: FailureObservation | undefined = signature
    ? {
        strategyId: strategy.strategyId,
        strategyFamily: strategy.strategyFamily,
        normalizedFailureSignature: signature,
        newEvidenceFlag: !observations.some((observation) =>
          observation.strategyFamily === strategy.strategyFamily && observation.normalizedFailureSignature === signature),
        evidenceRefs: [],
      }
    : undefined;
  const nextObservations = currentFailure ? [...observations, currentFailure] : observations;
  const attempt = Number(metadata.attemptsUsed ?? 0) + 1;
  const journal = new AdaptiveShadowJournal(String(metadata.journalFile));
  journal.append(createAdaptiveShadowObservation({
    recordId: `actual-${task.id}-${attempt}`,
    runId: state.runId,
    workflowId: "generic-visible-main-pev",
    mission,
    beforeGaps,
    afterGaps,
    evidence,
    currentStrategy: strategy,
    observations: nextObservations,
    ...(currentFailure ? { currentFailure } : {}),
    resourceUsage: { attemptsUsed: attempt, strategiesUsed: 1, resourceUnitsUsed: attempt },
    currentBehavior: successful
      ? { action: "SETTLE_TASK_AND_AWAIT_VISIBLE_MAIN", reason: "Ordinary visible-main remains authoritative; shadow evidence did not control dispatch." }
      : { action: "REFUSE_OR_CHECKPOINT_FAILURE", reason: "Ordinary visible-main no-progress and failure policy remains authoritative." },
  }));
  runtime.adapterState = {
    ...(runtime.adapterState ?? {}),
    adaptiveSupervision: {
      ...metadata,
      controlledExecution: false,
      records: journal.readAll().length,
      gaps: afterGaps,
      observations: nextObservations,
      attemptsUsed: attempt,
    },
  };
}

function adaptiveJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}_OUTPUT_INVALID_JSON`);
  }
  return parsed as Record<string, unknown>;
}

function parseAdaptiveStrategyProposal(text: string): StrategyProposal {
  const raw = adaptiveJsonObject(text, "ADAPTIVE_CANARY_MODEL_B");
  const candidate = raw.proposal && typeof raw.proposal === "object" && !Array.isArray(raw.proposal)
    ? raw.proposal as Record<string, unknown>
    : raw;
  if (!candidate.strategy || typeof candidate.strategy !== "object" || Array.isArray(candidate.strategy)) {
    throw new Error("ADAPTIVE_CANARY_MODEL_B_PROPOSAL_MISSING");
  }
  return candidate as unknown as StrategyProposal;
}

interface AdaptiveProductionProposalParseFailure {
  code:
    | "ADAPTIVE_PRODUCTION_PLANNER_OUTPUT_EMPTY"
    | "ADAPTIVE_PRODUCTION_PLANNER_OUTPUT_MALFORMED"
    | "ADAPTIVE_PRODUCTION_PLANNER_PROPOSAL_SCHEMA_INCOMPLETE"
    | "ADAPTIVE_PRODUCTION_PLANNER_PROPOSAL_AMBIGUOUS";
  message: string;
}

type AdaptiveProductionProposalParseResult =
  | { ok: true; proposal: StrategyProposal }
  | { ok: false; failure: AdaptiveProductionProposalParseFailure };

function adaptiveProductionProposalHasCompleteSchema(value: unknown): value is StrategyProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Record<string, unknown>;
  const strategy = proposal.strategy;
  if (typeof proposal.preservedMissionHash !== "string" || !strategy || typeof strategy !== "object" || Array.isArray(strategy)) return false;
  const candidate = strategy as Record<string, unknown>;
  const stringFields = ["strategyId", "strategyFamily", "currentBeliefOrHypothesis", "method", "abandonmentCondition"];
  const arrayFields = ["whichGapIds", "expectedEvidence", "operations", "requiredPermissions", "mutationPaths"];
  const budget = candidate.resourceBudget;
  return stringFields.every((key) => typeof candidate[key] === "string") &&
    arrayFields.every((key) => Array.isArray(candidate[key]) && (candidate[key] as unknown[]).every((item) => typeof item === "string")) &&
    candidate.materialProfile !== null && typeof candidate.materialProfile === "object" && !Array.isArray(candidate.materialProfile) &&
    Number.isSafeInteger(candidate.attemptsUsed) &&
    Boolean(budget && typeof budget === "object" && !Array.isArray(budget) &&
      Number.isSafeInteger((budget as Record<string, unknown>).maxAttempts) &&
      Number.isSafeInteger((budget as Record<string, unknown>).resourceUnits) &&
      Number.isSafeInteger((budget as Record<string, unknown>).resourceUnitsPerAttempt));
}

function extractAdaptiveProductionJsonObjects(text: string): unknown[] {
  const sources = [text.trim(), ...extractFenceContents(text)];
  const jsonTexts = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    jsonTexts.add(source);
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escape) escape = false;
        else if (character === "\\") escape = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") {
        if (depth === 0) start = index;
        depth += 1;
      } else if (character === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          jsonTexts.add(source.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }
  const parsed: unknown[] = [];
  for (const jsonText of jsonTexts) {
    try { parsed.push(JSON.parse(jsonText)); } catch {}
  }
  return parsed;
}

function adaptiveProductionProposalCandidates(value: unknown): StrategyProposal[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const candidates: StrategyProposal[] = [];
  if (adaptiveProductionProposalHasCompleteSchema(record)) candidates.push(record);
  for (const key of ["proposal", "result", "output", "data", "response"]) {
    candidates.push(...adaptiveProductionProposalCandidates(record[key]));
  }
  return candidates;
}

function parseAdaptiveProductionStrategyProposal(text: string): AdaptiveProductionProposalParseResult {
  if (!text.trim()) {
    return { ok: false, failure: { code: "ADAPTIVE_PRODUCTION_PLANNER_OUTPUT_EMPTY", message: "The configured planner returned no proposal bytes." } };
  }
  const parsed = extractAdaptiveProductionJsonObjects(text);
  if (parsed.length === 0) {
    return { ok: false, failure: { code: "ADAPTIVE_PRODUCTION_PLANNER_OUTPUT_MALFORMED", message: "Planner output contained no parseable JSON object." } };
  }
  const unique = new Map<string, StrategyProposal>();
  for (const root of parsed) {
    for (const proposal of adaptiveProductionProposalCandidates(root)) {
      unique.set(canonicalAdaptiveValue(proposal), proposal);
    }
  }
  if (unique.size === 0) {
    return { ok: false, failure: { code: "ADAPTIVE_PRODUCTION_PLANNER_PROPOSAL_SCHEMA_INCOMPLETE", message: "Planner JSON did not contain one schema-complete StrategyProposal." } };
  }
  if (unique.size > 1) {
    return { ok: false, failure: { code: "ADAPTIVE_PRODUCTION_PLANNER_PROPOSAL_AMBIGUOUS", message: `Planner output contained ${unique.size} distinct schema-complete proposals.` } };
  }
  return { ok: true, proposal: structuredClone([...unique.values()][0]) };
}

function adaptiveProductionSchemaRepairPrompt(
  failedOutput: string,
  failure: AdaptiveProductionProposalParseFailure,
  mission: FrozenMissionContract,
  gaps: string[],
): string {
  return [
    "ADAPTIVE_PRODUCTION_SCHEMA_REPAIR_V1",
    "Your previous production replan response could not be parsed. This is the only schema-repair retry.",
    `Host diagnostic: ${failure.code}: ${failure.message}`,
    "Return exactly one JSON object and no Markdown or commentary. Never invent a fallback outside your own materially-different proposal.",
    `preservedMissionHash MUST equal ${mission.missionHash}. Target gap ids: ${JSON.stringify(gaps)}.`,
    `Allowed mutation paths: ${JSON.stringify(mission.contract.protectedPathsAndPermissions.allowedMutationPaths)}. Required permissions: ${JSON.stringify(mission.contract.protectedPathsAndPermissions.grantedPermissions)}.`,
    "Required shape: {\"preservedMissionHash\":\"...\",\"strategy\":{\"strategyId\":\"...\",\"strategyFamily\":\"...\",\"whichGapIds\":[\"...\"],\"currentBeliefOrHypothesis\":\"...\",\"method\":\"...\",\"materialProfile\":{},\"expectedEvidence\":[\"executor-progress\"],\"abandonmentCondition\":\"...\",\"attemptsUsed\":0,\"resourceBudget\":{\"maxAttempts\":1,\"resourceUnits\":1,\"resourceUnitsPerAttempt\":1},\"operations\":[\"...\"],\"requiredPermissions\":[\"...\"],\"mutationPaths\":[\"...\"]}}",
    `Previous response (repair its schema; do not copy surrounding prose): ${JSON.stringify(failedOutput)}`,
  ].join("\n\n");
}

function adaptiveCanaryFailureObservation(permit: { strategy: CurrentStrategy }, output: SubagentResult): FailureObservation {
  const parsed = adaptiveJsonObject(output.text, "ADAPTIVE_CANARY_FAMILY_A");
  const evidenceRefs = Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
  if (parsed.outcome !== "failure" || evidenceRefs.length > 0) {
    throw new Error("ADAPTIVE_CANARY_FAMILY_A_MUST_RETURN_NO_INFORMATION_FAILURE");
  }
  // The host, not model prose, owns the stable equivalence signature.
  return {
    strategyId: permit.strategy.strategyId,
    strategyFamily: permit.strategy.strategyFamily,
    normalizedFailureSignature: "host-classified-equivalent-no-information",
    newEvidenceFlag: false,
    evidenceRefs: [],
  };
}

async function runAdaptiveEnforceCanaryVisibleMain(
  initialState: SupervisionRunState,
  store: SupervisionStateStore,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  internal: OrchestrationState,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  dispatchApproval: ApprovalConsumptionMetadata,
) {
  let state = initialState;
  const runtime = requireGenericRuntime(state);
  let terminalVerificationEvidence: Record<string, unknown> = {};
  const failTerminal = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (state.status === "executing") state = transitionSupervisionState(state, "awaiting_supervisor");
    if (state.status === "awaiting_supervisor") state = transitionSupervisionState(state, "verifying");
    if (state.status === "verifying") state = transitionSupervisionState(state, "terminal");
    state.terminalOutcome = "fail";
    updateGenericCursor(state, { stage: "terminal", nextTaskIndex: state.tasks.length, currentTaskId: undefined });
    state = store.appendCheckpoint(state, {
      kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash,
      criteria: state.mission.acceptanceCriteria.map((criterion) => criterion.id), effectChanges: [], outcome: "fail",
    }, { ...terminalVerificationEvidence, adaptiveSupervision: { mode: "enforce-canary-v1", error: message, secondApprovalIssued: false } });
    updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
    store.save(state);
    return lifecycleResult(state, undefined, {
      ...terminalVerificationEvidence,
      adaptiveSupervision: { mode: "enforce-canary-v1", status: "fail", error: message, approvalCount: 1, secondApprovalIssued: false },
    });
  };

  try {
    if (state.tasks.length !== 1) throw new Error("ADAPTIVE_CANARY_REQUIRES_EXACTLY_ONE_BOUNDED_PLAN_TASK");
    if (params.predictedWriteSet?.some((entry) => /[*?\[\]]/.test(entry))) {
      throw new Error("ADAPTIVE_CANARY_GLOB_WRITE_SET_UNSUPPORTED");
    }
    const task = state.tasks[0];
    const mission = adaptiveMissionFromVisibleMain(state.mission, runtime.plan.predictedWriteSet);
    const canaryStore = new AdaptiveEnforceCanaryStore(runsRootDir(), state.runId);
    if (canaryStore.exists()) throw new Error("ADAPTIVE_CANARY_ALREADY_STARTED");
    canaryStore.create({
      runId: state.runId,
      mission,
      gaps: adaptiveCanaryGaps(),
      strategyA: adaptiveStrategyA(),
      approvalCount: 1,
    });
    runtime.adapterState = {
      ...(runtime.adapterState ?? {}),
      adaptiveSupervision: {
        mode: "enforce-canary-v1",
        missionHash: mission.missionHash,
        stateFile: canaryStore.stateFile,
        eventsFile: canaryStore.eventsFile,
        approvalCount: 1,
      },
    };
    state = transitionSupervisionState(state, "executing");
    state.currentTaskId = task.id;
    updateGenericCursor(state, { currentTaskId: task.id });
    store.save(state);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const before = captureContentSignatureSnapshot(state.mission.cwd);
      const permit = canaryStore.beginStrategyAExecution();
      emit(`Adaptive enforce canary: dispatching real family A attempt ${attempt}/2.`);
      const output = await spawnChecked(
        internal, params, agents, params.executorAgent,
        [
          "ADAPTIVE_SUPERVISION_CANARY_FAMILY_A",
          `Attempt ${attempt}/2. This is a non-mutating routed canary probe; do not use tools or modify files.`,
          "Return JSON exactly: {\"outcome\":\"failure\",\"evidenceRefs\":[],\"observation\":\"no new acceptance information\"}.",
          `Frozen mission hash: ${mission.missionHash}`,
        ].join("\n\n"),
        signal, emit, undefined, toModelOverride(params.executorModel, params.executorProvider),
      );
      const changes = diffContentSignatureSnapshots(before, captureContentSignatureSnapshot(state.mission.cwd));
      if (changes.length) throw new Error(`ADAPTIVE_CANARY_FAMILY_A_MUTATED_WORKSPACE: ${changes.map((item) => item.path).join(", ")}`);
      canaryStore.recordStrategyAFailure(adaptiveCanaryFailureObservation(permit, output));
    }
    if (canaryStore.load().phase !== "strategy_a_exhausted") throw new Error("ADAPTIVE_CANARY_FAMILY_A_NOT_EXHAUSTED");

    const proposalBaseline = captureContentSignatureSnapshot(state.mission.cwd);
    emit("Adaptive enforce canary: family A exhausted; requesting a real model-authored Strategy B.");
    const proposer = await spawnChecked(
      internal, params, agents, params.plannerAgent,
      [
        "ADAPTIVE_SUPERVISION_CANARY_MODEL_B_PROPOSAL",
        "Propose one materially different Strategy B for the same frozen mission. Return a single JSON StrategyProposal and no Markdown.",
        `preservedMissionHash MUST equal ${mission.missionHash}.`,
        "strategyFamily must not be family-a-equivalent-no-information; whichGapIds must be [\"G1\"].",
        "Use explicit expectedEvidence [\"strict-product-acceptance\"] and a non-empty abandonmentCondition.",
        "Allowed operations are inspect, bounded-product-work, and test. Forbidden operations are destructive, scope-expansion, and acceptance-weakening.",
        `Allowed mutation paths: ${JSON.stringify(runtime.plan.predictedWriteSet ?? [])}. Required permissions: workspace-read${runtime.plan.predictedWriteSet?.length ? " and bounded-write" : ""}.`,
        "Include all CurrentStrategy fields. Set attemptsUsed=0 and resourceBudget={\"maxAttempts\":1,\"resourceUnits\":1,\"resourceUnitsPerAttempt\":1}. materialProfile is ignored and reclassified by the host.",
        `Frozen strict acceptance (cannot be overridden): ${JSON.stringify(mission.contract.acceptanceCriteria)}`,
        `Original task: ${state.mission.originalTask}`,
        `Approved plan task: ${task.description}`,
      ].join("\n\n"),
      signal, emit, undefined, toModelOverride(params.plannerModel, params.plannerProvider),
    );
    const proposalChanges = diffContentSignatureSnapshots(proposalBaseline, captureContentSignatureSnapshot(state.mission.cwd));
    if (proposalChanges.length) throw new Error("ADAPTIVE_CANARY_PROPOSER_MUTATED_WORKSPACE");
    const modelProposal = parseAdaptiveStrategyProposal(proposer.text);
    const hostMaterialProfile = hostClassifyAdaptiveMaterial(modelProposal.strategy);
    const proposed = canaryStore.recordStrategyBProposal(modelProposal, hostMaterialProfile);
    const latestValidation = proposed.proposals.at(-1)?.validation;
    if (!latestValidation?.accepted) {
      const reasons = latestValidation && !latestValidation.accepted ? latestValidation.reasons.map((item) => item.code).join(",") : "UNKNOWN";
      throw new Error(`ADAPTIVE_CANARY_STRATEGY_B_REJECTED: ${reasons}`);
    }
    canaryStore.activateStrategyB(); // fsync + read-after-write before any B permit/dispatch
    const bPermit = canaryStore.beginStrategyBExecution();
    if (!bPermit.durableStrategyBActivation) throw new Error("ADAPTIVE_CANARY_B_NOT_DURABLY_ACTIVATED");

    const beforeB = captureContentSignatureSnapshot(state.mission.cwd);
    emit("Adaptive enforce canary: durably activated Strategy B; dispatching B in the same run.");
    const bOutput = await spawnChecked(
      internal, params, agents, params.executorAgent,
      [
        "ADAPTIVE_SUPERVISION_CANARY_STRATEGY_B_EXECUTION",
        "Execute the approved Strategy B now in this same run. Use tools only inside its host-validated operation, permission, and mutation boundaries.",
        `Run identity: ${state.runId}. Frozen mission hash: ${mission.missionHash}.`,
        `Original task: ${state.mission.originalTask}`,
        `Approved plan task: ${task.description}`,
        `Host-validated Strategy B: ${JSON.stringify(bPermit.strategy)}`,
        `Strict acceptance remains: ${JSON.stringify(mission.contract.acceptanceCriteria)}`,
        "After completing real work, return JSON with outcome=success, a non-empty evidenceRef, and a concise summary.",
      ].join("\n\n"),
      signal, emit, undefined, toModelOverride(params.executorModel, params.executorProvider), undefined, true,
    );
    const bParsed = adaptiveJsonObject(bOutput.text, "ADAPTIVE_CANARY_STRATEGY_B");
    if (bParsed.outcome !== "success" || typeof bParsed.evidenceRef !== "string" || !bParsed.evidenceRef.trim()) {
      throw new Error("ADAPTIVE_CANARY_STRATEGY_B_SUCCESS_EVIDENCE_REQUIRED");
    }
    const afterB = captureContentSignatureSnapshot(state.mission.cwd);
    const changes = diffContentSignatureSnapshots(beforeB, afterB);
    const effectContract = supervisedTaskEffectContract(runtime, state.mission.paradigm, task);
    if (effectContract.requiresContentProgress && changes.length === 0) throw new Error("ADAPTIVE_CANARY_B_NO_CONTENT_PROGRESS");
    const pathViolations = checkLanePaths({
      lane: state.lane, cwd: state.mission.cwd, worktree: state.mission.worktree,
      paths: changes.map((change) => change.path), allowedWriteSet: task.predictedWriteSet ?? runtime.plan.predictedWriteSet,
    });
    if (pathViolations.length) throw new Error(`ADAPTIVE_CANARY_B_SCOPE_VIOLATION: ${pathViolations.map((item) => item.message).join("; ")}`);
    canaryStore.recordStrategyBSuccess({
      evidenceRef: bParsed.evidenceRef.trim(),
      evidenceKind: "strict-product-acceptance",
      gapId: "G1",
      effect: "close",
      acceptanceEligible: true,
    });
    const output = executorOutputFromSupervisedResult({ id: task.id, description: task.description, dependsOn: task.dependsOn }, bOutput);
    runtime.executorOutputs.push(output);
    runtime.contentBaseline = afterB;
    runtime.completedTaskIds = [task.id];
    state.lastTaskId = task.id;
    state.currentTaskId = undefined;
    state = store.appendCheckpoint(state, {
      kind: "executor", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash,
      taskId: task.id, criteria: task.criteria, effectChanges: changes, outcome: "adaptive_strategy_b_settled",
    }, {
      output,
      hostMetadata: createExecutorCheckpointHostMetadata(dispatchApproval),
      adaptiveSupervision: { phase: "acceptance_evaluation", durableStrategyBActivation: true, secondApprovalIssued: false },
    });
    updateGenericCursor(state, { stage: "verifier", nextTaskIndex: 1, completedTaskIds: [task.id], currentTaskId: undefined, lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
    state = transitionSupervisionState(state, "awaiting_supervisor");
    state = transitionSupervisionState(state, "verifying"); // internal continuation: no second human approval/token
    store.save(state);

    const verifier = await spawnChecked(
      internal, params, agents, params.verifierAgent,
      `VISIBLE_MAIN_ADAPTIVE_CANARY_STRICT_VERIFICATION\nVerify every frozen product acceptance criterion after the real A,A,model-B,B sequence. Return JSON exactly: {"status":"pass"|"fail","reasons":["..."],"criterionFindings":[{"criterionId":"AC-01","status":"pass"|"fail","evidence":[{"kind":"test","observed":"...","exitCode":0}]}]}\nMission: ${JSON.stringify(state.mission)}\nAdaptive state: ${JSON.stringify(canaryStore.load())}\nStrategy B output: ${JSON.stringify(output)}`,
      signal, emit, undefined, toModelOverride(params.verifierModel, params.verifierProvider),
      undefined, false, true,
    );
    const verifierParsed = adaptiveJsonObject(verifier.text, "ADAPTIVE_CANARY_VERIFIER");
    const findings = Array.isArray(verifierParsed.criterionFindings) ? verifierParsed.criterionFindings as CriterionFinding[] : [];
    const numericGateFindings = evaluateNumericAcceptanceGates(state.mission);
    const numericCoverageIssues = numericTargetCoverageIssues(state.mission);
    const verificationIssues = [
      ...validateFinalVerification(state.mission, findings),
      ...numericGateFailureIssues(numericGateFindings),
      ...numericCoverageIssues,
    ];
    const failedFindings = [...findings.filter((finding) => finding.status === "fail"), ...numericGateFindings.filter((finding) => finding.status === "fail")];
    terminalVerificationEvidence = { verifier, findings, numericGateFindings, numericCoverageIssues, verificationIssues };
    if (verifierParsed.status !== "pass" || hasBlockingVerificationIssues(verificationIssues) || failedFindings.length) {
      throw new Error(`ADAPTIVE_CANARY_STRICT_ACCEPTANCE_FAILED: ${verificationIssues.map((item) => item.message).join("; ")}`);
    }
    if (numericCoverageIssues.length > 0) {
      state = transitionSupervisionState(state, "awaiting_supervisor");
      state = store.appendCheckpoint(state, {
        kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash,
        criteria: numericCoverageIssues.map((issue) => issue.criterionId).filter((value): value is string => Boolean(value)), effectChanges: [], outcome: "numeric_evaluation_unavailable",
      }, { verifier, findings, numericGateFindings, numericCoverageIssues, verificationIssues, adaptiveSupervision: { phase: "awaiting_numeric_supervisor_judgment", approvalCount: 1, secondApprovalIssued: false } });
      updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
      store.save(state);
      const approved = issueCheckpointApproval(store, state);
      return lifecycleResult(approved.state, approved.token, { verifier, findings, numericGateFindings, numericCoverageIssues, verificationIssues });
    }
    canaryStore.completeStrictAcceptance(mission.contract.acceptanceCriteria);
    state.completedCriteria = state.mission.acceptanceCriteria.map((criterion) => criterion.id);
    updateGenericCursor(state, { stage: "terminal", nextTaskIndex: 1, completedTaskIds: [task.id] });
    state = transitionSupervisionState(state, "terminal");
    state.terminalOutcome = "pass";
    state = store.appendCheckpoint(state, {
      kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash,
      criteria: state.completedCriteria, effectChanges: [], outcome: "pass",
    }, { verifier, findings, numericGateFindings, verificationIssues, adaptiveSupervision: { phase: "completed", approvalCount: 1, secondApprovalIssued: false } });
    updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
    store.save(state);
    return lifecycleResult(state, undefined, {
      verifier, findings, numericGateFindings, verificationIssues,
      adaptiveSupervision: {
        mode: "enforce-canary-v1", status: "pass", approvalCount: 1, secondApprovalIssued: false,
        state: canaryStore.load(), events: canaryStore.readEvents(),
      },
    });
  } catch (error) {
    return failTerminal(error);
  }
}

function adaptiveProductionFailureSignature(output: ExecutorOutput, requiresContentProgress: boolean, changeCount: number): string {
  const text = `${output.stderr ?? ""}\n${output.output}`;
  const stableCode = text.match(/\b(?:[A-Z][A-Z0-9]+_){1,}[A-Z0-9]+\b/)?.[0]?.toLowerCase();
  if (output.exitCode !== 0) return `executor-exit-${output.exitCode}:${stableCode ?? "no-stable-code"}`;
  if (/^(?:FINAL[_ ]VERDICT|STATUS|OVERALL|RESULT)\s*[:=-]\s*(?:FAIL|FAILED|ERROR|INCONCLUSIVE|UNKNOWN)\b/im.test(text)) {
    return `executor-explicit-fail:${stableCode ?? "no-stable-code"}`;
  }
  if (requiresContentProgress && changeCount === 0) return `required-content-no-change:${stableCode ?? "no-stable-code"}`;
  return `grounding-failure:${stableCode ?? "no-stable-code"}`;
}

function adaptiveProductionEvidenceRef(output: ExecutorOutput, changes: ContentSignatureChange[]): string {
  return `executor-progress:${createHash("sha256").update(canonicalAdaptiveValue({
    taskId: output.taskId,
    exitCode: output.exitCode,
    output: output.output,
    changes,
    toolCalls: output.toolCalls ?? null,
  }), "utf8").digest("hex")}`;
}

function adaptiveProductionReplacementTask(
  task: CriterionTask,
  strategy: CurrentStrategy,
  runId: string,
  missionHash: string,
): PlanTask {
  return {
    id: task.id,
    dependsOn: task.dependsOn,
    description: [
      "ADAPTIVE SUPERVISION V1 — DURABLY ACTIVATED REPLACEMENT STRATEGY.",
      "Execute the replacement below against the same frozen mission. Do not broaden scope or weaken acceptance.",
      `Production run identity: ${runId}. Frozen mission hash: ${missionHash}.`,
      `Original approved task: ${task.description}`,
      `Replacement strategy: ${JSON.stringify(strategy)}`,
    ].join("\n\n"),
  };
}

async function runAdaptiveProductionTask(
  state: SupervisionRunState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  internal: OrchestrationState,
  task: CriterionTask,
  plan: Plan,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
): Promise<{ output: ExecutorOutput; store: AdaptiveProductionStore }> {
  if (state.tasks.length !== 1) throw new Error("ADAPTIVE_PRODUCTION_V1_REQUIRES_ONE_COHERENT_PLAN_TASK");
  const runtime = requireGenericRuntime(state);
  const mission = adaptiveMissionFromVisibleMain(state.mission, runtime.plan.predictedWriteSet);
  const productionStore = new AdaptiveProductionStore(runsRootDir(), state.runId);
  if (!productionStore.exists()) {
    productionStore.create({
      runId: state.runId,
      hostMissionHash: state.mission.missionHash,
      mission,
      gaps: adaptiveProductionGaps(state),
      initialStrategy: adaptiveProductionStrategy(state, runtime, task),
      approvalCount: 1,
    });
  }
  runtime.adapterState = {
    ...(runtime.adapterState ?? {}),
    adaptiveSupervision: {
      mode: "adaptive-v1",
      stateFile: productionStore.stateFile,
      eventsFile: productionStore.eventsFile,
      approvalCount: 1,
      controlledExecution: true,
    },
  };

  let lastFailureSignature: string | undefined;
  while (true) {
    const adaptiveState = productionStore.load();
    if (adaptiveState.phase === "strategy_executing") {
      throw new Error("ADAPTIVE_PRODUCTION_MUTATION_OUTCOME_UNKNOWN: restart occurred after reservation; refusing blind replay.");
    }
    if (adaptiveState.phase === "acceptance_evaluation" || adaptiveState.phase === "completed") {
      const prior = runtime.executorOutputs.at(-1) as ExecutorOutput | undefined;
      if (!prior) throw new Error("ADAPTIVE_PRODUCTION_SETTLED_OUTPUT_MISSING");
      return { output: prior, store: productionStore };
    }
    if (adaptiveState.phase === "failed") {
      throw new Error(`${adaptiveState.failure?.code ?? "ADAPTIVE_PRODUCTION_FAILED"}: ${adaptiveState.failure?.message ?? "adaptive state failed"}`);
    }

    if (adaptiveState.phase === "strategy_exhausted") {
      const proposalBaseline = captureContentSignatureSnapshot(state.mission.cwd);
      emit("Adaptive Supervision v1: current strategy family exhausted; requesting a materially different legal replacement.");
      const unresolvedGapIds = adaptiveState.gaps.filter((gap) => gap.status !== "closed").map((gap) => gap.gapId);
      const proposalRoute = toModelOverride(params.plannerModel, params.plannerProvider);
      const proposer = await spawnChecked(
        internal, params, agents, params.plannerAgent,
        [
          "ADAPTIVE_SUPERVISION_PRODUCTION_REPLAN_V1",
          "Return one JSON StrategyProposal and no Markdown. The host ignores your materialProfile and classifies material differences itself.",
          `preservedMissionHash MUST equal ${mission.missionHash}. Do not include acceptanceCriteriaOverride.`,
          `Target unresolved gap ids: ${JSON.stringify(unresolvedGapIds)}.`,
          `Exhausted strategy: ${JSON.stringify(adaptiveState.activeStrategy)}.`,
          "The replacement must materially change hypothesis, mechanism, decomposition, environment, instrumentation, worker, task scope, or legal route—not merely rename/paraphrase the old task.",
          "Allowed operations: inspect, bounded-product-work, test. Forbidden: destructive, scope-expansion, acceptance-weakening.",
          `Allowed mutation paths: ${JSON.stringify(runtime.plan.predictedWriteSet ?? [])}. Required permissions: workspace-read${runtime.plan.predictedWriteSet?.length ? " and bounded-write" : ""}.`,
          "Include every CurrentStrategy field; expectedEvidence must be [\"executor-progress\"], attemptsUsed=0, resourceBudget={\"maxAttempts\":1,\"resourceUnits\":1,\"resourceUnitsPerAttempt\":1}, and a non-empty abandonmentCondition.",
          `Frozen strict acceptance: ${JSON.stringify(mission.contract.acceptanceCriteria)}.`,
          `Original mission: ${state.mission.originalTask}`,
          `Approved task: ${task.description}`,
          `Observed failures: ${JSON.stringify(adaptiveState.observations)}`,
        ].join("\n\n"),
        signal, emit, undefined, proposalRoute,
      );
      const initialProposalChanges = diffContentSignatureSnapshots(proposalBaseline, captureContentSignatureSnapshot(state.mission.cwd));
      if (initialProposalChanges.length) throw new Error(`ADAPTIVE_PRODUCTION_PROPOSER_MUTATED_WORKSPACE: ${initialProposalChanges.map((change) => change.path).join(", ")}`);
      let parsedProposal = parseAdaptiveProductionStrategyProposal(proposer.text);
      if (!parsedProposal.ok) {
        emit(`Adaptive Supervision v1: planner proposal invalid (${parsedProposal.failure.code}); performing the sole schema-repair retry.`);
        const repair = await spawnChecked(
          internal, params, agents, params.plannerAgent,
          adaptiveProductionSchemaRepairPrompt(proposer.text, parsedProposal.failure, mission, unresolvedGapIds),
          signal, emit, undefined, proposalRoute,
        );
        parsedProposal = parseAdaptiveProductionStrategyProposal(repair.text);
        if (!parsedProposal.ok) {
          throw new Error(`${parsedProposal.failure.code}: ${parsedProposal.failure.message} The single production schema-repair retry was exhausted.`);
        }
      }
      const proposalChanges = diffContentSignatureSnapshots(proposalBaseline, captureContentSignatureSnapshot(state.mission.cwd));
      if (proposalChanges.length) throw new Error(`ADAPTIVE_PRODUCTION_PROPOSER_MUTATED_WORKSPACE: ${proposalChanges.map((change) => change.path).join(", ")}`);
      const modelProposal = parsedProposal.proposal;
      const proposed = productionStore.recordProposal(modelProposal, hostClassifyAdaptiveProductionMaterial(modelProposal.strategy));
      const validation = proposed.proposals.at(-1)?.validation;
      if (!validation?.accepted) {
        const codes = validation && !validation.accepted ? validation.reasons.map((reason) => reason.code).join(",") : "UNKNOWN";
        throw new Error(`ADAPTIVE_PRODUCTION_STRATEGY_REJECTED: ${codes}`);
      }
      productionStore.activateReplacement(); // fsync + read-after-write precede replacement dispatch
      continue;
    }

    if (!["strategy_ready", "strategy_retry_ready", "strategy_activated"].includes(adaptiveState.phase)) {
      throw new Error(`ADAPTIVE_PRODUCTION_PHASE_UNSUPPORTED: ${adaptiveState.phase}`);
    }
    const permit = productionStore.beginExecution();
    const isReplacement = permit.strategy.strategyId !== productionStore.load().initialStrategyId;
    const attemptTask: PlanTask = isReplacement
      ? adaptiveProductionReplacementTask(task, permit.strategy, state.runId, mission.missionHash)
      : permit.reservation.attempt === 1
        ? { id: task.id, description: task.description, dependsOn: task.dependsOn }
        : {
            id: task.id,
            dependsOn: task.dependsOn,
            description: [
              task.description,
              "ADAPTIVE SUPERVISION V1 — SOLE SAME-FAMILY RETRY.",
              "Use materially stronger instrumentation and explicitly seek new evidence. Do not merely repeat or paraphrase the first attempt. If the same failure recurs without new information, report it plainly; this family will be exhausted.",
              `Prior host failure signature: ${lastFailureSignature ?? "unknown"}.`,
            ].join("\n\n"),
          };
    emit(`Adaptive Supervision v1: executing ${isReplacement ? "durably activated replacement" : "current strategy"} attempt ${permit.reservation.attempt}.`);
    const before = captureContentSignatureSnapshot(state.mission.cwd);
    const output = await executeExecutorTaskWithRecovery(internal, params, agents, attemptTask, plan, signal, emit, undefined);
    const after = captureContentSignatureSnapshot(state.mission.cwd);
    const changes = diffContentSignatureSnapshots(before, after);
    const cumulativeChanges = diffContentSignatureSnapshots(runtime.contentBaseline, after);
    const pathViolations = checkLanePaths({
      lane: state.lane,
      cwd: state.mission.cwd,
      worktree: state.mission.worktree,
      paths: changes.map((change) => change.path),
      allowedWriteSet: task.predictedWriteSet ?? runtime.plan.predictedWriteSet,
    });
    if (pathViolations.length) {
      throw new Error(`ADAPTIVE_PRODUCTION_SCOPE_VIOLATION: ${pathViolations.map((item) => item.message).join("; ")}`);
    }
    const effectContract = supervisedTaskEffectContract(runtime, state.mission.paradigm, task);
    const grounded = hasSuccessfulGroundedSupervisedOutput(output);
    const success = grounded && (!effectContract.requiresContentProgress || cumulativeChanges.length > 0);
    if (success) {
      const settledOutput = { ...output, description: task.description };
      // Persist the real settled output in the host runtime before advancing the
      // adaptive state. A crash after success_recorded can therefore resume
      // acceptance evaluation without reconstructing executor prose.
      if (!runtime.executorOutputs.some((candidate) =>
        candidate.taskId === settledOutput.taskId && candidate.output === settledOutput.output && candidate.exitCode === settledOutput.exitCode)) {
        runtime.executorOutputs.push(settledOutput);
      }
      new SupervisionStateStore(state.runId).save(state);
      productionStore.recordSuccess(adaptiveProductionEvidenceRef(settledOutput, cumulativeChanges));
      return { output: settledOutput, store: productionStore };
    }

    const signature = adaptiveProductionFailureSignature(output, effectContract.requiresContentProgress, cumulativeChanges.length);
    const priorEquivalent = productionStore.load().observations.some((observation) =>
      observation.strategyFamily.toLowerCase() === permit.strategy.strategyFamily.toLowerCase() &&
      observation.normalizedFailureSignature === signature);
    lastFailureSignature = signature;
    const failed = productionStore.recordFailure({
      strategyId: permit.strategy.strategyId,
      strategyFamily: permit.strategy.strategyFamily,
      normalizedFailureSignature: signature,
      newEvidenceFlag: !priorEquivalent,
      evidenceRefs: [],
    });
    if (failed.phase === "failed") {
      throw new Error(`${failed.failure?.code ?? "ADAPTIVE_PRODUCTION_FAILED"}: ${failed.failure?.message ?? signature}`);
    }
  }
}

/** Execute or recover exactly one durable task; never advances the host cursor itself. */
async function executeOneSupervisedTask(
  supervisionState: SupervisionRunState,
  orchestrationState: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  task: PlanTask,
  plan: Plan,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  settlementControl?: SupervisedSettlementControl,
): Promise<ExecutorOutput> {
  const runtime = requireGenericRuntime(supervisionState);
  const historicalPhases = Array.isArray(runtime.adapterState?.historicalPhases)
    ? runtime.adapterState.historicalPhases as Array<{ index: number; name: string; status: string }>
    : [];
  const historicalIndex = /^historical-(\d+)$/.exec(task.id)?.[1];
  const historicalPhase = historicalIndex === undefined
    ? undefined
    : historicalPhases.find((phase) => phase.index === Number(historicalIndex));
  const phaseName = historicalPhase?.name ?? `supervised-${task.id}`;

  let loaded: LoadedRunState | undefined;
  try { loaded = RunStateStore.load(supervisionState.runId); } catch {}
  const runStore = loaded
    ? RunStateStore.open(supervisionState.runId)
    : RunStateStore.create(
        supervisionState.runId,
        supervisionState.mission.paradigm,
        supervisionState.mission.originalTask,
        JSON.parse(JSON.stringify(params)) as Record<string, unknown>,
        [],
        runtime.adapterState?.dynamicWorkflow && typeof runtime.adapterState.dynamicWorkflow === "object"
          ? runtime.adapterState.dynamicWorkflow as Record<string, unknown>
          : undefined,
        {
          schemaVersion: 1,
          mode: "visible-main",
          classification: String(runtime.adapterState?.classification ?? "executor-bearing") as "executor-bearing" | "mutating",
          identity: runtime.identity,
          cursor: runtime.cursor,
        },
      );
  loaded = RunStateStore.load(supervisionState.runId);
  const existingPhase = loaded.state.phases.find((phase) => phase.name === phaseName);
  const phaseIndex = existingPhase?.index ?? historicalPhase?.index ?? Math.max(-1, ...loaded.state.phases.map((phase) => phase.index)) + 1;

  if (existingPhase?.status === "done") {
    const restored = loaded.checkpoints.get(phaseIndex);
    if (!restored) throw new Error(`MISSING_SUPERVISED_TASK_CHECKPOINT: ${phaseName}.`);
    emit(`Supervision restored settled task ${task.id} from ${phaseName}; no executor was respawned.`);
    return executorOutputFromSupervisedResult(task, restored as SubagentResult);
  }
  if (existingPhase?.status === "detached") {
    const survivor = loaded.survivors.get(phaseIndex);
    if (survivor) {
      const restored = await collectSurvivorResult<SubagentResult>(survivor, emit, signal, "visible-main");
      if (restored) {
        runStore.checkpointPhase(phaseIndex, phaseName, restored);
        return executorOutputFromSupervisedResult(task, restored);
      }
    }
  }

  const survival = {
    resultFile: runStore.survivorResultPath(phaseIndex, phaseName),
    manifestFile: runStore.survivorManifestPath(phaseIndex, phaseName),
    phaseName,
    phaseIndex,
    settleOnAbort: true,
    ...(settlementControl ? {
      abandonSignal: settlementControl.abandonSignal,
      onSettling: settlementControl.onSettling,
    } : {}),
  };
  try {
    const dynamicBindings = Array.isArray(runtime.adapterState?.dynamicTaskBindings)
      ? runtime.adapterState.dynamicTaskBindings as DynamicSupervisionTaskBinding[]
      : [];
    const dynamicBinding = dynamicBindings.find((binding) => binding.taskId === task.id);
    let output: ExecutorOutput;
    if (dynamicBinding && runtime.adapterState?.dynamicWorkflow && typeof runtime.adapterState.dynamicWorkflow === "object") {
      const resolved = resolvePinnedDynamicWorkflow(
        runtime.adapterState.dynamicWorkflow as Record<string, unknown>,
        supervisionState.mission.paradigm,
        NATIVE_SHAPE_NAMES,
      );
      const phase = resolved.workflow.phases.find((candidate) => candidate.id === dynamicBinding.phaseId);
      if (!phase) throw new Error(`PINNED_DYNAMIC_TASK_MISSING: ${task.id}.`);
      const roleRoute = phase.route.role === "planner"
        ? { provider: params.plannerProvider, model: params.plannerModel }
        : phase.route.role === "verifier"
          ? { provider: params.verifierProvider, model: params.verifierModel }
          : phase.route.role === "executor"
            ? { provider: params.executorProvider, model: params.executorModel }
            : {};
      const modelOverride = {
        provider: phase.route.provider ?? roleRoute.provider,
        model: phase.route.model ?? roleRoute.model,
      };
      const dependencyOutputs = (runtime.executorOutputs as ExecutorOutput[])
        .filter((item) => phase.dependsOn.some((dependency) => item.taskId === `dynamic-${dynamicBinding.iteration}-${dependency}`))
        .map((item) => `${item.agentName}: ${item.output}`)
        .join("\n\n");
      const prompt = [
        `You are executing declarative workflow ${JSON.stringify(resolved.workflow.name)}, phase ${JSON.stringify(phase.id)}, iteration ${dynamicBinding.iteration}/${resolved.workflow.maxIterations}.`,
        "Do not invoke recursive orchestration. Complete only this durable task boundary.",
        `Original task:\n${supervisionState.mission.originalTask}`,
        dependencyOutputs ? `Dependency outputs:\n${dependencyOutputs}` : "Dependency outputs: none.",
        `Phase instructions:\n${phase.prompt}`,
        phase.expectedOutput ? `Expected output:\n${phase.expectedOutput}` : "",
      ].filter(Boolean).join("\n\n");
      const result = await spawnChecked(
        orchestrationState, params, agents, phase.agentName, prompt, signal, emit, undefined,
        modelOverride.provider || modelOverride.model ? modelOverride : undefined,
        survival,
        true,
      );
      output = executorOutputFromSupervisedResult(task, result);
    } else {
      output = await executeExecutorTaskWithRecovery(
        orchestrationState, params, agents, task, plan, signal, emit, undefined, survival,
      );
    }
    runStore.checkpointPhase(phaseIndex, phaseName, {
      agentName: output.agentName,
      task: output.description,
      text: output.output,
      stderr: output.stderr ?? "",
      exitCode: output.exitCode,
      durationMs: output.durationMs,
      events: 0,
      toolCalls: output.toolCalls,
      actionEvidence: output.actionEvidence,
      commandTimes: output.commandTimes,
      provider: output.provider,
      model: output.model,
    });
    return output;
  } catch (error) {
    if (error instanceof SubagentDetachedError) runStore.markDetached(phaseIndex, phaseName, error.manifest);
    throw error;
  }
}

async function runVisibleMainLifecycle(
  raw: Record<string, unknown>,
  action: SupervisionAction,
  signal?: AbortSignal,
  onUpdate?: (update: unknown) => void,
  ctx?: { cwd?: string; model?: { provider?: string; id?: string } },
  dispatchContext?: VisibleMainDispatchContext,
  settlementControl?: SupervisedSettlementControl,
) {
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const runId = typeof raw.runId === "string" && raw.runId.trim() ? raw.runId.trim() : undefined;
  if (action !== "run") {
    if (!runId) throw new Error(`orchestrate action=${action} requires runId.`);
    const store = new SupervisionStateStore(runId);
    const persistedBeforeLifecycle = readFileSync(store.stateFile);
    const compatibility = store.loadGenericCompatibleReadOnly({
      hostInstanceId: SUPERVISION_HOST_INSTANCE,
      restartRequired: true,
    });
    let state = compatibility.state;
    if (raw.supervision !== undefined && raw.supervision !== state.mode) {
      throw new Error(`Supervision mode drift refused for ${runId}: frozen=${state.mode}, requested=${String(raw.supervision)}.`);
    }
    const frozenAdaptiveMode = state.runtime?.kind === "generic-shape"
      ? normalizePublicAdaptiveSupervisionMode(state.runtime.params.adaptiveSupervision)
      : "off";
    if (raw.adaptiveSupervision !== undefined && normalizePublicAdaptiveSupervisionMode(raw.adaptiveSupervision) !== frozenAdaptiveMode) {
      throw new Error(`Adaptive supervision mode drift refused for ${runId}: frozen=${frozenAdaptiveMode}, requested=${String(raw.adaptiveSupervision)}.`);
    }
    const frozenNoForceKill = state.mission.workerExecutionConstraints?.noForceKill === true;
    if (raw.noForceKill !== undefined && raw.noForceKill !== frozenNoForceKill) {
      throw new Error(`Worker execution constraint drift refused for ${runId}: frozen noForceKill=${frozenNoForceKill}, requested=${String(raw.noForceKill)}.`);
    }
    if (raw.lane !== undefined && raw.lane !== state.lane) {
      throw new Error(`Run lane drift refused for ${runId}: frozen=${state.lane}, requested=${String(raw.lane)}.`);
    }
    if (action === "inspect") {
      const baseline = state.runtime?.contentBaseline;
      const current = baseline ? captureContentSignatureSnapshot(state.mission.cwd, baseline.limits) : undefined;
      const currentDriftChanges = baseline && current ? diffContentSignatureSnapshots(baseline, current) : [];
      const scopedBaseline = state.runtime?.approvedScopeBaseline;
      const scopedCurrent = scopedBaseline ? captureContentSignatureSnapshot(state.mission.cwd, scopedBaseline.limits) : undefined;
      const scopedChanges = scopedBaseline && scopedCurrent ? diffContentSignatureSnapshots(scopedBaseline, scopedCurrent) : [];
      const contentCoverage = {
        workspace: baseline && current ? { partial: baseline.truncated || current.truncated || baseline.omitted.length > 0 || current.omitted.length > 0, beforeFiles: baseline.fileCount, afterFiles: current.fileCount } : { partial: true },
        approvedScope: scopedBaseline && scopedCurrent ? { paths: scopedBaseline.limits.scope, partial: scopedBaseline.truncated || scopedCurrent.truncated || scopedBaseline.omitted.length > 0 || scopedCurrent.omitted.length > 0, changes: scopedChanges, baselineReference: `${store.stateFile}#runtime.approvedScopeBaseline` } : { partial: true, unavailable: 'No initial literal approved-scope snapshot saved; historical omitted bytes cannot be reconstructed.' },
        note: 'Only observed byte changes are shown. Absence from partial or omitted coverage is not deletion; checkpoint effects are saved observations, not a complete workspace diff.',
      };
      const savedCheckpointChanges = [...state.checkpoints].reverse().find(item => item.effectChanges.length)?.effectChanges ?? [];
      // Legacy checkpoints treated snapshot absence as evidence, including byte
      // omissions that never set truncated. Their after-coverage was not saved.
      // Preserve observed modifications; revalidate absence-derived claims against
      // today's path-covered workspace/scope diff without rewriting saved effects.
      const confirmedAbsences = new Set(
        [...currentDriftChanges, ...scopedChanges].map(change => `${change.path}:${change.kind}`),
      );
      const checkpointChanges = savedCheckpointChanges.filter(change => {
        if (change.kind === 'modified' || confirmedAbsences.has(`${change.path}:${change.kind}`)) return true;
        if (!baseline) return false;
        const file = normalizeWriteSetEntry(change.path);
        if (!file || file !== change.path || path.isAbsolute(file) || /^[a-z]:/i.test(file) || file.split('/').includes('..') || /[*?\[\]{}]/.test(file)) return false;
        // A one-path observation is not starved by an unrelated cutoff/large file.
        // For additions the original baseline must also cover this path's absence.
        if (baseline.limits.scope && !baseline.limits.scope.some(scope => {
          const target = scope.replace(/\/$/, '');
          return file === target || file.startsWith(target + '/');
        })) return false;
        const observed = captureContentSignatureSnapshot(state.mission.cwd, { ...baseline.limits, scope: [file] });
        // Byte-only omissions do not stop traversal. Unlike hard cutoffs, they
        // leave absence trustworthy at other paths; the omitted paths themselves
        // remain excluded by diff's path-coverage check. This is a local view only.
        const pathBaseline = baseline.truncated
          && baseline.omitted.some(item => item.reason === 'file-byte-limit')
          && !baseline.omitted.some(item => item.reason === 'file-limit' || item.reason === 'total-byte-limit')
          ? { ...baseline, truncated: false } : baseline;
        return diffContentSignatureSnapshots(pathBaseline, observed).some(item => item.path === file && item.kind === change.kind);
      });
      const contentChanges = [...new Map(
        [...checkpointChanges, ...currentDriftChanges, ...scopedChanges].map((change) => [`${change.path}:${change.kind}`, change]),
      ).values()];
      const snapshot = buildInspectionSnapshot(state, { drift: currentMissionDrift(state), contentChanges });
      if (!persistedBeforeLifecycle.equals(readFileSync(store.stateFile))) throw new Error("INSPECT_IMMUTABILITY_BREACH");
      return {
        markdown: compactSupervisionMarkdown(state, snapshot) + `\nCoverage: ${contentCoverage.workspace.partial ? 'partial workspace' : 'bounded workspace'}; approved scope ${contentCoverage.approvedScope.partial ? 'partial/unavailable' : 'complete within declared bounds'}. ${contentCoverage.note}\nApproved-scope baseline: ${contentCoverage.approvedScope.baselineReference ?? contentCoverage.approvedScope.unavailable}`,
        details: {
          ...snapshot,
          contentCoverage,
          lane: state.lane,
          terminalOutcome: state.terminalOutcome,
          pauseReason: state.pauseReason,
          acceptance: state.acceptance,
          ...(compatibility.metadata ? { legacyCompatibility: compatibility.metadata } : {}),
        },
      };
    }
    if (state.status === "cancelled" || state.status === "terminal") throw new Error(`Run ${runId} is irreversible in status ${state.status}.`);
    // Migration is pure during inspect. A requested state-changing lifecycle
    // action is the first authorized boundary at which the generic projection
    // may replace the old runtime atomically.
    if (compatibility.migrated) store.save(state);
    if (action === "accept") {
      if (!raw.approvalToken || typeof raw.approvalToken !== "string") {
        throw new Error("orchestrate action=accept requires approvalToken.");
      }
      state = store.acceptWithReason(raw.approvalToken, raw.reason, SUPERVISION_HOST_INSTANCE);
      return lifecycleResult(state);
    }
    if (action === "cancel") {
      const now = new Date().toISOString();
      state = { ...state, currentApproval: state.currentApproval ? { ...state.currentApproval, invalidatedAt: now } : undefined };
      state = transitionSupervisionState(state, "cancelled");
      state.terminalOutcome = "cancelled";
      store.save(state);
      return lifecycleResult(state);
    }
    if (action === "pause") {
      const now = new Date().toISOString();
      state = { ...state, currentApproval: state.currentApproval ? { ...state.currentApproval, invalidatedAt: now } : undefined, pauseReason: "visible_main_pause" };
      if (state.status !== "paused") state = transitionSupervisionState(state, "paused");
      state = store.appendCheckpoint(state, { kind: "pause", createdAt: now, missionHash: state.mission.missionHash, criteria: [], effectChanges: [], outcome: "paused" }, { reason: state.pauseReason });
      updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
      store.save(state);
      const approved = issueCheckpointApproval(store, state);
      return lifecycleResult(approved.state, approved.token);
    }
    if (action !== "continue") throw new Error(`Unsupported supervision action: ${action}`);
    if ((!raw.approvalToken || typeof raw.approvalToken !== "string") && ["plan_checkpoint", "awaiting_supervisor"].includes(state.status)) {
      const approved = issueCheckpointApproval(store, state);
      return lifecycleResult(approved.state, approved.token);
    }
    if ((!raw.approvalToken || typeof raw.approvalToken !== "string") && state.status === "paused") {
      state = store.appendCheckpoint(state, { kind: "pause", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: [], effectChanges: [], outcome: "fresh_approval_required" }, { reason: state.pauseReason ?? "restart_pause" });
      updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
      store.save(state);
      const approved = issueCheckpointApproval(store, state);
      return lifecycleResult(approved.state, approved.token);
    }
    if (!raw.approvalToken || typeof raw.approvalToken !== "string") throw new Error("orchestrate action=continue requires approvalToken.");
    let runtime = requireGenericRuntime(state);
    if (!state.currentApproval) throw new Error("No approval is outstanding for this checkpoint.");
    const lastCheckpoint = state.checkpoints[state.checkpoints.length - 1];
    const consumedDispatchApproval = store.consumeApprovalForDispatch(raw.approvalToken, {
      runId, missionHash: state.mission.missionHash, checkpointId: lastCheckpoint.id, action: "continue",
    }); // exclusive compare-and-consume happens before any worker spawn
    state = consumedDispatchApproval.state;
    const dispatchApproval = consumedDispatchApproval.approvalConsumption;
    runtime = requireGenericRuntime(state);
    runtime.hostInstanceId = SUPERVISION_HOST_INSTANCE;
    store.save(state); // approved resume owns the run durably before any worker can spawn
    const boundary = currentMissionBoundary(state);
    const drift = boundary.flags;
    if (drift.some((flag) => flag.blocking)) {
      // Restart migration deliberately leaves the run paused. Once its fresh
      // approval is consumed, re-enter the ordinary supervised boundary before
      // recording drift; paused -> blocked_infrastructure is not a legal direct
      // transition and must never turn a safe drift refusal into an exception.
      if (state.status === "paused") state = transitionSupervisionState(state, "awaiting_supervisor");
      state = transitionSupervisionState(state, "blocked_infrastructure");
      state.audit.infrastructureFailures.push({ infrastructure: true, code: "orchestrator", message: drift.map((flag) => flag.message).join("; ") });
      store.save(state);
      return lifecycleResult(state, undefined, { drift });
    }
    // Consuming the one-use visible-main approval acknowledges only the
    // nonblocking commit/content advisory that was available for inspection.
    // Advance the mutable observation baseline before dispatch so external
    // effects cannot be misattributed to the next executor.
    acknowledgeSupervisorBoundary(state, boundary);
    store.save(state);

    const params = normalizeParams(runtime.params, state.mission.cwd);
    params.workerExecutionConstraints = JSON.parse(JSON.stringify(state.mission.workerExecutionConstraints ?? { noForceKill: false }));
    const agents = await loadAgents();
    resolveConfiguredRoleDefaults(params, agents);
    const internal = lifecycleState(params, runId);
    internal.intake = runtime.intake as Intake;
    const plan: Plan = { tasks: runtime.plan.tasks.map((task) => ({ id: task.id, description: task.description, dependsOn: task.dependsOn, ...(task.expectsFileChange === undefined ? {} : { expectsFileChange: task.expectsFileChange }) })), notes: runtime.plan.notes, predictedWriteSet: runtime.plan.predictedWriteSet, externalEvidenceRoots: runtime.plan.externalEvidenceRoots };
    internal.plan = plan;
    const completed = new Set(runtime.cursor.completedTaskIds);
    const legacyCompatibility = runtime.adapterState?.legacyPevMigration as { executorRespawnAllowed?: unknown; mode?: unknown } | undefined;
    const executorRespawnAllowed = legacyCompatibility?.executorRespawnAllowed !== false;
    const nextTask = runtime.cursor.stage === "executor-task" ? state.tasks[runtime.cursor.nextTaskIndex] : undefined;
    if (nextTask && !executorRespawnAllowed) {
      throw new Error("LEGACY_PEV_VERIFICATION_ONLY: compatibility state forbids historical executor respawn.");
    }
    if (nextTask && (!nextTask.dependsOn.every((dependency) => completed.has(dependency)) || completed.has(nextTask.id))) {
      throw new Error(`GENERIC_SUPERVISION_CURSOR_INVALID: task ${nextTask.id} is not the next dependency-ready unsettled task.`);
    }
    // Retain settled output and positive observations even if later evidence
    // checks fail. They do not authorize cursor/acceptance advancement.
    let settledExecutorOutput: ExecutorOutput | undefined;
    let observedEffects: ContentSignatureChange[] = [];
    let effectObservation: ExecutorOutput["effectObservation"];
    try {
      if (params.adaptiveSupervision === "enforce-canary-v1") {
        return await runAdaptiveEnforceCanaryVisibleMain(state, store, params, agents, internal, signal, emit, dispatchApproval);
      }
      if (nextTask) {
        state = transitionSupervisionState(state.status === "paused" ? transitionSupervisionState(state, "awaiting_supervisor") : state, "executing");
        state.currentTaskId = nextTask.id;
        updateGenericCursor(state, { currentTaskId: nextTask.id });
        store.save(state);
        const before = runtime.contentBaseline;
        const acceptedGitBeforeTask = acceptedRuntimeGitBaseline(state);
        const adaptiveTask = params.adaptiveSupervision === "adaptive-v1"
          ? await runAdaptiveProductionTask(state, params, agents, internal, nextTask, plan, signal, emit)
          : undefined;
        const output = adaptiveTask?.output ?? await executeOneSupervisedTask(
          state, internal, params, agents,
          { id: nextTask.id, description: nextTask.description, dependsOn: nextTask.dependsOn }, plan,
          signal, emit, settlementControl,
        );
        settledExecutorOutput = output;
        runtime.adapterState = { ...(runtime.adapterState ?? {}), commandTimes: mergeCommandTimes(runtime.adapterState?.commandTimes as CommandTimes | undefined, output.commandTimes, getCommandTimesForRun(state.runId)) };
        observedEffects = output.effectChanges ?? [];
        effectObservation = { status: observedEffects.length || (output.filesChanged ?? 0) > 0 ? "partial" : "unknown", reason: "workspace content observation unavailable" };
        const after = captureContentSignatureSnapshot(state.mission.cwd);
        const omitted = [...before.omitted, ...after.omitted];
        const workspaceChanges = diffContentSignatureSnapshots(before, after).filter((change) =>
          !omitted.some((entry) => change.path === entry.path || change.path.startsWith(`${entry.path.replace(/\/$/, "")}/`))
          && !(change.kind === "added" && before.truncated)
          && !(change.kind === "deleted" && after.truncated));
        effectObservation = {
          status: before.truncated || after.truncated || omitted.some((entry) => entry.reason !== "excluded")
            || (output.effectObservation !== undefined && output.effectObservation.status !== "complete") ? "partial" : "complete",
        };
        // Even a complete later read is only a net diff. It cannot erase
        // observed activity that a continuation or split subsequently restored.
        const changes = [...new Map([...observedEffects, ...workspaceChanges].map((change) => [change.path, change])).values()];
        observedEffects = changes;
        output.effectChanges = changes;
        output.changedFiles = [...new Set([...(output.changedFiles ?? []), ...changes.map((change) => change.path)])];
        const observedCount = Math.max(output.changedFiles.length, output.filesChanged ?? 0);
        output.filesChanged = effectObservation.status === "complete" || observedCount > 0 ? observedCount : undefined;
        output.effectObservation = effectObservation;
        if (effectObservation.status !== "complete") {
          throw new Error("CONTENT_OBSERVATION_UNAVAILABLE: workspace snapshot is incomplete; observed changes are a lower bound.");
        }
        const externalEvidenceAfter = captureExternalEvidenceSnapshot(state.mission.externalEvidenceRoots ?? []);
        const externalEvidenceBefore = runtime.externalEvidenceBaseline ?? captureExternalEvidenceSnapshot(state.mission.externalEvidenceRoots ?? []);
        const externalEvidenceChanges = diffExternalEvidenceSnapshots(externalEvidenceBefore, externalEvidenceAfter);
        if (externalEvidenceBefore.unobservableRoots.length || externalEvidenceAfter.unobservableRoots.length) {
          throw new Error(`EXTERNAL_EVIDENCE_UNOBSERVABLE: ${[...new Set([...externalEvidenceBefore.unobservableRoots, ...externalEvidenceAfter.unobservableRoots])].join(", ")}`);
        }
        if (externalEvidenceChanges.length) {
          throw new Error(`EXTERNAL_EVIDENCE_ROOT_MUTATION: declared evidence roots are read-only: ${externalEvidenceChanges.map((change) => change.path).join(", ")}`);
        }
        runtime.externalEvidenceBaseline = externalEvidenceAfter;
        if (params.adaptiveSupervision === "shadow-v1") {
          try {
            appendActualAdaptiveShadow(state, runtime, nextTask, output, changes);
          } catch (error) {
            const metadata = runtime.adapterState?.adaptiveSupervision as Record<string, unknown> | undefined;
            runtime.adapterState = {
              ...(runtime.adapterState ?? {}),
              adaptiveSupervision: {
                ...(metadata ?? { mode: "shadow-v1", records: 0 }),
                controlledExecution: false,
                observationError: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }
        const executorOutcome = classifySettledExecutorOutcome({
          outputText: output.output,
          exitCode: output.exitCode ?? 1,
          contentChangeCount: changes.length,
          expectsFileChange: nextTask.expectsFileChange,
        });
        if (executorOutcome.advisoryFlags.some((flag) => flag.code === "no_content_progress")) {
          state.audit.noProgress = true;
        }
        const pathViolations = checkLanePaths({ lane: state.lane, cwd: state.mission.cwd, worktree: state.mission.worktree, paths: changes.map((change) => change.path), allowedWriteSet: nextTask.predictedWriteSet ?? runtime.plan.predictedWriteSet });
        const { hard: hardViolations, scope: scopeViolations } = partitionLaneViolations(pathViolations);
        // Worktree escapes and protected host roots stay hard stops.
        if (hardViolations.length) throw new Error(`PROTECTED_OR_OUT_OF_SCOPE_EFFECT: ${hardViolations.map((item) => item.message).join("; ")}`);
        // An in-worktree path the planner omitted from the frozen write set is
        // a scope omission, not an infrastructure failure: widen the durable
        // write set, record the amendment, and let the supervisor's next
        // one-use continue accept it (guard-decisions, 2026-09-03).
        const scopeAmendment = scopeViolations.length
          ? applyScopeAmendment(state, runtime, nextTask.id, scopeViolations.map((item) => item.path))
          : undefined;
        if (scopeAmendment) {
          emit(`Scope amendment for ${nextTask.id}: ${scopeAmendment.paths.join(", ")} were outside the frozen write set and are now in scope pending supervisor acceptance.`);
        }
        completed.add(nextTask.id);
        if (!runtime.executorOutputs.some((candidate) =>
          candidate.taskId === output.taskId && candidate.output === output.output && candidate.exitCode === output.exitCode)) {
          runtime.executorOutputs.push(output);
        }
        const checkpointRouteObservations = appendRouteObservations(runtime, [observedRouteFromResult("executor", output)]);
        runtime.contentBaseline = after;
        const gitAfterTask = gitText(state.mission.cwd, ["rev-parse", "HEAD"]);
        if (gitAfterTask !== acceptedGitBeforeTask && executorOwnsCommit(nextTask, state.mission.originalTask, output.output, acceptedGitBeforeTask, gitAfterTask, state.mission.cwd)) {
          recordBaselineTransition(runtime, {
            source: "executor",
            from: acceptedGitBeforeTask,
            to: gitAfterTask,
            paths: changes.map((change) => change.path),
            taskId: nextTask.id,
          });
          runtime.acceptedGitBaseline = gitAfterTask;
        }
        state.lastTaskId = nextTask.id;
        state.currentTaskId = undefined;
        state.completedCriteria = state.mission.acceptanceCriteria
          .filter((criterion) => state.tasks.filter((task) => task.criteria.includes(criterion.id)).every((task) => completed.has(task.id)))
          .map((criterion) => criterion.id);
        const nextTaskIndex = runtime.cursor.nextTaskIndex + 1;
        updateGenericCursor(state, {
          stage: nextTaskIndex < state.tasks.length ? "executor-task" : "verifier",
          nextTaskIndex,
          completedTaskIds: [...completed],
          currentTaskId: undefined,
        });
        state = transitionSupervisionState(state, "awaiting_supervisor");
        state = store.appendCheckpoint(state, { kind: "executor", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, taskId: nextTask.id, criteria: nextTask.criteria, effectChanges: changes, outcome: executorOutcome.outcome }, {
          output,
          executorOutcome,
          effects: changes,
          routeObservations: checkpointRouteObservations,
          cursor: runtime.cursor,
          hostMetadata: createExecutorCheckpointHostMetadata(dispatchApproval),
          ...(scopeAmendment ? { scopeAmendment } : {}),
        });
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        if (signal?.aborted) {
          state.pauseReason = "visible_main_pause_after_executor_settlement";
          state = transitionSupervisionState(state, "paused");
          state = store.appendCheckpoint(
            state,
            {
              kind: "pause",
              createdAt: new Date().toISOString(),
              missionHash: state.mission.missionHash,
              taskId: nextTask.id,
              criteria: nextTask.criteria,
              effectChanges: [],
              outcome: "paused_after_executor_settlement",
            },
            { reason: state.pauseReason, executorCheckpointId: state.checkpoints[state.checkpoints.length - 1].id, cursor: runtime.cursor },
          );
          updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
          store.save(state);
          return lifecycleResult(state, undefined, { executor: output, settledBeforePause: true });
        }
        if (params.adaptiveSupervision !== "adaptive-v1" || nextTaskIndex < state.tasks.length) {
          const approved = issueCheckpointApproval(store, state);
          return lifecycleResult(approved.state, approved.token, { executor: output });
        }
        emit("Adaptive Supervision v1: real strategy execution settled; continuing directly to strict frozen acceptance without a second approval.");
      }

      state = transitionSupervisionState(state.status === "paused" ? transitionSupervisionState(state, "awaiting_supervisor") : state, "verifying");
      store.save(state);
      updateGenericCursor(state, { stage: "verifier", nextTaskIndex: state.tasks.length, currentTaskId: undefined });
      store.save(state);
      const verificationPrompt = buildVisibleMainVerificationPrompt(
        runtime.intake as Intake,
        state.mission,
        runtime.plan,
        runtime.executorOutputs,
      );
      const verifierCount = params.verifierCount;
      const verifierIndexes = Array.from({ length: verifierCount }, (_unused, index) => index);
      const batchNumber = (runtime.verifierBatches?.length ?? 0) + 1;
      const batchId = `verifier-batch-${batchNumber}`;
      const scheduledAt = new Date().toISOString();
      const verifierRoute = toModelOverride(params.verifierModel, params.verifierProvider);
      state.audit.activeWorkers = verifierIndexes.map((index) => ({ phase: `${batchId}-verifier-${index + 1}` }));
      state = store.appendCheckpoint(
        state,
        { kind: "verifier", createdAt: scheduledAt, missionHash: state.mission.missionHash, criteria: state.mission.acceptanceCriteria.map((criterion) => criterion.id), effectChanges: [], outcome: "parallel_batch_started" },
        { batchId, configuredCount: verifierCount, concurrency: verifierCount, activeWorkers: state.audit.activeWorkers, routeObservations: routeObservations(runtime), cursor: runtime.cursor },
      );
      runtime = requireGenericRuntime(state);

      let verifierEventSequence = 0;
      let verifierRuns: Array<{
        verifier: SubagentResult;
        parsed: Record<string, unknown> | null;
        parsing: NormalizedVisibleMainVerifierResponse;
        recoveredSettlement?: RecoveredVerifierSettlementAssessment;
        findings: CriterionFinding[];
        verificationIssues: ReturnType<typeof validateFinalVerification>;
        failedFindings: CriterionFinding[];
        spawnStartedAt: string;
        spawnStartedSequence: number;
        completedAt: string;
        completedSequence: number;
        pass: boolean;
      }> = [];
      let verifierBatchError: unknown;
      // Observe exhaustively even when runtime output lives in the mission cwd.
      // Only actual host writer transitions can be removed from attribution.
      const hostPublications = new HostPublicationObservation(state.mission.cwd);
      const verifierWorkspaceBefore = captureVerifierWorkspaceSnapshot(state.mission.cwd);
      const verifierExternalEvidenceBefore = captureExternalEvidenceSnapshot(state.mission.externalEvidenceRoots ?? []);
      let verifierWorkspaceAfter: ContentSignatureSnapshot;
      let verifierExternalEvidenceAfter: ExternalEvidenceSnapshot;
      try {
        verifierRuns = await withHostPublicationObservation(hostPublications, () => runBoundedPool(verifierIndexes, verifierCount, signal, async (verifierIndex, _index, workerSignal) => {
          const spawnStartedAt = new Date().toISOString();
          const spawnStartedSequence = ++verifierEventSequence;
          const prompt = verifierCount > 1
            ? `${verificationPrompt}\n\nVerifier instance ${verifierIndex + 1}/${verifierCount}: verify independently. The host will aggregate only after every sibling settles, and any FAIL makes the batch FAIL.`
            : verificationPrompt;
          const verifier = await spawnChecked(internal, params, agents, params.verifierAgent, prompt, workerSignal, emit, undefined, verifierRoute, undefined, false, true);
          const completedAt = new Date().toISOString();
          const completedSequence = ++verifierEventSequence;
          const parsing = normalizeVisibleMainVerifierResponse(
            parseVisibleMainVerifierResponse(verifier.text),
            {
              executorOutputContractSource: runtime.intake.executorOutputContractSource,
              plannerInferredPresentationRules: runtime.intake.plannerInferredPresentationRules
                ?? runtime.intake.inferredAdvisoryCriteria?.filter((item: string) => /executor output|presentation|format/i.test(item))
                ?? [],
            },
          );
          const parsed = parsing.parsed;
          const findings = Array.isArray(parsed?.criterionFindings) ? parsed.criterionFindings as CriterionFinding[] : [];
          const recoveredSettlement = parsing.recovery
            ? assessRecoveredVerifierSettlement(
                parsing,
                state.mission.acceptanceCriteria.map((criterion) => criterion.id),
              )
            : undefined;
          const parserIssues = parsing.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            ...(diagnostic.advisory ? { advisory: true as const } : {}),
          }));
          const verificationIssues: ReturnType<typeof validateFinalVerification> = [
            ...validateFinalVerification(state.mission, findings),
            ...parserIssues,
            ...(recoveredSettlement && !recoveredSettlement.terminalEligible
              ? [{
                  code: "incomplete_recovered_verifier_verdict",
                  message: `Recovered verifier verdict is not terminally complete: ${recoveredSettlement.issues.join("; ")}.`,
                }]
              : []),
          ];
          const failedFindings = findings.filter((finding) => finding.status === "fail");
          return {
            verifier, parsed, parsing, recoveredSettlement, findings, verificationIssues, failedFindings,
            spawnStartedAt, spawnStartedSequence, completedAt, completedSequence,
            pass: parsed?.status === "pass" && !hasBlockingVerificationIssues(verificationIssues) && failedFindings.length === 0,
          };
        }));
      } catch (error) {
        verifierBatchError = error;
      } finally {
        // runBoundedPool settles/aborts every sibling before returning. Capture
        // immediately, then clear host bookkeeping and persist below.
        verifierWorkspaceAfter = captureVerifierWorkspaceSnapshot(state.mission.cwd);
        verifierExternalEvidenceAfter = captureExternalEvidenceSnapshot(state.mission.externalEvidenceRoots ?? []);
        state.audit.activeWorkers = [];
      }

      const workspaceChanges = diffContentSignatureSnapshots(verifierWorkspaceBefore, verifierWorkspaceAfter);
      const externalEvidenceChanges = diffExternalEvidenceSnapshots(verifierExternalEvidenceBefore, verifierExternalEvidenceAfter);
      const externalEvidenceUnobservableRoots = [...new Set([
        ...verifierExternalEvidenceBefore.unobservableRoots,
        ...verifierExternalEvidenceAfter.unobservableRoots,
      ])];
      const classifyWorkspacePath = createVerifierWorkspacePathClassifier(state.mission.cwd, runsRootDir(), hostPublications.admittedPaths(verifierWorkspaceBefore, verifierWorkspaceAfter));
      const ignoredToolCacheChanges = workspaceChanges.filter((change) => classifyWorkspacePath(change.path) === "tool-cache");
      const ignoredHostRuntimeChanges = workspaceChanges.filter((change) => classifyWorkspacePath(change.path) === "host-runtime");
      const enforcedChanges = workspaceChanges.filter((change) => classifyWorkspacePath(change.path) === "enforced");
      const beforeHash = verifierWorkspaceContentHash(verifierWorkspaceBefore);
      const afterHash = verifierWorkspaceContentHash(verifierWorkspaceAfter);
      const protectedBeforeHash = verifierWorkspaceProtectedContentHash(verifierWorkspaceBefore, classifyWorkspacePath);
      const protectedAfterHash = verifierWorkspaceProtectedContentHash(verifierWorkspaceAfter, classifyWorkspacePath);
      const protectedHashChanged = protectedBeforeHash !== protectedAfterHash;
      const omissionsChanged = JSON.stringify(verifierWorkspaceBefore.omitted) !== JSON.stringify(verifierWorkspaceAfter.omitted);
      const workspaceIntegrity = {
        beforeHash,
        afterHash,
        hashChanged: beforeHash !== afterHash,
        protectedBeforeHash,
        protectedAfterHash,
        protectedHashChanged,
        omissionsChanged,
        changes: workspaceChanges,
        ignoredToolCacheChanges,
        ignoredHostRuntimeChanges,
        enforcedChanges,
        externalEvidenceChanges,
        externalEvidenceUnobservableRoots,
        // Advisory cache and host-runtime files remain in the exhaustive
        // manifests and raw diff. The same classifier removes only those exact
        // paths from detailed enforcement and the protected hashes.
        mutationDetected: enforcedChanges.length > 0 || protectedHashChanged || omissionsChanged || externalEvidenceChanges.length > 0 || externalEvidenceUnobservableRoots.length > 0,
        before: verifierWorkspaceSnapshotSummary(verifierWorkspaceBefore),
        after: verifierWorkspaceSnapshotSummary(verifierWorkspaceAfter),
      };
      const aggregationStartedAt = new Date().toISOString();
      const aggregationStartedSequence = ++verifierEventSequence;
      const numericGateFindings = evaluateNumericAcceptanceGates(state.mission);
      const numericCoverageIssues = numericTargetCoverageIssues(state.mission);
      const pass = verifierBatchError === undefined
        && !workspaceIntegrity.mutationDetected
        && verifierRuns.length === verifierCount
        && verifierRuns.every((run) => run.pass)
        && numericGateFindings.every((finding) => finding.status === "pass");
      const latestSpawnStart = verifierRuns.length ? Math.max(...verifierRuns.map((run) => run.spawnStartedSequence)) : 0;
      const earliestCompletion = verifierRuns.length ? Math.min(...verifierRuns.map((run) => run.completedSequence)) : 0;
      const latestSpawnStartedAt = verifierRuns.length ? Math.max(...verifierRuns.map((run) => Date.parse(run.spawnStartedAt))) : 0;
      const earliestCompletedAt = verifierRuns.length ? Math.min(...verifierRuns.map((run) => Date.parse(run.completedAt))) : 0;
      const verificationBatch: GenericVerifierBatchEvidence = {
        batchId,
        configuredCount: verifierCount,
        concurrency: verifierCount,
        scheduledAt,
        members: verifierRuns.map((run, index) => ({
          index: index + 1,
          agentName: run.verifier.agentName,
          ...(run.verifier.provider ? { provider: run.verifier.provider } : {}),
          ...(run.verifier.model ? { model: run.verifier.model } : {}),
          spawnStartedAt: run.spawnStartedAt,
          spawnStartedSequence: run.spawnStartedSequence,
          completedAt: run.completedAt,
          completedSequence: run.completedSequence,
          status: run.pass ? "pass" : "fail",
        })),
        parallelOverlap: verifierRuns.length === verifierCount && verifierCount > 1 && latestSpawnStart < earliestCompletion && latestSpawnStartedAt <= earliestCompletedAt,
        aggregationStartedAt,
        aggregationStartedSequence,
        aggregateStatus: pass ? "pass" : "fail",
        workspaceIntegrity,
      };
      runtime.verifierBatches = [...(runtime.verifierBatches ?? []), verificationBatch];
      runtime.adapterState = { ...(runtime.adapterState ?? {}), commandTimes: mergeCommandTimes(runtime.adapterState?.commandTimes as CommandTimes | undefined, ...verifierRuns.map(run => run.verifier.commandTimes), getCommandTimesForRun(state.runId)) };
      const verifiers = verifierRuns.map((run) => run.verifier);
      const verifier = verifiers[0];
      const allRouteObservations = appendRouteObservations(
        runtime,
        verifiers.map((result) => observedRouteFromResult("verifier", result)),
      );
      const essentialRoles = new Set((runtime.intake.routingRequirements ?? []).filter((requirement) => requirement.essential).map((requirement) => requirement.role));
      const expectedObservedRoutes = state.mission.routes.filter((route) => essentialRoles.has(route.role as RoutingRequirement["role"]));
      const routeAdvisories = checkObservedRouteAdvisories(expectedObservedRoutes, allRouteObservations);
      const verifierFindings = verifierRuns.map((run, index) => ({ verifierIndex: index + 1, findings: run.findings }));
      const verifierParsing = verifierRuns.map((run, index) => ({
        verifierIndex: index + 1,
        diagnostics: run.parsing.diagnostics,
        capabilityTelemetry: run.parsing.capabilityTelemetry,
        inferredPresentationTelemetry: run.parsing.inferredPresentationTelemetry,
        ...(run.parsing.presentationNormalization ? { presentationNormalization: run.parsing.presentationNormalization } : {}),
        ...(run.parsing.commandUnavailable ? { commandUnavailable: run.parsing.commandUnavailable } : {}),
        ...(run.parsing.recovery ? { recovery: run.parsing.recovery } : {}),
        ...(run.recoveredSettlement ? { recoveredSettlement: run.recoveredSettlement } : {}),
      }));
      const findings = verifierRuns[0]?.findings ?? [];
      const failedFindings = [
        ...verifierRuns.flatMap((run) => run.parsing.commandUnavailable ? [] : run.failedFindings),
        ...numericGateFindings.filter((finding) => finding.status === "fail"),
      ];
      const verificationIssues = [
        ...verifierRuns.flatMap((run, index) => run.verificationIssues.map((issue) => ({
          ...issue,
          message: `verifier-${index + 1}: ${issue.message}`,
        }))),
        ...numericGateFailureIssues(numericGateFindings),
        ...numericCoverageIssues,
      ];
      const verifierReasons = verifierRuns.flatMap((run, index) => {
        const reasons = Array.isArray(run.parsed?.reasons) ? run.parsed.reasons.map(String) : [];
        return reasons.map((reason) => `verifier-${index + 1}: ${reason}`);
      });
      const recoveredVerifierRuns = verifierRuns
        .map((run, index) => run.recoveredSettlement ? { verifierIndex: index + 1, ...run.recoveredSettlement } : undefined)
        .filter((value): value is { verifierIndex: number } & RecoveredVerifierSettlementAssessment => value !== undefined);
      const recoveredVerifierSettlement = recoveredVerifierRuns.length
        ? {
            terminalEligible: recoveredVerifierRuns.length === verifierRuns.filter((run) => run.parsing.recovery).length
              && recoveredVerifierRuns.every((assessment) => assessment.terminalEligible),
            verifiers: recoveredVerifierRuns,
          }
        : undefined;
      let verificationEvidence: Record<string, unknown> = {
        verifier, verifiers, findings, numericGateFindings, numericCoverageIssues, verifierFindings, verifierParsing, verificationIssues,
        verificationBatch, routeObservations: allRouteObservations, routeAdvisories,
        ...(recoveredVerifierSettlement ? { recoveredVerifierSettlement } : {}),
      };
      // Persist batch integrity before interpreting self-report. Any byte effect
      // is hostile and overrides semantic PASS, transport failure, or claimed
      // inability to run a command.
      store.save(state);
      if (workspaceIntegrity.mutationDetected) {
        const verifierMutation = { code: "verifier_mutation", reason: "verifier_mutation" } as const;
        updateGenericCursor(state, { stage: "terminal", nextTaskIndex: state.tasks.length, currentTaskId: undefined });
        state = transitionSupervisionState(state, "terminal");
        state.terminalOutcome = "fail";
        state = store.appendCheckpoint(
          state,
          { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: state.mission.acceptanceCriteria.map((criterion) => criterion.id), effectChanges: workspaceChanges, outcome: "verifier_mutation" },
          { ...verificationEvidence, verifierMutation, cursor: runtime.cursor },
        );
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        return lifecycleResult(state, undefined, { ...verificationEvidence, verifierMutation });
      }
      if (verifierBatchError !== undefined) throw verifierBatchError;
      const unavailable = verifierRuns.find((run) => run.parsing.commandUnavailable)?.parsing.commandUnavailable;
      const substantiveFailure = verifierRuns.some((run) => !run.parsing.commandUnavailable && !run.pass)
        || numericGateFindings.some((finding) => finding.status === "fail");
      if (unavailable && !substantiveFailure) throw commandUnavailableError(unavailable.message);

      const recoveredVerifierJson = verifierRuns.some((run) => run.parsing.recovery !== undefined);
      const safelyRecoveredVerifierJson = recoveredVerifierJson && verifierRuns.every((run) =>
        !run.parsing.recovery
        || (run.parsing.recovery.strategy === "eof_closing_suffix" && run.recoveredSettlement?.terminalEligible === true));
      if (pass && recoveredVerifierJson && !safelyRecoveredVerifierJson) {
        // Semantic-field extraction is deliberately less authoritative than
        // suffix-only repair. Preserve its evidence at the supervisor boundary
        // instead of automatically promoting extracted fields to terminal.
        state = transitionSupervisionState(state, "awaiting_supervisor");
        state = store.appendCheckpoint(
          state,
          { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: state.mission.acceptanceCriteria.map((criterion) => criterion.id), effectChanges: [], outcome: "advisory_verifier_parse" },
          { ...verificationEvidence, parseRecoveryAdvisory: true, cursor: runtime.cursor },
        );
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        const approved = issueCheckpointApproval(store, state);
        return lifecycleResult(approved.state, approved.token, { ...verificationEvidence, parseRecoveryAdvisory: true });
      }
      if (pass && safelyRecoveredVerifierJson) {
        // Recovery supplied structural EOF delimiters only. The frozen-ID
        // completeness assessment above proved that every required semantic
        // finding and evidence value was already present in the raw response,
        // so apply the ordinary verdict now rather than launching another
        // verifier batch. Diagnostics and raw response remain attached.
        verificationEvidence = {
          ...verificationEvidence,
          recoveryAdvisory: {
            code: "complete_recovered_verifier_verdict",
            advisory: true,
            message: "Complete recovered verifier verdict settled without repeating verification.",
          },
        };
      }
      if (pass && numericCoverageIssues.length > 0) {
        // A semantic reviewer cannot silently stand in for an absent persisted
        // measurement. Keep the explicit reason and stop at the supervisor
        // boundary; accept-with-reason remains distinct from mechanical PASS.
        state = transitionSupervisionState(state, "awaiting_supervisor");
        state = store.appendCheckpoint(
          state,
          { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: numericCoverageIssues.map((issue) => issue.criterionId).filter((value): value is string => Boolean(value)), effectChanges: [], outcome: "numeric_evaluation_unavailable" },
          { ...verificationEvidence, numericCoverageIssues, cursor: runtime.cursor },
        );
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        const approved = issueCheckpointApproval(store, state);
        return lifecycleResult(approved.state, approved.token, { ...verificationEvidence, numericCoverageIssues });
      }
      if (pass) {
        if (params.adaptiveSupervision === "adaptive-v1") {
          const adaptiveStore = new AdaptiveProductionStore(runsRootDir(), state.runId);
          const adaptiveBeforeAcceptance = adaptiveStore.load();
          adaptiveStore.completeStrictAcceptance(
            adaptiveBeforeAcceptance.gaps.map((gap) => gap.gapId),
            adaptiveBeforeAcceptance.mission.contract.acceptanceCriteria,
          );
          verificationEvidence = {
            ...verificationEvidence,
            adaptiveSupervision: {
              mode: "adaptive-v1",
              approvalCount: 1,
              secondApprovalIssued: false,
              state: adaptiveStore.load(),
              events: adaptiveStore.readEvents(),
            },
          };
        }
        state.completedCriteria = state.mission.acceptanceCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id);
        updateGenericCursor(state, { stage: "terminal", nextTaskIndex: state.tasks.length, completedTaskIds: [...completed] });
        state = transitionSupervisionState(state, "terminal");
        state.terminalOutcome = "pass";
        state = store.appendCheckpoint(state, { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: state.completedCriteria, effectChanges: [], outcome: "pass" }, { ...verificationEvidence, cursor: runtime.cursor });
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        return lifecycleResult(state, undefined, verificationEvidence);
      }
      const failedCriteria = [...new Set(failedFindings.map((finding) => finding.criterionId).filter(Boolean))];
      const repairCriteria = failedCriteria.length ? failedCriteria : state.mission.acceptanceCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id);
      if (isRoutingOnlyVerificationFailure(state.mission.acceptanceCriteria, repairCriteria)) {
        const settlement = settleRoutingOnlyVerificationFailure(state.mission.acceptanceCriteria, repairCriteria);
        state = transitionSupervisionState(state, "awaiting_supervisor");
        state = store.appendCheckpoint(
          state,
          { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: repairCriteria, effectChanges: [], outcome: "routing_advisory" },
          { ...verificationEvidence, routingOnlySettlement: settlement, repairBudgetExhausted: false, cursor: runtime.cursor },
        );
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        const approved = issueCheckpointApproval(store, state);
        return lifecycleResult(approved.state, approved.token, { ...verificationEvidence, routingOnlySettlement: settlement });
      }
      let repairPlanned = false;
      // Ambiguous old-schema states get exactly one bounded final-verification
      // opportunity. A failed verifier may not manufacture a repair executor
      // after migration declared historical replay unsafe.
      if (params.adaptiveSupervision !== "adaptive-v1" && executorRespawnAllowed && runtime.repairCount < params.maxRetries) {
        runtime.repairCount += 1;
        repairPlanned = true;
        const repairId = `repair-${runtime.repairCount}`;
        const repairBase = state.tasks.find((task) => task.id === state.lastTaskId)?.description ?? state.mission.originalTask;
        const repairReasons = verifierReasons.length ? verifierReasons : verificationIssues.map((issue) => issue.message);
        const schemaOnlyFailure = failedFindings.length === 0 && verificationIssues.length > 0;
        const routingOnlyFailure = repairCriteria.length > 0 && repairCriteria.every((criterionId) =>
          /model routing evidence/i.test(state.mission.acceptanceCriteria.find((criterion) => criterion.id === criterionId)?.text ?? ""));
        const repair: CriterionTask = {
          id: repairId,
          description: `${repairBase}\nRepair only verifier failures for ${repairCriteria.join(", ")}: ${JSON.stringify(repairReasons)}`,
          dependsOn: [...runtime.cursor.completedTaskIds],
          criteria: repairCriteria,
          predictedWriteSet: runtime.plan.predictedWriteSet,
          ...((schemaOnlyFailure || routingOnlyFailure) ? { expectsFileChange: false } : {}),
        };
        state.tasks.push(repair); state.approvedTaskIds.push(repairId); runtime.plan.tasks.push(repair);
        updateGenericCursor(state, { stage: "executor-task", nextTaskIndex: state.tasks.length - 1 });
      }
      if (!repairPlanned) {
        if (params.adaptiveSupervision === "adaptive-v1") {
          const adaptiveStore = new AdaptiveProductionStore(runsRootDir(), state.runId);
          const reason = [...verifierReasons, ...verificationIssues.map((issue) => issue.message)].join("; ") || "Strict verifier rejected one or more frozen criteria.";
          adaptiveStore.fail("ADAPTIVE_PRODUCTION_STRICT_VERIFIER_FAILED", reason);
          verificationEvidence = {
            ...verificationEvidence,
            adaptiveSupervision: {
              mode: "adaptive-v1",
              approvalCount: 1,
              secondApprovalIssued: false,
              state: adaptiveStore.load(),
              events: adaptiveStore.readEvents(),
            },
          };
        }
        updateGenericCursor(state, { stage: "terminal", nextTaskIndex: state.tasks.length });
        state = transitionSupervisionState(state, "terminal");
        state.terminalOutcome = "fail";
        state = store.appendCheckpoint(state, { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: repairCriteria, effectChanges: [], outcome: "fail" }, { ...verificationEvidence, repairBudgetExhausted: true, cursor: runtime.cursor });
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        return lifecycleResult(state, undefined, verificationEvidence);
      }
      state = transitionSupervisionState(state, "awaiting_supervisor");
      state = store.appendCheckpoint(state, { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: repairCriteria, effectChanges: [], outcome: "fail" }, { ...verificationEvidence, cursor: runtime.cursor });
      updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
      store.save(state);
      const approved = issueCheckpointApproval(store, state);
      return lifecycleResult(approved.state, approved.token, verificationEvidence);
    } catch (error) {
      if (error instanceof ConfirmedSupervisedAbandonError) {
        const now = new Date().toISOString();
        state = {
          ...state,
          currentApproval: state.currentApproval ? { ...state.currentApproval, invalidatedAt: now } : undefined,
          currentTaskId: undefined,
        };
        state = transitionSupervisionState(state, "cancelled");
        state.terminalOutcome = "cancelled";
        state.pauseReason = "confirmed_abandon_partial_file_risk";
        state.audit.activeWorkers = [];
        state = store.appendCheckpoint(
          state,
          {
            kind: "pause",
            createdAt: now,
            missionHash: state.mission.missionHash,
            criteria: [],
            effectChanges: [],
            outcome: "confirmed_abandon",
          },
          { reason: state.pauseReason, phase: error.phase, partialFileRiskAcknowledged: true },
        );
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id, currentTaskId: undefined });
        store.save(state);
        return lifecycleResult(state, undefined, { confirmedAbandon: true, partialFileRiskAcknowledged: true });
      }
      if (error instanceof SubagentDetachedError) {
        state.audit.detachedWorkers.push({ pid: error.manifest.pid, phase: error.manifest.phaseName });
        state.pauseReason = "executor_detached_survivor_requires_resume";
        state = transitionSupervisionState(state, "paused");
        state = store.appendCheckpoint(state, { kind: "pause", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, taskId: state.currentTaskId, criteria: state.currentTaskId ? state.tasks.find((task) => task.id === state.currentTaskId)?.criteria ?? [] : [], effectChanges: [], outcome: "detached_survivor" }, { survivor: error.manifest, cursor: requireGenericRuntime(state).cursor });
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        return lifecycleResult(state, undefined, { survivor: error.manifest });
      }
      const classified = classifyInfrastructureFailure(error);
      if (settledExecutorOutput) {
        settledExecutorOutput.effectObservation = effectObservation;
        if (effectObservation?.status === "unknown") {
          settledExecutorOutput.filesChanged = undefined;
          settledExecutorOutput.changedFiles = undefined;
        }
        if (!runtime.executorOutputs.some((candidate) =>
          candidate.taskId === settledExecutorOutput!.taskId && candidate.output === settledExecutorOutput!.output && candidate.exitCode === settledExecutorOutput!.exitCode)) {
          runtime.executorOutputs.push(settledExecutorOutput);
        }
      }
      const failureEffects = { effectChanges: observedEffects, ...(effectObservation ? { effectObservation } : {}) };
      const roleRecovery = error && typeof error === "object" && "roleRecovery" in error ? error.roleRecovery : undefined;
      const failureEvidence = { error: classified, ...(roleRecovery ? { roleRecovery } : {}), ...(settledExecutorOutput ? { output: settledExecutorOutput } : {}), ...(effectObservation ? { effectObservation } : {}) };
      state.audit.infrastructureFailures.push(classified);
      if (/^ROLE_RECOVERY_(?:EXHAUSTED|INTEGRITY):/.test(classified.message) && state.status === "verifying") {
        // Role recovery is already bounded and settled. Do not transform its
        // exhaustion into a new executor repair or silently issue another loop.
        state = transitionSupervisionState(state, "terminal");
        state.terminalOutcome = "fail";
        updateGenericCursor(state, { stage: "terminal", nextTaskIndex: state.tasks.length, currentTaskId: undefined });
        state = store.appendCheckpoint(state, { kind: "verifier", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: state.mission.acceptanceCriteria.map(criterion => criterion.id), ...failureEffects, outcome: "role_recovery_exhausted" }, { ...failureEvidence, cursor: requireGenericRuntime(state).cursor });
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        return lifecycleResult(state, undefined, failureEvidence);
      }
      const adaptiveDeterministicFailure = /^ADAPTIVE_PRODUCTION_[A-Z0-9_]+/.test(classified.message);
      if (params.adaptiveSupervision === "adaptive-v1" && (!classified.infrastructure || adaptiveDeterministicFailure)) {
        let adaptiveDetails: Record<string, unknown> = {
          mode: "adaptive-v1",
          approvalCount: 1,
          secondApprovalIssued: false,
          error: classified,
        };
        try {
          const adaptiveStore = new AdaptiveProductionStore(runsRootDir(), state.runId);
          if (adaptiveStore.exists()) {
            if (adaptiveStore.load().phase !== "failed") {
              adaptiveStore.fail("ADAPTIVE_PRODUCTION_EXECUTION_FAILED", classified.message);
            }
            adaptiveDetails = {
              ...adaptiveDetails,
              state: adaptiveStore.load(),
              events: adaptiveStore.readEvents(),
            };
          }
        } catch (adaptiveError) {
          adaptiveDetails.persistenceError = adaptiveError instanceof Error ? adaptiveError.message : String(adaptiveError);
        }
        if (state.status === "executing") state = transitionSupervisionState(state, "awaiting_supervisor");
        if (state.status === "awaiting_supervisor") state = transitionSupervisionState(state, "verifying");
        if (state.status === "verifying") state = transitionSupervisionState(state, "terminal");
        state.terminalOutcome = "fail";
        updateGenericCursor(state, { stage: "terminal", nextTaskIndex: state.tasks.length, currentTaskId: undefined });
        state = store.appendCheckpoint(state, {
          kind: "verifier",
          createdAt: new Date().toISOString(),
          missionHash: state.mission.missionHash,
          criteria: state.currentTaskId ? state.tasks.find((task) => task.id === state.currentTaskId)?.criteria ?? [] : [],
          ...failureEffects,
          outcome: "fail",
        }, { ...failureEvidence, adaptiveSupervision: adaptiveDetails, cursor: requireGenericRuntime(state).cursor });
        updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
        store.save(state);
        return lifecycleResult(state, undefined, { ...failureEvidence, adaptiveSupervision: adaptiveDetails });
      }
      state = transitionSupervisionState(state, classified.infrastructure ? "blocked_infrastructure" : "awaiting_supervisor");
      state = store.appendCheckpoint(state, { kind: classified.infrastructure ? "infrastructure" : "executor", createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, taskId: state.currentTaskId, criteria: state.currentTaskId ? state.tasks.find((task) => task.id === state.currentTaskId)?.criteria ?? [] : [], ...failureEffects, outcome: classified.infrastructure ? "blocked_infrastructure" : "fail" }, failureEvidence);
      if (!classified.infrastructure) {
        const approved = issueCheckpointApproval(store, state);
        return lifecycleResult(approved.state, approved.token, failureEvidence);
      }
      return lifecycleResult(state, undefined, failureEvidence);
    }
  }

  if (typeof raw.task !== "string" || !raw.task.trim()) throw new Error("orchestrate action=run requires task.");
  const params = normalizeParams(raw, ctx?.cwd ?? process.cwd());
  const paradigm = inferOrchestrationParadigm(params);
  if (!dispatchContext) throw new Error(`VISIBLE_SUPERVISION_DISPATCH_REQUIRED: ${paradigm} has no host-owned adapter binding.`);
  if (dispatchContext.resumeState?.state.supervision) {
    const binding = dispatchContext.resumeState.state.supervision;
    if (binding.mode !== "visible-main") {
      throw new Error(`HISTORICAL_SUPERVISION_MODE_REFUSED: run ${binding.mode} cannot silently switch to visible-main.`);
    }
    if (!binding.identity || JSON.stringify(binding.identity) !== JSON.stringify(dispatchContext.identity)) {
      throw new Error("HISTORICAL_SUPERVISION_IDENTITY_REFUSED: stored protocol/adapter identity does not match dispatch.");
    }
  }
  const agents = await loadAgents();
  resolveConfiguredRoleDefaults(params, agents);
  const intake = buildIntake(params, agents, undefined);
  const cwd = path.resolve(params.cwd);
  // Keep an explicitly supplied absolute Windows cwd byte-for-byte in the
  // durable mission. Runtime filesystem access uses the resolved path, while
  // supervision compares canonical identities so slash aliases do not drift.
  const durableMissionCwd = path.isAbsolute(params.cwd) || /^[a-zA-Z]:[\\/]/.test(params.cwd)
    ? params.cwd
    : cwd;
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const branch = gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseline = gitText(cwd, ["rev-parse", "HEAD"]);
  const criteria = buildNumericAwareAcceptanceCriteria(params.task, params.numericAcceptanceGates, intake.successCriteria);
  const plannerRoute = resolveNamedRoleRoute(agents, params.plannerAgent, params.plannerModel, params.plannerProvider);
  const executorRoute = resolveNamedRoleRoute(agents, params.executorAgent, params.executorModel, params.executorProvider);
  const verifierRoute = resolveNamedRoleRoute(agents, params.verifierAgent, params.verifierModel, params.verifierProvider);
  const mission = createFrozenMission({
    originalTask: params.task, cwd: durableMissionCwd, worktree: { root, realRoot: realpathSync.native(root), branch, baseline },
    paradigm, lane: raw.lane === "orchestrator-maintenance" ? "orchestrator-maintenance" : "product",
    routes: [
      { role: "planner", agentName: params.plannerAgent, provider: plannerRoute.provider ?? "default", model: plannerRoute.model ?? "default" },
      { role: "executor", agentName: params.executorAgent, provider: executorRoute.provider ?? "default", model: executorRoute.model ?? "default" },
      { role: "verifier", agentName: params.verifierAgent, provider: verifierRoute.provider ?? "default", model: verifierRoute.model ?? "default" },
    ], constraints: intake.constraints, nonGoals: intake.nonGoals, acceptanceCriteria: criteria,
    workerExecutionConstraints: params.workerExecutionConstraints,
    externalEvidenceRoots: params.externalEvidenceRoots ?? [],
    criteriaAuthority: {
      ownerCriteria: intake.ownerCriteria,
      supervisorAddedConstraints: intake.supervisorAddedConstraints,
      plannerInferredPresentationRules: intake.plannerInferredPresentationRules,
    },
  });
  params.externalEvidenceRoots = mission.externalEvidenceRoots ?? [];
  const newRunId = dispatchContext.resumeState?.state.runId ?? `orc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const store = new SupervisionStateStore(newRunId);
  if (existsSync(store.stateFile)) {
    throw new Error(`SUPERVISION_RUN_ALREADY_BOUND: ${newRunId}; use action=inspect/continue rather than replaying action=run.`);
  }
  let state = createInitialSupervisionState({ runId: newRunId, mission, tasks: [] });
  const contentBaseline = captureContentSignatureSnapshot(cwd);
  state.runtime = createGenericSupervisionRuntime({
    identity: dispatchContext.identity,
    cursor: createGenericSupervisionCursor(dispatchContext.identity, { stage: "plan" }),
    params: JSON.parse(JSON.stringify({ ...raw, task: params.task, cwd, supervision: "visible-main", action: "run" })),
    intake,
    plan: { tasks: [], notes: "planning", predictedWriteSet: params.predictedWriteSet, externalEvidenceRoots: params.externalEvidenceRoots },
    completedTaskIds: [],
    executorOutputs: [],
    contentBaseline,
    approvedScopeBaseline: params.predictedWriteSet?.length && params.predictedWriteSet.every(entry => !/[*?\[\]{}]/.test(entry))
      ? captureContentSignatureSnapshot(cwd, { scope: params.predictedWriteSet }) : undefined,
    externalEvidenceBaseline: captureExternalEvidenceSnapshot(params.externalEvidenceRoots),
    acceptedGitBaseline: baseline,
    repairCount: 0,
    hostInstanceId: SUPERVISION_HOST_INSTANCE,
    adapterState: {
      classification: shapeRegistry.get(paradigm)?.execution?.classification ?? dispatchContext.resolvedDynamicWorkflow?.execution.classification ?? "executor-bearing",
      ...(dispatchContext.resumeState ? { historicalRunId: dispatchContext.resumeState.state.runId } : {}),
    },
  });
  store.create(state); // mission, protocol and owning host are atomic before any worker spawn
  // A previously bound historical cursor may already be ahead of "plan"; do
  // not move it backwards while reconstructing the shape-neutral plan.
  if (!dispatchContext.resumeState?.state.supervision) syncHistoricalSupervisionBinding(state);
  let preflightInProgress = false;
  try {
    if (params.preflight) {
      preflightInProgress = true;
      await withWorkerExecutionConstraints(params.workerExecutionConstraints, () =>
        withSubagentPhaseLogging(newRunId, () => runProviderPreflight(params, agents, undefined, signal, emit)));
      preflightInProgress = false;
    }
    const internal = lifecycleState(params, newRunId); internal.intake = intake;
    const deterministic = buildDeterministicSupervisionPlan(dispatchContext, params.task, criteria, params.predictedWriteSet);
    let parsedPlan: Plan;
    let tasks: CriterionTask[];
    let completedTaskIds: string[];
    let adapterState: Record<string, unknown>;
    let plannerObservation: ObservedMissionRoute | undefined;
    let plannerPathReferenceAdvisories: PlannerPathReferenceAdvisory[] = [];
    if (deterministic) {
      tasks = deterministic.tasks;
      completedTaskIds = deterministic.completedTaskIds;
      adapterState = deterministic.adapterState;
      parsedPlan = { tasks: tasks.map(({ id, description, dependsOn }) => ({ id, description, dependsOn })), notes: deterministic.notes, predictedWriteSet: params.predictedWriteSet, externalEvidenceRoots: params.externalEvidenceRoots };
    } else {
      const adaptivePlanningRule = params.adaptiveSupervision === "enforce-canary-v1"
        ? "\nADAPTIVE ENFORCE CANARY: return exactly one bounded plan task. The same frozen task will undergo real A,A,model-B,B execution after the single initial visible-main approval.\n"
        : params.adaptiveSupervision === "adaptive-v1"
          ? "\nADAPTIVE PRODUCTION V1: return exactly one coherent bounded plan task covering every frozen acceptance criterion. This real task is Strategy A; after two equivalent no-information failures the host may durably activate a legal model-authored Strategy B in the same run without a second approval.\n"
          : "";
      const planner = await spawnChecked(internal, params, agents, params.plannerAgent, buildPlanningPrompt(intake, 1, [], [], params.predictedWriteSet, params.externalEvidenceRoots) + adaptivePlanningRule, signal, emit, undefined, toModelOverride(params.plannerModel, params.plannerProvider), undefined, false, false, "planner");
      plannerObservation = observedRouteFromResult("planner", planner);
      parsedPlan = parsePlan(planner.text, params.task);
      parsedPlan.externalEvidenceRoots = validatePlannedExternalEvidenceRoots(parsedPlan.externalEvidenceRoots, mission);
      try {
        assertPlannerPreservesDeliverables(intake.deliverables, parsedPlan);
      } catch (error) {
        throw new Error(`SUPERVISED_PLAN_REJECTED: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!params.predictedWriteSet) {
        const classifiedPaths = classifyPlannerPathReferences({
          paths: parsedPlan.predictedWriteSet,
          readOnlyInputs: parsedPlan.readOnlyInputs,
          taskText: params.task,
          plan: parsedPlan,
          lane: mission.lane,
          cwd,
          worktree: mission.worktree,
        });
        parsedPlan.predictedWriteSet = classifiedPaths.writePaths;
        plannerPathReferenceAdvisories = classifiedPaths.advisories;
      }
      const scope = params.predictedWriteSet ?? parsedPlan.predictedWriteSet;
      if (parsedPlan.tasks.some((task) => task.expectsFileChange === true) && !scope?.length) {
        throw new Error("SUPERVISED_PLAN_REJECTED: implementation plan omitted a bounded predicted write set.");
      }
      tasks = parsedPlan.tasks.map((task, index) => ({ ...task, criteria: [criteria[index % criteria.length].id], predictedWriteSet: scope }));
      for (let index = 0; index < criteria.length; index += 1) if (!tasks.some((task) => task.criteria.includes(criteria[index].id))) tasks[index % tasks.length].criteria.push(criteria[index].id);
      completedTaskIds = [];
      adapterState = { classification: shapeRegistry.get(paradigm)?.execution?.classification ?? "executor-bearing" };
    }
    const frozenProductCriteria = criteria.map((criterion) => criterion.text);
    const emittedProductCriteria = parsedPlan.acceptanceCriteria?.filter((criterion) => !isHostOrchestrationRequirement(criterion)) ?? [];
    const plannerCriteriaAdvisories = deterministic
      ? []
      : emittedProductCriteria.length === 0
        ? [{ code: "planner_acceptance_criteria_derived", message: "Planner emitted no product acceptance criteria; the host retained the numbered/task-derived frozen criteria.", advisory: true as const }]
        : JSON.stringify(emittedProductCriteria) === JSON.stringify(frozenProductCriteria)
          ? []
          : [{ code: "planner_acceptance_criteria_mismatch", message: "Planner acceptance criteria differed from task-derived frozen criteria; the host retained the frozen product authority.", advisory: true as const }];
    parsedPlan.acceptanceCriteria = frozenProductCriteria;
    const scope = params.predictedWriteSet ?? parsedPlan.predictedWriteSet;
    const planIssues = validateCriterionTaskPlan(tasks, mission, { allowedWriteSet: params.predictedWriteSet, cwd, approvedTaskIds: tasks.map((task) => task.id) });
    const laneIssues = checkLanePaths({ lane: mission.lane, cwd, worktree: mission.worktree, paths: scope ?? [], allowedWriteSet: scope });
    if (planIssues.length || laneIssues.length) throw new Error(`SUPERVISED_PLAN_REJECTED: ${[...planIssues.map((issue) => issue.message), ...laneIssues.map((issue) => issue.message)].join("; ")}`);
    const firstIncomplete = tasks.findIndex((task) => !completedTaskIds.includes(task.id));
    const nextTaskIndex = firstIncomplete < 0 ? tasks.length : firstIncomplete;
    const runtime = requireGenericRuntime(state);
    runtime.plan = { tasks, notes: parsedPlan.notes, predictedWriteSet: scope, externalEvidenceRoots: params.externalEvidenceRoots, acceptanceCriteria: frozenProductCriteria };
    runtime.adapterState = { ...adapterState, commandTimes: getCommandTimesForRun(state.runId) };
    const planRouteObservations = appendRouteObservations(runtime, [plannerObservation]);
    runtime.executorOutputs = dispatchContext.resumeState
      ? [...dispatchContext.resumeState.checkpoints.entries()].map(([index, result]) => ({
          taskId: `historical-${index}`,
          description: tasks.find((task) => task.id === `historical-${index}`)?.description ?? `Restored historical phase ${index}`,
          agentName: result.agentName,
          output: result.text,
          stderr: result.stderr || undefined,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          toolCalls: result.toolCalls,
          actionEvidence: result.actionEvidence,
          commandTimes: result.commandTimes,
          provider: result.provider,
          model: result.model,
        }))
      : [];
    state.tasks = tasks;
    state.approvedTaskIds = tasks.map((task) => task.id);
    updateGenericCursor(state, {
      stage: nextTaskIndex < tasks.length ? "executor-task" : "verifier",
      nextTaskIndex,
      completedTaskIds,
      currentTaskId: undefined,
    });
    if (params.adaptiveSupervision === "shadow-v1") {
      try {
        initializeAdaptiveShadow(state, runtime);
      } catch (error) {
        // Shadow telemetry has no execution authority: even journal failure
        // cannot cancel, replan, delay, or otherwise alter ordinary dispatch.
        runtime.adapterState = {
          ...(runtime.adapterState ?? {}),
          adaptiveSupervision: {
            mode: "shadow-v1",
            controlledExecution: false,
            records: 0,
            observationError: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } else if (params.adaptiveSupervision === "enforce-canary-v1") {
      runtime.adapterState = {
        ...(runtime.adapterState ?? {}),
        adaptiveSupervision: { mode: "enforce-canary-v1", phase: "awaiting_initial_visible_main_approval", approvalCount: 1 },
      };
    } else if (params.adaptiveSupervision === "adaptive-v1") {
      if (tasks.length !== 1) throw new Error("ADAPTIVE_PRODUCTION_V1_REQUIRES_ONE_COHERENT_PLAN_TASK");
      runtime.adapterState = {
        ...(runtime.adapterState ?? {}),
        adaptiveSupervision: { mode: "adaptive-v1", phase: "awaiting_initial_visible_main_approval", approvalCount: 1 },
      };
    }
    const numericTargetCoverage = criteria
      .filter((criterion) => criterion.numericTarget)
      .map((criterion) => ({
        criterionId: criterion.id,
        target: criterion.numericTarget,
        evaluation: criterion.numericGate
          ? { kind: "host_numeric_gate", gate: criterion.numericGate }
          : { kind: "unavailable", ...criterion.numericEvaluationUnavailable },
      }));
    store.save(state);
    state = store.appendCheckpoint(state, { kind: "plan", createdAt: new Date().toISOString(), missionHash: mission.missionHash, criteria: criteria.map((criterion) => criterion.id), effectChanges: [], outcome: "plan_ready" }, { mission, intake, plan: runtime.plan, declaredPlan: { tasks: parsedPlan.tasks, predictedWriteSet: parsedPlan.predictedWriteSet, notes: parsedPlan.notes }, routes: mission.routes, routeObservations: planRouteObservations, plannerCriteriaAdvisories, plannerPathReferenceAdvisories, numericTargetCoverage, effectsBaseline: contentBaseline, protocol: runtime.identity, cursor: runtime.cursor });
    updateGenericCursor(state, { lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id });
    state = transitionSupervisionState(state, "awaiting_supervisor"); store.save(state);
    const automaticDecision = raw.automaticPlanApproval === true
      ? checkAutomaticPlanApproval({ ...state, tasks: state.tasks.map(task => ({ ...task,
          predictedWriteSet: parsedPlan.predictedWriteSet,
        })) }, { allowedWriteSet: params.predictedWriteSet })
      : undefined;
    if (automaticDecision && !deterministic && (!parsedPlan.raw || typeof parsedPlan.raw !== "object")) {
      automaticDecision.approved = false;
      automaticDecision.reasons.push("plan genuinely missing: planner did not supply a structured task plan");
    }
    if (automaticDecision && !automaticDecision.approved) {
      state.pauseReason = `automatic_plan_approval_refused: ${automaticDecision.reasons.join("; ")}`;
      store.save(state);
    }
    const approved = issueCheckpointApproval(store, state);
    if (automaticDecision?.approved) {
      approved.state.automaticPlanApprovals = [...(approved.state.automaticPlanApprovals ?? []), {
        authority: "fixed-host-checks", checkpointId: approved.state.checkpoints.at(-1)!.id,
        approvedAt: new Date().toISOString(), scope: [...(params.predictedWriteSet ?? [])],
      }];
      store.save(approved.state);
      return await runVisibleMainLifecycle({action: "continue", runId: state.runId, approvalToken: approved.token}, "continue", signal, onUpdate, ctx, dispatchContext, settlementControl);
    }
    return lifecycleResult(approved.state, approved.token, { plan: runtime.plan, protocol: runtime.identity, cursor: runtime.cursor, numericTargetCoverage, automaticPlanApproval: { enabled: raw.automaticPlanApproval === true, decision: automaticDecision }, audit: { missionHash: mission.missionHash, lane: mission.lane, routes: mission.routes } });
  } catch (error) {
    if (preflightInProgress && state.audit.activeWorkers.length === 0 && state.audit.detachedWorkers.length === 0) {
      const persisted = appendZeroWorkerPreflightAbort(store, state, error);
      return lifecycleResult(persisted.state, undefined, {
        error: persisted.error,
        preflightAbort: persisted.preflightAbort,
      });
    }
    const classified = classifyInfrastructureFailure(error);
    state.audit.infrastructureFailures.push(classified);
    state = transitionSupervisionState(state, classified.infrastructure ? "blocked_infrastructure" : "cancelled");
    store.save(state);
    return lifecycleResult(state, undefined, { error: classified });
  }
}


function copyOptionalStringParams(source: Record<string, unknown>, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) result[key] = value.trim();
  }
  return result;
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
  const lifecycleActions = new Set(["run", "inspect", "continue", "accept", "pause", "cancel"]);

  // Clear positional forms are accepted without conflating the historical
  // abort-survivor resume API with visible-main continuation:
  //   /orchestrate inspect --run-id <id>
  //   /orchestrate resume <legacy-run-id>
  let startIndex = 0;
  if (tokens[0] === "resume") {
    if (!tokens[1] || tokens[1].startsWith("--")) throw new Error("resume requires a legacy abort-survivor run id.");
    params.resume = tokens[1];
    startIndex = 2;
  } else if (lifecycleActions.has(tokens[0] ?? "")) {
    params.action = tokens[0];
    startIndex = 1;
  }

  const setAction = (action: string): void => {
    if (params.action !== undefined && params.action !== action) {
      throw new Error(`Conflicting lifecycle actions: ${String(params.action)} and ${action}.`);
    }
    params.action = action;
  };

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

  for (let i = startIndex; i < tokens.length; i++) {
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
    if (normalized === "discoveryOnly" || normalized === "discovery") {
      params.discoveryOnly = true;
      continue;
    }
    if (normalized === "noForceKill") {
      if (inlineValue !== undefined) throw new Error(`--${flag} does not take a value.`);
      params.noForceKill = true;
      continue;
    }
    if (lifecycleActions.has(normalized)) {
      if (inlineValue !== undefined) throw new Error(`--${flag} does not take a value.`);
      setAction(normalized);
      continue;
    }
    if (normalized === "visibleMain" || normalized === "off") {
      if (inlineValue !== undefined) throw new Error(`--${flag} does not take a value.`);
      params.supervision = normalized === "visibleMain" ? "visible-main" : "off";
      continue;
    }
    if (normalized === "product" || normalized === "orchestratorMaintenance") {
      if (inlineValue !== undefined) throw new Error(`--${flag} does not take a value.`);
      params.lane = normalized === "product" ? "product" : "orchestrator-maintenance";
      continue;
    }

    const { value, nextIndex } = takeValue(i, `--${flag}`, inlineValue);
    i = nextIndex;
    switch (normalized) {
      case "action":
        if (!lifecycleActions.has(value)) throw new Error(`--${flag} must be run, inspect, continue, accept, pause, or cancel.`);
        setAction(value);
        break;
      case "runId":
        params.runId = value;
        break;
      case "approvalToken":
      case "token":
        params.approvalToken = value;
        break;
      case "reason":
        params.reason = value;
        break;
      case "supervision":
        if (value !== "visible-main" && value !== "off") throw new Error(`--${flag} must be visible-main or off.`);
        params.supervision = value;
        break;
      case "adaptiveSupervision":
        if (!new Set(["off", "shadow-v1", "enforce-canary-v1", "adaptive-v1"]).has(value)) {
          throw new Error(`--${flag} must be off, shadow-v1, enforce-canary-v1, or adaptive-v1.`);
        }
        params.adaptiveSupervision = value;
        break;
      case "lane":
        if (value !== "product" && value !== "orchestrator-maintenance") throw new Error(`--${flag} must be product or orchestrator-maintenance.`);
        params.lane = value;
        break;
      case "resume":
        if (params.action !== undefined) throw new Error("Legacy --resume is distinct from visible-main --action/--run-id controls.");
        params.resume = value;
        break;
      case "maxSubagents":
        params.maxSubagents = parseNumberFlag(`--${flag}`, value);
        break;
      case "maxRetries":
        params.maxRetries = parseNumberFlag(`--${flag}`, value);
        break;
      case "concurrency":
        params.concurrency = parseNumberFlag(`--${flag}`, value);
        break;
      case "executorConcurrency":
        params.executorConcurrency = parseNumberFlag(`--${flag}`, value);
        break;
      case "executorCount":
        params.executorCount = parseNumberFlag(`--${flag}`, value);
        break;
      case "plannerCount":
      case "plannerConcurrency":
        params.plannerCount = parseNumberFlag(`--${flag}`, value);
        break;
      case "verifierCount":
      case "verifierConcurrency":
        params.verifierCount = parseNumberFlag(`--${flag}`, value);
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
      case "automaticPlanApproval":
        if (value !== "on" && value !== "off") throw new Error("--automatic-plan-approval requires on or off");
        params.automaticPlanApproval = value === "on";
        break;
      case "paradigm":
        params.paradigm = value;
        break;
      case "hardGates":
        params.hardGates = value;
        break;
      case "writeSet":
      case "predictedWriteSet":
        params.predictedWriteSet = value;
        break;
      case "externalEvidenceRoots":
      case "evidenceRoots":
        params.externalEvidenceRoots = parseWriteSetInput(value);
        break;
      case "numericGates":
      case "numericAcceptanceGates":
        try {
          params.numericAcceptanceGates = JSON.parse(value) as unknown;
        } catch {
          throw new Error(`--${flag} requires a JSON array.`);
        }
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
        throw new Error(`Unknown flag --${flag}. Supported lifecycle flags: --action, --run/--inspect/--continue/--accept/--pause/--cancel, --run-id, --approval-token/--token, --reason, --supervision/--visible-main/--off, --adaptive-supervision off|shadow-v1|enforce-canary-v1|adaptive-v1, --lane/--product/--orchestrator-maintenance, and distinct legacy --resume. Existing run flags remain supported: --max-subagents, --max-retries, --concurrency, --executor-concurrency, --executor-count, --planner-count, --planner-concurrency, --verifier-count, --verifier-concurrency, --planner-agent, --executor-agent, --verifier-agent, --cwd, --allow-local-model, --paradigm, --hard-gates, --write-set, --external-evidence-roots, --numeric-gates JSON, --discovery-only, --no-force-kill, --preflight/--no-preflight, role model/provider flags, and role fallback flags.`);
    }
  }

  const task = taskParts.join(" ").trim();
  const action = String(params.action ?? "run");
  if (action === "accept" && (typeof params.reason !== "string" || !params.reason.trim())) {
    throw new Error("Lifecycle action accept requires --reason with non-empty text.");
  }
  if (action !== "accept" && params.reason !== undefined) throw new Error("--reason is valid only with lifecycle action accept.");
  if (action !== "run" && task) throw new Error(`Lifecycle action ${action} does not accept task text.`);
  if (params.resume !== undefined && task) throw new Error("Legacy resume does not accept new task text; it restores the frozen historical task.");
  if (params.resume !== undefined && params.action !== undefined) throw new Error("Legacy resume is distinct from visible-main lifecycle actions.");
  if (task) params.task = task;
  return params;
}

export function parseOrchestrateCommandArgsForTest(args: string): Record<string, unknown> {
  return parseOrchestrateCommandArgs(args);
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

function normalizePublicAdaptiveSupervisionMode(value: unknown): PublicAdaptiveSupervisionMode {
  if (value === undefined || value === "off") return "off";
  if (value === "shadow-v1" || value === "enforce-canary-v1" || value === "adaptive-v1") return value;
  throw new Error("adaptiveSupervision must be off, shadow-v1, enforce-canary-v1, or adaptive-v1.");
}

function assertBoundedAdaptiveInvocation(
  params: NormalizedParams,
  paradigm: string,
  raw: Record<string, unknown>,
): void {
  if (params.adaptiveSupervision === "off") return;
  if (paradigm !== "plan-execute-verify") {
    throw new Error(`ADAPTIVE_SUPERVISION_UNSUPPORTED_PARADIGM: ${params.adaptiveSupervision} is bounded to plan-execute-verify; no preflight or worker was started.`);
  }
  if (params.supervision !== "visible-main") {
    throw new Error(`ADAPTIVE_SUPERVISION_REQUIRES_VISIBLE_MAIN: ${params.adaptiveSupervision} cannot run with supervision=off; no preflight or worker was started.`);
  }
  if (raw.resume !== undefined || params.discoveryOnly) {
    throw new Error(`ADAPTIVE_SUPERVISION_BOUNDED_RUN_ONLY: ${params.adaptiveSupervision} does not support legacy resume or discovery-only execution; no preflight or worker was started.`);
  }
  const requiredAdaptiveSubagents = params.adaptiveSupervision === "adaptive-v1" ? 7 : 6;
  if ((params.adaptiveSupervision === "enforce-canary-v1" || params.adaptiveSupervision === "adaptive-v1") && params.maxSubagents < requiredAdaptiveSubagents) {
    throw new Error(`ADAPTIVE_SUPERVISION_SUBAGENT_BUDGET_TOO_SMALL: ${params.adaptiveSupervision} requires maxSubagents >= ${requiredAdaptiveSubagents} so its bounded planner/executor/verifier sequence${params.adaptiveSupervision === "adaptive-v1" ? " and sole proposal schema-repair retry" : ""} remain available; no preflight or worker was started.`);
  }
  if ((params.adaptiveSupervision === "enforce-canary-v1" || params.adaptiveSupervision === "adaptive-v1") && params.predictedWriteSet?.some((entry) => /[*?\[\]]/.test(entry))) {
    throw new Error("ADAPTIVE_SUPERVISION_GLOB_WRITE_SET_UNSUPPORTED: use exact files or directory prefixes; no preflight or worker was started.");
  }
}

function normalizeExternalEvidenceRootBindings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = parseWriteSetInput(value);
  if (!parsed?.length) return [];
  if (parsed.length > 32) throw new Error("externalEvidenceRoots must contain at most 32 roots.");
  return parsed;
}

function normalizeNumericAcceptanceGateBindings(value: unknown): Array<NumericAcceptanceGate & { criterionId: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("numericAcceptanceGates must be an array of at most 100 criterion-bound gates.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`numericAcceptanceGates[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.criterionId !== "string" || !/^AC-\d{2,}$/.test(record.criterionId)) {
      throw new Error(`numericAcceptanceGates[${index}].criterionId must be a stable AC-nn id.`);
    }
    if (seen.has(record.criterionId)) throw new Error(`Duplicate numeric acceptance gate for ${record.criterionId}.`);
    seen.add(record.criterionId);
    const { criterionId, ...gate } = record;
    return { criterionId, ...(gate as unknown as NumericAcceptanceGate) };
  });
}

function normalizeParams(params: Record<string, unknown>, defaultCwd: string): NormalizedParams {
  const task = String(params.task ?? "").trim();
  if (!task) throw new Error("orchestrate requires a non-empty task.");
  const inferredRoutingRaw = inferModelRoutingFromTask(task);
  const orchestrationControls = inferOrchestrationControlsFromTask(task, params, inferredRoutingRaw);

  // BUG FIX (2026-07-02, natural-language-route-parser-hijacks-roles-from-task-prose.md):
  // When ANY explicit route param is present for a role, natural-language route
  // extraction is fully SUPPRESSED for that role — explicit params always win,
  // and prose can never fill the un-set side of an explicitly-routed role.
  //
  // The suppression is applied ONCE here and stored on NormalizedParams
  // (`inferredRouting`) so buildRoutingRequirements and the shape context reuse
  // the SAME filtered object. Previously buildRoutingRequirements re-ran
  // inferModelRoutingFromTask and could recombine a suppressed NL model with an
  // explicit provider-only override (e.g. executorProvider set + prose model),
  // producing a false routing requirement / 404 preflight.
  const plannerExplicit = optionalString(params.plannerModel) !== undefined || optionalString(params.plannerProvider) !== undefined;
  const executorExplicit = optionalString(params.executorModel) !== undefined || optionalString(params.executorProvider) !== undefined;
  const verifierExplicit = optionalString(params.verifierModel) !== undefined || optionalString(params.verifierProvider) !== undefined;
  const inferredRouting: InferredModelRouting = {
    ...inferredRoutingRaw,
    planner: plannerExplicit ? undefined : inferredRoutingRaw.planner,
    executor: executorExplicit ? undefined : inferredRoutingRaw.executor,
    verifier: verifierExplicit ? undefined : inferredRoutingRaw.verifier,
  };
  const nlPlanner = inferredRouting.planner;
  const nlExecutor = inferredRouting.executor;
  const nlVerifier = inferredRouting.verifier;

  return {
    task,
    plannerAgent: stringParam(params.plannerAgent, "planner"),
    executorAgent: stringParam(params.executorAgent, "coder"),
    verifierAgent: stringParam(params.verifierAgent, "reviewer"),
    concurrency: clampInt(params.executorConcurrency ?? params.executorCount ?? params.concurrency ?? orchestrationControls.executorConcurrency ?? orchestrationControls.executorCount ?? orchestrationControls.concurrency, 2, 1, 16),
    plannerCount: clampInt(params.plannerCount ?? orchestrationControls.plannerCount, 1, 1, 16),
    verifierCount: clampInt(params.verifierCount ?? orchestrationControls.verifierCount, 1, 1, 16),
    maxRetries: clampInt(params.maxRetries ?? orchestrationControls.maxRetries ?? (orchestrationControls.maxAttempts !== undefined ? orchestrationControls.maxAttempts - 1 : undefined), 2, 0, 5),
    maxRetriesExplicit: params.maxRetries !== undefined || orchestrationControls.maxAttempts !== undefined || orchestrationControls.maxRetries !== undefined,
    maxSubagents: clampInt(params.maxSubagents ?? orchestrationControls.maxSubagents, DEFAULT_MAX_SUBAGENTS, 3, MAX_SUBAGENTS_LIMIT),
    maxSubagentsExplicit: params.maxSubagents !== undefined || orchestrationControls.maxSubagents !== undefined,
    cwd: stringParam(params.cwd, defaultCwd),
    allowLocalModel: typeof params.allowLocalModel === "boolean" ? params.allowLocalModel : false,
    plannerModel: optionalString(params.plannerModel) ?? nlPlanner?.model,
    plannerProvider: optionalString(params.plannerProvider) ?? nlPlanner?.provider,
    executorModel: optionalString(params.executorModel) ?? nlExecutor?.model,
    executorProvider: optionalString(params.executorProvider) ?? nlExecutor?.provider,
    verifierModel: optionalString(params.verifierModel) ?? nlVerifier?.model,
    verifierProvider: optionalString(params.verifierProvider) ?? nlVerifier?.provider,
    orchestrationControls,
    inferredRouting,
    paradigm: typeof params.paradigm === "string" ? params.paradigm : undefined,
    supervision: params.supervision === "off" ? "off" : "visible-main",
    adaptiveSupervision: normalizePublicAdaptiveSupervisionMode(params.adaptiveSupervision),
    hardGates: normalizeHardGatesMode(params.hardGates),
    predictedWriteSet: parseWriteSetInput(params.predictedWriteSet),
    externalEvidenceRoots: normalizeExternalEvidenceRootBindings(params.externalEvidenceRoots),
    numericAcceptanceGates: normalizeNumericAcceptanceGateBindings(params.numericAcceptanceGates),
    discoveryOnly: typeof params.discoveryOnly === "boolean" ? params.discoveryOnly : false,
    preflight: typeof params.preflight === "boolean" ? params.preflight : true,
    workerExecutionConstraints: {
      noForceKill: params.noForceKill === true
        || Boolean(params.workerExecutionConstraints && typeof params.workerExecutionConstraints === "object"
          && (params.workerExecutionConstraints as Record<string, unknown>).noForceKill === true),
      ...(params.workerExecutionConstraints && typeof params.workerExecutionConstraints === "object"
        && (params.workerExecutionConstraints as Record<string, unknown>).testAuthorization
        ? { testAuthorization: JSON.parse(JSON.stringify((params.workerExecutionConstraints as Record<string, unknown>).testAuthorization)) }
        : {}),
    },
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
  resumeState?: LoadedRunState,
  pinnedDynamicResolution?: ResolvedDynamicWorkflow,
) {
  const agents = await loadAgents();
  // Named orchestration roles resolve from their agent profile and the current
  // Pi default route. They must not silently inherit the conversational model.
  resolveConfiguredRoleDefaults(params, agents);
  inheritedModel = undefined;
  const evidenceWorktreeRoot = gitText(params.cwd, ["rev-parse", "--show-toplevel"]) ?? path.resolve(params.cwd);
  let evidenceWorktreeRealRoot = evidenceWorktreeRoot;
  try { evidenceWorktreeRealRoot = realpathSync.native(evidenceWorktreeRoot); } catch { /* validation reports invalid roots when any were requested */ }
  params.externalEvidenceRoots = canonicalizeExternalEvidenceRoots({
    cwd: params.cwd,
    worktreeRoot: evidenceWorktreeRoot,
    worktreeRealRoot: evidenceWorktreeRealRoot,
    roots: params.externalEvidenceRoots ?? [],
    protectedRoots: defaultProtectedRoots(),
  });

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
    runId: resumeState?.state.runId ?? `orc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
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

  // Dual-plan owns fixed, role-safe routes, but uses the shared preflight. Put
  // those defaults on normalized params before preflight so the health checks
  // cover the exact routes the five shape seats will spawn (rather than named
  // profile/Pi defaults). Keep gpt-5.5 as the executor's safe fallback unless
  // the caller supplied a fallback chain explicitly.
  if (paradigm === "dual-plan-synthesis-execute-verify") {
    params.plannerProvider ??= "openai-codex";
    params.plannerModel ??= "gpt-5.6-sol";
    params.executorProvider ??= "openai-codex";
    params.executorModel ??= "gpt-5.6-sol";
    params.verifierProvider ??= "openai-codex";
    params.verifierModel ??= "gpt-5.5";
    if (!params.executorFallbackProvider && !params.executorFallbackModel) {
      params.executorFallbackProvider = "openai-codex";
      params.executorFallbackModel = "gpt-5.5";
    }
  }

  const shapeOwnsPreflight = paradigm === "composable-pipeline";
  let resolvedDynamicWorkflow: ResolvedDynamicWorkflow | undefined = pinnedDynamicResolution;
  if (!shapeRegistry.has(paradigm) && !resolvedDynamicWorkflow) {
    // Invocation-time resolution is deliberately uncached: a workflow created
    // earlier in this same Pi process is immediately visible without reload.
    // Resume never re-reads mutable source; it validates and uses the exact
    // snapshot pinned in the original run state.
    resolvedDynamicWorkflow = resumeState
      ? resolvePinnedDynamicWorkflow(
          resumeState.state.dynamicWorkflow,
          paradigm,
          NATIVE_SHAPE_NAMES,
        )
      : resolveDynamicWorkflow(paradigm, {
          cwd: params.cwd,
          nativeNames: NATIVE_SHAPE_NAMES,
        });
  }
  const execution = shapeRegistry.get(paradigm)?.execution ?? resolvedDynamicWorkflow?.execution;
  const dispatch = resolveShapeDispatch(execution, params.supervision);
  if (dispatch.disposition === "fail-closed") {
    throw new Error(`SHAPE_EXECUTION_CONTRACT_REFUSED: ${paradigm} ${dispatch.reason}; no preflight or worker was started.`);
  }
  const deterministicReadOnlyInvocation = isDeterministicReadOnlyInvocation(
    params,
    paradigm,
    resolvedDynamicWorkflow,
  );
  if (dispatch.disposition === "supervised" && !deterministicReadOnlyInvocation) {
    throw new Error(
      `VISIBLE_SUPERVISION_DISPATCH_REQUIRED: ${paradigm} advertises ` +
        `${dispatch.identity.protocolId}/${dispatch.identity.adapterId}; no preflight or worker was started.`,
    );
  }
  emit(`Run ${state.runId}: paradigm=${paradigm}, hardGates=${params.hardGates}, preflight=${params.preflight}.`);
  const plannerSelected = resolveNamedRoleRoute(agents, params.plannerAgent, params.plannerModel, params.plannerProvider);
  const executorSelected = resolveNamedRoleRoute(agents, params.executorAgent, params.executorModel, params.executorProvider);
  const verifierSelected = resolveNamedRoleRoute(agents, params.verifierAgent, params.verifierModel, params.verifierProvider);
  if (shapeOwnsPreflight) {
    emit("Composable pipeline will resolve and report role-safe routes; named agent-profile routes are non-authoritative.");
  } else {
    emit(
      `Selected routes before preflight: planner=${formatRoutedModel(plannerSelected.provider, plannerSelected.model)}, ` +
        `executor=${formatRoutedModel(executorSelected.provider, executorSelected.model)}, ` +
        `verifier=${formatRoutedModel(verifierSelected.provider, verifierSelected.model)}.`,
    );
  }

  if (paradigm === "plan-execute-verify") {
    const terminalResume = firstPevTerminalNoRetry(resumeState);
    if (terminalResume) {
      state.intake = buildIntake(params, agents, inheritedModel);
      state.attempt = attemptFromTerminalPhase(terminalResume) ?? 0;
      emit(
        `RESUME of run ${state.runId}: terminal no-retry state ${terminalResume.code} already persisted; ` +
          `returning without planner/executor/verifier respawn.`,
      );
      return finalizePevTerminalResult(params, state, terminalResume);
    }
  }

  let preflightInProgress = false;
  try {
  if (paradigm === "dual-plan-synthesis-execute-verify") {
    const configuredRoutes = [
      params.plannerProvider, params.plannerModel,
      params.executorProvider, params.executorModel,
      params.verifierProvider, params.verifierModel,
      params.plannerFallbackProvider, params.plannerFallbackModel,
      params.executorFallbackProvider, params.executorFallbackModel,
      params.verifierFallbackProvider, params.verifierFallbackModel,
    ].filter((value): value is string => Boolean(value));
    const forbidden = configuredRoutes.find((value) => /deepseek|openrouter/i.test(value));
    if (forbidden) {
      throw new Error(
        `FORBIDDEN_DUAL_PLAN_ROUTE: provider/model route "${forbidden}" is not permitted for this native shape.`,
      );
    }
  }

  // ── Pre-flight provider health checks (F5) ──────────────────────────
  const deterministicDynamicCanary = Boolean(resolvedDynamicWorkflow) && params.task.trim() === "SHAPE_CANARY";
  // composable-pipeline owns role-safe route resolution because its composed
  // planner seats do not map one-to-one to named agent profiles. Let the shape
  // reject forbidden routes and preflight every actually-used role before any
  // work spawn; generic named-profile preflight would ping the wrong route.
  if (params.preflight && !deterministicDynamicCanary && !shapeOwnsPreflight) {
    preflightInProgress = true;
    await withWorkerExecutionConstraints(params.workerExecutionConstraints, () =>
      withSubagentPhaseLogging(state.runId, () => runProviderPreflight(params, agents, inheritedModel, signal, emit)));
    preflightInProgress = false;
  } else if (shapeOwnsPreflight && params.preflight) {
    emit("Preflight delegated to composable-pipeline role-safe route resolution.");
  } else if (deterministicDynamicCanary && params.preflight) {
    emit("Dynamic workflow canary: skipping provider preflight to preserve the deterministic zero-process contract.");
  }

  // ── Shape-based orchestration dispatch ────────────────────────────────
  if (paradigm !== "plan-execute-verify") {
    const shape = shapeRegistry.get(paradigm);
    if (!shape && !resolvedDynamicWorkflow) {
      throw new Error(
        `Unknown orchestration paradigm "${paradigm}". Available paradigms: ${[...shapeRegistry.keys()].join(", ")}. ` +
          `No ${paradigm}.workflow.json artifact was found in the trusted project or user workflow roots.`,
      );
    }

    // Reuse the suppressed routing from normalizeParams so shapes never see an
    // NL route for a role that carried an explicit override param.
    const inferredModelRouting = params.inferredRouting ?? inferModelRoutingFromTask(params.task);
    const context: OrchestrationShapeContext = {
      params,
      signal,
      onUpdate,
      inheritedModel,
      agents,
      inferredModelRouting,
      runId: state.runId,
      resumeState,
    };

    const emitShape = (text: string) => {
      onUpdate?.({ content: [{ type: "text", text }] });
    };
    if (resumeState) {
      emitShape(`[orchestrate] RESUME of run ${resumeState.state.runId}: ` +
        `${resumeState.state.phases.filter((p) => p.status === "done").length} phase(s) checkpointed, ` +
        `${resumeState.state.phases.filter((p) => p.status === "detached").length} detached survivor(s).`);
    }
    emitShape(`[orchestrate] Dispatching to "${paradigm}" shape…`);

    const result: OrchestrationShapeResult = await withWorkerExecutionConstraints(params.workerExecutionConstraints, () =>
      withSubagentPhaseLogging(state.runId, () => resolvedDynamicWorkflow
        ? runDynamicWorkflow(resolvedDynamicWorkflow, context)
        : shape!.run(context)));
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

  // ── Checkpoint/resume wiring (ABORT-RESUME-DESIGN.md) ───────────────────
  // Phases are NAME-keyed so the executor phase can be split PER TASK
  // (attempt-N-executor-<taskId>), each spawned in abort-survivor mode and each
  // checkpointed with its resolved provider/model. Planner and verifier remain
  // single per-attempt phases (attempt-N-planner / attempt-N-verifier). Phase
  // indices are allocated deterministically in first-touch order; on resume they
  // are recovered by NAME from the persisted state.json so they line up with the
  // checkpoints/survivors already on disk (even the pre-any-phase abort edge,
  // production run orc-mr3x90b5-00iz). On resume, completed phases are RESTORED
  // (not re-spawned) and a detached survivor is re-attached via bounded polling.
  const pevStore = resumeState
    ? RunStateStore.open(resumeState.state.runId)
    : RunStateStore.create(state.runId, "plan-execute-verify", params.task, JSON.parse(JSON.stringify(params)) as Record<string, unknown>, []);
  const pevPhaseIndex = new Map<string, number>();
  let pevNextIndex = 0;
  for (const phase of resumeState?.state.phases ?? []) {
    pevPhaseIndex.set(phase.name, phase.index);
    pevNextIndex = Math.max(pevNextIndex, phase.index + 1);
  }
  const pevIndexOf = (name: string): number => {
    let idx = pevPhaseIndex.get(name);
    if (idx === undefined) { idx = pevNextIndex++; pevPhaseIndex.set(name, idx); }
    return idx;
  };
  const pevRestore = <T,>(name: string): T | undefined => {
    const idx = pevPhaseIndex.get(name);
    return idx === undefined ? undefined : (resumeState?.checkpoints.get(idx) as unknown as T | undefined);
  };
  const pevCheckpoint = (name: string, result: unknown, route?: { provider?: string; model?: string }): void => {
    // Every checkpointed result carries its resolved provider/model so a resumed
    // run can see exactly which route produced each phase. This applies to BOTH
    // single-spawn/per-task objects AND verifier ARRAY checkpoints (residual 2a);
    // the route is only ever ADDED, never allowed to overwrite an already-resolved
    // provider/model with undefined (empty {} routes must not strip metadata).
    const stamp = (item: unknown): unknown =>
      item && typeof item === "object" && !Array.isArray(item)
        ? {
            ...(item as Record<string, unknown>),
            provider: route?.provider ?? (item as { provider?: unknown }).provider,
            model: route?.model ?? (item as { model?: unknown }).model,
          }
        : item;
    const payload = Array.isArray(result)
      ? result.map(stamp)
      : result
        ? stamp(result)
        : result;
    pevStore.checkpointPhase(pevIndexOf(name), name, payload as unknown as SubagentResult);
  };
  const pevSurvival = (name: string) => {
    const idx = pevIndexOf(name);
    return {
      resultFile: pevStore.survivorResultPath(idx, name),
      manifestFile: pevStore.survivorManifestPath(idx, name),
      phaseName: name,
      phaseIndex: idx,
    };
  };
  const pevCollectSurvivor = async <T,>(name: string): Promise<T | undefined> => {
    const idx = pevPhaseIndex.get(name);
    if (idx === undefined) return undefined;
    const survivor = resumeState?.survivors.get(idx);
    if (!survivor) return undefined;
    const collected = await collectSurvivorResult<T>(survivor, emit, signal, "plan-execute-verify");
    if (collected) pevCheckpoint(name, collected);
    return collected;
  };
  // Executor-task survivor: the abort-survivor writer persists a raw SubagentResult,
  // so collect it WITHOUT auto-checkpointing (the generic collector stores the raw
  // object), convert to an ExecutorOutput, then checkpoint that with the route.
  const pevCollectExecutorSurvivor = async (name: string, task: PlanTask): Promise<ExecutorOutput | undefined> => {
    const idx = pevPhaseIndex.get(name);
    if (idx === undefined) return undefined;
    const survivor = resumeState?.survivors.get(idx);
    if (!survivor) return undefined;
    const collected = await collectSurvivorResult<SubagentResult>(survivor, emit, signal, "plan-execute-verify");
    if (!collected) return undefined;
    const out = executorOutputFromSubagent(task, collected);
    pevCheckpoint(name, out, toModelOverride(params.executorModel, params.executorProvider));
    return out;
  };
  const pevDetachGuard = (name: string, error: unknown): never => {
    if (error instanceof SubagentDetachedError) {
      pevStore.markDetached(pevIndexOf(name), name, error.manifest);
      throw new Error(
        `Orchestration aborted mid-phase but the ${name} subagent (pid=${error.manifest.pid}) ` +
          `continues in the background. Resume this run by re-invoking the orchestrate tool with { resume: "${pevStore.runId}" }. ` +
          `Completed phases are checkpointed and will not be re-executed.`,
      );
    }
    throw error as Error;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    state.attempt = attempt;
    emit(`Orchestration attempt ${attempt}/${maxAttempts}: planning...`);
    const preAttemptHead = gitHeadHash(params.cwd);
    const plannerName = `attempt-${attempt}-planner`;
    const verifierName = `attempt-${attempt}-verifier`;
    const executorTaskName = (taskId: string) => `attempt-${attempt}-executor-${taskId}`;

    const completedTasks = [...state.taskLedger.values()].filter((entry) => entry.verdict === "passed");
    const plannerPrompt = buildPlanningPrompt(state.intake, attempt, state.failureReasons, completedTasks, params.predictedWriteSet, params.externalEvidenceRoots);
    const plannerRoute = toModelOverride(params.plannerModel, params.plannerProvider);
    let plannerOutputs: SubagentResult[];
    let planner: SubagentResult;
    let selectedPlannerIndex = 0;
    const restoredPlanner = pevRestore<SubagentResult>(plannerName) ?? (await pevCollectSurvivor<SubagentResult>(plannerName));
    if (restoredPlanner) {
      emit(`Attempt ${attempt}: planner phase restored from checkpoint (resume) — skipping re-spawn.`);
      planner = restoredPlanner;
      plannerOutputs = [planner];
      state.plannerOutputs = plannerOutputs;
    } else {
      emit(`Attempt ${attempt}: spawning ${params.plannerCount} planner subagent(s) in parallel...`);
      const plannerJobs = Array.from({ length: params.plannerCount }, (_unused, index) => index);
      // Per-child survivor/checkpoint names so a mid-phase abort during a
      // MULTI-planner phase (plannerCount>1) can detach and later re-attach each
      // individual planner survivor. For plannerCount===1 the child name collapses
      // to the phase name, preserving the single-spawn checkpoint semantics.
      const plannerChildName = (i: number) => (params.plannerCount === 1 ? plannerName : `${plannerName}-${i}`);
      try {
        plannerOutputs = await runBoundedPool(plannerJobs, params.plannerCount, signal, async (plannerIndex, _index, workerSignal) => {
          const childName = plannerChildName(plannerIndex);
          // Resume path 1: completed per-child checkpoint — restore without re-spawn.
          const restoredChild = pevRestore<SubagentResult>(childName);
          if (restoredChild && !Array.isArray(restoredChild)) {
            emit(`Attempt ${attempt}: planner instance ${plannerIndex + 1}/${params.plannerCount} restored from checkpoint (resume) — skipping re-spawn.`);
            return restoredChild;
          }
          // Resume path 2: detached survivor for this planner child — collect or respawn.
          const survivorChild = await pevCollectSurvivor<SubagentResult>(childName);
          if (survivorChild) {
            emit(`Attempt ${attempt}: planner instance ${plannerIndex + 1}/${params.plannerCount} survivor collected (resume) — skipping re-spawn.`);
            return survivorChild;
          }
          const prompt = params.plannerCount > 1
            ? `${plannerPrompt}\n\nPlanner instance ${plannerIndex + 1}/${params.plannerCount}: produce an independent tiny plan. The orchestrator will deterministically select the lowest-index parseable plan; do not coordinate with other planners.`
            : plannerPrompt;
          let out: SubagentResult;
          try {
            out = await spawnChecked(state, params, agents, params.plannerAgent, prompt, workerSignal, emit, inheritedModel, plannerRoute, pevSurvival(childName), false, false, "planner");
          } catch (error) {
            pevDetachGuard(childName, error);
            throw error;
          }
          pevCheckpoint(childName, out, plannerRoute);
          return out;
        });
      } catch (error) {
        pevDetachGuard(plannerName, error);
        throw error;
      }
      state.plannerOutputs = plannerOutputs;
      selectedPlannerIndex = selectPlannerOutputIndex(plannerOutputs, params.task);
      planner = plannerOutputs[selectedPlannerIndex];
      pevCheckpoint(plannerName, planner, plannerRoute ?? {});
    }
    state.planText = planner.text;
    let plan = parsePlan(planner.text, params.task);
    // Worker admission is decided from the launcher-selected model, complete Pi
    // prompt, and active tool schemas. Do not split from model-name heuristics.
    plan.externalEvidenceRoots = validatePlannedExternalEvidenceRoots(plan.externalEvidenceRoots, {
      cwd: params.cwd,
      worktree: { root: evidenceWorktreeRoot, realRoot: evidenceWorktreeRealRoot, branch: null, baseline: null },
      externalEvidenceRoots: params.externalEvidenceRoots,
    });
    assertPlannerPreservesDeliverables(state.intake.deliverables, plan);
    const planRoleControls = extractPlanRoleControls(plan);
    const executorConcurrency = clampInt(planRoleControls.executorConcurrency ?? params.concurrency, params.concurrency, 1, 16);
    const verifierCount = clampInt(planRoleControls.verifierCount ?? params.verifierCount, params.verifierCount, 1, 16);
    const executionWaves = buildExecutionWaves(plan);
    state.plan = plan;

    if (params.plannerCount > 1) {
      emit(`Attempt ${attempt}: selected planner ${selectedPlannerIndex + 1}/${plannerOutputs.length} by deterministic lowest-index parseable-plan rule.`);
    }
    if (planRoleControls.executorConcurrency || planRoleControls.verifierCount) {
      emit(`Planner-supplied role controls applied: executorConcurrency=${executorConcurrency}, verifierCount=${verifierCount}.`);
    }
    const taskAssignments = plan.tasks.map((t) => `${t.id}=${t.description}`).join("; ");
    emit(`Plan tasks: ${taskAssignments}`);

    // ── Predict-then-write (AGENTS.md: Discovery before mutation) ────────
    // The contract-granted set wins; a planner-declared set is enforced when
    // no contract set was supplied. Enforcement is deterministic — no model
    // judgment is involved in detecting an out-of-set mutation.
    const contractWriteSet = params.predictedWriteSet;
    const effectiveWriteSet = contractWriteSet ?? plan.predictedWriteSet;
    if (plan.predictedWriteSet?.length) {
      emit(`Planner predicted write set (${plan.predictedWriteSet.length} entrie(s)): ${plan.predictedWriteSet.join(", ")}`);
    }
    if (contractWriteSet && plan.predictedWriteSet?.length) {
      const outsideContract = planEntriesOutsideContract(plan.predictedWriteSet, contractWriteSet);
      if (outsideContract.length > 0) {
        // Pre-execution satisfiability failure: the plan already declares
        // out-of-scope mutations. This is terminal for the current discovery:
        // fail BEFORE any executor spawns and do not retry inside the same run.
        emit(`Attempt ${attempt}: plan predicts ${outsideContract.length} mutation(s) outside the contracted write set — failing before execution: ${outsideContract.join(", ")}`);
        const terminalState = persistPevWriteSetTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-write-set-pre-execution`,
          "WRITE_SET_VIOLATION",
          state,
          undefined,
          outsideContract,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.executorOutputs = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        return finalizePevTerminalResult(params, state, terminalState);
      }
    }

    if (params.discoveryOnly) {
      const writeSetLabel = contractWriteSet ? "contract-granted" : plan.predictedWriteSet?.length ? "planner-predicted" : "none declared";
      const manifestLines = [
        `# Discovery manifest (run ${state.runId})`,
        "",
        "Discovery-only mode: no executor or verifier subagents were spawned; this run mutated no files.",
        "",
        `## Plan (${plan.tasks.length} task(s))`,
        ...plan.tasks.map((t) => `- ${t.id}: ${t.description}${t.dependsOn.length ? ` (depends on ${t.dependsOn.join(", ")})` : ""}`),
      ];
      if (plan.notes) manifestLines.push("", `Notes: ${plan.notes}`);
      manifestLines.push(
        "",
        `## Predicted write set (${writeSetLabel})`,
        ...(effectiveWriteSet?.length ? effectiveWriteSet.map((entry) => `- ${entry}`) : ["(none declared)"]),
        "",
        "To execute under deterministic write-set enforcement, re-run without discoveryOnly and pass the approved list as predictedWriteSet.",
      );
      const manifest = manifestLines.join("\n");
      emit(`Discovery-only run complete: ${plan.tasks.length} task(s) planned, ${effectiveWriteSet?.length ?? 0} write-set entrie(s); no executors spawned.`);
      state.finalResult = manifest;
      return {
        markdown: manifest,
        details: {
          runId: state.runId,
          mode: "discovery-only",
          plan: { tasks: plan.tasks, notes: plan.notes },
          predictedWriteSet: effectiveWriteSet ?? [],
          externalEvidenceRoots: params.externalEvidenceRoots,
          writeSetSource: writeSetLabel,
          progressLog: state.progressLog,
        },
      };
    }

    const requiredBudget = computeRequiredSubagentBudget(state.spawnedCount, plan.tasks.length, attempt, maxAttempts, params.plannerCount, verifierCount);
    if (!params.maxSubagentsExplicit && requiredBudget > params.maxSubagents) {
      const previous = params.maxSubagents;
      params.maxSubagents = Math.min(requiredBudget, MAX_SUBAGENTS_LIMIT);
      emit(
        `Auto-raised maxSubagents from ${previous} to ${params.maxSubagents} based on plan size (${plan.tasks.length} executor task(s)), plannerCount=${params.plannerCount}, verifierCount=${verifierCount}, and retry budget (${maxAttempts} attempt(s)).`,
      );
      if (requiredBudget > MAX_SUBAGENTS_LIMIT) {
        emit(`Required subagent budget ${requiredBudget} exceeds hard safety limit ${MAX_SUBAGENTS_LIMIT}; orchestration may still stop if the ceiling is reached.`);
      }
    } else if (params.maxSubagentsExplicit) {
      emit(`Using explicit maxSubagents=${params.maxSubagents}; auto-raise is disabled for this run.`);
    }

    const remainingAfterPlan = params.maxSubagents - state.spawnedCount;
    const neededForExecutionAndVerify = plan.tasks.length + verifierCount;
    if (neededForExecutionAndVerify > remainingAfterPlan) {
      throw new Error(
        `Subagent ceiling exceeded after planning: need ${neededForExecutionAndVerify} more spawn(s), remaining ${remainingAfterPlan}, maxSubagents=${params.maxSubagents}. Try /orchestrate --max-subagents ${requiredBudget} ... or reduce --max-retries.`,
      );
    }

    let writeSetObservationSummary = "";
    let writeSetBefore: WriteSetSnapshot | undefined;
    if (effectiveWriteSet?.length || params.externalEvidenceRoots?.length) {
      writeSetBefore = captureWriteSetSnapshot(params.cwd, effectiveWriteSet ?? [], params.externalEvidenceRoots);
      if (writeSetBefore.unobservableScopes.length) {
        emit(
          `Attempt ${attempt}: write-set observation is unobservable before executor spawn — ` +
            `${writeSetBefore.unobservableScopes.join(", ")}; failing closed with no executor/verifier spawn.`,
        );
        const terminalState = persistPevWriteSetTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-write-set-pre-executor`,
          "WRITE_SET_UNOBSERVABLE",
          state,
          undefined,
          writeSetBefore.unobservableScopes,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.executorOutputs = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        return finalizePevTerminalResult(params, state, terminalState);
      }
    }

    // Executor phase is checkpointed PER TASK (attempt-N-executor-<taskId>). Each
    // task spawn runs in abort-survivor mode and its output is checkpointed with the
    // resolved executor provider/model, so a mid-execution abort can resume without
    // re-running already-completed tasks and without losing detached survivors.
    const executorRoute = toModelOverride(params.executorModel, params.executorProvider);
    emit(`Attempt ${attempt}: executing ${plan.tasks.length} task(s) across ${executionWaves.length} dependency wave(s) with executor concurrency ${executorConcurrency}...`);
    let executorOutputs: ExecutorOutput[] = [];
    try {
      executorOutputs = await runExecutorTasksInWaves(
        executionWaves,
        executorConcurrency,
        signal,
        async (task, _index, workerSignal) => {
          const taskName = executorTaskName(task.id);
          // Resume path 1: completed per-task checkpoint — restore without re-execution.
          const restoredTask = pevRestore<ExecutorOutput>(taskName);
          if (restoredTask && !Array.isArray(restoredTask)) {
            emit(`Attempt ${attempt}: executor task ${task.id} restored from checkpoint (resume) — skipping re-execution.`);
            return restoredTask;
          }
          // Resume path 2: detached survivor for this task — collect or respawn.
          const survivorOut = await pevCollectExecutorSurvivor(taskName, task);
          if (survivorOut) {
            emit(`Attempt ${attempt}: executor task ${task.id} survivor collected (resume) — skipping re-execution.`);
            return survivorOut;
          }
          let out: ExecutorOutput;
          try {
            out = await executeExecutorTaskWithRecovery(
              state, params, agents, task, plan, workerSignal, emit, inheritedModel, pevSurvival(taskName),
            );
          } catch (error) {
            pevDetachGuard(taskName, error);
            throw error;
          }
          pevCheckpoint(taskName, out, executorRoute);
          return out;
        },
      );
    } catch (error) {
      if (error instanceof SubagentTerminalAmbiguousError) {
        if (writeSetBefore) {
          const writeSetAfter = captureWriteSetSnapshot(params.cwd, effectiveWriteSet ?? [], params.externalEvidenceRoots);
          const terminalEval = evaluateWriteSetObservation(writeSetBefore, writeSetAfter, effectiveWriteSet ?? []);
          emit(`Attempt ${attempt}: terminal executor transport state observed; post-executor write-set snapshot: ${formatPevWriteSetObservation(terminalEval)}`);
          if (terminalEval.unobservableScopes.length || terminalEval.violations.length) {
            const code = terminalEval.unobservableScopes.length ? "WRITE_SET_UNOBSERVABLE" : "WRITE_SET_VIOLATION";
            const terminalState = persistPevWriteSetTerminal(
              pevStore,
              pevIndexOf,
              `attempt-${attempt}-executor-terminal-write-set`,
              code,
              state,
              terminalEval,
            );
            const verifierResult = makePevTerminalVerifierResult(terminalState);
            state.verifierResult = verifierResult;
            state.verifierResults = [];
            state.executorOutputs = [];
            state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
            state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
            return finalizePevTerminalResult(params, state, terminalState);
          }
        }
        const terminalState = persistPevAmbiguousTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-executor-terminal`,
          error,
          state,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.executorOutputs = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs: [], verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        return finalizePevTerminalResult(params, state, terminalState);
      }
      throw error;
    }
    state.executorOutputs = executorOutputs;

    if (writeSetBefore) {
      const writeSetAfter = captureWriteSetSnapshot(params.cwd, effectiveWriteSet ?? [], params.externalEvidenceRoots);
      const writeSetEval = evaluateWriteSetObservation(writeSetBefore, writeSetAfter, effectiveWriteSet ?? []);
      writeSetObservationSummary =
        `Write/evidence observation (${contractWriteSet ? "contract-granted" : "planner-predicted"} write scope, ${effectiveWriteSet?.length ?? 0} write entrie(s), ${params.externalEvidenceRoots?.length ?? 0} read-only evidence root(s)): ` +
        `${writeSetEval.observed.length} observed mutation(s), ${writeSetEval.violations.length} violation(s), ` +
        `${writeSetEval.unobservableScopes.length} unobservable scope(s).`;
      if (writeSetEval.unobservableScopes.length || writeSetEval.violations.length) {
        const code = writeSetEval.unobservableScopes.length ? "WRITE_SET_UNOBSERVABLE" : "WRITE_SET_VIOLATION";
        emit(
          `Attempt ${attempt}: write-set enforcement failed before verification; ` +
            `${formatPevWriteSetObservation(writeSetEval)} This is terminal for the current discovery.`,
        );
        const terminalState = persistPevWriteSetTerminal(
          pevStore,
          pevIndexOf,
          `attempt-${attempt}-write-set-post-executor`,
          code,
          state,
          writeSetEval,
        );
        const verifierResult = makePevTerminalVerifierResult(terminalState);
        state.verifierResult = verifierResult;
        state.verifierResults = [];
        state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs, verifierResult, verifierResults: [] });
        state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
        updateTaskLedgerFromFailure(state, plan, executorOutputs, verifierResult.reasons, attempt, emit);
        return finalizePevTerminalResult(params, state, terminalState);
      }
    }

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

    if (writeSetObservationSummary) {
      artifactEvidence.summary += `\n${writeSetObservationSummary}`;
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
      state.verifierResults = [];
      state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs, verifierResult, verifierResults: [] });
      state.failureReasons.push(...verifierResult.reasons.map((reason) => `Attempt ${attempt}: ${reason}`));
      updateTaskLedgerFromFailure(state, plan, executorOutputs, verifierResult.reasons, attempt, emit);

      if (attempt >= maxAttempts) break;
      if (state.spawnedCount >= params.maxSubagents) {
        throw new Error(`Subagent ceiling reached before retry: spawned ${state.spawnedCount}/${params.maxSubagents}.`);
      }
      continue;
    }

    const verifierRoute = toModelOverride(params.verifierModel, params.verifierProvider);
    let verifierOutputs: SubagentResult[];
    const restoredVerifier = pevRestore<SubagentResult[]>(verifierName);
    if (restoredVerifier && Array.isArray(restoredVerifier)) {
      emit(`Attempt ${attempt}: verifier phase restored from checkpoint (resume) — skipping re-spawn.`);
      verifierOutputs = restoredVerifier;
    } else {
      emit(`Attempt ${attempt}: verifying executor outputs with ${verifierCount} verifier subagent(s) in parallel...`);
      const verifierPrompt = buildVerificationPrompt(state.intake!, plan, executorOutputs, buildRoutingEvidenceForVerifier(params, state), artifactEvidence.summary);
      const verifierJobs = Array.from({ length: verifierCount }, (_unused, index) => index);
      // Per-child survivor/checkpoint names so a mid-phase abort during a
      // MULTI-verifier phase (verifierCount>1) can detach and re-attach each
      // individual verifier survivor. For verifierCount===1 the child name
      // collapses to the phase name; the phase-level checkpoint (an array,
      // written after the pool) then overwrites it, preserving prior semantics.
      const verifierChildName = (i: number) => (verifierCount === 1 ? verifierName : `${verifierName}-${i}`);
      try {
        verifierOutputs = await runBoundedPool(verifierJobs, verifierCount, signal, async (verifierIndex, _index, workerSignal) => {
          const childName = verifierChildName(verifierIndex);
          // Resume path 1: completed per-child checkpoint — restore without re-spawn.
          const restoredChild = pevRestore<SubagentResult>(childName);
          if (restoredChild && !Array.isArray(restoredChild)) {
            emit(`Attempt ${attempt}: verifier instance ${verifierIndex + 1}/${verifierCount} restored from checkpoint (resume) — skipping re-spawn.`);
            return restoredChild;
          }
          // Resume path 2: detached survivor for this verifier child — collect or respawn.
          const survivorChild = await pevCollectSurvivor<SubagentResult>(childName);
          if (survivorChild) {
            emit(`Attempt ${attempt}: verifier instance ${verifierIndex + 1}/${verifierCount} survivor collected (resume) — skipping re-spawn.`);
            return survivorChild;
          }
          const prompt = verifierCount > 1
            ? `${verifierPrompt}\n\nVerifier instance ${verifierIndex + 1}/${verifierCount}: independently verify. The orchestrator aggregates with strict consensus: any FAIL makes the aggregate FAIL.`
            : verifierPrompt;
          let out: SubagentResult;
          try {
            out = await spawnChecked(state, params, agents, params.verifierAgent, prompt, workerSignal, emit, inheritedModel, verifierRoute, pevSurvival(childName), false, true);
          } catch (error) {
            pevDetachGuard(childName, error);
            throw error;
          }
          pevCheckpoint(childName, out, verifierRoute);
          return out;
        });
      } catch (error) {
        pevDetachGuard(verifierName, error);
        throw error;
      }
      pevCheckpoint(verifierName, verifierOutputs, verifierRoute ?? {});
    }
    const verifierResults = verifierOutputs.map((verifierOutput, index) => ({
      agentName: verifierOutput.agentName,
      ...parseVerifierResult(verifierOutput.text),
      raw: verifierOutput.text,
      reasons: parseVerifierResult(verifierOutput.text).reasons.map((reason) => verifierCount > 1 ? `verifier-${index + 1}: ${reason}` : reason),
    }));
    state.verifierResults = verifierResults;
    const verifierResult = aggregateVerifierResults(verifierResults);
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

    state.attempts.push({ attempt, plan, plannerText: planner.text, plannerOutputs, executorOutputs, verifierResult, verifierResults });

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
    const terminalNoRetry = error instanceof SubagentTerminalAmbiguousError ? error.info : undefined;
    const composableResumeUnsupported = paradigm === "composable-pipeline";
    const resumeUnsupportedReason = composableResumeUnsupported
      ? "This composable-pipeline run is non-resumable: the paradigm does not persist RunStateStore checkpoints. " +
        "The run ID is diagnostic only; inspect possible mutations before starting a new orchestration."
      : undefined;
    const providerError =
      (error as { providerError?: ProviderHealthError }).providerError ??
      parseProviderError(message);
    state.abortReason = message;
    state.failureReasons.push(`Run aborted: ${message}`);
    if (terminalNoRetry) {
      state.failureReasons.push(`Terminal no-retry state: ${terminalNoRetry.code}; retryAllowed=false; resultLost=${terminalNoRetry.resultLost}.`);
    }
    if (resumeUnsupportedReason) state.failureReasons.push(resumeUnsupportedReason);
    emit(
      `Orchestration aborted — emitting partial report. Structured error: ${formatProviderError(providerError)}`,
    );
    let durablePreflightAbort: PersistedPreflightAbort | undefined;
    if (preflightInProgress && state.spawnedCount === 0) {
      durablePreflightAbort = persistPreInitializationPreflightAbort(
        params,
        agents,
        state.runId,
        paradigm,
        error,
      );
    }
    state.finalResult = buildFinalResult("fail", params, state);
    return {
      markdown: state.finalResult,
      details: {
        ...buildDetails("fail", params, state),
        aborted: true,
        abortReason: message,
        providerError,
        paradigm,
        ...(durablePreflightAbort ? {
          persistedStatus: durablePreflightAbort.state.status,
          persistedCheckpointId: durablePreflightAbort.state.checkpoints.at(-1)?.id,
          preflightAbort: durablePreflightAbort.preflightAbort,
        } : {}),
        ...(terminalNoRetry ? { terminalNoRetry, retryAllowed: false, code: terminalNoRetry.code } : {}),
        ...(resumeUnsupportedReason ? {
          resumeSupported: false,
          resumable: false,
          resumeHint: {
            supported: false,
            paradigm,
            reason: resumeUnsupportedReason,
            runIdPurpose: "diagnostic-only",
          },
        } : {}),
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
const PREFLIGHT_PING_TIMEOUT_MS = 20_000;
const PREFLIGHT_TOTAL_TIMEOUT_MS = 75_000;

function preflightBoundFromEnv(name: string, productionDefault: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : productionDefault;
}

async function runProviderPreflight(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  inheritedModel: { provider?: string; model?: string } | undefined,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
): Promise<void> {
  const perPingTimeoutMs = preflightBoundFromEnv("ORCHESTRATE_PREFLIGHT_TIMEOUT_MS", PREFLIGHT_PING_TIMEOUT_MS);
  const totalTimeoutMs = preflightBoundFromEnv("ORCHESTRATE_PREFLIGHT_TOTAL_TIMEOUT_MS", PREFLIGHT_TOTAL_TIMEOUT_MS);
  const deadline = Date.now() + totalTimeoutMs;
  const remainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`PREFLIGHT TOTAL TIMEOUT after ${totalTimeoutMs}ms (primary/fallback budget exhausted).`);
    return Math.min(perPingTimeoutMs, remaining);
  };

  const resolveRoute = (agentName: string, model?: string, provider?: string): RoleModelOverride => {
    const profile = agents.get(agentName);
    return {
      provider: provider ?? profile?.provider ?? inheritedModel?.provider,
      model: model ?? profile?.model ?? inheritedModel?.model,
      providerIsPiDefault: provider === undefined && profile?.providerIsPiDefault === true,
      modelIsPiDefault: model === undefined && profile?.modelIsPiDefault === true,
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
    roles.map((role) => ({
      roles: [role.role],
      provider: role.provider,
      model: role.model,
      providerIsPiDefault: role.providerIsPiDefault,
      modelIsPiDefault: role.modelIsPiDefault,
    })),
    {
      cwd: params.cwd,
      allowLocalModel: params.allowLocalModel,
      signal,
      onProgress: emit,
      timeoutMs: remainingTimeout(),
      totalTimeoutMs: Math.max(1, deadline - Date.now()),
    },
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
            {
              cwd: params.cwd,
              allowLocalModel: params.allowLocalModel,
              signal,
              onProgress: emit,
              timeoutMs: remainingTimeout(),
              totalTimeoutMs: Math.max(1, deadline - Date.now()),
            },
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

interface PersistedPreflightAbort {
  state: SupervisionRunState;
  error: ReturnType<typeof classifyInfrastructureFailure>;
  preflightAbort: {
    phase: "provider-health-preflight";
    workerDispatchCount: 0;
    productMutation: false;
    resultLostAfterMutation: false;
    classifiedOutcome: string;
    providerError?: ProviderHealthError;
  };
}

/**
 * Persist a zero-worker provider-health abort as infrastructure evidence.
 * Health pings are never product workers and cannot justify mutation-loss
 * language, even when the child process ended ambiguously.
 */
function appendZeroWorkerPreflightAbort(
  store: SupervisionStateStore,
  state: SupervisionRunState,
  error: unknown,
): PersistedPreflightAbort {
  const attachedProviderError = error && typeof error === "object"
    ? (error as { providerError?: ProviderHealthError }).providerError
    : undefined;
  const initial = classifyInfrastructureFailure(error);
  const classified = initial.infrastructure
    ? initial
    : {
        infrastructure: true,
        code: attachedProviderError?.type === "aborted" ? "orchestrator" as const : "provider" as const,
        message: initial.message,
        retryAllowed: attachedProviderError ? false : undefined,
      };
  const preflightAbort: PersistedPreflightAbort["preflightAbort"] = {
    phase: "provider-health-preflight",
    workerDispatchCount: 0,
    productMutation: false,
    resultLostAfterMutation: false,
    classifiedOutcome: classified.code ?? "provider",
    ...(attachedProviderError ? { providerError: attachedProviderError } : {}),
  };
  state.audit.infrastructureFailures.push(classified);
  if (state.status !== "blocked_infrastructure") {
    state = transitionSupervisionState(state, "blocked_infrastructure");
  }
  store.save(state);
  state = store.appendCheckpoint(
    state,
    {
      kind: "infrastructure",
      createdAt: new Date().toISOString(),
      missionHash: state.mission.missionHash,
      criteria: [],
      effectChanges: [],
      outcome: "preflight_aborted",
    },
    { error: classified, preflightAbort },
  );
  return { state, error: classified, preflightAbort };
}

/** Create the durable supervision shell missing on legacy/off preflight paths. */
function persistPreInitializationPreflightAbort(
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  runId: string,
  paradigm: string,
  error: unknown,
): PersistedPreflightAbort {
  const intake = buildIntake(params, agents, undefined);
  const cwd = path.resolve(params.cwd);
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  let realRoot = root;
  try { realRoot = realpathSync.native(root); } catch { /* lexical root remains durable evidence */ }
  const criteria = buildNumericAwareAcceptanceCriteria(params.task, params.numericAcceptanceGates, intake.successCriteria);
  const role = (name: string, model?: string, provider?: string) => resolveNamedRoleRoute(agents, name, model, provider);
  const planner = role(params.plannerAgent, params.plannerModel, params.plannerProvider);
  const executor = role(params.executorAgent, params.executorModel, params.executorProvider);
  const verifier = role(params.verifierAgent, params.verifierModel, params.verifierProvider);
  const mission = createFrozenMission({
    originalTask: params.task,
    cwd: params.cwd,
    worktree: {
      root,
      realRoot,
      branch: gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      baseline: gitText(cwd, ["rev-parse", "HEAD"]),
    },
    paradigm,
    lane: "product",
    routes: [
      { role: "planner", agentName: params.plannerAgent, provider: planner.provider ?? "default", model: planner.model ?? "default" },
      { role: "executor", agentName: params.executorAgent, provider: executor.provider ?? "default", model: executor.model ?? "default" },
      { role: "verifier", agentName: params.verifierAgent, provider: verifier.provider ?? "default", model: verifier.model ?? "default" },
    ],
    constraints: intake.constraints,
    nonGoals: intake.nonGoals,
    acceptanceCriteria: criteria,
    workerExecutionConstraints: params.workerExecutionConstraints,
    externalEvidenceRoots: params.externalEvidenceRoots ?? [],
    criteriaAuthority: {
      ownerCriteria: intake.ownerCriteria,
      supervisorAddedConstraints: intake.supervisorAddedConstraints,
      plannerInferredPresentationRules: intake.plannerInferredPresentationRules,
    },
  });
  let state = createInitialSupervisionState({ runId, mission, tasks: [] });
  const identity = {
    protocolId: HOST_TASK_BOUNDARY_PROTOCOL_ID,
    adapterId: paradigm === "plan-execute-verify" ? PEV_SHAPE_ADAPTER_ID : GENERIC_SHAPE_ADAPTER_ID,
    adapterVersion: 1 as const,
  };
  state.runtime = createGenericSupervisionRuntime({
    identity,
    cursor: createGenericSupervisionCursor(identity, { stage: "plan" }),
    params: JSON.parse(JSON.stringify({ ...params, action: "run", supervision: "visible-main" })),
    intake,
    plan: { tasks: [], notes: "Provider health preflight aborted before planning." },
    completedTaskIds: [],
    executorOutputs: [],
    contentBaseline: captureContentSignatureSnapshot(cwd),
    acceptedGitBaseline: mission.worktree.baseline,
    repairCount: 0,
    hostInstanceId: SUPERVISION_HOST_INSTANCE,
    adapterState: { classification: "read-only", zeroWorkerPreflightAbort: true },
  });
  const store = new SupervisionStateStore(runId);
  store.create(state);
  return appendZeroWorkerPreflightAbort(store, state, error);
}

function computeRequiredSubagentBudget(
  spawnedThroughCurrentPlanner: number,
  executorTaskCount: number,
  currentAttempt: number,
  maxAttempts: number,
  plannerCount = 1,
  verifierCount = 1,
): number {
  const finishCurrentAttempt = executorTaskCount + verifierCount; // current planner batch already spawned.
  const remainingAttempts = Math.max(0, maxAttempts - currentAttempt);
  const fullFutureAttempt = plannerCount + executorTaskCount + verifierCount;
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

/** Byte snapshot of the task window, independent of stable git status flags. */
function captureGitStatusEntries(cwd: string): ContentSignatureSnapshot | null {
  try {
    return captureContentSignatureSnapshot(cwd);
  } catch {
    return null;
  }
}

/** Positive byte changes; undefined means absence of changes is not proven. */
function diffGitStatusEntries(before: ContentSignatureSnapshot | null, after: ContentSignatureSnapshot | null): string[] | undefined {
  if (!before || !after) return undefined;
  const omitted = [...before.omitted, ...after.omitted];
  const changed = diffContentSignatureSnapshots(before, after).filter((change) =>
    !omitted.some((entry) => change.path === entry.path || change.path.startsWith(`${entry.path.replace(/\/$/, "")}/`))
    && !(change.kind === "added" && before.truncated)
    && !(change.kind === "deleted" && after.truncated)).map((change) => change.path);
  const partial = before.truncated || after.truncated || omitted.some((entry) => entry.reason !== "excluded");
  return partial && !changed.length ? undefined : changed;
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
/**
 * Build a minimal ExecutorOutput from a raw SubagentResult. Used when a detached
 * executor-task survivor is collected on resume (the abort-survivor writer only
 * persists the raw SubagentResult, not the wrapped ExecutorOutput).
 */
function executorOutputFromSubagent(task: PlanTask, result: SubagentResult): ExecutorOutput {
  return {
    taskId: task.id,
    description: task.description,
    agentName: result.agentName,
    output: result.text,
    stderr: result.stderr || undefined,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    contextExhaustionSignal: result.contextExhaustionSignal,
    toolCalls: result.toolCalls,
    actionEvidence: result.actionEvidence,
    commandTimes: result.commandTimes,
    provider: result.provider,
    model: result.model,
  };
}

async function executeExecutorTaskWithRecovery(
  state: OrchestrationState,
  params: NormalizedParams,
  agents: Map<string, AgentProfile>,
  task: PlanTask,
  plan: Plan,
  signal: AbortSignal | undefined,
  emit: (text: string) => void,
  inheritedModel: { provider?: string; model?: string } | undefined,
  survival?: {
    resultFile: string;
    manifestFile: string;
    phaseName?: string;
    phaseIndex?: number;
  },
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

  // Tier 0: authoritative pre-spawn admission. Resolve the same profile/model,
  // Pi-assembled system prompt, and active tools that the child launcher uses.
  const loadedExecutorProfile = agents.get(params.executorAgent) ?? { name: params.executorAgent };
  const executorProfile: AgentProfile = {
    ...loadedExecutorProfile,
    provider: params.executorProvider ?? loadedExecutorProfile.provider ?? inheritedModel?.provider,
    model: params.executorModel ?? loadedExecutorProfile.model ?? inheritedModel?.model,
    providerIsPiDefault: params.executorProvider === undefined
      && loadedExecutorProfile.provider !== undefined
      && loadedExecutorProfile.providerIsPiDefault === true,
    modelIsPiDefault: params.executorModel === undefined
      && loadedExecutorProfile.model !== undefined
      && loadedExecutorProfile.modelIsPiDefault === true,
  };
  const launchPrompt = await resolveCompleteWorkerLaunchPrompt({
    cwd: params.cwd,
    profile: executorProfile,
    appendedSystemPrompt: buildSubagentSystemPrompt(executorProfile),
    workerExecutionConstraints: params.workerExecutionConstraints,
  });
  const budget = assertWorkerPromptFitsCapacity({
    prompt,
    completeSystemPrompt: launchPrompt.systemPrompt,
    toolSchemas: launchPrompt.toolSchemas,
    contextWindow: launchPrompt.contextWindow,
    maxOutputTokens: launchPrompt.maxOutputTokens,
    modelId: `${launchPrompt.provider}/${launchPrompt.model}`,
  });
  emit(
    "Task " + task.id + ": configured pre-spawn capacity: " + budget.saturationPercent + "% " +
    "margin-adjusted estimated saturation (" + budget.risk + "), rec: " + budget.recommendation,
  );

  const maxDepth = state.maxRecoveryDepth;

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
      survival,
      true,
    );
  } catch (err) {
    // A mid-phase abort in abort-survivor mode detaches the child and rejects
    // with SubagentDetachedError. This MUST propagate so the caller can persist
    // the survivor manifest and surface the resume hint — never swallow it into
    // an ordinary task failure.
    if (err instanceof SubagentDetachedError) throw err;
    if (err instanceof SubagentTerminalAmbiguousError) throw err;
    if (err instanceof ConfirmedSupervisedAbandonError) throw err;
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
  const postStatusEntries = captureGitStatusEntries(params.cwd);
  const changedFiles = diffGitStatusEntries(preStatusEntries, postStatusEntries);
  const observationStatus = !preStatusEntries || !postStatusEntries ? "unknown"
    : preStatusEntries.truncated || postStatusEntries.truncated
      || [...preStatusEntries.omitted, ...postStatusEntries.omitted].some((entry) => entry.reason !== "excluded") ? "partial" : "complete";
  if (result.toolCalls || changedFiles) {
    emit(
      "Task " + task.id + ": effect evidence — tool calls " + formatToolCallSummary(result.toolCalls) +
      "; worktree delta " + (changedFiles ? changedFiles.length + " file(s)" + (changedFiles.length ? " (" + changedFiles.join(", ") + ")" : "") : "unknown (content observation unavailable)") + ".",
    );
  }

  let output: ExecutorOutput = {
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
    actionEvidence: result.actionEvidence,
    commandTimes: result.commandTimes,
    effectSnapshots: [{ before: preStatusEntries, after: postStatusEntries }],
    filesChanged: changedFiles ? changedFiles.length : undefined,
    changedFiles,
    effectChanges: changedFiles?.map((file) => {
      const before = preStatusEntries?.files[file], after = postStatusEntries?.files[file];
      return { path: file, kind: !before ? "added" : !after ? "deleted" : "modified", before, after };
    }),
    effectObservation: { status: observationStatus },
    provider: result.provider,
    model: result.model,
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

  // Retain chronological byte observations even when a continuation rejects
  // or exhausts its context. An unavailable boundary never means zero effects.
  let settledSnapshot = postStatusEntries;
  const observeRecovery = (next: ExecutorOutput): ExecutorOutput => {
    const before = settledSnapshot;
    const after = captureGitStatusEntries(params.cwd);
    settledSnapshot = after;
    const changedFiles = diffGitStatusEntries(before, after);
    const status = !before || !after ? "unknown"
      : before.truncated || after.truncated || [...before.omitted, ...after.omitted].some(entry => entry.reason !== "excluded") ? "partial" : "complete";
    return { ...next, effectSnapshots: [{ before, after }],
      filesChanged: changedFiles?.length, changedFiles, effectObservation: { status },
      effectChanges: changedFiles?.map(file => {
        const pre = before?.files[file], post = after?.files[file];
        return { path: file, kind: !pre ? "added" : !post ? "deleted" : "modified", before: pre, after: post };
      }) };
  };
  const recoverBySplit = async (): Promise<ExecutorOutput> => {
    const next = await trySplitAndExecute(
      state, params, agents, task, plan, output.output,
      signal, emit, inheritedModel, budget, maxDepth,
    );
    return mergeExecutorOutputs(output, next.effectSnapshots?.length ? next : observeRecovery(next));
  };

  // Tier 2: Handoff continuation (CONTINUE)
  if (state.recoveryDepth < maxDepth && state.spawnedCount < params.maxSubagents) {
    emit("Task " + task.id + ": attempting handoff continuation (CONTINUE)...");

    const contract = tryReadContinuationContract(task.id, params.cwd);
    const continuationPrompt = `${bindingPromptPreamble(state.intake!)}\n\n${buildExecutorContinuationPrompt({
      taskId: task.id,
      taskDescription: task.description,
      contract: contract ?? undefined,
      priorOutput: result.text,
    })}`;

    let continueResult: SubagentResult;
    try {
      continueResult = await spawnChecked(
        state, params, agents, params.executorAgent,
        continuationPrompt, signal, emit, inheritedModel,
        toModelOverride(params.executorModel, params.executorProvider),
        undefined,
        true,
      );
    } catch (error) {
      emit("Task " + task.id + ": handoff continuation spawn failed — escalating to split.");
      state.recoveryLog.push(
        "[RECOVERY] " + task.id + ": CONTINUE spawn failed — escalating to SPLIT.",
      );
      output = mergeExecutorOutputs(output, observeRecovery({
        taskId: task.id, description: task.description, agentName: params.executorAgent,
        output: "Continuation spawn error: " + String(error), stderr: String(error), exitCode: 1, durationMs: 0,
      }));
      return recoverBySplit();
    }

    output = mergeExecutorOutputs(output, observeRecovery({
      taskId: task.id, description: task.description, agentName: continueResult.agentName,
      output: "## CONTINUATION\n" + continueResult.text, stderr: continueResult.stderr || undefined,
      exitCode: continueResult.exitCode, durationMs: continueResult.durationMs,
      contextBudget: budget, truncated: continueResult.truncated,
      contextExhaustionSignal: continueResult.contextExhaustionSignal,
      toolCalls: continueResult.toolCalls, actionEvidence: continueResult.actionEvidence,
      commandTimes: continueResult.commandTimes,
      provider: continueResult.provider, model: continueResult.model,
    }));
    if (!checkContextExhaustion(continueResult)) {
      emit("Task " + task.id + ": handoff continuation succeeded.");
      state.recoveryLog.push(
        "[RECOVERY] " + task.id + ": CONTINUE tier succeeded.",
      );
      return output;
    }

    emit("Task " + task.id + ": handoff continuation also exhausted — escalating to split.");
    state.recoveryLog.push(
      "[RECOVERY] " + task.id + ": CONTINUE exhausted — escalating to SPLIT.",
    );
  }

  return recoverBySplit();
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
  let settledSnapshot = captureGitStatusEntries(params.cwd);
  const observeSubtask = (next: ExecutorOutput): ExecutorOutput => {
    const before = settledSnapshot;
    const after = captureGitStatusEntries(params.cwd);
    settledSnapshot = after;
    const changedFiles = diffGitStatusEntries(before, after);
    const status = !before || !after ? "unknown"
      : before.truncated || after.truncated || [...before.omitted, ...after.omitted].some(entry => entry.reason !== "excluded") ? "partial" : "complete";
    return { ...next, effectSnapshots: [{ before, after }], filesChanged: changedFiles?.length, changedFiles,
      effectObservation: { status }, effectChanges: changedFiles?.map(file => {
        const pre = before?.files[file], post = after?.files[file];
        return { path: file, kind: !pre ? "added" : !post ? "deleted" : "modified", before: pre, after: post };
      }) };
  };

  for (const subtask of split.subtasks) {
    if (state.spawnedCount >= params.maxSubagents) {
      emit(
        "Task " + task.id + ": spawn ceiling reached mid-split (" +
        state.spawnedCount + "/" + params.maxSubagents + ") — stopping subtask chain.",
      );
      break;
    }

    const subtaskPrompt = `${bindingPromptPreamble(state.intake!)}\n\n${buildSubtaskExecutorPrompt(
      subtask,
      task.description,
      partialOutput,
      split.metadata,
    )}`;

    let subtaskResult: SubagentResult;
    try {
      subtaskResult = await spawnChecked(
        state, params, agents, params.executorAgent,
        subtaskPrompt, signal, emit, inheritedModel,
        toModelOverride(params.executorModel, params.executorProvider),
        undefined,
        true,
      );
    } catch (err) {
      emit("Task " + task.id + ": subtask " + subtask.id + " spawn failed — " + String(err));
      subtaskOutputs.push(observeSubtask({
        taskId: subtask.id,
        description: subtask.description,
        agentName: params.executorAgent,
        output: "Subtask spawn failed: " + String(err),
        exitCode: 1,
        durationMs: 0,
        contextBudget: budget,
      }));
      continue;
    }

    subtaskOutputs.push(observeSubtask({
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
      toolCalls: subtaskResult.toolCalls,
      actionEvidence: subtaskResult.actionEvidence,
      commandTimes: subtaskResult.commandTimes,
      provider: subtaskResult.provider,
      model: subtaskResult.model,
    }));

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
  const observedRouteOutput = subtaskOutputs.find((item) => item.provider || item.model);
  const effects = subtaskOutputs.reduce(mergeExecutorOutputs);

  state.recoveryLog.push(
    "[RECOVERY] " + task.id + ": SPLIT tier completed — " +
    subtaskOutputs.length + " subtask(s), all_clean=" + allClean,
  );

  return {
    ...effects,
    taskId: task.id,
    description: task.description,
    agentName: params.executorAgent,
    output: chainedOutput,
    exitCode: allClean ? 0 : 1,
    durationMs: totalDuration,
    contextBudget: budget,
    toolCalls: subtaskOutputs.reduce<ToolCallSummary | undefined>((ledger, item) => sumToolCallSummaries(ledger, item.toolCalls), undefined),
    actionEvidence: subtaskOutputs.reduce<ActionEvidenceLedger | undefined>((ledger, item) => mergeActionEvidenceLedgers(ledger, item.actionEvidence), undefined),
    commandTimes: mergeCommandTimes(...subtaskOutputs.map(item => item.commandTimes)),
    provider: observedRouteOutput?.provider,
    model: observedRouteOutput?.model,
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
export function checkContextExhaustion(result: SubagentResult): boolean {
  // Structured transport evidence is authoritative even if the child process
  // happened to exit cleanly after publishing a partial result.
  if (result.truncated || result.contextExhaustionSignal) return true;

  const text = result.text ?? "";
  if (!text.trim()) return true;

  // A non-empty exit-0 SubagentResult is produced only after the host observes
  // a complete terminal assistant result. Settle that protocol result before
  // inspecting ordinary report prose (which may legitimately discuss output
  // that was "truncated" or a diagnostic timeout that was "exceeded").
  if (result.exitCode === 0) return false;

  const truncationSignals: RegExp[] = [
    /\b(?:truncated|cut off|too long)\b/i,
    /\b(?:context(?: window| length| limit)?|token(?: budget| limit)?|output limit)\b[^\r\n.]{0,80}\b(?:exceeded|exhausted|reached)\b/i,
    /\b(?:ran out of|out of)\s+(?:context|tokens?)\b/i,
    /\.\.\.\s*$/m,
    /(?:content|output|response)\s+(?:has been|was)\s+truncated/i,
    /\b(?:transport|stream|connection)\b[^\r\n.]{0,80}\b(?:ended|closed|failed|lost|interrupted)\b[^\r\n.]{0,80}\b(?:before|without)\b[^\r\n.]{0,40}\b(?:completion|complete|final|result)\b/i,
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
  const changedFiles = first.changedFiles || second.changedFiles
    ? [...new Set([...(first.changedFiles ?? []), ...(second.changedFiles ?? [])])] : undefined;
  const observedCount = first.changedFiles && second.changedFiles
    ? changedFiles!.length : (first.filesChanged ?? 0) + (second.filesChanged ?? 0);
  // Known positive evidence survives; unknown plus zero is never proven zero.
  const firstWindows = first.effectSnapshots ?? [], secondWindows = second.effectSnapshots ?? [];
  const before = secondWindows[0]?.before, after = firstWindows.at(-1)?.after;
  const continuous = before != null && after != null && JSON.stringify(before) === JSON.stringify(after);
  const complete = continuous && first.effectObservation?.status === "complete" && second.effectObservation?.status === "complete";
  const filesChanged = observedCount > 0 ? observedCount
    : complete && first.filesChanged === 0 && second.filesChanged === 0 ? 0 : undefined;
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
    actionEvidence: mergeActionEvidenceLedgers(first.actionEvidence, second.actionEvidence),
    commandTimes: mergeCommandTimes(first.commandTimes, second.commandTimes),
    filesChanged,
    effectObservation: { status: complete ? "complete" : "partial" },
    effectChanges: first.effectChanges || second.effectChanges ? [...(first.effectChanges ?? []), ...(second.effectChanges ?? [])] : undefined,
    effectSnapshots: first.effectSnapshots || second.effectSnapshots ? [...(first.effectSnapshots ?? []), ...(second.effectSnapshots ?? [])] : undefined,
    changedFiles,
    provider: second.provider ?? first.provider,
    model: second.model ?? first.model,
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
  abortSurvival?: {
    resultFile: string;
    manifestFile: string;
    phaseName?: string;
    phaseIndex?: number;
    settleOnAbort?: boolean;
    abandonSignal?: AbortSignal;
    onSettling?: (info: SupervisedSettlementInfo) => void;
  },
  phaseMutates = false,
  verifierReadOnly = false,
  recoveryRole?: "planner" | "verifier",
): Promise<SubagentResult> {
  // Semantic role, not profile-name coincidence, owns recovery and routing.
  const role = phaseMutates ? undefined : recoveryRole ?? (verifierReadOnly ? "verifier" : undefined);
  const launch = async (prompt: string, stage: RoleRecoveryStage = "initial", index = 0, planning = false): Promise<SubagentResult> => {
    if (state.spawnedCount >= params.maxSubagents) throw new Error(`Subagent ceiling exceeded: already spawned ${state.spawnedCount}/${params.maxSubagents}.`);
    state.spawnedCount++;
    const name = planning ? params.plannerAgent : agentName;
    onProgress?.(`Spawning subagent ${name} (${state.spawnedCount}/${params.maxSubagents}) in ${params.cwd}`);
    const phaseLogIndex = abortSurvival?.phaseIndex ?? state.spawnedCount - 1;
    const baseName = abortSurvival?.phaseName ?? name;
    const phaseLogName = index === 0 ? baseName : `${baseName}-role-recovery-${index}-${stage}`;
    const timedPrompt = role === "verifier" && !planning ? `${prompt}\n\nHOST-OWNED COMMAND TIMING (measurements, not worker claims):\n${JSON.stringify(getCommandTimesForRun(state.runId))}` : prompt;
    const operation = () => runSubagent(name, timedPrompt, {
      agents, cwd: params.cwd, allowLocalModel: params.allowLocalModel, signal, inheritedModel, onProgress,
      modelOverride: planning ? toModelOverride(params.plannerModel, params.plannerProvider) : modelOverride,
      phaseLogFile: phaseLogPathFor(state.runId, phaseLogIndex, phaseLogName),
      phaseResultFile: phaseResultPathFor(state.runId, phaseLogIndex, phaseLogName),
      commandTimingContext: { runId: state.runId, role: planning ? "planner" : role ?? "executor", phase: phaseLogIndex, stage },
      // Intermediate shards settle instead of publishing raw detached shards
      // into the parent's terminal checkpoint/survivor slot.
      ...(abortSurvival ? { abortSurvival: role ? { ...abortSurvival, settleOnAbort: true } : abortSurvival } : {}),
      phaseMutates, readOnly: planning || verifierReadOnly,
      verifier: role === "verifier" && !planning,
      ...(role ? { recoverableRole: planning ? "planner" as const : role } : {}),
      workerExecutionConstraints: params.workerExecutionConstraints,
    });
    return role ? observeRoleReadOnlyLaunch(params.cwd, params.externalEvidenceRoots ?? [], operation) : operation();
  };
  if (!role) return launch(task);
  const request = createRoleRecoveryRequest({ role, prompt: task, acceptanceCriteria: state.intake?.successCriteria, allowReplan: params.paradigm !== "verify-only" });
  const result = await runRoleWithRecovery(request, {
    launch: (prompt, stage, index) => launch(prompt, stage, index),
    ...(request.sourceOptions.allowReplan ? { launchPlanner: (prompt: string, stage: RoleRecoveryStage, index: number) => launch(prompt, stage, index, true) } : {}),
    canLaunch: () => state.spawnedCount < params.maxSubagents, signal, onProgress,
  });
  if (result.roleRecovery) state.recoveryLog?.push(`Role recovery ${role}: terminal validated after ${result.roleRecovery.steps.map(step => `${step.stage}/${step.outcome}`).join(", ")}.`);
  return result;
}

function resolveNamedRoleRoute(
  agents: Map<string, AgentProfile>,
  agentName: string,
  model?: string,
  provider?: string,
): RoleModelOverride {
  const profile = agents.get(agentName);
  return {
    model: model ?? profile?.model,
    provider: provider ?? profile?.provider,
    modelIsPiDefault: model === undefined && profile?.modelIsPiDefault === true,
    providerIsPiDefault: provider === undefined && profile?.providerIsPiDefault === true,
  };
}

export function resolveConfiguredRoleDefaults(
  params: Pick<NormalizedParams, "plannerAgent" | "executorAgent" | "verifierAgent"> & { cwd?: string },
  agents: Map<string, AgentProfile>,
): void {
  const settings = SettingsManager.create(params.cwd ?? process.cwd(), getAgentDir());
  const piDefault = {
    provider: settings.getDefaultProvider(),
    model: settings.getDefaultModel(),
  };

  // Put current Pi defaults on the named role profiles rather than params.
  // Params remain true explicit/NL overrides, so shapes with their own fixed
  // route defaults are not accidentally overridden by the global Pi route.
  for (const agentName of new Set([params.plannerAgent, params.executorAgent, params.verifierAgent])) {
    const profile = agents.get(agentName) ?? { name: agentName };
    agents.set(agentName, {
      ...profile,
      model: profile.model ?? piDefault.model,
      provider: profile.provider ?? piDefault.provider,
      modelIsPiDefault: profile.model === undefined && piDefault.model !== undefined,
      providerIsPiDefault: profile.provider === undefined && piDefault.provider !== undefined,
    });
  }
}

export async function loadAgents(): Promise<Map<string, AgentProfile>> {
  const agents = new Map<string, AgentProfile>();
  for (const agent of DEFAULT_AGENTS) agents.set(agent.name, agent);

  const agentRoot = getAgentDir();
  const agentsDir = path.join(agentRoot, "agents");
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
    /** Host-owned raw stdout/stderr streaming log. */
    commandTimingContext?: CommandTimingContext;
    commandTimingClocks?: CommandTimingClocks;
    commandTimingPrior?: CommandTimes;
    phaseLogFile?: string;
    /** Host-owned incremental heartbeat and terminal-result publication. */
    phaseResultFile?: string;
    /**
     * Abort-survivor mode (ABORT-RESUME-DESIGN.md): when the AbortSignal fires,
     * detach the child instead of killing it — persist a survivor manifest,
     * reject with SubagentDetachedError, and background-write the full result to
     * `resultFile` when the child eventually closes. Opt-in per spawn; spawns
     * without this option keep exact kill-on-abort semantics.
     */
    abortSurvival?: {
      resultFile: string;
      manifestFile: string;
      phaseName?: string;
      phaseIndex?: number;
      settleOnAbort?: boolean;
      /** Separate, explicit second-Escape authority; the first signal only waits. */
      abandonSignal?: AbortSignal;
      onSettling?: (info: SupervisedSettlementInfo) => void;
    };
    /** See SpawnSubagentOptions.phaseMutates in substrate.ts. */
    phaseMutates?: boolean;
    /** Capability-fence this phase to the shared evidence-only tool allowlist. */
    readOnly?: boolean;
    /** Give a verifier bash plus inspection tools while edit/write remain absent. */
    verifier?: boolean;
    /** Enables typed, settled context exhaustion for role recovery only. */
    recoverableRole?: "planner" | "verifier";
    /** Internal recursion fence for the single provider-refusal retry. */
    providerRefusalRetryAttempt?: 0 | 1;
    /** Frozen worker policy; loads only the narrow dispatch guard when opted in. */
    workerExecutionConstraints?: WorkerExecutionConstraints;
  },
): Promise<SubagentResult> {
  const startedAt = Date.now();
  appendSubagentPhaseLog(options.phaseLogFile, "host", `started=${new Date(startedAt).toISOString()} agent=${agentName}`);
  const loadedProfile = options.agents.get(agentName) ?? { name: agentName };
  const profile: AgentProfile = {
    ...loadedProfile,
    provider: options.modelOverride?.provider ?? loadedProfile.provider ?? options.inheritedModel?.provider,
    model: options.modelOverride?.model ?? loadedProfile.model ?? options.inheritedModel?.model,
    providerIsPiDefault: options.modelOverride?.provider !== undefined
      ? options.modelOverride.providerIsPiDefault === true
      : loadedProfile.provider !== undefined && loadedProfile.providerIsPiDefault === true,
    modelIsPiDefault: options.modelOverride?.model !== undefined
      ? options.modelOverride.modelIsPiDefault === true
      : loadedProfile.model !== undefined && loadedProfile.modelIsPiDefault === true,
    ...(options.verifier
      ? { tools: [...VERIFIER_EVIDENCE_TOOLS] }
      : options.readOnly ? { tools: [...READ_ONLY_EVIDENCE_TOOLS] } : {}),
  };
  rejectLocalModelIfNeeded(profile, options.allowLocalModel);
  const phaseResult = new SubagentPhaseResultRecorder(options.phaseResultFile, profile.name, task, startedAt, undefined, options.commandTimingPrior);
  let tempDir: string | undefined;
  let childCreated = false;
  let launchFailed = false;
  // Publication precedes admission. Cover every preparation failure without
  // taking terminal settlement away from a child that may still be alive.
  try {
    options.onProgress?.(
      `Subagent ${profile.name}: using ${formatRoutedModel(profile.provider, profile.model)}.`,
    );

    const systemPrompt = buildSubagentSystemPrompt(profile);
    const launchPrompt = await resolveCompleteWorkerLaunchPrompt({
      cwd: options.cwd,
      profile,
      appendedSystemPrompt: systemPrompt,
      workerExecutionConstraints: options.workerExecutionConstraints,
    });
    // Keep legacy child arguments and evidence on the same canonical route used
    // by launcher-equivalent admission.
    profile.provider = launchPrompt.provider;
    profile.model = launchPrompt.model;
    assertWorkerPromptFitsCapacity({
      prompt: task,
      completeSystemPrompt: launchPrompt.systemPrompt,
      toolSchemas: launchPrompt.toolSchemas,
      contextWindow: launchPrompt.contextWindow,
      maxOutputTokens: launchPrompt.maxOutputTokens,
      modelId: `${launchPrompt.provider}/${launchPrompt.model}`,
    });
    tempDir = await mkTempDir();
    const testPolicy = materializeFrozenTestAuthorizationPolicy(options.workerExecutionConstraints?.testAuthorization, tempDir, options.cwd);
    const promptFile = path.join(tempDir, `${safeFileName(agentName)}-system-prompt.txt`);
    await writeFile(promptFile, systemPrompt, "utf8");

    const command = resolvePiCommand();
    const args = [
      ...command.argsPrefix,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--extension",
      WORKER_MONITOR_BOOTSTRAP_EXTENSION,
      "--extension",
      WORKER_NO_OUTPUT_MONITOR_EXTENSION,
      ...(options.workerExecutionConstraints?.noForceKill
        ? ["--extension", WORKER_EXECUTION_CONSTRAINTS_EXTENSION]
        : []),
      "--append-system-prompt",
      promptFile,
    ];

    if (profile.provider) args.push("--provider", profile.provider);
    args.push("--model", launchPrompt.modelArgument);
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
    // No-force-kill prompts use stdin so Pi can initialize its explicit guard
    // before model/tool dispatch while avoiding command-line prompt exposure.
    let pipeStdin = options.workerExecutionConstraints?.noForceKill === true;
    if (task.length <= safeArgLen && !pipeStdin) {
      args.push(task);
    } else {
      pipeStdin = true;
      options.onProgress?.(
        options.workerExecutionConstraints?.noForceKill
          ? `Subagent ${profile.name}: piping the prompt so Pi loads the explicit no-force-kill guard before model/tool dispatch.`
          : `Subagent ${profile.name}: prompt size ${task.length} chars exceeds safe arg limit ${safeArgLen}; piping via stdin.`,
      );
    }

    options.onProgress?.(
      `Subagent ${profile.name}: launching ${path.basename(command.command)} ${args.includes("--no-extensions") ? "--no-extensions" : ""} --mode json in ${options.cwd}`,
    );

    const noOutputPhaseRoot = path.dirname(options.phaseResultFile ?? options.phaseLogFile ?? path.join(os.tmpdir(), phaseResult.launchId, "phase.log"));
    const noOutputAlarmAckRoot = path.join(noOutputPhaseRoot, "no-output-alarm-acks");
    const baseSpawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: {
        ...(command.env ?? process.env),
        PI_ORCHESTRATOR_RUN_ID: `legacy-${phaseResult.launchId}`,
        PI_ORCHESTRATOR_WORKER_ID: phaseResult.launchId,
        PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE: testPolicy.file,
        PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256: testPolicy.sha256,
        PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT: path.join(noOutputPhaseRoot, "no-output-evidence"),
        PI_ORCHESTRATOR_ALARM_ACK_ROOT: noOutputAlarmAckRoot,
      },
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: command.shell,
    };
    const launchAttempts = buildWindowsEpermSpawnAttempts(command.command, args, baseSpawnOptions);

    for (let attemptIndex = 0; attemptIndex < launchAttempts.length; attemptIndex++) {
      const launch = launchAttempts[attemptIndex];
      appendSubagentPhaseLog(options.phaseLogFile, "host", `launch-attempt=${attemptIndex + 1} command=${path.basename(launch.command)}`);
      let stderr = "";
      let lastAssistantText = "";
      let settledAssistantText: string | undefined;
      let roleContextExhausted = false;
      let eventCount = 0;
      let killedByAbort = false;
      let agentEnded = false;
      let protocolTimedOut = false;
      let workerGuardAttested = options.workerExecutionConstraints?.noForceKill !== true;
      let workerMonitorAttested = false;
      let guardAttestationBuffer = "";
      let taskDispatched = false;
      let firstJsonProtocolEventSeen = false;
      let firstJsonTimer: NodeJS.Timeout | undefined;
      const firstJsonTimeoutMs = getPiChildFirstJsonTimeoutMs(command.env ?? process.env);
      const markFirstJsonProtocolEvent = () => {
        if (firstJsonProtocolEventSeen) return;
        firstJsonProtocolEventSeen = true;
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
      };
      const assistantFailures: string[] = [];
      let terminalProviderRefusal: ReturnType<typeof classifyProviderRefusal>;
      // A child-level provider retry can legitimately recover after emitting an
      // error message/agent_end pair. Keep those diagnostics as telemetry, but
      // classify settlement from the last assistant result in the retried turn.
      const recoveredAssistantFailures: string[] = [];
      const toolCalls = emptyToolCallSummary();
      const actionEvidence = new ActionEvidenceCollector({
        cancellationJournalFile: path.join(noOutputPhaseRoot, `${phaseResult.launchId}.cancellations.jsonl`),
      });
      const commandTimes = new CommandTimesCollector({
        runId: options.phaseResultFile ? path.dirname(options.phaseResultFile) : undefined,
        role: options.recoverableRole ?? (options.verifier ? "verifier" : profile.name),
        phase: Number(/phase-(\d+)/.exec(path.basename(options.phaseResultFile ?? ""))?.[1]),
        ...options.commandTimingContext, launchId: `${phaseResult.launchId}:${attemptIndex}`,
      }, options.commandTimingClocks);
      let collectorFailure: Error | undefined;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(launch.command, launch.args, launch.options);
        childCreated = true;
        phaseResult.heartbeat(eventCount, child.pid);
        firstJsonTimer = setTimeout(() => {
          protocolTimedOut = true;
          const guarded = options.workerExecutionConstraints?.noForceKill === true;
          const timeoutMessage = guarded
            ? `PI_CHILD_FIRST_JSON_TIMEOUT: no valid JSON protocol event within ${firstJsonTimeoutMs}ms from ${path.basename(launch.command)}; child left untouched by no-force-kill policy.`
            : `PI_CHILD_FIRST_JSON_TIMEOUT: no valid JSON protocol event within ${firstJsonTimeoutMs}ms from ${path.basename(launch.command)}; terminating owned child tree.`;
          stderr += `\n${timeoutMessage}`;
          appendSubagentPhaseLog(options.phaseLogFile, "host", timeoutMessage);
          if (!guarded) {
            try { child.kill("SIGTERM"); } catch {}
            killOwnedProcessTree(child.pid, "first-json-timeout");
          }
        }, firstJsonTimeoutMs);
        firstJsonTimer.unref?.();
      } catch (err) {
        if (isWindowsSpawnEperm(err) && attemptIndex < launchAttempts.length - 1) {
          const next = launchAttempts[attemptIndex + 1];
          options.onProgress?.(
            `Subagent ${profile.name}: Windows spawn EPERM from ${formatSpawnAttempt(launch)}; ` +
              `retrying with ${formatSpawnAttempt(next)}.`,
          );
          continue;
        }
        // Terminal EPERM: capture evidence before throwing.
        const evidence = buildWindowsEpermEvidence(err, launch, options.cwd);
        const evidencePath = await writeWindowsEpermEvidence(evidence);
        const evidenceSuffix = evidencePath ? ` Evidence: ${evidencePath}` : " Evidence capture skipped.";
        throw new Error(formatSpawnFailure(err, launch, options.cwd) + evidenceSuffix);
      }

      const buildResult = (code: number | null, text = lastAssistantText): SubagentResult => {
        const result: SubagentResult = {
          agentName: profile.name,
          task,
          text: text.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          durationMs: Date.now() - startedAt,
          events: eventCount,
          toolCalls,
          actionEvidence: actionEvidence.finalize(),
          commandTimes: mergeCommandTimes(options.commandTimingPrior ?? { schemaVersion: 1, entries: [] }, commandTimes.snapshot(actionEvidence.finalize())),
        };
        if (profile.provider) result.provider = profile.provider;
        if (profile.model) result.model = profile.model;
        if (recoveredAssistantFailures.length > 0) {
          result.recoveredAssistantFailures = [...recoveredAssistantFailures];
        }
        return result;
      };
      const heartbeatTimer = setInterval(() => phaseResult.heartbeat(eventCount, child.pid), 5_000);
      heartbeatTimer.unref?.();
      child.once("close", (code) => {
        clearInterval(heartbeatTimer);
        if (code === 0 && settledAssistantText !== undefined && !roleContextExhausted && !protocolTimedOut && !killedByAbort && !collectorFailure) {
          try { phaseResult.complete(buildResult(code, settledAssistantText), assistantFailures); }
          catch (error) {
            collectorFailure = error instanceof Error ? error : new Error(String(error));
            phaseResult.incomplete(`ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
          }
        } else {
          const reason = collectorFailure ? `ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`
            : roleContextExhausted ? "role worker exhausted context; partial output is not terminal" : code === 0
              ? "child closed without a complete assistant result"
              : `child exited with code ${String(code)}`;
          try { phaseResult.incomplete(reason, actionEvidence.finalize()); }
          catch (error) {
            // Preserve the original rejection if final evidence is also lost.
            collectorFailure ??= error instanceof Error ? error : new Error(String(error));
            phaseResult.incomplete(`ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
          }
        }
      });

      const dispatchTask = (): void => {
        if (!pipeStdin || !child.stdin || taskDispatched) return;
        taskDispatched = true;
        child.stdin.on("error", () => {});
        child.stdin.end(task);
      };

      // Abort-survivor plumbing (ABORT-RESUME-DESIGN.md), ported from the
      // substrate spawn so the inline plan-execute-verify path can detach and
      // resume. detachReject unwinds the awaiting promise; the background
      // close-handler persists the final result.
      let detachReject: ((err: SubagentDetachedError) => void) | undefined;
      const detachPromise = new Promise<never>((_resolve, reject) => {
        detachReject = reject;
      });
      detachPromise.catch(() => {});

      let confirmedAbandon = false;
      const terminateOwnedChild = () => {
        killedByAbort = true;
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
        try { child.kill("SIGTERM"); } catch {}
        killOwnedProcessTree(child.pid, "abort");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          killOwnedProcessTree(child.pid, "abort-hard-kill");
        }, 2000).unref?.();
      };
      const abortHandler = () => {
        const survival = options.abortSurvival;
        if (options.recoverableRole || survival?.settleOnAbort) {
          phaseResult.heartbeat(eventCount, child.pid);
          survival?.onSettling?.({
            phase: survival?.phaseName ?? "(unnamed)",
            agentName: profile.name,
            ...(child.pid ? { pid: child.pid } : {}),
          });
          options.onProgress?.(
            `Subagent ${profile.name}: pause acknowledged while ${survival?.phaseName ?? "active phase"} pid=${child.pid} is live; waiting for durable settlement before pausing. Escape again requires explicit confirmation because abandonment can leave partial files.`,
          );
          return;
        }
        if (survival) {
          const manifest = {
            pid: child.pid,
            agentName: profile.name,
            phaseName: survival.phaseName ?? "(unnamed)",
            phaseIndex: survival.phaseIndex ?? -1,
            startedAt,
            detachedAt: new Date().toISOString(),
            resultFile: survival.resultFile,
          };
          try {
            writeFileSync(survival.manifestFile, JSON.stringify(manifest, null, 2), "utf8");
          } catch {}
          child.once("close", (code) => {
            try {
              const backgroundResult: SubagentResult = {
                agentName: profile.name,
                task,
                text: lastAssistantText.trim(),
                stderr: stderr.trim(),
                exitCode: code,
                durationMs: Date.now() - startedAt,
                events: eventCount,
                toolCalls,
                actionEvidence: actionEvidence.finalize(),
                commandTimes: mergeCommandTimes(options.commandTimingPrior ?? { schemaVersion: 1, entries: [] }, commandTimes.snapshot(actionEvidence.finalize())),
              };
              if (profile.provider) backgroundResult.provider = profile.provider;
              if (profile.model) backgroundResult.model = profile.model;
              writeFileSync(survival.resultFile, JSON.stringify(backgroundResult, null, 2), "utf8");
            } catch (error) {
              collectorFailure = error instanceof Error ? error : new Error(String(error));
              appendSubagentPhaseLog(options.phaseLogFile, "host", `ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
            }
          });
          detachReject?.(new SubagentDetachedError(profile.name, manifest));
          return;
        }
        terminateOwnedChild();
      };
      const abandonHandler = () => {
        const survival = options.abortSurvival;
        if (!survival?.settleOnAbort || killedByAbort) return;
        confirmedAbandon = true;
        options.onProgress?.(
          `Subagent ${profile.name}: supervisor confirmed abandonment of ${survival.phaseName ?? "active phase"}; interrupting now with partial-file risk acknowledged.`,
        );
        terminateOwnedChild();
      };
      if (options.signal) {
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener("abort", abortHandler, { once: true });
      }
      if (options.abortSurvival?.abandonSignal) {
        if (options.abortSurvival.abandonSignal.aborted) abandonHandler();
        else options.abortSurvival.abandonSignal.addEventListener("abort", abandonHandler, { once: true });
        child.once("close", () => options.abortSurvival?.abandonSignal?.removeEventListener("abort", abandonHandler));
      }

      if (!child.stdout) throw new Error(`PI_CHILD_STDOUT_UNAVAILABLE: ${profile.name}`);
      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        appendSubagentPhaseLog(options.phaseLogFile, "stdout", line);
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed);
          if (isPiJsonProtocolEvent(event)) markFirstJsonProtocolEvent();
          eventCount++;
          // Authority must see every event before any additive timing parser or
          // publication can fail. Timing idempotence never skips validation.
          try { if (!collectorFailure) actionEvidence.observe(event); }
          catch (error) {
            collectorFailure = error instanceof Error ? error : new Error(String(error));
            appendSubagentPhaseLog(options.phaseLogFile, "host", `ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
          }
          let timingChanged = false;
          try { timingChanged = commandTimes.observe(event); }
          catch {
            commandTimes.markUnavailable();
            timingChanged = true;
            // Parser errors may include worker secrets; persist only safe state.
            appendSubagentPhaseLog(options.phaseLogFile, "host", "COMMAND_TIMES_UNAVAILABLE: timing observation failed; authoritative evidence remains required.");
          }
          if (timingChanged) phaseResult.publishCommandTimes(commandTimes.snapshot());
          phaseResult.observeEvent(event);
          const progress = describeJsonEvent(profile.name, event);
          if (progress) options.onProgress?.(progress);
          if (!collectorFailure) acknowledgeNoOutputAlarm(event, noOutputAlarmAckRoot);
          if (event?.type === "tool_execution_start") {
            const toolName = optionalString((event as Record<string, unknown>).toolName);
            if (toolName) recordToolCall(toolCalls, toolName);
          }
          // `agent_end` terminates one child attempt, not necessarily the whole
          // turn. Pi marks retryable attempt endings with willRetry=true and may
          // additionally emit auto_retry_end after the successful replacement.
          if (options.recoverableRole && (event?.type === "agent_start" || (event?.type === "compaction_end" && event.willRetry === true))) {
            if (roleContextExhausted) recoveredAssistantFailures.push("role_context_exhaustion_auto_recovered");
            recoveredAssistantFailures.push(...assistantFailures);
            assistantFailures.length = 0;
            roleContextExhausted = false;
            agentEnded = false;
            settledAssistantText = undefined;
          }
          if (event?.type === "agent_end") {
            if ((event as { willRetry?: boolean }).willRetry === true) {
              if (roleContextExhausted) recoveredAssistantFailures.push("role_context_exhaustion_auto_recovered");
              recoveredAssistantFailures.push(...assistantFailures);
              assistantFailures.length = 0;
              roleContextExhausted = false;
              agentEnded = false;
            } else {
              agentEnded = true;
            }
          }
          if (event?.type === "auto_retry_end" && (event as { success?: boolean }).success === true) {
            if (roleContextExhausted) recoveredAssistantFailures.push("role_context_exhaustion_auto_recovered");
            recoveredAssistantFailures.push(...assistantFailures);
            assistantFailures.length = 0;
            roleContextExhausted = false;
            agentEnded = false;
          }
          if (event?.type === "message_end" && event.message?.role === "assistant" && !agentEnded) {
            lastAssistantText = extractMessageText(event.message);
            const stopReason = optionalString(event.message.stopReason) ?? optionalString(event.stopReason);
            const errorMessage =
              optionalString(event.message.errorMessage) ??
              optionalString(event.errorMessage) ??
              optionalString(event.message.error?.message) ??
              optionalString(event.error?.message);
            const normalizedStopReason = stopReason?.toLowerCase();
            if (options.recoverableRole && (isRoleContextExhaustion(stopReason, errorMessage) || isRoleRecoveryHandoff(lastAssistantText, options.recoverableRole))) roleContextExhausted = true;
            if (normalizedStopReason === "error" || normalizedStopReason === "aborted") {
              assistantFailures.push(`assistant stopReason=${stopReason}`);
            } else if (
              lastAssistantText.trim() &&
              (normalizedStopReason === "stop" || normalizedStopReason === "end_turn" || normalizedStopReason === "completed")
            ) {
              settledAssistantText = lastAssistantText;
            }
            if (errorMessage) assistantFailures.push(`assistant errorMessage=${errorMessage}`);
            terminalProviderRefusal = classifyProviderRefusal(event) ?? terminalProviderRefusal;
          }
          phaseResult.heartbeat(eventCount, child.pid);
        } catch {
          // JSON mode should emit JSONL; ignore any incidental non-JSON line defensively.
        }
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        const attestationCandidate = guardAttestationBuffer + text;
        if (!workerMonitorAttested && attestationCandidate.includes(NO_OUTPUT_MONITOR_READY_MARKER)) workerMonitorAttested = true;
        if (!workerGuardAttested && attestationCandidate.includes(NO_FORCE_KILL_GUARD_READY_MARKER)) {
          workerGuardAttested = true;
          dispatchTask();
        }
        guardAttestationBuffer = attestationCandidate.slice(-512);
        stderr += text;
        appendSubagentPhaseLog(options.phaseLogFile, "stderr", text);
        phaseResult.heartbeat(eventCount, child.pid);
      });

      dispatchTask();
      // Pi loads explicit extensions before model/tool dispatch. Releasing stdin
      // here avoids its prompt-before-extension-error startup deadlock; the host
      // still fails closed below unless the guard attests before child exit.

      let exitCode: number | null;
      try {
        exitCode = await Promise.race([
          new Promise<number | null>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => resolve(code));
          }),
          detachPromise,
        ]);
      } catch (err) {
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
        if (options.signal) options.signal.removeEventListener("abort", abortHandler);
        if (err instanceof SubagentDetachedError) {
          // Do NOT close stdoutReader: background collectors keep accumulating
          // until the orphaned child closes and writes its result file.
          options.onProgress?.(
            `Subagent ${profile.name}: DETACHED on abort (pid=${err.manifest.pid}); ` +
              `result will be persisted to ${err.manifest.resultFile}.`,
          );
          throw err;
        }
        stdoutReader.close();
        if (isWindowsSpawnEperm(err) && attemptIndex < launchAttempts.length - 1) {
          phaseResult.retry();
          const next = launchAttempts[attemptIndex + 1];
          options.onProgress?.(
            `Subagent ${profile.name}: Windows spawn EPERM from ${formatSpawnAttempt(launch)}; ` +
              `retrying with ${formatSpawnAttempt(next)}.`,
          );
          continue;
        }
        // Terminal EPERM: capture evidence before throwing.
        const evidence = buildWindowsEpermEvidence(err, launch, options.cwd);
        const evidencePath = await writeWindowsEpermEvidence(evidence);
        const evidenceSuffix = evidencePath ? ` Evidence: ${evidencePath}` : " Evidence capture skipped.";
        throw new Error(formatSpawnFailure(err, launch, options.cwd) + evidenceSuffix);
      }

      if (firstJsonTimer) clearTimeout(firstJsonTimer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
      stdoutReader.close();

      const buildCandidate = (): SubagentResult => buildResult(exitCode);
      const throwAmbiguousIfMutating = (errorMessage: string): void => {
        const mutatingEvidence = options.phaseMutates === true || toolCalls.mutating > 0;
        if (!mutatingEvidence) return;
        const candidate = lastAssistantText.trim() ? buildCandidate() : undefined;
        throw new SubagentTerminalAmbiguousError(profile.name, {
          code: candidate ? "AMBIGUOUS_COMPLETION" : "RESULT_LOST_AFTER_MUTATION",
          resultLost: !candidate,
          errorMessage,
          exitCode,
          stderr: stderr.trim(),
          assistantFailures: [...assistantFailures],
          ...(candidate ? { candidate } : {}),
        });
      };

      if (collectorFailure) {
        throw new Error(`ACTION_EVIDENCE_PERSISTENCE_FAILED: ${collectorFailure.message}`);
      }
      if (!workerMonitorAttested) {
        throw new Error(`NO_OUTPUT_MONITOR_NOT_LOADED: ${agentName} did not attest the explicitly loaded command monitor.`);
      }
      if (!workerGuardAttested) {
        throw new Error(`NO_FORCE_KILL_GUARD_NOT_LOADED: ${agentName} did not attest the explicitly loaded bash timeout interceptor.`);
      }
      if (roleContextExhausted && !killedByAbort && !protocolTimedOut) throw new RoleContextExhaustionError(buildCandidate());
      const durableResult = phaseResult.readComplete();
      if (!killedByAbort && !protocolTimedOut && durableResult) {
        if (assistantFailures.length > 0) {
          options.onProgress?.(
            `Subagent ${profile.name}: transport failed after a complete host-owned phase result; recovered ${phaseResult.file}.`,
          );
        }
        return durableResult;
      }
      if (killedByAbort) {
        if (confirmedAbandon) throw new ConfirmedSupervisedAbandonError(options.abortSurvival?.phaseName ?? agentName);
        throw new Error(`Subagent ${agentName} aborted.`);
      }
      const providerRefusal = terminalProviderRefusal
        ?? classifyProviderRefusal(assistantFailures.join("; "))
        ?? classifyProviderRefusal(stderr);
      if (providerRefusal) {
        const retryAttempt = options.providerRefusalRetryAttempt ?? 0;
        const retryEligible = isProvablyReadOnlySubagent(options.readOnly, profile.tools) && toolCalls.mutating === 0;
        if (retryEligible && retryAttempt === 0) {
          options.onProgress?.(`Subagent ${profile.name}: provider refused the read-only review; retrying once with defensive evidence-only wording.`);
          const retried = await runSubagent(agentName, buildProviderRefusalRetryPrompt(task), {
            ...options,
            providerRefusalRetryAttempt: 1,
            commandTimingPrior: mergeCommandTimes(options.commandTimingPrior ?? { schemaVersion: 1, entries: [] }, commandTimes.snapshot()),
          });
          retried.commandTimes = mergeCommandTimes(commandTimes.snapshot(actionEvidence.finalize()), retried.commandTimes);
          retried.providerRefusal = {
            ...providerRefusal,
            retryAllowed: true,
            retryEligible: true,
            retryAttempted: true,
            mutationAmbiguous: false,
          };
          return retried;
        }
        throw new ProviderRefusalError(profile.name, {
          providerMessage: providerRefusal.providerMessage,
          retryAllowed: false,
          retryEligible,
          retryAttempted: retryAttempt > 0,
          mutationAmbiguous: !retryEligible,
        });
      }
      if (protocolTimedOut) {
        const message = JSON.stringify({
          type: "pi_child_first_json_timeout",
          agent: agentName,
          timeoutMs: firstJsonTimeoutMs,
          pid: child.pid,
          cwd: options.cwd,
          commandBasename: path.basename(launch.command),
          launchRuntime: command.launchRuntime,
        });
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }
      if (exitCode !== 0) {
        const message = `Subagent ${agentName} exited with code ${exitCode}. stderr: ${truncateWithNotice(stderr.trim(), 2000, "stderr")}`;
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }
      if (assistantFailures.length > 0) {
        const stderrSuffix = stderr.trim() ? ` stderr: ${truncateWithNotice(stderr.trim(), 1000, "stderr")}` : "";
        const message =
          `Subagent ${agentName} reported assistant failure despite exit code 0: ` +
          `${truncateWithNotice(assistantFailures.join("; "), 2000, "assistant failure details")}.${stderrSuffix}`;
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }

      if (recoveredAssistantFailures.length > 0) {
        options.onProgress?.(
          `Subagent ${profile.name}: transient assistant/transport failure(s) auto-recovered by child retry: ` +
            truncateWithNotice(recoveredAssistantFailures.join("; "), 1000, "recovered failure details"),
        );
      }
      return buildCandidate();
    }
    throw new Error(`Subagent ${agentName} did not launch: no spawn attempts were available.`);
  } catch (error) {
    launchFailed = true;
    if (!childCreated) phaseResult.incomplete(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (tempDir !== undefined) {
      try { await rm(tempDir, { recursive: true, force: true }); }
      catch (error) {
        // Cleanup must not replace the original refusal or launch failure.
        if (!launchFailed) throw error;
        appendSubagentPhaseLog(options.phaseLogFile, "host", `launch cleanup failed: ${String(error)}`);
      }
    }
  }
}

/** Direct regression entry point for the legacy launcher; does not start an orchestration. */
export const runLegacySubagentForTest = runSubagent;

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

  if (eventType === "tool_execution_update") {
    const partial = raw.partialResult && typeof raw.partialResult === "object"
      ? raw.partialResult as Record<string, unknown>
      : undefined;
    const details = partial?.details && typeof partial.details === "object"
      ? partial.details as Record<string, unknown>
      : undefined;
    const alarm = details?.noOutputAlarm && typeof details.noOutputAlarm === "object"
      ? details.noOutputAlarm as Record<string, unknown>
      : undefined;
    if (alarm?.type === "command_no_output_alarm") {
      return `COMMAND_NO_OUTPUT_ALARM ${JSON.stringify({
        agentName,
        toolCallId: raw.toolCallId,
        commandId: alarm.commandId,
        invocationId: alarm.invocationId,
        wallTime: alarm.wallTime,
        elapsedMs: alarm.elapsedMs,
        noOutputMs: alarm.noOutputMs,
        eligibility: alarm.eligibility,
      })}`;
    }
  }

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
  const plannerInferredPresentationRules: string[] = [];
  const criteriaProvenance: Intake["criteriaProvenance"] = [];
  const routingRequirements = buildRoutingRequirements(params, agents, inheritedModel);
  const essentialRoutingRequirements = routingRequirements.filter((req) => req.essential);
  const successCriteria = deriveProductAcceptanceCriteria(params.task);
  const deliverables = extractTaskDeliverables(params.task);
  for (const criterion of successCriteria) criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  for (const req of essentialRoutingRequirements) {
    inferredAdvisoryCriteria.push(
      `Host route check: observe ${req.role} (${req.agentName}) using ${formatRoutedModel(req.provider, req.model)} from launcher metadata — advisory to product acceptance.`,
    );
  }
  if (executorOutputContract && executorOutputContractSource === "explicit") {
    const criterion = `Executor outputs must satisfy this output contract: ${executorOutputContract}`;
    successCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "success", source: "explicit" });
  } else if (executorOutputContract) {
    const presentationRule = `(inferred) Executor outputs should follow the output format implied by the task: ${executorOutputContract} — advisory only; violations are warnings, never failures.`;
    inferredAdvisoryCriteria.push(presentationRule);
    plannerInferredPresentationRules.push(presentationRule);
  }
  if (params.plannerCount > 1) {
    inferredAdvisoryCriteria.push(`Host scheduling control: run ${params.plannerCount} planner subagent(s) before deterministic plan selection.`);
  }
  if (params.verifierCount > 1) {
    inferredAdvisoryCriteria.push(`Host scheduling control: run ${params.verifierCount} verifier subagent(s) before deterministic verdict aggregation.`);
  }

  const failureCriteria = extractFailureCriteria(params.task);
  for (const criterion of failureCriteria) criteriaProvenance.push({ text: criterion, kind: "failure", source: "explicit" });
  if (executorOutputContract && executorOutputContractSource === "explicit") {
    const criterion = "Executor output that violates the output contract is a FAIL, even if semantically correct.";
    failureCriteria.push(criterion);
    criteriaProvenance.push({ text: criterion, kind: "failure", source: "explicit" });
  }

  const supervisorAddedConstraints = [
    "Do not reinterpret explicit user constraints as optional preferences.",
    "Do not treat model routing requirements as executor work or product acceptance; they are host-observed advisory facts.",
    "Preserve explicit output-format requirements exactly when provided.",
  ];
  const ownerCriteria = {
    success: [...successCriteria],
    failure: [...failureCriteria],
    ...(executorOutputContractSource === "explicit" && executorOutputContract ? { outputContract: executorOutputContract } : {}),
  };

  return {
    originalTask: params.task,
    taskSummary: summarizeTask(params.task),
    taskType: "deterministic planner/executor/verifier orchestration",
    userIntent: inferIntent(params.task),
    goalAttractor: "A PASS result with executor outputs matching the requested work and all essential constraints visibly satisfied.",
    taskScope: "Only the work described in the original task and normalized intake contract is in scope.",
    constraints,
    invariants: supervisorAddedConstraints,
    successCriteria,
    deliverables,
    failureCriteria,
    nonGoals: extractNonGoals(params.task),
    ambiguities: [],
    routingDecision: essentialRoutingRequirements.length
      ? "Requested routes are configured by the host and checked mechanically from launcher metadata; observations are advisory to the product verdict."
      : "No explicit or inferred essential model routing was requested; use profile/inherited/default routing.",
    routingRequirements,
    orchestrationControls: params.orchestrationControls,
    executorOutputContract,
    executorOutputContractSource,
    inferredAdvisoryCriteria,
    criteriaProvenance,
    ownerCriteria,
    supervisorAddedConstraints,
    plannerInferredPresentationRules,
  };
}

function formatBindingContractForPrompt(intake: Intake): string {
  return JSON.stringify({
    original_task: intake.originalTask,
    owner_criteria: intake.ownerCriteria,
    explicit_constraints: intake.constraints,
    supervisor_safety_invariants: intake.supervisorAddedConstraints,
    success_criteria: intake.successCriteria,
    failure_criteria: intake.failureCriteria,
    named_deliverables: intake.deliverables,
    executor_output_contract: intake.executorOutputContractSource === "explicit" ? intake.executorOutputContract : undefined,
  }, null, 2);
}

function bindingPromptPreamble(intake: Intake): string {
  return `BINDING OWNER INSTRUCTIONS, SAFETY, AND ACCEPTANCE — COMPLETE AND VERBATIM WHERE APPLICABLE:\n${formatBindingContractForPrompt(intake)}\n\nDo not treat later summaries, plans, or non-binding context as permission to weaken, replace, or truncate this section.`;
}

function formatIntakeForPrompt(intake: Intake): string {
  return JSON.stringify({
    task_summary: intake.taskSummary,
    task_type: intake.taskType,
    user_intent: intake.userIntent,
    goal_attractor: intake.goalAttractor,
    task_scope: intake.taskScope,
    constraints: intake.constraints,
    success_criteria: intake.successCriteria,
    deliverables: intake.deliverables,
    non_goals: intake.nonGoals,
    ambiguities: intake.ambiguities,
    routing_decision: intake.routingDecision,
    routing_requirements: intake.routingRequirements,
    orchestration_controls: intake.orchestrationControls,
    owner_criteria: intake.ownerCriteria,
    supervisor_added_constraints: intake.supervisorAddedConstraints,
    planner_inferred_presentation_rules: intake.plannerInferredPresentationRules,
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
      deliverables: intake.deliverables,
      failure_criteria: intake.failureCriteria,
      executor_output_contract: intake.executorOutputContract,
      executor_output_contract_source: intake.executorOutputContractSource,
      owner_criteria: intake.ownerCriteria,
      supervisor_added_constraints: intake.supervisorAddedConstraints,
      planner_inferred_presentation_rules: intake.plannerInferredPresentationRules,
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
  // Reuse the already-suppressed routing computed in normalizeParams. Re-running
  // inferModelRoutingFromTask here would reintroduce NL routes for roles that
  // carry an explicit param, letting a provider-only override recombine with a
  // suppressed NL model (bug: natural-language-route-parser-hijacks-roles-from-task-prose.md).
  const inferredFromTask = params.inferredRouting ?? {};
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
      const requirement: RoutingRequirement = { role: role.role, agentName: role.agentName, provider, model, essential: role.explicit || source === "natural_language", source };
      if (role.role === "planner" && params.plannerCount > 1) requirement.count = params.plannerCount;
      if (role.role === "verifier" && params.verifierCount > 1) requirement.count = params.verifierCount;
      if (role.role === "executor" && params.concurrency > 1) requirement.count = params.concurrency;
      return requirement;
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
    const needed = req.role === "executor"
      ? Math.max(1, req.count ?? state.executorOutputs.length)
      : req.role === "planner"
        ? Math.max(1, req.count ?? params.plannerCount)
        : req.role === "verifier"
          ? Math.max(1, req.count ?? params.verifierCount)
          : 1;
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

/** Broad host-supervision classifier; conservative because a false read-only classification can mutate without checkpoints. */
function isSupervisedImplementationRequest(description: string): boolean {
  return /\b(CREATE|IMPLEMENT|BUILD|MODIFY|ADD|WRITE|GENERATE|EDIT|CHANGE|FIX|PATCH|UPDATE|DELETE|REMOVE|REFACTOR|MIGRATE|INSTALL|CODE)\b/i.test(description);
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
export function detectExecutorOutputQualityFailures(
  executorOutputs: ExecutorOutput[],
  artifactEvidence?: ArtifactEvidence,
): string[] {
  const failures: string[] = [];
  for (const output of executorOutputs) {
    const trimmed = output.output.trim();

    // Structured exhaustion always wins, including after an exit-0 process.
    if (output.truncated || output.contextExhaustionSignal) {
      failures.push(output.taskId + ": structured context exhaustion or truncation signal");
      continue;
    }

    // Empty output is not a complete settlement even if the process exited 0.
    if (!trimmed) {
      failures.push(output.taskId + ": empty executor output (possible crash or truncation before any text)");
      output.truncated = true;
      output.contextExhaustionSignal = true;
      continue;
    }

    // An exit-0, non-empty result is a complete host-observed terminal
    // settlement. Only incomplete/nonzero transport may fall back to prose
    // heuristics; ordinary reports often discuss truncated external logs.
    const terminallySettled = output.exitCode === 0;
    if (!terminallySettled) {
      const truncationSignals: RegExp[] = [
        /\b(?:truncated|cut off|too long)\b/i,
        /\b(?:context(?: window| length| limit)?|token(?: budget| limit)?|output limit)\b[^\r\n.]{0,80}\b(?:exceeded|exhausted|reached)\b/i,
        /\b(?:ran out of|out of)\s+(?:context|tokens?)\b/i,
        /\.\.\.\s*$/m,
        /(?:content|output|response)\s+(?:has been|was)\s+truncated/i,
        /\b(?:transport|stream|connection)\b[^\r\n.]{0,80}\b(?:ended|closed|failed|lost|interrupted)\b[^\r\n.]{0,80}\b(?:before|without)\b[^\r\n.]{0,40}\b(?:completion|complete|final|result)\b/i,
      ];
      if (truncationSignals.some((signal) => signal.test(trimmed))) {
        failures.push(output.taskId + ": truncation signal detected");
        output.truncated = true;
        output.contextExhaustionSignal = true;
        continue;
      }

      // Content-shape fallbacks apply only when terminal transport did not
      // settle successfully; they cannot override an authoritative result.
      const lastLine = trimmed.split("\n").filter(Boolean).pop() ?? "";
      const lastChar = lastLine.trim().slice(-1);
      const endsProperly = /[.!?})\\>\`"]$/.test(lastChar) || /\x60\x60\x60$/.test(lastLine.trim());
      if (!endsProperly && trimmed.length > 200) {
        failures.push(output.taskId + ": possible truncation");
        output.truncated = true;
      }

      const openBraces = (trimmed.match(/\{/g) ?? []).length;
      const closeBraces = (trimmed.match(/\}/g) ?? []).length;
      if (openBraces > closeBraces) {
        failures.push(output.taskId + ": possible incomplete JSON");
        output.truncated = true;
      }

      const jsonFenceCount = (trimmed.match(/```json/g) ?? []).length;
      const closeFenceCount = (trimmed.match(/```/g) ?? []).length;
      if (jsonFenceCount > 0 && closeFenceCount < jsonFenceCount * 2) {
        failures.push(output.taskId + ": unclosed JSON code fence");
        output.truncated = true;
      }
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

// NOTE: `normalizeRoutingText` and `modelAliasFromText` were moved VERBATIM to
// src/model-aliases.ts (WAVE3-SPEC ITEM C) to break the composable-pipeline ->
// index.ts circular import. They are imported at the top of this file and
// remain the single source of truth for the known-models alias registry.

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

/**
 * Resolve a structured NL model token ("provider <P> model <T>" / "<P>/<T>")
 * against the known-models alias registry. Returns the canonical alias when the
 * model side (or "<provider> <model>") is recognized, else undefined — so
 * unknown tokens from task prose can never become a route (residual 1).
 */
function knownAliasForStructured(provider: string, model: string): RoleModelOverride | undefined {
  return modelAliasFromText(model) ?? modelAliasFromText(`${provider} ${model}`);
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
  // BUG FIX (2026-07-02 residual 1): the structured "provider <P> model <T>" and
  // "<P>/<T>" forms used to be routed WITHOUT validating the model token against
  // the known-models registry, so ordinary prose ("provider anthropic model today",
  // greedy tails like "today produces NO route change") hijacked a role route.
  // Every structured form must now resolve its model side via modelAliasFromText
  // before it can become a route; unknown tokens are ignored with a logged notice.
  const providerModel = cleaned.match(/^provider\s+([a-z0-9_.-]+)\s+(?:model\s+)?(.+)$/i);
  if (providerModel) {
    const alias = knownAliasForStructured(providerModel[1].trim(), providerModel[2].trim());
    if (alias) return alias;
    noteRejectedNlRouteToken(cleaned);
    return undefined;
  }
  if (!cleaned || cleaned.split(/\s+/).length > 8) return undefined;
  if (!/[a-z0-9]/i.test(cleaned)) return undefined;
  // Structured explicit "provider/model" form: route only when the model side
  // validates against the known-models registry (residual 1).
  const slash = cleaned.indexOf("/");
  if (slash > 0) {
    const provider = cleaned.slice(0, slash).trim();
    const model = cleaned.slice(slash + 1).trim();
    if (provider && model) {
      const alias = knownAliasForStructured(provider, model);
      if (alias) return alias;
      noteRejectedNlRouteToken(cleaned);
      return undefined;
    }
  }
  // BUG FIX (2026-07-02, natural-language-route-parser-hijacks-roles-from-task-prose.md):
  // A bare single token extracted from task prose (e.g. "today", "tomorrow") is
  // NOT a model. Only route it if it validates against the known-models
  // registry (modelAliasFromText / structured provider forms above). Unknown
  // tokens are ignored with a logged notice — never routed — so ordinary prose
  // can no longer hijack a role route (production evidence: run orc-mr43a2em-dvzs,
  // planner routed to anthropic/today → preflight 404).
  noteRejectedNlRouteToken(cleaned);
  return undefined;
}

/** Log a notice that an unroutable natural-language model token was ignored. */
function noteRejectedNlRouteToken(token: string): void {
  if (!token) return;
  try {
    console.warn(`[orchestrate] Ignored unroutable natural-language model token "${token}" (not in known-models registry).`);
  } catch {}
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

/**
 * Preserve explicit numbered product acceptance after a PASS ONLY IF marker.
 * This intentionally handles only the narrow, auditable list form; it stops at
 * the next all-caps contract heading and never substitutes a generic routing
 * criterion for the user's product conditions.
 */
function extractNumberedPassOnlyIfCriteria(task: string): string[] {
  const marker = /PASS\s+ONLY\s+IF\b[^\r\n]*(?:\r?\n|$)/i.exec(task);
  if (!marker) return [];
  const tail = task.slice(marker.index + marker[0].length);
  const lines = tail.split(/\r?\n/);
  const criteria: string[] = [];
  let current = "";
  let sawNumbered = false;
  const flush = () => {
    const value = current.replace(/\s+/g, " ").trim();
    if (value) criteria.push(value);
    current = "";
  };
  for (const line of lines) {
    const numbered = /^\s*\d+[.)]\s+(.+?)\s*$/.exec(line);
    if (numbered) {
      flush();
      sawNumbered = true;
      current = numbered[1];
      continue;
    }
    if (!sawNumbered) {
      if (!line.trim()) continue;
      break;
    }
    if (/^\s*[A-Z][A-Z _-]{3,}:?\s*$/.test(line) || /^\s*(?:FAILURE|NON-GOALS?|OUTPUT|ROUTING)\b[^a-z]*:?\s*$/.test(line)) break;
    if (!line.trim()) {
      flush();
      // A blank after a complete numbered item ends the narrow list unless
      // another numbered item follows; later numbered lines can restart it.
      continue;
    }
    if (!current) break;
    current += ` ${line.trim()}`;
  }
  flush();
  return [...new Set(criteria)];
}

function extractSuccessCriteria(task: string): string[] {
  const criteria: string[] = [];
  const exactResults = task.match(/RESULT\s+task-\d+\s*:\s*[^\n\r]+/gi) ?? [];
  for (const result of exactResults) criteria.push(`Executor output includes exact line: ${result.trim()}`);
  const passOnlyIfCriteria = extractNumberedPassOnlyIfCriteria(task);
  if (passOnlyIfCriteria.length) criteria.push(...passOnlyIfCriteria);
  else if (/pass only if/i.test(task)) criteria.push("Verifier follows the explicit PASS-only-if criteria from the original task.");
  return [...new Set(criteria)];
}

function isHostOrchestrationRequirement(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  return /\b(?:routing|provider|model)\b/i.test(compact) && /\b(?:planner|executor|verifier|subagent|gpt|deepseek|claude|openai|anthropic)\b/i.test(compact)
    || /\b(?:run|spawn|use)\s+(?:exactly\s+)?(?:one|two|three|four|\d+)\s+(?:planner|executor|verifier|subagent)s?\b/i.test(compact)
    || /\b(?:planner|executor|verifier|subagent)s?\b[^.\n]{0,80}\bconcurrent(?:ly|cy)?\b/i.test(compact);
}

function extractNumberedTaskRequirements(task: string): string[] {
  const criteria: string[] = [];
  for (const line of task.split(/\r?\n/)) {
    const match = /^\s*\d+[.)]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const criterion = match[1].replace(/\s+/g, " ").trim();
    if (criterion && !isHostOrchestrationRequirement(criterion)) criteria.push(criterion);
  }
  return [...new Set(criteria)];
}

function productTaskFallback(task: string): string {
  const productLines = task
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*\d+[.)]\s+/, "").trim())
    .filter((line) => line && !/^(?:requirements?|acceptance criteria|success criteria|deliverables?)\s*:$/i.test(line))
    .filter((line) => !isHostOrchestrationRequirement(line));
  return productLines.length > 0
    ? `Original task is satisfied exactly as specified in the complete binding original_task section, including: ${productLines.join(" ")}`
    : "Complete binding original_task requirements are satisfied.";
}

function canonicalExtractedNumericUnit(raw: string | undefined): string {
  const unit = (raw ?? "count").trim().toLowerCase();
  const aliases: Record<string, string> = {
    millisecond: "ms", milliseconds: "ms", msec: "ms",
    second: "s", seconds: "s", sec: "s",
    microsecond: "us", microseconds: "us", "µs": "us", "μs": "us",
    minute: "min", minutes: "min", percent: "%", percentage: "%",
    counts: "count", frame: "frames", frames: "frames", byte: "bytes", bytes: "bytes",
  };
  return aliases[unit] ?? unit;
}

function cleanNumericTargetMetric(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^\s*(?:(?:run\s+)?acceptance\b[^:]{0,240}|success\s+criteria|targets?)\s*:\s*/i, "")
    .replace(/^\s*(?:and|then)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract only owner-authored comparator targets. Bare numbers are deliberately
 * ignored: dates, revisions, hashes, defect labels, route versions, examples,
 * and historical inventories must never become invented product metrics.
 */
export function extractNumericAcceptanceTargets(task: string): NumericAcceptanceTarget[] {
  const results: NumericAcceptanceTarget[] = [];
  const seen = new Set<string>();
  const symbolic = /^(.*?)\s*(<=|>=|==|!=|<|>)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(milliseconds?|msec|ms|seconds?|sec|s|microseconds?|[µμ]s|us|minutes?|min|percent(?:age)?|%|frames?|bytes?|counts?)?\s*[.,]?$/i;
  const verbal = /^(.*?)\s+(at most|no more than|at least|no less than|under|below|over|above|exactly)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(milliseconds?|msec|ms|seconds?|sec|s|microseconds?|[µμ]s|us|minutes?|min|percent(?:age)?|%|frames?|bytes?|counts?)?\s*[.,]?$/i;
  const verbalOperators: Record<string, NumericAcceptanceTarget["op"]> = {
    "at most": "<=", "no more than": "<=", "at least": ">=", "no less than": ">=",
    under: "<", below: "<", over: ">", above: ">", exactly: "==",
  };
  for (const rawSegment of task.split(/(?:[;\r\n]+|(?<=[.!?])\s+)/)) {
    const segment = rawSegment.trim();
    if (!segment || /\b(?:for example|example|e\.g\.|for instance)\b/i.test(segment)) continue;
    if (/\b(?:historical|inventory|observed|previously|prior result|baseline result)\b/i.test(segment) && !/\btargets?\b/i.test(segment)) continue;
    const symbolicMatch = symbolic.exec(segment);
    const verbalMatch = symbolicMatch ? null : verbal.exec(segment);
    const match = symbolicMatch ?? verbalMatch;
    if (!match) continue;
    const metric = cleanNumericTargetMetric(match[1]);
    if (!metric || metric.length > 256
      || /^(?:item|defect|round|task|issue|commit|hash|sha-?256|rev(?:ision)?|route|model|version|gpt|claude|deepseek|astra|sol)\b/i.test(metric)
      || /\b(?:calendar\s+)?(?:date|year|timestamp)\b/i.test(metric)
      || /^[A-Z]{1,4}\d*$/.test(metric)) continue;
    const op = symbolicMatch
      ? symbolicMatch[2] as NumericAcceptanceTarget["op"]
      : verbalOperators[verbalMatch?.[2].toLowerCase() ?? ""];
    const threshold = Number(match[3]);
    if (!op || !Number.isFinite(threshold)) continue;
    const inferredMetricUnit = !match[4]
      ? /\bframes?$/i.test(metric) ? "frames"
        : /\bbytes?$/i.test(metric) ? "bytes"
          : undefined
      : undefined;
    const unit = canonicalExtractedNumericUnit(match[4] ?? inferredMetricUnit);
    const sourceText = `${metric} ${op} ${threshold}${match[4] && unit !== "count" ? ` ${unit}` : ""}`;
    const key = `${metric.toLowerCase()}\u0000${op}\u0000${threshold}\u0000${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ metric, op, threshold, unit, sourceText });
  }
  return results;
}

/** Freeze product-facing acceptance from explicit task text, never host routing/scheduling controls. */
export function deriveProductAcceptanceCriteria(task: string): string[] {
  const explicit = extractSuccessCriteria(task).filter((criterion) => !isHostOrchestrationRequirement(criterion));
  const numbered = extractNumberedTaskRequirements(task);
  const baseCriteria = [...new Set([...explicit, ...numbered])];
  const targets = extractNumericAcceptanceTargets(task);
  const criteria = baseCriteria.length
    ? baseCriteria
    : targets.length
      ? [...targets.map((target) => target.sourceText), productTaskFallback(task)]
      : [productTaskFallback(task)];
  for (const target of targets) {
    const represented = criteria.some((criterion) => criterion.replace(/\s+/g, " ").toLowerCase() === target.sourceText.toLowerCase());
    if (!represented) criteria.push(target.sourceText);
  }
  return [...new Set(criteria)];
}

/**
 * Bind extracted task targets to stable criteria. A caller-supplied gate keeps
 * its host-owned evidence authority. Without one, persist why evaluation is
 * unavailable rather than silently delegating the number to verifier prose.
 */
export function buildNumericAwareAcceptanceCriteria(
  task: string,
  bindings: Array<NumericAcceptanceGate & { criterionId: string }> = [],
  preferredCriteria?: string[],
): AcceptanceCriterion[] {
  const texts = preferredCriteria?.length ? [...preferredCriteria] : deriveProductAcceptanceCriteria(task);
  const targets = extractNumericAcceptanceTargets(task);
  for (const target of targets) {
    if (!texts.some((text) => text.replace(/\s+/g, " ").trim().toLowerCase() === target.sourceText.toLowerCase())) {
      texts.push(target.sourceText);
    }
  }
  const targetByText = new Map(targets.map((target) => [target.sourceText.toLowerCase(), target]));
  const numericGatesByCriterion = new Map(bindings.map(({ criterionId, ...numericGate }) => [criterionId, numericGate]));
  const criteria = texts.map((text, index): AcceptanceCriterion => {
    const id = `AC-${String(index + 1).padStart(2, "0")}`;
    const numericGate = numericGatesByCriterion.get(id);
    numericGatesByCriterion.delete(id);
    const numericTarget = targetByText.get(text.replace(/\s+/g, " ").trim().toLowerCase());
    return {
      id,
      text,
      required: true,
      ...(numericTarget ? { numericTarget } : {}),
      ...(numericGate ? { numericGate } : {}),
      ...(numericTarget && !numericGate
        ? {
            numericEvaluationUnavailable: {
              code: "missing_evidence_selector" as const,
              reason: `No numericAcceptanceGates binding with a persisted source path and JSON Pointer or regex selector was supplied for ${id}; the host will not invent an evidence file.`,
            },
          }
        : {}),
    };
  });
  if (numericGatesByCriterion.size) {
    throw new Error(`Numeric acceptance gate references unknown criteria: ${[...numericGatesByCriterion.keys()].join(", ")}.`);
  }
  return criteria;
}

function looksLikeDeliverablePath(value: string): boolean {
  const candidate = value.trim().replace(/^['"`]+|['"`,;:.)]+$/g, "").replaceAll("\\", "/");
  return !/\s/.test(candidate) && (
    /^(?:[a-z]:\/)?(?:[\w.@(){}+-]+\/)+[\w.*@(){}+-]+$/i.test(candidate)
    || /^[\w.@(){}+-]+\.[a-z0-9-]{1,12}$/i.test(candidate)
  );
}

function deliverablePathsFromText(text: string): string[] {
  const values: string[] = [];
  const add = (raw: string) => {
    const cleaned = raw.trim().replace(/^['"`]+|['"`,;:.)]+$/g, "").replaceAll("\\", "/");
    if (looksLikeDeliverablePath(cleaned) && !values.includes(cleaned)) values.push(cleaned);
  };
  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) add(match[1]);
  const withoutCode = text.replace(/`[^`\r\n]+`/g, " ");
  for (const match of withoutCode.matchAll(/(?:[a-z]:[\\/])?(?:[\w.@(){}+-]+[\\/])+[\w.*@(){}+-]+/gi)) add(match[0]);
  return values;
}

function normalizeDeliverablePhrase(raw: string): string {
  return raw
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*(?:the|a|an)\s+/i, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .trim();
}

/** Extract affirmative task deliverables without turning exclusion examples into requirements. */
export function extractTaskDeliverables(task: string): string[] {
  const deliverables: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const paths = deliverablePathsFromText(raw);
    const candidates = paths.length ? paths : [normalizeDeliverablePhrase(raw)];
    for (const candidate of candidates) {
      if (!candidate || (!paths.length && !/\b(?:handoff|review|report|documentation|document|workflow|artifact|file)s?\b/i.test(candidate))) continue;
      const key = candidate.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deliverables.push(candidate);
      }
    }
  };

  let inDeliverablesSection = false;
  for (const line of task.split(/\r?\n/)) {
    const heading = /^\s*(?:#+\s*)?(?:required\s+|named\s+)?deliverables?\b[^:]*:\s*(.*)$/i.exec(line);
    if (heading) {
      inDeliverablesSection = true;
      if (heading[1].trim()) add(heading[1]);
      continue;
    }
    if (inDeliverablesSection && /^\s*[-*+]\s+/.test(line)) {
      add(line);
      continue;
    }
    if (inDeliverablesSection && line.trim()) inDeliverablesSection = false;
    if (/\b(?:must\s+be\s+included|must\s+include|part\s+of\s+the\s+commit|included\s+in\s+the\s+commit)\b/i.test(line)
      && !/^\s*(?:exclude|omit|do not include|leave out)\b/i.test(line)) add(line);
  }

  for (const match of task.matchAll(/\b(?:including|must\s+include)\s+([^.;\r\n]+?)(?=\s+\b(?:while|but)\s+(?:excluding|omitting)\b|[.;\r\n]|$)/gi)) {
    for (const item of match[1].split(/,|\s+and\s+/i)) add(item);
  }
  return deliverables;
}

function artifactKinds(value: string): Set<string> {
  const kinds = new Set<string>();
  if (/\bhandoffs?\b/i.test(value)) kinds.add("handoff");
  if (/\breviews?\b/i.test(value)) kinds.add("review");
  if (/\breports?\b/i.test(value)) kinds.add("report");
  if (/\b(?:docs?|documents?|documentation)\b/i.test(value)) kinds.add("doc");
  if (/\bworkflows?\b/i.test(value)) kinds.add("workflow");
  return kinds;
}

function plannerExclusionItems(plan: Plan): string[] {
  const source = [plan.notes, ...plan.tasks.map((task) => task.description)].join("\n");
  const items: string[] = [];
  for (const match of source.matchAll(/\b(?:exclude|omit|drop|leave\s+out|do\s+not\s+(?:include|stage|commit))\s+([^.;\r\n]+)/gi)) {
    for (const item of match[1].split(/,|\s+and\s+/i)) {
      const cleaned = item.replace(/\s+(?:from|out of)\s+the\s+(?:commit|deliverables?).*$/i, "").trim();
      if (cleaned) items.push(cleaned);
    }
  }
  return items;
}

function exclusionDropsDeliverable(exclusion: string, deliverable: string): boolean {
  if (/^\s*(?:unrelated|other|unlisted|temporary)\b/i.test(exclusion)) return false;
  const excluded = exclusion.replaceAll("\\", "/").replace(/^[`'"\s]+|[`'"\s]+$/g, "").toLowerCase();
  const named = deliverable.replaceAll("\\", "/").toLowerCase();
  if (looksLikeDeliverablePath(deliverable)) {
    const pathPrefix = excluded.replace(/\/$/, "");
    if (pathPrefix && (named === pathPrefix || named.startsWith(`${pathPrefix}/`))) return true;
    if (/^(?:docs?|documentation)$/.test(pathPrefix) && named.startsWith("docs/")) return true;
  }
  const excludedKinds = artifactKinds(excluded);
  return [...artifactKinds(named)].some((kind) => excludedKinds.has(kind));
}

function plannerDroppedDeliverables(deliverables: string[], plan: Plan): string[] {
  const exclusions = plannerExclusionItems(plan);
  return deliverables.filter((deliverable) => exclusions.some((exclusion) => exclusionDropsDeliverable(exclusion, deliverable)));
}

function assertPlannerPreservesDeliverables(deliverables: string[], plan: Plan): void {
  const dropped = plannerDroppedDeliverables(deliverables, plan);
  if (dropped.length) {
    throw new Error(`PLAN_DROPS_NAMED_DELIVERABLES: planner exclusions remove ${dropped.join(", ")}`);
  }
}

function extractFailureCriteria(task: string): string[] {
  const criteria: string[] = [];
  if (/no markdown|no bold|no bullets|no headings|no separator/i.test(task)) criteria.push("Markdown, bold, bullets, headings, separator lines, or extra sections violate strict executor output requirements.");
  // Bind line-count authority to an actual output directive. Phrases such as
  // "compile exactly once" are product semantics, not response formatting.
  if (/exactly one (?:plain-text )?line|one short line/i.test(task)) criteria.push("More than one executor output line violates strict output requirements.");
  return criteria;
}

function extractNonGoals(task: string): string[] {
  const nonGoals: string[] = [];
  if (/do not edit files?/i.test(task)) nonGoals.push("File modification is out of scope.");
  if (/do not run commands?/i.test(task)) nonGoals.push("Command execution is out of scope unless explicitly allowed by the task.");
  return nonGoals;
}

function extractExecutorOutputContract(task: string): { contract: string; source: "explicit" | "inferred" } | undefined {
  const explicitMarker = /RESULT\s+task-N|RESULT\s+task-\d+|exactly one (?:plain-text )?line|one short line/i.test(task);
  const presentationDirective = /\b(?:output|return|answer|respond)\b[^\r\n]{0,160}\b(?:concise|short|findings?|safe\/unsafe|format)\b/i.test(task);
  if (!explicitMarker && !presentationDirective) return undefined;
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
    : { contract: "Prefer the concise presentation implied by the task without omitting substantive evidence.", source: "inferred" };
}

function plannerAcceptanceCriteriaInstruction(criteria: string[]): string {
  return `- **Product acceptance**: you MUST emit \"acceptance_criteria\": ${JSON.stringify(criteria)} in the top-level plan JSON. Preserve these task-derived product criteria exactly; do not add model routing, provider identity, concurrency, or other host controls.`;
}

function plannerDeliverablesInstruction(deliverables: string[]): string {
  if (!deliverables.length) return "- **Named deliverables**: none were affirmatively identified by the task.";
  return `- **Named deliverables**: preserve every entry in intake.deliverables: ${JSON.stringify(deliverables)}. Never broaden an exclusion (for example docs/handoffs or docs/reviews) so it drops one of these deliverables.`;
}

function textExplicitlyMarksPathReadOnly(candidate: string, resolvedPath: string, sourceText: string): boolean {
  const aliases = new Set([
    candidate,
    candidate.replaceAll("\\", "/"),
    candidate.replaceAll("/", "\\"),
    resolvedPath,
    resolvedPath.replaceAll("\\", "/"),
    resolvedPath.replaceAll("/", "\\"),
  ].map((value) => value.toLowerCase()));
  const contexts: string[] = [];
  for (const segment of sourceText.split(/(?:\r?\n)+|(?<=[.!?])\s+/)) {
    const lowered = segment.toLowerCase();
    for (const alias of aliases) {
      if (!alias) continue;
      let offset = lowered.indexOf(alias);
      while (offset >= 0) {
        // Bind intent to the referenced path, not to an unrelated mutation
        // instruction hundreds of characters later in the same long sentence.
        contexts.push(segment.slice(Math.max(0, offset - 100), offset + alias.length + 180));
        offset = lowered.indexOf(alias, offset + alias.length);
      }
    }
  }
  return contexts.some((context) => {
    const strongReadOnly = /\bread[- ]only\b|\bimmutable\b|\b(?:do not|never|must not)\s+(?:edit|modify|write|change|delete|replace)\b|\bnot\s+(?:a|the)\s+(?:mutation|write)\s+target\b|\bmust not appear\b.{0,80}\bwrite set\b/i.test(context);
    if (strongReadOnly) return true;
    const readIntent = /\b(?:inspect|read|locate|consult|reference|view|input|use unchanged)\b/i.test(context);
    const mutationIntent = /\b(?:edit|modify|write|create|delete|replace|patch|repair|update|move|rename)\b/i.test(context);
    return readIntent && !mutationIntent;
  });
}

function validatePlannedExternalEvidenceRoots(
  planned: string[] | undefined,
  mission: Pick<SupervisionRunState["mission"], "cwd" | "worktree" | "externalEvidenceRoots">,
): string[] {
  const frozen = mission.externalEvidenceRoots ?? [];
  if (!planned?.length) return [...frozen];
  const canonical = canonicalizeExternalEvidenceRoots({
    cwd: mission.cwd,
    worktreeRoot: mission.worktree.root,
    worktreeRealRoot: mission.worktree.realRoot,
    roots: planned,
    protectedRoots: defaultProtectedRoots(),
  });
  const allowed = new Set(frozen.map((root) => process.platform === "win32" ? root.toLowerCase() : root));
  const undeclared = canonical.filter((root) => !allowed.has(process.platform === "win32" ? root.toLowerCase() : root));
  if (undeclared.length) {
    throw new Error(`SUPERVISED_PLAN_REJECTED: external evidence root was not declared by the caller: ${undeclared.join(", ")}`);
  }
  return [...frozen];
}

function classifyPlannerPathReferences(input: {
  paths: string[] | undefined;
  readOnlyInputs: string[] | undefined;
  taskText: string;
  plan: Plan;
  lane: RunLane;
  cwd: string;
  worktree: FrozenMission["worktree"];
}): { writePaths: string[] | undefined; advisories: PlannerPathReferenceAdvisory[] } {
  const writePaths: string[] = [];
  const advisories: PlannerPathReferenceAdvisory[] = [];
  const sourceText = [input.taskText, input.plan.notes, ...input.plan.tasks.map((task) => task.description)].join("\n");
  const explicitlyReadOnly = new Set(input.readOnlyInputs ?? []);
  for (const candidate of new Set([...(input.paths ?? []), ...explicitlyReadOnly])) {
    const issues = checkLanePaths({
      lane: input.lane,
      cwd: input.cwd,
      worktree: input.worktree,
      paths: [candidate],
      allowedWriteSet: [candidate],
    });
    const boundaryIssue = issues.find((issue) => issue.code === "path_escape" || issue.code === "protected_path");
    const readOnly = explicitlyReadOnly.has(candidate)
      || Boolean(boundaryIssue && textExplicitlyMarksPathReadOnly(candidate, boundaryIssue.resolvedPath, sourceText));
    if (readOnly) {
      const resolvedPath = boundaryIssue?.resolvedPath ?? path.resolve(input.cwd, candidate).replaceAll("\\", "/");
      advisories.push({
        code: "external_read_only_reference",
        path: candidate,
        resolvedPath,
        message: `Planner path ${candidate} is explicitly read-only; it is recorded as reference input, not mutation authority or part of the write set.`,
      });
      continue;
    }
    if (!explicitlyReadOnly.has(candidate)) writePaths.push(candidate);
  }
  return { writePaths: input.paths === undefined ? undefined : writePaths, advisories };
}

/** Narrow exported seam used by regression tests without constructing private intake state. */
export function buildPlanningPromptForTest(task: string, externalEvidenceRoots: string[] = []): string {
  const criteria = deriveProductAcceptanceCriteria(task);
  const deliverables = extractTaskDeliverables(task);
  return `Planner output schema includes \"acceptance_criteria\" and \"external_evidence_roots\".\nPlanner intake includes \"deliverables\": ${JSON.stringify(deliverables)}.\nDeclared external evidence roots: ${JSON.stringify(externalEvidenceRoots)}; this category never grants write authority.\n${plannerAcceptanceCriteriaInstruction(criteria)}\n${plannerDeliverablesInstruction(deliverables)}`;
}

/** Narrow pure seam for testing binding propagation without persistence-backed orchestration. */
export function buildPlanningPrompt(intake: Intake, attempt: number, failureReasons: string[], completedTasks: TaskLedgerEntry[] = [], contractWriteSet?: string[], externalEvidenceRoots: string[] = []): string {
  const retryBlock = failureReasons.length
    ? `\nPrevious verifier failure reasons to address deterministically (host context, not new owner criteria):\nROLE_RECOVERY_PLANNING_CONTEXT:\n${JSON.stringify(failureReasons)}\n`
    : "";
  const evidenceSchema = externalEvidenceRoots.length
    ? `,"external_evidence_roots":["absolute/read-only/evidence/root"]`
    : "";
  const evidenceRootsBlock = externalEvidenceRoots.length
    ? `\nEXTERNAL EVIDENCE ROOTS (read/evaluation only; never writes):\n${externalEvidenceRoots.map((entry) => `- ${entry}`).join("\n")}\nCopy these into external_evidence_roots, never predicted_write_set. Any write beneath them fails.\n`
    : "";
  const evidenceRule = externalEvidenceRoots.length
    ? `\n- External evidence roots permit reads/evaluation only. Never convert an external predicted write into evidence authority.`
    : "";
  const contractWriteSetBlock = contractWriteSet?.length
    ? `\nCONTRACTED WRITE SET (hard scope granted by the caller — deterministic enforcement):\n${contractWriteSet.map((entry) => `- ${entry}`).join("\n")}\nRepository content writes your tasks create or modify MUST fall within this set; any out-of-set mutation is an automatic deterministic FAIL naming the file. Disposable owned external scratch is different: validate a newly owned absolute canonical Temp path outside the repository and evidence roots before writing, and keep it out of the repository write set. This does not authorize writes to any other external path. Declared read-only evidence roots and owner live/frozen roots remain READONLY; being outside the repository never grants evidence write authority. Preserve all caller scratch restrictions. If required repository work falls outside the named set, do NOT plan that mutation — name the file and the reason in "notes" so the caller can widen the authorization first.\n`
    : "";
  // F2: completed tasks from prior attempts must NOT be re-created. The
  // orchestrator reuses their outputs and routes them to re-verification.
  const completedBlock = completedTasks.length
    ? `\nTasks ALREADY COMPLETED successfully in a previous attempt (their artifacts exist on disk). Keep their IDs stable, do NOT instruct executors to re-create or re-do their work, and plan only the remaining/failed work. The orchestrator will reuse their results automatically:\n${completedTasks.map((entry) => `- ${entry.taskId}: ${entry.description}`).join("\n")}\n`
    : "";
  return `${bindingPromptPreamble(intake)}\n\nPlan the following task for executor subagents. Return JSON if possible, exactly shaped as:\n{"acceptance_criteria":["product outcome copied exactly from intake.success_criteria"],"tasks":[{"id":"...","description":"...","dependsOn":[]}],"predicted_write_set":["repo/relative/output"]${evidenceSchema},"read_only_inputs":["external/or/repo/input"],"notes":"..."}\n\nINTAKE CONTRACT:\n${formatIntakeForPrompt(intake)}\n\nRules:\n- Keep task IDs stable and simple (task-1, task-2, ...).\n- Make each description self-contained.\n- Do not execute the task.\n${plannerAcceptanceCriteriaInstruction(intake.successCriteria)}\n${plannerDeliverablesInstruction(intake.deliverables)}\n- Carry forward all owner criteria, constraints, named deliverables, and any explicitly owner-authored executor output contract into the task descriptions/notes.\n- Keep provenance separate: supervisor_added_constraints govern safe orchestration, while planner_inferred_presentation_rules are advisory and MUST NOT be promoted into acceptance/failure criteria or stricter line-count rules.\n- If model routing requirements exist in intake, treat them as host-owned advisory checks, not executor work or product acceptance.\n- If the task cannot be safely split, return one task.\n- **Task-size cap**: each executor task description MUST be under ~200 words. Tasks exceeding this should be split into multiple smaller tasks. Small tasks ensure executor subagents have enough context budget to use write/edit/bash tools and produce actual file artifacts rather than text reports.\n- An executor task that only describes/analyzes and never touches files is NOT sufficient for CREATE or IMPLEMENT work — the verifier will check for actual file artifacts.\n- **Effect declaration**: on every task set "expects_file_change": true for implementation work that creates or modifies files, and "expects_file_change": false for validation, audit, review, or test-only tasks. Validation-only tasks are legitimate and are not failed for changing no files, but they must still return grounded evidence.
- **Predicted write set (predict-then-write)**: if the tasks will create or modify ANY files, include "predicted_write_set": ["repo/relative/path", ...] in the plan JSON — the exact files (or narrow "dir/" prefixes) the tasks will touch. This list becomes the executors' write scope and is enforced mechanically after execution: any mutation outside it fails the attempt naming the file. Predict precisely; do not pad with directories you merely might touch.\n${evidenceRule}\n- **Read-only path inputs**: put files/directories that tasks only inspect, read, or use unchanged in "read_only_inputs", never in "predicted_write_set". External read-only inputs must be beneath a declared external evidence root and grant no mutation authority.\n- **POSIX-shell diagnostics**: redirect discarded output only to \`/dev/null\`; never redirect to literal \`NUL\` (for example, never use \`2>NUL\`), because POSIX shells on Windows can create a workspace artifact with that name.\n${evidenceRootsBlock}${contractWriteSetBlock}\nAttempt: ${attempt}${completedBlock}${retryBlock}`;
}

/** Narrow pure seam for testing binding propagation without persistence-backed orchestration. */
export function buildExecutorPrompt(intake: Intake, plan: Plan, task: PlanTask): string {
  const outputRule = intake.executorOutputContractSource === "explicit" && intake.executorOutputContract
    ? `Owner-authored executor output contract (highest priority):\n${intake.executorOutputContract}\n\nDo not add generic report sections. Do not add Markdown unless the contract explicitly requires it.`
    : intake.executorOutputContract
      ? `Advisory presentation guidance (planner-inferred; never a product failure criterion):\n${intake.executorOutputContract}\nReturn the substantive evidence in as many lines as clarity requires.`
      : "Return a concise report with changes/findings, files touched, commands/tests run, and remaining issues or uncertainty.";

  const intakeText = promptMinification(intake);
  const planText = JSON.stringify(plan, null, 2);

  return `${bindingPromptPreamble(intake)}\n\nYou are executing one task from a deterministic orchestration.\n\nIMPORTANT: If your task is to CREATE, IMPLEMENT, BUILD, or MODIFY code/files, you MUST use write/edit/bash tools to produce actual file artifacts. A text-only response that merely describes what you would do — without creating or modifying any files — is a FAILURE. Always produce concrete artifacts for implementation tasks.\n\nINTAKE CONTRACT:\n${intakeText}\n\nFull plan:\n${planText}\n\nAssigned executor task:\n${JSON.stringify(task, null, 2)}\n\nComplete only the assigned task. Use Pi tools only if needed and allowed by the intake constraints.\n\nPOSIX-shell diagnostics: redirect discarded output only to \`/dev/null\`; never redirect to literal \`NUL\` (for example, never use \`2>NUL\`), because POSIX shells on Windows can create a workspace artifact with that name.\n${injectContinuationGuardrail(task.id)}\n\n${outputRule}`;
}

export function buildVisibleMainVerificationPrompt(
  intake: Intake,
  mission: SupervisionRunState["mission"],
  plan: Plan,
  outputs: ExecutorOutput[],
): string {
  const actionEvidence = outputs.map((output) => ({ taskId: output.taskId, ledger: output.actionEvidence ?? null }));
  return `${bindingPromptPreamble(intake)}\n\nVISIBLE_MAIN_CRITERION_VERIFICATION\nVerify every frozen acceptance criterion using machine evidence. Return JSON exactly: {"status":"pass"|"fail","reasons":["..."],"criterionFindings":[{"criterionId":"AC-01","status":"pass"|"fail","evidence":[{"kind":"test","observed":"...","exitCode":0}]}]}\nMission: ${JSON.stringify(mission)}\nPlan: ${JSON.stringify(plan)}\nExecutor outputs: ${JSON.stringify(outputs)}\nHOST-OWNED COMMAND TIMING (measurements, not worker claims):\n${JSON.stringify(commandTimesFromHostResults(outputs))}\nHOST-OWNED ACTION EVIDENCE AUTHORITY: the chronological, secret-redacted ledger below is authoritative and overrides contradictory executor prose. Judge command outcomes and RED/edit/GREEN order from host evidence, never from self-report.\n${JSON.stringify(actionEvidence)}\nIndependently re-run relevant checks and inspect the actual changes; executor claims alone are not evidence.\nAdvisory review question: was work unexpectedly slow or expensive, and what available timing/usage evidence supports that assessment? Missing evidence is unknown, not zero. Do not guess costs. This question is not a new PASS/FAIL gate and does not alter binding acceptance or independent review requirements.\nPROVENANCE RULE: owner criteria remain hard. Supervisor-added constraints govern orchestration safety but are not new product criteria. Planner-inferred presentation rules are advisory and must not cause FAIL unless the mission records an explicit owner output contract.`;
}

export function buildVerificationPrompt(intake: Intake, plan: Plan, outputs: ExecutorOutput[], routingEvidence: string, artifactEvidence?: string): string {
  const artifactBlock = artifactEvidence
    ? `\n\nARTIFACT EVIDENCE (collected post-execution by orchestrator):\n${artifactEvidence}`
    : "";
  const actionEvidence = outputs.map((output) => ({ taskId: output.taskId, ledger: output.actionEvidence ?? null }));
  return `${bindingPromptPreamble(intake)}\n\nVerify the orchestration result against the intake contract.\n\nINTAKE CONTRACT:\n${formatIntakeForPrompt(intake)}\n\nPlan:\n${JSON.stringify(plan, null, 2)}\n\nExecutor outputs:\n${JSON.stringify(outputs, null, 2)}\n\nHOST-OWNED COMMAND TIMING (measurements, not worker claims):\n${JSON.stringify(commandTimesFromHostResults(outputs))}\n\nHOST-OWNED ACTION EVIDENCE AUTHORITY:\nThe chronological, secret-redacted host ledger below is authoritative and overrides contradictory executor prose. Judge command outcomes and RED/edit/GREEN order from host evidence, never from self-report.\n${JSON.stringify(actionEvidence, null, 2)}\n\nModel routing evidence/configuration supplied by orchestrator:\n${routingEvidence}${artifactBlock}\n\nReturn JSON exactly and only in this shape:\n{"status":"pass"|"fail","reasons":["..."]}\n\nUse status "pass" only if the plan, outputs, and supplied routing evidence/configuration satisfy the intake success criteria and do not violate any constraints, invariants, or failure criteria. Use "fail" with concrete reasons for missing, unclear, or incorrect work.\n\nEFFECT EVIDENCE RULE: The ARTIFACT EVIDENCE block (if present) contains mechanical ground truth — per-task tool-call telemetry (write/edit/bash executions) and worktree file deltas. Judge implementation work by these OBSERVED EFFECTS, not by the shape or length of the executor's reply text. An executor that performed real tool-based file mutations and answered with a brief summary (or a table) is VALID. Conversely, prose claiming files were created is INSUFFICIENT when the effect evidence shows zero mutations — treat that as FAIL with reason "no observed effects for implementation task".\n\nIndependently re-run relevant checks and inspect the actual changes; executor claims alone are not evidence.\nAdvisory review question: was work unexpectedly slow or expensive, and what available timing/usage evidence supports that assessment? Missing evidence is unknown, not zero. Do not guess costs. This question is not a new PASS/FAIL gate and does not alter binding acceptance or independent review requirements.\n\nPROVENANCE RULE: owner_criteria are verdict-determining. supervisor_added_constraints govern orchestration safety but do not create product acceptance. planner_inferred_presentation_rules are advisory only — you may mention violations as warnings inside reasons, but they MUST NOT cause status "fail" on their own. Unknown provenance must not be silently weakened.`;
}

function selectPlannerOutputIndex(outputs: SubagentResult[], originalTask: string): number {
  for (const [index, output] of outputs.entries()) {
    const plan = parsePlan(output.text, originalTask);
    if (plan.tasks.length > 0) return index;
  }
  return 0;
}

function extractPlanRoleControls(plan: Plan): { executorConcurrency?: number; verifierCount?: number } {
  const raw = plan.raw && typeof plan.raw === "object" ? plan.raw as Record<string, unknown> : undefined;
  if (!raw) return {};
  const controls = raw.orchestrationControls && typeof raw.orchestrationControls === "object"
    ? raw.orchestrationControls as Record<string, unknown>
    : raw.controls && typeof raw.controls === "object"
      ? raw.controls as Record<string, unknown>
      : undefined;
  const readNumber = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
      if (typeof value === "string") {
        const parsed = parseNaturalNumber(value);
        if (parsed !== undefined) return parsed;
      }
    }
    return undefined;
  };
  return {
    executorConcurrency: readNumber(raw.executorConcurrency, raw.executorCount, controls?.executorConcurrency, controls?.executorCount),
    verifierCount: readNumber(raw.verifierCount, raw.verifiers, controls?.verifierCount, controls?.verifiers),
  };
}

function aggregateVerifierResults(
  results: Array<{ agentName: string; status: "pass" | "fail"; reasons: string[]; raw: string }>,
): { status: "pass" | "fail"; reasons: string[]; raw: string } {
  if (results.length === 0) {
    return { status: "fail", reasons: ["No verifier results were produced."], raw: "[]" };
  }
  const failures = results.filter((result) => result.status !== "pass");
  if (failures.length > 0) {
    return {
      status: "fail",
      reasons: failures.flatMap((result, index) => result.reasons.length ? result.reasons : [`verifier-${index + 1}: verifier returned FAIL without reasons`]),
      raw: JSON.stringify(results),
    };
  }
  return {
    status: "pass",
    reasons: results.flatMap((result, index) => result.reasons.length ? result.reasons : [`verifier-${index + 1}: pass`]),
    raw: JSON.stringify(results),
  };
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
        const predictedWriteSet = parseWriteSetInput(raw.predicted_write_set ?? raw.predictedWriteSet);
        const readOnlyInputs = parseWriteSetInput(raw.read_only_inputs ?? raw.readOnlyInputs);
        const externalEvidenceRoots = parseWriteSetInput(raw.external_evidence_roots ?? raw.externalEvidenceRoots);
        const acceptanceCriteria = stringArray(raw.acceptance_criteria ?? raw.acceptanceCriteria);
        return { tasks, notes: optionalString(raw.notes) ?? "", raw: parsed, predictedWriteSet, readOnlyInputs, externalEvidenceRoots, acceptanceCriteria };
      }
    }
  }

  const fallback = text.trim() || originalTask;
  const fallbackExpectation = inferDefaultExpectsFileChange(fallback);
  return {
    tasks: [{ id: "task-1", description: fallback, dependsOn: [], ...(fallbackExpectation === undefined ? {} : { expectsFileChange: fallbackExpectation }) }],
    notes: "Planner output was not parseable as plan JSON; fell back to one executor task containing the planner output.",
    raw: text,
  };
}

export function inferDefaultExpectsFileChange(description: string): false | undefined {
  if (SUPERVISED_ANALYSIS_CONTRACT.test(description) &&
      (!hasImperativeMutationPromise(description) || SUPERVISED_NO_MUTATION_CONTRACT.test(description))) {
    return false;
  }
  return undefined;
}

function normalizePlanTask(item: unknown, index: number): PlanTask | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const description = optionalString(raw.description)?.trim();
  if (!description) return null;
  const id = optionalString(raw.id)?.trim() || `task-${index + 1}`;
  const declaredExpectation = parseExpectsFileChange(raw);
  const inferredExpectation = inferDefaultExpectsFileChange(description);
  const unambiguouslyValidationOnly = SUPERVISED_NO_MUTATION_CONTRACT.test(description)
    || (/^\s*(?:independently\s+)?(?:audit|verify|validate|inspect|review|check|confirm|test)\b/i.test(description)
      && !hasImperativeMutationPromise(description));
  // Override an accidental true only for an unambiguous validation contract.
  // Words such as "review" inside an implementation task remain incidental.
  const expectsFileChange = declaredExpectation === true && unambiguouslyValidationOnly
    ? false
    : declaredExpectation ?? inferredExpectation;
  return { id, description, dependsOn: stringArray(raw.dependsOn) ?? [], ...(expectsFileChange === undefined ? {} : { expectsFileChange }) };
}

/** Focused regression seams for planner-input validation. */
export function parsePlanForTest(text: string, originalTask: string): Plan {
  return parsePlan(text, originalTask);
}

export function plannerDroppedDeliverablesForTest(task: string, plannerText: string): string[] {
  return plannerDroppedDeliverables(extractTaskDeliverables(task), parsePlan(plannerText, task));
}

export function assertPlannerPreservesDeliverablesForTest(task: string, plannerText: string): void {
  assertPlannerPreservesDeliverables(extractTaskDeliverables(task), parsePlan(plannerText, task));
}

/** Accepts "expects_file_change"/"expectsFileChange" booleans or effect: "validate" | "implement". */
function parseExpectsFileChange(raw: Record<string, unknown>): boolean | undefined {
  for (const key of ["expects_file_change", "expectsFileChange"]) {
    const value = raw[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(?:true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  }
  const effect = typeof raw.effect === "string" ? raw.effect.trim().toLowerCase() : undefined;
  if (effect === "validate" || effect === "verify" || effect === "audit") return false;
  if (effect === "implement" || effect === "mutate") return true;
  return undefined;
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

function firstPevTerminalNoRetry(resumeState?: LoadedRunState): TerminalNoRetryState | undefined {
  return [...(resumeState?.terminalStates.values() ?? [])]
    .sort((a, b) => a.phaseIndex - b.phaseIndex)
    .find((state) =>
      state.code === "WRITE_SET_VIOLATION" ||
      state.code === "WRITE_SET_UNOBSERVABLE" ||
      state.code === "AMBIGUOUS_COMPLETION" ||
      state.code === "RESULT_LOST_AFTER_MUTATION");
}

function attemptFromTerminalPhase(terminalState: TerminalNoRetryState): number | undefined {
  const match = terminalState.phaseName.match(/attempt-(\d+)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatPevWriteSetObservation(evaluation: WriteSetObservationEvaluation): string {
  const parts = [
    `${evaluation.observed.length} observed mutation(s)`,
    `${evaluation.violations.length} violation(s)`,
    `${evaluation.unobservableScopes.length} unobservable scope(s)`,
  ];
  if (evaluation.observed.length) parts.push(`observed=${evaluation.observed.join(", ")}`);
  if (evaluation.violations.length) parts.push(`violations=${evaluation.violations.join(", ")}`);
  if (evaluation.unobservableScopes.length) parts.push(`unobservable=${evaluation.unobservableScopes.join(", ")}`);
  return parts.join("; ");
}

function writeSetTerminalPaths(
  code: "WRITE_SET_VIOLATION" | "WRITE_SET_UNOBSERVABLE",
  evaluation?: WriteSetObservationEvaluation,
  fallbackPaths: string[] = [],
): string[] {
  if (!evaluation) return [...new Set(fallbackPaths)];
  return code === "WRITE_SET_UNOBSERVABLE"
    ? [...new Set(evaluation.unobservableScopes)]
    : [...new Set(evaluation.violations)];
}

function makePevTerminalVerifierResult(terminalState: TerminalNoRetryState): { status: "fail"; reasons: string[]; raw: string } {
  let reason: string;
  if (terminalState.code === "WRITE_SET_UNOBSERVABLE") {
    const scopes = terminalState.unobservableScopes?.length ? terminalState.unobservableScopes.join(", ") : "(unknown scope)";
    reason = `WRITE_SET_UNOBSERVABLE: write-set observation could not observe ${scopes}; failing closed before verifier spawn; retryAllowed=false.`;
  } else if (terminalState.code === "WRITE_SET_VIOLATION") {
    const violations = terminalState.violations?.length ? terminalState.violations.map((p) => `"${p}"`).join(", ") : "(unknown violation)";
    const label = terminalState.errorMessage.includes("WRITE_SET_VIOLATION (pre-execution)")
      ? "WRITE_SET_VIOLATION (pre-execution)"
      : "WRITE_SET_VIOLATION";
    reason = `${label}: ${violations} mutated outside the predicted write set; failing before verifier spawn; retryAllowed=false.`;
  } else {
    reason =
      `Terminal no-retry state ${terminalState.code}: retryAllowed=false; ` +
      `resultLost=${terminalState.resultLost}; verifierSpawned=false; ${terminalState.errorMessage}`;
  }
  return { status: "fail", reasons: [reason], raw: JSON.stringify({ status: "fail", reasons: [reason] }) };
}

function persistPevWriteSetTerminal(
  store: RunStateStore,
  indexOf: (name: string) => number,
  phaseName: string,
  code: "WRITE_SET_VIOLATION" | "WRITE_SET_UNOBSERVABLE",
  state: OrchestrationState,
  evaluation?: WriteSetObservationEvaluation,
  fallbackPaths: string[] = [],
): TerminalNoRetryState {
  const paths = writeSetTerminalPaths(code, evaluation, fallbackPaths);
  const phaseIndex = indexOf(phaseName);
  const violationLabel = phaseName.includes("pre-execution") ? "WRITE_SET_VIOLATION (pre-execution)" : "WRITE_SET_VIOLATION";
  const errorMessage = code === "WRITE_SET_UNOBSERVABLE"
    ? `WRITE_SET_UNOBSERVABLE before verifier spawn: ${paths.join(", ") || "(unknown scope)"}. The run is terminal for this discovery and will not retry.`
    : `${violationLabel} before verifier spawn: ${paths.map((p) => `"${p}"`).join(", ") || "(unknown violation)"}. The run is terminal for this discovery and will not retry.`;
  return store.markTerminalNoRetry(phaseIndex, phaseName, {
    code,
    retryAllowed: false,
    resultLost: false,
    phaseName,
    phaseIndex,
    recordedAt: new Date().toISOString(),
    errorMessage,
    spawnedCount: state.spawnedCount,
    verifierSpawned: false,
    observed: evaluation?.observed ?? [],
    violations: evaluation?.violations ?? (code === "WRITE_SET_VIOLATION" ? paths : []),
    unobservableScopes: evaluation?.unobservableScopes ?? (code === "WRITE_SET_UNOBSERVABLE" ? paths : []),
  });
}

function persistPevAmbiguousTerminal(
  store: RunStateStore,
  indexOf: (name: string) => number,
  phaseName: string,
  error: SubagentTerminalAmbiguousError,
  state: OrchestrationState,
): TerminalNoRetryState {
  const phaseIndex = indexOf(phaseName);
  const info = error.info;
  return store.markTerminalNoRetry(phaseIndex, phaseName, {
    code: info.code,
    retryAllowed: false,
    resultLost: info.resultLost,
    phaseName,
    phaseIndex,
    recordedAt: new Date().toISOString(),
    errorMessage: info.errorMessage,
    agentName: info.agentName,
    exitCode: info.exitCode,
    spawnedCount: state.spawnedCount,
    verifierSpawned: false,
  }, info.candidate);
}

function finalizePevTerminalResult(
  params: NormalizedParams,
  state: OrchestrationState,
  terminalState: TerminalNoRetryState,
): { markdown: string; details: Record<string, unknown> } {
  state.spawnedCount = Math.max(state.spawnedCount, terminalState.spawnedCount ?? 0);
  if (!state.verifierResult) state.verifierResult = makePevTerminalVerifierResult(terminalState);
  state.verifierResults = state.verifierResults ?? [];
  for (const reason of state.verifierResult.reasons) {
    if (!state.failureReasons.some((existing) => existing.includes(reason))) {
      state.failureReasons.push(`Terminal no-retry: ${reason}`);
    }
  }
  state.finalResult = buildFinalResult("fail", params, state);
  return {
    markdown: state.finalResult,
    details: {
      ...buildDetails("fail", params, state),
      code: terminalState.code,
      retryAllowed: false,
      resultLost: terminalState.resultLost,
      verifierSpawned: false,
      spawnedCount: state.spawnedCount,
      observed: terminalState.observed ?? [],
      violations: terminalState.violations ?? [],
      unobservableScopes: terminalState.unobservableScopes ?? [],
      terminalNoRetry: terminalState,
    },
  };
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
    formatCommandTimes(mergeCommandTimes(getCommandTimesForRun(state.runId), commandTimesFromHostResults(state))),
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
    commandTimes: mergeCommandTimes(getCommandTimesForRun(state.runId), commandTimesFromHostResults(state)),
    commandTimingSummary: summarizeCommandTimes(mergeCommandTimes(getCommandTimesForRun(state.runId), commandTimesFromHostResults(state))),
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
      verifierResults: (state.verifierResults ?? []).map((result) => ({
        agentName: result.agentName,
        status: result.status,
        reasons: result.reasons.map((reason) => truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "verifier reason")),
        raw: truncateWithNotice(result.raw, MAX_DETAIL_TEXT_CHARS, "verifier raw output"),
      })),
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
      verifierResults: (attempt.verifierResults ?? []).map((result) => ({
        agentName: result.agentName,
        status: result.status,
        reasons: result.reasons.map((reason) => truncateWithNotice(reason, MAX_DETAIL_TEXT_CHARS, "verifier reason")),
        raw: truncateWithNotice(result.raw, MAX_DETAIL_TEXT_CHARS, "verifier raw output"),
      })),
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
    return resolvePiChildCommand(currentCliScript, "process.argv[1]");
  }

  const cliScript = process.argv.find((arg) => isExistingPiCliScript(arg));
  if (cliScript) return resolvePiChildCommand(cliScript, "process.argv");

  const installedCliScript = resolveInstalledPiCliScript();
  if (installedCliScript) return resolvePiChildCommand(installedCliScript, "installed Pi CLI");

  return process.platform === "win32"
    ? { command: "pi.cmd", argsPrefix: [], shell: true }
    : { command: "pi", argsPrefix: [] };
}

function resolvePiCliPath(cliPath: string, envName: string): ResolvedPiCommand {
  if (!existsSync(cliPath)) throw new Error(`${envName} points to a missing Pi CLI path: ${cliPath}`);
  const ext = path.extname(cliPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return resolvePiChildCommand(cliPath, envName);
  return { command: cliPath, argsPrefix: [], shell: shouldUseWindowsShell(cliPath), launchRuntime: shouldUseWindowsShell(cliPath) ? "shell" : "native" };
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
  const executorCount = firstNumberMatch(task, [
    /\b(?:at[\s-]*least|up[\s-]*to|use|run|spawn|available|allow|invoke)\s+([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?executors?\b/i,
    /\b([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?executors?\b/i,
    /\b(?:executors?|executor\s+agents?|executor\s+slots?)\s*(?:count|pool|concurrency|parallelism|available|of|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const plannerCount = firstNumberMatch(task, [
    /\b(?:use|run|spawn|allow|invoke)\s+([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?planners?\b/i,
    /\b([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?planners?\b/i,
    /\b(?:planners?|planner\s+agents?)\s*(?:count|pool|concurrency|parallelism|of|=|:)?\s*([a-z0-9-]+)\b/i,
  ], rawMatches);
  const verifierCount = firstNumberMatch(task, [
    /\b(?:use|run|spawn|allow|invoke)\s+([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?verifiers?\b/i,
    /\b([a-z0-9-]+)\s+(?:simultaneous\s+|parallel\s+|concurrent\s+)?verifiers?\b/i,
    /\b(?:verifiers?|verifier\s+agents?)\s*(?:count|pool|concurrency|parallelism|of|=|:)?\s*([a-z0-9-]+)\b/i,
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
    concurrencySource: params.concurrency !== undefined || params.executorConcurrency !== undefined || params.executorCount !== undefined ? "parameter" : concurrency || executorCount ? "natural_language" : "default",
    ...(executorCount ? { executorCount, executorConcurrency: executorCount } : {}),
    ...(plannerCount ? { plannerCount } : {}),
    ...(verifierCount ? { verifierCount } : {}),
    roleConcurrencySource: params.plannerCount !== undefined || params.verifierCount !== undefined || params.executorConcurrency !== undefined || params.executorCount !== undefined ? "parameter" : executorCount || plannerCount || verifierCount ? "natural_language" : "default",
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
    case "awaiting supervisor":
    case "paused":    return "⏸";
    case "blocked infrastructure":
    case "failed":    return "❌";
    case "cancelled": return "🚫";
    case "complete":  return "✅";
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
