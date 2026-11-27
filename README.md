# Mumaith Chat — Multilingual Real-Time Speech-to-Text

Mumaith Chat is a web application for real-time multilingual speech-to-text supporting **English**, **Hindi**, and **Hindi + English (Hinglish)** mixed speech, backed by Groq Whisper (`whisper-large-v3-turbo`), FastAPI WebSockets, and SQLite transcription history management.

*(Note: The repository also retains the legacy `/api/voice`, `/api/chat`, and `/api/reset` endpoints and `appointments` table from the initial voice-agent prototype.)*

---

## Implemented Features

- **Dashboard:** Displays SQLite-backed metrics (total transcriptions, created today, total audio duration, top language), a 14-day activity SVG bar chart, and recent transcriptions.
- **Live Transcription:**
  - Language selector: Automatic Detection, Hindi + English (Hinglish), Hindi, and English.
  - Browser `MediaRecorder` streaming over `WS /ws/transcribe` with Start, Pause/Resume, and Stop controls, live `MM:SS` timer, and Web Audio input level meter.
  - Separate **Finalized Transcript** editor and **Live Interim Stream** area.
  - Enforced 10 MB per-recording limit (`MAX_AUDIO_BYTES`) that finalizes safely without discarding the initial WebM header and notifies the client.
  - Error recovery for microphone permission denial, missing hardware, WebSocket interruption, and missing API key without discarding transcript text.
- **Transcription History (CRUD):**
  - Create manual notes or save live recordings to SQLite.
  - Full-text search (`q`), language filter, date range filter, sorting (`newest` / `oldest`), and pagination.
  - View Details modal, Edit title/transcript/language, Delete with confirmation, Copy to clipboard, Download `.txt`, and Print-to-PDF (`@media print`).
- **Settings:** Persists UI preferences (default language, theme, audio input device, auto-save prompt) in browser `localStorage` and documents keyboard shortcuts (`Space`, `Ctrl/Cmd+S`, `/`).

---

## Technology Stack

| Layer | Technologies |
|---|---|
| **Backend** | Python 3.10+ (Docker uses 3.12-slim), FastAPI `0.115.6`, Uvicorn `0.32.1`, Pydantic |
| **Speech-to-Text** | Groq Cloud API (`groq==1.7.0`), `whisper-large-v3-turbo` |
| **Database** | SQLite (`sqlite3`) stored at `DB_PATH` (default `data/agent.db`) |
| **Frontend** | Vanilla HTML5, CSS3, ES6+ JavaScript (`MediaRecorder`, `AudioContext`, `WebSocket`) |
| **Testing** | `pytest==8.3.4`, `pytest-asyncio==0.25.0`, FastAPI `TestClient` |
| **Containerization** | Docker, Docker Compose |

---

## Prerequisites & Local Setup

1. Create a free Groq account and generate an API key at [Groq Console](https://console.groq.com/keys).
2. Create and activate a Python virtual environment, then install dependencies:

   ```zsh
   python3 -m venv .venv
   source .venv/bin/activate
   python -m pip install -r requirements.txt
   ```

   *(On Windows PowerShell, use `py -m venv .venv` and `.\.venv\Scripts\Activate.ps1`.)*

3. Create `.env` from `.env.example` and set your `GROQ_API_KEY`:

   ```zsh
   cp .env.example .env
   ```

   Edit `.env` and replace `replace_with_your_groq_api_key` with your actual key. Never commit `.env` to Git (it is listed in `.gitignore`).

---

## Running Locally

Start the FastAPI server:

```zsh
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000> in Chrome or Edge (microphone access requires `localhost` or HTTPS).

---

## Running Tests

Run the automated test suite (uses temporary SQLite databases and mocked STT/LLM clients; no `GROQ_API_KEY` required):

```zsh
.venv/bin/python -m pytest -v
```

---

## API Reference

### REST Endpoints
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Serves Mumaith Chat frontend |
| `GET` | `/api/health` | Server status, STT model, and `stt_configured` flag |
| `GET` | `/api/transcriptions/stats` | Dashboard KPIs, language counts, 14-day activity, and recent items |
| `POST` | `/api/transcriptions` | Create and save a transcription |
| `GET` | `/api/transcriptions` | List/search/filter/paginate transcriptions (`q`, `language`, `date_from`, `date_to`, `sort`, `limit`, `offset`) |
| `GET` | `/api/transcriptions/{id}` | Retrieve a single transcription |
| `PATCH` | `/api/transcriptions/{id}` | Update `title`, `transcript`, or `language` |
| `DELETE` | `/api/transcriptions/{id}` | Delete a transcription |

### WebSocket Streaming (`WS /ws/transcribe`)
- **Connect:** `ws://127.0.0.1:8000/ws/transcribe?language=mixed&mime=audio/webm` (`language`: `auto` | `mixed` | `hi` | `en`)
- **Client → Server:**
  - Binary frames: `MediaRecorder` audio chunks (e.g. `1200ms` timeslice)
  - JSON text frames: `{"type": "stop"}`, `{"type": "flush"}`, `{"type": "ping"}`, `{"type": "language", "language": "..."}`
- **Server → Client (JSON):**
  - `{"type": "interim", "text": "...", "language": "...", "stt_ms": 180}`
  - `{"type": "final", "text": "...", "language": "...", "stt_ms": 210}`
  - `{"type": "limit_reached", "max_bytes": 10485760, "message": "..."}`
  - `{"type": "error", "message": "..."}`

---

## SQLite Persistence & Deployment

- **Database file:** Configured via `DB_PATH` in `.env` (default `data/agent.db`). Contains `transcriptions` and `appointments` tables.
- **Docker Compose:** [docker-compose.yml](docker-compose.yml) mounts `./data:/app/data` so SQLite data persists across container restarts locally (`docker compose up --build`).
- **Cloud Hosting:** On stateless hosts (Render, Railway, Fly.io), attach a persistent volume at `/app/data` or migrate `app/db.py` to PostgreSQL, and set `GROQ_API_KEY` in the host's environment variables.

---

## Known Limitations & Manual Verification

- **Live Groq STT & Chrome Microphone:** Automated tests mock the Groq client. With a valid `GROQ_API_KEY` in `.env`, manually verify in Chrome:
  1. Live interim text appears while speaking English, Hindi, and mixed Hinglish before clicking Stop.
  2. Saving, searching, editing, and deleting records in the UI persist across server restarts.
  3. Zero browser console errors or failed WebSocket frames appear in DevTools.
- **Recording Size Cap:** A single continuous WebSocket recording is capped at `MAX_AUDIO_BYTES` (10 MB) to stay within API payload limits; upon reaching the cap, the server finalizes the recording and notifies the client.
- **No Audio Playback:** Audio files are not stored on disk or in SQLite; only text transcripts and metadata are persisted.
