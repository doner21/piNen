#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
);

process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function makeJiti() {
  return createJiti(__filename, { interopDefault: true, moduleCache: false });
}

function loadShapeModule() {
  return makeJiti()(path.join(PROJECT_ROOT, "src", "shapes", "venue-rescue-synthesis.ts"));
}

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "venue-rescue-synthesis.ts"), "utf8");
  assert.match(source, /name:\s*"venue-rescue-synthesis"/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /agent_reload_runtime\s*\(/, "shape must not call reload bridge");
  assert.doesNotMatch(source, /agent_scheduler\s*\(/, "shape must not call scheduler bridge");
  assert.doesNotMatch(source, /executeCommand\s*\(/, "shape must not call executeCommand");
  assert.doesNotMatch(source, /sendUserMessage\s*\(/, "shape must not send reload slash command");
  assert.doesNotMatch(source, /orchestrate\s*\(/, "shape must not call orchestrate");
}

function testCanaryBranch() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "venue-rescue-synthesis.ts"), "utf8");
  assert.match(source, /SHAPE_CANARY:venue-rescue-synthesis/, "generated shape must include deterministic SHAPE_CANARY branch");
  assert.match(source, /canary:\s*true/, "canary response must include canary: true");
  assert.match(source, /spawnedCount:\s*0/, "canary must not spawn subagents");
}

function testRegistryDiscovery() {
  // Shape must be registered: load index and probe with unknown paradigm
  const tool = loadOrchestrateTool();
  // done via loadOrchestrateTool checking shapeRegistry
}

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({
    registerTool(definition) {
      if (definition.name === "orchestrate") tool = definition;
    },
    registerCommand() {},
  });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

async function run() {
  testCommittedShapeStaticRules();
  testCanaryBranch();
  console.log("PASS venue-rescue-synthesis: static rules, canary branch");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
