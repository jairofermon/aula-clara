from types import SimpleNamespace
from uuid import uuid4

from aula_clara_worker.errors import TransientPipelineError
from aula_clara_worker.logging import configure_logging
from aula_clara_worker.worker import Worker


class FakeRepository:
    def __init__(self):
        self.job = {
            "id": uuid4(), "class_id": uuid4(), "user_id": uuid4(),
            "job_type": "prepare_audio", "attempt_count": 1,
            "max_attempts": 3, "input_json": {},
        }
        self.claims = 0
        self.completed = 0
        self.failures = []

    def claim(self, worker_id, lock_ttl):
        del worker_id, lock_ttl
        self.claims += 1
        return self.job if self.claims <= 2 else None

    def renew(self, job_id, worker_id):
        del job_id, worker_id
        return True

    def fail_job(self, job, code, message, transient):
        del job
        self.failures.append((code, message, transient))
        return "retry_wait"

    def complete_job(self, job_id, output):
        del job_id, output
        self.completed += 1


class FlakyProcessor:
    def __init__(self):
        self.repository = FakeRepository()
        self.settings = SimpleNamespace(worker_id="w1", lock_ttl_seconds=3)
        self.calls = 0

    def process(self, job):
        del job
        self.calls += 1
        if self.calls == 1:
            raise TransientPipelineError("timeout")
        return {"resumed": True}


def test_worker_retries_then_completes_without_duplicate_completion() -> None:
    configure_logging("CRITICAL")
    processor = FlakyProcessor()
    worker = Worker(processor)  # type: ignore[arg-type]
    assert worker.run_once() is True
    assert worker.run_once() is True
    assert processor.repository.failures[0][2] is True
    assert processor.repository.completed == 1
