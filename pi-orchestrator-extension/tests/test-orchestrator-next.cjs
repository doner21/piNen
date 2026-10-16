#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const next = jiti(path.join(PROJECT_ROOT, "src", "next", "index.ts"));

function loadOrchestrateNextTool() {
  const mod = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({
    registerTool(definition) {
      if (definition.name === "orchestrate_next") tool = definition;
    },
    registerCommand() {},
    sendMessage() {},
  });
  assert.ok(tool, "orchestrate_next tool should be registered");
  return tool;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function result(output, exitCode = 0) {
  return { type: "result", output, exitCode };
}

function info(summary) {
  return { summary, data: {} };
}

function verification(status, summary = status) {
  return {
    status,
    summary,
    checks: [{ id: "machine", status, evidence: ["fixture evidence"] }],
    remaining: status === "pass" ? [] : ["repair required"],
  };
}

function singleAgentSpec({
  name = "single-agent",
  access = "read-only",
  resultMode = "informational",
  outputSchema = "informational-v1",
  retry,
} = {}) {
  return {
    schemaVersion: 2,
    name,
    inputs: { task: { type: "string", required: true } },
    defaults: { timeoutMs: 5_000, maxAttempts: 1 },
    limits: { maxConcurrency: 1, maxTotalAttempts: retry?.maxAttempts ?? 1 },
    phases: [{
      id: "work",
      kind: "agent",
      role: "worker",
      agent: { name: "worker" },
      access,
      workspace: { mode: "shared" },
      resultMode,
      outputSchema,
      input: { task: "${inputs.task}" },
      ...(retry ? { retry } : {}),
    }],
    completion: { terminalPhase: "work", require: resultMode === "gate" ? "pass" : "success" },
  };
}

function twoIsolatedWritersSpec() {
  return {
    schemaVersion: 2,
    name: "two-isolated-writers",
    inputs: { task: { type: "string", required: true } },
    defaults: { timeoutMs: 5_000, maxAttempts: 1 },
    limits: { maxConcurrency: 2, maxTotalAttempts: 3 },
    phases: [
      {
        id: "candidate-a", kind: "agent", role: "worker", agent: { name: "worker" },
        access: "workspace-write", workspace: { mode: "isolated" },
        resultMode: "informational", outputSchema: "informational-v1", input: { task: "${inputs.task}" },
      },
      {
        id: "candidate-b", kind: "agent", role: "worker", agent: { name: "worker" },
        access: "workspace-write", workspace: { mode: "isolated" },
        resultMode: "informational", outputSchema: "informational-v1", input: { task: "${inputs.task}" },
      },
      {
        id: "integrate", kind: "integrate", dependsOn: ["candidate-a", "candidate-b"],
        access: "workspace-write", workspace: { mode: "shared" },
        resultMode: "deterministic", outputSchema: "integration-result-v1",
        integrate: { sources: ["candidate-a", "candidate-b"], strategy: "apply-clean" },
      },
    ],
    completion: { terminalPhase: "integrate", require: "success" },
  };
}

function singleCommandSpec({ name = "single-command", cwd = ".", args = ["check.cjs"], timeoutMs = 1_000, env } = {}) {
  return {
    schemaVersion: 2,
    name,
    inputs: {},
    defaults: { timeoutMs: 5_000, maxAttempts: 1 },
    limits: { maxConcurrency: 1, maxTotalAttempts: 1 },
    phases: [{
      id: "check",
      kind: "deterministic-command",
      access: "read-only",
      workspace: { mode: "shared" },
      resultMode: "deterministic",
      outputSchema: "command-result-v1",
      command: { executable: "node", args, cwd, timeoutMs, maxOutputBytes: 8_192, ...(env ? { env } : {}) },
    }],
    completion: { terminalPhase: "check", require: "success" },
  };
}

function testCompiler() {
  const source = next.readOnlyFanoutJoinPilot();
  const compiled = next.compileWorkflow(source);
  assert.equal(compiled.ir.schemaVersion, 2);
  assert.equal(compiled.hash.length, 64);
  assert.deepEqual(compiled.schedule.waves.map((wave) => wave.map((phase) => phase.id)), [
    ["inspect-api", "inspect-state"],
    ["join-findings"],
  ]);

  const reordered = clone(source);
  reordered.phases.reverse();
  reordered.phases.find((phase) => phase.id === "join-findings").dependsOn.reverse();
  assert.equal(next.compileWorkflow(reordered).hash, compiled.hash, "phase/dependency source order must not alter canonical IR hash");

  const unknown = clone(source);
  unknown.coordinatorShell = true;
  assert.throws(() => next.compileWorkflow(unknown), (error) => error.code === "UNKNOWN_FIELD");

  const cycle = clone(source);
  cycle.phases.find((phase) => phase.id === "inspect-api").dependsOn = ["join-findings"];
  assert.throws(() => next.compileWorkflow(cycle), (error) => error.code === "INVALID_WORKFLOW_GRAPH");

  const missingAccess = clone(source);
  delete missingAccess.phases[0].access;
  assert.throws(() => next.compileWorkflow(missingAccess), (error) => error.code === "INVALID_ACCESS_MODE");

  const twoWriters = clone(source);
  for (const id of ["inspect-api", "inspect-state"]) {
    twoWriters.phases.find((phase) => phase.id === id).access = "workspace-write";
  }
  assert.throws(() => next.compileWorkflow(twoWriters), (error) => error.code === "SHARED_WORKSPACE_WRITER_CONFLICT");

  const unsafeRetry = singleAgentSpec({ retry: { on: ["semantic-failure"], maxAttempts: 2 } });
  assert.throws(() => next.compileWorkflow(unsafeRetry), (error) => error.code === "UNSAFE_RETRY_CATEGORY");

  const wrongGateSchema = singleAgentSpec({ resultMode: "gate", outputSchema: "informational-v1" });
  assert.throws(() => next.compileWorkflow(wrongGateSchema), (error) => error.code === "PHASE_CONTRACT_CONFLICT");
  const weakGateCompletion = singleAgentSpec({ resultMode: "gate", outputSchema: "verification-v1" });
  weakGateCompletion.completion.require = "success";
  assert.throws(() => next.compileWorkflow(weakGateCompletion), (error) => error.code === "INVALID_COMPLETION");

  const isolated = clone(source);
  isolated.phases[0].workspace.mode = "isolated";
  assert.throws(() => next.compileWorkflow(isolated), (error) => error.code === "INVALID_ISOLATED_WORKSPACE");
  const isolatedPev = next.compileWorkflow(next.singleWriterPevPilot());
  assert.equal(isolatedPev.ir.phases.find((phase) => phase.id === "implement").workspace.mode, "isolated");
  assert.deepEqual(isolatedPev.ir.phases.find((phase) => phase.id === "integrate").integrate.sources, ["implement"]);

  const effectExpression = singleAgentSpec();
  effectExpression.phases[0].input.previous = "${phases.other.effects}";
  assert.throws(() => next.compileWorkflow(effectExpression), (error) => error.code === "INVALID_EXPRESSION");

  assert.throws(
    () => next.compileWorkflow(singleCommandSpec({ env: { NODE_OPTIONS: "--require=escape.js" } })),
    (error) => error.code === "UNSAFE_COMMAND_ENV",
  );

  const unknownInput = next.compileWorkflow(singleAgentSpec());
  assert.throws(() => next.validateWorkflowInput(unknownInput.ir, { task: "x", surprise: true }), (error) => error.code === "UNKNOWN_INPUT");
  assert.throws(() => next.validateWorkflowInput(unknownInput.ir, {}), (error) => error.code === "MISSING_INPUT");
}

function testEventStore(tempRoot) {
  const eventRoot = path.join(tempRoot, "event-store");
  const clock = () => new Date("2026-08-23T00:00:00.000Z");
  const store = next.FileEventStore.create(eventRoot, "event-test", clock);
  store.append({ runId: "event-test", type: "run.created", data: {} });
  store.append({ runId: "event-test", type: "workflow.compiled", data: { workflowHash: "a".repeat(64) } });
  assert.deepEqual(store.readAll().map((event) => event.seq), [1, 2]);
  assert.throws(
    () => next.FileEventStore.open(eventRoot, "event-test", clock),
    (error) => error.code === "RUN_ALREADY_OPEN",
    "a second writer must not acquire the same run",
  );
  store.close();
  const reopened = next.FileEventStore.open(eventRoot, "event-test", clock);
  reopened.append({ runId: "event-test", type: "run.completed", data: { status: "pass" } });
  assert.equal(reopened.readAll().length, 3);
  reopened.close();

  const filePath = path.join(eventRoot, "event-test", "events.jsonl");
  fs.appendFileSync(filePath, "{torn", "utf8");
  assert.throws(() => next.FileEventStore.open(eventRoot, "event-test"), (error) => error.code === "TORN_EVENT_LOG");

  const stale = next.FileEventStore.create(eventRoot, "stale-lease", clock);
  stale.append({ runId: "stale-lease", type: "run.created", data: {} });
  stale.close();
  fs.writeFileSync(path.join(eventRoot, "stale-lease", "writer.lock"), `${JSON.stringify({ pid: 2147483647, acquiredAt: clock().toISOString() })}\n`, "utf8");
  const recoveredLease = next.FileEventStore.open(eventRoot, "stale-lease", clock);
  assert.equal(recoveredLease.readAll().length, 1, "dead writer lease should be recovered safely");
  recoveredLease.close();

  const base = [
    { version: 1, runId: "projection", seq: 1, at: clock().toISOString(), type: "run.created", data: {} },
    { version: 1, runId: "projection", seq: 2, at: clock().toISOString(), type: "phase.ready", phaseId: "a", data: {} },
    { version: 1, runId: "projection", seq: 3, at: clock().toISOString(), type: "phase.attempt.started", phaseId: "a", attempt: 1, data: {} },
    { version: 1, runId: "projection", seq: 4, at: clock().toISOString(), type: "effect.observed", phaseId: "a", attempt: 1, data: { effect: { path: "x", kind: "created" } } },
    { version: 1, runId: "projection", seq: 5, at: clock().toISOString(), type: "phase.succeeded", phaseId: "a", attempt: 1, data: {} },
    { version: 1, runId: "projection", seq: 6, at: clock().toISOString(), type: "run.completed", data: {} },
  ];
  const projected = next.projectRun(base);
  const permuted = next.projectRun([base[5], base[3], base[1], base[4], base[0], base[2]]);
  assert.deepEqual(permuted, projected, "projection must sort and replay by authoritative sequence");
  assert.throws(() => next.projectRun([base[0], base[2]]), (error) => error.code === "EVENT_SEQUENCE_GAP");
  const conflicting = [...base, { ...base[5], seq: 7, type: "run.failed" }];
  assert.throws(() => next.projectRun(conflicting), (error) => error.code === "CONFLICTING_RUN_TERMINALS");
}

async function testReadOnlyFanoutJoin(tempRoot) {
  const workspace = path.join(tempRoot, "fanout-workspace");
  fs.mkdirSync(workspace);
  const compiled = next.compileWorkflow(next.readOnlyFanoutJoinPilot());
  const adapter = new next.FakeWorkerAdapter({
    "inspect-api": [{ delayMs: 30, events: [result(info("api finding"))] }],
    "inspect-state": [{ delayMs: 30, events: [result(info("state finding"))] }],
  });
  const store = new next.MemoryEventStore("fanout-run");
  const run = await new next.RunKernel().run(compiled, {
    runId: "fanout-run",
    workspaceRoot: workspace,
    input: { task: "review" },
    eventStore: store,
    agentAdapter: adapter,
  });
  assert.equal(run.status, "pass");
  assert.equal(adapter.stats.maxActive, 2, "independent read-only phases should overlap");
  assert.deepEqual(run.phaseOutcomes["join-findings"].output.phaseIds, ["inspect-api", "inspect-state"]);
  assert.equal(run.projection.status, "succeeded");
}

async function testRetryAndOutcomeUnknown(tempRoot) {
  const workspace = path.join(tempRoot, "fault-workspace");
  fs.mkdirSync(workspace);

  const retryCompiled = next.compileWorkflow(singleAgentSpec({
    name: "retry-before-effects",
    retry: { on: ["provider-transient"], maxAttempts: 2 },
  }));
  const retryAdapter = new next.FakeWorkerAdapter({
    work: [
      { events: [{ type: "failed", category: "provider-transient", message: "overloaded" }] },
      { events: [result(info("recovered"))] },
    ],
  });
  const retryStore = new next.MemoryEventStore("retry-run");
  const retryRun = await new next.RunKernel().run(retryCompiled, {
    runId: "retry-run",
    workspaceRoot: workspace,
    input: { task: "retry" },
    eventStore: retryStore,
    agentAdapter: retryAdapter,
  });
  assert.equal(retryRun.status, "pass");
  assert.equal(retryRun.phaseOutcomes.work.attempt, 2);
  assert.equal(retryAdapter.stats.starts, 2);
  assert.equal(retryStore.readAll().filter((event) => event.type === "phase.retry.scheduled").length, 1);

  const launchCompiled = next.compileWorkflow(singleAgentSpec({
    name: "writer-launch-retry",
    access: "workspace-write",
    retry: { on: ["launch-failure"], maxAttempts: 2 },
  }));
  const launchAdapter = new next.FakeWorkerAdapter({
    work: [
      { emitStarted: false, events: [{ type: "failed", category: "launch-failure", message: "process never started" }] },
      { mutations: [{ path: "launch-recovered.txt", content: "ok\n" }], events: [result(info("recovered writer"))] },
    ],
  });
  const launchRun = await new next.RunKernel().run(launchCompiled, {
    runId: "writer-launch-run",
    workspaceRoot: workspace,
    input: { task: "write after launch recovery" },
    eventStore: new next.MemoryEventStore("writer-launch-run"),
    agentAdapter: launchAdapter,
  });
  assert.equal(launchRun.status, "pass");
  assert.equal(launchRun.phaseOutcomes.work.attempt, 2, "a writer launch failure before start/effects is retry-safe");

  const unknownCompiled = next.compileWorkflow(singleAgentSpec({
    name: "mutation-ack-lost",
    access: "workspace-write",
    retry: { on: ["protocol-failure"], maxAttempts: 2 },
  }));
  const unknownAdapter = new next.FakeWorkerAdapter({
    work: [{
      mutations: [{ path: "preserved.txt", content: "useful work\n" }],
      events: [{ type: "failed", category: "protocol-failure", message: "final response lost" }],
    }],
  });
  const unknownStore = new next.MemoryEventStore("unknown-run");
  const unknownRun = await new next.RunKernel().run(unknownCompiled, {
    runId: "unknown-run",
    workspaceRoot: workspace,
    input: { task: "write" },
    eventStore: unknownStore,
    agentAdapter: unknownAdapter,
  });
  assert.equal(unknownRun.status, "fail");
  assert.equal(unknownRun.phaseOutcomes.work.status, "outcome-unknown");
  assert.equal(unknownAdapter.stats.starts, 1, "writer must not be blindly retried after an observed mutation");
  assert.equal(fs.readFileSync(path.join(workspace, "preserved.txt"), "utf8"), "useful work\n");

  const timeoutSpec = singleAgentSpec({ name: "agent-deadline" });
  timeoutSpec.defaults.timeoutMs = 50;
  const timeoutAdapter = new next.FakeWorkerAdapter({
    work: [{ delayMs: 200, events: [result(info("too late"))] }],
  });
  const timeoutRun = await new next.RunKernel().run(next.compileWorkflow(timeoutSpec), {
    runId: "agent-timeout-run",
    workspaceRoot: workspace,
    input: { task: "timeout" },
    eventStore: new next.MemoryEventStore("agent-timeout-run"),
    agentAdapter: timeoutAdapter,
  });
  assert.equal(timeoutRun.status, "fail");
  assert.equal(timeoutRun.phaseOutcomes.work.category, "budget-exhausted");
  assert.notEqual(timeoutRun.status, "cancelled");
}

async function testEventLogResume(tempRoot) {
  const workspace = path.join(tempRoot, "resume-workspace");
  fs.mkdirSync(workspace);
  const compiled = next.compileWorkflow(next.readOnlyFanoutJoinPilot());
  const store = new next.MemoryEventStore("resume-read-only");
  const append = (type, data = {}, phaseId, attempt) => store.append({
    runId: "resume-read-only",
    type,
    data,
    ...(phaseId ? { phaseId } : {}),
    ...(attempt ? { attempt } : {}),
  });
  append("run.created", { workflow: compiled.ir.name, workspaceRoot: workspace, input: { task: "resume fixture" } });
  append("workflow.compiled", { workflowHash: compiled.hash, canonicalJson: compiled.canonicalJson });
  append("phase.ready", {}, "inspect-api");
  append("phase.attempt.started", { workerRunId: "old-api" }, "inspect-api", 1);
  append("worker.result.validated", { output: info("durable API finding"), schema: "informational-v1" }, "inspect-api", 1);
  append("phase.succeeded", {
    output: info("durable API finding"),
    process: { started: true, exitCode: 0 },
    protocol: { status: "valid", schema: "informational-v1" },
    semantic: { status: "not-applicable" },
    effectStatus: "none",
  }, "inspect-api", 1);
  append("phase.ready", {}, "inspect-state");
  append("phase.attempt.started", { workerRunId: "interrupted-state" }, "inspect-state", 1);

  const adapter = new next.FakeWorkerAdapter({
    "inspect-state": [
      { events: [] },
      { events: [result(info("recovered state finding"))] },
    ],
  });
  const resumed = await new next.RunKernel().run(compiled, {
    runId: "resume-read-only",
    workspaceRoot: workspace,
    input: { task: "resume fixture" },
    eventStore: store,
    agentAdapter: adapter,
  });
  assert.equal(resumed.status, "pass");
  assert.equal(adapter.stats.starts, 1, "resume must not respawn completed phases");
  assert.equal(resumed.phaseOutcomes["inspect-api"].output.summary, "durable API finding");
  assert.equal(resumed.phaseOutcomes["inspect-state"].attempt, 2);
  assert.equal(store.readAll().filter((event) => event.type === "run.resumed").length, 1);

  const pinCompiled = next.compileWorkflow(singleAgentSpec({ name: "resume-pin" }));
  const pinStore = new next.MemoryEventStore("resume-pin");
  pinStore.append({ runId: "resume-pin", type: "run.created", data: { workspaceRoot: workspace, input: { task: "original" } } });
  pinStore.append({ runId: "resume-pin", type: "workflow.compiled", data: { workflowHash: pinCompiled.hash } });
  await assert.rejects(
    () => new next.RunKernel().run(pinCompiled, {
      runId: "resume-pin", workspaceRoot: workspace, input: { task: "changed" }, eventStore: pinStore,
      agentAdapter: new next.FakeWorkerAdapter({}),
    }),
    (error) => error.code === "RESUME_INPUT_MISMATCH",
  );
  const otherWorkspace = path.join(tempRoot, "resume-other-workspace");
  fs.mkdirSync(otherWorkspace);
  await assert.rejects(
    () => new next.RunKernel().run(pinCompiled, {
      runId: "resume-pin", workspaceRoot: otherWorkspace, input: { task: "original" }, eventStore: pinStore,
      agentAdapter: new next.FakeWorkerAdapter({}),
    }),
    (error) => error.code === "RESUME_WORKSPACE_MISMATCH",
  );

  const policyStore = new next.MemoryEventStore("resume-policy-pin");
  policyStore.append({ runId: "resume-policy-pin", type: "run.created", data: { workspaceRoot: workspace, input: { task: "policy" }, runtimePolicy: { adapter: "pi-json-subprocess-v2", allowLocalModel: false } } });
  policyStore.append({ runId: "resume-policy-pin", type: "workflow.compiled", data: { workflowHash: pinCompiled.hash } });
  await assert.rejects(
    () => new next.RunKernel().run(pinCompiled, {
      runId: "resume-policy-pin", workspaceRoot: workspace, input: { task: "policy" }, runtimePolicy: { adapter: "pi-json-subprocess-v2", allowLocalModel: true }, eventStore: policyStore,
      agentAdapter: new next.FakeWorkerAdapter({}),
    }),
    (error) => error.code === "RESUME_RUNTIME_POLICY_MISMATCH",
  );

  const recoveredCompiled = next.compileWorkflow(singleAgentSpec({ name: "recover-validated" }));
  const recoveredStore = new next.MemoryEventStore("recover-validated");
  recoveredStore.append({ runId: "recover-validated", type: "run.created", data: { workspaceRoot: workspace, input: { task: "recover" } } });
  recoveredStore.append({ runId: "recover-validated", type: "workflow.compiled", data: { workflowHash: recoveredCompiled.hash } });
  recoveredStore.append({ runId: "recover-validated", type: "phase.attempt.started", phaseId: "work", attempt: 1, data: {} });
  recoveredStore.append({ runId: "recover-validated", type: "worker.result.validated", phaseId: "work", attempt: 1, data: { output: info("durable validated result"), schema: "informational-v1", processExitCode: 0 } });
  const recoveredAdapter = new next.FakeWorkerAdapter({});
  const recoveredRun = await new next.RunKernel().run(recoveredCompiled, {
    runId: "recover-validated", workspaceRoot: workspace, input: { task: "recover" }, eventStore: recoveredStore,
    agentAdapter: recoveredAdapter,
  });
  assert.equal(recoveredRun.status, "pass");
  assert.equal(recoveredAdapter.stats.starts, 0, "durably validated result should be promoted without respawn");
  assert.equal(recoveredRun.phaseOutcomes.work.output.summary, "durable validated result");

  const nonzeroCompiled = next.compileWorkflow(singleCommandSpec({ name: "recover-nonzero-command" }));
  const nonzeroStore = new next.MemoryEventStore("recover-nonzero-command");
  nonzeroStore.append({ runId: "recover-nonzero-command", type: "run.created", data: { workspaceRoot: workspace, input: {} } });
  nonzeroStore.append({ runId: "recover-nonzero-command", type: "workflow.compiled", data: { workflowHash: nonzeroCompiled.hash } });
  nonzeroStore.append({ runId: "recover-nonzero-command", type: "phase.attempt.started", phaseId: "check", attempt: 1, data: {} });
  nonzeroStore.append({ runId: "recover-nonzero-command", type: "worker.result.validated", phaseId: "check", attempt: 1, data: {
    output: { exitCode: 2, stdout: "", stderr: "failed" }, schema: "command-result-v1", processExitCode: 2,
  } });
  const nonzeroRun = await new next.RunKernel().run(nonzeroCompiled, {
    runId: "recover-nonzero-command", workspaceRoot: workspace, input: {}, eventStore: nonzeroStore,
    agentAdapter: new next.FakeWorkerAdapter({}),
  });
  assert.equal(nonzeroRun.status, "fail");
  assert.equal(nonzeroRun.phaseOutcomes.check.category, "deterministic-check-failure");
  assert.equal(nonzeroRun.phaseOutcomes.check.process.exitCode, 2);

  const invalidStore = new next.MemoryEventStore("resume-invalid-output");
  invalidStore.append({ runId: "resume-invalid-output", type: "run.created", data: { workspaceRoot: workspace, input: { task: "invalid" } } });
  invalidStore.append({ runId: "resume-invalid-output", type: "workflow.compiled", data: { workflowHash: recoveredCompiled.hash } });
  invalidStore.append({ runId: "resume-invalid-output", type: "phase.succeeded", phaseId: "work", attempt: 1, data: { output: { summary: 42 } } });
  await assert.rejects(
    () => new next.RunKernel().run(recoveredCompiled, {
      runId: "resume-invalid-output", workspaceRoot: workspace, input: { task: "invalid" }, eventStore: invalidStore,
      agentAdapter: new next.FakeWorkerAdapter({}),
    }),
    (error) => error.code === "RESUME_OUTPUT_INVALID",
  );

  const pev = next.compileWorkflow(singleAgentSpec({ name: "resume-shared-writer", access: "workspace-write" }));
  const writerStore = new next.MemoryEventStore("resume-writer");
  const writerAppend = (type, data = {}, phaseId, attempt) => writerStore.append({
    runId: "resume-writer", type, data,
    ...(phaseId ? { phaseId } : {}),
    ...(attempt ? { attempt } : {}),
  });
  writerAppend("run.created", { workflow: pev.ir.name, workspaceRoot: workspace, input: { task: "writer crash" } });
  writerAppend("workflow.compiled", { workflowHash: pev.hash, canonicalJson: pev.canonicalJson });
  writerAppend("phase.attempt.started", { workerRunId: "resume-writer:work:1" }, "work", 1);
  const writerAdapter = new next.FakeWorkerAdapter({});
  const writerResume = await new next.RunKernel().run(pev, {
    runId: "resume-writer",
    workspaceRoot: workspace,
    input: { task: "writer crash" },
    eventStore: writerStore,
    agentAdapter: writerAdapter,
  });
  assert.equal(writerResume.status, "fail");
  assert.equal(writerResume.phaseOutcomes.work.status, "outcome-unknown");
  assert.equal(writerAdapter.stats.starts, 0, "interrupted shared writer must never be blindly replayed");
}

async function testIsolatedWorkspaceIntegration(tempRoot) {
  const workspace = path.join(tempRoot, "isolated-product");
  const runDirectory = path.join(tempRoot, "isolated-runtime", "run-one");
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "node_modules", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".git", "config"), "product git metadata\n", "utf8");
  fs.writeFileSync(path.join(workspace, "dirty.txt"), "dirty baseline\n", "utf8");
  fs.writeFileSync(path.join(workspace, "node_modules", "fixture", "ignored-prerequisite.txt"), "required\n", "utf8");

  const compiled = next.compileWorkflow(next.singleWriterPevPilot());
  const implement = compiled.ir.phases.find((phase) => phase.id === "implement");
  const integrate = compiled.ir.phases.find((phase) => phase.id === "integrate");
  const manager = new next.SnapshotWorkspaceManager({ runDirectory });
  const binding = await manager.prepare({ runId: "isolated-manual", phase: implement, attempt: 1, productRoot: workspace });
  assert.notEqual(binding.root, fs.realpathSync(workspace));
  assert.equal(fs.existsSync(path.join(binding.root, ".git")), false, "isolated candidate must exclude shared Git administration");
  assert.equal(fs.readFileSync(path.join(binding.root, "dirty.txt"), "utf8"), "dirty baseline\n", "dirty tracked state must be copied");
  assert.equal(fs.readFileSync(path.join(binding.root, "node_modules", "fixture", "ignored-prerequisite.txt"), "utf8"), "required\n", "ignored prerequisites must be copied");
  fs.writeFileSync(path.join(binding.root, "dirty.txt"), "candidate change\n", "utf8");
  fs.writeFileSync(path.join(binding.root, "created.txt"), "candidate file\n", "utf8");
  assert.equal(fs.readFileSync(path.join(workspace, "dirty.txt"), "utf8"), "dirty baseline\n", "candidate work must not mutate product before integrate");
  const applied = await manager.integrate({ runId: "isolated-manual", phase: integrate, attempt: 1, productRoot: workspace, sources: [binding] });
  assert.equal(applied.output.status, "integrated");
  assert.equal(fs.readFileSync(path.join(workspace, "dirty.txt"), "utf8"), "candidate change\n");
  assert.equal(fs.readFileSync(path.join(workspace, "created.txt"), "utf8"), "candidate file\n");
  assert.equal(fs.readFileSync(path.join(workspace, ".git", "config"), "utf8"), "product git metadata\n");

  const conflictBinding = await manager.prepare({ runId: "isolated-manual", phase: implement, attempt: 2, productRoot: workspace });
  fs.writeFileSync(path.join(conflictBinding.root, "dirty.txt"), "candidate two\n", "utf8");
  fs.writeFileSync(path.join(workspace, "dirty.txt"), "user changed after isolation\n", "utf8");
  await assert.rejects(
    () => manager.integrate({ runId: "isolated-manual", phase: integrate, attempt: 2, productRoot: workspace, sources: [conflictBinding] }),
    /INTEGRATION_PRODUCT_CONFLICT/,
  );
  assert.equal(fs.readFileSync(path.join(workspace, "dirty.txt"), "utf8"), "user changed after isolation\n", "conflicting user bytes must be preserved");
  const createConflictBinding = await manager.prepare({ runId: "isolated-manual", phase: implement, attempt: 3, productRoot: workspace });
  fs.writeFileSync(path.join(createConflictBinding.root, "late-created.txt"), "candidate late file\n", "utf8");
  fs.writeFileSync(path.join(workspace, "late-created.txt"), "user late file\n", "utf8");
  await assert.rejects(
    () => manager.integrate({ runId: "isolated-manual", phase: integrate, attempt: 3, productRoot: workspace, sources: [createConflictBinding] }),
    /INTEGRATION_PRODUCT_CONFLICT/,
  );
  assert.equal(fs.readFileSync(path.join(workspace, "late-created.txt"), "utf8"), "user late file\n", "user-created target after isolation must never be overwritten");

  const outsideEscape = path.join(tempRoot, "integration-outside-escape");
  fs.mkdirSync(path.join(workspace, "safe-parent"));
  fs.mkdirSync(outsideEscape);
  const escapeBinding = await manager.prepare({ runId: "isolated-manual", phase: implement, attempt: 4, productRoot: workspace });
  fs.writeFileSync(path.join(escapeBinding.root, "safe-parent", "escaped.txt"), "must stay contained\n", "utf8");
  fs.rmSync(path.join(workspace, "safe-parent"), { recursive: true, force: true });
  fs.symlinkSync(outsideEscape, path.join(workspace, "safe-parent"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => manager.integrate({ runId: "isolated-manual", phase: integrate, attempt: 4, productRoot: workspace, sources: [escapeBinding] }),
    /INTEGRATION_PATH_ESCAPE/,
  );
  assert.equal(fs.existsSync(path.join(outsideEscape, "escaped.txt")), false, "integration must never follow a swapped product ancestor junction");
  fs.rmSync(path.join(workspace, "safe-parent"), { recursive: true, force: true });

  const parallelWorkspace = path.join(tempRoot, "parallel-isolated-product");
  const parallelRuntime = path.join(tempRoot, "parallel-isolated-runtime", "run");
  fs.mkdirSync(parallelWorkspace);
  const parallel = await new next.RunKernel().run(next.compileWorkflow(twoIsolatedWritersSpec()), {
    runId: "parallel-isolated",
    workspaceRoot: parallelWorkspace,
    input: { task: "produce candidates" },
    eventStore: new next.MemoryEventStore("parallel-isolated"),
    agentAdapter: new next.FakeWorkerAdapter({
      "candidate-a": [{ mutations: [{ path: "same.txt", content: "A\n" }], events: [result(info("candidate A"))] }],
      "candidate-b": [{ mutations: [{ path: "same.txt", content: "B\n" }], events: [result(info("candidate B"))] }],
    }),
    workspaceManager: new next.SnapshotWorkspaceManager({ runDirectory: parallelRuntime }),
  });
  assert.equal(parallel.status, "fail");
  assert.equal(parallel.phaseOutcomes.integrate.category, "authorization-violation");
  assert.match(parallel.phaseOutcomes.integrate.error, /INTEGRATION_CANDIDATE_CONFLICT/);
  assert.equal(fs.existsSync(path.join(parallelWorkspace, "same.txt")), false, "conflicting candidates must not partially integrate");
  assert.notEqual(parallel.phaseOutcomes["candidate-a"].workspace.root, parallel.phaseOutcomes["candidate-b"].workspace.root);

  const rollbackWorkspace = path.join(tempRoot, "integration-rollback-product");
  const rollbackRuntime = path.join(tempRoot, "integration-rollback-runtime", "run");
  fs.mkdirSync(path.join(rollbackWorkspace, "tree"), { recursive: true });
  fs.writeFileSync(path.join(rollbackWorkspace, "alpha.txt"), "alpha original\n", "utf8");
  fs.writeFileSync(path.join(rollbackWorkspace, "tree", "inside.txt"), "inside original\n", "utf8");
  const rollbackManager = new next.SnapshotWorkspaceManager({ runDirectory: rollbackRuntime, faultAfterAppliedEffects: 3 });
  const rollbackBinding = await rollbackManager.prepare({ runId: "rollback-run", phase: implement, attempt: 1, productRoot: rollbackWorkspace });
  fs.writeFileSync(path.join(rollbackBinding.root, "alpha.txt"), "alpha candidate\n", "utf8");
  fs.rmSync(path.join(rollbackBinding.root, "tree"), { recursive: true, force: true });
  fs.writeFileSync(path.join(rollbackBinding.root, "tree"), "directory became file\n", "utf8");
  await assert.rejects(
    () => rollbackManager.integrate({ runId: "rollback-run", phase: integrate, attempt: 1, productRoot: rollbackWorkspace, sources: [rollbackBinding] }),
    /INTEGRATION_INJECTED_FAILURE/,
  );
  assert.equal(fs.readFileSync(path.join(rollbackWorkspace, "alpha.txt"), "utf8"), "alpha original\n", "rollback must restore already-modified files");
  assert.equal(fs.statSync(path.join(rollbackWorkspace, "tree")).isDirectory(), true, "rollback must restore prior directory type");
  assert.equal(fs.readFileSync(path.join(rollbackWorkspace, "tree", "inside.txt"), "utf8"), "inside original\n", "rollback must restore prior directory contents");
}

async function testDurableSurvivorAndResumeProvenance(tempRoot) {
  const workspace = path.join(tempRoot, "durable-survivor-workspace");
  const runDirectory = path.join(tempRoot, "durable-survivor-runtime", "survivor-run");
  fs.mkdirSync(workspace);
  fs.mkdirSync(runDirectory, { recursive: true });
  const compiled = next.compileWorkflow(singleAgentSpec({ name: "durable-survivor" }));
  const store = new next.MemoryEventStore("survivor-run");
  store.append({ runId: "survivor-run", type: "run.created", data: { workspaceRoot: workspace, input: { task: "survive" } } });
  store.append({ runId: "survivor-run", type: "workflow.compiled", data: { workflowHash: compiled.hash, canonicalJson: compiled.canonicalJson } });
  const workerRunId = "survivor-run:work:1";
  store.append({ runId: "survivor-run", type: "phase.attempt.started", phaseId: "work", attempt: 1, data: { workerRunId } });
  const workerKey = createHash("sha256").update(workerRunId).digest("hex");
  const workerDirectory = path.join(runDirectory, "workers", workerKey);
  const resultFile = path.join(workerDirectory, "result.json");
  const manifestFile = path.join(workerDirectory, "survivor.manifest.json");
  fs.mkdirSync(workerDirectory, { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify({ pid: process.pid, resultFile })}\n`, "utf8");
  store.append({ runId: "survivor-run", type: "worker.detached", phaseId: "work", attempt: 1, data: { publication: { manifestFile, resultFile, pid: process.pid } } });
  const adapter = new next.PiSubprocessWorkerAdapter({ agents: new Map(), allowLocalModel: false, runDirectory });
  const pending = await new next.RunKernel().run(compiled, {
    runId: "survivor-run", workspaceRoot: workspace, input: { task: "survive" }, eventStore: store, agentAdapter: adapter,
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.phaseOutcomes.work.category, "result-file-pending");
  assert.equal(pending.projection.status, "paused");
  assert.equal(store.readAll().filter((event) => event.type === "phase.attempt.started").length, 1, "live survivor must not respawn");

  fs.writeFileSync(resultFile, `${JSON.stringify({
    agentName: "worker", task: "survive", text: JSON.stringify(info("durably published")), stderr: "", exitCode: 0,
    durationMs: 1, events: 1, toolCalls: { total: 0, mutating: 0, byName: {} },
  })}\n`, "utf8");
  const promoted = await new next.RunKernel().run(compiled, {
    runId: "survivor-run", workspaceRoot: workspace, input: { task: "survive" }, eventStore: store,
    agentAdapter: new next.PiSubprocessWorkerAdapter({ agents: new Map(), allowLocalModel: false, runDirectory }),
  });
  assert.equal(promoted.status, "pass");
  assert.equal(promoted.phaseOutcomes.work.output.summary, "durably published");
  assert.equal(promoted.phaseOutcomes.work.process.exitCode, 0);
  assert.ok(store.readAll().some((event) => event.type === "worker.result.published"));

  const mismatchCompiled = next.compileWorkflow(singleAgentSpec({ name: "publication-mismatch" }));
  const mismatchStore = new next.MemoryEventStore("publication-mismatch");
  const mismatchWorkerId = "publication-mismatch:work:1";
  const mismatchRuntime = path.join(tempRoot, "publication-mismatch-runtime", "run");
  const mismatchWorkerDirectory = path.join(mismatchRuntime, "workers", createHash("sha256").update(mismatchWorkerId).digest("hex"));
  const mismatchResultFile = path.join(mismatchWorkerDirectory, "result.json");
  const mismatchManifestFile = path.join(mismatchWorkerDirectory, "survivor.manifest.json");
  fs.mkdirSync(mismatchWorkerDirectory, { recursive: true });
  fs.writeFileSync(mismatchResultFile, `${JSON.stringify({
    agentName: "worker", task: "mismatch", text: JSON.stringify(info("must not promote")), stderr: "", exitCode: 0,
    durationMs: 1, events: 1, toolCalls: { total: 0, mutating: 0, byName: {} },
  })}\n`, "utf8");
  fs.writeFileSync(mismatchManifestFile, `${JSON.stringify({ pid: process.pid, resultFile: mismatchResultFile })}\n`, "utf8");
  mismatchStore.append({ runId: "publication-mismatch", type: "run.created", data: { workspaceRoot: workspace, input: { task: "mismatch" } } });
  mismatchStore.append({ runId: "publication-mismatch", type: "workflow.compiled", data: { workflowHash: mismatchCompiled.hash } });
  mismatchStore.append({ runId: "publication-mismatch", type: "phase.attempt.started", phaseId: "work", attempt: 1, data: { workerRunId: mismatchWorkerId } });
  mismatchStore.append({ runId: "publication-mismatch", type: "worker.detached", phaseId: "work", attempt: 1, data: { publication: {
    manifestFile: path.join(mismatchRuntime, "bogus.manifest.json"), resultFile: path.join(mismatchRuntime, "bogus.result.json"),
  } } });
  const mismatchResume = await new next.RunKernel().run(mismatchCompiled, {
    runId: "publication-mismatch", workspaceRoot: workspace, input: { task: "mismatch" }, eventStore: mismatchStore,
    agentAdapter: new next.PiSubprocessWorkerAdapter({ agents: new Map(), allowLocalModel: false, runDirectory: mismatchRuntime }),
  });
  assert.equal(mismatchResume.status, "fail");
  assert.equal(mismatchStore.readAll().some((event) => event.type === "phase.succeeded"), false, "detached event must match the exact inspected publication paths");

  const ambiguousCompiled = next.compileWorkflow(singleAgentSpec({ name: "ambiguous-shared-writer", access: "workspace-write" }));
  const ambiguousStore = new next.MemoryEventStore("ambiguous-crash-window");
  const ambiguousWorkerId = "ambiguous-crash-window:work:1";
  const ambiguousRuntime = path.join(tempRoot, "ambiguous-runtime", "run");
  const ambiguousKey = createHash("sha256").update(ambiguousWorkerId).digest("hex");
  const ambiguousWorkerDirectory = path.join(ambiguousRuntime, "workers", ambiguousKey);
  fs.mkdirSync(ambiguousWorkerDirectory, { recursive: true });
  const ambiguousCandidateFile = path.join(ambiguousWorkerDirectory, "candidate.json");
  const ambiguousResultFile = path.join(ambiguousWorkerDirectory, "result.json");
  const ambiguousManifestFile = path.join(ambiguousWorkerDirectory, "survivor.manifest.json");
  const ambiguousRawCandidate = {
    agentName: "worker", task: "ambiguous", text: JSON.stringify(info("ambiguous candidate")), stderr: "transport lost", exitCode: 0,
    durationMs: 1, events: 1, toolCalls: { total: 1, mutating: 1, byName: { write: 1 } },
  };
  fs.writeFileSync(ambiguousCandidateFile, `${JSON.stringify(ambiguousRawCandidate)}\n`, "utf8");
  // Adversarial stale/misrouted bytes at the survivor result path must still
  // not override event-log candidate provenance.
  fs.writeFileSync(ambiguousResultFile, `${JSON.stringify(ambiguousRawCandidate)}\n`, "utf8");
  fs.writeFileSync(ambiguousManifestFile, `${JSON.stringify({ pid: process.pid, resultFile: ambiguousResultFile })}\n`, "utf8");
  ambiguousStore.append({ runId: "ambiguous-crash-window", type: "run.created", data: { workspaceRoot: workspace, input: { task: "ambiguous" } } });
  ambiguousStore.append({ runId: "ambiguous-crash-window", type: "workflow.compiled", data: { workflowHash: ambiguousCompiled.hash } });
  ambiguousStore.append({ runId: "ambiguous-crash-window", type: "phase.attempt.started", phaseId: "work", attempt: 1, data: { workerRunId: ambiguousWorkerId } });
  ambiguousStore.append({ runId: "ambiguous-crash-window", type: "effect.observed", phaseId: "work", attempt: 1, data: { effect: { path: "ambiguous.txt", kind: "created" } } });
  ambiguousStore.append({ runId: "ambiguous-crash-window", type: "worker.transport.failed", phaseId: "work", attempt: 1, data: { category: "candidate-result-preserved", message: "crash before phase terminal" } });
  ambiguousStore.append({ runId: "ambiguous-crash-window", type: "worker.candidate.preserved", phaseId: "work", attempt: 1, data: { publication: {
    manifestFile: ambiguousManifestFile,
    resultFile: ambiguousResultFile,
    candidateFile: ambiguousCandidateFile,
  } } });
  const ambiguousResume = await new next.RunKernel().run(ambiguousCompiled, {
    runId: "ambiguous-crash-window", workspaceRoot: workspace, input: { task: "ambiguous" }, eventStore: ambiguousStore,
    agentAdapter: new next.PiSubprocessWorkerAdapter({ agents: new Map(), allowLocalModel: false, runDirectory: ambiguousRuntime }),
  });
  assert.equal(ambiguousResume.status, "fail");
  assert.equal(ambiguousResume.phaseOutcomes.work.status, "outcome-unknown");
  assert.equal(ambiguousStore.readAll().some((event) => event.type === "phase.succeeded"), false, "ambiguous candidate publication must never be promoted as survivor success");
  assert.equal(fs.existsSync(ambiguousResultFile), true, "adversarial result-path fixture should exist");

  const fallbackStore = new next.MemoryEventStore("provenance-fallback");
  const fallbackCompiled = next.compileWorkflow(singleCommandSpec({ name: "provenance-fallback" }));
  fallbackStore.append({ runId: "provenance-fallback", type: "run.created", data: { workspaceRoot: workspace, input: {} } });
  fallbackStore.append({ runId: "provenance-fallback", type: "workflow.compiled", data: { workflowHash: fallbackCompiled.hash } });
  fallbackStore.append({ runId: "provenance-fallback", type: "phase.attempt.started", phaseId: "check", attempt: 1, data: {} });
  fallbackStore.append({ runId: "provenance-fallback", type: "worker.result.received", phaseId: "check", attempt: 1, data: { exitCode: 3 } });
  fallbackStore.append({ runId: "provenance-fallback", type: "worker.result.validated", phaseId: "check", attempt: 1, data: { output: { exitCode: 3, stdout: "", stderr: "old log" }, schema: "command-result-v1" } });
  const fallbackRecovered = await new next.RunKernel().run(fallbackCompiled, {
    runId: "provenance-fallback", workspaceRoot: workspace, input: {}, eventStore: fallbackStore,
    agentAdapter: new next.FakeWorkerAdapter({}),
  });
  assert.equal(fallbackRecovered.phaseOutcomes.check.category, "deterministic-check-failure", "old received-event exit provenance must be preserved");
  assert.equal(fallbackRecovered.phaseOutcomes.check.process.exitCode, 3);

  const missingStore = new next.MemoryEventStore("provenance-missing");
  const missingCompiled = next.compileWorkflow(singleAgentSpec({ name: "provenance-missing" }));
  missingStore.append({ runId: "provenance-missing", type: "run.created", data: { workspaceRoot: workspace, input: { task: "missing" } } });
  missingStore.append({ runId: "provenance-missing", type: "workflow.compiled", data: { workflowHash: missingCompiled.hash } });
  missingStore.append({ runId: "provenance-missing", type: "phase.attempt.started", phaseId: "work", attempt: 1, data: {} });
  missingStore.append({ runId: "provenance-missing", type: "worker.result.validated", phaseId: "work", attempt: 1, data: { output: info("missing exit"), schema: "informational-v1" } });
  await assert.rejects(
    () => new next.RunKernel().run(missingCompiled, {
      runId: "provenance-missing", workspaceRoot: workspace, input: { task: "missing" }, eventStore: missingStore,
      agentAdapter: new next.FakeWorkerAdapter({}),
    }),
    (error) => error.code === "RESUME_PROCESS_PROVENANCE_MISSING",
  );

  for (const [id, resultMode, outputSchema, output, exitCode, expectedCategory] of [
    ["recovered-gate-fail", "gate", "verification-v1", verification("fail", "published fail"), 0, "semantic-failure"],
    ["recovered-agent-nonzero", "informational", "informational-v1", info("valid envelope"), 7, "protocol-failure"],
  ]) {
    const itemCompiled = next.compileWorkflow(singleAgentSpec({ name: id, resultMode, outputSchema }));
    const itemStore = new next.MemoryEventStore(id);
    itemStore.append({ runId: id, type: "run.created", data: { workspaceRoot: workspace, input: { task: id } } });
    itemStore.append({ runId: id, type: "workflow.compiled", data: { workflowHash: itemCompiled.hash } });
    itemStore.append({ runId: id, type: "phase.attempt.started", phaseId: "work", attempt: 1, data: {} });
    itemStore.append({ runId: id, type: "worker.result.validated", phaseId: "work", attempt: 1, data: { output, schema: outputSchema, processExitCode: exitCode } });
    const recovered = await new next.RunKernel().run(itemCompiled, {
      runId: id, workspaceRoot: workspace, input: { task: id }, eventStore: itemStore,
      agentAdapter: new next.FakeWorkerAdapter({}),
    });
    assert.equal(recovered.status, "fail");
    assert.equal(recovered.phaseOutcomes.work.category, expectedCategory);
  }
}

async function testSemanticGateIsIndependentOfExit(tempRoot) {
  const workspace = path.join(tempRoot, "gate-workspace");
  fs.mkdirSync(workspace);
  const compiled = next.compileWorkflow(singleAgentSpec({
    name: "semantic-gate",
    resultMode: "gate",
    outputSchema: "verification-v1",
  }));
  const adapter = new next.FakeWorkerAdapter({ work: [{ events: [result(verification("fail", "behavior is wrong"), 0)] }] });
  const run = await new next.RunKernel().run(compiled, {
    runId: "semantic-run",
    workspaceRoot: workspace,
    input: { task: "verify" },
    eventStore: new next.MemoryEventStore("semantic-run"),
    agentAdapter: adapter,
  });
  assert.equal(run.status, "fail");
  assert.equal(run.phaseOutcomes.work.process.exitCode, 0);
  assert.equal(run.phaseOutcomes.work.protocol.status, "valid");
  assert.equal(run.phaseOutcomes.work.semantic.status, "fail");
  assert.equal(run.phaseOutcomes.work.category, "semantic-failure");

  const hiddenAdapter = new next.FakeWorkerAdapter({
    work: [{
      inspectionEffects: [{ path: "hidden-write.txt", kind: "created" }],
      events: [result(info("claimed read-only"))],
    }],
  });
  const hidden = await new next.RunKernel().run(next.compileWorkflow(singleAgentSpec({ name: "inspected-read-only-effect" })), {
    runId: "inspected-effect-run",
    workspaceRoot: workspace,
    input: { task: "inspect" },
    eventStore: new next.MemoryEventStore("inspected-effect-run"),
    agentAdapter: hiddenAdapter,
  });
  assert.equal(hidden.status, "fail");
  assert.equal(hidden.phaseOutcomes.work.category, "authorization-violation");
  assert.equal(hidden.phaseOutcomes.work.effects.status, "observed");
}

async function testCommandAdapterSafety(tempRoot) {
  const workspace = path.join(tempRoot, "command-workspace");
  const outside = path.join(tempRoot, "command-outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "check.cjs"), "console.log('escaped')\n", "utf8");
  const linked = path.join(workspace, "linked-outside");
  fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const adapter = new next.CommandWorkerAdapter({ executables: { node: process.execPath } });
  assert.throws(() => new next.CommandWorkerAdapter({ executables: { node: "node" } }), /absolute existing files/);
  const fixedInputAdapter = new next.CommandWorkerAdapter({
    executables: { node: process.execPath },
    fixedArgs: { node: ["-", "expected"] },
    fixedStdin: { node: "if (process.argv[2] !== 'expected') process.exit(7);\n" },
  });
  const fixedInputWorkspace = path.join(tempRoot, "fixed-stdin-workspace");
  fs.mkdirSync(fixedInputWorkspace);
  const fixedInputRun = await new next.RunKernel().run(next.compileWorkflow(singleCommandSpec({ name: "fixed-stdin-args", args: ["ignored.cjs"] })), {
    runId: "fixed-stdin-args-run",
    workspaceRoot: fixedInputWorkspace,
    input: {},
    eventStore: new next.MemoryEventStore("fixed-stdin-args-run"),
    agentAdapter: new next.FakeWorkerAdapter({}),
    commandAdapter: fixedInputAdapter,
  });
  assert.equal(fixedInputRun.status, "pass", "host-owned stdin execution must preserve pinned trailing validator args");

  const escaped = await new next.RunKernel().run(next.compileWorkflow(singleCommandSpec({ cwd: "linked-outside" })), {
    runId: "command-escape-run",
    workspaceRoot: workspace,
    input: {},
    eventStore: new next.MemoryEventStore("command-escape-run"),
    agentAdapter: new next.FakeWorkerAdapter({}),
    commandAdapter: adapter,
  });
  assert.equal(escaped.status, "fail");
  assert.equal(escaped.phaseOutcomes.check.category, "authorization-violation");
  assert.equal(escaped.phaseOutcomes.check.process.started, false);

  fs.writeFileSync(path.join(workspace, "noop.cjs"), "console.log('noop');\n", "utf8");
  const unobservableLink = await new next.RunKernel().run(next.compileWorkflow(singleCommandSpec({
    name: "command-symlink-observation",
    args: ["noop.cjs"],
  })), {
    runId: "command-symlink-run",
    workspaceRoot: workspace,
    input: {},
    eventStore: new next.MemoryEventStore("command-symlink-run"),
    agentAdapter: new next.FakeWorkerAdapter({}),
    commandAdapter: adapter,
  });
  assert.equal(unobservableLink.status, "fail");
  assert.equal(unobservableLink.phaseOutcomes.check.category, "effects-unobservable");
  assert.equal(unobservableLink.phaseOutcomes.check.process.started, false);
  fs.rmSync(linked, { recursive: true, force: true });

  fs.writeFileSync(path.join(workspace, "hang.cjs"), "setInterval(() => {}, 1000);\n", "utf8");
  const started = Date.now();
  const timed = await new next.RunKernel().run(next.compileWorkflow(singleCommandSpec({
    name: "bounded-command-timeout",
    args: ["hang.cjs"],
    timeoutMs: 100,
  })), {
    runId: "command-timeout-run",
    workspaceRoot: workspace,
    input: {},
    eventStore: new next.MemoryEventStore("command-timeout-run"),
    agentAdapter: new next.FakeWorkerAdapter({}),
    commandAdapter: adapter,
  });
  assert.equal(timed.status, "fail");
  assert.equal(timed.phaseOutcomes.check.category, "deterministic-check-failure");
  assert.ok(Date.now() - started < 3_000, "timeout must terminate even a long-running child");

  fs.writeFileSync(path.join(workspace, "mutate.cjs"), "require('node:fs').writeFileSync('command-created.txt', 'bad\\n');\n", "utf8");
  const mutating = await new next.RunKernel().run(next.compileWorkflow(singleCommandSpec({
    name: "read-only-command-mutation",
    args: ["mutate.cjs"],
  })), {
    runId: "command-mutation-run",
    workspaceRoot: workspace,
    input: {},
    eventStore: new next.MemoryEventStore("command-mutation-run"),
    agentAdapter: new next.FakeWorkerAdapter({}),
    commandAdapter: adapter,
  });
  assert.equal(mutating.status, "fail");
  assert.equal(mutating.phaseOutcomes.check.category, "authorization-violation");
  assert.deepEqual(mutating.phaseOutcomes.check.effects.mutations, [{ path: "command-created.txt", kind: "created" }]);
}

async function testSingleWriterPevFixture(tempRoot) {
  const workspace = path.join(tempRoot, "pev-workspace");
  const eventRoot = path.join(tempRoot, "pev-events-outside-product");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "validate.cjs"), [
    "const fs = require('node:fs');",
    "const actual = fs.readFileSync('product.txt', 'utf8');",
    "if (actual !== 'built\\n') { console.error(JSON.stringify({ actual })); process.exit(2); }",
    "console.log(JSON.stringify({ ok: true }));",
    "",
  ].join("\n"), "utf8");

  const compiled = next.compileWorkflow(next.singleWriterPevPilot());
  const agent = new next.FakeWorkerAdapter({
    plan: [{ events: [result({ summary: "write product", steps: ["create product.txt"] })] }],
    implement: [{
      mutations: [{ path: "product.txt", content: "built\n" }],
      events: [result({ summary: "built fixture", files: ["product.txt"], tests: [] })],
    }],
    verify: [{ events: [result(verification("pass", "machine check passed"))] }],
  });
  const command = new next.CommandWorkerAdapter({ executables: { node: process.execPath } });
  const store = next.FileEventStore.create(eventRoot, "pev-run");
  const run = await new next.RunKernel().run(compiled, {
    runId: "pev-run",
    workspaceRoot: workspace,
    input: { task: "build the fixture" },
    eventStore: store,
    agentAdapter: agent,
    commandAdapter: command,
    workspaceManager: new next.SnapshotWorkspaceManager({ runDirectory: path.join(eventRoot, "pev-run") }),
  });

  assert.equal(run.status, "pass");
  assert.equal(run.phaseOutcomes.test.process.exitCode, 0);
  assert.equal(run.phaseOutcomes.verify.semantic.status, "pass");
  assert.equal(fs.readFileSync(path.join(workspace, "product.txt"), "utf8"), "built\n");
  assert.equal(fs.existsSync(path.join(workspace, "events.jsonl")), false, "orchestration event state must stay outside the product workspace");
  assert.ok(fs.existsSync(path.join(eventRoot, "pev-run", "events.jsonl")));
  store.close();
}

async function testRealPiAdapterAndPublicTool(tempRoot) {
  const workspace = path.join(tempRoot, "real-pi-workspace");
  const runsRoot = path.join(tempRoot, "real-pi-runs");
  const logPath = path.join(tempRoot, "real-pi-log.jsonl");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "validate.cjs"), [
    "const fs = require('node:fs');",
    "if (fs.readFileSync('product.txt', 'utf8') !== 'built\\n') process.exit(2);",
    "console.log('fixture valid');",
    "",
  ].join("\n"), "utf8");

  const saved = {
    PI_CLI_PATH: process.env.PI_CLI_PATH,
    FAKE_PI_LOG: process.env.FAKE_PI_LOG,
    FAKE_PI_NEXT_TARGET: process.env.FAKE_PI_NEXT_TARGET,
    FAKE_PI_NEXT_CONTENT: process.env.FAKE_PI_NEXT_CONTENT,
    FAKE_PI_NEXT_DELAY_MS: process.env.FAKE_PI_NEXT_DELAY_MS,
    FAKE_PI_NEXT_DELAY_PHASE: process.env.FAKE_PI_NEXT_DELAY_PHASE,
    FAKE_PI_NEXT_TAMPER_VALIDATOR: process.env.FAKE_PI_NEXT_TAMPER_VALIDATOR,
    PI_ORCHESTRATOR_NEXT_RUNS_ROOT: process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT,
  };
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_NEXT_TARGET = "product.txt";
  process.env.FAKE_PI_NEXT_CONTENT = "built\n";
  process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = runsRoot;

  const agents = new Map([
    ["planner", { name: "planner", tools: [] }],
    ["coder", { name: "coder", tools: ["read", "bash", "edit", "write"] }],
    ["reviewer", { name: "reviewer", tools: [] }],
  ]);
  try {
    for (const [runId, unsafeRoot] of [
      ["unsafe-runs-root", path.join(workspace, "runtime-state")],
      ["unsafe-dotdot-prefix-root", path.join(workspace, "..state")],
    ]) {
      await assert.rejects(
        () => next.runOrchestratorNext({
          task: "reject product-local event state",
          workflow: "read-only-fanout-join",
          cwd: workspace,
          runsRoot: unsafeRoot,
          runId,
        }, { agents }),
        /runsRoot must be outside/,
      );
    }
    const alternateExecutable = process.platform === "win32" ? process.env.COMSPEC : "/bin/sh";
    if (alternateExecutable && path.isAbsolute(alternateExecutable) && fs.existsSync(alternateExecutable)) {
      await assert.rejects(
        () => next.runOrchestratorNext({
          task: "reject arbitrary host executable",
          workflow: "single-writer-pev",
          cwd: workspace,
          runsRoot,
          runId: "unsafe-executable",
          testExecutable: alternateExecutable,
          testArgs: ["validate.cjs"],
        }, { agents }),
        /only the host Node\.js executable/,
      );
    }

    const tamperWorkspace = path.join(tempRoot, "validator-tamper-workspace");
    const tamperLog = path.join(tempRoot, "validator-tamper-log.jsonl");
    fs.mkdirSync(tamperWorkspace);
    fs.writeFileSync(path.join(tamperWorkspace, "validate.cjs"), "console.error('original validator rejects'); process.exit(9);\n", "utf8");
    process.env.FAKE_PI_LOG = tamperLog;
    process.env.FAKE_PI_NEXT_TAMPER_VALIDATOR = "1";
    const tamperedValidatorRun = await next.runOrchestratorNext({
      action: "run",
      task: "Attempt to bypass a rejecting validator.",
      workflow: "single-writer-pev",
      cwd: tamperWorkspace,
      runsRoot,
      runId: "validator-tamper-run",
      testExecutable: process.execPath,
      testArgs: ["validate.cjs"],
    }, { agents });
    assert.equal(tamperedValidatorRun.details.status, "fail", "executor-mutated workspace validator must not replace pinned host validator bytes");
    assert.equal(tamperedValidatorRun.details.phaseOutcomes.test.category, "deterministic-check-failure");
    assert.equal(tamperedValidatorRun.details.phaseOutcomes.test.process.exitCode, 9);
    assert.equal(fs.readFileSync(path.join(tamperWorkspace, "validate.cjs"), "utf8"), "process.exit(0);\n", "fixture must prove product validator was actually tampered");
    delete process.env.FAKE_PI_NEXT_TAMPER_VALIDATOR;
    process.env.FAKE_PI_LOG = logPath;

    const readOnly = await next.runOrchestratorNext({
      task: "Review the supplied fixture from two perspectives.",
      workflow: "read-only-fanout-join",
      cwd: workspace,
      runsRoot,
      runId: "real-read-only",
      concurrency: 2,
    }, { agents });
    assert.equal(readOnly.details.status, "pass");
    assert.ok(fs.existsSync(readOnly.details.eventLog));
    assert.equal(fs.existsSync(path.join(workspace, "events.jsonl")), false);

    const fallback = await next.runOrchestratorNext({
      task: "Exercise safe provider fallback for both read-only workers.",
      workflow: "read-only-fanout-join",
      cwd: workspace,
      runsRoot,
      runId: "real-fallback",
      concurrency: 2,
      verifierProvider: "badprov",
      verifierModel: "bad-model",
      verifierFallbackProvider: "goodprov",
      verifierFallbackModel: "good-model",
    }, { agents });
    assert.equal(fallback.details.status, "pass");

    const pev = await next.runOrchestratorNext({
      task: "Create product.txt containing built followed by a newline.",
      workflow: "single-writer-pev",
      cwd: workspace,
      runsRoot,
      runId: "real-pev",
      testExecutable: process.execPath,
      testArgs: ["validate.cjs"],
    }, { agents });
    assert.equal(pev.details.status, "pass");
    assert.equal(pev.details.phaseOutcomes.implement.effects.status, "observed");
    assert.equal(pev.details.phaseOutcomes.test.process.exitCode, 0);
    assert.equal(pev.details.phaseOutcomes.verify.semantic.status, "pass");
    assert.equal(fs.readFileSync(path.join(workspace, "product.txt"), "utf8"), "built\n");

    const tool = loadOrchestrateNextTool();
    const toolResult = await tool.execute(
      "next-public-tool",
      {
        task: "Run the public v2 read-only pilot.",
        workflow: "read-only-fanout-join",
        cwd: workspace,
        runId: "public-tool-run",
        concurrency: 2,
        runsRoot: path.join(workspace, "caller-controlled-runtime-root"),
      },
      undefined,
      () => {},
      { cwd: workspace },
    );
    assert.equal(toolResult.details.status, "pass");
    assert.match(toolResult.content[0].text, /Orchestrator Next: PASS/);
    assert.equal(path.resolve(toolResult.details.runDirectory).startsWith(path.resolve(workspace) + path.sep), false, "public caller runsRoot must be ignored");

    const outsideMarker = path.join(tempRoot, "public-command-escape.txt");
    fs.writeFileSync(path.join(workspace, "evil.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(outsideMarker)}, 'escaped');\n`, "utf8");
    const publicPev = await tool.execute(
      "next-public-pev",
      {
        task: "Run the public fixed-validator v2 PEV pilot.",
        workflow: "single-writer-pev",
        validator: "node-workspace-validator",
        cwd: workspace,
        runId: "public-pev-run",
        testExecutable: process.execPath,
        testArgs: ["evil.cjs"],
        testCwd: ".",
      },
      undefined,
      () => {},
      { cwd: workspace },
    );
    assert.equal(publicPev.details.status, "pass");
    assert.equal(fs.existsSync(outsideMarker), false, "caller-supplied public argv must be ignored in favor of the fixed validator profile");

    const resumeTask = "Resume a public read-only v2 run from its durable event log.";
    const resumeCompiled = next.compileWorkflow(next.readOnlyFanoutJoinPilot());
    const resumeSeed = next.FileEventStore.create(runsRoot, "public-resume-seed");
    resumeSeed.append({ runId: "public-resume-seed", type: "run.created", data: { workflow: resumeCompiled.ir.name, workspaceRoot: workspace, input: { task: resumeTask } } });
    resumeSeed.append({ runId: "public-resume-seed", type: "workflow.compiled", data: { workflowHash: resumeCompiled.hash, canonicalJson: resumeCompiled.canonicalJson } });
    resumeSeed.append({ runId: "public-resume-seed", type: "phase.attempt.started", phaseId: "inspect-api", attempt: 1, data: {} });
    resumeSeed.append({ runId: "public-resume-seed", type: "phase.succeeded", phaseId: "inspect-api", attempt: 1, data: {
      output: info("persisted public API finding"),
      process: { started: true, exitCode: 0 },
      protocol: { status: "valid", schema: "informational-v1" },
      semantic: { status: "not-applicable" },
    } });
    resumeSeed.append({ runId: "public-resume-seed", type: "phase.attempt.started", phaseId: "inspect-state", attempt: 1, data: {} });
    resumeSeed.close();
    const publicResume = await tool.execute(
      "next-public-resume",
      { action: "resume", runId: "public-resume-seed" },
      undefined,
      () => {},
      { cwd: workspace },
    );
    assert.equal(publicResume.details.status, "pass");
    assert.equal(publicResume.details.phaseOutcomes["inspect-api"].output.summary, "persisted public API finding");
    assert.equal(publicResume.details.phaseOutcomes["inspect-state"].attempt, 2);
    const publicInspection = await tool.execute(
      "next-public-inspect",
      { action: "inspect", runId: "public-resume-seed" },
      undefined,
      () => {},
      { cwd: path.join(tempRoot, "irrelevant-caller-cwd") },
    );
    assert.equal(publicInspection.details.action, "inspect");
    assert.equal(publicInspection.details.status, "succeeded");
    assert.equal(publicInspection.details.projection.phases["inspect-state"].status, "succeeded");
    assert.match(publicInspection.content[0].text, /Orchestrator Next Inspection: SUCCEEDED/);

    const survivorLog = path.join(tempRoot, "real-survivor-log.jsonl");
    process.env.FAKE_PI_LOG = survivorLog;
    process.env.FAKE_PI_NEXT_DELAY_MS = "700";
    const controller = new AbortController();
    const survivorPromise = next.runOrchestratorNext({
      action: "run",
      task: "Prove real subprocess survivor publication and durable resume.",
      workflow: "read-only-fanout-join",
      cwd: workspace,
      runsRoot,
      runId: "real-survivor-run",
      concurrency: 2,
    }, { agents, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("fixture parent interruption")), 200);
    const survivorPending = await survivorPromise;
    assert.equal(survivorPending.details.status, "pending");
    assert.equal(survivorPending.details.projection.status, "paused");
    const survivorRunDirectory = survivorPending.details.runDirectory;
    await waitFor(() => {
      const workersRoot = path.join(survivorRunDirectory, "workers");
      if (!fs.existsSync(workersRoot)) return false;
      const workerDirs = fs.readdirSync(workersRoot);
      return workerDirs.length === 2 && workerDirs.every((directory) => fs.existsSync(path.join(workersRoot, directory, "result.json")));
    }, 5_000);
    delete process.env.FAKE_PI_NEXT_DELAY_MS;
    const survivorResumed = await next.runOrchestratorNext({ action: "resume", runId: "real-survivor-run", runsRoot }, { agents });
    assert.equal(survivorResumed.details.status, "pass");
    assert.equal(survivorResumed.details.phaseOutcomes["inspect-api"].attempt, 1, "published survivor result must be promoted without respawn");
    const survivorRecords = fs.readFileSync(survivorLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(survivorRecords.length, 2, "durable resume must not launch duplicate workers");
    process.env.FAKE_PI_LOG = logPath;

    const writerSurvivorLog = path.join(tempRoot, "real-writer-survivor-log.jsonl");
    process.env.FAKE_PI_LOG = writerSurvivorLog;
    process.env.FAKE_PI_NEXT_TARGET = "survivor-product.txt";
    process.env.FAKE_PI_NEXT_CONTENT = "survivor-built\n";
    process.env.FAKE_PI_NEXT_DELAY_MS = "900";
    process.env.FAKE_PI_NEXT_DELAY_PHASE = "implement";
    fs.writeFileSync(path.join(workspace, "validate.cjs"), [
      "const fs = require('node:fs');",
      "if (fs.readFileSync('survivor-product.txt', 'utf8') !== 'survivor-built\\n') process.exit(2);",
      "console.log('survivor fixture valid');",
      "",
    ].join("\n"), "utf8");
    const writerController = new AbortController();
    const writerSurvivorPromise = next.runOrchestratorNext({
      action: "run",
      task: "Create survivor-product.txt containing survivor-built followed by a newline.",
      workflow: "single-writer-pev",
      cwd: workspace,
      runsRoot,
      runId: "real-writer-survivor-run",
      testExecutable: process.execPath,
      testArgs: ["validate.cjs"],
    }, { agents, signal: writerController.signal });
    await waitFor(() => {
      if (!fs.existsSync(writerSurvivorLog)) return false;
      return fs.readFileSync(writerSurvivorLog, "utf8").split("\n").filter(Boolean).map(JSON.parse).some((record) => record.agentName === "coder");
    }, 5_000);
    writerController.abort(new Error("fixture writer parent interruption"));
    const writerPending = await writerSurvivorPromise;
    assert.equal(writerPending.details.status, "pending");
    assert.equal(writerPending.details.phaseOutcomes.implement.category, "result-file-pending");
    assert.equal(fs.existsSync(path.join(workspace, "survivor-product.txt")), false, "detached isolated writer must not mutate product before integration");
    await waitFor(() => {
      const workersRoot = path.join(writerPending.details.runDirectory, "workers");
      if (!fs.existsSync(workersRoot)) return false;
      return fs.readdirSync(workersRoot).some((directory) => fs.existsSync(path.join(workersRoot, directory, "result.json")));
    }, 5_000);
    delete process.env.FAKE_PI_NEXT_DELAY_MS;
    delete process.env.FAKE_PI_NEXT_DELAY_PHASE;
    const writerResumed = await next.runOrchestratorNext({ action: "resume", runId: "real-writer-survivor-run", runsRoot }, { agents });
    assert.equal(writerResumed.details.status, "pass");
    assert.equal(writerResumed.details.phaseOutcomes.implement.attempt, 1, "published isolated writer must be promoted without duplicate mutation");
    assert.equal(fs.readFileSync(path.join(workspace, "survivor-product.txt"), "utf8"), "survivor-built\n");
    const writerSurvivorRecords = fs.readFileSync(writerSurvivorLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(writerSurvivorRecords.filter((record) => record.agentName === "coder").length, 1, "isolated writer survivor must not respawn");
    process.env.FAKE_PI_LOG = logPath;
    process.env.FAKE_PI_NEXT_TARGET = "product.txt";
    process.env.FAKE_PI_NEXT_CONTENT = "built\n";

    const records = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(records.length, 15, "read-only, fallback attempts, direct/public PEV, public tool, and one resumed worker should launch");
    assert.equal(records.filter((record) => record.provider === "badprov").length, 2);
    assert.equal(records.filter((record) => record.provider === "goodprov").length, 2);
    assert.ok(records.filter((record) => record.noTools).length >= 11, "all planner/reviewer/read-only workers should be capability-enforced no-tools");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-next-"));
  const started = process.hrtime.bigint();
  try {
    testCompiler();
    testEventStore(tempRoot);
    await testReadOnlyFanoutJoin(tempRoot);
    await testRetryAndOutcomeUnknown(tempRoot);
    await testEventLogResume(tempRoot);
    await testIsolatedWorkspaceIntegration(tempRoot);
    await testDurableSurvivorAndResumeProvenance(tempRoot);
    await testSemanticGateIsIndependentOfExit(tempRoot);
    await testCommandAdapterSafety(tempRoot);
    await testSingleWriterPevFixture(tempRoot);
    await testRealPiAdapterAndPublicTool(tempRoot);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`PASS orchestrator-next: compiler/hash/dry-run, event replay, bounded fan-out/join, isolated dirty-state integration/conflicts, durable survivor publication/resume, safe retry, outcome-unknown preservation, semantic gate, single-writer PEV fixture (${durationMs.toFixed(1)}ms)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("test-orchestrator-next: FAIL");
  console.error(error);
  process.exit(1);
});
