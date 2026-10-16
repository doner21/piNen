#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim()).map(JSON.parse);
}

function makeWorkspace(root, name) {
  const workspace = path.join(root, name);
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

const PRODUCT_CRITERIA = [
  "adaptive-product.txt contains the real Strategy B product result.",
  "The same durable run preserves mission identity and uses one initial approval across A to B.",
  "Strict frozen product acceptance passes without weakening or route-only substitution.",
];

const TASK = [
  "Implement the bounded adaptive product fixture.",
  "",
  "PASS ONLY IF every product condition is independently true:",
  ...PRODUCT_CRITERIA.map((criterion, index) => `${index + 1}. ${criterion}`),
].join("\n");

function baseParams(workspace) {
  return {
    task: TASK,
    cwd: workspace,
    paradigm: "plan-execute-verify",
    supervision: "visible-main",
    preflight: false,
    maxRetries: 0,
    maxSubagents: 6,
    predictedWriteSet: "adaptive-product.txt",
    plannerAgent: "planner",
    plannerProvider: "openai-codex",
    plannerModel: "gpt-5.6-sol",
    executorAgent: "coder",
    executorProvider: "openai-codex",
    executorModel: "gpt-5.6-sol",
    verifierAgent: "reviewer",
    verifierProvider: "openai-codex",
    verifierModel: "gpt-5.5",
  };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-real-canary-"));
  const runs = path.join(temp, "runs");
  const log = path.join(temp, "fake-pi.jsonl");
  fs.mkdirSync(runs, { recursive: true });
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runs;
  process.env.FAKE_PI_LOG = log;
  process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";
  process.env.FAKE_PI_ADAPTIVE_TARGET = "adaptive-product.txt";

  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const extension = jiti(path.join(ROOT, "src", "index.ts")).default;
  const integration = jiti(path.join(ROOT, "src", "adaptive-supervision-integration.ts"));
  let tool;
  extension({
    registerTool(value) { if (value.name === "orchestrate") tool = value; },
    registerCommand() {},
  });
  assert.ok(tool, "the registered public orchestrate tool is available");

  const call = (params, workspace) => tool.execute(
    "adaptive-real-canary-test", params, undefined, () => {}, { cwd: workspace },
  );

  try {
    // Omission and explicit off retain the ordinary generic visible-main path:
    // one planner, one plan checkpoint, and no adaptive artifacts or authority.
    for (const [label, explicitMode] of [["omitted", undefined], ["off", "off"]]) {
      const workspace = makeWorkspace(temp, `default-${label}`);
      const beforeCalls = readLog(log).length;
      const params = { ...baseParams(workspace) };
      delete params.maxSubagents;
      if (explicitMode !== undefined) params.adaptiveSupervision = explicitMode;
      const planned = await call(params, workspace);
      assert.equal(planned.details.status, "awaiting_supervisor");
      assert.equal(planned.details.checkpoint.kind, "plan");
      assert.equal(readLog(log).length, beforeCalls + 1, `${label} mode performs only ordinary planning before approval`);
      const runDir = path.join(runs, planned.details.runId);
      assert.equal(fs.existsSync(path.join(runDir, "adaptive-shadow-v1.jsonl")), false);
      assert.equal(fs.existsSync(path.join(runDir, "adaptive-enforce-canary.json")), false);
      const state = readJson(path.join(runDir, "supervision.json"));
      assert.equal(state.runtime.adapterState.adaptiveSupervision, undefined);
    }

    // Stage 3 is durable, actual, and explicitly observational. Planning writes
    // no synthetic records; the ordinary real executor result is observed only
    // after the visible-main approval and shadow still cannot control dispatch.
    {
      const workspace = makeWorkspace(temp, "shadow");
      const beforeCalls = readLog(log).length;
      process.env.FAKE_PI_EXECUTOR_STYLE = "write-summary-table";
      const planned = await call({
        ...baseParams(workspace),
        predictedWriteSet: "out-1.txt",
        adaptiveSupervision: "shadow-v1",
      }, workspace);
      assert.equal(planned.details.status, "awaiting_supervisor");
      assert.equal(readLog(log).length, beforeCalls + 1, "shadow planning adds no synthetic dispatch");
      let state = readJson(path.join(runs, planned.details.runId, "supervision.json"));
      let shadowMeta = state.runtime.adapterState.adaptiveSupervision;
      assert.deepEqual(
        { mode: shadowMeta.mode, controlledExecution: shadowMeta.controlledExecution, records: shadowMeta.records },
        { mode: "shadow-v1", controlledExecution: false, records: 0 },
      );
      const settled = await call({
        action: "continue",
        runId: planned.details.runId,
        approvalToken: planned.details.approvalToken,
      }, workspace);
      assert.equal(settled.details.status, "awaiting_supervisor");
      assert.equal(readLog(log).length, beforeCalls + 2, "shadow mode uses exactly the ordinary planner and executor");
      state = readJson(path.join(runs, planned.details.runId, "supervision.json"));
      shadowMeta = state.runtime.adapterState.adaptiveSupervision;
      const records = new integration.AdaptiveShadowJournal(shadowMeta.journalFile).readAll();
      assert.equal(records.length, 1, JSON.stringify(shadowMeta));
      assert.equal(records[0].record.controlledExecution, false);
      assert.equal(records[0].record.workflowId, "generic-visible-main-pev");
      assert.deepEqual(
        records[0].record.semanticProgress.strengthenedGapIds,
        state.mission.acceptanceCriteria.map((criterion) => `G-${criterion.id}`),
      );
      assert.equal(records[0].record.currentBehavior.action, "SETTLE_TASK_AND_AWAIT_VISIBLE_MAIN");
      assert.equal(records[0].record.wouldDecide.kind, "CONTINUE");
      assert.equal(shadowMeta.controlledExecution, false);
      delete process.env.FAKE_PI_EXECUTOR_STYLE;
    }

    // Stage 4 public real-run canary: registered tool -> planner -> A -> A ->
    // routed model B proposal -> durably activated B -> strict verifier.
    const workspace = makeWorkspace(temp, "positive");
    const logStart = readLog(log).length;
    const planned = await call({ ...baseParams(workspace), adaptiveSupervision: "enforce-canary-v1" }, workspace);
    assert.equal(planned.details.status, "awaiting_supervisor");
    assert.equal(planned.details.checkpoint.kind, "plan");
    const runId = planned.details.runId;
    const runDir = path.join(runs, runId);
    const initialStateBytes = fs.readFileSync(path.join(runDir, "supervision.json"), "utf8");
    const initialState = JSON.parse(initialStateBytes);
    const frozenCriteria = initialState.mission.acceptanceCriteria.map((item) => item.text);
    assert.equal(PRODUCT_CRITERIA.every((criterion) => frozenCriteria.includes(criterion)), true,
      "every numbered PASS ONLY IF product criterion survives intake into the frozen host mission");
    assert.equal(frozenCriteria.some((item) => /routing|model route/i.test(item)), false,
      "routing is host telemetry and never enters frozen product acceptance");
    assert.ok(initialState.runtime.intake.inferredAdvisoryCriteria.some((item) => /host route check/i.test(item)),
      "requested routes remain visible as host-owned advisories");

    const terminal = await call({
      action: "continue",
      runId,
      approvalToken: planned.details.approvalToken,
    }, workspace);
    assert.equal(terminal.details.status, "terminal");
    assert.equal(terminal.details.terminalOutcome, "pass");
    assert.equal(fs.readFileSync(path.join(workspace, "adaptive-product.txt"), "utf8"),
      "adaptive strategy B executed in the same run\n");

    const calls = readLog(log).slice(logStart);
    assert.deepEqual(calls.map((entry) => entry.adaptivePhase), [
      "canary-planning", "family-a", "family-a", "model-b-proposal", "strategy-b-execution", "strict-verification",
    ], "the real child-process route is planner,A,A,model-B,B,verifier in one run");
    assert.deepEqual(calls.map((entry) => entry.agentName), ["planner", "coder", "coder", "planner", "coder", "reviewer"]);
    assert.deepEqual(calls.map((entry) => `${entry.provider}/${entry.model}`), [
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.5",
    ]);
    const bDispatch = calls.find((entry) => entry.adaptivePhase === "strategy-b-execution");
    assert.deepEqual(bDispatch.adaptivePersistedState, {
      phase: "strategy_b_executing",
      activationDurableBeforeDispatch: true,
      approvalCount: 1,
      reconstructedRun: false,
    }, "the B subprocess observes durable activation and reservation before its own dispatch");

    const finalState = readJson(path.join(runDir, "supervision.json"));
    assert.deepEqual(finalState.mission, initialState.mission, "host frozen mission bytes and hash survive A-to-B");
    assert.equal(finalState.runId, runId);
    assert.ok(finalState.currentApproval.consumedAt, "the sole initial approval was consumed");
    assert.equal(finalState.terminalOutcome, "pass");
    assert.deepEqual(finalState.mission.acceptanceCriteria.map((item) => item.text), frozenCriteria);

    const canary = terminal.details.adaptiveSupervision.state;
    assert.equal(canary.runId, runId);
    assert.equal(canary.reconstructedRun, false);
    assert.equal(canary.approvalCount, 1);
    assert.equal(canary.invariantSnapshot.initialApprovalCount, 1);
    assert.equal(canary.mission.canonicalBytes, canary.invariantSnapshot.missionCanonicalBytes);
    assert.equal(canary.mission.missionHash, canary.invariantSnapshot.missionHash);
    assert.equal(canary.invariantSnapshot.runId, runId);
    assert.deepEqual(canary.mission.contract.acceptanceCriteria, frozenCriteria);
    assert.equal(PRODUCT_CRITERIA.every((criterion) => canary.mission.contract.acceptanceCriteria.includes(criterion)), true);
    assert.equal(canary.invariantSnapshot.acceptanceCriteriaBytes, JSON.stringify(frozenCriteria));
    assert.deepEqual(JSON.parse(canary.invariantSnapshot.safetyScopeBytes), {
      protectedPathsAndPermissions: canary.mission.contract.protectedPathsAndPermissions,
      safetyEnvelope: canary.mission.contract.safetyEnvelope,
    });
    const transitionGaps = JSON.parse(canary.invariantSnapshot.gapLedgerBytesAtTransitionStart);
    assert.deepEqual(transitionGaps.map((gap) => [gap.gapId, gap.status]), [["G0", "closed"], ["G1", "open"]]);
    assert.deepEqual(canary.gaps.map((gap) => [gap.gapId, gap.status]), [["G0", "closed"], ["G1", "closed"]]);
    assert.equal(canary.exhaustedFamilies.includes("family-a-equivalent-no-information"), true);
    assert.deepEqual(canary.decisions.map((decision) => decision.kind), ["CONTINUE", "REPLAN"]);
    assert.equal(canary.proposals.length, 1);
    assert.equal(canary.proposals[0].validation.accepted, true);
    assert.equal(canary.proposals[0].modelProposal.strategy.strategyId, "strategy-b-real-model",
      "the routed proposer output is retained durably, not reconstructed by a callback");
    assert.equal(canary.activations[0].durableBeforeDispatch, true);
    assert.equal(canary.executionReservations.length, 3);
    assert.deepEqual(canary.executionReservations.map((item) => item.strategyFamily), [
      "family-a-equivalent-no-information", "family-a-equivalent-no-information", "family-b-bounded-write-and-test",
    ]);
    assert.deepEqual(canary.strictAcceptance.satisfiedCriteria, frozenCriteria);
    assert.equal(canary.strictAcceptance.passed, true);
    assert.deepEqual(terminal.details.adaptiveSupervision.events.map((event) => event.kind), [
      "created",
      "execution_reserved", "strategy_a_failure_recorded",
      "execution_reserved", "strategy_a_failure_recorded",
      "strategy_b_proposal_recorded", "strategy_b_activated",
      "execution_reserved", "strategy_b_success_recorded", "strict_acceptance_completed",
    ]);
    assert.equal(terminal.details.adaptiveSupervision.secondApprovalIssued, false);

    // Host validation rejects three deceptive/illegal model outputs before B
    // activation or execution. Each uses actual routed A and proposer children.
    for (const [mode, expectedCode] of [
      ["disguised-same-family", "NOT_MATERIALLY_DIFFERENT"],
      ["unsafe", "SAFETY_ENVELOPE_VIOLATION"],
      ["acceptance-weakening", "ACCEPTANCE_OVERRIDE_FORBIDDEN"],
    ]) {
      process.env.FAKE_PI_ADAPTIVE_PROPOSAL = mode;
      const negativeWorkspace = makeWorkspace(temp, `negative-${mode}`);
      const before = readLog(log).length;
      const negativePlan = await call({ ...baseParams(negativeWorkspace), adaptiveSupervision: "enforce-canary-v1" }, negativeWorkspace);
      const rejected = await call({
        action: "continue",
        runId: negativePlan.details.runId,
        approvalToken: negativePlan.details.approvalToken,
      }, negativeWorkspace);
      assert.equal(rejected.details.status, "terminal");
      assert.equal(rejected.details.terminalOutcome, "fail");
      assert.match(rejected.details.adaptiveSupervision.error, new RegExp(expectedCode));
      const negativeCalls = readLog(log).slice(before);
      assert.deepEqual(negativeCalls.map((entry) => entry.adaptivePhase), [
        "canary-planning", "family-a", "family-a", "model-b-proposal",
      ], `${mode} is refused before B dispatch and verifier`);
      const rejectedState = readJson(path.join(runs, negativePlan.details.runId, "adaptive-enforce-canary.json"));
      assert.equal(rejectedState.activations.length, 0);
      assert.equal(rejectedState.proposals[0].validation.accepted, false);
      assert.ok(rejectedState.proposals[0].validation.reasons.some((reason) => reason.code === expectedCode));
      assert.equal(fs.existsSync(path.join(negativeWorkspace, "adaptive-product.txt")), false);
    }
    delete process.env.FAKE_PI_ADAPTIVE_PROPOSAL;

    // Unsupported adaptive use fails before provider preflight or any child.
    const unsupportedWorkspace = makeWorkspace(temp, "unsupported");
    const beforeUnsupported = readLog(log).length;
    await assert.rejects(() => call({
      ...baseParams(unsupportedWorkspace),
      adaptiveSupervision: "enforce-canary-v1",
      paradigm: "verify-only",
    }, unsupportedWorkspace), /ADAPTIVE_SUPERVISION_UNSUPPORTED_PARADIGM/);
    assert.equal(readLog(log).length, beforeUnsupported);

    const offWorkspace = makeWorkspace(temp, "unsupported-supervision-off");
    await assert.rejects(() => call({
      ...baseParams(offWorkspace),
      adaptiveSupervision: "enforce-canary-v1",
      supervision: "off",
    }, offWorkspace), /ADAPTIVE_SUPERVISION_REQUIRES_VISIBLE_MAIN/);
    assert.equal(readLog(log).length, beforeUnsupported);

    console.log("test-adaptive-supervision-real-canary: public shadow and real A,A,model-B,B canary scenarios passed");
  } finally {
    for (const key of [
      "PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "FAKE_PI_LOG", "FAKE_PI_PLAN_STYLE",
      "FAKE_PI_ADAPTIVE_TARGET", "FAKE_PI_ADAPTIVE_PROPOSAL", "FAKE_PI_ADAPTIVE_VERIFY_FAIL", "FAKE_PI_EXECUTOR_STYLE",
    ]) delete process.env[key];
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
