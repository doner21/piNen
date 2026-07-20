# Win Lifecycle Process Trace — Runbook

**Status:** HARNESS ARTIFACT — non-invasive diagnostic tooling for a future human-approved run.

**Do not execute any script until you have read this entire document and explicitly approved the run.**

---

## 1. Purpose

Capture child-process creation events (flashes) during Pi terminal/console lifecycle operations from **outside** Pi — no modification to Pi source, config, registry, services, or persistent system state.

## 2. Lifecycle Paths Covered

| Path | Trigger | What it captures |
|------|---------|-----------------|
| **Cold Start** | Pi launched from Start Menu, executable, or Terminal | Process creation from Pi executable launch through first render and idle |
| **Open-from-Terminal** | Pi launched from an existing shell (`cmd`, `powershell`, `pwsh`, Windows Terminal) | Process creation from the terminal spawn command through Pi attach |
| **Runtime Reload** | `/reload` command inside a running Pi session | Process creation during reload through post-render idle |
| **New Session** | `/new` command inside a running Pi session | Process creation during clean-session spawn through render |

## 3. Prerequisites

- Windows 10+ or Windows Server 2016+
- PowerShell 5.1+ (Windows PowerShell) or PowerShell 7+
- **No elevation required** for WMI (default) trace
- ETW/ProcMon capture requires separate human approval and elevation
- Pi must be installed and reachable on PATH (or adjust `$PiExecutable` in scripts)

## 4. Quick Start (Step-by-Step)

> **WARNING:** Do not run live monitoring unless you have read and approved every safety constraint in §9.

### 4.1 Setup

```powershell
# 1. Create a run directory
$RUN_ID = "win-lifecycle-process-trace-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -Path ".\runs\$RUN_ID" -ItemType Directory -Force | Out-Null
Set-Location ".\runs\$RUN_ID"

# 2. Copy harness scripts to the run directory (so logs stay with the run)
Copy-Item "..\Start-ProcessTrace.ps1" .
Copy-Item "..\Write-TraceMarker.ps1" .
Copy-Item "..\Stop-ProcessTrace.ps1" .
Copy-Item "..\Correlate-ProcessTrace.ps1" .
```

### 4.2 Start Tracing

```powershell
# Start the WMI process-start listener BEFORE launching Pi
.\Start-ProcessTrace.ps1 -RunId $RUN_ID
```

**Verify:** You should see output confirming the WMI subscription is active.

### 4.3 Run Lifecycle Paths

Perform each lifecycle action **manually** while inserting action markers using `Write-TraceMarker.ps1`.

#### 4.3.1 Cold Start

```
1. .\Write-TraceMarker.ps1 -MarkerName "COLD_START_BEGIN" -RunId $RUN_ID -Note "About to launch Pi from Start Menu / executable"
2. Launch Pi (Start Menu, double-click executable, or terminal-launched cold start)
3. Wait for Pi to render fully
4. .\Write-TraceMarker.ps1 -MarkerName "COLD_START_FIRST_RENDER" -RunId $RUN_ID -Note "Pi UI/session visible and rendered"
5. Wait ~5 seconds for idle
6. .\Write-TraceMarker.ps1 -MarkerName "COLD_START_END" -RunId $RUN_ID -Note "Pi session idle, cold start complete"
```

#### 4.3.2 Open-from-Terminal

```
1. Open a terminal (cmd.exe, powershell.exe, pwsh.exe, or Windows Terminal)
2. .\Write-TraceMarker.ps1 -MarkerName "OPEN_FROM_TERMINAL_BEGIN" -RunId $RUN_ID -Note "Terminal open, about to launch Pi"
3. .\Write-TraceMarker.ps1 -MarkerName "OPEN_FROM_TERMINAL_COMMAND_SENT" -RunId $RUN_ID -Note "Just pressed Enter on the pi command"
4. Type and execute: pi
5. Wait for Pi to attach and render
6. .\Write-TraceMarker.ps1 -MarkerName "OPEN_FROM_TERMINAL_ATTACHED" -RunId $RUN_ID -Note "Pi attached and rendered in terminal"
7. Wait ~5 seconds for idle
8. .\Write-TraceMarker.ps1 -MarkerName "OPEN_FROM_TERMINAL_END" -RunId $RUN_ID -Note "Open-from-terminal path complete"
```

#### 4.3.3 Runtime Reload

```
1. Ensure Pi is running and a session is active
2. .\Write-TraceMarker.ps1 -MarkerName "RELOAD_BEGIN" -RunId $RUN_ID -Note "About to type /reload"
3. .\Write-TraceMarker.ps1 -MarkerName "RELOAD_COMMAND_SENT" -RunId $RUN_ID -Note "Just pressed Enter on /reload"
4. Type /reload in Pi and press Enter
5. Wait for Pi to reload and render
6. .\Write-TraceMarker.ps1 -MarkerName "RELOAD_POST_RENDER_IDLE" -RunId $RUN_ID -Note "Pi post-reload render complete, session idle"
7. Wait ~5 seconds
8. .\Write-TraceMarker.ps1 -MarkerName "RELOAD_END" -RunId $RUN_ID -Note "Reload path complete"
```

#### 4.3.4 New Session

```
1. Ensure Pi is running and a session is active
2. .\Write-TraceMarker.ps1 -MarkerName "NEW_SESSION_BEGIN" -RunId $RUN_ID -Note "About to type /new"
3. .\Write-TraceMarker.ps1 -MarkerName "NEW_SESSION_COMMAND_SENT" -RunId $RUN_ID -Note "Just pressed Enter on /new"
4. Type /new in Pi and press Enter
5. Wait for the new Pi session to render
6. .\Write-TraceMarker.ps1 -MarkerName "NEW_SESSION_RENDERED" -RunId $RUN_ID -Note "New session rendered"
7. Wait ~5 seconds
8. .\Write-TraceMarker.ps1 -MarkerName "NEW_SESSION_END" -RunId $RUN_ID -Note "New session path complete"
```

### 4.4 Stop Tracing

```powershell
.\Stop-ProcessTrace.ps1 -RunId $RUN_ID
```

### 4.5 Correlate Results

```powershell
.\Correlate-ProcessTrace.ps1 -RunId $RUN_ID
```

### 4.6 Review

- `process-events.jsonl` — raw process-creation events from WMI
- `markers.jsonl` — action markers inserted by the operator
- `correlated-events.jsonl` — events assigned to lifecycle windows
- `correlation-summary.md` — human-readable summary with PASS/FAIL recommendation

---

## 5. Action Marker Reference

### 5.1 Marker Format (JSONL)

Each marker is one line of JSON:

```json
{
  "run_id": "win-lifecycle-process-trace-YYYYMMDD-HHMMSS",
  "marker_id": "uuid",
  "marker_name": "RELOAD_BEGIN",
  "lifecycle_path": "reload",
  "timestamp_utc": "2026-06-26T12:34:56.789Z",
  "timestamp_local": "2026-06-26T08:34:56.789-04:00",
  "monotonic_ms": 123456789,
  "operator_note": "human-visible action about to begin"
}
```

### 5.2 Marker Names (Complete List)

| Marker Name | Lifecycle Path | When to Insert |
|-------------|---------------|----------------|
| `COLD_START_BEGIN` | cold_start | Immediately before launching Pi from cold |
| `COLD_START_FIRST_RENDER` | cold_start | When Pi UI/session is first visible |
| `COLD_START_END` | cold_start | ~5s after first render, session visibly idle |
| `OPEN_FROM_TERMINAL_BEGIN` | open_from_terminal | Terminal open, about to type `pi` |
| `OPEN_FROM_TERMINAL_COMMAND_SENT` | open_from_terminal | Immediately after pressing Enter on `pi` |
| `OPEN_FROM_TERMINAL_ATTACHED` | open_from_terminal | Pi attached and rendered in terminal |
| `OPEN_FROM_TERMINAL_END` | open_from_terminal | ~5s after attach, session idle |
| `RELOAD_BEGIN` | reload | About to type `/reload` |
| `RELOAD_COMMAND_SENT` | reload | Immediately after pressing Enter on `/reload` |
| `RELOAD_POST_RENDER_IDLE` | reload | Post-reload render complete, session idle |
| `RELOAD_END` | reload | ~5s after idle |
| `NEW_SESSION_BEGIN` | new_session | About to type `/new` |
| `NEW_SESSION_COMMAND_SENT` | new_session | Immediately after pressing Enter on `/new` |
| `NEW_SESSION_RENDERED` | new_session | New session rendered |
| `NEW_SESSION_END` | new_session | ~5s after render |

---

## 6. Correlation Windows

### 6.1 Cold Start

| Boundary | Time | Description |
|----------|------|-------------|
| Window start | `COLD_START_BEGIN` - 2s | Pre-launch buffer |
| Core start | `COLD_START_BEGIN` | Pi launch initiated |
| Core end | `COLD_START_FIRST_RENDER` | Pi first visible |
| Window end | `COLD_START_FIRST_RENDER` + 5s | Post-render buffer for idle |

### 6.2 Open-from-Terminal

| Boundary | Time | Description |
|----------|------|-------------|
| Window start | `OPEN_FROM_TERMINAL_BEGIN` - 2s | Pre-command buffer |
| Core start | `OPEN_FROM_TERMINAL_COMMAND_SENT` | Command sent |
| Core end | `OPEN_FROM_TERMINAL_ATTACHED` | Pi attached |
| Window end | `OPEN_FROM_TERMINAL_ATTACHED` + 5s | Post-attach buffer |

### 6.3 Reload

| Boundary | Time | Description |
|----------|------|-------------|
| Window start | `RELOAD_BEGIN` - 2s | Pre-command buffer |
| Core start | `RELOAD_COMMAND_SENT` | /reload sent |
| Core end | `RELOAD_POST_RENDER_IDLE` | Post-reload idle |
| Window end | `RELOAD_POST_RENDER_IDLE` + 5s | Buffer |

### 6.4 New Session

| Boundary | Time | Description |
|----------|------|-------------|
| Window start | `NEW_SESSION_BEGIN` - 2s | Pre-command buffer |
| Core start | `NEW_SESSION_COMMAND_SENT` | /new sent |
| Core end | `NEW_SESSION_RENDERED` | New session rendered |
| Window end | `NEW_SESSION_RENDERED` + 5s | Buffer |

---

## 7. Evidence Schema

Each process event is recorded as one JSONL line:

```json
{
  "run_id": "win-lifecycle-process-trace-YYYYMMDD-HHMMSS",
  "event_source": "WMI.Win32_ProcessStartTrace",
  "event_time_utc": "2026-06-26T12:34:56.789Z",
  "child_pid": 1234,
  "child_process_name": "cmd.exe",
  "child_executable_path": "C:\\Windows\\System32\\cmd.exe",
  "child_command_line": "cmd.exe /c ...",
  "parent_pid": 4321,
  "parent_process_name": "pi.exe",
  "parent_executable_path": "C:\\Path\\To\\pi.exe",
  "parent_command_line": "pi ...",
  "grandparent_pid": 1111,
  "session_id": 1,
  "user": "DOMAIN\\user",
  "shell_usage": {
    "observed_shell_parent": true,
    "shell_process": "powershell.exe",
    "classification": "powershell-parent"
  },
  "window_console_observations": {
    "conhost_seen": false,
    "windows_terminal_lineage_seen": false,
    "main_window_handle_observable": null,
    "creation_flags_observable": false
  },
  "correlation": {
    "lifecycle_path": "reload",
    "window_name": "RELOAD_COMMAND_SENT_to_RELOAD_POST_RENDER_IDLE",
    "offset_ms_from_window_start": 128
  },
  "raw_event": {},
  "collection_warnings": []
}
```

---

## 8. Verifier Fail-Closed Criteria

A future verifier **MUST FAIL** the run if **any** of the following is true:

1. Any required marker from §5.2 is missing from `markers.jsonl`.
2. Monitor start time (`COLLECTION_START` marker) is **after** the first `*_BEGIN` marker.
3. Timestamps within any single lifecycle path are not strictly monotonic.
4. Events recorded outside the declared correlation windows (§6) are claimed as in-window evidence.
5. Command-line evidence is unavailable (`child_command_line` is null) but conclusions depend on it.
6. Any harness script modified Pi source, Pi configuration, Windows registry, system services, or persistent system settings.
7. Live evidence is claimed without a documented human approval step for live execution.
8. `marker_id` values are duplicated.
9. `run_id` is inconsistent across markers and events.

---

## 9. Rollback, Safety, and Cleanup

### 9.1 During the Run

- **All WMI subscriptions are user-scoped** — they terminate when the registering PowerShell process exits.
- If the trace script crashes or is force-killed, the WMI subscription is automatically cleaned up by the system (no zombie listeners).
- **Do not kill unrelated processes.**

### 9.2 After the Run

1. **Stop all trace listeners:**
   ```powershell
   .\Stop-ProcessTrace.ps1 -RunId $RUN_ID
   ```
   This unregisters the WMI event subscription and stops the background job.

2. **Verify no lingering listeners:**
   ```powershell
   Get-EventSubscriber | Where-Object { $_.SourceObject -like "*ProcessStart*" } | Unregister-Event -Force
   ```

3. **Archive (do not delete) evidence logs:**
   ```powershell
   Move-Item ".\runs\$RUN_ID" ".\runs\$RUN_ID-ARCHIVED-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
   ```

### 9.3 Sensitive Data Handling

- **Command lines may contain secrets** (tokens, passwords, paths).
- Treat `process-events.jsonl` and `correlated-events.jsonl` as **sensitive**.
- Use `Redact-Trace.ps1` (optional, separate script) to create redacted copies — **never overwrite raw evidence**.
- Do not commit raw trace files to public repositories.

### 9.4 ETW/ProcMon Elevation

- If ETW or ProcMon capture is used: **must have explicit human approval documented in the run log.**
- ETW sessions must be stopped explicitly:
  ```powershell
  logman stop "PiProcessTrace" -ets
  ```
- ProcMon must be stopped from its GUI or via command line.

---

## 10. Uncertainty Annotations

| Hypothesis | Confidence | Notes |
|-----------|-----------|-------|
| WMI can capture sufficient command-line detail if `Win32_Process` is queried immediately after `Win32_ProcessStartTrace` | Medium | Race condition possible; child process may exit before query completes |
| Console flashes correlate with transient `cmd.exe`, `powershell.exe`, `conhost.exe`, or terminal-hosted child processes | Medium-High | Requires pattern analysis post-capture |
| Start Menu cold-start parent lineage may vary by Windows shell behavior | High | `explorer.exe` likely; Start Menu vs Taskbar behavior differs |
| `/reload` and `/new` may spawn helper shells or Node/npm child processes | Medium | Depends on Pi implementation and install path |
| Window visibility/creation flags not reliably observable without ETW/ProcMon/UI automation/video capture | High | WMI alone cannot observe `CREATE_NO_WINDOW` or similar flags |

---

## 11. Non-Invasiveness Attestation

This harness:

- Does **not** modify Pi source code, extensions, or configuration.
- Does **not** modify Windows registry.
- Does **not** install or configure system services.
- Does **not** install device drivers.
- Does **not** create persistent hooks, injections, or scheduled tasks.
- Does **not** intercept, pause, or modify running Pi processes.
- Does **not** require elevation for default WMI operation.
- All scripts **terminate cleanly** and are **removable** by deleting the `harness/` directory.
- WMI subscriptions are **process-scoped** and auto-cleanup on script exit.

**This is a harness-artifact-only materialization. No live tracing has been performed.**

---

## 12. File Inventory

| File | Purpose |
|------|---------|
| `README-runbook.md` | This document |
| `Start-ProcessTrace.ps1` | Starts WMI process-start listener, writes `process-events.jsonl` |
| `Write-TraceMarker.ps1` | Appends timestamped action markers to `markers.jsonl` |
| `Stop-ProcessTrace.ps1` | Unregisters listeners, records stop marker |
| `Correlate-ProcessTrace.ps1` | Joins markers and events, emits correlated evidence |
| `correlation-summary.md` | Per-lifecycle event summary template (populated by Correlate-ProcessTrace.ps1) |
