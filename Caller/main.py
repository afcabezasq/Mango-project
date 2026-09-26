"""Intake service: inbound Guava agent that takes messages from callers and saves them as tasks.

Delivery is handled by the separate scheduler service (scheduler.py), which picks up
saved tasks when they are due.

Run with `python main.py [chat|local|phone]`.
"""

import logging
import os
import re
import sys
from datetime import date, datetime, time, timedelta

import guava
from guava import logging_utils
from guava.events import BotSessionEnded

from constants import AGENT_PHONE_NUMBER, ORGANIZATION, SENDER_NAME
from task_store import MessageTask, TaskStore

logger = logging.getLogger("guava.intake_agent")

store = TaskStore()

# Task built from a call's answers, waiting for the caller to confirm it. Keyed by call ID.
unconfirmed: dict[str, MessageTask] = {}

agent = guava.Agent(
    name=SENDER_NAME,
    organization=ORGANIZATION,
    purpose="Take messages from callers and schedule them to be delivered by phone.",
)

NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "ten": 10,
    "fifteen": 15, "twenty": 20, "thirty": 30, "forty five": 45, "half an": 0.5,
}
IMMEDIATE = ("now", "right now", "right away", "immediately", "asap")


def local_now() -> datetime:
    tz_name = os.environ.get("TASK_TIMEZONE")
    if tz_name:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(tz_name))
    return datetime.now().astimezone()


def parse_time(text: str) -> time | None:
    """Parse spoken times like '18:30', '6:30 pm', '6pm', 'noon'. Returns None if unclear."""
    text = text.strip().lower().replace(".", "")
    if text in ("noon", "midday"):
        return time(12, 0)
    if text == "midnight":
        return time(0, 0)
    match = re.fullmatch(r"(\d{1,2})(?:[:h ]?(\d{2}))?\s*(am|pm)?", text)
    if not match:
        return None
    hour, minute, meridiem = int(match[1]), int(match[2] or 0), match[3]
    if meridiem == "pm" and hour < 12:
        hour += 12
    elif meridiem == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    return time(hour, minute)


def parse_delay(text: str) -> timedelta | None:
    """Parse relative times like 'in one minute', 'in 5 minutes', 'in half an hour'."""
    match = re.fullmatch(r"(?:in\s+)?([\w ]+?)\s+(minute|min|hour|hr)s?(?: from now)?", text.strip().lower())
    if not match:
        return None
    amount = match[1]
    amount = float(amount) if amount.replace(".", "", 1).isdigit() else NUMBER_WORDS.get(amount)
    if amount is None:
        return None
    return timedelta(hours=amount) if match[2] in ("hour", "hr") else timedelta(minutes=amount)


def normalize_phone(text: str) -> str | None:
    digits = re.sub(r"\D", "", text)
    if text.strip().startswith("+") and 8 <= len(digits) <= 15:
        return "+" + digits
    if len(digits) == 10:  # assume a US number
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return None


def start_message_round(call: guava.Call, round_no: int) -> None:
    now = local_now()
    call.set_variable("round", round_no)
    call.set_task(
        f"take_message_{round_no}",
        objective=(
            "Take a message the caller wants delivered by phone, and when to deliver it. "
            f"Right now it is {now:%A, %B %d, %Y, %H:%M}. "
            "Do not confirm or read back anything yet; that happens in the next step."
        ),
        checklist=[
            guava.Field(key=f"recipient_name_{round_no}", field_type="text",
                        description="Full name of the person who should receive the message"),
            guava.Field(key=f"recipient_phone_{round_no}", field_type="text",
                        description="Recipient's phone number, including country code if outside the US"),
            guava.Field(key=f"message_{round_no}", field_type="text",
                        description="The exact message to deliver, in the caller's words"),
            guava.Field(key=f"delivery_date_{round_no}", field_type="date",
                        description="Date to deliver the message (today if they want it now or in a few minutes)"),
            guava.Field(key=f"delivery_time_{round_no}", field_type="text",
                        description=("When to deliver it, exactly as one of: a clock time like '6:30 pm', "
                                     "a delay like 'in 5 minutes', or 'now'")),
        ],
    )


def build_task(call: guava.Call, round_no: int) -> tuple[MessageTask | None, str | None]:
    """Turn the collected fields into a task, or return a reason to re-ask the caller."""
    get = lambda key: call.get_field(f"{key}_{round_no}")

    phone = normalize_phone(str(get("recipient_phone") or ""))
    if phone is None:
        return None, "The phone number is not valid. Ask for it again, including the area code."

    now = local_now()
    when_text = str(get("delivery_time") or "").strip().lower()
    delay = parse_delay(when_text)
    if when_text in IMMEDIATE:
        scheduled = now
    elif delay is not None:
        scheduled = now + delay
    else:
        parsed_time = parse_time(when_text)
        if parsed_time is None:
            return None, "The delivery time was unclear. Ask for a clock time like '6:30 pm' or a delay like 'in 10 minutes'."
        d = get("delivery_date")
        if isinstance(d, dict):
            day = date(d["year"], d["month"], d["day"])
        elif isinstance(d, str) and d:
            day = date.fromisoformat(d[:10])
        else:
            day = now.date()
        scheduled = datetime.combine(day, parsed_time, tzinfo=now.tzinfo)
        if scheduled < now - timedelta(minutes=1):
            return None, "That delivery time is in the past. Ask for a future date and time."

    return MessageTask(
        recipient_name=str(get("recipient_name")),
        recipient_phone=phone,
        message=str(get("message")),
        scheduled_at=scheduled.isoformat(),
        requested_by=getattr(call.call_info, "from_number", None),
    ), None


def describe_when(task: MessageTask) -> str:
    when = datetime.fromisoformat(task.scheduled_at).astimezone(local_now().tzinfo)
    if when - local_now() < timedelta(minutes=1):
        return "right away"
    day = "today" if when.date() == local_now().date() else f"on {when:%A, %B %d}"
    return f"{day} at {when:%I:%M %p}".replace(" 0", " ")


def confirm_task(call: guava.Call, round_no: int, task: MessageTask) -> None:
    unconfirmed[call.id] = task
    call.set_task(
        f"confirm_{round_no}",
        checklist=[
            (f"Read back the details: message \"{task.message}\" for {task.recipient_name} "
             f"at {task.recipient_phone}, delivered {describe_when(task)}."),
            guava.Field(key=f"confirmed_{round_no}", field_type="multiple_choice", choices=["yes", "no"],
                        description="Whether the caller confirms the details are correct"),
            guava.Field(key=f"another_message_{round_no}", field_type="multiple_choice", choices=["yes", "no"],
                        description="If confirmed, whether the caller wants to leave another message", required=False),
        ],
    )


@agent.on_call_start
def on_call_start(call: guava.Call) -> None:
    start_message_round(call, 1)


@agent.on_task_complete
def on_task_complete(call: guava.Call, task_id: str) -> None:
    round_no = call.get_variable("round", 1)

    if task_id == f"take_message_{round_no}":
        task, problem = build_task(call, round_no)
        if problem:
            logger.info("Re-asking caller: %s", problem)
            call.retry_task(reason=problem)
        else:
            confirm_task(call, round_no, task)

    elif task_id == f"confirm_{round_no}":
        task = unconfirmed.pop(call.id)
        if call.get_field(f"confirmed_{round_no}") != "yes":
            call.send_instruction("Apologize and collect the message details again.")
            start_message_round(call, round_no + 1)
            return

        store.add(task)
        logger.info("Saved task %s for %s at %s", task.id, task.recipient_name, task.scheduled_at)
        if call.get_field(f"another_message_{round_no}") == "yes":
            start_message_round(call, round_no + 1)
        else:
            call.hangup("Tell the caller their message is scheduled, thank them and say goodbye.")

    else:
        logger.warning("Unexpected task completed: %s", task_id)


@agent.on_session_end
def on_session_end(call: guava.Call, event: BotSessionEnded) -> None:
    unconfirmed.pop(call.id, None)
    logger.info("Session ended (session: %s)", call.id)


if __name__ == "__main__":
    logging_utils.configure_logging()

    # Pass "phone" or "local" as an argument to change modes:
    mode = sys.argv[1] if len(sys.argv) > 1 else "chat"
    if mode == "phone":
        agent.listen_phone(AGENT_PHONE_NUMBER)
    elif mode == "local":
        agent.call_local()
    else:
        agent.chat()
