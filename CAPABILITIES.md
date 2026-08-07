# piNen Capability Inventory

This inventory describes the reusable harness shipped in this repository. Counts refer to the sanitized tree, not to private runtime state.

## Deterministic orchestration — 16 shapes

| Shape | Purpose |
|---|---|
| `plan-execute-verify` | Bounded planner → executor waves → verifier, with targeted retries |
| `multi-verify-vote` | Independent verifier voting |
| `composable-pipeline` | Natural-language phase composition |
| `dual-plan-synthesis-execute-verify` | Two plans, synthesis, execution, direct-evidence verification |
| `verify-only` | Read-only evidence verification without execution |
| `paradigm-creator` | Propose bounded reusable orchestration paradigms |
| `shape-builder` | Deterministically generate, test, reload-gate, and canary a shape |
| `ssi-single-writer-exclusive-lane` | Serialized SSI writer/native-gate workflow with lock and bounded repair |
| `venue-rescue-synthesis` | Bounded venue-rescue research/synthesis workflow |
| `frozen-gate-fix-loop` | Bounded fixes against a content-hash-locked specification |
| `evidence-audit` | Re-audit a completed run from frozen evidence |
| `independent-replication` | Two isolated implementations and independent verification |
| `preregistered-concurrency-spike` | Pre-registered bounded concurrency evidence |
| `m66-explicit-routing-proof` | Explicit routing/context-isolation acceptance proof |
| `win-console-spawn-root-cause` | Windows subprocess/console root-cause workflow |
| `win-lifecycle-process-trace` | Non-invasive Windows lifecycle trace harness workflow |

Shared orchestration capabilities include:

- provider/model preflight and fallback chains;
- explicit per-role model routing;
- up to 16 planner, executor, or verifier slots where the selected shape permits it;
- topological executor waves and bounded spawn guards;
- effect-based verification, tool-call evidence, worktree deltas, and hard-gate modes;
- resumable checkpointed runs and deterministic non-LLM phases;
- read-only discovery planning on PEV/dual-plan plus deterministic predicted-write-set enforcement on PEV/frozen-gate;
- terminal no-retry handling when a mutating child loses its result stream;
- Windows child-process recovery/evidence;
- plain-language completion reports without extra policy paperwork.

## Persistent memory

### Engram tools

`gentle-engram` and the Engram MCP server expose:

- discovery: `mem_context`, `mem_search`, `mem_get_observation`, `mem_timeline`, `mem_stats`;
- persistence: `mem_save`, `mem_update`, `mem_delete`, `mem_save_prompt`;
- sessions: `mem_session_start`, `mem_session_summary`, `mem_session_end`;
- project/health: `mem_current_project`, `mem_doctor`, `mem_suggest_topic_key`;
- capture/review: `mem_capture_passive`, `mem_review`;
- relation reasoning: `mem_judge`, `mem_compare`.

The repository contains setup, policy, client package, MCP wiring, and docs only. It contains no user memories or Engram databases.

### Graphify Brain

- knowledge-graph extraction for code, documents, and mixed media;
- graph reports and wiki navigation;
- project-memory save/load/list/prune/pin/keep/GC workflows;
- autonomous code-only and semantic maintenance;
- cross-project global graph maintenance;
- optional human-readable Obsidian wiki sync.

The committed `graphify-brain/` starts empty.

## Continuity and autonomous operation

- `agent_scheduler`: durable delayed wake-ups scoped to a working directory;
- `agent_new_session`: agent-operated context reset with canonical diagnostics;
- `agent_reload_runtime`: deferred runtime reload with diagnostics and retry handling;
- context-window usage monitoring;
- explicit continuation/handoff contracts;
- optional idempotent Pi core patch for command dispatch;
- startup/shutdown Graphify maintenance coordination;
- automated isolated Git backup refs with gitleaks and protected-path gates.

## Tool and service integrations

- **Browser:** Playwright MCP, snapshots, screenshots, forms, tabs, console/network inspection.
- **Search:** DuckDuckGo Lite/direct search with browser fallback, image search, reverse-image workflows, Tavily MCP.
- **MCP:** lazy server connection, progressive tool discovery, direct server calls, OAuth flow support.
- **Gmail:** send, inbox list, read, and IMAP search with multi-account config.
- **Telegram:** paired-chat bridge, active-session takeover, daemon fallback, text and photo sending.
- **Spotify:** full MCP playback, search, devices, queue, albums, saved tracks, top items, and playlist CRUD/reorder; clean-start playlist helper.
- **Railway:** projects, services, environments, deploys, domains, variables, storage, metrics, logs, templates, and docs.
- **Domains:** GoDaddy domain suggestions and availability checks.
- **Supabase/Postgres:** product workflows, auth/RLS guidance, schema/performance best practices.

## Active extensions — 39 source/test files

Major extension groups:

- scheduling, reload, new-session, and context awareness;
- deterministic subagents and model routing;
- Graphify and autonomous Graphify;
- isolated Git backup, a retired checkpoint compatibility stub, and destructive-command confirmation;
- browser/search, Playwright, Railway, GoDaddy, MCP status;
- Gmail, Spotify, and Telegram;
- thinking level, verbosity, todos, logo/widget, and test utilities.

See `agent/extensions/` for source.

## Generic subagent profiles — 51

Base roles:

- `planner`, `coder`, `reviewer`, `researcher`, `browser-agent`, `api-test-reader`;
- `graphify-extract`, `graphify-autonomy-runner`;
- `gm-planner`, `gm-executor`, `gm-verifier`;
- symbolic model profiles for Codex, DeepSeek, and Opus.

Specialist `orch-*` sidecars cover:

- intake, requirements, scope;
- codebase/dependency/internet/prior-art/risk/Graphify/memory research;
- architecture, implementation, migration, testing, rollback, and task splitting;
- feature, bugfix, refactor, test, integration, config, and documentation execution;
- acceptance, regression, security, performance, typecheck, and UI verification;
- execution witnessing, context/drift observation, artifact audit, decision recording, handoff, knowledge capture, and run archiving.

No project-specific profiles are included.

## Active skills — 48

```text
agent-new-session                 agent-reload
algorithmic-art                  artifacts-builder
brand-guidelines                 canvas-design
changelog-generator              competitive-ads-extractor
content-research-writer          docx
domain-name-brainstormer         file-organizer
find-skills                      frontend-design
global-graphify-maintenance      graphify
image-enhancer                   interactive-diagram-builder
internal-comms                   internet-research
invoice-organizer                lead-research-assistant
mcp-builder                      meeting-insights-analyzer
notion-knowledge-capture         notion-meeting-intelligence
notion-research-documentation    notion-spec-to-implementation
orchestration-builder            orchestration-wrapper
pdf                              pi-core-patch-reapply
pptx                             raffle-winner-picker
resemble-detect                  skill-creator
slack-gif-creator                spec-driven-ecology
spotify-play                     spotify-playlist
supabase                         supabase-postgres-best-practices
telegram-pi                      telegram-session-takeover
theme-factory                    video-downloader
webapp-testing                   xlsx
```

NenFlow v3 and its `pev-*` roles are retired. Historical runs, compatibility prompts, and retired implementation files are not published; orchestration routes through `/orchestrate`.

## Safety and publishing

- real auth/MCP/Gmail/Spotify/Telegram configs are denied by `.gitignore`;
- runtime executables/native binaries, databases, sessions, runs, handoffs, diagnostics, caches, nested repositories, and project memories are excluded (licensed skill font assets remain);
- example configs contain placeholders only;
- gitleaks configuration and security docs are included;
- Git backup uses isolated refs and never mutates the working branch;
- dangerous shell commands require confirmation;
- Publishing safeguards are documented in `docs/SECURITY.md`; routine Git publication remains an explicit user action.
