from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

from app import db
from app.config import settings
from app.main import app, state


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    path = str(tmp_path / "test_transcriptions.db")
    monkeypatch.setattr(settings, "db_path", path)
    db.init_db(path)


def test_index_and_health():
    with TestClient(app) as client:
        r_idx = client.get("/")
        assert r_idx.status_code == 200
        assert "Mumaith Chat" in r_idx.text
        assert "VaniScript" not in r_idx.text
        assert "/static/mumaith-logo.svg" in r_idx.text

        r_logo = client.get("/static/mumaith-logo.svg")
        assert r_logo.status_code == 200
        assert "<svg" in r_logo.text
        assert 'class="ai-orb-visual"' in r_idx.text
        assert 'data-orb-state="idle"' in r_idx.text

        r_health = client.get("/api/health")
        assert r_health.status_code == 200
        data = r_health.json()
        assert data["status"] == "ok"
        assert "stt_configured" in data


def test_transcription_crud_search_and_stats():
    with TestClient(app) as client:
        # Empty stats
        s0 = client.get("/api/transcriptions/stats").json()
        assert s0["total_count"] == 0

        # Create Hinglish + English records
        c1 = client.post(
            "/api/transcriptions",
            json={
                "title": "Ramesh Hinglish Test",
                "transcript": "Hello, mera naam Ramesh hai. I want to test the real-time transcription system.",
                "language": "mixed",
                "duration_ms": 5400,
            },
        )
        assert c1.status_code == 201
        t1 = c1.json()
        assert t1["word_count"] == 13

        c2 = client.post(
            "/api/transcriptions",
            json={
                "title": "English Standup",
                "transcript": "Daily engineering sync notes.",
                "language": "en",
                "duration_ms": 3000,
            },
        )
        assert c2.status_code == 201
        t2 = c2.json()

        # Search & filter
        listed = client.get("/api/transcriptions", params={"q": "Ramesh", "language": "mixed"}).json()
        assert listed["total"] == 1
        assert listed["items"][0]["id"] == t1["id"]

        # Read single
        got = client.get(f"/api/transcriptions/{t1['id']}")
        assert got.status_code == 200
        assert got.json()["title"] == "Ramesh Hinglish Test"

        # Update
        upd = client.patch(
            f"/api/transcriptions/{t1['id']}",
            json={"title": "Ramesh Updated", "transcript": "Hello, mera naam Ramesh hai."},
        )
        assert upd.status_code == 200
        assert upd.json()["title"] == "Ramesh Updated"
        assert upd.json()["word_count"] == 5

        # Stats
        s1 = client.get("/api/transcriptions/stats").json()
        assert s1["total_count"] == 2
        assert s1["total_duration_ms"] == 8400
        assert len(s1["recent"]) == 2

        # Delete
        d1 = client.delete(f"/api/transcriptions/{t2['id']}")
        assert d1.status_code == 200
        assert client.get(f"/api/transcriptions/{t2['id']}").status_code == 404


def _recv_json_timeout(ws, timeout: float = 3.0):
    import threading

    result: dict = {}
    exc_box: list[BaseException] = []
    done = threading.Event()

    def _reader():
        try:
            result["data"] = ws.receive_json()
        except BaseException as exc:  # pragma: no cover - propagated below
            exc_box.append(exc)
        finally:
            done.set()

    thread = threading.Thread(target=_reader, daemon=True)
    thread.start()
    if not done.wait(timeout=timeout):
        try:
            ws.close()
        except Exception:
            pass
        thread.join(timeout=1.0)
        raise AssertionError(f"Timed out after {timeout}s waiting for WebSocket event")
    if exc_box:
        raise exc_box[0]
    return result["data"]


def test_websocket_streaming_with_mock_stt():
    class FakeSTT:
        client = object()

        async def transcribe_detailed(self, audio, filename, mime, language="auto", prompt=None):
            return {"text": "Hello, mera naam Ramesh hai.", "language": language}

    with TestClient(app) as client:
        orig_stt = state["stt"]
        state["stt"] = FakeSTT()
        try:
            with client.websocket_connect("/ws/transcribe?language=mixed&mime=audio/webm") as ws:
                ws.send_bytes(b"\x00" * 8500)
                interim = _recv_json_timeout(ws)
                assert interim["type"] == "interim"
                assert "Ramesh" in interim["text"]

                ws.send_json({"type": "stop"})
                final = _recv_json_timeout(ws)
                assert final["type"] == "final"
                assert final["text"] == "Hello, mera naam Ramesh hai."
        finally:
            state["stt"] = orig_stt


def test_sqlite_persists_across_app_restarts(tmp_path, monkeypatch):
    db_file = str(tmp_path / "restart_persist.db")
    monkeypatch.setattr(settings, "db_path", db_file)

    # First app lifecycle: create record
    with TestClient(app) as client1:
        res = client1.post(
            "/api/transcriptions",
            json={
                "title": "Restart Persistence Check",
                "transcript": "Kal subah 10 baje meeting hai.",
                "language": "mixed",
                "duration_ms": 4200,
            },
        )
        assert res.status_code == 201
        created_id = res.json()["id"]

    # Second app lifecycle (simulating server restart): verify record & stats persist
    with TestClient(app) as client2:
        got = client2.get(f"/api/transcriptions/{created_id}")
        assert got.status_code == 200
        assert got.json()["title"] == "Restart Persistence Check"
        stats = client2.get("/api/transcriptions/stats").json()
        assert stats["total_count"] == 1


def test_ws_transcribe_without_api_key_sends_error():
    with TestClient(app) as client:
        orig_client = state["stt"].client
        state["stt"].client = None
        try:
            with client.websocket_connect("/ws/transcribe?language=auto&mime=audio/webm") as ws:
                err = ws.receive_json()
                assert err["type"] == "error"
                assert "GROQ_API_KEY" in err["message"]
        finally:
            state["stt"].client = orig_client


def test_ws_transcribe_limit_preserves_header_and_avoids_duplicate_final(monkeypatch):
    import app.main as main_mod

    seen_audio = []

    class CapturingSTT:
        client = object()

        async def transcribe_detailed(self, audio, filename, mime, language="auto", prompt=None):
            seen_audio.append(audio)
            return {"text": "Finalized before limit.", "language": language}

    monkeypatch.setattr(main_mod, "MAX_AUDIO_BYTES", 10000)

    with TestClient(app) as client:
        orig_stt = state["stt"]
        state["stt"] = CapturingSTT()
        try:
            with client.websocket_connect("/ws/transcribe?language=mixed&mime=audio/webm") as ws:
                # First chunk contains the WebM header
                ws.send_bytes(b"WEBM_HDR_" + b"\x01" * 4000)
                ws.send_bytes(b"\x02" * 4000)
                interim_msg = ws.receive_json()
                assert interim_msg["type"] == "interim"

                # Third chunk exceeds MAX_AUDIO_BYTES (10000)
                ws.send_bytes(b"\x03" * 4000)

                final_msg = ws.receive_json()
                assert final_msg["type"] == "final"
                assert final_msg["text"] == "Finalized before limit."

                limit_msg = ws.receive_json()
                assert limit_msg["type"] == "limit_reached"
                assert limit_msg["max_bytes"] == 10000

                # Sending extra chunks or stop after limit must not trigger a duplicate final STT call
                ws.send_bytes(b"\x04" * 2000)
                ws.send_json({"type": "stop"})
                ws.send_json({"type": "ping"})
                pong = ws.receive_json()
                assert pong["type"] == "pong"

            assert len(seen_audio) == 2  # 1 interim + 1 final (no duplicate final)
            assert all(a.startswith(b"WEBM_HDR_") for a in seen_audio)
            assert all(len(a) <= 10000 for a in seen_audio)
        finally:
            state["stt"] = orig_stt


def test_vercel_zero_config_entrypoint_and_lazy_init(tmp_path, monkeypatch):
    from app.config import _default_db_path
    from app.main import app as fastapi_app

    monkeypatch.setenv("VERCEL", "1")
    assert _default_db_path() == "/tmp/agent.db"

    # Simulate serverless cold start where state was not pre-populated by lifespan
    state.clear()
    db_file = str(tmp_path / "lazy_init.db")
    monkeypatch.setattr(settings, "db_path", db_file)

    with TestClient(fastapi_app) as client:
        res = client.get("/api/health")
        assert res.status_code == 200
        assert res.json()["status"] == "ok"
        assert client.get("/").status_code == 200
        assert client.get("/static/styles.css").status_code == 200
        assert client.get("/static/app.js").status_code == 200


@pytest.mark.asyncio
async def test_ensure_initialized_is_concurrency_safe(tmp_path, monkeypatch):
    import asyncio
    from app.main import ensure_initialized
    from app.rag import KnowledgeBase

    build_calls = 0
    orig_build = KnowledgeBase.build

    async def counting_build(self):
        nonlocal build_calls
        build_calls += 1
        await asyncio.sleep(0.02)
        await orig_build(self)

    monkeypatch.setattr(KnowledgeBase, "build", counting_build)
    monkeypatch.setattr(settings, "db_path", str(tmp_path / "concurrent.db"))
    state.clear()

    await asyncio.gather(*(ensure_initialized() for _ in range(10)))
    assert build_calls == 1
    assert state["initialized"] is True


def test_ws_transcribe_stt_exception_returns_error_event():
    class FailingSTT:
        client = object()

        async def transcribe_detailed(self, audio, filename, mime, language="auto", prompt=None):
            raise RuntimeError("Connection error.")

    with TestClient(app) as client:
        orig_stt = state["stt"]
        state["stt"] = FailingSTT()
        try:
            with client.websocket_connect("/ws/transcribe?language=mixed&mime=audio/webm") as ws:
                ws.send_bytes(b"\x00" * 8500)
                err = _recv_json_timeout(ws)
                assert err["type"] == "error"
                assert "Connection error." in err["message"]
        finally:
            state["stt"] = orig_stt


def test_voice_mode_turn_chat_and_reset():
    from app.agent import CONVERSATIONAL_PROMPT, VoiceAgent

    class FakeConversationalLLM:
        def __init__(self):
            self.chat = NS(completions=NS(create=self.create))

        async def create(self, **kwargs):
            last_user = kwargs["messages"][-1]["content"]
            return NS(choices=[NS(message=NS(content=f"Heard: {last_user}", tool_calls=None))])

    class FakeSTT:
        client = object()

        async def transcribe_detailed(self, audio, filename, mime, language="auto", prompt=None):
            return {"text": "Mera naam Ramesh hai.", "language": "hi"}

    with TestClient(app) as client:
        orig_stt = state["stt"]
        orig_vm = state.get("voice_mode_agent")
        state["stt"] = FakeSTT()
        state["voice_mode_agent"] = VoiceAgent(FakeConversationalLLM(), "fake", None, system_prompt=CONVERSATIONAL_PROMPT)
        try:
            r_turn = client.post(
                "/api/voice-mode/turn",
                files={"audio": ("utterance.webm", b"\x00" * 2000, "audio/webm")},
                data={"session_id": "vm-1", "language": "mixed"},
            )
            assert r_turn.status_code == 200
            d1 = r_turn.json()
            assert d1["transcript"] == "Mera naam Ramesh hai."
            assert d1["reply"] == "Heard: Mera naam Ramesh hai."
            assert d1["language"] == "hi"

            r_chat = client.post("/api/voice-mode/chat", json={"text": "Tell me a joke", "session_id": "vm-1", "language": "te"})
            assert r_chat.status_code == 200
            assert "Respond only in Telugu" in r_chat.json()["reply"]
            assert r_chat.json()["language"] == "te"
            assert len(state["voice_mode_agent"].sessions["vm-1"]) == 4

            r_reset = client.post("/api/voice-mode/reset", data={"session_id": "vm-1"})
            assert r_reset.status_code == 200
            assert "vm-1" not in state["voice_mode_agent"].sessions
        finally:
            state["stt"] = orig_stt
            state["voice_mode_agent"] = orig_vm


def test_speech_to_text_rejects_low_confidence_noise():
    import asyncio
    from app.speech import SpeechToText

    class FakeLowConfClient:
        def __init__(self):
            self.audio = NS(transcriptions=NS(create=self.create))

        async def create(self, **kwargs):
            return NS(
                text="Sí",
                language="es",
                segments=[{"no_speech_prob": 0.88, "avg_logprob": -1.45}],
            )

    stt = SpeechToText(FakeLowConfClient(), "whisper-large-v3-turbo")
    res = asyncio.run(stt.transcribe_detailed(b"\x00" * 2000, "noise.webm", "audio/webm"))
    assert res["low_confidence"] is True
    assert res["text"] == ""


def test_voice_mode_defaults_to_english_unless_changed():
    from app.agent import CONVERSATIONAL_PROMPT, VoiceAgent

    captured = []

    class RecordingLLM:
        def __init__(self):
            self.chat = NS(completions=NS(create=self.create))

        async def create(self, **kwargs):
            captured.append(kwargs["messages"][-1]["content"])
            return NS(choices=[NS(message=NS(content="English response.", tool_calls=None))])

    with TestClient(app) as client:
        orig_vm = state.get("voice_mode_agent")
        state["voice_mode_agent"] = VoiceAgent(RecordingLLM(), "fake", None, system_prompt=CONVERSATIONAL_PROMPT)
        try:
            r = client.post("/api/voice-mode/chat", json={"text": "Hola amigo", "session_id": "lang-lock"})
            assert r.status_code == 200
            assert r.json()["language"] == "en"
            assert captured[0].startswith("[Respond only in English]")
        finally:
            state["voice_mode_agent"] = orig_vm


def test_recv_json_timeout_does_not_leave_blocked_thread():
    import threading

    unblocked = threading.Event()

    class BlockingWS:
        def receive_json(self):
            unblocked.wait(timeout=5.0)
            raise RuntimeError("closed")

        def close(self):
            unblocked.set()

    before = {t.ident for t in threading.enumerate()}
    with pytest.raises(AssertionError, match="Timed out"):
        _recv_json_timeout(BlockingWS(), timeout=0.05)
    after = {t.ident for t in threading.enumerate() if t.is_alive()}
    assert unblocked.is_set()
    assert after.issubset(before)


def test_ws_transcribe_pcm_wraps_wav_and_supports_discard():
    seen_calls = []

    class PcmCapturingSTT:
        client = object()

        async def transcribe_detailed(self, audio, filename, mime, language="auto", prompt=None):
            seen_calls.append((audio, filename, mime, language))
            return {"text": "What are your clinic hours today?", "language": language, "low_confidence": False}

    with TestClient(app) as client:
        orig_stt = state["stt"]
        state["stt"] = PcmCapturingSTT()
        try:
            with client.websocket_connect("/ws/transcribe?language=en&mime=audio/pcm;rate=16000") as ws:
                ws.send_bytes(b"\x01\x00" * 4000)
                ws.send_json({"type": "discard"})
                ws.send_json({"type": "ping"})
                assert _recv_json_timeout(ws)["type"] == "pong"
                assert len(seen_calls) == 0

                ws.send_bytes(b"\x02\x00" * 17000)
                interim = _recv_json_timeout(ws)
                assert interim["type"] == "interim"

                ws.send_json({"type": "stop"})
                final = _recv_json_timeout(ws)
                assert final["type"] == "final"
                assert final["text"] == "What are your clinic hours today?"

            assert len(seen_calls) == 2
            for audio_bytes, fname, mime_type, lang in seen_calls:
                assert audio_bytes.startswith(b"RIFF")
                assert b"WAVEfmt " in audio_bytes[:20]
                assert fname == "stream.wav"
                assert mime_type == "audio/wav"
                assert lang == "en"
        finally:
            state["stt"] = orig_stt


def test_voice_mode_turn_rejects_noise_without_calling_llm():
    from app.agent import CONVERSATIONAL_PROMPT, VoiceAgent

    llm_calls = 0

    class CountingLLM:
        def __init__(self):
            self.chat = NS(completions=NS(create=self.create))

        async def create(self, **kwargs):
            nonlocal llm_calls
            llm_calls += 1
            return NS(choices=[NS(message=NS(content="Should not happen", tool_calls=None))])

    class NoiseSTT:
        client = object()

        async def transcribe_detailed(self, audio, filename, mime, language="auto", prompt=None):
            return {"text": "...", "language": "en", "low_confidence": True}

    with TestClient(app) as client:
        orig_stt = state["stt"]
        orig_vm = state.get("voice_mode_agent")
        state["stt"] = NoiseSTT()
        state["voice_mode_agent"] = VoiceAgent(CountingLLM(), "fake", None, system_prompt=CONVERSATIONAL_PROMPT)
        try:
            r = client.post(
                "/api/voice-mode/turn",
                files={"audio": ("noise.wav", b"RIFF" + b"\x00" * 2000, "audio/wav")},
                data={"session_id": "noise-1"},
            )
            assert r.status_code == 200
            body = r.json()
            assert body["transcript"] == ""
            assert body["reply"] == ""
            assert llm_calls == 0
        finally:
            state["stt"] = orig_stt
            state["voice_mode_agent"] = orig_vm


def test_voice_mode_turn_defaults_to_english_and_switches_explicitly():
    from app.agent import CONVERSATIONAL_PROMPT, VoiceAgent

    prompts = []

    class RecordingLLM:
        def __init__(self):
            self.chat = NS(completions=NS(create=self.create))

        async def create(self, **kwargs):
            prompts.append(kwargs["messages"])
            return NS(choices=[NS(message=NS(content="Reply.", tool_calls=None))])

    class FixedSTT:
        client = object()

        async def transcribe_detailed(self, audio, filename, mime, language="auto", prompt=None):
            return {"text": "Namaste, kya haal hai?", "language": language, "low_confidence": False}

    with TestClient(app) as client:
        orig_stt = state["stt"]
        orig_vm = state.get("voice_mode_agent")
        state["stt"] = FixedSTT()
        state["voice_mode_agent"] = VoiceAgent(RecordingLLM(), "fake", None, system_prompt=CONVERSATIONAL_PROMPT)
        try:
            r_default = client.post(
                "/api/voice-mode/turn",
                files={"audio": ("u1.wav", b"RIFF" + b"\x00" * 2000, "audio/wav")},
                data={"session_id": "lang-turn"},
            )
            assert r_default.status_code == 200
            assert any("Respond only in English" in m["content"] for m in prompts[0])

            r_explicit = client.post(
                "/api/voice-mode/turn",
                files={"audio": ("u2.wav", b"RIFF" + b"\x00" * 2000, "audio/wav")},
                data={"session_id": "lang-turn", "language": "hi"},
            )
            assert r_explicit.status_code == 200
            assert any("Respond only in Hindi" in m["content"] for m in prompts[1])
        finally:
            state["stt"] = orig_stt
            state["voice_mode_agent"] = orig_vm


def test_voice_vad_js_suite():
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run([node, "--test", "tests/test_voice_vad.mjs"], capture_output=True, text=True, timeout=15)
    assert res.returncode == 0, f"JS VAD tests failed:\n{res.stdout}\n{res.stderr}"


def test_stt_passes_vocab_hint_and_logs_safe_diagnostics(caplog, monkeypatch):
    import asyncio
    import logging
    from app.speech import SpeechToText

    seen_kwargs = []

    class CapturingClient:
        def __init__(self):
            self.audio = NS(transcriptions=NS(create=self.create))

        async def create(self, **kwargs):
            seen_kwargs.append(kwargs)
            return NS(
                text="My name is Bramha.",
                language="en",
                segments=[{"no_speech_prob": 0.05, "avg_logprob": -0.2}],
            )

    monkeypatch.setattr(settings, "stt_vocab_hint", "Bramha, VaniScript")
    stt = SpeechToText(CapturingClient(), "whisper-large-v3-turbo")
    wav_bytes = b"RIFF" + b"\x00" * 40 + b"\x01\x00" * 16000

    with caplog.at_level(logging.INFO, logger="speech"):
        res = asyncio.run(stt.transcribe_detailed(wav_bytes, "stream.wav", "audio/wav", language="en"))

    assert res["text"] == "My name is Bramha."
    assert seen_kwargs[0]["language"] == "en"
    assert seen_kwargs[0]["model"] == "whisper-large-v3-turbo"
    assert "Bramha" in seen_kwargs[0]["prompt"]
    assert any("duration_ms=" in rec.message and "Bramha" in rec.message for rec in caplog.records)
    assert not any("RIFF" in rec.message for rec in caplog.records)


def test_voice_mode_settings_popover_structure():
    with TestClient(app) as client:
        html = client.get("/").text
        assert 'id="vmSettingsBtn"' in html
        assert 'id="vmSettingsPopover"' in html
        assert 'role="dialog"' in html and 'hidden' in html
        pop_start = html.index('id="vmSettingsPopover"')
        pop_end = html.index('<!-- Live Waveform + Status -->')
        pop_html = html[pop_start:pop_end]
        for ctrl_id in ("vmCaptureMode", "vmSensitivity", "vmLanguage", "vmSilenceMs", "vmVoiceSelect", "vmRateSelect"):
            assert f'id="{ctrl_id}"' in pop_html
        for main_btn in ("vmStartBtn", "vmInterruptBtn", "vmPauseBtn", "vmMuteBtn", "vmEndBtn"):
            assert f'id="{main_btn}"' in html[:pop_start]
