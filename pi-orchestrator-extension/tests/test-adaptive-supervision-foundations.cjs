#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const adaptive = jiti(path.join(PROJECT_ROOT, "src", "adaptive-supervision.ts"));
const integration = jiti(path.join(PROJECT_ROOT, "src", "adaptive-supervision-integration.ts"));
const host = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function missionContract() {
  return {
    missionId: "adaptive-v1-fixture",
    requiredOutcomes: ["Close G1 without changing mission identity."],
    acceptanceCriteria: ["G1 closes only with fixture-pass evidence."],
    strategicInvariants: ["Preserve closed gaps.", "Do not weaken acceptance."],
    nonGoals: ["No SSI owner state.", "No hardware."],
    safetyEnvelope: {
      allowedOperations: ["execute_fixture", "diagnose_fixture"],
      forbiddenOperations: ["weaken_acceptance", "touch_owner_state"],
    },
    protectedPathsAndPermissions: {
      protectedPaths: [".pi", "owner-profile"],
      allowedMutationPaths: ["fixture"],
      grantedPermissions: ["fixture-write"],
    },
    resourceBudget: {
      maxTotalAttempts: 3,
      maxAttemptsPerStrategy: 2,
      maxStrategies: 2,
      maxResourceUnits: 3,
    },
    finalEnvironmentRequirements: ["deterministic-fixture"],
  };
}

function gapLedger() {
  return [
    {
      gapId: "G0",
      requirement: "Previously completed work remains complete.",
      status: "closed",
      admissibleEvidence: ["prior-pass"],
      evidenceRefs: ["prior-pass-ref"],
    },
    {
      gapId: "G1",
      requirement: "Replacement strategy succeeds.",
      status: "open",
      admissibleEvidence: ["fixture-pass", "diagnostic"],
      dependsOn: ["G0"],
      evidenceRefs: [],
    },
    {
      gapId: "G2",
      requirement: "Previously completed unrelated acceptance remains closed.",
      status: "closed",
      admissibleEvidence: ["later-pass"],
      evidenceRefs: ["later-pass-ref"],
    },
  ];
}

function strategyA() {
  return {
    strategyId: "strategy-a",
    strategyFamily: "A",
    whichGapIds: ["G1"],
    currentBeliefOrHypothesis: "Method A can close G1.",
    method: "Run deterministic Method A.",
    materialProfile: { hypothesis: "hypothesis-a", mechanism: "mechanism-a", instrumentation: "baseline-instrumentation", worker: "fixture-worker" },
    expectedEvidence: ["fixture-pass"],
    abandonmentCondition: "Abandon after a second equivalent failure without new evidence.",
    attemptsUsed: 0,
    resourceBudget: { maxAttempts: 2, resourceUnits: 2, resourceUnitsPerAttempt: 1 },
    operations: ["execute_fixture"],
    requiredPermissions: ["fixture-write"],
    mutationPaths: ["fixture/a.txt"],
  };
}

function strategyB() {
  return {
    strategyId: "strategy-b",
    strategyFamily: "B",
    whichGapIds: ["G1"],
    currentBeliefOrHypothesis: "Method A's mechanism is wrong; Method B can close G1.",
    method: "Run materially different deterministic Method B.",
    materialProfile: { hypothesis: "hypothesis-b", mechanism: "mechanism-b", instrumentation: "b-instrumentation", worker: "fixture-worker" },
    expectedEvidence: ["fixture-pass"],
    abandonmentCondition: "Abandon if Method B does not emit fixture-pass evidence once.",
    attemptsUsed: 0,
    resourceBudget: { maxAttempts: 1, resourceUnits: 1, resourceUnitsPerAttempt: 1 },
    operations: ["execute_fixture"],
    requiredPermissions: ["fixture-write"],
    mutationPaths: ["fixture/b.txt"],
  };
}

function proposalFor(mission, strategy = strategyB()) {
  return { preservedMissionHash: mission.missionHash, strategy };
}

function hostMaterialClassifier({ strategy, exhaustedStrategy }) {
  if (/Method B/i.test(strategy.method)) return structuredClone(strategyB().materialProfile);
  return structuredClone(exhaustedStrategy?.materialProfile ?? strategyA().materialProfile);
}

function justifiedRetryVariation({ strategy }) {
  return {
    reason: "Add bounded instrumentation before the sole retry.",
    dimension: "instrumentation",
    from: strategy.materialProfile.instrumentation,
    to: "retry-instrumentation",
    expectedNewEvidence: ["instrumented-failure-detail"],
  };
}

function rejectionCodes(result) {
  assert.equal(result.accepted, false);
  return result.reasons.map((reason) => reason.code);
}

function testMissionHashAndSemanticProgress() {
  const contract = missionContract();
  const mission = adaptive.createFrozenMissionContract(contract);
  assert.equal(adaptive.verifyFrozenMissionContract(mission), true);
  assert.equal(mission.missionHash, adaptive.hashMissionContract(contract));
  assert.equal(Object.isFrozen(mission), true);
  assert.equal(Object.isFrozen(mission.contract), true);
  assert.equal(Object.isFrozen(mission.contract.resourceBudget), true);
  const changed = structuredClone(contract);
  changed.acceptanceCriteria = ["Weaker acceptance."];
  assert.notEqual(adaptive.hashMissionContract(changed), mission.missionHash, "acceptance changes alter mission identity");

  const gaps = gapLedger();
  const activity = adaptive.observeSemanticProgress(gaps, [{
    evidenceRef: "file-changed",
    evidenceKind: "activity",
    gapId: "G1",
    effect: "activity",
    acceptanceEligible: false,
  }], structuredClone(gaps));
  assert.equal(activity.usefulProgress, false, "file activity alone is not semantic progress");
  assert.equal(activity.reason, "no_semantic_progress");

  const strengthened = adaptive.applyGapEvidence(gaps, {
    evidenceRef: "partial-proof",
    evidenceKind: "fixture-pass",
    gapId: "G1",
    effect: "strengthen",
    acceptanceEligible: false,
  });
  assert.equal(strengthened.find((gap) => gap.gapId === "G1").status, "strengthened");
  assert.equal(adaptive.observeSemanticProgress(gaps, [], strengthened).usefulProgress, true);
  assert.throws(() => adaptive.applyGapEvidence(gaps, {
    evidenceRef: "diagnostic-only",
    evidenceKind: "fixture-pass",
    gapId: "G1",
    effect: "close",
    acceptanceEligible: false,
  }), /NON_ACCEPTANCE_EVIDENCE_CANNOT_CLOSE_GAP/);
  assert.throws(() => adaptive.applyGapEvidence(gaps, {
    evidenceRef: "unknown-diagnostic",
    evidenceKind: "not-admissible",
    gapId: "G1",
    effect: "reduce_uncertainty",
    acceptanceEligible: false,
  }), /INADMISSIBLE_EVIDENCE_FOR_GAP/);
  assert.throws(() => adaptive.observeSemanticProgress(gaps, [{
    evidenceRef: "not-recorded",
    evidenceKind: "diagnostic",
    gapId: "G1",
    effect: "reduce_uncertainty",
    acceptanceEligible: false,
  }], structuredClone(gaps)), /UNRECORDED_SEMANTIC_EVIDENCE/);
  assert.equal(gaps.find((gap) => gap.gapId === "G0").status, "closed", "source ledger remains immutable");
}

function testSameFailureTwiceRule() {
  const a = strategyA();
  const first = {
    strategyId: a.strategyId,
    strategyFamily: "A",
    normalizedFailureSignature: " F ",
    newEvidenceFlag: true,
    evidenceRefs: ["first-diagnostic"],
  };
  const secondWithEvidence = {
    strategyId: a.strategyId,
    strategyFamily: "a",
    normalizedFailureSignature: "f",
    newEvidenceFlag: true,
    evidenceRefs: ["second-diagnostic"],
  };
  const secondWithoutEvidence = { ...secondWithEvidence, newEvidenceFlag: false, evidenceRefs: [] };
  assert.equal(adaptive.isEquivalentFailure(first, secondWithoutEvidence), true);
  assert.equal(adaptive.isStrategyExhausted(a, [first]), false, "first failure permits one justified retry");
  assert.equal(adaptive.isStrategyExhausted(a, [first, secondWithEvidence]), false, "new information keeps strategy viable");
  assert.equal(adaptive.isStrategyExhausted(a, [first, secondWithoutEvidence]), true, "second equivalent no-information failure exhausts family");
  assert.equal(adaptive.isStrategyExhausted(a, [first, { ...secondWithoutEvidence, normalizedFailureSignature: "G" }]), false);
  assert.equal(adaptive.isStrategyExhausted(a, [
    first,
    { ...secondWithoutEvidence, normalizedFailureSignature: "G" },
    secondWithoutEvidence,
  ]), true, "non-adjacent equivalent repeats still exhaust the family");
}

function testProposalLegalityAndDecisionVocabulary() {
  const mission = adaptive.createFrozenMissionContract(missionContract());
  const gaps = gapLedger();
  const a = strategyA();
  const usage = { attemptsUsed: 2, strategiesUsed: 1, resourceUnitsUsed: 2 };
  const accepted = adaptive.validateStrategyProposal(mission, gaps, a, proposalFor(mission), usage);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.humanApprovalRequired, false, "legal in-envelope B needs no new human approval");

  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, { ...proposalFor(mission), preservedMissionHash: "0".repeat(64) }, usage,
  )).includes("MISSION_HASH_CHANGED"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, { ...proposalFor(mission), acceptanceCriteriaOverride: [] }, usage,
  )).includes("ACCEPTANCE_OVERRIDE_FORBIDDEN"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), strategyFamily: "A", strategyId: "renamed-a" }), usage,
  )).includes("STRATEGY_FAMILY_EXHAUSTED"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, {
      ...strategyB(),
      currentBeliefOrHypothesis: a.currentBeliefOrHypothesis,
      method: a.method,
      materialProfile: structuredClone(a.materialProfile),
    }), usage,
  )).includes("NOT_MATERIALLY_DIFFERENT"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, {
      ...strategyA(),
      strategyId: "strategy-a-renamed",
      strategyFamily: "A-renamed",
      currentBeliefOrHypothesis: "A paraphrase of the same hypothesis.",
      method: "Paraphrase deterministic Method A.",
    }), usage,
  )).includes("NOT_MATERIALLY_DIFFERENT"), "renaming a family and paraphrasing prose is not a material change");
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), whichGapIds: ["G404"] }), usage,
  )).includes("MISSING_TARGET_GAP"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), expectedEvidence: ["not-admissible"] }), usage,
  )).includes("EXPECTED_EVIDENCE_INADMISSIBLE"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), whichGapIds: ["G0"] }), usage,
  )).includes("TARGET_GAP_ALREADY_CLOSED"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), operations: ["touch_owner_state"] }), usage,
  )).includes("SAFETY_ENVELOPE_VIOLATION"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), requiredPermissions: ["admin"] }), usage,
  )).includes("PERMISSION_OUTSIDE_ENVELOPE"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), mutationPaths: [".pi/secret.txt"] }), usage,
  )).includes("MUTATION_SCOPE_OUTSIDE_ENVELOPE"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission, { ...strategyB(), mutationPaths: [".PI/secret.txt"] }), usage,
  )).includes("MUTATION_SCOPE_OUTSIDE_ENVELOPE"));
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, strategyB(), proposalFor(mission, { ...strategyA(), strategyId: "strategy-a-reactivated" }), usage, ["A", "B"],
  )).includes("STRATEGY_FAMILY_EXHAUSTED"), "an exhausted family remains illegal after another strategy becomes current");
  assert.ok(rejectionCodes(adaptive.validateStrategyProposal(
    mission, gaps, a, proposalFor(mission), { ...usage, attemptsUsed: 3 },
  )).includes("RESOURCE_BUDGET_EXCEEDED"));

  const observations = [
    { strategyId: "strategy-a", strategyFamily: "A", normalizedFailureSignature: "F", newEvidenceFlag: true, evidenceRefs: [] },
    { strategyId: "strategy-a", strategyFamily: "A", normalizedFailureSignature: "F", newEvidenceFlag: false, evidenceRefs: [] },
  ];
  assert.equal(adaptive.validateInitialStrategy(mission, gaps, a).accepted, true);
  assert.ok(rejectionCodes(adaptive.validateInitialStrategy(
    mission, gaps, { ...a, mutationPaths: [".PI/unsafe.txt"] },
  )).includes("MUTATION_SCOPE_OUTSIDE_ENVELOPE"), "initial Strategy A is checked before execution");
  assert.equal(adaptive.decideSupervisorAction({ mission, gaps, currentStrategy: a, observations, resourceUsage: usage }).kind, "REPLAN");
  assert.equal(adaptive.decideSupervisorAction({
    mission, gaps, currentStrategy: a, observations: observations.slice(0, 1), resourceUsage: usage,
    specificBlockingUncertainty: {
      questionOrHypothesis: "Does environment X cause F?",
      targetGap: "G1",
      resourceBudget: { maxAttempts: 1, resourceUnits: 0, resourceUnitsPerAttempt: 0 },
      expectedEvidence: ["diagnostic"],
      exitCondition: "Observe one result.",
      returnTarget: "G1",
      acceptanceEligible: false,
    },
  }).kind, "DETOUR");
  assert.equal(adaptive.decideSupervisorAction({
    mission, gaps, currentStrategy: a, observations: [], resourceUsage: { ...usage, attemptsUsed: 3 },
  }).kind, "ESCALATE");
  assert.equal(adaptive.decideSupervisorAction({
    mission, gaps, currentStrategy: a, observations: observations.slice(0, 1), resourceUsage: usage,
  }).kind, "CONTINUE");
}

function testStage3ShadowJournalIsDurableAndNonControlling() {
  const root = tempDir("adaptive-shadow-journal");
  const journalFile = path.join(root, "shadow.jsonl");
  try {
    const mission = adaptive.createFrozenMissionContract(missionContract());
    const before = gapLedger();
    const evidence = {
      evidenceRef: "shadow-strengthening-proof",
      evidenceKind: "diagnostic",
      gapId: "G1",
      effect: "strengthen",
      acceptanceEligible: false,
    };
    const after = adaptive.applyGapEvidence(before, evidence);
    const first = {
      strategyId: "strategy-a",
      strategyFamily: "A",
      normalizedFailureSignature: "same-no-information-failure",
      newEvidenceFlag: true,
      evidenceRefs: [evidence.evidenceRef],
    };
    const second = { ...first, newEvidenceFlag: false, evidenceRefs: [] };
    const record = adaptive.createAdaptiveShadowObservation({
      recordId: "shadow-record-2",
      runId: "shadow-foundation-run",
      workflowId: "synthetic-ssi-workflow",
      observedAt: "2026-09-01T00:00:00.000Z",
      mission,
      beforeGaps: before,
      afterGaps: after,
      evidence: [evidence],
      currentStrategy: strategyA(),
      observations: [first, second],
      currentFailure: second,
      resourceUsage: { attemptsUsed: 2, strategiesUsed: 1, resourceUnitsUsed: 2 },
      currentBehavior: {
        action: "CURRENT_RETRY_POLICY",
        reason: "The existing supervisor remains authoritative in shadow mode.",
      },
    });
    assert.equal(record.controlledExecution, false);
    assert.deepEqual(record.semanticProgress.strengthenedGapIds, ["G1"]);
    assert.equal(record.gapChanges[0].beforeStatus, "open");
    assert.equal(record.gapChanges[0].afterStatus, "strengthened");
    assert.equal(record.repeatedFailure.equivalentToPrior, true);
    assert.equal(record.repeatedFailure.familyExhausted, true);
    assert.equal(record.currentBehavior.action, "CURRENT_RETRY_POLICY");
    assert.equal(record.wouldDecide.kind, "REPLAN");

    const journal = new integration.AdaptiveShadowJournal(journalFile);
    const persisted = journal.append(record);
    assert.equal(persisted.sequence, 1);
    assert.equal(persisted.previousRecordHash, null);
    assert.match(persisted.recordHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(journal.readAll(), [persisted], "shadow record survives durable read-after-write validation");
    assert.throws(() => journal.append(record), /ADAPTIVE_SHADOW_DUPLICATE_RECORD/);

    const tampered = fs.readFileSync(journalFile, "utf8").replace("CURRENT_RETRY_POLICY", "CONTROL_EXECUTION");
    fs.writeFileSync(journalFile, tampered, "utf8");
    assert.throws(() => journal.readAll(), /ADAPTIVE_SHADOW_JOURNAL_INTEGRITY_FAILURE/,
      "hash chaining makes semantic/current-behavior tampering visible");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testDefaultOffAndSameRunDurableTransition() {
  const workspace = tempDir("adaptive-v1-workspace");
  const stateRoot = tempDir("adaptive-v1-state");
  const disabledStateRoot = tempDir("adaptive-v1-disabled");
  const runId = "adaptive-v1-stage2";
  const mission = adaptive.createFrozenMissionContract(missionContract());
  const proposal = proposalFor(mission);
  const calls = [];
  try {
    await assert.rejects(() => integration.runAdaptiveSupervisionV1Fixture({
      runId: "adaptive-disabled",
      workspaceRoot: workspace,
      stateRoot: disabledStateRoot,
      missionContract: missionContract(),
      initialGaps: gapLedger(),
      strategyA: strategyA(),
      env: {},
      classifyMaterialProfile: hostMaterialClassifier,
      planStrategyARetry: justifiedRetryVariation,
      proposeStrategyB: () => proposal,
      executeStep: () => ({ outcome: "failure", failureSignature: "F", newEvidenceFlag: false, evidenceRefs: [] }),
    }), /ADAPTIVE_SUPERVISION_V1_DISABLED/);
    assert.equal(fs.readdirSync(disabledStateRoot).length, 0, "default-off path writes no run state");
    assert.equal(integration.adaptiveSupervisionV1Mode({}), "off");
    assert.equal(typeof host.runAdaptiveSupervisionV1Fixture, "function", "host exposes the gated Stage 2 seam");
    assert.equal(host.adaptiveSupervisionV1Mode({}), "off");

    const stateFile = path.join(stateRoot, runId, "supervision.json");
    const result = await integration.runAdaptiveSupervisionV1Fixture({
      runId,
      workspaceRoot: workspace,
      stateRoot,
      missionContract: missionContract(),
      initialGaps: gapLedger(),
      strategyA: strategyA(),
      env: { [integration.ADAPTIVE_SUPERVISION_V1_FEATURE_FLAG]: "1" },
      classifyMaterialProfile: hostMaterialClassifier,
      planStrategyARetry(input) {
        calls.push("retry-variation-a");
        return justifiedRetryVariation(input);
      },
      proposeStrategyB(input) {
        calls.push("model-proposal-b");
        assert.equal(input.runId, runId);
        assert.equal(input.mission.missionHash, mission.missionHash);
        assert.equal(input.gaps.find((gap) => gap.gapId === "G0").status, "closed");
        assert.equal(input.gaps.find((gap) => gap.gapId === "G1").status, "open");
        return proposal;
      },
      executeStep(strategy, attempt, permit) {
        calls.push(`${strategy.strategyFamily}:${attempt}`);
        assert.equal(permit.resourceUnits, 1);
        assert.deepEqual(permit.allowedOperations, ["execute_fixture"]);
        assert.equal(permit.attempt, attempt);
        if (strategy.strategyFamily === "A") {
          return {
            outcome: "failure",
            failureSignature: "F",
            newEvidenceFlag: attempt === 1,
            evidenceRefs: attempt === 1 ? ["first-diagnostic"] : [],
          };
        }
        assert.equal(strategy.strategyFamily, "B");
        const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        const persistedAdaptive = persisted.runtime.adapterState.adaptiveSupervision;
        assert.equal(persistedAdaptive.phase, "strategy_b_activated", "B activation is durable before B executes");
        assert.equal(persistedAdaptive.activations[0].activatedBeforeExecution, true);
        assert.match(persistedAdaptive.activations[0].checkpointId, /^checkpoint-\d{4}$/);
        return {
          outcome: "success",
          evidence: {
            evidenceRef: "strategy-b-fixture-pass",
            evidenceKind: "fixture-pass",
            gapId: "G1",
            effect: "close",
            acceptanceEligible: true,
          },
        };
      },
    });

    assert.deepEqual(calls, ["A:1", "retry-variation-a", "A:2", "model-proposal-b", "B:1"]);
    assert.equal(result.runId, runId);
    assert.equal(result.state.runId, runId);
    assert.equal(result.state.mode, "visible-main");
    assert.equal(result.state.status, "terminal");
    assert.equal(result.state.terminalOutcome, "pass");
    assert.equal(result.hostMissionHash, result.state.mission.missionHash);
    assert.equal(result.missionContractHash, mission.missionHash);
    assert.equal(result.adaptiveState.initialMissionHash, mission.missionHash);
    assert.equal(result.adaptiveState.missionContract.canonicalBytes, result.adaptiveState.initialMissionBytes);
    assert.equal(result.adaptiveState.reconstructedRun, false);
    assert.equal(result.adaptiveState.humanApprovalCount, 1);
    assert.ok(result.state.currentApproval.consumedAt, "only the initial visible-main approval was consumed");
    assert.equal(result.adaptiveState.exhaustedFamilies.includes("A"), true);
    assert.equal(result.adaptiveState.activeStrategy.strategyFamily, "B");
    assert.equal(result.adaptiveState.modelProposals.length, 1);
    assert.equal(result.adaptiveState.modelProposals[0].source, "model");
    assert.deepEqual(result.adaptiveState.modelProposals[0].hostMaterialProfile, strategyB().materialProfile);
    assert.equal(result.adaptiveState.modelProposals[0].validation.accepted, true);
    assert.equal(result.adaptiveState.retryVariations.length, 1);
    assert.equal(result.adaptiveState.retryVariations[0].dimension, "instrumentation");
    assert.equal(result.adaptiveState.retryVariations[0].to, "retry-instrumentation");
    assert.equal(result.adaptiveState.activations[0].activatedBeforeExecution, true);
    assert.equal(result.adaptiveState.acceptanceClosedByStrategyId, "strategy-b");
    assert.equal(result.adaptiveState.gaps.find((gap) => gap.gapId === "G0").status, "closed");
    assert.equal(result.adaptiveState.gaps.find((gap) => gap.gapId === "G1").status, "closed");
    assert.equal(result.adaptiveState.gaps.find((gap) => gap.gapId === "G2").status, "closed", "already-closed unrelated gaps survive strategy replacement");
    assert.deepEqual(result.state.completedCriteria, ["AC-01"]);

    const payloads = result.state.checkpoints.map((checkpoint) => {
      const envelope = JSON.parse(fs.readFileSync(checkpoint.payloadFile, "utf8"));
      return { checkpoint, adaptive: envelope.payload.adaptiveSupervision };
    });
    const a1 = payloads.find(({ checkpoint }) => checkpoint.outcome === "strategy_a_attempt_1_failed");
    const retry = payloads.find(({ checkpoint }) => checkpoint.outcome === "strategy_a_retry_justified");
    const exhausted = payloads.find(({ checkpoint }) => checkpoint.outcome === "strategy_a_exhausted");
    const activated = payloads.find(({ checkpoint }) => checkpoint.outcome === "strategy_b_activated");
    const bClosed = payloads.find(({ checkpoint }) => checkpoint.outcome === "strategy_b_closed_g1");
    assert.ok(a1 && retry && exhausted && activated && bClosed);
    assert.equal(a1.adaptive.gaps.find((gap) => gap.gapId === "G1").status, "open");
    assert.equal(retry.adaptive.retryVariations[0].to, "retry-instrumentation");
    assert.ok(a1.checkpoint.sequence < retry.checkpoint.sequence && retry.checkpoint.sequence < exhausted.checkpoint.sequence);
    assert.equal(exhausted.adaptive.gaps.find((gap) => gap.gapId === "G1").status, "open");
    assert.equal(exhausted.adaptive.exhaustedFamilies.includes("A"), true);
    assert.equal(activated.adaptive.activeStrategy.strategyFamily, "B");
    assert.equal(bClosed.adaptive.gaps.find((gap) => gap.gapId === "G1").status, "closed");
    assert.ok(activated.checkpoint.sequence < bClosed.checkpoint.sequence, "B activation precedes B evidence and closure");
    for (const { adaptive: snapshot } of payloads) {
      assert.equal(snapshot.initialMissionHash, mission.missionHash);
      assert.equal(snapshot.missionContract.missionHash, mission.missionHash);
      assert.equal(snapshot.missionContract.canonicalBytes, snapshot.initialMissionBytes);
      assert.equal(snapshot.runId, runId);
    }

    const enabled = { [integration.ADAPTIVE_SUPERVISION_V1_FEATURE_FLAG]: "1" };
    let invalidInitialExecuted = false;
    await assert.rejects(() => integration.runAdaptiveSupervisionV1Fixture({
      runId: "adaptive-invalid-initial",
      workspaceRoot: workspace,
      stateRoot,
      missionContract: missionContract(),
      initialGaps: gapLedger(),
      strategyA: { ...strategyA(), operations: ["touch_owner_state"] },
      env: enabled,
      classifyMaterialProfile: hostMaterialClassifier,
      planStrategyARetry: justifiedRetryVariation,
      proposeStrategyB: ({ mission: frozen }) => proposalFor(frozen),
      executeStep() {
        invalidInitialExecuted = true;
        return { outcome: "failure", failureSignature: "F", newEvidenceFlag: false, evidenceRefs: [] };
      },
    }), /ADAPTIVE_INITIAL_STRATEGY_REJECTED: SAFETY_ENVELOPE_VIOLATION/);
    assert.equal(invalidInitialExecuted, false, "illegal initial Strategy A is refused before executeStep");

    const negativeFixture = (negativeRunId, proposedStrategy, bResult, classifier = hostMaterialClassifier) => integration.runAdaptiveSupervisionV1Fixture({
      runId: negativeRunId,
      workspaceRoot: workspace,
      stateRoot,
      missionContract: missionContract(),
      initialGaps: gapLedger(),
      strategyA: strategyA(),
      env: enabled,
      classifyMaterialProfile: classifier,
      planStrategyARetry: justifiedRetryVariation,
      proposeStrategyB: ({ mission: frozen }) => proposalFor(frozen, proposedStrategy),
      executeStep: (strategy, attempt) => strategy.strategyFamily === "A"
        ? {
            outcome: "failure",
            failureSignature: "F",
            newEvidenceFlag: attempt === 1,
            evidenceRefs: [],
          }
        : bResult,
    });
    const successfulB = {
      outcome: "success",
      evidence: {
        evidenceRef: "negative-fixture-pass",
        evidenceKind: "fixture-pass",
        gapId: "G1",
        effect: "close",
        acceptanceEligible: true,
      },
    };
    let invalidBudgetAExecuted = false;
    await assert.rejects(() => integration.runAdaptiveSupervisionV1Fixture({
      runId: "adaptive-a-budget-exceeded",
      workspaceRoot: workspace,
      stateRoot,
      missionContract: missionContract(),
      initialGaps: gapLedger(),
      strategyA: { ...strategyA(), resourceBudget: { maxAttempts: 2, resourceUnits: 4, resourceUnitsPerAttempt: 2 } },
      env: enabled,
      classifyMaterialProfile: hostMaterialClassifier,
      planStrategyARetry: justifiedRetryVariation,
      proposeStrategyB: ({ mission: frozen }) => proposalFor(frozen),
      executeStep() {
        invalidBudgetAExecuted = true;
        return { outcome: "failure", failureSignature: "F", newEvidenceFlag: false, evidenceRefs: [] };
      },
    }), /ADAPTIVE_INITIAL_STRATEGY_REJECTED: RESOURCE_BUDGET_EXCEEDED/);
    assert.equal(invalidBudgetAExecuted, false, "Strategy A budget is refused before execution dispatch");

    await assert.rejects(
      () => negativeFixture("adaptive-b-budget-exceeded", {
        ...strategyB(),
        resourceBudget: { maxAttempts: 1, resourceUnits: 2, resourceUnitsPerAttempt: 2 },
      }, successfulB),
      /ADAPTIVE_STRATEGY_B_REJECTED: RESOURCE_BUDGET_EXCEEDED/,
      "Strategy B budget is refused before activation and execution",
    );
    await assert.rejects(
      () => negativeFixture("adaptive-b-off-target", strategyB(), {
        ...successfulB,
        evidence: { ...successfulB.evidence, gapId: "G2" },
      }),
      /ADAPTIVE_FIXTURE_STRATEGY_B_EVIDENCE_OUT_OF_TARGET/,
      "Strategy B cannot close a gap it did not target",
    );
    await assert.rejects(
      () => negativeFixture("adaptive-model-profile-forgery", {
        ...strategyA(),
        strategyId: "strategy-a-forged",
        strategyFamily: "forged-b",
        method: "Paraphrase Method A while claiming a new material profile.",
        materialProfile: structuredClone(strategyB().materialProfile),
      }, successfulB),
      /ADAPTIVE_STRATEGY_B_REJECTED: .*NOT_MATERIALLY_DIFFERENT/,
      "model-supplied material ids are replaced by host classification",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(disabledStateRoot, { recursive: true, force: true });
  }
}

(async function main() {
  const tests = [
    ["mission hash and semantic-progress truth", testMissionHashAndSemanticProgress],
    ["same failure twice exhausts only without new evidence", testSameFailureTwiceRule],
    ["proposal legality and four-decision vocabulary", testProposalLegalityAndDecisionVocabulary],
    ["Stage 3 shadow journal is durable and non-controlling", testStage3ShadowJournalIsDurableAndNonControlling],
    ["default-off same-run durable A-to-B integration", testDefaultOffAndSameRunDurableTransition],
  ];
  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
  console.log("test-adaptive-supervision-foundations: all scenarios passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
