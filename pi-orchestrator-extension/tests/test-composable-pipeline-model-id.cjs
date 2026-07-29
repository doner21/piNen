#!/usr/bin/env node
/**
 * WAVE3 ITEM C regression — composable-pipeline malformed anthropic model id.
 * ==========================================================================
 * Bug: composed middle phases (synthesize/critique/hypothesize) constructed
 * model ids by string-munging a human label ("Claude Sonnet 4.5" →
 * "claude-sonnet-4.5", dot preserved) which 404s; and those phases were
 * unreachable by the executor/planner/verifier override params so the malformed
 * default aborted the whole run.
 *
 * These tests drive composable-pipeline's shape.run directly (so we can inject
 * an inferredModelRouting.runtimeRoles hint) and assert via the fake-pi spawn
 * log that:
 *   1. a dotted anthropic runtime-role id is spawned as a DASHED id (never a dot);
 *   2. with NO runtime-role hint, an explicit executor override reaches the
 *      composed phase (inheritance);
 *   3. a non-anthropic dotted id (gpt-5.5) passes through UNMODIFIED (no
 *      over-normalization).
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
function makeJiti() { return createJiti(__filename, { interopDefault: true, moduleCache: false }); }

const COMPOSABLE_PATH = path.join(PROJECT_ROOT, "src", "shapes", "composable-pipeline.ts");
const ALIASES_PATH = path.join(PROJECT_ROOT, "src", "model-aliases.ts");

function baseParams(tmp, extra) {
  return {
    task: "just synthesize the approach into a coherent understanding",
    cwd: tmp, maxSubagents: 12, allowLocalModel: false,
    executorAgent: "coder", verifierAgent: "reviewer", plannerAgent: "planner",
    concurrency: 1, plannerCount: 1, verifierCount: 1,
    hardGates: "advisory", preflight: false,
    orchestrationControls: { runtimeRoles: [], rawMatches: [] },
    ...extra,
  };
}

/** Drive composable-pipeline's shape.run directly with an injected routing hint. */
async function driveComposable(inferredModelRouting, extraParams) {
  const shape = makeJiti()(COMPOSABLE_PATH).composablePipelineShape;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-modelid-"));
  const logPath = path.join(tmp, "log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const result = await shape.run({
      params: baseParams(tmp, extraParams),
      agents: new Map(),
      onUpdate: () => {},
      inferredModelRouting,
    });
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { result, calls };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Pure unit checks on the normalizer (fast, hermetic) ─────────────────────

function testNormalizerUnit() {
  const { normalizeAnthropicModelId, resolveComposedPhaseModel } = makeJiti()(ALIASES_PATH);
  // Dotted anthropic id → dashed.
  assert.deepEqual(
    normalizeAnthropicModelId({ provider: "anthropic", model: "claude-sonnet-4.5" }),
    { provider: "anthropic", model: "claude-sonnet-4-5" },
    "dotted anthropic id must become dashed",
  );
  // Non-anthropic dotted id → UNCHANGED (gpt-5.5 must never be corrupted).
  assert.deepEqual(
    normalizeAnthropicModelId({ provider: "openai-codex", model: "gpt-5.5" }),
    { provider: "openai-codex", model: "gpt-5.5" },
    "gpt-5.5 must pass through unmodified",
  );
  // deepseek dotted-free id → unchanged; undefined (inherit) → undefined.
  assert.deepEqual(
    normalizeAnthropicModelId({ provider: "deepseek", model: "deepseek-v4-flash" }),
    { provider: "deepseek", model: "deepseek-v4-flash" },
  );
  assert.equal(normalizeAnthropicModelId(undefined), undefined, "inherit route stays inherit");
  // resolveComposedPhaseModel: runtime-role wins and is normalized.
  assert.deepEqual(
    resolveComposedPhaseModel({ runtimeRole: { provider: "anthropic", model: "claude-sonnet-4.5" } }),
    { provider: "anthropic", model: "claude-sonnet-4-5" },
  );
  // No runtime-role → inherit executor route first, then planner.
  assert.deepEqual(
    resolveComposedPhaseModel({ executorRoute: { provider: "exprov", model: "exmodel" }, plannerRoute: { provider: "plprov", model: "plmodel" } }),
    { provider: "exprov", model: "exmodel" },
    "executor route inherited before planner",
  );
  assert.deepEqual(
    resolveComposedPhaseModel({ plannerRoute: { provider: "plprov", model: "plmodel" } }),
    { provider: "plprov", model: "plmodel" },
    "planner route inherited when no executor route",
  );
  assert.equal(
    resolveComposedPhaseModel({}),
    undefined,
    "no routes → inherit (undefined)",
  );
}

// ── End-to-end via fake-pi spawn log ────────────────────────────────────────

async function testDottedAnthropicRuntimeRoleBecomesDashed() {
  const { calls } = await driveComposable({
    runtimeRoles: { synthesizer: { provider: "anthropic", model: "claude-sonnet-4.5" } },
  });
  const synth = calls.find((c) => c.agentName === "coder");
  assert.ok(synth, "synthesize phase must spawn the executor agent (coder)");
  assert.equal(synth.provider, "anthropic", "synthesizer spawn keeps the anthropic provider");
  assert.equal(synth.model, "claude-sonnet-4-5", "dotted anthropic id must be spawned as the dashed id");
  for (const c of calls) {
    assert.doesNotMatch(String(c.model || ""), /claude-sonnet-4\.5/, "NO spawn may carry the dotted model id");
  }
}

async function testExplicitExecutorOverrideReachesComposedPhase() {
  // No runtime-role hint → the composed phase must INHERIT the explicit executor route.
  const { calls } = await driveComposable({}, { executorProvider: "exprov", executorModel: "exmodel" });
  const synth = calls.find((c) => c.agentName === "coder");
  assert.ok(synth, "synthesize phase must spawn the executor agent (coder)");
  assert.equal(synth.provider, "exprov", "composed phase must inherit the explicit executor provider");
  assert.equal(synth.model, "exmodel", "composed phase must inherit the explicit executor model");
}

async function testGpt55PassesThroughUnmodified() {
  const { calls } = await driveComposable({
    runtimeRoles: { synthesizer: { provider: "openai-codex", model: "gpt-5.5" } },
  });
  const synth = calls.find((c) => c.agentName === "coder");
  assert.ok(synth, "synthesize phase must spawn the executor agent (coder)");
  assert.equal(synth.provider, "openai-codex", "gpt-5.5 provider preserved");
  assert.equal(synth.model, "gpt-5.5", "gpt-5.5 must NOT be over-normalized (dot preserved)");
}

async function testPlannerDefaultRoutePlaceholderInheritsExplicitExecutorRoute() {
  process.env.FAKE_PI_COMPOSABLE_PLAN_DEFAULT_ROUTE = "1";
  try {
    const { calls } = await driveComposable({}, {
      task: "Plan and execute a tiny validation task.",
      executorProvider: "deepseek",
      executorModel: "deepseek-v4-pro",
    });
    const executor = calls.find((c) => c.agentName === "coder");
    assert.ok(executor, "execute phase must spawn the executor agent (coder)");
    assert.equal(executor.provider, "deepseek", "planner provider=default must inherit the explicit executor provider");
    assert.equal(executor.model, "deepseek-v4-pro", "planner model=default must inherit the explicit executor model");
    assert.ok(calls.every((c) => c.provider !== "default"), "no child may receive literal provider=default");
    assert.ok(calls.every((c) => c.model !== "default"), "no child may receive literal model=default");
  } finally {
    delete process.env.FAKE_PI_COMPOSABLE_PLAN_DEFAULT_ROUTE;
  }
}

async function run() {
  testNormalizerUnit();
  await testDottedAnthropicRuntimeRoleBecomesDashed();
  await testExplicitExecutorOverrideReachesComposedPhase();
  await testGpt55PassesThroughUnmodified();
  await testPlannerDefaultRoutePlaceholderInheritsExplicitExecutorRoute();
  console.log("PASS composable-pipeline-model-id: normalizer unit, composed-phase inheritance, gpt-5.5 preservation, and planner default-route placeholders inherit explicit executor routing");
}

run().catch((error) => { console.error("test-composable-pipeline-model-id: FAIL"); console.error(error); process.exit(1); });
