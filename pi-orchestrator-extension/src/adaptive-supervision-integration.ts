import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  activateAdaptiveCanaryStrategyB,
  applyGapEvidence,
  assertAdaptiveEnforceCanaryInvariants,
  canonicalAdaptiveValue,
  canonicalMissionContract,
  completeAdaptiveCanaryStrictAcceptance,
  createAdaptiveEnforceCanaryState,
  createFrozenMissionContract,
  decideSupervisorAction,
  observeSemanticProgress,
  recordAdaptiveCanaryStrategyAFailure,
  recordAdaptiveCanaryStrategyBProposal,
  recordAdaptiveCanaryStrategyBSuccess,
  reserveAdaptiveCanaryExecution,
  validateInitialStrategy,
  validateStrategyProposal,
  verifyFrozenMissionContract,
  type AdaptiveCanaryExecutionReservation,
  type AdaptiveEnforceCanaryState,
  type AdaptiveResourceUsage,
  type AdaptiveShadowObservation,
  type AdaptiveSupervisorDecision,
  type CreateAdaptiveEnforceCanaryInput,
  type CurrentStrategy,
  type FailureObservation,
  type FrozenMissionContract,
  type Gap,
  type GapEvidence,
  type MissionContract,
  type StrategyMaterialDimension,
  type StrategyMaterialProfile,
  type StrategyProposal,
  type StrategyProposalValidation,
} from "./adaptive-supervision";
import {
  GENERIC_SHAPE_ADAPTER_ID,
  HOST_TASK_BOUNDARY_PROTOCOL_ID,
  SupervisionStateStore,
  createFrozenMission,
  createGenericSupervisionCursor,
  createGenericSupervisionRuntime,
  createInitialSupervisionState,
  issueApprovalToken,
  transitionSupervisionState,
  type CriterionTask,
  type GenericSupervisionRuntime,
  type SupervisionRunState,
} from "./supervision";
import { captureContentSignatureSnapshot } from "./write-set";

export const ADAPTIVE_SUPERVISION_V1_FEATURE_FLAG = "PI_ORCHESTRATOR_ADAPTIVE_SUPERVISION_V1" as const;
export type AdaptiveSupervisionV1Mode = "off" | "fixture-v1";

export function adaptiveSupervisionV1Mode(env: NodeJS.ProcessEnv = process.env): AdaptiveSupervisionV1Mode {
  return env[ADAPTIVE_SUPERVISION_V1_FEATURE_FLAG] === "1" ? "fixture-v1" : "off";
}

export interface AdaptiveFixtureFailureResult {
  outcome: "failure";
  failureSignature: string;
  newEvidenceFlag: boolean;
  evidenceRefs: string[];
}

export interface AdaptiveFixtureSuccessResult {
  outcome: "success";
  evidence: GapEvidence;
}

export type AdaptiveFixtureExecutionResult = AdaptiveFixtureFailureResult | AdaptiveFixtureSuccessResult;

export interface AdaptiveFixtureModelProposalRecord {
  source: "model";
  proposal: StrategyProposal;
  hostMaterialProfile: StrategyMaterialProfile;
  validatedProposal: StrategyProposal;
  validation: StrategyProposalValidation;
}

export interface AdaptiveFixtureRetryVariation {
  reason: string;
  dimension: StrategyMaterialDimension;
  from: string;
  to: string;
  expectedNewEvidence: string[];
}

export interface AdaptiveFixtureExecutionPermit {
  attempt: number;
  resourceUnits: number;
  allowedOperations: string[];
  mutationPaths: string[];
}

export interface AdaptiveFixtureActivation {
  strategyId: string;
  strategyFamily: string;
  activatedBeforeExecution: true;
  checkpointId?: string;
}

export interface AdaptiveFixtureExecutionRecord {
  strategyId: string;
  strategyFamily: string;
  attempt: number;
  outcome: "failure" | "success";
  resourceUnitsUsed: number;
  failureSignature?: string;
  evidenceRef?: string;
}

export interface AdaptiveFixtureDurableState {
  schemaVersion: 1;
  mode: "fixture-v1";
  runId: string;
  hostMissionHash: string;
  missionContract: FrozenMissionContract;
  initialMissionBytes: string;
  initialMissionHash: string;
  phase:
    | "ready"
    | "strategy_a_attempt_1_failed"
    | "strategy_a_retry_justified"
    | "strategy_a_exhausted"
    | "strategy_b_proposed"
    | "strategy_b_activated"
    | "completed";
  gaps: Gap[];
  initiallyClosedGapIds: string[];
  activeStrategy: CurrentStrategy;
  strategyHistory: CurrentStrategy[];
  observations: FailureObservation[];
  retryVariations: AdaptiveFixtureRetryVariation[];
  exhaustedFamilies: string[];
  resourceUsage: AdaptiveResourceUsage;
  decisions: AdaptiveSupervisorDecision[];
  modelProposals: AdaptiveFixtureModelProposalRecord[];
  activations: AdaptiveFixtureActivation[];
  executions: AdaptiveFixtureExecutionRecord[];
  humanApprovalCount: 1;
  reconstructedRun: false;
  acceptanceClosedByStrategyId?: string;
}

export interface AdaptiveFixtureInput {
  runId: string;
  workspaceRoot: string;
  stateRoot: string;
  missionContract: MissionContract;
  initialGaps: Gap[];
  strategyA: CurrentStrategy;
  env?: NodeJS.ProcessEnv;
  classifyMaterialProfile(input: {
    source: "initial" | "proposal";
    strategy: CurrentStrategy;
    exhaustedStrategy?: CurrentStrategy;
  }): StrategyMaterialProfile;
  planStrategyARetry(input: {
    strategy: CurrentStrategy;
    firstFailure: FailureObservation;
  }): AdaptiveFixtureRetryVariation;
  proposeStrategyB(input: {
    runId: string;
    mission: FrozenMissionContract;
    gaps: Gap[];
    exhaustedStrategy: CurrentStrategy;
    observations: FailureObservation[];
  }): Promise<StrategyProposal> | StrategyProposal;
  executeStep(
    strategy: CurrentStrategy,
    attempt: number,
    permit: AdaptiveFixtureExecutionPermit,
  ): Promise<AdaptiveFixtureExecutionResult> | AdaptiveFixtureExecutionResult;
}

export interface AdaptiveFixtureResult {
  runId: string;
  hostMissionHash: string;
  missionContractHash: string;
  state: SupervisionRunState;
  adaptiveState: AdaptiveFixtureDurableState;
}

function runtimeOf(state: SupervisionRunState): GenericSupervisionRuntime {
  if (state.runtime?.kind !== "generic-shape") throw new Error("ADAPTIVE_FIXTURE_RUNTIME_MISSING");
  return state.runtime;
}

function adaptiveStateOf(state: SupervisionRunState): AdaptiveFixtureDurableState {
  const value = runtimeOf(state).adapterState?.adaptiveSupervision;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ADAPTIVE_FIXTURE_STATE_MISSING");
  return value as unknown as AdaptiveFixtureDurableState;
}

function setAdaptiveState(state: SupervisionRunState, adaptive: AdaptiveFixtureDurableState): void {
  const runtime = runtimeOf(state);
  runtime.adapterState = {
    ...(runtime.adapterState ?? {}),
    adaptiveSupervision: structuredClone(adaptive) as unknown as Record<string, unknown>,
  };
}

function assertMissionStable(adaptive: AdaptiveFixtureDurableState): void {
  if (
    !verifyFrozenMissionContract(adaptive.missionContract) ||
    adaptive.missionContract.canonicalBytes !== adaptive.initialMissionBytes ||
    adaptive.missionContract.missionHash !== adaptive.initialMissionHash ||
    canonicalMissionContract(adaptive.missionContract.contract) !== adaptive.initialMissionBytes
  ) throw new Error("ADAPTIVE_MISSION_CONTRACT_DRIFT");
}

function nowIso(): string {
  return new Date().toISOString();
}

function criteriaFor(contract: MissionContract) {
  return contract.acceptanceCriteria.map((text, index) => ({
    id: `AC-${String(index + 1).padStart(2, "0")}`,
    text,
    required: true,
  }));
}

function checkpointCriteria(state: SupervisionRunState): string[] {
  return state.mission.acceptanceCriteria.map((criterion) => criterion.id);
}

function updateAdaptiveAndSave(store: SupervisionStateStore, state: SupervisionRunState, adaptive: AdaptiveFixtureDurableState): void {
  assertMissionStable(adaptive);
  if (state.runId !== adaptive.runId || state.mission.missionHash !== adaptive.hostMissionHash) {
    throw new Error("ADAPTIVE_SAME_RUN_IDENTITY_DRIFT");
  }
  setAdaptiveState(state, adaptive);
  store.save(state);
}

function appendAdaptiveCheckpoint(
  store: SupervisionStateStore,
  state: SupervisionRunState,
  adaptive: AdaptiveFixtureDurableState,
  input: { kind: "plan" | "executor" | "verifier"; outcome: string; taskId?: string },
): SupervisionRunState {
  setAdaptiveState(state, adaptive);
  return store.appendCheckpoint(state, {
    kind: input.kind,
    createdAt: nowIso(),
    missionHash: state.mission.missionHash,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    criteria: checkpointCriteria(state),
    effectChanges: [],
    outcome: input.outcome,
  }, {
    adaptiveSupervision: structuredClone(adaptive),
    runIdentity: { runId: state.runId, hostMissionHash: state.mission.missionHash },
  });
}

function reserveExecution(adaptive: AdaptiveFixtureDurableState): AdaptiveFixtureExecutionPermit {
  const units = adaptive.activeStrategy.resourceBudget.resourceUnitsPerAttempt;
  const nextStrategyAttempt = adaptive.activeStrategy.attemptsUsed + 1;
  const nextStrategyResource = nextStrategyAttempt * units;
  const missionBudget = adaptive.missionContract.contract.resourceBudget;
  if (
    nextStrategyAttempt > adaptive.activeStrategy.resourceBudget.maxAttempts ||
    nextStrategyResource > adaptive.activeStrategy.resourceBudget.resourceUnits ||
    adaptive.resourceUsage.attemptsUsed + 1 > missionBudget.maxTotalAttempts ||
    adaptive.resourceUsage.resourceUnitsUsed + units > missionBudget.maxResourceUnits
  ) throw new Error("ADAPTIVE_FIXTURE_RESOURCE_BUDGET_EXCEEDED");
  // Reserve before dispatch. A callback receives only this bounded permit and
  // cannot enlarge its charge through a post-execution self-report.
  adaptive.resourceUsage.attemptsUsed += 1;
  adaptive.resourceUsage.resourceUnitsUsed += units;
  adaptive.activeStrategy.attemptsUsed = nextStrategyAttempt;
  const history = adaptive.strategyHistory.find((strategy) => strategy.strategyId === adaptive.activeStrategy.strategyId);
  if (history) history.attemptsUsed = nextStrategyAttempt;
  return {
    attempt: nextStrategyAttempt,
    resourceUnits: units,
    allowedOperations: [...adaptive.activeStrategy.operations],
    mutationPaths: [...adaptive.activeStrategy.mutationPaths],
  };
}

function applyRetryVariation(adaptive: AdaptiveFixtureDurableState, variation: AdaptiveFixtureRetryVariation): void {
  const profile = adaptive.activeStrategy.materialProfile;
  const current = profile[variation.dimension];
  if (
    !variation.reason.trim() || !variation.from.trim() || !variation.to.trim() || variation.from.trim() === variation.to.trim() ||
    !Array.isArray(variation.expectedNewEvidence) || variation.expectedNewEvidence.length === 0 ||
    variation.expectedNewEvidence.some((item) => typeof item !== "string" || !item.trim()) ||
    current !== variation.from
  ) throw new Error("ADAPTIVE_FIXTURE_RETRY_VARIATION_INVALID");
  profile[variation.dimension] = variation.to;
  const history = adaptive.strategyHistory.find((strategy) => strategy.strategyId === adaptive.activeStrategy.strategyId);
  if (history) history.materialProfile[variation.dimension] = variation.to;
  adaptive.retryVariations.push(structuredClone(variation));
}

function failureObservation(strategy: CurrentStrategy, result: AdaptiveFixtureFailureResult): FailureObservation {
  if (!result.failureSignature.trim()) throw new Error("ADAPTIVE_FIXTURE_FAILURE_SIGNATURE_REQUIRED");
  return {
    strategyId: strategy.strategyId,
    strategyFamily: strategy.strategyFamily,
    normalizedFailureSignature: result.failureSignature.replace(/\s+/g, " ").trim(),
    newEvidenceFlag: result.newEvidenceFlag,
    evidenceRefs: [...result.evidenceRefs],
  };
}

/**
 * Deterministic Stage 2 vertical slice. It deliberately proves only one
 * same-run transition: A fails twice without new information, a model callback
 * proposes B, the hard shell validates and durably activates B, then B closes
 * G1 with admissible evidence. The feature is default-off and has no public
 * orchestration parameter yet.
 */
export async function runAdaptiveSupervisionV1Fixture(input: AdaptiveFixtureInput): Promise<AdaptiveFixtureResult> {
  if (adaptiveSupervisionV1Mode(input.env) !== "fixture-v1") throw new Error("ADAPTIVE_SUPERVISION_V1_DISABLED");
  if (!fs.existsSync(input.workspaceRoot) || !fs.statSync(input.workspaceRoot).isDirectory()) {
    throw new Error("ADAPTIVE_FIXTURE_WORKSPACE_REQUIRED");
  }

  const missionContract = createFrozenMissionContract(input.missionContract);
  const g1 = input.initialGaps.find((gap) => gap.gapId === "G1");
  if (!g1 || g1.status !== "open" || input.initialGaps.some((gap) => gap.gapId !== "G1" && gap.status !== "closed")) {
    throw new Error("ADAPTIVE_FIXTURE_LEDGER_INVALID: G1 must be the sole open mission gap.");
  }
  const hostClassifiedStrategyA: CurrentStrategy = {
    ...structuredClone(input.strategyA),
    materialProfile: structuredClone(input.classifyMaterialProfile({
      source: "initial",
      strategy: structuredClone(input.strategyA),
    })),
  };
  const initialStrategyValidation = validateInitialStrategy(
    missionContract,
    input.initialGaps,
    hostClassifiedStrategyA,
    { attemptsUsed: 0, strategiesUsed: 0, resourceUnitsUsed: 0 },
  );
  if (!initialStrategyValidation.accepted) {
    throw new Error(`ADAPTIVE_INITIAL_STRATEGY_REJECTED: ${initialStrategyValidation.reasons.map((reason) => reason.code).join(",")}`);
  }
  const validatedStrategyA = initialStrategyValidation.strategy;
  const hostCriteria = criteriaFor(missionContract.contract);
  const hostMission = createFrozenMission({
    originalTask: missionContract.contract.requiredOutcomes.join("\n"),
    cwd: input.workspaceRoot,
    worktree: {
      root: input.workspaceRoot,
      realRoot: fs.realpathSync.native(input.workspaceRoot),
      branch: null,
      baseline: null,
    },
    paradigm: "adaptive-supervision-v1-fixture",
    lane: "orchestrator-maintenance",
    routes: [{
      role: "strategy-proposer",
      agentName: "deterministic-model-fixture",
      provider: "fixture",
      model: "strategy-b",
    }],
    constraints: [
      ...missionContract.contract.strategicInvariants,
      ...missionContract.contract.safetyEnvelope.forbiddenOperations.map((operation) => `forbid:${operation}`),
    ],
    nonGoals: missionContract.contract.nonGoals,
    acceptanceCriteria: hostCriteria,
  });
  const task: CriterionTask = {
    id: "adaptive-transition",
    description: "Prove an exhausted Strategy A can be replaced by legal Strategy B in the same run.",
    dependsOn: [],
    criteria: hostCriteria.map((criterion) => criterion.id),
  };
  const store = new SupervisionStateStore(input.runId, input.stateRoot);
  let state = createInitialSupervisionState({ runId: input.runId, mission: hostMission, tasks: [task], mode: "visible-main" });
  store.create(state);
  const identity = {
    protocolId: HOST_TASK_BOUNDARY_PROTOCOL_ID,
    adapterId: GENERIC_SHAPE_ADAPTER_ID,
    adapterVersion: 1 as const,
  };
  const adaptive: AdaptiveFixtureDurableState = {
    schemaVersion: 1,
    mode: "fixture-v1",
    runId: input.runId,
    hostMissionHash: hostMission.missionHash,
    missionContract,
    initialMissionBytes: missionContract.canonicalBytes,
    initialMissionHash: missionContract.missionHash,
    phase: "ready",
    gaps: structuredClone(input.initialGaps),
    initiallyClosedGapIds: input.initialGaps.filter((gap) => gap.status === "closed").map((gap) => gap.gapId),
    activeStrategy: structuredClone(validatedStrategyA),
    strategyHistory: [structuredClone(validatedStrategyA)],
    observations: [],
    retryVariations: [],
    exhaustedFamilies: [],
    resourceUsage: { attemptsUsed: 0, strategiesUsed: 1, resourceUnitsUsed: 0 },
    decisions: [],
    modelProposals: [],
    activations: [],
    executions: [],
    humanApprovalCount: 1,
    reconstructedRun: false,
  };
  assertMissionStable(adaptive);
  state.runtime = createGenericSupervisionRuntime({
    identity,
    cursor: createGenericSupervisionCursor(identity, { stage: "executor-task", nextTaskIndex: 0 }),
    params: {
      task: hostMission.originalTask,
      cwd: input.workspaceRoot,
      paradigm: hostMission.paradigm,
      supervision: "visible-main",
      adaptiveSupervision: "fixture-v1",
    },
    intake: { fixture: "adaptive-supervision-v1" },
    plan: { tasks: [task], notes: "Deterministic Stage 2 A-to-B fixture." },
    completedTaskIds: [],
    executorOutputs: [],
    contentBaseline: captureContentSignatureSnapshot(input.workspaceRoot),
    repairCount: 0,
    adapterState: {
      classification: "executor-bearing",
      adaptiveSupervision: structuredClone(adaptive) as unknown as Record<string, unknown>,
    },
  });
  store.save(state);
  state = appendAdaptiveCheckpoint(store, state, adaptive, { kind: "plan", outcome: "adaptive_plan_ready", taskId: task.id });
  state = transitionSupervisionState(state, "awaiting_supervisor");
  store.save(state);

  // Exactly one initial visible-main approval authorizes the bounded fixture.
  const planCheckpoint = state.checkpoints[state.checkpoints.length - 1];
  const issued = issueApprovalToken({
    runId: state.runId,
    missionHash: state.mission.missionHash,
    checkpointId: planCheckpoint.id,
    action: "continue",
  });
  state.currentApproval = issued.record;
  store.save(state);
  state = store.consumeApproval(issued.token, {
    runId: state.runId,
    missionHash: state.mission.missionHash,
    checkpointId: planCheckpoint.id,
    action: "continue",
  });
  state = transitionSupervisionState(state, "executing");
  state.currentTaskId = task.id;
  store.save(state);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const permit = reserveExecution(adaptive); // hard-shell quota reservation precedes dispatch
    updateAdaptiveAndSave(store, state, adaptive);
    const result = await input.executeStep(structuredClone(adaptive.activeStrategy), attempt, structuredClone(permit));
    if (result.outcome !== "failure") throw new Error(`ADAPTIVE_FIXTURE_EXPECTED_A_FAILURE_${attempt}`);
    const observation = failureObservation(adaptive.activeStrategy, result);
    adaptive.observations.push(observation);
    adaptive.executions.push({
      strategyId: adaptive.activeStrategy.strategyId,
      strategyFamily: adaptive.activeStrategy.strategyFamily,
      attempt,
      outcome: "failure",
      resourceUnitsUsed: permit.resourceUnits,
      failureSignature: observation.normalizedFailureSignature,
    });
    const decision = decideSupervisorAction({
      mission: adaptive.missionContract,
      gaps: adaptive.gaps,
      currentStrategy: adaptive.activeStrategy,
      observations: adaptive.observations,
      resourceUsage: adaptive.resourceUsage,
    });
    adaptive.decisions.push(decision);
    if (attempt === 1) {
      if (decision.kind !== "CONTINUE") throw new Error("ADAPTIVE_FIXTURE_FIRST_FAILURE_MUST_ALLOW_RETRY");
      adaptive.phase = "strategy_a_attempt_1_failed";
      state = appendAdaptiveCheckpoint(store, state, adaptive, { kind: "executor", outcome: "strategy_a_attempt_1_failed", taskId: task.id });
      const variation = input.planStrategyARetry({
        strategy: structuredClone(adaptive.activeStrategy),
        firstFailure: structuredClone(observation),
      });
      applyRetryVariation(adaptive, variation);
      adaptive.phase = "strategy_a_retry_justified";
      state = appendAdaptiveCheckpoint(store, state, adaptive, { kind: "executor", outcome: "strategy_a_retry_justified", taskId: task.id });
    } else {
      if (decision.kind !== "REPLAN") throw new Error("ADAPTIVE_FIXTURE_SECOND_EQUIVALENT_FAILURE_MUST_REPLAN");
      adaptive.phase = "strategy_a_exhausted";
      if (!adaptive.exhaustedFamilies.includes(adaptive.activeStrategy.strategyFamily)) {
        adaptive.exhaustedFamilies.push(adaptive.activeStrategy.strategyFamily);
      }
      state = appendAdaptiveCheckpoint(store, state, adaptive, { kind: "executor", outcome: "strategy_a_exhausted", taskId: task.id });
    }
  }

  const proposal = await input.proposeStrategyB({
    runId: state.runId,
    mission: structuredClone(adaptive.missionContract),
    gaps: structuredClone(adaptive.gaps),
    exhaustedStrategy: structuredClone(adaptive.activeStrategy),
    observations: structuredClone(adaptive.observations),
  });
  adaptive.phase = "strategy_b_proposed";
  const hostMaterialProfile = input.classifyMaterialProfile({
    source: "proposal",
    strategy: structuredClone(proposal.strategy),
    exhaustedStrategy: structuredClone(adaptive.activeStrategy),
  });
  const validatedProposal: StrategyProposal = {
    ...structuredClone(proposal),
    strategy: {
      ...structuredClone(proposal.strategy),
      materialProfile: structuredClone(hostMaterialProfile),
    },
  };
  const validation = validateStrategyProposal(
    adaptive.missionContract,
    adaptive.gaps,
    adaptive.activeStrategy,
    validatedProposal,
    adaptive.resourceUsage,
    adaptive.exhaustedFamilies,
  );
  adaptive.modelProposals.push({
    source: "model",
    proposal: structuredClone(proposal),
    hostMaterialProfile: structuredClone(hostMaterialProfile),
    validatedProposal: structuredClone(validatedProposal),
    validation: structuredClone(validation),
  });
  updateAdaptiveAndSave(store, state, adaptive);
  if (!validation.accepted) {
    throw new Error(`ADAPTIVE_STRATEGY_B_REJECTED: ${validation.reasons.map((reason) => reason.code).join(",")}`);
  }

  adaptive.activeStrategy = structuredClone(validation.strategy);
  adaptive.strategyHistory.push(structuredClone(validation.strategy));
  adaptive.resourceUsage.strategiesUsed += 1;
  adaptive.phase = "strategy_b_activated";
  adaptive.activations.push({
    strategyId: validation.strategy.strategyId,
    strategyFamily: validation.strategy.strategyFamily,
    activatedBeforeExecution: true,
  });
  state = appendAdaptiveCheckpoint(store, state, adaptive, { kind: "executor", outcome: "strategy_b_activated", taskId: task.id });
  const activationCheckpoint = state.checkpoints[state.checkpoints.length - 1];
  adaptive.activations[adaptive.activations.length - 1].checkpointId = activationCheckpoint.id;
  updateAdaptiveAndSave(store, state, adaptive); // activation is durable before executeStep(B)

  const beforeB = structuredClone(adaptive.gaps);
  const bPermit = reserveExecution(adaptive); // reserve B's bounded attempt before execution
  updateAdaptiveAndSave(store, state, adaptive);
  const bResult = await input.executeStep(structuredClone(adaptive.activeStrategy), 1, structuredClone(bPermit));
  if (bResult.outcome !== "success") throw new Error("ADAPTIVE_FIXTURE_STRATEGY_B_MUST_SUCCEED");
  if (
    bResult.evidence.gapId !== "G1" ||
    !adaptive.activeStrategy.whichGapIds.includes(bResult.evidence.gapId) ||
    !adaptive.activeStrategy.expectedEvidence.includes(bResult.evidence.evidenceKind)
  ) throw new Error("ADAPTIVE_FIXTURE_STRATEGY_B_EVIDENCE_OUT_OF_TARGET");
  adaptive.gaps = applyGapEvidence(adaptive.gaps, bResult.evidence);
  const semanticProgress = observeSemanticProgress(beforeB, [bResult.evidence], adaptive.gaps);
  if (!semanticProgress.closedGapIds.includes("G1")) throw new Error("ADAPTIVE_FIXTURE_G1_NOT_CLOSED_BY_B");
  adaptive.executions.push({
    strategyId: adaptive.activeStrategy.strategyId,
    strategyFamily: adaptive.activeStrategy.strategyFamily,
    attempt: 1,
    outcome: "success",
    resourceUnitsUsed: bPermit.resourceUnits,
    evidenceRef: bResult.evidence.evidenceRef,
  });
  adaptive.acceptanceClosedByStrategyId = adaptive.activeStrategy.strategyId;
  state = appendAdaptiveCheckpoint(store, state, adaptive, { kind: "executor", outcome: "strategy_b_closed_g1", taskId: task.id });

  if (adaptive.gaps.find((gap) => gap.gapId === "G1")?.status !== "closed") throw new Error("ADAPTIVE_FIXTURE_G1_REMAINS_OPEN");
  if (adaptive.initiallyClosedGapIds.some((gapId) => adaptive.gaps.find((gap) => gap.gapId === gapId)?.status !== "closed")) {
    throw new Error("ADAPTIVE_FIXTURE_CLOSED_GAP_REGRESSED");
  }
  if (!adaptive.gaps.every((gap) => gap.status === "closed")) {
    throw new Error("ADAPTIVE_FIXTURE_STRICT_ACCEPTANCE_REFUSED: unresolved mission gaps remain.");
  }
  state.lastTaskId = task.id;
  state.currentTaskId = undefined;
  state.completedCriteria = checkpointCriteria(state);
  const runtime = runtimeOf(state);
  runtime.completedTaskIds = [task.id];
  runtime.cursor = createGenericSupervisionCursor(runtime.identity, {
    stage: "verifier",
    nextTaskIndex: 1,
    completedTaskIds: [task.id],
    lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id,
  });
  state = transitionSupervisionState(state, "awaiting_supervisor");
  // Legal, in-envelope B proceeds directly to strict acceptance evaluation;
  // no second approval token is issued or consumed.
  state = transitionSupervisionState(state, "verifying");
  store.save(state);
  adaptive.phase = "completed";
  runtime.cursor = createGenericSupervisionCursor(runtime.identity, {
    stage: "terminal",
    nextTaskIndex: 1,
    completedTaskIds: [task.id],
    lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id,
  });
  setAdaptiveState(state, adaptive);
  state = transitionSupervisionState(state, "terminal");
  state.terminalOutcome = "pass";
  state = appendAdaptiveCheckpoint(store, state, adaptive, { kind: "verifier", outcome: "pass", taskId: task.id });
  runtimeOf(state).cursor = createGenericSupervisionCursor(runtimeOf(state).identity, {
    stage: "terminal",
    nextTaskIndex: 1,
    completedTaskIds: [task.id],
    lastCheckpointId: state.checkpoints[state.checkpoints.length - 1].id,
  });
  updateAdaptiveAndSave(store, state, adaptive);

  const reloaded = store.loadReadOnly();
  const reloadedAdaptive = adaptiveStateOf(reloaded);
  assertMissionStable(reloadedAdaptive);
  if (reloaded.runId !== input.runId || reloaded.mission.missionHash !== hostMission.missionHash || reloadedAdaptive.reconstructedRun) {
    throw new Error("ADAPTIVE_FIXTURE_DURABLE_IDENTITY_FAILURE");
  }
  return {
    runId: reloaded.runId,
    hostMissionHash: reloaded.mission.missionHash,
    missionContractHash: reloadedAdaptive.missionContract.missionHash,
    state: reloaded,
    adaptiveState: structuredClone(reloadedAdaptive),
  };
}

// ---------------------------------------------------------------------------
// Stage 3 durable shadow journal
// ---------------------------------------------------------------------------

export interface AdaptiveShadowDurableEnvelope {
  schemaVersion: 1;
  sequence: number;
  previousRecordHash: string | null;
  recordHash: string;
  record: AdaptiveShadowObservation;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function appendJsonLineDurably(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, "a");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Append-only shadow evidence. The observation type hard-codes
 * `controlledExecution:false`; this journal has no dispatch API and therefore
 * cannot accidentally become an execution authority.
 */
export class AdaptiveShadowJournal {
  readonly file: string;

  constructor(file: string) {
    if (!file.trim()) throw new Error("ADAPTIVE_SHADOW_JOURNAL_PATH_REQUIRED");
    this.file = path.resolve(file);
  }

  readAll(): AdaptiveShadowDurableEnvelope[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, "utf8").split(/\r?\n/).filter((line) => line.trim());
    const envelopes = lines.map((line) => JSON.parse(line) as AdaptiveShadowDurableEnvelope);
    let previous: string | null = null;
    const identities = new Set<string>();
    for (let index = 0; index < envelopes.length; index += 1) {
      const envelope = envelopes[index];
      if (
        envelope.schemaVersion !== 1 || envelope.sequence !== index + 1 ||
        envelope.previousRecordHash !== previous || envelope.record.controlledExecution !== false ||
        envelope.record.mode !== "shadow-v1" || envelope.record.schemaVersion !== 1 ||
        envelope.recordHash !== sha256(canonicalAdaptiveValue({
          sequence: envelope.sequence,
          previousRecordHash: envelope.previousRecordHash,
          record: envelope.record,
        }))
      ) throw new Error("ADAPTIVE_SHADOW_JOURNAL_INTEGRITY_FAILURE");
      const identity = `${envelope.record.runId}\u0000${envelope.record.recordId}`;
      if (identities.has(identity)) throw new Error("ADAPTIVE_SHADOW_DUPLICATE_RECORD");
      identities.add(identity);
      previous = envelope.recordHash;
    }
    return envelopes;
  }

  append(record: AdaptiveShadowObservation): AdaptiveShadowDurableEnvelope {
    if (record.controlledExecution !== false || record.mode !== "shadow-v1" || record.schemaVersion !== 1) {
      throw new Error("ADAPTIVE_SHADOW_NON_CONTROLLING_RECORD_REQUIRED");
    }
    const existing = this.readAll();
    if (existing.some((item) => item.record.runId === record.runId && item.record.recordId === record.recordId)) {
      throw new Error("ADAPTIVE_SHADOW_DUPLICATE_RECORD");
    }
    const sequence = existing.length + 1;
    const previousRecordHash = existing.at(-1)?.recordHash ?? null;
    const recordHash = sha256(canonicalAdaptiveValue({ sequence, previousRecordHash, record }));
    const envelope: AdaptiveShadowDurableEnvelope = {
      schemaVersion: 1,
      sequence,
      previousRecordHash,
      recordHash,
      record: structuredClone(record),
    };
    appendJsonLineDurably(this.file, envelope);
    // Read-after-write makes durability/integrity failure visible to the host.
    const persisted = this.readAll().at(-1);
    if (!persisted || persisted.recordHash !== recordHash) throw new Error("ADAPTIVE_SHADOW_DURABILITY_FAILURE");
    return structuredClone(persisted);
  }
}

// ---------------------------------------------------------------------------
// Stage 4 durable enforce-canary host adapter
// ---------------------------------------------------------------------------

export type AdaptiveCanaryDurableEventKind =
  | "created"
  | "execution_reserved"
  | "strategy_a_failure_recorded"
  | "strategy_b_proposal_recorded"
  | "strategy_b_activated"
  | "strategy_b_success_recorded"
  | "strict_acceptance_completed";

export interface AdaptiveCanaryDurableEvent {
  schemaVersion: 1;
  sequence: number;
  kind: AdaptiveCanaryDurableEventKind;
  runId: string;
  phase: AdaptiveEnforceCanaryState["phase"];
  missionHash: string;
  stateHash: string;
  createdAt: string;
}

export interface AdaptiveCanaryDispatchPermit {
  runId: string;
  missionHash: string;
  strategy: CurrentStrategy;
  reservation: AdaptiveCanaryExecutionReservation;
  /** True only when B activation was loaded from disk before reservation. */
  durableStrategyBActivation: boolean;
}

function atomicWriteJsonDurably(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Durable state adapter for the one real A,A,model-B,B canary. It intentionally
 * does not accept execution callbacks: callers must obtain a permit, dispatch
 * their routed subprocess, then record the classified real output. In
 * particular, `beginStrategyBExecution` can only return after a previously
 * persisted B activation has been loaded and checked.
 */
export class AdaptiveEnforceCanaryStore {
  readonly runId: string;
  readonly stateFile: string;
  readonly eventsFile: string;

  constructor(stateRoot: string, runId: string) {
    if (!stateRoot.trim() || !runId.trim() || /[\\/]/.test(runId)) throw new Error("ADAPTIVE_CANARY_STORE_IDENTITY_INVALID");
    this.runId = runId;
    const directory = path.join(path.resolve(stateRoot), runId);
    this.stateFile = path.join(directory, "adaptive-enforce-canary.json");
    this.eventsFile = path.join(directory, "adaptive-enforce-canary.events.jsonl");
  }

  exists(): boolean {
    return fs.existsSync(this.stateFile);
  }

  create(input: CreateAdaptiveEnforceCanaryInput): AdaptiveEnforceCanaryState {
    if (input.runId !== this.runId) throw new Error("ADAPTIVE_CANARY_RUN_ID_MISMATCH");
    if (this.exists() || fs.existsSync(this.eventsFile)) throw new Error("ADAPTIVE_CANARY_ALREADY_EXISTS");
    const state = createAdaptiveEnforceCanaryState(input);
    this.persist(state, "created");
    return structuredClone(state);
  }

  load(): AdaptiveEnforceCanaryState {
    if (!this.exists()) throw new Error("ADAPTIVE_CANARY_STATE_MISSING");
    const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as AdaptiveEnforceCanaryState;
    assertAdaptiveEnforceCanaryInvariants(state);
    if (state.runId !== this.runId) throw new Error("ADAPTIVE_CANARY_RUN_ID_MISMATCH");
    return state;
  }

  private persist(state: AdaptiveEnforceCanaryState, kind: AdaptiveCanaryDurableEventKind): void {
    assertAdaptiveEnforceCanaryInvariants(state);
    if (state.runId !== this.runId) throw new Error("ADAPTIVE_CANARY_RUN_ID_MISMATCH");
    atomicWriteJsonDurably(this.stateFile, state);
    const sequence = fs.existsSync(this.eventsFile)
      ? fs.readFileSync(this.eventsFile, "utf8").split(/\r?\n/).filter((line) => line.trim()).length + 1
      : 1;
    appendJsonLineDurably(this.eventsFile, {
      schemaVersion: 1,
      sequence,
      kind,
      runId: state.runId,
      phase: state.phase,
      missionHash: state.mission.missionHash,
      stateHash: sha256(canonicalAdaptiveValue(state)),
      createdAt: nowIso(),
    } satisfies AdaptiveCanaryDurableEvent);
    const reloaded = this.load();
    if (sha256(canonicalAdaptiveValue(reloaded)) !== sha256(canonicalAdaptiveValue(state))) {
      throw new Error("ADAPTIVE_CANARY_DURABILITY_FAILURE");
    }
  }

  private beginExecution(expected: "A" | "B"): AdaptiveCanaryDispatchPermit {
    const persistedBeforeReservation = this.load();
    const isA = persistedBeforeReservation.activeStrategy.strategyId === persistedBeforeReservation.strategyAId;
    if ((expected === "A") !== isA) throw new Error("ADAPTIVE_CANARY_UNEXPECTED_STRATEGY_FAMILY");
    const durableStrategyBActivation = !isA &&
      persistedBeforeReservation.phase === "strategy_b_activated" &&
      persistedBeforeReservation.activations.some((item) =>
        item.strategyId === persistedBeforeReservation.activeStrategy.strategyId && item.durableBeforeDispatch === true);
    if (!isA && !durableStrategyBActivation) throw new Error("ADAPTIVE_CANARY_B_NOT_DURABLY_ACTIVATED");
    const reserved = reserveAdaptiveCanaryExecution(persistedBeforeReservation);
    this.persist(reserved.state, "execution_reserved");
    return {
      runId: reserved.state.runId,
      missionHash: reserved.state.mission.missionHash,
      strategy: structuredClone(reserved.state.activeStrategy),
      reservation: structuredClone(reserved.reservation),
      durableStrategyBActivation,
    };
  }

  beginStrategyAExecution(): AdaptiveCanaryDispatchPermit {
    return this.beginExecution("A");
  }

  recordStrategyAFailure(observation: FailureObservation): AdaptiveEnforceCanaryState {
    const state = recordAdaptiveCanaryStrategyAFailure(this.load(), observation);
    this.persist(state, "strategy_a_failure_recorded");
    return structuredClone(state);
  }

  recordStrategyBProposal(
    modelProposal: StrategyProposal,
    hostMaterialProfile: StrategyMaterialProfile,
  ): AdaptiveEnforceCanaryState {
    const state = recordAdaptiveCanaryStrategyBProposal(this.load(), modelProposal, hostMaterialProfile);
    this.persist(state, "strategy_b_proposal_recorded");
    return structuredClone(state);
  }

  activateStrategyB(): AdaptiveEnforceCanaryState {
    const state = activateAdaptiveCanaryStrategyB(this.load());
    this.persist(state, "strategy_b_activated");
    return structuredClone(state);
  }

  beginStrategyBExecution(): AdaptiveCanaryDispatchPermit {
    return this.beginExecution("B");
  }

  recordStrategyBSuccess(evidence: GapEvidence): AdaptiveEnforceCanaryState {
    const state = recordAdaptiveCanaryStrategyBSuccess(this.load(), evidence);
    this.persist(state, "strategy_b_success_recorded");
    return structuredClone(state);
  }

  completeStrictAcceptance(satisfiedCriteria: string[]): AdaptiveEnforceCanaryState {
    const state = completeAdaptiveCanaryStrictAcceptance(this.load(), satisfiedCriteria);
    this.persist(state, "strict_acceptance_completed");
    return structuredClone(state);
  }

  readEvents(): AdaptiveCanaryDurableEvent[] {
    if (!fs.existsSync(this.eventsFile)) return [];
    const events = fs.readFileSync(this.eventsFile, "utf8").split(/\r?\n/).filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AdaptiveCanaryDurableEvent);
    events.forEach((event, index) => {
      if (
        event.schemaVersion !== 1 || event.sequence !== index + 1 || event.runId !== this.runId ||
        !/^[a-f0-9]{64}$/.test(event.missionHash) || !/^[a-f0-9]{64}$/.test(event.stateHash)
      ) throw new Error("ADAPTIVE_CANARY_EVENT_LOG_INTEGRITY_FAILURE");
    });
    return events;
  }
}
