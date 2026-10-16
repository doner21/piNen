---
name: agent-reload
description: Agent-operated Pi reload workflow. Use when the agent needs to reload Pi extensions, skills, prompts, or themes and continue afterward by scheduling a near-future wake-up with agent_scheduler BEFORE triggering the reload tool.
---

# Agent Reload

Reloads Pi resources after the current turn settles, then resumes through a
scheduled continuation.

## Current architecture (Pi 0.84.2+)

`agent_reload_runtime` cannot call `ctx.reload()` directly because tools receive
`ExtensionContext`, not `ExtensionCommandContext`. It therefore:

1. waits for two stable idle ticks
2. dispatches `/agent-reload-runtime` through
   `pi.sendUserMessage(..., { expandPromptTemplates: true })`
3. lets the command handler call `ctx.reload()`
4. confirms success from `session_shutdown { reason: "reload" }`

Dispatch must happen from the settled idle poll. Pi handles expanded extension
commands before its streaming/follow-up queue logic.

Pi 0.84.2 added this supported command-dispatch option. The bridge no longer
requires the private `pi.executeCommand` patch. This matters because Pi 0.84.3+
launches `dist/bundle/cli.js`, while the legacy patcher edited only
`dist/core/*` and could report a false 11/11 success for the active CLI.

## Procedure

1. Write a concise continuation beginning `RESUME AFTER RELOAD:`. Include cwd,
   task, next steps, relevant paths, and the required diagnostics read.
2. Call `agent_scheduler` first in its own tool call. Use enough delay for the
   reload and diagnostics to settle; 75-90 seconds is the safe verification
   window.
3. Confirm scheduling succeeded.
4. Call `agent_reload_runtime` with `{}`.
5. Stop immediately and end the turn.

Never batch the scheduler and reload tool calls.

## Continuation first action

Read:

```text
C:/Users/you/.pi/agent/agent-reload-diagnostics.json
```

Check `phase`, `reloadConfirmed`, `reloadSilentlyFailed`,
`executeCommandRejected`, and `confirmedBy` before relying on newly loaded
resources.

- Success: `phase: "done"`, `reloadConfirmed: true`,
  `confirmedBy: "session_shutdown:reload"`.
- Failure: `phase: "failed"`, `reloadSilentlyFailed: true`, with no
  authoritative confirmation. Tell the user to type `/reload` manually.

Historical `executeCommand*` diagnostics fields remain for compatibility; they
no longer indicate a private-patch dependency in bridge v4.

## Recovery

If the loaded tool still reports that `pi.executeCommand` is unavailable, the
pre-v4 extension is still in memory. Type `/reload` once or restart Pi to load
the updated extension. Reapplying the legacy core patch does not alter the
bundled CLI.

## Safety invariants

- Schedule continuation first.
- Wait for stable idle before command dispatch.
- Always use `expandPromptTemplates: true`.
- Treat `session_shutdown:reload` as authoritative.
- Treat `ctx.reload()` as terminal for its command handler.
- Stop immediately after calling `agent_reload_runtime`.
