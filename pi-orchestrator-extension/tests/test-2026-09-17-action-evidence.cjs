#!/usr/bin/env node
/** Regression: host-owned completed action evidence reaches the same-run verifier. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const ISOLATED_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-action-evidence-focused-"));
process.env.PI_CODING_AGENT_DIR = path.join(ISOLATED_ROOT, "agent");
process.env.PI_ORCHESTRATOR_RUNS_ROOT = path.join(ISOLATED_ROOT, "runs");
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = path.join(ISOLATED_ROOT, "next-runs");
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = ISOLATED_ROOT;
for (const directory of [process.env.PI_CODING_AGENT_DIR, process.env.PI_ORCHESTRATOR_RUNS_ROOT, process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT]) fs.mkdirSync(directory, { recursive: true });
const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const {
  ActionEvidenceCollector,
  mergeActionEvidenceLedgers,
  redactActionText,
} = jiti(path.join(ROOT, "src", "action-evidence.ts"));
const {
  buildVerificationPrompt,
  buildVisibleMainVerificationPrompt,
} = jiti(path.join(ROOT, "src", "index.ts"));
const { spawnSubagent } = jiti(path.join(ROOT, "src", "substrate.ts"));
const { NO_FORCE_KILL_GUARD_READY_MARKER } = jiti(path.join(ROOT, "src", "worker-execution-constraints.ts"));

function collectSingle(start, end) {
  const collector = new ActionEvidenceCollector();
  collector.observe(start);
  collector.observe(end);
  return collector.finalize();
}

function assertExitAuthorityRegression() {
  const failed = collectSingle(
    { type: "tool_execution_start", toolCallId: "failed-7", toolName: "bash", args: { command: "node fail.cjs" } },
    {
      type: "tool_execution_end", toolCallId: "failed-7", toolName: "bash",
      result: { content: [{ type: "text", text: "fixture setup mentioned exit code: 0\nCommand exited with code 7" }] },
      isError: true,
    },
  ).entries[0];
  assert.equal(failed.exitCode, 7, "a real failed terminal result must retain its observed exit code");
  assert.equal(failed.outcome, "failed");

  const contradictoryFailure = collectSingle(
    { type: "tool_execution_start", toolCallId: "failed-zero-prose", toolName: "bash", args: { command: "node fail.cjs" } },
    {
      type: "tool_execution_end", toolCallId: "failed-zero-prose", toolName: "bash",
      result: { content: [{ type: "text", text: "diagnostic prose only\nexit code: 0" }] },
      isError: true,
    },
  ).entries[0];
  assert.equal(contradictoryFailure.exitCode, null,
    "diagnostic success prose must not become numeric evidence for a structured failure");
  assert.equal(contradictoryFailure.outcome, "failed",
    "structured isError authority must survive contradictory diagnostic prose");

  const diagnosticFailure = collectSingle(
    { type: "tool_execution_start", toolCallId: "failed-diagnostic-seven", toolName: "bash", args: { command: "node fail.cjs" } },
    {
      type: "tool_execution_end", toolCallId: "failed-diagnostic-seven", toolName: "bash",
      result: { content: [{ type: "text", text: "diagnostic prose only\nexit code: 7" }] },
      isError: true,
    },
  ).entries[0];
  assert.equal(diagnosticFailure.exitCode, null,
    "generic diagnostic exit-code prose is not a terminal command-failure suffix");
  assert.equal(diagnosticFailure.outcome, "failed");

  const benign = collectSingle(
    { type: "tool_execution_start", toolCallId: "benign-prose", toolName: "bash", args: { command: "node pass.cjs" } },
    {
      type: "tool_execution_end", toolCallId: "benign-prose", toolName: "bash",
      result: { content: [{ type: "text", text: "fixture documentation: exit code: 7 is the negative-control example" }] },
      isError: false,
    },
  ).entries[0];
  assert.equal(benign.exitCode, null, "successful result structure must outrank an exit-code phrase in stdout");
  assert.equal(benign.outcome, "succeeded");

  const unknown = collectSingle(
    { type: "tool_execution_start", toolCallId: "unknown-failure", toolName: "bash", args: { command: "node unknown.cjs" } },
    {
      type: "tool_execution_end", toolCallId: "unknown-failure", toolName: "bash",
      result: { content: [{ type: "text", text: "opaque failure PASSWORD='unknown secret value'" }] },
      isError: true,
    },
  ).entries[0];
  assert.equal(unknown.exitCode, null, "unknown failures must not receive an invented exit code");
  assert.equal(unknown.outcome, "failed");
  assert.match(unknown.error, /opaque failure/);
  assert.doesNotMatch(unknown.error, /unknown secret value/);
}

function assertEscapedAssignmentRegression() {
  const value = String.raw`env PASSWORD=fixture\ secret\ suffix node pass.cjs`;
  const redacted = redactActionText(value);
  assert.equal(redacted, "env PASSWORD=[REDACTED] node pass.cjs");
  assert.doesNotMatch(redacted, /fixture|secret|suffix/);
}

function collectLargeUrlCredentialEvidence(command) {
  const collector = new ActionEvidenceCollector();
  collector.observe({
    type: "tool_execution_start", toolCallId: "large-url", toolName: "bash",
    args: { command },
  });
  collector.observe({
    type: "tool_execution_end", toolCallId: "large-url", toolName: "bash",
    result: { details: { exitCode: 0 } }, isError: false,
  });
  return collector.finalize();
}

function assertCompactJsonSecondUrlCredentialRegression() {
  const compactJson = '{"public":"https://public.example","private":"https://compact-user:compact-pass@private.example/path"}';
  const compactRedacted = redactActionText(compactJson);
  assert.equal(
    compactRedacted,
    '{"public":"https://public.example","private":"https://[REDACTED]@private.example/path"}',
    "a credential-bearing URL after another URL in compact JSON must be redacted",
  );
  assert.doesNotMatch(compactRedacted, /compact-user|compact-pass/);
}

function assertUnicodeSeparatedSecondUrlCredentialRegression() {
  const unicodeSeparated = "https://public.example\u2028https://unicode-user:unicode-pass@private.example/path";
  const unicodeRedacted = redactActionText(unicodeSeparated);
  assert.equal(
    unicodeRedacted,
    "https://public.example\u2028https://[REDACTED]@private.example/path",
    "a credential-bearing URL after another URL and a Unicode separator must be redacted",
  );
  assert.doesNotMatch(unicodeRedacted, /unicode-user|unicode-pass/);
}

function assertSmallLinearUrlRegression() {
  // This deliberately remains small enough for the historical quadratic
  // implementation to fail quickly rather than running its multi-minute case.
  const command = "a".repeat(100_000);
  assert.equal(command.length, 100_000);
  const startedAt = performance.now();
  const ledger = collectLargeUrlCredentialEvidence(command);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 100,
    `100,000-character URL scan must be linear and finish below 100 ms; observed ${elapsedMs.toFixed(1)} ms`);
  assert.equal(ledger.entries.length, 1);
}

function assertExactLargeLinearUrlRegression() {
  const exactLength = 2_000_345;
  const credentialPrefix = "PASSWORD=url-secret-value ";
  const command = credentialPrefix + "a".repeat(exactLength - credentialPrefix.length);
  assert.equal(command.length, exactLength, "performance fixture length must remain exact");

  // Module loading and JIT bootstrap happened above. This measures the actual
  // collector observe/finalize production path, including redaction and bounds.
  const startedAt = performance.now();
  const ledger = collectLargeUrlCredentialEvidence(command);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_250,
    `2,000,345-character production evidence path must finish below the low-flake 1,250 ms ceiling; observed ${elapsedMs.toFixed(1)} ms`);
  console.log(`MEASURE action-evidence exact-length=${exactLength} elapsedMs=${elapsedMs.toFixed(1)} ceilingMs=1250`);

  const serialized = JSON.stringify(ledger);
  assert.equal(ledger.totalEntries, 1);
  assert.equal(ledger.totalCompletedEntries, 1);
  assert.equal(ledger.incompleteEntries, 0);
  assert.equal(ledger.entries.length, 0, "oversized action must be omitted as one whole entry");
  assert.equal(ledger.omittedEntries, 1);
  assert.equal(ledger.omittedCompletedEntries, 1);
  assert.deepEqual(ledger.omissionReasons, ["serialized-size-budget"]);
  assert.doesNotMatch(serialized, /url-secret-value/);
}

function assertSafeTypecheckEntrypoint() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["typecheck:next"], "node tests/typecheck-next.cjs",
    "typecheck:next must bypass the signal-forwarding run-isolated wrapper");
  assert.doesNotMatch(pkg.scripts["test:2026-09-17"], /run-isolated/,
    "the focused safety suite must not use the signal-forwarding wrapper");
}

function assertMergeOmissionReasonRegression() {
  const oversized = collectSingle(
    {
      type: "tool_execution_start", toolCallId: "oversized", toolName: "bash",
      args: { command: `node huge.cjs ${"x".repeat(2_000_000)}` },
    },
    {
      type: "tool_execution_end", toolCallId: "oversized", toolName: "bash",
      result: { details: { exitCode: 0 } }, isError: false,
    },
  );
  assert.deepEqual(oversized.omissionReasons, ["serialized-size-budget"]);
  assert.equal(oversized.totalEntries, 1);
  assert.equal(oversized.totalCompletedEntries, 1);
  assert.equal(oversized.omittedEntries, 1);
  assert.equal(oversized.omittedCompletedEntries, 1);

  const small = collectSingle(
    { type: "tool_execution_start", toolCallId: "small", toolName: "bash", args: { command: "true" } },
    {
      type: "tool_execution_end", toolCallId: "small", toolName: "bash",
      result: { details: { exitCode: 0 } }, isError: false,
    },
  );
  const merged = mergeActionEvidenceLedgers(oversized, small);
  assert.deepEqual(merged.omissionReasons, ["serialized-size-budget"],
    "merging a size-omitted ledger must not invent an entry-count omission");
  assert.equal(merged.totalEntries, 2);
  assert.equal(merged.totalCompletedEntries, 2);
  assert.equal(merged.incompleteEntries, 0);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].toolCallId, "small");
  assert.equal(merged.omittedEntries, 1);
  assert.equal(merged.omittedCompletedEntries, 1);
}

const focusedCases = {
  "exit-authority": assertExitAuthorityRegression,
  "escaped-assignment": assertEscapedAssignmentRegression,
  "url-second-credential-compact-json": assertCompactJsonSecondUrlCredentialRegression,
  "url-second-credential-unicode": assertUnicodeSeparatedSecondUrlCredentialRegression,
  "url-linear-small": assertSmallLinearUrlRegression,
  "url-linear-exact": assertExactLargeLinearUrlRegression,
  "merge-omission": assertMergeOmissionReasonRegression,
  "safe-typecheck-entrypoint": assertSafeTypecheckEntrypoint,
};
const focusedCase = process.argv[2];
if (focusedCase) {
  try {
    assert.ok(focusedCases[focusedCase], `unknown focused case: ${focusedCase}`);
    focusedCases[focusedCase]();
    console.log(`PASS focused action-evidence regression: ${focusedCase}`);
  } finally {
    fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  }
} else {

function assertCollectorEdgeCases() {
  const collector = new ActionEvidenceCollector();
  const hugePadding = "x".repeat(2_000_000);
  collector.observe({
    type: "tool_execution_start", toolCallId: "huge", toolName: "bash",
    args: { command: `node probe.cjs ${hugePadding} --password "quoted giant secret" -H "Authorization: Basic dXNlcjpwYXNz"` },
  });
  collector.observe({
    type: "tool_execution_end", toolCallId: "huge", toolName: "bash",
    result: { content: [{ type: "text", text: "Command exited with code 7" }] }, isError: true,
  });
  collector.observe({
    type: "tool_execution_start", toolCallId: "opaque-error", toolName: "bash",
    args: { command: "node opaque-failure.cjs" },
  });
  collector.observe({
    type: "tool_execution_end", toolCallId: "opaque-error", toolName: "bash",
    result: { content: [{ type: "text", text: "opaque tool failure without a numeric status" }] }, error: true,
  });
  const ledger = collector.finalize();
  const serialized = JSON.stringify(ledger);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= ledger.serializedSizeLimitBytes,
    "serialized ledger must obey its declared byte budget");
  assert.ok(ledger.omissionReasons.includes("serialized-size-budget"), `missing whole-entry size omission reason: ${serialized.slice(0, 1000)}`);
  assert.equal(ledger.totalEntries, 2);
  assert.equal(ledger.entries.length, 1, "an oversized entry must be omitted whole, not sliced internally");
  assert.equal(ledger.omittedEntries, 1, "whole-entry size omission must be accounted exactly");
  assert.equal(ledger.omittedCompletedEntries, 1);
  assert.equal(ledger.entries.some((entry) => entry.toolCallId === "huge"), false);
  assert.doesNotMatch(serialized, /TRUNCATED|dXNlcjpwYXNz|quoted giant secret/);
  const opaque = ledger.entries.find((entry) => entry.toolCallId === "opaque-error");
  assert.equal(opaque.exitCode, null, "failure without an observed status must not invent exit code 1");
  assert.equal(opaque.outcome, "failed");
  assert.match(opaque.error, /opaque tool failure/);

  const structured = new ActionEvidenceCollector();
  structured.observe({ type: "tool_execution_start", toolCallId: "structured", toolName: "bash", args: { command: "node fail.cjs" } });
  structured.observe({
    type: "tool_execution_end", toolCallId: "structured", toolName: "bash",
    result: {
      content: [{ type: "text", text: "fixture prose says exit code: 0" }],
      details: { exitCode: 7 },
    },
    isError: true,
  });
  assert.equal(structured.finalize().entries[0].exitCode, 7,
    "authoritative structured exit status must outrank arbitrary output prose");

  const giantId = "id-" + "y".repeat(2_000_000);
  const giantIdCollector = new ActionEvidenceCollector();
  giantIdCollector.observe({ type: "tool_execution_start", toolCallId: giantId, toolName: "bash", args: { command: "true" } });
  giantIdCollector.observe({ type: "tool_execution_end", toolCallId: giantId, toolName: "bash", result: { details: { exitCode: 0 } } });
  const giantIdLedger = giantIdCollector.finalize();
  assert.ok(Buffer.byteLength(JSON.stringify(giantIdLedger), "utf8") <= giantIdLedger.serializedSizeLimitBytes,
    "the hard ledger ceiling must cover toolCallId and every other entry field");
  assert.equal(giantIdLedger.entries.length, 0);
  assert.equal(giantIdLedger.omittedEntries, 1);
  assert.equal(giantIdLedger.omittedCompletedEntries, 1);

  const secrets = [
    `curl --password 'quoted secret suffix' -H "Authorization: Basic dXNlcjpwYXNz"`,
    `export "PASSWORD=fixture secret with spaces"; curl -H "Authorization: Token token-value"`,
    String.raw`env PASSWORD=fixture\ secret\ suffix TOKEN=plain-token node send.cjs`,
    `curl -H "Authorization: Bearer bearer-value" https://url-user:url-secret-value@example.test`,
    `node send.cjs '{"password":"json secret value"}' --api-key=cli-secret-value`,
  ];
  const redacted = secrets.map(redactActionText).join("\n");
  assert.doesNotMatch(redacted, /quoted secret suffix|fixture secret with spaces|fixture\\ secret\\ suffix|plain-token|token-value|bearer-value|url-user|url-secret-value|json secret value|cli-secret-value/);
  assert.match(redacted, /--password \[REDACTED\]/);
  assert.match(redacted, /Authorization: Basic \[REDACTED\]/);
  assert.match(redacted, /Authorization: Token \[REDACTED\]/);
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
  assert.match(redacted, /PASSWORD=\[REDACTED\]/);
  assert.match(redacted, /TOKEN=\[REDACTED\]/);
  assert.match(redacted, /https:\/\/\[REDACTED\]@example\.test/);
  assert.match(redacted, /"password":\[REDACTED\]/);
  assert.match(redacted, /--api-key=\[REDACTED\]/);
}

function fixtureIntake() {
  return {
    originalTask: "Implement the fixture with tests-first evidence.",
    taskSummary: "fixture",
    taskType: "implementation",
    userIntent: "prove host action evidence",
    goalAttractor: "real RED/edit/GREEN evidence",
    taskScope: "fixture only",
    constraints: [],
    invariants: [],
    successCriteria: ["real assertion turns RED to GREEN"],
    deliverables: ["subject.txt"],
    failureCriteria: [],
    nonGoals: [],
    ambiguities: [],
    routingDecision: "fixture",
    routingRequirements: [],
    orchestrationControls: {},
    inferredAdvisoryCriteria: [],
    criteriaProvenance: [],
    ownerCriteria: { success: ["real assertion turns RED to GREEN"], failure: [] },
    supervisorAddedConstraints: [],
    plannerInferredPresentationRules: [],
  };
}

function fixtureOutput(ledger) {
  return {
    taskId: "task-1",
    description: "EDIT subject.txt after a causal RED and rerun the assertion.",
    agentName: "coder",
    output: "All tests passed on the first try; no failed command occurred.",
    exitCode: 0,
    durationMs: 1,
    actionEvidence: ledger,
    filesChanged: 1,
    changedFiles: ["subject.txt"],
  };
}

function assertLedger(ledger) {
  assert.ok(ledger, "executor result must carry host-owned actionEvidence");
  assert.equal(ledger.totalEntries, 3);
  assert.equal(ledger.totalCompletedEntries, 3);
  assert.equal(ledger.incompleteEntries, 0);
  assert.equal(ledger.entries.length, 3);
  assert.equal(ledger.omittedEntries, 0);
  assert.equal(ledger.omittedCompletedEntries, 0);
  assert.deepEqual(ledger.omissionReasons, []);
  assert.equal(new Set(ledger.entries.map((entry) => entry.sequence)).size, ledger.entries.length);
  assert.ok(ledger.entries.every((entry) => entry.status === "completed" && entry.startedSequence < entry.completedSequence),
    "real AgentSession evidence consists of aligned start/end entries");
  const red = ledger.entries.find((entry) => entry.toolCallId === "red-1");
  const edit = ledger.entries.find((entry) => entry.toolCallId === "edit-1");
  const green = ledger.entries.find((entry) => entry.toolCallId === "green-1");
  assert.ok(red && edit && green, "real AgentSession emitted RED, edit, and GREEN entries");
  assert.equal(red.command, "API_TOKEN=[REDACTED] node assert-after.cjs");
  assert.equal(red.timeoutKeyPresent, false, "the real RED omits timeout rather than passing a sentinel");
  assert.equal(red.exitCode, 1);
  assert.equal(red.outcome, "failed");
  assert.equal(edit.target, "subject.txt");
  assert.equal(edit.exitCode, null, "a non-process edit must not receive an invented exit code");
  assert.equal(edit.outcome, "succeeded", "the real AgentSession completion status proves edit success");
  assert.equal(green.command, "API_TOKEN=[REDACTED] node assert-after.cjs");
  assert.equal(green.timeoutKeyPresent, false, "the real GREEN omits timeout rather than passing a sentinel");
  assert.equal(green.exitCode, null, "status-only bash success must not invent an unobserved exit code");
  assert.equal(green.outcome, "succeeded");
  assert.ok(red.sequence < edit.sequence && edit.sequence < green.sequence,
    "ledger alone proves causal RED-before-edit-before-GREEN");
  assert.doesNotMatch(JSON.stringify(ledger), /super-secret-value/);
}

function assertProductionVerifierPrompt(prompt, ledger) {
  assert.match(prompt, /HOST-OWNED ACTION EVIDENCE AUTHORITY/);
  assert.match(prompt, /authoritative and overrides contradictory executor prose/);
  assert.match(prompt, /red-1/);
  assert.match(prompt, /edit-1/);
  assert.match(prompt, /green-1/);
  assert.match(prompt, /"exitCode":\s*1/);
  assert.doesNotMatch(prompt, /super-secret-value/);
  for (const entry of ledger.entries) assert.match(prompt, new RegExp(entry.toolCallId));
}

async function runRealAgentSessionIntegration() {
  assert.equal(typeof buildVerificationPrompt, "function",
    "the classic production verifier prompt builder must be directly integration-testable");
  assert.equal(typeof buildVisibleMainVerificationPrompt, "function",
    "the visible-main production verifier prompt builder must be directly integration-testable");

  const runtime = path.join(__dirname, `.action-evidence-runtime-${process.pid}-${Date.now()}`);
  const workspace = path.join(runtime, "workspace");
  const agentDir = path.join(runtime, "agent");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "subject.txt"), "before\n", "utf8");
  fs.writeFileSync(path.join(workspace, "assert-after.cjs"), [
    'const assert = require("node:assert/strict");',
    'const fs = require("node:fs");',
    'assert.equal(fs.readFileSync("subject.txt", "utf8"), "after\\n", "subject must be edited before GREEN");',
    'console.log("ASSERT_AFTER_PASS");',
    '',
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "fixture",
        models: [{ id: "evidence-model", name: "Evidence fixture", reasoning: false, input: ["text"], contextWindow: 8_000_000, maxTokens: 1_000 }],
      },
    },
  }), "utf8");

  const previousCli = process.env.PI_CLI_PATH;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CLI_PATH = path.join(__dirname, "fixtures", "action-evidence-agent-session-worker.cjs");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const launched = await spawnSubagent(
      "coder",
      "Run the real assertion, edit subject.txt, then rerun the same assertion.",
      {
        agents: new Map([["coder", {
          name: "coder",
          provider: "fixture",
          model: "evidence-model",
          tools: ["bash", "edit"],
        }]]),
        cwd: workspace,
        allowLocalModel: true,
        workerExecutionConstraints: { noForceKill: true },
      },
    );
    assert.equal(launched.exitCode, 0, `production launcher failed:\n${launched.stderr}`);
    assert.match(launched.stderr, new RegExp(NO_FORCE_KILL_GUARD_READY_MARKER),
      "the production host must observe the real no-force-kill guard attestation");
    assert.equal(launched.text, "All tests passed on the first try; no failed command occurred.");
    assert.equal(fs.readFileSync(path.join(workspace, "subject.txt"), "utf8"), "after\n",
      "the real edit tool must be what makes the repeated assertion pass");
    assert.equal(fs.existsSync(path.join(agentDir, "settings.json")), false,
      "the guarded in-memory AgentSession must not write settings");
    assert.equal(fs.existsSync(path.join(runtime, "runs-state")), false,
      "direct production spawnSubagent integration must not write runs-state");
    assert.equal(fs.existsSync(path.join(workspace, ".pi")), false,
      "the in-memory AgentSession must not persist session state in the workspace");

    const ledger = launched.actionEvidence;
    assertLedger(ledger);
    const intake = fixtureIntake();
    const plan = { tasks: [{ id: "task-1", description: "EDIT subject.txt after causal RED.", dependsOn: [] }], notes: "fixture" };
    const output = fixtureOutput(ledger);
    const classicPrompt = buildVerificationPrompt(intake, plan, [output], "fixture route", "fixture artifact evidence");
    const visiblePrompt = buildVisibleMainVerificationPrompt(intake, {
      originalTask: intake.originalTask,
      acceptanceCriteria: [{ id: "AC-01", text: "real assertion turns RED to GREEN", required: true }],
    }, plan, [output]);
    assert.match(classicPrompt, /Verify the orchestration result/);
    assert.match(visiblePrompt, /VISIBLE_MAIN_CRITERION_VERIFICATION/);
    assertProductionVerifierPrompt(classicPrompt, ledger);
    assertProductionVerifierPrompt(visiblePrompt, ledger);
  } finally {
    if (previousCli === undefined) delete process.env.PI_CLI_PATH;
    else process.env.PI_CLI_PATH = previousCli;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

(async () => {
  assertExitAuthorityRegression();
  assertSafeTypecheckEntrypoint();
  assertEscapedAssignmentRegression();
  assertMergeOmissionReasonRegression();
  assertCompactJsonSecondUrlCredentialRegression();
  assertUnicodeSeparatedSecondUrlCredentialRegression();
  assertSmallLinearUrlRegression();
  assertExactLargeLinearUrlRegression();
  assertCollectorEdgeCases();
  await runRealAgentSessionIntegration();
  console.log("PASS action-evidence: real isolated AgentSession executes causal RED/edit/GREEN and both production verifier paths receive bounded host authority");
})().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
});
}
