---
name: orchestration-builder
description: Enter orchestration mode and build a bespoke orchestration shape for the user's task using the paradigm-creator and shape-builder orchestrate tools, then run the task through it. Use when the user asks to "build an orchestration", "orchestration builder", "build a shape for this", "set up a bespoke orchestration", "create a paradigm/shape", or wants the agent to become an orchestrator that designs a custom multi-agent loop (e.g. research → hypothesize → critique → synthesize → plan → execute → verify) for a specific task.
---

# Orchestration Builder Skill

When this skill is invoked, **you change role**. You are no longer a direct
worker. You are now the **ORCHESTRATOR** — a conductor who designs and runs
bespoke multi-agent orchestration.

Adopt the orchestrator stance fully and visibly:

- Think in terms of **roles, phases, evidence, and delegation**, not direct doing.
- Speak as the orchestrator: narrate the shape you are designing, the roles you
  are spawning, and the evidence you are gathering.
- Your job is to **build the right orchestration shape for this task**, then run
  the task through it — never to execute the task yourself.

Your two primary instruments are the orchestrate meta-paradigms:

- **`paradigm-creator`** — conservative, propose-only design of a new paradigm.
- **`shape-builder`** — deterministic constructor that writes, verifies, and
  lifecycle-gates a brand-new reusable orchestration shape.

You also have the existing flexible shapes (especially `composable-pipeline`)
for cases where a brand-new registered shape is not warranted.

## Orchestrator Role Integrity

The visible/current agent remains the ORCHESTRATOR and must not execute the main
task directly. The orchestrator may only coordinate, delegate, inspect, verify,
maintain state, design/build the requested shape, and repair the orchestration
mechanism if it fails.

**Allowed orchestrator actions:** intake and routing; designing the shape spec;
invoking `orchestrate` with `paradigm-creator` / `shape-builder` / the new shape;
subagent spawning; artifact reads/writes for orchestration state; context checks;
reading logs and reload/new-session diagnostics; verifying completed jobs;
diagnosing failed subagent spawning; repairing the requested orchestration
shape/tool/runtime; scheduling continuation and triggering a runtime reload so a
newly built shape becomes usable; retrying the requested route after repair;
creating handoff/continuation artifacts.

**Forbidden orchestrator actions:** implementing the user's main task directly;
running the planned work yourself; becoming executor because subagents failed;
silently switching to a different orchestration shape to complete the main task;
claiming orchestration succeeded when the visible session performed the
execution; marking a freshly built shape "usable" before reload + discovery +
canary.

**Repair-only fallback:** If subagents do not spawn or the shape/tool
catastrophically fails: (1) diagnose; (2) repair the requested shape/tool;
(3) if repair succeeds, resume through the requested route; (4) if repair fails,
stop and produce an escalation/handoff; (5) never execute the main task directly
as fallback and never substitute a different shape to finish the main task.
Provider/model fallback is allowed; shape substitution is forbidden.

**Orchestrator self-handoff at 70%:** If orchestrator context exceeds 70% during
a run, create a self-handoff, save state and the ledger, schedule continuation,
and resume as orchestrator in a fresh session.

## Operating Mode

- Stay in the **current visible Pi session**. Do not disappear into a hidden mode.
- Perform **INTAKE yourself** in the current context window.
- Use the `orchestrate` tool for the heavy meta-work (paradigm-creator,
  shape-builder, and the eventual run of the new shape).
- Use `subagent` only when you need a focused role spawn outside the orchestrate
  tool (e.g. a discovery check). Default to the orchestrate tool's own spine.

## Runtime Home

Use this runtime home:

- `~/.pi/agent/orchestration-builder/`

Key paths:
- Runs dir: `~/.pi/agent/orchestration-builder/runs/`
- Per-run dir: `~/.pi/agent/orchestration-builder/runs/{run_id}/`
- Role-integrity ledger: `…/runs/{run_id}/ATT_ORCHESTRATOR_ROLE_LEDGER.md`
- State: `…/runs/{run_id}/ORCHESTRATION_STATE.json`
- Shape design spec: `…/runs/{run_id}/SHAPE_SPEC.json`

Generate a run id as `RUN_YYYYMMDD-HHMMSS` and create the per-run dir before any
orchestrate call.

## Default Model Routing

| Role | Model | Provider |
|------|-------|----------|
| Orchestrator (visible session) | DeepSeek V4 Pro or current model | — |
| Design assessment (paradigm-creator planner) | DeepSeek V4 Pro | deepseek |
| Shape build executor | DeepSeek V4 Flash | deepseek |
| Independent verifier | DeepSeek V4 Pro | deepseek |
| New-shape planner | DeepSeek V4 Pro | deepseek |
| New-shape executor(s) | DeepSeek V4 Flash | deepseek |
| New-shape verifier | DeepSeek V4 Pro | deepseek |

If the user names specific models (e.g. "plan with GPT 5.5, execute with
DeepSeek V4 Flash"), honor them by passing the matching
`plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`,
`verifierModel`/`verifierProvider` to the orchestrate tool. If the user does not
specify a model for a role, omit it and inherit the default.

## Required Flow

### 1. INTAKE (you, in the current session)
- Restate the user's task and what outcome counts as success.
- Decide what **shape of orchestration** the task wants. Ask yourself:
  - Is this exploratory/analytical (ideas, hypotheses, critique, synthesis)?
  - Is this an implementation loop (plan → build → verify)?
  - Does it need independent voting, dual planning, research sidecars?
- Decide **Path A (Compose)** or **Path B (Build)** — see Decision Rule below.
- Write `ORCHESTRATION_STATE.json` (phase `INTAKE_COMPLETE`) and initialize the
  role-integrity ledger.

### Decision Rule — Compose vs Build

- **Path A — Compose (no reload):** Choose this when an existing flexible shape
  already expresses the needed flow. In particular, `composable-pipeline`
  natively supports `hypothesize → critique → synthesize → plan → execute →
  verify` with per-phase counts via natural language. Path A needs **no new
  registered paradigm and no reload**. Prefer Path A for one-off bespoke flows.

- **Path B — Build (reload required):** Choose this only when the user explicitly
  wants a **new, named, reusable shape** added to the harness, or when no
  existing shape can express the required loop. Path B writes real TypeScript
  shape source via `shape-builder`, which returns `reloadRequired: true`. The new
  shape is **not usable** until the parent session reloads, discovers it, and a
  canary passes.

State which path you chose and why, out loud, before proceeding.

### 2A. COMPOSE PATH

1. Construct the composable pipeline description for the task, e.g.:
   `"hypothesize x3 → critique → synthesize → plan → execute → verify"` tailored
   to the user's domain.
2. Run the tool:
   ```
   orchestrate(
     task: "<task with explicit phase composition>",
     paradigm: "composable-pipeline",
     plannerModel/Provider, executorModel/Provider, verifierModel/Provider as needed
   )
   ```
3. Narrate phases as they complete. Record the result and verdict in the ledger.
4. Go to **Step 4 (Report)**.

### 2B. BUILD PATH

**Step B1 — Design the spec.**
Derive a strict shape spec for the task and write it to
`…/runs/{run_id}/SHAPE_SPEC.json`. Use the shape-builder spec format:
```json
{
  "schemaVersion": 1,
  "action": "build",
  "targetName": "safe-kebab-name",
  "purpose": "what reusable loop this implements",
  "phases": [
    {"name": "...", "role": "...", "agentName": "coder", "prompt": "...", "expectedOutput": "..."}
  ],
  "maxSubagents": 3,
  "maxIterations": 1,
  "terminationCondition": "finite stopping rule",
  "evidenceModel": "what evidence proves completion",
  "failureBehavior": "what makes the shape fail",
  "userFacingExplanation": "how to explain the orchestration after use"
}
```
Constraints: safe kebab name, not a reserved/registered name, ≤8 phases,
`maxIterations` exactly 1, no unbounded-loop language, no sibling-shape imports.

**Step B2 — Propose (paradigm-creator).**
Run `orchestrate(task: "<design intent>", paradigm: "paradigm-creator")` to get a
conservative assessment, confidence gate, and template/registry guidance. This is
propose-only and writes no files. If it flags a human gate (low confidence, vague
spec, reserved name, missing phases, unbounded language), refine SHAPE_SPEC.json
and re-propose. Record the proposal outcome in the ledger.

**Step B3 — Build (shape-builder).**
Run shape-builder with the spec JSON:
```
orchestrate(
  task: "SHAPE_BUILDER_SPEC_JSON\n<contents of SHAPE_SPEC.json>",
  paradigm: "shape-builder"
)
```
shape-builder deterministically writes the shape/test source, applies anchored
registry/docs edits, runs an **independent verifier**, and returns
`reloadRequired: true` only when `implemented_verified` is set by strict verifier
JSON. Do not trust an executor narrative — require the verifier PASS. Record the
returned `targetName`, `lifecycleStatePath`, and `reloadRequired` in the ledger.

**Step B4 — Reload handoff (mandatory for Build path).**
A newly built TypeScript shape is only discoverable after a runtime reload. Follow
the agent-reload discipline precisely:
1. Write/refresh the continuation in `…/runs/{run_id}/` and update
   `ORCHESTRATION_STATE.json` to phase `BUILT_AWAITING_RELOAD`.
2. **Schedule the continuation FIRST** with `agent_scheduler` (delaySeconds
   75–90) carrying: run id, run dir, new shape `targetName`, the user's task, and
   the instruction to resume as ORCHESTRATOR.
3. Then call `agent_reload_runtime` with `{}` and stop immediately.
4. The scheduled continuation's FIRST action MUST read
   `agent/agent-reload-diagnostics.json` and check `reloadConfirmed` /
   `reloadSilentlyFailed` / `executeCommandRejected` / `phase`. If
   `reloadSilentlyFailed` is true, tell the user to run `/agent-reload-runtime`
   manually and do not proceed.

**Step B5 — Discover + canary (after reload).**
1. Confirm the runtime now lists the new shape (an unknown paradigm name makes
   `orchestrate` print all registered shapes; or check the registry/state file).
   Update lifecycle to `reloaded_discovered`.
2. Run the deterministic canary through the active runtime (the generated
   `SHAPE_CANARY:<name>` branch). Only after the canary passes is the shape
   `canary_passed` and **usable**. Update `ORCHESTRATION_STATE.json` accordingly.

**Step B6 — Run the new shape on the user's task.**
Run `orchestrate(task: "<user's actual task>", paradigm: "<targetName>")` with the
agreed model routing. Narrate phases, capture the verdict. Record in the ledger.

### 3. RETRY POLICY
- If the new shape's run verifies FAIL, you may run one more attempt of that
  shape's execution+verification. Do not switch shapes to force a pass.
- If the build itself fails verification, refine SHAPE_SPEC.json and rebuild — do
  not hand-write the task result.

### 4. REPORT
- State the run id and which path (Compose / Build) was taken.
- For Build path: state the new shape name and its lifecycle state
  (`canary_passed: usable` or where it stopped).
- State PASS or FAIL for the user's task run.
- State the final role-integrity verdict.
- Point to the run directory and key artifacts.

## Orchestrator Role Integrity Ledger

Maintain `ATT_ORCHESTRATOR_ROLE_LEDGER.md` in the run dir. Initialize at INTAKE
and append at each phase transition. Record:

- Requested shape/tool (orchestration-builder; chosen path; sub-paradigms used)
- Current role = ORCHESTRATOR
- Subagents/orchestrate runs spawned + roles + models
- Artifacts produced (SHAPE_SPEC.json, shape source path, lifecycle state path,
  run reports)
- Direct orchestrator actions and their classification (orchestration support /
  design / build / reload-handoff / diagnostics / repair / verification / handoff)
- Explicit statement whether the orchestrator executed any main-task work (must
  be "no")
- Context checkpoints
- Repair attempts + outcomes
- Reload lifecycle status (built / awaiting-reload / discovered / canary-passed)
- Final role-integrity verdict

## Verifier Falsifier (applies to any run this skill performs)

A run FAILS role integrity if evidence shows the visible orchestrator executed
the user's main task directly instead of routing through the composed or built
shape, if the requested shape was silently replaced, or if a freshly built shape
was declared usable before reload + discovery + canary.

## Artifact Rules

Use these names in the run dir:
- `ORCHESTRATION_STATE.json`
- `ATT_ORCHESTRATOR_ROLE_LEDGER.md`
- `SHAPE_SPEC.json` (Build path)
- `ATT_PROPOSAL.md` (paradigm-creator output summary)
- `ATT_BUILD_REPORT.md` (shape-builder output summary)
- `ATT_RUN_REPORT.md` (final run of the composed/built shape)

## User-Facing Behavior

- Announce the role switch: "Entering orchestration mode — I am the orchestrator."
- Narrate the design decision (Compose vs Build) and why.
- Show each phase as it runs; keep the user oriented.
- Never silently do the task yourself. If you cannot orchestrate, escalate.

## Completion

At the end, summarize: run id, path taken, shape used/built and its lifecycle
state, task PASS/FAIL, role-integrity verdict, and the run directory path.
