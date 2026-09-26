# Mango reminder delivery

The Python listener saves confirmed messages and calendar reminders to the shared Supabase `public.tasks` table. This folder polls for due reminders and delivers them through Guava. See [the full integration guide](../Listener/INTEGRATION.md) for Google consent, calendar access codes and recovery.

```bash
# Read-only queue preview:
DELIVERY_MODE=log guava run . -- scheduler
# After authorizing real outbound calls:
DELIVERY_MODE=call guava run . -- scheduler
```

`guava run` supplies CLI authentication. `uv run python scheduler.py` also works if Guava credentials are already configured in the environment. Ctrl-C stops polling and waits for active calls.

`main.py phone`, `main.py chat`, and `main.py local` are compatibility launchers for the canonical calendar-aware `Listener/main.py`. Run only one inbound listener.

The scheduler defaults to read-only preview. Call mode uses conditional `pending` → `in_progress` claims and saves `done`/`failed` with the outcome. It retains completed rows for review. It never automatically requeues an interrupted call, since that could call someone twice. Review in-progress or failed rows against Guava call history before retrying.

Configuration comes from the repository's `.env` and process environment. `GUAVA_AGENT_NUMBER` (or `MANGO_AGENT_NUMBER`) is the owned number used for outbound calls. `SENDER_NAME` defaults to Mango; `ORGANIZATION` to Mango Industries. `SCHEDULER_POLL_SECONDS` defaults to 5. Calls can incur Guava usage; running the preview does not call anyone or modify queued tasks.
