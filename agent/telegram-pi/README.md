# telegram-pi runtime directory

## Topics mode upgrade (2026-10-01)

With `TELEGRAM_PI_MODE=topics` or an approved non-secret `deployment.json` beside this file, `daemon.mjs` delegates to `forum-router.mjs`, the single bot owner. It does not spawn, time-limit or kill any Pi process. Sessions use authenticated local IPC, never poll, and keep their own forum topic across parent-session rotation. The token is always environment-only. A deployment pins its private group, allowlist, expected bot username and absolute runtime directory; inherited legacy group/allowlist variables cannot override approved IDs. Without deployment, isolated environment-only setup still works. State is separate (`routes.json`, `router-endpoint.json`, `router-control.json`, `session-settings.json`) in the selected runtime directory; capability files must remain local and private.

Deployment mode is selected by both future Pi windows and the existing daemon entry point without a Task Scheduler or global environment change. Invalid profiles fail closed, never silently start legacy polling. Automatic session logon remains opt-in (`/telegram enable`); otherwise use `/telegram logon [label]`. Already-loaded owner windows are not hot-upgraded. Normal deployed startup refuses a living legacy ownership claim. The approved initial migration observes the old loop's actual drained return through a temporary localhost diagnostic connection, resumes it and closes that listener, then pins a fresh router claim to keep cached legacy pollers quiet. It does not close/restart Pi or modify scheduler behaviour.

Use `/telegram logon [label]` / `logoff`. `enable` / `disable` controls opt-in future automatic logon. General `/sessions` and topic `/where` are router commands. Stop the router with `/telegram daemon stop`: authenticated local operator IPC drains work and confirms completion before permitting replacement. The operator capability differs from the session capability; normal session RPC cannot stop the router. No process kills or session deadlines are used. Do not infer shutdown from Windows console closure. Boot-task changes are deferred until owner approval. Do not run the legacy poller at the same time for this bot.

See `C:/Users/you/telegramupgrade/README.md` for setup, phone testing and installation status. **Installing source does not activate topics mode or update already-running windows. No real cutover or running-session reload/restart without separate owner approval while P7 is paused.**

## Document attachments

The bridge supports `send_document` and `/telegram send-document "<file>" [--caption "..."]` in topics and legacy modes. Non-empty regular local files up to 10MB are supported; network shares, symlinks and obvious credentials are refused. Plaintext captions are limited to 1024 characters. Credential scanning is best-effort; do not upload secrets or disguised credential exports.

Successful sends return `message_id`, basename and byte size. Do not automatically retry unconfirmed uploads. Topics mode uses the authenticated router and permits only the session's own live binding. It checks document capability before reading the file, so installing source requires an orderly shared-router restart and a session extension reload. Older sessions keep working for text/photos and need their own authorized reload to gain document tools.

Offline regressions from this staged candidate: `node --test tests/documents.test.cjs tests/reload.test.cjs tests/inbound.test.cjs`. Tests use read-only staged dependencies and newly owned canonical external Temp directories, not candidate scratch, live credentials or Telegram polling.

## Receiving pictures and documents

The existing bot owner downloads attachments; no new poller is introduced. Topics mode requires an allowlisted non-bot sender in the pinned private group, a live bound topic, queue space, and an adapter advertising `receive_attachments`. Old adapters refuse attachments before downloading; old routers remain text-compatible but do not receive attachments. Both router and adapter must load this upgrade through a separately owner-approved transition; **nothing here activates or reloads live installations**. Legacy attachment reception additionally requires the exact explicitly paired chat/topic and the current session ownership claim.

- One non-empty attachment per update, maximum **10MiB (10,485,760 bytes)** in metadata and the actual streamed response. Missing/invalid size, oversized variants, mismatched size, unsafe filename/MIME, redirects, unsafe `getFile` paths, unsupported content and recognizable credentials are refused. Unauthorized users/groups are silently ignored (no fetch and no routing information); authorized unbound/offline/unsupported sessions receive a static refusal.
- Pictures: JPEG, PNG, WebP, including images sent as documents. Captions (up to 1024 characters) are quoted untrusted data. A model advertising image input receives genuine Pi `ImageContent` with base64 bytes and MIME, not a pathname/placeholder. Without image capability, reception is refused. Image validation is basic signature/container/dimension validation, not a complete image decoder.
- Documents: PDF, Word `.doc`/`.docx`, RTF, UTF-8 text/Markdown/CSV/JSON, with matching MIME/extension and basic content checks. Code/executable formats, arbitrary archives, SVG/HTML and macro-enabled Word extensions are unsupported. No archive is expanded, document parser launched, code executed, slash command dispatched, or prompt template expanded by reception.
- Documents are stored byte-exactly under the receiving runtime's `attachments/<session-and-lease-hash>/attachment-<random>.<extension>`, with generated names, exclusive creation, canonical ancestor/link checks and private mode flags. Only that receiving session receives the inspection path; runtime-root paths are redacted from mirrored replies. Ordinary router/state JSON contains offsets/ticket metadata, never raw attachment bytes. Pi's own image conversation history can persist structured image data.
- **Storage is not parsing.** No PDF/Word parser is bundled or automatically run. The model can read text using its tools; binary PDFs/Word need an available safe parser and scans/encryption may be unreadable. Word/container validation is not malware certification. Secret scanning is best-effort, including UTF-16; compressed/encrypted/obfuscated secrets may evade it. Do not upload secrets. The bridge is not an OS sandbox: same-account processes retain their existing file permissions.
- Duplicate updates, offline delivery, disconnects and rotation never replay attachments into a new session. Refused/uncertain updates are consumed; resend explicitly after reconnecting if appropriate. Session-owned files remain for later inspection; there is no automatic deletion timer. Owner cleanup is a separate decision.

### Future owner-only live testcard (not performed by this build)

After separate approval for activation, use only a purpose-started isolated Pi session and a separate test bot/private group. Log on its own topic with an image-capable model. Send a small recognizable photo with a caption and ask what is visible; verify the model describes the actual picture and caption. Send a harmless small PDF/Word/text document and ask for inspection; verify a session-local path, exact size, and honest parser limitations rather than a fabricated summary. Send the same types in an unbound topic/from a nonallowlisted user and verify no delivery. Send an unsupported/over-10MiB attachment and verify a clear refusal. Log off, send an attachment, then log on/rotate: verify no replay. Finally explicitly send text, a photo and a document outbound and confirm prior behavior. Do not use secrets, real owner files, uploaded executable code, or live owner sessions for this test.

## Legacy-mode reference

The remainder describes the unchanged legacy branch only; do not use its fallback-process/force-stop instructions in topics mode.

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
  Enter it privately into the approved local launch console, without echoing it:
  ```powershell
  $secret = Read-Host 'Bot token (hidden)' -AsSecureString
  $env:TELEGRAM_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
  Remove-Variable secret
  ```
  Start only newly approved processes from that console. Never put the token in `setx` or other CLI arguments, chat, config or task XML; do not restart an active owner Pi session.
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
plaintext. After separate owner approval, send a small harmless photo with a caption to verify structured model image delivery (image-capable model required); see the future owner-only testcard above. Close the
TUI and confirm the daemon fallback keeps Telegram working; reopen the TUI
and confirm the daemon yields.
