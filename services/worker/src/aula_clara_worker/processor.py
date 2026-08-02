from __future__ import annotations

import json
import tempfile
import time
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .audio import FfmpegAudioProcessor
from .config import Settings
from .consolidation import consolidate_segments
from .database import JobRepository
from .domain import NotesContent, SummaryContent
from .errors import InvalidPdfError, NoSpeechError, ReviewRequiredError
from .pdf_export import build_notes_html, render_pdf
from .providers import ContentProvider, FakeProvider, OpenAIContentProvider, OpenAITranscriptionProvider, TranscriptionProvider
from .storage import StorageGateway


def extract_pdf_text(path: Path, max_pages: int = 40, max_characters: int = 10_000) -> str:
    try:
        reader = PdfReader(str(path), strict=True)
        parts: list[str] = []
        for page in reader.pages[:max_pages]:
            parts.append(page.extract_text() or "")
            if sum(map(len, parts)) >= max_characters:
                break
        return "\n".join(parts)[:max_characters]
    except (PdfReadError, OSError, ValueError) as exc:
        raise InvalidPdfError("PDF não pôde ser extraído") from exc


def markdown_for(material_type: str, content: BaseModel) -> str | None:
    if isinstance(content, NotesContent):
        lines = [f"# {content.title}", "", "## Índice cronológico", *[f"- {item}" for item in content.chronological_index]]
        for section in content.sections:
            lines.extend(["", f"## {section.title}", section.body, f"\nTimestamp: {section.timestamp_ms} ms"])
        if content.emphasized_points:
            lines.extend(["", "## Pontos enfatizados", *[f"- {item}" for item in content.emphasized_points]])
        if content.teacher_examples:
            lines.extend(["", "## Exemplos do professor", *[f"- {item}" for item in content.teacher_examples]])
        if content.remaining_questions:
            lines.extend(["", "## Dúvidas remanescentes", *[f"- {item}" for item in content.remaining_questions]])
        return "\n".join(lines)
    if isinstance(content, SummaryContent):
        return "\n".join([
            "# Resumo", "", content.overview, "", "## Conceitos",
            *[f"- {item}" for item in content.concepts], "", "## Pontos para prova",
            *[f"- {item}" for item in content.exam_items],
        ])
    return None


class JobProcessor:
    def __init__(
        self,
        settings: Settings,
        repository: JobRepository,
        storage: StorageGateway,
        transcription_provider: TranscriptionProvider,
        content_provider: ContentProvider,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.storage = storage
        self.transcription_provider = transcription_provider
        self.content_provider = content_provider
        self.audio = FfmpegAudioProcessor(settings.max_transcription_chunk_bytes)

    @classmethod
    def build(cls, settings: Settings) -> JobProcessor:
        repository = JobRepository(settings.database_url)
        storage = StorageGateway(settings.supabase_url, settings.supabase_service_role_key, settings.signed_url_ttl_seconds)
        if settings.provider_mode == "fake":
            fake = FakeProvider()
            return cls(settings, repository, storage, fake, fake)
        return cls(
            settings,
            repository,
            storage,
            OpenAITranscriptionProvider(settings.openai_api_key, settings.transcription_model),
            OpenAIContentProvider(settings.openai_api_key, settings.review_model, settings.generation_model),
        )

    def process(self, job: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "prepare_audio": self.prepare_audio,
            "transcribe_chunk": self.transcribe_chunk,
            "assemble_transcript": self.assemble_transcript,
            "review_transcript": self.review_transcript,
            "generate_notes": self.generate_material,
            "generate_summary": self.generate_material,
            "generate_flashcards": self.generate_material,
            "generate_questions": self.generate_material,
            "generate_mindmap": self.generate_material,
            "generate_pdf": self.generate_pdf,
        }
        handler = handlers.get(str(job["job_type"]))
        if not handler:
            raise ValueError(f"tipo de job desconhecido: {job['job_type']}")
        return handler(job)

    def prepare_audio(self, job: dict[str, Any]) -> dict[str, Any]:
        source_file_id = UUID(str(job["input_json"]["source_file_id"]))
        existing = self.repository.existing_chunks(source_file_id)
        if existing:
            return {"resumed": True, "chunk_count": len(existing)}
        source = self.repository.get_file(source_file_id)
        self.repository.update_job_progress(job["id"], "Baixando áudio privado", 5)
        with tempfile.TemporaryDirectory(prefix="aula-clara-") as directory:
            workdir = Path(directory)
            source_path = workdir / "source-media"
            self.storage.download("class-audio", source["storage_path"], source_path)
            slide_context = ""
            slides = self.repository.find_slides(job["class_id"])
            if slides:
                slide_path = workdir / "slides.pdf"
                self.storage.download("class-materials", slides["storage_path"], slide_path)
                slide_context = extract_pdf_text(slide_path)
            self.repository.update_job_progress(job["id"], "Validando e dividindo áudio", 20)
            duration_ms, chunk_files = self.audio.prepare(
                source_path,
                workdir,
                self.settings.chunk_target_seconds,
                self.settings.chunk_overlap_seconds,
            )
            persisted: list[dict[str, Any]] = []
            for index, chunk in enumerate(chunk_files):
                storage_path = f"{job['user_id']}/{job['class_id']}/chunks/{chunk.sha256}.flac"
                self.storage.upload("class-audio", storage_path, chunk.path, "audio/flac")
                persisted.append({
                    "chunk_index": chunk.window.index,
                    "start_ms": chunk.window.start_ms,
                    "end_ms": chunk.window.end_ms,
                    "storage_path": storage_path,
                    "sha256": chunk.sha256,
                    "size_bytes": chunk.size_bytes,
                })
                self.repository.update_job_progress(job["id"], f"Salvando bloco {index + 1} de {len(chunk_files)}", 30 + round(((index + 1) / len(chunk_files)) * 60))
            self.repository.persist_prepared_chunks(job=job, source_file_id=source_file_id, duration_ms=duration_ms, chunks=persisted, slide_context=slide_context)
        return {"duration_ms": duration_ms, "chunk_count": len(persisted)}

    def transcribe_chunk(self, job: dict[str, Any]) -> dict[str, Any]:
        chunk_id = UUID(str(job["input_json"]["chunk_id"]))
        chunk = self.repository.get_chunk(chunk_id)
        if self.repository.chunk_already_transcribed(chunk_id):
            return {"resumed": True, "chunk_id": str(chunk_id)}
        klass = self.repository.get_class_context(job["class_id"])
        with tempfile.TemporaryDirectory(prefix="aula-clara-") as directory:
            chunk_path = Path(directory) / "chunk.flac"
            self.storage.download("class-audio", chunk["storage_path"], chunk_path)
            self.repository.update_job_progress(job["id"], "Enviando bloco para transcrição", 25)
            started = time.monotonic()
            result = self.transcription_provider.transcribe(
                chunk_path,
                duration_ms=int(chunk["end_ms"]) - int(chunk["start_ms"]),
                language=str(klass["language"]),
                context=self.repository.transcription_context(job["class_id"]),
                diarize=bool(klass.get("speaker_count")),
            )
            elapsed_ms = round((time.monotonic() - started) * 1000)
        if not result.segments:
            raise NoSpeechError("provider não retornou segmentos")
        audio_seconds = (int(chunk["end_ms"]) - int(chunk["start_ms"])) / 1000
        estimated = Decimal(str((audio_seconds / 60) * self.settings.audio_cost_per_minute))
        completed, total = self.repository.persist_transcription(
            job=job, chunk=chunk, result=result, model_name=self.settings.transcription_model, estimated_cost=estimated
        )
        return {"chunk_id": str(chunk_id), "segments": len(result.segments), "elapsed_ms": elapsed_ms, "chunks_completed": completed, "chunks_total": total}

    def assemble_transcript(self, job: dict[str, Any]) -> dict[str, Any]:
        if self.repository.assembly_done(job["class_id"]):
            return {"resumed": True, "version": 1}
        candidates = self.repository.consolidation_candidates(job["class_id"])
        if not candidates:
            raise NoSpeechError("nenhum segmento persistido")
        kept = consolidate_segments(candidates, self.settings.chunk_overlap_seconds * 1000)
        self.repository.persist_assembly(job, [item.id for item in kept])
        return {"version": 1, "input_segments": len(candidates), "segments": len(kept), "duplicates_removed": len(candidates) - len(kept)}

    def review_transcript(self, job: dict[str, Any]) -> dict[str, Any]:
        class_context = self.repository.get_class_context(job["class_id"])
        slide_context = self.repository.transcription_context(job["class_id"])
        reviewed = 0
        while batch := self.repository.unreviewed_segments(job["class_id"]):
            request = [{"segment_id": str(item["segment_id"]), "raw_text": item["raw_text"], "start_ms": item["start_ms"], "end_ms": item["end_ms"]} for item in batch]
            started = time.monotonic()
            result = self.content_provider.review(request, slide_context)
            duration = round((time.monotonic() - started) * 1000)
            self.repository.apply_review_batch(job["class_id"], result)
            reviewed += len(result.segments)
            usage = getattr(self.content_provider, "last_usage", {})
            input_units = usage.get("input_units")
            output_units = usage.get("output_units")
            estimated = Decimal(str(
                ((int(input_units or 0) / 1_000_000) * self.settings.input_cost_per_million)
                + ((int(output_units or 0) / 1_000_000) * self.settings.output_cost_per_million)
            ))
            self.repository.record_operation(
                class_id=job["class_id"],
                job_id=job["id"],
                provider=self.settings.provider_mode,
                model_name=self.settings.review_model,
                operation_type="review",
                duration_ms=duration,
                input_units=int(input_units) if input_units is not None else None,
                output_units=int(output_units) if output_units is not None else None,
                estimated_cost=estimated,
                request_id=str(usage["request_id"]) if usage.get("request_id") else None,
            )
            self.repository.update_job_progress(job["id"], f"{reviewed} segmentos revisados", min(95, 10 + reviewed))
        unreviewed, needs_review = self.repository.finish_review(job["class_id"])
        return {"reviewed": reviewed, "unreviewed": unreviewed, "needs_review": needs_review, "language": class_context["language"]}

    def generate_material(self, job: dict[str, Any]) -> dict[str, Any]:
        material_id = UUID(str(job["input_json"]["material_id"]))
        material = self.repository.get_material(material_id)
        if material["status"] == "completed":
            return {"resumed": True, "material_id": str(material_id)}
        transcript = self.repository.material_input(job["class_id"], int(material["source_transcript_version"]))
        if not transcript:
            raise ReviewRequiredError("transcrição ainda contém pendências")
        context = self.repository.get_class_context(job["class_id"])
        started = time.monotonic()
        content = self.content_provider.generate(str(material["material_type"]), transcript, context)
        duration = round((time.monotonic() - started) * 1000)
        self.repository.finish_material(material_id, content.model_dump(mode="json"), markdown_for(str(material["material_type"]), content), None, self.settings.generation_model)
        usage = getattr(self.content_provider, "last_usage", {})
        input_units = usage.get("input_units")
        output_units = usage.get("output_units")
        estimated = Decimal(str(
            ((int(input_units or 0) / 1_000_000) * self.settings.input_cost_per_million)
            + ((int(output_units or 0) / 1_000_000) * self.settings.output_cost_per_million)
        ))
        self.repository.record_operation(
            class_id=job["class_id"],
            job_id=job["id"],
            provider=self.settings.provider_mode,
            model_name=self.settings.generation_model,
            operation_type=str(material["material_type"]),
            duration_ms=duration,
            input_units=int(input_units) if input_units is not None else None,
            output_units=int(output_units) if output_units is not None else None,
            estimated_cost=estimated,
            request_id=str(usage["request_id"]) if usage.get("request_id") else None,
        )
        return {"material_id": str(material_id), "material_type": str(material["material_type"])}

    def generate_pdf(self, job: dict[str, Any]) -> dict[str, Any]:
        material_id = UUID(str(job["input_json"]["material_id"]))
        material = self.repository.get_material(material_id)
        if material["status"] == "completed" and material.get("storage_path"):
            return {"resumed": True, "material_id": str(material_id), "storage_path": material["storage_path"]}
        transcript = self.repository.material_input(job["class_id"], int(material["source_transcript_version"]))
        if not transcript:
            raise ReviewRequiredError("transcrição ainda contém pendências")
        notes_material_id = UUID(str(job["input_json"]["notes_material_id"]))
        notes_material = self.repository.get_material(notes_material_id)
        if (
            str(notes_material["class_id"]) != str(job["class_id"])
            or str(notes_material["material_type"]) != "notes"
            or str(notes_material["status"]) != "completed"
            or int(notes_material["source_transcript_version"])
            != int(material["source_transcript_version"])
        ):
            raise ReviewRequiredError("apostila validada ausente para esta versão")
        # JSONB returns UUID values as JSON strings. Validate from JSON so Pydantic
        # keeps strict field validation while applying JSON's canonical UUID decode.
        notes = NotesContent.model_validate_json(
            json.dumps(notes_material["structured_content"], ensure_ascii=False)
        )
        context = self.repository.get_class_context(job["class_id"])
        with tempfile.TemporaryDirectory(prefix="aula-clara-pdf-") as directory:
            destination = Path(directory) / "apostila.pdf"
            document = build_notes_html(
                context,
                transcript,
                int(material["source_transcript_version"]),
                notes,
            )
            started = time.monotonic()
            render_pdf(document, destination)
            duration = round((time.monotonic() - started) * 1000)
            storage_path = f"{job['user_id']}/{job['class_id']}/apostila-v{material['version']}.pdf"
            self.storage.upload("generated-exports", storage_path, destination, "application/pdf")
            pdf_size = destination.stat().st_size
        structured = {"kind": "study-notes-pdf", "source_transcript_version": material["source_transcript_version"], "source_notes_material_id": str(notes_material_id), "segment_count": len(transcript)}
        self.repository.finish_material(material_id, structured, None, storage_path, "playwright-html")
        self.repository.record_operation(class_id=job["class_id"], job_id=job["id"], provider="local", model_name="playwright", operation_type="pdf", duration_ms=duration)
        return {"material_id": str(material_id), "storage_path": storage_path, "size_bytes": pdf_size}
