# Phase 2 Implementation Plan — Autonomous Graphify Code-Only Run Loop

Planner: Claude Opus 4.8  
Executor target: GPT 5.5 Codex  
Primary file: `agent/extensions/autonomous-graphify/index.ts`  
Do not touch: `agent/extensions/agent-scheduler/**`, `agent/scheduler.json`, Graphify Brain layout, or unrelated `graphify.ts` gate logic.

## Objective

Add a safe, debounced, single-flight, cooldown-protected autonomous loop that runs `graphify update .` when Phase 1 mutation tracking detects enough **code-only** changes. It must not block normal work, must not loop on its own output, must log every run, and must update state crash-safely.

Manual `/graphify-auto run-now --code-only` and `graphify_auto` tool actions `run_now` / `schedule` should be added.

## Constraints

- No LLM spend in Phase 2 autonomous path.
- Use `graphify update .` only for automatic runs.
- Do not run inside `tool_result`; run after `agent_end` debounce.
- Use a single-flight lock under `agent/graphify-autonomy/lock`.
- Respect pause/disable/cooldown.
- Ignore self-generated artifacts: `graphify-out/`, `agent/graphify-autonomy/`, `.git/`, `node_modules/`, logs, scheduler files.
- Clear timers on `session_shutdown`.
- Do not modify scheduler internals or scheduler state.

## State and config changes

### Extend `GraphifyAutonomyState`

Add:

```ts
runStatus: "idle" | "debouncing" | "running" | "failed";
activeRunId: string | null;
activeRunStartedAt: string | null;
scheduledFor: string | null;
lastRunExitCode: number | null;
lastRunDurationMs: number | null;
lastRunStdoutTail: string | null;
lastRunStderrTail: string | null;
```

Defaults:

```ts
runStatus: "idle",
activeRunId: null,
activeRunStartedAt: null,
scheduledFor: null,
lastRunExitCode: null,
lastRunDurationMs: null,
lastRunStdoutTail: null,
lastRunStderrTail: null
```

Update `DEFAULT_STATE` and `normalizeState` so old `state.json` files self-heal.

### Optional config additions

Add to config type/defaults/normalizer:

```ts
codeExtensions: string[];
runTimeoutMs: number;       // default 180000
maxOutputTailBytes: number; // default 4000
```

Recommended code extensions:

```ts
[
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php",
  ".swift", ".kt", ".scala", ".sh", ".sql", ".vue", ".svelte"
]
```

### Required ignore fix

In `isIgnoredPath`, add:

```ts
if (withSlashes.includes("/graphify-autonomy/")) return true;
if (/\.jsonl$/i.test(normalized)) return true;
```

This prevents state/run-log writes from triggering a new run.

## New helper functions

### Classification

```ts
function classifyChangedFiles(
  changedFiles: string[],
  config: GraphifyAutonomyConfig
): "codeOnly" | "docsOrMixed" | "ignoredOnly"
```

Rules:

- Drop `bash:` entries.
- Drop ignored paths.
- If nothing remains: `ignoredOnly`.
- If all remaining files use code extensions: `codeOnly`.
- Otherwise: `docsOrMixed`.

Conservative rule: bash-only changes do not qualify as code-only.

### Auto-run gate

```ts
function shouldAutoRunCodeOnly(
  config: GraphifyAutonomyConfig,
  state: GraphifyAutonomyState,
  classification: ReturnType<typeof classifyChangedFiles>,
  now: number
): { run: boolean; reason: string }
```

Return `run:false` if:

- disabled
- paused
- `runStatus !== "idle"`
- change count below threshold
- classification is not `codeOnly`
- cooldown is in the future

Return `run:true` otherwise.

### Lock helpers

```ts
type LockMeta = { pid: number; runId: string; startedAt: string; host?: string };

async function acquireGraphifyLock(runId: string): Promise<LockMeta | null>
async function releaseGraphifyLock(runId: string): Promise<void>
async function readLockMeta(): Promise<LockMeta | null>
function isLockStale(meta: LockMeta, now: number, maxAgeMs: number): boolean
```

Implementation:

- Acquire with `fsp.open(paths().lock, "wx")`.
- Write lock metadata.
- On `EEXIST`, read existing metadata.
- If stale by age (`runTimeoutMs + 60000`), unlink and retry once.
- Release only if current lock `runId` matches.

### Run executor

```ts
async function runCodeOnlyGraphify(
  cwd: string,
  reason: string,
  opts?: { force?: boolean }
): Promise<{
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  runId: string;
}>
```

Behavior:

1. Generate `runId`.
2. Acquire graphify lock.
3. If locked, return failure result with `stderrTail: "already running/locked"`.
4. Update state to `running` with active run id/start time.
5. Append run-log start event.
6. Run `graphify update .` from `cwd` using async `execFile` or `spawn`.
7. Timeout using `config.runTimeoutMs`.
8. Capture bounded stdout/stderr tails using `config.maxOutputTailBytes`.
9. Append run-log end event.
10. Release lock in `finally`.

Use `execFile`, not `execSync`, so the event loop is not blocked.

### Finalizer

```ts
async function finalizeRun(
  result: Awaited<ReturnType<typeof runCodeOnlyGraphify>>,
  reason: string
): Promise<void>
```

On success:

- `lastRunAt = now`
- `lastRunReason = reason`
- `lastRunMode = "code-only"`
- `lastRunExitCode = 0`
- store duration/tails
- `cooldownUntil = now + cooldownMinutes`
- `runStatus = "idle"`
- clear pending/scheduled/active fields
- reset `significantChangeCount = 0`
- reset `changedFiles = []`
- `failureCount = 0`

On failure:

- `runStatus = "failed"`
- increment `failureCount`
- set `lastFailureReason`
- store exit code/tails
- clear active/scheduled fields
- do not reset change counters
- keep pending reason

### Run log

```ts
async function appendRunLog(record: Record<string, unknown>): Promise<void>
```

Append JSONL to `agent/graphify-autonomy/run-log.jsonl`. Best-effort rotate/truncate to `config.maxRunLogEntries` lines.

### Debounce runtime

Module-scoped vars:

```ts
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let debounceArmedFor: string | undefined;
let runInProgress = false;
let lastKnownCwd: string | undefined;
```

Functions:

```ts
function clearDebounce(): void
function armDebounce(cwd: string, reason: string, delayMs: number): void
```

`armDebounce` should coalesce existing timers, set `scheduledFor`, then after delay re-read config/state and re-check `shouldAutoRunCodeOnly` before running.

## Lifecycle wiring

### `session_start`

- Ensure runtime files.
- Cache `lastKnownCwd = ctx.cwd`.
- If state says `running` but no valid lock exists or lock is stale, reset to `idle`.
- Optionally re-arm a pending debounce if state says `debouncing` and conditions still allow.

### `session_shutdown`

- Call `clearDebounce()`.
- Do not kill already-running child processes in Phase 2.

### `tool_result`

- Keep Phase 1 mutation tracking.
- Cache `lastKnownCwd = ctx.cwd`.

### `agent_end`

Replace `maybeMarkPendingAfterAgentEnd()` with `maybeScheduleAfterAgentEnd(cwd)`:

1. Preserve existing pending marker behavior.
2. Classify changed files.
3. Run `shouldAutoRunCodeOnly`.
4. If true:
   - set `runStatus = "debouncing"`
   - set `scheduledFor`
   - arm debounce using `config.debounceSeconds`
5. If false, leave pending marker for manual or Phase 3 handling.

If `agent_end` does not expose cwd, use `lastKnownCwd`.

### `before_agent_start`

Extend advisory text to show:

- `runStatus`
- `scheduledFor`
- `cooldownUntil`
- last failure if present

## Slash command changes

Rewrite `/graphify-auto run-now`:

```text
/graphify-auto run-now [--code-only] [--force] [path]
```

- Phase 2 supports only code-only.
- If `--semantic` or `--full` is provided, warn that it is deferred to Phase 3.
- Respect paused/disabled unless `--force`.
- Resolve path, defaulting to `ctx.cwd`.
- Fire-and-forget the run and immediately notify the user.
- A second call while locked should report already running.

Update `/graphify-auto status` to include:

- `runStatus`
- `scheduledFor`
- `cooldownUntil`
- `activeRunId`
- `lastRunExitCode`
- `lastRunDurationMs`
- stdout/stderr tail summaries if useful

## Tool changes

Extend `GraphifyAutoParams`:

```ts
const GraphifyAutoParams = Type.Object({
  action: StringEnum(["status", "mark_needed", "pause", "resume", "run_now", "schedule"] as const),
  reason: Type.Optional(Type.String({ description: "Reason for mark_needed, pause, or run." })),
  mode: Type.Optional(StringEnum(["code-only"] as const)),
  force: Type.Optional(Type.Boolean({ description: "Bypass pause/cooldown for manual override." }))
});
```

Tool behavior:

- `run_now`: start code-only graphify run asynchronously and return immediately.
- `schedule`: mark pending and arm debounce.
- Existing actions remain backward compatible.

Update tool description/guidelines to state Phase 2 is code-only and LLM-free.

## Export helpers for testing

Add to export block:

```ts
classifyChangedFiles,
shouldAutoRunCodeOnly,
isLockStale
```

## Verification commands

```bash
cd %USERPROFILE%/.pi/agent

# TypeScript parse/transpile check if full tsc is unavailable
node -e "const fs=require('fs'); const ts=require('typescript'); const f='extensions/autonomous-graphify/index.ts'; const r=ts.transpileModule(fs.readFileSync(f,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}, reportDiagnostics:true}); console.log((r.diagnostics||[]).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('\n') || 'transpile ok')"

# JSON parse check
node -e "JSON.parse(require('fs').readFileSync('graphify-autonomy/config.json','utf8')); if (require('fs').existsSync('graphify-autonomy/state.json')) JSON.parse(require('fs').readFileSync('graphify-autonomy/state.json','utf8')); console.log('json ok')"

# No-LLM graphify update baseline
graphify update .

# Scheduler untouched
git diff --stat extensions/agent-scheduler/ scheduler.json

# After reload/manual run
tail -5 graphify-autonomy/run-log.jsonl
```

In-session checks after reload:

```text
/graphify-auto status
/graphify-auto run-now --code-only
/graphify-auto status
```

Expected:

- Status shows running/debouncing/cooldown fields.
- Manual run starts exactly one update.
- Lock exists during run and disappears after.
- Success sets cooldown and resets change counters.
- A second run while locked is refused or reports already running.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `agent_end` lacks cwd | Cache `lastKnownCwd` from `session_start`/`tool_result`. |
| `graphify` missing from PATH | Log failure clearly, do not crash. |
| Self-trigger loop | Ignore `graphify-autonomy`, `graphify-out`, `.jsonl`, logs; reset counters on success. |
| Stale lock | Age-based stale break. |
| Runaway graphify | `runTimeoutMs` timeout. |
| TUI blocks on command | Fire-and-forget command/tool run. |
| Reload loses debounce | Persist `scheduledFor`; optionally re-arm on session start. |
| Concurrent state writes | Keep mutators short; Phase 4 can harden with a state lock if needed. |

## Recommended implementation order

1. Extend state/config/defaults/normalizers and ignore rules.
2. Add `classifyChangedFiles` and `shouldAutoRunCodeOnly`.
3. Add lock helpers.
4. Add run-log, executor, and finalizer.
5. Add debounce vars/functions and shutdown cleanup.
6. Wire `agent_end` scheduling and cwd caching.
7. Rewrite `run-now` command and enrich status.
8. Add tool `run_now`/`schedule`.
9. Add session-start orphan reset/re-arm and advisory text extension.
10. Run verification.

## Next action

Hand this plan to GPT 5.5 Codex for implementation. Start with steps 1–6 as the functional core, then add command/tool controls and verification.
