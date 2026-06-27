# Configuration Guide

piNen is configured through JSON files in the `agent/` directory, environment
variables, and optionally through Pi settings.

## Configuration Files

| File | Purpose |
|------|---------|
| `agent/auth.json` | AI provider API keys |
| `agent/mcp.json` | MCP server configuration (Engram, Tavily, Spotify, etc.) |
| `agent/gmail-config.json` | Gmail integration (optional) |
| `agent/settings.json` | Agent defaults (model, provider, theme) |
| `agent/models.json` | Model definitions with env-var placeholders |
| `agent/model-router.json` | Model routing rules |

## AI Provider API Keys

Copy `agent/auth.example.json` to `agent/auth.json` and add your API keys:

```json
{
  "providers": {
    "openai-codex": {
      "apiKey": "sk-your-openai-key",
      "baseURL": "https://api.openai.com/v1"
    },
    "deepseek": {
      "apiKey": "sk-your-deepseek-key",
      "baseURL": "https://api.deepseek.com/v1"
    },
    "anthropic": {
      "apiKey": "sk-ant-your-anthropic-key",
      "baseURL": "https://api.anthropic.com"
    }
  }
}
```

**Safety:** `auth.json` is gitignored. Never commit it.

## MCP Servers

Copy `agent/mcp.example.json` to `agent/mcp.json` and configure MCP servers:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["-e", "..."],
      "lifecycle": "lazy"
    },
    "tavily": {
      "command": "npx",
      "args": ["tavily-mcp"],
      "env": {
        "TAVILY_API_KEY": "tvly-your-tavily-key"
      },
      "lifecycle": "lazy"
    },
    "spotify": {
      "command": "node",
      "args": ["path-to-spotify-mcp-build/index.js"],
      "lifecycle": "lazy"
    }
  }
}
```

**Available MCP servers:**

| Server | Purpose | Requires |
|--------|---------|----------|
| `engram` | Persistent memory (auto-configured) | Engram binary |
| `tavily` | Internet research | Tavily API key |
| `spotify` | Spotify playback and playlists | Spotify MCP build + OAuth |

## Spotify Configuration

1. Build the Spotify MCP server:
   ```bash
   cd agent/spotify-mcp && npm ci && npm run build
   ```

2. Configure `agent/mcp.json` to point to the build:
   ```json
   "spotify": {
     "command": "node",
     "args": ["<pi-home>/agent/spotify-mcp/build/index.js"]
   }
   ```

   Or set the `SPOTIFY_BUILD_PATH` environment variable.

3. Run `spotify_playMusic` once to trigger OAuth authentication.

See `agent/spotify-mcp/README.md` for detailed setup.

## Telegram Bridge

1. Create `agent/telegram-pi/config.json` from the example:
   ```bash
   cp agent/telegram-pi/config.example.json agent/telegram-pi/config.json
   ```

2. Add your Telegram bot token and authorized chat IDs.

3. Install the daemon:
   ```powershell
   # Windows
   powershell -File agent/telegram-pi/install-windows-task.ps1
   ```

See `agent/telegram-pi/README.md` for detailed setup.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ENGRAM_BIN` | Path to Engram binary |
| `TAVILY_API_KEY` | Tavily API key (can be in mcp.json instead) |
| `PINEN_PERSIST_ENV` | Set to `1` to allow setup.sh to persist environment variables |
| `SPOTIFY_BUILD_PATH` | Path to Spotify MCP build directory |

## Model Configuration

`agent/models.json` defines available models. Defaults use environment variables
for provider selection. Customize by editing this file.

`agent/model-router.json` defines routing rules for automatically selecting models
based on task type.

## Orchestration Configuration

Orchestration shapes are configured in `pi-orchestrator-extension/`. The default
shape for general orchestration is `plan-execute-verify`. For GitHub publishing,
use `safe-github-publish` (the recommended default).

See `pi-orchestrator-extension/PARADIGMS.md` for all available shapes and their options.

## Theme

Set the theme in `agent/settings.json`:
```json
{
  "theme": "dark"
}
```

Available themes: `dark`, `light`, and any theme from the `theme-factory` skill.

## Graphify Brain

The Graphify Brain starts empty. Build project knowledge graphs by running:

```
/graphify
```

Graphs are stored in `graphify-brain/` (gitignored by default).
