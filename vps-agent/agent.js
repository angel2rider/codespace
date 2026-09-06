#!/usr/bin/env node
// Probe agent: holds a WebSocket to the Worker's ProbeQueue Durable Object,
// receives probe jobs the moment they are queued, runs `yt-dlp -J` for
// metadata only (no media download), and POSTs results straight back.
// Runs under systemd on a small VPS (designed for 1 vCPU / 1 GB RAM).
//
// Fallback: if the socket is down, it long-polls POST /api/probe/claim.
//
// Env (see .env):
//   WORKER_URL      e.g. https://yt-dl-worker.example.workers.dev
//   WORKER_SECRET   shared secret (must match the Worker's WORKER_SECRET)
//   YTDLP_PATH      absolute path to the yt-dlp binary
//   COOKIES_PATH    optional cookies.txt for age-gated videos

const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");
const SECRET = process.env.WORKER_SECRET || "";
const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const COOKIES = process.env.COOKIES_PATH || "";
const CLAIM_INTERVAL = 10_000; // REST fallback poll cadence (socket down only)
const MAX_CONCURRENT = 1; // keep RAM tiny on the 1 GB box

const { execFile } = require("child_process");

let active = 0;
let ws = null;
let wsRetries = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.message += stderr ? ` :: ${String(stderr).slice(-400)}` : "";
        reject(err);
      } else resolve({ stdout });
    });
  });
}

// ---- WebSocket (primary job source) ----

function connectWS() {
  const url =
    WORKER_URL.replace(/^http/, "ws") +
    "/api/probe/socket?secret=" +
    encodeURIComponent(SECRET);
  const socket = new WebSocket(url);
  socket.onopen = () => {
    log("websocket connected");
    wsRetries = 0;
  };
  socket.onmessage = (ev) => {
    try {
      const job = JSON.parse(ev.data);
      if (job && job.type === "job" && job.nonce && job.url) {
        if (active < MAX_CONCURRENT) handleJob(job);
        else log(`job ${job.nonce} dropped (busy) - UI fallback will retry`);
      }
    } catch {
      // Malformed frame; ignore.
    }
  };
  socket.onclose = () => {
    log("websocket closed; will reconnect");
    ws = null;
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {}
  };
  ws = socket;
}

function wsLoop() {
  if (!ws) connectWS();
  setTimeout(wsLoop, Math.min(30_000, 1_000 * (wsRetries + 1)));
}

// ---- REST claim fallback ----

async function claim() {
  const res = await fetch(`${WORKER_URL}/api/probe/claim`, {
    method: "POST",
    headers: { "x-probe-secret": SECRET },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`claim HTTP ${res.status}`);
  const data = await res.json();
  return data && data.job ? data.job : null;
}

// ---- Probe execution ----

async function fetchMeta(url) {
  const args = ["--remote-components", "ejs:github", "--no-warnings", "-J", url];
  if (COOKIES) args.unshift("--cookies", COOKIES);
  const { stdout } = await execFileP(YTDLP, args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 90_000,
  });
  return JSON.parse(stdout);
}

function buildPayload(meta, nonce) {
  const fpsByHeight = new Map();
  for (const f of meta.formats || []) {
    if (!f.height || !f.vcodec || f.vcodec === "none") continue;
    if (f.protocol === "m3u8_native") continue;
    const cur = fpsByHeight.get(f.height) || 0;
    if ((f.fps || 0) > cur) fpsByHeight.set(f.height, f.fps || 0);
  }
  const resolutions = [...fpsByHeight.entries()]
    .map(([h, fps]) => ({ h, fps }))
    .sort((a, b) => b.h - a.h);
  return {
    nonce,
    title: meta.title || "",
    id: meta.id || "",
    thumbnail: meta.thumbnail || "",
    duration: meta.duration || 0,
    isLive: !!meta.is_live,
    resolutions,
  };
}

async function postResult(payload) {
  const res = await fetch(`${WORKER_URL}/api/probe/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-probe-secret": SECRET },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`result POST HTTP ${res.status}`);
}

async function handleJob(job) {
  active++;
  const { url, nonce } = job;
  log(`job ${nonce} start: ${url}`);
  try {
    const meta = await fetchMeta(url);
    const payload = buildPayload(meta, nonce);
    await postResult(payload);
    log(
      `job ${nonce} ok (${payload.resolutions.length} resolutions, ` +
        `${payload.title || "untitled"})`
    );
  } catch (err) {
    log(`job ${nonce} FAILED: ${err.message}`);
    try {
      await postResult({ nonce, error: String(err.message || err).slice(0, 300) });
    } catch (postErr) {
      log(`job ${nonce} could not report failure: ${postErr.message}`);
    }
  } finally {
    active--;
  }
}

async function tick() {
  if (active >= MAX_CONCURRENT) return;
  let job = null;
  try {
    job = await claim();
  } catch (err) {
    log(`claim error: ${err.message}`);
    return;
  }
  if (job) handleJob(job); // intentionally not awaited
}

async function main() {
  if (!WORKER_URL || !SECRET) {
    console.error("WORKER_URL and WORKER_SECRET are required");
    process.exit(1);
  }
  log(`agent starting; worker=${WORKER_URL} yt-dlp=${YTDLP}`);

  // One-shot mode for testing: `agent.js --once <url>` runs a single probe
  // with a fixed nonce and exits.
  if (process.argv[2] === "--once") {
    const url = process.argv[3];
    if (!url) {
      console.error("usage: agent.js --once <url>");
      process.exit(1);
    }
    await handleJob({ url, nonce: "deadbeef" });
    return;
  }

  wsLoop(); // primary: pushed jobs
  for (;;) {
    if (!ws || ws.readyState !== 1) await tick(); // fallback: poll only when socket is down
    await sleep(active ? 1_000 : CLAIM_INTERVAL);
  }
}

main();
