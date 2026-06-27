# Autonomous Graphify Phase 2 — Code-Only Run Loop Intake

## Original request

> Let's set up a similar orchestration for Phase 2.

## Context

Phase 1 is implemented. It created the autonomous Graphify foundation:

- The legacy hard Graphify gate is config-driven via `agent/graphify-autonomy/config.json`.
- Default `gateMode` is `soft`, so normal work is advisory/non-blocking.
- `agent/extensions/autonomous-graphify/index.ts` provides:
  - `/graphify-auto status|pause|resume|enable|disable|mark-needed|gate|config|run-now`
  - `graphify_auto` tool actions `status|mark_needed|pause|resume`
  - persistent config/state files
  - mutation tracking for `write`, `edit`, and conservative mutating `bash`
  - graph freshness advisory injection
- `agent/agents/graphify-autonomy-runner.json` exists as a future cheap DeepSeek V4 Flash worker.

Phase 2 should add the first real autonomous run loop, limited to **code-only, LLM-free incremental graphify updates**.

## Task statement

Implement a safe, debounced, single-flight, cooldown-protected autonomous code-only Graphify maintenance loop. When Phase 1 mutation tracking detects enough meaningful code changes, the extension should schedule a delayed maintenance run that executes `graphify update .` without LLM semantic work, logs the result, updates state, and never blocks normal agent work.

## Primary users

- The human user, who wants ongoing Graphify freshness without manually invoking `/graphify` after ordinary code edits.
- The active Pi agent, which should be able to inspect status, mark maintenance needed, and request a code-only run through safe commands/tools.
- Future Phase 3 semantic/subagent workers, which should not be entangled with the Phase 2 code-only loop.

## Scope for Phase 2

In scope:

1. Debounced post-agent scheduling for code-only or likely-code changes.
2. Single-flight lock file at `agent/graphify-autonomy/lock`.
3. Cooldown enforcement via `state.cooldownUntil` and `config.cooldownMinutes`.
4. Background/asynchronous spawn of `graphify update .` or equivalent no-LLM incremental command.
5. Run audit logging to `agent/graphify-autonomy/run-log.jsonl`.
6. State updates on success/failure:
   - `lastRunAt`
   - `lastRunReason`
   - `lastRunMode: "code-only"`
   - `cooldownUntil`
   - `pendingReason` cleared on success
   - change counters reset on success
   - failure count/reason updated on failure
7. Manual `/graphify-auto run-now --code-only`.
8. Tool support for safe actions such as `run_now` or `schedule` if the executor can add them without destabilizing the schema.
9. Status output showing whether a run is pending/running/cooling down.
10. Timer cleanup on `session_shutdown`.

Out of scope:

- Deep semantic extraction.
- Docs/intakes/plans semantic subagent routing.
- Human wiki generation.
- Full/deep Graphify rebuilds.
- Editing `agent-scheduler` internals or `agent/scheduler.json`.
- OS-level daemons or runs when Pi is fully closed.

## Core behavior

### Automatic path

1. `tool_result` continues tracking meaningful changes.
2. On `agent_end`, if:
   - `config.enabled === true`
   - `config.paused === false`
   - no run is currently active
   - no lock is active, or stale lock can be broken
   - cooldown has expired
   - significant changes meet threshold
   - changed files are code-only or safe for no-LLM update

   then set `pendingReason`, `pendingSince`, and arm a debounce timer.

3. After debounce:
   - re-read config/state
   - re-check pause/disable/cooldown/lock
   - acquire lock
   - append a run-log start record
   - spawn/run `graphify update .` from the current project cwd
   - capture bounded stdout/stderr
   - update state and log end record
   - release lock

### Manual path

`/graphify-auto run-now --code-only [path]` should bypass threshold/debounce, but still respect:

- enabled/paused unless a documented `--force` is provided
- single-flight lock
- sensitive path/ignore rules
- bounded output logging

### Tool path

`graphify_auto` should support at least:

- `status`
- `mark_needed`
- `pause`
- `resume`

Phase 2 may add:

- `run_now` with `mode: "code-only"`
- `schedule` with `mode: "code-only"`

Only add these if the schema remains simple and backward compatible.

## Invariants

- **No LLM spend in Phase 2 autonomous path.** Phase 2 should run only code-only/incremental Graphify maintenance.
- **No inline blocking during normal work.** Automatic runs must be debounced after agent completion and should not run inside the active tool execution path.
- **Single-flight.** Only one autonomous Graphify run may execute at a time across sessions/processes.
- **No loops.** A successful autonomous run must not immediately trigger another run from its own graphify output/log/state file changes.
- **Ignore self-generated artifacts.** Changes under `graphify-out/`, `agent/graphify-autonomy/`, logs, scheduler files, `.git/`, caches, and `node_modules/` should not trigger another run.
- **Cooldown is real.** After success, do not auto-run again until cooldown expires unless the human explicitly uses a force/manual command.
- **Paused means paused.** If paused/disabled, do not start automatic runs.
- **Manual control remains.** `/graphify-auto pause` must stop new automatic runs; it should not necessarily kill an already-running child unless Phase 2 explicitly implements cancellation.
- **Crash safe.** Locks must contain enough metadata to be broken if stale; state writes remain atomic.
- **Quiet failure.** Failures should be logged and visible in status, but not spammed on every turn.

## Proposed state additions

Extend `GraphifyAutonomyState` with fields such as:

```json
{
  "runStatus": "idle|debouncing|running|failed",
  "activeRunId": null,
  "activeRunStartedAt": null,
  "lastRunExitCode": null,
  "lastRunDurationMs": null,
  "lastRunStdoutTail": null,
  "lastRunStderrTail": null,
  "scheduledFor": null
}
```

Exact names can differ, but status must expose equivalent information.

## Suggested implementation primitives

- `withGraphifyLock(fn)` using `fsp.open(lock, "wx")`, metadata write, stale-break, `finally unlink`.
- `armDebounce(ctx, reason)` storing a single session-scoped `setTimeout`.
- `clearDebounce()` on shutdown.
- `shouldAutoRunCodeOnly(config, state, cwd, now)` as a pure helper.
- `classifyChangedFiles(state.changedFiles)` returning `codeOnly | docsOrMixed | ignoredOnly`.
- `runCodeOnlyGraphify(cwd, reason)` that calls `graphify update .` using `spawn` or `execFile` with bounded output.
- `appendRunLog(record)` writing JSONL.

## Verification requirements

- JSON config/state remain parseable.
- TypeScript parses/transpiles.
- `graphify_auto status` shows pending/running/cooldown state after reload.
- Manual `/graphify-auto run-now --code-only` starts exactly one run.
- A second run while locked is refused or reports already running.
- After a successful run, `cooldownUntil` is set and change counters reset.
- Changes to `graphify-out/` or `agent/graphify-autonomy/` do not trigger a new run.
- No files under `agent/extensions/agent-scheduler/` or `agent/scheduler.json` are modified.

## Requested orchestration

1. Use this intake as the Phase 2 task statement.
2. Ask Claude Opus 4.8 to produce a concrete implementation plan.
3. Save that plan to `agent/extensions/autonomous-graphify/phase2-plan.md`.
4. Then GPT 5.5 Codex can execute the saved plan in a separate implementation step.
