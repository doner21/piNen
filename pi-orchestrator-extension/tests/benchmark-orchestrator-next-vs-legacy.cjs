#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });

function loadTools() {
  const mod = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  const tools = new Map();
  extension({
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    sendMessage() {},
  });
  return tools;
}

async function timed(action) {
  const started = process.hrtime.bigint();
  const result = await action();
  return { result, durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "orcn-legacy-compare-"));
  const workspace = path.join(temp, "product");
  const log = path.join(temp, "workers.jsonl");
  const runsRoot = path.join(temp, "next-runs");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "README.md"), "fixture\n", "utf8");
  const saved = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_PI_LOG: process.env.FAKE_PI_LOG,
    PI_ORCHESTRATOR_NEXT_RUNS_ROOT: process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT,
  };
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = log;
  process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = runsRoot;
  try {
    const tools = loadTools();
    const legacy = tools.get("orchestrate");
    const next = tools.get("orchestrate_next");
    assert.ok(legacy, "legacy escape hatch must remain registered during side-by-side proving");
    assert.ok(next, "v2 tool must be registered");

    const legacyRun = await timed(() => legacy.execute(
      "legacy-compare",
      {
        task: "Use 2 verifiers to review the supplied fixture independently and return cited checks.",
        paradigm: "verify-only",
        verifierCount: 2,
        preflight: false,
        cwd: workspace,
      },
      undefined,
      () => {},
      { cwd: workspace },
    ));
    assert.equal(legacyRun.result.details.status, "pass");
    assert.equal(legacyRun.result.details.spawnedCount, 2);

    const beforeNextRecords = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const nextRun = await timed(() => next.execute(
      "next-compare",
      {
        action: "run",
        task: "Review the supplied fixture from two independent perspectives and join the typed findings.",
        workflow: "read-only-fanout-join",
        concurrency: 2,
        cwd: workspace,
        runId: "compare-next-read-only",
      },
      undefined,
      () => {},
      { cwd: workspace },
    ));
    assert.equal(nextRun.result.details.status, "pass");
    const afterRecords = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
    const nextSpawned = afterRecords - beforeNextRecords;
    assert.equal(nextSpawned, 2);
    const eventText = fs.readFileSync(nextRun.result.details.eventLog, "utf8");
    const events = eventText.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "phase.attempt.started").length, 3, "two workers plus one deterministic join");
    assert.equal(events.filter((event) => event.type === "run.completed").length, 1);

    const output = {
      status: "PASS",
      benchmark: "read-only-two-worker-side-by-side-v1",
      fixture: "tests/fake-pi.cjs",
      legacy: {
        tool: "orchestrate",
        paradigm: "verify-only",
        status: legacyRun.result.details.status,
        workerSpawns: legacyRun.result.details.spawnedCount,
        durationMs: Number(legacyRun.durationMs.toFixed(1)),
        durableTypedEventLog: false,
      },
      next: {
        tool: "orchestrate_next",
        workflow: "read-only-fanout-join",
        status: nextRun.result.details.status,
        workerSpawns: nextSpawned,
        durationMs: Number(nextRun.durationMs.toFixed(1)),
        durableTypedEventLog: true,
        eventCount: events.length,
      },
      cutover: "hold-side-by-side",
      reason: "One deterministic fixture is not sufficient for default-tool cutover; legacy remains the explicit escape hatch until live pilot reliability thresholds are met.",
    };
    console.log(JSON.stringify(output));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("benchmark-orchestrator-next-vs-legacy: FAIL");
  console.error(error);
  process.exit(1);
});
