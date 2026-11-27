"""FastAPI entrypoint: real-time STT WebSocket, transcription CRUD, and voice agent routes."""
import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db
from .agent import VoiceAgent
from .config import settings
from .rag import KnowledgeBase
from .speech import SpeechToText, TextToSpeech, build_client
from .tools import ToolRegistry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("api")
STATIC = Path(__file__).parent / "static"
MAX_AUDIO_BYTES = 10 * 1024 * 1024
ALLOWED_LANGUAGES = {"auto", "en", "hi", "mixed"}
state: dict = {}
_init_locks: dict[int, asyncio.Lock] = {}


async def ensure_initialized():
    loop_id = id(asyncio.get_running_loop())
    lock = _init_locks.setdefault(loop_id, asyncio.Lock())
    async with lock:
        if state.get("db_path") != settings.db_path:
            db.init_db()
            state["db_path"] = settings.db_path
        if state.get("initialized"):
            return
        client = build_client(required=False)
        if client is None:
            log.warning("GROQ_API_KEY is missing; STT and chat endpoints will return 503 until configured.")
        kb = KnowledgeBase(settings.kb_dir)
        await kb.build()
        state.update(
            initialized=True,
            kb=kb,
            agent=VoiceAgent(client, settings.llm_model, ToolRegistry(kb)) if client else None,
            stt=SpeechToText(client, settings.stt_model),
            tts=TextToSpeech(),
        )
        log.info("Ready | llm=%s stt=%s stt_configured=%s kb=%s db=%s",
                 settings.llm_model, settings.stt_model, client is not None, kb.mode, settings.db_path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_initialized()
    yield


app = FastAPI(title="Voice AI Transcription Studio", version="2.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def init_middleware(request: Request, call_next):
    await ensure_initialized()
    return await call_next(request)


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    session_id: str | None = None
    speak: bool = True


class TranscriptionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    transcript: str = Field(min_length=1, max_length=100000)
    language: Literal["auto", "en", "hi", "mixed"] = "auto"
    duration_ms: int = Field(default=0, ge=0)


class TranscriptionUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    transcript: str | None = Field(default=None, min_length=1, max_length=100000)
    language: Literal["auto", "en", "hi", "mixed"] | None = None


async def run_turn(session_id: str, user_text: str, speak: bool, stt_ms: int = 0) -> dict:
    if state.get("agent") is None:
        raise HTTPException(503, "GROQ_API_KEY is not configured. Add it to .env and restart.")
    t0 = time.perf_counter()
    try:
        result = await state["agent"].respond(session_id, user_text)
    except Exception as exc:
        log.exception("LLM failed")
        raise HTTPException(502, f"Language model error: {exc}") from exc

    audio = {"audio_b64": None, "mime": None, "engine": "off"}
    tts_ms = 0
    if speak:
        t1 = time.perf_counter()
        try:
            audio = await state["tts"].synthesize()
        except Exception as exc:  # degrade gracefully: browser voice
            log.warning("TTS failed, browser fallback: %s", exc)
            audio = {"audio_b64": None, "mime": None, "engine": "browser"}
        tts_ms = round((time.perf_counter() - t1) * 1000)

    agent_ms = round((time.perf_counter() - t0) * 1000) - tts_ms
    timings = {"stt_ms": stt_ms, "llm_ms": result["llm_ms"], "tools_ms": result["tools_ms"],
               "tts_ms": tts_ms, "total_ms": stt_ms + agent_ms + tts_ms}
    log.info("session=%s timings=%s tools=%s", session_id[:8], timings,
             [t["name"] for t in result["tool_calls"]])
    return {"session_id": session_id, "transcript": user_text, "reply": result["reply"],
            "tool_calls": result["tool_calls"], "timings": timings, **audio}


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "llm": settings.llm_model,
        "stt": settings.stt_model,
        "stt_configured": state["stt"].client is not None,
        "tts": settings.tts_provider,
        "kb_chunks": len(state["kb"].chunks),
        "kb_mode": state["kb"].mode,
    }


@app.post("/api/voice")
async def voice(
    audio: UploadFile = File(...),
    session_id: str = Form(None),
    speak: bool = Form(True),
    language: str = Form("auto"),
):
    if state["stt"].client is None:
        raise HTTPException(503, "GROQ_API_KEY is not configured. Add it to .env and restart.")
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Empty audio")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio too long - keep it under about a minute")
    session_id = session_id or str(uuid.uuid4())
    lang = language if language in ALLOWED_LANGUAGES else "auto"

    t0 = time.perf_counter()
    try:
        text = await state["stt"].transcribe(
            data,
            audio.filename or "audio.webm",
            audio.content_type or "audio/webm",
            language=lang,
        )
    except Exception as exc:
        log.exception("STT failed")
        raise HTTPException(502, f"Speech-to-text error: {exc}") from exc
    stt_ms = round((time.perf_counter() - t0) * 1000)

    if len(text) < 2:
        return {"session_id": session_id, "transcript": "", "reply": "", "tool_calls": [],
                "timings": {"stt_ms": stt_ms}, "audio_b64": None, "mime": None,
                "engine": "none", "note": "No speech detected"}
    return await run_turn(session_id, text, speak, stt_ms)


@app.post("/api/chat")
async def chat(body: ChatIn):
    return await run_turn(body.session_id or str(uuid.uuid4()), body.text.strip(), body.speak)


@app.post("/api/reset")
async def reset(session_id: str = Form(...)):
    if state.get("agent"):
        state["agent"].reset(session_id)
    return {"status": "reset"}


# ---------- Real-time Streaming Transcription WebSocket ----------
@app.websocket("/ws/transcribe")
async def ws_transcribe(
    websocket: WebSocket,
    language: str = Query("auto"),
    mime: str = Query("audio/webm"),
):
    await ensure_initialized()
    await websocket.accept()
    lang = language if language in ALLOWED_LANGUAGES else "auto"
    ext = "m4a" if "mp4" in mime else "ogg" if "ogg" in mime else "webm"
    filename = f"stream.{ext}"

    if state["stt"].client is None:
        await websocket.send_json({
            "type": "error",
            "message": "GROQ_API_KEY is not configured on the server. Add it to .env and restart.",
        })
        await websocket.close(code=1011)
        return

    buffer = bytearray()
    last_transcribed_len = 0
    last_stt_at = 0.0
    limit_reached = False
    finalized = False

    async def run_stt(msg_type: str):
        nonlocal last_transcribed_len, last_stt_at
        if len(buffer) < 1500:
            if msg_type == "final":
                await websocket.send_json({"type": "final", "text": "", "language": lang, "stt_ms": 0})
            return
        snapshot = bytes(buffer)
        t0 = time.perf_counter()
        try:
            res = await state["stt"].transcribe_detailed(snapshot, filename, mime, language=lang)
            stt_ms = round((time.perf_counter() - t0) * 1000)
            last_transcribed_len = len(snapshot)
            last_stt_at = time.monotonic()
            await websocket.send_json({
                "type": msg_type,
                "text": res["text"],
                "language": res["language"],
                "stt_ms": stt_ms,
            })
        except Exception as exc:
            log.warning("WebSocket STT error: %s", exc)
            await websocket.send_json({"type": "error", "message": f"Transcription error: {exc}"})

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                if limit_reached:
                    continue
                chunk = message["bytes"]
                if len(buffer) + len(chunk) > MAX_AUDIO_BYTES:
                    limit_reached = True
                    if not finalized:
                        await run_stt("final")
                        finalized = True
                    await websocket.send_json({
                        "type": "limit_reached",
                        "max_bytes": MAX_AUDIO_BYTES,
                        "message": "Recording reached the maximum audio limit and was finalized.",
                    })
                    continue
                buffer.extend(chunk)
                now = time.monotonic()
                if len(buffer) - last_transcribed_len >= 6000 and (now - last_stt_at) >= 1.6:
                    await run_stt("interim")
            elif message.get("text") is not None:
                try:
                    ctrl = json.loads(message["text"])
                except json.JSONDecodeError:
                    ctrl = {"type": message["text"]}
                cmd = ctrl.get("type")
                if cmd == "ping":
                    await websocket.send_json({"type": "pong"})
                elif cmd in ("stop", "flush"):
                    if not finalized:
                        await run_stt("final")
                    buffer.clear()
                    last_transcribed_len = 0
                    limit_reached = False
                    finalized = False
                elif cmd == "language" and ctrl.get("language") in ALLOWED_LANGUAGES:
                    lang = ctrl["language"]
    except WebSocketDisconnect:
        log.info("WebSocket client disconnected")


# ---------- Transcription History CRUD & Dashboard Stats ----------
@app.get("/api/transcriptions/stats")
async def transcription_stats():
    return db.get_transcription_stats()


@app.post("/api/transcriptions", status_code=201)
async def create_transcription(body: TranscriptionCreate):
    return db.create_transcription(
        title=body.title,
        transcript=body.transcript,
        language=body.language,
        duration_ms=body.duration_ms,
    )


@app.get("/api/transcriptions")
async def list_transcriptions(
    q: str = Query("", max_length=200),
    language: str = Query("all"),
    date_from: str = Query(""),
    date_to: str = Query(""),
    sort: Literal["newest", "oldest"] = Query("newest"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    return db.list_transcriptions(
        q=q,
        language=language,
        date_from=date_from,
        date_to=date_to,
        sort=sort,
        limit=limit,
        offset=offset,
    )


@app.get("/api/transcriptions/{transcription_id}")
async def get_transcription(transcription_id: int):
    row = db.get_transcription(transcription_id)
    if not row:
        raise HTTPException(404, "Transcription not found")
    return row


@app.patch("/api/transcriptions/{transcription_id}")
async def update_transcription(transcription_id: int, body: TranscriptionUpdate):
    row = db.update_transcription(
        transcription_id,
        title=body.title,
        transcript=body.transcript,
        language=body.language,
    )
    if not row:
        raise HTTPException(404, "Transcription not found")
    return row


@app.delete("/api/transcriptions/{transcription_id}")
async def delete_transcription(transcription_id: int):
    if not db.delete_transcription(transcription_id):
        raise HTTPException(404, "Transcription not found")
    return {"status": "deleted", "id": transcription_id}
