import shutil
import subprocess
from pathlib import Path

import pytest

from aula_clara_worker.audio import FfmpegAudioProcessor


@pytest.mark.integration
@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg ausente")
def test_real_ffmpeg_creates_valid_chunks(tmp_path: Path) -> None:
    source = tmp_path / "tone.wav"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=3", str(source),
    ], check=True)
    duration, chunks = FfmpegAudioProcessor(24 * 1024 * 1024).prepare(source, tmp_path, 2, 1)
    assert 2_900 <= duration <= 3_100
    assert len(chunks) >= 2
    assert all(chunk.path.exists() and chunk.size_bytes > 0 for chunk in chunks)
