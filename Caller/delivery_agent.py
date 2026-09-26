"""Outbound agent summoned for a single task: calls the recipient and delivers the message."""

import logging
import os
import re

import guava
from guava.events import BotSessionEnded, OutboundCallFailed

from constants import AGENT_PHONE_NUMBER, ORGANIZATION, SENDER_NAME
from task_store import MessageTask

logger = logging.getLogger("guava.delivery_agent")


def build_delivery_agent(task: MessageTask, outcome: dict) -> guava.Agent:
    """Create a fresh agent dedicated to one task. Writes the call result into `outcome`."""
    agent = guava.Agent(
        name=SENDER_NAME,
        organization=ORGANIZATION,
        purpose="Deliver a requested message or calendar reminder by phone.",
    )

    @agent.on_call_start
    def on_call_start(call: guava.Call) -> None:
        call.reach_person(
            contact_full_name=task.recipient_name,
            voicemail_message=(
                f"Hi {task.recipient_name}, this is a message from {SENDER_NAME}: {task.message}"
            ),
        )

    @agent.on_reach_person
    def on_reach_person(call: guava.Call, availability: str) -> None:
        if availability != "available":
            outcome["result"] = f"recipient {availability}"
            call.hangup("Politely say goodbye.")
            return
        call.set_task(
            "deliver_message",
            objective=f"Deliver a message from {SENDER_NAME} to {task.recipient_name}.",
            checklist=[
                guava.Say(f"{SENDER_NAME} asked me to give you this message."),
                guava.Say(task.message),
            ],
        )

    @agent.on_task_complete("deliver_message")
    def on_delivered(call: guava.Call) -> None:
        outcome["delivered"] = True
        outcome["result"] = "delivered"
        call.hangup("Wish them a wonderful day and say goodbye.")

    @agent.on_outbound_failed
    def on_outbound_failed(call: guava.Call, event: OutboundCallFailed) -> None:
        outcome["result"] = f"call failed: {event.error_reason} ({event.error_code})"

    @agent.on_session_end
    def on_session_end(call: guava.Call, event: BotSessionEnded) -> None:
        outcome.setdefault("result", f"session ended: {event.termination_reason}")

    return agent


def execute_task(task: MessageTask) -> tuple[bool, str]:
    """Run the scheduled task. Blocks until the outbound call ends.

    Set DELIVERY_MODE=log to skip the phone call (useful while testing with `chat`).
    """
    if os.environ.get("DELIVERY_MODE", "log") != "call":
        logger.info("[dry run] Would deliver task %s", task.id)
        return True, "logged (dry run)"

    if not re.fullmatch(r"\+[1-9]\d{7,14}", AGENT_PHONE_NUMBER):
        raise ValueError("Configure an owned Guava phone number before enabling delivery.")

    outcome: dict = {}
    agent = build_delivery_agent(task, outcome)
    agent.call_phone(
        from_number=AGENT_PHONE_NUMBER,
        to_number=task.recipient_phone,
    )
    return outcome.get("delivered", False), outcome.get("result", "unknown")
