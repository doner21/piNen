#!/usr/bin/env node
"use strict";
/** Failed scratch staging remains owned through close; public retry, not direct
 * map manipulation, must reconcile it after native filesystem recovery. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const PARENT = process.env.ITEM3_EVIDENCE_PARENT;
assert.ok(PARENT && path.isAbsolute(PARENT), "an explicit isolated evidence parent is required");
const parentReal = fs.realpathSync(PARENT);
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(parentReal, "orc-item3-owner-close-")));
assert.ok(ROOT.startsWith(`${parentReal}${path.sep}`), "the run must remain inside its disposable parent");
for (const [key, name] of Object.entries({PI_CODING_AGENT_DIR: "agent", PI_ORCHESTRATOR_RUNS_ROOT: "runs",
  PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next", PI_CODING_AGENT_SESSION_DIR: "sessions"})) {
  process.env[key] = path.join(ROOT, name);
  fs.mkdirSync(process.env[key]);
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = ROOT;
process.env.PI_OFFLINE = "1";
const {CommandTelemetryOwner, CommandTelemetryClient} = require("../src/command-telemetry-owner.cjs");
const realWrite = fs.writeFileSync, realRemove = fs.rmSync;
const invocationId = "a".repeat(24);
const owner = new CommandTelemetryOwner({commandRoot:path.join(ROOT,"command"), evidenceDirectory:path.join(ROOT,"evidence"),commandId:"stage-close-retry"});
const client = new CommandTelemetryClient(owner.configuration(), invocationId);
let stage, writeHit = 0, removalHits = 0, denyRemoval = true;
const eio = () => Object.assign(new Error("TEST_STAGE_WRITE_FAILURE"), {code:"EIO"});
const ebusy = () => Object.assign(new Error("TEST_STAGE_REMOVE_FAILURE"), {code:"EBUSY"});
(async () => {
  let serverClosed = false;
  let fallbackUsed = false;
  let prior, priorHash, closeResults;
  try {
    await owner.start();
    owner.server.once("close",()=>{serverClosed = true;}); // before close trigger
    await client.connect();
    await client.publish({type:"invocation_terminal",outcome:"succeeded",marker:"PRIOR_VALID"},"terminal");
    assert.equal(owner.drainEvents().length,1);
    prior = owner.generations.get(invocationId).file;
    priorHash = crypto.createHash("sha256").update(fs.readFileSync(prior)).digest("hex");
    fs.writeFileSync = function(file,data,...args) {
      if (!stage && String(file).startsWith(owner.evidenceDirectory) && String(file).endsWith(".tmp")) {
        stage = String(file);
        realWrite.call(this,file,Buffer.from(data).subarray(0,4096),...args);
        writeHit++;
        throw eio();
      }
      return realWrite.call(this,file,data,...args);
    };
    fs.rmSync = function(file,...args) {
      if (denyRemoval && stage && path.resolve(String(file)) === path.resolve(stage)) { removalHits++; throw ebusy(); }
      return realRemove.call(this,file,...args);
    };
    await assert.rejects(()=>client.publish({type:"invocation_terminal",outcome:"succeeded",payload:"x".repeat(8192)},"terminal"),/TEST_STAGE_WRITE_FAILURE/);
    assert.equal(writeHit,1);
    assert.equal(realWrite !== fs.writeFileSync,true);
    assert.equal(fs.statSync(stage).size,4096);
    closeResults = await Promise.allSettled([owner.close(),owner.close()]);
    const before = owner.accounting();
    fs.writeFileSync = realWrite;
    denyRemoval = false;
    const retryResults = await Promise.allSettled([owner.close(),owner.close()]);
    const after = owner.accounting();
    const observation = {root:ROOT,stage,writeHit,removalHits,serverClosed,
      closeResults:closeResults.map(r=>r.status === "rejected" ? {status:r.status,reason:r.reason?.message}:{status:r.status}),
      retryResults:retryResults.map(r=>r.status === "rejected" ? {status:r.status,reason:r.reason?.message}:{status:r.status}),
      before:{stages:before.retainedFailedStages,charge:before.currentOutstandingBytes},
      after:{stages:after.retainedFailedStages,charge:after.currentOutstandingBytes},
      stageExists:fs.existsSync(stage),priorHashUnchanged:crypto.createHash("sha256").update(fs.readFileSync(prior)).digest("hex")===priorHash};
    realWrite(path.join(ROOT,"observation.json"),JSON.stringify(observation,null,2));
    console.log(JSON.stringify(observation));
    assert.equal(serverClosed,true,"native server close must precede public shutdown result");
    assert.deepEqual(closeResults.map(x=>x.status),["rejected","rejected"],"first concurrent shutdown must report retained native stage");
    assert.equal(before.retainedFailedStages,1);
    assert.ok(before.currentOutstandingBytes>0);
    assert.deepEqual(retryResults.map(x=>x.status),["fulfilled","fulfilled"],"fault-removed public retry must settle");
    assert.equal(after.retainedFailedStages,0);
    assert.equal(after.currentOutstandingBytes,0);
    assert.equal(observation.stageExists,false);
    assert.equal(observation.priorHashUnchanged,true);
    // The failed transaction did not poison subsequent healthy command owners.
    const following = new CommandTelemetryOwner({commandRoot:path.join(ROOT,"following"),
      evidenceDirectory:path.join(ROOT,"following-evidence"),commandId:"following-healthy"});
    const followingClient = new CommandTelemetryClient(following.configuration(), "b".repeat(24));
    try {
      await following.start();
      const followingNativeClose = new Promise(resolve=>following.server.once("close",resolve));
      await followingClient.connect();
      const receipt=await followingClient.publish({type:"invocation_terminal",outcome:"succeeded",marker:"HEALTHY_FOLLOWING_EVIDENCE"},"terminal");
      assert.equal(receipt.accepted,true);
      assert.ok(following.drainEvents().some(e=>e.marker==="HEALTHY_FOLLOWING_EVIDENCE"));
      await followingClient.close();
      await following.close();
      await followingNativeClose;
    } finally {
      const outcomes=await Promise.allSettled([followingClient.close(),following.close()]);
      assert.ok(outcomes.every(x=>x.status==="fulfilled"),"healthy following cleanup must settle");
    }
  } finally {
    fs.writeFileSync=realWrite; fs.rmSync=realRemove;
    denyRemoval=false;
    const close = await Promise.allSettled([client.close(),owner.close()]);
    if (close.some(x=>x.status!=="fulfilled")) {
      fallbackUsed=true;
      // Test-safety only; record failed public recovery, not a PASS.
      owner.reconcileFailedStages();
      const recovered = await Promise.allSettled([owner.close()]);
      if (recovered.some(x=>x.status!=="fulfilled")) console.error("PUBLIC_RECOVERY_FAILED", recovered.map(x=>x.reason?.message));
      assert.ok(recovered.every(x=>x.status==="fulfilled"),"fault-removed public shutdown must settle after fixture fallback");
    }
    if (owner.accounting().retainedFailedStages) { fallbackUsed=true; owner.reconcileFailedStages(); }
    if (fallbackUsed) console.error("FAILED_PRODUCT_RECOVERY_MANUAL_STAGE_RECONCILIATION",ROOT);
    console.log(`PRESERVED_OWNER_CLOSE_ROOT ${ROOT}`);
    assert.equal(fallbackUsed,false,"a successful test body cannot hide failed public cleanup behind a logged fallback");
  }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
