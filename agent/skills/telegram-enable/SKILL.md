---
name: telegram-enable
description: Enable automatic Telegram topic logon for future Pi windows. Use when invoking Telegram enable or explicitly asking future project windows to join Telegram automatically.
disable-model-invocation: true
---

# Telegram enable — future windows

Invoke `/skill:telegram-enable` or the shorter `/telegram-enable` in Pi. Treat explicit invocation as permission to set the **shared automatic-logon option for future interactive/RPC Pi sessions**, not to restart or reload existing windows.

1. Run `node scripts/enable.cjs --enable` with this skill directory as the working directory, or resolve that script to its absolute path. The helper selects the approved topics deployment, verifies its active router, and changes only `autoLogon: true` in its non-secret session settings. It never reads a bot token, changes legacy polling/ownership, edits scheduler/auth/environment settings, or starts/kills a process.
2. Require an `ok: true` result. If it fails, report the safe error; do not guess that the setting was applied or silently fall back to legacy enable/takeover.
3. Reply briefly: “Automatic Telegram logon is enabled for future Pi windows. Use /telegram-logon to connect this window now.” Explain that each future window still receives its own topic and folder label. To turn it off later, use native `/telegram disable` in a topics-mode Pi window.

Do not log on, rename, restart or reload existing sessions as part of this skill. Do not enable this setting merely because someone invokes `/telegram-logon` or asks for instructions; explicit enable permission is required.
