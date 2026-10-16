#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");

function installJitiPath() {
  process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  return require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
}

async function childMain(mode) {
  const createJiti = installJitiPath();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"], "fresh host discovers the on-disk package entrypoint");
  const entrypoint = path.resolve(ROOT, manifest.pi.extensions[0]);
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  let tool;
  jiti(entrypoint).default({
    registerTool(value) { if (value.name === "orchestrate") tool = value; },
    registerCommand() {},
  });
  assert.ok(tool, "fresh host registered orchestrate from package manifest");
  for (const property of ["action", "runId", "approvalToken", "supervision", "lane"]) {
    assert.ok(tool.parameters.properties[property], `fresh schema exposes ${property}`);
  }
  const workspace = process.env.CANARY_WORKSPACE;
  const coordinatorWorkspace = process.env.CANARY_CONTEXT_WORKSPACE;
  assert.notEqual(path.resolve(workspace), path.resolve(coordinatorWorkspace), "explicit mission and coordinator workspaces differ");
  const call = (params) => tool.execute("fresh-host-canary", params, undefined, () => {}, { cwd: coordinatorWorkspace });

  if (mode === "plan") {
    const planned = await call({
      task: "CREATE file out-1.txt with fixture content.",
      cwd: workspace,
      paradigm: "composable-pipeline",
      predictedWriteSet: "out-1.txt",
      preflight: false,
      maxRetries: 0,
      verifierCount: 2,
      plannerProvider: "openai-codex",
      plannerModel: "gpt-5.6-sol",
      executorProvider: "openai-codex",
      executorModel: "gpt-5.6-sol",
      verifierProvider: "openai-codex",
      verifierModel: "gpt-5.5",
    });
    assert.equal(planned.details.status, "awaiting_supervisor");
    assert.equal(planned.details.checkpoint.kind, "plan");
    assert.equal(planned.details.protocol.adapterId, "generic-shape-adapter-v1", "composable-pipeline uses the generic visible-main adapter");
    assert.equal(path.resolve(planned.details.cwd), path.resolve(workspace), "explicit cwd is frozen as mission authority");
    assert.equal(fs.existsSync(path.join(workspace, "out-1.txt")), false);
    process.stdout.write(`${JSON.stringify({ pid: process.pid, runId: planned.details.runId, approvalToken: planned.details.approvalToken })}\n`);
    return;
  }

  if (mode === "verify-only") {
    const fixtureName = "canary.txt";
    const beforeNames = fs.readdirSync(workspace).sort();
    const beforeBytes = new Map(beforeNames.map((name) => [name, fs.readFileSync(path.join(workspace, name))]));
    const verified = await call({
      task: `Evidence checklist: confirm ${fixtureName} line 1 contains SAFE_CANARY and cite the exact file line.`,
      cwd: workspace,
      paradigm: "verify-only",
      supervision: "visible-main",
      preflight: false,
      verifierProvider: "openai-codex",
      verifierModel: "gpt-5.5",
    });
    assert.equal(verified.details.status, "pass", "read-only classification dispatches directly and returns PASS");
    assert.equal(verified.details.plannerSpawns, 0, "verify-only spawns zero planners");
    assert.equal(verified.details.executorSpawns, 0, "verify-only spawns zero executors");
    assert.equal(verified.details.spawnedCount, 1, "verify-only spawns exactly one reviewer");
    assert.match(verified.content[0].text, /canary\.txt:1 SAFE_CANARY/, "PASS includes a citation from the inspected fixture");

    const afterNames = fs.readdirSync(workspace).sort();
    assert.deepEqual(afterNames, beforeNames, "read-only worker cannot create or remove workspace files");
    for (const name of beforeNames) {
      assert.deepEqual(fs.readFileSync(path.join(workspace, name)), beforeBytes.get(name), `${name} remains byte immutable`);
    }
    assert.equal(fs.existsSync(path.join(workspace, "mutation-attempt.txt")), false, "hostile mutation probe had no mutation-capable path");

    const calls = fs.readFileSync(process.env.FAKE_PI_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(calls.length, 1, "fresh verify-only invocation launches one real CLI child path");
    assert.equal(calls[0].agentName, "reviewer");
    assert.equal(calls[0].provider, "openai-codex");
    assert.equal(calls[0].model, "gpt-5.5");
    // guard-decisions (2026-09-03): verify-only keeps bash; read-only is enforced by the host effects snapshot.
    assert.deepEqual(calls[0].tools.split(","), ["read", "grep", "find", "ls", "bash"], "reviewer receives the evidence tools plus bash");
    assert.equal(calls[0].noTools, false);
    assert.equal(calls[0].noExtensions, true, "mutation-capable extension tools remain unavailable");
    process.stdout.write(`${JSON.stringify({ pid: process.pid, status: verified.details.status, reviewers: 1, planners: 0, executors: 0 })}\n`);
    return;
  }

  if (mode === "resume-full") {
    const runId = process.env.CANARY_RUN_ID;
    const preRestartToken = process.env.CANARY_OLD_TOKEN;
    const stateFile = path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, runId, "supervision.json");
    const beforeInspect = fs.readFileSync(stateFile);
    const paused = await call({ action: "inspect", runId });
    assert.equal(paused.details.status, "paused", "a genuinely new host pauses nonterminal work and invalidates old approval");
    assert.equal(path.resolve(paused.details.cwd), path.resolve(workspace), "runId inspection restores the frozen mission cwd from a different coordinator cwd");
    assert.equal(paused.details.drift.some((flag) => flag.code === "cwd_changed"), false, "coordinator ctx.cwd is not mission drift");
    assert.match(String(paused.details.pauseReason), /process_restart_requires_fresh_visible_main_approval/);
    assert.deepEqual(fs.readFileSync(stateFile), beforeInspect, "fresh-host inspect remains byte immutable");

    const renewed = await call({ action: "continue", runId });
    assert.equal(renewed.details.status, "paused");
    assert.ok(renewed.details.approvalToken);
    await assert.rejects(() => call({ action: "continue", runId, approvalToken: preRestartToken }), /invalid|stale|consumed/);

    const executed = await call({ action: "continue", runId, approvalToken: renewed.details.approvalToken });
    assert.equal(executed.details.status, "awaiting_supervisor");
    assert.equal(executed.details.checkpoint.kind, "executor");
    assert.match(fs.readFileSync(path.join(workspace, "out-1.txt"), "utf8"), /^fixture content for out-1\.txt written at /);
    await assert.rejects(() => call({ action: "continue", runId, approvalToken: renewed.details.approvalToken }), /invalid|stale|consumed/);

    const executorInspectBytes = fs.readFileSync(stateFile);
    const executorInspect = await call({ action: "inspect", runId });
    assert.equal(executorInspect.details.status, "awaiting_supervisor");
    assert.deepEqual(fs.readFileSync(stateFile), executorInspectBytes);
    assert.ok(executorInspect.details.contentChanges.some((change) => change.path === "out-1.txt" && change.kind === "added"));

    const terminal = await call({ action: "continue", runId, approvalToken: executed.details.approvalToken });
    assert.equal(terminal.details.status, "terminal");
    assert.equal(terminal.details.terminalOutcome, "pass");
    assert.ok(terminal.details.findings.length > 0);
    assert.ok(terminal.details.findings.every((finding) => finding.evidence.length > 0));
    assert.equal(terminal.details.verifiers.length, 2, "terminal evidence retains both sibling verifier outputs");
    const batch = terminal.details.verificationBatch;
    assert.equal(batch.configuredCount, 2);
    assert.equal(batch.concurrency, 2);
    assert.equal(batch.members.length, 2);
    assert.equal(batch.parallelOverlap, true, "event ordering proves both verifier spawns began before either completed");
    assert.ok(Math.max(...batch.members.map((member) => member.spawnStartedSequence)) < Math.min(...batch.members.map((member) => member.completedSequence)));
    assert.ok(Math.max(...batch.members.map((member) => Date.parse(member.spawnStartedAt))) <= Math.min(...batch.members.map((member) => Date.parse(member.completedAt))), "wall-clock intervals overlap as well as ordered events");
    assert.ok(batch.aggregationStartedSequence > Math.max(...batch.members.map((member) => member.completedSequence)), "aggregation begins only after both reviewers settle");
    assert.ok(Date.parse(batch.aggregationStartedAt) >= Math.max(...batch.members.map((member) => Date.parse(member.completedAt))));
    assert.ok(batch.members.every((member) => member.agentName === "reviewer" && member.provider === "openai-codex" && member.model === "gpt-5.5"));
    await assert.rejects(() => call({ action: "continue", runId, approvalToken: executed.details.approvalToken }), /irreversible|terminal/);

    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual(persisted.runtime.verifierBatches.at(-1), batch, "parallel verifier evidence is durable in run state");
    const verifierCheckpoints = persisted.checkpoints.filter((checkpoint) => checkpoint.kind === "verifier");
    assert.equal(verifierCheckpoints.length, 2, "batch-start and aggregate verifier checkpoints are both recorded");
    assert.equal(verifierCheckpoints[0].outcome, "parallel_batch_started");
    const terminalPayload = JSON.parse(fs.readFileSync(verifierCheckpoints.at(-1).payloadFile, "utf8")).payload;
    assert.equal(terminalPayload.verifiers.length, 2, "terminal checkpoint persists both reviewer outputs");
    assert.deepEqual(terminalPayload.verificationBatch, batch);

    const inspectedTerminal = await call({ action: "inspect", runId });
    assert.deepEqual(inspectedTerminal.details.verifierBatches.at(-1), batch, "runId-only inspect exposes durable verifier concurrency evidence");

    const calls = fs.readFileSync(process.env.FAKE_PI_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const planners = calls.filter((entry) => entry.agentName === "planner");
    const coders = calls.filter((entry) => entry.agentName === "coder");
    const reviewers = calls.filter((entry) => entry.agentName === "reviewer");
    assert.equal(planners.length, 1);
    assert.equal(coders.length, 1);
    assert.equal(reviewers.length, 2);
    assert.ok(planners.every((entry) => entry.provider === "openai-codex" && entry.model === "gpt-5.6-sol"));
    assert.ok(coders.every((entry) => entry.provider === "openai-codex" && entry.model === "gpt-5.6-sol"));
    assert.ok(reviewers.every((entry) => entry.provider === "openai-codex" && entry.model === "gpt-5.5"));
    process.stdout.write(`${JSON.stringify({ pid: process.pid, status: terminal.details.status, outcome: terminal.details.terminalOutcome, replayRefused: true })}\n`);
    return;
  }

  throw new Error(`unknown child mode ${mode}`);
}

function runFresh(mode, env) {
  const result = spawnSync(process.execPath, [__filename], {
    cwd: ROOT,
    env: { ...process.env, ...env, CANARY_CHILD_MODE: mode },
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `fresh host ${mode} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const lines = String(result.stdout).trim().split("\n").filter(Boolean);
  assert.ok(lines.length, `fresh host ${mode} returned no canary result`);
  return JSON.parse(lines.at(-1));
}

async function parentMain() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-fresh-workspace-a-"));
  const coordinatorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-fresh-workspace-b-"));
  const readOnlyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-fresh-read-only-"));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visible-main-fresh-runs-"));
  const log = path.join(runRoot, "fresh-fake-log.jsonl");
  const readOnlyLog = path.join(runRoot, "fresh-read-only-fake-log.jsonl");
  fs.writeFileSync(path.join(readOnlyWorkspace, "canary.txt"), "SAFE_CANARY immutable evidence\n", "utf8");
  const env = {
    CANARY_WORKSPACE: workspace,
    CANARY_CONTEXT_WORKSPACE: coordinatorWorkspace,
    PI_ORCHESTRATOR_RUNS_ROOT: runRoot,
    PI_CLI_PATH: path.join(__dirname, "fake-pi.cjs"),
    FAKE_PI_LOG: log,
    FAKE_PI_PLAN_STYLE: "impl-1-ws",
    FAKE_PI_EXECUTOR_STYLE: "write-summary-table",
    FAKE_PI_VISIBLE_VERIFY_DELAY_MS: "150",
  };
  try {
    const planned = runFresh("plan", env);
    assert.notEqual(planned.pid, process.pid, "plan ran in a fresh host process");
    const completed = runFresh("resume-full", { ...env, CANARY_RUN_ID: planned.runId, CANARY_OLD_TOKEN: planned.approvalToken });
    assert.notEqual(completed.pid, process.pid, "lifecycle continuation ran in a fresh host process");
    assert.notEqual(completed.pid, planned.pid, "restart proof uses a different host instance");
    assert.deepEqual({ status: completed.status, outcome: completed.outcome, replayRefused: completed.replayRefused }, { status: "terminal", outcome: "pass", replayRefused: true });
    const readOnly = runFresh("verify-only", {
      ...env,
      CANARY_WORKSPACE: readOnlyWorkspace,
      FAKE_PI_LOG: readOnlyLog,
      FAKE_PI_SAFE_EVIDENCE_FIXTURE: "canary.txt",
    });
    assert.notEqual(readOnly.pid, process.pid, "verify-only ran in a fresh host process");
    assert.deepEqual(
      { status: readOnly.status, reviewers: readOnly.reviewers, planners: readOnly.planners, executors: readOnly.executors },
      { status: "pass", reviewers: 1, planners: 0, executors: 0 },
    );
    console.log("test-visible-main-fresh-host: restart lifecycle and fresh verify-only safe-tool evidence inspection passed in fresh processes");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(coordinatorWorkspace, { recursive: true, force: true });
    fs.rmSync(readOnlyWorkspace, { recursive: true, force: true });
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

if (process.env.CANARY_CHILD_MODE) {
  childMain(process.env.CANARY_CHILD_MODE).catch((error) => { console.error(error); process.exit(1); });
} else {
  parentMain().catch((error) => { console.error(error); process.exit(1); });
}
