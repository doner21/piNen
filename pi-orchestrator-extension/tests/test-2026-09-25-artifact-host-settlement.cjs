#!/usr/bin/env node
/** Finite production-seam regression for capture work after terminal transport refusal. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-host-settlement-"));
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

// Product code is imported only after all mutable roots are isolated.
const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const monitor = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
const { CommandTelemetryOwner, CommandTelemetryClient, FrameDecoder } = require("../src/command-telemetry-owner.cjs");

function coalescedLegalFramesRespectSharedQueue() {
  const frames = [];
  const errors = [];
  let retainedBytes = 0;
  let maxRetainedBytes = 0;
  const decoder = new FrameDecoder(
    (frame) => frames.push(frame),
    (error) => errors.push(error),
    () => 256 * 1024,
    (bytes) => {
      if (retainedBytes + bytes > 64 * 1024) return false;
      retainedBytes += bytes;
      maxRetainedBytes = Math.max(maxRetainedBytes, retainedBytes);
      return true;
    },
    (bytes) => { retainedBytes -= bytes; },
  );
  const encoded = Buffer.concat(Array.from({ length: 7 }, (_, index) => Buffer.from(`${JSON.stringify({
    kind: "payload_chunk",
    opId: "f".repeat(32),
    channel: "terminal",
    data: "A".repeat(10_000),
    final: index === 6,
  })}\n`)));
  assert.ok(encoded.length > 64 * 1024, "fixture must reproduce one coalesced delivery above the shared queue bound");
  decoder.push(encoded);
  decoder.finish();
  assert.deepEqual(errors, [],
    "coalescing separately bounded frames must not turn legal terminal publication into a queue refusal");
  assert.equal(frames.length, 7);
  assert.equal(retainedBytes, 0);
  assert.ok(maxRetainedBytes < 64 * 1024,
    "the decoder must still reserve every retained byte before buffering it");

  const splitFrames = [];
  const splitErrors = [];
  let splitRetained = 0;
  const splitDecoder = new FrameDecoder(
    (frame) => splitFrames.push(frame),
    (error) => splitErrors.push(error),
    () => 256 * 1024,
    (bytes) => {
      if (splitRetained + bytes > 64 * 1024) return false;
      splitRetained += bytes;
      return true;
    },
    (bytes) => { splitRetained -= bytes; },
  );
  const splitFrame = Buffer.from(`${JSON.stringify({ kind: "split_frame", marker: "SPLIT_PARTIAL_PRESERVED" })}\n`);
  splitDecoder.push(splitFrame.subarray(0, 7));
  assert.equal(splitRetained, 7, "an incomplete frame remains charged between network deliveries");
  splitDecoder.push(splitFrame.subarray(7));
  splitDecoder.finish();
  assert.deepEqual(splitErrors, []);
  assert.equal(splitFrames[0]?.marker, "SPLIT_PARTIAL_PRESERVED");
  assert.equal(splitRetained, 0);
  console.log(`PASS item3 coalesced and split legal frames decode within shared queue maxRetainedBytes=${maxRetainedBytes}`);
}

async function terminalRefusalSettlesHostCaptureQueue() {
  const caseRoot = path.join(TEMP_ROOT, "terminal-refusal");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const workspace = path.join(caseRoot, "workspace");
  const output = path.join(workspace, "artifact.log");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(output, "COMMITTED_CAPTURE_MARKER\n");
  const parent = fs.lstatSync(workspace, { bigint: true });
  const captureRequest = {
    type: "declared_file_capture_request",
    workspaceRealPath: fs.realpathSync(workspace),
    specs: [{
      path: output,
      parentRealPath: fs.realpathSync(workspace),
      parentDevice: parent.dev.toString(),
      parentInode: parent.ino.toString(),
    }],
    maxTotalBytes: 64 * 1024,
  };

  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory,
    commandId: "artifact-host-terminal-refusal",
  });
  const refusedInvocation = "c".repeat(24);
  const healthyInvocation = "d".repeat(24);
  const refused = new CommandTelemetryClient(owner.configuration(), refusedInvocation);
  const healthy = new CommandTelemetryClient(owner.configuration(), healthyInvocation);
  const queue = new monitor.HostCaptureSettlementQueue((invocationId) => owner.invocationProducerState(invocationId));
  const readBudget = new monitor.SharedReadBudget(256 * 1024, owner);
  const reader = new monitor.EventReader(evidenceDirectory, readBudget);
  const capture = (job) => {
    readBudget.beginCycle();
    const result = monitor.captureSettledFilesWithSharedCredits(
      job.specs, job.workspaceRealPath, reader, job.maxTotalBytes,
    );
    readBudget.finalizeCycle();
    return result;
  };
  const commit = (invocationId, terminal) => owner.commitHostEvidence(invocationId, terminal);

  try {
    await owner.start();
    await refused.connect();
    await refused.publish({ ...captureRequest, invocationId: refusedInvocation });
    for (const event of owner.drainEvents()) {
      if (event.type === "declared_file_capture_request") queue.addRequest(event);
    }
    assert.deepEqual(queue.pendingInvocationIds(), [refusedInvocation]);
    assert.equal(queue.settleNext(capture, commit), undefined,
      "capture remains deferred while its authenticated producer can still publish a terminal");

    // Keep a real durable generation that terminal-loss settlement must not erase.
    assert.equal(owner.commitHostEvidence(refusedInvocation, {
      type: "prior_host_evidence",
      invocationId: refusedInvocation,
      marker: "PRIOR_COMMITTED_EVIDENCE",
    }), true);

    const refusal = new Promise((resolve) => refused.once("transportError", resolve));
    const socketClosed = refused.socket.destroyed
      ? Promise.resolve()
      : new Promise((resolve) => refused.socket.once("close", resolve));
    refused.socket.write(Buffer.concat([Buffer.alloc(70_000, 1), Buffer.from("\n")]));
    const refusalError = await refusal;
    await socketClosed;
    assert.match(String(refusalError?.message || refusalError), /COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND/,
      "the real owner must refuse the observed oversize line before host settlement");

    // A separate healthy invocation reaches the same production queue behind
    // the refused one. Its progress proves the repair does not merely empty all work.
    await healthy.connect();
    await healthy.publish({ ...captureRequest, invocationId: healthyInvocation, specs: [] });
    await healthy.publish({
      type: "invocation_terminal",
      invocationId: healthyInvocation,
      outcome: "succeeded",
      declaredFileCapture: { status: "host_capture_requested", results: [] },
      marker: "HEALTHY_TERMINAL_AFTER_REFUSAL",
    }, "terminal");
    for (const event of owner.drainEvents()) {
      if (event.type === "declared_file_capture_request") queue.addRequest(event);
      if (event.type === "invocation_terminal") queue.addTerminal(event);
    }

    const refusedSettlement = queue.settleNext(capture, commit);
    assert.equal(refusedSettlement?.kind, "unavailable",
      "a closed authenticated producer cannot leave accepted capture work waiting forever for an impossible terminal");
    assert.equal(refusedSettlement.invocationId, refusedInvocation);
    assert.equal(refusedSettlement.reason, "COMMAND_TELEMETRY_TERMINAL_UNAVAILABLE_AFTER_PRODUCER_CLOSE");
    assert.match(JSON.stringify(refusedSettlement.capture), /COMMITTED_CAPTURE_MARKER/,
      "already captured evidence remains available when terminal publication is unavailable");

    const prior = owner.acquireCommitted(refusedInvocation);
    assert.ok(prior, "prior durable evidence must remain owned after missing-terminal settlement");
    assert.match(prior.bytes.toString("utf8"), /PRIOR_COMMITTED_EVIDENCE/);
    owner.releaseReader(prior.leaseId);

    const healthySettlement = queue.settleNext(capture, commit);
    assert.equal(healthySettlement?.kind, "terminal");
    assert.equal(healthySettlement.invocationId, healthyInvocation);
    assert.equal(healthySettlement.terminal.marker, "HEALTHY_TERMINAL_AFTER_REFUSAL");
    assert.deepEqual(queue.pendingInvocationIds(), []);

    const durableHealthy = owner.acquireCommitted(healthyInvocation);
    assert.ok(durableHealthy, "healthy terminal must remain durably consumable");
    assert.match(durableHealthy.bytes.toString("utf8"), /HEALTHY_TERMINAL_AFTER_REFUSAL/);
    owner.releaseReader(durableHealthy.leaseId);
    console.log("PASS item3 refused terminal settles host capture as unavailable while preserving evidence and healthy progress");
  } finally {
    await Promise.allSettled([refused.close(), healthy.close()]);
    await owner.close();
  }
}

async function legalLargeTerminalPublicationSettles() {
  const caseRoot = path.join(TEMP_ROOT, "legal-large-terminal");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "legal-large-terminal-publication",
  });
  const invocationId = "e".repeat(24);
  const client = new CommandTelemetryClient(owner.configuration(), invocationId);
  try {
    await owner.start();
    await client.connect();
    const terminal = {
      type: "invocation_terminal",
      invocationId,
      outcome: "cancelled_no_output",
      marker: "LEGAL_LARGE_TERMINAL_MARKER",
      payload: "",
    };
    const targetBytes = 100_672;
    const fixedBytes = Buffer.byteLength(JSON.stringify(terminal), "utf8") + 1;
    terminal.payload = "L".repeat(targetBytes - fixedBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(terminal), "utf8") + 1, targetBytes);
    const receipt = await client.publish(terminal, "terminal");
    assert.equal(receipt.accepted, true,
      "a legal terminal near the observed supervisor size must publish through the existing bounded transport");
    const drained = owner.drainEvents();
    assert.equal(drained.some((event) => event.marker === "LEGAL_LARGE_TERMINAL_MARKER"), true);
    console.log("PASS item3 legal near-capacity terminal publishes and settles through the real owner/client transport");
  } finally {
    await client.close();
    await owner.close();
  }
}

let succeeded = false;
(async () => {
  coalescedLegalFramesRespectSharedQueue();
  await terminalRefusalSettlesHostCaptureQueue();
  await legalLargeTerminalPublicationSettles();
  succeeded = true;
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  if (succeeded && (process.exitCode === undefined || process.exitCode === 0)) {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } else {
    console.error(`ITEM3_HOST_SETTLEMENT_FAILURE_ROOT=${TEMP_ROOT}`);
  }
});
