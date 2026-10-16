#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(PROJECT_ROOT, "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const mission = jiti(path.join(PROJECT_ROOT, "src", "mission", "index.ts"));

const ROUTE = {
  provider: process.env.DMS_LIVE_PROVIDER || "openai-codex",
  model: process.env.DMS_LIVE_MODEL || "gpt-5.5",
  thinkingLevel: "off",
};

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-rpc-live-"));
  const cwd = path.join(root, "workspace");
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(cwd);
  const cliPath = path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  assert.equal(fs.existsSync(cliPath), true, "installed Pi CLI is required");
  const factory = new mission.PiRpcMissionWorkerFactory({
    cliPath,
    sessionRoot,
    heartbeatMs: 250,
    promptTimeoutMs: 120_000,
    shutdownGraceMs: 2_000,
  });
  const request = {
    runId: "real-rpc-recovery",
    generation: 1,
    cwd,
    route: ROUTE,
    fallbacks: [],
    readOnly: false,
  };
  try {
    const first = await factory.open(request);
    const firstPid = first.identity.pid;
    assert.equal((await first.inspect()).state, "idle");
    const events = await collect(first.prompt("Reply with exactly DMS_RPC_RECOVERY_OK and no other text. Do not call tools."));
    const settled = events.find((event) => event.type === "settled");
    assert.ok(settled?.cursor, "real Pi must publish a durable session cursor");
    assert.ok(settled.tokens > 0, "real Pi token delta must be observed");
    assert.equal(events.some((event) => event.type === "tool"), false, "bounded probe must not call tools");
    assert.equal(fs.existsSync(first.identity.sessionFile), true, "settled Pi session must be durable before shutdown");
    const sessionEntries = fs.readFileSync(first.identity.sessionFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const assistant = sessionEntries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").at(-1)?.message;
    const assistantText = assistant?.content?.filter((item) => item.type === "text").map((item) => item.text).join("") ?? "";
    assert.equal(assistantText.trim(), "DMS_RPC_RECOVERY_OK", "real RPC probe must verify the model output, not only settlement");
    const identity = { ...first.identity, route: { ...first.identity.route } };
    await first.close();
    assert.equal(await waitDead(firstPid), true, "first RPC process must exit cleanly");

    const second = await factory.open({ ...request, generation: 2, resume: identity });
    assert.equal(second.identity.sessionId, identity.sessionId);
    assert.equal(second.identity.sessionFile, identity.sessionFile);
    assert.equal(second.identity.cursor, identity.cursor);
    assert.notEqual(second.identity.pid, identity.pid);
    assert.equal(second.identity.route.provider, identity.route.provider);
    assert.equal(second.identity.route.model, identity.route.model);
    assert.equal((await second.inspect()).state, "idle");
    const secondPid = second.identity.pid;
    await second.close();
    assert.equal(await waitDead(secondPid), true, "resumed RPC process must exit cleanly");
    console.log(`PASS durable-mission real RPC: settled cursor/tokens persisted and exact ${ROUTE.provider}/${ROUTE.model} session reopened under a new PID with zero model work on resume`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
