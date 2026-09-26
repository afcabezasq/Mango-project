# waitlist-agent

A [Guava](https://goguava.ai/docs) voice agent that takes messages over the phone and delivers each one to its recipient with a call at the time the caller chose.

## How it works

The system runs as two services that share a SQLite database (`tasks.db`):

```
caller ──► intake service (main.py) ──► tasks.db ──► scheduler service (scheduler.py)
                                                           │
                                                           └─► one delivery agent per due task ──► recipient's phone
```

1. **Intake service** ([main.py](main.py)) answers calls to the Guava number. For each message it collects:
   - the recipient's full name
   - the recipient's phone number
   - the message itself
   - when to deliver it: a clock time ("6:30 pm"), a delay ("in 10 minutes") or "now"

   If the phone number is invalid, or the time is unclear or in the past, it asks again. It then reads the details back, including the exact delivery time, and saves the task only once the caller confirms. After that it asks whether the caller wants to leave another message, so one call can create several tasks.

2. **Task store** ([task_store.py](task_store.py)) keeps every task in `tasks.db` with its status: `pending`, `running`, `done` or `failed`, plus the result of the delivery.

3. **Scheduler service** ([scheduler.py](scheduler.py)) checks the database every few seconds. For each task that is due, it marks the task `running` and starts a separate worker for it, so deliveries run in parallel. When it starts, it puts back in the queue any task left `running` by a previous run.

4. **Delivery agent** ([delivery_agent.py](delivery_agent.py)) is a new Guava agent created for each task. It calls the recipient, checks it is speaking to the right person, and reads the message on behalf of the sender. If voicemail answers, it leaves the message there. The outcome of the call is stored on the task: delivered, recipient unavailable, or call failed.

## Configuration

The phone number, sender name and organization are in [constants.py](constants.py).

| Environment variable | Default | Purpose |
|---|---|---|
| `GUAVA_API_KEY` | — | Guava API key (the Guava CLI handles this after `guava login`) |
| `GUAVA_AGENT_NUMBER` | the number in `constants.py` | Guava number that receives the incoming calls and places the delivery calls |
| `DELIVERY_MODE` | `call` | Set to `log` to write deliveries to the log instead of making calls |
| `SCHEDULER_POLL_SECONDS` | `5` | How often the scheduler checks for due tasks |
| `TASK_TIMEZONE` | server's local time | Timezone for delivery times, e.g. `America/Bogota` (on Windows, install `tzdata`) |

The Guava number must have outbound calling enabled for deliveries to work.

## Running

Start both services, each in its own terminal:

```bash
python main.py phone    # intake: answer real calls on the Guava number
python scheduler.py     # scheduler: deliver tasks when they are due
```

`main.py` also takes `chat` (type to the intake agent in the terminal) or `local` (talk to it with your microphone and speakers). Either way, the scheduler service delivers what gets saved.

To test without calling anyone, start the scheduler in dry-run mode:

```bash
DELIVERY_MODE=log python scheduler.py
```

## Notes

- Both services must use the same `tasks.db`, so run them on the same machine. To run them on different machines, or to deploy the intake agent with `guava deploy`, replace the SQLite store with a shared database.
- Tasks are only delivered while the scheduler is running. Tasks that come due while it is stopped go out as soon as it starts again.
- Stopping the scheduler cuts off any delivery call in progress. That task is called again the next time the scheduler starts.
