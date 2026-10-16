#!/usr/bin/env node
/** I only: planner input preserves named deliverables and normalizes validation effects. */
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const orchestrator = jiti(path.join(ROOT, "src", "index.ts"));

const task = [
  "Repair the widget and commit the complete intended candidate.",
  "Deliverables that must be included in the same commit:",
  "- `src/widget.ts`",
  "- `docs/handoffs/phase3-owner.md` (the amended owner-confirmation handoff)",
  "- `docs/reviews/phase3-validation.md` (the current validation review entry)",
  "Exclude unrelated handoffs, caches, diagnostics, and secrets.",
  "First validate the existing candidate without modifying files, then stage and commit all named deliverables.",
].join("\n");

const deliverables = orchestrator.extractTaskDeliverables(task);
assert.deepEqual(deliverables, [
  "src/widget.ts",
  "docs/handoffs/phase3-owner.md",
  "docs/reviews/phase3-validation.md",
], "intake extracts the task's affirmative path deliverables, not unrelated exclusions");

const prompt = orchestrator.buildPlanningPromptForTest(task);
assert.match(prompt, /"deliverables"/i, "planner receives a structured deliverable list");
for (const deliverable of deliverables) {
  assert.match(prompt, new RegExp(deliverable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `planner sees ${deliverable}`);
}

const droppingPlan = JSON.stringify({
  acceptance_criteria: ["The widget and documentation are committed together."],
  tasks: [{
    id: "task-1",
    description: "Stage src/widget.ts. Exclude docs/handoffs and docs/reviews from the commit.",
    dependsOn: [],
    expects_file_change: false,
  }],
  predicted_write_set: ["src/widget.ts"],
  notes: "Leave documentation out of the commit.",
});
assert.deepEqual(orchestrator.plannerDroppedDeliverablesForTest(task, droppingPlan), [
  "docs/handoffs/phase3-owner.md",
  "docs/reviews/phase3-validation.md",
], "broad planner exclusions cannot silently remove named handoff/review deliverables");
assert.throws(
  () => orchestrator.assertPlannerPreservesDeliverablesForTest(task, droppingPlan),
  /PLAN_DROPS_NAMED_DELIVERABLES.*docs\/handoffs\/phase3-owner\.md.*docs\/reviews\/phase3-validation\.md/i,
);

const preservingPlan = JSON.stringify({
  tasks: [{
    id: "task-1",
    description: "Validate first, then include src/widget.ts, docs/handoffs/phase3-owner.md, and docs/reviews/phase3-validation.md in the commit. Exclude unrelated handoffs only.",
    dependsOn: [],
    expects_file_change: false,
  }],
  predicted_write_set: deliverables,
});
assert.deepEqual(orchestrator.plannerDroppedDeliverablesForTest(task, preservingPlan), [],
  "a qualified unrelated-handoff exclusion does not conflict with an explicitly preserved named handoff");

const normalized = orchestrator.parsePlanForTest(JSON.stringify({
  tasks: [
    { id: "validate", description: "Validate the existing candidate and report command evidence without modifying files.", dependsOn: [], expects_file_change: true },
    { id: "commit", description: "Inspect the staged existing bytes, create one commit, and verify its hash; do not edit candidate files.", dependsOn: ["validate"], expects_file_change: true },
    { id: "repair", description: "Add the missing regression test and repair src/widget.ts.", dependsOn: ["validate"], expects_file_change: true },
  ],
}), task);
assert.equal(normalized.tasks[0].expectsFileChange, false, "validation-only task is false even when planner declared true");
assert.equal(normalized.tasks[1].expectsFileChange, false, "commit/verification of existing bytes is content-read-only");
assert.equal(normalized.tasks[2].expectsFileChange, true, "actual implementation keeps explicit mutation expectation");

console.log("test-round3-defect-i: named deliverables preserved; validation tasks normalize to expectsFileChange=false");
