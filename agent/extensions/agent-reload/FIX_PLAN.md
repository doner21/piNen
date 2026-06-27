# Fix Plan: Agent Reload / New-Session Autonomous Bridges (v2 — post-critique)

## Repro result (confirmed 2026-06-25 ~13:51)

Called `agent_reload_runtime` from a clean session after instrumenting both
extensions on disk. Diagnostics: poll RAN (attempts:16), idleDetected set,
`reloadInvoked` set, NO error — but the instrumented code was NOT loaded
(diagnostics had old shape). `resource-loader.reload()` calls
`clearExtensionCache()`, so if `session.reload()` had run, new code would be
active. It wasn't → `session.reload()` never ran → `handleReloadCommand`
silently no-op'd.

## Root cause (reload — VERIFIED by both critiques against Pi core source)

Tool `ExtensionContext` (createContext) has no `reload()`/`newSession()`; only
command context does. Extension MUST route through `pi.executeCommand` →
registered command handler → `commandCtx.reload()` → interactive-mode
`handleReloadCommand()` → `this.session.reload()`.

`handleReloadCommand()` (interactive-mode.js L4169) has silent no-op paths:
- `if (this.session.isStreaming) { showWarning; return; }`
- `if (this.session.isCompacting) { showWarning; return; }`
- `try { await this.session.reload(...) } catch { showError("Reload failed"); }` (swallowed)

All return normally → executeCommand resolves cleanly → extension cannot
distinguish success from silent failure. The isStreaming race: idle poll
verifies `!isStreaming` (2 ticks), but `isStreaming` can flip back true before
`handleReloadCommand` checks (deferred turn work, scheduler message, or the
`process.nextTick` yield inside handleReloadCommand admitting pending work).

## Root cause (new-session — MISDIAGNOSED, needs separate instrumentation)

Per Opus critique (verified): the `newSession` command-context action
(interactive-mode.js L1153) has NO `isStreaming`/`isCompacting` guard — it
calls `runtimeHost.newSession(options)` directly. So the new-session failure
mechanism is DIFFERENT. The earlier 24s `executeCommand` duration is NOT a
silent-bail signature (silent bail returns in ~0ms). Likely: newSession ran
`withSession` (kickoff turn) but the session switch didn't take effect, OR it
threw `AgentHarnessError("busy")` (would surface as executeCommandRejected),
OR was cancelled by session_before_switch. **Apply the same robust pattern
below to new-session (it helps regardless), and instrument separately.**

## Synthesized fix (from GPT-5.5 + Opus critiques)

### 1. Confirm via `session_shutdown{reason:"reload"|"new"}`, NOT session_start

`session.reload()` / `newSession()` emit `session_shutdown` with the reason
BEFORE teardown, in the still-alive OLD instance where `lastKnownCwd` is
intact and the cwd is correct. `session_start` fires in the REBUILT instance
where module state is reset (counters/generations lost) and `lastKnownCwd`
falls back to `process.cwd()` which may differ → writes confirmation to the
wrong file. **session_shutdown is the reliable success signal.**

### 2. Persist a unique request-id to disk (not an in-memory generation counter)

Module state dies on in-process reload (jiti re-evaluates the module).
Persist `activeRequestId` (`reload-<ts>-<rand>`) to the diagnostics file.
session_shutdown confirms by matching the request-id (so a manual /reload
during the window doesn't false-confirm).

### 3. Explicit phase machine

`phase: "idle" | "polling" | "command-in-flight" | "verifying" | "done" | "failed"`

Coalesce (reject new execute() calls) only when phase is non-terminal
(`polling` | `command-in-flight` | `verifying`). Allow new attempts from
terminal phases (`done` | `failed` | `idle`). **DROP the
`pending && !pollInterval` heuristic** — it's exactly true during
command-in-flight → double-fire hazard.

### 4. Gate idle on `ctx.isIdle() && !ctx.hasPendingMessages()`

`hasPendingMessages()` (on ExtensionContext, verified) directly detects the
scheduler-message / queued-turn race. Gate firing on both being stable for 2
ticks. Keep IDLE_TICKS_REQUIRED=2 (do NOT just increase ticks — that only
shifts the window).

### 5. Verification timer affirms FAILURE only

On success, the process is rebuilt; the timer's purpose collapses. The timer
fires only if `session_shutdown` did NOT confirm → writes
`reloadSilentlyFailed=true`. Clear the timer in session_shutdown (timers
survive in-process reload and would otherwise accumulate).

### 6. Hard timeout on executeCommand (can't cancel, but resets state)

Wrap executeCommand in Promise.race with 25s (reload) / 45s (new-session).
On timeout, phase="failed", error, reset to idle. The underlying promise may
still resolve late → a late session_shutdown will confirm (acceptable).

### 7. Honest coalesce tool returns

If execute() is called while non-terminal phase, return a result that says
"already in progress (phase X, request Y)" — not "deferred".

### 8. Single bounded autonomous retry on silent failure

On `reloadSilentlyFailed`, if retryCount < 1, re-arm the poll after 2s (the
agent has stopped; only the timer can retry). Safe because no reload is
in-flight (session_shutdown did NOT fire). On second failure, write terminal
"failed" for the continuation to surface.

### 9. Merge diagnostics on EVERY write

All writes (execute entry, tick, coalesce, timeout, resolved/rejected,
session_shutdown confirmation, verification failure) merge with the existing
file (append to executeEntries/tickLog, cap sizes). Preserves the audit trail
across polls and reloads.

### 10. Handle newSession cancellation

If `ctx.newSession()` returns `{cancelled: true}` (session_before_switch
cancelled), session_shutdown does NOT fire → verification timer catches it as
failed. (Detection, not prevention.)

### 11. Self-check via the scheduled continuation

The agent has STOPPED after the tool returns. Only the scheduled continuation
arriving in the (reloaded or un-reloaded) runtime can act on diagnostics.
promptGuidelines instruct: the continuation's FIRST action is to read the
diagnostics file and check `reloadConfirmed`/`reloadSilentlyFailed`/
`executeCommandRejected`/`phase` before relying on new tool actions.

### 12. waitForIdle() in the command handler (marginal, harmless)

`ctx.waitForIdle()` on command ctx resolves immediately if no turn is
in-flight (runPromise undefined). Add `await ctx.waitForIdle()` before
`ctx.reload()` in the command handler — cheap yield, marginal benefit. Do
NOT rely on it as the race fix (hasPendingMessages gate is the real fix).
Note: only works because we fire from a timer; never `await executeCommand`
synchronously inside the tool's execute (would deadlock).

## Constraints (unchanged)

- No dist edits. Fix in the two extension .ts files.
- Cannot bypass pi.executeCommand.
- Keep the manual /agent-reload-runtime and /agent-new-session commands.

## Verification

1. Implement both extensions per this plan.
2. ONE manual /reload to load the fixed code (the bridge is currently broken,
   so it can't load its own fix — note this for the user).
3. Autonomous reload round-trip: call agent_reload_runtime from a clean
   session with a scheduled continuation.
4. Read diagnostics: confirm either `reloadConfirmed:true` (success) or
   `reloadSilentlyFailed:true` with a clear error (no silent staleness).
5. Confirm coalesce honesty: a second execute() during non-terminal phase
   returns "already in progress".
6. Confirm hasPendingMessages gate: a scheduler message arriving during the
   idle window does not trigger a premature reload.

## What this fix does NOT do

- Does not fix the upstream `handleReloadCommand` silent no-op (in Pi core
  dist, can't edit). DETECTS it + retries once + surfaces clear error.
- Does not fully resolve the new-session mystery (misdiagnosed root cause).
  Applies the robust pattern; separate instrumentation needed.
