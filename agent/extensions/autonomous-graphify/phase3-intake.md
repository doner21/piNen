# Autonomous Graphify Phase 3 — Semantic Subagent Runs Intake

## Original request

> Let's move on to phase three of the graphify. Use a similar orchestration system as previous.

## Context

Phase 1 is implemented: config/state, pause/resume/status, mutation tracking, advisory context injection via `before_agent_start`.

Phase 2 is implemented: code-only, LLM-free autonomous run loop with debounce, single-flight lock, cooldown, run-log, and manual `/graphify-auto run-now --code-only`.

The config already reserves Phase 3 primitives that have no runtime behavior yet:

```json
"models": {
  "semantic": { "provider": "deepseek", "model": "deepseek-v4-flash" },
  "verifier": { "provider": "deepseek", "model": "deepseek-v4-pro" }
},
"runner": { "subagent": "graphify-autonomy-runner" }
```

The slash command currently rejects semantic/full requests with:

> Phase 2 supports only LLM-free --code-only runs; semantic/full modes are deferred to Phase 3.

Phase 3 activates these deferred capabilities.

## Task statement

Add autonomous **semantic** graphify runs to the Phase 2 code-only loop. When mutation tracking detects docs, plans, intakes, session notes, wiki drafts, or other non-code content changes, the extension should route to cheap LLM subagents (DeepSeek V4 Flash default) for community labeling, wiki narrative generation, and semantic extraction. A DeepSeek V4 Pro verifier should optionally review the output. The system must never block normal agent work, must log all semantic runs, and must respect the same pause/disable/cooldown/single-flight invariants as Phase 2.

## Primary users

- The human user, who wants stale graphs refreshed with semantic content when docs/plans/intakes change.
- The active Pi agent, which should be advised (not blocked) about semantic graph freshness.
- Autonomous subagent workers (`graphify-autonomy-runner`) that produce graphify outputs without consuming the main session.

## Scope for Phase 3

### In scope

1. **Classification expansion**: Extend `classifyChangedFiles` (or add a peer) to recognize `docsOrMixed` and `semanticWorthy` categories — intakes, plans, session summaries, wiki pages, AGENTS.md, skill READMEs, project docs.
2. **Semantic gate**: A `shouldAutoRunSemantic()` function mirroring `shouldAutoRunCodeOnly()` but for doc/mixed changes, with a higher threshold or configurable policy.
3. **Subagent spawning**: Use the configured `runner.subagent` (`graphify-autonomy-runner`) to launch cheap-model graphify semantic work — community labels, wiki narratives, graph-rag alignment — without blocking the main agent.
4. **Verifier integration**: After semantic subagent completes, optionally run a verifier pass (DeepSeek V4 Pro) to assert output quality and graph consistency.
5. **Brain sync**: After successful semantic runs, sync outputs into the global Graphify Brain at `~/.pi/graphify-brain/` so future sessions can consult fresh semantic artifacts.
6. **Run-now semantic**: `/graphify-auto run-now --semantic [path]` and `graphify_auto` tool `run_now` with `mode: "semantic"`.
7. **Status enrichment**: Show semantic-run-specific fields in status: last semantic run timestamp, model used, subagent outcome, verifier verdict.
8. **Run-log differentiation**: Log entries distinguish semantic vs code-only runs with mode, model, subagent name, verifier verdict.
9. **Config/model routes**: Activate `models.semantic` and `models.verifier` for actual subagent calls. Keep DeepSeek V4 Flash as default semantic worker and DeepSeek V4 Pro as verifier.
10. **Failure handling**: Semantic run failures should not stall code-only runs; track separate failure counters.
11. **Auto-schedule triggering**: On `agent_end`, when classification is `docsOrMixed` and threshold is met, schedule a semantic debounce parallel to (but not conflicting with) code-only debounce.

### Out of scope

- Full/deep graphify rebuilds (manual `/graphify` remains available).
- Real-time semantic processing during active tool calls.
- Producing human-readable reports unless the subagent or graphify itself generates them.
- Modifying graphify's internal extraction pipeline.
- OS-level daemons.
- Multi-project semantic workers in a single run.

## Core behavior

### Automatic path

After `agent_end`, when Phase 2 mutation tracking detects changes and `classifyChangedFiles` returns `docsOrMixed`:

1. If Phase 2 code-only gate would fire, let it fire first (code-only runs are cheap and fast).
2. After code-only run completes (or is skipped), re-evaluate: if docs/mixed changes remain above semantic threshold, mark semantic pending and schedule a semantic debounce.
3. After debounce:
   - Re-read config/state.
   - Re-check pause/disable/cooldown/lock.
   - Acquire graphify lock.
   - Append run-log semantic-start record.
   - Launch `runner.subagent` with a prompt that includes:
     - Project cwd
     - Changed files list
     - Type of semantic work needed (community labels, wiki updates, graph-rag sync)
     - Model override from config
   - Await subagent completion.
   - Optionally launch verifier subagent with the semantic output.
   - Finalize: update state, append end record, release lock, sync brain.

### Manual path

`/graphify-auto run-now --semantic [--force] [path]` should:

- Bypass threshold/debounce but still respect enabled/paused unless `--force`.
- Respect single-flight lock.
- Launch the configured subagent immediately.
- Report progress via status/notify.

### Tool path

`graphify_auto` tool:

- `run_now` with `mode: "semantic"` — fire-and-forget semantic run.
- `schedule` with `mode: "semantic"` — mark and debounce semantic work.
- Status output shows semantic-specific fields.

## Invariants

All Phase 1 and Phase 2 invariants apply, plus:

- **Cheap models only for autonomous semantic work.** The default must be DeepSeek V4 Flash. The human may override via config.
- **Semantic runs do not block code-only runs.** If both code-only and semantic changes are detected, code-only runs first, semantic follows.
- **Single-flight lock is shared.** Only one graphify run (code-only or semantic) at a time.
- **Subagent isolation.** Semantic work runs in its own subagent context; the main agent session is not consumed.
- **Verifier is optional but encouraged.** If `models.verifier` is configured, run verification; if it fails, record the failure but do not gate on it unless config says so.
- **Brain sync is best-effort.** Failures should be logged, not crash the loop.
- **No semantic loops.** Semantic run output changes to `graphify-out/` and `graphify-autonomy/` must be ignored for change detection, same as Phase 2.
- **Cooldown applies to all runs.** After any successful run (code-only or semantic), cooldown is set; manual force bypasses it.
- **Configurable semantic threshold.** Separate from code-only threshold; default higher (e.g., 5 changes or 2 doc changes).

## Proposed state additions

Extend `GraphifyAutonomyState`:

```json
{
  "lastSemanticRunAt": null,
  "lastSemanticRunReason": null,
  "lastSemanticModel": null,
  "lastSemanticSubagent": null,
  "lastSemanticOk": null,
  "lastSemanticExitCode": null,
  "lastSemanticDurationMs": null,
  "lastVerifierOk": null,
  "lastVerifierVerdict": null,
  "lastBrainSyncOk": null
}
```

And separate failure tracking for semantic:

```json
{
  "semanticFailureCount": 0,
  "lastSemanticFailureReason": null
}
```

## Proposed config additions

```json
{
  "semanticChangeThreshold": 5,
  "semanticDocExtensions": [".md", ".mdx", ".txt", ".rst", ".adoc", ".wiki"],
  "semanticDebounceSeconds": 120,
  "autoVerifierEnabled": true,
  "verifierTimeoutMs": 120000
}
```

## Subagent design

### `graphify-autonomy-runner`

Existing agent definition at `agent/agents/graphify-autonomy-runner.json`. Should be called with:

```
Task: Run semantic graphify maintenance for {cwd}.
Changed files: {list}
Reason: {reason}
Instructions: Run `graphify` with appropriate flags for semantic extraction, community labeling, and wiki generation. Use the project's graphify-out/ output directory. Report what was produced and any errors.
```

The orchestrator should override the model from config: `models.semantic`.

### Optional verifier subagent

If `autoVerifierEnabled`, after semantic completion, launch a verifier subagent (could reuse `graphify-autonomy-runner` with verifier model) with:

```
Task: Verify the graphify semantic output at {cwd}/graphify-out/.
Expected artifacts: wiki/*.md, updated GRAPH_REPORT.md, community labels.
Check for: parseable JSON/HTML, coherent community names, graph consistency.
Return: PASS or FAIL with evidence.
```

## Implementation primitives

- `classifyChangedFiles` extension to recognize doc/semantic-worthy files via `config.semanticDocExtensions`.
- `shouldAutoRunSemantic()` mirror function.
- `runSemanticGraphify(cwd, reason)` — spawns subagent, awaits result, optionally runs verifier.
- `syncBrainAfterSemantic(cwd, result)` — copies/syncs outputs to global brain.
- `finalizeSemanticRun(result)` — updates semantic-specific state fields.
- Separate debounce timer for semantic work, or a combined scheduler that sequences code-only then semantic.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Subagent stalls or times out | `runner.timeoutMs` config; Phase 2 timeout pattern reused. |
| Semantic run is too expensive | Default to Flash; configurable model; max one semantic run per cooldown window. |
| Verifier contradicts semantic output | Log disagreement; do not block; human can inspect via status/run-log. |
| Brain sync corrupts existing graphs | Write to timestamped dirs; atomic rename; best-effort. |
| Semantic and code-only both armed | Shared lock ensures serialization; code-only runs first. |
| Subagent context too large | Pass only changed files list, not full diffs; keep prompts bounded. |

## Requested orchestration

1. Use this intake as the Phase 3 task statement.
2. Ask Claude Opus 4.8 to produce a concrete implementation plan for Phase 3.
3. Save that plan to `agent/extensions/autonomous-graphify/phase3-plan.md`.
4. Then GPT 5.5 Codex can execute the saved plan in a separate implementation step.

## Success criteria

- `/graphify-auto run-now --semantic` launches a subagent and reports progress.
- `graphify_auto run_now mode:semantic` works from the tool.
- After docs/intakes change, a semantic run is scheduled automatically.
- Semantic runs use DeepSeek V4 Flash by default.
- Verifier runs (when enabled) and reports PASS/FAIL.
- Brain sync copies outputs to global brain after semantic success.
- Status shows semantic-specific fields.
- Run-log has differentiated semantic entries.
- Code-only and semantic runs do not deadlock each other.
- No semantic run triggers another infinite loop.
- Config remains backward compatible; missing semantic fields self-heal.
