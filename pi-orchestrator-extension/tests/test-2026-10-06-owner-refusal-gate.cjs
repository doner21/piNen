#!/usr/bin/env node
"use strict";
/** Item 3 / run 12 focused regression (review 27 / run-11 final review finding 1).
 * tests/test-2026-09-23-single-owner.cjs refusalResponseOwnershipBound wraps
 * owner.accept(): it counts a socket BEFORE calling the real accept() and
 * uncounts it only on that socket's own 'close' event. The owner removes a
 * tracked connection (settleConnection) and a refused one
 * (rejectAcceptedSocket's close listener) on that same 'close' event. Node's
 * server._connections counter can already drop below server.maxConnections
 * at the moment the owner destroys a refused socket -- synchronously inside
 * that destroy() call -- well before that socket's JS 'close' event fires.
 * In that window Node can hand a brand-new socket to the 'connection'
 * listener (owner.accept()) while the owner still holds the first refusal
 * outstanding, so the single-owner wrapper's peak can reach 202 even though
 * the owner itself never holds more than one refusal at a time.
 *
 * This drives a REAL net server (no stubs) through exactly that window:
 * 200 real tracked connections, one real connection that takes the single
 * refusal slot, and a hook on that refused socket's own destroy() that
 * synchronously opens one more real connection at the precise moment Node's
 * native admission gate is most likely still open. Finite and offline: a
 * fixed 200 tracked sockets, a fixed single probe socket, and a bounded
 * setImmediate poll (the same pattern tests/test-2026-09-23-single-owner.cjs
 * and tests/test-2026-09-21-no-output-gate1.cjs already use) with a fixed
 * turn cap that throws rather than hangs. No timers, sleeps, deadlines or
 * retries are added. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { CommandTelemetryOwner } = require("../src/command-telemetry-owner.cjs");

const TEMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-refusal-gate-")));
const MAX_POLL_TURNS = 200000;

async function yieldUntil(predicate, label) {
  for (let turn = 0; turn < MAX_POLL_TURNS; turn += 1) {
    if (predicate()) return turn;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`CONDITION_NOT_REACHED_WITHIN_FINITE_TURNS ${label}`);
}

function installSingleOwnerWrapper(owner) {
  // Copied from tests/test-2026-09-23-single-owner.cjs refusalResponseOwnershipBound
  // (the exact counting the lean-set assertion relies on): count before the
  // real accept() runs, uncount only on that socket's own 'close'.
  const originalAccept = owner.accept;
  const state = { activeAcceptedSockets: 0, peakAcceptedSockets: 0 };
  owner.accept = function observedAcceptedSocket(socket) {
    state.activeAcceptedSockets += 1;
    state.peakAcceptedSockets = Math.max(state.peakAcceptedSockets, state.activeAcceptedSockets);
    socket.once("close", () => { state.activeAcceptedSockets -= 1; });
    return originalAccept.call(this, socket);
  };
  return state;
}

async function noSocketReachesListenerWhileRefusalOutstanding() {
  const caseRoot = path.join(TEMP_ROOT, "refusal-gate-window");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "refusal-gate-window-command",
  });
  const wrapper = installSingleOwnerWrapper(owner);
  const trackedSockets = [];
  let refusedSocket;
  let refusedCloseFired = false;
  let probeSocket;
  let probeOutcome; // "connected-before-refusal-close" | "connected-after-refusal-close" | "refused"
  try {
    await owner.start();
    for (let index = 0; index < 200; index += 1) {
      const socket = net.createConnection(owner.endpoint);
      trackedSockets.push(socket);
    }
    await yieldUntil(() => owner.connections.size === 200, "tracked-200");

    const refusalClient = net.createConnection(owner.endpoint);
    refusalClient.on("error", () => {});
    refusalClient.on("data", () => {});
    await yieldUntil(() => owner.refusedConnections.size === 1, "first-refusal-outstanding");
    for (const socket of owner.refusedConnections) refusedSocket = socket;
    refusedSocket.once("close", () => { refusedCloseFired = true; });

    // Hook the refused socket's own destroy() -- the exact native-timing
    // window review 27 witnessed -- and, synchronously inside it, open one
    // more real connection using the owner's own existing endpoint. No new
    // mechanism: this only observes what Node already hands to accept().
    const originalDestroy = refusedSocket.destroy;
    refusedSocket.destroy = function observedDestroy(...args) {
      const value = originalDestroy.apply(this, args);
      if (!probeSocket) {
        probeSocket = net.createConnection(owner.endpoint);
        probeSocket.on("error", () => { if (probeOutcome === undefined) probeOutcome = "refused"; });
        probeSocket.once("connect", () => {
          probeOutcome = refusedCloseFired ? "connected-after-refusal-close" : "connected-before-refusal-close";
        });
      }
      return value;
    };

    await yieldUntil(() => refusedCloseFired, "refused-socket-close");
    await yieldUntil(() => probeOutcome !== undefined, "probe-outcome-settled");
    // Give the wrapper's own 'close' bookkeeping a chance to run for every
    // socket that did reach accept(), the same bounded yield the single-owner
    // test itself uses after its burst, before reading the peak.
    await new Promise((resolve) => setImmediate(resolve));

    console.log(`MEASURE item3 refusal-gate-window peakAcceptedSockets=${wrapper.peakAcceptedSockets} `
      + `probeOutcome=${probeOutcome} refusedConnections=${owner.refusedConnections.size} `
      + `maxRefusedConnections=${owner.maxRefusedConnections} trackedConnections=${owner.connections.size}`);
    // `probeOutcome` (logged above for diagnostic trail) reflects only the
    // OS-level TCP handshake the client observed, which can complete before
    // the server application layer ever hands the socket to `accept()`; it
    // is not itself proof that the probe reached the owner's listener. The
    // single-owner-counted peak below is: it increments only inside the
    // wrapped `accept()`, so it is the exact proxy for "reached the
    // listener" that tests/test-2026-09-23-single-owner.cjs itself relies on.
    assert.ok(wrapper.peakAcceptedSockets <= 201,
      "raw registration refusal responses must have one fixed owner slot rather than an unbounded set outside "
      + "tracked connections, counted the same way tests/test-2026-09-23-single-owner.cjs counts it");
  } finally {
    await Promise.all([...trackedSockets, probeSocket].map(async (socket) => {
      if (!socket || socket.destroyed) return;
      socket.resume();
      const closed = new Promise((resolve) => socket.once("close", resolve));
      socket.end();
      await closed;
    }));
    await owner.close();
  }
}

(async () => {
  try {
    await noSocketReachesListenerWhileRefusalOutstanding();
    console.log("PASS item3 no socket reaches the owner's listener while a refusal is outstanding");
  } finally {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
