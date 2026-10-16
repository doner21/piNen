#!/usr/bin/env node
/** Safe regression: binding text and configured capacity without durable run state. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orc-binding-capacity-"));
const workspace = path.join(runtime, "workspace");
const agentDir = path.join(runtime, "agent");
const previousRoots = Object.fromEntries([
  "PI_ORCHESTRATOR_RUNS_ROOT", "PI_ORCHESTRATOR_NEXT_RUNS_ROOT",
  "PI_ORCHESTRATOR_TEST_RUNS_OWNER", "PI_CODING_AGENT_DIR",
].map(key => [key, process.env[key]]));
process.env.PI_ORCHESTRATOR_RUNS_ROOT = path.join(runtime, "legacy");
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = path.join(runtime, "next");
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = runtime;
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const directory of [workspace, agentDir, process.env.PI_ORCHESTRATOR_RUNS_ROOT, process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT]) {
  fs.mkdirSync(directory);
}
function restoreRoots() {
  for (const [key, value] of Object.entries(previousRoots)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
(async () => {
  try {
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
} = jiti(path.join(ROOT, "src", "index.ts"));
const { resolveCompleteWorkerLaunchPrompt } = jiti(path.join(ROOT, "src", "substrate.ts"));
const { assertWorkerPromptFitsCapacity } = jiti(path.join(ROOT, "src", "executor-recovery", "budget-estimator.ts"));

function fixtureIntake(originalTask) {
  return {
    originalTask,
    taskSummary: "binding fixture",
    taskType: "implementation",
    userIntent: "preserve owner text",
    goalAttractor: "all role prompts retain the marker",
    taskScope: "fixture only",
    constraints: ["Every sentence is binding."],
    invariants: [],
    successCriteria: ["BINDING_LIMIT_BEYOND_OLD_CUTOFF reaches every role."],
    deliverables: ["out.txt"],
    failureCriteria: [],
    nonGoals: [],
    ambiguities: [],
    routingDecision: "fixture",
    routingRequirements: [],
    orchestrationControls: {},
    inferredAdvisoryCriteria: [],
    criteriaProvenance: [],
    ownerCriteria: {
      success: ["BINDING_LIMIT_BEYOND_OLD_CUTOFF reaches every role."],
      failure: [],
    },
    supervisorAddedConstraints: [],
    plannerInferredPresentationRules: [],
  };
}

  assert.equal(typeof buildPlanningPrompt, "function");
  assert.equal(typeof buildExecutorPrompt, "function");
  const indexSource = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  assert.doesNotMatch(indexSource, /estimateExecutorContextBudget\s*\(/,
    "executor admission must not use the historical chars-per-token/model-name guess");
  assert.doesNotMatch(indexSource, /computeAdaptiveTaskSizeCap\s*\(/,
    "classic and visible-main planning must not split from guessed model-name capacity");

  const originalTask = [
    "CREATE out.txt with fixture content. Every sentence in this task is binding owner instruction.",
    "x".repeat(12_000),
    "BINDING_LIMIT_BEYOND_OLD_CUTOFF must reach planner, executor, and verifier intact.",
  ].join("\n");
  const intake = fixtureIntake(originalTask);
  const plan = {
    tasks: [{ id: "task-1", description: "Create out.txt.", dependsOn: [], expectsFileChange: true }],
    notes: "fixture",
  };
  const output = {
    taskId: "task-1", description: "Create out.txt.", agentName: "coder",
    output: "fixture", exitCode: 0, durationMs: 1,
  };
  const prompts = {
    planner: buildPlanningPrompt(intake, 0, []),
    executor: buildExecutorPrompt(intake, plan, plan.tasks[0]),
    classicVerifier: buildVerificationPrompt(intake, plan, [output], "fixture route"),
    visibleVerifier: buildVisibleMainVerificationPrompt(intake, {
      originalTask,
      acceptanceCriteria: [{ id: "AC-01", text: "BINDING_LIMIT_BEYOND_OLD_CUTOFF reaches every role.", required: true }],
    }, plan, [output]),
  };
  for (const [role, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /BINDING_LIMIT_BEYOND_OLD_CUTOFF/, `${role} prompt lost the late binding marker`);
    assert.match(prompt, /BINDING OWNER INSTRUCTIONS/);
  }

  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture",
        models: [
          { id: "gpt-4-32k", name: "Configured wide misleading id", reasoning: false, input: ["text"], contextWindow: 8_000_000, maxTokens: 1_000 },
          { id: "unknown-tiny-model", name: "Configured tiny model", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 },
        ],
      },
    },
  }), "utf8");
    const wide = await resolveCompleteWorkerLaunchPrompt({
      cwd: workspace,
      profile: { name: "planner", provider: "fixture", model: "gpt-4-32k", tools: ["read"] },
      appendedSystemPrompt: "binding fixture role",
    });
    assert.equal(wide.contextWindow, 8_000_000,
      "configured contextWindow must override the misleading model id");
    assert.doesNotThrow(() => assertWorkerPromptFitsCapacity({
      prompt: `CREATE out.txt. ${"z".repeat(100_000)} BINDING_END`,
      completeSystemPrompt: wide.systemPrompt,
      toolSchemas: wide.toolSchemas,
      contextWindow: wide.contextWindow,
      maxOutputTokens: wide.maxOutputTokens,
      modelId: `${wide.provider}/${wide.model}`,
    }));

    fs.writeFileSync(path.join(workspace, "AGENTS.md"), `fixture complete-system overhead\n${"h".repeat(180_000)}`, "utf8");
    const tiny = await resolveCompleteWorkerLaunchPrompt({
      cwd: workspace,
      profile: { name: "planner", provider: "fixture", model: "unknown-tiny-model", tools: ["read"] },
      appendedSystemPrompt: "binding fixture role",
    });
    assert.throws(() => assertWorkerPromptFitsCapacity({
      prompt: "CREATE out.txt with fixture content and verify it.",
      completeSystemPrompt: tiny.systemPrompt,
      toolSchemas: tiny.toolSchemas,
      contextWindow: tiny.contextWindow,
      maxOutputTokens: tiny.maxOutputTokens,
      modelId: `${tiny.provider}/${tiny.model}`,
    }), /BINDING_PROMPT_CAPACITY_REFUSED|binding.*(?:capacity|fit)/i,
    "complete Pi prompt and tool-schema overhead must be refused before worker spawn");

    console.log("PASS binding-capacity: pure production prompt seams preserve late binding text and in-memory launch sizing uses configured capacity plus complete prompt overhead without runs-state");
  } finally {
    restoreRoots();
    fs.rmSync(runtime, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
