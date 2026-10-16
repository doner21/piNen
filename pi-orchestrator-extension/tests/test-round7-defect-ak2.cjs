#!/usr/bin/env node
/** AK2: paused runs retire only after conclusive host/worker death and survivor exclusion. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const supervision = jiti(path.join(ROOT, "src", "supervision.ts"));
const orchestrator = jiti(path.join(ROOT, "src", "index.ts"));

const HOST_PID = 41001;
const HOST_STARTED_AT = 1_700_000_000_000;
const WORKER_PID = 41002;
const DEAD_HOST_PAUSE = `process_restart_requires_fresh_visible_main_approval; owning_host_pid_dead: pid=${HOST_PID}; probe=ESRCH`;

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function directoryDigest(root) {
  const entries = [];
  function walk(dir, prefix = "") {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const absolute = path.join(dir, item.name);
      assert.ok(!fs.lstatSync(absolute).isSymbolicLink(), "fixture artifacts must not be links");
      if (item.isDirectory()) {
        entries.push([relative + "/", "directory"]); // Also fence empty additions/removals.
        walk(absolute, relative);
      } else {
        assert.ok(item.isFile(), "fixture artifacts must be regular files");
        entries.push([relative, crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
      }
    }
  }
  walk(root);
  return entries;
}

function createPausedRun(root, runId, options = {}) {
  const runDir = path.join(root, runId);
  const mission = supervision.createFrozenMission({
    originalTask: "Create a bounded fixture artifact.",
    cwd: runDir,
    worktree: { root: runDir, realRoot: runDir, branch: "fixture", baseline: "fixture" },
    paradigm: "plan-execute-verify",
    lane: "orchestrator-maintenance",
    routes: [], constraints: [], nonGoals: [],
    acceptanceCriteria: [{ id: "AC-01", text: "fixture remains bounded", required: true }],
  });
  let state = supervision.createInitialSupervisionState({ runId, mission, tasks: [] });
  state = supervision.restartToPaused(state, new Date("2026-09-11T00:00:00.000Z"));
  state.pauseReason = DEAD_HOST_PAUSE;
  state.runtime = {
    kind: "legacy-pev",
    params: {}, intake: {}, plan: { tasks: [], notes: "fixture" },
    completedTaskIds: [], executorOutputs: [],
    contentBaseline: { root: runDir, files: {}, fileCount: 0, totalBytes: 0, truncated: false, omitted: [], limits: { maxFiles: 1, maxBytes: 1 } },
    repairCount: 0,
    ...(options.legacyUnknown ? {} : { hostInstanceId: `${HOST_PID}:${HOST_STARTED_AT}` }),
  };
  if (options.auditActive) state.audit.activeWorkers = [{ pid: options.auditActive.pid, phase: "executor" }];
  if (options.auditDetached) state.audit.detachedWorkers = [{ pid: options.auditDetached.pid, phase: "executor" }];
  const store = new supervision.SupervisionStateStore(runId, root);
  store.create(state);
  json(path.join(runDir, "state.json"), {
    runId, paradigm: "plan-execute-verify", task: "fixture", createdAt: state.createdAt,
    params: {}, phases: options.detachedPhase
      ? [{ index: 0, name: "worker", status: "detached" }]
      : options.pendingPhase
        ? [{ index: 0, name: "worker", status: "pending" }]
        : [],
  });
  if (options.runningSidecar) {
    json(path.join(runDir, "phase-0-worker.result.json"), {
      schemaVersion: 1, kind: "subagent-phase-result", status: "running", launchId: "fixture-launch",
      agentName: "coder", taskSha256: "a".repeat(64), startedAt: new Date(HOST_STARTED_AT + 1).toISOString(),
      heartbeatAt: new Date(HOST_STARTED_AT + 1_000).toISOString(), heartbeatSequence: 1, eventCount: 1,
      pid: options.runningSidecar.pid,
    });
  }
  if (options.incompleteSidecar) {
    json(path.join(runDir, "phase-0-worker.result.json"), {
      schemaVersion: 1, kind: "subagent-phase-result", status: "incomplete", launchId: "fixture-launch",
      agentName: "coder", taskSha256: "a".repeat(64), startedAt: new Date(HOST_STARTED_AT + 1).toISOString(),
      heartbeatAt: new Date(HOST_STARTED_AT + 1_000).toISOString(), heartbeatSequence: 1, eventCount: 1,
      pid: options.incompleteSidecar.pid,
    });
  }
  if (options.survivorManifest) {
    json(path.join(runDir, "survivor-0-worker.json"), {
      pid: options.survivorManifest.pid, agentName: "coder", phaseName: "worker", phaseIndex: 0,
      startedAt: HOST_STARTED_AT + 1, detachedAt: "2026-09-11T00:00:00.000Z",
      resultFile: path.join(runDir, "survivor-0-worker.result.json"),
    });
  }
  if (options.malformedState) fs.writeFileSync(path.join(runDir, "state.json"), "{not-json\n", "utf8");
  return { runDir, store };
}

function sequenceObserver(sequences) {
  const counts = new Map();
  return (pid) => {
    const values = sequences.get(pid);
    assert.ok(values, `unexpected process observation for pid ${pid}`);
    const index = counts.get(pid) ?? 0;
    counts.set(pid, index + 1);
    return values[Math.min(index, values.length - 1)];
  };
}

// Only this exact top-level derived publication may change. Ownership, approval,
// state, sidecars, survivors and even unrecognised artifacts remain byte-fenced.
function assertNonDerivedUnchanged(before, after, message) {
  for (const entries of [before, after]) assert.equal(entries.filter(([name]) => name === "live-status.json").length, 1);
  const protectedEntries = entries => entries.filter(([name]) => name !== "live-status.json");
  assert.deepEqual(protectedEntries(after), protectedEntries(before), message);
}

function assertLivePublication(live, runId, options, started, finished) {
  assert.equal(new Date(live.observedAt).toISOString(), live.observedAt);
  assert.ok(Date.parse(live.observedAt) >= started && Date.parse(live.observedAt) <= finished, "read publishes a fresh observation");
  // Retirement's injected observations are separate from the status reader's
  // default probes, which this fixture deliberately makes unavailable. Thus a
  // stale heartbeat or a survivor must remain unknown, never proven absent.
  let worker;
  const audit = options.auditActive ?? options.auditDetached;
  const sidecar = options.runningSidecar ?? options.incompleteSidecar;
  if (audit?.pid) worker = { pid: audit.pid, phase: "executor", liveness: "unknown" };
  else if (sidecar) worker = { pid: sidecar.pid, phase: "worker", liveness: "unknown",
    heartbeatAt: new Date(HOST_STARTED_AT + 1_000).toISOString(), launchId: "fixture-launch" };
  else if (options.survivorManifest) worker = { pid: options.survivorManifest.pid, phase: "worker", liveness: "unknown" };
  const errors = live.observationErrors;
  assert.ok(Array.isArray(errors));
  const probeErrors = [...(options.legacyUnknown ? [] : [HOST_PID]), ...(worker ? [worker.pid] : [])]
    .map(pid => `PID ${pid}: process_probe_failed`);
  if (options.malformedState) {
    assert.match(errors[0], /^state\.json: /);
    assert.equal(errors[1], "state.json: phase manifest unavailable");
    assert.deepEqual(errors.slice(2), probeErrors);
  } else assert.deepEqual(errors, probeErrors);
  assert.deepEqual(live, {
    schemaVersion: 1, runId, observedAt: live.observedAt, going: "unknown",
    phase: worker?.phase ?? null, activeWorkers: worker ? [worker] : [],
    heartbeatAt: worker?.heartbeatAt ?? null, activeSilenceAlarms: [],
    lastError: DEAD_HOST_PAUSE, observationErrors: errors,
  }, "derived status reflects fixture identity, uncertainty, workers, heartbeat and last error");
}

function assertRejectedByteIdentical(root, runId, observer, expectedCode, options = {}) {
  const runDir = path.join(root, runId);
  const before = directoryDigest(runDir);
  const started = Date.now();
  const result = orchestrator.retireConclusivePausedRuns({ rootDir: root, observeProcess: observer });
  const finished = Date.now();
  assert.equal(result.retired.includes(runId), false, `${runId} must not retire`);
  assert.equal(result.rejected.find((item) => item.runId === runId)?.code, expectedCode);
  assertNonDerivedUnchanged(before, directoryDigest(runDir), `${runId}: all non-derived bytes remain unchanged`);
  const live = JSON.parse(fs.readFileSync(path.join(runDir, "live-status.json"), "utf8"));
  assertLivePublication(live, runId, options, started, finished);
  // Prove that the exception cannot conceal any authoritative mutation, missing
  // artifact, arbitrary addition, or a same-named publication in a subdirectory.
  for (const [name] of before.filter(([name]) => name !== "live-status.json")) {
    assert.throws(() => assertNonDerivedUnchanged(before, before.map(entry => entry[0] === name ? [name, "changed"] : entry)), assert.AssertionError);
    assert.throws(() => assertNonDerivedUnchanged(before, before.filter(entry => entry[0] !== name)), assert.AssertionError);
  }
  for (const name of ["unexpected.bin", "nested/live-status.json", "empty/"]) {
    assert.throws(() => assertNonDerivedUnchanged(before, [...before, [name, "unexpected"]]), assert.AssertionError);
  }
  assert.throws(() => assertLivePublication({ ...live, going: "not going" }, runId, options, started, finished), assert.AssertionError);
  if (live.activeWorkers.length) assert.throws(() => assertLivePublication({ ...live, activeWorkers: [] }, runId, options, started, finished), assert.AssertionError);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak2-runs-"));
const originalKill = process.kill;
try {
  process.kill = () => { throw new Error("AK2 tests must use injected observations, never real process probes"); };

  createPausedRun(root, "eligible", { runningSidecar: { pid: WORKER_PID } });
  const eligible = orchestrator.retireConclusivePausedRuns({
    rootDir: root,
    observeProcess: sequenceObserver(new Map([
      [HOST_PID, [{ status: "dead", evidence: "ESRCH" }]],
      [WORKER_PID, [{ status: "dead", evidence: "ESRCH" }]],
    ])),
    now: () => new Date("2026-09-11T01:00:00.000Z"),
  });
  assert.deepEqual(eligible.retired, ["eligible"]);
  const retired = JSON.parse(fs.readFileSync(path.join(root, "eligible", "supervision.json"), "utf8"));
  assert.equal(retired.status, "terminal");
  assert.equal(retired.terminalOutcome, "retired_dead_host");
  assert.notEqual(retired.terminalOutcome, "pass");
  assert.equal(retired.pauseReason, DEAD_HOST_PAUSE, "the dead-host-only pause reason remains unchanged");
  assert.equal(retired.retirement.code, "conclusively_orphaned_paused_run");
  assert.match(retired.retirement.reason, /owning host.*conclusively dead/i);
  assert.equal(retired.checkpoints.at(-1).kind, "retirement");
  assert.equal(retired.checkpoints.at(-1).outcome, "retired_dead_host");
  assert.equal(supervision.buildInspectionSnapshot(retired).retirement.reason, retired.retirement.reason,
    "read-only inspection exposes the persisted retirement reason");

  const rejectionCases = [
    ["live-host", {}, new Map([[HOST_PID, [{ status: "alive", startedAt: HOST_STARTED_AT }]]]), "owning_host_live"],
    ["reused-host-pid", {}, new Map([[HOST_PID, [{ status: "alive", startedAt: HOST_STARTED_AT + 99_999 }]]]), "owning_host_pid_reused"],
    ["ambiguous-host", {}, new Map([[HOST_PID, [{ status: "unknown", reason: "ambiguous probe" }]]]), "owning_host_liveness_unknown"],
    ["inaccessible-host", {}, new Map([[HOST_PID, [{ status: "unknown", reason: "EPERM" }]]]), "owning_host_liveness_unknown"],
    ["legacy-unknown", { legacyUnknown: true }, new Map(), "owning_host_identity_unknown"],
    ["live-worker", { runningSidecar: { pid: WORKER_PID } }, new Map([
      [HOST_PID, [{ status: "dead", evidence: "ESRCH" }]],
      [WORKER_PID, [{ status: "alive", startedAt: HOST_STARTED_AT + 1 }]],
    ]), "active_worker_live"],
    ["reused-worker-pid", { runningSidecar: { pid: WORKER_PID } }, new Map([
      [HOST_PID, [{ status: "dead", evidence: "ESRCH" }]],
      [WORKER_PID, [{ status: "alive", startedAt: HOST_STARTED_AT + 99_999 }]],
    ]), "active_worker_pid_reused"],
    ["ambiguous-worker", { runningSidecar: { pid: WORKER_PID } }, new Map([
      [HOST_PID, [{ status: "dead", evidence: "ESRCH" }]],
      [WORKER_PID, [{ status: "unknown", reason: "EPERM" }]],
    ]), "active_worker_liveness_unknown"],
    ["missing-worker-pid", { auditActive: {} }, new Map([[HOST_PID, [{ status: "dead", evidence: "ESRCH" }]]]), "active_worker_identity_unknown"],
    ["detached-audit", { auditDetached: { pid: WORKER_PID } }, new Map([[HOST_PID, [{ status: "dead", evidence: "ESRCH" }]]]), "detached_worker_present"],
    ["detached-phase", { detachedPhase: true }, new Map([[HOST_PID, [{ status: "dead", evidence: "ESRCH" }]]]), "survivor_present"],
    ["survivor-manifest", { survivorManifest: { pid: WORKER_PID } }, new Map([[HOST_PID, [{ status: "dead", evidence: "ESRCH" }]]]), "survivor_present"],
    ["incomplete-sidecar", { incompleteSidecar: { pid: WORKER_PID } }, new Map([[HOST_PID, [{ status: "dead", evidence: "ESRCH" }]]]), "worker_settlement_ambiguous"],
    ["malformed-run-state", { malformedState: true }, new Map([[HOST_PID, [{ status: "dead", evidence: "ESRCH" }]]]), "run_state_inaccessible"],
  ];
  for (const [runId, options, observations, expectedCode] of rejectionCases) {
    createPausedRun(root, runId, options);
    assertRejectedByteIdentical(root, runId, sequenceObserver(observations), expectedCode, options);
  }

  createPausedRun(root, "revalidation-race");
  assertRejectedByteIdentical(root, "revalidation-race", sequenceObserver(new Map([
    [HOST_PID, [
      { status: "dead", evidence: "ESRCH" },
      { status: "alive", startedAt: HOST_STARTED_AT },
    ]],
  ])), "owning_host_live");

  const source = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  assert.match(source, /settleOnAbort:\s*true/, "AB settle-on-abort remains enabled");
  assert.match(source, /createSupervisedPauseInteraction/, "AB pause UI remains wired");
  assert.doesNotMatch(source, /process\.kill\([^,]+,\s*(?!0\b)/, "retirement never force-kills a host or worker");

  console.log("test-round7-defect-ak2: only conclusively orphaned paused runs retire; all live, unknown, reused-PID, and survivor candidates retain every non-derived byte; live status is checked");
} finally {
  process.kill = originalKill;
  fs.rmSync(root, { recursive: true, force: true });
}
