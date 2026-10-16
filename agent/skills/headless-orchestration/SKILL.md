---
name: headless-orchestration
description: Runs deterministic /orchestrate work in a detached Pi SDK host while a free coordinator monitors current status, forwards Telegram alarms and handles safe recovery. This skill should be used for long headless orchestrations or repairing a headless launch/monitoring recipe.
---

# Headless orchestration

Keep the coordinator free to answer the owner; give the detached host only the authorized orchestration. Read [the preparation and runnable example](references/run-example.md) and [the ONE canonical limitations list](references/known-limitations.md). Resolve bundled paths from this skill directory.

## Prepare and launch

1. Freeze an immutable running orchestrator/SDK copy separate from the editable worktree. Preserve the existing orchestrator and isolation fixes. Physically own its dependencies; never link back to live `.pi`. Use only declared read-only evidence, not a broad workspace/config snapshot. Keep owner data and working builds untouched.
2. Before any scratch write, assert a newly owned, nonempty absolute canonical externalTemp outside workspace and read-only inputs, with no symlinks/junctions. Prepare every input and isolated agent/session/run/cache/temp directory before detached launch. Keep product writes inside the authorized cwd/write set; scratch ownership grants no evidence mutation or out-of-cwd product write authority.
3. Copy [scripts/launch.mjs](scripts/launch.mjs) and [scripts/orchestrate-host.mjs](scripts/orchestrate-host.mjs) to the owned run. Use the stable absolute `C:/Program Files/nodejs/node.exe`, not the disappearing bare Node shim. Require Astra host/supervisor and planner (`openai-codex/gpt-6-astra`), ONE sequential Sol executor and ONE fresh independent Sol verifier (`openai-codex/gpt-6.1-sol`), no fallback, `maxRetries: 0`. Check observed routes; labels alone are not routing evidence. Missing named routes are a blocker, not permission to substitute.
4. Use the bound host's supported `DefaultResourceLoader`, awaited `bindExtensions` and expanded literal `/orchestrate` dispatch in that order. Plain SDK prompt alone was silent. Scrub child `PI_SESSION_FILE`/`PI_SESSION_ID`; create fresh session lineage. Retain stdout/stderr, events, dispatch, started, current results and completion/error output. Schedule external coordinator check-ins before launching; do not edit the running copy.

## Plain supervisor brief

Use this short template, replacing the approved scope. Avoid dense rule-speak: it causes false pauses when compact inspect points to full detail elsewhere.

> Inspect the current run. At the plan checkpoint, read `planSummary` (or `savedArtifacts.plan`). If it has tasks and acceptance criteria within the approved scope, approve and continue. Request a fresh approval with `continue` without a token if needed, then consume the returned one-use approval in `continue`. Pause only for protected code, a forbidden change, or a genuinely missing plan; say which. At later checkpoints, continue when the settled result and actual content changes are within scope. Full detail is in the saved files; do not demand it all in compact inspect. Never repeat a completed worker. Report the actual terminal verdict, not SDK settlement.

### Paradigm and automatic approval

The launcher accepts any registered paradigm, including a shape-builder workflow. Put custom workflow JSON in the authorized project's `<cwd>/.pi/orchestrator-workflows/` before freezing/launching. User workflows are hidden by isolation: copy the particular authorized workflow into project scope; do not copy a broad user configuration. Use a verifier after **every** file-changing phase.

Automatic initial-plan approval is **off by default**. State `automaticPlanApproval: false` in config and `--automatic-plan-approval off` in the literal command. For explicit opt-in, state `true` and `--automatic-plan-approval on` together. Dispatch records the setting; supervision records each fixed-check approval. Only the initial plan is automatic, not later worker/verifier decisions. Host checks require a saved intact plan, task ACs, an explicit coordinator write set, and narrow predicted paths in the pinned worktree outside protected areas. Missing scope, directories/wildcards, protected paths, escape or unreadable/inconsistent plans refuse automatic approval with a reason; a supervisor handles exceptions. Do not treat planner-inferred scope as coordinator authorization.

## Monitor and talk to the owner

- Use the existing **coordinator-owned `agent_scheduler`** to schedule check-ins every **10–15 minutes**, re-arming while work continues. Add no script polling, timers, deadlines, sleeps, signals or exits; leave shell timeout absent/null. Read incoming owner messages promptly; answer “is anything running?” correctly within **one minute**, using fresh observations rather than a stored launch flag. If nothing is running and progress is blocked, tell the owner the blocker and decision needed immediately, then use the coordinator scheduler for two-hour reminders.
- At each check-in explicitly refresh the current projection through the bundled `--status` adapter; at checkpoints inspect through the owning host's supported `orchestrate` action/command. Follow the example's actual fields: tri-state `going`, phase, active worker PID/launch identity/liveness, heartbeat/output, `activeSilenceAlarms`, `lastError`, observation errors and observation time. Obtain blockers from current inspection data, not a fictitious LiveStatus property. Reconcile OS child identity/PID existence, phase sidecars, top-level host events and completion status. Never promote an old nested log or historical checkpoint to a current alarm.
- **Explicitly invoke the existing coordinator Telegram bridge's plaintext send-message action**, using the actual action/argument schema exposed by that tool, addressed to the owner. Send a short sanitized run/phase/worker/alarm/error/blocker message immediately when current `activeSilenceAlarms`, `lastError` or blockers are observed; send each active alarm once, then material updates and clearance. A log entry, UI notification or headless report is not Telegram delivery. Keep the bridge outside the worker; add no token to configuration/logs/arguments, new Telegram polling, SSI fence or deployment. If the bridge/send action is unavailable, report that delivery blocker instead of claiming it sent.
- Treat full JSON streams as private: they may contain encrypted reasoning. Parse only tool/text/current outcome; never display reasoning signatures, secrets, approval tokens or raw dumps.

## Inspect, decide, recover

Treat `awaiting_supervisor` as a checkpoint, **never final success**. Inspect the current run's frozen mission, criteria, effects and tests; take only a legal `allowedNextActions` decision. Continue with the fresh one-use run/checkpoint-bound approval. Accept only when authorized and eligible after a settled verifier with no active/detached worker, with a reason; `accepted_with_reason` is not verifier PASS. Pause/cancel when required. Do not confuse SDK settlement/exit0 or a stale `executing` field with orchestration completion.

After `result_lost_after_mutation` (result lost after mutation), inspect/reconcile and preserve work; do not replay the run or completed executor. Use existing role recovery on fixed named role paths, never model substitution. Item5 is already built/reviewed; do not rebuild it for this recipe. Apply the two-materially-different-attempt cutoff per unbuilt fix; it does not authorize a third isolation repair.

Never kill owner/unknown processes. Only after ownership and silence inspection may the coordinator stop its purpose-started **OWN** worker that has produced no output for **30 minutes** while blocking its parent; say so afterwards. Do not add stop logic to these scripts. Unknown identity or uncertain output does not satisfy this exception.

Keep reviews independent and read-only: no reviewer writes in workspace/evidence, even caches. Only the coordinator commits after fresh whole review; no push, live reload or cutover without the owner. Validate this recipe with frontmatter/discovery, bundled path checks, `node --check` for each `.mjs`, source API/dispatch order, model-free sample semantics and forbidden-behavior/preservation checks. Do not launch a real-model workflow merely to validate documentation. Leave whole-round lean checks, fresh Astra review and owner-use for the later integrated boundary.
