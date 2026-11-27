"""Groq speech-to-text and browser-based speech output."""
from groq import AsyncGroq

from .config import settings


class SpeechToText:
    def __init__(self, client: AsyncGroq | None, model: str):
        self.client, self.model = client, model

    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        mime: str,
        language: str = "auto",
        prompt: str | None = None,
    ) -> str:
        result = await self.transcribe_detailed(audio, filename, mime, language=language, prompt=prompt)
        return result["text"]

    async def transcribe_detailed(
        self,
        audio: bytes,
        filename: str,
        mime: str,
        language: str = "auto",
        prompt: str | None = None,
    ) -> dict:
        if self.client is None:
            raise RuntimeError("GROQ_API_KEY is missing. Add your key to the .env file.")

        kwargs: dict = {
            "model": self.model,
            "file": (filename, audio, mime),
            "response_format": "verbose_json",
        }
        if language in ("en", "hi"):
            kwargs["language"] = language
        if prompt is not None:
            kwargs["prompt"] = prompt
        elif language == "mixed":
            kwargs["prompt"] = "Natural Hinglish conversation mixing Hindi and English."

        resp = await self.client.audio.transcriptions.create(**kwargs)
        text = (getattr(resp, "text", None) or "").strip()
        detected_lang = getattr(resp, "language", None) or (language if language in ("en", "hi") else "auto")
        return {"text": text, "language": detected_lang}


class TextToSpeech:
    async def synthesize(self) -> dict:
        return {"audio_b64": None, "mime": None, "engine": "browser"}


def build_client(required: bool = True) -> AsyncGroq | None:
    if not settings.groq_api_key or settings.groq_api_key == "replace_with_your_groq_api_key":
        if required:
            raise RuntimeError("GROQ_API_KEY is missing. Add your key to the .env file.")
        return None
    return AsyncGroq(api_key=settings.groq_api_key)
