# Autonomous Graphify Maintenance Workflow — Opus 4.8 Plan

Planner: Claude Opus 4.8  
Executor target: GPT 5.5 Codex  
Runtime worker default: DeepSeek V4 Flash

## Objective

Replace the blunt, blocking Graphify gate in `agent/extensions/graphify.ts` with a pauseable, advisory, scheduled, cheap, context-aware autonomous graphify upkeep system implemented primarily in `agent/extensions/autonomous-graphify/index.ts`, governed by config, controllable via `/graphify-auto` plus a `graphify_auto` tool, and persisted crash-safely in `agent/graphify-autonomy/`.

## Key facts established

| Area | Finding | Consequence |
|---|---|---|
| Current gate | `graphify.ts` hard-blocks `read`/`bash` on exploratory source access until a graphify artifact is read. | Make it mode-driven: `off`, `soft`, `strict`; default non-blocking. |
| Brain | `graphify.ts` owns the global Graphify Brain and `/memory*` behavior. | Reuse existing brain persistence; do not duplicate. |
| Scheduler | `agent-scheduler` is self-contained and should not be modified. | Treat scheduler as an external capability only. |
| Mutation detection | `tool_result` exposes tool name/input/error state. | Use structured detection for `write`/`edit`; conservative bash heuristics only. |
| Lifecycle | `before_agent_start`, `tool_result`, `agent_end`, `session_start`, `session_shutdown` support the needed flow. | Extension hooks are sufficient. |
| Graphify CLI | `graphify update .` supports incremental no-LLM updates; report records built commit. | Code-only path should be LLM-free. |
| Models | DeepSeek V4 Flash is available as `provider: deepseek`, `model: deepseek-v4-flash`. | Pin cheap semantic runner defaults there, configurable. |

## Invariants

1. Non-blocking by default: no Graphify gate block unless mode is explicitly `strict`.
2. Single-flight graphify runs via `agent/graphify-autonomy/lock` with stale-break.
3. No infinite loops: debounce, cooldown, recorded reason, and no immediate self-reschedule.
4. Atomic `state.json` writes via temp file + rename.
5. Cheap by default: code-only changes use `graphify update .`; semantic work uses DeepSeek V4 Flash unless overridden.
6. Respect ignores and sensitive files.
7. Reload safe: pending state and cooldown survive; timers cleaned on shutdown.
8. Do not modify scheduler internals or scheduler store format.
9. Reuse existing Graphify Brain save/sync mechanisms.
10. Keep status quiet and deduplicated.

## Files

Create:
- `agent/extensions/autonomous-graphify/index.ts`
- `agent/graphify-autonomy/config.json`
- `agent/agents/graphify-autonomy-runner.json`
- Optional later: `agent/agents/graphify-autonomy-verifier.json`

Runtime-created:
- `agent/graphify-autonomy/state.json`
- `agent/graphify-autonomy/run-log.jsonl`
- `agent/graphify-autonomy/lock`

Edit:
- `agent/extensions/graphify.ts` — make gate mode-aware.
- `C:\Users\<username>\AGENTS.md` — add autonomous graphify policy.

Do not edit:
- `agent/extensions/agent-scheduler/index.ts`
- `agent/scheduler.json` format
- Graphify Brain layout

## Config schema

```json
{
  "enabled": true,
  "paused": false,
  "gateMode": "soft",
  "debounceSeconds": 60,
  "cooldownMinutes": 30,
  "significantChangeThreshold": 3,
  "models": {
    "semantic": { "provider": "deepseek", "model": "deepseek-v4-flash" },
    "verifier": { "provider": "deepseek", "model": "deepseek-v4-pro" }
  },
  "runner": { "subagent": "graphify-autonomy-runner" },
  "ignoreGlobs": ["**/node_modules/**", "**/graphify-out/**", "**/.git/**", "**/scheduler.json", "**/*.log", "**/*.tmp"],
  "brainSyncAfterRun": true,
  "maxRunLogEntries": 500
}
```

State shape:

```json
{
  "lastRunAt": null,
  "lastRunReason": null,
  "lastRunMode": null,
  "pendingReason": null,
  "pendingSince": null,
  "cooldownUntil": null,
  "failureCount": 0,
  "lastFailureReason": null,
  "lastFailureNotifiedHash": null
}
```

## Decisions

1. Keep Graphify Brain in `graphify.ts`; create `autonomous-graphify` extension for autonomy.
2. Gate becomes `off|soft|strict` and defaults to `soft`.
3. Use extension-owned debounce/cooldown/lock state; scheduler only as optional future integration.
4. Detect mutations from structured tool inputs, not stdout.
5. Phase 1 is pause gate + status + mark-needed + change detection.
6. Deduplicate failure notices by reason hash.

## Phases

### Phase 1 — Pause gate + observability

1. Create `agent/graphify-autonomy/config.json` with `gateMode: "soft"`.
2. Edit `agent/extensions/graphify.ts` so the current hard gate reads config:
   - `off`: pass through.
   - `soft`: do not block; optionally record/advisory notify.
   - `strict`: current blocking behavior.
3. Create `agent/extensions/autonomous-graphify/index.ts` with:
   - config loader
   - atomic state read/write with corrupt-state backup
   - mutation tracker for `write`/`edit` and conservative mutating bash commands
   - `before_agent_start` freshness nudge comparing `git rev-parse HEAD` to `GRAPH_REPORT.md`
   - `/graphify-auto status|pause|resume|enable|disable|mark-needed|gate`
   - `graphify_auto` tool actions `status|mark_needed|pause|resume`
4. Wire `session_start`/`session_shutdown` to load state and clear timers.

Exit criteria:
- Gate no longer blocks in default mode.
- `/graphify-auto status` shows freshness, pending reason, paused/enabled, last run/failure.
- Mutations are counted.
- Scheduler files remain untouched.

### Phase 2 — Code-only autonomous runs

1. Add lock helpers for `agent/graphify-autonomy/lock`.
2. On `agent_end`, if meaningful changes exceed threshold and cooldown allows, set `pendingReason` and start debounce timer.
3. After debounce, acquire lock and spawn `graphify update .` asynchronously.
4. Log run results to `run-log.jsonl`; update state on success/failure.
5. Add `/graphify-auto run-now [--code-only]` and tool actions `run_now|schedule`.

Exit criteria:
- Editing files produces at most one debounced no-LLM `graphify update .`.
- Lock prevents concurrent runs.
- Cooldown prevents loops.

### Phase 3 — Cheap semantic subagent runs

1. Create `agent/agents/graphify-autonomy-runner.json` pinned to `deepseek/deepseek-v4-flash`.
2. Route docs/intakes/plans/skills/non-code changes to the runner.
3. Support `/graphify-auto run-now --semantic|--full`.
4. Dedupe and surface failures once.

Exit criteria:
- Doc-only changes trigger a cheap semantic run.
- Code-only changes remain LLM-free.

### Phase 4 — Hardening and policy

1. Add optional verifier subagent.
2. Add log rotation/GC.
3. Update `C:\Users\<username>\AGENTS.md` with autonomous graphify policy.
4. Optionally integrate long-horizon `agent_scheduler` wakeups without touching scheduler internals.

## Verification commands

```bash
cd %USERPROFILE%/.pi/agent
npx tsc --noEmit extensions/autonomous-graphify/index.ts 2>&1 | head -40

git rev-parse HEAD
grep "Built from commit" ../graphify-out/GRAPH_REPORT.md

graphify update .

git diff --stat scheduler.json

tail -5 graphify-autonomy/run-log.jsonl
```

Recommended pure-helper tests:
- `isMutatingTool`
- `isIgnoredPath`
- `shouldSchedule`
- `computeFreshness`
- corrupt-state recovery

## Recommended first execution

Start with Phase 1 only. It immediately solves the stated pain by pausing/softening the gate, is reversible by config, and gives GPT 5.5 Codex a safe base for later autonomous run-loop work.
