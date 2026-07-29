#!/usr/bin/env node
/**
 * Predicted-write-set enforcement fixtures (predict-then-write)
 * =============================================================
 * Implements the deterministic side of the AGENTS.md "Discovery before
 * mutation" policy:
 *
 * 1. Contract violation (post-execution): executor mutates a file outside
 *    the contract-granted write set → deterministic FAIL naming the file,
 *    BEFORE any verifier spawn.
 * 2. Contract pass: all mutations inside the granted set → PASS, evidence
 *    summary records the enforcement.
 * 3. Pre-execution satisfiability: planner-declared predicted_write_set
 *    exceeds the contracted scope → FAIL before ANY executor spawns.
 * 4. Discovery-only mode: planning happens, manifest is returned, zero
 *    executor/verifier spawns, zero file mutations.
 * 5. Matcher unit behavior: exact / dir-prefix / glob / normalization.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

function loadWriteSetModule() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  return jiti(path.join(PROJECT_ROOT, "src", "write-set.ts"));
}

const SCENARIO_ENV_KEYS = [
  "FAKE_PI_PLAN_STYLE",
  "FAKE_PI_EXECUTOR_STYLE",
  "FAKE_PI_VERIFIER_SEQUENCE",
  "FAKE_PI_VERIFIER_STATUS",
  "FAKE_PI_DISCOVERY_PLANNER_MUTATING",
];

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orchestrate-write-set-"));
  const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", windowsHide: true });
  assert.equal(init.status, 0, `git init should succeed: ${init.stderr}`);
  return dir;
}

async function runScenario(task, { env = {}, params = {}, cwd } = {}) {
  const workDir = cwd ?? makeTempGitRepo();
  const logPath = path.join(workDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  for (const key of SCENARIO_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-write-set-enforcement",
      { task, cwd: workDir, ...params },
      undefined,
      () => {},
      { cwd: workDir },
    );
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim() : "";
    const calls = logText ? logText.split("\n").map((line) => JSON.parse(line)) : [];
    return { result, calls, workDir };
  } finally {
    for (const key of SCENARIO_ENV_KEYS) delete process.env[key];
  }
}

// ── 1. Contract violation → deterministic FAIL before verifier spawn ──────
async function testContractViolation() {
  const { result, calls } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0, predictedWriteSet: "allowed-only.txt" },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  assert.match(markdown, /# Orchestration Result: FAIL/,
    "mutation outside the contracted write set must force FAIL");
  assert.match(markdown, /WRITE_SET_VIOLATION: "out-1\.txt"/,
    "the violating file must be named mechanically in the failure reasons");
  const reviewerCalls = calls.filter((call) => call.agentName === "reviewer");
  assert.equal(reviewerCalls.length, 0,
    "write-set violation must fail BEFORE any verifier subagent spawns");
  const coderCalls = calls.filter((call) => call.agentName === "coder");
  assert.equal(coderCalls.length, 1, "exactly one executor spawn expected");
}

// ── 2. Contract pass: mutations inside the set → PASS ─────────────────────
async function testContractPass() {
  const { result, workDir } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0, predictedWriteSet: "out-1.txt, fake-pi-log.jsonl" },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  assert.match(markdown, /# Orchestration Result: PASS/,
    "in-scope mutations must not trip write-set enforcement");
  assert.ok(fs.existsSync(path.join(workDir, "out-1.txt")), "fixture artifact should exist on disk");
}

// ── 3. Pre-execution: plan exceeds contract → FAIL with zero executors ────
async function testPreExecutionPlanViolation() {
  const { result, calls } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1-ws", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0, predictedWriteSet: "docs/" },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  assert.match(markdown, /# Orchestration Result: FAIL/,
    "a plan predicting out-of-contract mutations must FAIL");
  assert.match(markdown, /WRITE_SET_VIOLATION \(pre-execution\)/,
    "the failure must be classified as pre-execution");
  const coderCalls = calls.filter((call) => call.agentName === "coder");
  assert.equal(coderCalls.length, 0,
    "pre-execution write-set failure must spawn ZERO executors (contradiction costs a re-plan, not a mutation)");
  const reviewerCalls = calls.filter((call) => call.agentName === "reviewer");
  assert.equal(reviewerCalls.length, 0, "no verifier spawns either");
}

// ── 4. Discovery-only: manifest returned, nothing spawned or mutated ──────
async function testDiscoveryOnly() {
  const { result, calls, workDir } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1-ws", FAKE_PI_EXECUTOR_STYLE: "write-summary-table" },
      params: { maxRetries: 0, discoveryOnly: true },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  assert.match(markdown, /# Discovery manifest/, "discovery-only mode returns a manifest");
  assert.match(markdown, /no project mutations/, "manifest makes the scoped no-project-mutation claim");
  assert.doesNotMatch(markdown, /mutated no files/, "manifest must not claim the orchestration wrote no runtime files");
  assert.match(markdown, /out-1\.txt/, "manifest lists the planner-predicted write set");
  assert.equal(result.details?.mode, "discovery-only");
  assert.deepEqual(result.details?.predictedWriteSet, ["out-1.txt"]);
  const plannerCalls = calls.filter((call) => call.agentName === "planner");
  const coderCalls = calls.filter((call) => call.agentName === "coder");
  const reviewerCalls = calls.filter((call) => call.agentName === "reviewer");
  assert.equal(plannerCalls.length, 1, "discovery-only should spawn exactly one planner");
  assert.equal(plannerCalls[0].tools, "read,grep,find,ls",
    "PEV discovery planner must receive the explicit read-only tool allowlist");
  assert.equal(plannerCalls[0].noTools, false);
  assert.equal(coderCalls.length, 0, "discovery-only must spawn no executors");
  assert.equal(reviewerCalls.length, 0, "discovery-only must spawn no verifiers");
  assert.ok(!fs.existsSync(path.join(workDir, "out-1.txt")),
    "discovery-only must not mutate any files");
}

async function testDiscoveryPreflightSkipsUnusedRoutes() {
  const pev = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: { FAKE_PI_PLAN_STYLE: "impl-1-ws" },
      params: {
        maxRetries: 0,
        discoveryOnly: true,
        preflight: true,
        plannerProvider: "fixtureprov",
        plannerModel: "fixture-model",
        executorProvider: "badprov",
        executorModel: "unused-bad-executor",
        verifierProvider: "badprov",
        verifierModel: "unused-bad-verifier",
      },
    },
  );
  assert.equal(pev.result.details?.mode, "discovery-only",
    "PEV discovery should proceed when only unused executor/verifier routes are unhealthy");
  assert.ok(!pev.calls.some((call) => call.provider === "badprov"),
    "PEV discovery preflight must not ping unused executor/verifier routes");

  const dual = await runScenario("Inspect and propose the bounded fixture change.", {
    params: {
      paradigm: "dual-plan-synthesis-execute-verify",
      discoveryOnly: true,
      preflight: true,
      plannerProvider: "badprov",
      plannerModel: "unused-configured-planner",
      executorProvider: "badprov",
      executorModel: "unused-configured-executor",
      verifierProvider: "badprov",
      verifierModel: "unused-configured-verifier",
    },
  });
  assert.equal(dual.result.details?.mode, "discovery-only",
    "dual-plan discovery should preflight and run its fixed planner/synthesis routes");
  assert.ok(!dual.calls.some((call) => call.provider === "badprov"),
    "dual-plan discovery preflight must not ping configured routes unused by its discovery phases");
  const dualProviders = new Set(dual.calls.map((call) => call.provider).filter(Boolean));
  assert.ok(dualProviders.has("deepseek") && dualProviders.has("openai-codex"),
    "dual-plan discovery should preflight/spawn the exact fixed planner and synthesis providers");
}

async function testDiscoveryMutationTelemetryFailsClosed() {
  const { result, calls } = await runScenario(
    "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
    {
      env: {
        FAKE_PI_PLAN_STYLE: "impl-1-ws",
        FAKE_PI_DISCOVERY_PLANNER_MUTATING: "1",
      },
      params: { maxRetries: 0, discoveryOnly: true, preflight: false },
    },
  );
  const markdown = result.content?.[0]?.text || "";
  assert.match(markdown, /DISCOVERY_ONLY_MUTATION_DETECTED/,
    "mutating planner telemetry must abort discovery before a manifest is returned");
  assert.equal(calls.filter((call) => call.agentName === "planner").length, 1);
  assert.equal(calls.filter((call) => call.agentName === "coder").length, 0);
  assert.equal(calls.filter((call) => call.agentName === "reviewer").length, 0);
}

async function testUnsupportedControlsFailBeforePreflight() {
  const baseParams = {
    preflight: true,
    plannerProvider: "badprov",
    plannerModel: "bad-model",
    maxRetries: 0,
  };
  const scenarios = [
    {
      label: "custom-shape discovery",
      params: { ...baseParams, paradigm: "composable-pipeline", discoveryOnly: true },
      token: /DISCOVERY_ONLY_UNSUPPORTED_PARADIGM/,
    },
    {
      label: "custom-shape write set",
      params: { ...baseParams, paradigm: "composable-pipeline", predictedWriteSet: "out-1.txt" },
      token: /PREDICTED_WRITE_SET_UNSUPPORTED_PARADIGM/,
    },
    {
      label: "dual-plan execution write set",
      params: { ...baseParams, paradigm: "dual-plan-synthesis-execute-verify", predictedWriteSet: "out-1.txt" },
      token: /PREDICTED_WRITE_SET_UNSUPPORTED_PARADIGM/,
    },
  ];

  for (const scenario of scenarios) {
    const { result, calls } = await runScenario("Fixture control-scope check.", { params: scenario.params });
    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, scenario.token, `${scenario.label} must return the stable error token`);
    assert.equal(calls.length, 0, `${scenario.label} must fail before provider preflight or any role spawn`);
  }
}

async function testCommaSeparatedAgentProfileToolsLoad() {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orchestrate-agent-profile-"));
  const agentsDir = path.join(agentRoot, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "planner.json"), JSON.stringify({
    name: "planner",
    systemPrompt: "Fixture planner profile.",
    tools: "read,bash,grep",
  }), "utf8");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    const { calls } = await runScenario(
      "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
      {
        env: { FAKE_PI_PLAN_STYLE: "impl-1", FAKE_PI_EXECUTOR_STYLE: "claims-no-write" },
        params: { maxRetries: 0, preflight: false },
      },
    );
    const plannerCall = calls.find((call) => call.agentName === "planner");
    assert.ok(plannerCall, "planner profile fixture must be loaded");
    assert.equal(plannerCall.tools, "read,bash,grep",
      "comma-separated JSON profile tools must reach the Pi child CLI");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
}

// ── 5. Matcher unit behavior ──────────────────────────────────────────────
function testMatcherUnits() {
  const ws = loadWriteSetModule();

  // Exact, case-insensitive, separator-normalized.
  assert.ok(ws.fileMatchesWriteSet("docs\\A.md", ["docs/a.md"]), "backslash + case normalization");
  assert.ok(!ws.fileMatchesWriteSet("docs/b.md", ["docs/a.md"]), "exact entries do not cover siblings");

  // Directory prefix.
  assert.ok(ws.fileMatchesWriteSet("docs/sub/deep.md", ["docs/"]), "dir prefix covers nested files");
  assert.ok(!ws.fileMatchesWriteSet("docs2/x.md", ["docs/"]), "dir prefix must not cover lookalike dirs");

  // Globs: * stays in one segment, ** crosses segments.
  assert.ok(ws.fileMatchesWriteSet("tools/a.mjs", ["tools/*.mjs"]), "single-segment glob");
  assert.ok(!ws.fileMatchesWriteSet("tools/sub/a.mjs", ["tools/*.mjs"]), "* must not cross segments");
  assert.ok(ws.fileMatchesWriteSet("runs/sub/a.json", ["runs/**"]), "** crosses segments");

  // Input parsing: string with commas/newlines, arrays, dedupe.
  assert.deepEqual(ws.parseWriteSetInput("a.txt, b.txt\na.txt"), ["a.txt", "b.txt"]);
  assert.deepEqual(ws.parseWriteSetInput(["./c.txt", "d\\e.txt"]), ["c.txt", "d/e.txt"]);
  assert.equal(ws.parseWriteSetInput("  ,\n"), undefined, "empty input parses to undefined");
  assert.throws(() => ws.parseWriteSetInput("../outside.txt"),
    /WRITE_SET_INVALID_ENTRY/, "leading parent traversal must be rejected");
  assert.throws(() => ws.parseWriteSetInput("docs/../outside.txt"),
    /WRITE_SET_INVALID_ENTRY/, "embedded parent traversal must be rejected");
  assert.deepEqual(ws.parseWriteSetInput("docs/name..txt"), ["docs/name..txt"],
    "non-segment double dots remain valid");
  const absoluteWithTraversal = `${path.resolve(os.tmpdir()).replace(/\\/g, "/")}/allowed-root/../outside.txt`;
  assert.deepEqual(ws.parseWriteSetInput(absoluteWithTraversal), [absoluteWithTraversal],
    "absolute external entries remain supported even when the OS resolves a parent segment later");

  // Evaluation: violations + unobservable tasks.
  const evaluation = ws.evaluateWriteSet(
    [
      { taskId: "task-1", filesChanged: 2, changedFiles: ["docs/a.md", "rogue.txt"] },
      { taskId: "task-2" },
    ],
    ["docs/"],
  );
  assert.deepEqual(evaluation.violations, ["rogue.txt"]);
  assert.deepEqual(evaluation.unobservableTasks, ["task-2"]);

  // Pre-execution containment: identical dir/glob grants are in scope.
  assert.deepEqual(ws.planEntriesOutsideContract(["docs/a.md", "docs/"], ["docs/"]), []);
  assert.deepEqual(ws.planEntriesOutsideContract(["src/x.ts"], ["docs/"]), ["src/x.ts"]);
}

(async function main() {
  const suites = [
    ["matcher units", () => testMatcherUnits()],
    ["contract violation forces deterministic FAIL pre-verifier", testContractViolation],
    ["in-scope mutations PASS", testContractPass],
    ["plan exceeding contract fails pre-execution with zero executor spawns", testPreExecutionPlanViolation],
    ["discovery-only returns a read-only manifest with zero execution spawns", testDiscoveryOnly],
    ["discovery preflight skips unused executor/verifier routes", testDiscoveryPreflightSkipsUnusedRoutes],
    ["discovery-only mutating planner telemetry fails closed", testDiscoveryMutationTelemetryFailsClosed],
    ["unsupported optional controls fail before preflight", testUnsupportedControlsFailBeforePreflight],
    ["comma-separated agent profile tools load", testCommaSeparatedAgentProfileToolsLoad],
  ];
  for (const [name, fn] of suites) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log("test-write-set-enforcement: all scenarios passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
