import pytest

from aula_clara_worker.audio import plan_chunks


def test_plan_chunks_uses_overlap_and_duration() -> None:
    chunks = plan_chunks(1_250_000, 600_000, 5_000)
    assert [(item.start_ms, item.end_ms) for item in chunks] == [
        (0, 600_000),
        (595_000, 1_195_000),
        (1_190_000, 1_250_000),
    ]


def test_plan_chunks_prefers_nearby_silence() -> None:
    chunks = plan_chunks(1_000_000, 600_000, 5_000, [570_000, 805_000])
    assert chunks[0].end_ms == 570_000
    assert chunks[1].start_ms == 565_000


def test_invalid_overlap_is_rejected() -> None:
    with pytest.raises(ValueError):
        plan_chunks(1000, 100, 100)
