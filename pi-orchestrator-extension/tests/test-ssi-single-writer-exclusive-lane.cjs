#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(PROJECT_ROOT, "src", "shapes", "ssi-single-writer-exclusive-lane.ts");
const README_PATH = path.join(PROJECT_ROOT, "README.md");
const PARADIGMS_PATH = path.join(PROJECT_ROOT, "PARADIGMS.md");
const LIFECYCLE_PATH = path.join(PROJECT_ROOT, "shape-builder-lifecycle", "ssi-single-writer-exclusive-lane.json");
const OPERATIONS_PATH = path.join(PROJECT_ROOT, "shape-builder-lifecycle", "ssi-single-writer-exclusive-lane-OPERATIONS.md");
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

function loadTestHook() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  return jiti(SOURCE_PATH).__ssiSingleWriterExclusiveLaneTest;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssi-exclusive-shape-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "origin.git");
  fs.mkdirSync(repo);
  git(root, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "shape-test@example.invalid");
  git(repo, "config", "user.name", "Shape Test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "baseline\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "baseline");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  return {
    root,
    repo,
    remote,
    lockPath: path.join(root, "ssi-machine.lock"),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function makeContext(repo, overrides = {}) {
  const executorProvider = overrides.executorProvider ?? "openai-codex";
  const executorModel = overrides.executorModel ?? "gpt-5.5";
  return {
    params: {
      task: overrides.task ?? "Finish the ordinary SSI musical hot-swap slice.",
      plannerAgent: "planner-fixture",
      executorAgent: "writer-fixture",
      verifierAgent: "reviewer-fixture",
      plannerModel: "planner-model",
      plannerProvider: "planner-provider",
      executorModel,
      executorProvider,
      verifierModel: "reviewer-model",
      verifierProvider: "reviewer-provider",
      concurrency: 8,
      plannerCount: 3,
      verifierCount: overrides.verifierCount ?? 7,
      maxRetries: 1,
      maxRetriesExplicit: true,
      maxSubagents: 12,
      maxSubagentsExplicit: true,
      cwd: repo,
      allowLocalModel: false,
      orchestrationControls: { runtimeRoles: [], rawMatches: [] },
      hardGates: "advisory",
      preflight: false,
      discoveryOnly: false,
      ...overrides.params,
    },
    agents: new Map([
      ["planner-fixture", { name: "planner-fixture", tools: ["read", "bash", "edit", "write"] }],
      ["writer-fixture", { name: "writer-fixture", tools: ["read", "bash", "edit", "write"] }],
      ["reviewer-fixture", { name: "reviewer-fixture", tools: ["read", "bash", "edit", "write"] }],
    ]),
    inferredModelRouting: {},
    runId: `test-${Math.random().toString(16).slice(2)}`,
  };
}

function passReview() {
  return JSON.stringify({ status: "PASS", findings: [] });
}

function failReview() {
  return JSON.stringify({
    status: "FAIL",
    findings: [{
      summary: "Concrete source defect",
      evidence: "The branch omits the required lifecycle transition.",
      repair: "Add the missing transition guard.",
      file: "src/runtime.cpp",
      line: 42,
    }],
  });
}

function machineVerdict(status = "PASS") {
  return JSON.stringify({
    status,
    checks: [{
      command: "npm test",
      status,
      exitCode: status === "PASS" ? 0 : 1,
      evidence: status === "PASS" ? "all fixture checks passed" : "fixture gate failed",
    }],
    cleanup: { status: "PASS", survivingProcesses: [], resourcesReleased: true },
    findings: status === "PASS" ? [] : [{
      summary: "Concrete machine failure",
      evidence: "npm test exited 1 in the focused gate.",
      repair: "Correct the focused regression before retesting.",
    }],
  });
}

function finalizerVerdict(repo, overrides = {}) {
  const branch = git(repo, "branch", "--show-current");
  const localHash = git(repo, "rev-parse", "HEAD");
  return JSON.stringify({
    status: "PASS",
    action: "noop",
    branch,
    localHash,
    remoteHash: localHash,
    taskRelevantChangesRemain: false,
    sensoryCard: "Play Glass Pluck, switch to Warm Pad, and confirm the held note changes without a click.",
    ...overrides,
  });
}

function phaseFromPrompt(prompt) {
  return (prompt.match(/^SSI_SHAPE_PHASE: ([^\r\n]+)/) || [])[1] || "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSubstrate {
  constructor(repoInfo, behavior = {}) {
    this.repoInfo = repoInfo;
    this.behavior = behavior;
    this.calls = [];
    this.events = [];
    this.activeDiagnosis = 0;
    this.maxDiagnosis = 0;
    this.activeReview = 0;
    this.maxReview = 0;
    this.machineCall = 0;
    this.reviewCall = 0;
    this.spawn = this.spawn.bind(this);
  }

  async spawn(agentName, prompt, options) {
    const phase = phaseFromPrompt(prompt);
    const route = options.modelOverride || {};
    const tools = [...(options.agents.get(agentName)?.tools || [])];
    const call = { phase, agentName, prompt, options, tools, route };
    this.calls.push(call);
    this.events.push(`start:${phase}`);

    if (phase === "parallel-read-only-diagnosis") {
      this.activeDiagnosis++;
      this.maxDiagnosis = Math.max(this.maxDiagnosis, this.activeDiagnosis);
      await delay(12);
      this.activeDiagnosis--;
    }
    if (phase === "parallel-read-only-source-review") {
      this.activeReview++;
      this.maxReview = Math.max(this.maxReview, this.activeReview);
      await delay(12);
      this.activeReview--;
    }

    let text = `${phase} fixture output`;
    let exitCode = 0;
    if (phase === "parallel-read-only-diagnosis" && this.behavior.diagnosisExitCode) {
      exitCode = this.behavior.diagnosisExitCode;
    } else if (phase === "parallel-read-only-source-review") {
      const index = this.reviewCall++;
      if (this.behavior.malformedReview && index === 0) text = "```json\nnot strict json\n```";
      else if (this.behavior.failReview && index === 0) text = failReview();
      else text = passReview();
    } else if (phase === "exclusive-machine-test-lane" || phase === "exclusive-serialized-retest") {
      assert.equal(fs.existsSync(this.repoInfo.lockPath), true, "machine spawn must occur while atomic lock exists");
      const index = this.machineCall++;
      if (this.behavior.machineMutation && index === 0) {
        fs.appendFileSync(path.join(this.repoInfo.repo, "tracked.txt"), "machine mutation\n");
      }
      const verdicts = this.behavior.machineVerdicts || ["PASS"];
      const selected = verdicts[Math.min(index, verdicts.length - 1)];
      text = selected === "MALFORMED" ? "PASS (exit code zero)" : machineVerdict(selected);
    } else if (phase === "same-writer-finalize") {
      if (this.behavior.finalizerMutation) {
        fs.appendFileSync(path.join(this.repoInfo.repo, "tracked.txt"), "finalizer mutation\n");
      }
      text = this.behavior.finalizerText || finalizerVerdict(this.repoInfo.repo);
    }

    this.events.push(`end:${phase}`);
    return {
      agentName,
      provider: route.provider,
      model: route.model,
      task: prompt,
      text,
      stderr: "",
      exitCode,
      durationMs: 1,
      events: 1,
    };
  }
}

async function runShape(repoInfo, behavior = {}, contextOverrides = {}) {
  const fake = new FakeSubstrate(repoInfo, behavior);
  const lockEvents = [];
  const hook = loadTestHook();
  const result = await hook.run(makeContext(repoInfo.repo, contextOverrides), {
    spawn: fake.spawn,
    machineLockPath: repoInfo.lockPath,
    onLockEvent(event, lockPath) { lockEvents.push({ event, lockPath }); },
  });
  return { result, fake, lockEvents };
}

function assertStaticRules() {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  assert.match(source, /name:\s*"ssi-single-writer-exclusive-lane"/);
  assert.match(source, /Promise\.all/);
  assert.match(source, /phaseMutates/);
  assert.match(source, /ls-files/);
  assert.match(source, /ls-remote/);
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /agent_reload_runtime\s*\(/);
  assert.doesNotMatch(source, /agent_scheduler\s*\(/);
  assert.doesNotMatch(source, /executeCommand\s*\(/);
  assert.doesNotMatch(source, /sendUserMessage\s*\(/);
  assert.doesNotMatch(source, /orchestrate\s*\(/);
}

function assertOperationalCatalogAndLifecycle() {
  const readme = fs.readFileSync(README_PATH, "utf8");
  const paradigms = fs.readFileSync(PARADIGMS_PATH, "utf8");
  const operations = fs.readFileSync(OPERATIONS_PATH, "utf8");
  const lifecycle = JSON.parse(fs.readFileSync(LIFECYCLE_PATH, "utf8"));

  assert.match(readme, /`ssi-single-writer-exclusive-lane` — usable deterministic shape/);
  assert.match(readme, /ssi-single-writer-exclusive-lane-OPERATIONS\.md/);
  assert.match(paradigms, /Usable deterministic (?:native )?generated shapes/);
  assert.match(paradigms, /ssi-single-writer-exclusive-lane-OPERATIONS\.md/);
  assert.match(operations, /What this shape is for/);
  assert.match(operations, /Operational history/);
  assert.match(operations, /orc-ms605rjj-zcrr/);
  assert.match(operations, /04be11042608f7b42ad8ccfd2b3e89c70ccfb948/);

  assert.equal(lifecycle.targetName, "ssi-single-writer-exclusive-lane");
  assert.equal(lifecycle.lifecycleStatus, "canary_passed");
  assert.equal(lifecycle.usable, true);
  assert.equal(lifecycle.reloadRequired, false);
  assert.equal(lifecycle.nextRequiredGate, null);
  assert.equal(lifecycle.operationalLogPath, "shape-builder-lifecycle/ssi-single-writer-exclusive-lane-OPERATIONS.md");
  assert.equal(lifecycle.operationalValidation?.productionProven, true);
  assert.equal(lifecycle.operationalValidation?.discovery?.spawnedCount, 0);
  assert.equal(lifecycle.operationalValidation?.productionRun?.status, "pass");
  assert.equal(lifecycle.operationalValidation?.productionRun?.remoteVerified, true);
  assert.equal(lifecycle.history?.some((entry) => entry.to === "reloaded_discovered"), true);
  assert.equal(lifecycle.history?.some((entry) => entry.to === "canary_passed"), true);
}

async function testHappyPathBarriersProfilesLockAndSkip() {
  const repo = makeRepo();
  try {
    const { result, fake, lockEvents } = await runShape(repo);
    assert.equal(result.details.status, "pass");
    assert.equal(fake.maxDiagnosis, 3, "three diagnoses must overlap behind one barrier");
    assert.equal(fake.maxReview, 2, "two source reviews must overlap behind one barrier");
    assert.equal(fake.calls.filter((call) => call.phase === "exclusive-machine-test-lane").length, 1,
      "verifierCount > 1 must still produce exactly one machine verifier");
    assert.equal(fake.calls.filter((call) => call.phase === "exclusive-serialized-retest").length, 0,
      "initial PASS must skip retest");
    assert.equal(fake.calls.filter((call) => call.phase === "bounded-same-writer-repair").length, 0,
      "initial PASS must skip repair");
    assert.deepEqual(lockEvents.map((entry) => entry.event), ["acquired", "released"]);
    assert.equal(fs.existsSync(repo.lockPath), false, "owned lock must be released");

    const synthesisStart = fake.events.indexOf("start:synthesize-smallest-plan");
    const lastDiagnosisEnd = Math.max(...fake.events.map((event, index) => event === "end:parallel-read-only-diagnosis" ? index : -1));
    assert.ok(synthesisStart > lastDiagnosisEnd, "synthesis must wait for all diagnoses");
    const machineStart = fake.events.indexOf("start:exclusive-machine-test-lane");
    const lastReviewEnd = Math.max(...fake.events.map((event, index) => event === "end:parallel-read-only-source-review" ? index : -1));
    assert.ok(machineStart > lastReviewEnd, "machine verifier must wait for both source reviews");

    for (const call of fake.calls.filter((call) =>
      ["parallel-read-only-diagnosis", "synthesize-smallest-plan", "parallel-read-only-source-review"].includes(call.phase))) {
      assert.deepEqual(call.tools, ["read"], `${call.phase} must expose read only`);
    }
    const implementation = fake.calls.find((call) => call.phase === "single-writer-implementation");
    assert.deepEqual(implementation.tools, ["read", "edit", "write"]);
    assert.equal(implementation.tools.includes("bash"), false);
    const machine = fake.calls.find((call) => call.phase === "exclusive-machine-test-lane");
    assert.deepEqual(machine.tools, ["read", "bash"]);
    const finalizer = fake.calls.find((call) => call.phase === "same-writer-finalize");
    assert.deepEqual(finalizer.tools, ["read", "bash"]);
    assert.equal(finalizer.tools.includes("edit") || finalizer.tools.includes("write"), false);
  } finally {
    repo.cleanup();
  }
}

async function testOneConcreteFailureGetsOneSameWriterRepairAndRetest() {
  const repo = makeRepo();
  try {
    const { result, fake, lockEvents } = await runShape(repo, { failReview: true, machineVerdicts: ["PASS", "PASS"] });
    assert.equal(result.details.status, "pass");
    assert.equal(result.details.repairRan, true);
    assert.equal(fake.calls.filter((call) => call.phase === "bounded-same-writer-repair").length, 1);
    assert.equal(fake.calls.filter((call) => call.phase === "exclusive-serialized-retest").length, 1);
    assert.equal(fake.machineCall, 2);
    assert.deepEqual(lockEvents.map((entry) => entry.event), ["acquired", "released", "acquired", "released"]);

    const writerCalls = fake.calls.filter((call) =>
      ["single-writer-implementation", "bounded-same-writer-repair", "same-writer-finalize"].includes(call.phase));
    assert.equal(writerCalls.length, 3);
    for (const call of writerCalls) {
      assert.equal(call.agentName, "writer-fixture");
      assert.deepEqual(call.route, { provider: "openai-codex", model: "gpt-5.5" });
    }
    for (const call of writerCalls.filter((call) => call.phase !== "same-writer-finalize")) {
      assert.deepEqual(call.tools, ["read", "edit", "write"]);
      assert.equal(call.tools.includes("bash"), false);
      assert.equal(call.options.phaseMutates, true);
    }
  } finally {
    repo.cleanup();
  }
}

async function testFinalFailNeverFinalizes() {
  const repo = makeRepo();
  try {
    const { result, fake } = await runShape(repo, { machineVerdicts: ["FAIL", "FAIL"] });
    assert.equal(result.details.status, "fail");
    assert.equal(fake.calls.filter((call) => call.phase === "bounded-same-writer-repair").length, 1);
    assert.equal(fake.calls.filter((call) => call.phase === "exclusive-serialized-retest").length, 1);
    assert.equal(fake.calls.filter((call) => call.phase === "same-writer-finalize").length, 0);
  } finally {
    repo.cleanup();
  }
}

async function testForbiddenRoutesRejectBeforeZeroSpawns() {
  const repo = makeRepo();
  try {
    for (const route of [
      { executorProvider: "deepseek", executorModel: "deepseek-v4-pro" },
      { executorProvider: "openrouter", executorModel: "openai/gpt-5.5" },
      { executorProvider: "openai-codex", executorModel: "gpt-4.1" },
    ]) {
      const fake = new FakeSubstrate(repo);
      const hook = loadTestHook();
      await assert.rejects(
        () => hook.run(makeContext(repo.repo, route), { spawn: fake.spawn, machineLockPath: repo.lockPath }),
        /rejected|not allowlisted/,
      );
      assert.equal(fake.calls.length, 0, "forbidden route must reject before any work spawn");
    }
  } finally {
    repo.cleanup();
  }
}

async function testMalformedJsonFailsClosed() {
  for (const behavior of [{ malformedReview: true }, { machineVerdicts: ["MALFORMED"] }]) {
    const repo = makeRepo();
    try {
      const { result, fake } = await runShape(repo, behavior);
      assert.equal(result.details.status, "fail");
      assert.equal(fake.calls.filter((call) => call.phase === "same-writer-finalize").length, 0);
      assert.match(result.markdown, /malformed strict JSON/);
    } finally {
      repo.cleanup();
    }
  }
}

async function testMachineAndFinalizerMutationFail() {
  for (const behavior of [{ machineMutation: true }, { finalizerMutation: true }]) {
    const repo = makeRepo();
    try {
      const { result, fake } = await runShape(repo, behavior);
      assert.equal(result.details.status, "fail");
      assert.match(result.markdown, /changed (?:tracked or nonignored untracked )?working-file contents/);
      if (behavior.machineMutation) {
        assert.equal(fake.calls.filter((call) => call.phase === "same-writer-finalize").length, 0);
      }
    } finally {
      repo.cleanup();
    }
  }
}

async function testHeldLockFailsWithoutMachineSpawnOrForeignRelease() {
  const repo = makeRepo();
  try {
    fs.mkdirSync(repo.lockPath);
    fs.writeFileSync(path.join(repo.lockPath, "foreign-owner"), "held");
    const { result, fake, lockEvents } = await runShape(repo);
    assert.equal(result.details.status, "fail");
    assert.equal(fake.calls.filter((call) => call.phase.includes("machine-test-lane")).length, 0);
    assert.equal(fake.calls.filter((call) => call.phase === "same-writer-finalize").length, 0);
    assert.deepEqual(lockEvents, []);
    assert.equal(fs.existsSync(repo.lockPath), true, "shape must not release a lock it did not acquire");
  } finally {
    repo.cleanup();
  }
}

async function testCanarySpawnsZeroAndTouchesNoLock() {
  const repo = makeRepo();
  try {
    const fake = new FakeSubstrate(repo);
    const hook = loadTestHook();
    const context = makeContext(repo.repo, {
      task: "SHAPE_CANARY:ssi-single-writer-exclusive-lane",
      executorProvider: "deepseek",
      executorModel: "forbidden",
    });
    const result = await hook.run(context, { spawn: fake.spawn, machineLockPath: repo.lockPath });
    assert.equal(result.details.status, "pass");
    assert.equal(result.details.spawnedCount, 0);
    assert.equal(fake.calls.length, 0);
    assert.equal(fs.existsSync(repo.lockPath), false);
  } finally {
    repo.cleanup();
  }
}

async function testDiagnosisNonzeroStopsBeforeWriter() {
  const repo = makeRepo();
  try {
    const { result, fake } = await runShape(repo, { diagnosisExitCode: 1 });
    assert.equal(result.details.status, "fail");
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls.some((call) => call.phase === "single-writer-implementation"), false);
  } finally {
    repo.cleanup();
  }
}

async function testIndependentRemoteHashMismatchFails() {
  const repo = makeRepo();
  try {
    fs.appendFileSync(path.join(repo.repo, "tracked.txt"), "local-only commit\n");
    git(repo.repo, "add", "tracked.txt");
    git(repo.repo, "commit", "-m", "local only");
    const { result } = await runShape(repo);
    assert.equal(result.details.status, "fail");
    assert.match(result.markdown, /Independent local\/remote verification failed/);
  } finally {
    repo.cleanup();
  }
}

async function run() {
  assertStaticRules();
  assertOperationalCatalogAndLifecycle();
  await testHappyPathBarriersProfilesLockAndSkip();
  await testOneConcreteFailureGetsOneSameWriterRepairAndRetest();
  await testFinalFailNeverFinalizes();
  await testForbiddenRoutesRejectBeforeZeroSpawns();
  await testMalformedJsonFailsClosed();
  await testMachineAndFinalizerMutationFail();
  await testHeldLockFailsWithoutMachineSpawnOrForeignRelease();
  await testCanarySpawnsZeroAndTouchesNoLock();
  await testDiagnosisNonzeroStopsBeforeWriter();
  await testIndependentRemoteHashMismatchFails();
  console.log("PASS ssi-single-writer-exclusive-lane: barriers, profiles, route allowlist, lock, bounded repair, strict verdicts, fingerprints, and independent hashes");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
