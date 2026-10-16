#!/usr/bin/env node
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PI_NODE_MODULES = path.join(PROJECT_ROOT, "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
process.env.PI_ORCHESTRATOR_RUNS_ROOT = path.join(os.tmpdir(), `dms-load-no-inspection-${process.pid}`);
Module._initPaths();
childProcess.spawnSync = () => { throw new Error("process inspection deliberately unavailable during extension load"); };
Module.syncBuiltinESMExports();
const createJiti = require(path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const mod = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));

(async () => {
  const tools = new Set();
  await (mod.default ?? mod)({
    registerTool(definition) { tools.add(definition.name); },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
  });
  assert.equal(tools.has("orchestrate"), true, "legacy orchestrate must still register");
  assert.equal(tools.has("orchestrate_next"), true, "orchestrate_next must still register");
  assert.equal(tools.has("orchestrate_mission"), true, "durable mission must register after lazy import");

  const guardedTools = new Set();
  await (mod.default ?? mod)({
    registerTool(definition) {
      if (definition.name === "orchestrate_mission") throw new Error("synthetic optional registration failure");
      guardedTools.add(definition.name);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
  });
  assert.equal(guardedTools.has("orchestrate"), true, "mission registration failure must preserve legacy orchestrate");
  assert.equal(guardedTools.has("orchestrate_next"), true, "mission registration failure must preserve orchestrate_next");

  const importFailureTools = new Map();
  await (mod.default ?? mod)({
    registerTool(definition) { importFailureTools.set(definition.name, definition); },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
  });
  process.env.PI_ORCHESTRATOR_TEST_FAIL_MISSION_MODULE = "1";
  await assert.rejects(
    () => importFailureTools.get("orchestrate_mission").execute("synthetic", { action: "inspect", runId: "unused" }),
    /synthetic durable mission module load failure/,
  );
  delete process.env.PI_ORCHESTRATOR_TEST_FAIL_MISSION_MODULE;
  assert.equal(importFailureTools.has("orchestrate"), true, "mission import failure must preserve legacy orchestrate");
  assert.equal(importFailureTools.has("orchestrate_next"), true, "mission import failure must preserve orchestrate_next");
  assert.equal(importFailureTools.has("orchestrate_mission"), true, "lazy shell remains available for a later healthy call");
  fs.rmSync(process.env.PI_ORCHESTRATOR_RUNS_ROOT, { recursive: true, force: true });
  console.log("PASS extension load isolates process inspection and optional mission registration");
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
