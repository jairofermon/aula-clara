from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, TypeVar
from uuid import UUID

from openai import (
    APIConnectionError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)
from pydantic import BaseModel, ValidationError

from .domain import (
    Alternative,
    Flashcard,
    FlashcardsContent,
    MindmapContent,
    MindmapNode,
    NotesContent,
    NotesSection,
    Question,
    QuestionsContent,
    ReviewBatch,
    ReviewedSegment,
    ReviewIssue,
    SummaryContent,
    TimestampReference,
    TranscriptionResult,
    TranscriptionSegment,
)
from .errors import (
    AuthenticationProviderError,
    InvalidProviderResponse,
    QuotaProviderError,
    TransientPipelineError,
)

T = TypeVar("T", bound=BaseModel)


class TranscriptionProvider(ABC):
    @abstractmethod
    def transcribe(
        self,
        audio_path: Path,
        *,
        duration_ms: int,
        language: str,
        context: str,
        diarize: bool,
    ) -> TranscriptionResult: ...


class ContentProvider(ABC):
    @abstractmethod
    def review(self, segments: list[dict[str, Any]], slide_context: str) -> ReviewBatch: ...

    @abstractmethod
    def generate(self, material_type: str, transcript: list[dict[str, Any]], class_context: dict[str, Any]) -> BaseModel: ...


def _classify_openai_error(error: Exception) -> Exception:
    if isinstance(error, (APIConnectionError, APITimeoutError, RateLimitError)):
        return TransientPipelineError(str(error))
    if isinstance(error, (AuthenticationError, PermissionDeniedError)):
        return AuthenticationProviderError(str(error))
    if isinstance(error, BadRequestError) and any(term in str(error).lower() for term in ("quota", "billing", "credit")):
        return QuotaProviderError(str(error))
    if isinstance(error, BadRequestError):
        return InvalidProviderResponse(str(error))
    return error


class OpenAITranscriptionProvider(TranscriptionProvider):
    def __init__(self, api_key: str, model: str) -> None:
        self.client = OpenAI(api_key=api_key, timeout=180, max_retries=0)
        self.model = model

    def transcribe(
        self,
        audio_path: Path,
        *,
        duration_ms: int,
        language: str,
        context: str,
        diarize: bool,
    ) -> TranscriptionResult:
        try:
            with audio_path.open("rb") as audio_file:
                if "diarize" in self.model:
                    response = self.client.audio.transcriptions.create(
                        model=self.model,
                        file=audio_file,
                        response_format="diarized_json",
                        chunking_strategy="auto",
                        language=language,
                    )
                elif self.model == "whisper-1":
                    response = self.client.audio.transcriptions.create(
                        model=self.model,
                        file=audio_file,
                        response_format="verbose_json",
                        timestamp_granularities=["segment"],
                        language=language,
                        prompt=context[:1200] or None,
                    )
                else:
                    extra_body: dict[str, Any] = {}
                    if self.model == "gpt-transcribe":
                        extra_body = {"languages": [language]}
                    response = self.client.audio.transcriptions.create(
                        model=self.model,
                        file=audio_file,
                        prompt=context[:1200] or None,
                        extra_body=extra_body,
                    )
        except Exception as error:  # SDK expõe subclasses diferentes por status.
            classified = _classify_openai_error(error)
            if classified is not error:
                raise classified from error
            raise

        raw_segments = getattr(response, "segments", None)
        segments: list[TranscriptionSegment] = []
        if raw_segments:
            for item in raw_segments:
                start = round(float(getattr(item, "start", 0)) * 1000)
                end = round(float(getattr(item, "end", 0)) * 1000)
                text = str(getattr(item, "text", "")).strip()
                if text and end > start:
                    segments.append(
                        TranscriptionSegment(
                            text=text,
                            start_ms=start,
                            end_ms=end,
                            speaker_label=getattr(item, "speaker", None),
                            confidence=getattr(item, "confidence", None),
                        )
                    )
        else:
            text = str(getattr(response, "text", "")).strip()
            if text:
                segments.append(TranscriptionSegment(text=text, start_ms=0, end_ms=duration_ms))
        usage = getattr(response, "usage", None)
        return TranscriptionResult(
            segments=segments,
            request_id=getattr(response, "_request_id", None),
            input_units=getattr(usage, "input_tokens", None) if usage else None,
            output_units=getattr(usage, "output_tokens", None) if usage else None,
        )


class OpenAIContentProvider(ContentProvider):
    def __init__(self, api_key: str, review_model: str, generation_model: str) -> None:
        self.client = OpenAI(api_key=api_key, timeout=180, max_retries=0)
        self.review_model = review_model
        self.generation_model = generation_model
        self.last_usage: dict[str, int | str | None] = {}

    def _parse(self, model: str, schema: type[T], system: str, payload: object) -> T:
        try:
            response = self.client.responses.parse(
                model=model,
                input=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
                ],
                text_format=schema,
            )
            parsed = response.output_parsed
            usage = response.usage
            self.last_usage = {
                "input_units": getattr(usage, "input_tokens", None) if usage else None,
                "output_units": getattr(usage, "output_tokens", None) if usage else None,
                "request_id": getattr(response, "_request_id", None),
            }
        except (ValidationError, ValueError) as error:
            raise InvalidProviderResponse(str(error)) from error
        except Exception as error:
            classified = _classify_openai_error(error)
            if classified is not error:
                raise classified from error
            raise
        if parsed is None:
            raise InvalidProviderResponse("resposta recusada ou sem output estruturado")
        return parsed

    def review(self, segments: list[dict[str, Any]], slide_context: str) -> ReviewBatch:
        rules = (
            "Revise conservadoramente em português. Preserve sentido, exemplos, ordem e IDs. "
            "Não resuma nem use conhecimento externo. Corrija pontuação e erros evidentes; "
            "marque termos técnicos, nomes, números, dosagens e trechos sem sentido quando incertos. "
            "needs_review deve ser verdadeiro exatamente quando issues não estiver vazia."
        )
        result = self._parse(self.review_model, ReviewBatch, rules, {"segments": segments, "slides": slide_context[:8000]})
        expected = {UUID(str(item["segment_id"])) for item in segments}
        returned = [item.segment_id for item in result.segments]
        if set(returned) != expected or len(returned) != len(set(returned)):
            raise InvalidProviderResponse("IDs da revisão não correspondem ao lote")
        return result

    def generate(self, material_type: str, transcript: list[dict[str, Any]], class_context: dict[str, Any]) -> BaseModel:
        schemas: dict[str, type[BaseModel]] = {
            "notes": NotesContent,
            "summary": SummaryContent,
            "flashcards": FlashcardsContent,
            "questions": QuestionsContent,
            "mindmap": MindmapContent,
        }
        schema = schemas.get(material_type)
        if schema is None:
            raise ValueError(f"material não suportado: {material_type}")
        system = (
            "Gere material de estudo em português usando exclusivamente a transcrição validada. "
            "Preserve timestamps em milissegundos e IDs de origem. Não insira HTML. "
            "Em questões, gere cinco alternativas distintas, exatamente uma correta e explique todas. "
            "No Mermaid, use apenas mindmap com labels de texto simples."
        )
        return self._parse(self.generation_model, schema, system, {"class": class_context, "transcript": transcript})


class FakeProvider(TranscriptionProvider, ContentProvider):
    """Provider explícito e determinístico; nunca é selecionado silenciosamente em produção."""

    def transcribe(
        self,
        audio_path: Path,
        *,
        duration_ms: int,
        language: str,
        context: str,
        diarize: bool,
    ) -> TranscriptionResult:
        del audio_path, language, context
        midpoint = max(1000, duration_ms // 2)
        first_end = min(duration_ms, midpoint)
        items = [
            TranscriptionSegment(
                text="Nesta aula, vamos organizar os conceitos principais e relacioná-los aos exemplos.",
                start_ms=0,
                end_ms=first_end,
                speaker_label="Falante 1" if diarize else None,
                confidence=0.96,
            )
        ]
        if duration_ms > first_end:
            items.append(
                TranscriptionSegment(
                    text="O professor destacou um [trecho duvidoso] que precisa de conferência humana.",
                    start_ms=first_end,
                    end_ms=duration_ms,
                    speaker_label="Falante 1" if diarize else None,
                    confidence=0.68,
                )
            )
        return TranscriptionResult(segments=items, request_id="fake-local")

    def review(self, segments: list[dict[str, Any]], slide_context: str) -> ReviewBatch:
        del slide_context
        reviewed: list[ReviewedSegment] = []
        for item in segments:
            text = str(item["raw_text"]).strip()
            uncertain = "[trecho duvidoso]" in text
            issues = [ReviewIssue(type="unclear", description="Trecho marcado para escuta humana.", proposed_text=text.replace("[trecho duvidoso]", "trecho"))] if uncertain else []
            reviewed.append(ReviewedSegment(segment_id=UUID(str(item["segment_id"])), revised_text=text, needs_review=uncertain, confidence=0.68 if uncertain else 0.97, issues=issues))
        return ReviewBatch(segments=reviewed)

    def generate(self, material_type: str, transcript: list[dict[str, Any]], class_context: dict[str, Any]) -> BaseModel:
        if not transcript:
            raise InvalidProviderResponse("transcrição vazia")
        first = transcript[0]
        segment_id = UUID(str(first["segment_id"]))
        timestamp = int(first["start_ms"])
        title = str(class_context.get("title", "Aula"))
        if material_type == "summary":
            return SummaryContent(overview=f"Visão geral de {title}.", concepts=["Conceito principal"], mechanisms=["Relação explicada na aula"], classifications=[], cause_and_effect=[], teacher_examples=["Exemplo preservado da transcrição"], emphasized_points=["Ponto enfatizado"], traps=[], exam_items=["Revisar o conceito principal"], references=[TimestampReference(timestamp_ms=timestamp, source_segment_ids=[segment_id])])
        if material_type == "flashcards":
            return FlashcardsContent(flashcards=[Flashcard(id="fc-1", front="Qual é o conceito central?", back="O conceito apresentado no início da aula.", timestamp_ms=timestamp, tags=["aula-clara"], difficulty="easy", source_segment_ids=[segment_id])])
        if material_type == "questions":
            alternatives = [Alternative(id=letter, text=f"Alternativa {letter.upper()}") for letter in "abcde"]
            return QuestionsContent(questions=[Question(id="q-1", question="Qual alternativa corresponde ao ponto central da aula?", alternatives=alternatives, correct_alternative_id="a", correct_explanation="A alternativa A corresponde ao segmento usado.", incorrect_explanations={letter: "Não corresponde ao segmento de origem." for letter in "bcde"}, difficulty="easy", timestamp_ms=timestamp, source_segment_ids=[segment_id])])
        if material_type == "mindmap":
            return MindmapContent(title=title, root=MindmapNode(id="root", label=title, children=[MindmapNode(id="c1", label="Conceito principal")]), mermaid=f"mindmap\n  root(({title}))\n    Conceito principal")
        if material_type == "notes":
            return NotesContent(title=title, chronological_index=[f"00:00 — {title}"], sections=[NotesSection(title="Transcrição comentada", body=str(first["text"]), timestamp_ms=timestamp, source_segment_ids=[segment_id])], teacher_examples=["Exemplo preservado da aula"], emphasized_points=["Ponto enfatizado"], remaining_questions=[])
        raise ValueError(f"material não suportado: {material_type}")
