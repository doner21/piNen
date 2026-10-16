#!/usr/bin/env node
/**
 * Guard decisions (2026-09-03)
 * ============================
 * Three host guards that used to turn legitimate steps into hard stops now
 * surface as decisions or effect checks:
 *
 * 1. Scope amendment: a settled task that mutated an in-worktree path outside
 *    the frozen write set settles into awaiting_supervisor with the paths
 *    recorded in audit.scopeAmendments and named in the inspect text; the
 *    supervisor's one-use continue accepts them into scope. Worktree escapes
 *    and protected host roots remain hard infrastructure stops.
 * 2. Declared effect: a plan task with expects_file_change:false settles with
 *    zero byte-level change. An explicit expects_file_change:true promise that
 *    produces no bytes also settles, with no_content_progress kept as an
 *    advisory for the supervisor rather than thrown as NO_CONTENT_PROGRESS.
 * 3. Verify-only by effects: the verifier keeps bash; any workspace mutation
 *    during a verify-only run forces FAIL with VERIFY_ONLY_MUTATION.
 */
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

function loadModules() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const extension = jiti(path.join(PROJECT_ROOT, "src", "index.ts")).default;
  const supervision = jiti(path.join(PROJECT_ROOT, "src", "supervision.ts"));
  let tool;
  extension({ registerTool(value) { if (value.name === "orchestrate") tool = value; }, registerCommand() {} });
  assert.ok(tool, "orchestrate tool should be registered");
  return { tool, supervision };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

const SCENARIO_ENV = [
  "FAKE_PI_PLAN_STYLE", "FAKE_PI_EXECUTOR_STYLE", "FAKE_PI_VERIFIER_STATUS",
  "FAKE_PI_VISIBLE_VERIFY_FAIL", "FAKE_PI_VERIFY_ONLY_MUTATE",
];

function makeFixture(label) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `guard-decisions-${label}-`));
  const workspace = path.join(temp, "workspace");
  const runs = path.join(temp, "runs");
  fs.mkdirSync(workspace, { recursive: true });
  // The fake-pi log lives OUTSIDE the workspace so it can never read as a
  // product effect in a content snapshot.
  const log = path.join(temp, "fake-pi.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runs;
  process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT = path.join(temp, "workflows");
  process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT = path.join(temp, "user-workflows");
  process.env.FAKE_PI_LOG = log;
  for (const key of SCENARIO_ENV) delete process.env[key];
  return {
    temp, workspace, runs, log,
    cleanup() {
      for (const key of ["PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT", "PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT", "FAKE_PI_LOG", ...SCENARIO_ENV]) delete process.env[key];
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

function supervisionState(fixture, runId) {
  return JSON.parse(fs.readFileSync(path.join(fixture.runs, runId, "supervision.json"), "utf8"));
}

// ── 1. Out-of-set in-worktree edit becomes a supervisor decision ──────────
async function testScopeAmendmentDecision() {
  const fixture = makeFixture("scope");
  try {
    const { tool } = loadModules();
    const call = (params) => tool.execute("guard-decisions", params, undefined, () => {}, { cwd: fixture.workspace });
    process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws-extra";
    process.env.FAKE_PI_EXECUTOR_STYLE = "write-summary-table-extra";

    const planned = await call({ task: "Build the fixture artifact: CREATE file out-1.txt with the fixture content.", paradigm: "plan-execute-verify", cwd: fixture.workspace, preflight: false, maxRetries: 0 });
    assert.equal(planned.details.status, "awaiting_supervisor");
    assert.equal(planned.details.checkpoint.kind, "plan");
    assert.deepEqual(supervisionState(fixture, planned.details.runId).runtime.plan.predictedWriteSet, ["out-1.txt"], "planner scope omits extra-note.txt");

    const settled = await call({ action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken });
    assert.equal(settled.details.status, "awaiting_supervisor", "an in-worktree scope omission is a decision, not blocked_infrastructure");
    assert.equal(settled.details.checkpoint.kind, "executor");
    assert.equal(settled.details.checkpoint.outcome, "settled");
    assert.ok(settled.details.allowedNextActions.includes("continue"), "continue stays legal so the supervisor can accept the amendment");
    assert.ok(settled.details.approvalToken, "a one-use approval is issued for the acceptance");
    assert.deepEqual(settled.details.scopeAmendments.map((item) => ({ taskId: item.taskId, paths: item.paths })), [{ taskId: "task-1", paths: ["extra-note.txt"] }]);
    assert.match(settled.content?.[0]?.text || settled.markdown || "", /Scope amendment: extra-note\.txt were outside the frozen write set for task-1; continue accepts them into scope, cancel rejects\./);
    assert.deepEqual(settled.details.infrastructureFailures, [], "no infrastructure failure is recorded for a scope omission");
    assert.ok(fs.existsSync(path.join(fixture.workspace, "out-1.txt")) && fs.existsSync(path.join(fixture.workspace, "extra-note.txt")), "the settled task's files remain on disk");

    const persisted = supervisionState(fixture, planned.details.runId);
    assert.deepEqual(persisted.audit.scopeAmendments.map((item) => item.paths), [["extra-note.txt"]], "amendment is durable in the audit");
    assert.deepEqual([...persisted.runtime.plan.predictedWriteSet].sort(), ["extra-note.txt", "out-1.txt"], "the durable plan write set is widened");
    assert.ok(persisted.tasks.every((task) => !task.predictedWriteSet || task.predictedWriteSet.includes("extra-note.txt")), "per-task write sets are widened too");
    const checkpointPayload = JSON.parse(fs.readFileSync(path.join(fixture.runs, planned.details.runId, `${persisted.checkpoints.at(-1).id}-executor.json`), "utf8"));
    assert.deepEqual(checkpointPayload.payload.scopeAmendment.paths, ["extra-note.txt"], "the executor checkpoint payload carries the amendment");

    const inspected = await call({ action: "inspect", runId: planned.details.runId });
    assert.match(inspected.content?.[0]?.text || inspected.markdown || "", /Scope amendment: extra-note\.txt/, "read-only inspect names the pending amendment");

    const verified = await call({ action: "continue", runId: planned.details.runId, approvalToken: settled.details.approvalToken });
    assert.equal(verified.details.status, "terminal");
    assert.equal(verified.details.terminalOutcome, "pass", "accepting the amendment lets verification run without a write-set violation");
    assert.deepEqual(supervisionState(fixture, planned.details.runId).audit.infrastructureFailures, []);
    assert.equal(readLog(fixture.log).filter((row) => row.agentName === "reviewer").length, 1, "the verifier ran exactly once after acceptance");
  } finally {
    fixture.cleanup();
  }
}

// ── 2. Escapes and protected roots stay hard stops ────────────────────────
function testHardViolationsStayHard() {
  const { supervision } = loadModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-decisions-lane-"));
  try {
    const worktree = { root, realRoot: fs.realpathSync.native(root) };
    const violations = supervision.checkLanePaths({
      lane: "product", cwd: root, worktree,
      paths: ["src/in-scope.ts", "src/omitted.ts", "../escape.ts"],
      allowedWriteSet: ["src/in-scope.ts"],
    });
    const byPath = Object.fromEntries(violations.map((item) => [item.path, item.code]));
    assert.equal(byPath["src/in-scope.ts"], undefined, "granted paths are clean");
    assert.equal(byPath["src/omitted.ts"], "out_of_scope_path", "an in-worktree omission is a scope violation");
    assert.equal(byPath["../escape.ts"], "path_escape", "parent traversal is an escape");

    const split = supervision.partitionLaneViolations(violations);
    assert.deepEqual(split.scope.map((item) => item.path), ["src/omitted.ts"]);
    assert.deepEqual(split.hard.map((item) => item.path), ["../escape.ts"], "only the escape remains a hard stop");

    const protectedViolation = supervision.checkLanePaths({
      lane: "product", cwd: root, worktree,
      paths: ["note.txt"],
      allowedWriteSet: ["note.txt"],
      protectedRoots: [root],
    });
    assert.deepEqual(supervision.partitionLaneViolations(protectedViolation).hard.map((item) => item.code), ["protected_path"], "protected host roots are never a scope amendment");

    // Genuinely unobservable scopes keep their infrastructure classification.
    const classified = supervision.classifyInfrastructureFailure(new Error("WRITE_SET_UNOBSERVABLE: predicted write set scope could not be captured"));
    assert.equal(classified.infrastructure, true, "unobservable write-set scopes still classify as infrastructure");
    assert.equal(classified.code, "write_set");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── 3. Declared effect expectation drives the no-progress guard ───────────
async function testDeclaredEffectExpectation() {
  const fixture = makeFixture("declared");
  try {
    const { tool } = loadModules();
    const call = (params) => tool.execute("guard-decisions", params, undefined, () => {}, { cwd: fixture.workspace });

    process.env.FAKE_PI_PLAN_STYLE = "declared-false-1";
    process.env.FAKE_PI_EXECUTOR_STYLE = "claims-no-write";
    const validatePlan = await call({ task: "Run the fixture checks and report.", paradigm: "plan-execute-verify", cwd: fixture.workspace, preflight: false, maxRetries: 0 });
    assert.equal(validatePlan.details.status, "awaiting_supervisor");
    const validateState = supervisionState(fixture, validatePlan.details.runId);
    assert.equal(validateState.tasks[0].expectsFileChange, false, "the declaration is carried into the durable task");
    const validated = await call({ action: "continue", runId: validatePlan.details.runId, approvalToken: validatePlan.details.approvalToken });
    assert.equal(validated.details.status, "awaiting_supervisor", "a declared validation task settles with zero change");
    assert.equal(validated.details.checkpoint.outcome, "settled");
    assert.deepEqual(validated.details.checkpoint.effectChanges, []);
    assert.equal(validated.details.noProgress, false, "no NO_CONTENT_PROGRESS is raised for a declared validation task");
    assert.deepEqual(fs.readdirSync(fixture.workspace), [], "nothing was written");

    for (const key of SCENARIO_ENV) delete process.env[key];
    process.env.FAKE_PI_PLAN_STYLE = "declared-true-1";
    process.env.FAKE_PI_EXECUTOR_STYLE = "claims-no-write";
    const implPlan = await call({ task: "Prepare the fixture artifact out-1.txt for review.", paradigm: "plan-execute-verify", cwd: fixture.workspace, preflight: false, maxRetries: 0 });
    assert.equal(implPlan.details.status, "awaiting_supervisor");
    assert.equal(supervisionState(fixture, implPlan.details.runId).tasks[0].expectsFileChange, true);
    const implemented = await call({ action: "continue", runId: implPlan.details.runId, approvalToken: implPlan.details.approvalToken });
    assert.equal(implemented.details.checkpoint.outcome, "settled", "a declared implementation no-op reaches the supervisor instead of throwing");
    assert.equal(implemented.details.noProgress, true, "the no-content fact remains visible as an advisory");
    assert.equal(implemented.details.error, undefined, "zero effects are not converted into a host error");
    const implementedState = supervisionState(fixture, implPlan.details.runId);
    const implementedPayload = JSON.parse(fs.readFileSync(path.join(fixture.runs, implPlan.details.runId, `${implementedState.checkpoints.at(-1).id}-executor.json`), "utf8"));
    assert.deepEqual(implementedPayload.payload.executorOutcome.advisoryFlags.map((flag) => flag.code), ["no_content_progress"]);
  } finally {
    fixture.cleanup();
  }
}

// ── 4. Verify-only keeps the shell and is read-only by effects ────────────
async function testVerifyOnlyEffects() {
  const fixture = makeFixture("verify-only");
  try {
    const { tool } = loadModules();
    const call = (params) => tool.execute("guard-decisions", params, undefined, () => {}, { cwd: fixture.workspace });
    fs.writeFileSync(path.join(fixture.workspace, "out-1.txt"), "fixture evidence\n", "utf8");

    const clean = await call({ task: "Verify CHECK-1 against the existing fixture evidence.", paradigm: "verify-only", cwd: fixture.workspace, preflight: false });
    assert.equal(clean.details.status, "pass", "a non-mutating verifier passes");
    const record = readLog(fixture.log).at(-1);
    const tools = String(record.tools ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    assert.deepEqual(tools, ["read", "grep", "find", "ls", "bash"], "verify-only verifier keeps bash alongside the evidence tools");
    assert.equal(record.noExtensions, true, "extensions stay off for the verifier child");
    assert.ok(!tools.includes("write") && !tools.includes("edit"), "no mutation tools are offered");

    process.env.FAKE_PI_VERIFY_ONLY_MUTATE = "1";
    const mutated = await call({ task: "Verify CHECK-1 against the existing fixture evidence.", paradigm: "verify-only", cwd: fixture.workspace, preflight: false });
    assert.equal(mutated.details.status, "fail", "a verifier that mutates the workspace is failed by effects even though it reported pass");
    const markdown = mutated.content?.[0]?.text || mutated.markdown || "";
    assert.match(markdown, /VERIFY_ONLY_MUTATION: added:verifier-side-effect\.txt/, "the mutation is named in the report");
    assert.ok(fs.existsSync(path.join(fixture.workspace, "verifier-side-effect.txt")), "the effect check observes the real file");
    assert.equal(mutated.details.verifierRuns?.[0]?.mutations?.length, 1, "details carry the observed mutation");
  } finally {
    fixture.cleanup();
  }
}

(async function main() {
  const suites = [
    ["hard lane violations stay hard, scope omissions partition out", () => testHardViolationsStayHard()],
    ["out-of-set in-worktree edit becomes a supervisor decision and is accepted by continue", testScopeAmendmentDecision],
    ["declared effect expectation drives the no-progress guard", testDeclaredEffectExpectation],
    ["verify-only keeps the shell and fails on workspace mutation", testVerifyOnlyEffects],
  ];
  for (const [name, fn] of suites) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log("test-guard-decisions: all scenarios passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
