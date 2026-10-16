#!/usr/bin/env node
/** Round 7 scheduler store: atomic replacement tolerates bounded transient Windows contention. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const schedulerSource = path.join(ROOT, "..", "agent", "extensions", "agent-scheduler", "index.ts");
const previous = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  NODE_PATH: process.env.NODE_PATH,
};
const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

function baselineStore() {
  const now = Date.now();
  return {
    version: 1,
    schedules: {
      "sched-existing": {
        id: "sched-existing",
        message: "preserve existing destination",
        dueAt: now + 120_000,
        createdAt: now,
        status: "pending",
        originCwdKey: "fixture-cwd",
        originCwd: "fixture-cwd",
        createdBy: "tool",
        updatedAt: now,
      },
    },
    nextSeq: 2,
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
  return jiti(schedulerSource).default;
}

function createHarness(extension, cwd, sessionFile) {
  const listeners = new Map();
  const tools = new Map();
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
    sendUserMessage() { throw new Error("store tests never deliver wake-ups"); },
  };
  extension(pi);
  return {
    ctx,
    async schedule(message) {
      return tools.get("agent_scheduler").execute(
        `round7-store-${message}`,
        { action: "schedule", message, delaySeconds: 60 },
        undefined,
        undefined,
        ctx,
      );
    },
    async close() {
      for (const handler of listeners.get("session_shutdown") || []) {
        await handler({ reason: "quit" }, ctx);
      }
    },
  };
}

function temporaryStoreFiles(home) {
  return fs.readdirSync(home).filter((name) => /^scheduler\.json\..+\.tmp$/.test(name));
}

function injectedRenameError(code, message) {
  return Object.assign(new Error(message), { code, syscall: "rename" });
}

async function runScenario(name, injectRename, verify) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `round7-scheduler-store-${name}-`));
  const cwd = path.join(home, "workspace");
  const sessionFile = path.join(home, "sessions", "current.jsonl");
  const storePath = path.join(home, "scheduler.json");
  const initialStore = baselineStore();
  const initialBytes = `${JSON.stringify(initialStore, null, 2)}\n`;
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(storePath, initialBytes);
  process.env.PI_CODING_AGENT_DIR = home;

  const extension = loadExtension(home);
  const harness = createHarness(extension, cwd, sessionFile);
  const originalRename = fs.promises.rename;
  const calls = [];
  fs.promises.rename = async (from, to) => {
    const atomicStoreRename = path.resolve(to) === path.resolve(storePath)
      && /^scheduler\.json\..+\.tmp$/.test(path.basename(from));
    if (!atomicStoreRename) return originalRename.call(fs.promises, from, to);
    calls.push({ from: path.resolve(from), to: path.resolve(to) });
    return injectRename({ attempt: calls.length, from, to, originalRename });
  };

  try {
    await verify({
      calls,
      harness,
      home,
      initialBytes,
      readDestination: () => fs.readFileSync(storePath, "utf8"),
      storePath,
    });
  } finally {
    fs.promises.rename = originalRename;
    await harness.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
  }
}

(async () => {
  try {
    await runScenario(
      "transient-eperm",
      ({ attempt, from, to, originalRename }) => {
        if (attempt <= 2) throw injectedRenameError("EPERM", `injected transient EPERM ${attempt}`);
        return originalRename.call(fs.promises, from, to);
      },
      async ({ calls, harness, home, readDestination }) => {
        const result = await harness.schedule("transient EPERM survives");
        assert.match(result.content[0].text, /Scheduled #/);
        assert.equal(calls.length, 3, "two transient EPERM failures are retried at the production rename seam");
        const stored = JSON.parse(readDestination());
        assert.equal(stored.schedules["sched-existing"].message, "preserve existing destination");
        assert.ok(Object.values(stored.schedules).some((record) => record.message === "transient EPERM survives"));
        assert.deepEqual(temporaryStoreFiles(home), [], "successful replacement leaves no temp files");
        assert.equal(fs.existsSync(path.join(home, "scheduler.lock")), false, "successful replacement releases its lock");
      },
    );

    await runScenario(
      "bounded-exhaustion",
      () => { throw injectedRenameError("EPERM", "injected persistent EPERM"); },
      async ({ calls, harness, home, initialBytes, readDestination }) => {
        const persistent = await assert.rejects(
          harness.schedule("persistent EPERM rejects"),
          (error) => error?.code === "EPERM" && /persistent/.test(error.message),
        );
        assert.equal(persistent, undefined);
        assert.equal(calls.length, 6, "persistent transient contention exhausts exactly five bounded retries");
        assert.equal(readDestination(), initialBytes, "failed atomic replacement never removes or overwrites the destination");
        assert.deepEqual(temporaryStoreFiles(home), [], "exhausted replacement cleans its private temp file");
        assert.equal(fs.existsSync(path.join(home, "scheduler.lock")), false, "exhaustion releases its lock");
      },
    );

    await runScenario(
      "non-retryable",
      () => { throw injectedRenameError("EINVAL", "injected non-retryable rename failure"); },
      async ({ calls, harness, home, initialBytes, readDestination }) => {
        await assert.rejects(
          harness.schedule("EINVAL rejects immediately"),
          (error) => error?.code === "EINVAL" && /non-retryable/.test(error.message),
        );
        assert.equal(calls.length, 1, "non-retryable rename errors propagate without retry");
        assert.equal(readDestination(), initialBytes, "non-retryable failure preserves the atomic destination bytes");
        assert.deepEqual(temporaryStoreFiles(home), [], "non-retryable failure cleans its private temp file");
        assert.equal(fs.existsSync(path.join(home, "scheduler.lock")), false, "non-retryable failure releases its lock");
      },
    );

    console.log("test-round7-scheduler-store: transient EPERM retries are bounded; failures preserve destination atomicity and clean temporary state");
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
