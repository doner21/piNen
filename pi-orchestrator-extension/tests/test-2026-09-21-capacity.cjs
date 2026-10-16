#!/usr/bin/env node
/**
 * Item 1 focused regression.
 *
 * This harness creates every root before product import, never launches a
 * worker, and finishes naturally. It exercises production prompt builders,
 * Pi's complete launch assembly, launcher-equivalent model resolution, and the
 * shared admission function.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item1-capacity-"));
const WORKSPACE = path.join(TEMP_ROOT, "workspace");
const AGENT_DIR = path.join(TEMP_ROOT, "agent");
const RUNS_ROOT = path.join(TEMP_ROOT, "runs");
const NEXT_RUNS_ROOT = path.join(TEMP_ROOT, "next-runs");
for (const directory of [WORKSPACE, AGENT_DIR, RUNS_ROOT, NEXT_RUNS_ROOT]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), "{}\n", "utf8");
fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), "{}\n", "utf8");
fs.writeFileSync(path.join(AGENT_DIR, "models.json"), '{"providers":{}}\n', "utf8");

// PI_CODING_AGENT_DIR is Pi's real launcher configuration source. Keep the
// historical PI_AGENT_DIR alias equal for ordinary cases, then deliberately
// conflict them in the dedicated regression below.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_AGENT_DIR = AGENT_DIR;
process.env.PI_ORCHESTRATOR_RUNS_ROOT = RUNS_ROOT;
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = NEXT_RUNS_ROOT;
process.env.PI_OFFLINE = "1";

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const {
  buildExecutorPrompt,
  buildPlanningPrompt,
  buildVerificationPrompt,
  buildVisibleMainVerificationPrompt,
  loadAgents,
  resolveConfiguredRoleDefaults,
} = jiti(path.join(ROOT, "src", "index.ts"));
const { ActionEvidenceCollector } = jiti(path.join(ROOT, "src", "action-evidence.ts"));
const { resolveCompleteWorkerLaunchPrompt } = jiti(path.join(ROOT, "src", "substrate.ts"));
const {
  ADMISSION_ESTIMATE_MARGIN_PERCENT,
  ADMISSION_FRAMING_ALLOWANCE_TOKENS,
  DEFAULT_REPLY_RESERVE_TOKENS,
  assertWorkerPromptFitsCapacity,
} = jiti(path.join(ROOT, "src", "executor-recovery", "budget-estimator.ts"));
const {
  DEFAULT_COMPACTION_SETTINGS,
  ModelRuntime,
  estimateTokens,
  resolveCliModel,
} = jiti(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));

function fixtureIntake(originalTask) {
  return {
    originalTask,
    taskSummary: "Review an implementation while retaining complete owner authority and evidence.",
    taskType: "implementation-review",
    userIntent: "repair item 1 without dropping evidence",
    goalAttractor: "capacity admission reflects the complete assembled request",
    taskScope: "item 1 only",
    constraints: ["Keep all binding text.", "Keep every host action ledger entry."],
    invariants: ["No prompt truncation.", "No model fallback."],
    successCriteria: ["LATE_OWNER_SENTINEL_21_SEPTEMBER remains present."],
    deliverables: ["focused regression", "implementation"],
    failureCriteria: ["Any owner text or action evidence is omitted."],
    nonGoals: ["No planner/verifier recovery tiers in this item."],
    ambiguities: [],
    routingDecision: "planner Astra, executor Sol, verifier Astra",
    routingRequirements: [],
    orchestrationControls: {},
    inferredAdvisoryCriteria: [],
    criteriaProvenance: [],
    ownerCriteria: {
      success: ["LATE_OWNER_SENTINEL_21_SEPTEMBER remains present."],
      failure: ["Any owner text or action evidence is omitted."],
    },
    supervisorAddedConstraints: ["Do not set command time limits."],
    plannerInferredPresentationRules: [],
  };
}

function bindingBrief() {
  const heading = "BINDING OWNER BRIEF — 21 SEPTEMBER\n";
  const closing = "\nLATE_OWNER_SENTINEL_21_SEPTEMBER\nEND OF BINDING OWNER BRIEF";
  return heading + "Every sentence remains binding. Preserve tests, evidence, safety rules, and configured model limits.\n"
    + "owner-rule-line\n".repeat(760) + closing;
}

function actionLedger(commandCount = 31) {
  const collector = new ActionEvidenceCollector();
  for (let index = 1; index <= commandCount; index += 1) {
    const id = `call-${String(index).padStart(2, "0")}`;
    const command = `node tests/focused-${String(index).padStart(2, "0")}.cjs --fixture command-${index}`;
    collector.observe({ type: "tool_execution_start", toolCallId: id, toolName: "bash", input: { command } });
    collector.observe({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "bash",
      isError: false,
      result: { exitCode: 0, text: `PASS focused command ${index}` },
    });
  }
  return collector.finalize();
}

function denseCandidateText(minimumChars) {
  const lines = [];
  for (let index = 0; lines.join("\n").length < minimumChars; index += 1) {
    const hex = ((index * 2654435761) >>> 0).toString(16).padStart(8, "0");
    lines.push(
      `command-${index}: node tests/regression-${index % 37}.cjs --case=${hex}; ` +
      `observed={\"path\":\"src/module-${index % 91}.ts\",\"digest\":\"${hex}${(index + 17).toString(36)}\"}`,
    );
  }
  return lines.join("\n").slice(0, minimumChars);
}

function projectionBytes(launch, prompt) {
  return Buffer.byteLength(JSON.stringify({
    systemPrompt: launch.systemPrompt,
    messages: [{ role: "user", content: prompt }],
    tools: launch.toolSchemas,
  }), "utf8");
}

function makeOutput(candidateText, ledger) {
  return {
    taskId: "task-1",
    description: "Implement and verify item 1.",
    agentName: "executor",
    output: candidateText,
    stderr: undefined,
    exitCode: 0,
    durationMs: 91_000,
    toolCalls: { total: 31, mutating: 31, byName: { bash: 31 } },
    actionEvidence: ledger,
    filesChanged: 3,
    changedFiles: ["src/substrate.ts", "src/executor-recovery/budget-estimator.ts", "tests/item1.cjs"],
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  };
}

function buildSizedReviewer(builder, launch, intake, plan, mission, targetOldBytes, ledger) {
  let low = 0;
  let high = targetOldBytes;
  let best;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const output = makeOutput(denseCandidateText(middle), ledger);
    const prompt = builder === "classic"
      ? buildVerificationPrompt(intake, plan, [output], "planner/executor/verifier configured routes", "3 changed files; focused tests passed")
      : buildVisibleMainVerificationPrompt(intake, mission, plan, [output]);
    const bytes = projectionBytes(launch, prompt);
    best = { prompt, output, bytes };
    if (bytes < targetOldBytes) low = middle + 1;
    else if (bytes > targetOldBytes) high = middle - 1;
    else break;
  }
  assert.ok(Math.abs(best.bytes - targetOldBytes) < 256,
    `fixture projection should be close to observed ${targetOldBytes}, got ${best.bytes}`);
  return best;
}

async function capacityCase() {
  assert.equal(typeof estimateTokens, "function", "Pi public estimateTokens must be available");
  assert.equal(estimateTokens({ role: "user", content: "x".repeat(17), timestamp: 0 }), 5,
    "test records Pi estimateTokens chars/4 behavior without calling it exact");

  const launch = await resolveCompleteWorkerLaunchPrompt({
    cwd: WORKSPACE,
    profile: {
      name: "reviewer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      tools: ["read", "grep", "find", "ls", "bash"],
    },
    appendedSystemPrompt: "You are the isolated independent reviewer. Read source and run focused tests yourself.",
  });
  assert.equal(launch.contextWindow, 272_000);
  assert.equal(launch.maxOutputTokens, 128_000);

  const intake = fixtureIntake(bindingBrief());
  const ledger = actionLedger();
  const plan = {
    tasks: [{ id: "task-1", description: "Implement item 1 with tests first.", dependsOn: [], expectsFileChange: true }],
    notes: "Preserve owner text and host evidence.",
    predictedWriteSet: ["src/substrate.ts", "src/executor-recovery/budget-estimator.ts", "tests/"],
  };
  const mission = {
    originalTask: intake.originalTask,
    acceptanceCriteria: [{ id: "AC-01", text: intake.successCriteria[0], required: true }],
    workerExecutionConstraints: { noForceKill: true },
  };

  const executorPrompt = buildExecutorPrompt(intake, plan, plan.tasks[0]);
  assert.match(executorPrompt, /LATE_OWNER_SENTINEL_21_SEPTEMBER/);
  assert.doesNotThrow(() => assertWorkerPromptFitsCapacity({
    prompt: executorPrompt,
    completeSystemPrompt: launch.systemPrompt,
    toolSchemas: launch.toolSchemas,
    contextWindow: launch.contextWindow,
    maxOutputTokens: launch.maxOutputTokens,
    modelId: `${launch.provider}/${launch.model}`,
    bindingSection: "executor prompt",
  }));

  const fixtures = [
    ["visible", 230_347],
    ["classic", 240_292],
    ["visible", 269_176],
  ];
  for (const [builder, target] of fixtures) {
    const fixture = buildSizedReviewer(builder, launch, intake, plan, mission, target, ledger);
    assert.match(fixture.prompt, /LATE_OWNER_SENTINEL_21_SEPTEMBER/);
    for (let index = 1; index <= 31; index += 1) {
      assert.match(fixture.prompt, new RegExp(`call-${String(index).padStart(2, "0")}`),
        `${builder}/${target} lost action ledger entry ${index}`);
    }
    let budget;
    assert.doesNotThrow(() => {
      budget = assertWorkerPromptFitsCapacity({
        prompt: fixture.prompt,
        completeSystemPrompt: launch.systemPrompt,
        toolSchemas: launch.toolSchemas,
        contextWindow: launch.contextWindow,
        maxOutputTokens: launch.maxOutputTokens,
        modelId: `${launch.provider}/${launch.model}`,
        bindingSection: `${builder} reviewer prompt`,
      });
    }, `${builder} reviewer with old byte projection ${fixture.bytes} should now fit`);
    assert.equal(budget.measurementMethod, "pi-estimateTokens-with-fixed-host-allowances");
    assert.equal(budget.replyReserveTokens, 16_384);
    assert.equal(budget.marginPercent, 25);
    assert.equal(budget.framingAllowanceTokens, 4_096);
    assert.ok(budget.admissionInputTokens < fixture.bytes,
      "new estimate must be distinguished from the historical serialized-byte bound");
    console.log(`MEASURE ${builder} oldProjectionBytes=${fixture.bytes} estimatedAdmissionTokens=${budget.admissionInputTokens} reserve=${budget.replyReserveTokens}`);
  }

  let plannerLow = 0;
  let plannerHigh = 150_000;
  let plannerPrompt = "";
  let plannerBytes = 0;
  while (plannerLow <= plannerHigh) {
    const middle = Math.floor((plannerLow + plannerHigh) / 2);
    const plannerIntake = fixtureIntake(`${bindingBrief()}\n${denseCandidateText(middle)}`);
    const candidate = buildPlanningPrompt(plannerIntake, 0, []);
    const bytes = projectionBytes(launch, candidate);
    plannerPrompt = candidate;
    plannerBytes = bytes;
    if (bytes < 149_913) plannerLow = middle + 1;
    else if (bytes > 149_913) plannerHigh = middle - 1;
    else break;
  }
  assert.ok(Math.abs(plannerBytes - 149_913) < 256, `planner fixture should approximate observed old size, got ${plannerBytes}`);
  assert.doesNotThrow(() => assertWorkerPromptFitsCapacity({
    prompt: plannerPrompt,
    completeSystemPrompt: launch.systemPrompt,
    toolSchemas: launch.toolSchemas,
    contextWindow: launch.contextWindow,
    maxOutputTokens: launch.maxOutputTokens,
    modelId: `${launch.provider}/${launch.model}`,
    bindingSection: "planner prompt",
  }));
}

function expectedPolicy(input) {
  const system = estimateTokens({ role: "user", content: input.completeSystemPrompt, timestamp: 0 });
  const user = estimateTokens({ role: "user", content: input.prompt, timestamp: 0 });
  const toolsText = JSON.stringify(input.toolSchemas);
  const tools = estimateTokens({ role: "user", content: toolsText, timestamp: 0 });
  const base = system + user + tools;
  const margin = Math.ceil(base * 0.25);
  const admission = base + margin + 4096;
  const reserve = Math.min(input.maxOutputTokens, 16384);
  return { system, user, tools, base, margin, admission, reserve };
}

async function invariantsCase() {
  assert.equal(ADMISSION_ESTIMATE_MARGIN_PERCENT, 25);
  assert.equal(ADMISSION_FRAMING_ALLOWANCE_TOKENS, 4096);
  assert.equal(DEFAULT_REPLY_RESERVE_TOKENS, 16384);
  assert.equal(DEFAULT_REPLY_RESERVE_TOKENS, DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    "reply baseline must match Pi's documented/default compaction response reserve");

  const base = {
    prompt: "user-code: const π = '🙂';\n".repeat(53),
    completeSystemPrompt: "large-system-context\n".repeat(71),
    toolSchemas: [{ name: "fixture", description: "JSON-heavy tool", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    maxOutputTokens: 128_000,
    modelId: "misleading-provider/unknown-tiny-name",
    bindingSection: "invariant fixture",
  };
  const expected = expectedPolicy(base);
  const exactBoundary = assertWorkerPromptFitsCapacity({ ...base, contextWindow: expected.admission + expected.reserve });
  assert.equal(exactBoundary.admissionInputTokens, expected.admission);
  assert.equal(exactBoundary.usableBudgetTokens, 0);
  assert.deepEqual(exactBoundary.sections.map((section) => section.name), ["completeSystemPrompt", "userPrompt", "activeToolSchemas"]);
  assert.equal(exactBoundary.sections.reduce((sum, section) => sum + section.estimatedTokens, 0), expected.base);
  assert.equal(exactBoundary.replyReserveTokens, expected.reserve);
  assert.equal(exactBoundary.estimateMarginTokens, expected.margin);
  assert.match(exactBoundary.measurementCaveat, /estimate/i);
  assert.match(exactBoundary.measurementCaveat, /not an? exact/i);

  assert.throws(() => assertWorkerPromptFitsCapacity({
    ...base,
    contextWindow: expected.admission + expected.reserve - 1,
  }), (error) => {
    assert.match(error.message, /BINDING_PROMPT_CAPACITY_REFUSED/);
    assert.match(error.message, /invariant fixture/);
    assert.match(error.message, /estimated/i);
    assert.match(error.message, /completeSystemPrompt=.*userPrompt=.*activeToolSchemas=/);
    assert.match(error.message, /25% uncertainty margin/);
    assert.match(error.message, /4096 framing\/tool allowance/);
    assert.match(error.message, /16384 reply reserve/);
    assert.match(error.message, /No worker was spawned and no binding text was truncated/);
    return true;
  });

  const smallOutput = assertWorkerPromptFitsCapacity({ ...base, contextWindow: expected.admission + 512, maxOutputTokens: 512 });
  assert.equal(smallOutput.replyReserveTokens, 512, "reply reserve is bounded by model output capability");

  const specialLookingPrompt = "<|endoftext|><|im_start|>\nconst dense = {\"emoji\":\"🧪\",\"path\":\"C:\\\\fixture\"};\n".repeat(500);
  const specialSnapshot = specialLookingPrompt;
  const specialBudget = assertWorkerPromptFitsCapacity({
    ...base,
    prompt: specialLookingPrompt,
    contextWindow: 1_000_000,
  });
  assert.equal(specialLookingPrompt, specialSnapshot, "measurement must not alter special-token-looking input");
  assert.ok(specialBudget.sections.find((section) => section.name === "userPrompt").estimatedTokens > 0);

  assert.throws(() => assertWorkerPromptFitsCapacity({
    prompt: "small user prompt",
    completeSystemPrompt: denseCandidateText(150_000),
    toolSchemas: [],
    contextWindow: 20_000,
    maxOutputTokens: 1_000,
    modelId: "fixture/large-system",
    bindingSection: "complete system prompt",
  }), /BINDING_PROMPT_CAPACITY_REFUSED.*completeSystemPrompt=/s);

  const hugeTools = Array.from({ length: 500 }, (_, index) => ({
    name: `tool_${index}`,
    description: denseCandidateText(500),
    parameters: { type: "object", properties: { value: { type: "string", description: `field-${index}` } } },
  }));
  assert.throws(() => assertWorkerPromptFitsCapacity({
    prompt: "small user prompt",
    completeSystemPrompt: "small system prompt",
    toolSchemas: hugeTools,
    contextWindow: 20_000,
    maxOutputTokens: 1_000,
    modelId: "fixture/large-tools",
    bindingSection: "active tools",
  }), /BINDING_PROMPT_CAPACITY_REFUSED.*activeToolSchemas=/s);

  const circular = {};
  circular.self = circular;
  assert.throws(() => assertWorkerPromptFitsCapacity({
    ...base,
    contextWindow: 1_000_000,
    toolSchemas: circular,
  }), /BINDING_PROMPT_CAPACITY_UNRESOLVED.*tool schemas/i);
  assert.throws(() => assertWorkerPromptFitsCapacity({ ...base, contextWindow: 0 }), /CAPACITY_UNRESOLVED/);
  assert.throws(() => assertWorkerPromptFitsCapacity({ ...base, contextWindow: 100_000, maxOutputTokens: -1 }), /CAPACITY_UNRESOLVED/);

  const estimatorSource = fs.readFileSync(path.join(ROOT, "src", "executor-recovery", "budget-estimator.ts"), "utf8");
  assert.match(estimatorSource, /estimateTokens/);
  assert.doesNotMatch(estimatorSource, /charsPerToken|o200k|cl100k|encodingForModel|encoding_for_model/i,
    "policy must not make unsupported tokenizer/encoding mappings");
  const indexSource = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  const substrateSource = fs.readFileSync(path.join(ROOT, "src", "substrate.ts"), "utf8");
  assert.ok((indexSource.match(/assertWorkerPromptFitsCapacity\s*\(/g) || []).length >= 2,
    "legacy and executor Tier-0 admissions must use the shared policy");
  assert.ok((substrateSource.match(/assertWorkerPromptFitsCapacity\s*\(/g) || []).length >= 1,
    "substrate admission must use the shared policy");
}

function customModelsConfig(provider, models) {
  return JSON.stringify({
    providers: {
      [provider]: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "fixture",
        models,
      },
    },
  }, null, 2);
}

function customModel(id, contextWindow, maxTokens = 2_000) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow,
    maxTokens,
  };
}

function writeAgentFixture(agentDir, options) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(options.settings ?? {}, null, 2), "utf8");
  fs.writeFileSync(path.join(agentDir, "models.json"), options.modelsConfig ?? '{"providers":{}}\n', "utf8");
  if (options.instructions) fs.writeFileSync(path.join(agentDir, "AGENTS.md"), options.instructions, "utf8");
}

async function configRootCase() {
  const launcherAgentDir = path.join(TEMP_ROOT, "launcher-agent");
  const legacyAgentDir = path.join(TEMP_ROOT, "legacy-agent");
  const provider = "root-fixture";
  const model = "same-route";
  writeAgentFixture(launcherAgentDir, {
    modelsConfig: customModelsConfig(provider, [customModel(model, 20_000)]),
    instructions: "LAUNCHER_ROOT_INSTRUCTIONS_20000",
  });
  writeAgentFixture(legacyAgentDir, {
    modelsConfig: customModelsConfig(provider, [customModel(model, 272_000, 128_000)]),
    instructions: "LEGACY_ALIAS_INSTRUCTIONS_272000",
  });

  const previousCodingDir = process.env.PI_CODING_AGENT_DIR;
  const previousLegacyDir = process.env.PI_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = launcherAgentDir;
  process.env.PI_AGENT_DIR = legacyAgentDir;
  try {
    const launch = await resolveCompleteWorkerLaunchPrompt({
      cwd: WORKSPACE,
      profile: { name: "reviewer", provider, model, tools: ["read"] },
      appendedSystemPrompt: "conflicting root fixture",
    });
    assert.equal(launch.contextWindow, 20_000,
      "admission must use Pi getAgentDir()/PI_CODING_AGENT_DIR, exactly like the launcher");
    assert.match(launch.systemPrompt, /LAUNCHER_ROOT_INSTRUCTIONS_20000/,
      "admission must assemble instructions from the launcher's effective agent directory");
    assert.doesNotMatch(launch.systemPrompt, /LEGACY_ALIAS_INSTRUCTIONS_272000/);

    const targetAdmission = 44_786;
    let low = 0;
    let high = 200_000;
    let prompt = "";
    let policy;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = "x".repeat(middle);
      const measured = expectedPolicy({
        prompt: candidate,
        completeSystemPrompt: launch.systemPrompt,
        toolSchemas: launch.toolSchemas,
        maxOutputTokens: launch.maxOutputTokens,
      });
      prompt = candidate;
      policy = measured;
      if (measured.admission < targetAdmission) low = middle + 1;
      else if (measured.admission > targetAdmission) high = middle - 1;
      else break;
    }
    assert.equal(policy.admission, targetAdmission,
      "fixture reproduces the 44,786-token estimate accepted against the wrong 272k root");
    assert.throws(() => assertWorkerPromptFitsCapacity({
      prompt,
      completeSystemPrompt: launch.systemPrompt,
      toolSchemas: launch.toolSchemas,
      contextWindow: launch.contextWindow,
      maxOutputTokens: launch.maxOutputTokens,
      modelId: `${launch.provider}/${launch.model}`,
      bindingSection: "conflicting agent roots",
    }), /BINDING_PROMPT_CAPACITY_REFUSED/,
    "the real 20k launcher limit must refuse work that the wrong 272k root accepted");
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousCodingDir;
    process.env.PI_AGENT_DIR = previousLegacyDir;
  }
}

function competingFixtureConfig() {
  return customModelsConfig("fixture", [
    customModel("fixture/model", 272_000, 128_000),
    customModel("model", 30_000, 3_000),
    customModel("z-model", 20_000, 2_000),
  ]);
}

function installCompetingFixtureDefaults() {
  const modelsPath = path.join(AGENT_DIR, "models.json");
  const settingsPath = path.join(AGENT_DIR, "settings.json");
  const originals = {
    models: fs.readFileSync(modelsPath, "utf8"),
    settings: fs.readFileSync(settingsPath, "utf8"),
  };
  fs.writeFileSync(modelsPath, competingFixtureConfig(), "utf8");
  fs.writeFileSync(settingsPath, JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture/model",
  }, null, 2), "utf8");
  return () => {
    fs.writeFileSync(modelsPath, originals.models, "utf8");
    fs.writeFileSync(settingsPath, originals.settings, "utf8");
  };
}

async function upstreamDefaultRouteCase() {
  assert.equal(typeof loadAgents, "function", "production agent loading must be testable end-to-end");
  assert.equal(typeof resolveConfiguredRoleDefaults, "function", "production default routing must be testable end-to-end");
  const correctDir = path.join(TEMP_ROOT, "upstream-correct-agent");
  const wrongDir = path.join(TEMP_ROOT, "upstream-wrong-agent");
  writeAgentFixture(correctDir, {
    modelsConfig: competingFixtureConfig(),
    settings: { defaultProvider: "fixture", defaultModel: "fixture/model" },
  });
  writeAgentFixture(wrongDir, {
    modelsConfig: customModelsConfig("fixture", [customModel("wrong-default", 999_000)]),
    settings: { defaultProvider: "fixture", defaultModel: "wrong-default" },
  });

  const previousCodingDir = process.env.PI_CODING_AGENT_DIR;
  const previousLegacyDir = process.env.PI_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = correctDir;
  process.env.PI_AGENT_DIR = wrongDir;
  try {
    const agents = await loadAgents();
    const params = { plannerAgent: "planner", executorAgent: "coder", verifierAgent: "reviewer", cwd: WORKSPACE };
    resolveConfiguredRoleDefaults(params, agents);
    const profile = agents.get("planner");
    assert.equal(profile?.provider, "fixture");
    assert.equal(profile?.model, "fixture/model",
      "normal named-role defaults must come from Pi's effective configuration root");
    assert.equal(profile?.modelIsPiDefault, true,
      "normal route construction must retain saved-default provenance");

    const launch = await resolveCompleteWorkerLaunchPrompt({
      cwd: WORKSPACE,
      profile,
      appendedSystemPrompt: "normal upstream named-role fixture",
    });
    assert.equal(`${launch.provider}/${launch.model}`, "fixture/fixture/model");
    assert.equal(launch.contextWindow, 272_000,
      "saved slash-ID default must retain exact semantics through the actual named-role chain");
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousCodingDir;
    process.env.PI_AGENT_DIR = previousLegacyDir;
  }
}

async function savedDefaultExactCase() {
  const restore = installCompetingFixtureDefaults();
  try {
    const launch = await resolveCompleteWorkerLaunchPrompt({
      cwd: WORKSPACE,
      profile: { name: "executor", tools: ["read"] },
      appendedSystemPrompt: "saved exact default fixture",
    });
    assert.equal(`${launch.provider}/${launch.model}`, "fixture/fixture/model");
    assert.equal(launch.contextWindow, 272_000,
      "saved defaults must use Pi's exact getModel(provider, id) semantics, not fuzzy CLI parsing");
  } finally {
    restore();
  }
}

async function providerOnlyCase() {
  const restore = installCompetingFixtureDefaults();
  try {
    const launch = await resolveCompleteWorkerLaunchPrompt({
      cwd: WORKSPACE,
      profile: { name: "executor", provider: "fixture", tools: ["read"] },
      appendedSystemPrompt: "provider-only exact default fixture",
    });
    assert.equal(`${launch.provider}/${launch.model}`, "fixture/fixture/model");
    assert.equal(launch.contextWindow, 272_000,
      "provider-only profile must preserve an exact matching settings.defaultModel");
  } finally {
    restore();
  }
}

async function slashZModelRoundTripCase() {
  const modelsPath = path.join(AGENT_DIR, "models.json");
  const originalModels = fs.readFileSync(modelsPath, "utf8");
  fs.writeFileSync(modelsPath, customModelsConfig("fixture", [
    customModel("fixture/model", 272_000, 128_000),
    customModel("z-model", 20_000, 2_000),
  ]), "utf8");
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(AGENT_DIR, "auth.json"),
      modelsPath,
      modelsStorePath: path.join(AGENT_DIR, "models-store-slash-z.json"),
      allowModelNetwork: false,
    });
    const launch = await resolveCompleteWorkerLaunchPrompt({
      cwd: WORKSPACE,
      profile: { name: "executor", provider: "fixture", model: "fixture/fixture/model", tools: ["read"] },
      appendedSystemPrompt: "qualified slash ID versus z-model fixture",
    });
    const child = resolveCliModel({ cliProvider: launch.provider, cliModel: launch.modelArgument, modelRuntime: runtime });
    assert.deepEqual(
      [child.model?.id, child.model?.contextWindow, child.model?.maxTokens],
      ["fixture/model", 272_000, 128_000],
      "fixture/model admission must not emit child arguments that select competing z-model",
    );
  } finally {
    fs.writeFileSync(modelsPath, originalModels, "utf8");
  }
}

async function slashModelIdCase() {
  const restore = installCompetingFixtureDefaults();
  try {
    const modelsPath = path.join(AGENT_DIR, "models.json");
    const oracleRuntime = await ModelRuntime.create({
      authPath: path.join(AGENT_DIR, "auth.json"),
      modelsPath,
      modelsStorePath: path.join(AGENT_DIR, "models-store-slash-id.json"),
      allowModelNetwork: false,
    });
    const admittedOracle = resolveCliModel({
      cliProvider: "fixture",
      cliModel: "fixture/fixture/fixture/model",
      modelRuntime: oracleRuntime,
    });
    assert.equal(admittedOracle.error, undefined);
    assert.equal(admittedOracle.model?.id, "fixture/model");

    const launch = await resolveCompleteWorkerLaunchPrompt({
      cwd: WORKSPACE,
      profile: { name: "executor", provider: "fixture", model: "fixture/fixture/fixture/model", tools: ["read"] },
      appendedSystemPrompt: "canonical-reference collision fixture",
    });
    assert.equal(launch.provider, "fixture");
    assert.equal(launch.model, "fixture/model");
    assert.equal(launch.contextWindow, 272_000);
    assert.equal(launch.modelArgument, "fixture/fixture/fixture/model",
      "canonical construction must add only the qualification depth proven necessary by real CLI resolution");

    const childRoundTrip = resolveCliModel({
      cliProvider: launch.provider,
      cliModel: launch.modelArgument,
      modelRuntime: oracleRuntime,
    });
    assert.equal(childRoundTrip.error, undefined);
    assert.deepEqual({
      provider: childRoundTrip.model?.provider,
      model: childRoundTrip.model?.id,
      contextWindow: childRoundTrip.model?.contextWindow,
      maxTokens: childRoundTrip.model?.maxTokens,
    }, {
      provider: launch.provider,
      model: launch.model,
      contextWindow: launch.contextWindow,
      maxTokens: launch.maxOutputTokens,
    }, "final child --provider/--model arguments must round-trip to the admitted route and limits");

    const indexSource = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
    const substrateSource = fs.readFileSync(path.join(ROOT, "src", "substrate.ts"), "utf8");
    assert.match(indexSource, /args\.push\("--model", launchPrompt\.modelArgument\)/,
      "legacy launcher must consume the round-trip-proven canonical model argument");
    assert.match(substrateSource, /args\.push\("--model", launchPrompt\.modelArgument\)/,
      "substrate launcher must consume the round-trip-proven canonical model argument");
  } finally {
    restore();
  }
}

function legacyFixtureEnvironmentCase() {
  const pending = [path.join(ROOT, "tests")];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".cjs") && absolute !== __filename) files.push(absolute);
    }
  }
  const legacyUsers = files.filter((file) => fs.readFileSync(file, "utf8").includes("PI_AGENT_DIR"));
  assert.deepEqual(legacyUsers.map((file) => path.relative(ROOT, file)), [],
    "all existing CJS fixtures must use Pi's real PI_CODING_AGENT_DIR configuration root");

  const migrated = [
    "tests/test-2026-09-17-binding-capacity.cjs",
    "tests/test-2026-09-17-no-force-kill-real-child.cjs",
    "tests/test-2026-09-17-action-evidence.cjs",
    "tests/test-round3-defect-g.cjs",
    "tests/test-evidence-audit.cjs",
  ];
  for (const relative of migrated) {
    assert.match(fs.readFileSync(path.join(ROOT, relative), "utf8"), /PI_CODING_AGENT_DIR/,
      `${relative} must explicitly isolate the launcher configuration root`);
  }
}

function cachedModel(id, name) {
  return {
    id,
    name,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
    compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true },
  };
}

async function modelCatalogCase() {
  const modelsPath = path.join(AGENT_DIR, "models.json");
  const originalModelsConfig = fs.readFileSync(modelsPath, "utf8");
  const cacheOnlyId = "gpt-cache-only-item1-fixture";
  fs.writeFileSync(path.join(AGENT_DIR, "models-store.json"), JSON.stringify({
    "openai-codex": {
      models: [cachedModel("gpt-6-astra", "GPT-6 Astra"), cachedModel(cacheOnlyId, "Cache-only item 1 fixture")],
      checkedAt: Date.now(),
      lastModified: Date.now() + 86_400_000,
      etag: '"item1-fixture"',
    },
  }, null, 2), "utf8");

  const oracleRuntime = await ModelRuntime.create({
    authPath: path.join(AGENT_DIR, "auth.json"),
    modelsPath,
    modelsStorePath: path.join(AGENT_DIR, "models-store.json"),
    allowModelNetwork: false,
  });
  for (const id of ["gpt-6-astra", cacheOnlyId]) {
    const oracle = resolveCliModel({ cliProvider: "openai-codex", cliModel: id, modelRuntime: oracleRuntime });
    assert.equal(oracle.error, undefined, `launcher oracle should resolve ${id}: ${oracle.error}`);
    assert.ok(oracle.model, `launcher oracle should return ${id}`);

    const production = await resolveCompleteWorkerLaunchPrompt({
      cwd: WORKSPACE,
      profile: { name: "reviewer", provider: "openai-codex", model: id, tools: ["read"] },
      appendedSystemPrompt: "cache restoration fixture",
    });
    assert.deepEqual({
      provider: production.provider,
      id: production.model,
      api: production.api,
      contextWindow: production.contextWindow,
      maxTokens: production.maxOutputTokens,
      compat: production.compat,
    }, {
      provider: oracle.model.provider,
      id: oracle.model.id,
      api: oracle.model.api,
      contextWindow: oracle.model.contextWindow,
      maxTokens: oracle.model.maxTokens,
      compat: oracle.model.compat,
    }, `production resolution must equal CLI resolution for ${id}`);
  }

  const defaultSettings = JSON.stringify({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6-astra",
  }, null, 2);
  fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), defaultSettings, "utf8");
  const fromSettings = await resolveCompleteWorkerLaunchPrompt({
    cwd: WORKSPACE,
    profile: { name: "reviewer", tools: ["read"] },
    appendedSystemPrompt: "settings-derived default route fixture",
  });
  assert.equal(`${fromSettings.provider}/${fromSettings.model}`, "openai-codex/gpt-6-astra");
  assert.equal(fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf8"), defaultSettings,
    "settings-derived launcher resolution must not mutate fixture settings");
  fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), "{}\n", "utf8");

  const qualified = await resolveCompleteWorkerLaunchPrompt({
    cwd: WORKSPACE,
    profile: { name: "reviewer", model: "openai-codex/gpt-6-astra:high", tools: ["read"] },
    appendedSystemPrompt: "qualified CLI route fixture",
  });
  assert.equal(`${qualified.provider}/${qualified.model}`, "openai-codex/gpt-6-astra",
    "qualified --model syntax must use launcher-equivalent CLI parsing");
  assert.equal(qualified.modelArgument, "gpt-6-astra:high",
    "canonical child model argument must retain thinking while preserving bare-ID compatibility when round-trip safe");

  assert.equal(fs.readFileSync(modelsPath, "utf8"), originalModelsConfig,
    "Astra resolves without any custom models.json definition or mutation");
  assert.ok(!originalModelsConfig.includes("gpt-6-astra"));
  assert.equal(fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf8"), "{}\n");
  assert.equal(fs.existsSync(path.join(AGENT_DIR, "sessions")), false,
    "in-memory launch assembly must not create persisted sessions");
  assert.equal(fs.existsSync(path.join(WORKSPACE, ".pi")), false,
    "fixture settings/session state must not escape the isolated agent directory");

  const overrideConfig = JSON.stringify({
    providers: {
      "openai-codex": {
        modelOverrides: {
          "gpt-5.6-sol": { contextWindow: 200_000, maxTokens: 8_192 },
        },
      },
    },
  }, null, 2);
  fs.writeFileSync(modelsPath, overrideConfig, "utf8");
  const overridden = await resolveCompleteWorkerLaunchPrompt({
    cwd: WORKSPACE,
    profile: { name: "executor", provider: "openai-codex", model: "gpt-5.6-sol", tools: ["read"] },
    appendedSystemPrompt: "configured override fixture",
  });
  assert.equal(overridden.contextWindow, 200_000);
  assert.equal(overridden.maxOutputTokens, 8_192);
  assert.equal(fs.readFileSync(modelsPath, "utf8"), overrideConfig,
    "configured model overrides must be honored without configuration mutation");

  await assert.rejects(() => resolveCompleteWorkerLaunchPrompt({
    cwd: WORKSPACE,
    profile: { name: "reviewer", provider: "openai-codex", model: "gpt-6-astr", tools: ["read"] },
    appendedSystemPrompt: "fuzzy mismatch fixture",
  }), /BINDING_PROMPT_CAPACITY_UNRESOLVED.*different model route/,
  "an unavailable explicit route must not silently admit a fuzzy-selected model");

  await assert.rejects(() => resolveCompleteWorkerLaunchPrompt({
    cwd: WORKSPACE,
    profile: { name: "reviewer", provider: "missing-provider", model: "missing-model", tools: ["read"] },
    appendedSystemPrompt: "missing route fixture",
  }), /BINDING_PROMPT_CAPACITY_UNRESOLVED/);
}

const cases = {
  capacity: capacityCase,
  invariants: invariantsCase,
  "config-root": configRootCase,
  "upstream-default-route": upstreamDefaultRouteCase,
  "saved-default-exact": savedDefaultExactCase,
  "provider-only": providerOnlyCase,
  "slash-z-roundtrip": slashZModelRoundTripCase,
  "slash-model-id": slashModelIdCase,
  "legacy-fixture-env": legacyFixtureEnvironmentCase,
  "model-catalog": modelCatalogCase,
};

(async () => {
  const selected = process.argv.includes("--case")
    ? process.argv[process.argv.indexOf("--case") + 1]
    : undefined;
  const entries = selected ? [[selected, cases[selected]]] : Object.entries(cases);
  if (selected && !cases[selected]) throw new Error(`Unknown case ${selected}`);
  for (const [name, run] of entries) {
    await run();
    console.log(`PASS item1 ${name}`);
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
