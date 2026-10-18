import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A deferred new-session request must survive an owner message or scheduler
// wake that keeps Pi busy for longer than the old 30-second window, then
// switch once Pi is idle and deliver the kickoff into the new session.
// Incident: 13 Oct 2026, two coordinator refreshes failed this way.

const here = dirname(fileURLToPath(import.meta.url));
const piPackageRoot = process.env.PI_CORE_ROOT ?? join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
  "npm", "node_modules", "@earendil-works", "pi-coding-agent",
);
const piRequire = createRequire(join(piPackageRoot, "package.json"));
const { createJiti } = piRequire("jiti");
const root = await mkdtemp(join(tmpdir(), "agent-new-session-busy-turn-"));
const originalPiHome = process.env.PI_HOME;
const realNow = Date.now;
process.env.PI_HOME = root;

try {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { typebox: piRequire.resolve("typebox") },
  });
  const modulePath = process.env.AGENT_NEW_SESSION_MODULE ?? join(here, "index.ts");
  const agentNewSession = await jiti.import(modulePath, { default: true });
  const handlers = new Map(), commands = new Map(), tools = new Map();
  const dispatches = [], kickoffs = [];
  let asyncError;

  const commandContext = {
    cwd: root,
    sessionManager: { getSessionFile: () => join(root, "old-session.jsonl") },
    async newSession(options = {}) {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "new" });
      if (options.withSession) {
        await options.withSession({ sendUserMessage: async (text) => { kickoffs.push(text); }, ui: { notify: () => {} } });
      }
      return { cancelled: false };
    },
  };
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    sendUserMessage(text, options) {
      dispatches.push({ text, options });
      queueMicrotask(async () => {
        try {
          const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
          await commands.get(match[1]).handler(match[2] ?? "", commandContext);
        } catch (error) { asyncError = error; }
      });
    },
  };
  agentNewSession(pi);
  const tool = tools.get("agent_new_session");

  // An owner message arrives straight after the request: Pi stays busy.
  let busy = true;
  const toolContext = { cwd: root, isIdle: () => !busy, hasPendingMessages: () => false };
  const kickoff = "RESUME AFTER NEW SESSION: continue the builder port";
  const result = await tool.execute("tool-call", { kickoff }, undefined, undefined, toolContext);
  assert.equal(result.details.deferred, true);

  // Simulate the busy turn lasting well past 30 seconds of wall time.
  let offset = 0;
  Date.now = () => realNow() + offset;
  await new Promise((resolve) => setTimeout(resolve, 700));
  offset = 45_000;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  offset = 120_000;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(dispatches.length, 0, "must not switch while Pi is busy");

  const waiting = JSON.parse(await readFile(join(root, "agent", "agent-new-session-diagnostics.json"), "utf8"));
  assert.notEqual(waiting.phase, "failed", "a long busy turn must not fail the request");

  // The owner turn ends; Pi becomes idle.
  busy = false;
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  if (asyncError) throw asyncError;

  assert.equal(dispatches.length, 1, "switch must happen once Pi is idle");
  assert.deepEqual(dispatches[0].options, { expandPromptTemplates: true });
  assert.deepEqual(kickoffs, [kickoff], "kickoff must reach the new session");
  const done = JSON.parse(await readFile(join(root, "agent", "agent-new-session-diagnostics.json"), "utf8"));
  assert.equal(done.phase, "done");
  assert.equal(done.newSessionConfirmed, true);
  assert.equal(done.confirmedBy, "session_shutdown:new");
  console.log(JSON.stringify({ ok: true, waitedPastOldWindowMs: 120_000, kickoffDelivered: true }));
} finally {
  Date.now = realNow;
  if (originalPiHome === undefined) delete process.env.PI_HOME;
  else process.env.PI_HOME = originalPiHome;
  await rm(root, { recursive: true, force: true });
}
