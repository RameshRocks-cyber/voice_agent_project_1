import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent


def env(key: str, default=None):
    value = os.getenv(key)
    return value if value not in (None, "") else default


def _default_db_path() -> str:
    if os.getenv("VERCEL"):
        return "/tmp/agent.db"
    return "data/agent.db"


def _default_kb_dir() -> str:
    candidate = Path("knowledge_base")
    if candidate.exists():
        return str(candidate)
    return str(BASE_DIR / "knowledge_base")


class Settings:
    is_vercel = bool(os.getenv("VERCEL"))
    groq_api_key = env("GROQ_API_KEY")
    llm_model = env("GROQ_CHAT_MODEL", "openai/gpt-oss-20b")
    stt_model = env("GROQ_STT_MODEL", "whisper-large-v3-turbo")
    tts_provider = "browser"

    timezone = env("TIMEZONE", "Asia/Kolkata")
    db_path = env("DB_PATH", _default_db_path())
    kb_dir = env("KB_DIR", _default_kb_dir())
    max_history_turns = int(env("MAX_HISTORY_TURNS", "10"))


settings = Settings()
