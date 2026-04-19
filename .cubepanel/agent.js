#!/usr/bin/env node
// CubePanel Agent — runs inside Codespace.
// Spawns java, pipes stdio, parses logs, reports metrics + player events.
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const SUPABASE_URL = process.env.CUBEPANEL_SUPABASE_URL;
const AGENT_TOKEN = process.env.CUBEPANEL_AGENT_TOKEN;
const SERVER_DIR = path.resolve(__dirname, "..", "server");
const JAR_URL_FILE = path.join(__dirname, "jar_url.txt");
const IMPORT_FILE = path.join(__dirname, "import.json");

if (!SUPABASE_URL || !AGENT_TOKEN) {
  console.error("[CubePanel] Missing CUBEPANEL_SUPABASE_URL or CUBEPANEL_AGENT_TOKEN");
  process.exit(1);
}

let mc = null;
const players = new Map(); // name -> { joined_at, uuid }
let startedAt = null;
let lastTps = 20;
let lastCpu = 0;
const LOG_BUF = [];

function api(method, path, body, headers) {
  return new Promise((resolve) => {
    const url = new URL(SUPABASE_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname: url.hostname, path: url.pathname + url.search,
      headers: Object.assign({
        "X-Agent-Token": AGENT_TOKEN,
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      }, headers || {}),
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

const post = (path, body) => api("POST", path, body);
const get = (path) => api("GET", path);

let publicAddress = null;

async function reportMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const cpus = os.cpus().length || 1;
  const load = os.loadavg()[0];
  lastCpu = Math.min(100, Math.round((load / cpus) * 100));
  const uptime = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  await post("/functions/v1/agent-relay", {
    action: "metrics",
    data: {
      live_players: players.size,
      live_ram_used_mb: Math.round((total - free) / 1024 / 1024),
      live_ram_total_mb: Math.round(total / 1024 / 1024),
      live_cpu_percent: lastCpu,
      live_tps: lastTps,
      live_uptime_seconds: uptime,
      agent_status: mc ? "running" : "connected",
      public_address: publicAddress,
    },
  });
}

async function flushLogs() {
  if (!LOG_BUF.length) return;
  const lines = LOG_BUF.splice(0, Math.min(LOG_BUF.length, 50));
  await post("/functions/v1/agent-relay", { action: "logs", data: { lines } });
}

async function announcePlayer(event, name, uuid) {
  await post("/functions/v1/agent-relay", { action: "player_event", data: { event, name, uuid } });
}

function parseLogLine(line) {
  // Player join: "Steve[/127.0.0.1:1234] logged in with entity id ..."
  const join = line.match(/(?:^|: )([A-Za-z0-9_]{2,16})\[\/[\d\.:]+\] logged in/);
  if (join) {
    const name = join[1];
    if (!players.has(name)) {
      players.set(name, { joined_at: Date.now() });
      announcePlayer("join", name);
    }
  }
  // Player leave
  const leave = line.match(/(?:^|: )([A-Za-z0-9_]{2,16}) (?:lost connection|left the game)/);
  if (leave) {
    const name = leave[1];
    if (players.has(name)) {
      players.delete(name);
      announcePlayer("leave", name);
    }
  }
  // TPS lines (Paper)
  const tps = line.match(/TPS from last 1m[^\d]+([\d\.]+)/);
  if (tps) lastTps = Math.min(20, parseFloat(tps[1]));
  // playit.gg public address: "tcp://yourname.playit.gg:12345" or "minecraft.yourname.playit.gg:12345"
  const playit = line.match(/([a-zA-Z0-9-]+\.playit\.gg(?::\d+)?)/);
  if (playit) publicAddress = playit[1];
}

let playitProc = null;
function startPlayit() {
  if (playitProc) return;
  const playitBin = path.join(__dirname, "playit");
  if (!fs.existsSync(playitBin)) { LOG_BUF.push("[CubePanel] playit não instalado — pula tunnel."); return; }
  LOG_BUF.push("[CubePanel] A iniciar túnel playit.gg (visita o link em baixo para autorizar 1x)...");
  playitProc = spawn(playitBin, [], { cwd: __dirname, shell: false });
  const handle = (d) => {
    const s = d.toString();
    for (const line of s.split(/\r?\n/).filter(Boolean)) {
      LOG_BUF.push("[playit] " + line);
      parseLogLine(line);
    }
  };
  playitProc.stdout.on("data", handle);
  playitProc.stderr.on("data", handle);
  playitProc.on("exit", () => { playitProc = null; LOG_BUF.push("[CubePanel] playit parou."); });
}

async function ensureJar() {
  // If user clicked "Resolve JAR" in panel, server_jar_url is written to repo via marker.
  // For now, the github-proxy resolves the URL and the agent downloads it on-demand.
  const jarPath = path.join(SERVER_DIR, "server.jar");
  if (fs.existsSync(jarPath)) return true;
  if (!fs.existsSync(JAR_URL_FILE)) {
    LOG_BUF.push("[CubePanel] server.jar não existe e jar_url.txt não foi configurado.");
    return false;
  }
  const url = fs.readFileSync(JAR_URL_FILE, "utf8").trim();
  LOG_BUF.push("[CubePanel] A descarregar server.jar de " + url);
  try {
    execSync("curl -sSL -o " + JSON.stringify(jarPath) + " " + JSON.stringify(url), { stdio: "inherit" });
    LOG_BUF.push("[CubePanel] Download concluído.");
    return true;
  } catch (e) {
    LOG_BUF.push("[CubePanel] Falha no download: " + e.message);
    return false;
  }
}

async function startServer() {
  if (mc) return;
  const ok = await ensureJar();
  if (!ok) return;
  const jarPath = path.join(SERVER_DIR, "server.jar");
  if (!fs.existsSync(jarPath)) {
    LOG_BUF.push("[CubePanel] ERRO: server.jar não encontrado em " + jarPath + ". Configura o tipo/versão no painel e clica 'Resolver JAR'.");
    return;
  }
  // Parse CUBEPANEL_JAVA_CMD into argv (no shell). Defaults to safe args.
  const raw = (process.env.CUBEPANEL_JAVA_CMD || "java -Xms2G -Xmx4G -jar server.jar nogui").trim();
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || ["java"];
  const argv = tokens.map((t) => t.replace(/^"|"$/g, ""));
  const bin = argv.shift() || "java";
  LOG_BUF.push("[CubePanel] $ " + bin + " " + argv.join(" "));
  startPlayit();
  try {
    mc = spawn(bin, argv, { cwd: SERVER_DIR, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    LOG_BUF.push("[CubePanel] Falha ao arrancar Java: " + e.message + ". Verifica se 'java' está no PATH (java -version).");
    mc = null;
    return;
  }
  startedAt = Date.now();
  players.clear();
  mc.on("error", (err) => {
    LOG_BUF.push("[CubePanel] Erro de processo Java: " + err.message + (err.code === "ENOENT" ? " (binário 'java' não encontrado no PATH)" : ""));
    mc = null; startedAt = null;
  });
  const handle = (data) => {
    const s = data.toString();
    const split = s.split(/\r?\n/).filter(Boolean);
    for (const line of split) {
      LOG_BUF.push(line);
      parseLogLine(line);
    }
  };
  mc.stdout && mc.stdout.on("data", handle);
  mc.stderr && mc.stderr.on("data", (d) => {
    const s = "[STDERR] " + d.toString();
    LOG_BUF.push(s);
  });
  mc.on("exit", (code) => {
    LOG_BUF.push("[CubePanel] Server parou (code " + code + ").");
    mc = null; startedAt = null; players.clear();
    post("/functions/v1/agent-relay", { action: "players", data: { list: [] } });
  });
}

function stopServer() {
  if (!mc) return;
  try { mc.stdin.write("stop\n"); } catch {}
  setTimeout(() => { if (mc) try { mc.kill("SIGTERM"); } catch {} }, 8000);
}

function sendCmd(cmd) {
  if (!mc) { LOG_BUF.push("[CubePanel] Servidor offline — comando ignorado: " + cmd); return; }
  try { mc.stdin.write(cmd + "\n"); } catch (e) { LOG_BUF.push("[CubePanel] Erro: " + e.message); }
}

async function checkImport() {
  if (!fs.existsSync(IMPORT_FILE)) return;
  try {
    const { url } = JSON.parse(fs.readFileSync(IMPORT_FILE, "utf8"));
    fs.unlinkSync(IMPORT_FILE);
    LOG_BUF.push("[CubePanel] A importar ZIP de " + url);
    const zipPath = path.join(__dirname, "import.zip");
    execSync("curl -sSL -o " + JSON.stringify(zipPath) + " " + JSON.stringify(url), { stdio: "inherit" });
    const unzipper = require("unzipper");
    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: SERVER_DIR })).promise();
    fs.unlinkSync(zipPath);
    LOG_BUF.push("[CubePanel] Import concluído.");
  } catch (e) {
    LOG_BUF.push("[CubePanel] Falha no import: " + e.message);
  }
}

async function poll() {
  const j = await get("/functions/v1/agent-relay?action=poll");
  if (!j || !j.commands) return;
  for (const c of j.commands) {
    if (c.type === "start") startServer();
    else if (c.type === "stop") stopServer();
    else if (c.type === "restart") { stopServer(); setTimeout(startServer, 9000); }
    else if (c.type === "cmd") sendCmd(c.value);
  }
}

console.log("[CubePanel] Agent started.");
post("/functions/v1/agent-relay", { action: "hello", data: { agent_status: "connected" } });
setInterval(reportMetrics, 5000);
setInterval(flushLogs, 1000);
setInterval(poll, 2000);
setInterval(checkImport, 5000);
