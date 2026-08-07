#!/usr/bin/env bash
# Pi-config bootstrap — run once after cloning
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Bootstrapping Pi-config from ${PI_HOME}"

# --- npm dependencies ---
if [ -f "${SCRIPT_DIR}/npm/package.json" ]; then
  echo "==> Installing Pi npm packages (gentle-engram, pi-mcp-adapter)..."
  (cd "${SCRIPT_DIR}/npm" && npm install --no-audit --no-fund)
fi

if [ -f "${SCRIPT_DIR}/extensions/package.json" ]; then
  echo "==> Installing Pi extension dependencies..."
  (cd "${SCRIPT_DIR}/extensions" && npm install --no-audit --no-fund)
fi

# --- Engram memory setup ---
ENGRAM_BIN_PATH="${SCRIPT_DIR}/bin/engram"
ENGRAM_BIN_WIN="${SCRIPT_DIR}/bin/engram.exe"

if [ -f "${ENGRAM_BIN_WIN}" ]; then
  echo "==> Engram binary found at ${ENGRAM_BIN_WIN}"
  echo ""
  echo "--> Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo "    export ENGRAM_BIN=\"${ENGRAM_BIN_WIN}\""
  echo ""
  echo "    Or on Windows (PowerShell profile):"
  echo "    \$env:ENGRAM_BIN = \"${ENGRAM_BIN_WIN}\""
elif [ -f "${ENGRAM_BIN_PATH}" ]; then
  echo "==> Engram binary found at ${ENGRAM_BIN_PATH}"
  echo ""
  echo "--> Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo "    export ENGRAM_BIN=\"${ENGRAM_BIN_PATH}\""
fi

# Auto-append ENGRAM_BIN to .bashrc if not present
if [ -f "${ENGRAM_BIN_PATH}" ] || [ -f "${ENGRAM_BIN_WIN}" ]; then
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
    if [ -f "${rc}" ] && ! grep -q "ENGRAM_BIN" "${rc}" 2>/dev/null; then
      echo "export ENGRAM_BIN=\"${ENGRAM_BIN_PATH}\"  # Pi Engram memory" >> "${rc}"
      echo "--> Appended ENGRAM_BIN to ${rc}"
    fi
  done
fi

echo ""
echo "==> Pi-config bootstrap complete."
echo ""
echo "    Restart Pi and verify Engram memory:"
echo "      mem_context"
echo ""
echo "    If Pi says Engram is unavailable, set ENGRAM_BIN manually:"
echo "      export ENGRAM_BIN=\"${ENGRAM_BIN_PATH}\""
