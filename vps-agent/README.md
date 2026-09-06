# VPS probe agent

A tiny Node.js agent that makes the site's resolution lookup fast. It holds a
WebSocket to the Worker's `ProbeQueue` Durable Object, receives probe jobs the
instant they are queued, runs `yt-dlp -J` (metadata only — no video download),
and POSTs the result straight back to the Worker.

```
Worker DO ──WebSocket push──▶ this agent ──yt-dlp -J──▶ POST /api/probe/result ──▶ DO
     └────────── POST /api/probe/claim (fallback when the socket is down) ─────────┘
```

Downloads are **not** handled here — they still run on GitHub Actions
(`.github/workflows/download.yml`) and upload to the Hugging Face bucket.
This box only ever fetches video metadata (a few hundred KB per probe).

## Why a VPS at all?

GitHub Actions adds 10–20s of runner provisioning before `yt-dlp` even starts.
With the agent, a resolution check finishes in ~20s total (vs ~60–90s) — and
repeats within an hour are served from the Worker's cache in <0.5s.

## Install (Ubuntu, fresh box)

```bash
# 1. Node.js 22 (needs built-in fetch/WebSocket)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. yt-dlp in a venv (the static binary is much slower on small VPSes:
#    pyinstaller extracts ~30MB to disk on every run)
sudo python3 -m venv /opt/ytprobe/venv
sudo /opt/ytprobe/venv/bin/pip install yt-dlp

# 3. Deno (yt-dlp's JS runtime for YouTube PO-token challenges)
sudo mkdir -p /opt/ytprobe/bin
sudo curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip
sudo unzip -o /tmp/deno.zip -d /opt/ytprobe/bin

# 4. App + config
sudo useradd -r -s /usr/sbin/nologin -d /opt/ytprobe ytprobe
sudo mkdir -p /opt/ytprobe
sudo cp agent.js /opt/ytprobe/
sudo cp ytprobe.service /etc/systemd/system/
sudo tee /opt/ytprobe/.env >/dev/null <<EOF
WORKER_URL=https://yt-dl-worker.example.workers.dev
WORKER_SECRET=<same value as the Worker's WORKER_SECRET secret>
YTDLP_PATH=/opt/ytprobe/venv/bin/yt-dlp
HOME=/opt/ytprobe
DENO_DIR=/opt/ytprobe/.cache/deno
XDG_CACHE_HOME=/opt/ytprobe/.cache
# COOKIES_PATH=/opt/ytprobe/cookies.txt   # optional, for age-gated videos
EOF
sudo chown -R ytprobe:ytprobe /opt/ytprobe
sudo chmod 750 /opt/ytprobe && sudo chmod 640 /opt/ytprobe/.env

# 5. Start
sudo systemctl daemon-reload
sudo systemctl enable --now ytprobe
```

## YouTube cookies (recommended on datacenter IPs)

Oracle/AWS/GCP IP ranges trigger YouTube's "Sign in to confirm you're not a
bot" check. Export `cookies.txt` from a logged-in browser (see
`yt-dlp` wiki on exporting YouTube cookies), drop it at
`/opt/ytprobe/cookies.txt` (owned by `ytprobe`, mode 640) and set
`COOKIES_PATH` in the env file.

## Managing

```bash
systemctl status ytprobe
sudo journalctl -u ytprobe -f          # live logs ("job <nonce> ok ..." per probe)
sudo systemctl restart ytprobe         # after editing agent.js or .env
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `claim HTTP 401` in logs | `WORKER_SECRET` doesn't match the Worker's secret. |
| Probes time out but no jobs in logs | Socket down + stale fallback? Check for `websocket connected` after a restart. |
| `Sign in to confirm you're not a bot` | Cookies missing/expired — see section above. |
| `The page needs to be reloaded` | Missing Deno/EJS challenge solver; keep deno in `PATH`. |
| Slow probes (~30s+) | Check `YTDLP_PATH` points at the venv install, not the pyinstaller binary. |
