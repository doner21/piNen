#!/usr/bin/env node
"use strict";
/** Full production role dispatch + worker launch/event seams. Only child I/O,
 * launcher assembly and pre-existing scheduling handles are injected. The same
 * file replays the pre-build2 source via ROUND7_BASELINE_SOURCE_ROOT. */
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto"), Module = require("node:module");
const { EventEmitter } = require("node:events");
const ROOT = path.resolve(__dirname, ".."), SOURCE = process.env.ROUND7_BASELINE_SOURCE_ROOT ? path.resolve(process.env.ROUND7_BASELINE_SOURCE_ROOT) : ROOT;
const SCRATCH = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orch-r7-role-")));
// Assert the just-created owned canonical Temp directory BEFORE any file write.
assert.ok(SCRATCH && path.isAbsolute(SCRATCH) && fs.statSync(SCRATCH).isDirectory());
assert.equal(path.dirname(SCRATCH), fs.realpathSync.native(os.tmpdir()), "owned scratch is an immediate child of canonical Temp");
for (const protectedRoot of [ROOT, SOURCE, ...(SOURCE === ROOT ? [] : [path.dirname(SOURCE)])]) {
  const relative = path.relative(fs.realpathSync.native(protectedRoot), SCRATCH);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "scratch must be outside workspace and read-only input");
}
for (const [key, dir] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_ORCHESTRATOR_RUNS_ROOT: "runs", PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next" })) { process.env[key] = path.join(SCRATCH, dir); fs.mkdirSync(process.env[key], { recursive: true }); }
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = SCRATCH; process.env.PI_OFFLINE = "1";
const ts = require(path.join(ROOT, "node_modules/typescript")), PI = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules");
process.env.NODE_PATH = [PI, path.join(ROOT, "node_modules")].join(path.delimiter); Module._initPaths();
const jiti = require(path.join(PI, "jiti/lib/jiti.cjs"))(__filename, { interopDefault: true, moduleCache: true, fsCache: false });
// Missing recovery on the baseline is NOT a loader error: run its original
// complete dispatch/launch functions and assert the missing semantic behavior.
const timing = fs.existsSync(path.join(SOURCE, "src/command-times.ts")) ? jiti(path.join(SOURCE, "src/command-times.ts")) : {};
const getCommandTimesForRun = runId => timing.readRunCommandTimes?.(runId ? path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT, runId) : undefined);
const helpers = fs.existsSync(path.join(SOURCE, "src/role-recovery.ts")) ? jiti(path.join(SOURCE, "src/role-recovery.ts")) : {};
const publications = jiti(path.join(SOURCE, "src/host-publications.ts"));
const signatures = jiti(path.join(SOURCE, "src/write-set.ts"));
const hostState = jiti(path.join(SOURCE, "src/run-state.ts"));
const substrate = jiti(path.join(SOURCE, 'src/substrate.ts'));
const generations = jiti(path.join(SOURCE, 'src/process-generation.ts'));
function declarations(relative, names) {
  const file = path.join(SOURCE, relative), ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return names.map(name => { const node = ast.statements.find(item => item.name?.text === name); assert.ok(node, `baseline declaration ${relative}:${name}`); return node.getText(ast).replace(/^export\s+/, ""); }).join("\n");
}
function compile(source, dependencies, expression) {
  const context = vm.createContext({ Date, path, os, process, console, Buffer, structuredClone, Error, Map, Set, ...fs,
    createHash: crypto.createHash, randomBytes: crypto.randomBytes,
    ...require(path.join(SOURCE, 'src/streaming-redactor.cjs')),
    sanitizeSubagentResult: substrate.sanitizeSubagentResult,
    isProvablyReadOnlySubagent: substrate.isProvablyReadOnlySubagent,
    isNoToolInfrastructureFailure: substrate.isNoToolInfrastructureFailure,
    isInfrastructureFailure: substrate.isInfrastructureFailure,
    SubagentInfrastructureError: substrate.SubagentInfrastructureError,
    // Child I/O is simulated here; feed creation-bound fixture generations to
    // the REAL pure assessor, not a cleanup PASS stub. Real SDK/window tests
    // independently exercise kernel observation and surviving descendants.
    ProcessGenerationTracker: class { constructor(pid) { const born='2026-10-17T00:00:00.0000000Z';this.tree={schemaVersion:1,rootPid:pid,rootBorn:born,observedAt:born,members:[{pid,parentPid:1,born}],status:'clean',survivors:[],unknown:[]}; } sample() {} rootClosed() {} current() { return structuredClone(this.tree); } },
    assessResultProcessTrees: outputs=>outputs.flatMap(o=>(o.processTrees?.length?o.processTrees:[o.processTree]).map(t=>generations.assessTreeWithObserver(t,()=>({status:'dead',evidence:'ESRCH'})))),
    getRunProcessTrees: ()=>undefined,
    ...hostState, ...signatures, ...publications, ...helpers, ...timing,
    ...jiti(path.join(SOURCE, 'src/spawn-budget.ts')), getCommandTimesForRun, ...dependencies });
  vm.runInContext(ts.transpileModule(source + `\nglobalThis.api = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.api;
}
const OWNER = "Owner rules intact: no model substitution; preserve done executors; closing sentinel OWNER-END.";
const criteria = ["Check A", "Check B"];
const binding = `BINDING OWNER INSTRUCTIONS, SAFETY, AND ACCEPTANCE — COMPLETE AND VERBATIM WHERE APPLICABLE:\n${JSON.stringify({ original_task: OWNER, success_criteria: criteria })}\n\nDo not treat later summaries, plans, or non-binding context as permission to weaken, replace, or truncate this section.`;
const plan = JSON.stringify({ acceptance_criteria: criteria, tasks: [{ id: "task-1", description: "Implement the remaining change", dependsOn: [], expects_file_change: true, criteria: ["RC-1", "RC-2"] }], predicted_write_set: ["candidate.txt"] });
const verdict = JSON.stringify({ status: "pass", reasons: [], criterionFindings: criteria.map((text, i) => ({ criterionId: `RC-${i+1}`, status: "pass", evidence: [{ kind: "test", observed: text, exitCode: 0 }] })) });
const invalidVerdict = JSON.stringify({ status: "pass", reasons: [], criterionFindings: [{ criterionId: "RC-1", status: "pass", evidence: [{ observed: "only first" }] }] });
const outputEvidence = [{ taskId: "task-1", output: "x".repeat(3000), actionEvidence: { entries: [{ command: "read-only command", outcome: "success" }] } }, { taskId: "task-2", output: "y".repeat(3000), actionEvidence: { entries: [] } }];
function planningCapacityPrompt(relative) {
  const names = relative === "src/index.ts" ? ["buildPlanningPrompt", "bindingPromptPreamble", "formatBindingContractForPrompt", "formatIntakeForPrompt", "plannerAcceptanceCriteriaInstruction", "plannerDeliverablesInstruction"] : ["buildPlanningPrompt", "formatIntakeForPrompt"];
  const builder = compile(declarations(relative === "src/index.ts" ? relative : "src/shapes/plan-execute-verify.ts", names), {}, "buildPlanningPrompt");
  const intake = { originalTask: OWNER, successCriteria: criteria, constraints: ["no substitution"], invariants: [], failureCriteria: [], nonGoals: [], ambiguities: [], deliverables: [], supervisorAddedConstraints: [], ownerCriteria: { success: criteria }, orchestrationControls: {} };
  return builder(intake, 1, ["x".repeat(3000), "y".repeat(3000)]);
}
function prompt(role) { return role === "planner" ? `${binding}\n\nPlan the following task. INTAKE CONTRACT:\n${JSON.stringify({ original_task: OWNER, success_criteria: criteria })}\nKeep acceptance criteria. Attempt: 1` : `${binding}\n\nVerify the orchestration result.\n\nPlan:\n${plan}\n\nExecutor outputs:\n${JSON.stringify(outputEvidence)}\n\nHOST-OWNED ACTION EVIDENCE AUTHORITY:\nReal ledger:\n${JSON.stringify(outputEvidence.map(o => ({ taskId: o.taskId, ledger: o.actionEvidence })))}\n\nModel routing evidence/configuration supplied by orchestrator:\nfixed route\nReturn JSON status/reasons.`; }
let serial = 0;
async function exercise(relative, role, mode) {
  const only = mode.startsWith("verify-only-");
  const id = `${++serial}-${role}-${mode}`, cwd = path.join(SCRATCH, id), logs = mode.startsWith("visible-main-nested") ? path.join(cwd, "runs") : path.join(SCRATCH, `${id}-logs`), evidence = path.join(SCRATCH, `${id}-evidence`);
  for (const dir of [cwd, logs, evidence]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(cwd, "candidate.txt"), "settled executor artifact"); fs.writeFileSync(path.join(evidence, "input.txt"), "immutable");
  const requests = [], optionsSeen = [], sidecars = [], route = { provider: "owner-provider", model: "owner-model" };
  let count = 0, refuse = 0;
  const handle = { unref() {} };
  const deps = {
    atomicWriteJsonSync: mode.startsWith("visible-main-nested") ? hostState.atomicWriteJsonSync : (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); },
    allocatePhaseEvidence: (_agent, log, result) => {
      const resultFile = result ?? path.join(logs, `worker-${sidecars.length}.result.json`);
      sidecars.push(resultFile);
      return { logFile: log ?? resultFile.replace(".result.json", ".log"), resultFile };
    },
    appendSubagentPhaseLog() {}, rejectLocalModelIfNeeded() {}, formatRoutedModel: (p,m) => `${p}/${m}`,
    READ_ONLY_EVIDENCE_TOOLS: ["read", "grep", "find", "ls"], VERIFIER_EVIDENCE_TOOLS: ["read", "grep", "find", "ls", "bash"],
    workerExecutionConstraintContext: { getStore: () => undefined }, subagentPhaseLogContext: { getStore: () => ({ runId: id }) },
    resolveCompleteWorkerLaunchPrompt: async ({ profile }) => ({ ...route, modelArgument: route.model, systemPrompt: profile.systemPrompt ?? "system", toolSchemas: [], contextWindow: 32000, maxOutputTokens: 1000 }),
    assertWorkerPromptFitsCapacity({ prompt: task }) { if ((mode === "capacity" || mode === "planner-capacity") && task.includes("x".repeat(3000)) && task.includes("y".repeat(3000))) { refuse++; throw new Error("BINDING_PROMPT_CAPACITY_REFUSED: two evidence units cannot fit"); } if (mode === "binding-too-large") { refuse++; throw new Error("BINDING_PROMPT_CAPACITY_REFUSED: binding alone cannot fit"); } },
    mkTempDir: async () => fs.mkdtempSync(path.join(SCRATCH, "prompt-")), materializeFrozenTestAuthorizationPolicy: () => ({ file: "owned-policy", sha256: "a".repeat(64) }), safeFileName: value => value,
    writeFile: fs.promises.writeFile, rm: fs.promises.rm,
    resolvePiCommand: () => ({ command: "injected-child-only", argsPrefix: [], env: {} }), buildWindowsEpermSpawnAttempts: (command, args, options) => [{ command, args, options }],
    WORKER_MONITOR_BOOTSTRAP_EXTENSION: "bootstrap", WORKER_NO_OUTPUT_MONITOR_EXTENSION: "monitor", WORKER_EXECUTION_CONSTRAINTS_EXTENSION: "guard",
    NO_OUTPUT_MONITOR_READY_MARKER: "MONITOR-READY", NO_FORCE_KILL_GUARD_READY_MARKER: "GUARD-READY",
    emptyToolCallSummary: () => ({ total: 0, mutating: 0, byTool: {} }), ActionEvidenceCollector: class { observe() {} finalize() { return { entries: [], hostObserved: "preserved-host-observation" }; } },
    setTimeout: () => handle, setInterval: () => handle, clearTimeout() {}, clearInterval() {}, getPiChildFirstJsonTimeoutMs: () => 0,
    toModelOverride: () => route,
    spawn(_command, args, options) {
      const child = new EventEmitter(), reader = new EventEmitter(); child.pid = 50000 + ++count; child.stdout = reader; child.stderr = new EventEmitter(); child.kill = () => { throw new Error("no process signals"); };
      const dispatch = task => {
      requests.push(task); optionsSeen.push({ args, options });
      Promise.resolve().then(() => {
        child.stderr.emit("data", Buffer.from("MONITOR-READY GUARD-READY"));
        const stage = task.match(/"stage":"([^"]+)"/)?.[1];
        const exhausted = mode === "always-exhausted" || ((mode === "return-planning" || mode === "verify-only-chain" || mode === "visible-main-readonly-chain") && count <= 2) || (count === 1 && mode !== "capacity" && mode !== "planner-capacity" && mode !== "binding-too-large" && mode !== "sdk-overflow");
        if ((mode === "verifier-build-cache" || mode === "verify-only-cache") && count === 1) { fs.mkdirSync(path.join(cwd, "dist"), { recursive: true }); fs.writeFileSync(path.join(cwd, "dist", "cache.txt"), "build cache only"); }
        if (mode === "mutation" && count === 1) fs.writeFileSync(path.join(cwd, "candidate.txt"), "illegal verifier mutation");
        if (mode === "evidence-mutation" && count === 1) fs.writeFileSync(path.join(evidence, "input.txt"), "illegal evidence mutation");
        if (mode === "visible-main-nested-mutation" && count === 1) fs.writeFileSync(sidecars[sidecars.length - 1], "unobserved worker tampering before host overwrites result");
        let text = role === "planner" ? plan : mode === "missing-findings" ? invalidVerdict : verdict;
        if (mode === "changed-criteria") text = plan.replace('"Check B"', '"weaker criterion"');
        if (mode === "cycle") text = plan.replace('"dependsOn":[]', '"dependsOn":["task-1"]');
        if (mode === "trimmed-id-collision") { const malformed = JSON.parse(plan); malformed.tasks.push({ ...malformed.tasks[0], id: " task-1" }); text = JSON.stringify(malformed); }
        if (mode === "visible-main-readonly-chain") text = verdict.replaceAll("RC-1", "AC-01").replaceAll("RC-2", "AC-02");
        if (only) text = JSON.stringify({ overall: "pass", reasons: [], checks: criteria.map((description, i) => ({ id: `check-${i + 1}`, description, status: "pass", citations: ["candidate.txt:1 inspected"] })) });
        if (mode === "verify-only-missing") text = JSON.stringify({ overall: "pass", reasons: [], checks: [] });
        if (stage === "shard") text = JSON.stringify({ scope: JSON.parse(task.match(/"remaining":(\[[^\n]*?\]),"requiredCriteria"/)[1]), notes: "partial substantive inspection/planning analysis, not terminal", evidence: [{ observed: "candidate.txt:1 contains settled executor artifact" }] });
        if (stage === "replan") text = JSON.stringify({ groups: JSON.parse(task.match(/"remaining":(\[[^\n]*?\]),"requiredCriteria"/)[1]).map(id => [id]) });
        if (exhausted) text = JSON.stringify({ status: "pass", tasks: [], recovery: { remaining: ["Check B"] } });
        if (exhausted && mode === "handoff") text = JSON.stringify({ roleRecoveryHandoff: { role, completed: ["Check A notes"], remaining: ["Check B"], partialResult: "partial substantive findings" } });
        if (mode === "sdk-overflow" && count === 1) {
          reader.emit("line", JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "length", content: '{"status":"pass","tasks":[]}' } }));
          reader.emit("line", JSON.stringify({ type: "agent_end", willRetry: false }));
          reader.emit("line", JSON.stringify({ type: "compaction_end", reason: "overflow", willRetry: true }));
          reader.emit("line", JSON.stringify({ type: "agent_start" }));
        }
        reader.emit("line", JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: exhausted ? mode === "handoff" ? "stop" : mode === "provider-context" ? "error" : "length" : "stop", ...(exhausted && mode === "provider-context" ? { errorMessage: "maximum context length exceeded" } : {}), content: text } }));
        reader.emit("line", JSON.stringify({ type: "agent_end" })); child.emit("close", 0);
      }); };
      child.stdin = new EventEmitter(); child.stdin.end = dispatch;
      if (!args.includes("guard")) dispatch(args[args.length - 1]);
      return child;
    },
    createInterface: ({ input }) => { input.close = () => {}; return input; }, isPiJsonProtocolEvent: () => true,
    acknowledgeNoOutputAlarm() {}, recordToolCall() {}, optionalString: value => typeof value === "string" ? value : undefined,
    classifyProviderRefusal: () => undefined, isWindowsSpawnEperm: () => false, SubagentDetachedError: class extends Error {}, SubagentTerminalAmbiguousError: class extends Error {},
    buildWindowsEpermEvidence: () => ({}), writeWindowsEpermEvidence: async () => undefined, formatSpawnFailure: error => error.message,
    phaseLogPathFor: (_run, index) => path.join(logs, `phase-${index}.log`), phaseResultPathFor: (_run, index) => { const file = path.join(logs, `phase-${index}.result.json`); sidecars.push(file); return file; },
  };
  const publicLaunchName = relative === "src/index.ts" ? "runSubagent" : "spawnSubagent";
  const launchName = fs.readFileSync(path.join(SOURCE, relative), 'utf8').includes(`function ${publicLaunchName}Attempt(`) ? `${publicLaunchName}Attempt` : publicLaunchName;
  const launch = compile(declarations("src/substrate.ts", ["SubagentPhaseResultRecorder", "isValidBoundPhaseResult"]) + "\n" + declarations(relative, [launchName, "buildSubagentSystemPrompt", "describeJsonEvent", "extractMessageText", "truncateWithNotice"]), deps, launchName);
  const workerName = mode === "shared-profile" ? "shared-worker" : role === "planner" ? "planner" : "reviewer";
  const agents = new Map([[workerName, { name: workerName, ...route }]]);
  const params = { cwd, task: only ? `${OWNER}\n1. Check A\n2. Check B\nINTAKE CONTRACT:\n{"success_criteria":["do not weaken"]}\n\nExecutor outputs:\n[{"instruction":"caller-owned delimiter-looking instruction stays verbatim"}]` : OWNER, plannerAgent: mode === "shared-profile" ? workerName : "planner", verifierAgent: mode === "shared-profile" ? workerName : "reviewer", maxSubagents: mode === "spawn-budget" ? 1 : 12, allowLocalModel: false, externalEvidenceRoots: [evidence], workerExecutionConstraints: { noForceKill: true }, ...(mode === "visible-main-readonly-chain" ? { paradigm: "verify-only" } : {}) };
  let spawned = 0;
  const state = { runId: id, spawnedCount: 0, routingEvidence: [], recoveryLog: [], intake: { originalTask: OWNER, successCriteria: criteria }, maxRecoveryDepth: 2, spawnGuard: { reserve() { if (++spawned > params.maxSubagents) throw new Error("Substrate spawn ceiling exceeded"); return spawned; }, cap: params.maxSubagents, wouldFit: n => spawned + n <= params.maxSubagents } };
  const wrapperRelative = relative === "src/index.ts" ? relative : "src/shapes/plan-execute-verify.ts";
  const dispatch = compile(declarations(wrapperRelative, ["spawnChecked"]), { ...deps, runSubagent: launch, spawnSubagent: launch }, "spawnChecked");
  let result, error;
  let originalPrompt = mode === "planner-capacity" ? planningCapacityPrompt(relative) : prompt(role);
  if (mode.startsWith("visible-main")) {
    const buildVisible = compile(declarations("src/index.ts", ["buildVisibleMainVerificationPrompt", "bindingPromptPreamble", "formatBindingContractForPrompt"]), {}, "buildVisibleMainVerificationPrompt");
    originalPrompt = buildVisible({ originalTask: OWNER, successCriteria: criteria, constraints: [], deliverables: [], failureCriteria: [] }, { originalTask: OWNER, cwd, acceptanceCriteria: criteria.map((text, i) => ({ id: mode === "visible-main-readonly-chain" ? `AC-0${i + 1}` : `RC-${i + 1}`, text, required: true })) }, JSON.parse(plan), outputEvidence);
  }
  const beforeOuter = signatures.captureContentSignatureSnapshot(cwd, { excludeDirectories: [] });
  const outer = new publications.HostPublicationObservation(cwd);
  try {
    if (only) {
      const shape = compile(declarations("src/shapes/verify-only.ts", ["runVerifyOnly", "buildVerifyOnlyPrompt", "buildVerifierAgents", "parseVerifyOnlyResult", "aggregateChecks", "buildFinalResult", "buildDetails", "inferVerifierCount", "extractJson", "extractFenceContents", "extractBalancedObject", "optionalString", "stringArray"]), {
        ...deps, spawnSubagent: launch,
        SpawnGuard: compile(declarations("src/substrate.ts", ["SpawnGuard", "clampSpawnCeiling"]), { SUBSTRATE_CAPS: { MAX_TOTAL_SPAWNS: 200 } }, "SpawnGuard"),
        MAX_VERIFIER_CONCURRENCY: 3, DEFAULT_VERIFIER_COUNT: 1, MAX_VERIFIER_COUNT: 7, MAX_FINAL_CHARS: 20000, MAX_DETAIL_CHARS: 4000, VERIFY_ONLY_TOOLS: ["read", "grep", "find", "ls", "bash"],
        throwIfAborted() {}, truncateWithNotice: text => text, formatRouteLabel: () => "owner-provider/owner-model",
        runBoundedPool: async (items, _count, _signal, worker) => Promise.all(items.map((item, i) => worker(item, i))),
      }, "runVerifyOnly");
      const output = await shape({ params, agents, onUpdate() {} });
      assert.equal(output.details.plannerSpawns, 0, "verify-only never creates an implicit planner route");
      assert.equal(output.details.executorSpawns, 0);
      const run = output.details.verifierRuns[0]; result = { ...run, text: run.raw, exitCode: run.overall === "pass" ? 0 : 1 };
    } else result = await publications.withHostPublicationObservation(outer, () => relative === "src/index.ts" ? dispatch(state, params, agents, workerName, originalPrompt, undefined, () => {}, undefined, route, undefined, false, role === "verifier", role) : dispatch(state, params, agents, workerName, role, originalPrompt, undefined, () => {}, undefined, route));
  } catch (err) { error = err; }
  if (["always-exhausted", "spawn-budget", "binding-too-large", "missing-findings", "verify-only-missing", "changed-criteria", "cycle", "trimmed-id-collision", "mutation", "verifier-build-cache", "evidence-mutation", "visible-main-nested-mutation"].includes(mode)) {
    assert.ok(error, `unsafe/incomplete ${mode} must explicitly stop, never yield a terminal result`);
    assert.match(error.message, /ROLE_RECOVERY_EXHAUSTED|ROLE_RECOVERY_INTEGRITY/, "semantic recovery refusal, not harness/loader failure");
    assert.equal(result, undefined); assert.ok(count <= 7 && refuse <= 7, "recovery is bounded");
  } else {
    assert.equal(error, undefined, `role must recover on the production dispatch path: ${error?.stack}`);
    assert.ok(mode === "sdk-overflow" ? requests.length === 1 : requests.length >= 2, "substantive recovery follows on, but settled SDK overflow recovery does not repeat a completed worker");
    assert.equal(result.exitCode, 0); assert.ok(result.roleRecovery?.terminalValidated, "only validated terminal recovery may be returned");
    assert.equal(result.roleRecovery.role, role, "semantic role is preserved even when role profiles share a name");
    if (mode !== "sdk-overflow") { assert.ok(result.roleRecovery.steps.length >= 2); assert.ok(result.roleRecovery.steps.some(s => s.stage !== "initial")); }
    if (mode === "capacity" || mode === "planner-capacity") { assert.ok(refuse >= 1); assert.ok(result.roleRecovery.steps.some(s => s.stage === "shard"), "capacity uses smaller evidence chains, not identical retry"); }
    else if (mode !== "sdk-overflow") assert.ok(result.roleRecovery.steps.some(s => s.stage === "continuation"));
    if (mode === "return-planning") assert.ok(result.roleRecovery.steps.some(s => s.stage === "replan") && result.roleRecovery.steps.filter(s => s.stage === "shard").length >= 2, "exhausted continuation returns to the configured planner and chains substantive inspection");
    if (mode === "visible-main-readonly-chain") assert.ok(!result.roleRecovery.steps.some(s => s.stage === "replan") && JSON.parse(result.text).criterionFindings.every(finding => finding.criterionId.startsWith("AC-")), "visible-main read-only recovery retains the frozen mission schema without an implicit planner");
    if (mode === "verify-only-chain") assert.ok(!result.roleRecovery.steps.some(s => s.stage === "replan") && result.roleRecovery.steps.filter(s => s.stage === "shard").length >= 2, "read-only context recovery chains without a planner");
    assert.equal(JSON.parse(result.text).status ?? "pass", "pass");
    if(!only){
      assert.equal(relative==='src/index.ts'?state.spawnedCount:spawned,count,'only physical launches consume the budget; admission refusals do not');
      assert.equal(result.processTrees.length,count,'every physical exhausted/planner/shard generation survives synthesis');
    }
  }
  if (mode.startsWith("visible-main-nested")) {
    const admitted = outer.admittedPaths(beforeOuter, signatures.captureContentSignatureSnapshot(cwd, { excludeDirectories: [] }));
    if (mode.endsWith("mutation")) assert.equal(admitted.size, 0, "nested observations must not launder tampered host publications");
    else assert.ok(admitted.size >= 2, "real initial/continuation sidecar writes remain attributed to the enclosing visible-main batch");
  }
  for (const [index, task] of requests.entries()) {
    // Independent capacity shards inspect disjoint original evidence; carrying
    // every sibling's ledger into each shard recreates the prompt-growth bug.
    // Continuations and final synthesis must still receive host observations.
    if (index > 0 && !task.includes('"stage":"shard"')) assert.ok(task.includes('"hostObserved":"preserved-host-observation"'), "follow-on synthesis/continuations receive host-observed evidence, not just worker prose");
    assert.ok(task.includes(OWNER), "complete original owner instructions reach every worker");
    if (only) assert.ok(task.includes(params.task), "a caller's delimiter-looking checklist text is never partitioned as host evidence");
    if (task !== originalPrompt) { assert.match(task, /ROLE_RECOVERY/); assert.match(task, /remaining/); assert.match(task, /sourceOptions/); }
  }
  if (mode === "planner-capacity" && !error) {
    assert.equal(requests.at(-1).split('"hostObserved":"preserved-host-observation"').length - 1, requests.length - 1,
      "final synthesis retains every settled shard's host observation exactly once");
  }
  for (const observation of optionsSeen) { assert.ok(observation.args.includes(route.provider)); assert.ok(observation.args.includes(route.model)); assert.ok(observation.args.includes("guard")); }
  if (mode === "continuation") {
    const saved = sidecars.filter(file => fs.existsSync(file)).map(file => JSON.parse(fs.readFileSync(file, "utf8")));
    assert.ok(saved.some(s => s.status === "incomplete"), "exhausted partial worker is not a complete sidecar on either launcher");
  }
  if (!mode.includes("mutation")) assert.equal(fs.readFileSync(path.join(cwd, "candidate.txt"), "utf8"), "settled executor artifact", "verification recovery never repeats completed executor work");
}
// The independent failing probes now exercise the same production publication,
// bounded-pool, recovery and shape functions. Promise barriers establish overlap
// without clocks, timers or a worker execution masquerading as a host write.
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const exhaustive = { maxFiles: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER, maxFileBytes: Number.MAX_SAFE_INTEGER, excludeDirectories: [] };
const realPool = compile(declarations("src/substrate.ts", ["runBoundedPool", "throwIfAborted"]), { AbortController }, "runBoundedPool");
function fixture(name) {
  const cwd = path.join(SCRATCH, `probe-${++serial}-${name}`); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "product.txt"), "unchanged"); return cwd;
}
function requireObserver() { assert.equal(typeof helpers.observeRoleReadOnlyLaunch, "function", "baseline lacks per-launch integrity/recovery observation"); }
async function siblingPublications() {
  requireObserver();
  const cwd = fixture("siblings"), before = signatures.captureContentSignatureSnapshot(cwd, exhaustive);
  const outer = new publications.HostPublicationObservation(cwd), ready = [deferred(), deferred()];
  const results = await publications.withHostPublicationObservation(outer, () => realPool([0, 1], 2, undefined, async index => {
    // Both observations exist before either synchronous host publication begins.
    try { await helpers.observeRoleReadOnlyLaunch(cwd, [], async () => {
      ready[index].resolve(); await ready[1-index].promise;
      hostState.atomicWriteJsonSync(path.join(cwd, `${index}.result.json`), { host: index });
      await Promise.resolve();
    }); return "fulfilled"; } catch (error) { return error.message; }
  }));
  const admitted = outer.admittedPaths(before, signatures.captureContentSignatureSnapshot(cwd, exhaustive));
  assert.equal(admitted.size, 2, "enclosing host observation authenticates both sibling publications");
  assert.ok(results.every(result => result === "fulfilled"), `concurrent genuine sibling publications are not worker mutations: ${JSON.stringify(results)}`);
}
async function actualVerifyOnlyPublications(concurrent = false, mutation, cleanup) {
  requireObserver();
  const cwd = fixture(concurrent ? "configured-concurrent" : mutation ?? "final-sidecars"), evidence = path.join(SCRATCH, `probe-evidence-${serial}`);
  fs.mkdirSync(evidence); fs.writeFileSync(path.join(evidence, "input.txt"), "immutable");
  fs.mkdirSync(path.join(cwd, "node_modules/package"), { recursive: true }); fs.writeFileSync(path.join(cwd, "node_modules/package/index.js"), "dependency");
  const rendezvous = [deferred(), deferred()], counts = [0, 0], routes = [], prompts = [];
  const logPublishers = compile(declarations("src/substrate.ts", ["appendSubagentPhaseLog", "appendSubagentPhaseLogUnobserved", "replacePhaseLogWithTail", "utf8Tail", "configuredPhaseLogMaxBytes"]), {}, "({ appendSubagentPhaseLog })");
  const shape = compile(declarations("src/shapes/verify-only.ts", ["runVerifyOnly", "buildVerifyOnlyPrompt", "buildVerifierAgents", "parseVerifyOnlyResult", "aggregateChecks", "buildFinalResult", "buildDetails", "inferVerifierCount", "extractJson", "extractFenceContents", "extractBalancedObject", "optionalString", "stringArray"]), {
    SpawnGuard: compile(declarations("src/substrate.ts", ["SpawnGuard", "clampSpawnCeiling"]), { SUBSTRATE_CAPS: { MAX_TOTAL_SPAWNS: 200 } }, "SpawnGuard"),
    MAX_VERIFIER_CONCURRENCY: 3, DEFAULT_VERIFIER_COUNT: 1, MAX_VERIFIER_COUNT: 7, MAX_FINAL_CHARS: 20000, MAX_DETAIL_CHARS: 4000, VERIFY_ONLY_TOOLS: ["read", "grep", "find", "ls", "bash"],
    throwIfAborted() {}, truncateWithNotice: text => text, formatRoutedModel: (provider, model) => `${provider}/${model}`, formatRouteLabel: () => "owner-provider/owner-model", toModelOverride: () => ({ provider: "owner-provider", model: "owner-model" }),
    runBoundedPool: realPool,
    assessResultProcessTrees: outputs=>outputs.flatMap(o=>(o.processTrees?.length?o.processTrees:[o.processTree]).map(t=>generations.assessTreeWithObserver(t,()=>cleanup==='survivor'?{status:'alive',startedAt:Date.parse(t.rootBorn),birthIdentity:t.rootBorn}:{status:'dead',evidence:'ESRCH'}))),
    async spawnSubagent(name, task, options) {
      options.reserveSpawn?.(); // This stub stands at the physical child-launch seam.
      const index = task.includes("verifier 2 of 2") ? 1 : 0, count = ++counts[index]; routes.push(options.modelOverride); prompts.push(task);
      if (concurrent && count === 1) { rendezvous[index].resolve(); await rendezvous[1-index].promise; }
      const file = path.join(cwd, `phase-${index}-${count}.result.json`), log = path.join(cwd, `phase-${index}.log`);
      hostState.atomicWriteJsonSync(file, { host: "settled", task });
      logPublishers.appendSubagentPhaseLog(log, "host", `phase ${count}`);
      if (mutation && count === 1) {
        if (mutation === "source-restored") fs.writeFileSync(path.join(cwd, "product.txt"), "worker mutation");
        else if (mutation === "spoofed") fs.writeFileSync(path.join(cwd, "unowned.result.json"), "spoofed host result");
        else if (mutation === "overwritten") { fs.writeFileSync(file, "worker tampering"); hostState.atomicWriteJsonSync(file, { host: "overwrite" }); }
        else if (mutation === "log-tamper") fs.appendFileSync(log, "worker injected bytes");
        else if (mutation === "dependency") fs.writeFileSync(path.join(cwd, "node_modules/package/index.js"), "worker mutation");
        else if (mutation === "evidence") fs.writeFileSync(path.join(evidence, "input.txt"), "worker mutation");
      }
      if (mutation === "source-restored" && count === 2) fs.writeFileSync(path.join(cwd, "product.txt"), "unchanged");
      const born='2026-10-17T00:00:00.0000000Z',pid=60000+index*10+count;
      const processTree={schemaVersion:1,rootPid:pid,rootBorn:born,observedAt:born,members:[{pid,parentPid:1,born}],status:'clean',survivors:[],unknown:cleanup==='unknown'?['fixture_observation_gap']:[]};
      const result = { ...(cleanup==='missing'?{}:{processTree}), agentName: name, provider: "owner-provider", model: "owner-model", task, text: JSON.stringify({ overall: "pass", reasons: [], checks: [{ id: "check-1", description: "check product", status: "pass", citations: ["product.txt:1"] }] }), exitCode: 0, durationMs: 0 };
      if (count === 1) throw new helpers.RoleContextExhaustionError({ ...result, text: "partial" });
      return result;
    },
  }, "runVerifyOnly");
  const task = `${OWNER}\n${concurrent ? "2 verifiers\n" : ""}1. Check product`;
  let output, error;
  try { output = await shape({ params: { cwd, task, verifierAgent: "reviewer", maxSubagents: 8, allowLocalModel: false, externalEvidenceRoots: [evidence] }, agents: new Map([["reviewer", { name: "reviewer", provider: "owner-provider", model: "owner-model" }]]), onUpdate() {} }); } catch (err) { error = err; }
  if (mutation) {
    assert.ok(error, `real ${mutation} must be rejected, not admitted as a host publication`);
    assert.match(error.message, /ROLE_RECOVERY_INTEGRITY/, "semantic integrity failure, not fixture/loader failure");
    assert.equal(counts[0], 1, "a later continuation cannot restore/launder an exhausted worker's mutation");
  } else {
    assert.equal(error, undefined, `configured verification must settle: ${error?.stack}`);
    assert.equal(output.details.status, cleanup ? "fail" : "pass", 'verify-only cleanup gate preserves every attempted generation; clean authentic sidecars remain admitted');
    if(cleanup)assert.ok(output.details.verifierRuns.every(run=>run.reasons.some(reason=>reason.includes('WORKER_PROCESS_GENERATION_NOT_CLEAN'))));
    assert.equal(output.details.processTrees.length,concurrent?4:2,'every exhausted and terminal generation retained');
    assert.equal(output.details.plannerSpawns, 0); assert.equal(output.details.executorSpawns, 0);
    assert.equal(output.details.spawnedCount, concurrent ? 4 : 2);
    for (const run of output.details.verifierRuns) { assert.equal(run.mutations.length, 0); assert.ok(run.roleRecovery.terminalValidated); }
  }
  for (const route of routes) assert.deepEqual(route, { provider: "owner-provider", model: "owner-model" });
  for (const prompt of prompts) assert.ok(prompt.includes(task), "binding checklist reaches each fixed-route continuation intact");
}
async function ownershipLifetime(mode) {
  requireObserver();
  const cwd = fixture(mode), file = path.join(cwd, "host.json"), before = signatures.captureContentSignatureSnapshot(cwd, exhaustive);
  const outer = new publications.HostPublicationObservation(cwd);
  if (mode === "no-history-replay") {
    await publications.withHostPublicationObservation(outer, async () => {
      hostState.atomicWriteJsonSync(file, { generation: 1 });
      // A later nested observation has its own byte boundary, not the parent's
      // history. A second genuine publication must still be attributed.
      await helpers.observeRoleReadOnlyLaunch(cwd, [], async () => hostState.atomicWriteJsonSync(file, { generation: 2 }));
    });
    assert.equal(outer.admittedPaths(before, signatures.captureContentSignatureSnapshot(cwd, exhaustive)).size, 1);
  } else if (mode === "unrelated-run") {
    const start = deferred(), written = deferred();
    // Created OUTSIDE the run's ALS operation: identical cwd is not ownership.
    const unrelated = new publications.HostPublicationObservation(cwd);
    const outsider = start.promise.then(() => publications.withHostPublicationObservation(unrelated, async () => { hostState.atomicWriteJsonSync(file, { unrelated: true }); written.resolve(); }));
    await assert.rejects(publications.withHostPublicationObservation(outer, () => helpers.observeRoleReadOnlyLaunch(cwd, [], async () => { start.resolve(); await written.promise; })), /ROLE_RECOVERY_INTEGRITY/);
    await outsider;
    assert.equal(outer.admittedPaths(before, signatures.captureContentSignatureSnapshot(cwd, exhaustive)).size, 0);
  } else if (mode === "closed-child") {
    let late; const resume = deferred();
    await publications.withHostPublicationObservation(outer, async () => {
      await helpers.observeRoleReadOnlyLaunch(cwd, [], async () => { late = resume.promise.then(() => hostState.atomicWriteJsonSync(file, { staleChild: true })); });
      resume.resolve(); await late;
    });
    assert.equal(outer.admittedPaths(before, signatures.captureContentSignatureSnapshot(cwd, exhaustive)).size, 0, "closed child must not feed a still-active parent via stale async context");
  } else if (mode === "closed-parent") {
    let late; const resume = deferred();
    await publications.withHostPublicationObservation(outer, async () => { late = resume.promise.then(() => hostState.atomicWriteJsonSync(file, { staleParent: true })); });
    resume.resolve(); await late;
    assert.equal(outer.admittedPaths(before, signatures.captureContentSignatureSnapshot(cwd, exhaustive)).size, 0, "closed run cannot authenticate later host writes");
  } else if (mode === "sibling-tamper") {
    const ready = [deferred(), deferred()];
    const results = await publications.withHostPublicationObservation(outer, () => Promise.allSettled([0, 1].map(index => helpers.observeRoleReadOnlyLaunch(cwd, [], async () => {
      ready[index].resolve(); await ready[1-index].promise;
      if (index === 0) hostState.atomicWriteJsonSync(file, { host: true });
      else fs.writeFileSync(file, "worker tamper of sibling host file");
      await Promise.resolve();
    }))));
    assert.ok(results.every(result => result.status === "rejected" && /ROLE_RECOVERY_INTEGRITY/.test(result.reason.message)));
    assert.equal(outer.admittedPaths(before, signatures.captureContentSignatureSnapshot(cwd, exhaustive)).size, 0);
  }
}
const failures = [];
async function check(id, body) { try { await body(); console.log(`PASS ${id}`); } catch (error) { failures.push({ id, error: error.name }); console.log(`RED ${id}: ${error.name}`); } }
(async () => {
  try {
    await check("probe/concurrent-genuine-sibling-host-publications", siblingPublications);
    await check("probe/actual-recovered-verify-only-final-sidecars", () => actualVerifyOnlyPublications());
    await check("probe/actual-configured-concurrent-verify-only", () => actualVerifyOnlyPublications(true));
    for(const cleanup of ['missing','unknown','survivor'])await check(`probe/verify-only-cleanup-${cleanup}`,()=>actualVerifyOnlyPublications(false,undefined,cleanup));
    for (const mode of ["source-restored", "spoofed", "overwritten", "log-tamper", "dependency", "evidence"]) await check(`probe/verify-only-${mode}`, () => actualVerifyOnlyPublications(false, mode));
    for (const mode of ["no-history-replay", "unrelated-run", "closed-child", "closed-parent", "sibling-tamper"]) await check(`probe/${mode}`, () => ownershipLifetime(mode));
    for (const relative of ["src/index.ts", "src/substrate.ts"]) {
      for (const role of ["planner", "verifier"]) for (const mode of ["continuation", "handoff", "provider-context", "sdk-overflow", "shared-profile", "always-exhausted", "spawn-budget", "binding-too-large"]) await check(`${relative}/${role}/${mode}`, () => exercise(relative, role, mode));
      for (const mode of ["capacity", "return-planning", "missing-findings", "mutation", "verifier-build-cache", "evidence-mutation", "visible-main-nested", "visible-main-nested-mutation", "visible-main-readonly-chain"]) await check(`${relative}/verifier/${mode}`, () => exercise(relative, "verifier", mode));
      for (const mode of ["planner-capacity", "return-planning", "changed-criteria", "cycle", "trimmed-id-collision"]) await check(`${relative}/planner/${mode}`, () => exercise(relative, "planner", mode));
      if (relative === "src/substrate.ts") for (const mode of ["verify-only-continuation", "verify-only-chain", "verify-only-missing", "verify-only-cache"]) await check(`actual-shape/${mode}`, () => exercise(relative, "verifier", mode));
    }
  } finally { fs.rmSync(SCRATCH, { recursive: true, force: true }); }
  assert.equal(failures.length, 0, 'role recovery cases failed (safe labels only)');
})().catch(() => { console.error('ROLE_RECOVERY_CHECK_FAILED (safe labels only)'); process.exitCode = 1; });
