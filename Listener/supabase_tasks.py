"""Insert confirmed message tasks using the team's existing Supabase adapter."""

import json
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from Data.db import add_task, update_task_status


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


class BookingNeedsReview(Exception):
    """The row is durable but must not be delivered until booking is resolved."""


def queue_booking(calendar, appointment, reminder):
    """Persist intent before Google; release the reminder only after verified booking.

    Google and Postgres cannot share a transaction. A failed/uncertain operation
    leaves an awaiting_calendar row for review, never an automatically dialed task.
    """
    payload = {**reminder, "kind": "calendar_reminder", "calendar": appointment,
               "calendar_event_id": hashlib.sha256(appointment["request_id"].encode()).hexdigest(),
               "result": None}
    row = add_task(caller=reminder["requested_by"] or "Caller", task=json.dumps(payload),
                   scheduled_date=reminder["scheduled_at"], status="awaiting_calendar")
    if not isinstance(row, dict) or not row.get("id"):
        raise RuntimeError("Supabase did not confirm the booking request.")
    try:
        event = calendar.book(**appointment, confirmed=True)
        if event.get("id") != payload["calendar_event_id"]:
            raise RuntimeError("Calendar event ID did not match the request.")
        updated = update_task_status(row["id"], "pending", expected_status="awaiting_calendar")
        if not updated:
            raise RuntimeError("Could not verify the reminder was released.")
    except Exception:
        raise BookingNeedsReview("The saved request needs review before retrying.") from None
    return str(row["id"])
