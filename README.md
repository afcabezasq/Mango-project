# Mango

Mango is an AI secretary for personal and business phone calls, built on [Guava](https://goguava.ai/docs). It answers calls, takes messages, and delivers them to their recipients by phone.

## Repository layout

| Folder | Stack | What it does |
|---|---|---|
| [Listener/](Listener/) | Python 3.11+, uv | Inbound Mango agent. Saves confirmed phone-message requests to Supabase and books confirmed appointments using the account connected in the frontend. See [Listener/INTEGRATION.md](Listener/INTEGRATION.md). The previous TypeScript iteration is retained. |
| [Caller/](Caller/) | Python 3.11+, uv | Scheduler and outbound delivery consuming confirmed Supabase tasks. `Caller/main.py` delegates intake to the canonical Listener. |
| [FrontEnd/](FrontEnd/) | Node 24, plain HTML/CSS/JS | Web UI and a small Node server. Handles Google sign-in (Calendar and Gmail scopes) and serves the dashboard. |
| [Data/](Data/) | Supabase (Postgres) | Database migrations in `Data/supabase/migrations/`. |

## Prerequisites

- Node 24
- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- The [Guava CLI](https://goguava.ai/docs/cli-reference), logged in with `guava login`
- A Guava phone number (with outbound calling enabled for deliveries)
- For the frontend, a Google OAuth client

## Getting started

### Listener

```bash
cd Listener
uv sync
guava run . -- --check   # offline config check
uv run python -m unittest discover -s tests -p 'test_python*.py' -v
guava run .         # prints a WebRTC test link
```

### Caller

```bash
cd Caller
uv sync
DELIVERY_MODE=log guava run . -- scheduler   # read-only preview; no rows changed
# When ready to permit real calls:
DELIVERY_MODE=call guava run . -- scheduler
```

Run one inbound listener. The scheduler defaults to read-only preview. Enable call mode only when ready for outbound usage. See [INTEGRATION.md](Listener/INTEGRATION.md) for the full booking → Supabase → reminder flow and private calendar reads.

### FrontEnd

```bash
cd FrontEnd
npm ci
npm run ui          # http://localhost:3000
```

All services read root `.env`, then `FrontEnd/.env` and `FrontEnd/ui/.env`; process environment takes priority:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_SCOPES` | OAuth scopes (defaults to profile, Calendar and Gmail) |
| `MANGO_AGENT_NUMBER` | Guava phone number shown in the UI |

## Local data and secrets

Keep local credentials and data out of Git. The root `.env` is already tracked upstream and must be rotated/untracked by the owners; ignore rules only protect new untracked files:

- `.env` files
- `guava.toml` (Guava project and organization settings)
- `.mango-data/` (call reports and Google OAuth tokens)
- `*.db` (the Caller task queue)
- `profiles/*.local.json` (private Listener profile overrides)

Call reports, task databases and logs contain caller names and phone numbers. Do not commit or publish them.
