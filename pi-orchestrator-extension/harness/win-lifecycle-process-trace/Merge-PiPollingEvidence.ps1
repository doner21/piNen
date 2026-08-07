<#
.SYNOPSIS
    Merge-PiPollingEvidence.ps1 -- HARNESS ARTIFACT
    Offline correlation engine for polling-mode evidence: joins action markers
    and CIM polling process-creation events, assigns each event to lifecycle
    correlation windows, and emits correlation reports.

.DESCRIPTION
    Reads markers.jsonl and ALL process-events*.jsonl files (including rotated
    files like process-events-20260626-120000.jsonl). Builds correlation windows
    per the planner specification (same window specs as Merge-PiLifecycleEvidence.ps1).
    Correlates each process-start event to the appropriate lifecycle path and window.

    Handles PARTIAL runs gracefully -- missing lifecycle paths are marked as
    "not collected in this run" rather than failing hard.

    Generates:
      - correlation-report.md  : Human-readable summary with per-path stats,
                                 missing marker warnings, uncertainty
                                 annotations, and PASS/FAIL recommendation.
      - correlation-report.json: Machine-readable full correlation output.
      - evidence-index.json    : Index of all evidence files with metadata.

    CAPTURE_SOURCE: Accepts "cim-polling-diff" (polling) records.

    NON-INVASIVE: Read-only analysis of existing trace files. No modification
    of captured evidence.

.PARAMETER RunId
    REQUIRED. The run identifier string.

.PARAMETER OutputPath
    Directory containing markers.jsonl and process-events*.jsonl.
    Defaults to current directory.

.PARAMETER ProcMonCsv
    Optional path to a ProcMon CSV export for additional correlation.
    Requires separate human approval.

.EXAMPLE
    .\Merge-PiPollingEvidence.ps1 -RunId "pi-lifecycle-20260626T120000Z"

.EXAMPLE
    .\Merge-PiPollingEvidence.ps1 -RunId $env:RUN_ID -OutputPath $env:RUN_DIR
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".",

    [Parameter(Mandatory = $false)]
    [string]$ProcMonCsv = ""
)

$ErrorActionPreference = "Continue"

$MarkersFile = Join-Path $OutputPath "markers.jsonl"
$EventsPattern = Join-Path $OutputPath "process-events*.jsonl"
$ReportMd    = Join-Path $OutputPath "correlation-report.md"
$ReportJson  = Join-Path $OutputPath "correlation-report.json"
$IndexFile   = Join-Path $OutputPath "evidence-index.json"

Write-Host "======================================"  -ForegroundColor Cyan
Write-Host "MERGING PI POLLING EVIDENCE"             -ForegroundColor Cyan
Write-Host "  Run ID:    $RunId"                       -ForegroundColor Cyan
Write-Host "  Path:      $OutputPath"                  -ForegroundColor Cyan
Write-Host "  Mode:      Polling (cim-polling-diff)"   -ForegroundColor Cyan
Write-Host "======================================"  -ForegroundColor Cyan

# ── Helper: parse ISO-8601 timestamp to UTC DateTime ───────────────────
function ConvertFrom-Iso8601Utc {
    param([string]$IsoString)
    if (-not $IsoString) { return $null }
    try {
        $dt = [DateTime]::Parse($IsoString, [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor
            [System.Globalization.DateTimeStyles]::AssumeUniversal)
        return $dt
    } catch {
        Write-Host "  WARNING: Could not parse timestamp: '$IsoString'"
        return $null
    }
}

# ── Helper: resolve lifecycle path from marker label ───────────────────
function Get-LifecyclePath {
    param([string]$Label)
    switch -Wildcard ($Label) {
        "COLD_START_*"         { return "cold_start" }
        "OPEN_FROM_TERMINAL_*" { return "open_from_terminal" }
        "RELOAD_*"             { return "reload" }
        "NEW_SESSION_*"        { return "new_session" }
        default                { return "harness" }
    }
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 1: LOAD MARKERS
# ═══════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "[1/5] Loading markers..."
$markersRaw = @()
if (Test-Path $MarkersFile) {
    Get-Content $MarkersFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line) {
            try {
                $m = $line | ConvertFrom-Json
                $utc = ConvertFrom-Iso8601Utc -IsoString $m.timestamp_utc
                if ($utc) {
                    $m | Add-Member -NotePropertyName "_utc" -NotePropertyValue $utc -Force
                }
                $m | Add-Member -NotePropertyName "_lifecycle_path" -NotePropertyValue (Get-LifecyclePath -Label $m.label) -Force
                $markersRaw += $m
            } catch {
                Write-Host "  WARNING: Could not parse marker line: $_"
            }
        }
    }
}

# Sort by UTC timestamp
$markersRaw = $markersRaw | Sort-Object { $_._utc.Ticks }

Write-Host "  Loaded $($markersRaw.Count) markers"

# ═══════════════════════════════════════════════════════════════════════
# STEP 2: LOAD PROCESS EVENTS (ALL process-events*.jsonl files)
# ═══════════════════════════════════════════════════════════════════════
Write-Host "[2/5] Loading process events (all process-events*.jsonl)..."
$eventsRaw = @()

$eventFiles = Get-ChildItem -Path $OutputPath -Filter "process-events*.jsonl" -ErrorAction SilentlyContinue
if (-not $eventFiles) {
    Write-Host "  No process-events*.jsonl files found in $OutputPath"
} else {
    foreach ($ef in $eventFiles) {
        Write-Host "  Reading: $($ef.Name)"
        Get-Content $ef.FullName -Encoding UTF8 | ForEach-Object {
            $line = $_.Trim()
            if ($line) {
                try {
                    $e = $line | ConvertFrom-Json
                    $utc = ConvertFrom-Iso8601Utc -IsoString $e.timestamp_utc
                    if ($utc) {
                        $e | Add-Member -NotePropertyName "_utc" -NotePropertyValue $utc -Force
                    }
                    $eventsRaw += $e
                } catch {
                    Write-Host "  WARNING: Could not parse event line from $($ef.Name): $_"
                }
            }
        }
    }
}

# Sort by UTC timestamp
$eventsRaw = $eventsRaw | Sort-Object { $_._utc.Ticks }

Write-Host "  Loaded $($eventsRaw.Count) process events from $($eventFiles.Count) file(s)"

# ═══════════════════════════════════════════════════════════════════════
# STEP 3: BUILD CORRELATION WINDOWS
# ═══════════════════════════════════════════════════════════════════════
Write-Host "[3/5] Building correlation windows..."

# Planner-specified marker sequences per lifecycle path
$lifecycleMarkerSeq = [ordered]@{
    cold_start = @(
        "COLD_START_BEGIN",
        "COLD_START_FIRST_RENDER",
        "COLD_START_END"
    )
    open_from_terminal = @(
        "OPEN_FROM_TERMINAL_BEGIN",
        "OPEN_FROM_TERMINAL_COMMAND_SENT",
        "OPEN_FROM_TERMINAL_ATTACHED",
        "OPEN_FROM_TERMINAL_END"
    )
    reload = @(
        "RELOAD_BEGIN",
        "RELOAD_TRIGGER_SENT",
        "RELOAD_POST_IDLE",
        "RELOAD_END"
    )
    new_session = @(
        "NEW_SESSION_BEGIN",
        "NEW_SESSION_TRIGGER_SENT",
        "NEW_SESSION_RENDER",
        "NEW_SESSION_END"
    )
}

# Per-path window definitions (same as Merge-PiLifecycleEvidence.ps1)
$windowSpecs = @{
    cold_start = @{
        max_timeout_sec     = 60
        primary_start       = "COLD_START_BEGIN"
        primary_end         = "COLD_START_FIRST_RENDER"
        expanded_start_ofs  = -2
        expanded_end_ofs    = +5
        expanded_end_label  = "COLD_START_END"
    }
    open_from_terminal = @{
        max_timeout_sec     = 45
        primary_start       = "OPEN_FROM_TERMINAL_BEGIN"
        primary_end         = "OPEN_FROM_TERMINAL_ATTACHED"
        expanded_start_ofs  = -2
        expanded_end_ofs    = +5
        expanded_end_label  = "OPEN_FROM_TERMINAL_END"
    }
    reload = @{
        max_timeout_sec     = 90
        primary_start       = "RELOAD_TRIGGER_SENT"
        primary_end         = "RELOAD_POST_IDLE"
        expanded_start_ofs  = -1
        expanded_end_ofs    = +10
        expanded_end_label  = "RELOAD_END"
    }
    new_session = @{
        max_timeout_sec     = 120
        primary_start       = "NEW_SESSION_TRIGGER_SENT"
        primary_end         = "NEW_SESSION_RENDER"
        expanded_start_ofs  = -1
        expanded_end_ofs    = +10
        expanded_end_label  = "NEW_SESSION_END"
    }
}

$correlationWindows = @()
$windowBuildErrors  = @()
$notCollectedPaths  = @()

foreach ($path in $lifecycleMarkerSeq.Keys) {
    $expectedMarkers = $lifecycleMarkerSeq[$path]
    $spec = $windowSpecs[$path]

    # Find markers for this path
    $pathMarkers = $markersRaw | Where-Object { $_.label -in $expectedMarkers } | Sort-Object _utc
    $foundLabels = $pathMarkers | ForEach-Object { $_.label }

    # Check missing markers
    $missingExpected = $expectedMarkers | Where-Object { $_ -notin $foundLabels }

    # Find primary window endpoints
    $primaryStartMarker = $pathMarkers | Where-Object { $_.label -eq $spec.primary_start } | Select-Object -First 1
    $primaryEndMarker   = $pathMarkers | Where-Object { $_.label -eq $spec.primary_end } | Select-Object -First 1
    $expandedEndMarker  = $pathMarkers | Where-Object { $_.label -eq $spec.expanded_end_label } | Select-Object -First 1

    if (-not $primaryStartMarker -or -not $primaryEndMarker) {
        # Partial run -- primary markers not present
        $notCollectedPaths += $path
        $windowBuildErrors += "$path : Cannot build window -- primary markers missing ($($spec.primary_start)=$($null -ne $primaryStartMarker), $($spec.primary_end)=$($null -ne $primaryEndMarker)) -- not collected in this run"
        continue
    }

    # Build core window
    $coreStart = $primaryStartMarker._utc
    $coreEnd   = $primaryEndMarker._utc

    # Build expanded window
    $expandedStart = $coreStart.AddSeconds($spec.expanded_start_ofs)
    if ($expandedEndMarker) {
        $expandedEnd = $expandedEndMarker._utc.AddSeconds($spec.expanded_end_ofs)
    } else {
        $expandedEnd = $coreEnd.AddSeconds($spec.expanded_end_ofs)
    }

    # Timeout check
    $windowDuration = ($expandedEnd - $expandedStart).TotalSeconds
    $timeoutExceeded = $windowDuration -gt $spec.max_timeout_sec

    $window = [PSCustomObject]@{
        lifecycle_path       = $path
        window_name          = "$($spec.primary_start)_to_$($spec.primary_end)"
        core_start           = $coreStart
        core_end             = $coreEnd
        expanded_start       = $expandedStart
        expanded_end         = $expandedEnd
        primary_start_label  = $spec.primary_start
        primary_end_label    = $spec.primary_end
        max_timeout_sec      = $spec.max_timeout_sec
        timeout_exceeded     = $timeoutExceeded
        markers_found        = @($foundLabels)
        markers_missing      = @($missingExpected)
        all_path_markers     = $pathMarkers
    }
    $correlationWindows += $window
}

Write-Host "  Built $($correlationWindows.Count) correlation windows"
if ($notCollectedPaths.Count -gt 0) {
    Write-Host "  Paths NOT collected: $($notCollectedPaths -join ', ')"
}
if ($windowBuildErrors) {
    foreach ($err in $windowBuildErrors) {
        Write-Host "  WARNING: $err"
    }
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 4: CORRELATE EVENTS TO WINDOWS
# ═══════════════════════════════════════════════════════════════════════
Write-Host "[4/5] Correlating events to windows..."

$correlated = @()
$uncorrelated = @()

foreach ($event in $eventsRaw) {
    $evtUtc = $event._utc
    if (-not $evtUtc) {
        $uncorrelated += $event
        continue
    }

    $matched = $false

    foreach ($window in $correlationWindows) {
        if ($evtUtc -ge $window.expanded_start -and $evtUtc -le $window.expanded_end) {
            $inCore = ($evtUtc -ge $window.core_start -and $evtUtc -le $window.core_end)
            $offsetMs = [math]::Round(($evtUtc - $window.core_start).TotalMilliseconds)

            # Populate correlation fields
            $event | Add-Member -NotePropertyName "correlation" -NotePropertyValue ([ordered]@{
                lifecycle_path              = $window.lifecycle_path
                window_name                 = $window.window_name
                offset_ms_from_window_start = $offsetMs
                in_core_window              = $inCore
            }) -Force

            $correlated += $event
            $matched = $true
            break
        }
    }

    if (-not $matched) {
        $event | Add-Member -NotePropertyName "correlation" -NotePropertyValue ([ordered]@{
            lifecycle_path              = "uncorrelated"
            window_name                 = $null
            offset_ms_from_window_start = $null
            in_core_window              = $false
        }) -Force
        $uncorrelated += $event
    }
}

Write-Host "  Correlated: $($correlated.Count) events"
Write-Host "  Uncorrelated: $($uncorrelated.Count) events"

# ═══════════════════════════════════════════════════════════════════════
# STEP 5: GENERATE REPORTS
# ═══════════════════════════════════════════════════════════════════════
Write-Host "[5/5] Generating reports..."

# ── Per-path statistics ────────────────────────────────────────────────
$pathStats = @{}
foreach ($window in $correlationWindows) {
    $path = $window.lifecycle_path
    $inWindow = $correlated | Where-Object { $_.correlation.lifecycle_path -eq $path }
    $inCore   = $inWindow | Where-Object { $_.correlation.in_core_window -eq $true }

    $childProcs = $inCore | ForEach-Object { $_.child_process_name } | Where-Object { $_ } | Select-Object -Unique
    $parentProcs = $inCore | ForEach-Object { $_.parent_process_name } | Where-Object { $_ } | Select-Object -Unique
    $shellEvents = $inCore | Where-Object { $_.shell_indicators.is_shell_process -eq $true }
    $piRelated = $inCore | Where-Object { $_.is_pi_related -eq $true }

    $pathStats[$path] = @{
        window            = $window
        total_in_window   = $inWindow.Count
        total_in_core     = $inCore.Count
        child_processes   = $childProcs
        parent_processes  = $parentProcs
        shell_processes   = $shellEvents | ForEach-Object { "$($_.child_process_name)($($_.child_pid))" }
        pi_related_events = $piRelated.Count
    }
}

# ── Verifier fail-closed analysis ──────────────────────────────────────
$failReasons = @()
$warnings    = @()

# V1: For collected paths only, all required markers present
foreach ($path in $lifecycleMarkerSeq.Keys) {
    if ($path -in $notCollectedPaths) { continue }
    $expectedMarkers = $lifecycleMarkerSeq[$path]
    $pathMarkers     = $markersRaw | Where-Object { $_.label -in $expectedMarkers }
    $foundLabels     = $pathMarkers | ForEach-Object { $_.label }
    $missing         = $expectedMarkers | Where-Object { $_ -notin $foundLabels }
    if ($missing) {
        $failReasons += "V1-MISSING-MARKERS: $path missing: $($missing -join ', ')"
    }
}

# V2: Timestamp validation
$badTimestampMarkers = $markersRaw | Where-Object { -not $_._utc }
if ($badTimestampMarkers.Count -gt 0) {
    $failReasons += "V2-BAD-TIMESTAMPS: $($badTimestampMarkers.Count) markers have unparseable timestamps"
}

# V3: Process events must have timestamps
$badTimestampEvents = $eventsRaw | Where-Object { -not $_._utc }
if ($badTimestampEvents.Count -gt 0) {
    $failReasons += "V3-BAD-EVENT-TIMESTAMPS: $($badTimestampEvents.Count) events have unparseable timestamps"
}

# V4: Monotonic timestamps within each collected lifecycle path
foreach ($path in $lifecycleMarkerSeq.Keys) {
    if ($path -in $notCollectedPaths) { continue }
    $expectedMarkers = $lifecycleMarkerSeq[$path]
    $pathMarkers = $markersRaw | Where-Object { $_.label -in $expectedMarkers } | Sort-Object _utc
    $prev = $null
    foreach ($m in $pathMarkers) {
        if ($prev -and $m._utc -le $prev._utc) {
            $failReasons += "V4-NONMONOTONIC: $path : $($prev.label) ($($prev.timestamp_utc)) >= $($m.label) ($($m.timestamp_utc))"
        }
        $prev = $m
    }
}

# V5: Each claimed lifecycle window must have supporting process events
foreach ($window in $correlationWindows) {
    $path = $window.lifecycle_path
    $stats = $pathStats[$path]
    if ($stats.total_in_core -eq 0) {
        $warnings += "V5-NO-CORE-EVENTS: $path has 0 process events in core window. May indicate: (a) no child processes spawned, (b) processes created and exited between polling intervals, or (c) marker timing misalignment. NOTE: Polling mode may miss short-lived processes."
    }
}

# V6: Collection start must be before first lifecycle BEGIN marker (for collected paths)
$firstBegin = $markersRaw | Where-Object { $_.label -match "_BEGIN$" } | Sort-Object _utc | Select-Object -First 1
$collectionStart = $markersRaw | Where-Object { $_.label -eq "COLLECTION_START" } | Select-Object -First 1
if ($collectionStart -and $firstBegin) {
    if ($collectionStart._utc -gt $firstBegin._utc) {
        $failReasons += "V6-COLLECTION-AFTER-BEGIN: COLLECTION_START ($($collectionStart.timestamp_utc)) is after $($firstBegin.label) ($($firstBegin.timestamp_utc))"
    }
}

# V7: Correlated events must have child PID present
$eventsWithoutPid = $correlated | Where-Object { -not $_.child_pid -or $_.child_pid -eq 0 }
if ($eventsWithoutPid.Count -gt 0) {
    $failReasons += "V7-MISSING-CHILD-PID: $($eventsWithoutPid.Count) correlated events lack valid child_pid"
}

# V8: Inconsistent run_id
$badRunId = @()
$badRunId += ($markersRaw | Where-Object { $_.run_id -ne $RunId })
$badRunId += ($eventsRaw | Where-Object { $_.run_id -ne $RunId })
if ($badRunId.Count -gt 0) {
    $failReasons += "V8-RUNID-MISMATCH: $($badRunId.Count) records have run_id != '$RunId'"
}

# V9: Max timeout exceeded (for collected paths)
foreach ($window in $correlationWindows) {
    if ($window.timeout_exceeded) {
        $failReasons += "V9-TIMEOUT: $($window.lifecycle_path) window exceeded max timeout ($($window.max_timeout_sec)s)"
    }
}

# V10: Shell PID mismatch for open_from_terminal
$terminalMarkers = $markersRaw | Where-Object { $_.label -match "OPEN_FROM_TERMINAL" }
$claimedShellPids = $terminalMarkers | ForEach-Object {
    if ($_.metadata -and $_.metadata.shell_pid) { $_.metadata.shell_pid }
} | Select-Object -Unique
foreach ($claimedPid in $claimedShellPids) {
    $matchedInEvents = $eventsRaw | Where-Object {
        $_.parent_pid -eq $claimedPid -or $_.child_pid -eq $claimedPid
    }
    if (-not $matchedInEvents) {
        $warnings += "V10-SHELL-PID-NOT-OBSERVED: Claimed shell PID $claimedPid not found in process event stream"
    }
}

# V11: Check capture source is polling-mode
$nonPollingEvents = $eventsRaw | Where-Object { $_.capture_source -ne "cim-polling-diff" -and $_.capture_source -ne $null }
if ($nonPollingEvents.Count -gt 0) {
    $warnings += "V11-NON-POLLING-CAPTURE: $($nonPollingEvents.Count) events from non-polling capture source ($(($nonPollingEvents | ForEach-Object { $_.capture_source } | Select-Object -Unique) -join ', ')) -- mixed capture sources detected"
}

# V12 (NEW): Polling-specific check -- warn about potential missed processes
# No hard fail, but note the limitation
if ($eventsRaw.Count -gt 0) {
    $warnings += "V12-POLLING-LIMITATION: Polling mode may miss processes that start AND exit within a single polling interval. Detection accuracy is limited by poll interval."
}

# Final verdict
$verdict = if ($failReasons.Count -eq 0) { "PASS" } else { "FAIL" }

# ═══════════════════════════════════════════════════════════════════════
# 5a. correlation-report.md
# ═══════════════════════════════════════════════════════════════════════
$mdLines = @()
$mdLines += "# Pi Lifecycle Process Trace -- Correlation Report (Polling Mode)"
$mdLines += ""
$mdLines += "| Field | Value |"
$mdLines += "|---|---|"
$mdLines += "| **Run ID** | $RunId |"
$mdLines += "| **Generated** | $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz') |"
$mdLines += "| **Verdict** | **$verdict** |"
$mdLines += "| **Capture Mode** | cim-polling-diff (non-admin) |"
$mdLines += "| **Harness** | HARNESS ARTIFACT -- non-invasive diagnostic tooling |"
$mdLines += ""
$mdLines += "---"
$mdLines += ""

# Overall stats
$mdLines += "## Overall Statistics"
$mdLines += ""
$mdLines += "| Metric | Value |"
$mdLines += "|---|---|"
$mdLines += "| Total markers | $($markersRaw.Count) |"
$mdLines += "| Total process events | $($eventsRaw.Count) |"
$mdLines += "| Correlated events | $($correlated.Count) |"
$mdLines += "| Uncorrelated events | $($uncorrelated.Count) |"
$mdLines += "| Correlation windows | $($correlationWindows.Count) |"
$mdLines += "| Paths NOT collected | $($notCollectedPaths.Count) ($($notCollectedPaths -join ', ')) |"

$collStart = $markersRaw | Where-Object { $_.label -eq "COLLECTION_START" } | Select-Object -First 1
$collEnd   = $markersRaw | Where-Object { $_.label -eq "COLLECTION_END" -or $_.label -eq "TRACE_STOPPED" } | Select-Object -First 1
if ($collStart) { $mdLines += "| Collection start | $($collStart.timestamp_utc) |" }
if ($collEnd)   { $mdLines += "| Collection end   | $($collEnd.timestamp_utc) |" }
$mdLines += ""

# Verdict section
$mdLines += "## Verifier Verdict: **$verdict**"
$mdLines += ""
if ($failReasons.Count -gt 0) {
    $mdLines += "### Failure Reasons"
    $mdLines += ""
    foreach ($reason in $failReasons) {
        $mdLines += "- FAIL: $reason"
    }
    $mdLines += ""
}
if ($warnings.Count -gt 0) {
    $mdLines += "### Warnings / Soft Anomalies"
    $mdLines += ""
    foreach ($w in $warnings) {
        $mdLines += "- WARNING: $w"
    }
    $mdLines += ""
}

# Not-collected paths section
if ($notCollectedPaths.Count -gt 0) {
    $displayNotCollected = foreach ($p in $notCollectedPaths) {
        switch ($p) {
            "cold_start"         { "Cold Start" }
            "open_from_terminal" { "Open-from-Terminal" }
            "reload"             { "Runtime Reload" }
            "new_session"        { "New Session" }
            default              { $p }
        }
    }
    $mdLines += "### Not Collected in This Run"
    $mdLines += ""
    $mdLines += "The following lifecycle paths were not collected in this run and are excluded from correlation:"
    $mdLines += ""
    foreach ($n in $displayNotCollected) {
        $mdLines += "- **$n**"
    }
    $mdLines += ""
}

# Per-path sections
$mdLines += "---"
$mdLines += ""
$mdLines += "## Per-Lifecycle-Path Results"
$mdLines += ""

foreach ($path in @("cold_start", "open_from_terminal", "reload", "new_session")) {
    $displayName = switch ($path) {
        "cold_start"         { "Cold Start" }
        "open_from_terminal" { "Open-from-Terminal" }
        "reload"             { "Runtime Reload" }
        "new_session"        { "New Session" }
    }

    if ($path -in $notCollectedPaths) {
        $mdLines += "### $displayName -- NOT COLLECTED"
        $mdLines += ""
        $mdLines += "No markers for this lifecycle path were found. This path was not exercised in this run."
        $mdLines += ""
        continue
    }

    $stats = $pathStats[$path]
    if (-not $stats) { continue }
    $w = $stats.window

    $mdLines += "### $displayName"
    $mdLines += ""

    if ($w.markers_missing -and $w.markers_missing.Count -gt 0) {
        $mdLines += "**MISSING MARKERS:** $($w.markers_missing -join ', ')"
        $mdLines += ""
    }

    $mdLines += "| Metric | Value |"
    $mdLines += "|---|---|"
    $mdLines += "| Window name | $($w.window_name) |"
    $mdLines += "| Core start (UTC) | $($w.core_start.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $mdLines += "| Core end (UTC) | $($w.core_end.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $mdLines += "| Expanded start (UTC) | $($w.expanded_start.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $mdLines += "| Expanded end (UTC) | $($w.expanded_end.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $mdLines += "| Core window duration | $([math]::Round(($w.core_end - $w.core_start).TotalMilliseconds)) ms |"
    $mdLines += "| Max timeout | $($w.max_timeout_sec)s |"
    $mdLines += "| Timeout exceeded | $(if ($w.timeout_exceeded) { 'YES' } else { 'OK' }) |"
    $mdLines += "| Events in expanded window | $($stats.total_in_window) |"
    $mdLines += "| Events in core window | $($stats.total_in_core) |"
    $mdLines += "| Pi-related events | $($stats.pi_related_events) |"
    $mdLines += "| Markers present | $($w.markers_found.Count)/$($lifecycleMarkerSeq[$path].Count) |"

    if ($stats.child_processes -and $stats.child_processes.Count -gt 0) {
        $mdLines += "| Child processes observed | $($stats.child_processes -join ', ') |"
    } else {
        $mdLines += "| Child processes observed | (none) |"
    }

    if ($stats.parent_processes -and $stats.parent_processes.Count -gt 0) {
        $mdLines += "| Parent processes observed | $($stats.parent_processes -join ', ') |"
    }

    if ($stats.shell_processes -and $stats.shell_processes.Count -gt 0) {
        $mdLines += "| Shell processes | $($stats.shell_processes -join ', ') |"
    }

    $mdLines += ""

    # Uncertainty annotations
    $mdLines += "**Uncertainty / HYPOTHESIS annotations:**"
    $mdLines += ""
    if ($stats.total_in_core -eq 0) {
        $mdLines += "- **HYPOTHESIS:** No process-creation events captured in core window. Possible explanations: (a) no child processes spawned, (b) child processes created and exited within polling interval, (c) marker timing misaligned with actual process creation."
    } else {
        $mdLines += "- Process events observed. See child processes for shell/console candidates."
    }
    $mdLines += "- **HYPOTHESIS:** CIM polling cannot observe process creation flags (CREATE_NO_WINDOW, etc.) -- window visibility claims are INFERENCE only."
    $mdLines += "- **HYPOTHESIS:** Console-flash determination is speculative unless backed by ETW, UI automation, or video evidence."
    $mdLines += "- **HYPOTHESIS:** Polling mode may miss short-lived processes (< polling interval). Timestamps have +/- interval accuracy."
    $mdLines += ""
}

# Uncorrelated events
$mdLines += "---"
$mdLines += ""
$mdLines += "## Unmatched Events (Outside All Windows)"
$mdLines += ""
$mdLines += "Events not assigned to any lifecycle correlation window: **$($uncorrelated.Count)**"
$mdLines += ""
if ($uncorrelated.Count -gt 0) {
    $mdLines += "| Time (UTC) | PID | Child Process | Parent Process | Pi-Related |"
    $mdLines += "|---|---|---|---|---|"
    foreach ($ue in $uncorrelated | Sort-Object _utc) {
        $isPi = if ($ue.is_pi_related) { "Yes" } else { "" }
        $mdLines += "| $($ue.timestamp_utc) | $($ue.child_pid) | $($ue.child_process_name) | $($ue.parent_process_name) | $isPi |"
    }
    $mdLines += ""
}

# Limitations section
$mdLines += "---"
$mdLines += ""
$mdLines += "## Polling Mode Limitations"
$mdLines += ""
$mdLines += "This trace was captured using cim-polling-diff (non-admin polling mode). Key differences vs WMI event-based capture:"
$mdLines += ""
$mdLines += "| Aspect | Polling (this run) | WMI Events (admin) |"
$mdLines += "|---|---|---|"
$mdLines += "| Admin required | No | Yes (Event Log Readers) |"
$mdLines += "| Detection method | PID diff between snapshots | Kernel event subscription |"
$mdLines += "| Missed processes | Processes that start AND exit within polling interval | None (captures all StartTrace events) |"
$mdLines += "| Timestamp accuracy | +/- polling interval from actual creation | Exact creation timestamp |"
$mdLines += "| Command line capture | Only if process still alive at poll time | From WMI enrichment (also race-prone) |"
$mdLines += "| Parent lineage | Query at poll time (process alive) | Query at event time (process may have exited) |"
$mdLines += "| Raw kernel event | Not available | Win32_ProcessStartTrace fields available |"
$mdLines += "| Cross-session detection | Same-session only (default) | All sessions (with Event Log Readers) |"
$mdLines += "| Stop mechanism | Kill listener process via PID | Unregister WMI subscription (session-scoped) |"
$mdLines += ""

# Collection metadata
$mdLines += "---"
$mdLines += ""
$mdLines += "## Collection Metadata"
$mdLines += ""
$mdLines += "| Item | Value |"
$mdLines += "|---|---|"
$mdLines += "| Evidence source | CIM Win32_Process polling diff |"
$mdLines += "| Harness type | Non-invasive, user-scoped, removable |"
$mdLines += "| Elevation required | No |"
$mdLines += "| ETW/ProcMon used | No |"
$mdLines += "| Pi source modified | No |"
$mdLines += "| Registry modified | No |"
$mdLines += "| Persistent hooks installed | No |"
$mdLines += "| Service installed | No |"
$mdLines += "| Scheduled task created | No |"
$mdLines += ""

# Write markdown report
$mdLines -join "`n" | Out-File -FilePath $ReportMd -Encoding UTF8
Write-Host "  Wrote: $ReportMd"

# ═══════════════════════════════════════════════════════════════════════
# 5b. correlation-report.json
# ═══════════════════════════════════════════════════════════════════════
$reportJsonObj = [ordered]@{
    run_id                  = $RunId
    generated_at            = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz')
    capture_mode            = "cim-polling-diff"
    verdict                 = $verdict
    total_markers           = $markersRaw.Count
    total_process_events    = $eventsRaw.Count
    correlated_events       = $correlated.Count
    uncorrelated_events     = $uncorrelated.Count
    correlation_windows     = $correlationWindows.Count
    not_collected_paths     = @($notCollectedPaths)
    fail_reasons            = @($failReasons)
    warnings                = @($warnings)
    collection_start_utc    = if ($collStart) { $collStart.timestamp_utc } else { $null }
    collection_end_utc      = if ($collEnd)   { $collEnd.timestamp_utc }   else { $null }
    lifecycle_paths         = [ordered]@{}
}

foreach ($path in @("cold_start", "open_from_terminal", "reload", "new_session")) {
    if ($path -in $notCollectedPaths) {
        $reportJsonObj.lifecycle_paths[$path] = [ordered]@{
            status = "not_collected"
            note   = "This lifecycle path was not exercised in this run"
        }
        continue
    }

    $stats = $pathStats[$path]
    if (-not $stats) { continue }
    $w = $stats.window

    $reportJsonObj.lifecycle_paths[$path] = [ordered]@{
        status                 = "collected"
        window_name            = $w.window_name
        core_start_utc         = $w.core_start.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        core_end_utc           = $w.core_end.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        expanded_start_utc     = $w.expanded_start.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        expanded_end_utc       = $w.expanded_end.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        core_duration_ms       = [math]::Round(($w.core_end - $w.core_start).TotalMilliseconds)
        max_timeout_sec        = $w.max_timeout_sec
        timeout_exceeded       = $w.timeout_exceeded
        markers_found          = @($w.markers_found)
        markers_missing        = @($w.markers_missing)
        events_in_expanded     = $stats.total_in_window
        events_in_core         = $stats.total_in_core
        pi_related_events      = $stats.pi_related_events
        child_processes        = @($stats.child_processes)
        parent_processes       = @($stats.parent_processes)
        shell_processes        = @($stats.shell_processes)
    }
}

$reportJsonObj | ConvertTo-Json -Depth 6 | Out-File -FilePath $ReportJson -Encoding UTF8
Write-Host "  Wrote: $ReportJson"

# ═══════════════════════════════════════════════════════════════════════
# 5c. evidence-index.json
# ═══════════════════════════════════════════════════════════════════════
$evidenceFiles = @(
    @{ file = "markers.jsonl";           role = "action_markers";        record_count = $markersRaw.Count }
    @{ file = "process-events.jsonl";    role = "process_start_events";  record_count = $eventsRaw.Count }
    @{ file = "trace-collector.log";     role = "harness_operational_log"; record_count = $null }
    @{ file = "correlation-report.md";   role = "human_readable_report"; record_count = $null }
    @{ file = "correlation-report.json"; role = "machine_readable_report"; record_count = $null }
    @{ file = "evidence-index.json";     role = "this_index";            record_count = $null }
)

$index = [ordered]@{
    run_id              = $RunId
    generated_at        = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz')
    capture_mode        = "cim-polling-diff"
    harness_type        = "HARNESS_ARTIFACT -- non-invasive diagnostic tooling"
    evidence_files      = @()
}

# Add rotated event files to the index
$rotatedFiles = Get-ChildItem -Path $OutputPath -Filter "process-events-*.jsonl" -ErrorAction SilentlyContinue
foreach ($rf in $rotatedFiles) {
    $evidenceFiles += @{ file = $rf.Name; role = "process_start_events_rotated"; record_count = $null }
}

foreach ($ef in $evidenceFiles) {
    $fullPath = Join-Path $OutputPath $ef.file
    $exists = Test-Path $fullPath
    $entry = [ordered]@{
        file           = $ef.file
        role           = $ef.role
        exists         = $exists
        size_bytes     = if ($exists) { (Get-Item $fullPath).Length } else { $null }
        record_count   = $ef.record_count
    }
    $index.evidence_files += $entry
}

$index | ConvertTo-Json -Depth 3 | Out-File -FilePath $IndexFile -Encoding UTF8
Write-Host "  Wrote: $IndexFile"

# ── Console summary ────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================"  -ForegroundColor Green
Write-Host "CORRELATION COMPLETE (POLLING MODE)"      -ForegroundColor Green
Write-Host "  Verdict:       $verdict"
Write-Host "  Fail reasons:  $($failReasons.Count)"
Write-Host "  Warnings:      $($warnings.Count)"
Write-Host "  Not collected: $($notCollectedPaths -join ', ')"
Write-Host "  Report (md):   $ReportMd"
Write-Host "  Report (json): $ReportJson"
Write-Host "  Index:         $IndexFile"
Write-Host "======================================"  -ForegroundColor Green

if ($verdict -eq "FAIL") {
    Write-Host ""
    Write-Host "VERIFIER FAIL-CLOSED. Review correlation-report.md for failure details."
    Write-Host "Do NOT claim live evidence unless all failures are resolved."
}
