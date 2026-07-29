# Orchestration Paradigms (Shapes)

This document describes the orchestration paradigms (shapes) available in the Pi orchestrate extension and how to add new ones.

## Available Paradigms

| Name | Description |
|------|-------------|
| `plan-execute-verify` | Classic planner → executor waves → verifier flow. Default paradigm. Supports retries with failure feedback and deterministic model routing checks. |
| `multi-verify-vote` | Planner → executor waves → multiple verifiers (odd count) → majority vote. Each verifier independently judges pass/fail; outcome is decided by majority. |
| `composable-pipeline` | Dynamic pipeline composition via natural language (hypothesize → critique → synthesize → plan → execute → verify, with per-phase counts). |
| `dual-plan-synthesis-execute-verify` | Two independent routed planners (OpenRouter GLM 5.2 + OpenAI Codex GPT 5.5) → Opus 4.8 synthesis reviewer → DeepSeek V4 Pro executor → GPT 5.5 direct-evidence verifier, with bounded executor retry feedback. |
| `verify-only` | Verification-only: input is an evidence checklist + paths; spawns verifier(s) ONLY (no planner, no executors); output is per-check verdicts with citations. Supports multi-verifier majority vote ("3 verifiers" in the task text). Exempt from all implementation-task heuristics — verification output is legitimately text-only. Verifiers are granted read/bash/grep tools so they can gather and cite evidence independently. |
| `paradigm-creator` | Conservative meta-orchestration for proposing new reusable paradigms. V1 is explicit-only and propose-only: it runs one bounded assessment planner, then deterministic TypeScript helpers normalize the name, validate the spec, gate confidence, render a template, run static checks, and return reload handoff details without writing files. |
| `shape-builder` | Deterministic meta-constructor for creating new orchestration shapes with full lifecycle gating. V1 is explicit-only: parses strict spec JSON, writes generated shape/test source, applies anchored registry/docs edits, runs independent verification, and returns `reloadRequired: true` when verified. Does not reload or mark usable before post-reload discovery and canary. |
| `win-console-spawn-root-cause` | Downstream Windows console-spawn flash root-cause investigation. Routes execution to DeepSeek V4 Pro and higher-level reasoning to GPT-5.5. Three finite phases: intake-boundary-plan (planner maps boundaries/hypotheses), instrumented-execution-and-candidate-fix (DeepSeek V4 Pro executes checklist with runtime instrumentation), falsifiable-verification-and-synthesis (GPT-5.5 judges with direct evidence). Falsifier must fail if execution route is wrong, evidence is static-grep-only, lifecycle paths omitted, or rollback missing. |
| `win-lifecycle-process-trace` | Non-invasive Windows lifecycle process-trace runbook and harness materialization. Planner (GPT-5.5) maps lifecycle boundaries, action markers, and correlation windows for cold start, open-from-Terminal, reload, and new-session. Executor (DeepSeek V4 Pro) produces non-invasive diagnostic harness scripts (PowerShell/WMI/ETW) with rollback/safety procedures. Verifier (GPT-5.5) judges harness materials: MUST FAIL if evidence is static-only, action markers missing, correlation windows undefined, lifecycle paths omitted, rollback absent, executor route wrong, or shape faked live evidence. Shape is non-invasive until a separate human-approved run — no live Pi interception, no config mutation. |
| `frozen-gate-fix-loop` | Bounded-fix loop for an EXISTING near-passing implementation against a FROZEN (sha256-content-locked) gate/spec document with enumerated residual findings. Phases 1 and 3 are DETERMINISTIC (non-LLM) sha256 verifications of the frozen document before and after each executor fix (tamper-proof); a mismatch is an automatic FAIL with zero LLM spawns. The executor fixes ONLY the enumerated findings (restructuring beyond scope is a verifier FAIL); an independent verifier re-checks raw artifacts with fail-closed JSON parsing; the loop retries bounded on verifier FAIL (default `maxRetries` 2). Route overrides honored; resume-supported (deterministic phases re-execute, completed LLM phases restore from checkpoint). |
| `evidence-audit` | Hardened re-verifier over a COMPLETED run's evidence (falsifier-grade `verify-only`). Phase 1 DETERMINISTIC `verify-hash` of the frozen gate document (mismatch ⇒ zero-spawn FAIL); Phase 2 DETERMINISTIC `manifest` (sha256 + bytes) of the declared gate-evidence files — a missing file is a zero-spawn FAIL, and the checkpointed manifest IS the audit fingerprint; Phase 3 spawns exactly ONE read-only verifier (NO executor) that audits run-id binding, internal consistency, and freshness from raw artifacts with fail-closed JSON; Phase 4 DETERMINISTIC `verify-hash` confirms the frozen doc was untouched. Never writes into the audited tree. Verifier route override honored; resume-supported. |
| `independent-replication` | Two INDEPENDENT implementations of ONE frozen gate in isolated lane subdirectories, routed to (ideally) different models, compared honestly. DETERMINISTIC `verify-hash` before, between (mid), and after the two lanes (tamper-proof; mismatch ⇒ FAIL at the next deterministic check with lane B not run). Each lane runs its own lane-confined executor (lane B forbidden from reading lane A) then an independent fail-closed verifier. Overall verdict is aggregated IN CODE (PASS iff both lanes PASS and all freeze checks hold); the diversity caveat is COMPUTED from the resolved lane routes (fully-disjoint vs shared-model narrowed). Per-lane route overrides honored; resume-supported. |
| `safe-github-publish` | Sanitization contract → delegated clean staging/publish → independent remote verification. Private-first repository creation with gitleaks scanning, path denylists, and explicit mode separation. |

### `safe-github-publish` usage

```text
/orchestrate --paradigm safe-github-publish "Publish this project as my-repo"
```

The planner defines explicit allowlists/denylists; the executor builds a clean staging tree without source `.git/` history, scans it, creates/pushes the repository private-first, and the verifier independently clones and checks the remote. The visible orchestrator never performs the publishing work directly.

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

1. Plan A runs as `provider=openrouter`, `model=z-ai/glm-5.2`.
2. Plan B runs independently as `provider=openai-codex`, `model=gpt-5.5`.
3. Synthesis runs as `provider=anthropic`, `model=claude-opus-4-8` and produces the only plan the executor may implement.
4. Execution runs as `provider=deepseek`, `model=deepseek-v4-pro`.
5. Verification runs as `provider=openai-codex`, `model=gpt-5.5`, returning JSON PASS/FAIL with evidence and retry feedback.
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

V1 is intentionally conservative:

- **Explicit-only**: available only by `--paradigm shape-builder` or the tool `paradigm` parameter. No fuzzy natural-language auto-selection.
- **Deterministic**: all parsing, validation, rendering, and static checks are in-process TypeScript, not LLM-delegated.
- **Lifecycle gating**: shapes progress through `proposed → implementation_reported → implemented_verified → (parent reload) → reloaded_discovered → canary_passed`. Only `canary_passed` is usable.
- **Independent verifier**: `implemented_verified` is set only by strict parsed independent verifier JSON evidence — the executor's own narrative is never trusted.
- **No reload in shape**: `reloadRequired: true` is a handoff signal to the visible ORCHESTRATOR. The shape never calls `agent_reload_runtime`, `agent_scheduler`, `executeCommand`, or `sendUserMessage`.
- **Anchored edits only**: registry/docs/test modifications use deterministic anchors (`// shape-builder generated ... :start` / `:end`). No free-form LLM rewrites of central files.
- **Extension-root-relative**: all writes are resolved from the extension root, never from `params.cwd`. Temp-root override via `PI_SHAPE_BUILDER_EXTENSION_ROOT`.
- **Sibling-shape rule**: generated shapes import only substrate/types. No sibling imports are permitted. Static checks enforce this.
- **Canary branch**: every generated shape includes a deterministic `SHAPE_CANARY:<name>` branch that returns `{ canary: true, spawnedCount: 0 }` without spawning subagents or mutating files. Post-reload canary through active runtime is the final gate.

### Generated shape spec format

Strict JSON spec consumed by shape-builder:

```json
{
  "schemaVersion": 1,
  "action": "build",
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

Validation rejects: unsafe names, reserved/registered names, missing phases, >8 phases, `maxIterations !== 1`, unbounded-loop language, sibling imports, and forbidden runtime calls.

### Independent verifier contract

The verifier (cloned from reviewer profile with `read/bash/grep` tools) must gather direct evidence and return strict JSON:

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

## Orchestration mode

When the user explicitly requests orchestration, the current agent coordinates the selected shape and its isolated subagents. It must not quietly execute the main task directly while claiming delegation occurred. The shape's own reports, checkpoints, and gates are sufficient; do not add role ledgers or closeout paperwork.

On failure, diagnose and repair the specific product or orchestration defect, then re-run while there is material progress. Provider/model fallback and reversible scope reduction are allowed. Involve the user only for material subjective choices, irreversible actions, unavailable credentials/hardware, or sustained no-progress. See `agent/AGENTS.md` for the canonical policy.

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

## Architecture: Substrate and Shapes

The orchestrate extension uses a **two-layer architecture**:

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

### Layer B — Shapes (`shapes/` directory)

Each shape implements the `OrchestrationShape` interface defined in `types.ts`:

```typescript
interface OrchestrationShape {
  name: string;           // Unique identifier (used with --paradigm)
  description: string;    // Human-readable description
  run(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult>;
}
```

**ONE-LINE RULE: Shapes are siblings, they stand on the substrate, they never build on each other.**

Every shape:
- Receives normalized parameters via `OrchestrationShapeContext`
- Uses only substrate primitives (`spawnSubagent`, `runBoundedPool`, etc.)
- Never imports, extends, or calls another shape
- Never assumes or depends on another shape's internal behavior

## How to Add a New Shape

1. Create a new file in `src/shapes/` (e.g., `my-custom-shape.ts`).

2. Implement `OrchestrationShape` using **only** substrate primitives:

```typescript
// my-custom-shape.ts
import { spawnSubagent, runBoundedPool, SpawnGuard, SUBSTRATE_CAPS, /* ... */ } from "../substrate";
import type { OrchestrationShape, OrchestrationShapeContext, OrchestrationShapeResult } from "../types";

export const myCustomShape: OrchestrationShape = {
  name: "my-custom-shape",
  description: "Brief description of what this shape does.",
  run: async (context: OrchestrationShapeContext): Promise<OrchestrationShapeResult> => {
    const { params, signal, onUpdate, inheritedModel, agents } = context;

    // Use spawnGuard to bound all subagent spawns
    const spawnGuard = new SpawnGuard(params.maxSubagents);

    // Phase 1: Plan
    const planResult = await spawnSubagent(params.plannerAgent, buildPrompt(params.task), { /* ... */ });

    // Phase 2: Execute using runWorkGraph / runBoundedPool
    // Phase 3: Verify / vote / etc.

    return { markdown: "...", details: { /* ... */ } };
  },
};
```

3. Register the shape in `src/index.ts`:

```typescript
import { myCustomShape } from "./shapes/my-custom-shape";
// ...
shapeRegistry.set(myCustomShape.name, myCustomShape);
```

4. That's it. The shape is now available via `--paradigm my-custom-shape`.

For programmatic creation, use `shape-builder` which handles lifecycle gating, independent verification, and reload handoff:

```text
/orchestrate --paradigm shape-builder "{...spec json...}"
```

See the `shape-builder` section above for the full spec format and lifecycle contract.

## Shape-Builder Generated Shapes

<!-- shape-builder:generated-shapes:start -->
- `m66-explicit-routing-proof`: Build-time generated M6.6 proof shape for explicit route, context-isolation, executor-control, and two-verifier dispatch acceptance.
<!-- shape-builder:generated-shapes:end -->

## Design Rules

1. **Shapes are siblings.** They stand on the substrate and never import, extend, or call each other.
2. **The substrate enforces bounds.** Always use `SpawnGuard` and clamp values through `SUBSTRATE_CAPS` helpers.
3. **Default is `plan-execute-verify`.** Unknown paradigm names list available shapes and stop with an error.
4. **Each shape owns its meaning of termination.** The substrate only enforces that iterations/spawns are finite. What "retry," "vote," or "attempt" means is entirely shape-owned.
5. **No cross-shape code reuse.** If functionality is needed by multiple shapes, it belongs in the substrate.
6. **Self-extension is gated.** `paradigm-creator` is propose-only and requires a human or explicit `shape-builder` to apply. `shape-builder` gates usability through independent verification, parent-session reload, active-runtime discovery, and post-reload canary. No shape marks itself or another shape usable without these gates.
