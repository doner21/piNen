#!/usr/bin/env node
"use strict";

/**
 * P-JOURNAL-COMMIT-BOUNDARY: standalone regression for commitCancellationJournalEntry's
 * pre-append/committed boundary and the post-commit notification-failure diagnostic.
 *
 * Every case runs on real files in an isolated, contained scratch root, using one-shot
 * hooks on the actual imported fs.appendFileSync / fs.truncateSync (the same seam the
 * production caller uses). No child process, no timer, nothing asynchronous.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");

// Isolation: a fresh, absolute, nonempty, contained scratch root created BEFORE any
// repository import. Prefer ITEM3_EVIDENCE_PARENT (set by run-check.cjs); otherwise an
// mkdtemp under os.tmpdir().
const evidenceParent = process.env.ITEM3_EVIDENCE_PARENT;
const parentForMkdtemp = evidenceParent || os.tmpdir();
const TEMP_ROOT = fs.mkdtempSync(path.join(parentForMkdtemp, "journal-boundary-"));
const tempRealPath = fs.realpathSync(TEMP_ROOT);
const temporaryParent = `${fs.realpathSync(parentForMkdtemp)}${path.sep}`;
if (!path.isAbsolute(tempRealPath) || tempRealPath.length === 0 || !tempRealPath.startsWith(temporaryParent)) {
  throw new Error("JOURNAL_BOUNDARY_ROOT_NOT_CONTAINED");
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
const isolatedTmp = path.join(TEMP_ROOT, "tmp");
fs.mkdirSync(isolatedTmp, { recursive: true });
for (const key of ["TMP", "TEMP", "TMPDIR"]) {
  if (!process.env[key] || !path.isAbsolute(process.env[key])) process.env[key] = isolatedTmp;
}

// Load the live monitor module through the same jiti setup as
// tests/test-2026-09-25-ownership-enumeration.cjs (lines ~45-52).
const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const monitor = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));

// A repeated call to commitCancellationJournalEntry through the SAME jiti-compiled
// module instance stops re-reading fs.appendFileSync/truncateSync dynamically after
// the first successful call (observed empirically: V8's inline cache for the
// property load inside the compiled function specializes after one monomorphic
// hit and no longer reflects a later reassignment of fs.appendFileSync on this
// instance). A freshly jiti-compiled instance has its own, unspecialized call
// site, so every call whose fault hook must be observed uses one. This mirrors
// tests/test-2026-09-25-ownership-enumeration.cjs's own loadFreshMonitor helper.
function loadFreshMonitor(evidenceRoot, label) {
  const loader = createJiti(path.join(evidenceRoot, `${label}-loader.cjs`), {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
  });
  return loader(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
}

const native = Object.freeze({
  appendFileSync: fs.appendFileSync,
  truncateSync: fs.truncateSync,
});

function syncFilesystemExports() { Module.syncBuiltinESMExports?.(); }
function restoreFilesystem() {
  for (const [name, implementation] of Object.entries(native)) fs[name] = implementation;
  syncFilesystemExports();
}
function samePath(left, right) { return path.resolve(String(left)) === path.resolve(String(right)); }
function makeCaseRoot(id) {
  const root = path.join(TEMP_ROOT, id.replace(/[^a-z0-9-]/gi, "-"));
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function lineFor(marker) { return `${JSON.stringify({ marker })}\n`; }
function unproven(message) {
  const error = new Error(message);
  error.journalBoundaryUnproven = true;
  return error;
}

// One-shot fault hooks, path-matched to the case journal, counted and self-disarming.
function armOneShotAppendFault(journal, error, prefixLength) {
  let hits = 0;
  let armed = true;
  fs.appendFileSync = function hookedAppend(file, value, ...args) {
    if (armed && samePath(file, journal)) {
      armed = false;
      hits += 1;
      native.appendFileSync.call(this, file, String(value).slice(0, prefixLength), ...args);
      throw error;
    }
    return native.appendFileSync.call(this, file, value, ...args);
  };
  syncFilesystemExports();
  return () => hits;
}
function armOneShotTruncateFault(journal, error) {
  let hits = 0;
  let armed = true;
  fs.truncateSync = function hookedTruncate(file, ...args) {
    if (armed && samePath(file, journal)) {
      armed = false;
      hits += 1;
      throw error;
    }
    return native.truncateSync.call(this, file, ...args);
  };
  syncFilesystemExports();
  return () => hits;
}

const results = [];
function runCase(id, body) {
  const evidenceRoot = makeCaseRoot(id);
  let status = "pass";
  let message = "";
  try {
    body(evidenceRoot);
  } catch (error) {
    if (error && error.journalBoundaryUnproven) {
      status = "unproven";
      message = error.message;
    } else if (error instanceof assert.AssertionError) {
      status = "red";
      message = error.message;
    } else {
      status = "red";
      message = (error && error.message) || String(error);
    }
  } finally {
    restoreFilesystem();
  }
  results.push({ id, status, message });
  console.log(`JOURNAL_BOUNDARY_CASE ${id} ${status} ${message}`);
}

// ---------------------------------------------------------------------------
// jb-healthy-control: two healthy commits, committedBytes maintained by the
// caller exactly as the production sealCancellation caller does.
// ---------------------------------------------------------------------------
function jbHealthyControl(evidenceRoot) {
  const journal = path.join(evidenceRoot, "cancellations.jsonl");
  const hash = crypto.createHash("sha256");
  const lineA = lineFor("JB_HEALTHY_A");
  const lineB = lineFor("JB_HEALTHY_B");
  let committed = 0;
  let committedBytes = 0;
  monitor.commitCancellationJournalEntry({
    commandJournalPath: journal, line: lineA, commandJournalHash: hash, committedBytes,
    recordCommitted() { committed += 1; committedBytes += Buffer.byteLength(lineA, "utf8"); },
    publishUpdate() {},
  });
  monitor.commitCancellationJournalEntry({
    commandJournalPath: journal, line: lineB, commandJournalHash: hash, committedBytes,
    recordCommitted() { committed += 1; committedBytes += Buffer.byteLength(lineB, "utf8"); },
    publishUpdate() {},
  });
  const bytes = fs.readFileSync(journal, "utf8");
  assert.equal(bytes, lineA + lineB, "healthy commits must append exactly A then B with no loss or duplication");
  assert.equal(committed, 2, "both healthy commits must be counted");
  assert.equal(
    hash.copy().digest("hex"),
    crypto.createHash("sha256").update(lineA + lineB, "utf8").digest("hex"),
    "the retained hash must track exactly the committed bytes",
  );
  const lines = bytes.trim().split(/\r?\n/);
  assert.equal(lines.length, 2, "exactly two journal lines");
  for (const l of lines) JSON.parse(l);
}

// ---------------------------------------------------------------------------
// jb-partial-append-prior-prefix: a failed append must not leave untracked
// bytes concatenated onto the prior committed prefix (rule part a).
// ---------------------------------------------------------------------------
function jbPartialAppendPriorPrefix(evidenceRoot) {
  const journal = path.join(evidenceRoot, "cancellations.jsonl");
  const hash = crypto.createHash("sha256");
  const lineA = lineFor("JB_PARTIAL_A");
  const lineB = lineFor("JB_PARTIAL_B");
  let committed = 0;
  loadFreshMonitor(evidenceRoot, "commit-a").commitCancellationJournalEntry({
    commandJournalPath: journal, line: lineA, commandJournalHash: hash, committedBytes: 0,
    recordCommitted() { committed += 1; },
    publishUpdate() {},
  });
  const boundaryAfterA = Buffer.byteLength(lineA, "utf8");
  const hookError = Object.assign(new Error("jb-partial-append EIO"), { code: "EIO" });
  const appendHits = armOneShotAppendFault(journal, hookError, 7);

  // A freshly loaded monitor instance for the faulted call: see loadFreshMonitor's
  // comment above for why reusing an already-called instance here would silently
  // bypass the fault hook instead of observing it.
  let thrown;
  try {
    loadFreshMonitor(evidenceRoot, "commit-b-faulted").commitCancellationJournalEntry({
      commandJournalPath: journal, line: lineB, commandJournalHash: hash, committedBytes: boundaryAfterA,
      recordCommitted() { committed += 1; },
      publishUpdate() {},
    });
  } catch (error) { thrown = error; }

  if (appendHits() !== 1) throw unproven(`premise: appendFileSync hook was not hit exactly once (hits=${appendHits()})`);
  assert.equal(thrown, hookError, "the original append error must be rethrown unchanged");
  assert.equal(fs.readFileSync(journal, "utf8"), lineA, "failed append leaves the committed prefix exactly");
  assert.equal(committed, 1, "the failed commit must not be counted");
  assert.equal(
    hash.copy().digest("hex"),
    crypto.createHash("sha256").update(lineA, "utf8").digest("hex"),
    "hash must reflect only A after the failed append",
  );

  restoreFilesystem();
  loadFreshMonitor(evidenceRoot, "commit-b-retry").commitCancellationJournalEntry({
    commandJournalPath: journal, line: lineB, commandJournalHash: hash, committedBytes: boundaryAfterA,
    recordCommitted() { committed += 1; },
    publishUpdate() {},
  });
  const finalBytes = fs.readFileSync(journal, "utf8");
  assert.equal(finalBytes, lineA + lineB, "retry after fault removal must append exactly A then B with no corrupt or duplicate record");
  assert.equal(committed, 2, "both commits counted after retry");
  assert.equal(
    hash.copy().digest("hex"),
    crypto.createHash("sha256").update(lineA + lineB, "utf8").digest("hex"),
    "hash must reflect A+B after retry",
  );
  const lines = finalBytes.trim().split(/\r?\n/);
  assert.equal(lines.filter((l) => l.includes("JB_PARTIAL_B")).length, 1, "exactly one record with B's marker");
}

// ---------------------------------------------------------------------------
// jb-reconcile-failure-then-retry: when the post-failure reconcile truncate
// also fails, both errors must be retained, and a later retry must still
// succeed cleanly (rule part a, reconcile-before-retry).
// ---------------------------------------------------------------------------
function jbReconcileFailureThenRetry(evidenceRoot) {
  const journal = path.join(evidenceRoot, "cancellations.jsonl");
  const hash = crypto.createHash("sha256");
  const lineA = lineFor("JB_RECONCILE_A");
  const lineB = lineFor("JB_RECONCILE_B");
  let committed = 0;
  loadFreshMonitor(evidenceRoot, "commit-a").commitCancellationJournalEntry({
    commandJournalPath: journal, line: lineA, commandJournalHash: hash, committedBytes: 0,
    recordCommitted() { committed += 1; },
    publishUpdate() {},
  });
  const boundaryAfterA = Buffer.byteLength(lineA, "utf8");
  const appendError = Object.assign(new Error("jb-reconcile-append EIO"), { code: "EIO" });
  const truncateError = Object.assign(new Error("jb-reconcile-truncate EIO"), { code: "EIO" });
  const appendHits = armOneShotAppendFault(journal, appendError, 7);
  const truncateHits = armOneShotTruncateFault(journal, truncateError);

  let thrown;
  try {
    loadFreshMonitor(evidenceRoot, "commit-b-faulted").commitCancellationJournalEntry({
      commandJournalPath: journal, line: lineB, commandJournalHash: hash, committedBytes: boundaryAfterA,
      recordCommitted() { committed += 1; },
      publishUpdate() {},
    });
  } catch (error) { thrown = error; }

  if (appendHits() !== 1) throw unproven(`premise: appendFileSync hook was not hit exactly once (hits=${appendHits()})`);
  assert.ok(thrown, "the failed commit must throw");
  assert.equal(committed, 1, "the failed commit must not be counted");
  assert.equal(
    hash.copy().digest("hex"),
    crypto.createHash("sha256").update(lineA, "utf8").digest("hex"),
    "hash must reflect only A after the failed append",
  );

  restoreFilesystem();
  loadFreshMonitor(evidenceRoot, "commit-b-retry").commitCancellationJournalEntry({
    commandJournalPath: journal, line: lineB, commandJournalHash: hash, committedBytes: boundaryAfterA,
    recordCommitted() { committed += 1; },
    publishUpdate() {},
  });
  const finalBytes = fs.readFileSync(journal, "utf8");
  assert.equal(finalBytes, lineA + lineB, "retry after fault removal must append exactly A then B with no corrupt or duplicate record");
  assert.equal(committed, 2, "both commits counted after retry");
  assert.equal(
    hash.copy().digest("hex"),
    crypto.createHash("sha256").update(lineA + lineB, "utf8").digest("hex"),
    "hash must reflect A+B after retry",
  );
  const lines = finalBytes.trim().split(/\r?\n/);
  assert.equal(lines.length, 2, "exactly two JSON lines");
  for (const l of lines) JSON.parse(l);

  // Last: the reconcile-truncate hook and the retained double-error shape.
  assert.equal(truncateHits(), 1, "the truncate hook must be hit exactly once");
  assert.ok(thrown instanceof AggregateError, "the retained throw must be an AggregateError combining both failures");
  assert.equal(thrown.errors.length, 2, "both the append and reconcile errors must be retained");
  assert.equal(thrown.errors[0], appendError, "errors[0] must be the append error");
  assert.equal(thrown.errors[1], truncateError, "errors[1] must be the truncate error");
}

// ---------------------------------------------------------------------------
// jb-update-failure-committed-once: a publishUpdate throw after a durable
// append must not be rethrown, and must not reclassify the durable record
// (rule part b).
// ---------------------------------------------------------------------------
function jbUpdateFailureCommittedOnce(evidenceRoot) {
  const journal = path.join(evidenceRoot, "cancellations.jsonl");
  const hash = crypto.createHash("sha256");
  const lineA = lineFor("JB_UPDATE_A");
  const lineB = lineFor("JB_UPDATE_B");
  let committed = 0;
  monitor.commitCancellationJournalEntry({
    commandJournalPath: journal, line: lineA, commandJournalHash: hash, committedBytes: 0,
    recordCommitted() { committed += 1; },
    publishUpdate() {},
  });
  const boundaryAfterA = Buffer.byteLength(lineA, "utf8");
  const notifyError = new Error("jb-update-failure publishUpdate throw");
  let thrown;
  let result;
  try {
    result = monitor.commitCancellationJournalEntry({
      commandJournalPath: journal, line: lineB, commandJournalHash: hash, committedBytes: boundaryAfterA,
      recordCommitted() { committed += 1; },
      publishUpdate() { throw notifyError; },
    });
  } catch (error) { thrown = error; }

  assert.equal(thrown, undefined, "post-commit notification failure does not throw");
  assert.equal(fs.readFileSync(journal, "utf8"), lineA + lineB, "the durable record for B must be complete and exactly once");
  assert.equal(committed, 2, "the durable commit for B must still be counted despite the notification failure");
  assert.equal(
    hash.copy().digest("hex"),
    crypto.createHash("sha256").update(lineA + lineB, "utf8").digest("hex"),
    "hash must reflect A+B",
  );
  assert.equal(result && result.notificationFailure, notifyError, "the returned notificationFailure must be the same Error object");
}

// ---------------------------------------------------------------------------
// jb-update-failure-no-retry-append-through-queue: a publishUpdate throw must
// not leave a just-committed terminal pending in the production queue, which
// is what previously caused the next drain turn to append the same canonical
// record a second time (rule part b, through ArtifactTerminalSettlementQueue).
// ---------------------------------------------------------------------------
function jbUpdateFailureNoRetryAppendThroughQueue(evidenceRoot) {
  const journal = path.join(evidenceRoot, "cancellations.jsonl");
  const hash = crypto.createHash("sha256");
  const line = lineFor("JB_QUEUE_RECORD");
  let committed = 0;
  let lastResult;
  const invocationId = "jb-queue-invocation";
  const event = { invocationId };
  const queue = new monitor.ArtifactTerminalSettlementQueue();

  const makeCommit = (publishUpdateImpl) => () => {
    lastResult = monitor.commitCancellationJournalEntry({
      commandJournalPath: journal, line, commandJournalHash: hash, committedBytes: 0,
      recordCommitted() { committed += 1; },
      publishUpdate: publishUpdateImpl,
    });
  };

  // settle #1: the load defers the terminal (retry:true); it becomes pending.
  const settled1 = queue.settle(event, () => ({ retry: true }), makeCommit(() => {}));
  assert.equal(settled1, false, "a retry:true load must not settle on the first attempt");
  assert.equal(queue.hasPending(), true, "the deferred terminal must be pending after the first settle");

  // settle #2: the load resolves; the commit callback's publishUpdate throws once.
  const notifyError = new Error("jb-queue-update-failure");
  let settle2Thrown;
  let settled2;
  try {
    settled2 = queue.settle(event, () => ({ retry: false }), makeCommit(() => { throw notifyError; }));
  } catch (error) { settle2Thrown = error; }

  // Exactly one drain-equivalent turn, as the monitor drain does. No loop.
  if (queue.hasPending()) {
    queue.settle(queue.firstPending(), () => ({ retry: false }), makeCommit(() => {}));
  }

  const bytes = fs.readFileSync(journal, "utf8");
  const lines = bytes.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, "exactly one canonical record");
  assert.equal(committed, 1, "the durable record must be counted exactly once");
  assert.equal(settle2Thrown, undefined, "settle #2 must not throw");
  assert.equal(settled2, true, "settle #2 must report settlement");
  assert.equal(queue.hasPending(), false, "the queue must have no pending terminal after settle #2");
  assert.equal(lastResult && lastResult.notificationFailure, notifyError, "the notification failure must be retained by the commit callback");
}

runCase("jb-healthy-control", jbHealthyControl);
runCase("jb-partial-append-prior-prefix", jbPartialAppendPriorPrefix);
runCase("jb-reconcile-failure-then-retry", jbReconcileFailureThenRetry);
runCase("jb-update-failure-committed-once", jbUpdateFailureCommittedOnce);
runCase("jb-update-failure-no-retry-append-through-queue", jbUpdateFailureNoRetryAppendThroughQueue);

const notPass = results.filter((r) => r.status !== "pass");
if (notPass.length > 0) {
  console.log(`PRESERVED_FAILURE_ROOT ${TEMP_ROOT}`);
  throw new Error(`JOURNAL_BOUNDARY_FAILED ${JSON.stringify(notPass)}`);
}
console.log(`PASS item3 journal commit boundary cases=${results.length}`);
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
