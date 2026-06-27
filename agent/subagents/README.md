# Subagents

This folder captures the research and implementation plan for adding **subagents with their own context window** to Pi.

## Goal

When a specific subagent is invoked, Pi should spawn a separate agent process/session with:

- its **own isolated context window**
- its **own prompt/instructions**
- optional **tool restrictions**
- optional **model selection**
- a **compressed result** returned to the parent agent

## Why this approach

Pi itself explicitly does **not** ship with built-in subagents, but its docs say subagents can be built with:

- extensions
- the SDK
- RPC mode
- spawning separate Pi processes

Pi already includes an **example subagent extension** upstream that uses exactly this pattern.

## Files in this folder

- `RESEARCH.md` - external and Pi-specific research
- `PLAN.md` - concrete implementation plan
- `TASKLIST.md` - execution checklist

## Recommended implementation direction

Use a **Pi extension** that registers a `subagent` tool and spawns a fresh `pi` subprocess in `--mode json` or `--mode rpc` with `--no-session`.

That gives us the cleanest route to:

1. isolated context
2. controllable model/tools/system prompt
3. streaming updates back to the main agent
4. per-subagent configuration via markdown files

## Key upstream references

- Pi README: Pi skips built-in subagents by design but supports building them via extensions
- Pi SDK docs: custom tools can spawn sub-agents
- Pi example: `examples/extensions/subagent/`
- OpenAI orchestration docs: specialized agents and handoffs
- Anthropic context engineering guidance: isolate contexts and return compressed outputs
- Google Gemini CLI subagents announcement: separate context windows reduce context rot
