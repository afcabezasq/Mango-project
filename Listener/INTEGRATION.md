# Calendar events and scheduled phone reminders

**Implemented and partially verified.** This PR targets `main` and includes the Python listener/UI integration from PR #5. It reuses Archery's Google Calendar/Gmail sign-in; no second OAuth flow is introduced.

## Run the three services

From the repository root, start the dashboard:

```bash
npm run ui
```

Open **http://localhost:3000**, sign in with Google, grant Calendar access, and set an **8–12 digit private calendar access code**. The code is required to read event details over the phone. Reconnect if your existing token file predates the verified Google account/expiry fields.

Use the displayed **Call** link or dial Mango directly. The existing **Call Me** endpoint remains a frontend placeholder; it does not initiate the booking flow.

In another terminal:

```bash
cd Listener
guava run . -- --check              # offline configuration check
guava run . -- --mode phone         # answer the owned number from root .env
# Or use: guava run .                # WebRTC testing (Guava usage)
```

In a third terminal:

```bash
cd Caller
DELIVERY_MODE=log guava run . -- scheduler   # read-only queue preview, no calls
# Enable only when ready to allow real outbound calls/usage:
DELIVERY_MODE=call guava run . -- scheduler
```

Ctrl-C stops a service. Scheduler shutdown waits for calls already started. Stop older scheduler versions before enabling the updated one; the older code does not use conditional claims. Do not run duplicate inbound listeners. `Caller/main.py phone` delegates to the same new Listener, so old launch commands cannot use the previous pre-confirmation intake.

## Behavior

- **Book:** caller supplies title, name, start/end with timezone, callback number, and reminder time. Mango asks for the reminder time and defaults to the event start only when accepted. It reads all details back and requires explicit yes.
- **Save:** insert `awaiting_calendar` into Supabase, create/verify the Google event, then transition that exact row to `pending`. A busy slot, invalid time, rejected confirmation, failed database write, or unverified Google response cannot produce a success claim.
- **Deliver:** the scheduler selects due `pending` rows, conditionally claims them as `in_progress`, and hands each won claim to the existing outbound agent. It saves `done`/`failed` and the outcome. Competing schedulers cannot both win the same row. Missed times are delivered when the scheduler next runs; this is a polling service, not a real-time guarantee.
- **Read events:** user supplies a date range (up to 31 days) and their private code. Only after server verification does Mango read titles and times from the connected user's primary calendar. All-day and recurring occurrences are included; if Google returns another page, Mango identifies the result as partial. Wrong codes do not query the calendar. The Guava field is marked sensitive; the code is not repeated or saved in task rows.
- **Phone message:** confirmed standalone messages still enter the same delivery queue, without requiring a calendar event.

## Existing Supabase table (no migration required)

`public.tasks` retains `id`, `caller`, `date`, `task`, and `status`. `date` is the requested **call time in UTC**, not necessarily the appointment start. `task` is a JSON string containing recipient, message, request ID and, for bookings, the Google account ID, deterministic event ID, title and event start/end. OAuth credentials and calendar access codes never go into this table.

States: `awaiting_calendar` → `pending` → `in_progress` → `done` or `failed`. A synthetic, non-deliverable row dated in 2099 verified insertion, held status and conditional update against the shared Supabase project; it was removed and its absence verified. Existing tasks and schema were untouched. The existing publishable key could insert/update this row without user authentication; its table permissions are therefore suitable only for this trusted demo. Before public deployment, restrict table policies and run backend access with a private server key. This PR does not weaken or replace live policies.

There is no distributed transaction between Google and Supabase. An uncertain booking/activation leaves a durable row for review; the scheduler ignores `awaiting_calendar`. Never automatically requeue `in_progress`: the call may already have connected. No automatic retries or deletions occur.

### Recover an uncertain request

1. Stop the listener/scheduler involved and inspect the one task row in Supabase.
2. For `awaiting_calendar`, use the stored Google event ID and account to check whether the exact event exists. If it exists and matches, set the row to `pending` only after confirming the reminder is still wanted. If it does not exist, mark it `failed` and have the caller reconfirm a new request. For an uncertain response, wait/check again; do not blindly book again.
3. For `in_progress`, check Guava's call history. Mark `done`/`failed` based on the outcome. Only reset to `pending` after verifying a repeat call is appropriate.
4. The reminder is a confirmed snapshot. Editing/deleting the event later in Google does not automatically change the Supabase reminder; update/cancel its pending row too.

## Configuration and identity

Root `.env`, then `FrontEnd/.env`, then `FrontEnd/ui/.env` are read; explicit process environment takes priority. Required names: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SUPABASE_URL`, and one Supabase key (`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEY` preferred server-side, or the existing `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_ANON_KEY` with proper table permissions). `GUAVA_AGENT_NUMBER` falls back to `MANGO_AGENT_NUMBER`. `TASK_TIMEZONE` defaults to `America/New_York`. The scheduler defaults to `DELIVERY_MODE=log` (read-only). `SCHEDULER_POLL_SECONDS` defaults to 5.

The original root `.env` is already tracked on `main`; this PR neither republishes its values in new code nor rewrites Git history. Treat credentials previously committed to Git as exposed and rotate them through their providers. Ignore rules prevent newly untracked environment files from being added, but cannot untrack an existing file.

Google requires the Calendar API enabled, the current origin registered on the Web OAuth client, and the intended account allowed by the consent screen. The exact default origin is `http://localhost:3000`; use `PORT`/`MANGO_UI_ORIGIN` consistently for another local port. Google client credentials alone do not grant access: a user must complete consent. Gmail permissions remain available to the existing UI; this change does not send or read mail.

This remains **one connected Google owner per local installation**, with one private token file at `FrontEnd/.mango-data/google_tokens.json`. It is not a hosted multi-tenant service. The UI binds to loopback, checks origin/CSRF headers, and never serves token/config files. Switching or disconnecting Google blocks operations pinned to another account. The code hash is in `FrontEnd/.mango-data/calendar_access.json`, bound to Google `sub`, salted with PBKDF2, and stored with mode 600. Five failed code attempts across calls lock calendar reads for 15 minutes in the running listener process. Use one listener process for this local deployment.

Bookings contain no attendees and request no invitation updates. Availability is rechecked before insertion, but other independent Google Calendar writers can still race.

## Verification

```bash
cd Listener
uv run python -m unittest discover -s tests -p 'test_*.py' -v
cd ..
node --test FrontEnd/tests/*.test.js
```

The 26 Python and 4 Node tests cover real Guava handler registration, UI→Python credentials and access-code hashing, confirmation/decline, custom reminder time, future/due tasks, booking partial failures, concurrent claims, provider error redaction, all-day/calendar pagination, and Google refresh/disconnect. Google and phone transports are mocked; a real Google consent, event and phone call still require a supervised test. No live call or Google event was created during implementation.

Official references: [Guava coding-agent starter](https://goguava.ai/docs/coding-agent-starter.md), [Google popup code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model), [event list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [event creation](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys), [PostgREST conditional updates](https://docs.postgrest.org/en/stable/references/api/tables_views.html).
