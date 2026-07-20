# Engram Persistent Memory

piNen includes the complete **Engram capability layer** while deliberately excluding all user memory content.

## Components

| Component | Location | Role |
|---|---|---|
| Pi package | `agent/npm/package.json` | Installs `gentle-engram`, which exposes Pi-native `mem_*` tools |
| Pi settings | `agent/settings.json` | Loads `npm:gentle-engram@0.1.8` |
| MCP template | `agent/mcp.example.json` | Starts `engram mcp --tools=agent` lazily |
| Installer | `install.ps1`, `agent/setup.ps1`, `agent/setup.sh` | Installs/finds the binary and configures `ENGRAM_BIN` |
| Agent policy | `agent/AGENTS.md` | Defines when memories and session summaries are saved/recalled |

The Engram executable is downloaded from its upstream release and verified by the Windows installer. It is not committed to this repository.

## Memory tools

### Search and retrieval

- `mem_context` — recent project memories and sessions
- `mem_search` — semantic/keyword search with optional project/type/scope filters
- `mem_get_observation` — retrieve one observation by id
- `mem_timeline` — surrounding observations
- `mem_stats` — memory statistics

### Save and maintain

- `mem_save` — save a decision, bugfix, architecture fact, discovery, pattern, config, or preference
- `mem_update` — update an observation
- `mem_delete` — soft/hard delete an observation
- `mem_suggest_topic_key` — propose a stable upsert key
- `mem_save_prompt` — preserve a user prompt

### Session lifecycle

- `mem_session_start`
- `mem_session_summary`
- `mem_session_end`
- `mem_current_project`

### Capture, review, and relations

- `mem_capture_passive` — capture a `## Key Learnings` section
- `mem_review` — list or mark observations reviewed
- `mem_judge` — adjudicate a candidate relation
- `mem_compare` — explicitly relate two observations
- `mem_doctor` — diagnose Engram availability/configuration

## Setup

### Windows installer

The one-click installer places the binary at:

```text
%USERPROFILE%\.pi\agent\bin\engram.exe
```

For a manual clone:

```powershell
.\agent\setup.ps1
$env:ENGRAM_BIN = "$HOME\.pi\agent\bin\engram.exe"
```

Persist only when wanted:

```powershell
.\agent\setup.ps1 -PersistEnv
```

### Linux/macOS

Place the appropriate upstream binary at:

```text
$HOME/.pi/agent/bin/engram
```

Then:

```bash
chmod +x "$HOME/.pi/agent/bin/engram"
export ENGRAM_BIN="$HOME/.pi/agent/bin/engram"
./agent/setup.sh
```

To persist the environment variable:

```bash
./agent/setup.sh --persist-env
```

## Verify

Start Pi and call:

```text
mem_doctor
mem_current_project
mem_context
```

If unavailable:

1. Confirm `ENGRAM_BIN` points to an existing executable.
2. Run `agent/setup.ps1` or `agent/setup.sh`.
3. Confirm `agent/mcp.json` was copied from `agent/mcp.example.json`.
4. Confirm `agent/npm/node_modules/gentle-engram` exists after `npm ci`.
5. Restart Pi after changing environment variables or packages.

## Recommended memory protocol

- Search `mem_context` before re-deriving project context.
- Save bug fixes, architecture decisions, non-obvious discoveries, config changes, reusable patterns, and user preferences promptly.
- Use stable `topic_key` values for evolving decisions.
- Save a session summary before declaring meaningful work complete.
- After context compaction, restore memory context before continuing.

A useful observation shape is:

```text
What: one sentence describing the durable fact
Why: motivation
Where: affected paths/components
Learned: edge cases and gotchas
```

## Privacy boundary

The following are never part of piNen:

- Engram databases or observation stores;
- saved prompts, session summaries, or personal preferences;
- health traces containing local runtime context;
- project-specific Graphify memories;
- the Engram executable itself.

Each installation creates its own memory store after configuration. The repository ships the capability, not the data.
