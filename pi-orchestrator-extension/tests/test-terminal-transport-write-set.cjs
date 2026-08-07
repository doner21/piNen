#!/usr/bin/env node
/**
 * Regression coverage for RUN_20260722-001825 shape repair:
 * - frozen-gate/custom dispatch enforces predictedWriteSet before verifier spawn,
 *   including absolute external prefix observation and lookalike sibling rejects.
 * - terminal assistant/transport-after-work on a mutating phase is persisted as
 *   candidate/result-lost no-retry state and resume does not respawn it.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function makeJiti() { return createJiti(__filename, { interopDefault: true, moduleCache: false }); }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({ registerTool(def) { if (def.name === "orchestrate") tool = def; }, registerCommand() {} });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

function writeFakeCli(dir) {
  const fakePath = path.join(dir, "fake-terminal-transport-cli.cjs");
  fs.writeFileSync(fakePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
function argValue(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function agentName() {
  const prompt = argValue("--append-system-prompt") || "unknown-system-prompt.txt";
  return path.basename(prompt).replace(/-system-prompt\\.txt$/, "") || "unknown";
}
function promptText() {
  const last = args[args.length - 1];
  return last && !last.startsWith("--") ? last : "";
}
function emit(event) { console.log(JSON.stringify(event)); }
function log(prompt) {
  if (!process.env.FAKE_PI_LOG) return;
  fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({
    agentName: agentName(),
    provider: argValue("--provider") || null,
    model: argValue("--model") || null,
    promptSnippet: prompt.slice(0, 220),
  }) + "\\n", "utf8");
}
function finish(text, opts = {}) {
  emit({ type: "message_start" });
  for (const event of opts.toolEvents || []) emit(event);
  const message = { role: "assistant", content: [{ type: "text", text }] };
  if (opts.stopReason) message.stopReason = opts.stopReason;
  if (opts.errorMessage) message.errorMessage = opts.errorMessage;
  emit({ type: "message_end", message, stopReason: opts.stopReason, errorMessage: opts.errorMessage });
  emit({ type: "agent_end" });
  process.exit(opts.exitCode ?? 0);
}
const prompt = promptText();
log(prompt);
if (prompt.includes("You are the EXECUTOR in a frozen-gate-fix-loop orchestration")) {
  fs.writeFileSync(path.resolve(process.cwd(), "bounded-fix-marker.txt"), "bounded fix marker\\n", "utf8");
  if (process.env.FAKE_MODE === "external-write-set" || process.env.FAKE_MODE === "external-only-cwd-mutation") {
    const base = process.env.FAKE_EXTERNAL_BASE;
    fs.mkdirSync(path.join(base, "replicas"), { recursive: true });
    fs.writeFileSync(path.join(base, "replicas", "ok.txt"), "allowed child\\n", "utf8");
    if (process.env.FAKE_MODE === "external-write-set") {
      fs.mkdirSync(path.join(base, "replicas$DIR"), { recursive: true });
      fs.writeFileSync(path.join(base, "replicas$DIR", "bad.txt"), "lookalike sibling violation\\n", "utf8");
    }
  }
  if (process.env.FAKE_MODE === "dirty-file-mutation") {
    for (const file of (process.env.FAKE_DIRTY_FILES || "").split(path.delimiter).filter(Boolean)) {
      fs.appendFileSync(file, "mutated again by bounded-fix\\n", "utf8");
    }
  }
  if (process.env.FAKE_MODE === "terminal-after-work") {
    finish("candidate bounded-fix result after mutation", {
      stopReason: "error",
      errorMessage: "terminal transport failed after mutating work completed",
      toolEvents: [
        { type: "tool_execution_start", toolName: "write" },
        { type: "tool_execution_end", toolName: "write" },
      ],
    });
  }
  finish("bounded fix completed; frozen doc not modified", {
    toolEvents: [
      { type: "tool_execution_start", toolName: "write" },
      { type: "tool_execution_end", toolName: "write" },
    ],
  });
}
if (prompt.includes("You are the VERIFIER in a frozen-gate-fix-loop orchestration")) {
  finish(JSON.stringify({ overall: "pass", reasons: ["fixture verifier pass"], feedback: "", evidence: [] }));
}
if (prompt.includes("Plan the following task")) {
  const mode = process.env.FAKE_MODE || "";
  const tasks = mode === "pev-concurrent-violation"
    ? [1, 2].map((n) => ({ id: "task-" + n, description: "CREATE file out-" + n + ".txt with the fixture content.", dependsOn: [] }))
    : [{ id: "task-1", description: "CREATE file out-1.txt with the fixture content.", dependsOn: [] }];
  finish(JSON.stringify({ tasks, notes: "fixture plan for " + (mode || "default") }));
}
if (prompt.includes("You are executing one task from a deterministic orchestration")) {
  const mode = process.env.FAKE_MODE || "";
  const assignedBlock = prompt.includes("Assigned executor task:") ? prompt.slice(prompt.lastIndexOf("Assigned executor task:")) : prompt;
  const taskMatches = [...assignedBlock.matchAll(/"id": "task-([0-9]+)"/g)];
  const n = taskMatches.length ? Number(taskMatches[taskMatches.length - 1][1]) : 1;
  const out = path.resolve(process.cwd(), "out-" + n + ".txt");
  fs.writeFileSync(out, "fixture content for out-" + n + "\\n", "utf8");
  if (mode === "pev-dirty-mutation") {
    for (const file of (process.env.FAKE_DIRTY_FILES || "").split(path.delimiter).filter(Boolean)) {
      fs.appendFileSync(file, "mutated by executor task-" + n + "\\n", "utf8");
    }
  }
  if (mode === "pev-terminal-violation") {
    fs.writeFileSync(path.resolve(process.cwd(), "unexpected-terminal.txt"), "terminal path violation\\n", "utf8");
  }
  if (mode === "pev-concurrent-violation" && n === 2) {
    fs.writeFileSync(path.resolve(process.cwd(), "unexpected-concurrent.txt"), "concurrent path violation\\n", "utf8");
  }
  const toolEvents = [
    { type: "tool_execution_start", toolName: "write" },
    { type: "tool_execution_end", toolName: "write" },
  ];
  if (mode === "pev-terminal-clean" || mode === "pev-terminal-violation") {
    finish("candidate executor result for task-" + n, {
      stopReason: "error",
      errorMessage: "terminal transport failed after mutating PEV executor work completed",
      toolEvents,
    });
  }
  finish("executor completed task-" + n, { toolEvents });
}
if (prompt.includes("Verify the orchestration result")) {
  finish(JSON.stringify({ status: "pass", reasons: ["fixture verifier pass"] }));
}
finish("ok");
`, "utf8");
  try { fs.chmodSync(fakePath, 0o755); } catch {}
  return fakePath;
}

function makeTask(cwd) {
  const docContent = Buffer.from("FROZEN GATE SPEC v1\nAcceptance: all findings resolved.\n");
  const docPath = path.join(cwd, "gate.md");
  fs.writeFileSync(docPath, docContent);
  return [
    "Bounded fix of the existing implementation against the frozen gate.",
    `FROZEN_DOC_PATH: ${docPath}`,
    `FROZEN_DOC_SHA256: ${sha256(docContent)}`,
    "FINDINGS:",
    "- residual finding: fix the marker",
  ].join("\n");
}

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

function initGit(dir) {
  git(dir, ["init"]);
}

function commitTrackedFixture(dir, file, content) {
  git(dir, ["config", "user.email", "fixture@example.test"]);
  git(dir, ["config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(dir, file), content, "utf8");
  git(dir, ["add", file]);
  git(dir, ["commit", "-m", `add ${file}`]);
}

async function runFrozenGateScenario(mode, extraParams = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-terminal-ws-"));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-runs-"));
  const externalBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-external-"));
  initGit(cwd);
  const fakeCli = writeFakeCli(cwd);
  const logPath = path.join(cwd, "log.jsonl");
  const previous = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_PI_LOG: process.env.FAKE_PI_LOG,
    FAKE_MODE: process.env.FAKE_MODE,
    FAKE_EXTERNAL_BASE: process.env.FAKE_EXTERNAL_BASE,
    FAKE_DIRTY_FILES: process.env.FAKE_DIRTY_FILES,
    PI_ORCHESTRATOR_RUNS_ROOT: process.env.PI_ORCHESTRATOR_RUNS_ROOT,
  };
  process.env.PI_CLI_PATH = fakeCli;
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_MODE = mode;
  process.env.FAKE_EXTERNAL_BASE = externalBase;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-terminal-transport-write-set",
      {
        task: makeTask(cwd),
        paradigm: "frozen-gate-fix-loop",
        preflight: false,
        cwd,
        maxSubagents: 12,
        maxRetries: 2,
        ...extraParams,
      },
      undefined,
      () => {},
      { cwd },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { cwd, runsRoot, externalBase, logPath, result, calls, tool };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runPevScenario(mode, extraParams = {}, setup = () => {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-terminal-ws-"));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-runs-"));
  const previous = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_PI_LOG: process.env.FAKE_PI_LOG,
    FAKE_MODE: process.env.FAKE_MODE,
    FAKE_DIRTY_FILES: process.env.FAKE_DIRTY_FILES,
    PI_ORCHESTRATOR_RUNS_ROOT: process.env.PI_ORCHESTRATOR_RUNS_ROOT,
  };
  initGit(cwd);
  setup(cwd);
  const fakeCli = writeFakeCli(cwd);
  const logPath = path.join(cwd, "log.jsonl");
  process.env.PI_CLI_PATH = fakeCli;
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_MODE = mode;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      `test-pev-${mode}`,
      {
        task: "Build the PEV fixture artifact(s).",
        preflight: false,
        cwd,
        maxSubagents: 12,
        maxRetries: 2,
        predictedWriteSet: "out-1.txt, out-2.txt, log.jsonl",
        ...extraParams,
      },
      undefined,
      () => {},
      { cwd },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { cwd, runsRoot, logPath, result, calls, tool };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testExternalWriteSetViolationBeforeVerifier() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-terminal-ws-"));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-runs-"));
  const externalBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-external-"));
  initGit(cwd);
  const fakeCli = writeFakeCli(cwd);
  const logPath = path.join(cwd, "log.jsonl");
  process.env.PI_CLI_PATH = fakeCli;
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_MODE = "external-write-set";
  process.env.FAKE_EXTERNAL_BASE = externalBase;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-external-write-set",
      {
        task: makeTask(cwd),
        paradigm: "frozen-gate-fix-loop",
        preflight: false,
        cwd,
        maxSubagents: 12,
        maxRetries: 2,
        predictedWriteSet: [
          "bounded-fix-marker.txt",
          "log.jsonl",
          path.join(externalBase, "replicas") + path.sep,
        ].join(","),
      },
      undefined,
      () => {},
      { cwd },
    );
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const coder = calls.filter((c) => c.agentName === "coder");
    const reviewer = calls.filter((c) => c.agentName === "reviewer");
    const markdown = result.content?.[0]?.text || "";
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "WRITE_SET_VIOLATION");
    assert.equal(result.details.retryAllowed, false);
    assert.equal(result.details.verifierSpawned, false);
    assert.equal(coder.length, 1, "one bounded-fix spawn should occur before write-set enforcement");
    assert.equal(reviewer.length, 0, "write-set violation must stop before verifier spawn");
    assert.ok(result.details.violations.some((p) => p.includes("replicas$DIR") && p.endsWith("bad.txt")), "lookalike replicas$DIR/ sibling must be named as violation");
    assert.match(markdown, /WRITE_SET_VIOLATION/);

    const runId = result.details.runId || result.details.terminalNoRetry?.runId;
    assert.ok(runId, "write-set violation must persist a resumable terminal run id");
    const runState = makeJiti()(path.join(PROJECT_ROOT, "src", "run-state.ts"));
    const loaded = runState.RunStateStore.load(runId);
    assert.equal(loaded.terminalStates.size, 1, "write-set violation must be persisted as terminal no-retry state");
    assert.equal([...loaded.terminalStates.values()][0].code, "WRITE_SET_VIOLATION");

    const beforeResumeCalls = calls.length;
    const resumeResult = await tool.execute(
      "test-write-set-violation-resume",
      { resume: runId, preflight: false, cwd },
      undefined,
      () => {},
      { cwd },
    );
    const allCalls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(allCalls.length, beforeResumeCalls, "resume after WRITE_SET_VIOLATION must not respawn executor or verifier");
    assert.equal(resumeResult.details.code, "WRITE_SET_VIOLATION");
    assert.equal(resumeResult.details.retryAllowed, false);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_EXTERNAL_BASE;
    delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(externalBase, { recursive: true, force: true });
  }
}

async function testExternalOnlyWriteSetStillObservesCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-external-only-cwd-"));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-runs-"));
  const externalBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-external-"));
  initGit(cwd);
  const fakeCli = writeFakeCli(cwd);
  const previous = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_MODE: process.env.FAKE_MODE,
    FAKE_EXTERNAL_BASE: process.env.FAKE_EXTERNAL_BASE,
    PI_ORCHESTRATOR_RUNS_ROOT: process.env.PI_ORCHESTRATOR_RUNS_ROOT,
  };
  process.env.PI_CLI_PATH = fakeCli;
  process.env.FAKE_MODE = "external-only-cwd-mutation";
  process.env.FAKE_EXTERNAL_BASE = externalBase;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-external-only-cwd-observed",
      {
        task: makeTask(cwd),
        paradigm: "frozen-gate-fix-loop",
        preflight: false,
        cwd,
        maxSubagents: 12,
        maxRetries: 2,
        predictedWriteSet: path.join(externalBase, "replicas") + path.sep,
      },
      undefined,
      () => {},
      { cwd },
    );
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "WRITE_SET_VIOLATION");
    assert.equal(result.details.verifierSpawned, false);
    assert.ok(result.details.violations.includes("bounded-fix-marker.txt"), "cwd mutation must be observed even when write set is external-only");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(externalBase, { recursive: true, force: true });
  }
}

async function testAlreadyDirtyFilesChangedAgainAreViolations() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-dirty-baseline-"));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fgfl-runs-"));
  initGit(cwd);
  commitTrackedFixture(cwd, "tracked-dirty.txt", "committed baseline\n");
  fs.appendFileSync(path.join(cwd, "tracked-dirty.txt"), "pre-existing tracked dirty state\n", "utf8");
  fs.writeFileSync(path.join(cwd, "untracked-dirty.txt"), "pre-existing untracked dirty state\n", "utf8");
  const fakeCli = writeFakeCli(cwd);
  const logPath = path.join(cwd, "log.jsonl");
  const previous = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_PI_LOG: process.env.FAKE_PI_LOG,
    FAKE_MODE: process.env.FAKE_MODE,
    FAKE_DIRTY_FILES: process.env.FAKE_DIRTY_FILES,
    PI_ORCHESTRATOR_RUNS_ROOT: process.env.PI_ORCHESTRATOR_RUNS_ROOT,
  };
  process.env.PI_CLI_PATH = fakeCli;
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_MODE = "dirty-file-mutation";
  process.env.FAKE_DIRTY_FILES = [path.join(cwd, "tracked-dirty.txt"), path.join(cwd, "untracked-dirty.txt")].join(path.delimiter);
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dirty-baseline-write-set",
      {
        task: makeTask(cwd),
        paradigm: "frozen-gate-fix-loop",
        preflight: false,
        cwd,
        maxSubagents: 12,
        maxRetries: 2,
        predictedWriteSet: "bounded-fix-marker.txt, log.jsonl",
      },
      undefined,
      () => {},
      { cwd },
    );
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "WRITE_SET_VIOLATION");
    assert.equal(calls.filter((c) => c.agentName === "reviewer").length, 0, "dirty-file mutation violation must stop before verifier");
    assert.ok(result.details.violations.includes("tracked-dirty.txt"), "tracked dirty file changed again must be detected");
    assert.ok(result.details.violations.includes("untracked-dirty.txt"), "untracked dirty file changed again must be detected");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
}

async function testPevUnobservableWriteSetFailsClosedBeforeVerifier() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-unobservable-ws-"));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pev-runs-"));
  const logPath = path.join(cwd, "fake-pi-log.jsonl");
  const previous = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_PI_LOG: process.env.FAKE_PI_LOG,
    FAKE_PI_PLAN_STYLE: process.env.FAKE_PI_PLAN_STYLE,
    FAKE_PI_EXECUTOR_STYLE: process.env.FAKE_PI_EXECUTOR_STYLE,
    PI_ORCHESTRATOR_RUNS_ROOT: process.env.PI_ORCHESTRATOR_RUNS_ROOT,
  };
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_PLAN_STYLE = "impl-1";
  process.env.FAKE_PI_EXECUTOR_STYLE = "write-summary-table";
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-pev-unobservable-write-set",
      {
        task: "Build the fixture artifact: CREATE file out-1.txt with the fixture content.",
        preflight: false,
        cwd,
        maxSubagents: 6,
        maxRetries: 0,
        predictedWriteSet: "out-1.txt, fake-pi-log.jsonl",
      },
      undefined,
      () => {},
      { cwd },
    );
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const markdown = result.content?.[0]?.text || "";
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "WRITE_SET_UNOBSERVABLE");
    assert.equal(result.details.retryAllowed, false);
    assert.equal(result.details.verifierSpawned, false);
    assert.match(markdown, /WRITE_SET_UNOBSERVABLE/);
    assert.equal(calls.filter((c) => c.agentName === "reviewer").length, 0, "PEV unobservable write-set snapshot must fail before verifier spawn");
    assert.equal(calls.filter((c) => c.agentName === "coder").length, 0, "pre-executor unobservable write-set snapshot must fail before executor spawn");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
}

async function testTerminalTransportNoRetryAndResumeNoRespawn() {
  const scenario = await runFrozenGateScenario("terminal-after-work");
  const { result, calls, cwd, runsRoot, externalBase, tool } = scenario;
  try {
    const coder = calls.filter((c) => c.agentName === "coder");
    const reviewer = calls.filter((c) => c.agentName === "reviewer");
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "AMBIGUOUS_COMPLETION");
    assert.equal(result.details.retryAllowed, false);
    assert.equal(result.details.verifierSpawned, false);
    assert.ok(result.details.spawnedCount >= 1, "ambiguous report must preserve spawnedCount >= 1");
    assert.equal(coder.length, 1, "mutating executor spawned exactly once");
    assert.equal(reviewer.length, 0, "terminal ambiguous mutating phase must not spawn verifier");

    const terminal = result.details.terminalNoRetry;
    assert.ok(terminal.runId, "terminal state should include runId for resume");
    assert.ok(terminal.candidateResultFile, "candidate result should be persisted when assistant text was captured");
    assert.ok(fs.existsSync(terminal.candidateResultFile), "candidate result file must exist");
    const candidate = JSON.parse(fs.readFileSync(terminal.candidateResultFile, "utf8"));
    assert.match(candidate.text, /candidate bounded-fix result/);

    const previousRunsRoot = process.env.PI_ORCHESTRATOR_RUNS_ROOT;
    process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
    try {
      const runState = makeJiti()(path.join(PROJECT_ROOT, "src", "run-state.ts"));
      const loaded = runState.RunStateStore.load(terminal.runId);
      assert.equal(loaded.terminalStates.size, 1, "terminal no-retry state must be persisted in run-state");
      assert.equal([...loaded.terminalStates.values()][0].retryAllowed, false);

      const beforeResumeCalls = calls.length;
      const resumeResult = await tool.execute(
        "test-terminal-resume",
        { resume: terminal.runId, preflight: false, cwd },
        undefined,
        () => {},
        { cwd },
      );
      const allCalls = fs.readFileSync(path.join(cwd, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(allCalls.length, beforeResumeCalls, "resume of terminal no-retry state must not respawn any subagent");
      assert.equal(resumeResult.details.code, "AMBIGUOUS_COMPLETION");
      assert.equal(resumeResult.details.retryAllowed, false);
      assert.ok(resumeResult.details.spawnedCount >= 1, "resume report must still preserve prior spawnedCount >= 1");
    } finally {
      if (previousRunsRoot === undefined) delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;
      else process.env.PI_ORCHESTRATOR_RUNS_ROOT = previousRunsRoot;
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(externalBase, { recursive: true, force: true });
  }
}

async function testPevDirtyBaselineFilesChangedAgainAreViolations() {
  const scenario = await runPevScenario("pev-dirty-mutation", {
    predictedWriteSet: "out-1.txt, log.jsonl",
  }, (cwd) => {
    commitTrackedFixture(cwd, "tracked-dirty.txt", "committed baseline\n");
    fs.appendFileSync(path.join(cwd, "tracked-dirty.txt"), "pre-existing tracked dirty state\n", "utf8");
    fs.writeFileSync(path.join(cwd, "untracked-dirty.txt"), "pre-existing untracked dirty state\n", "utf8");
    process.env.FAKE_DIRTY_FILES = [path.join(cwd, "tracked-dirty.txt"), path.join(cwd, "untracked-dirty.txt")].join(path.delimiter);
  });
  const { result, calls, cwd, runsRoot } = scenario;
  try {
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "WRITE_SET_VIOLATION");
    assert.equal(result.details.retryAllowed, false);
    assert.equal(result.details.verifierSpawned, false);
    assert.equal(calls.filter((c) => c.agentName === "coder").length, 1, "PEV executor should run once before post-executor write-set evaluation");
    assert.equal(calls.filter((c) => c.agentName === "reviewer").length, 0, "PEV dirty-baseline violation must stop before verifier");
    assert.ok(result.details.violations.includes("tracked-dirty.txt"), "tracked dirty content change must be detected");
    assert.ok(result.details.violations.includes("untracked-dirty.txt"), "untracked dirty content change must be detected");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
}

async function testPevTerminalNoRetryPersistsAndResumeDoesNotRespawn() {
  const scenario = await runPevScenario("pev-terminal-clean", {
    predictedWriteSet: "out-1.txt, log.jsonl",
  });
  const { result, calls, cwd, runsRoot, tool } = scenario;
  try {
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "AMBIGUOUS_COMPLETION");
    assert.equal(result.details.retryAllowed, false);
    assert.equal(result.details.verifierSpawned, false);
    assert.ok(result.details.spawnedCount >= 2, "PEV terminal report must preserve planner+executor spawn count");
    assert.equal(calls.filter((c) => c.agentName === "planner").length, 1);
    assert.equal(calls.filter((c) => c.agentName === "coder").length, 1);
    assert.equal(calls.filter((c) => c.agentName === "reviewer").length, 0);
    const terminal = result.details.terminalNoRetry;
    assert.equal(terminal.retryAllowed, false);
    assert.ok(terminal.runId, "PEV terminal state must include run id");
    assert.ok(terminal.candidateResultFile, "PEV terminal candidate must be persisted");
    assert.ok(fs.existsSync(terminal.candidateResultFile));

    const previousRunsRoot = process.env.PI_ORCHESTRATOR_RUNS_ROOT;
    process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
    try {
      const beforeResumeCalls = calls.length;
      const resumeResult = await tool.execute(
        "test-pev-terminal-resume",
        { resume: terminal.runId, preflight: false, cwd },
        undefined,
        () => {},
        { cwd },
      );
      const allCalls = fs.readFileSync(path.join(cwd, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(allCalls.length, beforeResumeCalls, "PEV terminal resume must not spawn planner/executor/verifier again");
      assert.equal(resumeResult.details.code, "AMBIGUOUS_COMPLETION");
      assert.equal(resumeResult.details.retryAllowed, false);
      assert.equal(resumeResult.details.verifierSpawned, false);
    } finally {
      if (previousRunsRoot === undefined) delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;
      else process.env.PI_ORCHESTRATOR_RUNS_ROOT = previousRunsRoot;
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
}

async function testPevTerminalTransportWriteSetViolationWins() {
  const scenario = await runPevScenario("pev-terminal-violation", {
    predictedWriteSet: "out-1.txt, log.jsonl",
  });
  const { result, calls, cwd, runsRoot } = scenario;
  try {
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "WRITE_SET_VIOLATION");
    assert.equal(result.details.retryAllowed, false);
    assert.equal(result.details.verifierSpawned, false);
    assert.equal(calls.filter((c) => c.agentName === "coder").length, 1);
    assert.equal(calls.filter((c) => c.agentName === "reviewer").length, 0);
    assert.ok(result.details.violations.includes("unexpected-terminal.txt"), "write-set failure must win over terminal ambiguous state when present");
    assert.equal(result.details.terminalNoRetry.code, "WRITE_SET_VIOLATION");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
}

async function testPevConcurrentWaveWriteSetViolationStopsBeforeVerifier() {
  const scenario = await runPevScenario("pev-concurrent-violation", {
    executorConcurrency: 2,
    predictedWriteSet: "out-1.txt, out-2.txt, log.jsonl",
  });
  const { result, calls, cwd, runsRoot } = scenario;
  try {
    assert.equal(result.details.status, "fail");
    assert.equal(result.details.code, "WRITE_SET_VIOLATION");
    assert.equal(result.details.verifierSpawned, false);
    assert.equal(calls.filter((c) => c.agentName === "coder").length, 2, "both independent PEV executors should run in the concurrent wave");
    assert.equal(calls.filter((c) => c.agentName === "reviewer").length, 0, "concurrent write-set violation must stop before verifier");
    assert.ok(result.details.violations.includes("unexpected-concurrent.txt"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
}

(async function main() {
  await testExternalWriteSetViolationBeforeVerifier();
  console.log("ok - external absolute write-set violation persists terminal no-retry and stops before verifier");
  await testExternalOnlyWriteSetStillObservesCwd();
  console.log("ok - external-only write set still observes cwd mutations");
  await testAlreadyDirtyFilesChangedAgainAreViolations();
  console.log("ok - already-dirty tracked/untracked file mutations are detected");
  await testPevUnobservableWriteSetFailsClosedBeforeVerifier();
  console.log("ok - PEV unobservable write-set deltas fail closed before verifier");
  await testPevDirtyBaselineFilesChangedAgainAreViolations();
  console.log("ok - PEV dirty-baseline tracked/untracked mutations are detected");
  await testPevTerminalNoRetryPersistsAndResumeDoesNotRespawn();
  console.log("ok - PEV terminal no-retry persists and resume does not respawn");
  await testPevTerminalTransportWriteSetViolationWins();
  console.log("ok - PEV terminal transport still lets write-set violation win");
  await testPevConcurrentWaveWriteSetViolationStopsBeforeVerifier();
  console.log("ok - PEV concurrent wave write-set violation stops before verifier");
  await testTerminalTransportNoRetryAndResumeNoRespawn();
  console.log("ok - terminal transport after mutating work persists no-retry and resume does not respawn");
  console.log("test-terminal-transport-write-set: ALL PASS");
})().catch((error) => {
  console.error("test-terminal-transport-write-set: FAIL");
  console.error(error);
  process.exit(1);
});
