from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Iterator
from uuid import UUID

from .database import JobRepository
from .errors import PipelineError
from .logging import get_logger
from .processor import JobProcessor


@contextmanager
def lock_heartbeat(repository: JobRepository, job_id, worker_id: str, interval_seconds: int) -> Iterator[None]:
    stopped = threading.Event()

    def beat() -> None:
        while not stopped.wait(max(1, interval_seconds)):
            repository.renew(job_id, worker_id)

    thread = threading.Thread(target=beat, name="job-lock-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join(timeout=2)


class Worker:
    def __init__(self, processor: JobProcessor) -> None:
        self.processor = processor
        self.settings = processor.settings
        self.repository = processor.repository
        self.log = get_logger()

    def run_once(self) -> bool:
        job = self.repository.claim(self.settings.worker_id, self.settings.lock_ttl_seconds)
        if not job:
            return False
        context = {"class_id": str(job["class_id"]), "job_id": str(job["id"]), "job_type": str(job["job_type"]), "attempt": job["attempt_count"]}
        self.log.info("job_started", **context)
        try:
            with lock_heartbeat(self.repository, job["id"], self.settings.worker_id, self.settings.lock_ttl_seconds // 3):
                output = self.processor.process(job)
            self.repository.complete_job(job["id"], output)
            self.log.info("job_completed", **context, output_keys=sorted(output))
        except PipelineError as error:
            status = self.repository.fail_job(job, error.code, error.public_message, error.transient)
            if (
                status == "failed"
                and job["job_type"].startswith("generate_")
                and job.get("input_json", {}).get("material_id")
            ):
                self.repository.fail_material(UUID(str(job["input_json"]["material_id"])), error.public_message)
            self.log.warning("job_failed", **context, error_code=error.code, retry_status=status)
        except Exception:
            status = self.repository.fail_job(job, "unexpected_error", "O processamento encontrou uma falha inesperada.", True)
            self.log.exception("job_unexpected_error", **context, retry_status=status)
        return True
