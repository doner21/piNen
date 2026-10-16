#!/usr/bin/env node
/** J only: a complete host-owned phase result survives a later transport error; incomplete mutation remains no-retry. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const historical = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  "fixtures",
  "round3",
  "orc-mtrd364s-it26-checkpoint-0002-infrastructure.json",
), "utf8"));
assert.equal(historical.checkpoint.outcome, "blocked_infrastructure");
assert.match(historical.payload.error.message, /RESULT_LOST_AFTER_MUTATION.*retryAllowed=false.*WebSocket error/);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "round3-defect-j-"));
const runsRoot = path.join(home, "runs");
const agents = path.join(home, "agents");
const worker = path.join(home, "worker.cjs");
const directWorker = path.join(home, "direct-worker.cjs");
const callsFile = path.join(home, "calls.jsonl");
fs.mkdirSync(runsRoot, { recursive: true });
fs.mkdirSync(agents, { recursive: true });

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}
function workspace(name) {
  const cwd = path.join(home, name);
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "round3-j@example.invalid");
  git(cwd, "config", "user.name", "Round 3 J Fixture");
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  git(cwd, "add", "seed.txt");
  git(cwd, "commit", "--quiet", "-m", "fixture baseline");
  return cwd;
}

fs.writeFileSync(directWorker, `
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "tool_execution_start", toolName: "write", args: { path: "direct.txt" } });
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PASS: direct substrate result." }], stopReason: "stop" } });
emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" }, stopReason: "error", errorMessage: "fetch failed" });
emit({ type: "agent_end" });
`);

fs.writeFileSync(worker, `
const fs = require("node:fs");
const path = require("node:path");
const states = fs.readdirSync(process.env.PI_ORCHESTRATOR_RUNS_ROOT)
  .map((id) => path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, id, "supervision.json"))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const state = states.find((candidate) => path.resolve(candidate.mission.cwd) === path.resolve(process.cwd()));
if (!state) throw new Error("fixture supervision state missing");
fs.appendFileSync(process.env.J_CALLS_FILE, JSON.stringify({ runId: state.runId, status: state.status }) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let text;
if (state.status === "plan_checkpoint") {
  text = JSON.stringify({
    acceptance_criteria: ["The requested file exists with the fixture content."],
    tasks: [{ id: "task-1", description: "CREATE out.txt with the fixture content.", depends_on: [], expects_file_change: true }],
    notes: "J durable phase-result fixture",
    predicted_write_set: ["out.txt"],
  });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
} else if (state.status === "executing") {
  fs.writeFileSync(path.join(process.cwd(), "out.txt"), "J fixture\\n");
  emit({ type: "tool_execution_start", toolName: "write", args: { path: "out.txt" } });
  if (process.env.J_SCENARIO === "complete") {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PASS: created out.txt with J fixture content." }], stopReason: "stop" } });
  }
  emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "WebSocket error" },
    stopReason: "error",
    errorMessage: "WebSocket error",
  });
  emit({ type: "agent_end" });
} else if (state.status === "verifying") {
  text = JSON.stringify({
    status: "pass",
    reasons: ["Durable executor result was recovered without a duplicate spawn."],
    criterionFindings: state.mission.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: "pass",
      evidence: [{ kind: "test", observed: "out.txt contains J fixture", exitCode: 0 }],
    })),
  });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
} else {
  throw new Error("unexpected fixture state " + state.status);
}
`);

const previous = {
  PI_ORCHESTRATOR_RUNS_ROOT: process.env.PI_ORCHESTRATOR_RUNS_ROOT,
  PI_CLI_PATH: process.env.PI_CLI_PATH,
  PI_NODE_PATH: process.env.PI_NODE_PATH,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  J_CALLS_FILE: process.env.J_CALLS_FILE,
  J_SCENARIO: process.env.J_SCENARIO,
};
process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
process.env.PI_CLI_PATH = worker;
process.env.PI_NODE_PATH = process.execPath;
process.env.PI_CODING_AGENT_DIR = agents;
process.env.J_CALLS_FILE = callsFile;
const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const jiti = require(path.join(piModules, "jiti", "lib", "jiti.cjs"))(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const extension = jiti(path.join(ROOT, "src", "index.ts")).default;
const substrate = jiti(path.join(ROOT, "src", "substrate.ts"));
let tool;
extension({ registerTool(value) { if (value.name === "orchestrate") tool = value; }, registerCommand() {} });
assert.ok(tool);
const call = (cwd, params) => tool.execute("J-test", params, undefined, () => {}, { cwd });
const calls = () => fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];

async function plannedRun(cwd) {
  return call(cwd, {
    action: "run",
    supervision: "visible-main",
    preflight: false,
    maxRetries: 0,
    cwd,
    task: "Create out.txt with J fixture content, then verify it.",
    predictedWriteSet: "out.txt",
  });
}

(async () => {
  try {
    process.env.J_SCENARIO = "complete";
    const completeCwd = workspace("complete");
    const planned = await plannedRun(completeCwd);
    const executed = await call(completeCwd, { action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken });
    assert.equal(executed.details.status, "awaiting_supervisor", JSON.stringify(executed.details));
    assert.match(executed.details.executor.output, /PASS: created out\.txt/);
    assert.equal(calls().filter((entry) => entry.runId === planned.details.runId && entry.status === "executing").length, 1, "complete result is not respawned");
    const runDir = path.join(runsRoot, planned.details.runId);
    const executorResultName = fs.readdirSync(runDir).find((name) => /^phase-\d+-supervised-task-1\.result\.json$/.test(name));
    assert.ok(executorResultName, `missing executor phase result in ${JSON.stringify(fs.readdirSync(runDir))}`);
    const publication = JSON.parse(fs.readFileSync(path.join(runDir, executorResultName), "utf8"));
    assert.equal(publication.schemaVersion, 1);
    assert.equal(publication.kind, "subagent-phase-result");
    assert.equal(publication.status, "complete");
    assert.ok(publication.heartbeatSequence >= 3, JSON.stringify(publication));
    assert.match(publication.result.text, /PASS: created out\.txt/);
    assert.equal(publication.result.exitCode, 0);
    assert.ok(!fs.readdirSync(runDir).some((name) => name.startsWith("terminal-no-retry-")), "recovered result is a normal settlement");
    const verified = await call(completeCwd, { action: "continue", runId: planned.details.runId, approvalToken: executed.details.approvalToken });
    assert.equal(verified.details.status, "terminal", JSON.stringify(verified.details));
    assert.equal(verified.details.terminalOutcome, "pass");

    process.env.J_SCENARIO = "incomplete";
    const incompleteCwd = workspace("incomplete");
    const incompletePlan = await plannedRun(incompleteCwd);
    const incomplete = await call(incompleteCwd, { action: "continue", runId: incompletePlan.details.runId, approvalToken: incompletePlan.details.approvalToken });
    assert.equal(incomplete.details.status, "blocked_infrastructure", JSON.stringify(incomplete.details));
    assert.match(incomplete.details.error.message, /RESULT_LOST_AFTER_MUTATION.*retryAllowed=false.*WebSocket error/);
    assert.equal(calls().filter((entry) => entry.runId === incompletePlan.details.runId && entry.status === "executing").length, 1, "incomplete mutating loss is never retried");
    assert.equal(calls().filter((entry) => entry.runId === incompletePlan.details.runId && entry.status === "verifying").length, 0);
    const incompleteDir = path.join(runsRoot, incompletePlan.details.runId);
    const incompleteName = fs.readdirSync(incompleteDir).find((name) => /^phase-\d+-supervised-task-1\.result\.json$/.test(name));
    assert.ok(incompleteName);
    const incompletePublication = JSON.parse(fs.readFileSync(path.join(incompleteDir, incompleteName), "utf8"));
    assert.equal(incompletePublication.status, "incomplete");
    assert.equal("result" in incompletePublication, false);

    process.env.PI_CLI_PATH = directWorker;
    const directDir = path.join(runsRoot, "direct-substrate");
    fs.mkdirSync(directDir, { recursive: true });
    const directResultFile = path.join(directDir, "phase-0-direct.result.json");
    const direct = await substrate.spawnSubagent("coder", "direct substrate transport fixture", {
      agents: new Map([["coder", { name: "coder" }]]),
      cwd: completeCwd,
      allowLocalModel: false,
      phaseMutates: true,
      phaseLogFile: path.join(directDir, "phase-0-direct.log"),
      phaseResultFile: directResultFile,
    });
    assert.match(direct.text, /PASS: direct substrate result/);
    assert.equal(JSON.parse(fs.readFileSync(directResultFile, "utf8")).status, "complete");
    console.log("test-round3-defect-j: complete inline/substrate sidecars recovered; incomplete mutation remains terminal no-retry");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
