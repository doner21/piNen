#!/usr/bin/env node
/** Round 7 AF: store reads retire only conclusively orphaned session fences. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const previous = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  NODE_PATH: process.env.NODE_PATH,
};
const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

function normalizedCwd(cwd) {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pendingRecord(id, cwd, targetSessionFile) {
  const now = Date.now();
  return {
    id,
    message: `wake ${id}`,
    dueAt: now + 60_000,
    createdAt: now - 60_000,
    status: "pending",
    originCwdKey: normalizedCwd(cwd),
    originCwd: cwd,
    originSessionFile: targetSessionFile,
    targetSessionFile,
    createdBy: "tool",
    updatedAt: now - 60_000,
  };
}

function writeStore(home, records) {
  fs.writeFileSync(
    path.join(home, "scheduler.json"),
    JSON.stringify({ version: 1, schedules: Object.fromEntries(records.map((record) => [record.id, record])), nextSeq: 20 }, null, 2),
  );
}

function readStore(home) {
  return JSON.parse(fs.readFileSync(path.join(home, "scheduler.json"), "utf8"));
}

function loadSchedulerModule(home) {
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
  return jiti(path.join(ROOT, "..", "agent", "extensions", "agent-scheduler", "index.ts"));
}

function createHarness(extension, cwd, sessionFile) {
  const tools = new Map();
  const listeners = new Map();
  const sends = [];
  const ctx = {
    cwd,
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: { notify() {} },
  };
  const pi = {
    on(name, handler) {
      const handlers = listeners.get(name) || [];
      handlers.push(handler);
      listeners.set(name, handlers);
    },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    sendUserMessage(message, options) { sends.push({ message, options }); },
  };
  extension(pi);
  return {
    ctx,
    sends,
    tools,
    async get(id) {
      return tools.get("agent_scheduler").execute("af-get", { action: "get", id }, undefined, undefined, ctx);
    },
    async close() {
      for (const handler of listeners.get("session_shutdown") || []) await handler({ reason: "quit" }, ctx);
    },
  };
}

async function runScenario(name, configure, assertions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `round7-defect-af-${name}-`));
  const cwd = path.join(home, "workspace");
  const currentSession = path.join(home, "sessions", "current.jsonl");
  const targetSession = path.join(home, "sessions", "missing-target.jsonl");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(currentSession), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = home;
  const module = loadSchedulerModule(home);
  assert.equal(typeof module.createAgentSchedulerExtension, "function", "AF exposes a dependency-injected scheduler factory");
  const record = pendingRecord(`sched-af-${name}`, cwd, targetSession);
  const untargeted = { ...pendingRecord(`sched-af-${name}-cwd`, cwd, targetSession), originSessionFile: undefined, targetSessionFile: undefined };
  writeStore(home, [record, untargeted]);
  const dependencies = configure({ cwd, currentSession, targetSession });
  const harness = createHarness(module.createAgentSchedulerExtension(dependencies), cwd, currentSession);
  try {
    const result = await harness.get(record.id);
    await assertions({ cwd, currentSession, targetSession, record, untargeted, result, store: readStore(home), sends: harness.sends });
  } finally {
    await harness.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await runScenario(
      "orphan",
      () => ({
        probeSessionFile: async () => "missing",
        observeSessionProcesses: async () => ({ certainty: "complete", observations: [] }),
      }),
      async ({ record, untargeted, result, store, sends }) => {
        const expired = store.schedules[record.id];
        assert.equal(expired.status, "failed");
        assert.match(expired.failureReason, /session fence expired on store read/i);
        assert.match(expired.failureReason, /target session file is missing/i);
        assert.match(expired.failureReason, /no live session in the origin cwd matches/i);
        assert.match(result.content[0].text, /\[failed\]/);
        assert.match(result.content[0].text, /session fence expired on store read/i, "the persisted reason is visible through get");
        assert.equal(store.schedules[untargeted.id].status, "pending", "cwd-only records are never treated as orphaned fences");
        assert.equal(sends.length, 0, "read-time reconciliation never invokes delivery");
      },
    );

    await runScenario(
      "live-match",
      ({ cwd, targetSession }) => ({
        probeSessionFile: async () => "missing",
        observeSessionProcesses: async () => ({
          certainty: "complete",
          observations: [{ cwd, sessionFile: targetSession, liveness: "live", pid: 101 }],
        }),
      }),
      async ({ record, store }) => {
        assert.equal(store.schedules[record.id].status, "pending", "a live exact target protects an unflushed session file");
        assert.equal(store.schedules[record.id].failureReason, undefined);
      },
    );

    await runScenario(
      "unknown-match",
      ({ cwd, targetSession }) => ({
        probeSessionFile: async () => "missing",
        observeSessionProcesses: async () => ({
          certainty: "complete",
          observations: [{ cwd, sessionFile: targetSession, liveness: "unknown", pid: 102 }],
        }),
      }),
      async ({ record, store }) => {
        assert.equal(store.schedules[record.id].status, "pending", "unknown target-process liveness is not proof of absence");
      },
    );

    await runScenario(
      "unknown-inventory",
      () => ({
        probeSessionFile: async () => "missing",
        observeSessionProcesses: async () => ({ certainty: "unknown", observations: [] }),
      }),
      async ({ record, store }) => {
        assert.equal(store.schedules[record.id].status, "pending", "an incomplete process inventory cannot expire a fence");
      },
    );

    await runScenario(
      "filesystem-unknown",
      () => ({
        probeSessionFile: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
        observeSessionProcesses: async () => ({ certainty: "complete", observations: [] }),
      }),
      async ({ record, store }) => {
        assert.equal(store.schedules[record.id].status, "pending", "filesystem errors other than conclusive absence fail closed");
      },
    );

    await runScenario(
      "present",
      () => ({
        probeSessionFile: async () => "present",
        observeSessionProcesses: async () => ({ certainty: "complete", observations: [] }),
      }),
      async ({ record, store }) => {
        assert.equal(store.schedules[record.id].status, "pending", "an existing target remains routable");
      },
    );

    await runScenario(
      "dead-match",
      ({ cwd, targetSession }) => ({
        probeSessionFile: async () => "missing",
        observeSessionProcesses: async () => ({
          certainty: "complete",
          observations: [{ cwd, sessionFile: targetSession, liveness: "dead", pid: 103 }],
        }),
      }),
      async ({ record, store }) => {
        assert.equal(store.schedules[record.id].status, "failed", "a conclusively dead observation does not keep an orphan alive");
      },
    );

    console.log("test-round7-defect-af: store reads expire only conclusively missing, process-unowned session fences and retain visible reasons");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
