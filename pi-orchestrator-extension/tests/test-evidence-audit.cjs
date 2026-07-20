#!/usr/bin/env node
/**
 * WAVE3 ITEM A tests — evidence-audit shape.
 * ==========================================
 * Static rules + registry discovery + fake-pi end-to-end lifecycle:
 *   - happy PASS (freeze-verify → evidence-manifest → integrity-audit → final-re-verify)
 *   - freeze MISMATCH at phase 1 ⇒ status:fail with ZERO subagent spawns
 *   - missing evidence file ⇒ status:fail with ZERO subagent spawns (manifest fail-closed)
 *   - verifier fail-closed on unparseable output
 *   - route override changes the verifier spawn AND the Routes line
 *   - checkpoint carries the manifest + resolved routes
 *   - resume round-trip: restored verifier not respawned; deterministic phases re-execute
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

const SHAPE_PATH = path.join(PROJECT_ROOT, "src", "shapes", "evidence-audit.ts");
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
  assert.match(source, /name:\s*"evidence-audit"/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.match(source, /RunStateStore/, "shape must use the run-state store");
  assert.match(source, /abortSurvival/, "shape must spawn LLM phases in abort-survivor mode");
  assert.match(source, /from "\.\.\/routes"/, "shape must import the shared route helper");
  assert.match(source, /from "\.\.\/deterministic-phase"/, "shape must import the deterministic phase primitive");
  assert.match(source, /SHAPE_CANARY:evidence-audit/, "shape must include a deterministic canary branch");
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /executeCommand\s*\(/);
  assert.doesNotMatch(source, /orchestrate\s*\(/);
  assert.doesNotMatch(source, /deepseek|gpt|claude|opus|sonnet/i, "shape must not hardcode provider/model names");
}

async function testRegistryDiscovery() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ea-reg-"));
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute("t", { paradigm: "definitely-not-a-real-paradigm", preflight: false, cwd: tmp, task: "x" }, undefined, () => {}, { cwd: tmp });
    const md = result.content?.[0]?.text || result.markdown || "";
    assert.match(md, /Unknown orchestration paradigm/, "unknown paradigm must be reported");
    assert.match(md, /evidence-audit/, "unknown-paradigm report must list evidence-audit among available paradigms");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testCanary() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ea-canary-"));
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "SHAPE_CANARY:evidence-audit",
      { paradigm: "evidence-audit", preflight: false, cwd: tmp, task: "SHAPE_CANARY:evidence-audit" },
      undefined, () => {}, { cwd: tmp },
    );
    const md = result.content?.[0]?.text || result.markdown || "";
    assert.match(md, /Canary: PASS/, "canary must PASS");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── End-to-end drive helper ─────────────────────────────────────────────────

async function driveShape(params, env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ea-"));
  const logPath = path.join(tmp, "log.jsonl");
  // Frozen gate doc + a completed-run evidence directory with gate-evidence files.
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: all findings resolved.\n");
  const docPath = path.join(tmp, "gate.md");
  fs.writeFileSync(docPath, docContent);
  const reference = sha256(docContent);

  const evidenceDir = path.join(tmp, "completed-run");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "gate-metrics.json"), JSON.stringify({ runId: "run-xyz", pass: true }));
  fs.writeFileSync(path.join(evidenceDir, "verify.log"), "run-xyz verification OK\n");

  const evidenceFilesLine = (env && env.MISSING_EVIDENCE_FILE)
    ? ["GATE_EVIDENCE_FILES:", "- gate-metrics.json", "- does-not-exist.json"].join("\n")
    : ["GATE_EVIDENCE_FILES:", "- gate-metrics.json", "- verify.log"].join("\n");

  const task = [
    "Audit the completed run's evidence against the frozen gate.",
    `FROZEN_DOC_PATH: ${docPath}`,
    `FROZEN_DOC_SHA256: ${env && env.WRONG_HASH ? sha256(Buffer.from("something else")) : reference}`,
    `EVIDENCE_CWD: ${evidenceDir}`,
    "RUN_ID_LABEL: run-xyz",
    "AUDIT_FOCUS: confirm run-id binding and recomputable gate metrics",
    evidenceFilesLine,
  ].join("\n");

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  for (const [k, v] of Object.entries((env && env.fakePi) || {})) process.env[k] = v;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-ea",
      { task, paradigm: "evidence-audit", preflight: false, cwd: tmp, maxSubagents: 12, ...params },
      undefined, () => {}, { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const markdown = result.content?.[0]?.text || result.markdown || "";
    return { result, calls, markdown, details: result.details || {}, tmp, docPath, reference, evidenceDir };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    for (const k of Object.keys((env && env.fakePi) || {})) delete process.env[k];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testHappyPass() {
  const { calls, markdown, details } = await driveShape({}, {});
  assert.equal(details.status, "pass", "happy audit must PASS");
  const reviewer = calls.filter((c) => c.agentName === "reviewer");
  const coder = calls.filter((c) => c.agentName === "coder");
  assert.equal(reviewer.length, 1, "exactly one verifier (reviewer) spawn");
  assert.equal(coder.length, 0, "evidence-audit must spawn ZERO executors");
  assert.match(markdown, /DETERMINISTIC \(no LLM\)/, "report must tag deterministic phases");
  assert.match(markdown, /freeze-verify/, "report must include freeze-verify");
  assert.match(markdown, /evidence-manifest/, "report must include evidence-manifest");
  assert.match(markdown, /final-re-verify/, "report must include final-re-verify");
  assert.match(markdown, /Evidence Manifest/i, "report must include the evidence manifest section");
  // Manifest fingerprint must carry the real gate-evidence file entries.
  assert.match(markdown, /gate-metrics\.json/, "manifest must list the gate-evidence file");
}

async function testFreezeMismatchZeroSpawn() {
  const { calls, markdown, details } = await driveShape({}, { WRONG_HASH: true });
  assert.equal(details.status, "fail", "freeze mismatch must FAIL");
  assert.equal(calls.length, 0, "freeze mismatch must spawn ZERO subagents");
  assert.match(markdown, /mismatch/i, "report must explain the mismatch");
}

async function testMissingEvidenceFileZeroSpawn() {
  const { calls, markdown, details } = await driveShape({}, { MISSING_EVIDENCE_FILE: true });
  assert.equal(details.status, "fail", "missing evidence file must FAIL");
  assert.equal(calls.length, 0, "missing evidence file must spawn ZERO subagents (manifest fail-closed before any spawn)");
  assert.match(markdown, /MISSING_FILE|evidence-manifest/i, "report must attribute the failure to the manifest phase");
}

async function testVerifierFailClosedOnUnparseable() {
  const { calls, details } = await driveShape({}, { fakePi: { FAKE_PI_EVIDENCE_AUDIT_VERIFIER: "unparseable" } });
  assert.equal(details.status, "fail", "unparseable verifier output must fail-closed to FAIL");
  const reviewer = calls.filter((c) => c.agentName === "reviewer");
  assert.equal(reviewer.length, 1, "verifier still spawned once");
}

async function testRouteOverride() {
  const { calls, markdown } = await driveShape({ verifierProvider: "vprov", verifierModel: "vmodel" }, {});
  const reviewer = calls.find((c) => c.agentName === "reviewer");
  assert.ok(reviewer, "must spawn reviewer");
  assert.equal(reviewer.provider, "vprov", "verifier spawn must honor verifierProvider override");
  assert.equal(reviewer.model, "vmodel", "verifier spawn must honor verifierModel override");
  assert.match(markdown, /\*\*Routes:\*\* Verifier=vprov\/vmodel/, "Routes line must reflect verifier override");
}

// ── Resume round-trip (direct shape.run with a pre-seeded run-state) ─────────

async function testResumeRoundTrip() {
  const jiti = makeJiti();
  const shape = jiti(SHAPE_PATH).evidenceAuditShape;
  const runState = jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ea-resume-"));
  const logPath = path.join(tmp, "log.jsonl");
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: all findings resolved.\n");
  const docPath = path.join(tmp, "gate.md");
  fs.writeFileSync(docPath, docContent);
  const reference = sha256(docContent);
  const evidenceDir = path.join(tmp, "completed-run");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "gate-metrics.json"), JSON.stringify({ runId: "run-xyz", pass: true }));

  const task = [
    "Audit the completed run's evidence against the frozen gate.",
    `FROZEN_DOC_PATH: ${docPath}`,
    `FROZEN_DOC_SHA256: ${reference}`,
    `EVIDENCE_CWD: ${evidenceDir}`,
    "RUN_ID_LABEL: run-xyz",
    "GATE_EVIDENCE_FILES:",
    "- gate-metrics.json",
  ].join("\n");

  const runId = `test-ea-resume-${Date.now().toString(36)}`;
  const stageNames = ["freeze-verify", "evidence-manifest", "integrity-audit", "final-re-verify"];
  const store = runState.RunStateStore.create(runId, "evidence-audit", task, { cwd: tmp, maxSubagents: 12 }, stageNames);
  // Pre-checkpoint integrity-audit (index 2) as a COMPLETED pass verifier — resume must NOT respawn it.
  store.checkpointPhase(2, "integrity-audit", {
    agentName: "reviewer", task: "integrity-audit",
    text: JSON.stringify({ overall: "pass", reasons: ["restored auditor pass"], feedback: "", evidence: ["restored"] }),
    stderr: "", exitCode: 0, durationMs: 33, events: 3, toolCalls: { total: 0, byTool: {} },
  });
  const resumeState = runState.RunStateStore.load(runId);

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const params = {
      task, cwd: tmp, maxSubagents: 12, allowLocalModel: false,
      executorAgent: "coder", verifierAgent: "reviewer", plannerAgent: "planner",
      concurrency: 1, plannerCount: 1, verifierCount: 1,
      verifierProvider: "vprov", verifierModel: "vmodel",
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
    const reviewer = calls.filter((c) => c.agentName === "reviewer");
    assert.equal(reviewer.length, 0, "resume must NOT respawn the restored integrity-audit (reviewer)");
    assert.equal(result.details.status, "pass", "resumed audit must complete PASS");
    assert.match(result.markdown, /DETERMINISTIC \(no LLM\)/, "deterministic phases must re-execute on resume");
    // Checkpoint carries the manifest + resolved routes.
    const reloaded = runState.RunStateStore.load(runId);
    assert.equal(reloaded.checkpoints.get(0).deterministic, true, "freeze-verify checkpoint carries deterministic marker");
    assert.equal(reloaded.checkpoints.get(0).outputs.sha256, reference, "freeze-verify checkpoint carries outputs.sha256");
    const manifestCp = reloaded.checkpoints.get(1);
    assert.equal(manifestCp.deterministic, true, "evidence-manifest checkpoint carries deterministic marker");
    assert.ok(Array.isArray(manifestCp.outputs.entries), "evidence-manifest checkpoint carries the manifest entries");
    assert.ok(manifestCp.outputs.entries.some((e) => e.path === "gate-metrics.json"), "manifest entries include the gate-evidence file");
    assert.match(result.details.routes, /Verifier=vprov\/vmodel/, "resolved routes carried into details");
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
  await testHappyPass();
  await testFreezeMismatchZeroSpawn();
  await testMissingEvidenceFileZeroSpawn();
  await testVerifierFailClosedOnUnparseable();
  await testRouteOverride();
  await testResumeRoundTrip();
  console.log("PASS evidence-audit: static rules, registry discovery, canary, happy PASS (1 verifier / 0 executors), freeze-mismatch zero-spawn, missing-evidence-file zero-spawn, verifier fail-closed on unparseable, route override, checkpoint manifest+routes, resume round-trip");
}

run().catch((error) => { console.error("test-evidence-audit: FAIL"); console.error(error); process.exit(1); });
