# NenFlow v3 Retirement — 2026-07-18

NenFlow v3 and its model-driven `pev-*` loop are retired. The deterministic
orchestration system (`/orchestrate`, provided by
`~/.pi/pi-orchestrator-extension`) is the supported orchestration path. It owns
intake, planning, execution, verification, retries, checkpointing, and bounded
shape dispatch in code without depending on NenFlow.

## Public piNen state

The sanitized distribution does **not** ship:

- `/nenflow_v3` or `/pev` compatibility prompts;
- `nenflow-v3` / `nenflow-pev-*` skills;
- `pev-*` agent profiles;
- the retired NenFlow extension or runtime directory;
- historical NenFlow runs, schemas, templates, or private restore artifacts.

If a user asks for NenFlow or PEV orchestration, route the task through
`/orchestrate` instead.

## Current equivalents

| Retired behavior | Current path |
|---|---|
| planner → executor → verifier loop | `plan-execute-verify` shape |
| multiple independent verifiers | `multi-verify-vote` |
| ad hoc multi-phase workflow | `composable-pipeline` |
| verification without execution | `verify-only` |
| new reusable shape design/build | `paradigm-creator` + `shape-builder` |
| global Graphify maintenance roles | `gm-planner`, `gm-executor`, `gm-verifier` |

The `orch-*` specialist sidecars remain available around deterministic runs.
The `spec-driven-ecology` skill remains a standalone intake method but does not
invoke NenFlow.

## Operating policy

Direct mode is the default for ordinary work. When the user explicitly asks for
orchestration, use `/orchestrate`, coordinate its subagents, and rely on the
shape's built-in reports and gates. Do not recreate retired role ledgers or
other NenFlow paperwork.
