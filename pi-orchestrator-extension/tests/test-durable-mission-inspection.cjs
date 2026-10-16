#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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

function compile(cwd) {
  return mission.compileMissionContract({
    schemaVersion: 1,
    objective: "Repair the disposable fixture and leave validate.cjs passing.",
    cwd,
    route: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
    fallbacks: [],
    budgets: { wallClockMs: 120_000, maxTurns: 4, maxRestarts: 2, maxSpecialists: 0, maxTokens: 50_000 },
    validator: { kind: "node-workspace-validator", script: "validate.cjs", timeoutMs: 2_000, maxOutputBytes: 8_192 },
    constraints: [],
  });
}

function processInspector(initial) {
  const values = new Map(Object.entries(initial).map(([pid, value]) => [Number(pid), { pid: Number(pid), ...value }]));
  return {
    values,
    inspect(pid) { return values.get(pid) ?? { pid, alive: false }; },
  };
}

function add(store, type, data, at, generation = 1) {
  return store.append({ runId: store.runId, type, generation, data: data ?? {}, ...(at ? { at } : {}) });
}

function createRun({ runsRoot, runId, compiled, sessionFile, state = "validator-pass" }) {
  const store = mission.FileMissionJournal.create(runsRoot, runId, () => new Date("2026-09-02T00:00:00.000Z"));
  add(store, "mission.created", {
    missionHash: compiled.missionHash,
    canonicalJson: compiled.canonicalJson,
    cwd: compiled.contract.cwd,
    workerAdapter: "inspection-fixture",
  }, "2026-09-02T00:00:00.000Z");
  add(store, "mission.started", { missionHash: compiled.missionHash }, "2026-09-02T00:00:01.000Z");
  add(store, "worker.started", { identity: {
    adapter: "inspection-fixture",
    workerId: `${runId}:worker`,
    pid: 72_002,
    processStartedAt: "2026-09-02T00:00:02.000Z",
    sessionId: `${runId}:session`,
    sessionFile,
    cursor: "entry-1",
    generation: 1,
    route: compiled.contract.route,
  } }, "2026-09-02T00:00:02.000Z");
  add(store, "worker.heartbeat", { at: "2026-09-02T00:00:03.000Z" }, "2026-09-02T00:00:03.000Z");
  if (state === "validator-pass") {
    add(store, "worker.settled", { cursor: "entry-1", tokens: 125 }, "2026-09-02T00:00:04.000Z");
    add(store, "validator.completed", { result: {
      status: "pass", exitCode: 0, timedOut: false, durationMs: 8.5,
      stdout: "PASS\n", stderr: "", outputTruncated: false, validatorSha256: "a".repeat(64),
    } }, "2026-09-02T00:00:05.000Z");
  } else if (state === "resume-worker") {
    add(store, "worker.failed", { message: "transport ended", recoverable: true }, "2026-09-02T00:00:04.000Z");
  } else if (state === "outcome-unknown") {
    add(store, "mission.outcome-unknown", { reason: "effects need reconciliation" }, "2026-09-02T00:00:04.000Z");
  }
  store.close();
}

function bytes(files) {
  return new Map(files.map((file) => [file, fs.readFileSync(file)]));
}

function assertBytesEqual(before) {
  for (const [file, expected] of before) assert.deepEqual(fs.readFileSync(file), expected, `${file} changed during inspection`);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-inspection-"));
  try {
    const workspace = path.join(root, "workspace");
    const runsRoot = path.join(root, "runtime");
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(workspace);
    fs.mkdirSync(sessions);
    fs.writeFileSync(path.join(workspace, "validate.cjs"), "process.exit(0);\n");
    const compiled = compile(workspace);
    const rejectedIdentity = mission.FileMissionJournal.create(runsRoot, "inspect-rejected-identity");
    add(rejectedIdentity, "mission.created", { missionHash: compiled.missionHash, canonicalJson: compiled.canonicalJson });
    const identitySecret = "worker-identity-secret-must-not-leak";
    assert.throws(() => add(rejectedIdentity, "worker.started", { identity: {
      adapter: "inspection-fixture", workerId: "secret-worker", pid: 72_002,
      processStartedAt: "2026-09-02T00:00:02.000Z", sessionId: "secret-session",
      sessionFile: path.join(sessions, "secret.jsonl"), cursor: null, generation: 1,
      route: compiled.contract.route, ownerToken: identitySecret,
    } }), (error) => error.code === "MISSION_WORKER_INVALID");
    assert.equal(rejectedIdentity.readAll().length, 1, "invalid identity transition must not be appended");
    assert.equal(fs.readFileSync(rejectedIdentity.eventFile, "utf8").includes(identitySecret), false);
    rejectedIdentity.close();

    const sessionFile = path.join(sessions, "primary.jsonl");
    fs.writeFileSync(sessionFile, "");
    createRun({ runsRoot, runId: "inspect-live", compiled, sessionFile });

    const inspector = processInspector({
      72_001: { alive: true, startedAt: "2026-09-02T00:00:01.000Z" },
      72_002: { alive: true, startedAt: "2026-09-02T00:00:02.000Z" },
    });
    const lease = mission.FileWorkspaceLease.acquire({
      leaseRoot: path.join(runsRoot, "workspace-leases"),
      workspacePath: workspace,
      workspaceFingerprint: compiled.contract.workspaceFingerprint,
      runId: "inspect-live",
      missionHash: compiled.missionHash,
      ownerPid: 72_001,
      ownerProcessStartedAt: "2026-09-02T00:00:01.000Z",
      processInspector: inspector,
      clock: () => new Date("2026-09-02T00:00:02.000Z"),
      ttlMs: 30_000,
    });
    lease.bindWorker(72_002, "2026-09-02T00:00:02.000Z");

    const runDirectory = path.join(runsRoot, "inspect-live");
    const protectedFiles = [
      path.join(runDirectory, "events.jsonl"),
      path.join(runDirectory, "current.json"),
      lease.file,
      sessionFile,
    ];
    const before = bytes(protectedFiles);
    const report = mission.inspectDurableMission({
      runsRoot,
      runId: "inspect-live",
      processInspector: inspector,
      clock: () => new Date("2026-09-02T00:00:10.000Z"),
    });
    assert.equal(report.version, 1);
    assert.equal(report.state, "VALIDATING");
    assert.equal(report.missionHash, compiled.missionHash);
    assert.equal(report.objectiveHash, createHash("sha256").update(`pi-durable-objective-v1\0${compiled.contract.objective}`).digest("hex"));
    assert.equal(report.worker.process.status, "alive");
    assert.equal(report.worker.session.status, "present");
    assert.equal(report.worker.lastHeartbeatAt, "2026-09-02T00:00:03.000Z");
    assert.equal(report.worker.heartbeatAgeMs, 7_000);
    assert.equal(report.budgets.consumed.turns, 1);
    assert.equal(report.budgets.consumed.tokens, 125);
    assert.equal(report.budgets.remaining.wallClockMs, 110_000);
    assert.equal(report.validator.status, "pass");
    assert.equal(report.workspaceLease.state, "active");
    assert.equal(report.workspaceLease.belongsToMission, true);
    assert.equal(report.workspaceLease.ownerProcess.status, "alive");
    assert.equal(report.supervisor.state, "released");
    assert.equal(report.safeAction.code, "wait-worker");
    assert.equal(JSON.stringify(report).includes("ownerToken"), false, "inspection must not disclose lease capability tokens");
    assertBytesEqual(before);

    inspector.values.set(72_002, { pid: 72_002, alive: false });
    let next = mission.inspectDurableMission({ runsRoot, runId: "inspect-live", processInspector: inspector, clock: () => new Date("2026-09-02T00:00:10.000Z") });
    assert.equal(next.safeAction.code, "wait-supervisor", "a live lease owner still fences a dead worker before expiry");
    inspector.values.set(72_001, { pid: 72_001, alive: false });
    next = mission.inspectDurableMission({ runsRoot, runId: "inspect-live", processInspector: inspector, clock: () => new Date("2026-09-02T00:00:10.000Z") });
    assert.equal(next.safeAction.code, "resume-mission");
    assert.match(next.safeAction.reason, /publish the durable validator pass/);

    const missingSession = path.join(sessions, "missing.jsonl");
    createRun({ runsRoot, runId: "inspect-missing-session", compiled, sessionFile: missingSession, state: "resume-worker" });
    next = mission.inspectDurableMission({ runsRoot, runId: "inspect-missing-session", processInspector: inspector, clock: () => new Date("2026-09-02T00:00:10.000Z") });
    assert.equal(next.worker.process.status, "dead");
    assert.equal(next.worker.session.status, "missing");
    assert.equal(next.safeAction.code, "inspect-runtime", "another run's active workspace lease must block resume first");
    lease.release();
    next = mission.inspectDurableMission({ runsRoot, runId: "inspect-missing-session", processInspector: inspector, clock: () => new Date("2026-09-02T00:00:10.000Z") });
    assert.equal(next.safeAction.code, "inspect-session");

    const heldJournal = mission.FileMissionJournal.open(runsRoot, "inspect-missing-session");
    const actualOwner = new mission.SystemProcessInspector().inspect(process.pid);
    assert.equal(actualOwner.alive, true);
    assert.ok(actualOwner.startedAt);
    inspector.values.set(process.pid, actualOwner);
    next = mission.inspectDurableMission({ runsRoot, runId: "inspect-missing-session", processInspector: inspector, clock: () => new Date("2026-09-02T00:00:10.000Z") });
    assert.equal(next.supervisor.state, "active");
    assert.equal(next.safeAction.code, "wait-supervisor", "an active journal owner must fence a second supervisor");
    heldJournal.close();

    inspector.values.set(72_002, { pid: 72_002, alive: true });
    next = mission.inspectDurableMission({ runsRoot, runId: "inspect-missing-session", processInspector: inspector, clock: () => new Date("2026-09-02T00:00:10.000Z") });
    assert.equal(next.worker.process.status, "unknown");
    assert.equal(next.safeAction.code, "inspect-worker", "uncertain process identity must fail closed");

    createRun({ runsRoot, runId: "inspect-unknown", compiled, sessionFile, state: "outcome-unknown" });
    next = mission.inspectDurableMission({ runsRoot, runId: "inspect-unknown", processInspector: inspector, clock: () => new Date("2026-09-02T00:00:10.000Z") });
    assert.equal(next.state, "OUTCOME_UNKNOWN");
    assert.equal(next.safeAction.code, "reconcile-outcome", "outcome reconciliation takes priority over worker uncertainty");

    const malformedCanonical = JSON.stringify({ ...compiled.contract, budgets: { ...compiled.contract.budgets, hidden: "secret" } });
    const malformedHash = createHash("sha256").update(malformedCanonical).digest("hex");
    const malformed = mission.FileMissionJournal.create(runsRoot, "inspect-malformed-contract");
    add(malformed, "mission.created", { missionHash: malformedHash, canonicalJson: malformedCanonical });
    malformed.close();
    assert.throws(
      () => mission.inspectDurableMission({ runsRoot, runId: "inspect-malformed-contract", processInspector: inspector }),
      (error) => error.code === "MISSION_INSPECTION_CONTRACT_MALFORMED",
      "inspection must apply the full mission compiler and reject extra contract fields",
    );

    const unfencedWorkspace = path.join(root, "unfenced-workspace");
    fs.mkdirSync(unfencedWorkspace);
    fs.writeFileSync(path.join(unfencedWorkspace, "validate.cjs"), "process.exit(0);\n");
    const unfencedCompiled = compile(unfencedWorkspace);
    const unfencedRun = mission.FileMissionJournal.create(runsRoot, "inspect-unfenced-worker");
    add(unfencedRun, "mission.created", {
      missionHash: unfencedCompiled.missionHash, canonicalJson: unfencedCompiled.canonicalJson,
      cwd: unfencedCompiled.contract.cwd, workerAdapter: "inspection-fixture",
    });
    add(unfencedRun, "mission.started", { missionHash: unfencedCompiled.missionHash });
    unfencedRun.close();
    const unfencedInspector = processInspector({ 73_001: { alive: true, startedAt: "2026-09-02T00:00:01.000Z" } });
    mission.FileWorkspaceLease.acquire({
      leaseRoot: path.join(runsRoot, "workspace-leases"), workspacePath: unfencedWorkspace,
      workspaceFingerprint: unfencedCompiled.contract.workspaceFingerprint, runId: "inspect-unfenced-worker",
      missionHash: unfencedCompiled.missionHash, ownerPid: 73_001,
      ownerProcessStartedAt: "2026-09-02T00:00:01.000Z", processInspector: unfencedInspector,
    });
    unfencedInspector.values.set(73_001, { pid: 73_001, alive: false });
    next = mission.inspectDurableMission({ runsRoot, runId: "inspect-unfenced-worker", processInspector: unfencedInspector });
    assert.equal(next.workspaceLease.workerProcess.status, "not-recorded");
    assert.equal(next.safeAction.code, "inspect-runtime", "unfenced worker spawn window must never be reported safe to resume");

    console.log("PASS durable-mission inspection: read-only state, strict contract, supervisor/process/session/lease fencing, budgets, validator, and safe action");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
