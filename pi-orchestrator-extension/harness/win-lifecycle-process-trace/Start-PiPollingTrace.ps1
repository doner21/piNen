<#
.SYNOPSIS
    Start-PiPollingTrace.ps1 -- HARNESS ARTIFACT
    Starts a NON-ADMIN bounded polling-based process trace for Pi lifecycle
    process-creation capture. Uses Get-CimInstance Win32_Process polling
    instead of Register-CimIndicationEvent (which requires admin/elevation).

.DESCRIPTION
    Polls Get-CimInstance -ClassName Win32_Process at a configurable interval
    (default 200ms). On each poll, diffs against the previous snapshot to
    detect newly created PIDs. For each new process, enriches with Win32_Process
    queries for command line, executable path, parent/grandparent lineage,
    shell/console detection, and writes a JSONL record to process-events.jsonl.

    NON-INVASIVE: No elevation, no registry changes, no drivers, no persistent
    hooks. The polling loop is bounded by -DurationSeconds (default 120s).
    Listener can be stopped out-of-process via Stop-PiPollingTrace.ps1.

    LIMITATIONS vs WMI events:
      - Polling misses processes that start AND exit between polls
      - Timestamps have +/- polling interval accuracy (not exact creation time)
      - No RawWMIEvent field (no Win32_ProcessStartTrace subscription)
      - capture_source = "cim-polling-diff"

.PARAMETER RunId
    Unique run identifier. Recommended format: "pi-lifecycle-YYYYMMDDTHHmmssZ".

.PARAMETER OutputPath
    Directory for output files. Defaults to current directory.

.PARAMETER DurationSeconds
    Maximum duration in seconds before auto-stop. Default 120.
    SAFETY CONSTRAINT: The trace will ALWAYS stop after this bound.

.PARAMETER PollIntervalMs
    Polling interval in milliseconds. Default 200.
    Lower values improve detection accuracy but increase CPU usage.

.PARAMETER PiExecutableName
    Name of the Pi executable process image to tag. Defaults to "pi".
    Used to set is_pi_related boolean in records (NOT to filter -- all
    processes are recorded).

.PARAMETER MaxFileSizeMB
    Maximum size in MB for the events file before rotation. Default 10.

.EXAMPLE
    .\Start-PiPollingTrace.ps1 -RunId "pi-lifecycle-20260626T120000Z" -DurationSeconds 60

.EXAMPLE
    # Launch hidden in background:
    Start-Process powershell -ArgumentList "-NoProfile -WindowStyle Hidden -File `"C:\path\to\Start-PiPollingTrace.ps1`" -RunId `"$env:RUN_ID`" -OutputPath `"$env:RUN_DIR`" -DurationSeconds 120" -WindowStyle Hidden
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".",

    [Parameter(Mandatory = $false)]
    [int]$DurationSeconds = 120,

    [Parameter(Mandatory = $false)]
    [int]$PollIntervalMs = 200,

    [Parameter(Mandatory = $false)]
    [string]$PiExecutableName = "pi",

    [Parameter(Mandatory = $false)]
    [int]$MaxFileSizeMB = 10
)

$ErrorActionPreference = "Stop"

# ── Validate params ────────────────────────────────────────────────────
if ($DurationSeconds -lt 1) {
    throw "DurationSeconds must be >= 1"
}
if ($PollIntervalMs -lt 50) {
    Write-Warning "PollIntervalMs < 50ms may cause high CPU usage. Clamping to 50ms."
    $PollIntervalMs = 50
}

# ── Setup output directory ─────────────────────────────────────────────
if (-not (Test-Path $OutputPath)) {
    New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
}

$EventsFile  = Join-Path $OutputPath "process-events.jsonl"
$LogFile     = Join-Path $OutputPath "trace-collector.log"
$StateFile   = Join-Path $OutputPath ".trace-state.json"
$SubFile     = Join-Path $OutputPath ".trace-subscriber.txt"

# ── Logging helper ─────────────────────────────────────────────────────
function Write-TraceLog {
    param([string]$Message, [string]$Level = "INFO")
    $ts = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffzzz")
    $line = "[$ts] [$Level] $Message"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

# ── Shell/console classification tables ────────────────────────────────
$ShellProcessNames = @(
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe"
)

$ConsoleProcessNames = @(
    "conhost.exe",
    "OpenConsole.exe",
    "WindowsTerminal.exe",
    "wt.exe"
)

function Get-ShellKind {
    param([string]$ProcessName)
    switch -Wildcard ($ProcessName.ToLower()) {
        "cmd.exe"             { return "cmd" }
        "powershell.exe"      { return "powershell" }
        "pwsh.exe"            { return "pwsh" }
        "windowsterminal.exe" { return "windows-terminal" }
        "wt.exe"              { return "windows-terminal" }
        "conhost.exe"         { return "conhost" }
        "openconsole.exe"     { return "open-console" }
        default               { return "unknown" }
    }
}

# ── WMI query helper (gracefully handles race with process exit) ───────
function Get-ProcessDetails {
    param([uint32]$ProcessId)
    if ($ProcessId -eq 0) { return $null }
    try {
        $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop |
                Select-Object -First 1
        if ($proc) {
            return @{
                ProcessId       = $proc.ProcessId
                ProcessName     = $proc.Name
                ExecutablePath  = $proc.ExecutablePath
                CommandLine     = $proc.CommandLine
                ParentProcessId = $proc.ParentProcessId
                SessionId       = $proc.SessionId
            }
        }
    } catch {
        # Process exited before CIM query completed -- expected for short-lived processes
    }
    return $null
}

# ── Lineage resolution ─────────────────────────────────────────────────
function Resolve-Ancestors {
    param([uint32]$ParentPid)
    $parent         = Get-ProcessDetails -ProcessId $ParentPid
    $grandparent    = $null
    $greatGrandparent = $null
    if ($parent -and $parent.ParentProcessId -and $parent.ParentProcessId -ne 0) {
        $grandparent = Get-ProcessDetails -ProcessId $parent.ParentProcessId
        if ($grandparent -and $grandparent.ParentProcessId -and $grandparent.ParentProcessId -ne 0) {
            $greatGrandparent = Get-ProcessDetails -ProcessId $grandparent.ParentProcessId
        }
    }
    return @{
        parent           = $parent
        grandparent      = $grandparent
        greatGrandparent = $greatGrandparent
        allNames         = @(
            if ($parent)           { $parent.ProcessName           } else { $null }
            if ($grandparent)      { $grandparent.ProcessName      } else { $null }
            if ($greatGrandparent) { $greatGrandparent.ProcessName } else { $null }
        ) | Where-Object { $_ }
    }
}

# ── Shell indicators builder ───────────────────────────────────────────
function Get-ShellIndicators {
    param($Ancestors, [string]$ChildProcessName)
    [string[]]$allNames = @($ChildProcessName) + $Ancestors.allNames

    $isShell = $allNames -match ($ShellProcessNames -join '|') -and $allNames[0] -in $ShellProcessNames
    $shellKind = if ($isShell) { Get-ShellKind -ProcessName $allNames[0] } else { $null }
    $hasTerminalAncestor = [bool](($allNames | Select-Object -Skip 1) -match ($ShellProcessNames -join '|') -or
                                  ($allNames | Select-Object -Skip 1) -match ($ConsoleProcessNames -join '|'))
    $hasConhostNearby = [bool](($allNames) -match ($ConsoleProcessNames -join '|'))

    return @{
        is_shell_process      = $isShell
        shell_kind            = $shellKind
        has_terminal_ancestor = $hasTerminalAncestor
        has_conhost_nearby    = $hasConhostNearby
    }
}

# ── Window/console observations builder ────────────────────────────────
function Get-WindowConsoleObservations {
    param($Ancestors)
    $flags = @()
    if ($Ancestors.allNames -contains "conhost.exe") {
        $flags += "conhost_present"
    }
    if ($Ancestors.parent -or $Ancestors.grandparent) {
        $cmdLine = $Ancestors.parent.CommandLine + $Ancestors.grandparent.CommandLine
        if ($cmdLine -match "-WindowStyle\s+Hidden") {
            $flags += "WindowStyle_Hidden_inferred"
        }
        if ($cmdLine -match "start\s+/min") {
            $flags += "start_min_inferred"
        }
        if ($cmdLine -match "cmd\s+/c") {
            $flags += "cmd_c_inferred"
        }
    }

    return @{
        observable = $false
        source     = "process-tree-inference"
        flags      = $flags
        notes      = "Window style not directly observable through CIM polling"
    }
}

# ── Determine enrichment status ────────────────────────────────────────
function Get-EnrichmentStatus {
    param($ChildInfo)
    if ($ChildInfo -and $ChildInfo.ExecutablePath -and $ChildInfo.CommandLine) {
        return "complete"
    } elseif ($ChildInfo) {
        return "partial"
    } else {
        return "missed-process-exited"
    }
}

# ── Determine if process is Pi-related ─────────────────────────────────
function Test-IsPiRelated {
    param([string]$ProcessName, [string]$CommandLine, [string]$PiExePattern)
    if (-not $ProcessName) { return $false }
    # Match executable name (e.g., "pi.exe", "pi")
    $baseName = if ($ProcessName -match '^(.*)\.exe$') { $Matches[1] } else { $ProcessName }
    if ($baseName -eq $PiExePattern) { return $true }
    # Node-based Pi: node.exe with pi in command line
    if ($ProcessName -eq "node.exe" -and $CommandLine -and $CommandLine -match [regex]::Escape($PiExePattern)) {
        return $true
    }
    return $false
}

# ── Write JSONL event record ───────────────────────────────────────────
function Write-ProcessEvent {
    param([hashtable]$EventData)
    $json = $EventData | ConvertTo-Json -Depth 6 -Compress
    Add-Content -Path $EventsFile -Value $json -Encoding UTF8

    # Size check: rotate if exceeding MaxFileSizeMB
    if ((Get-Item $EventsFile -ErrorAction SilentlyContinue).Length -gt ($MaxFileSizeMB * 1MB)) {
        $rotatedName = Join-Path $OutputPath "process-events-$(Get-Date -Format 'yyyyMMdd-HHmmss').jsonl"
        Move-Item -Path $EventsFile -Destination $rotatedName -Force
        Write-TraceLog "Events file rotated to: $rotatedName (exceeded ${MaxFileSizeMB}MB)" -Level "WARN"
    }
}

# ═══════════════════════════════════════════════════════════════════════
# INITIALIZATION
# ═══════════════════════════════════════════════════════════════════════

Write-TraceLog "=== Start-PiPollingTrace ==="
Write-TraceLog "RunId:            $RunId"
Write-TraceLog "OutputPath:       $OutputPath"
Write-TraceLog "DurationSeconds:  $DurationSeconds"
Write-TraceLog "PollIntervalMs:   $PollIntervalMs"
Write-TraceLog "PiExecutableName: $PiExecutableName"
Write-TraceLog "EventsFile:       $EventsFile"

# ── Write COLLECTION_START marker ──────────────────────────────────────
$collectionStartUtc = (Get-Date).ToUniversalTime()
$markersFile = Join-Path $OutputPath "markers.jsonl"
$collectionStartMarker = [ordered]@{
    record_type     = "marker"
    run_id          = $RunId
    lifecycle       = "harness"
    label           = "COLLECTION_START"
    sequence        = 0
    timestamp_utc   = $collectionStartUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local = $collectionStartUtc.ToLocalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    collector_pid   = $PID
    operator_note   = "CIM polling trace listener started (non-admin, bounded ${DurationSeconds}s, ${PollIntervalMs}ms interval)"
    metadata        = @{
        expected_parent_pid = $null
        shell_kind          = $null
        pi_pid              = $null
    }
}
$json = $collectionStartMarker | ConvertTo-Json -Depth 4 -Compress
Add-Content -Path $markersFile -Value $json -Encoding UTF8
Write-TraceLog "COLLECTION_START marker written to markers.jsonl"

# ── Save state files (for out-of-process stop) ─────────────────────────
$listenerPid = $PID
$subscriberId = "pi-polling-$PID"
$listenerPid.ToString() | Out-File -FilePath $SubFile -Encoding UTF8 -Force

@{
    RunId           = $RunId
    EventsFile      = $EventsFile
    LogFile         = $LogFile
    StartedAt       = $collectionStartUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    PiExePat        = $PiExecutableName
    Subscriber      = $subscriberId
    ListenerPid     = $listenerPid
    DurationSeconds = $DurationSeconds
    PollIntervalMs  = $PollIntervalMs
    CaptureMode     = "cim-polling-diff"
} | ConvertTo-Json | Out-File -FilePath $StateFile -Encoding UTF8 -Force

Write-TraceLog "Listener PID: $listenerPid"
Write-TraceLog "State saved to: $StateFile"

# ═══════════════════════════════════════════════════════════════════════
# POLLING LOOP
# ═══════════════════════════════════════════════════════════════════════

Write-TraceLog ""
Write-TraceLog "========================================"
Write-TraceLog "TRACE LISTENER IS ACTIVE (POLLING MODE, NON-ADMIN)."
Write-TraceLog "DO NOT CLOSE THIS WINDOW."
Write-TraceLog "Polling interval: ${PollIntervalMs}ms"
Write-TraceLog "Auto-stop after: ${DurationSeconds}s"
Write-TraceLog "Run: Stop-PiPollingTrace.ps1 -RunId '$RunId' to stop early"
Write-TraceLog "Run: Write-PiLifecycleMarker.ps1 to insert action markers"
Write-TraceLog "========================================"
Write-TraceLog ""

# ── Take initial process snapshot ──────────────────────────────────────
function Get-ProcessSnapshot {
    try {
        $procs = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
                 Select-Object ProcessId, Name, ExecutablePath, CommandLine, ParentProcessId, SessionId
        $snap = @{}
        foreach ($p in $procs) {
            if ($p.ProcessId -gt 0) {
                $snap[[uint32]$p.ProcessId] = $p
            }
        }
        return $snap
    } catch {
        Write-TraceLog "ERROR: Failed to query Win32_Process: $_" -Level "ERROR"
        return $null
    }
}

$previousSnapshot = Get-ProcessSnapshot
if (-not $previousSnapshot) {
    Write-TraceLog "FATAL: Could not take initial process snapshot. Exiting." -Level "ERROR"
    exit 1
}
Write-TraceLog "Initial snapshot: $($previousSnapshot.Count) processes"

$pollCount = 0
$newProcessCount = 0
$deadline = (Get-Date).AddSeconds($DurationSeconds)
$pollIntervalSeconds = $PollIntervalMs / 1000.0

try {
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds $PollIntervalMs
        $pollCount++

        $currentSnapshot = Get-ProcessSnapshot
        if (-not $currentSnapshot) {
            Write-TraceLog "WARNING: Skipping poll $pollCount -- failed to get snapshot" -Level "WARN"
            $previousSnapshot = @{} # Reset to avoid stale diff on next poll
            continue
        }

        # ── Diff: find new PIDs ──────────────────────────────────────────
        $newPids = @()
        foreach ($pidKey in $currentSnapshot.Keys) {
            if (-not $previousSnapshot.ContainsKey($pidKey)) {
                $newPids += $pidKey
            }
        }

        if ($newPids.Count -gt 0) {
            Write-TraceLog "Poll $pollCount : $($newPids.Count) new process(es) detected: $($newPids -join ', ')"

            foreach ($newPid in $newPids) {
                $proc = $currentSnapshot[$newPid]
                $childPid       = $proc.ProcessId
                $childProcName  = $proc.Name
                $parentPid      = $proc.ParentProcessId
                $sessionId      = $proc.SessionId

                $eventTimeUtc   = (Get-Date).ToUniversalTime()
                $eventTimeLocal = $eventTimeUtc.ToLocalTime()

                # Enrich: query Win32_Process for details (uses the current snapshot data)
                $childInfo = @{
                    ProcessId      = $childPid
                    ProcessName    = $childProcName
                    ExecutablePath = $proc.ExecutablePath
                    CommandLine    = $proc.CommandLine
                    ParentProcessId= $parentPid
                    SessionId      = $sessionId
                }

                $ancestors = if ($parentPid -and $parentPid -ne 0) {
                    Resolve-Ancestors -ParentPid $parentPid
                } else {
                    @{ parent = $null; grandparent = $null; greatGrandparent = $null; allNames = @() }
                }

                $shellIndicators = Get-ShellIndicators -Ancestors $ancestors -ChildProcessName $childProcName
                $windowObs       = Get-WindowConsoleObservations -Ancestors $ancestors
                $enrichStatus    = Get-EnrichmentStatus -ChildInfo $childInfo
                $isPiRelated     = Test-IsPiRelated -ProcessName $childProcName -CommandLine $proc.CommandLine -PiExePattern $PiExecutableName

                # Resolve user SID
                $userSid = $null
                try {
                    $currentSessionId = (Get-Process -Id $PID).SessionId
                    if ($sessionId -eq $currentSessionId) {
                        $userSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
                    }
                } catch {
                    # Non-critical
                }

                # Build evidence record
                $record = [ordered]@{
                    record_type                   = "process_start"
                    run_id                        = $RunId
                    capture_source                = "cim-polling-diff"
                    timestamp_utc                 = $eventTimeUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    timestamp_local               = $eventTimeLocal.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
                    child_pid                     = [long]$childPid
                    child_process_name            = if ($childInfo) { $childInfo.ProcessName } else { $childProcName }
                    child_executable_path         = if ($childInfo) { $childInfo.ExecutablePath } else { $null }
                    child_command_line            = if ($childInfo) { $childInfo.CommandLine } else { $null }
                    parent_pid                    = [long]$parentPid
                    parent_process_name           = if ($ancestors.parent) { $ancestors.parent.ProcessName } else { $null }
                    parent_executable_path        = if ($ancestors.parent) { $ancestors.parent.ExecutablePath } else { $null }
                    parent_command_line           = if ($ancestors.parent) { $ancestors.parent.CommandLine } else { $null }
                    session_id                    = [long]$sessionId
                    user_sid                      = $userSid
                    is_pi_related                 = $isPiRelated
                    shell_indicators              = $shellIndicators
                    window_console_observations   = $windowObs
                    enrichment_status             = $enrichStatus
                    # No raw_event -- polling mode doesn't have WMI event subscription
                    raw_event                     = $null
                }

                Write-ProcessEvent -EventData $record
                $newProcessCount++
            }
        }

        # Update snapshot for next diff
        $previousSnapshot = $currentSnapshot

        # Periodic status log every ~100 polls
        if ($pollCount % 100 -eq 0) {
            $remaining = [math]::Max(0, [math]::Round(($deadline - (Get-Date)).TotalSeconds))
            Write-TraceLog "Heartbeat: poll=$pollCount, new_procs=$newProcessCount, remaining=${remaining}s"
        }
    }

    Write-TraceLog "Polling loop complete after $DurationSeconds seconds ($pollCount polls, $newProcessCount new processes detected)"

} finally {
    # ── Cleanup: write TRACE_STOPPED marker even on unexpected exit ──────
    Write-TraceLog "Shutting down polling trace listener..."

    $nowUtc = (Get-Date).ToUniversalTime()
    $stopMarker = [ordered]@{
        record_type    = "marker"
        run_id         = $RunId
        lifecycle      = "harness"
        label          = "TRACE_STOPPED"
        sequence       = 9999  # Will be fixed by merge script
        timestamp_utc  = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        timestamp_local = $nowUtc.ToLocalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
        collector_pid  = [long]$PID
        operator_note  = "Polling trace stopped -- duration limit reached ($DurationSeconds seconds, $pollCount polls, $newProcessCount new processes)"
        metadata       = [ordered]@{
            expected_parent_pid  = $null
            shell_kind           = $null
            shell_pid            = $null
            launch_command       = $null
            pi_pid               = $null
            total_polls          = $pollCount
            new_processes        = $newProcessCount
            capture_mode         = "cim-polling-diff"
        }
    }
    $stopJson = $stopMarker | ConvertTo-Json -Depth 4 -Compress
    Add-Content -Path $markersFile -Value $stopJson -Encoding UTF8
    Write-TraceLog "TRACE_STOPPED marker written"

    # Clean up state files
    foreach ($f in @($StateFile, $SubFile)) {
        if (Test-Path $f) {
            try { Remove-Item $f -Force -ErrorAction Stop }
            catch { Write-TraceLog "WARNING: Could not remove state file: $f" -Level "WARN" }
        }
    }

    Write-TraceLog "Listener shutdown complete."
    Write-TraceLog "Evidence preserved in: $OutputPath"
}
