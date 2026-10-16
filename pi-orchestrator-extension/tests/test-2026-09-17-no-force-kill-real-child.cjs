#!/usr/bin/env node
/** Item 2: actual AgentSession dispatch rejects every owned bash timeout key except null (NULL-TIMEOUT-ALLOWED, 6 October 2026). */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item2-agent-session-"));
const WORKSPACE = path.join(TEMP_ROOT, "workspace");
const AGENT_DIR = path.join(TEMP_ROOT, "agent");
const RUNS_ROOT = path.join(TEMP_ROOT, "runs");
const NEXT_RUNS_ROOT = path.join(TEMP_ROOT, "next-runs");
const PHASE_ROOT = path.join(TEMP_ROOT, "phase-evidence");
for (const directory of [WORKSPACE, AGENT_DIR, RUNS_ROOT, NEXT_RUNS_ROOT, PHASE_ROOT]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({
  defaultProvider: "fixture",
  defaultModel: "guard-model",
}, null, 2), "utf8");
fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), "{}\n", "utf8");
fs.writeFileSync(path.join(AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fixture: {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "fixture",
      models: [{
        id: "guard-model",
        name: "Guard fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 1_000,
      }],
    },
  },
}, null, 2), "utf8");
fs.mkdirSync(path.join(AGENT_DIR, "agents"), { recursive: true });
fs.writeFileSync(path.join(AGENT_DIR, "agents", "item2-roles.json"), JSON.stringify([
  { name: "planner", tools: ["read", "bash"] },
  { name: "coder", tools: ["read", "bash", "edit", "write"] },
  { name: "reviewer", tools: ["read", "bash", "edit", "write"] },
], null, 2), "utf8");

// Every config, cache, workspace, evidence and run root is isolated before any
// product or Pi module import. The synthetic provider never makes a request.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_ORCHESTRATOR_RUNS_ROOT = RUNS_ROOT;
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = NEXT_RUNS_ROOT;
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_OFFLINE = "1";
process.env.ITEM2_WORKSPACE = WORKSPACE;
process.env.ITEM2_PHASE_ROOT = PHASE_ROOT;
process.env.ITEM2_LAUNCH_RECORDS = path.join(TEMP_ROOT, "launcher-records.jsonl");
process.env.PI_CLI_PATH = path.join(__dirname, "fixtures", "no-force-kill-agent-session-worker.cjs");

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function main() {
  const fixture = require(path.join(__dirname, "fixtures", "no-force-kill-agent-session-worker.cjs"));
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const guard = jiti(path.join(ROOT, "src", "worker-execution-constraints.ts"));
  const substrate = jiti(path.join(ROOT, "src", "substrate.ts"));
  const orchestrator = jiti(path.join(ROOT, "src", "index.ts"));
  const supervision = jiti(path.join(ROOT, "src", "supervision.ts"));
  const guardPath = path.join(ROOT, "src", "worker-execution-constraints.ts");
  const monitorPath = path.join(ROOT, "src", "worker-no-output-monitor.ts");
  const bootstrapPath = path.join(ROOT, "src", "worker-monitor-bootstrap.ts");

  // Preserve the existing launcher evidence without entering its process path:
  // guarded stdin is released only after Pi can load the explicit extension,
  // and the host still fails closed when the ready marker is absent.
  for (const relative of ["src/index.ts", "src/substrate.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(source, /if \([^\n]*noForceKill[^\n]*!== true\) dispatchTask\(\)/,
      `${relative} must not deadlock real Pi by withholding stdin until guard attestation`);
    assert.match(source, /dispatchTask\(\);\s*\/\/ Pi loads explicit extensions before model\/tool dispatch/,
      `${relative} must release stdin before waiting for guard attestation`);
    assert.match(source, /NO_FORCE_KILL_GUARD_NOT_LOADED/,
      `${relative} must retain host refusal when guard attestation is absent`);
  }

  assert.equal(guard.NO_FORCE_KILL_GUARD_READY_MARKER, "NO_FORCE_KILL_GUARD_READY:v1");
  const roleTools = new Map([
    ["planner", ["bash"]],
    ["executor", ["bash"]],
    ["verifier", [...substrate.VERIFIER_EVIDENCE_TOOLS]],
  ]);
  const reports = [];
  for (const [role, tools] of roleTools) {
    reports.push(await fixture.runRole({
      root: ROOT,
      role,
      tools,
      guardPath,
      expectedVerifierTools: [...substrate.VERIFIER_EVIDENCE_TOOLS],
    }));
  }

  // Freeze the parsed policy with the actual production role routes, then use
  // that frozen object to drive both duplicated host launcher implementations.
  const parsedPolicy = orchestrator.parseOrchestrateCommandArgsForTest(
    "run --no-force-kill -- item2 launcher wiring probe",
  );
  assert.equal(parsedPolicy.noForceKill, true);
  const agents = await orchestrator.loadAgents();
  const roleParams = {
    plannerAgent: "planner",
    executorAgent: "coder",
    verifierAgent: "reviewer",
    cwd: WORKSPACE,
  };
  orchestrator.resolveConfiguredRoleDefaults(roleParams, agents);
  const roles = [
    { role: "planner", agentName: roleParams.plannerAgent, verifier: false },
    { role: "executor", agentName: roleParams.executorAgent, verifier: false },
    { role: "verifier", agentName: roleParams.verifierAgent, verifier: true },
  ];
  for (const { agentName } of roles) {
    assert.equal(agents.get(agentName)?.provider, "fixture");
    assert.equal(agents.get(agentName)?.model, "guard-model");
  }
  const mission = supervision.createFrozenMission({
    originalTask: "item2 launcher wiring probe",
    cwd: WORKSPACE,
    worktree: {
      root: WORKSPACE,
      realRoot: fs.realpathSync(WORKSPACE),
      branch: null,
      baseline: null,
    },
    paradigm: "plan-execute-verify",
    lane: "orchestrator-maintenance",
    routes: roles.map(({ role, agentName }) => ({
      role,
      agentName,
      provider: agents.get(agentName).provider,
      model: agents.get(agentName).model,
    })),
    constraints: ["Bash arguments must omit timeout."],
    nonGoals: [],
    acceptanceCriteria: [{ id: "AC-01", text: "Guarded launchers load the frozen execution constraint.", required: true }],
    workerExecutionConstraints: { noForceKill: parsedPolicy.noForceKill },
  });
  assert.equal(supervision.verifyFrozenMission(mission), true);
  assert.deepEqual(mission.workerExecutionConstraints, { noForceKill: true });
  assert.equal(supervision.verifyFrozenMission({
    ...mission,
    workerExecutionConstraints: { noForceKill: false },
  }), false, "changing the frozen no-force-kill policy must invalidate mission identity");

  let launchSequence = 0;
  const launchWith = async (launcher, roleSpec) => {
    launchSequence += 1;
    process.env.ITEM2_LAUNCHER_KIND = launcher;
    const evidenceBase = path.join(PHASE_ROOT, `${launcher}-${roleSpec.role}-${launchSequence}`);
    const options = {
      agents,
      cwd: WORKSPACE,
      allowLocalModel: true,
      phaseLogFile: `${evidenceBase}.jsonl`,
      phaseResultFile: `${evidenceBase}.result.json`,
      verifier: roleSpec.verifier,
      readOnly: roleSpec.verifier,
    };
    if (launcher === "substrate") {
      return substrate.withWorkerExecutionConstraints(mission.workerExecutionConstraints, () =>
        substrate.spawnSubagent(roleSpec.agentName, `guarded ${roleSpec.role} substrate probe`, options));
    }
    assert.equal(typeof orchestrator.runLegacySubagentForTest, "function",
      "legacy launcher must be directly testable without starting an orchestration");
    return orchestrator.runLegacySubagentForTest(
      roleSpec.agentName,
      `guarded ${roleSpec.role} legacy probe`,
      { ...options, workerExecutionConstraints: mission.workerExecutionConstraints },
    );
  };

  if (process.argv.includes("--causal-red-wiring")) {
    // Safe mutation probe: the natural-finishing child deliberately ignores
    // the supplied extension argument. Leaving the rejection uncaught makes
    // this invocation RED exactly as removing --extension wiring would.
    process.env.ITEM2_SUPPRESS_GUARD = "1";
    await launchWith("substrate", roles[0]);
    throw new Error("wiring mutation unexpectedly passed");
  }

  for (const launcher of ["substrate", "legacy"]) {
    for (const roleSpec of roles) {
      const result = await launchWith(launcher, roleSpec);
      assert.equal(result.exitCode, 0);
      assert.equal(result.text, "launcher guard probe complete");
      assert.equal(result.actionEvidence.entries.find((entry) => entry.toolCallId === "launcher-20")?.outcome, "failed");
      assert.equal(result.actionEvidence.entries.find((entry) => entry.toolCallId === "launcher-allowed")?.outcome, "succeeded");
    }
  }

  const successfulLaunchRecords = readJsonLines(process.env.ITEM2_LAUNCH_RECORDS);
  assert.equal(successfulLaunchRecords.length, 6);
  const expectedTools = {
    planner: ["read", "bash"],
    coder: ["read", "bash", "edit", "write"],
    reviewer: [...substrate.VERIFIER_EVIDENCE_TOOLS],
  };
  for (const record of successfulLaunchRecords) {
    assert.equal(record.noExtensions, true);
    assert.deepEqual(record.extensionPaths, [bootstrapPath, monitorPath, guardPath],
      `${record.launcher}/${record.role} must receive the automatic monitor and guarded timeout interceptor`);
    assert.deepEqual(record.effectiveExtensionPaths, [bootstrapPath, monitorPath, guardPath]);
    assert.deepEqual(record.tools, expectedTools[record.role]);
    assert.deepEqual(record.safetyInterceptions, [],
      `${record.launcher}/${record.role} must be protected by the loaded production guard`);
    assert.equal(record.modelCalls, 2);
  }
  assert.deepEqual(
    successfulLaunchRecords.map((record) => `${record.launcher}:${record.role}`),
    [
      "substrate:planner", "substrate:coder", "substrate:reviewer",
      "legacy:planner", "legacy:coder", "legacy:reviewer",
    ],
  );

  // The child still performs genuine AgentSession dispatch and exits naturally,
  // but ignores the extension argument. Both hosts must reject specifically for
  // missing attestation rather than surfacing a loader error or accepting output.
  process.env.ITEM2_SUPPRESS_GUARD = "1";
  for (const launcher of ["substrate", "legacy"]) {
    await assert.rejects(
      () => launchWith(launcher, roles[0]),
      /NO_FORCE_KILL_GUARD_NOT_LOADED/,
      `${launcher} host must fail closed when the explicit guard does not attest`,
    );
  }
  delete process.env.ITEM2_SUPPRESS_GUARD;
  const allLaunchRecords = readJsonLines(process.env.ITEM2_LAUNCH_RECORDS);
  const refusedRecords = allLaunchRecords.slice(6);
  assert.equal(refusedRecords.length, 2);
  assert.ok(refusedRecords.every((record) => record.modelCalls === 2));
  assert.ok(refusedRecords.every((record) =>
    JSON.stringify(record.effectiveExtensionPaths) === JSON.stringify([bootstrapPath, monitorPath])),
  "suppressing the timeout guard must leave the automatic no-output monitor loaded");
  assert.ok(refusedRecords.every((record) =>
    JSON.stringify(record.safetyInterceptions) === JSON.stringify(["launcher-20"])),
  "missing-guard children must reach only the test backstop before the host refuses their otherwise complete result");

  assert.equal(guard.ownsBashTimeoutArgument({ timeout: null }), true);
  assert.equal(guard.ownsBashTimeoutArgument({ nested: [{ timeout: undefined }] }), true,
    "production ownership check must recurse through own object/array properties");
  const cycle = { branch: {} };
  cycle.branch.back = cycle;
  cycle.branch.items = [{ timeout: null }];
  assert.equal(guard.ownsBashTimeoutArgument(cycle), true, "recursive ownership check must be cycle-safe");
  const inherited = Object.create({ timeout: 30 });
  inherited.command = "printf inherited-only";
  assert.equal(guard.ownsBashTimeoutArgument(inherited), false, "prototype keys remain outside policy scope");

  for (const report of reports) {
    const { role, raw, normalized, ends, executionBoundary, safetyInterceptions } = report.observations;
    const nullRaw = raw.get("timeout-null");
    const nullNormalized = normalized.get("timeout-null");
    assert.equal(nullRaw?.topLevelTimeout, true, `${role}: raw null key must be observed before validation`);
    assert.equal(nullNormalized?.topLevelTimeout, false,
      `${role}: real Pi normalization must remove optional timeout:null before tool_call`);
    assert.equal(nullRaw.args.timeout, null, `${role}: validation must not mutate the captured raw null payload`);
    const undefinedRaw = raw.get("timeout-undefined")?.args;
    assert.equal(Object.hasOwn(undefinedRaw, "timeout"), true,
      `${role}: raw undefined ownership must survive in memory`);
    assert.equal(undefinedRaw.timeout, undefined);
    assert.equal(safetyInterceptions.length, 0,
      `${role}: production guard failed; test safety backstop intercepted ${safetyInterceptions.map((x) => x.toolCallId).join(", ")}`);

    const executedIds = executionBoundary.map((entry) => entry.toolCallId);
    assert.ok(executedIds.includes("allowed-parallel"));
    assert.ok(executedIds.includes("command-text-parallel"), "timeout text is not an argument key");
    assert.ok(executedIds.includes("sequential-allowed"));
    for (const allowedId of [
      "allowed-parallel",
      "command-text-parallel",
      "sequential-allowed",
      "reused-id",
      "validation-reused-id",
    ]) {
      assert.equal(ends.get(allowedId)?.isError, false, `${role}/${allowedId} must complete through real bash`);
    }
    assert.ok(executedIds.includes("reused-id"), "a reused ID without timeout must not inherit stale state");
    assert.equal(executedIds.filter((id) => id === "reused-id").length, 1,
      "the forbidden reused ID is blocked and the later allowed call executes exactly once");
    assert.ok(executedIds.includes("validation-reused-id"),
      "a validation-failed ID must be cleared before reuse on a later turn");
    assert.equal(executedIds.filter((id) => id === "validation-reused-id").length, 1,
      "the invalid call never executes and its later timeout-absent reuse executes once");
    assert.match(ends.get("reused-id")?.text ?? "", /reused-id-allowed|NO_FORCE_KILL_CONSTRAINT/,
      "reused correlation must settle without leaking into a later turn");
  }

  console.log("PASS item2 no-force-kill actual AgentSession + launchers: frozen policy and production planner/coder/reviewer tool resolution drive both real host launchers; missing attestation is refused; raw undefined/empty/numeric/nested non-null keys cannot execute while a null timeout key executes (NULL-TIMEOUT-ALLOWED); mixed parallel/sequential calls and reused IDs remain correctly correlated");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
