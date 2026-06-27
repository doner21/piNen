# Orchestration Paradigms (Shapes)

This document describes the orchestration paradigms (shapes) available in the Pi orchestrate extension and how to add new ones.

## Available Paradigms

| Name | Description |
|------|-------------|
| `plan-execute-verify` | Classic planner → executor waves → verifier flow. Default paradigm. Supports retries with failure feedback and deterministic model routing checks. |
| `multi-verify-vote` | Planner → executor waves → multiple verifiers (odd count) → majority vote. Each verifier independently judges pass/fail; outcome is decided by majority. |
| `composable-pipeline` | Dynamic pipeline composition via natural language (hypothesize → critique → synthesize → plan → execute → verify, with per-phase counts). |
| `safe-github-publish` | Safe GitHub publishing: contract/intake → delegated sanitize/build/create/push by executor → independent remote verification. Private-first repo creation with gitleaks scanning, path denylists, and role integrity. Default recommended method for GitHub publishing in piNen. |
| `verify-only` | Verification-only: input is an evidence checklist + paths; spawns verifier(s) ONLY (no planner, no executors); output is per-check verdicts with citations. Supports multi-verifier majority vote ("3 verifiers" in the task text). Exempt from all implementation-task heuristics — verification output is legitimately text-only. Verifiers are granted read/bash/grep tools so they can gather and cite evidence independently. |

### `verify-only` usage

```text
/orchestrate --paradigm verify-only "Evidence checklist: 1) src/app.ts exports startServer 2) tests pass via npm test. Paths: src/, tests/"
```

It is also auto-selected when the task contains `verify-only`, `verification only`,
`just verify`, `only verify`, or `re-verify`.

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

If no paradigm is specified, `plan-execute-verify` is used by default.

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

## Design Rules

1. **Shapes are siblings.** They stand on the substrate and never import, extend, or call each other.
2. **The substrate enforces bounds.** Always use `SpawnGuard` and clamp values through `SUBSTRATE_CAPS` helpers.
3. **Default is `plan-execute-verify`.** Unknown paradigm names list available shapes and stop with an error.
4. **Each shape owns its meaning of termination.** The substrate only enforces that iterations/spawns are finite. What "retry," "vote," or "attempt" means is entirely shape-owned.
5. **No cross-shape code reuse.** If functionality is needed by multiple shapes, it belongs in the substrate.
