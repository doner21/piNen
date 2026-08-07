---
name: orchestration-builder
description: Enter orchestration mode to compose, build, run, or repair bespoke orchestration workflows with the deterministic orchestrate system. This skill should be used when the user asks to "build an orchestration", "build me a shape", "build a shape for this", "orchestration builder", "create a reusable workflow/paradigm", or "repair/fix/update an existing orchestration shape or workflow". Default reusable builds are declarative, immediately usable, and require no reload; native TypeScript shapes are explicit exceptions.
---

# Orchestration Builder

Enter **ORCHESTRATOR** mode. Design and coordinate the requested orchestration;
do not perform the user's main task directly.

Use the stable `orchestrate` tool as the deterministic spine. Treat ordinary
orchestration workflows as data consumed by that spine, not as extensions
compiled into Pi.

## Core Rules

- Keep the visible agent in the orchestrator role.
- Route planning, execution, and verification through `orchestrate` subagents.
- Use machine checks and the returned verifier verdict as the finish line.
- Repair a failing requested workflow instead of silently substituting another
  workflow or doing the main task directly.
- Honor user-specified model/provider routes. Omit route overrides when the user
  does not specify them.
- Preserve unrelated dirty work. Do not commit or push unless separately
  authorized.
- Do not create role-integrity ledgers, closeout paperwork, or evidence folders.
  Use the orchestrate run state and plain-language reporting already produced by
  the tool.

## Choose the Correct Path

Classify the request before invoking a builder.

### Path A — Compose a one-off flow

Choose Compose when an existing flexible shape can express the requested phases
and the user does not need a named reusable artifact.

Prefer `composable-pipeline` for flows such as:

```text
research x3 → hypothesize x2 → critique → synthesize → plan → execute → verify
```

Run the composed task directly. Do not create a workflow artifact and do not
reload Pi.

### Path B — Build a reusable declarative workflow (default)

Choose Declarative Build when the user asks for a new named/reusable
orchestration arrangement built from bounded roles, prompts, dependencies, and
agent phases.

Interpret phrases such as **"build me a shape"**, **"build a new orchestration
shape"**, and **"create a reusable paradigm"** as declarative by default. Do not
infer native TypeScript merely from the word "shape".

Declarative builds:

- publish one versioned `.workflow.json` artifact;
- resolve on every `orchestrate` invocation;
- validate, discover, and canary in the same Pi process;
- return `usable: true` and `reloadRequired: false` on success;
- require no static import, registry edit, generated TypeScript, or Pi reload.

### Path C — Repair an existing workflow or shape

Choose Repair when the user names an existing workflow/shape and asks to fix,
update, harden, extend, or change its behavior.

Resolve and classify the target before editing:

1. **Declarative workflow** — user/project `.workflow.json`; repair without
   reload.
2. **Native/built-in shape** — TypeScript extension code; repair through PEV,
   then reload/restart once after verified code changes.
3. **One-off composition** — no durable artifact; revise the composition prompt
   or build a new declarative workflow if persistence is requested.

Never call `shape-builder` with the same name and a differing spec as an update
mechanism. Ordinary builder publication intentionally refuses to overwrite a
different existing artifact. Use the Repair flow below.

### Path D — Build native extension/substrate code (explicit exception)

Choose Native Build only when the workflow cannot be represented as bounded
data and genuinely needs new executable substrate behavior, host integration,
custom scheduling semantics, machine locks, lifecycle hooks, or extension APIs.

Require an explicit decision or state the need clearly. Set:

```json
"artifactKind": "native-shape"
```

Native shapes retain TypeScript generation, static registration, independent
verification, and a one-time reload/restart before runtime discovery and
canary. Do not use Native Build merely because a declarative workflow is
complex.

## Intake

Before acting:

1. Restate the task and the physical or machine-verifiable success condition.
2. Identify whether the request is Compose, Declarative Build, Repair, or Native
   Build.
3. Determine scope:
   - use `"project"` when the workflow is specific to the current project;
   - use `"user"` when it should be available across projects;
   - ask only when this distinction is materially ambiguous.
4. Define finite phases, dependencies, maximum subagents, termination, evidence,
   and failure behavior.
5. State the selected path and why.

## Compose Flow

1. Express the requested phases and counts in the task text.
2. Invoke:

```text
orchestrate(
  task: "<task plus explicit phase composition>",
  paradigm: "composable-pipeline"
)
```

3. Report the run verdict and what was verified.

## Declarative Build Flow

### 1. Design a strict builder spec

Use safe lowercase kebab-case and the current schema:

```json
{
  "schemaVersion": 1,
  "action": "build",
  "artifactKind": "declarative-workflow",
  "scope": "project",
  "targetName": "safe-kebab-name",
  "purpose": "What reusable orchestration this implements",
  "phases": [
    {
      "name": "plan",
      "role": "planner",
      "agentName": "planner",
      "prompt": "Produce a bounded implementation plan.",
      "expectedOutput": "A concrete plan with success and failure checks."
    },
    {
      "name": "execute",
      "role": "executor",
      "agentName": "coder",
      "prompt": "Implement the approved plan and run machine checks.",
      "expectedOutput": "Changed files and observed test results."
    },
    {
      "name": "verify",
      "role": "verifier",
      "agentName": "reviewer",
      "prompt": "Independently inspect the result and return PASS or FAIL.",
      "expectedOutput": "A grounded verdict with concrete reasons."
    }
  ],
  "maxSubagents": 3,
  "maxIterations": 1,
  "terminationCondition": "Stop after the finite phase list completes.",
  "evidenceModel": "Source inspection plus task-specific machine checks.",
  "failureBehavior": "Fail if any required phase or verification check fails.",
  "userFacingExplanation": "Plan, implement, and independently verify the task."
}
```

Keep 1–8 sequential phases, `maxSubagents` from 1–20, and
`maxIterations: 1`. Avoid unknown fields, duplicate normalized phase names,
unbounded-loop language, sibling imports, and runtime-control calls.

### 2. Build through `shape-builder`

Invoke:

```text
orchestrate(
  task: "SHAPE_BUILDER_SPEC_JSON\n<strict JSON spec>",
  paradigm: "shape-builder"
)
```

Require all of the following before calling the workflow usable:

- `status: pass`
- `implemented_verified: true`
- `lifecycleStatus: canary_passed`
- `usable: true`
- `reloadRequired: false`
- source scope/path, schema version, content hash, and canary evidence

If the destination already contains a different artifact, stop the Build path
and switch to Repair. Do not delete or overwrite it blindly.

### 3. Run immediately

Invoke the new workflow in the same Pi session:

```text
orchestrate(
  task: "<the user's actual task>",
  paradigm: "<targetName>"
)
```

Use the agreed model routing and limits. No reload handoff is needed.

## Existing Declarative Workflow Repair Flow

### 1. Reproduce and identify

Start with a concrete defect statement:

- workflow name;
- project cwd;
- input that exposes the defect;
- observed behavior;
- expected behavior;
- machine-verifiable regression condition.

Resolve the workflow with a zero-spawn canary:

```text
orchestrate(
  task: "SHAPE_CANARY",
  paradigm: "<workflow-name>",
  cwd: "<project cwd>",
  preflight: false
)
```

Record the selected scope, source path, schema version, content hash, and
snapshot hash. Project scope has precedence over user scope. A present but
invalid project artifact must fail closed rather than falling back to a user
artifact.

Default artifact roots are:

- user: `~/.pi/orchestrator-workflows/<name>.workflow.json`
- project: `<cwd>/.pi/orchestrator-workflows/<name>.workflow.json`

### 2. Repair through a safe PEV route

Do not use the broken target workflow to repair itself. Invoke
`plan-execute-verify` with a task that tells subagents to:

1. inspect the resolved artifact and reproduce the defect;
2. preserve the workflow name and intended scope unless migration is explicit;
3. modify only the exact workflow artifact and focused tests/docs when needed;
4. keep the schema strict and all limits finite;
5. validate the JSON/IR and run relevant focused/full tests;
6. report old and new content hashes and exact observed results.

Use an exact predicted write set when practical. Do not permit executors to edit
Pi's globally installed package or core patches.

### 3. Canary the repaired artifact

After PEV returns PASS, invoke the zero-spawn canary again in the same Pi
session. Require:

- the same intended workflow name and scope;
- a new content hash when behavior changed;
- strict validation and `canary: true`;
- zero subagent spawn for the canary.

No reload is required. Invocation-time resolution reads the repaired artifact on
the next call.

### 4. Run a fresh regression

Start a **new** workflow run using the minimal previously failing task, then run
the user's actual task if different.

Do not resume an in-progress pre-repair run to test the repair. Resume is
intentionally pinned to the old validated snapshot so source changes cannot
silently alter a running orchestration.

### 5. Report

Report:

- workflow name and scope;
- source path;
- old and new content hashes;
- PEV verdict;
- canary verdict;
- minimal regression result;
- whether anything remains unverified.

## Native Shape Build or Repair Flow

Use a PEV implementation task to create or repair native TypeScript and tests.
Require source inspection and the extension's focused/full test suites. For a
new native shape, use `shape-builder` with `artifactKind: "native-shape"`.

After independent PASS:

1. schedule a continuation;
2. reload/restart the affected Pi process once;
3. read reload diagnostics first on continuation;
4. verify runtime discovery;
5. run `SHAPE_CANARY:<name>`;
6. only then run product work through the native shape.

Treat this reload as activation of changed extension code, not as the ordinary
declarative workflow lifecycle.

## Retry Policy

- Fix a concrete product/workflow defect and rerun the same requested route.
- Use materially different diagnosis when a retry repeats the same failure.
- Do not switch shapes merely to manufacture PASS.
- Involve the user only for a subjective scope decision, destructive action,
  unavailable credential/hardware, or sustained no-progress requiring a real
  scope tradeoff.

## Prompt Patterns to Recognize

Treat these as Declarative Build requests:

```text
Build a reusable project-scoped orchestration shape named release-evidence-loop
for this project. Have it research, plan, execute, and independently verify the
release. Canary it and run it immediately. Use declarative workflow mode; do not
use native-shape unless a new substrate capability is genuinely required.
```

Treat these as Declarative Repair requests:

```text
Repair the existing orchestration workflow release-evidence-loop in
C:/path/to/project. When given <failing input>, it currently <observed failure>;
it should <expected behavior>. Use the declarative repair flow: resolve and
record its current provenance/hash, reproduce the defect, repair it through PEV,
run focused tests, canary it in the same session, and start a fresh regression
run. Preserve its name and project scope. No reload.
```

Treat these as Native Repair requests only when explicitly appropriate:

```text
Repair the native orchestration shape exclusive-machine-lane. The defect is in
its cross-process machine-lock substrate, not its phase prompts. Use PEV, run the
full extension tests, reload once after independent PASS, then run its native
canary and the regression task.
```

## Completion

Summarize the selected path, workflow/shape name and scope, lifecycle state,
verification verdict, canary result, task result, and genuinely unverified
items. State clearly whether a reload was required and why.
