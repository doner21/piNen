#!/usr/bin/env node
/**
 * Focused invocation-time declarative workflow tests.
 *
 * Every mutable root is redirected beneath one temporary directory. The test
 * also fingerprints Pi's installed package (excluding dependency packages)
 * before and after runtime exercise to prove that extension-only discovery,
 * building, execution, and resume do not patch global/core files.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const PI_NODE_MODULES = path.join(PI_PACKAGE_ROOT, "node_modules");

process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const dynamic = jiti(path.join(PROJECT_ROOT, "src", "dynamic-workflow.ts"));
const runState = jiti(path.join(PROJECT_ROOT, "src", "run-state.ts"));

function loadOrchestrateTool() {
  const mod = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({
    registerTool(definition) {
      if (definition.name === "orchestrate") tool = definition;
    },
    registerCommand() {},
  });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

function workflow(name, overrides = {}) {
  return {
    schemaVersion: 1,
    name,
    description: `Focused workflow ${name}.`,
    phases: [
      {
        id: "inspect",
        role: "planner",
        agentName: "planner",
        prompt: "Inspect the supplied task and return one concise finding.",
        expectedOutput: "One concise finding.",
        dependsOn: [],
        route: { role: "planner" },
      },
      {
        id: "report",
        role: "executor",
        agentName: "coder",
        prompt: "Use the dependency finding and return a concise report.",
        expectedOutput: "A concise report.",
        dependsOn: ["inspect"],
        route: { role: "executor" },
      },
    ],
    maxSubagents: 2,
    maxConcurrency: 2,
    maxIterations: 1,
    continueOnFailure: false,
    terminationCondition: "Stop after the report phase.",
    evidenceModel: "Phase outputs are direct evidence.",
    failureBehavior: "Fail on a nonzero phase exit.",
    userFacingExplanation: "A bounded inspect-then-report workflow was used.",
    ...overrides,
  };
}

function writeWorkflow(root, document) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${document.name}.workflow.json`);
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return file;
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function fingerprintInstalledPi() {
  const records = [];
  const visit = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Dependencies are external packages, not Pi core. Excluding this large
      // subtree keeps the no-core-mutation check focused and fast.
      if (!relative && entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      const childRelative = path.join(relative, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) visit(absolute, childRelative);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        const hash = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
        records.push(`${childRelative}\0${stat.size}\0${hash}`);
      } else if (entry.isSymbolicLink()) {
        records.push(`${childRelative}\0symlink\0${fs.readlinkSync(absolute)}`);
      }
    }
  };
  visit(PI_PACKAGE_ROOT);
  return crypto.createHash("sha256").update(records.join("\n")).digest("hex");
}

function testValidationAndBoundaries(tempRoot) {
  const userRoot = path.join(tempRoot, "validation-user");
  const projectRoot = path.join(tempRoot, "validation-project");
  fs.mkdirSync(userRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  for (const unsafeRunId of ["..", ".", "../escape", "alias/escape", "-leading-dash", "trailing-dot.", "CON", ""]) {
    assert.throws(
      () => runState.runDirFor(unsafeRunId),
      /Invalid orchestration run id/,
      `run-state path must reject ${JSON.stringify(unsafeRunId)}`,
    );
  }
  const previousRunsRoot = process.env.PI_ORCHESTRATOR_RUNS_ROOT;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = path.join(tempRoot, "tampered-runs");
  const requestedRunId = "requested-run";
  const tamperedRunDir = runState.runDirFor(requestedRunId);
  fs.mkdirSync(tamperedRunDir, { recursive: true });
  fs.writeFileSync(path.join(tamperedRunDir, "state.json"), JSON.stringify({
    runId: "different-run",
    paradigm: "valid-workflow",
    task: "task",
    createdAt: new Date().toISOString(),
    params: {},
    phases: [],
  }), "utf8");
  assert.throws(() => runState.RunStateStore.load(requestedRunId), /Run state id mismatch/);
  if (previousRunsRoot === undefined) delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;
  else process.env.PI_ORCHESTRATOR_RUNS_ROOT = previousRunsRoot;

  const valid = dynamic.validateDynamicWorkflow(workflow("valid-workflow"));
  assert.equal(valid.schemaVersion, 1);
  assert.equal(valid.phases.length, 2);
  const canaryResolved = {
    workflow: valid,
    provenance: {
      sourcePath: "fixture",
      scope: "user",
      schemaVersion: 1,
      contentHash: "a".repeat(64),
      snapshotHash: crypto.createHash("sha256").update(JSON.stringify(valid)).digest("hex"),
      validatedSnapshot: valid,
    },
  };
  const canary = dynamic.runDynamicWorkflowCanary(canaryResolved);
  assert.equal(canary.details.status, "pass");
  assert.equal(canary.details.deterministic, true);
  assert.equal(canary.details.spawnedCount, 0);
  assert.deepEqual(canary.details.waves, [["inspect"], ["report"]]);
  const mutatedResolved = JSON.parse(JSON.stringify(canaryResolved));
  mutatedResolved.workflow.description = "changed after validation";
  assert.throws(
    () => dynamic.runDynamicWorkflowCanary(mutatedResolved),
    (error) => error.code === "WORKFLOW_PROVENANCE_MISMATCH",
  );

  assert.throws(
    () => dynamic.resolveDynamicWorkflow("../escape", { cwd: tempRoot, nativeNames: new Set(), roots: { user: userRoot, project: projectRoot } }),
    (error) => error.code === "UNSAFE_WORKFLOW_NAME",
  );
  assert.throws(
    () => dynamic.validateDynamicWorkflow(workflow("Bad_Name")),
    (error) => error.code === "UNSAFE_WORKFLOW_NAME",
  );
  assert.throws(
    () => dynamic.validateDynamicWorkflow({ ...workflow("bad-version"), schemaVersion: 2 }),
    (error) => error.code === "UNSUPPORTED_WORKFLOW_SCHEMA",
  );
  assert.throws(
    () => dynamic.validateDynamicWorkflow({ ...workflow("unknown-field"), coordinatorShell: true }),
    (error) => error.code === "UNKNOWN_WORKFLOW_FIELD",
  );
  const executablePhaseField = workflow("executable-phase-field");
  executablePhaseField.phases[0].shell = "rm -rf unsafe";
  assert.throws(
    () => dynamic.validateDynamicWorkflow(executablePhaseField),
    (error) => error.code === "UNKNOWN_WORKFLOW_FIELD",
  );
  const duplicatePhaseIds = workflow("duplicate-phase-ids");
  duplicatePhaseIds.phases[1].id = duplicatePhaseIds.phases[0].id;
  assert.throws(
    () => dynamic.validateDynamicWorkflow(duplicatePhaseIds),
    (error) => error.code === "INVALID_WORKFLOW_GRAPH",
  );
  const duplicateDependencies = workflow("duplicate-dependencies");
  duplicateDependencies.phases[1].dependsOn = ["inspect", "inspect"];
  assert.throws(
    () => dynamic.validateDynamicWorkflow(duplicateDependencies),
    (error) => error.code === "INVALID_WORKFLOW_GRAPH",
  );

  for (const invalid of [
    { ...workflow("nan-limit"), maxConcurrency: Number.NaN },
    { ...workflow("infinite-limit"), maxIterations: Number.POSITIVE_INFINITY },
    { ...workflow("concurrency-limit"), maxConcurrency: dynamic.DYNAMIC_WORKFLOW_LIMITS.MAX_CONCURRENCY + 1 },
    { ...workflow("spawn-limit"), maxSubagents: dynamic.DYNAMIC_WORKFLOW_LIMITS.MAX_TOTAL_SPAWNS + 1 },
    {
      ...workflow("derived-spawn-limit"),
      phases: Array.from({ length: 22 }, (_, index) => ({
        id: `phase-${index}`,
        role: "executor",
        agentName: "coder",
        prompt: "bounded",
        expectedOutput: "bounded",
        dependsOn: [],
        route: { role: "executor" },
      })),
      maxIterations: 3,
      maxSubagents: undefined,
    },
  ]) {
    assert.throws(
      () => dynamic.validateDynamicWorkflow(invalid),
      (error) => error.code === "WORKFLOW_LIMIT_EXCEEDED",
      `finite limit must reject ${invalid.name}`,
    );
  }
  const tooManyPhases = workflow("phase-limit", {
    phases: Array.from({ length: dynamic.DYNAMIC_WORKFLOW_LIMITS.MAX_PHASES + 1 }, (_, index) => ({
      id: `phase-${index}`,
      role: "executor",
      agentName: "coder",
      prompt: "bounded",
      expectedOutput: "bounded",
      dependsOn: [],
      route: { role: "executor" },
    })),
  });
  assert.throws(
    () => dynamic.validateDynamicWorkflow(tooManyPhases),
    (error) => error.code === "INVALID_WORKFLOW_PHASES",
  );

  const malformed = path.join(userRoot, "malformed.workflow.json");
  fs.writeFileSync(malformed, "{ definitely-not-json", "utf8");
  assert.throws(
    () => dynamic.loadDynamicWorkflowArtifact(malformed, userRoot, "user"),
    (error) => error.code === "MALFORMED_WORKFLOW_JSON",
  );

  const outsideDir = path.join(tempRoot, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideArtifact = writeWorkflow(outsideDir, workflow("outside-artifact"));
  assert.throws(
    () => dynamic.loadDynamicWorkflowArtifact(outsideArtifact, userRoot, "user"),
    (error) => error.code === "WORKFLOW_PATH_ESCAPE",
  );

  const oversized = path.join(userRoot, "oversized.workflow.json");
  fs.writeFileSync(oversized, Buffer.alloc(dynamic.DYNAMIC_WORKFLOW_LIMITS.MAX_ARTIFACT_BYTES + 1, 0x20));
  assert.throws(
    () => dynamic.loadDynamicWorkflowArtifact(oversized, userRoot, "user"),
    (error) => error.code === "WORKFLOW_TOO_LARGE",
  );

  const symlinkContainer = path.join(userRoot, "linked-outside");
  fs.symlinkSync(outsideDir, symlinkContainer, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => dynamic.loadDynamicWorkflowArtifact(path.join(symlinkContainer, "outside-artifact.workflow.json"), userRoot, "user"),
    (error) => error.code === "WORKFLOW_PATH_ESCAPE",
  );

  assert.throws(
    () => dynamic.resolveDynamicWorkflow("shape-builder", {
      cwd: tempRoot,
      nativeNames: new Set(["shape-builder"]),
      roots: { user: userRoot, project: projectRoot },
    }),
    (error) => error.code === "NATIVE_WORKFLOW_COLLISION",
  );

  const danglingName = "dangling-project-entry";
  writeWorkflow(userRoot, workflow(danglingName, { description: "must not be used as fallback" }));
  const vanishedTarget = path.join(tempRoot, "vanished-target");
  fs.mkdirSync(vanishedTarget, { recursive: true });
  const danglingProjectArtifact = path.join(projectRoot, `${danglingName}.workflow.json`);
  fs.symlinkSync(vanishedTarget, danglingProjectArtifact, process.platform === "win32" ? "junction" : "dir");
  fs.rmSync(vanishedTarget, { recursive: true, force: true });
  assert.throws(
    () => dynamic.resolveDynamicWorkflow(danglingName, {
      cwd: tempRoot,
      nativeNames: new Set(),
      roots: { user: userRoot, project: projectRoot },
    }),
    (error) => error.code === "WORKFLOW_PATH_UNRESOLVABLE",
    "a present invalid project entry must fail closed instead of falling back to user scope",
  );
}

function testProjectPrecedence(tempRoot) {
  const userRoot = path.join(tempRoot, "precedence-user");
  const projectRoot = path.join(tempRoot, "precedence-project");
  writeWorkflow(userRoot, workflow("same-name", { description: "user copy" }));
  const projectPath = writeWorkflow(projectRoot, workflow("same-name", { description: "project copy" }));

  const resolved = dynamic.resolveDynamicWorkflow("same-name", {
    cwd: tempRoot,
    nativeNames: new Set(),
    roots: { user: userRoot, project: projectRoot },
  });
  assert.ok(resolved);
  assert.equal(resolved.workflow.description, "project copy");
  assert.equal(resolved.provenance.scope, "project");
  assert.equal(path.resolve(resolved.provenance.sourcePath), fs.realpathSync.native(projectPath));
}

async function testSameProcessBuildExecuteAndPinnedResume(tempRoot, installedBefore) {
  const tool = loadOrchestrateTool();
  const cwd = path.join(tempRoot, "project");
  const userRoot = path.join(tempRoot, "runtime-user");
  const projectRoot = path.join(tempRoot, "runtime-project");
  const runsRoot = path.join(tempRoot, "runs");
  const logPath = path.join(tempRoot, "fake-pi-log.jsonl");
  fs.mkdirSync(cwd, { recursive: true });

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT = userRoot;
  process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT = projectRoot;
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;

  const builderSpec = {
    schemaVersion: 1,
    action: "build",
    targetName: "same-process-runtime",
    purpose: "Build and execute a workflow without reloading Pi.",
    phases: [
      { name: "inspect", role: "planner", agentName: "planner", prompt: "Inspect the task.", expectedOutput: "Finding." },
      { name: "report", role: "executor", agentName: "coder", prompt: "Report using the finding.", expectedOutput: "Report." },
    ],
    maxSubagents: 2,
    maxIterations: 1,
    terminationCondition: "Stop after report.",
    evidenceModel: "Phase outputs.",
    failureBehavior: "Fail on phase error.",
    userFacingExplanation: "Inspect then report.",
  };

  const built = await tool.execute(
    "dynamic-builder",
    { task: JSON.stringify(builderSpec), paradigm: "shape-builder", preflight: false, cwd, maxSubagents: 4 },
    undefined,
    () => {},
    { cwd },
  );
  assert.equal(built.details.status, "pass");
  assert.equal(built.details.usable, true);
  assert.equal(built.details.reloadRequired, false);
  assert.equal(built.details.canary.spawnedCount, 0);
  assert.equal(readLog(logPath).length, 0, "build and deterministic canary must spawn no Pi children");

  const artifactPath = path.join(userRoot, "same-process-runtime.workflow.json");
  assert.ok(fs.existsSync(artifactPath));
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, "src", "shapes", "same-process-runtime.ts")), false);
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, "tests", "test-same-process-runtime.cjs")), false);

  const canary = await tool.execute(
    "dynamic-canary",
    { task: "SHAPE_CANARY", paradigm: "same-process-runtime", cwd },
    undefined,
    () => {},
    { cwd },
  );
  assert.equal(canary.details.status, "pass");
  assert.equal(canary.details.spawnedCount, 0);
  assert.equal(readLog(logPath).length, 0, "invocation-time canary must skip default preflight and remain zero-process");

  const executed = await tool.execute(
    "dynamic-execute",
    {
      task: "Exercise the newly built workflow now.",
      paradigm: "same-process-runtime",
      preflight: false,
      cwd,
      maxSubagents: 4,
      concurrency: 2,
    },
    undefined,
    () => {},
    { cwd },
  );
  assert.equal(executed.details.status, "pass");
  assert.equal(executed.details.dynamicWorkflow, true);
  assert.equal(executed.details.spawnedCount, 2);
  assert.equal(executed.details.workflow.scope, "user");
  assert.equal(readLog(logPath).length, 2, "ordinary execution must run both bounded phases");

  const originalHash = executed.details.workflow.contentHash;
  const originalSnapshot = JSON.parse(JSON.stringify(executed.details.workflow.validatedSnapshot));
  const statePath = path.join(runsRoot, executed.details.runId, "state.json");
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.dynamicWorkflow.contentHash, originalHash);
  assert.deepEqual(persisted.dynamicWorkflow.validatedSnapshot, originalSnapshot);

  const changed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  changed.description = "MUTATED SOURCE THAT MUST NOT REPLACE THE PINNED SNAPSHOT";
  changed.phases[0].prompt = "Changed prompt that must not run during resume.";
  fs.writeFileSync(artifactPath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
  const changedHash = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  assert.notEqual(changedHash, originalHash);

  const callsBeforeResume = readLog(logPath).length;
  const resumed = await tool.execute(
    "dynamic-resume",
    { resume: executed.details.runId, preflight: false, cwd },
    undefined,
    () => {},
    { cwd },
  );
  assert.equal(resumed.details.status, "pass");
  assert.equal(resumed.details.workflow.scope, "pinned");
  assert.equal(resumed.details.workflow.contentHash, originalHash);
  assert.deepEqual(resumed.details.workflow.validatedSnapshot, originalSnapshot);
  assert.equal(resumed.details.workflow.validatedSnapshot.description, builderSpec.purpose);
  assert.equal(resumed.details.restoredCount, 2);
  assert.equal(readLog(logPath).length, callsBeforeResume, "completed pinned resume must not respawn phases");

  // Corrupting the pinned snapshot must fail closed rather than loading the
  // now-valid-but-changed source artifact.
  persisted.dynamicWorkflow.validatedSnapshot.description = "tampered pinned state";
  fs.writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => tool.execute(
      "dynamic-tampered-resume",
      { resume: executed.details.runId, preflight: false, cwd },
      undefined,
      () => {},
      { cwd },
    ),
    /PINNED_WORKFLOW_MISMATCH/,
  );
  assert.equal(readLog(logPath).length, callsBeforeResume, "failed pinned validation must occur before spawn");

  const nativeCanary = await tool.execute(
    "native-regression",
    { task: "SHAPE_CANARY:evidence-audit", paradigm: "evidence-audit", preflight: false, cwd },
    undefined,
    () => {},
    { cwd },
  );
  assert.equal(nativeCanary.details.status, "pass");
  assert.equal(nativeCanary.details.canary, true);
  assert.equal(nativeCanary.details.spawnedCount, 0);

  assert.equal(fingerprintInstalledPi(), installedBefore, "dynamic workflow tests must not modify installed/global Pi package files");
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dynamic-workflow-"));
  const savedEnv = Object.fromEntries([
    "PI_CLI_PATH",
    "FAKE_PI_LOG",
    "PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT",
    "PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT",
    "PI_ORCHESTRATOR_RUNS_ROOT",
  ].map((key) => [key, process.env[key]]));

  try {
    // Snapshot after loading jiti/extension dependencies: the test below is the
    // operation under examination, and this avoids attributing dependency
    // loader initialization to workflow execution.
    const installedBefore = fingerprintInstalledPi();
    testValidationAndBoundaries(tempRoot);
    testProjectPrecedence(tempRoot);
    await testSameProcessBuildExecuteAndPinnedResume(tempRoot, installedBefore);
    console.log("PASS dynamic-workflow: validation, limits, containment, precedence, same-process build/discovery/canary/execution, pinned resume, native regression, no global Pi mutation");
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("test-dynamic-workflow: FAIL");
  console.error(error);
  process.exit(1);
});
