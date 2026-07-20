#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeHangingFakePi(tmp) {
  const fake = path.join(tmp, "fake-pi-noise-malformed-hang.cjs");
  fs.writeFileSync(fake, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_PID_FILE, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
process.stdout.write(JSON.stringify({ type: "noise", note: "non-protocol JSON must not clear startup watchdog" }) + "\\n");
process.stdout.write("{ this is malformed json\\n");
setInterval(() => {}, 1000);
`, "utf8");
  return fake;
}

async function testProtocolEventAllowlist() {
  const { PI_JSON_PROTOCOL_EVENT_TYPES, isPiJsonProtocolEvent } = jiti(path.join(PROJECT_ROOT, "src", "child-launch.ts"));
  for (const type of PI_JSON_PROTOCOL_EVENT_TYPES) {
    assert.equal(isPiJsonProtocolEvent({ type }), true, `${type} should be a valid Pi JSON protocol event`);
  }
  assert.equal(isPiJsonProtocolEvent({ type: "noise" }), false, "unknown well-formed JSON must fail closed");
  assert.equal(isPiJsonProtocolEvent({ type: "" }), false);
  assert.equal(isPiJsonProtocolEvent({}), false);
  assert.equal(isPiJsonProtocolEvent(null), false);
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function assertZeroSurvivors(pidFile, label) {
  await sleep(2500);
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  assert.equal(isAlive(pids.pid), false, `${label}: fake Pi survivor remained: ${pids.pid}`);
  assert.equal(isAlive(pids.grandchild), false, `${label}: fake Pi grandchild survivor remained: ${pids.grandchild}`);
  return pids;
}

async function testSubstrateUnknownAndMalformedDoNotClearStartupTimeout() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-protocol-timeout-substrate-"));
  const fake = writeHangingFakePi(tmp);
  const pidFile = path.join(tmp, "fake-pids.json");
  const oldEnv = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    PI_CHILD_FIRST_JSON_TIMEOUT_MS: process.env.PI_CHILD_FIRST_JSON_TIMEOUT_MS,
    FAKE_PID_FILE: process.env.FAKE_PID_FILE,
  };

  process.env.PI_CLI_PATH = fake;
  process.env.PI_CHILD_FIRST_JSON_TIMEOUT_MS = "300";
  process.env.FAKE_PID_FILE = pidFile;

  let structured;
  try {
    const substrate = jiti(path.join(PROJECT_ROOT, "src", "substrate.ts"));
    const agents = new Map([["protocol-timeout", {
      name: "protocol-timeout",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tools: [],
      skills: [],
      systemPrompt: "Return normally only if this fake Pi unexpectedly reaches protocol startup.",
    }]]);
    await substrate.spawnSubagent("protocol-timeout", "timeout expected", { agents, cwd: tmp, allowLocalModel: false });
    assert.fail("expected first-valid-protocol-event timeout");
  } catch (error) {
    structured = JSON.parse(String(error && error.message || error));
  } finally {
    restoreEnv(oldEnv);
  }

  assert.equal(structured.type, "pi_child_first_json_timeout");
  await assertZeroSurvivors(pidFile, "substrate launcher");
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testInlineOrchestratorUnknownAndMalformedDoNotClearStartupTimeout() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-protocol-timeout-inline-"));
  const fake = writeHangingFakePi(tmp);
  const pidFile = path.join(tmp, "fake-pids.json");
  const oldEnv = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    PI_CHILD_FIRST_JSON_TIMEOUT_MS: process.env.PI_CHILD_FIRST_JSON_TIMEOUT_MS,
    FAKE_PID_FILE: process.env.FAKE_PID_FILE,
  };

  process.env.PI_CLI_PATH = fake;
  process.env.PI_CHILD_FIRST_JSON_TIMEOUT_MS = "300";
  process.env.FAKE_PID_FILE = pidFile;

  let result;
  try {
    const extensionModule = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
    const activate = typeof extensionModule === "function" ? extensionModule : extensionModule.default;
    let orchestrateTool;
    const fakePi = {
      registerTool(tool) {
        if (tool && tool.name === "orchestrate") orchestrateTool = tool;
      },
      registerCommand() {},
      sendMessage() {},
    };
    activate(fakePi);
    assert.ok(orchestrateTool, "orchestrate tool should be registered");
    result = await orchestrateTool.execute("test-call", {
      task: "Exercise the default inline plan-execute-verify launcher timeout path.",
      paradigm: "plan-execute-verify",
      preflight: false,
      maxRetries: 0,
      plannerCount: 1,
      verifierCount: 1,
      maxSubagents: 3,
      cwd: tmp,
    }, undefined, undefined, { cwd: tmp });
  } finally {
    restoreEnv(oldEnv);
  }

  assert.equal(result.details.status, "fail");
  assert.equal(result.details.aborted, true, "inline orchestrator should return a structured partial failure");
  const structured = JSON.parse(result.details.abortReason);
  assert.equal(structured.type, "pi_child_first_json_timeout");
  assert.equal(structured.agent, "planner");
  assert.equal(structured.cwd, tmp);
  await assertZeroSurvivors(pidFile, "inline orchestrator launcher");
  fs.rmSync(tmp, { recursive: true, force: true });
}

(async () => {
  await testProtocolEventAllowlist();
  await testSubstrateUnknownAndMalformedDoNotClearStartupTimeout();
  await testInlineOrchestratorUnknownAndMalformedDoNotClearStartupTimeout();
  console.log("PASS child-launch-protocol: Pi JSON event allowlist rejects unknown/malformed startup noise on substrate and inline orchestrator launchers; timeout cleanup leaves zero survivors");
})().catch((error) => {
  console.error("test-child-launch-protocol: FAIL");
  console.error(error);
  process.exit(1);
});
