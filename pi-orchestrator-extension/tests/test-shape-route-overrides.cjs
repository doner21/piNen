#!/usr/bin/env node
/**
 * Item B regression tests — shared route helper + per-shape override honoring.
 * ===========================================================================
 * Proves that for every audited shape (multi-verify-vote, verify-only,
 * venue-rescue-synthesis, composable-pipeline) passing executor/verifier
 * (and planner) route overrides changes BOTH the actual spawn routing (via the
 * fake-pi call log) AND the report `Routes:` line — closing the silent-route-
 * override bug class through the shared helper (src/routes.ts). Also proves the
 * shared helper's semantics are identical to dual-plan's prior production
 * behavior (parity truth table).
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

async function runShape(paradigm, extraParams) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-route-override-"));
  const logPath = path.join(tmp, "log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      `test-${paradigm}`,
      { paradigm, preflight: false, cwd: tmp, maxSubagents: 12, ...extraParams },
      undefined, () => {}, { cwd: tmp },
    );
    const calls = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const markdown = result.content?.[0]?.text || result.markdown || "";
    return { result, calls, markdown };
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const NEUTRAL_TASK = "Apply a tiny scoped fix and confirm it.";

async function testMultiVerifyVote() {
  const { calls, markdown } = await runShape("multi-verify-vote", {
    task: NEUTRAL_TASK,
    executorProvider: "exprov", executorModel: "exmodel",
    verifierProvider: "vprov", verifierModel: "vmodel",
  });
  const coder = calls.find((c) => c.agentName === "coder");
  assert.ok(coder, "multi-verify-vote must spawn a coder (executor)");
  assert.equal(coder.provider, "exprov", "executor spawn must honor executorProvider override");
  assert.equal(coder.model, "exmodel", "executor spawn must honor executorModel override");
  const reviewer = calls.find((c) => c.agentName === "reviewer");
  assert.ok(reviewer, "multi-verify-vote must spawn a reviewer (verifier)");
  assert.equal(reviewer.provider, "vprov", "verifier spawn must honor verifierProvider override");
  assert.equal(reviewer.model, "vmodel", "verifier spawn must honor verifierModel override");
  assert.match(markdown, /\*\*Routes:\*\*/, "report must include a Routes line");
  assert.match(markdown, /Executor=exprov\/exmodel/, "Routes line must reflect executor override");
  assert.match(markdown, /Verifier=vprov\/vmodel/, "Routes line must reflect verifier override");
}

async function testVerifyOnly() {
  const { calls, markdown } = await runShape("verify-only", {
    task: "Evidence checklist: check-1 confirm foo; check-2 confirm bar.",
    verifierProvider: "vprov", verifierModel: "vmodel",
  });
  const reviewer = calls.find((c) => c.agentName === "reviewer");
  assert.ok(reviewer, "verify-only must spawn a reviewer (verifier)");
  assert.equal(reviewer.provider, "vprov", "verifier spawn must honor verifierProvider override");
  assert.equal(reviewer.model, "vmodel", "verifier spawn must honor verifierModel override");
  assert.ok(!calls.some((c) => c.agentName === "coder" || c.agentName === "planner"),
    "verify-only must not spawn planner/executor");
  assert.match(markdown, /\*\*Routes:\*\* Verifier=vprov\/vmodel/, "Routes line must reflect verifier override");
}

async function testVenueRescueSynthesis() {
  const { calls, markdown } = await runShape("venue-rescue-synthesis", {
    task: "Rescue plan for a struggling venue using the provided accounts.",
    verifierProvider: "vprov", verifierModel: "vmodel",
  });
  const verifier = calls.find((c) => c.agentName === "bham-verifier");
  assert.ok(verifier, "venue-rescue must spawn the bham-verifier (role: verifier)");
  assert.equal(verifier.provider, "vprov", "verifier-role spawn must honor verifierProvider override");
  assert.equal(verifier.model, "vmodel", "verifier-role spawn must honor verifierModel override");
  // Role-scoping: the verifier override must NOT leak to non-verifier phases.
  const nonVerifierLeak = calls.some((c) => c.agentName !== "bham-verifier" && (c.provider === "vprov" || c.model === "vmodel"));
  assert.ok(!nonVerifierLeak, "verifier override must not hijack non-verifier phases");
  assert.match(markdown, /\*\*Routes:\*\* Verifier=vprov\/vmodel/, "Routes line must reflect verifier override");
}

async function testComposablePipeline() {
  const { calls, markdown } = await runShape("composable-pipeline", {
    task: "Plan, execute, and verify a tiny scoped fix.",
    plannerProvider: "openai-codex", plannerModel: "gpt-5.6-sol",
    executorProvider: "openai-codex", executorModel: "gpt-5.6-sol",
    verifierProvider: "openai-codex", verifierModel: "gpt-5.5",
  });
  const coder = calls.find((c) => c.agentName === "coder");
  assert.ok(coder, "composable-pipeline must spawn a coder (executor)");
  assert.equal(coder.provider, "openai-codex", "executor spawn must honor executorProvider override");
  assert.equal(coder.model, "gpt-5.6-sol", "executor spawn must honor executorModel override");
  const reviewer = calls.find((c) => c.agentName === "reviewer");
  assert.ok(reviewer, "composable-pipeline must spawn a reviewer (verifier)");
  assert.equal(reviewer.provider, "openai-codex", "verifier spawn must honor verifierProvider override");
  assert.equal(reviewer.model, "gpt-5.5", "verifier spawn must honor verifierModel override");
  assert.match(markdown, /Executor=openai-codex\/gpt-5\.6-sol/, "Routes line must reflect executor override");
  assert.match(markdown, /Verifier=openai-codex\/gpt-5\.5/, "Routes line must reflect verifier override");
}

function testSharedHelperParity() {
  const routes = makeJiti()(path.join(PROJECT_ROOT, "src", "routes.ts"));
  const { resolveRouteWithFallback, resolveRouteOverride, formatRouteLabel } = routes;
  const fallback = { provider: "deepseek", model: "deepseek-v4-pro" };
  // Byte-identical truth table to dual-plan's original resolveRoutes semantics:
  // (model || provider) ? { provider: provider ?? fb.provider, model: model ?? fb.model } : fb
  assert.deepEqual(resolveRouteWithFallback(undefined, undefined, fallback), fallback,
    "no override → full fallback constant");
  assert.deepEqual(resolveRouteWithFallback("m", undefined, fallback), { provider: "deepseek", model: "m" },
    "model-only override fills provider from fallback");
  assert.deepEqual(resolveRouteWithFallback(undefined, "p", fallback), { provider: "p", model: "deepseek-v4-pro" },
    "provider-only override fills model from fallback");
  assert.deepEqual(resolveRouteWithFallback("m", "p", fallback), { provider: "p", model: "m" },
    "both overrides win");
  // resolveRouteOverride (no-default shapes) mirrors the long-used toModelOverride.
  assert.equal(resolveRouteOverride(undefined, undefined), undefined, "no override → inherit (undefined)");
  assert.deepEqual(resolveRouteOverride("m", "p"), { model: "m", provider: "p" }, "override object returned");
  assert.equal(formatRouteLabel(undefined), "inherited (session default)", "undefined route → inherited label");
  assert.equal(formatRouteLabel({ provider: "p", model: "m" }), "p/m", "resolved route → provider/model label");
}

function testDualPlanUsesSharedHelper() {
  const dual = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "dual-plan-synthesis-execute-verify.ts"), "utf8");
  assert.match(dual, /from "\.\.\/routes"/, "dual-plan must import the shared route helper");
  assert.match(dual, /resolveRouteWithFallback/, "dual-plan must delegate to the shared helper");
  assert.match(dual, /function resolveRoutes/, "dual-plan must retain the resolveRoutes wrapper name");
}

async function run() {
  await testMultiVerifyVote();
  await testVerifyOnly();
  await testVenueRescueSynthesis();
  await testComposablePipeline();
  testSharedHelperParity();
  testDualPlanUsesSharedHelper();
  console.log("PASS shape-route-overrides: multi-verify-vote, verify-only, venue-rescue-synthesis, composable-pipeline honor overrides in spawns + Routes line; shared helper parity");
}

run().catch((error) => { console.error("test-shape-route-overrides: FAIL"); console.error(error); process.exit(1); });
