(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const LANG_LABELS = {
    auto: "Auto",
    mixed: "Hindi + English",
    hi: "Hindi",
    te: "Telugu",
    en: "English",
  };

  const SETTINGS_KEY = "vaniscript_settings_v1";
  const defaultSettings = {
    defaultLanguage: "auto",
    theme: "light",
    micDeviceId: "",
    autoSavePrompt: false,
    reducedMotion: false,
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
    // Hands-free Voice Mode state
    vm: {
      active: false,
      starting: false,
      inFlightChat: false,
      status: "off", // off | listening | capturing | thinking | speaking | paused | muted | error
      muted: false,
      paused: false,
      pttHeld: false,
      sessionId: crypto.randomUUID(),
      stream: null,
      audioCtx: null,
      analyser: null,
      rafId: null,
      recorder: null,
      ws: null,
      chunks: [],
      finalHandled: false,
      utteranceAborted: false,
      activeUtteranceId: 0,
      submittedUtteranceIds: new Set(),
      detector: null,
      sourceNode: null,
      processorNode: null,
      silentGain: null,
      activeUtterance: null,
      ttsWatchdog: null,
      speakingStartedAt: 0,
      speechStartedAt: 0,
      lastLoudAt: 0,
      onsetLoudSince: 0,
      activeSpeechMs: 0,
      noiseFloor: 0.006,
      bargeInLoudSince: 0,
      messages: [], // {role, text, meta}
    },
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
    document.documentElement.setAttribute("data-reduced-motion", state.settings.reducedMotion ? "true" : "false");
  }

  function applyTheme(theme) {
    const resolved = theme || "light";
    document.documentElement.setAttribute("data-theme", resolved);
    const btn = $("#themeToggleBtn");
    if (btn) btn.textContent = resolved === "dark" ? "Light mode" : "Dark mode";
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
  const VALID_VIEWS = new Set(["dashboard", "voice-mode", "live", "history", "settings"]);

  function switchView(view) {
    const targetView = VALID_VIEWS.has(view) ? view : "dashboard";
    state.view = targetView;
    $$(".nav-item").forEach((b) => {
      const isMatch = b.dataset.view === targetView;
      b.classList.toggle("active", isMatch);
      b.setAttribute("aria-current", isMatch ? "page" : "false");
    });
    $$(".view").forEach((v) => {
      const isMatch = v.id === `view-${targetView}`;
      v.hidden = !isMatch;
      v.classList.toggle("active", isMatch);
      v.style.display = "";
    });
    const titles = {
      dashboard: "Workspace",
      "voice-mode": "Voice Mode",
      live: "Live Studio",
      history: "History",
      settings: "Settings",
    };
    $("#pageTitle").textContent = titles[targetView] || "Workspace";
    if (location.hash !== `#${targetView}`) {
      history.replaceState(null, "", `#${targetView}`);
    }
    closeMobileSidebar();

    if (targetView === "dashboard") loadDashboard();
    if (targetView === "history") loadHistory();
    if (targetView === "settings") loadAudioDevices();
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
      box.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          </div>
          <div class="empty-title">No activity yet</div>
          <p>Start a live transcription to populate your 14-day activity chart.</p>
          <button class="btn btn-primary btn-sm" id="chartStartBtn">Start Recording</button>
        </div>`;
      $("#chartStartBtn")?.addEventListener("click", () => switchView("live"));
      return;
    }

    const maxCount = Math.max(...days.map((d) => d.count), 1);
    const width = 540;
    const height = 216;
    const padLeft = 28;
    const padRight = 12;
    const padTop = 16;
    const padBottom = 28;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const barSlot = plotW / days.length;
    const barW = Math.min(30, Math.max(12, barSlot * 0.56));

    const midCount = Math.ceil(maxCount / 2);
    const ticks = [...new Set([0, midCount, maxCount])];
    const gridLines = ticks.map((val) => {
      const y = Math.round(padTop + plotH - (val / maxCount) * plotH);
      return `
        <line class="chart-grid" x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}"></line>
        <text class="chart-label" x="${padLeft - 6}" y="${y + 3}" text-anchor="end">${val}</text>
      `;
    }).join("");

    const bars = days.map((d, i) => {
      const h = Math.max(4, Math.round((d.count / maxCount) * plotH));
      const x = Math.round(padLeft + i * barSlot + (barSlot - barW) / 2);
      const y = padTop + plotH - h;
      const label = d.date.slice(5);
      return `
        <g>
          <title>${esc(d.date)}: ${d.count} transcription(s), ${formatDuration(d.duration_ms)}</title>
          <rect class="chart-bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="4"></rect>
          <text class="chart-label" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${esc(label)}</text>
        </g>`;
    }).join("");

    box.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily transcription activity">
        ${gridLines}
        <line class="chart-axis" x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}"></line>
        ${bars}
      </svg>`;
  }

  function renderRecentList(items) {
    const list = $("#recentList");
    if (!items.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
          </div>
          <div class="empty-title">No conversations yet</div>
          <p>Record your first Hindi, English, or Hinglish session to build your library.</p>
          <button class="btn btn-primary btn-sm" id="emptyRecentStartBtn">Start recording</button>
        </div>`;
      $("#emptyRecentStartBtn")?.addEventListener("click", () => {
        switchView("live");
        startRecording();
      });
      return;
    }
    list.innerHTML = items.map((item) => `
      <div class="recent-row" data-id="${item.id}">
        <div class="recent-row-main">
          <div class="recent-title">${esc(item.title)}</div>
          <div class="recent-preview">${esc(item.transcript)}</div>
        </div>
        <div class="recent-row-meta">
          <span class="badge badge-primary">${esc(LANG_LABELS[item.language] || item.language)}</span>
          <span class="mono">${formatDuration(item.duration_ms)}</span>
          <span>${esc(formatDate(item.created_at))}</span>
          <span class="badge badge-success">Saved</span>
        </div>
      </div>
    `).join("");

    list.querySelectorAll(".recent-row").forEach((el) => {
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
    $("#cancelRecBtn").disabled = s !== "recording" && s !== "paused";

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

  const IDLE_WAVE_HEIGHTS = [24, 38, 52, 34, 68, 44, 78, 56, 36, 62, 84, 48, 30, 72, 90, 54, 40, 66, 76, 46, 32, 58, 42, 28];

  function initWaveforms() {
    for (const id of ["heroWaveform", "liveWaveform", "vmWaveform"]) {
      const el = $(`#${id}`);
      if (!el) continue;
      el.innerHTML = IDLE_WAVE_HEIGHTS.map((h) => `<span class="wave-bar" style="height:${h}%"></span>`).join("");
    }
  }

  function resetLiveWaveform() {
    const bars = $$("#liveWaveform .wave-bar");
    bars.forEach((b, i) => {
      b.style.height = `${IDLE_WAVE_HEIGHTS[i % IDLE_WAVE_HEIGHTS.length]}%`;
      b.classList.remove("active");
    });
  }

  function startMeter(stream) {
    state.audioCtx = state.audioCtx || new AudioContext();
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 256;
    state.audioCtx.createMediaStreamSource(stream).connect(state.analyser);
    const buf = new Uint8Array(state.analyser.frequencyBinCount);
    const bars = $$("#liveWaveform .wave-bar");
    const tick = () => {
      if (state.recStatus === "recording") {
        state.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 320));
        $("#meterFill").style.width = `${level}%`;
        bars.forEach((bar, i) => {
          const sample = Math.abs((buf[(i * 4) % buf.length] - 128) / 128);
          const pct = Math.max(14, Math.min(100, Math.round(sample * 240 + level * 0.35)));
          bar.style.height = `${pct}%`;
          bar.classList.toggle("active", level > 4);
        });
      } else {
        $("#meterFill").style.width = "0%";
        resetLiveWaveform();
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
    resetLiveWaveform();
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
      state.cancelRequested = true;
      if (state.recorder && (state.recorder.state === "recording" || state.recorder.state === "paused")) {
        state.recorder.stop();
      } else {
        stopMediaResources();
      }
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.close();
      }
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
      const cancelled = state.cancelRequested;
      state.cancelRequested = false;
      stopMediaResources();
      if (!cancelled && wasActive && state.ws && state.ws.readyState === WebSocket.OPEN) {
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

  function cancelRecording() {
    state.cancelRequested = true;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.close();
    }
    if (state.recorder && (state.recorder.state === "recording" || state.recorder.state === "paused")) {
      state.recorder.stop();
    } else {
      stopMediaResources();
    }
    $("#interimTranscript").textContent = "Waiting for speech…";
    $("#interimTranscript").dataset.active = "";
    $("#interimTranscript").classList.add("muted");
    $("#interimLatency").textContent = "";
    state.recStatus = "idle";
    updateRecorderUI();
    toast("Recording cancelled.", "info");
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
    $("#settingReducedMotion").checked = Boolean(state.settings.reducedMotion);
    document.documentElement.setAttribute("data-reduced-motion", state.settings.reducedMotion ? "true" : "false");
    applyTheme(state.settings.theme);
  }

  // ---------- Event Wiring ----------
  function initEvents() {
    $(".nav-list")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".nav-item[data-view]");
      if (btn) switchView(btn.dataset.view);
    });
    window.addEventListener("hashchange", () => {
      const h = location.hash.replace(/^#\/?/, "");
      if (VALID_VIEWS.has(h) && h !== state.view) switchView(h);
    });
    $("#menuBtn").addEventListener("click", () => {
      $("#sidebar").classList.add("open");
      $("#sidebarBackdrop").classList.add("open");
    });
    $("#sidebarBackdrop").addEventListener("click", closeMobileSidebar);
    $("#heroVoiceOrbBtn")?.addEventListener("click", () => {
      switchView("voice-mode");
    });
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
    $("#cancelRecBtn").addEventListener("click", cancelRecording);
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
    $("#settingReducedMotion").addEventListener("change", (e) => {
      saveSettings({ reducedMotion: e.target.checked });
    });

    // Voice Mode controls
    $("#vmStartBtn").addEventListener("click", startVoiceSession);
    $("#vmInterruptBtn")?.addEventListener("click", interruptVmSpeech);
    $("#vmPauseBtn")?.addEventListener("click", toggleVmPause);
    $("#vmEndBtn").addEventListener("click", endVoiceSession);
    $("#vmMuteBtn").addEventListener("click", toggleVmMute);
    $("#vmSettingsBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleVmSettingsPopover();
    });
    $("#vmSettingsCloseBtn")?.addEventListener("click", () => closeVmSettingsPopover(true));
    document.addEventListener("click", (e) => {
      const pop = $("#vmSettingsPopover");
      const btn = $("#vmSettingsBtn");
      if (!pop || pop.hidden) return;
      if (!pop.contains(e.target) && (!btn || !btn.contains(e.target))) {
        closeVmSettingsPopover(false);
      }
    });
    $("#vmLanguage")?.addEventListener("change", updateVmQuickMeta);
    $("#vmVoiceSelect")?.addEventListener("change", updateVmQuickMeta);
    $("#vmSensitivity")?.addEventListener("change", (e) => {
      if (!state.vm.active) return;
      state.vm.detector?.setConfig(e.target.value, { silenceMs: Number($("#vmSilenceMs")?.value || 1500) });
      const msg = e.target.value === "noisy"
        ? "Noisy room sensitivity active (stricter filtering may miss quiet speech)."
        : e.target.value === "quiet"
          ? "Quiet room sensitivity active."
          : "Balanced sensitivity active.";
      setVmStatus(vmIdleStatus(), msg);
    });
    $("#vmSilenceMs")?.addEventListener("change", (e) => {
      if (!state.vm.active) return;
      state.vm.detector?.setConfig($("#vmSensitivity")?.value || "balanced", { silenceMs: Number(e.target.value || 1500) });
    });
    $("#vmCaptureMode")?.addEventListener("change", (e) => {
      if (!state.vm.active) return;
      const mode = e.target.value;
      if (mode === "ptt") {
        state.vm.detector?.setState("paused", Date.now());
      } else if (!state.vm.paused && !state.vm.muted && state.vm.status !== "speaking") {
        state.vm.detector?.setState("listening", Date.now());
      }
      const msg = mode === "ptt"
        ? "Push-to-talk active: hold Space to speak."
        : mode === "wake"
          ? "Wake-phrase mode: start with “Hey Vani”."
          : "Listening… speak naturally whenever you're ready.";
      setVmStatus(vmIdleStatus(), msg);
    });
    $("#vmSaveHistoryBtn").addEventListener("click", saveVmToHistory);
    $("#vmDismissErrBtn").addEventListener("click", () => { $("#vmErrorBanner").hidden = true; });
    $("#vmTextForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const val = $("#vmTextInput").value.trim();
      if (!val) return;
      $("#vmTextInput").value = "";
      submitVmText(val);
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

      if (e.key === "Escape") {
        const pop = $("#vmSettingsPopover");
        if (pop && !pop.hidden) {
          closeVmSettingsPopover(true);
          return;
        }
      }

      if (typing) return;

      if (e.code === "Space" && state.view === "live") {
        e.preventDefault();
        if (state.recStatus === "idle") startRecording();
        else if (state.recStatus === "recording" || state.recStatus === "paused") stopRecording();
      } else if (e.code === "Space" && state.view === "voice-mode" && ($("#vmCaptureMode")?.value === "ptt") && state.vm.active && !state.vm.paused && !state.vm.muted && !state.vm.pttHeld) {
        e.preventDefault();
        state.vm.pttHeld = true;
        stopVmSpeech();
        state.vm.speechStartedAt = Date.now();
        state.vm.lastLoudAt = Date.now();
        state.vm.activeSpeechMs = 1000;
        setVmStatus("capturing", "Push-to-talk: hearing you…");
        startPttCapture();
      } else if (e.key === "/") {
        e.preventDefault();
        switchView("history");
        setTimeout(() => $("#historySearch").focus(), 50);
      } else if (e.key === "Escape") {
        closeDetailModal();
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space" && state.vm.pttHeld) {
        state.vm.pttHeld = false;
        if (state.vm.recorder && state.vm.recorder.state === "recording") {
          state.vm.recorder.stop();
        }
      }
    });
  }

  // ---------- Hands-Free Voice Mode (VAD -> STT -> LLM -> TTS -> Listening) ----------
  function vmLog(event, detail = {}) {
    console.debug("[VoiceMode]", event, detail);
  }

  function setVmStatus(status, statusText) {
    const prev = state.vm.status;
    state.vm.status = status;
    if (prev !== status) vmLog("state_transition", { from: prev, to: status });
    const badge = $("#vmStateBadge");
    const map = {
      off: ["Session ended", "badge-neutral"],
      listening: ["Listening", "badge-success"],
      capturing: ["Hearing you", "badge-primary"],
      thinking: ["Processing…", "badge-warning"],
      speaking: ["Speaking", "badge-primary"],
      paused: ["Paused", "badge-warning"],
      muted: ["Muted", "badge-neutral"],
      error: ["Error", "badge-danger"],
    };
    const [label, cls] = map[status] || map.off;
    badge.textContent = label;
    badge.className = `badge ${cls}`;
    if (statusText !== undefined) {
      $("#vmLiveStatusText").textContent = statusText;
    }

    $("#vmStartBtn").disabled = state.vm.active;
    $("#vmEndBtn").disabled = !state.vm.active;
    const intBtn = $("#vmInterruptBtn");
    if (intBtn) intBtn.disabled = !(state.vm.active && status === "speaking");
    const pauseBtn = $("#vmPauseBtn");
    if (pauseBtn) {
      pauseBtn.disabled = !state.vm.active;
      pauseBtn.textContent = state.vm.paused ? "Resume listening" : "Pause listening";
    }
    $("#vmMuteBtn").disabled = !state.vm.active;
    $("#vmMuteBtn").textContent = state.vm.muted ? "Unmute mic" : "Mute mic";
    $("#vmSaveHistoryBtn").disabled = state.vm.messages.length === 0;
    syncHeroOrbState(status);
  }

  function syncHeroOrbState(status) {
    const orb = $("#heroVoiceOrbBtn");
    if (!orb) return;
    let orbState = "idle";
    if (state.vm.active && (status === "listening" || status === "capturing")) {
      orbState = "listening";
    } else if (state.vm.active && status === "speaking") {
      orbState = "speaking";
    }
    orb.dataset.orbState = orbState;
    if (orbState !== "listening") {
      orb.style.setProperty("--orb-level", "0");
    }
  }

  function resetVmWaveform() {
    $$("#vmWaveform .wave-bar").forEach((b, i) => {
      b.style.height = `${IDLE_WAVE_HEIGHTS[i % IDLE_WAVE_HEIGHTS.length]}%`;
      b.classList.remove("active");
    });
  }

  function renderVmMessages() {
    const box = $("#vmMessages");
    if (!state.vm.messages.length) {
      box.innerHTML = `<div class="empty-state"><div class="empty-title">No conversation yet</div><p>Start a voice session or type a message below to begin.</p></div>`;
      return;
    }
    box.innerHTML = state.vm.messages.map((m) => `
      <div class="vm-bubble ${m.role}">
        <div>${esc(m.text)}</div>
        ${m.meta ? `<div class="vm-bubble-meta mono">${esc(m.meta)}</div>` : ""}
      </div>
    `).join("");
    box.scrollTop = box.scrollHeight;
    $("#vmSaveHistoryBtn").disabled = false;
  }

  function updateVmQuickMeta() {
    const meta = $("#vmQuickMeta");
    if (!meta) return;
    const langSel = $("#vmLanguage");
    const voiceSel = $("#vmVoiceSelect");
    const langVal = langSel ? langSel.value : "en";
    const langLabel = LANG_LABELS[langVal] || langVal;
    let voiceLabel = "Default voice";
    if (voiceSel && voiceSel.selectedOptions && voiceSel.selectedOptions[0]) {
      voiceLabel = voiceSel.selectedOptions[0].textContent.replace(/\s*\([^)]*\)\s*$/, "").trim() || "Default voice";
      if (voiceLabel.length > 22) voiceLabel = `${voiceLabel.slice(0, 20)}…`;
    }
    meta.textContent = `${langLabel} · ${voiceLabel}`;
  }

  function closeVmSettingsPopover(restoreFocus = false) {
    const pop = $("#vmSettingsPopover");
    const btn = $("#vmSettingsBtn");
    if (pop) pop.hidden = true;
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      if (restoreFocus) btn.focus();
    }
  }

  function toggleVmSettingsPopover() {
    const pop = $("#vmSettingsPopover");
    const btn = $("#vmSettingsBtn");
    if (!pop) return;
    const willOpen = pop.hidden;
    pop.hidden = !willOpen;
    if (btn) btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function stopVmSpeech() {
    if (state.vm.activeUtterance || state.vm.ttsQueue?.length) {
      vmLog("tts_cancel", { remainingChunks: state.vm.ttsQueue?.length || 0 });
    }
    state.vm.ttsQueue = [];
    clearInterval(state.vm.ttsWatchdog);
    state.vm.ttsWatchdog = null;
    state.vm.activeUtterance = null;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  function populateVmVoices() {
    const sel = $("#vmVoiceSelect");
    if (!sel || !("speechSynthesis" in window)) return;
    const prev = sel.value;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) {
      sel.innerHTML = `<option value="">No browser voices available (system default)</option>`;
      return;
    }
    sel.innerHTML = `<option value="">Default voice</option>` +
      voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join("");

    if (prev && voices.some((v) => v.voiceURI === prev)) {
      sel.value = prev;
      return;
    }

    const femaleRegex = /\b(samantha|lekha|veena|karen|victoria|moira|tessa|fiona|zira|aria|jenny|natasha|neerja|swara|female|woman)\b/i;
    const preferred =
      voices.find((v) => femaleRegex.test(v.name) && /^en|^hi/i.test(v.lang)) ||
      voices.find((v) => femaleRegex.test(v.name));
    if (preferred) {
      sel.value = preferred.voiceURI;
    }
    updateVmQuickMeta();
  }

  function speakVmReply(text, langHint) {
    if (!text) {
      if (state.vm.active) setVmStatus(vmIdleStatus(), "Listening for your next question…");
      return;
    }
    if (!("speechSynthesis" in window)) {
      if (state.vm.active) setVmStatus(vmIdleStatus(), "Browser speech synthesis unavailable; listening…");
      return;
    }
    stopVmSpeech();
    state.vm.speakingStartedAt = Date.now();
    state.vm.detector?.setState("speaking", state.vm.speakingStartedAt);
    vmLog("tts_start", { chars: text.length });
    setVmStatus("speaking", "Speaking reply…");

    const sentences = (text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [text])
      .map((s) => s.trim())
      .filter(Boolean);
    state.vm.ttsQueue = sentences;

    const chosenUri = $("#vmVoiceSelect")?.value || "";
    const voices = window.speechSynthesis.getVoices() || [];
    const chosenVoice = chosenUri ? voices.find((v) => v.voiceURI === chosenUri) : null;
    const activeLang = $("#vmLanguage")?.value || "en";
    const langTagMap = { en: "en-IN", hi: "hi-IN", te: "te-IN", mixed: "en-IN" };
    const rate = Number($("#vmRateSelect")?.value || 1.0);

    const finishAll = () => {
      state.vm.ttsQueue = [];
      clearInterval(state.vm.ttsWatchdog);
      state.vm.ttsWatchdog = null;
      state.vm.activeUtterance = null;
      vmLog("tts_end");
      if (state.vm.active && state.vm.status === "speaking") {
        const nextIdle = vmIdleStatus();
        const captureMode = $("#vmCaptureMode")?.value || "hands-free";
        state.vm.detector?.setState(captureMode === "ptt" ? "paused" : nextIdle, Date.now());
        setVmStatus(nextIdle, state.vm.muted ? "Mic muted." : (state.vm.paused ? "Paused." : "Listening…"));
      }
    };

    const speakNext = () => {
      if (!state.vm.active || state.vm.status !== "speaking" || !state.vm.ttsQueue.length) {
        finishAll();
        return;
      }
      const chunk = state.vm.ttsQueue.shift();
      const u = new SpeechSynthesisUtterance(chunk);
      if (chosenVoice && (activeLang === "en" || activeLang === "auto" || activeLang === "mixed" || chosenVoice.lang.toLowerCase().startsWith(activeLang))) {
        u.voice = chosenVoice;
        u.lang = chosenVoice.lang;
      } else {
        const hasDevanagari = /[\u0900-\u097F]/.test(chunk);
        const hasTelugu = /[\u0C00-\u0C7F]/.test(chunk);
        if (hasTelugu || activeLang === "te") u.lang = "te-IN";
        else if (hasDevanagari || activeLang === "hi") u.lang = "hi-IN";
        else u.lang = langTagMap[activeLang] || "en-IN";
      }
      u.rate = rate;
      u.onend = () => {
        if (state.vm.ttsQueue.length && state.vm.active && state.vm.status === "speaking") {
          speakNext();
        } else {
          finishAll();
        }
      };
      u.onerror = () => finishAll();
      state.vm.activeUtterance = u;
      window.speechSynthesis.speak(u);
    };

    speakNext();

    // Guard against Chrome dropping SpeechSynthesisUtterance.onend without cutting off startup
    let startedSpeaking = false;
    let idleTicks = 0;
    state.vm.ttsWatchdog = setInterval(() => {
      if (!state.vm.active || state.vm.status !== "speaking") {
        clearInterval(state.vm.ttsWatchdog);
        state.vm.ttsWatchdog = null;
        return;
      }
      if (window.speechSynthesis.speaking) {
        startedSpeaking = true;
        idleTicks = 0;
      } else if (!window.speechSynthesis.pending && !state.vm.ttsQueue.length) {
        const elapsed = Date.now() - state.vm.speakingStartedAt;
        if (startedSpeaking || elapsed > 3000) {
          idleTicks += 1;
          if (idleTicks >= 2) finishAll();
        }
      }
    }, 450);
  }

  function closeVmSocket(ws) {
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch { /* ignore */ }
  }

  function openUtteranceSocket(utteranceId, initialPcm) {
    const lang = $("#vmLanguage")?.value || "en";
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const mime = `audio/pcm;rate=${window.VoiceVad.TARGET_SAMPLE_RATE}`;
    const wsUrl = `${proto}//${location.host}/ws/transcribe?language=${encodeURIComponent(lang)}&mime=${encodeURIComponent(mime)}`;

    state.vm.activeUtteranceId = utteranceId;
    state.vm.chunks = [];
    state.vm.finalHandled = false;
    state.vm.utteranceAborted = false;
    if (initialPcm && initialPcm.length) {
      state.vm.chunks.push(initialPcm.buffer.slice(initialPcm.byteOffset, initialPcm.byteOffset + initialPcm.byteLength));
    }

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    state.vm.ws = ws;
    ws._utteranceId = utteranceId;
    ws._stopPendingOnOpen = false;

    ws.onopen = () => {
      if (state.vm.utteranceAborted || state.vm.activeUtteranceId !== utteranceId) {
        closeVmSocket(ws);
        return;
      }
      for (const buf of state.vm.chunks) {
        ws.send(buf);
      }
      state.vm.chunks = [];
      if (ws._stopPendingOnOpen) {
        ws._stopPendingOnOpen = false;
        ws.send(JSON.stringify({ type: "stop" }));
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (state.vm.activeUtteranceId !== utteranceId || state.vm.utteranceAborted) return;

      if (msg.type === "interim") {
        if (state.vm.status === "capturing" && !state.vm.utteranceAborted) {
          $("#vmLiveStatusText").textContent = msg.text ? `Hearing (draft): "${msg.text}"` : "Hearing you…";
        }
      } else if (msg.type === "final") {
        if (state.vm.finalHandled || state.vm.utteranceAborted) return;
        state.vm.finalHandled = true;
        closeVmSocket(ws);
        if (state.vm.ws === ws) state.vm.ws = null;
        if (!state.vm.active) return;

        const transcript = (msg.text || "").trim();
        const minSpeechMs = state.vm.detector ? state.vm.detector.getConfig().minSpeechMs : 420;
        if (msg.low_confidence || window.VoiceVad.isNoiseFragment(transcript, state.vm.activeSpeechMs, minSpeechMs)) {
          const captureMode = $("#vmCaptureMode")?.value || "hands-free";
          state.vm.detector?.setState(captureMode === "ptt" ? "paused" : vmIdleStatus(), Date.now());
          setVmStatus(vmIdleStatus(), "Didn’t catch that—please repeat.");
          return;
        }
        if (state.vm.submittedUtteranceIds.has(utteranceId)) {
          return;
        }
        state.vm.submittedUtteranceIds.add(utteranceId);
        submitVmTranscript(transcript, msg.language, msg.stt_ms);
      } else if (msg.type === "limit_reached") {
        state.vm.detector?.forceEndUtterance(Date.now());
      } else if (msg.type === "error") {
        if (state.vm.finalHandled || state.vm.utteranceAborted) return;
        state.vm.finalHandled = true;
        closeVmSocket(ws);
        if (state.vm.ws === ws) state.vm.ws = null;
        const captureMode = $("#vmCaptureMode")?.value || "hands-free";
        state.vm.detector?.setState(captureMode === "ptt" ? "paused" : vmIdleStatus(), Date.now());
        $("#vmErrorTitle").textContent = "Transcription Service Error";
        $("#vmErrorMsg").textContent = msg.message || "Speech-to-text failed.";
        $("#vmErrorBanner").hidden = false;
        setVmStatus(state.vm.active ? vmIdleStatus() : "error", "Transcription failed — listening…");
      }
    };

    ws.onerror = () => {
      if (!state.vm.finalHandled && !state.vm.utteranceAborted && state.vm.active && state.vm.activeUtteranceId === utteranceId) {
        const captureMode = $("#vmCaptureMode")?.value || "hands-free";
        state.vm.detector?.setState(captureMode === "ptt" ? "paused" : vmIdleStatus(), Date.now());
        $("#vmErrorTitle").textContent = "WebSocket Error";
        $("#vmErrorMsg").textContent = "Lost connection to transcription stream.";
        $("#vmErrorBanner").hidden = false;
        setVmStatus("error", "WebSocket connection failed.");
      }
    };
  }

  function startPttCapture() {
    if (!state.vm.stream || state.vm.recorder) return;
    const mime = pickMime() || "audio/webm";
    const lang = $("#vmLanguage").value;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws/transcribe?language=${encodeURIComponent(lang)}&mime=${encodeURIComponent(mime)}`;

    state.vm.chunks = [];
    state.vm.finalHandled = false;
    state.vm.utteranceAborted = false;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    state.vm.ws = ws;

    let stopPendingOnOpen = false;
    let pendingReads = 0;
    let stopRequested = false;

    const sendStop = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
      } else if (ws.readyState === WebSocket.CONNECTING) {
        stopPendingOnOpen = true;
      } else if (!state.vm.finalHandled) {
        setVmStatus(vmIdleStatus(), "Listening…");
      }
    };

    ws.onopen = () => {
      for (const buf of state.vm.chunks) ws.send(buf);
      state.vm.chunks = [];
      if (stopPendingOnOpen) {
        stopPendingOnOpen = false;
        ws.send(JSON.stringify({ type: "stop" }));
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "interim") {
        if (state.vm.status === "capturing" && !state.vm.utteranceAborted) {
          $("#vmLiveStatusText").textContent = msg.text ? `Hearing (draft): "${msg.text}"` : "Hearing you…";
        }
      } else if (msg.type === "final") {
        if (state.vm.finalHandled || state.vm.utteranceAborted) return;
        state.vm.finalHandled = true;
        closeVmSocket(ws);
        if (!state.vm.active) return;
        const transcript = (msg.text || "").trim();
        if (msg.low_confidence || window.VoiceVad.isNoiseFragment(transcript)) {
          setVmStatus(vmIdleStatus(), "I didn’t catch that—please repeat.");
          return;
        }
        submitVmTranscript(transcript, msg.language, msg.stt_ms);
      } else if (msg.type === "error") {
        if (state.vm.finalHandled || state.vm.utteranceAborted) return;
        state.vm.finalHandled = true;
        closeVmSocket(ws);
        showVmError("Transcription Service Error", msg.message || "Speech-to-text failed.");
        setVmStatus(state.vm.active ? vmIdleStatus() : "error", "Transcription failed — listening…");
      }
    };

    const rec = new MediaRecorder(state.vm.stream, MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : undefined);
    rec.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0 || state.vm.utteranceAborted) return;
      pendingReads += 1;
      try {
        const ab = await e.data.arrayBuffer();
        if (!state.vm.utteranceAborted) {
          if (ws.readyState === WebSocket.OPEN) ws.send(ab);
          else if (ws.readyState === WebSocket.CONNECTING) state.vm.chunks.push(ab);
        }
      } finally {
        pendingReads -= 1;
        if (stopRequested && pendingReads === 0 && !state.vm.utteranceAborted && state.vm.active) sendStop();
      }
    };
    rec.onstop = () => {
      state.vm.recorder = null;
      if (state.vm.utteranceAborted || !state.vm.active) {
        state.vm.chunks = [];
        closeVmSocket(ws);
        return;
      }
      stopRequested = true;
      setVmStatus("thinking", "Finalizing transcript…");
      if (pendingReads === 0) sendStop();
    };
    state.vm.recorder = rec;
    rec.start(1000);
  }

  const STOP_PHRASE_RE = /^(stop|stop talking|be quiet|quiet|please stop|stop speaking)[.!?\s]*$/i;

  function detectLanguageSwitchCommand(text) {
    return window.VoiceVad.detectLanguageSwitchCommand(text);
  }

  async function submitVmTranscript(transcript, _langHint, sttMs = 0) {
    if (state.vm.inFlightChat) return;
    vmLog("transcription_result", { chars: transcript.length, stt_ms: sttMs });
    if (STOP_PHRASE_RE.test(transcript)) {
      stopVmSpeech();
      const captureMode = $("#vmCaptureMode")?.value || "hands-free";
      state.vm.detector?.setState(captureMode === "ptt" ? "paused" : vmIdleStatus(), Date.now());
      setVmStatus(vmIdleStatus(), "Playback stopped. Listening…");
      return;
    }

    const mode = $("#vmCaptureMode")?.value || "hands-free";
    let cleanText = transcript.trim();

    if (mode === "wake") {
      const wakeMatch = cleanText.match(/^(?:hey|hi|hello|ok)?\s*vani(?:script)?[\s,.:!?-]*(.*)$/i);
      if (!wakeMatch) {
        state.vm.detector?.setState(vmIdleStatus(), Date.now());
        setVmStatus(vmIdleStatus(), "Ignored background speech (say “Hey Vani” to address the assistant).");
        return;
      }
      cleanText = (wakeMatch[1] || "").trim();
      if (!cleanText) {
        state.vm.detector?.setState(vmIdleStatus(), Date.now());
        setVmStatus(vmIdleStatus(), "Yes? Listening for your question…");
        return;
      }
    }

    const requestedLang = detectLanguageSwitchCommand(cleanText);
    if (requestedLang) {
      const sel = $("#vmLanguage");
      if (sel) sel.value = requestedLang;
      updateVmQuickMeta();
      const label = LANG_LABELS[requestedLang] || requestedLang;
      const confirmMsg = `Switched language to ${label}.`;
      state.vm.messages.push({ role: "user", text: cleanText, meta: sttMs ? `STT ${sttMs} ms` : "" });
      state.vm.messages.push({ role: "assistant", text: confirmMsg, meta: `Language locked: ${label}` });
      renderVmMessages();
      speakVmReply(confirmMsg, requestedLang);
      return;
    }

    const lockedLang = $("#vmLanguage")?.value || "en";
    state.vm.inFlightChat = true;
    state.vm.detector?.setState("thinking", Date.now());
    setVmStatus("thinking", "Generating reply…");
    state.vm.messages.push({ role: "user", text: cleanText, meta: sttMs ? `STT ${sttMs} ms` : "" });
    renderVmMessages();
    try {
      const data = await apiFetch("/api/voice-mode/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanText, session_id: state.vm.sessionId, language: lockedLang }),
      });
      state.vm.messages.push({ role: "assistant", text: data.reply, meta: `LLM ${data.llm_ms} ms` });
      renderVmMessages();
      speakVmReply(data.reply, lockedLang);
    } catch (err) {
      vmLog("error", { stage: "chat", message: err.message });
      $("#vmErrorTitle").textContent = "Assistant Error";
      $("#vmErrorMsg").textContent = err.message;
      $("#vmErrorBanner").hidden = false;
      const captureMode = $("#vmCaptureMode")?.value || "hands-free";
      state.vm.detector?.setState(captureMode === "ptt" ? "paused" : vmIdleStatus(), Date.now());
      setVmStatus(state.vm.active ? vmIdleStatus() : "off", `Error: ${err.message} — listening…`);
    } finally {
      state.vm.inFlightChat = false;
    }
  }

  function vmIdleStatus() {
    if (state.vm.muted) return "muted";
    if (state.vm.paused) return "paused";
    return "listening";
  }

  async function submitVmText(text) {
    await submitVmTranscript(text, $("#vmLanguage")?.value || "en", 0);
  }

  async function setupVmAudioPipeline() {
    const audioCtx = state.vm.audioCtx;
    const source = audioCtx.createMediaStreamSource(state.vm.stream);
    state.vm.sourceNode = source;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    state.vm.analyser = analyser;
    source.connect(analyser);

    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    state.vm.silentGain = silentGain;

    const freqBuf = new Uint8Array(analyser.frequencyBinCount);
    const timeBuf = new Uint8Array(analyser.fftSize);
    const bars = $$("#vmWaveform .wave-bar");
    const sampleRate = audioCtx.sampleRate || 48000;
    const binHz = sampleRate / analyser.fftSize;
    const lowBin = Math.max(1, Math.floor(300 / binHz));
    const highBin = Math.min(freqBuf.length - 1, Math.ceil(3400 / binHz));

    const handleFrame = (float32Samples) => {
      if (!state.vm.active || !state.vm.detector) return;
      analyser.getByteFrequencyData(freqBuf);
      let speechBandSum = 0;
      for (let i = lowBin; i <= highBin; i++) speechBandSum += freqBuf[i];
      const speechBandAvg = speechBandSum / Math.max(1, highBin - lowBin + 1);
      state.vm.detector.pushAudioFrame(float32Samples, sampleRate, Date.now(), { speechBandAvg });
    };

    let workletReady = false;
    if (audioCtx.audioWorklet && typeof AudioWorkletNode === "function") {
      try {
        const processorCode = `
          class VmPcmProcessor extends AudioWorkletProcessor {
            constructor() {
              super();
              this._buf = new Float32Array(1920);
              this._offset = 0;
            }
            process(inputs) {
              const input = inputs[0];
              if (input && input[0] && input[0].length) {
                const ch = input[0];
                let idx = 0;
                while (idx < ch.length) {
                  const take = Math.min(ch.length - idx, this._buf.length - this._offset);
                  this._buf.set(ch.subarray(idx, idx + take), this._offset);
                  this._offset += take;
                  idx += take;
                  if (this._offset >= this._buf.length) {
                    const out = this._buf;
                    this._buf = new Float32Array(1920);
                    this._offset = 0;
                    this.port.postMessage(out, [out.buffer]);
                  }
                }
              }
              return true;
            }
          }
          registerProcessor("vm-pcm-processor", VmPcmProcessor);
        `;
        const blobUrl = URL.createObjectURL(new Blob([processorCode], { type: "application/javascript" }));
        try {
          await audioCtx.audioWorklet.addModule(blobUrl);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        const workletNode = new AudioWorkletNode(audioCtx, "vm-pcm-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        workletNode.port.onmessage = (ev) => {
          if (ev.data) handleFrame(ev.data);
        };
        source.connect(workletNode);
        workletNode.connect(silentGain);
        silentGain.connect(audioCtx.destination);
        state.vm.processorNode = workletNode;
        workletReady = true;
      } catch (err) {
        vmLog("audio_worklet_fallback", { reason: err.message });
      }
    }

    if (!workletReady && typeof audioCtx.createScriptProcessor === "function") {
      const scriptNode = audioCtx.createScriptProcessor(1024, 1, 1);
      scriptNode.onaudioprocess = (ev) => {
        const ch = ev.inputBuffer.getChannelData(0);
        if (ch && ch.length) handleFrame(new Float32Array(ch));
      };
      source.connect(scriptNode);
      scriptNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);
      state.vm.processorNode = scriptNode;
    }

    const renderWaveform = () => {
      if (!state.vm.active) return;
      if (!state.vm.muted && !state.vm.paused && (state.vm.status === "listening" || state.vm.status === "capturing" || state.vm.status === "speaking")) {
        analyser.getByteTimeDomainData(timeBuf);
        let sum = 0;
        for (const v of timeBuf) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / timeBuf.length);
        const level = Math.min(100, Math.round(rms * 320));
        const activeWave = state.vm.status === "capturing" || rms > (state.vm.detector?.getNoiseFloor() || 0.006) * 2.5;
        bars.forEach((bar, i) => {
          const sample = Math.abs((timeBuf[(i * 4) % timeBuf.length] - 128) / 128);
          bar.style.height = `${Math.max(14, Math.min(100, Math.round(sample * 240 + level * 0.3)))}%`;
          bar.classList.toggle("active", activeWave);
        });
      } else {
        resetVmWaveform();
      }
      state.vm.rafId = requestAnimationFrame(renderWaveform);
    };
    renderWaveform();
  }

  function showVmError(title, message) {
    const banner = $("#vmErrorBanner");
    const titleEl = $("#vmErrorTitle");
    const msgEl = $("#vmErrorMsg");
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (banner) banner.hidden = false;
  }

  async function startVoiceSession() {
    if (state.vm.active || state.vm.starting) return;
    state.vm.starting = true;
    try {
      const banner = $("#vmErrorBanner");
      if (banner) banner.hidden = true;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showVmError("Microphone Unsupported", "Your browser does not support microphone capture.");
        return;
      }

      let micResult;
      try {
        micResult = await window.VoiceVad.negotiateMicConstraints(navigator.mediaDevices, state.settings.micDeviceId);
        state.vm.stream = micResult.stream;
      } catch (err) {
        const micBadge = $("#vmMicBadge");
        const name = err && err.name ? err.name : "";
        const isDenied = name === "NotAllowedError" || name === "PermissionDeniedError";
        const isMissing = name === "NotFoundError" || name === "DevicesNotFoundError";
        if (micBadge) {
          micBadge.textContent = isDenied ? "Mic: Denied" : "Mic: Unavailable";
          micBadge.className = "badge badge-danger";
        }
        if (isDenied) {
          showVmError("Microphone Permission Denied", "Microphone access was rejected by the browser. Allow mic access and try again.");
        } else if (isMissing) {
          showVmError("Microphone Not Found", "No microphone device was detected. Connect a microphone and try again.");
        } else {
          showVmError("Microphone Access Error", `Could not access microphone (${name || "Error"}: ${err.message || err}).`);
        }
        return;
      }

      try {
        const micBadge = $("#vmMicBadge");
        if (micBadge) {
          micBadge.textContent = "Mic: Connected";
          micBadge.className = "badge badge-success";
        }
        const ts = micResult.settings || {};
        const sup = micResult.supported || {};
        const fmtFlag = (v, isSupported) => {
          if (isSupported === false) return "unsupported";
          return v === true ? "on" : v === false ? "off" : "auto";
        };
        const audioMeta = $("#vmAudioMeta");
        if (audioMeta) {
          audioMeta.textContent = `EC:${fmtFlag(ts.echoCancellation, sup.echoCancellation)} · NS:${fmtFlag(ts.noiseSuppression, sup.noiseSuppression)} · AGC:${fmtFlag(ts.autoGainControl, sup.autoGainControl)}`;
        }

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        state.vm.audioCtx = state.vm.audioCtx || new AudioCtx();
        if (state.vm.audioCtx.state === "suspended") {
          await state.vm.audioCtx.resume();
        }

        const captureMode = $("#vmCaptureMode")?.value || "hands-free";
        const sensitivity = $("#vmSensitivity")?.value || "balanced";
        const silenceMs = Number($("#vmSilenceMs")?.value || 1500);
        state.vm.submittedUtteranceIds = new Set();

        state.vm.detector = window.VoiceVad.createTurnDetector({
          sensitivity,
          config: { silenceMs },
          initialState: captureMode === "ptt" ? "paused" : "listening",
          onBargeIn: () => {
            vmLog("barge_in");
            stopVmSpeech();
          },
          onLevel: ({ rms, state: detState }) => {
            const orb = $("#heroVoiceOrbBtn");
            if (orb && state.vm.active && (detState === "listening" || detState === "capturing")) {
              const norm = Math.min(1, Math.max(0, rms * 6));
              orb.style.setProperty("--orb-level", norm.toFixed(3));
            }
          },
          onUtteranceStart: ({ utteranceId, initialPcm, bargeIn }) => {
            vmLog("speech_start", { utteranceId, bargeIn });
            state.vm.activeSpeechMs = 0;
            setVmStatus("capturing", "Hearing you…");
            openUtteranceSocket(utteranceId, initialPcm);
          },
          onUtteranceChunk: ({ utteranceId, pcm }) => {
            if (state.vm.utteranceAborted || state.vm.activeUtteranceId !== utteranceId) return;
            const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
            const ws = state.vm.ws;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(ab);
            } else if (ws && ws.readyState === WebSocket.CONNECTING) {
              state.vm.chunks.push(ab);
            }
          },
          onUtteranceRejected: ({ utteranceId, reason, activeSpeechMs }) => {
            vmLog("utterance_rejected", { utteranceId, reason, activeSpeechMs });
            if (state.vm.activeUtteranceId === utteranceId) {
              state.vm.utteranceAborted = true;
              const ws = state.vm.ws;
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "discard" }));
              }
              closeVmSocket(ws);
              state.vm.ws = null;
            }
            setVmStatus(vmIdleStatus(), "Ignored brief noise — listening…");
          },
          onUtteranceEnd: ({ utteranceId, activeSpeechMs }) => {
            vmLog("speech_end", { utteranceId, activeSpeechMs });
            if (state.vm.activeUtteranceId !== utteranceId || state.vm.utteranceAborted) return;
            state.vm.activeSpeechMs = activeSpeechMs;
            setVmStatus("thinking", "Finalizing transcript…");
            const ws = state.vm.ws;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "stop" }));
            } else if (ws && ws.readyState === WebSocket.CONNECTING) {
              ws._stopPendingOnOpen = true;
            } else {
              state.vm.detector?.setState(vmIdleStatus(), Date.now());
              setVmStatus(vmIdleStatus(), "Listening…");
            }
          },
        });

        state.vm.active = true;
        state.vm.muted = false;
        state.vm.paused = false;
        await setupVmAudioPipeline();
        const readyMsg = captureMode === "ptt"
          ? "Push-to-talk active: hold Space to speak."
          : captureMode === "wake"
            ? "Wake-phrase mode: start with “Hey Vani”."
            : "Listening… speak naturally whenever you're ready.";
        setVmStatus("listening", readyMsg);
      } catch (err) {
        if (state.vm.stream) {
          state.vm.stream.getTracks().forEach((t) => t.stop());
          state.vm.stream = null;
        }
        showVmError("Voice Session Startup Error", `Audio setup failed: ${err.message || err}`);
        setVmStatus("error", "Voice session failed to start.");
      }
    } finally {
      state.vm.starting = false;
    }
  }

  function endVoiceSession() {
    state.vm.active = false;
    state.vm.utteranceAborted = true;
    state.vm.detector?.setState("off", Date.now());
    state.vm.detector = null;
    stopVmSpeech();
    cancelAnimationFrame(state.vm.rafId);
    if (state.vm.processorNode) {
      try { state.vm.processorNode.disconnect(); } catch { /* ignore */ }
      if ("onaudioprocess" in state.vm.processorNode) state.vm.processorNode.onaudioprocess = null;
      state.vm.processorNode = null;
    }
    if (state.vm.sourceNode) {
      try { state.vm.sourceNode.disconnect(); } catch { /* ignore */ }
      state.vm.sourceNode = null;
    }
    if (state.vm.silentGain) {
      try { state.vm.silentGain.disconnect(); } catch { /* ignore */ }
      state.vm.silentGain = null;
    }
    closeVmSocket(state.vm.ws);
    state.vm.ws = null;
    if (state.vm.recorder && state.vm.recorder.state === "recording") {
      state.vm.recorder.stop();
    }
    state.vm.recorder = null;
    if (state.vm.stream) {
      state.vm.stream.getTracks().forEach((t) => t.stop());
      state.vm.stream = null;
    }
    resetVmWaveform();
    const audioMeta = $("#vmAudioMeta");
    if (audioMeta) audioMeta.textContent = "";
    const micBadge = $("#vmMicBadge");
    if (micBadge) {
      micBadge.textContent = "Mic: Idle";
      micBadge.className = "badge badge-neutral";
    }
    setVmStatus("off", "Voice session ended.");
  }

  function toggleVmPause() {
    if (!state.vm.active) return;
    state.vm.paused = !state.vm.paused;
    if (state.vm.paused) {
      stopVmSpeech();
      state.vm.utteranceAborted = true;
      closeVmSocket(state.vm.ws);
      state.vm.ws = null;
      if (state.vm.recorder && state.vm.recorder.state === "recording") {
        state.vm.recorder.stop();
      }
      state.vm.detector?.setState("paused", Date.now());
      setVmStatus("paused", "Listening paused. Click Resume listening to continue.");
    } else {
      const next = vmIdleStatus();
      const captureMode = $("#vmCaptureMode")?.value || "hands-free";
      state.vm.detector?.setState(captureMode === "ptt" ? "paused" : next, Date.now());
      setVmStatus(next, state.vm.muted ? "Mic muted." : "Listening…");
    }
  }

  function interruptVmSpeech() {
    if (!state.vm.active || state.vm.status !== "speaking") return;
    stopVmSpeech();
    const next = vmIdleStatus();
    const captureMode = $("#vmCaptureMode")?.value || "hands-free";
    state.vm.detector?.setState(captureMode === "ptt" ? "paused" : next, Date.now());
    setVmStatus(next, "Playback interrupted. Listening…");
  }

  function toggleVmMute() {
    if (!state.vm.active) return;
    state.vm.muted = !state.vm.muted;
    if (state.vm.muted) {
      state.vm.utteranceAborted = true;
      closeVmSocket(state.vm.ws);
      state.vm.ws = null;
      if (state.vm.recorder && state.vm.recorder.state === "recording") {
        state.vm.recorder.stop();
      }
      state.vm.detector?.setState("muted", Date.now());
    } else {
      const captureMode = $("#vmCaptureMode")?.value || "hands-free";
      state.vm.detector?.setState(captureMode === "ptt" ? "paused" : vmIdleStatus(), Date.now());
    }
    setVmStatus(vmIdleStatus(), state.vm.muted ? "Mic muted." : (state.vm.paused ? "Paused." : "Listening…"));
  }

  async function saveVmToHistory() {
    if (!state.vm.messages.length) return;
    const transcript = state.vm.messages.map((m) => `${m.role === "user" ? "You" : "Mumaith Chat"}: ${m.text}`).join("\n\n");
    const title = `Voice Session · ${new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    try {
      await apiFetch("/api/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, transcript, language: $("#vmLanguage").value, duration_ms: 0 }),
      });
      toast("Conversation saved to History.", "success");
      loadDashboard();
    } catch (err) {
      toast(`Failed to save conversation: ${err.message}`, "error");
    }
  }

  // ---------- Boot ----------
  initWaveforms();
  populateVmVoices();
  updateVmQuickMeta();
  if ("speechSynthesis" in window && typeof window.speechSynthesis.addEventListener === "function") {
    window.speechSynthesis.addEventListener("voiceschanged", populateVmVoices);
  }
  syncSettingsUI();
  initEvents();
  checkHealth();
  checkMicPermission();
  updateRecorderUI();
  const initialHash = location.hash.replace(/^#\/?/, "");
  if (VALID_VIEWS.has(initialHash) && initialHash !== "dashboard") {
    switchView(initialHash);
  } else {
    switchView("dashboard");
  }
})();
