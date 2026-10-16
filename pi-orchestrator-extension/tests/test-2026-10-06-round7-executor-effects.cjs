#!/usr/bin/env node
"use strict";
/** Exercise complete private production task/lifecycle functions via AST
 * extraction. Only launch, approval/store I/O, and git observation boundaries
 * are injected; effect capture/diff, task results and failure catch are real.
 * Inline fixtures keep this file copyable to ac26579 with no extra test files.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const ROOT = path.resolve(__dirname, "..");
// Reviewers can point this unchanged regression at an archived baseline src/.
// Dependencies and owned runtime roots remain those of this isolated test.
const SOURCE_ROOT = process.env.ROUND7_BASELINE_SOURCE_ROOT ? path.resolve(process.env.ROUND7_BASELINE_SOURCE_ROOT) : ROOT;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "orch-r7-effects-"));
for (const [key, dir] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_ORCHESTRATOR_RUNS_ROOT: "runs", PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next" })) {
  process.env[key] = path.join(SCRATCH, dir); fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = SCRATCH;
process.env.PI_OFFLINE = "1";
const ts = require(path.join(ROOT, "node_modules/typescript"));
const PI_MODULES = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter); Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti/lib/jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const timing = fs.existsSync(path.join(SOURCE_ROOT, "src/command-times.ts")) ? jiti(path.join(SOURCE_ROOT, "src/command-times.ts")) : {};
const signatures = jiti(path.join(SOURCE_ROOT, "src/write-set.ts"));
const supervision = jiti(path.join(SOURCE_ROOT, "src/supervision.ts"));
const NOW = Date.parse("2026-10-06T12:00:00Z");
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
function compile(relative, names, dependencies) {
  const file = path.join(SOURCE_ROOT, relative), text = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const source = names.map(name => {
    const node = ast.statements.find(item => item.name?.text === name);
    assert.ok(node, `baseline production function exists: ${relative}:${name}`);
    return node.getText(ast).replace(/^export\s+/, "");
  }).join("\n");
  const context = vm.createContext({ Error, Date: Clock, path, fs, os, process, Buffer, console, structuredClone,
    ...signatures, ...timing, getCommandTimesForRun: runId => timing.readRunCommandTimes?.(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, runId)), ...dependencies });
  const js = ts.transpileModule(source + `\nglobalThis.api = { ${names.join(",")} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(js, context, { filename: relative }); return context.api;
}
const failures = [];
async function check(id, body) {
  try { await body(); console.log(`PASS ${id}`); }
  catch (error) { failures.push({ id, error: error.message }); console.log(`RED ${id}: ${error.message}`); }
}
function workspace(id) {
  const cwd = path.join(SCRATCH, id); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "pre-existing tracked dirt");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "pre-existing untracked dirt");
  return cwd;
}
const toolCalls = { total: 1, mutating: 1, byTool: { write: 1 } };
const budget = { saturationPercent: 1, risk: "low", recommendation: "NORMAL" };
function result(exitCode = 0) { return { agentName: "coder", task: "fixture", text: "candidate", exitCode, durationMs: 0, toolCalls, events: 1 }; }
async function taskEffects(relative, id, mutate, expected, options = {}) {
  const cwd = workspace(id); let afterDispatch = false;
  const task = { id: "task-1", description: "Implement a file change.", dependsOn: [], expectsFileChange: true };
  const dependencies = {
    spawnSync(_command, args) {
      assert.equal(_command, "git", "no actual process launches");
      if (options.unavailable && afterDispatch) return { status: 1, stdout: "", stderr: "injected git unavailable" };
      // Stable status text despite byte mutations is the causal baseline defect.
      const lines = [];
      if (fs.existsSync(path.join(cwd, "untracked.txt"))) lines.push("?? untracked.txt");
      if (fs.existsSync(path.join(cwd, "tracked.txt"))) lines.push(" M tracked.txt");
      if (fs.existsSync(path.join(cwd, "created.txt"))) lines.push("?? created.txt");
      return { status: 0, stdout: lines.join("\n") + "\n", stderr: "" };
    },
    captureContentSignatureSnapshot(root, limits) {
      if (options.unavailable && afterDispatch) throw new Error("injected content observation unavailable");
      const captured = signatures.captureContentSignatureSnapshot(root, limits);
      if (options.partial && afterDispatch) {
        delete captured.files["untracked.txt"];
        captured.truncated = true;
        captured.omitted.push({ path: "untracked.txt", reason: "file-byte-limit" });
      }
      return captured;
    },
    buildExecutorPrompt: () => "fixture prompt", buildSubagentSystemPrompt: () => "fixture system",
    resolveCompleteWorkerLaunchPrompt: async () => ({ provider: "owner", model: "owner", systemPrompt: "fixture", toolSchemas: [] }),
    assertWorkerPromptFitsCapacity: () => budget, estimateExecutorContextBudget: () => budget,
    toModelOverride: () => undefined, resolveTaskAgent: () => "coder", inferredRuntimeModelForTask: () => undefined,
    mergeModelOverrides: () => undefined,
    async spawnChecked() { mutate(cwd); afterDispatch = true; return result(options.exitCode ?? 0); },
    checkContextExhaustion: () => false, formatToolCallSummary: () => "1 write",
    parseExecutorOutputSuffix: () => undefined, classifyTaskOutputType: () => "file_change", hasFileClaimsInProse: () => true,
    emptyToolCallSummary: () => ({ total: 0, mutating: 0, byName: {} }),
    SubagentDetachedError: class extends Error {}, SubagentTerminalAmbiguousError: class extends Error {}, ConfirmedSupervisedAbandonError: class extends Error {},
  };
  const shape = relative.includes("shapes/");
  const names = shape
    ? ["capturePreExecutionGitSnapshot", "computePostExecutionDiff", "buildGitDiffForcingBlock", "executeExecutorTaskWithRecovery", "isImplementationTask"]
    : ["captureGitStatusEntries", "diffGitStatusEntries", "executeExecutorTaskWithRecovery", "buildTaskEffectEvidenceMap", "isImplementationTask"];
  const api = compile(relative, names, dependencies);
  const output = await api.executeExecutorTaskWithRecovery({ taskLedger: new Map(), intake: {}, spawnedCount: 0, maxRecoveryDepth: 0, spawnGuard: { wouldFit: () => true } },
    { cwd, executorAgent: "coder", maxSubagents: 10 }, new Map(), task, { tasks: [task], notes: "fixture" }, undefined, () => {}, undefined, {});
  assert.equal(output.exitCode, options.exitCode ?? 0, "effect observation must never turn a failed executor into PASS");
  if (options.unavailable || (options.partial && !expected.length)) {
    assert.ok(output.filesChanged === undefined || output.filesChanged === null || /unknown|unobservable|unavailable/i.test(JSON.stringify(output.effectObservation)),
      "unavailable post snapshot must not become proven zero changes");
  } else {
    assert.deepEqual(Array.from(output.changedFiles ?? []).sort(), expected.slice().sort(), "actual task output must include byte changes on already-dirty paths and exclude unchanged dirt");
    assert.equal(output.filesChanged, expected.length);
    if (!shape) assert.equal(api.buildTaskEffectEvidenceMap([output]).get(task.id).filesChanged, expected.length, "downstream effect consumer retains actual change count");
    if (options.partial) assert.equal(output.effectObservation.status, "partial", "positive partial effects are lower bounds");
  }
}
async function lifecycleEffects(id, options) {
  const cwd = workspace(id), stateFile = path.join(cwd, "supervision.json"), checkpointFile = path.join(cwd, "checkpoint.json");
  const before = signatures.captureContentSignatureSnapshot(cwd);
  const task = { id: "task-1", description: "Implement candidate", dependsOn: [], criteria: ["AC-1"], expectsFileChange: true };
  const runtime = { kind: "generic-shape", params: { adaptiveSupervision: "off" }, intake: {},
    plan: { tasks: [task], notes: "fixture", predictedWriteSet: ["tracked.txt"] }, contentBaseline: before,
    cursor: { stage: "executor-task", nextTaskIndex: 0, completedTaskIds: [] }, executorOutputs: [], hostInstanceId: "fixture-host" };
  let state = { runId: id, mode: "visible-main", status: "awaiting_supervisor", lane: "orchestrator-maintenance", tasks: [task], currentApproval: {}, checkpoints: [{ id: "initial", kind: "plan", effectChanges: [] }], completedCriteria: [],
    mission: { originalTask: "fixture", cwd, worktree: {}, missionHash: "a".repeat(64), acceptanceCriteria: [{ id: "AC-1", required: true }], externalEvidenceRoots: [path.join(SCRATCH, "evidence-only")] },
    audit: { infrastructureFailures: [], activeWorkers: [], detachedWorkers: [] }, runtime };
  const save = value => { state = value; fs.writeFileSync(stateFile, JSON.stringify(value)); };
  // This file is host state, not executor workspace content. Capture is scoped
  // to the candidate files below, so mock store publications cannot count as work.
  save(state);
  let recorded;
  const store = {
    stateFile,
    loadGenericCompatibleReadOnly: () => ({ state, migrated: false }),
    consumeApprovalForDispatch: () => ({ state, approvalConsumption: { fixture: true } }), save,
    appendCheckpoint(value, checkpoint, payload) {
      recorded = { checkpoint: { id: "observed", ...checkpoint }, payload };
      fs.writeFileSync(checkpointFile, JSON.stringify(recorded));
      value.checkpoints.push(recorded.checkpoint); save(value); return value;
    },
  };
  const snapshot = () => {
    const captured = signatures.captureContentSignatureSnapshot(cwd);
    for (const file of ["supervision.json", "checkpoint.json"]) delete captured.files[file];
    return captured;
  };
  runtime.contentBaseline = snapshot(); save(state);
  let dispatched = false;
  const dependencies = {
    SupervisionStateStore: class { constructor() { return store; } }, readFileSync: fs.readFileSync,
    SUPERVISION_HOST_INSTANCE: "fixture-host", normalizePublicAdaptiveSupervisionMode: () => "off",
    requireGenericRuntime: value => value.runtime,
    currentMissionBoundary: () => ({ flags: [] }), acknowledgeSupervisorBoundary() {},
    normalizeParams: () => ({ cwd, adaptiveSupervision: "off" }), loadAgents: async () => new Map(), resolveConfiguredRoleDefaults() {}, lifecycleState: () => ({}),
    acceptedRuntimeGitBaseline: () => "fixture-head",
    transitionSupervisionState(value, status) { value.status = status; return value; },
    updateGenericCursor(value, update) { Object.assign(value.runtime.cursor, update); },
    async executeOneSupervisedTask() {
      dispatched = true;
      if (options.mutate) fs.writeFileSync(path.join(cwd, "tracked.txt"), "real executor mutation");
      const effectChanges = options.outputObserved ? signatures.diffContentSignatureSnapshots(runtime.contentBaseline, snapshot()) : undefined;
      if (options.revert) fs.writeFileSync(path.join(cwd, "tracked.txt"), "pre-existing tracked dirt");
      return { taskId: task.id, description: task.description, output: "candidate", exitCode: options.exitCode ?? 0, toolCalls,
        ...(effectChanges ? { effectChanges, changedFiles: effectChanges.map(change => change.path), filesChanged: effectChanges.length } : {}),
        ...(options.outputPartial ? { effectObservation: { status: "partial" } } : {}) };
    },
    captureContentSignatureSnapshot() {
      if (dispatched && options.contentUnavailable) throw new Error("CONTENT_OBSERVATION_UNAVAILABLE");
      const captured = snapshot();
      if (dispatched && options.partial) {
        const omittedPath = options.omitTracked ? "tracked.txt" : "untracked.txt";
        delete captured.files[omittedPath];
        captured.truncated = true;
        captured.omitted.push({ path: omittedPath, reason: "file-byte-limit" });
      }
      return captured;
    },
    captureExternalEvidenceSnapshot() { if (options.throwEvidence) throw new Error("EXTERNAL_EVIDENCE_OBSERVATION_FAILED"); return { roots: ["fixture"], files: {}, unobservableRoots: ["fixture"] }; },
    diffExternalEvidenceSnapshots: signatures.diffExternalEvidenceSnapshots,
    classifyInfrastructureFailure: supervision.classifyInfrastructureFailure,
    ConfirmedSupervisedAbandonError: class extends Error {}, SubagentDetachedError: class extends Error {},
    issueCheckpointApproval: (_store, value) => ({ state: value, token: "fixture" }),
    lifecycleResult: (value, token, extra) => ({ status: value.status, completedCriteria: value.completedCriteria, ...extra }),
  };
  const api = compile("src/index.ts", ["runVisibleMainLifecycle"], dependencies);
  const output = await api.runVisibleMainLifecycle({ runId: id, approvalToken: "fixture" }, "continue");
  assert.ok(dispatched, "actual lifecycle must reach injected executor");
  assert.ok(recorded, "actual failure catch must append a checkpoint");
  const persisted = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
  assert.notEqual(persisted.checkpoint.outcome, "pass", "unobservable evidence stays failed");
  assert.deepEqual(output.completedCriteria, [], "failure must not advance frozen acceptance");
  assert.deepEqual(runtime.cursor.completedTaskIds, [], "failure must not complete the task");
  assert.match(persisted.payload.error.message, /EXTERNAL_EVIDENCE|CONTENT_OBSERVATION_UNAVAILABLE/);
  assert.equal(runtime.executorOutputs.length, 1, "failure keeps the settled executor output, not just an error");
  assert.equal(persisted.payload.output.exitCode, options.exitCode ?? 0, "raw worker outcome remains truthful");
  if (options.contentUnavailable && !options.outputObserved) {
    assert.equal(persisted.payload.output.filesChanged, undefined, "unknown content must not persist zero task effects");
    assert.ok(persisted.checkpoint.effectChanges == null || /unknown|unobservable|unavailable/i.test(JSON.stringify(persisted.checkpoint.effectObservation)),
      "unavailable workspace observation cannot publish effectChanges: [] as proven zero");
  } else {
    assert.deepEqual((persisted.checkpoint.effectChanges ?? []).map(change => change.path), options.mutate ? ["tracked.txt"] : [],
      "failure checkpoint retains observed executor bytes even after external evidence fails");
    if (options.mutate) assert.equal(persisted.checkpoint.effectChanges[0].kind, "modified");
    assert.equal(persisted.payload.output.filesChanged, options.mutate ? 1 : options.partial ? undefined : 0);
    if (options.partial || options.contentUnavailable || options.outputPartial) assert.equal(persisted.checkpoint.effectObservation.status, "partial");
  }
}
async function aggregateEffects(relative) {
  const shape = relative.includes("shapes/");
  const names = shape ? ["mergeExecutorOutputs"] : ["mergeExecutorOutputs", "sumToolCallSummaries"];
  const api = compile(relative, names, { mergeActionEvidenceLedgers: () => undefined });
  const zero = { taskId: "task-1", description: "Implement", output: "", exitCode: 1, durationMs: 0, filesChanged: 0, changedFiles: [], effectObservation: { status: "complete" } };
  const unknown = { ...zero, filesChanged: undefined, changedFiles: undefined, effectObservation: { status: "unknown" } };
  const positive = { ...zero, filesChanged: 1, changedFiles: ["tracked.txt"] };
  assert.equal(api.mergeExecutorOutputs(zero, unknown).filesChanged, undefined, "unknown plus known zero is not proven zero");
  const partialZero = { ...zero, effectObservation: { status: "partial" } };
  assert.equal(api.mergeExecutorOutputs(zero, partialZero).filesChanged, undefined, "a partial zero lower bound cannot become a complete zero count");
  const retained = api.mergeExecutorOutputs(positive, unknown);
  assert.equal(retained.filesChanged, 1, "positive effects survive merging with unavailable evidence");
  assert.equal(retained.exitCode, 1, "effect merging cannot manufacture PASS");
  assert.notEqual(retained.effectObservation.status, "complete");
}
async function recoveryEffects(relative, mode, splitOutcome) {
  const shape = relative.includes("shapes/");
  const cwd = workspace(`${shape ? "shape" : "legacy"}-recovery-${mode}`);
  const task = { id: "task-1", description: "Implement a file change.", dependsOn: [], expectsFileChange: true };
  let launches = 0, unavailable = false;
  const deps = {
    spawnSync: () => ({ status: 0, stdout: " M tracked.txt\n?? untracked.txt\n" }),
    captureContentSignatureSnapshot(root) {
      if (unavailable) throw new Error("continuation content unavailable");
      const snapshot = signatures.captureContentSignatureSnapshot(root);
      if ((mode === "partial" && launches >= 2) || (splitOutcome === "partial" && launches >= 4)) {
        delete snapshot.files["untracked.txt"]; snapshot.truncated = true;
        snapshot.omitted.push({ path: "untracked.txt", reason: "file-byte-limit" });
      }
      return snapshot;
    },
    buildExecutorPrompt: () => "fixture", buildGitDiffForcingBlock: () => "fixture", buildSubagentSystemPrompt: () => "fixture",
    resolveCompleteWorkerLaunchPrompt: async () => ({ provider: "owner", model: "owner", systemPrompt: "fixture", toolSchemas: [] }),
    assertWorkerPromptFitsCapacity: () => budget, estimateExecutorContextBudget: () => budget,
    toModelOverride: () => undefined, resolveTaskAgent: () => "coder", inferredRuntimeModelForTask: () => undefined, mergeModelOverrides: () => undefined,
    tryReadContinuationContract: () => null, bindingPromptPreamble: () => "fixture", buildExecutorContinuationPrompt: () => "continue",
    async spawnChecked() {
      launches++;
      if (launches === 1) { fs.writeFileSync(path.join(cwd, "tracked.txt"), "first executor mutation"); return { ...result(), truncated: true }; }
      if (mode === "split-revert") {
        if (launches === 3) fs.writeFileSync(path.join(cwd, "untracked.txt"), "split subtask mutation");
        if (launches === 4) fs.writeFileSync(path.join(cwd, "untracked.txt"), "pre-existing untracked dirt");
      } else if (mode !== "unchanged") fs.writeFileSync(path.join(cwd, "untracked.txt"), "continuation mutation");
      if (mode === "unknown" || (splitOutcome === "unknown" && launches === 4)) unavailable = true;
      if (mode === "throw" || (splitOutcome === "throw" && launches === 4)) throw new Error("continuation/split failed after changing bytes");
      return { ...result(mode === "failed" || (splitOutcome === "failed" && launches === 4) ? 1 : 0), truncated: mode === "exhausted" || (mode === "split-revert" && launches === 2) };
    },
    checkContextExhaustion: value => !!value.truncated,
    // The independent split probe executes the actual production split chain.
    // Other continuation controls retain their original no-launch escalation.
    ...(mode === "split-revert" ? {
      splitTaskOnFailure: () => ({ newDepth: 1, metadata: {}, subtasks: [{ id: "split-1", description: "modify" }, { id: "split-2", description: "restore" }] }),
      buildSubtaskExecutorPrompt: () => "fixture", chainExecutorOutputs: () => "split fixtures",
    } : { trySplitAndExecute: async () => ({ taskId: task.id, description: task.description, output: "replan", exitCode: 1, durationMs: 0 }) }),
    formatToolCallSummary: () => "write", parseExecutorOutputSuffix: () => undefined, classifyTaskOutputType: () => "file_change", hasFileClaimsInProse: () => true,
    mergeActionEvidenceLedgers: () => undefined, emptyToolCallSummary: () => ({ total: 0, mutating: 0, byTool: {} }),
    SubagentDetachedError: class extends Error {}, SubagentTerminalAmbiguousError: class extends Error {}, ConfirmedSupervisedAbandonError: class extends Error {},
    inferOutputTypeFromDescription: () => "file_change", validateOutputTypeContract: () => [], scanEscapeClauses: () => [],
  };
  const names = ["executeExecutorTaskWithRecovery", "mergeExecutorOutputs", "isImplementationTask", ...(mode === "split-revert" ? ["trySplitAndExecute", "splitAndExecuteTask", "escalateToReplan"] : []), ...(shape
    ? ["capturePreExecutionGitSnapshot", "computePostExecutionDiff", "collectArtifactEvidence"]
    : ["captureGitStatusEntries", "diffGitStatusEntries", "sumToolCallSummaries"])];
  const api = compile(relative, names, deps);
  const state = { taskLedger: new Map(), intake: {}, spawnedCount: 0, maxRecoveryDepth: 1, recoveryDepth: 0, recoveryLog: [], spawnGuard: { wouldFit: () => true } };
  const output = await api.executeExecutorTaskWithRecovery(state, { cwd, executorAgent: "coder", maxSubagents: 10 }, new Map(), task, { tasks: [task], notes: "fixture" }, undefined, () => {}, undefined, {});
  assert.equal(launches, mode === "split-revert" ? 4 : 2);
  const expected = ["tracked.txt", ...(["unchanged", "unknown", "partial"].includes(mode) ? [] : ["untracked.txt"])];
  assert.deepEqual(Array.from(output.changedFiles ?? []).sort(), expected.sort(), "recovery must retain the first executor and actual continuation changes");
  assert.equal(output.filesChanged, expected.length);
  assert.equal(output.exitCode, ["failed", "throw", "exhausted"].includes(mode) || ["failed", "throw"].includes(splitOutcome) ? 1 : 0);
  assert.equal(output.effectObservation.status, ["unknown", "partial"].includes(mode) || ["unknown", "partial"].includes(splitOutcome) ? "partial" : "complete");
  if (shape) {
    assert.ok(output.preExecSnapshot, "merged output retains first pre-exec boundary");
    assert.ok(output.postExecSnapshot, "merged output retains last settled boundary, even unavailable");
    const preMap = new Map([[task.id, output.preExecSnapshot]]);
    const evidence = api.collectArtifactEvidence(cwd, [output], { preExecSnapshots: preMap });
    if (["unknown", "partial"].includes(mode) || ["unknown", "partial"].includes(splitOutcome)) {
      assert.ok(evidence.hardGateFailures.some(item => /OBSERVATION UNAVAILABLE/.test(item)), "incomplete continuation must not bypass artifact validation");
      assert.ok(!evidence.hardGateFailures.some(item => /ZERO/.test(item)));
    } else assert.equal(evidence.hardGateFailures.length, 0, `known recovery bytes must reach artifact gate: ${JSON.stringify(evidence.hardGateFailures)}`);
    assert.match(evidence.summary, /tracked\.txt/, "known first-window observation survives unavailable final snapshot");
  }
}
async function mergedArtifactEffects() {
  const cwd = workspace("merged-artifact");
  const api = compile("src/shapes/plan-execute-verify.ts", ["capturePreExecutionGitSnapshot", "computePostExecutionDiff", "collectArtifactEvidence", "isImplementationTask", "mergeExecutorOutputs"], {
    spawnSync: () => ({ status: 0, stdout: " M tracked.txt\n?? untracked.txt\n" }),
    inferOutputTypeFromDescription: () => "file_change", validateOutputTypeContract: () => [], scanEscapeClauses: () => [],
  });
  const before = api.capturePreExecutionGitSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "first mutation");
  const middle = api.capturePreExecutionGitSnapshot(cwd);
  // A continuation restores bytes: net-zero is not zero executor activity.
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "pre-existing tracked dirt");
  const after = api.capturePreExecutionGitSnapshot(cwd);
  const segment = (preExecSnapshot, postExecSnapshot) => {
    const diff = api.computePostExecutionDiff(preExecSnapshot, postExecSnapshot);
    return { taskId: "task-1", description: "Implement", output: "candidate", exitCode: 0, durationMs: 0,
      preExecSnapshot, postExecSnapshot, filesChanged: diff.filesChanged, changedFiles: [...diff.newFiles, ...diff.modifiedFiles, ...diff.deletedFiles], effectObservation: diff.effectObservation };
  };
  const merged = api.mergeExecutorOutputs(segment(before, middle), segment(middle, after));
  const preMap = new Map(); if (merged.preExecSnapshot) preMap.set(merged.taskId, merged.preExecSnapshot);
  const evidence = api.collectArtifactEvidence(cwd, [merged], { preExecSnapshots: preMap });
  assert.equal(evidence.hardGateFailures.length, 0, `observed snapshot chain must reach artifact gate: ${JSON.stringify(evidence.hardGateFailures)}`);
  assert.match(evidence.summary, /tracked\.txt/);
  // A readable but disconnected continuation cannot turn an observation gap
  // into a complete chain. Keep the positive bytes and retain the hard gate.
  const disconnected = api.mergeExecutorOutputs(segment(before, middle), segment(after, after));
  const gapEvidence = api.collectArtifactEvidence(cwd, [disconnected], { preExecSnapshots: new Map([[disconnected.taskId, disconnected.preExecSnapshot]]) });
  assert.ok(gapEvidence.hardGateFailures.some(item => /OBSERVATION UNAVAILABLE/.test(item)), "disconnected windows remain partial");
  assert.match(gapEvidence.summary, /tracked\.txt/);
  const disconnectedZero = api.mergeExecutorOutputs(segment(before, before), segment(after, after));
  assert.equal(disconnectedZero.filesChanged, undefined, "a disconnected zero chain cannot prove zero task effects");
}
async function artifactEffects(unknown) {
  const cwd = workspace(unknown ? "artifact-unknown" : "artifact-positive");
  const api = compile("src/shapes/plan-execute-verify.ts", ["capturePreExecutionGitSnapshot", "computePostExecutionDiff", "collectArtifactEvidence", "isImplementationTask"], {
    spawnSync: () => ({ status: 0, stdout: " M tracked.txt\n?? untracked.txt\n" }),
    inferOutputTypeFromDescription: () => "file_change", validateOutputTypeContract: () => [], scanEscapeClauses: () => [],
  });
  const before = api.capturePreExecutionGitSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "settled mutation");
  const after = unknown ? { success: false, files: [], rawStatus: "unavailable" } : api.capturePreExecutionGitSnapshot(cwd);
  const output = { taskId: "task-1", description: "Implement", output: "candidate", preExecSnapshot: before, postExecSnapshot: after };
  const evidence = api.collectArtifactEvidence(cwd, [output], { preExecSnapshots: new Map([[output.taskId, before]]) });
  if (unknown) {
    assert.ok(evidence.hardGateFailures.some(failure => /OBSERVATION UNAVAILABLE/.test(failure)), "unavailable evidence stays a failure");
    assert.ok(!evidence.hardGateFailures.some(failure => /ZERO/.test(failure)), "unknown downstream evidence must not claim proven zero");
    assert.match(evidence.summary, /unknown/);
  } else {
    assert.equal(evidence.hardGateFailures.length, 0, "already-dirty mutation survives downstream artifact gate");
    assert.match(evidence.summary, /tracked\.txt/);
  }
}
// Faithfully promoted independent Sol assertion: individually complete windows
// with different boundaries are not a complete observation chain.
async function disconnectedLegacyEffects() {
  const cwd = workspace("legacy-disconnected-reviewer");
  const first = signatures.captureContentSignatureSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "unobserved intervening mutation");
  const second = signatures.captureContentSignatureSnapshot(cwd);
  const api = compile("src/index.ts", ["mergeExecutorOutputs", "sumToolCallSummaries"], { mergeActionEvidenceLedgers: () => undefined });
  const zero = s => ({ taskId: "task-1", description: "Implement", output: "", exitCode: 0, durationMs: 0, filesChanged: 0, changedFiles: [], effectObservation: { status: "complete" }, effectSnapshots: [{ before: s, after: s }] });
  const merged = api.mergeExecutorOutputs(zero(first), zero(second));
  assert.equal(merged.filesChanged, undefined, "disconnected complete zero windows must not invent complete-zero evidence");
  assert.notEqual(merged.effectObservation.status, "complete");
}
(async () => {
  try {
    for (const relative of ["src/index.ts", "src/shapes/plan-execute-verify.ts"]) {
      const prefix = relative.includes("shapes") ? "shape" : "legacy";
      await check(`${prefix}/unchanged-dirty-control`, () => taskEffects(relative, `${prefix}-unchanged`, () => {}, []));
      await check(`${prefix}/already-dirty-tracked-and-untracked`, () => taskEffects(relative, `${prefix}-dirty`, cwd => { fs.writeFileSync(path.join(cwd, "tracked.txt"), "further tracked edit"); fs.writeFileSync(path.join(cwd, "untracked.txt"), "further untracked edit"); }, ["tracked.txt", "untracked.txt"]));
      await check(`${prefix}/creation-deletion`, () => taskEffects(relative, `${prefix}-create-delete`, cwd => { fs.unlinkSync(path.join(cwd, "untracked.txt")); fs.writeFileSync(path.join(cwd, "created.txt"), "created"); }, ["untracked.txt", "created.txt"]));
      await check(`${prefix}/unknown-not-zero`, () => taskEffects(relative, `${prefix}-unknown`, () => {}, [], { unavailable: true }));
      await check(`${prefix}/failed-worker-preserves-effects`, () => taskEffects(relative, `${prefix}-failed`, cwd => fs.writeFileSync(path.join(cwd, "tracked.txt"), "failed executor still changed bytes"), ["tracked.txt"], { exitCode: 1 }));
      await check(`${prefix}/partial-positive-not-false-deletion`, () => taskEffects(relative, `${prefix}-partial-positive`, cwd => fs.writeFileSync(path.join(cwd, "tracked.txt"), "observed positive"), ["tracked.txt"], { partial: true }));
      await check(`${prefix}/partial-zero-is-unknown`, () => taskEffects(relative, `${prefix}-partial-zero`, () => {}, [], { partial: true }));
      await check(`${prefix}/merge-unknown-retains-positive`, () => aggregateEffects(relative));
    }
    await check("lifecycle/unobservable-evidence-retains-mutations", () => lifecycleEffects("unobservable", { mutate: true }));
    await check("lifecycle/thrown-evidence-retains-mutations", () => lifecycleEffects("evidence-throws", { mutate: true, throwEvidence: true }));
    await check("lifecycle/unchanged-dirty-is-zero-but-failed", () => lifecycleEffects("zero-control", { mutate: false }));
    await check("lifecycle/workspace-unavailable-is-unknown", () => lifecycleEffects("content-unknown", { contentUnavailable: true }));
    await check("lifecycle/later-unavailable-workspace-retains-earlier-observation", () => lifecycleEffects("earlier-positive", { mutate: true, contentUnavailable: true, outputObserved: true }));
    await check("lifecycle/later-partial-workspace-retains-earlier-observation", () => lifecycleEffects("earlier-partial", { mutate: true, partial: true, omitTracked: true, outputObserved: true }));
    await check("lifecycle/partial-workspace-retains-positive", () => lifecycleEffects("content-partial", { mutate: true, partial: true }));
    await check("lifecycle/failed-worker-retains-effects-after-evidence-failure", () => lifecycleEffects("failed-evidence", { mutate: true, exitCode: 1 }));
    await check("lifecycle/later-complete-net-zero-retains-partial-activity", () => lifecycleEffects("partial-reverted-positive", { mutate: true, outputObserved: true, outputPartial: true, revert: true }));
    await check("reviewer/legacy-disconnected-zero-is-unknown", disconnectedLegacyEffects);
    await check("reviewer/lifecycle-complete-later-read-retains-positive-recovery-activity", () => lifecycleEffects("reverted-positive", { mutate: true, outputObserved: true, revert: true }));
    for (const relative of ["src/index.ts", "src/shapes/plan-execute-verify.ts"]) {
      await check(`${relative}/reviewer-actual-split-reversion`, () => recoveryEffects(relative, "split-revert"));
      for (const outcome of ["failed", "throw", "unknown", "partial"]) {
        await check(`${relative}/actual-split-reversion-${outcome}`, () => recoveryEffects(relative, "split-revert", outcome));
      }
    }
    await check("shape/recovery-merge-to-artifact-snapshot-chain", mergedArtifactEffects);
    for (const relative of ["src/index.ts", "src/shapes/plan-execute-verify.ts"]) {
      for (const mode of ["unchanged", "changed", "failed", "partial", "unknown", "throw", "exhausted"]) {
        await check(`${relative}/continuation-${mode}`, () => recoveryEffects(relative, mode));
      }
    }
    await check("shape/artifact-gate-retains-dirty-mutation", () => artifactEffects(false));
    await check("shape/artifact-gate-unknown-not-zero", () => artifactEffects(true));
  } finally { fs.rmSync(SCRATCH, { recursive: true, force: true }); }
  assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
})().catch(error => { throw error; });
