#!/usr/bin/env node
"use strict";
// Run the real visible-main verifier lifecycle and real host publishers in a
// disposable workspace whose runtime root is INSIDE the exhaustive snapshot.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto"), Module = require("node:module");
const ROOT = path.resolve(__dirname, ".."), SOURCE_ROOT = process.env.ROUND7_BASELINE_SOURCE_ROOT ? path.resolve(process.env.ROUND7_BASELINE_SOURCE_ROOT) : ROOT;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "orch-r7-sidecars-"));
for (const [key, dir] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_ORCHESTRATOR_RUNS_ROOT: "runs", PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next" })) {
  process.env[key] = path.join(SCRATCH, dir); fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = SCRATCH; process.env.PI_OFFLINE = "1";
const PI_MODULES = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter); Module._initPaths();
const jiti = require(path.join(PI_MODULES, "jiti/lib/jiti.cjs"))(__filename, { interopDefault: true, moduleCache: true, fsCache: false });
const ts = require(path.join(ROOT, "node_modules/typescript"));
const timing = fs.existsSync(path.join(SOURCE_ROOT, "src/command-times.ts")) ? jiti(path.join(SOURCE_ROOT, "src/command-times.ts")) : {};
const signatures = jiti(path.join(SOURCE_ROOT, "src/write-set.ts"));
const runState = jiti(path.join(SOURCE_ROOT, "src/run-state.ts"));
const liveStatus = jiti(path.join(SOURCE_ROOT, "src/live-status.ts"));
const { ActionEvidenceCollector } = jiti(path.join(SOURCE_ROOT, "src/action-evidence.ts"));
const helperFile = path.join(SOURCE_ROOT, "src/host-publications.ts");
const publications = fs.existsSync(helperFile) ? jiti(helperFile) : {
  HostPublicationObservation: class {}, withHostPublicationObservation: (_observation, operation) => operation(),
  observeHostPublication: (_files, operation) => operation(),
};
const substrateAst = ts.createSourceFile("substrate.ts", fs.readFileSync(path.join(SOURCE_ROOT, "src/substrate.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const publisherNames = ["SubagentPhaseResultRecorder", "isValidBoundPhaseResult", "appendSubagentPhaseLog", "replacePhaseLogWithTail", "utf8Tail", "configuredPhaseLogMaxBytes", "appendSubagentPhaseLogUnobserved", "ActionEvidenceCollector"].filter(name => substrateAst.statements.some(item => item.name?.text === name));
const publisherContext = vm.createContext({ ...fs, path, process, Date, Buffer, createHash: crypto.createHash, randomBytes: crypto.randomBytes, ...publications, ...liveStatus, ...timing, UnobservedActionEvidenceCollector: ActionEvidenceCollector, atomicWriteJsonSync: runState.atomicWriteJsonSync });
vm.runInContext(ts.transpileModule(publisherNames.map(name => substrateAst.statements.find(item => item.name?.text === name).getText(substrateAst).replace(/^export\s+/, "")).join("\n") + `\nglobalThis.api = { ${publisherNames.join(",")} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, publisherContext);
const substrate = publisherContext.api;
const failures = [];
async function check(id, body) { try { await body(); console.log(`PASS ${id}`); } catch (error) { failures.push({ id, error: error.message }); console.log(`RED ${id}: ${error.message}`); } }
function compile(dependencies) {
  const file = path.join(SOURCE_ROOT, "src/index.ts"), ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const names = ["VERIFIER_WORKSPACE_EXHAUSTIVE_BOUND", "VERIFIER_TOOL_CACHE_PREFIXES", "HOST_RUNTIME_CHECKPOINT_FILE", "HOST_RUNTIME_PHASE_FILE", "normalizedVerifierPath", "isVerifierToolCachePath", "createVerifierWorkspacePathClassifier", "captureVerifierWorkspaceSnapshot", "verifierWorkspaceContentHash", "verifierWorkspaceProtectedContentHash", "verifierWorkspaceSnapshotSummary", "runVisibleMainLifecycle"];
  const source = names.map(name => ast.statements.find(item => item.name?.text === name || item.declarationList?.declarations.some(d => d.name?.text === name))).filter(Boolean).map(node => node.getText(ast).replace(/^export\s+/, "")).join("\n");
  const context = vm.createContext({ fs, path, process, console, Date, Error, Buffer, structuredClone, createHash: crypto.createHash, readFileSync: fs.readFileSync,
    ...signatures, ...publications, ...timing, getCommandTimesForRun: runId => timing.readRunCommandTimes?.(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, runId)), ...dependencies });
  vm.runInContext(ts.transpileModule(source + "\nglobalThis.run = runVisibleMainLifecycle;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return { run: context.run, classify: context.createVerifierWorkspacePathClassifier };
}
async function lifecycle(id, mutate, options = {}) {
  const cwd = path.join(SCRATCH, id), runsRoot = path.join(cwd, "node_modules/.round7-runtime/runs"), runId = "orc-fixture-sidecars", runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  for (const file of ["src/code.ts", "tests/check.cjs", "config.json", "evidence/input.txt", "node_modules/package/index.js", "node_modules/.round7-runtime/runs/orc-other/phase-0-reviewer.result.json"]) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), "original");
  }
  const runtime = { kind: "generic-shape", params: {}, intake: {}, plan: { tasks: [], notes: "fixture" }, executorOutputs: [], repairCount: 0, cursor: { stage: "verifier", nextTaskIndex: 0, completedTaskIds: [] } };
  let state = { runId, mode: "visible-main", status: "awaiting_supervisor", lane: "orchestrator-maintenance", tasks: [], currentApproval: {}, checkpoints: [{ id: "initial", kind: "executor" }], completedCriteria: [], approvedTaskIds: [],
    mission: { originalTask: "fixture", cwd, worktree: {}, missionHash: "a".repeat(64), acceptanceCriteria: [{ id: "AC-1", required: true }], externalEvidenceRoots: options.runtimeAsEvidence ? [runDir] : [], routes: [] }, audit: { infrastructureFailures: [], activeWorkers: [], detachedWorkers: [] }, runtime };
  const store = { stateFile: path.join(SCRATCH, `${id}-supervision.json`), loadGenericCompatibleReadOnly: () => ({ state, migrated: false }), consumeApprovalForDispatch: () => ({ state, approvalConsumption: {} }), save: value => { state = value; },
    appendCheckpoint(value, checkpoint, payload) { value.checkpoints.push({ id: `checkpoint-${value.checkpoints.length}`, ...checkpoint }); value.lastPayload = payload; return value; } };
  fs.writeFileSync(store.stateFile, JSON.stringify(state));
  let dispatched = false;
  const deps = {
    SupervisionStateStore: class { constructor() { return store; } }, SUPERVISION_HOST_INSTANCE: "fixture", normalizePublicAdaptiveSupervisionMode: () => "off", requireGenericRuntime: value => value.runtime,
    currentMissionBoundary: () => ({ flags: [] }), acknowledgeSupervisorBoundary() {}, normalizeParams: () => ({ cwd, verifierAgent: "reviewer", verifierCount: 1, maxRepairs: 0, adaptiveSupervision: "off" }),
    loadAgents: async () => new Map(), resolveConfiguredRoleDefaults() {}, lifecycleState: () => ({}), transitionSupervisionState(value, status) { value.status = status; return value; }, updateGenericCursor(value, update) { Object.assign(value.runtime.cursor, update); },
    buildVisibleMainVerificationPrompt: () => "fixture", toModelOverride: () => undefined, routeObservations: () => [], runsRootDir: () => runsRoot,
    async runBoundedPool(items, _count, _signal, worker) { return Promise.all(items.map((item, index) => worker(item, index))); },
    async spawnChecked() {
      dispatched = true;
      const log = path.join(runDir, "phase-0-reviewer.log"), resultFile = path.join(runDir, "phase-0-reviewer.result.json"), journal = path.join(runDir, "fixture.cancellations.jsonl");
      const recorder = new substrate.SubagentPhaseResultRecorder(resultFile, "reviewer", "fixture", Date.now(), { observeProcess: () => ({ status: "dead" }) });
      substrate.appendSubagentPhaseLog(log, "host", "fixture reviewer launched");
      // Same constructor publication seam used by the real substrate. Neither
      // a claimed filename nor a configured runtime folder establishes ownership.
      const HostCollector = substrate.ActionEvidenceCollector ?? ActionEvidenceCollector;
      const collector = new HostCollector({ cancellationJournalFile: journal });
      if (mutate) await mutate({ cwd, runDir, log, resultFile, journal, recorder, collector });
      const evidence = collector.finalize();
      recorder.incomplete("fixture semantic FAIL, not a source mutation");
      return { agentName: "reviewer", text: "fixture", exitCode: 1, durationMs: 0, events: 0, actionEvidence: evidence };
    },
    parseVisibleMainVerifierResponse: () => ({ status: "fail", reasons: ["fixture product failure"], criterionFindings: [{ criterionId: "AC-1", status: "fail" }] }),
    normalizeVisibleMainVerifierResponse: parsed => ({ parsed, diagnostics: [] }), validateFinalVerification: () => [], hasBlockingVerificationIssues: issues => issues.length > 0,
    evaluateNumericAcceptanceGates: () => [], numericTargetCoverageIssues: () => [], numericGateFailureIssues: () => [], appendRouteObservations: () => [], observedRouteFromResult: () => undefined, checkObservedRouteAdvisories: () => [],
    isRoutingOnlyVerificationFailure: () => false, classifyInfrastructureFailure: error => ({ message: String(error), infrastructure: true }), ConfirmedSupervisedAbandonError: class extends Error {}, SubagentDetachedError: class extends Error {},
    lifecycleResult: (value, _token, extra) => ({ status: value.status, ...extra }), issueCheckpointApproval: (_store, value) => ({ state: value, token: "fixture" }),
  };
  const output = await compile(deps).run({ runId, approvalToken: "fixture" }, "continue");
  assert.ok(dispatched, "the actual lifecycle launches its verifier");
  assert.ok(output.verificationBatch?.workspaceIntegrity, `actual verifier integrity published, not a loader failure: ${JSON.stringify(output)}`);
  assert.ok(output.verificationBatch.workspaceIntegrity.changes.length >= 3, "exhaustive raw observation retains host log/result/journal");
  return output.verificationBatch.workspaceIntegrity;
}
(async () => {
  try {
    await check("real lifecycle excludes authentic host publications inside workspace", async () => {
      const observed = await lifecycle("host-only");
      assert.equal(observed.mutationDetected, false, "host log/result/empty cancellation journal must not be attributed to reviewer edits");
      assert.ok(observed.ignoredHostRuntimeChanges.length >= 3);
    });
    await check("real collector journal append is host-owned publication", async () => {
      const observed = await lifecycle("journal-append", ({ collector, journal }) => {
        collector.observe({ type: "tool_execution_update", toolCallId: "fixture-command", partialResult: { details: { noOutputCancellation: {
          schemaVersion: 1, outcome: "cancelled_no_output", invocationId: "fixture-invocation", summary: "fixture receipt", partialLog: "",
          cancellationRequested: true, cancellationAccepted: true, cancellationConfirmed: true, confirmationBasis: "terminal_signal_after_owned_handle_action",
          terminalExitCode: null, terminalSignal: "SIGTERM", cancellationTarget: "retained-direct-test-child-handle", eligibility: "authenticated_run_owned_test_child",
          artifactPath: "fixture-artifact", artifactSha256: "a".repeat(64), artifactBytes: 0, artifactIntegrity: "verified",
        } } } });
        assert.ok(fs.statSync(journal).size > 0, "the real collector must actually append, not merely create an empty journal");
      });
      assert.equal(observed.mutationDetected, false); assert.ok(observed.ignoredHostRuntimeChanges.some(change => change.path.endsWith(".cancellations.jsonl")));
    });
    for (const file of ["src/code.ts", "tests/check.cjs", "config.json", "evidence/input.txt", "node_modules/package/index.js", "node_modules/.round7-runtime/runs/orc-other/phase-0-reviewer.result.json", "node_modules/.round7-runtime/runs/orc-fixture-sidecars/phase-99-reviewer.log"]) {
      await check(`reviewer mutation enforced: ${file}`, async () => {
        const observed = await lifecycle(`mutation-${failures.length}-${file.replaceAll(/[^a-z0-9]/gi, "-")}`, ({ cwd }) => fs.writeFileSync(path.join(cwd, file), "reviewer mutation"));
        assert.equal(observed.mutationDetected, true); assert.ok(observed.enforcedChanges.some(change => change.path === file));
      });
    }
    await check("reviewer tampers with real result before later host publication", async () => {
      const observed = await lifecycle("tamper-overwritten", ({ resultFile }) => fs.writeFileSync(resultFile, "reviewer tampering"));
      assert.equal(observed.mutationDetected, true, "host overwrite must not launder reviewer edits");
    });
    await check("host publications cannot bypass read-only external evidence", async () => {
      const observed = await lifecycle("runtime-as-evidence", undefined, { runtimeAsEvidence: true });
      assert.equal(observed.mutationDetected, true); assert.ok(observed.externalEvidenceChanges.length >= 3);
    });
    await check("reviewer tampering in real host log stays enforced", async () => {
      const observed = await lifecycle("log-tamper", ({ log }) => fs.appendFileSync(log, "reviewer injected bytes"));
      assert.equal(observed.mutationDetected, true); assert.ok(observed.enforcedChanges.some(change => change.path.endsWith("phase-0-reviewer.log")));
    });
    await check("path escapes cannot claim host publication ownership", async () => {
      const root = path.join(SCRATCH, "escape"); fs.mkdirSync(root);
      const outside = path.join(SCRATCH, "outside.log"), before = signatures.captureContentSignatureSnapshot(root);
      const observation = new publications.HostPublicationObservation(root);
      await publications.withHostPublicationObservation(observation, async () => publications.observeHostPublication([outside], () => fs.writeFileSync(outside, "host bytes outside workspace")));
      const after = signatures.captureContentSignatureSnapshot(root);
      if (observation.admittedPaths) assert.equal(observation.admittedPaths(before, after).size, 0);
      const classify = compile({}).classify(root, path.join(root, "runs"), new Set(["../outside.log"]));
      assert.equal(classify("../outside.log"), "enforced");
      assert.equal(classify("node_modules/.vite/../../src/code.ts"), "enforced");
    });
    await check("symlink within runtime remains enforced", async () => {
      const observed = await lifecycle("symlink", ({ cwd, runDir }) => fs.symlinkSync(path.join(cwd, "src"), path.join(runDir, "phase-77-reviewer.result.json"), "junction"));
      assert.equal(observed.mutationDetected, true); assert.equal(observed.omissionsChanged, true);
    });
  } finally { fs.rmSync(SCRATCH, { recursive: true, force: true }); }
  assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
})().catch(error => { throw error; });
