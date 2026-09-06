# Tube Pull — YouTube → Hugging Face downloader

A serverless YouTube downloader with three moving parts:

1. **Cloudflare Worker** — a public website that accepts a YouTube URL, shows live progress, and hands you the finished file.
2. **GitHub Actions** — does the actual downloading with `yt-dlp` (cookies + JS-challenge solver + ffmpeg merge).
3. **Hugging Face Storage Bucket** — stores the finished files on HF's CDN (public, dedup-friendly, no artifact size limits).

```
┌─────────┐  POST /api/download   ┌──────────────────┐  workflow_dispatch  ┌────────────────┐
│ Browser │ ────────────────────▶ │ Cloudflare Worker │ ──────────────────▶ │ GitHub Actions │
│  (site) │ ◀──────────────────── │  trigger + track  │                     │  yt-dlp + ffmpeg│
└─────────┘  poll every 2.5s     └──────────────────┘                     └───────┬────────┘
                                        │                                         │ hf buckets cp
                                        │ GET /api/status/:runId                  ▼
                                        ▼                              ┌────────────────────┐
                              GitHub Jobs API (steps)                  │  HF Storage Bucket │
                                                                       │  (public, CDN)     │
                                                                       └────────────────────┘
                                        final click: GET /api/file?path=… → streamed w/ clean filename
```

## Repository layout

```
.github/workflows/download.yml   # the downloader workflow (yt-dlp → ffmpeg → HF bucket)
worker/                          # Cloudflare Worker (site + API)
├── wrangler.toml                # wrangler config (pinned account id)
└── src/
    ├── index.js                 # routes: / (site), /api/download, /api/status/:runId, /api/file
    └── github.js                # GitHub dispatch/status + HF bucket/CDN helpers
cookies.txt                      # local only — gitignored, never commit
```

## Secrets

| Where | Name | Value | Purpose |
|---|---|---|---|
| GitHub repo → *Settings → Secrets and variables → Actions* | `YT_COOKIES` | base64 of a `cookies.txt` exported from a logged-in browser (e.g. via the *Get cookies.txt LOCALLY* extension) | Bypasses YouTube's “Sign in to confirm you're not a bot” on datacenter IPs |
| GitHub repo secrets | `HF_TOKEN` | Hugging Face token with **Write** permission ([create](https://huggingface.co/settings/tokens)) | Lets the workflow create/upload to the bucket |
| Cloudflare Worker secret | `GH_TOKEN` | GitHub token with `repo` + `workflow` scope | Lets the Worker dispatch workflows and read run status |

Set the Worker secret with:

```bash
cd worker
npx wrangler secret put GH_TOKEN
```

## Using it

### Website (the easy way)
Open the Worker URL (e.g. `https://yt-dl-worker.<your-subdomain>.workers.dev`), paste a YouTube link, choose *Video (mp4)* or *Audio (mp3)*, and watch the checklist: **Preparing runtime → Preparing tools → Downloading video → Uploading to storage**. When it finishes, click the result — the file downloads with its real name (title + `[video id]`).

### GitHub Actions UI
Repo → **Actions** → *Download YouTube video* → **Run workflow** with:

| Input | Required | Default | Notes |
|---|---|---|---|
| `url` | ✔ | — | Video or playlist URL |
| `format` | | `best` | `best` (mp4) · `audio` (mp3) · a max height: `2160` `1440` `1080` `720` `480` `360` |
| `hf_namespace` | ✔ | — | HF username or org, e.g. `Angelrider` |
| `hf_bucket` | | `video-downloads` | Created automatically (private on first creation) |

The site's resolution picker is powered by a **probe pipeline** (see [Resolution checks](#resolution-checks) below). The **Probe formats** workflow (`.github/workflows/probe.yml`) is the fallback path — it runs `yt-dlp -J` on a runner and POSTs the result back to the Worker when the VPS agent is unavailable.

### CLI

```bash
gh workflow run download.yml \
  -f url="https://youtu.be/VIDEO_ID" \
  -f format=video \
  -f hf_namespace=Angelrider \
  -f hf_bucket=video-downloads

gh run watch                     # or grab the run id from `gh run list`
```

## What you get

- **Naming:** `<YouTube title> [<video id>] [<height>p].mp4` for video (the height suffix keeps resolution variants of the same video distinct), `<YouTube title> [<video id>].mp3` for audio.
- **Resolution picking:** the site probes available heights first, then downloads exactly what you pick — or the next available height below it if YouTube doesn't serve that exact size.
- **Embedded metadata** (visible in VLC/Plex/Infuse): title, uploader, date, thumbnail, and YouTube chapters (`--embed-metadata --embed-chapters --embed-thumbnail`).
- **Storage:** files land in the bucket at `huggingface.co/buckets/<namespace>/<bucket>` and are served by HF's CDN. Re-downloading identical content is nearly instant thanks to Xet chunk-level deduplication (only changed chunks upload).

## Resolution checks

When you paste a URL, the Worker asks yt-dlp what resolutions the video has before starting a download. Three layers keep this fast and reliable:

1. **VPS agent (fast path, ~20 s):** a tiny agent on an Oracle free-tier box holds a WebSocket to the Worker's `ProbeQueue` Durable Object. Jobs are pushed to it the instant they're queued; it runs `yt-dlp -J` (metadata only) and POSTs the result straight back. Setup and operations: [`vps-agent/README.md`](vps-agent/README.md).
2. **GitHub Actions (fallback):** if the agent doesn't answer within 30 s, the Worker dispatches `probe.yml`, which runs the same extraction on a runner.
3. **Result cache (<0.5 s):** successful probes are cached by video id inside the Durable Object for 1 h, so re-checking the same video is instant.

The UI also shows an instant title + thumbnail preview (via YouTube's oEmbed endpoint) while formats load.

Architecture note: the queue lives in a Durable Object rather than Workers KV because KV is eventually consistent (reads can be ~60 s stale across colos), which silently broke job handoff.

## Performance

A typical single video completes in **~22–35 s**:

| Phase | Time | Notes |
|---|---|---|
| Runner + Deno setup | ~2 s | No repo checkout needed |
| Tool fetch (parallel) | ~10 s | Standalone yt-dlp binary + static ffmpeg + hf CLI, fetched concurrently |
| Download + merge | ~8–20 s | Includes YouTube's occasional 0–20 s “sleep as required by the site” wait (see below) |
| Upload to HF | ~1–8 s | Dedup makes repeats ~1 s |

**Why the occasional wait?** When YouTube serves a player response containing a pre-roll ad, yt-dlp waits out the ad duration before downloading (`available_at` timestamp). We measured that this is a **hard gate**: skipping the sleep (patching yt-dlp) causes `HTTP 403` on the actual stream data for every client on datacenter IPs. The workflow tries `web_embedded → web_safari → default` player clients, which minimizes how often the wait appears — embedded players rarely get pre-roll ads. YouTube Premium cookies would eliminate it entirely.

**Why not more parallel?** The remaining time is dominated by YouTube's throttles and runner provisioning, not our code. Tool fetching is already parallel; downloads are already at 100+ MB/s.

## How downloads work (under the hood)

- **Bot checks:** `denoland/setup-deno@v2` provides the JS runtime yt-dlp needs for YouTube's PO-token/JS challenges; `--remote-components ejs:github` fetches the challenge-solver script.
- **Cookies:** the `YT_COOKIES` secret is base64-decoded to `cookies.txt` on the runner (never committed; exists only for the job's lifetime).
- **Client fallback:** `--extractor-args youtube:player_client=web_embedded` first (fast, few ads), then `web_safari`, then the default multi-client flow — per-client failures fall through automatically.
- **Merge:** static ffmpeg from [BtbN's builds](https://github.com/BtbN/FFmpeg-Builds/releases) (the `ubuntu-latest` image no longer ships ffmpeg) merges best video + best audio into mp4.
- **Upload:** `hf buckets create --private` is idempotent (safe on every run), then `hf buckets cp` uploads the result.
- **Serving:** `/api/file` resolves a fresh signed CDN URL per request and streams it with a correct `Content-Disposition` (HF's signed URLs double-encode filenames — the proxy fixes that, so “Save as” shows the real name).

## Deploying / updating the Worker

```bash
cd worker
npx wrangler deploy          # deploy code changes
npx wrangler tail            # live logs
npx wrangler secret list     # verify GH_TOKEN is set
```

`wrangler.toml` pins the Cloudflare `account_id`, so deploys go to the right account even with multiple accounts logged in.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Sign in to confirm you're not a bot` | No/expired cookies | Re-export `cookies.txt` from a logged-in browser, base64 it, update `YT_COOKIES` |
| `n challenge solving failed` / `The page needs to be reloaded` | EJS solver missing | Ensure `denoland/setup-deno@v2` + `--remote-components ejs:github` are in the workflow (they are) |
| `Requested merging of multiple formats but ffmpeg is not installed` | ffmpeg missing | Static ffmpeg step must run before the download step (it does) |
| `HTTP Error 403` on video data | Sleep skipped or URL gate | Don't patch out the site-required sleep; ensure client fallback order is intact |
| 404 opening a bucket file URL | Browser cached an old link / mid-upload click | Use the site's download button or the bucket page — links are generated fresh |
| Wrong/old video shows as a run's result | — | Fixed: status only lists files uploaded during that run's window |
| Worker `403` from GitHub API | `GH_TOKEN` lacks scope | Recreate the token with `repo` + `workflow`, re-run `wrangler secret put GH_TOKEN` |

## Security notes

- `cookies.txt` is gitignored — check `git status` before committing anything cookie-related.
- Cookies and tokens pasted into chats/logs should be **rotated**: re-export cookies (or log out everywhere) and roll the HF token, then update the secrets.
- The site is intentionally open; anyone with the URL can trigger downloads (and use your Actions minutes). To lock it down, add a shared API key check in `worker/src/index.js` before the `/api/download` handler.

## Cost / limits

- **GitHub Actions:** free tier includes 2,000 min/month (public repos are unlimited); each download uses ~1 min.
- **HF Storage Buckets:** free allowance on creation, then per-TB pricing (see `hf.co/storage`). Buckets are non-versioned — deleting a file actually frees space.
- **Cloudflare Workers:** free tier is 100k requests/day — the site and status polls are tiny; file streaming through `/api/file` is the only bandwidth-heavy path (falls back to direct signed CDN URLs if ever needed).
