"""SQLite store for appointments (stands in for a real business system / MySQL)."""
import os
import sqlite3
from contextlib import contextmanager

from .config import settings


@contextmanager
def connect(path: str | None = None):
    path = path or settings.db_path
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(path: str | None = None):
    with connect(path) as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                purpose TEXT,
                status TEXT NOT NULL DEFAULT 'booked',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS transcriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                transcript TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'auto',
                duration_ms INTEGER NOT NULL DEFAULT 0,
                word_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions(created_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_transcriptions_language ON transcriptions(language)")


def create_transcription(
    title: str,
    transcript: str,
    language: str = "auto",
    duration_ms: int = 0,
    path: str | None = None,
) -> dict:
    clean_title = (title or "").strip() or "Untitled Transcription"
    clean_text = (transcript or "").strip()
    word_count = len(clean_text.split()) if clean_text else 0
    with connect(path) as c:
        cur = c.execute(
            """INSERT INTO transcriptions (title, transcript, language, duration_ms, word_count)
               VALUES (?, ?, ?, ?, ?)""",
            (clean_title, clean_text, language or "auto", max(0, int(duration_ms)), word_count),
        )
        row = c.execute("SELECT * FROM transcriptions WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_transcriptions(
    q: str = "",
    language: str = "",
    date_from: str = "",
    date_to: str = "",
    sort: str = "newest",
    limit: int = 20,
    offset: int = 0,
    path: str | None = None,
) -> dict:
    clauses = ["1=1"]
    params: list = []

    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        clauses.append("(lower(title) LIKE ? OR lower(transcript) LIKE ?)")
        params.extend([like, like])

    if language and language not in ("all", ""):
        clauses.append("language = ?")
        params.append(language)

    if date_from:
        clauses.append("substr(created_at, 1, 10) >= ?")
        params.append(date_from)

    if date_to:
        clauses.append("substr(created_at, 1, 10) <= ?")
        params.append(date_to)

    where_sql = " AND ".join(clauses)
    order_sql = "created_at ASC, id ASC" if sort == "oldest" else "created_at DESC, id DESC"
    safe_limit = max(1, min(100, int(limit)))
    safe_offset = max(0, int(offset))

    with connect(path) as c:
        total = c.execute(f"SELECT COUNT(*) FROM transcriptions WHERE {where_sql}", params).fetchone()[0]
        rows = c.execute(
            f"SELECT * FROM transcriptions WHERE {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?",
            [*params, safe_limit, safe_offset],
        ).fetchall()

    return {
        "items": [dict(r) for r in rows],
        "total": total,
        "limit": safe_limit,
        "offset": safe_offset,
    }


def get_transcription(transcription_id: int, path: str | None = None) -> dict | None:
    with connect(path) as c:
        row = c.execute("SELECT * FROM transcriptions WHERE id = ?", (transcription_id,)).fetchone()
    return dict(row) if row else None


def update_transcription(
    transcription_id: int,
    title: str | None = None,
    transcript: str | None = None,
    language: str | None = None,
    path: str | None = None,
) -> dict | None:
    existing = get_transcription(transcription_id, path=path)
    if not existing:
        return None

    new_title = existing["title"] if title is None else (title.strip() or existing["title"])
    new_transcript = existing["transcript"] if transcript is None else transcript.strip()
    new_language = existing["language"] if language is None else language
    word_count = len(new_transcript.split()) if new_transcript else 0

    with connect(path) as c:
        c.execute(
            """UPDATE transcriptions
               SET title = ?, transcript = ?, language = ?, word_count = ?,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               WHERE id = ?""",
            (new_title, new_transcript, new_language, word_count, transcription_id),
        )
        row = c.execute("SELECT * FROM transcriptions WHERE id = ?", (transcription_id,)).fetchone()
    return dict(row) if row else None


def delete_transcription(transcription_id: int, path: str | None = None) -> bool:
    with connect(path) as c:
        cur = c.execute("DELETE FROM transcriptions WHERE id = ?", (transcription_id,))
    return cur.rowcount > 0


def get_transcription_stats(path: str | None = None) -> dict:
    from datetime import datetime, timedelta, timezone

    now_utc = datetime.now(timezone.utc)
    today_str = now_utc.strftime("%Y-%m-%d")
    start_14d = (now_utc - timedelta(days=13)).strftime("%Y-%m-%d")

    with connect(path) as c:
        totals = c.execute(
            "SELECT COUNT(*) AS total_count, COALESCE(SUM(duration_ms), 0) AS total_duration_ms FROM transcriptions"
        ).fetchone()
        today_count = c.execute(
            "SELECT COUNT(*) FROM transcriptions WHERE substr(created_at, 1, 10) = ?",
            (today_str,),
        ).fetchone()[0]
        lang_rows = c.execute(
            "SELECT language, COUNT(*) AS count FROM transcriptions GROUP BY language ORDER BY count DESC"
        ).fetchall()
        daily_rows = c.execute(
            """SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count,
                      COALESCE(SUM(duration_ms), 0) AS duration_ms
               FROM transcriptions
               WHERE substr(created_at, 1, 10) >= ?
               GROUP BY substr(created_at, 1, 10)
               ORDER BY date ASC""",
            (start_14d,),
        ).fetchall()
        recent_rows = c.execute(
            """SELECT id, title, transcript, language, duration_ms, word_count, created_at, updated_at
               FROM transcriptions
               ORDER BY created_at DESC, id DESC
               LIMIT 5"""
        ).fetchall()

    return {
        "total_count": totals["total_count"],
        "today_count": today_count,
        "total_duration_ms": totals["total_duration_ms"],
        "languages": [dict(r) for r in lang_rows],
        "daily_activity": [dict(r) for r in daily_rows],
        "recent": [dict(r) for r in recent_rows],
    }
