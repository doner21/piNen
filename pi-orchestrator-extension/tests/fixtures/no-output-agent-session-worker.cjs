#!/usr/bin/env node
/** Offline AgentSession worker used by the item-3 production-dispatch regression. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE = process.cwd();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const args = process.argv.slice(2);
assert.ok(AGENT_DIR && process.env.PI_OFFLINE === "1", "fixture requires isolated offline roots");

let ownerFollowupAdapter;
async function installOwnerFollowupAdapter() {
  if (process.env.ITEM3_SCENARIO !== "gate-owner-followup") return;
  const ownerModule = require(path.join(ROOT, "src", "command-telemetry-owner.cjs"));
  const { CommandTelemetryOwner, CommandTelemetryClient } = ownerModule;
  const originalStart = CommandTelemetryOwner.prototype.start;
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originalRmSync = fs.rmSync;
  const adapterIds = new Set(["e".repeat(24), "f".repeat(24)]);
  const metrics = {
    actualPartialWriteBytes: 0,
    partialFailureCharged: false,
    cleanupReclaimed: false,
    zeroFailureCharged: false,
    zeroCleanupReclaimed: false,
    priorSurvived: false,
    deferredObserved: false,
    unadmittedPayloadStarted: false,
    actualOwnerRequestsDuringScenario: 0,
    nativeCounterDeliveriesDuringScenario: 0,
    scenarioStarted: false,
    scenarioCompleted: false,
    scenarioError: "",
    terminalDrainCases: [],
    durableTerminalTexts: [],
  };
  const adapterClients = new Set();
  let installedOwner;
  let scenarioPromise;

  CommandTelemetryOwner.prototype.start = async function instrumentedOwnerStart(...startArgs) {
    await originalStart.apply(this, startArgs);
    installedOwner = this;
    const owner = this;
    const nestedId = "e".repeat(24);
    const blockerId = "f".repeat(24);
    let scenarioActive = false;
    let contentionArmed = false;
    let blocker;
    let blockerRelease;
    let releaseBlocker;
    let nativeDeliveryObserved;
    let resolveNativeDelivery;
    let drainGeneration = 0;
    let holdAdapterDrain = false;
    let pendingDrainFault;
    const drainWaiters = [];

    blockerRelease = new Promise((resolve) => { releaseBlocker = resolve; });
    nativeDeliveryObserved = new Promise((resolve) => { resolveNativeDelivery = resolve; });

    const originalDrainEvents = owner.drainEvents;
    owner.drainEvents = function observedDrain(...drainArgs) {
      if (holdAdapterDrain) return [];
      let result = [];
      let thrown;
      let actualBytesRead = 0;
      const trackedDescriptors = new Set();
      const openedTrackedDescriptors = new Set();
      const closedTrackedDescriptors = new Set();
      if (pendingDrainFault) {
        fs.readFileSync = function observedLegacyDrainRead(file, ...readArgs) {
          if (path.resolve(String(file)) === path.resolve(pendingDrainFault.file)
            && pendingDrainFault.mode === "open-read-failure") {
            const error = new Error("integrated finite terminal open/read failure");
            error.code = "EIO";
            throw error;
          }
          const value = originalReadFileSync.call(this, file, ...readArgs);
          if (path.resolve(String(file)) === path.resolve(pendingDrainFault.file)) {
            actualBytesRead += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
          }
          return value;
        };
        fs.openSync = function observedBoundedDrainOpen(file, ...openArgs) {
          if (path.resolve(String(file)) === path.resolve(pendingDrainFault.file)
            && pendingDrainFault.mode === "open-read-failure") {
            const error = new Error("integrated finite terminal open/read failure");
            error.code = "EIO";
            throw error;
          }
          const descriptor = originalOpenSync.call(this, file, ...openArgs);
          if (path.resolve(String(file)) === path.resolve(pendingDrainFault.file)) {
            trackedDescriptors.add(descriptor);
            openedTrackedDescriptors.add(descriptor);
          }
          return descriptor;
        };
        fs.closeSync = function observedBoundedDrainClose(descriptor, ...closeArgs) {
          if (openedTrackedDescriptors.has(descriptor)) closedTrackedDescriptors.add(descriptor);
          return originalCloseSync.call(this, descriptor, ...closeArgs);
        };
        fs.readSync = function observedBoundedDrainRead(descriptor, ...readArgs) {
          const bytes = originalReadSync.call(this, descriptor, ...readArgs);
          if (trackedDescriptors.has(descriptor)) {
            actualBytesRead += bytes;
            trackedDescriptors.delete(descriptor);
          }
          return bytes;
        };
      }
      try { result = originalDrainEvents.apply(this, drainArgs); }
      catch (error) { thrown = error; }
      finally {
        fs.readFileSync = originalReadFileSync;
        fs.openSync = originalOpenSync;
        fs.readSync = originalReadSync;
        fs.closeSync = originalCloseSync;
      }
      if (pendingDrainFault) {
        const fault = pendingDrainFault;
        const accounting = this.accounting();
        const affected = new Set([fault.badInvocation, fault.healthyInvocation]);
        const relatedLeases = [...(this.readerLeases?.values() ?? [])]
          .filter((lease) => affected.has(lease.invocationId)).length;
        const queuedRelated = this.events.filter((record) => affected.has(record.delivery?.invocationId)).length;
        metrics.terminalDrainCases.push({
          mode: fault.mode,
          committedBytes: fault.committedBytes,
          actualBytesRead,
          healthyDelivered: result.some((event) => event.marker === fault.healthyMarker),
          corruptDelivered: result.some((event) => event.marker === fault.badMarker),
          bounded: fault.mode === "same-size-corruption"
            ? actualBytesRead === fault.committedBytes
            : actualBytesRead === 0,
          handlesClosed: [...openedTrackedDescriptors].every((descriptor) => closedTrackedDescriptors.has(descriptor)),
          threw: thrown?.message || "",
          relatedLeases,
          queuedRelated,
          failedOperationRecorded: accounting.failedOperations > fault.failedOperationsBefore,
        });
        pendingDrainFault = undefined;
        fault.resolve();
      }
      drainGeneration += 1;
      while (drainWaiters.length) drainWaiters.shift()(drainGeneration);
      return result;
    };
    const waitForDrainAfter = (generation) => drainGeneration > generation
      ? Promise.resolve(drainGeneration)
      : new Promise((resolve) => drainWaiters.push(resolve));

    const originalRetireCommitted = owner.retireCommitted;
    owner.retireCommitted = function observedRetirement(invocationId) {
      const lease = this.acquireCommitted(invocationId);
      if (lease) {
        metrics.durableTerminalTexts.push(lease.bytes.toString("utf8"));
        this.releaseReader(lease.leaseId);
      }
      return originalRetireCommitted.call(this, invocationId);
    };

    const originalCompleteHostWork = owner.completeHostWork;
    owner.completeHostWork = function observedHostWork(permission, actualBytes) {
      const result = originalCompleteHostWork.call(this, permission, actualBytes);
      if (scenarioActive && permission?.channel === "counter" && actualBytes > 0) {
        metrics.nativeCounterDeliveriesDuringScenario += 1;
        resolveNativeDelivery();
      }
      return result;
    };

    const originalCompletePayload = owner.completePayload;
    owner.completePayload = function observedPayload(connection, ...payloadArgs) {
      if (contentionArmed && !adapterIds.has(connection.invocationId)
        && connection.pending?.status !== "granted") metrics.unadmittedPayloadStarted = true;
      return originalCompletePayload.call(this, connection, ...payloadArgs);
    };

    const originalRequest = owner.request;
    let blockerReleaseScheduled = false;
    owner.request = function observedRequest(connection, frame) {
      const actualPublisher = scenarioActive && !adapterIds.has(connection.invocationId);
      const result = originalRequest.call(this, connection, frame);
      if (actualPublisher) metrics.actualOwnerRequestsDuringScenario += 1;
      if (contentionArmed && actualPublisher && connection.pending?.status === "queued") {
        metrics.deferredObserved = true;
        if (!blockerReleaseScheduled) {
          blockerReleaseScheduled = true;
          setImmediate(() => blocker.close().then(() => {
            adapterClients.delete(blocker);
            releaseBlocker();
          }, (error) => {
            metrics.scenarioError = error?.stack || String(error);
            releaseBlocker();
          }));
        }
      }
      return result;
    };

    const runTerminalDrainCase = async (realParentInvocationId, mode, index) => {
      const badInvocation = String(7 - index * 2).repeat(24);
      const healthyInvocation = String(6 - index * 2).repeat(24);
      adapterIds.add(badInvocation); adapterIds.add(healthyInvocation);
      const bad = new CommandTelemetryClient(owner.configuration(realParentInvocationId), badInvocation);
      const healthy = new CommandTelemetryClient(owner.configuration(realParentInvocationId), healthyInvocation);
      adapterClients.add(bad); adapterClients.add(healthy);
      try {
        holdAdapterDrain = true;
        await Promise.all([bad.connect(), healthy.connect()]);
        const badMarker = `INTEGRATED_DRAIN_BAD_${mode}`;
        const healthyMarker = `INTEGRATED_DRAIN_HEALTHY_${mode}`;
        await bad.publish({ type: "invocation_terminal", outcome: "succeeded", marker: badMarker }, "terminal");
        await healthy.publish({ type: "invocation_terminal", outcome: "succeeded", marker: healthyMarker }, "terminal");
        const badRecord = owner.events.find((record) => record.delivery?.invocationId === badInvocation);
        assert.ok(badRecord?.delivery?.file);
        const committedBytes = fs.statSync(badRecord.delivery.file).size;
        if (mode === "growth") originalWriteFileSync.call(fs, badRecord.delivery.file, Buffer.alloc(200 * 1024, 120));
        else if (mode === "same-size-corruption") originalWriteFileSync.call(fs, badRecord.delivery.file, Buffer.alloc(committedBytes, 120));
        const consumed = new Promise((resolve) => {
          pendingDrainFault = {
            mode, file: badRecord.delivery.file, badInvocation, healthyInvocation,
            badMarker, healthyMarker, committedBytes,
            failedOperationsBefore: owner.accounting().failedOperations,
            resolve,
          };
        });
        holdAdapterDrain = false;
        const beforeDrain = drainGeneration;
        await Promise.all([consumed, waitForDrainAfter(beforeDrain)]);
      } finally {
        holdAdapterDrain = false;
        pendingDrainFault = undefined;
        for (const [leaseId, lease] of owner.readerLeases ?? []) {
          if (lease.invocationId === badInvocation || lease.invocationId === healthyInvocation) owner.releaseReader(leaseId);
        }
        owner.finalizeInvocation(badInvocation); owner.finalizeInvocation(healthyInvocation);
        originalRetireCommitted.call(owner, badInvocation);
        originalRetireCommitted.call(owner, healthyInvocation);
        await Promise.allSettled([bad.close(), healthy.close()]);
        adapterClients.delete(bad); adapterClients.delete(healthy);
      }
    };

    const runConcurrentScenario = async (realParentInvocationId) => {
      scenarioActive = true;
      metrics.scenarioStarted = true;
      const nested = new CommandTelemetryClient(owner.configuration(realParentInvocationId), nestedId);
      blocker = new CommandTelemetryClient(owner.configuration(realParentInvocationId), blockerId);
      adapterClients.add(nested); adapterClients.add(blocker);
      let prior;
      let failedTemporary = "";
      let failureMode = "";
      let rejectCleanup = false;
      try {
        await nested.connect();
        await nested.publish({ type: "invocation_terminal", outcome: "succeeded", marker: "INTEGRATED_PRIOR_COMMITTED" }, "terminal");
        prior = owner.acquireCommitted(nestedId);
        assert.ok(prior);

        // The blocker is a naturally closing publisher under the real
        // supervisor's owner. Its EOF is independent of the deferred real
        // publication, so repaired admission cannot create a circular wait.
        await blocker.connect();
        await blocker.requestWork("terminal", 240 * 1024);
        contentionArmed = true;
        await blockerRelease;
        contentionArmed = false;

        fs.writeFileSync = function instrumentedFailedWrite(file, data, ...writeArgs) {
          const target = String(file);
          if (failureMode && target.includes(`${nestedId}.terminal.`) && target.endsWith(".tmp")) {
            const bytes = failureMode === "partial" ? Buffer.from(data).subarray(0, 48 * 1024) : Buffer.alloc(0);
            originalWriteFileSync.call(this, file, bytes, ...writeArgs);
            if (failureMode === "partial") metrics.actualPartialWriteBytes += bytes.length;
            failedTemporary = target;
            const error = new Error(`integrated finite ${failureMode} staging write failure`);
            error.code = "ENOSPC";
            throw error;
          }
          return originalWriteFileSync.call(this, file, data, ...writeArgs);
        };
        fs.rmSync = function instrumentedFailedCleanup(file, ...removeArgs) {
          if (rejectCleanup && failedTemporary && path.resolve(String(file)) === path.resolve(failedTemporary)) {
            const error = new Error("integrated finite staging cleanup failure");
            error.code = "EBUSY";
            throw error;
          }
          return originalRmSync.call(this, file, ...removeArgs);
        };

        failureMode = "partial";
        rejectCleanup = true;
        await assert.rejects(() => nested.publish({
          type: "invocation_terminal", outcome: "succeeded", marker: "INTEGRATED_FAILED_SUCCESSOR",
          payload: "p".repeat(60 * 1024),
        }, "terminal"), /integrated finite partial staging write failure/);
        failureMode = "";
        metrics.partialFailureCharged = Number(owner.accounting().failedRetainedBytes) >= 48 * 1024
          && Number(owner.accounting().currentOutstandingBytes) >= 48 * 1024;
        metrics.priorSurvived = fs.readFileSync(prior.file, "utf8").includes("INTEGRATED_PRIOR_COMMITTED");
        rejectCleanup = false;
        let drainBefore = drainGeneration;
        await nested.publish({ type: "integrated_cleanup_barrier", marker: "PARTIAL_CLEANUP_CONFIRMED" });
        await waitForDrainAfter(drainBefore);
        metrics.cleanupReclaimed = !fs.existsSync(failedTemporary)
          && Number(owner.accounting().failedRetainedBytes || 0) === 0;

        failedTemporary = "";
        failureMode = "zero-byte";
        rejectCleanup = true;
        await assert.rejects(() => nested.publish({
          type: "invocation_terminal", outcome: "succeeded", marker: "INTEGRATED_ZERO_BYTE_SUCCESSOR",
        }, "terminal"), /integrated finite zero-byte staging write failure/);
        failureMode = "";
        const zeroFailureAccounting = owner.accounting();
        metrics.zeroFailureCharged = fs.existsSync(failedTemporary)
          && Number(zeroFailureAccounting.retainedFailedStages) >= 1
          && Number(zeroFailureAccounting.currentOutstandingBytes) > 0;
        metrics.priorSurvived &&= fs.readFileSync(prior.file, "utf8").includes("INTEGRATED_PRIOR_COMMITTED");
        rejectCleanup = false;
        drainBefore = drainGeneration;
        await nested.publish({ type: "integrated_cleanup_barrier", marker: "ZERO_CLEANUP_CONFIRMED" });
        await waitForDrainAfter(drainBefore);
        const zeroRecovered = owner.accounting();
        metrics.zeroCleanupReclaimed = !fs.existsSync(failedTemporary)
          && Number(zeroRecovered.retainedFailedStages) === 0;

        for (const [index, mode] of ["growth", "same-size-corruption", "open-read-failure"].entries()) {
          await runTerminalDrainCase(realParentInvocationId, mode, index);
        }

        owner.releaseReader(prior.leaseId);
        assert.equal(owner.retireCommitted(nestedId), true);
        prior = undefined;
        if (metrics.nativeCounterDeliveriesDuringScenario === 0) await nativeDeliveryObserved;
        metrics.scenarioCompleted = true;
      } finally {
        failureMode = "";
        rejectCleanup = false;
        fs.readFileSync = originalReadFileSync;
        fs.openSync = originalOpenSync;
        fs.readSync = originalReadSync;
        fs.closeSync = originalCloseSync;
        fs.writeFileSync = originalWriteFileSync;
        fs.rmSync = originalRmSync;
        if (prior) owner.releaseReader(prior.leaseId);
        await Promise.allSettled([nested.close(), blocker.close()]);
        adapterClients.delete(nested); adapterClients.delete(blocker);
        scenarioActive = false;
        contentionArmed = false;
      }
    };

    const originalReceive = owner.receive;
    owner.receive = function observedRegistration(connection, frame) {
      const result = originalReceive.call(this, connection, frame);
      if (!scenarioPromise && frame?.kind === "register" && connection.registered
        && !adapterIds.has(connection.invocationId)) {
        scenarioPromise = runConcurrentScenario(connection.invocationId).catch((error) => {
          metrics.scenarioError = error?.stack || String(error);
        });
      }
      return result;
    };
  };

  ownerFollowupAdapter = {
    metrics,
    snapshot() {
      return {
        ...metrics,
        durableTerminalTexts: metrics.durableTerminalTexts.slice(),
        ownerAccounting: installedOwner?.accounting(),
      };
    },
    async restore() {
      if (scenarioPromise) await scenarioPromise;
      CommandTelemetryOwner.prototype.start = originalStart;
      fs.readFileSync = originalReadFileSync;
      fs.openSync = originalOpenSync;
      fs.readSync = originalReadSync;
      fs.closeSync = originalCloseSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.rmSync = originalRmSync;
      await Promise.allSettled([...adapterClients].map((client) => client.close()));
    },
  };
}

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

function argumentValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function extensionPaths() {
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "--extension" || args[index] === "-e") && args[index + 1]) paths.push(args[index + 1]);
  }
  return paths;
}

function textOf(content) {
  return (content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

async function readPrompt() {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  return prompt;
}

async function main() {
  const sdk = require(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
  const ai = require(path.join(ROOT, "node_modules", "@earendil-works", "pi-ai"));
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(AGENT_DIR, "auth.json"),
    modelsPath: path.join(AGENT_DIR, "models.json"),
    modelsStorePath: path.join(AGENT_DIR, `models-store-item3-${process.pid}.json`),
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("fixture", "no-output-model");
  assert.ok(model, "isolated no-output model must resolve");

  await installOwnerFollowupAdapter();
  const loadedExtensions = extensionPaths().filter((entry) =>
    process.env.ITEM3_SUPPRESS_MONITOR !== "1" || path.basename(entry) !== "worker-no-output-monitor.ts");
  const mutationFactory = (pi) => {
    pi.on("tool_result", (event) => {
      if (event.toolName !== "bash") return undefined;
      if (process.env.ITEM3_PROGRESS_RECORDS) {
        fs.appendFileSync(process.env.ITEM3_PROGRESS_RECORDS, `${JSON.stringify({
          role: process.env.ITEM3_ROLE,
          toolCallId: event.toolCallId,
          hasNoOutput: Boolean(event.details?.noOutput),
          outcome: event.details?.noOutput?.outcome,
        })}\n`, "utf8");
      }
      if (ownerFollowupAdapter) {
        return { details: { ...(event.details ?? {}), item3OwnerFollowup: ownerFollowupAdapter.snapshot() } };
      }
      if (!event.details?.noOutput) return undefined;
      if (process.env.ITEM3_MUTATION_DROP_EVIDENCE === "1") {
        const { noOutput: _dropped, ...details } = event.details;
        return { details };
      }
      if (process.env.ITEM3_MUTATION_DROP_PARTIAL === "1") {
        return { details: { ...event.details, noOutput: {
          ...event.details.noOutput,
          partialLog: "",
          cancellations: (event.details.noOutput.cancellations ?? []).map((entry) => ({ ...entry, partialLog: "" })),
        } } };
      }
      return undefined;
    });
  };
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: WORKSPACE,
    agentDir: AGENT_DIR,
    settingsManager,
    noExtensions: args.includes("--no-extensions"),
    additionalExtensionPaths: loadedExtensions,
    extensionFactories: [{ name: "item3-mutation-probe", factory: mutationFactory }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], "explicit worker extensions must load");

  const tools = (argumentValue("--tools") || "bash").split(",").map((value) => value.trim()).filter(Boolean);
  const { session } = await sdk.createAgentSession({
    cwd: WORKSPACE,
    agentDir: AGENT_DIR,
    modelRuntime,
    model,
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(WORKSPACE),
    tools,
  });
  const events = [];
  session.subscribe((event) => {
    events.push(event);
    if (process.env.ITEM3_PROGRESS_RECORDS && event.type === "tool_execution_start") {
      fs.appendFileSync(process.env.ITEM3_PROGRESS_RECORDS, `${JSON.stringify({
        role: process.env.ITEM3_ROLE,
        toolCallId: event.toolCallId,
        phase: "start",
      })}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });

  const faux = ai.createFauxCore({
    provider: "fixture",
    models: [{ id: "no-output-model", contextWindow: 200_000, maxTokens: 2_000 }],
  });
  const quotedNode = `'${process.execPath.replace(/\\/g, "/").replace(/'/g, `'\"'\"'`)}'`;
  const comprehensive = process.env.ITEM3_SCENARIO === "comprehensive";
  const artifactTamperFocused = process.env.ITEM3_SCENARIO === "artifact-tamper-focused";
  const gateCounterOnly = process.env.ITEM3_SCENARIO === "gate-counter-only";
  const gateCaptureBoundary = process.env.ITEM3_SCENARIO === "gate-capture-boundary";
  const gateNestedCapture = process.env.ITEM3_SCENARIO === "gate-nested-capture";
  const gateOwnerFollowup = process.env.ITEM3_SCENARIO === "gate-owner-followup";
  const calls = artifactTamperFocused ? [
    ai.fauxToolCall("bash", {
      command: "node tests/item3-oversize-artifact.cjs; node tests/item3-tamper-artifact.cjs \"$PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT\"; true",
    }, { id: "artifact-tamper" }),
  ] : comprehensive ? [
    ai.fauxToolCall("bash", {
      command: "node tests/item3-silent.cjs; printf 'LOOP_CONTINUED\\n'; node tests/item3-active-stdout.cjs; node tests/item3-file-active.cjs --outputFile logs/activity.log; node tests/item3-file-replace.cjs --outputFile logs/replace.log; true",
    }, { id: "silent-loop" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-busy-silent.cjs" }, { id: "busy-silent" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-post-summary.cjs" }, { id: "post-summary" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-active-stderr.cjs" }, { id: "active-stderr" }),
    ai.fauxToolCall("bash", { command: `${quotedNode} tests/item3-unsupported.cjs` }, { id: "unsupported-absolute" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-success.cjs" }, { id: "ordinary-success" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-capture-secret.cjs --outputFile logs/capture-secret.log" }, { id: "capture-secret-success" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-fail.cjs" }, { id: "ordinary-failure" }),
    ai.fauxToolCall("bash", { command: "cd sub && node tests/item3-cwd.cjs" }, { id: "cwd-semantics" }),
    ai.fauxToolCall("bash", { command: "command node tests/item3-success.cjs" }, { id: "command-prefix" }),
    ai.fauxToolCall("bash", { command: "exec node tests/item3-success.cjs" }, { id: "exec-prefix" }),
    ai.fauxToolCall("bash", { command: "printf PIPE_INPUT | node tests/item3-stdin.cjs" }, { id: "stdin-pipe" }),
    ai.fauxToolCall("bash", { command: "node <<'SCRIPT'\nconsole.log('HEREDOC_INPUT_OK')\nconst literal = 'node tests/not-a-command.cjs'\nSCRIPT" }, { id: "heredoc-stdin" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-session.cjs" }, { id: "session-context" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-undeclared-log.cjs" }, { id: "undeclared-file-writer" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-silent.cjs; node tests/item3-noisy.cjs; true" }, { id: "trailing-noise" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-oversize-artifact.cjs; node tests/item3-tamper-artifact.cjs \"$PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT\"; true" }, { id: "artifact-tamper" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-silent.cjs; node tests/item3-post-summary.cjs; true" }, { id: "two-cancellations" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-giant-secret.cjs" }, { id: "giant-secret" }),
    ai.fauxToolCall("bash", {
      command: `node tests/item3-silent.cjs --outputFile logs/junction/log.txt; node tests/item3-junction-switch.cjs '${String(process.env.ITEM3_OUTSIDE_DIR).replace(/\\/g, "/")}' logs/junction; true`,
    }, { id: "junction-seal" }),
    ai.fauxToolCall("bash", {
      command: `if false; then node tests/item3-success.cjs; fi; ${quotedNode} tests/item3-unsupported.cjs`,
    }, { id: "unexecuted-branch-observe-only" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-writev-busy.cjs logs/writev-cjs.log" }, { id: "writev-cjs" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-writev-busy.mjs logs/writev-esm.log" }, { id: "writev-esm" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-counter-operations.cjs logs/counter-ops.log" }, { id: "counter-operations" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-worker-thread-writer.cjs logs/worker-thread.log" }, { id: "worker-thread-writer" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-sync-busy-writer.cjs logs/sync-busy.log" }, { id: "sync-busy-writer" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-closed-observer-writer.cjs logs/closed-observer.log" }, { id: "closed-observer-writer" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-same-size-writer.cjs logs/same-size.log --outputFile logs/same-size.log" }, { id: "same-size-writer" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-renamed-handle-writer.cjs logs/open-handle.log --outputFile logs/open-handle.log" }, { id: "renamed-handle-writer" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-argument-writer.cjs logs/argument-selected.log" }, { id: "argument-selected-writer" }),
    ai.fauxToolCall("bash", { command: "npm run test:wrapper" }, { id: "package-wrapper" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-descendant-parent.cjs logs/descendant.log" }, { id: "descendant-writer" }),
    ai.fauxToolCall("bash", { command: "PATH=\"$PATH:/item3-path-suffix\" node tests/item3-path.cjs" }, { id: "path-edit" }),
    ai.fauxToolCall("bash", { command: "NODE_OPTIONS='--require ./tests/item3-preload.cjs' node tests/item3-preload-target.cjs" }, { id: "node-options-once" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-escaped-output.cjs" }, { id: "escaped-output" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-oversize-artifact.cjs" }, { id: "oversize-artifact" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-multibyte.cjs" }, { id: "multibyte-output" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-leaf-link-writer.cjs logs/leaf-link.log --outputFile logs/leaf-link.log" }, { id: "leaf-link-output" }),
  ] : gateCaptureBoundary ? [
    ai.fauxToolCall("bash", { command: "node tests/item3-capture-boundary.cjs --outputFile logs/capture-boundary.log" }, { id: "gate-capture-boundary" }),
  ] : gateOwnerFollowup ? [
    ai.fauxToolCall("bash", {
      command: "node tests/item3-nested-capture-wrapper.cjs; node tests/item3-file-replace.cjs --outputFile logs/replace.log",
    }, { id: "gate-owner-followup" }),
  ] : gateNestedCapture ? [
    ai.fauxToolCall("bash", { command: "node tests/item3-nested-capture-wrapper.cjs" }, { id: "gate-nested-capture" }),
  ] : gateCounterOnly ? [
    ai.fauxToolCall("bash", { command: "node tests/item3-busy-silent.cjs" }, { id: "gate-busy-silent" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-silent.cjs" }, { id: "gate-idle-silent" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-undeclared-log.cjs" }, { id: "gate-undeclared-writer" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-writev-busy.cjs logs/gate-writev-cjs.log" }, { id: "gate-writev-cjs" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-writev-busy.mjs logs/gate-writev-esm.log" }, { id: "gate-writev-esm" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-worker-thread-writer.cjs logs/gate-worker-thread.log" }, { id: "gate-worker-thread" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-same-size-writer.cjs logs/gate-same-size.log" }, { id: "gate-same-size" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-renamed-handle-writer.cjs logs/gate-renamed-handle.log" }, { id: "gate-renamed-handle" }),
    ai.fauxToolCall("bash", { command: "node tests/item3-argument-writer.cjs logs/gate-argument.log" }, { id: "gate-argument-selected" }),
  ] : [
    ai.fauxToolCall("bash", {
      command: "node tests/item3-silent.cjs; printf 'LOOP_CONTINUED\\n'; true",
    }, { id: "silent-loop" }),
  ];
  faux.setResponses([
    ai.fauxAssistantMessage(calls, { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("The command completed normally and no cancellation occurred.", { stopReason: "stop" }),
  ]);
  session.agent.streamFunction = faux.streamSimple;
  if (artifactTamperFocused || comprehensive || gateCounterOnly || gateCaptureBoundary || gateNestedCapture || gateOwnerFollowup) session.agent.toolExecution = "sequential";

  try {
    const prompt = await readPrompt();
    await session.prompt(prompt || "item3 real-dispatch probe");
    const toolResults = events
      .filter((event) => event.type === "message_end" && event.message?.role === "toolResult")
      .map((event) => ({
        toolCallId: event.message.toolCallId,
        isError: event.message.isError,
        text: textOf(event.message.content),
        details: event.message.details,
      }));
    const recordFile = process.env.ITEM3_LAUNCH_RECORDS;
    if (recordFile) {
      fs.appendFileSync(recordFile, `${JSON.stringify({
        launcher: process.env.ITEM3_LAUNCHER_KIND,
        role: process.env.ITEM3_ROLE,
        extensions: loadedExtensions.map((entry) => path.basename(entry)),
        testAuthorizationSha256: process.env.PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256,
        tools,
        modelCalls: faux.state.callCount,
        alarms: events
          .filter((event) => event.type === "tool_execution_update" && event.partialResult?.details?.noOutputAlarm)
          .map((event) => event.partialResult.details.noOutputAlarm),
        toolResults,
      })}\n`, "utf8");
    }
  } finally {
    session.dispose();
    await ownerFollowupAdapter?.restore();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
