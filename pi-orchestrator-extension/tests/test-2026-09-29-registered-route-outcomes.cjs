"use strict";
// REGISTERED-ROUTE-TESTS (review 23 finding 9). New test-only file, Claude Code run 7 builder
// (2026-09-29). Persistent in-repository tests for the registered-route outcomes of runs 4-6 and of
// HR3-EXTEND (item 2 of this run), driven through the actual registered bash tool
// (monitor.default({registerTool, on, events}); tool.execute(...)), never a synthetic call. Tests
// only: package.json, README and other wiring are unchanged, and this file runs directly with node
// (node tests/test-2026-09-29-registered-route-outcomes.cjs). This is disclosed in the builder report.
//
// Isolation (hard rule 7 / P3 finding parent): BEFORE any repository import, PI_* and
// TMP/TEMP/TMPDIR are rebound under a fresh mkdtemp root inside ITEM3_EVIDENCE_PARENT (set by the
// run-folder run-check.cjs harness; falls back to a mkdtemp under the OS temp dir so this file also
// runs standalone, outside the harness). No environment hook specific to any before-image is added
// here: pointing a case at an older module tree is entirely the run-folder driver's job
// (build/REGISTERED-ROUTE-TESTS/rrt-before-driver.cjs), via the optional `loadMonitor` it passes to
// runRegisteredRouteCase.
//
// Ported from run-folder probes, disclosed by name:
//  - rrt-hr3-sink-zero / rrt-hr3-sink-nonzero (rule 'hr3', R1-R7 including decision 3 retention) and
//    rrt-hr3x-sink-end-throw (rule 'hr3x', X1-X6): from this run's
//    build/HR3-EXTEND/probes/hr3x-registered.cjs, itself derived from the review 23 reviewer's
//    build/REVIEW/../review/probes/rv23-registered.cjs (run 6). Kept: the root check, authorization
//    file, authorized node test child, named-pipe release barrier, the one-shot sink fault on the
//    actual owner's sendToInvocation for the first counter_registered, the one-shot stdin.end throw
//    from closeInternal (sink-end-throw only), the close wrapper, the closeServiceNaturally recovery.
//    Dropped (out of scope for this item): the loss-exhausted and capture-refusal scenarios and the
//    sampler-switch constant.
//  - rrt-hr3x-<mode> for the 9 modes HR3-EXTEND (item 2 of this run) closed (sampler-close,
//    reader-poll, owner-drain, final-drain, read-budget-finalize, telemetry-owner-close,
//    sampler-end-throw, multi-drain-finalize, sampler-close-nonzero): from this run's
//    build/HR3-EXTEND/probes/hr3x-instance.cjs, itself derived from
//    tests/fixtures/item3-monitor-instance-evidence.cjs. These already drive tool.execute() of the
//    actual registered bash tool; no pipe barrier is needed because their commands are synchronous
//    shell built-ins, not a spawned node child.
//  - rrt-capqueue-unadmitted-terminal: from run 5's build/P-CAPQUEUE/probes/pcapqueue-registered.cjs.
//  - rrt-m1087-monitorio-reporting: new case (no run-folder probe reused a whole file for this one).
//    It drives the healthy registered route (no engineered sampler loss -- the only finite native
//    route to a loss arrival needs the pre-existing authorized sampler switch, whose literal
//    environment-variable name the chronology audit rejects in any added repository line; this is
//    named-open per the plan, reason rrt-m1087-loss-exhausted) and checks the reporting half of the
//    M1087 re-grounded proviso: details.monitorIo.unavailableCounterErrorDispositions is always
//    present and equals the sum of per-invocation counterErrorDelivery counts plus the omitted
//    count, with owner outstanding 0. The count is legitimately 0 on this route; this is disclosed
//    as this case's own unproven scope, not a weakened assertion (owner decision 1: "explicit
//    unavailable disposition, never silently skipped, nothing outstanding" -- the omission check,
//    not the loss-arrival routing, is what this case witnesses).
//  - rrt-ceiling-<variant> (8 variants): CEILING item (Claude Code run 8, 2026-09-30, builder for that
//    item). Registered route via tool.execute(), no pipe barrier; the child's own printf writes N
//    bytes into the actual owner's evidenceDirectory to drive measureTelemetry()'s categorization.
//  - rrt-interval-<variant> (3 variants): P-INTERVAL item (Claude Code run 8, 2026-09-30). Registered
//    route WITH a named-pipe release barrier around an authorized node test child, modelled on
//    runRegisteredPipeCase above (same barrier/uncaughtException-collector pattern). A one-shot fault
//    is armed on either EventReader.prototype.poll ("poll", "poll-nonzero") or the captured
//    CommandTelemetryOwner instance's drainEvents ("owner-drain") -- the same two call sites
//    processEvents() reaches from the exec interval callback (src/worker-no-output-monitor.ts). The
//    hook fires only when the call stack contains "processEvents" and not "processMonitorDrainTurn",
//    i.e. only from the periodic setInterval tick, never from the post-execution final drain (that
//    site already has its own coverage under rrt-hr3x-reader-poll / rrt-hr3x-owner-drain). Before the
//    P-INTERVAL correction this escaped as a process-level uncaught exception; after it, it is caught,
//    recorded once as a step:"interval-poll" settlement-failure entry, and the child's real outcome is
//    reported unchanged (owner decision 4 / hard rule 3, extended the same way as HR3-EXTEND and
//    CEILING).
//
// Every case throws (via node:assert/strict or a plain Error) on failure. As main, a failing case's
// rejection is left unhandled, which the Node runtime turns into a non-zero termination status by itself;
// this file never sets that termination status itself.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");
const cp = require("node:child_process");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Isolation. Must run before any repository import (hard rule 7 / plan text).
// ---------------------------------------------------------------------------
const EVIDENCE_PARENT_ENV = process.env.ITEM3_EVIDENCE_PARENT;
const EVIDENCE_PARENT = EVIDENCE_PARENT_ENV && path.isAbsolute(EVIDENCE_PARENT_ENV)
  ? EVIDENCE_PARENT_ENV
  : fs.mkdtempSync(path.join(os.tmpdir(), "rrt-evidence-parent-"));
fs.mkdirSync(EVIDENCE_PARENT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(EVIDENCE_PARENT, "rrt-"));
const ISOLATED_DIRS = {
  TMP: "tmp",
  TEMP: "tmp",
  TMPDIR: "tmp",
  PI_CODING_AGENT_DIR: "agent",
  PI_CODING_AGENT_SESSION_DIR: "sessions",
  PI_ORCHESTRATOR_RUNS_ROOT: "runs",
  PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next",
};
for (const [key, dir] of Object.entries(ISOLATED_DIRS)) {
  const resolved = path.join(RUN_ROOT, dir);
  fs.mkdirSync(resolved, { recursive: true });
  process.env[key] = resolved;
}
for (const key of Object.keys(ISOLATED_DIRS)) {
  if (!path.isAbsolute(process.env[key] || "") || process.env[key].length === 0) throw new Error(`RRT_ROOTS_NOT_ISOLATED ${key}`);
}
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
delete process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY;

// ---------------------------------------------------------------------------
// Repository constants and helpers (no repository import above this line).
// ---------------------------------------------------------------------------
const REPO = path.resolve(__dirname, "..");
const LIVE_MONITOR = path.join(REPO, "src", "worker-no-output-monitor.ts");
const PI_MODULES = path.join(REPO, "node_modules/@earendil-works/pi-coding-agent/node_modules");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
// Innermost monitor caller first (matches the run 4-7 registered-route probes' convention).
const callerOf = (stack) => /writeCounterError/.test(stack) ? "writeCounterError"
  : /deliverNativeCounterState/.test(stack) ? "deliverNativeCounterState"
    : /admitNativeCounterRequest/.test(stack) ? "admitNativeCounterRequest" : "other";

let nextTmp = 0;
function freshRoot(label) {
  const root = path.join(RUN_ROOT, "tmp", `${label}-${++nextTmp}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function defaultLoadMonitor() {
  process.env.NODE_PATH = [PI_MODULES, path.join(REPO, "node_modules")].join(path.delimiter);
  Module._initPaths();
  const createJiti = require(path.join(PI_MODULES, "jiti/lib/jiti.cjs"));
  const loaderDir = freshRoot("loader");
  const jiti = createJiti(path.join(loaderDir, "loader.cjs"), { interopDefault: true, moduleCache: false, fsCache: false });
  return jiti(LIVE_MONITOR);
}

// `loadMonitor` (options.loadMonitor) may be omitted (loads the live module), a loaded module
// object directly (what the run-folder driver passes: jiti.evalModule(beforeBytes, {filename:
// LIVE_MONITOR}), after checking the image hash), or a (possibly async) zero-argument function that
// returns one. This file never reads a before-image path itself.
async function resolveMonitor(loadMonitor) {
  if (loadMonitor === undefined) return defaultLoadMonitor();
  if (typeof loadMonitor === "function") return await loadMonitor();
  return loadMonitor;
}

const { observeChild, closeServiceNaturally } = require(path.join(REPO, "tests/fixtures/item3-native-counter-witness.cjs"));
const { CommandTelemetryOwner } = require(path.join(REPO, "src/command-telemetry-owner.cjs"));

function withScopedEnv() {
  const backup = new Map();
  const set = (key, value) => { if (!backup.has(key)) backup.set(key, process.env[key]); process.env[key] = value; };
  const restore = () => { for (const [key, value] of backup) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  return { set, restore };
}

function writeAuthorization(root, workspace, entrypoint) {
  const body = {
    schemaVersion: 1,
    authority: "run-admission-owner-task",
    workspaceRealPath: fs.realpathSync(workspace),
    existingEntrypoints: entrypoint
      ? [{ path: fs.realpathSync(entrypoint), bytes: fs.statSync(entrypoint).size, sha256: sha256(fs.readFileSync(entrypoint)) }]
      : [],
    approvedDynamicScopes: [],
    allowedNodeOptions: [],
  };
  const bytes = Buffer.from(JSON.stringify({ ...body, policyHash: sha256(Buffer.from(JSON.stringify(body))) }));
  const authorityFile = path.join(root, "authorization.json");
  fs.writeFileSync(authorityFile, bytes);
  return { authorityFile, authorityBytes: bytes };
}

// =============================================================================================
// rrt-hr3-sink-zero, rrt-hr3-sink-nonzero, rrt-hr3x-sink-end-throw
// Registered route WITH a named-pipe release barrier around an authorized node test child.
// =============================================================================================
async function runRegisteredPipeCase(mod, scenario, rule) {
  const root = freshRoot(`rrt-reg-${scenario}`);
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const acks = path.join(root, "acks");
  for (const dir of [workspace, evidence, acks]) fs.mkdirSync(dir, { recursive: true });
  const barrier = scenario !== "healthy";
  const pipeName = `\\\\.\\pipe\\rrt-${crypto.randomBytes(8).toString("hex")}`;
  const childScript = path.join(workspace, "rrt-child.cjs");
  const childLines = ['"use strict";', 'process.stdout.write("RRT_CHILD_START\\n");'];
  if (barrier) {
    childLines.push(
      'const net = require("node:net");',
      `const socket = net.connect(${JSON.stringify(pipeName)});`,
      'let received = "";',
      'socket.setEncoding("utf8");',
      'socket.on("data", (chunk) => {',
      '  received += chunk;',
      '  if (received.includes("release\\n")) {',
      '    process.stdout.write("RRT_CHILD_COMPLETE\\n");',
      '    socket.end();',
      ...(scenario === "sink-nonzero" ? ['    throw new Error("RRT_CHILD_NATURAL_NONZERO");'] : []),
      '  }',
      '});',
      'socket.on("error", (error) => { process.stdout.write("RRT_CHILD_PIPE_ERROR " + error.message + "\\n"); });',
    );
  } else {
    childLines.push('process.stdout.write("RRT_CHILD_COMPLETE\\n");');
  }
  childLines.push("");
  fs.writeFileSync(childScript, childLines.join("\n"));
  const { authorityFile, authorityBytes } = writeAuthorization(root, workspace, childScript);
  const env = withScopedEnv();
  delete process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY; // product default policy
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE", authorityFile);
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256", sha256(authorityBytes));
  env.set("PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT", evidence);
  env.set("PI_ORCHESTRATOR_ALARM_ACK_ROOT", acks);
  env.set("PI_ORCHESTRATOR_WORKER_ID", `rrt-registered-${scenario}`);

  const FAULT_MESSAGE = "RRT_ONE_SHOT_TELEMETRY_SINK_FAULT";
  const END_FAULT_MESSAGE = "RRT_ONE_SHOT_SAMPLER_STDIN_END_THROW";
  const r = { fault: { hits: 0 }, endFault: { hits: 0 }, sends: [], terminals: [], closeCalls: [], harnessRecovery: {}, publicMonitor: {}, sinkWrap: { installed: false }, closeWrap: { installed: false }, uncaught: [] };
  let faultError; let endFaultError;
  const onUncaught = (error) => r.uncaught.push({ message: String(error?.message || error), isFault: error === faultError });
  process.on("uncaughtException", onUncaught);
  let childSocket; let releaseRequested = false; let released = false; let owner;
  const server = net.createServer((socket) => {
    childSocket = socket;
    if (releaseRequested && !released) { released = true; socket.write("release\n"); }
  });
  const serverClosed = new Promise((resolve) => server.once("close", resolve));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipeName, resolve); });
  const release = () => {
    if (releaseRequested) return;
    releaseRequested = true;
    if (childSocket && !released) { released = true; childSocket.write("release\n"); }
  };
  const scheduleRelease = () => queueMicrotask(release);

  const original = { start: CommandTelemetryOwner.prototype.start, spawn: cp.spawn };
  let service; let sampler; let ownerServer; let ownerServerClosed = false; let tool; let resultHandler; let lastPolled = [];
  CommandTelemetryOwner.prototype.start = function rrtCapturedOwnerStart(...args) {
    owner = this;
    r.ownerSamePrototype = Object.getPrototypeOf(this) === CommandTelemetryOwner.prototype;
    const returned = original.start.apply(this, args);
    ownerServer = this.server; if (ownerServer) ownerServer.once("close", () => { ownerServerClosed = true; });
    const realSend = this.sendToInvocation;
    let armed = scenario.startsWith("sink-");
    this.sendToInvocation = function rrtSend(invocationId, event, channel, permission, prior) {
      const stack = String(new Error("caller").stack);
      if (armed && event?.type === "counter_registered") {
        armed = false;
        r.fault.hits += 1; r.fault.caller = callerOf(stack); r.fault.callerStack = stack.split("\n").slice(0, 16);
        faultError = new Error(FAULT_MESSAGE);
        r.sends.push({ invocationId, type: event?.type, channel, caller: callerOf(stack), faulted: true });
        if (scenario === "sink-end-throw" && sampler) {
          const stdin = sampler.child.stdin;
          const realEnd = stdin.end;
          stdin.end = function rrtOneShotEndThrow(...endArgs) {
            delete stdin.end; // the next call (recovery) reaches the real end
            r.endFault.hits += 1; r.endFault.callerStack = String(new Error("caller").stack).split("\n").slice(0, 12);
            endFaultError = new Error(END_FAULT_MESSAGE);
            throw endFaultError;
          };
          r.endFault.realEndIsFunction = typeof realEnd === "function";
        }
        scheduleRelease();
        throw faultError;
      }
      const returnedSend = realSend.call(this, invocationId, event, channel, permission, prior);
      r.sends.push({ invocationId, type: event?.type, channel, caller: callerOf(stack) });
      if (event?.type === "counter_error") scheduleRelease();
      return returnedSend;
    };
    const realReserve = this.reserveHostWork;
    this.reserveHostWork = function rrtReserve(invocationId, channel, bytes) {
      const permission = realReserve.call(this, invocationId, channel, bytes);
      if (!permission) scheduleRelease();
      return permission;
    };
    const realDrain = this.drainEvents;
    this.drainEvents = function rrtDrain(...drainArgs) {
      const drained = realDrain.apply(this, drainArgs);
      const turn = [...lastPolled, ...drained]; lastPolled = [];
      for (const event of turn) if (event?.type === "invocation_terminal") r.terminals.push({ invocationId: event.invocationId, outcome: event.outcome, exitCode: event.exitCode });
      if (turn.some((event) => event?.type === "observation_error")) scheduleRelease();
      return drained;
    };
    return returned;
  };
  cp.spawn = function rrtSpawn(...args) {
    const child = original.spawn.apply(this, args);
    if (service && !sampler && /powershell\.exe$/i.test(String(args[0]))) {
      sampler = observeChild(child, "rrt-sampler");
      sampler.close.then(scheduleRelease);
    }
    return child;
  };
  Module.syncBuiltinESMExports?.();
  const S = mod.WindowsIoCounterService.prototype;
  const originals = { serviceStart: S.start, poll: mod.EventReader.prototype.poll };
  try {
    S.start = function rrtServiceStart(...args) {
      service = this;
      const realSink = this.stateSink;
      if (typeof realSink === "function" && !r.sinkWrap.installed) {
        r.sinkWrap.installed = true;
        this.stateSink = function rrtSink(invocationId, state, bytes, nativeFrameBytes) {
          try { return realSink(invocationId, state, bytes, nativeFrameBytes); }
          finally { scheduleRelease(); }
        };
      }
      const realClose = this.close;
      if (typeof realClose === "function" && !r.closeWrap.installed) {
        r.closeWrap.installed = true;
        const instance = this;
        this.close = function rrtClose(...closeArgs) {
          const record = { nativeClosedAtCall: instance.nativeClosed };
          r.closeCalls.push(record);
          const promise = realClose.apply(instance, closeArgs);
          promise.then(
            () => { record.outcome = "fulfilled"; record.nativeClosedAtSettle = instance.nativeClosed; },
            (error) => { record.outcome = "rejected"; record.isFault = error === faultError; record.nativeClosedAtSettle = instance.nativeClosed; },
          );
          return promise;
        };
      }
      return originals.serviceStart.apply(this, args);
    };
    mod.EventReader.prototype.poll = function rrtPoll(...args) { const value = originals.poll.apply(this, args); lastPolled = value; return value; };
    mod.default({ registerTool(definition) { if (definition.name === "bash") tool = definition; }, on(name, handler) { if (name === "tool_result") resultHandler = handler; }, events: { emit() {} } });
    if (!tool) throw new Error("RRT_BASH_TOOL_NOT_REGISTERED");
    const toolCallId = `rrt-${scenario}`;
    const updates = [];
    const onUpdate = (update) => { const text = (update?.content || []).map((item) => item?.text || "").join(""); updates.push(text.slice(-2000)); };
    try {
      const raw = await tool.execute(toolCallId, { command: "node rrt-child.cjs" }, undefined, onUpdate, { cwd: workspace, sessionManager: { getSessionId: () => "rrt", getSessionFile: () => undefined } });
      r.publicMonitor.execute = "fulfilled";
      r.publicMonitor.content = (raw.content || []).map((item) => item?.text || "").join("").slice(0, 4000);
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: raw.content || [] });
      r.publicMonitor.details = patch?.details ?? raw.details;
    } catch (error) {
      r.publicMonitor.execute = "rejected";
      r.publicMonitor.error = { name: error?.name, message: String(error?.message).slice(0, 4000), isFault: error === faultError, isAggregate: error instanceof AggregateError };
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: [] });
      r.publicMonitor.details = patch?.details;
    }
    r.publicMonitor.updatesTail = updates.slice(-3);
    r.publicMonitor.samplerClosedAfterExecute = sampler?.terminalObserved();
    r.serviceAfter = service ? { transportFailureIsFault: faultError !== undefined && service.transportFailure === faultError, nativeClosed: service.nativeClosed } : null;
    if (service && rule === "hr3") {
      let outcome;
      await service.close().then(() => { outcome = "fulfilled"; }, () => { outcome = "rejected"; });
      r.secondClose = outcome;
    }
  } finally {
    CommandTelemetryOwner.prototype.start = original.start; cp.spawn = original.spawn;
    S.start = originals.serviceStart; mod.EventReader.prototype.poll = originals.poll;
    Module.syncBuiltinESMExports?.();
    release();
    r.harnessRecovery.required = Boolean((ownerServer && !ownerServerClosed) || (sampler && !sampler.terminalObserved()));
    r.harnessRecovery.samplerAliveAfterExecute = Boolean(sampler && !sampler.terminalObserved());
    try { if (service && sampler && !sampler.terminalObserved()) await closeServiceNaturally(service, [sampler], r.harnessRecovery); }
    catch (error) { r.harnessRecovery.serviceError = error.message; }
    try { if (owner && !owner.closed) await owner.close(); } catch (error) { r.harnessRecovery.ownerError = error.message; }
    server.close(); await serverClosed;
    process.off("uncaughtException", onUncaught);
    r.samplerTerminal = sampler?.snapshot().terminalOutcome;
    env.restore();
  }

  const d = r.publicMonitor.details ?? {};
  const text = `${r.publicMonitor.content ?? ""}\n${(r.publicMonitor.updatesTail || []).join("\n")}\n${r.publicMonitor.error?.message ?? ""}`;
  if (!r.ownerSamePrototype) throw new Error("RRT_OWNER_NOT_CAPTURED (UNPROVEN, not a RED)");
  if (!r.sinkWrap.installed || !r.closeWrap.installed) throw new Error("RRT_SERVICE_NOT_WRAPPED (UNPROVEN, not a RED)");
  if (r.fault.hits !== 1 || r.fault.caller !== "deliverNativeCounterState" || !/writeState/.test(r.fault.callerStack.join("\n")) || !/onData/.test(r.fault.callerStack.join("\n")))
    throw new Error(`RRT_SINK_FAULT_NOT_HIT_THROUGH_ACTUAL_CALLER ${JSON.stringify(r.fault)} (UNPROVEN, not a RED)`);
  if (scenario === "sink-end-throw" && (r.endFault.hits !== 1 || !/closeInternal/.test((r.endFault.callerStack || []).join("\n"))))
    throw new Error(`RRT_END_FAULT_NOT_HIT_FROM_CLOSEINTERNAL ${JSON.stringify(r.endFault)} (UNPROVEN, not a RED)`);
  const closeFirst = r.closeCalls[0];
  if (rule === "hr3") {
    if (scenario === "sink-zero") {
      assert.equal(r.publicMonitor.execute, "fulfilled", `R1: telemetry failure became the command's result: ${JSON.stringify(r.publicMonitor.error)}`);
      assert.match(r.publicMonitor.content ?? "", /RRT_CHILD_COMPLETE/, "R1");
      assert.doesNotMatch(r.publicMonitor.content ?? "", /RRT_ONE_SHOT_TELEMETRY_SINK_FAULT/, "R1");
    } else {
      assert.equal(r.publicMonitor.execute, "rejected", "R1");
      assert.equal(r.publicMonitor.error?.isFault, false, "R1");
      assert.equal(r.publicMonitor.error?.isAggregate, false, "R1");
      assert.match(r.publicMonitor.error?.message ?? "", /with code 1/, "R1");
      assert.match(r.publicMonitor.error?.message ?? "", /RRT_CHILD_COMPLETE/, "R1");
    }
    assert.deepEqual(d.monitorIo?.retainedCounterServiceFailure, { name: "Error", message: FAULT_MESSAGE }, "R2");
    assert.equal(closeFirst?.outcome, "rejected", "R3");
    assert.equal(closeFirst?.isFault, true, "R3");
    assert.equal(closeFirst?.nativeClosedAtSettle, true, "R3");
    assert.equal(r.serviceAfter?.transportFailureIsFault, true, "R3");
    assert.equal(r.serviceAfter?.nativeClosed, true, "R3");
    assert.equal(r.secondClose, "fulfilled", "R3 (decision 3: a later close fulfils)");
    assert.match(text, /RRT_CHILD_START/, "R4");
    assert.match(text, /RRT_CHILD_COMPLETE/, "R4");
    assert.equal(r.terminals.length, 1, "R4");
    if (scenario === "sink-zero") assert.equal(r.terminals[0].outcome, "succeeded", "R4");
    else { assert.equal(r.terminals[0].outcome, "failed", "R4"); assert.equal(r.terminals[0].exitCode, 1, "R4"); }
    assert.deepEqual(r.uncaught.map((u) => u.message), [], "R5");
    assert.equal(r.publicMonitor.samplerClosedAfterExecute, true, "R5");
    assert.equal(r.harnessRecovery.required, false, "R5");
    const entry = (d.monitorIo?.telemetrySettlementFailures || []).find((s) => s.step === "counter-service-close");
    assert.ok(entry, `R6: no counter-service-close settlement entry: ${JSON.stringify(d.monitorIo?.telemetrySettlementFailures)}`);
    assert.equal(entry.nativeSettlement, "witnessed", "R6");
    assert.equal(entry.message, FAULT_MESSAGE, "R6");
  } else if (rule === "hr3x") {
    assert.equal(r.publicMonitor.execute, "fulfilled", `X1: telemetry failure became the command's result: ${JSON.stringify(r.publicMonitor.error)}`);
    assert.match(r.publicMonitor.content ?? "", /RRT_CHILD_COMPLETE/, "X1");
    assert.doesNotMatch(r.publicMonitor.content ?? "", /RRT_ONE_SHOT_TELEMETRY_SINK_FAULT/, "X1");
    assert.equal(Object.prototype.hasOwnProperty.call(d.monitorIo || {}, "retainedCounterServiceFailure"), false, "X2");
    const entry = (d.monitorIo?.telemetrySettlementFailures || []).find((s) => s.step === "counter-service-close");
    assert.ok(entry, `X3: no counter-service-close settlement entry: ${JSON.stringify(d.monitorIo?.telemetrySettlementFailures)}`);
    assert.equal(entry.name, "Error", "X3");
    assert.equal(entry.message, FAULT_MESSAGE, "X3");
    assert.equal(entry.nativeSettlement, "not-established", "X3");
    assert.equal(closeFirst?.outcome, "rejected", "X4");
    assert.equal(closeFirst?.isFault, true, "X4");
    assert.equal(closeFirst?.nativeClosedAtSettle, false, "X4");
    assert.equal(r.harnessRecovery.samplerAliveAfterExecute, true, "X5");
    assert.equal(r.samplerTerminal?.kind, "close", "X5");
    assert.deepEqual(r.uncaught.map((u) => u.message), [], "X6");
  }
}

// =============================================================================================
// rrt-hr3x-<mode> (9 modes): registered route via the same tool.execute(), no pipe barrier
// (synchronous shell commands, no spawned node child).
// =============================================================================================
const EXPECTED_STEP = {
  "sampler-close": "counter-service-close", "reader-poll": "event-drain", "owner-drain": "event-drain",
  "final-drain": "event-final-drain", "read-budget-finalize": "read-budget-finalize",
  "telemetry-owner-close": "telemetry-owner-close", "sampler-end-throw": "counter-service-close",
  "sampler-close-nonzero": "counter-service-close",
};
const faultMessage = (name) => `RRT_HR3X_${name}`;

async function runInstanceCase(mod, mode) {
  const root = freshRoot(`rrt-instance-${mode}`);
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const acks = path.join(root, "acks");
  for (const dir of [workspace, evidence, acks]) fs.mkdirSync(dir, { recursive: true });
  const { authorityFile, authorityBytes } = writeAuthorization(root, workspace, undefined);
  const env = withScopedEnv();
  delete process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY;
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE", authorityFile);
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256", sha256(authorityBytes));
  env.set("PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT", evidence);
  env.set("PI_ORCHESTRATOR_ALARM_ACK_ROOT", acks);
  env.set("PI_ORCHESTRATOR_WORKER_ID", `rrt-instance-${mode}`);

  const original = { ownerStart: CommandTelemetryOwner.prototype.start, ownerClose: CommandTelemetryOwner.prototype.close, spawn: cp.spawn };
  const r = { mode, faultHits: {}, harnessRecovery: {}, publicMonitor: {} };
  let owner; let service; let server; let serverClosed = false; let sampler; let tool; let resultHandler;
  let originalServiceStart; let originalServiceClose; let originalPoll; let originalFinalize;
  let serviceCloseEntered = false;
  let pollFaultEnabled = mode === "reader-poll" || mode === "final-drain";
  let ownerDrainFaultEnabled = mode === "owner-drain" || mode === "multi-drain-finalize";
  let readBudgetFaultEnabled = mode === "read-budget-finalize" || mode === "multi-drain-finalize";
  let ownerCloseFaultEnabled = mode === "telemetry-owner-close";
  let flushQueueFaultEnabled = mode === "sampler-close" || mode === "sampler-close-nonzero";
  let stdinEndFaultEnabled = mode === "sampler-end-throw";
  const hit = (name) => { r.faultHits[name] = (r.faultHits[name] || 0) + 1; };

  CommandTelemetryOwner.prototype.start = function rrtOwnerStart(...args) {
    owner = this;
    const returned = original.ownerStart.apply(this, args);
    server = this.server;
    if (server) server.once("close", () => { serverClosed = true; });
    if (ownerDrainFaultEnabled) {
      const realDrain = this.drainEvents;
      this.drainEvents = function rrtOwnerDrain(...drainArgs) {
        const stack = new Error("fault caller").stack;
        if (ownerDrainFaultEnabled && stack.includes("processMonitorDrainTurn")) { ownerDrainFaultEnabled = false; hit("owner.drainEvents"); throw new Error(faultMessage("owner-drain")); }
        return realDrain.apply(this, drainArgs);
      };
    }
    return returned;
  };
  if (ownerCloseFaultEnabled) {
    CommandTelemetryOwner.prototype.close = function rrtOwnerClose(...args) {
      const stack = new Error("fault caller").stack;
      if (ownerCloseFaultEnabled && stack.includes("settleResources")) { ownerCloseFaultEnabled = false; hit("owner.close"); return Promise.reject(new Error(faultMessage("telemetry-owner-close"))); }
      return original.ownerClose.apply(this, args);
    };
  }
  cp.spawn = function rrtSpawn(...args) {
    const child = original.spawn.apply(this, args);
    if (service && /powershell\.exe$/i.test(String(args[0]))) sampler = observeChild(child, "rrt-instance-sampler");
    return child;
  };
  Module.syncBuiltinESMExports?.();
  try {
    originalServiceStart = mod.WindowsIoCounterService.prototype.start;
    originalServiceClose = mod.WindowsIoCounterService.prototype.close;
    originalPoll = mod.EventReader.prototype.poll;
    originalFinalize = mod.SharedReadBudget.prototype.finalizeCycle;
    mod.WindowsIoCounterService.prototype.close = function rrtServiceClose(...args) {
      serviceCloseEntered = true;
      if (flushQueueFaultEnabled) {
        const originalFlush = this.flushQueue;
        this.flushQueue = function rrtOneShotFlush() { this.flushQueue = originalFlush; flushQueueFaultEnabled = false; hit("sampler.close.flushQueue"); throw new Error(faultMessage("sampler-close")); };
      }
      if (stdinEndFaultEnabled && this.child && this.child.stdin) {
        const stdin = this.child.stdin;
        stdin.end = function rrtOneShotEndThrow(...endArgs) { delete stdin.end; stdinEndFaultEnabled = false; hit("sampler.close.stdinEnd"); throw new Error(faultMessage("sampler-end-throw")); };
      }
      return originalServiceClose.apply(this, args);
    };
    mod.WindowsIoCounterService.prototype.start = function rrtServiceStart(...args) { service = this; return originalServiceStart.apply(this, args); };
    mod.EventReader.prototype.poll = function rrtPoll(...args) {
      const stack = new Error("fault caller").stack;
      const inDrainTurn = stack.includes("processMonitorDrainTurn");
      if (pollFaultEnabled && inDrainTurn) {
        if (mode === "reader-poll") { pollFaultEnabled = false; hit("reader.poll"); throw new Error(faultMessage("reader-poll")); }
        if (mode === "final-drain" && serviceCloseEntered) { pollFaultEnabled = false; hit("reader.poll"); throw new Error(faultMessage("final-drain")); }
      }
      return originalPoll.apply(this, args);
    };
    mod.SharedReadBudget.prototype.finalizeCycle = function rrtFinalize(...args) {
      const stack = new Error("fault caller").stack;
      if (readBudgetFaultEnabled && stack.includes("settleResources") && !stack.includes("processEvents")) { readBudgetFaultEnabled = false; hit("readBudget.finalizeCycle"); throw new Error(faultMessage("read-budget-finalize")); }
      return originalFinalize.apply(this, args);
    };
    mod.default({ registerTool(definition) { if (definition.name === "bash") tool = definition; }, on(name, handler) { if (name === "tool_result") resultHandler = handler; }, events: { emit() {} } });
    const command = mode === "sampler-close-nonzero" ? "printf 'ASTRA_ACTUAL_COMMAND_COMPLETE\\n'; false" : "printf 'ASTRA_ACTUAL_COMMAND_COMPLETE\\n'";
    const toolCallId = `rrt-${mode}`;
    try {
      const raw = await tool.execute(toolCallId, { command }, undefined, undefined, { cwd: workspace, sessionManager: { getSessionId: () => "rrt-instance", getSessionFile: () => undefined } });
      r.publicMonitor.execute = "fulfilled";
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: raw.content });
      r.publicMonitor.text = (patch?.content ?? raw.content ?? []).map((item) => item?.text || "").join("");
      r.publicMonitor.details = patch?.details ?? raw.details;
    } catch (error) {
      r.publicMonitor.execute = "rejected";
      r.publicMonitor.error = { name: error.name, message: error.message, isAggregate: error instanceof AggregateError };
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: [] });
      r.publicMonitor.details = patch?.details;
    }
  } finally {
    CommandTelemetryOwner.prototype.start = original.ownerStart;
    CommandTelemetryOwner.prototype.close = original.ownerClose;
    cp.spawn = original.spawn;
    if (originalServiceStart) mod.WindowsIoCounterService.prototype.start = originalServiceStart;
    if (originalServiceClose) mod.WindowsIoCounterService.prototype.close = originalServiceClose;
    if (originalPoll) mod.EventReader.prototype.poll = originalPoll;
    if (originalFinalize) mod.SharedReadBudget.prototype.finalizeCycle = originalFinalize;
    Module.syncBuiltinESMExports?.();
    r.harnessRecovery.required = Boolean((server && !serverClosed) || (sampler && !sampler.terminalObserved()));
    try { if (service && sampler) await closeServiceNaturally(service, [sampler], r.harnessRecovery); } catch (error) { r.harnessRecovery.serviceError = { message: error.message }; }
    try { if (owner) await owner.close(); } catch (error) { r.harnessRecovery.ownerError = { message: error.message }; }
    r.harnessRecovery.sampler = sampler?.snapshot();
    env.restore();
  }

  const d = r.publicMonitor.details ?? {};
  const settlements = d.monitorIo?.telemetrySettlementFailures ?? [];
  if (mode !== "healthy" && mode !== "sampler-close-nonzero") {
    const totalHits = Object.values(r.faultHits).reduce((a, b) => a + b, 0);
    if (mode === "multi-drain-finalize") {
      if (totalHits !== 2 || r.faultHits["owner.drainEvents"] !== 1 || r.faultHits["readBudget.finalizeCycle"] !== 1) throw new Error(`RRT_HOOK_MISS ${mode} ${JSON.stringify(r.faultHits)} (UNPROVEN, not a RED)`);
    } else if (totalHits !== 1) throw new Error(`RRT_HOOK_MISS ${mode} ${JSON.stringify(r.faultHits)} (UNPROVEN, not a RED)`);
  }
  if (mode === "sampler-close-nonzero" && (r.faultHits["sampler.close.flushQueue"] || 0) !== 1) throw new Error(`RRT_HOOK_MISS ${mode} ${JSON.stringify(r.faultHits)} (UNPROVEN, not a RED)`);
  if (mode === "sampler-close-nonzero") {
    assert.equal(r.publicMonitor.execute, "rejected");
    assert.equal(r.publicMonitor.error?.isAggregate, false, "the child outcome must not be wrapped with the settlement fault");
    assert.match(r.publicMonitor.error?.message ?? "", /ASTRA_ACTUAL_COMMAND_COMPLETE/);
    assert.match(r.publicMonitor.error?.message ?? "", /code 1/);
    const entry = settlements.find((s) => s.step === "counter-service-close");
    assert.ok(entry, `no counter-service-close settlement entry: ${JSON.stringify(settlements)}`);
    assert.equal(entry.nativeSettlement, "witnessed");
  } else {
    assert.equal(r.publicMonitor.execute, "fulfilled", `settlement failure became the command result: ${JSON.stringify(r.publicMonitor.error)}`);
    assert.match(r.publicMonitor.text ?? "", /ASTRA_ACTUAL_COMMAND_COMPLETE/);
    if (mode === "multi-drain-finalize") {
      assert.equal(settlements.length, 2, JSON.stringify(settlements));
      const drainEntry = settlements.find((s) => s.step === "event-drain");
      const budgetEntry = settlements.find((s) => s.step === "read-budget-finalize");
      assert.ok(drainEntry && drainEntry.message === faultMessage("owner-drain"));
      assert.ok(budgetEntry && budgetEntry.message === faultMessage("read-budget-finalize"));
      assert.equal(drainEntry.nativeSettlement, "not-established");
      assert.equal(budgetEntry.nativeSettlement, "not-established");
    } else {
      assert.equal(settlements.length, 1, JSON.stringify(settlements));
      const entry = settlements[0];
      assert.equal(entry.step, EXPECTED_STEP[mode]);
      assert.equal(entry.name, "Error");
      assert.equal(entry.message, faultMessage(mode));
      if (mode === "sampler-close") assert.equal(entry.nativeSettlement, "witnessed");
      else if (mode === "sampler-end-throw" || mode === "telemetry-owner-close") assert.equal(entry.nativeSettlement, "not-established");
    }
    assert.equal(Object.prototype.hasOwnProperty.call(d.monitorIo || {}, "retainedCounterServiceFailure"), false);
    const expectRecovery = mode === "telemetry-owner-close" || mode === "sampler-end-throw";
    assert.equal(r.harnessRecovery.required, expectRecovery, JSON.stringify(r.harnessRecovery));
    if (mode === "sampler-end-throw") assert.equal(r.harnessRecovery.sampler?.terminalOutcome?.kind, "close");
  }
}

// =============================================================================================
// rrt-capqueue-unadmitted-terminal
// =============================================================================================
async function runCapqueueCase(mod) {
  const root = freshRoot("rrt-capqueue");
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const acks = path.join(root, "acks");
  for (const dir of [workspace, evidence, acks]) fs.mkdirSync(dir, { recursive: true });
  const childScript = path.join(workspace, "rrt-capqueue-child.cjs");
  fs.writeFileSync(childScript, ['"use strict";', 'process.stdout.write("RRT_CAPQUEUE_CHILD_START\\n");', 'process.stdout.write("RRT_CAPQUEUE_CHILD_COMPLETE\\n");', ''].join("\n"));
  const { authorityFile, authorityBytes } = writeAuthorization(root, workspace, childScript);
  const env = withScopedEnv();
  delete process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY;
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE", authorityFile);
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256", sha256(authorityBytes));
  env.set("PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT", evidence);
  env.set("PI_ORCHESTRATOR_ALARM_ACK_ROOT", acks);
  env.set("PI_ORCHESTRATOR_WORKER_ID", "rrt-capqueue");

  const FAULT_MESSAGE = "RRT_CAPQUEUE_ONE_SHOT_CAPTURE_REQUEST_REFUSAL";
  const r = { fault: { hits: 0 }, payloads: [], requests: [], terminalsAdded: [], settlements: [], retired: [], terminals: [], uncaught: [], harnessRecovery: {}, publicMonitor: {}, queueInstances: 0 };
  let faultError;
  const onUncaught = (error) => r.uncaught.push({ message: String(error?.message || error), isFault: error === faultError });
  process.on("uncaughtException", onUncaught);
  const original = { start: CommandTelemetryOwner.prototype.start, spawn: cp.spawn };
  let owner; let service; let ownerServer; let ownerServerClosed = false; let sampler; let tool; let resultHandler; let originalServiceStart; let queueOriginals;
  const queues = new Set();
  CommandTelemetryOwner.prototype.start = function rrtCqOwnerStart(...args) {
    owner = this;
    r.ownerIdentity = { samePrototype: Object.getPrototypeOf(this) === CommandTelemetryOwner.prototype };
    const returned = original.start.apply(this, args);
    ownerServer = this.server; if (ownerServer) ownerServer.once("close", () => { ownerServerClosed = true; });
    const realComplete = this.completePayload;
    let armed = true;
    this.completePayload = function rrtFaultedCompletePayload(connection, invocation, pending, event, actualBytes) {
      r.payloads.push({ type: String(event?.type), invocationId: invocation?.invocationId, channel: pending?.channel });
      if (armed && event?.type === "declared_file_capture_request") {
        armed = false;
        const ownerInstance = this;
        ownerInstance.recordActual = function rrtOneShotRecordActual() {
          delete ownerInstance.recordActual;
          r.fault.hits += 1; r.fault.invocationId = invocation?.invocationId; r.fault.callerStack = String(new Error("caller").stack).split("\n").slice(0, 12);
          faultError = new Error(FAULT_MESSAGE);
          throw faultError;
        };
      }
      return realComplete.call(this, connection, invocation, pending, event, actualBytes);
    };
    const realRetire = this.retireCommitted;
    this.retireCommitted = function rrtObservedRetire(invocationId) { const returnedRetire = realRetire.call(this, invocationId); r.retired.push({ invocationId, returned: returnedRetire }); return returnedRetire; };
    const realDrain = this.drainEvents;
    this.drainEvents = function rrtCqObservedDrain(...drainArgs) {
      const drained = realDrain.apply(this, drainArgs);
      for (const event of drained) if (event?.type === "invocation_terminal") r.terminals.push({ invocationId: event.invocationId, outcome: event.outcome, exitCode: event.exitCode });
      return drained;
    };
    return returned;
  };
  cp.spawn = function rrtCqSpawn(...args) {
    const child = original.spawn.apply(this, args);
    if (service && !sampler && /powershell\.exe$/i.test(String(args[0]))) sampler = observeChild(child, "rrt-capqueue-sampler");
    return child;
  };
  Module.syncBuiltinESMExports?.();
  try {
    originalServiceStart = mod.WindowsIoCounterService.prototype.start;
    mod.WindowsIoCounterService.prototype.start = function rrtCqServiceStart(...args) { service = this; return originalServiceStart.apply(this, args); };
    const Q = mod.HostCaptureSettlementQueue.prototype;
    queueOriginals = { addRequest: Q.addRequest, addTerminal: Q.addTerminal, settleNext: Q.settleNext };
    Q.addRequest = function rrtObservedAddRequest(event) { queues.add(this); const accepted = queueOriginals.addRequest.call(this, event); r.requests.push({ invocationId: event?.invocationId, accepted }); return accepted; };
    Q.addTerminal = function rrtObservedAddTerminal(event) { queues.add(this); r.terminalsAdded.push({ invocationId: event?.invocationId, hasJob: this.hasJob(event?.invocationId), captureStatus: event?.declaredFileCapture?.status }); return queueOriginals.addTerminal.call(this, event); };
    Q.settleNext = function rrtObservedSettleNext(capture, commit) { queues.add(this); const settlement = queueOriginals.settleNext.call(this, capture, commit); if (settlement !== undefined) r.settlements.push({ kind: settlement.kind, invocationId: settlement.invocationId, reason: settlement.reason, hasCapture: settlement.capture !== undefined }); return settlement; };
    mod.default({ registerTool(definition) { if (definition.name === "bash") tool = definition; }, on(name, handler) { if (name === "tool_result") resultHandler = handler; }, events: { emit() {} } });
    const toolCallId = "rrt-capqueue";
    const onUpdate = (update) => { const text = (update?.content || []).map((item) => item?.text || "").join(""); r.lastUpdateText = text.slice(-4000); };
    try {
      const raw = await tool.execute(toolCallId, { command: "node rrt-capqueue-child.cjs" }, undefined, onUpdate, { cwd: workspace, sessionManager: { getSessionId: () => "rrt-capqueue", getSessionFile: () => undefined } });
      r.publicMonitor.execute = "fulfilled";
      r.publicMonitor.childText = (raw.content || []).map((item) => item?.text || "").join("").slice(0, 4000);
      r.publicMonitor.samplerClosed = sampler?.terminalObserved();
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: raw.content || [] });
      r.publicMonitor.details = patch?.details ?? raw.details;
    } catch (error) {
      r.publicMonitor.execute = "rejected";
      r.publicMonitor.error = { name: error?.name, message: error?.message };
      r.publicMonitor.samplerClosed = sampler?.terminalObserved();
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: [] });
      r.publicMonitor.details = patch?.details;
    }
    r.queueInstances = queues.size;
    r.queueState = [...queues].map((queue) => ({ terminalsSize: queue.terminals?.size }));
  } finally {
    CommandTelemetryOwner.prototype.start = original.start; cp.spawn = original.spawn;
    if (originalServiceStart) mod.WindowsIoCounterService.prototype.start = originalServiceStart;
    if (queueOriginals) Object.assign(mod.HostCaptureSettlementQueue.prototype, queueOriginals);
    Module.syncBuiltinESMExports?.();
    r.harnessRecovery.required = Boolean((ownerServer && !ownerServerClosed) || (sampler && !sampler.terminalObserved()));
    try { if (service && sampler && !sampler.terminalObserved()) await closeServiceNaturally(service, [sampler], r.harnessRecovery); } catch (error) { r.harnessRecovery.serviceError = { message: error.message }; }
    try { if (owner && !owner.closed) await owner.close(); } catch (error) { r.harnessRecovery.ownerError = { message: error.message }; }
    process.off("uncaughtException", onUncaught);
    env.restore();
  }

  const d = r.publicMonitor.details ?? {};
  const inv = r.fault.invocationId;
  if (!r.ownerIdentity?.samePrototype) throw new Error("RRT_CAPQUEUE_OWNER_NOT_CAPTURED (UNPROVEN, not a RED)");
  if (r.fault.hits !== 1) throw new Error(`RRT_CAPQUEUE_FAULT_NOT_HIT hits=${r.fault.hits} (UNPROVEN, not a RED)`);
  if (r.queueInstances !== 1) throw new Error(`RRT_CAPQUEUE_QUEUE_NOT_OBSERVED instances=${r.queueInstances} (UNPROVEN, not a RED)`);
  const childOutput = `${r.lastUpdateText ?? ""}\n${r.publicMonitor.childText ?? ""}`;
  assert.equal(r.fault.hits, 1, "H1");
  assert.match(r.fault.callerStack.join("\n"), /completePayload/, "H1");
  assert.equal(r.payloads.filter((p) => p.type === "declared_file_capture_request").length, 1, "H1");
  assert.deepEqual(r.requests.filter((rq) => rq.invocationId === inv), [], "R1");
  assert.deepEqual(r.terminalsAdded.filter((t) => t.invocationId === inv), [{ invocationId: inv, hasJob: false, captureStatus: "host_capture_requested" }], "R1");
  assert.equal(r.queueState[0].terminalsSize, 0, "R2: a terminal claiming host capture must not remain stranded outside the pending predicate");
  assert.deepEqual(r.settlements.filter((s) => s.invocationId === inv), [{ kind: "unadmitted", invocationId: inv, reason: "HOST_CAPTURE_REQUEST_NOT_ADMITTED", hasCapture: false }], "R2");
  assert.ok(r.retired.some((rt) => rt.invocationId === inv), "R3: the host never finished the terminal");
  assert.match(String(d.noOutputObservation?.reason), /^terminal outcome=succeeded/, "R4");
  assert.ok((d.invocationTelemetry || []).some((item) => item.invocationId === inv && item.declaredFileCaptureEvidence === "unavailable" && item.declaredFileCaptureUnavailableReason === "HOST_CAPTURE_REQUEST_NOT_ADMITTED"), "R5: no explicit unavailable capture record");
  assert.equal(r.publicMonitor.execute, "fulfilled", "R6");
  assert.match(childOutput, /RRT_CAPQUEUE_CHILD_START/, "R6");
  assert.match(childOutput, /RRT_CAPQUEUE_CHILD_COMPLETE/, "R6");
  assert.deepEqual(r.terminals.filter((t) => t.invocationId === inv).map((t) => t.outcome), ["succeeded"], "R6");
  assert.deepEqual(r.uncaught.map((u) => u.message), [], "R7");
  assert.equal(r.publicMonitor.samplerClosed, true, "R7");
  assert.equal(r.harnessRecovery.required, false, "R7");
}

// =============================================================================================
// rrt-m1087-monitorio-reporting
// =============================================================================================
async function runM1087MonitorIoCase(mod) {
  const root = freshRoot("rrt-m1087");
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const acks = path.join(root, "acks");
  for (const dir of [workspace, evidence, acks]) fs.mkdirSync(dir, { recursive: true });
  const childScript = path.join(workspace, "rrt-m1087-child.cjs");
  fs.writeFileSync(childScript, ['"use strict";', 'process.stdout.write("RRT_M1087_CHILD_START\\n");', 'process.stdout.write("RRT_M1087_CHILD_COMPLETE\\n");', ''].join("\n"));
  const { authorityFile, authorityBytes } = writeAuthorization(root, workspace, childScript);
  const env = withScopedEnv();
  delete process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY;
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE", authorityFile);
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256", sha256(authorityBytes));
  env.set("PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT", evidence);
  env.set("PI_ORCHESTRATOR_ALARM_ACK_ROOT", acks);
  env.set("PI_ORCHESTRATOR_WORKER_ID", "rrt-m1087");

  let tool; let resultHandler;
  const publicMonitor = {};
  Module.syncBuiltinESMExports?.();
  try {
    mod.default({ registerTool(definition) { if (definition.name === "bash") tool = definition; }, on(name, handler) { if (name === "tool_result") resultHandler = handler; }, events: { emit() {} } });
    if (!tool) throw new Error("RRT_M1087_BASH_TOOL_NOT_REGISTERED");
    const toolCallId = "rrt-m1087";
    const raw = await tool.execute(toolCallId, { command: "node rrt-m1087-child.cjs" }, undefined, undefined, { cwd: workspace, sessionManager: { getSessionId: () => "rrt-m1087", getSessionFile: () => undefined } });
    publicMonitor.execute = "fulfilled";
    publicMonitor.text = (raw.content || []).map((item) => item?.text || "").join("");
    const patch = resultHandler?.({ toolName: "bash", toolCallId, content: raw.content || [] });
    publicMonitor.details = patch?.details ?? raw.details;
  } finally {
    env.restore();
  }

  assert.equal(publicMonitor.execute, "fulfilled");
  assert.match(publicMonitor.text ?? "", /RRT_M1087_CHILD_COMPLETE/);
  const d = publicMonitor.details ?? {};
  assert.equal(Object.prototype.hasOwnProperty.call(d.monitorIo || {}, "unavailableCounterErrorDispositions"), true,
    "M1087 re-grounded proviso: details.monitorIo.unavailableCounterErrorDispositions must always be reported, never omitted");
  assert.equal(typeof d.monitorIo.unavailableCounterErrorDispositions, "number");
  const perInvocationCount = (d.invocationTelemetry || []).reduce((sum, item) => sum + (item?.counterErrorDelivery?.count || 0), 0);
  const omittedEntry = (d.invocationTelemetry || []).find((item) => item && typeof item.counterErrorDeliveryOmitted === "number");
  const omittedCount = omittedEntry ? omittedEntry.counterErrorDeliveryOmitted : 0;
  assert.equal(d.monitorIo.unavailableCounterErrorDispositions, perInvocationCount + omittedCount,
    "the reported disposition total must equal the sum of per-invocation counterErrorDelivery counts plus the omitted count");
  assert.equal(Number(d.commandOwnerAccounting?.currentOutstandingBytes), 0, "owner outstanding must be 0 after the healthy route settles");
}

// =============================================================================================
// rrt-ceiling-<variant> (8 variants): CEILING item (Claude Code run 8, 2026-09-30), owner decision of
// 30 September applying decision 4 / hard rule 3. Registered route via the same tool.execute(), no
// pipe barrier (synchronous shell built-ins, no spawned node child). The child's own `printf` writes
// N bytes directly into the actual owner's evidenceDirectory, published to the child's environment as
// RRT_CEILING_EVENT_DIR by a CommandTelemetryOwner.prototype.start hook (the same hook point the
// rrt-hr3x-<mode> cases above already use for CommandTelemetryOwner). Writing directly into
// evidenceDirectory drives measureTelemetry()'s own file-name categorization (src/worker-no-output-
// monitor.ts, the `/\.file\.|file\.observation/`, `/counter|...observation\.mailbox/`,
// `/controls|ack/`, `/terminal/` chain) without needing any new product hook: the five ceilings that
// key off on-disk evidence-directory bytes (counter, event, control, terminal, invocation/disk) are
// witnessed this way. CONTROL_QUEUE_PEAK_EXCEEDED and GLOBAL_POLL_PEAK_EXCEEDED key off the native
// counter-service transport/read-budget accounting instead of on-disk bytes; reaching them natively
// would need a raised bound or fabricated stats (hard rules 2 and 9), so they are named-open in the
// plan (ceiling-control-queue-peak, ceiling-global-poll-peak) and covered by reading the unchanged,
// still-present comparison lines only.
const CEILING_CATEGORY_SIZE = {
  counter: 16 * 1024 + 3616,      // > 16 KiB (COUNTER_TELEMETRY_PEAK_EXCEEDED)
  events: 512 * 1024 + 5712,      // > 512 KiB (EVENT_TELEMETRY_PEAK_EXCEEDED)
  controls: 64 * 1024 + 4464,     // > 64 KiB (CONTROL_TELEMETRY_PEAK_EXCEEDED)
  terminal: 256 * 1024 + 7856,    // > 256 KiB (TERMINAL_TELEMETRY_PEAK_EXCEEDED)
  disk: 1024 * 1024 + 51424,      // > 1024 KiB (INVOCATION_TELEMETRY_PEAK_EXCEEDED), via a
                                   // fileObservation-pattern name: no ceiling check reads
                                   // peakFileObservationBytes, so only peakDiskBytes (disk += every
                                   // file's size regardless of category) is driven by this file.
};
// File-name fragments that steer measureTelemetry()'s if/else-if categorization (first match wins;
// checked in this order there: fileObservation, counter, controls/ack, terminal, else events).
const CEILING_CATEGORY_NAME = {
  counter: "rrt-ceiling-counter.bin",
  events: "rrt-ceiling-payload.bin",
  controls: "rrt-ceiling-controls.bin",
  terminal: "rrt-ceiling-terminal.bin",
  disk: "rrt-ceiling-disk.file.observation.bin",
};
const CEILING_CATEGORY_MESSAGE = {
  counter: "COUNTER_TELEMETRY_PEAK_EXCEEDED",
  events: "EVENT_TELEMETRY_PEAK_EXCEEDED",
  controls: "CONTROL_TELEMETRY_PEAK_EXCEEDED",
  terminal: "TERMINAL_TELEMETRY_PEAK_EXCEEDED",
  disk: "INVOCATION_TELEMETRY_PEAK_EXCEEDED",
};
// Fixed check order in the corrected product (unchanged from the seven original throw sites): this is
// the order telemetryCeilingFailures/telemetrySettlementFailures must preserve for C2 (multi variant).
const CEILING_CHECK_ORDER = ["counter", "events", "controls", "terminal", "disk"];
const CEILING_ACCOUNTING_KEY = {
  counter: "peakCounterBytes", events: "peakEventBytes", controls: "peakControlBytes",
  terminal: "peakTerminalBytes", disk: "peakDiskBytes",
};
const CEILING_VARIANT_CATEGORIES = {
  counter: ["counter"], events: ["events"], controls: ["controls"], terminal: ["terminal"], disk: ["disk"],
  multi: ["counter", "events", "controls", "terminal", "disk"],
  "events-nonzero": ["events"],
  "with-settlement": ["events"],
};

function ceilingChildCommand(categories, { failExit } = {}) {
  const writes = categories.map((category) => {
    const size = CEILING_CATEGORY_SIZE[category];
    const name = CEILING_CATEGORY_NAME[category];
    return `printf '%*s' ${size} '' > "$RRT_CEILING_EVENT_DIR/${name}"`;
  });
  const parts = [...writes, "printf 'RRT_CEILING_CHILD_COMPLETE\\n'"];
  if (failExit) parts.push("false");
  return parts.join("; ");
}

async function runCeilingCase(mod, variant) {
  const categories = CEILING_VARIANT_CATEGORIES[variant];
  if (!categories) throw new Error(`RRT_CEILING_UNKNOWN_VARIANT ${variant}`);
  const withSettlement = variant === "with-settlement";
  const failExit = variant === "events-nonzero";
  const root = freshRoot(`rrt-ceiling-${variant}`);
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const acks = path.join(root, "acks");
  for (const dir of [workspace, evidence, acks]) fs.mkdirSync(dir, { recursive: true });
  const { authorityFile, authorityBytes } = writeAuthorization(root, workspace, undefined);
  const env = withScopedEnv();
  delete process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY;
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE", authorityFile);
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256", sha256(authorityBytes));
  env.set("PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT", evidence);
  env.set("PI_ORCHESTRATOR_ALARM_ACK_ROOT", acks);
  env.set("PI_ORCHESTRATOR_WORKER_ID", `rrt-ceiling-${variant}`);

  const EVENT_DRAIN_FAULT_MESSAGE = "RRT_CEILING_ONE_SHOT_EVENT_DRAIN_FAULT";
  const r = { harnessRecovery: {}, publicMonitor: {}, faultHits: {} };
  let owner; let capturedDir; let commandRoot; let ownerServer; let ownerServerClosed = false;
  let service; let sampler; let tool; let resultHandler;
  let ownerDrainFaultEnabled = withSettlement;
  const original = { ownerStart: CommandTelemetryOwner.prototype.start, spawn: cp.spawn };
  CommandTelemetryOwner.prototype.start = function rrtCeilingOwnerStart(...args) {
    owner = this;
    capturedDir = this.evidenceDirectory;
    commandRoot = path.dirname(capturedDir);
    process.env.RRT_CEILING_EVENT_DIR = String(capturedDir).split(path.sep).join("/");
    const returned = original.ownerStart.apply(this, args);
    ownerServer = this.server; if (ownerServer) ownerServer.once("close", () => { ownerServerClosed = true; });
    if (ownerDrainFaultEnabled) {
      const realDrain = this.drainEvents;
      this.drainEvents = function rrtCeilingOwnerDrain(...drainArgs) {
        const stack = new Error("fault caller").stack;
        if (ownerDrainFaultEnabled && stack.includes("processMonitorDrainTurn")) {
          ownerDrainFaultEnabled = false;
          r.faultHits["owner.drainEvents"] = (r.faultHits["owner.drainEvents"] || 0) + 1;
          throw new Error(EVENT_DRAIN_FAULT_MESSAGE);
        }
        return realDrain.apply(this, drainArgs);
      };
    }
    return returned;
  };
  cp.spawn = function rrtCeilingSpawn(...args) {
    const child = original.spawn.apply(this, args);
    if (service && !sampler && /powershell\.exe$/i.test(String(args[0]))) sampler = observeChild(child, `rrt-ceiling-sampler-${variant}`);
    return child;
  };
  Module.syncBuiltinESMExports?.();
  let originalServiceStart;
  try {
    originalServiceStart = mod.WindowsIoCounterService.prototype.start;
    mod.WindowsIoCounterService.prototype.start = function rrtCeilingServiceStart(...args) { service = this; return originalServiceStart.apply(this, args); };
    mod.default({ registerTool(definition) { if (definition.name === "bash") tool = definition; }, on(name, handler) { if (name === "tool_result") resultHandler = handler; }, events: { emit() {} } });
    if (!tool) throw new Error("RRT_CEILING_BASH_TOOL_NOT_REGISTERED");
    const command = ceilingChildCommand(categories, { failExit });
    const toolCallId = `rrt-ceiling-${variant}`;
    try {
      const raw = await tool.execute(toolCallId, { command }, undefined, undefined, { cwd: workspace, sessionManager: { getSessionId: () => "rrt-ceiling", getSessionFile: () => undefined } });
      r.publicMonitor.execute = "fulfilled";
      r.publicMonitor.text = (raw.content || []).map((item) => item?.text || "").join("");
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: raw.content || [] });
      r.publicMonitor.details = patch?.details ?? raw.details;
    } catch (error) {
      r.publicMonitor.execute = "rejected";
      r.publicMonitor.error = { name: error?.name, message: String(error?.message || error).slice(0, 4000), isAggregate: error instanceof AggregateError };
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: [] });
      r.publicMonitor.details = patch?.details;
    }
    r.commandRootExistsAfterResult = commandRoot !== undefined ? fs.existsSync(commandRoot) : undefined;
  } finally {
    CommandTelemetryOwner.prototype.start = original.ownerStart; cp.spawn = original.spawn;
    if (originalServiceStart) mod.WindowsIoCounterService.prototype.start = originalServiceStart;
    Module.syncBuiltinESMExports?.();
    r.harnessRecovery.required = Boolean((ownerServer && !ownerServerClosed) || (sampler && !sampler.terminalObserved()));
    try { if (service && sampler && !sampler.terminalObserved()) await closeServiceNaturally(service, [sampler], r.harnessRecovery); } catch (error) { r.harnessRecovery.serviceError = { message: error.message }; }
    try { if (owner && !owner.closed) await owner.close(); } catch (error) { r.harnessRecovery.ownerError = { message: error.message }; }
    env.restore();
  }

  const d = r.publicMonitor.details ?? {};
  const settlements = d.monitorIo?.telemetrySettlementFailures ?? [];
  const ceilingEntries = settlements.filter((s) => s.step === "telemetry-ceiling");
  const expectedMessages = CEILING_CHECK_ORDER.filter((c) => categories.includes(c)).map((c) => CEILING_CATEGORY_MESSAGE[c]);

  // C1 (checked first, so a ceiling-caused rejection is reported as C1, not as the P0 premise check
  // below going unmet as a side effect): the child's real outcome is the result, never the ceiling
  // message standing in for it.
  if (failExit) {
    assert.equal(r.publicMonitor.execute, "rejected", "C1");
    assert.equal(r.publicMonitor.error?.isAggregate, false, "C1: the child outcome must not be wrapped with the ceiling diagnostic");
    assert.match(r.publicMonitor.error?.message ?? "", /RRT_CEILING_CHILD_COMPLETE/, "C1");
    assert.match(r.publicMonitor.error?.message ?? "", /code 1/, "C1");
    for (const message of expectedMessages) assert.doesNotMatch(r.publicMonitor.error?.message ?? "", new RegExp(message), "C1: ceiling message must not replace the real outcome");
  } else {
    assert.equal(r.publicMonitor.execute, "fulfilled", `C1: a telemetry ceiling became the command's result: ${JSON.stringify(r.publicMonitor.error)}`);
    assert.match(r.publicMonitor.text ?? "", /RRT_CEILING_CHILD_COMPLETE/, "C1");
    for (const message of expectedMessages) assert.doesNotMatch(r.publicMonitor.text ?? "", new RegExp(message), "C1: ceiling message must not replace the real outcome");
  }

  // P0: premise -- the write actually landed and was actually sized past the relevant ceiling(s).
  // Checked through telemetryAccounting (d.telemetryAccounting), which survives command-root cleanup.
  for (const category of categories) {
    const key = CEILING_ACCOUNTING_KEY[category];
    const value = Number(d.telemetryAccounting?.[key]);
    if (!(value > 0)) throw new Error(`RRT_CEILING_PREMISE_NOT_MET ${variant} ${category} ${key}=${d.telemetryAccounting?.[key]} (UNPROVEN, not a RED)`);
  }
  if (withSettlement && (r.faultHits["owner.drainEvents"] || 0) !== 1) {
    throw new Error(`RRT_CEILING_HOOK_MISS ${variant} ${JSON.stringify(r.faultHits)} (UNPROVEN, not a RED)`);
  }

  // C2: one step:"telemetry-ceiling" entry per exceeded ceiling, in the fixed check order, after any
  // settlement-step entries (with-settlement only).
  assert.deepEqual(ceilingEntries.map((e) => e.message), expectedMessages, `C2: ${JSON.stringify(settlements)}`);
  for (const entry of ceilingEntries) {
    assert.equal(entry.name, "Error", "C2");
    assert.equal(entry.nativeSettlement, "not-established", "C2");
  }
  if (withSettlement) {
    assert.equal(settlements.length, categories.length + 1, `C2: ${JSON.stringify(settlements)}`);
    const drainEntry = settlements.find((s) => s.step === "event-drain");
    assert.ok(drainEntry, `C2: no event-drain settlement entry: ${JSON.stringify(settlements)}`);
    assert.equal(drainEntry.message, EVENT_DRAIN_FAULT_MESSAGE, "C2");
    assert.equal(settlements.indexOf(drainEntry) < settlements.indexOf(ceilingEntries[0]), true, "C2: settlement-step entries precede telemetry-ceiling entries");
  } else {
    assert.equal(settlements.length, categories.length, `C2: ${JSON.stringify(settlements)}`);
  }

  // C3: the reported peak is strictly above the unchanged ceiling literal for each triggered category.
  const CEILING_LITERAL = { counter: 16 * 1024, events: 512 * 1024, controls: 64 * 1024, terminal: 256 * 1024, disk: 1024 * 1024 };
  for (const category of categories) {
    const key = CEILING_ACCOUNTING_KEY[category];
    assert.ok(Number(d.telemetryAccounting?.[key]) > CEILING_LITERAL[category], `C3: ${category} ${key}=${d.telemetryAccounting?.[key]}`);
  }

  // C4: no harness recovery was needed -- the owner server and the native sampler settled on their own.
  assert.equal(r.harnessRecovery.required, false, `C4: ${JSON.stringify(r.harnessRecovery)}`);

  // C5: the command root is cleaned up (rmSync via the tool_result cleanup patch), even though a
  // ceiling was exceeded.
  assert.equal(r.commandRootExistsAfterResult, false, "C5: command root was not cleaned after a ceiling breach");
}

// =============================================================================================
// rrt-interval-<variant> (3 variants): P-INTERVAL item (Claude Code run 8, 2026-09-30), owner decision
// of 30 September applying decision 4 / hard rule 3. Registered route WITH a named-pipe release
// barrier around an authorized node test child, modelled on runRegisteredPipeCase above. A one-shot
// fault is armed on either EventReader.prototype.poll ("poll", "poll-nonzero") or the captured
// CommandTelemetryOwner instance's drainEvents ("owner-drain"), the same two call sites
// processEvents() reaches from the exec interval callback. The hook fires only when the call stack
// contains "processEvents" and not "processMonitorDrainTurn" -- only from the periodic setInterval
// tick, never from the post-execution final drain.
// =============================================================================================
function intervalFaultMessage(variant) {
  return `RRT_INTERVAL_ONE_SHOT_${variant.toUpperCase().replace(/-/g, "_")}_FAULT`;
}

async function runIntervalCase(mod, variant) {
  const nonzero = variant === "poll-nonzero";
  const root = freshRoot(`rrt-interval-${variant}`);
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const acks = path.join(root, "acks");
  for (const dir of [workspace, evidence, acks]) fs.mkdirSync(dir, { recursive: true });
  const pipeName = `\\\\.\\pipe\\rrt-interval-${crypto.randomBytes(8).toString("hex")}`;
  const childScript = path.join(workspace, "rrt-interval-child.cjs");
  const childLines = [
    '"use strict";',
    'process.stdout.write("RRT_INTERVAL_CHILD_START\\n");',
    'const net = require("node:net");',
    `const socket = net.connect(${JSON.stringify(pipeName)});`,
    'let received = "";',
    'socket.setEncoding("utf8");',
    'socket.on("data", (chunk) => {',
    '  received += chunk;',
    '  if (received.includes("release\\n")) {',
    '    process.stdout.write("RRT_INTERVAL_CHILD_COMPLETE\\n");',
    '    socket.end();',
    ...(nonzero ? ['    throw new Error("RRT_INTERVAL_CHILD_NATURAL_NONZERO");'] : []),
    '  }',
    '});',
    'socket.on("error", (error) => { process.stdout.write("RRT_INTERVAL_CHILD_PIPE_ERROR " + error.message + "\\n"); });',
    "",
  ];
  fs.writeFileSync(childScript, childLines.join("\n"));
  const { authorityFile, authorityBytes } = writeAuthorization(root, workspace, childScript);
  const env = withScopedEnv();
  delete process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY; // product default policy (pollMs 1000ms)
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE", authorityFile);
  env.set("PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256", sha256(authorityBytes));
  env.set("PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT", evidence);
  env.set("PI_ORCHESTRATOR_ALARM_ACK_ROOT", acks);
  env.set("PI_ORCHESTRATOR_WORKER_ID", `rrt-interval-${variant}`);

  const FAULT_MESSAGE = intervalFaultMessage(variant);
  const r = { fault: { hits: 0 }, terminals: [], harnessRecovery: {}, publicMonitor: {}, uncaught: [] };
  let faultError;
  const onUncaught = (error) => r.uncaught.push({ message: String(error?.message || error), isFault: error === faultError });
  process.on("uncaughtException", onUncaught);
  let childSocket; let releaseRequested = false; let released = false; let owner;
  const server = net.createServer((socket) => {
    childSocket = socket;
    if (releaseRequested && !released) { released = true; socket.write("release\n"); }
  });
  const serverClosed = new Promise((resolve) => server.once("close", resolve));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipeName, resolve); });
  const release = () => {
    if (releaseRequested) return;
    releaseRequested = true;
    if (childSocket && !released) { released = true; childSocket.write("release\n"); }
  };
  const scheduleRelease = () => queueMicrotask(release);

  const original = { ownerStart: CommandTelemetryOwner.prototype.start, spawn: cp.spawn };
  let service; let sampler; let ownerServer; let ownerServerClosed = false; let tool; let resultHandler;
  let armed = true;
  CommandTelemetryOwner.prototype.start = function rrtIntervalOwnerStart(...args) {
    owner = this;
    r.ownerSamePrototype = Object.getPrototypeOf(this) === CommandTelemetryOwner.prototype;
    const returned = original.ownerStart.apply(this, args);
    ownerServer = this.server; if (ownerServer) ownerServer.once("close", () => { ownerServerClosed = true; });
    const realDrain = this.drainEvents;
    this.drainEvents = function rrtIntervalOwnerDrain(...drainArgs) {
      const stack = String(new Error("fault caller").stack);
      const fromInterval = stack.includes("processEvents") && !stack.includes("processMonitorDrainTurn");
      if (variant === "owner-drain" && armed && fromInterval) {
        armed = false;
        r.fault.hits += 1; r.fault.callerStack = stack.split("\n").slice(0, 16);
        faultError = new Error(FAULT_MESSAGE);
        scheduleRelease();
        throw faultError;
      }
      const drained = realDrain.apply(this, drainArgs);
      for (const event of drained) if (event?.type === "invocation_terminal") r.terminals.push({ invocationId: event.invocationId, outcome: event.outcome, exitCode: event.exitCode });
      return drained;
    };
    return returned;
  };
  cp.spawn = function rrtIntervalSpawn(...args) {
    const child = original.spawn.apply(this, args);
    if (service && !sampler && /powershell\.exe$/i.test(String(args[0]))) sampler = observeChild(child, `rrt-interval-sampler-${variant}`);
    return child;
  };
  Module.syncBuiltinESMExports?.();
  const originalPoll = mod.EventReader.prototype.poll;
  let originalServiceStart;
  try {
    originalServiceStart = mod.WindowsIoCounterService.prototype.start;
    mod.WindowsIoCounterService.prototype.start = function rrtIntervalServiceStart(...args) { service = this; return originalServiceStart.apply(this, args); };
    mod.EventReader.prototype.poll = function rrtIntervalPoll(...args) {
      const stack = String(new Error("fault caller").stack);
      const fromInterval = stack.includes("processEvents") && !stack.includes("processMonitorDrainTurn");
      if ((variant === "poll" || variant === "poll-nonzero") && armed && fromInterval) {
        armed = false;
        r.fault.hits += 1; r.fault.callerStack = stack.split("\n").slice(0, 16);
        faultError = new Error(FAULT_MESSAGE);
        scheduleRelease();
        throw faultError;
      }
      return originalPoll.apply(this, args);
    };
    mod.default({ registerTool(definition) { if (definition.name === "bash") tool = definition; }, on(name, handler) { if (name === "tool_result") resultHandler = handler; }, events: { emit() {} } });
    if (!tool) throw new Error("RRT_INTERVAL_BASH_TOOL_NOT_REGISTERED");
    const toolCallId = `rrt-interval-${variant}`;
    try {
      const raw = await tool.execute(toolCallId, { command: "node rrt-interval-child.cjs" }, undefined, undefined, { cwd: workspace, sessionManager: { getSessionId: () => "rrt-interval", getSessionFile: () => undefined } });
      r.publicMonitor.execute = "fulfilled";
      r.publicMonitor.text = (raw.content || []).map((item) => item?.text || "").join("");
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: raw.content || [] });
      r.publicMonitor.details = patch?.details ?? raw.details;
    } catch (error) {
      r.publicMonitor.execute = "rejected";
      r.publicMonitor.error = { name: error?.name, message: String(error?.message || error).slice(0, 4000), isFault: error === faultError, isAggregate: error instanceof AggregateError };
      const patch = resultHandler?.({ toolName: "bash", toolCallId, content: [] });
      r.publicMonitor.details = patch?.details;
    }
    r.publicMonitor.samplerClosedAfterExecute = sampler?.terminalObserved();
  } finally {
    CommandTelemetryOwner.prototype.start = original.ownerStart; cp.spawn = original.spawn;
    if (originalServiceStart) mod.WindowsIoCounterService.prototype.start = originalServiceStart;
    mod.EventReader.prototype.poll = originalPoll;
    Module.syncBuiltinESMExports?.();
    release();
    r.harnessRecovery.required = Boolean((ownerServer && !ownerServerClosed) || (sampler && !sampler.terminalObserved()));
    try { if (service && sampler && !sampler.terminalObserved()) await closeServiceNaturally(service, [sampler], r.harnessRecovery); }
    catch (error) { r.harnessRecovery.serviceError = error.message; }
    try { if (owner && !owner.closed) await owner.close(); } catch (error) { r.harnessRecovery.ownerError = error.message; }
    server.close(); await serverClosed;
    process.off("uncaughtException", onUncaught);
    env.restore();
  }

  const d = r.publicMonitor.details ?? {};
  if (!r.ownerSamePrototype) throw new Error("RRT_INTERVAL_OWNER_NOT_CAPTURED (UNPROVEN, not a RED)");
  if (r.fault.hits !== 1) throw new Error(`RRT_INTERVAL_HOOK_MISS ${variant} hits=${r.fault.hits} (UNPROVEN, not a RED)`);
  if (!/processEvents/.test(r.fault.callerStack.join("\n")) || /processMonitorDrainTurn/.test(r.fault.callerStack.join("\n")))
    throw new Error(`RRT_INTERVAL_FAULT_NOT_FROM_INTERVAL ${JSON.stringify(r.fault)} (UNPROVEN, not a RED)`);

  // I0: hook hit exactly once, from the interval.
  assert.equal(r.fault.hits, 1, "I0");

  // I1: no uncaught exception escaped the interval callback (this is what P-INTERVAL corrects; it is
  // the assertion that fails, status 1, on the pre-correction before-image).
  assert.deepEqual(r.uncaught.map((u) => u.message), [], `I1: ${JSON.stringify(r.uncaught)}`);

  // I2: the child's real outcome is the tool call's result, never the interval fault.
  if (nonzero) {
    assert.equal(r.publicMonitor.execute, "rejected", "I2");
    assert.equal(r.publicMonitor.error?.isFault, false, "I2");
    assert.equal(r.publicMonitor.error?.isAggregate, false, "I2");
    assert.match(r.publicMonitor.error?.message ?? "", /RRT_INTERVAL_CHILD_COMPLETE/, "I2");
    assert.doesNotMatch(r.publicMonitor.error?.message ?? "", new RegExp(FAULT_MESSAGE), "I2");
  } else {
    assert.equal(r.publicMonitor.execute, "fulfilled", `I2: interval failure became the command's result: ${JSON.stringify(r.publicMonitor.error)}`);
    assert.match(r.publicMonitor.text ?? "", /RRT_INTERVAL_CHILD_COMPLETE/, "I2");
    assert.doesNotMatch(r.publicMonitor.text ?? "", new RegExp(FAULT_MESSAGE), "I2");
  }

  // I3: exactly the one interval-poll entry.
  const settlements = d.monitorIo?.telemetrySettlementFailures ?? [];
  const entry = settlements.find((s) => s.step === "interval-poll");
  assert.ok(entry, `I3: no interval-poll settlement entry: ${JSON.stringify(settlements)}`);
  assert.equal(settlements.length, 1, `I3: ${JSON.stringify(settlements)}`);
  assert.equal(entry.name, "Error", "I3");
  assert.equal(entry.message, FAULT_MESSAGE, "I3");
  assert.equal(entry.nativeSettlement, "not-established", "I3");

  // I4: exactly one terminal, matching the child's real outcome.
  assert.equal(r.terminals.length, 1, `I4: ${JSON.stringify(r.terminals)}`);
  if (nonzero) assert.equal(r.terminals[0].outcome, "failed", "I4");
  else assert.equal(r.terminals[0].outcome, "succeeded", "I4");

  // I5: no harness recovery was needed -- the owner server and the native sampler settled on their own.
  assert.equal(r.harnessRecovery.required, false, `I5: ${JSON.stringify(r.harnessRecovery)}`);

  // I6: no retained-counter-service-failure key (this fault site is unrelated to the counter transport).
  assert.equal(Object.prototype.hasOwnProperty.call(d.monitorIo || {}, "retainedCounterServiceFailure"), false, "I6");
}

// =============================================================================================
// Public surface
// =============================================================================================
const CASES = Object.freeze([
  "rrt-hr3-sink-zero",
  "rrt-hr3-sink-nonzero",
  "rrt-hr3x-sink-end-throw",
  "rrt-capqueue-unadmitted-terminal",
  "rrt-m1087-monitorio-reporting",
  "rrt-hr3x-sampler-close",
  "rrt-hr3x-reader-poll",
  "rrt-hr3x-owner-drain",
  "rrt-hr3x-final-drain",
  "rrt-hr3x-read-budget-finalize",
  "rrt-hr3x-telemetry-owner-close",
  "rrt-hr3x-sampler-end-throw",
  "rrt-hr3x-multi-drain-finalize",
  "rrt-hr3x-sampler-close-nonzero",
  "rrt-ceiling-counter",
  "rrt-ceiling-events",
  "rrt-ceiling-controls",
  "rrt-ceiling-terminal",
  "rrt-ceiling-disk",
  "rrt-ceiling-multi",
  "rrt-ceiling-events-nonzero",
  "rrt-ceiling-with-settlement",
  "rrt-interval-poll",
  "rrt-interval-poll-nonzero",
  "rrt-interval-owner-drain",
]);
const INSTANCE_MODES = new Set([
  "sampler-close", "reader-poll", "owner-drain", "final-drain", "read-budget-finalize",
  "telemetry-owner-close", "sampler-end-throw", "multi-drain-finalize", "sampler-close-nonzero",
]);

async function runRegisteredRouteCase(caseId, options = {}) {
  if (!CASES.includes(caseId)) throw new Error(`RRT_UNKNOWN_CASE ${caseId}`);
  const mod = await resolveMonitor(options.loadMonitor);
  if (caseId === "rrt-hr3-sink-zero") return runRegisteredPipeCase(mod, "sink-zero", "hr3");
  if (caseId === "rrt-hr3-sink-nonzero") return runRegisteredPipeCase(mod, "sink-nonzero", "hr3");
  if (caseId === "rrt-hr3x-sink-end-throw") return runRegisteredPipeCase(mod, "sink-end-throw", "hr3x");
  if (caseId === "rrt-capqueue-unadmitted-terminal") return runCapqueueCase(mod);
  if (caseId === "rrt-m1087-monitorio-reporting") return runM1087MonitorIoCase(mod);
  if (caseId.startsWith("rrt-ceiling-")) return runCeilingCase(mod, caseId.slice("rrt-ceiling-".length));
  if (caseId.startsWith("rrt-interval-")) return runIntervalCase(mod, caseId.slice("rrt-interval-".length));
  const mode = caseId.slice("rrt-hr3x-".length);
  if (INSTANCE_MODES.has(mode)) return runInstanceCase(mod, mode);
  throw new Error(`RRT_UNKNOWN_CASE ${caseId}`);
}

module.exports = { CASES, runRegisteredRouteCase };

if (require.main === module) {
  (async () => {
    for (const caseId of CASES) {
      await runRegisteredRouteCase(caseId);
      console.log(`PASS ${caseId}`);
    }
    console.log("PASS test-2026-09-29-registered-route-outcomes (all cases)");
  })();
  // A rejected promise here is left unhandled on purpose: Node turns an unhandled rejection into a
  // non-zero termination status by itself, so a failing case is reported as a stopped/failed native run
  // (status 1) without this file ever setting that termination status itself.
}
