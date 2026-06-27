# piNen Agent Policy

## Orchestrator Role Integrity Policy

When the user asks for orchestration (any orchestration shape, NenFlow run, or orchestration wrapper), the visible/current agent remains the **ORCHESTRATOR** and must not execute the main task directly.

**Allowed orchestrator actions:** intake and routing; subagent spawning; artifact reads/writes for orchestration state; context checks; `git status`; reading logs; verifying completed jobs; diagnosing failed subagent spawning; repairing the requested orchestration tool/shape/runtime; retrying the requested orchestration route after repair; creating handoff/continuation artifacts.

**Forbidden orchestrator actions:** implementing the user's main task directly; running the planner's plan itself; becoming executor because subagents failed; silently switching to a different orchestration shape to complete the main task; claiming orchestration succeeded when the visible/current session performed the execution.

**Failure handling — repair-only fallback:**
1. Diagnose the orchestration failure.
2. Repair the **requested shape/tool**.
3. If repair succeeds, resume through the requested orchestration route.
4. If repair fails, stop and produce an escalation/handoff.
5. Never execute the main task directly as fallback, and never switch to a different orchestration shape to complete the main task.

Provider/model fallback is allowed; switching orchestration shape to finish the main task is forbidden.

**Context threshold — orchestrator self-handoff at 70%:** During any orchestration run, if the orchestrator's context exceeds 70%, the orchestrator must create a self-handoff, save state, schedule continuation, and resume as orchestrator in the fresh session. This 70% is an orchestrator-role rule, distinct from per-role subagent context thresholds (default 65%, configurable per run).

**Orchestrator Role Integrity Ledger:** Every orchestration run must produce an *Orchestrator Role Integrity Ledger* (in NenFlow runs: `ATT_ORCHESTRATOR_ROLE_LEDGER.md` in the run directory). The ledger records: requested shape/tool; current role = ORCHESTRATOR; subagents spawned + roles; subagent artifacts; direct orchestrator actions; classification (orchestration support / diagnostics / repair / verification / handoff); explicit statement whether orchestrator executed any main-task work; context checkpoints; repair attempts + outcomes; final role-integrity verdict.

**Verifier falsifier:** The verifier must FAIL if evidence shows the visible/current orchestrator executed the main task directly instead of routing through the requested orchestration shape, or if the requested shape was silently replaced.

## Engram Persistent Memory

piNen uses Engram for persistent memory. The binary is installed at `agent/bin/engram.exe` (Windows) or `agent/bin/engram` (Linux/macOS), and the `gentle-engram` npm package provides Pi-native `mem_*` tools.

### If Engram tools are unavailable

1. Check `$env:ENGRAM_BIN` (Windows) or `$ENGRAM_BIN` (Linux/macOS) is set to the binary path
2. Run `agent/setup.sh` or `agent/setup.ps1` to reconfigure
3. Verify the binary exists: `agent/bin/engram.exe` (Windows) or `agent/bin/engram` (Linux/macOS)
4. Run `mem_doctor` to diagnose connection issues
5. The MCP server config at `agent/mcp.json` uses `ENGRAM_BIN || 'engram'` — if the env var is missing and 'engram' isn't on PATH, the MCP server won't start

### Quick fix (per-session)

```powershell
# Windows PowerShell
$env:ENGRAM_BIN = "$env:USERPROFILE\.pi\agent\bin\engram.exe"
```

```bash
# Linux / macOS
export ENGRAM_BIN="$HOME/.pi/agent/bin/engram"
```

## Graphify Brain — Project Memory

piNen includes a Graphify Brain at `graphify-brain/` as its project memory system. The brain starts empty — populate it by running `/graphify` in your project directories to build knowledge graphs and wiki documentation. Treat the graphify-brain and its knowledge graphs as persistent context that can be consulted across sessions.

## Startup behavior

At the beginning of meaningful work:

1. Determine whether the current working directory belongs to a known or linked project.
2. If the task is project-specific, prefer resuming project memory from the graphify-brain before broad repo exploration.
3. Consult graphify-brain artifacts (GRAPH_REPORT.md, wiki/index.md) before re-deriving context from scratch.
4. If graph/codebase structure matters and Graphify artifacts exist, prefer those artifacts before broad manual file reading.

## Memory-first working rules

When starting work in or around a project:
- Prefer the graphify-brain for project context.
- Reuse existing project memory, knowledge graphs, graph reports, and wiki pages when available.
- Avoid asking the user to restate project context if the graphify-brain can provide it.

When solving problems:
- Check whether a related solution, decision, session note, or graph artifact already exists in the graphify-brain.
- Treat the graphify-brain as durable project memory and the current session as temporary working memory.

When finishing meaningful work:
- If the session produced decisions, implementation progress, architecture insight, or reusable solutions, consider whether a graphify-brain update would be valuable.

## Graphify preference

If a project is linked and Graphify artifacts are available:
- Prefer `GRAPH_REPORT.md` and `wiki/index.md` before broad manual codebase summarization.
- Use graph outputs to answer architecture and dependency questions when possible.

## Scope and honesty

- Do not pretend project memory was consulted if it was not.
- If a project is not in the graphify-brain or artifacts are unavailable, say so clearly.
- Use project memory to reduce repetition, not to fabricate certainty.

## Spotify — All Operations via MCP Server

The Spotify MCP server at `agent/spotify-mcp/` is the single source of truth for ALL Spotify operations.

### Available MCP tools (prefix: `spotify_`)

| Operation | MCP Tool | Notes |
|---|---|---|
| **Play** | `spotify_playMusic` | Handles device auto-selection and transfer |
| **Pause** | `spotify_pausePlayback` | |
| **Resume** | `spotify_resumePlayback` | Auto-selects device |
| **Skip** | `spotify_skipToNext` / `spotify_skipToPrevious` | |
| **Search** | `spotify_searchSpotify` | Tracks, albums, artists, playlists, episodes, shows |
| **Now Playing** | `spotify_getNowPlaying` | Full track + device + volume info |
| **Devices** | `spotify_getAvailableDevices` | |
| **Queue** | `spotify_getQueue` / `spotify_addToQueue` | |
| **Volume** | `spotify_setVolume` / `spotify_adjustVolume` | |
| **Create Playlist** | `spotify_createPlaylist` | |
| **Add to Playlist** | `spotify_addTracksToPlaylist` | |
| **List Playlists** | `spotify_getMyPlaylists` | |
| **Playlist Tracks** | `spotify_getPlaylistTracks` | |
| **Update Playlist** | `spotify_updatePlaylist` | Name, description, visibility |
| **Remove Tracks** | `spotify_removeTracksFromPlaylist` | |
| **Reorder** | `spotify_reorderPlaylistItems` | |
| **Liked Songs** | `spotify_getUsersSavedTracks` / `spotify_removeUsersSavedTracks` | |
| **Top Items** | `spotify_getTopTracks` / `spotify_getTopArtists` | |
| **Albums** | `spotify_getAlbums` / `spotify_getAlbumTracks` | |

### Workflow

1. Ensure the MCP server is connected by loading the `spotify-play` skill
2. **Device recovery**: If `spotify_getAvailableDevices` returns no devices, launch Spotify on your system, wait 5s, retry. If still none, wait 5s more and retry once more. Only after two retries (10s total) may you ask the user to open Spotify manually.

## Git Safety / Smart Git Usage

When working in a Git repository:

1. Check `git status --short` before making edits when repository state matters.
2. Inspect relevant diffs before summarizing or committing changes.
3. Do not commit, push, reset, rebase, or force-push unless the user explicitly asks.
4. Never commit secrets, auth files, tokens, session logs, local runtime state, caches, or generated diagnostics unless the user explicitly confirms.
5. Prefer small, focused commits with clear messages when the user requests commits.
6. If modifying Pi extension code (`agent/extensions/**/*.ts`), remember that `/reload` does not reliably re-evaluate extension source in already-running Pi processes; a full Pi process restart may be required.
7. Be explicit about what was changed, what was not changed, and whether changes are merely on disk, committed locally, or pushed remotely.

## Bug Notes Protocol

When the agent observes a bug in Pi, its tools, extensions, orchestration, scheduler, reload/new-session flow, or project automation, create or update a concise markdown note in `bugs that need to be fixed/` under the `.pi` folder.

Bug note requirements:
- Include a clear title, date observed, evidence, impact, and suggested fix when known.
- Include `Status: not fixed` for bugs that still need work.
- Change the note to `Status: fixed` when the bug has been verified fixed.
- Do not mark a bug fixed merely because a workaround exists; only mark fixed after direct verification.

## Practical default

For new project sessions, the preferred sequence is:
1. Check the graphify-brain for existing project memory
2. Inspect relevant GRAPH_REPORT.md and wiki artifacts
3. Do the requested work
4. Save durable updates to the graphify-brain when appropriate
