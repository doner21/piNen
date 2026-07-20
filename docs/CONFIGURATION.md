# Configuration Guide

piNen separates committed capability configuration from private runtime credentials.

## Files

| File | Committed? | Purpose |
|---|---:|---|
| `agent/settings.json` | yes | Pi defaults and package loading |
| `agent/models.json` | yes | available model definitions |
| `agent/model-router.json` | yes | named role routes |
| `agent/auth.example.json` | yes | provider credential template |
| `agent/auth.json` | **no** | real provider credentials |
| `agent/mcp.example.json` | yes | Engram/Tavily/Spotify MCP template |
| `agent/mcp.json` | **no** | real MCP configuration |
| `agent/gmail-config.example.json` | yes | Gmail multi-account template |
| `agent/gmail-config.json` | **no** | Gmail addresses/app passwords |
| `agent/spotify-mcp/spotify-config.example.json` | yes | Spotify app template |
| `agent/spotify-mcp/spotify-config.json` | **no** | Spotify app/OAuth config |
| `agent/telegram-pi/config.example.json` | yes | non-secret daemon settings |
| `agent/telegram-pi/config.json` | **no** | local Telegram daemon settings |

## Provider authentication

```bash
cp agent/auth.example.json agent/auth.json
```

Replace placeholders only in `auth.json`. Provider-specific auth formats may change with Pi releases; use Pi's current provider documentation if a provider uses OAuth rather than a raw API key.

## MCP servers

```bash
cp agent/mcp.example.json agent/mcp.json
```

The template includes:

- **Engram:** local persistent-memory MCP server, resolved from `ENGRAM_BIN` or the default piNen location;
- **Tavily:** internet research using `TAVILY_API_KEY`;
- **Spotify:** the local built MCP server.

Never put a credential in `mcp.example.json`.

## Engram

Default binary locations:

```text
Windows:   %USERPROFILE%\.pi\agent\bin\engram.exe
Unix:      $HOME/.pi/agent/bin/engram
```

Environment variable:

```powershell
$env:ENGRAM_BIN = "$HOME\.pi\agent\bin\engram.exe"
```

```bash
export ENGRAM_BIN="$HOME/.pi/agent/bin/engram"
```

See [ENGRAM_MEMORY.md](ENGRAM_MEMORY.md).

## Gmail

```bash
cp agent/gmail-config.example.json agent/gmail-config.json
```

The extension supports named accounts:

```json
{
  "defaultAccount": "personal",
  "accounts": {
    "personal": {
      "email": "you@example.com",
      "appPassword": "<GMAIL_APP_PASSWORD>"
    }
  }
}
```

Use a Gmail app password, not the primary account password.

## Spotify

```bash
cd agent/spotify-mcp
npm ci
npm run build
cp spotify-config.example.json spotify-config.json
```

Point the `spotify` entry in `agent/mcp.json` at `agent/spotify-mcp/build/index.js`, or set the path required by your MCP adapter. Complete Spotify OAuth locally. Tokens/config stay ignored.

The separate `agent/extensions/spotify-pi/` extension is also included, but the harness policy prefers the MCP server because it supports playlist management and is the single configured source of truth.

## Telegram

Set the bot token only in the environment:

```powershell
setx TELEGRAM_BOT_TOKEN "<token>"
```

```bash
export TELEGRAM_BOT_TOKEN="<token>"
```

Copy `agent/telegram-pi/config.example.json` only for non-secret daemon settings. Do **not** add a token field. Pair/authorize a chat from Pi using the Telegram skill/tool workflow.

## Models and routes

- `settings.json` controls default provider/model/thinking level and loads the deterministic orchestrator, MCP adapter, and Engram package.
- `models.json` provides custom model definitions.
- `model-router.json` maps planner/executor/verifier/orchestrator routes.

Recipients can change defaults without removing capabilities. A route is usable only when the corresponding provider is configured.

## Orchestration

The package path `../pi-orchestrator-extension` in `agent/settings.json` loads `/orchestrate` and the `orchestrate` tool. Per-run route overrides are available for planner/executor/verifier roles. See `../pi-orchestrator-extension/PARADIGMS.md`.

## Graphify Brain

The committed `graphify-brain/` is empty. Running Graphify creates project-specific graphs locally; they remain ignored.

## Environment variables

| Variable | Purpose |
|---|---|
| `ENGRAM_BIN` | Engram executable path |
| `TAVILY_API_KEY` | Tavily API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_ALLOWED_FROM` | optional Telegram sender allowlist |
| `TELEGRAM_CHAT_ID` | optional paired chat id |
| `TELEGRAM_PI_CWD` | Telegram daemon Pi working directory |
| `PI_HOME` | non-default Pi home |
| `PI_CLI_PATH` / `PI_CLI` | orchestrator Pi child CLI override |
| `PINEN_PERSIST_ENV` | opt-in Unix setup persistence |

## Dependency install

```bash
npm ci
(cd agent/npm && npm ci)
(cd agent/extensions && npm ci)
(cd agent/spotify-mcp && npm ci && npm run build)
```

Do not commit generated `node_modules/` or `build/` directories.
