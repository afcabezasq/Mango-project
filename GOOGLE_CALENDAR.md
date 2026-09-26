# Google Calendar linking for Mango users

**Implemented and partially verified.** The standalone TypeScript module is `src/google-calendar.ts`. It accepts any user's Google account email, including Gmail, Proton addresses, and custom domains. No account is hardcoded. This connects **Google Calendar**, with Google sign-in; it does not access Proton Mail or a calendar hosted by Proton.

An ordinary personal Gmail account works; a paid Google Workspace subscription is not required for this linking flow. Open [Google Calendar](https://calendar.google.com/) once with the intended account to make sure its calendar is available. The examples below use Gmail.

A Google account can be created with an existing Proton email address, without creating a Gmail mailbox. A Proton address can also be an alternate sign-in for an existing Google account. Google may return that account's canonical primary email after sign-in. The module uses the verified Google account ID (`sub`) as the connection identity; typed emails are sign-in hints, not proof of account ownership.

Proton's paid-plan requirement applies to [sharing a calendar hosted by Proton through a link](https://proton.me/support/share-calendar-via-link). This module does not use that feature. A Proton email address by itself is not a Google account; it must first be registered with Google. Creating a new Gmail account is an alternative, not a prerequisite for someone who already has a Google account.

## Credentials the application needs

- A Google Cloud project with **Google Calendar API enabled**.
- A Google OAuth consent configuration and **Desktop app OAuth client**, including client ID and client secret.
- Optionally, a Google API key (`GOOGLE_API_KEY`). The key identifies the project; it cannot replace user consent or authorize a private calendar. If supplied, it is sent only on Calendar API requests, in a header.
- Each user grants consent in their own Google browser session. Mango never accepts a Google or Proton password.

This local iteration requests only `openid`, `email`, and `calendar.calendarlist.readonly`. It can link/select a calendar and list calendar metadata. It cannot read event contents, inspect availability, create events, or send invitations. Those are separate future permissions and functions.

## One-time developer setup

1. In [Google Cloud Console](https://console.cloud.google.com/), select the app's project. Open **APIs & Services → Library → Google Calendar API → Enable**.
2. Open **Google Auth platform → Branding** and configure the app identity/support email. For consumer accounts such as Gmail or users registered with a Proton address, configure **Audience → External**. During testing, add each intended Google account under **Test users**, including any newly created Gmail account. Do not configure the app for only the developer's own account.
3. Under **Data Access**, configure the identity/email and read-only calendar-list scopes above. Users must grant calendar-list permission when consenting.
4. Under **Clients → Create client → Desktop app**, create the client and download its JSON. Store it locally at `.mango-data/google-oauth-client.json`, outside Git. Keep the file readable only by the local user; do not paste credentials into chat or source code.
5. Copy `.env.example` to `.env` without overwriting an existing file, and set `GOOGLE_OAUTH_CLIENT_FILE` to that JSON file. This setting takes precedence over `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; those two environment variables are an alternative to a file. Leave the optional `GOOGLE_API_KEY` blank unless the app supplies one.

`npm run calendar:link` explicitly loads `.env` using Node. The voice-agent command continues to use its existing environment behavior. `.mango-data`, `.env`, `credentials.json`, `token.json`, and `client_secret_*.json` are ignored by Git.

## Link any user's Google Calendar

From the repository root:

```bash
# Offline configuration shape check; does not validate credentials with Google:
npm run calendar:link -- --email someone@gmail.com --check

# Starts a five-minute local sign-in session:
npm run calendar:link -- --email someone@gmail.com
```

Replace the example address with the current user's sign-in email. Open the printed Google URL **in a browser on the same computer**, choose the intended account, review the permissions, and approve calendar-list access. Google handles any password/MFA. The success page says the calendar was linked. The terminal reports the verified account and selected calendar, never tokens.

The primary calendar is selected by default. Pass `--calendar '<calendar-id>'` to select another accessible calendar. Ctrl-C cancels linking; a pending sign-in expires after five minutes. Existing successful connections remain intact on failure or cancellation. Unsuccessful sign-in can still have granted Google consent; the user can remove it in their Google account's third-party access settings.

## Import the separate module

```typescript
import {
  readGoogleCalendarConfig,
  startGoogleCalendarLink,
  loadGoogleCalendarConnection,
} from "./src/google-calendar.ts";

const config = readGoogleCalendarConfig(process.env);
const session = await startGoogleCalendarLink(config, {
  email: currentUserEmail, // runtime input; Gmail, Proton, or another Google account address
  calendarId: "primary",
  // On relinking, optionally pin the Google ID already bound to this Mango user:
  // expectedAccountId: previouslyLinkedGoogleAccountId,
});

// Present session.authorizationUrl to the current user in their local browser.
const connection = await session.completed;
// Associate connection.account.id with the authenticated Mango user in your app.
const calendars = await connection.listCalendars();

// Later, on the same installation:
const restored = loadGoogleCalendarConnection(config, connection.account.id);
const refreshedCalendarList = await restored.listCalendars();
```

`startGoogleCalendarLink` returns the authorization URL, a completion promise, and `cancel()`. A successful result exposes account identity, selected calendar metadata, and `listCalendars()`. It never returns credentials. Google Auth Library handles OAuth token exchange, ID-token signature/issuer/audience/expiry verification, and access-token refresh. The module checks OAuth state, PKCE, the sign-in nonce, granted Calendar scope, and optional expected account ID.

Connections are saved separately per OAuth client and verified Google account ID in `.mango-data/google-calendar/`: directory mode **700**, file mode **600**, atomic writes. Only the refresh token and connection metadata persist; API keys, client secrets, access tokens, and ID tokens are not copied into connection files. This is private local filesystem storage, **not encrypted multi-user server storage**. Changing `MANGO_GOOGLE_DATA_DIR` requires a private location and an appropriate Git/deployment exclusion.

The temporary callback listener binds only to `127.0.0.1` on an available port and closes on completion, denial, timeout, or cancellation. Tokens, callback codes, calendar URLs, and raw Google errors should never be included in Guava call logs or `call.addInfo()`.

## Guava boundary and remaining verification

This module is deliberately independent of the voice agent. Link the owner's account during setup. Guava's `onQuestion`, `onActionRequest`, and `onAction` callbacks are the documented places to call a future authorized calendar service; no browser authentication should run inside a phone conversation. Nothing in `main.ts` or `src/mango.ts` has been changed to fetch or expose calendar information.

Offline tests use mocked Google responses and real loopback HTTP callbacks. They cover Gmail, Proton primary/alternate emails, multiple accounts, pagination, consent/state/identity failures, cancellation, and private storage. No real account has been linked or accessed. A real integration test still requires developer OAuth configuration and a user's browser consent.

For a hosted multi-user app, use Google's **Web application** OAuth flow with HTTPS callbacks, authenticated Mango sessions, a per-user authorization mapping, and protected server-side token storage. The local Desktop flow is not a hosted login endpoint. Testing-mode Google consent and refresh-token limits also apply; review Google's OAuth documentation before public release.

## Official documentation used

- [Google account with a non-Gmail address](https://support.google.com/accounts/answer/27441)
- [Google Calendar Node quickstart](https://developers.google.com/workspace/calendar/api/quickstart/nodejs)
- [Google OAuth for installed apps and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google OpenID Connect identity claims](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [CalendarList API](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)
- [Google Auth Library for Node.js](https://github.com/googleapis/google-auth-library-nodejs)
- [Google web application OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Guava coding-agent starter](https://goguava.ai/docs/coding-agent-starter.md)
- [Guava action request/execute callbacks](https://goguava.ai/docs/on-action-request-execute)
