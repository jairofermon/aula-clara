from uuid import uuid4

import pytest
from pydantic import ValidationError

from aula_clara_worker.domain import ReviewBatch
from aula_clara_worker.providers import FakeProvider


def test_invalid_provider_shape_is_rejected_without_defaults() -> None:
    with pytest.raises(ValidationError):
        ReviewBatch.model_validate({
            "segments": [{
                "segment_id": str(uuid4()),
                "revised_text": "Texto",
                "needs_review": True,
                "confidence": 0.7,
                "issues": [],
                "campo_inventado": "não permitido",
            }]
        })


def test_fake_review_preserves_ids_and_marks_uncertainty() -> None:
    segment_id = uuid4()
    result = FakeProvider().review(
        [{"segment_id": str(segment_id), "raw_text": "Um [trecho duvidoso].", "start_ms": 0, "end_ms": 1000}],
        "",
    )
    assert result.segments[0].segment_id == segment_id
    assert result.segments[0].needs_review is True
    assert result.segments[0].issues[0].type == "unclear"
