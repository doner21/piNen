# piNen Agent Harness

`agent/` is the Pi home configuration shipped by piNen. It contains reusable capability source and safe templates only.

## Main directories

| Path | Purpose |
|---|---|
| `agents/` | 51 generic subagent profiles |
| `extensions/` | Active Pi extensions and extension tests |
| `skills/` | 48 active skills |
| `prompts/` | Stable slash-command prompt templates |
| `orchestration/` | `orch-*` specialist sidecar registry |
| `npm/` | `gentle-engram`, `pi-mcp-adapter`, and optional package dependencies |
| `core-patch/` | Optional, user-invoked `pi.executeCommand` bridge patcher |
| `spotify-mcp/` | Spotify MCP server source |
| `telegram-pi/` | Telegram daemon/support source and safe config template |
| `tools/` | Standalone diagnostics/helpers |
| `docs/` | Harness-specific operational docs |

## Configuration

1. Copy templates:

```bash
cp agent/auth.example.json agent/auth.json
cp agent/mcp.example.json agent/mcp.json
```

2. Optionally configure integrations:

```bash
cp agent/gmail-config.example.json agent/gmail-config.json
cp agent/spotify-mcp/spotify-config.example.json agent/spotify-mcp/spotify-config.json
cp agent/telegram-pi/config.example.json agent/telegram-pi/config.json
```

3. Bootstrap:

```powershell
# Windows
.\agent\setup.ps1
```

```bash
# Linux/macOS
./agent/setup.sh
```

All real config targets above are gitignored.

## Engram persistent memory

Engram is wired in three layers:

1. `settings.json` loads `gentle-engram`.
2. `npm/package.json` pins the Pi memory package and MCP adapter.
3. `mcp.example.json` starts the Engram binary lazily and without embedding a machine path.

The installer downloads the Engram executable separately; no executable or memory database is committed. See `../docs/ENGRAM_MEMORY.md`.

## Deterministic orchestration

`settings.json` loads `../pi-orchestrator-extension`, which provides `/orchestrate` and the `orchestrate` tool. The stable `planner`, `coder`, and `reviewer` agents form the default spine; specialist `orch-*` roles are optional sidecars.

NenFlow v3 and the `pev-*` loop are retired and are not shipped. Route orchestration requests through `/orchestrate`; see `docs/nenflow-v3-retirement.md`.

## Key tools and commands

```text
/orchestrate ...                  deterministic multi-agent workflow
/subagents list                   list subagent profiles
/subagents spawn <agent> <task>   isolated delegated task
/graphify [path]                  build a knowledge graph
/memory list                      list Graphify project memories
/think <level>                    reasoning level
/verbosity <level>                response detail
/todos                            persistent task list
```

LLM-callable continuity tools:

- `agent_scheduler`
- `agent_new_session`
- `agent_reload_runtime`
- `context_usage`
- `model_router`
- `git_backup`
- `graphify_auto`
- `subagent`
- `orchestrate`

## Extensions

The extension layer includes:

- agent scheduler, reload, new-session, and canonical diagnostics;
- autonomous Graphify and Graphify Brain;
- deterministic subagents and model routing;
- browser search, Playwright, MCP status, Railway, and GoDaddy;
- Gmail, Spotify, and Telegram;
- isolated-ref Git backup, Git checkpoint, and destructive-command confirmation;
- context, thinking, verbosity, todos, and piNen UI.

`extensions/package.json` contains all non-core runtime dependencies. Run `npm ci` there after cloning.

## Safety boundary

Do not commit:

- `auth.json`, `mcp.json`, `gmail-config.json`, `spotify-config.json`, Telegram token/config state;
- sessions, scheduler data, run artifacts, handoffs, diagnostics, or daemon state;
- `agent/bin/`, databases, dependencies, builds, or nested `.git/` directories;
- Graphify project graphs or Engram memory content.

The root `.gitignore` enforces these boundaries. Use gitleaks before publishing.
