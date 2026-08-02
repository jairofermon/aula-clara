import os
from pathlib import Path

import pytest

from aula_clara_worker.providers import OpenAITranscriptionProvider


@pytest.mark.integration
@pytest.mark.skipif(os.getenv("RUN_OPENAI_INTEGRATION") != "1" or not os.getenv("OPENAI_API_KEY"), reason="integração paga desativada")
def test_openai_small_audio_when_explicitly_enabled() -> None:
    audio = Path(__file__).parent / "fixtures" / "sample.webm"
    if not audio.exists():
        pytest.skip("adicione tests/fixtures/sample.webm para executar")
    provider = OpenAITranscriptionProvider(os.environ["OPENAI_API_KEY"], os.getenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-transcribe-diarize"))
    result = provider.transcribe(audio, duration_ms=3000, language="pt", context="", diarize=True)
    assert result.segments
