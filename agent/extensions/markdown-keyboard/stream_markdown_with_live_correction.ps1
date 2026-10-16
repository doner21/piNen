param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt,
    [int]$Port = 8766,
    [int]$TimeoutSeconds = 360
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$queue = Join-Path $root 'markdown-stream.queue'
$typistLog = Join-Path $root 'markdown-typist.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$api = "http://127.0.0.1:$Port"

try {
    $before = Invoke-RestMethod "$api/api/document" -TimeoutSec 2
} catch {
    throw "Markdown keyboard server is not running at $api."
}
if ($before.content.Length -ne 0 -or $before.cursor -ne 0 -or $before.selectedCount -ne 0) {
    throw 'Live correction requires an empty document with cursor at zero. Delete the current document through the physical keyboard first.'
}

[IO.File]::WriteAllText($queue, '', $utf8NoBom)
$python = (Get-Command python).Source
$typist = Start-Process $python -ArgumentList @(
    '-B',
    (Join-Path $root 'physical_markdown_typist.py'),
    '--queue', $queue,
    '--log', $typistLog,
    '--pause-ms', '45'
) -PassThru -WindowStyle Hidden

try {
    & node (Join-Path $root 'stream_model_with_live_correction.mjs') $Prompt
    if ($LASTEXITCODE -ne 0) { throw "Live correction bridge exited with code $LASTEXITCODE." }

    $state = Invoke-RestMethod "$api/api/document" -TimeoutSec 2
    $forbidden = @($state.disabledCharacters | Where-Object { $state.content.Contains($_) })
    if ($forbidden.Count -ne 0) { throw "Final file contains unavailable characters: $($forbidden -join ', ')" }
    Write-Host "Verified corrected document: $($state.charCount) characters at $($state.path)"
    Write-Host "SHA256: $($state.sha256)"
} finally {
    [IO.File]::AppendAllText($queue, '"__STOP__"' + "`n", $utf8NoBom)
    $typist.WaitForExit(8000) | Out-Null
    if (-not $typist.HasExited) { Stop-Process -Id $typist.Id -Force }
}
