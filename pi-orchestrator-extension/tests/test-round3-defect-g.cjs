#!/usr/bin/env node
/** G only: streamed per-phase logs survive RESULT_LOST_AFTER_MUTATION without enabling retry. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  "fixtures",
  "round3",
  "orc-mtr7ftkd-s8js-checkpoint-0002-infrastructure.json",
), "utf8"));
assert.equal(fixture.checkpoint.outcome, "blocked_infrastructure");
assert.match(fixture.payload.error.message, /RESULT_LOST_AFTER_MUTATION.*retryAllowed=false.*fetch failed/);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "round3-defect-g-"));
const cwd = path.join(home, "workspace");
const runsRoot = path.join(home, "runs");
const worker = path.join(home, "worker.cjs");
const callsFile = path.join(home, "calls.jsonl");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(runsRoot, { recursive: true });
function git(...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}
git("init", "--quiet");
git("config", "user.email", "round3-g@example.invalid");
git("config", "user.name", "Round 3 G Fixture");
fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
git("add", "seed.txt");
git("commit", "--quiet", "-m", "fixture baseline");

fs.writeFileSync(worker, `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const last = args.at(-1) || "";
const prompt = last && last !== args[modelIndex + 1] && !last.startsWith("--")
  ? last
  : (() => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } })();
const promptFile = args[args.indexOf("--append-system-prompt") + 1] || "unknown-system-prompt.txt";
const agentName = path.basename(promptFile).replace(/-system-prompt\\.txt$/, "");
fs.appendFileSync(process.env.G_CALLS_FILE, JSON.stringify({ agentName, prompt: prompt.slice(0, 120) }) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (prompt.includes("Plan the following task")) {
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({
    tasks: [{ id: "task-1", description: "CREATE out.txt with the fixture content.", dependsOn: [] }],
    notes: "G streamed transport fixture",
    predicted_write_set: ["out.txt"],
  }) }], stopReason: "stop" } });
  process.exit(0);
}
if (prompt.includes("You are executing one task from a deterministic orchestration")) {
  fs.writeFileSync(path.join(process.cwd(), "out.txt"), "mutated before transport loss\\n");
  emit({ type: "tool_execution_start", toolName: "write", args: { path: "out.txt" } });
  process.stdout.write(JSON.stringify({ type: "fixture_progress", observed: "mutation completed before socket loss" }) + "\\n");
  process.stderr.write("G_STDERR transport diagnostic before fetch failed\\n");
  emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" },
    stopReason: "error",
    errorMessage: "fetch failed",
  });
  emit({ type: "agent_end" });
  process.exit(0);
}
throw new Error("unexpected fixture phase");
`);

const previous = {
  PI_ORCHESTRATOR_RUNS_ROOT: process.env.PI_ORCHESTRATOR_RUNS_ROOT,
  PI_CLI_PATH: process.env.PI_CLI_PATH,
  PI_NODE_PATH: process.env.PI_NODE_PATH,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  G_CALLS_FILE: process.env.G_CALLS_FILE,
};
process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
process.env.PI_CLI_PATH = worker;
process.env.PI_NODE_PATH = process.execPath;
process.env.PI_CODING_AGENT_DIR = path.join(home, "agents");
process.env.G_CALLS_FILE = callsFile;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fixture: {
      baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture",
      models: [{ id: "round3-g-model", name: "Round 3 G fixture", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1_000 }],
    },
  },
}));
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "round3-g-model" }));

const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const jiti = require(path.join(piModules, "jiti", "lib", "jiti.cjs"))(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const extension = jiti(path.join(ROOT, "src", "index.ts")).default;
let tool;
extension({ registerTool(value) { if (value.name === "orchestrate") tool = value; }, registerCommand() {} });
assert.ok(tool);

const calls = () => fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

(async () => {
  try {
    const result = await tool.execute("G-test", {
      task: "CREATE out.txt with fixture content.",
      paradigm: "plan-execute-verify",
      supervision: "off",
      preflight: false,
      cwd,
      maxRetries: 2,
      plannerProvider: "fixture", plannerModel: "round3-g-model",
      executorProvider: "fixture", executorModel: "round3-g-model",
      verifierProvider: "fixture", verifierModel: "round3-g-model",
      predictedWriteSet: "out.txt",
    }, undefined, () => {}, { cwd });
    assert.equal(result.details.status, "fail", JSON.stringify(result.details));
    assert.equal(result.details.code, "RESULT_LOST_AFTER_MUTATION");
    assert.equal(result.details.retryAllowed, false);
    assert.equal(result.details.verifierSpawned, false);
    assert.equal(result.details.terminalNoRetry.resultLost, true);
    assert.equal(calls().filter((entry) => entry.agentName === "coder").length, 1, "lost mutating result is never retried");
    assert.equal(calls().filter((entry) => entry.agentName === "reviewer").length, 0);

    const runDir = path.join(runsRoot, result.details.terminalNoRetry.runId);
    const logs = fs.readdirSync(runDir).filter((name) => /^phase-.*\.log$/.test(name)).sort();
    assert.ok(logs.some((name) => /planner/.test(name)), JSON.stringify(logs));
    assert.ok(logs.some((name) => /executor/.test(name)), JSON.stringify(logs));
    const executorLogName = logs.find((name) => /executor/.test(name));
    const executorLog = fs.readFileSync(path.join(runDir, executorLogName), "utf8");
    assert.match(executorLog, /\[stdout\].*tool_execution_start.*write/);
    assert.match(executorLog, /\[stdout\].*mutation completed before socket loss/);
    assert.match(executorLog, /\[stdout\].*fetch failed/);
    assert.match(executorLog, /\[stderr\] G_STDERR transport diagnostic before fetch failed/);
    const beforeResumeLog = fs.readFileSync(path.join(runDir, executorLogName));
    const beforeResumeCalls = calls().length;

    const resumed = await tool.execute("G-resume", {
      resume: result.details.terminalNoRetry.runId,
      preflight: false,
      cwd,
    }, undefined, () => {}, { cwd });
    assert.equal(resumed.details.code, "RESULT_LOST_AFTER_MUTATION");
    assert.equal(resumed.details.retryAllowed, false);
    assert.equal(calls().length, beforeResumeCalls, "resume of terminal result-lost state spawns nothing");
    assert.deepEqual(fs.readFileSync(path.join(runDir, executorLogName)), beforeResumeLog, "resume preserves the streamed phase evidence byte-for-byte");
    console.log("test-round3-defect-g: stdout/stderr streamed to phase logs; RESULT_LOST remains no-retry");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
