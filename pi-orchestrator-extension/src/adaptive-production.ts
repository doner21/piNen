import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  applyGapEvidence,
  canonicalAdaptiveValue,
  decideSupervisorAction,
  validateInitialStrategy,
  validateStrategyProposal,
  verifyFrozenMissionContract,
  type AdaptiveResourceUsage,
  type AdaptiveSupervisorDecision,
  type CurrentStrategy,
  type FailureObservation,
  type FrozenMissionContract,
  type Gap,
  type StrategyMaterialProfile,
  type StrategyProposal,
  type StrategyProposalValidation,
} from "./adaptive-supervision";

export type AdaptiveProductionPhase =
  | "strategy_ready"
  | "strategy_executing"
  | "strategy_retry_ready"
  | "strategy_exhausted"
  | "strategy_proposed"
  | "strategy_activated"
  | "acceptance_evaluation"
  | "completed"
  | "failed";

export interface AdaptiveProductionInvariantSnapshot {
  runId: string;
  hostMissionHash: string;
  missionCanonicalBytes: string;
  missionHash: string;
  acceptanceCriteriaBytes: string;
  safetyScopeBytes: string;
  gapIdentityBytes: string;
  initialApprovalCount: 1;
}

export interface AdaptiveProductionExecutionReservation {
  reservationId: string;
  strategyId: string;
  strategyFamily: string;
  attempt: number;
  resourceUnits: number;
  reservedAt: string;
  outcome?: "failure" | "success";
  failureSignature?: string;
  evidenceRef?: string;
}

export interface AdaptiveProductionProposalRecord {
  proposedAt: string;
  modelProposal: StrategyProposal;
  hostMaterialProfile: StrategyMaterialProfile;
  validatedProposal: StrategyProposal;
  validation: StrategyProposalValidation;
}

export interface AdaptiveProductionActivationRecord {
  strategyId: string;
  strategyFamily: string;
  activatedAt: string;
  durableBeforeDispatch: true;
}

export interface AdaptiveProductionState {
  schemaVersion: 1;
  mode: "adaptive-v1";
  runId: string;
  hostMissionHash: string;
  reconstructedRun: false;
  approvalCount: 1;
  mission: FrozenMissionContract;
  invariantSnapshot: AdaptiveProductionInvariantSnapshot;
  phase: AdaptiveProductionPhase;
  gaps: Gap[];
  activeStrategy: CurrentStrategy;
  initialStrategyId: string;
  strategyHistory: CurrentStrategy[];
  observations: FailureObservation[];
  exhaustedFamilies: string[];
  resourceUsage: AdaptiveResourceUsage;
  decisions: AdaptiveSupervisorDecision[];
  proposals: AdaptiveProductionProposalRecord[];
  activations: AdaptiveProductionActivationRecord[];
  executionReservations: AdaptiveProductionExecutionReservation[];
  strictAcceptance?: {
    passed: true;
    satisfiedGapIds: string[];
    satisfiedCriteria: string[];
    evaluatedAt: string;
  };
  failure?: { code: string; message: string; observedAt: string };
}

export interface AdaptiveProductionCreateInput {
  runId: string;
  hostMissionHash: string;
  mission: FrozenMissionContract;
  gaps: Gap[];
  initialStrategy: CurrentStrategy;
  approvalCount: number;
}

export interface AdaptiveProductionDispatchPermit {
  runId: string;
  hostMissionHash: string;
  missionHash: string;
  strategy: CurrentStrategy;
  reservation: AdaptiveProductionExecutionReservation;
  durableReplacementActivation: boolean;
}

export type AdaptiveProductionEventKind =
  | "created"
  | "execution_reserved"
  | "failure_recorded"
  | "proposal_recorded"
  | "replacement_activated"
  | "success_recorded"
  | "strict_acceptance_completed"
  | "failed";

export interface AdaptiveProductionEvent {
  schemaVersion: 1;
  sequence: number;
  previousEventHash: string | null;
  eventHash: string;
  kind: AdaptiveProductionEventKind;
  runId: string;
  hostMissionHash: string;
  missionHash: string;
  phase: AdaptiveProductionPhase;
  stateHash: string;
  createdAt: string;
}

function nowIso(value?: string): string {
  const result = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error("ADAPTIVE_PRODUCTION_TIMESTAMP_INVALID");
  return result;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function gapIdentity(gaps: Gap[]): string {
  return canonicalAdaptiveValue(gaps.map((gap) => ({
    gapId: gap.gapId,
    requirement: gap.requirement,
    admissibleEvidence: gap.admissibleEvidence,
    dependsOn: gap.dependsOn ?? [],
  })));
}

function assertUniqueGapIds(gaps: Gap[]): void {
  if (!Array.isArray(gaps) || gaps.length === 0) throw new Error("ADAPTIVE_PRODUCTION_GAPS_REQUIRED");
  const ids = gaps.map((gap) => gap.gapId);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("ADAPTIVE_PRODUCTION_GAP_IDENTITY_INVALID");
  }
}

export function assertAdaptiveProductionInvariants(state: AdaptiveProductionState): void {
  if (!state || state.schemaVersion !== 1 || state.mode !== "adaptive-v1") throw new Error("ADAPTIVE_PRODUCTION_STATE_INVALID");
  assertUniqueGapIds(state.gaps);
  const snapshot = state.invariantSnapshot;
  if (
    !verifyFrozenMissionContract(state.mission) ||
    state.runId !== snapshot.runId ||
    state.hostMissionHash !== snapshot.hostMissionHash ||
    state.reconstructedRun !== false ||
    state.approvalCount !== 1 || snapshot.initialApprovalCount !== 1 ||
    state.mission.canonicalBytes !== snapshot.missionCanonicalBytes ||
    state.mission.missionHash !== snapshot.missionHash ||
    canonicalAdaptiveValue(state.mission.contract.acceptanceCriteria) !== snapshot.acceptanceCriteriaBytes ||
    canonicalAdaptiveValue({
      safetyEnvelope: state.mission.contract.safetyEnvelope,
      protectedPathsAndPermissions: state.mission.contract.protectedPathsAndPermissions,
      resourceBudget: state.mission.contract.resourceBudget,
    }) !== snapshot.safetyScopeBytes ||
    gapIdentity(state.gaps) !== snapshot.gapIdentityBytes
  ) throw new Error("ADAPTIVE_PRODUCTION_PROTECTED_INVARIANT_DRIFT");
  if (state.strategyHistory.length === 0 || state.resourceUsage.strategiesUsed !== state.strategyHistory.length) {
    throw new Error("ADAPTIVE_PRODUCTION_STRATEGY_HISTORY_INVALID");
  }
  const ids = new Set(state.strategyHistory.map((strategy) => strategy.strategyId));
  if (!ids.has(state.activeStrategy.strategyId) || ids.size !== state.strategyHistory.length) {
    throw new Error("ADAPTIVE_PRODUCTION_ACTIVE_STRATEGY_INVALID");
  }
  for (const gap of state.gaps) {
    if (gap.status === "closed" && !state.strictAcceptance?.passed) {
      throw new Error("ADAPTIVE_PRODUCTION_GAP_CLOSED_BEFORE_STRICT_ACCEPTANCE");
    }
  }
}

export function createAdaptiveProductionState(input: AdaptiveProductionCreateInput): AdaptiveProductionState {
  if (!input.runId.trim() || !/^[a-f0-9]{64}$/.test(input.hostMissionHash) || input.approvalCount !== 1) {
    throw new Error("ADAPTIVE_PRODUCTION_IDENTITY_OR_APPROVAL_INVALID");
  }
  if (!verifyFrozenMissionContract(input.mission)) throw new Error("ADAPTIVE_PRODUCTION_MISSION_INVALID");
  assertUniqueGapIds(input.gaps);
  if (input.gaps.some((gap) => gap.status === "closed")) {
    throw new Error("ADAPTIVE_PRODUCTION_INITIAL_ACCEPTANCE_GAPS_MUST_BE_OPEN");
  }
  const validation = validateInitialStrategy(input.mission, input.gaps, input.initialStrategy);
  if (!validation.accepted) {
    throw new Error(`ADAPTIVE_PRODUCTION_INITIAL_STRATEGY_REJECTED: ${validation.reasons.map((reason) => reason.code).join(",")}`);
  }
  const gaps = structuredClone(input.gaps);
  const strategy = structuredClone(validation.strategy);
  const state: AdaptiveProductionState = {
    schemaVersion: 1,
    mode: "adaptive-v1",
    runId: input.runId,
    hostMissionHash: input.hostMissionHash,
    reconstructedRun: false,
    approvalCount: 1,
    mission: structuredClone(input.mission),
    invariantSnapshot: {
      runId: input.runId,
      hostMissionHash: input.hostMissionHash,
      missionCanonicalBytes: input.mission.canonicalBytes,
      missionHash: input.mission.missionHash,
      acceptanceCriteriaBytes: canonicalAdaptiveValue(input.mission.contract.acceptanceCriteria),
      safetyScopeBytes: canonicalAdaptiveValue({
        safetyEnvelope: input.mission.contract.safetyEnvelope,
        protectedPathsAndPermissions: input.mission.contract.protectedPathsAndPermissions,
        resourceBudget: input.mission.contract.resourceBudget,
      }),
      gapIdentityBytes: gapIdentity(gaps),
      initialApprovalCount: 1,
    },
    phase: "strategy_ready",
    gaps,
    activeStrategy: strategy,
    initialStrategyId: strategy.strategyId,
    strategyHistory: [structuredClone(strategy)],
    observations: [],
    exhaustedFamilies: [],
    resourceUsage: { attemptsUsed: 0, strategiesUsed: 1, resourceUnitsUsed: 0 },
    decisions: [],
    proposals: [],
    activations: [],
    executionReservations: [],
  };
  assertAdaptiveProductionInvariants(state);
  return state;
}

function pendingReservation(state: AdaptiveProductionState): AdaptiveProductionExecutionReservation {
  const reservation = [...state.executionReservations].reverse().find((candidate) => candidate.outcome === undefined);
  if (!reservation || reservation.strategyId !== state.activeStrategy.strategyId) {
    throw new Error("ADAPTIVE_PRODUCTION_RESERVATION_MISSING");
  }
  return reservation;
}

function reserveExecution(state: AdaptiveProductionState, reservedAt?: string): {
  state: AdaptiveProductionState;
  reservation: AdaptiveProductionExecutionReservation;
} {
  assertAdaptiveProductionInvariants(state);
  if (state.phase !== "strategy_ready" && state.phase !== "strategy_retry_ready" && state.phase !== "strategy_activated") {
    throw new Error("ADAPTIVE_PRODUCTION_EXECUTION_NOT_AUTHORIZED");
  }
  const next = structuredClone(state);
  const attempt = next.activeStrategy.attemptsUsed + 1;
  const units = next.activeStrategy.resourceBudget.resourceUnitsPerAttempt;
  const strategyBudget = next.activeStrategy.resourceBudget;
  const missionBudget = next.mission.contract.resourceBudget;
  if (
    attempt > strategyBudget.maxAttempts || attempt * units > strategyBudget.resourceUnits ||
    next.resourceUsage.attemptsUsed + 1 > missionBudget.maxTotalAttempts ||
    next.resourceUsage.resourceUnitsUsed + units > missionBudget.maxResourceUnits
  ) throw new Error("ADAPTIVE_PRODUCTION_RESOURCE_BUDGET_EXCEEDED");
  next.activeStrategy.attemptsUsed = attempt;
  const historical = next.strategyHistory.find((strategy) => strategy.strategyId === next.activeStrategy.strategyId);
  if (historical) historical.attemptsUsed = attempt;
  next.resourceUsage.attemptsUsed += 1;
  next.resourceUsage.resourceUnitsUsed += units;
  const reservation: AdaptiveProductionExecutionReservation = {
    reservationId: `${next.runId}:${next.activeStrategy.strategyId}:${attempt}`,
    strategyId: next.activeStrategy.strategyId,
    strategyFamily: next.activeStrategy.strategyFamily,
    attempt,
    resourceUnits: units,
    reservedAt: nowIso(reservedAt),
  };
  next.executionReservations.push(reservation);
  next.phase = "strategy_executing";
  assertAdaptiveProductionInvariants(next);
  return { state: next, reservation: structuredClone(reservation) };
}

function recordFailure(state: AdaptiveProductionState, observation: FailureObservation): AdaptiveProductionState {
  assertAdaptiveProductionInvariants(state);
  if (state.phase !== "strategy_executing") throw new Error("ADAPTIVE_PRODUCTION_FAILURE_OUT_OF_PHASE");
  if (
    observation.strategyId !== state.activeStrategy.strategyId ||
    compact(observation.strategyFamily) !== compact(state.activeStrategy.strategyFamily) ||
    !observation.normalizedFailureSignature.trim()
  ) throw new Error("ADAPTIVE_PRODUCTION_FAILURE_CLASSIFICATION_INVALID");
  const next = structuredClone(state);
  const reservation = pendingReservation(next);
  reservation.outcome = "failure";
  reservation.failureSignature = compact(observation.normalizedFailureSignature);
  next.observations.push(structuredClone(observation));
  const decision = decideSupervisorAction({
    mission: next.mission,
    gaps: next.gaps,
    currentStrategy: next.activeStrategy,
    observations: next.observations,
    resourceUsage: next.resourceUsage,
  });
  next.decisions.push(decision);
  if (decision.kind === "REPLAN") {
    next.phase = "strategy_exhausted";
    if (!next.exhaustedFamilies.some((family) => compact(family) === compact(next.activeStrategy.strategyFamily))) {
      next.exhaustedFamilies.push(next.activeStrategy.strategyFamily);
    }
  } else if (decision.kind === "CONTINUE" && next.activeStrategy.attemptsUsed < next.activeStrategy.resourceBudget.maxAttempts) {
    next.phase = "strategy_retry_ready";
  } else {
    next.phase = "failed";
    next.failure = {
      code: `ADAPTIVE_PRODUCTION_${decision.kind}`,
      message: decision.reason,
      observedAt: nowIso(),
    };
  }
  assertAdaptiveProductionInvariants(next);
  return next;
}

function recordProposal(
  state: AdaptiveProductionState,
  modelProposal: StrategyProposal,
  hostMaterialProfile: StrategyMaterialProfile,
  proposedAt?: string,
): AdaptiveProductionState {
  assertAdaptiveProductionInvariants(state);
  if (state.phase !== "strategy_exhausted") throw new Error("ADAPTIVE_PRODUCTION_PROPOSAL_OUT_OF_PHASE");
  const next = structuredClone(state);
  const validatedProposal: StrategyProposal = {
    ...structuredClone(modelProposal),
    strategy: {
      ...structuredClone(modelProposal.strategy),
      materialProfile: structuredClone(hostMaterialProfile),
    },
  };
  const validation = validateStrategyProposal(
    next.mission,
    next.gaps,
    next.activeStrategy,
    validatedProposal,
    next.resourceUsage,
    next.exhaustedFamilies,
  );
  next.proposals.push({
    proposedAt: nowIso(proposedAt),
    modelProposal: structuredClone(modelProposal),
    hostMaterialProfile: structuredClone(hostMaterialProfile),
    validatedProposal,
    validation: structuredClone(validation),
  });
  if (validation.accepted) next.phase = "strategy_proposed";
  assertAdaptiveProductionInvariants(next);
  return next;
}

function activateReplacement(state: AdaptiveProductionState, activatedAt?: string): AdaptiveProductionState {
  assertAdaptiveProductionInvariants(state);
  if (state.phase !== "strategy_proposed") throw new Error("ADAPTIVE_PRODUCTION_ACTIVATION_OUT_OF_PHASE");
  const proposal = state.proposals.at(-1);
  if (!proposal?.validation.accepted) throw new Error("ADAPTIVE_PRODUCTION_PROPOSAL_NOT_ACCEPTED");
  const next = structuredClone(state);
  const accepted = next.proposals.at(-1)!.validation;
  if (!accepted.accepted) throw new Error("ADAPTIVE_PRODUCTION_PROPOSAL_NOT_ACCEPTED");
  next.activeStrategy = structuredClone(accepted.strategy);
  next.strategyHistory.push(structuredClone(accepted.strategy));
  next.resourceUsage.strategiesUsed += 1;
  next.phase = "strategy_activated";
  next.activations.push({
    strategyId: accepted.strategy.strategyId,
    strategyFamily: accepted.strategy.strategyFamily,
    activatedAt: nowIso(activatedAt),
    durableBeforeDispatch: true,
  });
  assertAdaptiveProductionInvariants(next);
  return next;
}

function recordSuccess(state: AdaptiveProductionState, evidenceRef: string): AdaptiveProductionState {
  assertAdaptiveProductionInvariants(state);
  if (state.phase !== "strategy_executing" || !evidenceRef.trim()) {
    throw new Error("ADAPTIVE_PRODUCTION_SUCCESS_OUT_OF_PHASE_OR_MISSING_EVIDENCE");
  }
  const next = structuredClone(state);
  const reservation = pendingReservation(next);
  reservation.outcome = "success";
  reservation.evidenceRef = evidenceRef.trim();
  for (const gapId of next.activeStrategy.whichGapIds) {
    const gap = next.gaps.find((candidate) => candidate.gapId === gapId);
    if (!gap || !gap.admissibleEvidence.includes("executor-progress")) {
      throw new Error(`ADAPTIVE_PRODUCTION_EXECUTOR_EVIDENCE_INADMISSIBLE: ${gapId}`);
    }
    next.gaps = applyGapEvidence(next.gaps, {
      evidenceRef: `${evidenceRef.trim()}:${gapId}`,
      evidenceKind: "executor-progress",
      gapId,
      effect: "strengthen",
      acceptanceEligible: false,
    });
  }
  next.phase = "acceptance_evaluation";
  assertAdaptiveProductionInvariants(next);
  return next;
}

function completeStrictAcceptance(
  state: AdaptiveProductionState,
  satisfiedGapIds: string[],
  satisfiedCriteria: string[],
  evaluatedAt?: string,
): AdaptiveProductionState {
  assertAdaptiveProductionInvariants(state);
  if (state.phase !== "acceptance_evaluation") throw new Error("ADAPTIVE_PRODUCTION_ACCEPTANCE_OUT_OF_PHASE");
  const requiredGapIds = state.gaps.map((gap) => gap.gapId);
  if (canonicalAdaptiveValue([...satisfiedGapIds].sort()) !== canonicalAdaptiveValue([...requiredGapIds].sort())) {
    throw new Error("ADAPTIVE_PRODUCTION_STRICT_GAP_MISMATCH");
  }
  if (canonicalAdaptiveValue(satisfiedCriteria) !== canonicalAdaptiveValue(state.mission.contract.acceptanceCriteria)) {
    throw new Error("ADAPTIVE_PRODUCTION_STRICT_ACCEPTANCE_MISMATCH");
  }
  const next = structuredClone(state);
  for (const gapId of requiredGapIds) {
    next.gaps = applyGapEvidence(next.gaps, {
      evidenceRef: `strict-verifier:${gapId}`,
      evidenceKind: "criterion-verification",
      gapId,
      effect: "close",
      acceptanceEligible: true,
    });
  }
  next.strictAcceptance = {
    passed: true,
    satisfiedGapIds: [...satisfiedGapIds],
    satisfiedCriteria: [...satisfiedCriteria],
    evaluatedAt: nowIso(evaluatedAt),
  };
  next.phase = "completed";
  assertAdaptiveProductionInvariants(next);
  return next;
}

function failState(state: AdaptiveProductionState, code: string, message: string): AdaptiveProductionState {
  assertAdaptiveProductionInvariants(state);
  const next = structuredClone(state);
  next.phase = "failed";
  next.failure = { code, message, observedAt: nowIso() };
  assertAdaptiveProductionInvariants(next);
  return next;
}

function atomicWrite(file: string, value: unknown): void {
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

function appendDurably(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, "a");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export class AdaptiveProductionStore {
  readonly runId: string;
  readonly stateFile: string;
  readonly eventsFile: string;

  constructor(stateRoot: string, runId: string) {
    if (!stateRoot.trim() || !runId.trim() || /[\\/]/.test(runId)) throw new Error("ADAPTIVE_PRODUCTION_STORE_IDENTITY_INVALID");
    this.runId = runId;
    const directory = path.join(path.resolve(stateRoot), runId);
    this.stateFile = path.join(directory, "adaptive-v1.json");
    this.eventsFile = path.join(directory, "adaptive-v1.events.jsonl");
  }

  exists(): boolean {
    return fs.existsSync(this.stateFile);
  }

  create(input: AdaptiveProductionCreateInput): AdaptiveProductionState {
    if (input.runId !== this.runId || this.exists() || fs.existsSync(this.eventsFile)) {
      throw new Error("ADAPTIVE_PRODUCTION_ALREADY_EXISTS_OR_RUN_MISMATCH");
    }
    const state = createAdaptiveProductionState(input);
    this.persist(state, "created");
    return structuredClone(state);
  }

  load(): AdaptiveProductionState {
    if (!this.exists()) throw new Error("ADAPTIVE_PRODUCTION_STATE_MISSING");
    const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as AdaptiveProductionState;
    assertAdaptiveProductionInvariants(state);
    if (state.runId !== this.runId) throw new Error("ADAPTIVE_PRODUCTION_RUN_ID_MISMATCH");
    return state;
  }

  private persist(state: AdaptiveProductionState, kind: AdaptiveProductionEventKind): void {
    assertAdaptiveProductionInvariants(state);
    atomicWrite(this.stateFile, state);
    const existing = this.readEvents();
    const sequence = existing.length + 1;
    const previousEventHash = existing.at(-1)?.eventHash ?? null;
    const core = {
      schemaVersion: 1 as const,
      sequence,
      previousEventHash,
      kind,
      runId: state.runId,
      hostMissionHash: state.hostMissionHash,
      missionHash: state.mission.missionHash,
      phase: state.phase,
      stateHash: sha256(canonicalAdaptiveValue(state)),
      createdAt: nowIso(),
    };
    const event: AdaptiveProductionEvent = {
      ...core,
      eventHash: sha256(canonicalAdaptiveValue(core)),
    };
    appendDurably(this.eventsFile, event);
    const reloaded = this.load();
    if (sha256(canonicalAdaptiveValue(reloaded)) !== core.stateHash) throw new Error("ADAPTIVE_PRODUCTION_DURABILITY_FAILURE");
    this.readEvents();
  }

  beginExecution(): AdaptiveProductionDispatchPermit {
    const before = this.load();
    const replacement = before.activeStrategy.strategyId !== before.initialStrategyId;
    const durableReplacementActivation = !replacement || (
      before.phase === "strategy_activated" &&
      before.activations.some((activation) => activation.strategyId === before.activeStrategy.strategyId && activation.durableBeforeDispatch)
    );
    if (!durableReplacementActivation) throw new Error("ADAPTIVE_PRODUCTION_REPLACEMENT_NOT_DURABLY_ACTIVATED");
    const reserved = reserveExecution(before);
    this.persist(reserved.state, "execution_reserved");
    return {
      runId: reserved.state.runId,
      hostMissionHash: reserved.state.hostMissionHash,
      missionHash: reserved.state.mission.missionHash,
      strategy: structuredClone(reserved.state.activeStrategy),
      reservation: structuredClone(reserved.reservation),
      durableReplacementActivation,
    };
  }

  recordFailure(observation: FailureObservation): AdaptiveProductionState {
    const state = recordFailure(this.load(), observation);
    this.persist(state, "failure_recorded");
    return structuredClone(state);
  }

  recordProposal(modelProposal: StrategyProposal, hostMaterialProfile: StrategyMaterialProfile): AdaptiveProductionState {
    const state = recordProposal(this.load(), modelProposal, hostMaterialProfile);
    this.persist(state, "proposal_recorded");
    return structuredClone(state);
  }

  activateReplacement(): AdaptiveProductionState {
    const state = activateReplacement(this.load());
    this.persist(state, "replacement_activated");
    return structuredClone(state);
  }

  recordSuccess(evidenceRef: string): AdaptiveProductionState {
    const state = recordSuccess(this.load(), evidenceRef);
    this.persist(state, "success_recorded");
    return structuredClone(state);
  }

  completeStrictAcceptance(satisfiedGapIds: string[], satisfiedCriteria: string[]): AdaptiveProductionState {
    const state = completeStrictAcceptance(this.load(), satisfiedGapIds, satisfiedCriteria);
    this.persist(state, "strict_acceptance_completed");
    return structuredClone(state);
  }

  fail(code: string, message: string): AdaptiveProductionState {
    const state = failState(this.load(), code, message);
    this.persist(state, "failed");
    return structuredClone(state);
  }

  readEvents(): AdaptiveProductionEvent[] {
    if (!fs.existsSync(this.eventsFile)) return [];
    const events = fs.readFileSync(this.eventsFile, "utf8").split(/\r?\n/).filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AdaptiveProductionEvent);
    let previous: string | null = null;
    events.forEach((event, index) => {
      const core = {
        schemaVersion: event.schemaVersion,
        sequence: event.sequence,
        previousEventHash: event.previousEventHash,
        kind: event.kind,
        runId: event.runId,
        hostMissionHash: event.hostMissionHash,
        missionHash: event.missionHash,
        phase: event.phase,
        stateHash: event.stateHash,
        createdAt: event.createdAt,
      };
      if (
        event.schemaVersion !== 1 || event.sequence !== index + 1 || event.previousEventHash !== previous ||
        event.runId !== this.runId || !/^[a-f0-9]{64}$/.test(event.hostMissionHash) ||
        !/^[a-f0-9]{64}$/.test(event.missionHash) || !/^[a-f0-9]{64}$/.test(event.stateHash) ||
        event.eventHash !== sha256(canonicalAdaptiveValue(core))
      ) throw new Error("ADAPTIVE_PRODUCTION_EVENT_LOG_INTEGRITY_FAILURE");
      previous = event.eventHash;
    });
    return events;
  }
}
