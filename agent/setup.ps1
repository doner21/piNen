# piNen bootstrap — run once after cloning
# Safe to rerun: checks for existing state before modifying.
param(
    [switch]$PersistEnv,       # Opt-in: persist ENGRAM_BIN to user environment
    [switch]$ApplyCorePatch,   # Opt-in: apply the Pi core patch
    [switch]$DryRun            # Show what would happen without making changes
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PiHome = Split-Path -Parent $ScriptDir

if ($DryRun) {
    Write-Host "==> DRY RUN: piNen bootstrap from $PiHome (no changes will be made)" -ForegroundColor Cyan
    $DryRun = $true
} else {
    Write-Host "==> Bootstrapping piNen from $PiHome" -ForegroundColor Cyan
}

# --- npm dependencies ---
$npmPkg = Join-Path $ScriptDir "npm\package.json"
if (Test-Path $npmPkg) {
    Write-Host "==> Installing Pi npm packages (gentle-engram, pi-mcp-adapter)..." -ForegroundColor Yellow
    if (-not $DryRun) {
        Push-Location (Join-Path $ScriptDir "npm")
        npm install --no-audit --no-fund
        Pop-Location
    }
}

$extPkg = Join-Path $ScriptDir "extensions\package.json"
if (Test-Path $extPkg) {
    Write-Host "==> Installing Pi extension dependencies..." -ForegroundColor Yellow
    if (-not $DryRun) {
        Push-Location (Join-Path $ScriptDir "extensions")
        npm install --no-audit --no-fund
        Pop-Location
    }
}

# --- Engram memory setup ---
$engramBin = Join-Path $ScriptDir "bin\engram.exe"

if (Test-Path $engramBin) {
    Write-Host "==> Engram binary found at $engramBin" -ForegroundColor Green

    # Set ENGRAM_BIN for current session
    $env:ENGRAM_BIN = $engramBin

    # Persist to user environment variable (only with --PersistEnv)
    if ($PersistEnv) {
        try {
            [Environment]::SetEnvironmentVariable("ENGRAM_BIN", $engramBin, [EnvironmentVariableTarget]::User)
            Write-Host "--> ENGRAM_BIN persisted to user environment" -ForegroundColor Green
        } catch {
            Write-Host "--> WARNING: Could not persist ENGRAM_BIN to user environment (may need admin)" -ForegroundColor Yellow
            Write-Host "    Set it manually:" -ForegroundColor Yellow
            Write-Host "    [Environment]::SetEnvironmentVariable('ENGRAM_BIN', '$engramBin', 'User')" -ForegroundColor Yellow
        }
    } else {
        Write-Host "--> ENGRAM_BIN set for current session only." -ForegroundColor Cyan
        Write-Host "    To persist across sessions, rerun with -PersistEnv" -ForegroundColor Cyan
    }

    Write-Host ""
    Write-Host "    To set per-session only (no admin):" -ForegroundColor Cyan
    Write-Host "    `$env:ENGRAM_BIN = '$engramBin'" -ForegroundColor Cyan

} elseif (Test-Path (Join-Path $ScriptDir "bin\engram")) {
    $engramNix = Join-Path $ScriptDir "bin\engram"
    Write-Host "==> Engram binary found at $engramNix" -ForegroundColor Green
    $env:ENGRAM_BIN = $engramNix

    if ($PersistEnv) {
        try {
            [Environment]::SetEnvironmentVariable("ENGRAM_BIN", $engramNix, [EnvironmentVariableTarget]::User)
            Write-Host "--> ENGRAM_BIN persisted to user environment" -ForegroundColor Green
        } catch {
            Write-Host "--> WARNING: Could not persist ENGRAM_BIN" -ForegroundColor Yellow
        }
    } else {
        Write-Host "--> ENGRAM_BIN set for current session only." -ForegroundColor Cyan
        Write-Host "    To persist across sessions, rerun with -PersistEnv" -ForegroundColor Cyan
    }
} else {
    Write-Host "==> WARNING: Engram binary not found in agent\bin\" -ForegroundColor Red
    Write-Host "    Run the one-click installer (install.ps1) to download Engram, or" -ForegroundColor Yellow
    Write-Host "    download manually from: https://github.com/Gentleman-Programming/engram/releases" -ForegroundColor Yellow
}

# --- Core patch ---
$patcherScript = Join-Path $ScriptDir "core-patch\reapply-pi-core-patch.mjs"
if ($ApplyCorePatch -and (Test-Path $patcherScript)) {
    Write-Host "==> Applying Pi core patch..." -ForegroundColor Yellow
    if (-not $DryRun) {
        node $patcherScript
    }
    $verifyScript = Join-Path $ScriptDir "core-patch\verify-patch-command-registration.mjs"
    if (Test-Path $verifyScript) {
        Write-Host "==> Verifying core patch..." -ForegroundColor Yellow
        if (-not $DryRun) {
            node $verifyScript
        }
    }
} elseif (Test-Path $patcherScript) {
    Write-Host "--> Core patcher available. Run with -ApplyCorePatch to apply." -ForegroundColor Cyan
}

Write-Host ""
Write-Host "==> piNen bootstrap complete." -ForegroundColor Green
Write-Host ""
Write-Host "    Restart Pi and verify Engram memory:" -ForegroundColor Cyan
Write-Host "      mem_context" -ForegroundColor Cyan
Write-Host ""
Write-Host "    If Engram is unavailable, set ENGRAM_BIN manually:" -ForegroundColor Yellow
Write-Host "      `$env:ENGRAM_BIN = '$engramBin'" -ForegroundColor Yellow
