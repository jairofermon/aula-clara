from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from uuid import UUID


@dataclass(frozen=True, slots=True)
class CandidateSegment:
    id: UUID
    chunk_id: UUID
    chunk_index: int
    chunk_start_ms: int
    start_ms: int
    end_ms: int
    text: str


def _normalized(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text.casefold())
    return re.sub(r"[^a-z0-9]+", " ", "".join(char for char in plain if not unicodedata.combining(char))).strip()


def _is_overlap_duplicate(previous: CandidateSegment, current: CandidateSegment, overlap_ms: int) -> bool:
    if previous.chunk_id == current.chunk_id or previous.chunk_index >= current.chunk_index:
        return False
    boundary_limit = current.chunk_start_ms + overlap_ms + 2_000
    if current.start_ms > boundary_limit or previous.end_ms < current.chunk_start_ms - 2_000:
        return False
    left, right = _normalized(previous.text), _normalized(current.text)
    if not left or not right:
        return False
    similarity = SequenceMatcher(None, left, right).ratio()
    return similarity >= 0.90 and abs(previous.start_ms - current.start_ms) <= overlap_ms + 3_000


def consolidate_segments(segments: list[CandidateSegment], overlap_ms: int) -> list[CandidateSegment]:
    ordered = sorted(segments, key=lambda item: (item.start_ms, item.chunk_index, item.end_ms))
    output: list[CandidateSegment] = []
    for current in ordered:
        duplicate = any(_is_overlap_duplicate(previous, current, overlap_ms) for previous in output[-4:])
        if not duplicate:
            output.append(current)
    return output


def to_global_ms(chunk_start_ms: int, local_ms: int) -> int:
    if chunk_start_ms < 0 or local_ms < 0:
        raise ValueError("timestamps não podem ser negativos")
    return chunk_start_ms + local_ms
