"use strict";

/**
 * One command-scoped owner for telemetry admission, transport, publication and
 * retirement. Helpers can propose bounded work; only this owner grants and
 * commits it. The private pipe is intentionally command-specific, not a
 * reusable broker or service.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const LIMITS = Object.freeze({
  cycle: 256 * 1024,
  queue: 64 * 1024,
  files: 128,
  registrations: 200,
  frame: 256 * 1024,
  counter: 16 * 1024,
  ordinary: 512 * 1024,
  control: 64 * 1024,
  terminal: 256 * 1024,
  aggregatePerInvocation: 1024 * 1024,
  controlHeadroom: 16 * 1024,
});
const TERMINAL_DELIVERY_DESCRIPTOR_BYTES = 256;
const REGISTRATION_FRAME_BYTES = 4 * 1024;
const NON_TERMINAL_EVENT_QUEUE_LIMIT = LIMITS.queue - 16 * 1024;
const CHANNEL_LIMITS = Object.freeze({
  ordinary: LIMITS.ordinary,
  control: LIMITS.control,
  terminal: LIMITS.terminal,
  counter: LIMITS.counter,
});

function endpointFor(commandRoot, ownerId) {
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-orchestrator-${ownerId}`;
  return path.join(commandRoot, `telemetry-${ownerId}.sock`);
}
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), "utf8") + 1; }
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function encode(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > LIMITS.frame) throw new Error("COMMAND_TELEMETRY_FRAME_EXCEEDS_BOUND");
  return bytes;
}
function inspectPath(file) {
  try {
    const stat = fs.lstatSync(file);
    return { state: "present", bytes: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0 };
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "absent" : "unknown" };
  }
}
function removeConclusive(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
  // existsSync() collapses inaccessible metadata and genuine absence into the
  // same false result. Ownership can be released only after a metadata call
  // positively reports ENOENT; every other result remains owned.
  return inspectPath(file).state === "absent";
}
function safeUnlink(file) { removeConclusive(file); }

class FrameDecoder {
  constructor(
    onFrame,
    onError,
    maxFrameBytes = () => LIMITS.frame,
    reserveBufferedBytes = () => true,
    releaseBufferedBytes = () => {},
  ) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.maxFrameBytes = maxFrameBytes;
    this.reserveBufferedBytes = reserveBufferedBytes;
    this.releaseBufferedBytes = releaseBufferedBytes;
    this.remainder = Buffer.alloc(0);
    this.closed = false;
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    const retained = this.remainder.length;
    this.remainder = Buffer.alloc(0);
    if (retained > 0) this.releaseBufferedBytes(retained);
    this.onError(error);
  }
  push(chunk) {
    if (this.closed) return;
    const incoming = Buffer.from(chunk);
    let offset = 0;
    while (offset < incoming.length && !this.closed) {
      const newline = incoming.indexOf(10, offset);
      const end = newline < 0 ? incoming.length : newline + 1;
      const segment = incoming.subarray(offset, end);
      if (!this.reserveBufferedBytes(segment.length)) {
        this.fail(new Error("COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND"));
        return;
      }
      try { this.remainder = Buffer.concat([this.remainder, segment]); }
      catch (error) {
        this.releaseBufferedBytes(segment.length);
        this.fail(error);
        return;
      }
      if (newline < 0) {
        if (this.remainder.length > this.maxFrameBytes()) this.fail(new Error("COMMAND_TELEMETRY_FRAME_EXCEEDS_BOUND"));
        return;
      }
      if (this.remainder.length > this.maxFrameBytes()) {
        this.fail(new Error("COMMAND_TELEMETRY_FRAME_EXCEEDS_BOUND"));
        return;
      }
      const consumed = this.remainder.length;
      const line = this.remainder.toString("utf8", 0, consumed - 1);
      this.remainder = Buffer.alloc(0);
      this.releaseBufferedBytes(consumed);
      if (line.length) {
        try { this.onFrame(JSON.parse(line)); }
        catch { this.fail(new Error("COMMAND_TELEMETRY_FRAME_INVALID")); return; }
      }
      offset = end;
    }
  }
  finish() {
    if (this.closed) return;
    if (this.remainder.length) this.fail(new Error("COMMAND_TELEMETRY_FRAME_TRUNCATED"));
    else this.dispose();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    const retained = this.remainder.length;
    this.remainder = Buffer.alloc(0);
    if (retained > 0) this.releaseBufferedBytes(retained);
  }
}

class CommandTelemetryOwner {
  constructor({ commandRoot, evidenceDirectory, commandId, onEvent, publicationHook } = {}) {
    if (!commandRoot || !evidenceDirectory || !commandId) throw new Error("COMMAND_TELEMETRY_OWNER_CONFIGURATION_INVALID");
    this.commandRoot = commandRoot;
    this.evidenceDirectory = evidenceDirectory;
    this.commandId = commandId;
    this.onEvent = typeof onEvent === "function" ? onEvent : undefined;
    this.publicationHook = typeof publicationHook === "function" ? publicationHook : undefined;
    this.ownerId = crypto.randomBytes(16).toString("hex");
    this.permission = crypto.randomBytes(32).toString("hex");
    this.endpoint = endpointFor(commandRoot, this.ownerId);
    this.server = undefined;
    this.connections = new Set();
    this.refusedConnections = new Set();
    this.maxRefusedConnections = 0;
    this.invocations = new Map();
    this.events = [];
    this.eventQueueBytes = 0;
    this.nonTerminalEventQueueBytes = 0;
    this.reservedEventQueueBytes = 0;
    this.reservedNonTerminalEventQueueBytes = 0;
    this.maxEventQueueBytes = 0;
    this.maxCombinedQueueBytes = 0;
    this.maxNativeWritableBytes = 0;
    this.bufferedFrameBytes = 0;
    this.maxBufferedFrameBytes = 0;
    this.generations = new Map();
    this.activeStages = new Map();
    this.failedStages = new Map();
    this.failedReaderDescriptors = new Map();
    this.lastReaderDescriptorFailure = undefined;
    this.deferredRequests = [];
    this.pumpingRequests = false;
    this.hostPermissions = new Map();
    this.outstandingBytes = 0;
    this.maxOutstandingBytes = 0;
    this.maxActualBytes = 0;
    this.maxSingleActualBytes = 0;
    this.currentActualBytes = 0;
    this.maxCombinedActualBytes = 0;
    this.cumulativeActualBytes = 0;
    this.failedRetainedBytes = 0;
    this.maxFailedRetainedBytes = 0;
    this.maxRetainedBytes = 0;
    this.maxRetainedFiles = 0;
    this.maxQueuedBytes = 0;
    this.maxRegistrations = 0;
    this.registrationDenials = 0;
    this.abandonedOperations = 0;
    this.completedOperations = 0;
    this.failedOperations = 0;
    this.terminalReadFailures = 0;
    this.lastTerminalReadFailure = undefined;
    this.observerCallbackFailures = 0;
    this.lastObserverCallbackFailure = undefined;
    // `closed` stops admission immediately. Resource settlement is separate:
    // a failed descriptor close keeps shutdown retryable until it is conclusive.
    this.closed = false;
    this.closeAttempt = undefined;
    this.closeSettled = false;
    fs.mkdirSync(commandRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    this.evidenceRealPath = fs.realpathSync(evidenceDirectory);
  }
  async start() {
    if (this.closed) throw new Error("COMMAND_TELEMETRY_OWNER_CLOSED");
    if (this.server) return;
    if (process.platform !== "win32") safeUnlink(this.endpoint);
    this.server = net.createServer((socket) => this.accept(socket));
    // One fixed control slot lets the owner return an authenticated capacity
    // refusal while the 200 monitoring slots are occupied. Node drops any
    // further accepts before allocating another user-space response socket.
    this.server.maxConnections = LIMITS.registrations + 1;
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server?.off("listening", onListening); reject(error); };
      const onListening = () => { this.server?.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.endpoint);
    });
  }
  configuration(parentInvocationId) {
    return Object.freeze({
      ownerId: this.ownerId,
      endpoint: this.endpoint,
      permission: this.permission,
      commandId: this.commandId,
      parentInvocationId,
    });
  }
  rejectAcceptedSocket(socket, response) {
    const refusalAlreadyOutstanding = this.refusedConnections.size > 0;
    this.refusedConnections.add(socket);
    this.maxRefusedConnections = Math.max(this.maxRefusedConnections, this.refusedConnections.size);
    if (!refusalAlreadyOutstanding && this.server) {
      // Node's own `server._connections` counter can already drop below
      // `server.maxConnections` the moment this socket's native handle is
      // destroyed below, well before this socket's JS `close` event fires
      // and removes it from `refusedConnections`. Left alone, that lets
      // Node hand a brand-new socket to `accept()` in that gap while this
      // refusal is still outstanding. Lock the native admission gate down
      // to exactly the owner's own current tracked count -- state the
      // owner already has, no new limit -- for as long as this refusal
      // stays outstanding; the `close` listener below restores the fixed
      // one-slot-beyond-tracked value the moment it is no longer needed.
      this.server.maxConnections = this.connections.size;
    }
    socket.once("close", () => {
      this.refusedConnections.delete(socket);
      if (this.refusedConnections.size === 0 && this.server) {
        this.server.maxConnections = LIMITS.registrations + 1;
      }
    });
    const bytes = response === undefined ? undefined : encode(response);
    socket.end(bytes, () => {
      // The response has left the bounded native queue. Do not wait for an
      // unregistered peer to half-close a socket it may never read.
      if (!socket.destroyed) socket.destroy();
    });
  }
  accept(socket) {
    if (this.closed || this.connections.size >= LIMITS.registrations) {
      if (!this.closed) {
        if (this.refusedConnections.size > 0) {
          // The owner holds exactly one fixed refusal-response slot (see
          // `start()`). A socket arriving beyond the tracked set while that
          // slot is already outstanding has no slot of its own: destroy it
          // in-process using state the owner already tracks, rather than
          // holding a second refusal response. This closes the native-timing
          // gap where `server.maxConnections` alone can lag a fast burst.
          socket.destroy();
          return;
        }
        this.registrationDenials += 1;
        this.rejectAcceptedSocket(socket, { kind: "registration", accepted: false, reason: "monitoring registration capacity reached" });
      } else {
        this.rejectAcceptedSocket(socket);
      }
      return;
    }
    const connection = { socket, invocationId: undefined, pending: undefined, registered: false, closed: false };
    this.connections.add(connection);
    const decoder = new FrameDecoder(
      (frame) => this.receive(connection, frame),
      (error) => this.failConnection(connection, error),
      () => connection.registered ? LIMITS.frame : REGISTRATION_FRAME_BYTES,
      (bytes) => this.reserveFrameBuffer(bytes),
      (bytes) => this.releaseFrameBuffer(bytes),
    );
    connection.decoder = decoder;
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.once("end", () => decoder.finish());
    socket.on("drain", () => this.pumpRequests());
    socket.once("error", () => {});
    socket.once("close", () => this.settleConnection(connection));
  }
  nativeWritableBytes() {
    let bytes = 0;
    for (const connection of this.connections) {
      if (!connection.closed && !connection.socket.destroyed) bytes += connection.socket.writableLength;
    }
    return bytes;
  }
  observeQueueUsage(nativeBytes = this.nativeWritableBytes()) {
    this.maxNativeWritableBytes = Math.max(this.maxNativeWritableBytes, nativeBytes);
    this.maxCombinedQueueBytes = Math.max(
      this.maxCombinedQueueBytes,
      this.eventQueueBytes + this.reservedEventQueueBytes + this.bufferedFrameBytes + nativeBytes,
    );
  }
  reserveFrameBuffer(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0
      || this.eventQueueBytes + this.reservedEventQueueBytes + this.bufferedFrameBytes
        + this.nativeWritableBytes() + bytes > LIMITS.queue) return false;
    this.bufferedFrameBytes += bytes;
    this.maxBufferedFrameBytes = Math.max(this.maxBufferedFrameBytes, this.bufferedFrameBytes);
    this.observeQueueUsage();
    return true;
  }
  releaseFrameBuffer(bytes) {
    this.bufferedFrameBytes = Math.max(0, this.bufferedFrameBytes - bytes);
    this.observeQueueUsage();
  }
  deliveryClaimBytes(pending) {
    return pending.channel === "terminal" ? TERMINAL_DELIVERY_DESCRIPTOR_BYTES : pending.maxBytes;
  }
  write(connection, value, onSettled) {
    if (connection.closed || connection.socket.destroyed || !connection.socket.writable) return false;
    const bytes = encode(value);
    const priorSocketBytes = connection.socket.writableLength;
    const queued = priorSocketBytes + bytes.length;
    const aggregateNativeBytes = this.nativeWritableBytes() - priorSocketBytes + queued;
    this.maxQueuedBytes = Math.max(this.maxQueuedBytes, queued);
    if (queued > LIMITS.queue
      || this.eventQueueBytes + this.reservedEventQueueBytes + this.bufferedFrameBytes + aggregateNativeBytes > LIMITS.queue) {
      if (value?.kind === "error") connection.socket.destroy();
      else this.failConnection(connection, new Error("COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND"));
      return false;
    }
    this.observeQueueUsage(aggregateNativeBytes);
    try {
      connection.socket.write(bytes, (error) => {
        try { onSettled?.(error); } finally { this.pumpRequests(); }
      });
    } catch (error) {
      try { onSettled?.(error); } catch {}
      if (!connection.socket.destroyed) connection.socket.destroy();
      this.observeQueueUsage();
      return false;
    }
    this.observeQueueUsage();
    return true;
  }
  receive(connection, frame) {
    if (!frame || typeof frame !== "object") { this.failConnection(connection, new Error("COMMAND_TELEMETRY_FRAME_INVALID")); return; }
    if (!connection.registered) {
      if (frame.kind !== "register" || frame.ownerId !== this.ownerId || frame.permission !== this.permission
        || frame.commandId !== this.commandId || !/^[a-f0-9]{24}$/.test(String(frame.invocationId || ""))) {
        this.failConnection(connection, new Error("COMMAND_TELEMETRY_REGISTRATION_REJECTED")); return;
      }
      if (this.invocations.size >= LIMITS.registrations || this.invocations.has(frame.invocationId)) {
        this.registrationDenials += 1;
        this.write(connection, { kind: "registration", accepted: false, reason: "monitoring registration capacity reached" });
        connection.socket.end();
        return;
      }
      connection.registered = true;
      connection.invocationId = frame.invocationId;
      const parentInvocationId = typeof frame.parentInvocationId === "string" ? frame.parentInvocationId : undefined;
      const parent = parentInvocationId ? this.invocations.get(parentInvocationId) : undefined;
      this.invocations.set(frame.invocationId, {
        connection,
        invocationId: frame.invocationId,
        parentInvocationId: parent?.invocationId,
        children: new Set(),
        retainedBytes: { ordinary: 0, control: 0, terminal: 0, counter: 0 },
        finalized: false,
        terminalSettled: false,
      });
      parent?.children.add(frame.invocationId);
      this.maxRegistrations = Math.max(this.maxRegistrations, this.invocations.size);
      this.write(connection, { kind: "registration", accepted: true, ownerId: this.ownerId });
      return;
    }
    if (frame.kind === "request") { this.request(connection, frame); return; }
    if (frame.kind === "payload") { this.payload(connection, frame); return; }
    if (frame.kind === "payload_chunk") { this.payloadChunk(connection, frame); return; }
    if (frame.kind === "release") {
      const leaseId = String(frame.leaseId || "");
      // A lease is bound to the invocation that acquired it, not merely to
      // possession of its opaque identifier on another authenticated socket.
      if (this.readerLeases.get(leaseId)?.invocationId === connection.invocationId) {
        this.releaseReader(leaseId);
      }
      return;
    }
    this.failConnection(connection, new Error("COMMAND_TELEMETRY_PROTOCOL_VIOLATION"));
  }
  request(connection, frame) {
    const invocation = this.invocations.get(connection.invocationId);
    const channel = String(frame.channel || "");
    const maxBytes = Number(frame.maxBytes);
    const opId = String(frame.opId || "");
    if (!invocation || invocation.finalized || connection.pending || !/^[a-f0-9]{32}$/.test(opId)
      || !Object.hasOwn(CHANNEL_LIMITS, channel) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
      || maxBytes > Math.min(CHANNEL_LIMITS[channel], LIMITS.frame)) {
      this.write(connection, { kind: "grant", opId, accepted: false, reason: "invalid or competing operation" });
      return;
    }
    this.reconcileFailedStages();
    connection.pending = { opId, channel, maxBytes, chunks: [], receivedBytes: 0, status: "queued", queueClaimBytes: 0 };
    this.deferredRequests.push(connection);
    this.pumpRequests();
  }
  canGrant(connection, pending) {
    const invocation = this.invocations.get(connection.invocationId);
    if (!invocation || invocation.finalized || connection.closed || connection.pending !== pending) return false;
    const available = LIMITS.cycle - LIMITS.controlHeadroom - this.currentActualBytes - this.outstandingBytes - this.eventQueueBytes;
    const blockedStage = pending.channel === "terminal"
      && [...this.failedStages.values()].some((stage) => stage.invocationId === connection.invocationId);
    const queueClaimBytes = this.deliveryClaimBytes(pending);
    const grantFrameBytes = encode({ kind: "grant", opId: pending.opId, accepted: true, bytes: pending.maxBytes }).length;
    const nativeBytes = this.nativeWritableBytes();
    const queueFits = this.eventQueueBytes + this.reservedEventQueueBytes + this.bufferedFrameBytes + nativeBytes
        + queueClaimBytes + grantFrameBytes <= LIMITS.queue
      && (pending.channel === "terminal"
        || this.nonTerminalEventQueueBytes + this.reservedNonTerminalEventQueueBytes
          + queueClaimBytes <= NON_TERMINAL_EVENT_QUEUE_LIMIT);
    return !blockedStage && (pending.channel !== "terminal" || this.publicationReaderAdmissionAvailable())
      && pending.maxBytes <= available && queueFits
      && invocation.retainedBytes[pending.channel] + pending.maxBytes <= CHANNEL_LIMITS[pending.channel];
  }
  pumpRequests() {
    if (this.pumpingRequests || this.closed) return;
    this.pumpingRequests = true;
    try {
      this.reconcileFailedReaderDescriptors();
      this.reconcileFailedStages();
      const visits = this.deferredRequests.length;
      for (let visit = 0; visit < visits; visit += 1) {
        const connection = this.deferredRequests.shift();
        const pending = connection?.pending;
        if (!connection || !pending || pending.status !== "queued" || connection.closed) continue;
        if (!this.canGrant(connection, pending)) { this.deferredRequests.push(connection); continue; }
        pending.status = "granted";
        pending.queueClaimBytes = this.deliveryClaimBytes(pending);
        this.reservedEventQueueBytes += pending.queueClaimBytes;
        if (pending.channel !== "terminal") this.reservedNonTerminalEventQueueBytes += pending.queueClaimBytes;
        this.outstandingBytes += pending.maxBytes;
        this.maxOutstandingBytes = Math.max(this.maxOutstandingBytes, this.outstandingBytes);
        this.observeQueueUsage();
        if (!this.write(connection, { kind: "grant", opId: pending.opId, accepted: true, bytes: pending.maxBytes })) {
          this.releasePending(connection, false);
        }
      }
    } finally { this.pumpingRequests = false; }
  }
  releasePending(connection, retainCharge) {
    const pending = connection.pending;
    if (!pending) return;
    connection.pending = undefined;
    const queuedIndex = this.deferredRequests.indexOf(connection);
    if (queuedIndex >= 0) this.deferredRequests.splice(queuedIndex, 1);
    if (pending.status === "granted") {
      this.reservedEventQueueBytes = Math.max(0, this.reservedEventQueueBytes - pending.queueClaimBytes);
      if (pending.channel !== "terminal") {
        this.reservedNonTerminalEventQueueBytes = Math.max(0, this.reservedNonTerminalEventQueueBytes - pending.queueClaimBytes);
      }
      pending.queueClaimBytes = 0;
      if (!retainCharge) this.outstandingBytes = Math.max(0, this.outstandingBytes - pending.maxBytes);
      this.observeQueueUsage();
    }
  }
  recordActual(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("COMMAND_TELEMETRY_ACTUAL_BYTES_INVALID");
    this.maxSingleActualBytes = Math.max(this.maxSingleActualBytes, bytes);
    this.currentActualBytes += bytes;
    this.maxActualBytes = Math.max(this.maxActualBytes, this.currentActualBytes);
    this.maxCombinedActualBytes = Math.max(this.maxCombinedActualBytes, this.currentActualBytes);
    this.cumulativeActualBytes += bytes;
    if (this.currentActualBytes > LIMITS.cycle) throw new Error("COMMAND_TELEMETRY_COMBINED_ACTUAL_EXCEEDS_BOUND");
  }
  advanceCycle() {
    this.currentActualBytes = 0;
  }
  hasRetainedReaderDescriptor(leaseId) {
    for (const retained of this.failedReaderDescriptors.values()) {
      if (retained.leaseId === leaseId) return true;
    }
    return false;
  }
  reconcileFailedReaderDescriptors() {
    for (const [descriptor, retained] of this.failedReaderDescriptors) {
      let closed = false;
      try { fs.closeSync(descriptor); closed = true; }
      catch {
        try { fs.fstatSync(descriptor); }
        catch (probeError) { closed = probeError?.code === "EBADF"; }
      }
      if (!closed) continue;
      this.failedReaderDescriptors.delete(descriptor);
      if (retained.permissionId) {
        const permission = this.hostPermissions.get(retained.permissionId);
        if (permission && retained.managedHostRead) {
          permission.pendingReaderDescriptors = Math.max(0, permission.pendingReaderDescriptors - 1);
          if (permission.pendingReaderDescriptors === 0 && permission.pendingWrites === 0
            && (permission.abandoned || permission.completionActualBytes !== undefined)) {
            this.settleHostPermission(permission, permission.abandoned ? "abandoned" : "completed");
          }
        } else if (permission) {
          // Legacy committed-delivery reads recorded their actual bytes before
          // close and retained the permission only as descriptor ownership.
          this.hostPermissions.delete(retained.permissionId);
          this.outstandingBytes = Math.max(0, this.outstandingBytes - permission.maxBytes);
          this.retireInvocationRecord(permission.invocationId);
        }
      } else if (retained.publicationCharge) {
        this.releasePublicationCharge(retained.publicationCharge);
      } else {
        this.outstandingBytes = Math.max(0, this.outstandingBytes - retained.chargeBytes);
      }
    }
  }
  retainPublicationCharge(charge) { charge.obligations += 1; }
  releasePublicationCharge(charge) {
    charge.obligations -= 1;
    if (charge.obligations === 0) this.outstandingBytes = Math.max(0, this.outstandingBytes - charge.bytes);
  }
  committedReaderAdmissionAvailable() {
    this.reconcileFailedReaderDescriptors();
    return this.failedReaderDescriptors.size === 0;
  }
  publicationReaderAdmissionAvailable() {
    // Publication opens a verification handle. A retained handle blocks the
    // next open, including a publication from another invocation or the host.
    if (!this.committedReaderAdmissionAvailable()) return false;
    let files = this.activeStages.size + this.failedReaderDescriptors.size;
    for (const stage of this.failedStages.values()) files += stage.possibleFiles?.length || 1;
    for (const current of this.generations.values()) files += current.previous ? 2 : 1;
    return files + 1 <= LIMITS.files;
  }
  reserveHostReaderWork(invocationId, channel, maxBytes) {
    // One unresolved native reader is enough to make another open unsafe. The
    // retained permission supplies the charge; refusing another reader keeps
    // descriptor count bounded without blocking unrelated owner operations.
    if (!this.committedReaderAdmissionAvailable()) return undefined;
    return this.reserveHostWork(invocationId, channel, maxBytes);
  }
  retainHostReaderDescriptor(descriptor, permission, actualBytes, context = {}) {
    const admitted = permission && this.hostPermissions.get(permission.permissionId);
    if (!admitted || admitted.invocationId !== permission.invocationId || admitted.channel !== permission.channel
      || admitted.completionActualBytes !== undefined || admitted.abandoned
      || !Number.isSafeInteger(descriptor) || descriptor < 0 || this.failedReaderDescriptors.has(descriptor)
      || !Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > admitted.maxBytes) {
      throw new Error("COMMAND_TELEMETRY_HOST_READER_RETENTION_INVALID");
    }
    this.recordActual(actualBytes);
    admitted.completionActualBytes = actualBytes;
    admitted.pendingReaderDescriptors += 1;
    this.failedReaderDescriptors.set(descriptor, {
      permissionId: admitted.permissionId,
      chargeBytes: admitted.maxBytes,
      managedHostRead: true,
    });
    this.lastReaderDescriptorFailure = Object.freeze({
      invocationId: admitted.invocationId,
      source: String(context.source || "host-reader").slice(0, 128),
      reason: String(context.reason || "COMMAND_TELEMETRY_HOST_READER_CLOSE_FAILED").slice(0, 256),
    });
  }
  reconcileFailedStages(invocationId) {
    for (const [key, stage] of this.failedStages) {
      if (invocationId && stage.invocationId !== invocationId) continue;
      const unresolved = (stage.possibleFiles || [stage.file]).filter((file) => !removeConclusive(file));
      if (unresolved.length > 0) {
        stage.possibleFiles = unresolved;
        stage.file = unresolved[0];
        continue;
      }
      this.failedStages.delete(key);
      this.failedRetainedBytes = Math.max(0, this.failedRetainedBytes - stage.retainedBytes);
      if (stage.publicationCharge) this.releasePublicationCharge(stage.publicationCharge);
      else this.outstandingBytes = Math.max(0, this.outstandingBytes - stage.chargeBytes);
    }
    this.measureRetainedStorage();
  }
  measureRetainedStorage() {
    let files = 0; let bytes = 0;
    for (const current of this.generations.values()) {
      for (const record of [current, current.previous].filter(Boolean)) {
        files += 1;
        try { bytes += fs.statSync(record.file).size; }
        catch { bytes += Number(record.bytes) || 0; }
      }
    }
    for (const stage of this.activeStages.values()) {
      files += 1;
      try { bytes += fs.statSync(stage.file).size; }
      catch { bytes += Number(stage.retainedBytes) || 0; }
    }
    for (const stage of this.failedStages.values()) {
      const possibleFiles = stage.possibleFiles || [stage.file];
      for (const file of possibleFiles) {
        files += 1;
        try { bytes += fs.statSync(file).size; }
        catch { bytes += Number(stage.retainedBytes) || 0; }
      }
    }
    this.maxRetainedBytes = Math.max(this.maxRetainedBytes, bytes);
    this.maxRetainedFiles = Math.max(this.maxRetainedFiles, files);
    return { files, bytes };
  }
  payload(connection, frame) {
    const pending = connection.pending;
    const invocation = this.invocations.get(connection.invocationId);
    if (!pending || pending.status !== "granted" || !invocation || frame.opId !== pending.opId || frame.channel !== pending.channel || pending.receivedBytes !== 0) {
      this.failConnection(connection, new Error("COMMAND_TELEMETRY_UNADMITTED_PAYLOAD")); return;
    }
    const actualBytes = byteLength(frame.event);
    if (actualBytes > pending.maxBytes) { this.failConnection(connection, new Error("COMMAND_TELEMETRY_PAYLOAD_EXCEEDS_GRANT")); return; }
    this.completePayload(connection, invocation, pending, frame.event, actualBytes);
  }
  payloadChunk(connection, frame) {
    const pending = connection.pending;
    const invocation = this.invocations.get(connection.invocationId);
    if (!pending || pending.status !== "granted" || !invocation || frame.opId !== pending.opId || frame.channel !== pending.channel
      || typeof frame.data !== "string" || frame.data.length > 48 * 1024) {
      this.failConnection(connection, new Error("COMMAND_TELEMETRY_UNADMITTED_PAYLOAD_CHUNK")); return;
    }
    const chunk = Buffer.from(frame.data, "base64");
    if (chunk.toString("base64") !== frame.data || pending.receivedBytes + chunk.length + 1 > pending.maxBytes) {
      this.failConnection(connection, new Error("COMMAND_TELEMETRY_PAYLOAD_EXCEEDS_GRANT")); return;
    }
    pending.chunks.push(chunk);
    pending.receivedBytes += chunk.length;
    if (frame.final !== true) return;
    let event;
    try { event = JSON.parse(Buffer.concat(pending.chunks, pending.receivedBytes).toString("utf8")); }
    catch { this.failConnection(connection, new Error("COMMAND_TELEMETRY_CHUNKED_PAYLOAD_INVALID")); return; }
    const actualBytes = byteLength(event);
    if (actualBytes !== pending.receivedBytes + 1 || actualBytes > pending.maxBytes) {
      this.failConnection(connection, new Error("COMMAND_TELEMETRY_CHUNKED_PAYLOAD_SIZE_MISMATCH")); return;
    }
    this.completePayload(connection, invocation, pending, event, actualBytes);
  }
  completePayload(connection, invocation, pending, event, actualBytes) {
    let retainCharge = false;
    try {
      this.recordActual(actualBytes);
      let publication;
      if (pending.channel === "terminal") publication = this.commitEvidence(invocation.invocationId, event, actualBytes, pending.maxBytes);
      this.completedOperations += 1;
      if (pending.channel === "terminal") {
        const delivery = this.retainCommittedDelivery(invocation.invocationId, publication.generation);
        this.events.push({ delivery, bytes: TERMINAL_DELIVERY_DESCRIPTOR_BYTES, channel: pending.channel, chargeBytes: pending.maxBytes });
        this.eventQueueBytes += TERMINAL_DELIVERY_DESCRIPTOR_BYTES;
        this.releasePending(connection, true);
      } else {
        this.events.push({ event, bytes: actualBytes, channel: pending.channel });
        this.eventQueueBytes += actualBytes;
        this.nonTerminalEventQueueBytes += actualBytes;
        this.releasePending(connection, false);
      }
      this.maxEventQueueBytes = Math.max(this.maxEventQueueBytes, this.eventQueueBytes);
      try {
        this.onEvent?.(event, { invocationId: invocation.invocationId, channel: pending.channel, actualBytes, publication });
      } catch (error) {
        // Observation is best-effort and occurs after the owner has committed
        // the transaction. Record callback failure without rewriting the
        // producer receipt or inviting a duplicate publication retry.
        this.observerCallbackFailures += 1;
        this.lastObserverCallbackFailure = Object.freeze({
          invocationId: invocation.invocationId,
          channel: pending.channel,
          reason: String(error?.message || error || "COMMAND_TELEMETRY_OBSERVER_CALLBACK_FAILED").slice(0, 256),
        });
      }
      this.write(connection, { kind: "receipt", opId: pending.opId, accepted: true, publication });
    } catch (error) {
      this.failedOperations += 1;
      retainCharge = error?.commandTelemetryChargeRetained === true;
      this.releasePending(connection, retainCharge);
      this.write(connection, { kind: "receipt", opId: pending.opId, accepted: false, reason: error?.message || String(error) });
    } finally {
      this.pumpRequests();
    }
  }
  commitEvidence(invocationId, event, payloadBytes, chargeBytes = payloadBytes) {
    if (!this.publicationReaderAdmissionAvailable()) throw new Error("COMMAND_TELEMETRY_PUBLICATION_READER_NOT_ADMITTED");
    this.reconcileFailedStages(invocationId);
    if ([...this.failedStages.values()].some((stage) => stage.invocationId === invocationId)) {
      throw new Error("COMMAND_TELEMETRY_FAILED_STAGE_STILL_OWNED");
    }
    const current = this.generations.get(invocationId);
    if (current?.previous) {
      this.retirePrevious(invocationId);
      if (current.previous) throw new Error("COMMAND_TELEMETRY_PREDECESSOR_STILL_IN_USE");
    }
    if (current?.blockedByRetirementFailure) throw new Error("COMMAND_TELEMETRY_PREDECESSOR_RETIREMENT_BLOCKED");
    const generation = (current?.generation || 0) + 1;
    const serialized = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (serialized.length !== payloadBytes || serialized.length > LIMITS.terminal) throw new Error("COMMAND_TELEMETRY_TERMINAL_EXCEEDS_BOUND");
    // Large terminal operations use two owner-advanced bounded phases: pipe
    // ingress, then durable staging. The permission remains charged across the
    // boundary, so no competing operation can spend the same capacity.
    if (this.currentActualBytes + serialized.length > LIMITS.cycle) this.advanceCycle();
    const predecessorBytes = current?.bytes || 0;
    let retainedFiles = this.activeStages.size
      + [...this.failedStages.values()].reduce((sum, failed) => sum + (failed.possibleFiles?.length || 1), 0);
    for (const retained of this.generations.values()) {
      for (const _record of [retained, retained.previous].filter(Boolean)) retainedFiles += 1;
    }
    if (retainedFiles + 1 > LIMITS.files) throw new Error("COMMAND_TELEMETRY_FILE_CAPACITY_EXHAUSTED");
    if (predecessorBytes + serialized.length > LIMITS.terminal) throw new Error("COMMAND_TELEMETRY_TERMINAL_WORKING_SET_EXCEEDS_BOUND");
    const temporary = path.join(this.evidenceDirectory, `${invocationId}.terminal.${generation}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    const committed = path.join(this.evidenceDirectory, `${invocationId}.terminal.${generation}.json`);
    const publicationCharge = { bytes: chargeBytes, obligations: 0 };
    const stage = { file: temporary, invocationId, generation, retainedBytes: 0, chargeBytes, publicationCharge };
    this.activeStages.set(temporary, stage);
    let observedStageBytes = 0;
    let renamed = false;
    let committedIdentity;
    try {
      fs.writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
      observedStageBytes = serialized.length;
      stage.retainedBytes = observedStageBytes;
      this.measureRetainedStorage();
      this.recordActual(serialized.length);
      const stagedStat = fs.lstatSync(temporary, { bigint: true });
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.size !== BigInt(serialized.length)) {
        throw new Error("COMMAND_TELEMETRY_STAGED_IDENTITY_INVALID");
      }
      this.publicationHook?.({ phase: "prepared", invocationId, generation, temporary, committed, previous: current?.file });
      fs.renameSync(temporary, committed);
      renamed = true;
      const committedStat = fs.lstatSync(committed, { bigint: true });
      if (!committedStat.isFile() || committedStat.isSymbolicLink() || committedStat.size !== BigInt(serialized.length)
        || committedStat.dev !== stagedStat.dev || committedStat.ino !== stagedStat.ino) {
        throw new Error("COMMAND_TELEMETRY_COMMITTED_IDENTITY_INVALID");
      }
      // Verify the actual post-rename object, not just the intended buffer.
      // Each native read is limited to the admitted terminal size and charged
      // through the existing owner cycle before predecessor retirement.
      if (this.currentActualBytes + serialized.length > LIMITS.cycle) this.advanceCycle();
      let descriptor;
      try {
        descriptor = fs.openSync(committed, "r");
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.size !== stagedStat.size
          || opened.dev !== stagedStat.dev || opened.ino !== stagedStat.ino) {
          throw new Error("COMMAND_TELEMETRY_COMMITTED_IDENTITY_INVALID");
        }
        const actual = Buffer.alloc(serialized.length);
        const read = fs.readSync(descriptor, actual, 0, actual.length, 0);
        this.recordActual(read);
        const afterHandle = fs.fstatSync(descriptor, { bigint: true });
        const afterPath = fs.lstatSync(committed, { bigint: true });
        if (read !== serialized.length || !afterPath.isFile() || afterPath.isSymbolicLink()
          || afterHandle.size !== stagedStat.size || afterHandle.dev !== stagedStat.dev || afterHandle.ino !== stagedStat.ino
          || afterPath.size !== stagedStat.size || afterPath.dev !== stagedStat.dev || afterPath.ino !== stagedStat.ino
          || !actual.equals(serialized)) {
          throw new Error("COMMAND_TELEMETRY_COMMITTED_CONTENT_OR_IDENTITY_CHANGED");
        }
      } finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); }
          catch (error) {
            let stillOpen = true;
            try { fs.fstatSync(descriptor); }
            catch (probeError) { if (probeError?.code === "EBADF") stillOpen = false; }
            if (stillOpen) {
              this.retainPublicationCharge(publicationCharge);
              this.failedReaderDescriptors.set(descriptor, { chargeBytes, publicationCharge });
              error.commandTelemetryChargeRetained = true;
            }
            throw error;
          }
        }
      }
      committedIdentity = Object.freeze({
        dev: committedStat.dev.toString(), ino: committedStat.ino.toString(), size: serialized.length,
      });
    } catch (error) {
      // renameSync can complete the native rename and still report an error.
      // Inspect both bounded transaction names; absence of the temporary name
      // alone does not prove that the admitted successor disappeared.
      const candidateFiles = [...new Set(renamed ? [committed, temporary] : [temporary, committed])];
      const unresolvedFiles = [];
      let retainedBytes = 0;
      for (const candidate of candidateFiles) {
        const candidateState = inspectPath(candidate);
        if (candidateState.state === "absent") continue;
        retainedBytes = Math.max(retainedBytes, candidateState.state === "unknown"
          ? Math.max(observedStageBytes, serialized.length)
          : candidateState.bytes || 0);
        if (!removeConclusive(candidate)) unresolvedFiles.push(candidate);
      }
      if (retainedBytes > observedStageBytes) this.recordActual(retainedBytes - observedStageBytes);
      this.activeStages.delete(temporary);
      if (unresolvedFiles.length > 0) {
        stage.file = unresolvedFiles[0];
        stage.possibleFiles = unresolvedFiles;
        stage.retainedBytes = retainedBytes;
        this.retainPublicationCharge(publicationCharge);
        this.failedStages.set(stage.file, stage);
        this.failedRetainedBytes += retainedBytes;
        this.maxFailedRetainedBytes = Math.max(this.maxFailedRetainedBytes, this.failedRetainedBytes);
        this.measureRetainedStorage();
        error.commandTelemetryChargeRetained = true;
      }
      throw error;
    }
    this.activeStages.delete(temporary);
    const previous = current ? {
      file: current.file, generation: current.generation, readers: current.readers || 0,
      bytes: current.bytes, sha256: current.sha256, identity: current.identity,
    } : undefined;
    const next = {
      file: committed, generation, readers: 0, previous, bytes: serialized.length,
      sha256: crypto.createHash("sha256").update(serialized).digest("hex"), identity: committedIdentity,
    };
    this.generations.set(invocationId, next);
    this.retirePrevious(invocationId);
    this.measureRetainedStorage();
    try { this.publicationHook?.({ phase: "committed", invocationId, generation, committed, previous: current?.file }); } catch {}
    return { generation, file: committed };
  }
  retirePrevious(invocationId) {
    const current = this.generations.get(invocationId);
    const previous = current?.previous;
    if (!previous || previous.readers > 0) return;
    if (removeConclusive(previous.file)) {
      current.previous = undefined;
      current.blockedByRetirementFailure = false;
    } else {
      current.blockedByRetirementFailure = true;
    }
    this.measureRetainedStorage();
  }
  retireCommitted(invocationId) {
    const current = this.generations.get(invocationId);
    if (!current || current.readers > 0 || current.previous) return false;
    if (!removeConclusive(current.file)) {
      current.blockedByRetirementFailure = true;
      return false;
    }
    this.generations.delete(invocationId);
    this.measureRetainedStorage();
    return true;
  }
  retainCommittedDelivery(invocationId, generation) {
    const current = this.generations.get(invocationId);
    if (!current || current.generation !== generation) throw new Error("COMMAND_TELEMETRY_COMMITTED_DELIVERY_UNAVAILABLE");
    current.readers += 1;
    const leaseId = crypto.randomBytes(16).toString("hex");
    if (!this.readerLeases) this.readerLeases = new Map();
    this.readerLeases.set(leaseId, { invocationId, generation: current.generation });
    return Object.freeze({
      leaseId, invocationId, generation: current.generation, file: current.file,
      bytes: current.bytes, sha256: current.sha256, identity: current.identity,
    });
  }
  committedRecord(delivery) {
    const current = this.generations.get(delivery.invocationId);
    if (current?.generation === delivery.generation) return current;
    if (current?.previous?.generation === delivery.generation) return current.previous;
    return undefined;
  }
  readCommittedDelivery(delivery, authorizedBytes = LIMITS.terminal, retention = {}) {
    const record = this.committedRecord(delivery);
    const expectedBytes = Number(delivery?.bytes);
    if (!record || record.file !== delivery.file || record.bytes !== expectedBytes
      || record.sha256 !== delivery.sha256 || record.identity !== delivery.identity
      || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0
      || expectedBytes > LIMITS.terminal || expectedBytes > authorizedBytes
      || this.currentActualBytes + expectedBytes > LIMITS.cycle
      || !this.committedReaderAdmissionAvailable()) {
      throw new Error("COMMAND_TELEMETRY_COMMITTED_READ_NOT_ADMITTED");
    }
    let descriptor;
    try {
      const before = fs.lstatSync(record.file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expectedBytes)
        || before.dev.toString() !== record.identity.dev || before.ino.toString() !== record.identity.ino) {
        throw new Error("COMMAND_TELEMETRY_COMMITTED_IDENTITY_CHANGED");
      }
      const canonical = fs.realpathSync(record.file);
      if (!isWithin(this.evidenceRealPath, canonical)) throw new Error("COMMAND_TELEMETRY_COMMITTED_PATH_ESCAPED");
      descriptor = fs.openSync(canonical, "r");
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.size !== BigInt(expectedBytes)
        || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("COMMAND_TELEMETRY_COMMITTED_HANDLE_CHANGED");
      }
      const bytes = Buffer.alloc(expectedBytes);
      const read = expectedBytes > 0 ? fs.readSync(descriptor, bytes, 0, expectedBytes, 0) : 0;
      this.recordActual(read);
      if (read !== expectedBytes) throw new Error("COMMAND_TELEMETRY_COMMITTED_READ_INCOMPLETE");
      const afterHandle = fs.fstatSync(descriptor, { bigint: true });
      const afterPath = fs.lstatSync(record.file, { bigint: true });
      if (!afterPath.isFile() || afterPath.isSymbolicLink()
        || afterHandle.size !== BigInt(expectedBytes) || afterHandle.dev !== opened.dev || afterHandle.ino !== opened.ino
        || afterPath.size !== BigInt(expectedBytes) || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
        || fs.realpathSync(record.file) !== canonical) {
        throw new Error("COMMAND_TELEMETRY_COMMITTED_IDENTITY_CHANGED");
      }
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
        throw new Error("COMMAND_TELEMETRY_COMMITTED_CONTENT_CHANGED");
      }
      return bytes;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); }
        catch (error) {
          let stillOpen = true;
          try { fs.fstatSync(descriptor); }
          catch (probeError) { if (probeError?.code === "EBADF") stillOpen = false; }
          if (stillOpen) {
            this.failedReaderDescriptors.set(descriptor, {
              leaseId: delivery.leaseId,
              chargeBytes: Number(retention.chargeBytes) || authorizedBytes,
              permissionId: retention.permissionId,
            });
            this.lastReaderDescriptorFailure = Object.freeze({
              invocationId: delivery.invocationId,
              generation: delivery.generation,
              reason: String(error?.code || error?.message || "COMMAND_TELEMETRY_COMMITTED_CLOSE_FAILED").slice(0, 256),
            });
          }
        }
      }
    }
  }
  acquireCommitted(invocationId) {
    const current = this.generations.get(invocationId);
    if (!current) return undefined;
    const permission = this.reserveHostReaderWork("__command__", "terminal", current.bytes);
    if (!permission) throw new Error("COMMAND_TELEMETRY_COMMITTED_READ_NOT_ADMITTED");
    let delivery;
    try {
      delivery = this.retainCommittedDelivery(invocationId, current.generation);
      const bytes = this.readCommittedDelivery(delivery, current.bytes, {
        chargeBytes: permission.maxBytes, permissionId: permission.permissionId,
      });
      if (!this.hasRetainedReaderDescriptor(delivery.leaseId)) this.completeHostWork(permission, 0);
      return { ...delivery, bytes };
    } catch (error) {
      if (delivery) this.releaseReader(delivery.leaseId);
      if ((!delivery || !this.hasRetainedReaderDescriptor(delivery.leaseId))
        && this.hostPermissions.has(permission.permissionId)) this.completeHostWork(permission, 0);
      throw error;
    }
  }
  releaseReader(leaseId) {
    const lease = this.readerLeases?.get(leaseId);
    if (!lease) return false;
    this.readerLeases.delete(leaseId);
    const current = this.generations.get(lease.invocationId);
    if (current?.generation === lease.generation) current.readers = Math.max(0, current.readers - 1);
    else if (current?.previous?.generation === lease.generation) current.previous.readers = Math.max(0, current.previous.readers - 1);
    this.retirePrevious(lease.invocationId);
    return true;
  }
  reserveHostWork(invocationId, channel, maxBytes) {
    const invocation = invocationId === "__command__" ? { finalized: false } : this.invocations.get(invocationId);
    if (this.closed || !invocation || invocation.finalized || !Object.hasOwn(CHANNEL_LIMITS, channel)
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > CHANNEL_LIMITS[channel]) return undefined;
    this.reconcileFailedReaderDescriptors();
    this.reconcileFailedStages();
    const available = LIMITS.cycle - LIMITS.controlHeadroom - this.currentActualBytes - this.outstandingBytes - this.eventQueueBytes;
    if (maxBytes > available) return undefined;
    const permissionId = crypto.randomBytes(16).toString("hex");
    this.hostPermissions.set(permissionId, {
      permissionId, invocationId, channel, maxBytes,
      pendingWrites: 0, pendingReaderDescriptors: 0,
      completionActualBytes: undefined, abandoned: false, writeFailed: false,
    });
    this.outstandingBytes += maxBytes;
    this.maxOutstandingBytes = Math.max(this.maxOutstandingBytes, this.outstandingBytes);
    return Object.freeze({ permissionId, invocationId, channel, maxBytes });
  }
  settleHostPermission(admitted, outcome) {
    if (!admitted || !this.hostPermissions.has(admitted.permissionId)) return;
    this.hostPermissions.delete(admitted.permissionId);
    this.outstandingBytes = Math.max(0, this.outstandingBytes - admitted.maxBytes);
    if (outcome === "abandoned") this.abandonedOperations += 1;
    else if (admitted.writeFailed) this.failedOperations += 1;
    else this.completedOperations += 1;
    this.retireInvocationRecord(admitted.invocationId);
    this.pumpRequests();
  }
  settleHostWrite(permissionId, error) {
    const admitted = this.hostPermissions.get(permissionId);
    if (!admitted) return;
    admitted.pendingWrites = Math.max(0, admitted.pendingWrites - 1);
    if (error) admitted.writeFailed = true;
    if (admitted.pendingWrites > 0 || admitted.pendingReaderDescriptors > 0) return;
    if (admitted.abandoned) this.settleHostPermission(admitted, "abandoned");
    else if (admitted.completionActualBytes !== undefined) this.settleHostPermission(admitted, "completed");
  }
  completeHostWork(permission, actualBytes) {
    const admitted = permission && this.hostPermissions.get(permission.permissionId);
    if (!admitted || admitted.invocationId !== permission.invocationId || admitted.channel !== permission.channel
      || admitted.completionActualBytes !== undefined || admitted.abandoned
      || !Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > admitted.maxBytes) {
      throw new Error("COMMAND_TELEMETRY_HOST_WORK_EXCEEDS_PERMISSION");
    }
    this.recordActual(actualBytes);
    admitted.completionActualBytes = actualBytes;
    if (admitted.pendingWrites === 0 && admitted.pendingReaderDescriptors === 0) {
      this.settleHostPermission(admitted, "completed");
    }
  }
  abandonHostWork(permission) {
    const admitted = permission && this.hostPermissions.get(permission.permissionId);
    if (!admitted || admitted.completionActualBytes !== undefined || admitted.abandoned) return false;
    admitted.abandoned = true;
    if (admitted.pendingWrites === 0 && admitted.pendingReaderDescriptors === 0) {
      this.settleHostPermission(admitted, "abandoned");
    }
    return true;
  }
  commitHostEvidence(invocationId, event) {
    const serializedBytes = byteLength(event);
    if (serializedBytes > LIMITS.terminal) throw new Error("COMMAND_TELEMETRY_TERMINAL_EXCEEDS_BOUND");
    if (!this.publicationReaderAdmissionAvailable()) return false;
    const permission = this.reserveHostWork("__command__", "terminal", serializedBytes);
    if (!permission) return false;
    let retainCharge = false;
    try {
      this.commitEvidence(invocationId, event, serializedBytes, permission.maxBytes);
      this.completeHostWork(permission, 0);
      return true;
    } catch (error) {
      retainCharge = error?.commandTelemetryChargeRetained === true;
      this.hostPermissions.delete(permission.permissionId);
      if (!retainCharge) this.outstandingBytes = Math.max(0, this.outstandingBytes - permission.maxBytes);
      this.failedOperations += 1;
      this.pumpRequests();
      throw error;
    }
  }
  hostDeliveryBytes(event, channel = "counter") {
    if (!Object.hasOwn(CHANNEL_LIMITS, channel)) throw new Error("COMMAND_TELEMETRY_CHANNEL_INVALID");
    return encode({ kind: "host", channel, event }).length;
  }
  sendToInvocation(invocationId, event, channel = "counter", permission, priorActualBytes = 0) {
    const invocation = this.invocations.get(invocationId);
    const admitted = permission && this.hostPermissions.get(permission.permissionId);
    if (!invocation || invocation.finalized || !admitted
      || admitted.completionActualBytes !== undefined || admitted.abandoned
      || admitted.invocationId !== invocationId || admitted.channel !== channel
      || !Number.isSafeInteger(priorActualBytes) || priorActualBytes < 0) return false;
    const bytes = this.hostDeliveryBytes(event, channel);
    if (bytes > CHANNEL_LIMITS[channel] || priorActualBytes + bytes > admitted.maxBytes) return false;
    admitted.pendingWrites += 1;
    let callbackSettled = false;
    const written = this.write(invocation.connection, { kind: "host", channel, event }, (error) => {
      callbackSettled = true;
      this.settleHostWrite(admitted.permissionId, error);
    });
    // write() reports a synchronous native throw through the callback before
    // returning false. Only a refusal that never submitted/called back needs
    // its newly reserved write claim released here.
    if (!written && !callbackSettled) admitted.pendingWrites -= 1;
    return written;
  }
  drainEvents() {
    this.advanceCycle();
    const drained = [];
    while (this.events.length > 0) {
      const next = this.events[0];
      // Admission deferral is not an unavailable/corrupt terminal. Keep the
      // delivery, lease, queue claim and producer charge intact and preserve
      // ordering until the earlier native descriptor closes conclusively.
      if (next.delivery && !this.committedReaderAdmissionAvailable()) break;
      const record = this.events.shift();
      this.eventQueueBytes = Math.max(0, this.eventQueueBytes - record.bytes);
      if (record.channel !== "terminal") {
        this.nonTerminalEventQueueBytes = Math.max(0, this.nonTerminalEventQueueBytes - record.bytes);
      }
      this.observeQueueUsage();
      if (!record.delivery) { drained.push(record.event); continue; }
      try {
        const bytes = this.readCommittedDelivery(record.delivery, record.chargeBytes, { chargeBytes: record.chargeBytes });
        drained.push(JSON.parse(bytes.toString("utf8")));
      } catch (error) {
        this.failedOperations += 1;
        this.terminalReadFailures += 1;
        this.lastTerminalReadFailure = Object.freeze({
          invocationId: record.delivery.invocationId,
          generation: record.delivery.generation,
          reason: String(error?.code || error?.message || "COMMAND_TELEMETRY_COMMITTED_READ_FAILED").slice(0, 256),
        });
      } finally {
        const descriptorRetained = this.hasRetainedReaderDescriptor(record.delivery.leaseId);
        this.releaseReader(record.delivery.leaseId);
        if (!descriptorRetained) this.outstandingBytes = Math.max(0, this.outstandingBytes - record.chargeBytes);
      }
    }
    this.pumpRequests();
    return drained;
  }
  failConnection(connection, error) {
    if (connection.closed) return;
    try { this.write(connection, { kind: "error", message: error.message }); } catch {}
    connection.socket.destroy();
  }
  settleConnection(connection) {
    if (connection.closed) return;
    connection.closed = true;
    connection.decoder?.dispose();
    this.connections.delete(connection);
    if (connection.pending) {
      const wasGranted = connection.pending.status === "granted";
      this.releasePending(connection, false);
      if (wasGranted) this.abandonedOperations += 1;
    }
    if (connection.invocationId) {
      this.reconcileFailedStages(connection.invocationId);
      const invocation = this.invocations.get(connection.invocationId);
      if (invocation?.connection === connection) this.finalizeInvocation(connection.invocationId);
    }
    this.pumpRequests();
  }
  finalizeInvocation(invocationId) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) return false;
    invocation.finalized = true;
    invocation.terminalSettled = true;
    if (invocation.connection.pending) {
      const wasGranted = invocation.connection.pending.status === "granted";
      this.releasePending(invocation.connection, false);
      if (wasGranted) this.abandonedOperations += 1;
    }
    this.reconcileFailedStages(invocationId);
    this.retireInvocationRecord(invocationId);
    return true;
  }
  retireInvocationRecord(invocationId) {
    const invocation = this.invocations.get(invocationId);
    const hostWorkPending = [...this.hostPermissions.values()]
      .some((permission) => permission.invocationId === invocationId);
    if (!invocation || !invocation.terminalSettled || invocation.children.size > 0 || hostWorkPending) return;
    this.invocations.delete(invocationId);
    if (!invocation.parentInvocationId) return;
    const parent = this.invocations.get(invocation.parentInvocationId);
    parent?.children.delete(invocationId);
    if (parent?.terminalSettled) this.retireInvocationRecord(parent.invocationId);
  }
  invocationProducerState(invocationId) {
    const invocation = this.invocations.get(invocationId);
    return invocation && !invocation.finalized ? "open" : "closed";
  }
  accounting() {
    const retained = this.measureRetainedStorage();
    return {
      ownerId: this.ownerId,
      currentOutstandingBytes: this.outstandingBytes,
      maxOutstandingBytes: this.maxOutstandingBytes,
      maxActualBytes: this.maxActualBytes,
      maxSingleActualBytes: this.maxSingleActualBytes,
      maxCombinedActualBytes: this.maxCombinedActualBytes,
      cumulativeActualBytes: this.cumulativeActualBytes,
      pendingRequests: this.deferredRequests.filter((connection) => connection.pending?.status === "queued").length,
      failedRetainedBytes: this.failedRetainedBytes,
      maxFailedRetainedBytes: this.maxFailedRetainedBytes,
      retainedFailedStages: this.failedStages.size,
      activeStages: this.activeStages.size,
      reservedEventQueueBytes: this.reservedEventQueueBytes,
      reservedNonTerminalEventQueueBytes: this.reservedNonTerminalEventQueueBytes,
      maxQueuedBytes: this.maxQueuedBytes,
      maxNativeWritableBytes: this.maxNativeWritableBytes,
      maxEventQueueBytes: this.maxEventQueueBytes,
      maxCombinedQueueBytes: this.maxCombinedQueueBytes,
      bufferedFrameBytes: this.bufferedFrameBytes,
      maxBufferedFrameBytes: this.maxBufferedFrameBytes,
      activeRegistrations: this.invocations.size,
      maxRegistrations: this.maxRegistrations,
      registrationDenials: this.registrationDenials,
      activeRefusalResponses: this.refusedConnections.size,
      maxRefusalResponses: this.maxRefusedConnections,
      retainedGenerations: retained.files,
      retainedBytes: retained.bytes,
      maxRetainedFiles: this.maxRetainedFiles,
      maxRetainedBytes: this.maxRetainedBytes,
      abandonedOperations: this.abandonedOperations,
      completedOperations: this.completedOperations,
      failedOperations: this.failedOperations,
      terminalReadFailures: this.terminalReadFailures,
      lastTerminalReadFailure: this.lastTerminalReadFailure,
      observerCallbackFailures: this.observerCallbackFailures,
      lastObserverCallbackFailure: this.lastObserverCallbackFailure,
      retainedReaderDescriptors: this.failedReaderDescriptors.size,
      lastReaderDescriptorFailure: this.lastReaderDescriptorFailure,
    };
  }
  async settleCloseAttempt() {
    this.reconcileFailedReaderDescriptors();
    this.reconcileFailedStages();
    const descriptorPermissions = new Set(
      [...this.failedReaderDescriptors.values()].map((retained) => retained.permissionId).filter(Boolean),
    );
    for (const permission of [...this.hostPermissions.values()]) {
      if (descriptorPermissions.has(permission.permissionId)) continue;
      // A queued native write is still owned work. Its callback is the
      // conclusive settlement signal; socket.end() below flushes it naturally.
      if (permission.pendingWrites > 0) continue;
      this.abandonHostWork(permission);
    }
    for (const connection of this.connections) connection.socket.end();
    for (const socket of this.refusedConnections) socket.end();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    this.reconcileFailedReaderDescriptors();
    this.reconcileFailedStages();
    if (this.failedReaderDescriptors.size > 0) throw new Error("COMMAND_TELEMETRY_READER_DESCRIPTOR_STILL_OWNED");
    // Closed admission does not settle staging or a pending native callback.
    // Preserve these identities and charges so a later public close can
    // reconcile them when the filesystem/callback has actually recovered.
    if (this.activeStages.size > 0 || this.failedStages.size > 0) {
      throw new Error("COMMAND_TELEMETRY_STAGE_STILL_OWNED");
    }
    if ([...this.hostPermissions.values()].some((permission) => permission.pendingWrites > 0)) {
      throw new Error("COMMAND_TELEMETRY_NATIVE_WRITE_STILL_OWNED");
    }
    if (process.platform !== "win32") safeUnlink(this.endpoint);
  }
  async close() {
    this.closed = true;
    if (this.closeSettled) return;
    if (this.closeAttempt) return this.closeAttempt;
    const attempt = this.settleCloseAttempt();
    this.closeAttempt = attempt;
    try {
      await attempt;
      this.closeSettled = true;
    } finally {
      if (this.closeAttempt === attempt) this.closeAttempt = undefined;
    }
  }
}

class CommandTelemetryClient extends EventEmitter {
  constructor(configuration, invocationId) {
    super();
    this.configuration = configuration;
    this.invocationId = invocationId;
    this.socket = undefined;
    this.connectPromise = undefined;
    this.pendingGrant = new Map();
    this.pendingReceipt = new Map();
    this.registered = false;
    this.closed = false;
    this.terminalError = undefined;
    this.maxQueuedBytes = 0;
  }
  connect() {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closed) return Promise.reject(new Error("COMMAND_TELEMETRY_CLIENT_CLOSED"));
    // A connected socket is not a registered client. Share the pending
    // registration result, including its failure, with every concurrent caller.
    if (!this.connectPromise) this.connectPromise = this.connectInternal();
    return this.connectPromise;
  }
  async connectInternal() {
    const socket = net.createConnection(this.configuration.endpoint);
    this.socket = socket;
    const decoder = new FrameDecoder((frame) => this.receive(frame), (error) => this.fail(error));
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.once("end", () => decoder.finish());
    socket.once("error", (error) => this.fail(error));
    socket.once("close", () => this.fail(new Error("COMMAND_TELEMETRY_OWNER_CLOSED")));
    await new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => { socket.off("connect", onConnect); socket.off("error", onError); };
      socket.once("connect", onConnect); socket.once("error", onError);
    });
    const registration = new Promise((resolve, reject) => { this.registrationWaiter = { resolve, reject }; });
    try {
      this.write({
        kind: "register", ownerId: this.configuration.ownerId, permission: this.configuration.permission,
        commandId: this.configuration.commandId, invocationId: this.invocationId,
        parentInvocationId: this.configuration.parentInvocationId,
      });
    } catch (error) {
      this.registrationWaiter = undefined;
      if (!socket.destroyed && !socket.writableEnded) {
        try { socket.end(); } catch {}
      }
      throw error;
    }
    await registration;
  }
  write(value) {
    if (this.terminalError) throw this.terminalError;
    if (!this.socket?.writable || this.closed) throw new Error("COMMAND_TELEMETRY_CLIENT_CLOSED");
    const bytes = encode(value);
    const queued = this.socket.writableLength + bytes.length;
    this.maxQueuedBytes = Math.max(this.maxQueuedBytes, queued);
    if (queued > LIMITS.queue) throw new Error("COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND");
    this.socket.write(bytes);
  }
  async writeAsync(value) {
    if (this.terminalError) throw this.terminalError;
    if (!this.socket?.writable || this.closed) throw new Error("COMMAND_TELEMETRY_CLIENT_CLOSED");
    const bytes = encode(value);
    const queued = this.socket.writableLength + bytes.length;
    this.maxQueuedBytes = Math.max(this.maxQueuedBytes, queued);
    if (queued > LIMITS.queue) throw new Error("COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND");
    await new Promise((resolve, reject) => {
      this.socket.write(bytes, (error) => error ? reject(error) : resolve());
    });
  }
  receive(frame) {
    if (frame.kind === "registration") {
      if (frame.accepted) {
        this.registered = true;
        this.registrationWaiter?.resolve();
        this.registrationWaiter = undefined;
      } else {
        // A registration refusal is a terminal transport outcome. Retaining it
        // prevents connect() from treating the still-closing socket as healthy.
        this.fail(new Error(frame.reason || "COMMAND_TELEMETRY_REGISTRATION_REJECTED"));
      }
      return;
    }
    if (frame.kind === "grant") {
      const waiter = this.pendingGrant.get(frame.opId); this.pendingGrant.delete(frame.opId);
      if (!waiter) return;
      if (frame.accepted) waiter.resolve(frame);
      else waiter.reject(new Error(frame.reason || "COMMAND_TELEMETRY_GRANT_REJECTED"));
      return;
    }
    if (frame.kind === "receipt") {
      const waiter = this.pendingReceipt.get(frame.opId); this.pendingReceipt.delete(frame.opId);
      if (!waiter) return;
      if (frame.accepted) waiter.resolve(frame);
      else waiter.reject(new Error(frame.reason || "COMMAND_TELEMETRY_PUBLICATION_FAILED"));
      return;
    }
    if (frame.kind === "host") { this.emit("event", frame.event, frame.channel); return; }
    if (frame.kind === "error") this.fail(new Error(frame.message || "COMMAND_TELEMETRY_OWNER_ERROR"));
  }
  async requestWork(channel, maxBytes) {
    if (this.terminalError) throw this.terminalError;
    if (!this.registered) throw new Error("COMMAND_TELEMETRY_CLIENT_NOT_REGISTERED");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > (CHANNEL_LIMITS[channel] || 0)) {
      throw new Error("COMMAND_TELEMETRY_CHANNEL_FRAME_EXCEEDS_BOUND");
    }
    const opId = crypto.randomBytes(16).toString("hex");
    const grant = new Promise((resolve, reject) => this.pendingGrant.set(opId, { resolve, reject }));
    try { this.write({ kind: "request", opId, channel, maxBytes }); }
    catch (error) {
      this.pendingGrant.delete(opId);
      throw error;
    }
    await grant;
    return Object.freeze({ opId, channel, maxBytes });
  }
  async commitGranted(grant, event) {
    if (this.terminalError) throw this.terminalError;
    const actualBytes = byteLength(event);
    if (!grant || actualBytes > grant.maxBytes) throw new Error("COMMAND_TELEMETRY_PAYLOAD_EXCEEDS_GRANT");
    const receipt = new Promise((resolve, reject) => this.pendingReceipt.set(grant.opId, { resolve, reject }));
    const serialized = Buffer.from(JSON.stringify(event), "utf8");
    try {
      if (serialized.length <= 8 * 1024) {
        this.write({ kind: "payload", opId: grant.opId, channel: grant.channel, event });
      } else {
        for (let offset = 0; offset < serialized.length; offset += 8 * 1024) {
          const end = Math.min(serialized.length, offset + 8 * 1024);
          await this.writeAsync({
            kind: "payload_chunk", opId: grant.opId, channel: grant.channel,
            data: serialized.subarray(offset, end).toString("base64"), final: end === serialized.length,
          });
        }
      }
    } catch (error) {
      this.pendingReceipt.delete(grant.opId);
      if (this.socket && !this.socket.destroyed && !this.socket.writableEnded) {
        try { this.socket.end(); } catch {}
      }
      throw error;
    }
    return receipt;
  }
  async publish(event, channel = "ordinary") {
    const actualBytes = byteLength(event);
    const grant = await this.requestWork(channel, actualBytes);
    return this.commitGranted(grant, event);
  }
  fail(error) {
    if (this.closed) return;
    const terminalError = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    this.registered = false;
    this.terminalError = terminalError;
    this.registrationWaiter?.reject(terminalError);
    this.registrationWaiter = undefined;
    for (const waiter of this.pendingGrant.values()) waiter.reject(terminalError);
    for (const waiter of this.pendingReceipt.values()) waiter.reject(terminalError);
    this.pendingGrant.clear(); this.pendingReceipt.clear();
    if (this.socket && !this.socket.destroyed && !this.socket.writableEnded) {
      try { this.socket.end(); } catch {}
    }
    this.emit("transportError", terminalError);
  }
  async close() {
    if (!this.socket || this.socket.destroyed) return;
    const socket = this.socket;
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.end();
    await closed;
  }
}

module.exports = { CommandTelemetryOwner, CommandTelemetryClient, FrameDecoder, COMMAND_TELEMETRY_LIMITS: LIMITS };
