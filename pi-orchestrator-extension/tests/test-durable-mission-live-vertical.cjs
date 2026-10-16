#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

const ROUTE = {
  provider: process.env.DMS_LIVE_PROVIDER || "openai-codex",
  model: process.env.DMS_LIVE_MODEL || "gpt-5.5",
  thinkingLevel: "off",
};

function contract(cwd) {
  return {
    schemaVersion: 1,
    objective: "Create product.txt containing exactly fixed followed by one newline. Keep validate.cjs unchanged. Run any useful local check, then settle with a concise summary.",
    cwd,
    route: ROUTE,
    fallbacks: [],
    budgets: { wallClockMs: 5 * 60_000, maxTurns: 5, maxRestarts: 3, maxSpecialists: 0, maxTokens: 100_000 },
    validator: { kind: "node-workspace-validator", script: "validate.cjs", timeoutMs: 10_000, maxOutputBytes: 16_384 },
    constraints: ["Do not modify validate.cjs.", "Do not invoke another orchestration workflow."],
  };
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitDead(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

async function runCrashChild(options) {
  const child = spawn(process.execPath, [path.join(__dirname, "fixtures", "durable-mission-live-crash-child.cjs")], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DMS_FIXTURE_CWD: options.cwd,
      DMS_FIXTURE_RUNS: options.runsRoot,
      DMS_FIXTURE_SESSIONS: options.sessionRoot,
      DMS_FIXTURE_CRASH_MARKER: options.crashMarker,
      DMS_FIXTURE_CLI: options.cliPath,
      DMS_FIXTURE_RUN_ID: options.runId,
      DMS_LIVE_PROVIDER: ROUTE.provider,
      DMS_LIVE_MODEL: ROUTE.model,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exit = await Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("crash child exceeded 180 seconds")), 180_000)),
  ]).catch(async (error) => {
    if (child.pid && alive(child.pid)) {
      if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else { try { process.kill(child.pid, "SIGKILL"); } catch {} }
    }
    throw error;
  });
  return { ...exit, stdout, stderr, pid: child.pid };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-live-vertical-"));
  const cwd = path.join(root, "workspace");
  const runsRoot = path.join(root, "runs");
  const sessionRoot = path.join(root, "sessions");
  const crashMarker = path.join(root, "supervisor-crashed.json");
  const validatorMarker = path.join(root, "host-validator-first-failure.marker");
  const cliPath = path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const runId = "live-crash-repair";
  fs.mkdirSync(cwd);
  const validatorFile = path.join(cwd, "validate.cjs");
  fs.writeFileSync(validatorFile, [
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(validatorMarker)};`,
    "const actual = fs.existsSync('product.txt') ? fs.readFileSync('product.txt', 'utf8') : '';",
    "if (actual !== 'fixed\\n') { console.error(JSON.stringify({code:'PRODUCT_NOT_FIXED',actual})); process.exit(2); }",
    "if (process.env.DMS_VALIDATOR === '1' && !fs.existsSync(marker)) { fs.writeFileSync(marker, 'forced-once\\n'); console.error('FORCED_FIRST_HOST_VALIDATION_FAILURE: settle again without weakening validate.cjs'); process.exit(3); }",
    "console.log('PASS durable live fixture');",
  ].join("\n"));
  const validatorSha = sha(validatorFile);

  try {
    const crashed = await runCrashChild({ cwd, runsRoot, sessionRoot, crashMarker, cliPath, runId });
    assert.equal(crashed.code, 91, `supervisor crash child did not stop at worker settlement; stderr=${crashed.stderr}`);
    assert.equal(fs.existsSync(crashMarker), true);
    assert.equal(fs.readFileSync(path.join(cwd, "product.txt"), "utf8"), "fixed\n", "first worker must mutate product before supervisor crash");
    assert.equal(sha(validatorFile), validatorSha, "worker must not edit validator source");

    const afterCrash = mission.FileMissionJournal.inspect(runsRoot, runId);
    assert.equal(afterCrash.projection.state, "VALIDATING");
    assert.equal(afterCrash.events.at(-1).type, "worker.settled", "crash must occur before workspace reconciliation or terminal publication");
    const priorIdentity = afterCrash.projection.worker;
    assert.ok(priorIdentity?.pid);
    assert.equal(await waitDead(crashed.pid), true, "crashed supervisor process must be gone");
    if (!await waitDead(priorIdentity.pid)) {
      const cleanupFactory = new mission.PiRpcMissionWorkerFactory({ cliPath, sessionRoot });
      assert.equal(await cleanupFactory.terminate(priorIdentity), true, "orphan worker must be boundedly terminable before resume");
    }
    assert.equal(await waitDead(priorIdentity.pid), true, "old worker must be proven dead before replacement");

    const factory = new mission.PiRpcMissionWorkerFactory({ cliPath, sessionRoot, promptTimeoutMs: 120_000, heartbeatMs: 500 });
    const result = await mission.runDurableMission({ contract: contract(cwd), workerFactory: factory, runId, runsRoot });
    assert.equal(result.status, "pass");
    assert.equal(result.projection.state, "SUCCEEDED");
    assert.equal(result.projection.usage.restarts, 1);
    assert.equal(fs.readFileSync(path.join(cwd, "product.txt"), "utf8"), "fixed\n");
    assert.equal(sha(validatorFile), validatorSha);
    assert.equal(fs.existsSync(validatorMarker), true, "host validator must execute its forced first-failure branch");

    const inspected = mission.FileMissionJournal.inspect(runsRoot, runId);
    const starts = inspected.events.filter((event) => event.type === "worker.started").map((event) => event.data.identity);
    assert.equal(starts.length, 2, "only original and one post-crash replacement worker may start");
    assert.equal(new Set(starts.map((identity) => identity.sessionId)).size, 1, "replacement must reopen the same primary Pi session");
    assert.notEqual(starts[0].pid, starts[1].pid);
    assert.deepEqual(inspected.events.filter((event) => event.type === "validator.completed").map((event) => event.data.result.status), ["fail", "pass"]);
    assert.equal(inspected.events.filter((event) => event.type === "repair.requested").length, 1);
    assert.ok(inspected.events.some((event) => event.type === "effects.observed" && event.data.effects.some((effect) => effect.path === "product.txt")));
    assert.equal(inspected.events.at(-1).type, "mission.succeeded");
    assert.deepEqual(mission.projectMission(inspected.events), result.projection, "event replay must reproduce the terminal projection exactly");
    assert.equal((await factory.inspect(starts[1])).state, "exited", "terminal mission must leave no live Pi worker");
    assert.deepEqual(fs.readdirSync(cwd).sort(), ["product.txt", "validate.cjs"], "supervisor runtime files must stay outside the product workspace");
    console.log(`PASS durable-mission live vertical: real ${ROUTE.provider}/${ROUTE.model} worker mutated, supervisor crashed pre-publication, exact session resumed under new PID, same agent received forced validator failure, repair pass reached SUCCEEDED`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
