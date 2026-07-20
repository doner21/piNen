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

function loadOrchestrateTool() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const mod = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
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

async function runWithFakePi() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orchestrate-role-concurrency-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_PLAN_STYLE = "analysis-4";
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-role-concurrency",
      {
        task: "Tiny role-concurrency demo: use two planners, four executors, and three verifiers on independent analysis-only items. Test should run on DeepSeek V4 Flash.",
        cwd: PROJECT_ROOT,
        maxRetries: 0,
        maxSubagents: 20,
        plannerProvider: "deepseek",
        plannerModel: "deepseek-v4-flash",
        executorProvider: "deepseek",
        executorModel: "deepseek-v4-flash",
        verifierProvider: "deepseek",
        verifierModel: "deepseek-v4-flash",
      },
      undefined,
      () => {},
      { cwd: PROJECT_ROOT },
    );
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim() : "";
    const calls = logText ? logText.split("\n").map((line) => JSON.parse(line)) : [];
    return { result, calls };
  } finally {
    delete process.env.FAKE_PI_PLAN_STYLE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runWithFakePi()
  .then(({ result, calls }) => {
    const markdown = result.content?.[0]?.text || "";
    const details = result.details;
    assert.match(markdown, /# Orchestration Result: PASS/);
    assert.equal(details.params.plannerCount, 2);
    assert.equal(details.params.concurrency, 4);
    assert.equal(details.params.verifierCount, 3);

    assert.equal(calls.filter((call) => call.agentName === "planner").length, 2, "two planners should spawn");
    assert.equal(calls.filter((call) => call.agentName === "coder").length, 4, "four independent executor tasks should spawn");
    assert.equal(calls.filter((call) => call.agentName === "reviewer").length, 3, "three verifiers should spawn");

    assert.ok(calls.filter((call) => ["planner", "coder", "reviewer"].includes(call.agentName)).every((call) => call.provider === "deepseek"));
    assert.ok(calls.filter((call) => ["planner", "coder", "reviewer"].includes(call.agentName)).every((call) => call.model === "deepseek-v4-flash"));

    const progress = details.deterministicState.progressLog.join("\n");
    assert.match(progress, /spawning 2 planner subagent\(s\) in parallel/);
    assert.match(progress, /executor concurrency 4/);
    assert.match(progress, /3 verifier subagent\(s\) in parallel/);
    assert.equal(details.deterministicState.verifierResult.status, "pass");
    assert.equal(details.deterministicState.verifierResults.length, 3);
    console.log("PASS role concurrency: 2 planners, 4 executors, 3 verifiers on DeepSeek V4 Flash fixture");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
