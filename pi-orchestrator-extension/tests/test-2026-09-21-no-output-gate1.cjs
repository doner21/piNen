#!/usr/bin/env node
/** Gate-1 causal regressions for bounded telemetry and non-interfering Windows observation. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Writable } = require("node:stream");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-gate1-"));
const AGENT_DIR = path.join(TEMP_ROOT, "agent");
const RUNS_ROOT = path.join(TEMP_ROOT, "runs");
const NEXT_RUNS_ROOT = path.join(TEMP_ROOT, "next-runs");
for (const directory of [AGENT_DIR, RUNS_ROOT, NEXT_RUNS_ROOT]) fs.mkdirSync(directory, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_ORCHESTRATOR_RUNS_ROOT = RUNS_ROOT;
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = NEXT_RUNS_ROOT;
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_OFFLINE = "1";
delete process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_READY;

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });

// host-capture-aggregate-actual instrumentation (Blocker B gap[0]): wraps
// node:fs openSync/readSync/closeSync BEFORE the production module below is
// loaded, so the module's own destructured node:fs bindings resolve to these
// wrappers (the same seam tests/fixtures/item3-read-credit-race.cjs uses).
// Tracking only applies to descriptors opened under one case's own root
// (enabled by that case alone, via __captureInstrumentationOwnerRootLower);
// every other gate1 case is an unaffected pass-through.
const __originalFsForCaptureInstrumentation = { openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync };
const __captureInstrumentationTrackedFds = new Set();
let __captureInstrumentationOwnerRootLower = null;
let __captureInstrumentationPhysicalBytes = 0;
let __captureInstrumentationHookHits = 0;
fs.openSync = function gate1InstrumentedOpen(file, ...args) {
  const fd = __originalFsForCaptureInstrumentation.openSync.call(this, file, ...args);
  if (__captureInstrumentationOwnerRootLower && typeof file !== "number") {
    try {
      if (path.resolve(String(file)).toLowerCase().startsWith(__captureInstrumentationOwnerRootLower)) __captureInstrumentationTrackedFds.add(fd);
    } catch {}
  }
  return fd;
};
fs.readSync = function gate1InstrumentedRead(fd, ...args) {
  const read = __originalFsForCaptureInstrumentation.readSync.call(this, fd, ...args);
  if (__captureInstrumentationTrackedFds.has(fd)) { __captureInstrumentationPhysicalBytes += read; __captureInstrumentationHookHits += 1; }
  return read;
};
fs.closeSync = function gate1InstrumentedClose(fd, ...args) {
  const value = __originalFsForCaptureInstrumentation.closeSync.call(this, fd, ...args);
  __captureInstrumentationTrackedFds.delete(fd);
  return value;
};

const { EventReader, SharedReadBudget, WindowsIoCounterService, captureSettledFilesWithSharedCredits } = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
const { CounterSamplingScheduler, captureDeclaredFilesAfterSettlement } = require(path.join(ROOT, "src", "no-output-test-supervisor.cjs"));
const { FixtureSegmentProducer: BoundedEventTransport } = require("./fixtures/item3-segment-producer.cjs");

async function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
}

async function sustainedRetentionGreen() {
  const caseRoot = path.join(TEMP_ROOT, "sustained-retention");
  const eventDir = path.join(caseRoot, "events");
  fs.mkdirSync(eventDir, { recursive: true });
  const output = path.join(caseRoot, "fixture-output.log");
  const fixture = path.join(caseRoot, "protocol-child.cjs");
  fs.writeFileSync(fixture, [
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => { const message = JSON.parse(line); if (message.action === 'write') { fs.appendFileSync(message.path, `WRITE_${message.index}\\n`); console.log(`written:${message.index}`); } });",
    "",
  ].join("\n"));
  const service = new WindowsIoCounterService(eventDir, "9".repeat(64), "sustained-command");
  let child; let acceptedEpochs = 0; let cumulativeTraffic = 0; let peakRetained = 0; let peakFiles = 0; let peakQueued = 0; let writeGrowth = 0;
  const outputLines = [];
  try {
    await service.start();
    const earliestCreationUnixMs = Date.now();
    child = spawn(process.execPath, [fixture], { cwd: caseRoot, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: false });
    child.stdout.setEncoding("utf8");
    let remainder = ""; const lineWaiters = [];
    child.stdout.on("data", (chunk) => { remainder += chunk; const lines = remainder.split(/\r?\n/); remainder = lines.pop() || ""; for (const line of lines) { const waiter = lineWaiters.shift(); if (waiter) waiter(line); else outputLines.push(line); } });
    const nextLine = () => outputLines.length ? Promise.resolve(outputLines.shift()) : new Promise((resolve) => lineWaiters.push(resolve));
    const latestCreationUnixMs = Date.now();
    const invocationId = "sustained-invocation";
    const transportId = require("node:crypto").createHash("sha256").update(`sustained-command\0${invocationId}`).digest("hex").slice(0, 32);
    const bindingGeneration = "8".repeat(32);
    service.register({ invocationId, transportId, bindingGeneration, pid: child.pid, expectedExecutable: process.execPath, earliestCreationUnixMs, latestCreationUnixMs });
    let state = await service.waitForCounterState(transportId, 0);
    assert.equal(state.type, "counter_registered");
    let generation = Number(state.transportGeneration); let requestGeneration = 0; let priorWriteOperations = 0; let priorWriteTransfer = 0;
    for (let epoch = 1; epoch <= 3000; epoch += 1) {
      if (epoch % 100 === 0) {
        child.stdin.write(`${JSON.stringify({ action: "write", path: output, index: epoch })}\n`);
        assert.equal(await nextLine(), `written:${epoch}`);
      }
      requestGeneration += 1;
      const requestId = requestGeneration.toString(16).padStart(32, "0");
      service.sample({ invocationId, transportId, bindingGeneration, requestGeneration, requestId });
      state = await service.waitForCounterState(transportId, generation);
      assert.equal(state.type, "counter_sample");
      assert.equal(state.requestId, requestId);
      assert.equal(Number(state.requestGeneration), requestGeneration);
      assert.equal(state.bindingGeneration, bindingGeneration);
      assert.ok(Number(state.transportGeneration) > generation);
      generation = Number(state.transportGeneration);
      acceptedEpochs += 1;
      const serialized = Buffer.byteLength(JSON.stringify(state), "utf8");
      cumulativeTraffic += serialized;
      const writeOperations = Number(state.writeOperations); const writeTransfer = Number(state.writeTransfer);
      if (writeOperations > priorWriteOperations || writeTransfer > priorWriteTransfer) writeGrowth += 1;
      priorWriteOperations = writeOperations; priorWriteTransfer = writeTransfer;
      const files = fs.readdirSync(eventDir).map((name) => path.join(eventDir, name));
      peakFiles = Math.max(peakFiles, files.length);
      peakRetained = Math.max(peakRetained, files.reduce((sum, file) => sum + fs.statSync(file).size, 0));
      const queue = service.getTransportStats(); peakQueued = Math.max(peakQueued, queue.queuedBytes, queue.maxQueuedBytes);
    }
    assert.equal(acceptedEpochs, 3000);
    assert.ok(generation > 3000, `publication generations did not advance: ${generation}`);
    assert.ok(writeGrowth >= 30, `fixture writes were not reflected in process counters: ${writeGrowth}`);
    assert.ok(cumulativeTraffic > 50 * 16 * 1024, `cumulative traffic did not cross cap many times: ${cumulativeTraffic}`);
    assert.ok(peakRetained <= 16 * 1024, `retained counter storage did not plateau: ${peakRetained}`);
    assert.ok(peakQueued <= 64 * 1024, `queued/native writable bytes exceeded cap: ${peakQueued}`);
    service.unregister(invocationId);
    child.stdin.end();
    await waitForClose(child);
    await service.close();
  } finally {
    try { service.unregister("sustained-invocation"); } catch {}
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
    if (child) await waitForClose(child);
    try { await service.close(); } catch {}
  }
  console.log(`MEASURE item3 sustained acceptedEpochs=${acceptedEpochs} cumulativeBytes=${cumulativeTraffic} peakRetainedBytes=${peakRetained} peakFiles=${peakFiles} peakQueuedBytes=${peakQueued} writeGrowthEpochs=${writeGrowth}`);
}

async function finiteStorageRed() {
  const caseRoot = path.join(TEMP_ROOT, "finite-storage");
  const eventDir = path.join(caseRoot, "events");
  fs.mkdirSync(eventDir, { recursive: true });
  const fixture = path.join(caseRoot, "natural-child.cjs");
  fs.writeFileSync(fixture, "process.stdin.resume(); process.stdin.on('end', () => {});\n");
  const authKey = "a".repeat(64);
  const commandId = "finite-storage-command";
  let publishedStates = 0; let maxPublishedGeneration = 0;
  const service = new WindowsIoCounterService(eventDir, authKey, commandId, undefined, (_invocationId, state) => {
    publishedStates += 1;
    maxPublishedGeneration = Math.max(maxPublishedGeneration, Number(state.transportGeneration) || 0);
  });
  let child;
  let peakCounterBytes = 0;
  let peakFiles = 0;
  try {
    await service.start();
    const earliestCreationUnixMs = Date.now();
    child = spawn(process.execPath, [fixture], { cwd: caseRoot, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: false });
    const latestCreationUnixMs = Date.now();
    const invocationId = "finite-storage-invocation";
    const transportId = require("node:crypto").createHash("sha256").update(`${commandId}\0${invocationId}`).digest("hex").slice(0, 32);
    const bindingGeneration = "b".repeat(32);
    service.register({
      schemaVersion: 1, commandId, invocationId, transportId, bindingGeneration, sequence: 1,
      wallTime: new Date().toISOString(), type: "counter_registration", auth: "fixture",
      pid: child.pid, expectedExecutable: process.execPath, earliestCreationUnixMs, latestCreationUnixMs,
    });
    for (let index = 0; index < 3000; index += 1) {
      service.sample({ invocationId, transportId, bindingGeneration, requestGeneration: index + 1, requestId: (index + 1).toString(16).padStart(32, "0") });
      if (index % 100 === 99) {
        const files = fs.readdirSync(eventDir).map((name) => path.join(eventDir, name));
        peakFiles = Math.max(peakFiles, files.length);
        peakCounterBytes = Math.max(peakCounterBytes, files.reduce((sum, file) => sum + fs.statSync(file).size, 0));
      }
    }
    const transportStats = service.getTransportStats();
    assert.ok(transportStats.inFlight <= 1, `more than one counter request entered flight: ${transportStats.inFlight}`);
    assert.ok(transportStats.maxQueuedBytes <= 64 * 1024, `counter control queue exceeded 64 KiB: ${transportStats.maxQueuedBytes}`);
    await service.close();
    const files = fs.readdirSync(eventDir).map((name) => path.join(eventDir, name));
    peakFiles = Math.max(peakFiles, files.length);
    peakCounterBytes = Math.max(peakCounterBytes, files.reduce((sum, file) => sum + fs.statSync(file).size, 0));
    assert.ok(publishedStates > 0, "finite counter producer must deliver at least its registered state before natural close");
    assert.ok(maxPublishedGeneration <= 2, "counter responses must not manufacture additional sample requests");
  } finally {
    try { await service.close(); } catch {}
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
    if (child) await waitForClose(child);
  }
  assert.equal(peakCounterBytes, 0, "single-owner counter transport must not create transient counter files");
  assert.equal(peakFiles, 0, "single-owner counter transport must not create transient counter generations");
  assert.ok(peakCounterBytes <= 16 * 1024,
    `counter producer exceeded 16 KiB retained storage under finite load: ${peakCounterBytes}`);
  assert.ok(peakCounterBytes <= 1024 * 1024,
    `aggregate ordinary telemetry exceeded 1 MiB: ${peakCounterBytes}`);
  assert.ok(peakFiles <= 8, `counter transport created unbounded files: ${peakFiles}`);
  console.log(`MEASURE item3 finite-storage peakCounterBytes=${peakCounterBytes} peakFiles=${peakFiles}`);
}

function schedulerGreen() {
  const scheduler = new CounterSamplingScheduler(100);
  assert.equal(scheduler.tick(0, true), 1);
  for (let index = 0; index < 1000; index += 1) assert.equal(scheduler.tick(0, true), undefined,
    "responses/ticks with an outstanding request must never manufacture more requests");
  assert.equal(scheduler.acceptResponse(1), true);
  assert.equal(scheduler.tick(50, true), undefined);
  scheduler.requestFresh(); scheduler.requestFresh(); scheduler.requestFresh();
  assert.equal(scheduler.tick(50, true), 2, "freshness demands must coalesce into one request");
  assert.equal(scheduler.acceptResponse(2), true);
  assert.equal(scheduler.tick(10000, true), 3, "missed opportunities must produce one request, not a catch-up burst");
  assert.equal(scheduler.tick(10000, true), undefined);
}

async function eventReclamationGreen() {
  const eventDir = path.join(TEMP_ROOT, "event-reclamation");
  fs.mkdirSync(eventDir, { recursive: true });
  const transport = new BoundedEventTransport(eventDir, "event-cycle", "event-command", "e".repeat(64));
  const reader = new EventReader(eventDir);
  let observed = 0;
  for (let cycle = 0; cycle < 50; cycle += 1) {
    for (let index = 0; index < 100; index += 1) {
      transport.publish({ type: "ordinary", cycle, index, payload: "z".repeat(900) });
      if (index % 10 === 0) transport.publish({ type: "control", cycle, index, payload: "c".repeat(500) }, "control");
    }
    while (reader.hasPending()) {
      observed += reader.poll().filter((event) => event.type === "ordinary").length;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  transport.sealCurrent();
  while (reader.hasPending()) { observed += reader.poll(true).filter((event) => event.type === "ordinary").length; await new Promise((resolve) => setImmediate(resolve)); }
  const stats = transport.stats();
  assert.equal(observed, 5000);
  assert.ok(stats.cumulativeBytes > 4 * 512 * 1024, `cumulative traffic did not repeatedly cross cap: ${stats.cumulativeBytes}`);
  assert.ok(stats.peakBytes <= 512 * 1024 + 64 * 1024, `event peak exceeded event/control retention: ${stats.peakBytes}`);
  assert.ok(stats.peakFiles <= 18, `event segments/scratch grew without bound: ${stats.peakFiles}`);
}

async function retirementAccountingGreen() {
  const eventDir = path.join(TEMP_ROOT, "retirement-accounting");
  fs.mkdirSync(eventDir, { recursive: true });
  const transport = new BoundedEventTransport(eventDir, "retirement", "retirement-command", "d".repeat(64));
  for (let index = 0; index < 400; index += 1) transport.publish({ type: "retirement", index, payload: "r".repeat(300) });
  transport.sealCurrent();
  const expectedPayloadBytes = transport.stats().cumulativeBytes;
  const reader = new EventReader(eventDir);
  let observed = 0;
  while (reader.hasPending()) {
    observed += reader.poll(true).filter((event) => event.type === "retirement").length;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(observed, 400);
  assert.equal(reader.eventBytesRead, expectedPayloadBytes,
    "retirement accounting must equal bytes actually consumed once, not an inflated denominator");
  assert.ok(reader.eventFileBytes >= reader.eventBytesRead,
    "cumulative retired storage must cover actual one-pass event reads");
  const before = reader.eventBytesRead;
  assert.deepEqual(reader.poll(true), []);
  assert.equal(reader.eventBytesRead, before, "retired files must never be reread to inflate cumulative accounting");
  const shared = reader.sharedBudget.accounting();
  assert.ok(shared.maxActualBytes <= 256 * 1024);
  assert.ok(shared.maxActualBytes <= shared.maxCycleBytes);
}

function terminalDrainRed() {
  const eventDir = path.join(TEMP_ROOT, "terminal-drain");
  fs.mkdirSync(eventDir, { recursive: true });
  const marker = `TERMINAL_HEAD_${"u".repeat(12000)}_TERMINAL_TAIL`;
  fs.writeFileSync(path.join(eventDir, "case.terminal.json"), `${JSON.stringify({ type: "invocation_terminal", marker })}\n`);
  const reader = new EventReader(eventDir);
  let terminal;
  let polls = 0;
  while (reader.hasPending()) {
    const before = reader.eventBytesRead;
    for (const event of reader.poll(true)) if (event.type === "invocation_terminal") terminal = event;
    assert.ok(reader.eventBytesRead > before, "pending terminal envelope made no incremental progress");
    assert.ok(reader.eventBytesRead - before <= 256 * 1024);
    polls += 1;
    assert.ok(polls < 100, "terminal drain busy-spun without completion");
  }
  assert.equal(terminal.marker, marker);
}

function globalFairnessRed() {
  const eventDir = path.join(TEMP_ROOT, "global-fairness");
  fs.mkdirSync(eventDir, { recursive: true });
  const hotLine = `${JSON.stringify({ type: "noise", padding: "x".repeat(1000) })}\n`;
  fs.writeFileSync(path.join(eventDir, "000-hot.jsonl"), hotLine.repeat(700));
  fs.writeFileSync(path.join(eventDir, "zzz-counter.jsonl"), `${JSON.stringify({ type: "counter_sample", transportId: "f".repeat(32), transportGeneration: 1 })}\n`);
  fs.writeFileSync(path.join(eventDir, "zzy-file.jsonl"), `${JSON.stringify({ type: "file_sample", transportId: "e".repeat(32), transportGeneration: 1 })}\n`);
  fs.writeFileSync(path.join(eventDir, "zzx.terminal.json"), `${JSON.stringify({ type: "invocation_terminal", marker: `TAIL_${"t".repeat(8000)}` })}\n`);
  const reader = new EventReader(eventDir);
  let mailboxSeen = false; let fileSeen = false; let terminalSeen = false;
  for (let poll = 0; poll < 3; poll += 1) {
    fs.appendFileSync(path.join(eventDir, "000-hot.jsonl"), hotLine.repeat(300));
    const before = reader.eventBytesRead;
    for (const event of reader.poll()) {
      if (event.type === "counter_sample") mailboxSeen = true;
      if (event.type === "file_sample") fileSeen = true;
      if (event.type === "invocation_terminal") terminalSeen = true;
    }
    assert.ok(reader.eventBytesRead - before <= 256 * 1024);
    if (mailboxSeen && fileSeen && terminalSeen) break;
  }
  assert.equal(mailboxSeen, true, "hot JSONL source starved a queued counter mailbox");
  assert.equal(fileSeen, true, "hot source starved file observation delivery");
  assert.equal(terminalSeen, true, "hot source starved terminal delivery");
}

async function crossHelperActualCreditRed() {
  const root = path.join(TEMP_ROOT, "cross-helper-actual-credit");
  const eventDir = path.join(root, "events");
  fs.mkdirSync(eventDir, { recursive: true });
  const eventLine = `${JSON.stringify({ type: "finite-final-drain", payload: "e".repeat(900) })}\n`;
  fs.writeFileSync(path.join(eventDir, "events.jsonl"), eventLine.repeat(160));
  const budget = new SharedReadBudget(256 * 1024);
  const reader = new EventReader(eventDir, budget, 64 * 1024);
  const counterService = new WindowsIoCounterService(eventDir, "a".repeat(64), "cross-helper-command", budget);
  reader.poll(true);
  counterService.beginReadCycle();
  const nativeLine = `${JSON.stringify({ type: "service_ready", desiredAccess: 4096 })}\n`;
  const nativeChunk = Buffer.from(nativeLine.repeat(Math.floor((16 * 1024) / Buffer.byteLength(nativeLine))), "utf8");
  counterService.onData(nativeChunk);
  let actualReadAndDelivery = reader.eventBytesRead + nativeChunk.length;

  const captureFile = path.join(root, "capture.log");
  fs.writeFileSync(captureFile, Buffer.alloc(64 * 1024, 3));
  const parent = fs.lstatSync(root, { bigint: true });
  const capture = captureDeclaredFilesAfterSettlement([{
    path: captureFile,
    parentRealPath: fs.realpathSync(root),
    parentDevice: parent.dev.toString(),
    parentInode: parent.ino.toString(),
  }], fs.realpathSync(root), 64 * 1024, budget);
  actualReadAndDelivery += capture.bytesRead;

  const firstCycle = budget.accounting();
  assert.ok(actualReadAndDelivery <= 256 * 1024,
    `combined final-drain/native-counter/capture actual reads exceeded 256 KiB: ${actualReadAndDelivery}`);
  assert.ok(actualReadAndDelivery <= firstCycle.currentCycleBytes,
    `actual combined work ${actualReadAndDelivery} exceeded granted credits ${firstCycle.currentCycleBytes}`);
  assert.ok(firstCycle.actualSourceBytes["counter-native-response"] > 0,
    "native counter response work must consume the same shared grant cycle");

  let helpersDelivered = 0;
  for (let index = 0; index < 2; index += 1) {
    reader.poll(true);
    counterService.beginReadCycle();
    const mailbox = path.join(root, `helper-${index}.mailbox`);
    fs.writeFileSync(mailbox, Buffer.alloc(64 * 1024, index + 1));
    reader.chargeExternal(64 * 1024, "helper-mailbox-delivery-and-read");
    const descriptor = fs.openSync(mailbox, "r");
    try {
      const bytes = Buffer.alloc(64 * 1024);
      const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      assert.equal(read, bytes.length);
      helpersDelivered += 1;
    } finally { fs.closeSync(descriptor); }
    const cycle = budget.accounting();
    assert.ok(cycle.currentActualBytes <= 256 * 1024);
    assert.ok(cycle.currentActualBytes <= cycle.currentCycleBytes);
  }
  assert.equal(helpersDelivered, 2,
    "credit-starved helpers must make fair progress in later cycles rather than receiving independent same-cycle pools");
}

function outstandingHelperGrantRed() {
  const root = path.join(TEMP_ROOT, "outstanding-helper-grants");
  fs.mkdirSync(root, { recursive: true });
  const budget = new SharedReadBudget(256 * 1024);
  const reader = new EventReader(root, budget);
  const files = [0, 1].map((index) => {
    const file = path.join(root, `grant-${index}.mailbox`);
    fs.writeFileSync(file, Buffer.alloc(96 * 1024, index + 1));
    return file;
  });

  budget.beginCycle();
  reader.chargeExternal(96 * 1024, "helper-delivery", "grant-one");
  budget.beginCycle();
  let secondGranted = true;
  try { reader.chargeExternal(96 * 1024, "helper-delivery", "grant-two"); }
  catch { secondGranted = false; }

  let actualSecondCycleWork = secondGranted ? 96 * 1024 : 0;
  for (const file of secondGranted ? files : files.slice(0, 1)) {
    const descriptor = fs.openSync(file, "r");
    try {
      const bytes = Buffer.alloc(96 * 1024);
      const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      assert.equal(read, bytes.length);
      actualSecondCycleWork += read;
    } finally { fs.closeSync(descriptor); }
  }
  assert.equal(secondGranted, false,
    "a new host cycle must not erase a still-outstanding asynchronous helper-read grant");
  assert.ok(actualSecondCycleWork <= 256 * 1024,
    `outstanding helper reads plus new delivery exceeded the global cycle: ${actualSecondCycleWork}`);
  assert.equal(budget.consumeHelperReadGrant("grant-one", 96 * 1024), true);
  budget.beginCycle();
  assert.doesNotThrow(() => reader.chargeExternal(96 * 1024, "helper-delivery", "grant-two"),
    "consumed helper grants must be reclaimed so later helpers make progress");
}

async function sharedReadContentionGreen() {
  const eventDir = path.join(TEMP_ROOT, "shared-read-contention");
  fs.mkdirSync(eventDir, { recursive: true });
  const hotLine = `${JSON.stringify({ type: "noise", padding: "x".repeat(900) })}\n`;
  fs.writeFileSync(path.join(eventDir, "000-hot.jsonl"), hotLine.repeat(1500));
  fs.writeFileSync(path.join(eventDir, "zzz-counter.jsonl"), `${JSON.stringify({ type: "counter_sample", marker: "COUNTER_FAIRNESS" })}\n`);
  fs.writeFileSync(path.join(eventDir, "zzy.terminal.json"), `${JSON.stringify({ type: "invocation_terminal", marker: `TERMINAL_FAIRNESS_${"t".repeat(12000)}` })}\n`);
  const artifact = path.join(eventDir, "external-artifact.bin");
  fs.writeFileSync(artifact, Buffer.alloc(120 * 1024, 7));
  const budget = new SharedReadBudget(256 * 1024);
  const reader = new EventReader(eventDir, budget);
  let events = 0; let terminalSeen = false; let counterSeen = false; let artifactRead = false; let captureCredits = false;
  for (let cycle = 0; cycle < 64 && (reader.hasPending() || !artifactRead || !captureCredits); cycle += 1) {
    for (const event of reader.poll(true)) {
      events += 1;
      if (event.marker === "COUNTER_FAIRNESS") counterSeen = true;
      if (String(event.marker || "").startsWith("TERMINAL_FAIRNESS_")) terminalSeen = true;
    }
    if (!artifactRead) artifactRead = Boolean(reader.readFileWithinCycle(artifact, 256 * 1024, "artifact"));
    else if (!captureCredits) captureCredits = budget.reserveExactBeforeRead(64 * 1024, "declared-file-capture");
    const accounting = budget.accounting();
    assert.ok(accounting.currentCycleBytes <= 256 * 1024, `combined source work exceeded shared cycle: ${accounting.currentCycleBytes}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(events, 1502);
  assert.equal(counterSeen, true, "hot events starved a counter mailbox");
  assert.equal(terminalSeen, true, "hot events starved a legal terminal record");
  assert.equal(artifactRead, true, "hot events starved a bounded artifact read");
  assert.equal(captureCredits, true, "artifact/event work permanently starved post-settlement capture credits");
  assert.ok(budget.accounting().maxCycleBytes <= 256 * 1024);
}

// Blocker B audit gap[0] (C:/Users/you/orc-repair-claude-run10-2026-10-05/
// blocker-b/report.json, proposedAddedAssertion), adapted from that audit's
// prototype probe-aggregate-actual-reads.cjs. Restates, behaviourally, the
// property the removed historical remainingBudget regexes protected: within
// one shared read cycle, the AGGREGATE of bytes PHYSICALLY read (via the
// fs.readSync wrapper installed above, before the monitor import, counting
// only this case's own descriptors) plus native counter-response bytes
// delivered, across event drain, a bounded artifact read and the PRODUCTION
// post-settlement host-capture route (captureSettledFilesWithSharedCredits,
// not the helper's captureDeclaredFilesAfterSettlement), never exceeds
// 256 KiB and never exceeds the credits granted that cycle, and that all
// three sources make progress within a finite number of cycles.
async function hostCaptureAggregateActualGreen() {
  const root = path.join(TEMP_ROOT, "host-capture-aggregate-actual");
  const eventDir = path.join(root, "events");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(eventDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const rootLower = path.resolve(root).toLowerCase();

  const noiseLine = (source, index) => `${JSON.stringify({ type: "noise", source, index, padding: "x".repeat(900) })}\n`;
  let expectedEvents = 0;
  for (const source of ["a", "b", "c"]) {
    let text = "";
    for (let index = 0; index < 220; index += 1) { text += noiseLine(source, index); expectedEvents += 1; }
    fs.writeFileSync(path.join(eventDir, `${source}.jsonl`), text);
  }
  fs.writeFileSync(path.join(eventDir, "z.terminal.json"), `${JSON.stringify({ type: "invocation_terminal", marker: `T_${"t".repeat(20000)}` })}\n`);
  expectedEvents += 1;

  const artifact = path.join(root, "artifact.bin");
  fs.writeFileSync(artifact, Buffer.alloc(200 * 1024, 7));
  const workspaceRealPath = fs.realpathSync(workspace);
  const parentStat = fs.lstatSync(workspace, { bigint: true });
  const captureSpecs = ["out1.log", "out2.log", "out3.log"].map((name) => {
    const file = path.join(workspaceRealPath, name);
    fs.writeFileSync(file, Buffer.alloc(90 * 1024, 65));
    return { path: file, parentRealPath: workspaceRealPath, parentDevice: parentStat.dev.toString(), parentInode: parentStat.ino.toString() };
  });

  const budget = new SharedReadBudget(256 * 1024);
  const reader = new EventReader(eventDir, budget, 16 * 1024);
  const counter = new WindowsIoCounterService(eventDir, "a".repeat(64), "host-capture-aggregate-command", budget);
  const nativeLine = `${JSON.stringify({ type: "service_ready", desiredAccess: 4096 })}\n`;
  const nativeChunk = Buffer.from(nativeLine.repeat(Math.floor((8 * 1024) / Buffer.byteLength(nativeLine))), "utf8");

  let events = 0; let artifactDone = false; let captureDone = false;
  const violations = [];
  const hookHitsBefore = __captureInstrumentationHookHits;
  __captureInstrumentationOwnerRootLower = rootLower;
  try {
    for (let cycle = 0; cycle < 400 && (reader.hasPending() || !artifactDone || !captureDone); cycle += 1) {
      const physicalBefore = __captureInstrumentationPhysicalBytes;
      events += reader.poll(true).length; // begins the shared cycle (finalizes the previous one)
      counter.beginReadCycle();
      counter.onData(nativeChunk); // production native-response charging path
      const nativeDelivered = nativeChunk.length;
      if (!artifactDone) {
        const outcome = reader.readFileWithinCycleOutcome(artifact, 256 * 1024, "artifact", root);
        if (outcome.kind === "read") artifactDone = true;
      }
      if (!captureDone) {
        const result = captureSettledFilesWithSharedCredits(captureSpecs, workspaceRealPath, reader, 64 * 1024);
        if (result) captureDone = true;
      }
      const accounting = budget.accounting();
      const physical = __captureInstrumentationPhysicalBytes - physicalBefore;
      const aggregate = physical + nativeDelivered;
      if (aggregate > 256 * 1024) violations.push({ cycle, aggregate, violation: "AGGREGATE_ACTUAL_EXCEEDS_256KIB" });
      if (aggregate > accounting.currentCycleBytes) {
        violations.push({ cycle, aggregate, grantedCycleBytes: accounting.currentCycleBytes, violation: "AGGREGATE_ACTUAL_EXCEEDS_GRANTED_CREDITS" });
      }
    }
  } finally {
    __captureInstrumentationOwnerRootLower = null;
  }
  const hookHits = __captureInstrumentationHookHits - hookHitsBefore;
  assert.ok(hookHits > 0, "instrumentation never observed a production read on the case root: case is invalid");
  assert.equal(violations.length, 0, `aggregate actual read/delivery exceeded the shared cycle: ${JSON.stringify(violations[0])}`);
  assert.equal(events, expectedEvents, "bounded drain must still deliver every event under the shared cycle");
  assert.equal(artifactDone, true, "hot events starved the bounded artifact read");
  assert.equal(captureDone, true, "hot events starved the production host-capture route");
  assert.ok(budget.accounting().maxCycleBytes <= 256 * 1024);
}

async function closeCallbackRed() {
  const service = new WindowsIoCounterService(path.join(TEMP_ROOT, "close-callback"), "a".repeat(64), "close-callback-command");
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = new Writable({ highWaterMark: 16 * 1024, write(_chunk, _encoding, callback) { setImmediate(callback); } });
  child.stdin.on("finish", () => { child.exitCode = 0; child.emit("close", 0); });
  service.child = child;
  service.send({ action: "unregister_file", transportId: "a".repeat(32), bindingGeneration: "b".repeat(32) });
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  let failure;
  try {
    assert.equal(child.stdin.writableLength, 0);
    assert.equal(closed, true, "close must settle from write completion even when no drain event fires");
    assert.equal(service.queueCloseWaiters.length, 0);
  } catch (error) { failure = error; }
  finally {
    // Failure-safe cleanup touches only this in-memory Writable and production waiter method.
    service.settleQueueWaiters();
    await closing;
  }
  if (failure) throw failure;
}

async function transportCloseGreen() {
  const makeService = (name, writable) => {
    const service = new WindowsIoCounterService(path.join(TEMP_ROOT, name), "a".repeat(64), name);
    const child = new EventEmitter(); child.exitCode = null; child.stdin = writable;
    writable.on("finish", () => { child.exitCode = 0; child.emit("close", 0); });
    writable.on("drain", () => { service.writeBlocked = false; service.flushQueue(); service.settleQueueWaiters(); });
    writable.on("error", (error) => { service.failTransport(error); child.exitCode = 1; child.emit("close", 1); });
    service.child = child;
    return { service, child };
  };

  let drains = 0;
  const pressuredWritable = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { setImmediate(callback); } });
  pressuredWritable.on("drain", () => { drains += 1; });
  const pressured = makeService("close-backpressure", pressuredWritable);
  pressured.service.send({ action: "sample", payload: "x".repeat(2048) });
  let pressuredSettled = false; let pressuredError;
  const pressuredClose = pressured.service.close().then(() => { pressuredSettled = true; }, (error) => { pressuredSettled = true; pressuredError = error; });
  for (let turn = 0; turn < 8 && !pressuredSettled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const pressuredNeededManualSettlement = !pressuredSettled;
  if (pressuredNeededManualSettlement) pressured.service.settleQueueWaiters();
  await pressuredClose;
  assert.equal(pressuredError, undefined);
  assert.equal(pressuredNeededManualSettlement, false, "backpressure close required test-only waiter settlement");
  assert.equal(pressuredSettled, true, "backpressure close must settle through protocol events");
  assert.ok(drains >= 1, "actual backpressure must release through drain");
  assert.equal(pressured.service.queueCloseWaiters.length, 0);

  const queuedWritable = new Writable({ highWaterMark: 16 * 1024, write(_chunk, _encoding, callback) { setImmediate(callback); } });
  const queued = makeService("close-queued", queuedWritable);
  queued.service.writeBlocked = true;
  for (let index = 0; index < 16; index += 1) queued.service.send({ action: "queued", index, payload: "q".repeat(256) });
  let queuedSettled = false;
  const closing = queued.service.close().then(() => { queuedSettled = true; });
  assert.ok(queued.service.getTransportStats().queuedBytes <= 64 * 1024);
  queued.service.writeBlocked = false;
  queued.service.flushQueue();
  for (let turn = 0; turn < 64 && !queuedSettled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const queuedNeededManualSettlement = !queuedSettled;
  if (queuedNeededManualSettlement) queued.service.settleQueueWaiters();
  await closing;
  assert.equal(queuedNeededManualSettlement, false, "queued close required test-only waiter settlement");
  assert.equal(queuedSettled, true);
  assert.equal(queued.service.getTransportStats().queuedBytes, 0);
  assert.equal(queued.service.queueCloseWaiters.length, 0);

  const brokenWritable = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("controlled disconnect")); } });
  const broken = makeService("close-disconnected", brokenWritable);
  broken.service.send({ action: "disconnect" });
  let brokenSettled = false; let brokenError;
  const brokenClose = broken.service.close().then(() => { brokenSettled = true; }, (error) => { brokenSettled = true; brokenError = error; });
  for (let turn = 0; turn < 8 && !brokenSettled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  if (!brokenSettled) broken.service.failTransport(new Error("controlled disconnect fallback"));
  await brokenClose;
  assert.match(String(brokenError?.message), /controlled disconnect|TRANSPORT/);
  assert.equal(broken.service.queueCloseWaiters.length, 0);
}

async function serviceLifecycleRed() {
  if (process.platform !== "win32") return;
  const caseRoot = path.join(TEMP_ROOT, "service-lifecycle");
  const eventDir = path.join(caseRoot, "events");
  fs.mkdirSync(eventDir, { recursive: true });
  const fixture = path.join(caseRoot, "natural-child.cjs");
  fs.writeFileSync(fixture, "process.stdin.resume(); process.stdin.on('end', () => {});\n");
  const service = new WindowsIoCounterService(eventDir, "c".repeat(64), "lifecycle-command");
  const invocationId = "lifecycle"; const id = "a".repeat(32); const binding = "b".repeat(32);
  let child;
  try {
    await service.start();
    const earliestCreationUnixMs = Date.now();
    child = spawn(process.execPath, [fixture], { cwd: caseRoot, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: false });
    const latestCreationUnixMs = Date.now();
    service.register({ invocationId, transportId: id, bindingGeneration: binding, pid: child.pid, expectedExecutable: process.execPath, earliestCreationUnixMs, latestCreationUnixMs });
    const registered = await service.waitForCounterState(id, 0);
    const generation = Number(registered.transportGeneration);
    const firstWaiter = service.waitForCounterState(id, generation);
    const secondWaiter = service.waitForCounterState(id, generation + 1);
    service.sample({ invocationId, transportId: id, bindingGeneration: binding, requestGeneration: 1, requestId: "c".repeat(32) });
    await firstWaiter;
    assert.equal(service.counterStateWaiters.get(id).length, 1, "later-generation waiter must retain its own predicate");
    service.sample({ invocationId, transportId: id, bindingGeneration: binding, requestGeneration: 2, requestId: "d".repeat(32) });
    await secondWaiter;
    service.unregister(invocationId);
    assert.equal(service.latestCounterStates.has(id), false);
    assert.equal(service.counterStateWaiters.has(id), false);
    child.stdin.end(); await waitForClose(child);
    await service.close();
    assert.equal(service.active.size, 0);
  } finally {
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
    if (child) await waitForClose(child);
    try { await service.close(); } catch {}
  }
}

async function powershellFramingRed() {
  const script = path.join(ROOT, "src", "windows-process-io-sampler.ps1");
  const source = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(source, /Console\]::In\.ReadLine\(\)/, "PowerShell input must be bounded before allocation");
  assert.match(source, /New-Object char\[\] 4096/, "native request framing must allocate a fixed 4 KiB character buffer");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const runInput = async (parts) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-16384); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16384); });
    for (const part of parts) child.stdin.write(part);
    child.stdin.end();
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    return { ...result, stdout, stderr };
  };
  const validFrame = `${JSON.stringify({ action: "bad", transportId: "a".repeat(32), bindingGeneration: "b".repeat(32) })}\n`;
  const partial = await runInput([validFrame.slice(0, 7), validFrame.slice(7)]);
  assert.equal(partial.code, 0, partial.stderr);
  assert.match(partial.stdout, /service_ready/);
  const oversized = await runInput(["x".repeat(5000), "\n"]);
  assert.notEqual(oversized.code, 0);
  assert.match(oversized.stderr, /exceeds 4096/);
  const unterminated = await runInput([validFrame.trimEnd()]);
  assert.notEqual(unterminated.code, 0);
  assert.match(unterminated.stderr, /unterminated request frame/);
}

async function activeSensorLossGreen() {
  if (process.platform !== "win32") return;
  const caseRoot = path.join(TEMP_ROOT, "active-sensor-loss");
  const eventDir = path.join(caseRoot, "events"); fs.mkdirSync(eventDir, { recursive: true });
  const fixture = path.join(caseRoot, "natural-child.cjs"); fs.writeFileSync(fixture, "process.stdin.resume(); process.stdin.on('end', () => {});\n");
  process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_SAMPLES = "2";
  const service = new WindowsIoCounterService(eventDir, "7".repeat(64), "loss-command");
  let child;
  try {
    await service.start();
    const earliestCreationUnixMs = Date.now();
    child = spawn(process.execPath, [fixture], { cwd: caseRoot, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: false });
    const latestCreationUnixMs = Date.now();
    const invocationId = "loss-invocation"; const transportId = "6".repeat(32); const bindingGeneration = "5".repeat(32);
    service.register({ invocationId, transportId, bindingGeneration, pid: child.pid, expectedExecutable: process.execPath, earliestCreationUnixMs, latestCreationUnixMs });
    const registered = await service.waitForCounterState(transportId, 0);
    assert.equal(registered.type, "counter_registered");
    service.sample({ invocationId, transportId, bindingGeneration, requestGeneration: 1, requestId: "4".repeat(32) });
    const baseline = await service.waitForCounterState(transportId, Number(registered.transportGeneration));
    assert.equal(baseline.type, "counter_sample");
    service.sample({ invocationId, transportId, bindingGeneration, requestGeneration: 2, requestId: "3".repeat(32) });
    const second = await service.waitForCounterState(transportId, Number(baseline.transportGeneration));
    assert.equal(second.type, "counter_sample");
    const lost = await service.waitForCounterState(transportId, Number(second.transportGeneration));
    assert.equal(lost.type, "counter_error");
    assert.match(String(lost.message), /exited unexpectedly|closed/i);
    child.stdin.end(); await waitForClose(child);
    try { await service.close(); } catch {}
  } finally {
    delete process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_SAMPLES;
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
    if (child) await waitForClose(child);
    try { await service.close(); } catch {}
  }
}

async function windowsNoninterferenceGreen() {
  if (process.platform !== "win32") return;
  const caseRoot = path.join(TEMP_ROOT, "windows-no-live-file-handles");
  const eventDir = path.join(caseRoot, "events");
  fs.mkdirSync(eventDir, { recursive: true });
  const observed = path.join(caseRoot, "observed.log");
  const replacement = path.join(caseRoot, "replacement.log");
  fs.writeFileSync(observed, "OLD0"); fs.writeFileSync(replacement, "GEN0");
  const fixture = path.join(caseRoot, "replacement-child.cjs");
  fs.writeFileSync(fixture, [
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => { const message = JSON.parse(line); if (message.action === 'replace') { for (let generation = 1; generation <= 8; generation += 1) { const temporary = `${message.path}.${generation}.tmp`; fs.writeFileSync(temporary, `GEN${generation}`); fs.renameSync(temporary, message.path); } console.log('replacement:8'); } });",
    "",
  ].join("\n"));
  const service = new WindowsIoCounterService(eventDir, "b".repeat(64), "windows-replacement-command");
  let child;
  try {
    await service.start();
    const earliestCreationUnixMs = Date.now();
    child = spawn(process.execPath, [fixture], { cwd: caseRoot, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: false });
    child.stdout.setEncoding("utf8");
    const output = new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(chunk.trim())));
    const latestCreationUnixMs = Date.now();
    const invocationId = "windows-replacement-invocation"; const transportId = "c".repeat(32); const bindingGeneration = "d".repeat(32);
    service.register({ invocationId, transportId, bindingGeneration, pid: child.pid, expectedExecutable: process.execPath, earliestCreationUnixMs, latestCreationUnixMs });
    const registered = await service.waitForCounterState(transportId, 0);
    service.sample({ invocationId, transportId, bindingGeneration, requestGeneration: 1, requestId: "e".repeat(32) });
    const baseline = await service.waitForCounterState(transportId, Number(registered.transportGeneration));
    child.stdin.write(`${JSON.stringify({ action: "replace", path: observed })}\n`);
    assert.equal(await output, "replacement:8", "finite direct Node replacement sequence did not complete");
    service.sample({ invocationId, transportId, bindingGeneration, requestGeneration: 2, requestId: "f".repeat(32) });
    const after = await service.waitForCounterState(transportId, Number(baseline.transportGeneration));
    assert.ok(Number(after.writeOperations) > Number(baseline.writeOperations) || Number(after.writeTransfer) > Number(baseline.writeTransfer));
    child.stdin.end(); await waitForClose(child);
    service.unregister(invocationId); await service.close();
    assert.equal(fs.readFileSync(observed, "utf8"), "GEN8");
    const parent = fs.lstatSync(caseRoot, { bigint: true });
    const capture = captureDeclaredFilesAfterSettlement([{ path: observed, parentRealPath: fs.realpathSync(caseRoot), parentDevice: parent.dev.toString(), parentInode: parent.ino.toString() }], fs.realpathSync(caseRoot), 64 * 1024);
    assert.equal(capture.results[0].status, "captured");
    assert.equal(capture.results[0].head, "GEN8");
    assert.equal(capture.results[0].historicalContent, "not_retained_during_execution");
    const movedAfterCapture = path.join(caseRoot, "moved-after-capture.log");
    fs.renameSync(observed, movedAfterCapture);
    fs.renameSync(movedAfterCapture, observed);
    const deleted = path.join(caseRoot, "deleted.log");
    fs.writeFileSync(deleted, "gone"); fs.rmSync(deleted);
    const deletedCapture = captureDeclaredFilesAfterSettlement([{ path: deleted, parentRealPath: fs.realpathSync(caseRoot), parentDevice: parent.dev.toString(), parentInode: parent.ino.toString() }], fs.realpathSync(caseRoot), 64 * 1024);
    assert.equal(deletedCapture.results[0].status, "missing");
    assert.equal(deletedCapture.results[0].historicalContent, "not_retained_during_execution");
  } finally {
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
    if (child) await waitForClose(child);
    try { await service.close(); } catch {}
  }
}

const cases = {
  "finite-storage": finiteStorageRed,
  "sustained-retention": sustainedRetentionGreen,
  "scheduler": schedulerGreen,
  "event-reclamation": eventReclamationGreen,
  "retirement-accounting": retirementAccountingGreen,
  "terminal-drain": terminalDrainRed,
  "global-fairness": globalFairnessRed,
  "cross-helper-actual-credit": crossHelperActualCreditRed,
  "outstanding-helper-grants": outstandingHelperGrantRed,
  "shared-read-contention": sharedReadContentionGreen,
  "host-capture-aggregate-actual": hostCaptureAggregateActualGreen,
  "close-callback": closeCallbackRed,
  "transport-close": transportCloseGreen,
  "service-lifecycle": serviceLifecycleRed,
  "powershell-framing": powershellFramingRed,
  "active-sensor-loss": activeSensorLossGreen,
  "windows-noninterference": windowsNoninterferenceGreen,
};
(async () => {
  const selected = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : undefined;
  const entries = selected ? [[selected, cases[selected]]] : Object.entries(cases);
  if (selected && !cases[selected]) throw new Error(`unknown gate1 case: ${selected}`);
  for (const [name, run] of entries) { await run(); console.log(`PASS item3 gate1 ${name}`); }
})().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
