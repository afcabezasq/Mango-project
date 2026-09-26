"""Insert confirmed message tasks using the team's existing Supabase adapter."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from Data.db import add_task


def queue_message(task):
    """Keep the public.tasks payload compatible with Caller/task_store.py."""
    payload = {key: task[key] for key in ("id", "recipient_name", "recipient_phone", "message")}
    payload.update(task=f"Deliver message to {task['recipient_name']} ({task['recipient_phone']}): {task['message']}", result=None)
    result = add_task(
        caller=task["requested_by"] or "Caller",
        scheduled_date=task["scheduled_at"], status="pending",
        task=json.dumps(payload),
    )
    if not isinstance(result, dict) or not result.get("id"):
        raise RuntimeError("Supabase did not confirm a saved task ID.")
    return str(result["id"])
