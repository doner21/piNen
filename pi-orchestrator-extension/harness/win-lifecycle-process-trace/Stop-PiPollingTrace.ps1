<#
.SYNOPSIS
    Stop-PiPollingTrace.ps1 -- HARNESS ARTIFACT
    Stops the NON-ADMIN polling-based process trace listener by killing the
    listener process via Stop-Process, writes TRACE_STOPPED marker, and
    performs cleanup verification.

.DESCRIPTION
    Reads the listener PID from .trace-state.json or .trace-subscriber.txt.
    Stops the listener via Stop-Process (key advantage over WMI: polling
    listeners CAN be killed from another process). Writes TRACE_STOPPED
    marker, verifies listener is gone, cleans up state files, and preserves
    evidence files.

    NON-INVASIVE: Only kills processes created by this harness. No WMI
    subscription cleanup needed (polling doesn't create subscriptions).

.PARAMETER RunId
    REQUIRED. The run identifier string.

.PARAMETER OutputPath
    Directory containing trace files. Defaults to current directory.

.PARAMETER DeleteEvidence
    If specified, deletes evidence files after trace stops.
    OFF BY DEFAULT -- evidence is preserved. Use with caution.

.EXAMPLE
    .\Stop-PiPollingTrace.ps1 -RunId "pi-lifecycle-20260626T120000Z"

.EXAMPLE
    .\Stop-PiPollingTrace.ps1 -RunId $env:RUN_ID -OutputPath $env:RUN_DIR
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".",

    [Parameter(Mandatory = $false)]
    [switch]$DeleteEvidence
)

$ErrorActionPreference = "Continue"

$MarkersFile  = Join-Path $OutputPath "markers.jsonl"
$EventsFile   = Join-Path $OutputPath "process-events.jsonl"
$LogFile      = Join-Path $OutputPath "trace-collector.log"
$StateFile    = Join-Path $OutputPath ".trace-state.json"
$SubFile      = Join-Path $OutputPath ".trace-subscriber.txt"

Write-Host "======================================"  -ForegroundColor Yellow
Write-Host "STOPPING PI POLLING TRACE"               -ForegroundColor Yellow
Write-Host "  Run ID:  $RunId"                         -ForegroundColor Yellow
Write-Host "  Path:    $OutputPath"                    -ForegroundColor Yellow
Write-Host "======================================"  -ForegroundColor Yellow
Write-Host ""

# ── Helper: append to trace log ────────────────────────────────────────
function Write-TraceLog {
    param([string]$Message, [string]$Level = "INFO")
    $ts = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffzzz")
    $line = "[$ts] [$Level] $Message"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    Write-Host $line
}

# ── Step 1: Read listener PID from state files ─────────────────────────
Write-TraceLog "Reading trace state to find listener PID..."
$listenerPid = $null

# Try .trace-state.json first (has more metadata)
if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($state.ListenerPid) {
            $listenerPid = [int]$state.ListenerPid
            Write-TraceLog "Found listener PID from state file: $listenerPid"
        }
    } catch {
        Write-TraceLog "WARNING: Could not parse state file: $_" -Level "WARN"
    }
}

# Fallback: try .trace-subscriber.txt (just the PID)
if (-not $listenerPid -and (Test-Path $SubFile)) {
    try {
        $content = (Get-Content $SubFile -Raw -ErrorAction Stop).Trim()
        if ($content -match '^(\d+)$') {
            $listenerPid = [int]$Matches[1]
            Write-TraceLog "Found listener PID from subscriber file: $listenerPid"
        }
    } catch {
        Write-TraceLog "WARNING: Could not read subscriber file: $_" -Level "WARN"
    }
}

# ── Step 2: Stop the listener process ──────────────────────────────────
$stopped = $false
if ($listenerPid -and $listenerPid -ne $PID) {
    try {
        $proc = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-TraceLog "Stopping listener process PID=$listenerPid (Name=$($proc.ProcessName))..."
            Stop-Process -Id $listenerPid -Force -ErrorAction Stop
            Write-TraceLog "Listener process $listenerPid stopped successfully"
            $stopped = $true

            # Give it a moment to fully exit
            Start-Sleep -Milliseconds 500
        } else {
            Write-TraceLog "Listener process PID=$listenerPid not found (may already have exited)"
        }
    } catch {
        Write-TraceLog "WARNING: Could not stop listener process $listenerPid : $_" -Level "WARN"
    }
} elseif ($listenerPid -eq $PID) {
    Write-TraceLog "WARNING: Stop script is running as the listener PID. Stopping self is not recommended -- use a separate process to stop." -Level "WARN"
} else {
    Write-TraceLog "WARNING: No listener PID found in state files. Listener may have already exited or been manually stopped." -Level "WARN"
}

# ── Step 3: Verify listener is gone ────────────────────────────────────
if ($listenerPid) {
    try {
        $stillRunning = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
        if ($stillRunning) {
            Write-TraceLog "WARNING: Listener process $listenerPid is STILL running after Stop-Process attempt!" -Level "WARN"
        } else {
            Write-TraceLog "Verified: Listener process $listenerPid is not running"
        }
    } catch {
        Write-TraceLog "Verified: Listener process $listenerPid is not running (Get-Process threw, process gone)"
    }
}

# Also check for any orphaned polling powershell processes
try {
    $pollingProcs = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -match "Start-PiPollingTrace" -and $_.ProcessId -ne $PID }
    if ($pollingProcs) {
        foreach ($pp in $pollingProcs) {
            Write-TraceLog "WARNING: Found orphaned polling process: PID=$($pp.ProcessId), CmdLine=$($pp.CommandLine)" -Level "WARN"
        }
    }
} catch {
    # CIM query may fail, not critical
}

# ── Step 4: Write TRACE_STOPPED marker ─────────────────────────────────
if (-not (Test-Path $OutputPath)) {
    New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
}

$nowUtc = (Get-Date).ToUniversalTime()
$nowLocal = $nowUtc.ToLocalTime()

# Get last sequence number for monotonic ordering
$lastSeq = 0
if (Test-Path $MarkersFile) {
    $existing = Get-Content $MarkersFile -Encoding UTF8 -ErrorAction SilentlyContinue |
                Where-Object { $_.Trim() -ne "" } |
                ForEach-Object {
                    try { $_ | ConvertFrom-Json }
                    catch { $null }
                }
    $maxSeq = ($existing | ForEach-Object { $_.sequence } | Measure-Object -Maximum).Maximum
    if ($maxSeq -ge 0) { $lastSeq = $maxSeq + 1 }
}

$stopMarker = [ordered]@{
    record_type     = "marker"
    run_id          = $RunId
    lifecycle       = "harness"
    label           = "TRACE_STOPPED"
    sequence        = $lastSeq
    timestamp_utc   = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local = $nowLocal.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    collector_pid   = [long]$PID
    operator_note   = "Polling trace stopped -- listener PID $listenerPid killed, $(if ($stopped) { 'stopped successfully' } else { 'was not running' })"
    metadata        = [ordered]@{
        expected_parent_pid = $null
        shell_kind          = $null
        shell_pid           = $null
        launch_command      = $null
        pi_pid              = $null
        listener_pid        = $listenerPid
        stopped_ok          = $stopped
        capture_mode        = "cim-polling-diff"
    }
}

$stopJson = $stopMarker | ConvertTo-Json -Depth 4 -Compress
Add-Content -Path $MarkersFile -Value $stopJson -Encoding UTF8
Write-TraceLog "TRACE_STOPPED marker written to markers.jsonl"

# ── Step 5: Clean up state files ───────────────────────────────────────
$stateFiles = @($StateFile, $SubFile)
foreach ($file in $stateFiles) {
    if (Test-Path $file) {
        try {
            Remove-Item $file -Force -ErrorAction Stop
            Write-TraceLog "Removed state file: $(Split-Path $file -Leaf)"
        } catch {
            Write-TraceLog "WARNING: Could not remove state file $(Split-Path $file -Leaf): $_" -Level "WARN"
        }
    }
}

# ── Step 6: Preserve/flush evidence files ──────────────────────────────
$evidenceFiles = @(
    @{Path = $MarkersFile; Name = "markers.jsonl"},
    @{Path = $EventsFile;  Name = "process-events.jsonl"},
    @{Path = $LogFile;     Name = "trace-collector.log"}
)

# Also check for rotated evidence files
$rotatedEvents = Get-ChildItem -Path $OutputPath -Filter "process-events-*.jsonl" -ErrorAction SilentlyContinue
foreach ($re in $rotatedEvents) {
    $evidenceFiles += @{Path = $re.FullName; Name = $re.Name}
}

foreach ($ef in $evidenceFiles) {
    if (Test-Path $ef.Path) {
        $size = (Get-Item $ef.Path).Length
        Write-TraceLog "Evidence preserved: $($ef.Name) ($([math]::Round($size/1KB, 1)) KB)"
    } else {
        Write-TraceLog "Evidence file not found: $($ef.Name)" -Level "WARN"
    }
}

# ── Step 7: Delete evidence if requested ───────────────────────────────
if ($DeleteEvidence) {
    Write-TraceLog "WARNING: Deleting evidence files as requested" -Level "WARN"
    foreach ($ef in $evidenceFiles) {
        if (Test-Path $ef.Path) {
            try {
                Remove-Item $ef.Path -Force
                Write-TraceLog "Deleted: $($ef.Name)"
            } catch {
                Write-TraceLog "ERROR: Could not delete $($ef.Name): $_" -Level "ERROR"
            }
        }
    }
}

# ── Summary ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================"  -ForegroundColor Green
Write-Host "POLLING TRACE STOPPED"                    -ForegroundColor Green
Write-Host "  Run ID:         $RunId"
Write-Host "  Listener PID:   $listenerPid"
Write-Host "  Stopped:        $(if ($stopped) { 'YES' } else { 'NO (already gone or not found)' })"
Write-Host "  Markers:        $MarkersFile"
Write-Host "  Events:         $EventsFile"
Write-Host "  Evidence:       $(if ($DeleteEvidence) { 'DELETED' } else { 'PRESERVED' })"
Write-Host "======================================"  -ForegroundColor Green
Write-Host ""
Write-Host "Next step: Merge-PiPollingEvidence.ps1 -RunId '$RunId' -OutputPath '$OutputPath'"
