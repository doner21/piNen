#!/usr/bin/env node
"use strict";
/** Item 3 / run 11 focused regression: the owner's fixed registration-refusal
 * slot must stay a single slot in-process, not merely a hope that Node's
 * server.maxConnections wins a timing race against a burst of real sockets
 * (see run 10 report.json defectsFound[0]: peakAcceptedSockets 202 > 201,
 * trackedConnections 200, under tests/test-2026-09-23-single-owner.cjs's
 * refusalResponseOwnershipBound). This drives the owner's real accept() path
 * directly for two sockets arriving beyond the 200-registration bound while
 * the first refusal response is still outstanding: deterministic and finite,
 * no real network burst, no timers, no sleeps, no retries. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CommandTelemetryOwner } = require("../src/command-telemetry-owner.cjs");

const TEMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-refusal-slot-")));

function makeTrackedConnection() {
  // Only accept()'s capacity check (`this.connections.size`) and close()'s
  // settlement loop (`connection.socket.end()`) ever touch these once the
  // test clears `owner.connections` in its own `finally`, so a minimal stub
  // is sufficient; no real socket or registration handshake is exercised.
  return { socket: { destroyed: false, writableLength: 0, end() {} }, invocationId: undefined,
    pending: undefined, registered: false, closed: false };
}

function makeRefusalSocket() {
  // Mirrors exactly what CommandTelemetryOwner#rejectAcceptedSocket uses on a
  // real net.Socket: `once("close", ...)` registration and an `end(bytes, cb)`
  // call. The callback is deliberately never invoked, so this refusal socket
  // stays outstanding (never closes) for the whole case, the same way a real
  // socket stays outstanding until its peer, or the kernel, finishes the
  // half-close -- which is exactly the window the defect lives in.
  const closeListeners = [];
  return {
    destroyed: false,
    once(event, listener) { if (event === "close") closeListeners.push(listener); },
    on() {},
    end() {},
    destroy() {},
  };
}

async function refusalSlotStaysSingleUnderDirectAccept() {
  const caseRoot = path.join(TEMP_ROOT, "refusal-slot-single-ownership");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "refusal-slot-single-ownership-command",
  });
  try {
    // Reach the 200-registration bound without any real sockets or
    // registration handshake: accept()'s capacity check only reads
    // `this.connections.size`.
    for (let index = 0; index < 200; index += 1) owner.connections.add(makeTrackedConnection());
    assert.equal(owner.connections.size, 200);

    const first = makeRefusalSocket();
    const second = makeRefusalSocket();
    // Drive the real, unmodified accept() path directly for two sockets that
    // arrive beyond the tracked bound. The first takes the refusal branch and
    // stays outstanding (its `end` callback never fires, so it never reaches
    // the `close` event that would remove it from `owner.refusedConnections`).
    // The second then arrives while that one refusal slot is still held.
    owner.accept(first);
    owner.accept(second);

    console.log(`MEASURE item3 refusal-slot-single-ownership refusedConnections=${owner.refusedConnections.size} `
      + `maxRefusedConnections=${owner.maxRefusedConnections} trackedConnections=${owner.connections.size}`);
    assert.ok(owner.refusedConnections.size <= 1,
      "the owner holds exactly one fixed refusal-response slot; a second socket beyond the tracked "
      + "set must be destroyed in-process rather than held as a second outstanding refusal");
    assert.ok(owner.maxRefusedConnections <= 1,
      "the refusal-response slot's own high-water mark must never exceed its single fixed slot");
  } finally {
    owner.connections.clear();
    owner.refusedConnections.clear();
    await owner.close();
  }
}

(async () => {
  try {
    await refusalSlotStaysSingleUnderDirectAccept();
    console.log("PASS item3 refusal-response slot stays single under direct accept()");
  } finally {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
