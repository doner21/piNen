<#
.SYNOPSIS
    Correlate-ProcessTrace.ps1 — HARNESS ARTIFACT
    Joins action markers and process-creation events, assigns each event to
    a lifecycle correlation window, and emits correlated evidence.

.DESCRIPTION
    Reads markers.jsonl and process-events.jsonl, parses timestamps, builds
    correlation windows per the planner's specification, and assigns each
    process event to windows it falls within.

    Outputs:
      - correlated-events.jsonl   : process events with correlation fields populated
      - correlation-summary.md    : human-readable summary with per-path stats,
                                    missing marker warnings, uncertainty
                                    annotations, and PASS/FAIL recommendation.

    NON-INVASIVE: Read-only analysis of existing trace files.

.PARAMETER RunId
    REQUIRED. The run identifier string.

.PARAMETER OutputPath
    Directory containing markers.jsonl and process-events.jsonl.
    Defaults to current directory.

.EXAMPLE
    .\Correlate-ProcessTrace.ps1 -RunId "win-lifecycle-process-trace-20260626-123456"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = "."
)

$ErrorActionPreference = "Continue"

$MarkersFile  = Join-Path $OutputPath "markers.jsonl"
$EventsFile   = Join-Path $OutputPath "process-events.jsonl"
$CorrFile     = Join-Path $OutputPath "correlated-events.jsonl"
$SummaryFile  = Join-Path $OutputPath "correlation-summary.md"

Write-Host "======================================"
Write-Host "CORRELATE PROCESS TRACE"
Write-Host "  Run ID:  $RunId"
Write-Host "  Path:    $OutputPath"
Write-Host "======================================"

# ── Helper: parse ISO-8601 with timezone to DateTime ───────────────────
function ConvertFrom-Iso8601 {
    param([string]$IsoString)
    if (-not $IsoString) { return $null }
    try {
        return [DateTime]::Parse($IsoString, [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor
            [System.Globalization.DateTimeStyles]::AssumeUniversal)
    } catch {
        Write-Host "WARNING: Could not parse timestamp: $IsoString"
        return $null
    }
}

# ── Step 1: Load markers ───────────────────────────────────────────────
Write-Host ""
Write-Host "[1/5] Loading markers..."
$markers = @()
if (Test-Path $MarkersFile) {
    Get-Content $MarkersFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line) {
            try {
                $m = $line | ConvertFrom-Json
                $m.PSObject.TypeNames.Insert(0, "TraceMarker")
                $m | Add-Member -NotePropertyName "_parsed_utc" -NotePropertyValue (ConvertFrom-Iso8601 $m.timestamp_utc)
                $markers += $m
            } catch {
                Write-Host "WARNING: Could not parse marker line: $_"
            }
        }
    }
}
Write-Host "  Loaded $($markers.Count) markers"

# ── Step 2: Load process events ────────────────────────────────────────
Write-Host "[2/5] Loading process events..."
$events = @()
if (Test-Path $EventsFile) {
    Get-Content $EventsFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line) {
            try {
                $e = $line | ConvertFrom-Json
                $e.PSObject.TypeNames.Insert(0, "ProcessEvent")
                $e | Add-Member -NotePropertyName "_parsed_utc" -NotePropertyValue (ConvertFrom-Iso8601 $e.event_time_utc)
                $events += $e
            } catch {
                Write-Host "WARNING: Could not parse event line: $_"
            }
        }
    }
}
Write-Host "  Loaded $($events.Count) process events"

# ── Step 3: Define correlation windows ─────────────────────────────────
Write-Host "[3/5] Building correlation windows..."

# Map marker names to positions within each lifecycle path
$lifecycleMarkerSequence = @{
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
        "RELOAD_COMMAND_SENT",
        "RELOAD_POST_RENDER_IDLE",
        "RELOAD_END"
    )
    new_session = @(
        "NEW_SESSION_BEGIN",
        "NEW_SESSION_COMMAND_SENT",
        "NEW_SESSION_RENDERED",
        "NEW_SESSION_END"
    )
}

# Build correlation windows per the planner's spec
$correlationWindows = @()
$windowDefs = @()

# For each lifecycle path, look up its markers and construct windows
foreach ($path in $lifecycleMarkerSequence.Keys) {
    $seq = $lifecycleMarkerSequence[$path]
    $pathMarkers = $markers | Where-Object { $_.lifecycle_path -eq $path } | Sort-Object _parsed_utc

    # Validate marker presence
    $foundNames = $pathMarkers | ForEach-Object { $_.marker_name }
    $missing = $seq | Where-Object { $_ -notin $foundNames }
    if ($missing) {
        Write-Host "  WARNING: $path missing markers: $($missing -join ', ')"
    }

    # Define windows based on path type
    switch ($path) {
        "cold_start" {
            $begin   = $pathMarkers | Where-Object { $_.marker_name -eq "COLD_START_BEGIN" } | Select-Object -First 1
            $render  = $pathMarkers | Where-Object { $_.marker_name -eq "COLD_START_FIRST_RENDER" } | Select-Object -First 1
            $end     = $pathMarkers | Where-Object { $_.marker_name -eq "COLD_START_END" } | Select-Object -First 1

            if ($begin -and $render) {
                $windowStart = $begin._parsed_utc.AddSeconds(-2)
                $coreStart   = $begin._parsed_utc
                $coreEnd     = $render._parsed_utc
                $windowEnd   = $render._parsed_utc.AddSeconds(5)

                $windowDefs += [PSCustomObject]@{
                    lifecycle_path = $path
                    window_name    = "COLD_START_BEGIN_to_COLD_START_FIRST_RENDER"
                    window_start   = $windowStart
                    core_start     = $coreStart
                    core_end       = $coreEnd
                    window_end     = $windowEnd
                    markers_found  = $foundNames
                    markers_missing = $missing
                }
            }
        }
        "open_from_terminal" {
            $begin   = $pathMarkers | Where-Object { $_.marker_name -eq "OPEN_FROM_TERMINAL_BEGIN" } | Select-Object -First 1
            $cmdSent = $pathMarkers | Where-Object { $_.marker_name -eq "OPEN_FROM_TERMINAL_COMMAND_SENT" } | Select-Object -First 1
            $attached = $pathMarkers | Where-Object { $_.marker_name -eq "OPEN_FROM_TERMINAL_ATTACHED" } | Select-Object -First 1
            $end     = $pathMarkers | Where-Object { $_.marker_name -eq "OPEN_FROM_TERMINAL_END" } | Select-Object -First 1

            if ($begin -and $attached) {
                $windowStart = $begin._parsed_utc.AddSeconds(-2)
                $coreStart   = if ($cmdSent) { $cmdSent._parsed_utc } else { $begin._parsed_utc }
                $coreEnd     = $attached._parsed_utc
                $windowEnd   = $attached._parsed_utc.AddSeconds(5)

                $windowDefs += [PSCustomObject]@{
                    lifecycle_path = $path
                    window_name    = "OPEN_FROM_TERMINAL_COMMAND_SENT_to_OPEN_FROM_TERMINAL_ATTACHED"
                    window_start   = $windowStart
                    core_start     = $coreStart
                    core_end       = $coreEnd
                    window_end     = $windowEnd
                    markers_found  = $foundNames
                    markers_missing = $missing
                }
            }
        }
        "reload" {
            $begin   = $pathMarkers | Where-Object { $_.marker_name -eq "RELOAD_BEGIN" } | Select-Object -First 1
            $cmdSent = $pathMarkers | Where-Object { $_.marker_name -eq "RELOAD_COMMAND_SENT" } | Select-Object -First 1
            $idle    = $pathMarkers | Where-Object { $_.marker_name -eq "RELOAD_POST_RENDER_IDLE" } | Select-Object -First 1
            $end     = $pathMarkers | Where-Object { $_.marker_name -eq "RELOAD_END" } | Select-Object -First 1

            if ($begin -and $idle) {
                $windowStart = $begin._parsed_utc.AddSeconds(-2)
                $coreStart   = if ($cmdSent) { $cmdSent._parsed_utc } else { $begin._parsed_utc }
                $coreEnd     = $idle._parsed_utc
                $windowEnd   = $idle._parsed_utc.AddSeconds(5)

                $windowDefs += [PSCustomObject]@{
                    lifecycle_path = $path
                    window_name    = "RELOAD_COMMAND_SENT_to_RELOAD_POST_RENDER_IDLE"
                    window_start   = $windowStart
                    core_start     = $coreStart
                    core_end       = $coreEnd
                    window_end     = $windowEnd
                    markers_found  = $foundNames
                    markers_missing = $missing
                }
            }
        }
        "new_session" {
            $begin   = $pathMarkers | Where-Object { $_.marker_name -eq "NEW_SESSION_BEGIN" } | Select-Object -First 1
            $cmdSent = $pathMarkers | Where-Object { $_.marker_name -eq "NEW_SESSION_COMMAND_SENT" } | Select-Object -First 1
            $rendered = $pathMarkers | Where-Object { $_.marker_name -eq "NEW_SESSION_RENDERED" } | Select-Object -First 1
            $end     = $pathMarkers | Where-Object { $_.marker_name -eq "NEW_SESSION_END" } | Select-Object -First 1

            if ($begin -and $rendered) {
                $windowStart = $begin._parsed_utc.AddSeconds(-2)
                $coreStart   = if ($cmdSent) { $cmdSent._parsed_utc } else { $begin._parsed_utc }
                $coreEnd     = $rendered._parsed_utc
                $windowEnd   = $rendered._parsed_utc.AddSeconds(5)

                $windowDefs += [PSCustomObject]@{
                    lifecycle_path = $path
                    window_name    = "NEW_SESSION_COMMAND_SENT_to_NEW_SESSION_RENDERED"
                    window_start   = $windowStart
                    core_start     = $coreStart
                    core_end       = $coreEnd
                    window_end     = $windowEnd
                    markers_found  = $foundNames
                    markers_missing = $missing
                }
            }
        }
    }
}

Write-Host "  Built $($windowDefs.Count) correlation windows"

# ── Step 4: Correlate events to windows ────────────────────────────────
Write-Host "[4/5] Correlating events to windows..."

$correlatedEventCount = 0
$unmatchedEvents = @()
$allCorrelated = @()

foreach ($event in $events) {
    $evtUtc = $event._parsed_utc
    if (-not $evtUtc) { continue }

    $matched = $false

    foreach ($window in $windowDefs) {
        if ($evtUtc -ge $window.window_start -and $evtUtc -le $window.window_end) {
            $inCore = ($evtUtc -ge $window.core_start -and $evtUtc -le $window.core_end)
            $offsetMs = [math]::Round(($evtUtc - $window.core_start).TotalMilliseconds)

            # Populate correlation fields
            $event.correlation = @{
                lifecycle_path              = $window.lifecycle_path
                window_name                 = $window.window_name
                offset_ms_from_window_start = $offsetMs
                in_core_window              = $inCore
            }

            $allCorrelated += $event
            $correlatedEventCount++
            $matched = $true
            break
        }
    }

    if (-not $matched) {
        $event.correlation = @{
            lifecycle_path              = "uncorrelated"
            window_name                 = $null
            offset_ms_from_window_start = $null
            in_core_window              = $false
        }
        $unmatchedEvents += $event
        $allCorrelated += $event
    }
}

Write-Host "  Correlated: $correlatedEventCount events"
Write-Host "  Unmatched:  $($unmatchedEvents.Count) events"

# ── Step 5: Write correlated output ────────────────────────────────────
Write-Host "[5/5] Writing output files..."

# 5a. Write correlated events JSONL
$allCorrelated | ForEach-Object {
    $json = $_ | ConvertTo-Json -Depth 6 -Compress
    Add-Content -Path $CorrFile -Value $json -Encoding UTF8
}
Write-Host "  Wrote: $CorrFile"

# 5b. Generate correlation summary markdown
$collectionStart = $markers | Where-Object { $_.marker_name -eq "COLLECTION_START" } | Select-Object -First 1
$collectionEnd   = $markers | Where-Object { $_.marker_name -eq "COLLECTION_END" }   | Select-Object -First 1

# Collect per-path statistics
$pathStats = @{}
foreach ($wd in $windowDefs) {
    $path = $wd.lifecycle_path
    $inWindow = $allCorrelated | Where-Object { $_.correlation.lifecycle_path -eq $path }
    $inCore   = $inWindow | Where-Object { $_.correlation.in_core_window -eq $true }

    $childProcs = $inCore | ForEach-Object { $_.child_process_name } | Select-Object -Unique
    $parentProcs = $inCore | ForEach-Object { $_.parent_process_name } | Where-Object { $_ } | Select-Object -Unique

    $pathStats[$path] = @{
        window           = $wd
        total_in_window  = $inWindow.Count
        total_in_core    = $inCore.Count
        child_processes  = $childProcs
        parent_processes = $parentProcs
    }
}

# Build the summary
$summaryLines = @()
$summaryLines += "# Correlation Summary — Win Lifecycle Process Trace"
$summaryLines += ""
$summaryLines += "**Run ID:** $RunId"
$summaryLines += "**Generated:** $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz')"
$summaryLines += "**Harness:** HARNESS ARTIFACT — non-invasive diagnostic tooling"
$summaryLines += ""

# Overall stats
$summaryLines += "## Overall Statistics"
$summaryLines += ""
$summaryLines += "| Metric | Value |"
$summaryLines += "|---|---|"
$summaryLines += "| Total markers | $($markers.Count) |"
$summaryLines += "| Total process events | $($events.Count) |"
$summaryLines += "| Correlated events | $correlatedEventCount |"
$summaryLines += "| Unmatched events | $($unmatchedEvents.Count) |"
$summaryLines += "| Correlation windows | $($windowDefs.Count) |"
if ($collectionStart) { $summaryLines += "| Collection start | $($collectionStart.timestamp_utc) |" }
if ($collectionEnd)   { $summaryLines += "| Collection end   | $($collectionEnd.timestamp_utc) |" }
$summaryLines += ""

# Per-path sections
$summaryLines += "## Per-Lifecycle-Path Results"
$summaryLines += ""

foreach ($path in @("cold_start", "open_from_terminal", "reload", "new_session")) {
    $stats = $pathStats[$path]
    $wd = $stats.window

    $summaryLines += "### $($path -replace '_', ' ' | ForEach-Object { (Get-Culture).TextInfo.ToTitleCase($_) })"
    $summaryLines += ""

    if ($wd.markers_missing -and $wd.markers_missing.Count -gt 0) {
        $summaryLines += "**⚠️ WARNING: Missing markers:** $($wd.markers_missing -join ', ')"
        $summaryLines += ""
    }

    $summaryLines += "| Metric | Value |"
    $summaryLines += "|---|---|"
    $summaryLines += "| Window name | $($wd.window_name) |"
    $summaryLines += "| Window start | $($wd.window_start.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $summaryLines += "| Core start | $($wd.core_start.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $summaryLines += "| Core end | $($wd.core_end.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $summaryLines += "| Window end | $($wd.window_end.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) |"
    $summaryLines += "| Events in full window | $($stats.total_in_window) |"
    $summaryLines += "| Events in core window | $($stats.total_in_core) |"
    $summaryLines += "| Markers found | $($wd.markers_found.Count)/$($lifecycleMarkerSequence[$path].Count) |"

    if ($stats.child_processes) {
        $summaryLines += "| Child processes observed | $($stats.child_processes -join ', ') |"
    } else {
        $summaryLines += "| Child processes observed | (none) |"
    }

    if ($stats.parent_processes) {
        $summaryLines += "| Parent processes observed | $($stats.parent_processes -join ', ') |"
    }

    $summaryLines += ""

    # Uncertainty annotations
    $summaryLines += "**Uncertainty annotations:**"
    $summaryLines += ""
    if ($stats.total_in_core -eq 0) {
        $summaryLines += "- **HYPOTHESIS:** No process-creation events captured in core window. Possible explanations: (a) no child processes spawned, (b) child processes created/exited before WMI could query command line, (c) marker timing misaligned with actual process creation."
    }
    $summaryLines += "- WMI cannot observe process creation flags (CREATE_NO_WINDOW, etc.) — window visibility is **HYPOTHESIS** only."
    $summaryLines += "- Console-flash determination is **HYPOTHESIS** unless backed by ETW, UI automation, or video evidence."
    $summaryLines += ""
}

# Unmatched events section
$summaryLines += "## Unmatched Events"
$summaryLines += ""
$summaryLines += "Events not assigned to any lifecycle window: **$($unmatchedEvents.Count)**"
$summaryLines += ""
if ($unmatchedEvents.Count -gt 0) {
    $summaryLines += "| Time (UTC) | PID | Process Name | Parent Name |"
    $summaryLines += "|---|---|---|---|"
    foreach ($ue in $unmatchedEvents) {
        $summaryLines += "| $($ue.event_time_utc) | $($ue.child_pid) | $($ue.child_process_name) | $($ue.parent_process_name) |"
    }
    $summaryLines += ""
}

# Verifier recommendation section
$summaryLines += "## Verifier PASS/FAIL Recommendation"
$summaryLines += ""

$failReasons = @()

# Check 1: All required markers present
foreach ($path in $lifecycleMarkerSequence.Keys) {
    $seq = $lifecycleMarkerSequence[$path]
    $pathMarkers = $markers | Where-Object { $_.lifecycle_path -eq $path }
    $foundNames = $pathMarkers | ForEach-Object { $_.marker_name }
    $missing = $seq | Where-Object { $_ -notin $foundNames }
    if ($missing) {
        $failReasons += "Missing markers in $path : $($missing -join ', ')"
    }
}

# Check 2: Monitor start time not after first BEGIN marker
$firstBegin = $markers | Where-Object { $_.marker_name -match "_BEGIN$" } | Sort-Object _parsed_utc | Select-Object -First 1
if ($collectionStart -and $firstBegin) {
    if ($collectionStart._parsed_utc -gt $firstBegin._parsed_utc) {
        $failReasons += "COLLECTION_START ($($collectionStart.timestamp_utc)) is AFTER first BEGIN marker $($firstBegin.marker_name) ($($firstBegin.timestamp_utc))"
    }
}

# Check 3: Monotonic timestamps within each path
foreach ($path in $lifecycleMarkerSequence.Keys) {
    $pathMarkers = $markers | Where-Object { $_.lifecycle_path -eq $path } | Sort-Object _parsed_utc
    $prev = $null
    foreach ($m in $pathMarkers) {
        if ($prev -and $m._parsed_utc -le $prev._parsed_utc) {
            $failReasons += "Non-monotonic timestamps in $path : $($prev.marker_name) ($($prev.timestamp_utc)) >= $($m.marker_name) ($($m.timestamp_utc))"
        }
        $prev = $m
    }
}

# Check 4: Events outside windows claimed as in-window (checked during correlation; unmatched events have "uncorrelated" path)
# This is handled by the correlation logic — unmatched are marked as "uncorrelated"

# Check 5: Command lines unavailable where conclusions depend
# (HYPOTHESIS-level check; we flag it as a soft warning)
$missingCmdLine = $events | Where-Object { -not $_.child_command_line -and -not $_.correlation.lifecycle_path -eq "uncorrelated" }
if ($missingCmdLine.Count -gt 0) {
    $failReasons += "WARNING: $($missingCmdLine.Count) correlated events have null child_command_line — conclusions may be unsupported"
}

# Check 6: Duplicate marker_ids
$dupIds = $markers | Group-Object marker_id | Where-Object { $_.Count -gt 1 }
if ($dupIds) {
    $failReasons += "Duplicate marker_id values found: $($dupIds.Name -join ', ')"
}

# Check 7: Inconsistent run_id
$badRunIds = $markers | Where-Object { $_.run_id -ne $RunId }
$badRunIds += $events | Where-Object { $_.run_id -ne $RunId }
if ($badRunIds.Count -gt 0) {
    $failReasons += "Inconsistent run_id found in $($badRunIds.Count) records"
}

# Final verdict
if ($failReasons.Count -eq 0) {
    $verdict = "**PASS**"
    $summaryLines += "**Verdict: PASS** ✅"
    $summaryLines += ""
    $summaryLines += "All verifier criteria satisfied. Evidence is consistent and complete."
} else {
    $verdict = "**FAIL**"
    $summaryLines += "**Verdict: FAIL** ❌"
    $summaryLines += ""
    $summaryLines += "### Failure Reasons"
    $summaryLines += ""
    foreach ($reason in $failReasons) {
        $summaryLines += "- $reason"
    }
}

$summaryLines += ""
$summaryLines += "## Collection Metadata"
$summaryLines += ""
$summaryLines += "- **Evidence source:** WMI Win32_ProcessStartTrace"
$summaryLines += "- **Harness type:** Non-invasive, user-scoped, removable"
$summaryLines += "- **Elevation required:** No (WMI default)"
$summaryLines += "- **ETW/ProcMon used:** No (requires separate human approval)"
$summaryLines += "- **Pi source modified:** No"
$summaryLines += "- **Registry modified:** No"
$summaryLines += "- **Persistent hooks installed:** No"

# Write the summary
$summaryLines -join "`n" | Out-File -FilePath $SummaryFile -Encoding UTF8
Write-Host "  Wrote: $SummaryFile"

# ── Console summary ────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================"
Write-Host "CORRELATION COMPLETE"
Write-Host "  Verdict:    $verdict"
Write-Host "  Summary:    $SummaryFile"
Write-Host "  Correlated: $CorrFile"
Write-Host "======================================"
