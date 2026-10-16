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
const supervision = jiti(path.join(PROJECT_ROOT, "src", "supervision.ts"));
const runState = jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));
const writeSet = jiti(path.join(PROJECT_ROOT, "src", "write-set.ts"));

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function missionInput(root, cwd = root) {
  return {
    originalTask: "Implement a generic supervised shape.",
    cwd,
    worktree: { root, realRoot: fs.realpathSync.native(root), branch: "main", baseline: "abc123" },
    paradigm: "generic-fixture",
    lane: "orchestrator-maintenance",
    routes: [{ role: "executor", agentName: "coder", provider: "openai-codex", model: "gpt-5.6-sol" }],
    constraints: ["Stay in scope."],
    nonGoals: ["No product edits."],
    acceptanceCriteria: [{ id: "AC-01", text: "Persist each task boundary.", required: true }],
  };
}

function tasks() {
  return [{ id: "task-1", description: "Build foundation", dependsOn: [], criteria: ["AC-01"] }];
}

function identity(adapterId = supervision.GENERIC_SHAPE_ADAPTER_ID) {
  return { protocolId: supervision.HOST_TASK_BOUNDARY_PROTOCOL_ID, adapterId, adapterVersion: 1 };
}

function testConservativeCapabilityResolution() {
  assert.deepEqual(supervision.resolveShapeSupervision(undefined), {
    disposition: "fail-closed",
    classification: "unknown",
    requiresVisibleMain: true,
    reason: "missing-execution-classification",
  });
  assert.equal(supervision.resolveShapeSupervision({ classification: "read-only" }).disposition, "read-only");
  assert.deepEqual(supervision.resolveShapeSupervision({ classification: "executor-bearing" }), {
    disposition: "fail-closed",
    classification: "executor-bearing",
    requiresVisibleMain: true,
    reason: "missing-supervision-adapter",
  });
  const resolved = supervision.resolveShapeSupervision({
    classification: "mutating",
    supervision: identity(),
  });
  assert.equal(resolved.disposition, "supervised");
  assert.deepEqual(resolved.identity, identity());
  assert.equal(
    supervision.resolveShapeSupervision({
      classification: "executor-bearing",
      supervision: { protocolId: "future-protocol-v9", adapterId: "fixture-v1", adapterVersion: 1 },
    }).reason,
    "unsupported-supervision-protocol",
  );
}

function testCwdSpellingAndCanonicalIdentity() {
  const root = tempDir("supervision-cwd");
  try {
    const original = process.platform === "win32" ? root.replace(/\//g, "\\") : root;
    const equivalent = original.replace(/\\/g, "/");
    const mission = supervision.createFrozenMission(missionInput(root, original));
    assert.equal(mission.cwd, original, "durable mission preserves caller cwd spelling");
    assert.equal(
      supervision.canonicalDirectoryIdentity("C:\\Users\\Example\\Project"),
      supervision.canonicalDirectoryIdentity("c:/Users/Example/Project/"),
      "Windows slash/case aliases compare as one directory",
    );
    assert.equal(
      supervision.detectBoundaryDrift({
        mission,
        currentMissionHash: mission.missionHash,
        currentCwd: equivalent,
        currentWorktreeRoot: mission.worktree.root,
        currentWorktreeRealRoot: mission.worktree.realRoot,
        currentBranch: mission.worktree.branch,
        currentBaseline: mission.worktree.baseline,
      }).some((flag) => flag.code === "cwd_changed"),
      false,
      "equivalent cwd slash spelling is not drift",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFrozenWorkspaceIdentityDriftBlocks() {
  const root = tempDir("supervision-workspace-drift");
  try {
    const mission = supervision.createFrozenMission(missionInput(root));
    const stable = {
      mission,
      currentMissionHash: mission.missionHash,
      currentCwd: mission.cwd,
      currentWorktreeRoot: mission.worktree.root,
      currentWorktreeRealRoot: mission.worktree.realRoot,
      currentBranch: mission.worktree.branch,
      currentBaseline: mission.worktree.baseline,
    };
    const assertBlocking = (override, expectedCode) => {
      const flags = supervision.detectBoundaryDrift({ ...stable, ...override });
      const flag = flags.find((candidate) => candidate.code === expectedCode);
      assert.ok(flag, `expected ${expectedCode}`);
      assert.equal(flag.blocking, true, `${expectedCode} must block continuation`);
    };

    assert.deepEqual(supervision.detectBoundaryDrift(stable), [], "unchanged frozen workspace remains resumable");
    assertBlocking({ currentWorktreeRoot: path.join(root, "other-root") }, "worktree_root_changed");
    assertBlocking({ currentWorktreeRealRoot: path.join(root, "other-real-root") }, "worktree_real_root_changed");
    assertBlocking({ currentBranch: "feature/drift" }, "branch_changed");
    const baselineFlag = supervision.detectBoundaryDrift({ ...stable, currentBaseline: "def456", baselineChangePaths: ["changed.txt"] })
      .find((candidate) => candidate.code === "baseline_changed");
    assert.ok(baselineFlag, "expected baseline_changed");
    assert.equal(baselineFlag.blocking, false, "commit drift is supervisor-visible advisory rather than infrastructure stop");
    assert.match(baselineFlag.message, /changed\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testGenericRuntimeAtomicRoundTrip() {
  const stateRoot = tempDir("generic-supervision-store");
  const workspace = tempDir("generic-supervision-workspace");
  try {
    const mission = supervision.createFrozenMission(missionInput(workspace));
    const protocol = identity("fixture-adapter-v1");
    const cursor = supervision.createGenericSupervisionCursor(protocol, {
      stage: "executor-task",
      nextTaskIndex: 1,
      completedTaskIds: ["task-0"],
      currentTaskId: "task-1",
      lastCheckpointId: "checkpoint-0001",
    });
    const runtime = supervision.createGenericSupervisionRuntime({
      identity: protocol,
      cursor,
      params: { cwd: workspace },
      intake: { task: mission.originalTask },
      plan: { tasks: tasks(), notes: "fixture" },
      completedTaskIds: ["task-0"],
      executorOutputs: [{ taskId: "task-0", outcome: "pass" }],
      contentBaseline: writeSet.captureContentSignatureSnapshot(workspace),
      repairCount: 0,
      adapterState: { phase: "execute" },
    });
    const initial = {
      ...supervision.createInitialSupervisionState({ runId: "generic-runtime", mission, tasks: tasks() }),
      runtime,
    };
    const store = new supervision.SupervisionStateStore("generic-runtime", stateRoot);
    store.create(initial);
    assert.deepEqual(store.loadReadOnly().runtime.cursor, cursor);
    assert.equal(store.loadReadOnly().runtime.identity.adapterId, "fixture-adapter-v1");
    assert.equal(fs.readdirSync(store.runDir).some((name) => name.includes(".tmp-")), false);

    const mismatched = structuredClone(store.loadReadOnly());
    mismatched.runtime.cursor.identity.adapterId = "other-adapter-v1";
    assert.throws(() => store.save(mismatched), /identity mismatch/);
    const switched = structuredClone(store.loadReadOnly());
    switched.runtime.identity.adapterId = "other-adapter-v1";
    switched.runtime.cursor.identity.adapterId = "other-adapter-v1";
    assert.throws(() => store.save(switched), /Refusing to change the durable/);
    assert.equal(store.loadReadOnly().runtime.identity.adapterId, "fixture-adapter-v1", "rejected save leaves durable bytes intact");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function testHistoricalRunStateBackwardCompatibilityAndBinding() {
  const root = tempDir("historical-run-state");
  const previous = process.env.PI_ORCHESTRATOR_RUNS_ROOT;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = root;
  try {
    const legacy = runState.RunStateStore.create(
      "legacy-unbound",
      "legacy-shape",
      "legacy task",
      { cwd: "C:/legacy" },
      ["execute"],
    );
    assert.equal(runState.RunStateStore.load(legacy.runId).state.supervision, undefined, "old unbound states still load");

    const protocol = identity("historical-adapter-v1");
    const cursor = supervision.createGenericSupervisionCursor(protocol);
    legacy.bindSupervision({
      schemaVersion: 1,
      mode: "visible-main",
      classification: "executor-bearing",
      identity: protocol,
      cursor,
    });
    const loaded = runState.RunStateStore.load(legacy.runId);
    assert.equal(loaded.state.supervision.cursor.stage, "plan");
    assert.equal(loaded.state.supervision.identity.adapterId, "historical-adapter-v1");
    assert.throws(() => legacy.bindSupervision({
      ...loaded.state.supervision,
      identity: identity("replacement-adapter-v1"),
      cursor: supervision.createGenericSupervisionCursor(identity("replacement-adapter-v1")),
    }), /Refusing to change/);
  } finally {
    if (previous === undefined) delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;
    else process.env.PI_ORCHESTRATOR_RUNS_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async function main() {
  const tests = [
    ["conservative shape capability resolution", testConservativeCapabilityResolution],
    ["durable cwd spelling with canonical comparison", testCwdSpellingAndCanonicalIdentity],
    ["frozen worktree/branch block while commit drift is advisory", testFrozenWorkspaceIdentityDriftBlocks],
    ["generic cursor/runtime atomic round trip", testGenericRuntimeAtomicRoundTrip],
    ["historical state compatibility and pinned binding", testHistoricalRunStateBackwardCompatibilityAndBinding],
  ];
  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
  console.log("test-supervision-foundations: all scenarios passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
