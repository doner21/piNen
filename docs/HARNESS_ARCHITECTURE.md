# Harness Architecture

piNen is a sanitized Pi coding-agent harness — a pre-configured, batteries-included
installation of the Pi coding agent with extensions, skills, and orchestration
tools.

## High-Level Architecture

```
piNen Harness
├── Pi Core (npm: @earendil-works/pi-coding-agent)
│   ├── Agent loop (REPL + tool execution)
│   ├── Provider routing (OpenAI, Anthropic, DeepSeek, etc.)
│   └── Core tools (read, bash, edit, write, etc.)
│
├── Extensions (agent/extensions/)
│   ├── pinen-logo.ts          — piNen wordmark (above-editor widget)
│   ├── agent-scheduler/       — Autonomous wake-up scheduling
│   ├── agent-new-session/     — Agent-operated clean-session flow
│   ├── agent-reload/          — Agent-operated reload flow
│   ├── autonomous-graphify/   — Auto Graphify Brain maintenance
│   ├── nenflow-v3.ts          — NenFlow v3 orchestration engine
│   ├── subagent.ts            — Subagent spawning and management
│   ├── telegram-pi/           — Telegram ↔ Pi bridge
│   ├── context-awareness.ts   — Context budget monitoring
│   ├── git-checkpoint.ts      — Git checkpoint before risky operations
│   ├── model-router.ts        — Intelligent model selection
│   └── ... (20+ extensions)
│
├── Skills (agent/skills/)     — 50+ skill directories
├── Agents (agent/agents/)     — 50+ subagent definitions (JSON)
├── Prompts (agent/prompts/)   — System prompt templates
│
├── NenFlow v3 (agent/nenflow-v3/)
│   ├── context-policy.js      — Context budget enforcement
│   ├── validator.js           — Run validation
│   ├── schemas/               — Artifact schemas
│   ├── templates/             — Run templates
│   └── tests/                 — Validation tests
│
├── Orchestration Extension (pi-orchestrator-extension/)
│   ├── src/index.ts           — Shape registry and CLI
│   ├── src/substrate.ts       — Subagent spawning primitives
│   ├── src/types.ts           — OrchestrationShape interface
│   ├── src/judgment.ts        — Effect-based verdict hardening
│   └── src/shapes/            — Orchestration shapes
│       ├── plan-execute-verify.ts
│       ├── safe-github-publish.ts   (default GitHub publishing)
│       ├── multi-verify-vote.ts
│       ├── composable-pipeline.ts
│       └── verify-only.ts
│
├── Engram Memory (agent/bin/engram)
│   └── Persistent memory across sessions and compactions
│
├── Graphify Brain (graphify-brain/)
│   └── Knowledge graph storage (starts empty)
│
├── MCP Servers
│   ├── agent/spotify-mcp/     — Spotify playback + playlists
│   ├── Tavily (via npm)       — Internet research
│   └── Engram (built-in)      — Memory tools
│
└── Infrastructure
    ├── agent/setup.ps1/sh     — Bootstrap scripts
    ├── agent/core-patch/      — Pi core patching
    ├── install.ps1/sh         — One-click installers
    └── docs/                  — User-facing documentation
```

## piNen Logo

The piNen logo is displayed as an **above-editor widget** (not a header
replacement) via `agent/extensions/pinen-logo.ts`. It shows the "warm terminal
intelligence" wordmark between the agent output area and the user input area.

This is verified as part of the `safe-github-publish` pipeline.

## Orchestration Flow

### NenFlow v3 (PEV Stream)

```
User Task → Intake/Scout → Plan → Execute → Verify → Report
               │              │       │         │
               └─ Researcher   └─ Planner  └─ Executor  └─ Verifier
```

### Orchestration Shapes

The `pi-orchestrator-extension` provides reusable shapes built on a shared
**substrate** (subagent spawning, concurrency control, bounded execution):

```
OrchestrationShape
├── plan-execute-verify     (classic 3-phase)
├── safe-github-publish     (default GitHub publishing)
├── multi-verify-vote       (majority-rule verification)
├── composable-pipeline     (dynamic phase composition)
└── verify-only             (verification-only)
```

**Shape → Substrate rule:** Shapes are siblings — they stand on the substrate,
never build on each other. The substrate enforces hard bounds on spawns and
iterations.

## GitHub Publishing (safe-github-publish)

The `safe-github-publish` shape is the **default recommended method** for
publishing repositories to GitHub. It implements a 3-phase pipeline:

1. **Plan/Contract (Planner):** Produces a sanitization plan with allowlists
   and deny lists. Never copies source `.git/` history.

2. **Execute (Executor):** Builds a clean staging tree from the allowlist,
   runs local safety checks (gitleaks, path scans, secret scans), initializes
   a fresh git repository, creates a **private-first** GitHub repo, and pushes.

3. **Verify (Verifier):** Independently clones the remote, runs all safety
   gates, and produces a PASS/FAIL verdict with evidence.

**Role integrity:** The visible/current orchestrator never executes staging,
sanitization, commit, repo creation, or push. These are always delegated.

## Security Model

See [SECURITY.md](SECURITY.md) for the full security model.

Key points:
- **Zero secrets in repo** — Configs are templates only
- **Private-first publishing** — Repos are created private
- **No personal data** — Publisher paths/emails sanitized
- **gitleaks scanning** — Pre-commit and pre-push secret detection

## Extending the Harness

### Adding New Skills

Create a new directory in `agent/skills/` with a `SKILL.md` file.
See `agent/skills/skill-creator/SKILL.md` for the skill creation guide.

### Adding New Extensions

Create a TypeScript file in `agent/extensions/`. Extensions use the Pi SDK.
See the existing extensions for examples.

### Adding New Orchestration Shapes

Create a new file in `pi-orchestrator-extension/src/shapes/` implementing
the `OrchestrationShape` interface, then register it in
`pi-orchestrator-extension/src/index.ts`. See
`pi-orchestrator-extension/PARADIGMS.md` for the full guide.
