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

function loadSupportModule() {
  return require(path.join(PROJECT_ROOT, "src", "shape-builder-support.ts"));
}

// ── Test: registry discovery lists shape-builder ──────────────────────────

async function testRegistryDiscovery() {
  const tool = loadOrchestrateTool();
  const result = await tool.execute(
    "test-shape-builder-discovery",
    { task: "list paradigms", paradigm: "unknown-test-shape-builder", preflight: false, cwd: PROJECT_ROOT },
    undefined,
    () => {},
    { cwd: PROJECT_ROOT },
  );
  assert.equal(result.details.status, "fail");
  assert.match(result.details.abortReason, /Available paradigms:/);
  assert.match(result.details.abortReason, /shape-builder/);
}

// ── Test: committed shape static rules ────────────────────────────────────

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "shape-builder.ts"), "utf8");
  assert.match(source, /name:\s*"shape-builder"/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  // No sibling shape imports (allow shape-builder-support, which is not a shape)
  assert.doesNotMatch(source, /from\s+["']\.\/paradigm-creator/, "shape must not import sibling paradigm-creator");
  assert.doesNotMatch(source, /from\s+["']\.\/plan-execute-verify/, "shape must not import sibling plan-execute-verify");
  assert.doesNotMatch(source, /from\s+["']\.\/verify-only/, "shape must not import sibling verify-only");
  // No forbidden runtime calls
  assert.doesNotMatch(source, /agent_reload_runtime\s*\(/, "shape must not call reload bridge");
  assert.doesNotMatch(source, /agent_scheduler\s*\(/, "shape must not call scheduler bridge");
  assert.doesNotMatch(source, /executeCommand\s*\(/, "shape must not call executeCommand");
  assert.doesNotMatch(source, /sendUserMessage\s*\(\s*["']\/reload/, "shape must not send reload slash command");
}

// ── Test: lifecycle helper monotonicity ───────────────────────────────────

function testLifecycleHelpers() {
  const mod = loadSupportModule();

  // Status ranks
  assert.equal(mod.SHAPE_BUILDER_LIFECYCLE_RANK["proposed"], 10);
  assert.equal(mod.SHAPE_BUILDER_LIFECYCLE_RANK["implementation_reported"], 20);
  assert.equal(mod.SHAPE_BUILDER_LIFECYCLE_RANK["declarative_verified"], 30);
  assert.equal(mod.SHAPE_BUILDER_LIFECYCLE_RANK["implemented_verified"], 30);
  assert.equal(mod.SHAPE_BUILDER_LIFECYCLE_RANK["runtime_discovered"], 40);
  assert.equal(mod.SHAPE_BUILDER_LIFECYCLE_RANK["reloaded_discovered"], 40);
  assert.equal(mod.SHAPE_BUILDER_LIFECYCLE_RANK["canary_passed"], 50);

  // Forward transitions OK
  assert.equal(mod.transitionLifecycleState("proposed", "implementation_reported").ok, true);
  assert.equal(mod.transitionLifecycleState("implementation_reported", "declarative_verified").ok, true);
  assert.equal(mod.transitionLifecycleState("declarative_verified", "runtime_discovered").ok, true);
  assert.equal(mod.transitionLifecycleState("implementation_reported", "implemented_verified").ok, true);
  assert.equal(mod.transitionLifecycleState("implemented_verified", "runtime_discovered").ok, true);
  assert.equal(mod.transitionLifecycleState("runtime_discovered", "canary_passed").ok, true);
  assert.equal(mod.transitionLifecycleState("implemented_verified", "reloaded_discovered").ok, true);
  assert.equal(mod.transitionLifecycleState("reloaded_discovered", "canary_passed").ok, true);

  // Idempotent same-status
  assert.equal(mod.transitionLifecycleState("proposed", "proposed").ok, true);
  assert.equal(mod.transitionLifecycleState("canary_passed", "canary_passed").ok, true);

  // Backward transitions rejected
  assert.equal(mod.transitionLifecycleState("implementation_reported", "proposed").ok, false);
  assert.equal(mod.transitionLifecycleState("implemented_verified", "proposed").ok, false);
  assert.equal(mod.transitionLifecycleState("canary_passed", "reloaded_discovered").ok, false);

  // Skipped transitions rejected
  assert.equal(mod.transitionLifecycleState("proposed", "implemented_verified").ok, false);
  assert.equal(mod.transitionLifecycleState("proposed", "canary_passed").ok, false);
  assert.equal(mod.transitionLifecycleState("implementation_reported", "canary_passed").ok, false);

  // Compute helpers
  assert.equal(mod.computeUsable("proposed"), false);
  assert.equal(mod.computeUsable("canary_passed"), true);
  assert.equal(mod.computeUsable("implemented_verified"), false);
  assert.equal(mod.computeReloadRequired("implemented_verified"), true);
  assert.equal(mod.computeReloadRequired("proposed"), false);
  assert.equal(mod.computeReloadRequired("canary_passed"), false);
  assert.equal(mod.computeNextRequiredGate("proposed"), "implementation");
  assert.equal(mod.computeNextRequiredGate("implementation_reported"), "implementation_verification");
  assert.equal(mod.computeNextRequiredGate("declarative_verified"), "runtime_discovery");
  assert.equal(mod.computeNextRequiredGate("implemented_verified"), "agent_reload");
  assert.equal(mod.computeNextRequiredGate("reloaded_discovered"), "canary");
  assert.equal(mod.computeNextRequiredGate("canary_passed"), "none");

  // Name normalization
  assert.equal(mod.normalizeShapeName("  My Test-Shape!! "), "my-test-shape");
  assert.equal(mod.normalizeShapeName("Débaté → Synthesis"), "debate-synthesis");
  assert.ok(mod.normalizeShapeName("_bad").startsWith("bad"));

  // Build initial lifecycle state
  const state = mod.buildInitialLifecycleState("/tmp/ext", "test-shape", ["a.ts"], []);
  assert.equal(state.lifecycleStatus, "proposed");
  assert.equal(state.usable, false);
  assert.equal(state.reloadRequired, false);
  assert.equal(state.nextRequiredGate, "implementation");
  assert.deepEqual(state.generatedFiles, ["a.ts"]);
  assert.ok(state.history.length >= 1);

  // Transition and update
  const result = mod.transitionAndUpdateState(state, "implementation_reported", "actor", {});
  assert.equal(result.success, true);
  assert.equal(result.state.lifecycleStatus, "implementation_reported");
  assert.equal(result.state.reloadRequired, false);

  // Record failure
  const failed = mod.recordFailure(state, "implementation", "bad", {});
  assert.equal(failed.failures.length, 1);

  // Spec parsing
  const specJson = JSON.stringify({
    schemaVersion: 1,
    action: "build",
    targetName: "my-test-shape",
    purpose: "Test purpose",
    phases: [{ name: "phase1", role: "test", agentName: "coder", prompt: "do it", expectedOutput: "done" }],
    maxSubagents: 3,
    maxIterations: 1,
    terminationCondition: "Stop after phase.",
    evidenceModel: "Direct evidence.",
    failureBehavior: "Fail on error.",
    userFacingExplanation: "Test shape.",
  });
  const parsed = mod.parseShapeBuilderSpecFromTask(specJson);
  assert.ok(!("error" in parsed), `Parse should succeed: ${parsed.error || ""}`);
  assert.equal(parsed.targetName, "my-test-shape");
  assert.equal(parsed.artifactKind, "declarative-workflow", "ordinary builds must default to declarative data");
  assert.equal(parsed.scope, "user", "ordinary builds must default to durable user scope");

  // Parser is strict: unknown fields and non-string phase fields are rejected
  // rather than silently discarded/coerced before validation.
  const unknownField = mod.parseShapeBuilderSpecFromTask(JSON.stringify({
    ...JSON.parse(specJson),
    coordinatorShell: "powershell",
  }));
  assert.ok("error" in unknownField);
  assert.match(unknownField.error, /unknown field/);
  const unknownPhaseField = mod.parseShapeBuilderSpecFromTask(JSON.stringify({
    ...JSON.parse(specJson),
    phases: [{ ...JSON.parse(specJson).phases[0], command: "echo unsafe" }],
  }));
  assert.ok("error" in unknownPhaseField);
  assert.match(unknownPhaseField.error, /unknown field/);
  const coercedPrompt = mod.parseShapeBuilderSpecFromTask(JSON.stringify({
    ...JSON.parse(specJson),
    phases: [{ ...JSON.parse(specJson).phases[0], prompt: { command: "no" } }],
  }));
  assert.ok("error" in coercedPrompt);
  assert.match(coercedPrompt.error, /must be strings/);

  // Spec validation
  const reserved = new Set(["existing-shape"]);
  assert.deepEqual(mod.validateShapeBuilderSpec(parsed, reserved), []);

  // Reserved name rejection
  const reservedSpec = { ...parsed, targetName: "shape-builder" };
  assert.ok(mod.validateShapeBuilderSpec(reservedSpec, new Set(["shape-builder"])).some((e) => /reserved/.test(e)));

  // Unbounded loop rejection
  const loopSpec = { ...parsed, terminationCondition: "Keep iterating until perfect." };
  assert.ok(mod.validateShapeBuilderSpec(loopSpec, reserved).some((e) => /unbounded-loop/.test(e)));

  // maxIterations !== 1
  const iterSpec = { ...parsed, maxIterations: 2 };
  assert.ok(mod.validateShapeBuilderSpec(iterSpec, reserved).some((e) => /maxIterations/.test(e)));

  // maxSubagents < phase count
  const capSpec = { ...parsed, maxSubagents: 0 };
  assert.ok(mod.validateShapeBuilderSpec(capSpec, reserved).some((e) => /maxSubagents/.test(e)));
  const fractionalCapSpec = { ...parsed, maxSubagents: 1.5 };
  assert.ok(mod.validateShapeBuilderSpec(fractionalCapSpec, reserved).some((e) => /maxSubagents/.test(e)),
    "fractional spawn caps must be rejected before compilation");
  const unsafeRawName = { ...parsed, targetName: "../Normalized Away" };
  assert.ok(mod.validateShapeBuilderSpec(unsafeRawName, reserved).some((e) => /already be safe lowercase kebab-case/.test(e)),
    "unsafe raw names must not be silently normalized into an accepted artifact name");
  const duplicatePhaseIds = {
    ...parsed,
    phases: [parsed.phases[0], { ...parsed.phases[0], name: "phase1!!" }],
    maxSubagents: 2,
  };
  assert.ok(mod.validateShapeBuilderSpec(duplicatePhaseIds, reserved).some((e) => /duplicates normalized phase id/.test(e)));
  const oversizedPrompt = {
    ...parsed,
    phases: [{ ...parsed.phases[0], prompt: "x".repeat(mod.MAX_SHAPE_BUILDER_PROMPT_CHARS + 1) }],
  };
  assert.ok(mod.validateShapeBuilderSpec(oversizedPrompt, reserved).some((e) => /prompt must be at most/.test(e)));

  // Strict parser must preserve invalid schemaVersion/action so validation rejects them.
  const invalidParsed = mod.parseShapeBuilderSpecFromTask(JSON.stringify({
    ...JSON.parse(specJson),
    schemaVersion: 999,
    action: "delete",
  }));
  assert.ok(!("error" in invalidParsed), `invalid schema/action JSON should still parse for validation: ${invalidParsed.error || ""}`);
  const invalidErrors = mod.validateShapeBuilderSpec(invalidParsed, reserved);
  assert.ok(invalidErrors.some((e) => /schemaVersion/.test(e)), "invalid schemaVersion must be rejected");
  assert.ok(invalidErrors.some((e) => /action/.test(e)), "invalid action must be rejected");

  const siblingImportSpec = { ...parsed, purpose: 'try import { x } from "./verify-only";' };
  assert.ok(mod.validateShapeBuilderSpec(siblingImportSpec, reserved).some((e) => /sibling-import/.test(e)),
    "sibling-import text in spec fields must be rejected");

  const forbiddenRuntimeCallSpec = { ...parsed, failureBehavior: "Call agent_reload_runtime() when done." };
  assert.ok(mod.validateShapeBuilderSpec(forbiddenRuntimeCallSpec, reserved).some((e) => /forbidden runtime-call/.test(e)),
    "forbidden runtime-call text in spec fields must be rejected");
}

// ── Test: shape source rendering ──────────────────────────────────────────

function testShapeRendering() {
  const mod = loadSupportModule();

  const spec = {
    schemaVersion: 1,
    action: "build",
    targetName: "test-render-shape",
    purpose: "A test rendering shape.",
    phases: [
      { name: "step-one", role: "analyzer", agentName: "planner", prompt: "Analyze the task.", expectedOutput: "Analysis results." },
      { name: "step-two", role: "executor", agentName: "coder", prompt: "Execute the task.", expectedOutput: "Execution results." },
    ],
    maxSubagents: 3,
    maxIterations: 1,
    terminationCondition: "Stop after two phases.",
    evidenceModel: "Direct evidence.",
    failureBehavior: "Fail on any phase error.",
    userFacingExplanation: "Two-phase test shape.",
  };

  const source = mod.renderShapeSource(spec);
  assert.match(source, /export const testRenderShapeShape:\s*OrchestrationShape/);
  assert.match(source, /SHAPE_CANARY:test-render-shape/);
  assert.match(source, /canary:\s*true/);
  assert.match(source, /spawnedCount:\s*0/);
  assert.match(source, /new SpawnGuard\(/);
  assert.match(source, /spawnSubagent\(/);

  // Native rendering must JSON-quote policy text instead of interpolating it
  // into a generated template literal (backslash + backtick is a breakout edge).
  const injectionSource = mod.renderShapeSource({
    ...spec,
    terminationCondition: "stop\\`); throw new Error('injected') //",
    evidenceModel: "evidence ${process.env.SECRET}",
  });
  assert.doesNotMatch(injectionSource, /\*\*Termination:\*\* stop\\`\)/);
  assert.match(injectionSource, /"\*\*Termination:\*\* " \+ "stop/);
  assert.match(injectionSource, /"\*\*Evidence model:\*\* " \+ "evidence \$\{process\.env\.SECRET\}"/);

  // Static checks
  const errors = mod.staticCheckGeneratedShape(source);
  assert.deepEqual(errors, [], `Generated source should pass static checks: ${errors.join("; ")}`);

  // Static check should catch missing canary
  const noCanary = source.replace(/SHAPE_CANARY:test-render-shape/g, "NO_CANARY_HERE");
  const noCanaryErrors = mod.staticCheckGeneratedShape(noCanary);
  assert.ok(noCanaryErrors.some((e) => /SHAPE_CANARY/.test(e)), "should catch missing SHAPE_CANARY");

  // Static check should catch sibling imports
  const withSibling = source + '\nimport { x } from "./verify-only";';
  assert.ok(mod.staticCheckGeneratedShape(withSibling).some((e) => /sibling/.test(e)));
}

// ── Test: test source rendering ────────────────────────────────────────────

function testTestRendering() {
  const mod = loadSupportModule();
  const testSource = mod.renderShapeTest("test-render-shape");
  assert.match(testSource, /test-render-shape/);
  assert.match(testSource, /SHAPE_CANARY:/);
  assert.match(testSource, /spawnSubagent/);
  // The rendered test source contains agent_reload_runtime in its assertions —
  // that's correct (it's testing the generated shape for forbidden calls).
  assert.match(testSource, /agent_reload_runtime/, "test should assert no forbidden reload calls");
}

// ── Test: verifier JSON parsing ───────────────────────────────────────────

function testVerifierJsonParsing() {
  const mod = loadSupportModule();

  // Valid PASS JSON
  const passJson = JSON.stringify({
    overall: "pass",
    implemented_verified: true,
    reloadRequired: true,
    targetName: "test-target",
    lifecycleStatePath: "/tmp/lifecycle.json",
    checks: [
      { id: "files", status: "pass", citations: ["f:1"] },
      { id: "registry", status: "pass", citations: ["r:1"] },
      { id: "docs", status: "pass", citations: ["d:1"] },
      { id: "tests", status: "pass", citations: ["t:1"] },
      { id: "forbidden-behavior", status: "pass", citations: ["fb:1"] },
      { id: "sibling-rule", status: "pass", citations: ["sr:1"] },
      { id: "lifecycle", status: "pass", citations: ["l:1"] },
      { id: "canary-template", status: "pass", citations: ["ct:1"] },
    ],
    commands: [
      { command: "node tests/test-test-target.cjs", exitCode: 0, stdoutSnippet: "PASS" },
      { command: "npm test", exitCode: 0, stdoutSnippet: "PASS" },
    ],
    failReasons: [],
  });
  const passResult = mod.parseVerifierJson(passJson, "test-target", "/tmp/lifecycle.json");
  assert.ok(!("error" in passResult), `PASS should parse: ${passResult.error || ""}`);
  assert.equal(passResult.overall, "pass");
  assert.equal(passResult.implemented_verified, true);
  assert.equal(passResult.reloadRequired, true);

  // FAIL JSON
  const failJson = JSON.stringify({
    overall: "fail",
    implemented_verified: false,
    reloadRequired: false,
    targetName: "test-target",
    lifecycleStatePath: "/tmp/lifecycle.json",
    checks: [],
    commands: [],
    failReasons: ["Tests failed."],
  });
  const failResult = mod.parseVerifierJson(failJson, "test-target", "/tmp/lifecycle.json");
  assert.ok(!("error" in failResult));
  assert.equal(failResult.overall, "fail");
  assert.equal(failResult.implemented_verified, false);

  // Non-JSON text
  const nonJsonResult = mod.parseVerifierJson("just some text", "test-target", "/tmp/lifecycle.json");
  assert.ok("error" in nonJsonResult);

  // Missing check
  const missingCheck = JSON.stringify({
    overall: "pass",
    implemented_verified: true,
    reloadRequired: true,
    targetName: "test-target",
    lifecycleStatePath: "/tmp/lifecycle.json",
    checks: [
      { id: "files", status: "pass", citations: ["f:1"] },
    ],
    commands: [
      { command: "node tests/test-test-target.cjs", exitCode: 0, stdoutSnippet: "PASS" },
      { command: "npm test", exitCode: 0, stdoutSnippet: "PASS" },
    ],
    failReasons: [],
  });
  const missingResult = mod.parseVerifierJson(missingCheck, "test-target", "/tmp/lifecycle.json");
  assert.ok("error" in missingResult);
  assert.match(missingResult.error, /Missing required check/);

  // Wrong targetName
  const wrongTarget = JSON.stringify({
    overall: "pass",
    implemented_verified: true,
    reloadRequired: true,
    targetName: "wrong-name",
    lifecycleStatePath: "/tmp/lifecycle.json",
    checks: [
      { id: "files", status: "pass", citations: ["f:1"] },
      { id: "registry", status: "pass", citations: ["r:1"] },
      { id: "docs", status: "pass", citations: ["d:1"] },
      { id: "tests", status: "pass", citations: ["t:1"] },
      { id: "forbidden-behavior", status: "pass", citations: ["fb:1"] },
      { id: "sibling-rule", status: "pass", citations: ["sr:1"] },
      { id: "lifecycle", status: "pass", citations: ["l:1"] },
      { id: "canary-template", status: "pass", citations: ["ct:1"] },
    ],
    commands: [
      { command: "node tests/test-test-target.cjs", exitCode: 0, stdoutSnippet: "PASS" },
      { command: "npm test", exitCode: 0, stdoutSnippet: "PASS" },
    ],
    failReasons: [],
  });
  const wrongResult = mod.parseVerifierJson(wrongTarget, "test-target", "/tmp/lifecycle.json");
  assert.ok("error" in wrongResult);
  assert.match(wrongResult.error, /targetName mismatch/);

  // Check with "fail" status
  const failCheck = JSON.stringify({
    overall: "pass",
    implemented_verified: true,
    reloadRequired: true,
    targetName: "test-target",
    lifecycleStatePath: "/tmp/lifecycle.json",
    checks: [
      { id: "files", status: "pass", citations: ["f:1"] },
      { id: "registry", status: "pass", citations: ["r:1"] },
      { id: "docs", status: "pass", citations: ["d:1"] },
      { id: "tests", status: "fail", citations: ["t:1"] },
      { id: "forbidden-behavior", status: "pass", citations: ["fb:1"] },
      { id: "sibling-rule", status: "pass", citations: ["sr:1"] },
      { id: "lifecycle", status: "pass", citations: ["l:1"] },
      { id: "canary-template", status: "pass", citations: ["ct:1"] },
    ],
    commands: [
      { command: "node tests/test-test-target.cjs", exitCode: 0, stdoutSnippet: "PASS" },
      { command: "npm test", exitCode: 0, stdoutSnippet: "PASS" },
    ],
    failReasons: [],
  });
  const failCheckResult = mod.parseVerifierJson(failCheck, "test-target", "/tmp/lifecycle.json");
  assert.ok("error" in failCheckResult);
  assert.match(failCheckResult.error, /not "pass"/);

  // Overall pass must still be rejected if any required command is nonzero.
  const nonzeroCommand = JSON.stringify({
    overall: "pass",
    implemented_verified: true,
    reloadRequired: true,
    targetName: "test-target",
    lifecycleStatePath: "/tmp/lifecycle.json",
    checks: [
      { id: "files", status: "pass", citations: ["f:1"] },
      { id: "registry", status: "pass", citations: ["r:1"] },
      { id: "docs", status: "pass", citations: ["d:1"] },
      { id: "tests", status: "pass", citations: ["t:1"] },
      { id: "forbidden-behavior", status: "pass", citations: ["fb:1"] },
      { id: "sibling-rule", status: "pass", citations: ["sr:1"] },
      { id: "lifecycle", status: "pass", citations: ["l:1"] },
      { id: "canary-template", status: "pass", citations: ["ct:1"] },
    ],
    commands: [
      { command: "node tests/test-test-target.cjs", exitCode: 1, stdoutSnippet: "FAIL" },
      { command: "npm test", exitCode: 0, stdoutSnippet: "PASS" },
    ],
    failReasons: [],
  });
  const nonzeroResult = mod.parseVerifierJson(nonzeroCommand, "test-target", "/tmp/lifecycle.json");
  assert.ok("error" in nonzeroResult, "nonzero verifier command must reject implemented_verified");
  assert.match(nonzeroResult.error, /exit 1/);
}

// ── Test: extension root resolution ────────────────────────────────────────

function testExtensionRoot() {
  const mod = loadSupportModule();
  // With override
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sb-root-"));
  process.env.PI_SHAPE_BUILDER_EXTENSION_ROOT = tempDir;
  try {
    assert.equal(mod.resolveExtensionRoot("file:///some/shape.ts"), tempDir);
  } finally {
    delete process.env.PI_SHAPE_BUILDER_EXTENSION_ROOT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // resolveInRoot safety
  assert.throws(() => mod.resolveInRoot("/tmp/ext", "../../etc/passwd"), /escapes extension root/);
}

// ── Test: lifecycle read/write atomicity ──────────────────────────────────

async function testLifecyclePersistence() {
  const mod = loadSupportModule();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sb-lifecycle-"));
  try {
    const statePath = mod.lifecycleStatePath(tempDir, "test-persist");
    const state = mod.buildInitialLifecycleState(tempDir, "test-persist", ["a.ts", "b.ts"], []);
    await mod.writeLifecycleState(state);

    assert.ok(fs.existsSync(statePath));

    const loaded = await mod.readLifecycleState(statePath);
    assert.ok(loaded);
    assert.equal(loaded.targetName, "test-persist");
    assert.equal(loaded.lifecycleStatus, "proposed");
    assert.equal(loaded.usable, false);

    // Lifecycle persistence must not follow a file symlink out of the trusted
    // root. Windows without Developer Mode may deny symlink creation; only
    // that platform limitation is skipped.
    const outside = path.join(tempDir, "outside-lifecycle.json");
    fs.writeFileSync(outside, "{}\n");
    const symlinkState = mod.buildInitialLifecycleState(tempDir, "symlinked", [], []);
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outside, symlinkState.lifecycleStatePath, "file");
      symlinkCreated = true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }
    if (symlinkCreated) {
      await assert.rejects(() => mod.writeLifecycleState(symlinkState), /symlink lifecycle state/);
      assert.equal(fs.readFileSync(outside, "utf8"), "{}\n", "outside lifecycle target must remain untouched");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Test: continuation template ───────────────────────────────────────────

function testContinuationTemplate() {
  const mod = loadSupportModule();
  const template = mod.buildContinuationTemplate("my-shape");
  assert.match(template, /^RESUME AFTER PI RELOAD:/);
  assert.match(template, /agent-reload-diagnostics\.json/);
  assert.match(template, /my-shape/);
}

// ── Test: verifier prompt includes required markers ───────────────────────

function testVerifierPrompt() {
  const mod = loadSupportModule();
  const prompt = mod.buildImplementationVerifierPrompt({
    targetName: "test-shape",
    extensionRoot: "/tmp",
    lifecycleStatePath: "/tmp/lifecycle.json",
    generatedFiles: ["src/shapes/test-shape.ts", "tests/test-test-shape.cjs"],
    anchoredEditPaths: ["src/index.ts"],
    testCommand: "node tests/test-test-shape.cjs",
  });
  assert.match(prompt, /SHAPE-BUILDER IMPLEMENTATION VERIFIER/);
  assert.match(prompt, /INDEPENDENT IMPLEMENTATION VERIFIER/);
  assert.match(prompt, /test-shape/);
  assert.match(prompt, /"files"/);
  assert.match(prompt, /"registry"/);
  assert.match(prompt, /"docs"/);
  assert.match(prompt, /"tests"/);
  assert.match(prompt, /"forbidden-behavior"/);
  assert.match(prompt, /"sibling-rule"/);
  assert.match(prompt, /"lifecycle"/);
  assert.match(prompt, /"canary-template"/);
}

function prepareTempExtensionRoot(extRoot) {
  fs.mkdirSync(path.join(extRoot, "src", "shapes"), { recursive: true });
  fs.mkdirSync(path.join(extRoot, "tests"), { recursive: true });

  // Copy central files with real anchors so anchored edits exercise the same
  // deterministic build path as production, but use a tiny npm test script to
  // avoid recursive shape-builder integration tests inside the temp root.
  for (const file of ["src/index.ts", "README.md", "PARADIGMS.md"]) {
    fs.cpSync(path.join(PROJECT_ROOT, file), path.join(extRoot, file));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  pkg.scripts = { test: "node tests/test-placeholder.cjs" };
  fs.writeFileSync(path.join(extRoot, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(extRoot, "tests", "test-placeholder.cjs"), "console.log('PASS placeholder temp-root test');\n", "utf8");

  fs.cpSync(path.join(PROJECT_ROOT, "tests", "fake-pi.cjs"), path.join(extRoot, "tests", "fake-pi.cjs"));
  fs.cpSync(path.join(PROJECT_ROOT, "src", "substrate.ts"), path.join(extRoot, "src", "substrate.ts"));
  fs.cpSync(path.join(PROJECT_ROOT, "src", "types.ts"), path.join(extRoot, "src", "types.ts"));
  fs.cpSync(path.join(PROJECT_ROOT, "src", "judgment.ts"), path.join(extRoot, "src", "judgment.ts"));
  fs.cpSync(path.join(PROJECT_ROOT, "src", "shape-builder-support.ts"), path.join(extRoot, "src", "shape-builder-support.ts"));
  fs.mkdirSync(path.join(extRoot, "src", "executor-recovery"), { recursive: true });
  try { fs.cpSync(path.join(PROJECT_ROOT, "src", "executor-recovery"), path.join(extRoot, "src", "executor-recovery"), { recursive: true }); } catch {}
}

// ── Test: temp-root build via fake Pi ─────────────────────────────────────

async function testTempRootBuildWithFakePi() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sb-build-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  const extRoot = path.join(tempDir, "ext-root");
  prepareTempExtensionRoot(extRoot);
  const immutableExtensionFiles = ["src/index.ts", "package.json", "README.md", "PARADIGMS.md"];
  const extensionBaseline = new Map(immutableExtensionFiles.map((file) => [
    file,
    fs.readFileSync(path.join(extRoot, file), "utf8"),
  ]));

  process.env.PI_SHAPE_BUILDER_EXTENSION_ROOT = extRoot;
  const userWorkflowRoot = path.join(tempDir, "user-workflows");
  const projectWorkflowRoot = path.join(tempDir, "project-workflows");
  process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT = userWorkflowRoot;
  process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT = projectWorkflowRoot;

  try {
    const tool = loadOrchestrateTool();
    const specJson = JSON.stringify({
      schemaVersion: 1,
      action: "build",
      targetName: "temp-build-test",
      purpose: "A test shape built in a temp root.",
      phases: [
        { name: "analyze", role: "analyst", agentName: "planner", prompt: "Analyze.", expectedOutput: "Analysis." },
      ],
      maxSubagents: 3,
      maxIterations: 1,
      terminationCondition: "Stop after analysis phase.",
      evidenceModel: "Phase output evidence.",
      failureBehavior: "Fail on phase error.",
      userFacingExplanation: "Single-phase analysis shape.",
    });

    const result = await tool.execute(
      "test-shape-builder-temp-root",
      {
        task: specJson,
        paradigm: "shape-builder",
        preflight: false,
        cwd: extRoot,
        maxSubagents: 5,
        plannerModel: "gpt-5.5", plannerProvider: "openai-codex",
        executorModel: "deepseek-v4-pro", executorProvider: "deepseek",
        verifierModel: "gpt-5.5", verifierProvider: "openai-codex",
      },
      undefined,
      () => {},
      { cwd: extRoot },
    );

    // The fake-pi.js fixture should return PASS verifier JSON by default
    const details = result.details;
    assert.equal(details.paradigm, "shape-builder");
    assert.equal(details.targetName, "temp-build-test");
    assert.equal(details.lifecycleStatus, "canary_passed");
    assert.equal(details.implemented_verified, true);
    assert.equal(details.usable, true);
    assert.equal(details.reloadRequired, false);
    assert.equal(details.nextRequiredGate, "none");
    assert.equal(details.artifactKind, "declarative-workflow");
    assert.equal(details.canary.spawnedCount, 0);
    assert.equal(details.spawnedCount, 0);

    // Ordinary builds publish only durable JSON under the selected trusted
    // workflow root; they do not generate extension TypeScript or tests.
    const artifactPath = path.join(userWorkflowRoot, "temp-build-test.workflow.json");
    const lifecyclePath = path.join(userWorkflowRoot, "shape-builder-lifecycle", "temp-build-test.json");
    assert.ok(fs.existsSync(artifactPath), "declarative workflow should exist in temp user root");
    assert.ok(fs.existsSync(lifecyclePath), "lifecycle JSON should exist beside the trusted workflow root");
    assert.equal(fs.existsSync(path.join(extRoot, "src", "shapes", "temp-build-test.ts")), false);
    assert.equal(fs.existsSync(path.join(extRoot, "tests", "test-temp-build-test.cjs")), false);

    const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, "utf8"));
    assert.equal(lifecycle.lifecycleStatus, "canary_passed");
    assert.equal(lifecycle.usable, true);
    assert.equal(lifecycle.reloadRequired, false);

    // A normal orchestrate invocation in this same loaded process discovers
    // the new name immediately; no extension reload or static import is used.
    const immediate = await tool.execute(
      "test-shape-builder-immediate-canary",
      { task: "SHAPE_CANARY", paradigm: "temp-build-test", preflight: false, cwd: extRoot },
      undefined,
      () => {},
      { cwd: extRoot },
    );
    assert.equal(immediate.details.status, "pass");
    assert.equal(immediate.details.canary, true);
    assert.equal(immediate.details.spawnedCount, 0);

    // Differing content may not overwrite an existing durable artifact.
    const originalArtifact = fs.readFileSync(artifactPath, "utf8");
    const differingResult = await tool.execute(
      "test-shape-builder-collision",
      { task: JSON.stringify({ ...JSON.parse(specJson), purpose: "Different content." }), paradigm: "shape-builder", preflight: false, cwd: extRoot },
      undefined,
      () => {},
      { cwd: extRoot },
    );
    assert.equal(differingResult.details.status, "fail");
    assert.match(differingResult.details.failureReason, /already exists and differs/);
    assert.equal(fs.readFileSync(artifactPath, "utf8"), originalArtifact, "collision must preserve original bytes");

    // Explicit project scope publishes beneath the project-owned trusted root.
    const projectSpec = {
      ...JSON.parse(specJson),
      targetName: "temp-project-build-test",
      scope: "project",
    };
    const projectResult = await tool.execute(
      "test-shape-builder-project-scope",
      { task: JSON.stringify(projectSpec), paradigm: "shape-builder", preflight: false, cwd: extRoot, maxSubagents: 5 },
      undefined,
      () => {},
      { cwd: extRoot },
    );
    assert.equal(projectResult.details.status, "pass");
    assert.equal(projectResult.details.scope, "project");
    assert.ok(fs.existsSync(path.join(projectWorkflowRoot, "temp-project-build-test.workflow.json")));

    // A user-scope build may not claim success when a same-name project entry
    // has deterministic precedence.
    const hiddenUserResult = await tool.execute(
      "test-shape-builder-project-precedence",
      { task: JSON.stringify({ ...projectSpec, scope: "user" }), paradigm: "shape-builder", preflight: false, cwd: extRoot },
      undefined,
      () => {},
      { cwd: extRoot },
    );
    assert.equal(hiddenUserResult.details.status, "fail");
    assert.match(hiddenUserResult.details.failureReason, /already has precedence/);
    assert.equal(fs.existsSync(path.join(userWorkflowRoot, "temp-project-build-test.workflow.json")), false);

    // Existing symlinks are collisions, never publication targets. Skip only
    // when the host cannot create symlinks (common on Windows without Dev Mode).
    const outsideArtifact = path.join(tempDir, "outside.workflow.json");
    fs.writeFileSync(outsideArtifact, originalArtifact);
    const symlinkArtifact = path.join(userWorkflowRoot, "symlink-build-test.workflow.json");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideArtifact, symlinkArtifact, "file");
      symlinkCreated = true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }
    if (symlinkCreated) {
      const symlinkResult = await tool.execute(
        "test-shape-builder-symlink-collision",
        { task: JSON.stringify({ ...JSON.parse(specJson), targetName: "symlink-build-test" }), paradigm: "shape-builder", preflight: false, cwd: extRoot },
        undefined,
        () => {},
        { cwd: extRoot },
      );
      assert.equal(symlinkResult.details.status, "fail");
      assert.match(symlinkResult.details.failureReason, /non-regular workflow artifact/);
    }

    for (const [file, baseline] of extensionBaseline) {
      assert.equal(fs.readFileSync(path.join(extRoot, file), "utf8"), baseline, `ordinary build must not edit ${file}`);
    }
    assert.equal(fs.existsSync(logPath), false, "declarative build/discovery/canary must spawn no Pi subprocess");

  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.PI_SHAPE_BUILDER_EXTENSION_ROOT;
    delete process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT;
    delete process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Test: verifier FAIL fixture ───────────────────────────────────────────

async function testVerifierFailFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sb-verifier-fail-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  const extRoot = path.join(tempDir, "ext-root");
  prepareTempExtensionRoot(extRoot);

  process.env.PI_SHAPE_BUILDER_EXTENSION_ROOT = extRoot;
  process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT = path.join(tempDir, "user-workflows");
  process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT = path.join(tempDir, "project-workflows");

  try {
    const tool = loadOrchestrateTool();
    const spec = {
      schemaVersion: 1,
      action: "build",
      artifactKind: "native-shape",
      targetName: "native-success-test",
      purpose: "Test explicit native lifecycle.",
      phases: [{ name: "p1", role: "r1", agentName: "coder", prompt: "do", expectedOutput: "done" }],
      maxSubagents: 3,
      maxIterations: 1,
      terminationCondition: "Stop.",
      evidenceModel: "Evidence.",
      failureBehavior: "Fail.",
      userFacingExplanation: "Test.",
    };

    // A native build must not shadow an existing durable declarative name.
    fs.mkdirSync(process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT, "native-collision-test.workflow.json"), "{}\n");
    const collisionResult = await tool.execute(
      "test-shape-builder-native-collision",
      { task: JSON.stringify({ ...spec, targetName: "native-collision-test" }), paradigm: "shape-builder", preflight: false, cwd: extRoot, maxSubagents: 5 },
      undefined,
      () => {},
      { cwd: extRoot },
    );
    assert.equal(collisionResult.details.status, "fail");
    assert.match(collisionResult.details.failureReason, /collides with existing user workflow artifact/);
    assert.equal(fs.existsSync(path.join(extRoot, "src", "shapes", "native-collision-test.ts")), false);

    // Explicit native mode retains its historical verifier and reload gate.
    const nativeSuccess = await tool.execute(
      "test-shape-builder-native-success",
      { task: JSON.stringify(spec), paradigm: "shape-builder", preflight: false, cwd: extRoot, maxSubagents: 5 },
      undefined,
      () => {},
      { cwd: extRoot },
    );
    assert.equal(nativeSuccess.details.status, "pass");
    assert.equal(nativeSuccess.details.lifecycleStatus, "implemented_verified");
    assert.equal(nativeSuccess.details.usable, false);
    assert.equal(nativeSuccess.details.reloadRequired, true);
    assert.equal(nativeSuccess.details.nextRequiredGate, "agent_reload");
    assert.equal(nativeSuccess.details.spawnedCount, 1);
    assert.ok(fs.existsSync(path.join(extRoot, "src", "shapes", "native-success-test.ts")));

    process.env.FAKE_PI_SHAPE_BUILDER_VERIFIER_STATUS = "fail";
    const specJson = JSON.stringify({ ...spec, targetName: "verifier-fail-test", purpose: "Test verifier fail fixture." });
    const result = await tool.execute(
      "test-shape-builder-verifier-fail",
      {
        task: specJson,
        paradigm: "shape-builder",
        preflight: false,
        cwd: extRoot,
        maxSubagents: 5,
      },
      undefined,
      () => {},
      { cwd: extRoot },
    );

    const details = result.details;
    assert.equal(details.status, "fail");
    assert.equal(details.paradigm, "shape-builder");
    assert.equal(details.lifecycleStatus, "implementation_reported");
    assert.equal(details.implemented_verified, false);
    assert.equal(details.usable, false);
    assert.equal(details.reloadRequired, false);

  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.PI_SHAPE_BUILDER_EXTENSION_ROOT;
    delete process.env.PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT;
    delete process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT;
    delete process.env.FAKE_PI_SHAPE_BUILDER_VERIFIER_STATUS;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Test: paradigm-creator regression ─────────────────────────────────────

async function testParadigmCreatorRegression() {
  const tool = loadOrchestrateTool();
  const result = await tool.execute(
    "test-shape-builder-pc-regression",
    { task: "list paradigms", paradigm: "unknown-test-pc", preflight: false, cwd: PROJECT_ROOT },
    undefined,
    () => {},
    { cwd: PROJECT_ROOT },
  );
  assert.match(result.details.abortReason, /paradigm-creator/);
  assert.match(result.details.abortReason, /shape-builder/);
}

// ── Test: spec validation with reserved names ─────────────────────────────

function testSpecValidationReserved() {
  const mod = loadSupportModule();
  const reserved = new Set(["plan-execute-verify", "shape-builder", "verify-only"]);

  const baseSpec = {
    schemaVersion: 1,
    action: "build",
    targetName: "shape-builder",
    purpose: "Test",
    phases: [{ name: "p1", role: "r1", agentName: "coder", prompt: "do", expectedOutput: "done" }],
    maxSubagents: 3,
    maxIterations: 1,
    terminationCondition: "Stop.",
    evidenceModel: "Evidence.",
    failureBehavior: "Fail.",
    userFacingExplanation: "Test.",
  };

  const errors = mod.validateShapeBuilderSpec(baseSpec, reserved);
  assert.ok(errors.some((e) => /reserved/.test(e)), "shape-builder should be reserved");

  const planExec = { ...baseSpec, targetName: "plan-execute-verify" };
  assert.ok(mod.validateShapeBuilderSpec(planExec, reserved).some((e) => /reserved/.test(e)));
}

// ── Main ──────────────────────────────────────────────────────────────────

async function run() {
  await testRegistryDiscovery();
  testCommittedShapeStaticRules();
  testLifecycleHelpers();
  testShapeRendering();
  testTestRendering();
  testVerifierJsonParsing();
  testExtensionRoot();
  await testLifecyclePersistence();
  testContinuationTemplate();
  testVerifierPrompt();
  testSpecValidationReserved();
  await testParadigmCreatorRegression();
  await testTempRootBuildWithFakePi();
  await testVerifierFailFixture();
  console.log("PASS shape-builder: strict schema/caps, lifecycle/path safety, reload-free declarative build/discovery/canary, collision protection, native reload regression");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
