---
name: telegram-logon
description: Connect this Pi window to its own Telegram topic. Use when invoking Telegram logon or asking to put the current project window on the phone.
disable-model-invocation: true
---

# Telegram logon — this window only

Invoke `/skill:telegram-logon [label]` or the shorter `/telegram-logon [label]` in the desired **Pi window**, not in Telegram. Interpret an optional argument only as the topic's display label, not a request to switch folders or control another window.

1. Call `telegram_pi` with `action: "status"`. Require `mode: "topics"` before changing anything. If this window still has legacy code, stop and explain that it needs a new window or a separately approved safe reload; never use legacy `start`/`takeover`, reload, restart or stop a project automatically.
2. Call **this window's** `telegram_pi` with `action: "logon"` and the optional `label`. Omit the label to use the current session/project name. Do not register a surrogate session from a shell script.
3. Call `telegram_pi` status again. Verify `registered: true`, the returned topic matches `pairedThreadId`, and the router lists this session online. Report errors honestly; do not change credentials or launch competing pollers.
4. Reply briefly: “Connected as LABEL. On your phone, open the Test bot group and select LABEL.” Explain only when necessary that it is a topic inside the group, not a new channel, and that the label does not change the working folder. If the owner cannot find it, offer a direct navigation button using the existing approved Telegram workflow.

Do not enable automatic logon here. Use `/telegram-enable` separately when explicitly requested. Never read/display a token or mirror local conversation content. Keep SSI/Max applications, project work and scheduler untouched.
