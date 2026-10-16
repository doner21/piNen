param(
    [string]$File = "$PSScriptRoot\output\live-notes.md",
    [int]$Port = 8766
)

$ErrorActionPreference = 'Stop'
$python = (Get-Command python).Source
$edge = (Get-Command msedge.exe -ErrorAction SilentlyContinue).Source
if (-not $edge) { $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) { throw 'Microsoft Edge was not found.' }

$log = Join-Path $env:LOCALAPPDATA 'Temp\markdown-keyboard-server.log'
$errorLog = Join-Path $env:LOCALAPPDATA 'Temp\markdown-keyboard-server-error.log'
$serverArgs = @(
    (Join-Path $PSScriptRoot 'markdown_keyboard_server.py'),
    '--port', "$Port",
    '--file', $File
)
$server = Start-Process $python -ArgumentList $serverArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError $errorLog

$deadline = (Get-Date).AddSeconds(8)
do {
    Start-Sleep -Milliseconds 150
    try {
        $null = Invoke-RestMethod "http://127.0.0.1:$Port/api/document" -TimeoutSec 1
        $ready = $true
    } catch { $ready = $false }
} until ($ready -or (Get-Date) -gt $deadline -or $server.HasExited)

Start-Sleep -Milliseconds 250
if ($server.HasExited) {
    if (Test-Path $errorLog) { Get-Content $errorLog | Write-Error }
    throw "Markdown keyboard server exited early. Port $Port may already be in use."
}
if (-not $ready) {
    if (Test-Path $errorLog) { Get-Content $errorLog | Write-Error }
    throw 'Markdown keyboard server did not become ready.'
}

$edgeArgs = @(
    '--new-window',
    "--app=http://127.0.0.1:$Port/",
    '--window-position=18,10',
    '--window-size=930,1040'
)
Start-Process $edge -ArgumentList $edgeArgs

Write-Host "Markdown keyboard: http://127.0.0.1:$Port/"
Write-Host "Document: $([IO.Path]::GetFullPath($File))"
Write-Host "Server PID: $($server.Id)"
