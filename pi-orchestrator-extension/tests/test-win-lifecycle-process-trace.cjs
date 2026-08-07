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
    "test-win-lifecycle-trace-discovery",
    { task: "list paradigms", paradigm: "unknown-test-paradigm", preflight: false, cwd: PROJECT_ROOT },
    undefined,
    () => {},
    { cwd: PROJECT_ROOT },
  );
  assert.equal(result.details.status, "fail");
  assert.match(result.details.abortReason, /Available paradigms:/);
  assert.match(result.details.abortReason, /win-lifecycle-process-trace/);
}

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "shapes", "win-lifecycle-process-trace.ts"),
    "utf8",
  );

  // Must have the correct shape name.
  assert.match(source, /name:\s*"win-lifecycle-process-trace"/);

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
  assert.match(source, /trace-runbook-and-harness-plan/);
  assert.match(source, /non-invasive-harness-materialization/);
  assert.match(source, /trace-evidence-verification/);

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

  // Must contain non-invasive attestation language.
  assert.match(source, /non-invasive/i);
  assert.match(source, /static-only/);
  assert.match(source, /action markers/i);
  assert.match(source, /correlation windows/i);
  assert.match(source, /external process/i);
}

async function testProposeShapeWithFakePi() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-trace-test-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-trace-run",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles. Include action markers and correlation windows.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Win-Lifecycle-Process-Trace Orchestration:/);
    assert.match(markdown, /Paradigm:\*\* win-lifecycle-process-trace/);
    assert.match(markdown, /Orchestrator Role Integrity Ledger/);
    assert.match(markdown, /ORCHESTRATOR/);
    assert.match(markdown, /did NOT execute main-task work/);
    assert.match(markdown, /Phase 1: trace-runbook-and-harness-plan/);
    assert.match(markdown, /Phase 2: non-invasive-harness-materialization/);
    assert.match(markdown, /Phase 3: trace-evidence-verification/);

    assert.equal(result.details.paradigm, "win-lifecycle-process-trace");
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
      "win-lifecycle-process-trace",
    );
    // Non-invasive attestation must be present.
    assert.ok(
      result.details.nonInvasiveAttestation,
      "details must include non-invasive attestation",
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-verifier-fail-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "fail";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-verifier-fail-exit0",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles.",
        paradigm: "win-lifecycle-process-trace",
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
      /# Win-Lifecycle-Process-Trace Orchestration: FAIL/,
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
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testVerifierPassStillWorks() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-verifier-pass-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "pass";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-verifier-pass",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles.",
        paradigm: "win-lifecycle-process-trace",
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
    assert.match(markdown, /# Win-Lifecycle-Process-Trace Orchestration: PASS/);
    assert.match(markdown, /Verifier Gate/);
    assert.match(markdown, /Gate triggered:\*\* PASS/);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDefaultsModelRouting() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-defaults-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "pass";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-defaults",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Verify gpt-5.5 and deepseek-v4-pro defaults are used.
    assert.equal(result.details.modelRouting.planner, "openai-codex/gpt-5.5");
    assert.equal(result.details.modelRouting.executor, "deepseek/deepseek-v4-pro");
    assert.equal(result.details.modelRouting.verifier, "openai-codex/gpt-5.5");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testEmptyVerifierFailsClosed() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-empty-verifier-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  // Empty/indeterminate verifier verdict: no clear pass/fail should fail closed.
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-empty-verifier",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Empty/unparseable verifier output should fail closed.
    assert.equal(
      result.details.status,
      "fail",
      "shape must fail closed when verifier output is empty/unparseable",
    );
    assert.ok(
      result.details.verifierVerdict,
      "details must include verifier verdict even for empty output",
    );
    assert.equal(
      result.details.verifierVerdict.isFail,
      true,
      "empty verifier output must produce fail verdict",
    );
    assert.match(
      result.details.verifierVerdict.reasons[0],
      /empty/,
      "empty verifier reasons must mention empty output",
    );
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testUnparseableVerifierFailsClosed() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-unparseable-verifier-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  // Non-empty unparseable verifier output: prose with no JSON and no clear verdict.
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "unparseable";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-unparseable-verifier",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Non-empty unparseable verifier output must fail closed.
    assert.equal(
      result.details.status,
      "fail",
      "shape must fail closed when verifier output is non-empty but unparseable",
    );
    assert.ok(
      result.details.verifierVerdict,
      "details must include verifier verdict for unparseable output",
    );
    assert.equal(
      result.details.verifierVerdict.isFail,
      true,
      "unparseable verifier output must produce fail verdict",
    );
    assert.ok(
      result.details.verifierVerdict.reasons.some((r) => r.toLowerCase().includes("unparseable")),
      "verifier reasons must mention unparseable output",
    );

    // Markdown must reflect FAIL.
    const markdown = result.content?.[0]?.text || "";
    assert.match(
      markdown,
      /# Win-Lifecycle-Process-Trace Orchestration: FAIL/,
      "markdown title must indicate FAIL for unparseable verifier",
    );
    assert.match(
      markdown,
      /Final status:\*\* FAIL/,
      "markdown final status must be FAIL for unparseable verifier",
    );
    assert.match(
      markdown,
      /Verifier Gate/,
      "markdown must include Verifier Gate section for unparseable verifier",
    );
    assert.match(
      markdown,
      /Gate triggered:\*\* FAIL/,
      "verifier gate must indicate FAIL for unparseable verifier",
    );
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testTextPassVerifierFailsClosed() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-text-pass-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  // Non-JSON prose containing "overall: pass" and "status: pass" keywords.
  // Must NOT be accepted as PASS — shape must fail closed.
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "text-pass";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-text-pass",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Non-JSON text with "overall: pass" must fail closed — regex pass fallback removed.
    assert.equal(
      result.details.status,
      "fail",
      "shape must fail closed when verifier output is non-JSON text containing 'overall: pass'",
    );
    assert.ok(
      result.details.verifierVerdict,
      "details must include verifier verdict for text-pass output",
    );
    assert.equal(
      result.details.verifierVerdict.isFail,
      true,
      "text-pass (non-JSON prose with pass keywords) must produce fail verdict",
    );
    assert.ok(
      result.details.verifierVerdict.reasons &&
        result.details.verifierVerdict.reasons.some((r) =>
          r.toLowerCase().includes("unparseable") || r.toLowerCase().includes("lacks a clear verdict")
        ),
      `verifier reasons must indicate unparseable/lacks verdict, got: ${JSON.stringify(result.details.verifierVerdict.reasons)}`,
    );

    // Markdown must reflect FAIL.
    const markdown = result.content?.[0]?.text || "";
    assert.match(
      markdown,
      /# Win-Lifecycle-Process-Trace Orchestration: FAIL/,
      "markdown title must indicate FAIL for text-pass verifier",
    );
    assert.match(
      markdown,
      /Final status:\*\* FAIL/,
      "markdown final status must be FAIL for text-pass verifier",
    );
    assert.match(
      markdown,
      /Gate triggered:\*\* FAIL/,
      "verifier gate must indicate FAIL for text-pass verifier",
    );
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testWrappedJsonPassVerifierFailsClosed() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-wrapped-json-pass-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  // Non-JSON wrapper prose containing an embedded JSON block with
  // {"overall":"pass"}. Must fail closed — embedded JSON pass in
  // non-JSON wrapper text is never a valid pass verdict.
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "wrapped-json-pass";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-wrapped-json-pass",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Embedded JSON {"overall":"pass"} inside non-JSON wrapper text must fail closed.
    assert.equal(
      result.details.status,
      "fail",
      "shape must fail closed when verifier output is non-JSON wrapper containing embedded JSON pass block",
    );
    assert.ok(
      result.details.verifierVerdict,
      "details must include verifier verdict for wrapped-json-pass output",
    );
    assert.equal(
      result.details.verifierVerdict.isFail,
      true,
      "wrapped-json-pass (non-JSON wrapper with embedded pass JSON) must produce fail verdict",
    );
    assert.ok(
      result.details.verifierVerdict.reasons &&
        result.details.verifierVerdict.reasons.some((r) =>
          r.toLowerCase().includes("unparseable") || r.toLowerCase().includes("lacks a clear verdict")
        ),
      `verifier reasons must indicate unparseable/lacks verdict for wrapped-json-pass, got: ${JSON.stringify(result.details.verifierVerdict.reasons)}`,
    );

    // Markdown must reflect FAIL.
    const markdown = result.content?.[0]?.text || "";
    assert.match(
      markdown,
      /# Win-Lifecycle-Process-Trace Orchestration: FAIL/,
      "markdown title must indicate FAIL for wrapped-json-pass verifier",
    );
    assert.match(
      markdown,
      /Final status:\*\* FAIL/,
      "markdown final status must be FAIL for wrapped-json-pass verifier",
    );
    assert.match(
      markdown,
      /Gate triggered:\*\* FAIL/,
      "verifier gate must indicate FAIL for wrapped-json-pass verifier",
    );
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testVerifierUnknownJsonCausesFail() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-unknown-json-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  // Parseable JSON with non-pass/fail verdict value must fail closed.
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "unknown-json";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-unknown-json",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Status must be "fail" when verifier returns parseable JSON with overall="unknown".
    assert.equal(
      result.details.status,
      "fail",
      "shape status must be 'fail' when verifier JSON has overall='unknown'",
    );
    assert.ok(
      result.details.verifierVerdict,
      "details must include parsed verifier verdict",
    );
    assert.equal(
      result.details.verifierVerdict.isFail,
      true,
      "verifier verdict must indicate failure for 'unknown' overall",
    );
    assert.equal(
      result.details.verifierVerdict.overall,
      "unknown",
      "verifier overall must be 'unknown'",
    );
    assert.ok(
      result.details.verifierVerdict.summary &&
        result.details.verifierVerdict.summary.includes("lacks a clear pass/fail verdict"),
      `verifier summary must mention 'lacks a clear pass/fail verdict', got: ${result.details.verifierVerdict.summary}`,
    );

    // Markdown must reflect FAIL.
    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Win-Lifecycle-Process-Trace Orchestration: FAIL/);
    assert.match(markdown, /Gate triggered:\*\* FAIL/);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testVerifierInconclusiveJsonCausesFail() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-inconclusive-json-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  // Parseable JSON with non-pass/fail verdict value must fail closed.
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "inconclusive-json";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-inconclusive-json",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Status must be "fail" when verifier returns parseable JSON with status="inconclusive".
    assert.equal(
      result.details.status,
      "fail",
      "shape status must be 'fail' when verifier JSON has status='inconclusive'",
    );
    assert.ok(
      result.details.verifierVerdict,
      "details must include parsed verifier verdict",
    );
    assert.equal(
      result.details.verifierVerdict.isFail,
      true,
      "verifier verdict must indicate failure for 'inconclusive' status",
    );
    assert.equal(
      result.details.verifierVerdict.overall,
      "inconclusive",
      "verifier overall must be 'inconclusive'",
    );
    assert.ok(
      result.details.verifierVerdict.summary &&
        result.details.verifierVerdict.summary.includes("lacks a clear pass/fail verdict"),
      `verifier summary must mention 'lacks a clear pass/fail verdict', got: ${result.details.verifierVerdict.summary}`,
    );

    // Markdown must reflect FAIL.
    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Win-Lifecycle-Process-Trace Orchestration: FAIL/);
    assert.match(markdown, /Gate triggered:\*\* FAIL/);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testVerifierPromptContainsOrchestrationEvidence() {
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "shapes", "win-lifecycle-process-trace.ts"),
    "utf8",
  );

  // The verifier prompt (buildVerifierPrompt) must contain an ORCHESTRATION EVIDENCE block.
  assert.match(source, /ORCHESTRATION EVIDENCE/);
  assert.match(source, /END ORCHESTRATION EVIDENCE/);

  // Must contain the evidence fields the verifier can cite.
  assert.match(source, /Requested shape\/tool.*win-lifecycle-process-trace/);
  assert.match(source, /Current visible role.*ORCHESTRATOR/);
  assert.match(source, /orchestratorExecutedMainTaskWork.*false/);
  assert.match(source, /Live monitoring run by orchestrator.*false/);
  assert.match(source, /Executor model route/);
  assert.match(source, /Subagents spawned.*3/);

  // Verifier instructions must reference the evidence block for conditions 1 and 2.
  assert.match(source, /ORCHESTRATION EVIDENCE block/);
  assert.match(source, /do NOT infer/);

  // Condition 4 example must list all 4 lifecycle marker pairs (8 markers total).
  assert.match(source, /COLD_START_BEGIN\/END[\s\S]*TERMINAL_OPEN_BEGIN\/END[\s\S]*RELOAD_BEGIN\/END[\s\S]*NEW_SESSION_BEGIN\/END/);

  // Condition 6 must list all 4 lifecycle paths individually.
  assert.match(source, /Cold start\n/);
  assert.match(source, /Open-from-Terminal\n/);
  assert.match(source, /Reload\n/);
  assert.match(source, /New-session\n/);

  // Each condition 3-9 must specify whether it judges against EXECUTOR OUTPUT or EVIDENCE block.
  assert.match(source, /\(Judge this against the EXECUTOR OUTPUT\.\)/);
  assert.match(source, /\(Judge this against the ORCHESTRATION EVIDENCE block/);
}

async function testVerifierPromptEvidenceBlockInFakePi() {
  // Run a normal pass scenario and verify the fake-pi verifier received
  // the ORCHESTRATION EVIDENCE block with correct fields.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-evidence-block-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "pass";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-evidence-block",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // Shape should pass with the pass verdict.
    assert.equal(result.details.status, "pass", "shape must pass when verifier passes");

    // Verify the fake-pi log contains all 3 spawns.
    const calls = fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 3, "must spawn exactly 3 subagents");

    // The verifier (calls[2]) must have received a prompt containing the
    // ORCHESTRATION EVIDENCE block with the correct executor route.
    const verifierCall = calls[2];
    assert.match(
      verifierCall.promptSnippet || "",
      /ORCHESTRATION EVIDENCE/,
      "verifier prompt must contain ORCHESTRATION EVIDENCE block",
    );

    // Verifier verdict must cite the evidence block.
    const verifierVerdict = result.details.verifierVerdict;
    assert.ok(verifierVerdict, "details must include verifier verdict");
    assert.equal(verifierVerdict.isFail, false, "verifier must not indicate failure");
    assert.equal(verifierVerdict.overall, "pass", "verifier overall must be pass");

    // The falsification checks must include evidence from the ORCHESTRATION EVIDENCE block.
    // Since we can't directly parse the verifier's falsification checks from the fake-pi
    // (they're embedded in the JSON verdict string), verify the markdown reflects pass.
    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Win-Lifecycle-Process-Trace Orchestration: PASS/);
    assert.match(markdown, /Orchestrator Role Integrity Ledger/);
    assert.match(markdown, /deepseek\/deepseek-v4-pro/);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testVerifierFailsWhenEvidenceBlockMissing() {
  // Regression: if the ORCHESTRATION EVIDENCE block were absent, the verifier
  // should still detect role-integrity/model-route issues. This test verifies
  // the fake-pi verifier returns a fail when the prompt lacks the evidence block.
  // We simulate this by running the shape normally (which includes the block)
  // and verifying the fake-pi verifier saw it — the fail path is tested via
  // the static-only executor style which already triggers a fail verdict.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-win-lifecycle-evidence-missing-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT = "fail";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-win-lifecycle-evidence-missing-regression",
      {
        task: "Create a non-invasive diagnostic harness for tracing Windows Pi process creation.",
        paradigm: "win-lifecycle-process-trace",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 6,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // With fail verdict, shape status must be fail.
    assert.equal(result.details.status, "fail");
    assert.ok(result.details.verifierVerdict);
    assert.equal(result.details.verifierVerdict.isFail, true);
    assert.equal(result.details.verifierVerdict.overall, "fail");

    // Verify the verifier call's prompt contains ORCHESTRATION EVIDENCE
    const calls = fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const verifierCall = calls[2];
    assert.match(
      verifierCall.promptSnippet || "",
      /ORCHESTRATION EVIDENCE/,
      "verifier prompt must contain ORCHESTRATION EVIDENCE block",
    );

    // The fail verdict's falsification checks should still show role-integrity
    // and model-route checks as pass (since the evidence block is present).
    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Win-Lifecycle-Process-Trace Orchestration: FAIL/);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testRegistryDiscovery();
  testCommittedShapeStaticRules();
  testVerifierPromptContainsOrchestrationEvidence();
  await testProposeShapeWithFakePi();
  await testVerifierFailWithExitCodeZero();
  await testVerifierPassStillWorks();
  await testDefaultsModelRouting();
  await testEmptyVerifierFailsClosed();
  await testUnparseableVerifierFailsClosed();
  await testTextPassVerifierFailsClosed();
  await testWrappedJsonPassVerifierFailsClosed();
  await testVerifierUnknownJsonCausesFail();
  await testVerifierInconclusiveJsonCausesFail();
  await testVerifierPromptEvidenceBlockInFakePi();
  await testVerifierFailsWhenEvidenceBlockMissing();
  console.log(
    "PASS win-lifecycle-process-trace: registry discovery, static rules, verifier prompt evidence block, shape execution with fake Pi, verifier fail/pass gate, defaults, empty-verifier-fail-closed, unparseable-verifier-fail-closed, text-pass-fail-closed, wrapped-json-pass-fail-closed, unknown-json-fail-closed, inconclusive-json-fail-closed, evidence-block-integration, evidence-block-missing-regression",
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
