#!/usr/bin/env node
"use strict";

/**
 * Finite production-seam regression for inaccessible telemetry files.
 *
 * Filesystem calls are faulted only for files in this disposable root. No ACLs
 * are changed. The owner must treat inaccessible metadata as unknown, retain
 * its existing charge and identity, and resume only after conclusive cleanup.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-inconclusive-filesystem-"));
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

const { CommandTelemetryOwner } = require("../src/command-telemetry-owner.cjs");
const original = {
  writeFileSync: fs.writeFileSync,
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  existsSync: fs.existsSync,
  rmSync: fs.rmSync,
  renameSync: fs.renameSync,
};

function denied(message = "finite scratch-only inaccessible metadata") {
  const error = new Error(message);
  error.code = "EACCES";
  return error;
}
function restoreFilesystem() {
  fs.writeFileSync = original.writeFileSync;
  fs.statSync = original.statSync;
  fs.lstatSync = original.lstatSync;
  fs.existsSync = original.existsSync;
  fs.rmSync = original.rmSync;
  fs.renameSync = original.renameSync;
}
function sameFile(left, right) {
  return path.resolve(String(left)) === path.resolve(String(right));
}
function actualStorage(directory) {
  const files = fs.readdirSync(directory);
  return {
    files,
    bytes: files.reduce((sum, name) => sum + original.statSync(path.join(directory, name)).size, 0),
  };
}

function exerciseInaccessibleFailedStage({ label, partialBytes }) {
  const caseRoot = path.join(TEMP_ROOT, label);
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const invocationId = label === "partial-stage" ? "a".repeat(24) : "b".repeat(24);
  const owner = new CommandTelemetryOwner({ commandRoot: caseRoot, evidenceDirectory, commandId: label });
  let inaccessibleStage = "";
  let stagingWrites = 0;
  let removalAttempts = 0;
  try {
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: `${label}_PRIOR_VALID`,
    }), true);
    const priorFile = owner.generations.get(invocationId).file;

    const isStage = (file) => typeof file === "string"
      && file.startsWith(evidenceDirectory) && file.endsWith(".tmp");
    fs.writeFileSync = function inaccessibleStageWrite(file, data, ...args) {
      if (!isStage(file)) return original.writeFileSync.call(this, file, data, ...args);
      inaccessibleStage = String(file);
      original.writeFileSync.call(this, file, Buffer.from(data).subarray(0, partialBytes), ...args);
      stagingWrites += 1;
      throw denied("finite scratch-only staging write failure");
    };
    fs.statSync = function inaccessibleStageStat(file, ...args) {
      if (sameFile(file, inaccessibleStage) || isStage(file)) throw denied();
      return original.statSync.call(this, file, ...args);
    };
    fs.lstatSync = function inaccessibleStageLstat(file, ...args) {
      if (sameFile(file, inaccessibleStage) || isStage(file)) throw denied();
      return original.lstatSync.call(this, file, ...args);
    };
    fs.existsSync = function misleadingExistence(file) {
      if (sameFile(file, inaccessibleStage) || isStage(file)) return false;
      return original.existsSync.call(this, file);
    };
    fs.rmSync = function inaccessibleStageRemoval(file, ...args) {
      if (sameFile(file, inaccessibleStage) || isStage(file)) {
        removalAttempts += 1;
        throw denied("finite scratch-only staging removal failure");
      }
      return original.rmSync.call(this, file, ...args);
    };

    const outcomes = [];
    for (let attempt = 0; attempt < 130; attempt += 1) {
      owner.advanceCycle();
      try {
        owner.commitHostEvidence(invocationId, {
          type: "invocation_terminal", outcome: "succeeded", marker: `${label}_SUCCESSOR_${attempt}`,
          payload: "x".repeat(8192),
        });
        outcomes.push("accepted");
      } catch (error) {
        const message = String(error?.message || error);
        assert.match(message, /finite scratch-only staging write failure|COMMAND_TELEMETRY_FAILED_STAGE_STILL_OWNED/,
          "only the initial injected write failure or a legitimate already-owned refusal is expected");
        outcomes.push(message.includes("STILL_OWNED") ? "owned" : "write-failure");
      }
    }

    restoreFilesystem();
    const retained = actualStorage(evidenceDirectory);
    const accounting = owner.accounting();
    const priorIntact = fs.readFileSync(priorFile, "utf8").includes(`${label}_PRIOR_VALID`);
    const bounded = stagingWrites === 1
      && retained.files.length === 2
      && retained.files.filter((name) => name.endsWith(".tmp")).length === 1
      && accounting.retainedFailedStages === 1
      && accounting.currentOutstandingBytes > 0
      && accounting.failedRetainedBytes >= accounting.currentOutstandingBytes
      && accounting.retainedBytes >= partialBytes
      && priorIntact
      && outcomes[0] === "write-failure"
      && outcomes.slice(1).every((outcome) => outcome === "owned");
    console.log(`MEASURE item3 ${label} ${JSON.stringify({
      attempts: outcomes.length, stagingWrites, removalAttempts, actualFiles: retained.files.length,
      actualBytes: retained.bytes, retainedFailedStages: accounting.retainedFailedStages,
      currentOutstandingBytes: accounting.currentOutstandingBytes,
      conservativeFailedBytes: accounting.failedRetainedBytes, retainedBytes: accounting.retainedBytes,
      priorIntact, bounded,
    })}`);
    assert.equal(bounded, true,
      "an inaccessible failed stage must remain owned and prevent repeated staging allocation");

    owner.reconcileFailedStages(invocationId);
    assert.equal(fs.existsSync(inaccessibleStage), false,
      "restored access must permit conclusive failed-stage cleanup");
    assert.equal(owner.accounting().retainedFailedStages, 0);
    assert.equal(owner.accounting().currentOutstandingBytes, 0);
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: `${label}_RECOVERED`,
    }), true);
    const recovered = owner.acquireCommitted(invocationId);
    assert.match(recovered.bytes.toString("utf8"), new RegExp(`${label}_RECOVERED`));
    owner.releaseReader(recovered.leaseId);
  } finally {
    restoreFilesystem();
  }
}

function exerciseRenamedStageAndNoopRemoval() {
  const renamedRoot = path.join(TEMP_ROOT, "renamed-stage");
  const evidenceDirectory = path.join(renamedRoot, "evidence");
  const invocationId = "f".repeat(24);
  const owner = new CommandTelemetryOwner({ commandRoot: renamedRoot, evidenceDirectory, commandId: "renamed-stage" });
  let renamedDestination = "";
  let renameFaults = 0;
  let renamedStageCleaned = false;
  try {
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "RENAMED_STAGE_PRIOR",
    }), true);
    const priorFile = owner.generations.get(invocationId).file;
    fs.renameSync = function renameThenFail(from, to, ...args) {
      if (String(from).startsWith(evidenceDirectory) && String(from).endsWith(".tmp")) {
        original.renameSync.call(this, from, to, ...args);
        renamedDestination = String(to);
        renameFaults += 1;
        throw denied("finite scratch-only post-rename failure");
      }
      return original.renameSync.call(this, from, to, ...args);
    };
    fs.rmSync = function inaccessibleRenamedStageRemoval(file, ...args) {
      if (renamedDestination && sameFile(file, renamedDestination)) {
        throw denied("finite scratch-only renamed-stage removal failure");
      }
      return original.rmSync.call(this, file, ...args);
    };
    assert.throws(() => owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "RENAMED_STAGE_SUCCESSOR",
    }), /finite scratch-only post-rename failure/);
    const retained = owner.accounting();
    assert.equal(original.existsSync(renamedDestination), true,
      "the injected rename completed before reporting its failure");
    assert.equal(original.existsSync(priorFile), true,
      "a failed successor must not erase prior committed evidence");
    assert.equal(retained.retainedFailedStages, 1,
      "an ambiguously completed rename must retain the successor identity");
    assert.ok(retained.currentOutstandingBytes > 0,
      "an ambiguously completed rename must retain its owner permission");
    const filesBeforeRefusal = actualStorage(evidenceDirectory).files.length;
    assert.throws(() => owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "MUST_WAIT_FOR_RENAMED_STAGE",
    }), /COMMAND_TELEMETRY_FAILED_STAGE_STILL_OWNED/);
    assert.equal(actualStorage(evidenceDirectory).files.length, filesBeforeRefusal,
      "an unresolved renamed stage must prevent another staging allocation");

    restoreFilesystem();
    owner.reconcileFailedStages(invocationId);
    renamedStageCleaned = !original.existsSync(renamedDestination);
    assert.equal(renamedStageCleaned, true);
    assert.equal(owner.accounting().retainedFailedStages, 0);
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "RENAMED_STAGE_RECOVERED",
    }), true);

    const noopRoot = path.join(TEMP_ROOT, "noop-removal");
    const noopOwner = new CommandTelemetryOwner({
      commandRoot: noopRoot, evidenceDirectory: path.join(noopRoot, "evidence"), commandId: "noop-removal",
    });
    const noopInvocation = "9".repeat(24);
    assert.equal(noopOwner.commitHostEvidence(noopInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "NOOP_REMOVAL_RETAIN",
    }), true);
    const noopFile = noopOwner.generations.get(noopInvocation).file;
    fs.rmSync = function noOpRemoval(file, ...args) {
      if (sameFile(file, noopFile)) return undefined;
      return original.rmSync.call(this, file, ...args);
    };
    assert.equal(noopOwner.retireCommitted(noopInvocation), false,
      "a removal call returning without removing the file is not settlement");
    assert.equal(noopOwner.generations.has(noopInvocation), true);
    assert.equal(original.existsSync(noopFile), true);
    restoreFilesystem();
    assert.equal(noopOwner.retireCommitted(noopInvocation), true);

    console.log(`MEASURE item3 renamed-stage-noop-removal ${JSON.stringify({
      renameFaults,
      renamedStageCleaned,
      noopRemovalRecovered: !original.existsSync(noopFile),
    })}`);
  } finally {
    restoreFilesystem();
  }
}

function exerciseInconclusiveRetirement() {
  const predecessorRoot = path.join(TEMP_ROOT, "inaccessible-predecessor");
  const predecessorOwner = new CommandTelemetryOwner({
    commandRoot: predecessorRoot,
    evidenceDirectory: path.join(predecessorRoot, "evidence"),
    commandId: "inaccessible-predecessor",
  });
  const predecessorInvocation = "c".repeat(24);
  const currentRoot = path.join(TEMP_ROOT, "inaccessible-current");
  const currentOwner = new CommandTelemetryOwner({
    commandRoot: currentRoot,
    evidenceDirectory: path.join(currentRoot, "evidence"),
    commandId: "inaccessible-current",
  });
  const currentInvocation = "d".repeat(24);
  let predecessorLease;
  let inaccessibleFile = "";
  let deletionAttempts = 0;
  try {
    assert.equal(predecessorOwner.commitHostEvidence(predecessorInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "PREDECESSOR_VALID",
    }), true);
    predecessorLease = predecessorOwner.acquireCommitted(predecessorInvocation);
    const predecessorFile = predecessorLease.file;
    assert.equal(predecessorOwner.commitHostEvidence(predecessorInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "CURRENT_VALID",
    }), true);

    const makeInaccessible = (file) => {
      inaccessibleFile = file;
      fs.rmSync = function inaccessibleRemoval(candidate, ...args) {
        if (sameFile(candidate, inaccessibleFile)) {
          deletionAttempts += 1;
          throw denied("finite scratch-only generation removal failure");
        }
        return original.rmSync.call(this, candidate, ...args);
      };
      fs.lstatSync = function inaccessibleLstat(candidate, ...args) {
        if (sameFile(candidate, inaccessibleFile)) throw denied();
        return original.lstatSync.call(this, candidate, ...args);
      };
      fs.existsSync = function misleadingExistence(candidate) {
        if (sameFile(candidate, inaccessibleFile)) return false;
        return original.existsSync.call(this, candidate);
      };
    };

    makeInaccessible(predecessorFile);
    predecessorOwner.releaseReader(predecessorLease.leaseId);
    predecessorLease = undefined;
    const predecessorRetained = Boolean(predecessorOwner.generations.get(predecessorInvocation)?.previous)
      && original.existsSync(predecessorFile);
    const predecessorFileCount = actualStorage(path.join(predecessorRoot, "evidence")).files.length;
    assert.throws(() => predecessorOwner.commitHostEvidence(predecessorInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "MUST_WAIT_FOR_PREDECESSOR",
    }), /COMMAND_TELEMETRY_PREDECESSOR_STILL_IN_USE|COMMAND_TELEMETRY_PREDECESSOR_RETIREMENT_BLOCKED/);
    assert.equal(actualStorage(path.join(predecessorRoot, "evidence")).files.length, predecessorFileCount,
      "an inaccessible predecessor must block another generation allocation");
    assert.equal(predecessorRetained, true,
      "failed deletion plus inaccessible metadata must retain predecessor ownership");

    restoreFilesystem();
    assert.equal(predecessorOwner.commitHostEvidence(predecessorInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "PREDECESSOR_RECOVERED",
    }), true);
    assert.equal(fs.existsSync(predecessorFile), false);

    assert.equal(currentOwner.commitHostEvidence(currentInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "CURRENT_RETAIN_UNTIL_GONE",
    }), true);
    const currentFile = currentOwner.generations.get(currentInvocation).file;
    makeInaccessible(currentFile);
    const retiredWhileUnknown = currentOwner.retireCommitted(currentInvocation);
    const currentRetained = currentOwner.generations.has(currentInvocation) && original.existsSync(currentFile);
    assert.equal(retiredWhileUnknown, false);
    assert.equal(currentRetained, true,
      "failed deletion plus inaccessible metadata must retain current-generation ownership");

    restoreFilesystem();
    assert.equal(currentOwner.retireCommitted(currentInvocation), true);
    assert.equal(fs.existsSync(currentFile), false);

    const absentRoot = path.join(TEMP_ROOT, "confirmed-absence");
    const absentOwner = new CommandTelemetryOwner({
      commandRoot: absentRoot,
      evidenceDirectory: path.join(absentRoot, "evidence"),
      commandId: "confirmed-absence",
    });
    const absentInvocation = "e".repeat(24);
    assert.equal(absentOwner.commitHostEvidence(absentInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "EXTERNALLY_REMOVED",
    }), true);
    const absentFile = absentOwner.generations.get(absentInvocation).file;
    original.rmSync(absentFile, { force: true });
    assert.equal(absentOwner.retireCommitted(absentInvocation), true,
      "a conclusive ENOENT absence must retire ownership rather than strand it");
    assert.equal(absentOwner.accounting().retainedGenerations, 0);

    console.log(`MEASURE item3 inconclusive-retirement ${JSON.stringify({
      deletionAttempts, predecessorRetained, predecessorRecovered: !fs.existsSync(predecessorFile),
      retiredWhileUnknown, currentRetained, currentRecovered: !fs.existsSync(currentFile),
      confirmedAbsenceRetired: absentOwner.accounting().retainedGenerations === 0,
    })}`);
  } finally {
    restoreFilesystem();
    if (predecessorLease) predecessorOwner.releaseReader(predecessorLease.leaseId);
  }
}

let passed = false;
try {
  exerciseInaccessibleFailedStage({ label: "partial-stage", partialBytes: 4096 });
  exerciseInaccessibleFailedStage({ label: "zero-stage", partialBytes: 0 });
  exerciseRenamedStageAndNoopRemoval();
  exerciseInconclusiveRetirement();
  passed = true;
  console.log("PASS item3 inconclusive filesystem ownership and recovery");
} finally {
  restoreFilesystem();
  if (passed) fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  else console.log(`PRESERVED_FAILURE_ROOT ${TEMP_ROOT}`);
}
