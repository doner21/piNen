# piNen One-Click Windows Installer
# Safe, idempotent, no-admin by default.
#
# One-liner usage:
# powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/doner21/piNen/main/install.ps1'; $f=Join-Path $env:TEMP 'pinen-install.ps1'; Invoke-WebRequest -UseBasicParsing $u -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f"
#
# Options:
#   -InstallDir <path>    Override default install location ($HOME\.pi)
#   -Force                Overwrite existing install (backs up first)
#   -ApplyCorePatch       Apply the Pi core patch after install
#   -DryRun               Show what would happen without making changes
#   -SkipEngram           Skip Engram download and setup
#   -PersistEnv           Persist ENGRAM_BIN to the user environment

param(
    [string]$InstallDir = "",
    [switch]$Force,
    [switch]$ApplyCorePatch,
    [switch]$DryRun,
    [switch]$SkipEngram,
    [switch]$PersistEnv
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# --- Constants ---
$SCRIPT_NAME = "piNen One-Click Installer"
$REPO_URL = "https://github.com/doner21/piNen.git"
$ENGRAM_VERSION = "v1.17.0"
$ENGRAM_ZIP_URL = "https://github.com/Gentleman-Programming/engram/releases/download/$ENGRAM_VERSION/engram_1.17.0_windows_amd64.zip"
$ENGRAM_SHA256 = "f0852549f5e3d000f1f39cd1648d4a4e3df3f489011937f6e92b148a9784782b"

if ($DryRun) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  $SCRIPT_NAME -- DRY RUN" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

# --- Install directory ---
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:USERPROFILE ".pi"
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

Write-Host ""
Write-Host "==> piNen install directory: $InstallDir" -ForegroundColor Cyan

# --- Existing install check ---
if (Test-Path $InstallDir) {
    $items = Get-ChildItem -Path $InstallDir -ErrorAction SilentlyContinue
    if ($items -and $items.Count -gt 0) {
        if (-not $Force) {
            if ($DryRun) {
                Write-Host "==> [DRY RUN] Existing install at $InstallDir would be detected." -ForegroundColor Cyan
                Write-Host "    Would require -Force to back up and overwrite." -ForegroundColor Cyan
            }
            else {
                Write-Host "==> ERROR: $InstallDir already exists and is non-empty." -ForegroundColor Red
                Write-Host "    Use -Force to back up the existing directory and proceed." -ForegroundColor Yellow
                Write-Host "    WARNING: Existing secrets/configs will be preserved ONLY in the backup." -ForegroundColor Yellow
                exit 1
            }
        }

        $backupDir = "$InstallDir-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Host "==> Backing up existing .pi to: $backupDir" -ForegroundColor Yellow
        if (-not $DryRun) {
            Move-Item -Path $InstallDir -Destination $backupDir -Force
            Write-Host "--> Backup complete. Existing secrets/configs preserved at $backupDir" -ForegroundColor Green
        }
    }
}

# --- Prerequisites check ---
Write-Host ""
Write-Host "==> Checking prerequisites..." -ForegroundColor Cyan

# Node.js
$nodeVersion = $null
try { $nodeVersion = & node --version 2>$null } catch { }
if (-not $nodeVersion) {
    Write-Host "--> Node.js not found." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "    Attempting to install Node.js via winget..." -ForegroundColor Yellow
        if (-not $DryRun) {
            winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        }
    }
    else {
        Write-Host "    ERROR: Node.js is required. Install from https://nodejs.org/" -ForegroundColor Red
        Write-Host "    Then rerun this installer." -ForegroundColor Red
        exit 1
    }
}
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nv = & node --version 2>$null
    Write-Host "--> Node.js: $nv" -ForegroundColor Green
}

# npm
if (Get-Command npm -ErrorAction SilentlyContinue) {
    $npmv = & npm --version 2>$null
    Write-Host "--> npm: v$npmv" -ForegroundColor Green
}

# Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    $gv = & git --version 2>$null
    Write-Host "--> Git: $gv" -ForegroundColor Green
}
else {
    Write-Host "--> Git not found." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "    Attempting to install Git via winget..." -ForegroundColor Yellow
        if (-not $DryRun) {
            winget install Git.Git --accept-source-agreements --accept-package-agreements
        }
    }
    else {
        Write-Host "    WARNING: Git is recommended. Install from https://git-scm.com/" -ForegroundColor Yellow
    }
}

# --- Install Pi harness ---
Write-Host ""
Write-Host "==> Installing Pi coding-agent harness..." -ForegroundColor Cyan

$piVersion = $null
try { $piVersion = & pi --version 2>$null } catch { }

if (-not $piVersion) {
    Write-Host "--> Installing @earendil-works/pi-coding-agent globally..." -ForegroundColor Yellow
    if (-not $DryRun) {
        npm install -g @earendil-works/pi-coding-agent
    }
    try { $piVersion = & pi --version 2>$null } catch { }
    if ($piVersion) {
        Write-Host "--> Pi installed: $piVersion" -ForegroundColor Green
    }
}
else {
    Write-Host "--> Pi already installed: $piVersion" -ForegroundColor Green
}

# --- Clone piNen repository ---
Write-Host ""
Write-Host "==> Cloning piNen repository..." -ForegroundColor Cyan

if (Get-Command git -ErrorAction SilentlyContinue) {
    if (-not $DryRun) {
        git clone --depth 1 $REPO_URL $InstallDir 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to clone repository." -ForegroundColor Red
            exit 1
        }
        Write-Host "--> Repository cloned to $InstallDir" -ForegroundColor Green
    }
    else {
        Write-Host "--> [DRY RUN] Would clone $REPO_URL to $InstallDir" -ForegroundColor Cyan
    }
}
else {
    Write-Host "--> Git unavailable. Downloading zip archive..." -ForegroundColor Yellow
    if (-not $DryRun) {
        $zipUrl = "https://github.com/doner21/piNen/archive/refs/heads/main.zip"
        $zipPath = Join-Path $env:TEMP "pinen-main.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zipPath
        Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
        Remove-Item $zipPath
        Write-Host "--> Zip archive extracted to $InstallDir" -ForegroundColor Green
    }
    else {
        Write-Host "--> [DRY RUN] Would download and extract main.zip to $InstallDir" -ForegroundColor Cyan
    }
}

# --- Install npm dependencies ---
Write-Host ""
Write-Host "==> Installing npm dependencies..." -ForegroundColor Cyan

if (-not $DryRun) {
    Set-Location $InstallDir
}
else {
    Write-Host "--> [DRY RUN] Would Set-Location to $InstallDir" -ForegroundColor Cyan
}

# Root
if (Test-Path (Join-Path $InstallDir "package.json")) {
    Write-Host "--> Installing root dependencies..." -ForegroundColor Yellow
    if (-not $DryRun) { npm install --no-audit --no-fund 2>&1 }
    else { Write-Host "    [DRY RUN] Would run: npm install" -ForegroundColor Cyan }
}
elseif ($DryRun) {
    Write-Host "--> [DRY RUN] Root package.json would be present after clone" -ForegroundColor Cyan
}

# agent/npm
if (Test-Path (Join-Path $InstallDir "agent/npm/package.json")) {
    Write-Host "--> Installing agent/npm dependencies..." -ForegroundColor Yellow
    if (-not $DryRun) {
        Push-Location (Join-Path $InstallDir "agent/npm")
        if (Test-Path "package-lock.json") {
            npm ci --no-audit --no-fund 2>&1
        }
        else {
            npm install --no-audit --no-fund 2>&1
        }
        Pop-Location
    }
    else { Write-Host "    [DRY RUN] Would run: npm ci in agent/npm" -ForegroundColor Cyan }
}
elseif ($DryRun) {
    Write-Host "--> [DRY RUN] agent/npm/package.json would be present after clone" -ForegroundColor Cyan
}

# agent/extensions
if (Test-Path (Join-Path $InstallDir "agent/extensions/package.json")) {
    Write-Host "--> Installing agent/extensions dependencies..." -ForegroundColor Yellow
    if (-not $DryRun) {
        Push-Location (Join-Path $InstallDir "agent/extensions")
        if (Test-Path "package-lock.json") {
            npm ci --no-audit --no-fund 2>&1
        }
        else {
            npm install --no-audit --no-fund 2>&1
        }
        Pop-Location
    }
    else { Write-Host "    [DRY RUN] Would run: npm ci in agent/extensions" -ForegroundColor Cyan }
}
elseif ($DryRun) {
    Write-Host "--> [DRY RUN] agent/extensions/package.json would be present after clone" -ForegroundColor Cyan
}

# agent/spotify-mcp
if (Test-Path (Join-Path $InstallDir "agent/spotify-mcp/package.json")) {
    Write-Host "--> Installing agent/spotify-mcp dependencies..." -ForegroundColor Yellow
    if (-not $DryRun) {
        Push-Location (Join-Path $InstallDir "agent/spotify-mcp")
        if (Test-Path "package-lock.json") {
            npm ci --no-audit --no-fund 2>&1
        }
        npm run build 2>&1
        Pop-Location
    }
    else { Write-Host "    [DRY RUN] Would run: npm ci + npm run build in agent/spotify-mcp" -ForegroundColor Cyan }
}
elseif ($DryRun) {
    Write-Host "--> [DRY RUN] agent/spotify-mcp/package.json would be present after clone" -ForegroundColor Cyan
}

# --- Engram setup ---
if (-not $SkipEngram) {
    Write-Host ""
    Write-Host "==> Setting up Engram memory..." -ForegroundColor Cyan

    $engramDir = Join-Path $InstallDir "agent\bin"
    $engramBin = Join-Path $engramDir "engram.exe"

    if (Test-Path $engramBin) {
        Write-Host "--> Engram binary already present at $engramBin" -ForegroundColor Green
    }
    else {
        Write-Host "--> Downloading Engram $ENGRAM_VERSION from GitHub releases..." -ForegroundColor Yellow
        if (-not $DryRun) {
            if (-not (Test-Path $engramDir)) {
                New-Item -ItemType Directory -Path $engramDir -Force | Out-Null
            }

            $zipPath = Join-Path $env:TEMP "engram-windows-amd64.zip"
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $ENGRAM_ZIP_URL -OutFile $zipPath
                Write-Host "--> Engram zip downloaded" -ForegroundColor Green

                # Verify SHA256
                $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
                if ($actualHash -ne $ENGRAM_SHA256) {
                    Write-Host "--> ERROR: SHA256 verification FAILED!" -ForegroundColor Red
                    Write-Host "    Expected: $ENGRAM_SHA256" -ForegroundColor Red
                    Write-Host "    Actual:   $actualHash" -ForegroundColor Red
                    Write-Host "    The downloaded file may be corrupted or tampered with." -ForegroundColor Red
                    Write-Host "    Aborting Engram installation for safety." -ForegroundColor Red
                    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
                    $engramInstallFailed = $true
                }
                else {
                    Write-Host "--> SHA256 verified OK" -ForegroundColor Green
                    Expand-Archive -Path $zipPath -DestinationPath $engramDir -Force
                    Remove-Item $zipPath -Force

                    if (Test-Path $engramBin) {
                        Write-Host "--> Engram extracted to $engramBin" -ForegroundColor Green
                    }
                    else {
                        Write-Host "--> WARNING: engram.exe not found in zip archive" -ForegroundColor Yellow
                        Write-Host "    The zip contents may have changed structure." -ForegroundColor Yellow
                        $engramInstallFailed = $true
                    }
                }
            }
            catch {
                Write-Host "--> WARNING: Could not download Engram automatically." -ForegroundColor Yellow
                Write-Host "    Download manually from: https://github.com/Gentleman-Programming/engram/releases" -ForegroundColor Yellow
                Write-Host "    Place the binary at: $engramBin" -ForegroundColor Yellow
                $engramInstallFailed = $true
            }
        }
    }

    # Set ENGRAM_BIN for this installer process. Persistence is opt-in.
    if (Test-Path $engramBin) {
        $env:ENGRAM_BIN = $engramBin
        Write-Host "--> ENGRAM_BIN set for the installer process" -ForegroundColor Green

        if ($PersistEnv) {
            try {
                [Environment]::SetEnvironmentVariable("ENGRAM_BIN", $engramBin, [EnvironmentVariableTarget]::User)
                Write-Host "--> ENGRAM_BIN persisted to user environment" -ForegroundColor Green
            }
            catch {
                Write-Host "--> WARNING: Could not persist ENGRAM_BIN to user environment" -ForegroundColor Yellow
                Write-Host "    You may need to set it manually: setx ENGRAM_BIN `"$engramBin`"" -ForegroundColor Yellow
            }
        }
        else {
            Write-Host "--> ENGRAM_BIN was not persisted (use -PersistEnv to opt in)." -ForegroundColor Cyan
            Write-Host "    The default MCP template also discovers Engram at this install path." -ForegroundColor Cyan
        }
    }
}

# --- Config scaffolding ---
Write-Host ""
Write-Host "==> Setting up configuration templates..." -ForegroundColor Cyan

$configFiles = @(
    @{ Example = "agent\auth.example.json"; Target = "agent\auth.json" },
    @{ Example = "agent\mcp.example.json"; Target = "agent\mcp.json" }
)

foreach ($cfg in $configFiles) {
    $examplePath = Join-Path $InstallDir $cfg.Example
    $targetPath = Join-Path $InstallDir $cfg.Target

    if (Test-Path $examplePath) {
        if (Test-Path $targetPath) {
            Write-Host "--> $($cfg.Target) already exists (skipping)" -ForegroundColor Green
        }
        else {
            Write-Host "--> Creating $($cfg.Target) from template" -ForegroundColor Yellow
            if (-not $DryRun) {
                Copy-Item $examplePath $targetPath
            }
            else {
                Write-Host "    [DRY RUN] Would copy $($cfg.Example) to $($cfg.Target)" -ForegroundColor Cyan
            }
        }
    }
    elseif ($DryRun) {
        Write-Host "--> [DRY RUN] $($cfg.Example) would be present after clone" -ForegroundColor Cyan
    }
}

Write-Host "--> IMPORTANT: Edit agent/auth.json and agent/mcp.json with your API keys!" -ForegroundColor Yellow
Write-Host "    Never commit these files -- they are gitignored." -ForegroundColor Yellow

# --- Core patch ---
if ($ApplyCorePatch) {
    Write-Host ""
    Write-Host "==> Applying Pi core patch..." -ForegroundColor Cyan

    $patcher = Join-Path $InstallDir "agent\core-patch\reapply-pi-core-patch.mjs"
    if (Test-Path $patcher) {
        if (-not $DryRun) {
            node $patcher 2>&1
        }
        $verifier = Join-Path $InstallDir "agent\core-patch\verify-patch-command-registration.mjs"
        if (Test-Path $verifier) {
            if (-not $DryRun) {
                node $verifier 2>&1
            }
        }
        Write-Host "--> Core patch applied" -ForegroundColor Green
    }
}

# --- Done ---
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  piNen installation complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Add your API keys to:" -ForegroundColor White
Write-Host "     $InstallDir\agent\auth.json" -ForegroundColor White
Write-Host "     $InstallDir\agent\mcp.json" -ForegroundColor White
Write-Host ""
Write-Host "  2. Start Pi:" -ForegroundColor White
Write-Host "     pi" -ForegroundColor White
Write-Host ""
Write-Host "  Optional:" -ForegroundColor Cyan
Write-Host "  - Apply core patch: rerun with -ApplyCorePatch" -ForegroundColor White
Write-Host ""
if ($PersistEnv) {
    Write-Host "  ENGRAM_BIN has been persisted to your user environment." -ForegroundColor Green
    Write-Host "  Restart your terminal for it to take effect everywhere." -ForegroundColor Yellow
}
else {
    Write-Host "  ENGRAM_BIN was not persisted. Use -PersistEnv if you want that." -ForegroundColor Cyan
}
Write-Host ""
Write-Host "  For help, see:" -ForegroundColor Cyan
Write-Host "  - docs\INSTALL_WINDOWS.md" -ForegroundColor White
Write-Host "  - docs\CONFIGURATION.md" -ForegroundColor White
Write-Host ""
