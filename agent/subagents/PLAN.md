# Implementation Plan

## Objective

Add a Pi extension that lets the main agent invoke a named subagent, where that subagent runs in a **separate context window** and returns a compressed result.

---

## Chosen architecture

### Parent orchestrator

A Pi extension loaded from:

- `~/.pi/agent/extensions/subagent/`

This extension will register a tool, likely named:

- `subagent`

### Child execution model

Each invocation launches a separate Pi child process using one of these modes:

### Phase 1 choice

Use:

```bash
pi --mode json -p --no-session
```

Why:

- already used by Pi's upstream example
- simple to parse
- enough for first implementation

### Phase 2 optional upgrade

Move to:

```bash
pi --mode rpc --no-session
```

if we need tighter interaction, richer event control, or multi-step child orchestration.

---

## Folder structure to implement

```text
~/.pi/agent/
  agents/
    researcher.md
    planner.md
    reviewer.md
    coder.md
  extensions/
    subagent/
      index.ts
      agents.ts
      runner.ts
      types.ts
  subagents/
    README.md
    RESEARCH.md
    PLAN.md
    TASKLIST.md
```

---

## Execution phases

## Phase 1 - Reuse upstream example as baseline

### Goal

Get a working local extension that proves isolated subagent invocation.

### Tasks

1. Copy/adapt Pi's upstream example from:
   - `examples/extensions/subagent/index.ts`
   - `examples/extensions/subagent/agents.ts`
2. Install it into:
   - `~/.pi/agent/extensions/subagent/`
3. Create initial agent definition files in:
   - `~/.pi/agent/agents/`
4. Verify a simple call works end-to-end.

### Acceptance criteria

- parent can invoke `subagent`
- child runs in separate process
- child output returns to parent
- abort stops child process cleanly

---

## Phase 2 - Simplify for your intended UX

### Goal

Make invocation match the workflow you actually want.

### Recommendation

Support a clear call style such as:

```text
Use subagent researcher to investigate authentication flow
```

or internally:

```json
{ "agent": "researcher", "task": "investigate authentication flow" }
```

### Tasks

1. Keep single-agent mode first
2. Keep parallel and chain mode optional but available
3. Add better validation and clearer error messages
4. Return concise structured output

### Suggested output shape

```json
{
  "agent": "researcher",
  "status": "ok",
  "summary": "...",
  "findings": ["..."],
  "files": ["..."],
  "risks": ["..."],
  "next_steps": ["..."]
}
```

The parent-visible message can still be plain text, but the tool `details` should stay structured.

---

## Phase 3 - Agent registry and definitions

### Goal

Allow named subagents to be discovered from markdown files.

### Agent file format

```md
---
name: researcher
description: Performs codebase and web research
tools: read,bash,grep,find,ls
model: sonnet
---

You are a research specialist.
Focus on findings, evidence, and concise summaries.
```

### Tasks

1. Load user-level agents from:
   - `~/.pi/agent/agents/`
2. Optionally support project-local agents from:
   - `.pi/agents/`
3. Default to **user-only** for safety
4. Require opt-in or confirmation for project-local agents

### Acceptance criteria

- named agents are discoverable
- duplicate names resolve predictably
- project agents are gated

---

## Phase 4 - Result compression and parent hygiene

### Goal

Prevent the child transcript from bloating the parent session.

### Rules

1. Child keeps its own internal work isolated
2. Parent receives:
   - final answer
   - structured details
   - maybe a short execution summary
3. Parent should not ingest every tool log by default

### Tasks

1. define a result schema
2. trim noisy tool/event output in parent view
3. expose expanded view only on demand

### Acceptance criteria

- parent context remains compact
- results are still debuggable

---

## Phase 5 - Operational hardening

### Goal

Make the feature reliable enough for regular use.

### Tasks

1. abort propagation
2. timeouts
3. child exit-code handling
4. model/tool validation before spawn
5. safe temp-file handling for delegated prompts
6. optional concurrency limits for parallel runs
7. logging and diagnostics for failures

### Acceptance criteria

- killed parent turn kills child
- failures return useful messages
- no orphaned processes

---

## Phase 6 - Optional RPC upgrade

### Goal

Upgrade from JSON print mode to RPC if needed.

### Use RPC when

- we need multi-turn interactive child workflows
- we need richer streaming/control semantics
- we want tighter integration from non-Node environments

### Do not do this first

The JSON subprocess design is enough for initial delivery.

---

## Security model

### Risks

Subagents are effectively remote-controlled agent executions with tool access.

### Controls

1. default to **user-level agents only**
2. restrict tools per agent
3. prefer read-only agents for research/planning/review
4. gate project-local agent prompts behind confirmation
5. optionally add allowlists for cwd or commands later

---

## Recommended first set of subagents

### researcher

- tools: read, bash, grep, find, ls
- purpose: repo and web investigation

### planner

- tools: read, grep, find, ls
- purpose: produce implementation plans only

### reviewer

- tools: read, bash, grep, find, ls
- purpose: inspect code and diffs, report issues

### coder

- tools: read, bash, edit, write
- purpose: implementation in isolated context

---

## What we should build first

### MVP

1. install/adapt the upstream subagent extension
2. add 2-4 markdown-defined agents
3. verify isolated execution
4. make result output concise
5. document invocation patterns

This gets us to a usable subagent system quickly.

---

## Open questions

1. Do you want subagents callable only by the LLM tool, or also via slash commands?
2. Should child sessions be strictly ephemeral (`--no-session`) or optionally persisted for debugging?
3. Should coder-type subagents be allowed to write, or should early versions be read-only?
4. Do you want project-level `.pi/agents/` enabled by default in trusted repos?

---

## Recommended next move

Implement the MVP by adapting Pi's built-in example into your local extension directory and adding a small starter agent registry.
