#!/usr/bin/env node
/** Fresh-review regressions for durable capture, terminal fitting, and producer/read budgets. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-fresh3-"));
for (const [key, name] of Object.entries({
  PI_CODING_AGENT_DIR: "agent",
  PI_ORCHESTRATOR_RUNS_ROOT: "runs",
  PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next",
})) {
  process.env[key] = path.join(TEMP_ROOT, name);
  fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_OFFLINE = "1";

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
const monitor = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
const supervisor = require(path.join(ROOT, "src", "no-output-test-supervisor.cjs"));
const { assertItem3InvocationBudget, assertItem3ProducerBudget } = require("./fixtures/item3-budget-assertions.cjs");
const { CommandTelemetryOwner } = require("../src/command-telemetry-owner.cjs");
const { FixtureSegmentProducer } = require("./fixtures/item3-segment-producer.cjs");

function ownerProducerAccounting(accounting) {
  return {
    peakDiskBytes: Number(accounting.maxRetainedBytes) || Number(accounting.retainedBytes) || 0,
    peakFiles: Number(accounting.maxRetainedFiles) || Number(accounting.retainedGenerations) || 0,
    peakReservedBytes: Number(accounting.maxOutstandingBytes) || 0,
    peakEventBytes: 0,
    peakControlBytes: 0,
    peakTerminalBytes: Number(accounting.retainedBytes) || 0,
  };
}

function authorization(cwd, script, source) {
  const body = {
    schemaVersion: 1,
    authority: "run-admission-owner-task",
    workspaceRealPath: fs.realpathSync(cwd),
    existingEntrypoints: [{
      path: fs.realpathSync(script),
      bytes: fs.statSync(script).size,
      sha256: crypto.createHash("sha256").update(source).digest("hex"),
    }],
    approvedDynamicScopes: [],
    allowedNodeOptions: [],
  };
  const value = { ...body, policyHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  const file = path.join(cwd, "authorization.json");
  const bytes = Buffer.from(JSON.stringify(value));
  fs.writeFileSync(file, bytes);
  return { file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

async function runSupervisor(name, source, outputContents) {
  const cwd = path.join(TEMP_ROOT, name);
  fs.mkdirSync(cwd, { recursive: true });
  const script = path.join(cwd, "test.cjs");
  const output = path.join(cwd, "output.log");
  fs.writeFileSync(script, source);
  if (outputContents !== undefined) fs.writeFileSync(output, outputContents);
  const auth = authorization(cwd, script, source);
  const events = path.join(cwd, "events");
  const evidence = path.join(cwd, "evidence");
  const owner = new CommandTelemetryOwner({ commandRoot: path.join(cwd, "owner"), evidenceDirectory: events, commandId: `${name}-${"識".repeat(512)}` });
  await owner.start();
  const child = spawn(process.execPath, [
    path.join(ROOT, "src", "no-output-test-supervisor.cjs"),
    "--event-dir", events,
    "--evidence-root", evidence,
    "--command-id", `${name}-${"識".repeat(512)}`,
    "--policy", "{}",
    "--authorization-file", auth.file,
    "--authorization-sha256", auth.sha256,
    "--io-observer", path.join(ROOT, "src", "no-output-io-observer.cjs"),
    "--host-managed-capture", "true",
    "--owner-config", JSON.stringify(owner.configuration()),
    "--", script, "--outputFile", output,
  ], {
    cwd,
    env: { ...process.env, PI_ORC_NO_OUTPUT_AUTH: "c".repeat(64) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const published = owner.drainEvents();
  const terminals = [];
  const captureBudget = new monitor.SharedReadBudget(256 * 1024, owner);
  const captureReader = new monitor.EventReader(events, captureBudget);
  for (const terminal of published.filter((event) => event.type === "invocation_terminal")) {
    const request = published.find((event) => event.type === "declared_file_capture_request" && event.invocationId === terminal.invocationId);
    if (request) {
      captureBudget.beginCycle();
      const capture = monitor.captureSettledFilesWithSharedCredits(
        request.specs, request.workspaceRealPath, captureReader, request.maxTotalBytes,
      );
      captureBudget.finalizeCycle();
      assert.ok(capture, "production shared owner must admit the finite post-settlement capture");
      terminal.declaredFileCapture = capture;
      assert.equal(owner.commitHostEvidence(terminal.invocationId, terminal), true,
        "enriched capture must commit through the production owner before it is called durable");
    }
    const committed = owner.acquireCommitted(terminal.invocationId);
    assert.ok(committed, "durable terminal generation must remain available to its consumer");
    terminals.push(JSON.parse(committed.bytes.toString("utf8")));
    owner.releaseReader(committed.leaseId);
  }
  const ownerAccounting = owner.accounting();
  await owner.close();
  return { code, stderr, terminals, ownerAccounting };
}

async function captureRedaction() {
  const secret = "synthetic_capture_secret_123";
  const secretResult = await runSupervisor(
    "capture-secret",
    "// output is prepared by the finite parent fixture\n",
    `HEAD_MARKER\nPASSWORD=${secret}\nHANGING_CAPTURE_TAIL_MARKER\n`,
  );
  assert.equal(secretResult.code, 0, secretResult.stderr);
  assert.equal(secretResult.terminals.length, 1);
  const durable = JSON.stringify(secretResult.terminals[0]);
  assert.doesNotMatch(durable, new RegExp(secret));
  assert.match(durable, /\[REDACTED\]/);
  assert.match(durable, /HANGING_CAPTURE_TAIL_MARKER/);
  assertItem3ProducerBudget(ownerProducerAccounting(secretResult.ownerAccounting), "capture-secret", secretResult.terminals[0].sharedReadAccounting);

  const splitRoot = path.join(TEMP_ROOT, "capture-split");
  fs.mkdirSync(splitRoot, { recursive: true });
  const splitFile = path.join(splitRoot, "split.log");
  const splitSecret = "synthetic_discontinuous_secret_456";
  const head = `${"H".repeat(53)}\nPASSWORD=`;
  const tail = `${splitSecret}\nDISCONTINUOUS_SAFE_TAIL_MARKER\n`;
  fs.writeFileSync(splitFile, `${head}${"M".repeat(256)}${tail}`);
  const parent = fs.lstatSync(splitRoot, { bigint: true });
  const splitCapture = supervisor.captureDeclaredFilesAfterSettlement([{
    path: splitFile,
    parentRealPath: fs.realpathSync(splitRoot),
    parentDevice: parent.dev.toString(),
    parentInode: parent.ino.toString(),
  }], fs.realpathSync(splitRoot), 128);
  const splitDurable = JSON.stringify(splitCapture);
  assert.doesNotMatch(splitDurable, new RegExp(splitSecret));
  assert.match(splitDurable, /DISCONTINUOUS_SAFE_TAIL_MARKER/);

  for (const [name, separator, secretLine, marker] of [
    ["quoted-space", "\n", 'LEAK_SEGMENT_ALPHA LEAK_SEGMENT_BETA"', "SAFE_QUOTED_TAIL_MARKER"],
    ["concatenated", "\n", `LEAK_UNQUOTED"'LEAK_QUOTED'LEAK_SUFFIX`, "SAFE_CONCATENATED_TAIL_MARKER"],
    ["crlf-unicode", "\r\n", '秘密🙂 LEAK_UNICODE_BETA"', "SAFE_CRLF_UNICODE_MARKER"],
  ]) {
    const boundaryFile = path.join(splitRoot, `${name}.log`);
    const boundaryTail = `${secretLine}${separator}${marker}${separator}`;
    fs.writeFileSync(boundaryFile, `PASSWORD="${"M".repeat(512)}${boundaryTail}`);
    const captured = supervisor.captureDeclaredFilesAfterSettlement([{
      path: boundaryFile,
      parentRealPath: fs.realpathSync(splitRoot),
      parentDevice: parent.dev.toString(),
      parentInode: parent.ino.toString(),
    }], fs.realpathSync(splitRoot), 128);
    const retained = JSON.stringify(captured);
    for (const leaked of ["LEAK_SEGMENT_ALPHA", "LEAK_SEGMENT_BETA", "LEAK_UNQUOTED", "LEAK_QUOTED", "LEAK_SUFFIX", "LEAK_UNICODE_BETA", "秘密", "🙂"]) {
      if (secretLine.includes(leaked)) assert.doesNotMatch(retained, new RegExp(leaked), `${name} leaked ${leaked}`);
    }
    assert.match(retained, new RegExp(marker), `${name} lost safely separated useful output`);
  }

  for (const [name, continuation, marker] of [
    ["multiline-double", 'FIRST_SECRET_LINE\nSYNTHETIC_MULTILINE_SECRET"\n', "SAFE_MULTILINE_DOUBLE_MARKER"],
    ["multiline-single", "FIRST_SECRET_LINE\r\nSYNTHETIC_SINGLE_SECRET'\r\n", "SAFE_MULTILINE_SINGLE_MARKER"],
    ["multiline-escaped", 'FIRST_SECRET_LINE\\\nSYNTHETIC_ESCAPED_SECRET"\n', "SAFE_MULTILINE_ESCAPED_MARKER"],
    ["multiline-mixed", 'FIRST_SECRET_LINE\nSYNTHETIC_DOUBLE_SECRET"\'SYNTHETIC_SINGLE_SECRET\'\n', "SAFE_MULTILINE_MIXED_MARKER"],
    ["multiline-utf8", '第一秘密行🙂\nSYNTHETIC_UTF8_SECRET認証"\n', "SAFE_MULTILINE_UTF8_MARKER"],
  ]) {
    const file = path.join(splitRoot, `${name}.log`);
    const opener = name === "multiline-single" ? "PASSWORD='" : 'PASSWORD="';
    fs.writeFileSync(file, opener + "M".repeat(512) + continuation + marker + "\n");
    const captured = supervisor.captureDeclaredFilesAfterSettlement([{
      path: file,
      parentRealPath: fs.realpathSync(splitRoot),
      parentDevice: parent.dev.toString(),
      parentInode: parent.ino.toString(),
    }], fs.realpathSync(splitRoot), 256);
    const retained = JSON.stringify(captured);
    assert.doesNotMatch(retained, /FIRST_SECRET_LINE|SYNTHETIC_|第一秘密行|認証|🙂/, `${name} leaked a multiline continuation`);
    assert.match(retained, new RegExp(marker), `${name} lost safely separated useful output`);
  }

  const beyondScan = path.join(splitRoot, "beyond-state-scan.log");
  fs.writeFileSync(beyondScan, `PASSWORD="${"M".repeat(210 * 1024)}SYNTHETIC_BEYOND_SCAN_SECRET"\nSAFE_BEYOND_SCAN_MARKER\n`);
  const beyond = supervisor.captureDeclaredFilesAfterSettlement([{
    path: beyondScan,
    parentRealPath: fs.realpathSync(splitRoot),
    parentDevice: parent.dev.toString(),
    parentInode: parent.ino.toString(),
  }], fs.realpathSync(splitRoot), 256);
  const beyondRetained = JSON.stringify(beyond);
  assert.equal(beyond.results[0].lexicalStateScanComplete, false);
  assert.doesNotMatch(beyondRetained, /SYNTHETIC_BEYOND_SCAN_SECRET/);
  assert.doesNotMatch(beyondRetained, /SAFE_BEYOND_SCAN_MARKER/,
    "content beyond the bounded lexical-state scan must not be guessed safe");
  assert.match(beyondRetained, /tail unavailable: complete lexical-state scan exceeded bounded read budget/);

}

async function durableBoundaryCapture() {
  const durableSuffix = 'FIRST_DURABLE_SECRET_LINE\r\nLEAK_DURABLE_ALPHA LEAK_DURABLE_BETA"\r\nSAFE_DURABLE_OUTPUT\r\n' + "B".repeat(30_000) + "\nUSEFUL_DURABLE_FINAL_MARKER\n";
  const durableTail = "X".repeat(32_768 - Buffer.byteLength(durableSuffix)) + durableSuffix;
  const durableBoundary = await runSupervisor(
    "capture-discontinuous-quoted",
    `require('node:fs').writeFileSync(process.argv[3], 'PASSWORD="' + 'M'.repeat(100000) + ${JSON.stringify(durableTail)});\n`,
  );
  assert.equal(durableBoundary.code, 0, durableBoundary.stderr);
  assert.equal(durableBoundary.terminals.length, 1);
  const durableBoundaryText = JSON.stringify(durableBoundary.terminals[0]);
  assert.doesNotMatch(durableBoundaryText, /FIRST_DURABLE_SECRET_LINE|LEAK_DURABLE_ALPHA|LEAK_DURABLE_BETA/);
  assert.match(durableBoundaryText, /SAFE_DURABLE_OUTPUT/);
  assert.match(durableBoundaryText, /USEFUL_DURABLE_FINAL_MARKER/);
}

async function terminalFitting() {
  const escaped = await runSupervisor(
    "capture-control-bytes",
    "// output is prepared by the finite parent fixture\n",
    Buffer.alloc(65_536, 1),
  );
  assert.equal(escaped.code, 0, escaped.stderr);
  assert.equal(escaped.terminals.length, 1, "valid capture must not erase the natural terminal outcome");
  assert.equal(escaped.terminals[0].outcome, "succeeded");
  assert.equal(escaped.terminals[0].commandId, `capture-control-bytes-${"識".repeat(512)}`);
  assert.ok(Buffer.byteLength(JSON.stringify(escaped.terminals[0]) + "\n", "utf8") <= 256 * 1024);
  assert.match(JSON.stringify(escaped.terminals[0].declaredFileCapture), /captured|truncated/);
  assertItem3ProducerBudget(ownerProducerAccounting(escaped.ownerAccounting), "capture-control-bytes", escaped.terminals[0].sharedReadAccounting);

  const failed = await runSupervisor(
    "capture-failing-control-bytes",
    "process.exitCode = 3;\n",
    Buffer.concat([Buffer.alloc(32_768, 1), Buffer.from("FAILURE_CAPTURE_TAIL_MARKER\n")]),
  );
  assert.equal(failed.code, 3, failed.stderr);
  assert.equal(failed.terminals.length, 1);
  assert.equal(failed.terminals[0].outcome, "failed");
  assert.equal(failed.terminals[0].exitCode, 3);
  assert.match(JSON.stringify(failed.terminals[0].declaredFileCapture), /FAILURE_CAPTURE_TAIL_MARKER/);
  assertItem3ProducerBudget(ownerProducerAccounting(failed.ownerAccounting), "capture-failing-control-bytes", failed.terminals[0].sharedReadAccounting);
}

function producerReservations() {
  assert.throws(() => assertItem3InvocationBudget({
    peakDiskBytes: 0, peakFiles: 1, peakCounterBytes: 0, peakFileObservationBytes: 0,
    peakEventBytes: 512 * 1024 + 1, peakControlBytes: 0, peakTerminalBytes: 0,
    maxQueuedBytes: 0, maxInFlight: 0, maxPollBytes: 0,
  }, "causal-overbudget-control"), /event peak/,
  "one overbudget invocation must fail through the shared assertion hook");
  for (const [channel, frameSize, count] of [["ordinary", 65_536, 8], ["control", 4_096, 16]]) {
    const directory = path.join(TEMP_ROOT, `producer-${channel}`);
    fs.mkdirSync(directory, { recursive: true });
    const transport = new FixtureSegmentProducer(directory, `${channel}-invocation`, "command", "a".repeat(64));
    let rejected = false;
    for (let index = 0; index < count; index += 1) {
      const base = {
        schemaVersion: 1, commandId: "command", invocationId: `${channel}-invocation`, sequence: index + 1,
        wallTime: new Date().toISOString(), type: "finite-probe", padding: "", auth: "a".repeat(64),
      };
      const padding = "x".repeat(frameSize - Buffer.byteLength(JSON.stringify(base) + "\n"));
      try { transport.publish({ type: "finite-probe", padding }, channel); }
      catch (error) { assert.match(String(error?.message), /BACKPRESSURE|CAPACITY|RESERVATION/); rejected = true; break; }
    }
    if (channel === "ordinary") transport.sealCurrent(); else transport.sealControl();
    const stats = transport.stats();
    assert.equal(rejected, true, `${channel} producer admitted frames beyond its complete serialized budget`);
    assert.ok(stats.peakReservedBytes > stats.peakBytes,
      `${channel} regression must measure simultaneous producer staging plus retained files, not only a post-response scan`);
    assertItem3InvocationBudget({
      peakDiskBytes: stats.peakBytes,
      peakFiles: stats.peakFiles,
      peakCounterBytes: 0,
      peakFileObservationBytes: 0,
      peakEventBytes: stats.peakEventBytes,
      peakControlBytes: stats.peakControlBytes,
      peakTerminalBytes: stats.peakTerminalBytes,
      maxQueuedBytes: 0,
      maxInFlight: 0,
      maxPollBytes: 0,
      peakReservedBytes: stats.peakReservedBytes,
    }, `${channel}-reservation`);
  }
}

async function runFiniteFixture(relative, args = []) {
  const child = spawn(process.execPath, [path.join(ROOT, relative), ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr || stdout);
  return stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
}

async function reservationMetadataCredits() {
  const result = JSON.parse(await runFiniteFixture("tests/fixtures/item3-publication-credit-probe.cjs", ["metadata"]));
  assert.ok(result.supervisorCombined <= 256 * 1024);
  assert.ok(result.hostCombined <= 256 * 1024);
}

async function replacementFailureRetention() {
  const result = JSON.parse(await runFiniteFixture("tests/fixtures/item3-publication-credit-probe.cjs", ["replacement"]));
  assert.equal(result.terminalRetained, true);
  assert.equal(result.independentCounterPathAbsent, true);
}

async function boundedArtifactReadRace() {
  const child = spawn(process.execPath, [path.join(ROOT, "tests", "fixtures", "item3-read-credit-race.cjs")], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr || stdout);
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.ok(result.growthActualReadBytes <= 256 * 1024);
  assert.ok(result.growthActualReadBytes <= result.growthReservedBytes);
  assert.equal(result.replacementRejected, true);
  assert.equal(result.shortReadRejected, true);
  assert.equal(result.symlinkRejected, true);
}

function corruptArtifactFallback() {
  const root = path.join(TEMP_ROOT, "corrupt-artifact-fallback");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "artifact.json");
  const artifact = {
    schemaVersion: 1,
    outcome: "cancelled_no_output",
    commandId: "artifact-command",
    invocationId: "artifact-invocation",
    summary: "Cancelled after silence.",
    noOutputMs: 600000,
    totalElapsedMs: 700000,
    alarmMonotonicMs: 1,
    alarmAcknowledgedMonotonicMs: 2,
    cancelledMonotonicMs: 3,
    cancellationRequested: true,
    cancellationAccepted: true,
    cancellationConfirmed: true,
    confirmationBasis: "terminal_signal_after_owned_handle_action",
    terminalExitCode: null,
    terminalSignal: "SIGTERM",
    cancellationTarget: "retained-direct-test-child-handle",
    eligibility: "authenticated_run_owned_test_child",
    observedSources: ["stdout"],
    observationErrors: [],
    partialLog: "MUTABLE_ARTIFACT_CONTENT",
  };
  const original = Buffer.from(`${JSON.stringify(artifact)}\n`);
  fs.writeFileSync(file, original);
  const expectedSha = crypto.createHash("sha256").update(original).digest("hex");
  fs.writeFileSync(file, Buffer.from(original.toString("utf8").replace("MUTABLE_ARTIFACT_CONTENT", "TAMPERED_ARTIFACT_VALUE_")));
  const budget = new monitor.SharedReadBudget();
  const reader = new monitor.EventReader(root, budget);
  budget.beginCycle();
  const loaded = monitor.loadArtifact(file, root, artifact.commandId, artifact.invocationId, expectedSha, original.length, reader);
  assert.equal(loaded.retry, false);
  assert.equal(loaded.artifact, undefined, "same-path mutable artifact must not verify against its sealed digest");
  const fallback = monitor.selectCancellationPartialLog({
    partialLogHead: "CANONICAL_TERMINAL_HEAD",
    partialLogTail: "CANONICAL_TERMINAL_TAIL_MARKER",
  }, loaded.artifact);
  assert.match(fallback, /CANONICAL_TERMINAL_HEAD/);
  assert.match(fallback, /CANONICAL_TERMINAL_TAIL_MARKER/);
  assert.doesNotMatch(fallback, /TAMPERED_ARTIFACT/);
}

function sharedReadCredits() {
  assert.equal(typeof monitor.SharedReadBudget, "function", "production shared read-credit mechanism must be exported for finite path instrumentation");
  const budget = new monitor.SharedReadBudget(256 * 1024);
  budget.beginCycle();
  assert.equal(budget.reserveBeforeRead(128 * 1024, "events"), 128 * 1024);
  assert.equal(budget.reserveBeforeRead(64 * 1024, "artifact"), 64 * 1024);
  assert.equal(budget.reserveBeforeRead(64 * 1024, "capture"), 64 * 1024);
  assert.equal(budget.reserveBeforeRead(1, "mailbox"), 0, "all source classes must share one finite cycle");
  const accounting = budget.accounting();
  assert.equal(accounting.currentCycleBytes, 256 * 1024);
  assert.equal(accounting.maxCycleBytes, 256 * 1024);
  assert.deepEqual(Object.keys(accounting.sourceBytes).sort(), ["artifact", "capture", "events"]);
}

const cases = {
  capture: captureRedaction,
  "capture-durable-boundary": durableBoundaryCapture,
  terminal: terminalFitting,
  producer: producerReservations,
  reads: sharedReadCredits,
  "read-race": boundedArtifactReadRace,
  "artifact-fallback": corruptArtifactFallback,
  "reservation-metadata": reservationMetadataCredits,
  "replacement-failure": replacementFailureRetention,
};

(async () => {
  const selected = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : undefined;
  const entries = selected ? [[selected, cases[selected]]] : Object.entries(cases);
  if (selected && !cases[selected]) throw new Error(`unknown fresh3 case: ${selected}`);
  for (const [name, run] of entries) {
    await run();
    console.log(`PASS item3 fresh3 ${name}`);
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
