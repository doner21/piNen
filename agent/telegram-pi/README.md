# telegram-pi runtime directory

Runtime support files for the Telegram ↔ Pi active-session integration.
The extension itself lives at `../extensions/telegram-pi/index.ts`. This
directory holds the headless fallback daemon, Windows Task Scheduler scripts,
config examples, and runtime state/logs.

## Files

| File | Purpose |
|------|---------|
| `daemon.mjs` | Headless fallback supervisor. Hosts `pi --mode rpc` with the global `telegram-pi` extension when no active TUI session heartbeat exists; yields when one becomes active. |
| `install-windows-task.ps1` | Installs the Windows Task Scheduler entry that launches `daemon.mjs` at user logon. |
| `uninstall-windows-task.ps1` | Removes the Task Scheduler entry. Does not delete daemon/state/logs. |
| `config.example.json` | Non-secret config template. Copy to `config.json` and edit. **Never put the token here.** |
| `README.md` | This file. |

## Runtime-generated files (created by the extension/daemon, not committed)

| File | Purpose |
|------|---------|
| `state.json` | Non-secret runtime state (enabled flag, polling state, paired chat id prefix, offset, etc.). |
| `heartbeat.json` | Session heartbeat `{ "ts": <epochMs>, "at": <epochMs>, "mode": "tui", ... }`. Extension writes `ts` (primary) and `at` (compat). Daemon reads `hb.ts ?? hb.at`. Written by the extension in TUI/RPC mode; read by the daemon. |
| `daemon-state.json` | Non-secret daemon/fallback supervisor state (daemonPid, running, pid, startedAt, lastExit, lastError, lastErrorAt, consecutiveSpawnErrors). |
| `secret.token` | Optional 0600 stored bot token, written only by `/telegram setup` when the env var is absent and the user explicitly chooses to store it locally. Never printed. |
| `logs/daemon.log` | Redacted, rotated daemon log. |

## Security model

- **Token source of truth is the `TELEGRAM_BOT_TOKEN` environment variable.**
  Set it as a user env var so the TUI session, the daemon, and the Task
  Scheduler task (which runs as your user at logon) all see it:
  ```powershell
  setx TELEGRAM_BOT_TOKEN "<your token>"
  ```
  Then open a new shell / log off and back on so the env var is picked up.
- The optional `secret.token` file is a fallback only, written 0600 by
  `/telegram setup`, and is never printed, logged, returned by `status`/tool
  results, or passed as a process argument.
- The daemon **never** reads, logs, or passes the token. The spawned
  `pi --mode rpc` process inherits the daemon's environment, so the token
  reaches the extension via `process.env.TELEGRAM_BOT_TOKEN` only.
- Task Scheduler XML contains **no** token and **no** per-action env vars. The
  task runs as the interactive user at logon so it inherits the user env.
- All log lines are run through a redactor that strips Telegram bot token
  patterns (`123456789:AA...`) and replaces Bot API URLs
  (`https://api.telegram.org/bot.../...`) with `[tg-api-redacted]`.

## Heartbeat / advisory lock contract

The extension writes `heartbeat.json` with `{ "ts": <epochMs>, "at": <epochMs>, "mode": "tui" }`
on TUI `session_start` and refreshes it periodically while the TUI session is
alive. The daemon reads `hb.ts ?? hb.at` (legacy compat) and treats a heartbeat
younger than `heartbeatFreshSecs` (default 60s) with `mode === "tui"` as "active
TUI session":

- If the TUI heartbeat is **fresh**, the daemon does **not** start the
  `pi --mode rpc` fallback, and stops it if it was running (yields).
- If the TUI heartbeat is **stale or absent**, the daemon (re)starts the
  fallback so Telegram still works.

This guarantees the daemon and an active TUI session never compete. Only TUI
heartbeats gate the fallback (an RPC/daemon heartbeat does not block itself).

## Configured cwd

The fallback runs with the **configured cwd** so Pi scheduling services
(`agent-scheduler`, `scheduler.json`) still drain the correct cwd-scoped
wake-ups. The cwd is determined in this order:

1. `TELEGRAM_PI_CWD` env var.
2. `cwd` field in `config.json`.
3. `process.cwd()` of the daemon (hard default).

**No agent-scheduler file or behavior is modified by anything in this
directory.**

## Windows boot setup

1. Set the token env var (see above) and reopen your shell.
2. Run `/telegram setup` in a Pi TUI session to configure the allowed
   `from.id` (or `/telegram pair` after messaging the bot).
3. Install the boot task (from a shell in your usual project cwd):
   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.pi\agent\telegram-pi\install-windows-task.ps1" -Cwd "C:\path\to\your\project"
   ```
   Or via the extension: `/telegram daemon install`.
4. Confirm:
   ```powershell
   Get-ScheduledTask -TaskName TelegramPiDaemon
   Start-ScheduledTask -TaskName TelegramPiDaemon
   ```
5. To remove:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.pi\agent\telegram-pi\uninstall-windows-task.ps1"
   ```
   Or via the extension: `/telegram daemon uninstall`.

## Config file (config.json)

Copy `config.example.json` to `config.json` and edit. The daemon reads this
file on startup. Merge order: **hard defaults < config.json < env vars**.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `cwd` | string | `process.cwd()` | Working directory for fallback Pi |
| `piBinary` | string\|null | auto-detect | Path to pi binary. null = auto-detect |
| `heartbeatFreshSecs` | number | 60 | Max heartbeat age for TUI-active |
| `superviseIntervalSecs` | number | 10 | Supervisor check interval |
| `respawnCooldownSecs` | number | 15 | Min delay between respawns |
| `logMaxBytes` | number | 1000000 | Rotate log at size |
| `logMaxFiles` | number | 5 | Keep N rotated log files |

**piBinary auto-detect (Windows):** tries `%APPDATA%/npm/pi.cmd`, then
`%APPDATA%/npm/pi`, then falls back to `pi` on PATH.

**Never add a `token` field to config.json.** The daemon ignores any token
field. Token must come from `TELEGRAM_BOT_TOKEN` env var or `secret.token`.

## Daemon commands

- **Start:** `/telegram daemon start` spawns a detached `node daemon.mjs`
  process using `process.execPath`. No token args.
- **Stop:** `/telegram daemon stop` reads `daemon-state.json` for `daemonPid`
  and sends SIGTERM **only to that pid**. Does not kill arbitrary pi processes.
- **Status:** `/telegram daemon status` shows heartbeat info plus
  daemon-state.json summary (daemonPid, running, pid, startedAt, lastError,
  consecutiveSpawnErrors).
- **Install:** `/telegram daemon install` registers the Windows Task Scheduler
  entry (at logon, interactive user).
- **Uninstall:** `/telegram daemon uninstall` removes the task.

## Daemon behavior notes

- `daemon.mjs` is plain ESM (`.mjs`) and runs with `node` directly — no build.
- It keeps the child `pi --mode rpc` stdin **open** so the RPC process stays
  alive, but sends **no prompts**. The extension auto-starts Telegram polling
  on `session_start` when `autoStartPolling` is enabled (or when started via
  `/telegram start`).
- stdout from `pi --mode rpc` is split on `\n` **only** (strict JSONL framing).
  Node `readline` is intentionally **not** used, because it also splits on
  U+2028 / U+2029, which are valid inside JSON strings and would corrupt RPC.
- Logs are size-rotated (`daemon.log`, `daemon.log.0`, … up to `logMaxFiles`).
- On yield (TUI became active) the daemon closes the child's stdin, sends
  `SIGTERM`, and falls back to `taskkill /PID /T /F` after a 3s grace period
  on Windows.
- Crashed fallbacks are respawned after `respawnCooldownSecs` (default 15s).
- After 3 consecutive ENOENT spawn errors (pi binary not found), the daemon
  **fatal-stops** respawning until restart or config change.
- Daemon-state.json tracks `consecutiveSpawnErrors` and `lastError`/`lastErrorAt`
  (redacted) for diagnostics.
- `running: true` is written to daemon-state.json only after successful child
  spawn. Child errors write `running: false, pid: null` immediately.

## Manual real-Telegram test (for the user)

See `../extensions/telegram-pi/intake.md` "Manual real-Telegram test steps".
Summary: create a bot via @BotFather, set `TELEGRAM_BOT_TOKEN`, message the
bot in a private chat, `/telegram setup` or `/telegram pair`, `/telegram
start`, send a text prompt from Telegram, confirm it appears as a labelled
user message in the TUI and the assistant reply is mirrored back as
plaintext. Send a photo to confirm it is ignored (not errored). Close the
TUI and confirm the daemon fallback keeps Telegram working; reopen the TUI
and confirm the daemon yields.
