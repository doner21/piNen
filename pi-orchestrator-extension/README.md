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
pi install ~/.pi/pi-orchestrator-extension
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
- `--concurrency N` — executor concurrency per dependency wave (legacy alias, max 16).
- `--executor-concurrency N` / `--executor-count N` — executor wave slots; supports up to 16 simultaneous independent executors when dependencies allow.
- `--planner-count N` / `--planner-concurrency N` — run multiple planner subagents in parallel, then deterministically select the lowest-index parseable plan.
- `--verifier-count N` / `--verifier-concurrency N` — run multiple verifier subagents in parallel; aggregate with strict consensus (any verifier FAIL makes the aggregate FAIL).
- `--planner-agent NAME`, `--executor-agent NAME`, `--verifier-agent NAME` — agent profile names.
- `--planner-model M`, `--planner-provider P` — per-run model override for the planner.
- `--executor-model M`, `--executor-provider P` — per-run model override for executor agents.
- `--verifier-model M`, `--verifier-provider P` — per-run model override for the verifier.
- `--cwd PATH` — child subprocess working directory.
- `--allow-local-model` / `--no-allow-local-model` — local model guard override.
- `--paradigm NAME` — orchestration shape: `plan-execute-verify` (default), `multi-verify-vote`, `composable-pipeline`, `dual-plan-synthesis-execute-verify`, `verify-only`, `paradigm-creator`, `shape-builder`, `win-console-spawn-root-cause`, `win-lifecycle-process-trace`, `frozen-gate-fix-loop`, `evidence-audit`, `independent-replication`, `safe-github-publish`.
- `--hard-gates MODE` — judgment-layer gate mode: `strict` | `advisory` (default) | `off`. See "Judgment layer" below.
- `--write-set PATHS` — comma-separated repo-relative paths, prefixes, simple globs, or absolute external paths. Deterministic enforcement is supported by `plan-execute-verify` and `frozen-gate-fix-loop`; dual-plan accepts it only as proposed scope with `--discovery-only`. Unsupported shapes fail closed.
- `--discovery-only` — read-only planning supported by `plan-execute-verify` and `dual-plan-synthesis-execute-verify`; returns a plan plus predicted write set without spawning executors or verifiers. Unsupported shapes fail closed.
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
- **Predict-then-write scope**: for `plan-execute-verify` and
  `frozen-gate-fix-loop`, `predictedWriteSet`/`--write-set` constrains execution
  to approved relative or absolute paths. Out-of-contract plans fail before
  execution and observed out-of-scope mutations fail before verifier spawn.
  `discoveryOnly`/`--discovery-only` is supported by PEV and dual-plan; it uses
  read-only planning and returns the proposed scope without project mutations.
  Other control/shape combinations fail closed instead of being ignored.
- **Terminal ambiguous mutation handling**: if a mutating child loses its final
  result stream or exits with an unrecovered assistant/transport error, the run
  persists a no-retry terminal state rather than blindly spawning a duplicate
  executor against potentially changed files.
- **Pre-flight + structured failures (F5)**: before spawning any subagent, a
  1-token health ping runs for each routed provider/model pair. Every ping has
  a 20-second wall-clock timeout and the complete primary/fallback preflight
  has a 75-second wall-clock budget. Timeout and abort failures produce a
  machine-readable error (`provider`, `model`, `type`) and a terminal partial
  FAIL report (`details.aborted`, `details.providerError`) instead of hanging
  or dumping raw provider payloads.
- **Intake provenance (F6)**: every derived criterion carries
  `source: explicit | inferred` (`intake.criteriaProvenance`). Synthesized
  criteria (e.g. a generic executor output contract without literal format
  markers in the task) are demoted to `inferredAdvisoryCriteria` — they may
  warn but can never cause a FAIL.
- **Commit evidence (F7)**: the report exposes pre/post-execution `HEAD`
  hashes per attempt (plus a run id), so verifiers can diff reliably despite
  interleaved checkpoint auto-commits.
- **`dual-plan-synthesis-execute-verify` paradigm**: route-specific high-stakes loop with OpenRouter GLM 5.2 + OpenAI Codex GPT 5.5 independent planners, Opus 4.8 synthesis, DeepSeek V4 Pro execution, and GPT 5.5 direct-evidence verification with bounded executor retry feedback.
- **`verify-only` paradigm (F8)**: input is an evidence checklist + paths;
  spawns verifier(s) only; output is per-check verdicts with citations; exempt
  from implementation-task heuristics. See `PARADIGMS.md`.
- **`win-console-spawn-root-cause` paradigm**: 3-phase Windows console flash investigation. Routes execution to DeepSeek V4 Pro, higher-level reasoning to GPT-5.5. Falsifiable verifier with strict FAIL conditions: execution not DeepSeek V4 Pro, static-grep-only, lifecycle paths omitted, Windows console mechanics unaddressed, rollback missing, fix too broad.
- **`win-lifecycle-process-trace` paradigm**: 3-phase non-invasive Windows lifecycle process-trace runbook and harness materialization. Planner (GPT-5.5) maps lifecycle boundaries, action markers, and correlation windows. Executor (DeepSeek V4 Pro) produces non-invasive diagnostic harness scripts and verification checklist. Verifier (GPT-5.5) judges harness materials: must fail if static-only, action markers/correlation windows missing, lifecycle paths omitted, rollback absent, or executor route wrong. Shape is non-invasive until a separate human-approved run — no live Pi interception, no config mutation.
- **`frozen-gate-fix-loop` paradigm**: bounded-fix loop for an EXISTING near-passing implementation against a FROZEN (sha256-content-locked) gate/spec document plus enumerated residual findings. Phases 1 and 3 are DETERMINISTIC (non-LLM) sha256 verifications of the frozen document before and after each executor fix — a mismatch is an automatic FAIL (freeze mismatch spawns zero LLMs; a mid-run tamper FAILs before the verifier). The executor fixes ONLY the enumerated findings (restructuring beyond scope is a verifier FAIL); an independent verifier re-checks raw artifacts with fail-closed JSON parsing; the loop retries bounded on verifier FAIL (default `maxRetries` 2). Inputs are labeled fields in the task and/or a referenced `SPEC_FILE` (spec-file pattern preferred): `FROZEN_DOC_PATH`, `FROZEN_DOC_SHA256`, `FINDINGS`, optional `SPEC_FILE`/`RUN_ID_LABEL`. Route overrides (`executorModel`/`executorProvider`, `verifierModel`/`verifierProvider`) are honored and reflected in the report `Routes:` line; resume is supported (deterministic phases re-execute; completed LLM phases restore from checkpoint). Built on the new deterministic non-LLM phase primitive (`src/deterministic-phase.ts`: `hash-file`, `verify-hash`, `freeze-record`, `manifest` — pure Node stdlib, no spawn/network/arbitrary command execution, checkpointed with a `deterministic: true` marker and a `DETERMINISTIC (no LLM)` report tag). See `PARADIGMS.md`.
- **`evidence-audit` paradigm**: hardened re-verifier over a COMPLETED run's evidence (falsifier-grade `verify-only`). Phase 1 DETERMINISTIC `verify-hash` of the frozen gate document (mismatch ⇒ zero-spawn FAIL); Phase 2 DETERMINISTIC `manifest` (sha256 + bytes) of the declared gate-evidence files relative to `EVIDENCE_CWD` — a missing/invalid file is a zero-spawn FAIL and the checkpointed manifest IS the audit fingerprint; Phase 3 spawns exactly ONE read-only verifier (NO executor) that audits run-id binding, internal consistency, and freshness from raw artifacts with fail-closed JSON; Phase 4 DETERMINISTIC `verify-hash` confirms the frozen doc was untouched. The shape never writes into the audited tree. Inputs: `FROZEN_DOC_PATH`, `FROZEN_DOC_SHA256`, `EVIDENCE_CWD`, optional `RUN_ID_LABEL`/`AUDIT_FOCUS`/`GATE_EVIDENCE_FILES`/`SPEC_FILE`. `verifierModel`/`verifierProvider` overrides honored; resume-supported. See `PARADIGMS.md`.
- **`independent-replication` paradigm**: two INDEPENDENT implementations of ONE frozen gate in isolated lane subdirectories, routed to (ideally) different models, compared honestly (codifies the K1/G2 two-shape pattern). DETERMINISTIC `verify-hash` before, between, and after the two lanes (tamper-proof; a mid-run tamper ⇒ FAIL at the next deterministic check with lane B not run). Each lane runs its own lane-confined executor (lane B forbidden from reading lane A) then an independent fail-closed verifier. The overall verdict is aggregated IN CODE (PASS iff both lanes PASS and all freeze checks hold); the diversity caveat is COMPUTED from the resolved lane routes ("fully disjoint" vs shared-model narrowed). Inputs: `FROZEN_DOC_PATH`, `FROZEN_DOC_SHA256`, `BASE_CWD`, optional `LANE_A_SUBDIR`/`LANE_B_SUBDIR`, optional lane-B route overrides `LANE_B_EXECUTOR_PROVIDER/MODEL` and `LANE_B_VERIFIER_PROVIDER/MODEL`; lane A uses the standard `executorModel`/`verifierModel` params. Resume-supported. See `PARADIGMS.md`.
- **`paradigm-creator` paradigm**: explicit-only conservative self-extension
  helper. V1 is propose-only: it runs one bounded assessment planner, then
  deterministic TypeScript helpers normalize the requested name, validate the
  spec, gate confidence, render a candidate shape template, run static checks,
  and return reload handoff details. It does not write files, reload Pi,
  schedule continuations, or infer itself from fuzzy natural language.
  V1 validation limits: `maxIterations` must be exactly `1` (generated
  template runs a single sequential pass), and `maxSubagents` must be at
  least the number of proposed phases.

The per-spawn model-routing attestation lines (`Subagent X: using
provider/model.`) and the deterministic routing check are unchanged and remain
byte-compatible in the report. Pre-flight pings do not count against
`maxSubagents` and never emit attestation-shaped lines.

## Safe GitHub publishing

`safe-github-publish` is the publishing-specific shape:

```text
/orchestrate --paradigm safe-github-publish "Publish this project as my-repo"
```

It requires a sanitization contract, builds a clean staging tree without source Git history, runs gitleaks and path-deny checks, creates the target private-first, pushes through an executor, and independently verifies the remote. The visible orchestrator never performs the main publishing work directly.

## Per-run model routing and natural-language controls

The `orchestrate` tool accepts optional `plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`, and `verifierModel`/`verifierProvider` parameters so the caller can select each role route. On the command line, use `--planner-model`, `--planner-provider`, etc. Explicit overrides take precedence. Omitted fields resolve from the named agent profile in `~/.pi/agent/agents/`, then from `~/.pi/agent/settings.json` (`defaultProvider`/`defaultModel`); they no longer inherit the conversational model. The selected planner/executor/verifier routes are emitted before preflight begins.

Because this package is loaded as a Pi extension, applying source changes to an already-running Pi or embedded host may require a **full process restart**. A source update does not itself reload or restart active processes.

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

## `win-console-spawn-root-cause` example

```text
/orchestrate --paradigm win-console-spawn-root-cause "Investigate remaining console flashes on Pi reload and new-session"
```

Explicit paradigm call with overrides:

```json
{
  "task": "Investigate remaining console flashes on Pi reload, new-session, and open-from-Terminal",
  "paradigm": "win-console-spawn-root-cause",
  "executorModel": "deepseek-v4-pro",
  "executorProvider": "deepseek",
  "plannerModel": "gpt-5.5",
  "plannerProvider": "openai-codex",
  "preflight": false,
  "maxSubagents": 6
}
```

## `win-lifecycle-process-trace` example

```text
/orchestrate --paradigm win-lifecycle-process-trace "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles"
```

Explicit paradigm call with overrides:

```json
{
  "task": "Create non-invasive process-trace harness for Windows Pi lifecycles",
  "paradigm": "win-lifecycle-process-trace",
  "executorModel": "deepseek-v4-pro",
  "executorProvider": "deepseek",
  "plannerModel": "gpt-5.5",
  "plannerProvider": "openai-codex",
  "preflight": false,
  "maxSubagents": 6
}
```

This shape produces runbook/harness materials and a verification contract. It does NOT execute tracing or launch Pi processes. A separate human-approved run is required to execute the harness against live Pi processes.

## `paradigm-creator` example

```text
/orchestrate --paradigm paradigm-creator "Propose a bounded red-team / blue-team / judge paradigm for migration audits"
```

The result is a proposal report, not an applied mutation. After a human or future explicit apply mode writes the proposed files and tests pass, the parent Pi session must schedule continuation, trigger a runtime reload, stop, read reload diagnostics first, and verify the new paradigm appears in runtime discovery before using it.

## `shape-builder` example

```text
/orchestrate --paradigm shape-builder "SHAPE_BUILDER_SPEC_JSON\n{...spec json...}"
```

The shape-builder is a deterministic meta-constructor for creating new orchestration shapes with full lifecycle gating.

### Lifecycle states

A generated shape progresses through: `proposed` → `implementation_reported` → `implemented_verified` → (parent reload) → `reloaded_discovered` → `canary_passed`.

- **proposed**: Spec parsed, validated, lifecycle JSON written. No files written yet.
- **implementation_reported**: Generated files written, local checks passed. Not yet verified.
- **implemented_verified**: Independent verifier confirmed implementation. `reloadRequired: true`.
- **reloaded_discovered**: Post-reload; active runtime confirms shape is registered.
- **canary_passed**: Active runtime canary succeeded. `usable: true`.

### Return contract

Successful pre-reload response includes:
- `implemented_verified: true`, `usable: false`, `reloadRequired: true`
- `nextRequiredGate: "agent_reload"`
- `continuationTemplate` beginning `RESUME AFTER PI RELOAD:`

The shape itself never reloads, schedules, or marks a shape usable before post-reload canary.

### Reload handoff

After verification reports `implemented_verified`:
1. Visible ORCHESTRATOR schedules continuation, calls `agent_reload_runtime`, and stops.
2. Resumed ORCHESTRATOR reads `agent-reload-diagnostics.json` first.
3. Active runtime discovery with intentionally-unknown paradigm — confirm the generated name appears.
4. Active runtime canary with `paradigm:<name>` and `task: "SHAPE_CANARY:<name>"`.
5. Only after canary passes, mark the shape `usable: true`.

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
  "cwd": "/path/to/my-project",
  "allowLocalModel": false
}
```

Explicit paradigm-creator call:

```json
{
  "task": "Propose a bounded red-team / blue-team / judge paradigm for migration audits",
  "paradigm": "paradigm-creator",
  "preflight": false,
  "maxSubagents": 3
}
```

## Orchestration mode

Use this extension when the user explicitly requests orchestration. The current agent coordinates the selected planner/executor/verifier subprocesses and reports the observed result; it must not quietly perform the main task directly while claiming the run was delegated. Use the shape's built-in reports and gates without adding role ledgers, receipts, or other policy paperwork. On failure, repair the specific product or orchestration defect and re-run while there is material progress. See `agent/AGENTS.md` for the canonical public policy.

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

## Shape-Builder Generated Shapes

<!-- shape-builder:generated-shapes:start -->
- `m66-explicit-routing-proof`: Build-time generated M6.6 proof shape for explicit route, context-isolation, executor-control, and two-verifier dispatch acceptance.
<!-- shape-builder:generated-shapes:end -->
