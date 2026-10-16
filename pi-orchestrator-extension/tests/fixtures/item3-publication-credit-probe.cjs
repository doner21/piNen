#!/usr/bin/env node
/** Finite production-method probes for reservation-read credits and replacement failure. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-publication-probe-"));
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

const originalReadFileSync = fs.readFileSync;
const originalRenameSync = fs.renameSync;
let trackReservationReads = false;
let reservationReadBytes = 0;
let deniedTarget = "";
let denyRename = false;
let previousVisibleAtDeniedRename = false;
fs.readFileSync = function instrumentedRead(file, ...args) {
  const value = originalReadFileSync.call(this, file, ...args);
  if (trackReservationReads && String(file).includes(".reservation.")) {
    reservationReadBytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
  }
  return value;
};
fs.renameSync = function instrumentedRename(from, to) {
  if (denyRename && path.resolve(String(to)) === deniedTarget) {
    previousVisibleAtDeniedRename = fs.existsSync(to);
    const error = new Error("finite injected publication rename failure");
    error.code = "EACCES";
    throw error;
  }
  return originalRenameSync.call(this, from, to);
};

try {
  const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
  process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter);
  Module._initPaths();
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const monitor = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
  const { FixtureSegmentProducer } = require("./item3-segment-producer.cjs");
  const mode = process.argv[2];
  const eventDir = path.join(TEMP_ROOT, "events");
  fs.mkdirSync(eventDir);

  if (mode === "metadata") {
    const artifact = path.join(TEMP_ROOT, "artifact.bin");
    fs.writeFileSync(artifact, Buffer.alloc(256 * 1024, 1));

    const supervisorBudget = new monitor.SharedReadBudget();
    const supervisorReader = new monitor.EventReader(eventDir, supervisorBudget);
    supervisorBudget.beginCycle();
    assert.equal(supervisorReader.readFileWithinCycle(artifact, 256 * 1024, "artifact").length, 256 * 1024);
    reservationReadBytes = 0; trackReservationReads = true;
    const transport = new FixtureSegmentProducer(eventDir, "supervisor-invocation", "command", "a".repeat(64));
    transport.publish({ type: "finite-metadata-probe" });
    trackReservationReads = false;
    const supervisorCombined = 256 * 1024 + reservationReadBytes;
    assert.ok(supervisorCombined <= 256 * 1024,
      `supervisor reservation metadata bypassed shared credits: ${supervisorCombined}`);

    for (const name of fs.readdirSync(eventDir)) fs.rmSync(path.join(eventDir, name), { force: true });
    const hostBudget = new monitor.SharedReadBudget();
    const hostReader = new monitor.EventReader(eventDir, hostBudget);
    hostBudget.beginCycle();
    assert.equal(hostReader.readFileWithinCycle(artifact, 256 * 1024, "artifact").length, 256 * 1024);
    const service = new monitor.WindowsIoCounterService(eventDir, "b".repeat(64), "command", hostBudget);
    const state = { invocationId: "host-invocation", bindingGeneration: "c".repeat(32), transportGeneration: 0 };
    reservationReadBytes = 0; trackReservationReads = true;
    service.writeState("d".repeat(32), state, { type: "counter_sample", marker: "HOST" });
    trackReservationReads = false;
    const hostCombined = 256 * 1024 + reservationReadBytes;
    assert.ok(hostCombined <= 256 * 1024,
      `host reservation metadata bypassed shared credits: ${hostCombined}`);
    console.log(JSON.stringify({ supervisorCombined, hostCombined, reservationReadBytes }));
  } else if (mode === "replacement") {
    const transport = new FixtureSegmentProducer(eventDir, "invocation", "command", "e".repeat(64));
    transport.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "ORIGINAL" }, "terminal");
    const terminal = path.join(eventDir, "invocation.terminal.json");
    const originalTerminal = fs.readFileSync(terminal, "utf8");
    deniedTarget = path.resolve(terminal); previousVisibleAtDeniedRename = false; denyRename = true;
    assert.throws(() => transport.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "NEW" }, "terminal"), /finite injected publication rename failure/);
    denyRename = false;
    assert.equal(previousVisibleAtDeniedRename, true, "concurrent reader must retain the previous terminal until replacement commits");
    assert.equal(fs.readFileSync(terminal, "utf8"), originalTerminal,
      "failed terminal replacement must retain the previous valid generation");

    assert.equal(fs.readdirSync(eventDir).some((name) => name.includes("counter") || name.includes("mailbox")), false,
      "single-owner counter delivery must not create an independent filesystem publication path");
    assert.equal(fs.readdirSync(eventDir).filter((name) => name.endsWith(".tmp")).length, 0);
    console.log(JSON.stringify({ terminalRetained: true, independentCounterPathAbsent: true }));
  } else {
    throw new Error(`unknown probe mode ${String(mode)}`);
  }
} finally {
  fs.readFileSync = originalReadFileSync;
  fs.renameSync = originalRenameSync;
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
}
