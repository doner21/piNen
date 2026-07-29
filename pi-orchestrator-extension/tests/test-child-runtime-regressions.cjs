#!/usr/bin/env node
/**
 * Focused deterministic regressions for child-process orchestration runtime defects:
 * - child auto-retry lifecycle clears transient assistant failures;
 * - final unrecovered assistant failures remain terminal;
 * - composable role/phase xN syntax preserves exact requested cardinality;
 * - terminal ambiguous mutation never triggers a middle-phase fallback spawn;
 * - composable aborts explicitly report that the run is non-resumable.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function makeJiti() {
  return createJiti(__filename, { interopDefault: true, moduleCache: false });
}

function writeLifecycleFake(dir) {
  const fakePath = path.join(dir, "fake-child-runtime.cjs");
  fs.writeFileSync(fakePath, `#!/usr/bin/env node
const fs = require("node:fs");
function emit(event) { console.log(JSON.stringify(event)); }
if (process.env.FAKE_PI_LOG) {
  fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ mode: process.env.FAKE_RUNTIME_MODE || "unknown" }) + "\\n", "utf8");
}
const mode = process.env.FAKE_RUNTIME_MODE;
if (mode === "retry-recovered") {
  emit({ type: "message_start" });
  emit({ type: "message_end", message: {
    role: "assistant",
    content: [{ type: "text", text: "transient failed attempt" }],
    stopReason: "error",
    errorMessage: "Connection error."
  }});
  emit({ type: "agent_end", willRetry: true });
  emit({ type: "auto_retry_start", attempt: 1 });
  emit({ type: "message_start" });
  emit({ type: "message_end", message: {
    role: "assistant",
    content: [{ type: "text", text: "recovered final result" }],
    stopReason: "stop"
  }});
  emit({ type: "agent_end" });
  emit({ type: "auto_retry_end", success: true });
  process.exit(0);
}
if (mode === "terminal-unrecovered") {
  emit({ type: "message_start" });
  emit({ type: "message_end", message: {
    role: "assistant",
    content: [{ type: "text", text: "partial terminal result" }],
    stopReason: "error",
    errorMessage: "WebSocket closed 1012."
  }});
  emit({ type: "agent_end" });
  process.exit(0);
}
if (mode === "ambiguous-middle") {
  emit({ type: "message_start" });
  emit({ type: "tool_execution_start", toolName: "write" });
  emit({ type: "tool_execution_end", toolName: "write" });
  emit({ type: "message_end", message: {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "result stream lost after mutation"
  }});
  emit({ type: "agent_end" });
  process.exit(0);
}
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
emit({ type: "agent_end" });
`, "utf8");
  try { fs.chmodSync(fakePath, 0o755); } catch {}
  return fakePath;
}

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({
    registerTool(definition) { if (definition.name === "orchestrate") tool = definition; },
    registerCommand() {},
  });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

async function withFakeRuntime(mode, test) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-runtime-"));
  const fakePath = writeLifecycleFake(tmp);
  const logPath = path.join(tmp, "calls.jsonl");
  const previous = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_RUNTIME_MODE: process.env.FAKE_RUNTIME_MODE,
    FAKE_PI_LOG: process.env.FAKE_PI_LOG,
  };
  process.env.PI_CLI_PATH = fakePath;
  process.env.FAKE_RUNTIME_MODE = mode;
  process.env.FAKE_PI_LOG = logPath;
  try {
    return await test({ tmp, logPath });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testRecoveredRetryLifecycle() {
  await withFakeRuntime("retry-recovered", async ({ tmp }) => {
    const { spawnSubagent } = makeJiti()(path.join(PROJECT_ROOT, "src", "substrate.ts"));
    const progress = [];
    const result = await spawnSubagent("retry-fixture", "exercise child retry lifecycle", {
      agents: new Map(), cwd: tmp, allowLocalModel: false,
      onProgress: (line) => progress.push(line),
    });
    assert.equal(result.text, "recovered final result", "successful retry output must replace the failed attempt");
    assert.deepEqual(result.recoveredAssistantFailures, [
      "assistant stopReason=error",
      "assistant errorMessage=Connection error.",
    ]);
    assert.match(progress.join("\n"), /auto-recovered by child retry/, "recovered transport telemetry must remain visible");
  });
}

async function testTerminalUnrecoveredFailure() {
  await withFakeRuntime("terminal-unrecovered", async ({ tmp }) => {
    const { spawnSubagent } = makeJiti()(path.join(PROJECT_ROOT, "src", "substrate.ts"));
    await assert.rejects(
      () => spawnSubagent("terminal-fixture", "exercise final assistant failure", {
        agents: new Map(), cwd: tmp, allowLocalModel: false,
      }),
      (error) => {
        assert.match(error.message, /reported assistant failure despite exit code 0/);
        assert.match(error.message, /WebSocket closed 1012/);
        return true;
      },
    );
  });
}

function compactPipeline(config) {
  return config.phases.map(({ kind, count }) => [kind, count]);
}

async function testExactPhaseCardinalityParsingAndRuntime() {
  const { parsePipelineConfig } = makeJiti()(
    path.join(PROJECT_ROOT, "src", "shapes", "composable-pipeline.ts"),
  );
  const expected = [["hypothesize", 3], ["critique", 2], ["verify", 2]];
  assert.deepEqual(
    compactPipeline(parsePipelineConfig("hypotheses x3, critiques x2, verify x2")),
    expected,
  );
  assert.deepEqual(
    compactPipeline(parsePipelineConfig("3 hypothesizers, 2 critics, and 2 verifiers")),
    expected,
  );
  assert.deepEqual(
    compactPipeline(parsePipelineConfig("hypothesis ×3, critique ×2, verifier ×2")),
    expected,
  );
  assert.deepEqual(
    compactPipeline(parsePipelineConfig("only hypotheses x3")),
    [["hypothesize", 3]],
    "explicit counts must not activate unrequested or explicitly negated phases",
  );

  await withFakeRuntime("cardinality", async ({ tmp, logPath }) => {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-child-runtime-cardinality",
      {
        task: "hypotheses x3, critiques x2, verify x2",
        paradigm: "composable-pipeline",
        preflight: false,
        cwd: tmp,
        maxSubagents: 10,
      },
      undefined,
      () => {},
      { cwd: tmp },
    );
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(result.details.pipeline.map(({ kind, count }) => [kind, count]), expected);
    assert.equal(result.details.hypotheses.length, 3);
    assert.equal(result.details.critiques.length, 2);
    assert.equal(result.details.voteResult.votes.length, 2);
    assert.equal(result.details.spawnedCount, 7);
    assert.equal(calls.length, 7, "runtime must spawn exactly the requested 3+2+2 agents");
  });
}

async function testNoFallbackAfterAmbiguousMutationAndNonResumableAbort() {
  await withFakeRuntime("ambiguous-middle", async ({ tmp, logPath }) => {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-child-runtime-ambiguous-middle",
      {
        task: "Only hypothesize x1 about the IPC defect.",
        paradigm: "composable-pipeline",
        preflight: false,
        cwd: tmp,
        maxSubagents: 4,
      },
      undefined,
      () => {},
      { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    assert.equal(calls.length, 1, "terminal ambiguous mutation must not launch the generic fallback child");
    assert.equal(result.details.aborted, true);
    assert.equal(result.details.code, "RESULT_LOST_AFTER_MUTATION");
    assert.equal(result.details.retryAllowed, false);
    assert.match(result.details.terminalNoRetry.errorMessage, /result stream lost after mutation/);
    assert.equal(result.details.resumeSupported, false);
    assert.equal(result.details.resumable, false);
    assert.equal(result.details.resumeHint.runIdPurpose, "diagnostic-only");
    assert.match(result.details.resumeHint.reason, /does not persist RunStateStore checkpoints/);
    assert.match(result.content[0].text, /composable-pipeline run is non-resumable/);

    const resumeDescription = tool.parameters?.properties?.resume?.description || "";
    assert.match(resumeDescription, /Supported paradigms:/);
    assert.doesNotMatch(resumeDescription, /Supported paradigms:[^.]*composable-pipeline/);
  });
}

async function main() {
  await testRecoveredRetryLifecycle();
  console.log("ok - recovered child retry lifecycle is non-terminal with telemetry");
  await testTerminalUnrecoveredFailure();
  console.log("ok - final unrecovered assistant failure remains terminal");
  await testExactPhaseCardinalityParsingAndRuntime();
  console.log("ok - composable xN/×N parsing and runtime cardinality are exact");
  await testNoFallbackAfterAmbiguousMutationAndNonResumableAbort();
  console.log("ok - ambiguous mutation suppresses fallback and reports non-resumable abort");
  console.log("test-child-runtime-regressions: ALL PASS");
}

main().catch((error) => {
  console.error("test-child-runtime-regressions: FAIL");
  console.error(error);
  process.exit(1);
});
