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
  assert.match(markdown, /out-1\.txt/, "manifest lists the planner-predicted write set");
  assert.equal(result.details?.mode, "discovery-only");
  assert.deepEqual(result.details?.predictedWriteSet, ["out-1.txt"]);
  const coderCalls = calls.filter((call) => call.agentName === "coder");
  const reviewerCalls = calls.filter((call) => call.agentName === "reviewer");
  assert.equal(coderCalls.length, 0, "discovery-only must spawn no executors");
  assert.equal(reviewerCalls.length, 0, "discovery-only must spawn no verifiers");
  assert.ok(!fs.existsSync(path.join(workDir, "out-1.txt")),
    "discovery-only must not mutate any files");
}

// ── 5. Managed run-state is transport bookkeeping, not product mutation ──
function testManagedRunStateExcludedFromObservation() {
  const ws = loadWriteSetModule();
  const dir = makeTempGitRepo();
  const runsRoot = path.join(dir, "runs-state");
  const previous = process.env.PI_ORCHESTRATOR_RUNS_ROOT;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const before = ws.captureWriteSetSnapshot(dir, ["product.txt"]);
    assert.deepEqual(before.unobservableScopes, []);

    fs.mkdirSync(path.join(runsRoot, "orc-fixture"), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, "orc-fixture", "state.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "product.txt"), "product\n");

    const after = ws.captureWriteSetSnapshot(dir, ["product.txt"]);
    const observed = ws.evaluateWriteSetObservation(before, after, ["product.txt"]);
    assert.deepEqual(observed.observed, ["product.txt"], "managed run-state checkpoints must be excluded");
    assert.deepEqual(observed.violations, []);
  } finally {
    if (previous === undefined) delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;
    else process.env.PI_ORCHESTRATOR_RUNS_ROOT = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. Matcher unit behavior ──────────────────────────────────────────────
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
    ["managed run-state is excluded from product write-set observation", () => testManagedRunStateExcludedFromObservation()],
    ["contract violation forces deterministic FAIL pre-verifier", testContractViolation],
    ["in-scope mutations PASS", testContractPass],
    ["plan exceeding contract fails pre-execution with zero executor spawns", testPreExecutionPlanViolation],
    ["discovery-only returns manifest with zero spawns and zero mutations", testDiscoveryOnly],
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
