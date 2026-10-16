param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt,
    [int]$Port = 8766,
    [switch]$Clear,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$queue = Join-Path $root 'markdown-stream.queue'
$streamLog = Join-Path $root 'model-stream.log'
$typistLog = Join-Path $root 'markdown-typist.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$api = "http://127.0.0.1:$Port"

try {
    $before = Invoke-RestMethod "$api/api/document" -TimeoutSec 2
} catch {
    throw "Markdown keyboard server is not running at $api. Run start_markdown_keyboard.ps1 first."
}

if ($Clear) {
    $before = Invoke-RestMethod "$api/api/edit" -Method Post -ContentType 'application/json' -Body '{"action":"clear"}'
}

[IO.File]::WriteAllText($queue, '', $utf8NoBom)
$python = (Get-Command python).Source
$typist = Start-Process $python -ArgumentList @(
    (Join-Path $root 'physical_markdown_typist.py'),
    '--queue', $queue,
    '--log', $typistLog
) -PassThru -WindowStyle Hidden

try {
    & node (Join-Path $root 'stream_model_to_markdown_keyboard.mjs') $Prompt
    if ($LASTEXITCODE -ne 0) { throw "Model stream bridge exited with code $LASTEXITCODE." }

    $newText = (Get-Content $streamLog -Encoding UTF8 | ForEach-Object { (ConvertFrom-Json $_).delta }) -join ''
    $expected = $before.content.Substring(0, $before.selectionStart) + $newText + $before.content.Substring($before.selectionEnd)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 200
        $state = Invoke-RestMethod "$api/api/document" -TimeoutSec 2
    } until ($state.content -ceq $expected -or (Get-Date) -gt $deadline -or $typist.HasExited)

    if ($state.content -cne $expected) {
        throw "Physical typing did not converge. Expected $($expected.Length) characters; file has $($state.content.Length)."
    }

    [IO.File]::AppendAllText($queue, '"__STOP__"' + "`n", $utf8NoBom)
    $typist.WaitForExit(5000) | Out-Null
    Write-Host "Verified: $($state.charCount) characters persisted at $($state.path)"
    Write-Host "SHA256: $($state.sha256)"
} finally {
    if (-not $typist.HasExited) {
        [IO.File]::AppendAllText($queue, '"__STOP__"' + "`n", $utf8NoBom)
        $typist.WaitForExit(3000) | Out-Null
        if (-not $typist.HasExited) { Stop-Process -Id $typist.Id -Force }
    }
}
