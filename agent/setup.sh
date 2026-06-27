#!/usr/bin/env bash
# piNen bootstrap — run once after cloning
# Requires --persist-env or PINEN_PERSIST_ENV=1 to persist ENGRAM_BIN to shell profiles.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=false
PERSIST_ENV="${PINEN_PERSIST_ENV:-0}"
APPLY_CORE_PATCH=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --persist-env) PERSIST_ENV=1 ;;
    --apply-core-patch) APPLY_CORE_PATCH=true ;;
  esac
done

if [ "$DRY_RUN" = true ]; then
  echo "==> DRY RUN: piNen bootstrap from ${PI_HOME} (no changes will be made)"
fi

echo "==> Bootstrapping piNen from ${PI_HOME}"

# --- npm dependencies ---
if [ -f "${SCRIPT_DIR}/npm/package.json" ]; then
  echo "==> Installing Pi npm packages (gentle-engram, pi-mcp-adapter)..."
  if [ "$DRY_RUN" = false ]; then
    (cd "${SCRIPT_DIR}/npm" && npm install --no-audit --no-fund)
  fi
fi

if [ -f "${SCRIPT_DIR}/extensions/package.json" ]; then
  echo "==> Installing Pi extension dependencies..."
  if [ "$DRY_RUN" = false ]; then
    (cd "${SCRIPT_DIR}/extensions" && npm install --no-audit --no-fund)
  fi
fi

# --- Engram memory setup ---
ENGRAM_BIN_PATH="${SCRIPT_DIR}/bin/engram"
ENGRAM_BIN_WIN="${SCRIPT_DIR}/bin/engram.exe"

if [ -f "${ENGRAM_BIN_WIN}" ]; then
  echo "==> Engram binary found at ${ENGRAM_BIN_WIN}"
  echo ""
  echo "--> To use Engram, set ENGRAM_BIN in your shell:"
  echo "    export ENGRAM_BIN=\"${ENGRAM_BIN_WIN}\""
  echo ""
  echo "    Or on Windows (PowerShell):"
  echo "    \$env:ENGRAM_BIN = \"${ENGRAM_BIN_WIN}\""

  # Only persist profile with opt-in
  if [ "${PERSIST_ENV}" = "1" ]; then
    for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
      if [ -f "${rc}" ] && ! grep -q "ENGRAM_BIN" "${rc}" 2>/dev/null; then
        echo "export ENGRAM_BIN=\"${ENGRAM_BIN_PATH}\"  # piNen Engram memory" >> "${rc}"
        echo "--> Appended ENGRAM_BIN to ${rc}"
      fi
    done
  else
    echo ""
    echo "--> To persist ENGRAM_BIN across sessions, rerun with --persist-env"
    echo "    or set PINEN_PERSIST_ENV=1"
  fi

elif [ -f "${ENGRAM_BIN_PATH}" ]; then
  echo "==> Engram binary found at ${ENGRAM_BIN_PATH}"
  echo ""
  echo "--> To use Engram, set ENGRAM_BIN in your shell:"
  echo "    export ENGRAM_BIN=\"${ENGRAM_BIN_PATH}\""

  if [ "${PERSIST_ENV}" = "1" ]; then
    for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
      if [ -f "${rc}" ] && ! grep -q "ENGRAM_BIN" "${rc}" 2>/dev/null; then
        echo "export ENGRAM_BIN=\"${ENGRAM_BIN_PATH}\"  # piNen Engram memory" >> "${rc}"
        echo "--> Appended ENGRAM_BIN to ${rc}"
      fi
    done
  else
    echo ""
    echo "--> To persist ENGRAM_BIN across sessions, rerun with --persist-env"
    echo "    or set PINEN_PERSIST_ENV=1"
  fi
else
  echo "==> WARNING: Engram binary not found in agent/bin/"
  echo "    Run the one-click installer (install.sh) to download Engram, or"
  echo "    download manually from: https://github.com/Gentleman-Programming/engram/releases"
fi

# --- Core patch ---
PATCHER_SCRIPT="${SCRIPT_DIR}/core-patch/reapply-pi-core-patch.mjs"
if [ "${APPLY_CORE_PATCH}" = true ] && [ -f "${PATCHER_SCRIPT}" ]; then
  echo "==> Applying Pi core patch..."
  if [ "$DRY_RUN" = false ]; then
    node "${PATCHER_SCRIPT}"
  fi

  VERIFY_SCRIPT="${SCRIPT_DIR}/core-patch/verify-patch-command-registration.mjs"
  if [ -f "${VERIFY_SCRIPT}" ]; then
    echo "==> Verifying core patch..."
    if [ "$DRY_RUN" = false ]; then
      node "${VERIFY_SCRIPT}"
    fi
  fi
elif [ -f "${PATCHER_SCRIPT}" ]; then
  echo "--> Core patcher available. Run with --apply-core-patch to apply."
fi

echo ""
echo "==> piNen bootstrap complete."
echo ""
echo "    Restart Pi and verify Engram memory:"
echo "      mem_context"
echo ""
echo "    If Engram is unavailable, set ENGRAM_BIN manually:"
echo "      export ENGRAM_BIN=\"${ENGRAM_BIN_PATH}\""
