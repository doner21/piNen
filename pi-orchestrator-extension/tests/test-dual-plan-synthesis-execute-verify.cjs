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

function loadRunState() {
  return makeJiti()(path.join(PROJECT_ROOT, "src", "run-state.ts"));
}

async function testRegistryDiscovery() {
  const tool = loadOrchestrateTool();
  const result = await tool.execute(
    "test-dual-plan-discovery",
    { task: "list paradigms", paradigm: "unknown-test-paradigm", preflight: false, cwd: PROJECT_ROOT },
    undefined,
    () => {},
    { cwd: PROJECT_ROOT },
  );
  assert.equal(result.details.status, "fail");
  assert.match(result.details.abortReason, /dual-plan-synthesis-execute-verify/);
}

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "dual-plan-synthesis-execute-verify.ts"), "utf8");
  assert.match(source, /name:\s*"dual-plan-synthesis-execute-verify"/);
  assert.match(source, /runBoundedPool/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.match(source, /DEFAULT_PLANNER_ROUTE = \{ provider: "openai-codex", model: "gpt-5\.6-sol" \} as const/);
  assert.match(source, /DEFAULT_EXECUTOR_ROUTE = \{ provider: "openai-codex", model: "gpt-5\.6-sol" \} as const/);
  assert.match(source, /DEFAULT_VERIFIER_ROUTE = \{ provider: "openai-codex", model: "gpt-5\.5" \} as const/);
  assert.match(source, /params\.plannerModel/);
  assert.match(source, /params\.plannerProvider/);
  assert.match(source, /params\.executorModel/);
  assert.match(source, /params\.verifierModel/);
  assert.doesNotMatch(source, /deepseek/i, "shape source must contain no DeepSeek route or narrative");
  assert.doesNotMatch(source, /openrouter/i, "shape source must contain no OpenRouter route or narrative");
  assert.doesNotMatch(source, /from\s+["']\.\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /while\s*\(\s*true\s*\)/, "shape must not contain unbounded loops");
}

function assertNoForbiddenRoutes(calls, label) {
  const forbidden = calls.filter((call) =>
    /deepseek|openrouter/i.test(`${call.provider || ""}/${call.model || ""}`));
  assert.deepEqual(forbidden, [], `${label}: no DeepSeek/OpenRouter process may spawn`);
}

async function testRunUsesRoleDefaultsAndPasses() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-shape-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dual-plan-run",
      {
        task: "Fixture task: apply a minimal scheduler race fix and verify it.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 8,
        maxRetries: 1,
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /Dual-Plan-Synthesis-Execute-Verify Orchestration: PASS/);
    assert.equal(result.details.shapeDetails?.status ?? result.details.status, "pass");

    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 5, "two planners, one synthesis reviewer, one coder, one verifier");
    const routedCalls = calls.map((call) => [call.agentName, call.provider, call.model]);
    assert.deepEqual(
      routedCalls.slice(0, 2).sort((a, b) => `${a[1]}/${a[2]}`.localeCompare(`${b[1]}/${b[2]}`)),
      [
        ["planner", "openai-codex", "gpt-5.6-sol"],
        ["planner", "openai-codex", "gpt-5.6-sol"],
      ],
      "first two spawns should use the planner-role default, order may vary due concurrency",
    );
    assert.deepEqual(routedCalls.slice(2), [
      ["reviewer", "openai-codex", "gpt-5.6-sol"],
      ["coder", "openai-codex", "gpt-5.6-sol"],
      ["reviewer", "openai-codex", "gpt-5.5"],
    ]);
    assertNoForbiddenRoutes(calls, "default run");

    const details = result.details?.shapeDetails ?? result.details;
    assert.deepEqual(details.routeResolution.map(({ seat, role, provider, model }) => ({ seat, role, provider, model })), [
      { seat: "Plan A", role: "planner", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "Plan B", role: "planner", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "synthesis", role: "planner", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "executor", role: "executor", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "verifier", role: "verifier", provider: "openai-codex", model: "gpt-5.5" },
    ], "every seat must appear in normalized route/preflight resolution");
    assert.deepEqual(details.routingEvidence.map(({ seat, provider, model }) => ({ seat, provider, model })), [
      { seat: "Plan A", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "Plan B", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "synthesis", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "executor-1", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "verifier-1", provider: "openai-codex", model: "gpt-5.5" },
    ], "every spawned seat must have observed routing evidence");
    assert.match(markdown, /Preflight role coverage.*Plan A=planner.*Synthesis=planner.*Executor=executor.*Verifier=verifier/);
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testExplicitRoleRouteOverrides() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-route-overrides-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dual-plan-route-overrides",
      {
        task: "Fixture task: honor all explicit role routes.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 8,
        maxRetries: 1,
        plannerProvider: "openai-codex",
        plannerModel: "gpt-5.6-sol",
        executorProvider: "openai-codex",
        executorModel: "gpt-5.5",
        verifierProvider: "openai-codex",
        verifierModel: "gpt-5.5",
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    assert.equal(result.details.shapeDetails?.status ?? result.details.status, "pass");
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 5, "two planners, synthesis, executor, and verifier");
    assert.deepEqual(calls.map((call) => [call.agentName, call.provider, call.model]), [
      ["planner", "openai-codex", "gpt-5.6-sol"],
      ["planner", "openai-codex", "gpt-5.6-sol"],
      ["reviewer", "openai-codex", "gpt-5.6-sol"],
      ["coder", "openai-codex", "gpt-5.5"],
      ["reviewer", "openai-codex", "gpt-5.5"],
    ], "every shape-owned seat must obey explicit allowed role routes");
    assertNoForbiddenRoutes(calls, "explicit override run");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDiscoveryOnly() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-discovery-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dual-plan-discovery-only",
      {
        task: "Fixture task: apply a minimal scheduler race fix and verify it.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 8,
        maxRetries: 1,
        discoveryOnly: true,
        predictedWriteSet: [
          "C:/absolute/path/allowed-only.txt",
          "relative/prefix/",
          "C:/absolute-prefix/",
          "fixture-out.txt",
        ],
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // ── Details normalized array ────────────────────────────────────
    const expectedNormalized = [
      "C:/absolute/path/allowed-only.txt",
      "relative/prefix/",
      "C:/absolute-prefix/",
      "fixture-out.txt",
    ];
    assert.equal(result.details?.status, "discovery-only");
    assert.equal(result.details?.mode, "discovery-only");
    assert.deepEqual(result.details?.predictedWriteSet, expectedNormalized,
      "details must expose the exact normalized predicted write set");

    // ── Markdown assertions ─────────────────────────────────────────
    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Discovery-only manifest/,
      "discovery-only mode must return a discovery manifest");
    assert.match(markdown, /\*\*Mode:\*\* discovery-only/,
      "manifest must declare discovery-only mode");
    for (const entry of expectedNormalized) {
      assert.match(markdown, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `manifest must list predicted write-set entry: ${entry}`);
    }

    // ── Expected predicted-write-set block (exact, untruncated) ────
    const expectedBlock =
      "BEGIN_PREDICTED_WRITE_SET\n" +
      expectedNormalized.map((entry) => `- ${entry}`).join("\n") +
      "\nEND_PREDICTED_WRITE_SET";

    // ── Spawn assertions ────────────────────────────────────────────
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 3,
      "discovery-only: exactly 3 spawns (Plan A, Plan B, synthesis) — no executor or verifier");

    const routedCalls = calls.map((call) => [call.agentName, call.provider, call.model]);
    assert.deepEqual(
      routedCalls.slice(0, 2).sort((a, b) => `${a[1]}/${a[2]}`.localeCompare(`${b[1]}/${b[2]}`)),
      [
        ["planner", "openai-codex", "gpt-5.6-sol"],
        ["planner", "openai-codex", "gpt-5.6-sol"],
      ],
      "first two spawns must use the planner-role default",
    );
    assert.deepEqual(
      routedCalls[2],
      ["reviewer", "openai-codex", "gpt-5.6-sol"],
      "third spawn must be the synthesis reviewer on the planner-role route",
    );
    assertNoForbiddenRoutes(calls, "discovery-only run");
    assert.deepEqual(result.details.routingEvidence.map(({ seat, provider, model }) => ({ seat, provider, model })), [
      { seat: "Plan A", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "Plan B", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "synthesis", provider: "openai-codex", model: "gpt-5.6-sol" },
    ], "discovery-only must evidence every spawned seat");

    const coderCalls = calls.filter((call) => call.agentName === "coder");
    assert.equal(coderCalls.length, 0, "discovery-only must spawn NO executor (coder)");
    const reviewerCalls = calls.filter((call) => call.agentName === "reviewer");
    assert.equal(reviewerCalls.length, 1, "discovery-only: exactly one reviewer call (synthesis only, no verifier)");

    // ── Read-only tool assertions ───────────────────────────────────
    for (const call of calls) {
      assert.equal(call.tools, "read,grep,find,ls",
        `discovery-only spawn for ${call.agentName} (${call.model}) must have read-only tools`);
      assert.equal(call.noTools, false,
        `discovery-only spawn for ${call.agentName} must NOT have --no-tools (must use restricted --tools)`);
    }

    // ── Block injection assertions ──────────────────────────────────
    // Both planner calls receive the exact block.
    const plannerCalls = calls.filter((call) => call.agentName === "planner");
    assert.equal(plannerCalls.length, 2, "both planners must be spawned");
    for (const pc of plannerCalls) {
      assert.ok(pc.predictedWriteSetBlock, `planner must include predictedWriteSetBlock in log: ${pc.model}`);
      assert.equal(pc.predictedWriteSetBlock, expectedBlock,
        `planner ${pc.model} predictedWriteSetBlock must match exactly`);
    }

    // Synthesis reviewer receives the exact block.
    assert.equal(reviewerCalls[0].predictedWriteSetBlock, expectedBlock,
      "synthesis reviewer predictedWriteSetBlock must match exactly");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDiscoveryOnlyEmpty() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-discovery-empty-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dual-plan-discovery-only-empty",
      {
        task: "Fixture task: empty write set coverage.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 8,
        maxRetries: 1,
        discoveryOnly: true,
        predictedWriteSet: [],
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    assert.equal(result.details?.status, "discovery-only");
    assert.equal(result.details?.mode, "discovery-only");
    assert.deepEqual(result.details?.predictedWriteSet, [],
      "empty predictedWriteSet must be an empty array in details");

    const markdown = result.content?.[0]?.text || "";
    assert.match(markdown, /# Discovery-only manifest/);
    assert.match(markdown, /empty.*no files predicted/i,
      "manifest must indicate empty write set");

    const expectedEmptyBlock =
      "BEGIN_PREDICTED_WRITE_SET\n(empty — no contract-granted writes)\nEND_PREDICTED_WRITE_SET";

    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 3, "discovery-only empty: exactly 3 spawns");

    // All three spawns receive the empty block.
    for (const call of calls) {
      assert.ok(call.predictedWriteSetBlock, `${call.agentName} must have predictedWriteSetBlock`);
      assert.equal(call.predictedWriteSetBlock, expectedEmptyBlock,
        `${call.agentName} predictedWriteSetBlock must be the canonical empty block`);
    }

    const coderCalls = calls.filter((call) => call.agentName === "coder");
    assert.equal(coderCalls.length, 0, "discovery-only empty: no coder");

    // ── Read-only tool assertions ───────────────────────────────────
    for (const call of calls) {
      assert.equal(call.tools, "read,grep,find,ls",
        `discovery-only empty spawn for ${call.agentName} must have read-only tools`);
      assert.equal(call.noTools, false,
        `discovery-only empty spawn for ${call.agentName} must NOT have --no-tools`);
    }
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDiscoveryOnlyMutationDetected() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-mutation-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_DUAL_PLAN_MUTATING = "1";

  try {
    const tool = loadOrchestrateTool();
    const result = await tool.execute(
      "test-dual-plan-mutation",
      {
        task: "Fixture task: apply a minimal scheduler race fix and verify it.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: false,
        cwd: tempDir,
        maxSubagents: 8,
        maxRetries: 1,
        discoveryOnly: true,
        predictedWriteSet: ["fixture-out.txt"],
      },
      undefined,
      () => {},
      { cwd: tempDir },
    );

    // The orchestrator catches shape errors and returns a failure result
    // with abortReason containing the error token.
    assert.equal(result.details.status, "fail",
      "discovery with mutating planner must return fail status");
    assert.ok(result.details.abortReason,
      "failure must include abortReason");
    assert.match(result.details.abortReason, /DISCOVERY_MUTATION_DETECTED/,
      "abortReason must contain DISCOVERY_MUTATION_DETECTED error token");
    assert.match(result.details.abortReason, /Plan A/,
      "abortReason must name the phase (Plan A) that had mutating tool calls");

    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // Synthesis must not spawn after mutation detection — only two planner spawns.
    assert.equal(calls.length, 2,
      "only two planner spawns — synthesis must NOT spawn after mutation detection");

    for (const call of calls) {
      assert.equal(call.agentName, "planner", "only planners should be in the log");
      assert.equal(call.tools, "read,grep,find,ls",
        "discovery-only spawn must have read-only tools (even when mutation is detected later)");
      assert.equal(call.noTools, false,
        "discovery-only spawn must NOT have --no-tools");
    }
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    delete process.env.FAKE_PI_DUAL_PLAN_MUTATING;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testPreflightExecutorFallbackAndSeatCoverage() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-preflight-fallback-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  const updates = [];
  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  process.env.ORCHESTRATE_PREFLIGHT_TIMEOUT_MS = "300";
  process.env.ORCHESTRATE_PREFLIGHT_TOTAL_TIMEOUT_MS = "1500";
  try {
    const result = await loadOrchestrateTool().execute(
      "test-dual-plan-preflight-fallback",
      {
        task: "Fixture task: preflight every dual-plan role and use the executor fallback.",
        paradigm: "dual-plan-synthesis-execute-verify",
        preflight: true,
        cwd: tempDir,
        maxSubagents: 8,
        maxRetries: 0,
        plannerProvider: "openai-codex",
        plannerModel: "gpt-5.6-sol",
        executorProvider: "badprov",
        executorModel: "bad-primary",
        executorFallbackProvider: "openai-codex",
        executorFallbackModel: "gpt-5.5",
        verifierProvider: "openai-codex",
        verifierModel: "gpt-5.5",
      },
      undefined,
      (update) => updates.push(update.content?.map((part) => part.text).filter(Boolean).join("\n") || ""),
      { cwd: tempDir },
    );
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const workCalls = calls.filter((call) => call.agentName !== "preflight");
    assert.equal(result.details?.shapeDetails?.status ?? result.details?.status, "pass");
    assert.ok(calls.some((call) => call.preflightFixture === "fail" && call.provider === "badprov"),
      "executor primary must be preflighted before fallback");
    assert.ok(calls.some((call) => call.agentName === "preflight" && call.provider === "openai-codex" && call.model === "gpt-5.5"),
      "executor fallback/verifier route must be preflighted");
    assert.deepEqual(workCalls.find((call) => call.agentName === "coder") &&
      [workCalls.find((call) => call.agentName === "coder").provider, workCalls.find((call) => call.agentName === "coder").model],
      ["openai-codex", "gpt-5.5"], "executor must spawn on the healthy fallback");
    assertNoForbiddenRoutes(calls, "preflight/fallback run");
    assert.match(updates.join("\n"), /executor re-routed to fallback 1 openai-codex\/gpt-5\.5/);
    assert.match(updates.join("\n"), /Resolved dual-plan seats \(preflight roles\): Plan A=planner:openai-codex\/gpt-5\.6-sol.*executor=executor:openai-codex\/gpt-5\.5.*verifier=verifier:openai-codex\/gpt-5\.5/,
      "seat-to-preflight-role evidence must show the final fallback route");
  } finally {
    for (const key of ["PI_CLI_PATH", "FAKE_PI_LOG", "ORCHESTRATE_PREFLIGHT_TIMEOUT_MS", "ORCHESTRATE_PREFLIGHT_TOTAL_TIMEOUT_MS"]) delete process.env[key];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testResumePreservesObservedSafeRoutes() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dual-plan-resume-routes-"));
  const logPath = path.join(tempDir, "fake-pi-log.jsonl");
  const runState = loadRunState();
  const runId = `test-dual-plan-routes-${Date.now().toString(36)}`;
  const storedParams = {
    cwd: tempDir,
    maxSubagents: 8,
    maxRetries: 0,
    preflight: false,
    plannerProvider: "openai-codex",
    plannerModel: "gpt-5.6-sol",
    executorProvider: "openai-codex",
    executorModel: "gpt-5.6-sol",
    verifierProvider: "openai-codex",
    verifierModel: "gpt-5.5",
  };
  const store = runState.RunStateStore.create(
    runId,
    "dual-plan-synthesis-execute-verify",
    "Resume the route-safe dual-plan fixture.",
    storedParams,
    ["planA", "planB", "synthesis", "executor-1", "verifier-1"],
  );
  const checkpoint = (agentName, text, model) => ({
    agentName,
    provider: "openai-codex",
    model,
    task: "",
    text,
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    events: 1,
    toolCalls: { total: 0, mutating: 0, byTool: {} },
  });
  store.checkpointPhase(0, "planA", checkpoint("planner", "restored Plan A", "gpt-5.6-sol"));
  store.checkpointPhase(1, "planB", checkpoint("planner", "restored Plan B", "gpt-5.6-sol"));
  store.checkpointPhase(2, "synthesis", checkpoint("reviewer", "restored synthesis", "gpt-5.6-sol"));

  process.env.PI_CLI_PATH = path.join(__dirname, "fake-pi.cjs");
  process.env.FAKE_PI_LOG = logPath;
  try {
    const result = await loadOrchestrateTool().execute(
      "test-dual-plan-resume-routes",
      { resume: runId, cwd: tempDir },
      undefined,
      () => {},
      { cwd: tempDir },
    );
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(calls.map((call) => [call.agentName, call.provider, call.model]), [
      ["coder", "openai-codex", "gpt-5.6-sol"],
      ["reviewer", "openai-codex", "gpt-5.5"],
    ], "resume must not respawn checkpointed planning/synthesis seats");
    assertNoForbiddenRoutes(calls, "resume run");
    const details = result.details?.shapeDetails ?? result.details;
    assert.deepEqual(details.routingEvidence.map(({ seat, provider, model }) => ({ seat, provider, model })), [
      { seat: "Plan A", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "Plan B", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "synthesis", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "executor-1", provider: "openai-codex", model: "gpt-5.6-sol" },
      { seat: "verifier-1", provider: "openai-codex", model: "gpt-5.5" },
    ], "resume evidence must include restored and newly spawned seats");
  } finally {
    delete process.env.PI_CLI_PATH;
    delete process.env.FAKE_PI_LOG;
    fs.rmSync(runState.runDirFor(runId), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testRegistryDiscovery();
  testCommittedShapeStaticRules();
  await testRunUsesRoleDefaultsAndPasses();
  await testExplicitRoleRouteOverrides();
  await testDiscoveryOnly();
  await testDiscoveryOnlyEmpty();
  await testDiscoveryOnlyMutationDetected();
  await testPreflightExecutorFallbackAndSeatCoverage();
  await testResumePreservesObservedSafeRoutes();
  console.log("PASS dual-plan-synthesis-execute-verify: registry, static rules, role defaults, role overrides, evidence, discovery-only, mutation-detected, resume routes");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
