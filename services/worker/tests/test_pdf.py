import json
from uuid import uuid4

from aula_clara_worker.domain import NotesContent, NotesSection
from aula_clara_worker.pdf_export import build_notes_html


def test_pdf_html_reuses_validated_notes_and_escapes_content() -> None:
    segment_id = uuid4()
    notes = NotesContent(
        title="Aula",
        chronological_index=["00:00 — Introdução"],
        sections=[
            NotesSection(
                title="Tema <principal>",
                body="Explicação validada",
                timestamp_ms=1_250,
                source_segment_ids=[segment_id],
            )
        ],
        teacher_examples=["Exemplo do professor"],
        emphasized_points=["Ponto de prova"],
        remaining_questions=["Dúvida conferida"],
    )
    document = build_notes_html(
        {"title": "Aula", "subject_name": "Biologia", "class_date": "2026-08-01"},
        [{"start_ms": 1_250, "text": "Transcrição integral"}],
        1,
        notes,
    )

    assert "Tema &lt;principal&gt;" in document
    assert "Exemplo do professor" in document
    assert "Ponto de prova" in document
    assert "Dúvida conferida" in document
    assert "Transcrição integral" in document


def test_notes_content_rehydrates_from_jsonb_representation() -> None:
    notes = NotesContent(
        title="Aula",
        chronological_index=["00:00 — Introdução"],
        sections=[
            NotesSection(
                title="Tema",
                body="Conteúdo",
                timestamp_ms=0,
                source_segment_ids=[uuid4()],
            )
        ],
        teacher_examples=[],
        emphasized_points=[],
        remaining_questions=[],
    )

    persisted_json = json.dumps(notes.model_dump(mode="json"), ensure_ascii=False)
    restored = NotesContent.model_validate_json(persisted_json)

    assert restored == notes
