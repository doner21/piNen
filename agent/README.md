# Pi Agent Configuration

This repo contains a complete Pi coding-agent configuration — agents, skills, extensions, subagents, prompts, NenFlow v3 setup, and the Global Graphify Brain memory system — ready to deploy on any machine (Windows, macOS, Linux).

## What's New in This Configuration

This configuration extends Pi with several powerful systems:

### 🧠 Global Graphify Brain (Memory System)
A persistent knowledge-graph memory system that saves and reloads project knowledge across sessions. Uses graphify to build structured knowledge graphs, then injects relevant graph context automatically on every agent turn.

- **`/graphify [folder]`** — Build a knowledge graph of any folder
- **`/memory save`** — Save the graph to the global brain
- **`/memory list`** — List all saved project graphs
- **`/memory load <project>`** — Load a graph into context
- **`/memory runs <project>`** — Browse historical graph runs
- **`/memory prune <project>`** — Analyse runs for pruning candidates
- **`/memory pin/unpin <project> --run <id>`** — Protect runs from pruning
- **`/memory gc <project>`** — Garbage-collect low-value runs
- **`/memory keep <project> --run <id>`** — Keep a specific run
- **`/memory stats [project]`** — Memory storage statistics
- **`/memory-wiki sync`** — Sync graph artifacts to an Obsidian vault
- **`/memory-wiki open`** — Open the vault in Obsidian

The brain context is automatically injected on every agent turn so the model always knows what knowledge graphs are available.

### 🔄 Subagent System
Custom subagent system with isolated context windows. Each subagent runs as a separate Pi process with its own model, tools, and system prompt.

- **`/subagents list`** — List available subagents
- **`/subagents spawn <agent> <task>`** — Run a subagent with a task
- **`/subagents spawn --allow-local <agent> <task>`** — Allow local models
- **`/subagents create`** — Interactive subagent creation wizard
- **`subagent` tool** — LLM-callable subagent tool

Subagents support agency levels:
- **read-only** — inspect files only
- **research** — read + bash, no writes
- **write-enabled** — full read/write access

Available subagents: `researcher`, `planner`, `coder`, `reviewer`, `pev-researcher`, `pev-planner`, `pev-executor`, `pev-verifier`, `browser-agent`, `api-test-reader`

### 📋 NenFlow v3 Workflow Engine
A structured Plan-Execute-Verify workflow engine with isolated phases, subagent delegation, and automatic validation.

- **`/nenflow_v3 <task>`** — Start a NenFlow v3 run
- **`/pev <task>`** — Alias for `/nenflow_v3`

The orchestrator performs intake itself in the visible session, then delegates research, planning, execution, and verification to subagents. Each run creates structured artifacts (intake, research, plan, execution, verifier brief, verification) stored under `nenflow-v3/runs/RUN_YYYYMMDD-HHMMSS/`.

### 🌐 Browser Automation (Playwright MCP)
Full browser automation via Playwright MCP server, auto-connecting on session start.

- **`/mcp list`** — List MCP server status and tools
- **`/mcp tools [server]`** — List available browser tools

Provides: `browser_navigate`, `browser_click`, `browser_snapshot`, `browser_take_screenshot`, `browser_type`, `browser_fill_form`, `browser_evaluate`, and more.

### 🧠 Thinking Level Control
Granular control over model reasoning depth.

- **`/think [off|minimal|low|medium|high|xhigh]`** — Set reasoning budget
- **`/think`** — Interactive picker

Levels: off (0), minimal (~1k), low (~4k), medium (~10k), high (~32k), xhigh (maximum)

### ✂️ Verbosity Control
Control how concise or detailed model responses are.

- **`/verbosity [brief|concise|normal|detailed|verbose]`** — Set verbosity
- **`/verbosity`** — Interactive picker

### 📝 Persistent Todos
A JSON-backed task list with full CRUD operations.

- **`/todos`** — List tasks
- **`/todos add <task>`** — Add a task
- **`/todos done <n>`** — Mark task complete
- **`/todos remove <n>`** — Delete a task
- **`/todos clear`** — Clear all tasks

### 🛡️ Destructive Command Confirmation
Intercepts dangerous commands (rm -rf, dd, mkfs, etc.) and prompts for confirmation before execution.

### 💾 Git Checkpoint
Automatically creates a git commit before any LLM-issued `write` or `edit` tool call, providing automatic rollback points.

### 🌐 Web Search Integration
Browser-backed web search is included by default via `browser_web_search` (DuckDuckGo Lite/direct HTTP with Playwright fallback). It does not require Ollama, Llama, or a local model. The older Ollama-backed `web_search` / `web_fetch` tools remain optional for users who install `npm:@ollama/pi-web-search` themselves.

## Prerequisites

- **Node.js** 18+ installed
- **Pi** coding agent installed globally:
  ```bash
  npm install -g @mariozechner/pi-coding-agent
  ```
- **Git** installed
- (Optional) **ripgrep** (`rg`) and **fd** if you want the bundled search tools

## Installation on a New Machine

### 1. Clone into the Pi agent directory

Pi stores its configuration in `~/.pi/agent/` (or `%USERPROFILE%\.pi\agent\` on Windows).

```bash
# Back up any existing config first (optional)
mv ~/.pi/agent ~/.pi/agent.backup.$(date +%Y%m%d) 2>/dev/null

# Create the directory and clone
mkdir -p ~/.pi/agent
git clone https://github.com/doner21/pi-config.git ~/.pi/agent
```

On **Windows PowerShell**:
```powershell
# Backup
Rename-Item "$env:USERPROFILE\.pi\agent" ".pi\agent.backup.$(Get-Date -Format yyyyMMdd)" -ErrorAction SilentlyContinue

# Clone
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.pi\agent"
git clone https://github.com/doner21/pi-config.git "$env:USERPROFILE\.pi\agent"
```

### 2. Install extension dependencies

The extensions use TypeScript and have npm dependencies that are gitignored. Restore them:

```bash
cd ~/.pi/agent/extensions
npm install
```

### 3. Configure your API keys

The `auth.json` file is **not** in this repo (it contains secrets). Create it manually:

```bash
# Create auth.json with your API keys
cat > ~/.pi/agent/auth.json << 'EOF'
{
  "providers": {
    "deepseek": {
      "apiKey": "sk-your-deepseek-api-key"
    }
  }
}
EOF
```

> **Note:** Copy your real API keys from your original machine's `~/.pi/agent/auth.json`. Never commit this file.

### 4. Web search tools

No extra install is required for the default web search path. This config includes `browser-picture-search.ts`, which registers:

- `browser_web_search` — DuckDuckGo Lite/direct HTTP search with Playwright fallback
- `browser_image_search` — browser-assisted Google Images workflow
- `browser_reverse_image_search` — browser-assisted reverse-image workflow

These tools do **not** use Ollama/Llama. If a DeepSeek-backed agent such as `browser-agent` performs the search, DeepSeek is the reasoning model interpreting results; the search backend remains DuckDuckGo/Playwright.

Optional legacy install:

```bash
cd ~/.pi/agent
pi install npm:@ollama/pi-web-search
```

Install that only if you specifically want `web_search` / `web_fetch`, which require Ollama running locally with web search/fetch enabled.

### 5. Verify the installation

```bash
# Start Pi
pi

# Pi should load all agents, skills, extensions, and NenFlow v3
# Check that your models appear and skills are listed

# Test basic commands:
/think medium
/subagents list
```

### 6. (Optional) Install binary tools

Pi uses `rg` (ripgrep) and `fd` for search. These live in `~/.pi/agent/bin/`:

```bash
# ripgrep
# Download from: https://github.com/BurntSushi/ripgrep/releases
# Extract rg.exe to ~/.pi/agent/bin/

# fd
# Download from: https://github.com/sharkdp/fd/releases  
# Extract fd.exe to ~/.pi/agent/bin/
```

Or install via package manager:
```bash
# macOS
brew install ripgrep fd

# Linux
sudo apt install ripgrep fd-find
```

## What's Included

### Slash Commands

| Command | Description |
|---------|-------------|
| `/graphify [folder]` | Build a knowledge graph |
| `/memory <subcommand>` | Global Graphify Brain memory management |
| `/memory-wiki <subcommand>` | Obsidian vault management |
| `/subagents <list\|spawn\|create>` | Subagent management |
| `/nenflow_v3 <task>` | NenFlow v3 workflow |
| `/pev <task>` | Alias for `/nenflow_v3` |
| `/think [level]` | Set reasoning depth |
| `/verbosity [level]` | Set response verbosity |
| `/todos <subcommand>` | Persistent task management |
| `/mcp <list\|tools>` | MCP server inspection |
| `/agents` | Retired - use `/subagents` |
| `/skill:graphify [folder]` | Trigger graphify skill |

### Agents (Subagent Definitions)

| Agent | Agency | Purpose |
|-------|--------|---------|
| `pev-executor` | write-enabled | NenFlow v3 execution |
| `pev-planner` | research | NenFlow v3 planning |
| `pev-researcher` | research | NenFlow v3 research |
| `pev-verifier` | read-only | NenFlow v3 verification |
| `researcher` | research | Web/codebase investigation |
| `planner` | research | Implementation planning |
| `coder` | write-enabled | Implementation |
| `reviewer` | read-only | Code review |
| `browser-agent` | read-only | Browser automation |
| `api-test-reader` | read-only | API testing |

### Skills

| Skill | Description |
|-------|-------------|
| `graphify` | Knowledge graph builder for any content |
| `nenflow-v3` | NenFlow v3 orchestration loop |
| `nenflow-pev-executor` | PEV Executor role |
| `nenflow-pev-planner` | PEV Planner role |
| `nenflow-pev-researcher` | PEV Researcher role |
| `nenflow-pev-verifier` | PEV Verifier role |
| `internet-research` | Web search via DuckDuckGo |

### Extensions

| Extension | Purpose |
|-----------|---------|
| `subagent.ts` | Subagent delegation with isolated context windows |
| `graphify.ts` | Global Graphify Brain memory system |
| `playwright-mcp.ts` | Browser automation via Playwright MCP |
| `nenflow-v3.ts` | NenFlow v3 workflow (stub - uses skills/prompts) |
| `git-checkpoint.ts` | Auto git commits before destructive operations |
| `thinking.ts` | Extended thinking/reasoning level control |
| `todos.ts` | Persistent JSON-backed task tracking |
| `verbosity.ts` | Response verbosity control |
| `mcp-status.ts` | MCP server connection monitoring |
| `confirm-destructive.ts` | Dangerous command confirmation |
| `agents.ts` | Deprecated - redirects to `/subagents` |

### NenFlow v3

Complete NenFlow v3 configuration including:
- `templates/CONTINUATION.md` — Continuation template
- `validator.js` — Run validation logic
- `runs/` — Historical run records (intake, plans, executions, verifications)

### Configuration Files

| File | Purpose |
|------|---------|
| `settings.json` | Pi settings (model, provider, packages) |
| `models.json` | Model definitions (cloud routes plus optional Ollama/local models) |
| `mcp-registry.json` | MCP server registry |
| `AGENTS.md` | Global agent policy (Capati memory + Graphify) |

### Prompts

| Prompt | Purpose |
|--------|---------|
| `nenflow_v3.md` | NenFlow v3 visible orchestration prompt template |
| `pev.md` | Alias for nenflow_v3 prompt template |

### Subagent Documentation

| File | Purpose |
|------|---------|
| `subagents/README.md` | Overview and design rationale |
| `subagents/RESEARCH.md` | External and Pi-specific subagent research |
| `subagents/PLAN.md` | Implementation plan (6 phases) |
| `subagents/TASKLIST.md` | Execution checklist |

## Architecture Overview

```
~/.pi/agent/
├── AGENTS.md              # Global agent policy
├── README.md              # This file
├── settings.json          # Pi settings
├── models.json            # Model definitions
├── mcp-registry.json      # MCP server state
├── .gitignore             # Git ignore rules
│
├── agents/                # Subagent definitions (JSON)
│   ├── pev-executor.json
│   ├── pev-planner.json
│   ├── pev-researcher.json
│   ├── pev-verifier.json
│   ├── researcher.json
│   ├── planner.json
│   ├── coder.json
│   ├── reviewer.json
│   ├── browser-agent.json
│   └── api-test-reader.json
│
├── extensions/            # TypeScript extensions
│   ├── subagent.ts        # Subagent delegation
│   ├── graphify.ts        # Global Graphify Brain
│   ├── playwright-mcp.ts  # Browser automation
│   ├── nenflow-v3.ts      # NenFlow stub
│   ├── git-checkpoint.ts  # Auto git commits
│   ├── thinking.ts        # Reasoning control
│   ├── todos.ts           # Task list
│   ├── verbosity.ts       # Verbosity control
│   ├── mcp-status.ts      # MCP monitoring
│   ├── confirm-destructive.ts # Danger prevention
│   ├── agents.ts          # Deprecated redirect
│   └── package.json       # Extension deps
│
├── skills/                # Skill definitions
│   ├── graphify/
│   ├── internet-research/
│   ├── nenflow-v3/
│   ├── nenflow-pev-executor/
│   ├── nenflow-pev-planner/
│   ├── nenflow-pev-researcher/
│   └── nenflow-pev-verifier/
│
├── prompts/               # Prompt templates
│   ├── nenflow_v3.md
│   └── pev.md
│
├── subagents/             # Subagent research/plan docs
│   ├── README.md
│   ├── RESEARCH.md
│   ├── PLAN.md
│   └── TASKLIST.md
│
├── nenflow-v3/            # NenFlow runtime
│   ├── templates/CONTINUATION.md
│   ├── validator.js
│   └── runs/              # Historical run records
│
├── backups/               # [gitignored] Auto-backups
└── sessions/              # [gitignored] Session history
```

## Using the Subagent System

### Creating your own subagent

```bash
/subagents create
```

This launches an interactive wizard that will:
1. Ask for a template (Research, Planner, Reviewer, Coder, or Blank)
2. Ask for an agency level (read-only, research, write-enabled)
3. Ask for a name, description, and system prompt
4. Optionally set provider/model and skills
5. Save the agent definition to `~/.pi/agent/agents/`

### Using subagents from the LLM

The `subagent` tool is registered for the LLM to call:

```
Use subagent researcher to investigate the authentication flow
```

The LLM will call the tool with `agent="researcher"` and a task description.

## Using the Global Graphify Brain

### First-time setup

```bash
# 1. Build a graph of your project
/graphify .

# 2. Save it to the global brain
/memory save

# 3. Load it (it injects automatically on future sessions)
/memory load <project-name>
```

### Managing graphs

```bash
/memory list                  # See all saved graphs
/memory runs <project>        # See all runs for a project
/memory prune <project>       # See pruning recommendations
/memory pin <project> --run <id>  # Protect a run
/memory keep <project> --run <id> # Keep a run from gc
/memory gc <project>          # Garbage-collect
/memory stats                 # See memory stats
```

## Using NenFlow v3

```bash
# Start a NenFlow v3 run
/nenflow_v3 Implement user authentication

# Or use the alias
/pev Fix the database connection bug
```

The orchestrator will:
1. Perform intake analysis in the visible session
2. Delegate research to `pev-researcher` (if needed)
3. Delegate planning to `pev-planner`
4. Delegate execution to `pev-executor`
5. Delegate verification to `pev-verifier`
6. Report PASS/FAIL at the end

## Browser Automation

The Playwright MCP server starts automatically when Pi launches.

```bash
# Check MCP status
/mcp list

# List all available browser tools
/mcp tools

# List tools from a specific server
/mcp tools playwright-mcp
```

Browser tools are available as regular Pi tools: `browser_navigate`, `browser_click`, `browser_snapshot`, etc.

## Keeping Config in Sync

After making changes on any machine, commit and push:

```bash
cd ~/.pi
git add -A
git commit -m "Update Pi config: <description>"
git push
```

On other machines, pull to sync:

```bash
cd ~/.pi
git pull
bash ~/.pi/agent/setup.sh  # re-runs npm install if package.json changed
```

## Cross-Platform Notes

### Windows
- Paths use `%USERPROFILE%\.pi\agent\`
- Binary tools (`engram.exe`, `rg.exe`, `fd.exe`) are bundled in `%USERPROFILE%\.pi\agent\bin\`
- ENGRAM_BIN is set automatically by `agent/setup.ps1`
- Git installed via [Git for Windows](https://git-scm.com/)
- Playwright MCP auto-detects Windows paths

### macOS
- Paths use `~/.pi/agent/`
- Install ripgrep and fd via Homebrew: `brew install ripgrep fd`
- Playwright works natively

### Linux
- Paths use `~/.pi/agent/`
- Install ripgrep and fd via apt: `sudo apt install ripgrep fd-find`
- Playwright works natively

## Security Notes

- **Never commit `auth.json`** — it contains API keys and is gitignored
- **Session history** is also gitignored (stored in `sessions/`)
- The repo is **private** — keep it that way if it contains personal config
- Rotate API keys periodically and update `auth.json` on all machines
- Subagents block local models by default — use `--allow-local` explicitly
- Read-only subagents prevent accidental file modification
