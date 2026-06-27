# piNen — Sanitized Pi Coding-Agent Harness

piNen is a production-ready, sanitized Pi coding-agent harness with NenFlow v3
orchestration, Engram persistent memory, and a rich ecosystem of extensions,
skills, and MCP integrations.

> **"warm terminal intelligence"**

## Quick Install (Windows)

Open PowerShell and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/doner21/piNen/main/install.ps1'; $f=Join-Path $env:TEMP 'pinen-install.ps1'; Invoke-WebRequest -UseBasicParsing $u -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f"
```

**What this does:**
- Installs Pi harness to `$HOME\.pi`
- Downloads and verifies Engram memory binary
- Installs npm dependencies
- Creates template configs (you add your own API keys)
- Never collects tokens, secrets, or telemetry
- Non-admin by default

Or clone and bootstrap manually:

```bash
git clone https://github.com/doner21/piNen.git $HOME/.pi
cd $HOME/.pi
powershell -NoProfile -ExecutionPolicy Bypass -File ./agent/setup.ps1
```

## Quick Install (Linux/macOS)

```bash
git clone https://github.com/doner21/piNen.git $HOME/.pi
cd $HOME/.pi
./agent/setup.sh
```

To persist ENGRAM_BIN across sessions, opt in explicitly:

```bash
./agent/setup.sh --persist-env
# or
PINEN_PERSIST_ENV=1 ./agent/setup.sh
```

## After Install

1. **Add your API keys:**

```bash
# Windows
Copy-Item $HOME\.pi\agent\auth.example.json $HOME\.pi\agent\auth.json
Copy-Item $HOME\.pi\agent\mcp.example.json $HOME\.pi\agent\mcp.json
# Edit auth.json and mcp.json with your keys
```

2. **Apply the core patch (optional but recommended):**

```powershell
# Windows
$HOME\.pi\agent\setup.ps1 -ApplyCorePatch
```

3. **Start Pi:**

```bash
pi
```

## Key Features

| Feature | Description |
|---------|-------------|
| **NenFlow v3** | Plan-Execute-Verify orchestration engine with role integrity |
| **safe-github-publish** | Default GitHub publishing method — sanitized staging, private-first, gitleaks scanning |
| **Engram Memory** | Persistent memory that survives sessions and compactions |
| **Graphify Brain** | Knowledge graph system for project memory (starts empty) |
| **piNen Logo** | "warm terminal intelligence" wordmark displayed above the editor |
| **MCP Integrations** | Spotify, Tavily, Engram, and extensible MCP server framework |
| **50+ Skills** | Algorithmic art, document processing, diagrams, research, and more |
| **Telegram Bridge** | Telegram ↔ Pi real-time messaging |
| **Orchestration Shapes** | `plan-execute-verify`, `safe-github-publish`, `multi-verify-vote`, `composable-pipeline`, `verify-only` |

## Repository Structure

```
piNen/
├── install.ps1              # Windows one-click installer
├── install.sh               # Unix convenience wrapper
├── package.json             # Root npm dependencies
├── .gitignore               # Publish-safe gitignore
├── .gitleaks.toml           # Gitleaks secret scanner config
├── docs/                    # Documentation
│   ├── INSTALL_WINDOWS.md
│   ├── CONFIGURATION.md
│   ├── SECURITY.md
│   └── HARNESS_ARCHITECTURE.md
├── agent/                   # Pi agent harness
│   ├── AGENTS.md            # Global agent policy
│   ├── README.md            # Agent configuration guide
│   ├── extensions/          # TypeScript extensions
│   ├── skills/              # 50+ skill directories
│   ├── agents/              # Subagent definitions
│   ├── nenflow-v3/          # NenFlow v3 engine
│   ├── prompts/             # System prompt templates
│   ├── core-patch/          # Pi core patch tooling
│   ├── spotify-mcp/         # Spotify MCP server
│   ├── telegram-pi/         # Telegram bridge
│   └── setup.ps1 / setup.sh # Bootstrap scripts
├── pi-orchestrator-extension/  # Reusable orchestration shapes
├── extensions/              # Root-level extensions
├── graphify-brain/          # Knowledge graph storage (starts empty)
└── bugs that need to be fixed/  # Bug tracking templates
```

## GitHub Publishing

piNen uses **safe-github-publish** as its default recommended method for pushing
repositories to GitHub. This shape:

1. Plans a sanitization contract with allowlists and deny lists
2. Builds a clean staging tree (never copies source `.git/` history)
3. Runs local safety checks: gitleaks, path scans, secret scans
4. Creates a **private-first** GitHub repository
5. Independently verifies the remote repository after push

To publish a new repo safely:

```
/orchestrate --paradigm safe-github-publish "Publish the current project to GitHub as my-repo"
```

See `pi-orchestrator-extension/PARADIGMS.md` for all available shapes.

## Documentation

- [Windows Installation](docs/INSTALL_WINDOWS.md)
- [Configuration Guide](docs/CONFIGURATION.md)
- [Security Model](docs/SECURITY.md)
- [Harness Architecture](docs/HARNESS_ARCHITECTURE.md)
- [Agent Configuration](agent/README.md)
- [Orchestration Paradigms](pi-orchestrator-extension/PARADIGMS.md)

## Safety

- **No committed secrets**: All auth configs are templates (`.example.json`) — you provide your own keys.
- **No runtime state**: Sessions, runs, handoffs, and diagnostics are gitignored.
- **No personal paths**: Repository is fully sanitized of publisher-specific paths.
- **No binaries**: Engram binary is downloaded by the installer, not committed.
- **gitleaks scanning**: The `.gitleaks.toml` config is included for pre-commit secret detection.

## License

MIT
