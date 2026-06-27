# piNen Agent Configuration

piNen is a sanitized Pi coding-agent harness. This `agent/` directory contains the
configuration, extensions, skills, and orchestration tools that make up the harness.

## Quick Start

After running the installer (`install.ps1` or `install.sh`), Pi will be installed at:

- Windows: `%USERPROFILE%\.pi`
- Linux/macOS: `$HOME/.pi`

## Configuration Files

| File | Purpose |
|------|---------|
| `auth.example.json` | Template for AI provider API keys (never commit real keys) |
| `mcp.example.json` | Template for MCP server configuration (env vars only) |
| `gmail-config.example.json` | Template for Gmail integration |
| `models.json` | Model definitions with env-var placeholders |
| `model-router.json` | Model routing configuration |
| `AGENTS.md` | Global agent policy — orchestrator rules, Engram setup, Graphify Brain |
| `settings.json` | Agent defaults (model, provider, thinking level, theme) |

### Setting Up API Keys

Copy the example files and add your own keys:

```bash
# Windows (PowerShell)
Copy-Item agent\auth.example.json agent\auth.json
Copy-Item agent\mcp.example.json agent\mcp.json
# Edit agent/auth.json and agent/mcp.json with your API keys
```

```bash
# Linux/macOS
cp agent/auth.example.json agent/auth.json
cp agent/mcp.example.json agent/mcp.json
# Edit agent/auth.json and agent/mcp.json with your API keys
```

## Extensions

Extensions are TypeScript modules in `agent/extensions/` that add capabilities to Pi:

| Extension | Purpose |
|-----------|---------|
| `pinen-logo.ts` | piNen wordmark displayed above the editor |
| `agent-scheduler/` | Autonomous agent wake-up scheduling |
| `agent-new-session/` | Agent-operated clean-session workflow |
| `agent-reload/` | Agent-operated reload workflow |
| `autonomous-graphify/` | Autonomous Graphify Brain maintenance |
| `nenflow-v3.ts` | NenFlow v3 orchestration engine |
| `subagent.ts` | Subagent spawning and management |
| `telegram-pi/` | Telegram ↔ Pi bridge |
| ... | (see `extensions/` for full list) |

## Orchestration

piNen includes the NenFlow v3 orchestration engine and a reusable orchestration
extension (`pi-orchestrator-extension/`) with several shapes (paradigms):

- `plan-execute-verify` — classic 3-phase flow
- `safe-github-publish` — **default GitHub publishing method** (sanitized staging, private-first, gitleaks)
- `multi-verify-vote` — majority-rule verification
- `composable-pipeline` — dynamic pipeline composition
- `verify-only` — verification-only with independent evidence

## Graphify Brain

The Graphify Brain at `graphify-brain/` stores project knowledge graphs. It starts
empty — build graphs by running `/graphify` in your project directories.

## Engram

Engram provides persistent memory that survives across sessions. The binary is
installed by the one-click installer. Configure it by setting `ENGRAM_BIN`:

```powershell
# Windows
$env:ENGRAM_BIN = "$env:USERPROFILE\.pi\agent\bin\engram.exe"
```

```bash
# Linux/macOS
export ENGRAM_BIN="$HOME/.pi/agent/bin/engram"
```

## Spotify MCP

Spotify integration uses the MCP server at `agent/spotify-mcp/`. See
`agent/spotify-mcp/README.md` for setup instructions.

## Telegram Bridge

The Telegram bridge at `agent/telegram-pi/` connects Pi to Telegram. See
`agent/telegram-pi/README.md` for setup and configuration.

## Safety Notes

- Never commit `auth.json`, `mcp.json`, or `gmail-config.json` — they contain secrets.
- The `.gitignore` file in this directory blocks runtime state, sessions, and diagnostics.
- Run directories (`nenflow-v3/runs/`, `orchestration/runs/`) hold run-time artifacts only.
- `graphify-brain/` holds personal project memory and is gitignored by default.
