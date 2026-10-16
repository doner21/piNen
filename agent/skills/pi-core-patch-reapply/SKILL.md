---
name: pi-core-patch-reapply
description: User-invoked maintenance for the legacy Pi dist/core compatibility patch and its slash commands. On Pi 0.84.2+ the agent reload/new-session bridges use supported expanded command dispatch and do not require pi.executeCommand.
---

# Pi Core Patch Maintenance

## Important architecture change

Pi 0.84.2 added supported extension-command dispatch:

```ts
pi.sendUserMessage("/registered-extension-command", {
  expandPromptTemplates: true,
});
```

Pi 0.84.3+ changed the Node CLI entrypoint to:

```text
dist/bundle/cli.js
```

The legacy patcher edits `dist/core/*`. Therefore an `11/11 applied` result
proves only that the modular files are patched; it does **not** prove that the
active bundled CLI contains `pi.executeCommand`. `/reload` reloads resources
and extensions but cannot rewrite already-imported core modules or inject the
modular patch into the bundle.

`agent_new_session` and `agent_reload_runtime` now keep their stable-idle polls
and dispatch their registered extension commands with
`expandPromptTemplates: true`. They no longer require the private core patch
and survive Pi npm updates.

## What the legacy patcher still does

`agent/core-patch/reapply-pi-core-patch.mjs` retains:

- modular-runtime `pi.executeCommand` compatibility edits
- historical Windows `windowsHide: true` edits
- backup-before-write, idempotency, static verification, and safe failure on
  source drift

Do not treat those modular sentinels as active bundled-CLI evidence.

## Slash commands

Both command families call the same compatibility patcher:

```text
/pi-core-new-session-patch check|apply|verify
/pi-core-reload-patch check|apply|verify
```

Aliases remain available:

```text
/pi-core-new-session-patch-check
/pi-core-new-session-patch-apply
/pi-core-new-session-patch-verify
/pi-core-reload-patch-check
/pi-core-reload-patch-apply
/pi-core-reload-patch-verify
```

After a successful `apply`, the slash-command wrapper automatically calls
`ctx.reload()` and returns. That reload activates the durable public bridge
extension; it does not pretend to hot-load dist/core changes into the bundle.

## Script commands

```text
node agent/core-patch/reapply-pi-core-patch.mjs check
node agent/core-patch/reapply-pi-core-patch.mjs apply
node agent/core-patch/reapply-pi-core-patch.mjs verify
node agent/core-patch/reapply-pi-core-patch.mjs status
node agent/core-patch/reapply-pi-core-patch.mjs list-backups
node agent/core-patch/reapply-pi-core-patch.mjs rollback [backupId]
```

Exit codes:

- `0`: success / fully applied
- `1`: edits needed
- `2`: safe failure due to source drift or unmatched target
- `3`: usage error

The standalone script never reloads or restarts Pi. Only the slash-command
wrapper performs the explicit post-apply extension reload.

## Recovery workflow

If an old loaded bridge says `pi.executeCommand is not available`:

1. Do **not** repeatedly reapply the compatibility patch.
2. Type `/reload` once or restart Pi to load the v4 bridge extension.
3. Retry `agent_new_session` or `agent_reload_runtime`.
4. Verify the canonical diagnostics.

If `/pi-core-new-session-patch apply` is run after v4 is loaded, it performs the
compatibility check/apply and automatically reloads extensions.

## Safety rules

- User-invoked only; no silent background patching.
- Safe-fail when anchors drift.
- Back up before mutation.
- Never patch minified `dist/bundle/chunks/*.js` as a long-term solution.
- Never omit `expandPromptTemplates: true` from public command dispatch.
- Dispatch bridge commands only after stable idle; expanded commands execute
  before Pi's streaming/follow-up queue logic.
- Do not call `process.exit()` from the patch extension.
- Treat `ctx.reload()` as terminal for the slash-command handler.

## Verification

Run:

```text
node agent/extensions/agent-new-session/public-command-dispatch.test.mjs
node agent/extensions/agent-reload/public-command-dispatch.test.mjs
node agent/extensions/agent-new-session/diagnostics-isolation.test.mjs
node agent/extensions/agent-reload/_verify-static.mjs
node agent/core-patch/verify-patch-command-registration.mjs
```

The registration verifier follows the real package `bin.pi` entrypoint,
confirms the bundle exposes `expandPromptTemplates`, and confirms it is not
mistaking modular `runtime.executeCommand` sentinels for bundled-runtime state.
