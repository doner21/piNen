"use strict";

// Pass-through capture of actual instances created by the registered monitor.
// No substitute owner/service, no new product exports, no independent monitor.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const Module = require("node:module");
const { observeChild, closeServiceNaturally } = require("./item3-native-counter-witness.cjs");
const ROOT = path.resolve(__dirname, "../..");
const { CommandTelemetryOwner } = require(path.join(ROOT, "src/command-telemetry-owner.cjs"));
const { StreamingSecretRedactor } = require(path.join(ROOT, "src/streaming-redactor.cjs"));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function runActualInstanceEvidence(root, mode) {
  assert.ok(path.isAbsolute(root) && root.length > 0);
  fs.mkdirSync(root, { recursive: true });
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const acks = path.join(root, "acks");
  for (const dir of [workspace, evidence, acks]) fs.mkdirSync(dir, { recursive: true });
  const authority = { schemaVersion: 1, authority: "run-admission-owner-task", workspaceRealPath: fs.realpathSync(workspace),
    existingEntrypoints: [], approvedDynamicScopes: [], allowedNodeOptions: [] };
  const bytes = Buffer.from(JSON.stringify({ ...authority, policyHash: digest(Buffer.from(JSON.stringify(authority))) }));
  const authorityFile = path.join(root, "authorization.json");
  fs.writeFileSync(authorityFile, bytes);
  const settings = { PI_OFFLINE: "1", PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE: authorityFile,
    PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256: digest(bytes), PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT: evidence,
    PI_ORCHESTRATOR_ALARM_ACK_ROOT: acks, PI_ORCHESTRATOR_WORKER_ID: "astra-review15-instance",
    PI_ORCHESTRATOR_NO_OUTPUT_POLICY: JSON.stringify({ minimumObservationMs: 100, alarmAfterMs: 200, cancelAfterMs: 400, minimumAlarmLeadMs: 100, pollMs: 10 }) };
  const oldEnv = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const piModules = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules");
  process.env.NODE_PATH = [piModules, path.join(ROOT, "node_modules")].join(path.delimiter);
  Module._initPaths();
  const createJiti = require(path.join(piModules, "jiti/lib/jiti.cjs"));
  const original = { start: CommandTelemetryOwner.prototype.start, drain: CommandTelemetryOwner.prototype.drainEvents,
    finish: StreamingSecretRedactor.prototype.finish,
    spawn: cp.spawn, write: fs.writeFileSync, chmod: fs.chmodSync, exists: fs.existsSync };
  const result = { mode, calls: [], nativeEvents: [], faultHits: 0, harnessRecovery: {}, publicMonitor: {} };
  let owner, service, server, serverClosed = false, sampler, monitor, tool, resultHandler;
  let originalServiceStart, originalPoll, originalServiceClose;
  let faultEnabled = true;
  function fault(operation) {
    result.faultHits += 1;
    result.calls.push({ operation, stack: new Error("fault caller").stack });
    faultEnabled = false; // remove at the failing transition, never after a wait
    throw new Error(`ASTRA_ACTUAL_${mode}`);
  }
  CommandTelemetryOwner.prototype.start = function capturedOwnerStart(...args) {
    owner = this;
    result.ownerIdentity = { samePrototype: Object.getPrototypeOf(this) === CommandTelemetryOwner.prototype,
      sameConstructor: this.constructor === CommandTelemetryOwner, commandRoot: this.commandRoot };
    const returned = original.start.apply(this, args);
    server = this.server;
    if (server) {
      server.once("listening", () => result.nativeEvents.push({ type: "server-listening" }));
      server.once("close", () => { serverClosed = true; result.nativeEvents.push({ type: "server-close" }); });
      server.on("connection", socket => {
        result.nativeEvents.push({ type: "socket-accepted" });
        socket.once("end", () => result.nativeEvents.push({ type: "socket-eof" }));
        socket.once("close", () => result.nativeEvents.push({ type: "socket-close" }));
        socket.on("error", error => result.nativeEvents.push({ type: "socket-error", message: error.message }));
      });
    }
    result.calls.push({ operation: "owner.start", exactOriginalReturn: true });
    if (mode === "measurement-directory") original.write(path.join(this.evidenceDirectory, "counter-owned.bin"), Buffer.alloc(257, 7));
    return returned;
  };
  CommandTelemetryOwner.prototype.drainEvents = function capturedDrain(...args) {
    result.calls.push({ operation: "owner.drain", sameOwner: this === owner });
    if (faultEnabled && mode === "owner-drain" && new Error().stack.includes("processMonitorDrainTurn")) fault("owner.drain");
    return original.drain.apply(this, args);
  };
  fs.writeFileSync = function shimWrite(file, ...args) {
    if (owner && faultEnabled && mode === "shim-write" && String(file).startsWith(path.join(owner.commandRoot, "shim") + path.sep)) fault("writeShim.writeFileSync");
    return original.write.call(this, file, ...args);
  };
  fs.chmodSync = function shimChmod(file, ...args) {
    if (owner && faultEnabled && mode === "shim-chmod" && String(file).startsWith(path.join(owner.commandRoot, "shim") + path.sep)) fault("writeShim.chmodSync");
    return original.chmod.call(this, file, ...args);
  };
  fs.existsSync = function measureExists(file) {
    if (owner && mode === "measurement-directory" && path.resolve(String(file)) === path.resolve(owner.evidenceDirectory)
      && new Error().stack.includes("measureTelemetry")) {
      result.faultHits += 1;
      return false; // scoped inaccessible-metadata shape of existsSync, not ENOENT proof
    }
    return original.exists.call(this, file);
  };
  cp.spawn = function capturedSpawn(...args) {
    const child = original.spawn.apply(this, args);
    if (service && /powershell\.exe$/i.test(String(args[0]))) {
      sampler = observeChild(child, "actual-monitor-sampler");
      result.calls.push({ operation: "native-sampler-spawn", sameService: service.constructor === monitor.WindowsIoCounterService });
    }
    return child;
  };
  if (mode === "redactor-finish") StreamingSecretRedactor.prototype.finish = function observedFinish(...args) {
    if (faultEnabled) fault("redactor.finish");
    return original.finish.apply(this, args);
  };
  Module.syncBuiltinESMExports?.();
  try {
    monitor = createJiti(path.join(root, "loader.cjs"), { interopDefault: true, moduleCache: false, fsCache: false })(path.join(ROOT, "src/worker-no-output-monitor.ts"));
    originalServiceStart = monitor.WindowsIoCounterService.prototype.start;
    originalPoll = monitor.EventReader.prototype.poll;
    originalServiceClose = monitor.WindowsIoCounterService.prototype.close;
    monitor.WindowsIoCounterService.prototype.close = function capturedServiceClose(...args) {
      if (mode === "sampler-close" && faultEnabled) {
        const originalFlush = this.flushQueue;
        this.flushQueue = function oneCloseFailure() {
          this.flushQueue = originalFlush;
          fault("sampler.close.flushQueue");
        };
      }
      return originalServiceClose.apply(this, args);
    };
    monitor.WindowsIoCounterService.prototype.start = function capturedServiceStart(...args) {
      service = this;
      result.serviceIdentity = { samePrototype: Object.getPrototypeOf(this) === monitor.WindowsIoCounterService.prototype,
        sameConstructor: this.constructor === monitor.WindowsIoCounterService };
      result.calls.push({ operation: "sampler.start", exactOriginalReturn: true });
      return originalServiceStart.apply(this, args);
    };
    monitor.EventReader.prototype.poll = function capturedPoll(...args) {
      const stack = new Error().stack;
      result.calls.push({ operation: "reader.poll", finalDrainCaller: stack.includes("processMonitorDrainTurn") });
      if (faultEnabled && mode === "reader-poll" && stack.includes("processMonitorDrainTurn")) fault("reader.poll");
      return originalPoll.apply(this, args);
    };
    monitor.default({ registerTool(definition) { if (definition.name === "bash") tool = definition; },
      on(name, handler) { if (name === "tool_result") resultHandler = handler; }, events: { emit() {} } });
    try {
      const raw = await tool.execute(`actual-${mode}`, { command: "printf 'ASTRA_ACTUAL_COMMAND_COMPLETE\\n'" }, undefined, undefined,
        { cwd: workspace, sessionManager: { getSessionId: () => "scratch-instance-test", getSessionFile: () => undefined } });
      result.publicMonitor.execute = "fulfilled";
      // Capture resources before the tool-result hook can remove the command root.
      result.publicMonitor.serverClosed = serverClosed;
      result.publicMonitor.samplerClosed = sampler?.terminalObserved();
      result.publicMonitor.accounting = owner?.accounting();
      const patch = resultHandler?.({ toolName: "bash", toolCallId: `actual-${mode}`, content: raw.content });
      result.publicMonitor.details = patch?.details ?? raw.details;
      // HR3-EXTEND-SETTLEMENT-DIAGNOSTIC: the command's own real text, so a settlement-failure mode
      // can be told apart from a healthy no-fault fulfilment by its content, not only by execute.
      result.publicMonitor.text = (patch?.content ?? raw.content ?? []).map((item) => item?.text || "").join("");
    } catch (error) {
      result.publicMonitor.execute = "rejected";
      result.publicMonitor.error = { message: error.message, stack: error.stack };
      result.publicMonitor.serverClosed = serverClosed;
      result.publicMonitor.samplerClosed = sampler?.terminalObserved();
      result.publicMonitor.accounting = owner?.accounting();
    }
  } finally {
    faultEnabled = false;
    CommandTelemetryOwner.prototype.start = original.start;
    CommandTelemetryOwner.prototype.drainEvents = original.drain;
    fs.writeFileSync = original.write; fs.chmodSync = original.chmod; fs.existsSync = original.exists; cp.spawn = original.spawn;
    StreamingSecretRedactor.prototype.finish = original.finish;
    if (monitor && originalServiceStart) monitor.WindowsIoCounterService.prototype.start = originalServiceStart;
    if (monitor && originalPoll) monitor.EventReader.prototype.poll = originalPoll;
    if (monitor && originalServiceClose) monitor.WindowsIoCounterService.prototype.close = originalServiceClose;
    Module.syncBuiltinESMExports?.();
    // This is harness recovery using the captured REAL instances. It is NOT
    // autonomous monitor recovery, even when the public component close works.
    result.harnessRecovery.required = Boolean((server && !serverClosed) || (sampler && !sampler.terminalObserved()));
    try { if (service && sampler) await closeServiceNaturally(service, [sampler], result.harnessRecovery); }
    catch (error) { result.harnessRecovery.serviceError = { message: error.message, stack: error.stack }; }
    try { if (owner) await owner.close(); }
    catch (error) { result.harnessRecovery.ownerError = { message: error.message, stack: error.stack }; }
    result.harnessRecovery.serverClosed = serverClosed;
    result.harnessRecovery.sampler = sampler?.snapshot();
    result.harnessRecovery.monitorRecovery = result.harnessRecovery.required ? "failed-recovery" : "no-harness-recovery-required";
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    original.write(path.join(evidence, "actual-instance.json"), JSON.stringify(result, null, 2));
  }
  assert.equal(result.ownerIdentity?.samePrototype, true, "same-module owner instance capture required");
  assert.equal(result.ownerIdentity?.sameConstructor, true);
  if (!["shim-write", "shim-chmod"].includes(mode)) {
    assert.equal(result.serviceIdentity?.samePrototype, true);
    assert.equal(result.serviceIdentity?.sameConstructor, true);
    assert.equal(result.harnessRecovery.sampler?.terminalOutcome?.kind, "close");
  }
  assert.equal(result.harnessRecovery.serverClosed, true, "native server-close required, not just owner.close fulfillment");
  if (mode !== "healthy") assert.ok(result.faultHits > 0, "fault must hit the actual caller");
  return result;
}
module.exports = { runActualInstanceEvidence };
if (require.main === module) (async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TEMP, "astra-actual-instance-")));
  console.log(`PRESERVED_ACTUAL_INSTANCE_ROOT ${root}`);
  const modes = ["healthy", "shim-write", "shim-chmod", "measurement-directory", "reader-poll", "owner-drain", "sampler-close", "redactor-finish"];
  const selected = process.argv[2];
  if (selected) assert.ok(modes.includes(selected), "unknown actual-instance case");
  for (const mode of selected ? [selected] : modes) {
    const result = await runActualInstanceEvidence(path.join(root, mode), mode);
    console.log(`ACTUAL_INSTANCE ${mode} ${JSON.stringify(result)}`);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
