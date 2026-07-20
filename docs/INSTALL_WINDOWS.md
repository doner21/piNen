# Windows Installation Guide

This guide covers installing piNen on Windows via the one-click installer or
manual clone+bootstrap.

## One-Click Install

Open **PowerShell** (not PowerShell ISE) and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/doner21/piNen/main/install.ps1'; $f=Join-Path $env:TEMP 'pinen-install.ps1'; Invoke-WebRequest -UseBasicParsing $u -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f"
```

**This command:**
1. Downloads `install.ps1` to a temp file (not `Invoke-Expression` — auditable)
2. Executes the downloaded script
3. The script handles everything: prerequisites, cloning, npm installs, Engram setup

### Install Options

| Flag | Description |
|------|-------------|
| `-InstallDir <path>` | Install to a custom directory (default: `$HOME\.pi`) |
| `-Force` | Overwrite an existing install (creates timestamped backup) |
| `-ApplyCorePatch` | Apply the Pi core patch after install |
| `-SkipEngram` | Skip Engram download and setup |
| `-PersistEnv` | Opt in to persisting `ENGRAM_BIN` in the user environment |
| `-DryRun` | Show what would happen without making changes |

**Example with options:**

```powershell
$u='https://raw.githubusercontent.com/doner21/piNen/main/install.ps1'
$f=Join-Path $env:TEMP 'pinen-install.ps1'
Invoke-WebRequest -UseBasicParsing $u -OutFile $f
powershell -NoProfile -ExecutionPolicy Bypass -File $f -ApplyCorePatch
```

## Manual Install

If you prefer to clone and bootstrap manually:

```powershell
git clone https://github.com/doner21/piNen.git $HOME\.pi
cd $HOME\.pi
.\agent\setup.ps1
```

With core patch:

```powershell
.\agent\setup.ps1 -ApplyCorePatch
```

## Prerequisites

The installer checks for these and attempts to install missing ones via `winget`:
- **Node.js** (required) — https://nodejs.org/
- **npm** (bundled with Node.js)
- **Git** (recommended) — https://git-scm.com/
- **winget** (optional, used for automatic prerequisite installation)

## After Install

### 1. API Keys

Copy the example configs and add your own keys:

```powershell
Copy-Item $HOME\.pi\agent\auth.example.json $HOME\.pi\agent\auth.json
Copy-Item $HOME\.pi\agent\mcp.example.json $HOME\.pi\agent\mcp.json
# Edit the files with your text editor
```

### 2. Core Patch (orchestration support)

```powershell
node $HOME\.pi\agent\core-patch\reapply-pi-core-patch.mjs
node $HOME\.pi\agent\core-patch\verify-patch-command-registration.mjs
```

Or:
```powershell
$HOME\.pi\agent\setup.ps1 -ApplyCorePatch
```

### 3. Start Pi

```powershell
pi
```

## Engram Memory

The one-click installer downloads Engram automatically from GitHub releases.
It places the binary at `$HOME\.pi\agent\bin\engram.exe`.

**Verify Engram is working:**

```
mem_context
```

**If Engram is unavailable:**
1. Ensure `$env:ENGRAM_BIN` is set
2. Run `mem_doctor` to diagnose
3. Reinstall with the installer or download manually

### Manual Engram Setup

Engram is pinned to **v1.17.0** with SHA256 verification. The installer
handles this automatically; for manual setup:

```powershell
$ENGRAM_VERSION = "v1.17.0"
$ENGRAM_SHA256 = "f0852549f5e3d000f1f39cd1648d4a4e3df3f489011937f6e92b148a9784782b"
$ENGRAM_ZIP_URL = "https://github.com/Gentleman-Programming/engram/releases/download/$ENGRAM_VERSION/engram_1.17.0_windows_amd64.zip"
$ENGRAM_PATH = "$env:USERPROFILE\.pi\agent\bin\engram.exe"

# Create target directory
New-Item -ItemType Directory -Path (Split-Path $ENGRAM_PATH) -Force | Out-Null

# Download and verify
$zipPath = Join-Path $env:TEMP "engram-windows-amd64.zip"
Invoke-WebRequest -UseBasicParsing -Uri $ENGRAM_ZIP_URL -OutFile $zipPath
$actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
if ($actualHash -ne $ENGRAM_SHA256) {
    Write-Host "SHA256 verification FAILED! Aborting." -ForegroundColor Red
    exit 1
}
Write-Host "SHA256 verified OK" -ForegroundColor Green
Expand-Archive -Path $zipPath -DestinationPath (Split-Path $ENGRAM_PATH) -Force
Remove-Item $zipPath
$env:ENGRAM_BIN = $ENGRAM_PATH

# Persist across sessions (no admin required)
[Environment]::SetEnvironmentVariable("ENGRAM_BIN", $ENGRAM_PATH, "User")
```

## Updating piNen

To update the harness to the latest version:

```powershell
cd $HOME\.pi
git pull origin main
.\agent\setup.ps1
```

## Uninstalling

Delete the install directory:

```powershell
Remove-Item -Recurse -Force $HOME\.pi
```

If you persisted `ENGRAM_BIN`, remove the environment variable:

```powershell
[Environment]::SetEnvironmentVariable("ENGRAM_BIN", $null, "User")
```

To remove the global Pi package:

```powershell
npm uninstall -g @earendil-works/pi-coding-agent
```

## Troubleshooting

### "pi is not recognized"
Ensure npm's global bin directory is on your PATH. Usually:
`%APPDATA%\npm`

### "ENGRAM_BIN is not set"
ENGRAM_BIN is automatically persisted by the installer. If missing:

```powershell
$env:ENGRAM_BIN = "$env:USERPROFILE\.pi\agent\bin\engram.exe"
[Environment]::SetEnvironmentVariable("ENGRAM_BIN", $env:ENGRAM_BIN, "User")
```

### "PowerShell execution policy"
The one-click command uses `-ExecutionPolicy Bypass` for the installer only.
This does not change your system policy.

### "Permission denied" / "Access denied"
The installer does not require admin privileges. If you see permission errors,
check that no process is using Pi or the install directory.
