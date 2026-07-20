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

function makeJiti() {
  return createJiti(__filename, { interopDefault: true, moduleCache: false });
}

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
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

function loadParadigmCreatorModule() {
  return makeJiti()(path.join(PROJECT_ROOT, "src", "shapes", "paradigm-creator.ts"));
}

async function testRegistryDiscovery() {
  const tool = loadOrchestrateTool();
  const result = await tool.execute(
    "test-paradigm-creator-discovery",
    { task: "list paradigms", paradigm: "unknown-test-paradigm", preflight: false, cwd: PROJECT_ROOT },
    undefined,
    () => {},
    { cwd: PROJECT_ROOT },
  );
  assert.equal(result.details.status, "fail");
  assert.match(result.details.abortReason, /Available paradigms:/);
  assert.match(result.details.abortReason, /paradigm-creator/);
  for (const name of EXPECTED_REGISTERED_PARADIGMS) {
    assert.match(result.details.abortReason, new RegExp(name), `unknown-paradigm error must list "${name}"`);
  }
}

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "paradigm-creator.ts"), "utf8");
  assert.match(source, /name:\s*"paradigm-creator"/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /agent_reload_runtime\s*\(/, "shape must not call reload bridge");
  assert.doesNotMatch(source, /agent_scheduler\s*\(/, "shape must not call scheduler bridge");
  assert.doesNotMatch(source, /executeCommand\s*\(/, "shape must not call executeCommand");
  assert.doesNotMatch(source, /sendUserMessage\s*\(\s*["']\/reload/, "shape must not send reload slash command");
}

const EXPECTED_REGISTERED_PARADIGMS = [
  "plan-execute-verify",
  "multi-verify-vote",
  "composable-pipeline",
  "dual-plan-synthesis-execute-verify",
  "verify-only",
  "paradigm-creator",
  "shape-builder",
  "win-console-spawn-root-cause",
  "win-lifecycle-process-trace",
];

function validSpec(overrides = {}) {
  return {
    name: "red-team-judge",
    purpose: "Run bounded red-team, blue-team, and judge review.",
    phases: [
      { name: "red", role: "critic", agentName: "reviewer", prompt: "Critique with evidence.", expectedOutput: "Risks." },
      { name: "blue", role: "defender", agentName: "coder", prompt: "Respond to risks.", expectedOutput: "Mitigations." },
      { name: "judge", role: "arbiter", agentName: "reviewer", prompt: "Judge mitigations.", expectedOutput: "Verdict." },
    ],
    maxSubagents: 3,
    maxIterations: 1,
    terminationCondition: "Stop after the judge phase.",
    evidenceModel: "Judge cites red and blue outputs.",
    failureBehavior: "Fail on unresolved critical risk.",
    userFacingExplanation: "Adversarial critique, defense, and judgment.",
    ...overrides,
  };
}

function testPureHelpers() {
  const mod = loadParadigmCreatorModule();
  assert.equal(mod.normalizeParadigmName("  Red Team/Judge!! "), "red-team-judge");
  assert.equal(mod.normalizeParadigmName("Débaté → Synthesis"), "debate-synthesis");

  assert.deepEqual(mod.validateParadigmSpec(validSpec()), []);
  // Reserved names — test all registered/reserved paradigms.
  for (const name of EXPECTED_REGISTERED_PARADIGMS) {
    assert.ok(
      mod.validateParadigmSpec(validSpec({ name })).some((error) => /already registered|reserved/.test(error)),
      `reserved name "${name}" should be rejected`,
    );
  }
  assert.ok(
    mod.validateParadigmSpec(validSpec({ terminationCondition: "Keep iterating until perfect." })).some((error) => /unbounded-loop/i.test(error)),
    "unbounded loop language should be rejected",
  );

  // maxSubagents must be at least the number of phases.
  assert.ok(
    mod.validateParadigmSpec(validSpec({ maxSubagents: 1 })).some((error) => /maxSubagents.*phases|number of phases/i.test(error)),
    "maxSubagents less than phase count should be rejected",
  );

  // maxIterations must be exactly 1 in v1.
  assert.ok(
    mod.validateParadigmSpec(validSpec({ maxIterations: 2 })).some((error) => /maxIterations.*exactly 1|single sequential pass/i.test(error)),
    "maxIterations other than 1 should be rejected",
  );

  assert.equal(
    mod.decideCreationAction({ action: "reuse-existing", confidence: 0.7, existingParadigm: "verify-only" }).action,
    "reuse-existing",
  );
  assert.equal(
    mod.decideCreationAction({ action: "reuse-existing", confidence: 0.7, existingParadigm: "win-lifecycle-process-trace" }).action,
    "reuse-existing",
  );
  assert.equal(
    mod.decideCreationAction({ action: "create", confidence: 0.4, spec: validSpec() }, []).action,
    "human-gate",
  );
  assert.equal(
    mod.decideCreationAction({ action: "create", confidence: 0.91, spec: validSpec() }, []).action,
    "create",
  );

  const rendered = mod.renderShapeFromTemplate(validSpec());
  assert.match(rendered, /export const redTeamJudgeShape: OrchestrationShape/);
  assert.deepEqual(mod.staticCheckGeneratedShape(rendered), []);
  assert.deepEqual(
    [...mod.KNOWN_PARADIGMS].sort(),
    EXPECTED_REGISTERED_PARADIGMS.slice().sort(),
    "KNOWN_PARADIGMS should match the full registered paradigm list",
  );
  assert.ok(
    mod.staticCheckGeneratedShape('import { x } from "./verify-only"; while(true) {}').length >= 2,
    "static checks should catch sibling imports and unbounded loops",
  );
}

async function testProposeModeNoFileWrite() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paradigm-creator-propose-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-paradigm-creator-propose",
      {
        task: "Create a reusable red-team / blue-team / judge orchestration paradigm for migration audits.",
        paradigm: "paradigm-creator",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 3,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Paradigm Creator: PASS/);
    assert.match(markdown, /propose-only mode/);
    assert.equal(result.details.paradigm, "paradigm-creator");
    assert.equal(result.details.mode, "propose");
    assert.equal(result.details.noFileMutation, true);
    assert.equal(result.details.reloadRequired, false);
    assert.equal(result.details.reloadRequiredAfterApply, true);
    assert.equal(result.details.targetName, "red-team-judge");

    assert.equal(fs.existsSync(path.join(tempDir, "src", "shapes", "red-team-judge.ts")), false);
    assert.equal(fs.existsSync(path.join(PROJECT_ROOT, "src", "shapes", "red-team-judge.ts")), false);

    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.agentName === "planner").length, 1, "exactly one assessment planner should spawn");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testRegistryDiscovery();
  testCommittedShapeStaticRules();
  testPureHelpers();
  await testProposeModeNoFileWrite();
  console.log("PASS paradigm-creator: registry, static rules, helpers, propose-mode no-file-write");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
