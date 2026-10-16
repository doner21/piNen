#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
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
const OBJECTIVE = "Create product.txt containing exactly fixed followed by one newline. Keep validate.cjs unchanged. Run any useful local check, then settle with a concise summary.";
const VALIDATOR_SPEC = { kind: "node-workspace-validator", script: "validate.cjs", timeoutMs: 10_000, maxOutputBytes: 16_384 };
const CLI_PATH = path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-benchmark-"));
const MARKERS = new Set();

function contract(cwd) {
  return {
    schemaVersion: 1,
    objective: OBJECTIVE,
    cwd,
    route: ROUTE,
    fallbacks: [],
    budgets: { wallClockMs: 5 * 60_000, maxTurns: 5, maxRestarts: 3, maxSpecialists: 0, maxTokens: 100_000 },
    validator: VALIDATOR_SPEC,
    constraints: ["Do not modify validate.cjs.", "Do not invoke another orchestration workflow."],
  };
}

function createWorkspace(label, forceFirstHostFailure) {
  const root = path.join(ROOT, label);
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const marker = benchmarkValidatorMarker(fs.realpathSync(cwd));
  MARKERS.add(marker);
  const validatorFile = path.join(cwd, "validate.cjs");
  fs.writeFileSync(validatorFile, [
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    "const workspaceKey = crypto.createHash('sha256').update(process.cwd()).digest('hex');",
    "const marker = path.join(os.tmpdir(), `dms-benchmark-validator-${workspaceKey}.marker`);",
    "const actual = fs.existsSync('product.txt') ? fs.readFileSync('product.txt', 'utf8') : '';",
    "if (actual !== 'fixed\\n') { console.error(JSON.stringify({code:'PRODUCT_NOT_FIXED',actual})); process.exit(2); }",
    forceFirstHostFailure
      ? "if (process.env.DMS_VALIDATOR === '1' && !fs.existsSync(marker)) { fs.writeFileSync(marker, 'forced-once\\n'); console.error('FORCED_FIRST_HOST_VALIDATION_FAILURE: settle again without weakening validate.cjs'); process.exit(3); }"
      : "// clean paired run has no injected validator failure",
    "console.log('PASS durable mission benchmark fixture');",
  ].join("\n"));
  const git = spawnSync("git", ["init", "-q"], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(spawnSync("git", ["add", "validate.cjs"], { cwd, encoding: "utf8", windowsHide: true }).status, 0);
  const committed = spawnSync("git", ["-c", "user.name=Durable Mission Benchmark", "-c", "user.email=benchmark@invalid", "commit", "-qm", "baseline"], {
    cwd, encoding: "utf8", windowsHide: true,
  });
  assert.equal(committed.status, 0, committed.stderr);
  return {
    root,
    cwd: fs.realpathSync(cwd),
    marker,
    validatorFile,
    validatorSha256: shaFile(validatorFile),
    sessions: path.join(root, "sessions"),
    runs: path.join(root, "runs"),
  };
}

async function directClean(fixture) {
  const hostRuntime = path.join(fixture.root, "direct-host");
  fs.mkdirSync(hostRuntime);
  const pinned = mission.pinNodeWorkspaceValidator(fixture.cwd, hostRuntime, VALIDATOR_SPEC);
  const factory = new mission.PiRpcMissionWorkerFactory({ cliPath: CLI_PATH, sessionRoot: fixture.sessions, promptTimeoutMs: 120_000, heartbeatMs: 500 });
  const started = performance.now();
  let worker;
  try {
    worker = await factory.open({ runId: "direct-clean", generation: 1, cwd: fixture.cwd, route: ROUTE, fallbacks: [], readOnly: false });
    let settled = false;
    let modelPrompts = 0;
    for await (const event of worker.prompt([
      OBJECTIVE,
      "Keep validate.cjs unchanged. Do not invoke an orchestration workflow.",
      "Work autonomously, run useful local checks, and return a concise summary when done.",
    ].join("\n\n"))) {
      if (event.type === "settled") { settled = true; modelPrompts += 1; break; }
    }
    assert.equal(settled, true);
    const validator = await mission.runPinnedNodeValidator(pinned, fixture.cwd);
    const identity = publicIdentity(worker.identity);
    await worker.close();
    const wallTimeMs = round(performance.now() - started);
    verifyWorkspace(fixture);
    assert.equal(validator.status, "pass");
    return {
      status: "pass",
      workerSpawns: 1,
      logicalPrimarySessions: 1,
      modelPrompts,
      ...sessionMetrics(identity.sessionFile),
      wallTimeMs,
      validatorIterations: 1,
      validatorStatuses: [validator.status],
      manualInterventionsPerformed: 0,
      manualInterventionsRequired: 0,
      recoveryOutcome: "not-needed-clean-run",
    };
  } finally {
    if (worker) {
      try { await worker.close(); }
      catch { await factory.terminate(worker.identity).catch(() => false); }
    }
  }
}

async function supervisedClean(fixture) {
  const factory = new mission.PiRpcMissionWorkerFactory({ cliPath: CLI_PATH, sessionRoot: fixture.sessions, promptTimeoutMs: 120_000, heartbeatMs: 500 });
  const started = performance.now();
  const result = await mission.runDurableMission({ contract: contract(fixture.cwd), workerFactory: factory, runId: "supervised-clean", runsRoot: fixture.runs });
  const wallTimeMs = round(performance.now() - started);
  assert.equal(result.status, "pass");
  verifyWorkspace(fixture);
  const inspected = mission.FileMissionJournal.inspect(fixture.runs, "supervised-clean");
  const starts = inspected.events.filter((event) => event.type === "worker.started").map((event) => event.data.identity);
  const validators = inspected.events.filter((event) => event.type === "validator.completed").map((event) => event.data.result.status);
  return {
    status: result.status,
    workerSpawns: starts.length,
    logicalPrimarySessions: new Set(starts.map((identity) => identity.sessionId)).size,
    modelPrompts: result.projection.usage.turns,
    ...sessionMetrics(starts.at(-1).sessionFile),
    wallTimeMs,
    validatorIterations: validators.length,
    validatorStatuses: validators,
    manualInterventionsPerformed: 0,
    manualInterventionsRequired: 0,
    recoveryOutcome: "not-needed-clean-run",
    durableEventCount: inspected.events.length,
  };
}

async function directCrash(fixture) {
  const hostRuntime = path.join(fixture.root, "direct-host");
  fs.mkdirSync(hostRuntime);
  const pinned = mission.pinNodeWorkspaceValidator(fixture.cwd, hostRuntime, VALIDATOR_SPEC);
  const crashMarker = path.join(fixture.root, "direct-controller-crashed.json");
  const started = performance.now();
  const child = await runChild(path.join(__dirname, "fixtures", "durable-mission-direct-crash-child.cjs"), {
    DMS_DIRECT_CWD: fixture.cwd,
    DMS_DIRECT_SESSIONS: fixture.sessions,
    DMS_DIRECT_CRASH_MARKER: crashMarker,
    DMS_DIRECT_CLI: CLI_PATH,
    DMS_DIRECT_OBJECTIVE: OBJECTIVE,
    DMS_LIVE_PROVIDER: ROUTE.provider,
    DMS_LIVE_MODEL: ROUTE.model,
  }, 92);
  assert.equal(fs.existsSync(crashMarker), true, child.stderr);
  const marker = JSON.parse(fs.readFileSync(crashMarker, "utf8"));
  verifyWorkspace(fixture);
  const cleanupFactory = new mission.PiRpcMissionWorkerFactory({ cliPath: CLI_PATH, sessionRoot: fixture.sessions });
  const workerState = await cleanupFactory.inspect(marker.identity);
  if (workerState.state !== "exited") assert.equal(await cleanupFactory.terminate(marker.identity), true, "direct orphan worker cleanup failed");
  assert.equal((await cleanupFactory.inspect(marker.identity)).state, "exited");
  const validator = await mission.runPinnedNodeValidator(pinned, fixture.cwd);
  assert.equal(validator.status, "fail", "injected first host validation must require a post-crash repair turn");
  const wallTimeMs = round(performance.now() - started);
  return {
    status: "intervention-required",
    workerSpawns: 1,
    logicalPrimarySessions: 1,
    modelPrompts: marker.modelPrompts,
    ...sessionMetrics(marker.identity.sessionFile),
    wallTimeMs,
    validatorIterations: 0,
    validatorStatuses: [],
    postCrashDiagnostic: { validatorIterations: 1, validatorStatuses: [validator.status] },
    diagnosticInterventionsPerformed: 1,
    manualInterventionsPerformed: 0,
    manualInterventionsRequired: 1,
    recoveryOutcome: "workspace-and-session-survived-but-no-controller-resumed-validator-repair",
    controllerExitCode: child.code,
  };
}

async function supervisedCrash(fixture) {
  const crashMarker = path.join(fixture.root, "supervisor-crashed.json");
  const runId = "supervised-crash";
  const started = performance.now();
  const child = await runChild(path.join(__dirname, "fixtures", "durable-mission-live-crash-child.cjs"), {
    DMS_FIXTURE_CWD: fixture.cwd,
    DMS_FIXTURE_RUNS: fixture.runs,
    DMS_FIXTURE_SESSIONS: fixture.sessions,
    DMS_FIXTURE_CRASH_MARKER: crashMarker,
    DMS_FIXTURE_CLI: CLI_PATH,
    DMS_FIXTURE_RUN_ID: runId,
    DMS_LIVE_PROVIDER: ROUTE.provider,
    DMS_LIVE_MODEL: ROUTE.model,
  }, 91);
  assert.equal(fs.existsSync(crashMarker), true, child.stderr);
  verifyWorkspace(fixture);
  const afterCrash = mission.FileMissionJournal.inspect(fixture.runs, runId);
  const prior = afterCrash.projection.worker;
  assert.ok(prior?.pid);
  const cleanupFactory = new mission.PiRpcMissionWorkerFactory({ cliPath: CLI_PATH, sessionRoot: fixture.sessions });
  if ((await cleanupFactory.inspect(prior)).state !== "exited") assert.equal(await cleanupFactory.terminate(prior), true);
  assert.equal((await cleanupFactory.inspect(prior)).state, "exited");

  const factory = new mission.PiRpcMissionWorkerFactory({ cliPath: CLI_PATH, sessionRoot: fixture.sessions, promptTimeoutMs: 120_000, heartbeatMs: 500 });
  const result = await mission.runDurableMission({ contract: contract(fixture.cwd), workerFactory: factory, runId, runsRoot: fixture.runs });
  const wallTimeMs = round(performance.now() - started);
  assert.equal(result.status, "pass");
  verifyWorkspace(fixture);
  const inspected = mission.FileMissionJournal.inspect(fixture.runs, runId);
  const starts = inspected.events.filter((event) => event.type === "worker.started").map((event) => event.data.identity);
  const validators = inspected.events.filter((event) => event.type === "validator.completed").map((event) => event.data.result.status);
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map((identity) => identity.sessionId)).size, 1);
  assert.deepEqual(validators, ["fail", "pass"]);
  return {
    status: result.status,
    workerSpawns: starts.length,
    logicalPrimarySessions: 1,
    modelPrompts: result.projection.usage.turns,
    ...sessionMetrics(starts.at(-1).sessionFile),
    wallTimeMs,
    validatorIterations: validators.length,
    validatorStatuses: validators,
    manualInterventionsPerformed: 0,
    manualInterventionsRequired: 0,
    recoveryOutcome: "automatic-exact-session-resume-validator-feedback-and-success",
    controllerExitCode: child.code,
    durableEventCount: inspected.events.length,
  };
}

async function runChild(script, extraEnv, expectedCode) {
  const child = spawn(process.execPath, [script], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const outcome = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${path.basename(script)} exceeded 180 seconds`)), 180_000)),
  ]).catch(async (error) => {
    if (child.pid) await terminateTree(child.pid);
    throw error;
  });
  assert.equal(outcome.code, expectedCode, `${path.basename(script)} exit=${outcome.code} signal=${outcome.signal}\nstdout=${stdout}\nstderr=${stderr}`);
  return { ...outcome, stdout, stderr };
}

function sessionMetrics(file) {
  const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const assistants = entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").map((entry) => entry.message);
  return {
    modelCalls: assistants.length,
    toolCalls: assistants.reduce((total, message) => total + (Array.isArray(message.content) ? message.content.filter((item) => item.type === "toolCall").length : 0), 0),
    tokens: assistants.reduce((total, message) => total + usageTokens(message.usage), 0),
  };
}

function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  if (Number.isFinite(usage.total)) return usage.total;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function verifyWorkspace(fixture) {
  assert.equal(fs.readFileSync(path.join(fixture.cwd, "product.txt"), "utf8"), "fixed\n");
  assert.equal(shaFile(fixture.validatorFile), fixture.validatorSha256, "agent modified validator source");
  const runtimeLeaks = fs.readdirSync(fixture.cwd).filter((name) => ![".git", "product.txt", "validate.cjs"].includes(name));
  assert.deepEqual(runtimeLeaks, [], `unexpected workspace files: ${runtimeLeaks.join(", ")}`);
}

function publicIdentity(identity) {
  return {
    adapter: identity.adapter, workerId: identity.workerId, pid: identity.pid,
    processStartedAt: identity.processStartedAt, sessionId: identity.sessionId,
    sessionFile: identity.sessionFile, cursor: identity.cursor, generation: identity.generation,
    route: identity.route,
  };
}

function shaFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function benchmarkValidatorMarker(cwd) {
  const workspaceKey = crypto.createHash("sha256").update(cwd).digest("hex");
  return path.join(os.tmpdir(), `dms-benchmark-validator-${workspaceKey}.marker`);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function terminateTree(pid) {
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

(async () => {
  assert.equal(fs.existsSync(CLI_PATH), true, "installed Pi CLI is required");
  try {
    const cleanDirectFixture = createWorkspace("clean-direct", false);
    const cleanSupervisedFixture = createWorkspace("clean-supervised", false);
    const crashDirectFixture = createWorkspace("crash-direct", true);
    const crashSupervisedFixture = createWorkspace("crash-supervised", true);
    assert.equal(cleanDirectFixture.validatorSha256, cleanSupervisedFixture.validatorSha256, "clean pair must pin byte-identical validators");
    assert.equal(crashDirectFixture.validatorSha256, crashSupervisedFixture.validatorSha256, "crash pair must pin byte-identical validators");

    const cleanDirect = await directClean(cleanDirectFixture);
    const cleanSupervised = await supervisedClean(cleanSupervisedFixture);
    const crashDirect = await directCrash(crashDirectFixture);
    const crashSupervised = await supervisedCrash(crashSupervisedFixture);

    assert.equal(cleanDirect.workerSpawns, 1);
    assert.equal(cleanSupervised.workerSpawns, 1, "supervisor must not increase ordinary worker count");
    assert.equal(crashDirect.status, "intervention-required");
    assert.equal(crashSupervised.status, "pass");
    const report = {
      version: 1,
      benchmark: "durable-mission-vs-direct-agent-paired-live-v1",
      recordedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      route: ROUTE,
      objectiveSha256: crypto.createHash("sha256").update(OBJECTIVE).digest("hex"),
      order: ["clean-direct", "clean-supervised", "crash-direct", "crash-supervised"],
      clean: { direct: cleanDirect, supervised: cleanSupervised },
      crashRecovery: { direct: crashDirect, supervised: crashSupervised },
      comparison: {
        ordinaryWorkerCountEqual: cleanDirect.workerSpawns === cleanSupervised.workerSpawns,
        wallTimeInterpretation: "observational-only; one fixed execution order is insufficient for a causal overhead estimate",
        supervisedOrdinaryExtraModelCalls: cleanSupervised.modelCalls - cleanDirect.modelCalls,
        recoveryValueObserved: crashSupervised.status === "pass" && crashDirect.manualInterventionsRequired > 0,
        publicToolDecision: "hold-until-full-live-suite-and-focused-diff-pass",
      },
      status: "PASS",
    };
    const defaultOutput = path.join(PROJECT_ROOT, "intakes", "durable-mission-supervisor", "benchmark-results", `paired-live-${report.recordedAt.replace(/[:.]/g, "-")}.json`);
    const output = path.resolve(process.env.DMS_BENCH_OUTPUT || defaultOutput);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ ...report, output }, null, 2));
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    for (const marker of MARKERS) fs.rmSync(marker, { force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
