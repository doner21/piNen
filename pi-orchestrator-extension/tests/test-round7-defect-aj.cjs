#!/usr/bin/env node
/** AJ: opt-in no-force-kill missions reject bash timeout arguments before dispatch. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });

function activateGuard() {
  let hook;
  const guard = jiti(path.join(ROOT, "src", "worker-execution-constraints.ts"));
  guard.default({
    on(event, handler) {
      if (event === "tool_call") hook = handler;
    },
  });
  assert.equal(typeof hook, "function", "guard must explicitly register a pre-dispatch tool_call hook");
  return { guard, hook };
}

async function dispatchThrough(hook, toolName, input, spy) {
  const decision = await hook({ toolName, toolCallId: "aj-spy", input }, {});
  if (decision?.block) return decision;
  spy.calls += 1;
  return { dispatched: true };
}

(async () => {
  const { guard, hook } = activateGuard();
  const spy = { calls: 0 };
  // NULL-TIMEOUT-ALLOWED (owner rule, 6 October 2026, superseding the prior
  // "key presence, including null, is forbidden" policy for null only):
  // null is premise-corrected out of this forbidden-value list because a
  // strict tool schema (OpenAI GPT-6.1 Sol workers) always sends
  // timeout: null for an omitted optional field. Every other owned value
  // stays forbidden, proven immediately below.
  for (const timeout of [undefined, 0, 1, 20, 120, "20"]) {
    const input = { command: "printf harmless", timeout };
    assert.equal(Object.hasOwn(input, "timeout"), true);
    const result = await dispatchThrough(hook, "bash", input, spy);
    assert.equal(result.block, true, `owned timeout=${String(timeout)} must be blocked`);
    assert.match(result.reason, /no-force-kill|timeout/i);
  }
  assert.equal(spy.calls, 0, "forbidden calls are intercepted before the harmless dispatch spy");

  const nullTimeoutResult = await dispatchThrough(hook, "bash", { command: "printf harmless-null-timeout", timeout: null }, spy);
  assert.equal(nullTimeoutResult.dispatched, true,
    "NULL-TIMEOUT-ALLOWED: an owned timeout key whose value is null must execute, not be blocked");
  assert.equal(spy.calls, 1, "the null-timeout dispatch reaches the harmless spy exactly once");

  const ordinary = await dispatchThrough(hook, "bash", { command: "printf harmless" }, spy);
  assert.equal(ordinary.dispatched, true, "a bash call that omits timeout remains available");
  const inherited = Object.create({ timeout: 20 });
  inherited.command = "printf harmless";
  assert.equal((await dispatchThrough(hook, "bash", inherited, spy)).dispatched, true,
    "the guard follows the narrow owning-key rule rather than inspecting prototypes");
  assert.equal((await dispatchThrough(hook, "read", { path: "x", timeout: 20 }, spy)).dispatched, true,
    "the guard is scoped to bash dispatch only");
  assert.equal(spy.calls, 4, "the null-timeout, ordinary, inherited-prototype and non-bash dispatches all reached the spy");
  assert.equal(guard.ownsBashTimeoutArgument({ timeout: null }), true);
  assert.equal(guard.ownsBashTimeoutArgument({}), false);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "round7-aj-"));
  const runsRoot = path.join(home, "runs");
  const workspace = path.join(home, "workspace");
  const log = path.join(home, "fake-pi.jsonl");
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  // Extend the existing deterministic fake only with argv observation. No shell
  // command is dispatched, and no destructive timeout probe is performed.
  const fakePi = path.join(home, "fake-pi-aj.cjs");
  const source = fs.readFileSync(path.join(__dirname, "fake-pi.cjs"), "utf8");
  const anchor = '    noExtensions: args.includes("--no-extensions"),';
  assert.ok(source.includes(anchor));
  fs.writeFileSync(fakePi, source.replace(anchor,
    `${anchor}\n    explicitExtensions: args.reduce((out, arg, index) => arg === "--extension" || arg === "-e" ? [...out, args[index + 1]] : out, []),`));

  const previous = Object.fromEntries([
    "PI_CLI_PATH", "PI_ORCHESTRATOR_RUNS_ROOT", "FAKE_PI_LOG", "FAKE_PI_PLAN_STYLE", "FAKE_PI_EXECUTOR_STYLE",
  ].map((key) => [key, process.env[key]]));
  process.env.PI_CLI_PATH = fakePi;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  process.env.FAKE_PI_LOG = log;
  process.env.FAKE_PI_PLAN_STYLE = "impl-1-ws";
  process.env.FAKE_PI_EXECUTOR_STYLE = "write-summary-table";

  try {
    const substrate = jiti(path.join(ROOT, "src", "substrate.ts"));
    const agents = new Map([["probe", { name: "probe", tools: ["bash"] }]]);
    await substrate.spawnSubagent("probe", "ordinary mission", {
      agents, cwd: workspace, allowLocalModel: false,
    });
    await substrate.spawnSubagent("probe", "guarded mission", {
      agents, cwd: workspace, allowLocalModel: false,
      workerExecutionConstraints: { noForceKill: true },
    });
    let calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.deepEqual(calls[0].explicitExtensions, [], "ordinary subprocess behavior remains unchanged");
    assert.equal(calls[0].noExtensions, true);
    assert.equal(calls[1].noExtensions, true, "unrelated extension discovery remains disabled");
    assert.deepEqual(calls[1].explicitExtensions, [path.join(ROOT, "src", "worker-execution-constraints.ts")],
      "the narrowly scoped guard is the sole explicitly loaded worker extension");

    let tool;
    const orchestrator = jiti(path.join(ROOT, "src", "index.ts"));
    assert.equal(
      orchestrator.parseOrchestrateCommandArgsForTest("run --no-force-kill -- harmless mission").noForceKill,
      true,
      "the slash command exposes the explicit opt-in",
    );
    assert.throws(
      () => orchestrator.parseOrchestrateCommandArgsForTest("run --no-force-kill=false -- harmless mission"),
      /does not take a value/i,
      "the slash flag cannot be ambiguously disabled with an inline value",
    );
    orchestrator.default({
      registerTool(value) { if (value.name === "orchestrate") tool = value; },
      registerCommand() {}, sendMessage() {}, sendUserMessage() {},
    });
    assert.ok(tool);
    const call = (params) => tool.execute("round7-aj", params, undefined, () => {}, { cwd: workspace });
    const planned = await call({
      action: "run", supervision: "visible-main", preflight: false, noForceKill: true,
      cwd: workspace, predictedWriteSet: "out.txt", task: "CREATE file out.txt with fixture content.",
    });
    const stateFile = path.join(runsRoot, planned.details.runId, "supervision.json");
    let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual(state.mission.workerExecutionConstraints, { noForceKill: true },
      "the opt-in is frozen into mission identity");
    assert.equal(state.runtime.params.noForceKill, true, "resume parameters retain the frozen opt-in");

    await call({ action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken });
    calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const missionCalls = calls.slice(2);
    assert.ok(missionCalls.length >= 2, "planner and executor were observed");
    for (const observed of missionCalls) {
      assert.equal(observed.noExtensions, true);
      assert.deepEqual(observed.explicitExtensions, [path.join(ROOT, "src", "worker-execution-constraints.ts")]);
    }

    await assert.rejects(
      () => call({ action: "continue", runId: planned.details.runId, noForceKill: false, approvalToken: "hostile" }),
      /constraint drift|noForceKill/i,
      "a resumed mission cannot weaken its frozen execution constraint",
    );

    const ordinaryWorkspace = path.join(home, "ordinary-workspace");
    fs.mkdirSync(ordinaryWorkspace);
    const ordinaryPlan = await tool.execute("round7-aj-ordinary", {
      action: "run", supervision: "visible-main", preflight: false,
      cwd: ordinaryWorkspace, predictedWriteSet: "out.txt", task: "CREATE file out.txt with fixture content.",
    }, undefined, () => {}, { cwd: ordinaryWorkspace });
    state = JSON.parse(fs.readFileSync(path.join(runsRoot, ordinaryPlan.details.runId, "supervision.json"), "utf8"));
    assert.deepEqual(state.mission.workerExecutionConstraints, { noForceKill: false },
      "ordinary missions freeze the existing default behavior explicitly");
    const lastCall = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).at(-1);
    assert.deepEqual(lastCall.explicitExtensions, [], "ordinary mission workers do not load the guard");

    console.log("PASS round7 AJ: frozen opt-in no-force-kill missions explicitly load one bash pre-dispatch guard, reject every owned timeout key except null before dispatch, retain --no-extensions isolation, and leave ordinary missions unchanged");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error?.stack || error); process.exit(1); });
