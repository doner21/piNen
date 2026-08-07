# Pi-config bootstrap — run once after cloning
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PiHome = Split-Path -Parent $ScriptDir

Write-Host "==> Bootstrapping Pi-config from $PiHome" -ForegroundColor Cyan

# --- npm dependencies ---
$npmPkg = Join-Path $ScriptDir "npm\package.json"
if (Test-Path $npmPkg) {
    Write-Host "==> Installing Pi npm packages (gentle-engram, pi-mcp-adapter)..." -ForegroundColor Yellow
    Push-Location (Join-Path $ScriptDir "npm")
    npm install --no-audit --no-fund
    Pop-Location
}

$extPkg = Join-Path $ScriptDir "extensions\package.json"
if (Test-Path $extPkg) {
    Write-Host "==> Installing Pi extension dependencies..." -ForegroundColor Yellow
    Push-Location (Join-Path $ScriptDir "extensions")
    npm install --no-audit --no-fund
    Pop-Location
}

# --- Engram memory setup ---
$engramBin = Join-Path $ScriptDir "bin\engram.exe"

if (Test-Path $engramBin) {
    Write-Host "==> Engram binary found at $engramBin" -ForegroundColor Green

    # Set ENGRAM_BIN for current session
    $env:ENGRAM_BIN = $engramBin

    # Persist to user environment variable
    try {
        [Environment]::SetEnvironmentVariable("ENGRAM_BIN", $engramBin, [EnvironmentVariableTarget]::User)
        Write-Host "--> ENGRAM_BIN persisted to user environment" -ForegroundColor Green
    } catch {
        Write-Host "--> WARNING: Could not persist ENGRAM_BIN to user environment (may need admin)" -ForegroundColor Yellow
        Write-Host "    Set it manually:" -ForegroundColor Yellow
        Write-Host "    [Environment]::SetEnvironmentVariable('ENGRAM_BIN', '$engramBin', 'User')" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "    To set per-session only (no admin):" -ForegroundColor Cyan
    Write-Host "    `$env:ENGRAM_BIN = `"$engramBin`"" -ForegroundColor Cyan

} elseif (Test-Path (Join-Path $ScriptDir "bin\engram")) {
    $engramNix = Join-Path $ScriptDir "bin\engram"
    Write-Host "==> Engram binary found at $engramNix" -ForegroundColor Green
    $env:ENGRAM_BIN = $engramNix
    try {
        [Environment]::SetEnvironmentVariable("ENGRAM_BIN", $engramNix, [EnvironmentVariableTarget]::User)
        Write-Host "--> ENGRAM_BIN persisted to user environment" -ForegroundColor Green
    } catch {
        Write-Host "--> WARNING: Could not persist ENGRAM_BIN" -ForegroundColor Yellow
    }
} else {
    Write-Host "==> WARNING: Engram binary not found in agent\bin\" -ForegroundColor Red
    Write-Host "    Download from: https://github.com/Gentleman-Programming/engram/releases"
}

Write-Host ""
Write-Host "==> Pi-config bootstrap complete." -ForegroundColor Green
Write-Host ""
Write-Host "    Restart Pi and verify Engram memory:" -ForegroundColor Cyan
Write-Host "      mem_context" -ForegroundColor Cyan
Write-Host ""
Write-Host "    If Engram is unavailable, set ENGRAM_BIN manually:" -ForegroundColor Yellow
Write-Host "      `$env:ENGRAM_BIN = `"$engramBin`"" -ForegroundColor Yellow
