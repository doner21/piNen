#!/usr/bin/env node
/**
 * Item A tests — plan-execute-verify checkpoint/resume on the live inline path.
 * ============================================================================
 * Covers the three cases mandated by the plan:
 *   1. checkpoint round-trip: a fresh plan-execute-verify run persists per-phase
 *      checkpoints (planner/executor/verifier) including the resolved
 *      provider/model for the single-spawn phases;
 *   2. resume-from-partial: a run whose planner phase is already checkpointed
 *      restores it and does NOT re-spawn the planner;
 *   3. resume where the abort happened BEFORE ANY phase completed (the
 *      orc-mr3x90b5-00iz edge): a detached planner survivor at phase index 0
 *      with no checkpoints is re-attached from its result file, not re-spawned.
 * Plus static wiring assertions on the inline path.
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

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({ registerTool(def) { if (def.name === "orchestrate") tool = def; }, registerCommand() {} });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

function loadRunState() { return makeJiti()(path.join(PROJECT_ROOT, "src", "run-state.ts")); }

function fakePlannerResult(text) {
  return { agentName: "planner", task: "", text, stderr: "", exitCode: 0, durationMs: 1, events: 1, toolCalls: { total: 0, byTool: {} } };
}
function fakeCoderResult(text) {
  return { agentName: "coder", task: "", text, stderr: "", exitCode: 0, durationMs: 1, events: 1, toolCalls: { total: 0, byTool: {} } };
}
function fakeReviewerResult(text) {
  return { agentName: "reviewer", task: "", text, stderr: "", exitCode: 0, durationMs: 1, events: 1, toolCalls: { total: 0, byTool: {} } };
}
const PASS_VERDICT = JSON.stringify({ status: "pass", reasons: ["seeded verifier pass"] });
const SEEDED_PLAN = JSON.stringify({ tasks: [{ id: "task-1", description: "Do the seeded fix.", dependsOn: [] }], notes: "seeded" });

async function execPev(tool, params, tmp, logPath) {
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const result = await tool.execute("test-pev-resume", params, undefined, () => {}, { cwd: tmp });
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { result, calls };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
  }
}

// ── 1. checkpoint round-trip ────────────────────────────────────────────────
async function testCheckpointRoundTrip() {
  const runState = loadRunState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-ckpt-"));
  const logPath = path.join(tmp, "log.jsonl");
  const tool = loadOrchestrateTool();
  const { result } = await execPev(tool, {
    task: "Apply a tiny scoped fix and confirm it.",
    paradigm: "plan-execute-verify", preflight: false, hardGates: "off", maxRetries: 0, maxSubagents: 8, cwd: tmp,
    plannerProvider: "pprov", plannerModel: "pmodel",
    executorProvider: "eprov", executorModel: "emodel",
    verifierProvider: "vprov", verifierModel: "vmodel",
  }, tmp, logPath);

  const runId = result.details.runId;
  assert.ok(runId, "run must expose a runId");
  const runDir = runState.runDirFor(runId);
  const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  assert.equal(state.paradigm, "plan-execute-verify", "state.json paradigm must be plan-execute-verify");
  assert.equal(state.task, "Apply a tiny scoped fix and confirm it.", "state.json must persist the task");

  const plannerCk = JSON.parse(fs.readFileSync(path.join(runDir, "phase-0-attempt-1-planner.json"), "utf8"));
  assert.equal(plannerCk.provider, "pprov", "planner checkpoint must record the resolved provider");
  assert.equal(plannerCk.model, "pmodel", "planner checkpoint must record the resolved model");

  // The executor phase is checkpointed PER TASK (attempt-N-executor-<taskId>),
  // each carrying the resolved executor provider/model.
  const execTaskFiles = fs.readdirSync(runDir).filter((f) => /^phase-\d+-attempt-1-executor-task-1\.json$/.test(f));
  assert.equal(execTaskFiles.length, 1, "executor task-1 must checkpoint as a dedicated per-task phase");
  const execCk = JSON.parse(fs.readFileSync(path.join(runDir, execTaskFiles[0]), "utf8"));
  assert.equal(execCk.provider, "eprov", "executor per-task checkpoint must record the resolved provider");
  assert.equal(execCk.model, "emodel", "executor per-task checkpoint must record the resolved model");
  assert.equal(execCk.taskId, "task-1", "executor per-task checkpoint must record its taskId");

  // The verifier phase index shifts after the planner (0) and each executor task.
  const verifierFile = fs.readdirSync(runDir).find((f) => /^phase-\d+-attempt-1-verifier\.json$/.test(f));
  assert.ok(verifierFile, "verifier phase must checkpoint");
  const verifierCk = JSON.parse(fs.readFileSync(path.join(runDir, verifierFile), "utf8"));
  assert.ok(Array.isArray(verifierCk), "verifier checkpoint stores the verifier outputs array");
  // Residual 2a: the ARRAY verifier checkpoint must carry the resolved route on
  // EVERY element (the route-less array write must not strip per-child metadata).
  assert.ok(verifierCk.length >= 1, "verifier checkpoint array must have at least one element");
  for (const entry of verifierCk) {
    assert.equal(entry.provider, "vprov", "each verifier checkpoint element must record the resolved provider");
    assert.equal(entry.model, "vmodel", "each verifier checkpoint element must record the resolved model");
  }

  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 1b. multi-verifier (count > 1) array checkpoint carries route on every child ─
// Residual 2a: with verifierCount>1 the verifier phase checkpoints an ARRAY of
// outputs; the array overwrite must not drop provider/model from any element.
async function testVerifierMultiCheckpointCarriesRoute() {
  const runState = loadRunState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-multiverify-ck-"));
  const logPath = path.join(tmp, "log.jsonl");
  const tool = loadOrchestrateTool();
  const { result } = await execPev(tool, {
    task: "Apply a tiny scoped fix and confirm it with two verifiers.",
    paradigm: "plan-execute-verify", preflight: false, hardGates: "off", maxRetries: 0, maxSubagents: 8, cwd: tmp,
    verifierCount: 2,
    verifierProvider: "vprov", verifierModel: "vmodel",
  }, tmp, logPath);

  const runId = result.details.runId;
  assert.ok(runId, "run must expose a runId");
  const runDir = runState.runDirFor(runId);
  const verifierFile = fs.readdirSync(runDir).find((f) => /^phase-\d+-attempt-1-verifier\.json$/.test(f));
  assert.ok(verifierFile, "multi-verifier aggregate phase must checkpoint");
  const verifierCk = JSON.parse(fs.readFileSync(path.join(runDir, verifierFile), "utf8"));
  assert.ok(Array.isArray(verifierCk), "multi-verifier checkpoint stores the outputs array");
  assert.equal(verifierCk.length, 2, "multi-verifier checkpoint must hold both verifier outputs");
  for (const entry of verifierCk) {
    assert.equal(entry.provider, "vprov", "each multi-verifier element must carry the resolved provider");
    assert.equal(entry.model, "vmodel", "each multi-verifier element must carry the resolved model");
  }

  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 2. resume-from-partial ──────────────────────────────────────────────────
async function testResumeFromPartial() {
  const runState = loadRunState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-partial-"));
  const logPath = path.join(tmp, "log.jsonl");
  const runId = `test-pev-partial-${Date.now().toString(36)}`;
  const storedParams = { cwd: tmp, maxSubagents: 8, maxRetries: 0, preflight: false, hardGates: "off" };
  const store = runState.RunStateStore.create(
    runId, "plan-execute-verify", "Resume the seeded fix.", storedParams,
    ["attempt-1-planner", "attempt-1-executor", "attempt-1-verifier"],
  );
  // Planner phase already complete → must be restored, not re-spawned.
  store.checkpointPhase(0, "attempt-1-planner", fakePlannerResult(SEEDED_PLAN));

  const tool = loadOrchestrateTool();
  const { result, calls } = await execPev(tool, { resume: runId, cwd: tmp }, tmp, logPath);

  assert.ok(!calls.some((c) => c.agentName === "planner"), "planner must NOT be re-spawned on resume");
  assert.ok(calls.some((c) => c.agentName === "coder"), "executor must still run on resume");
  assert.ok(calls.some((c) => c.agentName === "reviewer"), "verifier must still run on resume");
  const log = (result.details.deterministicState.progressLog || []).join("\n");
  assert.match(log, /planner phase restored from checkpoint/, "resume must log planner restoration");

  fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 3. resume before ANY phase completed (detached survivor at index 0) ─────
async function testResumeBeforeAnyPhase() {
  const runState = loadRunState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-survivor-"));
  const logPath = path.join(tmp, "log.jsonl");
  const runId = `test-pev-survivor-${Date.now().toString(36)}`;
  const storedParams = { cwd: tmp, maxSubagents: 8, maxRetries: 0, preflight: false, hardGates: "off" };
  const store = runState.RunStateStore.create(
    runId, "plan-execute-verify", "Resume from a detached planner survivor.", storedParams,
    ["attempt-1-planner", "attempt-1-executor", "attempt-1-verifier"],
  );
  // The abort happened BEFORE any phase completed: planner detached at index 0,
  // NO checkpoints exist. Its result file is already on disk (the orphaned child
  // finished in the background).
  const resultFile = store.survivorResultPath(0, "attempt-1-planner");
  fs.writeFileSync(resultFile, JSON.stringify(fakePlannerResult(SEEDED_PLAN)), "utf8");
  store.markDetached(0, "attempt-1-planner", {
    pid: 999999999, agentName: "planner", phaseName: "attempt-1-planner", phaseIndex: 0,
    startedAt: Date.now(), detachedAt: new Date().toISOString(), resultFile,
  });

  const tool = loadOrchestrateTool();
  const { result, calls } = await execPev(tool, { resume: runId, cwd: tmp }, tmp, logPath);

  assert.ok(!calls.some((c) => c.agentName === "planner"), "detached planner survivor must be collected, not re-spawned");
  assert.ok(calls.some((c) => c.agentName === "coder"), "executor must run after survivor collection");
  const log = (result.details.deterministicState.progressLog || []).join("\n");
  assert.match(log, /survivor phase attempt-1-planner result collected/, "resume must log survivor collection");

  fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Static wiring assertions on the inline plan-execute-verify path ─────────
function testInlineWiringStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "index.ts"), "utf8");
  assert.match(source, /RunStateStore\.create\(state\.runId, "plan-execute-verify"/, "inline path must create a plan-execute-verify run store");
  assert.match(source, /collectSurvivorResult/, "inline path must collect detached survivors");
  assert.match(source, /abortSurvival\?:/, "runSubagent must accept abortSurvival");
  assert.match(source, /pevCheckpoint\(/, "inline path must checkpoint phases");
  assert.match(source, /Supported paradigms: plan-execute-verify/, "resume schema must list plan-execute-verify");
  // Item A completeness: executor phase must be per-task, abort-survivor wired,
  // and SubagentDetachedError must propagate (never swallowed into a task failure).
  assert.match(source, /executorTaskName\(task\.id\)/, "executor phase must checkpoint per-task (attempt-N-executor-<taskId>)");
  assert.match(source, /pevCollectExecutorSurvivor/, "executor tasks must collect detached survivors per-task");
  assert.match(source, /pevSurvival\(taskName\)/, "executor task spawns must run in abort-survivor mode");
  assert.match(source, /if \(err instanceof SubagentDetachedError\) throw err/, "executor task recovery must propagate SubagentDetachedError");
  assert.match(source, /pevCheckpoint\(taskName, out, executorRoute\)/, "executor per-task checkpoint must carry the resolved executor route");
  // Residual 2 static wiring: pevCheckpoint stamps arrays (verifier phase) and
  // the inline runSubagent attaches the resolved route to its result object.
  assert.match(source, /Array\.isArray\(result\)/, "pevCheckpoint must handle array (verifier) results");
  assert.match(source, /result\.provider = profile\.provider/, "inline runSubagent must attach the resolved provider to its result");
}

// ── 4. resume where a per-task EXECUTOR spawn detached (survivor at its index) ─
async function testResumeExecutorTaskSurvivor() {
  const runState = loadRunState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-exec-survivor-"));
  const logPath = path.join(tmp, "log.jsonl");
  const runId = `test-pev-exec-survivor-${Date.now().toString(36)}`;
  const storedParams = { cwd: tmp, maxSubagents: 8, maxRetries: 0, preflight: false, hardGates: "off" };
  const store = runState.RunStateStore.create(
    runId, "plan-execute-verify", "Resume from a detached executor-task survivor.", storedParams,
    ["attempt-1-planner", "attempt-1-executor-task-1", "attempt-1-verifier"],
  );
  // Planner already checkpointed → the plan is restored deterministically.
  store.checkpointPhase(0, "attempt-1-planner", fakePlannerResult(SEEDED_PLAN));
  // Executor task-1 detached at index 1; its raw SubagentResult is already flushed.
  const resultFile = store.survivorResultPath(1, "attempt-1-executor-task-1");
  fs.writeFileSync(resultFile, JSON.stringify(fakeCoderResult("seeded executor output")), "utf8");
  store.markDetached(1, "attempt-1-executor-task-1", {
    pid: 999999999, agentName: "coder", phaseName: "attempt-1-executor-task-1", phaseIndex: 1,
    startedAt: Date.now(), detachedAt: new Date().toISOString(), resultFile,
  });

  const tool = loadOrchestrateTool();
  const { result, calls } = await execPev(tool, { resume: runId, cwd: tmp }, tmp, logPath);

  assert.ok(!calls.some((c) => c.agentName === "coder"), "detached executor-task survivor must be collected, not re-spawned");
  assert.ok(calls.some((c) => c.agentName === "reviewer"), "verifier must run after executor survivor collection");
  const log = (result.details.deterministicState.progressLog || []).join("\n");
  assert.match(log, /executor task task-1 survivor collected/, "resume must log executor-task survivor collection");

  fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 5. resume during a MULTI-planner phase (plannerCount>1) ─────────────────
// The abort happened mid multi-planner phase: one planner child detached
// (survivor) and one child had already checkpointed. On resume NEITHER planner
// child may be re-spawned — the survivor is re-attached and the checkpoint is
// restored, both keyed by their per-child phase names/indices.
async function testResumeMultiPlannerSurvivor() {
  const runState = loadRunState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-multiplan-"));
  const logPath = path.join(tmp, "log.jsonl");
  const runId = `test-pev-multiplan-${Date.now().toString(36)}`;
  const storedParams = { cwd: tmp, maxSubagents: 8, maxRetries: 0, preflight: false, hardGates: "off", plannerCount: 2 };
  const store = runState.RunStateStore.create(
    runId, "plan-execute-verify", "Resume from a detached multi-planner survivor.", storedParams,
    ["attempt-1-planner-0", "attempt-1-planner-1", "attempt-1-executor-task-1", "attempt-1-verifier"],
  );
  // planner child 0 detached at index 0 (survivor result already flushed).
  const resultFile = store.survivorResultPath(0, "attempt-1-planner-0");
  fs.writeFileSync(resultFile, JSON.stringify(fakePlannerResult(SEEDED_PLAN)), "utf8");
  store.markDetached(0, "attempt-1-planner-0", {
    pid: 999999999, agentName: "planner", phaseName: "attempt-1-planner-0", phaseIndex: 0,
    startedAt: Date.now(), detachedAt: new Date().toISOString(), resultFile,
  });
  // planner child 1 already completed at index 1 (checkpointed).
  store.checkpointPhase(1, "attempt-1-planner-1", fakePlannerResult(SEEDED_PLAN));

  const tool = loadOrchestrateTool();
  const { result, calls } = await execPev(tool, { resume: runId, cwd: tmp }, tmp, logPath);

  assert.ok(!calls.some((c) => c.agentName === "planner"), "no planner child may be re-spawned when all planner children resume from checkpoint/survivor");
  assert.ok(calls.some((c) => c.agentName === "coder"), "executor must run after multi-planner resume");
  assert.ok(calls.some((c) => c.agentName === "reviewer"), "verifier must run after multi-planner resume");
  const log = (result.details.deterministicState.progressLog || []).join("\n");
  assert.match(log, /planner instance \d+\/\d+ survivor collected/, "resume must log per-child planner survivor collection");
  assert.match(log, /planner instance \d+\/\d+ restored from checkpoint/, "resume must log per-child planner checkpoint restoration");

  fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 6. resume during a MULTI-verifier phase (verifierCount>1) ───────────────
// The abort happened mid multi-verifier phase: one verifier child detached and
// one had checkpointed. On resume NEITHER verifier child may be re-spawned.
async function testResumeMultiVerifierSurvivor() {
  const runState = loadRunState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-multiverify-"));
  const logPath = path.join(tmp, "log.jsonl");
  const runId = `test-pev-multiverify-${Date.now().toString(36)}`;
  const storedParams = { cwd: tmp, maxSubagents: 8, maxRetries: 0, preflight: false, hardGates: "off", verifierCount: 2 };
  const store = runState.RunStateStore.create(
    runId, "plan-execute-verify", "Resume from a detached multi-verifier survivor.", storedParams,
    ["attempt-1-planner", "attempt-1-verifier-0", "attempt-1-verifier-1"],
  );
  // Planner already checkpointed at index 0 → plan restored, no planner spawn.
  store.checkpointPhase(0, "attempt-1-planner", fakePlannerResult(SEEDED_PLAN));
  // verifier child 0 detached at index 1 (survivor result already flushed).
  const resultFile = store.survivorResultPath(1, "attempt-1-verifier-0");
  fs.writeFileSync(resultFile, JSON.stringify(fakeReviewerResult(PASS_VERDICT)), "utf8");
  store.markDetached(1, "attempt-1-verifier-0", {
    pid: 999999999, agentName: "reviewer", phaseName: "attempt-1-verifier-0", phaseIndex: 1,
    startedAt: Date.now(), detachedAt: new Date().toISOString(), resultFile,
  });
  // verifier child 1 already completed at index 2 (checkpointed).
  store.checkpointPhase(2, "attempt-1-verifier-1", fakeReviewerResult(PASS_VERDICT));

  const tool = loadOrchestrateTool();
  const { result, calls } = await execPev(tool, { resume: runId, cwd: tmp }, tmp, logPath);

  assert.ok(!calls.some((c) => c.agentName === "planner"), "planner must NOT be re-spawned (plan restored)");
  assert.ok(!calls.some((c) => c.agentName === "reviewer"), "no verifier child may be re-spawned when all verifier children resume from checkpoint/survivor");
  assert.ok(calls.some((c) => c.agentName === "coder"), "executor must still run on multi-verifier resume");
  const log = (result.details.deterministicState.progressLog || []).join("\n");
  assert.match(log, /verifier instance \d+\/\d+ survivor collected/, "resume must log per-child verifier survivor collection");
  assert.match(log, /verifier instance \d+\/\d+ restored from checkpoint/, "resume must log per-child verifier checkpoint restoration");

  fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function run() {
  testInlineWiringStaticRules();
  await testCheckpointRoundTrip();
  await testVerifierMultiCheckpointCarriesRoute();
  await testResumeFromPartial();
  await testResumeBeforeAnyPhase();
  await testResumeExecutorTaskSurvivor();
  await testResumeMultiPlannerSurvivor();
  await testResumeMultiVerifierSurvivor();
  console.log("PASS pev-resume: checkpoint round-trip (single+multi-verifier route metadata), resume-from-partial, resume-before-any-phase, per-task executor survivor, multi-planner survivor, multi-verifier survivor, inline wiring");
}

run().catch((error) => { console.error("test-pev-resume: FAIL"); console.error(error); process.exit(1); });
