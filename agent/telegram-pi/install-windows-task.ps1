# PowerShell: install-windows-task.ps1
# Installs a Windows Task Scheduler entry that launches the telegram-pi
# headless fallback daemon at user logon.
#
# SECURITY: This script NEVER writes the Telegram bot token into the Task
# Scheduler XML or into any process argument. The token is read by the
# extension from the TELEGRAM_BOT_TOKEN environment variable (set it as a
# user env var via System settings or `setx TELEGRAM_BOT_TOKEN "<token>"`)
# or from its 0600 secret file. The task runs only when the user is logged
# on so it inherits the user environment (including TELEGRAM_BOT_TOKEN).
#
# This script does NOT modify any agent-scheduler file or behavior.
#
# Usage (PowerShell):
#   powershell -ExecutionPolicy Bypass -File install-windows-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-windows-task.ps1 -TaskName TelegramPiDaemon
#   powershell -ExecutionPolicy Bypass -File install-windows-task.ps1 -Cwd "C:\projects\myapp"
#
# Parameters:
#   -TaskName   Task Scheduler task name. Default: TelegramPiDaemon
#   -Cwd        Working directory for the fallback Pi session. Default: this
#                script's parent directory's project root (the .pi agent dir).
#   -NodePath   Optional explicit path to node.exe. Default: node on PATH.

[CmdletBinding()]
param(
    [string]$TaskName = "TelegramPiDaemon",
    [string]$Cwd = "",
    [string]$NodePath = "node",
    [int]$StartDelayMinutes = 2
)

$ErrorActionPreference = "Stop"

# Resolve paths relative to this script.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DaemonScript = Join-Path $ScriptDir "daemon.mjs"

if (-not (Test-Path -LiteralPath $DaemonScript)) {
    throw "daemon.mjs not found at: $DaemonScript"
}

# Default cwd: the agent directory (parent of agent/telegram-pi).
# This keeps cwd-scoped scheduler wake-ups working for the usual project.
if ([string]::IsNullOrWhiteSpace($Cwd)) {
    # agent/telegram-pi -> agent -> <agentDir> ; but the user's project cwd is
    # usually elsewhere. Default to the current PowerShell location so the
    # caller controls it explicitly when needed.
    $Cwd = (Get-Location).Path
}

# Sanitize cwd to an absolute path.
$Cwd = (Resolve-Path -LiteralPath $Cwd).Path

# Do NOT include TELEGRAM_BOT_TOKEN here. It must come from the user
# environment. We intentionally do not pass it as an argument.

$ActionArgs = @($DaemonScript)
# Forward cwd to the daemon via env-style argument? No — daemon reads
# TELEGRAM_PI_CWD from its own environment. We set that env var on the task
# action via the working directory only; the daemon falls back to process.cwd()
# which Task Scheduler sets to $Cwd. To be explicit and robust, we also pass
# the cwd through the TELEGRAM_PI_CWD env var on the task.
# (Task Scheduler does not support per-action env vars directly; the daemon
#  reads process.cwd() when TELEGRAM_PI_CWD is unset, and Task Scheduler's
#  WorkingDirectory sets that.)

$Action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument ('"{0}"' -f $DaemonScript) `
    -WorkingDirectory $Cwd

# Run at user logon, and also allow restart on failure.
$Trigger = New-ScheduledTaskTrigger -AtLogOn
# Use Delay property for a post-logon delay (avoids StartBoundary absolute-date issues).
if ($StartDelayMinutes -gt 0) {
    $Trigger.Delay = "PT${StartDelayMinutes}M"
}

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# Run only when user is logged on (so the user environment, including
# TELEGRAM_BOT_TOKEN, is available). No stored password / S4U.
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

# Register (replace if exists).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Telegram-Pi headless fallback daemon. Hosts pi --mode rpc with the telegram-pi global extension when no active TUI session heartbeat exists. No secrets are stored in this task." | Out-Null

Write-Output ("Installed task '{0}'." -f $TaskName)
Write-Output ("  Action : {0} `"{1}`"" -f $NodePath, $DaemonScript)
Write-Output ("  Cwd    : {0}" -f $Cwd)
Write-Output ("  Trigger: At logon (interactive; inherits user env)")
Write-Output ""
Write-Output "NOTE: Set TELEGRAM_BOT_TOKEN as a USER environment variable so the"
Write-Output "task (which runs as your user at logon) can see it. Do NOT store the"
Write-Output "token in the task XML or args."
Write-Output "  setx TELEGRAM_BOT_TOKEN `"<your token>`""
Write-Output ""
Write-Output "Start it now with:  Start-ScheduledTask -TaskName '$TaskName'"
