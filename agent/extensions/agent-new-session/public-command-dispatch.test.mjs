import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const piPackageRoot = process.env.PI_CORE_ROOT ?? join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
  "npm", "node_modules", "@earendil-works", "pi-coding-agent",
);
const piRequire = createRequire(join(piPackageRoot, "package.json"));
const { createJiti } = piRequire("jiti");
const root = await mkdtemp(join(tmpdir(), "agent-new-session-public-dispatch-"));
const originalPiHome = process.env.PI_HOME;
process.env.PI_HOME = root;

try {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { typebox: piRequire.resolve("typebox") },
  });
  const agentNewSession = await jiti.import(join(here, "index.ts"), { default: true });
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const dispatches = [];
  let asyncError;

  const commandContext = {
    cwd: root,
    sessionManager: { getSessionFile: () => join(root, "old-session.jsonl") },
    async newSession(options = {}) {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({ reason: "new" });
      }
      if (options.withSession) {
        await options.withSession({
          sendUserMessage: async () => {},
          ui: { notify: () => {} },
        });
      }
      return { cancelled: false };
    },
  };

  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    sendUserMessage(text, options) {
      dispatches.push({ text, options });
      queueMicrotask(async () => {
        try {
          assert.equal(options?.expandPromptTemplates, true);
          const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
          assert.ok(match, "dispatch must be slash-command text");
          const command = commands.get(match[1]);
          assert.ok(command, `registered command missing: ${match[1]}`);
          await command.handler(match[2] ?? "", commandContext);
        } catch (error) {
          asyncError = error;
        }
      });
    },
  };

  // Deliberately omit pi.executeCommand: the public bridge must work in the
  // real 0.84.3+ bundled CLI where the private modular patch is absent.
  agentNewSession(pi);
  const tool = tools.get("agent_new_session");
  assert.ok(tool, "agent_new_session tool must register");

  const toolContext = {
    cwd: root,
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  const result = await tool.execute("tool-call", {}, undefined, undefined, toolContext);
  assert.equal(result.details.deferred, true);

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (asyncError) throw asyncError;

  assert.equal(dispatches.length, 1, "stable-idle poll must dispatch exactly once");
  assert.equal(dispatches[0].text, "/agent-new-session");
  assert.deepEqual(dispatches[0].options, { expandPromptTemplates: true });

  const diagnostics = JSON.parse(await readFile(
    join(root, "agent", "agent-new-session-diagnostics.json"),
    "utf8",
  ));
  assert.equal(diagnostics.phase, "done");
  assert.equal(diagnostics.newSessionConfirmed, true);
  assert.equal(diagnostics.confirmedBy, "session_shutdown:new");
  assert.equal(diagnostics.newSessionSilentlyFailed, false);
  assert.equal(diagnostics.executeCommandRejected, false);

  console.log(JSON.stringify({
    ok: true,
    privateExecuteCommandPresent: false,
    dispatchText: dispatches[0].text,
    expandPromptTemplates: dispatches[0].options.expandPromptTemplates,
    confirmedBy: diagnostics.confirmedBy,
  }));
} finally {
  if (originalPiHome === undefined) delete process.env.PI_HOME;
  else process.env.PI_HOME = originalPiHome;
  await rm(root, { recursive: true, force: true });
}
