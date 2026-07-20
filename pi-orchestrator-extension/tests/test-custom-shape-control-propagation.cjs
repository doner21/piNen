#!/usr/bin/env node
/**
 * Regression: explicit controls survive registered-tool custom-shape dispatch.
 *
 * This invokes the actual registered `orchestrate` tool and selects a genuine
 * shape-builder-produced bespoke shape. The fake Pi child is only a provider
 * fixture; dispatch, normalization, shape selection, routing, fan-out, and
 * result assembly are production extension code.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function loadRegisteredOrchestrateTool() {
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
  assert.ok(tool && typeof tool.execute === "function", "production orchestrate tool must be registered");
  return tool;
}

function jsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function assertRoute(row, provider, model, label) {
  assert.equal(row.provider, provider, `${label} provider route was dropped or defaulted`);
  assert.equal(row.model, model, `${label} model route was dropped or defaulted`);
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-control-dispatch-"));
  const logPath = path.join(tmp, "fake-pi-calls.jsonl");
  const runsRoot = path.join(PROJECT_ROOT, "runs-state");
  const runsBefore = new Set(fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []);
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadRegisteredOrchestrateTool();
    const controls = {
      paradigm: "preregistered-concurrency-spike",
      task: "Exercise the registered bespoke shape control path without modifying project files.",
      cwd: tmp,
      preflight: false,
      hardGates: "strict",
      maxSubagents: 8,
      executorConcurrency: 2,
      concurrency: 2,
      verifierCount: 2,
      plannerProvider: "openai-codex",
      plannerModel: "gpt-5.6-sol",
      executorProvider: "openai-codex",
      executorModel: "gpt-5.6-sol",
      verifierProvider: "zai",
      verifierModel: "glm-5.2",
    };
    const result = await tool.execute(
      "test-custom-shape-control-propagation",
      controls,
      undefined,
      () => {},
      { cwd: tmp },
    );
    const details = result.details;
    assert.ok(details, "registered runtime invocation must return structured details");

    // Bespoke identity must survive dispatch; a built-in must never be relabelled.
    assert.equal(details.paradigm, controls.paradigm, "bespoke shape identity was lost during dispatch");
    assert.notEqual(details.paradigm, "plan-execute-verify", "custom dispatch silently selected the built-in PEV shape");
    assert.equal(details.status, "pass", "bespoke fixture execution must complete");

    // Invocation controls must be materialized by the custom runtime, not lost.
    assert.deepEqual(details.controls, {
      executorConcurrency: 2,
      verifierCount: 2,
      preflight: false,
      hardGates: "strict",
      contextIsolation: "separate pi --no-session subprocess per spawn",
    });
    assert.ok(Array.isArray(details.routingRequirements) && details.routingRequirements.length === 3,
      "explicit planner/executor/verifier routing requirements must remain nonempty");
    const required = Object.fromEntries(details.routingRequirements.map((row) => [row.role, row]));
    assertRoute(required.planner, "openai-codex", "gpt-5.6-sol", "planner requirement");
    assertRoute(required.executor, "openai-codex", "gpt-5.6-sol", "executor requirement");
    assertRoute(required.verifier, "zai", "glm-5.2", "verifier requirement");
    assert.equal(required.verifier.count, 2, "verifier fan-out requirement was dropped");
    assert.ok(Object.values(required).every((row) => row.essential === true), "explicit routes must remain essential");

    // Runtime role evidence proves the requirements reached actual spawns.
    const roleResults = details.roleResults;
    assert.ok(Array.isArray(roleResults) && roleResults.length > 0, "runtime role results must remain nonempty");
    const executorRows = roleResults.filter((row) => row.role === "executor");
    const verifierRows = roleResults.filter((row) => row.role === "verifier");
    assert.equal(executorRows.length, 2, "both bespoke executor phases must execute");
    assert.equal(verifierRows.length, 2, "exactly two independent verifier contexts must execute");
    executorRows.forEach((row, index) => {
      assertRoute(row, "openai-codex", "gpt-5.6-sol", `executor runtime row ${index + 1}`);
      assert.equal(row.isolatedContext, true, "executor context isolation was omitted");
    });
    verifierRows.forEach((row, index) => {
      assertRoute(row, "zai", "glm-5.2", `verifier runtime row ${index + 1}`);
      assert.equal(row.isolatedContext, true, "verifier context isolation was omitted");
    });
    assert.equal(details.verifierResults.length, 2, "verifier aggregation evidence must retain both verifiers");

    // Independent child-process telemetry is a second guard against a default
    // provider being silently selected below the shape result boundary.
    const calls = jsonl(logPath);
    assert.ok(calls.length >= 5, "bespoke dispatch must reach real child spawn calls");
    const coderCalls = calls.filter((row) => row.agentName === "coder");
    const reviewerCalls = calls.filter((row) => row.agentName === "reviewer");
    assert.equal(coderCalls.length, 2, "executor spawn count changed");
    assert.ok(reviewerCalls.length >= 2, "verifier spawn count changed");
    coderCalls.forEach((row, index) => assertRoute(row, "openai-codex", "gpt-5.6-sol", `executor child ${index + 1}`));
    reviewerCalls.forEach((row, index) => assertRoute(row, "zai", "glm-5.2", `reviewer child ${index + 1}`));
    assert.ok(calls.every((row) => row.provider && row.model), "a child silently selected the default provider/model");

    // Future shape-builder output must carry the same controls, routes, and
    // evidence instead of fixing only this preregistered shape.
    const supportSource = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shape-builder-support.ts"), "utf8");
    for (const requiredFragment of [
      "resolveShapePhaseRoute",
      "requestedVerifierCount",
      "executorConcurrency: params.concurrency",
      "contextIsolation:",
      "routingRequirements:",
      "roleResults:",
      "verifierResults:",
      "Promise.all(launches)",
    ]) {
      assert.ok(supportSource.includes(requiredFragment), `generated-shape template lost ${requiredFragment}`);
    }

    console.log("PASS custom-shape-control-propagation: registered bespoke dispatch preserves identity, explicit routes, concurrency=2, verifierCount=2, isolated contexts, and non-default runtime routing");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fs.existsSync(runsRoot)) {
      for (const name of fs.readdirSync(runsRoot)) {
        if (!runsBefore.has(name)) fs.rmSync(path.join(runsRoot, name), { recursive: true, force: true });
      }
    }
  }
}

run().catch((error) => {
  console.error("test-custom-shape-control-propagation: FAIL");
  console.error(error);
  process.exit(1);
});
