# Autonomous Graphify Runs — Intake

## Original prompt

> The graphify gate is not working very well. I want to pause it. I want intelligent graphify runs that are autonomous: the agent can decide to run graphify based on clear instructions from AGENTS.md and other applied context engineering. I do not want to manually remember to graphify ongoing work. Graphify should be continually updated, run on cheap models like DeepSeek V4 Flash where possible, and have sub-agent activity take over graphify output production. It must not slow down normal work too much; perhaps it can schedule itself after every run completes, but we need an ongoing way to graphify our output. Write an intake.md to clarify constraints and intent, and get Opus 4.8 to create a plan that GPT 5.5 Codex can execute.

## Task statement

Design and implement a Pi-local autonomous graphify maintenance workflow that replaces the current hard "Graphify gate" with a pauseable, low-friction, intelligent update system. The system should keep project `graphify-out/` artifacts and the global graphify brain fresh during ongoing agent work without requiring the human to manually run `/graphify` after every meaningful change.

## Current pain / reason for change

- The current Graphify enforcement gate blocks exploratory reads/bash until a `graphify-out/` artifact is read.
- This is useful in principle, but too blunt during active development: it interrupts flow, can point at a missing wiki `_INDEX.md`, and does not itself make the graph fresher.
- The desired replacement is not "never use graphify"; it is "pause hard blocking and make graphify upkeep autonomous, scheduled, cheap, and context-aware."

## Primary users

- The human user, who wants graphify freshness without babysitting it.
- The active Pi agent, which should decide when graphify upkeep is warranted.
- Background/sub-agent graphify workers that can produce reports/wiki/brain updates without consuming the main session.

## Core use cases

1. **Pause hard gate**: Disable or soften the current blocking Graphify gate so normal development is not interrupted by mandatory graph reads.
2. **Detect meaningful changes**: Notice when an agent run produced file mutations, decisions, bug fixes, architecture changes, or new docs that should update the graph.
3. **Cheap code-only updates**: For code-only changes, prefer deterministic graphify incremental/AST updates with no LLM spend.
4. **Cheap semantic updates**: For docs, plans, intakes, session notes, or human wiki generation, route semantic work to inexpensive models by default, especially DeepSeek V4 Flash.
5. **Scheduled post-run upkeep**: Do not run graphify inline during critical user work unless explicitly requested. Schedule a follow-up after the agent is idle or after a short debounce window.
6. **Sub-agent production**: Delegate graphify output production (semantic extraction, community labels, wiki narratives, verification summaries) to subagents rather than the main agent when practical.
7. **Context-engineered autonomy**: Encode clear run criteria in AGENTS.md / a graphify autonomy config so future agents know when to schedule, skip, or force graphify.
8. **Brain persistence**: After successful graphify runs, save/sync outputs into the global Graphify Brain so future sessions can consult fresh artifacts.
9. **Visibility without noise**: Show concise status and failure notices; avoid long graph output dumps unless the user asks.

## Invariants

- **Do not slow down normal work.** Graphify upkeep must default to deferred/scheduled execution, not inline blocking during implementation.
- **Do not repeatedly schedule infinite loops.** Every autonomous run needs a lock, debounce, run reason, and cooldown.
- **No silent expensive runs.** Full semantic/deep graphify runs require a clear trigger and should report model/cost intent.
- **Use cheap models by default.** DeepSeek V4 Flash should be the default semantic/subagent model unless the user overrides it or the task requires a stronger model.
- **Prefer incremental updates.** Full rebuilds should be rare; use `graphify update .`, code-only AST paths, watcher flags, or changed-file manifests where possible.
- **Respect sensitive files.** Must not graphify secrets, credentials, node_modules, caches, build artifacts, or other ignored/sensitive paths. Follow graphify detection and `.gitignore` behavior.
- **Human remains in control.** Provide `/graphify-auto pause|resume|disable|status|run-now` and a config switch. Manual `/graphify` remains available.
- **Freshness is advisory, not a hard gate.** Agents should be nudged by context and status, not blocked by brittle tool-call interception.
- **Crash/reload safe.** State, locks, and scheduled wakeups must survive Pi reloads and not corrupt `agent/scheduler.json`.
- **No scheduler regression.** If using `agent_scheduler`, do not modify scheduler internals unless explicitly required; treat it as an external capability.

## Proposed artifact locations

- Intake artifact: `agent/extensions/autonomous-graphify/intake.md` (this file)
- Extension implementation: `agent/extensions/autonomous-graphify/index.ts`
- Runtime/state directory: `agent/graphify-autonomy/`
  - `config.json` — global defaults and model routes
  - `state.json` — last run, pending reason, cooldown, lock owner, failure count
  - `run-log.jsonl` — concise autonomous run audit trail
  - `lock` — advisory lock for one graphify run at a time
- Optional project-local policy: `.graphify-agent.md` or a section in `AGENTS.md`
- Optional subagents:
  - `agent/agents/graphify-autonomy-planner.json`
  - `agent/agents/graphify-autonomy-runner.json`
  - `agent/agents/graphify-autonomy-verifier.json`

## Public API candidates

### Slash command: `/graphify-auto`

Subcommands:

- `status` — show enabled/paused state, graph freshness, pending scheduled work, last run, last failure, and model defaults.
- `pause [reason]` — pause autonomous graphify upkeep; manual `/graphify` still works.
- `resume` — resume autonomous scheduling.
- `enable` / `disable` — persistent global toggle.
- `run-now [--cheap|--full|--code-only|--semantic] [path]` — manually request an autonomous-style run.
- `mark-needed [reason]` — mark graphify as needed without immediately running it.
- `config` — print/edit safe non-secret config.
- `gate off|soft|strict` — control the old Graphify gate behavior if kept in the existing graphify extension.

### LLM tool: `graphify_auto`

Actions:

- `status`
- `mark_needed`
- `schedule`
- `run_now`
- `pause`
- `resume`

The tool should not expose secrets. If it schedules a wake-up, the future prompt must be explicit and scoped, e.g. "Run autonomous graphify maintenance for CWD because files changed in this session; prefer code-only incremental update if possible."

## Trigger policy for autonomous decisions

Schedule a graphify maintenance check when any of these are true:

- The agent edited/wrote/deleted project files outside ignored directories.
- A session produced a bug fix, architecture decision, intake, plan, skill, extension, or reusable docs.
- `graphify-out/.needs_update` or `graphify-out/needs_update` exists.
- Git HEAD differs from the commit recorded in `GRAPH_REPORT.md`.
- More than N significant file changes occurred since last graphify run.
- The user asks an architecture/codebase question and the graph is stale.
- Before session close, if meaningful work occurred and no graphify run is pending.

Skip or defer when:

- Autonomous graphify is paused/disabled.
- A graphify run completed recently and no new meaningful changes are detected.
- Only scheduler/log/temp/cache files changed.
- The active task is latency-sensitive and the user did not ask for graph updates.
- Another graphify run is locked/running.

## Model / subagent defaults

- Planning for this implementation: Claude Opus 4.8.
- Execution target: GPT 5.5 Codex.
- Runtime autonomous graphify semantic/default worker: DeepSeek V4 Flash.
- Verification can use DeepSeek V4 Pro or GPT 5.5 depending on cost/strictness.
- The implementation should make model routing configurable, not hard-coded.

## Implementation shape assumptions

- A Pi extension can observe `tool_result`, `agent_end`, `session_shutdown`, and possibly `before_agent_start` to detect mutations and inject status/context.
- Background resources must start on `session_start` and clean up on `session_shutdown`.
- The extension should use status/context injection to advise the agent rather than hard-blocking tool calls.
- If using a background child process for graphify, it must be cancellable and logged.
- If using `agent_scheduler`, schedule after the current turn instead of recursively running immediately.
- For code-only changes, direct graphify incremental update should be attempted before any LLM subagent.
- For semantic/wiki output, subagent prompts should be narrow, cheap-model-friendly, and artifact-based.

## Success criteria

- The existing hard graphify gate can be paused or made advisory without deleting Graphify Brain functionality.
- Agents receive clear context about graph freshness and autonomous update policy.
- Meaningful file-changing sessions result in at most one debounced pending graphify maintenance check.
- Code-only changes can update graph artifacts without LLM semantic spend.
- Docs/intake/session-note changes can trigger cheap semantic/subagent graphify output production.
- Status/commands/tools expose what happened and why.
- No infinite scheduling loop occurs.
- No scheduler files are corrupted.
- No secrets or ignored build artifacts are graphified.
- A GPT 5.5 Codex executor can implement from the plan without needing to re-infer the product intent.

## Non-goals for first version

- Always-on OS daemon that runs when Pi is closed.
- Perfect semantic extraction for every changed document.
- Replacing the manual `/graphify` command.
- Running full deep graphify after every edit.
- Cloud deployment or shared multi-machine graph synchronization.
- Rewriting graphify itself unless a small CLI affordance is clearly needed.

## Open questions for planner

1. Should the old gate live inside `agent/extensions/graphify.ts` with a configurable mode, or should a new `autonomous-graphify` extension supersede it?
2. Should autonomous runs be launched directly by the extension, by `agent_scheduler` wake-up prompts, or by a dedicated subagent tool/command?
3. What is the safest way to detect actual file mutations from Pi tool results without parsing fragile text output?
4. How should project-local AGENTS.md instructions be updated so future agents understand the new policy?
5. What should the minimum viable first phase be: pause gate + status + mark-needed, or full scheduled run loop?
6. How should failures be surfaced without annoying the user on every turn?
