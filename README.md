# piNen — Orchestration-First Agent Harness

> **"warm terminal intelligence"**

piNen is an **orchestration-first** agent harness built on the Pi coding agent.
It treats orchestration not as a feature but as the **fundamental operating
paradigm** — the agent's primary way of reasoning about work is through
delegation, lifecycle-gated execution, and persistent memory spanning sessions
and projects.

```
  ╔═══════════════════════════════════════════════════════╗
  ║                                                       ║
  ║   piNen — warm terminal intelligence                  ║
  ║   orchestration-first · memory-persistent ·            ║
  ║   shape-composable · Telegram-connected                ║
  ║                                                       ║
  ╚═══════════════════════════════════════════════════════╝
```

---

## Philosophy

### Orchestration as the primal operating mode

piNen is built on a simple conviction: **an agent should not execute work
directly when it can delegate.** Every task, from a one-line file edit to a
multi-phase project, flows through the same pattern — intake, plan, delegate,
verify, persist. The visible agent is always the **ORCHESTRATOR**, not the
doer. This role integrity is not optional; it is enforced by policy, by the
substrate, and by the verifier, which will FAIL any run where the orchestrator
collapsed into the executor role.

### Memory that persists across time

Two memory systems work together:

- **Engram persistent memory** (`mem_*` tools) — durable observations,
  decisions, and session summaries that survive compaction, reloads, and
  full agent restarts. Every meaningful session ends with a structured
  summary; every non-obvious discovery is saved immediately.

- **Graphify Brain** (knowledge graphs) — project-level graph memory that
  captures architecture, dependencies, community structure, and a wiki of
  god nodes. The brain is built organically: `/graphify` maps a project,
  `graphify_auto` keeps it fresh. The agent consults it before broad file
  reading, treating it as durable project context rather than rediscovering
  from scratch each time.

Together they form a **layered memory architecture**: session → project →
harness — each layer more persistent than the last.

### Shapes as composable orchestration primitives

The `pi-orchestrator-extension` provides **orchestration shapes** — reusable,
deterministic orchestration paradigms built on a shared **substrate**.

```
Substrate (bounds, spawns, safety)
├── plan-execute-verify       (classic 3-phase)
├── multi-verify-vote         (majority-rule gates)
├── composable-pipeline       (dynamic phase composition)
├── safe-github-publish       (private-first, gitleaks-scanned)
├── verify-only               (independent evidence check)
└── shape-builder             (meta-constructor for new shapes)
```

**The one-line rule:** Shapes are siblings — they stand on the substrate,
never build on each other. No shape imports, extends, or calls another.
The substrate enforces hard bounds on spawns, iterations, and time, so no
shape can run forever.

### The shape-builder: a meta-constructor for evolving the harness

The `shape-builder` is piNen's most distinctive capability — it is a
**deterministic meta-paradigm constructor** that can create new, reusable
orchestration shapes from a strict JSON specification, gate them through
a full lifecycle, and only mark them usable after independent verification,
runtime reload, active discovery, and a canary pass.

```
Lifecycle: proposed → implemented_verified → (reload) → discovered → canary_passed
                                                              ↓
                                                        usable: true
```

This means piNen is not static — it can **grow its own orchestration
vocabulary**, adding new paradigms for novel task shapes without requiring
manual extension coding. Each generated shape is a first-class sibling,
registered in the registry, tested, documented, and independently verified.

### Connected intelligence

piNen bridges the terminal to the world:

- **Telegram bridge** — real-time messaging between Telegram and the agent.
  Send commands, receive results, manage sessions from your phone. The bridge
  runs as a background daemon with session takeover to route messages to the
  active session.

- **Gmail integration** — send, read, search, and receive email from within
  the agent. Inbox management, email-based task intake, and result delivery.

- **MCP ecosystem** — Spotify playback and playlist management, Tavily
  internet research, and an extensible MCP server framework for connecting
  any service.

---

## Quick Install (Windows)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/doner21/piNen/main/install.ps1'; $f=Join-Path $env:TEMP 'pinen-install.ps1'; Invoke-WebRequest -UseBasicParsing $u -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f"
```

**Options:**

```powershell
-PersistEnv       # Persist Engram path across sessions
-ApplyCorePatch   # Apply Pi core patch for orchestration support
-InstallDir <path>  # Custom install path (default: $HOME\.pi)
```

### Manual Install

```powershell
git clone https://github.com/doner21/piNen.git $HOME\.pi
cd $HOME\.pi
.\agent\setup.ps1 -ApplyCorePatch
```

### Linux / macOS

```bash
git clone https://github.com/doner21/piNen.git $HOME/.pi
cd $HOME/.pi
./agent/setup.sh --persist-env
```

---

## After Install

### 1. Add API keys

```powershell
Copy-Item $HOME\.pi\agent\auth.example.json $HOME\.pi\agent\auth.json
Copy-Item $HOME\.pi\agent\mcp.example.json $HOME\.pi\agent\mcp.json
# Edit auth.json and mcp.json with your provider keys
```

### 2. Start Pi

```bash
pi
```

### 3. Verify memory

```
mem_context
```

---

## Usage Guide

### Basic orchestration

Delegate a task through the plan-execute-verify pipeline:

```
/orchestrate "Review the code in src/, identify any security issues, and write a report."
```

Or via the tool interface:

```json
{
  "task": "Refactor the database layer to use connection pooling.",
  "paradigm": "plan-execute-verify"
}
```

### Using specific orchestration shapes

```text
/orchestrate --paradigm multi-verify-vote "Evaluate whether this refactor is safe."
/orchestrate --paradigm composeable-pipeline "Hypothesize → critique → synthesize → plan → execute → verify."
/orchestrate --paradigm verify-only "Evidence checklist: 1) tests pass 2) lint passes. Paths: src/"
/orchestrate --paradigm safe-github-publish "Publish current project as my-new-repo"
```

### Creating a new orchestration shape

The `shape-builder` paradigm generates a new shape from a spec:

```text
/orchestrate --paradigm shape-builder

SHAPE_BUILDER_SPEC_JSON
{
  "schemaVersion": 1,
  "action": "build",
  "targetName": "my-custom-shape",
  "purpose": "Runs two competing executors and picks the better result",
  "phases": [
    {"name": "executor-a", "role": "executor", "agentName": "coder", "prompt": "Implement approach A...", "expectedOutput": "code"},
    {"name": "executor-b", "role": "executor", "agentName": "coder", "prompt": "Implement approach B...", "expectedOutput": "code"},
    {"name": "judge", "role": "verifier", "agentName": "reviewer", "prompt": "Compare both outputs and select the better one...", "expectedOutput": "selection"}
  ],
  "maxSubagents": 3,
  "maxIterations": 1,
  "terminationCondition": "finite: one pass through phases",
  "evidenceModel": "subagent outputs",
  "failureBehavior": "any subagent failure fails the shape",
  "userFacingExplanation": "Competes two executors and selects the best result"
}
```

This will:
1. Parse and validate the spec
2. Render source, tests, registry entries, and documentation
3. Run tests and independent verification
4. Signal `reloadRequired: true` — you then reload Pi
5. After reload, the orchestrator verifies discovery and runs a canary
6. The new shape is marked `usable: true`

### Memory management

View session context:

```
mem_context
```

Search past decisions:

```
mem_search "database migration strategy"
```

Save an observation:

```
mem_save --title "Load testing threshold determined" --type decision
```

Build a project knowledge graph:

```
/graphify
```

### Telegram bridge

Check bridge status:

```
/telegram status
```

Send a message:

```
/telegram send "Task completed successfully"
```

Pair a Telegram sender (first time):

```
/telegram pair
```

### Gmail

Check inbox:

```
/gmail inbox 5
```

Send email:

```
/gmail send user@example.com "Subject" "Body text"
```

Search:

```
/gmail search "FROM john SUBJECT report"
```

### Listening to music (Spotify MCP)

```text
/mcp connect spotify
```

Then:

```text
Play some lo-fi hip hop
Add this to my focus playlist
What's playing now?
Skip to next
Volume 40
```

---

## Architecture

```
piNen
├── Orchestration Layer
│   ├── NenFlow v3          — Plan-Execute-Verify pipeline engine
│   ├── pi-orchestrator-ext  — Shape registry, substrate, judgment layer
│   └── Orchestration shapes — Registered paradigms (5+ built-in)
│
├── Memory Layer
│   ├── Engram               — Persistent cross-session memory
│   ├── Graphify Brain       — Project-level knowledge graphs
│   └── Session memory       — Context-aware working memory
│
├── Connection Layer
│   ├── Telegram bridge      — Real-time messaging
│   ├── Gmail integration    — Email send/receive/search
│   └── MCP ecosystem        — Spotify, Tavily, extensible
│
├── Extension Layer
│   ├── 20+ TypeScript extensions
│   ├── 50+ skill directories
│   └── 50+ subagent definitions
│
└── Safety Layer
    ├── Orchestrator Role Integrity (enforced by verifier)
    ├── Effect-based judgment (hard gates / advisory gates)
    ├── Substrate bounds (spawn caps, iteration caps)
    ├── gitleaks scanning (pre-commit / pre-push)
    └── No committed secrets (all configs are .example.json)
```

### Key concepts

| Concept | Description |
|---------|-------------|
| **Orchestrator** | The visible agent — always delegates, never executes main work |
| **Subagent** | Isolated agent process spawned for a focused task |
| **Shape** | A reusable orchestration paradigm (a named orchestration pattern) |
| **Substrate** | The safety layer that bounds every shape's spawns and iterations |
| **Lifecycle** | Monotonic status progression for shape-builder: proposed → → → canary_passed |
| **Engram** | Persistent memory across sessions, compactions, and restarts |
| **Graphify Brain** | Project-level knowledge graph with wiki documentation |
| **Role Integrity Ledger** | Every orchestration run's proof that the orchestrator stayed in role |
| **Judgment** | Effect-based verdict hardening — text-shape heuristics vs. real file mutations |

---

## Safety Model

- **Zero secrets in repo.** All configs are templates (`.example.json`). You
  provide your own keys.
- **No committed state.** Sessions, runs, handoffs, diagnostics are gitignored.
- **No personal paths.** The repository is sanitized of publisher-specific paths.
- **Private-first publishing.** The `safe-github-publish` shape creates repos
  as private.
- **gitleaks scanning.** Pre-commit and pre-push secret detection built in.
- **Role integrity enforcement.** The verifier FAILs if the orchestrator
  executed main-task work directly.

---

## Documentation

| Document | What it covers |
|----------|----------------|
| [Installation (Windows)](docs/INSTALL_WINDOWS.md) | One-click and manual install |
| [Configuration Guide](docs/CONFIGURATION.md) | API keys, MCP, Telegram, models |
| [Security Model](docs/SECURITY.md) | Threat model, secrets handling |
| [Harness Architecture](docs/HARNESS_ARCHITECTURE.md) | System architecture diagram |
| [Paradigms Guide](pi-orchestrator-extension/PARADIGMS.md) | All orchestration shapes |
| [Agent Policy](agent/AGENTS.md) | Role integrity, memory, git safety |

## License

MIT
