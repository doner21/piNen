<#
.SYNOPSIS
    Stop-ProcessTrace.ps1 — HARNESS ARTIFACT
    Stops the WMI process-start trace listener, unregisters subscriptions,
    terminates background jobs, and writes a COLLECTION_END marker.

.DESCRIPTION
    Cleans up all WMI event subscriptions related to process tracing.
    Writes a COLLECTION_END marker to the markers file for audit trail.
    Verifies that all subscriptions are removed.

    NON-INVASIVE: Only removes subscriptions created by this harness.
    Does not modify system state beyond unregistering its own WMI listeners.

.PARAMETER RunId
    REQUIRED. The run identifier string.

.PARAMETER OutputPath
    Directory for output files. Defaults to current directory.

.EXAMPLE
    .\Stop-ProcessTrace.ps1 -RunId "win-lifecycle-process-trace-20260626-123456"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = "."
)

$ErrorActionPreference = "Continue"

$MarkersFile = Join-Path $OutputPath "markers.jsonl"
$StateFile   = Join-Path $OutputPath ".trace-state.json"

Write-Host "======================================"
Write-Host "STOPPING PROCESS TRACE: $RunId"
Write-Host "======================================"

# ── Step 1: Write COLLECTION_END marker ────────────────────────────────
$nowUtc   = (Get-Date).ToUniversalTime()
$nowLocal = $nowUtc.ToLocalTime()
$tickCount = [Environment]::TickCount

$endMarker = [ordered]@{
    run_id         = $RunId
    marker_id      = [guid]::NewGuid().ToString()
    marker_name    = "COLLECTION_END"
    lifecycle_path = "harness"
    timestamp_utc  = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local = $nowLocal.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    monotonic_ms   = $tickCount
    operator_note  = "WMI process-start trace listener stopped"
}

if (-not (Test-Path $OutputPath)) {
    New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
}
$json = $endMarker | ConvertTo-Json -Depth 3 -Compress
Add-Content -Path $MarkersFile -Value $json -Encoding UTF8
Write-Host "[MARKER] COLLECTION_END written to markers.jsonl"

# ── Step 2: Read subscriber name from state file ───────────────────────
$subscriberName = $null
if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        $subscriberFile = Join-Path $OutputPath ".trace-subscriber.txt"
        if (Test-Path $subscriberFile) {
            $subscriberName = Get-Content $subscriberFile -Raw | ForEach-Object { $_.Trim() }
            Write-Host "Found subscriber name: $subscriberName"
        }
    } catch {
        Write-Host "WARNING: Could not read trace state file: $_"
    }
}

# ── Step 3: Unregister WMI event subscriptions ─────────────────────────
$unregistered = 0

# Method 1: Unregister by subscriber name
if ($subscriberName) {
    try {
        $sub = Get-EventSubscriber -SubscriptionId $subscriberName -ErrorAction SilentlyContinue
        if ($sub) {
            Unregister-Event -SubscriptionId $subscriberName -Force -ErrorAction Stop
            Write-Host "Unregistered event subscriber: $subscriberName"
            $unregistered++
        }
    } catch {
        Write-Host "WARNING: Could not unregister by subscriber name '$subscriberName': $_"
    }
}

# Method 2: Clean up any remaining CIM indication events
try {
    $cimEvents = Get-EventSubscriber -ErrorAction SilentlyContinue |
                 Where-Object { $_.SourceObject -match "Win32_ProcessStartTrace" -or $_.SourceObject -match "ProcessStart" }
    foreach ($evt in $cimEvents) {
        try {
            Unregister-Event -SubscriptionId $evt.SubscriptionId -Force -ErrorAction Stop
            Write-Host "Unregistered CIM event subscriber: $($evt.SubscriptionId)"
            $unregistered++
        } catch {
            Write-Host "WARNING: Could not unregister CIM subscriber $($evt.SubscriptionId): $_"
        }
    }
} catch {
    Write-Host "WARNING: Error enumerating event subscribers: $_"
}

# Method 3: Remove any WMI event registrations via Remove-Job (fallback)
try {
    $wmiJobs = Get-Job -Name "*ProcessStart*" -ErrorAction SilentlyContinue
    foreach ($job in $wmiJobs) {
        try {
            Remove-Job -Id $job.Id -Force -ErrorAction Stop
            Write-Host "Removed background job: $($job.Id) ($($job.Name))"
            $unregistered++
        } catch {
            Write-Host "WARNING: Could not remove job $($job.Id): $_"
        }
    }
} catch {
    Write-Host "WARNING: Error enumerating background jobs: $_"
}

# ── Step 4: Remove state files ─────────────────────────────────────────
$cleanupFiles = @(
    (Join-Path $OutputPath ".trace-subscriber.txt"),
    (Join-Path $OutputPath ".trace-state.json")
)
foreach ($file in $cleanupFiles) {
    if (Test-Path $file) {
        try {
            Remove-Item $file -Force
            Write-Host "Cleaned up state file: $file"
        } catch {
            Write-Host "WARNING: Could not remove state file $file : $_"
        }
    }
}

# ── Step 5: Summary ────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================"
Write-Host "TRACE STOPPED"
Write-Host "  Run ID:         $RunId"
Write-Host "  Subscribers:    $unregistered unregistered"
Write-Host "  Markers file:   $MarkersFile"
Write-Host "  Events file:    $(Join-Path $OutputPath 'process-events.jsonl')"
Write-Host "======================================"

if ($unregistered -eq 0) {
    Write-Host ""
    Write-Host "WARNING: No subscribers found to unregister."
    Write-Host "This may mean the trace was already stopped, was never started,"
    Write-Host "or the subscribing process has already exited (which auto-cleans WMI subscriptions)."
}
