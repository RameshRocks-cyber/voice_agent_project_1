(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const LANG_LABELS = {
    auto: "Auto",
    mixed: "Hindi + English",
    hi: "Hindi",
    en: "English",
  };

  const SETTINGS_KEY = "vaniscript_settings_v1";
  const defaultSettings = {
    defaultLanguage: "auto",
    theme: "system",
    micDeviceId: "",
    autoSavePrompt: false,
  };

  const state = {
    view: "dashboard",
    settings: loadSettings(),
    sttConfigured: true,
    // Live recording state
    recStatus: "idle", // idle | recording | paused | finalizing
    recorder: null,
    stream: null,
    ws: null,
    wsReconnects: 0,
    audioCtx: null,
    analyser: null,
    rafId: null,
    timerId: null,
    elapsedMs: 0,
    lastTickAt: 0,
    isSaving: false,
    // History state
    history: { q: "", language: "all", dateFrom: "", dateTo: "", sort: "newest", limit: 10, offset: 0 },
  };

  function loadSettings() {
    try {
      return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    } catch {
      return { ...defaultSettings };
    }
  }

  function saveSettings(next) {
    state.settings = { ...state.settings, ...next };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    applyTheme(state.settings.theme);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "system");
  }

  // ---------- Helpers ----------
  function esc(str) {
    return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  function formatTimer(ms) {
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function toast(message, type = "info") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    $("#toastContainer").appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      throw new Error((data && data.detail) || res.statusText || "Request failed");
    }
    return data;
  }

  // ---------- Navigation ----------
  function switchView(view) {
    state.view = view;
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$(".view").forEach((v) => { v.hidden = v.id !== `view-${view}`; });
    const titles = {
      dashboard: "Dashboard",
      live: "Live Transcription",
      history: "Transcription History",
      settings: "Settings",
    };
    $("#pageTitle").textContent = titles[view] || "Dashboard";
    closeMobileSidebar();

    if (view === "dashboard") loadDashboard();
    if (view === "history") loadHistory();
    if (view === "settings") loadAudioDevices();
  }

  function closeMobileSidebar() {
    $("#sidebar").classList.remove("open");
    $("#sidebarBackdrop").classList.remove("open");
  }

  // ---------- Health Check ----------
  async function checkHealth() {
    try {
      const h = await apiFetch("/api/health");
      state.sttConfigured = Boolean(h.stt_configured);
      $("#healthDot").className = `dot ${h.stt_configured ? "ok" : "warn"}`;
      $("#healthText").textContent = h.stt_configured
        ? `${h.stt} ready`
        : "GROQ_API_KEY missing";
    } catch {
      $("#healthDot").className = "dot err";
      $("#healthText").textContent = "Backend offline";
    }
  }

  // ---------- Dashboard ----------
  async function loadDashboard() {
    try {
      const stats = await apiFetch("/api/transcriptions/stats");
      $("#kpiTotal").textContent = String(stats.total_count);
      $("#kpiToday").textContent = String(stats.today_count);
      $("#kpiDuration").textContent = formatDuration(stats.total_duration_ms);

      if (stats.languages && stats.languages.length > 0) {
        const top = stats.languages[0];
        $("#kpiLanguage").textContent = LANG_LABELS[top.language] || top.language;
        $("#kpiLanguageSub").textContent = `${top.count} transcription${top.count === 1 ? "" : "s"}`;
      } else {
        $("#kpiLanguage").textContent = "No data";
        $("#kpiLanguageSub").textContent = "Record to see language breakdown";
      }

      renderActivityChart(stats.daily_activity || []);
      renderRecentList(stats.recent || []);
    } catch (err) {
      toast(`Failed to load dashboard: ${err.message}`, "error");
    }
  }

  function renderActivityChart(days) {
    const box = $("#activityChartContainer");
    if (!days.length) {
      box.innerHTML = `<div class="empty-state"><p>No transcription activity recorded yet.</p><button class="btn btn-primary btn-sm" id="chartStartBtn">Start Recording</button></div>`;
      $("#chartStartBtn")?.addEventListener("click", () => switchView("live"));
      return;
    }

    const maxCount = Math.max(...days.map((d) => d.count), 1);
    const width = 520;
    const height = 200;
    const padBottom = 26;
    const plotH = height - padBottom - 16;
    const barSlot = width / days.length;
    const barW = Math.min(34, Math.max(12, barSlot * 0.6));

    const bars = days.map((d, i) => {
      const h = Math.max(4, Math.round((d.count / maxCount) * plotH));
      const x = Math.round(i * barSlot + (barSlot - barW) / 2);
      const y = height - padBottom - h;
      const label = d.date.slice(5);
      return `
        <g>
          <title>${esc(d.date)}: ${d.count} transcription(s), ${formatDuration(d.duration_ms)}</title>
          <rect class="chart-bar" x="${x}" y="${y}" width="${barW}" height="${h}"></rect>
          <text class="chart-label" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${esc(label)}</text>
        </g>`;
    }).join("");

    box.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily transcription activity">${bars}</svg>`;
  }

  function renderRecentList(items) {
    const list = $("#recentList");
    if (!items.length) {
      list.innerHTML = `<div class="empty-state"><p>No saved transcriptions yet.</p></div>`;
      return;
    }
    list.innerHTML = items.map((item) => `
      <div class="recent-item" data-id="${item.id}">
        <div class="recent-top">
          <span class="recent-title">${esc(item.title)}</span>
          <span class="badge badge-primary">${esc(LANG_LABELS[item.language] || item.language)}</span>
        </div>
        <div class="recent-preview">${esc(item.transcript)}</div>
      </div>
    `).join("");

    list.querySelectorAll(".recent-item").forEach((el) => {
      el.addEventListener("click", () => openDetailsModal(Number(el.dataset.id)));
    });
  }

  // ---------- Live Transcription ----------
  function showLiveError(title, msg) {
    $("#liveErrorTitle").textContent = title;
    $("#liveErrorMsg").textContent = msg;
    $("#liveErrorBanner").hidden = false;
  }

  function hideLiveError() {
    $("#liveErrorBanner").hidden = true;
  }

  function updateMicPermissionBadge(permState) {
    const badge = $("#micPermBadge");
    const map = {
      granted: ["Mic: Granted", "badge-success"],
      denied: ["Mic: Denied", "badge-danger"],
      prompt: ["Mic: Ask on record", "badge-neutral"],
      unavailable: ["Mic: Unavailable", "badge-danger"],
    };
    const [text, cls] = map[permState] || ["Mic: Ready", "badge-neutral"];
    badge.textContent = text;
    badge.className = `badge ${cls}`;
  }

  async function checkMicPermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      updateMicPermissionBadge("unavailable");
      return;
    }
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const p = await navigator.permissions.query({ name: "microphone" });
        updateMicPermissionBadge(p.state);
        p.onchange = () => updateMicPermissionBadge(p.state);
      } catch {
        updateMicPermissionBadge("prompt");
      }
    }
  }

  function updateRecorderUI() {
    const s = state.recStatus;
    const badge = $("#recStateBadge");
    const labels = {
      idle: ["Idle", "badge-neutral"],
      recording: ["Recording (Live)", "badge-danger"],
      paused: ["Paused", "badge-warning"],
      finalizing: ["Finalizing…", "badge-primary"],
    };
    const [text, cls] = labels[s] || labels.idle;
    badge.textContent = text;
    badge.className = `badge ${cls}`;

    $("#startRecBtn").disabled = s !== "idle";
    $("#pauseRecBtn").disabled = s !== "recording" && s !== "paused";
    $("#pauseRecBtn").textContent = s === "paused" ? "Resume" : "Pause";
    $("#stopRecBtn").disabled = s !== "recording" && s !== "paused";

    const hasText = $("#finalTranscript").value.trim().length > 0;
    $("#saveLiveBtn").disabled = !hasText || state.isSaving || s === "finalizing";
    $("#clearLiveBtn").disabled = !hasText && !$("#interimTranscript").dataset.active;
    $("#copyLiveBtn").disabled = !hasText;

    const words = $("#finalTranscript").value.trim().split(/\s+/).filter(Boolean).length;
    $("#liveWordCount").textContent = `${words} word${words === 1 ? "" : "s"}`;
  }

  function pickMime() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  function startMeter(stream) {
    state.audioCtx = state.audioCtx || new AudioContext();
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 256;
    state.audioCtx.createMediaStreamSource(stream).connect(state.analyser);
    const buf = new Uint8Array(state.analyser.frequencyBinCount);
    const tick = () => {
      if (state.recStatus === "recording") {
        state.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 320));
        $("#meterFill").style.width = `${level}%`;
      } else {
        $("#meterFill").style.width = "0%";
      }
      state.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  function startTimer() {
    state.lastTickAt = Date.now();
    state.timerId = setInterval(() => {
      if (state.recStatus === "recording") {
        const now = Date.now();
        state.elapsedMs += now - state.lastTickAt;
        state.lastTickAt = now;
        $("#recTimer").textContent = formatTimer(state.elapsedMs);
      } else {
        state.lastTickAt = Date.now();
      }
    }, 250);
  }

  function stopMediaResources() {
    cancelAnimationFrame(state.rafId);
    clearInterval(state.timerId);
    $("#meterFill").style.width = "0%";
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
  }

  function openTranscriptionSocket(lang, mime) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/transcribe?language=${encodeURIComponent(lang)}&mime=${encodeURIComponent(mime || "audio/webm")}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        state.wsReconnects = 0;
        resolve(ws);
      };
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
      ws.onmessage = (ev) => handleWsMessage(ev.data);
      ws.onclose = () => {
        if (state.recStatus === "recording" || state.recStatus === "paused") {
          showLiveError("Connection Interrupted", "WebSocket connection closed while recording. Your transcript so far is preserved.");
          stopRecording();
        }
      };
    });
  }

  function handleWsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "interim") {
      const box = $("#interimTranscript");
      box.textContent = msg.text || "Listening…";
      box.dataset.active = msg.text ? "1" : "";
      box.classList.remove("muted");
      $("#interimLatency").textContent = msg.stt_ms ? `${msg.stt_ms} ms` : "";
    } else if (msg.type === "final") {
      const finalBox = $("#finalTranscript");
      if (msg.text) {
        const existing = finalBox.value.trim();
        finalBox.value = existing ? `${existing}\n${msg.text}` : msg.text;
      } else if (!finalBox.value.trim()) {
        showLiveError("No Speech Detected", "The audio did not contain recognizable speech. Please try speaking closer to the microphone.");
      }
      $("#interimTranscript").textContent = "Waiting for speech…";
      $("#interimTranscript").dataset.active = "";
      $("#interimTranscript").classList.add("muted");
      $("#interimLatency").textContent = msg.stt_ms ? `Finalized in ${msg.stt_ms} ms` : "";
      state.recStatus = "idle";
      updateRecorderUI();
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.close();
      }
      if (state.settings.autoSavePrompt && finalBox.value.trim()) {
        openSaveModal();
      }
    } else if (msg.type === "limit_reached") {
      showLiveError(
        "Recording Limit Reached",
        msg.message || "Maximum recording size reached. Your transcript has been finalized."
      );
      toast("Recording limit reached and finalized.", "info");
      if (state.recorder && (state.recorder.state === "recording" || state.recorder.state === "paused")) {
        state.recorder.stop();
      } else {
        stopMediaResources();
        state.recStatus = "idle";
        updateRecorderUI();
      }
    } else if (msg.type === "error") {
      showLiveError("Transcription Service Error", msg.message || "Speech-to-text failed.");
      state.recStatus = "idle";
      updateRecorderUI();
    }
  }

  async function startRecording() {
    if (state.recStatus !== "idle") return;
    hideLiveError();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showLiveError("Microphone Unsupported", "Your browser does not support audio recording. Use Chrome, Edge, or Safari over localhost/HTTPS.");
      return;
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      ...(state.settings.micDeviceId ? { deviceId: { exact: state.settings.micDeviceId } } : {}),
    };

    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      updateMicPermissionBadge("granted");
    } catch (err) {
      const denied = err.name === "NotAllowedError" || err.name === "PermissionDeniedError";
      updateMicPermissionBadge(denied ? "denied" : "unavailable");
      showLiveError(
        denied ? "Microphone Permission Denied" : "Microphone Unavailable",
        denied
          ? "Please allow microphone access in your browser settings and click Retry."
          : `Could not access microphone (${err.message}). Check your audio device.`
      );
      return;
    }

    const mime = pickMime();
    const lang = $("#liveLanguage").value;

    try {
      state.ws = await openTranscriptionSocket(lang, mime || "audio/webm");
    } catch (err) {
      stopMediaResources();
      showLiveError("Backend Connection Failed", "Could not open real-time transcription stream. Ensure the FastAPI server is running.");
      return;
    }

    state.elapsedMs = 0;
    $("#recTimer").textContent = "00:00";
    state.recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
    state.recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0 && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(await e.data.arrayBuffer());
      }
    };
    state.recorder.onstop = () => {
      const wasActive = state.recStatus === "recording" || state.recStatus === "paused";
      stopMediaResources();
      if (wasActive && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.recStatus = "finalizing";
        updateRecorderUI();
        state.ws.send(JSON.stringify({ type: "stop" }));
      } else {
        state.recStatus = "idle";
        updateRecorderUI();
      }
    };

    state.recStatus = "recording";
    state.recorder.start(1200); // 1.2s timeslice for progressive streaming
    startMeter(state.stream);
    startTimer();
    updateRecorderUI();
  }

  function togglePauseRecording() {
    if (!state.recorder) return;
    if (state.recStatus === "recording" && state.recorder.state === "recording") {
      state.recorder.pause();
      state.recStatus = "paused";
    } else if (state.recStatus === "paused" && state.recorder.state === "paused") {
      state.recorder.resume();
      state.recStatus = "recording";
      state.lastTickAt = Date.now();
    }
    updateRecorderUI();
  }

  function stopRecording() {
    if (state.recorder && (state.recorder.state === "recording" || state.recorder.state === "paused")) {
      state.recorder.stop();
    } else {
      stopMediaResources();
      state.recStatus = "idle";
      updateRecorderUI();
    }
  }

  function openSaveModal() {
    const transcript = $("#finalTranscript").value.trim();
    if (!transcript) {
      toast("Nothing to save yet.", "error");
      return;
    }
    const defaultTitle = `Transcription · ${new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    const lang = $("#liveLanguage").value;

    $("#modalTitle").textContent = "Save Transcription";
    $("#modalBody").innerHTML = `
      <div class="form-group">
        <label for="saveTitleInput">Title</label>
        <input id="saveTitleInput" class="input" value="${esc(defaultTitle)}" maxlength="200">
      </div>
      <div class="form-group">
        <label for="saveLangSelect">Language</label>
        <select id="saveLangSelect" class="input">
          <option value="auto" ${lang === "auto" ? "selected" : ""}>Automatic Detection</option>
          <option value="mixed" ${lang === "mixed" ? "selected" : ""}>Hindi + English (Hinglish)</option>
          <option value="hi" ${lang === "hi" ? "selected" : ""}>Hindi</option>
          <option value="en" ${lang === "en" ? "selected" : ""}>English</option>
        </select>
      </div>
      <div class="form-group">
        <label>Preview</label>
        <div class="detail-text">${esc(transcript)}</div>
      </div>
    `;
    $("#modalFooter").innerHTML = `
      <button class="btn btn-ghost" id="cancelSaveModalBtn">Cancel</button>
      <button class="btn btn-primary" id="confirmSaveBtn">Save to Database</button>
    `;
    $("#detailModal").hidden = false;
    $("#cancelSaveModalBtn").onclick = closeDetailModal;
    $("#confirmSaveBtn").onclick = async () => {
      const btn = $("#confirmSaveBtn");
      const title = $("#saveTitleInput").value.trim() || defaultTitle;
      const chosenLang = $("#saveLangSelect").value;
      btn.disabled = true;
      state.isSaving = true;
      updateRecorderUI();
      try {
        await apiFetch("/api/transcriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            transcript,
            language: chosenLang,
            duration_ms: state.elapsedMs,
          }),
        });
        toast("Transcription saved to database.", "success");
        closeDetailModal();
        loadDashboard();
      } catch (err) {
        showLiveError("Database Save Failed", `${err.message}. Your transcript is still preserved in the editor.`);
        toast(`Save failed: ${err.message}`, "error");
      } finally {
        btn.disabled = false;
        state.isSaving = false;
        updateRecorderUI();
      }
    };
  }

  // ---------- History & CRUD ----------
  async function loadHistory() {
    const h = state.history;
    const params = new URLSearchParams({
      q: h.q,
      language: h.language,
      date_from: h.dateFrom,
      date_to: h.dateTo,
      sort: h.sort,
      limit: String(h.limit),
      offset: String(h.offset),
    });

    $("#historyContent").innerHTML = `<div class="empty-state"><p>Loading transcriptions…</p></div>`;
    try {
      const data = await apiFetch(`/api/transcriptions?${params.toString()}`);
      renderHistoryTable(data);
    } catch (err) {
      $("#historyContent").innerHTML = `<div class="empty-state"><p class="muted">Failed to load history: ${esc(err.message)}</p></div>`;
    }
  }

  function renderHistoryTable(data) {
    const wrap = $("#historyContent");
    const pag = $("#historyPagination");
    if (!data.items || data.items.length === 0) {
      pag.hidden = true;
      wrap.innerHTML = `<div class="empty-state"><p>No transcriptions match your filters.</p><button class="btn btn-primary btn-sm" id="emptyRecordBtn">Create Recording</button></div>`;
      $("#emptyRecordBtn")?.addEventListener("click", () => switchView("live"));
      return;
    }

    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Preview</th>
            <th>Language</th>
            <th>Duration</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${data.items.map((item) => `
            <tr>
              <td><strong>${esc(item.title)}</strong></td>
              <td class="preview-cell">${esc(item.transcript)}</td>
              <td><span class="badge badge-primary">${esc(LANG_LABELS[item.language] || item.language)}</span></td>
              <td class="mono">${formatDuration(item.duration_ms)}</td>
              <td>${esc(formatDate(item.created_at))}</td>
              <td>
                <div class="btn-row">
                  <button class="btn btn-ghost btn-sm" data-action="view" data-id="${item.id}">View</button>
                  <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${item.id}">Edit</button>
                  <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${item.id}">Delete</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    wrap.querySelectorAll("button[data-action]").forEach((btn) => {
      const id = Number(btn.dataset.id);
      const act = btn.dataset.action;
      btn.addEventListener("click", () => {
        if (act === "view") openDetailsModal(id);
        if (act === "edit") openEditModal(id);
        if (act === "delete") confirmDelete(id);
      });
    });

    const start = data.offset + 1;
    const end = Math.min(data.offset + data.items.length, data.total);
    $("#paginationInfo").textContent = `Showing ${start}–${end} of ${data.total}`;
    $("#prevPageBtn").disabled = data.offset <= 0;
    $("#nextPageBtn").disabled = end >= data.total;
    pag.hidden = false;
  }

  async function openDetailsModal(id) {
    try {
      const item = await apiFetch(`/api/transcriptions/${id}`);
      $("#modalTitle").textContent = item.title;
      $("#modalBody").innerHTML = `
        <div class="detail-meta">
          <span class="badge badge-primary">${esc(LANG_LABELS[item.language] || item.language)}</span>
          <span>Created: ${esc(formatDate(item.created_at))}</span>
          <span>Duration: ${formatDuration(item.duration_ms)}</span>
          <span>Words: ${item.word_count}</span>
        </div>
        <div class="detail-text">${esc(item.transcript)}</div>
      `;
      $("#modalFooter").innerHTML = `
        <button class="btn btn-ghost btn-sm" id="detailCopyBtn">Copy</button>
        <button class="btn btn-ghost btn-sm" id="detailTxtBtn">Download TXT</button>
        <button class="btn btn-ghost btn-sm" id="detailPdfBtn">Export PDF</button>
        <button class="btn btn-secondary btn-sm" id="detailEditBtn">Edit</button>
        <button class="btn btn-danger btn-sm" id="detailDeleteBtn">Delete</button>
      `;
      $("#detailModal").hidden = false;

      $("#detailCopyBtn").onclick = () => copyText(item.transcript);
      $("#detailTxtBtn").onclick = () => downloadTxt(item);
      $("#detailPdfBtn").onclick = () => printPdf(item);
      $("#detailEditBtn").onclick = () => openEditModal(item.id);
      $("#detailDeleteBtn").onclick = () => confirmDelete(item.id);
    } catch (err) {
      toast(`Could not load transcription: ${err.message}`, "error");
    }
  }

  async function openEditModal(id) {
    try {
      const item = await apiFetch(`/api/transcriptions/${id}`);
      $("#modalTitle").textContent = "Edit Transcription";
      $("#modalBody").innerHTML = `
        <div class="form-group">
          <label for="editTitle">Title</label>
          <input id="editTitle" class="input" value="${esc(item.title)}" maxlength="200">
        </div>
        <div class="form-group">
          <label for="editLang">Language</label>
          <select id="editLang" class="input">
            <option value="auto" ${item.language === "auto" ? "selected" : ""}>Automatic Detection</option>
            <option value="mixed" ${item.language === "mixed" ? "selected" : ""}>Hindi + English (Hinglish)</option>
            <option value="hi" ${item.language === "hi" ? "selected" : ""}>Hindi</option>
            <option value="en" ${item.language === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
        <div class="form-group">
          <label for="editTranscript">Transcript</label>
          <textarea id="editTranscript" class="transcript-box" rows="8">${esc(item.transcript)}</textarea>
        </div>
      `;
      $("#modalFooter").innerHTML = `
        <button class="btn btn-ghost" id="editCancelBtn">Cancel</button>
        <button class="btn btn-primary" id="editSaveBtn">Save Changes</button>
      `;
      $("#detailModal").hidden = false;
      $("#editCancelBtn").onclick = closeDetailModal;
      $("#editSaveBtn").onclick = async () => {
        const title = $("#editTitle").value.trim();
        const transcript = $("#editTranscript").value.trim();
        const language = $("#editLang").value;
        if (!title || !transcript) {
          toast("Title and transcript cannot be empty.", "error");
          return;
        }
        $("#editSaveBtn").disabled = true;
        try {
          await apiFetch(`/api/transcriptions/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, transcript, language }),
          });
          toast("Transcription updated.", "success");
          closeDetailModal();
          if (state.view === "history") loadHistory();
          if (state.view === "dashboard") loadDashboard();
        } catch (err) {
          toast(`Update failed: ${err.message}`, "error");
        } finally {
          $("#editSaveBtn").disabled = false;
        }
      };
    } catch (err) {
      toast(`Could not load transcription: ${err.message}`, "error");
    }
  }

  function openNewManualModal() {
    $("#modalTitle").textContent = "New Manual Transcription";
    $("#modalBody").innerHTML = `
      <div class="form-group">
        <label for="newTitle">Title</label>
        <input id="newTitle" class="input" placeholder="e.g., Team Standup Notes" maxlength="200">
      </div>
      <div class="form-group">
        <label for="newLang">Language</label>
        <select id="newLang" class="input">
          <option value="auto">Automatic Detection</option>
          <option value="mixed">Hindi + English (Hinglish)</option>
          <option value="hi">Hindi</option>
          <option value="en">English</option>
        </select>
      </div>
      <div class="form-group">
        <label for="newTranscript">Transcript</label>
        <textarea id="newTranscript" class="transcript-box" rows="8" placeholder="Enter or paste transcription text..."></textarea>
      </div>
    `;
    $("#modalFooter").innerHTML = `
      <button class="btn btn-ghost" id="newCancelBtn">Cancel</button>
      <button class="btn btn-primary" id="newSaveBtn">Create</button>
    `;
    $("#detailModal").hidden = false;
    $("#newCancelBtn").onclick = closeDetailModal;
    $("#newSaveBtn").onclick = async () => {
      const title = $("#newTitle").value.trim();
      const transcript = $("#newTranscript").value.trim();
      const language = $("#newLang").value;
      if (!title || !transcript) {
        toast("Please enter both title and transcript.", "error");
        return;
      }
      $("#newSaveBtn").disabled = true;
      try {
        await apiFetch("/api/transcriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, transcript, language, duration_ms: 0 }),
        });
        toast("Transcription created.", "success");
        closeDetailModal();
        loadHistory();
      } catch (err) {
        toast(`Create failed: ${err.message}`, "error");
      } finally {
        $("#newSaveBtn").disabled = false;
      }
    };
  }

  function confirmAction(title, message, onConfirm) {
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    $("#confirmModal").hidden = false;
    const close = () => { $("#confirmModal").hidden = true; };
    $("#closeConfirmBtn").onclick = close;
    $("#confirmCancelBtn").onclick = close;
    $("#confirmOkBtn").onclick = async () => {
      close();
      await onConfirm();
    };
  }

  function confirmDelete(id) {
    confirmAction(
      "Delete Transcription",
      "Are you sure you want to permanently delete this transcription? This action cannot be undone.",
      async () => {
        try {
          await apiFetch(`/api/transcriptions/${id}`, { method: "DELETE" });
          toast("Transcription deleted.", "success");
          closeDetailModal();
          if (state.view === "history") loadHistory();
          if (state.view === "dashboard") loadDashboard();
        } catch (err) {
          toast(`Delete failed: ${err.message}`, "error");
        }
      }
    );
  }

  function closeDetailModal() {
    $("#detailModal").hidden = true;
  }

  // ---------- Export & Copy ----------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard.", "success");
    } catch {
      toast("Clipboard copy failed.", "error");
    }
  }

  function downloadTxt(item) {
    const content = [
      `Title: ${item.title}`,
      `Date: ${formatDate(item.created_at)}`,
      `Language: ${LANG_LABELS[item.language] || item.language}`,
      `Duration: ${formatDuration(item.duration_ms)}`,
      "",
      "---",
      "",
      item.transcript,
    ].join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${item.title.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 48) || "transcription"}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function printPdf(item) {
    $("#printSheet").innerHTML = `
      <h1>${esc(item.title)}</h1>
      <div class="print-meta">
        Date: ${esc(formatDate(item.created_at))} · Language: ${esc(LANG_LABELS[item.language] || item.language)} · Duration: ${formatDuration(item.duration_ms)}
      </div>
      <div class="print-body">${esc(item.transcript)}</div>
    `;
    window.print();
  }

  // ---------- Settings ----------
  async function loadAudioDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      const sel = $("#settingMicDevice");
      sel.innerHTML = `<option value="">System Default Microphone</option>` +
        mics.map((m, i) => `<option value="${esc(m.deviceId)}">${esc(m.label || `Microphone ${i + 1}`)}</option>`).join("");
      sel.value = state.settings.micDeviceId || "";
    } catch { /* ignore */ }
  }

  function syncSettingsUI() {
    $("#settingDefaultLang").value = state.settings.defaultLanguage;
    $("#liveLanguage").value = state.settings.defaultLanguage;
    $("#settingTheme").value = state.settings.theme;
    $("#settingAutoSave").checked = Boolean(state.settings.autoSavePrompt);
    applyTheme(state.settings.theme);
  }

  // ---------- Event Wiring ----------
  function initEvents() {
    $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
    $("#menuBtn").addEventListener("click", () => {
      $("#sidebar").classList.add("open");
      $("#sidebarBackdrop").classList.add("open");
    });
    $("#sidebarBackdrop").addEventListener("click", closeMobileSidebar);
    $("#quickRecordBtn").addEventListener("click", () => switchView("live"));
    $("#viewAllHistoryBtn").addEventListener("click", () => switchView("history"));
    $("#refreshDashboardBtn").addEventListener("click", loadDashboard);

    $("#themeToggleBtn").addEventListener("click", () => {
      const next = state.settings.theme === "dark" ? "light" : "dark";
      saveSettings({ theme: next });
      $("#settingTheme").value = next;
    });

    // Live view
    $("#startRecBtn").addEventListener("click", startRecording);
    $("#pauseRecBtn").addEventListener("click", togglePauseRecording);
    $("#stopRecBtn").addEventListener("click", stopRecording);
    $("#saveLiveBtn").addEventListener("click", openSaveModal);
    $("#copyLiveBtn").addEventListener("click", () => copyText($("#finalTranscript").value));
    $("#clearLiveBtn").addEventListener("click", () => {
      confirmAction("Clear Transcript", "Clear the current transcript text from the editor?", () => {
        $("#finalTranscript").value = "";
        $("#interimTranscript").textContent = "Waiting for speech…";
        $("#interimTranscript").dataset.active = "";
        $("#interimTranscript").classList.add("muted");
        $("#recTimer").textContent = "00:00";
        state.elapsedMs = 0;
        updateRecorderUI();
      });
    });
    $("#finalTranscript").addEventListener("input", updateRecorderUI);
    $("#liveRetryBtn").addEventListener("click", () => { hideLiveError(); startRecording(); });
    $("#liveDismissErrBtn").addEventListener("click", hideLiveError);

    // History filters
    let searchTimer;
    $("#historySearch").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.history.q = e.target.value;
        state.history.offset = 0;
        loadHistory();
      }, 220);
    });
    $("#historyLangFilter").addEventListener("change", (e) => {
      state.history.language = e.target.value;
      state.history.offset = 0;
      loadHistory();
    });
    $("#historyDateFrom").addEventListener("change", (e) => {
      state.history.dateFrom = e.target.value;
      state.history.offset = 0;
      loadHistory();
    });
    $("#historyDateTo").addEventListener("change", (e) => {
      state.history.dateTo = e.target.value;
      state.history.offset = 0;
      loadHistory();
    });
    $("#historySort").addEventListener("change", (e) => {
      state.history.sort = e.target.value;
      state.history.offset = 0;
      loadHistory();
    });
    $("#prevPageBtn").addEventListener("click", () => {
      state.history.offset = Math.max(0, state.history.offset - state.history.limit);
      loadHistory();
    });
    $("#nextPageBtn").addEventListener("click", () => {
      state.history.offset += state.history.limit;
      loadHistory();
    });
    $("#newManualBtn").addEventListener("click", openNewManualModal);

    // Settings
    $("#settingDefaultLang").addEventListener("change", (e) => {
      saveSettings({ defaultLanguage: e.target.value });
      $("#liveLanguage").value = e.target.value;
      toast("Default language updated.", "success");
    });
    $("#settingTheme").addEventListener("change", (e) => {
      saveSettings({ theme: e.target.value });
    });
    $("#settingMicDevice").addEventListener("change", (e) => {
      saveSettings({ micDeviceId: e.target.value });
      toast("Microphone preference saved.", "success");
    });
    $("#settingAutoSave").addEventListener("change", (e) => {
      saveSettings({ autoSavePrompt: e.target.checked });
    });

    // Modals
    $("#closeModalBtn").addEventListener("click", closeDetailModal);
    $("#detailModal").addEventListener("click", (e) => {
      if (e.target.id === "detailModal") closeDetailModal();
    });

    // Keyboard shortcuts (ignored when typing in inputs/textareas/selects)
    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : "";
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (state.view === "live" && $("#finalTranscript").value.trim()) {
          e.preventDefault();
          openSaveModal();
        }
        return;
      }

      if (typing) return;

      if (e.code === "Space" && state.view === "live") {
        e.preventDefault();
        if (state.recStatus === "idle") startRecording();
        else if (state.recStatus === "recording" || state.recStatus === "paused") stopRecording();
      } else if (e.key === "/") {
        e.preventDefault();
        switchView("history");
        setTimeout(() => $("#historySearch").focus(), 50);
      } else if (e.key === "Escape") {
        closeDetailModal();
      }
    });
  }

  // ---------- Boot ----------
  syncSettingsUI();
  initEvents();
  checkHealth();
  checkMicPermission();
  updateRecorderUI();
  loadDashboard();
})();
