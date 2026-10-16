#!/usr/bin/env node
/** Authenticated command-scoped supervisor for one host-contracted Node test child. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { StreamingSecretRedactor, redactCompleteText } = require("./streaming-redactor.cjs");
const { CommandTelemetryClient } = require("./command-telemetry-owner.cjs");

const DEFAULT_POLICY = Object.freeze({
  minimumObservationMs: 2 * 60_000,
  alarmAfterMs: 5 * 60_000,
  cancelAfterMs: 10 * 60_000,
  minimumAlarmLeadMs: 30_000,
  pollMs: 1_000,
});
const MAX_LOG_BYTES = 64 * 1024;
const FIRST_LOG_BYTES = 4 * 1024;

function validatePolicy(value) {
  const policy = { ...DEFAULT_POLICY, ...(value && typeof value === "object" ? value : {}) };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new Error(`Invalid no-output policy ${key}`);
  }
  if (policy.minimumObservationMs > policy.alarmAfterMs || policy.alarmAfterMs >= policy.cancelAfterMs) {
    throw new Error("No-output policy requires minimumObservation <= alarm < cancellation");
  }
  if (policy.minimumAlarmLeadMs >= policy.cancelAfterMs) throw new Error("Invalid no-output alarm lead");
  return Object.freeze(policy);
}

class SilencePolicyMachine {
  constructor(policy, startedMonotonicMs = performance.now()) {
    this.policy = validatePolicy(policy);
    this.startedMonotonicMs = startedMonotonicMs;
    this.lastOutputMonotonicMs = startedMonotonicMs;
    this.alarmMonotonicMs = undefined;
    this.alarmAcknowledgedMonotonicMs = undefined;
    this.episode = 0;
    this.finalized = false;
  }
  beginObservation(now = performance.now()) {
    if (this.finalized) return;
    this.startedMonotonicMs = now;
    this.lastOutputMonotonicMs = now;
    this.alarmMonotonicMs = undefined;
    this.alarmAcknowledgedMonotonicMs = undefined;
  }
  observeOutput(now = performance.now()) {
    if (this.finalized) return;
    this.lastOutputMonotonicMs = now;
    if (this.alarmMonotonicMs !== undefined) {
      this.alarmMonotonicMs = undefined;
      this.alarmAcknowledgedMonotonicMs = undefined;
      this.episode += 1;
    }
  }
  acknowledgeAlarm(now = performance.now()) {
    if (this.alarmMonotonicMs === undefined || this.alarmAcknowledgedMonotonicMs !== undefined) return false;
    this.alarmAcknowledgedMonotonicMs = now;
    return true;
  }
  tick(now = performance.now()) {
    if (this.finalized) return undefined;
    const elapsedMs = now - this.startedMonotonicMs;
    const noOutputMs = now - this.lastOutputMonotonicMs;
    if (elapsedMs < this.policy.minimumObservationMs) return undefined;
    if (this.alarmMonotonicMs === undefined) {
      if (noOutputMs < this.policy.alarmAfterMs) return undefined;
      this.alarmMonotonicMs = now;
      return { kind: "alarm", now, elapsedMs, noOutputMs, episode: this.episode };
    }
    if (this.alarmAcknowledgedMonotonicMs === undefined) return undefined;
    if (noOutputMs < this.policy.cancelAfterMs) return undefined;
    if (now - this.alarmAcknowledgedMonotonicMs < this.policy.minimumAlarmLeadMs) return undefined;
    return {
      kind: "cancel", now, elapsedMs, noOutputMs, episode: this.episode,
      alarmMonotonicMs: this.alarmMonotonicMs,
      alarmAcknowledgedMonotonicMs: this.alarmAcknowledgedMonotonicMs,
    };
  }
  finalize() { this.finalized = true; }
}

class SharedReadBudget {
  constructor(limitBytes = 256 * 1024) {
    this.limitBytes = limitBytes; this.currentCycleBytes = 0; this.maxCycleBytes = 0;
    this.currentActualBytes = 0; this.maxActualBytes = 0; this.sourceBytes = new Map(); this.actualSourceBytes = new Map();
  }
  beginCycle() { this.currentCycleBytes = 0; this.currentActualBytes = 0; this.sourceBytes.clear(); this.actualSourceBytes.clear(); }
  reserveBeforeRead(requestedBytes, source) {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) throw new Error("INVALID_SHARED_READ_RESERVATION");
    const granted = Math.min(requestedBytes, this.limitBytes - this.currentCycleBytes);
    if (granted <= 0) return 0;
    this.currentCycleBytes += granted; this.maxCycleBytes = Math.max(this.maxCycleBytes, this.currentCycleBytes);
    this.sourceBytes.set(source, (this.sourceBytes.get(source) || 0) + granted);
    return granted;
  }
  consumeActual(bytes, source) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.currentActualBytes + bytes > this.currentCycleBytes) throw new Error("ACTUAL_READ_EXCEEDED_RESERVED_CREDITS");
    this.currentActualBytes += bytes; this.maxActualBytes = Math.max(this.maxActualBytes, this.currentActualBytes);
    this.actualSourceBytes.set(source, (this.actualSourceBytes.get(source) || 0) + bytes);
  }
  accounting() {
    return {
      currentCycleBytes: this.currentCycleBytes, maxCycleBytes: this.maxCycleBytes,
      currentActualBytes: this.currentActualBytes, maxActualBytes: this.maxActualBytes,
      sourceBytes: Object.fromEntries(this.sourceBytes), actualSourceBytes: Object.fromEntries(this.actualSourceBytes),
    };
  }
}

class CounterSamplingScheduler {
  constructor(intervalMs) { this.intervalMs = intervalMs; this.nextAt = 0; this.outstandingGeneration = undefined; this.generation = 0; this.freshDemand = false; }
  requestFresh() { this.freshDemand = true; }
  tick(now, ready) {
    if (!ready || this.outstandingGeneration !== undefined) return undefined;
    if (!this.freshDemand && now < this.nextAt) return undefined;
    this.freshDemand = false;
    this.nextAt = now + this.intervalMs; // missed opportunities are skipped, never replayed
    this.outstandingGeneration = ++this.generation;
    return this.outstandingGeneration;
  }
  acceptResponse(generation) {
    if (generation !== this.outstandingGeneration) return false;
    this.outstandingGeneration = undefined;
    return true;
  }
  fail() { this.outstandingGeneration = undefined; this.freshDemand = false; }
}

class BoundedFirstTail {
  constructor(maxBytes = MAX_LOG_BYTES, firstBytes = FIRST_LOG_BYTES) {
    this.maxBytes = maxBytes;
    this.firstBytes = firstBytes;
    this.first = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.totalBytes = 0;
  }
  append(text) {
    let bytes = Buffer.from(text, "utf8");
    this.totalBytes += bytes.length;
    if (this.first.length < this.firstBytes) {
      const take = Math.min(this.firstBytes - this.first.length, bytes.length);
      this.first = Buffer.concat([this.first, bytes.subarray(0, take)]);
      bytes = bytes.subarray(take);
    }
    if (bytes.length > 0) {
      const tailLimit = this.maxBytes - this.firstBytes;
      this.tail = Buffer.concat([this.tail, bytes]);
      if (this.tail.length > tailLimit) this.tail = this.tail.subarray(this.tail.length - tailLimit);
    }
  }
  text() {
    const omitted = this.totalBytes > this.first.length + this.tail.length;
    return this.first.toString("utf8") + (omitted ? "\n[...sanitized output omitted...]\n" : "") + this.tail.toString("utf8");
  }
}

/** Streaming redaction occurs before bounded retention, including across chunk boundaries. */
class SecretSafeLog {
  constructor() {
    this.store = new BoundedFirstTail();
    this.redactor = new StreamingSecretRedactor();
  }
  appendLabel(label) { this.append(`\n[${label}]\n`); }
  append(value) { const safe = this.redactor.push(value); if (safe) this.store.append(safe); }
  finish() { const safe = this.redactor.finish(); if (safe) this.store.append(safe); return this.store.text(); }
}

function parseCli(argv) {
  const divider = argv.indexOf("--");
  if (divider < 0) throw new Error("Missing supervised Node argument separator");
  const options = {};
  for (let index = 0; index < divider; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Malformed supervisor arguments");
    options[key.slice(2)] = value;
  }
  return { options, nodeArgs: argv.slice(divider + 1) };
}
function real(value) { return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value); }
function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
function utf8Tail(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
const EVIDENCE_OMISSION = "\n[...captured evidence omitted; non-contiguous boundary...]\n";
function jsonStringBytes(value) { return Buffer.byteLength(JSON.stringify(String(value)), "utf8"); }
function fitJsonString(value, maxSerializedBytes, marker = EVIDENCE_OMISSION) {
  const text = String(value);
  if (jsonStringBytes(text) <= maxSerializedBytes) return text;
  if (maxSerializedBytes <= jsonStringBytes("[truncated]")) return "";
  let low = 0; let high = Buffer.byteLength(text, "utf8"); let best = "[truncated]";
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    const headBytes = Math.floor(retained / 2);
    const candidate = `${utf8Prefix(text, headBytes)}${marker}${utf8Tail(text, retained - headBytes)}`;
    if (jsonStringBytes(candidate) <= maxSerializedBytes) { best = candidate; low = retained + 1; }
    else high = retained - 1;
  }
  return best;
}
const CANONICAL_EVIDENCE_KEYS = new Set([
  "schemaVersion", "type", "commandId", "invocationId", "transportId", "bindingGeneration", "sequence", "wallTime",
  "outcome", "exitCode", "signal", "totalElapsedMs", "noOutputMs", "alarmMonotonicMs", "alarmAcknowledgedMonotonicMs",
  "cancelledMonotonicMs", "cancellationRequested", "cancellationAccepted", "cancellationConfirmed", "confirmationBasis",
  "cancellationTarget", "eligibility", "ackToken", "artifactSha256", "artifactBytes",
]);
function fitEvidenceObject(value, maxBytes, serialize = (item) => Buffer.from(`${JSON.stringify(item)}\n`, "utf8")) {
  const fitted = JSON.parse(JSON.stringify(value));
  let bytes = serialize(fitted);
  if (bytes.length <= maxBytes) return { value: fitted, bytes, truncated: false };
  fitted.evidenceTruncated = true;
  for (let pass = 0; pass < 64; pass += 1) {
    bytes = serialize(fitted);
    if (bytes.length <= maxBytes) return { value: fitted, bytes, truncated: true };
    const candidates = [];
    const visit = (item, parent, key) => {
      if (typeof item === "string") {
        if (!CANONICAL_EVIDENCE_KEYS.has(String(key))) candidates.push({ parent, key, cost: jsonStringBytes(item) });
        return;
      }
      if (!item || typeof item !== "object") return;
      for (const [childKey, child] of Object.entries(item)) visit(child, item, childKey);
    };
    visit(fitted, undefined, undefined);
    candidates.sort((left, right) => right.cost - left.cost);
    const target = candidates.find((candidate) => candidate.cost > 64);
    if (!target) break;
    const current = target.parent[target.key];
    const excess = bytes.length - maxBytes;
    target.parent[target.key] = fitJsonString(current, Math.max(64, target.cost - excess - 256));
  }
  bytes = serialize(fitted);
  if (bytes.length > maxBytes) throw new Error("CANONICAL_TERMINAL_EVIDENCE_EXCEEDS_BOUND");
  return { value: fitted, bytes, truncated: true };
}
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function loadAuthorization(file, expectedSha256) {
  if (!file || !expectedSha256) return undefined;
  if (fs.statSync(file).size > 1024 * 1024) return undefined;
  const bytes = fs.readFileSync(file);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) return undefined;
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed?.schemaVersion !== 1 || parsed.authority !== "run-admission-owner-task") return undefined;
  const { policyHash, ...body } = parsed;
  if (crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") !== policyHash) return undefined;
  return Array.isArray(parsed.existingEntrypoints) && Array.isArray(parsed.approvedDynamicScopes) ? parsed : undefined;
}
function shellWords(value) {
  const words = [];
  let current = "";
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < value.length) current += value[++index];
      else current += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { if (current) { words.push(current); current = ""; } }
    else if (character === "\\" && index + 1 < value.length) current += value[++index];
    else current += character;
  }
  if (quote) return undefined;
  if (current) words.push(current);
  return words;
}
const NODE_OPTIONS_WITH_VALUE = new Set(["--conditions", "--env-file", "--import", "--loader", "--require", "-r", "--test-concurrency", "--test-name-pattern", "--test-reporter", "--test-reporter-destination", "--test-shard"]);
const PRELOAD_OPTIONS = new Set(["--import", "--loader", "--require", "-r"]);
const OUTPUT_OPTIONS = new Set(["--output-file", "--outputFile", "--reporter-output", "--reporterOutput", "--log-file", "--logFile", "--test-reporter-destination"]);
function parseNodeInvocation(nodeArgs, cwd, authorization, userNodeOptions = "") {
  const effectiveOptions = [];
  const preloads = [];
  const outputPaths = [];
  let scriptIndex = -1;
  for (let index = 0; index < nodeArgs.length; index += 1) {
    const arg = nodeArgs[index];
    if (arg === "--") { scriptIndex = index + 1; break; }
    if (!arg.startsWith("-")) { scriptIndex = index; break; }
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!authorization?.allowedNodeOptions?.includes(name)) return { error: `unapproved Node option ${name}` };
    effectiveOptions.push(arg);
    if (NODE_OPTIONS_WITH_VALUE.has(name) && inline === undefined) {
      if (!nodeArgs[index + 1]) return { error: `missing value for Node option ${name}` };
      const value = nodeArgs[++index]; effectiveOptions.push(value);
      if (PRELOAD_OPTIONS.has(name)) preloads.push(value);
      if (OUTPUT_OPTIONS.has(name)) outputPaths.push(path.resolve(cwd, value));
    } else {
      if (PRELOAD_OPTIONS.has(name) && inline !== undefined) preloads.push(inline);
      if (OUTPUT_OPTIONS.has(name) && inline !== undefined) outputPaths.push(path.resolve(cwd, inline));
    }
  }
  const environmentWords = userNodeOptions ? shellWords(userNodeOptions) : [];
  if (environmentWords === undefined) return { error: "NODE_OPTIONS quoting is malformed" };
  for (let index = 0; index < environmentWords.length; index += 1) {
    const arg = environmentWords[index];
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!authorization?.allowedNodeOptions?.includes(name)) return { error: `unapproved NODE_OPTIONS option ${name}` };
    if (NODE_OPTIONS_WITH_VALUE.has(name) && inline === undefined) {
      const value = environmentWords[++index];
      if (!value) return { error: `missing NODE_OPTIONS value for ${name}` };
      if (PRELOAD_OPTIONS.has(name)) preloads.push(value);
    } else if (PRELOAD_OPTIONS.has(name) && inline !== undefined) preloads.push(inline);
  }
  if (scriptIndex < 0 || !nodeArgs[scriptIndex]) return { error: "no explicit Node entrypoint" };
  const script = path.resolve(cwd, nodeArgs[scriptIndex]);
  for (let index = scriptIndex + 1; index < nodeArgs.length; index += 1) {
    const arg = nodeArgs[index];
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!OUTPUT_OPTIONS.has(name)) continue;
    const value = inline ?? nodeArgs[++index];
    if (!value) return { error: `missing output destination for ${name}` };
    outputPaths.push(path.resolve(cwd, value));
  }
  if (outputPaths.length > 32) return { error: "more than 32 output destinations require observe-only" };
  return { script, scriptIndex, effectiveOptions, preloads, outputPaths };
}
function classifyTest(nodeArgs, cwd, authorization, userNodeOptions = "") {
  const invocation = parseNodeInvocation(nodeArgs, cwd, authorization, userNodeOptions);
  if (invocation.error || !authorization) return { eligible: false, reason: invocation.error || "no frozen run test authorization", invocation };
  let canonical;
  try { canonical = real(invocation.script); } catch { return { eligible: false, reason: "entrypoint is unavailable", invocation }; }
  const stat = fs.lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return { eligible: false, reason: "entrypoint identity is unsafe", identity: canonical, invocation };
  const digest = crypto.createHash("sha256").update(fs.readFileSync(canonical)).digest("hex");
  const frozen = authorization.existingEntrypoints.find((candidate) => candidate.path === canonical && candidate.sha256 === digest && candidate.bytes === stat.size);
  const dynamic = authorization.approvedDynamicScopes.some((scope) => path.normalize(scope) === path.normalize(canonical));
  if (!frozen && !dynamic) return { eligible: false, reason: "entrypoint is outside frozen test authority", identity: canonical, invocation };
  for (const preload of invocation.preloads) {
    let resolved;
    try { resolved = real(path.resolve(cwd, preload)); } catch { return { eligible: false, reason: `preload is not a canonical authorized file: ${preload}`, identity: canonical, invocation }; }
    let preloadFrozen = false;
    try {
      const preloadStat = fs.lstatSync(resolved);
      const preloadDigest = crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
      preloadFrozen = authorization.existingEntrypoints.some((candidate) =>
        candidate.path === resolved && candidate.sha256 === preloadDigest && candidate.bytes === preloadStat.size);
    } catch {}
    if (!preloadFrozen) return { eligible: false, reason: `preload identity/digest is outside frozen authority: ${preload}`, identity: canonical, invocation };
  }
  return { eligible: true, reason: frozen ? "exact frozen test entrypoint" : "entrypoint admitted by frozen dynamic test scope", identity: canonical, digest, invocation };
}
function redactSimple(value) { const redactor = new SecretSafeLog(); redactor.append(String(value)); return redactor.finish(); }
function canonicalSigned(value) { const copy = { ...value }; delete copy.auth; return JSON.stringify(copy); }
function sign(value, key) { return crypto.createHmac("sha256", key).update(canonicalSigned(value)).digest("hex"); }
function validSignature(value, key) {
  if (!value || typeof value.auth !== "string") return false;
  const expected = Buffer.from(sign(value, key), "hex");
  let actual;
  try { actual = Buffer.from(value.auth, "hex"); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function outputSpec(outputPath, authorization) {
  if (!authorization || !isWithin(authorization.workspaceRealPath, outputPath)) return { path: outputPath, error: "output destination escapes frozen workspace" };
  let parentRealPath;
  try { parentRealPath = real(path.dirname(outputPath)); } catch { return { path: outputPath, error: "output destination parent is unavailable" }; }
  if (!isWithin(authorization.workspaceRealPath, parentRealPath)) return { path: outputPath, error: "output destination parent escapes frozen workspace" };
  const parent = fs.lstatSync(parentRealPath, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) return { path: outputPath, error: "output destination parent is linked or non-directory" };
  if (fs.existsSync(outputPath)) {
    const leaf = fs.lstatSync(outputPath);
    if (leaf.isSymbolicLink()) return { path: outputPath, error: "output destination leaf is a link" };
    if (!leaf.isFile()) return { path: outputPath, error: "output destination leaf is not a regular file" };
  }
  return {
    path: path.join(parentRealPath, path.basename(outputPath)), parentRealPath,
    parentDevice: parent.dev.toString(), parentInode: parent.ino.toString(),
  };
}

function captureDeclaredFilesAfterSettlement(specs, workspaceRealPath, maxTotalBytes = 64 * 1024, readBudget) {
  const results = [];
  const stateScanBudgetBytes = 192 * 1024;
  let scanRemaining = stateScanBudgetBytes;
  let serializedRemaining = 48 * 1024;
  let bytesRead = 0;
  for (const spec of specs) {
    const base = { path: redactCompleteText(spec.path), historicalContent: "not_retained_during_execution" };
    if (spec.error) { results.push({ ...base, status: "unavailable", error: redactCompleteText(spec.error) }); continue; }
    let descriptor;
    try {
      if (!fs.existsSync(spec.path)) { results.push({ ...base, status: "missing" }); continue; }
      if (!scanRemaining) { results.push({ ...base, status: "unavailable", error: "post-settlement lexical-state scan budget exhausted" }); continue; }
      const parent = real(path.dirname(spec.path));
      if (parent !== spec.parentRealPath || !isWithin(workspaceRealPath, parent)) throw new Error("capture parent identity or containment changed");
      const parentStat = fs.lstatSync(parent, { bigint: true });
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
        || parentStat.dev.toString() !== String(spec.parentDevice)
        || parentStat.ino.toString() !== String(spec.parentInode)) throw new Error("capture parent identity changed");
      const beforeLeaf = fs.lstatSync(spec.path, { bigint: true });
      if (beforeLeaf.isSymbolicLink() || !beforeLeaf.isFile()
        || beforeLeaf.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("capture leaf is linked, non-regular, or too large");
      const openedSize = Number(beforeLeaf.size);
      const requestedRead = Math.min(openedSize, scanRemaining);
      if (readBudget && readBudget.reserveBeforeRead(requestedRead, "declared-file-capture") !== requestedRead) throw new Error("post-settlement shared read budget exhausted");
      const canonical = real(spec.path);
      if (!isWithin(workspaceRealPath, canonical)) throw new Error("capture leaf escapes workspace");
      descriptor = fs.openSync(spec.path, "r");
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== beforeLeaf.dev || opened.ino !== beforeLeaf.ino
        || opened.size !== beforeLeaf.size) throw new Error("capture opened-handle identity mismatch");
      const captured = Buffer.alloc(requestedRead);
      const actualRead = requestedRead ? fs.readSync(descriptor, captured, 0, requestedRead, 0) : 0;
      if (readBudget?.consumeActual) readBudget.consumeActual(actualRead, "declared-file-capture");
      if (actualRead !== requestedRead) throw new Error("capture read was torn or incomplete");
      const afterHandle = fs.fstatSync(descriptor, { bigint: true });
      const afterLeaf = fs.lstatSync(spec.path, { bigint: true });
      if (afterLeaf.isSymbolicLink() || afterHandle.dev !== opened.dev || afterHandle.ino !== opened.ino
        || afterHandle.size !== opened.size || afterLeaf.dev !== opened.dev || afterLeaf.ino !== opened.ino
        || afterLeaf.size !== opened.size || real(spec.path) !== canonical) throw new Error("capture identity changed during read");
      scanRemaining -= actualRead; bytesRead += actualRead;
      const completeLexicalScan = actualRead === openedSize;
      const unavailableTail = completeLexicalScan ? "" : "\n[tail unavailable: complete lexical-state scan exceeded bounded read budget]\n";
      const sanitized = redactCompleteText(captured.toString("utf8")) + unavailableTail;
      const serializedAllowance = Math.max(64, Math.min(serializedRemaining, 48 * 1024));
      const excerpt = fitJsonString(sanitized, serializedAllowance);
      serializedRemaining = Math.max(0, serializedRemaining - jsonStringBytes(excerpt));
      const truncated = !completeLexicalScan || openedSize > maxTotalBytes || excerpt !== sanitized;
      results.push({
        ...base, status: truncated ? "truncated" : "captured", size: openedSize, bytesRead: actualRead,
        contentLayout: completeLexicalScan ? "sanitized_complete_current_generation" : "sanitized_prefix_tail_explicitly_unavailable",
        lexicalStateScanComplete: completeLexicalScan,
        contentTruncatedForEnvelope: excerpt !== sanitized,
        head: excerpt, tail: "",
      });
    } catch (error) {
      results.push({ ...base, status: "unavailable", error: redactCompleteText(error?.message || String(error)) });
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); }
        catch (error) {
          let conclusivelyClosed = false;
          try { fs.fstatSync(descriptor); }
          catch (probeError) { conclusivelyClosed = probeError?.code === "EBADF"; }
          if (!conclusivelyClosed) throw new Error(`CAPTURE_DESCRIPTOR_CLOSE_UNRESOLVED: ${error?.code || error?.message || error}`);
        }
      }
    }
  }
  return { results, bytesRead, budgetBytes: maxTotalBytes, stateScanBudgetBytes };
}

async function supervise(options, nodeArgs) {
  const authKey = process.env.PI_ORC_NO_OUTPUT_AUTH;
  if (!authKey || authKey.length < 32) throw new Error("Missing command-scoped supervisor authentication");
  const cwd = real(process.cwd());
  const policy = validatePolicy(JSON.parse(options.policy));
  const hostManagedReadGrants = options["host-managed-capture"] === "true";
  if (!hostManagedReadGrants) throw new Error("COMMAND_TELEMETRY_OWNER_REQUIRED_FOR_CAPTURE");
  const authorization = loadAuthorization(options["authorization-file"], options["authorization-sha256"]);
  const userNodeOptions = process.env.PI_ORC_USER_NODE_OPTIONS || "";
  const classification = classifyTest(nodeArgs, cwd, authorization, userNodeOptions);
  let eligible = classification.eligible === true && process.platform === "win32";
  if (process.platform !== "win32" && classification.eligible) classification.reason = "direct-child I/O backend is verified only on Windows";
  const invocationId = crypto.randomBytes(12).toString("hex");
  const transportId = crypto.createHash("sha256").update(`${options["command-id"]}\0${invocationId}`, "utf8").digest("hex").slice(0, 32);
  const bindingGeneration = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(options["event-dir"], { recursive: true });
  fs.mkdirSync(options["evidence-root"], { recursive: true });
  const sharedReadBudget = new SharedReadBudget();
  const machine = new SilencePolicyMachine(policy);
  const log = new SecretSafeLog();
  const outputSpecs = [];
  let observationError;
  for (const outputPath of classification.invocation?.outputPaths ?? []) outputSpecs.push(outputSpec(outputPath, authorization));
  let sequence = 0;
  let cancellationRequested = false;
  let cancellationAccepted = false;
  let cancellationDecision;
  let alarmAckToken;
  const controlTypes = new Set(["no_output_alarm", "no_output_alarm_acknowledged", "cancellation_requested", "cancellation_action_returned", "observation_error"]);
  let ownerConfiguration;
  try { ownerConfiguration = JSON.parse(options["owner-config"] || ""); }
  catch { observationError = "command telemetry owner configuration unavailable"; }
  const telemetryClient = ownerConfiguration ? new CommandTelemetryClient(ownerConfiguration, invocationId) : undefined;
  let telemetryAvailable = false;
  const inboundOwnerEvents = [];
  if (telemetryClient) {
    telemetryClient.on("event", (event) => {
      if (inboundOwnerEvents.length >= 64) { observationError = "command telemetry inbound queue capacity exhausted"; return; }
      inboundOwnerEvents.push(event);
    });
    telemetryClient.on("transportError", (error) => {
      // An authenticated owner refusal is terminal for this invocation. Stop
      // feeding the closed client; a later invocation may recover with its own
      // fresh client and registration.
      telemetryAvailable = false;
      if (!observationError) observationError = error?.message || String(error);
    });
    try { await telemetryClient.connect(); telemetryAvailable = true; }
    catch (error) { observationError = `command telemetry registration unavailable: ${error?.message || error}`; }
  }
  const queuedPublications = [];
  let queuedPublicationBytes = 0;
  let publicationPump;
  const completeEvent = (payload) => {
    const event = { schemaVersion: 1, commandId: options["command-id"], invocationId, sequence: ++sequence, wallTime: new Date().toISOString(), ...payload };
    event.auth = sign(event, authKey);
    return event;
  };
  const pumpPublications = () => {
    if (publicationPump) return publicationPump;
    publicationPump = (async () => {
      while (queuedPublications.length) {
        const item = queuedPublications.shift();
        queuedPublicationBytes -= item.bytes;
        if (!telemetryAvailable || !telemetryClient) continue;
        try { await telemetryClient.publish(item.event, item.channel); }
        catch (error) { observationError = error?.message || String(error); }
      }
    })().finally(() => { publicationPump = undefined; if (queuedPublications.length) pumpPublications(); });
    return publicationPump;
  };
  const publish = (payload) => {
    const event = completeEvent(payload);
    const channel = controlTypes.has(String(payload.type)) ? "control" : "ordinary";
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    const frameLimit = channel === "control" ? 4096 : 64 * 1024;
    if (bytes > frameLimit || queuedPublicationBytes + bytes > 64 * 1024) {
      observationError = `${channel} telemetry queue capacity exhausted`;
      return undefined;
    }
    queuedPublications.push({ event, channel, bytes });
    queuedPublicationBytes += bytes;
    void pumpPublications();
    return event;
  };
  const flushPublications = async () => {
    while (publicationPump || queuedPublications.length) {
      if (publicationPump) await publicationPump;
      else await pumpPublications();
    }
  };
  const publishRequired = async (payload, channel) => {
    await flushPublications();
    if (!telemetryAvailable || !telemetryClient) return undefined;
    const event = completeEvent(payload);
    await telemetryClient.publish(event, channel);
    return event;
  };
  const publishActivity = (source, bytes = 0) => { publish({ type: "output_activity", source, bytes }); };
  const childEnv = {
    ...process.env,
    PATH: process.env.PI_ORC_NO_OUTPUT_ORIGINAL_PATH || process.env.PATH,
    NODE_OPTIONS: userNodeOptions,
    PI_ORC_IO_OBSERVER: "1",
  };
  for (const key of Object.keys(childEnv)) {
    if ((key.startsWith("PI_ORC_NO_OUTPUT_") && key !== "PI_ORC_IO_OBSERVER") || [
      "PI_ORCHESTRATOR_ALARM_ACK_ROOT", "PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE",
      "PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256", "PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT",
    ].includes(key)) delete childEnv[key];
  }
  const observerPath = options["io-observer"];
  const childArgs = observerPath ? ["--require", observerPath, ...nodeArgs] : nodeArgs;
  const environmentSha256 = crypto.createHash("sha256").update(JSON.stringify(Object.entries(childEnv).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  const invocationDescriptor = {
    executable: process.execPath,
    entrypoint: classification.identity,
    entrypointSha256: classification.digest,
    argvSha256: crypto.createHash("sha256").update(JSON.stringify(nodeArgs)).digest("hex"),
    argv: nodeArgs.slice(0, 64).map((arg) => utf8Prefix(redactSimple(arg), 512)),
    argvOmitted: Math.max(0, nodeArgs.length - 64),
    cwd,
    environmentSha256,
    nodeOptionsSha256: crypto.createHash("sha256").update(userNodeOptions).digest("hex"),
    preloads: (classification.invocation?.preloads ?? []).slice(0, 32).map((item) => utf8Prefix(redactSimple(item), 1024)),
    outputDestinationsSha256: crypto.createHash("sha256").update(JSON.stringify(outputSpecs.map((spec) => spec.path))).digest("hex"),
    outputDestinations: outputSpecs.slice(0, 32).map((spec) => utf8Prefix(spec.path, 1024)),
    observationBackend: "external-GetProcessIoCounters-plus-declared-file-observer",
  };
  const transportConfig = {
    authKey,
    supervisorPath: __filename,
    eventDir: options["event-dir"],
    evidenceRoot: options["evidence-root"],
    commandId: options["command-id"],
    policy,
    authorizationFile: options["authorization-file"],
    authorizationSha256: options["authorization-sha256"],
    ioObserverPath: options["io-observer"],
    ownerConfiguration: ownerConfiguration ? { ...ownerConfiguration, parentInvocationId: invocationId } : undefined,
  };
  const earliestCreationUnixMs = Date.now();
  const child = spawn(process.execPath, childArgs, { cwd, env: childEnv, stdio: ["inherit", "pipe", "pipe", "pipe", "pipe"], windowsHide: true, detached: false });
  child.stdio[4]?.end(JSON.stringify(transportConfig));
  const latestCreationUnixMs = Date.now();
  let coverageReady = false;
  let counterReady = false;
  let observationStarted = false;
  let descendantObserved = false;
  let counterSequence = 0;
  let lastCounterSampleAt = 0;
  let counterBaseline;
  const counterScheduler = new CounterSamplingScheduler(policy.pollMs);
  let freshCancellationSequence;
  let freshCancellationDrained = false;
  let counterWriteActivityCount = 0;
  let counterUncertaintyCount = 0;
  let counterBindingValidated = false;
  const ioDecoder = new StringDecoder("utf8");
  let ioRemainder = "";
  const maybeBeginObservation = () => {
    if (!observationStarted && coverageReady && counterReady && !observationError) {
      observationStarted = true;
      machine.beginObservation();
      publish({ type: "observation_ready", backend: "GetProcessIoCounters", queryOnlyAccess: 4096 });
    }
  };
  const onIoFrame = (frame) => {
    if (!frame || frame.schemaVersion !== 1) return;
    if (frame.type === "coverage_ready") {
      coverageReady = true;
      maybeBeginObservation();
      publish({ type: "coverage_ready", workerThreadsSupported: frame.workerThreadsSupported === true });
    } else if (frame.type === "descendant_process") {
      descendantObserved = true; observationError = `output-producing descendant possible via ${String(frame.api || "unknown")}`;
      publish({ type: "observation_error", error: observationError });
    } else if (frame.type === "transport_child") {
      descendantObserved = true;
      observationError = "parent cancellation disabled while an output-producing descendant is independently supervised";
      publish({ type: "independent_child_transport", supported: frame.supported === true });
    } else if (frame.type === "worker_thread") {
      publish({ type: "worker_thread_coverage", supported: frame.supported === true });
    } else if (frame.type === "unobservable_io_backend") {
      observationError = `unobservable direct-child I/O backend via ${String(frame.api || "unknown")}`;
      publish({ type: "observation_error", error: observationError });
    }
  };
  let childExited = false;
  child.once("exit", () => { childExited = true; });
  const observationChannelFailed = (reason) => {
    if (childExited || cancellationRequested || observationError) return;
    coverageReady = false;
    observationError = reason;
    publish({ type: "observation_error", error: reason });
  };
  child.stdio[3]?.on("data", (chunk) => {
    const combined = ioRemainder + ioDecoder.write(chunk);
    const lines = combined.split(/\r?\n/); ioRemainder = lines.pop() || "";
    if (Buffer.byteLength(ioRemainder, "utf8") > 16 * 1024) { observationError = "I/O observer frame exceeded bound"; ioRemainder = ""; }
    for (const line of lines) if (line) {
      let frame;
      try { frame = JSON.parse(line); } catch { observationError = "I/O observer frame decode failed"; continue; }
      try { onIoFrame(frame); } catch (error) { observationError = `I/O observer handling failed: ${error?.message || error}`; }
    }
  });
  child.stdio[3]?.once("error", () => observationChannelFailed("direct-child I/O observation channel errored"));
  child.stdio[3]?.once("close", () => setImmediate(() => observationChannelFailed("direct-child I/O observation channel closed")));
  publish({ type: "invocation_started", executable: process.execPath, eligibility: { eligible, reason: classification.reason, identity: classification.identity }, invocationDescriptor, observedSources: ["stdout", "stderr", "process-wide-write-counters", ...outputSpecs.map((spec) => `post-settlement-file:${spec.path}`)], observationHealthy: false });
  publish({
    type: "counter_registration",
    pid: child.pid,
    transportId,
    bindingGeneration,
    expectedExecutable: process.execPath,
    earliestCreationUnixMs,
    latestCreationUnixMs,
  });
  const labeledSources = new Set();
  const observe = (source, chunk) => {
    machine.observeOutput(); freshCancellationSequence = undefined; freshCancellationDrained = false;
    if (!labeledSources.has(source)) { log.appendLabel(source); labeledSources.add(source); }
    log.append(chunk);
    publishActivity(source, chunk.length);
    (source === "stdout" ? process.stdout : process.stderr).write(chunk);
  };
  child.stdout?.on("data", (chunk) => observe("stdout", chunk));
  child.stderr?.on("data", (chunk) => observe("stderr", chunk));
  let pendingAlarmAcknowledgement;
  const acknowledgeIfPresent = () => {
    if (!pendingAlarmAcknowledgement || !alarmAckToken || machine.alarmAcknowledgedMonotonicMs !== undefined) return;
    const ack = pendingAlarmAcknowledgement;
    pendingAlarmAcknowledgement = undefined;
    if (ack.commandId !== options["command-id"] || ack.invocationId !== invocationId || ack.ackToken !== alarmAckToken || !validSignature(ack, authKey)) {
      observationError = "alarm acknowledgement authentication failed"; return;
    }
    if (machine.acknowledgeAlarm()) publish({ type: "no_output_alarm_acknowledged", monotonicMs: machine.alarmAcknowledgedMonotonicMs });
  };
  let observationTransportGeneration = 0;
  const requestCounterSample = (requestGeneration) => {
    if (!counterReady || observationError) return;
    publish({
      transportId,
      bindingGeneration,
      type: "counter_sample_request",
      requestGeneration,
      requestId: crypto.randomBytes(16).toString("hex"),
    });
  };
  const handleCounterState = (state) => {
    if (!validSignature(state, authKey) || state.commandId !== options["command-id"] || state.invocationId !== invocationId) {
      observationError = "counter state authentication failed"; counterReady = false; return;
    }
    if (state.type === "counter_error") {
      observationError = `counter observation failed: ${String(state.message || "unknown")}`;
      counterReady = false; counterScheduler.fail();
      publish({ type: "observation_error", error: observationError });
      return;
    }
    if (state.type === "counter_registered") {
      if (state.desiredAccess !== 4096 || path.resolve(state.executable).toLowerCase() !== path.resolve(process.execPath).toLowerCase()) {
        observationError = "counter registration identity or query-only permission mismatch"; counterReady = false; return;
      }
      counterReady = true;
      counterBindingValidated = true;
      invocationDescriptor.counterBinding = {
        desiredAccess: 4096,
        executable: state.executable,
        creationUnixMs: state.creationUnixMs,
      };
      lastCounterSampleAt = performance.now();
      return;
    }
    if (state.type !== "counter_sample") return;
    const counterStateSequence = Number(state.sequence);
    const fields = ["readOperations", "writeOperations", "otherOperations", "readTransfer", "writeTransfer", "otherTransfer"];
    const snapshot = {};
    for (const field of fields) {
      const value = Number(state[field]);
      if (!Number.isSafeInteger(value) || value < 0) { observationError = `invalid counter ${field}`; counterReady = false; return; }
      snapshot[field] = value;
    }
    if (counterSequence !== 0 && counterStateSequence <= counterSequence) { observationError = `counter sequence reordered expected>${counterSequence} observed=${counterStateSequence}`; counterReady = false; return; }
    if (counterSequence !== 0 && counterStateSequence > counterSequence + 1) publish({ type: "counter_snapshot_coalesced", fromSequence: counterSequence, toSequence: counterStateSequence });
    if (counterBaseline) {
      for (const field of fields) if (snapshot[field] < counterBaseline[field]) { observationError = `counter decreased: ${field}`; counterReady = false; return; }
      if (snapshot.writeOperations > counterBaseline.writeOperations || snapshot.writeTransfer > counterBaseline.writeTransfer) {
        counterWriteActivityCount += 1;
        machine.observeOutput(); freshCancellationSequence = undefined; freshCancellationDrained = false;
        publishActivity("process-wide-write-counters", snapshot.writeTransfer - counterBaseline.writeTransfer);
      }
      if (snapshot.otherOperations > counterBaseline.otherOperations || snapshot.otherTransfer > counterBaseline.otherTransfer) {
        counterUncertaintyCount += 1;
        machine.observeOutput(); freshCancellationSequence = undefined; freshCancellationDrained = false;
        publish({ type: "observation_uncertainty", source: "process-wide-other-io-counters" });
      }
    }
    if (!counterScheduler.acceptResponse(Number(state.requestGeneration))) { observationError = "counter response did not match outstanding scheduled request"; counterReady = false; return; }
    counterBaseline = snapshot;
    counterSequence = counterStateSequence;
    lastCounterSampleAt = performance.now();
    counterReady = true;
    maybeBeginObservation();
  };
  const pollCounter = () => {
    while (inboundOwnerEvents.length) {
      const state = inboundOwnerEvents.shift();
      if (state?.type === "alarm_ack") { pendingAlarmAcknowledgement = state; continue; }
      if (state?.type !== "counter_error") {
        if (state?.bindingGeneration !== bindingGeneration) { observationError = "counter binding generation mismatch"; counterReady = false; continue; }
        const generation = Number(state.transportGeneration);
        if (!Number.isSafeInteger(generation) || generation <= observationTransportGeneration) continue;
        observationTransportGeneration = generation;
      }
      try { handleCounterState(state); }
      catch { observationError = "counter transport decode failed"; counterReady = false; }
    }
  };
  const timer = setInterval(() => {
    pollCounter();
    acknowledgeIfPresent();
    const now = performance.now();
    if (!observationError) {
      const scheduledGeneration = counterScheduler.tick(now, counterReady);
      if (scheduledGeneration !== undefined) requestCounterSample(scheduledGeneration);
    }
    if (!observationError && observationStarted && counterReady && now - lastCounterSampleAt > Math.max(1000, policy.pollMs * 5)) {
      observationError = "counter observation became stale";
      counterReady = false;
      publish({ type: "observation_error", error: observationError });
    }
    if (!observationStarted) return;
    const decision = machine.tick();
    if (!decision) return;
    if (decision.kind === "alarm") {
      alarmAckToken = crypto.randomBytes(16).toString("hex");
      freshCancellationSequence = undefined;
      freshCancellationDrained = false;
      publish({ type: "no_output_alarm", ackToken: alarmAckToken, elapsedMs: decision.elapsedMs, noOutputMs: decision.noOutputMs, monotonicMs: decision.now, episode: decision.episode, eligibility: { eligible: eligible && coverageReady && counterReady && !descendantObserved && !observationError, reason: observationError || (!counterReady ? "external counter sampler not ready" : !coverageReady ? "coverage declaration channel not ready" : classification.reason) } });
      return;
    }
    if (!eligible || !coverageReady || !counterReady || descendantObserved || observationError || cancellationRequested) return;
    if (freshCancellationSequence === undefined) { freshCancellationSequence = counterSequence; counterScheduler.requestFresh(); return; }
    if (counterSequence <= freshCancellationSequence) return;
    if (!freshCancellationDrained) { freshCancellationDrained = true; return; }
    pollCounter();
    acknowledgeIfPresent();
    const rechecked = machine.tick();
    if (!rechecked || rechecked.kind !== "cancel" || !coverageReady || !counterReady || descendantObserved || observationError || child.exitCode !== null || child.signalCode !== null || !child._handle) return;
    cancellationRequested = true;
    cancellationDecision = rechecked;
    publish({ type: "cancellation_requested", elapsedMs: rechecked.elapsedMs, noOutputMs: rechecked.noOutputMs, monotonicMs: rechecked.now, alarmMonotonicMs: rechecked.alarmMonotonicMs, alarmAcknowledgedMonotonicMs: rechecked.alarmAcknowledgedMonotonicMs, target: "retained-direct-test-child-handle" });
    cancellationAccepted = child.kill();
    publish({ type: "cancellation_action_returned", accepted: cancellationAccepted, target: "retained-direct-test-child-handle" });
  }, policy.pollMs);
  timer.unref?.();
  const settlement = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  clearInterval(timer);
  const ioTail = ioDecoder.end();
  if (ioTail || ioRemainder) {
    const line = ioRemainder + ioTail;
    if (line) { try { onIoFrame(JSON.parse(line)); } catch { observationError = "I/O observer terminal frame decode failed"; } }
  }
  const declaredFileCapture = { results: [], bytesRead: 0, budgetBytes: 64 * 1024,
    status: authorization ? "host_capture_requested" : "unavailable" };
  // Without frozen authority there is no approved workspace to capture. The
  // original child still settles naturally; do not dereference absent policy
  // or manufacture a host capture request from its untrusted cwd.
  if (authorization) publish({
    type: "declared_file_capture_request",
    workspaceRealPath: authorization.workspaceRealPath,
    specs: outputSpecs.slice(0, 32),
    maxTotalBytes: 64 * 1024,
  });
  machine.finalize();
  const terminalAt = performance.now();
  const confirmed = cancellationRequested && cancellationAccepted && settlement.code === null && settlement.signal === "SIGTERM";
  const partialLog = log.finish();
  let artifactPath;
  let artifactSha256;
  let artifactBytes;
  let artifactError;
  if (confirmed) {
    const artifactName = `${crypto.createHash("sha256").update(`${options["command-id"]}\0${invocationId}`).digest("hex")}.json`;
    artifactPath = path.join(options["evidence-root"], artifactName);
    const artifact = {
      schemaVersion: 1, outcome: "cancelled_no_output", commandId: options["command-id"], invocationId,
      summary: `Cancelled after ${((terminalAt - machine.lastOutputMonotonicMs) / 60000).toFixed(3)} minutes with no output.`,
      noOutputMs: terminalAt - machine.lastOutputMonotonicMs, totalElapsedMs: terminalAt - machine.startedMonotonicMs,
      alarmMonotonicMs: machine.alarmMonotonicMs, alarmAcknowledgedMonotonicMs: machine.alarmAcknowledgedMonotonicMs,
      cancelledMonotonicMs: terminalAt, cancellationRequested: true, cancellationAccepted: true, cancellationConfirmed: true,
      confirmationBasis: "terminal_signal_after_owned_handle_action", terminalExitCode: settlement.code, terminalSignal: settlement.signal,
      cancellationTarget: "retained-direct-test-child-handle", eligibility: "authenticated_run_owned_test_child",
      observedSources: ["stdout", "stderr", "process-wide-write-counters", ...outputSpecs.map((spec) => `post-settlement-file:${spec.path}`)],
      observationErrors: observationError ? [observationError] : [], invocationDescriptor, declaredFileCapture, partialLog,
    };
    try {
      const fittedArtifact = fitEvidenceObject(artifact, 120 * 1024);
      const serializedArtifact = fittedArtifact.bytes;
      artifactBytes = serializedArtifact.byteLength;
      artifactSha256 = crypto.createHash("sha256").update(serializedArtifact).digest("hex");
      fs.writeFileSync(artifactPath, serializedArtifact, { mode: 0o600 });
    } catch (error) {
      artifactError = `artifact unavailable: ${error?.code || error?.message || String(error)}`;
      artifactPath = undefined; artifactSha256 = undefined; artifactBytes = undefined;
    }
  }
  const terminalSummary = confirmed
    ? `Cancelled after ${((terminalAt - machine.lastOutputMonotonicMs) / 60000).toFixed(3)} minutes with no output.`
    : undefined;
  try {
    await publishRequired({
      type: "invocation_terminal", transportId, bindingGeneration, outcome: confirmed ? "cancelled_no_output" : settlement.code === 0 ? "succeeded" : "failed",
      summary: terminalSummary,
      cancellationRequested, cancellationAccepted, cancellationConfirmed: confirmed,
      confirmationBasis: confirmed ? "terminal_signal_after_owned_handle_action" : "terminal_outcome_did_not_confirm_action",
      exitCode: settlement.code, signal: settlement.signal, totalElapsedMs: terminalAt - machine.startedMonotonicMs,
      noOutputMs: terminalAt - machine.lastOutputMonotonicMs, alarmMonotonicMs: machine.alarmMonotonicMs,
      alarmAcknowledgedMonotonicMs: machine.alarmAcknowledgedMonotonicMs, cancelledMonotonicMs: confirmed ? terminalAt : undefined,
      cancellationTarget: "retained-direct-test-child-handle",
      eligibility: "authenticated_run_owned_test_child",
      observedSources: ["stdout", "stderr", "process-wide-write-counters", ...outputSpecs.map((spec) => `post-settlement-file:${spec.path}`)],
      observationErrors: observationError ? [observationError] : [],
      observationError, counterWriteActivityCount, counterUncertaintyCount, counterBindingValidated,
      sharedReadAccounting: sharedReadBudget.accounting(),
      artifactPath, artifactSha256, artifactBytes, artifactError, invocationDescriptor, declaredFileCapture,
      partialLogHead: confirmed ? utf8Prefix(partialLog, 8 * 1024) : undefined,
      partialLogTail: confirmed ? utf8Tail(partialLog, 8 * 1024) : undefined,
    }, "terminal");
  } finally {
    await telemetryClient?.close();
  }
  process.exitCode = confirmed ? 86 : (typeof settlement.code === "number" ? settlement.code : 1);
}

async function main() { const { options, nodeArgs } = parseCli(process.argv.slice(2)); await supervise(options, nodeArgs); }
module.exports = {
  DEFAULT_POLICY,
  SilencePolicyMachine,
  SecretSafeLog,
  CounterSamplingScheduler, // @internal: isolated production-path regressions only
  SharedReadBudget, // @internal: isolated production-path regressions only
  captureDeclaredFilesAfterSettlement,
  classifyTest,
  validatePolicy,
};
if (require.main === module) main().catch((error) => { console.error(`NO_OUTPUT_SUPERVISOR_ERROR: ${error?.message || error}`); process.exitCode = 1; });
