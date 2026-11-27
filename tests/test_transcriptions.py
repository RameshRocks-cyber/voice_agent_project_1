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
        assert "VaniScript AI" in r_idx.text

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
                ws.send_bytes(b"\x00" * 7000)
                interim = ws.receive_json()
                assert interim["type"] == "interim"
                assert "Ramesh" in interim["text"]

                ws.send_json({"type": "stop"})
                final = ws.receive_json()
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
