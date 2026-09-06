// yt-dl Worker: serves the downloader site, triggers GitHub Actions, tracks progress.

import { triggerDownload, getStatus, proxyFile, probeVideo, getProbe } from "./github.js";

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
    width: min(660px, 94vw); background: rgba(19, 24, 36, .82);
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
  button {
    padding: 13px 22px; border-radius: 12px; border: none; font-weight: 600; font-size: 15px;
    color: white; cursor: pointer; background: linear-gradient(135deg, #3b82f6, #8b5cf6);
    transition: transform .12s, opacity .15s;
  }
  button:hover { transform: translateY(-1px); }
  button:disabled { opacity: .5; cursor: wait; transform: none; }

  .picker { margin-top: 24px; display: none; }
  .vcard {
    display: flex; gap: 14px; align-items: flex-start;
    padding: 14px; border-radius: 14px; background: rgba(11,14,20,.55);
    border: 1px solid rgba(120,140,190,.14);
  }
  .vcard img {
    width: 168px; aspect-ratio: 16/9; object-fit: cover; border-radius: 9px; flex: none;
    background: #1a2030;
  }
  .vmeta { min-width: 0; }
  .vtitle { font-size: 14.5px; font-weight: 600; line-height: 1.4; }
  .vdur { font-size: 12.5px; color: #8b94a7; margin-top: 5px; }
  .checking { display: flex; align-items: center; gap: 10px; color: #93a5c0; font-size: 14px; padding: 6px 2px; }
  .spin {
    width: 16px; height: 16px; border-radius: 50%; flex: none;
    border: 2px solid rgba(120,140,190,.25); border-top-color: #3b82f6;
    animation: rot .8s linear infinite;
  }
  @keyframes rot { to { transform: rotate(360deg); } }

  .res-title { margin: 18px 0 10px; font-size: 13px; color: #8b94a7; }
  .chips { display: flex; flex-wrap: wrap; gap: 9px; }
  .chip {
    padding: 10px 16px; border-radius: 11px; font-size: 14px; font-weight: 600;
    background: rgba(27,35,52,.9); border: 1px solid rgba(120,140,190,.22);
    color: #dbe2ee; cursor: pointer; transition: all .15s; user-select: none;
  }
  .chip small { font-weight: 500; color: #7d8aa3; margin-left: 5px; }
  .chip:hover { border-color: #3b82f6; background: rgba(35,48,74,.95); transform: translateY(-1px); }
  .chip.accent { background: linear-gradient(135deg, rgba(59,130,246,.25), rgba(139,92,246,.25)); border-color: rgba(99,132,246,.5); }

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
  .back { background: none; border: none; color: #7d8aa3; font-size: 13px; padding: 0; margin-top: 14px; font-weight: 500; }
  .back:hover { color: #aeb6c6; transform: none; }
</style>
</head>
<body>
  <main class="card">
    <div class="logo"><div class="dot">▶</div><h1>Tube Pull</h1></div>
    <p class="sub">Paste a YouTube link, pick your resolution, and the file is fetched at full speed. Click the result to save it.</p>

    <form id="f">
      <input id="url" type="url" required placeholder="https://youtube.com/watch?v=..." autocomplete="off">
      <button id="check">Check resolutions</button>
    </form>

    <section id="picker" class="picker">
      <div id="probe-state" class="checking"><div class="spin"></div><span>Fetching video info…</span></div>
      <div id="vwrap" style="display:none">
        <div class="vcard">
          <img id="vthumb" alt="">
          <div class="vmeta">
            <div class="vtitle" id="vtitle"></div>
            <div class="vdur" id="vdur"></div>
          </div>
        </div>
        <div class="res-title">Choose a version to download</div>
        <div class="chips" id="chips"></div>
      </div>
      <button class="back" id="reset">← start over</button>
    </section>

    <section id="status" class="status">
      <div class="bar"><div id="fill"></div></div>
      <div class="stage-row">
        <div class="stage" id="stage">Starting…</div>
        <div class="elapsed" id="elapsed"></div>
      </div>
      <div class="steps" id="steps"></div>
      <div class="err" id="err"></div>
      <div class="result" id="result"></div>
      <button class="back" id="again">← download another</button>
    </section>

    <div class="muted">Powered by GitHub Actions · Files on Hugging Face · No login required</div>
  </main>

<script>
  var $ = function(id) { return document.getElementById(id); };
  var checkBtn = $("check"), urlInput = $("url"), picker = $("picker"),
      probeState = $("probe-state"), vwrap = $("vwrap"),
      chipsBox = $("chips"), statusBox = $("status"),
      fill = $("fill"), stage = $("stage"), err = $("err"), elapsed = $("elapsed"),
      result = $("result"), stepsBox = $("steps");

  var STEPS = ["Preparing runtime", "Preparing tools", "Downloading video", "Uploading to storage"];
  var WIDTHS = { "Queued": 6, "Queued (waiting for a runner)": 12, "Preparing runtime": 22, "Preparing tools": 40, "Downloading video": 68, "Uploading to storage": 90 };
  var probeTimer = null, dlTimer = null, t0 = 0;

  function secs(s) {
    s = Math.round(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return h > 0 ? h + ":" + p(m) + ":" + p(r) : m + ":" + p(r);
  }

  function showPicker() {
    picker.style.display = "block";
    statusBox.style.display = "none";
    result.style.display = "none";
    err.style.display = "none";
    fill.style.width = "0%"; fill.style.background = ""; fill.style.animation = "";
    stepsBox.innerHTML = "";
    checkBtn.disabled = false;
  }

  function resetAll() {
    if (probeTimer) clearInterval(probeTimer);
    if (dlTimer) clearInterval(dlTimer);
    probeTimer = null; dlTimer = null;
    showPicker();
    picker.style.display = "none";
  }

  // ---- Phase 1: probe resolutions ----
  $("f").addEventListener("submit", function(e) {
    e.preventDefault();
    err.style.display = "none";
    picker.style.display = "block";
    vwrap.style.display = "none";
    chipsBox.innerHTML = "";
    probeState.style.display = "flex";
    probeState.innerHTML = '<div class="spin"></div><span>Fetching video info… (up to a minute)</span>';
    checkBtn.disabled = true;
    statusBox.style.display = "none";

    fetch("/api/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) throw new Error(d.error);
      pollProbe(d.nonce, 0);
    }).catch(function(ex) {
      probeState.innerHTML = '<span style="color:#f87171">' + ex.message + '</span>';
      checkBtn.disabled = false;
    });
  });

  function pollProbe(nonce, tries) {
    if (tries > 48) { // ~2 minutes
      probeState.innerHTML = '<span style="color:#f87171">Timed out reading video info — try again.</span>';
      checkBtn.disabled = false;
      return;
    }
    probeTimer = setTimeout(function() {
      fetch("/api/probe/" + nonce).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ready) { pollProbe(nonce, tries + 1); return; }
        renderProbe(d);
      }).catch(function() { pollProbe(nonce, tries + 1); });
    }, 2500);
  }

  function renderProbe(d) {
    probeState.style.display = "none";
    vwrap.style.display = "block";
    var img = $("vthumb");
    img.src = d.thumbnail || "";
    img.style.display = d.thumbnail ? "block" : "none";
    $("vtitle").textContent = d.title || "Untitled";
    $("vdur").textContent = d.duration ? secs(d.duration) + " · " + (d.id || "") : (d.id || "");

    chipsBox.innerHTML = "";
    var res = (d.resolutions || []).slice(0, 7);
    if (!res.length) {
      chipsBox.innerHTML = '<span style="color:#f87171;font-size:13.5px">No downloadable video resolutions found — try the audio option.</span>';
    }
    res.forEach(function(r) {
      addChip(r.h + "p" + (r.fps ? " " + r.fps + "fps" : ""), String(r.h), r.h >= 1080);
    });
    addChip("Best available", "best", true);
    addChip("Audio only · mp3", "audio", false);
  }

  function addChip(label, value, accent) {
    var c = document.createElement("div");
    c.className = "chip" + (accent ? " accent" : "");
    c.textContent = label;
    c.addEventListener("click", function() { startDownload(value, label); });
    chipsBox.appendChild(c);
  }

  // ---- Phase 2: download at the chosen resolution ----
  function startDownload(format, label) {
    if (probeTimer) clearInterval(probeTimer);
    picker.style.display = "none";
    statusBox.style.display = "block";
    err.style.display = "none"; err.textContent = "";
    result.style.display = "none"; result.innerHTML = "";
    fill.style.width = "0%"; fill.style.background = ""; fill.style.animation = "";
    stepsBox.innerHTML = "";
    stage.textContent = "Starting " + label + "…";
    elapsed.textContent = "";
    t0 = Date.now();

    fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value, format: format })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) throw new Error(d.error);
      renderSteps("Preparing runtime");
      pollDl(d.runId);
    }).catch(function(ex) {
      statusBox.style.display = "none";
      picker.style.display = "block";
      err.style.display = "block"; err.textContent = ex.message;
    });
  }

  function renderSteps(current) {
    stepsBox.innerHTML = "";
    var idx = STEPS.indexOf(current);
    STEPS.forEach(function(s, i) {
      var div = document.createElement("div");
      div.className = "step " + (i < idx ? "done" : i === idx ? "active" : "");
      div.innerHTML = '<span class="ic">' + (i < idx ? "✓" : "") + '</span><span>' + s + "</span>";
      stepsBox.appendChild(div);
    });
  }

  function pollDl(runId) {
    dlTimer = setInterval(function() {
      fetch("/api/status/" + runId).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.found) return;
        elapsed.textContent = Math.floor((Date.now() - t0) / 1000) + "s elapsed";

        if (d.status === "completed") {
          clearInterval(dlTimer);
          if (d.conclusion === "success" && d.files && d.files.length) { finish(d.files); }
          else { fail(d.stage || "Something went wrong", d.htmlUrl); }
          return;
        }
        var st = d.stage || "Working…";
        fill.style.width = (WIDTHS[st] || 30) + "%";
        stage.textContent = st;
        renderSteps(STEPS.indexOf(st) >= 0 ? st : "Preparing runtime");
      }).catch(function() {});
    }, 2500);
  }

  function finish(files) {
    fill.style.width = "100%";
    stage.textContent = "Done ✓";
    elapsed.textContent = Math.round((Date.now() - t0) / 1000) + "s total";
    var kids = stepsBox.children;
    for (var i = 0; i < kids.length; i++) kids[i].className = "step done";
    result.style.display = "block";
    result.innerHTML = '<div class="result-head">Your file is ready</div>';
    files.forEach(function(f) {
      var a = document.createElement("a");
      a.className = "dl";
      a.href = "/api/file?path=" + encodeURIComponent(f.name);
      a.setAttribute("download", f.name);
      a.innerHTML = '<span class="ic">⬇</span><span class="meta"><span class="name"></span><span class="size">' +
        (f.size / 1048576).toFixed(1) + " MB · tap to download</span></span>";
      a.querySelector(".name").textContent = f.name;
      result.appendChild(a);
    });
  }

  function fail(msg, url) {
    fill.style.width = "100%";
    fill.style.background = "#f87171";
    fill.style.animation = "none";
    stage.textContent = "Failed";
    err.style.display = "block";
    err.innerHTML = (msg || "Download failed") +
      (url ? ' — <a href="' + url + '" target="_blank" rel="noopener">view the run log</a>' : "");
  }

  $("reset").addEventListener("click", resetAll);
  $("again").addEventListener("click", resetAll);
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
      const RES_RE = /^(best|audio|2160|1440|1080|720|480|360)$/;
      const format = RES_RE.test(body.format || "") ? body.format : "best";

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
        const { runId } = await triggerDownload(env, link, format);
        return json({ runId });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // Ask yt-dlp what resolutions the video has (runs on a runner, result
    // lands in the bucket; the UI polls GET /api/probe/:nonce for it).
    if (url.pathname === "/api/probe" && request.method === "POST") {
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
      try {
        return json(await probeVideo(env, link));
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    const probeMatch = url.pathname.match(/^\/api\/probe\/([a-f0-9]{8})$/);
    if (probeMatch && request.method === "GET") {
      try {
        return json(await getProbe(env, probeMatch[1]));
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // The probe runner POSTs its result here (authenticated with the shared
    // WORKER_SECRET) instead of pushing through a third-party store.
    if (url.pathname === "/api/probe/result" && request.method === "POST") {
      if (request.headers.get("x-probe-secret") !== env.WORKER_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!body.nonce || !/^[a-f0-9]{8}$/.test(body.nonce)) {
        return json({ error: "Missing or invalid nonce" }, 400);
      }
      try {
        await env.PROBES.put(
          `probe:${body.nonce}`,
          JSON.stringify({
            title: body.title || "",
            id: body.id || "",
            thumbnail: body.thumbnail || "",
            duration: body.duration || 0,
            resolutions: body.resolutions || [],
          }),
          { expirationTtl: 3600 }
        );
        return json({ ok: true });
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
