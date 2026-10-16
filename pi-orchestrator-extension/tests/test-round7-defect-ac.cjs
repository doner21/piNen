#!/usr/bin/env node
/** Round 7 AC: explicit supervisor accept-with-reason is durable, bound, and never PASS. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ac-"));
  const runsRoot = path.join(home, "runs");
  const workspaceA = path.join(home, "workspace-a");
  const workspaceB = path.join(home, "workspace-b");
  const log = path.join(home, "fake-pi.jsonl");
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });

  const previous = Object.fromEntries([
    "PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "FAKE_PI_LOG", "FAKE_PI_PLAN_STYLE",
    "FAKE_PI_EXECUTOR_STYLE", "FAKE_PI_VISIBLE_VERIFY_FAIL",
  ].map((key) => [key, process.env[key]]));
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  process.env.FAKE_PI_LOG = log;
  process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";
  process.env.FAKE_PI_EXECUTOR_STYLE = "write-summary-table";

  try {
    const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
    const supervision = jiti(path.join(ROOT, "src", "supervision.ts"));
    const messages = [];
    let tool;
    let command;
    jiti(path.join(ROOT, "src", "index.ts")).default({
      registerTool(value) { if (value.name === "orchestrate") tool = value; },
      registerCommand(name, value) { if (name === "orchestrate") command = value; },
      sendMessage(value) { messages.push(value); },
      sendUserMessage() {},
    });
    assert.ok(tool && command, "orchestrate command and tool must register");
    assert.ok(tool.parameters.properties.reason, "tool schema exposes the bounded acceptance reason");

    const primitiveBinding = { runId: "orc-binding", missionHash: "a".repeat(64), checkpointId: "checkpoint-0004", action: "accept" };
    const primitive = supervision.issueApprovalToken(primitiveBinding, new Date("2026-09-10T12:00:00Z"), () => Buffer.alloc(32, 9));
    assert.throws(
      () => supervision.consumeApprovalToken(primitive.record, primitive.token, { ...primitiveBinding, action: "continue" }),
      /wrong action binding/,
      "approval primitives preserve exact action binding",
    );

    const call = (params, cwd) => tool.execute("round7-ac", params, undefined, () => {}, { cwd });
    async function reachFailedVerifier(cwd) {
      const planned = await call({
        action: "run", supervision: "visible-main", preflight: false, maxRetries: 1,
        cwd, predictedWriteSet: "out-1.txt", task: "CREATE file out-1.txt with fixture content.",
      }, cwd);
      const executed = await call({ action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken }, cwd);
      process.env.FAKE_PI_VISIBLE_VERIFY_FAIL = "1";
      const failed = await call({ action: "continue", runId: planned.details.runId, approvalToken: executed.details.approvalToken }, cwd);
      delete process.env.FAKE_PI_VISIBLE_VERIFY_FAIL;
      assert.equal(failed.details.status, "awaiting_supervisor");
      assert.equal(failed.details.checkpoint.kind, "verifier");
      assert.ok(failed.details.approvalToken);
      return { planned, executed, failed };
    }

    const first = await reachFailedVerifier(workspaceA);
    const firstRunDir = path.join(runsRoot, first.planned.details.runId);
    const stateFile = path.join(firstRunDir, "supervision.json");
    const beforeAcceptance = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const verifierCheckpoint = beforeAcceptance.checkpoints.at(-1);
    const verifierPayloadFile = path.join(firstRunDir, `${verifierCheckpoint.id}-${verifierCheckpoint.kind}.json`);
    const verifierBytes = fs.readFileSync(verifierPayloadFile);
    const workerCallsBeforeAccept = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).length;

    await assert.rejects(
      () => call({ action: "accept", runId: first.planned.details.runId, approvalToken: first.failed.details.approvalToken, reason: "   " }, workspaceA),
      /reason.*non-empty/i,
    );
    await assert.rejects(
      () => call({ action: "accept", runId: first.planned.details.runId, approvalToken: first.failed.details.approvalToken, reason: "x".repeat(2001) }, workspaceA),
      /reason.*2000/i,
    );

    const unsettledBytes = fs.readFileSync(stateFile);
    const unsettled = JSON.parse(unsettledBytes.toString("utf8"));
    unsettled.audit.activeWorkers = [{ phase: "hostile-still-running", pid: 4242 }];
    fs.writeFileSync(stateFile, `${JSON.stringify(unsettled, null, 2)}\n`);
    await assert.rejects(
      () => call({ action: "accept", runId: first.planned.details.runId, approvalToken: first.failed.details.approvalToken, reason: "Owner accepts the documented residual." }, workspaceA),
      /active worker|settled/i,
      "acceptance is unavailable while any worker remains active",
    );
    fs.writeFileSync(stateFile, unsettledBytes);

    const second = await reachFailedVerifier(workspaceB);
    await assert.rejects(
      () => call({ action: "accept", runId: second.planned.details.runId, approvalToken: first.failed.details.approvalToken, reason: "Cross-run token must fail." }, workspaceB),
      /invalid|wrong|binding/i,
      "approval from another run/checkpoint cannot authorize acceptance",
    );

    const reason = "Owner accepts the documented presentation residual; substantive findings remain visible.";
    const commandContext = {
      cwd: workspaceA,
      hasUI: false,
      signal: undefined,
      ui: {
        input: async () => { throw new Error("accept must not prompt for a task"); },
        notify() {}, setWidget() {}, setStatus() {}, setEditorText() {},
      },
    };
    const messagesBefore = messages.length;
    await command.handler(`accept --run-id ${first.planned.details.runId} --approval-token ${first.failed.details.approvalToken} --reason "${reason}"`, commandContext);
    const acceptedMessage = messages.slice(messagesBefore).find((entry) => entry.customType === "orchestrate-result");
    assert.ok(acceptedMessage, "command parsing dispatches accept-with-reason");
    assert.equal(acceptedMessage.details.status, "terminal");
    assert.equal(acceptedMessage.details.terminalOutcome, "accepted_with_reason");
    assert.equal(acceptedMessage.details.acceptance.reason, reason);
    assert.match(acceptedMessage.content, /ACCEPTED_WITH_REASON/);
    assert.match(acceptedMessage.content, /Owner accepts the documented presentation residual/);

    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(persisted.status, "terminal");
    assert.equal(persisted.terminalOutcome, "accepted_with_reason");
    assert.equal(persisted.acceptance.action, "accept");
    assert.equal(persisted.acceptance.reason, reason);
    assert.equal(persisted.acceptance.acceptedCheckpointId, verifierCheckpoint.id);
    assert.ok(persisted.acceptance.acceptedAt);
    assert.ok(persisted.currentApproval.consumedAt, "one-use checkpoint authority is durably consumed");
    assert.deepEqual(persisted.completedCriteria, beforeAcceptance.completedCriteria,
      "acceptance does not fabricate newly passed/completed criteria");
    assert.deepEqual(fs.readFileSync(verifierPayloadFile), verifierBytes,
      "acceptance never rewrites historical verifier findings or evidence");
    assert.equal(persisted.checkpoints.at(-1).kind, "acceptance");
    const acceptanceEnvelope = JSON.parse(fs.readFileSync(path.join(firstRunDir, `${persisted.checkpoints.at(-1).id}-acceptance.json`), "utf8"));
    assert.equal(acceptanceEnvelope.payload.acceptance.reason, reason);
    assert.equal(acceptanceEnvelope.payload.acceptedVerifierCheckpointId, verifierCheckpoint.id);
    assert.equal(fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).length, workerCallsBeforeAccept + 3,
      "only the second fixture run spawned workers; acceptance itself spawned none");

    const inspected = await call({ action: "inspect", runId: first.planned.details.runId }, workspaceA);
    assert.equal(inspected.details.terminalOutcome, "accepted_with_reason");
    assert.equal(inspected.details.acceptance.reason, reason);
    assert.match(inspected.content[0].text, /Accepted reason:/);
    await assert.rejects(
      () => call({ action: "accept", runId: first.planned.details.runId, approvalToken: first.failed.details.approvalToken, reason }, workspaceA),
      /irreversible|terminal|stale|consumed/i,
      "accepted authority cannot be replayed",
    );
    await assert.rejects(
      () => call({ action: "continue", runId: first.planned.details.runId, approvalToken: first.failed.details.approvalToken }, workspaceA),
      /irreversible|terminal|stale|consumed/i,
      "accepted runs cannot resume",
    );

    const acceptedSecond = await call({
      action: "accept", runId: second.planned.details.runId, approvalToken: second.failed.details.approvalToken,
      reason: "Second bounded acceptance exercises tool parsing.",
    }, workspaceB);
    assert.equal(acceptedSecond.details.terminalOutcome, "accepted_with_reason");

    console.log("PASS round7 AC: command/tool accept-with-reason is durable, one-use, settled-only, inspectable, and distinct from PASS");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error?.stack || error); process.exit(1); });
