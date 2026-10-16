#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");

function installJiti() {
  process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  return require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initWorkspace(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "legacy-migration@example.invalid");
  git(root, "config", "user.name", "Legacy Migration Fixture");
  fs.writeFileSync(path.join(root, "seed.txt"), "frozen seed\n");
  git(root, "add", "seed.txt");
  git(root, "commit", "--quiet", "-m", "fixture baseline");
  return {
    root,
    realRoot: fs.realpathSync.native(root),
    branch: git(root, "rev-parse", "--abbrev-ref", "HEAD"),
    baseline: git(root, "rev-parse", "HEAD"),
  };
}

function intake(originalTask) {
  return {
    task_summary: originalTask,
    task_type: "legacy migration fixture",
    user_intent: "Resume without replay.",
    goal_attractor: "A machine-evidenced verifier result.",
    task_scope: "Fixture workspace only.",
    constraints: ["Preserve frozen state."],
    invariants: ["Do not replay completed tasks."],
    success_criteria: ["The resumed boundary is safe."],
    failure_criteria: ["Duplicate execution fails."],
    original_task: originalTask,
  };
}

function outputFor(task) {
  return {
    taskId: task.id,
    description: task.description,
    agentName: "coder",
    output: `historical output for ${task.id}`,
    stderr: undefined,
    exitCode: 0,
    durationMs: 1,
    toolCalls: { total: 2, mutating: 1, byTool: { write: 1, bash: 1 } },
  };
}

function createLegacyFixture(supervision, writeSet, options) {
  const workspace = options.workspace;
  const worktree = { ...options.worktree, ...(options.worktreeOverride || {}) };
  const tasks = options.tasks;
  const criterionIds = [...new Set(tasks.flatMap((task) => task.criteria))];
  const originalTask = `Historical ${options.boundary} PEV fixture.`;
  const mission = supervision.createFrozenMission({
    originalTask,
    cwd: workspace,
    worktree,
    paradigm: "plan-execute-verify",
    lane: "product",
    routes: [
      { role: "planner", agentName: "planner", provider: "openai-codex", model: "gpt-5.6-sol" },
      { role: "executor", agentName: "coder", provider: "openai-codex", model: "gpt-5.6-sol" },
      { role: "verifier", agentName: "reviewer", provider: "openai-codex", model: "gpt-5.5" },
    ],
    constraints: ["Stay inside the fixture workspace."],
    nonGoals: ["Do not replay completed executors."],
    acceptanceCriteria: criterionIds.map((id) => ({ id, text: `Machine-verify ${id}.`, required: true })),
  });
  const runId = `legacy-${options.boundary}`;
  const store = new supervision.SupervisionStateStore(runId, options.runRoot);
  let state = supervision.createInitialSupervisionState({
    runId,
    mission,
    tasks,
    now: new Date("2026-08-29T10:00:00.000Z"),
  });
  store.create(state);

  const initialBaseline = writeSet.captureContentSignatureSnapshot(workspace);
  state = store.appendCheckpoint(state, {
    kind: "plan",
    createdAt: "2026-08-29T10:01:00.000Z",
    missionHash: mission.missionHash,
    criteria: criterionIds,
    effectChanges: [],
    outcome: "plan_ready",
  }, { fullPlan: tasks, effectsBaseline: initialBaseline });

  const completedTaskIds = [];
  const executorOutputs = [];
  let currentBaseline = initialBaseline;
  for (let index = 0; index < (options.completedCount || 0); index += 1) {
    const task = tasks[index];
    const before = currentBaseline;
    const target = options.completedFiles[index];
    fs.writeFileSync(path.join(workspace, target), `historical bytes for ${task.id}\n`);
    currentBaseline = writeSet.captureContentSignatureSnapshot(workspace);
    const effects = writeSet.diffContentSignatureSnapshots(before, currentBaseline);
    const output = outputFor(task);
    state = store.appendCheckpoint(state, {
      kind: "executor",
      createdAt: `2026-08-29T10:0${index + 2}:00.000Z`,
      missionHash: mission.missionHash,
      taskId: task.id,
      criteria: task.criteria,
      effectChanges: effects,
      outcome: "settled",
    }, { output, effects });
    completedTaskIds.push(task.id);
    executorOutputs.push(output);
  }

  if (options.verifierFailure) {
    state = store.appendCheckpoint(state, {
      kind: "verifier",
      createdAt: "2026-08-29T10:05:00.000Z",
      missionHash: mission.missionHash,
      criteria: options.verifierFailure,
      effectChanges: [],
      outcome: "fail",
    }, {
      verifier: { agentName: "reviewer", text: "historical verifier failure" },
      findings: options.verifierFailure.map((criterionId) => ({ criterionId, status: "fail", evidence: [] })),
    });
  }

  const issued = supervision.issueApprovalToken({
    runId,
    missionHash: mission.missionHash,
    checkpointId: state.checkpoints.at(-1).id,
    action: "continue",
  }, new Date("2026-08-29T10:06:00.000Z"), () => Buffer.alloc(32, options.tokenByte || 7));

  const completedSet = new Set(completedTaskIds);
  state.status = options.status || "awaiting_supervisor";
  state.currentTaskId = options.currentTaskId;
  state.lastTaskId = completedTaskIds.at(-1);
  state.currentApproval = issued.record;
  state.pauseReason = options.pauseReason;
  state.completedCriteria = criterionIds.filter((criterionId) =>
    tasks.filter((task) => task.criteria.includes(criterionId)).every((task) => completedSet.has(task.id))
  );
  state.runtime = {
    // Deliberately no `kind`: this is the pre-generic schema-v1 PEV payload.
    params: {
      task: originalTask,
      cwd: workspace,
      paradigm: "plan-execute-verify",
      preflight: false,
      maxRetries: options.maxRetries || 0,
      verifierCount: options.verifierCount || 1,
      plannerAgent: "planner",
      plannerProvider: "openai-codex",
      plannerModel: "gpt-5.6-sol",
      executorAgent: "coder",
      executorProvider: "openai-codex",
      executorModel: "gpt-5.6-sol",
      verifierAgent: "reviewer",
      verifierProvider: "openai-codex",
      verifierModel: "gpt-5.5",
      predictedWriteSet: options.predictedWriteSet,
    },
    intake: intake(originalTask),
    plan: { tasks, notes: `Frozen ${options.boundary} plan.`, predictedWriteSet: options.predictedWriteSet },
    completedTaskIds,
    executorOutputs,
    contentBaseline: currentBaseline,
    repairCount: options.repairCount || 0,
    hostInstanceId: "historical-host-before-generic-runtime",
  };
  store.save(state);

  return {
    runId,
    oldToken: issued.token,
    workspace,
    boundary: options.boundary,
    expectedMode: options.expectedMode || "exact-continuation",
    expectedExecutors: options.expectedExecutors,
    expectedCompleted: options.expectedCompleted,
    expectedOutcome: options.expectedOutcome || "pass",
    expectedSourceCheckpointIds: state.checkpoints.map((checkpoint) => checkpoint.id),
    expectedOldExecutorCheckpointIds: state.checkpoints.filter((checkpoint) => checkpoint.kind === "executor").map((checkpoint) => checkpoint.id),
    expectedOldEffects: state.checkpoints.filter((checkpoint) => checkpoint.kind === "executor").flatMap((checkpoint) => checkpoint.effectChanges),
    expectedContentBaseline: currentBaseline,
    expectedHistoricalOutputs: executorOutputs,
    mission: {
      missionHash: mission.missionHash,
      routes: mission.routes,
      lane: mission.lane,
      cwd: mission.cwd,
      worktree: mission.worktree,
    },
  };
}

function readCalls(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function childMain() {
  const createJiti = installJiti();
  const fixture = JSON.parse(process.env.LEGACY_FIXTURE);
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  let tool;
  jiti(path.join(ROOT, "src", "index.ts")).default({
    registerTool(value) { if (value.name === "orchestrate") tool = value; },
    registerCommand() {},
  });
  assert.ok(tool, "fresh source host registered the on-disk orchestrate tool");
  const call = (params) => tool.execute("legacy-migration", params, undefined, () => {}, { cwd: process.env.COORDINATOR_WORKSPACE });
  const stateFile = path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, fixture.runId, "supervision.json");

  const beforeInspect = fs.readFileSync(stateFile);
  const inspected = await call({ action: "inspect", runId: fixture.runId });
  assert.equal(inspected.details.status, "paused", `${fixture.boundary}: restart enters/retains pause`);
  assert.deepEqual(fs.readFileSync(stateFile), beforeInspect, `${fixture.boundary}: inspect is byte-immutable`);
  assert.equal(inspected.details.legacyCompatibility.mode, fixture.expectedMode);
  assert.equal(inspected.details.legacyCompatibility.executorRespawnAllowed, fixture.expectedMode === "exact-continuation");
  assert.equal(path.resolve(inspected.details.cwd), path.resolve(fixture.mission.cwd));
  assert.equal(inspected.details.missionHash, fixture.mission.missionHash);

  await assert.rejects(
    () => call({ action: "continue", runId: fixture.runId, approvalToken: fixture.oldToken }),
    /invalid|stale|consumed/i,
    `${fixture.boundary}: pre-restart one-use approval is invalidated`,
  );
  const migrated = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(migrated.runtime.kind, "generic-shape");
  assert.deepEqual(migrated.mission.routes, fixture.mission.routes);
  assert.equal(migrated.lane, fixture.mission.lane);
  assert.equal(path.resolve(migrated.mission.cwd), path.resolve(fixture.mission.cwd));
  assert.deepEqual(migrated.mission.worktree, fixture.mission.worktree);
  assert.deepEqual(migrated.runtime.adapterState.legacyPevMigration.sourceCheckpointIds, fixture.expectedSourceCheckpointIds);
  assert.deepEqual(migrated.runtime.adapterState.legacyPevMigration.executorCheckpointIds, fixture.expectedOldExecutorCheckpointIds);
  assert.deepEqual(migrated.runtime.contentBaseline, fixture.expectedContentBaseline, `${fixture.boundary}: effects baseline is preserved exactly`);
  assert.deepEqual(migrated.runtime.executorOutputs, fixture.expectedHistoricalOutputs, `${fixture.boundary}: settled executor outputs are restored exactly`);
  for (const expectedEffect of fixture.expectedOldEffects) {
    assert.ok(migrated.checkpoints.some((checkpoint) => checkpoint.effectChanges.some((effect) =>
      effect.path === expectedEffect.path && effect.kind === expectedEffect.kind
    )), `${fixture.boundary}: historical effect ${expectedEffect.kind}:${expectedEffect.path} survives migration`);
  }

  const renewed = await call({ action: "continue", runId: fixture.runId });
  assert.ok(renewed.details.approvalToken, `${fixture.boundary}: fresh visible-main approval issued`);
  let result = await call({ action: "continue", runId: fixture.runId, approvalToken: renewed.details.approvalToken });
  if (result.details.status === "awaiting_supervisor") {
    assert.equal(result.details.checkpoint.kind, "executor");
    result = await call({ action: "continue", runId: fixture.runId, approvalToken: result.details.approvalToken });
  }
  assert.equal(result.details.status, "terminal", `${fixture.boundary}: ${JSON.stringify(result.details)}`);
  assert.equal(result.details.terminalOutcome, fixture.expectedOutcome);

  const calls = readCalls(process.env.FAKE_PI_LOG);
  const coders = calls.filter((entry) => entry.agentName === "coder");
  assert.equal(coders.length, fixture.expectedExecutors, `${fixture.boundary}: no completed executor is duplicated`);
  assert.ok(coders.every((entry) => entry.provider === "openai-codex" && entry.model === "gpt-5.6-sol"));
  const finalState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(finalState.runtime.completedTaskIds, fixture.expectedCompleted);
  assert.equal(finalState.runtime.executorOutputs.length, fixture.expectedCompleted.length, "restored and new outputs are both durable");

  if (fixture.boundary === "verifier-repair") {
    assert.ok(finalState.tasks.some((task) => task.id === "repair-1"), "legacy verifier repair task is retained");
    assert.ok(finalState.runtime.plan.tasks.some((task) => task.id === "repair-1"));
    assert.equal(fs.existsSync(path.join(fixture.workspace, "repair.txt")), true, "the retained repair task, not a completed task, spawned");
    assert.equal(fs.readFileSync(path.join(fixture.workspace, "out-1.txt"), "utf8"), "historical bytes for task-1\n");
  }
  if (fixture.boundary === "paused") {
    assert.equal(coders.length, 0, "ambiguous paused executor cannot respawn in verification-only compatibility mode");
    const reviewers = calls.filter((entry) => entry.agentName === "reviewer");
    assert.equal(reviewers.length, 2);
    assert.ok(reviewers.every((entry) => entry.provider === "openai-codex" && entry.model === "gpt-5.5"));
    const batch = finalState.runtime.verifierBatches.at(-1);
    assert.equal(batch.members.length, 2);
    assert.deepEqual(batch.members.map((member) => member.status), ["pass", "fail"]);
    assert.equal(batch.aggregateStatus, "fail", "strict consensus makes either reviewer FAIL aggregate FAIL");
    assert.equal(batch.parallelOverlap, true);
    assert.ok(Math.max(...batch.members.map((member) => member.spawnStartedSequence)) < Math.min(...batch.members.map((member) => member.completedSequence)));
    assert.ok(batch.aggregationStartedSequence > Math.max(...batch.members.map((member) => member.completedSequence)));
    assert.ok(Date.parse(batch.aggregationStartedAt) >= Math.max(...batch.members.map((member) => Date.parse(member.completedAt))));
    assert.ok(batch.members.every((member) => member.spawnStartedAt && member.completedAt && member.provider && member.model));
    const verifierCheckpoint = finalState.checkpoints.filter((checkpoint) => checkpoint.kind === "verifier").at(-1);
    const payload = JSON.parse(fs.readFileSync(verifierCheckpoint.payloadFile, "utf8")).payload;
    assert.equal(payload.verifiers.length, 2, "both reviewer outputs persist in the terminal checkpoint");
    assert.deepEqual(payload.verificationBatch, batch);
  }

  process.stdout.write(`${JSON.stringify({ boundary: fixture.boundary, status: result.details.status })}\n`);
}

async function driftChildMain() {
  const createJiti = installJiti();
  const fixture = JSON.parse(process.env.LEGACY_FIXTURE);
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  let tool;
  jiti(path.join(ROOT, "src", "index.ts")).default({ registerTool(value) { if (value.name === "orchestrate") tool = value; }, registerCommand() {} });
  const call = (params) => tool.execute("legacy-drift", params, undefined, () => {}, { cwd: process.env.COORDINATOR_WORKSPACE });
  await call({ action: "inspect", runId: fixture.runId });
  await assert.rejects(() => call({ action: "continue", runId: fixture.runId, approvalToken: fixture.oldToken }), /invalid|stale|consumed/i);
  const renewed = await call({ action: "continue", runId: fixture.runId });
  const blocked = await call({ action: "continue", runId: fixture.runId, approvalToken: renewed.details.approvalToken });
  assert.equal(blocked.details.status, "blocked_infrastructure");
  const codes = new Set(blocked.details.drift.map((flag) => flag.code));
  for (const code of ["worktree_real_root_changed", "branch_changed", "baseline_changed"]) assert.ok(codes.has(code), code);
  assert.equal(readCalls(process.env.FAKE_PI_LOG).length, 0, "identity drift blocks before any worker spawn");
  process.stdout.write(`${JSON.stringify({ boundary: "drift", status: blocked.details.status })}\n`);
}

function runChild(mode, fixture, env) {
  const result = spawnSync(process.execPath, [__filename], {
    cwd: ROOT,
    env: { ...process.env, ...env, LEGACY_CHILD_MODE: mode, LEGACY_FIXTURE: JSON.stringify(fixture) },
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${mode}/${fixture.boundary} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1));
}

function parentMain() {
  installJiti();
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const supervision = jiti(path.join(ROOT, "src", "supervision.ts"));
  const writeSet = jiti(path.join(ROOT, "src", "write-set.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-pev-migration-"));
  const runRoot = path.join(temp, "runs");
  const coordinator = path.join(temp, "coordinator");
  fs.mkdirSync(runRoot, { recursive: true });
  fs.mkdirSync(coordinator, { recursive: true });
  const commonEnv = {
    PI_ORCHESTRATOR_RUNS_ROOT: runRoot,
    PI_CLI_PATH: path.join(__dirname, "fake-pi.cjs"),
    COORDINATOR_WORKSPACE: coordinator,
    FAKE_PI_EXECUTOR_STYLE: "write-summary-table",
    FAKE_PI_VISIBLE_VERIFY_DELAY_MS: "120",
  };

  try {
    const definitions = [
      {
        boundary: "plan",
        tasks: [{ id: "task-1", description: "CREATE file out-plan.txt with fixture content.", dependsOn: [], criteria: ["AC-01"], predictedWriteSet: ["out-plan.txt"] }],
        completedCount: 0,
        completedFiles: [],
        predictedWriteSet: ["out-plan.txt"],
        expectedExecutors: 1,
        expectedCompleted: ["task-1"],
      },
      {
        boundary: "executor",
        tasks: [
          { id: "task-1", description: "CREATE file out-1.txt with historical content.", dependsOn: [], criteria: ["AC-01"], predictedWriteSet: ["out-1.txt"] },
          { id: "task-2", description: "CREATE file out-2.txt with fixture content.", dependsOn: ["task-1"], criteria: ["AC-02"], predictedWriteSet: ["out-2.txt"] },
        ],
        completedCount: 1,
        completedFiles: ["out-1.txt"],
        predictedWriteSet: ["out-1.txt", "out-2.txt"],
        expectedExecutors: 1,
        expectedCompleted: ["task-1", "task-2"],
      },
      {
        boundary: "verifier-repair",
        tasks: [
          { id: "task-1", description: "CREATE file out-1.txt with historical content.", dependsOn: [], criteria: ["AC-01"], predictedWriteSet: ["out-1.txt"] },
          { id: "repair-1", description: "CREATE file repair.txt to repair only AC-01.", dependsOn: ["task-1"], criteria: ["AC-01"], predictedWriteSet: ["repair.txt"] },
        ],
        completedCount: 1,
        completedFiles: ["out-1.txt"],
        verifierFailure: ["AC-01"],
        repairCount: 1,
        maxRetries: 1,
        predictedWriteSet: ["out-1.txt", "repair.txt"],
        expectedExecutors: 1,
        expectedCompleted: ["task-1", "repair-1"],
      },
      {
        boundary: "paused",
        tasks: [
          { id: "task-1", description: "CREATE file out-1.txt with historical content.", dependsOn: [], criteria: ["AC-01"], predictedWriteSet: ["out-1.txt"] },
          { id: "task-2", description: "CREATE file must-not-replay.txt with ambiguous content.", dependsOn: ["task-1"], criteria: ["AC-02"], predictedWriteSet: ["must-not-replay.txt"] },
        ],
        completedCount: 1,
        completedFiles: ["out-1.txt"],
        status: "paused",
        pauseReason: "historical_operator_pause",
        currentTaskId: "task-2",
        verifierCount: 2,
        predictedWriteSet: ["out-1.txt", "must-not-replay.txt"],
        expectedMode: "verification-only",
        expectedExecutors: 0,
        expectedCompleted: ["task-1"],
        expectedOutcome: "fail",
      },
    ];

    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      const workspace = path.join(temp, `workspace-${definition.boundary}`);
      const worktree = initWorkspace(workspace);
      const fixture = createLegacyFixture(supervision, writeSet, {
        ...definition,
        workspace,
        worktree,
        runRoot,
        tokenByte: index + 1,
      });
      const log = path.join(temp, `${definition.boundary}.jsonl`);
      const env = {
        ...commonEnv,
        FAKE_PI_LOG: log,
        ...(definition.boundary === "paused" ? { FAKE_PI_VISIBLE_VERIFY_SEQUENCE: "pass,fail" } : {}),
      };
      assert.deepEqual(runChild("lifecycle", fixture, env), { boundary: definition.boundary, status: "terminal" });
    }

    const driftWorkspace = path.join(temp, "workspace-drift");
    const driftWorktree = initWorkspace(driftWorkspace);
    const driftFixture = createLegacyFixture(supervision, writeSet, {
      boundary: "drift",
      workspace: driftWorkspace,
      worktree: driftWorktree,
      worktreeOverride: {
        realRoot: path.join(temp, "not-the-real-worktree"),
        branch: "historical-other-branch",
        baseline: "0".repeat(40),
      },
      runRoot,
      tokenByte: 9,
      tasks: [{ id: "task-1", description: "CREATE file blocked.txt with fixture content.", dependsOn: [], criteria: ["AC-01"], predictedWriteSet: ["blocked.txt"] }],
      completedCount: 0,
      completedFiles: [],
      predictedWriteSet: ["blocked.txt"],
      expectedExecutors: 0,
      expectedCompleted: [],
    });
    assert.deepEqual(
      runChild("drift", driftFixture, { ...commonEnv, FAKE_PI_LOG: path.join(temp, "drift.jsonl") }),
      { boundary: "drift", status: "blocked_infrastructure" },
    );

    console.log("test-visible-main-legacy-pev-migration: plan, executor, verifier-repair, paused compatibility, strict parallel consensus, and frozen identity drift scenarios passed in fresh hosts");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.env.LEGACY_CHILD_MODE === "lifecycle") {
  childMain().catch((error) => { console.error(error); process.exit(1); });
} else if (process.env.LEGACY_CHILD_MODE === "drift") {
  driftChildMain().catch((error) => { console.error(error); process.exit(1); });
} else {
  try { parentMain(); } catch (error) { console.error(error); process.exit(1); }
}
