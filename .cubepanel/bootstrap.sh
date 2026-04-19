#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
echo "[CubePanel] Setup..."
mkdir -p .cubepanel server
[ ! -f server/eula.txt ] && echo "eula=true" > server/eula.txt
cd .cubepanel
# Install minimal deps for the agent (no native modules → fast install)
[ ! -d node_modules ] && npm install --silent --no-audit --no-fund unzipper 2>&1 | tail -5 || true
echo "[CubePanel] Ready."
