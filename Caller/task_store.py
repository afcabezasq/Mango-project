"""Store for message tasks, backed directly by Supabase single tasks table (caller, date, task, status)."""

import json
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from Data.db import add_task, claim_due_tasks, get_tasks, update_task_status

PENDING = "pending"
RUNNING = "running"
DONE = "done"
FAILED = "failed"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class MessageTask:
    recipient_name: str
    recipient_phone: str
    message: str
    scheduled_at: str
    requested_by: str | None = None
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = PENDING
    created_at: str = field(default_factory=utc_now_iso)
    completed_at: str | None = None
    result: str | None = None

    def __post_init__(self):
        try:
            self.scheduled_at = datetime.fromisoformat(self.scheduled_at).astimezone(timezone.utc).isoformat()
        except Exception:
            self.scheduled_at = utc_now_iso()


class TaskStore:
    """Supabase-backed store mapping to single table: public.tasks (caller, date, task, status)."""

    def add(self, task: MessageTask) -> MessageTask:
        task_payload = json.dumps({
            "recipient_name": task.recipient_name,
            "recipient_phone": task.recipient_phone,
            "message": task.message,
            "id": task.id,
            "result": task.result,
        })
        caller_val = task.requested_by or task.recipient_phone or "Unknown"
        res = add_task(
            caller=caller_val,
            task=task_payload,
            scheduled_date=task.scheduled_at,
            status=task.status,
        )
        if isinstance(res, dict) and "id" in res:
            task.id = str(res["id"])
        return task

    def claim_due(self) -> list[MessageTask]:
        """Atomically claim pending tasks due from Supabase."""
        rows = claim_due_tasks()
        tasks = []
        for r in rows:
            task_str = r.get("task", "")
            try:
                data = json.loads(task_str)
                tasks.append(MessageTask(
                    recipient_name=data.get("recipient_name", "Caller"),
                    recipient_phone=data.get("recipient_phone", r.get("caller", "")),
                    message=data.get("message", task_str),
                    scheduled_at=r.get("date", utc_now_iso()),
                    requested_by=r.get("caller"),
                    id=str(r["id"]),
                    status=RUNNING,
                    created_at=r.get("created_at", utc_now_iso()),
                ))
            except Exception:
                tasks.append(MessageTask(
                    recipient_name="Caller",
                    recipient_phone=r.get("caller", ""),
                    message=task_str,
                    scheduled_at=r.get("date", utc_now_iso()),
                    requested_by=r.get("caller"),
                    id=str(r["id"]),
                    status=RUNNING,
                ))
        return tasks

    def finish(self, task_id: str, ok: bool, result: str) -> None:
        new_status = DONE if ok else FAILED
        update_task_status(task_id, new_status)

    def requeue_running(self) -> int:
        running_tasks = get_tasks(status=RUNNING)
        for t in running_tasks:
            update_task_status(t["id"], PENDING)
        return len(running_tasks)
