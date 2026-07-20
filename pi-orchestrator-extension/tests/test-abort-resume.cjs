#!/usr/bin/env node
/**
 * Tests for the abort-survivor + checkpoint/resume repair
 * (ABORT-RESUME-DESIGN.md). Follows the conventions of the sibling tests:
 * jiti-loads TypeScript sources directly and asserts both static source
 * rules and runtime behavior of the pure state layer.
 */
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

function makeJiti() {
  return createJiti(__filename, { interopDefault: true, moduleCache: false });
}

// ── Static source rules ────────────────────────────────────────────────────

function testSubstrateStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "substrate.ts"), "utf8");
  assert.match(source, /export class SubagentDetachedError/, "substrate must export SubagentDetachedError");
  assert.match(source, /abortSurvival\?:/, "SpawnSubagentOptions must accept abortSurvival");
  assert.match(source, /detachPromise/, "spawn must race the close promise against detach");
  // The survival branch must NOT kill the child; the kill must stay in the non-survival branch.
  const abortHandlerBlock = source.slice(source.indexOf("const abortHandler = () => {"), source.indexOf("const stdoutReader"));
  const survivalBranch = abortHandlerBlock.slice(0, abortHandlerBlock.indexOf("killedByAbort = true"));
  assert.doesNotMatch(survivalBranch, /child\.kill/, "survival branch must not kill the child");
  assert.match(abortHandlerBlock, /killedByAbort = true/, "non-survival kill semantics must be preserved");
}

function testShapeWiringStaticRules() {
  const spike = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "preregistered-concurrency-spike.ts"), "utf8");
  assert.match(spike, /RunStateStore/, "spike shape must use the run-state store");
  assert.match(spike, /abortSurvival/, "spike shape must spawn phases in abort-survivor mode");
  assert.match(spike, /\{ resume: "\$\{store\.runId\}" \}/, "spike shape must surface a resume hint on detach");
  assert.doesNotMatch(spike, /from\s+["']\.\//, "shape must not import sibling shapes");

  const dual = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "dual-plan-synthesis-execute-verify.ts"), "utf8");
  assert.match(dual, /RunStateStore/, "dual-plan shape must use the run-state store");
  assert.match(dual, /abortSurvival/, "dual-plan shape must spawn long stages in abort-survivor mode");
  assert.match(dual, /executor-\$\{k\}/, "dual-plan must checkpoint per-attempt executor stages");
  assert.match(dual, /function resolveRoutes/, "dual-plan must honor executorModel/verifierModel param overrides (silent route replacement fix)");
  assert.match(dual, /routes\.executor,/, "dual-plan executor spawn must use the resolved route");
  assert.doesNotMatch(dual, /from\s+["']\.\//, "shape must not import sibling shapes");
}

function testIndexResumeParam() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "index.ts"), "utf8");
  assert.match(source, /resume: Type\.Optional/, "tool schema must expose the resume parameter");
  assert.match(source, /RunStateStore\.load\(resumeId\)/, "resume dispatch must load persisted state");
  assert.match(source, /resumeState\?: LoadedRunState/, "runOrchestration must accept resumeState");
  assert.match(source, /runId: state\.runId,\s*\n\s*resumeState,/, "shape context must carry runId + resumeState");
}

// ── Behavioral: run-state store round-trip ─────────────────────────────────

function testRunStateRoundTrip() {
  const jiti = makeJiti();
  const runState = jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));
  const runId = `test-abort-resume-${Date.now().toString(36)}`;

  const store = runState.RunStateStore.create(
    runId,
    "preregistered-concurrency-spike",
    "TEST TASK",
    { cwd: "C:/tmp", maxSubagents: 12 },
    ["implement", "measure", "verify", "verdict"],
  );

  const fakeResult = {
    agentName: "coder",
    task: "TEST TASK",
    text: "phase output",
    stderr: "",
    exitCode: 0,
    durationMs: 123,
    events: 4,
    toolCalls: { total: 0, byTool: {} },
  };
  store.checkpointPhase(0, "implement", fakeResult);
  store.markDetached(1, "measure", {
    pid: process.pid,
    agentName: "coder",
    phaseName: "measure",
    phaseIndex: 1,
    startedAt: Date.now(),
    detachedAt: new Date().toISOString(),
    resultFile: store.survivorResultPath(1, "measure"),
  });

  const loaded = runState.RunStateStore.load(runId);
  assert.equal(loaded.state.runId, runId);
  assert.equal(loaded.state.task, "TEST TASK");
  assert.equal(loaded.state.paradigm, "preregistered-concurrency-spike");
  assert.equal(loaded.state.phases.find((p) => p.index === 0).status, "done");
  assert.equal(loaded.state.phases.find((p) => p.index === 1).status, "detached");
  assert.equal(loaded.checkpoints.get(0).text, "phase output");
  assert.equal(loaded.survivors.get(1).phaseName, "measure");

  // Survivor result collection: write the result file, then collect.
  fs.writeFileSync(loaded.survivors.get(1).resultFile, JSON.stringify(fakeResult), "utf8");
  return runState
    .collectSurvivorResult(loaded.survivors.get(1), () => {}, undefined, "test")
    .then((collected) => {
      assert.equal(collected.text, "phase output");
      // Dead pid + no result file → undefined (respawn path).
      const deadSurvivor = {
        pid: 999999999,
        resultFile: path.join(loaded.runDir, "missing.result.json"),
        phaseName: "verify",
      };
      return runState.collectSurvivorResult(deadSurvivor, () => {}, undefined, "test");
    })
    .then((missing) => {
      assert.equal(missing, undefined);
      fs.rmSync(runDirOf(runState, runId), { recursive: true, force: true });
    });
}

function runDirOf(runState, runId) {
  return runState.runDirFor(runId);
}

// ── Behavioral: unknown resume id errors clearly ───────────────────────────

function testUnknownResumeId() {
  const jiti = makeJiti();
  const runState = jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));
  assert.throws(
    () => runState.RunStateStore.load("orc-nonexistent-run"),
    /Resume state not found for run "orc-nonexistent-run"/,
    "unknown resume id must produce the canary error message",
  );
}

// ── Load smoke: modules must jiti-load without throwing ────────────────────

function testModulesLoad() {
  const jiti = makeJiti();
  jiti(path.join(PROJECT_ROOT, "src", "substrate.ts"));
  jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));
  const spike = jiti(path.join(PROJECT_ROOT, "src", "shapes", "preregistered-concurrency-spike.ts"));
  assert.equal(spike.preregisteredConcurrencySpikeShape.name, "preregistered-concurrency-spike");
  const dual = jiti(path.join(PROJECT_ROOT, "src", "shapes", "dual-plan-synthesis-execute-verify.ts"));
  assert.ok(dual, "dual-plan shape module must load");
  const index = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
  assert.ok(index, "index module must load");
}

async function main() {
  const tests = [
    ["substrate static rules", testSubstrateStaticRules],
    ["shape wiring static rules", testShapeWiringStaticRules],
    ["index resume param", testIndexResumeParam],
    ["modules load", testModulesLoad],
    ["run-state round trip + survivor collection", testRunStateRoundTrip],
    ["unknown resume id", testUnknownResumeId],
  ];
  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
  console.log("test-abort-resume: ALL PASS");
}

main().catch((error) => {
  console.error("test-abort-resume: FAIL");
  console.error(error);
  process.exit(1);
});
