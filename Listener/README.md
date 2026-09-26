# Mango

**Current Python listener:** see [INTEGRATION.md](INTEGRATION.md) for the inbound → Supabase handoff and Google Calendar through Archery's UI. With `pyproject.toml` present, `guava run .` selects Python; `guava run . -- --check` has been verified offline. The TypeScript files below remain as the previous iteration for reference.

Mango is an AI secretary for personal and business calls, built in **TypeScript** on Guava. It answers inbound calls, collects messages and appointment requests, and can place one explicitly authorized outgoing call to a named recipient.

**First iteration: implemented and partially verified — 2026-09-26.** Type checking, 14 offline tests, both profile preflights, production dependency loading, and a live WebRTC listener check passed. No Mango conversation, real phone call, or cloud deployment has been tested.

## Start locally

Install Node 24 and the Guava CLI using the official documentation below, complete `guava login`, then run these commands from the repository root:

```bash
npm ci
npm run preflight                 # Offline; no call or connection
npm run check
npm test                          # SDK mocks; no paid test sessions
guava run .                       # Prints a temporary WebRTC link
```

Open the printed link and begin a conversation only when ready to use Guava minutes. **Ctrl-C** stops the local agent. Keep just one instance running. Speech and dialog processing happen in Guava's cloud, even with local code.

Dependencies are pinned in `package-lock.json`: Guava TypeScript SDK **0.35.0** and `tsx` **4.23.15**, running on Node **24**. This iteration was checked with Guava CLI **0.45.0**. With no `guava.toml`, `guava run .` infers Node from `package.json`.

## Choose and configure a profile

```bash
guava run . -- --profile profiles/personal.json
guava run . -- --profile profiles/business.json
```

Each process uses exactly one profile; callers cannot select the other profile. The business name is **Mango Industries** and the assistant is **Mango**. The supplied profiles contain no invented owner details or business facts. Configure `ownerName`, `organization` when relevant, `approvedFacts` (safe to tell callers), and `instructions`.

For private local customization, copy a profile to `profiles/personal.local.json` or `profiles/business.local.json` without overwriting an existing file, then pass that path with `--profile`. Those filenames are ignored by Git. Never put passwords or API keys in a profile. Git ignore rules are **not** a deployment upload exclusion policy; review local files before approving deployment.

Mango identifies itself as AI, asks one question at a time, and confirms important details. It takes requests and records what needs owner review. It has **no calendar, email, SMS, payment, or transfer integration** and must not claim to book, send, pay, or promise a callback. For outbound calls, it verifies the named recipient before providing the task or approved facts; voicemail gets no message and there are no automatic retries. This is conversational recipient confirmation, not strong identity authentication; use caller-safe facts only.

## Phone calls — only after owner approval

Check owned numbers with `guava numbers list`. Replace example numbers below with the authorized owned number and intended recipient. Check credits/billing first; the Free plan does not establish outbound registration or remaining allowance.

Inbound listener:

```bash
GUAVA_AGENT_NUMBER=+15555550123 guava run . -- --mode phone --profile profiles/business.json
```

Then dial the owned number from a real phone. The laptop must stay awake and online. No deployment or tunnel is necessary.

A single **real outgoing call** (requires Guava Outbound Dialing Registration approval and an identified owner/organization in the profile):

```bash
GUAVA_AGENT_NUMBER=+14849622356 guava run . -- \
  --mode outbound --profile profiles/personal.local.json \
  --to +15555550124 --recipient "Taylor" \
  --objective "Ask whether a repair appointment is available on Friday; record options for my review." \
  --confirm-dial
```

`--confirm-dial` confirms the operator authorized this specific call and usage. Add `--check` to validate without connecting or dialing. There is no campaign or bulk calling. Review any prior report's `doNotCall` before authorizing a later call; this starter does not maintain a persistent contact suppression service.

Other cloud-backed test modes, also requiring usage approval:

```bash
guava run . -- --mode local        # Immediately starts microphone audio
guava run . -- --mode chat         # Guava text test session
```

## Code and reports

| File | Purpose |
|---|---|
| `main.ts` | Entrypoint and channel dispatch. |
| `src/mango.ts` | Mango behavior, tasks, fields, and call handlers. |
| `profiles/*.json` | Owner-approved personal/business context. |
| `src/config.ts` | Profile validation and outbound launch checks. |
| `src/reports.ts` | Atomic private local JSON call reports. |
| `tests/mango.test.ts` | Offline behavior/configuration/report tests. |
| `package.json`, `package-lock.json`, `tsconfig.json` | Runtime, pinned dependencies, and TypeScript configuration. |
| `guava.toml` (local only) | Guava project/organization and Node 24 deployment settings; ignored by Git and not included in a clone. |
| `guava-docs.md` | Official coding-agent reference supplied by the CLI. |

Reports go to `.mango-data/`, with owner-only directory/file permissions. They contain contact details and should stay private. Reports distinguish partial from completed tasks, record call outcome/next action when collected, and preserve termination/opt-out information. Nothing sends these reports to the owner yet.

The SDK uses the existing CLI login; no manual API key is needed. Optional `GUAVA_API_KEY` is an alternative for other environments. `GUAVA_AGENT_NUMBER` supplies the owned phone number; `MANGO_REPORT_DIR` changes report storage. `.env` is **not** automatically loaded. No separate OpenAI or Twilio key is required.

## Managed deployment — prepared, not launched

Local config uses `node-sandbox:24`, one `guava-seed` replica, inbound direction, and healthchecks. `tsx` is a production dependency; an isolated `npm ci --omit=dev` plus entrypoint preflight passed. Cloud build/runtime and hosting cost are unverified. Guava status confirms no active deployment.

After approval to upload the project and use hosting:

```bash
guava deploy up .
guava deploy status .
guava deploy logs . -n 100
guava deploy build-logs .
guava deploy changed .
guava deploy down .                # Stop hosting; do not use purge for normal stopping
```

Default hosting listens on WebRTC with the personal profile. For hosted inbound phone calls, deliberately configure `phone_number` in `guava.toml` before deploying; Guava supplies `GUAVA_AGENT_NUMBER` and `GUAVA_HEALTH_SERVER`, which selects phone mode. Hosting does not initiate outgoing calls. The default deployed profile is `profiles/personal.json`; deliberately adjust that profile or the default profile path for a business deployment.

Managed reports default to `/tmp/mango-reports` and are **ephemeral**. Durable report delivery/storage is needed before relying on unattended hosting. Local terminal logs and cloud logs may contain caller information; do not publish them.

## Official references

[Coding-agent starter](https://goguava.ai/docs/coding-agent-starter.md), [quickstart](https://goguava.ai/docs/quickstart), [CLI and Node deployment](https://goguava.ai/docs/cli-reference), [call channels](https://goguava.ai/docs/agent), [recipient verification](https://goguava.ai/docs/reach-person), [outbound prerequisites](https://goguava.ai/docs/outbound-and-sms-permissions), [hosting](https://goguava.ai/docs/deployment).
