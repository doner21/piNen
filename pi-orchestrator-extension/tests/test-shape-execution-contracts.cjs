#!/usr/bin/env node
const assert = require("node:assert/strict");
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
const supervision = jiti(path.join(PROJECT_ROOT, "src", "supervision.ts"));
const dynamic = jiti(path.join(PROJECT_ROOT, "src", "dynamic-workflow.ts"));
const builder = jiti(path.join(PROJECT_ROOT, "src", "shape-builder-support.ts"));

const SHAPES = [
  ["composable-pipeline", "composablePipelineShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["dual-plan-synthesis-execute-verify", "dualPlanSynthesisExecuteVerifyShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["evidence-audit", "evidenceAuditShape", "read-only"],
  ["frozen-gate-fix-loop", "frozenGateFixLoopShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["independent-replication", "independentReplicationShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["m66-explicit-routing-proof", "m66ExplicitRoutingProofShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["multi-verify-vote", "multiVerifyVoteShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["paradigm-creator", "paradigmCreatorShape", "read-only"],
  ["plan-execute-verify", "planExecuteVerifyShape", "executor-bearing", supervision.PEV_SHAPE_ADAPTER_ID],
  ["preregistered-concurrency-spike", "preregisteredConcurrencySpikeShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["shape-builder", "shapeBuilderShape", "mutating", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["ssi-single-writer-exclusive-lane", "ssiSingleWriterExclusiveLaneShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["venue-rescue-synthesis", "venueRescueSynthesisShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["verify-only", "verifyOnlyShape", "read-only"],
  ["win-console-spawn-root-cause", "winConsoleSpawnRootCauseShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
  ["win-lifecycle-process-trace", "winLifecycleProcessTraceShape", "executor-bearing", supervision.GENERIC_SHAPE_ADAPTER_ID],
];

function testEveryNativeShapeIsClassified() {
  const indexModule = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
  assert.deepEqual(
    [...indexModule.NATIVE_SHAPE_NAMES].sort(),
    SHAPES.map(([name]) => name).sort(),
    "classification matrix must cover every actually registered native shape",
  );
  const sourceShapeNames = fs.readdirSync(path.join(PROJECT_ROOT, "src", "shapes"))
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /export const \w+Shape\s*:\s*OrchestrationShape/.test(
      fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", name), "utf8"),
    ))
    .map((name) => name.replace(/\.ts$/, ""))
    .sort();
  assert.deepEqual(sourceShapeNames, SHAPES.map(([name]) => name).sort(), "matrix must cover every native shape source");

  for (const [name, exportName, classification, adapterId] of SHAPES) {
    const mod = jiti(path.join(PROJECT_ROOT, "src", "shapes", `${name}.ts`));
    const shape = mod[exportName];
    assert.ok(shape, `${name} export exists`);
    assert.equal(shape.name, name);
    assert.ok(Object.isFrozen(shape.execution), `${name} capability is immutable`);
    const resolution = supervision.resolveShapeSupervision(shape.execution);
    assert.notEqual(resolution.disposition, "fail-closed", `${name} has a recognized classification`);
    assert.equal(resolution.classification, classification, `${name} classification`);
    if (classification === "read-only") {
      assert.equal(resolution.disposition, "read-only");
      assert.equal(shape.execution.supervision, undefined);
      const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", `${name}.ts`), "utf8");
      if (name === "verify-only") {
        assert.match(source, /VERIFY_ONLY_TOOLS/,
          "verify-only exposes evidence tools plus bash so reviewers can run machine checks");
        assert.match(source, /VERIFY_ONLY_MUTATION/,
          "verify-only enforces read-only behavior from observed effects");
      } else {
        assert.match(source, /readOnly:\s*true/,
          `${name} must force spawned reviewer/planner profiles through the read-only evidence allowlist`);
      }
    } else {
      assert.equal(resolution.disposition, "supervised");
      assert.equal(resolution.identity.protocolId, supervision.HOST_TASK_BOUNDARY_PROTOCOL_ID);
      assert.equal(resolution.identity.adapterId, adapterId, `${name} adapter`);
      assert.equal(resolution.identity.adapterVersion, 1);
    }
  }
}

function dynamicWorkflow(name) {
  return {
    schemaVersion: 1,
    name,
    description: "Capability fixture.",
    phases: [{
      id: "execute",
      role: "executor",
      agentName: "coder",
      prompt: "Produce the requested result.",
      expectedOutput: "A result.",
      dependsOn: [],
      route: { role: "executor" },
    }],
    maxSubagents: 1,
    maxConcurrency: 1,
    maxIterations: 1,
    continueOnFailure: false,
    terminationCondition: "Stop after execute.",
    evidenceModel: "Direct output.",
    failureBehavior: "Fail on nonzero exit.",
    userFacingExplanation: "Fixture.",
  };
}

function testDynamicResolutionInjectsHostCapability() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-capability-"));
  try {
    const user = path.join(root, "user");
    const project = path.join(root, "project");
    fs.mkdirSync(user, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "dynamic-capability.workflow.json"),
      `${JSON.stringify(dynamicWorkflow("dynamic-capability"), null, 2)}\n`,
      "utf8",
    );

    const resolved = dynamic.resolveDynamicWorkflow("dynamic-capability", {
      cwd: root,
      nativeNames: new Set(SHAPES.map(([name]) => name)),
      roots: { user, project },
    });
    assert.ok(resolved);
    assert.strictEqual(resolved.execution, dynamic.DYNAMIC_WORKFLOW_EXECUTION);
    const capability = supervision.resolveShapeSupervision(resolved.execution);
    assert.equal(capability.disposition, "supervised");
    assert.equal(capability.identity.adapterId, supervision.GENERIC_SHAPE_ADAPTER_ID);

    const resumed = dynamic.resolvePinnedDynamicWorkflow(
      resolved.provenance,
      "dynamic-capability",
      new Set(SHAPES.map(([name]) => name)),
    );
    assert.strictEqual(resumed.execution, dynamic.DYNAMIC_WORKFLOW_EXECUTION, "historical resume re-injects host policy");

    const missingCapability = { workflow: resolved.workflow, provenance: resolved.provenance };
    assert.throws(
      () => dynamic.runDynamicWorkflowCanary(missingCapability),
      (error) => error.code === "INVALID_WORKFLOW_EXECUTION_CAPABILITY",
      "manually constructed/future workflow resolutions fail closed without host capability",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFailClosedDispatchPolicy() {
  const indexSource = fs.readFileSync(path.join(PROJECT_ROOT, "src", "index.ts"), "utf8");
  const hostGate = indexSource.indexOf("const execution = shapeRegistry.get(paradigm)?.execution");
  const providerPreflight = indexSource.indexOf("// ── Pre-flight provider health checks", hostGate);
  assert.ok(hostGate >= 0 && providerPreflight > hostGate,
    "host capability resolution must occur before provider preflight and shape dispatch");

  const malformedReadOnly = {
    classification: "read-only",
    supervision: {
      protocolId: supervision.HOST_TASK_BOUNDARY_PROTOCOL_ID,
      adapterId: supervision.GENERIC_SHAPE_ADAPTER_ID,
      adapterVersion: 1,
    },
  };
  assert.equal(
    supervision.resolveShapeSupervision(malformedReadOnly).reason,
    "unsupported-supervision-protocol",
    "contradictory read-only adapter declarations fail closed",
  );
  assert.equal(supervision.resolveShapeDispatch(undefined, undefined).disposition, "fail-closed");
  assert.equal(
    supervision.resolveShapeDispatch({ classification: "executor-bearing" }, "visible-main").reason,
    "missing-supervision-adapter",
  );
  const explicitOff = supervision.resolveShapeDispatch({ classification: "executor-bearing" }, "off");
  assert.equal(explicitOff.disposition, "legacy-off", "only explicit off enables legacy unsupervised dispatch");
  assert.equal(explicitOff.bypassedReason, "missing-supervision-adapter");
  for (const supervisionDeclaration of [
    {
      protocolId: "host-task-boundary-v1",
      adapterId: "future-adapter-v2",
      adapterVersion: 2,
    },
    {
      protocolId: "host-task-boundary-v1",
      adapterId: "syntactically-valid-but-unimplemented-v1",
      adapterVersion: 1,
    },
  ]) {
    const future = supervision.resolveShapeDispatch({
      classification: "executor-bearing",
      supervision: supervisionDeclaration,
    }, undefined);
    assert.equal(future.disposition, "fail-closed", "unsupported future adapters never downgrade on omitted mode");
    assert.equal(future.reason, "unsupported-supervision-protocol");
  }
}

function testShapeBuilderCannotGenerateUnclassifiedExecutor() {
  const spec = {
    schemaVersion: 1,
    action: "build",
    artifactKind: "native-shape",
    scope: "extension",
    targetName: "future-custom-shape",
    purpose: "Future custom executor fixture.",
    phases: [{ name: "execute", role: "executor", agentName: "coder", prompt: "Build it.", expectedOutput: "Files." }],
    maxSubagents: 1,
    maxIterations: 1,
    terminationCondition: "Stop after execute.",
    evidenceModel: "Direct files.",
    failureBehavior: "Fail on error.",
    userFacingExplanation: "Fixture.",
  };
  const source = builder.renderShapeSource(spec);
  assert.match(source, /execution:\s*GENERIC_EXECUTOR_SHAPE_EXECUTION/);
  assert.deepEqual(builder.staticCheckGeneratedShape(source), []);
  const omitted = source
    .replace('import { GENERIC_EXECUTOR_SHAPE_EXECUTION } from "../supervision";\n', "")
    .replace("  execution: GENERIC_EXECUTOR_SHAPE_EXECUTION,\n", "");
  assert.ok(builder.staticCheckGeneratedShape(omitted).some((error) => /supervision capability/.test(error)));

  assert.equal(
    supervision.resolveShapeSupervision(undefined).reason,
    "missing-execution-classification",
    "future hand-written registrations remain conservatively fail-closed",
  );
}

function run() {
  testEveryNativeShapeIsClassified();
  testDynamicResolutionInjectsHostCapability();
  testFailClosedDispatchPolicy();
  testShapeBuilderCannotGenerateUnclassifiedExecutor();
  console.log("test-shape-execution-contracts: all scenarios passed");
}

run();
