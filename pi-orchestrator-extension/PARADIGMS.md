# Orchestration Paradigms (Shapes)

This document describes the orchestration paradigms (shapes) available in the Pi orchestrate extension and how to add new ones.

## Available Paradigms

| Name | Description |
|------|-------------|
| `plan-execute-verify` | Classic planner → executor waves → verifier flow. Default paradigm. Supports retries with failure feedback and deterministic model routing checks. |
| `multi-verify-vote` | Planner → executor waves → multiple verifiers (odd count) → majority vote. Each verifier independently judges pass/fail; outcome is decided by majority. |
| `composable-pipeline` | Dynamic pipeline composition via natural language (hypothesize → critique → synthesize → plan → execute → verify, with per-phase counts). |
| `dual-plan-synthesis-execute-verify` | Two independently routed planner passes → synthesis → executor → direct-evidence verifier, with bounded retry feedback. Defaults are role-safe OpenAI Codex GPT-5.6 Sol for planning/execution and GPT-5.5 for verification; explicit overrides are honored. |
| `verify-only` | Verification-only: input is an evidence checklist + paths; spawns verifier(s) ONLY (no planner, no executors); output is per-check verdicts with citations. Supports multi-verifier majority vote ("3 verifiers" in the task text). Exempt from all implementation-task heuristics — verification output is legitimately text-only. Verifiers are granted read/bash/grep tools so they can gather and cite evidence independently. |
| `paradigm-creator` | Conservative meta-orchestration for proposing new reusable paradigms. V1 is explicit-only and propose-only: it runs one bounded assessment planner, then deterministic TypeScript helpers normalize the name, validate the spec, gate confidence, render a template, run static checks, and return reload handoff details without writing files. |
| `shape-builder` | Deterministic meta-constructor for reusable orchestration. Ordinary specs compile to durable user/project declarative JSON, are rediscovered and canaried in-process, and return `usable: true`, `reloadRequired: false`. Explicit `artifactKind: "native-shape"` retains generated extension code, registry/tests, independent verification, and reload gating. |
| `win-console-spawn-root-cause` | Downstream Windows console-spawn flash root-cause investigation. Routes execution to DeepSeek V4 Pro and higher-level reasoning to GPT-5.5. Three finite phases: intake-boundary-plan (planner maps boundaries/hypotheses), instrumented-execution-and-candidate-fix (DeepSeek V4 Pro executes checklist with runtime instrumentation), falsifiable-verification-and-synthesis (GPT-5.5 judges with direct evidence). Falsifier must fail if execution route is wrong, evidence is static-grep-only, lifecycle paths omitted, or rollback missing. |
| `win-lifecycle-process-trace` | Non-invasive Windows lifecycle process-trace runbook and harness materialization. Planner (GPT-5.5) maps lifecycle boundaries, action markers, and correlation windows for cold start, open-from-Terminal, reload, and new-session. Executor (DeepSeek V4 Pro) produces non-invasive diagnostic harness scripts (PowerShell/WMI/ETW) with rollback/safety procedures. Verifier (GPT-5.5) judges harness materials: MUST FAIL if evidence is static-only, action markers missing, correlation windows undefined, lifecycle paths omitted, rollback absent, executor route wrong, or shape faked live evidence. Shape is non-invasive until a separate human-approved run — no live Pi interception, no config mutation. |
| `frozen-gate-fix-loop` | Bounded-fix loop for an EXISTING near-passing implementation against a FROZEN (sha256-content-locked) gate/spec document with enumerated residual findings. Phases 1 and 3 are DETERMINISTIC (non-LLM) sha256 verifications of the frozen document before and after each executor fix (tamper-proof); a mismatch is an automatic FAIL with zero LLM spawns. The executor fixes ONLY the enumerated findings (restructuring beyond scope is a verifier FAIL); an independent verifier re-checks raw artifacts with fail-closed JSON parsing; the loop retries bounded on verifier FAIL (default `maxRetries` 2). Route overrides honored; resume-supported (deterministic phases re-execute, completed LLM phases restore from checkpoint). |
| `evidence-audit` | Hardened re-verifier over a COMPLETED run's evidence (falsifier-grade `verify-only`). Phase 1 DETERMINISTIC `verify-hash` of the frozen gate document (mismatch ⇒ zero-spawn FAIL); Phase 2 DETERMINISTIC `manifest` (sha256 + bytes) of the declared gate-evidence files — a missing file is a zero-spawn FAIL, and the checkpointed manifest IS the audit fingerprint; Phase 3 spawns exactly ONE read-only verifier (NO executor) that audits run-id binding, internal consistency, and freshness from raw artifacts with fail-closed JSON; Phase 4 DETERMINISTIC `verify-hash` confirms the frozen doc was untouched. Never writes into the audited tree. Verifier route override honored; resume-supported. |
| `independent-replication` | Two INDEPENDENT implementations of ONE frozen gate in isolated lane subdirectories, routed to (ideally) different models, compared honestly. DETERMINISTIC `verify-hash` before, between (mid), and after the two lanes (tamper-proof; mismatch ⇒ FAIL at the next deterministic check with lane B not run). Each lane runs its own lane-confined executor (lane B forbidden from reading lane A) then an independent fail-closed verifier. Overall verdict is aggregated IN CODE (PASS iff both lanes PASS and all freeze checks hold); the diversity caveat is COMPUTED from the resolved lane routes (fully-disjoint vs shared-model narrowed). Per-lane route overrides honored; resume-supported. |
| `ssi-single-writer-exclusive-lane` | **Usable deterministic, production-proven SSI shape.** Three parallel read-only diagnoses → one synthesis → one allowlisted logical writer → two read-only source reviews → one cross-process-locked serialized native/Electron/WASAPI lane → at most one same-writer repair/retest → PASS-gated commit/push with independent remote verification. Use for integrated SSI work in a dirty shared checkout; not for small isolated changes or optional concurrent-rebuild stress. |

## Dynamic declarative workflow registry

Built-in/native shapes above remain registered in `src/index.ts` and retain their existing behavior. In addition, an unknown safe kebab-case `--paradigm` name is resolved as data on every invocation, without static imports or a module reload:

1. `<cwd>/.pi/orchestrator-workflows/<name>.workflow.json` (project scope, highest precedence)
2. `~/.pi/orchestrator-workflows/<name>.workflow.json` (user scope)

The environment overrides `PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT` and `PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT` are available for tests and controlled deployments. An invalid project artifact fails closed instead of falling back to a same-named user artifact, and declarative names cannot collide with built-in/native names.

Workflow documents use strict `schemaVersion: 1` JSON. Top-level fields are `name`, `description`, `phases`, `maxSubagents`, `maxConcurrency`, `maxIterations`, `continueOnFailure`, `terminationCondition`, `evidenceModel`, `failureBehavior`, and `userFacingExplanation`. Each phase defines `id`, `role`, `agentName`, `prompt`, optional `expectedOutput`, `dependsOn`, and optional `route` (`role: inherit|planner|executor|verifier`, plus optional `provider`/`model`). Unknown fields, malformed JSON, duplicate/missing/cyclic dependencies, unsafe names, and non-finite limits are rejected before any spawn.

The trusted-boundary policy requires a regular file whose canonical real path remains inside its canonical user/project root; path traversal and symlink/junction escapes are rejected. Documents are data only: no dynamic TypeScript import, coordinator shell/filesystem/network authority, private loader call, or recursive orchestration is exposed. Hard caps are 256 KiB per artifact, 64 name characters, 32 phases, 10 iterations, 64 total spawns, 16 concurrency, 16,000 prompt characters, 4,000 expected-output characters, and a 20,000-character final report.

Before use, `shape-builder` validates, rediscovers through this same resolver, and executes a deterministic DAG canary with zero subagent spawns. Each real run persists the canonical source path, scope, schema version, source SHA-256, validated-snapshot SHA-256, and exact validated IR. Resume uses that pinned snapshot rather than mutable source and fails closed if the pin is absent or inconsistent. Because these artifacts are user/project-owned and outside Pi's installed npm package, ordinary Pi self-updates cannot overwrite them.

### Usable deterministic native generated shapes

| Shape | Lifecycle | Select it when | Operational log |
|---|---|---|---|
| `ssi-single-writer-exclusive-lane` | `canary_passed`; usable; production-proven 2026-07-29 | Integrated SSI work combines source changes with native builds, process lifecycle, Electron/Playwright, or WASAPI and requires one writer plus non-overlapping machine gates. | [`shape-builder-lifecycle/ssi-single-writer-exclusive-lane-OPERATIONS.md`](shape-builder-lifecycle/ssi-single-writer-exclusive-lane-OPERATIONS.md) |

A shape belongs in this usable list only after registration, source tests, independent verification, runtime discovery, and a zero-spawn canary. Source presence alone is insufficient.

### `ssi-single-writer-exclusive-lane` usage

```text
/orchestrate --paradigm ssi-single-writer-exclusive-lane --executor-model gpt-5.6-sol --executor-provider openai-codex "<authoritative SSI task with exact serial ordinary gates and cleanup requirements>"
```

The task must distinguish ordinary SSI product acceptance from optional stress/developer experiments. Allowed executor routes are `openai-codex/gpt-5.6-sol`, `openai-codex/gpt-5.5`, and direct `zai/glm-5.2`; DeepSeek, OpenRouter, and unlisted executor routes fail before any work spawn. The shape uses strict JSON verdicts, working-content fingerprints, a scheduler-owned atomic machine lock, one bounded same-writer repair, full serialized retest, cleanup proof, and independent local/remote Git equality.

Read the [operations and usage log](shape-builder-lifecycle/ssi-single-writer-exclusive-lane-OPERATIONS.md) before using it. If an already-running Pi process says the paradigm is unknown, do not substitute another shape: fully restart Pi and run `SHAPE_CANARY:ssi-single-writer-exclusive-lane` because local-package `/reload` currently has a known stale-module defect.

### `evidence-audit` usage

```text
/orchestrate --paradigm evidence-audit "Audit the completed run's evidence.
FROZEN_DOC_PATH: ../PREREG.md
FROZEN_DOC_SHA256: <64-hex sha256>
EVIDENCE_CWD: ../runs/orc-....
RUN_ID_LABEL: orc-....
AUDIT_FOCUS: confirm run-id binding and recomputable gate metrics
GATE_EVIDENCE_FILES:
- gate-metrics.json
- verify.log"
```

Labeled inputs (case-insensitive), in the task and/or a referenced `SPEC_FILE` (spec-file pattern preferred): `FROZEN_DOC_PATH`, `FROZEN_DOC_SHA256`, `EVIDENCE_CWD` (the completed run directory to audit), optional `RUN_ID_LABEL`, optional `AUDIT_FOCUS`, optional `GATE_EVIDENCE_FILES` (inline `;`-separated and/or subsequent bullet lines, each **relative to `EVIDENCE_CWD`**, glob-free, staying under it). Phases: (1) `freeze-verify` DETERMINISTIC `verify-hash` — mismatch ⇒ zero-spawn FAIL; (2) `evidence-manifest` DETERMINISTIC `manifest` (cwd = `EVIDENCE_CWD`) — a missing/invalid file is a zero-spawn FAIL; the manifest is checkpointed as the audit fingerprint; (3) `integrity-audit` — exactly ONE verifier (NO executor), READ-ONLY intent toward the evidence cwd (read-only recompute allowed; writing into the audited tree is a contract violation), strict fail-closed JSON verdict; (4) `final-re-verify` DETERMINISTIC `verify-hash` — frozen doc untouched. Only `verifierModel`/`verifierProvider` overrides apply (there is no executor role); the report `Routes:` line derives from the resolved value. Resume-supported (deterministic phases re-execute; the completed verifier restores from checkpoint).

### `independent-replication` usage

```text
/orchestrate --paradigm independent-replication "Two independent implementations of the frozen gate.
FROZEN_DOC_PATH: ../GATE.md
FROZEN_DOC_SHA256: <64-hex sha256>
BASE_CWD: ../replication
LANE_A_SUBDIR: laneA
LANE_B_SUBDIR: laneB
LANE_B_EXECUTOR_PROVIDER: deepseek
LANE_B_EXECUTOR_MODEL: deepseek-v4-pro
LANE_B_VERIFIER_PROVIDER: openai-codex
LANE_B_VERIFIER_MODEL: gpt-5.5"
```

Labeled inputs (case-insensitive), in the task and/or a referenced `SPEC_FILE`: `FROZEN_DOC_PATH`, `FROZEN_DOC_SHA256`, `BASE_CWD`, optional `LANE_A_SUBDIR` (default `laneA`), `LANE_B_SUBDIR` (default `laneB`), optional lane-B route overrides `LANE_B_EXECUTOR_PROVIDER/MODEL` and `LANE_B_VERIFIER_PROVIDER/MODEL`. Lane A routes come from the standard `executorModel`/`executorProvider` and `verifierModel`/`verifierProvider` params; lane B falls back to lane A routes when its labels are absent (which triggers the narrowed-independence caveat). Phases: (1) `freeze-verify` DETERMINISTIC — mismatch ⇒ zero-spawn FAIL; (2) `implement-A` executor (confined to `laneA`) → (3) `verify-A` verifier (fail-closed JSON); (4) `mid-re-verify` DETERMINISTIC — a lane-A tamper ⇒ FAIL, lane B not run; (5) `implement-B` executor per lane-B routes (confined to `laneB`, forbidden from reading `laneA`) → (6) `verify-B` verifier per lane-B routes; (7) `final-re-verify` DETERMINISTIC; (8) IN-CODE aggregation — overall PASS iff `verdictA==pass && verdictB==pass &&` all three freeze checks passed. The report auto-emits a diversity statement COMPUTED from the resolved routes: "fully disjoint" when both executor and verifier routes differ, else a narrowed-independence caveat naming the shared model(s). Resume-supported.

### `dual-plan-synthesis-execute-verify` usage

```text
/orchestrate --paradigm dual-plan-synthesis-execute-verify --max-retries 2 "Fix a scheduler delivery race and verify with direct evidence"
```

This shape is intentionally route-specific for high-stakes implementation loops:

1. Plan A and Plan B use the planner-role route (default `openai-codex/gpt-5.6-sol`).
2. Synthesis uses the same planner-role route and produces the only plan the executor may implement.
3. Execution uses the executor-role route (default `openai-codex/gpt-5.6-sol`).
4. Verification uses the verifier-role route (default `openai-codex/gpt-5.5`), returning JSON PASS/FAIL with evidence and retry feedback.
5. Explicit per-role provider/model overrides are honored; retries remain bounded.
6. On FAIL, only the executor + verifier phases repeat, bounded by `maxRetries`; planning and synthesis are not repeated.

### `verify-only` usage

```text
/orchestrate --paradigm verify-only "Evidence checklist: 1) src/app.ts exports startServer 2) tests pass via npm test. Paths: src/, tests/"
```

It is also auto-selected when the task contains `verify-only`, `verification only`,
`just verify`, `only verify`, or `re-verify`.

### `win-console-spawn-root-cause` usage

```text
/orchestrate --paradigm win-console-spawn-root-cause "Investigate remaining console flashes on Pi reload and new-session"
```

This shape is intentionally route-specific for Windows console investigation:

1. `intake-boundary-plan` runs as `provider=openai-codex`, `model=gpt-5.5` — maps boundaries, hypotheses, and instrumentation plan. No file edits.
2. `instrumented-execution-and-candidate-fix` runs as `provider=deepseek`, `model=deepseek-v4-pro` — executes the planner checklist only. Requires runtime instrumentation (WMI/ETW/ProcMon or diagnostic spawn logging) around Pi startup, reload, new-session, and open-from-Terminal. May produce a minimal candidate fix with rollback limits.
3. `falsifiable-verification-and-synthesis` runs as `provider=openai-codex`, `model=gpt-5.5` — independently judges using direct evidence. Must FAIL if orchestrator did main-task work, execution was not DeepSeek V4 Pro, evidence is static-grep-only, lifecycle paths were not separately exercised, boundaries were omitted, Windows console mechanics not addressed, rollback path missing, or fix too broad.

Model/provider overrides: `plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`, `verifierModel`/`verifierProvider`. When absent, defaults above apply via `modelOverride`.

### `win-lifecycle-process-trace` usage

```text
/orchestrate --paradigm win-lifecycle-process-trace "Create a non-invasive diagnostic harness for tracing Windows Pi process creation across cold start, reload, and new-session lifecycles"
```

This shape is intentionally route-specific and non-invasive:

1. `trace-runbook-and-harness-plan` runs as `provider=openai-codex`, `model=gpt-5.5` — maps lifecycle paths (cold start, open-from-Terminal, reload, new-session), defines action markers and correlation windows, produces instrumentation plan. No file edits, no process launch.
2. `non-invasive-harness-materialization` runs as `provider=deepseek`, `model=deepseek-v4-pro` — materializes non-invasive diagnostic harness scripts (PowerShell/WMI/ETW), verification checklist, action-marker implementation, and rollback/safety procedures. NON-INVASIVE: no Pi config mutation, no live Pi interception, no Windows registry changes.
3. `trace-evidence-verification` runs as `provider=openai-codex`, `model=gpt-5.5` — independently judges harness materials against falsifiable contract. Must FAIL if orchestrator did main-task work, executor route is wrong, evidence is static-only (no external process-creation logging references), action markers missing, correlation windows missing, lifecycle paths omitted (cold/reload/new-session), rollback/safety absent, or shape faked live evidence.

Model/provider overrides: `plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`, `verifierModel`/`verifierProvider`. When absent, defaults above apply via `modelOverride`.

### `frozen-gate-fix-loop` usage

```text
/orchestrate --paradigm frozen-gate-fix-loop "Bounded fix against the frozen gate.
FROZEN_DOC_PATH: ../PREREG.md
FROZEN_DOC_SHA256: <64-hex sha256>
SPEC_FILE: ../RESIDUALS.md
FINDINGS:
- residual 1: <what to fix>
- residual 2: <what to fix>"
```

Labeled inputs (case-insensitive), supplied in the task text and/or a referenced spec file — **the spec-file pattern is preferred** so every role reads the same authoritative source first:

- `FROZEN_DOC_PATH:` — path to the frozen pre-registration/gate document (relative resolves to cwd; absolute allowed, so the gate may live outside cwd).
- `FROZEN_DOC_SHA256:` — the frozen document's reference sha256 (64-hex).
- `FINDINGS:` — enumerated residual findings to fix (inline `;`-separated and/or subsequent bullet lines).
- `SPEC_FILE:` — optional path to a residuals/spec file roles must read first.
- `RUN_ID_LABEL:` — optional fresh run-id label for the gate pipeline.

Phases: (1) `freeze-verify` DETERMINISTIC `verify-hash` — mismatch ⇒ automatic FAIL, **no LLM ever spawned**; (2) `bounded-fix-<k>` executor — fix EXACTLY the enumerated findings, rerun the gate pipeline with a fresh run-id; (3) `re-verify-freeze-<k>` DETERMINISTIC `verify-hash` tamper check — mismatch ⇒ automatic FAIL, **no verifier spawn that attempt**; (4) `verify-<k>` verifier — raw-artifact verification, diff-scope boundedness, run-id binding, strict fail-closed JSON verdict (`{"overall":"pass"|"fail","reasons":[...],"feedback":"...","evidence":[...]}`; empty/unparseable/unknown/non-exact-`pass` ⇒ FAIL); (5) bounded retry — on verifier FAIL with slots left, feed `feedback`/`reasons` into a new `bounded-fix`. Deterministic failures are fail-closed with NO retry (retrying a pure function is pointless). Model/provider overrides: `executorModel`/`executorProvider`, `verifierModel`/`verifierProvider`; the report `Routes:` line derives from the SAME resolved values passed to the spawns, and no provider/model name is hardcoded in the narrative.

The deterministic sha256 verifications use the shared non-LLM phase primitive (`src/deterministic-phase.ts`, v1 ops `hash-file`, `verify-hash`, `freeze-record`, `manifest`): pure Node stdlib (crypto/fs/path), no subagent spawn, no network, no arbitrary command execution. Deterministic phase outputs are checkpointed via `RunStateStore` with a `deterministic: true` marker and rendered in reports with a `DETERMINISTIC (no LLM)` tag.

### `paradigm-creator` usage

```text
/orchestrate --paradigm paradigm-creator "Propose a bounded red-team / blue-team / judge paradigm for migration audits"
```

V1 is intentionally conservative:

- **Explicit-only**: it is available by `--paradigm paradigm-creator` or the tool `paradigm` parameter. There is no fuzzy natural-language auto-selection trigger.
- **Propose-only by default**: it renders candidate TypeScript shape code plus exact registry/docs/test guidance, but performs no file writes and does not mutate the orchestrator during the run.
- **Deterministic spine in TypeScript**: name normalization, spec validation, confidence gating (`>= 0.85`), template rendering, and generated-source static checks are implemented as shape helpers rather than delegated to an LLM verdict.
- **Bounded substrate use**: it uses `SpawnGuard` and `spawnSubagent` for exactly one assessment planner spawn.
- **V1 validation limits**: `maxIterations` must be exactly `1` because the generated template runs a single sequential pass. `maxSubagents` must be at least the number of proposed phases (`phases.length`). Registered paradigm names (all entries in `shapeRegistry`) are reserved and cannot be reused.
- **Reload handoff only**: after a future human or explicit apply step writes files and tests pass, the parent Pi session must schedule continuation, trigger a runtime reload, stop, read reload diagnostics first, and verify runtime discovery before using the new paradigm. The shape itself does not reload or schedule anything.

Human gate cases include low confidence, vague specs, reserved names, missing phases, unbounded-loop language such as "keep iterating until perfect," sibling-shape imports in generated code, or missing static bounds.

### `shape-builder` usage

```text
/orchestrate --paradigm shape-builder "SHAPE_BUILDER_SPEC_JSON\n{\n  \"schemaVersion\": 1,\n  \"action\": \"build\",\n  \"targetName\": \"my-shape\",\n  \"purpose\": \"...\",\n  \"phases\": [...],\n  \"maxSubagents\": 3,\n  \"maxIterations\": 1,\n  \"terminationCondition\": \"...\",\n  \"evidenceModel\": \"...\",\n  \"failureBehavior\": \"...\",\n  \"userFacingExplanation\": \"...\"\n}"
```

The builder is explicit-only (`--paradigm shape-builder`) and has two artifact modes:

- **Declarative workflow (default)**: omit `artifactKind` or use `"artifactKind": "declarative-workflow"`. `scope` defaults to `"user"`; `"project"` selects the current `cwd` project root. The builder compiles a normal spec to JSON, publishes it atomically inside the trusted root, validates it, resolves it through the live invocation-time resolver, and runs the zero-spawn canary. Lifecycle is `proposed → implementation_reported → declarative_verified → runtime_discovered → canary_passed`; success is immediately `usable: true`, `reloadRequired: false`, `nextRequiredGate: "none"`. No TypeScript, per-workflow test module, static registry import, reload, or subprocess verifier is generated.
- **Native shape (explicit opt-in)**: use `"artifactKind": "native-shape"` only for genuine extension/substrate behavior that cannot be represented as data. It retains extension-root-relative TypeScript/test generation, anchored registry/docs/test edits, independent verifier JSON, sibling-shape/static safety checks, and lifecycle `proposed → implementation_reported → implemented_verified → (parent reload) → reloaded_discovered → canary_passed`. Pre-reload success remains `usable: false`, `reloadRequired: true`, `nextRequiredGate: "agent_reload"`.

Neither mode calls `agent_reload_runtime`, `agent_scheduler`, `pi.executeCommand`, private loader APIs, `sendUserMessage`, or recursive orchestration. The native branch's `SHAPE_CANARY:<name>` is post-reload; the declarative branch's graph canary is completed in the build run.

### Generated shape spec format

Strict JSON spec consumed by shape-builder:

```json
{
  "schemaVersion": 1,
  "action": "build",
  "artifactKind": "declarative-workflow",
  "scope": "user",
  "targetName": "safe-kebab-name",
  "purpose": "what reusable loop this implements",
  "phases": [
    {"name": "phase-name", "role": "role", "agentName": "coder", "prompt": "...", "expectedOutput": "..."}
  ],
  "maxSubagents": 3,
  "maxIterations": 1,
  "terminationCondition": "finite stopping rule",
  "evidenceModel": "what evidence proves completion",
  "failureBehavior": "what makes the shape fail",
  "userFacingExplanation": "how to explain the orchestration after use"
}
```

`artifactKind` defaults to `declarative-workflow`; `scope` defaults to `user` and may be `project`. Shape-builder specs are intentionally narrower than hand-authored workflow schema: 1–8 sequential phases, integer `maxSubagents` from 1–20, and exactly one iteration. Parsing rejects unknown top-level/phase fields and wrong JSON types instead of discarding or coercing them. Validation requires an already-safe lowercase kebab-case target, unique normalized phase IDs, bounded identifier tokens, and the dynamic runtime's text caps; it also rejects native/declarative collisions, missing phases, unbounded-loop language, sibling-import text, and forbidden runtime calls. Atomic publication refuses symlinks, non-regular entries, differing existing artifacts, and a user build hidden by project precedence. The compiled workflow then passes the stricter dynamic schema validator described above.

### Native-mode independent verifier contract

This contract applies only to explicit `artifactKind: "native-shape"`. The verifier (cloned from reviewer profile with `read/bash/grep` tools) must gather direct evidence and return strict JSON:

```json
{
  "overall": "pass" | "fail",
  "implemented_verified": true | false,
  "reloadRequired": true | false,
  "targetName": "<name>",
  "lifecycleStatePath": "<absolute path>",
  "checks": [
    {"id": "files", "status": "pass"|"fail", "citations": ["file:line"]},
    ... 8 required check IDs: files, registry, docs, tests, forbidden-behavior, sibling-rule, lifecycle, canary-template
  ],
  "commands": [
    {"command": "node tests/test-<target>.cjs", "exitCode": 0, "stdoutSnippet": "PASS"},
    {"command": "npm test", "exitCode": 0, "stdoutSnippet": "PASS"}
  ],
  "failReasons": []
}
```

Parse failure, overall "fail", any check "fail", or any missing required field → `implemented_verified: false`. Only strict PASS advances lifecycle.

## Judgment layer: hard gates and effect evidence

All paradigms run under the judgment layer introduced by the 2026-06-12
hardening (effect-based verdicts):

- **`hardGates: "strict" | "advisory" | "off"`** (default `advisory`):
  - `advisory` — text-shape heuristics (truncation signals, "text-only
    response", short-output checks, escape-clause scans, file-claim regexes)
    are demoted to report warnings; the verifier's evidenced verdict is the
    gate; hard gates only escalate (force FAIL) on effect-based
    contradictions (e.g. verifier PASS with zero observed mutations for
    implementation work — the 2026-06-03 false-PASS class).
  - `strict` — effect findings and non-immune text-shape findings fail fast
    before the verifier spawn.
  - `off` — everything is a warning; the verifier verdict is final.
- **Effect-evidence immunity**: a task with ≥1 successful mutating tool call
  (write/edit/bash) or ≥1 worktree file change can NEVER be failed by a
  text-shape heuristic, in any mode.
- Per-task tool-call counts and worktree deltas are exposed in the report and
  in the verifier's ARTIFACT EVIDENCE block.

## Orchestrator Role Integrity

When an orchestration paradigm runs, the visible/current agent is the ORCHESTRATOR and must not execute the main task directly. Every run must produce an *Orchestrator Role Integrity Ledger* recording: requested shape/tool; current role = ORCHESTRATOR; subagents spawned + roles; subagent artifacts; direct orchestrator actions; classification (orchestration support / diagnostics / repair / verification / handoff); explicit statement whether orchestrator executed any main-task work; context checkpoints; repair attempts + outcomes; final role-integrity verdict.

**Repair-only fallback:** On orchestration failure, repair the requested shape/tool; do not switch shapes or execute the main task directly. Provider/model fallback is allowed; shape substitution is forbidden.

**Dual-plan verifier falsifier for role collapse:** The verifier must FAIL if evidence shows the visible/current orchestrator executed the main task directly instead of routing through the requested orchestration shape, or if the requested shape was silently replaced. See `agent/AGENTS.md` for the canonical policy.

## Selecting a Paradigm

Via the tool parameter:

```json
{
  "task": "Your task description",
  "paradigm": "multi-verify-vote"
}
```

Via the slash command (see `/orchestrate` for all flags):

```
/orchestrate --paradigm multi-verify-vote "Your task description"
```

If no paradigm is specified, `plan-execute-verify` is used by default. `paradigm-creator` is not inferred from natural language in v1; select it explicitly.

To list all available paradigms at runtime, use an unknown paradigm name:

```
/orchestrate --paradigm unknown-name "task"
```

This will fail with a message listing all registered paradigms.

## Architecture: Substrate, native shapes, and declarative workflows

The orchestrate extension keeps one safety substrate under two workflow sources:

### Layer A — Substrate (`substrate.ts`)

Role-agnostic safety and plumbing. The substrate **never** mentions planner, executor, verifier, verdict, or retry. It provides:

| Function/Class | Purpose |
|---|---|
| `spawnSubagent()` | Spawn a single isolated Pi subagent process |
| `runBoundedPool()` | Run a bounded pool of concurrent workers |
| `buildExecutionWaves()` | Build a topological wave schedule from items with `id`/`dependsOn` |
| `runWorkGraph()` | Run a work graph (array of waves) through a bounded pool |
| `SpawnGuard` | Monotonic spawn-ceiling guard |
| `SUBSTRATE_CAPS` | Hard non-negotiable caps (`MAX_TOTAL_SPAWNS`, `ABSOLUTE_MAX_ITERATIONS`) |
| `clampSpawnCeiling()` | Clamp shape-requested spawn ceiling through substrate hard cap |
| `clampIterations()` | Clamp shape-requested iteration count through substrate hard cap |

**Substrate guarantee:** Bounded/cannot-run-forever is a substrate-level guarantee. No shape, no matter what it requests, can run forever or spawn unbounded subagents. The substrate clamps every value.

### Layer B1 — Built-in/native shapes (`shapes/` directory)

Each native shape implements the `OrchestrationShape` interface defined in `types.ts`:

```typescript
interface OrchestrationShape {
  name: string;           // Unique identifier (used with --paradigm)
  description: string;    // Human-readable description
  run(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult>;
}
```

**ONE-LINE RULE: Shapes are siblings, they stand on the substrate, they never build on each other.**

Every native shape:
- Receives normalized parameters via `OrchestrationShapeContext`
- Uses only substrate primitives (`spawnSubagent`, `runBoundedPool`, etc.)
- Never imports, extends, or calls another shape
- Never assumes or depends on another shape's internal behavior

### Layer B2 — Declarative resolver/runner (`dynamic-workflow.ts`)

The invocation-time resolver converts strict JSON into a fully defaulted validated IR, schedules dependency waves through substrate primitives, and records immutable provenance. It never imports workflow code. Native registry lookup happens first, so existing built-ins and the current `orchestrate` tool remain unchanged and cannot be shadowed.

## How to Add a New Workflow

For the normal path, call the existing `orchestrate` tool with `paradigm: "shape-builder"` and a `SHAPE_BUILDER_SPEC_JSON` task. Do not add a TypeScript file or edit `shapeRegistry`:

```text
/orchestrate --paradigm shape-builder "SHAPE_BUILDER_SPEC_JSON
{
  \"schemaVersion\": 1,
  \"action\": \"build\",
  \"scope\": \"user\",
  \"targetName\": \"my-custom-workflow\",
  \"purpose\": \"A bounded reusable workflow\",
  \"phases\": [{\"name\":\"do-work\",\"role\":\"executor\",\"agentName\":\"coder\",\"prompt\":\"Complete the task.\",\"expectedOutput\":\"Changed files and checks.\"}],
  \"maxSubagents\": 1,
  \"maxIterations\": 1,
  \"terminationCondition\": \"One pass\",
  \"evidenceModel\": \"Machine checks\",
  \"failureBehavior\": \"Fail on phase failure\",
  \"userFacingExplanation\": \"One bounded implementation phase\"
}"
```

On PASS, run it immediately with `/orchestrate --paradigm my-custom-workflow "..."`. A trusted editor may also author schema-v1 JSON directly in a trusted root.

To add an executable native shape, explicitly request `artifactKind: "native-shape"` or implement an `OrchestrationShape` using only substrate primitives, add its static import/registration and tests, then reload/restart Pi. Native extension work is the exceptional path and retains all existing safety and reload gates.

## Native Shape-Builder Generated Shapes

<!-- shape-builder:generated-shapes:start -->
- `venue-rescue-synthesis`: venue-rescue-synthesis runs cheap text research and a vision-based brand audit, then a specialist financial narrative, then a strong synthesis-and-critique that fuses everything into a rescue strategy with wild and practical options, then a design phase that builds a stylish interactive investor site, then an independent verification.
- `m66-explicit-routing-proof`: Build-time generated M6.6 proof shape for explicit route, context-isolation, executor-control, and two-verifier dispatch acceptance.
- [`ssi-single-writer-exclusive-lane`](shape-builder-lifecycle/ssi-single-writer-exclusive-lane-OPERATIONS.md) (**usable — canary passed; production-proven 2026-07-29**): Runs parallel read-only SSI diagnosis, one synthesized plan, one logical non-DeepSeek source writer, parallel source review, and a single serialized build/native/Electron/WASAPI lane with one bounded feedback pass before verified commit/push and a listening card.
<!-- shape-builder:generated-shapes:end -->

## Design Rules

1. **Shapes are siblings.** They stand on the substrate and never import, extend, or call each other.
2. **The substrate enforces bounds.** Always use `SpawnGuard` and clamp values through `SUBSTRATE_CAPS` helpers.
3. **Default is `plan-execute-verify`.** Unknown paradigm names list available shapes and stop with an error.
4. **Each shape owns its meaning of termination.** The substrate only enforces that iterations/spawns are finite. What "retry," "vote," or "attempt" means is entirely shape-owned.
5. **No cross-shape code reuse.** If functionality is needed by multiple shapes, it belongs in the substrate.
6. **Declarative creation is data-only.** Ordinary `shape-builder` specs publish under a trusted user/project root, then require same-process validation, resolver discovery, and a zero-spawn canary before returning usable; no reload or static registry edit occurs.
7. **Native self-extension remains reload-gated.** `paradigm-creator` proposes native code, and explicit `artifactKind: "native-shape"` preserves independent verification, parent-session reload, active-runtime discovery, and post-reload canary. No native shape is marked usable before those gates.
