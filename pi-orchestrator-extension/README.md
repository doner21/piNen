# Pi Orchestrator Extension

A local Pi package that adds deterministic multi-agent orchestration through the established `orchestrate` tool and `/orchestrate` command, plus the side-by-side event-sourced `orchestrate_next` v2 pilot.

## API note

Pi v0.75.0 does **not** expose a built-in core subagent API. This extension uses the extension-style subagent mechanism available in this install: it spawns isolated `pi` subprocesses in JSON print mode:

```bash
pi --mode json -p --no-session --no-extensions ...
```

The orchestrator captures JSONL `message_end` events and uses the final assistant text from each subprocess. It also listens to child JSONL progress events (`message_start`, `message_end`, `agent_end`, tool-call starts, and tool execution events) so `/orchestrate` and the `orchestrate` tool can prove visible activity while work is happening. It treats assistant `stopReason: "error"`, `stopReason: "aborted"`, or `errorMessage` as subprocess failures even when the process exits 0. Work runs through Pi subprocesses; the only direct model-runtime call is the isolated same-route, no-tool restoration probe described below.

Subprocesses are launched with `--no-extensions` so recursive orchestration is hard-disabled and child agents cannot see the parent `orchestrate` tool. Executor agents should rely on built-in Pi tools selected by their `tools` allowlist. The host explicitly loads its own no-output bash monitor for every worker; an opt-in no-force-kill mission additionally loads the separate timeout-key dispatch guard. `--no-extensions` continues to suppress every unrelated discovered extension.

## Round 9: isolated login and same-run resumption

Shared renewal is **not implemented**. KL-01 remains UNPROVEN (read-credit-race prerequisite unavailable); KL-02 remains parked, not fixed (pure-import isolation checker can miss `process.getBuiltinModule`). Neither is PASS or universal isolation proof. The real-model exhaustion, owner-use/Telegram and live three-consumer renewal proofs remain deferred. A private access+expiry+EMPTY-refresh machine snapshot is nonrenewing and is **not** supported input to the provisioning API. No main-session credential reads, refresh-token copying, broker, automatic shared renewal, or completed-writer replay is implied.

**Before 24 October 2026 07:17:59 UTC**, obtain fresh **independent** Codex OAuth material privately for this isolated runtime alone. Do not display it. For the supported prepared configuration (`credentialRenewalOwner: "independent-runtime-login"`), place the private provider-keyed JSON file at an absolute, physical, single-link path **inside `config.runDir` but outside `config.runDir/runtime`**. It must contain a supported `openai-codex` OAuth record with nonempty access, refresh and accountId and expiry more than five minutes ahead. An EMPTY-refresh snapshot cannot be provisioned by these commands. Do not alter historical configs, authority, state, or logs to make validation pass; request a supported prepared configuration/material if unavailable.

Before provisioning, ensure the isolated host and workers have naturally settled; do not update credentials under active consumers. No main-session refresh token may be copied.

Use the configured absolute Node executable and the **already bundled** `launch.mjs` beside `orchestrate-host.mjs` inside that owned run. In PowerShell (replace paths and run ID with the existing prepared run's values):

```powershell
$node = 'C:/Program Files/nodejs/node.exe'
$launch = '<absolute owned run>/launch.mjs'
$config = '<absolute owned run>/config.json'
$material = '<absolute owned run>/independent-login.json'
& $node $launch --provision-login $config $material
```

Equivalent supported API (from an isolated Node ES module):

```js
import { provisionIsolatedLogin, validateConfig } from './launch.mjs';
await provisionIsolatedLogin(configPath, ownedIndependentMaterialPath);
validateConfig(configPath); // local usability only; never print the config/credential
```

Provisioning validates the physical paths and local expiry and updates only the isolated auth store using the SDK storage lock. It does not prove remote validity or renew a credential. A successful host-owned same-route no-tool restoration probe is required before the single infrastructure retry. A failed probe does not dispatch a worker; all real worker/probe subprocess launches consume the same durable run budget, including continuation and transport retries. No continuation replenishes that budget.

Inspect without launching a competing host:

```powershell
& $node $launch --status $config '<existing-run-id>'
```

**Original intake item3 (dead-host takeover) is deferred to ROUND10 under the owner's tg-<owner-message> cutoff.** Round9 has no public adopt action or headless takeover support; even ESRCH-dead ownership is not transferred. Preserve dead-host work for inspection/reconciliation, never replay the original run or completed writer. Foreign live, reused and unknown ownership still refuse continuation/acceptance. Historical helper/creator cleanup failures remain failed/UNKNOWN, not reclassified by this deferral.

The existing owning host may use tool/command `continue` with newly issued one-use approval. Same-owner restoration retry, independent review, bounded repair and reasoned acceptance remain supported with the ordinary admission, permission, settlement and budget fences. A new headless `--continue` host cannot transfer ownership. Refusal dispatches no worker. Tool/command inspection and headless `--status` distinguish durable outcome from current whole-tree cleanup; `completion.json` is SDK-only, never product completion. A fresh same-route no-tool response is required before the single durable infrastructure retry. Failed probes, exhausted caps, unknown cleanup, uncertain dispatch or terminal status never authorize replay or acceptance around failure.

Process cleanup retains Windows creation identities and creator ordering. Production and test collectors share PID0-aware validation of every positive inventory row and retain independently observed absence at existing sample/native-close boundaries before later PID reuse. Host-observed native root completion and independent kernel absence are retained per exact member birth, original launch and phase; later PID reuse cannot invalidate that settled member. Root completion never settles descendants, and missing/stale/mismatched facts never clear uncertainty. A living process born during a worker generation whose creator generation was missed (including creator PID reuse) makes ancestry **unknown**, not clean and not assumed owned. Exact generations already observed on a kernel ancestry path outside the worker are not attributed to it. Inspection, continuation and acceptance preserve unresolved uncertainty; this is not a universal process-observer claim or permission to terminate an ambiguous process.

Worker launches require supported **isolated** `runtime/agent/settings.json` settings `{"retry":{"enabled":false,"maxRetries":0,"provider":{"maxRetries":0}}}`. Preserve other prepared settings; do not change the owner's settings. Both launchers refuse before dispatch if effective worker retries remain enabled: only the host's durable logical operation may retry. Policy rewording consumption is retained across restoration and same-owner continuation. Both automatic retry routes require recorder-pinned launch/phase/task inventories assessed independently clean before restoration and again after asynchronous admission, immediately before retry consumption/dispatch. Root close or a cached clean flag never settles helpers. Cleanup-only obstruction preserves the pending allowance; eligible SAME-owner continuation can resume it after independently proven cleanup, without replaying its predecessor. Missing, changed or older unpinned evidence refuses rather than inventing authority. Typed cleanup/infrastructure refusal cannot become ordinary executor repair or advisory preflight retry.

Raw partial worker/provider and command streams are withheld at shared persistence boundaries: a later credential label cannot retract an earlier echo. Sanitized complete results, bindings, lifecycle events and process inventories remain available. Original retry evidence paths are durable across same-owner continuation; policy wording changes do not create another infrastructure allowance. Interrupted recovery whose settled prefix cannot be restored refuses rather than replaying shards. Native permission never authorizes owner-facing exposure without the required independent native review.

### Repeatable current-source qualification (writer and reviewer)

Use an existing **physical, owned, empty test scratch** beneath the prescribed wrapper's `coordinator/tests` directory. This stages source only: no SDK/dependency copies, links, installs or SDK rewrites. The checked-in test runtime resolver uses the existing frozen native ESM SDK and Jiti's native-module setting; it changes dependency paths, not assertions or extension factories. In Git Bash, set `S` to your owned scratch, then use this same invocation for writer and reviewer:

```bash
N='C:/Program Files/nodejs/node.exe'
B='C:/Users/you/pi-headless-runs/round9-final-task-bfe0e1c9-be36-4ac1-870e-bb14bd87234a/repair-after-review'
W="$B/coordinator/test-command.mjs"
C='C:/Users/you/pi-orch-round9-continuation-20261017-01'
F='C:/Users/you/pi-headless-runs/round9-repair-6772b2ed-847b-4581-ae1b-958bed54ac2d/frozen'
S="$B/coordinator/tests/product-repair-next" # reviewer: substitute your owned scratch
"$N" "$W" --cwd "$S" -- "$N" "$C/pi-orchestrator-extension/tools/prepare-round9-tests.mjs" "$C" "$S" --source-only
R="$S/copy/pi-orchestrator-extension"
(
  "$N" "$W" --cwd "$S" -- "$N" --require "$R/tests/fixtures/round9-command-preload.cjs" "$R/tools/check-round9.cjs" "$S" "$C" "$F" "$B/inputs" > "$S/final-aggregate.log" 2>&1
  # Outside the aggregate, after its wrapper naturally returns, even on failure:
  "$N" "$W" --cwd "$S" -- "$N" --require "$R/tests/fixtures/round9-command-preload.cjs" "$R/tests/test-round9-generation-cleanup.cjs" "$S" --outside > "$S/final-outside.log" 2>&1
) &
```

Monitor these safe logs and `aggregate/results.json`; a wrapper's own exit code is not its inner command's verdict. The wrapper's `settled.public.json` records that verdict. Do not refresh the staged source while qualification runs. For a focused check, substitute its test path and required arguments for `check-round9.cjs` in the same wrapped command. The aggregate is one-shot per scratch. Both product results and the separate post-return reconciliation must pass before review; survivors or missing/unknown inventories are not clean, and an aggregate's still-running console/helpers are not cleanup proof.

Cutover remains owner-only; no reload/restart of existing windows. Undo is an owner-controlled ordinary code revert/cutover, not a mutation of frozen active runs. The repair itself makes no commit or live deployment.

## Pi CLI resolution

By default, the extension prefers the currently running Pi CLI script when available, then known installed `cli.js` locations, then falls back to `pi` (`pi.cmd` on Windows). Optional overrides:

- `PI_CLI_PATH`: path to a Pi executable or script. `.js`/`.mjs`/`.cjs` paths are run with the current Node executable; Windows `.cmd`/`.bat` paths are spawned through a shell.
- `PI_CLI`: command name/path override used as the executable command. On Windows, `.cmd`/`.bat` values are spawned with `shell: true`.

## Install

```bash
pi install C:/Users/you/pi-orchestrator-extension
```

If Pi is already running, reload resources after installing or changing the extension's own TypeScript:

```text
/reload
```

This install-time reload is not part of the ordinary workflow lifecycle. Once this extension version is active, adding or changing a declarative workflow JSON artifact is discovered on the next `orchestrate` invocation in the same Pi session.

## Command usage

```text
/orchestrate add tests for auth
/orchestrate run --supervision visible-main --lane product --write-set src/auth.ts,tests/auth.test.ts -- add tests for auth
/orchestrate run --supervision visible-main --external-evidence-roots C:/Temp/audit -- evaluate the existing audit without changing it
/orchestrate run --supervision visible-main --no-force-kill -- "run without bash timeout arguments"
/orchestrate inspect --run-id orc-example
/orchestrate continue --run-id orc-example --approval-token sup1_opaque-token
/orchestrate accept --run-id orc-example --approval-token sup1_... --reason "Owner accepts the documented residual"
/orchestrate pause --run-id orc-example
/orchestrate cancel --run-id orc-example
/orchestrate --max-subagents 24 --max-retries 2 add tests for auth
/orchestrate --planner-model gpt-5.5 --planner-provider openai-codex --executor-model deepseek-v4-pro --executor-provider deepseek "plan with GPT 5.5, execute with DeepSeek V4"
/orchestrate --concurrency 3 --planner-agent planner --executor-agent coder --verifier-agent reviewer -- "task text that may start with dashes"
/orchestrate --resume orc-historical-abort-survivor
```

Supported command flags:

- `run|inspect|continue|accept|pause|cancel` or `--action ACTION` — supervised lifecycle forms. Non-run actions require no task and never open the task prompt. `accept` additionally requires `--reason`.
- `--run-id ID` and `--approval-token TOKEN` (alias `--token`) — select a durable run and consume the immediately preceding one-use checkpoint approval. At an eligible settled verifier boundary the same authority may be consumed by either `continue` or terminal `accept`, never both.
- `--reason TEXT` — required only for `accept`; trimmed nonempty text up to 2,000 characters is persisted in `supervision.json` and the acceptance checkpoint.
- `--supervision visible-main|off` (aliases `--visible-main`, `--off`) — standard command PEV implementation defaults to `visible-main`; `off` is the explicit bounded/headless compatibility path.
- `--adaptive-supervision off|shadow-v1|enforce-canary-v1|adaptive-v1` — default `off`; bounded to fresh generic visible-main `plan-execute-verify` runs. See “Adaptive Supervision v1” below.
- `--lane product|orchestrator-maintenance` (aliases `--product`, `--orchestrator-maintenance`) — freezes the mutation lane. A product run cannot switch into maintenance during continuation.
- `--resume ID` (or positional `resume ID`) — distinct legacy abort-survivor resume; it does not mean visible-main `continue`.
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
- `--external-evidence-roots PATHS` (alias `--evidence-roots`; tool API: `externalEvidenceRoots: string[]`) — freeze up to 32 canonical absolute directories for read-only evidence inspection and host evaluation. The declaration is never write authority.
- `--numeric-gates JSON` — freeze optional per-criterion numeric gates for visible-main runs. The value is a JSON array; the tool API equivalent is `numericAcceptanceGates` (structured array). Each entry supplies `criterionId`, `metric`, optional `unit`, `source` (`path` plus exactly one of `jsonPointer` or `regex`), `op`, and finite `threshold`.
- `--allow-local-model` / `--no-allow-local-model` — local model guard override.
- `--paradigm NAME` — select a built-in/native shape or a safe kebab-case declarative workflow discovered at invocation time. Built-ins include `plan-execute-verify` (default), `multi-verify-vote`, `composable-pipeline`, `dual-plan-synthesis-execute-verify`, `verify-only`, `paradigm-creator`, `shape-builder`, `win-console-spawn-root-cause`, `win-lifecycle-process-trace`, `frozen-gate-fix-loop`, `evidence-audit`, `independent-replication`, and `ssi-single-writer-exclusive-lane`.
- `--hard-gates MODE` — judgment-layer gate mode: `strict` | `advisory` (default) | `off`. See "Judgment layer" below.
- `--preflight` / `--no-preflight` — toggle the 1-token provider health pings run before any subagent spawn (default on).
- `--no-force-kill` (tool API: `noForceKill: true`) — opt into a mission-bound worker guard. The frozen mission records the choice, every guarded child explicitly loads `src/worker-execution-constraints.ts` alongside the host-owned no-output monitor, and any `bash` argument object that owns a `timeout` key with a value other than `null` (a number including zero, a string, a boolean, an object, an array, or `undefined`) is blocked before dispatch. A `timeout` key that is absent, or present and explicitly `null` (as OpenAI's strict tool schema always sends for an omitted optional field), is allowed. The default is `false`, preserving ordinary mission behavior.
- `--planner-fallback-model M`, `--planner-fallback-provider P` (and the `executor`/`verifier` variants) — per-role fallback route applied when the primary route fails pre-flight (graceful degradation).

### No-output test-child policy

Every worker bash tool measures command-attributed stdout and stderr. A command-scoped `PATH` shim routes executed bare-`node` invocations through an authenticated helper without rewriting shell text, so `cd`, `command`, `exec`, pipelines, stdin, heredocs, shell PATH changes, and Pi session context retain normal semantics. User `NODE_OPTIONS` and preloads are removed from the trusted helper and restored exactly once in the test process.

Before provider preflight or the planner, the host creates one run-scoped test-authorization policy and binds it into the frozen mission/run parameters. Existing entrypoints are conservative candidates from the complete literal JavaScript graph of pre-existing `test`/`test:*` package scripts and are admitted only when the owner task positively authorizes testing; explicit instructions not to run tests produce empty authority. New or changed tests require an upfront approved exact file path beneath an already established package-test parent, so a general product directory such as `src` cannot become test authority. Both launchers, retries, continuation and resume serialize that same immutable policy without rereading package metadata. A historical run without a stored policy remains observe-only rather than resnapshotting after past worker mutation. Filenames, directory names, model claims, and `--test` appearing after a script grant no authority.

Each launch separately binds the canonical executable and entrypoint digest, complete Node options/argv hash, cwd, effective environment hash, user preloads, PATH and argument-selected output destinations. Unknown Node options, unauthorized preloads, changed out-of-scope entrypoints, or more than 32 output destinations are explicit observe-only cases.

Silence uses a reusable external Windows service bound only to privately registered, freshly spawned authorized test children. Through installed PowerShell/.NET interop it opens and retains `PROCESS_QUERY_LIMITED_INFORMATION` handles, validates executable and creation identity, and samples full `GetProcessIoCounters` values independently of the test event loop. It performs no process enumeration, name lookup, PID reacquisition, or termination. Write-operation/transfer increases reset silence even when the destination is undeclared; the evidence states that the filename/log content is unknown. Other-I/O growth is uncertainty that resets/disarms the silence episode rather than being claimed as output. Read counters alone do nothing.

The trusted in-test preload declares only lifecycle coverage—worker threads, descendants, native addons and transport—not filesystem write methods. Worker-thread writes share the process counters. Loss/staleness/error of either authenticated transport disables cancellation. A Node child launched by an approved wrapper is independently transported and admitted; the wrapper itself is never a target. Unknown descendants or native `process.dlopen` disable parent cancellation because direct-parent counters are then incomplete.

No monitor-owned file handle is retained, and no content-reading file open occurs, while a test is running. Declared paths are captured only after the child has actually settled, using bounded transient reads with parent, leaf, opened-handle identity and containment checks and `finally` closure. The current final object may be captured; displaced, renamed or deleted generations are explicitly reported as unavailable and are never inferred from a replacement pathname. Capture failure cannot erase an authenticated cancellation. If a supported test writes only an undeclared file, process-counter activity keeps it alive, but no filename or partial file log is invented.

The production defaults are a 2-minute minimum observation window, an alarm after 5 minutes without output, and cancellation after 10 minutes without output with at least 30 seconds of lead after the alarm reaches the host progress/log seam and is positively acknowledged. A mandatory bootstrap extension blocks every bash dispatch unless the monitor was constructed, so readiness is pre-dispatch rather than a post-settlement assertion.

Cancellation is not a command deadline. Any attributed output resets silence, so an active command can run indefinitely. The helper may act only on the exact direct Node test child it created and still owns by `ChildProcess`/libuv handle; it never targets a PID, process tree/group, shell, helper, worker/agent, application, native/audio process, descendant, owner-launched process, or another session. A successful `kill()` return is only an action receipt: `cancelled_no_output` requires the later matching terminal `SIGTERM` outcome with no exit code.

Each authenticated terminal cancellation is immediately streamed to an append-only host-owned digest-chain journal before later worker turns. Artifact digest/read failure cannot erase the classification. Inline ledger records are byte-bounded; complete identifiers and artifact references remain discoverable through journal path, count and final digest, including commands with more than 200 cancellations.

A fresh `run` without task text prompts for one; non-run actions and legacy resume never do. **Visible-main is capability-driven, not PEV-only.** Every registered native shape and invocation-time declarative workflow declares one immutable execution classification: `read-only`, `executor-bearing`, or `mutating`. Executor-bearing and mutating shapes use the host-owned `host-task-boundary-v1` protocol (the PEV adapter or shared generic adapter), stopping at a durable plan checkpoint before execution and again after every settled task before any next task or verifier. This applies to current bespoke/native shapes, shape-builder output, dynamically discovered workflows, future registrations, and historical run-state resume. Missing, contradictory, unknown, or merely well-formed-but-unimplemented adapter declarations fail before provider preflight or worker spawn. Omitting `supervision` never selects legacy execution; only explicit `--supervision off` does.

`awaiting_supervisor` is **not completion**: use read-only `inspect`, compare the compact checkpoint audit with the frozen mission, criteria, lane, approved write set, and byte-level effects, then choose `continue`, eligible `accept` with a reason, `pause`, or `cancel`. `accept` is offered only after a settled verifier checkpoint with no active or detached worker. It consumes the exact mission/checkpoint-bound one-use authority atomically and records terminal `accepted_with_reason`; it is deliberately distinct from verifier `PASS`, `FAIL`, pause, and cancellation. It does not add completed criteria or rewrite the historical verifier payload. Every executor checkpoint also carries host-owned `hostMetadata.approvalConsumption`: a SHA-256 token fingerprint, the complete run/mission/source-checkpoint/action binding, and the consumption timestamp produced by the same atomic compare-and-consume that authorized that dispatch. The raw token is never stored there, and approval claims in worker output have no authority. Host-observed verifier mutation and failed frozen numeric gates remain ineligible hard stops. Replay, cross-run/cross-checkpoint use, and tokens issued before a host restart are refused. A fresh host pauses every nonterminal supervised run and requires a newly issued approval. The visible agent coordinates only—it must not implement product work directly or convert a product run into orchestrator maintenance.

### Numeric acceptance gates

A visible-main run may bind a mechanical measurement to a frozen criterion. For example, the tool input below requires the persisted JSON measurement to be under 1,000 ms:

```json
{
  "numericAcceptanceGates": [{
    "criterionId": "AC-01",
    "metric": "renderer end-to-end",
    "unit": "ms",
    "source": { "path": "evidence/measurement.json", "jsonPointer": "/rendererEndToEndMs" },
    "op": "<",
    "threshold": 1000
  }]
}
```

Relative evidence paths resolve from the frozen mission cwd. An absolute numeric source must be beneath a frozen `externalEvidenceRoots` declaration; undeclared, traversing, protected, or symlink/junction-escaping paths fail closed. `jsonPointer` uses RFC 6901. A `regex` selector uses its first capture group (or the full match) as the number. The host reads a regular persisted file (maximum 4 MiB) at verification time, emits a concrete `numericGateFindings` entry with the observed value and comparison, and makes a miss, missing file, parse error, or non-finite value a hard FAIL. These findings supplement rather than replace the semantic verifier.

Owner-authored comparator targets such as `settle <= 12 s`, `survivors == 0`, or `quality > 99 %` become separate frozen numeric criteria. Dates, hashes, defect/task labels, model/route names, examples, and historical inventory counts do not. A matching configured gate freezes its file selector, operator, threshold, and unit; duration targets may match equivalent units such as `1 s` and `1000 ms`. If no gate supplies a real persisted source selector, the mission and plan checkpoint instead record `numericEvaluationUnavailable` with the explicit reason that the host will not invent evidence. A semantic verifier PASS then stops at `awaiting_supervisor`, never silently promotes prose-only target coverage to mechanical PASS. Missions without an owner-authored numeric target or configured numeric gate retain prior behavior.

At a slash-command checkpoint, the extension clears active dashboard/footer state and queues at most one fixed follow-up containing only validated run/checkpoint IDs. It never includes task/subagent text or approval tokens, and tool-call checkpoints do not queue this follow-up because the calling model already receives the result. UI labels distinguish awaiting supervisor, paused, blocked infrastructure, cancelled, terminal PASS, terminal FAIL, terminal ACCEPTED_WITH_REASON, and stale/replayed-token refusal. Explicit `--supervision off`, explicitly classified read-only shapes, and the distinct legacy abort-survivor resume syntax retain compatibility. Historical executor-bearing runs are bound to the durable protocol identity and shape-neutral cursor when resumed; detached survivors are collected rather than silently duplicated.

While running, `/orchestrate` surfaces visible progress in the Pi window: status/footer text, a live widget, durable `orchestrate-progress` messages, and child JSON-mode events such as subagent launches, assistant starts/finishes, and tool-call starts. Terminal and compatibility runs notify a summary and send a durable visible `orchestrate-result` message.

### Adaptive Supervision v1

Adaptive supervision is public but **default-off**. Omitting `--adaptive-supervision`, or passing `off`, uses the ordinary path and creates no adaptive state or execution authority:

```text
/orchestrate run --supervision visible-main --adaptive-supervision shadow-v1 --paradigm plan-execute-verify --write-set src/example.ts -- "implement the bounded task"
/orchestrate run --supervision visible-main --adaptive-supervision adaptive-v1 --paradigm plan-execute-verify --max-subagents 6 --write-set src/example.ts -- "implement the bounded task"
/orchestrate run --supervision visible-main --adaptive-supervision enforce-canary-v1 --paradigm plan-execute-verify --max-subagents 6 --write-set src/example.ts -- "exercise the legacy bounded canary"
```

The tool equivalent is `adaptiveSupervision: "shadow-v1" | "adaptive-v1" | "enforce-canary-v1"`.

- `shadow-v1` observes **actual** ordinary planner/executor work. It durably records criterion-derived gap changes, grounded progress or no-progress, repeated-failure classification, current visible-main behavior, and `wouldDecide`, always with `controlledExecution:false`. It performs no synthetic worker dispatch and cannot change execution.
- `adaptive-v1` is the production path. One coherent real Strategy A task executes normally. A sole instrumented same-family retry is allowed; a second equivalent no-information failure exhausts that family. A routed model then proposes materially different Strategy B, while host code classifies material dimensions and rejects mission-hash drift, acceptance substitution, disguised repetition, unsafe operations, out-of-scope mutation, missing evidence, or budget excess. Legal B is fsync-persisted and read back before same-run dispatch. The original frozen mission, acceptance criteria, gaps, run identity, safety scope, and single initial approval survive A→B; successful B proceeds directly to independent strict verification without a second approval. Acceptance gaps close only from verifier evidence, never file/process activity.
- `enforce-canary-v1` remains the deterministic compatibility canary with deliberately forced A,A,model-B,B phases.

Production v1 is deliberately bounded to a fresh generic visible-main `plan-execute-verify` run, one coherent plan task covering all frozen criteria, at least six subprocess slots, and exact file/directory write scopes (no globs). Supervision-off, other paradigms, legacy resume, discovery-only, malformed proposals, and restart after an unresolved execution reservation fail closed before replay. Omitted/off behavior is unchanged.

If `--max-subagents` is omitted, the extension auto-raises the ceiling after planning when the discovered plan size and retry budget require more than the default. Example: 6 executor tasks with `--max-retries 2` needs `3 * (1 planner + 6 executors + 1 verifier) = 24` subprocesses, so the default ceiling auto-raises from 12 to 24. If `--max-subagents` is provided explicitly, that number is honored and auto-raise is disabled.

## Orchestrator Next v2 (side-by-side pilot)

`orchestrate_next` is the opt-in replacement kernel. It keeps workflow compilation, scheduling, retries, semantic gates, workspace effects, and durable state transitions in one host-owned runtime. The established `orchestrate` tool remains registered as the legacy escape hatch while v2 proves cutover thresholds.

Supported pilot actions:

- `action=run` — start `read-only-fanout-join` or `single-writer-pev`.
- `action=resume` — supply only `runId`; the task, workflow, routes, typed input, product workspace, and command profile are restored from the pinned event log.
- `action=inspect` — inspect projection and durable worker publication state without launching workers or acquiring the run writer lease.

The writer PEV executes its agent in a disposable workspace copy under the host-owned run directory. This copy intentionally includes dirty tracked, untracked, and ignored prerequisites while excluding `.git` administration. A host `integrate` primitive compares the candidate to its base, rejects source disagreements or product bytes changed after isolation, then applies only conflict-free candidate effects. Tests and verification run against the integrated product workspace. Runtime files never live under the product workspace.

Parent cancellation uses durable survivor manifests and result publication. A still-live survivor projects as `PENDING`; resume inspects it before any replay, promotes a published schema-valid result with its real process exit code, and never duplicates a shared writer. Disposable isolated writer attempts may be replayed only within their compiled bounded retry policy. A full host-process crash before the background result publisher flushes remains detectable (dead survivor without result), not silently treated as success.

Public writer tests accept only `validator=node-workspace-validator`. Before any worker starts, the host captures and SHA-256-pins workspace-contained `./validate.cjs` under the external run directory, retains its bytes in coordinator memory, and later executes those captured bytes through the current Node executable's stdin with trailing pinned arguments preserved. An executor may mutate the product copy of `validate.cjs`, but it cannot replace the validator bytes used by that run. Caller executable paths, argv, and runtime roots are not public controls.

Validation commands:

```bash
npm test
npm run benchmark:next
```

`npm test` includes a deterministic 1,000-run fault corpus. The benchmark compares a two-worker legacy `verify-only` fixture with v2 read-only fan-out/join and confirms that both public tools remain available. Current cutover state and thresholds are in [`ORCHESTRATOR-NEXT-CUTOVER.md`](ORCHESTRATOR-NEXT-CUTOVER.md).

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
The visible-main host uses this hard/advisory split. A deterministic observation
never replaces an available semantic reviewer verdict unless it protects an
explicit safety boundary:

| Class | Check | Host behavior |
|---|---|---|
| **Hard** | Reviewer's substantive semantic criterion or overall `FAIL`, including explicit owner formatting requirements | Preserve the reviewer verdict; run a bounded repair when permitted, otherwise end `FAIL`. Unknown criterion provenance fails closed. A presentation-only FAIL is treated differently only when the frozen provenance proves the rule was planner-inferred. |
| **Hard** | Frozen numeric acceptance gate misses its threshold or cannot read a finite value from its persisted evidence source | Emit the observed host finding and fail acceptance regardless of reviewer prose. Boundary equality follows the frozen operator. A passing numeric gate does not override a semantic verifier FAIL. |
| **Hard** | Missing, replayed, concurrently consumed, or cross-bound approval; mission/checkpoint identity mismatch; worker-authored approval claims; unsupported supervision adapter | Refuse before another worker can spawn. Executor checkpoints receive host-owned consumed-approval metadata from the exact atomic dispatch authority (nonsecret SHA-256 fingerprint, full binding, timestamp), never a raw token or worker claim. An accept reason cannot bypass token binding, an active/detached worker, verifier mutation, or a failed frozen numeric gate. |
| **Hard when explicitly frozen** | A guarded worker calls `bash` with an own non-null `timeout` argument key | Own non-null timeout values are blocked before tool dispatch by the explicitly loaded worker hook; an absent key or explicitly `null` value is allowed; the host does not rely on post-hoc phase-log detection. The mission choice and resume parameters are frozen, and continuation cannot weaken it. Ordinary missions do not load the guard. `--no-extensions` still excludes every unrelated extension. |
| **Hard** | Spawn/concurrency/iteration/retry/task-size ceilings | Clamp or refuse; a model cannot enlarge host budgets. |
| **Hard** | Invalid or undeclared external evidence root/path, or any add/change/delete beneath a declared external evidence root | Require an existing canonical absolute directory outside the worktree and protected host roots. Declarations permit reads and numeric/verifier evidence evaluation only. Parent traversal, glob roots, protected overlaps, symlink/junction aliases or escapes, and unobservable contents fail closed. An external path in `predicted_write_set` remains a denied worktree escape; the host never converts it into evidence-root write authority. |
| **Hard** | Protected-root, external-worktree, or symlink-crossing mutation; visible-main verifier source/build/workspace file add/change/delete | Refuse the unsafe effect. Visible-main verifiers receive `read,grep,find,ls,bash` but not `edit`/`write` or extension/custom tools: read-only is enforced by effects, not by withholding the shell. The host snapshots the bounded workspace immediately before and after the entire concurrent verifier batch without ordinary directory exclusions or practical truncation limits, persists raw and protected content hashes, hash/omission drift, and exact add/change/delete evidence in `supervision.json`. Any non-advisory detailed/protected-hash mutation, including a source or build artifact beneath an otherwise ignored directory or the host runs root, overrides self-report with exact code/reason `verifier_mutation`. An in-worktree planner write-set omission is only advisory. |
| **Hard** | Ambiguous transport loss after mutation with no complete bound phase result | Return `blocked_infrastructure`, `retryAllowed=false`; never duplicate uncertain work. |
| **Round9 restored infrastructure** | Complete zero-tool auth/provider failure | One durable same-role retry only after an independent no-tool response on the same isolated provider/model/API/endpoint. Failed probes stay blocked; credential changes/expiry and elapsed time are not proof. Fresh lifecycle continuation does not reset consumed retry authority. No main-login access or shared renewal broker. Admission, permissions and spawn caps remain enforced. |
| **Hard** | Explicit forbidden route/provider, authentication/policy/refusal failure, or local-model safety restriction | Refuse before work dispatch. A terminal policy refusal is recorded distinctly as `provider_refused`, never as context exhaustion or generic result loss, and health probing does not reword or retry auth/policy/refusal errors. Missing route *observation* is different and is advisory. |
| **Bounded preflight recovery** | A provider-health ping fails with a transient timeout/network/transport result | Retry the identical provider/model route once within the total preflight budget; never invent a fallback route. Recovery is advisory. An exhausted zero-worker abort is durably checkpointed as `preflight_aborted`/`blocked_infrastructure` with classified error evidence, zero worker dispatch, and explicit `productMutation=false`/`resultLostAfterMutation=false`, including legacy/off paths that had not initialized ordinary supervision. |
| **Hard** | Verifier `PASS` contradicted by zero effects for explicitly mutation-bearing work when hard gates are enabled | Preserve the false-PASS effect guard. `hardGates: "off"` demotes it. |
| **Hard when frozen into the run** | Product safety invariants such as unauthorized SSI native edits, `main.ts` beyond an allowed list-only change, owner-store mutation, force-killing owner processes, or forbidden STOP/WASAPI/ROLI/A-B/`OneUseReservation` changes | Enforce through protected write scope and the reviewer's semantic acceptance criteria; never reinterpret these as evidence-schema advice. |
| **Hard interaction boundary** | A second Escape attempts to abandon an active visible-main phase that is settling after a pause request | The first Escape is acknowledged immediately but preserves `settleOnAbort=true`: the dashboard names the active phase and continuously shows elapsed settlement wait. A later Escape is consumed by a separate confirmation; abandonment occurs only after an affirmative **Confirm and abandon** choice that warns interruption can leave partial files. Declining keeps waiting. The extension observes terminal input without replacing an existing custom editor, and clears the transient status when the phase settles. |
| **Hard scheduler expiry prerequisite** | A pending record has an explicit or origin-fallback session fence | A store read may retire it only after a short creation grace, a conclusive `ENOENT`/`ENOTDIR` target-file probe, and a complete process/session inventory with no live or unknown-liveness exact target in the origin cwd. The failed record retains a visible `session fence expired on store read` reason. Existing files, uncertain filesystem/process observations, confirmed `/new` retargets, and unfenced cwd records remain pending. |
| **Hard paused-run retirement prerequisites** | A prior host generation left a run at the dead-owning-host pause boundary | A later host may settle it as terminal `RETIRED_DEAD_HOST` only after two read-only assessments conclude the exact owning PID is absent by `ESRCH`, every worker attempt has validated phase settlement and clean exact-generation evidence, and run state contains no detached worker, survivor artifact, ambiguous settlement, or inaccessible/unknown evidence. Successful results, closed unsuccessful attempts and explicit never-dispatched attempts remain distinct; a later unrelated worker PID reuse cannot undo proven generation settlement. The second assessment occurs under the retirement mutation fence immediately before persistence. Live hosts/workers, owning-host PID reuse, unproven worker reuse, `EPERM` or other ambiguous probes, malformed/legacy ownership, and survivor cases remain byte-identical. Retirement sends no signal, preserves the dead-host-only pause reason and historical findings, adds no passed criterion, and is never PASS. Newly detected dead hosts are paused after the retirement sweep, so they cannot be retired in the same host generation. |
| **Hard runs-state retention prerequisites** | A phase log reaches the seven-day age or 20 MiB size default | Default invocation is still dry-run. `--apply` may compress/remove or trim only a regular top-level `phase-*.log` after exact run ownership, terminal supervision, nonempty all-`done` durable phases, empty active/detached-worker audit, no survivor/symlink, and conclusive `ESRCH` host/worker absence. State hashes, file identities, canonical paths, liveness, and archive nonexistence are fenced again immediately before mutation. Missing supervision is inventory-only; age, a terminal label, or AK2 retirement metadata alone grants no deletion authority. Checkpoints and `*.result.json` are never targets. |
| **Explicit supervisor disposition (not PASS)** | `accept` with a bounded reason at an eligible settled verifier checkpoint | Consume the one-use checkpoint authority, append immutable host-owned acceptance metadata, and end `accepted_with_reason`. Preserve prior verifier findings and the existing completed-criteria list; later continue/accept calls are refused. |
| **Advisory pause request** | First Escape while a supervised executor is active | Request a pause and keep the worker alive until its durable result settles; do not silently detach or interrupt it. The pause is applied at the resulting checkpoint. |
| **Advisory supervisor boundary** | Owner-authored numeric target has no configured persisted evidence selector | Freeze the target and an explicit `numericEvaluationUnavailable` reason, preserve semantic verifier evidence, and stop at `awaiting_supervisor`; never invent a metric/file or report mechanical PASS. |
| **Advisory** | Verifier evidence schema/vocabulary: invalid bounds or counts, malformed/duplicate/orphan/missing criterion entries, malformed status or evidence arrays, unsupported kinds, missing/oversized observations, malformed hashes, missing machine evidence | Attach `verificationIssues`; retain an otherwise valid semantic `PASS`; do not spend repair budget. |
| **Advisory** | A verifier marks an otherwise grounded criterion `FAIL` solely because multiline output violated a planner-inferred presentation rule | Preserve the raw verdict and presentation telemetry, normalize that inferred-only finding to semantic `PASS`, and spend no repair budget. This requires explicit frozen `inferred` provenance, zero failed command evidence, and grounded substantive evidence; explicit owner format, semantic failures, mixed failures, or uncertain provenance remain hard. |
| **Normal** | Verifier response is strict valid JSON | Parse it without recovery and apply its semantic verdict normally. |
| **Advisory recovery, ordinary terminal verdict** | Verifier JSON is valid except for at most two missing closing `]`/`}` tokens at EOF, and the raw response already contains one internally consistent status plus exactly one complete evidenced finding for every frozen required criterion | Recover only the closing suffix, preserve the raw response, attach `verifier_json_eof_suffix_recovered` and `complete_recovered_verifier_verdict`, then apply the semantic PASS or FAIL immediately. A complete recovered PASS spends no second verifier batch; host numeric gates and the verifier-mutation fence still override it. |
| **Advisory supervisor boundary** | Bounded two-closer recovery fails, but the response has one unambiguous root `pass`/`fail` status and a complete, nonempty `criterionFindings` collection needing the finding/array/root EOF closers | Conservatively reconstruct those structural closers, preserve the raw response, attach `verifier_json_semantic_fallback`, and stop at `awaiting_supervisor`. This less-authoritative fallback never receives automatic terminal promotion, and no reason, finding, evidence, or substantive value is invented. |
| **Hard** | Verifier output or recovered verdict remains malformed, ambiguous, contradictory, incomplete, or missing a frozen finding | Reject it as invalid/incomplete verifier JSON; duplicate root fields, incomplete strings/primitives, mismatched delimiters, middle corruption, empty evidence, unknown/duplicate/missing criteria, and truncations without complete semantic findings are not eligible for terminal recovery. |
| **Bounded retry** | Provider refuses an invocation whose launch capabilities are provably read-only/no-tool and whose observed mutating-tool count is zero | Retry once with defensive evidence-only wording while preserving frozen criteria. Persist `provider_refused` cause/eligibility telemetry. A repeated refusal stops deterministically; any mutation-capable or ambiguous invocation receives no automatic retry. |
| **Retryable infrastructure** | The complete normalized reason, evidence value, or non-JSON response is an allowlisted capability-only statement that this verifier/worker lacks bash or command execution (including the historical exact `this worker exposes only read/grep/find/ls, not bash` form), and no substantive failed reason or evidence remains | Persist `command_unavailable` with retry eligibility. Matching is anchored to the whole statement and fails closed; command/tool/bash/cannot/unavailable token proximity never implies infrastructure. Structured JSON qualifies only when the raw response is exactly that object or one enclosing fence: a capability-only object extracted from surrounding prose remains a semantic FAIL. Strip only allowlisted capability statements into telemetry without spending semantic repair budget. Any product, runtime, implementation cause, or finding remains a criterion FAIL, including first-person or verifier-subject prose. |
| **Advisory** | Command/test evidence has a nonzero exit, an invalid `expectedExitCode`, or an observed exit different from `expectedExitCode` | Report the observation. A negative control may set integer `expectedExitCode`; matching nonzero evidence needs no warning. |
| **Advisory** | Settled executor changed zero bytes, including `expectsFileChange=true` work | Preserve semantic status/findings and stop for supervisor judgment with `no_content_progress` advice. |
| **Advisory** | Visible-main verifier changes a narrowly enumerated tool cache (`node_modules/.vite/**`) while running allowed checks | Retain the cache path in the exhaustive raw diff and raw hash drift, record it in `ignoredToolCacheChanges`, and apply the semantic verdict when the protected hash, omissions, and every non-cache path remain unchanged. This is not a general exemption for `node_modules` or another ordinarily ignored directory. |
| **Advisory** | Current or concurrent host bookkeeping changes beneath the configured runs root during a verifier batch | Retain every path in the exhaustive raw diff and raw hash drift, record only direct children of recognized `orc-*` run directories with enumerated phase/checkpoint/state/supervision runtime names in `ignoredHostRuntimeChanges`, and apply the semantic verdict when protected hashes, omissions, external evidence, and all other paths remain unchanged. A directory merely named `runs-state`, nested/lookalike paths, malformed run ids, and arbitrary source/build/JSON/log files remain hard verifier mutations. |
| **Advisory** | Missing/mismatched launcher route observation, commit/content baseline drift, declared external read-only path reference, or in-worktree planner scope omission | Record precise details for the supervisor; never rewrite product acceptance. |

Malformed output with no semantic `pass`/`fail` verdict is still an absent verdict,
not a semantic PASS. The table governs cases where a reviewer actually supplied
one.

- **Effect-evidence immunity**: a task with ≥1 successful mutating tool call
  or ≥1 observed file change is immune from all text-shape findings in every
  mode. Executors that do real work and reply with a summary table PASS.
- **Targeted retries (F2)**: per-task pass/fail state persists across
  attempts. Tasks referenced in failure reasons are retried; the rest are
  reused (their prior outputs are routed to re-verification, never
  regenerated) as long as their artifacts still exist on disk. The planner is
  told which tasks are already complete and must not re-create them.
- **Pre-flight + structured failures (F5/AG)**: before spawning any work subagent, a
  1-token health ping runs for each routed provider/model pair. A transient
  timeout/network/transport result gets exactly one retry on that identical
  route; authentication, policy, refusal, not-found, and rate-limit results are
  immediate hard failures. Every ping has a 20-second wall-clock timeout and
  the complete primary/retry/configured-fallback preflight has a 75-second
  wall-clock budget. Recovery is an advisory with attempt provenance. Exhausted
  or aborted zero-worker preflight produces a machine-readable error
  (`provider`, `model`, `type`) and a terminal partial FAIL report instead of
  hanging or dumping raw payloads. It also creates a durable infrastructure
  checkpoint, even on legacy/off paths before ordinary supervision existed;
  that checkpoint explicitly records zero work dispatch and no product
  mutation or result-loss-after-mutation claim.
- **Criterion authority and intake provenance (F6/AD)**: intake and the frozen
  mission separately persist `ownerCriteria`, `supervisorAddedConstraints`, and
  `plannerInferredPresentationRules`. The compatibility view still carries
  `source: explicit | inferred` in `intake.criteriaProvenance`. Synthesized
  presentation guidance is advisory and is never copied into product acceptance
  or failure criteria. Literal owner output markers remain hard. The same
  provenance labels are included in planner, executor, and verifier prompts so a
  planner cannot silently turn “concise” or an unrelated “exactly once” product
  requirement into a line-count gate.
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

## Guard decisions (2026-09-03)

Three host guards used to turn legitimate steps into hard stops. They now surface as
decisions or effect checks, so the supervisor decides and the verifier still gets a turn:

- **Out-of-set edit is a scope decision, not an infrastructure block.** When a settled task
  changed a file inside the frozen worktree that the planner's `predicted_write_set` omitted,
  the host widens the durable write set with those paths, records the amendment in
  `audit.scopeAmendments`, includes it in the executor checkpoint payload as `scopeAmendment`,
  and stops at the ordinary `awaiting_supervisor` checkpoint. `inspect` prints
  `Scope amendment: <paths> were outside the frozen write set for <taskId>; continue accepts
  them into scope, cancel rejects.` The next one-use `continue` is the acceptance. Worktree
  escapes, symlink crossings, and protected host roots remain hard stops
  (`PROTECTED_OR_OUT_OF_SCOPE_EFFECT`), and genuinely unobservable scopes still classify as
  `write_set` infrastructure failures.
- **The no-progress guard is typed by task.** Plan tasks accept
  `"expects_file_change": true|false` (also `expectsFileChange`, or `"effect": "validate" |
  "implement"`). `false` marks a validation, audit, review, or test-only task that legitimately
  settles with zero byte-level change; it is no longer failed with `NO_CONTENT_PROGRESS`, though
  an empty, failed, or inconclusive output still fails. `true` marks implementation work and
  keeps the guard. Undeclared tasks fall back to the description heuristics. The planner prompt
  asks for the declaration on every task.
- **`verify-only` keeps the shell and is read-only by effects.** The verifier receives
  `read, grep, find, ls, bash` so it can run tests, typechecks, and `git diff` itself. The host
  snapshots the cwd before each verifier and diffs it afterwards; any created, modified, or
  deleted file forces the run to FAIL with `VERIFY_ONLY_MUTATION: <paths>` regardless of the
  verifier's own verdict. The shape keeps its read-only execution classification because a
  verified zero-effect run is the contract. Build output directories the snapshot excludes
  (`dist`, `out`, `build`, `coverage`, `node_modules`) are tolerated.

Regression coverage: `tests/test-guard-decisions.cjs`.

## Per-run model routing and natural-language controls

The `orchestrate` tool accepts optional `plannerModel`/`plannerProvider`, `executorModel`/`executorProvider`, and `verifierModel`/`verifierProvider` parameters so the caller can select each role route. On the command line, use `--planner-model`, `--planner-provider`, etc. Explicit overrides take precedence. Omitted fields resolve from the named agent profile in `~/.pi/agent/agents/`, then from `~/.pi/agent/settings.json` (`defaultProvider`/`defaultModel`); they no longer inherit the conversational model. The selected planner/executor/verifier routes are emitted before preflight begins.

Because this package is loaded as a Pi extension, applying changes to the extension's own TypeScript or built-in/native shape registry in an already-running Pi or embedded SSI harness may require a **full Pi/SSI process restart**; `/reload` can retain stale local-package modules. The fresh-host canary proves the on-disk package entrypoint and lifecycle, not that an already-running Pi process has activated those bytes. Creating or editing an ordinary declarative workflow artifact does **not** require restart: invocation-time resolution makes it visible in the current session.

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
  "cwd": "C:/Users/you/my-project",
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
  "cwd": "C:/Users/you/my-project",
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

## Runs-state housekeeping

The standalone housekeeping command is **dry-run by default** and emits one JSON object per line:

```bash
npm run runs:prune
```

The conservative default policy inventories phase logs older than **7 days** for gzip compression and settled phase logs over **20 MiB** for newest-tail retention. These defaults bound growth in a store on the observed order of 9,074 entries, but the command still ends with `dry_run_complete` and changes nothing unless `--apply` is explicitly present. Either policy can be disabled or overridden:

```bash
# Dry-run with compression disabled and a custom 10 MiB cap.
npm run runs:prune -- --retention-days off --phase-log-max-bytes 10485760
```

Eligibility requires more than age or a terminal label. The immediate `orc-*` directory and files must be regular, canonical paths beneath the selected root; `supervision.json` and `state.json` must agree on the exact run ID; supervision must be terminal with no current, active, or detached worker; the durable phase list must be nonempty and entirely `done`; no survivor or symlink may exist; and every recorded host/worker PID must be conclusively absent with `ESRCH`. Unknown liveness, inaccessible state, PID reuse/live processes, malformed evidence, ownership mismatch, replacement races, or an existing `.gz` archive reject the run. AK2 `RETIRED_DEAD_HOST` metadata is audit evidence, not retention or deletion authority.

A qualifying old top-level `phase-*.log` is compressed to `.log.gz`, retaining only the configured byte tail first if oversized. A qualifying younger oversized log is trimmed through its already-open regular-file identity. Canonical paths, ownership/state hashes, file identities, settlement, liveness, and archive absence are revalidated immediately before each mutation; archive creation is exclusive. Top-level checkpoints, `*.result.json`, supervision, run state, and every other file are retained byte-for-byte.

After reviewing the complete dry-run list, add `--apply` to perform only those eligible phase-log operations:

```bash
npm run runs:prune -- --apply
```

A directory without `supervision.json` is reported as an ineligible `orphan-run-directory` inventory candidate, with its nested bytes counted once. Missing supervision cannot prove ownership, settlement, or liveness, so **orphan deletion is intentionally unavailable**: `--delete-orphans` remains a dry-run inventory view and combining it with `--apply` is rejected regardless of a supplied legacy confirmation token. Use `--root PATH` only for a deliberate alternate root. All apply, race, symlink, liveness, and 9,074-entry scale regressions run solely against OS-temp fixtures; the test suite never invokes prune against production `runs-state/`.

To cap a live streamed phase log (rather than waiting for terminal housekeeping), set `PI_ORCHESTRATOR_PHASE_LOG_MAX_BYTES` to a positive integer before starting Pi; `20971520` is the recommended 20 MiB ceiling. The stream writer compacts to the newest UTF-8 tail with headroom so the file stays under the ceiling. This environment setting is also default off, and a Pi restart is required to activate TypeScript changes or a changed launch environment.

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
