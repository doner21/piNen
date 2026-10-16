param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt,
    [int]$Port = 8766,
    [switch]$PhysicalClear,
    [ValidateSet('Visible', 'Fast', 'Maximum')]
    [string]$Speed = 'Maximum'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$lockPath = Join-Path $root '.rotating-constraint-run.lock'
$runLock = $null
$typist = $null
$queue = Join-Path $root 'markdown-stream.queue'
$ack = Join-Path $root 'markdown-physical-acks.jsonl'
$typistLog = Join-Path $root 'markdown-typist.log'
$typistErrorLog = Join-Path $root 'markdown-typist-error.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$api = "http://127.0.0.1:$Port"

try {
    try {
        $runLock = [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    } catch {
        throw 'Another Markdown Type Foundry physical run already owns the document.'
    }

    $activeWorkers = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @('python.exe', 'node.exe') -and
        ([string]$_.CommandLine) -match 'physical_markdown_typist.py|stream_model_with_rotating_constraint.mjs'
    })
    if ($activeWorkers.Count) {
        throw "A stale or concurrent Markdown worker is still active: PID $($activeWorkers.ProcessId -join ', ')."
    }

    try {
        $before = Invoke-RestMethod "$api/api/document" -TimeoutSec 2
    } catch {
        throw "Markdown keyboard server is not running at $api."
    }

    [IO.File]::WriteAllText($queue, '', $utf8NoBom)
    [IO.File]::WriteAllText($ack, '', $utf8NoBom)
    [IO.File]::WriteAllText($typistLog, '', $utf8NoBom)
    [IO.File]::WriteAllText($typistErrorLog, '', $utf8NoBom)
    $timings = switch ($Speed) {
        'Visible' { @('32', '8', '30') }
        'Fast' { @('8', '3', '4') }
        'Maximum' { @('0', '1', '0') }
    }
    $python = (Get-Command python).Source
    $typist = Start-Process $python -ArgumentList @(
        '-B',
        (Join-Path $root 'physical_markdown_typist.py'),
        '--queue', $queue,
        '--log', $typistLog,
        '--api', $api,
        '--ack', $ack,
        '--move-ms', $timings[0],
        '--press-ms', $timings[1],
        '--pause-ms', $timings[2]
    ) -PassThru -WindowStyle Hidden -RedirectStandardError $typistErrorLog

    $readyDeadline = (Get-Date).AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 20
        $ready = (Test-Path $typistLog) -and
            ((Get-Content $typistLog -Raw -ErrorAction SilentlyContinue) -match '"status": "ready"')
    } until ($ready -or $typist.HasExited -or (Get-Date) -gt $readyDeadline)
    if (-not $ready) {
        $typistError = Get-Content $typistErrorLog -Raw -ErrorAction SilentlyContinue
        throw "Physical Markdown typist did not become ready. $typistError"
    }

    if ($before.content.Length -ne 0 -or $before.cursor -ne 0 -or $before.selectedCount -ne 0) {
        if (-not $PhysicalClear) {
            throw 'Run requires an empty document. Use -PhysicalClear to clear it through visible edit keys.'
        }
        [IO.File]::AppendAllText($queue, '{"command":"SELECT_ALL"}' + "`n", $utf8NoBom)
        [IO.File]::AppendAllText($queue, '{"command":"BACKSPACE"}' + "`n", $utf8NoBom)
        $clearDeadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 20
            $cleared = Invoke-RestMethod "$api/api/document" -TimeoutSec 2
        } until (($cleared.content.Length -eq 0 -and $cleared.cursor -eq 0) -or
            $typist.HasExited -or (Get-Date) -gt $clearDeadline)
        if ($cleared.content.Length -ne 0 -or $cleared.cursor -ne 0) {
            throw 'Physical clear did not converge to an empty document.'
        }
        Write-Host 'Cleared prior Markdown through visible Select All and Backspace keys.'
    }

    $constraint = Invoke-RestMethod "$api/api/constraint/reset" -Method Post -ContentType 'application/json' -Body '{}'
    Write-Host "Rotating constraint run: $($constraint.constraint.runId)"
    Write-Host "Physical keyboard speed: $Speed ($($timings -join '/') ms move/press/pause)"
    Write-Host "Initial missing letter: $($constraint.constraint.blockedLetter.ToUpper()) for 5 seconds"

    $previousApi = $env:MARKDOWN_KEYBOARD_API
    try {
        $env:MARKDOWN_KEYBOARD_API = $api
        & (Get-Command node).Source (Join-Path $root 'stream_model_with_rotating_constraint.mjs') $Prompt
        $nodeExitCode = $LASTEXITCODE
    } finally {
        if ($null -eq $previousApi) {
            Remove-Item Env:MARKDOWN_KEYBOARD_API -ErrorAction SilentlyContinue
        } else {
            $env:MARKDOWN_KEYBOARD_API = $previousApi
        }
    }
    if ($nodeExitCode -ne 0) { throw "Rotating constraint bridge exited with code $nodeExitCode." }

    $state = Invoke-RestMethod "$api/api/document" -TimeoutSec 2
    $statisticsPath = Join-Path $root 'output/rotating-letter-statistics.json'
    $statisticsSvgPath = Join-Path $root 'output/rotating-letter-statistics.svg'
    $statistics = Get-Content $statisticsPath -Raw | ConvertFrom-Json
    if ($statistics.runId -cne $constraint.constraint.runId -or
        $state.constraint.runId -cne $constraint.constraint.runId) {
        throw 'Constraint run identity changed before statistics publication.'
    }
    if (-not $statistics.exactFileMatch -or $statistics.sha256 -cne $state.sha256) {
        throw 'Final physical file does not match the rotating-run statistics artifact.'
    }
    if ($statistics.authoritativeAttemptDelta -ne $statistics.acknowledgedOperationAttempts) {
        throw 'Physical attempt accounting does not reconcile with the authoritative server.'
    }
    if (-not (Test-Path $statisticsSvgPath)) { throw 'Rotating-run SVG was not published.' }
    $svgHash = (Get-FileHash $statisticsSvgPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($svgHash -cne $statistics.statisticsSvgSha256) { throw 'Rotating-run JSON/SVG pair does not match.' }
    $archiveRoot = Join-Path $root 'output/rotating-runs'
    if (-not (Test-Path (Join-Path $archiveRoot "$($statistics.runId).md")) -or
        -not (Test-Path (Join-Path $archiveRoot "$($statistics.runId).json")) -or
        -not (Test-Path (Join-Path $archiveRoot "$($statistics.runId).svg"))) {
        throw 'Immutable per-run document/statistics bundle was not published.'
    }
    $archiveDocumentHash = (Get-FileHash (Join-Path $archiveRoot "$($statistics.runId).md") -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveDocumentHash -cne $statistics.documentArchiveSha256) {
        throw 'Immutable per-run Markdown archive does not match the physical document.'
    }
    Write-Host "Verified rotating document: $($state.charCount) characters at $($state.path)"
    Write-Host "SHA256: $($state.sha256)"
    Write-Host "Corrections: $($statistics.corrections); rotations: $($statistics.rotations)"
    Write-Host "Statistical graph: $statisticsSvgPath"
} finally {
    if ($null -ne $typist) {
        try { [IO.File]::AppendAllText($queue, '"__STOP__"' + "`n", $utf8NoBom) } catch {}
        try { $typist.WaitForExit(8000) | Out-Null } catch {}
        if (-not $typist.HasExited) {
            try { Stop-Process -Id $typist.Id -Force } catch {}
        }
    }
    if ($null -ne $runLock) {
        try { $runLock.Dispose() } catch {}
    }
}
