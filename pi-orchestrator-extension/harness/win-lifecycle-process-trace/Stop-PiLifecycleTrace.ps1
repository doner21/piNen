<#
.SYNOPSIS
    Stop-PiLifecycleTrace.ps1 -- HARNESS ARTIFACT
    Stops the WMI process-start trace listener, unregisters all subscriptions,
    terminates background jobs, writes TRACE_STOPPED marker, and performs
    full cleanup verification.

.DESCRIPTION
    Cleans up all WMI event subscriptions related to Pi lifecycle tracing.
    Writes TRACE_STOPPED marker to markers.jsonl for audit trail.
    Removes internal state files. Verifies that all subscriptions are gone.
    Preserves evidence files (markers.jsonl, process-events.jsonl, trace-collector.log).

    NON-INVASIVE: Only removes subscriptions created by this harness.
    Does not modify system state beyond unregistering its own WMI listeners.

.PARAMETER RunId
    REQUIRED. The run identifier string.

.PARAMETER OutputPath
    Directory containing trace files. Defaults to current directory.

.PARAMETER DeleteEvidence
    If specified, deletes evidence files after trace stops.
    OFF BY DEFAULT -- evidence is preserved. Use with caution.

.EXAMPLE
    .\Stop-PiLifecycleTrace.ps1 -RunId "pi-lifecycle-20260626T120000Z"

.EXAMPLE
    .\Stop-PiLifecycleTrace.ps1 -RunId $env:RUN_ID -OutputPath $env:RUN_DIR
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
Write-Host "STOPPING PI LIFECYCLE PROCESS TRACE"      -ForegroundColor Yellow
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

# ── Step 1: Read subscriber name ───────────────────────────────────────
Write-TraceLog "Reading trace state..."
$subscriberName = $null
if (Test-Path $SubFile) {
    try {
        $subscriberName = (Get-Content $SubFile -Raw -ErrorAction Stop).Trim()
        Write-TraceLog "Found subscriber: $subscriberName"
    } catch {
        Write-TraceLog "WARNING: Could not read subscriber file: $_" -Level "WARN"
    }
}

# ── Step 2: Unregister WMI event subscriptions ─────────────────────────
Write-TraceLog "Unregistering WMI event subscriptions..."
$unregistered = 0

# Method A: By subscriber name (most precise)
if ($subscriberName) {
    try {
        $sub = Get-EventSubscriber -SubscriptionId $subscriberName -ErrorAction SilentlyContinue
        if ($sub) {
            Unregister-Event -SubscriptionId $subscriberName -Force -ErrorAction Stop
            Write-TraceLog "Unregistered subscriber: $subscriberName"
            $unregistered++
        } else {
            Write-TraceLog "Subscriber $subscriberName not found (may already be cleaned up)"
        }
    } catch {
        Write-TraceLog "WARNING: Could not unregister by subscriber name '$subscriberName': $_" -Level "WARN"
    }
}

# Method B: Any CIM indication events matching ProcessStartTrace
try {
    $cimEvents = Get-EventSubscriber -ErrorAction SilentlyContinue |
                 Where-Object {
                     $src = $_.SourceObject
                     ($src -is [string] -and $src -match "Win32_ProcessStartTrace") -or
                     ($src -is [string] -and $src -match "ProcessStart")
                 }
    foreach ($evt in $cimEvents) {
        try {
            Unregister-Event -SubscriptionId $evt.SubscriptionId -Force -ErrorAction Stop
            Write-TraceLog "Unregistered CIM subscriber: $($evt.SubscriptionId)"
            $unregistered++
        } catch {
            Write-TraceLog "WARNING: Could not unregister CIM subscriber $($evt.SubscriptionId): $_" -Level "WARN"
        }
    }
} catch {
    Write-TraceLog "WARNING: Error enumerating CIM subscribers: $_" -Level "WARN"
}

# Method C: Remove any background jobs matching ProcessStart (fallback)
try {
    $jobs = Get-Job -Name "*ProcessStart*" -ErrorAction SilentlyContinue
    foreach ($job in $jobs) {
        try {
            Remove-Job -Id $job.Id -Force -ErrorAction Stop
            Write-TraceLog "Removed background job: $($job.Id) ($($job.Name))"
            $unregistered++
        } catch {
            Write-TraceLog "WARNING: Could not remove job $($job.Id): $_" -Level "WARN"
        }
    }
} catch {
    Write-TraceLog "WARNING: Error enumerating background jobs: $_" -Level "WARN"
}

# Method D: Remove any remaining event registrations by source identifier
try {
    $allSubs = Get-EventSubscriber -ErrorAction SilentlyContinue
    foreach ($sub in $allSubs) {
        $srcStr = try { $sub.SourceObject.ToString() } catch { "" }
        if ($srcStr -match "ProcessStart|Win32_Process") {
            try {
                Unregister-Event -SubscriptionId $sub.SubscriptionId -Force -ErrorAction Stop
                Write-TraceLog "Unregistered residual subscriber: $($sub.SubscriptionId)"
                $unregistered++
            } catch {
                Write-TraceLog "WARNING: Could not unregister residual $($sub.SubscriptionId): $_" -Level "WARN"
            }
        }
    }
} catch {
    Write-TraceLog "WARNING: Final subscriber sweep error: $_" -Level "WARN"
}

# ── Step 3: Write TRACE_STOPPED marker ─────────────────────────────────
if (-not (Test-Path $OutputPath)) {
    New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
}

$nowUtc = (Get-Date).ToUniversalTime()
$nowLocal = $nowUtc.ToLocalTime()

# Get last sequence number
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
    record_type    = "marker"
    run_id         = $RunId
    lifecycle      = "harness"
    label          = "TRACE_STOPPED"
    sequence       = $lastSeq
    timestamp_utc  = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local = $nowLocal.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    collector_pid  = [long]$PID
    operator_note  = "Trace stopped -- $unregistered subscriptions unregistered"
    metadata       = [ordered]@{
        expected_parent_pid = $null
        shell_kind          = $null
        shell_pid           = $null
        launch_command      = $null
        pi_pid              = $null
        subscriptions_cleared = $unregistered
    }
}

$stopJson = $stopMarker | ConvertTo-Json -Depth 4 -Compress
Add-Content -Path $MarkersFile -Value $stopJson -Encoding UTF8
Write-TraceLog "TRACE_STOPPED marker written to markers.jsonl"

# ── Step 4: Clean up state files ───────────────────────────────────────
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

# ── Step 5: Flush evidence files ───────────────────────────────────────
# Files are auto-flushed via Add-Content; verify they exist
$evidenceFiles = @(
    @{Path = $MarkersFile; Name = "markers.jsonl"},
    @{Path = $EventsFile;  Name = "process-events.jsonl"},
    @{Path = $LogFile;     Name = "trace-collector.log"}
)

foreach ($ef in $evidenceFiles) {
    if (Test-Path $ef.Path) {
        $size = (Get-Item $ef.Path).Length
        Write-TraceLog "Evidence preserved: $($ef.Name) ($([math]::Round($size/1KB, 1)) KB)"
    } else {
        Write-TraceLog "Evidence file not found: $($ef.Name)" -Level "WARN"
    }
}

# ── Step 6: Delete evidence if requested ───────────────────────────────
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

# ── Step 7: Final verification ─────────────────────────────────────────
Write-TraceLog ""
Write-TraceLog "Verifying cleanup..."

$remaining = @()
try {
    $remaining = Get-EventSubscriber -ErrorAction SilentlyContinue |
                 Where-Object {
                     $src = try { $_.SourceObject.ToString() } catch { "" }
                     $src -match "Win32_ProcessStartTrace|ProcessStart"
                 }
} catch {
    $remaining = @()
}

if ($remaining.Count -eq 0) {
    Write-TraceLog "CLEANUP VERIFIED: No residual WMI subscriptions remain."
} else {
    Write-TraceLog "WARNING: $($remaining.Count) residual subscriptions remain:" -Level "WARN"
    foreach ($r in $remaining) {
        Write-TraceLog "  - $($r.SubscriptionId): $($r.SourceObject)" -Level "WARN"
    }
}

# ── Summary ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================"  -ForegroundColor Green
Write-Host "TRACE STOPPED"                             -ForegroundColor Green
Write-Host "  Run ID:          $RunId"
Write-Host "  Subscriptions:   $unregistered unregistered"
Write-Host "  Residual:        $($remaining.Count)"
Write-Host "  Markers:         $MarkersFile"
Write-Host "  Events:          $EventsFile"
Write-Host "  Evidence:         $(if ($DeleteEvidence) { 'DELETED' } else { 'PRESERVED' })"
Write-Host "======================================"  -ForegroundColor Green
Write-Host ""
Write-Host "Next step: Merge-PiLifecycleEvidence.ps1 -RunId '$RunId' -OutputPath '$OutputPath'"
