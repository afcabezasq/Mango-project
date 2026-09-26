# Mango

Mango is an AI secretary for personal and business phone calls, built on [Guava](https://goguava.ai/docs). It answers calls, takes messages, and delivers them to their recipients by phone.

## Repository layout

| Folder | Stack | What it does |
|---|---|---|
| [Listener/](Listener/) | TypeScript, Node 24 | Inbound agent. Answers calls with a personal or business profile, collects messages and appointment requests, and writes private call reports. It can also place one authorized outgoing call. See [Listener/README.md](Listener/README.md). |
| [Caller/](Caller/) | Python 3.11+, uv | Message delivery. An intake agent saves messages with a delivery time to SQLite, and a scheduler calls each recipient when their message is due. See [Caller/README.md](Caller/README.md). |
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
npm ci
npm run preflight   # offline config check
npm test
guava run .         # prints a WebRTC test link
```

### Caller

```bash
cd Caller
uv sync
uv run python main.py phone    # intake service
uv run python scheduler.py     # delivery scheduler, in a second terminal
```

Set `DELIVERY_MODE=log` on the scheduler to test without calling anyone.

### FrontEnd

```bash
cd FrontEnd
npm ci
npm run ui          # http://localhost:3000
```

The server reads a `.env` file from `FrontEnd/` or `FrontEnd/ui/`:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_SCOPES` | OAuth scopes (defaults to profile, Calendar and Gmail) |
| `MANGO_AGENT_NUMBER` | Guava phone number shown in the UI |

## Local data and secrets

These stay on your machine and are ignored by Git:

- `.env` files
- `guava.toml` (Guava project and organization settings)
- `.mango-data/` (call reports and Google OAuth tokens)
- `*.db` (the Caller task queue)
- `profiles/*.local.json` (private Listener profile overrides)

Call reports, task databases and logs contain caller names and phone numbers. Do not commit or publish them.
