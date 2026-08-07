<#
.SYNOPSIS
    Start-ProcessTrace.ps1 — HARNESS ARTIFACT
    Starts a non-invasive WMI process-start trace listener (Win32_ProcessStartTrace).
    Writes process-creation events to process-events.jsonl.

.DESCRIPTION
    Registers a temporary WMI event subscription for Win32_ProcessStartTrace.
    On every process-creation event, queries Win32_Process for command-line and
    executable path details, resolves parent and grandparent lineage, detects
    shell/console lineage, and appends a JSONL record to process-events.jsonl.

    NON-INVASIVE: User-scoped WMI subscription only. No elevation, no registry
    changes, no drivers, no persistent hooks. Subscription auto-cleans on script exit.

.PARAMETER RunId
    Unique run identifier (e.g., "win-lifecycle-process-trace-20260626-123456").

.PARAMETER OutputPath
    Directory for output files. Defaults to current directory.

.PARAMETER PiExecutableName
    Name of the Pi executable to watch for as a parent process. Defaults to "pi.exe".
    You may also set to "node.exe" if Pi is launched via Node directly.

.EXAMPLE
    .\Start-ProcessTrace.ps1 -RunId "win-lifecycle-process-trace-20260626-123456"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".",

    [Parameter(Mandatory = $false)]
    [string]$PiExecutableName = "pi.exe"
)

$ErrorActionPreference = "Stop"

# Ensure output directory exists
if (-not (Test-Path $OutputPath)) {
    New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
}

$EventsFile = Join-Path $OutputPath "process-events.jsonl"
$LogFile     = Join-Path $OutputPath "trace-collector.log"

# ── Helper: append a log line ──────────────────────────────────────────
function Write-TraceLog {
    param([string]$Message, [string]$Level = "INFO")
    $ts = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffK")
    $line = "[$ts] [$Level] $Message"
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

# ── Helper: get process info including command line ────────────────────
function Get-ProcessDetails {
    param([uint32]$ProcessId)
    try {
        $proc = Get-WmiObject -Class Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop |
                Select-Object -First 1
        if ($proc) {
            return @{
                ProcessId        = $proc.ProcessId
                ProcessName      = $proc.Name
                ExecutablePath   = $proc.ExecutablePath
                CommandLine      = $proc.CommandLine
                ParentProcessId  = $proc.ParentProcessId
                SessionId        = $proc.SessionId
            }
        }
    } catch {
        # Process may have exited before WMI query completed
    }
    return $null
}

# ── Helper: resolve parent details ─────────────────────────────────────
function Get-ParentDetails {
    param([uint32]$ParentProcessId)
    if ($ParentProcessId -eq 0) { return $null }
    return Get-ProcessDetails -ProcessId $ParentProcessId
}

# ── Helper: resolve grandparent details ────────────────────────────────
function Get-GrandparentDetails {
    param([uint32]$ParentProcessId)
    if ($ParentProcessId -eq 0) { return $null }
    $pp = Get-ParentDetails -ProcessId $ParentProcessId
    if ($pp -and $pp.ParentProcessId -and $pp.ParentProcessId -ne 0) {
        return Get-ProcessDetails -ProcessId $pp.ParentProcessId
    }
    return $null
}

# ── Helper: classify shell/console lineage ─────────────────────────────
$ShellProcessNames = @("cmd.exe", "powershell.exe", "pwsh.exe")
$ConsoleProcessNames = @("conhost.exe", "WindowsTerminal.exe")

function Get-ShellUsage {
    param($ParentInfo, $GrandparentInfo)
    $result = @{
        observed_shell_parent   = $false
        shell_process           = $null
        classification          = "none"
    }
    if ($ParentInfo -and $ShellProcessNames -contains $ParentInfo.ProcessName) {
        $result.observed_shell_parent = $true
        $result.shell_process = $ParentInfo.ProcessName
        $result.classification = "$($ParentInfo.ProcessName.Replace('.exe',''))-parent"
    }
    return $result
}

function Get-WindowConsoleObservations {
    param($ParentInfo, $GrandparentInfo)
    $allNames = @()
    if ($ParentInfo)      { $allNames += $ParentInfo.ProcessName }
    if ($GrandparentInfo) { $allNames += $GrandparentInfo.ProcessName }
    return @{
        conhost_seen                     = ($allNames -contains "conhost.exe")
        windows_terminal_lineage_seen    = ($allNames -contains "WindowsTerminal.exe")
        main_window_handle_observable    = $null   # WMI cannot observe window handles
        creation_flags_observable        = $false  # WMI cannot observe creation flags
    }
}

# ── Helper: get current user ───────────────────────────────────────────
function Get-CurrentUserString {
    try {
        return "$env:USERDOMAIN\$env:USERNAME"
    } catch {
        return "UNKNOWN"
    }
}

# ── Helper: append JSONL event record ──────────────────────────────────
function Write-ProcessEvent {
    param([hashtable]$EventData)
    $json = $EventData | ConvertTo-Json -Depth 6 -Compress
    Add-Content -Path $EventsFile -Value $json -Encoding UTF8
}

# ── Write COLLECTION_START marker ──────────────────────────────────────
Write-TraceLog "Starting process trace for run_id=$RunId"
Write-TraceLog "Events will be written to: $EventsFile"

$collectionStartUtc = (Get-Date).ToUniversalTime()
$collectionStartMarker = @{
    run_id            = $RunId
    marker_id         = [guid]::NewGuid().ToString()
    marker_name       = "COLLECTION_START"
    lifecycle_path    = "harness"
    timestamp_utc     = $collectionStartUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    timestamp_local   = $collectionStartUtc.ToLocalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
    monotonic_ms      = [Environment]::TickCount
    operator_note     = "WMI process-start trace listener started"
}
Write-ProcessEvent -EventData $collectionStartMarker

# ── Register WMI ProcessStartTrace event ───────────────────────────────
Write-TraceLog "Registering WMI Win32_ProcessStartTrace subscription..."

# We use Register-WmiEvent for synchronous WMI event registration.
# The query watches for __InstanceCreationEvent on Win32_ProcessStartTrace.
$wmiQuery = "SELECT * FROM Win32_ProcessStartTrace"

try {
    # Use Register-CimIndicationEvent (PowerShell 5.1+ preferred) if available,
    # fall back to Register-WmiEvent
    $wmiEvent = Register-CimIndicationEvent `
        -Namespace "root/CIMV2" `
        -ClassName "Win32_ProcessStartTrace" `
        -Action {
            $eventArgs = $EventArgs.NewEvent

            # Extract fields from the WMI event
            $childPid      = $eventArgs.ProcessID
            $childProcName = $eventArgs.ProcessName
            $parentPid     = $eventArgs.ParentProcessID
            $sessionId     = $eventArgs.SessionID
            $sid           = $eventArgs.Sid

            # Timestamps
            $eventTimeUtc = (Get-Date).ToUniversalTime()

            # Query Win32_Process for detailed info (immediate query to avoid race)
            $childInfo      = Get-ProcessDetails -ProcessId $childPid
            $parentInfo     = Get-ParentDetails -ProcessId $parentPid
            $grandparentPid = if ($parentInfo) { $parentInfo.ParentProcessId } else { $null }
            $grandparentInfo = if ($grandparentPid) { Get-ProcessDetails -ProcessId $grandparentPid } else { $null }

            # Shell/console observations
            $shellUsage    = Get-ShellUsage -ParentInfo $parentInfo -GrandparentInfo $grandparentInfo
            $windowObs     = Get-WindowConsoleObservations -ParentInfo $parentInfo -GrandparentInfo $grandparentInfo

            # Build event record
            $record = [ordered]@{
                run_id                    = $RunId
                event_source              = "WMI.Win32_ProcessStartTrace"
                event_time_utc            = $eventTimeUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                child_pid                 = $childPid
                child_process_name        = if ($childInfo) { $childInfo.ProcessName } else { $childProcName }
                child_executable_path     = if ($childInfo) { $childInfo.ExecutablePath } else { $null }
                child_command_line        = if ($childInfo) { $childInfo.CommandLine } else { $null }
                parent_pid                = $parentPid
                parent_process_name       = if ($parentInfo) { $parentInfo.ProcessName } else { $null }
                parent_executable_path    = if ($parentInfo) { $parentInfo.ExecutablePath } else { $null }
                parent_command_line       = if ($parentInfo) { $parentInfo.CommandLine } else { $null }
                grandparent_pid           = if ($grandparentInfo) { $grandparentInfo.ProcessId } else { $null }
                grandparent_process_name  = if ($grandparentInfo) { $grandparentInfo.ProcessName } else { $null }
                session_id                = $sessionId
                user                      = (Get-CurrentUserString)
                shell_usage               = $shellUsage
                window_console_observations = $windowObs
                correlation               = @{
                    lifecycle_path = $null
                    window_name    = $null
                    offset_ms_from_window_start = $null
                }
                raw_event                 = @{
                    TIME_CREATED    = $eventArgs.TIME_CREATED
                    ProcessID       = $eventArgs.ProcessID
                    ProcessName     = $eventArgs.ProcessName
                    ParentProcessID = $eventArgs.ParentProcessID
                    SessionID       = $eventArgs.SessionID
                    Sid             = $eventArgs.Sid
                }
                collection_warnings       = @()
            }

            # Add warning if command line was unavailable
            if (-not $record.child_command_line) {
                $record.collection_warnings += "child_command_line_unavailable:process_may_have_exited_before_WMI_query"
            }
            if (-not $record.parent_command_line) {
                $record.collection_warnings += "parent_command_line_unavailable"
            }

            # Write to events file
            try {
                $json = $record | ConvertTo-Json -Depth 6 -Compress
                Add-Content -Path $using:EventsFile -Value $json -Encoding UTF8
            } catch {
                # If we can't write to the events file, try the log
                Write-TraceLog -Message "Failed to write process event: $_" -Level "ERROR"
            }
        } `
        -ErrorAction Stop

    Write-TraceLog "WMI subscription registered successfully."
    Write-TraceLog "Subscription ID: $($wmiEvent.Name)"
    Write-TraceLog "Events file: $EventsFile"
    Write-TraceLog ""
    Write-TraceLog "========================================" -Level "NONE"
    Write-TraceLog "TRACE LISTENER IS ACTIVE. DO NOT CLOSE THIS WINDOW." -Level "NONE"
    Write-TraceLog "When ready to stop, run: Stop-ProcessTrace.ps1 -RunId '$RunId'" -Level "NONE"
    Write-TraceLog "========================================" -Level "NONE"
    Write-TraceLog ""

    # Register the event subscriber for cleanup tracking
    $subscriberFile = Join-Path $OutputPath ".trace-subscriber.txt"
    $wmiEvent.Name | Out-File -FilePath $subscriberFile -Encoding UTF8
    Write-TraceLog "Subscriber name saved to: $subscriberFile"

    # Export run state for Stop-ProcessTrace.ps1
    $stateFile = Join-Path $OutputPath ".trace-state.json"
    @{
        RunId      = $RunId
        EventsFile = $EventsFile
        LogFile    = $LogFile
        StartedAt  = $collectionStartUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    } | ConvertTo-Json | Out-File -FilePath $stateFile -Encoding UTF8
    Write-TraceLog "Trace state saved to: $stateFile"

    # Keep the script alive (the -Action scriptblock runs in the background)
    Write-TraceLog "Press Ctrl+C to stop tracing, or run Stop-ProcessTrace.ps1 from another window."
    try {
        while ($true) {
            Start-Sleep -Seconds 10
        }
    } finally {
        Write-TraceLog "Trace listener loop exiting."
    }

} catch {
    Write-TraceLog -Message "Failed to register WMI subscription: $_" -Level "ERROR"
    Write-TraceLog -Message "Ensure you have appropriate permissions. Try running in an elevated prompt if the issue persists."
    exit 1
}
