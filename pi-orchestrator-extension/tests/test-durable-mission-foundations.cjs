#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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

function baseContract(cwd) {
  return {
    schemaVersion: 1,
    objective: "Repair the fixture until its machine validator passes.",
    cwd,
    route: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
    fallbacks: [{ provider: "zai", model: "glm-5.2", thinkingLevel: "high" }],
    budgets: { wallClockMs: 60_000, maxTurns: 4, maxRestarts: 2, maxSpecialists: 0, maxTokens: 50_000 },
    validator: { kind: "node-workspace-validator", script: "validate.cjs", timeoutMs: 5_000, maxOutputBytes: 8_192 },
    constraints: ["Do not modify files outside the fixture."],
  };
}

function workerIdentity(generation = 1) {
  return {
    adapter: "fake-mission-worker-v1",
    workerId: `worker-${generation}`,
    pid: 2222 + generation,
    processStartedAt: `2026-09-02T00:00:0${generation}.000Z`,
    sessionId: `session-${generation}`,
    sessionFile: `C:/runtime/session-${generation}.jsonl`,
    cursor: null,
    generation,
  };
}

function validatorResult(status, exitCode) {
  return {
    status,
    exitCode,
    timedOut: false,
    durationMs: 12.5,
    stdout: status === "pass" ? "PASS\n" : "",
    stderr: status === "pass" ? "" : "fixture failed\n",
    outputTruncated: false,
    validatorSha256: "a".repeat(64),
  };
}

function fakeInspector(initial = {}) {
  const observations = new Map(Object.entries(initial).map(([pid, value]) => [Number(pid), { pid: Number(pid), ...value }]));
  return {
    observations,
    inspect(pid) {
      return observations.get(pid) ?? { pid, alive: false };
    },
  };
}

function append(store, type, data = {}, generation = 1) {
  return store.append({ runId: store.runId, type, generation, data });
}

async function testContract(root) {
  const workspace = path.join(root, "contract-workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "validate.cjs"), "process.exit(0);\n");
  const first = mission.compileMissionContract(baseContract(workspace));
  const second = mission.compileMissionContract({ ...baseContract(workspace), cwd: path.join(workspace, ".") });
  assert.equal(first.missionHash, second.missionHash);
  assert.equal(first.contract.cwd, fs.realpathSync(workspace));
  assert.equal(first.contract.budgets.maxTokens, 50_000);
  assert.equal(first.contract.route.thinkingLevel, "high");

  const unknown = { ...baseContract(workspace), microPhases: true };
  assert.throws(() => mission.compileMissionContract(unknown), (error) => error.code === "MISSION_UNKNOWN_FIELD");
  const duplicate = baseContract(workspace);
  duplicate.fallbacks = [{ ...duplicate.route }];
  assert.throws(() => mission.compileMissionContract(duplicate), (error) => error.code === "MISSION_ROUTE_DUPLICATE");
  const unsafeValidator = baseContract(workspace);
  unsafeValidator.validator.script = "other.cjs";
  assert.throws(() => mission.compileMissionContract(unsafeValidator), (error) => error.code === "MISSION_VALIDATOR_INVALID");
  const readOnly = baseContract(workspace);
  readOnly.validator = { kind: "none", readOnly: true };
  assert.equal(mission.compileMissionContract(readOnly).contract.validator.kind, "none");
}

async function testJournal(root) {
  const eventRoot = path.join(root, "journal-root");
  const clockTimes = [
    "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:01.000Z", "2026-09-02T00:00:02.000Z",
    "2026-09-02T00:00:03.000Z", "2026-09-02T00:00:04.000Z", "2026-09-02T00:00:05.000Z",
    "2026-09-02T00:00:06.000Z", "2026-09-02T00:00:07.000Z", "2026-09-02T00:00:08.000Z",
    "2026-09-02T00:00:09.000Z", "2026-09-02T00:00:10.000Z", "2026-09-02T00:00:11.000Z",
  ];
  let clockIndex = 0;
  const clock = () => new Date(clockTimes[Math.min(clockIndex++, clockTimes.length - 1)]);
  const store = mission.FileMissionJournal.create(eventRoot, "mission-journal", clock);
  append(store, "mission.created", { missionHash: "b".repeat(64) });
  append(store, "mission.started");
  append(store, "workspace.snapshot", { role: "baseline", digest: "c".repeat(64) });
  append(store, "worker.started", { identity: workerIdentity() });
  append(store, "worker.cursor", { cursor: "entry-1" });
  append(store, "effects.observed", { effects: [{ path: "src/a.ts", kind: "modified" }] });
  append(store, "worker.settled", { tokens: 100, cursor: "entry-1" });
  append(store, "validator.completed", { result: validatorResult("fail", 1) });
  append(store, "repair.requested", { feedback: "fixture failed" });
  append(store, "worker.settled", { tokens: 50, cursor: "entry-2" });
  append(store, "validator.completed", { result: validatorResult("pass", 0) });
  append(store, "mission.succeeded", { reason: "validator passed" });

  const projected = store.projection();
  assert.equal(projected.state, "SUCCEEDED");
  assert.equal(projected.nextAction, "none");
  assert.equal(projected.cursor, "entry-2");
  assert.equal(projected.usage.turns, 2);
  assert.equal(projected.usage.tokens, 150);
  assert.equal(projected.usage.elapsedMs, 11_000);
  assert.deepEqual(projected.effects, [{ path: "src/a.ts", kind: "modified" }]);
  assert.equal(projected.validator.status, "pass");
  assert.deepEqual(JSON.parse(fs.readFileSync(store.projectionFile, "utf8")), projected);
  assert.throws(() => mission.FileMissionJournal.open(eventRoot, "mission-journal"), (error) => error.code === "MISSION_ALREADY_OPEN");
  assert.throws(() => append(store, "mission.started"), (error) => error.code === "MISSION_EVENT_AFTER_TERMINAL");
  assert.equal(store.readAll().length, 12, "invalid transition must not be appended");
  store.close();

  fs.writeFileSync(path.join(eventRoot, "mission-journal", "current.json"), "{stale", "utf8");
  const reopened = mission.FileMissionJournal.open(eventRoot, "mission-journal", clock);
  assert.equal(reopened.projection().state, "SUCCEEDED");
  assert.equal(JSON.parse(fs.readFileSync(reopened.projectionFile, "utf8")).lastSeq, 12, "projection cache must rebuild from log");
  reopened.close();

  const staleLockFile = path.join(eventRoot, "mission-journal", "supervisor-lock-claims", "supervisor-0000000000000002.json");
  fs.writeFileSync(staleLockFile, `${JSON.stringify({
    version: 2, generation: 2, pid: process.pid, processStartedAt: "2000-01-01T00:00:00.000Z", token: "a".repeat(48), acquiredAt: "2000-01-01T00:00:00.000Z",
  })}\n`);
  const pidReuseRecovered = mission.FileMissionJournal.open(eventRoot, "mission-journal", clock);
  assert.equal(pidReuseRecovered.projection().state, "SUCCEEDED", "PID reuse with a different start identity must not retain the supervisor lock");
  pidReuseRecovered.close();

  const torn = mission.FileMissionJournal.create(eventRoot, "mission-torn", clock);
  append(torn, "mission.created", { missionHash: "d".repeat(64) });
  torn.close();
  fs.appendFileSync(path.join(eventRoot, "mission-torn", "events.jsonl"), "{torn", "utf8");
  assert.throws(() => mission.FileMissionJournal.open(eventRoot, "mission-torn"), (error) => error.code === "MISSION_LOG_TORN");

  const unknown = mission.FileMissionJournal.create(eventRoot, "mission-unknown", clock);
  append(unknown, "mission.created", { missionHash: "e".repeat(64) });
  append(unknown, "mission.started");
  append(unknown, "mission.outcome-unknown", { reason: "effects observed after lost acknowledgement" });
  assert.equal(unknown.projection().state, "OUTCOME_UNKNOWN");
  assert.equal(unknown.projection().nextAction, "inspect-outcome");
  unknown.close();
}

async function testLease(root) {
  const leaseRoot = path.join(root, "workspace-leases");
  const workspace = path.join(root, "lease-workspace");
  fs.mkdirSync(leaseRoot);
  fs.mkdirSync(workspace);
  const workspaceFingerprint = mission.computeWorkspaceFingerprint(fs.realpathSync(workspace));
  const inspector = fakeInspector({ 1111: { alive: true, startedAt: "2026-09-02T00:00:00.000Z" }, 2222: { alive: true, startedAt: "2026-09-02T00:00:01.000Z" } });
  const clock = () => new Date("2026-09-02T00:00:10.000Z");
  const base = { leaseRoot, workspacePath: workspace, workspaceFingerprint, processInspector: inspector, clock };
  const first = mission.FileWorkspaceLease.acquire({
    ...base, runId: "lease-run", missionHash: "f".repeat(64),
    ownerPid: 1111, ownerProcessStartedAt: "2026-09-02T00:00:00.000Z",
  });
  const bound = first.bindWorker(2222, "2026-09-02T00:00:01.000Z");
  assert.equal(bound.generation, 1);
  first.assertPublisher(bound.generation, bound.ownerToken);
  assert.throws(
    () => mission.FileWorkspaceLease.acquire({
      ...base, runId: "different-run", missionHash: "0".repeat(64),
      ownerPid: 3333, ownerProcessStartedAt: "2026-09-02T00:00:02.000Z",
    }),
    (error) => error.code === "WORKSPACE_WRITER_ACTIVE",
    "different run IDs must contend on one workspace-global lease",
  );

  inspector.observations.set(1111, { pid: 1111, alive: false });
  inspector.observations.set(2222, { pid: 2222, alive: false });
  inspector.observations.set(3333, { pid: 3333, alive: true, startedAt: "2026-09-02T00:00:02.000Z" });
  const second = mission.FileWorkspaceLease.acquire({
    ...base, runId: "different-run", missionHash: "0".repeat(64),
    ownerPid: 3333, ownerProcessStartedAt: "2026-09-02T00:00:02.000Z",
  });
  assert.equal(second.record.generation, 2);
  assert.equal(second.record.runId, "different-run");
  assert.throws(() => first.assertPublisher(bound.generation, bound.ownerToken), (error) => error.code === "WORKSPACE_LEASE_STALE_PUBLISHER");
  assert.throws(() => first.renew(), (error) => error.code === "WORKSPACE_LEASE_STALE_PUBLISHER");
  second.release();

  const third = mission.FileWorkspaceLease.acquire({
    ...base, runId: "lease-run", missionHash: "f".repeat(64),
    ownerPid: 3333, ownerProcessStartedAt: "2026-09-02T00:00:02.000Z",
  });
  assert.equal(third.record.generation, 3, "released lease may be reacquired even while old owner process lives");
  third.release();

  const unfencedRoot = path.join(root, "unfenced-lease-root");
  const unfencedWorkspace = path.join(root, "unfenced-lease-workspace");
  fs.mkdirSync(unfencedRoot);
  fs.mkdirSync(unfencedWorkspace);
  const unfencedFingerprint = mission.computeWorkspaceFingerprint(fs.realpathSync(unfencedWorkspace));
  const unfencedInspector = fakeInspector({
    3401: { alive: true, startedAt: "2026-09-02T03:40:01.000Z" },
    3402: { alive: true, startedAt: "2026-09-02T03:40:02.000Z" },
  });
  mission.FileWorkspaceLease.acquire({
    leaseRoot: unfencedRoot, workspacePath: unfencedWorkspace, workspaceFingerprint: unfencedFingerprint,
    runId: "unfenced-owner", missionHash: "4".repeat(64), processInspector: unfencedInspector,
    ownerPid: 3401, ownerProcessStartedAt: "2026-09-02T03:40:01.000Z",
  });
  unfencedInspector.observations.set(3401, { pid: 3401, alive: false });
  assert.throws(() => mission.FileWorkspaceLease.acquire({
    leaseRoot: unfencedRoot, workspacePath: unfencedWorkspace, workspaceFingerprint: unfencedFingerprint,
    runId: "unfenced-recovery", missionHash: "5".repeat(64), processInspector: unfencedInspector,
    ownerPid: 3402, ownerProcessStartedAt: "2026-09-02T03:40:02.000Z",
  }), (error) => error.code === "WORKSPACE_WRITER_UNCLASSIFIED", "dead owner with no fenced worker must never permit a blind replacement writer");

  const reuseDirectory = path.join(root, "lease-pid-reuse");
  const reuseWorkspace = path.join(root, "lease-pid-reuse-workspace");
  fs.mkdirSync(reuseDirectory);
  fs.mkdirSync(reuseWorkspace);
  const reuseFingerprint = mission.computeWorkspaceFingerprint(fs.realpathSync(reuseWorkspace));
  const staleMutexDirectory = path.join(reuseDirectory, `${reuseFingerprint}.mutex-claims`);
  fs.mkdirSync(staleMutexDirectory);
  fs.writeFileSync(path.join(staleMutexDirectory, "lease-mutex-0000000000000001.json"), `${JSON.stringify({
    version: 2, generation: 1, pid: process.pid, processStartedAt: "2000-01-01T00:00:00.000Z", token: "b".repeat(48), acquiredAt: "2000-01-01T00:00:00.000Z",
  })}\n`);
  const reusedInspector = fakeInspector({
    4444: { alive: true, startedAt: "2026-09-02T00:00:00.000Z" },
    4445: { alive: true, startedAt: "2026-09-02T00:00:01.000Z" },
  });
  const reuseBase = {
    leaseRoot: reuseDirectory, workspacePath: reuseWorkspace, workspaceFingerprint: reuseFingerprint,
    runId: "lease-pid-reuse", missionHash: "1".repeat(64), processInspector: reusedInspector, clock,
  };
  const original = mission.FileWorkspaceLease.acquire({
    ...reuseBase, ownerPid: 4444, ownerProcessStartedAt: "2026-09-02T00:00:00.000Z",
  });
  original.bindWorker(4445, "2026-09-02T00:00:01.000Z");
  reusedInspector.observations.set(4444, { pid: 4444, alive: true, startedAt: "2026-09-02T01:00:00.000Z" });
  reusedInspector.observations.set(4445, { pid: 4445, alive: false });
  const recovered = mission.FileWorkspaceLease.acquire({
    ...reuseBase, ownerPid: 5555, ownerProcessStartedAt: "2026-09-02T02:00:00.000Z",
  });
  assert.equal(recovered.record.generation, 2, "PID reuse with a different process start identity must not retain authority");
  assert.throws(() => original.release(), (error) => error.code === "WORKSPACE_LEASE_STALE_PUBLISHER");
  recovered.release();

  const expiryLeaseRoot = path.join(root, "expiry-lease-root");
  const expiryWorkspace = path.join(root, "expiry-lease-workspace");
  fs.mkdirSync(expiryLeaseRoot);
  fs.mkdirSync(expiryWorkspace);
  const expiryFingerprint = mission.computeWorkspaceFingerprint(fs.realpathSync(expiryWorkspace));
  const expiryInspector = fakeInspector({
    6001: { alive: true, startedAt: "2026-09-02T06:00:00.000Z" },
    6002: { alive: true, startedAt: "2026-09-02T06:00:01.000Z" },
    6003: { alive: true, startedAt: "2026-09-02T06:00:02.000Z" },
  });
  let expiryNow = new Date("2026-09-02T06:00:10.000Z");
  const expiring = mission.FileWorkspaceLease.acquire({
    leaseRoot: expiryLeaseRoot, workspacePath: expiryWorkspace, workspaceFingerprint: expiryFingerprint,
    runId: "expiring-run", missionHash: "2".repeat(64), processInspector: expiryInspector,
    ownerPid: 6001, ownerProcessStartedAt: "2026-09-02T06:00:00.000Z", clock: () => expiryNow, ttlMs: 1_000,
  });
  expiring.bindWorker(6002, "2026-09-02T06:00:01.000Z");
  expiryInspector.observations.set(6002, { pid: 6002, alive: false });
  expiryNow = new Date("2026-09-02T06:00:12.000Z");
  const afterExpiredDeadWorker = mission.FileWorkspaceLease.acquire({
    leaseRoot: expiryLeaseRoot, workspacePath: expiryWorkspace, workspaceFingerprint: expiryFingerprint,
    runId: "recovery-run", missionHash: "3".repeat(64), processInspector: expiryInspector,
    ownerPid: 6003, ownerProcessStartedAt: "2026-09-02T06:00:02.000Z", clock: () => expiryNow, ttlMs: 1_000,
  });
  assert.equal(afterExpiredDeadWorker.record.generation, 2, "expired lease with a confirmed-dead worker must be recoverable while the old Pi host PID remains alive");
  afterExpiredDeadWorker.release();
}

async function testProcessInspectionFailsClosed() {
  if (process.platform !== "win32") return;
  const inspector = new mission.SystemProcessInspector({
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: "",
    Path: "",
  });
  const uncertain = inspector.inspect(process.pid);
  assert.equal(uncertain.alive, true, "PowerShell/CIM launch failure must not be reported as confirmed process death");
  assert.equal(uncertain.startedAt, undefined);
}

async function testConcurrentStaleClaimRecovery(root) {
  const contender = path.join(__dirname, "fixtures", "durable-mission-lock-contender.cjs");

  const runPair = async (mode, targetRoot, workspace, runId, label) => {
    const barrier = path.join(root, `${label}.go`);
    const resultFiles = [path.join(root, `${label}-a.json`), path.join(root, `${label}-b.json`)];
    const children = resultFiles.map((resultFile) => spawn(process.execPath, [contender, mode, targetRoot, workspace, runId, barrier, resultFile], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }));
    const deadline = Date.now() + 15_000;
    while (!resultFiles.every((file) => fs.existsSync(`${file}.ready`)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(resultFiles.every((file) => fs.existsSync(`${file}.ready`)), true, `${label} contenders must become ready`);
    fs.writeFileSync(barrier, "go\n");
    await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${label} contender exited ${code}: ${stderr}`)));
    })));
    const results = resultFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(results.filter((item) => item.result === "acquired").length, 1, `${label} must grant exactly one live claim`);
    assert.equal(results.filter((item) => item.result === "blocked").length, 1, `${label} must block the competing claimant`);
  };

  const workspace = path.join(root, "concurrent-lease-workspace");
  const leaseRoot = path.join(root, "concurrent-lease-root");
  fs.mkdirSync(workspace);
  fs.mkdirSync(leaseRoot);
  const fingerprint = mission.computeWorkspaceFingerprint(fs.realpathSync(workspace));
  const mutexClaims = path.join(leaseRoot, `${fingerprint}.mutex-claims`);
  fs.mkdirSync(mutexClaims);
  fs.writeFileSync(path.join(mutexClaims, "lease-mutex-0000000000000001.json"), `${JSON.stringify({
    version: 2, generation: 1, pid: 777777, processStartedAt: "2000-01-01T00:00:00.000Z", token: "d".repeat(48), acquiredAt: "2000-01-01T00:00:00.000Z",
  })}\n`);
  await runPair("lease", leaseRoot, workspace, "concurrent-lease", "concurrent-lease");

  const journalRoot = path.join(root, "concurrent-journal-root");
  const journalRun = "concurrent-journal";
  const store = mission.FileMissionJournal.create(journalRoot, journalRun);
  append(store, "mission.created", { missionHash: "e".repeat(64) });
  store.close();
  const journalClaims = path.join(journalRoot, journalRun, "supervisor-lock-claims");
  fs.writeFileSync(path.join(journalClaims, "supervisor-0000000000000002.json"), `${JSON.stringify({
    version: 2, generation: 2, pid: 777778, processStartedAt: "2000-01-01T00:00:00.000Z", token: "e".repeat(48), acquiredAt: "2000-01-01T00:00:00.000Z",
  })}\n`);
  await runPair("journal", journalRoot, workspace, journalRun, "concurrent-journal");
}

async function testWorkspace(root) {
  const workspace = path.join(root, "workspace-snapshot");
  const runtime = path.join(root, "workspace-runtime");
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "node_modules", "ignored"), { recursive: true });
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(workspace, ".git", "config"), "ignored\n");
  fs.writeFileSync(path.join(workspace, "node_modules", "ignored", "x"), "ignored\n");
  fs.writeFileSync(path.join(workspace, "a.txt"), "one\n");
  const first = mission.captureWorkspaceSnapshot(workspace);
  assert.deepEqual(Object.keys(first.entries), [
    ".git/", ".git/config", "a.txt", "node_modules/", "node_modules/ignored/", "node_modules/ignored/x",
  ], "safety snapshots must observe SCM metadata, dependencies, and generated directories by default");
  const explicitlyIgnored = mission.captureWorkspaceSnapshot(workspace, { ignoredDirectories: [".git", "node_modules"] });
  assert.deepEqual(Object.keys(explicitlyIgnored.entries), ["a.txt"], "directory exclusions remain explicit opt-in behavior");
  const file = mission.writeWorkspaceSnapshot(runtime, "baseline", first);
  assert.equal(mission.readWorkspaceSnapshot(file).digest, first.digest);
  fs.writeFileSync(path.join(workspace, "a.txt"), "two\n");
  fs.writeFileSync(path.join(workspace, "b.txt"), "new\n");
  const second = mission.captureWorkspaceSnapshot(workspace);
  assert.deepEqual(mission.diffWorkspaceSnapshots(first, second), [
    { path: "a.txt", kind: "modified" },
    { path: "b.txt", kind: "created" },
  ]);
  const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
  tampered.entries["a.txt"] = "F:0:bad";
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => mission.readWorkspaceSnapshot(file), (error) => error.code === "MISSION_SNAPSHOT_DIGEST_MISMATCH");
}

async function testValidator(root) {
  const workspace = path.join(root, "validator-workspace");
  const runtime = path.join(root, "validator-runtime");
  fs.mkdirSync(workspace);
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(workspace, "product.txt"), "ok\n");
  fs.writeFileSync(path.join(workspace, "validate.cjs"), [
    "const fs = require('node:fs');",
    "if (fs.readFileSync('product.txt', 'utf8') !== 'ok\\n') { console.error('bad product'); process.exit(2); }",
    "console.log('VALID');",
  ].join("\n"));
  const spec = { kind: "node-workspace-validator", script: "validate.cjs", timeoutMs: 2_000, maxOutputBytes: 4_096 };
  const pinned = mission.pinNodeWorkspaceValidator(workspace, runtime, spec);
  fs.writeFileSync(path.join(workspace, "validate.cjs"), "process.exit(9);\n", "utf8");
  const passed = await mission.runPinnedNodeValidator(pinned, workspace);
  assert.equal(passed.status, "pass", "runtime must execute pinned validator bytes rather than drifted workspace source");
  assert.match(passed.stdout, /VALID/);
  fs.writeFileSync(path.join(workspace, "product.txt"), "bad\n");
  const failed = await mission.runPinnedNodeValidator(pinned, workspace);
  assert.equal(failed.status, "fail");
  assert.equal(failed.exitCode, 2);
  assert.match(failed.stderr, /bad product/);
  const reopened = mission.pinNodeWorkspaceValidator(workspace, runtime, spec, true);
  assert.equal(reopened.sha256, pinned.sha256);

  const timeoutWorkspace = path.join(root, "validator-timeout-workspace");
  const timeoutRuntime = path.join(root, "validator-timeout-runtime");
  fs.mkdirSync(timeoutWorkspace);
  fs.mkdirSync(timeoutRuntime);
  fs.writeFileSync(path.join(timeoutWorkspace, "validate.cjs"), "setInterval(() => {}, 1000);\n");
  const timeoutPinned = mission.pinNodeWorkspaceValidator(timeoutWorkspace, timeoutRuntime, { ...spec, timeoutMs: 100 });
  const timed = await mission.runPinnedNodeValidator(timeoutPinned, timeoutWorkspace);
  assert.equal(timed.status, "error");
  assert.equal(timed.timedOut, true);
  assert.ok(timed.durationMs < 5_000);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-foundations-"));
  const started = performance.now();
  try {
    await testContract(root);
    await testJournal(root);
    await testLease(root);
    await testProcessInspectionFailsClosed();
    await testConcurrentStaleClaimRecovery(root);
    await testWorkspace(root);
    await testValidator(root);
    console.log(`PASS durable-mission foundations: contract, journal/projection, race-safe lease fencing, snapshots, pinned validator (${(performance.now() - started).toFixed(1)}ms)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
