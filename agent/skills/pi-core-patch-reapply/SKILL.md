---
name: pi-core-patch-reapply
description: User-invoked reapplication of the local pi.executeCommand core patch after a Pi npm update overwrites the installed dist/ files. Use after `npm update -g @earendil-works/pi-coding-agent` when the agent-reload / agent-new-session autonomous bridges stop working because pi.executeCommand is no longer present. Manual/user-invoked only; no silent auto-patching, no live reload.
---

# Pi Core Patch Reapply (user-invoked, interim workaround)

This skill documents how to **manually reapply** the local `pi.executeCommand`
core patch after a Pi npm update overwrites the patched `dist/` files. It is an
**interim opt-in workaround**, not the long-term durable solution.

> ⚠️ This is a workaround while the upstream request for an official
> `ExtensionAPI.executeCommand()` remains open:
> <https://github.com/earendil-works/pi/issues/6010>
> See `agent/extensions/agent-reload/UPSTREAM_REQUEST.md`. The durable fix is an
> upstream Pi API; this patcher only restores the interim local patch on demand.

## What this patch does

Pi extensions have no public API for a tool/event-handler to dispatch a
registered slash command. As an interim workaround, installed Pi `dist/` files
are patched to expose `pi.executeCommand(name, args?)` on the `ExtensionAPI`.
This **core patch** enables **both** of the following autonomous agent bridges:

- `agent_reload_runtime`  — automatic Pi reload (managed via `/pi-core-reload-patch` commands)
- `agent_new_session`     — automatic Pi new-session (managed via `/pi-core-new-session-patch` commands)

The patcher currently applies **11 edits across 6 files** (run
`node agent/core-patch/reapply-pi-core-patch.mjs check` for the authoritative
list). These fall into two groups:

**A. `pi.executeCommand` bridge (the autonomy-critical edits):**

- `dist/core/extensions/loader.js`  — runtime stub + API delegate
- `dist/core/extensions/runner.js`  — runtime binding / command dispatch
- `dist/core/extensions/types.d.ts` — type declarations

**B. Windows `windowsHide:true` fixes (suppress console-window flashes):**

- `dist/core/footer-data-provider.js` — git `spawnSync` + `execFile`
- `dist/core/tools/find.js`           — `fd` spawn
- `dist/core/tools/grep.js`           — `rg` spawn
- `dist/core/exec.js`                 — spawn options

Group A is what restores the reload / new-session autonomy after a Pi update.
Group B is bundled into the same idempotent patcher for convenience.

Those edits live **inside the npm install tree**, so every
`npm update -g @earendil-works/pi-coding-agent` silently reverts them. The
patcher script lives **outside** the npm tree (under `agent/`) so it survives
updates and can reapply the patch on demand. Running the new-session `apply`
also repairs the reload bridge, and running the reload `apply` also repairs
the new-session bridge — there is only one underlying patch.

Prior patch evidence used to derive the edits:

- `agent/nenflow-v3/runs/RUN_20260620-194054/CORE_PATCH.diff`
- `agent/nenflow-v3/runs/RUN_20260623-160406/RELOAD_FIX_NOTES.md`
- `agent/extensions/agent-reload/UPSTREAM_REQUEST.md`

## The patcher script

```
agent/core-patch/reapply-pi-core-patch.mjs
```

This is a durable Node script. It is **user-invoked only** — importing the
module never patches anything; it only acts when run directly from the CLI.

### Commands

```
node agent/core-patch/reapply-pi-core-patch.mjs check
node agent/core-patch/reapply-pi-core-patch.mjs apply
node agent/core-patch/reapply-pi-core-patch.mjs verify
node agent/core-patch/reapply-pi-core-patch.mjs status
node agent/core-patch/reapply-pi-core-patch.mjs list-backups
node agent/core-patch/reapply-pi-core-patch.mjs rollback            # latest backup
node agent/core-patch/reapply-pi-core-patch.mjs rollback <backupDir> # specific backup
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | command succeeded (`check` reports fully-patched, `apply`/`verify` ok, `rollback` ok) |
| `1`  | `check` reports NOT fully patched — action needed (expected right after a Pi update) |
| `2`  | unmatched target / safe failure (Pi source drifted) — manual adaptation required |
| `3`  | bad usage / arguments |

### Environment override

If the patcher cannot auto-resolve the installed Pi package root, set:

```
# Windows PowerShell
$env:PI_CORE_ROOT = "<path-to-pi-coding-agent package root>"

# Linux / macOS
export PI_CORE_ROOT="<path-to-pi-coding-agent package root>"
```

The patcher resolves the install root robustly (env override → `require.resolve`
→ well-known Windows global npm path → `npm root -g`), so this is rarely needed.

## Hard rules (must respect)

- **Manual / user-invoked only.** The patcher is never run automatically, never
  on startup, never from a background task. A human (or the agent acting on an
  explicit user request) must invoke it. There is **no silent auto-patching**.
- **No live reload during implementation.** This skill and the patcher never
  trigger a Pi runtime reload. The patcher only edits files on disk and runs
  static checks.
- **NEVER use `pi.sendUserMessage('/command')` as a command bridge.** Pi's
  `sendUserMessage()` path injects slash commands as plain user text and never
  executes them. This skill does not use that path for anything. The patched
  `pi.executeCommand()` is a separate, real command-dispatch API.
- **Safe failure on unmatched targets.** If a patch anchor is missing (Pi source
  drifted), the patcher STOPS, writes nothing, and reports exit code `2`. Do not
  force-apply; re-derive the patch against the new source instead.
- **Idempotent.** `check`/`apply`/`verify` are safe to run repeatedly. Running
  `apply` twice never duplicates code or corrupts files.

## Workflow: after a Pi update

Follow these steps **in order**. Run each command from the Pi home directory
(`~/.pi` on this machine) unless noted.

### 1. Check whether the patch is still present

```
node agent/core-patch/reapply-pi-core-patch.mjs check
```

- Exit `0` → patch is present; nothing to do. Stop here.
- Exit `1` → patch is missing (expected after an update); continue to step 2.
- Exit `2` → safe failure / unmatched target; jump to **Safe failure** below.

`check` is read-only and idempotent. Run it freely.

### 2. Apply the patch

```
node agent/core-patch/reapply-pi-core-patch.mjs apply
```

What `apply` does, in order:

1. Re-evaluates patch state. If any anchor is missing → **safe failure**, exit
   `2`, no files written.
2. If all edits already applied → reports idempotent no-op, exit `0`.
3. **Backs up** the current (pre-apply) content of every target file to a
   timestamped directory under `agent/core-patch/backups/`. A `VERSION.txt` in
   that backup records the Pi version and root. A manifest is written to
   `agent/core-patch/patch-manifest.json`.
4. Applies each missing edit, asserting the anchor is unique before writing.
5. Runs a built-in post-apply static verify. If the post-apply state is not
   fully patched, it warns and points at the backup (exit `2`).

### 3. Verify the patch (static only)

```
node agent/core-patch/reapply-pi-core-patch.mjs verify
```

- Read-only. Performs no writes and **no live reload**.
- Confirms every edit sentinel is present and runs structural checks proving
  `executeCommand` exists in `loader.js`, `runner.js`, and `types.d.ts`.
- Exit `0` = PASS; `1` = not fully patched; `2` = unmatched.

### 4. Load the patched core (MANUAL — required after apply)

The patcher edits files on disk only. **The running Pi process still uses the
old, unpatched code until it is reloaded.** This skill and the patcher do NOT
trigger a reload. After a successful `apply` + `verify`, the user must
**manually** run one of:

```
/reload
```

or

```
/agent-reload-runtime
```

or simply **restart Pi**.

**Yes — a manual `/reload` (or restart) IS required after successful patching**
for the running Pi process to gain the `pi.executeCommand` API.

If you instead want the autonomous agent-reload bridge (which schedules a
continuation first), follow the `agent-reload` skill — but note that the
autonomous bridge only works once the patched core is actually loaded, i.e.
after the manual `/reload` above.

## Backups and rollback

### Backup location

Backups are written next to the script so they survive Pi npm updates too:

```
agent/core-patch/backups/<YYYYMMDD-HHMMSS>/
    loader.js__            (renamed from dist/core/extensions/loader.js)
    runner.js__            (renamed from dist/core/extensions/runner.js)
    types.d.ts__           (renamed from dist/core/extensions/types.d.ts)
    VERSION.txt
```

A manifest of applies and the backup list is kept at:

```
agent/core-patch/patch-manifest.json
```

### Inspect state and backups

```
node agent/core-patch/reapply-pi-core-patch.mjs status
node agent/core-patch/reapply-pi-core-patch.mjs list-backups
```

### Roll back

```
node agent/core-patch/reapply-pi-core-patch.mjs rollback            # newest backup
node agent/core-patch/reapply-pi-core-patch.mjs rollback <backupId> # specific
```

`rollback` restores the target files from the chosen backup. Before overwriting,
it snapshots the current (post-apply) state into a `prerollback-<timestamp>`
backup, so rollback is itself reversible. After rollback, **manually run
`/reload` (or restart Pi)** to load the restored core.

## Safe failure / unmatched targets

If `check`, `apply`, or `verify` returns exit code `2`, an expected patch anchor
was not found — the Pi source has drifted from the known patch shape.

- **Do NOT force-apply.** The patcher has already refused to write anything.
- Re-derive the patch against the new Pi source. Start from the prior evidence:
  - `agent/nenflow-v3/runs/RUN_20260620-194054/CORE_PATCH.diff`
  - `agent/nenflow-v3/runs/RUN_20260623-160406/RELOAD_FIX_NOTES.md`
  - `agent/extensions/agent-reload/UPSTREAM_REQUEST.md`
- Update the `PATCHES` definitions in `agent/core-patch/reapply-pi-core-patch.mjs`
  (new `find`/`replace`/`sentinel`) and re-run `check`.
- If a backup exists from a previously-good apply and you only need to get back
  to a working state, `rollback` to it instead.

## When to use this skill

Use this skill when:

- You just ran `npm update -g @earendil-works/pi-coding-agent` and the
  `agent_reload_runtime` / `agent_new_session` autonomous bridges now report
  that `pi.executeCommand` is unavailable.
- `check` (or the agent-reload diagnostics at
  `agent/agent-reload-diagnostics.json` with `executeCommandAvailable: false`)
  indicates the patch is missing.

Do **not** use this skill for ordinary human-initiated `/reload`; that needs no
patching.

## Slash command wrappers

A global extension at `agent/extensions/pi-core-reload-patch/index.ts` exposes
human-invoked slash commands for the common patcher operations. Two sets of
commands are registered — one for reload and one for new-session — but **both
shell out to the same patcher script** and perform identical operations.

### Reload patch commands (existing)

```
/pi-core-reload-patch check
/pi-core-reload-patch apply
/pi-core-reload-patch verify
```

Convenience aliases:

```
/pi-core-reload-patch-check
/pi-core-reload-patch-apply
/pi-core-reload-patch-verify
```

### New-session patch commands

```
/pi-core-new-session-patch check
/pi-core-new-session-patch apply
/pi-core-new-session-patch verify
```

Convenience aliases:

```
/pi-core-new-session-patch-check
/pi-core-new-session-patch-apply
/pi-core-new-session-patch-verify
```

### Shared underlying patcher

Both command sets invoke the same durable script:

```
agent/core-patch/reapply-pi-core-patch.mjs
```

There is **one core patch** (the `pi.executeCommand` bridge) and it enables
both `agent_reload_runtime` and `agent_new_session`. The separate command
paths exist for user clarity — running either `apply` produces the same
result. The output message from every command explicitly explains this shared
bridge.

The slash commands preserve the same safety rules as the script: user-invoked
only, idempotent, backs up before apply, safe-fails on source drift, and never
triggers a live reload. After any `apply` succeeds, the user must still
manually run `/reload` or restart Pi to load the patched core.

## Quick reference

```
# ── New-session commands ──

# 1. Check (read-only)
/pi-core-new-session-patch check
# or: node agent/core-patch/reapply-pi-core-patch.mjs check

# 2. Apply (backs up first, idempotent, safe-fails on drift)
/pi-core-new-session-patch apply
# or: node agent/core-patch/reapply-pi-core-patch.mjs apply

# 3. Verify (static only, no reload)
/pi-core-new-session-patch verify
# or: node agent/core-patch/reapply-pi-core-patch.mjs verify

# 4. MANUAL: load the patched core (required after apply)
/reload            # or /agent-reload-runtime, or restart Pi

# ── Reload commands (same patcher, same result) ──

# 1. Check
/pi-core-reload-patch check

# 2. Apply
/pi-core-reload-patch apply

# 3. Verify
/pi-core-reload-patch verify

# ── Shared note ──
# Both command sets invoke the same patcher. The underlying pi.executeCommand
# bridge enables both agent_reload_runtime AND agent_new_session.

# Rollback if needed (script-only)
node agent/core-patch/reapply-pi-core-patch.mjs status
node agent/core-patch/reapply-pi-core-patch.mjs list-backups
node agent/core-patch/reapply-pi-core-patch.mjs rollback
```

## Notes

- This skill is **manual / user-invoked**. Nothing here runs automatically.
- No silent auto-patching. No live reload during implementation.
- Never uses `pi.sendUserMessage('/command')` as a command bridge.
- A manual `/reload` (or restart) **is required** after a successful `apply`
  for the running Pi process to load the patched core.
- Long-term: prefer the upstream `ExtensionAPI.executeCommand()` API once
  implemented (issue #6010). This patcher is only the interim restore path.
