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

const cwd = path.resolve(required("DMS_FIXTURE_CWD"));
const runsRoot = path.resolve(required("DMS_FIXTURE_RUNS"));
const sessionRoot = path.resolve(required("DMS_FIXTURE_SESSIONS"));
const crashMarker = path.resolve(required("DMS_FIXTURE_CRASH_MARKER"));
const cliPath = path.resolve(required("DMS_FIXTURE_CLI"));
const runId = required("DMS_FIXTURE_RUN_ID");
const route = {
  provider: process.env.DMS_LIVE_PROVIDER || "openai-codex",
  model: process.env.DMS_LIVE_MODEL || "gpt-5.5",
  thinkingLevel: "off",
};
const contract = {
  schemaVersion: 1,
  objective: "Create product.txt containing exactly fixed followed by one newline. Keep validate.cjs unchanged. Run any useful local check, then settle with a concise summary.",
  cwd,
  route,
  fallbacks: [],
  budgets: { wallClockMs: 5 * 60_000, maxTurns: 5, maxRestarts: 3, maxSpecialists: 0, maxTokens: 100_000 },
  validator: { kind: "node-workspace-validator", script: "validate.cjs", timeoutMs: 10_000, maxOutputBytes: 16_384 },
  constraints: ["Do not modify validate.cjs.", "Do not invoke another orchestration workflow."],
};
const factory = new mission.PiRpcMissionWorkerFactory({ cliPath, sessionRoot, promptTimeoutMs: 120_000, heartbeatMs: 500 });
let crashed = false;

mission.runDurableMission({
  contract,
  workerFactory: factory,
  runId,
  runsRoot,
  onEvent(event) {
    if (!crashed && event.type === "worker.settled") {
      crashed = true;
      fs.writeFileSync(crashMarker, `${JSON.stringify({ runId, pid: process.pid, seq: event.seq, at: event.at })}\n`);
      process.exit(91);
    }
  },
}).then((result) => {
  console.error(`unexpected terminal result before crash: ${JSON.stringify(result)}`);
  process.exit(92);
}).catch((error) => {
  console.error(error?.stack || error);
  process.exit(93);
});

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
