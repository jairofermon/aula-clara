from __future__ import annotations

import os
from dataclasses import dataclass


def _integer(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise RuntimeError(f"{name} deve ser inteiro") from exc


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError as exc:
        raise RuntimeError(f"{name} deve ser numérico") from exc


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    supabase_url: str
    supabase_service_role_key: str
    openai_api_key: str
    transcription_model: str
    review_model: str
    generation_model: str
    provider_mode: str
    chunk_target_seconds: int
    chunk_overlap_seconds: int
    max_transcription_chunk_bytes: int
    signed_url_ttl_seconds: int
    worker_id: str
    poll_seconds: int
    lock_ttl_seconds: int
    log_level: str
    audio_cost_per_minute: float
    input_cost_per_million: float
    output_cost_per_million: float

    @classmethod
    def from_env(cls) -> Settings:
        settings = cls(
            database_url=os.getenv("SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"),
            supabase_url=os.getenv(
                "SUPABASE_INTERNAL_URL",
                os.getenv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321"),
            ),
            supabase_service_role_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            transcription_model=os.getenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-transcribe-diarize"),
            review_model=os.getenv("OPENAI_REVIEW_MODEL", "gpt-5.6"),
            generation_model=os.getenv("OPENAI_GENERATION_MODEL", "gpt-5.6"),
            provider_mode=os.getenv("PROVIDER_MODE", "fake").lower(),
            chunk_target_seconds=_integer("AUDIO_CHUNK_TARGET_SECONDS", 600),
            chunk_overlap_seconds=_integer("AUDIO_CHUNK_OVERLAP_SECONDS", 5),
            max_transcription_chunk_bytes=_integer("MAX_TRANSCRIPTION_CHUNK_MB", 24) * 1024 * 1024,
            signed_url_ttl_seconds=_integer("SIGNED_URL_TTL_SECONDS", 300),
            worker_id=os.getenv("WORKER_ID", "aula-clara-local-1"),
            poll_seconds=_integer("WORKER_POLL_SECONDS", 2),
            lock_ttl_seconds=_integer("WORKER_LOCK_TTL_SECONDS", 300),
            log_level=os.getenv("LOG_LEVEL", "INFO"),
            audio_cost_per_minute=_float("OPENAI_AUDIO_COST_PER_MINUTE", 0),
            input_cost_per_million=_float("OPENAI_INPUT_COST_PER_MILLION", 0),
            output_cost_per_million=_float("OPENAI_OUTPUT_COST_PER_MILLION", 0),
        )
        if settings.provider_mode not in {"fake", "openai"}:
            raise RuntimeError("PROVIDER_MODE deve ser fake ou openai")
        if settings.provider_mode == "openai" and not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY é obrigatória com PROVIDER_MODE=openai")
        if settings.chunk_overlap_seconds >= settings.chunk_target_seconds:
            raise RuntimeError("A sobreposição deve ser menor que o bloco-alvo")
        return settings
