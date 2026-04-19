#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
echo "[CubePanel] Setup..."
mkdir -p .cubepanel server
[ ! -f server/eula.txt ] && echo "eula=true" > server/eula.txt
# Root package.json + install — only @supabase/supabase-js (NO node-pty, NO native compile)
if [ ! -f package.json ]; then
  printf '{
  "name": "cubepanel-server",
  "private": true,
  "dependencies": { "@supabase/supabase-js": "^2.45.0" }
}
' > package.json
fi
echo "[CubePanel] npm install (root)..."
npm install --silent --no-audit --no-fund 2>&1 | tail -10 || true
# playit.gg binary at repo root (used by agent.js)
if [ ! -f playit ]; then
  echo "[CubePanel] A descarregar playit.gg..."
  curl -sSL -o playit "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64" || echo "[CubePanel] falhou playit download (não-fatal)"
  chmod +x playit 2>/dev/null || true
fi
echo "[CubePanel] Ready. Para arrancar manualmente: node agent.js"
