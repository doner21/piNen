#!/usr/bin/env node
/** Combined causal regression for command-scoped telemetry ownership. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Module = require("node:module");
const net = require("node:net");
const { CommandTelemetryOwner, CommandTelemetryClient } = require("../src/command-telemetry-owner.cjs");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-single-owner-"));
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

const originalRenameSync = fs.renameSync;
const originalWriteFileSync = fs.writeFileSync;
const originalRmSync = fs.rmSync;
let rejectedCommitTarget = "";
let rejectCommit = false;
let priorSeenDuringFailedCommit = "";
let partialFailureInvocation = "";
let rejectPartialWrite = false;
let rejectPartialCleanup = false;
let actualPartialWriteBytes = 0;
let failedTemporary = "";
let zeroFailureInvocation = "";
let rejectZeroWrite = false;
let rejectZeroCleanup = false;
let zeroFailedTemporary = "";
let rejectedPredecessorCleanup = "";
let rejectPredecessorCleanup = false;
fs.renameSync = function instrumentedRename(from, to) {
  if (rejectCommit && path.resolve(String(to)) === rejectedCommitTarget) {
    priorSeenDuringFailedCommit = fs.existsSync(to) ? fs.readFileSync(to, "utf8") : "";
    const error = new Error("finite injected successor commit failure");
    error.code = "EACCES";
    throw error;
  }
  return originalRenameSync.call(this, from, to);
};
fs.writeFileSync = function instrumentedWrite(file, data, ...args) {
  const target = String(file);
  if (rejectZeroWrite && target.includes(`${zeroFailureInvocation}.terminal.`) && target.endsWith(".tmp")) {
    originalWriteFileSync.call(this, file, Buffer.alloc(0), ...args);
    zeroFailedTemporary = target;
    const error = new Error("finite injected zero-byte staging write failure");
    error.code = "ENOSPC";
    throw error;
  }
  if (rejectPartialWrite && target.includes(`${partialFailureInvocation}.terminal.`) && target.endsWith(".tmp")) {
    const partial = Buffer.from(data).subarray(0, 48 * 1024);
    originalWriteFileSync.call(this, file, partial, ...args);
    actualPartialWriteBytes += partial.length;
    failedTemporary = target;
    const error = new Error("finite injected partial staging write failure");
    error.code = "ENOSPC";
    throw error;
  }
  return originalWriteFileSync.call(this, file, data, ...args);
};
fs.rmSync = function instrumentedRemove(file, ...args) {
  if (rejectZeroCleanup && zeroFailedTemporary
    && path.resolve(String(file)) === path.resolve(zeroFailedTemporary)) {
    const error = new Error("finite injected zero-byte staging cleanup failure");
    error.code = "EBUSY";
    throw error;
  }
  if (rejectPredecessorCleanup && rejectedPredecessorCleanup
    && path.resolve(String(file)) === path.resolve(rejectedPredecessorCleanup)) {
    const error = new Error("finite injected predecessor cleanup failure");
    error.code = "EBUSY";
    throw error;
  }
  if (rejectPartialCleanup && failedTemporary && path.resolve(String(file)) === path.resolve(failedTemporary)) {
    const error = new Error("finite injected staging cleanup failure");
    error.code = "EBUSY";
    throw error;
  }
  return originalRmSync.call(this, file, ...args);
};

async function combinedCausalScenario() {
  const caseRoot = path.join(TEMP_ROOT, "combined");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const commandId = "combined-owner-command";
  const owner = new CommandTelemetryOwner({ commandRoot: caseRoot, evidenceDirectory, commandId });
  await owner.start();

  const invocationA = "a".repeat(24);
  const invocationB = "b".repeat(24);
  const nestedInvocation = "c".repeat(24);
  partialFailureInvocation = nestedInvocation;
  const publisherA = new CommandTelemetryClient(owner.configuration(), invocationA);
  const publisherB = new CommandTelemetryClient(owner.configuration(), invocationB);
  const nestedPublisher = new CommandTelemetryClient(owner.configuration(invocationB), nestedInvocation);
  const mixedQueueClients = [];
  let blockerRelease;
  let originalOwnerRequest;
  let originalOwnerCompletePayload;
  let queueOriginalRequest;
  let queueOriginalWrite;
  try {
    await Promise.all([publisherA.connect(), publisherB.connect(), nestedPublisher.connect()]);
    let transportIngressBytes = 0;
    for (const connection of owner.connections) connection.socket.on("data", (chunk) => { transportIngressBytes += chunk.length; });

    // The nested publisher commits identifiable evidence. Eight actual partial
    // staging writes then fail while a reader holds that prior generation. A
    // failed deletion must remain owned/charged, block another allocation, and
    // be reclaimed only after a later request can conclusively remove it.
    await nestedPublisher.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "PRIOR_VALID" }, "terminal");
    owner.drainEvents();
    const priorLease = owner.acquireCommitted(nestedInvocation);
    assert.ok(priorLease);
    const priorBytes = priorLease.bytes.toString("utf8");
    assert.match(priorBytes, /PRIOR_VALID/);
    let peakFailureFiles = 0;
    let peakFailedCharge = 0;
    for (let round = 0; round < 8; round += 1) {
      failedTemporary = "";
      rejectPartialWrite = true;
      rejectPartialCleanup = true;
      await assert.rejects(
        () => nestedPublisher.publish({
          type: "invocation_terminal", outcome: "succeeded", marker: `FAILED_SUCCESSOR_${round}`,
          payload: "x".repeat(60 * 1024),
        }, "terminal"),
        /finite injected partial staging write failure/,
      );
      rejectPartialWrite = false;
      const duringFailure = owner.accounting();
      const files = fs.readdirSync(evidenceDirectory);
      peakFailureFiles = Math.max(peakFailureFiles, files.length);
      peakFailedCharge = Math.max(peakFailedCharge, Number(duringFailure.failedRetainedBytes) || 0);
      assert.equal(files.filter((name) => name.endsWith(".tmp")).length, 1,
        "one failed operation may retain one charged stage, never an accumulating retry set");
      assert.ok(Number(duringFailure.failedRetainedBytes) >= 48 * 1024,
        "an incompletely written stage must remain charged while deletion is unconfirmed");
      assert.ok(Number(duringFailure.currentOutstandingBytes) >= 48 * 1024,
        "failed staging work must continue consuming command-owner capacity");
      assert.equal(fs.readFileSync(priorLease.file, "utf8"), priorBytes,
        "a concurrent reader must retain the previously committed generation");

      // This is a deterministic cleanup barrier, not a retry timer. The next
      // finite request may proceed only after the owner confirms deletion.
      rejectPartialCleanup = false;
      await nestedPublisher.publish({ type: "cleanup_barrier", round, marker: "CLEANUP_CONFIRMED" });
      owner.drainEvents();
      assert.equal(fs.existsSync(failedTemporary), false);
      assert.equal(Number(owner.accounting().failedRetainedBytes) || 0, 0);
    }
    assert.equal(actualPartialWriteBytes, 8 * 48 * 1024);
    assert.equal(peakFailureFiles, 2, "prior generation plus one failed stage is the bounded storage peak");

    // A staging file exists even when a write fails before its first byte. Run
    // enough finite failures to expose recycled, untracked file allocations on
    // the broken implementation. Each repaired round has an independent
    // ordinary cleanup barrier, so a retained zero-byte stage can be removed
    // conclusively before the next attempt; no fixed implementation waits on
    // a permanently blocked terminal request.
    zeroFailureInvocation = nestedInvocation;
    let zeroPeakFiles = 0;
    let zeroStageOwnedEveryRound = true;
    let zeroStageRecoveredEveryRound = true;
    let zeroPriorPreservedEveryRound = true;
    for (let round = 0; round < 130; round += 1) {
      zeroFailedTemporary = "";
      rejectZeroWrite = true;
      rejectZeroCleanup = true;
      await assert.rejects(
        () => nestedPublisher.publish({
          type: "invocation_terminal", outcome: "succeeded", marker: `ZERO_BYTE_SUCCESSOR_${round}`,
        }, "terminal"),
        /finite injected zero-byte staging write failure/,
      );
      rejectZeroWrite = false;
      const duringFailure = owner.accounting();
      const duringFiles = fs.readdirSync(evidenceDirectory);
      zeroPeakFiles = Math.max(zeroPeakFiles, duringFiles.length);
      zeroStageOwnedEveryRound &&= fs.existsSync(zeroFailedTemporary)
        && duringFailure.retainedFailedStages >= 1
        && duringFailure.currentOutstandingBytes > 0;
      zeroPriorPreservedEveryRound &&= fs.readFileSync(priorLease.file, "utf8") === priorBytes;

      rejectZeroCleanup = false;
      await nestedPublisher.publish({ type: "zero_stage_cleanup_barrier", round, marker: "ZERO_CLEANUP_CONFIRMED" });
      owner.drainEvents();
      const afterCleanup = owner.accounting();
      zeroStageRecoveredEveryRound &&= !fs.existsSync(zeroFailedTemporary)
        && !fs.readdirSync(evidenceDirectory).some((name) => name.endsWith(".tmp"))
        && afterCleanup.retainedFailedStages === 0
        && afterCleanup.currentOutstandingBytes === 0;
    }

    // Exercise ordinary, control, and terminal descriptor deliveries under one
    // deterministic pre-payload barrier. The broken owner grants all four
    // against the same empty queue, so three 30-KiB retained payloads exceed
    // 64 KiB. The repaired owner grants only admitted queue claims; already
    // granted clients publish and drain naturally, allowing deferred clients
    // to progress without a deadline or circular grant-all wait.
    const mixedInvocations = ["1", "2", "3", "4"].map((digit) => digit.repeat(24));
    for (const invocationId of mixedInvocations) {
      const client = new CommandTelemetryClient(owner.configuration(), invocationId);
      mixedQueueClients.push(client);
      await client.connect();
    }
    const mixedChannels = ["ordinary", "ordinary", "control", "terminal"];
    const mixedEvents = mixedChannels.map((channel, index) => ({
      type: channel === "terminal" ? "invocation_terminal" : "mixed_delivery_pressure",
      outcome: channel === "terminal" ? "succeeded" : undefined,
      channel,
      publisher: index,
      payload: "q".repeat(30 * 1024),
    }));
    queueOriginalRequest = owner.request;
    queueOriginalWrite = owner.write;
    let requestFramesSeen = 0;
    let initialGrantedCount = 0;
    let releasePayloadBarrier;
    const payloadBarrier = new Promise((resolve) => { releasePayloadBarrier = resolve; });
    owner.write = function observeInitialGrants(connection, value) {
      if (requestFramesSeen < mixedQueueClients.length && value?.kind === "grant" && value.accepted) initialGrantedCount += 1;
      return queueOriginalWrite.call(this, connection, value);
    };
    owner.request = function releaseAfterAllRequests(connection, frame) {
      const result = queueOriginalRequest.call(this, connection, frame);
      requestFramesSeen += 1;
      if (requestFramesSeen === mixedQueueClients.length) releasePayloadBarrier();
      return result;
    };
    const mixedOperations = mixedQueueClients.map(async (client, index) => {
      const event = mixedEvents[index];
      const grant = await client.requestWork(mixedChannels[index], Buffer.byteLength(JSON.stringify(event)) + 1);
      await payloadBarrier;
      const receipt = await client.commitGranted(grant, event);
      if (initialGrantedCount < mixedQueueClients.length) owner.drainEvents();
      return receipt;
    });
    const mixedReceipts = await Promise.all(mixedOperations);
    owner.request = queueOriginalRequest;
    owner.write = queueOriginalWrite;
    owner.drainEvents();
    const mixedQueueAccounting = owner.accounting();
    owner.finalizeInvocation(mixedInvocations[3]);
    assert.equal(owner.retireCommitted(mixedInvocations[3]), true);
    await Promise.all(mixedQueueClients.map((client) => client.close()));
    mixedQueueClients.length = 0;

    await Promise.all([
      publisherA.publish({ type: "publisher_competition", publisher: "A" }),
      publisherB.publish({ type: "publisher_competition", publisher: "B" }),
      nestedPublisher.publish({ type: "nested_work_request", publisher: "B/nested" }),
    ]);
    owner.drainEvents();

    // B legitimately holds the entire payload allowance. A's required terminal
    // is submitted through the real private pipe. The test releases B by
    // natural EOF only after the owner has observed contention, independently
    // of A's eventual receipt. Reject-on-contention loses A; queue-and-defer
    // preserves it without any deadline, watchdog, or process action.
    const outstanding = await publisherB.requestWork("terminal", 240 * 1024);
    const originalRequest = owner.request;
    originalOwnerRequest = originalRequest;
    let deferredObserved = false;
    let unadmittedPayloadStarted = false;
    const originalCompletePayload = owner.completePayload;
    originalOwnerCompletePayload = originalCompletePayload;
    owner.completePayload = function instrumentedComplete(connection, ...args) {
      if (connection.invocationId === invocationA && !deferredObserved) unadmittedPayloadStarted = true;
      return originalCompletePayload.call(this, connection, ...args);
    };
    owner.request = function instrumentedRequest(connection, frame) {
      const result = originalRequest.call(this, connection, frame);
      const pendingRequests = Number(this.accounting().pendingRequests);
      if (connection.invocationId === invocationA && frame.channel === "terminal") deferredObserved = pendingRequests >= 1;
      if (pendingRequests === 2 && !blockerRelease) {
        blockerRelease = new Promise((resolve, reject) => {
          setImmediate(() => publisherB.close().then(resolve, reject));
        });
      }
      return result;
    };
    const [healthyReceipt, controlReceipt] = await Promise.all([
      publisherA.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "HEALTHY_FINAL" }, "terminal"),
      nestedPublisher.publish({ type: "required_control_progress", marker: "CONTROL_PROGRESS" }, "control"),
    ]);
    await blockerRelease;
    owner.request = originalRequest;
    owner.completePayload = originalCompletePayload;
    owner.drainEvents();
    const afterEof = owner.accounting();
    const healthyLease = owner.acquireCommitted(invocationA);
    const healthyProgress = Boolean(healthyReceipt.accepted) && Boolean(controlReceipt.accepted)
      && /HEALTHY_FINAL/.test(healthyLease.bytes.toString("utf8"));
    const abandonedReclaimed = afterEof.currentOutstandingBytes === 0 && afterEof.abandonedOperations >= 1;
    assert.equal(deferredObserved, true, "ordinary owner contention must create one bounded deferred request");
    assert.equal(unadmittedPayloadStarted, false, "a deferred publisher must not send payload before its grant");
    assert.equal(healthyProgress, true, "the deferred required terminal must eventually commit");

    owner.releaseReader(priorLease.leaseId);
    assert.equal(owner.retireCommitted(nestedInvocation), true);

    // A predecessor deletion failure remains visible/charged in retained
    // storage and blocks replacement until a later conclusive deletion. It
    // must not erase the new committed generation or become permanent after
    // cleanup is possible again.
    rejectedPredecessorCleanup = healthyLease.file;
    rejectPredecessorCleanup = true;
    await publisherA.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "RETAINED_SUCCESSOR" }, "terminal");
    owner.drainEvents();
    owner.releaseReader(healthyLease.leaseId);
    assert.equal(owner.accounting().retainedGenerations, 2);
    const retainedSuccessor = owner.acquireCommitted(invocationA);
    assert.match(retainedSuccessor.bytes.toString("utf8"), /RETAINED_SUCCESSOR/);
    owner.releaseReader(retainedSuccessor.leaseId);
    rejectPredecessorCleanup = false;
    await publisherA.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "PREDECESSOR_CLEANUP_RECOVERED" }, "terminal");
    owner.drainEvents();
    assert.equal(owner.accounting().retainedGenerations, 1);

    await publisherA.publish({
      type: "invocation_terminal", outcome: "cancelled_no_output",
      marker: "CHUNKED_TERMINAL_TAIL", partialLog: `CHUNKED_TERMINAL_HEAD_${"x".repeat(100 * 1024)}_CHUNKED_TERMINAL_TAIL`,
    }, "terminal");
    owner.drainEvents();
    const chunkedLease = owner.acquireCommitted(invocationA);
    assert.match(chunkedLease.bytes.toString("utf8"), /CHUNKED_TERMINAL_HEAD_.*CHUNKED_TERMINAL_TAIL/);
    owner.releaseReader(chunkedLease.leaseId);

    let peakGenerationFiles = 0;
    for (let generation = 0; generation < 300; generation += 1) {
      await publisherA.publish({ type: "invocation_terminal", outcome: "succeeded", marker: `GENERATION_${generation}` }, "terminal");
      owner.drainEvents();
      peakGenerationFiles = Math.max(peakGenerationFiles, fs.readdirSync(evidenceDirectory).length);
    }
    const settledAccounting = owner.accounting();

    const output = path.join(caseRoot, "observed-output.txt");
    const replacement = path.join(caseRoot, "observed-output.next.txt");
    fs.writeFileSync(output, "UNCHANGED_TEST_OUTPUT\n");
    fs.writeFileSync(replacement, "ORDINARY_RENAME_OUTPUT\n");
    fs.renameSync(replacement, output);
    const noninterference = fs.readFileSync(output, "utf8") === "ORDINARY_RENAME_OUTPUT\n";

    const observed = {
      actualPartialWriteBytes,
      transportIngressBytes,
      peakFailedCharge,
      combinedActualBytes: settledAccounting.maxCombinedActualBytes,
      inheritedOwnerBounded: settledAccounting.maxOutstandingBytes <= 256 * 1024 - 16 * 1024,
      deliveryQueueBounded: settledAccounting.maxEventQueueBytes <= 64 * 1024,
      combinedDeliveryAndNativeBounded: settledAccounting.maxCombinedQueueBytes <= 64 * 1024,
      queueClaimsReleased: settledAccounting.reservedEventQueueBytes === 0
        && settledAccounting.reservedNonTerminalEventQueueBytes === 0,
      mixedQueuePreAdmissionDeferred: initialGrantedCount < mixedInvocations.length,
      mixedQueueAccepted: mixedReceipts.every((receipt) => receipt.accepted),
      nativeWritableBounded: mixedQueueAccounting.maxQueuedBytes <= 64 * 1024
        && mixedQueueAccounting.maxNativeWritableBytes <= 64 * 1024,
      stageAllocationsReleased: settledAccounting.activeStages === 0
        && settledAccounting.retainedFailedStages === 0,
      zeroStageOwnedEveryRound,
      zeroStageRecoveredEveryRound,
      zeroPriorPreservedEveryRound,
      zeroStoragePlateaued: zeroPeakFiles <= 2,
      zeroPeakFiles,
      failedWorkReclaimed: settledAccounting.failedRetainedBytes === 0,
      priorSurvivedFailedSuccessor: /PRIOR_VALID/.test(priorBytes),
      deferredObserved,
      abandonedReclaimed,
      healthyProgress,
      retainedStatePlateaued: settledAccounting.retainedGenerations <= 1 && peakGenerationFiles <= 2,
      retainedGenerationStates: settledAccounting.retainedGenerations,
      peakGenerationFiles,
      noninterference,
      outstandingOperation: outstanding.opId,
    };
    console.log(`MEASURE item3 combined-causal ${JSON.stringify(observed)}`);

    assert.deepEqual(
      {
        inheritedOwnerBounded: observed.inheritedOwnerBounded,
        deliveryQueueBounded: observed.deliveryQueueBounded,
        combinedDeliveryAndNativeBounded: observed.combinedDeliveryAndNativeBounded,
        queueClaimsReleased: observed.queueClaimsReleased,
        mixedQueuePreAdmissionDeferred: observed.mixedQueuePreAdmissionDeferred,
        mixedQueueAccepted: observed.mixedQueueAccepted,
        nativeWritableBounded: observed.nativeWritableBounded,
        stageAllocationsReleased: observed.stageAllocationsReleased,
        zeroStageOwnedEveryRound: observed.zeroStageOwnedEveryRound,
        zeroStageRecoveredEveryRound: observed.zeroStageRecoveredEveryRound,
        zeroPriorPreservedEveryRound: observed.zeroPriorPreservedEveryRound,
        zeroStoragePlateaued: observed.zeroStoragePlateaued,
        failedWorkReclaimed: observed.failedWorkReclaimed,
        priorSurvivedFailedSuccessor: observed.priorSurvivedFailedSuccessor,
        deferredObserved: observed.deferredObserved,
        abandonedReclaimed: observed.abandonedReclaimed,
        healthyProgress: observed.healthyProgress,
        retainedStatePlateaued: observed.retainedStatePlateaued,
        noninterference: observed.noninterference,
      },
      {
        inheritedOwnerBounded: true,
        deliveryQueueBounded: true,
        combinedDeliveryAndNativeBounded: true,
        queueClaimsReleased: true,
        mixedQueuePreAdmissionDeferred: true,
        mixedQueueAccepted: true,
        nativeWritableBounded: true,
        stageAllocationsReleased: true,
        zeroStageOwnedEveryRound: true,
        zeroStageRecoveredEveryRound: true,
        zeroPriorPreservedEveryRound: true,
        zeroStoragePlateaued: true,
        failedWorkReclaimed: true,
        priorSurvivedFailedSuccessor: true,
        deferredObserved: true,
        abandonedReclaimed: true,
        healthyProgress: true,
        retainedStatePlateaued: true,
        noninterference: true,
      },
      "one command owner must charge failed work, defer contention, preserve evidence, reclaim EOF work, plateau state, and not interfere",
    );
  } finally {
    rejectPartialWrite = false;
    rejectPartialCleanup = false;
    rejectZeroWrite = false;
    rejectZeroCleanup = false;
    rejectPredecessorCleanup = false;
    if (queueOriginalRequest) owner.request = queueOriginalRequest;
    if (queueOriginalWrite) owner.write = queueOriginalWrite;
    if (originalOwnerRequest) owner.request = originalOwnerRequest;
    if (originalOwnerCompletePayload) owner.completePayload = originalOwnerCompletePayload;
    await Promise.allSettled([
      blockerRelease, publisherA.close(), publisherB.close(), nestedPublisher.close(),
      ...mixedQueueClients.map((client) => client.close()),
    ]);
    await owner.close();
  }
}

function predecessorAdmissionUsesOwnedMetadata() {
  const caseRoot = path.join(TEMP_ROOT, "predecessor-owned-metadata");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const invocationId = "a1".repeat(12);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory,
    commandId: "predecessor-owned-metadata-command",
  });
  const originalStatSync = fs.statSync;
  let priorFile = "";
  try {
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "OWNED_PREDECESSOR",
      payload: "p".repeat(170 * 1024),
    }), true);
    priorFile = owner.generations.get(invocationId).file;
    owner.advanceCycle();
    fs.statSync = function finitePredecessorStatFailure(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(priorFile)) {
        const error = new Error("finite injected predecessor metadata read failure");
        error.code = "EIO";
        throw error;
      }
      return originalStatSync.call(this, file, ...args);
    };
    const accountingDuringStatFailure = owner.accounting();
    const ownershipReportedDuringStatFailure = accountingDuringStatFailure.retainedGenerations === 1
      && accountingDuringStatFailure.retainedBytes >= 170 * 1024;
    let successorAccepted = false;
    try {
      successorAccepted = owner.commitHostEvidence(invocationId, {
        type: "invocation_terminal", outcome: "succeeded", marker: "MUST_NOT_OVERCOMMIT",
        payload: "s".repeat(100 * 1024),
      }) === true;
    } catch {}
    fs.statSync = originalStatSync;
    const filesAfterAttempt = fs.readdirSync(evidenceDirectory).length;
    const retained = owner.acquireCommitted(invocationId);
    const priorStillCurrent = /OWNED_PREDECESSOR/.test(retained.bytes.toString("utf8"));
    owner.releaseReader(retained.leaseId);
    console.log(`MEASURE item3 predecessor-owned-metadata ownershipReportedDuringStatFailure=${ownershipReportedDuringStatFailure} successorAccepted=${successorAccepted} filesAfterAttempt=${filesAfterAttempt} priorStillCurrent=${priorStillCurrent}`);
    assert.deepEqual(
      { ownershipReportedDuringStatFailure, successorAccepted, filesAfterAttempt, priorStillCurrent },
      { ownershipReportedDuringStatFailure: true, successorAccepted: false, filesAfterAttempt: 1, priorStillCurrent: true },
      "predecessor ownership metadata must bound successor admission even when a fresh stat is unavailable",
    );
  } finally {
    fs.statSync = originalStatSync;
  }
}

function hostFailedStageOwnership() {
  const caseRoot = path.join(TEMP_ROOT, "host-failed-stage");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const invocationId = "9".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory,
    commandId: "host-failed-stage-command",
  });
  let prior;
  try {
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "HOST_PRIOR_VALID",
    }), true);
    prior = owner.acquireCommitted(invocationId);
    assert.ok(prior);
    zeroFailureInvocation = invocationId;
    zeroFailedTemporary = "";
    rejectZeroWrite = true;
    rejectZeroCleanup = true;
    assert.throws(() => owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "HOST_ZERO_FAILURE",
    }), /finite injected zero-byte staging write failure/);
    rejectZeroWrite = false;
    const firstTemporary = zeroFailedTemporary;
    const filesWhileOwned = fs.readdirSync(evidenceDirectory).length;
    const charged = owner.accounting();
    assert.equal(charged.retainedFailedStages, 1);
    assert.ok(charged.currentOutstandingBytes > 0);

    assert.throws(() => owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "HOST_RETRY_MUST_WAIT",
    }), /COMMAND_TELEMETRY_FAILED_STAGE_STILL_OWNED/,
    "a host retry must not allocate another staging file while failed cleanup remains owned");
    assert.equal(fs.readdirSync(evidenceDirectory).length, filesWhileOwned);
    assert.equal(zeroFailedTemporary, firstTemporary,
      "blocked host retry must not reach another staging-file allocation");
    assert.match(fs.readFileSync(prior.file, "utf8"), /HOST_PRIOR_VALID/);

    rejectZeroCleanup = false;
    owner.reconcileFailedStages(invocationId);
    assert.equal(fs.existsSync(firstTemporary), false);
    assert.equal(owner.accounting().retainedFailedStages, 0);
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "HOST_RECOVERED_SUCCESSOR",
    }), true);
    const recovered = owner.acquireCommitted(invocationId);
    assert.match(recovered.bytes.toString("utf8"), /HOST_RECOVERED_SUCCESSOR/);
    owner.releaseReader(recovered.leaseId);
    console.log(`MEASURE item3 host-failed-stage filesWhileOwned=${filesWhileOwned} recovered=true`);
  } finally {
    rejectZeroWrite = false;
    rejectZeroCleanup = false;
    if (prior) owner.releaseReader(prior.leaseId);
  }
}

async function terminalDrainIsolation() {
  const outcomes = [];
  for (const mode of ["growth", "same-size-corruption", "open-read-failure"]) {
    const caseRoot = path.join(TEMP_ROOT, `terminal-drain-${mode}`);
    const owner = new CommandTelemetryOwner({
      commandRoot: caseRoot,
      evidenceDirectory: path.join(caseRoot, "evidence"),
      commandId: `terminal-drain-${mode}`,
    });
    const badInvocation = crypto.createHash("sha256").update(`bad:${mode}`).digest("hex").slice(0, 24);
    const healthyInvocation = crypto.createHash("sha256").update(`healthy:${mode}`).digest("hex").slice(0, 24);
    const bad = new CommandTelemetryClient(owner.configuration(), badInvocation);
    const healthy = new CommandTelemetryClient(owner.configuration(), healthyInvocation);
    const originalReadFile = fs.readFileSync;
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    const originalClose = fs.closeSync;
    const trackedDescriptors = new Set();
    const openedTrackedDescriptors = new Set();
    const closedTrackedDescriptors = new Set();
    let actualBytesRead = 0;
    try {
      await owner.start();
      await Promise.all([bad.connect(), healthy.connect()]);
      await bad.publish({ type: "invocation_terminal", outcome: "succeeded", marker: `BAD_${mode}` }, "terminal");
      await healthy.publish({ type: "invocation_terminal", outcome: "succeeded", marker: `HEALTHY_${mode}` }, "terminal");
      assert.equal(owner.events.length, 2);
      const badFile = owner.events.find((record) => record.delivery?.invocationId === badInvocation)?.delivery.file;
      assert.ok(badFile);
      const committedBytes = fs.statSync(badFile).size;
      if (mode === "growth") fs.writeFileSync(badFile, Buffer.alloc(300 * 1024, 120));
      else if (mode === "same-size-corruption") fs.writeFileSync(badFile, Buffer.alloc(committedBytes, 120));

      fs.readFileSync = function observedLegacyRead(file, ...args) {
        if (path.resolve(String(file)) === path.resolve(badFile) && mode === "open-read-failure") {
          const error = new Error("finite injected terminal open/read failure");
          error.code = "EIO";
          throw error;
        }
        const value = originalReadFile.call(this, file, ...args);
        if (path.resolve(String(file)) === path.resolve(badFile)) {
          actualBytesRead += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
        }
        return value;
      };
      fs.openSync = function observedBoundedOpen(file, ...args) {
        if (path.resolve(String(file)) === path.resolve(badFile) && mode === "open-read-failure") {
          const error = new Error("finite injected terminal open/read failure");
          error.code = "EIO";
          throw error;
        }
        const descriptor = originalOpen.call(this, file, ...args);
        if (path.resolve(String(file)) === path.resolve(badFile)) {
          trackedDescriptors.add(descriptor);
          openedTrackedDescriptors.add(descriptor);
        }
        return descriptor;
      };
      fs.closeSync = function observedBoundedClose(descriptor, ...args) {
        if (openedTrackedDescriptors.has(descriptor)) closedTrackedDescriptors.add(descriptor);
        return originalClose.call(this, descriptor, ...args);
      };
      fs.readSync = function observedBoundedRead(descriptor, ...args) {
        const bytes = originalRead.call(this, descriptor, ...args);
        if (trackedDescriptors.has(descriptor)) {
          actualBytesRead += bytes;
          trackedDescriptors.delete(descriptor);
        }
        return bytes;
      };

      let thrown;
      let drained = [];
      try { drained = owner.drainEvents(); } catch (error) { thrown = error; }
      fs.readFileSync = originalReadFile;
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
      fs.closeSync = originalClose;
      const retry = owner.drainEvents();
      const accounting = owner.accounting();
      const allDelivered = [...drained, ...retry];
      const healthyDelivered = allDelivered.some((event) => event.marker === `HEALTHY_${mode}`);
      const corruptDelivered = allDelivered.some((event) => event.marker === `BAD_${mode}`);
      const bounded = mode === "same-size-corruption"
        ? actualBytesRead === committedBytes
        : actualBytesRead === 0;
      const handlesClosed = [...openedTrackedDescriptors].every((descriptor) => closedTrackedDescriptors.has(descriptor));
      outcomes.push({ mode, committedBytes, actualBytesRead, healthyDelivered, corruptDelivered, bounded, handlesClosed,
        threw: thrown?.message ?? "", readerLeases: owner.readerLeases?.size ?? 0,
        outstandingBytes: accounting.currentOutstandingBytes, failedOperations: accounting.failedOperations });
      assert.equal(thrown, undefined, `${mode} must be isolated to its own terminal record`);
      assert.equal(healthyDelivered, true, `${mode} must not discard the subsequent healthy terminal`);
      assert.equal(corruptDelivered, false, `${mode} must not turn unauthenticated bytes into terminal evidence`);
      assert.equal(bounded, true,
        `${mode} must perform only its admitted committed-length read (actual=${actualBytesRead}, committed=${committedBytes})`);
      assert.equal(handlesClosed, true, `${mode} must close every opened generation descriptor in finally`);
      assert.equal(owner.readerLeases?.size ?? 0, 0, `${mode} must conclusively release every reader lease`);
      assert.equal(accounting.currentOutstandingBytes, 0, `${mode} must conclusively settle delivery permissions`);
      assert.ok(accounting.failedOperations >= 1, `${mode} must remain explicit in owner failure accounting`);
    } finally {
      fs.readFileSync = originalReadFile;
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
      fs.closeSync = originalClose;
      await Promise.allSettled([bad.close(), healthy.close()]);
      await owner.close();
    }
  }
  console.log(`MEASURE item3 terminal-drain-isolation ${JSON.stringify(outcomes)}`);
}

function conclusiveGenerationRetirement() {
  const originalRemove = fs.rmSync;
  const predecessorRoot = path.join(TEMP_ROOT, "conclusive-predecessor-retirement");
  const predecessorInvocation = "7".repeat(24);
  const predecessorOwner = new CommandTelemetryOwner({
    commandRoot: predecessorRoot,
    evidenceDirectory: path.join(predecessorRoot, "evidence"),
    commandId: "conclusive-predecessor-retirement-command",
  });
  const currentRoot = path.join(TEMP_ROOT, "conclusive-current-retirement");
  const currentInvocation = "6".repeat(24);
  const currentOwner = new CommandTelemetryOwner({
    commandRoot: currentRoot,
    evidenceDirectory: path.join(currentRoot, "evidence"),
    commandId: "conclusive-current-retirement-command",
  });
  let predecessorLease;
  let predecessorFile = "";
  let currentFile = "";
  try {
    assert.equal(predecessorOwner.commitHostEvidence(predecessorInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "PREDECESSOR_GENERATION",
    }), true);
    predecessorLease = predecessorOwner.acquireCommitted(predecessorInvocation);
    predecessorFile = predecessorLease.file;
    assert.equal(predecessorOwner.commitHostEvidence(predecessorInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "CURRENT_GENERATION",
    }), true);

    fs.rmSync = function finiteNoopPredecessorRemoval(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(predecessorFile)) return undefined;
      return originalRemove.call(this, file, ...args);
    };
    predecessorOwner.releaseReader(predecessorLease.leaseId);
    predecessorLease = undefined;
    const predecessorRecordRetained = Boolean(predecessorOwner.generations.get(predecessorInvocation)?.previous)
      && fs.existsSync(predecessorFile);

    fs.rmSync = originalRemove;
    assert.equal(currentOwner.commitHostEvidence(currentInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "CURRENT_RETIREMENT",
    }), true);
    currentFile = currentOwner.generations.get(currentInvocation).file;
    fs.rmSync = function finiteNoopCurrentRemoval(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(currentFile)) return undefined;
      return originalRemove.call(this, file, ...args);
    };
    const firstCurrentRetirement = currentOwner.retireCommitted(currentInvocation);
    const currentRecordRetained = firstCurrentRetirement === false
      && currentOwner.generations.has(currentInvocation) && fs.existsSync(currentFile);

    fs.rmSync = originalRemove;
    const predecessorRecovery = predecessorOwner.commitHostEvidence(predecessorInvocation, {
      type: "invocation_terminal", outcome: "succeeded", marker: "PREDECESSOR_RECOVERED",
    }) === true && !fs.existsSync(predecessorFile);
    const currentRecovery = currentOwner.retireCommitted(currentInvocation) === true && !fs.existsSync(currentFile);
    console.log(`MEASURE item3 conclusive-retirement predecessorRetained=${predecessorRecordRetained} currentRetained=${currentRecordRetained} predecessorRecovered=${predecessorRecovery} currentRecovered=${currentRecovery}`);
    assert.deepEqual(
      { predecessorRecordRetained, currentRecordRetained, predecessorRecovery, currentRecovery },
      { predecessorRecordRetained: true, currentRecordRetained: true, predecessorRecovery: true, currentRecovery: true },
      "a no-op or inconclusive deletion must retain generation ownership and block its release until confirmed absent",
    );
  } finally {
    fs.rmSync = originalRemove;
    if (predecessorLease) predecessorOwner.releaseReader(predecessorLease.leaseId);
  }
}

function committedAcquireRequiresAdmission() {
  const caseRoot = path.join(TEMP_ROOT, "committed-acquire-admission");
  const invocationId = "d".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "committed-acquire-admission-command",
  });
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  let blocker;
  let targetFile = "";
  let targetDescriptor;
  let actualBytesRead = 0;
  try {
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "ACQUIRE_ADMISSION",
      payload: "a".repeat(60 * 1024),
    }), true);
    targetFile = owner.generations.get(invocationId).file;
    owner.advanceCycle();
    blocker = owner.reserveHostWork("__command__", "terminal", 190 * 1024);
    assert.ok(blocker, "the finite competing owner operation must hold most shared capacity");
    fs.openSync = function observedAcquireOpen(file, ...args) {
      const descriptor = originalOpenSync.call(this, file, ...args);
      if (path.resolve(String(file)) === path.resolve(targetFile)) targetDescriptor = descriptor;
      return descriptor;
    };
    fs.readSync = function observedAcquireRead(descriptor, ...args) {
      const bytes = originalReadSync.call(this, descriptor, ...args);
      if (descriptor === targetDescriptor) actualBytesRead += bytes;
      return bytes;
    };
    assert.throws(() => owner.acquireCommitted(invocationId), /COMMAND_TELEMETRY_COMMITTED_READ_NOT_ADMITTED/,
      "a direct committed read must reserve shared owner capacity before opening or reading");
    assert.equal(actualBytesRead, 0, "a refused committed read must perform zero content I/O");
    const refusedReadBytes = actualBytesRead;
    assert.equal(owner.readerLeases?.size ?? 0, 0, "refused admission must not allocate a reader lease");
    assert.equal(owner.accounting().currentOutstandingBytes, 190 * 1024,
      "the competing operation must retain its charge while the read is refused");

    assert.equal(owner.abandonHostWork(blocker), true);
    blocker = undefined;
    const admitted = owner.acquireCommitted(invocationId);
    assert.match(admitted.bytes.toString("utf8"), /ACQUIRE_ADMISSION/);
    owner.releaseReader(admitted.leaseId);
    assert.equal(owner.retireCommitted(invocationId), true);
    console.log(`MEASURE item3 committed-acquire-admission refusedReadBytes=${refusedReadBytes} admittedAfterRelease=true`);
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    if (blocker) owner.abandonHostWork(blocker);
    for (const leaseId of owner.readerLeases?.keys() ?? []) owner.releaseReader(leaseId);
  }
}

function committedReadFailureReleasesLease() {
  const caseRoot = path.join(TEMP_ROOT, "committed-read-failure");
  const invocationId = "8".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "committed-read-failure-command",
  });
  const originalOpenSync = fs.openSync;
  try {
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", outcome: "succeeded", marker: "READ_FAILURE_LEASE",
    }), true);
    const committedFile = owner.generations.get(invocationId).file;
    fs.openSync = function injectedReadFailure(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(committedFile)) {
        const error = new Error("finite injected committed-read failure");
        error.code = "EIO";
        throw error;
      }
      return originalOpenSync.call(this, file, ...args);
    };
    assert.throws(() => owner.acquireCommitted(invocationId), /finite injected committed-read failure/);
    fs.openSync = originalOpenSync;
    assert.equal(owner.generations.get(invocationId).readers, 0,
      "a failed committed read must release the lease it acquired");
    assert.equal(owner.readerLeases?.size ?? 0, 0);
    assert.equal(owner.retireCommitted(invocationId), true,
      "failed read cleanup must not permanently block committed-generation retirement");
    console.log("MEASURE item3 committed-read-failure leaseReleased=true retirementRecovered=true");
  } finally {
    fs.openSync = originalOpenSync;
  }
}

async function committedDescriptorCloseOwnership() {
  const caseRoot = path.join(TEMP_ROOT, "committed-descriptor-close");
  const invocationId = "3".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "committed-descriptor-close-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  let targetFile = "";
  let targetDescriptor;
  let injected = false;
  let allowCloseRecovery = false;
  try {
    await owner.start();
    await client.connect();
    await client.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "CLOSE_OWNERSHIP" }, "terminal");
    targetFile = owner.events[0]?.delivery?.file || "";
    assert.ok(targetFile);
    fs.openSync = function observedDescriptorOpen(file, ...args) {
      const descriptor = originalOpenSync.call(this, file, ...args);
      if (path.resolve(String(file)) === path.resolve(targetFile)) targetDescriptor = descriptor;
      return descriptor;
    };
    fs.closeSync = function finiteCloseFailure(descriptor, ...args) {
      if (!allowCloseRecovery && descriptor === targetDescriptor) {
        injected = true;
        const error = new Error("finite injected committed descriptor close failure");
        error.code = "EBUSY";
        throw error;
      }
      return originalCloseSync.call(this, descriptor, ...args);
    };
    const drained = owner.drainEvents();
    allowCloseRecovery = true;
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    assert.equal(injected, true);
    const retained = owner.accounting();
    console.log(`MEASURE item3 committed-descriptor-close delivered=${drained.some((event) => event.marker === "CLOSE_OWNERSHIP")} retainedDescriptors=${String(retained.retainedReaderDescriptors)} outstanding=${retained.currentOutstandingBytes}`);
    assert.equal(drained.some((event) => event.marker === "CLOSE_OWNERSHIP"), true,
      "authenticated terminal evidence remains deliverable after a close failure");
    assert.equal(retained.retainedReaderDescriptors, 1,
      "an open descriptor whose close failed must remain owned explicitly");
    assert.ok(retained.currentOutstandingBytes > 0,
      "descriptor ownership must retain the terminal delivery charge");

    const reconciliation = owner.reserveHostWork("__command__", "ordinary", 1);
    assert.ok(reconciliation, "a later admitted operation must first reconcile the retained descriptor");
    owner.abandonHostWork(reconciliation);
    const recovered = owner.accounting();
    assert.equal(recovered.retainedReaderDescriptors, 0);
    assert.equal(recovered.currentOutstandingBytes, 0);
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    if (targetDescriptor !== undefined) { try { originalCloseSync(targetDescriptor); } catch {} }
    await client.close();
    await owner.close();
  }
}

async function directHostDeliveryRequiresPermission() {
  const caseRoot = path.join(TEMP_ROOT, "host-delivery-permission");
  const invocationId = "4".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "host-delivery-permission-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  const originalWrite = owner.write;
  const originalSettleHostWrite = owner.settleHostWrite;
  let hostWrites = 0;
  let permission;
  try {
    await owner.start();
    await client.connect();
    owner.write = function observedHostDelivery(connection, value, ...args) {
      if (value?.kind === "host") hostWrites += 1;
      return originalWrite.call(this, connection, value, ...args);
    };
    const unadmitted = owner.sendToInvocation(invocationId, { type: "unadmitted_host_delivery" }, "counter");
    const writesAfterUnadmitted = hostWrites;

    permission = owner.reserveHostWork(invocationId, "counter", 16 * 1024);
    assert.ok(permission);
    const admittedEvent = { type: "admitted_host_delivery", marker: "HOST_PERMISSION" };
    const deliveredEvent = new Promise((resolve) => client.once("event", resolve));
    let resolveNativeWrite;
    const nativeWriteSettled = new Promise((resolve) => { resolveNativeWrite = resolve; });
    owner.settleHostWrite = function observedNativeWriteSettlement(...args) {
      const result = originalSettleHostWrite.apply(this, args);
      resolveNativeWrite();
      return result;
    };
    const priorActualBytes = 128;
    const deliveryBytes = owner.hostDeliveryBytes(admittedEvent, "counter");
    const admitted = owner.sendToInvocation(invocationId, admittedEvent, "counter", permission, priorActualBytes);
    owner.completeHostWork(permission, priorActualBytes + (admitted ? deliveryBytes : 0));
    if (admitted) await Promise.all([deliveredEvent, nativeWriteSettled]);
    permission = undefined;
    const settled = owner.accounting();
    console.log(`MEASURE item3 host-delivery-permission unadmitted=${unadmitted} writesAfterUnadmitted=${writesAfterUnadmitted} admitted=${admitted}`);
    assert.deepEqual(
      { unadmitted, writesAfterUnadmitted, admitted, outstanding: settled.currentOutstandingBytes },
      { unadmitted: false, writesAfterUnadmitted: 0, admitted: true, outstanding: 0 },
      "direct host delivery must validate its existing owner permission before socket I/O",
    );
  } finally {
    owner.write = originalWrite;
    owner.settleHostWrite = originalSettleHostWrite;
    if (permission) owner.abandonHostWork(permission);
    await client.close();
    await owner.close();
  }
}

function helperReadPermissionCarryover() {
  const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
  process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const { SharedReadBudget } = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
  const caseRoot = path.join(TEMP_ROOT, "helper-read-permission-carryover");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "helper-read-permission-carryover-command",
  });
  const budget = new SharedReadBudget(256 * 1024, owner);
  budget.beginCycle();
  budget.grantHelperRead(4096, "helper-delivery", "finite-helper-grant", "1".repeat(24));
  assert.equal(owner.accounting().currentOutstandingBytes, 8192);
  budget.beginCycle();
  const carried = owner.accounting().currentOutstandingBytes;
  console.log(`MEASURE item3 helper-read-permission-carryover carriedOwnerBytes=${carried} helperBytes=${budget.accounting().outstandingHelperReadBytes}`);
  assert.equal(carried, 8192,
    "an unread helper grant must retain its command-owner permission across a cycle boundary");
  assert.equal(budget.consumeHelperReadGrant("finite-helper-grant", 4096, "1".repeat(24)), true);
  budget.finalizeCycle();
  assert.equal(owner.accounting().currentOutstandingBytes, 0,
    "the retained permission releases only after the helper read settles");
  let nextCycleStarted = true;
  try { budget.beginCycle(); } catch { nextCycleStarted = false; }
  assert.equal(nextCycleStarted, true,
    "an explicitly finalized cycle must not replay already-settled actual bytes at the next poll");
}

async function registrationRefusalIsTerminal() {
  const caseRoot = path.join(TEMP_ROOT, "registration-refusal-terminal");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "registration-refusal-terminal-command",
  });
  const invocationId = "41".repeat(12);
  const accepted = new CommandTelemetryClient(owner.configuration(), invocationId);
  const refused = new CommandTelemetryClient(owner.configuration(), invocationId);
  try {
    await owner.start();
    await accepted.connect();
    await assert.rejects(() => refused.connect(), /monitoring registration capacity reached/);
    await assert.rejects(() => refused.connect(), /monitoring registration capacity reached/,
      "a refused registration must remain terminal rather than appearing healthy before socket close");
    assert.equal(refused.registered, false);
    assert.match(refused.terminalError?.message ?? "", /monitoring registration capacity reached/);
    console.log("MEASURE item3 registration-refusal-terminal retainedRefusal=true reconnectRejected=true");
  } finally {
    await Promise.allSettled([accepted.close(), refused.close()]);
    await owner.close();
  }
}

async function clientRegistrationWriteFailureSettlement() {
  const caseRoot = path.join(TEMP_ROOT, "client-registration-write-failure");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "client-registration-write-failure-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), "10".repeat(12));
  const originalSocketWrite = net.Socket.prototype.write;
  let injected = false;
  try {
    await owner.start();
    net.Socket.prototype.write = function finiteRegistrationWriteFailure(chunk, ...args) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (!injected && /"kind":"register"/.test(text)) {
        injected = true;
        const error = new Error("finite injected registration write failure");
        error.code = "EPIPE";
        throw error;
      }
      return originalSocketWrite.call(this, chunk, ...args);
    };
    await assert.rejects(() => client.connect(), /finite injected registration write failure/);
    net.Socket.prototype.write = originalSocketWrite;
    const waiterRetained = Boolean(client.registrationWaiter);
    const releaseStarted = Boolean(client.socket?.destroyed || client.socket?.writableEnded);
    console.log(`MEASURE item3 client-registration-write-failure waiterRetained=${waiterRetained} releaseStarted=${releaseStarted}`);
    assert.deepEqual(
      { waiterRetained, releaseStarted },
      { waiterRetained: false, releaseStarted: true },
      "a failed registration write must clear its waiter and naturally settle the unregistered socket",
    );
  } finally {
    net.Socket.prototype.write = originalSocketWrite;
    client.registrationWaiter = undefined;
    await client.close();
    await owner.close();
  }
}

async function clientWriteFailureSettlement() {
  const caseRoot = path.join(TEMP_ROOT, "client-write-failure");
  const invocationId = "0".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "client-write-failure-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  const injected = new Error("finite injected client write failure");
  let originalWrite;
  try {
    await owner.start();
    await client.connect();
    originalWrite = client.write;
    client.write = function failBeforeRequestIo() { throw injected; };
    await assert.rejects(() => client.requestWork("ordinary", 128), /finite injected client write failure/);
    const grantWaitersAfterFailure = client.pendingGrant.size;
    client.pendingGrant.clear();

    client.write = originalWrite;
    const event = { type: "client_write_failure", marker: "GRANTED_OPERATION" };
    const grant = await client.requestWork("ordinary", Buffer.byteLength(JSON.stringify(event)) + 1);
    const socketClosed = new Promise((resolve) => client.socket.once("close", resolve));
    client.write = function failAfterGrant() { throw injected; };
    await assert.rejects(() => client.commitGranted(grant, event), /finite injected client write failure/);
    const receiptWaitersAfterFailure = client.pendingReceipt.size;
    const releaseStarted = client.socket.writableEnded;
    console.log(`MEASURE item3 client-write-failure grantWaiters=${grantWaitersAfterFailure} receiptWaiters=${receiptWaitersAfterFailure} releaseStarted=${releaseStarted}`);
    assert.deepEqual(
      { grantWaitersAfterFailure, receiptWaitersAfterFailure, releaseStarted },
      { grantWaitersAfterFailure: 0, receiptWaitersAfterFailure: 0, releaseStarted: true },
      "failed client writes must not leak waiters, and a granted partial operation must settle by natural transport EOF",
    );
    client.write = originalWrite;
    await socketClosed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(owner.accounting().currentOutstandingBytes, 0);
  } finally {
    if (originalWrite) client.write = originalWrite;
    client.pendingGrant.clear();
    client.pendingReceipt.clear();
    await client.close();
    await owner.close();
  }
}

async function observerCallbackCannotRewriteCommittedOutcome() {
  const caseRoot = path.join(TEMP_ROOT, "observer-callback-settlement");
  const invocationId = "42".repeat(12);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "observer-callback-settlement-command",
    onEvent() { throw new Error("finite injected observer callback failure"); },
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  try {
    await owner.start();
    await client.connect();
    const receipt = await client.publish({
      type: "invocation_terminal", outcome: "succeeded", marker: "COMMITTED_BEFORE_OBSERVER_FAILURE",
    }, "terminal");
    const drained = owner.drainEvents();
    assert.equal(receipt.accepted, true,
      "an optional observer callback must not rewrite an already committed publication as failed");
    assert.equal(drained.some((event) => event.marker === "COMMITTED_BEFORE_OBSERVER_FAILURE"), true);
    const accounting = owner.accounting();
    assert.equal(accounting.currentOutstandingBytes, 0);
    assert.equal(accounting.observerCallbackFailures, 1,
      "callback failure remains explicit even though it cannot rewrite the committed producer outcome");
    assert.match(accounting.lastObserverCallbackFailure?.reason ?? "", /finite injected observer callback failure/);
    console.log("MEASURE item3 observer-callback-settlement receiptAccepted=true committedDelivered=true");
  } finally {
    await client.close();
    await owner.close();
  }
}

async function hostPermissionSurvivesNativeWrite() {
  const caseRoot = path.join(TEMP_ROOT, "host-permission-native-write");
  const invocationId = "2".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "host-permission-native-write-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  let permission;
  let connection;
  let originalSocketWrite;
  let settleNativeWrite;
  try {
    await owner.start();
    await client.connect();
    connection = owner.invocations.get(invocationId).connection;
    originalSocketWrite = connection.socket.write;
    connection.socket.write = function deferredNativeWrite(_bytes, callback) {
      settleNativeWrite = callback;
      return true;
    };
    permission = owner.reserveHostWork(invocationId, "counter", 16 * 1024);
    assert.ok(permission);
    const event = { type: "counter_sample", marker: "NATIVE_WRITE_SETTLEMENT" };
    const deliveryBytes = owner.hostDeliveryBytes(event, "counter");
    assert.equal(owner.sendToInvocation(invocationId, event, "counter", permission, 128), true);
    owner.completeHostWork(permission, 128 + deliveryBytes);
    const beforeCallback = owner.accounting();
    console.log(`MEASURE item3 host-permission-native-write retainedBeforeCallback=${owner.hostPermissions.has(permission.permissionId)} outstandingBeforeCallback=${beforeCallback.currentOutstandingBytes}`);
    assert.equal(owner.hostPermissions.has(permission.permissionId), true,
      "a host permission must remain owned until its native socket write callback settles");
    assert.equal(beforeCallback.currentOutstandingBytes, 16 * 1024);

    connection.socket.write = originalSocketWrite;
    settleNativeWrite();
    const settled = owner.accounting();
    assert.equal(owner.hostPermissions.has(permission.permissionId), false);
    assert.equal(settled.currentOutstandingBytes, 0);
    permission = undefined;
  } finally {
    if (connection && originalSocketWrite) connection.socket.write = originalSocketWrite;
    if (permission && owner.hostPermissions.has(permission.permissionId)) owner.abandonHostWork(permission);
    await client.close();
    await owner.close();
  }
}

async function shutdownRetainsNativeWriteOwnership() {
  const caseRoot = path.join(TEMP_ROOT, "shutdown-native-write-ownership");
  const invocationId = "43".repeat(12);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "shutdown-native-write-ownership-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  let connection;
  let originalSocketWrite;
  let permission;
  let ownedAtNativeSettlement = false;
  try {
    await owner.start();
    await client.connect();
    connection = owner.invocations.get(invocationId).connection;
    originalSocketWrite = connection.socket.write;
    connection.socket.write = function observedShutdownWrite(bytes, callback) {
      return originalSocketWrite.call(this, bytes, (error) => {
        ownedAtNativeSettlement = owner.hostPermissions.has(permission.permissionId);
        callback?.(error);
      });
    };
    permission = owner.reserveHostWork(invocationId, "counter", 16 * 1024);
    assert.ok(permission);
    const event = { type: "shutdown_native_write", marker: "SHUTDOWN_WRITE_SETTLEMENT" };
    const deliveryBytes = owner.hostDeliveryBytes(event, "counter");
    assert.equal(owner.sendToInvocation(invocationId, event, "counter", permission), true);
    owner.completeHostWork(permission, deliveryBytes);
    await owner.close();
    assert.equal(ownedAtNativeSettlement, true,
      "owner shutdown must retain a host permission until its queued native write callback settles");
    assert.equal(owner.accounting().currentOutstandingBytes, 0);
    console.log("MEASURE item3 shutdown-native-write ownedAtSettlement=true outstanding=0");
  } finally {
    if (connection && originalSocketWrite) connection.socket.write = originalSocketWrite;
    await client.close();
    await owner.close();
  }
}

async function nativeWriteThrowSettlesConnection() {
  const caseRoot = path.join(TEMP_ROOT, "native-write-throw");
  const invocationId = "21".repeat(12);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "native-write-throw-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  let permission;
  let connection;
  let originalSocketWrite;
  try {
    await owner.start();
    await client.connect();
    connection = owner.invocations.get(invocationId).connection;
    originalSocketWrite = connection.socket.write;
    connection.socket.write = function finiteNativeWriteThrow() {
      const error = new Error("finite injected native write throw");
      error.code = "EPIPE";
      throw error;
    };
    permission = owner.reserveHostWork(invocationId, "counter", 16 * 1024);
    assert.ok(permission);
    let threw = false;
    let delivered = false;
    try {
      delivered = owner.sendToInvocation(invocationId, { type: "counter_error", marker: "WRITE_THROW" }, "counter", permission);
    } catch { threw = true; }
    connection.socket.write = originalSocketWrite;
    if (!threw) {
      owner.completeHostWork(permission, 0);
      permission = undefined;
    }
    console.log(`MEASURE item3 native-write-throw threw=${threw} delivered=${delivered} connectionSettling=${connection.socket.destroyed || connection.socket.writableEnded}`);
    assert.deepEqual(
      { threw, delivered, connectionSettling: connection.socket.destroyed || connection.socket.writableEnded },
      { threw: false, delivered: false, connectionSettling: true },
      "a synchronous native write failure must become a bounded connection failure, not escape with charged work stranded",
    );
  } finally {
    if (connection && originalSocketWrite) connection.socket.write = originalSocketWrite;
    if (permission && owner.hostPermissions.has(permission.permissionId)) owner.abandonHostWork(permission);
    await client.close();
    await owner.close();
  }
}

async function hostPermissionSurvivesProducerEof() {
  const caseRoot = path.join(TEMP_ROOT, "host-permission-eof");
  const invocationId = "5".repeat(24);
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "host-permission-eof-command",
  });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  let permission;
  try {
    await owner.start();
    await client.connect();
    permission = owner.reserveHostWork(invocationId, "counter", 16 * 1024);
    assert.ok(permission, "the finite host operation must be admitted before producer EOF");
    await client.close();
    const afterEof = owner.accounting();
    const retainedAcrossEof = owner.hostPermissions.has(permission.permissionId)
      && afterEof.currentOutstandingBytes === 16 * 1024
      && afterEof.activeRegistrations === 1;
    let completionSucceeded = false;
    try {
      owner.completeHostWork(permission, 512);
      completionSucceeded = true;
    } catch {}
    const afterCompletion = owner.accounting();
    const releasedAfterSettlement = completionSucceeded
      && afterCompletion.currentOutstandingBytes === 0
      && afterCompletion.activeRegistrations === 0;
    console.log(`MEASURE item3 host-permission-eof retainedAcrossEof=${retainedAcrossEof} releasedAfterSettlement=${releasedAfterSettlement}`);
    assert.deepEqual(
      { retainedAcrossEof, releasedAfterSettlement },
      { retainedAcrossEof: true, releasedAfterSettlement: true },
      "producer EOF must not refund an in-flight host operation before its explicit settlement",
    );
  } finally {
    if (permission && owner.hostPermissions.has(permission.permissionId)) owner.abandonHostWork(permission);
    await client.close();
    await owner.close();
  }
}

async function preRegistrationConnectionBound() {
  const caseRoot = path.join(TEMP_ROOT, "pre-registration-bound");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "pre-registration-bound-command",
  });
  const sockets = [];
  const socketStates = [];
  const originalAccept = owner.accept;
  let peakConnections = 0;
  let refusedResponses = 0;
  let resolveAllRefusals;
  const allRefusalsObserved = new Promise((resolve) => { resolveAllRefusals = resolve; });
  owner.accept = function observedAccept(socket) {
    const result = originalAccept.call(this, socket);
    peakConnections = Math.max(peakConnections, this.connections.size);
    return result;
  };
  try {
    await owner.start();
    for (let index = 0; index < 220; index += 1) {
      const socket = net.createConnection(owner.endpoint);
      let resolveRefusalSettlement;
      const state = {
        socket, response: "", refusalObserved: false, responseObserved: false,
        releaseCompletedAfterResponse: false,
        refusalSettled: new Promise((resolve) => { resolveRefusalSettlement = resolve; }),
      };
      socketStates.push(state);
      const observeRefusal = (kind) => {
        if (state.refusalObserved) return;
        state.refusalObserved = true;
        state.refusalKind = kind;
        state.responseObserved = kind === "response";
        refusedResponses += 1;
        if (refusedResponses === 20) resolveAllRefusals();
      };
      socket.on("data", (chunk) => {
        state.response += chunk.toString("utf8");
        if (/"accepted":false/.test(state.response)) observeRefusal("response");
      });
      socket.once("close", () => {
        if (index >= 200 && !state.refusalObserved) observeRefusal("bounded-drop");
        state.releaseCompletedAfterResponse = state.responseObserved;
        resolveRefusalSettlement();
      });
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      if (index < 200) socket.write("{");
      else await state.refusalSettled;
    }
    await allRefusalsObserved;
    await new Promise((resolve) => setImmediate(resolve));
    const refusedStates = socketStates.filter((state) => state.refusalObserved);
    const responseStates = refusedStates.filter((state) => state.responseObserved);
    const actualReleaseAfterResponse = responseStates.length > 0
      && responseStates.every((state) => state.releaseCompletedAfterResponse)
      && owner.accounting().activeRefusalResponses === 0;
    console.log(`MEASURE item3 pre-registration-bound peakConnections=${peakConnections} retainedConnections=${owner.connections.size} refusedResponses=${refusedStates.length} responseRefusals=${responseStates.length} actualReleaseAfterResponse=${actualReleaseAfterResponse}`);
    assert.ok(peakConnections <= 200,
      "the registration ceiling must pre-admit raw private-pipe connections before any frame buffering");
    assert.equal(refusedStates.length, 20);
    assert.equal(actualReleaseAfterResponse, true,
      "a response-observed refusal must reach actual socket close and owner release without relying on client/child close");
  } finally {
    await Promise.all(sockets.map(async (socket) => {
      if (socket.destroyed) return;
      socket.resume();
      const closed = new Promise((resolve) => socket.once("close", resolve));
      socket.end();
      await closed;
    }));
    await owner.close();
  }
}

async function preRegistrationFrameAdmission() {
  const caseRoot = path.join(TEMP_ROOT, "pre-registration-frame-admission");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "pre-registration-frame-admission-command",
  });
  const originalAccept = owner.accept;
  let acceptedSocket;
  let resolveDataObserved;
  const dataObserved = new Promise((resolve) => { resolveDataObserved = resolve; });
  owner.accept = function observePreRegistrationData(socket) {
    acceptedSocket = socket;
    socket.once("data", () => resolveDataObserved());
    return originalAccept.call(this, socket);
  };
  let socket;
  try {
    await owner.start();
    socket = net.createConnection(owner.endpoint);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await new Promise((resolve, reject) => {
      socket.write(Buffer.alloc(4097, 123), (error) => error ? reject(error) : resolve());
    });
    await dataObserved;
    const rejectedBeforeMoreInput = acceptedSocket.destroyed;
    console.log(`MEASURE item3 pre-registration-frame-admission rejectedBeforeMoreInput=${rejectedBeforeMoreInput}`);
    assert.equal(rejectedBeforeMoreInput, true,
      "an unregistered connection must not retain more than the fixed control-frame allowance while waiting for a newline");
  } finally {
    if (socket && !socket.destroyed) {
      socket.resume();
      const closed = new Promise((resolve) => socket.once("close", resolve));
      socket.end();
      await closed;
    }
    await owner.close();
  }
}

async function aggregateFrameBufferAdmission() {
  const caseRoot = path.join(TEMP_ROOT, "aggregate-frame-buffer-admission");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "aggregate-frame-buffer-admission-command",
  });
  const sockets = [];
  const acceptedSockets = [];
  const originalAccept = owner.accept;
  let observedData = 0;
  let resolveAllData;
  const allDataObserved = new Promise((resolve) => { resolveAllData = resolve; });
  owner.accept = function observeBufferedFrame(socket) {
    acceptedSockets.push(socket);
    socket.once("data", () => {
      observedData += 1;
      if (observedData === 80) resolveAllData();
    });
    return originalAccept.call(this, socket);
  };
  try {
    await owner.start();
    for (let index = 0; index < 80; index += 1) {
      const socket = net.createConnection(owner.endpoint);
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    }
    await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => {
      socket.write(Buffer.alloc(1024, 123), (error) => error ? reject(error) : resolve());
    })));
    await allDataObserved;
    const activeBufferedSockets = acceptedSockets.filter((socket) => !socket.destroyed).length;
    console.log(`MEASURE item3 aggregate-frame-buffer-admission activeBufferedSockets=${activeBufferedSockets}`);
    assert.ok(activeBufferedSockets <= 64,
      "all partial protocol frames must share the existing 64-KiB queue bound rather than multiply it per connection");
  } finally {
    await Promise.all(sockets.map(async (socket) => {
      if (socket.destroyed) return;
      socket.resume();
      const closed = new Promise((resolve) => socket.once("close", resolve));
      socket.end();
      await closed;
    }));
    await owner.close();
  }
}

async function frameBufferSharesDeliveryQueue() {
  const caseRoot = path.join(TEMP_ROOT, "frame-buffer-shared-queue");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "frame-buffer-shared-queue-command",
  });
  const publisher = new CommandTelemetryClient(owner.configuration(), "31".repeat(12));
  const partial = new CommandTelemetryClient(owner.configuration(), "32".repeat(12));
  try {
    await owner.start();
    await Promise.all([publisher.connect(), partial.connect()]);
    await publisher.publish({ type: "retained_delivery", payload: "q".repeat(40 * 1024) }, "ordinary");
    const partialConnection = owner.invocations.get("32".repeat(12)).connection;
    let resolveDataObserved;
    const dataObserved = new Promise((resolve) => { resolveDataObserved = resolve; });
    partialConnection.socket.once("data", () => resolveDataObserved());
    await new Promise((resolve, reject) => {
      partial.socket.write(Buffer.alloc(30 * 1024, 123), (error) => error ? reject(error) : resolve());
    });
    await dataObserved;
    const partialRejected = partialConnection.socket.destroyed;
    const accounting = owner.accounting();
    console.log(`MEASURE item3 frame-buffer-shared-queue partialRejected=${partialRejected} maxCombinedQueueBytes=${accounting.maxCombinedQueueBytes}`);
    assert.equal(partialRejected, true,
      "inbound partial frames and retained outbound deliveries must share one 64-KiB queue admission bound");
    assert.ok(accounting.maxCombinedQueueBytes <= 64 * 1024);
    owner.drainEvents();
  } finally {
    await Promise.allSettled([publisher.close(), partial.close()]);
    await owner.close();
  }
}

async function refusalResponseOwnershipBound() {
  const caseRoot = path.join(TEMP_ROOT, "refusal-response-ownership");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "refusal-response-ownership-command",
  });
  const sockets = [];
  const originalAccept = owner.accept;
  let activeAcceptedSockets = 0;
  let peakAcceptedSockets = 0;
  owner.accept = function observedAcceptedSocket(socket) {
    activeAcceptedSockets += 1;
    peakAcceptedSockets = Math.max(peakAcceptedSockets, activeAcceptedSockets);
    socket.once("close", () => { activeAcceptedSockets -= 1; });
    return originalAccept.call(this, socket);
  };
  try {
    await owner.start();
    const attempted = [];
    for (let index = 0; index < 220; index += 1) {
      const socket = net.createConnection(owner.endpoint);
      sockets.push(socket);
      attempted.push(new Promise((resolve) => {
        socket.once("connect", () => resolve("connected"));
        socket.once("error", () => resolve("rejected"));
      }));
    }
    await Promise.all(attempted);
    await new Promise((resolve) => setImmediate(resolve));
    console.log(`MEASURE item3 refusal-response-ownership peakAcceptedSockets=${peakAcceptedSockets} trackedConnections=${owner.connections.size}`);
    assert.ok(peakAcceptedSockets <= 201,
      "raw registration refusal responses must have one fixed owner slot rather than an unbounded set outside tracked connections");
  } finally {
    await Promise.all(sockets.map(async (socket) => {
      if (socket.destroyed) return;
      socket.resume();
      const closed = new Promise((resolve) => socket.once("close", resolve));
      socket.end();
      await closed;
    }));
    await owner.close();
  }
}

async function monitoringRegistrationBound() {
  const caseRoot = path.join(TEMP_ROOT, "registration-bound");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "registration-bound-command",
  });
  await owner.start();
  const clients = [];
  try {
    for (let index = 0; index < 200; index += 1) {
      const client = new CommandTelemetryClient(owner.configuration(), index.toString(16).padStart(24, "0"));
      await client.connect();
      clients.push(client);
    }
    const refused = new CommandTelemetryClient(owner.configuration(), "f".repeat(24));
    await assert.rejects(() => refused.connect(), /monitoring registration capacity reached/);
    const accounting = owner.accounting();
    assert.equal(accounting.maxRegistrations, 200);
    assert.equal(accounting.registrationDenials, 1);

    // Registration refusal limits only monitoring amplification. A real,
    // authorized finite test still runs with its original output and result.
    const script = path.join(caseRoot, "registration-refused-child.cjs");
    const source = "console.log('REGISTRATION_REFUSED_CHILD_COMPLETED');\n";
    fs.writeFileSync(script, source);
    const body = {
      schemaVersion: 1,
      authority: "run-admission-owner-task",
      workspaceRealPath: fs.realpathSync(caseRoot),
      existingEntrypoints: [{
        path: fs.realpathSync(script), bytes: Buffer.byteLength(source),
        sha256: crypto.createHash("sha256").update(source).digest("hex"),
      }],
      approvedDynamicScopes: [], allowedNodeOptions: [],
    };
    const policy = { ...body, policyHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    const authorization = path.join(caseRoot, "authorization.json");
    const authorizationBytes = Buffer.from(JSON.stringify(policy));
    fs.writeFileSync(authorization, authorizationBytes);
    const child = spawn(process.execPath, [
      path.join(ROOT, "src", "no-output-test-supervisor.cjs"),
      "--event-dir", path.join(caseRoot, "evidence"),
      "--evidence-root", path.join(caseRoot, "capture"),
      "--command-id", "registration-bound-command",
      "--policy", JSON.stringify({ minimumObservationMs: 100, alarmAfterMs: 200, cancelAfterMs: 400, minimumAlarmLeadMs: 100, pollMs: 10 }),
      "--authorization-file", authorization,
      "--authorization-sha256", crypto.createHash("sha256").update(authorizationBytes).digest("hex"),
      "--io-observer", path.join(ROOT, "src", "no-output-io-observer.cjs"),
      "--host-managed-capture", "true",
      "--owner-config", JSON.stringify(owner.configuration()),
      "--", script,
    ], {
      cwd: caseRoot,
      env: { ...process.env, PI_ORC_NO_OUTPUT_AUTH: "c".repeat(64), NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let childStdout = ""; let childStderr = "";
    child.stdout.on("data", (chunk) => { childStdout += chunk; });
    child.stderr.on("data", (chunk) => { childStderr += chunk; });
    const childCode = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    assert.equal(childCode, 0, childStderr);
    assert.match(childStdout, /REGISTRATION_REFUSED_CHILD_COMPLETED/);
    assert.equal(owner.drainEvents().some((event) => event.type === "invocation_terminal"), false,
      "a refused monitor registration must not fabricate terminal evidence");

    await clients[0].publish({ type: "accepted_at_registration_bound", marker: "ORIGINAL_INVOCATION_CONTINUES" });
    owner.drainEvents();
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
    await new Promise((resolve) => setImmediate(resolve));
    for (let index = 0; index < 410; index += 1) {
      const invocationId = (1000 + index).toString(16).padStart(24, "0");
      const client = new CommandTelemetryClient(owner.configuration(), invocationId);
      await client.connect();
      await client.publish({ type: "invocation_terminal", outcome: "succeeded", index }, "terminal");
      owner.drainEvents();
      owner.finalizeInvocation(invocationId);
      assert.equal(owner.retireCommitted(invocationId), true);
      await client.close();
    }
    const settled = owner.accounting();
    assert.equal(settled.activeRegistrations, 0);
    assert.equal(settled.retainedGenerations, 0);
    assert.equal(settled.currentOutstandingBytes, 0);
    console.log(`MEASURE item3 registration-bound maxRegistrations=${accounting.maxRegistrations} denials=${accounting.registrationDenials} completedInvocations=410 retainedGenerations=${settled.retainedGenerations}`);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await owner.close();
  }
}

async function actualWindowsOwnerSequence() {
  if (process.platform !== "win32") return;
  const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
  process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const { WindowsIoCounterService } = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));

  const caseRoot = path.join(TEMP_ROOT, "actual-windows-owner");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const fixture = path.join(caseRoot, "finite-counter-child.cjs");
  const output = path.join(caseRoot, "counter-output.log");
  fs.writeFileSync(fixture, [
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => { const value = JSON.parse(line); fs.appendFileSync(value.path, `WRITE_${value.epoch}\\n`); console.log(`written:${value.epoch}`); });",
    "",
  ].join("\n"));

  const commandId = "actual-windows-owner-command";
  const owner = new CommandTelemetryOwner({ commandRoot: path.join(caseRoot, "owner"), evidenceDirectory, commandId });
  await owner.start();
  const invocationId = "e".repeat(24);
  const nestedInvocationId = "f".repeat(24);
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  const nested = new CommandTelemetryClient(owner.configuration(invocationId), nestedInvocationId);
  // SINGLE-OWNER-IN-SINK-FAILURE-REJECTS (named test correction, owner decision 5 / review 23
  // finding 7): an in-sink check failure is retained by the service and its state is never
  // delivered, so every awaited state must fail with that same AssertionError instead of
  // waiting. stateWaiters now hold {resolve,reject} pairs; nextState() resolves a queued state
  // if one exists, else rejects with the retained inSinkFailure if the sink has already failed,
  // else waits as before.
  const pendingPermissions = new Map();
  const states = [];
  const stateWaiters = [];
  let inSinkFailure;
  client.on("event", (state) => {
    const waiter = stateWaiters.shift();
    if (waiter) waiter.resolve(state); else states.push(state);
  });
  const nextState = () => {
    if (states.length) return Promise.resolve(states.shift());
    if (inSinkFailure) return Promise.reject(inSinkFailure);
    return new Promise((resolve, reject) => stateWaiters.push({ resolve, reject }));
  };
  const service = new WindowsIoCounterService(
    evidenceDirectory, "9".repeat(64), commandId, undefined,
    (stateInvocationId, state, _bytes, nativeFrameBytes) => {
      try {
        const key = state.type === "counter_registered" ? "register" : `sample:${String(state.requestId || "control")}`;
        const permission = pendingPermissions.get(key) || owner.reserveHostWork(stateInvocationId, "counter", 16 * 1024);
        pendingPermissions.delete(key);
        assert.ok(permission, `missing owner permission for ${key}`);
        const deliveryBytes = owner.hostDeliveryBytes(state, "counter");
        assert.equal(owner.sendToInvocation(stateInvocationId, state, "counter", permission, nativeFrameBytes), true);
        owner.completeHostWork(permission, nativeFrameBytes + deliveryBytes);
      } catch (error) {
        if (!inSinkFailure) inSinkFailure = error;
        while (stateWaiters.length) stateWaiters.shift().reject(inSinkFailure);
        throw error;
      }
    },
  );
  let child;
  try {
    await Promise.all([client.connect(), nested.connect(), service.start()]);
    const earliestCreationUnixMs = Date.now();
    child = spawn(process.execPath, [fixture], {
      cwd: caseRoot,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });
    let stdoutRemainder = "";
    const outputLines = [];
    const outputWaiters = [];
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split(/\r?\n/); stdoutRemainder = lines.pop() || "";
      for (const line of lines) { const waiter = outputWaiters.shift(); if (waiter) waiter(line); else outputLines.push(line); }
    });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    const nextOutput = () => outputLines.length ? Promise.resolve(outputLines.shift()) : new Promise((resolve) => outputWaiters.push(resolve));
    const latestCreationUnixMs = Date.now();
    const transportId = "1".repeat(32);
    const bindingGeneration = "2".repeat(32);
    const registrationPermission = owner.reserveHostWork(invocationId, "counter", 16 * 1024);
    assert.ok(registrationPermission);
    pendingPermissions.set("register", registrationPermission);
    service.register({ invocationId, transportId, bindingGeneration, pid: child.pid, expectedExecutable: process.execPath, earliestCreationUnixMs, latestCreationUnixMs });
    const registered = await nextState();
    assert.equal(registered.type, "counter_registered");
    assert.equal(registered.desiredAccess, 4096);

    let acceptedEpochs = 0;
    let cumulativeNativeBytes = 0;
    for (let epoch = 1; epoch <= 3000; epoch += 1) {
      if (epoch % 100 === 0) {
        child.stdin.write(`${JSON.stringify({ path: output, epoch })}\n`);
        assert.equal(await nextOutput(), `written:${epoch}`);
      }
      const requestId = epoch.toString(16).padStart(32, "0");
      const permission = owner.reserveHostWork(invocationId, "counter", 16 * 1024);
      assert.ok(permission, `owner did not admit native response epoch ${epoch}`);
      pendingPermissions.set(`sample:${requestId}`, permission);
      service.sample({ invocationId, transportId, bindingGeneration, requestGeneration: epoch, requestId });
      const statePromise = nextState();
      const concurrentPublication = epoch % 100 === 0
        ? nested.publish({ type: "nested_epoch", epoch, marker: "OVERLAPPING_HELPER" })
        : Promise.resolve();
      const [state] = await Promise.all([statePromise, concurrentPublication]);
      owner.drainEvents();
      assert.equal(state.type, "counter_sample");
      assert.equal(state.requestId, requestId);
      cumulativeNativeBytes += Buffer.byteLength(JSON.stringify(state), "utf8") + 1;
      acceptedEpochs += 1;
    }
    await client.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "NORMAL_CLOSE_NONZERO" }, "terminal");
    service.unregister(invocationId);
    child.stdin.end();
    const childCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(childCode, 0, stderr);
    await service.close();
    const accounting = owner.accounting();
    assert.equal(acceptedEpochs, 3000);
    assert.ok(cumulativeNativeBytes > 1024 * 1024);
    assert.ok(accounting.completedOperations > 30);
    assert.ok(accounting.maxOutstandingBytes <= 256 * 1024 - 16 * 1024);
    assert.ok(accounting.maxQueuedBytes <= 64 * 1024);
    assert.ok(accounting.retainedGenerations <= 1);
    assert.equal(fs.readdirSync(evidenceDirectory).some((name) => name.includes("counter") || name.includes("mailbox") || name.endsWith(".rsv")), false);
    assert.match(fs.readFileSync(output, "utf8"), /WRITE_3000/);
    console.log(`MEASURE item3 actual-windows-owner acceptedEpochs=${acceptedEpochs} cumulativeNativeBytes=${cumulativeNativeBytes} maxOutstandingBytes=${accounting.maxOutstandingBytes} maxQueuedBytes=${accounting.maxQueuedBytes} retainedGenerations=${accounting.retainedGenerations}`);
  } finally {
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    }
    try { await service.close(); } catch {}
    await Promise.allSettled([client.close(), nested.close()]);
    await owner.close();
  }
}

(async () => {
  try {
    if (process.argv.includes("--pre-registration-tail-diagnosis")) {
      await preRegistrationConnectionBound();
      console.log("PASS item3 finite pre-registration tail diagnosis");
      return;
    }
    if (process.argv.includes("--refusal-response-ownership")) {
      await refusalResponseOwnershipBound();
      console.log("PASS item3 bounded refusal-response ownership");
      return;
    }
    if (process.argv.includes("--pre-registration-frame-admission")) {
      await preRegistrationFrameAdmission();
      console.log("PASS item3 pre-registration frame admission");
      return;
    }
    if (process.argv.includes("--aggregate-frame-buffer-admission")) {
      await aggregateFrameBufferAdmission();
      console.log("PASS item3 aggregate frame-buffer admission");
      return;
    }
    if (process.argv.includes("--frame-buffer-shared-queue")) {
      await frameBufferSharesDeliveryQueue();
      console.log("PASS item3 frame buffer shares delivery queue");
      return;
    }
    if (process.argv.includes("--combined-causal-only")) {
      await combinedCausalScenario();
      console.log("PASS item3 combined causal single-owner transaction");
      return;
    }
    if (process.argv.includes("--predecessor-owned-metadata")) {
      predecessorAdmissionUsesOwnedMetadata();
      console.log("PASS item3 predecessor admission uses owned metadata");
      return;
    }
    if (process.argv.includes("--descriptor-close-ownership")) {
      await committedDescriptorCloseOwnership();
      console.log("PASS item3 committed descriptor close ownership");
      return;
    }
    if (process.argv.includes("--direct-host-delivery")) {
      await directHostDeliveryRequiresPermission();
      console.log("PASS item3 direct host delivery pre-admission");
      return;
    }
    if (process.argv.includes("--observer-callback-settlement")) {
      await observerCallbackCannotRewriteCommittedOutcome();
      console.log("PASS item3 observer callback cannot rewrite committed outcome");
      return;
    }
    if (process.argv.includes("--host-native-write-ownership")) {
      await hostPermissionSurvivesNativeWrite();
      console.log("PASS item3 host permission retained through native write settlement");
      return;
    }
    if (process.argv.includes("--shutdown-native-write-ownership")) {
      await shutdownRetainsNativeWriteOwnership();
      console.log("PASS item3 shutdown retains native-write ownership");
      return;
    }
    if (process.argv.includes("--native-write-throw-settlement")) {
      await nativeWriteThrowSettlesConnection();
      console.log("PASS item3 native write-throw settlement");
      return;
    }
    if (process.argv.includes("--client-write-failure-settlement")) {
      await clientWriteFailureSettlement();
      console.log("PASS item3 client write-failure settlement");
      return;
    }
    if (process.argv.includes("--registration-refusal-terminal")) {
      await registrationRefusalIsTerminal();
      console.log("PASS item3 registration refusal is terminal");
      return;
    }
    if (process.argv.includes("--client-registration-write-failure")) {
      await clientRegistrationWriteFailureSettlement();
      console.log("PASS item3 client registration write-failure settlement");
      return;
    }
    if (process.argv.includes("--helper-read-permission-carryover")) {
      helperReadPermissionCarryover();
      console.log("PASS item3 helper-read permission carryover");
      return;
    }
    await combinedCausalScenario();
    console.log("PASS item3 combined causal single-owner transaction");
    predecessorAdmissionUsesOwnedMetadata();
    console.log("PASS item3 predecessor admission uses owned metadata");
    hostFailedStageOwnership();
    console.log("PASS item3 host failed-stage ownership and recovery");
    await terminalDrainIsolation();
    console.log("PASS item3 bounded record-local terminal drain and healthy successor delivery");
    conclusiveGenerationRetirement();
    console.log("PASS item3 conclusive predecessor/current generation retirement");
    committedAcquireRequiresAdmission();
    console.log("PASS item3 direct committed-read admission and retained competing charge");
    committedReadFailureReleasesLease();
    console.log("PASS item3 committed read-error lease recovery");
    await committedDescriptorCloseOwnership();
    console.log("PASS item3 committed descriptor close ownership");
    helperReadPermissionCarryover();
    console.log("PASS item3 helper-read permission carryover");
    await directHostDeliveryRequiresPermission();
    console.log("PASS item3 direct host delivery pre-admission");
    await observerCallbackCannotRewriteCommittedOutcome();
    console.log("PASS item3 observer callback cannot rewrite committed outcome");
    await hostPermissionSurvivesNativeWrite();
    console.log("PASS item3 host permission retained through native write settlement");
    await shutdownRetainsNativeWriteOwnership();
    console.log("PASS item3 shutdown retains native-write ownership");
    await nativeWriteThrowSettlesConnection();
    console.log("PASS item3 native write-throw settlement");
    await hostPermissionSurvivesProducerEof();
    console.log("PASS item3 host permission retained through producer EOF until settlement");
    await registrationRefusalIsTerminal();
    console.log("PASS item3 registration refusal is terminal");
    await clientRegistrationWriteFailureSettlement();
    console.log("PASS item3 client registration write-failure settlement");
    await clientWriteFailureSettlement();
    console.log("PASS item3 client write-failure settlement");
    await preRegistrationFrameAdmission();
    console.log("PASS item3 pre-registration frame admission");
    await aggregateFrameBufferAdmission();
    console.log("PASS item3 aggregate frame-buffer admission");
    await frameBufferSharesDeliveryQueue();
    console.log("PASS item3 frame buffer shares delivery queue");
    await preRegistrationConnectionBound();
    console.log("PASS item3 pre-registration connection admission bound");
    await refusalResponseOwnershipBound();
    console.log("PASS item3 bounded refusal-response ownership");
    await monitoringRegistrationBound();
    console.log("PASS item3 bounded monitoring registration");
    await actualWindowsOwnerSequence();
    console.log("PASS item3 actual Windows single-owner transport");
  } finally {
    fs.renameSync = originalRenameSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync = originalRmSync;
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
