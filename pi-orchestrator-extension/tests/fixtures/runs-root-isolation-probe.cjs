#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const ownerRoot = path.resolve(process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER || "");
const legacyRoot = path.resolve(process.env.PI_ORCHESTRATOR_RUNS_ROOT || "");
const nextRoot = path.resolve(process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT || "");
assert.ok(ownerRoot.startsWith(path.resolve(os.tmpdir()) + path.sep), "runner must declare an OS-temp owner root");
assert.ok(legacyRoot.startsWith(ownerRoot + path.sep), "legacy runs root must belong to the runner");
assert.ok(nextRoot.startsWith(ownerRoot + path.sep), "next runs root must belong to the runner");

const sharedRoots = String(process.env.ROUND3_L_FORBIDDEN_ROOTS || "")
  .split(path.delimiter)
  .filter(Boolean)
  .map((value) => path.resolve(value).toLowerCase());
const touchedShared = [];
function guard(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof URL)) return;
  const resolved = path.resolve(value instanceof URL ? require("node:url").fileURLToPath(value) : String(value)).toLowerCase();
  if (sharedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    touchedShared.push(resolved);
    throw new Error(`probe refused shared runs-state access: ${resolved}`);
  }
}
for (const [object, names] of [
  [fs, ["existsSync", "readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync", "openSync", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync"]],
  [fs.promises, ["access", "readFile", "readdir", "stat", "lstat", "realpath", "open", "writeFile", "appendFile", "mkdir", "rm", "unlink", "rename"]],
]) {
  for (const name of names) {
    const original = object[name];
    object[name] = function (...args) {
      guard(args[0]);
      if (name === "renameSync" || name === "rename") guard(args[1]);
      return original.apply(this, args);
    };
  }
}

const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const jiti = require(path.join(piModules, "jiti", "lib", "jiti.cjs"))(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const runState = jiti(path.join(ROOT, "src", "run-state.ts"));
const extension = jiti(path.join(ROOT, "src", "index.ts")).default;

const incompleteDir = path.join(legacyRoot, "orc-incomplete-plan-a");
fs.mkdirSync(incompleteDir, { recursive: true });
fs.writeFileSync(path.join(incompleteDir, "phase-0-planA.json"), "{}\n");
fs.writeFileSync(path.join(incompleteDir, "state.json"), "test-only legacy state without supervision\n");
const incompleteBefore = fs.readdirSync(incompleteDir).map((name) => [name, fs.readFileSync(path.join(incompleteDir, name), "base64")]);
assert.deepEqual(runState.listKnownRuns(), ["orc-incomplete-plan-a"], "legacy state listing remains available");
extension({ registerTool() {}, registerCommand() {} });
const incompleteAfter = fs.readdirSync(incompleteDir).map((name) => [name, fs.readFileSync(path.join(incompleteDir, name), "base64")]);
assert.deepEqual(incompleteAfter, incompleteBefore, "startup supervisor ignores a run dir without supervision.json");
assert.deepEqual(touchedShared, [], "extension registration must not inspect supplied shared roots");

const store = runState.RunStateStore.create("orc-l-probe", "plan-execute-verify", "L probe", { cwd: ownerRoot }, ["plan"]);
assert.ok(store.runDir.startsWith(legacyRoot + path.sep));
assert.equal(fs.existsSync(path.join(store.runDir, "state.json")), true);
console.log(`ISOLATION_PROBE ${JSON.stringify({ ownerRoot, legacyRoot, nextRoot })}`);
