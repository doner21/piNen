"use strict";

/** Finite real Windows sampler protocol, not a replacement sampler or process census.
 * Each request accepts ANY next response (including malformed/wrong/refused), or
 * native EOF/error/close. Public promises are inspected at that causal boundary;
 * none is trusted to release a native resource or to terminate this fixture.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const net = require("node:net");
const Module = require("node:module");
const { observeChild, trackPromise, closeServiceNaturally } = require("./item3-native-counter-witness.cjs");
const NATIVE_SPAWN = childProcess.spawn;
const ROOT = path.resolve(__dirname, "..", "..");
const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
const { CommandTelemetryOwner, CommandTelemetryClient } = require(path.join(ROOT, "src", "command-telemetry-owner.cjs"));

function isolatedRoot(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  assert.ok(path.isAbsolute(root) && root.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`));
  for (const [key, name] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_ORCHESTRATOR_RUNS_ROOT: "runs",
    PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next", PI_CODING_AGENT_SESSION_DIR: "sessions" })) {
    process.env[key] = path.join(root, name);
    fs.mkdirSync(process.env[key], { recursive: true });
  }
  for (const name of ["workspace", "evidence"]) fs.mkdirSync(path.join(root, name));
  process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = root;
  process.env.PI_OFFLINE = "1";
  return root;
}

function loadFreshMonitor(evidenceRoot, label) {
  process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter);
  Module._initPaths();
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  return createJiti(path.join(evidenceRoot, `${label}-loader.cjs`), {
    interopDefault: true, moduleCache: false, fsCache: false,
  })(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
}

function makeTarget(evidenceRoot) {
  const earliestCreationUnixMs = Date.now();
  const child = NATIVE_SPAWN(process.execPath, ["-e", "process.stdin.resume();"], {
    cwd: evidenceRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
  });
  return { child, witness: observeChild(child, "target"), earliestCreationUnixMs, latestCreationUnixMs: Date.now() };
}

function requireFrame(response, type) {
  if (response.kind !== "frame" || response.frame?.type !== type) {
    throw new Error(`NATIVE_PROTOCOL_RESPONSE: expected ${type}; observed ${JSON.stringify(response)}`);
  }
}
// Arm before waiting for native closure. A rejected public close must not
// strand the EOF fallback behind the very native-close promise it must release.
function armRejectedCloseFallback(record, samplers, recovery) {
  const release = () => {
    if (record.status !== "rejected") return;
    recovery.originalCloseError = record.snapshot().error;
    for (const sampler of samplers) {
      if (!sampler.terminalObserved() && !sampler.child.stdin.writableEnded && !sampler.child.stdin.destroyed) {
        recovery.safetyFallbackRequired = true;
        sampler.child.stdin.end();
      }
    }
  };
  if (record.observed) record.observed.then(release);
  else release();
}
async function lifecycle(evidenceRoot, mode, fixtureFault) {
  if (process.platform !== "win32") return { platform: process.platform, impossible: true };
  assert.ok(path.isAbsolute(evidenceRoot) && evidenceRoot.length > 0);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const samplers = [];
  const previousSpawn = childProcess.spawn;
  const switches = ["PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_READY", "PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_SAMPLES"];
  const previous = switches.map((key) => process.env[key]);
  for (const key of switches) delete process.env[key];
  if (mode === "repeated-start") process.env[switches[0]] = "1";
  if (mode === "exit-order") process.env[switches[1]] = "1";
  childProcess.spawn = function retainedSpawn(...args) {
    const child = previousSpawn.apply(this, args);
    const sampler = observeChild(child, `${mode}-sampler-${samplers.length + 1}`);
    sampler.ready = sampler.nextFrame(); // installed before production listeners
    samplers.push(sampler);
    return child;
  };
  Module.syncBuiltinESMExports?.();
  const result = { platform: process.platform, mode, recovery: { safetyFallbackRequired: false }, publicPromises: {} };
  const tracked = {};
  let service, target, bodyError;
  try {
    const monitor = loadFreshMonitor(evidenceRoot, mode);
    const states = [];
    service = new monitor.WindowsIoCounterService(evidenceRoot, "4".repeat(64), `finite-${mode}`, undefined,
      (_invocationId, state) => states.push(state));
    tracked.start = trackPromise(() => service.start());
    if (fixtureFault === "close-before-eof") {
      const originalFlush = service.flushQueue;
      service.flushQueue = function failurePathFlush() {
        service.flushQueue = originalFlush;
        throw new Error("FIXTURE_CLOSE_BEFORE_EOF");
      };
    }
    if (mode === "repeated-start") {
      tracked.secondStart = trackPromise(() => service.start());
      result.readyOutcomes = await Promise.all(samplers.map((sampler) => sampler.ready));
      result.terminalOutcomes = await Promise.all(samplers.map((sampler) => sampler.close));
      result.spawnCount = samplers.length;
      result.distinctPids = new Set(samplers.map((sampler) => sampler.child.pid)).size;
      result.settlements = [tracked.start.status, tracked.secondStart.status];
    } else {
      if (samplers.length !== 1) throw new Error(`NATIVE_SETUP_SPAWN_COUNT ${samplers.length}`);
      const sampler = samplers[0];
      result.ready = await sampler.ready;
      requireFrame(result.ready, "service_ready");
      // Do not await the public start promise here. The real response proves
      // only that the sampler wrote readiness. Continue through the public
      // register API; if readiness propagation is broken, register fails
      // synchronously and finally closes the retained sampler through EOF.
      result.startAtReady = tracked.start.snapshot();
      target = makeTarget(evidenceRoot);
      if (mode === "refused-registration") {
        target.child.stdin.end();
        result.targetTerminal = await target.witness.close;
      }
      const invocationId = "finite-invocation", transportId = "1".repeat(32), bindingGeneration = "2".repeat(32);
      if (mode === "fail-close") tracked.failedState = trackPromise(() => service.waitForCounterState(transportId, 0));
      else tracked.registered = trackPromise(() => service.waitForCounterState(transportId, 0));
      service.register({ invocationId, transportId, bindingGeneration, pid: target.child.pid, expectedExecutable: process.execPath,
        earliestCreationUnixMs: target.earliestCreationUnixMs, latestCreationUnixMs: target.latestCreationUnixMs });
      if (mode === "fail-close") {
        tracked.failAndClose = trackPromise(() => service.failAndClose("finite preflight requested service close"));
      } else if (mode === "refused-registration") {
        // Public close flushes the admitted registration frame and then sends
        // EOF. The real sampler must answer or close; no response promise can
        // hold this fixture open.
        tracked.protocolClose = trackPromise(() => service.close());
      } else {
        const requestId = "3".repeat(32);
        tracked.sampled = trackPromise(() => service.waitForCounterState(transportId, 1));
        if (mode === "exit-order") {
          tracked.terminalState = trackPromise(() => service.waitForCounterState(transportId, 2));
          sampler.onExit(() => {
            tracked.closeAtExit = trackPromise(() => service.close());
            tracked.closeAtExit.observed?.then(() => {
              result.closeResolvedBeforeNativeClose = tracked.closeAtExit.status === "fulfilled" && !sampler.terminalObserved();
            });
          });
        }
        service.sample({ invocationId, transportId, bindingGeneration, requestId, requestGeneration: 1 });
        if (mode === "protocol") tracked.protocolClose = trackPromise(() => service.close());
      }
      // Failure-path fixture control deliberately rejects the real service's
      // public close before EOF; it is not a substitute sampler or result.
      if (fixtureFault === "close-before-eof") {
        result.fixtureFault = fixtureFault;
      }
      for (const name of ["failAndClose", "protocolClose"]) {
        if (!tracked[name]) continue;
        if (fixtureFault === "close-before-eof" && name === "protocolClose") {
          // The first rejected close is the causal barrier. Give the real
          // service its public fault-removed retry before test-safety EOF.
          tracked[name].observed?.then(() => {
            tracked.recoveryClose = trackPromise(() => service.close());
            armRejectedCloseFallback(tracked.recoveryClose, samplers, result.recovery);
          });
        } else armRejectedCloseFallback(tracked[name], samplers, result.recovery);
      }
      // Native closure remains the barrier, now with rejection-driven EOF
      // reachable before it. Neither elapsed time nor public fulfillment proves it.
      result.samplerClose = await sampler.close;
      result.samplerExit = await sampler.exit;
      result.rawRegistered = sampler.frames.find((entry) => ["registered", "error"].includes(entry.frame?.type));
      result.rawSampled = sampler.frames.find((entry) => entry.frame?.type === "sample");
      if (mode === "refused-registration" && result.rawRegistered?.frame?.type === "error") {
        result.refused = { responseType: "error", message: result.rawRegistered.frame.message };
      }
      if (mode === "exit-order") {
        const exitIndex = sampler.events.findIndex((event) => event.type === "child-exit");
        result.adverseOrderingObserved = ["stdout-close", "stderr-close"].some((type) =>
          sampler.events.findIndex((event) => event.type === type) > exitIndex);
        if (!result.adverseOrderingObserved) result.coverageGap = "Actual PowerShell sampler closed both output streams before exit; separate test-owned native caller coverage exercises the adverse order.";
      }
      result.stateTypes = states.map((state) => state.type);
    }
  } catch (error) { bodyError = error; }
  finally {
    // Always attempt public recovery, even after assertion/setup failures and
    // even if native close has already happened. Preserve the original error.
    try {
      if (service) await closeServiceNaturally(service, samplers, result.recovery);
    } catch (error) { result.recovery.fixtureError = { message: error.message, stack: error.stack }; }
    if (target) {
      if (!target.child.stdin.writableEnded && !target.child.stdin.destroyed) target.child.stdin.end();
      result.targetTerminal = await target.witness.close;
      result.target = target.witness.snapshot();
    }
    result.samplers = samplers.map((sampler) => sampler.snapshot());
    result.sampler = result.samplers[0];
    result.samplerTerminal = result.sampler?.terminalOutcome;
    for (const [name, record] of Object.entries(tracked)) result.publicPromises[name] = record.snapshot();
    result.registered = tracked.registered?.value;
    result.sampled = tracked.sampled?.value;
    result.failedState = tracked.failedState?.value;
    if (result.refused) result.refused.stateType = tracked.registered?.value?.type;
    result.childCleared = service?.child === undefined;
    result.activeRegistrations = service?.active.size;
    if (bodyError) result.bodyError = { name: bodyError.name, message: bodyError.message, stack: bodyError.stack };
    childProcess.spawn = previousSpawn;
    switches.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    Module.syncBuiltinESMExports?.();
    fs.writeFileSync(path.join(evidenceRoot, "native-lifecycle.json"), JSON.stringify(result, null, 2));
  }
  if (bodyError) { bodyError.nativeObservation = result; throw bodyError; }
  return result;
}

async function runNativeOwnerCallerLifecycle(evidenceRoot, mode) {
  if (process.platform !== "win32") return { platform: process.platform, impossible: true };
  assert.ok(["fallback-refusal", "fallback-loss", "coalesced-sample"].includes(mode));
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const owner = new CommandTelemetryOwner({
    commandRoot: path.join(evidenceRoot, "owner"), evidenceDirectory: path.join(evidenceRoot, "owner-evidence"),
    commandId: `finite-native-caller-${mode}`,
  });
  const invocationId = mode === "fallback-refusal" ? "fa".repeat(12) : mode === "fallback-loss" ? "fc".repeat(12) : "cb".repeat(12);
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  const permissions = new Map();
  const blockers = [];
  const samplers = [];
  const originalReserveHostWork = owner.reserveHostWork;
  const originalSettleHostPermission = owner.settleHostPermission;
  let admissionPhase = "setup";
  const previousSpawn = childProcess.spawn;
  let service, target, bodyError;
  const result = { platform: process.platform, mode, recovery: { safetyFallbackRequired: false }, events: [], nativeResponses: [], admissions: [], unavailableRecords: [] };
  owner.reserveHostWork = function observedReserve(...args) {
    const permission = originalReserveHostWork.apply(this, args);
    result.admissions.push({ phase: admissionPhase, invocationId: args[0], channel: args[1], bytes: args[2], admitted: Boolean(permission) });
    return permission;
  };
  // fallback-loss only: pass-through witness of the owner's own settlement of
  // a host permission, so capacity is measured after the register response
  // permission has really settled (its delivery write callback), not before.
  const settledPermissions = new Map();
  const settlementWaiters = new Map();
  if (mode === "fallback-loss") owner.settleHostPermission = function observedSettle(admitted, outcome) {
    const held = Boolean(admitted && this.hostPermissions.has(admitted.permissionId));
    const value = originalSettleHostPermission.apply(this, [admitted, outcome]);
    if (held) {
      settledPermissions.set(admitted.permissionId, outcome);
      settlementWaiters.get(admitted.permissionId)?.(outcome);
      settlementWaiters.delete(admitted.permissionId);
    }
    return value;
  };
  childProcess.spawn = function retainedSpawn(...args) {
    const child = previousSpawn.apply(this, args);
    const sampler = observeChild(child, `${mode}-sampler`);
    sampler.ready = sampler.nextFrame();
    samplers.push(sampler);
    return child;
  };
  Module.syncBuiltinESMExports?.();
  try {
    await owner.start();
    await client.connect();
    client.on("event", (event) => result.events.push(event));
    const monitor = loadFreshMonitor(evidenceRoot, `native-caller-${mode}`);
    service = new monitor.WindowsIoCounterService(
      evidenceRoot, "e".repeat(64), `finite-native-caller-${mode}`, undefined,
      (stateInvocationId, state, _bytes, nativeFrameBytes) => {
        result.nativeResponses.push({ type: state.type, requestId: state.requestId, nativeFrameBytes });
        const previousPhase = admissionPhase;
        admissionPhase = "native-response";
        try {
          // M1087-REGROUND: the recorder stands where the monitor's bounded
          // per-invocation unavailable record stands in the execute closure.
          monitor.deliverNativeCounterState({
            nativeResponsePermissions: permissions, telemetryOwner: owner,
            invocationId: stateInvocationId, state, nativeFrameBytes,
            recordUnavailable: (unavailableInvocationId, requestId) => result.unavailableRecords.push({ invocationId: unavailableInvocationId, requestId, phase: admissionPhase }),
          });
        } finally { admissionPhase = previousPhase; }
      },
    );
    result.start = trackPromise(() => service.start());
    if (samplers.length !== 1) throw new Error(`NATIVE_CALLER_SPAWN_COUNT ${samplers.length}`);
    result.ready = await samplers[0].ready;
    requireFrame(result.ready, "service_ready");
    target = makeTarget(evidenceRoot);
    if (mode === "fallback-refusal") {
      target.child.stdin.end();
      result.targetTerminal = await target.witness.close;
    }
    const transportId = mode === "fallback-refusal" ? "a".repeat(32) : mode === "fallback-loss" ? "5".repeat(32) : "b".repeat(32);
    const bindingGeneration = mode === "fallback-refusal" ? "c".repeat(32) : mode === "fallback-loss" ? "6".repeat(32) : "d".repeat(32);
    // Installed before submission so the real sampler's register response
    // cannot arrive before its witness.
    const registerResponse = mode === "fallback-loss" ? samplers[0].nextFrame() : undefined;
    admissionPhase = "caller-register-admission";
    monitor.admitNativeCounterRequest({
      nativeResponsePermissions: permissions, telemetryOwner: owner, invocationId,
      key: `register:${invocationId}`,
      submit: () => service.register({
        invocationId, transportId, bindingGeneration, pid: target.child.pid, expectedExecutable: process.execPath,
        earliestCreationUnixMs: target.earliestCreationUnixMs, latestCreationUnixMs: target.latestCreationUnixMs,
      }),
    });
    if (mode === "fallback-loss") {
      // The live target is registered natively; the register response is
      // settled by its own admitted permission before capacity is exhausted.
      const registerPermission = permissions.get(`register:${invocationId}`);
      if (!registerPermission) throw new Error("NATIVE_CALLER_REGISTER_PERMISSION_UNMAPPED");
      result.registerResponse = await registerResponse;
      requireFrame(result.registerResponse, "registered");
      result.registerPermissionSettlement = await Promise.race([
        settledPermissions.has(registerPermission.permissionId)
          ? Promise.resolve(settledPermissions.get(registerPermission.permissionId))
          : new Promise((resolve) => settlementWaiters.set(registerPermission.permissionId, resolve)),
        samplers[0].close.then(() => "native-close-before-register-settlement"),
      ]);
      if (result.registerPermissionSettlement !== "completed") {
        throw new Error(`NATIVE_CALLER_REGISTER_NOT_SETTLED ${String(result.registerPermissionSettlement)}`);
      }
    }
    if (mode === "fallback-refusal" || mode === "fallback-loss") {
      admissionPhase = "blockers";
      while (true) {
        const blocker = owner.reserveHostWork(invocationId, "terminal", 16 * 1024);
        if (!blocker) break;
        blockers.push(blocker);
      }
      if (!blockers.length) throw new Error("NATIVE_CALLER_NO_BLOCKERS");
    } else {
      for (const [requestId, requestGeneration] of [["1".repeat(32), 1], ["2".repeat(32), 2]]) {
        admissionPhase = `caller-sample-${requestGeneration}-admission`;
        monitor.admitNativeCounterRequest({
          nativeResponsePermissions: permissions, telemetryOwner: owner, invocationId,
          key: `sample:${requestId}`,
          submit: () => service.sample({ invocationId, transportId, bindingGeneration, requestId, requestGeneration }),
        });
      }
    }
    if (mode === "fallback-loss") {
      // Capacity is genuinely exhausted. End only the retained sampler input
      // (natural EOF) while the service is not closing: the service's own
      // native close handler then emits its sampler-loss counter_error for
      // the still-active registration, an arrival with no admitted permission.
      result.failedOperationsBeforeLoss = owner.accounting().failedOperations;
      result.permissionKeysBeforeLoss = [...permissions.keys()];
      admissionPhase = "sampler-eof";
      samplers[0].child.stdin.end();
      result.lossNativeClose = await samplers[0].close;
      result.lossAtNativeClose = { permissionKeys: [...permissions.keys()], owner: owner.accounting() };
    }
    admissionPhase = "settlement";
    result.protocolClose = trackPromise(() => service.close());
    armRejectedCloseFallback(result.protocolClose, samplers, result.recovery);
    result.nativeClose = await samplers[0].close;
    result.nativeExit = await samplers[0].exit;
    result.permissionKeysAtNativeClose = [...permissions.keys()];
    result.ownerAtNativeClose = owner.accounting();
    result.frames = [...samplers[0].frames];
  } catch (error) { bodyError = error; }
  finally {
    try { if (service) await closeServiceNaturally(service, samplers, result.recovery); }
    catch (error) { result.recovery.fixtureError = { message: error.message, stack: error.stack }; }
    for (const permission of permissions.values()) if (owner.hostPermissions.has(permission.permissionId)) owner.abandonHostWork(permission);
    permissions.clear();
    for (const blocker of blockers) if (owner.hostPermissions.has(blocker.permissionId)) owner.abandonHostWork(blocker);
    if (target && !target.child.stdin.writableEnded && !target.child.stdin.destroyed) target.child.stdin.end();
    if (target) { result.targetTerminal = await target.witness.close; result.target = target.witness.snapshot(); }
    result.clientClose = await client.close().then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", message: error.message }));
    result.ownerClose = await owner.close().then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", message: error.message }));
    result.finalOwner = owner.accounting();
    result.sampler = samplers[0]?.snapshot();
    owner.reserveHostWork = originalReserveHostWork;
    owner.settleHostPermission = originalSettleHostPermission;
    childProcess.spawn = previousSpawn;
    Module.syncBuiltinESMExports?.();
    fs.writeFileSync(path.join(evidenceRoot, "native-caller.json"), JSON.stringify(result, null, 2));
  }
  if (bodyError) { bodyError.nativeObservation = result; throw bodyError; }
  return result;
}

async function runAdverseExitBeforeStdioCloseLifecycle(evidenceRoot, fixtureFault) {
  if (process.platform !== "win32") return { platform: process.platform, impossible: true };
  assert.ok(path.isAbsolute(evidenceRoot) && evidenceRoot.length > 0);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const direct = path.join(evidenceRoot, "adverse-direct.cjs");
  const descendant = path.join(evidenceRoot, "adverse-descendant.cjs");
  const controlPipe = `\\\\.\\pipe\\orc-counter-adverse-${process.pid}-${path.basename(evidenceRoot)}`;
  // The host owns the release endpoint before either child starts. Failure
  // cleanup can therefore release an already connected descendant, or close
  // admission so a not-yet-connected descendant naturally gets a socket error.
  const controlEvents = [];
  let controlSocket, releaseRequested = false, resolveControlClose;
  const controlClosed = new Promise((resolve) => { resolveControlClose = resolve; });
  const controlServer = net.createServer((socket) => {
    controlSocket = socket;
    controlEvents.push({ type: "control-accepted" });
    socket.on("error", (error) => controlEvents.push({ type: "control-error", message: error.message }));
    socket.on("data", (bytes) => controlEvents.push({ type: "control-data", text: bytes.toString() }));
    socket.once("end", () => controlEvents.push({ type: "control-eof" }));
    socket.once("close", () => { controlEvents.push({ type: "control-close" }); resolveControlClose(); });
    if (releaseRequested) socket.write("release");
  });
  const serverClosed = new Promise((resolve) => controlServer.once("close", () => {
    controlEvents.push({ type: "control-server-close" }); resolve();
  }));
  function releaseDescendant() {
    if (releaseRequested) return;
    releaseRequested = true;
    controlEvents.push({ type: "release-requested" });
    if (controlSocket && !controlSocket.writableEnded) controlSocket.write("release", (error) => {
      controlEvents.push({ type: "release-write-callback", error: error?.message });
    });
    controlServer.close();
  }
  const previousSpawn = childProcess.spawn;
  let sampler;
  const result = { platform: process.platform, mode: "adverse-exit-before-stdio-close", recovery: { safetyFallbackRequired: false }, publicPromises: {} };
  let service;
  let bodyError;
  const tracked = {};
  // Preparation owns the control server too: either source write may fail
  // before the sampler exists, but neither may bypass the same finally.
  try {
    await new Promise((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(controlPipe, resolve);
    });
    fs.writeFileSync(descendant, [
    "const net = require('node:net');",
    "const socket = net.createConnection(process.env.ADVERSE_CONTROL_PIPE);",
    "socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });",
    "socket.once('connect', () => process.send?.('ready'));",
    "socket.once('data', () => socket.end('descendant-release-received'));",
    "socket.once('end', () => { if (!socket.writableEnded) socket.end(); });",
    "socket.once('close', () => { if (process.connected) process.disconnect(); });",
    "",
  ].join("\n"));
  fs.writeFileSync(direct, [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, [${JSON.stringify(descendant)}], {`,
    "  env: { ...process.env, ADVERSE_CONTROL_PIPE: process.env.ADVERSE_CONTROL_PIPE },",
    "  stdio: ['ignore', 1, 2, 'ipc'], windowsHide: true, detached: true,",
    "});",
    "child.once('error', (error) => { console.error(error); process.exitCode = 1; });",
    "child.once('message', (message) => {",
    "  if (message !== 'ready') return;",
    "  child.disconnect();",
    "  child.unref();",
    "  process.stdout.write(JSON.stringify({ type: 'service_ready', desiredAccess: 4096, pid: process.pid }) + '\\n');",
    "});",
    "",
  ].join("\n"));
  childProcess.spawn = function adverseSamplerSpawn() {
    const child = previousSpawn(process.execPath, [direct], {
      cwd: evidenceRoot,
      env: { ...process.env, ADVERSE_CONTROL_PIPE: controlPipe },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
    });
    sampler = observeChild(child, "adverse-exit-before-stdio-close-sampler");
    sampler.ready = sampler.nextFrame();
    return child;
  };
  Module.syncBuiltinESMExports?.();
    const monitor = loadFreshMonitor(evidenceRoot, "adverse-exit-before-stdio-close");
    service = new monitor.WindowsIoCounterService(evidenceRoot, "a".repeat(64), "finite-adverse-exit-order");
    tracked.start = trackPromise(() => service.start());
    if (!sampler) throw new Error("ADVERSE_SETUP_NO_SAMPLER");
    tracked.closeAfterExit = undefined;
    sampler.onExit(() => {
      tracked.closeAfterExit = trackPromise(() => service.close());
      tracked.closeAfterExit.observed?.then(() => {
        result.closeResolvedBeforeNativeClose = tracked.closeAfterExit.status === "fulfilled" && !sampler.terminalObserved();
      });
    });
    result.ready = await sampler.ready;
    if (fixtureFault === "readiness") throw new Error("FIXTURE_ADVERSE_READINESS_FAILURE");
    requireFrame(result.ready, "service_ready");
    result.nativeExit = await sampler.exit;
    result.closeAtExitRegistration = tracked.closeAfterExit ? "registered" : "missing";
    if (fixtureFault === "control-release") throw new Error("FIXTURE_ADVERSE_CONTROL_RELEASE_FAILURE");
    releaseDescendant();
    if (controlSocket) await controlClosed;
    await serverClosed;
    result.controlRelease = { kind: "control-close", events: controlEvents };
    result.nativeClose = await sampler.close;
    const exitIndex = sampler.events.findIndex((event) => event.type === "child-exit");
    const stdoutCloseIndex = sampler.events.findIndex((event) => event.type === "stdout-close");
    const stderrCloseIndex = sampler.events.findIndex((event) => event.type === "stderr-close");
    result.order = { exitIndex, stdoutCloseIndex, stderrCloseIndex };
    result.adverseOrderingObserved = exitIndex >= 0 && stdoutCloseIndex > exitIndex && stderrCloseIndex > exitIndex;
    result.publicCloseAtNativeClose = tracked.closeAfterExit?.snapshot();
  } catch (error) { bodyError = error; }
  finally {
    // Always release the descendant's inherited-pipe obligation BEFORE waiting
    // for direct sampler close. Direct exit alone is deliberately insufficient.
    if (!releaseRequested) {
      result.recovery.safetyFallbackRequired = true;
      result.recovery.descendantReleaseFallbackRequired = true;
    }
    if (controlServer.listening) releaseDescendant();
    if (controlSocket) await controlClosed;
    if (controlServer.listening || releaseRequested) await serverClosed;
    result.controlEvents = controlEvents;
    result.descendantProcessExit = "not directly witnessed; control EOF/close and inherited stdio closure are witnessed separately";
    try {
      if (service && sampler) await closeServiceNaturally(service, [sampler], result.recovery);
    } catch (error) { result.recovery.fixtureError = { message: error.message, stack: error.stack }; }
    result.sampler = sampler?.snapshot();
    for (const [name, record] of Object.entries(tracked)) if (record) result.publicPromises[name] = record.snapshot();
    result.childCleared = service?.child === undefined;
    childProcess.spawn = previousSpawn;
    Module.syncBuiltinESMExports?.();
    fs.writeFileSync(path.join(evidenceRoot, "native-lifecycle.json"), JSON.stringify(result, null, 2));
  }
  if (bodyError) { bodyError.nativeObservation = result; throw bodyError; }
  return result;
}

const runNativeProtocolLifecycle = (root) => lifecycle(root, "protocol");
const runRefusedRegistrationLifecycle = (root) => lifecycle(root, "refused-registration");
const runRepeatedStartLifecycle = (root) => lifecycle(root, "repeated-start");
const runFailAndCloseLifecycle = (root) => lifecycle(root, "fail-close");
const runExitBeforeStdioCloseLifecycle = (root) => lifecycle(root, "exit-order");

async function runPreflight() {
  const root = isolatedRoot("orc-item3-astra-native-");
  console.log(`PRESERVED_NATIVE_COUNTER_PREFLIGHT_ROOT ${root}`);
  for (const mode of ["protocol", "refused-registration", "repeated-start", "fail-close", "exit-order"]) {
    const result = await lifecycle(path.join(root, "evidence", mode), mode);
    console.log(`NATIVE_COUNTER_PREFLIGHT ${mode} ${JSON.stringify(result)}`);
    assert.ok(result.samplers?.length > 0);
    for (const sampler of result.samplers) {
      assert.equal(sampler.terminalOutcome?.kind, "close");
      assert.equal(sampler.events.filter((event) => event.type === "child-close").length, 1);
      for (const write of sampler.writes) assert.equal(write.callbacks, 1, "every submitted native callback must be retained exactly once");
    }
    assert.equal(result.recovery.fixtureError, undefined);
    if (mode === "protocol") {
      assert.equal(result.rawRegistered?.frame?.type, "registered");
      assert.equal(result.rawSampled?.frame?.type, "sample");
      assert.equal(result.registered?.type, "counter_registered");
      assert.equal(result.sampled?.type, "counter_sample");
    }
    if (mode === "refused-registration") {
      assert.equal(result.refused?.responseType, "error");
      assert.equal(result.refused?.stateType, "counter_error");
    }
    if (mode === "fail-close") assert.equal(result.failedState?.type, "counter_error");
  }
  const adverse = await runAdverseExitBeforeStdioCloseLifecycle(path.join(root, "evidence", "adverse-exit-order"));
  console.log(`NATIVE_COUNTER_PREFLIGHT adverse-exit-order ${JSON.stringify(adverse)}`);
  assert.equal(adverse.sampler?.terminalOutcome?.kind, "close");
  assert.equal(adverse.adverseOrderingObserved, true,
    `test-owned native child did not produce exit-before-stdio-close: ${JSON.stringify(adverse.order)}`);
  assert.equal(adverse.recovery.fixtureError, undefined);
  const failedClose = await lifecycle(path.join(root, "evidence", "fixture-close-before-eof"), "refused-registration", "close-before-eof");
  console.log(`NATIVE_COUNTER_FIXTURE_FAILURE close-before-eof ${JSON.stringify(failedClose)}`);
  assert.equal(failedClose.publicPromises.protocolClose.status, "rejected", "the injected first public close must really fail");
  assert.match(failedClose.publicPromises.protocolClose.error?.message ?? "", /FIXTURE_CLOSE_BEFORE_EOF/);
  assert.equal(failedClose.publicPromises.recoveryClose.status, "fulfilled", "fault-removed public recovery must settle");
  assert.equal(failedClose.recovery.safetyFallbackRequired, false, "harness EOF is not product recovery");
  assert.equal(failedClose.sampler.terminalOutcome.kind, "close");
  for (const fault of ["readiness", "control-release"]) {
    let failure;
    try { await runAdverseExitBeforeStdioCloseLifecycle(path.join(root, "evidence", `fixture-adverse-${fault}`), fault); }
    catch (error) { failure = error; }
    const observation = failure?.nativeObservation;
    console.log(`NATIVE_COUNTER_FIXTURE_FAILURE adverse-${fault} ${JSON.stringify({ message: failure?.message, observation })}`);
    assert.match(failure?.message ?? "", /FIXTURE_ADVERSE_/);
    assert.equal(observation.recovery.status, "failed-recovery");
    assert.equal(observation.recovery.descendantReleaseFallbackRequired, true);
    assert.equal(observation.sampler.terminalOutcome.kind, "close");
    for (const type of ["control-eof", "control-close", "control-server-close", "release-write-callback"]) {
      assert.ok(observation.controlEvents.some((event) => event.type === type), type);
    }
    assert.ok(observation.controlEvents.some((event) => event.type === "control-data" && event.text.includes("descendant-release-received")));
    for (const type of ["stdout-end", "stderr-end", "stdout-close", "stderr-close", "child-close"]) {
      assert.ok(observation.sampler.events.some((event) => event.type === type), type);
    }
  }
  console.log("PASS finite native protocol prerequisite INCLUDING fixture failure paths; harness recovery remains FAILED and descendant process exit is not directly witnessed");
}

module.exports = { runCloseBeforeEofFixtureFailure: (root) => lifecycle(root, "refused-registration", "close-before-eof"),
  runNativeProtocolLifecycle, runRefusedRegistrationLifecycle, runRepeatedStartLifecycle,
  runFailAndCloseLifecycle, runExitBeforeStdioCloseLifecycle, runAdverseExitBeforeStdioCloseLifecycle,
  runNativeFallbackCallerLifecycle: (root) => runNativeOwnerCallerLifecycle(root, "fallback-refusal"),
  runNativeCoalescedCallerLifecycle: (root) => runNativeOwnerCallerLifecycle(root, "coalesced-sample"),
  runNativeFallbackLossCallerLifecycle: (root) => runNativeOwnerCallerLifecycle(root, "fallback-loss"),
  isolatedRoot };
if (require.main === module) runPreflight().catch((error) => { console.error(error.stack); process.exitCode = 1; });
