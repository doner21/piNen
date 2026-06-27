#!/usr/bin/env bash
# piNen One-Click Installer (Unix/macOS convenience wrapper)
# For full functionality, use git clone + agent/setup.sh
set -euo pipefail

INSTALL_DIR="${PI_HOME:-$HOME/.pi}"
REPO_URL="https://github.com/doner21/piNen.git"

echo "========================================"
echo "  piNen One-Click Installer (Unix)"
echo "========================================"
echo ""
echo "Install directory: ${INSTALL_DIR}"

if [ -d "${INSTALL_DIR}" ] && [ "$(ls -A "${INSTALL_DIR}" 2>/dev/null)" ]; then
  echo "ERROR: ${INSTALL_DIR} already exists and is non-empty."
  echo "  Set PI_HOME to a different directory, or remove the existing install."
  exit 1
fi

# Clone repository
echo "==> Cloning piNen repository..."
git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"

cd "${INSTALL_DIR}"

# Install npm dependencies
echo "==> Installing npm dependencies..."
if [ -f "package.json" ]; then
  npm install --no-audit --no-fund
fi

if [ -f "agent/npm/package.json" ]; then
  (cd agent/npm && npm install --no-audit --no-fund)
fi

if [ -f "agent/extensions/package.json" ]; then
  (cd agent/extensions && npm install --no-audit --no-fund)
fi

if [ -f "agent/spotify-mcp/package.json" ]; then
  (cd agent/spotify-mcp && npm install --no-audit --no-fund && npm run build)
fi

# Install Pi globally
echo "==> Installing Pi coding-agent..."
if ! command -v pi &>/dev/null; then
  npm install -g @earendil-works/pi-coding-agent
fi

# Bootstrap
echo "==> Bootstrapping piNen..."
bash agent/setup.sh "$@"

echo ""
echo "========================================"
echo "  piNen installation complete!"
echo "========================================"
echo ""
echo "  Next steps:"
echo "  1. Add your API keys to:"
echo "     ${INSTALL_DIR}/agent/auth.json"
echo "     ${INSTALL_DIR}/agent/mcp.json"
echo "  2. Start Pi:"
echo "     pi"
echo ""
echo "  To persist ENGRAM_BIN:"
echo "    bash agent/setup.sh --persist-env"
echo ""
