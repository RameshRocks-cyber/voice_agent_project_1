"""Groq speech-to-text and browser-based speech output."""
import logging
import time

from groq import AsyncGroq

from .config import settings

log = logging.getLogger("speech")


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
        if language in ("en", "hi", "te"):
            kwargs["language"] = language
        vocab_hint = (settings.stt_vocab_hint or "").strip()
        if prompt is not None:
            kwargs["prompt"] = prompt
        elif language == "mixed":
            base = "Natural Hinglish conversation mixing Hindi and English."
            kwargs["prompt"] = f"{base} Names: {vocab_hint}." if vocab_hint else base
        elif vocab_hint:
            kwargs["prompt"] = f"Names: {vocab_hint}."

        t0 = time.perf_counter()
        resp = await self.client.audio.transcriptions.create(**kwargs)
        stt_ms = round((time.perf_counter() - t0) * 1000)
        text = (getattr(resp, "text", None) or "").strip()
        detected_lang = getattr(resp, "language", None) or (language if language in ("en", "hi", "te") else "auto")

        segments = getattr(resp, "segments", None) or []
        no_speech_probs = []
        logprobs = []
        for seg in segments:
            nsp = seg.get("no_speech_prob") if isinstance(seg, dict) else getattr(seg, "no_speech_prob", None)
            lp = seg.get("avg_logprob") if isinstance(seg, dict) else getattr(seg, "avg_logprob", None)
            if nsp is not None:
                no_speech_probs.append(float(nsp))
            if lp is not None:
                logprobs.append(float(lp))

        avg_no_speech = sum(no_speech_probs) / len(no_speech_probs) if no_speech_probs else 0.0
        mean_logprob = sum(logprobs) / len(logprobs) if logprobs else 0.0
        low_confidence = bool(segments and (avg_no_speech > 0.65 or mean_logprob < -1.2))
        has_alnum = any(ch.isalnum() for ch in text)
        if (low_confidence or not has_alnum) and text:
            text = ""
            low_confidence = True

        duration_ms = round((len(audio) - 44) / 32.0) if (mime == "audio/wav" and len(audio) > 44) else None
        log.info(
            "stt model=%s lang=%s detected=%s mime=%s bytes=%d duration_ms=%s stt_ms=%d low_conf=%s text=%r",
            self.model,
            language,
            detected_lang,
            mime,
            len(audio),
            duration_ms,
            stt_ms,
            low_confidence,
            text,
        )

        return {
            "text": text,
            "language": detected_lang,
            "no_speech_prob": round(avg_no_speech, 3),
            "avg_logprob": round(mean_logprob, 3),
            "low_confidence": low_confidence,
        }


class TextToSpeech:
    async def synthesize(self) -> dict:
        return {"audio_b64": None, "mime": None, "engine": "browser"}


def build_client(required: bool = True) -> AsyncGroq | None:
    if not settings.groq_api_key or settings.groq_api_key == "replace_with_your_groq_api_key":
        if required:
            raise RuntimeError("GROQ_API_KEY is missing. Add your key to the .env file.")
        return None
    return AsyncGroq(api_key=settings.groq_api_key)
