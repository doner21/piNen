#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
);

process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function makeJiti() {
  return createJiti(__filename, { interopDefault: true, moduleCache: false });
}

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({
    registerTool(definition) {
      if (definition.name === "orchestrate") tool = definition;
    },
    registerCommand() {},
  });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

async function testRegistryDiscovery() {
  const tool = loadOrchestrateTool();
  const result = await tool.execute(
    "test-win-console-spawn-discovery",
    { task: "list paradigms", paradigm: "unknown-test-paradigm", preflight: false, cwd: PROJECT_ROOT },
    undefined,
    () => {},
    { cwd: PROJECT_ROOT },
  );
  assert.equal(result.details.status, "fail");
  assert.match(result.details.abortReason, /Available paradigms:/);
  assert.match(result.details.abortReason, /win-console-spawn-root-cause/);
}

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "shapes", "win-console-spawn-root-cause.ts"),
    "utf8",
  );

  // Must have the correct shape name.
  assert.match(source, /name:\s*"win-console-spawn-root-cause"/);

  // Must use SpawnGuard and spawnSubagent (substrate primitives).
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);

  // Must NOT import sibling shapes.
  assert.doesNotMatch(
    source,
    /from\s+["']\.\//,
    "shape must not import sibling shapes",
  );

  // Must NOT call reload bridge, scheduler, executeCommand, or sendUserMessage reload.
  assert.doesNotMatch(
    source,
    /agent_reload_runtime\s*\(/,
    "shape must not call reload bridge",
  );
  assert.doesNotMatch(
    source,
    /agent_scheduler\s*\(/,
    "shape must not call scheduler bridge",
  );
  assert.doesNotMatch(
    source,
    /executeCommand\s*\(/,
    "shape must not call executeCommand",
  );
  assert.doesNotMatch(
    source,
    /sendUserMessage\s*\(\s*["']\/reload/,
    "shape must not send reload slash command",
  );

  // Must contain the default model routing text for DeepSeek V4 Pro.
  assert.match(
    source,
    /deepseek-v4-pro/,
    "shape must reference deepseek-v4-pro (executor default model)",
  );

  // Must contain the default model routing text for GPT-5.5.
  assert.match(
    source,
    /gpt-5.5/,
    "shape must reference gpt-5.5 (planner/verifier default model)",
  );

  // Must reference all three phases.
  assert.match(source, /intake-boundary-plan/);
  assert.match(source, /instrumented-execution-and-candidate-fix/);
  assert.match(source, /falsifiable-verification-and-synthesis/);

  // Must contain Orchestrator Role Integrity Ledger section.
  assert.match(source, /Orchestrator Role Integrity Ledger/);

  // Must contain model routing defaults.
  assert.match(source, /DEFAULT_PLANNER_PROVIDER\s*=\s*"openai-codex"/);
  assert.match(source, /DEFAULT_PLANNER_MODEL\s*=\s*"gpt-5.5"/);
  assert.match(source, /DEFAULT_EXECUTOR_PROVIDER\s*=\s*"deepseek"/);
  assert.match(source, /DEFAULT_EXECUTOR_MODEL\s*=\s*"deepseek-v4-pro"/);
  assert.match(source, /DEFAULT_VERIFIER_PROVIDER\s*=\s*"openai-codex"/);
  assert.match(source, /DEFAULT_VERIFIER_MODEL\s*=\s*"gpt-5.5"/);

  // Must use modelOverride when spawning.
  assert.match(source, /modelOverride/);

  // Must NOT have unbounded loops.
  assert.doesNotMatch(source, /while\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(source, /for\s*\(\s*;\s*;\s*\)/);
}

async function testProposeShapeWithFakePi() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-console-test-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-console-root-cause-run",
      {
        task: "Investigate remaining terminal/console flashes on Pi reload and new-session. Normal message-send flashes are already fixed.",
        paradigm: "win-console-spawn-root-cause",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Win-Console-Spawn-Root-Cause Orchestration:/);
    assert.match(markdown, /Paradigm:\*\* win-console-spawn-root-cause/);
    assert.match(markdown, /Orchestrator Role Integrity Ledger/);
    assert.match(markdown, /ORCHESTRATOR/);
    assert.match(markdown, /did NOT execute main-task work/);
    assert.match(markdown, /Phase 1: intake-boundary-plan/);
    assert.match(markdown, /Phase 2: instrumented-execution-and-candidate-fix/);
    assert.match(markdown, /Phase 3: falsifiable-verification-and-synthesis/);

    assert.equal(result.details.paradigm, "win-console-spawn-root-cause");
    assert.equal(result.details.phases, 3);
    assert.ok(result.details.modelRouting, "must include model routing details");
    assert.equal(
      result.details.modelRouting.executor,
      "deepseek/deepseek-v4-pro",
      "executor must default to deepseek/deepseek-v4-pro",
    );
    assert.equal(
      result.details.modelRouting.planner,
      "openai-codex/gpt-5.5",
      "planner must default to openai-codex/gpt-5.5",
    );
    assert.equal(
      result.details.modelRouting.verifier,
      "openai-codex/gpt-5.5",
      "verifier must default to openai-codex/gpt-5.5",
    );
    assert.equal(result.details.spawnedCount, 3);
    assert.equal(result.details.spawnedCap, 6);
    assert.equal(
      result.details.orchestratorRoleIntegrity.orchestratorExecutedMainTaskWork,
      false,
    );
    assert.equal(
      result.details.orchestratorRoleIntegrity.requestedShape,
      "win-console-spawn-root-cause",
    );

    // Verify fake Pi logged exactly 3 spawns.
    const calls = fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 3, "must spawn exactly 3 subagents (planner + executor + verifier)");
    assert.equal(calls[0].agentName, "planner");
    assert.equal(calls[1].agentName, "coder");
    assert.equal(calls[2].agentName, "reviewer");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testVerifierFailWithExitCodeZero() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-console-verifier-fail-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_WIN_CONSOLE_VERIFIER_VERDICT = "fail";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-console-verifier-fail-exit0",
      {
        task: "Investigate remaining terminal/console flashes. Verifier should fail even with exit code 0.",
        paradigm: "win-console-spawn-root-cause",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Status must be "fail" despite all subagents exiting with code 0.
    assert.equal(
      result.details.status,
      "fail",
      "shape status must be 'fail' when verifier verdict is fail, even with exit code 0",
    );

    // Verifier verdict details must be present and indicate failure.
    assert.ok(
      result.details.verifierVerdict,
      "details must include parsed verifier verdict",
    );
    assert.equal(
      result.details.verifierVerdict.isFail,
      true,
      "verifier verdict must indicate failure",
    );
    assert.equal(
      result.details.verifierVerdict.overall,
      "fail",
      "verifier overall must be 'fail'",
    );
    assert.ok(
      Array.isArray(result.details.verifierVerdict.reasons),
      "verifier verdict must include reasons array",
    );
    assert.ok(
      result.details.verifierVerdict.reasons.length > 0,
      "verifier verdict reasons must not be empty",
    );

    // Markdown must reflect FAIL.
    const markdown = result.content?.[0]?.text || "";
    assert.match(
      markdown,
      /# Win-Console-Spawn-Root-Cause Orchestration: FAIL/,
      "markdown title must indicate FAIL",
    );
    assert.match(
      markdown,
      /Final status:\*\* FAIL/,
      "markdown final status must be FAIL",
    );
    assert.match(
      markdown,
      /Verifier Gate/,
      "markdown must include Verifier Gate section",
    );
    assert.match(
      markdown,
      /Gate triggered:\*\* FAIL/,
      "verifier gate must indicate FAIL",
    );
    assert.match(
      markdown,
      /Overall:\*\* fail/,
      "verifier gate overall must be fail",
    );

    // Subagents should all have exit code 0 but still produce a fail verdict.
    assert.equal(result.details.spawnedCount, 3);
    const calls = fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 3, "must spawn exactly 3 subagents");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_CONSOLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testVerifierPassStillWorks() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-console-verifier-pass-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_WIN_CONSOLE_VERIFIER_VERDICT = "pass";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-console-verifier-pass",
      {
        task: "Investigate flashes. Verifier should pass.",
        paradigm: "win-console-spawn-root-cause",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Status must be "pass" when verifier passes and all exit codes are 0.
    assert.equal(
      result.details.status,
      "pass",
      "shape status must be 'pass' when verifier verdict is pass",
    );
    assert.ok(result.details.verifierVerdict, "details must include verifier verdict");
    assert.equal(result.details.verifierVerdict.isFail, false);
    assert.equal(result.details.verifierVerdict.overall, "pass");

    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Win-Console-Spawn-Root-Cause Orchestration: PASS/);
    assert.match(markdown, /Verifier Gate/);
    assert.match(markdown, /Gate triggered:\*\* PASS/);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_CONSOLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testRegistryDiscovery();
  testCommittedShapeStaticRules();
  await testProposeShapeWithFakePi();
  await testVerifierFailWithExitCodeZero();
  await testVerifierPassStillWorks();
  console.log(
    "PASS win-console-spawn-root-cause: registry discovery, static rules, shape execution with fake Pi, verifier fail/pass gate",
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
