---
name: agent-new-session
description: Agent-operated new-session workflow for Pi coding agent. Use when the agent needs to start a fresh session with a clean context window (equivalent to the human `/new` command) and continue afterward by scheduling a near-future wake-up with agent_scheduler BEFORE triggering the new-session tool.
---

# Agent New Session

An agent-operable "new session" tool for Pi coding agent that lets the agent
start a fresh session with a clean context window — equivalent to the human
`/new` slash command. Pi's built-in `/new` is human-operated via the chat UI;
this skill lets an agent programmatically create a new session and continue
its work from a fresh context window.

## Why this exists

Pi's `ExtensionCommandContext` exposes `ctx.newSession()`, which tears down the
current session and creates a brand-new session. However, `ctx.newSession()` is
available only in command handlers (`ExtensionCommandContext`), **not** in tool
handlers (`ExtensionContext`). This skill bridges the gap with a deferred
invocation pattern:

- `/agent-new-session` — a global extension command whose handler calls
  `ctx.newSession()` with appropriate kickoff setup.
- `agent_new_session` — the LLM-callable tool registered by
  `agent/extensions/agent-new-session/index.ts`. It does NOT call
  `pi.executeCommand` synchronously. Instead it schedules a **background idle
  poll** (`setInterval` ~500ms) that waits for the agent to become idle
  (`ctx.isIdle()` true for 2 consecutive ticks), then invokes
  `pi.executeCommand("agent-new-session")`.

This bridge is NOT `pi.sendUserMessage('/agent-new-session', ...)`. Pi's
extension `sendUserMessage()` path uses `expandPromptTemplates: false`, so a
slash command delivered that way is injected as PLAIN USER TEXT and never
executes. The `agent_new_session` tool avoids that broken path entirely.

Because `ctx.newSession()` tears down the **old** session, the agent must
schedule a near-future continuation FIRST, so the **new** session receives a
kickoff message telling it what to do.

## Current limitation (2026-06-23)

`pi.executeCommand` is **not available in the current public Pi extension API**.
A previous workaround patched installed Pi `dist/` files, but that is not a
durable architecture because Pi npm updates overwrite it.

**Without an upstream command-dispatch API:** calling `agent_new_session`
returns a clear error message about `pi.executeCommand` not being available.
The idle poll is NOT started — no false success, no silent timeout. Check
the canonical Pi-home diagnostics file (`<PI_HOME>/agent/agent-new-session-diagnostics.json`,
`~/.pi/agent/agent-new-session-diagnostics.json` by default; on this Windows host,
`~/.pi/agent/agent-new-session-diagnostics.json`):
`executeCommandAvailable` will
be `false` and `idleDetected` will be `null`.

**The command path always works:** typing `/agent-new-session` in the TUI
triggers the extension command handler which calls `ctx.newSession()`
directly — this is the supported Pi API and works regardless of patches.

**Shared core bridge:** the `pi.executeCommand` patch that enables
`agent_new_session` is the **same patch** that enables `agent_reload_runtime`.
Both tools depend on the identical core bridge. See the
`pi-core-patch-reapply` skill for the full patcher workflow. The
new-session-specific slash commands are documented below.

**Future:** if upstream Pi ever adds an official `pi.executeCommand()` to
`ExtensionAPI`, the bridge requires zero code changes — only the
availability probe passes and the deferred idle-poll path activates.

See `agent/extensions/agent-reload/UPSTREAM_REQUEST.md` for the formal
upstream API request.

## Repairing the core bridge for new-session

When `agent_new_session` fails with "pi.executeCommand is not available"
(typically after a Pi npm update), the user can repair the shared core
bridge via slash command. The same underlying patcher at
`agent/core-patch/reapply-pi-core-patch.mjs` handles both reload and
new-session — the commands below are new-session-specific aliases that
all shell out to the same patcher.

### Exact user steps

Run these commands **in order** from inside Pi:

1. **Check** patch state (read-only):
   ```
   /pi-core-new-session-patch check
   ```
   Exit 0 = fully patched (no action needed). Exit 1 = patch missing
   (expected after a Pi update — continue to step 2). Exit 2 = safe
   failure (Pi source drifted — do not apply; re-derive the patch).

2. **Apply** the patch (backs up current files first, idempotent):
   ```
   /pi-core-new-session-patch apply
   ```

3. **Verify** the patch (static-only, read-only, no reload):
   ```
   /pi-core-new-session-patch verify
   ```
   Confirms every edit sentinel is present and structural checks pass.

4. **Manually load the patched core** (REQUIRED after apply):
   ```
   /reload
   ```
   or `/agent-reload-runtime`, or restart Pi.

   The patcher edits files on disk only. **The running Pi process still
   uses the old unpatched code until a manual `/reload` or restart.**
   After reload, `agent_new_session` can work.

### Command aliases

Convenience aliases are also registered (same behavior):

```
/pi-core-new-session-patch-check
/pi-core-new-session-patch-apply
/pi-core-new-session-patch-verify
```

### Safety invariants

- **User-invoked only** — no silent auto-patching, no startup/background
  patching.
- **No live reload** — the patcher and slash commands never trigger a
  reload or restart.
- **Idempotent** — check/apply/verify are safe to run repeatedly.
- **Backup-before-write** — `apply` snapshots every target file to
  `agent/core-patch/backups/` before editing.
- **Safe failure on source drift** — if a patch anchor is missing, the
  patcher stops, writes nothing, and reports exit code 2.
- **No `pi.sendUserMessage('/command')`** — the slash commands run the
  patcher script as a child process; they do not use the broken
  `sendUserMessage` command-dispatch path.

### How these commands relate to the reload patch commands

The `/pi-core-new-session-patch` commands and the `/pi-core-reload-patch`
commands both invoke the **same** durable patcher at
`agent/core-patch/reapply-pi-core-patch.mjs`. There is only one core
patch — the `pi.executeCommand` bridge — and it enables both
`agent_reload_runtime` and `agent_new_session`. The separate command
paths exist for user clarity; the underlying operation is identical.
Running the new-session `apply` also repairs the reload bridge, and
vice versa.

## When to use

Use this skill when the agent wants or needs to start a fresh session,
including (but not limited to):

- **Starting a new session** — user asks to "start a new session," "begin a
  fresh session," or an agent detects that a clean context window would be
  beneficial.
- **Clearing context** — user asks to "clear context and start fresh," "reset
  the session," or the agent's context window is filling up and it needs a
  clean slate to continue effectively.
- **Session hygiene** — before starting a major new task, after completing a
  large piece of work, or when the context window is cluttered with resolved
  conversations.

Do NOT use this skill for ordinary human-initiated `/new`; that needs no
scheduling.

## Procedure (follow exactly, in order)

### 1. Prepare the continuation (kickoff) message

Write a concise continuation message that begins EXACTLY with:

```
RESUME AFTER NEW SESSION:
```

The message must include:

- The current working directory (cwd) you are operating in.
- The prior task you were performing (one or two sentences).
- The concrete next steps to continue.
- Relevant file paths, artifacts, or run ids.
- Any critical decisions or state the new session needs.

Example:

```
RESUME AFTER NEW SESSION:
cwd: ~/.pi
Prior task: building the agent-new-session extension and skill (NenFlow run RUN_20260622-120000).
Next steps: verify the extension loads correctly, test the deferred idle-poll pattern, and complete the SKILL.md documentation.
Relevant files: agent/extensions/agent-new-session/index.ts, agent/skills/agent-new-session/SKILL.md
```

Keep the message **concise but complete** — the new session has no prior
context and relies entirely on this message to know what to do.

### 2. Schedule the continuation with agent_scheduler FIRST

Call `agent_scheduler` with `action: "schedule"` and `delaySeconds: 15` (or
75-90 when the diagnostics file needs to be read after the old 60s
executeCommand timeout — see [Timing notes](#timing-notes)), plus a
`label` and the continuation `message` from step 1.

- Typical target delay: **15 seconds** (`delaySeconds: 15`). This is the
  minimum safe delay (see [Timing notes](#timing-notes)).
- For acceptance/verification reads: **75–90 seconds** so the diagnostics
  file reflects final canonical state (see [Reading diagnostics after
  acceptance](#reading-diagnostics-after-acceptance)).
- Do this as its **own tool call**. Do NOT batch `agent_scheduler` and
  `agent_new_session` into a single parallel tool batch — the schedule must be
  confirmed before you trigger the new session.

### 3. Inspect the scheduler result

If scheduling failed (error message, backlog limit, etc.), DO NOT start a new
session. Report the failure and stop. Starting a new session without a
scheduled continuation would leave you with a blank session and no way to
resume.

### 4. Trigger the new session tool

Only after the schedule succeeds, call `agent_new_session` with `{}`.

- **First, check the tool's response.** If it returns an error about
  `pi.executeCommand` not being available, the new session DID NOT fire and
  WILL NOT fire. The idle poll was never started. Options:
  (a) type `/agent-new-session` manually in the TUI — this always works;
  (b) wait for/apply an upstream Pi command-dispatch API.
- If the tool returns "New session deferred" (no error), the bridge is active:
  - The tool does NOT invoke `ctx.newSession()` immediately. It schedules a
    **background idle poll** that monitors `ctx.isIdle()` at ~500ms intervals
    and fires `/agent-new-session` once the agent has been idle for 2
    consecutive ticks.
  - The new session is created **after your current turn ends** — not during
    the tool call itself.
  - The tool returns immediately with a "deferred" response. The actual
    session switch runs asynchronously once your response finishes and the
    agent becomes idle.
  - There is a 30-second maximum wait. If the agent does not become idle
    within that window, the poll times out and writes diagnostics to
    the canonical Pi-home file `<PI_HOME>/agent/agent-new-session-diagnostics.json`
    (`~/.pi/agent/agent-new-session-diagnostics.json` by default).
  - **Diagnostics interpretation:** `newSessionConfirmed: true` and
    `confirmedBy: "session_shutdown:new"` are authoritative success
    signals. Even if `executeCommandRejected` or `hardTimeout` appear in
    the diagnostics, if these confirmation fields are `true`, the session
    switch succeeded — the failure fields are late race artifacts that do
    not affect final status.

### 5. STOP immediately after the new-session tool returns

After `agent_new_session` returns, do NO further work in the old session:

- Do not call more tools.
- Do not write more files.
- Do not start parallel tasks.

**End your turn.** The idle poll creates the new session shortly after your
turn ends (when the agent becomes idle). The old session is destroyed by
`ctx.newSession()`.

Roughly 15 seconds later (per the schedule), the continuation message is
delivered into the new session via `pi.sendUserMessage` (fired by the
scheduler), resuming your task with a clean context window.

## Timing notes

- **For the initial kickoff schedule:** 15 seconds (`delaySeconds: 15`) is the
  standard delay for most workflows. It ensures the new session is fully
  initialized before the continuation message arrives.
- **For acceptance/verification reads:** use **75–90 seconds** when you need to
  read the canonical Pi-home file `<PI_HOME>/agent/agent-new-session-diagnostics.json`
  (`~/.pi/agent/agent-new-session-diagnostics.json` by default) after the session switch.
  The executeCommand handler has a 60-second hard timeout; its late timeout
  path can emit a failure write after the session has actually switched. A
  75–90s delay ensures the success-preserving diagnostics writer has finalized
  the canonical success shape before you read it.
- The scheduler's **5-second minimum** nudge means any delay under 5s is bumped
  to 5s; 15s clears that floor comfortably.
- **Why 15+ seconds is needed:** after the idle poll fires
  `/agent-new-session`, `ctx.newSession()` tears down the old runtime and
  initializes a brand-new session. This includes extension loading, skill
  loading, resource discovery, and session startup. If the continuation
  message arrives while the new session is still initializing, it may be lost
  or mishandled. 15 seconds provides sufficient headroom for the new session to
  be fully initialized before the continuation message arrives.
- **Scheduler filesystem persistence:** the agent-scheduler stores schedules in
  `agent/scheduler.json` on the filesystem. This state survives `ctx.newSession()`
  because it lives outside the runtime's in-memory state. When the new session
  starts, the scheduler extension reads `scheduler.json` and re-arms the timer.
  This is why the schedule-*then*-switch pattern works — the schedule record
  persists across the session boundary.
- The continuation is scoped to the cwd where it was created, so resumption
  happens in the same directory.

## Reading diagnostics after acceptance

When the continuation message's first action reads
the canonical Pi-home file `<PI_HOME>/agent/agent-new-session-diagnostics.json`
(`~/.pi/agent/agent-new-session-diagnostics.json` by default), interpret as follows:

- **PASS** — valid JSON, `phase === "done"`, `newSessionConfirmed === true`,
  `confirmedBy === "session_shutdown:new"`, `newSessionSilentlyFailed ===
  false`, `executeCommandRejected === false`, top-level `hardTimeout` absent
  or `false`, no top-level failure `error` contradicts success.
- **FAIL** — malformed JSON, or `phase === "failed"` with no
  `confirmedBy: "session_shutdown:new"`, or top-level
  `executeCommandRejected: true` / `hardTimeout: true` exists without
  corresponding confirmation fields.
- **Ambiguous recovery** — if the raw text contains `session_shutdown:new` but
  JSON is malformed (partial write), the success-preserving writer recovers
  confirmation from raw text on the next write. If the malformed file persists
  and diagnostics can't be read, the autonomous session switch status is
  uncertain — fall back to checking empirically (did a clean new session open?).

## What happens in the new session

When the new session starts and receives the scheduled continuation message:

1. The new session has a **completely fresh context window** — no prior
   conversation history, no stale tool call results, no clutter.
2. The continuation message (from step 1) is the **first user message** in the
   new session, providing the necessary context to resume work.
3. The new session can pick up exactly where the old one left off, using only
   the information in the continuation message plus files on disk.

## Safety notes

- `ctx.newSession()` tears down the old session **completely**. Nothing survives
  in memory. All unsaved state in the old session is lost.
- The tool never calls `pi.sendUserMessage('/agent-new-session', ...)`; it uses
  a deferred `pi.executeCommand` so the slash command actually executes after
  the agent becomes idle.
- **Always schedule first.** Never start a new session without a scheduled
  continuation — you will lose all context with no way to resume.
- **Never batch** `agent_scheduler` and `agent_new_session` in parallel;
  confirm the schedule result before switching sessions.
- After the tool returns, **stop immediately.** Do not continue unrelated
  old-session work. The old session is about to be destroyed.
- **No false success:** if the tool returns an error about
  `pi.executeCommand`, the new session DID NOT and WILL NOT fire. The idle
  poll was never started. Check the canonical Pi-home file
  `<PI_HOME>/agent/agent-new-session-diagnostics.json`
  (`~/.pi/agent/agent-new-session-diagnostics.json` by default):
  `executeCommandAvailable: false` and `idleDetected: null` confirm this.
- The `session_shutdown` handler in the extension cleans up the idle poll
  interval to prevent resource leaks.
- Diagnostics are written only to the canonical Pi-home file
  `<PI_HOME>/agent/agent-new-session-diagnostics.json`
  (`~/.pi/agent/agent-new-session-diagnostics.json` by default), independent
  of the active project cwd, if the idle poll times out (30s) or encounters errors.

## Quick reference

```
1. Write continuation message beginning "RESUME AFTER NEW SESSION:".
2. agent_scheduler { action: "schedule", delaySeconds: 15, label: "...", message: "..." }
   (separate call — NOT a parallel batch with the new-session tool)
   For acceptance/verification reads, use delaySeconds: 75-90.
3. Confirm schedule succeeded. If it failed, STOP — do not switch sessions.
4. agent_new_session {}   (schedules deferred idle-poll session switch; returns immediately)
5. STOP. End the turn. The idle poll creates the new session after your turn ends.
   Wait for the scheduled continuation in the new session.
6. In the new session, read <PI_HOME>/agent/agent-new-session-diagnostics.json FIRST
   (~/.pi/agent/agent-new-session-diagnostics.json by default).
   newSessionConfirmed:true + confirmedBy:"session_shutdown:new" = authoritative success.
```
