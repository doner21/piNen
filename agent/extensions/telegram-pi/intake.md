# Telegram ↔ Pi Active-Session Integration — Intake

## Original prompt

> Implement a secure Telegram ↔ Pi active-session integration under
> `~\.pi`. Telegram should be able to message the active PiNen/Pi
> TUI session view (not only a default headless instance). Telegram-origin
> messages must appear visibly in the session as user messages. Pi assistant
> replies for Telegram-origin prompts should be sent back to Telegram. The user
> and agent manage it via `/telegram` and `/skill:telegram-pi`; the agent also
> has a safe tool to query status / send messages. First-run setup guides the
> user when the bot token, allowed Telegram chat/user ID, or other required
> values are missing. An optional Windows boot daemon hosts the same global
> extension in `pi --mode rpc` fallback when no active TUI session heartbeat
> exists, and yields when one becomes active. Existing Pi scheduling services
> must remain intact — do not modify agent-scheduler files or behavior.

## Task statement

Build a global Pi extension (`agent/extensions/telegram-pi/index.ts`) plus a
runtime support directory (`agent/telegram-pi/`) and a skill
(`agent/skills/telegram-pi/SKILL.md`) that connect a Telegram bot to the
*active* Pi session, with a secure, guided first-run setup and an optional
Windows boot daemon fallback that does not compete with an active TUI session.

## Primary users

- The human user, via `/telegram` slash command and `/skill:telegram-pi`.
- The active LLM agent, via the safe `telegram_pi` tool (non-secret actions only).
- A Windows boot daemon (`agent/telegram-pi/daemon.mjs`) that hosts a headless
  `pi --mode rpc` fallback when no active TUI heartbeat exists.

## Core use cases

1. **First-run setup**: `/telegram setup` guides the user to provide a bot
   token (env var preferred) and an allowed Telegram chat/user ID. Never prints
   or leaks the token.
2. **Pairing**: `/telegram pair` associates the currently authorized Telegram
   `from.id` with the active Pi session as the default reply target.
3. **Start/stop polling**: `/telegram start` and `/telegram stop` begin/abort
   long-polling the Telegram Bot API in the active session.
4. **Enable/disable**: `/telegram enable|disable` toggles auto-start on session
   start without immediately polling.
5. **Send from agent**: `telegram_pi` tool action `send` lets the agent post a
   plaintext message to the paired Telegram chat.
6. **Status**: `/telegram status` and `telegram_pi` action `status` show
   non-secret runtime state (enabled, polling, paired chat id prefix, heartbeat
   age, daemon state).
7. **Daemon management**: `/telegram daemon status|install|uninstall|start|stop|help`
   installs/uninstalls/controls the Windows Task Scheduler entry that launches
   the headless fallback at boot.
8. **Active-session delivery**: Telegram-origin text appears as a visible user
   message in the active TUI session via `pi.sendUserMessage()`.
9. **Reply mirroring**: The assistant reply for a Telegram-origin prompt is sent
   back to Telegram (cautiously, request-id correlated, plaintext only).
10. **Headless fallback**: When no active TUI heartbeat exists, the daemon
    hosts the same global extension in `pi --mode rpc` so Telegram still works.

## Invariants (security & correctness)

- **Token never leaks.** The bot token is read from an env var
  (`TELEGRAM_BOT_TOKEN`) first; if a local secret must be stored, it is written
  to a 0600 file under `agent/telegram-pi/` and never printed, logged, returned
  by `status`/tool results, or passed as a process argument / Task Scheduler
  XML field.
- **No token via tool.** The `telegram_pi` tool exposes only non-secret actions
  (status, send, start, stop, daemon_status, list_chats). It never accepts or
  returns the token.
- **Allowlist enforcement.** Only Telegram updates from private, group, or
  supergroup chats whose message `from.id` is in the configured allowlist are
  processed. Channels, unsupported chat types, and unallowlisted senders are
  ignored. Default policy: allowlist is empty until the user pairs.
- **Text-only updates.** Only `message.text` updates are handled. Photos,
  stickers, voice, callbacks, inline queries, etc. are ignored (not errored).
- **Input neutralization.** Telegram-origin user text is surfaced as a visible
  user message but is neutralized/labelled so it cannot inject hidden
  instructions, control characters, or伪装 slash commands. A clear marker
  indicates the message originated from Telegram.
- **No parse_mode.** Outgoing Telegram messages are sent as plaintext
  (`sendMessage` with no `parse_mode`) to avoid Markdown/injection issues.
- **`send_photo` safety.** Uploading a local image (`sendPhoto` via
  multipart/form-data) is a higher-risk action than text, so it is gated:
  requires an explicit paired chat (no `lastSeenChatId` fallback), validates the
  file is a real image by magic bytes (JPEG/PNG/WebP, with WebP verified by the
  `WEBP` FourCC at offset 8), rejects symlinks and directories, enforces a
  10MB client-side cap, never logs file contents, and surfaces only the
  basename (never the full path) in error messages. Captions are plaintext,
  capped at 1024 chars, with no `parse_mode`. Multipart calls carry a finite
  upload timeout.
- **Reply mirroring is cautious.** Only the assistant reply corresponding to a
  Telegram-origin prompt is mirrored, correlated by a request id, and split into
  plaintext chunks below the Telegram 4096-char limit. Local TUI conversation
  never leaks to Telegram except for the explicitly mirrored reply.
- **Offset persistence.** The Telegram `offset` is persisted only after an
  update is delivered or deliberately ignored, never before, so a crash does not
  skip updates.
- **Heartbeat / advisory lock.** An active TUI session writes a heartbeat; the
  daemon checks it before starting the headless fallback and yields/stops the
  fallback when a TUI heartbeat becomes active, so the two never compete.
- **Abortable polling.** Polling uses `AbortSignal`, exponential backoff, and
  handles `deleteWebhook`, HTTP 409 (conflict from another poller), and network
  errors without crashing the session.
- **No scheduler modifications.** Existing Pi scheduling services
  (`agent/extensions/agent-scheduler`, `agent/scheduler.json`,
  `scheduler.lock`) must remain completely untouched. The daemon must use the
  configured cwd so scheduled wakeups still work.
- **No real credentials required for review.** The implementation must pass
  static code review without real Telegram credentials or network access.

## Scope

In scope:
- Global Pi extension `agent/extensions/telegram-pi/index.ts`.
- Runtime directory `agent/telegram-pi/` (daemon, config examples, logs,
  install/uninstall Windows Task Scheduler scripts, state files).
- Skill `agent/skills/telegram-pi/SKILL.md` plus referenced setup/security docs.
- Static verification without real Telegram access.

Out of scope (non-goals):
- Receiving non-text Telegram updates (media, stickers, voice, callbacks).
- Markdown/formatting in outgoing Telegram messages.
- Channel broadcasting. Group/supergroup support is limited to allowlisted
  `from.id` text messages and preserves forum-topic thread ids for replies.
- OS-level wake-from-sleep or launching Pi when no Pi process exists beyond the
  Task Scheduler boot entry.
- Modifying any agent-scheduler file or behavior.
- Mobile/Telegram-native UI changes.
- End-to-end encryption or alternative transports.

## Proposed artifact locations

- Extension implementation: `agent/extensions/telegram-pi/index.ts`
- Intake artifact: `agent/extensions/telegram-pi/intake.md` (this file)
- Runtime/state directory: `agent/telegram-pi/`
  - `daemon.mjs` — headless fallback supervisor
  - `install-windows-task.ps1` — Task Scheduler install
  - `uninstall-windows-task.ps1` — Task Scheduler uninstall
  - `README.md` — config examples and security notes
  - `config.example.json` — non-secret config template
  - `state.json` — non-secret runtime state (offset, paired chat id prefix,
    enabled flag, heartbeat)
  - `secret.token` — optional 0600 stored token (only if env var absent)
  - `logs/` — rotated, redacted logs
- Skill: `agent/skills/telegram-pi/SKILL.md`

## Public API candidates

### Command: `/telegram`

Subcommands:
- `status` — non-secret runtime state.
- `setup` — guided first-run configuration (token + allowlist).
- `pair` — associate the authorized Telegram `from.id` with this session.
- `start` — begin polling in the active session.
- `stop` — abort polling.
- `enable` / `disable` — toggle auto-start on session start.
- `send <text>` — send a plaintext message to the paired chat.
- `daemon status|install|uninstall|start|stop|help` — manage the boot daemon.

### Tool: `telegram_pi`

Non-secret actions only:
- `status` — runtime state (no token).
- `send` — post plaintext to the paired chat.
- `start` / `stop` — control polling.
- `daemon_status` — daemon + heartbeat state.
- `list_chats` — list paired/known chat id prefixes (if implemented).

### Daemon

- `agent/telegram-pi/daemon.mjs` supervises `pi --mode rpc` with the global
  extension loaded, using the configured cwd, keeping stdin open, avoiding
  Node `readline` for RPC parsing, redacting/rotating logs, and never passing
  the token via process args or Task Scheduler XML.

## Design constraints from Pi docs

- Extensions run with full system permissions; only trusted code is acceptable.
- Background resources (polling, timers, watchers) must start on `session_start`
  or from commands/tools — never in the extension factory.
- `session_shutdown` must close pollers/timers and persist state.
- `pi.sendUserMessage(content, { deliverAs })` injects a visible user message
  that triggers an agent turn; use `followUp` when the agent is busy so Telegram
  messages do not interrupt active work.
- `message_end` (assistant role) is the hook for reply mirroring; correlation
  to a Telegram-origin prompt is done via a request id, cautiously.
- Tools receive `ExtensionContext` (no session-switch/reload APIs); commands
  receive `ExtensionCommandContext`.
- RPC mode is JSONL over stdin/stdout with LF-only framing; Node `readline` is
  NOT protocol-compliant (it splits on U+2028/U+2029). The daemon must parse
  RPC with a strict LF splitter and keep stdin open.
- State under the Pi agent directory (`getAgentDir()`) survives reloads; atomic
  write (temp + rename) and an advisory lock are the established pattern (see
  the agent-scheduler extension).

## Acceptance criteria

- Files exist at the locations above; extension registers `/telegram` and the
  `telegram_pi` tool.
- `/telegram status` and `telegram_pi status` return only non-secret data; no
  raw token, and Bot API URLs/errors are redacted.
- First-run setup guides the user when token / allowed chat id are missing.
- Polling is abortable, uses backoff, calls `deleteWebhook`, and handles HTTP
  409 without crashing.
- Telegram-origin text is delivered as a visible, neutralized, labelled user
  message; offset is persisted only after delivery/ignore.
- Assistant replies for Telegram-origin prompts are mirrored to Telegram as
  plaintext, request-id correlated, split below 4096 chars.
- Heartbeat/advisory lock prevents the daemon from competing with an active TUI
  session; the daemon hosts `pi --mode rpc` fallback otherwise.
- Daemon/task scripts never include the token in process args or Task Scheduler
  XML; logs are redacted and rotated.
- No agent-scheduler file is created, modified, or deleted.
- Skill docs cover `/telegram`, `telegram_pi`, first-run setup, pairing, daemon
  operations, Windows boot instructions, manual real-Telegram testing, the
  non-text update policy, the private-chat/`from.id` allowlist defaults, input
  neutralization, no `parse_mode`, no raw token output, no token via tool, no
  local TUI conversation leakage, and no scheduler modifications.
- Static/type/syntax checks pass as far as this Pi extension environment allows,
  without real Telegram credentials.

## Group / forum-topic operational notes

- In Telegram groups, bot privacy mode can prevent the bot from seeing ordinary
  messages. The bot owner may need to use @BotFather `/setprivacy Disable`; if
  privacy stays enabled, users must @mention the bot, use a bot command, or
  reply to one of the bot's messages.
- Forum topics / private-chat topics may require enabling topic mode in
  @BotFather before topic-thread metadata is delivered.
- After patching, reload/restart Pi because existing sessions keep old
  extension code.
- To repair stale private-chat pairing, send a bot-visible message from the
  target group/topic, run `/telegram status`, verify `lastSeenChatId` is the
  group and `lastSeenThreadId` is a positive integer when a topic is present,
  then run `/telegram pair`. Verify `pairedChatId`/`pairedThreadId` now match
  the group/topic.
- Redacted Bot API `sendMessage` failures are surfaced through `lastError` in
  `/telegram status` and `telegram_pi({ action: "status" })`.
- Plaintext `/telegram send`/`telegram_pi send` may use the most recent allowed
  group/topic when the explicit pairing is still the same user's private chat;
  Telegram-origin reply mirroring always uses the incoming chat/topic captured
  for that prompt.

## Manual real-Telegram test steps (for the user)

1. Create a bot via @BotFather; copy the token. Set `TELEGRAM_BOT_TOKEN` env
   var (preferred) or run `/telegram setup` and provide it (stored 0600, never
   printed again).
2. In a private Telegram chat with the bot, send any message.
3. Run `/telegram setup` to set the allowed Telegram chat/user id (the `from.id`
   from step 2, or use `/telegram pair` after sending a message).
4. Run `/telegram start`. Confirm `/telegram status` shows polling active.
5. From Telegram, send a text prompt. Confirm it appears as a visible, labelled
   user message in the active Pi TUI session.
6. Confirm the Pi assistant reply is mirrored back to Telegram as plaintext.
7. Send a non-text update (photo/sticker); confirm it is ignored, not errored.
8. Run `/telegram stop`; confirm polling aborts and status reflects it.
9. Close the TUI. Confirm the boot daemon starts the `pi --mode rpc` fallback
   and Telegram still works. Reopen the TUI; confirm the daemon yields.
10. Run `/telegram daemon uninstall` to remove the Task Scheduler entry.

## Open questions / assumptions

- Assumption: "active PiNen/Pi TUI session" means a running Pi session in TUI or
  RPC mode with a live heartbeat; the daemon's headless fallback is the same
  global extension in `pi --mode rpc`.
- Assumption: a single paired private chat is the default reply target; the
  allowlist may contain multiple `from.id` values but only one is the active
  reply target per session.
- Assumption: the user will reload/restart Pi after installing the extension.
- Assumption: the bot token env var name is `TELEGRAM_BOT_TOKEN`; an optional
  stored-secret file is used only as a fallback when the env var is absent and
  the user explicitly chooses to store it locally.
- Assumption: reply mirroring correlates the assistant reply to the most recent
  Telegram-origin prompt via a request id; if correlation is ambiguous, the
  reply is not mirrored (fail-closed) rather than risk leaking unrelated TUI
  content.
