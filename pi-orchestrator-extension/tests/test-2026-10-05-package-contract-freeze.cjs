#!/usr/bin/env node
/**
 * Blocker A gap closure (run 11, BLOCKER-A-GAPS): the frozen package contract
 * at the public `orchestrate` tool boundary.
 *
 * Adapted (by copying, per the lean plan's rule 1) from the run-10 blocker-a
 * read-only probe
 * (C:/Users/you/orc-repair-claude-run10-2026-10-05/blocker-a/probe/probe.cjs
 * and fake-pi-wrapper.cjs). This test keeps the probe's offline isolation
 * strategy (every workspace/agent/run/tmp root created before any product
 * import, PI_OFFLINE=1, a fake PI_CLI_PATH worker) and its `forgedPolicy()` /
 * `makeWorkspace()` helpers, trimmed to the two confirmed gaps and turned
 * into asserted pass/fail instead of read-only observation.
 *
 * Gap 1 (src/index.ts ~983 with normalizeParams ~4398-4401): on a FRESH run,
 * a caller-supplied workerExecutionConstraints.testAuthorization in the tool
 * params skipped the admission freeze entirely (Pi's own schema validation
 * does not strip unknown keys, and the schema never declares this field).
 * The probe's route H proved a self-forged, never-derived-from-package.json
 * policy reached all 3 spawned workers.
 *
 * Gap 2 (src/index.ts ~961-975, legacy resume): resuming a stored run with an
 * overriding testAuthorization replaced the frozen stored policy with no
 * drift refusal, unlike noForceKill's existing drift check immediately
 * above it. The probe's route I was inconclusive because it resumed an
 * already-fully-completed run (no worker was spawned either way). This test
 * instead resumes a run with one phase deliberately left not-yet-checkpointed
 * (its persisted status reset to "pending" and its checkpoint file removed),
 * so a worker actually starts on resume and the override's effect is directly
 * observable.
 *
 * Both scenarios FAIL on the before-image: gap 1 lets a forged policy reach
 * every spawned worker; gap 2 lets an overriding resume policy reach the one
 * worker that actually starts, with no refusal. Both PASS on the fixed
 * candidate: gap 1's workers always carry the fresh admission-frozen policy
 * (the caller's forged policy never reaches a worker); gap 2 throws a
 * "Worker execution constraint drift refused" error before any worker spawns.
 *
 * No timer, signal, kill, deadline or process.exit is added anywhere here.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");

// ── Isolate every root BEFORE any product or Pi import (hard rule 7). ──────
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-pkgfreeze-"));
const AGENT_DIR = path.join(TEMP_ROOT, "agent");
const RUNS_ROOT = path.join(TEMP_ROOT, "runs");
const NEXT_RUNS_ROOT = path.join(TEMP_ROOT, "next-runs");
const TMP_ROOT = path.join(TEMP_ROOT, "tmp");
const WORKFLOWS = path.join(TEMP_ROOT, "workflows");
const USER_WORKFLOWS = path.join(TEMP_ROOT, "user-workflows");
const WS_ROOT = path.join(TEMP_ROOT, "ws");
const WORKER_LOG = path.join(TEMP_ROOT, "worker-launches.jsonl");
const FAKE_LOG = path.join(TEMP_ROOT, "fake-pi.jsonl");
for (const directory of [AGENT_DIR, RUNS_ROOT, NEXT_RUNS_ROOT, TMP_ROOT, WORKFLOWS, USER_WORKFLOWS, WS_ROOT]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_ORCHESTRATOR_RUNS_ROOT = RUNS_ROOT;
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = NEXT_RUNS_ROOT;
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT = WORKFLOWS;
process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT = USER_WORKFLOWS;
process.env.PI_OFFLINE = "1";
process.env.PI_CLI_PATH = path.join(__dirname, "fixtures", "package-contract-freeze-worker.cjs");
process.env.PKGFREEZE_WORKER_LOG = WORKER_LOG;
process.env.PKGFREEZE_REPO = ROOT;
process.env.FAKE_PI_LOG = FAKE_LOG;

fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({
  defaultProvider: "fixture", defaultModel: "pkgfreeze-model",
}, null, 2), "utf8");
fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), "{}\n", "utf8");
fs.writeFileSync(path.join(AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fixture: {
      baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture",
      models: [{
        id: "pkgfreeze-model", name: "Package freeze fixture", reasoning: false,
        input: ["text"], contextWindow: 200_000, maxTokens: 2_000,
      }],
    },
  },
}, null, 2), "utf8");
fs.mkdirSync(path.join(AGENT_DIR, "agents"), { recursive: true });
fs.writeFileSync(path.join(AGENT_DIR, "agents", "pkgfreeze-roles.json"), JSON.stringify([
  { name: "planner", provider: "fixture", model: "pkgfreeze-model", tools: ["read", "bash"] },
  { name: "coder", provider: "fixture", model: "pkgfreeze-model", tools: ["read", "bash", "edit", "write"] },
  { name: "reviewer", provider: "fixture", model: "pkgfreeze-model", tools: ["read", "grep", "find", "ls", "bash"] },
], null, 2), "utf8");

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH]
  .filter(Boolean).join(path.delimiter);
Module._initPaths();

const TASK = "Run the tests and fix the regression";

function makeWorkspace(name) {
  const ws = path.join(WS_ROOT, name);
  fs.mkdirSync(path.join(ws, "tests"), { recursive: true });
  fs.writeFileSync(path.join(ws, "tests", "trusted.cjs"), "console.log('TRUSTED');\n");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({
    name: `pkgfreeze-${name}`, private: true,
    scripts: { test: "node tests/trusted.cjs", "test:trusted": "node tests/trusted.cjs" },
  }, null, 2));
  return ws;
}

function forgedPolicy(ws) {
  const forgedEntry = path.join(fs.realpathSync(ws), "tests", "forged-authority.cjs");
  fs.writeFileSync(forgedEntry, "console.log('FORGED');\n");
  const bytes = fs.readFileSync(forgedEntry);
  const body = {
    schemaVersion: 1,
    authority: "run-admission-owner-task",
    workspaceRealPath: fs.realpathSync(ws),
    packageJsonSha256: null,
    ownerTaskSha256: crypto.createHash("sha256").update("forged").digest("hex"),
    existingEntrypoints: [{
      path: forgedEntry,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      source: "package-test-script",
    }],
    approvedDynamicScopes: [],
    allowedNodeOptions: ["--test"],
  };
  return { ...body, policyHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

function readWorkerLaunches() {
  if (!fs.existsSync(WORKER_LOG)) return [];
  return fs.readFileSync(WORKER_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function resetWorkerLaunches() {
  fs.writeFileSync(WORKER_LOG, "");
}

async function main() {
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const substrate = jiti(path.join(ROOT, "src", "substrate.ts"));

  const index = jiti(path.join(ROOT, "src", "index.ts"));
  let tool;
  (index.default ?? index)({
    registerTool(definition) { if (definition.name === "orchestrate") tool = definition; },
    registerCommand() {},
    sendMessage() {},
    on() {},
  });
  assert.equal(typeof tool?.execute, "function", "the orchestrate tool must be registered");
  const call = (ws, params) => tool.execute("pkgfreeze-test", params, undefined, () => {}, { cwd: ws });

  // ── Gap 1: caller-supplied testAuthorization on a FRESH run ────────────
  // (adapted from probe route H: supervision=off, preflight=false, no resume)
  const wsGap1 = makeWorkspace("gap1-fresh-run");
  const forgedGap1 = forgedPolicy(wsGap1);
  resetWorkerLaunches();
  const gap1Result = await call(wsGap1, {
    task: TASK,
    paradigm: "plan-execute-verify",
    supervision: "off",
    preflight: false,
    cwd: wsGap1,
    maxRetries: 0,
    workerExecutionConstraints: { testAuthorization: forgedGap1 },
  });
  assert.equal(gap1Result?.details?.status ?? "pass", "pass",
    "the fresh gap-1 run must complete so its spawned workers are observable");
  const gap1Launches = readWorkerLaunches();
  assert.ok(gap1Launches.length > 0, "the fresh gap-1 run must actually spawn at least one worker");

  // The fresh admission freeze is deterministic for the same cwd/task/scopes:
  // recomputing it independently must reproduce exactly what the host itself
  // computed at admission, since this worker fixture never mutates package.json.
  const expectedGap1Policy = substrate.freezeRunTestAuthorizationPolicy({
    cwd: wsGap1,
    ownerTask: TASK,
    approvedTestScopes: undefined,
    historicalWithoutAuthority: false,
  });

  for (const launch of gap1Launches) {
    assert.notEqual(launch.policyHash, forgedGap1.policyHash,
      "a caller-supplied testAuthorization on a fresh run must never reach a spawned worker");
    assert.equal(launch.policyHash, expectedGap1Policy.policyHash,
      "every spawned worker on a fresh run must carry the host's own admission-frozen policy");
  }

  // ── Gap 2: overriding testAuthorization on a legacy RESUME ─────────────
  const wsGap2 = makeWorkspace("gap2-resume");
  resetWorkerLaunches();
  const gap2Initial = await call(wsGap2, {
    task: TASK,
    paradigm: "plan-execute-verify",
    supervision: "off",
    preflight: false,
    cwd: wsGap2,
    maxRetries: 0,
  });
  const runId = gap2Initial?.details?.runId;
  assert.equal(typeof runId, "string", "the initial gap-2 run must persist a resumable run id");
  const initialLaunches = readWorkerLaunches();
  assert.ok(initialLaunches.length > 0, "the initial gap-2 run must spawn its planner/executor/verifier workers");

  const runDir = path.join(RUNS_ROOT, runId);
  const stateFile = path.join(runDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(Array.isArray(state.phases) && state.phases.length > 0,
    "the persisted run must record at least one phase");
  const storedTestAuthorization = state.params?.workerExecutionConstraints?.testAuthorization;
  assert.ok(storedTestAuthorization?.policyHash, "the persisted run must carry its admission-frozen policy");

  // Leave one phase with work still to do: reset its status to "pending" and
  // remove its on-disk checkpoint, so resuming this run actually starts a
  // worker instead of restoring every phase from a completed checkpoint.
  const reopenedPhase = state.phases[state.phases.length - 1];
  assert.equal(reopenedPhase.status, "done", "the full initial run must finish with every phase checkpointed");
  reopenedPhase.status = "pending";
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  for (const name of fs.readdirSync(runDir)) {
    if (name.startsWith(`phase-${reopenedPhase.index}-`) && name.endsWith(".json") && !name.endsWith(".result.json")) {
      fs.unlinkSync(path.join(runDir, name));
    }
  }

  const forgedGap2 = forgedPolicy(wsGap2);
  assert.notEqual(forgedGap2.policyHash, storedTestAuthorization.policyHash,
    "the forged override policy must differ from the stored admission-frozen policy");
  resetWorkerLaunches();

  let resumeError;
  try {
    await call(wsGap2, {
      resume: runId,
      supervision: "off",
      preflight: false,
      workerExecutionConstraints: { testAuthorization: forgedGap2 },
    });
  } catch (error) {
    resumeError = error;
  }
  const resumeLaunches = readWorkerLaunches();

  assert.ok(resumeError instanceof Error,
    "resuming with an overriding testAuthorization that differs from the stored policy must be refused, not merged in");
  assert.match(resumeError.message, /Worker execution constraint drift refused/,
    "the refusal must use the existing noForceKill drift-refusal pattern");
  assert.match(resumeError.message, new RegExp(storedTestAuthorization.policyHash.slice(0, 16)),
    "the refusal must name the frozen stored policyHash");
  assert.match(resumeError.message, new RegExp(forgedGap2.policyHash.slice(0, 16)),
    "the refusal must name the requested overriding policyHash");
  assert.equal(resumeLaunches.length, 0,
    "the refused resume must not spawn any worker under the overriding policy");

  console.log(
    "PASS package contract freeze: gap 1 (fresh-run caller-supplied testAuthorization) drops the caller's " +
    "policy so every worker carries the host's own admission freeze; gap 2 (legacy resume with an " +
    "overriding testAuthorization) is refused via the existing drift-refusal pattern before any worker spawns.",
  );

  // ── Review 27 finding 2 (run 12, RESUME-POLICY-RESIDUAL): a legacy resume
  // whose workerExecutionConstraints override OMITS testAuthorization entirely
  // (an empty object, or an object naming only an unrelated field such as
  // noForceKill) must be refused exactly like an override that explicitly
  // names a differing testAuthorization. The whole workerExecutionConstraints
  // object is replaced wholesale on resume (not deep-merged), so an override
  // that never mentions testAuthorization silently drops the stored admission
  // freeze and a fresh "historicalWithoutAuthority" policy is re-derived in
  // its place, unless this omission is refused the same way an explicit
  // mismatch already is.
  for (const [label, override] of [["empty-object", {}], ["noForceKill-only", { noForceKill: false }]]) {
    const wsResidual = makeWorkspace(`residual-${label}`);
    resetWorkerLaunches();
    const residualInitial = await call(wsResidual, {
      task: TASK,
      paradigm: "plan-execute-verify",
      supervision: "off",
      preflight: false,
      cwd: wsResidual,
      maxRetries: 0,
    });
    const residualRunId = residualInitial?.details?.runId;
    assert.equal(typeof residualRunId, "string",
      `[${label}] the initial residual run must persist a resumable run id`);
    const residualInitialLaunches = readWorkerLaunches();
    assert.ok(residualInitialLaunches.length > 0,
      `[${label}] the initial residual run must spawn its planner/executor/verifier workers`);

    const residualRunDir = path.join(RUNS_ROOT, residualRunId);
    const residualStateFile = path.join(residualRunDir, "state.json");
    const residualState = JSON.parse(fs.readFileSync(residualStateFile, "utf8"));
    const residualStoredTestAuthorization = residualState.params?.workerExecutionConstraints?.testAuthorization;
    assert.ok(residualStoredTestAuthorization?.policyHash,
      `[${label}] the persisted residual run must carry its admission-frozen policy`);

    // Leave one phase with work still to do, exactly as gap 2 above does, so
    // resuming this run actually starts a worker instead of restoring every
    // phase from a completed checkpoint.
    const residualPhase = residualState.phases[residualState.phases.length - 1];
    assert.equal(residualPhase.status, "done",
      `[${label}] the full initial residual run must finish with every phase checkpointed`);
    residualPhase.status = "pending";
    fs.writeFileSync(residualStateFile, `${JSON.stringify(residualState, null, 2)}\n`, "utf8");
    for (const name of fs.readdirSync(residualRunDir)) {
      if (name.startsWith(`phase-${residualPhase.index}-`) && name.endsWith(".json") && !name.endsWith(".result.json")) {
        fs.unlinkSync(path.join(residualRunDir, name));
      }
    }

    resetWorkerLaunches();
    let residualResumeError;
    let residualResumed;
    try {
      residualResumed = await call(wsResidual, {
        resume: residualRunId,
        supervision: "off",
        preflight: false,
        workerExecutionConstraints: override,
      });
    } catch (error) {
      residualResumeError = error;
    }
    const residualResumeLaunches = readWorkerLaunches();

    assert.ok(residualResumeError instanceof Error,
      `[${label}] resuming with a workerExecutionConstraints override that omits testAuthorization must be ` +
      "refused, not silently re-derived into a fresh historical policy");
    assert.match(residualResumeError.message, /Worker execution constraint drift refused/,
      `[${label}] the refusal must use the existing noForceKill drift-refusal pattern`);
    assert.match(residualResumeError.message, new RegExp(residualStoredTestAuthorization.policyHash.slice(0, 16)),
      `[${label}] the refusal must name the frozen stored policyHash`);
    assert.equal(residualResumeLaunches.length, 0,
      `[${label}] the refused resume must not spawn any worker under a re-derived historical policy`);
    assert.equal(residualResumed, undefined,
      `[${label}] a refused resume must throw before producing a tool result`);
  }

  console.log(
    "PASS package contract freeze residual: a legacy resume whose workerExecutionConstraints override omits " +
    "testAuthorization entirely (by passing {} or an object naming only an unrelated field) is refused via the " +
    "same drift-refusal pattern, for both the empty-object and noForceKill-only override shapes.",
  );

  // ── Review 28 finding 1 ("the frozen no-force-kill guard can still be
  // dropped on a legacy resume by a deliberate nested override; the top-level
  // drift check reads a field legacy runs never persist"), fixed test-first
  // in this pass alongside the NULL-TIMEOUT-ALLOWED fix. Two scenarios, both
  // from a legacy plan-execute-verify run whose top-level `noForceKill: true`
  // is declared at the public tool boundary; that path persists
  // NormalizedParams, so only the nested `workerExecutionConstraints.
  // noForceKill` is ever stored, never a top-level field.
  async function makeReview28NoForceKillRun(label) {
    const ws = makeWorkspace(`review28-${label}`);
    resetWorkerLaunches();
    const initial = await call(ws, {
      task: TASK, paradigm: "plan-execute-verify", supervision: "off", preflight: false,
      cwd: ws, maxRetries: 0, noForceKill: true,
    });
    const runId = initial?.details?.runId;
    assert.equal(typeof runId, "string", `[${label}] the initial review-28 run must persist a resumable run id`);
    assert.ok(readWorkerLaunches().length > 0, `[${label}] the initial review-28 run must spawn its workers`);

    const runDir = path.join(RUNS_ROOT, runId);
    const stateFile = path.join(runDir, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.params?.noForceKill, undefined,
      `[${label}] the legacy plan-execute-verify path persists NormalizedParams, which never carries a ` +
      "top-level noForceKill field");
    assert.equal(state.params?.workerExecutionConstraints?.noForceKill, true,
      `[${label}] the frozen noForceKill for this path lives only in the nested workerExecutionConstraints object`);
    const storedTestAuthorization = state.params?.workerExecutionConstraints?.testAuthorization;
    assert.ok(storedTestAuthorization?.policyHash, `[${label}] the persisted review-28 run must carry its admission-frozen policy`);

    const phase = state.phases[state.phases.length - 1];
    assert.equal(phase.status, "done", `[${label}] the full initial review-28 run must finish with every phase checkpointed`);
    phase.status = "pending";
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    for (const name of fs.readdirSync(runDir)) {
      if (name.startsWith(`phase-${phase.index}-`) && name.endsWith(".json") && !name.endsWith(".result.json")) {
        fs.unlinkSync(path.join(runDir, name));
      }
    }
    return { ws, runId, storedTestAuthorization };
  }

  // Scenario A: a nested workerExecutionConstraints override repeats the
  // stored testAuthorization EXACTLY (so the testAuthorization-drift check
  // above never fires) but flips noForceKill to false. Before this fix
  // nothing refused this, and the resumed worker launched without the guard.
  {
    const { ws, runId, storedTestAuthorization } = await makeReview28NoForceKillRun("nfk-drift");
    resetWorkerLaunches();
    let resumeError;
    try {
      await call(ws, {
        resume: runId,
        supervision: "off",
        preflight: false,
        workerExecutionConstraints: {
          noForceKill: false,
          testAuthorization: JSON.parse(JSON.stringify(storedTestAuthorization)),
        },
      });
    } catch (error) {
      resumeError = error;
    }
    const resumeLaunches = readWorkerLaunches();
    assert.ok(resumeError instanceof Error,
      "resuming with a nested noForceKill override that disagrees with the frozen value must be refused even " +
      "when the override repeats the stored testAuthorization exactly");
    assert.match(resumeError.message, /Worker execution constraint drift refused/,
      "the refusal must use the existing drift-refusal pattern");
    assert.match(resumeError.message, /frozen noForceKill=true/,
      "the refusal must name the frozen noForceKill value");
    assert.equal(resumeLaunches.length, 0,
      "the refused resume must not spawn a worker with the guard silently dropped");
  }

  // Scenario B: resuming the SAME shape of run with a top-level noForceKill
  // override that matches the frozen value must NOT be refused. Before this
  // fix the drift check read only the (always-absent, for this path)
  // top-level frozen field and wrongly refused a request that actually
  // matched the frozen policy.
  {
    const { ws, runId } = await makeReview28NoForceKillRun("nfk-match");
    resetWorkerLaunches();
    let resumeError;
    let resumed;
    try {
      resumed = await call(ws, { resume: runId, supervision: "off", preflight: false, noForceKill: true });
    } catch (error) {
      resumeError = error;
    }
    assert.equal(resumeError, undefined,
      "resuming with a top-level noForceKill override that matches the nested frozen value must not be refused " +
      `as drift${resumeError ? `: ${resumeError.message}` : ""}`);
    assert.ok(resumed, "the accepted resume must produce a tool result");
    const resumeLaunches = readWorkerLaunches();
    assert.ok(resumeLaunches.length > 0, "the accepted resume must actually spawn its remaining worker");
    for (const launch of resumeLaunches) {
      assert.ok((launch.explicitExtensions || []).some((entry) => entry.endsWith("worker-execution-constraints.ts")),
        "the resumed worker must still load the no-force-kill guard extension");
    }
  }

  console.log(
    "PASS package contract freeze review-28: a legacy resume's nested noForceKill override that disagrees with " +
    "the frozen value is refused even when it repeats the stored testAuthorization exactly, and a matching " +
    "top-level noForceKill override on resume is correctly accepted rather than wrongly refused as drift.",
  );

  // ── Review 29 finding 1 ("the NOFK-RESUME fix is incomplete: a legacy
  // resume whose nested workerExecutionConstraints override repeats the
  // stored testAuthorization exactly but OMITS noForceKill is still accepted,
  // and the resumed worker launches without the guard"). Unlike scenario A
  // above (which flips nested noForceKill to an explicit false), this
  // scenario never names noForceKill at all: the review-28 nested check only
  // ever fires when `overrides.workerExecutionConstraints.noForceKill` is
  // explicitly present, so a bare omission slipped through both the
  // top-level and nested drift checks, and the wholesale replacement of the
  // stored workerExecutionConstraints then silently dropped the frozen
  // nested noForceKill: true before this fix.
  {
    const { ws, runId, storedTestAuthorization } = await makeReview28NoForceKillRun("nfk-omit");
    resetWorkerLaunches();
    let resumeError;
    let resumed;
    try {
      resumed = await call(ws, {
        resume: runId,
        supervision: "off",
        preflight: false,
        workerExecutionConstraints: {
          testAuthorization: JSON.parse(JSON.stringify(storedTestAuthorization)),
        },
      });
    } catch (error) {
      resumeError = error;
    }
    const resumeLaunches = readWorkerLaunches();
    assert.ok(resumeError instanceof Error,
      "resuming with a nested workerExecutionConstraints override that repeats the stored testAuthorization " +
      "exactly but OMITS noForceKill entirely must be refused, not silently accepted with the guard dropped");
    assert.match(resumeError.message, /Worker execution constraint drift refused/,
      "the refusal must use the existing drift-refusal pattern");
    assert.match(resumeError.message, /frozen noForceKill=true/,
      "the refusal must name the frozen noForceKill value");
    assert.equal(resumeLaunches.length, 0,
      "the refused resume must not spawn a worker with the guard silently dropped by omission");
    assert.equal(resumed, undefined, "a refused resume must throw before producing a tool result");
  }

  console.log(
    "PASS package contract freeze review-29: a legacy resume's nested workerExecutionConstraints override that " +
    "repeats the stored testAuthorization exactly but omits noForceKill entirely is refused, closing the gap " +
    "left by the review-28 fix (which only caught an explicit disagreeing nested value).",
  );
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
