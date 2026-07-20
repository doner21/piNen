#!/usr/bin/env node
/**
 * Item B tests — frozen-gate-fix-loop shape.
 * ==========================================
 * Static rules + registry discovery + fake-pi end-to-end lifecycle:
 *   - happy lifecycle (freeze-verify → bounded-fix → re-verify → verifier PASS)
 *   - freeze MISMATCH at phase 1 ⇒ status:fail with ZERO subagent spawns
 *   - tamper between phases ⇒ automatic FAIL at phase 3, no verifier spawn
 *   - verifier fail → retry loop → second verifier PASS ends the run
 *   - route overrides change spawn routing AND the Routes line (no hardcoded models)
 *   - resume round-trip: a restored LLM phase is not respawned; deterministic
 *     phases re-execute; the run completes.
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

const SHAPE_PATH = path.join(PROJECT_ROOT, "src", "shapes", "frozen-gate-fix-loop.ts");
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
  assert.match(source, /name:\s*"frozen-gate-fix-loop"/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.match(source, /RunStateStore/, "shape must use the run-state store");
  assert.match(source, /abortSurvival/, "shape must spawn LLM phases in abort-survivor mode");
  assert.match(source, /from "\.\.\/routes"/, "shape must import the shared route helper");
  assert.match(source, /from "\.\.\/deterministic-phase"/, "shape must import the deterministic phase primitive");
  assert.match(source, /SHAPE_CANARY:frozen-gate-fix-loop/, "shape must include a deterministic canary branch");
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /agent_reload_runtime\s*\(/);
  assert.doesNotMatch(source, /agent_scheduler\s*\(/);
  assert.doesNotMatch(source, /executeCommand\s*\(/);
  assert.doesNotMatch(source, /sendUserMessage\s*\(/);
  assert.doesNotMatch(source, /orchestrate\s*\(/);
  assert.doesNotMatch(source, /deepseek|gpt|claude|opus|sonnet/i, "shape must not hardcode provider/model names");
}

async function testRegistryDiscovery() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-reg-"));
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute("t", { paradigm: "definitely-not-a-real-paradigm", preflight: false, cwd: tmp, task: "x" }, undefined, () => {}, { cwd: tmp });
    const md = result.content?.[0]?.text || result.markdown || "";
    assert.match(md, /Unknown orchestration paradigm/, "unknown paradigm must be reported");
    assert.match(md, /frozen-gate-fix-loop/, "unknown-paradigm report must list frozen-gate-fix-loop among available paradigms");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testCanary() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-canary-"));
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "SHAPE_CANARY:frozen-gate-fix-loop",
      { paradigm: "frozen-gate-fix-loop", preflight: false, cwd: tmp, task: "SHAPE_CANARY:frozen-gate-fix-loop" },
      undefined, () => {}, { cwd: tmp },
    );
    const md = result.content?.[0]?.text || result.markdown || "";
    assert.match(md, /Canary: PASS/, "canary must PASS");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── End-to-end drive helper ─────────────────────────────────────────────────

async function driveShape(taskExtra, params, env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-"));
  const logPath = path.join(tmp, "log.jsonl");
  // Frozen gate doc lives in the temp cwd; its sha256 is the reference.
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: all findings resolved.\n");
  const docPath = path.join(tmp, "gate.md");
  fs.writeFileSync(docPath, docContent);
  const reference = sha256(docContent);
  const task = [
    "Bounded fix of the existing implementation against the frozen gate.",
    `FROZEN_DOC_PATH: ${docPath}`,
    `FROZEN_DOC_SHA256: ${env && env.WRONG_HASH ? sha256(Buffer.from("something else")) : reference}`,
    "FINDINGS:",
    "- residual finding 1: fix the off-by-one in the counter",
    "- residual finding 2: correct the error message text",
    taskExtra || "",
  ].filter(Boolean).join("\n");

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  for (const [k, v] of Object.entries((env && env.fakePi) || {})) process.env[k] = v;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-fgfl",
      { task, paradigm: "frozen-gate-fix-loop", preflight: false, cwd: tmp, maxSubagents: 12, ...params },
      undefined, () => {}, { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const markdown = result.content?.[0]?.text || result.markdown || "";
    const details = result.details || {};
    return { result, calls, markdown, details, tmp, docPath, reference };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    for (const k of Object.keys((env && env.fakePi) || {})) delete process.env[k];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Drive the shape where the task body carries ONLY a SPEC_FILE reference and the
// frozen-gate coordinates + findings live inside that referenced spec file. This
// exercises the spec-file-preferred input path (WAVE2-SPEC ITEM B).
async function driveShapeSpecFileOnly(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-spec-"));
  const logPath = path.join(tmp, "log.jsonl");
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: all findings resolved.\n");
  const docPath = path.join(tmp, "gate.md");
  fs.writeFileSync(docPath, docContent);
  const reference = sha256(docContent);

  // The spec/residuals file holds the authoritative labeled inputs.
  const specPath = path.join(tmp, "residuals.spec.md");
  const badSpec = env && env.INVALID_SPEC;
  if (!(env && env.MISSING_SPEC)) {
    fs.writeFileSync(
      specPath,
      badSpec
        ? "# Residuals\n(No labeled gate coordinates here.)\n"
        : [
            "# Residuals / Frozen Gate Spec (authoritative)",
            `FROZEN_DOC_PATH: ${docPath}`,
            `FROZEN_DOC_SHA256: ${reference}`,
            "FINDINGS:",
            "- residual finding 1: fix the off-by-one in the counter",
            "- residual finding 2: correct the error message text",
          ].join("\n"),
    );
  }

  // Task body references ONLY the spec file — no inline gate coordinates.
  const task = [
    "Bounded fix of the existing implementation against the frozen gate.",
    `SPEC_FILE: ${specPath}`,
  ].join("\n");

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-fgfl-spec",
      { task, paradigm: "frozen-gate-fix-loop", preflight: false, cwd: tmp, maxSubagents: 12 },
      undefined, () => {}, { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const markdown = result.content?.[0]?.text || result.markdown || "";
    return { calls, markdown, details: result.details || {} };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testSpecFileOnlyHappyLifecycle() {
  const { calls, markdown, details } = await driveShapeSpecFileOnly({});
  assert.equal(details.status, "pass", "spec-file-only inputs must reach the happy lifecycle and PASS");
  const coder = calls.filter((c) => c.agentName === "coder");
  const reviewer = calls.filter((c) => c.agentName === "reviewer");
  assert.equal(coder.length, 1, "exactly one bounded-fix (coder) spawn on the spec-file happy path");
  assert.equal(reviewer.length, 1, "exactly one verify (reviewer) spawn on the spec-file happy path");
  assert.match(markdown, /DETERMINISTIC \(no LLM\)/, "report must tag deterministic phases");
}

async function testSpecFileMissingOrInvalidZeroSpawn() {
  // Spec file referenced but missing ⇒ no inputs resolvable ⇒ zero-spawn FAIL.
  const missing = await driveShapeSpecFileOnly({ MISSING_SPEC: true });
  assert.equal(missing.details.status, "fail", "missing spec file must FAIL");
  assert.equal(missing.calls.length, 0, "missing spec file must spawn ZERO subagents");
  // Spec file present but with no gate labels ⇒ still zero-spawn FAIL.
  const invalid = await driveShapeSpecFileOnly({ INVALID_SPEC: true });
  assert.equal(invalid.details.status, "fail", "invalid spec file must FAIL");
  assert.equal(invalid.calls.length, 0, "invalid spec file must spawn ZERO subagents");
}

async function testHappyLifecycle() {
  const { calls, markdown, details } = await driveShape("", {});
  assert.equal(details.status, "pass", "happy lifecycle must PASS");
  const coder = calls.filter((c) => c.agentName === "coder");
  const reviewer = calls.filter((c) => c.agentName === "reviewer");
  assert.equal(coder.length, 1, "exactly one bounded-fix (coder) spawn on happy path");
  assert.equal(reviewer.length, 1, "exactly one verify (reviewer) spawn on happy path");
  assert.match(markdown, /DETERMINISTIC \(no LLM\)/, "report must tag deterministic phases");
  assert.match(markdown, /freeze-verify/, "report must include freeze-verify phase");
  assert.match(markdown, /re-verify-freeze-1/, "report must include re-verify-freeze phase");
}

async function testFreezeMismatchZeroSpawn() {
  const { calls, markdown, details } = await driveShape("", {}, { WRONG_HASH: true });
  assert.equal(details.status, "fail", "freeze mismatch must FAIL");
  assert.equal(calls.length, 0, "freeze mismatch must spawn ZERO subagents");
  assert.match(markdown, /mismatch/i, "report must explain the mismatch");
  assert.match(markdown, /DETERMINISTIC \(no LLM\)/, "report must show the deterministic freeze-verify");
}

async function testTamperBetweenPhases() {
  const { calls, details, markdown } = await driveShape("", {}, { fakePi: { FAKE_PI_FGFL_TAMPER: "1" } });
  assert.equal(details.status, "fail", "tamper between phases must FAIL");
  const coder = calls.filter((c) => c.agentName === "coder");
  const reviewer = calls.filter((c) => c.agentName === "reviewer");
  assert.equal(coder.length, 1, "bounded-fix spawns once before tamper is detected");
  assert.equal(reviewer.length, 0, "NO verifier spawn on the tampered attempt");
  assert.match(markdown, /tamper/i, "report must explain the tamper detection");
}

async function testRetryThenPass() {
  const { calls, details } = await driveShape("", {}, { fakePi: { FAKE_PI_FGFL_VERIFIER_SEQUENCE: "fail,pass" } });
  assert.equal(details.status, "pass", "retry loop must end PASS on second verifier");
  const reviewer = calls.filter((c) => c.agentName === "reviewer");
  const coder = calls.filter((c) => c.agentName === "coder");
  assert.equal(reviewer.length, 2, "exactly two verifier spawns (fail then pass)");
  assert.equal(coder.length, 2, "exactly two bounded-fix spawns (one per attempt)");
}

async function testRouteOverride() {
  const { calls, markdown } = await driveShape("", {
    executorProvider: "exprov", executorModel: "exmodel",
    verifierProvider: "vprov", verifierModel: "vmodel",
  });
  const coder = calls.find((c) => c.agentName === "coder");
  const reviewer = calls.find((c) => c.agentName === "reviewer");
  assert.ok(coder && reviewer, "must spawn coder + reviewer");
  assert.equal(coder.provider, "exprov");
  assert.equal(coder.model, "exmodel");
  assert.equal(reviewer.provider, "vprov");
  assert.equal(reviewer.model, "vmodel");
  assert.match(markdown, /\*\*Routes:\*\* Executor=exprov\/exmodel Verifier=vprov\/vmodel/, "Routes line must reflect overrides");
}

// ── Resume round-trip (direct shape.run with a pre-seeded run-state) ─────────

async function testResumeRoundTrip() {
  const jiti = makeJiti();
  const shapeMod = jiti(SHAPE_PATH);
  const runState = jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));
  const shape = shapeMod.frozenGateFixLoopShape;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-resume-"));
  const logPath = path.join(tmp, "log.jsonl");
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: all findings resolved.\n");
  const docPath = path.join(tmp, "gate.md");
  fs.writeFileSync(docPath, docContent);
  const reference = sha256(docContent);
  const task = [
    "Bounded fix against frozen gate.",
    `FROZEN_DOC_PATH: ${docPath}`,
    `FROZEN_DOC_SHA256: ${reference}`,
    "FINDINGS:",
    "- residual finding 1",
  ].join("\n");

  const runId = `test-fgfl-resume-${Date.now().toString(36)}`;
  // Stage names must mirror the shape's allocation for maxAttempts=3.
  const stageNames = ["freeze-verify"];
  for (let k = 1; k <= 3; k++) stageNames.push(`bounded-fix-${k}`, `re-verify-freeze-${k}`, `verify-${k}`);
  const store = runState.RunStateStore.create(runId, "frozen-gate-fix-loop", task, { cwd: tmp, maxSubagents: 12, maxRetries: 2 }, stageNames);
  // Pre-checkpoint bounded-fix-1 as completed (index 1) — resume must NOT respawn it.
  store.checkpointPhase(1, "bounded-fix-1", {
    agentName: "coder", task: "bounded-fix-1", text: "restored bounded fix (no frozen doc change)",
    stderr: "", exitCode: 0, durationMs: 42, events: 4, toolCalls: { total: 0, byTool: {} },
  });
  const resumeState = runState.RunStateStore.load(runId);

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const params = {
      task, cwd: tmp, maxSubagents: 12, maxRetries: 2, allowLocalModel: false,
      executorAgent: "coder", verifierAgent: "reviewer",
      plannerAgent: "planner", concurrency: 1, plannerCount: 1, verifierCount: 1,
      maxRetriesExplicit: true, maxSubagentsExplicit: true, hardGates: "advisory", preflight: false,
      orchestrationControls: { runtimeRoles: [], rawMatches: [] },
    };
    const result = await shape.run({
      params, agents: new Map(), runId, resumeState, onUpdate: () => {},
      inferredModelRouting: {},
    });
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const coder = calls.filter((c) => c.agentName === "coder");
    const reviewer = calls.filter((c) => c.agentName === "reviewer");
    assert.equal(coder.length, 0, "resume must NOT respawn the restored bounded-fix-1 (coder)");
    assert.equal(reviewer.length, 1, "resume must still spawn the verifier");
    assert.equal(result.details.status, "pass", "resumed run must complete PASS");
    assert.match(result.markdown, /DETERMINISTIC \(no LLM\)/, "deterministic phases must re-execute on resume");
    // Deterministic phases were re-executed and re-checkpointed.
    const reloaded = runState.RunStateStore.load(runId);
    assert.equal(reloaded.checkpoints.get(0).deterministic, true, "freeze-verify checkpoint must carry deterministic marker");
    assert.equal(reloaded.checkpoints.get(0).outputs.sha256, reference, "freeze-verify checkpoint must carry outputs.sha256");
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
  await testHappyLifecycle();
  await testSpecFileOnlyHappyLifecycle();
  await testSpecFileMissingOrInvalidZeroSpawn();
  await testFreezeMismatchZeroSpawn();
  await testTamperBetweenPhases();
  await testRetryThenPass();
  await testRouteOverride();
  await testResumeRoundTrip();
  console.log("PASS frozen-gate-fix-loop: static rules, registry discovery, canary, happy lifecycle, spec-file-only lifecycle, spec-file missing/invalid zero-spawn, freeze-mismatch zero-spawn, tamper FAIL, retry→pass, route override, resume round-trip");
}

run().catch((error) => { console.error("test-frozen-gate-fix-loop: FAIL"); console.error(error); process.exit(1); });
