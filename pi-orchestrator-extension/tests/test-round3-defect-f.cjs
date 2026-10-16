#!/usr/bin/env node
/** F only: real executor-commit fixture + public visible-main commit-aware drift lifecycle. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const realFixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  "fixtures",
  "round3",
  "orc-mtf497by-tw44-checkpoint-0002-executor.json",
), "utf8"));
assert.equal(realFixture.checkpoint.kind, "executor");
assert.equal(realFixture.checkpoint.effectChanges.length, 5);
assert.match(realFixture.payload.output.output, /committed and pushed at ca52c7784cb5a834d2eeb6835f96f690ff3d1381/i);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "round3-defect-f-"));
const worker = path.join(home, "worker.cjs");
const agents = path.join(home, "agents");
fs.mkdirSync(agents, { recursive: true });

function git(cwd, ...args) {
  const result = cp.spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initWorkspace(name) {
  const cwd = path.join(home, name);
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "round3-f@example.invalid");
  git(cwd, "config", "user.name", "Round 3 F Fixture");
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  git(cwd, "add", "seed.txt");
  git(cwd, "commit", "--quiet", "-m", "fixture baseline");
  return cwd;
}

fs.writeFileSync(worker, `
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const assert = require("node:assert/strict");
const root = process.env.PI_ORCHESTRATOR_RUNS_ROOT;
assert.ok(root && path.resolve(root) !== path.resolve(${JSON.stringify(path.join(ROOT, "runs-state"))}));
const states = fs.readdirSync(root)
  .map((id) => path.join(root, id, "supervision.json"))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const state = states.find((candidate) => path.resolve(candidate.mission.cwd) === path.resolve(process.cwd()));
assert.ok(state, "isolated supervision state is visible to fixture worker");
const mode = process.env.F_SCENARIO;
let text;
if (state.status === "plan_checkpoint") {
  text = JSON.stringify({
    acceptance_criteria: ["The requested repository operation settles and is independently verified."],
    tasks: [{
      id: "task-1",
      description: mode === "own" ? "CREATE out.txt and COMMIT the requested change." : "Validate the acknowledged repository state without changing files.",
      depends_on: [],
      expects_file_change: mode === "own",
    }],
    notes: "F commit-aware baseline fixture",
    predicted_write_set: mode === "own" ? ["out.txt"] : [],
  });
} else if (state.status === "executing") {
  if (mode === "own") {
    fs.writeFileSync(path.join(process.cwd(), "out.txt"), "owned executor commit\\n");
    cp.execFileSync("git", ["add", "out.txt"], { cwd: process.cwd(), windowsHide: true });
    cp.execFileSync("git", ["commit", "--quiet", "-m", "executor-owned change"], { cwd: process.cwd(), windowsHide: true });
    text = "PASS: executor created and committed out.txt.";
  } else {
    text = "PASS: validation observed the supervisor-acknowledged external commit.";
  }
} else if (state.status === "verifying") {
  text = JSON.stringify({
    status: "pass",
    reasons: ["Commit-aware boundary remained resumable."],
    criterionFindings: state.mission.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: "pass",
      evidence: [{ kind: "test", observed: "fixture lifecycle passed", exitCode: 0 }],
    })),
  });
} else {
  throw new Error("unexpected supervision status " + state.status);
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
`);

const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
process.env.PI_CLI_PATH = worker;
process.env.PI_NODE_PATH = process.execPath;
process.env.PI_CODING_AGENT_DIR = agents;
Module._initPaths();
const jiti = require(path.join(piModules, "jiti", "lib", "jiti.cjs"))(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const extension = jiti(path.join(ROOT, "src", "index.ts")).default;
let tool;
extension({ registerTool(value) { if (value.name === "orchestrate") tool = value; }, registerCommand() {} });
assert.ok(tool);

const call = (cwd, params) => tool.execute("F-test", params, undefined, () => {}, { cwd });
const stateFor = (runId) => JSON.parse(fs.readFileSync(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, runId, "supervision.json"), "utf8"));

async function ownExecutorCommitReachesVerifier() {
  const cwd = initWorkspace("own");
  process.env.F_SCENARIO = "own";
  const frozen = git(cwd, "rev-parse", "HEAD");
  const planned = await call(cwd, {
    action: "run", supervision: "visible-main", lane: "product", preflight: false, maxRetries: 0,
    cwd, task: "1. Create out.txt, commit the requested change, then verify it.", predictedWriteSet: "out.txt",
  });
  const executed = await call(cwd, { action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken });
  assert.equal(executed.details.status, "awaiting_supervisor", JSON.stringify(executed.details));
  const advanced = git(cwd, "rev-parse", "HEAD");
  assert.notEqual(advanced, frozen, "fixture executor advances HEAD exactly like the real round-3 payload");
  const state = stateFor(planned.details.runId);
  assert.equal(state.runtime.acceptedGitBaseline, advanced, "executor-owned commit becomes the accepted runtime baseline");
  assert.ok(state.runtime.adapterState.baselineTransitions.some((entry) =>
    entry.source === "executor" && entry.from === frozen && entry.to === advanced && entry.paths.includes("out.txt")),
  "executor baseline transition is durable and path-scoped");
  const inspection = await call(cwd, { action: "inspect", runId: planned.details.runId });
  assert.equal(inspection.details.drift.some((flag) => flag.code === "baseline_changed" || flag.code === "content_baseline_changed"), false,
    "the run's own settled commit is expected, not drift");
  const verified = await call(cwd, { action: "continue", runId: planned.details.runId, approvalToken: executed.details.approvalToken });
  assert.equal(verified.details.status, "terminal", JSON.stringify(verified.details));
  assert.equal(verified.details.terminalOutcome, "pass");
}

async function externalCommitIsAdvisoryUntilSupervisorContinue() {
  const cwd = initWorkspace("external");
  process.env.F_SCENARIO = "external";
  const frozen = git(cwd, "rev-parse", "HEAD");
  const planned = await call(cwd, {
    action: "run", supervision: "visible-main", lane: "product", preflight: false, maxRetries: 0,
    cwd, task: "Validate the current repository state without changing files.",
  });
  fs.writeFileSync(path.join(cwd, "external.txt"), "supervisor-visible external commit\n");
  git(cwd, "add", "external.txt");
  git(cwd, "commit", "--quiet", "-m", "external concurrent change");
  const externalHead = git(cwd, "rev-parse", "HEAD");
  assert.notEqual(externalHead, frozen);

  const inspection = await call(cwd, { action: "inspect", runId: planned.details.runId });
  const baselineFlag = inspection.details.drift.find((flag) => flag.code === "baseline_changed");
  const contentFlag = inspection.details.drift.find((flag) => flag.code === "content_baseline_changed");
  assert.ok(baselineFlag && contentFlag, JSON.stringify(inspection.details.drift));
  assert.equal(baselineFlag.blocking, false, "unacknowledged external commit is advisory, never terminal infrastructure");
  assert.equal(contentFlag.blocking, false);
  assert.match(`${baselineFlag.message} ${contentFlag.message}`, /external\.txt/, "advisory names affected paths");

  const executed = await call(cwd, { action: "continue", runId: planned.details.runId, approvalToken: planned.details.approvalToken });
  assert.equal(executed.details.status, "awaiting_supervisor", JSON.stringify(executed.details));
  const state = stateFor(planned.details.runId);
  assert.equal(state.runtime.acceptedGitBaseline, externalHead, "approved continue accepts the observed external commit");
  assert.ok(state.runtime.adapterState.baselineTransitions.some((entry) =>
    entry.source === "supervisor" && entry.from === frozen && entry.to === externalHead && entry.paths.includes("external.txt")),
  "supervisor acknowledgment is durable with affected paths");
  const settledInspection = await call(cwd, { action: "inspect", runId: planned.details.runId });
  assert.equal(settledInspection.details.drift.some((flag) => flag.code === "baseline_changed" || flag.code === "content_baseline_changed"), false);
  const verified = await call(cwd, { action: "continue", runId: planned.details.runId, approvalToken: executed.details.approvalToken });
  assert.equal(verified.details.status, "terminal", JSON.stringify(verified.details));
  assert.equal(verified.details.terminalOutcome, "pass");
}

(async () => {
  try {
    await ownExecutorCommitReachesVerifier();
    await externalCommitIsAdvisoryUntilSupervisorContinue();
    console.log("test-round3-defect-f: executor commits are expected; external commits are path advisories until acknowledged");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
