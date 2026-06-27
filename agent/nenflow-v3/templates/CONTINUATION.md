---
artifact_type: CONTINUATION_CONTRACT
role: [PLANNER|EXECUTOR|VERIFIER|RESEARCHER|ORCHESTRATOR]
run_id: [RUN_YYYYMMDD-HHMMSS]
continuation_from: [PLANNER|EXECUTOR|VERIFIER|RESEARCHER|ORCHESTRATOR]
context_saturation_estimate: "~65%"
context_handoff_threshold_percent: 65
threshold_source: [user_prompt|intake|default]
measured_at: [ISO-8601 timestamp]
role_integrity_ledger_ref: [ATT_ORCHESTRATOR_ROLE_LEDGER.md path or N/A]
---

# ATT_[n] — CONTINUATION CONTRACT

## Work Completed
- Replace this with concrete completed work and evidence.

## Work Remaining
- Replace this with concrete remaining work.

## Critical Context
- Replace this with key constraints, file paths, findings, failures, command outputs, or decisions.

## Resume Instruction
Fresh [ROLE] continuation for run [RUN_ID]: read this continuation contract at [CONTRACT_PATH], read RUN_CONFIG.json, then complete only the remaining work and write the normal role output to the exact requested path. If context again reaches context_handoff_threshold_percent, finish the current atomic unit and write the next continuation contract to the exact configured path.

## Orchestrator Role-Integrity Re-affirmation

When `role: ORCHESTRATOR` and `continuation_from: ORCHESTRATOR`, the fresh orchestrator session must:
- Resume as ORCHESTRATOR (never assume the executor role).
- Read the Orchestrator Role Integrity Ledger at the `role_integrity_ledger_ref` path.
- Continue the requested orchestration shape only; do not switch shapes or execute the main task directly.
- Re-affirm the invariant: the visible/current agent remains the ORCHESTRATOR and must not execute the main task directly.
