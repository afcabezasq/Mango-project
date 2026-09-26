"""Poll Supabase for confirmed due reminders and deliver each claimed row once."""

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from guava import logging_utils
from delivery_agent import execute_task
from task_store import TaskStore
from Data.config import load_config

logger = logging.getLogger('guava.scheduler')


def run_task(store, task):
    logger.info('Delivering task %s', task.id)
    try:
        ok, result = execute_task(task)
    except Exception:
        logger.warning('Task %s failed; provider details omitted', task.id)
        ok, result = False, 'Delivery failed; review before retrying.'
    try:
        store.finish(task.id, ok, result)
    except Exception:
        logger.error('Could not save task %s result; review before retrying.', task.id)


def poll_once(store, submit, *, dry_run=False):
    if dry_run:
        rows = store.due_preview()
        logger.info('[preview] %d due task(s); no rows claimed and no calls made', len(rows))
        return len(rows)
    tasks = store.claim_due()
    for task in tasks:
        submit(run_task, store, task)
    return len(tasks)


def main():
    logging_utils.configure_logging()
    config = load_config()
    mode = config.get('DELIVERY_MODE', 'log')
    if mode not in ('log', 'call'):
        raise ValueError('DELIVERY_MODE must be log or call.')
    # Set explicitly so the delivery worker uses the same mode as the scheduler.
    os.environ['DELIVERY_MODE'] = mode
    poll_seconds = float(config.get('SCHEDULER_POLL_SECONDS', '5'))
    if poll_seconds <= 0:
        raise ValueError('SCHEDULER_POLL_SECONDS must be positive.')
    store, stop = TaskStore(), Event()
    logger.info('Scheduler started in %s mode', mode)
    # Never requeue in-progress rows automatically: a prior call may have connected.
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix='mango-delivery') as workers:
        try:
            while True:
                poll_once(store, workers.submit, dry_run=mode == 'log')
                if stop.wait(poll_seconds):
                    break
        except KeyboardInterrupt:
            logger.info('Scheduler stopping; waiting for calls already started.')


if __name__ == '__main__':
    main()
