#!/usr/bin/env node
"use strict";

/**
 * Finite production-consumer regression for cancellation-artifact outcomes.
 *
 * Only owner/cycle admission may defer a terminal. Once a read was admitted,
 * unavailable artifact evidence must settle the authenticated cancellation
 * through the canonical partial-log fallback and leave no pending terminal.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-artifact-outcome-"));
if (!path.isAbsolute(TEMP_ROOT) || !path.resolve(TEMP_ROOT).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
  throw new Error("ARTIFACT_OUTCOME_TEST_ROOT_NOT_CONTAINED");
}
for (const [key, name] of Object.entries({
  PI_CODING_AGENT_DIR: "agent",
  PI_ORCHESTRATOR_RUNS_ROOT: "runs",
  PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next",
})) {
  process.env[key] = path.join(TEMP_ROOT, name);
  fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_OFFLINE = "1";

const caseRoot = path.join(TEMP_ROOT, "case");
fs.mkdirSync(caseRoot, { recursive: true });
const target = path.join(caseRoot, "artifact.json");
const invocationId = "a".repeat(24);
const commandId = "artifact-outcome-settlement";
const artifact = {
  schemaVersion: 1,
  outcome: "cancelled_no_output",
  commandId,
  invocationId,
  summary: "cancelled after deterministic silence",
  noOutputMs: 600000,
  totalElapsedMs: 720000,
  alarmMonotonicMs: 600000,
  alarmAcknowledgedMonotonicMs: 601000,
  cancelledMonotonicMs: 720000,
  cancellationRequested: true,
  cancellationAccepted: true,
  cancellationConfirmed: true,
  confirmationBasis: "terminal_signal_after_owned_handle_action",
  terminalExitCode: null,
  terminalSignal: "SIGTERM",
  cancellationTarget: "retained-direct-test-child-handle",
  eligibility: "authenticated_run_owned_test_child",
  observedSources: ["stdout", "stderr", "declared-file"],
  observationErrors: [],
  partialLog: "HANGING_TEST_MARKER artifact body evidence",
};
const artifactBytes = Buffer.from(JSON.stringify(artifact));
fs.writeFileSync(target, artifactBytes);
const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
const terminal = {
  schemaVersion: 1,
  commandId,
  invocationId,
  sequence: 7,
  wallTime: new Date(0).toISOString(),
  type: "invocation_terminal",
  auth: "already-authenticated-by-production-consumer",
  outcome: "cancelled_no_output",
  cancellationConfirmed: true,
  confirmationBasis: "terminal_signal_after_owned_handle_action",
  exitCode: null,
  signal: "SIGTERM",
  summary: artifact.summary,
  partialLogHead: "HANGING_TEST_MARKER authenticated terminal fallback head",
  partialLogTail: "authenticated terminal fallback tail",
  artifactPath: target,
  artifactSha256,
  artifactBytes: artifactBytes.length,
};

const native = {
  lstatSync: fs.lstatSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
};
let mode = "healthy";
const descriptors = new Set();
let actualReadBytes = 0;
let openAttempts = 0;
let passed = false;

fs.lstatSync = function instrumentedLstat(file, ...args) {
  if (path.resolve(String(file)) === path.resolve(target) && mode === "stat-error") {
    const error = new Error("finite artifact lstat failure");
    error.code = "EACCES";
    throw error;
  }
  return native.lstatSync.call(this, file, ...args);
};
fs.openSync = function instrumentedOpen(file, ...args) {
  const trackedRead = path.resolve(String(file)) === path.resolve(target) && args[0] === "r";
  if (trackedRead) {
    openAttempts += 1;
    if (mode === "open-error") {
      const error = new Error("finite artifact open failure");
      error.code = "EACCES";
      throw error;
    }
    if (mode === "growth") fs.writeFileSync(target, Buffer.alloc(300 * 1024, 103));
    if (mode === "replacement") {
      const replacement = `${target}.replacement`;
      fs.writeFileSync(replacement, Buffer.alloc(artifactBytes.length, 114));
      fs.renameSync(replacement, target);
    }
    if (mode === "same-size-corruption") fs.writeFileSync(target, Buffer.alloc(artifactBytes.length, 120));
  }
  const descriptor = native.openSync.call(this, file, ...args);
  if (trackedRead) descriptors.add(descriptor);
  return descriptor;
};
fs.readSync = function instrumentedRead(descriptor, ...args) {
  if (descriptors.has(descriptor) && mode === "read-error") {
    const error = new Error("finite artifact read failure");
    error.code = "EIO";
    throw error;
  }
  if (descriptors.has(descriptor) && mode === "short-read") args[2] = Math.max(0, Number(args[2]) - 1);
  const read = native.readSync.call(this, descriptor, ...args);
  if (descriptors.has(descriptor)) actualReadBytes += read;
  return read;
};
fs.closeSync = function instrumentedClose(descriptor, ...args) {
  if (descriptors.has(descriptor) && mode === "close-error") {
    const error = new Error("finite artifact close failure");
    error.code = "EIO";
    throw error;
  }
  const result = native.closeSync.call(this, descriptor, ...args);
  descriptors.delete(descriptor);
  return result;
};

function restoreFilesystem() {
  fs.lstatSync = native.lstatSync;
  fs.openSync = native.openSync;
  fs.readSync = native.readSync;
  fs.closeSync = native.closeSync;
}

(async () => {
  try {
    const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
    process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter);
    Module._initPaths();
    const jiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"))(__filename, {
      interopDefault: true,
      moduleCache: false,
      fsCache: false,
    });
    const {
      ArtifactTerminalSettlementQueue,
      EventReader,
      SharedReadBudget,
      loadArtifact,
      selectCancellationPartialLog,
    } = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
    const { CommandTelemetryOwner } = require(path.join(ROOT, "src", "command-telemetry-owner.cjs"));
    const owner = new CommandTelemetryOwner({
      commandRoot: path.join(caseRoot, "command"),
      evidenceDirectory: path.join(caseRoot, "evidence"),
      commandId,
    });

    function createHarness(limitBytes = 256 * 1024) {
      const budget = new SharedReadBudget(limitBytes, owner);
      return { budget, reader: new EventReader(caseRoot, budget), queue: new ArtifactTerminalSettlementQueue(), committed: [] };
    }
    function load(reader, overrides = {}) {
      return loadArtifact(
        overrides.file ?? target,
        caseRoot,
        commandId,
        invocationId,
        overrides.sha256 ?? artifactSha256,
        overrides.bytes ?? artifactBytes.length,
        reader,
      );
    }
    function settle(harness, loadOverrides = {}) {
      return harness.queue.settle(terminal, () => load(harness.reader, loadOverrides), (loadedArtifact) => {
        harness.committed.push({
          artifactIntegrity: loadedArtifact ? "verified" : "unavailable_or_changed",
          partialLog: selectCancellationPartialLog(terminal, loadedArtifact),
        });
      });
    }
    function begin(harness) {
      owner.advanceCycle();
      harness.budget.beginCycle();
    }
    function finish(harness) { harness.budget.finalizeCycle(); }

    // True owner/cycle admission exhaustion remains pending, then succeeds on
    // the next naturally available cycle without changing the terminal.
    const deferred = createHarness(artifactBytes.length);
    begin(deferred);
    assert.equal(deferred.budget.reserveExactBeforeRead(artifactBytes.length, "finite-admission-exhaustion"), true);
    assert.equal(settle(deferred), false);
    assert.equal(deferred.queue.size, 1);
    assert.equal(deferred.committed.length, 0);
    finish(deferred);
    begin(deferred);
    assert.equal(settle(deferred), true);
    finish(deferred);
    assert.equal(deferred.queue.size, 0);
    assert.equal(deferred.committed[0].artifactIntegrity, "verified");
    assert.match(deferred.committed[0].partialLog, /artifact body evidence/);

    // Metadata failure, and every filesystem failure after admission, are
    // unavailable evidence—not requests to repeat the same final-drain cycle.
    // The consumer commits the authenticated fallback and removes its pending
    // map entry. Growth/replacement are injected after loadArtifact's initial
    // stat, on the exact handle-opening production seam.
    for (const failureMode of [
      "stat-error", "open-error", "read-error", "short-read",
      "growth", "replacement", "same-size-corruption",
    ]) {
      fs.writeFileSync(target, artifactBytes);
      const harness = createHarness();
      mode = failureMode;
      begin(harness);
      const settled = settle(harness);
      finish(harness);
      mode = "healthy";
      assert.equal(settled, true, `${failureMode} must settle unavailable rather than defer`);
      assert.equal(harness.queue.size, 0, `${failureMode} must leave no pending terminal`);
      assert.equal(harness.committed.length, 1, `${failureMode} must commit exactly one canonical fallback`);
      assert.equal(harness.committed[0].artifactIntegrity, "unavailable_or_changed");
      assert.match(harness.committed[0].partialLog, /authenticated terminal fallback head/);
    }
    fs.writeFileSync(target, artifactBytes);

    // Integrity and format failures are also final unavailable outcomes.
    mode = "healthy";
    for (const overrides of [
      { sha256: "0".repeat(64) },
      { file: path.join(caseRoot, "missing-artifact.json") },
    ]) {
      const harness = createHarness();
      begin(harness);
      assert.equal(settle(harness, overrides), true);
      finish(harness);
      assert.equal(harness.queue.size, 0);
      assert.equal(harness.committed[0].artifactIntegrity, "unavailable_or_changed");
    }
    const invalidJson = path.join(caseRoot, "invalid-artifact.json");
    const invalidBytes = Buffer.from("{not-json");
    fs.writeFileSync(invalidJson, invalidBytes);
    const invalidHarness = createHarness();
    begin(invalidHarness);
    assert.equal(settle(invalidHarness, {
      file: invalidJson,
      bytes: invalidBytes.length,
      sha256: crypto.createHash("sha256").update(invalidBytes).digest("hex"),
    }), true);
    finish(invalidHarness);
    assert.equal(invalidHarness.queue.size, 0);
    assert.equal(invalidHarness.committed[0].artifactIntegrity, "unavailable_or_changed");

    // Evidence may settle unavailable while an inconclusively closed native
    // descriptor and its permission remain owned. Recovery is independent.
    const closeFailure = createHarness();
    mode = "close-error";
    begin(closeFailure);
    assert.equal(settle(closeFailure), true,
      "an admitted close failure must settle evidence unavailable without hiding native ownership");
    finish(closeFailure);
    assert.equal(closeFailure.queue.size, 0);
    assert.equal(closeFailure.committed[0].artifactIntegrity, "unavailable_or_changed");
    assert.equal(descriptors.size, 1);
    assert.equal(owner.accounting().retainedReaderDescriptors, 1);
    assert.ok(owner.accounting().currentOutstandingBytes >= artifactBytes.length);

    mode = "healthy";
    const recovered = createHarness();
    begin(recovered);
    assert.equal(settle(recovered), true);
    finish(recovered);
    assert.equal(descriptors.size, 0, "the next admitted read must reconcile and conclusively close the retained descriptor");
    assert.equal(owner.accounting().retainedReaderDescriptors, 0);
    assert.equal(owner.accounting().currentOutstandingBytes, 0);
    assert.equal(recovered.committed[0].artifactIntegrity, "verified");
    assert.equal(recovered.queue.size, 0);

    await owner.close();
    passed = true;
    console.log(`PASS item3 artifact outcome settlement ${JSON.stringify({
      artifactBytes: artifactBytes.length,
      actualReadBytes,
      openAttempts,
      retainedReaderDescriptors: owner.accounting().retainedReaderDescriptors,
      outstandingBytes: owner.accounting().currentOutstandingBytes,
      deferredThenVerified: deferred.committed[0].artifactIntegrity,
      recoveredIntegrity: recovered.committed[0].artifactIntegrity,
    })}`);
  } finally {
    mode = "healthy";
    restoreFilesystem();
    for (const descriptor of descriptors) {
      try { native.closeSync(descriptor); } catch {}
    }
    if (passed) fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    else console.log(`PRESERVED_FAILURE_ROOT ${TEMP_ROOT}`);
  }
})().catch((error) => {
  console.error(error);
  throw error;
});
