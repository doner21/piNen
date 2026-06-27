# Pi Code Harness — Architecture & Data Flow Diagram

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                           PI CODING AGENT HARNESS                                ║
║                     ~/.pi/agent/  (aka <owner>/piNen)                        ║
╚══════════════════════════════════════════════════════════════════════════════════╝

                                    ┌──────────┐
                                    │   USER   │
                                    └────┬─────┘
                                         │
                ┌────────────────────────┼────────────────────────┐
                │                        │                        │
                v                        v                        v
    ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────┐
    │  SLASH COMMANDS   │   │  SUBAGENT SPAWN   │   │   LLM TOOL CALLS     │
    │  (user-typed)     │   │  (user-typed)     │   │  (model-initiated)   │
    └──────┬───────────┘   └──────┬───────────┘   └──────────┬───────────┘
           │                      │                          │
           v                      v                          v
    ╔══════════════════════════════════════════════════════════════════════╗
    ║                        EXTENSION LAYER  (12 .ts files)                ║
    ║                     hooks into Pi's event system                      ║
    ╚══════════════════════════════════════════════════════════════════════╝
           │                      │                          │
           │                      │                          │
    ┌──────┴──────────────────────┴──────────────────────────┴──────────────┐
    │                                                                        │
    │  ┌────────────────────────────────────────────────────────────────┐    │
    │  │                    ★ CORE ORCHESTRATION ★                       │    │
    │  │                                                                  │    │
    │  │  ┌────────────────────┐           ┌──────────────────────────┐  │    │
    │  │  │   thinking.ts      │           │  nenflow-v3.ts            │  │    │
    │  │  │                    │           │                           │  │    │
    │  │  │  /think off|min    │           │  /nenflow_v3 <task>       │  │    │
    │  │  │  /think low|med    │           │  /pev <task>              │  │    │
    │  │  │  /think high|xhigh │           │  → triggers prompt tmpl   │  │    │
    │  │  │                    │           │  → loads nenflow-v3 skill │  │    │
    │  │  └────────────────────┘           └──────────────────────────┘  │    │
    │  │                                                                  │    │
    │  │  ┌────────────────────┐           ┌──────────────────────────┐  │    │
    │  │  │  verbosity.ts      │           │  todos.ts                  │  │    │
    │  │  │                    │           │                           │  │    │
    │  │  │  /verbosity brief  │           │  /todos                   │  │    │
    │  │  │  concise|normal    │           │  /todos add|done|rem|clr  │  │    │
    │  │  │  detailed|verbose  │           │  → JSON-backed task list  │  │    │
    │  │  └────────────────────┘           └──────────────────────────┘  │    │
    │  └────────────────────────────────────────────────────────────────┘    │
    │                                                                        │
    │  ┌────────────────────────────────────────────────────────────────┐    │
    │  │                     ★ SAFETY GUARDRAILS ★                       │    │
    │  │                                                                  │    │
    │  │  ┌──────────────────────────────────────────────────────────┐  │    │
    │  │  │  confirm-destructive.ts                                   │  │    │
    │  │  │                                                           │  │    │
    │  │  │  hooks: tool_call (LLM bash), user_bash (!command)        │  │    │
    │  │  │  blocks: rm -rf, mkfs, dd, truncate, sudo rm,           │  │    │
    │  │  │          Windows recursive del/rd, redirect to /dev/      │  │    │
    │  │  │  → shows confirmation dialog; blocks if no UI             │  │    │
    │  │  └──────────────────────────────────────────────────────────┘  │    │
    │  │                                                                  │    │
    │  │  ┌──────────────────────────────────────────────────────────┐  │    │
    │  │  │  ★ git-checkpoint.ts  [MODIFIED — SPRINT] ★               │  │    │
    │  │  │                                                           │  │    │
    │  │  │  hooks: tool_call (write/edit tools only)                 │  │    │
    │  │  │  BEFORE:  git add -A && git commit ...                    │  │    │
    │  │  │  AFTER:   git add -u && git commit ...  ← SC7             │  │    │
    │  │  │  CHANGE:  -u stages tracked files only (no untracked)     │  │    │
    │  │  │  → never blocks agent; failures are warnings              │  │    │
    │  │  └──────────────────────────────────────────────────────────┘  │    │
    │  └────────────────────────────────────────────────────────────────┘    │
    │                                                                        │
    │  ┌────────────────────────────────────────────────────────────────┐    │
    │  │                  ★ SUBAGENT INFRASTRUCTURE ★                    │    │
    │  │                                                                  │    │
    │  │  ┌──────────────────────────────────────────────────────────┐  │    │
    │  │  │  ★ subagent.ts  [MODIFIED — SPRINT] ★                     │  │    │
    │  │  │                                                           │  │    │
    │  │  │  /subagents list|spawn|create                             │  │    │
    │  │  │  tool: subagent(agent, task, cwd?, allowLocalModel?)      │  │    │
    │  │  │                                                           │  │    │
    │  │  │  SC1 FIX:  CLI path resolution                            │  │    │
    │  │  │    BEFORE:  homedir()/AppData/Roaming/npm/...             │  │    │
    │  │  │    AFTER:   resolveCliPath():                             │  │    │
    │  │  │      1. PI_CLI_PATH env var                               │  │    │
    │  │  │      2. platform === "win32" → APPDATA || homedir()       │  │    │
    │  │  │      3. Unix → .npm-global, /usr/local/lib, /usr/lib      │  │    │
    │  │  │                                                           │  │    │
    │  │  │  SC8 FIX:  Structured metadata in results                 │  │    │
    │  │  │    BEFORE:  { content, details }                          │  │    │
    │  │  │    AFTER:   { content, details, metadata: {               │  │    │
    │  │  │                agent, agencyLevel, model, provider,        │  │    │
    │  │  │                sourceFile, resultLength, cwd } }           │  │    │
    │  │  └──────────────────────────────────────────────────────────┘  │    │
    │  │                                                                  │
    │  │  ┌────────────────────┐                                         │    │
    │  │  │  agents.ts          │   /agents → deprecated redirect        │    │
    │  │  │  (retired stub)     │   points user to /subagents            │    │
    │  │  └────────────────────┘                                         │    │
    │  └────────────────────────────────────────────────────────────────┘    │
    │                                                                        │
    │  ┌────────────────────────────────────────────────────────────────┐    │
    │  │               ★ BROWSER AUTOMATION ★                            │    │
    │  │                                                                  │    │
    │  │  ┌──────────────────────────────────────────────────────────┐  │    │
    │  │  │  ★ playwright-mcp.ts  [MODIFIED — SPRINT] ★               │  │    │
    │  │  │                                                           │  │    │
    │  │  │  hooks: session_start → spawns playwright-mcp --headless  │  │    │
    │  │  │         session_shutdown → closes MCP connection          │  │    │
    │  │  │  registers: 15+ browser tools (navigate, click, snapshot, │  │    │
    │  │  │              screenshot, type, fill, evaluate, etc.)      │  │    │
    │  │  │  lock recovery: kills zombie Chrome, clears stale LOCK   │  │    │
    │  │  │                                                           │  │    │
    │  │  │  SC2 FIX:  Browser profile path                           │  │    │
    │  │  │    BEFORE:  env["LOCALAPPDATA"] ?? "%USERPROFILE%/..."   │  │    │
    │  │  │    AFTER:   env["LOCALAPPDATA"] ?? join(homedir(),...)    │  │    │
    │  │  │    + import { homedir } from "node:os"                    │  │    │
    │  │  └──────────────────────────────────────────────────────────┘  │    │
    │  │                                                                  │
    │  │  ┌────────────────────┐                                         │    │
    │  │  │  mcp-status.ts      │   MCP server registry (shared state)   │    │
    │  │  │  (helper module)    │   /mcp list → show server status       │    │
    │  │  └────────────────────┘                                         │    │
    │  └────────────────────────────────────────────────────────────────┘    │
    │                                                                        │
    │  ┌────────────────────────────────────────────────────────────────┐    │
    │  │                   ★ MEMORY SYSTEM ★                             │    │
    │  │                                                                  │    │
    │  │  ┌──────────────────────────────────────────────────────────┐  │    │
    │  │  │  ★ graphify.ts  [MODIFIED — SPRINT] ★                     │  │    │
    │  │  │                                                           │  │    │
    │  │  │  /graphify <folder>  →  run graphify skill                │  │    │
    │  │  │  /memory save|list|load|runs|prune|pin|gc|keep|stats     │  │    │
    │  │  │  /memory-wiki sync|open|notes                             │  │    │
    │  │  │                                                           │  │    │
    │  │  │  hooks: session_start → rebuild brain index               │  │    │
    │  │  │         before_agent_start → inject brain context         │  │    │
    │  │  │                                                           │  │    │
    │  │  │  SC5 + SC6 FIX:  Memory injection safety gates            │  │    │
    │  │  │    BEFORE:  brainContextForCwd() injected ALL graph       │  │    │
    │  │  │             report content unconditionally                │  │    │
    │  │  │    AFTER:   Reads run-meta.json for safeToInject          │  │    │
    │  │  │             and verifiedStatus BEFORE injecting:          │  │    │
    │  │  │       safeToInject===false → SKIP GRAPH_REPORT            │  │    │
    │  │  │       verifiedStatus!="verified" → WARN but inject       │  │    │
    │  │  │       all new FS reads in try/catch                       │  │    │
    │  │  └──────────────────────────────────────────────────────────┘  │    │
    │  │                                                                  │
    │  │  ┌──────────────────────────────────────────────────────────┐  │    │
    │  │  │  memory-wiki-human.ts                                     │  │    │
    │  │  │  /memory-wiki-human → Obsidian vault management           │  │    │
    │  │  └──────────────────────────────────────────────────────────┘  │    │
    │  └────────────────────────────────────────────────────────────────┘    │
    │                                                                        │
    └────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │  Extensions load skills, spawn subagents,
                                         │  read agent configs, inject prompts
                                         │
           ┌─────────────────────────────┼─────────────────────────────┐
           │                             │                             │
           v                             v                             v
    ╔══════════════════╗     ╔═══════════════════╗     ╔══════════════════════╗
    ║   SKILLS LAYER   ║     ║  SUBAGENTS LAYER   ║     ║  PROMPTS LAYER      ║
    ║  (8 .md skill     ║     ║  (9 .json agents)  ║     ║  (2 .md templates)  ║
    ║   directories)    ║     ║                    ║     ║                     ║
    ╚══════════════════╝     ╚═══════════════════╝     ╚══════════════════════╝
           │                             │                             │
           │                             │                             │
    ┌──────┴─────────────────────────────┴─────────────────────────────┴──────┐
    │                                                                         │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │                     ★ SKILLS (skills/*/SKILL.md) ★                 │  │
    │  │                                                                    │  │
    │  │  ┌──────────────────────────┐  ┌──────────────────────────────┐   │  │
    │  │  │  graphify/               │  │  internet-research/           │   │  │
    │  │  │  Code→knowledge graph    │  │  DuckDuckGo web search       │   │  │
    │  │  │  AST extraction + LLM    │  │  Real-time info retrieval    │   │  │
    │  │  └──────────────────────────┘  └──────────────────────────────┘   │  │
    │  │                                                                    │  │
    │  │  ★ NENFLOW v3 SKILL FAMILY [ALL 5 MODIFIED — SPRINT] ★             │  │
    │  │                                                                    │  │
    │  │  ┌────────────────────────────────────────────────────────────┐   │  │
    │  │  │  nenflow-v3/SKILL.md       ← ORCHESTRATOR skill             │   │  │
    │  │  │  Intake → Research → Plan → Execute → Verify               │   │  │
    │  │  │  SC3 FIX: 10× %USERPROFILE%/.pi/agent/nenflow-v3/        │   │  │
    │  │  │            → ~/.pi/agent/nenflow-v3/                       │   │  │
    │  │  └────────────────────────────────────────────────────────────┘   │  │
    │  │                                                                    │  │
    │  │  ┌─────────────────────┐  ┌───────────────────────────────────┐   │  │
    │  │  │ nenflow-pev-         │  │  nenflow-pev-planner/             │   │  │
    │  │  │ researcher/SKILL.md  │  │  SKILL.md                         │   │  │
    │  │  │                      │  │                                    │   │  │
    │  │  │ Lightweight          │  │  Structured plan with             │   │  │
    │  │  │ discovery agent      │  │  invariants and success criteria  │   │  │
    │  │  │                      │  │                                    │   │  │
    │  │  │ SC3 FIX: 4× path     │  │  SC3 FIX: 4× path                 │   │  │
    │  │  │  %USERPROFILE%/     │  │   %USERPROFILE%/nenflow_v3/      │   │  │
    │  │  │  nenflow_v3/ →       │  │   → ~/.pi/agent/nenflow-v3/       │   │  │
    │  │  │  ~/.pi/agent/        │  │                                    │   │  │
    │  │  │  nenflow-v3/         │  │                                    │   │  │
    │  │  └─────────────────────┘  └───────────────────────────────────┘   │  │
    │  │                                                                    │  │
    │  │  ┌─────────────────────┐  ┌───────────────────────────────────┐   │  │
    │  │  │ nenflow-pev-         │  │  nenflow-pev-verifier/            │   │  │
    │  │  │ executor/SKILL.md    │  │  SKILL.md                         │   │  │
    │  │  │                      │  │                                    │   │  │
    │  │  │ Implements plan      │  │  Independent verification         │   │  │
    │  │  │ produces exec report │  │  Evidence-based PASS/FAIL         │   │  │
    │  │  │ + verifier brief     │  │                                    │   │  │
    │  │  │                      │  │  SC3 FIX: 4× path                 │   │  │
    │  │  │ SC3 FIX: 4× path     │  │   %USERPROFILE%/nenflow_v3/      │   │  │
    │  │  │  %USERPROFILE%/     │  │   → ~/.pi/agent/nenflow-v3/       │   │  │
    │  │  │  nenflow_v3/ →       │  │                                    │   │  │
    │  │  │  ~/.pi/agent/        │  │                                    │   │  │
    │  │  │  nenflow-v3/         │  │                                    │   │  │
    │  │  └─────────────────────┘  └───────────────────────────────────┘   │  │
    │  │                                                                    │  │
    │  │  NOTE: All 4 PEV skills also fixed: nenflow_v3 → nenflow-v3       │  │
    │  │        (underscore → hyphen, canonical directory name)             │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                         │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │                   ★ PROMPTS (prompts/*.md) ★                       │  │
    │  │                  [BOTH MODIFIED — SPRINT]                          │  │
    │  │                                                                    │  │
    │  │  ┌──────────────────────────────┐  ┌────────────────────────────┐  │  │
    │  │  │  pev.md                      │  │  nenflow_v3.md              │  │  │
    │  │  │                              │  │                             │  │  │
    │  │  │  Prompt template for         │  │  Prompt template for        │  │  │
    │  │  │  /pev command                │  │  /nenflow_v3 command        │  │  │
    │  │  │                              │  │                             │  │  │
    │  │  │  SC4 FIX: 1× path            │  │  SC4 FIX: 1× path           │  │  │
    │  │  │  %USERPROFILE%/.pi/         │  │  %USERPROFILE%/.pi/        │  │  │
    │  │  │  agent/skills/nenflow-       │  │  agent/skills/nenflow-      │  │  │
    │  │  │  v3/SKILL.md →               │  │  v3/SKILL.md →              │  │  │
    │  │  │  ~/.pi/agent/skills/         │  │  ~/.pi/agent/skills/        │  │  │
    │  │  │  nenflow-v3/SKILL.md         │  │  nenflow-v3/SKILL.md        │  │  │
    │  │  └──────────────────────────────┘  └────────────────────────────┘  │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                         │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │              ★ SUBAGENTS (agents/*.json) ★                         │  │
    │  │                                                                    │  │
    │  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────────────┐  │  │
    │  │  │ researcher.json │ │ planner.json   │ │ coder.json             │  │  │
    │  │  │ agency: research│ │ agency: read-  │ │ agency: write-enabled  │  │  │
    │  │  │ tools: read,bash│ │ only           │ │ tools: read,bash,edit, │  │  │
    │  │  │                 │ │ tools: read    │ │        write           │  │  │
    │  │  └────────────────┘ └────────────────┘ └────────────────────────┘  │  │
    │  │                                                                    │  │
    │  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────────────┐  │  │
    │  │  │ reviewer.json  │ │ api-test-      │ │ browser-agent.json     │  │  │
    │  │  │ agency: read-  │ │ reader.json    │ │ agency: research        │  │  │
    │  │  │ only           │ │                │ │                         │  │  │
    │  │  └────────────────┘ └────────────────┘ └────────────────────────┘  │  │
    │  │                                                                    │  │
    │  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────────────┐  │  │
    │  │  │ pev-researcher │ │ pev-planner    │ │ pev-executor            │  │  │
    │  │  │ .json          │ │ .json          │ │ .json                   │  │  │
    │  │  │ agency: research│ │ agency: read-  │ │ agency: write-enabled   │  │  │
    │  │  │ tools: read,bash│ │ only           │ │ tools: read,bash,edit,  │  │  │
    │  │  │ skill: nenflow- │ │ tools: read    │ │        write            │  │  │
    │  │  │ pev-researcher  │ │ skill: nenflow-│ │ skill: nenflow-         │  │  │
    │  │  │                 │ │ pev-planner    │ │ pev-executor            │  │  │
    │  │  └────────────────┘ └────────────────┘ └────────────────────────┘  │  │
    │  │                                                                    │  │
    │  │  ┌────────────────────────────────────────────────────────────┐    │  │
    │  │  │ pev-verifier.json                                          │    │  │
    │  │  │ agency: read-only  |  tools: read,bash                     │    │  │
    │  │  │ skill: nenflow-pev-verifier                                │    │  │
    │  │  └────────────────────────────────────────────────────────────┘    │  │
    │  │                                                                    │  │
    │  │  Agency levels:                                                    │  │
    │  │    read-only      →  read,grep,find,ls  (no bash, no writes)       │  │
    │  │    research       →  read,bash,grep,find,ls  (bash CAN write!)     │  │
    │  │    write-enabled  →  read,bash,edit,write  (full access)           │  │
    │  │                                                                    │  │
    │  │  NOTE: Agency enforcement is tool-config-based (not policy engine).│  │
    │  │        A "research" agent with bash CAN write via shell commands.  │  │
    │  │        confirm-destructive.ts catches dangerous patterns but       │  │
    │  │        does NOT classify bash operations as read vs write.         │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                         │
    └─────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │  Extensions and skills read/write
                                         │  from filesystem
                                         │
           ┌─────────────────────────────┼─────────────────────────────┐
           │                             │                             │
           v                             v                             v
    ╔══════════════════╗   ╔══════════════════════╗   ╔══════════════════════╗
    ║   MEMORY STORE   ║   ║   NENFLOW RUNS       ║   ║   OTHER STATE        ║
    ╚══════════════════╝   ╚══════════════════════╝   ╚══════════════════════╝
           │                             │                             │
    ┌──────┴─────────────────────────────┴─────────────────────────────┴──────┐
    │                                                                         │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │  ~/.pi/graphify-brain/            (Graphify Memory Store)          │  │
    │  │                                                                    │  │
    │  │  index.md  ← rebuilt on session_start, lists all saved projects    │  │
    │  │  brain-meta.json  ← HeatTracker (access counts, temperatures)      │  │
    │  │                                                                    │  │
    │  │  {project-slug}/                                                  │  │
    │  │    meta.json         ← displayName, projectPath, savedAt, nodes,   │  │
    │  │                         edges, lastRunId, runCount                  │  │
    │  │    GRAPH_REPORT.md   ← latest graph report (backward compat)        │  │
    │  │    graph.json        ← latest graph data (backward compat)          │  │
    │  │    wiki/             ← Graphify wiki output                         │  │
    │  │    obsidian/         ← Graphify obsidian output                     │  │
    │  │    runs/{runId}/                                                  │  │
    │  │      GRAPH_REPORT.md  run-meta.json  graph.json  wiki/  obsidian/  │  │
    │  │                                                                    │  │
    │  │  obsidian-vault/     ← Central Obsidian wiki vault                 │  │
    │  │    _INDEX.md          _BRAIN_CANVAS.canvas                         │  │
    │  │    {project-slug}/    ← per-project obsidian notes                 │  │
    │  │                                                                    │  │
    │  │  .archive/           ← pruned/gc'd runs (auto-delete after 30d)    │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                         │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │  ~/.pi/agent/nenflow-v3/runs/      (NenFlow v3 Run Artifacts)     │  │
    │  │                                                                    │  │
    │  │  validator.js  ← checks frontmatter (role, artifact_type, verdict) │  │
    │  │  .nenflow_context_health.json  ← shared context health tracker     │  │
    │  │  templates/CONTINUATION.md  ← continuation contract template       │  │
    │  │                                                                    │  │
    │  │  runs/RUN_YYYYMMDD-HHMMSS/                                        │  │
    │  │    LATEST_PLAN.md            ← symlink/copy of latest plan         │  │
    │  │    LATEST_EXECUTION.md       ← symlink/copy of latest exec report  │  │
    │  │    LATEST_VERIFIER_BRIEF.md  ← symlink/copy of latest brief        │  │
    │  │    LATEST_VERIFICATION.md    ← symlink/copy of latest verification │  │
    │  │    ATT_0_INTAKE.md           ← orchestrator intake                 │  │
    │  │    ATT_1_RESEARCH.md         ← optional researcher output          │  │
    │  │    ATT_1_PLAN.md             ← planner output (ATT_2 if research)  │  │
    │  │    ATT_n_EXECUTION.md        ← executor implementation report      │  │
    │  │    ATT_n_VERIFIER_BRIEF.md   ← executor's handoff to verifier      │  │
    │  │    ATT_n_VERIFICATION.md     ← verifier's PASS/FAIL verdict        │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                         │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │  Other State Files                                                │  │
    │  │                                                                    │  │
    │  │  settings.json            ← default model, provider, thinking      │  │
    │  │  auth.json                ← API keys (gitignored, never committed) │  │
    │  │  models.json              ← custom model definitions               │  │
    │  │  mcp-registry.json        ← MCP server connection state            │  │
    │  │  verbosity-state.json     ← current verbosity level                │  │
    │  │  sessions/                ← session history (gitignored)           │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                         │
    └─────────────────────────────────────────────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║                        DATA FLOW — NenFlow v3 Run                            ║
╚══════════════════════════════════════════════════════════════════════════════╝

    USER types: /nenflow_v3 or /pev <task>
         │
         v
    ┌──────────────────────────────────────────────────────────────────┐
    │  nenflow-v3 Prompt Template (prompts/nenflow_v3.md or pev.md)    │
    │  → Injects role instructions + loads nenflow-v3 skill            │
    └──────────────────────────────────────────────────────────────────┘
         │
         v
    ┌──────────────────────────────────────────────────────────────────┐
    │  ORCHESTRATOR (current visible session)                          │
    │  1. Generates run ID: RUN_YYYYMMDD-HHMMSS                        │
    │  2. Creates run directory under nenflow-v3/runs/                 │
    │  3. Writes ATT_0_INTAKE.md (ecological framing of task)          │
    │  4. Validates intake with validator.js                           │
    │  5. Writes .nenflow_context_health.json                          │
    └──────────────────────────────────────────────────────────────────┘
         │
         │  ┌──── optional ────┐
         │  v                  │
    ┌──────────────┐           │
    │  RESEARCH     │           │
    │  subagent:    │           │
    │  pev-resrchr  │───────────┘
    │  → ATT_1_RESEARCH.md     │
    └──────────────┘           │
                               v
    ┌──────────────────────────────────────────────────────────────────┐
    │  PLANNING                                                        │
    │  subagent: pev-planner                                           │
    │  Input:  ATT_0_INTAKE.md [+ ATT_1_RESEARCH.md]                  │
    │  Output: ATT_1_PLAN.md + LATEST_PLAN.md                          │
    │  Validated with: validator.js PLAN PLAN                          │
    └──────────────────────────────────────────────────────────────────┘
         │
         v
    ┌──────────────────────────────────────────────────────────────────┐
    │  EXECUTION                                                       │
    │  subagent: pev-executor                                          │
    │  Input:  ATT_0_INTAKE.md + ATT_1_PLAN.md                        │
    │  Output: ATT_2_EXECUTION.md + ATT_2_VERIFIER_BRIEF.md           │
    │          + LATEST_EXECUTION.md + LATEST_VERIFIER_BRIEF.md        │
    │  Makes actual file changes (edit/write/bash)                     │
    │  Git checkpoint fires BEFORE each write/edit (git add -u)        │
    │  Destructive commands require confirmation                       │
    └──────────────────────────────────────────────────────────────────┘
         │
         v
    ┌──────────────────────────────────────────────────────────────────┐
    │  VERIFICATION                                                    │
    │  subagent: pev-verifier                                          │
    │  Input:  ATT_0_INTAKE.md + ATT_1_PLAN.md                        │
    │          + ATT_2_VERIFIER_BRIEF.md                               │
    │  Output: ATT_3_VERIFICATION.md + LATEST_VERIFICATION.md          │
    │  Independently checks every file and success criterion           │
    │  Must produce: VERDICT: PASS  or  VERDICT: FAIL                  │
    │  Validated with: validator.js VERIFIER VERIFICATION_REPORT       │
    └──────────────────────────────────────────────────────────────────┘
         │                    │
         │  PASS              │  FAIL
         v                    v
    ┌──────────┐    ┌──────────────────────┐
    │  DONE    │    │  RETRY (Route E)      │
    │  Loop    │    │  Orchestrator may run │
    │  ends    │    │  one more EXECUTE +   │
    │          │    │  VERIFY cycle with    │
    │          │    │  failure context      │
    └──────────┘    └──────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║          SPRINT MODIFICATIONS — What Changed (RUN_20260509-011600)           ║
╚══════════════════════════════════════════════════════════════════════════════╝

    ┌─────────────────────────────────────────────────────────────────────┐
    │  FILE                           │  CHANGE                            │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  extensions/git-checkpoint.ts   │  git add -A  →  git add -u         │
    │                                 │  (SC7: no untracked absorption)     │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  extensions/playwright-mcp.ts   │  %USERPROFILE%/...  →  homedir()  │
    │                                 │  (SC2: portable browser profiles)    │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  extensions/subagent.ts         │  a) resolveCliPath() — platform-   │
    │                                 │     aware (PI_CLI_PATH → win32      │
    │                                 │     branch → unix candidates)       │
    │                                 │  b) metadata field in tool results  │
    │                                 │  (SC1: portable / SC8: observable)   │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  extensions/graphify.ts         │  brainContextForCwd() now reads    │
    │                                 │  run-meta.json and gates injection  │
    │                                 │  on safeToInject + verifiedStatus    │
    │                                 │  (SC5 + SC6: memory safety)         │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  skills/nenflow-v3/SKILL.md     │  10× %USERPROFILE%/.pi/agent/     │
    │                                 │  nenflow-v3/ → ~/.pi/agent/         │
    │                                 │  nenflow-v3/ (SC3)                  │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  skills/nenflow-pev-executor/   │  4× %USERPROFILE%/nenflow_v3/     │
    │  SKILL.md                       │  → ~/.pi/agent/nenflow-v3/         │
    │                                 │  + underscore → hyphen fix (SC3)   │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  skills/nenflow-pev-planner/    │  Same as above (SC3)               │
    │  SKILL.md                       │                                    │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  skills/nenflow-pev-researcher/ │  Same as above (SC3)               │
    │  SKILL.md                       │                                    │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  skills/nenflow-pev-verifier/   │  Same as above (SC3)               │
    │  SKILL.md                       │                                    │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  prompts/pev.md                 │  1× %USERPROFILE%/.pi/agent/      │
    │                                 │  skills/nenflow-v3/SKILL.md →      │
    │                                 │  ~/.pi/agent/skills/nenflow-        │
    │                                 │  v3/SKILL.md (SC4)                  │
    ├─────────────────────────────────┼────────────────────────────────────┤
    │  prompts/nenflow_v3.md          │  Same as above (SC4)               │
    └─────────────────────────────────┴────────────────────────────────────┘

    GLOBAL GREP RESULT (post-sprint):
      grep -rn "%USERPROFILE%" extensions/ skills/ prompts/
      → 1 hit: extensions/nenflow-v3.ts:10 (comment only, not functional)


╔══════════════════════════════════════════════════════════════════════════════╗
║                         FUTURE IMPROVEMENT AREAS                             ║
║                    (deferred — need pi-core or more work)                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

    ┌─────────────────────────────────────────────────────────────────────┐
    │  AREA                          │  STATUS                            │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  Bash read-only enforcement    │  Needs pi-core: tool-call policy   │
    │  (research agents CAN write    │  engine + bash classifier.         │
    │   via shell commands)          │  Hard to make watertight.          │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  Subagent transcript logging   │  Metadata field added (SC8).       │
    │  (full JSONL, tool calls,      │  Full ledger needs extension to    │
    │   stdout, stderr per run)      │  runSubagent() to persist streams. │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  MCP progressive disclosure    │  Needs pi-core API: dynamic tool   │
    │  (/browser on/off)             │  registration/unregistration.      │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  Evidence-based verification   │  Validator checks format only.     │
    │  (PASS requires evidence)      │  Verifier skill already mandates   │
    │                                 │  independent evidence checks.      │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  Expanded destructive patterns │  confirm-destructive.ts covers the │
    │  (git reset --hard, curl|sh,   │  basics; expansion is low effort.  │
    │   chmod -R 777, npm publish)   │                                    │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  Secret scanning                │  No gitleaks/trufflehog in repo.  │
    │  (public repo protection)      │  auth.json is gitignored.          │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  Architecture wiki              │  Graphify already generates wiki  │
    │  (human-readable docs)         │  output; manual docs deferred.     │
    ├────────────────────────────────┼────────────────────────────────────┤
    │  Capability registry            │  Needs pi-core middleware.        │
    │  (central policy engine)       │  Current approach: config-based.   │
    └────────────────────────────────┴────────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║                              LEGEND                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

    ★  =  Modified or added in this hardening sprint (RUN_20260509-011600)
    →  =  Data flow direction
    ═  =  Layer boundary
    ─  =  Connection line
