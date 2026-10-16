import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshLiveStatus, observeProcessIdentity, type LiveStatus, type LiveStatusOptions, type ProcessIdentityObservation, type ProcessIdentityObserver } from "./live-status";
export { observeProcessIdentity } from "./live-status";
export type { ProcessIdentityObservation, ProcessIdentityObserver } from "./live-status";

import {
  atomicWriteJsonSync,
  runDirFor,
  type GenericSupervisionCursor,
  type GenericSupervisionProtocolIdentity,
} from "./run-state";
import type { FrozenTestAuthorizationPolicy, ShapeExecutionContract, ShapeExecutionClassification, WorkerExecutionConstraints } from "./types";
import {
  canonicalizeExternalEvidenceRoots,
  fileMatchesWriteSet,
  isWindowsReservedDevicePath,
  normalizeWriteSetEntry,
  resolveDeclaredExternalEvidencePath,
  type ContentSignatureChange,
  type ContentSignatureSnapshot,
  type ExternalEvidenceSnapshot,
} from "./write-set";

export type SupervisionMode = "visible-main" | "off";
export type RunLane = "product" | "orchestrator-maintenance";

export const HOST_TASK_BOUNDARY_PROTOCOL_ID = "host-task-boundary-v1" as const;
export const GENERIC_SHAPE_ADAPTER_ID = "generic-shape-adapter-v1" as const;
export const PEV_SHAPE_ADAPTER_ID = "plan-execute-verify-adapter-v1" as const;

function frozenExecutionContract(
  classification: ShapeExecutionClassification,
  adapterId?: string,
): ShapeExecutionContract {
  return Object.freeze({
    classification,
    ...(adapterId
      ? {
          supervision: Object.freeze({
            protocolId: HOST_TASK_BOUNDARY_PROTOCOL_ID,
            adapterId,
            adapterVersion: 1 as const,
          }),
        }
      : {}),
  }) as ShapeExecutionContract;
}

/** Shared declarations used by native shapes and host-resolved workflows. */
export const READ_ONLY_SHAPE_EXECUTION = frozenExecutionContract("read-only");
export const GENERIC_EXECUTOR_SHAPE_EXECUTION = frozenExecutionContract("executor-bearing", GENERIC_SHAPE_ADAPTER_ID);
export const GENERIC_MUTATING_SHAPE_EXECUTION = frozenExecutionContract("mutating", GENERIC_SHAPE_ADAPTER_ID);
export const PEV_SHAPE_EXECUTION = frozenExecutionContract("executor-bearing", PEV_SHAPE_ADAPTER_ID);

export type ShapeSupervisionResolution =
  | {
      disposition: "read-only";
      classification: "read-only";
      requiresVisibleMain: false;
    }
  | {
      disposition: "supervised";
      classification: "executor-bearing" | "mutating";
      requiresVisibleMain: true;
      identity: GenericSupervisionProtocolIdentity;
    }
  | {
      disposition: "fail-closed";
      classification: ShapeExecutionClassification | "unknown";
      requiresVisibleMain: true;
      reason: "missing-execution-classification" | "missing-supervision-adapter" | "unsupported-supervision-protocol";
    };

/**
 * Resolve a shape capability before preflight or spawn. Unknown/malformed
 * capabilities deliberately resolve to fail-closed rather than legacy mode.
 */
export function resolveShapeSupervision(contract: ShapeExecutionContract | undefined): ShapeSupervisionResolution {
  if (!contract || typeof contract !== "object" || !new Set(["read-only", "executor-bearing", "mutating"]).has(contract.classification)) {
    return {
      disposition: "fail-closed",
      classification: "unknown",
      requiresVisibleMain: true,
      reason: "missing-execution-classification",
    };
  }
  if (contract.classification === "read-only") {
    // Read-only is a complete declaration, not a way to smuggle an unknown
    // adapter past validation. A contradictory adapter is malformed and must
    // fail closed just like an unsupported executor-bearing declaration.
    if (contract.supervision !== undefined) {
      return {
        disposition: "fail-closed",
        classification: "read-only",
        requiresVisibleMain: true,
        reason: "unsupported-supervision-protocol",
      };
    }
    return { disposition: "read-only", classification: "read-only", requiresVisibleMain: false };
  }
  if (!contract.supervision || typeof contract.supervision !== "object") {
    return {
      disposition: "fail-closed",
      classification: contract.classification,
      requiresVisibleMain: true,
      reason: "missing-supervision-adapter",
    };
  }
  if (
    contract.supervision.protocolId !== HOST_TASK_BOUNDARY_PROTOCOL_ID ||
    contract.supervision.adapterVersion !== 1 ||
    !isSupportedDispatchAdapter(contract.supervision.adapterId)
  ) {
    return {
      disposition: "fail-closed",
      classification: contract.classification,
      requiresVisibleMain: true,
      reason: "unsupported-supervision-protocol",
    };
  }
  return {
    disposition: "supervised",
    classification: contract.classification,
    requiresVisibleMain: true,
    identity: { ...contract.supervision },
  };
}

export type ShapeDispatchResolution = ShapeSupervisionResolution | {
  disposition: "legacy-off";
  classification: ShapeExecutionClassification | "unknown";
  requiresVisibleMain: false;
  /** Diagnostic only: the capability remains untrusted and is bypassed solely because off was explicit. */
  bypassedReason?: Extract<ShapeSupervisionResolution, { disposition: "fail-closed" }>["reason"];
};

/**
 * Host dispatch policy. Omission defaults to visible-main; only an explicit
 * `off` may enter the legacy unsupervised path. The returned value is intended
 * to be checked before provider preflight or any worker spawn.
 */
export function resolveShapeDispatch(
  contract: ShapeExecutionContract | undefined,
  mode: SupervisionMode | undefined,
): ShapeDispatchResolution {
  const capability = resolveShapeSupervision(contract);
  if (mode !== "off") return capability;
  return {
    disposition: "legacy-off",
    classification: capability.classification,
    requiresVisibleMain: false,
    ...(capability.disposition === "fail-closed" ? { bypassedReason: capability.reason } : {}),
  };
}

function isValidAdapterId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(value);
}

/**
 * Dispatch accepts only adapters implemented by this host build. A syntactically
 * valid future adapter id is still unsupported until its deterministic bridge is
 * shipped; treating it as the generic bridge would silently change semantics.
 */
function isSupportedDispatchAdapter(value: unknown): value is string {
  return value === GENERIC_SHAPE_ADAPTER_ID || value === PEV_SHAPE_ADAPTER_ID;
}
export type SupervisionAction = "run" | "inspect" | "continue" | "accept" | "pause" | "cancel";
export type SupervisionStatus =
  | "plan_checkpoint"
  | "awaiting_supervisor"
  | "executing"
  | "paused"
  | "blocked_infrastructure"
  | "cancelled"
  | "verifying"
  | "terminal";

export type NumericAcceptanceOperator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface NumericEvidenceSource {
  /** Absolute path, or a path resolved relative to the frozen mission cwd. */
  path: string;
  /** RFC 6901 pointer into a persisted JSON document. Exactly one selector is required. */
  jsonPointer?: string;
  /** JavaScript regular expression whose first capture (or full match) is numeric. */
  regex?: string;
}

export interface NumericAcceptanceGate {
  metric: string;
  /** Unit for the persisted value and threshold. Omitted for legacy/unitless gates. */
  unit?: string;
  source: NumericEvidenceSource;
  op: NumericAcceptanceOperator;
  threshold: number;
}

/** A numeric product target extracted from owner-authored task text. */
export interface NumericAcceptanceTarget {
  metric: string;
  op: NumericAcceptanceOperator;
  threshold: number;
  /** Canonical display unit; unitless cardinalities use `count`. */
  unit: string;
  /** Bounded owner-authored fragment from which the target was extracted. */
  sourceText: string;
}

export interface NumericEvaluationUnavailable {
  code: "missing_evidence_selector" | "non_mechanical_target" | "deferred_target";
  /** Explicit durable explanation; the host may not invent a metric source. */
  reason: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  required: boolean;
  /** Owner-authored target that must not disappear into verifier prose. */
  numericTarget?: NumericAcceptanceTarget;
  /** Optional host-evaluated mechanical acceptance condition. */
  numericGate?: NumericAcceptanceGate;
  /** Required when a numericTarget has no host-evaluated gate. */
  numericEvaluationUnavailable?: NumericEvaluationUnavailable;
}

/** Frozen separation between product authority and orchestration-authored guidance. */
export interface MissionCriteriaAuthority {
  ownerCriteria: {
    success: string[];
    failure: string[];
    outputContract?: string;
  };
  supervisorAddedConstraints: string[];
  plannerInferredPresentationRules: string[];
}

export interface ResolvedMissionRoute {
  role: string;
  agentName: string;
  provider: string;
  model: string;
}

/** Runtime route identity captured from the launcher result, never inferred from task prose. */
export interface ObservedMissionRoute extends ResolvedMissionRoute {
  source: "launcher";
}

export interface FrozenMissionInput {
  originalTask: string;
  cwd: string;
  worktree: {
    root: string;
    realRoot: string;
    branch: string | null;
    baseline: string | null;
  };
  paradigm: string;
  lane: RunLane;
  routes: ResolvedMissionRoute[];
  constraints: string[];
  nonGoals: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  /** Frozen worker dispatch policy. Undefined is accepted only for legacy schema-v1 missions. */
  workerExecutionConstraints?: WorkerExecutionConstraints;
  /** Canonical external directories that may be read/evaluated but never written. Undefined is legacy schema-v1. */
  externalEvidenceRoots?: string[];
  /** Optional only for loading schema-v1 missions created before provenance was persisted. */
  criteriaAuthority?: MissionCriteriaAuthority;
}

export interface FrozenMission extends FrozenMissionInput {
  schemaVersion: 1;
  missionHash: string;
}

export interface CriterionTask {
  id: string;
  description: string;
  dependsOn: string[];
  criteria: string[];
  predictedWriteSet?: string[];
  /**
   * Planner-declared effect expectation. false marks a validation/audit/test
   * task that legitimately settles without byte-level change; true marks an
   * implementation task. Undefined falls back to the description heuristics.
   */
  expectsFileChange?: boolean;
}

export interface ValidationIssue {
  code: string;
  message: string;
  taskId?: string;
  criterionId?: string;
  path?: string;
  /** Advisory issues are persisted for supervisor visibility but never replace a model verdict. */
  advisory?: true;
}

/**
 * Compare configured routes with identities returned by the actual launcher.
 * Route visibility is host telemetry, not a product acceptance criterion, so
 * every finding is advisory and can never replace the verifier's verdict.
 */
export function checkObservedRouteAdvisories(
  expected: ResolvedMissionRoute[],
  observed: ObservedMissionRoute[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const route of expected) {
    const sameRole = observed.filter((item) => item.role === route.role);
    if (sameRole.length === 0) {
      issues.push({
        code: "missing_route_observation",
        message: `No launcher-owned route observation was recorded for ${route.role} (${route.agentName}).`,
        advisory: true,
      });
      continue;
    }
    const match = sameRole.some((item) =>
      item.agentName === route.agentName &&
      item.provider === route.provider &&
      item.model === route.model);
    if (!match) {
      issues.push({
        code: "route_observation_mismatch",
        message: `Observed ${route.role} route did not match ${route.agentName} using ${route.provider}/${route.model}.`,
        advisory: true,
      });
    }
  }
  return issues;
}

function isRoutingCriterionText(text: string): boolean {
  return /\b(?:model\s+)?routing\s+evidence\b|\b(?:planner|executor|verifier)\b[^.\n]{0,120}\b(?:provider|model)\b/i.test(text);
}

/** Identify legacy missions whose failed acceptance surface contained only route bookkeeping. */
export function isRoutingOnlyVerificationFailure(
  criteria: AcceptanceCriterion[],
  failedCriterionIds: string[],
): boolean {
  if (failedCriterionIds.length === 0) return false;
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion.text]));
  return failedCriterionIds.every((criterionId) => {
    const text = byId.get(criterionId);
    return typeof text === "string" && isRoutingCriterionText(text);
  });
}

/** Deterministic settlement used when replaying a legacy route-only verifier failure. */
export function settleRoutingOnlyVerificationFailure(
  criteria: AcceptanceCriterion[],
  failedCriterionIds: string[],
): {
  outcome: "awaiting_supervisor" | "not_routing_only";
  terminal: false;
  repairPlanned: false;
  repairBudgetExhausted: false;
  advisoryFlags: ValidationIssue[];
} {
  const routingOnly = isRoutingOnlyVerificationFailure(criteria, failedCriterionIds);
  return {
    outcome: routingOnly ? "awaiting_supervisor" : "not_routing_only",
    terminal: false,
    repairPlanned: false,
    repairBudgetExhausted: false,
    advisoryFlags: routingOnly
      ? failedCriterionIds.map((criterionId) => ({
          code: "routing_only_verification_failure",
          message: `${criterionId} is legacy route bookkeeping; product settlement remains with the supervisor.`,
          criterionId,
          advisory: true,
        }))
      : [],
  };
}

export interface PlanValidationOptions {
  allowedWriteSet?: string[];
  cwd?: string;
  approvedTaskIds?: string[];
}

export interface ApprovalBinding {
  runId: string;
  missionHash: string;
  checkpointId: string;
  action: SupervisionAction;
}

export interface ApprovalRecord extends ApprovalBinding {
  tokenHash: string;
  issuedAt: string;
  consumedAt?: string;
  invalidatedAt?: string;
}

/**
 * Nonsecret evidence that a visible-main approval was consumed before an
 * executor dispatch. This object is created only by the host from the record
 * that passed compare-and-consume; workers never supply or amend it.
 */
export interface ApprovalConsumptionMetadata {
  authority: "visible-main-host";
  tokenFingerprint: `sha256:${string}`;
  binding: ApprovalBinding;
  consumedAt: string;
}

export interface ExecutorCheckpointHostMetadata {
  schemaVersion: 1;
  approvalConsumption: ApprovalConsumptionMetadata;
}

export interface SupervisionCheckpoint {
  id: string;
  sequence: number;
  kind: "plan" | "executor" | "verifier" | "acceptance" | "pause" | "retirement" | "infrastructure";
  createdAt: string;
  missionHash: string;
  taskId?: string;
  criteria: string[];
  effectChanges: ContentSignatureChange[];
  outcome?: string;
  payloadFile?: string;
}

export interface InfrastructureFailure {
  infrastructure: boolean;
  code?: "provider_refused" | "command_unavailable" | "provider" | "transport" | "checkpoint" | "parser" | "write_set" | "orchestrator";
  message: string;
  providerMessage?: string;
  retryAllowed?: boolean;
  retryEligible?: boolean;
  retryAttempted?: boolean;
  mutationAmbiguous?: boolean;
}

/**
 * A settled task mutated paths inside the worktree that the frozen write set
 * omitted. The host widens scope durably and records it here; the supervisor's
 * next one-use continue is the acceptance, cancel is the rejection.
 */
export interface ScopeAmendment {
  taskId: string;
  paths: string[];
  at: string;
}

export interface SupervisionAuditFacts {
  tests: Array<{ command: string; outcome: string }>;
  retries: number;
  infrastructureFailures: InfrastructureFailure[];
  forbiddenChanges: string[];
  noProgress: boolean;
  activeWorkers: Array<{ pid?: number; phase: string }>;
  detachedWorkers: Array<{ pid?: number; phase: string }>;
  /** Absent on states persisted before 2026-09-03; treated as empty. */
  scopeAmendments?: ScopeAmendment[];
}

export interface LegacyPevSupervisionRuntime {
  /** Missing on schema-v1 PEV files written before generic protocol support. */
  kind?: "legacy-pev";
  params: Record<string, unknown>;
  intake: unknown;
  plan: { tasks: CriterionTask[]; notes: string; predictedWriteSet?: string[]; externalEvidenceRoots?: string[]; acceptanceCriteria?: string[] };
  completedTaskIds: string[];
  executorOutputs: unknown[];
  contentBaseline: ContentSignatureSnapshot;
  /** Initial byte observation of literal coordinator-approved scope, independently bounded. */
  approvedScopeBaseline?: ContentSignatureSnapshot;
  /** Read-only external evidence baseline. Any change is a hard effect violation. */
  externalEvidenceBaseline?: ExternalEvidenceSnapshot;
  /** Mutable commit boundary accepted by executor ownership or visible supervisor acknowledgment. */
  acceptedGitBaseline?: string | null;
  repairCount: number;
  /** Owning host PID and process start time (`pid:timeOrigin`); absent on legacy runs. */
  hostInstanceId?: string;
}

/** Shape-neutral durable payload resumed one settled task boundary at a time. */
export interface GenericVerifierInstanceEvidence {
  index: number;
  agentName: string;
  provider?: string;
  model?: string;
  spawnStartedAt: string;
  spawnStartedSequence: number;
  completedAt: string;
  completedSequence: number;
  status: "pass" | "fail";
}

/** Durable proof that every verifier was launched before deterministic aggregation. */
export interface VerifierWorkspaceIntegrityEvidence {
  beforeHash: string;
  afterHash: string;
  /** True whenever the complete content manifests differ, including advisory cache and host-runtime files. */
  hashChanged: boolean;
  /** Exhaustive-manifest hashes with only explicitly advisory cache and host-runtime files removed. */
  protectedBeforeHash: string;
  protectedAfterHash: string;
  protectedHashChanged: boolean;
  /** Separately persisted so a changed omission can never disappear inside hash telemetry. */
  omissionsChanged: boolean;
  /** Complete path-level diff, including both advisory categories. */
  changes: ContentSignatureChange[];
  ignoredToolCacheChanges: ContentSignatureChange[];
  /** Host-owned runtime bookkeeping under the configured runs root. */
  ignoredHostRuntimeChanges: ContentSignatureChange[];
  enforcedChanges: ContentSignatureChange[];
  /** Absolute changes observed beneath read-only external evidence roots. */
  externalEvidenceChanges?: ContentSignatureChange[];
  /** Evidence roots that could not be exhaustively observed fail closed. */
  externalEvidenceUnobservableRoots?: string[];
  mutationDetected: boolean;
  before: Pick<ContentSignatureSnapshot, "root" | "fileCount" | "totalBytes" | "truncated" | "omitted" | "limits">;
  after: Pick<ContentSignatureSnapshot, "root" | "fileCount" | "totalBytes" | "truncated" | "omitted" | "limits">;
}

export interface GenericVerifierBatchEvidence {
  batchId: string;
  configuredCount: number;
  concurrency: number;
  scheduledAt: string;
  members: GenericVerifierInstanceEvidence[];
  parallelOverlap: boolean;
  aggregationStartedAt: string;
  aggregationStartedSequence: number;
  aggregateStatus: "pass" | "fail";
  /** Effect-enforced read-only proof spanning the complete concurrent batch. */
  workspaceIntegrity?: VerifierWorkspaceIntegrityEvidence;
}

export interface LegacyPevMigrationMetadata {
  adapterId: "legacy-pev-generic-migration-v1";
  sourceSchemaVersion: 1;
  sourceRuntimeKind: "missing" | "legacy-pev";
  mode: "exact-continuation" | "verification-only";
  executorRespawnAllowed: boolean;
  reasons: string[];
  sourceCheckpointIds: string[];
  executorCheckpointIds: string[];
  verifierCheckpointIds: string[];
  lastSourceCheckpointId?: string;
}

export interface GenericSupervisionRuntime extends Omit<LegacyPevSupervisionRuntime, "kind"> {
  kind: "generic-shape";
  identity: GenericSupervisionProtocolIdentity;
  cursor: GenericSupervisionCursor;
  /** Completed generic verifier batches, including launch/aggregation ordering evidence. */
  verifierBatches?: GenericVerifierBatchEvidence[];
  /** Adapter-owned JSON data; it must not carry live process handles. */
  adapterState?: Record<string, unknown>;
}

export interface LegacyPevMigrationResult {
  state: SupervisionRunState;
  migrated: boolean;
  metadata?: LegacyPevMigrationMetadata;
}

export type DurableSupervisionRuntime = LegacyPevSupervisionRuntime | GenericSupervisionRuntime;

export interface SupervisorAcceptance {
  /** This is a supervisor disposition, never a verifier PASS. */
  action: "accept";
  reason: string;
  acceptedAt: string;
  acceptedCheckpointId: string;
  hostInstanceId: string;
}

/** Host-owned administrative settlement for a conclusively orphaned paused run. */
export interface PausedRunRetirement {
  code: "conclusively_orphaned_paused_run";
  reason: string;
  retiredAt: string;
  owningHostInstanceId: string;
}

export interface SupervisionRunState {
  schemaVersion: 1;
  runId: string;
  mode: SupervisionMode;
  lane: RunLane;
  status: SupervisionStatus;
  mission: FrozenMission;
  createdAt: string;
  updatedAt: string;
  checkpointSequence: number;
  checkpoints: SupervisionCheckpoint[];
  tasks: CriterionTask[];
  approvedTaskIds: string[];
  completedCriteria: string[];
  currentTaskId?: string;
  lastTaskId?: string;
  currentApproval?: ApprovalRecord;
  automaticPlanApprovals?: Array<{ authority: "fixed-host-checks"; checkpointId: string; approvedAt: string; scope: string[] }>;
  audit: SupervisionAuditFacts;
  pauseReason?: string;
  terminalOutcome?: string;
  /** Host-owned, reasoned terminal disposition. It does not mark criteria passed. */
  acceptance?: SupervisorAcceptance;
  /** Administrative retirement is distinct from PASS, acceptance, cancellation, and failure. */
  retirement?: PausedRunRetirement;
  /** Host-owned resumable lifecycle payload. Kept in the mission-bound atomic state file. */
  runtime?: DurableSupervisionRuntime;
}

export interface ExecutorOutcomeAdvisory {
  code: "no_content_progress";
  message: string;
}

export interface SettledExecutorOutcome {
  outcome: "pass" | "fail" | "settled";
  reportedStatus?: "pass" | "fail";
  findings: unknown[];
  advisoryFlags: ExecutorOutcomeAdvisory[];
}

/**
 * Interpret a settled executor result without turning a zero-byte outcome into
 * an exception. The worker's own semantic verdict and findings are preserved;
 * an explicitly promised mutation that produced no bytes is supervisor-visible
 * advice, not a host-authored replacement verdict.
 */
export function classifySettledExecutorOutcome(input: {
  outputText: string;
  exitCode: number;
  contentChangeCount: number;
  expectsFileChange?: boolean;
}): SettledExecutorOutcome {
  const text = input.outputText.trim();
  let record: Record<string, unknown> | undefined;
  if (text) {
    const candidates = [text, ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim())];
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
          break;
        }
      } catch {
        // Prose is a valid executor result; inspect explicit status markers below.
      }
    }
  }

  const rawVerdict = record
    ? [record.status, record.overall, record.verdict, record.result].find((value) => typeof value === "string")
    : undefined;
  const proseVerdict = text.match(/^(?:FINAL[_ ]VERDICT|STATUS|OVERALL|RESULT)\s*[:=-]\s*(PASS|PASSED|SUCCESS|SUCCEEDED|FAIL|FAILED|ERROR|INCONCLUSIVE|UNKNOWN)\b/im)?.[1];
  const normalized = String(rawVerdict ?? proseVerdict ?? "").trim().toLowerCase();
  const reportedStatus = /^(?:pass|passed|success|succeeded)$/.test(normalized)
    ? "pass" as const
    : /^(?:fail|failed|error|inconclusive|unknown)$/.test(normalized)
      ? "fail" as const
      : undefined;
  const findings = Array.isArray(record?.findings) ? [...record.findings] : [];
  const outcome: SettledExecutorOutcome["outcome"] = input.exitCode !== 0 || !text || reportedStatus === "fail"
    ? "fail"
    : reportedStatus === "pass"
      ? "pass"
      : "settled";
  const advisoryFlags: ExecutorOutcomeAdvisory[] = input.expectsFileChange === true && input.contentChangeCount === 0
    ? [{ code: "no_content_progress", message: "Executor produced no byte-level change despite an explicit expectsFileChange=true plan declaration." }]
    : [];
  return {
    outcome,
    ...(reportedStatus ? { reportedStatus } : {}),
    findings,
    advisoryFlags,
  };
}

export interface DriftFlag {
  code:
    | "mission_hash_changed"
    | "cwd_changed"
    | "worktree_root_changed"
    | "worktree_real_root_changed"
    | "branch_changed"
    | "baseline_changed"
    | "content_baseline_changed"
    | "invalid_plan"
    | "protected_path"
    | "out_of_scope_path"
    | "unapproved_task"
    | "repeated_identical_failure"
    | "ambiguous_completion"
    | "no_content_progress";
  message: string;
  blocking: boolean;
}

export interface BoundaryDriftInput {
  mission: FrozenMission;
  currentMissionHash: string;
  currentCwd: string;
  currentWorktreeRoot: string;
  currentWorktreeRealRoot: string | null;
  currentBranch: string | null;
  currentBaseline: string | null;
  /** Runtime commit boundary; absent historical callers fall back to the frozen mission baseline. */
  acceptedBaseline?: string | null;
  /** Bounded paths associated with an unaccepted commit advance. */
  baselineChangePaths?: string[];
  planIssues?: ValidationIssue[];
  pathViolations?: LanePathViolation[];
  approvedTaskIds?: string[];
  observedTaskIds?: string[];
  repeatedIdenticalFailures?: number;
  ambiguousCompletion?: boolean;
  settledImplementationTask?: boolean;
  contentChanges?: ContentSignatureChange[];
}

export interface InspectionSnapshot {
  planSummary: { tasks: Array<CriterionTask & { acceptanceCriteria: AcceptanceCriterion[] }>; omittedTasks: number; declaredScope?: string[] };
  savedArtifacts: { state: string; plan?: string; result?: string; checkpoint?: string };
  checkpointState: { kind?: SupervisionCheckpoint["kind"]; awaitingApproval: boolean; approvalOutstanding: boolean; freshApprovalAvailable: boolean };
  settledResult?: { outcome?: string; text: string; omitted: boolean; findings?: unknown[] };
  automaticPlanApprovals: NonNullable<SupervisionRunState["automaticPlanApprovals"]>;
  runId: string;
  status: SupervisionStatus;
  missionHash: string;
  cwd: string;
  branch: string | null;
  baseline: string | null;
  currentTaskId?: string;
  lastTaskId?: string;
  currentTaskCriteria: string[];
  completedCriteria: string[];
  remainingCriteria: string[];
  contentChanges: ContentSignatureChange[];
  tests: SupervisionAuditFacts["tests"];
  retries: number;
  infrastructureFailures: InfrastructureFailure[];
  forbiddenChanges: string[];
  elapsedMs: number;
  noProgress: boolean;
  activeWorkers: SupervisionAuditFacts["activeWorkers"];
  detachedWorkers: SupervisionAuditFacts["detachedWorkers"];
  scopeAmendments: ScopeAmendment[];
  verifierBatches: GenericVerifierBatchEvidence[];
  retirement?: PausedRunRetirement;
  drift: DriftFlag[];
  allowedNextActions: SupervisionAction[];
  liveStatus: LiveStatus;
}

export interface LanePathViolation {
  path: string;
  resolvedPath: string;
  code: "protected_path" | "out_of_scope_path" | "path_escape";
  message: string;
}

export interface CriterionFinding {
  criterionId: string;
  status: "pass" | "fail";
  evidence: Array<{
    kind: "command" | "file" | "hash" | "test";
    observed: string;
    exitCode?: number;
  }>;
}

export interface NumericGateFinding extends CriterionFinding {
  metric: string;
  unit?: string;
  observedValue: number | null;
  op: NumericAcceptanceOperator;
  threshold: number;
  source: NumericEvidenceSource;
  /** Present when persisted evidence could not yield a finite numeric value. */
  error?: string;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key])}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON does not support ${typeof value} values.`);
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function assertNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function boundedIssueValue(value: string, maxLength = 80): string {
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

const NUMERIC_ACCEPTANCE_OPERATORS = new Set<NumericAcceptanceOperator>(["<", "<=", ">", ">=", "==", "!="]);
const NUMERIC_EVALUATION_UNAVAILABLE_CODES = new Set<NumericEvaluationUnavailable["code"]>([
  "missing_evidence_selector", "non_mechanical_target", "deferred_target",
]);
const MAX_NUMERIC_EVIDENCE_BYTES = 4 * 1024 * 1024;
const STRICT_NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function normalizeNumericUnit(value: unknown, label: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  const compact = assertNonEmptyString(value as string, label).trim().toLowerCase();
  if (compact.length > 64 || !/^[a-z%µμ][a-z0-9%µμ/_ .-]*$/i.test(compact)) {
    throw new Error(`${label} must be a bounded unit name.`);
  }
  const aliases: Record<string, string> = {
    millisecond: "ms", milliseconds: "ms", msec: "ms",
    second: "s", seconds: "s", sec: "s",
    microsecond: "us", microseconds: "us", "µs": "us", "μs": "us",
    minute: "min", minutes: "min",
    percent: "%", percentage: "%", counts: "count",
  };
  return aliases[compact] ?? compact;
}

function normalizeNumericTarget(value: unknown, criterionId: string): NumericAcceptanceTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`criterion ${criterionId} numericTarget must be an object.`);
  }
  const target = value as Record<string, unknown>;
  const metric = assertNonEmptyString(target.metric as string, `criterion ${criterionId} numericTarget.metric`).trim();
  if (metric.length > 256) throw new Error(`criterion ${criterionId} numericTarget.metric exceeds 256 characters.`);
  if (typeof target.op !== "string" || !NUMERIC_ACCEPTANCE_OPERATORS.has(target.op as NumericAcceptanceOperator)) {
    throw new Error(`criterion ${criterionId} numericTarget.op is unsupported.`);
  }
  if (typeof target.threshold !== "number" || !Number.isFinite(target.threshold)) {
    throw new Error(`criterion ${criterionId} numericTarget.threshold must be finite.`);
  }
  const sourceText = assertNonEmptyString(target.sourceText as string, `criterion ${criterionId} numericTarget.sourceText`).trim();
  if (sourceText.length > 1024) throw new Error(`criterion ${criterionId} numericTarget.sourceText exceeds 1024 characters.`);
  return {
    metric,
    op: target.op as NumericAcceptanceOperator,
    threshold: target.threshold,
    unit: normalizeNumericUnit(target.unit, `criterion ${criterionId} numericTarget.unit`, true) as string,
    sourceText,
  };
}

function normalizeNumericEvaluationUnavailable(value: unknown, criterionId: string): NumericEvaluationUnavailable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`criterion ${criterionId} numericEvaluationUnavailable must be an object.`);
  }
  const unavailable = value as Record<string, unknown>;
  if (typeof unavailable.code !== "string" || !NUMERIC_EVALUATION_UNAVAILABLE_CODES.has(unavailable.code as NumericEvaluationUnavailable["code"])) {
    throw new Error(`criterion ${criterionId} numericEvaluationUnavailable.code is unsupported.`);
  }
  const reason = assertNonEmptyString(unavailable.reason as string, `criterion ${criterionId} numericEvaluationUnavailable.reason`).trim();
  if (reason.length > 2048) throw new Error(`criterion ${criterionId} numericEvaluationUnavailable.reason exceeds 2048 characters.`);
  return { code: unavailable.code as NumericEvaluationUnavailable["code"], reason };
}

function durationUnitScale(unit: string | undefined): number | undefined {
  switch (unit) {
    case "us": return 0.001;
    case "ms": return 1;
    case "s": return 1000;
    case "min": return 60_000;
    default: return undefined;
  }
}

function numericUnitFromMetric(metric: string): string | undefined {
  const match = /(?:^|[\s_(\[/-])(milliseconds?|msec|ms|seconds?|sec|s|microseconds?|[µμ]s|us|minutes?|min|percent(?:age)?|%|frames?|bytes?|counts?)\s*$/i.exec(metric.trim());
  return match ? normalizeNumericUnit(match[1], "numericGate.metric unit") : undefined;
}

function numericallyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 8;
}

function numericTargetMatchesGate(target: NumericAcceptanceTarget, gate: NumericAcceptanceGate): boolean {
  if (target.op !== gate.op) return false;
  const targetScale = durationUnitScale(target.unit);
  const gateUnit = gate.unit ?? numericUnitFromMetric(gate.metric) ?? target.unit;
  const gateScale = durationUnitScale(gateUnit);
  if (targetScale !== undefined || gateScale !== undefined) {
    return targetScale !== undefined && gateScale !== undefined
      && numericallyEqual(target.threshold * targetScale, gate.threshold * gateScale);
  }
  return target.unit === gateUnit && numericallyEqual(target.threshold, gate.threshold);
}

function normalizeNumericAcceptanceGate(value: unknown, criterionId: string): NumericAcceptanceGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`criterion ${criterionId} numericGate must be an object.`);
  }
  const gate = value as Record<string, unknown>;
  const metric = assertNonEmptyString(gate.metric as string, `criterion ${criterionId} numericGate.metric`);
  if (metric.length > 256) throw new Error(`criterion ${criterionId} numericGate.metric exceeds 256 characters.`);
  if (!gate.source || typeof gate.source !== "object" || Array.isArray(gate.source)) {
    throw new Error(`criterion ${criterionId} numericGate.source must be an object.`);
  }
  const rawSource = gate.source as Record<string, unknown>;
  const sourcePath = assertNonEmptyString(rawSource.path as string, `criterion ${criterionId} numericGate.source.path`);
  if (sourcePath.length > 32_768) throw new Error(`criterion ${criterionId} numericGate.source.path is too long.`);
  const jsonPointer = rawSource.jsonPointer;
  const regex = rawSource.regex;
  if ((jsonPointer === undefined) === (regex === undefined)) {
    throw new Error(`criterion ${criterionId} numericGate.source requires exactly one of jsonPointer or regex.`);
  }
  if (jsonPointer !== undefined && (typeof jsonPointer !== "string" || (jsonPointer !== "" && !jsonPointer.startsWith("/")) || jsonPointer.length > 4_096)) {
    throw new Error(`criterion ${criterionId} numericGate.source.jsonPointer must be a bounded RFC 6901 pointer.`);
  }
  if (regex !== undefined) {
    if (typeof regex !== "string" || !regex || regex.length > 4_096) {
      throw new Error(`criterion ${criterionId} numericGate.source.regex must be bounded nonempty text.`);
    }
    try { new RegExp(regex, "m"); } catch {
      throw new Error(`criterion ${criterionId} numericGate.source.regex is invalid.`);
    }
  }
  if (typeof gate.op !== "string" || !NUMERIC_ACCEPTANCE_OPERATORS.has(gate.op as NumericAcceptanceOperator)) {
    throw new Error(`criterion ${criterionId} numericGate.op is unsupported.`);
  }
  if (typeof gate.threshold !== "number" || !Number.isFinite(gate.threshold)) {
    throw new Error(`criterion ${criterionId} numericGate.threshold must be finite.`);
  }
  return {
    metric,
    ...(gate.unit === undefined ? {} : { unit: normalizeNumericUnit(gate.unit, `criterion ${criterionId} numericGate.unit`) }),
    source: {
      path: sourcePath,
      ...(jsonPointer !== undefined ? { jsonPointer } : { regex: regex as string }),
    },
    op: gate.op as NumericAcceptanceOperator,
    threshold: gate.threshold,
  };
}

const PUBLIC_SUPERVISION_ACTIONS: ReadonlySet<string> = new Set(["run", "inspect", "continue", "accept", "pause", "cancel"]);

function assertPublicSupervisionAction(value: unknown, label: string): asserts value is SupervisionAction {
  if (typeof value !== "string" || !PUBLIC_SUPERVISION_ACTIONS.has(value)) {
    throw new Error(`${label} must be a public supervision action.`);
  }
}

function normalizeFrozenTestAuthorization(policy: FrozenTestAuthorizationPolicy | undefined): FrozenTestAuthorizationPolicy | undefined {
  if (!policy) return undefined;
  const clone = JSON.parse(JSON.stringify(policy)) as FrozenTestAuthorizationPolicy;
  const { policyHash, ...body } = clone;
  const expected = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (
    clone.schemaVersion !== 1
    || clone.authority !== "run-admission-owner-task"
    || !/^[a-f0-9]{64}$/.test(policyHash)
    || policyHash !== expected
    || !Array.isArray(clone.existingEntrypoints)
    || !Array.isArray(clone.approvedDynamicScopes)
    || !Array.isArray(clone.allowedNodeOptions)
  ) throw new Error("Frozen test authorization policy is invalid or was mutated.");
  return clone;
}

function normalizedMissionBody(input: FrozenMissionInput): FrozenMissionInput & { schemaVersion: 1 } {
  assertNonEmptyString(input.originalTask, "originalTask");
  assertNonEmptyString(input.paradigm, "paradigm");
  if (input.lane !== "product" && input.lane !== "orchestrator-maintenance") throw new Error("Invalid run lane.");
  const criterionIds = new Set<string>();
  const acceptanceCriteria = input.acceptanceCriteria.map((criterion) => {
    if (!/^AC-\d{2,}$/.test(criterion.id)) throw new Error(`Invalid stable criterion id: ${criterion.id}`);
    if (criterionIds.has(criterion.id)) throw new Error(`Duplicate criterion id: ${criterion.id}`);
    criterionIds.add(criterion.id);
    const numericTarget = criterion.numericTarget === undefined
      ? undefined
      : normalizeNumericTarget(criterion.numericTarget, criterion.id);
    const numericGate = criterion.numericGate === undefined
      ? undefined
      : normalizeNumericAcceptanceGate(criterion.numericGate, criterion.id);
    const numericEvaluationUnavailable = criterion.numericEvaluationUnavailable === undefined
      ? undefined
      : normalizeNumericEvaluationUnavailable(criterion.numericEvaluationUnavailable, criterion.id);
    if (numericTarget && !numericGate && !numericEvaluationUnavailable) {
      throw new Error(`criterion ${criterion.id} numeric target has prose-only coverage; supply a mechanical gate or an explicit mechanical evaluation unavailability explanation.`);
    }
    if (numericGate && numericEvaluationUnavailable) {
      throw new Error(`criterion ${criterion.id} cannot have both numericGate and numericEvaluationUnavailable.`);
    }
    if (numericEvaluationUnavailable && !numericTarget) {
      throw new Error(`criterion ${criterion.id} numericEvaluationUnavailable requires numericTarget.`);
    }
    if (numericTarget && numericGate && !numericTargetMatchesGate(numericTarget, numericGate)) {
      throw new Error(`criterion ${criterion.id} numeric gate does not match its frozen numeric target operator, threshold, and unit.`);
    }
    return {
      id: criterion.id,
      text: assertNonEmptyString(criterion.text, `criterion ${criterion.id}`),
      required: criterion.required === true,
      ...(numericTarget ? { numericTarget } : {}),
      ...(numericGate ? { numericGate } : {}),
      ...(numericEvaluationUnavailable ? { numericEvaluationUnavailable } : {}),
    };
  });
  if (acceptanceCriteria.length === 0) throw new Error("At least one acceptance criterion is required.");
  const routes = input.routes.map((route) => ({
    role: assertNonEmptyString(route.role, "route.role"),
    agentName: assertNonEmptyString(route.agentName, "route.agentName"),
    provider: assertNonEmptyString(route.provider, "route.provider"),
    model: assertNonEmptyString(route.model, "route.model"),
  })).sort((left, right) => left.role.localeCompare(right.role));
  // Preserve the caller's original cwd spelling in durable mission authority
  // (notably `C:\\...` on Windows). Comparison paths are canonicalized only at
  // the boundary; persistence must not silently rewrite user-visible identity.
  const cwd = assertNonEmptyString(input.cwd, "cwd");
  const root = normalizeWriteSetEntry(path.resolve(input.worktree.root));
  const realRoot = normalizeWriteSetEntry(path.resolve(input.worktree.realRoot));
  return {
    schemaVersion: 1,
    originalTask: input.originalTask,
    cwd,
    worktree: {
      root,
      realRoot,
      branch: input.worktree.branch,
      baseline: input.worktree.baseline,
    },
    paradigm: input.paradigm,
    lane: input.lane,
    routes,
    constraints: input.constraints.map((item) => assertNonEmptyString(item, "constraint")),
    nonGoals: input.nonGoals.map((item) => assertNonEmptyString(item, "nonGoal")),
    acceptanceCriteria,
    workerExecutionConstraints: {
      noForceKill: input.workerExecutionConstraints?.noForceKill === true,
      ...(normalizeFrozenTestAuthorization(input.workerExecutionConstraints?.testAuthorization)
        ? { testAuthorization: normalizeFrozenTestAuthorization(input.workerExecutionConstraints?.testAuthorization) }
        : {}),
    },
    ...(input.externalEvidenceRoots !== undefined
      ? {
          externalEvidenceRoots: canonicalizeExternalEvidenceRoots({
            cwd,
            worktreeRoot: root,
            worktreeRealRoot: realRoot,
            roots: input.externalEvidenceRoots,
            protectedRoots: defaultProtectedRoots(),
          }),
        }
      : {}),
    ...(input.criteriaAuthority
      ? {
          criteriaAuthority: {
            ownerCriteria: {
              success: input.criteriaAuthority.ownerCriteria.success.map((item) => assertNonEmptyString(item, "owner success criterion")),
              failure: input.criteriaAuthority.ownerCriteria.failure.map((item) => assertNonEmptyString(item, "owner failure criterion")),
              ...(input.criteriaAuthority.ownerCriteria.outputContract
                ? { outputContract: assertNonEmptyString(input.criteriaAuthority.ownerCriteria.outputContract, "owner output contract") }
                : {}),
            },
            supervisorAddedConstraints: input.criteriaAuthority.supervisorAddedConstraints
              .map((item) => assertNonEmptyString(item, "supervisor-added constraint")),
            plannerInferredPresentationRules: input.criteriaAuthority.plannerInferredPresentationRules
              .map((item) => assertNonEmptyString(item, "planner-inferred presentation rule")),
          },
        }
      : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Freeze the complete original mission authority and bind it to canonical SHA-256. */
export function createFrozenMission(input: FrozenMissionInput): FrozenMission {
  const body = normalizedMissionBody(input);
  return deepFreeze({ ...body, missionHash: sha256Canonical(body) });
}

export function verifyFrozenMission(mission: FrozenMission): boolean {
  if (!mission || typeof mission !== "object" || Array.isArray(mission)) return false;
  try {
    const { missionHash, ...body } = mission;
    return typeof missionHash === "string" && /^[a-f0-9]{64}$/.test(missionHash) && sha256Canonical(body) === missionHash;
  } catch {
    return false;
  }
}

function valueAtJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  let current = document;
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = encodedToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, token)) {
      throw new Error(`JSON pointer did not resolve at token ${JSON.stringify(token)}.`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function finiteNumericValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && STRICT_NUMBER_TEXT.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("selected evidence value is not a finite number.");
}

function readNumericEvidence(mission: FrozenMission, source: NumericEvidenceSource): number {
  const absoluteSource = path.isAbsolute(source.path) || /^[a-zA-Z]:[\\/]/.test(source.path);
  let evidencePath: string;
  if (absoluteSource) {
    // Missions created before AH omitted this field and retain legacy replay
    // compatibility. Every new host-created mission freezes [] or explicit roots.
    evidencePath = mission.externalEvidenceRoots === undefined
      ? path.resolve(source.path)
      : resolveDeclaredExternalEvidencePath(source.path, mission.externalEvidenceRoots);
  } else {
    if (normalizeWriteSetEntry(source.path).split("/").includes("..")) {
      throw new Error("numeric evidence source contains forbidden parent traversal.");
    }
    evidencePath = path.resolve(mission.cwd, source.path);
    const realEvidence = fs.realpathSync.native(evidencePath);
    if (!insideOrEqual(normalizeForComparison(realEvidence), normalizeForComparison(mission.worktree.realRoot))) {
      throw new Error("numeric evidence source escapes the frozen worktree through a symlink or junction.");
    }
  }
  const stat = fs.statSync(evidencePath);
  if (!stat.isFile()) throw new Error("numeric evidence source is not a regular file.");
  if (stat.size > MAX_NUMERIC_EVIDENCE_BYTES) {
    throw new Error(`numeric evidence source exceeds ${MAX_NUMERIC_EVIDENCE_BYTES} bytes.`);
  }
  const text = fs.readFileSync(evidencePath, "utf8");
  if (source.jsonPointer !== undefined) {
    return finiteNumericValue(valueAtJsonPointer(JSON.parse(text) as unknown, source.jsonPointer));
  }
  const match = new RegExp(source.regex as string, "m").exec(text);
  if (!match) throw new Error("numeric evidence regex did not match.");
  return finiteNumericValue(match[1] ?? match[0]);
}

function compareNumericAcceptance(observed: number, op: NumericAcceptanceOperator, threshold: number): boolean {
  switch (op) {
    case "<": return observed < threshold;
    case "<=": return observed <= threshold;
    case ">": return observed > threshold;
    case ">=": return observed >= threshold;
    case "==": return observed === threshold;
    case "!=": return observed !== threshold;
  }
}

/**
 * Surface owner numeric targets that could not be bound to persisted evidence.
 * These stop silent prose-only completion but remain supervisor-resolvable
 * because the host must not invent evidence paths or selectors.
 */
export function numericTargetCoverageIssues(mission: FrozenMission): ValidationIssue[] {
  return mission.acceptanceCriteria
    .filter((criterion) => criterion.numericTarget && !criterion.numericGate)
    .map((criterion) => ({
      code: "numeric_evaluation_unavailable",
      message: `${criterion.id} numeric target ${criterion.numericTarget?.sourceText} is not mechanically evaluated: ${criterion.numericEvaluationUnavailable?.reason ?? "no durable explanation was recorded"}`,
      criterionId: criterion.id,
      advisory: true as const,
    }));
}

/** Evaluate frozen numeric gates from persisted files without trusting reviewer prose. */
export function evaluateNumericAcceptanceGates(mission: FrozenMission): NumericGateFinding[] {
  const findings: NumericGateFinding[] = [];
  for (const criterion of mission.acceptanceCriteria) {
    const gate = criterion.numericGate;
    if (!gate) continue;
    try {
      const observedValue = readNumericEvidence(mission, gate.source);
      const passed = compareNumericAcceptance(observedValue, gate.op, gate.threshold);
      findings.push({
        criterionId: criterion.id,
        status: passed ? "pass" : "fail",
        metric: gate.metric,
        ...(gate.unit ? { unit: gate.unit } : {}),
        observedValue,
        op: gate.op,
        threshold: gate.threshold,
        source: gate.source,
        evidence: [{
          kind: "file",
          observed: `${gate.metric}: ${observedValue}${gate.unit ? ` ${gate.unit}` : ""} ${gate.op} ${gate.threshold}${gate.unit ? ` ${gate.unit}` : ""} => ${passed ? "PASS" : "FAIL"} (${gate.source.path}${gate.source.jsonPointer !== undefined ? `#${gate.source.jsonPointer}` : ` regex=${JSON.stringify(gate.source.regex)}`})`,
        }],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push({
        criterionId: criterion.id,
        status: "fail",
        metric: gate.metric,
        ...(gate.unit ? { unit: gate.unit } : {}),
        observedValue: null,
        op: gate.op,
        threshold: gate.threshold,
        source: gate.source,
        error: message,
        evidence: [{ kind: "file", observed: `${gate.metric}: unavailable ${gate.op} ${gate.threshold}${gate.unit ? ` ${gate.unit}` : ""} => FAIL (${message})` }],
      });
    }
  }
  return findings;
}

/** Validate criterion coverage, dependencies, task authority, and write scope before spawning. */
export function validateCriterionTaskPlan(
  tasks: CriterionTask[],
  mission: FrozenMission,
  options: PlanValidationOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownCriteria = new Set(mission.acceptanceCriteria.map((criterion) => criterion.id));
  const requiredCriteria = new Set(mission.acceptanceCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id));
  const coveredCriteria = new Set<string>();
  const taskIds = new Set<string>();
  const approved = options.approvedTaskIds ? new Set(options.approvedTaskIds) : undefined;

  for (const task of tasks) {
    if (!task.id.trim() || taskIds.has(task.id)) {
      issues.push({ code: "invalid_task_id", message: `Task id is empty or duplicated: ${task.id}`, taskId: task.id });
    }
    taskIds.add(task.id);
    if (approved && !approved.has(task.id)) {
      issues.push({ code: "unapproved_task", message: `Task ${task.id} is not in the approved plan.`, taskId: task.id });
    }
    if (!task.description.trim()) issues.push({ code: "missing_task_description", message: `Task ${task.id} has no description.`, taskId: task.id });
    if (!Array.isArray(task.criteria) || task.criteria.length === 0) {
      issues.push({ code: "criteria_less_task", message: `Task ${task.id} advances no criterion.`, taskId: task.id });
    }
    for (const criterionId of new Set(task.criteria ?? [])) {
      if (!knownCriteria.has(criterionId)) {
        issues.push({ code: "orphan_criterion", message: `Task ${task.id} references unknown ${criterionId}.`, taskId: task.id, criterionId });
      } else {
        coveredCriteria.add(criterionId);
      }
    }
    if (options.allowedWriteSet) {
      for (const candidate of task.predictedWriteSet ?? []) {
        if (isWindowsReservedDevicePath(candidate)) continue;
        if (!fileMatchesWriteSet(candidate, options.allowedWriteSet, options.cwd)) {
          issues.push({ code: "scope_expansion", message: `Task ${task.id} predicts out-of-scope path ${candidate}.`, taskId: task.id, path: candidate });
        }
      }
    }
  }
  for (const criterionId of requiredCriteria) {
    if (!coveredCriteria.has(criterionId)) {
      issues.push({ code: "uncovered_required_criterion", message: `Required ${criterionId} is not covered by any task.`, criterionId });
    }
  }
  for (const task of tasks) {
    const seenDependencies = new Set<string>();
    let duplicateReported = false;
    for (const dependency of task.dependsOn) {
      if (seenDependencies.has(dependency)) {
        if (!duplicateReported) {
          issues.push({
            code: "duplicate_dependency",
            message: `Task ${boundedIssueValue(task.id)} repeats dependency ${boundedIssueValue(dependency)}.`,
            taskId: boundedIssueValue(task.id),
          });
          duplicateReported = true; // one deterministic, bounded finding per hostile task
        }
        continue;
      }
      seenDependencies.add(dependency);
      if (dependency === task.id || !taskIds.has(dependency)) {
        issues.push({
          code: "invalid_dependency",
          message: `Task ${boundedIssueValue(task.id)} has invalid dependency ${boundedIssueValue(dependency)}.`,
          taskId: task.id,
        });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): boolean => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    const cycle = (taskById.get(taskId)?.dependsOn ?? []).some((dependency) => taskById.has(dependency) && visit(dependency));
    visiting.delete(taskId);
    visited.add(taskId);
    return cycle;
  };
  for (const task of tasks) {
    if (visit(task.id)) {
      issues.push({ code: "dependency_cycle", message: `Dependency cycle includes ${task.id}.`, taskId: task.id });
      break;
    }
  }
  return issues;
}

export function issueApprovalToken(
  binding: ApprovalBinding,
  now = new Date(),
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): { token: string; record: ApprovalRecord } {
  for (const key of ["runId", "missionHash", "checkpointId"] as const) assertNonEmptyString(binding[key], key);
  assertPublicSupervisionAction(binding.action, "action");
  const token = `sup1_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    record: { ...binding, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), issuedAt: now.toISOString() },
  };
}

/** Return a consumed copy. The caller atomically persists it before spawning. */
export function consumeApprovalToken(
  record: ApprovalRecord,
  token: string,
  expected: ApprovalBinding,
  now = new Date(),
): ApprovalRecord {
  if (record.consumedAt || record.invalidatedAt) throw new Error("Approval token is stale or already consumed.");
  assertPublicSupervisionAction(record.action, "persisted action");
  assertPublicSupervisionAction(expected.action, "expected action");
  for (const key of ["runId", "missionHash", "checkpointId", "action"] as const) {
    if (record[key] !== expected[key]) throw new Error(`Approval token has wrong ${key} binding.`);
  }
  const actualHash = crypto.createHash("sha256").update(token).digest();
  const expectedHash = Buffer.from(record.tokenHash, "hex");
  if (actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) {
    throw new Error("Approval token is invalid.");
  }
  return { ...record, consumedAt: now.toISOString() };
}

/** Build executor-checkpoint evidence from an already consumed host record. */
export function createApprovalConsumptionMetadata(record: ApprovalRecord): ApprovalConsumptionMetadata {
  if (!/^[a-f0-9]{64}$/i.test(record.tokenHash)) throw new Error("Approval token fingerprint is invalid.");
  if (!record.consumedAt || !Number.isFinite(Date.parse(record.consumedAt))) {
    throw new Error("Approval token is not consumed; executor checkpoint metadata is unavailable.");
  }
  for (const key of ["runId", "missionHash", "checkpointId"] as const) assertNonEmptyString(record[key], key);
  assertPublicSupervisionAction(record.action, "persisted action");
  return {
    authority: "visible-main-host",
    tokenFingerprint: `sha256:${record.tokenHash.toLowerCase()}`,
    binding: {
      runId: record.runId,
      missionHash: record.missionHash,
      checkpointId: record.checkpointId,
      action: record.action,
    },
    consumedAt: record.consumedAt,
  };
}

export function createExecutorCheckpointHostMetadata(
  approvalConsumption: ApprovalConsumptionMetadata,
): ExecutorCheckpointHostMetadata {
  return {
    schemaVersion: 1,
    approvalConsumption: structuredClone(approvalConsumption),
  };
}

// `verifying` is an internal state transition, never a visible-main action.
const LEGAL_TRANSITIONS: Record<SupervisionStatus, ReadonlySet<SupervisionStatus>> = {
  plan_checkpoint: new Set(["awaiting_supervisor", "paused", "blocked_infrastructure", "cancelled"]),
  awaiting_supervisor: new Set(["executing", "verifying", "terminal", "paused", "blocked_infrastructure", "cancelled"]),
  executing: new Set(["awaiting_supervisor", "paused", "blocked_infrastructure", "cancelled"]),
  paused: new Set(["awaiting_supervisor", "terminal", "cancelled"]),
  blocked_infrastructure: new Set(["paused", "cancelled"]),
  cancelled: new Set(),
  verifying: new Set(["awaiting_supervisor", "paused", "blocked_infrastructure", "cancelled", "terminal"]),
  terminal: new Set(),
};

export function transitionSupervisionState(
  state: SupervisionRunState,
  nextStatus: SupervisionStatus,
  now = new Date(),
): SupervisionRunState {
  if (!LEGAL_TRANSITIONS[state.status].has(nextStatus)) {
    throw new Error(`Illegal supervision transition: ${state.status} -> ${nextStatus}.`);
  }
  return { ...state, status: nextStatus, updatedAt: now.toISOString() };
}

function parseHostInstanceId(value: unknown): { pid: number; startedAt: number } | undefined {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}:[1-9]\d{0,15}$/.test(value)) return undefined;
  const [pid, startedAt] = value.split(":").map(Number);
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff || !Number.isSafeInteger(startedAt)) return undefined;
  return { pid, startedAt };
}

/**
 * Only ESRCH for a valid owning PID proves the host is gone. Missing/malformed
 * legacy ownership and all other probe errors are unknown, never dead. A live
 * reused PID is deliberately preserved even if its recorded start time differs.
 */
export function deadOwningHostPauseReason(
  hostInstanceId: unknown,
  observeProcess: ProcessIdentityObserver = observeProcessIdentity,
): string | undefined {
  const identity = parseHostInstanceId(hostInstanceId);
  if (!identity) return undefined;
  const observation = observeProcess(identity.pid);
  if (observation.status !== "dead" || observation.evidence !== "ESRCH") return undefined;
  return `process_restart_requires_fresh_visible_main_approval; owning_host_pid_dead: pid=${identity.pid}; probe=ESRCH`;
}

/** Restart recovery always invalidates an old approval and pauses nonterminal work. */
export function restartToPaused(state: SupervisionRunState, now = new Date()): SupervisionRunState {
  if (state.status === "terminal" || state.status === "cancelled") return structuredClone(state);
  return {
    ...structuredClone(state),
    status: "paused",
    updatedAt: now.toISOString(),
    pauseReason: "process_restart_requires_fresh_visible_main_approval",
    ...(state.currentApproval
      ? { currentApproval: { ...state.currentApproval, invalidatedAt: state.currentApproval.invalidatedAt ?? now.toISOString() } }
      : {}),
  };
}

export type PausedRunRetirementRejectionCode =
  | "not_paused"
  | "not_dead_host_pause"
  | "owning_host_identity_unknown"
  | "owning_host_live"
  | "owning_host_pid_reused"
  | "owning_host_liveness_unknown"
  | "run_state_inaccessible"
  | "detached_worker_present"
  | "survivor_present"
  | "active_worker_identity_unknown"
  | "active_worker_live"
  | "active_worker_pid_reused"
  | "active_worker_liveness_unknown"
  | "worker_settlement_ambiguous";

export type PausedRunRetirementAssessment =
  | { eligible: true; owningHostInstanceId: string; reason: string }
  | { eligible: false; code: PausedRunRetirementRejectionCode; reason: string };

function rejection(code: PausedRunRetirementRejectionCode, reason: string): PausedRunRetirementAssessment {
  return { eligible: false, code, reason };
}

function conclusivelyDead(observation: ProcessIdentityObservation): boolean {
  return observation.status === "dead" && observation.evidence === "ESRCH";
}

function assessWorkerProcess(
  pidValue: unknown,
  expectedStartedAt: number | undefined,
  observeProcess: ProcessIdentityObserver,
): PausedRunRetirementAssessment | undefined {
  if (!Number.isSafeInteger(pidValue) || (pidValue as number) < 1 || (pidValue as number) > 0x7fffffff) {
    return rejection("active_worker_identity_unknown", "An active worker record has no valid PID.");
  }
  const pid = pidValue as number;
  const observation = observeProcess(pid);
  if (conclusivelyDead(observation)) return undefined;
  if (observation.status === "unknown" || observation.status === "dead") {
    return rejection("active_worker_liveness_unknown", `Worker PID ${pid} is not conclusively absent: ${observation.status === "unknown" ? observation.reason : observation.evidence}.`);
  }
  if (
    expectedStartedAt !== undefined && observation.startedAt !== undefined &&
    Math.abs(observation.startedAt - expectedStartedAt) > 2_000
  ) {
    return rejection("active_worker_pid_reused", `Worker PID ${pid} belongs to a different process generation.`);
  }
  return rejection("active_worker_live", `Worker PID ${pid} is still alive.`);
}

/**
 * Read-only eligibility check for administrative retirement. Every unknown is
 * a rejection: old run formats, inaccessible files, detached survivors, and
 * non-conclusive process probes can never become evidence of absence.
 */
export function assessPausedRunRetirement(
  state: SupervisionRunState,
  runDir: string,
  observeProcess: ProcessIdentityObserver = observeProcessIdentity,
): PausedRunRetirementAssessment {
  if (state.status !== "paused") return rejection("not_paused", `Run status is ${state.status}, not paused.`);
  const host = parseHostInstanceId(state.runtime?.hostInstanceId);
  if (!host) return rejection("owning_host_identity_unknown", "The paused run has no valid owning-host generation identity.");
  const requiredPauseReason = `process_restart_requires_fresh_visible_main_approval; owning_host_pid_dead: pid=${host.pid}; probe=ESRCH`;
  if (state.pauseReason !== requiredPauseReason) {
    return rejection("not_dead_host_pause", "The pause was not produced by the dead-owning-host fence.");
  }
  const hostObservation = observeProcess(host.pid);
  if (!conclusivelyDead(hostObservation)) {
    if (hostObservation.status === "alive") {
      return rejection(
        hostObservation.startedAt !== undefined && Math.abs(hostObservation.startedAt - host.startedAt) > 2_000
          ? "owning_host_pid_reused"
          : "owning_host_live",
        hostObservation.startedAt !== undefined && Math.abs(hostObservation.startedAt - host.startedAt) > 2_000
          ? `Owning PID ${host.pid} has been reused by another process generation.`
          : `Owning host PID ${host.pid} is alive.`,
      );
    }
    return rejection("owning_host_liveness_unknown", `Owning host PID ${host.pid} is not conclusively dead: ${hostObservation.status === "unknown" ? hostObservation.reason : hostObservation.evidence}.`);
  }

  if (state.audit.detachedWorkers.length) {
    return rejection("detached_worker_present", "The supervision audit still contains a detached worker.");
  }

  let names: string[];
  let runState: unknown;
  try {
    names = fs.readdirSync(runDir);
    runState = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  } catch (error) {
    return rejection("run_state_inaccessible", `Run-state evidence is inaccessible or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRuntimeRecord(runState) || runState.runId !== state.runId || !Array.isArray(runState.phases)) {
    return rejection("run_state_inaccessible", "Run-state evidence has an invalid identity or phase collection.");
  }
  if (runState.phases.some((phase) => isRuntimeRecord(phase) && phase.status === "detached")) {
    return rejection("survivor_present", "The durable run state contains a detached survivor phase.");
  }
  if (names.some((name) => /^survivor-.*\.json$/i.test(name))) {
    return rejection("survivor_present", "A durable survivor artifact is present.");
  }

  const activeWorkers = [...state.audit.activeWorkers.map((worker) => ({ pid: worker.pid, startedAt: undefined as number | undefined }))];
  for (const name of names.filter((candidate) => /^phase-.*\.result\.json$/i.test(candidate))) {
    let sidecar: unknown;
    try {
      sidecar = JSON.parse(fs.readFileSync(path.join(runDir, name), "utf8"));
    } catch (error) {
      return rejection("run_state_inaccessible", `Phase settlement evidence ${name} is inaccessible or malformed.`);
    }
    if (!isRuntimeRecord(sidecar) || sidecar.kind !== "subagent-phase-result") {
      return rejection("run_state_inaccessible", `Phase settlement evidence ${name} has an unknown format.`);
    }
    if (sidecar.status === "incomplete") {
      return rejection("worker_settlement_ambiguous", `Phase settlement evidence ${name} is incomplete.`);
    }
    if (sidecar.status === "running") {
      const startedAt = typeof sidecar.startedAt === "string" && Number.isFinite(Date.parse(sidecar.startedAt))
        ? Date.parse(sidecar.startedAt)
        : undefined;
      activeWorkers.push({ pid: typeof sidecar.pid === "number" ? sidecar.pid : undefined, startedAt });
    } else if (sidecar.status !== "complete") {
      return rejection("worker_settlement_ambiguous", `Phase settlement evidence ${name} has unknown status ${String(sidecar.status)}.`);
    }
  }

  const observed = new Set<string>();
  for (const worker of activeWorkers) {
    const key = `${String(worker.pid)}:${String(worker.startedAt)}`;
    if (observed.has(key)) continue;
    observed.add(key);
    const workerRejection = assessWorkerProcess(worker.pid, worker.startedAt, observeProcess);
    if (workerRejection) return workerRejection;
  }

  return {
    eligible: true,
    owningHostInstanceId: `${host.pid}:${host.startedAt}`,
    reason: `Paused run retired because owning host PID ${host.pid} is conclusively dead (ESRCH), every recorded worker is conclusively absent, and no detached survivor exists.`,
  };
}

export function executorBoundaryDecision(input: { settled: boolean; elapsedMs: number }): "continue_executor" | "awaiting_supervisor" {
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) throw new Error("elapsedMs must be non-negative.");
  // Elapsed time may produce UI telemetry, but never terminates a coherent task.
  return input.settled ? "awaiting_supervisor" : "continue_executor";
}

/** Canonical comparison identity without changing the persisted spelling. */
export function canonicalDirectoryIdentity(value: string): string {
  const text = assertNonEmptyString(value, "directory");
  const windowsAbsolute = /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text);
  const resolved = windowsAbsolute ? path.win32.resolve(text) : path.resolve(text);
  const normalized = normalizeWriteSetEntry(resolved).replace(/\/$/, "");
  return process.platform === "win32" || windowsAbsolute ? normalized.toLowerCase() : normalized;
}

function normalizeForComparison(value: string): string {
  return canonicalDirectoryIdentity(value);
}

function insideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Canonicalize through the nearest existing ancestor without creating or opening the target. */
function resolveWithoutSymlinkEscape(candidate: string): string {
  let existing = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
  try {
    return path.resolve(fs.realpathSync.native(existing), ...suffix);
  } catch (error) {
    // A dangling link is still canonicalized to its lexical target so it cannot
    // become an allowed escape merely because the target does not exist yet.
    const stat = fs.lstatSync(existing);
    if (!stat.isSymbolicLink()) throw error;
    return path.resolve(path.dirname(existing), fs.readlinkSync(existing), ...suffix);
  }
}

function hasLexicalParentTraversal(candidate: string): boolean {
  return normalizeWriteSetEntry(candidate).split("/").includes("..");
}

export function defaultProtectedRoots(): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return [
    path.join(home, ".pi", "pi-orchestrator-extension"),
    path.join(home, ".pi", "agent"),
    path.join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
  ].map((entry) => normalizeWriteSetEntry(path.resolve(entry)));
}

/** Product work cannot cross its pinned worktree/write-set or enter host-owned protected roots. */
export function checkLanePaths(input: {
  lane: RunLane;
  cwd: string;
  paths: string[];
  allowedWriteSet?: string[];
  /** Evidence-only roots are accepted for inspection but deliberately ignored as write grants. */
  externalEvidenceRoots?: string[];
  protectedRoots?: string[];
  worktree?: { root: string; realRoot: string };
}): LanePathViolation[] {
  const cwd = path.resolve(input.cwd);
  const lexicalRoot = path.resolve(input.worktree?.root ?? cwd);
  const actualRoot = resolveWithoutSymlinkEscape(lexicalRoot);
  const realRoot = path.resolve(input.worktree?.realRoot ?? actualRoot);
  const resolvedCwd = resolveWithoutSymlinkEscape(cwd);
  const rootBindingValid = normalizeForComparison(actualRoot) === normalizeForComparison(realRoot)
    && insideOrEqual(normalizeForComparison(cwd), normalizeForComparison(lexicalRoot))
    && insideOrEqual(normalizeForComparison(resolvedCwd), normalizeForComparison(realRoot));
  const protectedRoots = (input.protectedRoots ?? defaultProtectedRoots()).map((root) => resolveWithoutSymlinkEscape(root));
  const violations: LanePathViolation[] = [];
  for (const candidate of input.paths) {
    // Device pseudo-paths are neither product effects nor grantable filesystem
    // targets on Windows. Filter them before path resolution or lstat calls.
    if (isWindowsReservedDevicePath(candidate)) continue;
    const lexical = path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate)
      ? path.resolve(candidate)
      : path.resolve(cwd, candidate);
    const resolved = resolveWithoutSymlinkEscape(lexical);
    const normalizedResolved = normalizeWriteSetEntry(resolved);
    const explicitlyGranted = Boolean(input.allowedWriteSet && fileMatchesWriteSet(candidate, input.allowedWriteSet, cwd));
    const resolvedGranted = Boolean(input.allowedWriteSet && fileMatchesWriteSet(normalizedResolved, input.allowedWriteSet, cwd));
    const lexicalInsideRoot = insideOrEqual(normalizeForComparison(lexical), normalizeForComparison(lexicalRoot));
    const resolvedInsideRoot = insideOrEqual(normalizeForComparison(resolved), normalizeForComparison(realRoot));

    if (hasLexicalParentTraversal(candidate)) {
      violations.push({ path: candidate, resolvedPath: normalizedResolved, code: "path_escape", message: `${candidate} contains forbidden parent traversal.` });
      continue;
    }
    if (input.lane === "product" && (!rootBindingValid || !lexicalInsideRoot)) {
      violations.push({ path: candidate, resolvedPath: normalizedResolved, code: "path_escape", message: `${candidate} escapes the frozen worktree root.` });
      continue;
    }
    if (input.lane === "product" && protectedRoots.some((root) => insideOrEqual(normalizeForComparison(resolved), normalizeForComparison(root)))) {
      violations.push({ path: candidate, resolvedPath: normalizedResolved, code: "protected_path", message: `${candidate} enters a host-owned protected root during product work.` });
      continue;
    }
    if (input.lane === "product" && !resolvedInsideRoot) {
      violations.push({ path: candidate, resolvedPath: normalizedResolved, code: "path_escape", message: `${candidate} crosses a symlink or junction outside the frozen worktree root.` });
      continue;
    }
    if (input.lane === "orchestrator-maintenance") {
      const lexicalInsideCwd = insideOrEqual(normalizeForComparison(lexical), normalizeForComparison(cwd));
      const resolvedInsideCwd = insideOrEqual(normalizeForComparison(resolved), normalizeForComparison(resolvedCwd));
      if ((!lexicalInsideCwd && !explicitlyGranted) || (!resolvedInsideCwd && !resolvedGranted)) {
        violations.push({ path: candidate, resolvedPath: normalizedResolved, code: "path_escape", message: `${candidate} escapes the maintenance cwd without an explicit canonical grant.` });
        continue;
      }
    }
    if (input.allowedWriteSet && !explicitlyGranted) {
      violations.push({ path: candidate, resolvedPath: normalizedResolved, code: "out_of_scope_path", message: `${candidate} is outside the frozen write set.` });
    }
  }
  return violations;
}

/**
 * Split lane violations into the ones that stay hard stops (worktree escape,
 * protected host roots) and the ones that are only a planner scope omission.
 * An out-of-scope path inside the frozen worktree is a supervisor decision,
 * not an infrastructure failure (guard-decisions, 2026-09-03).
 */
export function partitionLaneViolations(violations: LanePathViolation[]): {
  hard: LanePathViolation[];
  scope: LanePathViolation[];
} {
  const hard = violations.filter((violation) => violation.code !== "out_of_scope_path");
  const scope = violations.filter((violation) => violation.code === "out_of_scope_path");
  return { hard, scope };
}

export function classifyInfrastructureFailure(error: unknown): InfrastructureFailure {
  const object = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; info?: unknown } : undefined;
  const message = object?.message !== undefined ? String(object.message) : String(error ?? "");
  const info = object?.info && typeof object.info === "object" ? object.info as Record<string, unknown> : undefined;
  if (info?.code === "provider_refused") {
    return {
      infrastructure: true,
      code: "provider_refused",
      message,
      providerMessage: String(info.providerMessage ?? message),
      retryAllowed: info.retryAllowed === true,
      retryEligible: info.retryEligible === true,
      retryAttempted: info.retryAttempted === true,
      mutationAmbiguous: info.mutationAmbiguous === true,
    };
  }
  if (object?.code === "command_unavailable" || info?.code === "command_unavailable") {
    return {
      infrastructure: true,
      code: "command_unavailable",
      message,
      retryAllowed: true,
      retryEligible: true,
      retryAttempted: false,
      mutationAmbiguous: false,
    };
  }
  const haystack = `${String(object?.code ?? "")} ${message}`.toLowerCase();
  if (/content was flagged for possible (?:cybersecurity|security) risk/i.test(message)
    || /provider (?:policy )?refus(?:al|ed)[\s\S]{0,240}try rephrasing/i.test(message)) {
    return { infrastructure: true, code: "provider_refused", message, providerMessage: message };
  }
  const rules: Array<[InfrastructureFailure["code"], RegExp]> = [
    ["write_set", /write[_ -]?set|unobservable scope|predicted write/],
    ["checkpoint", /checkpoint|run state|resume state|atomic write|enoent.*state\.json/],
    ["provider", /provider|model unavailable|rate limit|quota|authentication|unauthorized|http 429/],
    ["transport", /transport|websocket|socket|econnreset|epipe|stream ended|spawn eperm/],
    ["parser", /parser|parse error|invalid json|unexpected token|schema validation/],
    ["orchestrator", /orchestrat|subagent|spawn budget|ambiguous completion|result lost/],
  ];
  const matched = rules.find(([, pattern]) => pattern.test(haystack));
  return matched ? { infrastructure: true, code: matched[0], message } : { infrastructure: false, message };
}

export function detectBoundaryDrift(input: BoundaryDriftInput): DriftFlag[] {
  const flags: DriftFlag[] = [];
  const add = (code: DriftFlag["code"], message: string, blocking = true) => flags.push({ code, message, blocking });
  if (!verifyFrozenMission(input.mission) || input.currentMissionHash !== input.mission.missionHash) add("mission_hash_changed", "Frozen mission authority changed.");
  if (normalizeForComparison(input.currentCwd) !== normalizeForComparison(input.mission.cwd)) add("cwd_changed", "Working directory changed from the frozen mission.");
  if (normalizeForComparison(input.currentWorktreeRoot) !== normalizeForComparison(input.mission.worktree.root)) {
    add("worktree_root_changed", "Git worktree root changed from the frozen mission.");
  }
  if (
    input.currentWorktreeRealRoot === null ||
    normalizeForComparison(input.currentWorktreeRealRoot) !== normalizeForComparison(input.mission.worktree.realRoot)
  ) {
    add("worktree_real_root_changed", "Canonical worktree identity changed from the frozen mission.");
  }
  if (input.currentBranch !== input.mission.worktree.branch) add("branch_changed", "Git branch changed from the frozen mission.");
  const acceptedBaseline = Object.prototype.hasOwnProperty.call(input, "acceptedBaseline")
    ? input.acceptedBaseline ?? null
    : input.mission.worktree.baseline;
  if (input.currentBaseline !== acceptedBaseline) {
    const paths = [...new Set((input.baselineChangePaths ?? []).filter(Boolean))].slice(0, 10);
    const pathSummary = paths.length ? paths.join(", ") : "no byte-level path changes observed";
    add(
      "baseline_changed",
      `Git baseline changed from the accepted runtime commit (${acceptedBaseline ?? "none"} -> ${input.currentBaseline ?? "none"}); affected paths: ${pathSummary}.`,
      false,
    );
  }
  if (input.planIssues?.length) add("invalid_plan", `Plan has ${input.planIssues.length} traceability or dependency issue(s).`);
  for (const violation of input.pathViolations ?? []) {
    add(violation.code === "protected_path" ? "protected_path" : "out_of_scope_path", violation.message);
  }
  const approved = new Set(input.approvedTaskIds ?? []);
  for (const taskId of input.observedTaskIds ?? []) if (!approved.has(taskId)) add("unapproved_task", `Unapproved task observed: ${taskId}.`);
  if ((input.repeatedIdenticalFailures ?? 0) >= 2) add("repeated_identical_failure", "The same failure repeated without new evidence.");
  if (input.ambiguousCompletion) add("ambiguous_completion", "Executor completion is ambiguous.");
  if (input.settledImplementationTask && (input.contentChanges?.length ?? 0) === 0) add("no_content_progress", "Settled implementation task produced no content-level progress.");
  return flags;
}

/** Create a validated cursor pinned to a protocol/adapter identity. */
export function createGenericSupervisionCursor(
  identity: GenericSupervisionProtocolIdentity,
  options: {
    stage?: GenericSupervisionCursor["stage"];
    nextTaskIndex?: number;
    completedTaskIds?: string[];
    currentTaskId?: string;
    lastCheckpointId?: string;
  } = {},
): GenericSupervisionCursor {
  assertGenericProtocolIdentity(identity);
  const nextTaskIndex = options.nextTaskIndex ?? 0;
  if (!Number.isSafeInteger(nextTaskIndex) || nextTaskIndex < 0) throw new Error("Generic supervision nextTaskIndex must be a non-negative safe integer.");
  const stage = options.stage ?? "plan";
  if (!new Set(["plan", "executor-task", "verifier", "terminal"]).has(stage)) throw new Error("Invalid generic supervision stage.");
  for (const [label, value] of [["currentTaskId", options.currentTaskId], ["lastCheckpointId", options.lastCheckpointId]] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`Generic supervision ${label} must be non-empty when present.`);
  }
  const completedTaskIds = [...(options.completedTaskIds ?? [])];
  if (completedTaskIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(completedTaskIds).size !== completedTaskIds.length) {
    throw new Error("Generic supervision completedTaskIds must be unique non-empty strings.");
  }
  return {
    schemaVersion: 1,
    identity: structuredClone(identity),
    stage,
    nextTaskIndex,
    completedTaskIds,
    ...(options.currentTaskId ? { currentTaskId: options.currentTaskId } : {}),
    ...(options.lastCheckpointId ? { lastCheckpointId: options.lastCheckpointId } : {}),
  };
}

/** Build the common durable runtime used by any shape adapter. */
export function createGenericSupervisionRuntime(input: Omit<GenericSupervisionRuntime, "kind">): GenericSupervisionRuntime {
  assertGenericProtocolIdentity(input.identity);
  validateGenericCursor(input.cursor, input.identity);
  return structuredClone({ ...input, kind: "generic-shape" });
}

function legacyCriterionTask(value: unknown): value is CriterionTask {
  if (!isRuntimeRecord(value)) return false;
  return typeof value.id === "string" && value.id.trim().length > 0
    && typeof value.description === "string" && value.description.trim().length > 0
    && Array.isArray(value.dependsOn) && value.dependsOn.every((item) => typeof item === "string" && item.trim().length > 0)
    && Array.isArray(value.criteria) && value.criteria.every((item) => typeof item === "string" && item.trim().length > 0)
    && (value.predictedWriteSet === undefined || (Array.isArray(value.predictedWriteSet) && value.predictedWriteSet.every((item) => typeof item === "string")));
}

function legacyContentBaseline(value: unknown): value is ContentSignatureSnapshot {
  return isRuntimeRecord(value)
    && typeof value.root === "string"
    && isRuntimeRecord(value.files)
    && isRuntimeRecord(value.limits)
    && Number.isSafeInteger(value.fileCount)
    && Number.isFinite(value.totalBytes)
    && typeof value.truncated === "boolean"
    && Array.isArray(value.omitted);
}

function checkpointPayloadOutput(value: unknown): unknown | undefined {
  return isRuntimeRecord(value) && Object.prototype.hasOwnProperty.call(value, "output") ? value.output : undefined;
}

function runtimeOutputTaskId(value: unknown): string | undefined {
  return isRuntimeRecord(value) && typeof value.taskId === "string" && value.taskId.trim() ? value.taskId : undefined;
}

function routeParamKey(role: string, suffix: "Agent" | "Provider" | "Model"): string {
  return `${role}${suffix}`;
}

/**
 * Pure schema-v1 PEV adapter. It never writes and never mutates its input.
 * Ambiguous completion is deliberately converted to verifier-only mode: a
 * historical executor is never replayed merely because an old cursor was not
 * available, while the frozen outputs remain available to bounded verification.
 */
export function migrateLegacyPevSupervisionState(
  source: SupervisionRunState,
  options: {
    now?: Date;
    hostInstanceId?: string;
    readCheckpointPayload?: (checkpoint: SupervisionCheckpoint) => unknown | undefined;
    restartRequired?: boolean;
  } = {},
): LegacyPevMigrationResult {
  if (source.runtime?.kind === "generic-shape") return { state: structuredClone(source), migrated: false };
  if (source.schemaVersion !== 1 || !verifyFrozenMission(source.mission)) {
    throw new Error(`LEGACY_SUPERVISION_COMPATIBILITY_REFUSED: ${source.runId} has invalid frozen mission authority.`);
  }
  if (source.mode !== "visible-main") {
    throw new Error(`LEGACY_SUPERVISION_COMPATIBILITY_REFUSED: ${source.runId} was not a visible-main supervised run.`);
  }
  if (source.mission.paradigm !== "plan-execute-verify") {
    throw new Error(`LEGACY_SUPERVISION_COMPATIBILITY_REFUSED: ${source.runId} is not a schema-v1 PEV run.`);
  }

  const state = structuredClone(source);
  const legacy = state.runtime as LegacyPevSupervisionRuntime | undefined;
  const reasons: string[] = [];
  const addReason = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!legacy || !isRuntimeRecord(legacy)) {
    throw new Error(`LEGACY_PEV_COMPATIBILITY_BLOCKED: ${source.runId} has no durable PEV runtime to verify.`);
  }
  if (state.lane !== state.mission.lane) addReason("state lane does not match the frozen mission lane");

  const runtimePlan = isRuntimeRecord(legacy.plan) && Array.isArray(legacy.plan.tasks) && legacy.plan.tasks.every(legacyCriterionTask)
    ? legacy.plan as LegacyPevSupervisionRuntime["plan"]
    : undefined;
  const stateTasksValid = Array.isArray(state.tasks) && state.tasks.every(legacyCriterionTask);
  const tasks = structuredClone(runtimePlan?.tasks ?? (stateTasksValid ? state.tasks : []));
  if (!runtimePlan) addReason("durable runtime plan is missing or malformed");
  if (!stateTasksValid) addReason("supervision task list is malformed");
  if (runtimePlan && stateTasksValid && canonicalJson(runtimePlan.tasks) !== canonicalJson(state.tasks)) {
    addReason("durable runtime plan differs from the approved supervision task list");
  }
  if (tasks.length === 0) addReason("no settled PEV plan can be reconstructed");
  const planIssues = validateCriterionTaskPlan(tasks, state.mission, {
    approvedTaskIds: Array.isArray(state.approvedTaskIds) ? state.approvedTaskIds : [],
    cwd: state.mission.cwd,
  });
  if (planIssues.length) addReason(`frozen plan has ${planIssues.length} traceability or dependency issue(s)`);
  if (state.currentTaskId) addReason("a historical executor task was active without a settled boundary");
  if (Array.isArray(state.audit.detachedWorkers) && state.audit.detachedWorkers.length) {
    addReason("historical detached executor ownership is ambiguous after upgrade");
  }

  const taskIds = tasks.map((task) => task.id);
  if (new Set(taskIds).size !== taskIds.length) addReason("plan task ids are not unique");
  const approved = new Set(Array.isArray(state.approvedTaskIds) ? state.approvedTaskIds : []);
  if (taskIds.some((id) => !approved.has(id))) addReason("plan contains a task outside the frozen approval set");

  const sourceCheckpointIds: string[] = [];
  const executorCheckpointIds: string[] = [];
  const verifierCheckpointIds: string[] = [];
  const settledCheckpointTaskIds: string[] = [];
  const payloadOutputs = new Map<string, unknown>();
  const verifierBatchById = new Map<string, GenericVerifierBatchEvidence>();
  const retainVerifierBatch = (value: unknown) => {
    if (!isRuntimeRecord(value) || typeof value.batchId !== "string" || !value.batchId.trim()) {
      addReason("legacy verifier batch evidence is malformed");
      return;
    }
    if (!verifierBatchById.has(value.batchId)) verifierBatchById.set(value.batchId, structuredClone(value) as unknown as GenericVerifierBatchEvidence);
  };
  const legacyVerifierBatches = (legacy as unknown as Record<string, unknown>).verifierBatches;
  if (legacyVerifierBatches !== undefined) {
    if (Array.isArray(legacyVerifierBatches)) legacyVerifierBatches.forEach(retainVerifierBatch);
    else addReason("legacy verifier batch collection is malformed");
  }
  let planEffectsBaseline: ContentSignatureSnapshot | undefined;
  for (let index = 0; index < state.checkpoints.length; index += 1) {
    const checkpoint = state.checkpoints[index];
    sourceCheckpointIds.push(checkpoint.id);
    if (
      checkpoint.sequence !== index + 1 || checkpoint.id !== `checkpoint-${String(index + 1).padStart(4, "0")}` ||
      checkpoint.missionHash !== state.mission.missionHash
    ) addReason("checkpoint sequence or mission binding is inconsistent");
    let payload: unknown;
    try { payload = options.readCheckpointPayload?.(checkpoint); } catch { addReason(`checkpoint payload ${checkpoint.id} could not be read`); }
    if (checkpoint.kind === "plan" && isRuntimeRecord(payload) && legacyContentBaseline(payload.effectsBaseline)) {
      planEffectsBaseline = structuredClone(payload.effectsBaseline);
    }
    if (checkpoint.kind === "executor" && checkpoint.outcome === "settled" && checkpoint.taskId) {
      executorCheckpointIds.push(checkpoint.id);
      settledCheckpointTaskIds.push(checkpoint.taskId);
      const output = checkpointPayloadOutput(payload);
      if (output !== undefined) payloadOutputs.set(checkpoint.taskId, structuredClone(output));
    }
    if (checkpoint.kind === "verifier") {
      verifierCheckpointIds.push(checkpoint.id);
      if (isRuntimeRecord(payload) && payload.verificationBatch !== undefined) retainVerifierBatch(payload.verificationBatch);
    }
  }
  if (state.checkpointSequence !== state.checkpoints.length) addReason("checkpointSequence does not match the durable checkpoint list");

  const declaredCompleted = Array.isArray(legacy.completedTaskIds) && legacy.completedTaskIds.every((id) => typeof id === "string")
    ? [...legacy.completedTaskIds]
    : [];
  if (declaredCompleted.length !== new Set(declaredCompleted).size) addReason("completed task ids are duplicated");
  const settledSet = new Set(settledCheckpointTaskIds);
  const safeCompleted: string[] = [];
  for (const task of tasks) {
    if (settledSet.has(task.id)) safeCompleted.push(task.id);
    else break;
  }
  if (settledCheckpointTaskIds.some((id) => !taskIds.includes(id))) addReason("executor checkpoint references an unknown task");
  if (canonicalJson(declaredCompleted) !== canonicalJson(safeCompleted)) {
    addReason("completed task prefix disagrees with settled executor checkpoints");
  }
  if (settledCheckpointTaskIds.some((id, index) => id !== safeCompleted[index])) {
    addReason("settled executor checkpoints are not a dependency-safe task prefix");
  }

  const outputByTask = new Map<string, unknown>();
  for (const output of Array.isArray(legacy.executorOutputs) ? legacy.executorOutputs : []) {
    const taskId = runtimeOutputTaskId(output);
    if (!taskId || outputByTask.has(taskId)) addReason("executor outputs have missing or duplicate task bindings");
    else outputByTask.set(taskId, structuredClone(output));
  }
  for (const [taskId, output] of payloadOutputs) if (!outputByTask.has(taskId)) outputByTask.set(taskId, output);
  if (safeCompleted.some((taskId) => !outputByTask.has(taskId))) addReason("a settled task has no durable executor output");
  const executorOutputs = tasks.flatMap((task) => outputByTask.has(task.id) ? [outputByTask.get(task.id)] : []);

  const contentBaseline = legacyContentBaseline(legacy.contentBaseline)
    ? structuredClone(legacy.contentBaseline)
    : planEffectsBaseline;
  if (!contentBaseline) {
    throw new Error(`LEGACY_PEV_COMPATIBILITY_BLOCKED: ${source.runId} has no trustworthy effects baseline for final verification.`);
  }
  if (canonicalDirectoryIdentity(contentBaseline.root) !== canonicalDirectoryIdentity(state.mission.cwd)) {
    throw new Error(`LEGACY_PEV_COMPATIBILITY_BLOCKED: ${source.runId} effects baseline is not bound to the frozen mission cwd.`);
  }

  const params = isRuntimeRecord(legacy.params) ? structuredClone(legacy.params) : {};
  if (!isRuntimeRecord(legacy.params)) addReason("runtime parameters are missing or malformed");
  if (typeof params.cwd === "string" && canonicalDirectoryIdentity(params.cwd) !== canonicalDirectoryIdentity(state.mission.cwd)) {
    addReason("runtime cwd differs from the frozen mission cwd");
  }
  if (params.paradigm !== undefined && params.paradigm !== state.mission.paradigm) addReason("runtime paradigm differs from the frozen mission");
  for (const route of state.mission.routes) {
    for (const [suffix, expected] of [["Agent", route.agentName], ["Provider", route.provider], ["Model", route.model]] as const) {
      const key = routeParamKey(route.role, suffix);
      if (params[key] !== undefined && params[key] !== expected) addReason(`runtime ${key} differs from the frozen mission route`);
      params[key] ??= expected;
    }
  }
  params.task ??= state.mission.originalTask;
  params.cwd ??= state.mission.cwd;
  params.paradigm ??= state.mission.paradigm;
  params.supervision = "visible-main";
  params.action = "run";

  const repairIds = tasks.map((task) => /^repair-(\d+)$/.exec(task.id)?.[1]).filter((value): value is string => value !== undefined);
  const inferredRepairCount = repairIds.length ? Math.max(...repairIds.map(Number)) : 0;
  const repairCount = Number.isSafeInteger(legacy.repairCount) && legacy.repairCount >= inferredRepairCount
    ? legacy.repairCount
    : inferredRepairCount;
  if (repairCount !== legacy.repairCount) addReason("repair count was reconstructed from durable repair tasks");

  const exactContinuation = reasons.length === 0;
  const identity: GenericSupervisionProtocolIdentity = {
    protocolId: HOST_TASK_BOUNDARY_PROTOCOL_ID,
    adapterId: PEV_SHAPE_ADAPTER_ID,
    adapterVersion: 1,
  };
  const nextTaskIndex = exactContinuation ? safeCompleted.length : tasks.length;
  const stage: GenericSupervisionCursor["stage"] = state.status === "terminal"
    ? "terminal"
    : exactContinuation && nextTaskIndex < tasks.length
      ? "executor-task"
      : "verifier";
  const metadata: LegacyPevMigrationMetadata = {
    adapterId: "legacy-pev-generic-migration-v1",
    sourceSchemaVersion: 1,
    sourceRuntimeKind: legacy.kind === "legacy-pev" ? "legacy-pev" : "missing",
    mode: exactContinuation ? "exact-continuation" : "verification-only",
    executorRespawnAllowed: exactContinuation,
    reasons,
    sourceCheckpointIds,
    executorCheckpointIds,
    verifierCheckpointIds,
    ...(sourceCheckpointIds.length ? { lastSourceCheckpointId: sourceCheckpointIds[sourceCheckpointIds.length - 1] } : {}),
  };
  state.tasks = tasks;
  state.runtime = createGenericSupervisionRuntime({
    identity,
    cursor: createGenericSupervisionCursor(identity, {
      stage,
      nextTaskIndex,
      completedTaskIds: safeCompleted,
      lastCheckpointId: metadata.lastSourceCheckpointId,
    }),
    params,
    intake: structuredClone(legacy.intake),
    plan: {
      tasks,
      notes: runtimePlan?.notes ?? "Legacy PEV compatibility verification plan.",
      ...(runtimePlan?.predictedWriteSet ? { predictedWriteSet: [...runtimePlan.predictedWriteSet] } : {}),
    },
    completedTaskIds: safeCompleted,
    executorOutputs,
    contentBaseline,
    repairCount,
    ...(verifierBatchById.size ? { verifierBatches: [...verifierBatchById.values()] } : {}),
    ...(options.hostInstanceId ? { hostInstanceId: options.hostInstanceId } : legacy.hostInstanceId ? { hostInstanceId: legacy.hostInstanceId } : {}),
    adapterState: {
      classification: "executor-bearing",
      ...(
        isRuntimeRecord((legacy as unknown as Record<string, unknown>).adapterState)
          ? { legacyAdapterState: structuredClone((legacy as unknown as Record<string, unknown>).adapterState) }
          : {}
      ),
      legacyPevMigration: metadata,
    },
  });

  if (options.restartRequired !== false && state.status !== "terminal" && state.status !== "cancelled") {
    return { state: restartToPaused(state, options.now), migrated: true, metadata };
  }
  return { state, migrated: true, metadata };
}

function assertGenericProtocolIdentity(identity: GenericSupervisionProtocolIdentity): void {
  if (
    !identity || identity.protocolId !== HOST_TASK_BOUNDARY_PROTOCOL_ID ||
    identity.adapterVersion !== 1 || !isValidAdapterId(identity.adapterId)
  ) {
    throw new Error("Invalid host task-boundary protocol/adapter identity.");
  }
}

function validateGenericCursor(cursor: GenericSupervisionCursor, identity: GenericSupervisionProtocolIdentity): void {
  if (
    !cursor || cursor.schemaVersion !== 1 ||
    !new Set(["plan", "executor-task", "verifier", "terminal"]).has(cursor.stage) ||
    !Number.isSafeInteger(cursor.nextTaskIndex) || cursor.nextTaskIndex < 0 ||
    !Array.isArray(cursor.completedTaskIds) ||
    cursor.completedTaskIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(cursor.completedTaskIds).size !== cursor.completedTaskIds.length
  ) {
    throw new Error("Invalid generic supervision cursor.");
  }
  assertGenericProtocolIdentity(cursor.identity);
  if (canonicalJson(cursor.identity) !== canonicalJson(identity)) throw new Error("Generic supervision cursor adapter identity mismatch.");
}

export function createInitialSupervisionState(input: {
  runId: string;
  mission: FrozenMission;
  tasks: CriterionTask[];
  mode?: SupervisionMode;
  now?: Date;
}): SupervisionRunState {
  assertNonEmptyString(input.runId, "runId");
  if (!verifyFrozenMission(input.mission)) throw new Error("Cannot create supervision state from an invalid mission hash.");
  const now = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    runId: input.runId,
    mode: input.mode ?? "visible-main",
    lane: input.mission.lane,
    status: "plan_checkpoint",
    mission: structuredClone(input.mission),
    createdAt: now,
    updatedAt: now,
    checkpointSequence: 0,
    checkpoints: [],
    tasks: structuredClone(input.tasks),
    approvedTaskIds: input.tasks.map((task) => task.id),
    completedCriteria: [],
    audit: {
      tests: [],
      retries: 0,
      infrastructureFailures: [],
      forbiddenChanges: [],
      noProgress: false,
      activeWorkers: [],
      detachedWorkers: [],
      scopeAmendments: [],
    },
  };
}

const MAX_SUPERVISOR_ACCEPTANCE_REASON_CHARS = 2_000;

export function normalizeSupervisorAcceptanceReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Supervisor acceptance reason must be a non-empty string.");
  }
  const reason = value.trim();
  if (reason.length > MAX_SUPERVISOR_ACCEPTANCE_REASON_CHARS) {
    throw new Error(`Supervisor acceptance reason must not exceed ${MAX_SUPERVISOR_ACCEPTANCE_REASON_CHARS} characters.`);
  }
  if (reason.includes("\0")) throw new Error("Supervisor acceptance reason must not contain NUL characters.");
  return reason;
}

/** Acceptance is available only at a settled verifier boundary. */
export function supervisorAcceptanceIneligibility(state: SupervisionRunState): string | undefined {
  if (state.status !== "awaiting_supervisor") return `status ${state.status} is not an awaiting supervisor boundary`;
  if (state.currentTaskId) return `task ${state.currentTaskId} is not settled`;
  if (state.audit.activeWorkers.length) return "an active worker has not settled";
  if (state.audit.detachedWorkers.length) return "a detached worker has not settled";
  const checkpoint = state.checkpoints[state.checkpoints.length - 1];
  if (!checkpoint || checkpoint.kind !== "verifier") return "the latest checkpoint is not a settled verifier result";
  if (!state.currentApproval) return "no checkpoint approval is outstanding";
  if (
    state.currentApproval.runId !== state.runId ||
    state.currentApproval.missionHash !== state.mission.missionHash ||
    state.currentApproval.checkpointId !== checkpoint.id ||
    state.currentApproval.action !== "continue"
  ) return "the outstanding checkpoint approval has a stale or wrong binding";
  if (state.currentApproval.consumedAt || state.currentApproval.invalidatedAt) return "the checkpoint approval is stale or already consumed";
  return undefined;
}

function allowedNextActions(state: SupervisionRunState): SupervisionAction[] {
  switch (state.status) {
    case "plan_checkpoint": return ["inspect", "continue", "pause", "cancel"];
    case "awaiting_supervisor": return supervisorAcceptanceIneligibility(state)
      ? ["inspect", "continue", "pause", "cancel"]
      : ["inspect", "continue", "accept", "pause", "cancel"];
    case "paused": return ["inspect", "continue", "cancel"];
    case "blocked_infrastructure":
    case "executing":
    case "verifying": return ["inspect", "pause", "cancel"];
    case "cancelled":
    case "terminal": return ["inspect"];
  }
}

/** Automatic approval is a fixed host decision, never a worker verdict or an inferred grant. */
export function checkAutomaticPlanApproval(state: SupervisionRunState, options: { allowedWriteSet?: string[] }): { approved: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!verifyFrozenMission(state.mission)) reasons.push("frozen mission invalid");
  if (!state.tasks.length) reasons.push("plan genuinely missing: no tasks");
  if (!options.allowedWriteSet?.length) reasons.push("approved scope missing");
  const checkpoint = state.checkpoints.at(-1);
  if (checkpoint?.kind !== "plan" || checkpoint.outcome !== "plan_ready") reasons.push("intact plan checkpoint missing");
  const planPath = checkpoint && path.join(runDirFor(state.runId), `${checkpoint.id}-plan.json`);
  if (!planPath || !fs.existsSync(planPath)) reasons.push("saved plan genuinely missing");
  else {
    try {
      const envelope = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const savedTasks = envelope.payload?.plan?.tasks ?? envelope.payload?.fullPlan;
      if (!Array.isArray(savedTasks) || !savedTasks.length || savedTasks.length !== state.tasks.length
        || savedTasks.some((task: any, index: number) => task?.id !== state.tasks[index]?.id || task?.description !== state.tasks[index]?.description)) reasons.push("saved plan missing or inconsistent with checkpoint tasks");
    } catch { reasons.push("saved plan unreadable: automatic approval refused"); }
  }
  const knownCriteria = new Set(state.mission.acceptanceCriteria.map(item => item.id));
  for (const task of state.tasks) {
    if (!task.description?.trim() || !task.criteria.length || task.criteria.some(id => !knownCriteria.has(id))) reasons.push(`${task.id}: tasks and acceptance criteria required`);
    if (!task.predictedWriteSet?.length && task.expectsFileChange !== false) reasons.push(`${task.id}: predicted scope missing`);
    for (const candidate of task.predictedWriteSet ?? []) {
      // Broad patterns cannot prove that protected code is excluded. Human approval remains available.
      if (/[*?\[\]]|[\\/]$/.test(candidate)) reasons.push(`${candidate}: scope cannot be proven for a wildcard or directory`);
      if (/(?:native|audio|device|alloc|(?:^|[\\/])stop(?:[.\\/]|$)|a[-_/]?b[-_/]?swap|profiles|saved[-_]?state|package[-_]?stores)/i.test(candidate)) reasons.push(`${candidate}: protected code or owner data`);
    }
    const violations = checkLanePaths({ lane: "product", cwd: state.mission.cwd, worktree: state.mission.worktree,
      paths: task.predictedWriteSet ?? [], allowedWriteSet: options.allowedWriteSet });
    reasons.push(...violations.map(item => item.message));
  }
  reasons.push(...validateCriterionTaskPlan(state.tasks, state.mission, {allowedWriteSet: options.allowedWriteSet, cwd: state.mission.cwd, approvedTaskIds: state.approvedTaskIds}).map(item => item.message));
  return { approved: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Build a detached inspection and refresh observed liveness, without changing durable execution state. */
export function buildInspectionSnapshot(
  state: SupervisionRunState,
  options: LiveStatusOptions & { drift?: DriftFlag[]; contentChanges?: ContentSignatureChange[] } = {},
): InspectionSnapshot {
  const currentTask = state.tasks.find((task) => task.id === state.currentTaskId);
  const required = state.mission.acceptanceCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id);
  const completed = new Set(state.completedCriteria);
  const lastCheckpoint = state.checkpoints[state.checkpoints.length - 1];
  const runDir = options.runDir ?? runDirFor(state.runId);
  const liveStatus = refreshLiveStatus(runDir, options, state);
  const artifact = (checkpoint?: SupervisionCheckpoint): string | undefined => checkpoint ? path.join(runDir, `${checkpoint.id}-${checkpoint.kind}.json`) : undefined;
  const planCheckpoint = state.checkpoints.find(item => item.kind === "plan");
  const resultCheckpoint = [...state.checkpoints].reverse().find(item => item.kind === "executor" || item.kind === "verifier");
  let declaredScope: string[] | undefined;
  if (planCheckpoint) {
    try {
      const payload = JSON.parse(fs.readFileSync(artifact(planCheckpoint)!, "utf8")).payload;
      const declared = payload?.declaredPlan?.predictedWriteSet ?? payload?.plan?.predictedWriteSet;
      if (Array.isArray(declared)) declaredScope = declared.filter((item: unknown): item is string => typeof item === "string");
    } catch { /* The saved reference remains visible; absence never grants approval. */ }
  }
  let settledResult: InspectionSnapshot["settledResult"];
  if (resultCheckpoint) {
    try {
      const envelope = JSON.parse(fs.readFileSync(artifact(resultCheckpoint)!, "utf8"));
      const payload = envelope.payload;
      const text = String(payload?.output?.output ?? payload?.output?.text ?? payload?.verifier?.text ?? payload?.verifierResult?.summary ?? payload?.report ?? resultCheckpoint.outcome ?? "");
      settledResult = {outcome: resultCheckpoint.outcome, text: text.slice(0, 1200), omitted: text.length > 1200,
        ...(Array.isArray(payload?.findings) ? { findings: payload.findings.slice(0, 12) } : {})};
    } catch { settledResult = {outcome: resultCheckpoint.outcome, text: "Saved result unavailable; inspect the referenced file.", omitted: true}; }
  }
  const awaitingApproval = allowedNextActions(state).includes("continue");
  return structuredClone({
    planSummary: { tasks: state.tasks.slice(0, 24).map(task => ({...task, description: task.description.slice(0, 600), acceptanceCriteria: state.mission.acceptanceCriteria.filter(item => task.criteria.includes(item.id))})), omittedTasks: Math.max(0, state.tasks.length - 24), declaredScope },
    savedArtifacts: {state: path.join(runDir, "supervision.json"), plan: artifact(planCheckpoint), result: artifact(resultCheckpoint), checkpoint: artifact(lastCheckpoint)},
    checkpointState: { kind: lastCheckpoint?.kind, awaitingApproval, approvalOutstanding: Boolean(state.currentApproval && !state.currentApproval.consumedAt && !state.currentApproval.invalidatedAt), freshApprovalAvailable: awaitingApproval && Boolean(lastCheckpoint) },
    settledResult,
    automaticPlanApprovals: state.automaticPlanApprovals ?? [],
    runId: state.runId,
    status: state.status,
    missionHash: state.mission.missionHash,
    cwd: state.mission.cwd,
    branch: state.mission.worktree.branch,
    baseline: state.mission.worktree.baseline,
    ...(state.currentTaskId ? { currentTaskId: state.currentTaskId } : {}),
    ...(state.lastTaskId ? { lastTaskId: state.lastTaskId } : {}),
    currentTaskCriteria: currentTask?.criteria ?? [],
    completedCriteria: [...completed].sort(),
    remainingCriteria: required.filter((criterionId) => !completed.has(criterionId)),
    contentChanges: options.contentChanges ?? [...state.checkpoints].reverse().find(item => item.effectChanges.length)?.effectChanges ?? [],
    tests: state.audit.tests,
    retries: state.audit.retries,
    infrastructureFailures: state.audit.infrastructureFailures,
    forbiddenChanges: state.audit.forbiddenChanges,
    elapsedMs: Math.max(0, (options.now ?? new Date()).getTime() - new Date(state.createdAt).getTime()),
    noProgress: state.audit.noProgress,
    activeWorkers: liveStatus.activeWorkers,
    detachedWorkers: state.audit.detachedWorkers,
    scopeAmendments: state.audit.scopeAmendments ?? [],
    verifierBatches: state.runtime?.kind === "generic-shape" ? state.runtime.verifierBatches ?? [] : [],
    ...(state.retirement ? { retirement: state.retirement } : {}),
    drift: options.drift ?? [],
    allowedNextActions: allowedNextActions(state),
    liveStatus,
  });
}

const MAX_VERIFICATION_FINDINGS = 100;
const MAX_EVIDENCE_PER_CRITERION = 20;
const MAX_CRITERION_ID_CHARS = 256;
const MAX_EVIDENCE_OBSERVED_CHARS = 16_384;
const SUPPORTED_EVIDENCE_KINDS = new Set(["command", "test", "file", "hash"]);
const SHA256_VALUE = /^[a-fA-F0-9]{64}$/;
const SHA256_BINDING = /(?:^|[\s;,])sha-?256\s*[:=]\s*[a-fA-F0-9]{64}(?=$|[\s;,])/i;

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedNonEmptyText(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars && value.trim().length > 0;
}

function isSha256Evidence(value: string): boolean {
  const trimmed = value.trim();
  return SHA256_VALUE.test(trimmed) || SHA256_BINDING.test(trimmed);
}

const BLOCKING_FINAL_VERIFICATION_CODES = new Set(["criterion_verification_failed"]);

function classifyFinalVerificationIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.map((issue) => BLOCKING_FINAL_VERIFICATION_CODES.has(issue.code)
    ? issue
    : { ...issue, advisory: true as const });
}

export function hasBlockingVerificationIssues(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.advisory !== true);
}

/**
 * Final verification treats parsed verifier JSON as untrusted runtime input.
 * The reviewer's semantic criterion FAIL remains blocking. Host observations
 * about schema, evidence vocabulary, counts, hashes, and command exit status
 * are advisory and cannot rewrite a semantic PASS.
 */
export function validateFinalVerification(
  mission: FrozenMission,
  findings: unknown,
  limits: { maxFindings?: number; maxEvidencePerCriterion?: number } = {},
): ValidationIssue[] {
  const requestedMaxFindings = limits?.maxFindings ?? MAX_VERIFICATION_FINDINGS;
  const requestedMaxEvidence = limits?.maxEvidencePerCriterion ?? MAX_EVIDENCE_PER_CRITERION;
  const validLimits = Number.isSafeInteger(requestedMaxFindings) && requestedMaxFindings >= 1
    && requestedMaxFindings <= MAX_VERIFICATION_FINDINGS
    && Number.isSafeInteger(requestedMaxEvidence) && requestedMaxEvidence >= 1
    && requestedMaxEvidence <= MAX_EVIDENCE_PER_CRITERION;
  if (!validLimits) {
    return classifyFinalVerificationIssues([{ code: "invalid_verification_bounds", message: "Verification bounds are invalid." }]);
  }
  const maxFindings = requestedMaxFindings as number;
  const maxEvidence = requestedMaxEvidence as number;
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(findings)) {
    return classifyFinalVerificationIssues([{ code: "invalid_verification_findings", message: "Verification findings must be an array." }]);
  }
  if (findings.length > maxFindings) {
    issues.push({ code: "verification_finding_limit", message: `Verification exceeds ${maxFindings} findings.` });
  }

  const known = new Set(mission.acceptanceCriteria.map((criterion) => criterion.id));
  const required = new Set(mission.acceptanceCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id));
  const seen = new Set<string>();
  for (const findingValue of findings.slice(0, maxFindings)) {
    if (!isRuntimeRecord(findingValue)) {
      issues.push({ code: "invalid_verification_finding", message: "Verification finding must be an object." });
      continue;
    }

    const criterionIdValue = findingValue.criterionId;
    const validCriterionId = isBoundedNonEmptyText(criterionIdValue, MAX_CRITERION_ID_CHARS);
    const criterionId = validCriterionId ? criterionIdValue : undefined;
    if (!criterionId) {
      issues.push({ code: "invalid_verification_criterion", message: "Verification criterionId must be bounded nonempty text." });
    } else {
      if (seen.has(criterionId)) {
        issues.push({ code: "duplicate_verification_finding", message: `Duplicate verification finding for ${criterionId}.`, criterionId });
      }
      seen.add(criterionId);
      if (!known.has(criterionId)) {
        issues.push({ code: "orphan_verification_finding", message: `Unknown verification criterion ${criterionId}.`, criterionId });
      }
    }

    const status = findingValue.status;
    const validStatus = status === "pass" || status === "fail";
    if (!validStatus) {
      issues.push({ code: "invalid_verification_status", message: "Verification status must be exactly pass or fail.", ...(criterionId ? { criterionId } : {}) });
    } else if (status === "fail") {
      issues.push({ code: "criterion_verification_failed", message: `${criterionId ?? "Criterion"} failed verification.`, ...(criterionId ? { criterionId } : {}) });
    }

    const evidenceValues = findingValue.evidence;
    if (!Array.isArray(evidenceValues)) {
      issues.push({
        code: "invalid_verification_evidence",
        message: "Verification evidence was not an array; reviewer PASS is retained for supervisor judgment.",
        ...(criterionId ? { criterionId } : {}),
        ...(status === "pass" ? { advisory: true as const } : {}),
      });
      if (status === "pass" && criterionId && required.has(criterionId)) {
        issues.push({ code: "missing_machine_evidence", message: `${criterionId} has no valid machine evidence; reviewer PASS is retained for supervisor judgment.`, criterionId, advisory: true });
      }
      continue;
    }
    if (evidenceValues.length > maxEvidence) {
      issues.push({ code: "verification_evidence_limit", message: `${criterionId ?? "Criterion"} exceeds ${maxEvidence} evidence entries.`, ...(criterionId ? { criterionId } : {}) });
    }

    let validMachineEvidence = 0;
    for (const evidenceValue of evidenceValues.slice(0, maxEvidence)) {
      if (!isRuntimeRecord(evidenceValue)) {
        issues.push({ code: "invalid_machine_evidence", message: "Machine evidence entry must be an object.", ...(criterionId ? { criterionId } : {}) });
        continue;
      }

      let entryValid = true;
      const kind = evidenceValue.kind;
      if (typeof kind !== "string" || !SUPPORTED_EVIDENCE_KINDS.has(kind)) {
        issues.push({
          code: "unsupported_evidence_kind",
          message: `Evidence kind ${typeof kind === "string" && kind.trim() ? JSON.stringify(kind) : "(missing)"} was normalized to a semantic note.`,
          ...(criterionId ? { criterionId } : {}),
          advisory: true,
        });
        // Unknown vocabularies remain useful semantic evidence when they carry
        // bounded observed text; vocabulary alone never flips verifier PASS.
      }
      const observed = evidenceValue.observed;
      if (!isBoundedNonEmptyText(observed, MAX_EVIDENCE_OBSERVED_CHARS)) {
        issues.push({ code: "invalid_machine_evidence", message: "Machine evidence observed text must be bounded and nonempty.", ...(criterionId ? { criterionId } : {}) });
        entryValid = false;
      }
      if (kind === "command" || kind === "test") {
        const exitCode = evidenceValue.exitCode;
        const hasExpectedExitCode = Object.prototype.hasOwnProperty.call(evidenceValue, "expectedExitCode");
        const expectedExitCode = evidenceValue.expectedExitCode;
        if (!Number.isInteger(exitCode)) {
          issues.push({ code: "invalid_machine_evidence", message: `${kind} evidence requires an integer exit code.`, ...(criterionId ? { criterionId } : {}) });
          entryValid = false;
        } else if (hasExpectedExitCode && !Number.isInteger(expectedExitCode)) {
          issues.push({ code: "invalid_expected_exit_code", message: `${kind} evidence expectedExitCode must be an integer when supplied.`, ...(criterionId ? { criterionId } : {}) });
        } else if (Number.isInteger(expectedExitCode) && exitCode !== expectedExitCode) {
          issues.push({ code: "unexpected_exit_evidence", message: `${kind} evidence exited ${exitCode}; expected ${expectedExitCode}.`, ...(criterionId ? { criterionId } : {}) });
        } else if (status === "pass" && !hasExpectedExitCode && exitCode !== 0) {
          issues.push({
            code: "nonzero_pass_evidence",
            message: `Passing ${kind} evidence recorded exit code ${exitCode} without an expectedExitCode; retained as an advisory observation.`,
            ...(criterionId ? { criterionId } : {}),
          });
        }
      }
      if (kind === "hash" && typeof observed === "string" && !isSha256Evidence(observed)) {
        issues.push({ code: "invalid_hash_evidence", message: "Hash evidence must contain a valid SHA-256 value or binding.", ...(criterionId ? { criterionId } : {}) });
        entryValid = false;
      }
      if (entryValid) validMachineEvidence += 1;
    }

    if (status === "pass" && criterionId && required.has(criterionId) && validMachineEvidence === 0) {
      issues.push({ code: "missing_machine_evidence", message: `${criterionId} has no valid machine evidence; reviewer PASS is retained for supervisor judgment.`, criterionId, advisory: true });
    }
  }
  for (const criterionId of required) {
    if (!seen.has(criterionId)) issues.push({ code: "missing_verification_finding", message: `Required ${criterionId} was not verified.`, criterionId });
  }
  return classifyFinalVerificationIssues(issues);
}

function validateLoadedSupervisionState(value: unknown, expectedRunId: string): SupervisionRunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervision state must be an object.");
  const state = value as SupervisionRunState;
  if (state.schemaVersion !== 1 || state.runId !== expectedRunId) throw new Error("Supervision state identity mismatch.");
  if (!Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, state.status) || !verifyFrozenMission(state.mission)) throw new Error("Supervision state is invalid or mission-bound data was changed.");
  if (!Array.isArray(state.checkpoints) || !Array.isArray(state.tasks) || !state.audit) throw new Error("Supervision state is missing required collections.");
  if (state.acceptance !== undefined) {
    if (
      state.acceptance.action !== "accept" ||
      typeof state.acceptance.reason !== "string" || !state.acceptance.reason.trim() ||
      typeof state.acceptance.acceptedAt !== "string" || !Number.isFinite(Date.parse(state.acceptance.acceptedAt)) ||
      typeof state.acceptance.acceptedCheckpointId !== "string" || !/^checkpoint-\d{4,}$/.test(state.acceptance.acceptedCheckpointId) ||
      typeof state.acceptance.hostInstanceId !== "string" || !state.acceptance.hostInstanceId.trim()
    ) throw new Error("Supervision acceptance metadata is invalid.");
    normalizeSupervisorAcceptanceReason(state.acceptance.reason);
    if (state.status !== "terminal" || state.terminalOutcome !== "accepted_with_reason") {
      throw new Error("Supervision acceptance metadata requires terminal accepted_with_reason state.");
    }
  }
  if (state.retirement !== undefined) {
    if (
      state.retirement.code !== "conclusively_orphaned_paused_run" ||
      typeof state.retirement.reason !== "string" || !state.retirement.reason.trim() ||
      typeof state.retirement.retiredAt !== "string" || !Number.isFinite(Date.parse(state.retirement.retiredAt)) ||
      !parseHostInstanceId(state.retirement.owningHostInstanceId)
    ) throw new Error("Paused-run retirement metadata is invalid.");
    if (state.status !== "terminal" || state.terminalOutcome !== "retired_dead_host" || state.acceptance !== undefined) {
      throw new Error("Paused-run retirement metadata requires terminal retired_dead_host state without acceptance.");
    }
  }
  if (state.runtime?.kind !== undefined && state.runtime.kind !== "legacy-pev" && state.runtime.kind !== "generic-shape") {
    throw new Error("Supervision state has an unknown durable runtime kind.");
  }
  if (state.runtime?.kind === "generic-shape") {
    assertGenericProtocolIdentity(state.runtime.identity);
    validateGenericCursor(state.runtime.cursor, state.runtime.identity);
  }
  return state;
}

/** Atomic durable store. Inspection refreshes only live-status.json, never the durable state. */
export class SupervisionStateStore {
  readonly runDir: string;
  readonly stateFile: string;

  constructor(readonly runId: string, rootDir?: string) {
    const validatedDefaultDir = runDirFor(runId); // validates traversal/reserved-name hostile input
    this.runDir = rootDir ? path.join(path.resolve(rootDir), runId) : validatedDefaultDir;
    this.stateFile = path.join(this.runDir, "supervision.json");
  }

  create(state: SupervisionRunState, options: LiveStatusOptions = {}): void {
    if (state.runId !== this.runId || fs.existsSync(this.stateFile)) throw new Error("Supervision state already exists or has the wrong run id.");
    validateLoadedSupervisionState(state, this.runId);
    atomicWriteJsonSync(this.stateFile, state);
    refreshLiveStatus(this.runDir, options, state);
  }

  save(state: SupervisionRunState, options: LiveStatusOptions = {}): void {
    if (state.runId !== this.runId || !verifyFrozenMission(state.mission)) throw new Error("Refusing to persist unbound supervision state.");
    validateLoadedSupervisionState(state, this.runId);
    if (fs.existsSync(this.stateFile)) {
      const persisted = this.readPersistedState();
      if (persisted.runtime?.kind === "generic-shape") {
        if (state.runtime?.kind !== "generic-shape" || canonicalJson(persisted.runtime.identity) !== canonicalJson(state.runtime.identity)) {
          throw new Error("Refusing to change the durable supervision protocol/adapter identity.");
        }
      }
    }
    atomicWriteJsonSync(this.stateFile, state);
    refreshLiveStatus(this.runDir, options, state);
  }

  /** Internal validation/retirement reads must not consume extra process probes
   * between the reconciler's two authoritative eligibility observations. */
  private readPersistedState(): SupervisionRunState {
    if (!fs.existsSync(this.stateFile)) throw new Error(`Supervision state not found for run ${this.runId}.`);
    return validateLoadedSupervisionState(JSON.parse(fs.readFileSync(this.stateFile, "utf8")), this.runId);
  }

  loadReadOnly(options: LiveStatusOptions = {}): SupervisionRunState {
    let state: SupervisionRunState;
    try {
      state = this.readPersistedState();
    } catch (error) {
      // A failed status read must not leave the last healthy badge untouched.
      // Preserve the original durable-state error after publishing uncertainty.
      if (fs.existsSync(this.runDir)) {
        try { refreshLiveStatus(this.runDir, { ...options, observationError: `supervision.json: ${error instanceof Error ? error.message : String(error)}` }); } catch {}
      }
      throw error;
    }
    refreshLiveStatus(this.runDir, options, state);
    return state;
  }

  /**
   * Return a detached generic projection of an old PEV state. The local
   * checkpoint filename is derived from validated state rather than trusting a
   * historical absolute payloadFile path, which also makes copied fixtures safe.
   */
  loadGenericCompatibleReadOnly(options: { now?: Date; hostInstanceId?: string; restartRequired?: boolean } = {}): LegacyPevMigrationResult {
    const state = this.loadReadOnly();
    return migrateLegacyPevSupervisionState(state, {
      ...options,
      readCheckpointPayload: (checkpoint) => {
        const payloadFile = path.join(this.runDir, `${checkpoint.id}-${checkpoint.kind}.json`);
        if (!fs.existsSync(payloadFile)) return undefined;
        const envelope = JSON.parse(fs.readFileSync(payloadFile, "utf8")) as unknown;
        if (!isRuntimeRecord(envelope) || !isRuntimeRecord(envelope.checkpoint)) {
          throw new Error(`Checkpoint payload ${checkpoint.id} is malformed.`);
        }
        if (
          envelope.checkpoint.id !== checkpoint.id || envelope.checkpoint.sequence !== checkpoint.sequence ||
          envelope.checkpoint.missionHash !== checkpoint.missionHash
        ) throw new Error(`Checkpoint payload ${checkpoint.id} has the wrong durable binding.`);
        return envelope.payload;
      },
    });
  }

  loadAfterRestart(now = new Date()): SupervisionRunState {
    const paused = restartToPaused(this.loadReadOnly(), now);
    if (paused.status !== "terminal" && paused.status !== "cancelled") this.save(paused);
    return paused;
  }

  /**
   * Retire an already-paused orphan without signalling any process. Eligibility
   * is checked once for discovery and again under an exclusive mutation fence;
   * the second process observation is the immediate pre-mutation authority.
   */
  retirePausedIfSafe(options: {
    observeProcess?: ProcessIdentityObserver;
    now?: () => Date;
  } = {}): { retired: true; state: SupervisionRunState } | { retired: false; assessment: Exclude<PausedRunRetirementAssessment, { eligible: true }> } {
    const observeProcess = options.observeProcess ?? observeProcessIdentity;
    const initial = assessPausedRunRetirement(this.readPersistedState(), this.runDir, observeProcess);
    if (!initial.eligible) return { retired: false, assessment: initial };

    const lockFile = `${this.stateFile}.retirement.lock`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      const latest = this.readPersistedState();
      const revalidated = assessPausedRunRetirement(latest, this.runDir, observeProcess);
      if (!revalidated.eligible) return { retired: false, assessment: revalidated };
      const retiredAt = (options.now?.() ?? new Date()).toISOString();
      const retirement: PausedRunRetirement = {
        code: "conclusively_orphaned_paused_run",
        reason: revalidated.reason,
        retiredAt,
        owningHostInstanceId: revalidated.owningHostInstanceId,
      };
      let next = structuredClone(latest);
      next.currentApproval = next.currentApproval
        ? { ...next.currentApproval, invalidatedAt: next.currentApproval.invalidatedAt ?? retiredAt }
        : undefined;
      next.currentTaskId = undefined;
      next.retirement = retirement;
      if (next.runtime?.kind === "generic-shape") {
        next.runtime.cursor.stage = "terminal";
        next.runtime.cursor.currentTaskId = undefined;
      }
      next = transitionSupervisionState(next, "terminal", new Date(retiredAt));
      next.terminalOutcome = "retired_dead_host";
      next = this.appendCheckpoint(next, {
        kind: "retirement",
        createdAt: retiredAt,
        missionHash: next.mission.missionHash,
        criteria: [],
        effectChanges: [],
        outcome: "retired_dead_host",
      }, {
        retirement,
        passedCriteriaAdded: [],
        forceKillAttempted: false,
      });
      return { retired: true, state: next };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { retired: false, assessment: rejection("run_state_inaccessible", "Paused-run retirement is already being evaluated by another host.") as Exclude<PausedRunRetirementAssessment, { eligible: true }> };
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }

  /**
   * Atomically consume checkpoint authority and persist an explicit terminal
   * acceptance. Historical verifier payloads remain byte-identical; the new
   * acceptance checkpoint references rather than replaces them.
   */
  acceptWithReason(token: string, reasonValue: unknown, hostInstanceId: string, now = new Date()): SupervisionRunState {
    const reason = normalizeSupervisorAcceptanceReason(reasonValue);
    assertNonEmptyString(hostInstanceId, "hostInstanceId");
    const lockFile = `${this.stateFile}.approval.lock`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      const latest = this.loadReadOnly();
      const ineligible = supervisorAcceptanceIneligibility(latest);
      if (ineligible) throw new Error(`Supervisor accept-with-reason refused: ${ineligible}.`);
      const acceptedCheckpoint = latest.checkpoints[latest.checkpoints.length - 1];
      const payloadFile = path.join(this.runDir, `${acceptedCheckpoint.id}-${acceptedCheckpoint.kind}.json`);
      const envelope = JSON.parse(fs.readFileSync(payloadFile, "utf8")) as unknown;
      if (!isRuntimeRecord(envelope) || !isRuntimeRecord(envelope.checkpoint) || !isRuntimeRecord(envelope.payload)) {
        throw new Error("Supervisor accept-with-reason refused: verifier checkpoint payload is missing or malformed.");
      }
      if (
        envelope.checkpoint.id !== acceptedCheckpoint.id ||
        envelope.checkpoint.sequence !== acceptedCheckpoint.sequence ||
        envelope.checkpoint.missionHash !== acceptedCheckpoint.missionHash
      ) throw new Error("Supervisor accept-with-reason refused: verifier checkpoint payload binding is stale.");
      const payload = envelope.payload;
      const numericGateFindings = Array.isArray(payload.numericGateFindings) ? payload.numericGateFindings : [];
      const verificationBatch = isRuntimeRecord(payload.verificationBatch) ? payload.verificationBatch : undefined;
      const workspaceIntegrity = verificationBatch && isRuntimeRecord(verificationBatch.workspaceIntegrity)
        ? verificationBatch.workspaceIntegrity
        : undefined;
      if (
        acceptedCheckpoint.outcome === "verifier_mutation" ||
        payload.verifierMutation !== undefined ||
        workspaceIntegrity?.mutationDetected === true ||
        numericGateFindings.some((finding) => isRuntimeRecord(finding) && finding.status === "fail")
      ) {
        throw new Error("Supervisor accept-with-reason refused: the verifier checkpoint contains a hard host safety or numeric failure.");
      }

      const consumed = consumeApprovalToken(latest.currentApproval as ApprovalRecord, token, {
        runId: latest.runId,
        missionHash: latest.mission.missionHash,
        checkpointId: acceptedCheckpoint.id,
        action: "continue",
      }, now);
      const acceptance: SupervisorAcceptance = {
        action: "accept",
        reason,
        acceptedAt: now.toISOString(),
        acceptedCheckpointId: acceptedCheckpoint.id,
        hostInstanceId,
      };
      let next = structuredClone(latest);
      next.currentApproval = consumed;
      next.acceptance = acceptance;
      if (next.runtime?.kind === "generic-shape") {
        next.runtime.cursor.stage = "terminal";
        next.runtime.cursor.currentTaskId = undefined;
      }
      next = transitionSupervisionState(next, "terminal", now);
      next.terminalOutcome = "accepted_with_reason";
      return this.appendCheckpoint(next, {
        kind: "acceptance",
        createdAt: acceptance.acceptedAt,
        missionHash: next.mission.missionHash,
        criteria: [],
        effectChanges: [],
        outcome: "accepted_with_reason",
      }, {
        acceptance,
        acceptedVerifierCheckpointId: acceptedCheckpoint.id,
        passedCriteriaAdded: [],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Approval is already being consumed by another continuation.");
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }

  /**
   * Cross-call/process compare-and-consume for an executor dispatch. The
   * returned metadata is derived inside the same exclusive section from the
   * exact token record that was verified and persisted.
   */
  consumeApprovalForDispatch(
    token: string,
    expected: ApprovalBinding,
    now = new Date(),
  ): { state: SupervisionRunState; approvalConsumption: ApprovalConsumptionMetadata } {
    const lockFile = `${this.stateFile}.approval.lock`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      const latest = this.loadReadOnly();
      if (!latest.currentApproval) throw new Error("No approval is outstanding for this checkpoint.");
      const consumed = consumeApprovalToken(latest.currentApproval, token, expected, now);
      const approvalConsumption = createApprovalConsumptionMetadata(consumed);
      const next = { ...latest, currentApproval: consumed };
      this.save(next);
      return { state: next, approvalConsumption };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Approval is already being consumed by another continuation.");
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }

  /** Compatibility wrapper for callers that do not need dispatch evidence. */
  consumeApproval(token: string, expected: ApprovalBinding, now = new Date()): SupervisionRunState {
    return this.consumeApprovalForDispatch(token, expected, now).state;
  }

  appendCheckpoint(
    state: SupervisionRunState,
    checkpoint: Omit<SupervisionCheckpoint, "id" | "sequence" | "payloadFile">,
    payload: unknown,
  ): SupervisionRunState {
    if (checkpoint.missionHash !== state.mission.missionHash) throw new Error("Checkpoint has the wrong mission binding.");
    const sequence = state.checkpointSequence + 1;
    const id = `checkpoint-${String(sequence).padStart(4, "0")}`;
    const payloadFile = path.join(this.runDir, `${id}-${checkpoint.kind}.json`);
    atomicWriteJsonSync(payloadFile, { checkpoint: { ...checkpoint, id, sequence }, payload });
    const complete: SupervisionCheckpoint = {
      ...checkpoint,
      id,
      sequence,
      payloadFile: normalizeWriteSetEntry(payloadFile),
    };
    const next = {
      ...structuredClone(state),
      checkpointSequence: sequence,
      checkpoints: [...state.checkpoints, complete],
      updatedAt: checkpoint.createdAt,
    };
    this.save(next);
    return next;
  }
}
