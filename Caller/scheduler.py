"""Scheduler service: runs separately from the intake agent.

Polls the task store for due tasks and summons one delivery agent per task, in parallel.

Run with `python scheduler.py`.
"""

import logging
import os
import threading

from guava import logging_utils

from delivery_agent import execute_task
from task_store import MessageTask, TaskStore

logger = logging.getLogger("guava.scheduler")

POLL_SECONDS = float(os.environ.get("SCHEDULER_POLL_SECONDS", "5"))


def run_task(store: TaskStore, task: MessageTask) -> None:
    logger.info("Delivering task %s to %s (%s)", task.id, task.recipient_name, task.recipient_phone)
    try:
        ok, result = execute_task(task)
    except Exception as exc:
        logger.exception("Task %s crashed", task.id)
        ok, result = False, f"error: {exc}"
    store.finish(task.id, ok, result)
    logger.info("Task %s finished: %s", task.id, result)


def main() -> None:
    logging_utils.configure_logging()
    store = TaskStore()
    stop = threading.Event()

    requeued = store.requeue_running()
    if requeued:
        logger.warning("Re-queued %d task(s) interrupted by a previous run", requeued)

    logger.info("Scheduler started, checking for due tasks every %ss", POLL_SECONDS)
    try:
        while not stop.wait(POLL_SECONDS):
            for task in store.claim_due():
                threading.Thread(
                    target=run_task, args=(store, task), name=f"task-{task.id}", daemon=True
                ).start()
    except KeyboardInterrupt:
        logger.info("Scheduler stopped")


if __name__ == "__main__":
    main()
