---
description: RETIRED — NenFlow v3 is retired; use the deterministic /orchestrate instead
argument-hint: "<task>"
---
NenFlow v3 has been retired (2026-07-18) in favor of the deterministic orchestration system.

Do NOT run the NenFlow v3 loop. Do not load `skills-retired/nenflow-v3` or spawn `pev-*` subagents.

Instead, route this task through the deterministic orchestrator:

- Use the `/orchestrate` command provided by `~/.pi/pi-orchestrator-extension` (it performs intake, planning, execution, and verification deterministically, including intake.md handling).
- For a lightweight rich run with specialist sidecars, use `/orch` (orchestration-wrapper skill).

Retirement notes and restore instructions: `~/.pi/agent/docs/nenflow-v3-retirement.md`

Task to route:

$@
