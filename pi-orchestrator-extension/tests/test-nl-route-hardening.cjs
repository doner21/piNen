#!/usr/bin/env node
/**
 * Item D regression test — natural-language route parser hardening.
 * ================================================================
 * The NL controls used to scrape ordinary task prose and route a role from it:
 * "…the same semantics dual-plan uses today" set the planner route to
 * anthropic/today (a nonexistent model), 404-aborting the run
 * (bug 2026-07-02-natural-language-route-parser-hijacks-roles-from-task-prose.md,
 * run orc-mr43a2em-dvzs). This test proves:
 *  (1) prose decoys ("uses today", "runs tomorrow") cause NO route change;
 *  (2) explicit params always win over prose decoys;
 *  (3) legitimate NL routing ("use GPT 5.5 for the planner") still works.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
function makeJiti() { return createJiti(__filename, { interopDefault: true, moduleCache: false }); }

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({ registerTool(def) { if (def.name === "orchestrate") tool = def; }, registerCommand() {} });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

async function runPev(params) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nl-hardening-"));
  const logPath = path.join(tmp, "log.jsonl");
  const agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture-default-provider",
    defaultModel: "fixture-default-model",
  }));
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.PI_AGENT_DIR = agentDir;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-nl-hardening",
      { paradigm: "plan-execute-verify", preflight: false, hardGates: "off", maxRetries: 0, maxSubagents: 8, cwd: tmp, ...params },
      undefined, () => {}, { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { result, calls };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.PI_AGENT_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const DECOY_TASK =
  "Harden the parser to keep the same semantics dual-plan uses today, and make sure it still runs tomorrow.";

async function testProseDecoyDoesNotRoute() {
  const { calls } = await runPev({ task: DECOY_TASK });
  const planner = calls.find((c) => c.agentName === "planner");
  assert.ok(planner, "planner must spawn");
  // Prose "uses today" / "runs tomorrow" must NOT become a route.
  assert.equal(planner.provider, "fixture-default-provider", "prose must not replace configured planner provider");
  assert.equal(planner.model, "fixture-default-model", "prose must not replace configured planner model");
  // Absolutely no call anywhere may be routed to the decoy tokens.
  for (const c of calls) {
    assert.notEqual(c.model, "today", "no role may be routed to 'today'");
    assert.notEqual(c.model, "tomorrow", "no role may be routed to 'tomorrow'");
  }
}

async function testExplicitParamsWinOverDecoys() {
  const { calls } = await runPev({
    task: DECOY_TASK,
    plannerProvider: "anthropic", plannerModel: "claude-opus-4-8",
  });
  const planner = calls.find((c) => c.agentName === "planner");
  assert.ok(planner, "planner must spawn");
  assert.equal(planner.provider, "anthropic", "explicit plannerProvider must win over prose");
  assert.equal(planner.model, "claude-opus-4-8", "explicit plannerModel must win over prose");
}

// A prose clause that DOES resolve to a known alias for the executor role.
// With the pre-fix bug, buildRoutingRequirements re-ran NL inference and could
// recombine this NL model with an explicit provider-only override, yielding a
// false routing requirement (executor=anthropic/gpt-5.5) that never matched the
// real spawn. The suppression must drop the NL executor route entirely once ANY
// explicit executor param is present.
const KNOWN_EXECUTOR_DECOY_TASK =
  "Use GPT 5.5 for execution. Then implement a tiny fix in the executor phase.";

async function testProviderOnlyExplicitSuppressesNlModel() {
  const { calls, result } = await runPev({
    task: KNOWN_EXECUTOR_DECOY_TASK,
    executorProvider: "anthropic",
  });
  const executor = calls.find((c) => c.agentName === "coder");
  assert.ok(executor, "executor (coder) must spawn");
  assert.equal(executor.provider, "anthropic", "explicit executorProvider must win");
  assert.notEqual(executor.model, "gpt-5.5", "suppressed NL model must not recombine with explicit provider");
  for (const c of calls) {
    assert.notEqual(c.model, "gpt-5.5", "no role may be routed to the suppressed NL decoy model");
  }
  const markdown = typeof result === "string" ? result : JSON.stringify(result);
  assert.ok(
    !/routing check failed[\s\S]*gpt-5\.5/i.test(markdown),
    "routing requirement must not be a recombined anthropic/gpt-5.5",
  );
}

async function testModelOnlyExplicitSuppressesNlProvider() {
  const { calls } = await runPev({
    task: KNOWN_EXECUTOR_DECOY_TASK,
    executorModel: "claude-opus-4-8",
  });
  const executor = calls.find((c) => c.agentName === "coder");
  assert.ok(executor, "executor (coder) must spawn");
  assert.equal(executor.model, "claude-opus-4-8", "explicit executorModel must win");
  assert.notEqual(executor.provider, "openai-codex", "suppressed NL provider must not recombine with explicit model");
  for (const c of calls) {
    assert.notEqual(c.model, "gpt-5.5", "no role may be routed to the suppressed NL decoy model");
  }
}

// ── Residual 1 (run orc-mr43c3tz-uqzv): the STRUCTURED NL forms.────────────────
// Two structured branches in parseModelCandidate used to route WITHOUT known-model
// validation:
//   Decoy A — worded  "provider <P> model <T>"  (providerModel regex, greedy tail);
//   Decoy B — slash    "<P>/<T>"                 (slash branch);
//   Decoy C — greedy   "<T> produces NO route change …" captured as the model token.
// <P> = the opus/sonnet-named first-party provider; <T> = the word for the current
// day. Decoy strings are built here by concatenation so no routing-like phrase
// appears as a literal in orchestrate task prose.
const DECOY_P = "anthropic";
const DECOY_T = "today";

// (a) Decoy A — worded "provider <P> model <T>" form must NOT route any role.
async function testStructuredWordedDecoyDoesNotRoute() {
  const task =
    "The planner should use provider " + DECOY_P + " model " + DECOY_T +
    ". Then do a tiny task.";
  const { calls } = await runPev({ task });
  const planner = calls.find((c) => c.agentName === "planner");
  assert.ok(planner, "planner must spawn");
  assert.equal(planner.provider, "fixture-default-provider", "worded decoy must not replace configured planner provider");
  assert.equal(planner.model, "fixture-default-model", "worded decoy must not replace configured planner model");
  for (const c of calls) {
    assert.notEqual(c.model, DECOY_T, "no role may be routed to the day-word token");
    assert.notEqual(c.provider, DECOY_P, "prose-derived provider must not become a route");
  }
}

// (b) Decoy B — slash "<P>/<T>" form must NOT route any role.
async function testStructuredSlashDecoyDoesNotRoute() {
  const task =
    "The planner should use " + DECOY_P + "/" + DECOY_T + ". Then do a tiny task.";
  const { calls } = await runPev({ task });
  const planner = calls.find((c) => c.agentName === "planner");
  assert.ok(planner, "planner must spawn");
  assert.equal(planner.provider, "fixture-default-provider", "slash decoy must not replace configured planner provider");
  assert.equal(planner.model, "fixture-default-model", "slash decoy must not replace configured planner model");
  for (const c of calls) {
    assert.notEqual(c.model, DECOY_T, "no role may be routed to the slash model token");
    assert.notEqual(c.model, DECOY_P + "/" + DECOY_T, "no role may be routed to the joined slash token");
    assert.notEqual(c.provider, DECOY_P, "slash-derived provider must not become a route");
  }
}

// (e) Decoy C — greedy multi-word unknown token "<T> produces NO route change …".
// The unbounded (.+)$ capture used to swallow trailing prose into the model token.
async function testGreedyMultiWordDecoyDoesNotRoute() {
  const greedyTail = DECOY_T + " produces NO route change and keeps running";
  const task =
    "The planner should use provider " + DECOY_P + " model " + greedyTail + ".";
  const { calls } = await runPev({ task });
  const planner = calls.find((c) => c.agentName === "planner");
  assert.ok(planner, "planner must spawn");
  assert.equal(planner.provider, "fixture-default-provider", "greedy decoy must not replace configured planner provider");
  assert.equal(planner.model, "fixture-default-model", "greedy decoy must not replace configured planner model");
  for (const c of calls) {
    assert.notEqual(c.model, greedyTail, "no role may be routed to the greedy multi-word token");
    assert.notEqual(c.model, DECOY_T, "no role may be routed to the day-word token");
    assert.ok(
      !(typeof c.model === "string" && /produces NO route change/i.test(c.model)),
      "no role may be routed to a token containing trailing prose",
    );
  }
}

// (d) explicit params win over structured prose decoys — planner spawns with the
// explicit values and no role is routed to the decoy token.
async function testExplicitParamsWinOverStructuredDecoys() {
  const task =
    "The planner should use provider " + DECOY_P + " model " + DECOY_T +
    ". Then do a tiny task.";
  const { calls } = await runPev({
    task,
    plannerProvider: "anthropic", plannerModel: "claude-opus-4-8",
  });
  const planner = calls.find((c) => c.agentName === "planner");
  assert.ok(planner, "planner must spawn");
  assert.equal(planner.provider, "anthropic", "explicit plannerProvider must win over structured prose");
  assert.equal(planner.model, "claude-opus-4-8", "explicit plannerModel must win over structured prose");
  for (const c of calls) {
    assert.notEqual(c.model, DECOY_T, "no role may be routed to the structured decoy token");
  }
}

async function testLegitimateNlRoutingStillWorks() {
  const { calls } = await runPev({ task: "Use GPT 5.5 for the planner. Then implement a tiny fix." });
  const planner = calls.find((c) => c.agentName === "planner");
  assert.ok(planner, "planner must spawn");
  assert.equal(planner.provider, "openai-codex", "known NL alias must still route the planner provider");
  assert.equal(planner.model, "gpt-5.5", "known NL alias must still route the planner model");
}

async function run() {
  await testProseDecoyDoesNotRoute();
  await testExplicitParamsWinOverDecoys();
  await testStructuredWordedDecoyDoesNotRoute();
  await testStructuredSlashDecoyDoesNotRoute();
  await testGreedyMultiWordDecoyDoesNotRoute();
  await testExplicitParamsWinOverStructuredDecoys();
  await testProviderOnlyExplicitSuppressesNlModel();
  await testModelOnlyExplicitSuppressesNlProvider();
  await testLegitimateNlRoutingStillWorks();
  console.log("PASS nl-route-hardening: prose + structured (worded/slash/greedy) decoys never route, explicit params win (incl. provider-only/model-only), known aliases still route");
}

run().catch((error) => { console.error("test-nl-route-hardening: FAIL"); console.error(error); process.exit(1); });
