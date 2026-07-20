#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function loadTool() {
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
  const mod = jiti(path.join(PROJECT_ROOT, "src", "index.ts"));
  let tool;
  (mod.default ?? mod)({ registerTool(def) { if (def.name === "orchestrate") tool = def; }, registerCommand() {} });
  assert.ok(tool);
  return tool;
}

async function run(extra, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-bounds-"));
  const agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-sol",
  }));
  const log = path.join(tmp, "calls.jsonl");
  const updates = [];
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = log;
  process.env.PI_AGENT_DIR = agentDir;
  process.env.ORCHESTRATE_PREFLIGHT_TIMEOUT_MS = String(options.pingMs ?? 180);
  process.env.ORCHESTRATE_PREFLIGHT_TOTAL_TIMEOUT_MS = String(options.totalMs ?? 700);
  const controller = options.abortAfterMs ? new AbortController() : undefined;
  const abortTimer = options.abortAfterMs ? setTimeout(() => controller.abort(), options.abortAfterMs) : undefined;
  const started = Date.now();
  try {
    const result = await loadTool().execute(
      "preflight-test",
      {
        task: "Analyze the fixture and return a concise result.",
        paradigm: "plan-execute-verify",
        hardGates: "off",
        maxRetries: 0,
        maxSubagents: 8,
        cwd: tmp,
        ...extra,
      },
      controller?.signal,
      (update) => updates.push(update.content?.map((part) => part.text).filter(Boolean).join("\n") ?? ""),
      // Deliberate conversational decoy: named roles must not inherit it.
      { cwd: tmp, model: { provider: "conversation-provider", id: "conversation-model" } },
    );
    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    return { result, calls, updates: updates.join("\n"), durationMs: Date.now() - started };
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    for (const key of ["PI_CLI_PATH", "FAKE_PI_LOG", "PI_AGENT_DIR", "ORCHESTRATE_PREFLIGHT_TIMEOUT_MS", "ORCHESTRATE_PREFLIGHT_TOTAL_TIMEOUT_MS"]) delete process.env[key];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testConfiguredDefaultsAndExplicitVerifier() {
  const { calls, updates } = await run({ verifierProvider: "zai", verifierModel: "glm-5.2" });
  assert.match(updates, /Selected routes before preflight: planner=openai-codex\/gpt-5\.6-sol, executor=openai-codex\/gpt-5\.6-sol, verifier=zai\/glm-5\.2/);
  const planner = calls.find((call) => call.agentName === "planner");
  const executor = calls.find((call) => call.agentName === "coder");
  const verifier = calls.find((call) => call.agentName === "reviewer");
  assert.deepEqual([planner.provider, planner.model], ["openai-codex", "gpt-5.6-sol"]);
  assert.deepEqual([executor.provider, executor.model], ["openai-codex", "gpt-5.6-sol"]);
  assert.deepEqual([verifier.provider, verifier.model], ["zai", "glm-5.2"]);
  assert.ok(!calls.some((call) => call.provider === "conversation-provider" || call.model === "conversation-model"));
}

async function testHangingPrimaryFallsBack() {
  const { calls, updates, durationMs } = await run({
    plannerProvider: "hangprov", plannerModel: "hang-model",
    plannerFallbackProvider: "openai-codex", plannerFallbackModel: "gpt-5.6-sol",
  });
  assert.ok(durationMs < 1500, `fallback run took ${durationMs}ms`);
  assert.match(updates, /type=timeout/);
  assert.match(updates, /planner re-routed to fallback 1 openai-codex\/gpt-5\.6-sol/);
  assert.ok(calls.some((call) => call.preflightFixture === "hang"));
  const planner = calls.find((call) => call.agentName === "planner");
  assert.deepEqual([planner.provider, planner.model], ["openai-codex", "gpt-5.6-sol"]);
}

async function testFailingProviderAndFallbackTerminalFail() {
  const { result, calls, updates } = await run({
    plannerProvider: "badprov", plannerModel: "bad-primary",
    plannerFallbackProvider: "badprov", plannerFallbackModel: "bad-fallback",
  });
  assert.equal(result.details.status, "fail");
  assert.equal(result.details.aborted, true);
  assert.match(updates, /Orchestration aborted — emitting partial report/);
  assert.ok(calls.filter((call) => call.preflightFixture === "fail").length >= 2, "primary and fallback must both be attempted");
  assert.ok(!calls.some((call) => call.agentName === "planner"), "no work subagent may spawn after terminal preflight failure");
}

async function testTotalFallbackBudget() {
  const { result, durationMs, updates } = await run({
    plannerProvider: "hangprov", plannerModel: "primary",
    plannerFallbackProvider: "hangprov,hangprov", plannerFallbackModel: "fallback-1,fallback-2",
  }, { pingMs: 180, totalMs: 320 });
  assert.equal(result.details.status, "fail");
  assert.ok(durationMs < 1000, `total preflight budget was not enforced: ${durationMs}ms`);
  assert.match(`${updates}\n${result.content[0].text}`, /PREFLIGHT TOTAL TIMEOUT|type=timeout/i);
}

async function testAbortIsTerminal() {
  const { result, durationMs, updates } = await run({
    plannerProvider: "hangprov", plannerModel: "abort-me",
  }, { pingMs: 500, totalMs: 900, abortAfterMs: 70 });
  assert.equal(result.details.status, "fail");
  assert.equal(result.details.aborted, true);
  assert.ok(durationMs < 700, `abort did not terminate promptly: ${durationMs}ms`);
  assert.match(updates, /PREFLIGHT ABORTED|type=aborted/i);
}

(async () => {
  await testConfiguredDefaultsAndExplicitVerifier();
  await testHangingPrimaryFallsBack();
  await testFailingProviderAndFallbackTerminalFail();
  await testTotalFallbackBudget();
  await testAbortIsTerminal();
  console.log("PASS preflight-bounds-routes: configured role defaults, explicit ZAI verifier, timeout, abort, fallback, and total bound");
})().catch((error) => { console.error("test-preflight-bounds-routes: FAIL"); console.error(error); process.exit(1); });
