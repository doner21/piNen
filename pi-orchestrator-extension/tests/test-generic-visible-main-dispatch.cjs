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

function loadModules() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const extension = jiti(path.join(ROOT, "src", "index.ts")).default;
  const runState = jiti(path.join(ROOT, "src", "run-state.ts"));
  let tool;
  extension({ registerTool(value) { if (value.name === "orchestrate") tool = value; }, registerCommand() {} });
  assert.ok(tool);
  return { tool, runState };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function workflow(name) {
  return {
    schemaVersion: 1,
    name,
    description: "Two durable read-only declarative phases.",
    phases: [
      { id: "inspect", role: "planner", agentName: "planner", prompt: "Inspect and analyze the fixture without file changes.", expectedOutput: "A grounded finding.", dependsOn: [], route: { role: "planner" } },
      { id: "verify", role: "verifier", agentName: "reviewer", prompt: "Verify the dependency finding and report the result without repository edits.", expectedOutput: "A grounded verification report.", dependsOn: ["inspect"], route: { role: "verifier" } },
    ],
    maxSubagents: 2,
    maxConcurrency: 2,
    maxIterations: 1,
    continueOnFailure: false,
    terminationCondition: "Stop after verification.",
    evidenceModel: "Phase output.",
    failureBehavior: "Fail on phase error.",
    userFacingExplanation: "Inspect then verify.",
  };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "generic-visible-main-"));
  const workspace = path.join(temp, "workspace");
  const workflows = path.join(temp, "workflows");
  const runs = path.join(temp, "runs");
  const log = path.join(temp, "fake-log.jsonl");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "durable-dynamic.workflow.json"), `${JSON.stringify(workflow("durable-dynamic"), null, 2)}\n`);
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runs;
  process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT = workflows;
  process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT = path.join(temp, "user-workflows");
  process.env.FAKE_PI_LOG = log;

  try {
    const { tool, runState } = loadModules();
    const call = (params) => tool.execute("generic-visible-main", params, undefined, () => {}, { cwd: workspace });

    const planned = await call({ task: "Exercise the declarative fixture.", paradigm: "durable-dynamic", cwd: workspace, preflight: false });
    assert.equal(planned.details.status, "awaiting_supervisor");
    assert.equal(planned.details.checkpoint.kind, "plan");
    assert.equal(planned.details.protocol.adapterId, "generic-shape-adapter-v1");
    assert.equal(readLog(log).length, 0, "host-derived dynamic plan is durable before any phase spawn");

    const inspected = await call({ action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken });
    assert.equal(inspected.details.status, "awaiting_supervisor");
    assert.equal(inspected.details.checkpoint.taskId, "dynamic-1-inspect");
    assert.deepEqual(inspected.details.checkpoint.effectChanges, [], "planner analysis advances with zero content effects");
    assert.equal(readLog(log).filter((entry) => entry.agentName === "planner").length, 1);
    assert.equal(readLog(log).filter((entry) => entry.agentName === "coder").length, 0);

    const reported = await call({ action: "continue", runId: planned.details.runId, approvalToken: inspected.details.approvalToken });
    assert.equal(reported.details.status, "awaiting_supervisor");
    assert.equal(reported.details.checkpoint.taskId, "dynamic-1-verify");
    assert.deepEqual(reported.details.checkpoint.effectChanges, [], "declarative verifier analysis advances with zero content effects");
    assert.equal(readLog(log).filter((entry) => entry.agentName === "coder").length, 0, "read-only workflow never needs a mutating executor");
    assert.equal(readLog(log).filter((entry) => entry.agentName === "reviewer").length, 1, "second approval settles only the declarative verifier phase");

    const verified = await call({ action: "continue", runId: planned.details.runId, approvalToken: reported.details.approvalToken });
    assert.equal(verified.details.status, "terminal");
    assert.equal(verified.details.terminalOutcome, "pass");
    assert.equal(readLog(log).filter((entry) => entry.agentName === "reviewer").length, 2, "final criterion verification remains behind its own approval");
    assert.deepEqual(fs.readdirSync(workspace), [], "zero-delta analysis needs no accidental file mutation, including nul/NUL");

    const state = JSON.parse(fs.readFileSync(path.join(runs, planned.details.runId, "supervision.json"), "utf8"));
    assert.equal(state.runtime.kind, "generic-shape");
    assert.equal(state.runtime.cursor.stage, "terminal");
    assert.equal(state.runtime.cursor.nextTaskIndex, 2);
    assert.equal(state.runtime.identity.adapterId, "generic-shape-adapter-v1");
    const phaseState = runState.RunStateStore.load(planned.details.runId).state;
    assert.equal(phaseState.supervision.cursor.stage, "terminal", "historical state.json mirrors the host cursor");

    const historicalId = `historical-${Date.now().toString(36)}`;
    const historicalStore = runState.RunStateStore.create(
      historicalId,
      "preregistered-concurrency-spike",
      "Resume the bounded historical fixture.",
      { cwd: workspace, preflight: false, paradigm: "preregistered-concurrency-spike" },
      ["implement", "verify"],
    );
    historicalStore.checkpointPhase(0, "implement", {
      agentName: "coder", task: "implement", text: "restored", stderr: "", exitCode: 0, durationMs: 1, events: 0,
    });
    const resumed = await call({ resume: historicalId, preflight: false, cwd: workspace });
    assert.equal(resumed.details.status, "awaiting_supervisor");
    assert.equal(resumed.details.checkpoint.kind, "plan");
    const bound = runState.RunStateStore.load(historicalId).state.supervision;
    assert.equal(bound.mode, "visible-main");
    assert.equal(bound.identity.adapterId, "generic-shape-adapter-v1");
    assert.equal(bound.cursor.nextTaskIndex, 1, "completed historical prefix is restored without respawn");

    assert.equal(fs.readdirSync(workspace).some((name) => name.toLowerCase() === "nul"), false, "historical resume also creates no nul mutation");
    console.log("test-generic-visible-main-dispatch: zero-delta planner/verifier phases and historical resume use one durable host boundary per approval");
  } finally {
    for (const key of ["PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT", "PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT", "FAKE_PI_LOG"]) delete process.env[key];
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
