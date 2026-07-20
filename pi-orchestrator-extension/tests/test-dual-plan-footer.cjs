#!/usr/bin/env node
/**
 * Item C regression test — dual-plan "Orchestration Used" footer.
 * ==============================================================
 * The closing narrative previously hardcoded "a DeepSeek executor" / "an Opus
 * synthesis reviewer" / "a GPT verifier" regardless of resolved routes
 * (bug 2026-07-02-dual-plan-report-footer-hardcodes-deepseek-executor-narrative.md).
 * This test drives a NON-DEFAULT executor route override through fake-pi and
 * asserts the footer contains no provider/model name contradicting the
 * resolved routes.
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

function orchestrationUsedSection(markdown) {
  const start = markdown.indexOf("## Orchestration Used");
  assert.ok(start >= 0, "report must contain an Orchestration Used section");
  return markdown.slice(start);
}

async function testFooterMatchesResolvedRoutes() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dualplan-footer-"));
  const logPath = path.join(tmp, "log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dual-plan-footer",
      {
        task: "Apply a minimal scheduler race fix and verify it.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: false, cwd: tmp, maxSubagents: 8, maxRetries: 0,
        // Non-default executor route: away from the shape's hardcoded deepseek.
        executorProvider: "anthropic", executorModel: "claude-opus-4-8",
      },
      undefined, () => {}, { cwd: tmp },
    );
    const markdown = result.content?.[0]?.text || result.markdown || "";
    const footer = orchestrationUsedSection(markdown);

    // The footer must reflect the RESOLVED executor route ...
    assert.match(footer, /executor \(anthropic\/claude-opus-4-8\)/,
      "footer must name the resolved executor route");
    // ... and must NOT contradict it with the old hardcoded model adjectives.
    assert.doesNotMatch(footer, /deepseek/i,
      "footer must not mention deepseek when the executor was routed elsewhere");
    assert.doesNotMatch(footer, /a DeepSeek executor/i, "old hardcoded narrative must be gone");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function run() {
  await testFooterMatchesResolvedRoutes();
  console.log("PASS dual-plan-footer: Orchestration Used narrative derives from resolved routes, no contradicting model name");
}

run().catch((error) => { console.error("test-dual-plan-footer: FAIL"); console.error(error); process.exit(1); });
