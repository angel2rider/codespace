// GitHub + Hugging Face API helpers for the downloader Worker.

const REPO = "angel2rider/codespace";
const WORKFLOW = "download.yml";

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
          format: format === "audio" ? "audio" : "video",
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

  // Success: list only files uploaded after this run started, so each
  // run's status shows its own result (not the whole bucket history).
  const runStart = new Date(run.created_at).getTime() - 5_000; // small slack
  const bucket = await fetch(
    `https://huggingface.co/api/buckets/Angelrider/video-downloads/tree?recursive=true`
  ).then((r) => r.json());
  const files = (Array.isArray(bucket) ? bucket : [])
    .filter(
      (f) =>
        f.type === "file" &&
        /\.(mp4|mp3)$/i.test(f.path) &&
        new Date(f.uploadedAt).getTime() >= runStart
    )
    .map((f) => ({
      name: f.path,
      size: f.size,
      url:
        `https://huggingface.co/buckets/Angelrider/video-downloads/resolve/` +
        `${encodeURIComponent(f.path).replace(/%2F/g, "/")}?download=true`,
    }));
  return { ...base, files };
}
