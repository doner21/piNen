#!/usr/bin/env node
"use strict";

/**
 * Finite production-seam regression for artifact-reader descriptor ownership.
 *
 * A native close failure is injected only for descriptors opened for one file
 * in this disposable root. The first unresolved descriptor must stay charged
 * to the command owner, suppress further descriptor allocation, and recover
 * after the native close path becomes conclusive again.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-artifact-reader-close-"));
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

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const { EventReader, SharedReadBudget, captureSettledFilesWithSharedCredits } = jiti(
  path.join(ROOT, "src", "worker-no-output-monitor.ts"),
);
const { CommandTelemetryOwner } = require(path.join(ROOT, "src", "command-telemetry-owner.cjs"));

const caseRoot = path.join(TEMP_ROOT, "case");
const owner = new CommandTelemetryOwner({
  commandRoot: path.join(caseRoot, "command"),
  evidenceDirectory: path.join(caseRoot, "evidence"),
  commandId: "artifact-reader-close",
});
const budget = new SharedReadBudget(256 * 1024, owner);
const reader = new EventReader(caseRoot, budget);
const target = path.join(caseRoot, "artifact.bin");
let trackedTarget = target;
fs.mkdirSync(caseRoot, { recursive: true });
fs.writeFileSync(target, Buffer.alloc(16, 1));

const original = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync };
const ownedDescriptors = new Set();
let admissions = 0;
let actualReadBytes = 0;
let closeFailures = 0;
let successfulReturns = 0;
let rejectTrackedClose = true;
let passed = false;

function restoreFilesystem() {
  fs.openSync = original.openSync;
  fs.closeSync = original.closeSync;
  fs.readSync = original.readSync;
}
function descriptorIsOpen(descriptor) {
  try { fs.fstatSync(descriptor); return true; }
  catch (error) { return error?.code !== "EBADF"; }
}

fs.openSync = function trackedOpen(file, ...args) {
  const descriptor = original.openSync.call(this, file, ...args);
  if (path.resolve(String(file)) === path.resolve(trackedTarget)) {
    ownedDescriptors.add(descriptor);
    admissions += 1;
  }
  return descriptor;
};
fs.readSync = function trackedRead(descriptor, ...args) {
  const read = original.readSync.call(this, descriptor, ...args);
  if (ownedDescriptors.has(descriptor)) actualReadBytes += read;
  return read;
};
fs.closeSync = function failedTrackedClose(descriptor, ...args) {
  if (ownedDescriptors.has(descriptor) && rejectTrackedClose) {
    closeFailures += 1;
    const error = new Error("finite scratch-only artifact close failure");
    error.code = "EIO";
    throw error;
  }
  const value = original.closeSync.call(this, descriptor, ...args);
  ownedDescriptors.delete(descriptor);
  return value;
};

try {
  for (let attempt = 0; attempt < 130; attempt += 1) {
    owner.advanceCycle();
    budget.beginCycle();
    const value = reader.readFileWithinCycle(target, 16, "artifact-close-failure", caseRoot);
    if (value !== undefined) successfulReturns += 1;
    budget.finalizeCycle();
  }

  const openBeforeRecovery = [...ownedDescriptors].filter(descriptorIsOpen).length;
  const beforeRecovery = owner.accounting();
  const boundedBeforeRecovery = admissions === 1
    && openBeforeRecovery === 1
    && closeFailures >= 1
    && successfulReturns === 0
    && beforeRecovery.retainedReaderDescriptors === 1
    && beforeRecovery.currentOutstandingBytes >= 16
    && beforeRecovery.completedOperations === 0;
  console.log(`MEASURE item3 artifact-reader-close ${JSON.stringify({
    attempts: 130,
    admissions,
    actualReadBytes,
    closeFailures,
    successfulReturns,
    openBeforeRecovery,
    retainedReaderDescriptors: beforeRecovery.retainedReaderDescriptors,
    currentOutstandingBytes: beforeRecovery.currentOutstandingBytes,
    completedOperations: beforeRecovery.completedOperations,
    boundedBeforeRecovery,
  })}`);
  assert.equal(boundedBeforeRecovery, true,
    "an unresolved artifact descriptor must remain owned and prevent repeated descriptor allocation");

  rejectTrackedClose = false;
  owner.advanceCycle();
  budget.beginCycle();
  const recovered = reader.readFileWithinCycle(target, 16, "artifact-close-recovery", caseRoot);
  budget.finalizeCycle();
  const afterRecovery = owner.accounting();
  console.log(`MEASURE item3 artifact-reader-recovery ${JSON.stringify({
    recoveredBytes: recovered ? [...recovered] : null,
    admissions,
    actualReadBytes,
    closeFailures,
    openDescriptors: [...ownedDescriptors].filter(descriptorIsOpen).length,
    retainedReaderDescriptors: afterRecovery.retainedReaderDescriptors,
    currentOutstandingBytes: afterRecovery.currentOutstandingBytes,
    completedOperations: afterRecovery.completedOperations,
    lastReaderDescriptorFailure: afterRecovery.lastReaderDescriptorFailure,
  })}`);
  assert.deepEqual(recovered, Buffer.alloc(16, 1),
    "healthy artifact reading must resume after conclusive descriptor recovery");
  assert.equal([...ownedDescriptors].filter(descriptorIsOpen).length, 0);
  assert.equal(afterRecovery.retainedReaderDescriptors, 0);
  assert.equal(afterRecovery.currentOutstandingBytes, 0);
  assert.ok(afterRecovery.completedOperations >= 2,
    "the recovered retained read and the healthy read must both settle through the owner");

  // The host post-settlement capture path shares the same owner permission and
  // descriptor lifecycle. This sibling coverage was added after the causal
  // artifact RED; it proves the correction is not local to one helper.
  const captureFile = path.join(caseRoot, "capture.log");
  fs.writeFileSync(captureFile, "CAPTURE_DESCRIPTOR_RECOVERY");
  trackedTarget = captureFile;
  rejectTrackedClose = true;
  const captureAdmissionsBefore = admissions;
  let admittedFailure;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    owner.advanceCycle();
    budget.beginCycle();
    const parent = fs.lstatSync(caseRoot, { bigint: true });
    const outcome = captureSettledFilesWithSharedCredits([{
      path: captureFile,
      parentRealPath: fs.realpathSync(caseRoot),
      parentDevice: parent.dev.toString(),
      parentInode: parent.ino.toString(),
    }], fs.realpathSync(caseRoot), reader, 64 * 1024);
    if (attempt === 0) admittedFailure = outcome;
    else assert.equal(outcome, undefined,
      "subsequent attempts must defer admission while the first descriptor is retained");
    budget.finalizeCycle();
  }
  const captureFailureAccounting = owner.accounting();
  assert.ok(admittedFailure, "admitted capture close failure must not masquerade as deferred admission");
  assert.equal(admittedFailure.results[0].status, "unavailable",
    "capture with an unresolved descriptor must report unavailable, not healthy evidence");
  assert.equal(admissions - captureAdmissionsBefore, 1,
    "an unresolved capture descriptor must block repeated capture opens");
  assert.equal(captureFailureAccounting.retainedReaderDescriptors, 1);
  assert.ok(captureFailureAccounting.currentOutstandingBytes >= Buffer.byteLength("CAPTURE_DESCRIPTOR_RECOVERY"));

  rejectTrackedClose = false;
  owner.advanceCycle();
  budget.beginCycle();
  const parent = fs.lstatSync(caseRoot, { bigint: true });
  const recoveredCapture = captureSettledFilesWithSharedCredits([{
    path: captureFile,
    parentRealPath: fs.realpathSync(caseRoot),
    parentDevice: parent.dev.toString(),
    parentInode: parent.ino.toString(),
  }], fs.realpathSync(caseRoot), reader, 64 * 1024);
  budget.finalizeCycle();
  assert.equal(recoveredCapture.results[0].status, "captured");
  assert.equal(recoveredCapture.results[0].head, "CAPTURE_DESCRIPTOR_RECOVERY");
  assert.equal(owner.accounting().retainedReaderDescriptors, 0);
  assert.equal(owner.accounting().currentOutstandingBytes, 0);

  passed = true;
  console.log(`PASS item3 artifact-reader descriptor ownership ${JSON.stringify({
    recoveryAdmissions: admissions,
    retainedReaderDescriptors: afterRecovery.retainedReaderDescriptors,
    currentOutstandingBytes: afterRecovery.currentOutstandingBytes,
    completedOperations: afterRecovery.completedOperations,
  })}`);
} finally {
  restoreFilesystem();
  for (const descriptor of ownedDescriptors) {
    try { original.closeSync(descriptor); } catch {}
  }
  if (passed) fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  else console.log(`PRESERVED_FAILURE_ROOT ${TEMP_ROOT}`);
}
