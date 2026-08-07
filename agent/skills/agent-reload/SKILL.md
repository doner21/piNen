---
name: agent-reload
description: Agent-operated Pi reload workflow. Use when the agent needs to reload Pi extensions, skills, prompts, or themes and continue afterward by scheduling a near-future wake-up with agent_scheduler BEFORE triggering the reload tool.
---

# Agent Reload Runtime

An agent-operable Pi reload workflow. Pi's built-in `/reload` is human-operated;
this skill lets an agent reload Pi's runtime (extensions, skills, prompts,
themes) and automatically wake itself up afterward to continue the prior task.

## Why this exists

Pi docs state that tools receive `ExtensionContext` (no `ctx.reload()`), while
command handlers receive `ExtensionCommandContext` (which exposes
`ctx.reload()`). So this workflow has two parts:

- `/agent-reload-runtime` — a global extension command whose handler is
  terminal: `await ctx.reload(); return;`.
- `agent_reload_runtime` — the LLM-callable reload tool registered by
  `agent/extensions/agent-reload/index.ts`. It does NOT call
  `pi.executeCommand` synchronously in its `execute` method. Instead it
  schedules a background idle poll (`setInterval` ~500ms) that waits for the
  agent to become idle (`ctx.isIdle()` true for 2 consecutive ticks), then
  invokes `pi.executeCommand("agent-reload-runtime")`. This avoids the
  live-test failure where synchronous `executeCommand` during assistant
  streaming did not actually refresh extensions/skills/prompts.

This bridge is NOT `pi.sendUserMessage('/agent-reload-runtime', ...)`. Pi's
extension `sendUserMessage()` path uses `expandPromptTemplates: false`, so a
slash command delivered that way is injected as PLAIN USER TEXT and never
executes. The `agent_reload_runtime` tool avoids that broken path entirely.

Because a reload wipes the in-memory runtime, the agent must schedule a
near-future continuation FIRST, so the reloaded runtime receives a prompt that
tells it to resume the prior task.

## Current limitation (2026-06-23)

`pi.executeCommand` is **not available in the current public Pi extension API**.
A previous workaround patched installed Pi `dist/` files, but that is not a
durable architecture because Pi npm updates overwrite it.

**Shared core bridge:** the `pi.executeCommand` patch that enables
`agent_reload_runtime` is the **same patch** that enables `agent_new_session`.
Both tools depend on the identical core bridge. The
`pi-core-patch-reapply` skill documents the full patcher workflow; the
reload-specific slash commands are `/pi-core-reload-patch check|apply|verify`
and the new-session-specific ones are `/pi-core-new-session-patch check|apply|verify`.
Running either `apply` repairs both bridges.

**Without an upstream command-dispatch API:** calling `agent_reload_runtime`
returns a clear error message about `pi.executeCommand` not being available.
The idle poll is NOT started — no false success, no silent timeout. Check
`agent/agent-reload-diagnostics.json`: `executeCommandAvailable` will be
`false` and `idleDetected` will be `null`.

**The command path always works:** typing `/agent-reload-runtime` in the
TUI triggers the extension command handler which calls `ctx.reload()`
directly — this is the supported Pi API and works regardless of patches.

**Future:** if upstream Pi ever adds an official `pi.executeCommand()` to
`ExtensionAPI`, the bridge requires zero code changes — only the
availability probe passes and the deferred idle-poll path activates.

See `agent/extensions/agent-reload/UPSTREAM_REQUEST.md` for the formal
upstream API request.

## When to use

Use this skill when the agent needs to reload Pi resources and continue
afterward — for example after installing or modifying a global extension or
skill that must take effect in the same session.

Do NOT use this skill for ordinary human-initiated `/reload`; that needs no
scheduling.

## Bootstrap / upstream notes

- **Self-check:** call `agent_reload_runtime` with `{}`. If the tool returns
  an error about `pi.executeCommand` not being available, the autonomous bridge
  cannot run in this Pi build. The manual TUI command `/agent-reload-runtime`
  still works because it runs inside `ExtensionCommandContext`.
- **Durable path:** keep the implementation in `~/.pi/agent/extensions/` and
  request/await an upstream command-dispatch API. Do not rely on installed
  `dist/` edits as the architecture; those are overwritten by Pi updates.
- **Current human gate:** when autonomous reload is unavailable, schedule any
  needed continuation and ask the human to type `/agent-reload-runtime` (or
  manual `/reload`) so Pi's supported command path performs the reload.

## Procedure (follow exactly, in order)

### 1. Prepare the continuation message

Write a continuation message that begins EXACTLY with:

```
RESUME AFTER PI RELOAD:
```

The message must include:

- The current working directory (cwd) you are operating in.
- The prior task you were performing (one or two sentences).
- The concrete next steps to continue.
- Relevant file paths, artifacts, or run ids.

Example:

```
RESUME AFTER PI RELOAD:
cwd: ~/.pi
Prior task: implementing the agent-reload extension and skill (NenFlow run RUN_20260620-194054).
Next steps: write ATT_4_EXECUTION.md and ATT_4_VERIFIER_BRIEF.md, then run the static verification grep/TS checks from the plan.
Relevant files: agent/extensions/agent-reload/index.ts, agent/skills/agent-reload/SKILL.md
```

### 2. Schedule the continuation with agent_scheduler FIRST

Call `agent_scheduler` with `action: "schedule"` and `delaySeconds: 15`, plus a
`label` and the continuation `message` from step 1.

- Target delay: **at least 15 seconds** (`delaySeconds: 15`). This clears both
  the scheduler's 5-second self-trigger floor and the reload-overdue suppression
  window (see Timing notes).
- Do this as its own tool call. Do NOT batch `agent_scheduler` and
  `agent_reload_runtime` into a single parallel tool batch — the schedule must
  be confirmed before you trigger the reload.

### 3. Inspect the scheduler result

If scheduling failed (error message, backlog limit, etc.), DO NOT reload.
Report the failure and stop. A reload without a scheduled continuation would
leave you unable to resume.

### 4. Trigger the reload tool

Only after the schedule succeeds, call `agent_reload_runtime` with `{}`.

- **First, check the tool's response.** If it returns an error about
  `pi.executeCommand` not being available, the reload DID NOT fire and WILL
  NOT fire. The idle poll was never started. Options:
  (a) type `/agent-reload-runtime` manually in the TUI — this always works;
  (b) wait for/apply an upstream Pi command-dispatch API.
- If the tool returns "Reload deferred" (no error), the bridge is active:
  - The tool does NOT invoke the reload immediately. It schedules a
    **background idle poll** that monitors `ctx.isIdle()` at ~500ms intervals
    and fires `/agent-reload-runtime` once the agent has been idle for 2
    consecutive ticks.
  - The reload executes **after your current turn ends** — not during the
    tool call itself.
  - The tool returns immediately with a "deferred" message. The actual reload
    runs asynchronously once your response finishes and the agent becomes idle.
  - There is a 30-second maximum wait. If the agent does not become idle
    within that window, the poll times out and writes diagnostics to
    `<cwd>/agent/agent-reload-diagnostics.json`.

### 5. STOP after the reload tool returns

After `agent_reload_runtime` returns, do NO further work in the old runtime:

- Do not call more tools.
- Do not write more files.
- Do not start parallel tasks.

End your turn. The reload reinitializes Pi shortly after your turn ends (when
the agent becomes idle), and roughly 15 seconds later (per the schedule) the
continuation message should be delivered into the reloaded session in the same
cwd, resuming your task.

## Timing notes

- **At least 15 seconds** is the target schedule delay (`delaySeconds: 15`).
- The scheduler's **5-second minimum** nudge means any delay under 5s is bumped
  to 5s; 15s clears that floor comfortably.
- **Reload-overdue suppression hazard (why >=15s):** on `session_start` with
  `reason === "reload"`, the scheduler sets
  `suppressOverdueDueAtOrBefore = startedAt - 1` and does NOT drain overdue
  records. `armTimer`/`onTimerFire` skip any record whose `dueAt <=
  suppressOverdueDueAtOrBefore`. So if the continuation's `dueAt` is `now + 8s`
  but reload + resource discovery completes at `now + 9s` or later, the
  continuation is silently suppressed FOREVER — the wake-up never fires. 15s
  gives reload and resource discovery enough headroom that the schedule is not
  already overdue by the time the reloaded runtime starts.
- The continuation is scoped to the cwd where it was created, so resume in the
  same directory.
- **Execution order:** the idle poll fires `/agent-reload-runtime` shortly after
  the assistant turn ends and the agent becomes idle. The reload itself then
  tears down and reinitializes the runtime. The 15-second scheduled continuation
  fires afterward in the reloaded session.

## Safety notes

- The reload command handler is terminal: `await ctx.reload(); return;`.
  Nothing runs after it in the old runtime.
- The tool never calls `pi.sendUserMessage('/...')`; it uses a deferred
  `pi.executeCommand` so the command actually executes after the agent becomes
  idle.
- Always schedule first. Never reload without a scheduled continuation.
- Never batch `agent_scheduler` and `agent_reload_runtime` in parallel; confirm
  the schedule result before reloading.
- After the tool returns, stop. Do not continue unrelated old-runtime work.
- **No false success:** if the tool returns an error about
  `pi.executeCommand`, the reload DID NOT and WILL NOT fire. The idle poll
  was never started. Check `agent/agent-reload-diagnostics.json`:
  `executeCommandAvailable: false` and `idleDetected: null` confirm this.
- Verify the schedule reached `delivered` (in `agent/scheduler.json`) after
  resume. Scheduler delivery alone is not reload evidence — reload is proven
  by the normal `/reload` loaded-resources report/status plus a `session_start`
  with `reason: "reload"` (recorded in diagnostics as `realReloadConfirmed:
  true`) plus the continuation arriving in the reloaded session.

## Quick reference

```
1. Write continuation message beginning "RESUME AFTER PI RELOAD:".
2. agent_scheduler { action: "schedule", delaySeconds: 15, label: "...", message: "..." }
   (separate call — NOT a parallel batch with the reload tool)
3. Confirm schedule succeeded. If it failed, STOP — do not reload.
4. agent_reload_runtime {}   (schedules deferred idle-poll reload; returns immediately)
5. STOP. End the turn. The idle poll fires the reload after your turn ends.
   Wait for the scheduled continuation in the reloaded session.
```
