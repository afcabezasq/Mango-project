# Python listener + Archery's Google sign-in

**Implemented and partially verified.** This branch builds on `connect-to-supabase`. Our scope is inbound intake, saving confirmed message requests, and confirmed calendar bookings. `Caller/scheduler.py`, outbound delivery, and task removal belong to the other team members and are unchanged.

## Run

```bash
# Repository root: this now starts the canonical FrontEnd/ UI.
npm run ui
# In another terminal:
cd Listener
uv sync
guava run . -- --check                  # Offline, no services contacted
uv run python -m unittest discover -s tests -p 'test_python*.py' -v
# After approving Guava usage:
guava run .                            # Python WebRTC listener
# For an owned inbound phone number, after approving the call:
GUAVA_AGENT_NUMBER=+15555550123 guava run . -- --mode phone
```

Ctrl-C stops either process. Default profile: `profiles/business.json` (Mango / Mango Industries). Use `--profile profiles/personal.json` for personal mode. `TASK_TIMEZONE` defaults to `America/New_York`; collected times require explicit offsets. No outbound mode is present in the Python listener.

## Team handoff

- `main.py`: collect intent and details, read them back, require explicit yes, then perform exactly one write attempt per call round. Failure never claims success or automatically retries an uncertain write.
- `supabase_tasks.py`: uses `Data.db.add_task` from the team's Supabase branch. A message becomes `public.tasks(caller, date, task, status)`, with `status="pending"`, UTC `date`, and a JSON **string** in `task` containing `id`, `recipient_name`, `recipient_phone`, `message`, a readable `task` description, and `result=null`. This matches `Caller/task_store.py`.
- `calendar_service.py`: reads the UI's connected Google account, checks free/busy, and books only after confirmation. A booking writes a Google event; it does **not** enqueue an unwanted outbound confirmation call. `appointments()` is an owner-side read helper (first 20 results plus pagination token); existing event titles are never handed to phone callers.
- `FrontEnd/ui/google-connection.js`: owns token-file format and private writes. Python does not implement another OAuth login. Gmail and non-Gmail Google account emails are handled by Google's UI.

Calendar event IDs are stable per confirmed request, so retries can recover the same event. Availability is rechecked before insert; a local lock prevents simultaneous bookings in this one listener process. Google does not provide atomic free/busy-and-book, so other calendar writers can still race. Do not run duplicate listener instances.

## Google UI configuration

Configure the existing Web application OAuth client in `FrontEnd/.env` (or `FrontEnd/ui/.env`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the existing `GOOGLE_SCOPES`. Enable Google Calendar API, use External consent with intended Google accounts as test users, and grant the full Calendar scope requested by the UI. No Google API key is needed.

Open **http://localhost:3000**, then use its Google sign-in button. Register that exact origin on the Google Web OAuth client. The popup token exchange uses the origin, following Google's current code-model documentation. If using another port, configure `PORT`; `MANGO_UI_ORIGIN` must match the browser's origin. The dashboard now binds to loopback and requires same-origin requests plus the popup's CSRF header.

The UI saves `FrontEnd/.mango-data/google_tokens.json` with mode 600, inside a mode-700 directory. The record contains `user.sub`, `clientId`, actual granted `scopes`, `expiresAt`, and `tokens`. Existing logins created before those fields were added must reconnect through the UI. Python reads the same OAuth client configuration for refresh; refreshed access tokens stay in memory, so Python never overwrites a newer UI login. Disconnecting or switching UI accounts blocks pending bookings. If no refresh token is available, reconnect; if Google still does not issue one, remove the app's old consent in Google account settings and sign in again.

This is one UI-connected owner per local installation, not a hosted multi-user login service. Tokens never go to the browser or Supabase task rows. Bookings contain no attendees and request no invitation updates. The Google OAuth scopes include Gmail for the existing frontend, but our Python code never accesses Gmail.

## Verification and remaining live checks

Offline tests mock Google and Supabase, exercise real Guava handler registration, verify the UI-to-Python token-file contract, confirmation, duplicate callbacks, busy slots, failed writes, refresh, account changes, and disconnect. No real login, calendar event, database row, phone call, or deployment was created.

Still needed: configure the Google Web OAuth client and sign in through the UI; verify the shared Supabase project's `public.tasks` schema and insert permissions; approve a controlled live message/booking test. The supplied Data client uses the team's existing project configuration; this branch does not change grants or fetch Vault secrets for the listener. The scheduler's claim/retry/delete behavior must be reviewed by its owner before real delivery.

Run `Listener/main.py` as the intake for this flow. Do not also start the older `Caller/main.py`: the latest upstream version saves pending tasks before confirmation, whereas this listener waits for explicit approval. A live pending row can be consumed by the teammate's running scheduler; coordinate before testing a write.

Official references: [Guava coding-agent starter](https://goguava.ai/docs/coding-agent-starter.md), [Google popup code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model), [availability API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), [event creation](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Supabase key types and RLS](https://supabase.com/docs/guides/getting-started/api-keys).
