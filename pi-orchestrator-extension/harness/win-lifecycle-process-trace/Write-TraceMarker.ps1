<#
.SYNOPSIS
    Write-TraceMarker.ps1 — HARNESS ARTIFACT
    Appends a timestamped action marker record to markers.jsonl.

.DESCRIPTION
    Creates a JSONL marker record with UTC and local timestamps, a monotonic
    counter, and operator-supplied notes. Allowed marker names are validated
    against the planner's action-marker scheme.

    NON-INVASIVE: Writes only to markers.jsonl. No system changes.

.PARAMETER MarkerName
    REQUIRED. One of the predefined lifecycle markers (e.g., "COLD_START_BEGIN").

.PARAMETER RunId
    REQUIRED. The run identifier string.

.PARAMETER Note
    Optional human-readable note describing the action observed.

.PARAMETER OutputPath
    Directory for output files. Defaults to current directory.

.EXAMPLE
    .\Write-TraceMarker.ps1 -MarkerName "RELOAD_BEGIN" -RunId "win-lifecycle-process-trace-20260626-123456" -Note "About to type /reload in Pi"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        "COLD_START_BEGIN",
        "COLD_START_FIRST_RENDER",
        "COLD_START_END",
        "OPEN_FROM_TERMINAL_BEGIN",
        "OPEN_FROM_TERMINAL_COMMAND_SENT",
        "OPEN_FROM_TERMINAL_ATTACHED",
        "OPEN_FROM_TERMINAL_END",
        "RELOAD_BEGIN",
        "RELOAD_COMMAND_SENT",
        "RELOAD_POST_RENDER_IDLE",
        "RELOAD_END",
        "NEW_SESSION_BEGIN",
        "NEW_SESSION_COMMAND_SENT",
        "NEW_SESSION_RENDERED",
        "NEW_SESSION_END"
    )]
    [string]$MarkerName,

    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$Note = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = "."
)

$ErrorActionPreference = "Stop"

# ── Determine lifecycle path from marker name ──────────────────────────
$lifecyclePathMap = @{
    "COLD_START_BEGIN"                    = "cold_start"
    "COLD_START_FIRST_RENDER"             = "cold_start"
    "COLD_START_END"                      = "cold_start"
    "OPEN_FROM_TERMINAL_BEGIN"            = "open_from_terminal"
    "OPEN_FROM_TERMINAL_COMMAND_SENT"     = "open_from_terminal"
    "OPEN_FROM_TERMINAL_ATTACHED"         = "open_from_terminal"
    "OPEN_FROM_TERMINAL_END"              = "open_from_terminal"
    "RELOAD_BEGIN"                        = "reload"
    "RELOAD_COMMAND_SENT"                 = "reload"
    "RELOAD_POST_RENDER_IDLE"             = "reload"
    "RELOAD_END"                          = "reload"
    "NEW_SESSION_BEGIN"                   = "new_session"
    "NEW_SESSION_COMMAND_SENT"            = "new_session"
    "NEW_SESSION_RENDERED"                = "new_session"
    "NEW_SESSION_END"                     = "new_session"
}

$lifecyclePath = $lifecyclePathMap[$MarkerName]

# ── Ensure output directory ────────────────────────────────────────────
if (-not (Test-Path $OutputPath)) {
    New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
}

$MarkersFile = Join-Path $OutputPath "markers.jsonl"

# ── Collect timestamps ─────────────────────────────────────────────────
$nowUtc   = (Get-Date).ToUniversalTime()
$nowLocal = $nowUtc.ToLocalTime()
$tickCount = [Environment]::TickCount

# ── Build marker record ────────────────────────────────────────────────
$marker = [ordered]@{
    run_id         = $RunId
    marker_id      = [guid]::NewGuid().ToString()
    marker_name    = $MarkerName
    lifecycle_path = $lifecyclePath
    timestamp_utc  = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local = $nowLocal.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    monotonic_ms   = $tickCount
    operator_note  = $Note
}

# ── Append to markers.jsonl ────────────────────────────────────────────
$json = $marker | ConvertTo-Json -Depth 3 -Compress
Add-Content -Path $MarkersFile -Value $json -Encoding UTF8

Write-Host "[MARKER] $MarkerName | lifecycle=$lifecyclePath | utc=$($marker.timestamp_utc) | note=$Note"
Write-Host "  Appended to: $MarkersFile"
