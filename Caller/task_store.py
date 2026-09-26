"""Supabase delivery queue. Only confirmed pending rows can be claimed."""

import json
import re
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from Data.db import add_task, claim_due_tasks, get_tasks, update_task_status, _request
from urllib.parse import quote

PENDING, RUNNING, DONE, FAILED = 'pending', 'in_progress', 'done', 'failed'


def utc_now_iso():
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
        when = datetime.fromisoformat(self.scheduled_at.replace('Z', '+00:00'))
        if when.tzinfo is None:
            raise ValueError('Task time requires a UTC offset.')
        self.scheduled_at = when.astimezone(timezone.utc).isoformat()
        if not self.recipient_name or not self.message or not re.fullmatch(r'\+[1-9]\d{7,14}', self.recipient_phone):
            raise ValueError('Task requires a name, message and E.164 phone number.')


class TaskStore:
    def __init__(self):
        self.payloads = {}

    def add(self, task):
        payload = {key: getattr(task, key) for key in ('id', 'recipient_name', 'recipient_phone', 'message', 'result')}
        row = add_task(task.requested_by or 'Caller', json.dumps(payload), task.scheduled_at, task.status)
        if not isinstance(row, dict) or not row.get('id'):
            raise RuntimeError('Supabase did not confirm a saved task.')
        task.id = str(row['id'])
        return task

    def due_preview(self):
        """Read-only dry run: never claim or finish a live task."""
        return _request(f'tasks?select=id,date&status=eq.pending&date=lte.{quote(utc_now_iso())}&order=date.asc&limit=10') or []

    def claim_due(self):
        tasks = []
        for row in claim_due_tasks():
            try:
                data = json.loads(row['task']) if isinstance(row['task'], str) else row['task']
                task = MessageTask(recipient_name=data['recipient_name'], recipient_phone=data['recipient_phone'],
                                   message=data['message'], scheduled_at=row['date'], requested_by=row.get('caller'),
                                   id=str(row['id']), status=RUNNING)
            except (ValueError, KeyError, TypeError):
                update_task_status(row['id'], FAILED, expected_status=RUNNING)
                continue  # Never turn malformed database content into a fallback phone call.
            self.payloads[task.id] = data
            tasks.append(task)
        return tasks

    def finish(self, task_id, ok, result):
        payload = self.payloads[task_id]
        payload = {**payload, 'result': result, 'completed_at': utc_now_iso()}
        rows = update_task_status(task_id, DONE if ok else FAILED, expected_status=RUNNING, task=json.dumps(payload))
        if not rows:
            raise RuntimeError('Could not confirm delivery status was saved; review before retrying.')
        self.payloads.pop(task_id, None)
