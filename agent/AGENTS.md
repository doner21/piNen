# piNen Agent Policy

## How work gets done (build-first policy, 2026-07-22)

piNen prioritizes real build work over process. The old Orchestrator Role Integrity Policy (role ledgers, pin maps, mandatory predicted-write-set paperwork, GATE_DEFECT verdicts, contract hygiene rules, mandatory subagent routing) is retired — it produced paperwork loops instead of product. The rules are now:

1. **Two modes, picked by the user's words.**
   - **Direct mode (default):** the current agent builds, fixes, and tests the user's task itself.
   - **Orchestration mode:** when the user asks to orchestrate, run an orchestration, or says "orchestration work" — go into orchestration mode (see the section below). Treat any explicit orchestration request as a normal supported mode, not an exception.
2. **Definition of done = the real test.** Intermediate engineering tasks close autonomously with agent-run machine checks and coherent tested changes (plus commits when authorized). Batch user sensory review only at substantial integrated build-room or slice boundaries, when there is a physical artifact the user can run, hear, or measure; give them a short test card (what to do, what should happen, what failure looks like). No closeout documents, ledgers, receipts, or evidence folders.
3. **Machine validation is agent-owned.** Run and interpret tests, logs, JSON, hashes, captures, and other machine-readable output; never delegate their inspection to the human. Report honestly and plainly: say what changed, what ran, what was observed, and what's unverified, without contract/legal phrasing or "no-credit" or "authorization boundary" language.
4. **A failing check gets fixed, not processed.** If a test correctly fails, fix the product. If the check itself is wrong or obsolete, fix or delete the check in the same run and say so in the commit message. Never leave a red check "documented around," and never build new gates around a broken one.
5. **If context runs low**, finish the current step and persist a short handoff (what's done, what's next, key paths). When continuation tooling is available, schedule and trigger a fresh session and resume autonomously; report an infrastructure failure only if autonomous continuation is unavailable.

## Orchestration mode (when the user asks for it)

When the user requests orchestration, use the deterministic `/orchestrate` command (`~/.pi/pi-orchestrator-extension`) as the standard shape. In this mode:

1. **The current agent coordinates; subagents do the work.** Run intake, spawn the planner/executor/verifier subagents, pass artifacts between them, and report the result. Don't quietly do the main task yourself while claiming it was orchestrated — if you end up doing it directly, say so plainly.
2. **Keep the machinery, drop the paperwork.** Use `/orchestrate`'s own built-in gates as they are. Do not add role-integrity ledgers, pin maps, satisfiability statements, closeout documents, or any run paperwork beyond what the tool itself produces.
3. **When a run fails:** repair the specific defect (in the product or orchestration tool) and re-run autonomously. While there is material progress, continue through multiple build/fix/test cycles using materially different approaches, independent diagnosis or subagents, model/provider fallback where useful, and reversible scope reduction. Attempts and elapsed time are not human checkpoints. Involve the human only for a sensory-ready integrated build, a material subjective scope/design choice, an irreversible or destructive action, unavailable credentials or hardware, or sustained no-progress that requires a concrete scope-backout decision.
4. **The finish line is the same as direct mode:** a real test passing or a physical artifact the user can run, hear, or measure — plus a plain-language summary of what the run did.

> **NenFlow v3 and PEV loops are retired (2026-07-18).** Do not run NenFlow, spawn `pev-*` subagents, or read nenflow prompts/health files. If a NenFlow run is requested, route it to `/orchestrate`. See `agent/docs/nenflow-v3-retirement.md`.

## Engram Persistent Memory

This Pi installation uses Engram for persistent memory. The installer places the binary at `agent/bin/engram.exe` on Windows (or `agent/bin/engram` on Unix), and the `gentle-engram` npm package provides Pi-native `mem_*` tools.

### If Engram tools are unavailable

1. Check `$env:ENGRAM_BIN` (Windows) or `$ENGRAM_BIN` (Linux/macOS) is set to the binary path
2. Run `agent/setup.sh` or `agent/setup.ps1` to reconfigure
3. Verify the binary exists: `agent/bin/engram.exe` (Windows) or `agent/bin/engram` (Linux/macOS)
4. Run `mem_doctor` to diagnose connection issues
5. The MCP server config at `agent/mcp.json` uses `ENGRAM_BIN || 'engram'` — if the env var is missing
   and 'engram' isn't on PATH, the MCP server won't start

### Quick fix (per-session)

```powershell
# Windows PowerShell
$env:ENGRAM_BIN = "$env:USERPROFILE\.pi\agent\bin\engram.exe"
```

```bash
# Linux / macOS
export ENGRAM_BIN="$HOME/.pi/agent/bin/engram"
```

### Persistent-memory protocol

Use Engram as durable working memory, not as a dump of transient output.

Save immediately after completing a bug fix, making an architecture/design decision, discovering a non-obvious codebase fact, changing configuration/environment setup, establishing a reusable pattern, or learning a user preference/constraint.

Use `mem_save` with a short searchable title, an appropriate type (`bugfix`, `decision`, `architecture`, `discovery`, `pattern`, `config`, or `preference`), project/personal scope, and a stable `topic_key` where the fact may evolve. Structure content as:

- **What**: what changed or was learned
- **Why**: motivation
- **Where**: relevant files/paths
- **Learned**: edge cases and gotchas

When recalling prior work, call `mem_context` first, then `mem_search` and `mem_get_observation` if needed. Before declaring meaningful work complete, save a `mem_session_summary` with Goal, Instructions, Discoveries, Accomplished, Next Steps, and Relevant Files. After context compaction, restore project memory before continuing.

Never commit or publish Engram databases, observations, session summaries, saved prompts, or health traces.

## Graphify Brain is first-class project memory context

This Pi installation uses the Graphify Brain at `~/.pi/graphify-brain` as its global project memory system.
Treat the graphify-brain and its knowledge graphs as persistent context that should be consulted in every substantive session.

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

The Spotify MCP server at `~/.pi/agent/spotify-mcp` is the single source of truth for ALL Spotify operations. Do not use the built-in `spotify_*` Pi tools — they lack playlist management and use a separate token system.

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

1. Ensure the MCP server is connected: `mcp({ connect: "spotify" })`
2. For playback requests, load and consult the `spotify-play` skill
3. **Device recovery**: If `spotify_getAvailableDevices` returns no devices, launch Spotify (`powershell -Command "Start-Process 'spotify:'"` on Windows), wait 5s, retry. If still none, wait 5s more and retry once more. Only after two retries (10s total) may you ask the user to open Spotify manually.

## Git Safety / Smart Git Usage

When working in a Git repository:

1. Check `git status --short` before making edits when repository state matters.
2. Inspect relevant diffs before summarizing or committing changes.
3. Do not commit, push, reset, rebase, or force-push unless the user explicitly asks.

   **Project-local override:** A project's own `AGENTS.md` takes precedence over rules 3–4 of this section for work within that project's repository. When a project AGENTS.md grants standing authorization for commits or other Git operations within its repo scope, that authorization governs; the global default restriction does not apply.

4. Never commit secrets, auth files, tokens, session logs, local runtime state, caches, or generated diagnostics unless the user explicitly confirms.
5. Prefer small, focused commits with clear messages when the user requests commits.
6. If modifying Pi extension code (`agent/extensions/**/*.ts`), remember that `/reload` does not reliably re-evaluate extension source in already-running Pi processes; a full Pi process restart may be required.
7. Be explicit about what was changed, what was not changed, and whether changes are merely on disk, committed locally, or pushed remotely.

## Automated Git Backup Policy

When explicitly enabled and configured by the user, the deterministic `git-backup` extension may create and push **isolated backup refs only**. This policy does not itself grant authorization, and isolated-backup authorization never permits agents to commit to, merge, rebase, reset, force-push, or push the working branch without a separate explicit request.

The project-local override described in § Git Safety / Smart Git Usage applies here as well: a project AGENTS.md may grant standing authorization for working-branch operations within that project's scope.

### Required backup model

1. Local rollback protection and off-machine backup are different states:
   - `local-snapshot` means an isolated `refs/pi-backups/...` commit exists locally.
   - `remote-verified` means the dedicated `pi-backup/...` remote branch was pushed and `ls-remote` independently matched the local snapshot commit.
2. Routine automation must use the `git_backup` tool or `/git-backup`; do not reproduce it with manual `git add`, `git commit`, or `git push` commands.
3. Backup snapshots must not mutate the working branch, real index, working tree, tags, or normal release branches.
4. Remote automation may use only an already-configured approved remote under the `existing-origin-only` policy. It must never create a repository, add/change a remote, change repository visibility, or force-push.
5. Secret scanning, protected-path checks, embedded-repository checks, changed-file limits, and object-size limits are hard gates. Do not bypass them merely to obtain a green backup result.
6. New/untracked source files should be included only when they are not ignored or protected and all safety gates pass.
7. Graphify maintenance and Git backups should coordinate but remain independent: successful Graphify completion should request a backup, while Graphify pause/failure must never prevent ordinary backup scheduling.
8. Mark backup needed after meaningful project changes. Before saying work is "backed up," call `git_backup` with `action=status` when available and report the exact state honestly.
9. If backup is blocked or fails, preserve the local work, report the reason and blocked paths without exposing secret contents, and never claim remote protection.
10. Repositories without an approved existing remote receive local snapshots only; creating or selecting a remote remains a separate user-authorized action.

### Expected automatic boundaries

The extension schedules debounced backups after meaningful tool mutations and `agent_settled`, performs startup/shutdown catch-up, and listens for Graphify completion events. These boundaries replace the retired behavior that created a working-branch commit before every edit.

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
