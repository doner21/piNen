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
function makeJiti() { return createJiti(__filename, { interopDefault: true, moduleCache: false }); }

const SHAPE_PATH = path.join(PROJECT_ROOT, "src", "shapes", "composable-pipeline.ts");

function baseParams(tmp, task, maxRetries = 0, maxSubagents = 20, extraParams = {}) {
  return {
    task, cwd: tmp, maxSubagents, maxSubagentsExplicit: true, maxRetries,
    maxRetriesExplicit: true, allowLocalModel: false,
    executorAgent: "coder", verifierAgent: "reviewer", plannerAgent: "planner",
    concurrency: 5, plannerCount: 1, verifierCount: 1,
    hardGates: "advisory", preflight: false, discoveryOnly: false,
    orchestrationControls: { runtimeRoles: [], rawMatches: [] },
    ...extraParams,
  };
}

async function drive(task, {
  maxRetries = 0,
  maxSubagents = 20,
  verifierSequence = "pass",
  verifierArtifact = false,
  extraParams = {},
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-order-retry-"));
  const logPath = path.join(tmp, "calls.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_COMPOSABLE_ORDER_RETRY = "1";
  process.env.FAKE_PI_COMPOSABLE_VERIFIER_SEQUENCE = verifierSequence;
  if (verifierArtifact) process.env.FAKE_PI_COMPOSABLE_VERIFIER_ARTIFACT = "1";
  try {
    const shape = makeJiti()(SHAPE_PATH).composablePipelineShape;
    const result = await shape.run({
      params: baseParams(tmp, task, maxRetries, maxSubagents, extraParams),
      agents: new Map(),
      inferredModelRouting: {},
      onUpdate: () => {},
    });
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    return { result, calls };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_COMPOSABLE_ORDER_RETRY;
    delete process.env.FAKE_PI_COMPOSABLE_VERIFIER_SEQUENCE;
    delete process.env.FAKE_PI_COMPOSABLE_VERIFIER_ARTIFACT;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function rejectBeforeSpawn(task, expectedCode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-order-reject-"));
  const logPath = path.join(tmp, "calls.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const shape = makeJiti()(SHAPE_PATH).composablePipelineShape;
    await assert.rejects(
      () => shape.run({
        params: baseParams(tmp, task, 0, 20),
        agents: new Map(), inferredModelRouting: {}, onUpdate: () => {},
      }),
      (error) => {
        assert.equal(error.name, "PipelineConfigurationError");
        assert.match(error.message, /COMPOSABLE_PIPELINE_CONFIG/);
        if (expectedCode) assert.equal(error.code, expectedCode);
        return true;
      },
    );
    assert.equal(fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim() : "", "",
      `invalid pipeline must fail before any spawn: ${task}`);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testExactCanaryOrderAndDataflow() {
  const task = "Only run these phases in this exact order: reconnaissance, plan x2, critique, synthesize, execute, verify x2.";
  const { result, calls } = await drive(task);
  const expectedPipeline = [
    ["research", 1], ["plan", 2], ["critique", 1], ["synthesize", 1], ["execute", 1], ["verify", 2],
  ];
  assert.deepEqual(result.details.pipeline.map(({ kind, count }) => [kind, count]), expectedPipeline);
  assert.deepEqual(calls.map((call) => call.composablePhase),
    ["research", "plan", "plan", "critique", "synthesize", "execute", "verify", "verify"]);
  assert.equal(calls.filter((call) => call.composablePhase === "plan").length, 2);
  assert.equal(calls.find((call) => call.composablePhase === "critique").candidatePlanCount, 2,
    "critique must receive both candidate plans");
  assert.equal(calls.find((call) => call.composablePhase === "synthesize").candidatePlanCount, 2,
    "synthesis must receive both candidate plans plus prior critiques");
  assert.equal(calls.find((call) => call.composablePhase === "execute").promptHasFinalSynthesizedPlan, true,
    "executor must receive the parseable final plan produced by synthesis");
  assert.equal(result.details.candidatePlans.length, 2);
  assert.equal(result.details.finalPlanSource, "synthesis");
  assert.equal(result.details.plan.notes, "fixture final plan from synthesis");
  assert.equal(result.details.attempts.length, 1);
  assert.equal(result.details.routingEvidence.length, calls.length,
    "every composed seat must produce structured route evidence");
  assert.deepEqual(result.details.actualCardinality.map(({ kind, spawned }) => [kind, spawned]), expectedPipeline,
    "reported cardinality must equal actual initial phase spawns");
  for (const call of calls) {
    const expected = call.composablePhase === "verify" ? "gpt-5.5" : "gpt-5.6-sol";
    assert.deepEqual([call.provider, call.model], ["openai-codex", expected]);
    assert.doesNotMatch(`${call.provider}/${call.model}`, /deepseek|openrouter/i);
  }
}

async function testIncidentalNegationDoesNotEraseExecute() {
  const task = "Only run these phases in this exact order: plan, execute, verify. No execution before the EXECUTE phase.";
  const { result, calls } = await drive(task);
  assert.deepEqual(result.details.pipeline.map(({ kind }) => kind), ["plan", "execute", "verify"]);
  assert.deepEqual(calls.map((call) => call.composablePhase), ["plan", "execute", "verify"]);
}

async function testContradictoryAndMissingExecuteFailClosed() {
  await rejectBeforeSpawn(
    "Implement the tiny fixture. Only run these phases in this exact order: plan, execute, verify. Explicitly skip execute.",
    "CONTRADICTORY_SKIP_EXECUTE",
  );
  await rejectBeforeSpawn(
    "Implement the tiny fixture. Only run these phases in this exact order: research, plan, verify.",
    "IMPLEMENTATION_PIPELINE_OMITS_EXECUTE",
  );

  // The limiter clause, not unrelated implementation intent before it,
  // declares the legacy phase list. This exact counterexample must reject
  // before fake-pi records any call.
  await rejectBeforeSpawn(
    "Implement the fixture. Only plan and verify.",
    "IMPLEMENTATION_PIPELINE_OMITS_EXECUTE",
  );

  // Attempt-2 residual: unordered/legacy composition must enforce the same
  // implementation invariant before the fake runtime can log a spawn.
  await rejectBeforeSpawn(
    "Fix the fixture. Only plan and verify. Explicitly skip execute.",
    "CONTRADICTORY_SKIP_EXECUTE",
  );
  await rejectBeforeSpawn(
    "Fix the fixture. Only plan and verify.",
    "IMPLEMENTATION_PIPELINE_OMITS_EXECUTE",
  );
  await rejectBeforeSpawn(
    "Repair the fixture with plan and verify; omit execution.",
    "CONTRADICTORY_SKIP_EXECUTE",
  );
  await rejectBeforeSpawn(
    "Build the fixture with plan and verify, without execute.",
    "CONTRADICTORY_SKIP_EXECUTE",
  );
  for (const task of [
    "Implement the fixture with plan and verify. No execute.",
    "IMPLEMENT the fixture with plan and verify — NO EXECUTION!",
    "Repair the fixture with plan and verify; no-executor phase.",
    "Create the fixture with plan and verify: do not execute.",
    "Modify the fixture with plan and verify; execution is prohibited.",
  ]) {
    await rejectBeforeSpawn(task, "CONTRADICTORY_SKIP_EXECUTE");
  }

  const readOnly = await drive("Analyze the fixture. Only plan and verify.");
  assert.deepEqual(readOnly.result.details.pipeline.map(({ kind }) => kind), ["plan", "verify"]);
  assert.deepEqual(readOnly.calls.map((call) => call.composablePhase), ["plan", "verify"],
    "a read-only plan/verify-only request must remain valid");
  assert.equal(readOnly.calls.length, 2, "read-only neighbor must make exactly two fake calls");

  const implementation = await drive("Implement the fixture. Only plan, execute, and verify.");
  assert.deepEqual(implementation.result.details.pipeline.map(({ kind }) => kind), ["plan", "execute", "verify"]);
  assert.deepEqual(implementation.calls.map((call) => call.composablePhase), ["plan", "execute", "verify"]);
  assert.equal(implementation.calls.length, 3, "valid implementation neighbor must make exactly three fake calls");

  const longReadOnly = await drive(
    "Analyze the fixture. Only plan and verify, with a concise report that reviews prior research and synthesis.",
  );
  assert.deepEqual(longReadOnly.result.details.pipeline.map(({ kind }) => kind), ["plan", "verify"],
    "phase words in prose after the controlled list must not expand the limiter");
  assert.equal(longReadOnly.calls.length, 2, "trailing prose must not add fake calls");
}

async function testExecuteOnlyAndArrowAuthority() {
  const executeOnly = await drive(
    "Implement the fixture. Only run these phases in this exact order: execute.",
  );
  assert.deepEqual(executeOnly.result.details.pipeline.map(({ kind, count }) => [kind, count]),
    [["execute", 1]]);
  assert.deepEqual(executeOnly.calls.map((call) => call.composablePhase), ["execute"]);
  assert.equal(executeOnly.result.details.voteResult, null, "execute-only must not inject a verifier");
  assert.equal(executeOnly.result.details.candidatePlans.length, 0, "execute-only must not inject planning");
  assert.deepEqual(executeOnly.result.details.actualCardinality,
    [{ kind: "execute", declared: 1, spawned: 1 }]);

  const arrow = await drive(
    "Implement the fixture using this authoritative topology: reconnaissance -> plan x2 -> critique -> synthesize -> execute -> verify x2. Do not add phases.",
  );
  assert.deepEqual(arrow.result.details.pipeline.map(({ kind, count }) => [kind, count]), [
    ["research", 1], ["plan", 2], ["critique", 1], ["synthesize", 1], ["execute", 1], ["verify", 2],
  ], "surrounding implementation prose must not become an extra ordered phase");
  assert.equal(arrow.calls.length, 8);
}

async function testVerifierArtifactCleanup() {
  const { result } = await drive(
    "Only run these phases in this exact order: plan, execute, verify.",
    { verifierArtifact: true },
  );
  const raw = result.details.voteResult.votes[0].raw;
  const payload = JSON.parse(raw);
  assert.ok(payload.cleanupArtifact, "fixture must create a verifier artifact in the run-owned directory");
  assert.equal(fs.existsSync(payload.cleanupArtifact), false,
    "verifier artifact directory must be removed before the shape returns");
}

async function testRolePreflightAndExecutorFallback() {
  const { result, calls } = await drive(
    "Only run these phases in this exact order: plan, execute, verify.",
    {
      extraParams: {
        preflight: true,
        executorProvider: "badprov",
        executorModel: "bad-primary",
        executorFallbackProvider: "openai-codex",
        executorFallbackModel: "gpt-5.5",
      },
    },
  );
  const workCalls = calls.filter((call) => call.composablePhase);
  assert.deepEqual(workCalls.map((call) => call.composablePhase), ["plan", "execute", "verify"]);
  const executor = workCalls.find((call) => call.composablePhase === "execute");
  assert.deepEqual([executor.provider, executor.model], ["openai-codex", "gpt-5.5"]);
  assert.deepEqual(result.details.selectedRoutes.executor,
    { provider: "openai-codex", model: "gpt-5.5" });
  assert.ok(result.details.preflightEvidence.some((item) =>
    item.role === "executor" && item.status === "failed" && !item.selected));
  assert.ok(result.details.preflightEvidence.some((item) =>
    item.role === "executor" && item.status === "healthy" && item.selected));
  assert.equal(result.details.routingEvidence.length, workCalls.length);
  assert.ok(calls.every((call) => !/deepseek|openrouter/i.test(`${call.provider}/${call.model}`)));
}

async function testExplicitInvalidCountsFailBeforeSpawn() {
  // Exact attempt-2 reproducer.
  await rejectBeforeSpawn("only plan x0 and verify", "PHASE_COUNT_OUT_OF_BOUNDS");

  // Every phase accepts both multiplier glyphs on either side of its canonical
  // alias, but an explicit zero is never allowed to fall back to count 1.
  for (const alias of ["research", "hypothesize", "critique", "synthesize", "plan", "execute", "verify"]) {
    for (const task of [
      `only ${alias} x0`,
      `only ${alias} ×0`,
      `only x0 ${alias}`,
      `only ×0 ${alias}`,
    ]) {
      await rejectBeforeSpawn(task, "PHASE_COUNT_OUT_OF_BOUNDS");
    }
  }

  await rejectBeforeSpawn("only plan x-1 and verify", "PHASE_COUNT_OUT_OF_BOUNDS");
  await rejectBeforeSpawn("only plan xInfinity and verify", "PHASE_COUNT_OUT_OF_BOUNDS");
  await rejectBeforeSpawn("only ×NaN plan and verify", "PHASE_COUNT_OUT_OF_BOUNDS");
  await rejectBeforeSpawn(`only plan x${"9".repeat(400)} and verify`, "PHASE_COUNT_OUT_OF_BOUNDS");
  await rejectBeforeSpawn(
    "Only run these phases in this exact order: plan ×0, verify.",
    "PHASE_COUNT_OUT_OF_BOUNDS",
  );
}

async function testRetryPolicy() {
  const task = "Only run these phases in this exact order: plan, execute, verify x2.";

  const noRetry = await drive(task, { maxRetries: 0, verifierSequence: "fail" });
  assert.equal(noRetry.calls.filter((call) => call.composablePhase === "execute").length, 1);
  assert.equal(noRetry.calls.filter((call) => call.composablePhase === "verify").length, 2);
  assert.equal(noRetry.result.details.attempts.length, 1);

  const oneRetry = await drive(task, { maxRetries: 1, verifierSequence: "fail" });
  assert.equal(oneRetry.calls.filter((call) => call.composablePhase === "plan").length, 1,
    "planning must not repeat");
  assert.equal(oneRetry.calls.filter((call) => call.composablePhase === "execute").length, 2);
  assert.equal(oneRetry.calls.filter((call) => call.composablePhase === "verify").length, 4);
  assert.equal(oneRetry.result.details.attempts.length, 2);
  assert.deepEqual(oneRetry.result.details.attempts.map((attempt) => attempt.status), ["fail", "fail"]);

  const passFirst = await drive(task, { maxRetries: 1, verifierSequence: "pass" });
  assert.equal(passFirst.calls.filter((call) => call.composablePhase === "execute").length, 1);
  assert.equal(passFirst.calls.filter((call) => call.composablePhase === "verify").length, 2);
  assert.equal(passFirst.result.details.attempts.length, 1, "PASS must stop retries immediately");
}

function testLegacyParsingAndFullWave() {
  const { parsePipelineConfig } = makeJiti()(SHAPE_PATH);
  const compact = (text) => parsePipelineConfig(text).phases.map(({ kind, count }) => [kind, count]);
  assert.deepEqual(compact("research x2, 3 planners, critique ×2, verify x2"),
    [["research", 2], ["critique", 2], ["plan", 3], ["verify", 2]],
    "legacy unordered prose keeps canonical order and prefix/suffix cardinality aliases");
  assert.deepEqual(compact("full wave"), [
    ["hypothesize", 1], ["critique", 1], ["synthesize", 1],
    ["plan", 1], ["execute", 1], ["verify", 1],
  ], "legacy full wave remains the original six-phase pipeline");
}

async function run() {
  await testExactCanaryOrderAndDataflow();
  await testIncidentalNegationDoesNotEraseExecute();
  await testContradictoryAndMissingExecuteFailClosed();
  await testExecuteOnlyAndArrowAuthority();
  await testVerifierArtifactCleanup();
  await testRolePreflightAndExecutorFallback();
  await testExplicitInvalidCountsFailBeforeSpawn();
  await testRetryPolicy();
  testLegacyParsingAndFullWave();
  console.log("PASS composable-pipeline-order-retry: ordered canary/dataflow, authoritative execute, fail-closed contradictions/counts, bounded execute-verify retries, legacy aliases/full-wave");
}

run().catch((error) => {
  console.error("test-composable-pipeline-order-retry: FAIL");
  console.error(error);
  process.exit(1);
});
