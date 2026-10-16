#!/usr/bin/env node
/** Round 7 AB: supervised pause acknowledgement and explicit abandonment UX. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_MODULES = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));

(async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ab-runs-"));
  process.env.PI_ORCHESTRATOR_RUNS_ROOT = runsRoot;
  try {
    const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
    const orchestrator = jiti(path.join(ROOT, "src", "index.ts"));
    assert.equal(typeof orchestrator.createSupervisedPauseInteraction, "function", "AB interaction seam must exist");

    let now = 10_000;
    const rendered = [];
    const notified = [];
    const confirms = [];
    let abandonCount = 0;
    let confirmAnswer = false;
    const interaction = orchestrator.createSupervisedPauseInteraction({
      now: () => now,
      render: (snapshot) => rendered.push(snapshot),
      notify: (message) => notified.push(message),
      confirm: async (title, message) => {
        confirms.push({ title, message });
        return confirmAnswer;
      },
      abandon: () => { abandonCount += 1; },
    });

    assert.equal(interaction.handleTerminalInput("\x1b"), false, "Escape before a settling pause remains owned by Pi");
    interaction.acknowledge({ phase: "supervised-task-2", agentName: "coder", pid: 4321 });
    assert.match(notified[0], /Pause acknowledged immediately/i);
    assert.match(rendered.at(-1).message, /supervised-task-2/);
    assert.match(rendered.at(-1).message, /settling 0\.0s/);
    assert.match(rendered.at(-1).message, /Escape again/i);
    assert.match(rendered.at(-1).message, /partial files?/i);

    now += 1_450;
    interaction.refresh();
    assert.match(rendered.at(-1).message, /settling 1\.4s/, "elapsed settling wait remains visible as time advances");

    const declined = interaction.handleTerminalInput("\x1b");
    assert.equal(declined, true, "second Escape is intercepted for explicit confirmation");
    await interaction.whenConfirmationSettled();
    assert.equal(abandonCount, 0, "declining confirmation preserves settle-on-abort waiting");
    assert.equal(confirms.length, 1);
    assert.match(confirms[0].title, /Confirm and abandon/i);
    assert.match(confirms[0].message, /partial files?/i);
    assert.match(confirms[0].message, /continue waiting/i);

    confirmAnswer = true;
    assert.equal(interaction.handleTerminalInput("\x1b"), true);
    await interaction.whenConfirmationSettled();
    assert.equal(abandonCount, 1, "abandonment occurs only after affirmative confirmation");

    interaction.settled();
    const renderedAtSettlement = rendered.length;
    now += 2_000;
    interaction.refresh();
    assert.equal(rendered.length, renderedAtSettlement, "settlement clears the transient wait state");
    assert.equal(interaction.handleTerminalInput("\x1b"), false, "Escape ownership returns to Pi after settlement");

    const source = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
    assert.match(source, /settleOnAbort:\s*true/, "safe first-Escape settlement policy remains enabled");
    assert.match(source, /onTerminalInput/, "command uses supported raw-input composition rather than replacing custom editors");
    assert.doesNotMatch(source, /setEditorComponent\(/, "AB must not overwrite an existing custom editor");

    console.log("test-round7-defect-ab: immediate pause acknowledgement, elapsed wait, explicit abandonment confirmation, and settlement cleanup passed");
  } finally {
    delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
