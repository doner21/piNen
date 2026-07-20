# Abort-Survivor + Checkpoint/Resume — Design (2026-07-02)

**Problem (evidence: SSI K1 Shape B attempts 2–3, bug note
`2026-07-01-orchestrate-discards-completed-executor-phase-on-transport-drop.md`):**
Pi core aborts the `orchestrate` tool-call AbortSignal on long silent tool calls (observed at 44 and
57.5 min — upstream stream lifetime, not a fixed timer). The extension's spawn layer kills the
productive coder child on that signal, and the run has NO resume path (recovery tiers exist only for
context exhaustion). Result: hour-scale executor phases are un-runnable; completed work is discarded.

## Fix (three cooperating pieces)

### 1. Run-state store (`src/run-state.ts`, new)
Per-run persistent state under `~/.pi/pi-orchestrator-extension/runs/<runId>/`:
- `state.json` — `{ runId, paradigm, task, createdAt, params, phases: [{index, name, status}] }`
  (status: `done | detached | pending`).
- `phase-<index>-<name>.json` — full SubagentResult checkpoint written the moment a phase completes.
- `survivor-<index>-<name>.json` — manifest `{ pid, agentName, startedAt, resultFile, detachedAt }`
  written when an abort strands a live child.
- `survivor-<index>-<name>.result.json` — the SubagentResult, written in the BACKGROUND by the
  still-alive parent process when the orphaned child finally closes.

### 2. Abort-survivor spawns (`src/substrate.ts`)
`SpawnSubagentOptions.abortSurvival?: { resultFile, manifestFile, phaseName? }`.
When set, the abort handler does NOT kill the child. It: writes the survivor manifest, rejects the
awaiting promise with `SubagentDetachedError` (carrying the manifest), and leaves the stdout/stderr
collectors attached. When the child eventually closes, the collector writes the complete
SubagentResult to `resultFile`. Honest limitation (v1): background collection lives in the Pi
process — if Pi itself exits before the child finishes, the child's late events after that point are
lost (the child process itself survives and its cwd artifacts are intact; only the JSON transcript
tail is lost). Non-survival spawns keep today's kill semantics — user ESC cancellation still works
for every shape that does not opt in.

### 3. Checkpoint + resume wiring (opt-in per shape; v1: `preregistered-concurrency-spike`,
`dual-plan-synthesis-execute-verify`)
- Fresh runs: shape receives `context.runId` + creates the store; after each sequential phase, it
  checkpoints. Long phases are spawned with `abortSurvival`.
- `orchestrate({ resume: "<runId>" })`: index.ts loads the state, reconstructs params (stored task —
  caller may omit `task`), and re-dispatches the SAME shape with `context.resumeState`.
- Resume semantics per phase: `done` → restore checkpoint, do not respawn; `detached` → if
  result file exists, restore it; else if PID alive, poll every 10 s up to 25 min (stays inside the
  observed ~40-min abort window; on expiry return partial report with the same resume hint); else
  (PID dead, no result) respawn the phase fresh; `pending` → run normally.

## Non-goals (v1)
- No resume for the other nine shapes (they keep exact current behavior).
- No OS-level detach/stdio-file redirection (survives Pi-process death) — documented follow-up.
- No change to Pi core (root-cause stream keepalive stays a separate investigation).

## Verification
- `tests/test-abort-resume.cjs` (registered in package.json): run-state round-trip; substrate
  static + behavioral checks (SubagentDetachedError, no-kill on survival abort); shape wiring
  checks; index resume-param checks.
- Live canary after reload: `orchestrate({ resume: "orc-nonexistent" })` must answer with the
  new "resume state not found" error (proves new code is loaded).
