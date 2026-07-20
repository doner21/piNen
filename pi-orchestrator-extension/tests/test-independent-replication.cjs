#!/usr/bin/env node
/**
 * WAVE3 ITEM B tests — independent-replication shape.
 * ==================================================
 * Static rules + registry discovery + fake-pi end-to-end lifecycle:
 *   - disjoint routes ⇒ PASS + "fully disjoint" diversity statement
 *   - identical executor routes ⇒ PASS + narrowed-independence caveat
 *   - lane B verifier FAIL ⇒ overall FAIL
 *   - freeze MISMATCH ⇒ zero-spawn FAIL
 *   - tamper mid-run (lane A rewrites frozen doc) ⇒ FAIL at the next deterministic check
 *   - lane-confinement instruction present in BOTH executor prompts
 *   - resume round-trip: restored LLM phase not respawned; deterministic phases re-execute
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

const SHAPE_PATH = path.join(PROJECT_ROOT, "src", "shapes", "independent-replication.ts");
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({ registerTool(def) { if (def.name === "orchestrate") tool = def; }, registerCommand() {} });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

// ── Static rules ───────────────────────────────────────────────────────────

function testStaticRules() {
  const source = fs.readFileSync(SHAPE_PATH, "utf8");
  assert.match(source, /name:\s*"independent-replication"/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.match(source, /RunStateStore/, "shape must use the run-state store");
  assert.match(source, /abortSurvival/, "shape must spawn LLM phases in abort-survivor mode");
  assert.match(source, /from "\.\.\/routes"/, "shape must import the shared route helper");
  assert.match(source, /from "\.\.\/deterministic-phase"/, "shape must import the deterministic phase primitive");
  assert.match(source, /SHAPE_CANARY:independent-replication/, "shape must include a deterministic canary branch");
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /executeCommand\s*\(/);
  assert.doesNotMatch(source, /orchestrate\s*\(/);
  assert.doesNotMatch(source, /deepseek|gpt|claude|opus|sonnet/i, "shape must not hardcode provider/model names");
  // Diversity statement must be COMPUTED (a function), never a hardcoded string.
  assert.match(source, /function computeDiversityStatement/, "diversity statement must be computed from resolved routes");
  // Lane-confinement instruction reused in both executor prompts.
  assert.match(source, /LANE CONFINEMENT/, "shape must carry a lane-confinement instruction");
}

async function testRegistryDiscovery() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ir-reg-"));
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute("t", { paradigm: "definitely-not-a-real-paradigm", preflight: false, cwd: tmp, task: "x" }, undefined, () => {}, { cwd: tmp });
    const md = result.content?.[0]?.text || result.markdown || "";
    assert.match(md, /Unknown orchestration paradigm/, "unknown paradigm must be reported");
    assert.match(md, /independent-replication/, "unknown-paradigm report must list independent-replication among available paradigms");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testCanary() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ir-canary-"));
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "SHAPE_CANARY:independent-replication",
      { paradigm: "independent-replication", preflight: false, cwd: tmp, task: "SHAPE_CANARY:independent-replication" },
      undefined, () => {}, { cwd: tmp },
    );
    const md = result.content?.[0]?.text || result.markdown || "";
    assert.match(md, /Canary: PASS/, "canary must PASS");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── End-to-end drive helper ─────────────────────────────────────────────────

async function driveShape(params, env, laneBLines) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ir-"));
  const logPath = path.join(tmp, "log.jsonl");
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: implement the counter with wrap-around.\n");
  const docPath = path.join(tmp, "gate.md");
  fs.writeFileSync(docPath, docContent);
  const reference = sha256(docContent);
  const baseDir = path.join(tmp, "replication");
  fs.mkdirSync(baseDir, { recursive: true });

  const task = [
    "Two independent implementations of the frozen gate, compared honestly.",
    `FROZEN_DOC_PATH: ${docPath}`,
    `FROZEN_DOC_SHA256: ${env && env.WRONG_HASH ? sha256(Buffer.from("something else")) : reference}`,
    `BASE_CWD: ${baseDir}`,
    ...(laneBLines || []),
  ].join("\n");

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  for (const [k, v] of Object.entries((env && env.fakePi) || {})) process.env[k] = v;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-ir",
      { task, paradigm: "independent-replication", preflight: false, cwd: tmp, maxSubagents: 12, ...params },
      undefined, () => {}, { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const markdown = result.content?.[0]?.text || result.markdown || "";
    return { result, calls, markdown, details: result.details || {}, tmp, docPath, reference, baseDir };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    for (const k of Object.keys((env && env.fakePi) || {})) delete process.env[k];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testDisjointRoutesPassFullyDisjoint() {
  const { calls, markdown, details } = await driveShape(
    { executorProvider: "aprov", executorModel: "amodel", verifierProvider: "avprov", verifierModel: "avmodel" },
    {},
    [
      "LANE_B_EXECUTOR_PROVIDER: bprov",
      "LANE_B_EXECUTOR_MODEL: bmodel",
      "LANE_B_VERIFIER_PROVIDER: bvprov",
      "LANE_B_VERIFIER_MODEL: bvmodel",
    ],
  );
  assert.equal(details.status, "pass", "disjoint lanes both PASS ⇒ overall PASS");
  assert.match(markdown, /fully disjoint/i, "diversity statement must say fully disjoint");
  // Lane A executor route honored.
  const coderA = calls.find((c) => c.agentName === "coder" && c.provider === "aprov");
  const coderB = calls.find((c) => c.agentName === "coder" && c.provider === "bprov");
  assert.ok(coderA, "lane A executor must use lane A route (aprov/amodel)");
  assert.equal(coderA.model, "amodel");
  assert.ok(coderB, "lane B executor must use lane B route (bprov/bmodel)");
  assert.equal(coderB.model, "bmodel");
  const reviewerB = calls.find((c) => c.agentName === "reviewer" && c.provider === "bvprov");
  assert.ok(reviewerB, "lane B verifier must use lane B verifier route");
}

async function testIdenticalExecutorNarrowedCaveat() {
  // No LANE_B_* overrides → lane B inherits lane A routes → shared model → narrowed caveat.
  const { markdown, details } = await driveShape(
    { executorProvider: "aprov", executorModel: "amodel", verifierProvider: "avprov", verifierModel: "avmodel" },
    {},
    [],
  );
  assert.equal(details.status, "pass", "identical-route lanes both PASS ⇒ overall PASS");
  assert.match(markdown, /narrowed/i, "diversity statement must emit the narrowed-independence caveat");
  assert.match(markdown, /shared executor model/i, "narrowed caveat must name the shared executor model");
  assert.doesNotMatch(markdown, /fully disjoint/i, "must NOT claim full disjointness when routes are shared");
}

async function testLaneBVerifierFailOverallFail() {
  const { details, markdown } = await driveShape(
    { executorProvider: "aprov", executorModel: "amodel" },
    { fakePi: { FAKE_PI_IR_LANEB_VERIFIER: "fail" } },
    [],
  );
  assert.equal(details.status, "fail", "lane B verifier FAIL ⇒ overall FAIL");
  assert.equal(details.verdictA, "pass", "lane A still passed");
  assert.equal(details.verdictB, "fail", "lane B verdict is fail");
  assert.match(markdown, /Lane B verdict:\*\* FAIL/i, "report must show lane B FAIL");
}

async function testFreezeMismatchZeroSpawn() {
  const { calls, details, markdown } = await driveShape({}, { WRONG_HASH: true }, []);
  assert.equal(details.status, "fail", "freeze mismatch must FAIL");
  assert.equal(calls.length, 0, "freeze mismatch must spawn ZERO subagents");
  assert.match(markdown, /mismatch/i, "report must explain the mismatch");
}

async function testTamperMidRunFailsAtNextDeterministicCheck() {
  const { calls, details, markdown } = await driveShape({}, { fakePi: { FAKE_PI_IR_TAMPER: "1" } }, []);
  assert.equal(details.status, "fail", "tamper mid-run must FAIL");
  const coder = calls.filter((c) => c.agentName === "coder");
  const reviewer = calls.filter((c) => c.agentName === "reviewer");
  // Lane A implement + verify spawn; tamper detected at mid-re-verify; lane B NOT run.
  assert.equal(coder.length, 1, "only lane A executor spawns before tamper is detected");
  assert.equal(reviewer.length, 1, "only lane A verifier spawns before tamper is detected");
  assert.match(markdown, /tamper/i, "report must explain the tamper detection");
  assert.match(markdown, /mid-re-verify/i, "tamper must be caught at the mid-re-verify deterministic check");
}

// ── Lane-confinement present in BOTH executor prompts (static via prompt build) ─

function testLaneConfinementInBothExecutorPrompts() {
  const jiti = makeJiti();
  const source = fs.readFileSync(SHAPE_PATH, "utf8");
  // The executor prompt builder is shared for lane A and lane B, and it always
  // includes the LANE_CONFINEMENT constant — so both prompts carry it.
  assert.match(source, /buildExecutorPrompt\(\s*["']A["']/, "lane A must use the shared executor prompt builder");
  assert.match(source, /buildExecutorPrompt\(\s*["']B["']/, "lane B must use the shared executor prompt builder");
  assert.match(source, /\$\{LANE_CONFINEMENT\}/, "the executor prompt builder must embed the lane-confinement instruction");
  // Lane B prompt additionally forbids reading lane A.
  assert.match(source, /MUST NOT read, inspect, copy, or reference the other lane/i, "lane B executor prompt must forbid reading lane A");
}

// ── Resume round-trip (direct shape.run with a pre-seeded run-state) ─────────

async function testResumeRoundTrip() {
  const jiti = makeJiti();
  const shape = jiti(SHAPE_PATH).independentReplicationShape;
  const runState = jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ir-resume-"));
  const logPath = path.join(tmp, "log.jsonl");
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: implement the counter.\n");
  const docPath = path.join(tmp, "gate.md");
  fs.writeFileSync(docPath, docContent);
  const reference = sha256(docContent);
  const baseDir = path.join(tmp, "replication");
  fs.mkdirSync(baseDir, { recursive: true });

  const task = [
    "Two independent implementations of the frozen gate.",
    `FROZEN_DOC_PATH: ${docPath}`,
    `FROZEN_DOC_SHA256: ${reference}`,
    `BASE_CWD: ${baseDir}`,
  ].join("\n");

  const runId = `test-ir-resume-${Date.now().toString(36)}`;
  const stageNames = ["freeze-verify", "implement-A", "verify-A", "mid-re-verify", "implement-B", "verify-B", "final-re-verify"];
  const store = runState.RunStateStore.create(runId, "independent-replication", task, { cwd: tmp, maxSubagents: 12 }, stageNames);
  // Pre-checkpoint implement-A (index 1) as COMPLETED — resume must NOT respawn it.
  store.checkpointPhase(1, "implement-A", {
    agentName: "coder", task: "implement-A", text: "restored lane A implementation (frozen doc untouched)",
    stderr: "", exitCode: 0, durationMs: 40, events: 4, toolCalls: { total: 0, byTool: {} },
  });
  const resumeState = runState.RunStateStore.load(runId);

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const params = {
      task, cwd: tmp, maxSubagents: 12, allowLocalModel: false,
      executorAgent: "coder", verifierAgent: "reviewer", plannerAgent: "planner",
      concurrency: 1, plannerCount: 1, verifierCount: 1,
      hardGates: "advisory", preflight: false,
      orchestrationControls: { runtimeRoles: [], rawMatches: [] },
    };
    const result = await shape.run({
      params, agents: new Map(), runId, resumeState, onUpdate: () => {},
      inferredModelRouting: {},
    });
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    // implement-A restored (not respawned); lane A verify + lane B implement/verify still spawn.
    const implA = calls.filter((c) => c.promptSnippet && c.promptSnippet.includes("EXECUTOR for LANE A"));
    assert.equal(implA.length, 0, "resume must NOT respawn the restored implement-A");
    assert.equal(result.details.status, "pass", "resumed run must complete PASS");
    assert.match(result.markdown, /DETERMINISTIC \(no LLM\)/, "deterministic phases must re-execute on resume");
    const reloaded = runState.RunStateStore.load(runId);
    assert.equal(reloaded.checkpoints.get(0).deterministic, true, "freeze-verify checkpoint carries deterministic marker");
    assert.equal(reloaded.checkpoints.get(0).outputs.sha256, reference, "freeze-verify checkpoint carries outputs.sha256");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function run() {
  testStaticRules();
  await testRegistryDiscovery();
  await testCanary();
  await testDisjointRoutesPassFullyDisjoint();
  await testIdenticalExecutorNarrowedCaveat();
  await testLaneBVerifierFailOverallFail();
  await testFreezeMismatchZeroSpawn();
  await testTamperMidRunFailsAtNextDeterministicCheck();
  testLaneConfinementInBothExecutorPrompts();
  await testResumeRoundTrip();
  console.log("PASS independent-replication: static rules, registry discovery, canary, disjoint⇒PASS+fully-disjoint, identical-executor⇒PASS+narrowed caveat, lane-B verifier FAIL⇒overall FAIL, freeze-mismatch zero-spawn, tamper mid-run⇒FAIL at mid-re-verify, lane-confinement in both executor prompts, resume round-trip");
}

run().catch((error) => { console.error("test-independent-replication: FAIL"); console.error(error); process.exit(1); });
