from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Iterator
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from .consolidation import CandidateSegment
from .domain import ReviewBatch, TranscriptionResult


def backoff_seconds(attempt_count: int, base: int = 5, maximum: int = 300) -> int:
    if attempt_count < 1:
        raise ValueError("attempt_count deve ser positivo")
    exponential = min(base * (2 ** (attempt_count - 1)), maximum)
    jitter = (attempt_count * 7) % max(1, min(base, 11))
    return min(exponential + jitter, maximum)


class JobRepository:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection[dict[str, Any]]]:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            yield connection

    def claim(self, worker_id: str, lock_ttl_seconds: int) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute(
                "select * from public.claim_processing_job(%s, %s) limit 1",
                (worker_id, lock_ttl_seconds),
            ).fetchone()
            return row

    def renew(self, job_id: UUID, worker_id: str) -> bool:
        with self.connection() as connection:
            row = connection.execute("select public.renew_job_lock(%s, %s) as renewed", (job_id, worker_id)).fetchone()
            return bool(row and row["renewed"])

    def update_job_progress(self, job_id: UUID, stage: str, progress: int) -> None:
        with self.connection() as connection:
            connection.execute(
                "update public.processing_jobs set stage=%s, progress=%s, locked_at=now() where id=%s and status='running'",
                (stage, progress, job_id),
            )

    def complete_job(self, job_id: UUID, output: dict[str, Any] | None = None) -> None:
        with self.connection() as connection:
            connection.execute(
                """update public.processing_jobs set status='completed', stage='completed', progress=100,
                   output_json=coalesce(%s::jsonb, output_json), finished_at=now(), locked_at=null, locked_by=null
                   where id=%s""",
                (json.dumps(output) if output is not None else None, job_id),
            )

    def fail_job(self, job: dict[str, Any], code: str, public_message: str, transient: bool) -> str:
        attempts = int(job["attempt_count"])
        max_attempts = int(job["max_attempts"])
        will_retry = transient and attempts < max_attempts
        status = "retry_wait" if will_retry else "failed"
        next_attempt = datetime.now(UTC) + timedelta(seconds=backoff_seconds(attempts))
        with self.connection() as connection:
            connection.execute(
                """update public.processing_jobs set status=%s, stage=%s, error_code=%s, error_message=%s,
                   next_attempt_at=%s, locked_at=null, locked_by=null,
                   finished_at=case when %s='failed' then now() else null end where id=%s""",
                (status, "backoff" if will_retry else "failed", code, public_message, next_attempt, status, job["id"]),
            )
            connection.execute(
                """update public.classes set status=%s, current_stage=%s, error_message=%s where id=%s""",
                ("queued" if will_retry else "failed", "Nova tentativa agendada" if will_retry else "Etapa com falha", public_message, job["class_id"]),
            )
        return status

    def get_class_context(self, class_id: UUID) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute(
                """select c.*, s.name as subject_name from public.classes c
                   join public.subjects s on s.id=c.subject_id where c.id=%s and c.deleted_at is null""",
                (class_id,),
            ).fetchone()
        if not row:
            raise ValueError("aula não encontrada")
        return row

    def get_file(self, file_id: UUID) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute("select * from public.class_files where id=%s and upload_completed", (file_id,)).fetchone()
        if not row:
            raise ValueError("arquivo não encontrado")
        return row

    def find_slides(self, class_id: UUID) -> dict[str, Any] | None:
        with self.connection() as connection:
            return connection.execute(
                "select * from public.class_files where class_id=%s and file_type='slides' and upload_completed order by created_at limit 1",
                (class_id,),
            ).fetchone()

    def existing_chunks(self, source_file_id: UUID) -> list[dict[str, Any]]:
        with self.connection() as connection:
            return connection.execute(
                "select * from public.audio_chunks where source_file_id=%s order by chunk_index", (source_file_id,)
            ).fetchall()

    def persist_prepared_chunks(
        self,
        *,
        job: dict[str, Any],
        source_file_id: UUID,
        duration_ms: int,
        chunks: list[dict[str, Any]],
        slide_context: str,
    ) -> None:
        with self.connection() as connection, connection.transaction():
            connection.execute("update public.class_files set duration_ms=%s where id=%s", (duration_ms, source_file_id))
            total = len(chunks)
            for item in chunks:
                chunk = connection.execute(
                    """insert into public.audio_chunks
                       (class_id,source_file_id,chunk_index,start_ms,end_ms,storage_path,sha256,size_bytes,status)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,'ready')
                       on conflict (source_file_id,chunk_index) do update set
                         storage_path=excluded.storage_path, sha256=excluded.sha256, size_bytes=excluded.size_bytes,
                         start_ms=excluded.start_ms, end_ms=excluded.end_ms, status='ready'
                       returning id""",
                    (
                        job["class_id"], source_file_id, item["chunk_index"], item["start_ms"], item["end_ms"],
                        item["storage_path"], item["sha256"], item["size_bytes"],
                    ),
                ).fetchone()
                key = f"transcribe_chunk:{chunk['id']}:{item['sha256']}"
                transcription_job = connection.execute(
                    """insert into public.processing_jobs
                       (class_id,user_id,job_type,status,stage,idempotency_key,input_json)
                       values (%s,%s,'transcribe_chunk','pending','queued',%s,%s::jsonb)
                       on conflict (idempotency_key) do update set idempotency_key=excluded.idempotency_key
                       returning id""",
                    (job["class_id"], job["user_id"], key, json.dumps({"chunk_id": str(chunk["id"])})),
                ).fetchone()
                connection.execute(
                    "update public.audio_chunks set transcription_job_id=%s where id=%s",
                    (transcription_job["id"], chunk["id"]),
                )
            connection.execute(
                """update public.processing_jobs set output_json=%s::jsonb where id=%s""",
                (json.dumps({"duration_ms": duration_ms, "chunk_count": total, "slide_context": slide_context}), job["id"]),
            )
            connection.execute(
                """update public.classes set status='transcribing', progress=20, current_stage=%s,
                   error_message=null where id=%s""",
                (f"0 de {total} blocos transcritos", job["class_id"]),
            )

    def get_chunk(self, chunk_id: UUID) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute("select * from public.audio_chunks where id=%s", (chunk_id,)).fetchone()
        if not row:
            raise ValueError("chunk não encontrado")
        return row

    def chunk_already_transcribed(self, chunk_id: UUID) -> bool:
        with self.connection() as connection:
            row = connection.execute(
                "select exists(select 1 from public.transcript_segments where chunk_id=%s) as done", (chunk_id,)
            ).fetchone()
            return bool(row and row["done"])

    def transcription_context(self, class_id: UUID) -> str:
        with self.connection() as connection:
            row = connection.execute(
                """select c.title,c.topic,c.teacher_name,c.glossary,s.name as subject_name,
                   coalesce((select output_json->>'slide_context' from public.processing_jobs
                     where class_id=c.id and job_type='prepare_audio' and status in ('running','completed')
                     order by created_at desc limit 1),'') as slides
                   from public.classes c join public.subjects s on s.id=c.subject_id where c.id=%s""",
                (class_id,),
            ).fetchone()
        if not row:
            return ""
        return "\n".join(str(row[key]) for key in ("subject_name", "title", "topic", "teacher_name", "glossary", "slides") if row.get(key))[:10000]

    def persist_transcription(
        self,
        *,
        job: dict[str, Any],
        chunk: dict[str, Any],
        result: TranscriptionResult,
        model_name: str,
        estimated_cost: Decimal,
    ) -> tuple[int, int]:
        with self.connection() as connection, connection.transaction():
            for index, segment in enumerate(result.segments):
                sequence = int(chunk["chunk_index"]) * 10_000 + index
                connection.execute(
                    """insert into public.transcript_segments
                       (class_id,chunk_id,transcript_version,sequence_number,start_ms,end_ms,speaker_label,raw_text,confidence)
                       values (%s,%s,1,%s,%s,%s,%s,%s,%s)
                       on conflict (class_id,transcript_version,sequence_number) do nothing""",
                    (
                        job["class_id"], chunk["id"], sequence,
                        int(chunk["start_ms"]) + segment.start_ms,
                        min(int(chunk["end_ms"]), int(chunk["start_ms"]) + segment.end_ms),
                        segment.speaker_label, segment.text, segment.confidence,
                    ),
                )
            connection.execute("update public.audio_chunks set status='completed' where id=%s", (chunk["id"],))
            connection.execute(
                """insert into public.usage_records
                   (class_id,processing_job_id,provider,model_name,operation_type,input_units,output_units,audio_seconds,estimated_cost,request_id)
                   values (%s,%s,%s,%s,'transcription',%s,%s,%s,%s,%s)""",
                (
                    job["class_id"], job["id"], "openai" if result.request_id != "fake-local" else "fake",
                    model_name, result.input_units, result.output_units,
                    (int(chunk["end_ms"]) - int(chunk["start_ms"])) / 1000,
                    estimated_cost, result.request_id,
                ),
            )
            counts = connection.execute(
                """select count(*)::int as total,
                   count(*) filter (where status='completed')::int as completed
                   from public.audio_chunks where class_id=%s""",
                (job["class_id"],),
            ).fetchone()
            progress = 20 + round((counts["completed"] / max(1, counts["total"])) * 50)
            connection.execute(
                "update public.classes set progress=%s,current_stage=%s where id=%s",
                (progress, f"{counts['completed']} de {counts['total']} blocos transcritos", job["class_id"]),
            )
            if counts["total"] > 0 and counts["completed"] == counts["total"]:
                connection.execute(
                    """insert into public.processing_jobs
                       (class_id,user_id,job_type,status,stage,idempotency_key,input_json)
                       values (%s,%s,'assemble_transcript','pending','queued',%s,'{}')
                       on conflict (idempotency_key) do nothing""",
                    (job["class_id"], job["user_id"], f"assemble_transcript:{job['class_id']}:v1"),
                )
        return int(counts["completed"]), int(counts["total"])

    def consolidation_candidates(self, class_id: UUID) -> list[CandidateSegment]:
        with self.connection() as connection:
            rows = connection.execute(
                """select s.id,s.chunk_id,c.chunk_index,c.start_ms as chunk_start_ms,
                   s.start_ms,s.end_ms,s.raw_text from public.transcript_segments s
                   join public.audio_chunks c on c.id=s.chunk_id
                   where s.class_id=%s and s.transcript_version=1 order by s.start_ms,c.chunk_index""",
                (class_id,),
            ).fetchall()
        return [CandidateSegment(row["id"], row["chunk_id"], row["chunk_index"], row["chunk_start_ms"], row["start_ms"], row["end_ms"], row["raw_text"]) for row in rows]

    def assembly_done(self, class_id: UUID) -> bool:
        with self.connection() as connection:
            row = connection.execute(
                "select exists(select 1 from public.transcript_versions where class_id=%s and version=1) as done", (class_id,)
            ).fetchone()
            return bool(row and row["done"])

    def persist_assembly(self, job: dict[str, Any], kept_ids: list[UUID]) -> None:
        with self.connection() as connection, connection.transaction():
            connection.execute(
                "delete from public.transcript_segments where class_id=%s and transcript_version=1 and not (id=any(%s))",
                (job["class_id"], kept_ids),
            )
            connection.execute(
                "update public.transcript_segments set sequence_number=sequence_number+100000000 where class_id=%s and transcript_version=1",
                (job["class_id"],),
            )
            for sequence, segment_id in enumerate(kept_ids):
                connection.execute("update public.transcript_segments set sequence_number=%s where id=%s", (sequence, segment_id))
            connection.execute(
                """insert into public.transcript_versions(class_id,user_id,version,status,segment_count)
                   values (%s,%s,1,'assembled',%s) on conflict (class_id,version) do nothing""",
                (job["class_id"], job["user_id"], len(kept_ids)),
            )
            connection.execute("update public.classes set transcript_version=1,status='reviewing',progress=72,current_stage='Revisando transcrição' where id=%s", (job["class_id"],))
            connection.execute(
                """insert into public.processing_jobs(class_id,user_id,job_type,status,stage,idempotency_key,input_json)
                   values (%s,%s,'review_transcript','pending','queued',%s,%s::jsonb)
                   on conflict (idempotency_key) do nothing""",
                (job["class_id"], job["user_id"], f"review_transcript:{job['class_id']}:v1", json.dumps({"transcript_version": 1})),
            )

    def unreviewed_segments(self, class_id: UUID, limit: int = 30) -> list[dict[str, Any]]:
        with self.connection() as connection:
            return connection.execute(
                """select id as segment_id,raw_text,start_ms,end_ms from public.transcript_segments
                   where class_id=%s and transcript_version=1 and review_status='unreviewed'
                   order by sequence_number limit %s""",
                (class_id, limit),
            ).fetchall()

    def apply_review_batch(self, class_id: UUID, batch: ReviewBatch) -> None:
        with self.connection() as connection, connection.transaction():
            for item in batch.segments:
                connection.execute(
                    """update public.transcript_segments set revised_text=%s,confidence=%s,review_status=%s
                       where id=%s and class_id=%s and review_status='unreviewed'""",
                    (item.revised_text, item.confidence, "needs_review" if item.needs_review else "auto_reviewed", item.segment_id, class_id),
                )
                for issue in item.issues:
                    connection.execute(
                        """insert into public.transcript_issues
                           (class_id,transcript_segment_id,issue_type,description,proposed_text,confidence)
                           values (%s,%s,%s,%s,%s,%s)""",
                        (class_id, item.segment_id, issue.type, issue.description, issue.proposed_text, item.confidence),
                    )

    def finish_review(self, class_id: UUID) -> tuple[int, int]:
        with self.connection() as connection, connection.transaction():
            counts = connection.execute(
                """select count(*) filter (where review_status='unreviewed')::int as unreviewed,
                   count(*) filter (where review_status='needs_review')::int as needs_review
                   from public.transcript_segments where class_id=%s and transcript_version=1""",
                (class_id,),
            ).fetchone()
            if counts["unreviewed"] == 0:
                status = "needs_user_review" if counts["needs_review"] else "completed"
                progress = 85 if counts["needs_review"] else 100
                stage = "Aguardando conferência" if counts["needs_review"] else "Transcrição validada"
                connection.execute("update public.classes set status=%s,progress=%s,current_stage=%s where id=%s", (status, progress, stage, class_id))
                connection.execute("update public.transcript_versions set status=%s where class_id=%s and version=1", ("reviewed" if counts["needs_review"] else "validated", class_id))
            return int(counts["unreviewed"]), int(counts["needs_review"])

    def material_input(self, class_id: UUID, version: int) -> list[dict[str, Any]]:
        with self.connection() as connection:
            checks = connection.execute(
                """select
                   (select count(*) from public.transcript_issues where class_id=%s and status='open')::int as issues,
                   (select count(*) from public.transcript_segments where class_id=%s and transcript_version=%s and review_status in ('unreviewed','needs_review'))::int as unreviewed""",
                (class_id, class_id, version),
            ).fetchone()
            if checks["issues"] or checks["unreviewed"]:
                return []
            return connection.execute(
                """select id as segment_id,start_ms,end_ms,speaker_label,
                   coalesce(revised_text,raw_text) as text from public.transcript_segments
                   where class_id=%s and transcript_version=%s order by sequence_number""",
                (class_id, version),
            ).fetchall()

    def get_material(self, material_id: UUID) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute("select * from public.materials where id=%s", (material_id,)).fetchone()
        if not row:
            raise ValueError("material não encontrado")
        return row

    def finish_material(self, material_id: UUID, structured: dict[str, Any], markdown: str | None, storage_path: str | None, model_name: str) -> None:
        with self.connection() as connection, connection.transaction():
            row = connection.execute(
                """update public.materials set status='completed',structured_content=%s::jsonb,
                   markdown_content=%s,storage_path=%s,model_name=%s,error_message=null
                   where id=%s returning class_id""",
                (json.dumps(structured, ensure_ascii=False, default=str), markdown, storage_path, model_name, material_id),
            ).fetchone()
            connection.execute("update public.classes set status='completed',progress=100,current_stage='Material pronto',error_message=null where id=%s", (row["class_id"],))

    def fail_material(self, material_id: UUID, message: str) -> None:
        with self.connection() as connection:
            connection.execute("update public.materials set status='failed',error_message=%s where id=%s", (message, material_id))

    def record_operation(
        self,
        *,
        class_id: UUID,
        job_id: UUID,
        provider: str,
        model_name: str,
        operation_type: str,
        duration_ms: int,
        input_units: int | None = None,
        output_units: int | None = None,
        estimated_cost: Decimal = Decimal("0"),
        request_id: str | None = None,
    ) -> None:
        with self.connection() as connection:
            connection.execute(
                """insert into public.usage_records
                   (class_id,processing_job_id,provider,model_name,operation_type,input_units,output_units,estimated_cost,request_id,duration_ms)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (class_id, job_id, provider, model_name, operation_type, input_units, output_units, estimated_cost, request_id, duration_ms),
            )
