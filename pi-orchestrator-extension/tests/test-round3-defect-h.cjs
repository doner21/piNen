#!/usr/bin/env node
/** H only: untargeted external scheduler records are discovered on activity and survive reload overdue. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "round3-defect-h-"));
const cwd = path.join(home, "workspace");
const storePath = path.join(home, "scheduler.json");
fs.mkdirSync(cwd, { recursive: true });

const previous = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  NODE_PATH: process.env.NODE_PATH,
};
process.env.PI_CODING_AGENT_DIR = home;
const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const listeners = new Map();
const delivered = [];
const sessionEntries = [];
let idle = true;
const pi = {
  on(name, handler) {
    const handlers = listeners.get(name) || [];
    handlers.push(handler);
    listeners.set(name, handlers);
  },
  registerTool() {},
  registerCommand() {},
  async sendUserMessage(message, options) {
    delivered.push({ message, options });
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    };
    sessionEntries.push({
      type: "message",
      id: `wake-${sessionEntries.length + 1}`,
      parentId: sessionEntries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message: userMessage,
    });
    await emit("context", { messages: [userMessage] });
  },
};
const ctx = {
  cwd,
  hasUI: false,
  isIdle: () => idle,
  sessionManager: {
    getSessionFile: () => path.join(home, "fixture-session.jsonl"),
    getEntries: () => sessionEntries,
  },
  ui: { notify() {} },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function emit(name, event = {}) {
  for (const handler of listeners.get(name) || []) await handler(event, ctx);
}

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function injectPending(id, message) {
  const store = fs.existsSync(storePath)
    ? readStore()
    : { version: 1, schedules: {}, nextSeq: 1 };
  const now = Date.now();
  store.schedules[id] = {
    id,
    message,
    dueAt: now - 50,
    createdAt: now - 100,
    status: "pending",
    originCwdKey: process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd),
    originCwd: cwd,
    // Legacy external records with neither session field remain cwd-routed.
    createdBy: "tool",
    updatedAt: now - 100,
  };
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

(async () => {
  try {
    const stubs = {
      piAi: path.join(home, "stub-pi-ai.cjs"),
      codingAgent: path.join(home, "stub-coding-agent.cjs"),
      typebox: path.join(home, "stub-typebox.cjs"),
    };
    fs.writeFileSync(stubs.piAi, "module.exports = { StringEnum: (values, options) => ({ values, ...options }) };\n");
    fs.writeFileSync(stubs.codingAgent, "module.exports = { getAgentDir: () => process.env.PI_CODING_AGENT_DIR };\n");
    fs.writeFileSync(stubs.typebox, "module.exports = { Type: new Proxy({}, { get: () => (...args) => ({ args }) }) };\n");
    const jiti = require(path.join(piModules, "jiti", "lib", "jiti.cjs"))(__filename, {
      interopDefault: true,
      moduleCache: false,
      fsCache: false,
      alias: {
        "@earendil-works/pi-ai": stubs.piAi,
        "@earendil-works/pi-coding-agent": stubs.codingAgent,
        typebox: stubs.typebox,
      },
    });
    const extension = jiti(path.join(ROOT, "..", "agent", "extensions", "agent-scheduler", "index.ts")).default;
    extension(pi);

    await emit("session_start", { reason: "startup" });
    await waitFor(() => fs.existsSync(storePath), "isolated scheduler store creation");
    await sleep(350); // let the startup drain finish before external injection

    injectPending("sched-external-input", "wake discovered from user input");
    idle = false;
    await emit("input", {
      text: "ordinary user activity",
      images: [],
      source: "interactive",
    });
    assert.equal(delivered.length, 0, "ordinary input owns its active turn");
    idle = true;
    await emit("agent_settled", {});
    await waitFor(
      () => delivered.some((entry) => entry.message.includes("#sched-external-input")),
      "input-triggered external schedule delivery",
    );
    await waitFor(
      () => readStore().schedules["sched-external-input"].status === "delivered",
      "input-triggered delivery finalization",
    );

    injectPending("sched-external-turn", "wake discovered from turn end");
    idle = false;
    await emit("turn_end", { turnIndex: 1, message: {}, toolResults: [] });
    assert.equal(delivered.length, 1, "turn_end does not overlap an active run");
    idle = true;
    await emit("agent_settled", {});
    await waitFor(
      () => delivered.some((entry) => entry.message.includes("#sched-external-turn")),
      "turn-end-triggered external schedule delivery",
    );
    await waitFor(
      () => readStore().schedules["sched-external-turn"].status === "delivered",
      "turn-end-triggered delivery finalization",
    );

    await emit("session_shutdown", { reason: "reload" });
    injectPending("sched-overdue-reload", "continuation became overdue during reload");
    await emit("session_start", { reason: "reload" });
    await waitFor(
      () => delivered.some((entry) => entry.message.includes("#sched-overdue-reload")),
      "overdue reload continuation delivery",
    );
    await waitFor(
      () => readStore().schedules["sched-overdue-reload"].status === "delivered",
      "overdue reload delivery finalization",
    );

    const reloadDelivery = delivered.find((entry) => entry.message.includes("#sched-overdue-reload"));
    assert.equal(reloadDelivery.options.deliverAs, "followUp");
    assert.match(reloadDelivery.message, /Overdue by:/);
    assert.equal(delivered.length, 3, "each external record is delivered exactly once");
    console.log("test-round3-defect-h: external schedules refresh on input/turn end; reload overdue delivers once");
  } finally {
    await emit("session_shutdown", { reason: "quit" }).catch(() => {});
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
