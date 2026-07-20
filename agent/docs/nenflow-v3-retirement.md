# NenFlow v3 Retirement — 2026-07-18

NenFlow v3 (model-driven PEV orchestration) is retired. The **deterministic orchestration
system** (`/orchestrate`, provided by `~/.pi/pi-orchestrator-extension`) is now the standard
orchestration shape. It performs intake (including intake.md), planning, execution, and
verification deterministically in code and does not depend on any NenFlow component.

## What was disabled (all reversible, nothing deleted)

| Component | Before | After |
|---|---|---|
| `/nenflow_v3` prompt | `agent/prompts/nenflow_v3.md` (ran NenFlow) | Deprecation stub redirecting to `/orchestrate`; original in `agent/prompts-retired/` |
| `/pev` prompt | `agent/prompts/pev.md` (NenFlow alias) | Deprecation stub redirecting to `/orchestrate`; original in `agent/prompts-retired/` |
| Orchestrator skill | `agent/skills/nenflow-v3/` | Moved to `agent/skills-retired/nenflow-v3/` |
| Role skills | `agent/skills/nenflow-pev-{intake,researcher,planner,executor,verifier}/` | Moved to `agent/skills-retired/` |
| PEV agents | `agent/agents/pev-{researcher,planner,executor,verifier,intake-ecological}.json` | Renamed to `.json.disabled` |
| Extension stub | `agent/extensions/nenflow-v3.ts` (already no-op) | Renamed to `.ts.disabled` |

## Migration: global-graphify-maintenance

The `global-graphify-maintenance` skill previously spawned `pev-planner`, `pev-executor`,
and `pev-verifier`. It now uses dedicated clones with identical role prompts and tools but
no NenFlow branding or retired-skill references:

- `agent/agents/gm-planner.json`
- `agent/agents/gm-executor.json`
- `agent/agents/gm-verifier.json`

`agent/skills/global-graphify-maintenance/SKILL.md` was updated to reference the `gm-*`
names throughout (including the `ORCHESTRATION_HEADER.json` role table). Model routing
(DeepSeek V4 Pro/Flash) is unchanged. The two scheduler jobs that mentioned `pev-*` agents
were already `delivered` (completed) — no pending automation targets the disabled agents.

## What was updated (not disabled)

- `agent/skills/orchestration-wrapper/SKILL.md` — Mode A now routes durable-artifact runs to
  the deterministic `/orchestrate`; Modes B (lightweight rich run) and C unchanged.
- `agent/orchestration/SPECIALIST_REGISTRY.json` + `README.md` — primary spine is now the
  deterministic orchestrator; all `orch-*` sidecar agents unchanged.
- `agent/AGENTS.md` — Orchestrator Role Integrity Policy unchanged; NenFlow retirement noted.

## What was deliberately left untouched

- `pi-orchestrator-extension/` — the deterministic orchestration system, including its
  `intake.md`, `intakes/`, harness, and runs-state.
- All `orch-*` specialist sidecar agents in `agent/agents/`.
- `agent/skills/spec-driven-ecology/` — standalone ecological intake methodology still works
  and still produces intake artifacts (its optional "NenFlow v3 Integration Mode" is now a
  dead path).
- `agent/nenflow-v3/` — historical NenFlow runtime home (validator, templates, runs/).
  Kept as an archive of past run artifacts; nothing active reads it.
- All historical run directories (`agent/orchestrate-runs/`, `agent/orchestration-runs/`,
  `agent/orchestration/runs/`).
- `~/.claude/commands/nenflow*.md` — Claude Code (not Pi) slash commands; out of scope for
  this retirement.

## How to restore NenFlow v3

1. Move the six skill folders from `agent/skills-retired/` back into `agent/skills/`.
2. Remove the `.disabled` suffix from the five `pev-*.json` agents (leave
   `pev-intake.json.disabled` — it was disabled before this retirement).
3. Copy `agent/prompts-retired/nenflow_v3.md` and `pev.md` back over the stubs in
   `agent/prompts/`.
4. Rename `agent/extensions/nenflow-v3.ts.disabled` back to `.ts`.
5. Revert the wording updates in `orchestration-wrapper/SKILL.md`,
   `orchestration/SPECIALIST_REGISTRY.json`, `orchestration/README.md`, and `AGENTS.md`.
