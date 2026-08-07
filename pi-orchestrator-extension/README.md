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
pi install <PI_CONFIG>/pi-orchestrator-extension
```

If Pi is already running, reload resources after installing or changing the extension's own TypeScript:

```text
/reload
```

This install-time reload is not part of the ordinary workflow lifecycle. Once this extension version is active, adding or changing a declarative workflow JSON artifact is discovered on the next `orchestrate` invocation in the same Pi session.

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
- `--paradigm NAME` — select a built-in/native shape or a safe kebab-case declarative workflow discovered at invocation time. Built-ins include `plan-execute-verify` (default), `multi-verify-vote`, `composable-pipeline`, `dual-plan-synthesis-execute-verify`, `verify-only`, `paradigm-creator`, `shape-builder`, `win-console-spawn-root-cause`, `win-lifecycle-process-trace`, `frozen-gate-fix-loop`, `evidence-audit`, `independent-replication`, and `ssi-single-writer-exclusive-lane`.
- `--hard-gates MODE` — judgment-layer gate mode: `strict` | `advisory` (default) | `off`. See "Judgment layer" below.
- `--preflight` / `--no-preflight` — toggle the 1-token provider health pings run before any subagent spawn (default on).
- `--planner-fallback-model M`, `--planner-fallback-provider P` (and the `executor`/`verifier` variants) — per-role fallback route applied when the primary route fails pre-flight (graceful degradation).

If no task is provided, `/orchestrate` prompts for one. While running, it now surfaces visible progress in the Pi window: status/footer text, a live widget, durable `orchestrate-progress` messages, and child JSON-mode events such as subagent launches, assistant starts/finishes, and tool-call starts. When complete, it notifies a summary, sends a durable visible `orchestrate-result` message, places the final markdown report in the editor when UI is available, and includes a `Progress evidence` section in the report.

If `--max-subagents` is omitted, the extension auto-raises the ceiling after planning when the discovered plan size and retry budget require more than the default. Example: 6 executor tasks with `--max-retries 2` needs `3 * (1 planner + 6 executors + 1 verifier) = 24` subprocesses, so the default ceiling auto-raises from 12 to 24. If `--max-subagents` is provided explicitly, that number is honored and auto-raise is disabled.

## Declarative workflows: dynamic and reload-free

Ordinary reusable workflows are versioned JSON data, not extension modules. The resolver checks trusted roots on **every invocation**, so a workflow written by `shape-builder` (or by another trusted editor) can immediately run in the same Pi process:

```text
/orchestrate --paradigm my-review-loop "review this change"
```

Artifacts use the filename `<safe-kebab-name>.workflow.json` and live in one of these roots:

| Scope | Default root | Precedence |
|---|---|---|
| Project | `<cwd>/.pi/orchestrator-workflows/` | First |
| User | `~/.pi/orchestrator-workflows/` | Fallback |

`PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT` and `PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT` override these roots (primarily for tests and controlled deployments). A present project artifact wins over the same user workflow name; if that project artifact is invalid, resolution fails closed rather than falling back. Declarative workflows may not shadow any built-in/native shape.

### Schema version 1

Unknown fields are rejected. A minimal artifact is:

```json
{
  "schemaVersion": 1,
  "name": "my-review-loop",
  "description": "Review, then verify a change.",
  "phases": [
    {
      "id": "review",
      "role": "executor",
      "agentName": "coder",
      "prompt": "Review the requested change and report concrete findings.",
      "expectedOutput": "Findings with file and line evidence.",
      "dependsOn": [],
      "route": { "role": "executor" }
    },
    {
      "id": "verify",
      "role": "verifier",
      "agentName": "reviewer",
      "prompt": "Independently verify the dependency output.",
      "expectedOutput": "A supported pass/fail verdict.",
      "dependsOn": ["review"],
      "route": { "role": "verifier" }
    }
  ],
  "maxSubagents": 2,
  "maxConcurrency": 2,
  "maxIterations": 1,
  "continueOnFailure": false,
  "terminationCondition": "Stop after one finite pass.",
  "evidenceModel": "Cited phase outputs.",
  "failureBehavior": "Fail on a non-zero phase exit.",
  "userFacingExplanation": "A bounded review and independent verification workflow."
}
```

A phase `route.role` is `inherit`, `planner`, `executor`, or `verifier`; optional `provider` and `model` select an explicit bounded route. Dependencies must form an acyclic graph. The coordinator can only validate/schedule the graph and spawn isolated subagents through the existing substrate: workflow JSON cannot import TypeScript, execute coordinator shell commands, access coordinator filesystem APIs, call the network, or recursively orchestrate.

### Trust, bounds, and reproducibility

Both the requested workflow name and phase IDs must be safe lowercase kebab-case. The loader canonicalizes real paths and rejects path traversal plus symlink/junction escapes outside the selected trusted root. It accepts regular files only and enforces these hard limits before spawning:

- artifact size: 256 KiB; workflow name: 64 characters
- phases: 1–32; iterations: 1–10; total workflow spawn ceiling: 64
- concurrency: 1–16; prompt: 16,000 characters; expected output: 4,000 characters
- description: 2,000 characters; final report: 20,000 characters; retained phase output: 4,000 characters

`shape-builder` validates the artifact, rediscovers it through the same invocation-time resolver, and runs a deterministic graph canary with **zero subagent spawns**. A real workflow run stores its canonical source path, scope, schema version, source-byte SHA-256, validated-snapshot SHA-256, and the exact fully validated IR snapshot in run state and results. Resume uses only that pinned snapshot; it never silently switches to a source artifact changed after the run began, and fails closed if the pinned snapshot is absent or inconsistent. Older native run-state files remain valid.

The default user root and normal project roots are not part of Pi's globally installed npm package or its `dist` files. Ordinary `pi` self-updates therefore cannot overwrite these user/project-owned workflow artifacts (keep the project root in a user-owned project, as intended). No Pi core, global `dist`, private loader, or static import/registry edit is involved.

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

## Per-run model routing and natural-language controls

The `orchestrate` tool accepts optional `plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`, and `verifierModel`/`verifierProvider` parameters so the caller can select each role route. On the command line, use `--planner-model`, `--planner-provider`, etc. Explicit overrides take precedence. Omitted fields resolve from the named agent profile in `~/.pi/agent/agents/`, then from `~/.pi/agent/settings.json` (`defaultProvider`/`defaultModel`); they no longer inherit the conversational model. The selected planner/executor/verifier routes are emitted before preflight begins.

Because this package is loaded as a Pi extension, applying changes to the extension's own TypeScript or built-in/native shape registry in an already-running Pi or embedded SSI harness may require a **full Pi/SSI process restart**. Creating or editing an ordinary declarative workflow artifact does **not**: invocation-time resolution makes it visible in the current session.

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

The result is a proposal report, not an applied mutation. `paradigm-creator` proposes native extension code, so after an explicit apply step writes that code and tests pass, the parent Pi session must reload/restart and verify native runtime discovery before use. For an ordinary data-only workflow, use `shape-builder` instead; it writes declarative JSON and requires no reload.

## `shape-builder` example

```text
/orchestrate --paradigm shape-builder "SHAPE_BUILDER_SPEC_JSON\n{...spec json...}"
```

The shape-builder is a deterministic meta-constructor with two explicit artifact modes.

### Ordinary mode (default): declarative workflow

Omit `artifactKind`, or set `"artifactKind": "declarative-workflow"`. `scope` defaults to `"user"`; set it to `"project"` to publish under the current `cwd`. The builder compiles the normal `ShapeBuilderSpec` to one durable `.workflow.json` artifact. It does not generate TypeScript, a per-workflow test module, or static registry/docs imports. Builder JSON is strict: unknown top-level/phase fields and type coercion are rejected; names must already be safe lowercase kebab-case; phase identifiers must remain unique after normalization; and all numeric/text limits are checked before publication.

Lifecycle: `proposed` → `implementation_reported` → `declarative_verified` → `runtime_discovered` → `canary_passed`. Publication is atomic within the trusted root and refuses differing existing files, symlinks, non-regular entries, hidden user/project precedence conflicts, and native/declarative name collisions. Validation, invocation-time rediscovery, and the deterministic zero-spawn canary happen in the same run. Success returns:

- `implemented_verified: true`, `usable: true`, `reloadRequired: false`
- `lifecycleStatus: "canary_passed"`, `nextRequiredGate: "none"`
- source path, scope, schema version, content hash, and canary evidence

The workflow is immediately runnable with `--paradigm <targetName>` in the current Pi session.

### Explicit native mode: extension/substrate code

Set `"artifactKind": "native-shape"` only when the requested capability genuinely requires executable extension/substrate code that declarative phases cannot express. Native mode retains the historical code generation, static sibling/safety checks, independent verifier, anchored registry/docs/test edits, and lifecycle:

`proposed` → `implementation_reported` → `implemented_verified` → (parent reload) → `reloaded_discovered` → `canary_passed`.

A successful pre-reload native response remains `usable: false`, `reloadRequired: true`, and `nextRequiredGate: "agent_reload"`, with a `RESUME AFTER PI RELOAD:` continuation template. The shape itself never invokes reload, `pi.executeCommand`, a private loader, a scheduler, or recursive orchestration.

## `ssi-single-writer-exclusive-lane` — usable deterministic shape

Lifecycle: **`canary_passed`, usable, production-proven**. Use this shape for integrated SSI DAW work in a shared dirty checkout where exactly one logical writer must own source mutation and CMake/Ninja/native-host/Electron/Playwright/WASAPI gates must run one at a time behind a cross-process machine lock.

It runs three parallel read-only diagnoses, one synthesis, one allowlisted non-DeepSeek writer, two parallel read-only source reviews, one exclusive serialized machine lane, at most one same-writer repair and full retest, then a PASS-gated finalizer with independent local/remote Git verification. It is not appropriate for small docs-only or isolated edits, and optional concurrent-rebuild stress must not be promoted into ordinary SSI acceptance without an explicit scope decision.

```json
{
  "task": "<authoritative SSI task with exact serial gates and cleanup requirements>",
  "paradigm": "ssi-single-writer-exclusive-lane",
  "cwd": "<project-root>",
  "executorModel": "gpt-5.6-sol",
  "executorProvider": "openai-codex",
  "maxSubagents": 11,
  "maxRetries": 0
}
```

Canonical lifecycle and operational history: [`shape-builder-lifecycle/ssi-single-writer-exclusive-lane.json`](shape-builder-lifecycle/ssi-single-writer-exclusive-lane.json) and [`ssi-single-writer-exclusive-lane-OPERATIONS.md`](shape-builder-lifecycle/ssi-single-writer-exclusive-lane-OPERATIONS.md).

Existing Pi processes may retain a stale local-package registry after `/reload`; if the paradigm is reported unknown, fully restart Pi and run `SHAPE_CANARY:ssi-single-writer-exclusive-lane` before product work.

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
  "cwd": "<project-root>",
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

## Orchestrator Role Integrity

When an orchestration paradigm runs, the visible/current agent remains the ORCHESTRATOR and must not execute the main task directly. Every run must produce an *Orchestrator Role Integrity Ledger*. On orchestration failure, repair the requested shape/tool — do not switch shapes or execute the main task directly. Provider/model fallback is allowed; shape substitution is forbidden. See `PARADIGMS.md` and `agent/AGENTS.md` for the canonical policy.

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

## Native Shape-Builder Generated Shapes

<!-- shape-builder:generated-shapes:start -->
- `venue-rescue-synthesis`: venue-rescue-synthesis runs cheap text research and a vision-based brand audit, then a specialist financial narrative, then a strong synthesis-and-critique that fuses everything into a rescue strategy with wild and practical options, then a design phase that builds a stylish interactive investor site, then an independent verification.
- `m66-explicit-routing-proof`: Build-time generated M6.6 proof shape for explicit route, context-isolation, executor-control, and two-verifier dispatch acceptance.
- [`ssi-single-writer-exclusive-lane`](shape-builder-lifecycle/ssi-single-writer-exclusive-lane-OPERATIONS.md) (**usable — canary passed; production-proven 2026-07-29**): Runs parallel read-only SSI diagnosis, one synthesized plan, one logical non-DeepSeek source writer, parallel source review, and a single serialized build/native/Electron/WASAPI lane with one bounded feedback pass before verified commit/push and a listening card.
<!-- shape-builder:generated-shapes:end -->
