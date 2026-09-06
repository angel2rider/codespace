// GitHub + Hugging Face API helpers for the downloader Worker.
// Probe flow: jobs are queued in KV; a small VPS agent long-polls
// /api/probe/claim and POSTs results straight back (fast path, ~5s).
// If no agent claims within ~20s, /api/probe falls back to GitHub Actions.

const REPO = "angel2rider/codespace";
const WORKFLOW = "download.yml";
const PROBE_WORKFLOW = "probe.yml";
const BUCKET = "Angelrider/video-downloads";

const STEP_ORDER = [
  "Run denoland/setup-deno@v2",
  "Prepare tools",
  "Set up cookies",
  "Download video",
  "Upload to Hugging Face bucket",
];

const STAGES = {
  "Run denoland/setup-deno@v2": "Preparing runtime",
  "Prepare tools": "Preparing tools",
  "Set up cookies": "Preparing tools",
  "Download video": "Downloading video",
  "Upload to Hugging Face bucket": "Uploading to storage",
};

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "yt-dl-worker",
  };
}

// Trigger the workflow and resolve the resulting run id.
export async function triggerDownload(env, url, format) {
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          url,
          format,
          hf_namespace: "Angelrider",
          hf_bucket: "video-downloads",
        },
      }),
    }
  );
  if (dispatchRes.status !== 204) {
    throw new Error(`Dispatch failed (${dispatchRes.status})`);
  }

  // Dispatches return no body; poll briefly for the new queued run.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      { headers: ghHeaders(env) }
    );
    const data = await res.json();
    const run = data.workflow_runs?.[0];
    if (run && new Date(run.created_at).getTime() > Date.now() - 60_000) {
      return { runId: run.id, startedAt: run.created_at };
    }
  }
  throw new Error("Could not resolve run id after dispatch");
}

// Resolve a bucket file to its direct signed CDN URL (fresh per click).
// The ?download=true variant makes the CDN serve it as an attachment, so
// the browser downloads the file instead of opening it.
export async function resolveFileUrl(path) {
  const res = await fetch(
    `https://huggingface.co/buckets/Angelrider/video-downloads/resolve/` +
      `${encodeURIComponent(path).replace(/%2F/g, "/")}?download=true`,
    { redirect: "manual" }
  );
  if (res.status >= 300 && res.status < 400) {
    return res.headers.get("location");
  }
  if (res.ok) return res.url;
  throw new Error(`Could not resolve file (${res.status})`);
}

// Stream a bucket file through the Worker with a clean Content-Disposition,
// so "Save as" shows the real name (HF's signed URLs double-encode it).
export async function proxyFile(path) {
  const cdnUrl = await resolveFileUrl(path);
  const upstream = await fetch(cdnUrl, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Upstream fetch failed (${upstream.status})`);
  }
  const safeName = path.replace(/[\\"\r\n]/g, "_");
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  return new Response(upstream.body, { status: 200, headers });
}

// The probe queue lives in a Durable Object (strongly consistent - KV's
// eventual consistency broke the job handoff). One global instance is all
// this app needs; SQLite inside it keeps jobs/results.
export function getProbeQueue(env) {
  return env.PROBE_QUEUE.get(env.PROBE_QUEUE.idFromName("global"));
}

// Extract a video id from a YouTube URL (watch, shorts, youtu.be).
export function videoId(url) {
  const m = url.match(/(?:v=|shorts\/|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : null;
}

// Instant preview metadata from YouTube's public oEmbed endpoint (~200ms),
// so the UI can show title + thumbnail while the real probe runs.
export async function oembedPreview(url) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(4_000) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return { title: d.title || "", thumbnail: d.thumbnail_url || "" };
  } catch {
    return null;
  }
}

// Enqueue a probe job. The VPS agent holds a WebSocket to the DO, so jobs
// are pushed to it instantly; REST claim is the fallback. Returns a nonce
// plus an instant oEmbed preview; if this video was probed recently, the
// cached result is returned instead (ready: true, no agent round-trip).
export async function probeVideo(env, url) {
  const id = videoId(url);
  const q = getProbeQueue(env);
  const cachedNonce = await q.cachedNonce(id);
  if (cachedNonce) {
    return { nonce: cachedNonce, cached: true, preview: null };
  }
  const { nonce } = await q.enqueue(url);
  const preview = await oembedPreview(url);
  return { nonce, cached: false, preview };
}

// Agent long-poll: wait up to ~10s for a job (the DO wakes us when one
// arrives), then hand it over.
export async function claimProbeJob(env, waitMs = 10_000) {
  return getProbeQueue(env).claim();
}

// Agent (or fallback runner) posts the finished probe here.
export async function submitProbe(env, payload) {
  const { nonce, ...data } = payload;
  return getProbeQueue(env).submit(nonce, data);
}

// Read a probe result. Absent = still running.
export async function getProbe(env, nonce) {
  if (!/^[a-f0-9]{8}$/.test(nonce) || !env.PROBE_QUEUE) return { ready: false };
  return getProbeQueue(env).read(nonce);
}

// Fallback probe path: dispatch the GitHub Actions probe workflow (used when
// the VPS agent does not claim the job within 20s).
export async function dispatchProbe(env, url, nonce) {
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { url, nonce, callback: env.WORKER_URL } }),
    }
  );
  if (dispatchRes.status !== 204) {
    throw new Error(`Probe dispatch failed (${dispatchRes.status})`);
  }
  return { nonce };
}

// Map a run to progress info + result links.
export async function getStatus(env, runId) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/runs/${runId}`,
    { headers: ghHeaders(env) }
  );
  if (res.status === 404) return { found: false };
  const run = await res.json();

  const base = {
    found: true,
    status: run.status, // queued | in_progress | completed
    conclusion: run.conclusion, // success | failure | null
    htmlUrl: run.html_url,
    createdAt: run.created_at,
  };

  if (run.status !== "completed") {
    // Current stage from the job's steps.
    const jobsRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/runs/${runId}/jobs`,
      { headers: ghHeaders(env) }
    );
    const jobs = await jobsRes.json();
    const job = jobs.jobs?.[0];
    const done = new Set(
      (job?.steps || [])
        .filter((s) => s.conclusion === "success")
        .map((s) => s.name)
    );
    let stage = "Queued";
    for (const name of STEP_ORDER) {
      if (!done.has(name)) {
        stage = STAGES[name] || name;
        break;
      }
    }
    if (run.status === "queued") stage = "Queued (waiting for a runner)";
    return { ...base, stage };
  }

  if (run.conclusion !== "success") {
    return { ...base, stage: "Failed - check the Actions log", htmlUrl: run.html_url };
  }

  // Success: list only files uploaded while this run was active, so each
  // run's status shows its own result (not the whole bucket history).
  const runStart = new Date(run.created_at).getTime() - 5_000; // small slack
  const runEnd = run.updated_at ? new Date(run.updated_at).getTime() + 5_000 : Date.now();
  const bucket = await fetch(
    `https://huggingface.co/api/buckets/Angelrider/video-downloads/tree?recursive=true`
  ).then((r) => r.json());
  const files = (Array.isArray(bucket) ? bucket : [])
    .filter(
      (f) =>
        f.type === "file" &&
        /\.(mp4|mp3)$/i.test(f.path) &&
        new Date(f.uploadedAt).getTime() >= runStart &&
        new Date(f.uploadedAt).getTime() <= runEnd
    )
    .map((f) => ({
      name: f.path,
      size: f.size,
      url: null, // resolved lazily via /api/file (proxies with a clean filename)
    }));
  return { ...base, files };
}
