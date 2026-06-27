# Phase 3 Implementation Plan — Autonomous Graphify Semantic Subagent Runs

Planner: Claude Opus 4.8
Executor target: GPT 5.5 Codex
Primary file: `agent/extensions/autonomous-graphify/index.ts` (single file — no other files touched)
Do not touch: `agent/extensions/agent-scheduler/**`, `agent/scheduler.json`, `agent/extensions/graphify.ts`, the Graphify Brain layout/logic, or `agent/agents/graphify-autonomy-runner.json` (read it, do not edit it).

## Objective

Activate the deferred Phase 3 primitives (`models.semantic`, `models.verifier`, `runner.subagent`) so that when mutation tracking detects **doc/semantic-worthy** changes (intakes, plans, session notes, wiki drafts, AGENTS.md, skill READMEs, project docs), the extension routes semantic graphify work to a cheap LLM subagent (DeepSeek V4 Flash) running the existing `graphify-autonomy-runner`, optionally verified by a DeepSeek V4 Pro verifier subagent, and best-effort syncs results to the global Graphify Brain.

Semantic runs reuse the Phase 2 single-flight lock, cooldown, and debounce patterns, never block normal agent work, are fully logged, and self-heal on missing config/state.

## Constraints

- Single file: all changes land in `index.ts`.
- Cheap models only for autonomous semantic work — default `deepseek/deepseek-v4-flash` (semantic), `deepseek/deepseek-v4-pro` (verifier). Human may override via config.
- Shared single-flight lock: only one graphify run (code-only OR semantic) at a time. Code-only runs first; semantic follows.
- Subagent isolation: semantic work runs in a spawned `pi` child process (`--no-session`), never consuming the main session.
- No semantic loop: outputs under `graphify-out/`, `graphify-autonomy/`, `.git/`, `node_modules/`, `.jsonl`, logs are ignored for change detection (Phase 2 `isIgnoredPath` already covers these).
- Verifier optional and non-gating: log disagreement, never block.
- Brain sync best-effort: failures logged, never crash the loop.
- No blocking of normal agent work: all runs are fire-and-forget after `agent_end` debounce or manual trigger.
- Backward-compatible config/state: missing semantic fields self-heal via normalizers.
- Reuse the existing subagent invocation pattern from `examples/extensions/subagent/index.ts` (`getPiInvocation` + `spawn` with `--mode json -p --no-session`).

## Subagent spawn mechanism (reference)

Phase 3 must spawn the runner as a separate `pi` process. Mirror the proven pattern from the SDK example `examples/extensions/subagent/index.ts`:

```ts
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}
```

Invocation args for a subagent run:

```
["--mode", "json", "-p", "--no-session",
 "--model", <modelOverride>,
 "--tools", <agent.tools>,
 "--append-system-prompt", <tmpPromptFile>,
 `Task: ${task}`]
```

Parse newline-delimited JSON from stdout; collect `event.type === "message_end"` messages; the final assistant message text is the subagent result. Capture exit code from process close. Add `import { spawn } from "node:child_process"` (extend the existing import) and `basename` from `node:path`, `tmpdir`/`homedir` from `node:os` (extend existing `hostname` import), plus `mkdtemp`/`copyFile`/`rm` from `fsp`.

The runner agent definition is loaded from `join(getAgentDir(), "agents", "graphify-autonomy-runner.json")` (the configured `config.runner.subagent` + `.json`). Read `name`, `model`, `tools`, `systemPrompt`. Override `model` with `config.models.semantic` (semantic pass) or `config.models.verifier` (verifier pass). Confirm `pi --model` format against `docs/models.md`; default to the bare `model` string, falling back to `provider/model` if the bare form is rejected.

## State and config changes

### Extend `GraphifyAutonomyConfig` type + `DEFAULT_CONFIG` + `normalizeConfig`

Add fields (with defaults):

```ts
semanticChangeThreshold: number;   // default 5
semanticMinDocFiles: number;       // default 2  (OR-rule: 2 doc files also qualifies)
semanticDocExtensions: string[];   // default [".md", ".mdx", ".txt", ".rst", ".adoc", ".wiki"]
semanticDebounceSeconds: number;   // default 120
autoVerifierEnabled: boolean;      // default true
verifierTimeoutMs: number;         // default 120000
semanticTimeoutMs: number;         // default 600000 (LLM work slower than code-only)
verifierGates: boolean;            // default false — verifier FAIL never blocks unless true
// brainSyncAfterRun ALREADY EXISTS — reuse as the semantic brain-sync gate
```

`normalizeConfig` must add:
- `semanticDocExtensions: Array.isArray(raw.semanticDocExtensions) ? raw.semanticDocExtensions : DEFAULT_CONFIG.semanticDocExtensions`
- numeric self-heal for `semanticChangeThreshold`, `semanticMinDocFiles`, `semanticDebounceSeconds`, `verifierTimeoutMs`, `semanticTimeoutMs` via `Number.isFinite(...) ? Number(...) : DEFAULT`
- boolean self-heal for `autoVerifierEnabled`, `verifierGates` via `typeof raw.x === "boolean" ? raw.x : DEFAULT`

### Extend `GraphifyAutonomyState` type + `DEFAULT_STATE` + `normalizeState`

Add fields (defaults all null/0/[]):

```ts
// doc/semantic change tracking (parallel to code counters)
docChangeCount: number;            // 0
docChangedFiles: string[];         // []
// semantic run lifecycle
semanticRunStatus: "idle" | "debouncing" | "running" | "failed"; // "idle"
semanticPendingReason: string | null;     // null
semanticPendingSince: string | null;      // null
semanticScheduledFor: string | null;      // null
semanticActiveRunId: string | null;       // null
// semantic run results
lastSemanticRunAt: string | null;
lastSemanticRunReason: string | null;
lastSemanticModel: string | null;
lastSemanticSubagent: string | null;
lastSemanticOk: boolean | null;
lastSemanticExitCode: number | null;
lastSemanticDurationMs: number | null;
lastSemanticStdoutTail: string | null;
// verifier + brain sync
lastVerifierOk: boolean | null;
lastVerifierVerdict: string | null;
lastBrainSyncOk: boolean | null;
// failure tracking (separate from code-only failureCount)
semanticFailureCount: number;             // 0
lastSemanticFailureReason: string | null; // null
```

`normalizeState` must:
- `docChangedFiles: Array.isArray(raw.docChangedFiles) ? raw.docChangedFiles.slice(0, 200) : []`
- `docChangeCount: Number.isFinite(raw.docChangeCount) ? Number(raw.docChangeCount) : 0`
- `semanticFailureCount: Number.isFinite(raw.semanticFailureCount) ? Number(raw.semanticFailureCount) : 0`
- `semanticRunStatus`: validate against the same enum list, default `"idle"`
- spread `...DEFAULT_STATE, ...raw` already self-heals the rest (keep existing pattern)

Also extend `updateState`'s trailing slice to clamp `docChangedFiles`:
```ts
state.docChangedFiles = state.docChangedFiles.slice(-200);
```

### `GraphifyAutoParams` tool schema

Extend `mode` enum to include `"semantic"`:

```ts
mode: Type.Optional(StringEnum(["code-only", "semantic"] as const)),
```

## Classification additions

Keep `classifyChangedFiles` unchanged (it already returns `docsOrMixed`). Add a peer helper that counts doc-worthy files using `config.semanticDocExtensions`:

```ts
function countDocWorthyFiles(changedFiles: string[], config: GraphifyAutonomyConfig): number {
	const docExts = new Set(config.semanticDocExtensions.map((e) => e.toLowerCase()));
	return changedFiles
		.filter((f) => !f.startsWith("bash:") && !isIgnoredPath(f, config))
		.filter((f) => docExts.has(extname(f).toLowerCase()))
		.length;
}
```

Update `recordMutation` so doc-worthy changes also increment doc counters (same `updateState` call, alongside the existing significantChangeCount logic):

```ts
const isDoc = !changedPath.startsWith("bash:")
	&& config.semanticDocExtensions.map((e) => e.toLowerCase()).includes(extname(displayPath).toLowerCase());
await updateState((state) => {
	state.significantChangeCount += 1;
	state.lastMutationAt = new Date().toISOString();
	if (!state.changedFiles.includes(displayPath)) state.changedFiles.push(displayPath);
	if (isDoc) {
		state.docChangeCount += 1;
		if (!state.docChangedFiles.includes(displayPath)) state.docChangedFiles.push(displayPath);
	}
});
```

(`recordMutation` already reads `config` at the top — reuse it.)

## Semantic gate

Mirror `shouldAutoRunCodeOnly`:

```ts
function shouldAutoRunSemantic(
	config: GraphifyAutonomyConfig,
	state: GraphifyAutonomyState,
	now: number,
	options: { allowDebouncing?: boolean } = {},
): { run: boolean; reason: string } {
	if (!config.enabled) return { run: false, reason: "disabled" };
	if (config.paused) return { run: false, reason: "paused" };
	// shared single-flight: do not start semantic while a code-only run is active
	const allowed: GraphifyAutonomyState["runStatus"][] = ["idle", "failed"];
	if (!allowed.includes(state.runStatus)) return { run: false, reason: `code run status is ${state.runStatus}` };
	const allowedSem: GraphifyAutonomyState["semanticRunStatus"][] = options.allowDebouncing
		? ["idle", "failed", "debouncing"] : ["idle", "failed"];
	if (!allowedSem.includes(state.semanticRunStatus)) return { run: false, reason: `semantic status is ${state.semanticRunStatus}` };
	const docFiles = countDocWorthyFiles(state.docChangedFiles, config);
	const meetsThreshold = state.docChangeCount >= config.semanticChangeThreshold || docFiles >= config.semanticMinDocFiles;
	if (!meetsThreshold) return { run: false, reason: "below semantic threshold" };
	if (state.cooldownUntil && Date.parse(state.cooldownUntil) > now) return { run: false, reason: "cooldown active" };
	return { run: true, reason: `${state.docChangeCount} doc change(s)/${docFiles} doc file(s) passed semantic threshold` };
}
```

Note: the shared lock is enforced both by the `state.runStatus` check above and by `runInProgress`/`acquireGraphifyLock` at execution time.

## Subagent runtime helpers

Add module-scoped semantic debounce var alongside the existing `debounceTimer`:

```ts
let semanticDebounceTimer: ReturnType<typeof setTimeout> | undefined;
```

### Agent loader

```ts
type RunnerAgent = { name: string; model?: string; tools?: string; systemPrompt?: string };

async function loadRunnerAgent(config: GraphifyAutonomyConfig): Promise<RunnerAgent | null> {
	try {
		const p = join(getAgentDir(), "agents", `${config.runner.subagent}.json`);
		return JSON.parse(await fsp.readFile(p, "utf8")) as RunnerAgent;
	} catch {
		return null;
	}
}
```

### Generic subagent spawn

```ts
type SubagentResult = { ok: boolean; exitCode: number | null; output: string; durationMs: number };

async function spawnSubagent(
	cwd: string,
	agent: RunnerAgent,
	modelOverride: string,
	task: string,
	timeoutMs: number,
	maxOutputTailBytes: number,
): Promise<SubagentResult>
```

Behavior:
1. `mkdtemp` a temp dir; write `agent.systemPrompt` to `prompt.md` (mode 0o600) if non-empty.
2. Build args: `["--mode", "json", "-p", "--no-session", "--model", modelOverride]`; if `agent.tools` push `["--tools", agent.tools]`; if prompt file push `["--append-system-prompt", file]`; finally push `` `Task: ${task}` ``.
3. `const inv = getPiInvocation(args); const child = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore","pipe","pipe"], windowsHide: true });`
4. Buffer stdout line-by-line; JSON.parse each line; collect assistant `message_end` text into `output`.
5. Enforce timeout with `setTimeout(() => child.kill(), timeoutMs)` (clear on close).
6. Resolve on `close` with `{ ok: exitCode === 0, exitCode, output: tailBytes(output, maxOutputTailBytes), durationMs }`; on `error` resolve `{ ok:false, exitCode:null, output: err.message, durationMs }`.
7. Always `await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})` in `finally`.

### Semantic run orchestrator

```ts
async function runSemanticGraphify(
	cwd: string,
	reason: string,
	opts?: { force?: boolean },
): Promise<{
	ok: boolean; runId: string; durationMs: number;
	semantic: SubagentResult | null;
	verifier: { ok: boolean; verdict: string } | null;
	brainSyncOk: boolean | null;
	skippedReason?: "already-running" | "no-runner";
}>
```

Behavior:
1. `runId = ${Date.now()}-${hex}`; `started = Date.now()`.
2. If `runInProgress` → return `skippedReason: "already-running"`.
3. `const config = await readConfig()`.
4. `const agent = await loadRunnerAgent(config)`; if null → appendRunLog skip + return `skippedReason: "no-runner"`.
5. `const lock = await acquireGraphifyLock(runId)`; if null → return `skippedReason: "already-running"`.
6. `runInProgress = true`.
7. `updateState`: `semanticRunStatus = "running"; semanticActiveRunId = runId; semanticScheduledFor = null`.
8. `appendRunLog({ event: "semantic-start", runId, cwd, reason, mode: "semantic", model: config.models.semantic.model, subagent: agent.name })`.
9. Build the semantic task prompt (bounded — only changed file names, never diffs):
   ```
   Run semantic graphify maintenance for {cwd}.
   Changed files: {state.docChangedFiles.slice(-50).join(", ")}
   Reason: {reason}
   Instructions: Run `graphify` for semantic extraction, community labeling, and wiki
   generation against this project's graphify-out/ output directory. Prefer incremental
   updates. Report artifacts produced, commands run, and any errors. Do NOT touch
   graphify-autonomy/ runtime files.
   ```
10. `const semantic = await spawnSubagent(cwd, agent, modelOverrideFor(config.models.semantic), task, config.semanticTimeoutMs, config.maxOutputTailBytes)`.
11. If `config.autoVerifierEnabled && semantic.ok`: run verifier:
    ```
    Verify the graphify semantic output at {cwd}/graphify-out/.
    Expected artifacts: wiki/*.md, updated GRAPH_REPORT.md, community labels.
    Check for: parseable JSON/HTML, coherent community names, graph consistency.
    Return exactly PASS or FAIL on the first line, with brief evidence after.
    ```
    `const verRes = await spawnSubagent(cwd, agent, modelOverrideFor(config.models.verifier), verifyTask, config.verifierTimeoutMs, config.maxOutputTailBytes)`.
    Parse verdict from first line: `PASS` only if first line matches `/\bPASS\b/i` and not `/\bFAIL\b/i`; else `FAIL`. Build `verifier = { ok: verdict === "PASS", verdict }`.
12. Overall `ok = semantic.ok && (!config.verifierGates || verifier?.ok !== false)`.
13. Brain sync: if `ok && config.brainSyncAfterRun` → `brainSyncOk = await syncBrainAfterSemantic(cwd).catch(() => false)`. Else `brainSyncOk = null`.
14. `appendRunLog({ event: "semantic-end", runId, ok, exitCode: semantic.exitCode, durationMs, verifier: verifier?.verdict ?? null, brainSyncOk })`.
15. `finally`: `runInProgress = false; await releaseGraphifyLock(runId)`.
16. Return the aggregate result.

`modelOverrideFor(route)` helper: returns `route.model` (bare). Switch to `` `${route.provider}/${route.model}` `` if `pi --model` requires the combined form.

### Brain sync helper

```ts
async function syncBrainAfterSemantic(cwd: string): Promise<boolean>
```

Best-effort, mirrors the artifact-copy half of `graphify.ts` `saveProjectToBrain` WITHOUT importing it (single-file constraint):
1. `const outDir = join(cwd, "graphify-out")`; if `!existsSync(join(outDir, "GRAPH_REPORT.md"))` → return false.
2. `const slug = slugify(basename(cwd))` — add a local `slugify` matching graphify.ts (lowercase, non-alnum → `-`, collapse repeats, trim hyphens).
3. `const destBase = join(homedir(), ".pi", "graphify-brain", slug)`; `await fsp.mkdir(destBase, { recursive: true })`.
4. Copy known artifacts when present, file-by-file via `fsp.copyFile`, each wrapped in try/catch: `GRAPH_REPORT.md`, `graph.json`, any `*graphrag*.json`, and recursively the `wiki/` dir (manual recursive copy with `existsSync` guards; use `fsp.cp` only if confirmed available on target Node). Track success count.
5. Return `true` if at least `GRAPH_REPORT.md` copied, else `false`.

Notes:
- Add `import { homedir } from "node:os"`.
- Do NOT call `rebuildBrainIndex` (lives in graphify.ts; out of scope). graphify.ts rebuilds the brain index on its own `session_start`. Recording `lastBrainSyncOk` in state is sufficient for Phase 3.

### Semantic finalizer

```ts
async function finalizeSemanticRun(
	result: Awaited<ReturnType<typeof runSemanticGraphify>>,
	reason: string,
): Promise<void>
```

On `skippedReason`:
- `appendRunLog({ event: "semantic-skip", runId, reason, skippedReason })`.
- `updateState`: if `semanticRunStatus !== "running"` reset `semanticActiveRunId = null; semanticScheduledFor = null; semanticRunStatus = "idle"`.
- return.

Otherwise `const config = await readConfig(); const now = Date.now();` then `updateState`:
- always: `semanticActiveRunId = null; semanticScheduledFor = null;`
- `lastSemanticModel = config.models.semantic.model; lastSemanticSubagent = config.runner.subagent;`
- `lastSemanticExitCode = result.semantic?.exitCode ?? null; lastSemanticDurationMs = result.durationMs; lastSemanticStdoutTail = result.semantic?.output ?? null;`
- `lastVerifierOk = result.verifier?.ok ?? null; lastVerifierVerdict = result.verifier?.verdict ?? null; lastBrainSyncOk = result.brainSyncOk;`
- if `result.ok`:
  - `lastSemanticRunAt = new Date(now).toISOString(); lastSemanticRunReason = reason; lastSemanticOk = true;`
  - `cooldownUntil = new Date(now + cooldownMinutes*60000).toISOString()` (shared cooldown — same as code-only)
  - `semanticRunStatus = "idle";`
  - `semanticPendingReason = null; semanticPendingSince = null;`
  - `docChangeCount = 0; docChangedFiles = [];`
  - `semanticFailureCount = 0; lastSemanticFailureReason = null;`
- else:
  - `semanticRunStatus = "failed"; lastSemanticOk = false;`
  - `semanticFailureCount += 1;`
  - `lastSemanticFailureReason = result.semantic?.output?.slice(-500) || "semantic subagent failed";`
  - do NOT reset doc counters; keep `semanticPendingReason`.

Critical: semantic failure must NOT touch code-only `failureCount`/`runStatus`, and code-only failure must NOT touch semantic fields. They are fully independent.

## Debounce wiring (sequencing: code-only first, then semantic)

### `armSemanticDebounce`

```ts
function armSemanticDebounce(cwd: string, reason: string, delayMs: number): void {
	if (semanticDebounceTimer) clearTimeout(semanticDebounceTimer);
	semanticDebounceTimer = setTimeout(() => {
		void (async () => {
			if (semanticDebounceTimer) clearTimeout(semanticDebounceTimer);
			semanticDebounceTimer = undefined;
			const [config, state] = await Promise.all([readConfig(), readState()]);
			// If any run is active, reschedule shortly instead of dropping.
			if (runInProgress || state.runStatus === "running" || state.semanticRunStatus === "running") {
				armSemanticDebounce(cwd, reason, Math.min(30000, config.semanticDebounceSeconds * 1000));
				return;
			}
			const gate = shouldAutoRunSemantic(config, state, Date.now(), { allowDebouncing: true });
			if (!gate.run) {
				await updateState((next) => {
					if (next.semanticRunStatus === "debouncing") next.semanticRunStatus = "idle";
					next.semanticScheduledFor = null;
				});
				return;
			}
			const result = await runSemanticGraphify(cwd, reason);
			await finalizeSemanticRun(result, reason);
		})();
	}, delayMs);
}
```

This re-checks the shared lock so semantic never collides with an in-flight code-only run; it reschedules instead of dropping.

### `clearDebounce` — extend to clear semantic timer too

```ts
function clearDebounce(): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = undefined;
	if (semanticDebounceTimer) clearTimeout(semanticDebounceTimer);
	semanticDebounceTimer = undefined;
}
```

### `maybeScheduleAfterAgentEnd` — add semantic scheduling after code-only

After the existing code-only block, append:

```ts
// Re-read fresh state (code-only block may have armed/changed state).
const [cfg2, st2] = await Promise.all([readConfig(), readState()]);
const semGate = shouldAutoRunSemantic(cfg2, st2, Date.now());
if (!semGate.run) return;
// Use a LONGER delay than code-only so code-only fires first when both are armed.
const baseDelayMs = cfg2.semanticDebounceSeconds * 1000;
const delayMs = st2.runStatus === "debouncing"
	? baseDelayMs + cfg2.debounceSeconds * 1000   // wait out the code-only debounce window
	: baseDelayMs;
const semScheduledFor = new Date(Date.now() + delayMs).toISOString();
const semReason = st2.semanticPendingReason
	?? `${st2.docChangeCount} doc/semantic change(s) detected.`;
await updateState((next) => {
	next.semanticPendingReason = semReason;
	next.semanticPendingSince = next.semanticPendingSince ?? new Date().toISOString();
	next.semanticRunStatus = "debouncing";
	next.semanticScheduledFor = semScheduledFor;
});
armSemanticDebounce(cwd, semReason, delayMs);
```

Sequencing guarantee: code-only debounce (`debounceSeconds`, default 60) fires before semantic debounce (`semanticDebounceSeconds`, default 120, +60 when code-only also armed). The semantic debounce body additionally reschedules while a run is in progress. Together these enforce "code-only first, semantic follows" without deadlock.

## Lifecycle wiring updates

### `session_start`

After the existing code-only orphan/re-arm logic, add semantic equivalents:
- If `state.semanticRunStatus === "running"` and (no valid lock or lock stale) → reset `semanticRunStatus = "idle"; semanticActiveRunId = null;`.
- If `state.semanticRunStatus === "debouncing" && state.semanticScheduledFor` → `armSemanticDebounce(ctx.cwd, state.semanticPendingReason ?? "Re-armed pending semantic graphify run.", Math.max(0, Date.parse(state.semanticScheduledFor) - Date.now()))`.
- Update the load notice text to mention Phase 3 semantic runs.

Raise the lock stale window used by the session_start reset and `hasActiveRunLock`/`acquireGraphifyLock` to cover semantic timeouts: use `Math.max(config.runTimeoutMs, config.semanticTimeoutMs) + 60000` everywhere the current code uses `config.runTimeoutMs + 60000`.

### `session_shutdown`

No change beyond the `clearDebounce()` extension above (now also clears the semantic timer).

### `before_agent_start` advisory

Extend the advisory block to surface semantic fields when relevant:
- `state.semanticRunStatus` + `state.semanticScheduledFor`
- `state.semanticPendingReason`
- `state.lastSemanticRunAt` + `state.lastVerifierVerdict`
- `state.lastSemanticFailureReason`

Extend the `shouldInject` condition to also fire when `state.semanticPendingReason` is set.

## Status enrichment (`statusText`)

Append semantic-specific lines:
```ts
`semanticRunStatus: ${state.semanticRunStatus}`,
`semanticScheduledFor: ${state.semanticScheduledFor ?? "none"}`,
`semanticPending: ${state.semanticPendingReason ?? "none"}`,
`docChanges: ${state.docChangeCount}${state.docChangedFiles.length ? `, files ${state.docChangedFiles.slice(-5).join(", ")}` : ""}`,
`lastSemanticRun: ${state.lastSemanticRunAt ?? "never"}`,
`lastSemanticModel: ${state.lastSemanticModel ?? "none"}`,
`lastSemanticOk: ${state.lastSemanticOk ?? "n/a"}`,
`lastVerifier: ${state.lastVerifierVerdict ?? "n/a"}`,
`lastBrainSync: ${state.lastBrainSyncOk ?? "n/a"}`,
`semanticFailures: ${state.semanticFailureCount}${state.lastSemanticFailureReason ? ` — ${state.lastSemanticFailureReason}` : ""}`,
`verifier model: ${config.models.verifier.provider}/${config.models.verifier.model}`,
```

## Command changes (`/graphify-auto run-now`)

Rewrite the run-now branch to accept `--semantic`:
- Remove the "deferred to Phase 3" rejection for `--semantic`.
- Keep `--full` rejected (out of scope — manual `/graphify` only).
- If `--semantic` flag present (and not `--code-only`):
  - Respect `enabled`/`paused` unless `--force`.
  - `if (await hasActiveRunLock())` → notify already running, return.
  - Resolve `runCwd` from optional positional path (default `ctx.cwd`).
  - `const reason = "Run requested via /graphify-auto run-now --semantic.";`
  - Fire-and-forget: `void runSemanticGraphify(runCwd, reason, { force }).then((r) => finalizeSemanticRun(r, reason));`
  - Notify: `Started semantic graphify subagent run in ${runCwd}.`
- `--code-only` path unchanged.
- If neither flag → keep usage hint, now including `--semantic`.

Update the final usage hint string to:
```
Usage: /graphify-auto status|pause|resume|enable|disable|mark-needed|gate|config|run-now (--code-only|--semantic) [--force] [path]
```

## Tool changes (`graphify_auto`)

`run_now` action:
- If `params.mode === "semantic"`: validate lock, fire-and-forget `runSemanticGraphify(ctx.cwd, reason, { force }).then((r) => finalizeSemanticRun(r, reason))`, return "Started semantic graphify subagent run."
- Else (default/`code-only`): existing code-only path.

`schedule` action:
- If `params.mode === "semantic"`: set `semanticPendingReason/Since`, `semanticRunStatus = "debouncing"`, `semanticScheduledFor`, and `armSemanticDebounce(ctx.cwd, reason, config.semanticDebounceSeconds * 1000)`. Return scheduled message with the semantic timestamp.
- Else: existing code-only schedule path.

Update tool `description` + `promptGuidelines` to mention Phase 3 semantic subagent runs (DeepSeek V4 Flash worker, optional V4 Pro verifier, brain sync).

## Export block (for testing)

Add to the `export { ... }` block:
```ts
countDocWorthyFiles,
shouldAutoRunSemantic,
```

## Imports to extend

- `node:child_process`: add `spawn` (keep `execFile`, `execSync`).
- `node:os`: add `homedir`, `tmpdir` (keep `hostname`).
- `node:path`: add `basename` (keep existing).
- `fsp`: use `fsp.mkdtemp`, `fsp.copyFile`, `fsp.rm` (and `fsp.cp` only if confirmed available; otherwise manual recursive copy for `wiki/`).

## Implementation order (numbered)

1. Extend imports (`spawn`, `homedir`, `tmpdir`, `basename`).
2. Extend `GraphifyAutonomyConfig` type, `DEFAULT_CONFIG`, `normalizeConfig` with semantic config fields.
3. Extend `GraphifyAutonomyState` type, `DEFAULT_STATE`, `normalizeState`, and the `updateState` slice with semantic/doc state fields.
4. Extend `GraphifyAutoParams.mode` enum with `"semantic"`.
5. Add `countDocWorthyFiles`; update `recordMutation` to track doc counters.
6. Add `shouldAutoRunSemantic`.
7. Add `slugify`, `loadRunnerAgent`, `getPiInvocation`, `spawnSubagent`, `modelOverrideFor`.
8. Add `syncBrainAfterSemantic`.
9. Add `runSemanticGraphify` and `finalizeSemanticRun`.
10. Add `semanticDebounceTimer` var, `armSemanticDebounce`; extend `clearDebounce`; raise the lock stale window helper to use `max(runTimeoutMs, semanticTimeoutMs)`.
11. Extend `maybeScheduleAfterAgentEnd` with semantic scheduling (after code-only).
12. Extend `session_start` with semantic orphan-reset + re-arm; update load notice.
13. Extend `before_agent_start` advisory + `shouldInject`.
14. Enrich `statusText` with semantic fields.
15. Rewrite `/graphify-auto run-now` to accept `--semantic`; update usage hint.
16. Extend `graphify_auto` tool `run_now`/`schedule` for `mode: "semantic"`; update description/guidelines.
17. Extend export block.
18. Run verification.

Recommended core-first: steps 1–11 (functional semantic loop), then 12–16 (controls/observability), then 17–18.

## Verification

```bash
cd %USERPROFILE%/.pi/agent

# TypeScript transpile/diagnostics check
node -e "const fs=require('fs'); const ts=require('typescript'); const f='extensions/autonomous-graphify/index.ts'; const r=ts.transpileModule(fs.readFileSync(f,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}, reportDiagnostics:true}); console.log((r.diagnostics||[]).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('\n') || 'transpile ok')"

# Config/state JSON parse check
node -e "const fs=require('fs'); const p='graphify-autonomy/config.json'; if(fs.existsSync(p)) JSON.parse(fs.readFileSync(p,'utf8')); const s='graphify-autonomy/state.json'; if(fs.existsSync(s)) JSON.parse(fs.readFileSync(s,'utf8')); console.log('json ok')"

# Confirm runner agent is loadable
node -e "JSON.parse(require('fs').readFileSync('agents/graphify-autonomy-runner.json','utf8')); console.log('runner ok')"

# Scheduler + graphify.ts + runner agent untouched
git diff --stat extensions/agent-scheduler/ scheduler.json extensions/graphify.ts agents/graphify-autonomy-runner.json

# Run-log differentiation after a semantic run
tail -10 graphify-autonomy/run-log.jsonl
```

In-session checks after reload (full Pi restart — `/reload` does not reliably re-evaluate extension source):
```
/graphify-auto status                 # shows semantic fields, all "none"/"never" on fresh state
/graphify-auto run-now --semantic      # spawns subagent, notifies "Started semantic graphify subagent run"
/graphify-auto status                 # semanticRunStatus running → idle; lastSemanticRunAt set; verifier verdict present
```
Tool path:
```
graphify_auto run_now mode:semantic    # fire-and-forget semantic run
graphify_auto schedule mode:semantic   # arms semantic debounce, semanticScheduledFor set
```

Expected outcomes:
- Semantic run spawns exactly one `pi --no-session` child using `deepseek-v4-flash`; verifier (if enabled) spawns a second using `deepseek-v4-pro`.
- Lock file exists during a semantic run and is removed after; a second run while locked is refused.
- Run-log shows `semantic-start`/`semantic-end` with `mode: "semantic"`, model, subagent, verifier verdict, brainSyncOk.
- Successful semantic run sets shared `cooldownUntil`, resets `docChangeCount`/`docChangedFiles`, leaves code-only counters independent.
- After docs/intakes change and `agent_end`, semantic debounce is armed AFTER code-only; both can be armed without deadlock; semantic reschedules if code-only is mid-run.
- Brain sync copies `GRAPH_REPORT.md`/`graph.json`/`wiki/` into `~/.pi/graphify-brain/<slug>/`; `lastBrainSyncOk` reflects outcome.
- A Phase 2 `state.json` (missing semantic fields) loads cleanly with all semantic fields defaulted.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `pi` not resolvable for subagent spawn | `getPiInvocation` prefers `process.execPath + argv[1]`, falls back to `pi` on PATH. Spawn failure → `child.on("error")` → `ok:false`, logged, not crashing. |
| Subagent stalls / runs forever | `semanticTimeoutMs` (600000) and `verifierTimeoutMs` (120000) kill the child; lock stale-break raised to `max(runTimeoutMs, semanticTimeoutMs)+60000` as a backstop. |
| Semantic and code-only both armed → collision | Shared `runInProgress` + lock + `state.runStatus` checks serialize; semantic debounce reschedules instead of dropping; longer semantic delay sequences code-only first. |
| Semantic failure stalls code-only loop | Independent counters/status; `finalizeSemanticRun` never touches code-only `failureCount`/`runStatus`. |
| Verifier contradicts semantic output | `verifierGates` default false → log disagreement, never block. Verdict surfaced in status/run-log. |
| Brain sync corrupts existing graphs | Best-effort file-by-file copy in try/catch; only known artifacts; failure sets `lastBrainSyncOk=false`, never throws. |
| Semantic run loops on its own output | `graphify-out/`, `graphify-autonomy/`, `.jsonl`, logs already ignored by `isIgnoredPath`; doc counters reset on success. |
| Oversized subagent prompt | Pass only `docChangedFiles.slice(-50)` names, never diffs; bound output tails via `maxOutputTailBytes`. |
| Cheap-model guarantee bypassed | Default models hard-coded to DeepSeek Flash/Pro in `DEFAULT_CONFIG`; model comes only from config, never from call-time user input. |
| Expensive autonomous spend | One semantic run per shared cooldown window; threshold higher than code-only; verifier optional. |
| Backward-compat break | `normalizeConfig`/`normalizeState` default every new field; spread heals old files; corrupt state already quarantined by `readState`. |
| `fsp.cp` unavailable on target Node | Use manual recursive copy for `wiki/`; guard with `existsSync`. |

## Next action

Hand this plan to GPT 5.5 Codex for implementation in `agent/extensions/autonomous-graphify/index.ts`. Implement steps 1-11 (functional semantic loop) first, verify transpile + state self-heal, then add controls/observability (12-16), exports (17), and run full verification (18). After implementation, mark graphify maintenance via `graphify_auto mark_needed` rather than running inline full graphify.
