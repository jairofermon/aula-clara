from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .errors import ChunkTooLargeError, FfmpegMissingError, InvalidMediaError


@dataclass(frozen=True, slots=True)
class ChunkWindow:
    index: int
    start_ms: int
    end_ms: int


@dataclass(frozen=True, slots=True)
class AudioChunkFile:
    window: ChunkWindow
    path: Path
    sha256: str
    size_bytes: int


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def plan_chunks(
    duration_ms: int,
    target_ms: int,
    overlap_ms: int,
    silence_points_ms: list[int] | None = None,
) -> list[ChunkWindow]:
    if duration_ms <= 0 or target_ms <= 0 or overlap_ms < 0 or overlap_ms >= target_ms:
        raise ValueError("parâmetros de chunk inválidos")
    points = sorted(point for point in (silence_points_ms or []) if 0 < point < duration_ms)
    windows: list[ChunkWindow] = []
    start = 0
    while start < duration_ms:
        expected_end = min(duration_ms, start + target_ms)
        if expected_end == duration_ms:
            end = duration_ms
        else:
            radius = min(60_000, target_ms // 5)
            candidates = [point for point in points if expected_end - radius <= point <= expected_end + radius and point > start + 30_000]
            end = min(candidates, key=lambda point: abs(point - expected_end)) if candidates else expected_end
        if end <= start:
            raise ValueError("planejamento não avançou")
        windows.append(ChunkWindow(len(windows), start, end))
        if end == duration_ms:
            break
        start = end - overlap_ms
    return windows


class FfmpegAudioProcessor:
    def __init__(self, max_chunk_bytes: int) -> None:
        self.max_chunk_bytes = max_chunk_bytes

    @staticmethod
    def _ensure_tools() -> None:
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise FfmpegMissingError("ffmpeg/ffprobe ausente")

    @staticmethod
    def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(command, capture_output=True, check=True, text=True, encoding="utf-8", errors="replace")
        except FileNotFoundError as exc:
            raise FfmpegMissingError("ffmpeg/ffprobe ausente") from exc
        except subprocess.CalledProcessError as exc:
            # Não propaga nomes temporários nem stderr integral para o usuário.
            raise InvalidMediaError(f"ffmpeg retornou código {exc.returncode}") from exc

    def probe_duration_ms(self, source: Path) -> int:
        self._ensure_tools()
        result = self._run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
            "-of", "json", str(source),
        ])
        try:
            payload = json.loads(result.stdout)
            has_audio = any(item.get("codec_type") == "audio" for item in payload.get("streams", []))
            duration = float(payload["format"]["duration"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise InvalidMediaError("metadados de mídia inválidos") from exc
        if not has_audio or duration <= 0:
            raise InvalidMediaError("stream de áudio ausente")
        return round(duration * 1000)

    def _silence_points(self, source: Path) -> list[int]:
        try:
            result = subprocess.run(
                ["ffmpeg", "-hide_banner", "-i", str(source), "-af", "silencedetect=noise=-35dB:d=0.45", "-f", "null", "-"],
                capture_output=True, check=False, text=True, encoding="utf-8", errors="replace",
            )
        except FileNotFoundError as exc:
            raise FfmpegMissingError("ffmpeg ausente") from exc
        starts = [float(value) for value in re.findall(r"silence_start:\s*([0-9.]+)", result.stderr)]
        ends = [float(value) for value in re.findall(r"silence_end:\s*([0-9.]+)", result.stderr)]
        return [round(((start + end) / 2) * 1000) for start, end in zip(starts, ends, strict=False)]

    def prepare(
        self,
        source: Path,
        output_dir: Path,
        target_seconds: int,
        overlap_seconds: int,
    ) -> tuple[int, list[AudioChunkFile]]:
        duration_ms = self.probe_duration_ms(source)
        normalized = output_dir / "normalized.flac"
        self._run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", "-compression_level", "8", str(normalized),
        ])
        points = self._silence_points(normalized)
        windows = plan_chunks(duration_ms, target_seconds * 1000, overlap_seconds * 1000, points)
        chunks: list[AudioChunkFile] = []
        for window in windows:
            path = output_dir / f"chunk-{window.index:04d}.flac"
            self._run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{window.start_ms / 1000:.3f}", "-i", str(normalized),
                "-t", f"{(window.end_ms - window.start_ms) / 1000:.3f}",
                "-ac", "1", "-ar", "16000", "-c:a", "flac", "-compression_level", "8", str(path),
            ])
            size = path.stat().st_size
            if size > self.max_chunk_bytes:
                raise ChunkTooLargeError(f"chunk {window.index} acima do limite após compressão")
            chunks.append(AudioChunkFile(window, path, sha256_file(path), size))
        return duration_ms, chunks
