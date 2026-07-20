#!/usr/bin/env node
/**
 * Item A tests — deterministic non-LLM phase primitive (src/deterministic-phase.ts).
 * ==================================================================================
 * Temp-dir fixtures. Covers each op happy path; verify-hash mismatch produces a
 * structured (non-throwing) failure; freeze-record refuses to overwrite;
 * manifest missing-file fails closed; checkpoint round-trip carries the
 * deterministic marker + outputs through RunStateStore; and a static assertion
 * that the module contains no child_process/network/exec/spawn surface.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
function makeJiti() { return createJiti(__filename, { interopDefault: true, moduleCache: false }); }

function loadModule() {
  return makeJiti()(path.join(PROJECT_ROOT, "src", "deterministic-phase.ts"));
}
function loadRunState() {
  return makeJiti()(path.join(PROJECT_ROOT, "src", "run-state.ts"));
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-det-phase-"));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function testHashFile() {
  const mod = loadModule();
  await withTempDir(async (dir) => {
    const content = Buffer.from("hello deterministic world\n");
    fs.writeFileSync(path.join(dir, "a.txt"), content);
    const out = await mod.runDeterministicPhase({ op: "hash-file", cwd: dir, inputs: { path: "a.txt" } });
    assert.equal(out.deterministic, true);
    assert.equal(out.ok, true);
    assert.equal(out.outputs.sha256, sha256(content), "hash-file sha256 must match");
    assert.equal(out.outputs.bytes, content.length, "hash-file bytes must match");
  });
}

async function testHashFileMissing() {
  const mod = loadModule();
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => mod.runDeterministicPhase({ op: "hash-file", cwd: dir, inputs: { path: "nope.txt" } }),
      (e) => e instanceof mod.DeterministicPhaseError && e.code === "MISSING_FILE",
      "missing hash-file target must throw MISSING_FILE",
    );
  });
}

async function testVerifyHashMatch() {
  const mod = loadModule();
  await withTempDir(async (dir) => {
    const content = Buffer.from("frozen gate doc\n");
    fs.writeFileSync(path.join(dir, "gate.md"), content);
    const out = await mod.runDeterministicPhase({
      op: "verify-hash", cwd: dir, inputs: { path: "gate.md", reference: sha256(content).toUpperCase() },
    });
    assert.equal(out.ok, true);
    assert.equal(out.outputs.match, true, "verify-hash must match (case-insensitive reference)");
  });
}

async function testVerifyHashMismatchStructured() {
  const mod = loadModule();
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "gate.md"), "actual content\n");
    const wrong = sha256(Buffer.from("different content"));
    // Mismatch must NOT throw — it is a structured ok:false / match:false output.
    const out = await mod.runDeterministicPhase({
      op: "verify-hash", cwd: dir, inputs: { path: "gate.md", reference: wrong },
    });
    assert.equal(out.ok, false, "mismatch must yield ok:false");
    assert.equal(out.outputs.match, false, "mismatch must yield match:false");
    assert.equal(out.deterministic, true);
  });
}

async function testVerifyHashInvalidReference() {
  const mod = loadModule();
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "gate.md"), "x\n");
    await assert.rejects(
      () => mod.runDeterministicPhase({ op: "verify-hash", cwd: dir, inputs: { path: "gate.md", reference: "not-a-hash" } }),
      (e) => e instanceof mod.DeterministicPhaseError && e.code === "INVALID_HASH",
      "non-64-hex reference must throw INVALID_HASH",
    );
  });
}

async function testFreezeRecordAndRefuseOverwrite() {
  const mod = loadModule();
  await withTempDir(async (dir) => {
    const content = Buffer.from("preregistration artifact\n");
    fs.writeFileSync(path.join(dir, "prereg.md"), content);
    const out = await mod.runDeterministicPhase({
      op: "freeze-record", cwd: dir, inputs: { path: "prereg.md", name: "prereg", runId: "orc-test-1" },
    });
    assert.equal(out.ok, true);
    const recordPath = out.outputs.recordPath;
    assert.ok(fs.existsSync(recordPath), "freeze record file must be written");
    const recorded = fs.readFileSync(recordPath, "utf8");
    assert.match(recorded, new RegExp(`sha256: ${sha256(content)}`), "freeze record must contain the sha256");
    assert.match(recorded, /runId: orc-test-1/, "freeze record must contain the runId");
    const before = fs.readFileSync(recordPath);
    // Second attempt must refuse to overwrite.
    await assert.rejects(
      () => mod.runDeterministicPhase({ op: "freeze-record", cwd: dir, inputs: { path: "prereg.md", name: "prereg" } }),
      (e) => e instanceof mod.DeterministicPhaseError && e.code === "FREEZE_RECORD_EXISTS",
      "freeze-record must refuse to overwrite an existing record",
    );
    assert.deepEqual(fs.readFileSync(recordPath), before, "existing freeze record must be byte-unchanged");
  });
}

async function testManifestHappyAndMissing() {
  const mod = loadModule();
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "one.txt"), "one\n");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "two.txt"), "two\n");
    const out = await mod.runDeterministicPhase({
      op: "manifest", cwd: dir, inputs: { paths: ["one.txt", "sub/two.txt"] },
    });
    assert.equal(out.ok, true);
    assert.equal(out.outputs.entries.length, 2, "manifest must list both entries");
    assert.equal(out.outputs.entries[0].sha256, sha256(Buffer.from("one\n")));

    // WAVE2-SPEC ITEM A: the deterministic report must surface the actual
    // per-entry path, sha256, and bytes for manifest ops (not just a count).
    const report = mod.formatDeterministicPhaseForReport(out);
    const oneHash = sha256(Buffer.from("one\n"));
    const twoHash = sha256(Buffer.from("two\n"));
    assert.match(report, /DETERMINISTIC \(no LLM\)/, "manifest report must carry the deterministic tag");
    assert.ok(report.includes(oneHash), "manifest report must contain the first entry's computed sha256");
    assert.ok(report.includes(twoHash), "manifest report must contain the second entry's computed sha256");
    assert.ok(report.includes("one.txt"), "manifest report must contain the first entry's path");
    assert.ok(report.includes("sub/two.txt"), "manifest report must contain the second entry's path");
    assert.ok(report.includes("bytes=4"), "manifest report must contain the entry byte counts");
    // Missing file ⇒ MISSING_FILE (fail-closed).
    await assert.rejects(
      () => mod.runDeterministicPhase({ op: "manifest", cwd: dir, inputs: { paths: ["one.txt", "ghost.txt"] } }),
      (e) => e instanceof mod.DeterministicPhaseError && e.code === "MISSING_FILE",
      "manifest with a missing file must fail closed",
    );
    // Path traversal / absolute / glob rejected.
    await assert.rejects(
      () => mod.runDeterministicPhase({ op: "manifest", cwd: dir, inputs: { paths: ["../escape.txt"] } }),
      (e) => e instanceof mod.DeterministicPhaseError && e.code === "INVALID_MANIFEST_PATH",
      "manifest must reject traversal paths",
    );
    await assert.rejects(
      () => mod.runDeterministicPhase({ op: "manifest", cwd: dir, inputs: { paths: ["*.txt"] } }),
      (e) => e instanceof mod.DeterministicPhaseError && e.code === "INVALID_MANIFEST_PATH",
      "manifest must reject glob metacharacters",
    );
  });
}

async function testCheckpointRoundTrip() {
  const mod = loadModule();
  const runState = loadRunState();
  await withTempDir(async (dir) => {
    const content = Buffer.from("checkpoint doc\n");
    fs.writeFileSync(path.join(dir, "doc.txt"), content);
    const out = await mod.runDeterministicPhase({
      op: "verify-hash", cwd: dir, inputs: { path: "doc.txt", reference: sha256(content) },
    });
    const payload = mod.checkpointPayload(out);
    assert.equal(payload.deterministic, true, "checkpoint payload must carry deterministic:true");
    assert.equal(payload.agentName, "deterministic");
    assert.equal(payload.exitCode, 0, "ok output must checkpoint exitCode 0");

    const runId = `test-det-${Date.now().toString(36)}`;
    const store = runState.RunStateStore.create(runId, "frozen-gate-fix-loop", "TEST", { cwd: dir }, ["freeze-verify"]);
    store.checkpointPhase(0, "freeze-verify", payload);
    const loaded = runState.RunStateStore.load(runId);
    const cp = loaded.checkpoints.get(0);
    assert.equal(cp.deterministic, true, "deterministic marker must survive round-trip");
    assert.equal(cp.op, "verify-hash", "op must survive round-trip");
    assert.equal(cp.outputs.sha256, sha256(content), "outputs.sha256 must survive round-trip");
    assert.equal(cp.outputs.match, true, "outputs.match must survive round-trip");
    fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
  });
}

function testStaticNoCommandExecution() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "deterministic-phase.ts"), "utf8");
  assert.doesNotMatch(source, /child_process/, "must not import child_process");
  assert.doesNotMatch(source, /\bexec\s*\(/, "must not call exec");
  assert.doesNotMatch(source, /\bspawn\s*\(/, "must not call spawn");
  assert.doesNotMatch(source, /require\(["']http/, "must not use http");
  assert.doesNotMatch(source, /from\s+["']node:(http|https|net|dgram|tls)["']/, "must not import network modules");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "must not use fetch");
}

async function run() {
  await testHashFile();
  await testHashFileMissing();
  await testVerifyHashMatch();
  await testVerifyHashMismatchStructured();
  await testVerifyHashInvalidReference();
  await testFreezeRecordAndRefuseOverwrite();
  await testManifestHappyAndMissing();
  await testCheckpointRoundTrip();
  testStaticNoCommandExecution();
  console.log("PASS deterministic-phase: ops, verify-hash mismatch (structured), freeze-record no-overwrite, manifest fail-closed, checkpoint round-trip, no-command-execution static");
}

run().catch((error) => { console.error("test-deterministic-phase: FAIL"); console.error(error); process.exit(1); });
