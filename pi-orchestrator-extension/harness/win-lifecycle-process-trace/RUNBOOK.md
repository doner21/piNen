# Win Lifecycle Process Trace — RUNBOOK

**Status:** HARNESS ARTIFACT — non-invasive diagnostic tooling. For future human-approved run only.

**DO NOT EXECUTE without reading and approving every safety constraint in this document.**

---

## 1. Prerequisites

- Windows 10+ or Windows Server 2016+
- PowerShell 5.1+ (Windows PowerShell) or PowerShell 7+
- **No elevation required** for polling-mode capture (recommended non-admin path)
- WMI event-based capture (Win32_ProcessStartTrace) may require **Event Log Readers** membership or admin rights
- ETW/ProcMon capture requires **separate explicit human approval** (admin rights / driver installation)
- Pi installed and reachable (adjust `$PiExecutableName` parameter if not `pi.exe`)

---

## 0. Quick Start: Polling Mode (Non-Admin) -- RECOMMENDED

**Polling mode is the recommended approach for non-admin users.** It uses
`Get-CimInstance Win32_Process` polling with PID diff detection instead of
WMI event subscriptions (which require elevation on many systems).

### 0.1 Key Differences vs WMI Event Mode

| Aspect | Polling (cim-polling-diff) | WMI Events (Win32_ProcessStartTrace) |
|---|---|---|
| **Admin required** | No | Yes (Event Log Readers group) |
| **Detection** | PID diff between snapshots | Kernel event subscription |
| **Missed processes** | Processes that start AND exit within polling interval | None |
| **Timestamp accuracy** | +/- polling interval | Exact creation timestamp |
| **Stop mechanism** | Kill listener process by PID | Unregister CIM subscription |
| **Raw kernel event** | Not available | Win32_ProcessStartTrace fields |
| **Cross-session** | Same-session only | All sessions (with privileges) |

### 0.2 Procedure

```powershell
# 0. Setup
$env:RUN_ID = "pi-polling-$(Get-Date -Format 'yyyyMMddTHHmmssZ')"
$env:RUN_DIR = Join-Path $env:TEMP "pi-lifecycle-trace\$env:RUN_ID"
New-Item -Path $env:RUN_DIR -ItemType Directory -Force | Out-Null
Write-Host "Run directory: $env:RUN_DIR"

# 1. Start the polling listener (hidden, auto-stops after 120s by default)
Start-Process powershell -ArgumentList (
    "-NoProfile -WindowStyle Hidden -File `"" +
    "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Start-PiPollingTrace.ps1`"" +
    " -RunId `"$env:RUN_ID`"" +
    " -OutputPath `"$env:RUN_DIR`"" +
    " -DurationSeconds 120" +
    " -PollIntervalMs 200" +
    " -PiExecutableName `"pi`""
) -WindowStyle Hidden

# Wait for listener to initialize
Start-Sleep -Seconds 2

# Verify listener is running
if (Test-Path (Join-Path $env:RUN_DIR ".trace-subscriber.txt")) {
    $listenerPid = Get-Content (Join-Path $env:RUN_DIR ".trace-subscriber.txt")
    Write-Host "Listener running: PID=$listenerPid"
} else {
    Write-Warning "Listener may not have started -- check trace-collector.log"
}

# 2. Execute lifecycle paths (use Write-PiLifecycleMarker.ps1 -- same as WMI mode)
# Follow procedures in sections 4-7 below

# 3. Stop the polling listener
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Stop-PiPollingTrace.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR

# 4. Correlate evidence
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Merge-PiPollingEvidence.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR
```

### 0.3 Polling Scripts Reference

| Script | Purpose |
|---|---|
| `Start-PiPollingTrace.ps1` | Start non-admin polling trace listener |
| `Stop-PiPollingTrace.ps1` | Stop polling listener by killing PID |
| `Merge-PiPollingEvidence.ps1` | Correlate polling evidence and generate reports |
| `Write-PiLifecycleMarker.ps1` | Write action markers (shared with WMI mode) |

### 0.4 Polling Parameters

| Parameter | Default | Description |
|---|---|---|
| `-DurationSeconds` | 120 | Auto-stop after this many seconds (safety bound) |
| `-PollIntervalMs` | 200 | Polling interval in ms (lower = more accurate but higher CPU) |
| `-PiExecutableName` | `pi` | Process name to tag as `is_pi_related` |
| `-MaxFileSizeMB` | 10 | Max events file size before rotation |

---

## 2. Directory Setup

All evidence for a run lives in a single directory:

```powershell
$env:RUN_ID = "pi-lifecycle-$(Get-Date -Format 'yyyyMMddTHHmmssZ')"
$env:RUN_DIR = Join-Path $env:TEMP "pi-lifecycle-trace\$env:RUN_ID"
New-Item -Path $env:RUN_DIR -ItemType Directory -Force | Out-Null
Write-Host "Run directory: $env:RUN_DIR"
```

Temp root convention from planner: `%TEMP%\pi-lifecycle-trace\<run_id>\`

---

## 3. General Procedure (All Lifecycle Paths)

### 3.1 Start Listener (WMI Event Mode)

> **NOTE:** WMI event mode may require admin rights. If you get "Access denied",
> use Polling Mode (section 0 above) instead.

```powershell
# In a PowerShell window (keep this open for the entire session):
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Start-PiLifecycleTrace.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -PiExecutableName "pi.exe"
```

**Verify:** Output shows `"TRACE LISTENER IS ACTIVE. DO NOT CLOSE THIS WINDOW."`

### 3.2 Execute Lifecycle Path

Follow the path-specific procedures in §4–§7. Use `Write-PiLifecycleMarker.ps1` to insert markers at each boundary.

### 3.3 Stop Listener

When all lifecycle paths are complete:

```powershell
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Stop-PiLifecycleTrace.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR
```

### 3.4 Correlate Evidence

**For WMI Event Mode:**
```powershell
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Merge-PiLifecycleEvidence.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR
```

**For Polling Mode:**
```powershell
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Merge-PiPollingEvidence.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR
```

Output files:
- `correlation-report.md`
- `correlation-report.json`
- `evidence-index.json`

---

## 4. Cold Start Procedure

**Scope:** Pi launched from scratch via Start Menu, direct executable, or shortcut.

### 4.1 Markers

| Order | Marker | Operator Action |
|-------|--------|----------------|
| 1 | `COLD_START_BEGIN` | Before launching Pi |
| 2 | `COLD_START_FIRST_RENDER` | When Pi first visibly renders UI |
| 3 | `COLD_START_END` | When Pi is idle/usable (post-startup tasks complete) |

### 4.2 Step-by-Step

```powershell
# Step 1: Ensure trace listener is running (see §3.1)

# Step 2: Write COLD_START_BEGIN marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "COLD_START_BEGIN" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "About to launch Pi from Start Menu"

# Step 3: Launch Pi (manually)
#    - Via Start Menu: Press Win key, type "pi", press Enter
#    - Via terminal: pi
#    - Via direct path: "C:\Program Files\...\pi.exe"
#    DO NOT use /reload or /new flags — this is cold start.

# Step 4: Wait for Pi to visibly render (TUI appears in terminal)

# Step 5: Write COLD_START_FIRST_RENDER marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "COLD_START_FIRST_RENDER" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "Pi first visible render observed"

# Step 6: Wait for Pi to stabilize (model loaded, prompt visible, no startup messages)

# Step 7: Write COLD_START_END marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "COLD_START_END" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "Pi idle and usable"
```

### 4.3 Correlation Window

| Boundary | Value |
|----------|-------|
| Primary bracket | `COLD_START_BEGIN` → `COLD_START_FIRST_RENDER` |
| Expanded verifier window | `COLD_START_BEGIN - 2s` → `COLD_START_END + 5s` |
| Max timeout | 60s |

### 4.4 Expected Evidence

- Process tree rooted at Pi executable (or `node.exe`, or wrapper)
- Any transient `cmd.exe`, `powershell.exe`, `conhost.exe`, `OpenConsole.exe`, `WindowsTerminal.exe`, helper shells, or child processes created during launch
- Parent process identity (e.g., `explorer.exe` for Start Menu, terminal parent for terminal launch)

---

## 5. Open-from-Terminal Procedure

**Scope:** Pi launched from an existing shell (`cmd.exe`, `powershell.exe`, `pwsh.exe`, Windows Terminal).

### 5.1 Markers

| Order | Marker | Operator Action |
|-------|--------|----------------|
| 1 | `OPEN_FROM_TERMINAL_BEGIN` | Before typing launch command |
| 2 | `OPEN_FROM_TERMINAL_COMMAND_SENT` | Immediately after pressing Enter on launch command |
| 3 | `OPEN_FROM_TERMINAL_ATTACHED` | When Pi TUI appears in the terminal |
| 4 | `OPEN_FROM_TERMINAL_END` | When Pi is idle/usable |

### 5.2 Step-by-Step

```powershell
# Step 1: Identify your shell PID
$SHELL_PID = $PID
$SHELL_KIND = if ($PSVersionTable.PSEdition -eq "Core") { "pwsh" } else { "powershell" }
# Alternative if in cmd.exe: run 'echo %PID%' and note the value
# For Windows Terminal: use Get-Process WindowsTerminal | Select-Object Id

# Step 2: Write OPEN_FROM_TERMINAL_BEGIN marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "OPEN_FROM_TERMINAL_BEGIN" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "About to launch Pi from terminal" `
    -ShellPid $SHELL_PID `
    -ShellKind $SHELL_KIND

# Step 3: Type the launch command, but DO NOT press Enter yet
#    Example: pi

# Step 4: Press Enter to execute the command

# Step 5: IMMEDIATELY write OPEN_FROM_TERMINAL_COMMAND_SENT marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "OPEN_FROM_TERMINAL_COMMAND_SENT" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "Launch command submitted" `
    -ShellPid $SHELL_PID `
    -ShellKind $SHELL_KIND

# Step 6: Wait for Pi TUI to appear in terminal

# Step 7: Write OPEN_FROM_TERMINAL_ATTACHED marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "OPEN_FROM_TERMINAL_ATTACHED" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "Pi TUI attached to terminal" `
    -ShellPid $SHELL_PID `
    -ShellKind $SHELL_KIND

# Step 8: Wait for Pi to stabilize

# Step 9: Write OPEN_FROM_TERMINAL_END marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "OPEN_FROM_TERMINAL_END" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "Pi idle after terminal launch" `
    -ShellPid $SHELL_PID `
    -ShellKind $SHELL_KIND
```

### 5.3 Correlation Window

| Boundary | Value |
|----------|-------|
| Primary bracket | `OPEN_FROM_TERMINAL_BEGIN` → `OPEN_FROM_TERMINAL_ATTACHED` |
| Expanded verifier window | `OPEN_FROM_TERMINAL_BEGIN - 2s` → `OPEN_FROM_TERMINAL_END + 5s` |
| Max timeout | 45s |

### 5.4 Expected Evidence

- Parent shell PID → Pi process → any transient console/shell children
- Shell kind (`cmd`, `powershell`, `pwsh`, or `windows-terminal`) reflected in markers
- Launch command lineage chain

---

## 6. Runtime Reload Procedure

**Scope:** Pi reload triggered by `/reload` while Pi is already running.

### 6.1 Markers

| Order | Marker | Operator Action |
|-------|--------|----------------|
| 1 | `RELOAD_BEGIN` | Before typing `/reload` |
| 2 | `RELOAD_TRIGGER_SENT` | Immediately after submitting `/reload` |
| 3 | `RELOAD_POST_IDLE` | When Pi appears usable again after reload |
| 4 | `RELOAD_END` | Final confirmation of stable state |

### 6.2 Step-by-Step

```powershell
# Step 1: Note current Pi PID (from Task Manager or Get-Process)
#    $PI_PID = (Get-Process -Name "pi" -ErrorAction SilentlyContinue | Select-Object -First 1).Id

# Step 2: Write RELOAD_BEGIN marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "RELOAD_BEGIN" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "About to type /reload in Pi" `
    -PiPid $PI_PID

# Step 3: Type '/reload' in Pi and press Enter

# Step 4: IMMEDIATELY write RELOAD_TRIGGER_SENT marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "RELOAD_TRIGGER_SENT" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "/reload command submitted" `
    -PiPid $PI_PID

# Step 5: Wait for reload to complete — Pi reconnects, TUI appears, prompt visible

# Step 6: Write RELOAD_POST_IDLE marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "RELOAD_POST_IDLE" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "Pi usable after reload" `
    -PiPid $PI_PID

# Step 7: Check if Pi PID changed
#    $NEW_PI_PID = (Get-Process -Name "pi" -ErrorAction SilentlyContinue | Select-Object -First 1).Id
#    Note whether PID changed: $PI_PID vs $NEW_PI_PID

# Step 8: Write RELOAD_END marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "RELOAD_END" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "Reload complete — Pi PID: $NEW_PI_PID (was: $PI_PID)" `
    -PiPid $NEW_PI_PID
```

### 6.3 Correlation Window

| Boundary | Value |
|----------|-------|
| Primary bracket | `RELOAD_TRIGGER_SENT` → `RELOAD_POST_IDLE` |
| Expanded verifier window | `RELOAD_BEGIN - 1s` → `RELOAD_END + 10s` |
| Max timeout | 90s |

### 6.4 Expected Evidence

- Any new child process spawned by the existing Pi process during reload
- Any shell/console flash process (`cmd.exe`, `powershell.exe`, `conhost.exe`)
- Any replacement Pi process, if reload creates one (note PID before/after)
- If no new processes appear, that is also evidence: reload may be in-process

---

## 7. New Session Procedure

**Scope:** Pi starts a clean session via `/new`.

### 7.1 Markers

| Order | Marker | Operator Action |
|-------|--------|----------------|
| 1 | `NEW_SESSION_BEGIN` | Before typing `/new` |
| 2 | `NEW_SESSION_TRIGGER_SENT` | Immediately after submitting `/new` |
| 3 | `NEW_SESSION_RENDER` | When new session Pi TUI renders |
| 4 | `NEW_SESSION_END` | When new session is fully idle/usable |

### 7.2 Step-by-Step

```powershell
# Step 1: Note current Pi PID
#    $OLD_PI_PID = (Get-Process -Name "pi" -ErrorAction SilentlyContinue | Select-Object -First 1).Id

# Step 2: Write NEW_SESSION_BEGIN marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "NEW_SESSION_BEGIN" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "About to type /new in Pi" `
    -PiPid $OLD_PI_PID

# Step 3: Type '/new' in Pi and press Enter

# Step 4: IMMEDIATELY write NEW_SESSION_TRIGGER_SENT marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "NEW_SESSION_TRIGGER_SENT" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "/new command submitted" `
    -PiPid $OLD_PI_PID

# Step 5: Wait for new session to render — Pi TUI appears (may be in new window or same window)

# Step 6: Write NEW_SESSION_RENDER marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "NEW_SESSION_RENDER" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "New session Pi TUI rendered" `
    -PiPid $OLD_PI_PID

# Step 7: Check for new Pi PID
#    $NEW_PI_PID = (Get-Process -Name "pi" -ErrorAction SilentlyContinue | Select-Object -First 1).Id

# Step 8: Wait for new session to stabilize

# Step 9: Write NEW_SESSION_END marker
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Write-PiLifecycleMarker.ps1" `
    -MarkerName "NEW_SESSION_END" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -Note "New session stable — old PID: $OLD_PI_PID, new PID: $NEW_PI_PID"
```

### 7.3 Correlation Window

| Boundary | Value |
|----------|-------|
| Primary bracket | `NEW_SESSION_TRIGGER_SENT` → `NEW_SESSION_RENDER` |
| Expanded verifier window | `NEW_SESSION_BEGIN - 1s` → `NEW_SESSION_END + 10s` |
| Max timeout | 120s |

### 7.4 Expected Evidence

- Current Pi process spawning or handing off to a new Pi/session process
- Any transient shell/console children
- Any terminal attach/detach behavior
- Old Pi PID vs new Pi PID (may be same or different)

---

## 8. Safety / Rollback Procedure

After ALL lifecycle paths are traced, run:

```powershell
# Step 1a: Stop WMI event trace listener (from the listener window or a new window)
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Stop-PiLifecycleTrace.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR

# OR Step 1b: Stop polling trace listener
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Stop-PiPollingTrace.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR
```

**WMI stop script** does:
1. Writes `TRACE_STOPPED` marker to markers.jsonl
2. Unregisters WMI event subscriptions by source identifier
3. Stops any PowerShell listener background jobs
4. Flushes and closes evidence files
5. Verifies that all subscriptions are cleaned up
6. Removes internal state files (`.trace-subscriber.txt`, `.trace-state.json`)

**Polling stop script** does:
1. Reads listener PID from state file
2. Kills listener process via Stop-Process
3. Verifies listener is gone
4. Writes `TRACE_STOPPED` marker
5. Cleans up state files
6. Preserves evidence files

### 8.1 Manual Cleanup Verification

```powershell
# Verify no residual WMI subscriptions
Get-EventSubscriber | Where-Object { $_.SourceObject -match "Win32_ProcessStartTrace" }
# Expected output: (none)

# Verify no residual background jobs
Get-Job | Where-Object { $_.Name -match "ProcessStart" }
# Expected output: (none)
```

### 8.2 Evidence Preservation

- **DO NOT DELETE** `$env:RUN_DIR` after collection
- Evidence files (`markers.jsonl`, `process-events.jsonl`, `trace-collector.log`) are the permanent audit record
- Only delete temp logs when the human explicitly requests it
- Never commit raw command line data without review and redaction

### 8.3 Hard Constraints

- ❌ Never modify Pi source files
- ❌ Never modify `$env:APPDATA\.pi\agent\` config files
- ❌ Never modify Windows registry (`HKLM`, `HKCU`, etc.)
- ❌ Never install Windows services
- ❌ Never create persistent scheduled tasks
- ❌ Bound capture duration with timeout (`Start-PiLifecycleTrace.ps1` auto-timeout parameter)
- ❌ Bound log size with rotation (10MB default per file, configurable)
- ⚠️ Treat command lines as sensitive data — do not commit unredacted
- ✅ Only redact secrets in derived reports (correlation-report.md), not raw evidence files, unless human explicitly requests raw redaction

---

## 9. ETW / ProcMon Extension (Requires Separate Approval)

Default harness is **WMI-only**. If the human separately approves ETW or ProcMon:

### 9.1 ETW

```powershell
# Requires: Administrator elevation
# NOT included in default harness
# Use logman / xperf or Event Tracing Session
logman start PiLifecycleTrace -p "Microsoft-Windows-Kernel-Process" 0x10 -ets -o "$env:RUN_DIR\kernel-process.etl"
# ... run lifecycle paths ...
logman stop PiLifecycleTrace -ets
```

### 9.2 ProcMon Import

If a human separately produces a ProcMon CSV/PML export, the merge script supports importing it as an additional evidence source with `-ProcMonCsv` parameter.

```powershell
& "~\.pi\pi-orchestrator-extension\harness\win-lifecycle-process-trace\Merge-PiLifecycleEvidence.ps1" `
    -RunId $env:RUN_ID `
    -OutputPath $env:RUN_DIR `
    -ProcMonCsv "$env:RUN_DIR\procmon-export.csv"
```

**ProcMon live capture requires explicit human approval** (may involve drivers/admin rights).

---

## 10. Scoped-Out Items (Planner Constraints)

- No live monitoring in this orchestration
- No live Pi launch
- No `/reload` or `/new` execution
- No Pi source edits
- No Pi configuration edits
- No Windows registry edits
- No service installation
- No persistent scheduled task
- No driver-based capture by default
- No claim that console flashes were observed unless future evidence proves it
- No automated Pi lifecycle triggering by the harness unless separately approved
