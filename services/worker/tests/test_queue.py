from contextlib import contextmanager
from pathlib import Path

from aula_clara_worker.database import JobRepository, backoff_seconds


class FakeCursor:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def execute(self, sql, params):
        self.calls.append((sql, params))
        return FakeCursor(self.row)


def test_claim_calls_atomic_database_function(monkeypatch) -> None:
    repository = JobRepository("unused")
    connection = FakeConnection({"id": "job-1"})

    @contextmanager
    def fake_connection():
        yield connection

    monkeypatch.setattr(repository, "connection", fake_connection)
    assert repository.claim("worker-1", 300) == {"id": "job-1"}
    assert "claim_processing_job" in connection.calls[0][0]
    assert connection.calls[0][1] == ("worker-1", 300)


def test_migration_uses_skip_locked() -> None:
    root = Path(__file__).parents[3]
    migration = (root / "supabase" / "migrations" / "202608010001_initial_schema.sql").read_text(encoding="utf-8")
    assert "for update skip locked" in migration.lower()
    assert "idempotency_key text not null unique" in migration.lower()


def test_backoff_grows_and_is_capped() -> None:
    values = [backoff_seconds(attempt) for attempt in range(1, 10)]
    assert values == sorted(values)
    assert values[-1] == 300
