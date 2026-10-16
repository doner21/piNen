#!/usr/bin/env node
/** Focused regressions for terminal telemetry refusal and failed-suite evidence retention. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-artifact-settlement-"));
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

// Product code is imported only after every mutable test root is isolated.
const { CommandTelemetryOwner, CommandTelemetryClient } = require("../src/command-telemetry-owner.cjs");

async function oversizeLineRefusalSettlesClient() {
  const caseRoot = path.join(TEMP_ROOT, "oversize-line");
  const owner = new CommandTelemetryOwner({
    commandRoot: caseRoot,
    evidenceDirectory: path.join(caseRoot, "evidence"),
    commandId: "oversize-line-client-settlement",
  });
  const refusedInvocation = "a".repeat(24);
  const refused = new CommandTelemetryClient(owner.configuration(), refusedInvocation);
  let healthy;
  try {
    await owner.start();
    await refused.connect();
    const refusal = new Promise((resolve) => refused.once("transportError", resolve));

    // This is the observed 70,000-byte line, delivered through the real
    // command-private transport. It exceeds the shared 64-KiB queue without
    // substituting a different protocol error or raising any production limit.
    refused.socket.write(Buffer.concat([Buffer.alloc(70_000, 1), Buffer.from("\n")]));
    const refusalError = await refusal;
    assert.match(String(refusalError?.message || refusalError), /COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND/,
      "the owner must propagate the actual shared-queue refusal");
    assert.equal(refused.closed, true, "the refused client must enter a terminal state");
    assert.equal(owner.accounting().completedOperations, 0,
      "an oversize transport line must never be accepted as telemetry work");

    await assert.rejects(() => refused.connect(), /COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND/,
      "a terminally refused client must not report a subsequent connection as healthy");
    await assert.rejects(
      () => refused.publish({ type: "must_not_retry_after_terminal_refusal" }),
      /COMMAND_TELEMETRY_QUEUE_EXCEEDS_BOUND/,
      "later work on the refused client must settle with the original refusal rather than retrying",
    );
    assert.equal(refused.pendingGrant.size, 0);
    assert.equal(refused.pendingReceipt.size, 0);

    // Recovery is explicit and distinct: a fresh client can still make normal
    // progress after the refused operation has settled.
    healthy = new CommandTelemetryClient(owner.configuration(), "b".repeat(24));
    await healthy.connect();
    const receipt = await healthy.publish({ type: "healthy_after_refusal", marker: "HEALTHY_RECOVERY" });
    assert.equal(receipt.accepted, true);
    assert.equal(owner.drainEvents().some((event) => event.marker === "HEALTHY_RECOVERY"), true);
    console.log("PASS item3 oversize line terminally refuses one client while a fresh healthy client progresses");
  } finally {
    await Promise.allSettled([refused.close(), healthy?.close()]);
    await owner.close();
  }
}

async function failedSuiteRootIsPreserved() {
  const child = spawn(process.execPath, [
    path.join(ROOT, "tests", "test-2026-09-21-no-output.cjs"),
    "--failure-root-preservation-probe",
  ], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const match = /ITEM3_FAILURE_ROOT=(.+)/.exec(`${stdout}\n${stderr}`);
  assert.equal(code, 1, `the finite lifecycle probe must fail naturally: ${stderr}`);
  assert.ok(match, `the failing suite must report its disposable evidence root: ${stderr}`);
  const retainedRoot = match[1].trim();
  const diagnostic = path.join(retainedRoot, "failure-root-probe.json");
  assert.equal(fs.existsSync(retainedRoot), true,
    `a non-zero suite must retain its actual disposable root: ${retainedRoot}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(diagnostic, "utf8")), {
    outcome: "failed",
    marker: "ITEM3_FAILURE_ROOT_EVIDENCE",
  });
  console.log(`PASS item3 failed-suite evidence root retained at ${retainedRoot}`);
}

let focusedSucceeded = false;
(async () => {
  const onlyLifecycle = process.argv.includes("--failure-root-preservation");
  const onlyOversize = process.argv.includes("--oversize-client");
  if (!onlyLifecycle) await oversizeLineRefusalSettlesClient();
  if (!onlyOversize) await failedSuiteRootIsPreserved();
  focusedSucceeded = true;
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  if (focusedSucceeded && (process.exitCode === undefined || process.exitCode === 0)) {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } else {
    console.error(`ITEM3_FOCUSED_FAILURE_ROOT=${TEMP_ROOT}`);
  }
});
