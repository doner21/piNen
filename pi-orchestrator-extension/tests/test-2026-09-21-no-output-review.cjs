#!/usr/bin/env node
/** Independent-review regressions for item 3. Every root is isolated before product imports. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-review-"));
const WORKSPACE = path.join(TEMP_ROOT, "workspace");
const TEST_DIR = path.join(WORKSPACE, "tests");
const AGENT_DIR = path.join(TEMP_ROOT, "agent");
const RUNS_ROOT = path.join(TEMP_ROOT, "runs");
const NEXT_RUNS_ROOT = path.join(TEMP_ROOT, "next-runs");
for (const directory of [WORKSPACE, TEST_DIR, AGENT_DIR, RUNS_ROOT, NEXT_RUNS_ROOT]) fs.mkdirSync(directory, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_ORCHESTRATOR_RUNS_ROOT = RUNS_ROOT;
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = NEXT_RUNS_ROOT;
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_OFFLINE = "1";

for (const [name, source] of Object.entries({
  "worker-helper.cjs": "setTimeout(() => {}, 1);\n",
  "service-test.cjs": "setTimeout(() => {}, 1);\n",
  "main.js": "setTimeout(() => {}, 1);\n",
  "trusted.cjs": "console.log('TRUSTED');\n",
  "preload.cjs": "globalThis.PRELOAD = 1;\n",
  "alarm.cjs": "console.log('ALARM_CHILD_STARTED'); setTimeout(() => console.log('ALARM_NATURAL_COMPLETION'), 900);\n",
})) fs.writeFileSync(path.join(TEST_DIR, name), source);
fs.mkdirSync(path.join(WORKSPACE, "reports"), { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, "reports", "not-authority.cjs"), "console.log('output only');\n");
fs.writeFileSync(path.join(WORKSPACE, "package.json"), JSON.stringify({
  name: "item3-review-fixture", private: true,
  scripts: {
    "test:trusted": "node tests/trusted.cjs",
    "test:preload-candidate": "node tests/preload.cjs",
    "test:output-only": "node tests/trusted.cjs reports/not-authority.cjs",
  },
}, null, 2));

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const helper = require(path.join(ROOT, "src", "no-output-test-supervisor.cjs"));
const monitor = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
const substrate = jiti(path.join(ROOT, "src", "substrate.ts"));
const supervision = jiti(path.join(ROOT, "src", "supervision.ts"));
const { ActionEvidenceCollector, mergeActionEvidenceLedgers } = jiti(path.join(ROOT, "src", "action-evidence.ts"));
const { StreamingSecretRedactor, redactCompleteText } = require(path.join(ROOT, "src", "streaming-redactor.cjs"));
const { performance } = require("node:perf_hooks");
const { assertItem3InvocationBudget, assertItem3ProducerBudget } = require("./fixtures/item3-budget-assertions.cjs");
const { CommandTelemetryOwner } = require("../src/command-telemetry-owner.cjs");
const { FixtureSegmentProducer } = require("./fixtures/item3-segment-producer.cjs");

const policy = { minimumObservationMs: 100, alarmAfterMs: 250, cancelAfterMs: 500, minimumAlarmLeadMs: 100, pollMs: 10 };

function readJsonLines(directory) {
  const events = [];
  if (!fs.existsSync(directory)) return events;
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".jsonl") || entry.endsWith(".terminal.json"))) {
    for (const line of fs.readFileSync(path.join(directory, name), "utf8").split(/\r?\n/).filter(Boolean)) events.push(JSON.parse(line));
  }
  return events;
}

async function runHelperWithoutAcknowledgement() {
  const eventDir = path.join(TEMP_ROOT, "no-ack-events");
  const authorization = substrate.freezeRunTestAuthorizationPolicy({
    cwd: WORKSPACE, ownerTask: "Run the alarm test", approvedTestScopes: [path.join(TEST_DIR, "alarm.cjs")],
  });
  assert.equal(helper.classifyTest([path.join(TEST_DIR, "alarm.cjs")], WORKSPACE, authorization).eligible, true,
    "no-ACK control must be genuinely eligible before transport starts");
  const materialized = substrate.materializeFrozenTestAuthorizationPolicy(authorization, path.join(TEMP_ROOT, "no-ack-policy"), WORKSPACE);
  fs.mkdirSync(eventDir, { recursive: true });
  const owner = new CommandTelemetryOwner({ commandRoot: path.join(TEMP_ROOT, "no-ack-owner"), evidenceDirectory: eventDir, commandId: "no-ack-command" });
  await owner.start();
  const child = spawn(process.execPath, [
    path.join(ROOT, "src", "no-output-test-supervisor.cjs"),
    "--event-dir", eventDir,
    "--evidence-root", path.join(TEMP_ROOT, "no-ack-evidence"),
    "--command-id", "no-ack-command",
    "--policy", JSON.stringify(policy),
    "--authorization-file", materialized.file,
    "--authorization-sha256", materialized.sha256,
    "--io-observer", path.join(ROOT, "src", "no-output-io-observer.cjs"),
    "--host-managed-capture", "true",
    "--owner-config", JSON.stringify(owner.configuration()),
    "--", path.join(TEST_DIR, "alarm.cjs"),
  ], {
    cwd: WORKSPACE,
    env: { ...process.env, PI_ORC_NO_OUTPUT_AUTH: "a".repeat(64) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const settlement = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const events = owner.drainEvents();
  const ownerAccounting = owner.accounting();
  await owner.close();
  return { settlement, stdout, events, ownerAccounting };
}

function cancellationLedger(id, marker) {
  const collector = new ActionEvidenceCollector();
  collector.observe({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `node ${id}.cjs` } });
  collector.observe({
    type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: true,
    result: { details: { noOutput: {
      schemaVersion: 1, outcome: "cancelled_no_output", invocationId: id, summary: "Cancelled after 10.0 minutes with no output.",
      noOutputMs: 600000, totalElapsedMs: 700000,
      alarmMonotonicMs: 1, alarmAcknowledgedMonotonicMs: 1, cancelledMonotonicMs: 2, minimumObservationMs: 1, minimumAlarmLeadMs: 1,
      cancellationRequested: true, cancellationAccepted: true, cancellationConfirmed: true,
      confirmationBasis: "terminal_signal_after_owned_handle_action", terminalExitCode: null, terminalSignal: "SIGTERM",
      cancellationTarget: "retained-direct-test-child-handle", eligibility: "authenticated_run_owned_test_child",
      observedSources: ["stdout", "stderr"], observationErrors: [],
      partialLog: `${marker}${"x".repeat(64 * 1024)}`, artifactPath: path.join(TEMP_ROOT, `${id}.json`),
      artifactSha256: "a".repeat(64), artifactBytes: 1, artifactIntegrity: "verified", cancellations: [],
    } } },
  });
  return collector.finalize();
}

const cases = {
  async "run-policy-freeze"() {
    const frozen = substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask: "Run the trusted test" });
    const mission = supervision.createFrozenMission({
      originalTask: "Run the trusted test", cwd: WORKSPACE,
      worktree: { root: WORKSPACE, realRoot: fs.realpathSync(WORKSPACE), branch: null, baseline: null },
      paradigm: "plan-execute-verify", lane: "product",
      routes: [
        { role: "planner", agentName: "planner", provider: "fixture", model: "model" },
        { role: "executor", agentName: "coder", provider: "fixture", model: "model" },
        { role: "verifier", agentName: "reviewer", provider: "fixture", model: "model" },
      ], constraints: [], nonGoals: [], acceptanceCriteria: [{ id: "AC-01", text: "test", required: true }],
      workerExecutionConstraints: { noForceKill: true, testAuthorization: frozen },
    });
    assert.equal(supervision.verifyFrozenMission(mission), true);
    const originalPackageText = fs.readFileSync(path.join(WORKSPACE, "package.json"), "utf8");
    const mutatedPackage = JSON.parse(originalPackageText);
    mutatedPackage.scripts["test:late"] = "node tests/service-test.cjs";
    fs.writeFileSync(path.join(WORKSPACE, "package.json"), JSON.stringify(mutatedPackage, null, 2));
    const first = substrate.materializeFrozenTestAuthorizationPolicy(frozen, path.join(TEMP_ROOT, "policy-a"), WORKSPACE);
    const second = substrate.materializeFrozenTestAuthorizationPolicy(mission.workerExecutionConstraints.testAuthorization, path.join(TEMP_ROOT, "policy-b"), WORKSPACE);
    assert.equal(first.sha256, second.sha256, "worker launches must serialize the mission snapshot without rereading package metadata");
    const substrateSource = fs.readFileSync(path.join(ROOT, "src", "substrate.ts"), "utf8");
    const materializer = substrateSource.slice(substrateSource.indexOf("export function materializeFrozenTestAuthorizationPolicy"), substrateSource.indexOf("/** Resolve the exact launcher model"));
    assert.doesNotMatch(materializer, /package\.json|readFileSync/,
      "per-worker policy materialization must not reread mutable package authority");
    assert.equal(helper.classifyTest([path.join(TEST_DIR, "service-test.cjs")], WORKSPACE, frozen).eligible, false);
    assert.equal(supervision.verifyFrozenMission({ ...mission, workerExecutionConstraints: { ...mission.workerExecutionConstraints, testAuthorization: substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask: "Run the trusted test" }) } }), false);
    fs.writeFileSync(path.join(WORKSPACE, "package.json"), originalPackageText);
  },
  async "authority-negative"() {
    for (const ownerTask of [
      "Do not run any tests. Read documentation only.",
      "Do not execute the regression suite.",
      "Please explain how to run tests; do not execute them.",
      "The documentation says: ‘run tests’ as an example; explain it only.",
    ]) {
      const negative = substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask, approvedTestScopes: [path.join(WORKSPACE, "src")] });
      assert.equal(negative.existingEntrypoints.length, 0, ownerTask);
      assert.equal(negative.approvedDynamicScopes.length, 0, ownerTask);
    }
    const historical = substrate.freezeRunTestAuthorizationPolicy({
      cwd: WORKSPACE, ownerTask: "Run the trusted test", approvedTestScopes: [TEST_DIR], historicalWithoutAuthority: true,
    });
    assert.equal(historical.existingEntrypoints.length, 0, "historical resume without stored authority must never resnapshot mutable package state");
    assert.equal(historical.approvedDynamicScopes.length, 0);
  },
  async "authority-scope-preload"() {
    fs.mkdirSync(path.join(WORKSPACE, "src"), { recursive: true });
    const scoped = substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask: "Add and run tests", approvedTestScopes: [path.join(WORKSPACE, "src")] });
    fs.writeFileSync(path.join(WORKSPACE, "src", "new-app.cjs"), "console.log('app');\n");
    assert.equal(helper.classifyTest([path.join(WORKSPACE, "src", "new-app.cjs")], WORKSPACE, scoped).eligible, false,
      "general product scope must not become dynamic TEST authority");
    const futureTest = path.join(TEST_DIR, "future-approved.cjs");
    const futurePolicy = substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask: "Create and run tests", approvedTestScopes: [futureTest] });
    fs.writeFileSync(futureTest, "console.log('future test');\n");
    assert.equal(helper.classifyTest([futureTest], WORKSPACE, futurePolicy).eligible, true,
      "a truly upfront-approved exact TEST path must admit its later test invocation");
    const futureDirectory = path.join(TEST_DIR, "future-directory.cjs");
    const directoryPolicy = substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask: "Create and run tests", approvedTestScopes: [futureDirectory] });
    fs.mkdirSync(futureDirectory, { recursive: true });
    const nestedApp = path.join(futureDirectory, "nested-app.cjs");
    fs.writeFileSync(nestedApp, "console.log('nested');\n");
    assert.equal(helper.classifyTest([nestedApp], WORKSPACE, directoryPolicy).eligible, false,
      "a future exact file grant that becomes a directory must never authorize descendants");
    const preloadPolicy = substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask: "Run the trusted test", approvedTestScopes: [TEST_DIR] });
    fs.writeFileSync(path.join(TEST_DIR, "preload.cjs"), "globalThis.PRELOAD = 2;\n");
    assert.equal(helper.classifyTest([path.join(TEST_DIR, "trusted.cjs")], WORKSPACE, preloadPolicy, "--require ./tests/preload.cjs").eligible, false,
      "changed preload bytes must invalidate eligibility even when the target remains authorized");
    fs.writeFileSync(path.join(TEST_DIR, "preload.cjs"), "globalThis.PRELOAD = 1;\n");
  },
  async "authority-coverage"() {
    const actual = substrate.freezeRunTestAuthorizationPolicy({ cwd: ROOT, ownerTask: "Run the package tests" });
    assert.ok(actual.existingEntrypoints.length > 20, `ordinary package graph coverage is too narrow: ${actual.existingEntrypoints.length}`);
    assert.ok(actual.existingEntrypoints.some((entry) => entry.path.endsWith(path.join("tests", "test-round7-defect-aa.cjs"))),
      "normal package suites, not only run-isolated wrappers, must be authorized");
  },
  async eligibility() {
    const frozen = substrate.freezeRunTestAuthorizationPolicy({ cwd: WORKSPACE, ownerTask: "Run the trusted test" });
    assert.equal(helper.classifyTest([path.join(TEST_DIR, "trusted.cjs")], WORKSPACE, frozen).eligible, true);
    assert.equal(helper.classifyTest(["--test", path.join(TEST_DIR, "trusted.cjs")], WORKSPACE, frozen).eligible, true,
      "a true Node runner prefix still requires an exact host-contracted entrypoint");
    assert.equal(helper.classifyTest([path.join(TEST_DIR, "worker-helper.cjs")], WORKSPACE, frozen).eligible, false);
    assert.equal(helper.classifyTest([path.join(TEST_DIR, "service-test.cjs")], WORKSPACE, frozen).eligible, false);
    assert.equal(helper.classifyTest([path.join(WORKSPACE, "reports", "not-authority.cjs")], WORKSPACE, frozen).eligible, false,
      "a JavaScript output operand is not an executable test grant");
    assert.equal(helper.classifyTest([path.join(TEST_DIR, "main.js"), "--test"], WORKSPACE, frozen).eligible, false,
      "--test after a script is application argv, not a runner prefix");
    assert.equal(helper.classifyTest(["--inspect", path.join(TEST_DIR, "trusted.cjs")], WORKSPACE, frozen).eligible, false,
      "unknown privileged Node options must be observe-only");
    const tooManyOutputs = [path.join(TEST_DIR, "trusted.cjs")];
    for (let index = 0; index < 33; index += 1) tooManyOutputs.push("--outputFile", `logs/output-${index}.log`);
    assert.equal(helper.classifyTest(tooManyOutputs, WORKSPACE, frozen).eligible, false,
      "33 output destinations must become explicit observe-only rather than silently slicing to 32");
  },
  async "shell-semantics"() {
    const source = fs.readFileSync(path.join(ROOT, "src", "worker-no-output-monitor.ts"), "utf8");
    assert.doesNotMatch(source, /rewriteCommand|findBareNodeCommandTokens/,
      "shell text must remain untouched; production dispatch coverage exercises cwd, command, exec, stdin and heredoc");
  },
  async "alarm-ack"() {
    const realistic = new helper.SilencePolicyMachine(helper.DEFAULT_POLICY, 0);
    assert.equal(realistic.tick(119999), undefined);
    assert.equal(realistic.tick(300000).kind, "alarm");
    assert.equal(realistic.tick(599999), undefined);
    assert.equal(realistic.acknowledgeAlarm(600000), true);
    assert.equal(realistic.tick(629999), undefined);
    assert.equal(realistic.tick(630000).kind, "cancel");
    const result = await runHelperWithoutAcknowledgement();
    assert.match(result.stdout, /ALARM_NATURAL_COMPLETION/,
      "without positive supervisor acknowledgement the helper must not cancel");
    assert.equal(result.events.some((event) => event.outcome === "cancelled_no_output"), false);
    const terminal = result.events.find((event) => event.type === "invocation_terminal");
    assert.ok(terminal, "the naturally settled helper must publish one canonical terminal record");
    assertItem3ProducerBudget({
      peakDiskBytes: Number(result.ownerAccounting.retainedBytes) || 0,
      peakFiles: Number(result.ownerAccounting.retainedGenerations) || 0,
      peakReservedBytes: Number(result.ownerAccounting.maxOutstandingBytes) || 0,
      peakEventBytes: 0,
      peakControlBytes: 0,
      peakTerminalBytes: Number(result.ownerAccounting.retainedBytes) || 0,
    }, "review/no-ack", terminal.sharedReadAccounting);
  },
  async "evidence-authority"() {
    const journalFile = path.join(TEMP_ROOT, "authority-journal.jsonl");
    const collector = new ActionEvidenceCollector({ cancellationJournalFile: journalFile });
    const template = cancellationLedger("seed", "SEALED_ORIGINAL_MARKER").entries[0].noOutput.cancellations[0];
    collector.observe({ type: "tool_execution_start", toolCallId: "authority", toolName: "bash", args: { command: "node trusted.cjs" } });
    collector.observe({ type: "tool_execution_update", toolCallId: "authority", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: `完整-${"識".repeat(200)}`, partialLog: "SEALED_ORIGINAL_MARKER" } } } });
    collector.observe({ type: "tool_execution_end", toolCallId: "authority", toolName: "bash", isError: true, result: { details: { noOutput: { ...template, partialLog: "REPLACEMENT_TEXT", cancellations: [{ ...template, partialLog: "REPLACEMENT_TEXT" }], minimumObservationMs: 1, minimumAlarmLeadMs: 1 } } } });
    const ledger = collector.finalize();
    const entry = ledger.entries.find((item) => item.toolCallId === "authority");
    assert.match(entry.noOutput.partialLog, /SEALED_ORIGINAL_MARKER/);
    assert.doesNotMatch(entry.noOutput.partialLog, /REPLACEMENT_TEXT/);
    assert.match(fs.readFileSync(journalFile, "utf8"), new RegExp(`完整-${"識".repeat(200)}`), "durable journal must preserve full Unicode invocation IDs");

    const multi = new ActionEvidenceCollector({ cancellationJournalFile: path.join(TEMP_ROOT, "multi-authority.jsonl") });
    multi.observe({ type: "tool_execution_start", toolCallId: "multi", toolName: "bash", args: { command: "loop" } });
    multi.observe({ type: "tool_execution_update", toolCallId: "multi", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "multi-a", partialLog: "SEALED_A" } } } });
    multi.observe({ type: "tool_execution_update", toolCallId: "multi", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "multi-b", partialLog: "SEALED_B" } } } });
    multi.observe({ type: "tool_execution_end", toolCallId: "multi", toolName: "bash", isError: true, result: { details: { noOutput: { ...template, invocationId: "multi-a", partialLog: "SEALED_A", cancellations: [{ ...template, invocationId: "multi-a", partialLog: "SEALED_A" }, { ...template, invocationId: "multi-b", partialLog: "REPLACED_B" }], minimumObservationMs: 1, minimumAlarmLeadMs: 1 } } } });
    const multiEvidence = multi.finalize().entries[0].noOutput;
    assert.match(multiEvidence.partialLog, /SEALED_A/);
    assert.match(multiEvidence.partialLog, /SEALED_B/);
    assert.doesNotMatch(multiEvidence.partialLog, /REPLACED_B/);
  },
  async "journal-integrity"() {
    const journalFile = path.join(TEMP_ROOT, "identity-journal.jsonl");
    const collector = new ActionEvidenceCollector({ cancellationJournalFile: journalFile });
    const template = cancellationLedger("seed2", "MARKER").entries[0].noOutput.cancellations[0];
    collector.observe({ type: "tool_execution_update", toolCallId: "one", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "one" } } } });
    fs.truncateSync(journalFile, 0);
    assert.throws(() => collector.observe({ type: "tool_execution_update", toolCallId: "two", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "two" } } } }), /JOURNAL.*INTEGRITY|ACTION_EVIDENCE/i);
    const conflictCollector = new ActionEvidenceCollector({ cancellationJournalFile: path.join(TEMP_ROOT, "conflict-journal.jsonl") });
    conflictCollector.observe({ type: "tool_execution_update", toolCallId: "conflict", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "same-invocation", partialLog: "FIRST" } } } });
    assert.throws(() => conflictCollector.observe({ type: "tool_execution_update", toolCallId: "conflict", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "same-invocation", partialLog: "CONFLICT" } } } }), /CANCELLATION_CONFLICT/);
    assert.equal(conflictCollector.cancellationJournalFd, undefined);

    const sameLengthFile = path.join(TEMP_ROOT, "same-length-journal.jsonl");
    const sameLengthCollector = new ActionEvidenceCollector({ cancellationJournalFile: sameLengthFile });
    sameLengthCollector.observe({ type: "tool_execution_update", toolCallId: "same", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "same", partialLog: "SEALED_MARKER_A" } } } });
    const originalJournal = fs.readFileSync(sameLengthFile, "utf8");
    fs.writeFileSync(sameLengthFile, originalJournal.replace("SEALED_MARKER_A", "SEALED_MARKER_B"));
    assert.throws(() => sameLengthCollector.finalize(), /JOURNAL.*INTEGRITY|hash chain/i);
    assert.equal(sameLengthCollector.cancellationJournalFd, undefined, "journal descriptor must close on integrity failure");

    const helperSource = fs.readFileSync(path.join(ROOT, "src", "no-output-test-supervisor.cjs"), "utf8");
    assert.doesNotMatch(helperSource, /options\["command-id"\]\.replace\(/,
      "artifact filenames must use a fixed digest rather than raw command IDs");
    const substrateSource = fs.readFileSync(path.join(ROOT, "src", "substrate.ts"), "utf8");
    const indexSource = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
    assert.match(substrateSource, /collectorFailure|ACTION_EVIDENCE_PERSISTENCE/);
    assert.match(indexSource, /collectorFailure|ACTION_EVIDENCE_PERSISTENCE/);
  },
  async retention() {
    const first = cancellationLedger("cancel-a", "MARKER_A");
    const second = cancellationLedger("cancel-b", "MARKER_B");
    const merged = mergeActionEvidenceLedgers(first, second);
    assert.deepEqual(merged.cancellations.map((entry) => entry.toolCallId).sort(), ["cancel-a", "cancel-b"],
      "every cancellation must retain a compact record and artifact reference outside droppable inline entries");
    assert.ok(merged.cancellations.every((entry) => entry.artifactPath), "artifact references must survive inline omission");
    assert.ok(Buffer.byteLength(JSON.stringify(merged), "utf8") <= merged.serializedSizeLimitBytes);

    const journalFile = path.join(TEMP_ROOT, "host-cancellations.jsonl");
    const collector = new ActionEvidenceCollector({ cancellationJournalFile: journalFile });
    const template = first.entries[0].noOutput.cancellations[0];
    for (let index = 0; index < 201; index += 1) {
      collector.observe({
        type: "tool_execution_update", toolCallId: `tool-${index}`, toolName: "bash",
        partialResult: { details: { noOutputCancellation: {
          ...template,
          invocationId: `invocation-${index}-認証`,
          artifactPath: path.join(TEMP_ROOT, `very-long-${"路".repeat(80)}-${index}.json`),
        } } },
      });
    }
    collector.observe({ type: "tool_execution_start", toolCallId: "tampered-final", toolName: "bash", args: { command: "node trusted.cjs" } });
    collector.observe({ type: "tool_execution_update", toolCallId: "tampered-final", toolName: "bash", partialResult: { details: { noOutputCancellation: { ...template, invocationId: "tampered-invocation", partialLog: "SEALED_HOST_MARKER" } } } });
    collector.observe({ type: "tool_execution_end", toolCallId: "tampered-final", toolName: "bash", isError: false, result: { details: {} } });
    const journaled = collector.finalize();
    assert.equal(journaled.entries.find((entry) => entry.toolCallId === "tampered-final").outcome, "cancelled_no_output");
    assert.match(journaled.entries.find((entry) => entry.toolCallId === "tampered-final").noOutput.partialLog, /SEALED_HOST_MARKER/);
    assert.equal(journaled.cancellationJournals[0].count, 202);
    assert.equal(journaled.omittedCancellationIndexRecords, 201);
    assert.ok(Buffer.byteLength(JSON.stringify(journaled), "utf8") <= journaled.serializedSizeLimitBytes);
    const journalText = fs.readFileSync(journalFile, "utf8");
    assert.match(journalText, /invocation-200-認証/);
    assert.match(journalText, new RegExp(`very-long-${"路".repeat(80)}-200\\.json`));
    const journalLines = journalText.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(journalLines.at(-1).digest, journaled.cancellationJournals[0].finalDigest);
    assert.equal(journalLines[200].previousDigest, journalLines[199].digest);
  },
  async redaction() {
    const giant = `{"password":"${"q".repeat(70000)}"}`;
    for (const value of [
      giant,
      "https://url-user:url-pass@example.test/path",
      "TOKEN = whitespace secret value; echo ok",
      "Bearer standalone-token-value",
      "Authorization: Bearer header-token-value",
      String.raw`env PASSWORD=escaped\ secret\ suffix TOKEN=plain-token node`,
      `export "PASSWORD=quoted secret with spaces" --api-key='cli quoted secret'`,
    ]) {
      const redacted = redactCompleteText(value);
      assert.doesNotMatch(redacted, /q{128}|url-user|url-pass|whitespace secret|standalone-token|header-token|escaped\\ secret|plain-token|quoted secret|cli quoted/);
      assert.match(redacted, /\[REDACTED\]/);
    }
    const quotedAssignment = redactCompleteText(`export "PASSWORD=fixture secret with spaces"; echo ok`);
    for (const segment of ["fixture", "secret", "with", "spaces"]) assert.doesNotMatch(quotedAssignment, new RegExp(segment));
    const colonAssignment = redactCompleteText("password: colon-secret-value");
    for (const segment of ["colon", "secret", "value"]) assert.doesNotMatch(colonAssignment, new RegExp(segment));
    assert.equal(
      redactCompleteText(String.raw`env PASSWORD=fixture\ secret\ suffix node pass.cjs`),
      "env PASSWORD=[REDACTED] node pass.cjs",
      "escaped whitespace assignment must preserve no secret suffix",
    );
    for (const value of [
      `PASSWORD="prefix-segment"'suffix-segment'`,
      `PASSWORD=prefix" space-suffix"`,
    ]) {
      for (let splitAt = 1; splitAt < Buffer.byteLength(value, "utf8"); splitAt += 1) {
        const bytes = Buffer.from(value, "utf8");
        const lexer = new StreamingSecretRedactor();
        const redacted = lexer.push(bytes.subarray(0, splitAt)) + lexer.push(bytes.subarray(splitAt)) + lexer.finish();
        for (const segment of ["prefix", "segment", "suffix", "space"]) assert.doesNotMatch(redacted, new RegExp(segment), `${value} split=${splitAt} leaked ${segment}`);
      }
    }
    const bytes = Buffer.from("API_TOKEN=multibyte-secret🙂認証");
    const stream = new StreamingSecretRedactor();
    const split = stream.push(bytes.subarray(0, 11)) + stream.push(bytes.subarray(11, 24)) + stream.push(bytes.subarray(24)) + stream.finish();
    assert.doesNotMatch(split, /multibyte-secret|🙂|認証/);
    const benign = "x".repeat(100000);
    const started = performance.now();
    assert.equal(redactCompleteText(benign), benign);
    assert.ok(performance.now() - started < 20, "100k benign streaming redaction must retain the linear fast path");
  },
  async "fresh-bounds"() {
    const eventDir = path.join(TEMP_ROOT, "global-budget-events");
    fs.mkdirSync(eventDir, { recursive: true });
    const payload = Array.from({ length: 500 }, (_, sequence) => JSON.stringify({ schemaVersion: 1, commandId: "c", invocationId: "i", sequence, wallTime: "w", type: "noise", auth: "a", padding: "x".repeat(900) })).join("\n") + "\n";
    for (let index = 0; index < 3; index += 1) fs.writeFileSync(path.join(eventDir, `${index}.jsonl`), payload);
    const reader = new monitor.EventReader(eventDir);
    let totalEvents = reader.poll().length;
    assert.ok(reader.eventBytesRead <= 256 * 1024, `global poll budget exceeded: ${reader.eventBytesRead}`);
    while (reader.hasPending()) {
      const beforeFinal = reader.eventBytesRead;
      totalEvents += reader.poll(true).length;
      assert.ok(reader.eventBytesRead - beforeFinal <= 256 * 1024, `settlement poll budget exceeded: ${reader.eventBytesRead - beforeFinal}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(totalEvents, 1500, "bounded yielding settlement drain must be lossless");

    const collector = new ActionEvidenceCollector();
    for (let index = 0; index < 500; index += 1) {
      collector.observe({ type: "tool_execution_start", toolCallId: `a-${index}`, toolName: "bash", args: { command: "true" } });
      collector.observe({ type: "tool_execution_end", toolCallId: `a-${index}`, toolName: "bash", isError: false, result: { details: { exitCode: 0 } } });
    }
    assert.ok(collector.entries.length <= 200, `live collector retained ${collector.entries.length} terminal entries`);
    assert.equal(collector.finalize().totalCompletedEntries, 500);

    const pendingJournal = path.join(TEMP_ROOT, "pending-large-journal.jsonl");
    const pendingCollector = new ActionEvidenceCollector({ cancellationJournalFile: pendingJournal });
    const pendingTemplate = cancellationLedger("pending-seed", "PENDING").entries[0].noOutput.cancellations[0];
    for (let index = 0; index < 500; index += 1) {
      pendingCollector.observe({ type: "tool_execution_update", toolCallId: `pending-${index}`, toolName: "bash", partialResult: { details: { noOutputCancellation: { ...pendingTemplate, invocationId: `pending-invocation-${index}`, partialLog: "L".repeat(64 * 1024) } } } });
    }
    assert.ok(pendingCollector.sealedPreviewBytes <= 256 * 1024, `pending preview cache retained ${pendingCollector.sealedPreviewBytes} bytes`);
    assert.equal(pendingCollector.finalize().cancellationJournals[0].count, 500);

    const huge = new ActionEvidenceCollector();
    const command = "PASSWORD=url-secret-value " + "a".repeat(2_000_345 - "PASSWORD=url-secret-value ".length);
    let started = performance.now();
    huge.observe({ type: "tool_execution_start", toolCallId: "huge", toolName: "bash", args: { command } });
    huge.observe({ type: "tool_execution_end", toolCallId: "huge", toolName: "bash", isError: false, result: { details: { exitCode: 0 } } });
    huge.finalize();
    assert.ok(performance.now() - started < 1250, "exact 2,000,345-character evidence path exceeded 1,250 ms");
    started = performance.now();
    redactCompleteText(`${"a".repeat(100000)}=`);
    assert.ok(performance.now() - started < 100, "100k benign-plus-equals redaction exceeded 100 ms");
    const punctuation = "a=".repeat(1_000_173).slice(0, 2_000_345);
    const punctuationCollector = new ActionEvidenceCollector();
    started = performance.now();
    punctuationCollector.observe({ type: "tool_execution_start", toolCallId: "punctuation", toolName: "bash", args: { command: punctuation } });
    punctuationCollector.observe({ type: "tool_execution_end", toolCallId: "punctuation", toolName: "bash", isError: false, result: { details: { exitCode: 0 } } });
    punctuationCollector.finalize();
    assert.ok(performance.now() - started < 1250, "repeated-a= 2,000,345-character production collector exceeded 1,250 ms");
  },
  async "bounded-io"() {
    const budgetDir = path.join(TEMP_ROOT, "review-budget-hook");
    fs.mkdirSync(budgetDir, { recursive: true });
    const transport = new FixtureSegmentProducer(budgetDir, "review-budget", "review-budget-command", "f".repeat(64));
    const budgetReader = new monitor.EventReader(budgetDir);
    for (let index = 0; index < 100; index += 1) transport.publish({ type: "review-budget", index, payload: "b".repeat(256) });
    transport.sealCurrent();
    while (budgetReader.hasPending()) { budgetReader.poll(); await new Promise((resolve) => setImmediate(resolve)); }
    const transportStats = transport.stats();
    assertItem3InvocationBudget({
      peakDiskBytes: transportStats.peakBytes,
      peakFiles: transportStats.peakFiles,
      peakCounterBytes: 0,
      peakFileObservationBytes: 0,
      peakEventBytes: transportStats.peakBytes,
      peakControlBytes: 0,
      peakTerminalBytes: 0,
      maxQueuedBytes: 0,
      maxInFlight: 0,
      maxPollBytes: budgetReader.maxPollBytes,
    }, "review-budget-hook");

    const eventDir = path.join(TEMP_ROOT, "utf8-events");
    fs.mkdirSync(eventDir, { recursive: true });
    const eventFile = path.join(eventDir, "utf8.jsonl");
    const serialized = Buffer.from(`${JSON.stringify({ schemaVersion: 1, commandId: "c", invocationId: "i", sequence: 1, wallTime: "w", type: "invocation_terminal", auth: "a", marker: "🙂認証" })}\n`, "utf8");
    const emoji = serialized.indexOf(Buffer.from("🙂", "utf8"));
    fs.writeFileSync(eventFile, serialized.subarray(0, emoji + 2));
    const reader = new monitor.EventReader(eventDir);
    assert.deepEqual(reader.poll(), []);
    fs.appendFileSync(eventFile, serialized.subarray(emoji + 2));
    assert.equal(reader.poll()[0].marker, "🙂認証", "split UTF-8 bytes must survive streaming event decoding");
    const source = fs.readFileSync(path.join(ROOT, "src", "worker-no-output-monitor.ts"), "utf8");
    assert.doesNotMatch(source, /readFileSync\(file\)\.subarray|const acceptedEvents:\s*SupervisorEvent\[\]|invocationState\s*=\s*new Map/,
      "event ingestion must be incremental and terminal state bounded");
    assert.doesNotMatch(source, /readFileSync\(file\)[\s\S]{0,120}subarray\(Math\.max/,
      "output-file tails must not read complete files");
    const supervisorSource = fs.readFileSync(path.join(ROOT, "src", "no-output-test-supervisor.cjs"), "utf8");
    const liveSection = supervisorSource.slice(supervisorSource.indexOf("async function supervise"), supervisorSource.indexOf("const settlement = await"));
    assert.doesNotMatch(liveSection, /fs\.openSync\([^\n]*output|ContractFileObserver|register_file|sample_file/,
      "approved design forbids monitor-owned file handles/content reads while the test is live");
    const captureSection = supervisorSource.slice(supervisorSource.indexOf("function captureDeclaredFilesAfterSettlement"), supervisorSource.indexOf("async function supervise"));
    assert.match(captureSection, /finally\s*\{[^}]*fs\.closeSync/s,
      "post-settlement transient capture handles must close in finally");
    assert.match(captureSection, /historicalContent:\s*"not_retained_during_execution"/);
  },
};

(async () => {
  const selected = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : undefined;
  const entries = selected ? [[selected, cases[selected]]] : Object.entries(cases);
  if (selected && !cases[selected]) throw new Error(`unknown case: ${selected}`);
  for (const [name, run] of entries) {
    await run();
    console.log(`PASS item3 review regression ${name}`);
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
