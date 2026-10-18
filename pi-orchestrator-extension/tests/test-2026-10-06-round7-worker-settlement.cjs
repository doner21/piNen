#!/usr/bin/env node
"use strict";
/** Admission regression: execute the COMPLETE production launch functions, with
 * dependency injection at I/O boundaries. No subprocess or scheduler is used.
 * Private legacy functions are selected by the TS AST, not reimplemented.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const ROOT = path.resolve(__dirname, "..");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "orch-r7-settlement-"));
for (const [key, dir] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_ORCHESTRATOR_RUNS_ROOT: "runs", PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next" })) {
  process.env[key] = path.join(SCRATCH, dir);
  fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = SCRATCH;
process.env.PI_OFFLINE = "1";
const ts = require(path.join(ROOT, "node_modules/typescript"));
const substrate = require(path.join(ROOT, 'node_modules/jiti'))(__filename, { interopDefault: true, fsCache: false })(path.join(ROOT, 'src/substrate.ts'));
// A pending mock readiness promise has no native handle. Never let early event
// loop exhaustion accidentally report success before every case ran.
process.exitCode = 1;
const timingFile = path.join(ROOT, "src/command-times.ts");
const timingModule = { exports: {} }, actionModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ROOT, "src/action-evidence.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, { module: actionModule, exports: actionModule.exports, require: id => id.startsWith(".") ? require(path.join(ROOT, "src", id)) : require(id), Date, Buffer, TextDecoder });
vm.runInNewContext(ts.transpileModule(fs.readFileSync(timingFile, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, { module: timingModule, exports: timingModule.exports, require: id => id === "./action-evidence" ? actionModule.exports : require(id), Date, performance });
const NOW = Date.parse("2026-10-06T12:00:00Z");
let observedNow = NOW;
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [observedNow])); } static now() { return observedNow; } }
function declarations(relative, names) {
  const file = path.join(ROOT, relative);
  const text = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(item => item.name?.text === name);
    assert.ok(node, `production declaration ${relative}:${name} exists on baseline`);
    return node.getText(ast).replace(/^export\s+/, "");
  }).join("\n");
}
function compile(relative, name, dependencies) {
  if (fs.readFileSync(path.join(ROOT, relative), 'utf8').includes(`function ${name}Attempt(`)) name += 'Attempt';
  const source = declarations("src/substrate.ts", ["SubagentPhaseResultRecorder", "isValidBoundPhaseResult"])
    + "\n" + declarations(relative, [name, "buildSubagentSystemPrompt", "describeJsonEvent", "extractMessageText"]);
  const wrapper = dependencies.withInfrastructureRetry ? declarations('src/substrate.ts', ['retryInfrastructureSubagent']) + '\n' + declarations(relative, [name.replace(/Attempt$/, '')]) : '';
  const js = ts.transpileModule(source + wrapper + `\nglobalThis.launch = ${dependencies.withInfrastructureRetry ? name.replace(/Attempt$/, '') : name}; globalThis.Recorder = SubagentPhaseResultRecorder;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ Date: Clock, path, os, process, console, Buffer, structuredClone,
    createHash: crypto.createHash, randomBytes: crypto.randomBytes,
    existsSync: fs.existsSync, readFileSync: fs.readFileSync,
    atomicWriteJsonSync(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); },
    ...require(path.join(ROOT, 'src/streaming-redactor.cjs')),
    sanitizeSubagentResult: substrate.sanitizeSubagentResult,
    isProvablyReadOnlySubagent: substrate.isProvablyReadOnlySubagent,
    isNoToolInfrastructureFailure: substrate.isNoToolInfrastructureFailure,
    isInfrastructureFailure: substrate.isInfrastructureFailure,
    SubagentInfrastructureError: substrate.SubagentInfrastructureError,
    ProcessGenerationTracker: class { sample() {} rootClosed() {} current() { return undefined; } },
    ...timingModule.exports, ...dependencies });
  vm.runInContext(js, context, { filename: relative });
  return context;
}
const failures = [];
async function check(id, body) {
  try { await body(); console.log(`PASS ${id}`); }
  catch (error) { failures.push({ id, error: error.name }); console.log(`RED ${id}: ${error.name}`); }
}
async function exercise(relative, name, fault) {
  observedNow = NOW;
  const dir = path.join(SCRATCH, `${name}-${fault}`);
  fs.mkdirSync(dir, { recursive: true });
  const promptDir = path.join(dir, "prompt-tmp");
  fs.mkdirSync(promptDir);
  const sidecar = path.join(dir, "phase-0-reviewer.result.json");
  fs.writeFileSync(sidecar, JSON.stringify({ status: "running", launchId: "older-attempt", taskSha256: "obsolete-task" }));
  const publications = [];
  const reason = new Error(`ROUND7_${fault.toUpperCase()}_REFUSED`);
  let spawned = 0, readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const child = new EventEmitter();
  child.pid = 44002;
  child.stdout = fault === "survivor" ? undefined : new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { throw new Error("test must not signal a process"); };
  const reader = new EventEmitter();
  reader.close = () => {};
  const inertHandle = { unref() {} };
  const dependencies = {
    atomicWriteJsonSync(file, value) { publications.push(structuredClone(value)); fs.writeFileSync(file, JSON.stringify(value)); },
    allocatePhaseEvidence: () => ({ logFile: path.join(dir, "phase-0-reviewer.log"), resultFile: sidecar }),
    appendSubagentPhaseLog(file, stream, text) { if (file) fs.appendFileSync(file, `[${stream}] ${text}\n`); },
    rejectLocalModelIfNeeded() {}, formatRoutedModel: () => "owner-route",
    workerExecutionConstraintContext: { getStore: () => undefined }, subagentPhaseLogContext: { getStore: () => ({ runId: "fixture" }) },
    async resolveCompleteWorkerLaunchPrompt() { if (fault === "prompt") throw reason; return { provider: "owner-provider", model: "owner-model", modelArgument: "owner-model", systemPrompt: "fixture", toolSchemas: [], contextWindow: 10000, maxOutputTokens: 1000 }; },
    assertWorkerPromptFitsCapacity() { if (fault === "capacity") throw reason; },
    async mkTempDir() { if (fault === "preparation") throw reason; return promptDir; },
    materializeFrozenTestAuthorizationPolicy() { if (fault === "policy") throw reason; return { file: path.join(dir, "policy.json"), sha256: "a".repeat(64) }; },
    safeFileName: value => value,
    async writeFile(...args) { if (fault === "write") throw reason; return fs.promises.writeFile(...args); },
    async rm(...args) { if (fault === "cleanup") throw new Error("SECONDARY_CLEANUP_FAILURE"); return fs.promises.rm(...args); },
    resolvePiCommand() { if (fault === "command") throw reason; return { command: "injected-only", argsPrefix: [], env: {} }; },
    WORKER_MONITOR_BOOTSTRAP_EXTENSION: "fixture-bootstrap", WORKER_NO_OUTPUT_MONITOR_EXTENSION: "fixture-monitor", WORKER_EXECUTION_CONSTRAINTS_EXTENSION: "fixture-guard",
    buildWindowsEpermSpawnAttempts(command, args, options) { if (fault === "attempts") throw reason; return fault === "empty" ? [] : [{ command, args, options }]; },
    emptyToolCallSummary: () => ({ total: 0, mutating: 0, byName: {} }),
    ActionEvidenceCollector: class { constructor() { if (fault === "collector" || fault === "cleanup") throw reason; } observe() {} finalize() { return { entries: [] }; } },
    spawn() { if (fault === "spawn") throw reason; observedNow += 1001; spawned++; readyResolve(); return child; },
    buildWindowsEpermEvidence: () => ({}), writeWindowsEpermEvidence: async () => undefined,
    formatSpawnFailure: error => error.message,
    // Inert dependency handles for pre-existing production scheduling calls:
    // callbacks never run; only injected observations advance the clock.
    setTimeout: () => inertHandle, setInterval: () => inertHandle, clearTimeout() {}, clearInterval() {},
    getPiChildFirstJsonTimeoutMs: () => 0,
    createInterface: () => reader, isPiJsonProtocolEvent: () => true,
    acknowledgeNoOutputAlarm() {}, recordToolCall() {},
    optionalString: value => typeof value === "string" ? value : undefined,
    NO_OUTPUT_MONITOR_READY_MARKER: "FIXTURE_MONITOR_READY", NO_FORCE_KILL_GUARD_READY_MARKER: "FIXTURE_GUARD_READY",
    classifyProviderRefusal: () => undefined,
    SubagentDetachedError: class extends Error {}, SubagentTerminalAmbiguousError: class extends Error {},
    isWindowsSpawnEperm: () => false,
  };
  const context = compile(relative, name, dependencies);
  const options = { agents: new Map([["reviewer", { name: "reviewer" }]]), cwd: dir, allowLocalModel: false,
    phaseResultFile: sidecar, phaseLogFile: path.join(dir, "phase-0-reviewer.log"),
    onProgress() { if (fault === "progress") throw reason; } };
  const pending = context.launch("reviewer", "Review owned fixture only.", options);
  // Attach the rejection observer immediately; no unhandled rejection or waits.
  const settled = pending.then(value => ({ value }), error => ({ error }));
  if (fault === "success") {
    await ready;
    child.stderr.emit("data", Buffer.from("FIXTURE_MONITOR_READY"));
    reader.emit("line", JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "verified fixture" } }));
    reader.emit("line", JSON.stringify({ type: "agent_end" }));
    child.emit("close", 0);
  }
  const outcome = await settled;
  const result = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  assert.notEqual(result.launchId, "older-attempt", "the stale sidecar must be replaced by this attempt");
  assert.equal(result.launchId, publications[0].launchId, "settlement must retain the admitted attempt's launch binding");
  assert.equal(result.taskSha256, crypto.createHash("sha256").update("Review owned fixture only.").digest("hex"));
  if (fault === "success") {
    assert.equal(outcome.error, undefined, outcome.error?.stack);
    assert.equal(spawned, 1);
    assert.equal(result.status, "complete");
    assert.equal(result.result.exitCode, 0);
    assert.equal(result.result.text, "verified fixture");
    assert.ok(result.completedAt);
  } else if (fault === "survivor") {
    assert.ok(outcome.error, "post-spawn setup failure still rejects");
    assert.equal(spawned, 1);
    assert.equal(result.status, "running", "a returned child must not be terminalized by the pre-spawn catch");
    assert.equal(result.pid, child.pid);
    child.emit("close", 1);
    const closed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    assert.equal(closed.status, "incomplete", "existing close handling retains settlement ownership");
    assert.ok(closed.completedAt);
  } else {
    if (fault === "spawn") assert.match(outcome.error?.message, new RegExp(reason.message), "existing spawn-error wrapping remains intact");
    else if (fault === "empty") assert.match(outcome.error?.message, /no spawn attempts were available/);
    else assert.equal(outcome.error, reason, "original admission error must propagate unchanged");
    assert.equal(spawned, 0, "admission failure must not spawn a worker");
    assert.equal(result.eventCount, 0);
    assert.equal(result.pid, undefined);
    assert.equal(result.status, "incomplete", "unspawned attempt must not remain running");
    assert.match(result.incompleteReason, fault === "empty" ? /no spawn attempts were available/ : new RegExp(reason.message));
    assert.ok(result.completedAt, "pre-spawn refusal must have a completion timestamp");
    assert.equal(result.result, undefined, "refusal must never manufacture a successful worker result");
  }
}
module.exports = { compile, SCRATCH, substrate, ts, ROOT };
if (require.main === module) (async () => {
  try {
    for (const [relative, name] of [["src/substrate.ts", "spawnSubagent"], ["src/index.ts", "runSubagent"]]) {
      for (const fault of ["capacity", "prompt", "preparation", "progress", "policy", "write", "command", "attempts", "collector", "spawn", "empty", "cleanup", "success", "survivor"]) await check(`${name}/${fault}`, () => exercise(relative, name, fault));
    }
  } finally { fs.rmSync(SCRATCH, { recursive: true, force: true }); }
  assert.equal(failures.length, 0, 'worker settlement cases failed');
  process.exitCode = 0;
})().catch(() => { console.error('WORKER_SETTLEMENT_CHECK_FAILED (safe labels only)'); process.exitCode = 1; });
