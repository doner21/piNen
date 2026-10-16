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

const [mode, targetRoot, workspace, runId, barrier, resultFile] = process.argv.slice(2);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

(async () => {
  fs.writeFileSync(`${resultFile}.ready`, String(process.pid));
  while (!fs.existsSync(barrier)) await sleep(5);
  let handle;
  try {
    if (mode === "lease") {
      const canonicalWorkspace = fs.realpathSync(workspace);
      handle = mission.FileWorkspaceLease.acquire({
        leaseRoot: targetRoot,
        workspacePath: canonicalWorkspace,
        workspaceFingerprint: mission.computeWorkspaceFingerprint(canonicalWorkspace),
        runId,
        missionHash: "c".repeat(64),
      });
    } else if (mode === "journal") {
      handle = mission.FileMissionJournal.open(targetRoot, runId);
    } else {
      throw new Error(`unknown contender mode ${mode}`);
    }
    fs.writeFileSync(resultFile, JSON.stringify({ result: "acquired", pid: process.pid }));
    await sleep(2_000);
    if (mode === "lease") handle.release();
    else handle.close();
  } catch (error) {
    fs.writeFileSync(resultFile, JSON.stringify({ result: "blocked", code: error.code, message: error.message }));
  }
})().catch((error) => {
  fs.writeFileSync(resultFile, JSON.stringify({ result: "error", message: String(error?.stack || error) }));
  process.exitCode = 1;
});
