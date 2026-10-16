#!/usr/bin/env node
/**
 * Integrated all-shape visible-main regression matrix.
 *
 * This test intentionally exercises the registered tool boundary. It proves that
 * every current executor-bearing native shape is intercepted by the same durable
 * host protocol before the shape can run, while read-only and explicit-off paths
 * retain their documented compatibility behavior.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");

require("./fixtures/legacy-offline.cjs")();
const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));

// This is deliberately an explicit inventory, not a list derived from the
// registry under test. A newly registered native shape therefore makes this
// test fail until its execution classification and expected adapter are reviewed.
const NATIVE_MATRIX = [
  ["composable-pipeline", "composablePipelineShape", "executor-bearing", "generic-shape-adapter-v1", "native"],
  ["dual-plan-synthesis-execute-verify", "dualPlanSynthesisExecuteVerifyShape", "executor-bearing", "generic-shape-adapter-v1", "native"],
  ["evidence-audit", "evidenceAuditShape", "read-only", null, "native"],
  ["frozen-gate-fix-loop", "frozenGateFixLoopShape", "executor-bearing", "generic-shape-adapter-v1", "native"],
  ["independent-replication", "independentReplicationShape", "executor-bearing", "generic-shape-adapter-v1", "native"],
  ["m66-explicit-routing-proof", "m66ExplicitRoutingProofShape", "executor-bearing", "generic-shape-adapter-v1", "shape-builder-custom"],
  ["multi-verify-vote", "multiVerifyVoteShape", "executor-bearing", "generic-shape-adapter-v1", "native"],
  ["paradigm-creator", "paradigmCreatorShape", "read-only", null, "native"],
  ["plan-execute-verify", "planExecuteVerifyShape", "executor-bearing", "plan-execute-verify-adapter-v1", "native"],
  ["preregistered-concurrency-spike", "preregisteredConcurrencySpikeShape", "executor-bearing", "generic-shape-adapter-v1", "shape-builder-custom"],
  ["shape-builder", "shapeBuilderShape", "mutating", "generic-shape-adapter-v1", "native"],
  ["ssi-single-writer-exclusive-lane", "ssiSingleWriterExclusiveLaneShape", "executor-bearing", "generic-shape-adapter-v1", "shape-builder-custom"],
  ["venue-rescue-synthesis", "venueRescueSynthesisShape", "executor-bearing", "generic-shape-adapter-v1", "shape-builder-custom"],
  ["verify-only", "verifyOnlyShape", "read-only", null, "native"],
  ["win-console-spawn-root-cause", "winConsoleSpawnRootCauseShape", "executor-bearing", "generic-shape-adapter-v1", "native"],
  ["win-lifecycle-process-trace", "winLifecycleProcessTraceShape", "executor-bearing", "generic-shape-adapter-v1", "native"],
];

const SUPERVISED = NATIVE_MATRIX.filter((row) => row[2] !== "read-only");
const READ_ONLY = NATIVE_MATRIX.filter((row) => row[2] === "read-only");

function makeJiti() {
  return createJiti(__filename, { interopDefault: true, moduleCache: false });
}

function loadModules() {
  const jiti = makeJiti();
  const index = jiti(path.join(ROOT, "src", "index.ts"));
  const supervision = jiti(path.join(ROOT, "src", "supervision.ts"));
  const runState = jiti(path.join(ROOT, "src", "run-state.ts"));
  const writeSet = jiti(path.join(ROOT, "src", "write-set.ts"));
  const builder = jiti(path.join(ROOT, "src", "shape-builder-support.ts"));
  const next = jiti(path.join(ROOT, "src", "next", "index.ts"));
  let tool;
  let nextTool;
  (index.default ?? index)({
    registerTool(definition) {
      if (definition.name === "orchestrate") tool = definition;
      if (definition.name === "orchestrate_next") nextTool = definition;
    },
    registerCommand() {},
    sendMessage() {},
  });
  assert.ok(tool, "orchestrate tool registered");
  assert.ok(nextTool, "orchestrate_next tool registered");
  return { index, supervision, runState, writeSet, builder, next, tool, nextTool };
}

function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function workflow(name) {
  return {
    schemaVersion: 1,
    name,
    description: "Two executor boundaries used by the integrated supervision matrix.",
    phases: [
      { id: "first", role: "executor", agentName: "coder", prompt: "Return first bounded finding.", expectedOutput: "Finding one.", dependsOn: [], route: { role: "executor" } },
      { id: "second", role: "executor", agentName: "coder", prompt: "Return second bounded finding.", expectedOutput: "Finding two.", dependsOn: ["first"], route: { role: "executor" } },
    ],
    maxSubagents: 2,
    maxConcurrency: 2,
    maxIterations: 1,
    continueOnFailure: false,
    terminationCondition: "Stop after the second finding.",
    evidenceModel: "Settled phase outputs.",
    failureBehavior: "Fail on a phase error.",
    userFacingExplanation: "Two bounded executor phases.",
  };
}

function stateAt(runs, runId) {
  return JSON.parse(fs.readFileSync(path.join(runs, runId, "supervision.json"), "utf8"));
}

function deleteRun(runs, runId) {
  fs.rmSync(path.join(runs, runId), { recursive: true, force: true });
}

function assertNoMutatingTools(record, label) {
  const tools = String(record.tools ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  // guard-decisions (2026-09-03): verify-only verifiers keep bash and are held
  // read-only by the host's before/after content snapshot instead.
  const verifyOnly = String(record.promptSnippet ?? "").includes("VERIFICATION-ONLY orchestration");
  const expected = verifyOnly ? ["read", "grep", "find", "ls", "bash"] : ["read", "grep", "find", "ls"];
  assert.deepEqual(tools, expected, `${label} receives exactly the ${verifyOnly ? "verify-only evidence+shell" : "safe evidence"} allowlist`);
  assert.ok(!tools.some((tool) => ["write", "edit", "orchestrate"].includes(tool)), `${label} never receives mutation tools`);
  assert.equal(record.noTools, false, `${label} retains inspection capability`);
  assert.equal(record.noExtensions, true, `${label} cannot load extension tools`);
}

async function testNativeInventoryAndOmittedModeDispatch(modules, fixture) {
  assert.deepEqual(
    [...modules.index.NATIVE_SHAPE_NAMES].sort(),
    NATIVE_MATRIX.map(([name]) => name).sort(),
    "the explicit matrix must enumerate every registered native shape",
  );
  const shapeSources = fs.readdirSync(path.join(ROOT, "src", "shapes"))
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => /export const \w+Shape\s*:\s*OrchestrationShape/.test(fs.readFileSync(path.join(ROOT, "src", "shapes", file), "utf8")))
    .map((file) => file.replace(/\.ts$/, "")).sort();
  assert.deepEqual(shapeSources, NATIVE_MATRIX.map(([name]) => name).sort(), "the matrix also covers every native shape source");

  for (const [name, exportName, classification, adapterId] of NATIVE_MATRIX) {
    const shape = makeJiti()(path.join(ROOT, "src", "shapes", `${name}.ts`))[exportName];
    assert.ok(shape, `${name} export exists`);
    assert.equal(shape.name, name);
    assert.equal(shape.execution.classification, classification);
    assert.equal(Object.isFrozen(shape.execution), true, `${name} execution contract is immutable`);
    const resolution = modules.supervision.resolveShapeDispatch(shape.execution, undefined);
    if (classification === "read-only") {
      assert.equal(resolution.disposition, "read-only", `${name} remains read-only when supervision is omitted`);
    } else {
      assert.equal(resolution.disposition, "supervised", `${name} is supervised when mode is omitted`);
      assert.equal(resolution.identity.protocolId, modules.supervision.HOST_TASK_BOUNDARY_PROTOCOL_ID);
      assert.equal(resolution.identity.adapterId, adapterId);
    }
  }

  for (const [name, , classification, adapterId] of SUPERVISED) {
    const beforeCalls = records(fixture.log).length;
    const result = await fixture.call(modules.tool, {
      task: `Assess the bounded ${name} dispatch fixture and report observations.`,
      paradigm: name,
      cwd: fixture.workspace,
      preflight: false,
    });
    assert.equal(result.details.status, "awaiting_supervisor", `${name} must stop at a visible-main checkpoint`);
    assert.equal(result.details.checkpoint.kind, "plan", `${name} first checkpoint is the durable plan boundary`);
    assert.equal(result.details.protocol.protocolId, modules.supervision.HOST_TASK_BOUNDARY_PROTOCOL_ID);
    assert.equal(result.details.protocol.adapterId, adapterId);
    const afterCalls = records(fixture.log);
    assert.equal(afterCalls.length, beforeCalls + 1, `${name} initial dispatch may spawn only its host planner`);
    assert.equal(afterCalls.at(-1).agentName, "planner", `${name} native shape body did not run before approval`);
    const durable = stateAt(fixture.runs, result.details.runId);
    assert.equal(durable.runtime.kind, "generic-shape");
    assert.equal(durable.runtime.cursor.stage, "executor-task");
    assert.equal(durable.runtime.adapterState.classification, classification);
    assert.equal(durable.currentApproval.consumedAt, undefined);
    deleteRun(fixture.runs, result.details.runId);
  }
}

async function testDynamicReplayRestartAndVerifierBoundary(modules, fixture) {
  const before = records(fixture.log).length;
  const planned = await fixture.call(modules.tool, {
    task: "Exercise two bounded declarative executor boundaries.",
    paradigm: fixture.workflowName,
    cwd: fixture.workspace,
    preflight: false,
  });
  assert.equal(planned.details.status, "awaiting_supervisor");
  assert.equal(planned.details.protocol.adapterId, modules.supervision.GENERIC_SHAPE_ADAPTER_ID);
  assert.equal(records(fixture.log).length, before, "host-derived declarative plan is durable with zero workers");

  const stateFile = path.join(fixture.runs, planned.details.runId, "supervision.json");
  const inspectBytes = fs.readFileSync(stateFile);
  const inspected = await fixture.call(modules.tool, { action: "inspect", runId: planned.details.runId });
  assert.equal(inspected.details.status, "awaiting_supervisor");
  assert.deepEqual(fs.readFileSync(stateFile), inspectBytes, "inspect is byte-for-byte read-only");

  const first = await fixture.call(modules.tool, {
    action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken,
  });
  assert.equal(first.details.status, "awaiting_supervisor");
  assert.equal(first.details.checkpoint.taskId, "dynamic-1-first");
  assert.equal(records(fixture.log).filter((row) => row.agentName === "coder").length, 1, "one approval settles one executor");
  await assert.rejects(
    () => fixture.call(modules.tool, { action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken }),
    /stale|consumed|invalid/i,
    "an approval token cannot be replayed",
  );
  assert.equal(records(fixture.log).filter((row) => row.agentName === "coder").length, 1, "token replay spawns nothing");

  // Pin a valid owner identity whose real host has exited, then construct a
  // fresh extension instance. Only conclusive PID death may pause the run.
  const exitedHost = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  assert.equal(exitedHost.status, 0);
  assert.ok(Number.isInteger(exitedHost.pid) && exitedHost.pid > 0);
  const preRestartState = stateAt(fixture.runs, planned.details.runId);
  preRestartState.runtime.hostInstanceId = `${exitedHost.pid}:1`;
  fs.writeFileSync(stateFile, `${JSON.stringify(preRestartState, null, 2)}\n`, "utf8");
  const restarted = loadModules();
  const paused = await fixture.call(restarted.tool, { action: "inspect", runId: planned.details.runId });
  assert.equal(paused.details.status, "paused");
  assert.match(paused.details.pauseReason, /fresh_visible_main_approval/);
  await assert.rejects(
    () => fixture.call(restarted.tool, { action: "continue", runId: planned.details.runId, approvalToken: first.details.approvalToken }),
    /stale|invalidated|invalid/i,
    "pre-restart approval is invalid",
  );
  const fresh = await fixture.call(restarted.tool, { action: "continue", runId: planned.details.runId });
  assert.equal(fresh.details.status, "paused");
  assert.ok(fresh.details.approvalToken, "restart requires a fresh visible-main approval");

  const second = await fixture.call(restarted.tool, {
    action: "continue", runId: planned.details.runId, approvalToken: fresh.details.approvalToken,
  });
  assert.equal(second.details.status, "awaiting_supervisor");
  assert.equal(second.details.checkpoint.taskId, "dynamic-1-second");
  assert.equal(records(fixture.log).filter((row) => row.agentName === "coder").length, 2, "second approval settles exactly one more executor");
  assert.equal(records(fixture.log).filter((row) => row.agentName === "reviewer").length, 0, "verifier remains behind its own boundary");

  const verified = await fixture.call(restarted.tool, {
    action: "continue", runId: planned.details.runId, approvalToken: second.details.approvalToken,
  });
  assert.equal(verified.details.status, "terminal");
  assert.equal(verified.details.terminalOutcome, "pass");
  assert.equal(records(fixture.log).filter((row) => row.agentName === "reviewer").length, 1, "verifier starts only after explicit boundary approval");
  const terminal = stateAt(fixture.runs, planned.details.runId);
  assert.equal(terminal.runtime.cursor.stage, "terminal");
  assert.deepEqual(terminal.runtime.cursor.completedTaskIds, ["dynamic-1-first", "dynamic-1-second"]);
  return restarted;
}

async function testDiscoveryAndFuturePaths(modules, fixture) {
  const before = records(fixture.log).length;
  const discovered = await fixture.call(modules.tool, {
    task: "Discover the declarative fixture scope without running its phases.",
    paradigm: fixture.workflowName,
    discoveryOnly: true,
    cwd: fixture.workspace,
    preflight: false,
  });
  assert.equal(discovered.details.status, "awaiting_supervisor", "unsupported per-shape discovery cannot bypass visible-main");
  assert.equal(discovered.details.protocol.adapterId, modules.supervision.GENERIC_SHAPE_ADAPTER_ID);
  assert.equal(records(fixture.log).length, before, "declarative discovery omission starts no phase worker");
  deleteRun(fixture.runs, discovered.details.runId);

  for (const contract of [
    undefined,
    { classification: "executor-bearing" },
    { classification: "mutating", supervision: { protocolId: "host-task-boundary-v1", adapterId: "future-unimplemented-v1", adapterVersion: 1 } },
  ]) {
    const dispatch = modules.supervision.resolveShapeDispatch(contract, undefined);
    assert.equal(dispatch.disposition, "fail-closed", "future/unclassified execution fails closed when supervision is omitted");
  }
  const indexSource = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  const gate = indexSource.indexOf("const execution = nativeShape?.execution ?? resolvedDynamicWorkflow?.execution");
  const preflight = indexSource.indexOf("runProviderPreflight", gate);
  assert.ok(gate >= 0 && preflight > gate, "capability gate remains before provider preflight in registered-tool dispatch");

  const unknownBefore = records(fixture.log).length;
  const unknown = await fixture.call(modules.tool, {
    task: "Exercise a future unregistered shape.", paradigm: "future-unclassified-shape", cwd: fixture.workspace,
  });
  assert.equal(unknown.details.status, "fail");
  assert.equal(unknown.details.spawnedCount, 0);
  assert.equal(unknown.details.preflightStarted, false);
  assert.equal(records(fixture.log).length, unknownBefore, "unknown future path starts neither preflight nor worker");
}

async function testExplicitOffAndReadOnlyCompatibility(modules, fixture) {
  for (const [name, exportName] of SUPERVISED) {
    const shape = makeJiti()(path.join(ROOT, "src", "shapes", `${name}.ts`))[exportName];
    assert.equal(modules.supervision.resolveShapeDispatch(shape.execution, "off").disposition, "legacy-off", `${name} accepts explicit compatibility off`);
  }

  const dynamicBefore = records(fixture.log).length;
  const dynamic = await fixture.call(modules.tool, {
    task: "Exercise the declarative fixture in explicit compatibility mode.",
    paradigm: fixture.workflowName,
    supervision: "off",
    preflight: false,
    cwd: fixture.workspace,
  });
  assert.equal(dynamic.details.status, "pass");
  assert.equal(dynamic.details.spawnedCount, 2);
  assert.equal(records(fixture.log).length, dynamicBefore + 2, "explicit off runs both declarative phases directly");
  assert.equal(fs.existsSync(path.join(fixture.runs, dynamic.details.runId, "supervision.json")), false);

  const pevBefore = records(fixture.log).length;
  const pev = await fixture.call(modules.tool, {
    task: "Analyze the bounded compatibility fixture and report findings.",
    paradigm: "plan-execute-verify",
    supervision: "off",
    preflight: false,
    maxRetries: 0,
    cwd: fixture.workspace,
  });
  assert.equal(pev.details.status, "pass");
  assert.deepEqual(records(fixture.log).slice(pevBefore).map((row) => row.agentName), ["planner", "coder", "reviewer"]);

  const readOnlyBefore = records(fixture.log).length;
  const evidence = await fixture.call(modules.tool, {
    task: "SHAPE_CANARY:evidence-audit", paradigm: "evidence-audit", preflight: false, cwd: fixture.workspace,
  });
  assert.equal(evidence.details.status, "pass");
  assert.equal(evidence.details.spawnedCount, 0);
  const verified = await fixture.call(modules.tool, {
    task: "Verify CHECK-1 against the existing fixture evidence.", paradigm: "verify-only", preflight: false, cwd: fixture.workspace,
  });
  assert.equal(verified.details.status, "pass");
  const proposed = await fixture.call(modules.tool, {
    task: "Propose a bounded red-team blue-team judge paradigm without writing files.", paradigm: "paradigm-creator", preflight: false, cwd: fixture.workspace,
  });
  assert.equal(proposed.details.status, "pass");
  const readOnlyCalls = records(fixture.log).slice(readOnlyBefore);
  assert.equal(readOnlyCalls.length, 2, "read-only canary plus two read-only operations have expected spawn count");
  readOnlyCalls.forEach((row) => assertNoMutatingTools(row, row.agentName));
  assert.equal(fs.readdirSync(fixture.runs).some((runId) => fs.existsSync(path.join(fixture.runs, runId, "supervision.json"))), false,
    "read-only and cleaned compatibility paths create no visible-main state");
}

async function testHistoricalResumeAndFoundations(modules, fixture) {
  const historicalId = `matrix-historical-${Date.now().toString(36)}`;
  const historical = modules.runState.RunStateStore.create(
    historicalId,
    "preregistered-concurrency-spike",
    "Resume the bounded historical fixture.",
    { cwd: fixture.workspace, preflight: false, paradigm: "preregistered-concurrency-spike" },
    ["implement", "verify"],
  );
  historical.checkpointPhase(0, "implement", {
    agentName: "coder", task: "implement", text: "restored", stderr: "", exitCode: 0, durationMs: 1, events: 0,
  });
  const before = records(fixture.log).length;
  const resumed = await fixture.call(modules.tool, { resume: historicalId, cwd: fixture.workspace, preflight: false });
  assert.equal(resumed.details.status, "awaiting_supervisor");
  assert.equal(resumed.details.protocol.adapterId, modules.supervision.GENERIC_SHAPE_ADAPTER_ID);
  assert.equal(resumed.details.cursor.nextTaskIndex, 1);
  assert.equal(records(fixture.log).length, before, "historical completed prefix resumes without respawn");
  const bound = modules.runState.RunStateStore.load(historicalId).state.supervision;
  assert.equal(bound.mode, "visible-main");
  assert.equal(bound.cursor.nextTaskIndex, 1);
  deleteRun(fixture.runs, historicalId);

  const laneRoot = fs.mkdtempSync(path.join(fixture.temp, "lane-"));
  const worktree = { root: laneRoot, realRoot: fs.realpathSync.native(laneRoot) };
  const violations = modules.supervision.checkLanePaths({
    lane: "product", cwd: laneRoot, worktree,
    paths: ["src/allowed.ts", "tests/outside.cjs", "../escape.txt"],
    allowedWriteSet: ["src/"], protectedRoots: [],
  });
  assert.deepEqual(new Set(violations.map((item) => item.code)), new Set(["out_of_scope_path", "path_escape"]), "lane and write-set violations fail deterministically");

  fs.writeFileSync(path.join(laneRoot, "dirty.txt"), "before\n");
  const bytesBefore = modules.writeSet.captureContentSignatureSnapshot(laneRoot);
  fs.writeFileSync(path.join(laneRoot, "dirty.txt"), "after!\n");
  const byteChanges = modules.writeSet.diffContentSignatureSnapshots(bytesBefore, modules.writeSet.captureContentSignatureSnapshot(laneRoot));
  assert.deepEqual(byteChanges.map((change) => [change.path, change.kind]), [["dirty.txt", "modified"]], "pre-dirty byte changes remain observable");

  const survivorId = `matrix-survivor-${Date.now().toString(36)}`;
  const survivor = modules.runState.RunStateStore.create(survivorId, "plan-execute-verify", "fixture", { cwd: laneRoot }, ["execute"]);
  const resultFile = survivor.survivorResultPath(0, "execute");
  const result = { agentName: "coder", task: "fixture", text: "survived", stderr: "", exitCode: 0, durationMs: 1, events: 1 };
  survivor.markDetached(0, "execute", { pid: 999999999, agentName: "coder", phaseName: "execute", phaseIndex: 0, startedAt: Date.now(), detachedAt: new Date().toISOString(), resultFile });
  fs.writeFileSync(resultFile, JSON.stringify(result), "utf8");
  const collected = await modules.runState.collectSurvivorResult(modules.runState.RunStateStore.load(survivorId).survivors.get(0), () => {}, undefined, "matrix");
  assert.equal(collected.text, "survived", "abort survivor result is collected rather than respawned");
  deleteRun(fixture.runs, survivorId);

  const generated = modules.builder.renderShapeSource({
    schemaVersion: 1, action: "build", artifactKind: "native-shape", scope: "extension", targetName: "matrix-generated-shape",
    purpose: "Exercise future shape-builder supervision output.",
    phases: [{ name: "execute", role: "executor", agentName: "coder", prompt: "Execute it.", expectedOutput: "Result." }],
    maxSubagents: 1, maxIterations: 1, terminationCondition: "Stop after execute.", evidenceModel: "Direct result.",
    failureBehavior: "Fail on error.", userFacingExplanation: "One bounded phase.",
  });
  assert.match(generated, /execution:\s*GENERIC_EXECUTOR_SHAPE_EXECUTION/);
  assert.deepEqual(modules.builder.staticCheckGeneratedShape(generated), [], "shape-builder output is supervision-ready");

  const readOnlyNext = modules.next.compileWorkflow(modules.next.readOnlyFanoutJoinPilot());
  assert.deepEqual(readOnlyNext.schedule.waves.map((wave) => wave.map((phase) => phase.id)), [["inspect-api", "inspect-state"], ["join-findings"]]);
  const writerNext = modules.next.compileWorkflow(modules.next.singleWriterPevPilot("validate.cjs"));
  assert.deepEqual(writerNext.schedule.waves.map((wave) => wave.map((phase) => phase.id)), [["plan"], ["implement"], ["integrate"], ["test"], ["verify"]]);
  assert.equal(writerNext.ir.phases.filter((phase) => phase.kind === "agent" && phase.access === "workspace-write").length, 1,
    "Orchestrator Next preserves one executor/writer before test and verifier boundaries");

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const file of [
    "test-abort-resume.cjs", "test-write-set-enforcement.cjs", "test-shape-builder.cjs",
    "test-ssi-single-writer-exclusive-lane.cjs", "test-orchestrator-next.cjs",
  ]) assert.match(packageJson.scripts.test, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${file} remains in the full regression boundary`);
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "all-shape-visible-main-"));
  const fixture = {
    temp,
    workspace: path.join(temp, "workspace"),
    workflows: path.join(temp, "workflows"),
    runs: path.join(temp, "runs"),
    log: path.join(temp, "fake-pi.jsonl"),
    workflowName: "matrix-declarative",
  };
  fs.mkdirSync(fixture.workspace, { recursive: true });
  fs.mkdirSync(fixture.workflows, { recursive: true });
  fs.writeFileSync(path.join(fixture.workflows, `${fixture.workflowName}.workflow.json`), `${JSON.stringify(workflow(fixture.workflowName), null, 2)}\n`);
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = fixture.runs;
  process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT = fixture.workflows;
  process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT = path.join(temp, "user-workflows");
  process.env.FAKE_PI_LOG = fixture.log;
  fixture.call = (tool, params) => tool.execute("all-shape-visible-main-matrix", params, undefined, () => {}, { cwd: fixture.workspace });

  try {
    let modules = loadModules();
    await testNativeInventoryAndOmittedModeDispatch(modules, fixture);
    modules = await testDynamicReplayRestartAndVerifierBoundary(modules, fixture);
    deleteRun(fixture.runs, fs.readdirSync(fixture.runs).find((runId) => fs.existsSync(path.join(fixture.runs, runId, "supervision.json"))));
    await testDiscoveryAndFuturePaths(modules, fixture);
    await testExplicitOffAndReadOnlyCompatibility(modules, fixture);
    await testHistoricalResumeAndFoundations(modules, fixture);
    console.log(`test-all-shape-visible-main-matrix: ${NATIVE_MATRIX.length} native shapes plus declarative/custom/future/resume paths passed`);
  } finally {
    for (const key of ["PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT", "PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT", "FAKE_PI_LOG"]) delete process.env[key];
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("test-all-shape-visible-main-matrix: FAIL");
  console.error(error);
  process.exit(1);
});
