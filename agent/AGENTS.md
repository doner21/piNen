# Global Pi Agent Policy

## How work gets done (build-first policy, 2026-07-22)

The owner's priority is real build work, not process. The old Orchestrator Role Integrity Policy (role ledgers, pin maps, predicted write sets, GATE_DEFECT verdicts, contract hygiene rules, mandatory subagent routing) is retired — it produced paperwork loops instead of product. The rules are now:

1. **Two modes, picked by the user's words.**
   - **Direct mode (default):** the current agent builds, fixes, and tests the user's task itself.
   - **Orchestration mode:** when the user asks to orchestrate, run an orchestration, or says "orchestration work" — go into orchestration mode (see the section below). Most of this owner's work is orchestration work, so treat any explicit orchestration request as normal, not exceptional.
2. **Definition of done = the real test.** Intermediate engineering tasks close autonomously with agent-run machine checks and coherent commits. Batch human sensory review only at substantial integrated build-room or slice boundaries, when there is a physical artifact the owner can run, hear, or measure; give them a short test card (what to do, what should happen, what failure looks like). No closeout documents, ledgers, receipts, or evidence folders.
3. **Machine validation is agent-owned.** Run and interpret tests, logs, JSON, hashes, captures, and other machine-readable output; never delegate their inspection to the human. Report honestly and plainly: say what changed, what ran, what was observed, and what's unverified, without contract/legal phrasing or "no-credit" or "authorization boundary" language.
4. **A failing check gets fixed, not processed.** If a test correctly fails, fix the product. If the check itself is wrong or obsolete, fix or delete the check in the same run and say so in the commit message. Never leave a red check "documented around," and never build new gates around a broken one.
5. **If context runs low**, finish the current step and persist a short handoff (what's done, what's next, key paths). When continuation tooling is available, schedule and trigger a fresh session and resume autonomously; report an infrastructure failure only if autonomous continuation is unavailable.

## Lean working method (standing method since 2026-10-06)

Full text and reasons: `C:/Users/you/.pi/agent/docs/lean-working-method.md`. Read it before planning or briefing any multi-step or orchestrated work. Dropping the paperwork and keeping the safety rules let item 3 commit in hours after three weeks of runs; heavy rules made models literal and stalled them. The core:

- **Hard lines, never bent:**
  - Protected code needs the owner's named permission: the native folders (`experiments/phase0/parallel-crossfade/`, `tools/phase1/native/`, native parts of `tools/stage6/`, their build files) and live hardware windows. TypeScript that talks to the native host is ordinary code. An approved brief is permission to build everything else in it; a question never stops the run. Full page: `agent/docs/standing-permissions.md`.
  - Owner data and working builds stay untouched; work in separate copies.
  - Never force-kill what you did not start. You may stop your own test or worker process after 30 minutes of silence while it blocks its parent; say so afterwards.
  - Add no timers, deadlines, sleeps, signals or exits to product code, tests or launch arguments. A null timeout field placed by a tool schema is not a timer.
  - Use the owner's named models per role, with no substitution.
  - Only the coordinator commits, and only after the review passes. Never push without the owner's word.
  - At each milestone end, after the owner's listening pass and the review, the coordinator pushes the milestone branch and opens one pull request into the main branch with a short plain description; it never merges it. Lane merges in between stay local.
  - Never be idle silently: if nothing is running and you are blocked, message the owner once with the decision you need, and remind every two hours.
- **Proof:**
  - a test that fails before the fix and passes after it, re-run by the reviewer. Writing that test, fixtures included, is capped at two hours per fix; past the cap, use the cheapest existing machine check and put the behaviour on the owner's next listening card (safety checks the owner cannot hear are exempt);
  - faults the owner can hear or see are confirmed by listening first: send the card as soon as the fix builds and the agent's own check (measuring what the owner hears, not a theory) passes, with no reviewer in between; protected code, STOP, swap and identity checks are still reviewed first;
  - after a failed listening card, or a review showing a fix does not work, run a blind read-only planner before the next repair: it gets the owner's symptom words and the source only, never earlier diagnoses or fix history, traces the whole chain and names the production path the test must include;
  - one fresh independent review per milestone boundary, plus an extra one only for protected code or on request;
  - the owner's real-use test card;
  - one known-limitations list, approved once.
- **Dropped:** chronology audits, timing proofs, reading statements, hash and pin ledgers, receipts, evidence folders, per-batch reviews and release tasks, whole-tree re-verification every step.
- **Judgement:**
  - Apply each rule's reason, not its letter.
  - Replace an invented check that is impossible or out of proportion with the simplest check that protects the real rule, and note it in the handoff.
  - A disputed verdict is not a stop: a FAIL contradicted by the reviewer's own evidence or the coordinator's direct observation gets the missing evidence and a rerun of the review, and stops only if the rerun still fails. Never write "FAIL for missing proof" into a brief. The coordinator notes its outside observations in the run folder before the reviewer starts. Replace a days-old coordinator session at the next milestone.
  - Set a cutoff and a fallback for exploratory steps.
  - Stop for the owner only for what is genuinely theirs.
- **Long work runs headless:**
  - Run long commands in the background, not as blocking calls.
  - Build in headless workers.
  - Wrap `/orchestrate` in a headless pi process; the coordinator checks its files every 10 to 15 minutes and forwards alarms.
  - Never let the orchestrator edit its own running copy.
- **Rule hygiene:**
  - Every new rule names the incident it prevents.
  - Delete rules that catch nothing.
  - Fix a rule that causes a false failure rather than adding another.
  - Keep briefs short and plain.

## Orchestration mode (when the user asks for it)

When the user requests orchestration, use the deterministic `/orchestrate` command (`~/.pi/pi-orchestrator-extension`) as the standard shape. In this mode:

1. **The current agent coordinates; subagents do the work.** Run intake, spawn the planner/executor/verifier subagents, pass artifacts between them, and report the result. Don't quietly do the main task yourself while claiming it was orchestrated — if you end up doing it directly, say so plainly.
2. **Keep the machinery, drop the paperwork.** Use `/orchestrate`'s own built-in gates as they are. Do not add role-integrity ledgers, pin maps, satisfiability statements, closeout documents, or any run paperwork beyond what the tool itself produces.
3. **When a run fails:** repair the specific defect (in the product or orchestration tool) and re-run autonomously. While there is material progress, continue through multiple build/fix/test cycles using materially different approaches, independent diagnosis or subagents, model/provider fallback where useful, and reversible scope reduction. Attempts and elapsed time are not human checkpoints. Involve the human only for a sensory-ready integrated build, a material subjective scope/design choice, an irreversible or destructive action, unavailable credentials or hardware, or sustained no-progress that requires a concrete scope-backout decision.
4. **The finish line is the same as direct mode:** a real test passing or a physical artifact the owner can run, hear, or measure — plus a plain-language summary of what the run did.

> **NenFlow v3 and PEV loops are retired (2026-07-18).** Do not run NenFlow, spawn `pev-*` subagents, or read nenflow prompts/health files. If a NenFlow run is requested, route it to `/orchestrate`. See `agent/docs/nenflow-v3-retirement.md`.


## Engram Persistent Memory

This Pi installation uses Engram for persistent memory. The binary ships at `agent/bin/engram.exe`
and the `gentle-engram` npm package provides Pi-native `mem_*` tools.

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

## Graphify Brain is first-class project memory context

This Pi installation uses the Graphify Brain at `C:\Users\you\.pi\graphify-brain` as its global project memory system.
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

The Spotify MCP server at `C:/Users/you/.pi/agent/spotify-mcp` is the single source of truth for ALL Spotify operations. Do not use the built-in `spotify_*` Pi tools — they lack playlist management and use a separate token system.

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

   **Project-local override:** A project's own `AGENTS.md` (e.g., `C:/Users/you/my-project/AGENTS.md`) takes precedence over rules 3–4 of this section for work within that project's repository. When a project AGENTS.md grants standing authorization for commits or other Git operations within its repo scope, that authorization governs; the global default restriction does not apply.

4. Never commit secrets, auth files, tokens, session logs, local runtime state, caches, or generated diagnostics unless the user explicitly confirms.
5. Prefer small, focused commits with clear messages when the user requests commits.
6. After modifying global Pi extension source (`agent/extensions/**/*.ts`), use `/reload` to rebuild the extension runtime. A full restart may still be required for already-imported Pi core modules or stale package-extension modules.
7. On Pi 0.84.2+, agent reload/new-session bridges use `pi.sendUserMessage(..., { expandPromptTemplates: true })` from a stable-idle poll. Do not require the legacy `pi.executeCommand` core patch: Pi 0.84.3+ launches `dist/bundle/cli.js`, while that patch only touched `dist/core/*`.
8. Be explicit about what was changed, what was not changed, and whether changes are merely on disk, committed locally, or pushed remotely.

## Automated Git Backup Policy

The user has granted standing authorization for the deterministic `git-backup` extension to create and push **isolated backup refs only**. This authorization does not permit agents to commit to, merge, rebase, reset, force-push, or push the working branch without a separate explicit request.

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
