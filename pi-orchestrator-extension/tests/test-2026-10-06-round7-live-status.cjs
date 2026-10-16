#!/usr/bin/env node
"use strict";
/** Read actual supervision/phase files with deterministic process observations.
 * Existing baseline read/inspection APIs are used; a missing projection is an
 * assertion failure, never an import failure. All roots predate product imports.
 * Projection contract: live-status.json and inspection.liveStatus expose going
 * ('going'/'not going'/'unknown'), phase, activeWorkers, heartbeatAt,
 * activeSilenceAlarms, lastError. Durable execution status remains separate.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = process.env.ROUND7_BASELINE_SOURCE_ROOT ? path.resolve(process.env.ROUND7_BASELINE_SOURCE_ROOT) : ROOT;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "orch-r7-status-"));
for (const [key, dir] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_ORCHESTRATOR_RUNS_ROOT: "runs", PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next" })) {
  process.env[key] = path.join(SCRATCH, dir);
  fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = SCRATCH;
process.env.PI_OFFLINE = "1";
const PI_MODULES = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti/lib/jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const timing = fs.existsSync(path.join(SOURCE_ROOT, "src/command-times.ts")) ? jiti(path.join(SOURCE_ROOT, "src/command-times.ts")) : {};
const supervision = jiti(path.join(SOURCE_ROOT, "src/supervision.ts"));
const ts = require(path.join(ROOT, "node_modules/typescript"));
const HOST = 45001, WORKER = 45002, SECOND = 45003;
const START = Date.parse("2026-10-06T12:00:00Z"), NOW = new Date(START + 600000);
const dead = { status: "dead", evidence: "ESRCH" };
const alive = { status: "alive", startedAt: START };
function json(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function fixture(id, options = {}) {
  const runDir = path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, id);
  fs.mkdirSync(runDir, { recursive: true });
  const mission = supervision.createFrozenMission({ originalTask: "Observe owned fixture.", cwd: runDir,
    worktree: { root: runDir, realRoot: runDir, branch: "fixture", baseline: "fixture" }, paradigm: "plan-execute-verify",
    lane: "orchestrator-maintenance", routes: [], constraints: [], nonGoals: [], acceptanceCriteria: [{ id: "AC-01", text: "fixture", required: true }] });
  const state = supervision.createInitialSupervisionState({ runId: id, mission, tasks: [] });
  state.status = options.status ?? "executing";
  state.createdAt = new Date(START).toISOString();
  state.updatedAt = new Date(START).toISOString();
  state.runtime = { kind: "legacy-pev", params: {}, intake: {}, plan: { tasks: [], notes: "fixture" },
    completedTaskIds: [], executorOutputs: [], repairCount: 0,
    contentBaseline: { root: runDir, files: {}, fileCount: 0, totalBytes: 0, truncated: false, omitted: [], limits: { maxFiles: 100, maxBytes: 10000 } },
    ...(options.missingHost ? {} : { hostInstanceId: `${HOST}:${START}` }) };
  state.audit.activeWorkers = options.workers ?? [];
  if (options.lastError) state.audit.infrastructureFailures.push({ infrastructure: true, code: "orchestrator", message: options.lastError });
  const store = new supervision.SupervisionStateStore(id, process.env.PI_ORCHESTRATOR_RUNS_ROOT);
  store.create(state, { now: NOW, observeProcess: () => dead });
  json(path.join(runDir, "state.json"), { runId: id, paradigm: "plan-execute-verify", createdAt: state.createdAt, task: "fixture", params: {}, phases: options.workers?.map((w, index) => ({ index, name: w.phase, status: "running", pid: w.pid })) ?? [] });
  return { store, state, runDir };
}
function sidecar(f, index, pid, options = {}) {
  const file = path.join(f.runDir, `phase-${index}-executor.result.json`);
  json(file, { schemaVersion: 1, kind: "subagent-phase-result", status: options.status ?? "running", launchId: `launch-${index}`,
    agentName: "coder", taskSha256: "a".repeat(64), startedAt: new Date(START).toISOString(),
    heartbeatAt: new Date(options.heartbeat ?? NOW.getTime()).toISOString(), heartbeatSequence: 7, eventCount: 3, pid,
    ...(options.status === "complete" ? { completedAt: NOW.toISOString() } : {}) });
  return file;
}
function read(f, observations) {
  const observeProcess = pid => {
    assert.ok(observations.has(pid), `all process observations must be injected: ${pid}`);
    return observations.get(pid);
  };
  const options = { now: NOW, runDir: f.runDir, observeProcess };
  const original = fs.readFileSync(f.store.stateFile);
  const loaded = f.store.loadReadOnly(options);
  const inspection = supervision.buildInspectionSnapshot(loaded, options);
  assert.ok(original.equals(fs.readFileSync(f.store.stateFile)), "status refresh must not rewrite durable mission/checkpoint state");
  return { inspection, live: inspection.liveStatus ?? inspection };
}
function authoritative(f, live) {
  const file = path.join(f.runDir, "live-status.json");
  assert.ok(fs.existsSync(file), "every status read must publish the authoritative per-run live-status.json");
  const published = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(published.going, live.going);
  assert.deepEqual(published.activeWorkers, live.activeWorkers);
  assert.deepEqual(published.activeSilenceAlarms, live.activeSilenceAlarms);
}
const failures = [];
function check(id, body) {
  try { body(); console.log(`PASS ${id}`); }
  catch (error) { failures.push({ id, error: error.message }); console.log(`RED ${id}: ${error.message}`); }
}
function describe(relative) {
  const file = path.join(SOURCE_ROOT, relative), text = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(item => item.name?.text === "describeJsonEvent");
  assert.ok(node, "baseline alarm formatter exists");
  const context = vm.createContext({ optionalString: value => typeof value === "string" ? value : undefined });
  vm.runInContext(ts.transpileModule(node.getText(ast) + "\nglobalThis.describe = describeJsonEvent;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.describe;
}
const originalKill = process.kill;
let realProbes = 0;
try {
  process.kill = () => { realProbes++; throw new Error("real process probes/signals are forbidden in this regression"); };
  check("existing dead-host reconciliation remains conservative", () => {
    assert.match(supervision.deadOwningHostPauseReason(`${HOST}:${START}`, () => dead), /owning_host_pid_dead/);
    assert.equal(supervision.deadOwningHostPauseReason(`${HOST}:${START}`, () => alive), undefined);
    assert.equal(supervision.deadOwningHostPauseReason(`${HOST}:${START}`, () => ({ status: "unknown", reason: "EPERM" })), undefined);
    assert.equal(supervision.deadOwningHostPauseReason(undefined, () => { throw new Error("unknown identity must not be probed"); }), undefined);
  });
  check("status projection does not change the reconciler's independent revalidation probes", () => {
    const f = fixture("reconciler-probes", { status: "paused" });
    f.state.pauseReason = `process_restart_requires_fresh_visible_main_approval; owning_host_pid_dead: pid=${HOST}; probe=ESRCH`;
    f.store.save(f.state, { now: NOW, observeProcess: () => dead });
    let calls = 0;
    const outcome = f.store.retirePausedIfSafe({ now: () => NOW, observeProcess: pid => {
      assert.equal(pid, HOST); return calls++ === 0 ? dead : alive;
    } });
    assert.equal(calls, 2, "projection must not consume the discovery/revalidation observations");
    assert.equal(outcome.retired, false); assert.equal(outcome.assessment.code, "owning_host_live");
    assert.equal(JSON.parse(fs.readFileSync(f.store.stateFile, "utf8")).status, "paused");
  });
  check("authoritative file is refreshed on store reads and updates", () => {
    const f = fixture("authoritative");
    const options = { now: NOW, observeProcess: () => dead };
    f.store.loadReadOnly(options);
    const file = path.join(f.runDir, "live-status.json");
    assert.ok(fs.existsSync(file), "loadReadOnly must publish a derived live-status file, not just validate stale stored flags");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).going, "not going");
    const changed = f.store.loadReadOnly(options);
    changed.audit.infrastructureFailures.push({ infrastructure: true, code: "orchestrator", message: "FRESH_ERROR" });
    f.store.save(changed, options);
    assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).lastError).includes("FRESH_ERROR"), "update must refresh last error in the same authoritative file");
  });
  check("dead host and stale dead worker are not live", () => {
    const f = fixture("dead", { workers: [{ pid: WORKER, phase: "executor" }] });
    sidecar(f, 0, WORKER, { heartbeat: START });
    const { live } = read(f, new Map([[HOST, dead], [WORKER, dead]]));
    assert.equal(live.activeWorkers.length, 0, "stored activeWorkers must not establish liveness after conclusive death");
    assert.equal(live.going, "not going"); authoritative(f, live);
  });
  for (const [id, host, expected] of [["unknown", { status: "unknown", reason: "EPERM" }, "unknown"], ["reused", { status: "alive", startedAt: START + 99999 }, "unknown"], ["stale-alive", alive, "unknown"]]) {
    check(id, () => { const f = fixture(id); const { live } = read(f, new Map([[HOST, host]])); assert.equal(live.going, expected, "stored executing flag or stale identity cannot prove current activity"); authoritative(f, live); });
  }
  check("missing host identity is unknown", () => { const f = fixture("missing", { missingHost: true }); const { live } = read(f, new Map()); assert.equal(live.going, "unknown"); authoritative(f, live); });
  check("cancelled run preserves two actually surviving workers", () => {
    const f = fixture("cancelled", { status: "cancelled", workers: [{ pid: WORKER, phase: "executor" }, { pid: SECOND, phase: "reviewer" }] });
    sidecar(f, 0, WORKER); sidecar(f, 1, SECOND);
    const { live, inspection } = read(f, new Map([[HOST, dead], [WORKER, alive], [SECOND, alive]]));
    assert.equal(inspection.status, "cancelled", "observed liveness must not alter cancellation");
    assert.equal(live.going, "going", "real survivors outweigh cancelled launch state");
    assert.deepEqual(live.activeWorkers.map(w => w.pid).sort(), [WORKER, SECOND]);
    assert.deepEqual(live.activeWorkers.map(w => w.phase), ["executor", "reviewer"]);
    assert.deepEqual(inspection.activeWorkers, live.activeWorkers, "inspection must not retain a contradictory stored worker list");
    assert.ok(live.phase); assert.equal(live.heartbeatAt, NOW.toISOString()); authoritative(f, live);
  });
  check("worker probe failure does not prove no worker", () => {
    const f = fixture("worker-unknown", { workers: [{ pid: WORKER, phase: "executor" }] }); sidecar(f, 0, WORKER);
    const { live } = read(f, new Map([[HOST, dead], [WORKER, { status: "unknown", reason: "probe unavailable" }]]));
    assert.equal(live.going, "unknown"); authoritative(f, live);
  });
  check("running sidecar without a PID cannot establish activity", () => {
    const f = fixture("missing-worker-pid"); sidecar(f, 0, undefined);
    const { live } = read(f, new Map([[HOST, dead]])); assert.equal(live.going, "unknown"); authoritative(f, live);
  });
  check("unreadable phase observation is unknown", () => {
    const f = fixture("malformed"); fs.writeFileSync(path.join(f.runDir, "phase-0-executor.result.json"), "{malformed");
    const { live } = read(f, new Map([[HOST, dead]])); assert.equal(live.going, "unknown"); authoritative(f, live);
  });
  check("fresh owning host is observed, stopped runs do not inherit host activity", () => {
    for (const status of ["executing", "cancelled", "terminal"]) {
      const f = fixture(`fresh-host-${status}`, { status });
      f.state.updatedAt = NOW.toISOString();
      f.store.save(f.state, { now: NOW, observeProcess: () => alive });
      const { live } = read(f, new Map([[HOST, alive]]));
      assert.equal(live.going, status === "executing" ? "going" : "not going"); authoritative(f, live);
    }
  });
  check("stale and reused worker observations are not healthy", () => {
    for (const reused of [false, true]) {
      const f = fixture(`worker-stale-${reused}`, { workers: [{ pid: WORKER, phase: "executor" }] });
      sidecar(f, 0, WORKER, { heartbeat: reused ? NOW.getTime() : START });
      const { live } = read(f, new Map([[HOST, dead], [WORKER, reused ? { status: "alive", startedAt: NOW.getTime() + 99999 } : alive]]));
      assert.equal(live.going, "unknown"); authoritative(f, live);
    }
  });
  check("survivor manifests cannot be hidden by stopped state", () => {
    const f = fixture("detached-survivor", { status: "cancelled" });
    json(path.join(f.runDir, "survivor-0-executor.json"), { pid: WORKER, phaseName: "executor", startedAt: START, detachedAt: NOW.toISOString() });
    const { live } = read(f, new Map([[HOST, dead], [WORKER, alive]]));
    assert.equal(live.activeWorkers.length, 1); assert.equal(live.activeWorkers[0].pid, WORKER);
    assert.equal(live.going, "unknown", "manifest without a current heartbeat cannot prove health or absence"); authoritative(f, live);
  });
  check("legacy run-state status read refreshes the same projection", () => {
    const f = fixture("run-state-read");
    fs.rmSync(path.join(f.runDir, "live-status.json"), { force: true });
    const runState = jiti(path.join(SOURCE_ROOT, "src/run-state.ts"));
    runState.RunStateStore.load(f.state.runId, { now: NOW, observeProcess: () => dead });
    assert.ok(fs.existsSync(path.join(f.runDir, "live-status.json")), "legacy status read must publish a projection");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.runDir, "live-status.json"), "utf8")).going, "not going");
  });
  check("failed status reads publish uncertainty without altering the real error", () => {
    const f = fixture("failed-status-read");
    fs.writeFileSync(f.store.stateFile, "{unreadable");
    assert.throws(() => f.store.loadReadOnly({ now: NOW, observeProcess: () => dead }), SyntaxError);
    assert.ok(fs.existsSync(path.join(f.runDir, "live-status.json")), "failed status read must publish uncertainty");
    const published = JSON.parse(fs.readFileSync(path.join(f.runDir, "live-status.json"), "utf8"));
    assert.equal(published.going, "unknown");
    assert.ok(JSON.stringify(published.lastError).includes("supervision.json"));
    assert.equal(fs.readFileSync(f.store.stateFile, "utf8"), "{unreadable", "bad durable evidence stays untouched");
  });
  check("invalid frozen bindings do not publish a healthy or misidentified status", () => {
    for (const bad of ["mission", "run-id"]) {
      const f = fixture(`invalid-binding-${bad}`);
      const corrupted = structuredClone(f.state);
      if (bad === "mission") corrupted.mission.originalTask += " changed";
      else corrupted.runId = "wrong-run";
      json(f.store.stateFile, corrupted);
      const original = fs.readFileSync(f.store.stateFile);
      assert.throws(() => f.store.loadReadOnly({ now: NOW, observeProcess: () => dead }));
      assert.ok(fs.existsSync(path.join(f.runDir, "live-status.json")), "rejected bindings must publish uncertainty");
      const published = JSON.parse(fs.readFileSync(path.join(f.runDir, "live-status.json"), "utf8"));
      assert.equal(published.going, "unknown"); assert.equal(published.runId, path.basename(f.runDir));
      assert.ok(JSON.stringify(published.lastError).includes("supervision.json") || JSON.stringify(published.lastError).includes("identity mismatch"));
      assert.ok(original.equals(fs.readFileSync(f.store.stateFile)), "rejected bindings must never be rewritten");
    }
  });
  check("missing phase manifest does not prove no surviving worker", () => {
    const f = fixture("missing-manifest");
    fs.rmSync(path.join(f.runDir, "state.json"));
    const { live } = read(f, new Map([[HOST, dead]])); assert.equal(live.going, "unknown"); authoritative(f, live);
  });
  check("unknown phase metadata cannot become proven absence", () => {
    const f = fixture("unknown-phase-metadata");
    const file = path.join(f.runDir, "state.json"), manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.phases = [{ index: 0, name: "worker", status: "unknown-format", pid: WORKER }]; json(file, manifest);
    const { live } = read(f, new Map([[HOST, dead], [WORKER, alive]]));
    assert.equal(live.going, "unknown"); assert.equal(live.activeWorkers[0].pid, WORKER); authoritative(f, live);
  });
  check("old failure sidecars cannot hide a freshly observed error", () => {
    const f = fixture("latest-error", { lastError: "NEW_INFRASTRUCTURE_ERROR" });
    f.state.updatedAt = NOW.toISOString();
    json(path.join(f.runDir, "phase-0-executor.result.json"), { kind: "subagent-phase-result", status: "incomplete", startedAt: new Date(START).toISOString(), heartbeatAt: new Date(START).toISOString(), completedAt: new Date(START).toISOString(), incompleteReason: "OLD_ADMISSION_ERROR" });
    f.store.save(f.state, { now: NOW, observeProcess: () => dead });
    const { live } = read(f, new Map([[HOST, dead]]));
    assert.ok(JSON.stringify(live.lastError)?.includes("NEW_INFRASTRUCTURE_ERROR"), "the latest real error must remain visible"); authoritative(f, live);
  });
  check("alarm evidence remains visible when phase sidecar is unavailable", () => {
    const f = fixture("orphan-alarm-log");
    const event = { type: "tool_execution_update", toolCallId: "call", partialResult: { details: { noOutputAlarm: { type: "command_no_output_alarm", commandId: "monitor-command", invocationId: "inv" } } } };
    fs.writeFileSync(path.join(f.runDir, "phase-0-executor.log"), `[stdout] ${JSON.stringify(event)}\n`);
    const { live } = read(f, new Map([[HOST, dead]]));
    assert.equal(live.going, "unknown"); assert.equal(live.activeSilenceAlarms.length, 1); authoritative(f, live);
  });
  check("recorder publishes PID immediately and preserves alarm identity across log capping", () => {
    const f = fixture("recorder");
    const file = path.join(SOURCE_ROOT, "src/substrate.ts"), text = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const declarations = ["SubagentPhaseResultRecorder", "isValidBoundPhaseResult"].map(name => {
      const node = ast.statements.find(item => item.name?.text === name);
      assert.ok(node); return node.getText(ast).replace(/^export\s+/, "");
    }).join("\n");
    const helperFile = path.join(SOURCE_ROOT, "src/live-status.ts");
    const helpers = fs.existsSync(helperFile) ? jiti(helperFile) : {};
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW.getTime()])); } static now() { return NOW.getTime(); } }
    const context = vm.createContext({ ...timing, Date: Clock, process, path, createHash: crypto.createHash, randomBytes: crypto.randomBytes,
      existsSync: fs.existsSync, readFileSync: fs.readFileSync,
      atomicWriteJsonSync: (file, value) => json(file, value), refreshLiveStatus: helpers.refreshLiveStatus, reduceSilenceAlarms: helpers.reduceSilenceAlarms });
    vm.runInContext(ts.transpileModule(declarations + "\nglobalThis.Recorder = SubagentPhaseResultRecorder;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const recorder = new context.Recorder(path.join(f.runDir, "phase-0-coder.result.json"), "coder", "fixture", START, { now: NOW, observeProcess: pid => pid === HOST ? dead : alive });
    recorder.heartbeat(1, WORKER);
    assert.equal(JSON.parse(fs.readFileSync(recorder.file, "utf8")).pid, WORKER, "spawn PID must not wait for a throttled heartbeat");
    const alarm = invocationId => ({ type: "tool_execution_update", toolCallId: "pi-call", partialResult: { content: [], details: { noOutputAlarm: { type: "command_no_output_alarm", commandId: "monitor-command", invocationId } } } });
    recorder.observeEvent(alarm("inv-1")); recorder.observeEvent(alarm("inv-2"));
    fs.writeFileSync(path.join(f.runDir, "phase-0-coder.log"), "[stdout] capped unrelated output\n");
    let current = read(f, new Map([[HOST, dead], [WORKER, alive]])).live;
    assert.equal(current.activeSilenceAlarms.length, 2);
    assert.equal(current.activeSilenceAlarms[0].toolCallId, "pi-call", "monitor command ID differs from Pi tool call ID");
    recorder.heartbeat(2, WORKER);
    recorder.observeEvent({ type: "tool_execution_end", toolCallId: "other-call" });
    assert.equal(read(f, new Map([[HOST, dead], [WORKER, alive]])).live.activeSilenceAlarms.length, 2);
    recorder.observeEvent({ type: "tool_execution_update", toolCallId: "pi-call", partialResult: { content: [{ type: "text", text: "actual renewed output" }] } });
    assert.equal(read(f, new Map([[HOST, dead], [WORKER, alive]])).live.activeSilenceAlarms.length, 0);
    recorder.observeEvent(alarm("inv-3")); recorder.incomplete("REAL_WORKER_FAILURE");
    current = read(f, new Map([[HOST, dead], [WORKER, alive]])).live;
    assert.equal(current.activeSilenceAlarms.length, 0); assert.equal(current.lastError, "REAL_WORKER_FAILURE"); authoritative(f, current);
  });
  for (const relative of ["src/substrate.ts", "src/index.ts"]) {
    for (const clearBy of ["output", "completion"]) check(`${relative} alarm/${clearBy}`, () => {
      const f = fixture(`${path.basename(relative)}-${clearBy}`, { workers: [{ pid: WORKER, phase: "executor" }], lastError: "REAL_FAILED_EVIDENCE" });
      sidecar(f, 0, WORKER);
      const log = path.join(f.runDir, "phase-0-executor.log"), format = describe(relative);
      const alarm = { type: "command_no_output_alarm", commandId: "call-1", invocationId: "inv-1", wallTime: NOW.toISOString(), elapsedMs: 300000, noOutputMs: 300000, eligibility: "alarm-only" };
      const event = { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: [], details: { noOutputAlarm: alarm } } };
      const formatted = format("coder", event);
      assert.match(formatted, /COMMAND_NO_OUTPUT_ALARM/);
      fs.appendFileSync(log, `[host] ${formatted}\n[stdout] ${JSON.stringify(event)}\n`);
      const observations = new Map([[HOST, dead], [WORKER, alive]]);
      let current = read(f, observations).live;
      assert.equal(current.activeSilenceAlarms?.length, 1, "alarm must be copied out of actual launcher log");
      assert.equal(current.activeSilenceAlarms[0].commandId, "call-1"); assert.ok(JSON.stringify(current.lastError).includes("REAL_FAILED_EVIDENCE")); authoritative(f, current);
      fs.appendFileSync(log, `[stdout] ${JSON.stringify({ type: "tool_execution_end", toolCallId: "different-command", toolName: "bash" })}\n`);
      sidecar(f, 0, WORKER, { heartbeat: NOW.getTime() + 1 });
      current = read(f, observations).live;
      assert.equal(current.activeSilenceAlarms.length, 1, "unrelated command completion and heartbeat must not clear the alarm");
      const clear = clearBy === "output"
        ? { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "renewed command output" }] } }
        : { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { exitCode: 1 } };
      fs.appendFileSync(log, `[stdout] ${JSON.stringify(clear)}\n`);
      current = read(f, observations).live;
      assert.equal(current.activeSilenceAlarms.length, 0, "matching renewed output/completion clears only the active alarm"); authoritative(f, current);
    });
  }
  check("monitor cancellation replay settles A only and retains silent B", () => {
    const f = fixture("invocation-replay", { workers: [{ pid: WORKER, phase: "executor" }] });
    sidecar(f, 0, WORKER);
    const log = path.join(f.runDir, "phase-0-executor.log");
    const content = [{ type: "text", text: "output before either alarm" }];
    const publish = partialResult => fs.appendFileSync(log, `[stdout] ${JSON.stringify({ type: "tool_execution_update", toolCallId: "pi-call", partialResult })}\n`);
    // worker-no-output-monitor publishes latestUpdate.content for both alarms
    // and cancellation notifications; neither notification is new bash output.
    for (const invocationId of ["inv-a", "inv-b"]) publish({ content, details: { noOutputAlarm: { type: "command_no_output_alarm", commandId: "monitor-command", invocationId } } });
    const observations = new Map([[HOST, dead], [WORKER, alive]]);
    assert.equal(read(f, observations).live.activeSilenceAlarms?.length, 2);
    const settlement = { schemaVersion: 1, outcome: "cancelled_no_output", commandId: "monitor-command", invocationId: "inv-a", cancellationConfirmed: true,
      confirmationBasis: "terminal_signal_after_owned_handle_action", terminalExitCode: null, terminalSignal: "SIGTERM" };
    for (const mismatch of [{ invocationId: "other-invocation" }, { commandId: "other-command" }, { cancellationConfirmed: false }]) {
      publish({ content, details: { noOutputCancellation: { ...settlement, ...mismatch } } });
      assert.equal(read(f, observations).live.activeSilenceAlarms.length, 2, "unmatched or unconfirmed settlement and its replay cannot clear alarms");
    }
    publish({ content, details: { noOutputCancellation: { schemaVersion: 1, outcome: "cancelled_no_output", commandId: "monitor-command", invocationId: "inv-a", cancellationConfirmed: true,
      confirmationBasis: "terminal_signal_after_owned_handle_action", terminalExitCode: null, terminalSignal: "SIGTERM" } } });
    let current = read(f, observations).live;
    assert.deepEqual(current.activeSilenceAlarms.map(item => item.invocationId), ["inv-b"], "A settlement must not clear B; replayed latestUpdate.content is not fresh output");
    publish({ content });
    assert.equal(read(f, observations).live.activeSilenceAlarms.length, 1, "identical cumulative text cannot renew output");
    publish({ content: [{ type: "text", text: "output before either alarm\nnew command output" }] });
    current = read(f, observations).live;
    assert.equal(current.activeSilenceAlarms.length, 0, "genuinely changed ordinary bash output renews command activity");
    // A capped log may retain an alarm without its cumulative content. Absence
    // of that baseline is unknown, not evidence that replayed text is fresh.
    publish({ details: { noOutputAlarm: { type: "command_no_output_alarm", commandId: "monitor-command", invocationId: "content-unknown" } } });
    publish({ content });
    current = read(f, observations).live;
    assert.equal(current.activeSilenceAlarms.length, 1, "unavailable alarm-time content cannot establish fresh output");
    authoritative(f, current);
  });
  check("actual monitor publications retain replay identity and matching settlement", () => {
    const f = fixture("actual-monitor-publication", { workers: [{ pid: WORKER, phase: "executor" }] });
    sidecar(f, 0, WORKER);
    const monitorFile = path.join(SOURCE_ROOT, "src/worker-no-output-monitor.ts");
    const ast = ts.createSourceFile(monitorFile, fs.readFileSync(monitorFile, "utf8"), ts.ScriptTarget.Latest, true);
    let cancellation, alarm, evidenceExpression;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "evidence" && node.initializer?.getText(ast).includes('outcome: "cancelled_no_output"')) evidenceExpression = node.initializer.getText(ast);
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "onUpdate") {
        const text = node.getText(ast);
        if (text.includes("noOutputCancellation: evidence")) cancellation = text;
        if (text.includes("noOutputAlarm:") && text.includes("invocationId: event.invocationId")) alarm = text;
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(cancellation && alarm && evidenceExpression, "extract the actual production monitor publication and receipt expressions");
    const log = path.join(f.runDir, "phase-0-executor.log");
    const content = [{ type: "text", text: "old cumulative output" }];
    const context = vm.createContext({ latestUpdate: { content }, commandId: "monitor-command", ackRequestId: "fixture-ack", event: {}, evidence: {},
      summary: "fixture receipt", redactActionText: value => value, captureResults: [], captureLog: "", artifact: undefined, hasArtifactReference: false,
      commandJournalPath: "fixture-journal", selectCancellationPartialLog: () => "",
      onUpdate: partialResult => fs.appendFileSync(log, `[stdout] ${JSON.stringify({ type: "tool_execution_update", toolCallId: "pi-call", partialResult })}\n`) });
    vm.runInContext(ts.transpileModule(`globalThis.makeEvidence = () => (${evidenceExpression}); globalThis.publishAlarm = () => { ${alarm}; }; globalThis.publishCancellation = () => { ${cancellation}; };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    for (const invocationId of ["A", "B"]) { context.event = { invocationId }; context.publishAlarm(); }
    const observations = new Map([[HOST, dead], [WORKER, alive]]);
    assert.equal(read(f, observations).live.activeSilenceAlarms.length, 2);
    context.evidence = context.makeEvidence(); context.evidence.invocationId = "other";
    context.publishCancellation();
    assert.equal(read(f, observations).live.activeSilenceAlarms.length, 2);
    context.evidence.invocationId = "A"; context.publishCancellation(); context.publishCancellation();
    let current = read(f, observations).live;
    assert.deepEqual(current.activeSilenceAlarms.map(item => item.invocationId), ["B"], "actual repeated publication settles A only");
    context.latestUpdate = undefined; context.publishCancellation();
    assert.deepEqual(read(f, observations).live.activeSilenceAlarms.map(item => item.invocationId), ["B"], "unavailable publication content cannot renew B");
    context.latestUpdate = { content }; context.evidence.invocationId = "B"; context.publishCancellation();
    current = read(f, observations).live;
    assert.equal(current.activeSilenceAlarms.length, 0, "matching B settlement clears B"); authoritative(f, current);
  });
  assert.equal(realProbes, 0, "every process observation must be injected, including lifecycle writes");
} finally { process.kill = originalKill; fs.rmSync(SCRATCH, { recursive: true, force: true }); }
assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
