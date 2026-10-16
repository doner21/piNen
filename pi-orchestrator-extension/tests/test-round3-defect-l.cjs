#!/usr/bin/env node
/** L only: every sanctioned test entrypoint must receive an owned, disposable runs root before imports. */
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { scratch, checkPackageIsolation } = require("./test-2026-10-06-round7-test-isolation.cjs");
async function main() {
const inspection = scratch("round3-defect-l-entrypoints-");
try {
  await checkPackageIsolation(ROOT, inspection);
} finally {
  fs.rmSync(inspection, { recursive: true, force: true });
}

const standIn = scratch("round3-defect-l-shared-stand-in-");
const legacySentinel = path.join(standIn, "legacy-production-stand-in");
const nextSentinel = path.join(standIn, "next-production-stand-in");
fs.mkdirSync(legacySentinel);
fs.mkdirSync(nextSentinel);
fs.writeFileSync(path.join(legacySentinel, "sentinel.bin"), Buffer.from([0, 1, 255, 10]));
fs.writeFileSync(path.join(nextSentinel, "sentinel.bin"), Buffer.from([10, 255, 1, 0]));
const beforeLegacy = fs.readFileSync(path.join(legacySentinel, "sentinel.bin"));
const beforeNext = fs.readFileSync(path.join(nextSentinel, "sentinel.bin"));

try {
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, "run-isolated.cjs"), "tests/fixtures/runs-root-isolation-probe.cjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PI_ORCHESTRATOR_RUNS_ROOT: legacySentinel,
      PI_ORCHESTRATOR_NEXT_RUNS_ROOT: nextSentinel,
      ROUND3_L_FORBIDDEN_ROOTS: [legacySentinel, nextSentinel, path.join(ROOT, "runs-state")].join(path.delimiter),
    },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.error || ""}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const line = result.stdout.trim().split(/\r?\n/).find((value) => value.startsWith("ISOLATION_PROBE "));
  assert.ok(line, `probe must report its isolated roots; stdout=${result.stdout}`);
  const report = JSON.parse(line.slice("ISOLATION_PROBE ".length));
  const temp = path.resolve(os.tmpdir());
  assert.ok(path.resolve(report.ownerRoot).startsWith(temp + path.sep), "runner root must be under the OS temp directory");
  assert.notEqual(path.resolve(report.legacyRoot), path.resolve(legacySentinel));
  assert.notEqual(path.resolve(report.nextRoot), path.resolve(nextSentinel));
  assert.equal(fs.existsSync(report.ownerRoot), false, "runner must clean its complete per-file root after settlement");
  assert.deepEqual(fs.readFileSync(path.join(legacySentinel, "sentinel.bin")), beforeLegacy, "legacy shared-state stand-in remains byte-identical");
  assert.deepEqual(fs.readFileSync(path.join(nextSentinel, "sentinel.bin")), beforeNext, "next shared-state stand-in remains byte-identical");
  assert.deepEqual(fs.readdirSync(legacySentinel), ["sentinel.bin"]);
  assert.deepEqual(fs.readdirSync(nextSentinel), ["sentinel.bin"]);
} finally {
  fs.rmSync(standIn, { recursive: true, force: true });
}

console.log("test-round3-defect-l: wrapper/direct entrypoint isolation, sentinel preservation, incomplete dirs, and cleanup");
}
// Keep async assertions fatal without an unhandled rejection or early exit.
main().catch(error => { queueMicrotask(() => { throw error; }); });
