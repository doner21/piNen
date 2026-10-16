#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(PROJECT_ROOT, "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const mission = jiti(path.join(PROJECT_ROOT, "src", "mission", "index.ts"));

function contract(cwd, overrides = {}) {
  return mission.compileMissionContract({
    schemaVersion: 1,
    objective: "Make the fixture satisfy validate.cjs without weakening the required behavior.",
    cwd,
    route: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
    fallbacks: [],
    budgets: { wallClockMs: 120_000, maxTurns: 5, maxRestarts: 3, maxSpecialists: 0, maxTokens: 100_000 },
    validator: { kind: "node-workspace-validator", script: "validate.cjs", timeoutMs: 2_000, maxOutputBytes: 16_384 },
    constraints: ["Keep validate.cjs intact."],
    ...overrides,
  });
}

function ownerStart(pid) {
  return new Date(Date.UTC(2026, 8, 2, 2, 0, pid % 60)).toISOString();
}

function createValidator(workspace, expected = "fixed\n") {
  fs.writeFileSync(path.join(workspace, "validate.cjs"), [
    "const fs = require('node:fs');",
    `const expected = ${JSON.stringify(expected)};`,
    "const actual = fs.existsSync('product.txt') ? fs.readFileSync('product.txt', 'utf8') : '';",
    "if (actual !== expected) { console.error(JSON.stringify({expected, actual})); process.exit(2); }",
    "console.log('PASS fixture');",
  ].join("\n"));
}

function events(root, runId) {
  return mission.FileMissionJournal.inspect(root, runId).events;
}

async function testRepairSamePrimary(root) {
  const workspace = path.join(root, "repair-workspace");
  const runsRoot = path.join(root, "repair-runtime");
  const sessions = path.join(root, "repair-sessions");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "product.txt"), "bad\n");
  createValidator(workspace);
  const factory = new mission.ScriptedMissionWorkerFactory({
    sessionRoot: sessions,
    firstPid: 91_000,
    turns: [
      {
        mutations: [{ path: "product.txt", content: "still-bad\n" }],
        events: [
          { type: "heartbeat" },
          { type: "tool", toolCallId: "edit-1", toolName: "edit", phase: "end" },
          { type: "cursor", cursor: "cursor-1" },
          { type: "settled", cursor: "cursor-1", tokens: 100 },
        ],
      },
      {
        mutations: [{ path: "product.txt", content: "fixed\n" }],
        events: [
          { type: "cursor", cursor: "cursor-2" },
          { type: "settled", cursor: "cursor-2", tokens: 50 },
        ],
      },
    ],
  });
  const result = await mission.runDurableMission({
    contract: contract(workspace), workerFactory: factory, runId: "repair-same-primary", runsRoot,
    processInspector: factory, ownerPid: 81_001, ownerProcessStartedAt: ownerStart(81_001),
  });
  assert.equal(result.status, "pass");
  assert.equal(result.projection.state, "SUCCEEDED");
  assert.equal(result.projection.usage.turns, 2);
  assert.equal(result.projection.usage.tokens, 150);
  assert.equal(result.projection.cursor, "cursor-2");
  assert.equal(fs.readFileSync(path.join(workspace, "product.txt"), "utf8"), "fixed\n");
  assert.equal(factory.prompts.length, 2);
  assert.match(factory.prompts[0], /DURABLE MISSION/);
  assert.match(factory.prompts[1], /HOST VALIDATOR FAILED AFTER TURN 1/);
  assert.match(factory.prompts[1], /fixture failed|expected/);
  assert.equal(new Set(factory.sessions.map((item) => item.sessionId)).size, 1, "validator repair must stay in one primary session");
  const runEvents = events(runsRoot, "repair-same-primary");
  assert.equal(runEvents.filter((event) => event.type === "validator.completed").length, 2);
  assert.deepEqual(runEvents.filter((event) => event.type === "validator.completed").map((event) => event.data.result.status), ["fail", "pass"]);
  assert.equal(runEvents.filter((event) => event.type === "repair.requested").length, 1);
  assert.equal(runEvents.at(-1).type, "mission.succeeded");
  assert.equal(fs.existsSync(path.join(workspace, "events.jsonl")), false, "mission runtime files must stay outside product workspace");
}

async function testCrashResumeWithoutDuplicateMutation(root) {
  const workspace = path.join(root, "crash-workspace");
  const runsRoot = path.join(root, "crash-runtime");
  fs.mkdirSync(workspace);
  createValidator(workspace, "once\n");
  const factory = new mission.ScriptedMissionWorkerFactory({
    sessionRoot: path.join(root, "crash-sessions"),
    firstPid: 92_000,
    turns: [
      { mutations: [{ path: "product.txt", content: "once\n" }], throwMessage: "simulated worker process crash after mutation" },
      { events: [{ type: "cursor", cursor: "recovered-cursor" }, { type: "settled", cursor: "recovered-cursor", tokens: 25 }] },
    ],
  });
  const compiled = contract(workspace);
  const first = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "crash-resume", runsRoot,
    processInspector: factory, ownerPid: 82_001, ownerProcessStartedAt: ownerStart(82_001),
  });
  assert.equal(first.status, "pending");
  assert.equal(first.projection.state, "PAUSED");
  assert.equal(first.projection.nextAction, "resume-worker");
  assert.equal(fs.readFileSync(path.join(workspace, "product.txt"), "utf8"), "once\n");

  const second = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "crash-resume", runsRoot,
    processInspector: factory, ownerPid: 82_002, ownerProcessStartedAt: ownerStart(82_002),
  });
  assert.equal(second.status, "pass");
  assert.equal(second.projection.state, "SUCCEEDED");
  assert.equal(second.projection.usage.restarts, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "product.txt"), "utf8"), "once\n", "resume must not duplicate or replace the prior correct mutation");
  assert.equal(factory.prompts.length, 2);
  assert.match(factory.prompts[1], /RESUME DURABLE MISSION/);
  assert.match(factory.prompts[1], /created:product\.txt/);
  const runEvents = events(runsRoot, "crash-resume");
  assert.equal(runEvents.filter((event) => event.type === "worker.started").length, 2);
  assert.deepEqual(runEvents.filter((event) => event.type === "lease.acquired").map((event) => event.data.lease.generation), [1, 2]);
  const started = runEvents.filter((event) => event.type === "worker.started").map((event) => event.data.identity);
  assert.equal(started[0].sessionId, started[1].sessionId, "replacement worker must reopen the durable primary session");
  assert.notEqual(started[0].pid, started[1].pid, "replacement is a fresh process identity");
}

async function testLiveSurvivorBlocksDuplicate(root) {
  const workspace = path.join(root, "survivor-workspace");
  const runsRoot = path.join(root, "survivor-runtime");
  fs.mkdirSync(workspace);
  createValidator(workspace, "alive\n");
  const factory = new mission.ScriptedMissionWorkerFactory({
    sessionRoot: path.join(root, "survivor-sessions"),
    firstPid: 93_000,
    turns: [
      { mutations: [{ path: "product.txt", content: "alive\n" }], throwMessage: "supervisor transport disappeared", throwState: "running" },
      { events: [{ type: "settled", cursor: "survivor-recovered", tokens: 10 }] },
    ],
  });
  const compiled = contract(workspace);
  const first = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "live-survivor", runsRoot,
    processInspector: factory, ownerPid: 83_001, ownerProcessStartedAt: ownerStart(83_001),
  });
  assert.equal(first.status, "pending");
  assert.equal(first.projection.nextAction, "wait-worker");
  assert.equal(factory.prompts.length, 1);
  const firstIdentity = factory.sessions[0];

  const second = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "live-survivor", runsRoot,
    processInspector: factory, ownerPid: 83_002, ownerProcessStartedAt: ownerStart(83_002),
  });
  assert.equal(second.status, "pending");
  assert.equal(second.projection.nextAction, "wait-worker");
  assert.equal(factory.prompts.length, 1, "a live prior writer must not be duplicated");
  assert.equal(factory.sessions.length, 1);

  assert.equal(await factory.terminate(firstIdentity), true);
  const third = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "live-survivor", runsRoot,
    processInspector: factory, ownerPid: 83_003, ownerProcessStartedAt: ownerStart(83_003),
  });
  assert.equal(third.status, "pass");
  assert.equal(factory.prompts.length, 2);
  assert.equal(fs.readFileSync(path.join(workspace, "product.txt"), "utf8"), "alive\n");
  const runEvents = events(runsRoot, "live-survivor");
  assert.equal(runEvents.filter((event) => event.type === "worker.started").length, 2, "only the original and post-death replacement may start");
}

async function testResumeHonorsDurableValidationState(root) {
  for (const validatorAlreadyPassed of [false, true]) {
    const label = validatorAlreadyPassed ? "validator-pass-publish" : "settled-needs-validation";
    const workspace = path.join(root, `${label}-workspace`);
    const runsRoot = path.join(root, `${label}-runtime`);
    const sessions = path.join(root, `${label}-sessions`);
    fs.mkdirSync(workspace);
    fs.mkdirSync(sessions);
    createValidator(workspace);
    const compiled = contract(workspace, {
      budgets: { wallClockMs: 120_000, maxTurns: 1, maxRestarts: 2, maxSpecialists: 0, maxTokens: 100_000 },
    });
    const factory = new mission.ScriptedMissionWorkerFactory({ sessionRoot: sessions, turns: [] });
    const runId = `resume-${label}`;
    const store = mission.FileMissionJournal.create(runsRoot, runId);
    const add = (type, data = {}) => store.append({ runId, type, generation: 1, data });
    add("mission.created", {
      missionHash: compiled.missionHash, canonicalJson: compiled.canonicalJson, cwd: compiled.contract.cwd, workerAdapter: factory.adapterName,
    });
    add("mission.started", { missionHash: compiled.missionHash });
    const baseline = mission.captureWorkspaceSnapshot(workspace);
    const baselineFile = mission.writeWorkspaceSnapshot(store.runDirectory, "baseline", baseline);
    add("workspace.snapshot", { role: "baseline", digest: baseline.digest, file: baselineFile });
    const pinned = mission.pinNodeWorkspaceValidator(workspace, store.runDirectory, compiled.contract.validator);
    add("validator.pinned", { sha256: pinned.sha256, file: pinned.pinnedFile });
    const sessionFile = path.join(sessions, `${label}.jsonl`);
    fs.writeFileSync(sessionFile, "");
    add("worker.started", { identity: {
      adapter: factory.adapterName, workerId: `${runId}:primary:1`, pid: 96_001,
      processStartedAt: "2026-09-02T03:00:00.000Z", sessionId: `${label}-session`, sessionFile,
      cursor: "settled-cursor", generation: 1, route: compiled.contract.route,
    } });
    fs.writeFileSync(path.join(workspace, "product.txt"), "fixed\n");
    add("worker.settled", { turn: 1, cursor: "settled-cursor", tokens: 10 });
    if (validatorAlreadyPassed) {
      add("validator.started", { turn: 1, sha256: pinned.sha256 });
      const passed = await mission.runPinnedNodeValidator(pinned, workspace);
      assert.equal(passed.status, "pass");
      add("validator.completed", { turn: 1, result: passed });
    }
    store.close();

    const result = await mission.runDurableMission({
      contract: compiled, workerFactory: factory, runId, runsRoot, processInspector: factory,
      ownerPid: 86_001, ownerProcessStartedAt: ownerStart(86_001),
    });
    assert.equal(result.status, "pass", `${label} must finish despite maxTurns already being reached`);
    assert.equal(factory.prompts.length, 0, `${label} must not re-prompt or start a replacement writer`);
    assert.equal(factory.sessions.length, 0);
    const runEvents = events(runsRoot, runId);
    assert.equal(runEvents.filter((event) => event.type === "worker.started").length, 1);
    assert.equal(runEvents.filter((event) => event.type === "validator.completed").length, 1);
    assert.equal(runEvents.at(-1).type, "mission.succeeded");
  }
}

async function testValidatorPassSurvivesWaitWorkerPause(root) {
  const workspace = path.join(root, "validator-pass-wait-workspace");
  const runsRoot = path.join(root, "validator-pass-wait-runtime");
  const sessions = path.join(root, "validator-pass-wait-sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(workspace, "product.txt"), "fixed\n");
  createValidator(workspace);
  const compiled = contract(workspace, {
    budgets: { wallClockMs: 120_000, maxTurns: 1, maxRestarts: 2, maxSpecialists: 0, maxTokens: 100_000 },
  });
  const factory = new mission.ScriptedMissionWorkerFactory({ sessionRoot: sessions, turns: [] });
  const runId = "validator-pass-wait-worker";
  const survivor = await factory.open({
    runId, generation: 1, cwd: compiled.contract.cwd, route: compiled.contract.route,
    fallbacks: compiled.contract.fallbacks, readOnly: false,
  });
  const store = mission.FileMissionJournal.create(runsRoot, runId);
  const add = (type, data = {}) => store.append({ runId, type, generation: 1, data });
  add("mission.created", {
    missionHash: compiled.missionHash, canonicalJson: compiled.canonicalJson, cwd: compiled.contract.cwd, workerAdapter: factory.adapterName,
  });
  add("mission.started", { missionHash: compiled.missionHash });
  const baseline = mission.captureWorkspaceSnapshot(workspace);
  const baselineFile = mission.writeWorkspaceSnapshot(store.runDirectory, "baseline", baseline);
  add("workspace.snapshot", { role: "baseline", digest: baseline.digest, file: baselineFile });
  const pinned = mission.pinNodeWorkspaceValidator(workspace, store.runDirectory, compiled.contract.validator);
  add("validator.pinned", { sha256: pinned.sha256, file: pinned.pinnedFile });
  add("worker.started", { identity: survivor.identity });
  add("worker.settled", { turn: 1, cursor: null, tokens: 10 });
  add("validator.started", { turn: 1, sha256: pinned.sha256 });
  const passed = await mission.runPinnedNodeValidator(pinned, workspace);
  assert.equal(passed.status, "pass");
  add("validator.completed", { turn: 1, result: passed });
  store.close();

  const heldLease = mission.FileWorkspaceLease.acquire({
    leaseRoot: path.join(runsRoot, "workspace-leases"), workspacePath: workspace,
    workspaceFingerprint: compiled.contract.workspaceFingerprint, runId, missionHash: compiled.missionHash,
    processInspector: factory, ownerPid: 86_051, ownerProcessStartedAt: ownerStart(86_051),
  });
  heldLease.bindWorker(survivor.identity.pid, survivor.identity.processStartedAt);
  const pending = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId, runsRoot, processInspector: factory,
    ownerPid: 86_052, ownerProcessStartedAt: ownerStart(86_052),
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.projection.nextAction, "wait-worker");
  assert.equal(pending.projection.validator.status, "pass");
  assert.equal(factory.prompts.length, 0);

  assert.equal(await factory.terminate(survivor.identity), true);
  const recovered = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId, runsRoot, processInspector: factory,
    ownerPid: 86_053, ownerProcessStartedAt: ownerStart(86_053),
  });
  assert.equal(recovered.status, "pass");
  assert.equal(recovered.projection.state, "SUCCEEDED");
  assert.equal(factory.prompts.length, 0, "durable validator PASS must publish without replacement work");
  assert.equal(factory.sessions.length, 1);
  assert.equal(events(runsRoot, runId).at(-1).type, "mission.succeeded");
}

async function testDeadOwnerWithoutFencedWorkerIsOutcomeUnknown(root) {
  const workspace = path.join(root, "unfenced-worker-workspace");
  const runsRoot = path.join(root, "unfenced-worker-runtime");
  fs.mkdirSync(workspace);
  createValidator(workspace);
  const compiled = contract(workspace);
  const factory = new mission.ScriptedMissionWorkerFactory({ sessionRoot: path.join(root, "unfenced-worker-sessions"), turns: [] });
  const runId = "unfenced-worker";
  const store = mission.FileMissionJournal.create(runsRoot, runId);
  store.append({ runId, type: "mission.created", generation: 1, data: {
    missionHash: compiled.missionHash, canonicalJson: compiled.canonicalJson, cwd: compiled.contract.cwd, workerAdapter: factory.adapterName,
  } });
  store.append({ runId, type: "mission.started", generation: 1, data: { missionHash: compiled.missionHash } });
  store.close();
  const starts = new Map([
    [86_071, { pid: 86_071, alive: true, startedAt: ownerStart(86_071) }],
    [86_072, { pid: 86_072, alive: true, startedAt: ownerStart(86_072) }],
  ]);
  const inspector = { inspect(pid) { return starts.get(pid) ?? { pid, alive: false }; } };
  mission.FileWorkspaceLease.acquire({
    leaseRoot: path.join(runsRoot, "workspace-leases"), workspacePath: workspace,
    workspaceFingerprint: compiled.contract.workspaceFingerprint, runId, missionHash: compiled.missionHash,
    processInspector: inspector, ownerPid: 86_071, ownerProcessStartedAt: ownerStart(86_071),
  });
  starts.set(86_071, { pid: 86_071, alive: false });
  const result = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId, runsRoot, processInspector: inspector,
    ownerPid: 86_072, ownerProcessStartedAt: ownerStart(86_072),
  });
  assert.equal(result.status, "outcome-unknown");
  assert.equal(result.projection.state, "OUTCOME_UNKNOWN");
  assert.match(result.projection.reason, /before a worker identity was fenced/);
  assert.equal(factory.sessions.length, 0, "unclassified spawn window must never create a replacement worker");
}

async function testExhaustedRepairDoesNotOpenWorker(root) {
  const workspace = path.join(root, "exhausted-repair-workspace");
  const runsRoot = path.join(root, "exhausted-repair-runtime");
  const sessions = path.join(root, "exhausted-repair-sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(workspace, "product.txt"), "bad\n");
  createValidator(workspace);
  const compiled = contract(workspace, {
    budgets: { wallClockMs: 120_000, maxTurns: 1, maxRestarts: 2, maxSpecialists: 0, maxTokens: 100_000 },
  });
  const factory = new mission.ScriptedMissionWorkerFactory({ sessionRoot: sessions, turns: [] });
  const runId = "exhausted-repair";
  const store = mission.FileMissionJournal.create(runsRoot, runId);
  const add = (type, data = {}) => store.append({ runId, type, generation: 1, data });
  add("mission.created", {
    missionHash: compiled.missionHash, canonicalJson: compiled.canonicalJson, cwd: compiled.contract.cwd, workerAdapter: factory.adapterName,
  });
  add("mission.started", { missionHash: compiled.missionHash });
  const baseline = mission.captureWorkspaceSnapshot(workspace);
  const baselineFile = mission.writeWorkspaceSnapshot(store.runDirectory, "baseline", baseline);
  add("workspace.snapshot", { role: "baseline", digest: baseline.digest, file: baselineFile });
  const pinned = mission.pinNodeWorkspaceValidator(workspace, store.runDirectory, compiled.contract.validator);
  add("validator.pinned", { sha256: pinned.sha256, file: pinned.pinnedFile });
  const sessionFile = path.join(sessions, "exhausted.jsonl");
  fs.writeFileSync(sessionFile, "");
  add("worker.started", { identity: {
    adapter: factory.adapterName, workerId: `${runId}:primary:1`, pid: 96_101,
    processStartedAt: "2026-09-02T03:10:00.000Z", sessionId: "exhausted-session", sessionFile,
    cursor: "exhausted-cursor", generation: 1, route: compiled.contract.route,
  } });
  add("worker.settled", { turn: 1, cursor: "exhausted-cursor", tokens: 10 });
  add("validator.started", { turn: 1, sha256: pinned.sha256 });
  const failed = await mission.runPinnedNodeValidator(pinned, workspace);
  assert.equal(failed.status, "fail");
  add("validator.completed", { turn: 1, result: failed });
  add("repair.requested", { turn: 1, feedback: "repair required", validator: failed });
  store.close();

  const result = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId, runsRoot, processInspector: factory,
    ownerPid: 86_101, ownerProcessStartedAt: ownerStart(86_101),
  });
  assert.equal(result.status, "fail");
  assert.equal(result.projection.reason, "turn budget exhausted");
  assert.equal(factory.sessions.length, 0, "an exhausted repair must not open a replacement worker");
  assert.equal(factory.prompts.length, 0);
  assert.equal(events(runsRoot, runId).at(-1).type, "budget.exhausted");
}

async function testWorkerIdentitySecretsAreRejectedBeforePersistence(root) {
  const workspace = path.join(root, "identity-secret-workspace");
  const runsRoot = path.join(root, "identity-secret-runtime");
  fs.mkdirSync(workspace);
  createValidator(workspace);
  const compiled = contract(workspace);

  const runCase = async (label, secret, mutateIdentity, ownerPid) => {
    const baseFactory = new mission.ScriptedMissionWorkerFactory({
      sessionRoot: path.join(root, `${label}-sessions`),
      turns: [],
    });
    const factory = {
      adapterName: baseFactory.adapterName,
      async open(request) {
        const worker = await baseFactory.open(request);
        mutateIdentity(worker.identity);
        return worker;
      },
      inspect: baseFactory.inspect.bind(baseFactory),
      terminate: baseFactory.terminate.bind(baseFactory),
    };
    const result = await mission.runDurableMission({
      contract: compiled, workerFactory: factory, runId: label, runsRoot,
      processInspector: baseFactory, ownerPid, ownerProcessStartedAt: ownerStart(ownerPid),
    });
    assert.equal(result.status, "fail");
    assert.match(result.projection.reason, /malformed|unpinned/);
    const durableText = [
      fs.readFileSync(result.eventFile, "utf8"),
      fs.readFileSync(path.join(result.runDirectory, "current.json"), "utf8"),
      fs.readFileSync(path.join(runsRoot, "workspace-leases", `${compiled.contract.workspaceFingerprint}.json`), "utf8"),
    ].join("\n");
    assert.equal(durableText.includes(secret), false, `${label} secret must not reach durable state`);
    assert.equal(events(runsRoot, label).some((event) => event.type === "worker.started"), false);
  };

  const topSecret = "TOP_LEVEL_IDENTITY_SECRET_4dff5a";
  await runCase("identity-top-secret", topSecret, (identity) => { identity.ownerToken = topSecret; }, 86_201);
  const routeSecret = "ROUTE_IDENTITY_SECRET_b71ac2";
  await runCase("identity-route-secret", routeSecret, (identity) => {
    identity.route = { ...identity.route, secret: routeSecret };
  }, 86_202);
}

async function testWorkspaceLeaseBlocksDifferentRunIds(root) {
  const workspace = path.join(root, "cross-run-lease-workspace");
  const runsRoot = path.join(root, "cross-run-lease-runtime");
  fs.mkdirSync(workspace);
  createValidator(workspace, "held\n");
  const factory = new mission.ScriptedMissionWorkerFactory({
    sessionRoot: path.join(root, "cross-run-lease-sessions"),
    firstPid: 97_000,
    turns: [
      { mutations: [{ path: "product.txt", content: "held\n" }], throwMessage: "writer remains alive", throwState: "running" },
      { events: [{ type: "settled", cursor: "second-run", tokens: 1 }] },
    ],
  });
  const compiled = contract(workspace);
  const first = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "workspace-owner-a", runsRoot,
    processInspector: factory, ownerPid: 87_001, ownerProcessStartedAt: ownerStart(87_001),
  });
  assert.equal(first.status, "pending");
  const sessionsBefore = factory.sessions.length;

  const blocked = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "workspace-owner-b", runsRoot,
    processInspector: factory, ownerPid: 87_002, ownerProcessStartedAt: ownerStart(87_002),
  });
  assert.equal(blocked.status, "pending");
  assert.equal(blocked.projection.nextAction, "wait-worker");
  assert.equal(factory.sessions.length, sessionsBefore, "a different run ID must not spawn a second workspace writer");
  assert.equal(await factory.terminate(factory.sessions[0]), true);
}

async function testResumeOpenFailureAfterEffectsIsOutcomeUnknown(root) {
  const workspace = path.join(root, "resume-open-failure-workspace");
  const runsRoot = path.join(root, "resume-open-failure-runtime");
  fs.mkdirSync(workspace);
  createValidator(workspace, "mutated\n");
  const firstFactory = new mission.ScriptedMissionWorkerFactory({
    sessionRoot: path.join(root, "resume-open-failure-sessions"),
    firstPid: 98_000,
    turns: [{ mutations: [{ path: "product.txt", content: "mutated\n" }], throwMessage: "worker exited after mutation" }],
  });
  const compiled = contract(workspace);
  const first = await mission.runDurableMission({
    contract: compiled, workerFactory: firstFactory, runId: "resume-open-failure", runsRoot,
    processInspector: firstFactory, ownerPid: 88_001, ownerProcessStartedAt: ownerStart(88_001),
  });
  assert.equal(first.status, "pending");
  assert.ok(first.projection.effects.length > 0);

  const failingFactory = {
    adapterName: firstFactory.adapterName,
    async open() { throw new Error("simulated session reopen failure"); },
    inspect: firstFactory.inspect.bind(firstFactory),
    terminate: firstFactory.terminate.bind(firstFactory),
  };
  const resumed = await mission.runDurableMission({
    contract: compiled, workerFactory: failingFactory, runId: "resume-open-failure", runsRoot,
    processInspector: firstFactory, ownerPid: 88_002, ownerProcessStartedAt: ownerStart(88_002),
  });
  assert.equal(resumed.status, "outcome-unknown");
  assert.equal(resumed.projection.state, "OUTCOME_UNKNOWN");
  assert.match(resumed.projection.reason, /observed workspace effect/);
}

async function testInvariantFailureCleansWorkerAndLease(root) {
  const workspace = path.join(root, "identity-failure-workspace");
  const runsRoot = path.join(root, "identity-failure-runtime");
  const sessionRoot = path.join(root, "identity-failure-sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionRoot);
  createValidator(workspace);
  const compiled = contract(workspace);
  let state = "idle";
  const identity = {
    adapter: "invalid-identity-worker-v1", workerId: "invalid-route", pid: 99_001,
    processStartedAt: "2026-09-02T04:00:00.000Z", sessionId: "invalid-session",
    sessionFile: path.join(sessionRoot, "invalid.jsonl"), cursor: null, generation: 1,
    route: { provider: "not-allowed", model: "not-allowed", thinkingLevel: "off" },
  };
  fs.writeFileSync(identity.sessionFile, "");
  const worker = {
    identity,
    async *prompt() {},
    async inspect() { return { state, identity }; },
    async abort() { state = "exited"; },
    async close() { state = "exited"; },
  };
  const factory = {
    adapterName: identity.adapter,
    async open() { return worker; },
    inspect(value) {
      if (typeof value === "number") return { pid: value, alive: value === identity.pid && state !== "exited", startedAt: value === identity.pid ? identity.processStartedAt : undefined };
      return Promise.resolve({ state, identity });
    },
    async terminate() { state = "exited"; return true; },
  };
  const result = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "invalid-worker-identity", runsRoot,
    processInspector: factory, ownerPid: 89_001, ownerProcessStartedAt: ownerStart(89_001),
  });
  assert.equal(result.status, "fail");
  assert.equal(state, "exited", "identity rejection must stop the spawned worker");
  const leaseFile = path.join(runsRoot, "workspace-leases", `${compiled.contract.workspaceFingerprint}.json`);
  assert.equal(JSON.parse(fs.readFileSync(leaseFile, "utf8")).status, "released");
}

async function testMissingBaselineReleasesLease(root) {
  const workspace = path.join(root, "missing-baseline-workspace");
  const runsRoot = path.join(root, "missing-baseline-runtime");
  fs.mkdirSync(workspace);
  createValidator(workspace);
  const compiled = contract(workspace);
  const factory = new mission.ScriptedMissionWorkerFactory({ sessionRoot: path.join(root, "missing-baseline-sessions"), turns: [] });
  const runId = "missing-baseline";
  const store = mission.FileMissionJournal.create(runsRoot, runId);
  store.append({ runId, type: "mission.created", generation: 1, data: {
    missionHash: compiled.missionHash, canonicalJson: compiled.canonicalJson, cwd: compiled.contract.cwd, workerAdapter: factory.adapterName,
  } });
  store.append({ runId, type: "mission.started", generation: 1, data: { missionHash: compiled.missionHash } });
  store.close();
  const result = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId, runsRoot,
    processInspector: factory, ownerPid: 89_101, ownerProcessStartedAt: ownerStart(89_101),
  });
  assert.equal(result.status, "fail");
  const leaseFile = path.join(runsRoot, "workspace-leases", `${compiled.contract.workspaceFingerprint}.json`);
  assert.equal(JSON.parse(fs.readFileSync(leaseFile, "utf8")).status, "released", "known post-acquire errors must not leak a live-owner lease");
}

async function testJournalFailureRetainsLeaseForUnconfirmedWorker(root) {
  const workspace = path.join(root, "journal-failure-workspace");
  const runsRoot = path.join(root, "journal-failure-runtime");
  const sessionRoot = path.join(root, "journal-failure-sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionRoot);
  createValidator(workspace);
  const compiled = contract(workspace);
  const runId = "journal-failure-live-worker";
  const identity = {
    adapter: "journal-failure-worker-v1", workerId: `${runId}:primary:1`, pid: 99_101,
    processStartedAt: "2026-09-02T05:00:00.000Z", sessionId: "journal-failure-session",
    sessionFile: path.join(sessionRoot, "session.jsonl"), cursor: null, generation: 1, route: compiled.contract.route,
  };
  fs.writeFileSync(identity.sessionFile, "");
  const worker = {
    identity,
    async *prompt() {
      fs.appendFileSync(path.join(runsRoot, runId, "events.jsonl"), "{torn");
      yield { type: "heartbeat" };
    },
    async inspect() { return { state: "running", identity }; },
    async abort() {},
    async close() { throw new Error("worker remains alive"); },
  };
  const factory = {
    adapterName: identity.adapter,
    async open() { return worker; },
    inspect(value) {
      if (typeof value === "number") return { pid: value, alive: value === identity.pid, startedAt: value === identity.pid ? identity.processStartedAt : undefined };
      return Promise.resolve({ state: "running", identity });
    },
    async terminate() { return false; },
  };
  await assert.rejects(() => mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId, runsRoot,
    processInspector: factory, ownerPid: 89_201, ownerProcessStartedAt: ownerStart(89_201),
  }), (error) => error.code === "MISSION_LOG_TORN" || error.code === "MISSION_EVENT_MALFORMED");
  const leaseFile = path.join(runsRoot, "workspace-leases", `${compiled.contract.workspaceFingerprint}.json`);
  assert.equal(JSON.parse(fs.readFileSync(leaseFile, "utf8")).status, "active", "journal failure must retain fencing when worker cleanup is unconfirmed");
}

async function testUnknownWorkerAfterEffectsRetainsLease(root) {
  const workspace = path.join(root, "unknown-worker-effects-workspace");
  const runsRoot = path.join(root, "unknown-worker-effects-runtime");
  const sessionRoot = path.join(root, "unknown-worker-effects-sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionRoot);
  createValidator(workspace);
  const compiled = contract(workspace);
  const identity = {
    adapter: "unknown-worker-v1", workerId: "unknown-primary", pid: 99_201,
    processStartedAt: "2026-09-02T05:01:00.000Z", sessionId: "unknown-session",
    sessionFile: path.join(sessionRoot, "unknown.jsonl"), cursor: null, generation: 1, route: compiled.contract.route,
  };
  fs.writeFileSync(identity.sessionFile, "");
  const worker = {
    identity,
    async *prompt() {
      fs.writeFileSync(path.join(workspace, "product.txt"), "possible-effect\n");
      yield { type: "failed", message: "transport failed", retryable: false };
    },
    async inspect() { throw new Error("inspection unavailable"); },
    async abort() {},
    async close() { throw new Error("close unavailable"); },
  };
  const factory = {
    adapterName: identity.adapter,
    async open() { return worker; },
    inspect(value) {
      if (typeof value === "number") return { pid: value, alive: value === identity.pid, startedAt: value === identity.pid ? identity.processStartedAt : undefined };
      return Promise.reject(new Error("factory inspection unavailable"));
    },
    async terminate() { return false; },
  };
  const result = await mission.runDurableMission({
    contract: compiled, workerFactory: factory, runId: "unknown-worker-effects", runsRoot,
    processInspector: factory, ownerPid: 89_202, ownerProcessStartedAt: ownerStart(89_202),
  });
  assert.equal(result.status, "pending");
  assert.equal(result.projection.nextAction, "wait-worker");
  assert.ok(result.projection.effects.length > 0);
  const leaseFile = path.join(runsRoot, "workspace-leases", `${compiled.contract.workspaceFingerprint}.json`);
  assert.equal(JSON.parse(fs.readFileSync(leaseFile, "utf8")).status, "active", "unclassified live worker must retain writer fencing");
}

async function testUnconfirmedCancellationKeepsMissionNonTerminal(root) {
  const workspace = path.join(root, "cancel-unconfirmed-workspace");
  const runsRoot = path.join(root, "cancel-unconfirmed-runtime");
  const sessionRoot = path.join(root, "cancel-unconfirmed-sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionRoot);
  createValidator(workspace);
  const identity = {
    adapter: "stubborn-worker-v1",
    workerId: "stubborn-primary",
    pid: 95_001,
    processStartedAt: "2026-09-02T01:00:00.000Z",
    sessionId: "stubborn-session",
    sessionFile: path.join(sessionRoot, "stubborn.jsonl"),
    cursor: null,
    generation: 1,
    route: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
  };
  fs.writeFileSync(identity.sessionFile, "");
  const worker = {
    identity,
    async *prompt(_message, signal) {
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      yield { type: "failed", message: "caller abort observed", retryable: false };
    },
    async inspect() { return { state: "running", identity }; },
    async abort() {},
    async close() { throw new Error("stubborn worker did not close"); },
  };
  const factory = {
    adapterName: "stubborn-worker-v1",
    async open() { return worker; },
    inspect(value) {
      if (typeof value === "number") return { pid: value, alive: true, startedAt: value === identity.pid ? identity.processStartedAt : undefined };
      return Promise.resolve({ state: "running", identity });
    },
    async terminate() { return false; },
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const result = await mission.runDurableMission({
    contract: contract(workspace), workerFactory: factory, runId: "cancel-unconfirmed", runsRoot,
    processInspector: factory, ownerPid: 85_001, ownerProcessStartedAt: ownerStart(85_001), signal: controller.signal,
  });
  assert.equal(result.status, "pending");
  assert.equal(result.projection.state, "PAUSED");
  assert.equal(result.projection.nextAction, "wait-worker");
  const runEvents = events(runsRoot, "cancel-unconfirmed");
  assert.equal(runEvents.some((event) => event.type === "mission.cancelled"), false);
  assert.equal(runEvents.some((event) => event.type === "lease.released"), false, "unconfirmed cleanup must not release writer authority");
}

async function testCancellationAndReadOnly(root) {
  const cancelWorkspace = path.join(root, "cancel-workspace");
  const cancelRuns = path.join(root, "cancel-runtime");
  fs.mkdirSync(cancelWorkspace);
  createValidator(cancelWorkspace);
  const cancelFactory = new mission.ScriptedMissionWorkerFactory({
    sessionRoot: path.join(root, "cancel-sessions"),
    turns: [{ events: [{ type: "settled", cursor: "too-late", tokens: 1 }] }],
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await mission.runDurableMission({
    contract: contract(cancelWorkspace), workerFactory: cancelFactory, runId: "cancelled", runsRoot: cancelRuns,
    processInspector: cancelFactory, ownerPid: 84_001, ownerProcessStartedAt: ownerStart(84_001), signal: controller.signal,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.projection.state, "CANCELLED");
  assert.equal(cancelFactory.prompts.length, 0);

  const readOnlyWorkspace = path.join(root, "readonly-workspace");
  const readOnlyRuns = path.join(root, "readonly-runtime");
  fs.mkdirSync(readOnlyWorkspace);
  fs.writeFileSync(path.join(readOnlyWorkspace, "truth.txt"), "original\n");
  const readOnlyFactory = new mission.ScriptedMissionWorkerFactory({
    sessionRoot: path.join(root, "readonly-sessions"),
    turns: [{ mutations: [{ path: "truth.txt", content: "mutated\n" }], events: [{ type: "settled", cursor: "read", tokens: 1 }] }],
  });
  const readOnlyContract = contract(readOnlyWorkspace, {
    objective: "Inspect the fixture without changing it.",
    validator: { kind: "none", readOnly: true },
  });
  const refused = await mission.runDurableMission({
    contract: readOnlyContract, workerFactory: readOnlyFactory, runId: "readonly-refusal", runsRoot: readOnlyRuns,
    processInspector: readOnlyFactory, ownerPid: 84_002, ownerProcessStartedAt: ownerStart(84_002),
  });
  assert.equal(refused.status, "fail");
  assert.match(refused.projection.reason, /read-only mission observed/);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-runner-"));
  const started = performance.now();
  try {
    await testRepairSamePrimary(root);
    await testCrashResumeWithoutDuplicateMutation(root);
    await testLiveSurvivorBlocksDuplicate(root);
    await testResumeHonorsDurableValidationState(root);
    await testValidatorPassSurvivesWaitWorkerPause(root);
    await testDeadOwnerWithoutFencedWorkerIsOutcomeUnknown(root);
    await testExhaustedRepairDoesNotOpenWorker(root);
    await testWorkerIdentitySecretsAreRejectedBeforePersistence(root);
    await testWorkspaceLeaseBlocksDifferentRunIds(root);
    await testResumeOpenFailureAfterEffectsIsOutcomeUnknown(root);
    await testInvariantFailureCleansWorkerAndLease(root);
    await testMissingBaselineReleasesLease(root);
    await testJournalFailureRetainsLeaseForUnconfirmedWorker(root);
    await testUnknownWorkerAfterEffectsRetainsLease(root);
    await testUnconfirmedCancellationKeepsMissionNonTerminal(root);
    await testCancellationAndReadOnly(root);
    console.log(`PASS durable-mission runner: same-agent repair, crash/resume, workspace-global fencing, invariant cleanup, cancellation/read-only (${(performance.now() - started).toFixed(1)}ms)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
