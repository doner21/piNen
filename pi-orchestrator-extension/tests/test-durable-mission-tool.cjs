#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(PROJECT_ROOT, "node_modules");
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const mission = jiti(path.join(PROJECT_ROOT, "src", "mission", "index.ts"));
const missionTool = jiti(path.join(PROJECT_ROOT, "src", "mission", "tool.ts"));

(async () => {
  const loadProbe = spawnSync(process.execPath, [path.join(__dirname, "fixtures", "durable-mission-load-without-process-inspection.cjs")], {
    cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true,
  });
  assert.equal(loadProbe.status, 0, `${loadProbe.stdout}\n${loadProbe.stderr}`);
  assert.match(loadProbe.stdout, /PASS extension load/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-mission-tool-"));
  try {
    const cwd = path.join(root, "workspace");
    const runsRoot = path.join(root, "runtime");
    const sessionRoot = path.join(root, "sessions");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "validate.cjs"), [
      "const fs = require('node:fs');",
      "const actual = fs.existsSync('product.txt') ? fs.readFileSync('product.txt', 'utf8') : '';",
      "if (actual !== 'fixed\\n') { console.error('not fixed'); process.exit(2); }",
      "console.log('PASS');",
    ].join("\n"));
    const factory = new mission.ScriptedMissionWorkerFactory({
      sessionRoot,
      turns: [
        { mutations: [{ path: "product.txt", content: "fixed\n" }], throwMessage: "simulated controller transport loss" },
        { events: [{ type: "settled", cursor: "resumed-cursor", tokens: 25 }] },
      ],
    });
    const tools = new Map();
    const fakePi = {
      registerTool(definition) { tools.set(definition.name, definition); },
      getThinkingLevel() { return "high"; },
    };
    missionTool.registerDurableMissionTool(fakePi, {
      runsRoot: () => runsRoot,
      createWorkerFactory: () => factory,
    });
    const tool = tools.get("orchestrate_mission");
    assert.ok(tool, "opt-in durable mission tool must register");
    const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-5.5" } };
    const updates = [];
    const first = await tool.execute("tool-1", {
      action: "run",
      runId: "tool-crash-resume",
      objective: "Create product.txt containing exactly fixed followed by one newline.",
      maxTurns: 3,
      maxRestarts: 2,
      validator: "node-workspace-validator",
      validatorTimeoutMs: 2_000,
      validatorMaxOutputBytes: 8_192,
    }, undefined, (update) => updates.push(update), ctx);
    assert.equal(first.details.status, "pending");
    assert.equal(first.details.state, "PAUSED");
    assert.equal(first.details.projectedNextAction, "resume-worker");
    assert.ok(updates.some((update) => update.details.event === "worker.started"));
    assert.equal(fs.readFileSync(path.join(cwd, "product.txt"), "utf8"), "fixed\n");

    const inspected = await tool.execute("tool-2", { action: "inspect", runId: "tool-crash-resume" }, undefined, undefined, ctx);
    assert.equal(inspected.details.state, "PAUSED");
    assert.equal(inspected.details.safeAction.code, "resume-mission");
    assert.match(inspected.content[0].text, /Safe action: resume-mission/);

    await assert.rejects(
      () => tool.execute("tool-bad-resume", { action: "resume", runId: "tool-crash-resume", objective: "drift" }, undefined, undefined, ctx),
      /restores pinned inputs/,
    );
    const resumed = await tool.execute("tool-3", { action: "resume", runId: "tool-crash-resume" }, undefined, undefined, ctx);
    assert.equal(resumed.details.status, "pass");
    assert.equal(resumed.details.state, "SUCCEEDED");
    assert.equal(resumed.details.validator.status, "pass");
    assert.equal(resumed.details.safeAction.code, "none");
    assert.equal(factory.prompts.length, 2);
    assert.equal(new Set(factory.sessions.map((identity) => identity.sessionId)).size, 1, "public resume must reopen the exact primary session");

    const terminalInspection = await tool.execute("tool-4", { action: "inspect", runId: "tool-crash-resume" }, undefined, undefined, ctx);
    assert.equal(terminalInspection.details.state, "SUCCEEDED");
    assert.equal(terminalInspection.details.status, "succeeded");
    assert.equal(terminalInspection.details.safeAction.code, "none");
    assert.equal(fs.existsSync(path.join(cwd, "events.jsonl")), false, "public tool runtime must remain outside product workspace");

    const sessionsBeforeAbort = factory.sessions.length;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await tool.execute("tool-abort", {
      action: "run", runId: "tool-pre-aborted", objective: "Create no additional changes.", validator: "node-workspace-validator",
    }, controller.signal, undefined, ctx);
    assert.equal(cancelled.details.status, "cancelled");
    assert.equal(cancelled.details.state, "CANCELLED");
    assert.equal(factory.sessions.length, sessionsBeforeAbort, "pre-aborted public invocation must not open a worker");

    console.log("PASS durable-mission tool: opt-in registration, pinned inspection/resume, exact session recovery, abort, progress, and terminal validation");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
