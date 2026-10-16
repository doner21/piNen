#!/usr/bin/env node
/*
 * Offline fake Pi worker for tests/test-2026-10-05-package-contract-freeze.cjs.
 *
 * Adapted (by copying, per the lean plan's rule 1) from the run-10 blocker-a
 * probe's fake-pi-wrapper.cjs
 * (C:/Users/you/orc-repair-claude-run10-2026-10-05/blocker-a/probe/fake-pi-wrapper.cjs).
 * Removed: the package.json mutation behavior (route B/F used it to prove the
 * frozen policy is never re-derived after a worker mutates the workspace;
 * this test's two gaps do not need it and omitting it keeps the recomputed
 * expected policyHash in the test driver byte-identical to what the host
 * computed for the same inputs). Kept: the command-monitor ready marker, the
 * worker-launch record (policy file sha + parsed policyHash), and delegation
 * to the repository's own tests/fake-pi.cjs for the JSON-mode reply.
 * No timer, signal, kill, deadline or process.exit is added here.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

process.stderr.write("NO_OUTPUT_MONITOR_READY:v1\n");
const log = process.env.PKGFREEZE_WORKER_LOG;
const file = process.env.PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE;
const envSha = process.env.PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256;
const args = process.argv.slice(2);
const record = {
  kind: "worker-launch",
  wallMs: Date.now(),
  pid: process.pid,
  route: process.env.PKGFREEZE_ROUTE || null,
  cwd: process.cwd(),
  envSha: envSha || null,
  systemPrompt: path.basename(args[args.indexOf("--append-system-prompt") + 1] || ""),
  explicitExtensions: args.reduce((out, arg, index) => (
    (arg === "--extension" || arg === "-e") && args[index + 1] ? [...out, args[index + 1]] : out
  ), []),
};
try {
  const bytes = fs.readFileSync(file);
  record.fileSha = crypto.createHash("sha256").update(bytes).digest("hex");
  record.fileShaMatchesEnv = record.fileSha === envSha;
  const policy = JSON.parse(bytes.toString("utf8"));
  record.policyHash = policy.policyHash;
  record.authority = policy.authority;
  record.packageJsonSha256 = policy.packageJsonSha256;
  record.entrypoints = (policy.existingEntrypoints || []).map((entry) => path.basename(entry.path));
} catch (error) {
  record.policyError = String((error && error.message) || error);
}
if (log) fs.appendFileSync(log, `${JSON.stringify(record)}\n`);
require(path.join(process.env.PKGFREEZE_REPO, "tests", "fake-pi.cjs"));
