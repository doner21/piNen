#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PI_NODE_MODULES = path.join(PROJECT_ROOT, "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const mission = jiti(path.join(PROJECT_ROOT, "src", "mission", "index.ts"));

const cwd = path.resolve(required("DMS_DIRECT_CWD"));
const sessionRoot = path.resolve(required("DMS_DIRECT_SESSIONS"));
const crashMarker = path.resolve(required("DMS_DIRECT_CRASH_MARKER"));
const cliPath = path.resolve(required("DMS_DIRECT_CLI"));
const route = {
  provider: process.env.DMS_LIVE_PROVIDER || "openai-codex",
  model: process.env.DMS_LIVE_MODEL || "gpt-5.5",
  thinkingLevel: "off",
};
const objective = required("DMS_DIRECT_OBJECTIVE");
const factory = new mission.PiRpcMissionWorkerFactory({ cliPath, sessionRoot, promptTimeoutMs: 120_000, heartbeatMs: 500 });

(async () => {
  const startedAt = performance.now();
  let worker;
  let deliberateCrash = false;
  try {
    worker = await factory.open({
      runId: "direct-crash-baseline",
      generation: 1,
      cwd,
      route,
      fallbacks: [],
      readOnly: false,
    });
    let settled = false;
    let promptTokens = 0;
    let toolEvents = 0;
    for await (const event of worker.prompt([
      objective,
      "Keep validate.cjs unchanged. Do not invoke an orchestration workflow.",
      "Work autonomously, run useful local checks, and return a concise summary when done.",
    ].join("\n\n"))) {
      if (event.type === "tool" && event.phase === "end") toolEvents += 1;
      if (event.type === "settled") {
        settled = true;
        promptTokens += event.tokens;
        break;
      }
    }
    if (!settled) throw new Error("direct baseline worker ended without settlement");
    const marker = {
      version: 1,
      controllerPid: process.pid,
      identity: {
        adapter: worker.identity.adapter,
        workerId: worker.identity.workerId,
        pid: worker.identity.pid,
        processStartedAt: worker.identity.processStartedAt,
        sessionId: worker.identity.sessionId,
        sessionFile: worker.identity.sessionFile,
        cursor: worker.identity.cursor,
        generation: worker.identity.generation,
        route: worker.identity.route,
      },
      modelPrompts: 1,
      promptTokens,
      toolCalls: toolEvents,
      wallTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
    const temporary = `${crashMarker}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, crashMarker);
    deliberateCrash = true;
    process.exit(92);
  } finally {
    if (worker && !deliberateCrash) {
      try { await worker.close(); }
      catch { await factory.terminate(worker.identity).catch(() => false); }
    }
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(93);
});

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
