# Pi Orchestrator Extension

A local Pi package that adds deterministic multi-agent orchestration through an `orchestrate` tool and `/orchestrate` command.

## API note

Pi v0.75.0 does **not** expose a built-in core subagent API. This extension uses the extension-style subagent mechanism available in this install: it spawns isolated `pi` subprocesses in JSON print mode:

```bash
pi --mode json -p --no-session --no-extensions ...
```

The orchestrator captures JSONL `message_end` events and uses the final assistant text from each subprocess. It also listens to child JSONL progress events (`message_start`, `message_end`, `agent_end`, tool-call starts, and tool execution events) so `/orchestrate` and the `orchestrate` tool can prove visible activity while work is happening. It treats assistant `stopReason: "error"`, `stopReason: "aborted"`, or `errorMessage` as subprocess failures even when the process exits 0. It does not call LLM provider APIs directly.

Subprocesses are launched with `--no-extensions` so recursive orchestration is hard-disabled and child agents cannot see the parent `orchestrate` tool. Executor agents should rely on built-in Pi tools selected by their `tools` allowlist.

## Pi CLI resolution

By default, the extension prefers the currently running Pi CLI script when available, then known installed `cli.js` locations, then falls back to `pi` (`pi.cmd` on Windows). Optional overrides:

- `PI_CLI_PATH`: path to a Pi executable or script. `.js`/`.mjs`/`.cjs` paths are run with the current Node executable; Windows `.cmd`/`.bat` paths are spawned through a shell.
- `PI_CLI`: command name/path override used as the executable command. On Windows, `.cmd`/`.bat` values are spawned with `shell: true`.

## Install

```bash
pi install %USERPROFILE%/pi-orchestrator-extension
```

If Pi is already running, reload resources after installing:

```text
/reload
```

## Command usage

```text
/orchestrate add tests for auth
/orchestrate --max-subagents 24 --max-retries 2 add tests for auth
/orchestrate --planner-model gpt-5.5 --planner-provider openai-codex --executor-model deepseek-v4-pro --executor-provider deepseek "plan with GPT 5.5, execute with DeepSeek V4"
/orchestrate --concurrency 3 --planner-agent planner --executor-agent coder --verifier-agent reviewer -- "task text that may start with dashes"
```

Supported command flags:

- `--max-subagents N` — explicit total subprocess ceiling for the run.
- `--max-retries N` — retry count after the first attempt; `2` means up to 3 attempts.
- `--concurrency N` — executor concurrency per dependency wave.
- `--planner-agent NAME`, `--executor-agent NAME`, `--verifier-agent NAME` — agent profile names.
- `--planner-model M`, `--planner-provider P` — per-run model override for the planner.
- `--executor-model M`, `--executor-provider P` — per-run model override for executor agents.
- `--verifier-model M`, `--verifier-provider P` — per-run model override for the verifier.
- `--cwd PATH` — child subprocess working directory.
- `--allow-local-model` / `--no-allow-local-model` — local model guard override.
- `--paradigm NAME` — orchestration shape: `plan-execute-verify` (default), `multi-verify-vote`, `composable-pipeline`, `verify-only`, `safe-github-publish`.
- `--hard-gates MODE` — judgment-layer gate mode: `strict` | `advisory` (default) | `off`. See "Judgment layer" below.
- `--preflight` / `--no-preflight` — toggle the 1-token provider health pings run before any subagent spawn (default on).
- `--planner-fallback-model M`, `--planner-fallback-provider P` (and the `executor`/`verifier` variants) — per-role fallback route applied when the primary route fails pre-flight (graceful degradation).

If no task is provided, `/orchestrate` prompts for one. While running, it now surfaces visible progress in the Pi window: status/footer text, a live widget, durable `orchestrate-progress` messages, and child JSON-mode events such as subagent launches, assistant starts/finishes, and tool-call starts. When complete, it notifies a summary, sends a durable visible `orchestrate-result` message, places the final markdown report in the editor when UI is available, and includes a `Progress evidence` section in the report.

If `--max-subagents` is omitted, the extension auto-raises the ceiling after planning when the discovered plan size and retry budget require more than the default. Example: 6 executor tasks with `--max-retries 2` needs `3 * (1 planner + 6 executors + 1 verifier) = 24` subprocesses, so the default ceiling auto-raises from 12 to 24. If `--max-subagents` is provided explicitly, that number is honored and auto-raise is disabled.

## Judgment layer: effect-based verdicts (2026-06-12 hardening)

Verdicts derive from **observed effects** — per-task tool-call telemetry
(write/edit/bash executions counted from the child JSONL stream) and per-task
worktree deltas (`git status` snapshots before/after each executor) — not from
reply-text shape heuristics.

- **`hardGates` (default `advisory`)**: text-shape heuristics (truncation
  signals, "text-only response for implementation task", "suspiciously short
  output", escape-clause scans, file-claim regexes) are demoted to report
  warnings and can never determine a verdict on their own. The verifier's
  evidenced verdict is the gate. Hard gates only escalate (force FAIL) on
  effect-based contradictions: a verifier PASS while implementation tasks show
  zero mutating tool calls and zero worktree changes is forced to FAIL (the
  documented 2026-06-03 false-PASS class). `strict` restores fail-fast
  pre-verifier gates; `off` makes everything advisory.
- **Effect-evidence immunity**: a task with ≥1 successful mutating tool call
  or ≥1 observed file change is immune from all text-shape findings in every
  mode. Executors that do real work and reply with a summary table PASS.
- **Targeted retries (F2)**: per-task pass/fail state persists across
  attempts. Tasks referenced in failure reasons are retried; the rest are
  reused (their prior outputs are routed to re-verification, never
  regenerated) as long as their artifacts still exist on disk. The planner is
  told which tasks are already complete and must not re-create them.
- **Pre-flight + structured failures (F5)**: before spawning any subagent, a
  1-token health ping runs for each routed provider/model pair. Failures
  produce a machine-readable error (`provider`, `type`, `resets_at`) instead
  of raw payload dumps, per-role fallback routes are tried, and a **partial
  report is always emitted on abort** (`details.aborted`,
  `details.providerError`).
- **Intake provenance (F6)**: every derived criterion carries
  `source: explicit | inferred` (`intake.criteriaProvenance`). Synthesized
  criteria (e.g. a generic executor output contract without literal format
  markers in the task) are demoted to `inferredAdvisoryCriteria` — they may
  warn but can never cause a FAIL.
- **Commit evidence (F7)**: the report exposes pre/post-execution `HEAD`
  hashes per attempt (plus a run id), so verifiers can diff reliably despite
  interleaved checkpoint auto-commits.
- **`verify-only` paradigm (F8)**: input is an evidence checklist + paths;
  spawns verifier(s) only; output is per-check verdicts with citations; exempt
  from implementation-task heuristics. See `PARADIGMS.md`.

The per-spawn model-routing attestation lines (`Subagent X: using
provider/model.`) and the deterministic routing check are unchanged and remain
byte-compatible in the report. Pre-flight pings do not count against
`maxSubagents` and never emit attestation-shaped lines.

## GitHub Publishing (safe-github-publish)

The `safe-github-publish` paradigm is the **default recommended method** for
publishing repositories to GitHub from piNen. It implements a 3-phase safe
publishing pipeline:

1. **Plan/Contract (Planner):** Produces a sanitization plan with allowlists
   and deny lists. Never copies source `.git/` history.

2. **Execute (Executor):** Builds a clean staging tree, runs local safety
   checks (gitleaks, path scans, secret scans), initializes a fresh git
   repository, creates a **private-first** GitHub repo, and pushes.

3. **Verify (Verifier):** Independently clones the remote, runs all safety
   gates, and produces a PASS/FAIL verdict with evidence.

**Role integrity:** The visible/current orchestrator never executes staging,
sanitization, commit, repo creation, or push. These are always delegated to
the executor and verifier subagents.

Usage:

```
/orchestrate --paradigm safe-github-publish "Publish my project as my-repo"
```

Safety features:
- Private-first repository creation
- gitleaks secret scanning before push
- Path denylist enforcement (no auth files, sessions, runtime state)
- Personal path/email scrubbing
- Independent remote verification after push

See `PARADIGMS.md` for the full shape specification and `src/shapes/safe-github-publish.ts`
for the implementation.

## Per-run model routing and natural-language controls

The `orchestrate` tool accepts optional `plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`, and `verifierModel`/`verifierProvider` parameters so the calling model can decide which provider/model to use for each role. On the command line, use `--planner-model`, `--planner-provider`, etc. When these are omitted, the subagent inherits its configured model from the agent profile in `~/.pi/agent/agents/` (if set), otherwise from the parent session model.

The intake also preserves pure natural-language orchestration controls inside the task text, including max agents/subagents, executor concurrency/parallelism, retry/attempt loop limits, researcher counts, distinct perspectives, and runtime-role model routing. Explicit natural-language model routing is treated as essential orchestrator configuration, not executor work.

Examples:

```text
User: "plan with GPT 5.5, execute with DeepSeek V4, verify with GPT 5.5"
→ LLM calls orchestrate({ task:"...", plannerModel:"gpt-5.5", plannerProvider:"openai-codex", executorModel:"deepseek-v4-pro", executorProvider:"deepseek", verifierModel:"gpt-5.5", verifierProvider:"openai-codex" })

User: "Use max five agents, concurrency two, loop at most one attempt. Run two researchers with two different perspectives: routing pipeline and orchestration-language controls. Use DeepSeek V4 Pro for the researchers. Use PT 5.5 for the planner."
→ intake.orchestration_controls.maxSubagents = 5
→ intake.orchestration_controls.concurrency = 2
→ intake.orchestration_controls.maxAttempts = 1
→ intake.orchestration_controls.researcherCount = 2
→ intake.routing_requirements includes researcher=deepseek/deepseek-v4-pro and planner=openai-codex/gpt-5.5 as essential natural-language requirements
```

## Tool usage example

Ask Pi to use the tool, or call it from the model with parameters like:

```json
{
  "task": "Add tests for auth",
  "plannerAgent": "planner",
  "executorAgent": "coder",
  "verifierAgent": "reviewer",
  "plannerModel": "gpt-5.5",
  "plannerProvider": "openai-codex",
  "executorModel": "deepseek-v4-pro",
  "executorProvider": "deepseek",
  "verifierModel": "deepseek-v4-pro",
  "verifierProvider": "deepseek",
  "concurrency": 2,
  "maxRetries": 2,
  "maxSubagents": 12,
  "cwd": "%USERPROFILE%/my-project",
  "allowLocalModel": false
}
```

## Agent profiles

The extension loads optional agent definitions from:

```text
~/.pi/agent/agents
```

Supported formats:

- `.json` files with fields: `name`, `description`, `systemPrompt`, `provider`, `model`, `tools`, `skills`, `agencyLevel`
- `.md` files with frontmatter: `name`, `description`, `tools`, `model`, `provider`; the markdown body is used as the system prompt

If profiles are absent, conservative default `planner`, `coder`, and `reviewer` profiles are used.

## Determinism model

The parent extension owns all orchestration state: attempt counter, spawned count, plan, executor outputs, verifier result, failure reasons, and final result. Subagents are isolated Pi processes and do not share a mutable blackboard.
