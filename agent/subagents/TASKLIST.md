# Task List

## Immediate next steps

- [x] Research Pi-native and external subagent patterns
- [x] Write down the recommended architecture
- [x] Create a dedicated `.pi` folder for subagent research/plan
- [x] Install a local `subagent` extension under `~/.pi/agent/extensions/`
- [x] Add starter agents under `~/.pi/agent/agents/`
- [x] Validate extension syntax load with jiti
- [ ] Test single-agent isolated execution inside Pi after `/reload`
- [ ] Add structured result formatting
- [ ] Add project-agent safety gating
- [x] Retire legacy `/agents` command in favor of `/subagents`
- [x] Expand `/subagents` to support list, spawn, and create
- [x] Add agency-level selection for created agents (read-only, research, write-enabled)
- [ ] Decide whether to keep JSON mode or upgrade to RPC later

## MVP acceptance test

- [ ] Parent agent calls `subagent`
- [ ] Child process starts in isolated context
- [ ] Child gets agent-specific model/tools/system prompt
- [ ] Child returns concise summary
- [ ] Parent session stays compact
- [ ] Abort kills child process cleanly

## Suggested test prompts

- `Use subagent researcher to find where auth is implemented`
- `Use subagent planner to propose a migration plan for the auth flow`
- `Run reviewer on the recent changes and summarize risks`
