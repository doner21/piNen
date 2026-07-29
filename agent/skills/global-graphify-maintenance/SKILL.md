---
name: global-graphify-maintenance
description: Rebuilds the Graphify global graph (~/.graphify/global-graph.json) by merging per-project graphs from the graphify-brain, enabling cross-project discovery of reusable functionality, shared patterns, and community overlap.
---

# Global Graphify Maintenance

Use this skill when the user asks to rebuild or verify the cross-project Graphify
graph. This is explicit orchestration work: the current agent coordinates a
planner, executor, and independent verifier through the deterministic
`/orchestrate` system. Do not add role ledgers, intake receipts, status panels,
or custom closeout files beyond the selected shape's own output.

## Roles

| Role | Agent | Suggested route |
|---|---|---|
| Planner | `gm-planner` | DeepSeek V4 Pro |
| Executor | `gm-executor` | DeepSeek V4 Flash |
| Verifier | `gm-verifier` | DeepSeek V4 Pro |

Omit model/provider overrides unless the user requested them or those routes are
configured and available. Executor concurrency may be up to two when independent
source-graph checks can run in parallel.

## Source and output

- Source root: `~/.pi/graphify-brain/`
- Canonical output: `~/.graphify/global-graph.json`

Discover project directories dynamically. Never hardcode project names.

## Safety invariants

Carry these exact constraints into planning, execution, and verification:

1. **Source graphs are read-only.** Never modify, normalize, reformat, delete,
   or replace any file under `~/.pi/graphify-brain/`.
2. **Only the canonical global graph is mutable.** Outside temporary files owned
   by Graphify itself, the only durable output is
   `~/.graphify/global-graph.json`.
3. **Validate before merge.** A source is eligible only when its
   `graphify-out/graph.json` parses as JSON and has a top-level `nodes` array
   with at least one node.
4. **Skip safely.** Missing, malformed, or empty graphs are skipped with a
   concise reason; one bad project must not abort valid merges.
5. **No private-content reporting.** Report project labels and aggregate
   node/edge counts, not source document contents.

## Orchestrated flow

Invoke the deterministic orchestrator with the role agents above. The task sent
to the planner must require this flow:

### 1. Discover

Scan each immediate project directory under `~/.pi/graphify-brain/`. For every
candidate, record whether `graphify-out/graph.json` is present and valid, plus
node/edge counts for valid graphs.

### 2. Merge

Prefer the Graphify CLI:

```bash
graphify global add <project>/graphify-out/graph.json
graphify global list
graphify global path
```

If the installed CLI lacks those commands, merge deterministically with a local
script that preserves source graphs and writes only the canonical global output.
The fallback must retain enough project provenance to distinguish identical node
IDs from different projects.

### 3. Verify

The verifier independently checks:

- `~/.graphify/global-graph.json` exists and parses;
- top-level node/edge collections have the expected types;
- every accepted source project appears in the merged provenance/counts;
- skipped projects have valid reasons;
- no source graph's size/hash/mtime changed during the run;
- the output path is the canonical path reported by Graphify;
- aggregate counts and any reported cross-project bridge communities are
  recomputable from the output.

A correctly failing check gets fixed and re-run; do not document around it.

Suggested call shape:

```text
orchestrate(
  task: "Rebuild the global Graphify graph under the listed safety invariants and independently verify the canonical JSON output.",
  paradigm: "plan-execute-verify",
  plannerAgent: "gm-planner",
  executorAgent: "gm-executor",
  verifierAgent: "gm-verifier",
  executorConcurrency: 2
)
```

## Failure recovery

Diagnose whether failure came from invalid source data, unavailable CLI support,
merge logic, output validation, or subagent/runtime transport. Repair the
specific defect and re-run while material progress continues. A malformed source
is skipped, not repaired in place. Use model/provider fallback or the deterministic
local merge fallback when useful.

Involve the user only for an irreversible action, unavailable credential or
runtime, material scope choice, or sustained no-progress.

## Context continuity

Use `context_usage` for long scans. At the configured high-water mark (85% by
default), finish the current atomic step, persist a concise continuation,
schedule it, and resume in a fresh session.

## Completion

Report plainly:

- PASS or FAIL;
- canonical output path;
- accepted/skipped project counts;
- total nodes and edges;
- cross-project bridges if recomputed;
- machine checks run and any genuinely unverified item.
