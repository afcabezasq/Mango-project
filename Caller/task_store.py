"""SQLite store for message tasks, shared by the intake service and the scheduler service."""

import sqlite3
import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path

PENDING = "pending"
RUNNING = "running"
DONE = "done"
FAILED = "failed"

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "tasks.db"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class MessageTask:
    recipient_name: str
    recipient_phone: str
    message: str
    scheduled_at: str  # ISO-8601 in UTC, so rows sort and compare as text
    requested_by: str | None = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    status: str = PENDING
    created_at: str = field(default_factory=utc_now_iso)
    completed_at: str | None = None
    result: str | None = None

    def __post_init__(self):
        self.scheduled_at = datetime.fromisoformat(self.scheduled_at).astimezone(timezone.utc).isoformat()


_COLUMNS = [f.name for f in fields(MessageTask)]


class TaskStore:
    def __init__(self, path: Path = DEFAULT_DB_PATH):
        self._path = path
        with self._connect() as db:
            db.execute(f"""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    {", ".join(f"{c} TEXT" for c in _COLUMNS if c != "id")}
                )
            """)

    def _connect(self) -> sqlite3.Connection:
        # A new connection per call keeps the store safe to use from any thread or process.
        db = sqlite3.connect(self._path, timeout=30)
        db.row_factory = sqlite3.Row
        return db

    def add(self, task: MessageTask) -> MessageTask:
        with self._connect() as db:
            db.execute(
                f"INSERT INTO tasks ({', '.join(_COLUMNS)}) VALUES ({', '.join('?' * len(_COLUMNS))})",
                [asdict(task)[c] for c in _COLUMNS],
            )
        return task

    def claim_due(self) -> list[MessageTask]:
        """Atomically mark every pending task that is due as running, and return them."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT * FROM tasks WHERE status = ? AND scheduled_at <= ? ORDER BY scheduled_at",
                (PENDING, utc_now_iso()),
            ).fetchall()
            db.executemany(
                "UPDATE tasks SET status = ? WHERE id = ?", [(RUNNING, r["id"]) for r in rows]
            )
        return [MessageTask(**{**dict(r), "status": RUNNING}) for r in rows]

    def finish(self, task_id: str, ok: bool, result: str) -> None:
        with self._connect() as db:
            db.execute(
                "UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?",
                (DONE if ok else FAILED, result, utc_now_iso(), task_id),
            )

    def requeue_running(self) -> int:
        """Put tasks interrupted by a scheduler crash back in the queue."""
        with self._connect() as db:
            return db.execute(
                "UPDATE tasks SET status = ? WHERE status = ?", (PENDING, RUNNING)
            ).rowcount
