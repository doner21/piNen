# piNen — Full, Sanitized Pi Coding-Agent Harness

piNen packages the current Pi harness as a reusable installation: deterministic multi-agent orchestration, persistent Engram memory, Graphify project knowledge, autonomous scheduling/session continuity, browser and MCP tooling, integrations, safety automation, specialist agents, and 48 skills.

This repository contains the **harness and its capabilities**, not the publisher's projects or private runtime data.

> **warm terminal intelligence**

## What is included

- **Deterministic orchestration:** 15 bounded orchestration shapes, parallel planner/executor/verifier roles, route overrides, resumable runs, read-only discovery planning on PEV/dual-plan, predicted-write-set enforcement on PEV/frozen-gate, evidence gates, shape generation, and independent verification.
- **Engram persistent memory:** the full `mem_*` tool workflow, session summaries, passive capture, review/judgment tools, setup scripts, MCP wiring, and documentation. Memory databases and saved observations are deliberately excluded.
- **Graphify Brain:** code, skills, autonomous maintenance, global-graph maintenance, and an empty memory store ready for each installation.
- **Continuity:** delayed wake-ups, agent-operated reload/new-session bridges, context monitoring, handoff workflows, and the optional Pi core patch.
- **Tooling and integrations:** Playwright/browser search, Tavily/MCP gateway, Gmail, Telegram, Spotify MCP, Railway, GoDaddy domains, Supabase guidance, documents/spreadsheets/slides/PDFs, image/media workflows, and more.
- **Safety:** destructive-command confirmation, isolated Git backup refs, gitleaks configuration, secret-safe templates, no committed auth, and no project/session/runtime data.

See [CAPABILITIES.md](CAPABILITIES.md) for the complete inventory.

## Quick install — Windows

Open PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/doner21/piNen/main/install.ps1'; $f=Join-Path $env:TEMP 'pinen-install.ps1'; Invoke-WebRequest -UseBasicParsing $u -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f"
```

Or clone manually:

```powershell
git clone https://github.com/doner21/piNen.git "$HOME\.pi"
Set-Location "$HOME\.pi"
.\agent\setup.ps1
```

Optional flags:

```powershell
.\agent\setup.ps1 -PersistEnv       # persist ENGRAM_BIN
.\agent\setup.ps1 -ApplyCorePatch  # enable agent-operated reload/new-session bridge
.\agent\setup.ps1 -DryRun
```

## Quick install — Linux/macOS

```bash
git clone https://github.com/doner21/piNen.git "$HOME/.pi"
cd "$HOME/.pi"
./agent/setup.sh
```

Optional:

```bash
./agent/setup.sh --persist-env
./agent/setup.sh --apply-core-patch
./agent/setup.sh --dry-run
```

## Configure private credentials

Templates are committed; real credentials are not.

```bash
cp agent/auth.example.json agent/auth.json
cp agent/mcp.example.json agent/mcp.json
# Optional integrations:
cp agent/gmail-config.example.json agent/gmail-config.json
cp agent/spotify-mcp/spotify-config.example.json agent/spotify-mcp/spotify-config.json
cp agent/telegram-pi/config.example.json agent/telegram-pi/config.json
```

Edit only the copied private files. They are gitignored. Never commit them.

## Start and verify

```bash
pi
```

Useful checks inside Pi:

```text
/orchestrate --paradigm verify-only "Confirm the harness loaded"
/subagents list
/memory list
mem_context
mem_doctor
```

## Engram memory

Engram gives Pi durable memories that survive sessions and context compaction. piNen installs/wires the Engram executable and the `gentle-engram` Pi package, exposing tools such as:

- `mem_context`, `mem_search`, `mem_save`, `mem_update`, `mem_delete`
- `mem_session_start`, `mem_session_summary`, `mem_session_end`
- `mem_get_observation`, `mem_timeline`, `mem_stats`, `mem_doctor`
- `mem_capture_passive`, `mem_review`, `mem_judge`, `mem_compare`

The repository includes **the capability, not anyone's memory content**. See [docs/ENGRAM_MEMORY.md](docs/ENGRAM_MEMORY.md).

## Repository layout

```text
piNen/
├── agent/
│   ├── agents/                 # 51 generic subagent profiles
│   ├── extensions/             # 39 active extension/test source files
│   ├── skills/                 # 48 active skills
│   ├── prompts/                # stable command templates
│   ├── orchestration/          # specialist sidecar registry
│   ├── core-patch/             # optional command-dispatch patch tooling
│   ├── spotify-mcp/            # full Spotify MCP source
│   ├── telegram-pi/            # Telegram daemon/support source
│   ├── npm/                    # gentle-engram + MCP adapter dependencies
│   └── setup.ps1 / setup.sh
├── pi-orchestrator-extension/  # 15 shapes + 28 test/support scripts
├── graphify-brain/             # intentionally empty user memory store
├── docs/
├── examples/
└── install.ps1 / install.sh
```

## Sanitization boundary

Included:
- capability source, tests, prompts, policies, setup scripts, safe templates, and documentation;
- empty placeholders for memory/run directories.

Excluded:
- projects and project-specific agents/shapes;
- Engram observations/databases and Graphify project graphs;
- sessions, run artifacts, handoffs, diagnostics, scheduler/daemon state, caches, and dependencies;
- API keys, OAuth tokens, app passwords, auth configs, runtime executables/native binaries, and nested Git history. (Licensed font assets required by visual-design skills remain.)

The public tree is scanned with gitleaks before release. See [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

- [Complete capability inventory](CAPABILITIES.md)
- [Engram memory](docs/ENGRAM_MEMORY.md)
- [Isolated Git backup](docs/GIT_BACKUP.md)
- [Configuration](docs/CONFIGURATION.md)
- [Harness architecture](docs/HARNESS_ARCHITECTURE.md)
- [Windows installation](docs/INSTALL_WINDOWS.md)
- [Security model](docs/SECURITY.md)
- [Orchestration paradigms](pi-orchestrator-extension/PARADIGMS.md)
- [Agent harness guide](agent/README.md)
