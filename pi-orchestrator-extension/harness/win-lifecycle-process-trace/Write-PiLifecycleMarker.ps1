<#
.SYNOPSIS
    Write-PiLifecycleMarker.ps1 — HARNESS ARTIFACT
    Emits a timestamped action marker record to markers.jsonl per the planner's
    action-marker scheme.

.DESCRIPTION
    Creates a JSONL marker record with ISO-8601 UTC and local timestamps, a
    monotonic sequence counter, collector PID, operator note, and path-specific
    metadata. Validates marker names against the exact planner specification.
    Every marker flushes immediately to disk.

    NON-INVASIVE: Writes only to markers.jsonl. No system changes.

.PARAMETER MarkerName
    REQUIRED. Must be one of:
      COLD_START_BEGIN, COLD_START_FIRST_RENDER, COLD_START_END
      OPEN_FROM_TERMINAL_BEGIN, OPEN_FROM_TERMINAL_COMMAND_SENT, OPEN_FROM_TERMINAL_ATTACHED, OPEN_FROM_TERMINAL_END
      RELOAD_BEGIN, RELOAD_TRIGGER_SENT, RELOAD_POST_IDLE, RELOAD_END
      NEW_SESSION_BEGIN, NEW_SESSION_TRIGGER_SENT, NEW_SESSION_RENDER, NEW_SESSION_END

.PARAMETER RunId
    REQUIRED. The run identifier string.

.PARAMETER OutputPath
    Directory containing markers.jsonl. Defaults to current directory.

.PARAMETER Note
    Optional human-readable note describing the action observed.

.PARAMETER ShellPid
    PID of the shell process (for OPEN_FROM_TERMINAL markers).

.PARAMETER ShellKind
    Kind of shell: "cmd", "powershell", "pwsh", "windows-terminal", or "unknown".

.PARAMETER PiPid
    PID of the Pi process at marker time (for RELOAD and NEW_SESSION markers).

.PARAMETER LaunchCommand
    The command used to launch Pi (for OPEN_FROM_TERMINAL markers). May be redacted.

.EXAMPLE
    .\Write-PiLifecycleMarker.ps1 -MarkerName "RELOAD_BEGIN" -RunId "pi-lifecycle-20260626T120000Z" -Note "About to type /reload in Pi"

.EXAMPLE
    .\Write-PiLifecycleMarker.ps1 -MarkerName "OPEN_FROM_TERMINAL_BEGIN" -RunId $env:RUN_ID -ShellPid 12345 -ShellKind "powershell" -Note "Opening Pi from pwsh"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        # Cold Start
        "COLD_START_BEGIN",
        "COLD_START_FIRST_RENDER",
        "COLD_START_END",
        # Open-from-Terminal
        "OPEN_FROM_TERMINAL_BEGIN",
        "OPEN_FROM_TERMINAL_COMMAND_SENT",
        "OPEN_FROM_TERMINAL_ATTACHED",
        "OPEN_FROM_TERMINAL_END",
        # Reload
        "RELOAD_BEGIN",
        "RELOAD_TRIGGER_SENT",
        "RELOAD_POST_IDLE",
        "RELOAD_END",
        # New Session
        "NEW_SESSION_BEGIN",
        "NEW_SESSION_TRIGGER_SENT",
        "NEW_SESSION_RENDER",
        "NEW_SESSION_END"
    )]
    [string]$MarkerName,

    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".",

    [Parameter(Mandatory = $false)]
    [string]$Note = "",

    [Parameter(Mandatory = $false)]
    [int]$ShellPid = 0,

    [Parameter(Mandatory = $false)]
    [ValidateSet("cmd", "powershell", "pwsh", "windows-terminal", "unknown")]
    [string]$ShellKind = "unknown",

    [Parameter(Mandatory = $false)]
    [int]$PiPid = 0,

    [Parameter(Mandatory = $false)]
    [string]$LaunchCommand = ""
)

$ErrorActionPreference = "Stop"

# ── Determine lifecycle path from marker name ──────────────────────────
$lifecycle = switch -Wildcard ($MarkerName) {
    "COLD_START_*"          { "cold_start" }
    "OPEN_FROM_TERMINAL_*"  { "open_from_terminal" }
    "RELOAD_*"              { "reload" }
    "NEW_SESSION_*"         { "new_session" }
    default                 { "unknown" }
}

# ── Ensure output directory exists ─────────────────────────────────────
if (-not (Test-Path $OutputPath)) {
    New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
}

$MarkersFile = Join-Path $OutputPath "markers.jsonl"

# ── Compute monotonic sequence ─────────────────────────────────────────
$sequence = 0
if (Test-Path $MarkersFile) {
    $existing = Get-Content $MarkersFile -Encoding UTF8 -ErrorAction SilentlyContinue |
                Where-Object { $_.Trim() -ne "" } |
                ForEach-Object {
                    try { $_ | ConvertFrom-Json }
                    catch { $null }
                }
    $maxSeq = ($existing | ForEach-Object { $_.sequence } | Measure-Object -Maximum).Maximum
    if ($maxSeq -ge 0) { $sequence = $maxSeq + 1 }
}

# ── Timestamps ─────────────────────────────────────────────────────────
$nowUtc = (Get-Date).ToUniversalTime()
$nowLocal = $nowUtc.ToLocalTime()

# ── Build marker record per planner schema ─────────────────────────────
$marker = [ordered]@{
    record_type    = "marker"
    run_id         = $RunId
    lifecycle      = $lifecycle
    label          = $MarkerName
    sequence       = $sequence
    timestamp_utc  = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local = $nowLocal.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    collector_pid  = [long]$PID
    operator_note  = $Note
    metadata       = [ordered]@{
        expected_parent_pid = if ($ShellPid -gt 0) { [long]$ShellPid } else { $null }
        shell_kind          = if ($ShellKind -ne "unknown") { $ShellKind } else { $null }
        shell_pid           = if ($ShellPid -gt 0) { [long]$ShellPid } else { $null }
        launch_command      = if ($LaunchCommand) { $LaunchCommand } else { $null }
        pi_pid              = if ($PiPid -gt 0) { [long]$PiPid } else { $null }
    }
}

# ── Write to markers.jsonl ─────────────────────────────────────────────
$json = $marker | ConvertTo-Json -Depth 4 -Compress
Add-Content -Path $MarkersFile -Value $json -Encoding UTF8

# ── Console feedback ───────────────────────────────────────────────────
Write-Host "[MARKER] $MarkerName (seq=$sequence, lifecycle=$lifecycle, run=$RunId)" -ForegroundColor Cyan
if ($Note) {
    Write-Host "         Note: $Note"
}
Write-Host "         Written to: $MarkersFile"
