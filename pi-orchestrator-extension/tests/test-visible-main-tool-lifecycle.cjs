#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));

function loadTool() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const extension = (jiti(path.join(ROOT, "src", "index.ts")).default);
  let tool;
  extension({ registerTool(value) { if (value.name === "orchestrate") tool = value; }, registerCommand() {} });
  assert.ok(tool);
  return tool;
}

async function call(tool, params, cwd) {
  return tool.execute("visible-main-test", params, undefined, () => {}, { cwd });
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-tool-"));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-runs-"));
  const log = path.join(runRoot, "fake-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runRoot;
  process.env.FAKE_PI_LOG = log;
  process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";
  process.env.FAKE_PI_EXECUTOR_STYLE = "write-summary-table";
  const extraWorkspaces = [];
  try {
    const tool = loadTool();
    assert.match(tool.description, /awaiting_supervisor.*not completion/i);
    for (const name of ["action", "runId", "approvalToken", "supervision", "lane"]) assert.ok(tool.parameters.properties[name], `schema exposes ${name}`);

    const planned = await call(tool, {
      task: "CREATE file out-1.txt with fixture content.", cwd: workspace,
      predictedWriteSet: "out-1.txt", preflight: false, maxRetries: 0,
    }, workspace);
    assert.equal(planned.details.status, "awaiting_supervisor");
    assert.equal(planned.details.checkpoint.kind, "plan");
    assert.ok(planned.details.approvalToken);
    assert.equal(fs.existsSync(path.join(workspace, "out-1.txt")), false);
    let calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(calls.filter((entry) => entry.agentName === "coder").length, 0);
    assert.equal(calls.filter((entry) => entry.agentName === "reviewer").length, 0);

    const stateFile = path.join(runRoot, planned.details.runId, "supervision.json");
    const durablePlan = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(durablePlan.lane, "product", "the mutation lane is frozen with the mission");
    assert.deepEqual(durablePlan.tasks[0].predictedWriteSet, ["out-1.txt"], "the approved write set is frozen per task");
    const beforeInspect = fs.readFileSync(stateFile);
    const inspected = await call(tool, { action: "inspect", runId: planned.details.runId }, workspace);
    assert.equal(inspected.details.status, "awaiting_supervisor");
    assert.deepEqual(fs.readFileSync(stateFile), beforeInspect, "inspect is byte immutable");
    await assert.rejects(
      () => call(tool, { action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken, lane: "orchestrator-maintenance" }, workspace),
      /lane drift/i,
      "a continuation cannot switch the frozen product run into the maintenance lane",
    );

    const executed = await call(tool, { action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken }, workspace);
    assert.equal(executed.details.status, "awaiting_supervisor");
    assert.equal(executed.details.checkpoint.kind, "executor");
    assert.ok(fs.existsSync(path.join(workspace, "out-1.txt")));
    calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(calls.filter((entry) => entry.agentName === "coder").length, 1, "one approval spawns one executor");
    assert.equal(calls.filter((entry) => entry.agentName === "reviewer").length, 0, "post-last-executor checkpoint precedes verification");
    await assert.rejects(() => call(tool, { action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken }, workspace), /stale|consumed|invalid/);

    const verified = await call(tool, { action: "continue", runId: planned.details.runId, approvalToken: executed.details.approvalToken }, workspace);
    assert.equal(verified.details.status, "terminal");
    assert.equal(verified.details.terminalOutcome, "pass");
    assert.match(verified.content[0].text, /terminal PASS/);
    assert.ok(verified.details.findings.every((finding) => finding.evidence.length));
    calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(calls.filter((entry) => entry.agentName === "reviewer").length, 1);

    const pausedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-pause-")); extraWorkspaces.push(pausedWorkspace);
    const pausedRun = await call(tool, { task: "CREATE file out-1.txt with fixture content.", cwd: pausedWorkspace, predictedWriteSet: "out-1.txt", preflight: false }, pausedWorkspace);
    const paused = await call(tool, { action: "pause", runId: pausedRun.details.runId }, pausedWorkspace);
    assert.equal(paused.details.status, "paused");
    await assert.rejects(() => call(tool, { action: "continue", runId: pausedRun.details.runId, approvalToken: pausedRun.details.approvalToken }, pausedWorkspace), /invalid|stale|consumed/);
    const renewed = await call(tool, { action: "continue", runId: pausedRun.details.runId }, pausedWorkspace);
    assert.ok(renewed.details.approvalToken, "paused/restarted run can request a fresh approval without spawning");
    const cancelled = await call(tool, { action: "cancel", runId: pausedRun.details.runId }, pausedWorkspace);
    assert.equal(cancelled.details.status, "cancelled");
    await assert.rejects(() => call(tool, { action: "continue", runId: pausedRun.details.runId, approvalToken: renewed.details.approvalToken }, pausedWorkspace), /irreversible|cancelled/);

    const crossWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-cross-")); extraWorkspaces.push(crossWorkspace);
    const crossRun = await call(tool, { task: "CREATE file out-1.txt with fixture content.", cwd: crossWorkspace, predictedWriteSet: "out-1.txt", preflight: false }, crossWorkspace);
    await assert.rejects(() => call(tool, { action: "continue", runId: crossRun.details.runId, approvalToken: pausedRun.details.approvalToken }, crossWorkspace), /invalid|wrong/);
    await call(tool, { action: "cancel", runId: crossRun.details.runId }, crossWorkspace);

    const readonly = await call(tool, { task: "Audit the supplied fixture evidence.", cwd: workspace, paradigm: "verify-only", supervision: "visible-main", preflight: false }, workspace);
    assert.match(readonly.content[0].text, /Verify-Only Orchestration: PASS/);

    const terminalFailWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-terminal-fail-")); extraWorkspaces.push(terminalFailWorkspace);
    const terminalFailPlan = await call(tool, { task: "CREATE file out-1.txt with fixture content.", cwd: terminalFailWorkspace, predictedWriteSet: "out-1.txt", preflight: false, maxRetries: 0 }, terminalFailWorkspace);
    const terminalFailExec = await call(tool, { action: "continue", runId: terminalFailPlan.details.runId, approvalToken: terminalFailPlan.details.approvalToken }, terminalFailWorkspace);
    process.env.FAKE_PI_VISIBLE_VERIFY_FAIL = "1";
    const terminalFail = await call(tool, { action: "continue", runId: terminalFailPlan.details.runId, approvalToken: terminalFailExec.details.approvalToken }, terminalFailWorkspace);
    assert.equal(terminalFail.details.status, "terminal", "exhausted repair budget is an honest terminal state");
    assert.equal(terminalFail.details.terminalOutcome, "fail");
    assert.equal(terminalFail.details.approvalToken, undefined);
    assert.match(terminalFail.content[0].text, /terminal FAIL/);
    await assert.rejects(() => call(tool, { action: "continue", runId: terminalFailPlan.details.runId, approvalToken: terminalFailExec.details.approvalToken }, terminalFailWorkspace), /irreversible|terminal/);
    delete process.env.FAKE_PI_VISIBLE_VERIFY_FAIL;

    const repairWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-repair-")); extraWorkspaces.push(repairWorkspace);
    const repairPlan = await call(tool, { task: "CREATE file out-1.txt with fixture content.", cwd: repairWorkspace, predictedWriteSet: "out-1.txt", preflight: false, maxRetries: 1 }, repairWorkspace);
    const repairExec = await call(tool, { action: "continue", runId: repairPlan.details.runId, approvalToken: repairPlan.details.approvalToken }, repairWorkspace);
    process.env.FAKE_PI_VISIBLE_VERIFY_FAIL = "1";
    const failedVerify = await call(tool, { action: "continue", runId: repairPlan.details.runId, approvalToken: repairExec.details.approvalToken }, repairWorkspace);
    assert.equal(failedVerify.details.status, "awaiting_supervisor");
    assert.equal(failedVerify.details.checkpoint.kind, "verifier");
    assert.match(JSON.stringify(failedVerify.details.verificationIssues), /|^$/);
    delete process.env.FAKE_PI_VISIBLE_VERIFY_FAIL;
    const repaired = await call(tool, { action: "continue", runId: repairPlan.details.runId, approvalToken: failedVerify.details.approvalToken }, repairWorkspace);
    assert.equal(repaired.details.checkpoint.kind, "executor", "criterion-linked repair requires a separate approval and executor checkpoint");
    const repairFinal = await call(tool, { action: "continue", runId: repairPlan.details.runId, approvalToken: repaired.details.approvalToken }, repairWorkspace);
    assert.equal(repairFinal.details.status, "terminal");

    const off = await call(tool, { task: "CREATE file out-1.txt with fixture content.", cwd: workspace, supervision: "off", preflight: false, maxRetries: 0, predictedWriteSet: "out-1.txt" }, workspace);
    assert.match(off.content[0].text, /Orchestration Result/);

    const countBeforeGeneric = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const generic = await call(tool, {
      task: "BUILD the composable fixture through the shared host boundary.", cwd: workspace,
      paradigm: "composable-pipeline", preflight: false,
      predictedWriteSet: "out-1.txt",
    }, workspace);
    assert.equal(generic.details.status, "awaiting_supervisor");
    assert.equal(generic.details.checkpoint.kind, "plan");
    assert.equal(generic.details.protocol.protocolId, "host-task-boundary-v1");
    const countAfterGeneric = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(countAfterGeneric, countBeforeGeneric + 1, "omitted supervision defaults a generic executor-bearing shape to a plan checkpoint before execution");
    await call(tool, { action: "cancel", runId: generic.details.runId }, workspace);

    // A current bespoke/native shape follows the same shape-neutral cursor.
    // Three independent executor tasks require three distinct approvals, and
    // verification remains behind a fourth boundary.
    const customWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-custom-")); extraWorkspaces.push(customWorkspace);
    process.env.FAKE_PI_PLAN_STYLE = "impl-3";
    const customPlan = await call(tool, {
      task: "CREATE three bounded fixture files through the registered bespoke shape.",
      cwd: customWorkspace,
      paradigm: "preregistered-concurrency-spike",
      predictedWriteSet: "out-1.txt,out-2.txt,out-3.txt",
      preflight: false,
      maxRetries: 0,
    }, customWorkspace);
    assert.equal(customPlan.details.status, "awaiting_supervisor");
    assert.equal(customPlan.details.protocol.adapterId, "generic-shape-adapter-v1");
    let boundary = customPlan;
    const coderCountBeforeCustom = readCalls(log).filter((entry) => entry.agentName === "coder").length;
    const verifierCountBeforeCustom = readCalls(log).filter((entry) => entry.agentName === "reviewer" && entry.promptSnippet?.includes("VISIBLE_MAIN_CRITERION_VERIFICATION")).length;
    for (let index = 1; index <= 3; index += 1) {
      boundary = await call(tool, {
        action: "continue",
        runId: customPlan.details.runId,
        approvalToken: boundary.details.approvalToken,
      }, customWorkspace);
      assert.equal(boundary.details.status, "awaiting_supervisor");
      assert.equal(boundary.details.checkpoint.kind, "executor");
      assert.equal(boundary.details.checkpoint.taskId, `task-${index}`);
      assert.equal(
        readCalls(log).filter((entry) => entry.agentName === "coder").length,
        coderCountBeforeCustom + index,
        `approval ${index} settles exactly one bespoke executor task`,
      );
      assert.equal(
        readCalls(log).filter((entry) => entry.agentName === "reviewer" && entry.promptSnippet?.includes("VISIBLE_MAIN_CRITERION_VERIFICATION")).length,
        verifierCountBeforeCustom,
        "no verifier starts between bespoke executor boundaries",
      );
    }
    const customTerminal = await call(tool, {
      action: "continue",
      runId: customPlan.details.runId,
      approvalToken: boundary.details.approvalToken,
    }, customWorkspace);
    assert.equal(customTerminal.details.status, "terminal");
    assert.equal(customTerminal.details.terminalOutcome, "pass");
    assert.equal(
      readCalls(log).filter((entry) => entry.agentName === "reviewer" && entry.promptSnippet?.includes("VISIBLE_MAIN_CRITERION_VERIFICATION")).length,
      verifierCountBeforeCustom + 1,
      "the separate post-executor approval launches one verifier",
    );
    process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";

    console.log("test-visible-main-tool-lifecycle: all scenarios passed");
  } finally {
    for (const key of ["PI_ORCHESTRATOR_RUNS_ROOT", "FAKE_PI_LOG", "FAKE_PI_PLAN_STYLE", "FAKE_PI_EXECUTOR_STYLE", "FAKE_PI_VISIBLE_VERIFY_FAIL"]) delete process.env[key];
    fs.rmSync(workspace, { recursive: true, force: true });
    for (const directory of extraWorkspaces) fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
