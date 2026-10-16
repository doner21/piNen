# Prepare, then detach

Use the bundled scripts, not the old Temp workers. This example prepares a one-file documentation run; adapt its task and write set to the owner's actual authorization. Do not launch it merely to validate the skill.

## Prerequisites

- Use `C:/Program Files/nodejs/node.exe` on this Windows host; verify that physical executable exists. The bare Node command shim disappeared during a previous detached run.
- Prepare an immutable, independently owned orchestrator package at `C:/work/immutable-orchestrator-host/pi-orchestrator-extension`, including the existing round7 fixes and physically installed dependencies. Prepare a compatible Pi SDK/CLI and its own dependencies under the same frozen root, in `node_modules`. Do not junction/symlink dependencies to live `.pi` or editable sources. Keep the running copy unchanged until its run settles. No broad `.pi` snapshot is needed.
- Use an authorized separate product copy at `C:/work/authorized-product-copy`. Review its project settings/context; do not admit live packages or writable external destinations. A cwd/write-set check is not an OS sandbox. Permit product writes only inside that cwd and the approved set; owned external scratch is for runtime/validation, never product output.
- Prepare any declared read-only evidence as a separate canonical directory. The example uses none; add only the actual approved roots.
- Provision the exact registered `openai-codex/gpt-6-astra` and `openai-codex/gpt-6.1-sol` routes and credentials privately in the new runtime agent root before launch. Use approved credential provisioning; never print/copy secrets into this example, arguments, logs or a repository. OAuth refresh must write only to owned runtime state, not live auth. If a named model/auth is unavailable, stop; do not substitute.

## Preparation example

Save this block as an owned external preparation file, substitute the four input paths, and run it with the absolute Node executable. Validate its newly owned canonical externalTemp before any scratch write; reject linked ancestors and overlap with workspace, frozen inputs or evidence. It writes only beneath that new root. Prepare credentials separately as above, then schedule coordinator check-ins before launching.

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const skillRoot = 'C:/Users/you/pi-orch-round8/agent/skills/headless-orchestration';
const cwd = 'C:/work/authorized-product-copy';
const frozenRoot = 'C:/work/immutable-orchestrator-host';
const evidenceRoots = []; // Actual canonical read-only inputs only.
const canonical = value => {
  if (!value || !path.isAbsolute(value)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const resolved = path.resolve(value);
  for (let p = resolved; ; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error('NO_LINKS');
    if (path.dirname(p) === p) break;
  }
  if (path.relative(fs.realpathSync.native(resolved), resolved)) throw new Error('NONCANONICAL');
  return resolved;
};
const inside = (root, target) => {
  const r = path.relative(root, target);
  return !r || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
};
const workspace = canonical('C:/Users/you/pi-orch-round8');
const parent = canonical(os.tmpdir());
const externalTemp = path.join(parent, `headless-orchestration-${randomUUID()}`);
for (const root of [workspace, canonical(skillRoot), canonical(cwd), canonical(frozenRoot), ...evidenceRoots.map(canonical)]) {
  if (inside(root, externalTemp) || inside(externalTemp, root)) throw new Error('EXTERNAL_TEMP_OVERLAP');
}
if (!externalTemp || !path.isAbsolute(externalTemp) || fs.existsSync(externalTemp) || path.resolve(externalTemp) !== externalTemp) throw new Error('NEW_OWNED_TEMP_REQUIRED');
fs.mkdirSync(externalTemp); // First scratch write, after the ownership/path assertions.
if (canonical(externalTemp) !== externalTemp) throw new Error('TEMP_IDENTITY_CHANGED');
const runDir = externalTemp;
for (const dir of ['host', 'sessions', 'runtime/agent/agents', 'runtime/runs', 'runtime/next-runs', 'runtime/user-workflows', 'runtime/project-workflows', 'runtime/tmp', 'runtime/cache']) {
  fs.mkdirSync(path.join(runDir, dir), { recursive: true });
}
for (const name of ['launch.mjs', 'orchestrate-host.mjs']) {
  fs.copyFileSync(path.join(skillRoot, 'scripts', name), path.join(runDir, 'host', name), fs.constants.COPYFILE_EXCL);
}
const put = (name, value) => fs.writeFileSync(path.join(runDir, name), value, { flag: 'wx' });
const cfg = {
  nodeExe: 'C:/Program Files/nodejs/node.exe', cwd, frozenRoot, runDir, evidenceRoots,
  extension: path.join(frozenRoot, 'pi-orchestrator-extension/src/index.ts'),
  sdkEntry: path.join(frozenRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  piCli: path.join(frozenRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
  provider: 'openai-codex', model: 'gpt-6-astra', automaticPlanApproval: false,
  systemFile: path.join(runDir, 'system.md'), commandFile: path.join(runDir, 'command.txt'),
  supervisorFile: path.join(runDir, 'supervisor.md'),
};
// No fallback, compaction, credential payload or extra resource discovery.
put('runtime/agent/settings.json', JSON.stringify({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: 'off' }));
put('runtime/agent/agents/reviewer.json', JSON.stringify({
  name: 'reviewer', provider: 'openai-codex', model: 'gpt-6.1-sol',
  tools: ['read', 'bash', 'grep', 'find', 'ls'],
  systemPrompt: 'Independently inspect the actual candidate and rerun narrow checks. Do not fix files. Write nothing in workspace or evidence, including caches. Validate owned external scratch before writing there. No timers, deadlines, sleeps, signals, exits, kills or non-null bash timeout. No commits, push, reload or cutover.',
}));
put('system.md', 'Coordinate the authorized orchestration only. Do not implement product work directly. Honor the complete owner task, exact routes and legal checkpoints. No fallback or replay after result loss.');
const task = 'Create only HEADLESS-SMOKE.md with the text Headless recipe smoke check. ONE executor task, then ONE fresh independent verifier. No other product writes, commits, push, reload or cutover. No timers, deadlines, sleeps, signals, exits, kills or non-null bash timeout. Before any scratch write assert a newly owned nonempty absolute canonical externalTemp outside workspace and evidence, with no symlinks. Verifier writes nothing in workspace or evidence. Real-model exhaustion and owner-use are not proven by this sample.';
const q = JSON.stringify;
const command = ['/orchestrate run', '--supervision visible-main', '--lane product',
  '--paradigm plan-execute-verify', '--automatic-plan-approval off', '--adaptive-supervision off', '--max-subagents 3',
  '--planner-count 1', '--executor-concurrency 1', '--verifier-count 1', '--max-retries 0',
  '--planner-agent planner', '--executor-agent coder', '--verifier-agent reviewer',
  '--planner-provider openai-codex', '--planner-model gpt-6-astra',
  '--executor-provider openai-codex', '--executor-model gpt-6.1-sol',
  '--verifier-provider openai-codex', '--verifier-model gpt-6.1-sol',
  '--no-force-kill', '--cwd', q(cwd), '--write-set HEADLESS-SMOKE.md',
  ...(evidenceRoots.length ? ['--external-evidence-roots', q(evidenceRoots.join(','))] : []),
  '--', q(task)].join(' ');
put('command.txt', command);
put('supervisor.md', `Inspect the current run. Read its plan summary or saved plan. If tasks and acceptance criteria are within the approved HEADLESS-SMOKE.md scope, approve and continue. If needed, request fresh approval with continue without a token, then consume the returned one-use approval. Pause only for protected code, forbidden change or a genuinely missing plan; say which. At later checkpoints continue when the settled result and actual content changes are within scope. Full detail is in saved files; do not demand it all in compact inspect. Never repeat a completed worker. Report the actual terminal verdict, not SDK settlement.`);
put('config.json', JSON.stringify(cfg, null, 2));
console.log(JSON.stringify({ configPath: path.join(runDir, 'config.json'), launcher: path.join(runDir, 'host/launch.mjs'), agentDir: path.join(runDir, 'runtime/agent') }));
```

After all inputs, owned dependencies, runtime directories and private credentials are ready, launch the copied script, not the editable one:

```text
"C:/Program Files/nodejs/node.exe" "<owned-runDir>/host/launch.mjs" "<owned-runDir>/config.json"
```

Use a quick tool call with shell timeout absent/null. The launcher detaches and records its PID/argv in `dispatch.json`; the host records a fresh `sessionFile` in `started.json`. It uses reload → create session → subscribe → **await bindExtensions** → expanded literal `/orchestrate` → supervisory inspect/continue. Plain SDK prompting without binding was silent and is not an alternative. Copy no parent session: scrub `PI_SESSION_FILE` and `PI_SESSION_ID`; retain sessions, stdout/stderr, events, activity, dispatch, command results, report and completion/error output privately.

## Candidate owner-use after final independent Astra review

Not activated or proven by model-free checks. Freeze the reviewed candidate with physically owned dependencies; no new window is assumed to load uncommitted code. Copy the supplied owner-card programs unchanged to a fresh authorized product copy, never the owner's original folder. Adapt the example task to run `node normal.js`, `node silent.js`, `node slow.js` sequentially, with no product edits. Use automatic approval off and the plain brief first; then explicitly opt in on a separate fresh run if authorized. The coordinator releases the silent fixture only by the existing card's `release.txt` action in that copy. Observe planning → executor without a pause/recovery and the card's existing monitoring outcomes. Do not alter/expand its timing fixtures.

For custom-shape owner-use, place [two-builds.workflow.json](two-builds.workflow.json) into that separate project's `.pi/orchestrator-workflows/`. Change paradigm to `two-builds`, max-subagents to at least 5, write set to `out-1.txt,out-2.txt`, and task/brief scope to those two files. This is two changing executor phases, each followed by verification, then final criterion verification. Check all phase entries in `state.json`, fresh live status, checkpoint results/effects, and no false plan pause. User-scope workflow discovery is intentionally hidden; project scope is required. Real-model owner-use, exhaustion and alarm delivery remain unproven until actually run.

## Machine check boundary

`node tests/test-2026-10-12-round8-generic-headless.cjs` (from the orchestrator package, with physically owned SDK dependencies/peer packages and an owned external test root) copies the candidate and SDK into a separate frozen directory. It loads the real SDK/resource loader, binds the extension, and uses headless `/orchestrate` commands to exercise project discovery, explicit checkpoint approval, two changing phases with independent fixture readers, phase status/effects, host command timings and controlled checkpoint pause/continue without replay. It uses no empty SDK/host files or direct extension import. Windows cleanup belongs to the outer test runner after its child settles, because loaded native SDK modules cannot be removed in-process.

The workers are deterministic fixture processes. Their readiness marker models the fixture protocol only: it is **not** real monitor loading, Astra supervisor inference, transport-loss recovery or the owner's real-use test. Run the prepared real example above with the exact Astra/Sol routes to establish those integrated boundaries; until then they remain unproven. Never reinterpret SDK settlement or this machine check as real-model acceptance.

## Current status, without another host

At a checkpoint use the owning host's `orchestrate` tool `{ "action": "inspect", "runId": "<current-id>" }`, or `/orchestrate inspect --run-id <current-id>` in that same session. Its inspection returns a freshly derived `details.liveStatus`; legal actions are `details.allowedNextActions`. Derive blockers from `infrastructureFailures`, blocking `drift`, `forbiddenChanges`, `pauseReason` and current tool errors, not an invented `liveStatus.blockers` field. Keep approvalToken private; inspect does not manufacture approval authority.

During a worker phase, explicitly refresh via the bundled adapter instead of treating an old file as current:

```text
"C:/Program Files/nodejs/node.exe" "<owned-runDir>/host/launch.mjs" --status "<owned-runDir>/config.json" <current-run-id>
```

This is a mode of the bundled script, **not** a new orchestrator CLI. It calls the frozen source's exported `refreshLiveStatus` using independently owned `jiti`, with its filesystem cache disabled; it publishes only the owned run's `live-status.json`. It starts no SDK session/model/extension host, avoiding startup pausing or invalidating the active host's checkpoint authority. Discover the current runId from the top-level command/tool result; do not select an old nested run by filename. `going` is `going`, `not going`, or `unknown`, never a launch boolean. Observe `phase` (active activity only; null at a settled checkpoint), `phases` (observed manifest names/statuses, including settled phases), `activeWorkers` (PID/launchId/liveness/heartbeatAt), `heartbeatAt`, `activeSilenceAlarms`, `lastError`, `observationErrors`, and the projection's `observedAt`.

Reconcile that projection with dispatch/started identity, OS PID existence and creation identity (PID reuse is unknown, not owned), actual current phase sidecars/output, top-level host events and completion/error output. If the original host has settled or disappeared at a checkpoint, preserve its outputs and use the supported lifecycle inspection/recovery path with freshly issued authority in the isolated runtime; never relaunch the initial command/config as recovery. A new host pauses nonterminal runs and invalidates old approval authority. Parse JSONL on LF; select tool/text/current-outcome records only. Never display encrypted thinking/signatures, raw auth, approval tokens or full event dumps. `activity.json` tracks host events, not proof of child output. Neither `completion.json` (`sdkSettled`) nor SDK exit0 proves orchestration success. Inspect the current durable terminal outcome and independent verifier findings; report `accepted_with_reason` separately from verifier PASS.
