#!/usr/bin/env node
/** AK1: task numeric targets cannot disappear into prose-only verification. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const orchestrator = jiti(path.join(ROOT, "src", "index.ts"));
const supervision = jiti(path.join(ROOT, "src", "supervision.ts"));

const extracted = orchestrator.extractNumericAcceptanceTargets(`
RUN ACCEPTANCE:
program-changing settle <= 12 s; open < 10000 ms; data-only >= 0.5 s;
burst success settlements == 1; test survivors != 2; quality > 99 %; live transition frames == 96000.
Historical inventory: 352 passed, 42 skipped, 0 failed on 2026-09-10 at 13:50.
Commit b0e28cb67cf3201835318f507ad245feacbc2e74; defect AK1; route gpt-5.6-sol.
Release date >= 2026. Hash == 64. Defect AK >= 1. Route gpt >= 5.6.
Example: demo latency <= 1 ms. For example, sample count == 7.
`);
assert.deepEqual(extracted.map(({ metric, op, threshold, unit }) => ({ metric, op, threshold, unit })), [
  { metric: "program-changing settle", op: "<=", threshold: 12, unit: "s" },
  { metric: "open", op: "<", threshold: 10000, unit: "ms" },
  { metric: "data-only", op: ">=", threshold: 0.5, unit: "s" },
  { metric: "burst success settlements", op: "==", threshold: 1, unit: "count" },
  { metric: "test survivors", op: "!=", threshold: 2, unit: "count" },
  { metric: "quality", op: ">", threshold: 99, unit: "%" },
  { metric: "live transition frames", op: "==", threshold: 96000, unit: "frames" },
], "operators, thresholds, and units are retained while dates, hashes, labels, routes, examples, and inventory are ignored");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak1-"));
const previousRunsRoot = process.env.PI_ORCHESTRATOR_RUNS_ROOT;
try {
  fs.writeFileSync(path.join(home, "metrics.json"), JSON.stringify({ boundaryMs: 1000, missing: null, infinite: "Infinity" }) + "\n");
  fs.writeFileSync(path.join(home, "metrics.txt"), "duration_s=1\n");
  const base = {
    originalTask: "Settle at or below one second.",
    cwd: home,
    worktree: { root: home, realRoot: fs.realpathSync.native(home), branch: "main", baseline: "fixture" },
    paradigm: "plan-execute-verify",
    lane: "product",
    routes: [], constraints: [], nonGoals: [],
  };
  const target = { metric: "settle", op: "<=", threshold: 1, unit: "s", sourceText: "settle <= 1 s" };

  assert.throws(() => supervision.createFrozenMission({
    ...base,
    acceptanceCriteria: [{ id: "AC-01", text: "settle <= 1 s", required: true, numericTarget: target }],
  }), /numeric target.*prose-only|mechanical evaluation.*explanation/i,
  "a target may not silently retain only prose coverage");

  const unavailable = supervision.createFrozenMission({
    ...base,
    acceptanceCriteria: [{
      id: "AC-01", text: "settle <= 1 s", required: true, numericTarget: target,
      numericEvaluationUnavailable: { code: "missing_evidence_selector", reason: "No persisted source selector was supplied; inventing a file is forbidden." },
    }],
  });
  assert.equal(unavailable.acceptanceCriteria[0].numericEvaluationUnavailable.code, "missing_evidence_selector");
  assert.equal(supervision.numericTargetCoverageIssues(unavailable)[0].code, "numeric_evaluation_unavailable");

  const jsonBoundary = supervision.createFrozenMission({
    ...base,
    acceptanceCriteria: [{
      id: "AC-01", text: "settle <= 1 s", required: true, numericTarget: target,
      numericGate: { metric: "settle ms", source: { path: "metrics.json", jsonPointer: "/boundaryMs" }, op: "<=", threshold: 1000 },
    }],
  });
  assert.equal(supervision.evaluateNumericAcceptanceGates(jsonBoundary)[0].status, "pass", "boundary equality passes after s/ms normalization");

  const regexMiss = supervision.createFrozenMission({
    ...base,
    acceptanceCriteria: [{
      id: "AC-01", text: "settle < 1 s", required: true,
      numericTarget: { ...target, op: "<", sourceText: "settle < 1 s" },
      numericGate: { metric: "settle seconds", unit: "s", source: { path: "metrics.txt", regex: "duration_s=([0-9.]+)" }, op: "<", threshold: 1 },
    }],
  });
  assert.equal(supervision.evaluateNumericAcceptanceGates(regexMiss)[0].status, "fail", "host evidence overrides verifier prose on a strict-boundary miss");

  for (const selector of ["/missing", "/infinite"]) {
    const mission = supervision.createFrozenMission({
      ...base,
      acceptanceCriteria: [{
        id: "AC-01", text: "settle <= 1 s", required: true, numericTarget: target,
        numericGate: { metric: "settle", unit: "s", source: { path: "metrics.json", jsonPointer: selector }, op: "<=", threshold: 1 },
      }],
    });
    const finding = supervision.evaluateNumericAcceptanceGates(mission)[0];
    assert.equal(finding.status, "fail");
    assert.equal(finding.observedValue, null, `${selector} cannot fabricate finite evidence`);
  }

  assert.throws(() => supervision.createFrozenMission({
    ...base,
    acceptanceCriteria: [{
      id: "AC-01", text: "settle <= 1 s", required: true, numericTarget: target,
      numericGate: { metric: "settle", unit: "s", source: { path: "metrics.json", jsonPointer: "/boundaryMs" }, op: "<", threshold: 1 },
    }],
  }), /does not match.*target/i, "operator mismatches fail closed");

  const criteria = orchestrator.buildNumericAwareAcceptanceCriteria(
    "Measure the release. Targets: program settle <= 12 s; survivors == 0. Example: demo <= 2 ms.",
    [],
  );
  assert.equal(criteria.filter((criterion) => criterion.numericTarget).length, 2);
  assert.ok(criteria.filter((criterion) => criterion.numericTarget).every((criterion) => criterion.numericEvaluationUnavailable?.code === "missing_evidence_selector"),
    "normalization persists why no mechanical gate exists instead of losing targets in prose");
  assert.ok(criteria.some((criterion) => criterion.numericTarget?.metric === "program settle"));
  assert.ok(criteria.some((criterion) => criterion.numericTarget?.metric === "survivors"));
  assert.equal(criteria.some((criterion) => /demo/i.test(criterion.numericTarget?.metric ?? "")), false, "examples do not become numeric product criteria");

  const persistedMission = supervision.createFrozenMission({
    ...base,
    originalTask: "Measure the release. Targets: program settle <= 12 s; survivors == 0.",
    acceptanceCriteria: criteria,
  });
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = path.join(home, "runs");
  const store = new supervision.SupervisionStateStore("orc-round7-ak1-persistence");
  let state = supervision.createInitialSupervisionState({ runId: "orc-round7-ak1-persistence", mission: persistedMission, tasks: [] });
  store.create(state);
  state = store.appendCheckpoint(state, {
    kind: "plan", createdAt: new Date().toISOString(), missionHash: persistedMission.missionHash,
    criteria: persistedMission.acceptanceCriteria.map((criterion) => criterion.id), effectChanges: [], outcome: "plan_ready",
  }, {
    numericTargetCoverage: persistedMission.acceptanceCriteria.filter((criterion) => criterion.numericTarget).map((criterion) => ({
      criterionId: criterion.id, target: criterion.numericTarget,
      evaluation: { kind: "unavailable", ...criterion.numericEvaluationUnavailable },
    })),
  });
  store.save(state);
  const durable = JSON.parse(fs.readFileSync(store.stateFile, "utf8"));
  assert.equal(durable.mission.acceptanceCriteria.filter((criterion) => criterion.numericEvaluationUnavailable).length, 2,
    "supervision.json durably explains every target that lacks a mechanical selector");
  const checkpointPayload = JSON.parse(fs.readFileSync(state.checkpoints.at(-1).payloadFile, "utf8"));
  assert.equal(checkpointPayload.payload.numericTargetCoverage.length, 2, "the plan checkpoint exposes target coverage for inspection");

  console.log("test-round7-defect-ak1: numeric targets are frozen with gates or explicit unavailability; host misses remain hard");
} finally {
  previousRunsRoot === undefined ? delete process.env.PI_ORCHESTRATOR_RUNS_ROOT : process.env.PI_ORCHESTRATOR_RUNS_ROOT = previousRunsRoot;
  fs.rmSync(home, { recursive: true, force: true });
}
