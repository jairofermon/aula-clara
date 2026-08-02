from uuid import uuid4

from aula_clara_worker.consolidation import CandidateSegment, consolidate_segments, to_global_ms


def candidate(chunk_index: int, chunk_start: int, start: int, end: int, text: str) -> CandidateSegment:
    return CandidateSegment(uuid4(), uuid4(), chunk_index, chunk_start, start, end, text)


def test_global_timestamps() -> None:
    assert to_global_ms(595_000, 4_500) == 599_500


def test_overlap_duplicate_is_removed() -> None:
    first = candidate(0, 0, 596_000, 601_000, "A membrana controla a passagem de substâncias.")
    second = candidate(1, 595_000, 596_200, 601_100, "A membrana controla a passagem de substâncias")
    assert consolidate_segments([first, second], 5_000) == [first]


def test_similar_legitimate_sentence_outside_overlap_is_kept() -> None:
    first = candidate(0, 0, 100_000, 104_000, "Este conceito aparece novamente.")
    second = candidate(1, 595_000, 800_000, 804_000, "Este conceito aparece novamente.")
    assert consolidate_segments([first, second], 5_000) == [first, second]
