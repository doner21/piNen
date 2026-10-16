"use strict";

/** Filesystem segment producer used only to exercise the legacy EventReader test seam. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sign(value, key) {
  const copy = { ...value }; delete copy.auth;
  return crypto.createHmac("sha256", key).update(JSON.stringify(copy)).digest("hex");
}
function writeAtomic(file, bytes) {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

class FixtureSegmentProducer {
  constructor(directory, invocationId, commandId, authKey) {
    this.directory = directory; this.invocationId = invocationId; this.commandId = commandId; this.authKey = authKey;
    this.sequence = 0; this.segmentGeneration = 0; this.segmentBytes = 0; this.controlGeneration = 0; this.controlBytes = 0;
    this.cumulativeBytes = 0; this.peakBytes = 0; this.peakFiles = 0; this.peakReservedBytes = 0;
    this.peakEventBytes = 0; this.peakControlBytes = 0; this.peakTerminalBytes = 0;
    fs.mkdirSync(directory, { recursive: true });
  }
  publish(payload, channel = "ordinary") {
    const event = { schemaVersion: 1, commandId: this.commandId, invocationId: this.invocationId, sequence: ++this.sequence, wallTime: new Date().toISOString(), ...payload };
    event.auth = sign(event, this.authKey);
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (channel === "terminal") {
      this.sealCurrent(); this.sealControl();
      this.reserveAndWrite("terminal", bytes.length, bytes.length, () => writeAtomic(path.join(this.directory, `${this.invocationId}.terminal.json`), bytes));
    } else if (channel === "control") {
      if (bytes.length > 4096) throw new Error("CONTROL_FRAME_EXCEEDS_4_KIB");
      if (this.controlBytes + bytes.length > 8 * 1024) { this.sealControl(); this.controlGeneration += 1; this.controlBytes = 0; }
      if (this.liveControlFiles() >= 8 && !fs.existsSync(this.controlPath())) throw new Error("CONTROL_TRANSPORT_BACKPRESSURE_CAPACITY_EXHAUSTED");
      const nextSize = this.controlBytes + bytes.length;
      const sealBytes = Buffer.byteLength(`${nextSize}\n`, "utf8");
      this.reserveAndWrite("control", bytes.length, bytes.length + sealBytes, () => fs.appendFileSync(this.controlPath(), bytes, { mode: 0o600 }));
      this.controlBytes = nextSize;
    } else {
      if (bytes.length > 64 * 1024) throw new Error("ORDINARY_EVENT_FRAME_EXCEEDS_SEGMENT");
      if (this.segmentBytes + bytes.length > 64 * 1024) { this.sealCurrent(); this.segmentGeneration += 1; this.segmentBytes = 0; }
      if (this.liveOrdinaryFiles() >= 8 && !fs.existsSync(this.segmentPath())) throw new Error("ORDINARY_EVENT_BACKPRESSURE_CAPACITY_EXHAUSTED");
      const nextSize = this.segmentBytes + bytes.length;
      const sealBytes = Buffer.byteLength(`${nextSize}\n`, "utf8");
      this.reserveAndWrite("ordinary", bytes.length, bytes.length + sealBytes, () => fs.appendFileSync(this.segmentPath(), bytes, { mode: 0o600 }));
      this.segmentBytes = nextSize;
    }
    this.cumulativeBytes += bytes.length;
    this.updatePeak();
    return event;
  }
  sealControl() { this.writeSeal("control", this.controlPath(), this.controlBytes); }
  sealCurrent() { this.writeSeal("ordinary", this.segmentPath(), this.segmentBytes); }
  writeSeal(channel, file, dataBytes) {
    if (dataBytes <= 0 || !fs.existsSync(file) || fs.existsSync(`${file}.sealed`)) return;
    const seal = Buffer.from(`${dataBytes}\n`, "utf8");
    this.reserveAndWrite(channel, seal.length, seal.length, () => writeAtomic(`${file}.sealed`, seal));
  }
  reserveAndWrite(channel, stagingBytes, diskGrowthBytes, write) {
    const limits = { ordinary: 512 * 1024, control: 64 * 1024, terminal: 256 * 1024 };
    const channelPeak = this.channelBytes(channel) + stagingBytes + diskGrowthBytes;
    const aggregatePeak = this.invocationDiskBytes() + stagingBytes + diskGrowthBytes;
    const filesPeak = this.ownNames().length + 1;
    if (channelPeak > limits[channel]) throw new Error(`${String(channel).toUpperCase()}_TELEMETRY_CAPACITY_EXHAUSTED`);
    if (aggregatePeak > 1024 * 1024) throw new Error("INVOCATION_TRANSPORT_CAPACITY_EXHAUSTED");
    if (filesPeak > 128) throw new Error("INVOCATION_TELEMETRY_FILE_CAPACITY_EXHAUSTED");
    this.peakReservedBytes = Math.max(this.peakReservedBytes, aggregatePeak);
    this.peakFiles = Math.max(this.peakFiles, filesPeak);
    if (channel === "ordinary") this.peakEventBytes = Math.max(this.peakEventBytes, channelPeak);
    if (channel === "control") this.peakControlBytes = Math.max(this.peakControlBytes, channelPeak);
    if (channel === "terminal") this.peakTerminalBytes = Math.max(this.peakTerminalBytes, channelPeak);
    return write();
  }
  stats() {
    this.updatePeak();
    return {
      cumulativeBytes: this.cumulativeBytes, peakBytes: this.peakBytes, peakFiles: this.peakFiles,
      peakReservedBytes: this.peakReservedBytes, peakEventBytes: this.peakEventBytes,
      peakControlBytes: this.peakControlBytes, peakTerminalBytes: this.peakTerminalBytes,
    };
  }
  segmentPath() { return path.join(this.directory, `${this.invocationId}.events.${this.segmentGeneration}.jsonl`); }
  controlPath() { return path.join(this.directory, `${this.invocationId}.controls.${this.controlGeneration}.jsonl`); }
  ownNames() { return fs.readdirSync(this.directory).filter((name) => name.startsWith(`${this.invocationId}.`)); }
  liveOrdinaryFiles() { return this.ownNames().filter((name) => name.startsWith(`${this.invocationId}.events.`) && name.endsWith(".jsonl")).length; }
  liveControlFiles() { return this.ownNames().filter((name) => name.startsWith(`${this.invocationId}.controls.`) && name.endsWith(".jsonl")).length; }
  invocationDiskBytes() { return this.ownNames().reduce((sum, name) => { try { return sum + fs.statSync(path.join(this.directory, name)).size; } catch { return sum; } }, 0); }
  channelBytes(channel) {
    const matcher = channel === "ordinary" ? ".events." : channel === "control" ? ".controls." : ".terminal.json";
    return this.ownNames().filter((name) => name.includes(matcher)).reduce((sum, name) => { try { return sum + fs.statSync(path.join(this.directory, name)).size; } catch { return sum; } }, 0);
  }
  updatePeak() {
    const names = this.ownNames(); const bytes = this.invocationDiskBytes();
    this.peakBytes = Math.max(this.peakBytes, bytes); this.peakFiles = Math.max(this.peakFiles, names.length);
    this.peakEventBytes = Math.max(this.peakEventBytes, this.channelBytes("ordinary"));
    this.peakControlBytes = Math.max(this.peakControlBytes, this.channelBytes("control"));
    this.peakTerminalBytes = Math.max(this.peakTerminalBytes, this.channelBytes("terminal"));
    if (bytes > 1024 * 1024) throw new Error("INVOCATION_ORDINARY_TELEMETRY_EXCEEDS_1_MIB");
  }
}

module.exports = { FixtureSegmentProducer };
