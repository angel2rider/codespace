// Tube Pull Client Application Logic
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // DOM Elements
  const form = $("f");
  const urlInput = $("url");
  const btnClear = $("btnClear");
  const btnPaste = $("btnPaste");
  const videoPreview = $("videoPreview");
  const previewThumb = $("previewThumb");
  const previewTitle = $("previewTitle");
  const previewAuthorName = $("previewAuthorName");
  const btnPull = $("btnPull");
  const btnPullText = $("btnPullText");

  const statusSection = $("statusSection");
  const progressBarFill = $("progressBarFill");
  const stageTitle = $("stageTitle");
  const elapsedTime = $("elapsedTime");
  const stepList = $("stepList");
  const errorCard = $("errorCard");
  const errorMessage = $("errorMessage");
  const resultsCard = $("resultsCard");
  const downloadList = $("downloadList");

  const historySection = $("historySection");
  const btnToggleHistory = $("btnToggleHistory");
  const historyBody = $("historyBody");
  const historyBadge = $("historyBadge");
  const historyList = $("historyList");
  const btnClearHistory = $("btnClearHistory");
  const historyArrow = $("historyArrow");
  const toast = $("toast");

  // Constants
  const YT_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=[\w-]{6,}|shorts\/[\w-]{6,}|playlist\?list=[\w-]+)|youtu\.be\/[\w-]{6,})/i;
  const STEPS = ["Preparing runtime", "Preparing tools", "Downloading video", "Uploading to storage"];
  const STAGE_PROGRESS = {
    "Queued": 6,
    "Queued (waiting for a runner)": 12,
    "Preparing runtime": 24,
    "Preparing tools": 45,
    "Downloading video": 72,
    "Uploading to storage": 92
  };
  const STORAGE_KEY = "tubepull_history";

  let pollTimer = null;
  let timerStart = 0;
  let oEmbedAbort = null;
  let debounceTimeout = null;
  let currentPreview = null;

  // --- Toast ---
  let toastTimer = null;
  function showToast(msg, duration = 3000) {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.remove("hidden");
    toastTimer = setTimeout(() => {
      toast.classList.add("hidden");
    }, duration);
  }

  // --- Format Utilities ---
  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return "";
    const mb = bytes / (1024 * 1024);
    return mb >= 1000 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
  }

  function formatRelativeTime(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return "Just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  }

  // --- URL Input & Live oEmbed Preview ---
  function updateClearButton() {
    btnClear.style.display = urlInput.value.trim().length > 0 ? "inline-flex" : "none";
  }

  async function fetchVideoPreview(url) {
    if (oEmbedAbort) oEmbedAbort.abort();
    oEmbedAbort = new AbortController();

    try {
      previewTitle.textContent = "Fetching video details…";
      previewAuthorName.textContent = "YouTube";
      previewThumb.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='90' height='54' fill='%231f293d'%3E%3Crect width='100%25' height='100%25'/%3E%3C/svg%3E";
      videoPreview.classList.remove("hidden");

      const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oEmbedUrl, { signal: oEmbedAbort.signal });
      if (!res.ok) throw new Error("Preview not found");
      const data = await res.json();

      currentPreview = {
        title: data.title,
        author: data.author_name,
        thumbnail: data.thumbnail_url
      };

      previewTitle.textContent = data.title || "Video";
      previewAuthorName.textContent = data.author_name || "YouTube";
      if (data.thumbnail_url) {
        previewThumb.src = data.thumbnail_url;
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        currentPreview = null;
        videoPreview.classList.add("hidden");
      }
    }
  }

  function handleUrlChange(raw) {
    updateClearButton();
    const link = (raw || "").trim();

    if (debounceTimeout) clearTimeout(debounceTimeout);

    if (YT_RE.test(link)) {
      debounceTimeout = setTimeout(() => fetchVideoPreview(link), 250);
    } else {
      if (oEmbedAbort) oEmbedAbort.abort();
      currentPreview = null;
      videoPreview.classList.add("hidden");
    }
  }

  urlInput.addEventListener("input", (e) => handleUrlChange(e.target.value));

  btnClear.addEventListener("click", () => {
    urlInput.value = "";
    handleUrlChange("");
    urlInput.focus();
  });

  btnPaste.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.readText) {
        showToast("Clipboard access not supported in this browser");
        return;
      }
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        handleUrlChange(urlInput.value);
        showToast("Pasted from clipboard");
      }
    } catch {
      showToast("Please allow clipboard permission to paste");
    }
  });

  // --- Step Rendering & Progress ---
  function renderSteps(current) {
    stepList.innerHTML = "";
    const currentIdx = STEPS.indexOf(current);

    STEPS.forEach((stepName, i) => {
      const item = document.createElement("div");
      const isDone = i < currentIdx;
      const isActive = i === currentIdx;

      item.className = "step-item" + (isDone ? " done" : isActive ? " active" : "");
      const icon = isDone ? "✓" : isActive ? "•" : (i + 1);
      item.innerHTML = `<span class="step-circle">${icon}</span><span>${stepName}</span>`;
      stepList.appendChild(item);
    });
  }

  function tickTimer() {
    const elapsed = Math.floor((Date.now() - timerStart) / 1000);
    elapsedTime.textContent = `${elapsed}s elapsed`;
  }

  // --- Polling & Workflow Status ---
  function poll(runId, format) {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${runId}`);
        const data = await res.json();
        if (!data.found) return;

        tickTimer();

        if (data.status === "completed") {
          clearInterval(pollTimer);
          if (data.conclusion === "success" && data.files?.length) {
            finish(data.files, format);
          } else {
            fail(data.stage || "Download failed. Please check the logs.", data.htmlUrl);
          }
          return;
        }

        const stage = data.stage || "Processing…";
        const progress = STAGE_PROGRESS[stage] ?? 35;
        progressBarFill.style.width = `${progress}%`;
        stageTitle.textContent = stage;
        renderSteps(STEPS.includes(stage) ? stage : "Preparing runtime");
      } catch {
        // network glitch during polling, retry automatically next tick
      }
    }, 2500);
  }

  function finish(files, format) {
    progressBarFill.style.width = "100%";
    stageTitle.textContent = "Complete ✓";
    const totalSec = Math.round((Date.now() - timerStart) / 1000);
    elapsedTime.textContent = `${totalSec}s total`;

    // Mark all steps done
    const stepCircles = stepList.querySelectorAll(".step-item");
    stepCircles.forEach((item) => {
      item.className = "step-item done";
      const circle = item.querySelector(".step-circle");
      if (circle) circle.textContent = "✓";
    });

    // Render results
    downloadList.innerHTML = "";
    resultsCard.classList.remove("hidden");

    files.forEach((f) => {
      const directUrl = `/api/file?path=${encodeURIComponent(f.name)}`;
      const absUrl = new URL(directUrl, window.location.origin).href;
      const sizeStr = formatBytes(f.size);

      const item = document.createElement("div");
      item.className = "download-item";
      item.innerHTML = `
        <div class="download-info">
          <div class="download-icon">${format === "audio" ? "🎵" : "🎬"}</div>
          <div class="download-text">
            <span class="download-filename" title="${f.name}">${f.name}</span>
            <span class="download-meta">${sizeStr ? sizeStr + " · " : ""}Ready to save</span>
          </div>
        </div>
        <div class="download-actions">
          <button type="button" class="btn-copy" data-url="${absUrl}">Copy Link</button>
          <a class="btn-download" href="${directUrl}" download="${f.name}">⬇ Save</a>
        </div>
      `;
      downloadList.appendChild(item);

      // Save to download history
      saveToHistory({
        id: Date.now() + Math.random(),
        name: f.name,
        title: currentPreview?.title || f.name,
        size: f.size,
        format: format,
        timestamp: Date.now()
      });
    });

    // Wire copy buttons
    downloadList.querySelectorAll(".btn-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const link = btn.getAttribute("data-url");
        if (link) {
          try {
            await navigator.clipboard.writeText(link);
            showToast("Download link copied to clipboard!");
          } catch {
            showToast("Failed to copy link");
          }
        }
      });
    });

    btnPull.disabled = false;
    btnPullText.textContent = "Pull";
  }

  function fail(message, url) {
    if (pollTimer) clearInterval(pollTimer);
    progressBarFill.style.width = "100%";
    progressBarFill.style.background = "var(--danger)";
    stageTitle.textContent = "Failed";

    errorMessage.innerHTML = (message || "An unexpected error occurred.") +
      (url ? ` — <a href="${url}" target="_blank" rel="noopener noreferrer">View GitHub Action log</a>` : "");
    errorCard.classList.remove("hidden");

    btnPull.disabled = false;
    btnPullText.textContent = "Pull";
  }

  // --- Form Submission ---
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const url = urlInput.value.trim();
    if (!YT_RE.test(url)) {
      showToast("Please enter a valid YouTube URL");
      urlInput.focus();
      return;
    }

    const format = form.querySelector('input[name="format"]:checked')?.value || "video";

    // Reset status UI
    errorCard.classList.add("hidden");
    errorMessage.textContent = "";
    resultsCard.classList.add("hidden");
    downloadList.innerHTML = "";
    progressBarFill.style.width = "0%";
    progressBarFill.style.background = "";
    statusSection.classList.remove("hidden");
    stageTitle.textContent = "Initiating runner…";
    elapsedTime.textContent = "";
    renderSteps("Preparing runtime");

    timerStart = Date.now();
    btnPull.disabled = true;
    btnPullText.textContent = "Starting…";

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, format })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to trigger download");

      btnPullText.textContent = "Pulling…";
      poll(data.runId, format);
    } catch (err) {
      fail(err.message);
    }
  });

  // --- History Management ---
  function getHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveToHistory(item) {
    const list = getHistory();
    // Avoid exact duplicates
    const filtered = list.filter((x) => x.name !== item.name);
    filtered.unshift(item);
    if (filtered.length > 20) filtered.pop();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    } catch { /* storage full */ }
    renderHistory();
  }

  function renderHistory() {
    const list = getHistory();
    historyBadge.textContent = list.length;

    if (list.length === 0) {
      historyList.innerHTML = '<div style="font-size:12.5px;color:var(--text-dim);padding:8px 0;">No recent downloads saved yet.</div>';
      btnClearHistory.style.display = "none";
      return;
    }

    btnClearHistory.style.display = "block";
    historyList.innerHTML = "";

    list.forEach((item) => {
      const row = document.createElement("div");
      row.className = "history-item";
      const sizeStr = formatBytes(item.size);
      const timeStr = formatRelativeTime(item.timestamp);
      const directUrl = `/api/file?path=${encodeURIComponent(item.name)}`;

      row.innerHTML = `
        <div class="history-item-info">
          <span class="history-item-title" title="${item.title || item.name}">${item.title || item.name}</span>
          <span class="history-item-meta">
            <span>${item.format === "audio" ? "🎵 MP3" : "🎬 MP4"}</span>
            ${sizeStr ? `<span>· ${sizeStr}</span>` : ""}
            <span>· ${timeStr}</span>
          </span>
        </div>
        <div class="history-actions">
          <a class="btn-history-dl" href="${directUrl}" download="${item.name}">⬇ Save</a>
        </div>
      `;
      historyList.appendChild(row);
    });
  }

  btnToggleHistory.addEventListener("click", () => {
    const isExpanded = btnToggleHistory.getAttribute("aria-expanded") === "true";
    btnToggleHistory.setAttribute("aria-expanded", !isExpanded);
    historyArrow.textContent = isExpanded ? "▾" : "▴";
    if (isExpanded) {
      historyBody.classList.add("hidden");
    } else {
      historyBody.classList.remove("hidden");
      renderHistory();
    }
  });

  btnClearHistory.addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
    showToast("History cleared");
  });

  // Initial setup
  renderHistory();
  updateClearButton();
})();
