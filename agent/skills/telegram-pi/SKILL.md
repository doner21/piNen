---
name: telegram-pi
description: Operational and security guidance for the Telegram ↔ Pi bridge. Use this skill whenever the agent is asked about Telegram, /telegram commands, telegram_pi tool, daemon management, session takeover, polling conflicts, or Telegram token configuration. This skill NEVER provides actual bot tokens or encourages printing them.
---

# Telegram ↔ Pi Bridge — Agent Skill

## Security Rules (ALWAYS FOLLOW)

1. **NEVER request, print, log, or store the bot token.** Do not ask the user for their token. Do not echo it. Do not write it to any file except via `secret.token` (0600) using `/telegram setup`'s built-in flow.
2. **Token source of truth:** `TELEGRAM_BOT_TOKEN` environment variable (preferred). The 0600 `secret.token` file is a fallback written only by `/telegram setup`.
3. **Never put the token in:**
   - `config.json` (the daemon never reads a token from config)
   - CLI arguments
   - Task Scheduler XML
   - Any log or returned tool result
4. **Do NOT install the Windows Task Scheduler entry** (`/telegram daemon install`) unless the user explicitly asks for it.
5. **Do NOT touch** `agent/extensions/agent-scheduler/` or `agent/scheduler.json`. The telegram-pi bridge is independent of agent scheduling.
6. **Use `/telegram` and `telegram_pi` safely:** these commands/tools expose only non-secret actions (status, send, start, stop, daemon status, list chats, setup, pair).
7. **The `telegram_pi` tool** never accepts or returns the bot token. Available actions: `status`, `send`, `start`, `stop`, `takeover`, `daemon_status`, `list_chats`, `setup`, `pair`.
8. **Redaction:** All internal error surfaces redact the Bot API URL and token patterns before logging or surfacing to the user.

## 🔧 Frictionless Setup Guide

The bridge can be set up frictionlessly in two ways:

### A. Agent setup (headless, via `telegram_pi` tool)

Requires three environment variables to be set:

| Env Var | Purpose | Example |
|---------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `123456:ABC-DEF...` |
| `TELEGRAM_ALLOWED_FROM` | Comma-separated Telegram user IDs | `878335142` |
| `TELEGRAM_CHAT_ID` | Paired chat ID (usually same as user ID) | `878335142` |

**One-shot command:**

```
telegram_pi({ action: "setup" })
```

This will:
1. ✅ Read `TELEGRAM_BOT_TOKEN` and validate it via `getMe`
2. ✅ Read `TELEGRAM_ALLOWED_FROM` → populate allowlist
3. ✅ Read `TELEGRAM_CHAT_ID` → set paired chat (also adds to allowlist)
4. ✅ Set `enabled: true` (auto-start on session boot)
5. ✅ Start polling immediately
6. Return a status message

**Pair the most recent sender** (if someone already messaged the bot):

```
telegram_pi({ action: "pair" })
```

### B. User setup (interactive, via `/telegram setup`)

In a TUI session:

```
/telegram setup
```

Follow the prompts for token and allowlist. If all three env vars are already set, `/telegram setup` runs headlessly without interactive prompts.

**After setup**, you can also:

```
/telegram enable      # ensure auto-start on next session boot
/telegram start       # start polling now
```

### C. Quick status check

```
telegram_pi({ action: "status" })
```

Key fields to inspect:
- `tokenConfigured` + `tokenSource` — token is present and from env (preferred) or file
- `allowlistCount` — at least 1 sender allowed
- `pairedChatId` / `pairedThreadId` — the explicit reply target, including forum topic when paired from a topic
- `lastSeenChatId` / `lastSeenThreadId` — the most recent chat/topic the bot observed; use this to detect private-chat pairing vs group/topic traffic
- `polling` — polling is actively running
- `enabled` — auto-start is enabled
- `activeSession` — which Pi process currently claims Telegram ownership
- `lastError` — any recent Bot API/send errors

## Active-session takeover workflow

Use this whenever the user says Telegram messages are going to the wrong Pi session, asks to make **this** Pi session the Telegram session, or status shows a `409 conflict (another poller active)`.

### Agent path

1. Call `telegram_pi({ action: "status" })`.
2. If status shows `lastError` containing `409`, `activeSession.owner: false`, or the user explicitly wants this session to receive Telegram messages, call:

```
telegram_pi({ action: "takeover" })
```

3. Call `telegram_pi({ action: "status" })` again.
4. Success criteria:
   - `polling: true`
   - `activeSession.owner: true`
   - no current `lastError` containing `409`
5. Optionally send a short test message with `telegram_pi({ action: "send", text: "Telegram bridge is active in this Pi session." })`.

### User path

In the Pi TUI session that should receive Telegram messages, run:

```
/telegram takeover
/telegram status
```

If `/telegram status` reports `polling: true`, an active-session claim owned by this session, and no 409 error, this session is now the Telegram receiver.

### Limits

- The takeover path never prints or stores tokens.
- It only stops the recorded Telegram daemon pid. It does **not** kill arbitrary Pi/node processes.
- Updated competing Pi sessions yield when they observe another fresh active-session claim. Very old sessions that do not have this takeover code may need to be closed manually if 409 persists.

## Commands

### /telegram status
Shows non-secret runtime state: enabled, polling, token configured (source only, not value), allowlist count, paired chat id (prefix), heartbeat info, lastError.

### /telegram setup
Guided first-run setup. When all three env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_FROM`, `TELEGRAM_CHAT_ID`) are set, it auto-configures without interactive prompts (works headlessly). When env vars are missing, prompts for token (if absent, stores 0600), loads allowlist, and pairs sender.

### /telegram pair
Pairs the most recent Telegram sender (from `lastSeenFromId`) into the allowlist and sets `pairedChatId`. In a group/forum topic, send a bot-visible message from that exact chat/topic first, then run `/telegram pair`; status should show the group `pairedChatId` and positive `pairedThreadId` when Telegram provided one.

### /telegram start
Starts Telegram polling in the current session. Requires token + allowlist.

### /telegram stop
Stops polling in the current session.

### /telegram takeover
Makes the current Pi session the active Telegram receiver. This claims an `active-session.json` advisory ownership record, asks updated competing sessions to yield, stops the Telegram daemon if it is recorded in `daemon-state.json`, resets polling in the current session, and restarts polling here. Use this when Telegram messages are going to the wrong Pi session or status shows `lastError: 409 conflict (another poller active)`.

### /telegram enable / disable
Toggles auto-start polling on `session_start`.

### /telegram send <text>
Sends plaintext to the paired chat. No Markdown/HTML.

### /telegram daemon status
Shows heartbeat state AND daemon-state.json summary (daemonPid, running, pid, startedAt, lastError, consecutiveSpawnErrors).

### /telegram daemon start
Spawns a detached `node daemon.mjs` process using `process.execPath`. No token args. The daemon then supervises a `pi --mode rpc` fallback. Check status after starting.

### /telegram daemon stop
Reads `daemon-state.json`, extracts `daemonPid`, and sends SIGTERM **only to that pid**. Does NOT kill arbitrary pi processes.

### /telegram daemon install
Runs `install-windows-task.ps1` to register a Task Scheduler entry (at logon, interactive user, no token in XML).

### /telegram daemon uninstall
Runs `uninstall-windows-task.ps1`.

### /telegram help
Shows the help text.

## Tool Actions (`telegram_pi`)

| Action | Description | Works Headlessly |
|--------|-------------|:---:|
| `status` | Show runtime state | ✅ |
| `setup` | One-shot setup from env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_FROM`, `TELEGRAM_CHAT_ID`) | ✅ |
| `pair` | Pair the most recent Telegram sender | ✅ |
| `start` | Start polling | ✅ |
| `stop` | Stop polling | ✅ |
| `takeover` | Make this session the active Telegram receiver and resolve ordinary polling conflicts | ✅ |
| `send` | Send plaintext to paired chat | ✅ |
| `daemon_status` | Show heartbeat/daemon state | ✅ |
| `list_chats` | List known chat id prefixes | ✅ |

## Files and Layout

| Path | Purpose |
|------|---------|
| `agent/extensions/telegram-pi/index.ts` | Main extension: polling, mirroring, /telegram command, telegram_pi tool |
| `agent/telegram-pi/daemon.mjs` | Headless fallback supervisor (pi --mode rpc) |
| `agent/telegram-pi/config.example.json` | Non-secret daemon config template. Copy to `config.json` |
| `agent/telegram-pi/install-windows-task.ps1` | Windows Task Scheduler installer |
| `agent/telegram-pi/README.md` | User-facing documentation |
| `agent/skills/telegram-pi/SKILL.md` | This file |

## Manual Real-Telegram Test Steps

1. **Create a bot** via [@BotFather](https://t.me/BotFather) and get the token.
2. **Set the token:** `setx TELEGRAM_BOT_TOKEN "<token>"` (then restart terminal/Pi).
3. **Start Pi in TUI mode** and run `/telegram setup` to configure token + allowlist.
4. **Message the bot** from a private Telegram chat.
5. **Run `/telegram pair`** to add the sender to the allowlist.
6. **Run `/telegram start`** to begin polling.
7. **Send a text prompt** from Telegram. It should appear as a labelled user message in the TUI. The assistant reply should be mirrored back as plaintext to Telegram.
8. **Send a photo** to confirm it is ignored (not errored).
9. **Close the TUI** and confirm the daemon fallback keeps Telegram working (start daemon first if needed: `/telegram daemon start`).
10. **Reopen the TUI** and confirm the daemon yields (heartbeat gating).

## Group / Forum Topic Reply Troubleshooting

If group/topic messages reach Pi but replies do not return to the group/topic:

1. Reload or restart Pi after extension source changes; old sessions keep old extension code.
2. In the target group/topic, send a bot-visible text command/message (disable BotFather privacy if ordinary messages are invisible, or @mention/reply/use a bot command).
3. Run `/telegram status`; verify `lastSeenChatId` is the group chat, `lastSeenFromId` is the allowlisted user, and `lastSeenThreadId` is a positive integer for the topic when present.
4. Run `/telegram pair` from Pi to replace stale private-chat pairing with the group/topic target.
5. Run `/telegram status` again; `pairedChatId` should match the group prefix and `pairedThreadId` should match the topic if Telegram supplied one.
6. If sends still fail, inspect `lastError`; Bot API `sendMessage` errors are redacted and stored there.

Plaintext `/telegram send` now falls back to the most recent allowed group/topic when setup is still paired to that user's private chat (`pairedChatId == lastSeenFromId`). Reply mirroring for Telegram-origin prompts still uses the exact incoming chat/topic.

## Agent Setup Quick-Start (for Pi agents)

When a user asks you to set up the Telegram bridge:

1. **Check if env vars are set.** The key three are:
   - `TELEGRAM_BOT_TOKEN` — required
   - `TELEGRAM_ALLOWED_FROM` — required for allowlist
   - `TELEGRAM_CHAT_ID` — recommended for paired chat

2. **If all three are set**, call `telegram_pi({ action: "setup" })`. This does everything in one shot.

3. **If only the token is set**, use `/telegram setup` (the command has a headless auto-path when it detects TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_FROM + TELEGRAM_CHAT_ID are all present). If only some are set, guide the user to set the missing env vars.

4. **If nothing is set**, guide the user through:
   - Creating a bot on @BotFather
   - Setting env vars (recommended) or running `/telegram setup` in TUI mode

5. **After setup**, verify with `telegram_pi({ action: "status" })`.

6. **Troubleshooting:**
   - `tokenConfigured: false` → token not set
   - `polling: false` → call `telegram_pi({ action: "start" })`
   - `allowlistCount: 0` → need to pair or set `TELEGRAM_ALLOWED_FROM`
   - `lastError` contains `401` or `404` → bad token
   - `lastError` contains `409` → another poller (daemon or other session) is active; call `telegram_pi({ action: "takeover" })` to make the current session the Telegram receiver

## Daemon Behavior

- The daemon reads optional `config.json` (cwd, piBinary, heartbeatFreshSecs, superviseIntervalSecs, respawnCooldownSecs, logMaxBytes, logMaxFiles).
- **Never reads token from config.**
- Merge order: **hard defaults < config.json < env vars**.
- `piBinary` auto-detect on Windows: tries `%APPDATA%/npm/pi.cmd`, then `%APPDATA%/npm/pi`, then falls back to `pi`.
- The daemon writes `running: true` in `daemon-state.json` **only after successful child spawn**.
- On child error: writes `running: false`, `pid: null`, redacted `lastError`/`lastErrorAt`, increments `consecutiveSpawnErrors`.
- After 3 consecutive ENOENT spawn errors: **fatal stop** (no more respawns until daemon restart or config change).
- Heartbeat uses `ts` field (epochMs). Daemon reads `hb.ts ?? hb.at` for legacy compat.

## Heartbeat Contract

- Extension writes `heartbeat.json` with `{ pid, mode, ts, at?, cwd }` on session_start and every 20s.
- Daemon treats a heartbeat younger than `heartbeatFreshSecs` (default 60s) with `mode === "tui"` as "active TUI session."
- Active TUI → daemon yields (stops fallback).
- Stale/absent TUI → daemon (re)starts fallback.

## Config Fields (config.json)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `cwd` | string | `process.cwd()` | Working directory for fallback Pi |
| `piBinary` | string\|null | auto-detect | Path to pi binary |
| `heartbeatFreshSecs` | number | 60 | Max heartbeat age for TUI-active |
| `superviseIntervalSecs` | number | 10 | Supervisor check interval |
| `respawnCooldownSecs` | number | 15 | Min delay between respawns |
| `logMaxBytes` | number | 1000000 | Rotate log at size |
| `logMaxFiles` | number | 5 | Keep N rotated log files |

**Never add a `token` field to config.json.**
