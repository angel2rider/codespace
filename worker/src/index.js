// yt-dl Worker: serves the downloader site, triggers GitHub Actions, tracks progress.

import { triggerDownload, getStatus } from "./github.js";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tube Pull</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0e14; color: #e6e9ef;
  }
  .card {
    width: min(680px, 92vw); background: #131824; border: 1px solid #232b3d;
    border-radius: 16px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.45);
  }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p.sub { margin: 0 0 20px; color: #8b94a7; font-size: 14px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  input[type=url] {
    flex: 1; min-width: 240px; padding: 12px 14px; border-radius: 10px;
    border: 1px solid #2a3349; background: #0b0e14; color: #e6e9ef; font-size: 15px;
  }
  select, button {
    padding: 12px 16px; border-radius: 10px; border: 1px solid #2a3349;
    background: #1b2334; color: #e6e9ef; font-size: 15px; cursor: pointer;
  }
  button { background: #3b82f6; border-color: #3b82f6; font-weight: 600; }
  button:disabled { opacity: .55; cursor: wait; }
  .status { margin-top: 20px; display: none; }
  .bar { height: 10px; border-radius: 99px; background: #232b3d; overflow: hidden; }
  .bar > div {
    height: 100%; width: 0%; border-radius: 99px; transition: width .5s ease;
    background: linear-gradient(90deg, #3b82f6, #8b5cf6);
  }
  .stage { margin-top: 10px; font-size: 14px; color: #aeb6c6; }
  .err { margin-top: 12px; color: #f87171; font-size: 14px; }
  .result { margin-top: 18px; }
  .result a {
    display: block; padding: 12px 14px; margin-top: 8px; border-radius: 10px;
    background: #10251a; border: 1px solid #1e4d33; color: #4ade80;
    text-decoration: none; font-size: 14px; word-break: break-all;
  }
  .result a:hover { background: #15301f; }
  .muted { color: #667085; font-size: 12px; margin-top: 14px; }
</style>
</head>
<body>
  <main class="card">
    <h1>Tube Pull</h1>
    <p class="sub">Paste a YouTube link — the video is fetched and stored on Hugging Face.</p>
    <form id="f" class="row">
      <input id="url" type="url" required placeholder="https://youtube.com/watch?v=..." autocomplete="off">
      <select id="format">
        <option value="video">Video (mp4)</option>
        <option value="audio">Audio (mp3)</option>
      </select>
      <button id="go">Download</button>
    </form>

    <section id="status" class="status">
      <div class="bar"><div id="fill"></div></div>
      <div class="stage" id="stage">Queued</div>
      <div class="err" id="err"></div>
      <div class="result" id="result"></div>
    </section>

    <div class="muted">Runs on GitHub Actions · Stored on Hugging Face · No login required</div>
  </main>

<script>
  const $ = (id) => document.getElementById(id);
  const fill = $("fill"), stage = $("stage"), err = $("err"),
        result = $("result"), statusBox = $("status"), go = $("go");
  let timer = null;

  const WIDTHS = {
    "Queued": 5,
    "Queued (waiting for a runner)": 10,
    "Preparing runtime": 20,
    "Preparing tools": 35,
    "Downloading video": 65,
    "Uploading to storage": 90,
  };

  function poll(runId) {
    timer = setInterval(async () => {
      try {
        const res = await fetch("/api/status/" + runId);
        const data = await res.json();
        if (!data.found) return;

        if (data.status === "completed") {
          clearInterval(timer);
          if (data.conclusion === "success" && data.files?.length) {
            fill.style.width = "100%";
            stage.textContent = "Done";
            for (const f of data.files) {
              const a = document.createElement("a");
              a.href = f.url;
              a.textContent = "⬇ " + f.name + "  (" + (f.size / 1048576).toFixed(1) + " MB)";
              result.appendChild(a);
            }
          } else {
            fill.style.width = "100%";
            fill.style.background = "#f87171";
            stage.textContent = data.stage || "Failed";
            err.textContent = "Something went wrong — you can check the run here: " + data.htmlUrl;
          }
          go.disabled = false;
          return;
        }

        const w = WIDTHS[data.stage] ?? 30;
        fill.style.width = w + "%";
        stage.textContent = data.stage;
      } catch { /* keep polling */ }
    }, 3000);
  }

  $("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = ""; result.innerHTML = "";
    fill.style.width = "0%"; fill.style.background = "";
    statusBox.style.display = "block";
    stage.textContent = "Starting...";
    go.disabled = true;

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: $("url").value,
          format: $("format").value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start");
      poll(data.runId);
    } catch (ex) {
      stage.textContent = "Could not start";
      err.textContent = ex.message;
      go.disabled = false;
    }
  });
</script>
</body>
</html>`;

const YT_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=[\w-]{6,}|shorts\/[\w-]{6,}|playlist\?list=[\w-]+)|youtu\.be\/[\w-]{6,})/i;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/download" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const link = (body.url || "").trim();
      if (!YT_RE.test(link)) {
        return json({ error: "Please provide a valid YouTube URL" }, 400);
      }

      // One download at a time: reject if a run is still active.
      const recent = await fetch(
        `https://api.github.com/repos/angel2rider/codespace/actions/workflows/download.yml/runs?per_page=5`,
        { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "yt-dl-worker" } }
      ).then((r) => r.json());
      const active = (recent.workflow_runs || []).find(
        (r) => r.status === "queued" || r.status === "in_progress"
      );
      if (active) {
        return json({ error: "A download is already running. Try again in a minute." }, 429);
      }

      try {
        const { runId } = await triggerDownload(env, link, body.format);
        return json({ runId });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    const statusMatch = url.pathname.match(/^\/api\/status\/(\d+)$/);
    if (statusMatch && request.method === "GET") {
      try {
        return json(await getStatus(env, statusMatch[1]));
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
