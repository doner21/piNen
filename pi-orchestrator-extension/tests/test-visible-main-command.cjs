#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));

function delay(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function removeWindowsNulArtifact(workspace) {
  if (process.platform !== "win32" || !fs.existsSync(workspace) || !fs.readdirSync(workspace).includes("NUL")) return;
  // Node's Win32 filesystem API cannot unlink a literal reserved basename.
  // The fixture was created by Git Bash, so remove it through that same
  // bounded POSIX-shell path before deleting the temporary workspace.
  const result = spawnSync("bash", ["-lc", "rm -f -- NUL"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || fs.readdirSync(workspace).includes("NUL")) {
    throw new Error(`failed to clean fixture NUL artifact: ${result.stderr || result.error || "unknown error"}`);
  }
}

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-command-"));
  const secondWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-command-controls-"));
  const failWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-command-fail-"));
  const nulWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-command-nul-"));
  const blockedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-command-blocked-"));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-command-runs-"));
  const log = path.join(runRoot, "fake-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runRoot;
  process.env.FAKE_PI_LOG = log;
  process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";
  process.env.FAKE_PI_EXECUTOR_STYLE = "write-summary-table";

  const messages = [];
  const followups = [];
  const notifications = [];
  const widgets = [];
  const statuses = [];
  let command;
  let tool;
  let handlerSettled = false;
  let inputCalls = 0;

  const pi = {
    registerTool(value) { if (value.name === "orchestrate") tool = value; },
    registerCommand(name, value) { if (name === "orchestrate") command = value; },
    sendMessage(value) { messages.push(value); },
    sendUserMessage(content, options) { followups.push({ content, options, afterHandlerYield: handlerSettled }); },
  };
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  jiti(path.join(ROOT, "src", "index.ts")).default(pi);
  assert.ok(command && tool, "package registers the established command and tool");

  function context(cwd) {
    return {
      cwd,
      hasUI: true,
      signal: undefined,
      ui: {
        async input() { inputCalls += 1; throw new Error("non-interactive fixture must not prompt"); },
        notify(message, level) { notifications.push({ message, level }); },
        setWidget(key, value) { widgets.push({ key, value }); },
        setStatus(key, value) { statuses.push({ key, value }); },
        setEditorText() {},
      },
    };
  }

  async function invoke(args, cwd = workspace) {
    handlerSettled = false;
    const before = messages.length;
    await command.handler(args, context(cwd));
    handlerSettled = true;
    await delay();
    const resultMessages = messages.slice(before).filter((entry) => entry.customType === "orchestrate-result");
    return resultMessages.at(-1);
  }

  try {
    const plannedMessage = await invoke("--no-preflight --max-retries 0 --write-set out-1.txt -- CREATE file out-1.txt with fixture content.");
    assert.equal(plannedMessage.details.status, "awaiting_supervisor", "command defaults executor-bearing PEV to visible-main");
    assert.equal(plannedMessage.details.checkpoint.kind, "plan");
    assert.equal(fs.existsSync(path.join(workspace, "out-1.txt")), false, "plan checkpoint precedes executor spawn");
    assert.match(plannedMessage.content, /awaiting_supervisor is not completion/);
    assert.match(plannedMessage.content, /Legal actions: inspect, continue, pause, cancel/);
    assert.equal(followups.length, 1, "plan checkpoint injects one command-only wake-up");
    assert.equal(followups[0].afterHandlerYield, true, "wake-up is injected only after the command handler yields");
    assert.deepEqual(followups[0].options, { deliverAs: "followUp" });
    assert.match(followups[0].content, /^ORCHESTRATE_VISIBLE_MAIN_CHECKPOINT\nInspect runId=orc-[a-z0-9-]+ checkpointId=checkpoint-\d{4};/);
    assert.doesNotMatch(followups[0].content, /sup1_|fixture content|approval/i, "wake-up contains no token or mutable task text");

    const runId = plannedMessage.details.runId;
    const token = plannedMessage.details.approvalToken;
    const stateFile = path.join(runRoot, runId, "supervision.json");
    const beforeInspect = fs.readFileSync(stateFile);
    const inspectedMessage = await invoke(`inspect --run-id ${runId}`);
    assert.equal(inspectedMessage.details.status, "awaiting_supervisor");
    assert.deepEqual(fs.readFileSync(stateFile), beforeInspect, "command inspect is byte-immutable");
    assert.equal(followups.length, 1, "inspect cannot duplicate the command wake-up");

    const toolInspect = await tool.execute("command-tool-inspect", { action: "inspect", runId }, undefined, () => {}, { cwd: workspace });
    assert.equal(toolInspect.details.status, "awaiting_supervisor");
    await delay();
    assert.equal(followups.length, 1, "tool-call checkpoints never create command wake-ups");

    const executedMessage = await invoke(`continue --run-id ${runId} --approval-token ${token}`);
    assert.equal(executedMessage.details.status, "awaiting_supervisor");
    assert.equal(executedMessage.details.checkpoint.kind, "executor");
    assert.ok(fs.existsSync(path.join(workspace, "out-1.txt")));
    assert.equal(followups.length, 2, "settled executor checkpoint injects exactly one wake-up");
    assert.notEqual(followups[1].content, followups[0].content, "checkpoint id advances");
    assert.doesNotMatch(followups[1].content, /sup1_|fixture content/, "executor wake-up remains opaque");

    const notificationCount = notifications.length;
    await assert.rejects(() => invoke(`--action continue --run-id ${runId} --token ${token}`), /stale|consumed|invalid/);
    assert.ok(notifications.slice(notificationCount).some((entry) => entry.level === "error" && /failed/i.test(entry.message)), "replayed approval is visibly refused");
    assert.equal(followups.length, 2, "replay refusal cannot queue another wake-up");

    const terminalMessage = await invoke(`--continue --run-id ${runId} --approval-token ${executedMessage.details.approvalToken}`);
    assert.equal(terminalMessage.details.status, "terminal");
    assert.equal(terminalMessage.details.terminalOutcome, "pass");
    assert.match(terminalMessage.content, /terminal PASS/);
    assert.equal(followups.length, 2, "terminal result has no wake-up");
    assert.ok(notifications.some((entry) => entry.level === "info" && /terminal PASS/.test(entry.message)), "terminal PASS is honestly labeled");

    if (process.platform === "win32") {
      process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws-nul-diagnostic";
      const callCountBeforeRecurrence = readJsonLines(log).length;
      const nulPlan = await invoke("--no-preflight --max-retries 0 --write-set out-1.txt -- CREATE file out-1.txt with fixture content.", nulWorkspace);
      assert.equal(nulPlan.details.status, "awaiting_supervisor");
      assert.equal(nulPlan.details.checkpoint.kind, "plan");
      assert.ok(fs.readdirSync(nulWorkspace).includes("NUL"), "POSIX-shell planner diagnostic created the literal root NUL recurrence artifact");
      assert.equal(nulPlan.details.checkpoint.effectChanges.some((change) => /(?:^|\/)NUL(?:\.|$)/i.test(change.path)), false,
        "NUL is absent from plan-checkpoint effects");

      const nulExec = await invoke(`continue --run-id ${nulPlan.details.runId} --approval-token ${nulPlan.details.approvalToken}`, nulWorkspace);
      assert.equal(nulExec.details.status, "awaiting_supervisor", "planner-created NUL cannot block continuation");
      assert.equal(nulExec.details.checkpoint.kind, "executor", "executor spawned and settled after the poisoned-baseline recurrence");
      assert.deepEqual(nulExec.details.checkpoint.effectChanges.map((change) => change.path), ["out-1.txt"],
        "NUL cannot appear as an out-of-scope executor effect");

      const recurrenceCalls = readJsonLines(log).slice(callCountBeforeRecurrence);
      const plannerCall = recurrenceCalls.find((call) => call.agentName === "planner");
      const executorCall = recurrenceCalls.find((call) => call.agentName === "coder");
      assert.ok(plannerCall && executorCall, "both planner and executor subprocesses were observed");
      assert.equal(plannerCall.promptDirectsPosixDevNull, true, "planner guidance requires /dev/null rather than literal NUL");
      assert.equal(executorCall.promptDirectsPosixDevNull, true, "executor guidance requires /dev/null rather than literal NUL");
      process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";
    }

    const failPlan = await invoke("--no-preflight --max-retries 0 --write-set out-1.txt -- CREATE file out-1.txt with fixture content.", failWorkspace);
    const failExec = await invoke(`continue --run-id ${failPlan.details.runId} --approval-token ${failPlan.details.approvalToken}`, failWorkspace);
    process.env.FAKE_PI_VISIBLE_VERIFY_FAIL = "1";
    const terminalFail = await invoke(`continue --run-id ${failPlan.details.runId} --approval-token ${failExec.details.approvalToken}`, failWorkspace);
    delete process.env.FAKE_PI_VISIBLE_VERIFY_FAIL;
    assert.equal(terminalFail.details.status, "terminal");
    assert.equal(terminalFail.details.terminalOutcome, "fail");
    assert.ok(notifications.some((entry) => entry.level === "error" && /terminal FAIL/.test(entry.message)), "terminal FAIL is honestly labeled");

    if (process.platform === "win32") process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws-nul-diagnostic";
    const driftPlan = await invoke("--no-preflight --write-set out-1.txt -- CREATE file out-1.txt with fixture content.", blockedWorkspace);
    fs.writeFileSync(path.join(blockedWorkspace, "external-drift.txt"), "drift\n", "utf8");
    const driftInspection = await invoke(`inspect --run-id ${driftPlan.details.runId}`, blockedWorkspace);
    const driftFlags = driftInspection.details.drift.filter((flag) => flag.code === "content_baseline_changed");
    assert.equal(driftFlags.length, 1);
    assert.equal(driftFlags[0].blocking, false, "ordinary byte drift is an inspectable supervisor advisory");
    assert.match(JSON.stringify(driftInspection.details.drift), /external-drift\.txt/, "ordinary drift names its changed path");
    assert.doesNotMatch(JSON.stringify(driftInspection.details.drift), /(?:^|[\\/\"'])NUL(?:\.|[\\/\"'])/i,
      "NUL is absent from the drift advisory");
    const acknowledged = await invoke(`continue --run-id ${driftPlan.details.runId} --approval-token ${driftPlan.details.approvalToken}`, blockedWorkspace);
    assert.equal(acknowledged.details.status, "awaiting_supervisor", "continue acknowledges advisory drift and reaches the executor boundary");
    assert.deepEqual(acknowledged.details.checkpoint.effectChanges.map((change) => change.path), ["out-1.txt"],
      "acknowledged external drift is not misattributed to the executor");
    process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";

    const controlPlan = await invoke("run --supervision visible-main --lane product --no-preflight --write-set out-1.txt -- CREATE file out-1.txt with fixture content.", secondWorkspace);
    const controlRunId = controlPlan.details.runId;
    const paused = await invoke(`pause --run-id ${controlRunId}`, secondWorkspace);
    assert.equal(paused.details.status, "paused");
    assert.ok(notifications.some((entry) => entry.level === "warning" && /paused/.test(entry.message)));
    const cancelled = await invoke(`--cancel --run-id ${controlRunId}`, secondWorkspace);
    assert.equal(cancelled.details.status, "cancelled");
    await assert.rejects(() => invoke(`continue --run-id ${controlRunId} --approval-token ${paused.details.approvalToken}`, secondWorkspace), /irreversible|cancelled/);

    await assert.rejects(() => invoke("resume definitely-missing-legacy-run", workspace), /Resume state not found|Run state not found|not found/i);
    assert.equal(inputCalls, 0, "inspect/continue/pause/cancel and legacy resume never prompt for a task");
    assert.equal(widgets.at(-1).value, undefined, "active command dashboard is cleared after yielding");
    assert.equal(statuses.at(-1).value, undefined, "active command footer state is cleared after yielding");

    console.log("test-visible-main-command: command forms, UI states, opaque wake-ups, replay refusal, and no-prompt controls passed");
  } finally {
    for (const key of ["PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "FAKE_PI_LOG", "FAKE_PI_PLAN_STYLE", "FAKE_PI_EXECUTOR_STYLE", "FAKE_PI_VISIBLE_VERIFY_FAIL"]) delete process.env[key];
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(secondWorkspace, { recursive: true, force: true });
    fs.rmSync(failWorkspace, { recursive: true, force: true });
    removeWindowsNulArtifact(nulWorkspace);
    fs.rmSync(nulWorkspace, { recursive: true, force: true });
    removeWindowsNulArtifact(blockedWorkspace);
    fs.rmSync(blockedWorkspace, { recursive: true, force: true });
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
