#!/usr/bin/env node
/** Real isolated AgentSession worker for action-evidence integration coverage. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE = process.cwd();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const launcherArgs = process.argv.slice(2);
const extensionPaths = [];
for (let index = 0; index < launcherArgs.length; index += 1) {
  if (launcherArgs[index] === "--extension" && launcherArgs[index + 1]) extensionPaths.push(launcherArgs[index + 1]);
}
assert.ok(AGENT_DIR, "production launcher must pass PI_CODING_AGENT_DIR");
assert.ok(launcherArgs.includes("--mode") && launcherArgs.includes("json"),
  "fixture must be entered through the production JSON worker launcher");
assert.ok(launcherArgs.includes("--append-system-prompt"),
  "production launcher must supply its generated role prompt");
assert.ok(launcherArgs.includes("--no-extensions") && extensionPaths.length === 3,
  "production launcher must disable discovery and explicitly load its bootstrap, monitor and timeout guard");
assert.deepEqual(extensionPaths.map((entry) => path.basename(entry)), [
  "worker-monitor-bootstrap.ts", "worker-no-output-monitor.ts", "worker-execution-constraints.ts",
]);
assert.ok(launcherArgs.includes("--provider") && launcherArgs.includes("fixture"));
assert.ok(launcherArgs.includes("--model") && launcherArgs.includes("evidence-model"),
  "production launcher must preserve the bare model ID when real CLI round-trip proves it exact");

function readPrompt() {
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
  });
}

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

(async () => {
  const sdk = require(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
  const ai = require(path.join(ROOT, "node_modules", "@earendil-works", "pi-ai"));
  const settingsManager = sdk.SettingsManager.create(WORKSPACE, AGENT_DIR);
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(AGENT_DIR, "auth.json"),
    modelsPath: path.join(AGENT_DIR, "models.json"),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel("fixture", "evidence-model");
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: WORKSPACE,
    agentDir: AGENT_DIR,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: extensionPaths,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [],
    "the real no-force-kill guard must load cleanly before model/tool dispatch");
  const created = await sdk.createAgentSession({
    cwd: WORKSPACE,
    agentDir: AGENT_DIR,
    modelRuntime,
    model,
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(WORKSPACE),
    tools: ["bash", "edit"],
  });
  const session = created.session;
  session.agent.subscribe((event) => process.stdout.write(`${JSON.stringify(event)}\n`));

  const assertionCommand = "API_TOKEN=super-secret-value node assert-after.cjs";
  const faux = ai.createFauxCore({
    provider: "fixture",
    models: [{ id: "evidence-model", contextWindow: 8_000_000, maxTokens: 1_000 }],
  });
  faux.setResponses([
    ai.fauxAssistantMessage([
      ai.fauxToolCall("bash", { command: assertionCommand }, { id: "red-1" }),
    ], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([
      ai.fauxToolCall("edit", {
        path: "subject.txt",
        edits: [{ oldText: "before\n", newText: "after\n" }],
      }, { id: "edit-1" }),
    ], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([
      ai.fauxToolCall("bash", { command: assertionCommand }, { id: "green-1" }),
    ], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("All tests passed on the first try; no failed command occurred.", { stopReason: "stop" }),
  ]);
  session.agent.streamFunction = faux.streamSimple;

  try {
    const prompt = await readPrompt();
    assert.equal(prompt, "Run the real assertion, edit subject.txt, then rerun the same assertion.");
    await session.prompt(prompt);
    assert.equal(fs.readFileSync(path.join(WORKSPACE, "subject.txt"), "utf8"), "after\n");
    assert.equal(faux.state.callCount, 4);
  } finally {
    session.dispose();
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
