#!/usr/bin/env node
/** Round 6 Z: confirmed new sessions retarget predecessor fences and immediately resume due work. */
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function normalizedCwd(cwd) {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pendingRecord(id, cwd, oldSession, fields = {}) {
  const now = Date.now();
  return {
    id,
    message: `wake ${id}`,
    dueAt: now + 60_000,
    createdAt: now - 100,
    status: "pending",
    originCwdKey: normalizedCwd(cwd),
    originCwd: cwd,
    originSessionFile: oldSession,
    createdBy: "tool",
    updatedAt: now - 100,
    ...fields,
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

function writeOwnLease(home, cwd, sessionFile) {
  const leaseDir = path.join(home, "scheduler-sessions");
  fs.mkdirSync(leaseDir, { recursive: true });
  fs.writeFileSync(path.join(leaseDir, "fixture-own-lease.json"), JSON.stringify({
    version: 1,
    leaseId: "fixture-own-lease",
    pid: process.pid,
    cwd,
    sessionFile,
    updatedAt: Date.now(),
  }));
}

function createHarness({ extension, cwd, sessionFile }) {
  const listeners = new Map();
  const tools = new Map();
  const notifications = [];
  const entries = [];
  const sends = [];
  let idle = true;

  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => idle,
    hasPendingMessages: () => !idle,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getEntries: () => entries,
      getBranch: () => entries,
    },
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
    },
  };

  async function emit(name, event = {}) {
    for (const handler of listeners.get(name) || []) await handler(event, ctx);
  }

  const pi = {
    on(name, handler) {
      const handlers = listeners.get(name) || [];
      handlers.push(handler);
      listeners.set(name, handlers);
    },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    sendUserMessage(message, options) {
      sends.push({ message, options });
      const timestamp = Date.now();
      entries.push({
        type: "message",
        id: `wake-${entries.length + 1}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date(timestamp).toISOString(),
        message: { role: "user", content: [{ type: "text", text: message }], timestamp },
      });
      setTimeout(() => { void emit("context", { messages: [entries.at(-1).message] }); }, 0);
    },
  };

  extension(pi);
  return {
    ctx,
    emit,
    notifications,
    sends,
    tools,
    setIdle(value) { idle = value; },
    async close() { await emit("session_shutdown", { reason: "quit" }); },
  };
}

function loadExtension(home) {
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
  return jiti(path.join(ROOT, "..", "agent", "extensions", "agent-scheduler", "index.ts")).default;
}

async function runScenario(name, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `round6-defect-z-${name}-`));
  const cwd = path.join(home, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = home;
  const extension = loadExtension(home);
  try {
    await body({ home, cwd, extension });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await runScenario("retarget", async ({ home, cwd, extension }) => {
      const oldSession = path.join(home, "sessions", "missing-old.jsonl");
      const newSession = path.join(home, "sessions", "new.jsonl");
      const unrelatedSession = path.join(home, "sessions", "unrelated.jsonl");
      fs.mkdirSync(path.dirname(newSession), { recursive: true });
      fs.writeFileSync(unrelatedSession, "still present\n");
      assert.equal(fs.existsSync(oldSession), false, "the predecessor fence is genuinely missing");

      const originFenced = pendingRecord("sched-z-origin", cwd, oldSession);
      const explicitlyFenced = pendingRecord("sched-z-explicit", cwd, oldSession, { targetSessionFile: oldSession });
      const unrelated = pendingRecord("sched-z-unrelated", cwd, oldSession, { targetSessionFile: unrelatedSession });
      const terminal = { ...pendingRecord("sched-z-terminal", cwd, oldSession), status: "delivered", deliveredAt: Date.now() - 50 };
      writeStore(home, [originFenced, explicitlyFenced, unrelated, terminal]);

      const harness = createHarness({ extension, cwd, sessionFile: newSession });
      try {
        await harness.emit("session_start", { reason: "new", previousSessionFile: oldSession });
        await waitFor(() => {
          const schedules = readStore(home).schedules;
          return schedules[originFenced.id].targetSessionFile === newSession
            && schedules[explicitlyFenced.id].targetSessionFile === newSession;
        }, "missing predecessor fences to move to the confirmed new session");

        const schedules = readStore(home).schedules;
        assert.equal(schedules[originFenced.id].originSessionFile, oldSession, "origin traceability is preserved");
        assert.equal(schedules[explicitlyFenced.id].originSessionFile, oldSession, "explicit-target origin is preserved");
        assert.equal(schedules[unrelated.id].targetSessionFile, unrelatedSession, "another session's fence is not stolen");
        assert.equal(schedules[terminal.id].targetSessionFile, undefined, "terminal history is immutable");
        assert.ok(schedules[originFenced.id].updatedAt > originFenced.updatedAt);
        assert.ok(schedules[explicitlyFenced.id].updatedAt > explicitlyFenced.updatedAt);
        assert.ok(harness.notifications.some(({ message, type }) =>
          type === "info" && /Retargeted 2 pending schedule\(s\)/.test(message)
            && message.includes(oldSession) && message.includes(newSession)),
        JSON.stringify(harness.notifications));

        const list = await harness.tools.get("agent_scheduler").execute(
          "z-list", { action: "list" }, undefined, undefined, harness.ctx,
        );
        assert.match(list.content[0].text, /#sched-z-origin/);
        assert.match(list.content[0].text, /#sched-z-explicit/);
        assert.doesNotMatch(list.content[0].text, /#sched-z-unrelated/);
      } finally {
        await harness.close();
      }
    });

    await runScenario("expire", async ({ home, cwd, extension }) => {
      const oldSession = path.join(home, "sessions", "missing-old.jsonl");
      const staleAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const record = pendingRecord("sched-z-expire", cwd, oldSession, {
        createdAt: staleAt,
        updatedAt: staleAt,
      });
      writeStore(home, [record]);
      const harness = createHarness({ extension, cwd, sessionFile: undefined });
      try {
        await harness.emit("session_start", { reason: "new", previousSessionFile: oldSession });
        await waitFor(() => readStore(home).schedules[record.id]?.status === "failed", "unroutable missing-session fence expiry");
        const expired = readStore(home).schedules[record.id];
        assert.match(expired.failureReason, /session fence expired/i);
        assert.match(expired.failureReason, /neither the session context nor this process's lease/i);
        assert.ok(expired.failureReason.includes(oldSession));
        assert.ok(harness.notifications.some(({ message, type }) =>
          type === "warning" && message.includes(record.id) && /session fence expired/i.test(message)),
        JSON.stringify(harness.notifications));

        const get = await harness.tools.get("agent_scheduler").execute(
          "z-get", { action: "get", id: record.id }, undefined, undefined, harness.ctx,
        );
        assert.match(get.content[0].text, /\[failed\]/);
        assert.match(get.content[0].text, /session fence expired/i, "the durable failure reason is visible through the tool");
      } finally {
        await harness.close();
      }
    });

    await runScenario("existing-predecessor", async ({ home, cwd, extension }) => {
      const oldSession = path.join(home, "sessions", "existing-old.jsonl");
      const newSession = path.join(home, "sessions", "new.jsonl");
      const unrelatedSession = path.join(home, "sessions", "unrelated.jsonl");
      fs.mkdirSync(path.dirname(oldSession), { recursive: true });
      fs.writeFileSync(oldSession, "still exists\n");
      fs.writeFileSync(unrelatedSession, "still unrelated\n");
      const record = pendingRecord("sched-z-existing", cwd, oldSession, { dueAt: Date.now() - 1_000 });
      const unrelated = pendingRecord("sched-z-existing-unrelated", cwd, oldSession, {
        dueAt: Date.now() - 1_000,
        targetSessionFile: unrelatedSession,
      });
      writeStore(home, [record, unrelated]);
      const harness = createHarness({ extension, cwd, sessionFile: newSession });
      try {
        await harness.emit("session_start", { reason: "new", previousSessionFile: oldSession });
        await waitFor(
          () => harness.sends.some(({ message }) => message.includes(`#${record.id}`)),
          "due continuation with an existing predecessor to deliver without user input",
        );
        await waitFor(
          () => readStore(home).schedules[record.id]?.status === "delivered",
          "existing-predecessor delivery finalization",
        );
        const schedules = readStore(home).schedules;
        assert.equal(fs.existsSync(oldSession), true, "retargeting does not depend on deleting the predecessor JSONL");
        assert.equal(schedules[record.id].targetSessionFile, newSession);
        assert.equal(schedules[unrelated.id].targetSessionFile, unrelatedSession, "another session's effective fence is untouched");
        assert.equal(schedules[unrelated.id].status, "pending");
        assert.equal(harness.sends.length, 1, "only the retargeted continuation is delivered");
        assert.ok(harness.notifications.some(({ message, type }) =>
          type === "info" && /Retargeted 1 pending schedule\(s\)/.test(message)
            && message.includes(oldSession) && message.includes(newSession)),
        JSON.stringify(harness.notifications));
      } finally {
        await harness.close();
      }
    });

    await runScenario("fork", async ({ home, cwd, extension }) => {
      const oldSession = path.join(home, "sessions", "fork-old.jsonl");
      const forkSession = path.join(home, "sessions", "fork-new.jsonl");
      fs.mkdirSync(path.dirname(oldSession), { recursive: true });
      fs.writeFileSync(oldSession, "fork source still exists\n");
      const record = pendingRecord("sched-z-fork", cwd, oldSession, { dueAt: Date.now() - 1_000 });
      const cwdOnly = pendingRecord("sched-z-fork-cwd", cwd, oldSession, {
        dueAt: Date.now() - 1_000,
        originSessionFile: undefined,
      });
      writeStore(home, [record, cwdOnly]);
      const harness = createHarness({ extension, cwd, sessionFile: forkSession });
      try {
        await harness.emit("session_start", { reason: "fork", previousSessionFile: oldSession });
        await sleep(400);
        const unchanged = readStore(home).schedules[record.id];
        assert.equal(unchanged.targetSessionFile, undefined, "fork does not adopt predecessor fences");
        assert.equal(unchanged.status, "pending", "fork does not mutate the predecessor-fenced record");
        assert.equal(
          readStore(home).schedules[cwdOnly.id].status,
          "pending",
          "fork suppresses even a due cwd-only record that otherwise matches this session",
        );
        assert.equal(harness.sends.length, 0);
      } finally {
        await harness.close();
      }
    });

    await runScenario("own-lease-fallback", async ({ home, cwd, extension }) => {
      const oldSession = path.join(home, "sessions", "lease-old.jsonl");
      const leasedSession = path.join(home, "sessions", "lease-new.jsonl");
      fs.mkdirSync(path.dirname(oldSession), { recursive: true });
      fs.writeFileSync(oldSession, "old session still exists\n");
      writeOwnLease(home, cwd, leasedSession);
      const record = pendingRecord("sched-z-own-lease", cwd, oldSession);
      writeStore(home, [record]);
      const harness = createHarness({ extension, cwd, sessionFile: undefined });
      try {
        await harness.emit("session_start", { reason: "new", previousSessionFile: oldSession });
        await waitFor(
          () => readStore(home).schedules[record.id]?.targetSessionFile === leasedSession,
          "context-less new session to use this process's lease",
        );
        const retargeted = readStore(home).schedules[record.id];
        assert.equal(retargeted.status, "pending");
        assert.equal(retargeted.failureReason, undefined);
        assert.ok(harness.notifications.some(({ message, type }) =>
          type === "info" && message.includes(oldSession) && message.includes(leasedSession)),
        JSON.stringify(harness.notifications));
      } finally {
        await harness.close();
      }
    });

    await runScenario("replacement-unavailable", async ({ home, cwd, extension }) => {
      const oldSession = path.join(home, "sessions", "unavailable-old.jsonl");
      fs.mkdirSync(path.dirname(oldSession), { recursive: true });
      fs.writeFileSync(oldSession, "old session still exists\n");
      const record = pendingRecord("sched-z-no-replacement", cwd, oldSession);
      writeStore(home, [record]);
      const harness = createHarness({ extension, cwd, sessionFile: undefined });
      try {
        await harness.emit("session_start", { reason: "new", previousSessionFile: oldSession });
        await waitFor(
          () => readStore(home).schedules[record.id]?.status === "failed",
          "confirmed new session without either replacement source to fail visibly",
        );
        const failed = readStore(home).schedules[record.id];
        assert.match(failed.failureReason, /session fence expired/i);
        assert.match(failed.failureReason, /neither .* durable replacement session file/i);
        assert.ok(harness.notifications.some(({ message, type }) =>
          type === "warning" && message.includes(record.id) && /session fence expired/i.test(message)),
        JSON.stringify(harness.notifications));
      } finally {
        await harness.close();
      }
    });

    console.log("test-round6-defect-z: new sessions retarget existing or missing predecessor fences, drain due work, preserve fork suppression, and use own-lease fallback");
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
