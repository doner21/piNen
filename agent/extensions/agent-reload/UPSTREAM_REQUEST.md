# Upstream API Request: `pi.executeCommand()` on `ExtensionAPI`

> **Target:** `@earendil-works/pi-coding-agent`
> **Date:** 2026-06-23
> **Status:** Requested
> **Requester:** Pi autonomous agent workflow (agent-reload / agent-new-session extensions)

---

## Problem

Pi extensions have two contexts:

| Context | Available in | Has `reload()`? | Has `newSession()`? |
|---|---|---|---|
| `ExtensionContext` | Tool handlers, event handlers | No | No |
| `ExtensionCommandContext` | Slash-command handlers | Yes (`ctx.reload()`) | Yes (`ctx.newSession()`) |

An LLM-callable **tool** cannot invoke `/slash-commands` that require
`ExtensionCommandContext`. There is **no public, supported API** for a tool
or event handler to programmatically dispatch a slash command (or its
equivalent) through the normal TUI command path.

This prevents autonomous agent workflows such as:

- **agent_reload_runtime:** an agent tool that can trigger a Pi runtime
  reload (like human `/reload`) with schedule-first continuation safety.
- **agent_new_session:** an agent tool that can start a fresh Pi session
  (like human `/new`) with automated context handoff.

---

## Current Flawed Workarounds

### 1. Core patching (previously used by us — NOT durable)

Three installed Pi `dist/` files were patched to inject `pi.executeCommand()`:
`dist/core/extensions/loader.js`, `dist/core/extensions/runner.js`, and
`dist/core/extensions/types.d.ts`.

**Problem:** every `npm update` or `npm install` of
`@earendil-works/pi-coding-agent` overwrites these files, silently breaking
the autonomous bridge. Agents discover the breakage only at runtime when the
tool errors or silently fails.

### 2. `pi.sendUserMessage('/command', ...)` (does NOT work)

Pi's `sendUserMessage()` calls `prompt()` with `expandPromptTemplates: false`
(agent-session.js L1042-1044). Slash commands delivered this way are treated
as **plain user text** — they never execute through the command handler path.

### 3. External process / TUI emulation (fragile)

Launching a separate Pi process or scripting keystrokes into the TUI is
platform-dependent, fragile, and introduces race conditions.

---

## Requested API

Add `executeCommand` to the `ExtensionAPI` interface so tools and event
handlers can dispatch registered commands without receiving
`ExtensionCommandContext` directly.

```typescript
interface ExtensionAPI {
  // ... existing members ...

  /**
   * Execute a registered extension slash command by name.
   *
   * The command handler receives ExtensionCommandContext and runs as if the
   * user typed `/commandName` in the TUI.
   *
   * @param name     The registered command name (without leading slash).
   * @param args     Optional arguments string, passed as the handler's `args` parameter.
   * @returns        A promise that resolves when the command handler returns.
   * @throws         If the command is not registered, or the command handler throws.
   */
  executeCommand(name: string, args?: string): Promise<void>;
}
```

---

## Runtime Behavior Specification

1. `pi.executeCommand(name)` looks up the registered command with the given
   `name` in the current Pi runtime's command registry (the same one populated
   by `pi.registerCommand()`).

2. The command handler is invoked with `ExtensionCommandContext` — exactly as
   if the user typed `/<name>` in the TUI. This includes access to
   `ctx.reload()`, `ctx.newSession()`, `ctx.sessionManager`, etc.

3. The handler's return value / promise is passed through (the caller can await
   it). If the handler throws, the promise rejects.

4. The command runs with the **same concurrency semantics** as a user-typed
   command (no special privileges or separate execution context).

5. If the command is not registered, `executeCommand` throws or the promise
   rejects with a descriptive error (not a silent no-op).

6. `executeCommand` is available everywhere `ExtensionAPI` is available —
   tools, event handlers (`session_start`, `session_shutdown`, etc.), and any
   future context types.

---

## Non-Goals

- We are NOT requesting `executeCommand` on `ExtensionCommandContext`
  (command handlers already have direct access to `ctx.reload()` etc.).
- We are NOT requesting `ctx.reload()` or `ctx.newSession()` on
  `ExtensionContext` directly — the command dispatch model is sufficient
  and cleaner (keeps reload/new-session safety logic in command handlers).
- We are NOT requesting any changes to `sendUserMessage()` /
  `expandPromptTemplates` behavior (that's a separate concern).

---

## Verification Path

The requesting extensions live at:

- `agent/extensions/agent-reload/index.ts` — registers `/agent-reload-runtime`
  and the `agent_reload_runtime` tool. The tool calls
  `pi.executeCommand("agent-reload-runtime")` after idle detection.
- `agent/extensions/agent-new-session/index.ts` — registers
  `/agent-new-session` and the `agent_new_session` tool. Same pattern.

Both extensions probe `typeof pi.executeCommand === "function"` at init.
If upstream Pi adds `executeCommand`, the probe passes, the idle-poll
deferred bridge activates, and the extensions work without any code changes.

Verification test: call `agent_reload_runtime` tool → "Reload deferred" →
idle poll fires → `/agent-reload-runtime` executes → `ctx.reload()` runs →
visible resource report + `session_start` with `reason: "reload"`.

---

## Discussion

The current core patch locations (for reference, these will be retired once
this upstream API exists):

| File | Purpose |
|---|---|
| `dist/core/extensions/loader.js` | Inject `executeCommand` into the extension `api` object |
| `dist/core/extensions/runner.js` | Bind command dispatch logic onto the extension runtime |
| `dist/core/extensions/types.d.ts` | Add `executeCommand` to `ExtensionAPI` and runtime types |

These patches are documented in `CORE_PATCH.diff` in the agent-reload run
directory.
