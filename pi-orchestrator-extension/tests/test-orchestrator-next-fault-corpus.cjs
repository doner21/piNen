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
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const next = jiti(path.join(PROJECT_ROOT, "src", "next", "index.ts"));

function info(summary) {
  return { summary, data: {} };
}

function verification(status) {
  return {
    status,
    summary: `fixture ${status}`,
    checks: [{ id: "fixture", status, evidence: ["seeded corpus"] }],
    remaining: status === "pass" ? [] : ["repair"],
  };
}

function spec({ gate = false, retry = true } = {}) {
  return {
    schemaVersion: 2,
    name: gate ? "fault-gate" : retry ? "fault-retry" : "fault-single",
    inputs: { task: { type: "string", required: true } },
    defaults: { timeoutMs: 1_000, maxAttempts: 1 },
    limits: { maxConcurrency: 1, maxTotalAttempts: retry ? 2 : 1 },
    phases: [{
      id: "work",
      kind: "agent",
      role: gate ? "verifier" : "reviewer",
      agent: { name: "reviewer" },
      access: "read-only",
      workspace: { mode: "shared" },
      resultMode: gate ? "gate" : "informational",
      outputSchema: gate ? "verification-v1" : "informational-v1",
      input: { task: "${inputs.task}" },
      ...(retry ? { retry: { on: ["launch-failure", "provider-transient", "protocol-failure"], maxAttempts: 2 } } : {}),
    }],
    completion: { terminalPhase: "work", require: gate ? "pass" : "success" },
  };
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

async function main() {
  const iterations = Number.parseInt(process.env.ORCN_FAULT_ITERATIONS || "1000", 10);
  assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 10_000);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "orcn-fault-corpus-"));
  const random = xorshift32(0x5eedc0de);
  const compiledRetry = next.compileWorkflow(spec({ retry: true }));
  const compiledGate = next.compileWorkflow(spec({ gate: true, retry: false }));
  const counts = { pass: 0, retry: 0, protocolRetry: 0, semanticFail: 0, authorizationFail: 0, cancelled: 0 };
  const started = process.hrtime.bigint();
  try {
    for (let index = 0; index < iterations; index++) {
      const pick = random();
      const runId = `fault-${index}`;
      let compiled = compiledRetry;
      let script;
      let expectedStatus;
      let expectedCategory;
      let controller;
      if (pick < 0.4) {
        script = { work: [{ events: [{ type: "result", output: info("pass"), exitCode: 0 }] }] };
        expectedStatus = "pass";
        counts.pass++;
      } else if (pick < 0.6) {
        script = { work: [
          { events: [{ type: "failed", category: "provider-transient", message: "seeded overload" }] },
          { events: [{ type: "result", output: info("recovered"), exitCode: 0 }] },
        ] };
        expectedStatus = "pass";
        counts.retry++;
      } else if (pick < 0.75) {
        script = { work: [
          { events: [{ type: "result", output: { summary: 42 }, exitCode: 0 }] },
          { events: [{ type: "result", output: info("schema recovered"), exitCode: 0 }] },
        ] };
        expectedStatus = "pass";
        counts.protocolRetry++;
      } else if (pick < 0.85) {
        compiled = compiledGate;
        script = { work: [{ events: [{ type: "result", output: verification("fail"), exitCode: 0 }] }] };
        expectedStatus = "fail";
        expectedCategory = "semantic-failure";
        counts.semanticFail++;
      } else if (pick < 0.95) {
        script = { work: [{ inspectionEffects: [{ path: `hidden-${index}.txt`, kind: "created" }], events: [{ type: "result", output: info("false read-only"), exitCode: 0 }] }] };
        expectedStatus = "fail";
        expectedCategory = "authorization-violation";
        counts.authorizationFail++;
      } else {
        script = { work: [{ events: [{ type: "result", output: info("must not run"), exitCode: 0 }] }] };
        expectedStatus = "cancelled";
        controller = new AbortController();
        controller.abort(new Error("seeded cancellation"));
        counts.cancelled++;
      }
      const adapter = new next.FakeWorkerAdapter(script);
      const store = new next.MemoryEventStore(runId);
      const result = await new next.RunKernel().run(compiled, {
        runId,
        workspaceRoot: workspace,
        input: { task: `fault corpus ${index}` },
        eventStore: store,
        agentAdapter: adapter,
        ...(controller ? { signal: controller.signal } : {}),
      });
      assert.equal(result.status, expectedStatus, `iteration ${index}`);
      if (expectedCategory) assert.equal(result.phaseOutcomes.work?.category, expectedCategory, `iteration ${index}`);
      const events = store.readAll();
      assert.deepEqual(events.map((event) => event.seq), events.map((_, offset) => offset + 1), `iteration ${index} sequence`);
      assert.doesNotThrow(() => next.projectRun([...events].reverse()), `iteration ${index} replay`);
      const terminals = events.filter((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
      assert.equal(terminals.length, 1, `iteration ${index} terminal count`);
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), iterations);
    console.log(JSON.stringify({
      status: "PASS",
      corpus: "orchestrator-next-seeded-fault-v1",
      seed: "0x5eedc0de",
      iterations,
      invariantFailures: 0,
      durationMs: Number(durationMs.toFixed(1)),
      counts,
    }));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("test-orchestrator-next-fault-corpus: FAIL");
  console.error(error);
  process.exit(1);
});
