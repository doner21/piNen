# Pi Core Patch

The Pi coding agent requires a minimal core patch to enable `pi.executeCommand`
for internal orchestration. This patch is **opt-in**, **user-invoked only**,
and creates local backups for rollback.

## When to Patch

Apply the core patch after:
1. Installing the Pi harness (`npm install -g @earendil-works/pi-coding-agent`)
2. Updating the global Pi npm package
3. Running the one-click installer (run `install.ps1` with no flags first, then
   `agent/setup.ps1 -ApplyCorePatch` or `agent/setup.sh --apply-core-patch`)

## How to Apply

```bash
# Check if patching is needed
node agent/core-patch/reapply-pi-core-patch.mjs check

# Apply the patch (creates backups)
node agent/core-patch/reapply-pi-core-patch.mjs

# Verify the patch applied correctly
node agent/core-patch/verify-patch-command-registration.mjs
```

Or use the setup scripts:

```powershell
# Windows (PowerShell)
.\agent\setup.ps1 -ApplyCorePatch
```

```bash
# Linux/macOS
./agent/setup.sh --apply-core-patch
```

## What It Does

1. Locates the installed Pi package in the global `node_modules` directory
2. Creates timestamped backups of modified files in `agent/core-patch/backups/`
3. Applies minimal patches to the Pi core to register `pi.executeCommand`
4. Never triggers a live reload — requires a full Pi restart to take effect

## Rollback

If the patch causes issues, restore from backups:

```bash
# List available backups
ls agent/core-patch/backups/

# Restore (example)
cp agent/core-patch/backups/<timestamp>/*.js <global-pi-install-path>/
```

## Safety

- The patcher is **idempotent** — running it multiple times is safe
- Backups are created before any modifications
- The patcher never modifies files outside the Pi installation
- No live reload is triggered (requires restart)
- The `patch-manifest.json` records applied patches and is gitignored

## Notes

- After a `npm update -g @earendil-works/pi-coding-agent`, reapply the patch
- The patcher checks the current Pi version and errors if incompatible
- All backup files are gitignored by the agent `.gitignore`
