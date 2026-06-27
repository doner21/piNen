---
name: telegram-session-takeover
description: Make the current Pi session the active Telegram receiver when Telegram messages go to the wrong session, polling shows 409 conflict, or the user asks to stop other Telegram sessions and route Telegram here. Uses only non-secret telegram_pi actions and never exposes the bot token.
---

# Telegram Session Takeover

Use this skill when the user asks to make **this** Pi session receive Telegram messages, reports Telegram messages are not arriving here, or wants to resolve `409 conflict (another poller active)`.

## Security invariants

- Never request, print, log, or store `TELEGRAM_BOT_TOKEN`.
- Never kill arbitrary Pi/node processes.
- Only use `telegram_pi` non-secret actions and documented `/telegram` commands.
- The takeover action may stop the recorded Telegram daemon pid from `daemon-state.json`; it must not kill unrelated processes.

## Agent workflow

1. Check current bridge state:

```text
telegram_pi({ action: "status" })
```

2. If any of these are true, take over:
   - user explicitly asked to make this session the Telegram session
   - `lastError` contains `409`
   - `polling` is false but token/allowlist/paired chat are configured
   - `activeSession.owner` is false or another active session is shown

```text
telegram_pi({ action: "takeover" })
```

3. Verify:

```text
telegram_pi({ action: "status" })
```

Success criteria:
- `polling: true`
- `activeSession.owner: true`
- no current `lastError` containing `409`
- `tokenConfigured: true`
- `allowlistCount >= 1`
- `pairedChatId` is set

4. Optional confirmation to paired chat:

```text
telegram_pi({ action: "send", text: "Telegram bridge is active in this Pi session." })
```

## User workflow

In the Pi session that should receive Telegram messages, run:

```text
/telegram takeover
/telegram status
```

If status shows polling is true and this session owns the active-session claim, Telegram messages should route here.

## If takeover does not clear 409

- Wait a few seconds and run `telegram_pi({ action: "takeover" })` once more.
- Check `telegram_pi({ action: "daemon_status" })`.
- If 409 persists, an old Pi process without takeover support may still be polling. Ask the user to close the older Pi session; do not kill arbitrary processes automatically.
