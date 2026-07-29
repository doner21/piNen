---
name: orchestration-builder
description: Enter orchestration mode and build a bespoke orchestration shape for the user's task using the paradigm-creator and shape-builder orchestrate tools, then run the task through it. Use when the user asks to "build an orchestration", "orchestration builder", "build a shape for this", "set up a bespoke orchestration", "create a paradigm/shape", or wants the agent to become an orchestrator that designs a custom multi-agent loop (e.g. research → hypothesize → critique → synthesize → plan → execute → verify) for a specific task.
---

# Orchestration Builder Skill

When this skill is invoked, enter explicit **orchestration mode**. The current
agent coordinates the work: it designs or selects a bounded shape, invokes the
orchestrator, follows lifecycle/reload requirements, and reports the observed
result. Do not quietly execute the user's main task directly while claiming it
was delegated.

Use the existing orchestration machinery without adding role ledgers, pin maps,
receipts, or custom closeout documents beyond artifacts produced by the selected
shape.

## Primary instruments

- **`composable-pipeline`** — a one-off phase composition such as
  hypothesize → critique → synthesize → plan → execute → verify.
- **`paradigm-creator`** — conservative propose-only assessment of a reusable
  paradigm.
- **`shape-builder`** — deterministic constructor that writes, tests,
  independently verifies, and lifecycle-gates a reusable shape.

## Model routing

Honor any model/provider choices named by the user. Pass explicit
`plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`, and
`verifierModel`/`verifierProvider` overrides only for roles the user specified;
omit unspecified routes so configured defaults apply.

## Decision: compose or build

### Compose

Choose `composable-pipeline` when an existing flexible shape can express the
requested flow or when the workflow is one-off. Composition needs no source
mutation or runtime reload.

Example:

```text
orchestrate(
  task: "<task plus explicit phase composition>",
  paradigm: "composable-pipeline"
)
```

### Build

Choose the Build path only when the user wants a **new named reusable shape** or
no existing shape can represent the required control flow. Building writes
TypeScript/test/registry/docs artifacts and therefore requires independent
verification plus reload/discovery/canary before the shape is usable.

State the selected path and why before invoking it.

## Build flow

### 1. Create the shape specification

Prepare strict `SHAPE_BUILDER_SPEC_JSON`:

```json
{
  "schemaVersion": 1,
  "action": "build",
  "targetName": "safe-kebab-name",
  "purpose": "what reusable loop this implements",
  "phases": [
    {
      "name": "phase-name",
      "role": "executor",
      "agentName": "coder",
      "prompt": "bounded phase instruction",
      "expectedOutput": "concrete output"
    }
  ],
  "maxSubagents": 3,
  "maxIterations": 1,
  "terminationCondition": "finite stopping rule",
  "evidenceModel": "what evidence proves completion",
  "failureBehavior": "what makes the shape fail",
  "userFacingExplanation": "how to explain this shape"
}
```

Constraints:

- safe kebab-case name that is not reserved or already registered;
- at most eight finite phases;
- `maxIterations` exactly `1` for generated V1 shapes;
- no unbounded-loop language;
- no sibling-shape imports;
- phase prompts must be self-contained and produce inspectable outputs.

### 2. Assess with `paradigm-creator`

Run an explicit `paradigm-creator` orchestration for the design intent. It is
propose-only and does not write source. If confidence/spec validation fails,
refine the specification and reassess. Ask the user only when the remaining
issue is a material subjective design choice.

### 3. Build with `shape-builder`

```text
orchestrate(
  task: "SHAPE_BUILDER_SPEC_JSON\n<spec JSON>",
  paradigm: "shape-builder"
)
```

Require the shape-builder's independent verifier PASS. Do not infer success from
executor prose. Capture the returned `targetName`, `lifecycleStatePath`, and
`reloadRequired` values from the tool result.

### 4. Reload correctly

A newly written TypeScript shape is not usable until runtime reload:

1. Persist a concise continuation containing the target shape name, lifecycle
   state path, original task, and next action.
2. Schedule that continuation with `agent_scheduler` **before** reload (normally
   75–90 seconds).
3. Call `agent_reload_runtime` and stop immediately.
4. On continuation, first read
   `<PI_HOME>/agent/agent-reload-diagnostics.json`. Continue only when
   `phase` is `done` and `reloadConfirmed` is true. If reload silently failed,
   tell the user to run `/agent-reload-runtime` manually.

### 5. Discover and canary

After a confirmed reload:

1. Confirm the active runtime discovers the new paradigm.
2. Run its deterministic `SHAPE_CANARY:<targetName>` path.
3. Treat the shape as usable only after lifecycle state reaches
   `canary_passed`.

### 6. Run the task

Invoke the new shape against the user's actual task with agreed route overrides.
Use its own machine checks and verifier result as the outcome.

## Failure recovery

A correct failing check gets fixed, not documented around. Diagnose whether the
defect is in the product, generated shape, registry/docs edit, runtime reload,
or test. Repair the specific defect and re-run while there is material progress.
Use independent diagnosis, a materially different approach, provider/model
fallback, or reversible scope reduction where useful.

Involve the user only for a material subjective choice, irreversible action,
unavailable credential/hardware, or sustained no-progress requiring a concrete
scope-backout decision.

## Context continuity

Use `context_usage` during long build/reload cycles. At the configured high-water
mark (85% by default), finish the current step, persist the compact continuation,
schedule it, and resume in a fresh session rather than starting another large
phase.

## Completion

Report plainly:

- Compose or Build path and the shape used;
- for Build: target name and lifecycle state;
- concrete files/artifacts produced by the tool;
- machine checks run and their observed results;
- task PASS/FAIL and any genuinely unverified item.
