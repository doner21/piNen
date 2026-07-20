# Windows Subagent Spawn EPERM — Runbook

## Symptom

A Pi orchestration subagent fails with an error containing `EPERM` (or `code=EPERM`), and the `spawnSubagent` retry chain is exhausted (primary → windows-shell-hidden-fallback → windows-visible-fallback). The message includes:

```
spawn failed (... cwd=... code=EPERM: ... Hint: Windows returned EPERM while launching a Pi subagent subprocess.
```

In the current release the error message also appends ` Evidence: <path>` or ` Evidence capture skipped.`

## Quick Diagnostic

Run the standalone trace script to probe the local spawn environment:

```powershell
cd ~/.pi
node agent/diagnostics/windows-spawn-eperm-trace.mjs --minutes 5
```

This writes `agent/diagnostics/spawn-eperm/windows-spawn-trace-<ts>.json` and prints JSON to stdout. It does NOT require Pi to be running.

Dry-run (no file output, no event logs):

```powershell
node agent/diagnostics/windows-spawn-eperm-trace.mjs --dry-run --no-event-logs
```

Correlate against a previously captured evidence file:

```powershell
node agent/diagnostics/windows-spawn-eperm-trace.mjs --artifact agent/diagnostics/spawn-eperm/spawn-eperm-<pid>-<ts>.json
```

Optional flags:

| Flag | Default | Description |
|---|---|---|
| `--artifact <path>` | none | Load a prior evidence JSON for correlation |
| `--minutes <n>` | 10 | Event-log correlation window in minutes |
| `--out <path>` | auto | Override output file path |
| `--no-event-logs` | false | Skip `Get-WinEvent` queries |
| `--dry-run` / `-n` | false | Stdout only; no file write |

## How to Read the Evidence JSON

### Top-level evidence file (saved by the orchestrator extension)

```json
{
  "schemaVersion": 1,
  "kind": "windows-spawn-eperm-evidence",
  "timestampUtc": "...",
  "pid": 12345,
  "ppid": 54321,
  "platform": "win32",
  "nodeVersion": "v22.x.y",
  "execPath": { "basename": "node.exe", "equalsProcessExecPath": true, "exists": true },
  "cwd": { "basename": "project-name", "exists": true },
  "attempt": {
    "label": "windows-visible-fallback",
    "commandBasename": "node.exe",
    "argsCount": 8,
    "options": { "shell": false, "windowsHide": false, "detached": false, "stdioShape": "[\"ignore\",\"pipe\",\"pipe\"]" }
  },
  "envAllowlist": { "PATH_present": true, "PI_CLI_PATH_present": true, "PI_CLI_present": false },
  "error": { "code": "EPERM", "message": "..." },
  "correlationWindowMinutes": 10
}
```

Key fields:
- **attempt.label**: Which retry failed. `windows-visible-fallback` means even a non-hidden console spawn was blocked — this strongly suggests a policy-enforced block, not a window-style issue.
- **attempt.options.windowsHide**: `false` = visible terminal window was requested and still failed.
- **attempt.options.shell**: `false` = direct `CreateProcess`, not through `cmd.exe`.
- **envAllowlist.PI_CLI_PATH_present**: Whether the Pi CLI path env var was set.

### Trace script output

The trace script adds:
- **probes[]**: `{label, ok, code, durationMs}` for each test spawn. Check if ALL probes fail (`windowsHide:true`, `windowsHide:false`, `shell:true`).
- **parentChain[]**: PID → PPID chain. Look for a non-console parent or a Job-object host.
- **eventLogs[]**: Defender/CodeIntegrity/AppLocker/Sysmon events in the correlation window. Look for block events near the failure timestamp.

## Decision Tree

### 1. Are ALL spawn probes failing (even `node -v windowsHide:false`)?

- **Yes** → This is a system-wide spawn restriction, not specific to Pi. Likely causes:
  - Antivirus/EDR blocking `node.exe` child processes globally.
  - A restrictive Windows Job Object attached to the parent process tree.
  - AppLocker or Software Restriction Policies blocking Node.js.
  - **Action**: Run the PowerShell remediation commands from an unconstrained terminal (see below). Do NOT change registry/ACL/Defender settings from within Pi.

- **No (some probes pass)** → The issue is specific to certain spawn configurations:

  - **`windowsHide:true` fails, `windowsHide:false` passes**:
    - The parent process is likely running in a context where `CREATE_NO_WINDOW` is disallowed (e.g., a Windows Service, a Job Object without `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, or some container runtimes).
    - **Mitigation**: Run Pi from a normal terminal window (not a service/container/headless session).

  - **`shell:true` passes, `windowsHide:true` with `shell:false` fails**:
    - Direct `CreateProcess` is blocked but `cmd.exe` spawns are permitted. EDR may be intercepting unshelled subprocess creation.
    - **Mitigation**: Run Pi from a normal terminal and check Defender event logs for the blocking rule.

  - **PI_CLI_PATH probe fails but `node -v` passes**:
    - The Pi CLI script path may be blocked or missing.
    - **Action**: Verify the PI_CLI_PATH value and that the file exists.

### 2. Do event logs show a corresponding block?

- **Defender Operational** with ID 1116 (malware detected), 1117 (action taken) → Defender blocked the spawn.
- **AppLocker** events (8003-8007) → Software Restriction Policy block.
- **Sysmon** event ID 1 (Process Create) → Check if the target process appears; if absent, creation was blocked.
- **Security 4688** (Process Create) → Same check.

### 3. If all spawns are policy-blocked

The user must run copy-paste PowerShell commands **outside Pi** in an unconstrained terminal. Pi will not and cannot modify security settings automatically.

## Remediation Options (gated behind explicit user action)

Pi will NEVER automatically change Defender exclusions, registry settings, AppLocker rules, or ACLs. The following are *templates only* for the user to run manually:

### Check if Node is blocked by Defender

```powershell
# View recent Defender detections
Get-MpThreatDetection | Sort-Object -Property DetectionTime -Descending | Select-Object -First 10

# Check if node.exe has a Defender path exclusion
Get-MpPreference | Select-Object -ExpandProperty ExclusionPath
```

### Add a Defender process exclusion (template — run manually)

```powershell
# Add node.exe as a process exclusion (requires admin)
Add-MpPreference -ExclusionProcess "node.exe"

# Or add the Pi npm global directory as a path exclusion
Add-MpPreference -ExclusionPath "$env:APPDATA\npm"
```

### Check AppLocker policy

```powershell
Get-AppLockerPolicy -Effective | Test-AppLockerPolicy -Path "$env:APPDATA\npm\node.exe"
```

### Check if the parent is in a restrictive Job Object

```powershell
# From the trace script's parentChain section, identify the top-most parent.
# Job objects are typically attached by process managers, container runtimes,
# or development tools that use job objects for lifecycle management.
```

## Relaunch from Unconstrained Terminal

If the current Pi process is running inside a restricted context (e.g., launched from a TUI tool inside a Job Object), restart Pi from a standard PowerShell or Command Prompt window:

```powershell
# Launch Pi in a fresh, unconstrained terminal
pi
```

## Escalation Criteria

Escalate to a system administrator if:

1. **All spawn probes fail** and event logs show no corresponding block events — this may indicate a kernel-mode driver or EDR rule that does not produce Windows Event Log entries.
2. **The parent chain includes a security product's process name** as the grandparent or higher ancestor.
3. **Remediation requires domain-level GPO changes** beyond local machine settings.
4. **The user lacks local administrator rights** and cannot run `Get-MpPreference` or `Get-AppLockerPolicy`.

## Note on Evidence Capture

The orchestrator extension writes evidence JSON files to `agent/diagnostics/spawn-eperm/` on terminal EPERM failures. These files contain only safe, read-only fields: error codes, process metadata, redacted spawn attempt descriptors, and environment variable presence flags (never values). No API keys, prompts, task text, full command lines, or environment variable values are logged.
