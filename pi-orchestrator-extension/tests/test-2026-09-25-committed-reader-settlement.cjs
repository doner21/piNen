#!/usr/bin/env node
"use strict";

/**
 * Finite native regressions for committed-reader admission and shutdown.
 *
 * An inconclusively closed committed reader must block every later committed
 * reader before native I/O, without dropping queued terminal evidence. A
 * failed owner shutdown must remain closed to admission while allowing a later
 * close() call to finish resource settlement after native closure recovers.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-committed-reader-"));
const tempRealPath = fs.realpathSync(TEMP_ROOT);
const repoRealPath = fs.realpathSync(ROOT);
const relativeToRepo = path.relative(repoRealPath, tempRealPath);
if (!path.isAbsolute(tempRealPath) || relativeToRepo === "" || (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo))) {
  throw new Error("COMMITTED_READER_TEST_ROOT_NOT_ISOLATED");
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

const { CommandTelemetryOwner, CommandTelemetryClient } = require(path.join(ROOT, "src", "command-telemetry-owner.cjs"));
const native = {
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  fstatSync: fs.fstatSync,
};
let passed = false;

function descriptorIsOpen(descriptor) {
  try { native.fstatSync(descriptor); return true; }
  catch (error) { return error?.code !== "EBADF"; }
}

function installReadCloseFault(evidenceDirectory) {
  const evidenceRoot = path.resolve(evidenceDirectory);
  const descriptors = new Set();
  let rejectClose = true;
  let opens = 0;
  fs.openSync = function trackedReadOpen(file, ...args) {
    const descriptor = native.openSync.call(this, file, ...args);
    if (args[0] === "r" && path.dirname(path.resolve(String(file))) === evidenceRoot
      && new Error().stack?.includes("readCommittedDelivery")) {
      descriptors.add(descriptor);
      opens += 1;
    }
    return descriptor;
  };
  fs.closeSync = function finiteReadCloseFailure(descriptor, ...args) {
    if (rejectClose && descriptors.has(descriptor)) {
      const error = new Error("finite committed-reader close failure");
      error.code = "EIO";
      throw error;
    }
    const result = native.closeSync.call(this, descriptor, ...args);
    descriptors.delete(descriptor);
    return result;
  };
  return {
    descriptors,
    get opens() { return opens; },
    recover() { rejectClose = false; },
    restore() { fs.openSync = native.openSync; fs.closeSync = native.closeSync; },
    closeOwned() {
      rejectClose = false;
      for (const descriptor of descriptors) {
        try { native.closeSync(descriptor); } catch {}
        descriptors.delete(descriptor);
      }
    },
  };
}

async function committedDrainDefersWithoutReopening() {
  const caseRoot = path.join(TEMP_ROOT, "drain");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const owner = new CommandTelemetryOwner({ commandRoot: path.join(caseRoot, "command"), evidenceDirectory, commandId: "committed-drain" });
  const firstId = "1".repeat(24);
  const secondId = "2".repeat(24);
  const first = new CommandTelemetryClient(owner.configuration(), firstId);
  const second = new CommandTelemetryClient(owner.configuration(), secondId);
  const fault = installReadCloseFault(evidenceDirectory);
  // Premise correction F-CR-ORDER: the owner correctly refuses to grant a
  // terminal publication while an earlier committed-reader descriptor is
  // retained, so the publication is started without awaiting it. A
  // pass-through barrier on the actual owner.request observes its admission,
  // and the fault is recovered before any await of that publication.
  const originalRequest = owner.request;
  let secondRequestHits = 0;
  let resolveSecondRequest;
  const secondRequest = new Promise((resolve) => { resolveSecondRequest = resolve; });
  owner.request = function observedRequest(connection, frame) {
    const result = originalRequest.call(this, connection, frame);
    if (connection.invocationId === secondId) {
      secondRequestHits += 1;
      resolveSecondRequest(connection);
    }
    return result;
  };
  let secondPublication;
  try {
    await owner.start();
    await first.connect();
    await second.connect();
    await first.publish({ type: "invocation_terminal", invocationId: firstId, outcome: "succeeded", marker: "FIRST_COMMITTED" }, "terminal");
    const firstDrain = owner.drainEvents();
    assert.equal(firstDrain.some((event) => event.marker === "FIRST_COMMITTED"), true);
    assert.equal(fault.opens, 1);
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 1);
    assert.equal(owner.accounting().retainedReaderDescriptors, 1);

    secondPublication = second.publish({ type: "invocation_terminal", invocationId: secondId, outcome: "succeeded", marker: "DEFERRED_COMMITTED" }, "terminal");
    secondPublication.catch(() => {});
    const secondConnection = await Promise.race([
      secondRequest,
      secondPublication.then(() => { throw new Error("COMMITTED_READER_PUBLICATION_SETTLED_BEFORE_ADMISSION"); }),
    ]);
    assert.equal(secondRequestHits, 1, "the actual owner request path must observe the second publication");
    assert.equal(secondConnection.pending?.status, "queued", "a retained committed reader must defer terminal publication admission");
    assert.equal(owner.events.length, 0, "no committed evidence may be admitted while the reader is retained");
    assert.equal(fault.opens, 1);
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 1);
    assert.equal(owner.accounting().retainedReaderDescriptors, 1);
    for (let attempt = 0; attempt < 129; attempt += 1) {
      assert.deepEqual(owner.drainEvents(), [], "an unresolved reader must defer the queued committed terminal");
    }
    const deferred = owner.accounting();
    assert.equal(fault.opens, 1, "repeated committed drains must not allocate another native reader");
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 1);
    assert.equal(deferred.retainedReaderDescriptors, 1);
    assert.ok(deferred.currentOutstandingBytes > 0);

    fault.recover();
    owner.drainEvents();
    await secondPublication;
    assert.equal(owner.events.length, 1, "deferred committed evidence must remain queued");
    assert.equal(owner.events[0].delivery.invocationId, secondId);
    const recoveredDrain = owner.drainEvents();
    assert.equal(recoveredDrain.some((event) => event.marker === "DEFERRED_COMMITTED"), true);
    assert.equal(fault.opens, 2, "recovery may open the one preserved queued reader exactly once");
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 0);
    assert.equal(owner.events.length, 0);
    assert.equal(owner.accounting().retainedReaderDescriptors, 0);
    assert.equal(owner.accounting().currentOutstandingBytes, 0);
    console.log(`MEASURE item3 committed-drain-admission ${JSON.stringify({ attempts: 130, opens: fault.opens, queuedAfterRecovery: owner.events.length })}`);
  } finally {
    fault.recover();
    owner.reconcileFailedReaderDescriptors();
    owner.drainEvents();
    const publications = await Promise.allSettled(secondPublication ? [secondPublication] : []);
    for (const publication of publications) {
      if (publication.status === "rejected") console.log(`COMMITTED_READER_SECOND_PUBLICATION_REJECTED ${String(publication.reason?.message || publication.reason)}`);
    }
    owner.request = originalRequest;
    await Promise.allSettled([first.close(), second.close()]);
    await owner.close();
    fault.restore();
    fault.closeOwned();
  }
}

async function directAcquireDefersWithoutReopening() {
  const caseRoot = path.join(TEMP_ROOT, "acquire");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const invocationId = "3".repeat(24);
  const owner = new CommandTelemetryOwner({ commandRoot: path.join(caseRoot, "command"), evidenceDirectory, commandId: "committed-acquire" });
  const fault = installReadCloseFault(evidenceDirectory);
  const leases = [];
  try {
    assert.equal(owner.commitHostEvidence(invocationId, {
      type: "invocation_terminal", invocationId, outcome: "succeeded", marker: "ACQUIRE_COMMITTED",
    }), true);
    const first = owner.acquireCommitted(invocationId);
    leases.push(first.leaseId);
    assert.match(first.bytes.toString("utf8"), /ACQUIRE_COMMITTED/);
    owner.releaseReader(first.leaseId);
    leases.length = 0;
    assert.equal(fault.opens, 1);
    assert.equal(owner.accounting().retainedReaderDescriptors, 1);

    let deferred = 0;
    for (let attempt = 0; attempt < 129; attempt += 1) {
      try {
        const unexpected = owner.acquireCommitted(invocationId);
        if (unexpected) {
          leases.push(unexpected.leaseId);
          owner.releaseReader(unexpected.leaseId);
          leases.pop();
        }
      } catch (error) {
        assert.match(String(error?.message || error), /COMMAND_TELEMETRY_COMMITTED_READ_NOT_ADMITTED/);
        deferred += 1;
      }
    }
    assert.equal(deferred, 129, "every direct acquire must defer while native reader closure is unresolved");
    assert.equal(fault.opens, 1, "direct acquire must apply reader admission before native open");
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 1);

    fault.recover();
    const recovered = owner.acquireCommitted(invocationId);
    leases.push(recovered.leaseId);
    assert.match(recovered.bytes.toString("utf8"), /ACQUIRE_COMMITTED/);
    owner.releaseReader(recovered.leaseId);
    leases.length = 0;
    assert.equal(fault.opens, 2);
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 0);
    assert.equal(owner.accounting().retainedReaderDescriptors, 0);
    assert.equal(owner.accounting().currentOutstandingBytes, 0);
    console.log(`MEASURE item3 committed-acquire-admission ${JSON.stringify({ attempts: 130, opens: fault.opens, deferred })}`);
  } finally {
    fault.recover();
    owner.reconcileFailedReaderDescriptors();
    for (const leaseId of leases) owner.releaseReader(leaseId);
    await owner.close();
    fault.restore();
    fault.closeOwned();
  }
}

async function shutdownRetryReconcilesOwnedReader() {
  const caseRoot = path.join(TEMP_ROOT, "shutdown");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const invocationId = "4".repeat(24);
  const owner = new CommandTelemetryOwner({ commandRoot: path.join(caseRoot, "command"), evidenceDirectory, commandId: "committed-shutdown" });
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  const fault = installReadCloseFault(evidenceDirectory);
  try {
    await owner.start();
    await client.connect();
    await client.publish({ type: "invocation_terminal", invocationId, outcome: "succeeded", marker: "SHUTDOWN_COMMITTED" }, "terminal");
    assert.equal(owner.drainEvents().some((event) => event.marker === "SHUTDOWN_COMMITTED"), true);
    assert.equal(fault.opens, 1);
    assert.equal(owner.accounting().retainedReaderDescriptors, 1);

    const concurrent = await Promise.allSettled([owner.close(), owner.close()]);
    assert.equal(concurrent[0].status, "rejected");
    assert.equal(concurrent[1].status, "rejected", "concurrent close must not falsely report settlement");
    assert.match(String(concurrent[0].reason?.message || concurrent[0].reason), /COMMAND_TELEMETRY_READER_DESCRIPTOR_STILL_OWNED/);
    assert.match(String(concurrent[1].reason?.message || concurrent[1].reason), /COMMAND_TELEMETRY_READER_DESCRIPTOR_STILL_OWNED/);
    assert.equal(owner.closed, true, "failed settlement must still close admission");
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 1);
    assert.equal(owner.reserveHostWork("__command__", "ordinary", 1), undefined,
      "failed settlement must not reopen direct host admission");
    assert.equal(owner.commitHostEvidence("5".repeat(24), {
      type: "invocation_terminal", outcome: "succeeded", marker: "MUST_NOT_ADMIT_AFTER_CLOSE",
    }), false, "failed settlement must not admit new publication work");
    await assert.rejects(owner.start(), /COMMAND_TELEMETRY_OWNER_CLOSED/,
      "failed settlement must not restart the private owner endpoint");

    fault.recover();
    await owner.close();
    await owner.close();
    const settled = owner.accounting();
    assert.equal([...fault.descriptors].filter(descriptorIsOpen).length, 0);
    assert.equal(settled.retainedReaderDescriptors, 0);
    assert.equal(settled.currentOutstandingBytes, 0);
    console.log(`MEASURE item3 shutdown-reader-recovery ${JSON.stringify({ first: concurrent.map((result) => result.status), retained: settled.retainedReaderDescriptors, outstanding: settled.currentOutstandingBytes })}`);
  } finally {
    fault.recover();
    owner.reconcileFailedReaderDescriptors();
    await client.close();
    await owner.close();
    fault.restore();
    fault.closeOwned();
  }
}

(async () => {
  try {
    const selected = process.argv[2];
    if (!selected || selected === "drain") await committedDrainDefersWithoutReopening();
    if (!selected || selected === "acquire") await directAcquireDefersWithoutReopening();
    if (!selected || selected === "shutdown") await shutdownRetryReconcilesOwnedReader();
    if (selected && !["drain", "acquire", "shutdown"].includes(selected)) {
      throw new Error("COMMITTED_READER_TEST_SELECTOR_INVALID");
    }
    passed = true;
    console.log(`PASS item3 committed-reader admission and shutdown settlement${selected ? ` ${selected}` : ""}`);
  } finally {
    fs.openSync = native.openSync;
    fs.closeSync = native.closeSync;
    if (passed) fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    else console.log(`PRESERVED_FAILURE_ROOT ${TEMP_ROOT}`);
  }
})().catch((error) => {
  console.error(error);
  throw error;
});
