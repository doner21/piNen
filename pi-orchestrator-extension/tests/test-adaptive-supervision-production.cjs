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
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

const CRITERIA = [
  "adaptive-product.txt contains the production Strategy B result.",
  "The same durable run preserves frozen mission identity through real replanning.",
  "Strict product verification passes without acceptance substitution.",
];
const TASK = [
  "Repair the bounded adaptive production fixture.",
  "",
  "PASS ONLY IF every condition is independently true:",
  ...CRITERIA.map((criterion, index) => `${index + 1}. ${criterion}`),
].join("\n");

function params(workspace, mode = "adaptive-v1") {
  return {
    task: TASK,
    cwd: workspace,
    paradigm: "plan-execute-verify",
    supervision: "visible-main",
    adaptiveSupervision: mode,
    preflight: false,
    maxRetries: 0,
    maxSubagents: 7,
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-production-"));
  const runs = path.join(temp, "runs");
  const log = path.join(temp, "fake-pi.jsonl");
  fs.mkdirSync(runs, { recursive: true });
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runs;
  process.env.FAKE_PI_LOG = log;
  process.env.FAKE_PI_ADAPTIVE_PRODUCTION = "1";
  process.env.FAKE_PI_ADAPTIVE_TARGET = "adaptive-product.txt";

  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const extension = jiti(path.join(ROOT, "src", "index.ts")).default;
  let tool;
  extension({
    registerTool(value) { if (value.name === "orchestrate") tool = value; },
    registerCommand() {},
  });
  assert.ok(tool);
  const call = (input, workspace) => tool.execute("adaptive-production-test", input, undefined, () => {}, { cwd: workspace });

  try {
    // Omitted/off remains ordinary visible-main and creates no production authority.
    for (const label of ["omitted", "off"]) {
      const workspace = path.join(temp, `default-${label}`);
      fs.mkdirSync(workspace);
      const input = params(workspace);
      delete input.adaptiveSupervision;
      if (label === "off") input.adaptiveSupervision = "off";
      process.env.FAKE_PI_ADAPTIVE_PRODUCTION = "0";
      process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";
      const planned = await call(input, workspace);
      assert.equal(planned.details.status, "awaiting_supervisor");
      assert.equal(fs.existsSync(path.join(runs, planned.details.runId, "adaptive-v1.json")), false);
    }
    process.env.FAKE_PI_ADAPTIVE_PRODUCTION = "1";
    delete process.env.FAKE_PI_PLAN_STYLE;

    const workspace = path.join(temp, "positive");
    fs.mkdirSync(workspace);
    const logStart = readLog(log).length;
    const planned = await call(params(workspace), workspace);
    assert.equal(planned.details.status, "awaiting_supervisor");
    assert.equal(planned.details.checkpoint.kind, "plan");
    const runId = planned.details.runId;
    const runDir = path.join(runs, runId);
    assert.equal(fs.existsSync(path.join(runDir, "adaptive-v1.json")), false, "production state starts only after initial approval");
    const frozen = readJson(path.join(runDir, "supervision.json")).mission;
    assert.equal(CRITERIA.every((criterion) => frozen.acceptanceCriteria.some((item) => item.text === criterion)), true);

    const terminal = await call({ action: "continue", runId, approvalToken: planned.details.approvalToken }, workspace);
    assert.equal(terminal.details.status, "terminal");
    assert.equal(terminal.details.terminalOutcome, "pass", JSON.stringify(terminal.details));
    assert.equal(fs.readFileSync(path.join(workspace, "adaptive-product.txt"), "utf8"), "adaptive production Strategy B completed\n");

    const calls = readLog(log).slice(logStart);
    assert.deepEqual(calls.map((entry) => entry.adaptivePhase), [
      "production-planning",
      "production-strategy-a",
      "production-strategy-a-retry",
      "production-replan",
      "production-strategy-b",
      null,
    ]);
    assert.deepEqual(calls.map((entry) => [entry.agentName, entry.provider, entry.model]), [
      ["planner", "openai-codex", "gpt-5.6-sol"],
      ["coder", "openai-codex", "gpt-5.6-sol"],
      ["coder", "openai-codex", "gpt-5.6-sol"],
      ["planner", "openai-codex", "gpt-5.6-sol"],
      ["coder", "openai-codex", "gpt-5.6-sol"],
      ["reviewer", "openai-codex", "gpt-5.5"],
    ], "every production phase uses its configured real route");
    const bDispatch = calls.find((entry) => entry.adaptivePhase === "production-strategy-b");
    assert.equal(bDispatch.adaptivePersistedState.phase, "strategy_executing");
    assert.equal(bDispatch.adaptivePersistedState.activationDurableBeforeDispatch, true);
    assert.equal(bDispatch.adaptivePersistedState.approvalCount, 1);
    assert.equal(bDispatch.adaptivePersistedState.reconstructedRun, false);
    assert.deepEqual(bDispatch.adaptivePersistedState.eventKinds.slice(-3), [
      "proposal_recorded", "replacement_activated", "execution_reserved",
    ], "proposal and activation are fsynced/readable before Strategy B child dispatch");
    const finalHost = readJson(path.join(runDir, "supervision.json"));
    assert.deepEqual(finalHost.mission, frozen, "frozen host mission survives production replanning");
    assert.equal(finalHost.runId, runId);
    assert.equal(finalHost.currentApproval.consumedAt.length > 0, true);

    const adaptive = terminal.details.adaptiveSupervision;
    assert.equal(adaptive.mode, "adaptive-v1");
    assert.equal(adaptive.approvalCount, 1);
    assert.equal(adaptive.secondApprovalIssued, false);
    assert.equal(adaptive.state.runId, runId);
    assert.equal(adaptive.state.hostMissionHash, frozen.missionHash);
    assert.equal(adaptive.state.reconstructedRun, false);
    assert.equal(adaptive.state.phase, "completed");
    assert.deepEqual(adaptive.state.decisions.map((decision) => decision.kind), ["CONTINUE", "REPLAN"]);
    assert.equal(adaptive.state.exhaustedFamilies.length, 1);
    assert.equal(adaptive.state.strategyHistory.length, 2);
    assert.equal(adaptive.state.activations[0].durableBeforeDispatch, true);
    assert.equal(adaptive.state.executionReservations.length, 3);
    assert.equal(adaptive.state.gaps.every((gap) => gap.status === "closed"), true);
    assert.deepEqual(adaptive.state.strictAcceptance.satisfiedCriteria, adaptive.state.mission.contract.acceptanceCriteria);
    assert.deepEqual(adaptive.events.map((event) => event.kind), [
      "created",
      "execution_reserved", "failure_recorded",
      "execution_reserved", "failure_recorded",
      "proposal_recorded", "replacement_activated",
      "execution_reserved", "success_recorded",
      "strict_acceptance_completed",
    ]);
    adaptive.events.forEach((event, index) => {
      assert.equal(event.sequence, index + 1);
      assert.equal(event.previousEventHash, index ? adaptive.events[index - 1].eventHash : null);
    });
    assert.equal(adaptive.state.observations.length, 2);
    assert.equal(adaptive.state.observations[0].normalizedFailureSignature, adaptive.state.observations[1].normalizedFailureSignature);
    assert.equal(adaptive.state.observations[1].newEvidenceFlag, false, "two equivalent no-information A failures force production replanning");

    async function runProposalFormat(mode, expectedReplanPhases) {
      process.env.FAKE_PI_ADAPTIVE_PROPOSAL = mode;
      const formatWorkspace = path.join(temp, `proposal-${mode}`);
      fs.mkdirSync(formatWorkspace);
      const before = readLog(log).length;
      const formatPlan = await call(params(formatWorkspace), formatWorkspace);
      const result = await call({
        action: "continue",
        runId: formatPlan.details.runId,
        approvalToken: formatPlan.details.approvalToken,
      }, formatWorkspace);
      assert.equal(result.details.terminalOutcome, "pass", `${mode}: ${JSON.stringify(result.details)}`);
      const formatCalls = readLog(log).slice(before);
      assert.deepEqual(
        formatCalls.filter((entry) => entry.adaptivePhase?.startsWith("production-replan")).map((entry) => entry.adaptivePhase),
        expectedReplanPhases,
      );
      for (const entry of formatCalls.filter((item) => item.adaptivePhase?.startsWith("production-replan"))) {
        assert.deepEqual([entry.agentName, entry.provider, entry.model], ["planner", "openai-codex", "gpt-5.6-sol"]);
      }
      const dispatch = formatCalls.find((entry) => entry.adaptivePhase === "production-strategy-b");
      assert.deepEqual(dispatch.adaptivePersistedState.eventKinds.slice(-3), [
        "proposal_recorded", "replacement_activated", "execution_reserved",
      ]);
      assert.equal(result.details.adaptiveSupervision.approvalCount, 1);
      assert.equal(result.details.adaptiveSupervision.secondApprovalIssued, false);
    }

    await runProposalFormat("wrapped", ["production-replan"]);
    await runProposalFormat("unambiguous-prose", ["production-replan"]);
    await runProposalFormat("malformed-then-wrapped", ["production-replan", "production-replan-repair"]);
    await runProposalFormat("empty-then-fenced", ["production-replan", "production-replan-repair"]);

    process.env.FAKE_PI_ADAPTIVE_PROPOSAL = "invalid-twice";
    {
      const invalidWorkspace = path.join(temp, "proposal-invalid-twice");
      fs.mkdirSync(invalidWorkspace);
      const before = readLog(log).length;
      const invalidPlan = await call(params(invalidWorkspace), invalidWorkspace);
      const invalid = await call({
        action: "continue",
        runId: invalidPlan.details.runId,
        approvalToken: invalidPlan.details.approvalToken,
      }, invalidWorkspace);
      assert.equal(invalid.details.terminalOutcome, "fail");
      assert.match(invalid.details.error.message, /ADAPTIVE_PRODUCTION_PLANNER_PROPOSAL_SCHEMA_INCOMPLETE/);
      assert.doesNotMatch(invalid.details.error.message, /CANARY/);
      assert.match(invalid.details.error.message, /single production schema-repair retry was exhausted/i);
      const invalidCalls = readLog(log).slice(before);
      assert.deepEqual(
        invalidCalls.filter((entry) => entry.adaptivePhase?.startsWith("production-replan")).map((entry) => entry.adaptivePhase),
        ["production-replan", "production-replan-repair"],
      );
      assert.equal(invalidCalls.some((entry) => entry.adaptivePhase === "production-strategy-b"), false);
      const invalidState = readJson(path.join(runs, invalidPlan.details.runId, "adaptive-v1.json"));
      assert.equal(invalidState.phase, "failed");
      assert.equal(invalidState.proposals.length, 0, "host never synthesizes a proposal after invalid planner output");
      const invalidEvents = readLog(path.join(runs, invalidPlan.details.runId, "adaptive-v1.events.jsonl"));
      assert.equal(invalidEvents.some((event) => event.kind === "proposal_recorded" || event.kind === "replacement_activated"), false);
    }

    // Illegal model-authored replacements are rejected before activation/B execution.
    for (const [mode, code] of [
      ["disguised-same-family", "NOT_MATERIALLY_DIFFERENT"],
      ["unsafe", "SAFETY_ENVELOPE_VIOLATION"],
      ["acceptance-weakening", "ACCEPTANCE_OVERRIDE_FORBIDDEN"],
    ]) {
      process.env.FAKE_PI_ADAPTIVE_PROPOSAL = mode;
      const negativeWorkspace = path.join(temp, `negative-${mode}`);
      fs.mkdirSync(negativeWorkspace);
      const before = readLog(log).length;
      const negativePlan = await call(params(negativeWorkspace), negativeWorkspace);
      const rejected = await call({
        action: "continue",
        runId: negativePlan.details.runId,
        approvalToken: negativePlan.details.approvalToken,
      }, negativeWorkspace);
      assert.equal(rejected.details.status, "terminal");
      assert.equal(rejected.details.terminalOutcome, "fail");
      assert.equal(rejected.details.approvalToken, undefined, "adaptive rejection never issues a second approval");
      assert.match(rejected.details.error.message, new RegExp(code));
      const negativeState = readJson(path.join(runs, negativePlan.details.runId, "adaptive-v1.json"));
      assert.equal(negativeState.phase, "failed");
      assert.equal(negativeState.activations.length, 0);
      assert.equal(negativeState.proposals[0].validation.accepted, false);
      assert.equal(fs.existsSync(path.join(negativeWorkspace, "adaptive-product.txt")), false);
      assert.equal(readLog(log).slice(before).some((entry) => entry.adaptivePhase === "production-strategy-b"), false);
    }

    delete process.env.FAKE_PI_ADAPTIVE_PROPOSAL;

    // A strict-verifier failure closes both host and adaptive state as terminal
    // FAIL and never creates an ordinary repair approval loop.
    {
      process.env.FAKE_PI_VISIBLE_VERIFY_FAIL = "1";
      const verifierWorkspace = path.join(temp, "verifier-fail");
      fs.mkdirSync(verifierWorkspace);
      const verifierPlan = await call(params(verifierWorkspace), verifierWorkspace);
      const verifierFail = await call({
        action: "continue",
        runId: verifierPlan.details.runId,
        approvalToken: verifierPlan.details.approvalToken,
      }, verifierWorkspace);
      assert.equal(verifierFail.details.status, "terminal");
      assert.equal(verifierFail.details.terminalOutcome, "fail");
      assert.equal(verifierFail.details.approvalToken, undefined);
      const adaptiveFail = readJson(path.join(runs, verifierPlan.details.runId, "adaptive-v1.json"));
      assert.equal(adaptiveFail.phase, "failed");
      assert.equal(adaptiveFail.failure.code, "ADAPTIVE_PRODUCTION_STRICT_VERIFIER_FAILED");
      delete process.env.FAKE_PI_VISIBLE_VERIFY_FAIL;
    }

    // A replacement that produces an out-of-contract byte effect is terminal,
    // persists adaptive failure after the reservation, and cannot be replayed
    // through a newly issued approval.
    {
      process.env.FAKE_PI_ADAPTIVE_B_OUTSIDE = "1";
      const scopeWorkspace = path.join(temp, "scope-fail");
      fs.mkdirSync(scopeWorkspace);
      const scopePlan = await call(params(scopeWorkspace), scopeWorkspace);
      const scopeFail = await call({
        action: "continue",
        runId: scopePlan.details.runId,
        approvalToken: scopePlan.details.approvalToken,
      }, scopeWorkspace);
      assert.equal(scopeFail.details.status, "terminal");
      assert.equal(scopeFail.details.terminalOutcome, "fail");
      assert.equal(scopeFail.details.approvalToken, undefined);
      assert.match(scopeFail.details.error.message, /ADAPTIVE_PRODUCTION_SCOPE_VIOLATION/);
      const adaptiveFail = readJson(path.join(runs, scopePlan.details.runId, "adaptive-v1.json"));
      assert.equal(adaptiveFail.phase, "failed");
      assert.equal(adaptiveFail.failure.code, "ADAPTIVE_PRODUCTION_EXECUTION_FAILED");
      delete process.env.FAKE_PI_ADAPTIVE_B_OUTSIDE;
    }

    console.log("test-adaptive-supervision-production: real task failure, durable replan, replacement execution, strict acceptance, terminal safety failures, and rejections passed");
  } finally {
    for (const key of [
      "PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "FAKE_PI_LOG", "FAKE_PI_ADAPTIVE_PRODUCTION",
      "FAKE_PI_ADAPTIVE_TARGET", "FAKE_PI_ADAPTIVE_PROPOSAL", "FAKE_PI_ADAPTIVE_B_OUTSIDE",
      "FAKE_PI_VISIBLE_VERIFY_FAIL", "FAKE_PI_PLAN_STYLE",
    ]) delete process.env[key];
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
