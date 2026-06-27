# Agent Scheduler Extension Intake

## Original prompt

> I need to be able to give agents schedulers. So for instance, if you were waiting for a download to finish we didn't need to actually be active as an agent. You should be able to create a scheduler, schedules in a countdown for when you should come back online to check if the download is finished. This could be anything that requires you to be switched off and at some later date or time to be put back on again. For instance, you may decide you want to run a headless agent to do some work, but you might decide that you need to schedule an estimated time to check if the agent has finished. The intent here is to create a scheduling extension that any agent can call upon to instantiate them back into action after they have switched themselves off. The user may decide to use this scheduling extension to turn an agent on to do specific tasks at certain times.

## Task statement

Create a Pi extension that lets agents schedule future wake-ups. A wake-up should be able to re-inject a user message into Pi after a relative countdown or absolute date/time so the agent can resume with a concrete task, such as checking a download or a headless subagent status.

## Primary users

- The active LLM agent, via an LLM-callable tool.
- The human user, via slash commands.
- Future automation workflows that need delayed agent activation.

## Core use cases

1. **Countdown wake-up**: Agent schedules itself to return in N seconds/minutes/hours/days with a prompt like "Check whether download X is done".
2. **Absolute wake-up**: User or agent schedules a task for a specific ISO/local time.
3. **List schedules**: Agent/user can inspect pending/completed/cancelled schedules.
4. **Cancel schedules**: Agent/user can cancel an unneeded wake-up.
5. **Persistence across reloads/restarts**: Schedules should survive extension reloads and Pi restarts as long as Pi is later opened again.
6. **Safe offline behavior**: If Pi is closed when a schedule becomes due, the extension should trigger it on next session start and clearly mark it as overdue.

## Invariants

- The extension must not start timers in the factory; timers must be session-scoped and cleaned up on `session_shutdown`.
- The tool must never silently create an immediate infinite loop; schedules due at or before now should be nudged to a small minimum delay or require an explicit immediate action policy.
- Scheduled messages must be explicit user messages (via `pi.sendUserMessage`) so they trigger agent turns when Pi is running.
- Schedules must be persisted outside transient in-memory state.
- Cancelling a schedule must prevent future triggering.
- A triggered schedule should not trigger repeatedly after completion.
- The implementation must work without UI in JSON/print/RPC contexts, with UI notifications only when available.

## Design constraints from Pi docs

- Extension background resources should be started on `session_start` or from commands/tools, not in the extension factory.
- `session_shutdown` should clear timers/resources.
- Tools get `ExtensionContext`, not `ExtensionCommandContext`, so tools cannot call session-switching/reload APIs directly.
- `pi.sendUserMessage(content, { deliverAs })` can inject a future user turn. If the agent is busy when a timer fires, use `followUp` to avoid interrupting active work.
- Extension state can be persisted with custom session entries, but cross-session/global scheduling is better served by a JSON state file under the Pi agent directory.

## Proposed artifact location

- Extension implementation: `agent/extensions/agent-scheduler/index.ts`
- Persistent store: `agent/scheduler.json` (computed with `getAgentDir()` at runtime)
- Intake artifact: `agent/extensions/agent-scheduler/intake.md`

## Public API candidates

### Tool: `agent_scheduler`

Actions:
- `schedule`: create a future wake-up.
- `list`: list schedules.
- `cancel`: cancel a pending schedule.
- `get`: inspect one schedule.

Schedule inputs:
- `message`: the future user prompt to send.
- `delaySeconds` or `delayMinutes`: relative countdown.
- `at`: absolute time, preferably ISO 8601; local parse accepted with warning/details.
- `label`: optional human-readable purpose.

### Commands

- `/schedule-agent <delay> <message>` for quick countdowns (`10m`, `2h`, `1d`).
- `/schedules` list pending schedules.
- `/cancel-schedule <id>` cancel a schedule.

## Success criteria

- Extension compiles/loads as a Pi extension.
- LLM-callable tool can create, list, get, and cancel schedules.
- Slash commands cover basic user workflows.
- Timers are restored on session start and cleared on shutdown.
- Due/overdue schedules trigger once by calling `pi.sendUserMessage`.
- Persistent JSON survives reloads/restarts.
- Verification includes at least a static/type/syntax check and a direct source inspection for lifecycle, persistence, and wake-up behavior.

## Non-goals for first version

- Operating-system-level wake from sleep or launching Pi when no Pi process is running.
- Cron daemon/service installation.
- Distributed scheduling across machines.
- Complex recurrence rules.
- Calendar integration.

## Open questions / assumptions

- Assumption: "instantiate them back into action" means re-injecting a user message into a running Pi session or on the next Pi startup if the due time passed while closed. It does not mean launching Pi from the OS when no process exists.
- Assumption: global schedules are acceptable; a future version can add per-project scoping.
- Assumption: user will reload/restart Pi after installing the extension.

## Required orchestration requested by user

1. Intake file must be written before planning.
2. GPT 5.5 creates the initial plan.
3. Opus 4.8 critiques the plan.
4. Orchestrator/GPT 5.5 reads the critique and updates the plan.
5. GLM 5.2 executes the updated plan.
6. DeepSeek V4 Pro verifies.
7. Loop plan/update/execute/verify until successful verification.
