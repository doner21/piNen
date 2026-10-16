#!/usr/bin/env node
/** Run one or more package tests with fresh per-file state roots, inherited by every child process. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TESTS_ROOT = path.join(ROOT, "tests");
const requested = process.argv.slice(2);
if (requested.length === 0) {
  console.error("Usage: node tests/run-isolated.cjs tests/<file>.cjs [...]");
  process.exit(2);
}

let activeChild;
let activeRoot;
let interruptedSignal;

function removeOwnedRoot() {
  if (!activeRoot) return;
  const owned = activeRoot;
  activeRoot = undefined;
  try {
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  } catch (error) {
    console.error(`TEST_ISOLATION_CLEANUP_FAILED ${owned}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedSignal) return;
    interruptedSignal = signal;
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      try { activeChild.kill(signal); } catch {}
    }
  });
}
process.once("exit", removeOwnedRoot);

function resolveTest(argument) {
  const file = path.resolve(ROOT, argument);
  const relative = path.relative(TESTS_ROOT, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(file).toLowerCase() !== ".cjs") {
    throw new Error(`Refusing non-test entrypoint: ${argument}`);
  }
  if (!fs.statSync(file).isFile()) throw new Error(`Test entrypoint is not a file: ${argument}`);
  return file;
}

function runFile(file) {
  activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pi-orchestrator-test-${process.pid}-`));
  const env = {
    ...process.env,
    PI_ORCHESTRATOR_TEST_RUNS_OWNER: activeRoot,
    PI_ORCHESTRATOR_RUNS_ROOT: path.join(activeRoot, "legacy"),
    PI_ORCHESTRATOR_NEXT_RUNS_ROOT: path.join(activeRoot, "next"),
  };
  return new Promise((resolve, reject) => {
    activeChild = spawn(process.execPath, [file], {
      cwd: ROOT,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    activeChild.once("error", reject);
    activeChild.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    activeChild = undefined;
    removeOwnedRoot();
  });
}

(async () => {
  for (const argument of requested) {
    const file = resolveTest(argument);
    const result = await runFile(file);
    if (interruptedSignal) {
      process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
      return;
    }
    if (result.code !== 0) {
      console.error(`TEST_FILE_FAILED ${path.relative(ROOT, file)} exit=${result.code ?? "null"} signal=${result.signal ?? "none"}`);
      process.exitCode = typeof result.code === "number" && result.code > 0 ? result.code : 1;
      return;
    }
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
