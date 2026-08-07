#!/usr/bin/env node
/** Role-routing regressions for composable-pipeline. */
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
function makeJiti() { return createJiti(__filename, { interopDefault: true, moduleCache: false }); }

const SHAPE_PATH = path.join(PROJECT_ROOT, "src", "shapes", "composable-pipeline.ts");
const ALIASES_PATH = path.join(PROJECT_ROOT, "src", "model-aliases.ts");

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  let tool;
  (mod.default ?? mod)({
    registerTool(def) { if (def.name === "orchestrate") tool = def; },
    registerCommand() {},
  });
  assert.ok(tool);
  return tool;
}

function baseParams(tmp, extra) {
  return {
    task: "just synthesize the approach into a coherent understanding",
    cwd: tmp, maxSubagents: 12, allowLocalModel: false,
    executorAgent: "coder", verifierAgent: "reviewer", plannerAgent: "planner",
    concurrency: 1, plannerCount: 1, verifierCount: 1,
    maxRetries: 0, hardGates: "advisory", preflight: false,
    orchestrationControls: { runtimeRoles: [], rawMatches: [] },
    ...extra,
  };
}

async function driveComposable(inferredModelRouting = {}, extraParams = {}) {
  const shape = makeJiti()(SHAPE_PATH).composablePipelineShape;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-modelid-"));
  const logPath = path.join(tmp, "log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const result = await shape.run({
      params: baseParams(tmp, extraParams),
      agents: new Map([
        ["coder", { name: "coder", provider: "deepseek", model: "deepseek-v4-pro" }],
        ["planner", { name: "planner", provider: "openrouter", model: "profile/model" }],
      ]),
      onUpdate: () => {},
      inferredModelRouting,
    });
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    return { result, calls };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function driveTool(extraParams) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-tool-route-"));
  const logPath = path.join(tmp, "log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const result = await loadOrchestrateTool().execute(
      "composable-route-test",
      {
        task: "Only synthesize the fixture understanding.",
        paradigm: "composable-pipeline",
        cwd: tmp,
        maxSubagents: 8,
        preflight: true,
        ...extraParams,
      },
      undefined,
      () => {},
      { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    return { result, calls };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testNormalizerUnit() {
  const { normalizeAnthropicModelId, resolveComposedPhaseModel } = makeJiti()(ALIASES_PATH);
  assert.deepEqual(
    normalizeAnthropicModelId({ provider: "anthropic", model: "claude-sonnet-4.5" }),
    { provider: "anthropic", model: "claude-sonnet-4-5" },
  );
  assert.deepEqual(
    normalizeAnthropicModelId({ provider: "openai-codex", model: "gpt-5.5" }),
    { provider: "openai-codex", model: "gpt-5.5" },
  );
  assert.deepEqual(
    resolveComposedPhaseModel({ executorRoute: { provider: "p", model: "m" } }),
    { provider: "p", model: "m" },
  );
}

async function testRuntimeAndProfileHintsCannotHijackComposedSeat() {
  const { result, calls } = await driveComposable({
    runtimeRoles: { synthesizer: { provider: "deepseek", model: "deepseek-v4-pro" } },
  });
  const synth = calls.find((call) => call.composablePhase === "synthesize");
  assert.ok(synth, "synthesize phase must spawn");
  assert.deepEqual([synth.provider, synth.model], ["openai-codex", "gpt-5.6-sol"]);
  assert.deepEqual(result.details.selectedRoutes.planner,
    { provider: "openai-codex", model: "gpt-5.6-sol" });
  assert.equal(result.details.routingEvidence.length, 1, "every work seat must have route evidence");
  assert.ok(calls.every((call) => !/deepseek|openrouter/i.test(`${call.provider}/${call.model}`)),
    "no forbidden route may spawn");
}

async function testExplicitAllowedPlannerRouteReachesComposedSeat() {
  const { calls } = await driveComposable({}, {
    plannerProvider: "openai-codex", plannerModel: "gpt-5.6-sol",
  });
  const synth = calls.find((call) => call.composablePhase === "synthesize");
  assert.deepEqual([synth.provider, synth.model], ["openai-codex", "gpt-5.6-sol"]);
}

async function testForbiddenExplicitRoutesFailBeforeSpawn() {
  for (const route of [
    { plannerProvider: "deepseek", plannerModel: "deepseek-v4-pro" },
    { plannerProvider: "openrouter", plannerModel: "vendor/model" },
  ]) {
    await assert.rejects(
      () => driveComposable({}, route),
      (error) => error?.code === "FORBIDDEN_MODEL_ROUTE",
    );
  }
}

async function testTopLevelForbiddenRouteMakesZeroSpawns() {
  const { result, calls } = await driveTool({
    plannerProvider: "deepseek",
    plannerModel: "deepseek-v4-pro",
  });
  assert.equal(calls.length, 0,
    "generic preflight must not ping a forbidden profile/route before shape validation");
  assert.equal(result.details.status, "fail");
  assert.match(result.content[0].text, /FORBIDDEN_MODEL_ROUTE/);
}

async function testPlannerRoutePlaceholdersCannotOverrideExecutor() {
  process.env.FAKE_PI_COMPOSABLE_PLAN_DEFAULT_ROUTE = "1";
  try {
    const { calls } = await driveComposable({}, {
      task: "Plan and execute a tiny validation task.",
      executorProvider: "openai-codex", executorModel: "gpt-5.6-sol",
    });
    const executor = calls.find((call) => call.composablePhase === "execute");
    assert.ok(executor);
    assert.deepEqual([executor.provider, executor.model], ["openai-codex", "gpt-5.6-sol"]);
    assert.ok(calls.every((call) => call.provider !== "default" && call.model !== "default"));
  } finally {
    delete process.env.FAKE_PI_COMPOSABLE_PLAN_DEFAULT_ROUTE;
  }
}

(async () => {
  testNormalizerUnit();
  await testRuntimeAndProfileHintsCannotHijackComposedSeat();
  await testExplicitAllowedPlannerRouteReachesComposedSeat();
  await testForbiddenExplicitRoutesFailBeforeSpawn();
  await testTopLevelForbiddenRouteMakesZeroSpawns();
  await testPlannerRoutePlaceholdersCannotOverrideExecutor();
  console.log("PASS composable-pipeline-model-id: role-safe defaults/overrides, profile-hint isolation, gpt-5.5 preservation, forbidden-route rejection, and planner placeholder isolation");
})().catch((error) => {
  console.error("test-composable-pipeline-model-id: FAIL");
  console.error(error);
  process.exit(1);
});
