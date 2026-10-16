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

const FAKE_CLI = path.join(__dirname, "fixtures", "fake-mission-rpc-cli.cjs");
const PRIMARY = { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "off" };

function request(cwd, generation = 1, resume, route = PRIMARY, fallbacks = []) {
  return { runId: "rpc-fixture", generation, cwd, route, fallbacks, readOnly: false, ...(resume ? { resume } : {}) };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitFor(test, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return test();
}

async function testFakeLifecycle(root) {
  const cwd = path.join(root, "fake-workspace");
  const sessionRoot = path.join(root, "fake-sessions");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot,
    heartbeatMs: 10,
    promptTimeoutMs: 2_000,
    shutdownGraceMs: 500,
    env: { FAKE_RPC_SETTLE_MS: "60" },
  });
  const worker = await factory.open(request(cwd));
  const firstIdentity = { ...worker.identity, route: { ...worker.identity.route } };
  assert.equal(worker.identity.adapter, "pi-rpc-mission-worker-v1");
  assert.ok(worker.identity.pid > 0);
  assert.ok(worker.identity.processStartedAt);
  assert.equal(worker.identity.route.provider, PRIMARY.provider);
  assert.ok(path.isAbsolute(worker.identity.sessionFile));
  assert.ok(fs.existsSync(worker.identity.sessionFile));
  const header = JSON.parse(fs.readFileSync(worker.identity.sessionFile, "utf8").split("\n", 1)[0]);
  assert.equal(header.id, worker.identity.sessionId, "worker identity must point at an already durable session header");
  assert.equal(fs.realpathSync(header.cwd), fs.realpathSync(cwd));
  assert.equal((await worker.inspect()).state, "idle");

  const events = await collect(worker.prompt("Perform the fixture objective."));
  assert.ok(events.some((event) => event.type === "heartbeat"));
  assert.ok(events.some((event) => event.type === "tool" && event.phase === "start" && event.toolName === "read"));
  assert.ok(events.some((event) => event.type === "tool" && event.phase === "end" && event.isError === false));
  const cursor = events.find((event) => event.type === "cursor");
  const settled = events.find((event) => event.type === "settled");
  assert.ok(cursor && cursor.cursor);
  assert.equal(settled.cursor, cursor.cursor);
  assert.equal(settled.tokens, 120);
  assert.equal(worker.identity.cursor, cursor.cursor);
  assert.equal((await worker.inspect()).state, "idle");
  await worker.close();
  assert.equal(await waitFor(() => !isAlive(firstIdentity.pid)), true);

  const resumed = await factory.open(request(cwd, 2, { ...firstIdentity, cursor: cursor.cursor }));
  assert.equal(resumed.identity.sessionId, firstIdentity.sessionId);
  assert.equal(resumed.identity.sessionFile, firstIdentity.sessionFile);
  assert.equal(resumed.identity.cursor, cursor.cursor);
  assert.notEqual(resumed.identity.pid, firstIdentity.pid);
  assert.equal(resumed.identity.generation, 2);
  const second = await collect(resumed.prompt("Continue the same mission."));
  assert.equal(second.find((event) => event.type === "settled").tokens, 120, "usage must be a per-turn delta");
  assert.notEqual(resumed.identity.cursor, cursor.cursor);
  await resumed.close();
}

async function testRouteFallback(root) {
  const cwd = path.join(root, "fallback-workspace");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: path.join(root, "fallback-sessions"),
    shutdownGraceMs: 300,
    env: { FAKE_RPC_REJECT_PROVIDER: "broken-provider" },
  });
  const worker = await factory.open(request(
    cwd,
    1,
    undefined,
    { provider: "broken-provider", model: "broken", thinkingLevel: "off" },
    [PRIMARY],
  ));
  assert.deepEqual(worker.identity.route, PRIMARY);
  await worker.close();

  const exactSessionRoot = path.join(root, "exact-route-sessions");
  const initialFactory = new mission.PiRpcMissionWorkerFactory({ cliPath: FAKE_CLI, sessionRoot: exactSessionRoot, shutdownGraceMs: 300 });
  const initial = await initialFactory.open(request(cwd, 1, undefined, PRIMARY, [{ provider: "fallback-provider", model: "fallback-model", thinkingLevel: "off" }]));
  const identity = { ...initial.identity, route: { ...initial.identity.route } };
  await initial.close();
  const rejectingResumeFactory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: exactSessionRoot,
    shutdownGraceMs: 300,
    env: { FAKE_RPC_REJECT_PROVIDER: PRIMARY.provider },
  });
  await assert.rejects(
    () => rejectingResumeFactory.open(request(cwd, 2, identity, PRIMARY, [{ provider: "fallback-provider", model: "fallback-model", thinkingLevel: "off" }])),
    /RPC_ROUTE_CHAIN_EXHAUSTED/,
    "resume must fail rather than reopen the durable session on a different fallback route",
  );
}

async function testMalformedProtocolFailsClosed(root) {
  const cwd = path.join(root, "malformed-workspace");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: path.join(root, "malformed-sessions"),
    shutdownGraceMs: 300,
    env: { FAKE_RPC_MALFORMED_ON_PROMPT: "1" },
  });
  const worker = await factory.open(request(cwd));
  const pid = worker.identity.pid;
  await assert.rejects(() => collect(worker.prompt("trigger malformed output")), /RPC_MALFORMED_JSON|RPC_PROCESS_EXITED/);
  assert.equal(await waitFor(() => !isAlive(pid)), true, "protocol corruption must terminate the owned process before rejection settles");
  await worker.close();
}

async function testTornFrameTerminatesWorker(root) {
  const cwd = path.join(root, "torn-frame-workspace");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: path.join(root, "torn-frame-sessions"),
    shutdownGraceMs: 500,
    env: { FAKE_RPC_TORN_FRAME_ON_PROMPT: "1" },
  });
  const worker = await factory.open(request(cwd));
  const pid = worker.identity.pid;
  await assert.rejects(() => collect(worker.prompt("trigger torn frame")), /RPC_TORN_FRAME|RPC_PROCESS_EXITED/);
  assert.equal(await waitFor(() => !isAlive(pid)), true, "unterminated JSONL must fail closed and terminate the worker");
  await worker.close();
}

async function testMissingInitialSessionFailsClosed(root) {
  const cwd = path.join(root, "missing-session-workspace");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: path.join(root, "missing-session-root"),
    shutdownGraceMs: 500,
    env: { FAKE_RPC_REPORT_MISSING_SESSION: "1" },
  });
  await assert.rejects(() => factory.open(request(cwd)), /RPC_SESSION_NOT_DURABLE/);
}

async function testIdleProtocolCorruptionTerminatesWorker(root) {
  const cwd = path.join(root, "idle-malformed-workspace");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: path.join(root, "idle-malformed-sessions"),
    shutdownGraceMs: 500,
    env: { FAKE_RPC_MALFORMED_IDLE_MS: "500" },
  });
  const worker = await factory.open(request(cwd));
  const pid = worker.identity.pid;
  assert.equal(await waitFor(() => !isAlive(pid), 5_000), true, "idle protocol corruption must terminate the worker without a prompt listener");
  assert.equal((await worker.inspect()).state, "exited");
  await worker.close();
}

async function testSignalAbortSettlesAsFailure(root) {
  const cwd = path.join(root, "abort-workspace");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: path.join(root, "abort-sessions"),
    heartbeatMs: 10,
    shutdownGraceMs: 300,
    env: { FAKE_RPC_HANG_PROMPT: "1" },
  });
  const worker = await factory.open(request(cwd));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const events = await collect(worker.prompt("hang until aborted", controller.signal));
  const failed = events.find((event) => event.type === "failed");
  assert.ok(failed);
  assert.match(failed.message, /aborted by supervisor signal/);
  assert.ok(failed.cursor, "abort settlement must still publish the durable cursor");
  await worker.close();
}

async function testReadOnlyProfileAndEnvironmentIsolation(root) {
  const cwd = path.join(root, "readonly-profile-workspace");
  const argvFile = path.join(root, "readonly-argv.json");
  const envFile = path.join(root, "readonly-env.json");
  fs.mkdirSync(cwd);
  process.env.DMS_TEST_AMBIENT_SECRET = "must-not-reach-worker";
  try {
    const factory = new mission.PiRpcMissionWorkerFactory({
      cliPath: FAKE_CLI,
      sessionRoot: path.join(root, "readonly-profile-sessions"),
      shutdownGraceMs: 300,
      env: {
        FAKE_RPC_ARGV_FILE: argvFile,
        FAKE_RPC_ENV_FILE: envFile,
        FAKE_RPC_TOOL_NAME: "edit",
      },
    });
    const worker = await factory.open({ ...request(cwd), readOnly: true });
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls");
    const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8"));
    assert.equal(Object.hasOwn(childEnv, "DMS_TEST_AMBIENT_SECRET"), false, "ambient supervisor secrets must be stripped");
    const events = await collect(worker.prompt("attempt a forbidden edit"));
    const failed = events.find((event) => event.type === "failed");
    assert.ok(failed);
    assert.match(failed.message, /read-only worker attempted forbidden tool 'edit'/);
    await worker.close();
  } finally {
    delete process.env.DMS_TEST_AMBIENT_SECRET;
  }

  const inside = path.join(cwd, ".mission-sessions");
  const unsafeFactory = new mission.PiRpcMissionWorkerFactory({ cliPath: FAKE_CLI, sessionRoot: inside });
  await assert.rejects(() => unsafeFactory.open({ ...request(cwd), readOnly: true }), /RPC_SESSION_ROOT_INSIDE_WORKSPACE/);
  assert.equal(fs.existsSync(inside), false, "unsafe in-workspace session root must be rejected before any directory mutation");
}

async function testWindowsTreeTermination(root) {
  if (process.platform !== "win32") return "skipped-non-windows";
  const cwd = path.join(root, "tree-workspace");
  const pidFile = path.join(root, "tree-pids.json");
  fs.mkdirSync(cwd);
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath: FAKE_CLI,
    sessionRoot: path.join(root, "tree-sessions"),
    shutdownGraceMs: 1_000,
    env: { FAKE_RPC_GRANDCHILD_PID_FILE: pidFile, FAKE_RPC_IGNORE_EOF: "1" },
  });
  const worker = await factory.open(request(cwd));
  assert.equal(await waitFor(() => fs.existsSync(pidFile)), true);
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  assert.equal(isAlive(pids.root), true);
  assert.equal(isAlive(pids.grandchild), true);
  assert.equal(await factory.terminate(worker.identity), true);
  assert.equal(await waitFor(() => !isAlive(pids.root) && !isAlive(pids.grandchild)), true, "taskkill /T must leave zero owned survivors");
  return "passed";
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-rpc-worker-"));
  const started = performance.now();
  try {
    await testFakeLifecycle(root);
    await testRouteFallback(root);
    await testMalformedProtocolFailsClosed(root);
    await testTornFrameTerminatesWorker(root);
    await testMissingInitialSessionFailsClosed(root);
    await testIdleProtocolCorruptionTerminatesWorker(root);
    await testSignalAbortSettlesAsFailure(root);
    await testReadOnlyProfileAndEnvironmentIsolation(root);
    const tree = await testWindowsTreeTermination(root);
    console.log(`PASS durable-mission RPC worker: strict JSONL/torn-frame rejection, durable cursor/session recovery, route fallback, abort, ${tree} process-tree cleanup (${(performance.now() - started).toFixed(1)}ms)`);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    } catch (error) {
      console.error(`RPC fixture cleanup deferred for ${root}: ${error.message}`);
    }
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
