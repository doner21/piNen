# Research: Subagents with Separate Context Windows

## Problem statement

We want Pi to support invoking a named subagent such that the work runs in a **separate context window**, rather than polluting the parent session.

The parent agent should delegate a task, the subagent should complete it in isolation, and only the useful result should come back.

---

## Pi-specific research

### 1) Pi intentionally does not ship built-in subagents

From Pi's README:

- Pi is intentionally minimal.
- Pi explicitly says it skips built-in subagents.
- Pi recommends building subagents via **extensions**, **SDK integrations**, or by spawning **Pi instances**.

Implication:

- We do **not** need to fight Pi's architecture.
- The intended solution is extension-based or SDK-based orchestration.

### 2) Pi docs explicitly support custom tools that spawn sub-agents

From `docs/sdk.md`:

- One SDK use case is: **"Build custom tools that spawn sub-agents"**.
- Pi supports `createAgentSession()` and `createAgentSessionRuntime()` for programmatic session management.
- Pi also supports **RPC mode** for process-based integration.

Implication:

- There are two viable implementation paths:
  1. **subprocess orchestration** via `pi --mode json` or `pi --mode rpc`
  2. **in-process orchestration** via the SDK

### 3) Pi already has an upstream subagent extension example

Upstream example:

- `examples/extensions/subagent/index.ts`
- `examples/extensions/subagent/agents.ts`
- `examples/extensions/subagent/README.md`

Important details from the example:

- It registers a `subagent` tool.
- It spawns a **separate `pi` process** for each invocation.
- It runs the child with:
  - `--mode json`
  - `-p`
  - `--no-session`
- It can set per-agent:
  - `model`
  - `tools`
  - `system prompt`
- It supports:
  - single subagent mode
  - parallel subagents
  - chain mode
- Agent definitions are markdown files with YAML frontmatter.

This is the most important finding because it is already very close to the exact feature we want.

### 4) Pi also has a handoff example

Upstream example:

- `examples/extensions/handoff.ts`

This is not the same as subagents, but it reinforces a useful pattern:

- compress the current context
- move only the relevant information into the next focused thread/session

Implication:

- Good subagents should return **compressed, task-specific output**, not raw transcript dumps.

---

## Web research

### 1) OpenAI orchestration and handoffs

From OpenAI Agents docs and SDK docs:

- use specialized agents for narrow roles
- orchestrate via handoffs or agents-as-tools
- delegation works best when the receiving agent gets only the context it needs

Implication for us:

- our subagent tool should pass a **focused task packet**, not the whole parent transcript
- subagent definitions should be role-based: researcher, planner, coder, reviewer, etc.

### 2) Anthropic context engineering guidance

Anthropic's public guidance emphasizes:

- context engineering is about choosing what goes into the context window
- isolation is a core strategy
- large, mixed context causes degradation and "context rot"

Implication for us:

- separate process/session per subagent is the right design
- the parent should receive a summary/result, not the entire internal chain of thought or huge logs

### 3) Gemini CLI subagents announcement

Google's public write-up describes subagents as:

- specialized expert agents
- running in their own context windows
- invoked for high-volume or repetitive work
- reducing context rot in the main session

Implication for us:

- the concept is validated across modern agent systems
- per-agent markdown configuration is a practical, understandable UX

---

## Architectural options considered

## Option A - Spawn a separate Pi subprocess per subagent

### How it works

The parent Pi session calls a custom extension tool, which launches:

```bash
pi --mode json -p --no-session
```

or

```bash
pi --mode rpc --no-session
```

The extension streams events/results back into the parent session.

### Advantages

- strongest context isolation
- easiest mental model
- aligns with Pi's own example implementation
- easy to limit tools and set model per subagent
- child failure is naturally isolated

### Risks

- more process overhead
- need to manage abort/cleanup carefully
- need a stable result format

### Verdict

**Best first implementation.**

## Option B - Build subagents in-process with the Pi SDK

### How it works

An extension or separate app creates additional agent sessions via the SDK.

### Advantages

- no separate process management
- tighter control over runtime
- potentially lower overhead

### Risks

- harder to reason about isolation boundaries
- more implementation complexity inside one runtime
- easier to accidentally share state/tools/context incorrectly

### Verdict

Good future optimization, but not the best first version.

## Option C - Use tmux/session wrappers only

### How it works

Manually launch additional Pi sessions in terminal panes.

### Advantages

- simple operationally
- great for humans

### Risks

- weak programmatic UX
- not callable as a real tool from the parent agent
- poor integration for result return

### Verdict

Useful manually, but not the productized solution we want.

---

## Recommended design principles

1. **One invocation = one isolated child session/process**
2. **Pass only the task packet** to the child
3. **Restrict tools per agent** wherever possible
4. **Allow model-per-agent** configuration
5. **Return compressed output** to the parent
6. **Keep agent definitions in markdown** with YAML frontmatter
7. **Support streaming**, but persist only concise final summaries into the parent context
8. **Make project-local agents opt-in**, for security

---

## Proposed agent definition shape

```md
---
name: researcher
description: Web and codebase reconnaissance
tools: read,bash,grep,find,ls
model: sonnet
---

You are a focused research subagent.
Return only findings, risks, and citations.
Do not make edits.
```

Optional future fields:

- `cwd`
- `timeout`
- `maxTurns`
- `allowProjectAgents`
- `resultFormat`
- `temperature` if the runtime later supports it cleanly

---

## What success looks like

A parent prompt like:

- "Use the researcher subagent to investigate X"
- "Use the planner subagent to propose an implementation plan"
- "Run reviewer on the diff"

results in:

- the named subagent being launched in a **fresh child context**
- the child using its own prompt/tools/model
- the parent receiving only the **final, structured result**

---

## Final recommendation

Start with the **extension + subprocess** architecture based on Pi's upstream `subagent` example.

That is the shortest path to a working subagent system with true context isolation.
