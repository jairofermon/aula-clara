from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class TranscriptionSegment(StrictModel):
    text: str = Field(min_length=1)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    speaker_label: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def end_after_start(self) -> TranscriptionSegment:
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms deve ser maior que start_ms")
        return self


class TranscriptionResult(StrictModel):
    segments: list[TranscriptionSegment]
    request_id: str | None = None
    input_units: int | None = Field(default=None, ge=0)
    output_units: int | None = Field(default=None, ge=0)


IssueType = Literal["unclear", "technical_term", "medical_term", "number", "dosage", "proper_name", "nonsense"]


class ReviewIssue(StrictModel):
    type: IssueType
    description: str = Field(min_length=1)
    proposed_text: str | None = None


class ReviewedSegment(StrictModel):
    segment_id: UUID
    revised_text: str = Field(min_length=1)
    needs_review: bool
    confidence: float = Field(ge=0, le=1)
    issues: list[ReviewIssue]

    @model_validator(mode="after")
    def issue_consistency(self) -> ReviewedSegment:
        if self.needs_review != bool(self.issues):
            raise ValueError("needs_review deve corresponder à existência de issues")
        return self


class ReviewBatch(StrictModel):
    segments: list[ReviewedSegment]


class TimestampReference(StrictModel):
    timestamp_ms: int = Field(ge=0)
    source_segment_ids: list[UUID] = Field(min_length=1)


class SummaryContent(StrictModel):
    overview: str
    concepts: list[str]
    mechanisms: list[str]
    classifications: list[str]
    cause_and_effect: list[str]
    teacher_examples: list[str]
    emphasized_points: list[str]
    traps: list[str]
    exam_items: list[str]
    references: list[TimestampReference]


class Flashcard(StrictModel):
    id: str
    front: str
    back: str
    timestamp_ms: int = Field(ge=0)
    tags: list[str]
    difficulty: Literal["easy", "medium", "hard"]
    source_segment_ids: list[UUID] = Field(min_length=1)


class FlashcardsContent(StrictModel):
    flashcards: list[Flashcard]


class Alternative(StrictModel):
    id: str
    text: str


class Question(StrictModel):
    id: str
    question: str
    alternatives: list[Alternative] = Field(min_length=5, max_length=5)
    correct_alternative_id: str
    correct_explanation: str
    incorrect_explanations: dict[str, str]
    difficulty: Literal["easy", "medium", "hard"]
    timestamp_ms: int = Field(ge=0)
    source_segment_ids: list[UUID] = Field(min_length=1)

    @model_validator(mode="after")
    def one_correct(self) -> Question:
        ids = [item.id for item in self.alternatives]
        if len(ids) != len(set(ids)) or ids.count(self.correct_alternative_id) != 1:
            raise ValueError("deve haver exatamente uma alternativa correta existente")
        incorrect = set(ids) - {self.correct_alternative_id}
        if set(self.incorrect_explanations) != incorrect:
            raise ValueError("todas as alternativas incorretas precisam de explicação")
        return self


class QuestionsContent(StrictModel):
    questions: list[Question]


class MindmapNode(StrictModel):
    id: str
    label: str
    children: list[MindmapNode] = Field(default_factory=list)


class MindmapContent(StrictModel):
    title: str
    root: MindmapNode
    mermaid: str


class NotesSection(StrictModel):
    title: str
    body: str
    timestamp_ms: int = Field(ge=0)
    source_segment_ids: list[UUID] = Field(min_length=1)


class NotesContent(StrictModel):
    title: str
    chronological_index: list[str]
    sections: list[NotesSection]
    teacher_examples: list[str]
    emphasized_points: list[str]
    remaining_questions: list[str]
