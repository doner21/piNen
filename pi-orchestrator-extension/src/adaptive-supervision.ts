import crypto from "node:crypto";

export type GapStatus = "open" | "strengthened" | "closed" | "blocked";
export type AdaptiveSupervisorDecisionKind = "CONTINUE" | "REPLAN" | "DETOUR" | "ESCALATE";

export interface MissionResourceBudget {
  maxTotalAttempts: number;
  maxAttemptsPerStrategy: number;
  maxStrategies: number;
  maxResourceUnits: number;
}

export interface MissionContract {
  missionId: string;
  requiredOutcomes: string[];
  acceptanceCriteria: string[];
  strategicInvariants: string[];
  nonGoals: string[];
  safetyEnvelope: {
    allowedOperations: string[];
    forbiddenOperations: string[];
  };
  protectedPathsAndPermissions: {
    protectedPaths: string[];
    allowedMutationPaths: string[];
    grantedPermissions: string[];
  };
  resourceBudget: MissionResourceBudget;
  finalEnvironmentRequirements: string[];
}

export interface FrozenMissionContract {
  contract: MissionContract;
  canonicalBytes: string;
  missionHash: string;
}

export interface Gap {
  gapId: string;
  requirement: string;
  status: GapStatus;
  admissibleEvidence: string[];
  dependsOn?: string[];
  evidenceRefs: string[];
}

export interface StrategyResourceBudget {
  maxAttempts: number;
  resourceUnits: number;
  /** Host-reserved before each execution; callbacks cannot self-report a larger charge afterward. */
  resourceUnitsPerAttempt: number;
}

export type StrategyMaterialDimension =
  | "hypothesis"
  | "mechanism"
  | "decomposition"
  | "environment"
  | "instrumentation"
  | "worker"
  | "taskScope"
  | "route";

/** Host/fixture-classified stable ids, never free-form method prose. */
export type StrategyMaterialProfile = Partial<Record<StrategyMaterialDimension, string>>;

export interface CurrentStrategy {
  strategyId: string;
  strategyFamily: string;
  whichGapIds: string[];
  currentBeliefOrHypothesis: string;
  method: string;
  materialProfile: StrategyMaterialProfile;
  expectedEvidence: string[];
  abandonmentCondition: string;
  attemptsUsed: number;
  resourceBudget: StrategyResourceBudget;
  operations: string[];
  requiredPermissions: string[];
  mutationPaths: string[];
}

/**
 * Model output is intentionally unable to replace the Mission Contract. The
 * optional override field exists only so an attempted acceptance substitution
 * can be rejected with a stable reason instead of being silently ignored.
 */
export interface StrategyProposal {
  preservedMissionHash: string;
  strategy: CurrentStrategy;
  acceptanceCriteriaOverride?: string[];
}

export interface FailureObservation {
  strategyId: string;
  strategyFamily: string;
  normalizedFailureSignature: string;
  newEvidenceFlag: boolean;
  evidenceRefs: string[];
}

export type GapEvidenceEffect = "close" | "strengthen" | "reduce_uncertainty" | "falsify_hypothesis" | "activity";

export interface GapEvidence {
  evidenceRef: string;
  evidenceKind: string;
  gapId: string;
  effect: GapEvidenceEffect;
  acceptanceEligible: boolean;
  hypothesis?: string;
}

export interface SemanticProgressObservation {
  usefulProgress: boolean;
  closedGapIds: string[];
  strengthenedGapIds: string[];
  uncertaintyReducedGapIds: string[];
  falsifiedHypotheses: string[];
  reason: "gap_progress" | "uncertainty_reduced" | "hypothesis_falsified" | "no_semantic_progress";
}

export interface AdaptiveResourceUsage {
  attemptsUsed: number;
  strategiesUsed: number;
  resourceUnitsUsed: number;
}

export type StrategyProposalRejectionCode =
  | "INVALID_MISSION_AUTHORITY"
  | "MISSION_HASH_CHANGED"
  | "ACCEPTANCE_OVERRIDE_FORBIDDEN"
  | "INVALID_STRATEGY"
  | "MISSING_TARGET_GAP"
  | "TARGET_GAP_ALREADY_CLOSED"
  | "STRATEGY_FAMILY_EXHAUSTED"
  | "NOT_MATERIALLY_DIFFERENT"
  | "SAFETY_ENVELOPE_VIOLATION"
  | "PERMISSION_OUTSIDE_ENVELOPE"
  | "MUTATION_SCOPE_OUTSIDE_ENVELOPE"
  | "RESOURCE_BUDGET_EXCEEDED"
  | "MISSING_EXPECTED_EVIDENCE"
  | "EXPECTED_EVIDENCE_INADMISSIBLE"
  | "MISSING_ABANDONMENT_CONDITION";

export interface StrategyProposalRejection {
  code: StrategyProposalRejectionCode;
  message: string;
}

export type StrategyProposalValidation =
  | { accepted: true; strategy: CurrentStrategy; humanApprovalRequired: false }
  | { accepted: false; reasons: StrategyProposalRejection[] };

export type AdaptiveSupervisorDecision =
  | { kind: "CONTINUE"; reason: string }
  | { kind: "REPLAN"; reason: string; exhaustedStrategyFamily: string }
  | { kind: "DETOUR"; reason: string; returnTarget: string }
  | { kind: "ESCALATE"; reason: string };

export interface DiagnosticDetour {
  questionOrHypothesis: string;
  targetGap: string;
  resourceBudget: StrategyResourceBudget;
  expectedEvidence: string[];
  exitCondition: string;
  returnTarget: string;
  acceptanceEligible: false;
}

export interface AdaptiveSupervisorState {
  mission: FrozenMissionContract;
  gaps: Gap[];
  currentStrategy?: CurrentStrategy;
  observations: FailureObservation[];
  resourceUsage: AdaptiveResourceUsage;
  boundaryViolation?: string;
  specificBlockingUncertainty?: DiagnosticDetour;
  noLegalStrategyRemains?: boolean;
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

/** Stable JSON used by durable adaptive-supervision records and invariant snapshots. */
export function canonicalAdaptiveValue(value: unknown): string {
  return canonicalValue(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueNonEmpty(values: unknown): values is string[] {
  return Array.isArray(values) && values.every(nonEmpty) && new Set(values).size === values.length;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validateMissionContractShape(contract: MissionContract): void {
  if (!contract || typeof contract !== "object" || !nonEmpty(contract.missionId)) throw new Error("Mission Contract requires a non-empty missionId.");
  for (const [label, values] of [
    ["requiredOutcomes", contract.requiredOutcomes],
    ["acceptanceCriteria", contract.acceptanceCriteria],
    ["strategicInvariants", contract.strategicInvariants],
    ["nonGoals", contract.nonGoals],
    ["finalEnvironmentRequirements", contract.finalEnvironmentRequirements],
  ] as const) {
    if (!uniqueNonEmpty(values)) throw new Error(`Mission Contract ${label} must contain unique non-empty strings.`);
  }
  if (contract.requiredOutcomes.length === 0 || contract.acceptanceCriteria.length === 0) {
    throw new Error("Mission Contract requires outcomes and acceptance criteria.");
  }
  if (
    !contract.safetyEnvelope || !uniqueNonEmpty(contract.safetyEnvelope.allowedOperations) ||
    !uniqueNonEmpty(contract.safetyEnvelope.forbiddenOperations)
  ) throw new Error("Mission Contract safety envelope is invalid.");
  if (contract.safetyEnvelope.allowedOperations.some((operation) => contract.safetyEnvelope.forbiddenOperations.includes(operation))) {
    throw new Error("Mission Contract cannot both allow and forbid an operation.");
  }
  const boundaries = contract.protectedPathsAndPermissions;
  if (
    !boundaries || !uniqueNonEmpty(boundaries.protectedPaths) ||
    !uniqueNonEmpty(boundaries.allowedMutationPaths) || !uniqueNonEmpty(boundaries.grantedPermissions)
  ) throw new Error("Mission Contract path or permission boundary is invalid.");
  const budget = contract.resourceBudget;
  if (
    !budget || !positiveInteger(budget.maxTotalAttempts) || !positiveInteger(budget.maxAttemptsPerStrategy) ||
    !positiveInteger(budget.maxStrategies) || !nonNegativeInteger(budget.maxResourceUnits) ||
    budget.maxAttemptsPerStrategy > budget.maxTotalAttempts
  ) throw new Error("Mission Contract resource budget is invalid.");
}

export function canonicalMissionContract(contract: MissionContract): string {
  validateMissionContractShape(contract);
  return canonicalValue(contract);
}

export function hashMissionContract(contract: MissionContract): string {
  return crypto.createHash("sha256").update(canonicalMissionContract(contract), "utf8").digest("hex");
}

export function createFrozenMissionContract(contract: MissionContract): FrozenMissionContract {
  const detached = structuredClone(contract);
  const canonicalBytes = canonicalMissionContract(detached);
  const missionHash = crypto.createHash("sha256").update(canonicalBytes, "utf8").digest("hex");
  return deepFreeze({ contract: detached, canonicalBytes, missionHash });
}

export function verifyFrozenMissionContract(mission: FrozenMissionContract): boolean {
  try {
    return Boolean(
      mission && /^[a-f0-9]{64}$/.test(mission.missionHash) &&
      mission.canonicalBytes === canonicalMissionContract(mission.contract) &&
      mission.missionHash === crypto.createHash("sha256").update(mission.canonicalBytes, "utf8").digest("hex"),
    );
  } catch {
    return false;
  }
}

function validateGapLedger(gaps: Gap[]): void {
  if (!Array.isArray(gaps)) throw new Error("Gap ledger must be an array.");
  const ids = new Set<string>();
  for (const gap of gaps) {
    if (!gap || !nonEmpty(gap.gapId) || ids.has(gap.gapId)) throw new Error("Gap ids must be unique non-empty strings.");
    ids.add(gap.gapId);
    if (!nonEmpty(gap.requirement) || !new Set<GapStatus>(["open", "strengthened", "closed", "blocked"]).has(gap.status)) {
      throw new Error(`Gap ${gap.gapId} is invalid.`);
    }
    if (!uniqueNonEmpty(gap.admissibleEvidence) || !uniqueNonEmpty(gap.evidenceRefs)) throw new Error(`Gap ${gap.gapId} evidence is invalid.`);
    if (gap.dependsOn !== undefined && !uniqueNonEmpty(gap.dependsOn)) throw new Error(`Gap ${gap.gapId} dependencies are invalid.`);
  }
  for (const gap of gaps) {
    for (const dependency of gap.dependsOn ?? []) if (!ids.has(dependency) || dependency === gap.gapId) throw new Error(`Gap ${gap.gapId} has an invalid dependency.`);
  }
}

const GAP_EVIDENCE_EFFECTS: ReadonlySet<GapEvidenceEffect> = new Set([
  "close", "strengthen", "reduce_uncertainty", "falsify_hypothesis", "activity",
]);

function validateGapEvidenceAgainstLedger(gaps: Gap[], evidence: GapEvidence, requireRecorded: boolean): Gap {
  if (
    !evidence || !nonEmpty(evidence.evidenceRef) || !nonEmpty(evidence.evidenceKind) || !nonEmpty(evidence.gapId) ||
    !GAP_EVIDENCE_EFFECTS.has(evidence.effect) || typeof evidence.acceptanceEligible !== "boolean"
  ) throw new Error("Gap evidence is invalid.");
  const gap = gaps.find((candidate) => candidate.gapId === evidence.gapId);
  if (!gap) throw new Error(`Unknown gap ${evidence.gapId}.`);
  if (evidence.effect !== "activity" && !gap.admissibleEvidence.includes(evidence.evidenceKind)) {
    throw new Error(`INADMISSIBLE_EVIDENCE_FOR_GAP: ${evidence.evidenceKind} cannot advance ${gap.gapId}.`);
  }
  if (evidence.effect === "falsify_hypothesis" && !nonEmpty(evidence.hypothesis)) {
    throw new Error("Hypothesis-falsification evidence requires a hypothesis.");
  }
  if (requireRecorded && evidence.effect !== "activity" && !gap.evidenceRefs.includes(evidence.evidenceRef)) {
    throw new Error(`UNRECORDED_SEMANTIC_EVIDENCE: ${evidence.evidenceRef}.`);
  }
  return gap;
}

export function observeSemanticProgress(beforeGaps: Gap[], evidence: GapEvidence[], afterGaps: Gap[]): SemanticProgressObservation {
  validateGapLedger(beforeGaps);
  validateGapLedger(afterGaps);
  const before = new Map(beforeGaps.map((gap) => [gap.gapId, gap]));
  const after = new Map(afterGaps.map((gap) => [gap.gapId, gap]));
  if (before.size !== after.size || [...before.keys()].some((gapId) => !after.has(gapId))) {
    throw new Error("Semantic progress comparison requires the same gap identities.");
  }
  for (const item of evidence) validateGapEvidenceAgainstLedger(afterGaps, item, true);
  const closedGapIds: string[] = [];
  const strengthenedGapIds: string[] = [];
  for (const [gapId, previous] of before) {
    const next = after.get(gapId)!;
    if (previous.status !== "closed" && next.status === "closed") closedGapIds.push(gapId);
    if (previous.status === "open" && next.status === "strengthened") strengthenedGapIds.push(gapId);
    if (previous.status === "closed" && next.status !== "closed") throw new Error(`Closed gap ${gapId} cannot regress.`);
  }
  const uncertaintyReducedGapIds = [...new Set(evidence.filter((item) => item.effect === "reduce_uncertainty").map((item) => item.gapId))];
  const falsifiedHypotheses = [...new Set(evidence.filter((item) => item.effect === "falsify_hypothesis").map((item) => item.hypothesis!))];
  const usefulProgress = closedGapIds.length > 0 || strengthenedGapIds.length > 0 || uncertaintyReducedGapIds.length > 0 || falsifiedHypotheses.length > 0;
  const reason: SemanticProgressObservation["reason"] = closedGapIds.length || strengthenedGapIds.length
    ? "gap_progress"
    : uncertaintyReducedGapIds.length
      ? "uncertainty_reduced"
      : falsifiedHypotheses.length
        ? "hypothesis_falsified"
        : "no_semantic_progress";
  return { usefulProgress, closedGapIds, strengthenedGapIds, uncertaintyReducedGapIds, falsifiedHypotheses, reason };
}

export function applyGapEvidence(gaps: Gap[], evidence: GapEvidence): Gap[] {
  validateGapLedger(gaps);
  const source = validateGapEvidenceAgainstLedger(gaps, evidence, false);
  if (evidence.effect === "close" && !evidence.acceptanceEligible) {
    throw new Error("NON_ACCEPTANCE_EVIDENCE_CANNOT_CLOSE_GAP");
  }
  const next = structuredClone(gaps);
  const target = next.find((gap) => gap.gapId === source.gapId)!;
  if (evidence.effect !== "activity" && !target.evidenceRefs.includes(evidence.evidenceRef)) target.evidenceRefs.push(evidence.evidenceRef);
  if (evidence.effect === "close") target.status = "closed";
  else if (evidence.effect === "strengthen" && target.status === "open") target.status = "strengthened";
  validateGapLedger(next);
  return next;
}

export function isEquivalentFailure(previous: FailureObservation, current: FailureObservation): boolean {
  return Boolean(
    previous && current &&
    compactText(previous.strategyFamily) === compactText(current.strategyFamily) &&
    compactText(previous.normalizedFailureSignature) === compactText(current.normalizedFailureSignature),
  );
}

export function isStrategyExhausted(strategy: CurrentStrategy, observations: FailureObservation[]): boolean {
  const seenSignatures = new Set<string>();
  for (const observation of observations) {
    if (compactText(observation.strategyFamily) !== compactText(strategy.strategyFamily)) continue;
    const signature = compactText(observation.normalizedFailureSignature);
    if (seenSignatures.has(signature) && observation.newEvidenceFlag === false) return true;
    seenSignatures.add(signature);
  }
  return false;
}

const STRATEGY_MATERIAL_DIMENSIONS: ReadonlySet<string> = new Set([
  "hypothesis", "mechanism", "decomposition", "environment", "instrumentation", "worker", "taskScope", "route",
]);

function validMaterialProfile(value: unknown): value is StrategyMaterialProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(([key, item]) => STRATEGY_MATERIAL_DIMENSIONS.has(key) && nonEmpty(item));
}

function validStrategyShape(strategy: CurrentStrategy): boolean {
  return Boolean(
    strategy && nonEmpty(strategy.strategyId) && nonEmpty(strategy.strategyFamily) && uniqueNonEmpty(strategy.whichGapIds) &&
    strategy.whichGapIds.length > 0 && nonEmpty(strategy.currentBeliefOrHypothesis) && nonEmpty(strategy.method) &&
    validMaterialProfile(strategy.materialProfile) && uniqueNonEmpty(strategy.expectedEvidence) &&
    typeof strategy.abandonmentCondition === "string" && nonNegativeInteger(strategy.attemptsUsed) &&
    strategy.resourceBudget && positiveInteger(strategy.resourceBudget.maxAttempts) && nonNegativeInteger(strategy.resourceBudget.resourceUnits) &&
    nonNegativeInteger(strategy.resourceBudget.resourceUnitsPerAttempt) &&
    strategy.resourceBudget.resourceUnitsPerAttempt * strategy.resourceBudget.maxAttempts <= strategy.resourceBudget.resourceUnits &&
    uniqueNonEmpty(strategy.operations) && uniqueNonEmpty(strategy.requiredPermissions) && uniqueNonEmpty(strategy.mutationPaths),
  );
}

function materiallyDifferent(left: CurrentStrategy, right: CurrentStrategy): boolean {
  const keys = new Set([...Object.keys(left.materialProfile), ...Object.keys(right.materialProfile)]);
  return [...keys].some((key) => compactText(String(left.materialProfile[key as StrategyMaterialDimension] ?? "")) !==
    compactText(String(right.materialProfile[key as StrategyMaterialDimension] ?? "")));
}

function portableRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function pathWithin(candidate: string, scope: string): boolean {
  const normalizedCandidate = portableRelativePath(candidate)?.toLowerCase();
  const normalizedScope = portableRelativePath(scope)?.toLowerCase();
  if (!normalizedCandidate || !normalizedScope) return false;
  if (normalizedScope === "*") return true;
  return normalizedCandidate === normalizedScope || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function addReason(reasons: StrategyProposalRejection[], code: StrategyProposalRejectionCode, message: string): void {
  if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, message });
}

function validateStrategyEnvelope(
  mission: FrozenMissionContract,
  gaps: Gap[],
  strategy: CurrentStrategy,
  usage: AdaptiveResourceUsage,
): StrategyProposalRejection[] {
  const reasons: StrategyProposalRejection[] = [];
  if (!validStrategyShape(strategy)) {
    addReason(reasons, "INVALID_STRATEGY", "Strategy is missing required bounded fields or a host-classified material profile.");
    return reasons;
  }
  if (strategy.expectedEvidence.length === 0) addReason(reasons, "MISSING_EXPECTED_EVIDENCE", "Strategy must state expected evidence.");
  if (!strategy.abandonmentCondition.trim()) addReason(reasons, "MISSING_ABANDONMENT_CONDITION", "Strategy must state an abandonment condition.");
  const gapById = new Map(gaps.map((gap) => [gap.gapId, gap]));
  const targetGaps: Gap[] = [];
  for (const gapId of strategy.whichGapIds) {
    const gap = gapById.get(gapId);
    if (!gap) addReason(reasons, "MISSING_TARGET_GAP", `Strategy targets unknown gap ${gapId}.`);
    else if (gap.status === "closed") addReason(reasons, "TARGET_GAP_ALREADY_CLOSED", `Strategy targets already-closed gap ${gapId}.`);
    else targetGaps.push(gap);
  }
  if (
    strategy.expectedEvidence.some((kind) => !targetGaps.some((gap) => gap.admissibleEvidence.includes(kind))) ||
    targetGaps.some((gap) => !strategy.expectedEvidence.some((kind) => gap.admissibleEvidence.includes(kind)))
  ) addReason(reasons, "EXPECTED_EVIDENCE_INADMISSIBLE", "Expected evidence is not admissible for every targeted unresolved gap.");
  const contract = mission.contract;
  for (const operation of strategy.operations) {
    if (!contract.safetyEnvelope.allowedOperations.includes(operation) || contract.safetyEnvelope.forbiddenOperations.includes(operation)) {
      addReason(reasons, "SAFETY_ENVELOPE_VIOLATION", `Operation ${operation} is outside the safety envelope.`);
    }
  }
  for (const permission of strategy.requiredPermissions) {
    if (!contract.protectedPathsAndPermissions.grantedPermissions.includes(permission)) {
      addReason(reasons, "PERMISSION_OUTSIDE_ENVELOPE", `Permission ${permission} was not granted by the Mission Contract.`);
    }
  }
  for (const mutationPath of strategy.mutationPaths) {
    const validPath = portableRelativePath(mutationPath);
    const protectedPath = contract.protectedPathsAndPermissions.protectedPaths.some((scope) => pathWithin(mutationPath, scope));
    const allowedPath = contract.protectedPathsAndPermissions.allowedMutationPaths.some((scope) => pathWithin(mutationPath, scope));
    if (!validPath || protectedPath || !allowedPath) {
      addReason(reasons, "MUTATION_SCOPE_OUTSIDE_ENVELOPE", `Mutation path ${mutationPath} is outside the Mission Contract scope.`);
    }
  }
  const budget = contract.resourceBudget;
  if (
    !nonNegativeInteger(usage.attemptsUsed) || !nonNegativeInteger(usage.strategiesUsed) || !nonNegativeInteger(usage.resourceUnitsUsed) ||
    strategy.attemptsUsed !== 0 || strategy.resourceBudget.maxAttempts > budget.maxAttemptsPerStrategy ||
    usage.attemptsUsed + strategy.resourceBudget.maxAttempts > budget.maxTotalAttempts ||
    usage.strategiesUsed + 1 > budget.maxStrategies ||
    usage.resourceUnitsUsed + strategy.resourceBudget.resourceUnits > budget.maxResourceUnits
  ) addReason(reasons, "RESOURCE_BUDGET_EXCEEDED", "Strategy exceeds the immutable mission resource budget.");
  return reasons;
}

export function validateInitialStrategy(
  mission: FrozenMissionContract,
  gaps: Gap[],
  strategy: CurrentStrategy,
  usage: AdaptiveResourceUsage = { attemptsUsed: 0, strategiesUsed: 0, resourceUnitsUsed: 0 },
): StrategyProposalValidation {
  if (!verifyFrozenMissionContract(mission)) {
    return { accepted: false, reasons: [{ code: "INVALID_MISSION_AUTHORITY", message: "Frozen Mission Contract authority is invalid." }] };
  }
  validateGapLedger(gaps);
  const reasons = validateStrategyEnvelope(mission, gaps, strategy, usage);
  return reasons.length
    ? { accepted: false, reasons }
    : { accepted: true, strategy: structuredClone(strategy), humanApprovalRequired: false };
}

export function validateStrategyProposal(
  mission: FrozenMissionContract,
  gaps: Gap[],
  exhaustedStrategy: CurrentStrategy,
  proposal: StrategyProposal,
  usage: AdaptiveResourceUsage,
  exhaustedFamilies: readonly string[] = [exhaustedStrategy.strategyFamily],
): StrategyProposalValidation {
  const reasons: StrategyProposalRejection[] = [];
  if (!verifyFrozenMissionContract(mission)) {
    addReason(reasons, "INVALID_MISSION_AUTHORITY", "Frozen Mission Contract authority is invalid.");
    return { accepted: false, reasons };
  }
  if (!proposal || proposal.preservedMissionHash !== mission.missionHash) addReason(reasons, "MISSION_HASH_CHANGED", "Strategy proposal does not preserve the Mission Contract hash.");
  if (proposal && proposal.acceptanceCriteriaOverride !== undefined) {
    addReason(reasons, "ACCEPTANCE_OVERRIDE_FORBIDDEN", "Strategies cannot replace, weaken, or substitute acceptance criteria.");
  }
  validateGapLedger(gaps);
  const strategy = proposal?.strategy;
  if (!validStrategyShape(strategy)) {
    addReason(reasons, "INVALID_STRATEGY", "Strategy proposal is missing required bounded fields or a host-classified material profile.");
    return { accepted: false, reasons };
  }
  for (const reason of validateStrategyEnvelope(mission, gaps, strategy, usage)) addReason(reasons, reason.code, reason.message);
  if (exhaustedFamilies.some((family) => compactText(family) === compactText(strategy.strategyFamily))) {
    addReason(reasons, "STRATEGY_FAMILY_EXHAUSTED", `Strategy family ${strategy.strategyFamily} is exhausted.`);
  }
  if (!materiallyDifferent(strategy, exhaustedStrategy)) {
    addReason(reasons, "NOT_MATERIALLY_DIFFERENT", "Replacement does not change any host-classified material strategy dimension.");
  }
  if (reasons.length) return { accepted: false, reasons };
  return { accepted: true, strategy: structuredClone(strategy), humanApprovalRequired: false };
}

function missionBudgetExceeded(mission: FrozenMissionContract, usage: AdaptiveResourceUsage): boolean {
  const budget = mission.contract.resourceBudget;
  return usage.attemptsUsed >= budget.maxTotalAttempts || usage.strategiesUsed >= budget.maxStrategies || usage.resourceUnitsUsed > budget.maxResourceUnits;
}

export function decideSupervisorAction(state: AdaptiveSupervisorState): AdaptiveSupervisorDecision {
  if (!verifyFrozenMissionContract(state.mission)) return { kind: "ESCALATE", reason: "Mission Contract authority is invalid." };
  if (state.boundaryViolation) return { kind: "ESCALATE", reason: state.boundaryViolation };
  if (state.noLegalStrategyRemains) return { kind: "ESCALATE", reason: "No legal in-envelope strategy remains." };
  if (missionBudgetExceeded(state.mission, state.resourceUsage)) return { kind: "ESCALATE", reason: "Mission resource budget is exhausted." };
  const detour = state.specificBlockingUncertainty;
  if (detour) {
    if (detour.acceptanceEligible !== false || !nonEmpty(detour.questionOrHypothesis) || !nonEmpty(detour.returnTarget)) {
      return { kind: "ESCALATE", reason: "Diagnostic detour is malformed or attempts to become acceptance evidence." };
    }
    return { kind: "DETOUR", reason: detour.questionOrHypothesis, returnTarget: detour.returnTarget };
  }
  if (state.currentStrategy && isStrategyExhausted(state.currentStrategy, state.observations)) {
    return { kind: "REPLAN", reason: "Equivalent failure repeated without new semantic evidence.", exhaustedStrategyFamily: state.currentStrategy.strategyFamily };
  }
  return { kind: "CONTINUE", reason: state.gaps.every((gap) => gap.status === "closed") ? "All gaps are closed; continue to strict acceptance evaluation." : "Current strategy remains viable." };
}

// ---------------------------------------------------------------------------
// Stage 3: truthful, non-controlling shadow observations
// ---------------------------------------------------------------------------

export interface AdaptiveShadowGapChange {
  gapId: string;
  beforeStatus: GapStatus;
  afterStatus: GapStatus;
  addedEvidenceRefs: string[];
  removedEvidenceRefs: string[];
}

export interface AdaptiveRepeatedFailureClassification {
  strategyFamily: string;
  normalizedFailureSignature: string;
  equivalentPriorCount: number;
  equivalentToPrior: boolean;
  newEvidenceFlag: boolean;
  familyExhausted: boolean;
}

export interface AdaptiveShadowCurrentBehavior {
  /** The host's actual action, which need not use the adaptive vocabulary. */
  action: string;
  reason: string;
}

export interface AdaptiveShadowObservation {
  schemaVersion: 1;
  mode: "shadow-v1";
  recordId: string;
  runId: string;
  workflowId: string;
  observedAt: string;
  semanticProgress: SemanticProgressObservation;
  gapChanges: AdaptiveShadowGapChange[];
  repeatedFailure?: AdaptiveRepeatedFailureClassification;
  currentBehavior: AdaptiveShadowCurrentBehavior;
  wouldDecide: AdaptiveSupervisorDecision;
  /** A machine-checkable guarantee that shadowing cannot authorize dispatch. */
  controlledExecution: false;
}

export interface CreateAdaptiveShadowObservationInput {
  recordId: string;
  runId: string;
  workflowId: string;
  observedAt?: string;
  mission: FrozenMissionContract;
  beforeGaps: Gap[];
  afterGaps: Gap[];
  evidence: GapEvidence[];
  currentStrategy?: CurrentStrategy;
  observations: FailureObservation[];
  currentFailure?: FailureObservation;
  resourceUsage: AdaptiveResourceUsage;
  currentBehavior: AdaptiveShadowCurrentBehavior;
  boundaryViolation?: string;
  specificBlockingUncertainty?: DiagnosticDetour;
  noLegalStrategyRemains?: boolean;
}

export function classifyRepeatedFailure(
  observations: FailureObservation[],
  current: FailureObservation,
): AdaptiveRepeatedFailureClassification {
  if (!current || !nonEmpty(current.strategyFamily) || !nonEmpty(current.normalizedFailureSignature)) {
    throw new Error("ADAPTIVE_SHADOW_FAILURE_INVALID");
  }
  const prior = observations.filter((item) => item !== current);
  const equivalentPriorCount = prior.filter((item) => isEquivalentFailure(item, current)).length;
  const familyObservations = observations.includes(current) ? observations : [...observations, current];
  const syntheticStrategy = {
    strategyId: current.strategyId,
    strategyFamily: current.strategyFamily,
  } as CurrentStrategy;
  return {
    strategyFamily: current.strategyFamily,
    normalizedFailureSignature: compactText(current.normalizedFailureSignature),
    equivalentPriorCount,
    equivalentToPrior: equivalentPriorCount > 0,
    newEvidenceFlag: current.newEvidenceFlag,
    familyExhausted: isStrategyExhausted(syntheticStrategy, familyObservations),
  };
}

export function createAdaptiveShadowObservation(input: CreateAdaptiveShadowObservationInput): AdaptiveShadowObservation {
  if (![input.recordId, input.runId, input.workflowId, input.currentBehavior?.action, input.currentBehavior?.reason].every(nonEmpty)) {
    throw new Error("ADAPTIVE_SHADOW_IDENTITY_OR_BEHAVIOR_REQUIRED");
  }
  if (!verifyFrozenMissionContract(input.mission)) throw new Error("ADAPTIVE_SHADOW_MISSION_INVALID");
  const semanticProgress = observeSemanticProgress(input.beforeGaps, input.evidence, input.afterGaps);
  const before = new Map(input.beforeGaps.map((gap) => [gap.gapId, gap]));
  const gapChanges = input.afterGaps.flatMap((gap): AdaptiveShadowGapChange[] => {
    const previous = before.get(gap.gapId)!;
    const addedEvidenceRefs = gap.evidenceRefs.filter((item) => !previous.evidenceRefs.includes(item));
    const removedEvidenceRefs = previous.evidenceRefs.filter((item) => !gap.evidenceRefs.includes(item));
    if (previous.status === gap.status && addedEvidenceRefs.length === 0 && removedEvidenceRefs.length === 0) return [];
    return [{ gapId: gap.gapId, beforeStatus: previous.status, afterStatus: gap.status, addedEvidenceRefs, removedEvidenceRefs }];
  });
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("ADAPTIVE_SHADOW_TIMESTAMP_INVALID");
  const observations = input.currentFailure && !input.observations.includes(input.currentFailure)
    ? [...input.observations, input.currentFailure]
    : input.observations;
  const wouldDecide = decideSupervisorAction({
    mission: input.mission,
    gaps: input.afterGaps,
    currentStrategy: input.currentStrategy,
    observations,
    resourceUsage: input.resourceUsage,
    ...(input.boundaryViolation ? { boundaryViolation: input.boundaryViolation } : {}),
    ...(input.specificBlockingUncertainty ? { specificBlockingUncertainty: input.specificBlockingUncertainty } : {}),
    ...(input.noLegalStrategyRemains !== undefined ? { noLegalStrategyRemains: input.noLegalStrategyRemains } : {}),
  });
  return deepFreeze({
    schemaVersion: 1,
    mode: "shadow-v1",
    recordId: input.recordId,
    runId: input.runId,
    workflowId: input.workflowId,
    observedAt,
    semanticProgress,
    gapChanges,
    ...(input.currentFailure ? { repeatedFailure: classifyRepeatedFailure(input.observations, input.currentFailure) } : {}),
    currentBehavior: structuredClone(input.currentBehavior),
    wouldDecide,
    controlledExecution: false,
  });
}

// ---------------------------------------------------------------------------
// Stage 4: bounded enforce-canary state machine
// ---------------------------------------------------------------------------

export type AdaptiveEnforceCanaryPhase =
  | "strategy_a_ready"
  | "strategy_a_executing"
  | "strategy_a_retry_ready"
  | "strategy_a_exhausted"
  | "strategy_b_proposed"
  | "strategy_b_activated"
  | "strategy_b_executing"
  | "acceptance_evaluation"
  | "completed";

export interface AdaptiveCanaryInvariantSnapshot {
  runId: string;
  missionCanonicalBytes: string;
  missionHash: string;
  acceptanceCriteriaBytes: string;
  safetyScopeBytes: string;
  resourceBudgetBytes: string;
  gapLedgerBytesAtTransitionStart: string;
  initialApprovalCount: 1;
}

export interface AdaptiveCanaryExecutionReservation {
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

export interface AdaptiveCanaryProposalRecord {
  proposedAt: string;
  modelProposal: StrategyProposal;
  hostMaterialProfile: StrategyMaterialProfile;
  validatedProposal: StrategyProposal;
  validation: StrategyProposalValidation;
}

export interface AdaptiveCanaryActivationRecord {
  strategyId: string;
  strategyFamily: string;
  activatedAt: string;
  durableBeforeDispatch: true;
}

export interface AdaptiveEnforceCanaryState {
  schemaVersion: 1;
  mode: "enforce-canary-v1";
  runId: string;
  reconstructedRun: false;
  approvalCount: 1;
  mission: FrozenMissionContract;
  invariantSnapshot: AdaptiveCanaryInvariantSnapshot;
  phase: AdaptiveEnforceCanaryPhase;
  gaps: Gap[];
  activeStrategy: CurrentStrategy;
  strategyAId: string;
  strategyHistory: CurrentStrategy[];
  observations: FailureObservation[];
  exhaustedFamilies: string[];
  resourceUsage: AdaptiveResourceUsage;
  decisions: AdaptiveSupervisorDecision[];
  proposals: AdaptiveCanaryProposalRecord[];
  activations: AdaptiveCanaryActivationRecord[];
  executionReservations: AdaptiveCanaryExecutionReservation[];
  strictAcceptance?: {
    passed: true;
    satisfiedCriteria: string[];
    evaluatedAt: string;
  };
}

export interface CreateAdaptiveEnforceCanaryInput {
  runId: string;
  mission: FrozenMissionContract;
  gaps: Gap[];
  strategyA: CurrentStrategy;
  approvalCount: number;
}

function canaryNow(value?: string): string {
  const result = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error("ADAPTIVE_CANARY_TIMESTAMP_INVALID");
  return result;
}

function cloneCanary(state: AdaptiveEnforceCanaryState): AdaptiveEnforceCanaryState {
  return structuredClone(state);
}

function gapLedgerIdentity(gaps: Gap[]): string {
  return canonicalValue(gaps.map((gap) => ({
    gapId: gap.gapId,
    requirement: gap.requirement,
    admissibleEvidence: gap.admissibleEvidence,
    dependsOn: gap.dependsOn ?? [],
  })));
}

export function assertAdaptiveEnforceCanaryInvariants(state: AdaptiveEnforceCanaryState): void {
  if (!state || state.schemaVersion !== 1 || state.mode !== "enforce-canary-v1") throw new Error("ADAPTIVE_CANARY_STATE_INVALID");
  validateGapLedger(state.gaps);
  const snapshot = state.invariantSnapshot;
  if (
    !verifyFrozenMissionContract(state.mission) ||
    state.runId !== snapshot.runId || state.reconstructedRun !== false ||
    state.approvalCount !== 1 || snapshot.initialApprovalCount !== 1 ||
    state.mission.canonicalBytes !== snapshot.missionCanonicalBytes || state.mission.missionHash !== snapshot.missionHash ||
    canonicalValue(state.mission.contract.acceptanceCriteria) !== snapshot.acceptanceCriteriaBytes ||
    canonicalValue({
      safetyEnvelope: state.mission.contract.safetyEnvelope,
      protectedPathsAndPermissions: state.mission.contract.protectedPathsAndPermissions,
    }) !== snapshot.safetyScopeBytes ||
    canonicalValue(state.mission.contract.resourceBudget) !== snapshot.resourceBudgetBytes ||
    gapLedgerIdentity(state.gaps) !== gapLedgerIdentity(JSON.parse(snapshot.gapLedgerBytesAtTransitionStart) as Gap[])
  ) throw new Error("ADAPTIVE_CANARY_PROTECTED_INVARIANT_DRIFT");
  const initialGaps = JSON.parse(snapshot.gapLedgerBytesAtTransitionStart) as Gap[];
  for (const initial of initialGaps) {
    const current = state.gaps.find((gap) => gap.gapId === initial.gapId)!;
    if (initial.status === "closed" && current.status !== "closed") throw new Error("ADAPTIVE_CANARY_CLOSED_GAP_REGRESSED");
  }
  if (!new Set<AdaptiveEnforceCanaryPhase>([
    "acceptance_evaluation", "completed",
  ]).has(state.phase) && canonicalValue(state.gaps) !== snapshot.gapLedgerBytesAtTransitionStart) {
    throw new Error("ADAPTIVE_CANARY_GAPS_CHANGED_DURING_A_TO_B");
  }
}

export function createAdaptiveEnforceCanaryState(input: CreateAdaptiveEnforceCanaryInput): AdaptiveEnforceCanaryState {
  if (!nonEmpty(input.runId) || input.approvalCount !== 1) throw new Error("ADAPTIVE_CANARY_SINGLE_INITIAL_APPROVAL_REQUIRED");
  if (!verifyFrozenMissionContract(input.mission)) throw new Error("ADAPTIVE_CANARY_MISSION_INVALID");
  validateGapLedger(input.gaps);
  const validation = validateInitialStrategy(input.mission, input.gaps, input.strategyA);
  if (!validation.accepted) throw new Error(`ADAPTIVE_CANARY_STRATEGY_A_REJECTED: ${validation.reasons.map((item) => item.code).join(",")}`);
  const gaps = structuredClone(input.gaps);
  const state: AdaptiveEnforceCanaryState = {
    schemaVersion: 1,
    mode: "enforce-canary-v1",
    runId: input.runId,
    reconstructedRun: false,
    approvalCount: 1,
    mission: structuredClone(input.mission),
    invariantSnapshot: {
      runId: input.runId,
      missionCanonicalBytes: input.mission.canonicalBytes,
      missionHash: input.mission.missionHash,
      acceptanceCriteriaBytes: canonicalValue(input.mission.contract.acceptanceCriteria),
      safetyScopeBytes: canonicalValue({
        safetyEnvelope: input.mission.contract.safetyEnvelope,
        protectedPathsAndPermissions: input.mission.contract.protectedPathsAndPermissions,
      }),
      resourceBudgetBytes: canonicalValue(input.mission.contract.resourceBudget),
      gapLedgerBytesAtTransitionStart: canonicalValue(gaps),
      initialApprovalCount: 1,
    },
    phase: "strategy_a_ready",
    gaps,
    activeStrategy: structuredClone(validation.strategy),
    strategyAId: validation.strategy.strategyId,
    strategyHistory: [structuredClone(validation.strategy)],
    observations: [],
    exhaustedFamilies: [],
    resourceUsage: { attemptsUsed: 0, strategiesUsed: 1, resourceUnitsUsed: 0 },
    decisions: [],
    proposals: [],
    activations: [],
    executionReservations: [],
  };
  assertAdaptiveEnforceCanaryInvariants(state);
  return state;
}

export function reserveAdaptiveCanaryExecution(
  state: AdaptiveEnforceCanaryState,
  reservedAt?: string,
): { state: AdaptiveEnforceCanaryState; reservation: AdaptiveCanaryExecutionReservation } {
  assertAdaptiveEnforceCanaryInvariants(state);
  const next = cloneCanary(state);
  const isA = next.activeStrategy.strategyId === next.strategyAId;
  const legalPhase = isA
    ? next.phase === "strategy_a_ready" || next.phase === "strategy_a_retry_ready"
    : next.phase === "strategy_b_activated";
  if (!legalPhase) throw new Error("ADAPTIVE_CANARY_EXECUTION_NOT_AUTHORIZED");
  if (isA && next.activeStrategy.attemptsUsed >= 2) throw new Error("ADAPTIVE_CANARY_FAMILY_A_ATTEMPT_LIMIT");
  const units = next.activeStrategy.resourceBudget.resourceUnitsPerAttempt;
  const attempt = next.activeStrategy.attemptsUsed + 1;
  const missionBudget = next.mission.contract.resourceBudget;
  if (
    attempt > next.activeStrategy.resourceBudget.maxAttempts ||
    attempt * units > next.activeStrategy.resourceBudget.resourceUnits ||
    next.resourceUsage.attemptsUsed + 1 > missionBudget.maxTotalAttempts ||
    next.resourceUsage.resourceUnitsUsed + units > missionBudget.maxResourceUnits
  ) throw new Error("ADAPTIVE_CANARY_RESOURCE_BUDGET_EXCEEDED");
  next.activeStrategy.attemptsUsed = attempt;
  const history = next.strategyHistory.find((item) => item.strategyId === next.activeStrategy.strategyId);
  if (history) history.attemptsUsed = attempt;
  next.resourceUsage.attemptsUsed += 1;
  next.resourceUsage.resourceUnitsUsed += units;
  const reservation: AdaptiveCanaryExecutionReservation = {
    reservationId: `${next.runId}:${next.activeStrategy.strategyId}:${attempt}`,
    strategyId: next.activeStrategy.strategyId,
    strategyFamily: next.activeStrategy.strategyFamily,
    attempt,
    resourceUnits: units,
    reservedAt: canaryNow(reservedAt),
  };
  next.executionReservations.push(reservation);
  next.phase = isA ? "strategy_a_executing" : "strategy_b_executing";
  assertAdaptiveEnforceCanaryInvariants(next);
  return { state: next, reservation: structuredClone(reservation) };
}

function pendingReservation(state: AdaptiveEnforceCanaryState): AdaptiveCanaryExecutionReservation {
  const reservation = [...state.executionReservations].reverse().find((item) => item.outcome === undefined);
  if (!reservation || reservation.strategyId !== state.activeStrategy.strategyId) throw new Error("ADAPTIVE_CANARY_RESERVATION_MISSING");
  return reservation;
}

export function recordAdaptiveCanaryStrategyAFailure(
  state: AdaptiveEnforceCanaryState,
  observation: FailureObservation,
): AdaptiveEnforceCanaryState {
  assertAdaptiveEnforceCanaryInvariants(state);
  if (state.phase !== "strategy_a_executing" || state.activeStrategy.strategyId !== state.strategyAId) {
    throw new Error("ADAPTIVE_CANARY_A_FAILURE_OUT_OF_PHASE");
  }
  if (
    observation.strategyId !== state.activeStrategy.strategyId ||
    compactText(observation.strategyFamily) !== compactText(state.activeStrategy.strategyFamily) ||
    !nonEmpty(observation.normalizedFailureSignature)
  ) throw new Error("ADAPTIVE_CANARY_A_FAILURE_CLASSIFICATION_INVALID");
  const next = cloneCanary(state);
  const reservation = pendingReservation(next);
  reservation.outcome = "failure";
  reservation.failureSignature = compactText(observation.normalizedFailureSignature);
  next.observations.push(structuredClone(observation));
  const decision = decideSupervisorAction({
    mission: next.mission,
    gaps: next.gaps,
    currentStrategy: next.activeStrategy,
    observations: next.observations,
    resourceUsage: next.resourceUsage,
  });
  next.decisions.push(decision);
  if (reservation.attempt === 1) {
    if (decision.kind !== "CONTINUE") throw new Error("ADAPTIVE_CANARY_FIRST_A_FAILURE_MUST_RETRY");
    next.phase = "strategy_a_retry_ready";
  } else if (reservation.attempt === 2) {
    if (decision.kind !== "REPLAN") throw new Error("ADAPTIVE_CANARY_SECOND_A_FAILURE_MUST_EXHAUST_FAMILY");
    next.phase = "strategy_a_exhausted";
    next.exhaustedFamilies.push(next.activeStrategy.strategyFamily);
  } else {
    throw new Error("ADAPTIVE_CANARY_FAMILY_A_ATTEMPT_LIMIT");
  }
  assertAdaptiveEnforceCanaryInvariants(next);
  return next;
}

export function recordAdaptiveCanaryStrategyBProposal(
  state: AdaptiveEnforceCanaryState,
  modelProposal: StrategyProposal,
  hostMaterialProfile: StrategyMaterialProfile,
  proposedAt?: string,
): AdaptiveEnforceCanaryState {
  assertAdaptiveEnforceCanaryInvariants(state);
  if (state.phase !== "strategy_a_exhausted") throw new Error("ADAPTIVE_CANARY_B_PROPOSAL_OUT_OF_PHASE");
  const next = cloneCanary(state);
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
    proposedAt: canaryNow(proposedAt),
    modelProposal: structuredClone(modelProposal),
    hostMaterialProfile: structuredClone(hostMaterialProfile),
    validatedProposal,
    validation: structuredClone(validation),
  });
  if (validation.accepted) next.phase = "strategy_b_proposed";
  assertAdaptiveEnforceCanaryInvariants(next);
  return next;
}

export function activateAdaptiveCanaryStrategyB(
  state: AdaptiveEnforceCanaryState,
  activatedAt?: string,
): AdaptiveEnforceCanaryState {
  assertAdaptiveEnforceCanaryInvariants(state);
  if (state.phase !== "strategy_b_proposed") throw new Error("ADAPTIVE_CANARY_B_ACTIVATION_OUT_OF_PHASE");
  const proposal = state.proposals[state.proposals.length - 1];
  if (!proposal?.validation.accepted) throw new Error("ADAPTIVE_CANARY_B_PROPOSAL_NOT_ACCEPTED");
  const next = cloneCanary(state);
  const accepted = next.proposals[next.proposals.length - 1].validation;
  if (!accepted.accepted) throw new Error("ADAPTIVE_CANARY_B_PROPOSAL_NOT_ACCEPTED");
  next.activeStrategy = structuredClone(accepted.strategy);
  next.strategyHistory.push(structuredClone(accepted.strategy));
  next.resourceUsage.strategiesUsed += 1;
  next.phase = "strategy_b_activated";
  next.activations.push({
    strategyId: accepted.strategy.strategyId,
    strategyFamily: accepted.strategy.strategyFamily,
    activatedAt: canaryNow(activatedAt),
    durableBeforeDispatch: true,
  });
  assertAdaptiveEnforceCanaryInvariants(next);
  return next;
}

export function recordAdaptiveCanaryStrategyBSuccess(
  state: AdaptiveEnforceCanaryState,
  evidence: GapEvidence,
): AdaptiveEnforceCanaryState {
  assertAdaptiveEnforceCanaryInvariants(state);
  if (state.phase !== "strategy_b_executing" || state.activeStrategy.strategyId === state.strategyAId) {
    throw new Error("ADAPTIVE_CANARY_B_SUCCESS_OUT_OF_PHASE");
  }
  if (
    !state.activeStrategy.whichGapIds.includes(evidence.gapId) ||
    !state.activeStrategy.expectedEvidence.includes(evidence.evidenceKind)
  ) throw new Error("ADAPTIVE_CANARY_B_EVIDENCE_OUT_OF_TARGET");
  const next = cloneCanary(state);
  const reservation = pendingReservation(next);
  const before = structuredClone(next.gaps);
  next.gaps = applyGapEvidence(next.gaps, evidence);
  const progress = observeSemanticProgress(before, [evidence], next.gaps);
  if (!progress.usefulProgress) throw new Error("ADAPTIVE_CANARY_B_NO_SEMANTIC_PROGRESS");
  reservation.outcome = "success";
  reservation.evidenceRef = evidence.evidenceRef;
  next.phase = "acceptance_evaluation";
  assertAdaptiveEnforceCanaryInvariants(next);
  return next;
}

export function completeAdaptiveCanaryStrictAcceptance(
  state: AdaptiveEnforceCanaryState,
  satisfiedCriteria: string[],
  evaluatedAt?: string,
): AdaptiveEnforceCanaryState {
  assertAdaptiveEnforceCanaryInvariants(state);
  if (state.phase !== "acceptance_evaluation") throw new Error("ADAPTIVE_CANARY_ACCEPTANCE_OUT_OF_PHASE");
  if (state.gaps.some((gap) => gap.status !== "closed")) throw new Error("ADAPTIVE_CANARY_UNRESOLVED_GAPS");
  if (canonicalValue(satisfiedCriteria) !== canonicalValue(state.mission.contract.acceptanceCriteria)) {
    throw new Error("ADAPTIVE_CANARY_STRICT_ACCEPTANCE_MISMATCH");
  }
  const next = cloneCanary(state);
  next.strictAcceptance = { passed: true, satisfiedCriteria: [...satisfiedCriteria], evaluatedAt: canaryNow(evaluatedAt) };
  next.phase = "completed";
  assertAdaptiveEnforceCanaryInvariants(next);
  return next;
}
