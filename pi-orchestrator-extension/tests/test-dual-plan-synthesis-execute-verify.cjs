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

async function testRegistryDiscovery() {
  const tool = loadOrchestrateTool();
  const result = await tool.execute(
    "test-dual-plan-discovery",
    { task: "list paradigms", paradigm: "unknown-test-paradigm", preflight: false, cwd: PROJECT_ROOT },
    undefined,
    () => {},
    { cwd: PROJECT_ROOT },
  );
  assert.equal(result.details.status, "fail");
  assert.match(result.details.abortReason, /dual-plan-synthesis-execute-verify/);
}

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "dual-plan-synthesis-execute-verify.ts"), "utf8");
  assert.match(source, /name:\s*"dual-plan-synthesis-execute-verify"/);
  assert.match(source, /runBoundedPool/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.match(source, /z-ai\/glm-5\.2/);
  assert.match(source, /claude-opus-4-8/);
  assert.match(source, /deepseek-v4-pro/);
  assert.match(source, /gpt-5\.5/);
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /while\s*\(\s*true\s*\)/, "shape must not contain unbounded loops");
}

async function testRunUsesFixedRoutesAndPasses() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-shape-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dual-plan-run",
      {
        task: "Fixture task: apply a minimal scheduler race fix and verify it.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 8,
        maxRetries: 1,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /Dual-Plan-Synthesis-Execute-Verify Orchestration: PASS/);
    assert.equal(result.details.shapeDetails?.status ?? result.details.status, "pass");

    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 5, "two planners, one synthesis reviewer, one coder, one verifier");
    const routedCalls = calls.map((call) => [call.agentName, call.provider, call.model]);
    assert.deepEqual(
      routedCalls.slice(0, 2).sort((a, b) => `${a[1]}/${a[2]}`.localeCompare(`${b[1]}/${b[2]}`)),
      [
        ["planner", "openai-codex", "gpt-5.5"],
        ["planner", "openrouter", "z-ai/glm-5.2"],
      ],
      "first two spawns should be the independent planners, order may vary due concurrency",
    );
    assert.deepEqual(routedCalls.slice(2), [
      ["reviewer", "anthropic", "claude-opus-4-8"],
      ["coder", "deepseek", "deepseek-v4-pro"],
      ["reviewer", "openai-codex", "gpt-5.5"],
    ]);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testRegistryDiscovery();
  testCommittedShapeStaticRules();
  await testRunUsesFixedRoutesAndPasses();
  console.log("PASS dual-plan-synthesis-execute-verify: registry, static rules, fixed routes");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
