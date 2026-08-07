<#
.SYNOPSIS
    Start-PiLifecycleTrace.ps1 — HARNESS ARTIFACT
    Starts a non-invasive WMI process-start trace listener (Win32_ProcessStartTrace)
    for Pi lifecycle process-creation capture.

.DESCRIPTION
    Registers a temporary WMI event subscription for Win32_ProcessStartTrace.
    On every process-creation event, enriches with Win32_Process queries for
    command line, executable path, parent/grandparent lineage, shell/console
    detection, and writes a JSONL record to process-events.jsonl.

    NON-INVASIVE: User-scoped WMI subscription only. No elevation, no registry
    changes, no drivers, no persistent hooks. Subscription auto-cleans on
    script exit or system restart.

.PARAMETER RunId
    Unique run identifier. Recommended format: "pi-lifecycle-YYYYMMDDTHHmmssZ".

.PARAMETER OutputPath
    Directory for output files. Defaults to current directory.

.PARAMETER PiExecutableName
    Name of the Pi executable process image to watch. Defaults to "pi".
    Set to "node" if Pi is launched via Node directly.

.PARAMETER MaxFileSizeMB
    Maximum size in MB for the events file before rotation. Default 10.

.EXAMPLE
    .\Start-PiLifecycleTrace.ps1 -RunId "pi-lifecycle-20260626T120000Z"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".",

    [Parameter(Mandatory = $false)]
    [string]$PiExecutableName = "pi",

    [Parameter(Mandatory = $false)]
    [int]$MaxFileSizeMB = 10
)

$ErrorActionPreference = "Stop"

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
        $proc = Get-WmiObject -Class Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop |
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
        # Process exited before WMI query completed — expected for short-lived processes
    }
    return $null
}

# ── Lineage resolution ─────────────────────────────────────────────────
function Resolve-Ancestors {
    param([uint32]$ParentPid)
    $parent   = Get-ProcessDetails -ProcessId $ParentPid
    $grandparent = $null
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
        notes      = "Window style not directly observable through WMI"
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
        # New empty file will be created on next Add-Content
    }
}

# ── Write COLLECTION_START marker ──────────────────────────────────────
Write-TraceLog "Starting Pi lifecycle process trace for RunId=$RunId"
Write-TraceLog "Events file: $EventsFile"

$collectionStartUtc = (Get-Date).ToUniversalTime()
$collectionStartMarker = [ordered]@{
    record_type          = "marker"
    run_id               = $RunId
    lifecycle            = "harness"
    label                = "COLLECTION_START"
    sequence             = 0
    timestamp_utc        = $collectionStartUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local      = $collectionStartUtc.ToLocalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    collector_pid        = $PID
    operator_note        = "WMI process-start trace listener started"
    metadata             = @{
        expected_parent_pid = $null
        shell_kind          = $null
        pi_pid              = $null
    }
}
$markersFile = Join-Path $OutputPath "markers.jsonl"
$json = $collectionStartMarker | ConvertTo-Json -Depth 4 -Compress
Add-Content -Path $markersFile -Value $json -Encoding UTF8
Write-TraceLog "COLLECTION_START marker written to markers.jsonl"

# ── Register WMI Win32_ProcessStartTrace ───────────────────────────────
Write-TraceLog "Registering WMI Win32_ProcessStartTrace subscription..."

try {
    $wmiEvent = Register-CimIndicationEvent `
        -Namespace "root/CIMV2" `
        -ClassName "Win32_ProcessStartTrace" `
        -Action {
            $eventArgs = $EventArgs.NewEvent
            $childPid       = $eventArgs.ProcessID
            $childProcName  = $eventArgs.ProcessName
            $parentPid      = $eventArgs.ParentProcessID
            $sessionId      = $eventArgs.SessionID
            $sid            = $eventArgs.Sid

            $eventTimeUtc = (Get-Date).ToUniversalTime()
            $eventTimeLocal = $eventTimeUtc.ToLocalTime()

            # Enrich: query Win32_Process for details
            $childInfo = Get-ProcessDetails -ProcessId $childPid
            $ancestors = if ($parentPid) { Resolve-Ancestors -ParentPid $parentPid } else { Resolve-Ancestors -ParentPid 0 }
            $shellIndicators = Get-ShellIndicators -Ancestors $ancestors -ChildProcessName $childProcName
            $windowObs       = Get-WindowConsoleObservations -Ancestors $ancestors
            $enrichStatus    = Get-EnrichmentStatus -ChildInfo $childInfo

            # Resolve user SID to a string if not provided by WMI event
            $userSid = $sid
            if (-not $userSid -and $childInfo -and $childInfo.SessionId) {
                # Best-effort: we don't resolve SID from session in this harness
                $userSid = $null
            }
            # Also attempt from current user if session matches
            if (-not $userSid) {
                try {
                    $currentSessionId = (Get-Process -Id $PID).SessionId
                    if ($sessionId -eq $currentSessionId) {
                        $userSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
                    }
                } catch {
                    # Non-critical
                }
            }

            # Build the evidence record per planner schema
            $record = [ordered]@{
                record_type                   = "process_start"
                run_id                        = $using:RunId
                capture_source                = "wmi-process-start-trace"
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
                shell_indicators              = $shellIndicators
                window_console_observations   = $windowObs
                enrichment_status             = $enrichStatus
                raw_event                     = @{
                    TIME_CREATED    = $eventArgs.TIME_CREATED
                    ProcessID       = $eventArgs.ProcessID
                    ProcessName     = $eventArgs.ProcessName
                    ParentProcessID = $eventArgs.ParentProcessID
                    SessionID       = $eventArgs.SessionID
                    Sid             = $eventArgs.Sid
                }
            }

            # Write to events file
            try {
                $json = $record | ConvertTo-Json -Depth 6 -Compress
                Add-Content -Path $using:EventsFile -Value $json -Encoding UTF8
            } catch {
                Write-TraceLog -Message "ERROR writing process event: $_" -Level "ERROR"
            }
        } `
        -ErrorAction Stop

    $subscriberName = $wmiEvent.Name
    Write-TraceLog "WMI subscription registered: $subscriberName"
    Write-TraceLog "Events file: $EventsFile"

    # Save subscriber name for Stop-PiLifecycleTrace.ps1
    $subscriberName | Out-File -FilePath $SubFile -Encoding UTF8 -Force

    # Save state file
    @{
        RunId      = $RunId
        EventsFile = $EventsFile
        LogFile    = $LogFile
        StartedAt  = $collectionStartUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        PiExePat   = $PiExecutableName
        Subscriber = $subscriberName
    } | ConvertTo-Json | Out-File -FilePath $StateFile -Encoding UTF8 -Force

    Write-TraceLog ""
    Write-TraceLog "========================================"
    Write-TraceLog "TRACE LISTENER IS ACTIVE. DO NOT CLOSE THIS WINDOW."
    Write-TraceLog "Run: Stop-PiLifecycleTrace.ps1 -RunId '$RunId' to stop"
    Write-TraceLog "Run: Write-PiLifecycleMarker.ps1 to insert action markers"
    Write-TraceLog "========================================"
    Write-TraceLog ""

    # Keep alive — WMI events fire in the background via -Action
    try {
        while ($true) {
            Start-Sleep -Seconds 10
        }
    } finally {
        Write-TraceLog "Trace listener loop exiting."
    }

} catch {
    Write-TraceLog "FATAL: Failed to register WMI subscription: $_" -Level "ERROR"
    Write-TraceLog "Check permissions. WMI Win32_ProcessStartTrace requires membership in 'Event Log Readers' or local admin for non-interactive sessions."
    exit 1
}
