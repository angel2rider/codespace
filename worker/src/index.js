// yt-dl Worker: serves the downloader site, triggers GitHub Actions, tracks progress.

import { triggerDownload, getStatus, proxyFile } from "./github.js";

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
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: radial-gradient(1200px 800px at 20% -10%, #1b2a4a 0%, #0b0e14 55%) fixed;
    color: #e6e9ef; padding: 24px;
  }
  .card {
    width: min(640px, 94vw); background: rgba(19, 24, 36, .82);
    border: 1px solid rgba(120, 140, 190, .16); backdrop-filter: blur(14px);
    border-radius: 20px; padding: 32px; box-shadow: 0 24px 80px rgba(0,0,0,.5);
  }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .logo .dot {
    width: 34px; height: 34px; border-radius: 10px; flex: none;
    background: linear-gradient(135deg, #ef4444, #f97316);
    display: flex; align-items: center; justify-content: center; font-size: 17px;
  }
  h1 { margin: 0; font-size: 21px; letter-spacing: -.01em; }
  p.sub { margin: 10px 0 22px; color: #8b94a7; font-size: 14px; line-height: 1.5; }
  form { display: flex; gap: 10px; flex-wrap: wrap; }
  input[type=url] {
    flex: 1 1 240px; padding: 13px 15px; border-radius: 12px;
    border: 1px solid rgba(120,140,190,.22); background: rgba(11,14,20,.7);
    color: #e6e9ef; font-size: 15px; outline: none; transition: border-color .15s;
  }
  input[type=url]:focus { border-color: #3b82f6; }
  select {
    padding: 13px 12px; border-radius: 12px; border: 1px solid rgba(120,140,190,.22);
    background: rgba(27,35,52,.9); color: #e6e9ef; font-size: 14px; cursor: pointer; outline: none;
  }
  button {
    padding: 13px 22px; border-radius: 12px; border: none; font-weight: 600; font-size: 15px;
    color: white; cursor: pointer; background: linear-gradient(135deg, #3b82f6, #8b5cf6);
    transition: transform .12s, opacity .15s;
  }
  button:hover { transform: translateY(-1px); }
  button:disabled { opacity: .5; cursor: wait; transform: none; }

  .status { margin-top: 24px; display: none; }
  .bar {
    height: 12px; border-radius: 99px; background: rgba(120,140,190,.14);
    overflow: hidden; position: relative;
  }
  .bar > div {
    height: 100%; width: 0%; border-radius: 99px; transition: width .6s cubic-bezier(.22,1,.36,1);
    background: linear-gradient(90deg, #3b82f6, #8b5cf6, #d946ef);
    background-size: 200% 100%; animation: flow 2.2s linear infinite;
  }
  @keyframes flow { to { background-position: -200% 0; } }
  .stage-row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 12px; }
  .stage { font-size: 14px; font-weight: 600; color: #c3cad8; }
  .elapsed { font-size: 12px; color: #667085; font-variant-numeric: tabular-nums; }

  .steps { margin-top: 14px; display: flex; flex-direction: column; gap: 7px; }
  .step { display: flex; align-items: center; gap: 9px; font-size: 13px; color: #5b6474; transition: color .3s; }
  .step .ic {
    width: 18px; height: 18px; border-radius: 50%; flex: none; font-size: 11px;
    display: flex; align-items: center; justify-content: center;
    border: 1.5px solid rgba(120,140,190,.3); transition: all .3s;
  }
  .step.active { color: #93c5fd; }
  .step.active .ic { border-color: #3b82f6; animation: pulse 1.4s ease-in-out infinite; }
  .step.done { color: #86efac; }
  .step.done .ic { border-color: #22c55e; background: rgba(34,197,94,.15); color: #22c55e; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 4px rgba(59,130,246,.15); } }

  .err {
    margin-top: 14px; color: #f87171; font-size: 13.5px; line-height: 1.5; display: none;
    padding: 12px 14px; border-radius: 10px; background: rgba(248,113,113,.08);
    border: 1px solid rgba(248,113,113,.2);
  }
  .err a { color: #fca5a5; }

  .result { margin-top: 20px; display: none; }
  .result-head { font-size: 13px; color: #8b94a7; margin-bottom: 10px; }
  .dl {
    display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin-top: 8px;
    border-radius: 12px; background: rgba(16,37,26,.65); border: 1px solid rgba(34,197,94,.28);
    color: #4ade80; text-decoration: none; transition: background .15s, transform .12s;
  }
  .dl:hover { background: rgba(21,48,31,.85); transform: translateY(-1px); }
  .dl .ic { font-size: 18px; }
  .dl .meta { min-width: 0; }
  .dl .name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dl .size { font-size: 12px; color: #4b7d5e; margin-top: 2px; }
  .muted { color: #4d5566; font-size: 12px; margin-top: 22px; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <div class="logo"><div class="dot">▶</div><h1>Tube Pull</h1></div>
    <p class="sub">Paste a YouTube link — it gets fetched at full speed and stored on the edge. Click the result to save the file.</p>

    <form id="f">
      <input id="url" type="url" required placeholder="https://youtube.com/watch?v=..." autocomplete="off">
      <select id="format">
        <option value="video">Video · mp4</option>
        <option value="audio">Audio · mp3</option>
      </select>
      <button id="go">Pull</button>
    </form>

    <section id="status" class="status">
      <div class="bar"><div id="fill"></div></div>
      <div class="stage-row">
        <div class="stage" id="stage">Starting…</div>
        <div class="elapsed" id="elapsed"></div>
      </div>
      <div class="steps" id="steps"></div>
      <div class="err" id="err"></div>
      <div class="result" id="result"></div>
    </section>

    <div class="muted">Powered by GitHub Actions · Files on Hugging Face · No login required</div>
  </main>

<script>
  const $ = (id) => document.getElementById(id);
  const fill = $("fill"), stage = $("stage"), err = $("err"), elapsed = $("elapsed"),
        result = $("result"), statusBox = $("status"), go = $("go"), stepsBox = $("steps");
  let timer = null, t0 = 0;

  const STEPS = ["Preparing runtime", "Preparing tools", "Downloading video", "Uploading to storage"];
  const WIDTHS = { "Queued": 6, "Queued (waiting for a runner)": 12, "Preparing runtime": 22, "Preparing tools": 40, "Downloading video": 68, "Uploading to storage": 90 };

  function renderSteps(current) {
    stepsBox.innerHTML = "";
    const idx = STEPS.indexOf(current);
    STEPS.forEach((s, i) => {
      const div = document.createElement("div");
      div.className = "step " + (i < idx ? "done" : i === idx ? "active" : "");
      div.innerHTML = '<span class="ic">' + (i < idx ? "✓" : "") + '</span><span>' + s + "</span>";
      stepsBox.appendChild(div);
    });
  }

  function tick() {
    const s = Math.floor((Date.now() - t0) / 1000);
    elapsed.textContent = s + "s elapsed";
  }

  function poll(runId) {
    timer = setInterval(async () => {
      try {
        const data = await fetch("/api/status/" + runId).then((r) => r.json());
        if (!data.found) return;
        tick();

        if (data.status === "completed") {
          clearInterval(timer);
          if (data.conclusion === "success" && data.files?.length) {
            finish(data.files);
          } else {
            fail(data.stage || "Something went wrong", data.htmlUrl);
          }
          return;
        }

        const st = data.stage || "Working…";
        fill.style.width = (WIDTHS[st] ?? 30) + "%";
        stage.textContent = st;
        renderSteps(STEPS.includes(st) ? st : "Preparing runtime");
      } catch { /* keep polling */ }
    }, 2500);
  }

  function finish(files) {
    fill.style.width = "100%";
    stage.textContent = "Done ✓";
    elapsed.textContent = Math.round((Date.now() - t0) / 1000) + "s total";
    [...stepsBox.children].forEach((c) => (c.className = "step done"));
    result.style.display = "block";
    result.innerHTML = '<div class="result-head">Your file is ready</div>';
    for (const f of files) {
      const a = document.createElement("a");
      a.className = "dl";
      a.href = "/api/file?path=" + encodeURIComponent(f.name);
      a.setAttribute("download", f.name);
      a.innerHTML = '<span class="ic">⬇</span><span class="meta"><span class="name"></span><span class="size">' +
        (f.size / 1048576).toFixed(1) + " MB · tap to download</span></span>";
      a.querySelector(".name").textContent = f.name;
      result.appendChild(a);
    }
    go.disabled = false;
  }

  function fail(msg, url) {
    fill.style.width = "100%";
    fill.style.background = "#f87171";
    fill.style.animation = "none";
    stage.textContent = "Failed";
    err.style.display = "block";
    err.innerHTML = (msg || "Download failed") +
      (url ? ' — <a href="' + url + '" target="_blank" rel="noopener">view the run log</a>' : "");
    go.disabled = false;
  }

  $("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    err.style.display = "none"; err.textContent = "";
    result.style.display = "none"; result.innerHTML = "";
    fill.style.width = "0%"; fill.style.background = ""; fill.style.animation = "";
    statusBox.style.display = "block";
    stepsBox.innerHTML = "";
    stage.textContent = "Starting…";
    elapsed.textContent = "";
    t0 = Date.now();
    go.disabled = true;

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: $("url").value, format: $("format").value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start");
      renderSteps("Preparing runtime");
      poll(data.runId);
    } catch (ex) {
      fail(ex.message);
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

    // Stream a bucket file with a clean filename (handy for downloads).
    if (url.pathname === "/api/file" && (request.method === "GET" || request.method === "HEAD")) {
      const path = url.searchParams.get("path");
      if (!path || !/^[^/]+\.(mp4|mp3)$/i.test(path) || path.includes("..")) {
        return json({ error: "Invalid file path" }, 400);
      }
      try {
        return await proxyFile(path);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
