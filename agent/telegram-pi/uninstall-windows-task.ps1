# PowerShell: uninstall-windows-task.ps1
# Removes the Windows Task Scheduler entry created by install-windows-task.ps1.
#
# This script only removes the scheduled task. It does NOT delete the daemon,
# state, logs, secret file, or any agent-scheduler file. To stop a currently
# running daemon process, run `/telegram daemon stop` from a Pi session or
# kill the node process running daemon.mjs.
#
# Usage (PowerShell):
#   powershell -ExecutionPolicy Bypass -File uninstall-windows-task.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall-windows-task.ps1 -TaskName TelegramPiDaemon

[CmdletBinding()]
param(
    [string]$TaskName = "TelegramPiDaemon"
)

$ErrorActionPreference = "Stop"

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Existing) {
    Write-Output ("No task named '{0}' found. Nothing to do." -f $TaskName)
    return
}

# Stop it first if running.
try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} catch {}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output ("Removed task '{0}'." -f $TaskName)
Write-Output "No daemon files, state, logs, or scheduler files were modified."
