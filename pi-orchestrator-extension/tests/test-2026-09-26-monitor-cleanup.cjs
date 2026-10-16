#!/usr/bin/env node
"use strict";
/** The real registered bash monitor must settle both native resources before
 * returning or rejecting, even when one setup/finalization operation fails. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const parent = process.env.ITEM3_EVIDENCE_PARENT;
assert.ok(parent && path.isAbsolute(parent), "an isolated absolute evidence parent is required");
const realParent = fs.realpathSync(parent);
const root = fs.realpathSync(fs.mkdtempSync(path.join(realParent, "monitor-cleanup-")));
assert.ok(root.startsWith(`${realParent}${path.sep}`));
for (const [key, name] of Object.entries({PI_CODING_AGENT_DIR:"agent",PI_ORCHESTRATOR_RUNS_ROOT:"runs",
  PI_ORCHESTRATOR_NEXT_RUNS_ROOT:"next",PI_CODING_AGENT_SESSION_DIR:"sessions"})) {
  process.env[key] = path.join(root,name); fs.mkdirSync(process.env[key]);
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = root;
process.env.PI_OFFLINE = "1";
const { runActualInstanceEvidence } = require("./fixtures/item3-monitor-instance-evidence.cjs");
(async () => {
  const outcomes = [];
  const modes = ["shim-write","shim-chmod","reader-poll","owner-drain","redactor-finish","sampler-close"];
  if (process.argv[2]) assert.ok(modes.includes(process.argv[2]),"unknown cleanup mode");
  for (const mode of process.argv[2] ? [process.argv[2]] : modes) {
    const actual = await runActualInstanceEvidence(path.join(root,mode),mode);
    const beforeHarness = actual.publicMonitor;
    const expectedError = `ASTRA_ACTUAL_${mode}`;
    const observation = {mode, faultHits:actual.faultHits, publicOutcome:beforeHarness.execute,
      publicError:beforeHarness.error?.message, serverClosedAtReturn:beforeHarness.serverClosed,
      samplerClosedAtReturn:beforeHarness.samplerClosed,
      harnessRecoveryRequired:actual.harnessRecovery.required,
      serverNativeClose:actual.nativeEvents.some(event=>event.type === "server-close"),
      samplerNativeClose:actual.harnessRecovery.sampler?.terminalOutcome?.kind};
    outcomes.push(observation);
    console.log(`MONITOR_CLEANUP ${JSON.stringify(observation)}`);
    assert.equal(actual.faultHits,1,`${mode}: injected fault must reach the real production operation`);
    // MONITOR-CLEANUP-SETTLEMENT-OUTCOME (decision 4 / finding 6, HR3-EXTEND): for reader-poll,
    // owner-drain and sampler-close the child completes naturally, so the retained telemetry
    // settlement failure must not become the tool call's own result (hard rule 3); it is reported
    // as a separate details.monitorIo.telemetrySettlementFailures diagnostic instead, preserving the
    // identical failure message. Every other mode keeps the original "failure becomes the rejection"
    // assertion verbatim.
    if (mode === "reader-poll" || mode === "owner-drain" || mode === "sampler-close") {
      assert.equal(beforeHarness.execute,"fulfilled",`${mode}: a telemetry settlement failure must not become the tool call's result once the child completed naturally`);
      assert.match(beforeHarness.text ?? "",/ASTRA_ACTUAL_COMMAND_COMPLETE/,`${mode}: the command's real, natural outcome must still be reported`);
      const settlements = beforeHarness.details?.monitorIo?.telemetrySettlementFailures ?? [];
      assert.ok(settlements.length > 0,`${mode}: the retained settlement failure must be reported as a diagnostic`);
      const entry = settlements.find((s) => s.name === "Error" && s.message === expectedError && (s.step === "event-drain" || s.step === "counter-service-close"));
      assert.ok(entry,`${mode}: no settlement diagnostic preserves the original failure ${JSON.stringify(settlements)}`);
      if (mode === "sampler-close") assert.equal(entry.nativeSettlement,"witnessed",`${mode}: the counter-service-close native settlement must be witnessed`);
    } else {
      assert.equal(beforeHarness.execute,"rejected",`${mode}: failure must not become a healthy observe-only result`);
      assert.equal(beforeHarness.error?.message,expectedError,`${mode}: preserve the original failure`);
    }
    assert.equal(beforeHarness.serverClosed,true,`${mode}: real server closed before public return`);
    if (mode !== "shim-write" && mode !== "shim-chmod")
      assert.equal(beforeHarness.samplerClosed,true,`${mode}: real sampler closed before public return`);
    assert.equal(actual.harnessRecovery.required,false,`${mode}: harness closure is failed product recovery`);
    assert.equal(observation.serverNativeClose,true);
    if (mode !== "shim-write" && mode !== "shim-chmod") assert.equal(observation.samplerNativeClose,"close");
  }
  fs.writeFileSync(path.join(root,"outcomes.json"),JSON.stringify(outcomes,null,2));
  console.log(`PRESERVED_MONITOR_CLEANUP_ROOT ${root}`);
})().catch(error=>{console.error(error.stack);console.error(`PRESERVED_MONITOR_CLEANUP_ROOT ${root}`);process.exitCode=1;});
