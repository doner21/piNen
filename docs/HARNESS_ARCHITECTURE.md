# Harness Architecture

piNen is a sanitized Pi home with four cooperating layers: Pi core, extensions/tools, reusable skills/agents, and durable memory/orchestration services.

## High-level view

```text
User / Telegram / Scheduler
            │
            ▼
┌─────────────────────────────────────────────┐
│ Pi core (@earendil-works/pi-coding-agent)  │
│ agent loop · providers · core file tools    │
└──────────────┬──────────────────────────────┘
               │ loads
     ┌─────────┴─────────────────────────┐
     ▼                                   ▼
agent/extensions/                 pi-orchestrator-extension/
continuity · browser · MCP        15 bounded orchestration shapes
memory · safety · integrations    route/preflight/evidence/resume
     │                                   │
     ├──────────────┬────────────────────┤
     ▼              ▼                    ▼
agent/skills/   agent/agents/        isolated Pi JSON
48 workflows    51 role profiles     subprocesses
     │
     ├─────────────────┬──────────────────┐
     ▼                 ▼                  ▼
Engram              Graphify Brain      External MCP/services
observations        project graphs      Spotify/Tavily/etc.
```

## Extension layer

`agent/extensions/` registers commands, tools, event handlers, and UI:

- **continuity:** scheduler, new-session, reload, context usage;
- **delegation:** subagents, model router, deterministic orchestrator package;
- **memory:** Graphify, autonomous maintenance, human wiki sync;
- **browser/research:** Playwright, browser/image search, MCP server status;
- **safety:** destructive-command confirmation, isolated Git backups, checkpoints;
- **integrations:** Gmail, Telegram, Spotify, Railway, GoDaddy;
- **UX:** thinking, verbosity, todos, and piNen logo.

The optional core patch exposes command dispatch needed by the autonomous reload/new-session bridges. It is explicit, idempotent, backup-before-write, and never applied silently.

## Orchestration layer

`pi-orchestrator-extension/` provides the primary deterministic spine:

```text
intake/normalize
      │
route + provider preflight
      │
shape-selected bounded phases
      │
checkpoint/effect evidence
      │
independent verification
      │
plain-language result
```

Core properties:

- subprocess isolation via `pi --mode json`;
- spawn ceilings and finite retry/iteration bounds;
- planner/executor/verifier route overrides and fallbacks;
- dependency waves and bounded concurrency;
- deterministic non-LLM hash/manifest phases;
- resumable run state;
- read-only discovery planning on PEV/dual-plan and deterministic predicted-write-set enforcement on PEV/frozen-gate;
- no-retry terminal state after ambiguous mutating child completion;
- direct effect evidence rather than trusting prose claims;
- explicit fail-closed parser/verifier contracts.

Shapes are siblings built on shared substrate primitives. See `../pi-orchestrator-extension/PARADIGMS.md`.

NenFlow v3 is retired and its implementation/compatibility prompts are not shipped; orchestration routes through `/orchestrate`.

## Memory layer

### Engram

Engram stores compact observations and session summaries. `gentle-engram` exposes Pi-native `mem_*` tools; the MCP template starts the binary lazily. Memory content is local and excluded from Git.

### Graphify Brain

Graphify turns repositories/content into graph reports, JSON graphs, and wikis. The global brain indexes known project graphs for future sessions. piNen commits only an empty brain placeholder and the machinery that populates it.

Engram and Graphify are complementary:

- Engram: decisions, discoveries, preferences, summaries, relations.
- Graphify: structural project/code/document knowledge.

## Runtime-state separation

Capability source is committed. Mutable state is not:

```text
committed                           ignored/local
---------                           -------------
extension and skill source          sessions and scheduled messages
agent profiles and prompts          orchestration runs/checkpoints
safe config examples                auth/OAuth/app-password configs
setup/install scripts               Engram databases and binaries
tests and runbooks                  Graphify project graphs
empty memory placeholders           diagnostics, caches, builds, logs
```

This boundary lets the full harness move between machines without moving a user's projects or memory.

## Installation flow

1. Clone into `~/.pi`.
2. Install root, `agent/npm`, extension, and Spotify MCP dependencies.
3. Install/download Engram separately.
4. Copy credential templates to gitignored real config files.
5. Optionally apply the Pi command-dispatch core patch.
6. Start Pi; packages and extensions load from `agent/settings.json`.

## Extending piNen

- Skill: create `agent/skills/<name>/SKILL.md`.
- Agent: create a generic profile in `agent/agents/`.
- Extension: add TypeScript under `agent/extensions/` and dependencies to its package.
- Orchestration shape: implement a sibling shape, register it, add tests/docs, reload, discover, and canary it.
- MCP server: add a safe template entry; never commit a real credential.
