"use strict";

// Fixture-contract tests, not product coverage. All lifecycle events below
// come from these directly retained, finite Node children (or failed spawn).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { observeChild, closeServiceNaturally } = require("./item3-native-counter-witness.cjs");
const { isolatedRoot } = require("./item3-native-counter-finite.cjs");

async function main() {
  const root = isolatedRoot("orc-item3-astra-witness-");
  console.log(`PRESERVED_WITNESS_CHECK_ROOT ${root}`);
  const results = [];
  const child = (label, source) => observeChild(spawn(process.execPath, ["-e", source], {
    cwd: path.join(root, "workspace"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  }), label);
  for (const [label, text, kind] of [
    ["wrong", '{"type":"wrong"}\n', "frame"],
    ["refused", '{"type":"error","message":"refused"}\n', "frame"],
    ["malformed", '{broken}\n', "malformed-frame"],
    ["early-eof", '', "stdout-eof"],
  ]) {
    const witness = child(label, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(text)}));`);
    const response = witness.nextFrame();
    witness.child.stdin.end();
    assert.equal((await response).kind, kind);
    await witness.close;
    const late = await witness.nextFrame();
    assert.ok(["stdout-eof", "stdout-close", "close"].includes(late.kind));
    assert.equal((await witness.exit).kind, "exit");
    let lateExitCallbacks = 0;
    witness.onExit(() => { lateExitCallbacks += 1; });
    assert.equal(lateExitCallbacks, 1);
    results.push(witness.snapshot());
  }
  const failed = observeChild(spawn(path.join(root, "missing-executable"), [], { stdio: ["pipe", "pipe", "pipe"] }), "spawn-error");
  assert.equal((await failed.nextFrame()).kind, "spawn-error");
  assert.equal((await failed.close).kind, "close");
  assert.equal((await failed.exit).kind, "no-exit-event");
  assert.equal(failed.events.filter((event) => event.type === "child-exit").length, 0);
  assert.equal(failed.events.filter((event) => event.type === "child-close").length, 1);
  results.push(failed.snapshot());

  const callbackError = child("native-write-after-end", "process.stdin.resume();");
  const responseError = callbackError.nextFrame();
  callbackError.child.stdin.end();
  let callbacks = 0, actualError;
  callbackError.child.stdin.write("not accepted", (error) => { callbacks += 1; actualError = error; });
  const errorResponse = await responseError;
  await callbackError.close;
  assert.equal(callbacks, 1);
  assert.equal(actualError?.code, "ERR_STREAM_WRITE_AFTER_END");
  assert.ok(["write-callback-error", "stdin-error"].includes(errorResponse.kind));
  assert.equal(callbackError.writes[0].callbacks, 1);
  results.push(callbackError.snapshot());

  // Explicit public-promise double tests the fixture's recovery, not the
  // production service. EOF fallback must remain FAILED even after real close.
  const pendingChild = child("pending-public-close-double", "process.stdin.resume();");
  const recovery = { safetyFallbackRequired: false };
  await closeServiceNaturally({ close: () => new Promise(() => {}) }, [pendingChild], recovery);
  assert.equal(recovery.publicClose.status, "pending");
  assert.equal(recovery.status, "failed-recovery");
  assert.equal(recovery.safetyFallbackRequired, true);
  assert.equal(recovery.samplerTerminals[0].kind, "close");
  results.push({ scope: "public-promise-double; real native child", recovery });
  fs.writeFileSync(path.join(root, "evidence", "witnesses.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  console.log("PASS native witness fixture contract (not product coverage)");
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
