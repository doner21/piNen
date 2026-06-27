#!/usr/bin/env node
/**
 * Judgment-layer hardening regression fixtures
 * ============================================
 * Modeled on real transcripts per INTAKE_ORCHESTRATE_HARDENING.md:
 *
 * 1a. Ramen Don false-FAIL pattern (2026-06-11/12): executor performs real
 *     file writes via tools and replies with a summary table → must PASS,
 *     with text-shape heuristics demoted to warnings.
 * 1b. 2026-06-03 false-PASS pattern: verifier says PASS but zero artifacts
 *     exist → must FAIL with effect-contradiction evidence.
 * 2.  verify-only paradigm: completes with verifier spawns only — no
 *     planner/executor spawns, no implementation-heuristic gating.
 * 3.  Retry targeting (F2): 3-task plan, task-2 fails once → attempt 2
 *     re-executes ONLY task-2; task-1/task-3 are reused.
 * 4.  Pre-flight (F5): invalid provider → clean structured error before any
 *     work subagent spawn; partial report emitted.
 * 5.  Normalizer provenance (F6): a task with no output-format requirement
 *     produces a contract with zero inferred-criteria failures possible.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
);

process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function loadOrchestrateTool() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const mod = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({
    registerTool(definition) {
      if (definition.name === "orchestrate") tool = definition;
    },
    registerCommand() {},
  });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

const SCENARIO_ENV_KEYS = [
  "FAKE_PI_PLAN_STYLE",
  "FAKE_PI_EXECUTOR_STYLE",
  "FAKE_PI_VERIFIER_SEQUENCE",
  "FAKE_PI_VERIFIER_STATUS",
  "FAKE_PI_CONFLICT_EXECUTOR_ROUTE",
];

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orchestrate-judgment-"));
  const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", windowsHide: true });
  assert.equal(init.status, 0, `git init should succeed: ${init.stderr}`);
  return dir;
}

async function runScenario(task, { env = {}, params = {}, cwd } = {}) {
  const workDir = cwd ?? makeTempGitRepo();
  const logPath = path.join(workDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  for (const key of SCENARIO_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-judgment-hardening",
      { task, cwd: workDir, ...params },
      undefined,
      () => {},
      { cwd: workDir },
    );
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim() : "";
    const calls = logText ? logText.split("\n").map((line) => JSON.parse(line)) : [];
    return { result, calls, workDir };
  } finally {
    for (const key of SCENARIO_ENV_KEYS) delete process.env[key];
  }
}

// ── 1a. False-FAIL regression: real writes + summary-table reply → PASS ────
async function testFalseFailRegression() {
  const { result, calls, workDir } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0 },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  const details = result.details;

  assert.match(markdown, /# Orchestration Result: PASS/,
    "executor that performed real tool-based writes and replied with a summary table MUST PASS (F1)");
  assert.ok(fs.existsSync(path.join(workDir, "out-1.txt")), "fixture artifact should exist on disk");

  // Effect evidence captured: mutating tool calls recorded for the task.
  const ledgerEntry = details.taskLedger.find((entry) => entry.taskId === "task-1");
  assert.ok(ledgerEntry, "task-1 should be in the task ledger");
  assert.equal(ledgerEntry.verdict, "passed");
  assert.ok(ledgerEntry.mutatingToolCalls > 0, "mutating tool calls should be recorded as effect evidence");

  // Text-shape heuristics demoted: any findings appear as warnings, never as
  // hard-gate failure reasons.
  assert.ok(!markdown.includes("Post-execution hard gate"),
    "no text-shape heuristic may determine the verdict in advisory mode");
  assert.equal(details.hardGates, "advisory", "default hardGates mode should be advisory");

  const coderCalls = calls.filter((call) => call.agentName === "coder");
  assert.equal(coderCalls.length, 1, "exactly one executor spawn expected");
}

// ── 1b. False-PASS guard: verifier PASS + zero artifacts → FAIL ────────────
async function testFalsePassGuard() {
  const { result } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "claims-no-write" },
      params: { maxRetries: 0 },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  const details = result.details;

  assert.match(markdown, /# Orchestration Result: FAIL/,
    "verifier PASS with zero observed effects MUST be escalated to FAIL (2026-06-03 false-PASS guard)");
  assert.match(markdown, /Post-verification effect contradiction/,
    "the FAIL must cite effect-contradiction evidence");
  assert.match(markdown, /zero observed effects|zero mutating tool calls/i,
    "evidence must reference the observed-effects ground truth");
  assert.equal(details.status, "fail");
}

// ── 2. verify-only paradigm: verifier spawns only ───────────────────────────
async function testVerifyOnlyParadigm() {
  const { result, calls } = await runScenario(
    "Evidence checklist: 1) out-1.txt exists and contains fixture content. Paths: ./out-1.txt",
    { params: { paradigm: "verify-only", maxRetries: 0 } },
  );
  const markdown = result.content?.[0]?.text || "";
  const details = result.details;

  assert.equal(details.paradigm, "verify-only");
  assert.equal(details.executorSpawns, 0, "verify-only must spawn zero executors");
  assert.equal(details.plannerSpawns, 0, "verify-only must spawn zero planners");
  assert.match(markdown, /# Verify-Only Orchestration: PASS/);
  assert.match(markdown, /Per-check verdicts/);
  assert.match(markdown, /check-1/);
  assert.match(markdown, /out-1\.txt:1/, "per-check verdicts must carry citations");
  assert.ok(!/implementation task/i.test(markdown),
    "verify-only output must be exempt from implementation-task heuristics");

  const workCalls = calls.filter((call) => call.agentName !== "preflight");
  assert.ok(workCalls.every((call) => call.agentName === "reviewer"),
    `verify-only must spawn only verifier agents, saw: ${workCalls.map((c) => c.agentName).join(", ")}`);
  assert.ok(workCalls.length >= 1, "at least one verifier must be spawned");
}

// ── 3. Retry targeting (F2): only the failed task re-runs ──────────────────
async function testRetryTargetsOnlyFailedTask() {
  const { result, calls } = await runScenario(
    "Build the fixture artifacts: CREATE files out-1.txt, out-2.txt and out-3.txt.",
    {
      env: {
        FAKE_PI_PLAN_STYLE: "impl-3",
        FAKE_PI_EXECUTOR_STYLE: "write-summary-table",
        FAKE_PI_VERIFIER_SEQUENCE: "fail:task-2,pass",
      },
      params: { maxRetries: 1 },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  const details = result.details;

  assert.match(markdown, /# Orchestration Result: PASS/, "attempt 2 should pass");
  assert.equal(details.deterministicState.attempt, 2, "should take exactly two attempts");

  const coderCalls = calls.filter((call) => call.agentName === "coder");
  assert.equal(
    coderCalls.length,
    4,
    `attempt 1 must run 3 tasks and attempt 2 must re-run ONLY task-2 (3 + 1 = 4 executor spawns), saw ${coderCalls.length}`,
  );

  // The reused tasks are routed to re-verification, not regeneration.
  assert.match(markdown, /reusing prior output and routing to re-verification|reused from attempt 1/,
    "carried-forward tasks must be reused, not re-executed");

  const reviewerCalls = calls.filter((call) => call.agentName === "reviewer");
  assert.equal(reviewerCalls.length, 2, "one verifier per attempt");
}

// ── 4. Pre-flight (F5): structured error before any work spawn ─────────────
async function testPreflightStructuredFailure() {
  const { result, calls } = await runScenario(
    "Build something simple.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0, plannerProvider: "badprov", plannerModel: "bad-model" },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  const details = result.details;

  assert.equal(details.aborted, true, "pre-flight failure must produce an aborted partial report, not a throw");
  assert.ok(details.providerError, "a structured machine-readable provider error must be attached");
  assert.equal(details.providerError.type, "rate_limit", "429 payload must be classified as rate_limit");
  assert.equal(details.providerError.provider, "badprov");
  assert.ok(details.providerError.resetsAt, "resets_at must be extracted from the rate-limit payload");
  assert.match(markdown, /Orchestration aborted \(partial report\)/,
    "a partial report must ALWAYS be emitted on abort");

  const workCalls = calls.filter((call) => ["planner", "coder", "reviewer"].includes(call.agentName));
  assert.equal(workCalls.length, 0,
    `pre-flight failure must occur before ANY work subagent spawn, saw: ${workCalls.map((c) => c.agentName).join(", ")}`);
}

// ── 5. Normalizer provenance (F6) ───────────────────────────────────────────
async function testNormalizerProvenance() {
  // 5a: no output-format requirement at all → no contract, no inferred
  // failure criteria possible.
  const first = await runScenario(
    "CREATE a fixture artifact file describing the deployment steps.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0 },
    },
  );
  const intake = first.result.details.deterministicState.intake;
  assert.equal(intake.executorOutputContract ?? null, null,
    "a task with no output-format requirement must not synthesize an executor output contract");
  assert.deepEqual(intake.inferredAdvisoryCriteria, [], "no inferred criteria should exist");
  assert.ok(
    !intake.failureCriteria.some((criterion) => /output contract/i.test(criterion)),
    "no output-contract failure criterion may be synthesized",
  );
  assert.ok(
    intake.criteriaProvenance.every((entry) => entry.source === "explicit"),
    "every derived criterion must carry explicit provenance",
  );
  assert.match(first.result.content?.[0]?.text || "", /# Orchestration Result: PASS/);

  // 5b: a bare RESULT-task-N mention (no concrete format rules) → contract is
  // tagged inferred, demoted to advisory, and produces NO failure criteria.
  const second = await runScenario(
    "Produce RESULT task-N summaries while you CREATE file out-1.txt.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0 },
    },
  );
  const inferredIntake = second.result.details.deterministicState.intake;
  assert.equal(inferredIntake.executorOutputContractSource, "inferred",
    "a synthesized generic contract must be tagged source=inferred");
  assert.ok(inferredIntake.inferredAdvisoryCriteria.length >= 1,
    "the inferred contract must surface as an advisory criterion");
  assert.ok(
    !inferredIntake.failureCriteria.some((criterion) => /output contract/i.test(criterion)),
    "inferred contracts must never create failure criteria (warn, never fail)",
  );
  assert.match(second.result.content?.[0]?.text || "", /# Orchestration Result: PASS/,
    "inferred-criteria must not be able to fail the run");
}

// ── 6. hardGates=strict: zero-effect implementation work fails pre-verifier ─
async function testStrictModeFailsFast() {
  const { result, calls } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "claims-no-write" },
      params: { maxRetries: 0, hardGates: "strict" },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  assert.match(markdown, /# Orchestration Result: FAIL/);
  assert.match(markdown, /Post-execution hard gate/, "strict mode fails fast pre-verifier");
  const reviewerCalls = calls.filter((call) => call.agentName === "reviewer");
  assert.equal(reviewerCalls.length, 0, "strict-mode effect gate must fire before the verifier spawn");
}

async function run() {
  await testFalseFailRegression();
  console.log("PASS 1a: false-FAIL regression (effects + summary-table reply → PASS)");
  await testFalsePassGuard();
  console.log("PASS 1b: false-PASS guard (verifier PASS + zero artifacts → FAIL with effect contradiction)");
  await testVerifyOnlyParadigm();
  console.log("PASS 2:  verify-only paradigm (verifier spawns only, per-check verdicts with citations)");
  await testRetryTargetsOnlyFailedTask();
  console.log("PASS 3:  retry targeting (attempt 2 re-runs only task-2)");
  await testPreflightStructuredFailure();
  console.log("PASS 4:  pre-flight structured failure + partial report, zero work spawns");
  await testNormalizerProvenance();
  console.log("PASS 5:  normalizer provenance (no synthesized failure criteria)");
  await testStrictModeFailsFast();
  console.log("PASS 6:  hardGates=strict fails fast pre-verifier on zero-effect implementation work");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
