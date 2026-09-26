/** Google Calendar account linking for the local Mango app. No booking or Guava call is started. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { CodeChallengeMethod, OAuth2Client, type TokenPayload } from "google-auth-library";

export const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const GOOGLE_CALENDAR_SCOPES = ["openid", "email", CALENDAR_LIST_SCOPE];
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const DEFAULT_STORAGE = ".mango-data/google-calendar";

export class CalendarLinkError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export type GoogleCalendarConfig = {
  clientId: string;
  clientSecret: string;
  /** Optional project API key. OAuth user consent is still required. */
  apiKey?: string;
  storageDirectory?: string;
};
export type CalendarSummary = {
  id: string;
  summary: string;
  timeZone?: string;
  accessRole?: string;
  primary: boolean;
};
type SavedConnection = {
  version: 1;
  clientId: string;
  account: { id: string; email: string };
  calendar: CalendarSummary;
  refreshToken: string;
  linkedAt: string;
};
export type GoogleCalendarConnection = {
  account: { id: string; email: string };
  calendar: CalendarSummary;
  /** Returns metadata only; never returns OAuth tokens or event details. */
  listCalendars(): Promise<CalendarSummary[]>;
};
export type CalendarLinkSession = {
  authorizationUrl: string;
  completed: Promise<GoogleCalendarConnection>;
  cancel(): void;
};

function validateConfig(config: GoogleCalendarConfig) {
  if (!config.clientId?.trim() || !config.clientSecret?.trim()) {
    throw new CalendarLinkError("CONFIG", "Google Calendar requires a Desktop app OAuth client ID and client secret. An API key alone cannot authorize a private calendar.");
  }
}

function normalizedEmail(email: string) {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new CalendarLinkError("CONFIG", "Provide the Google account's full email address.");
  }
  return value;
}

/** Supports Google's downloaded Desktop app JSON, or explicit OAuth environment settings. */
export function readGoogleCalendarConfig(env: NodeJS.ProcessEnv): GoogleCalendarConfig {
  let clientId = env.GOOGLE_CLIENT_ID;
  let clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (env.GOOGLE_OAUTH_CLIENT_FILE) {
    try {
      const data = JSON.parse(readFileSync(env.GOOGLE_OAUTH_CLIENT_FILE, "utf8"));
      if (typeof data?.installed?.client_id !== "string" || typeof data?.installed?.client_secret !== "string") throw new Error();
      clientId = data.installed.client_id;
      clientSecret = data.installed.client_secret;
    } catch {
      throw new CalendarLinkError("CONFIG", "GOOGLE_OAUTH_CLIENT_FILE must be a readable Google Desktop app OAuth JSON file.");
    }
  }
  const config = {
    clientId: clientId ?? "", clientSecret: clientSecret ?? "",
    apiKey: env.GOOGLE_API_KEY || undefined,
    storageDirectory: env.MANGO_GOOGLE_DATA_DIR || DEFAULT_STORAGE,
  };
  validateConfig(config);
  return config;
}

function oauthClient(config: GoogleCalendarConfig, redirectUri?: string) {
  // Do not set OAuth2Client.apiKey: it can fall back to key-only auth instead of refreshing OAuth.
  return new OAuth2Client({
    clientId: config.clientId, clientSecret: config.clientSecret, redirectUri,
    transporterOptions: { timeout: 15_000 },
  });
}

function connectionPath(config: GoogleCalendarConfig, accountId: string) {
  // Google's verified sub is the account identity; emails and calendar titles are not pathnames.
  const name = createHash("sha256").update(`${config.clientId}\0${accountId}`).digest("hex");
  return join(config.storageDirectory ?? DEFAULT_STORAGE, `${name}.json`);
}

function saveConnection(config: GoogleCalendarConfig, record: SavedConnection) {
  const directory = config.storageDirectory ?? DEFAULT_STORAGE;
  let temporary: string | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error();
    temporary = join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, connectionPath(config, record.account.id));
  } catch {
    throw new CalendarLinkError("STORAGE", "Could not save the Google connection. Use a private directory owned by your user (mode 700).");
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
  }
}

async function listCalendars(client: OAuth2Client, apiKey?: string): Promise<CalendarSummary[]> {
  const calendars: CalendarSummary[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  try {
    do {
      const { data } = await client.request<{
        items?: Array<{ id?: string; summary?: string; timeZone?: string; accessRole?: string; primary?: boolean; deleted?: boolean }>;
        nextPageToken?: string;
      }>({
        url: CALENDAR_LIST_URL, method: "GET", timeout: 15_000,
        // Keep the optional API key out of URLs and out of the OAuth credential object.
        headers: apiKey ? { "X-Goog-Api-Key": apiKey } : undefined,
        params: { maxResults: 250, pageToken, fields: "items(id,summary,timeZone,accessRole,primary,deleted),nextPageToken" },
      });
      for (const item of data.items ?? []) {
        if (!item.deleted && typeof item.id === "string" && item.id) {
          calendars.push({ id: item.id, summary: item.summary ?? "Untitled calendar", timeZone: item.timeZone, accessRole: item.accessRole, primary: item.primary === true });
        }
      }
      pageToken = data.nextPageToken;
      if (pageToken) {
        if (seen.has(pageToken) || seen.size >= 100) throw new Error();
        seen.add(pageToken);
      }
    } while (pageToken);
    return calendars;
  } catch {
    // Google errors may contain request headers/tokens; never forward raw errors to logs or Guava.
    throw new CalendarLinkError("GOOGLE_API", "Google could not list calendars. Check that Calendar API is enabled and consent is granted; relink if access expired or was revoked.");
  }
}

function publicConnection(config: GoogleCalendarConfig, record: SavedConnection, client: OAuth2Client): GoogleCalendarConnection {
  client.on("tokens", tokens => {
    if (tokens.refresh_token) {
      record.refreshToken = tokens.refresh_token;
      saveConnection(config, record);
    }
  });
  return {
    account: { ...record.account }, calendar: { ...record.calendar },
    listCalendars: () => listCalendars(client, config.apiKey),
  };
}

/** Reuses a stored refresh token. Only later API calls contact Google; there is no browser here. */
export function loadGoogleCalendarConnection(config: GoogleCalendarConfig, accountId: string): GoogleCalendarConnection {
  validateConfig(config);
  try {
    const path = connectionPath(config, accountId);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error();
    const record = JSON.parse(readFileSync(path, "utf8")) as SavedConnection;
    if (record.version !== 1 || record.clientId !== config.clientId || record.account?.id !== accountId ||
        typeof record.account.email !== "string" || typeof record.refreshToken !== "string" || !record.refreshToken ||
        typeof record.calendar?.id !== "string") throw new Error();
    const client = oauthClient(config);
    client.setCredentials({ refresh_token: record.refreshToken });
    return publicConnection(config, record, client);
  } catch {
    throw new CalendarLinkError("STORAGE", "No valid private Google Calendar connection for this account and OAuth client. Link the account again.");
  }
}

function verifiedAccount(payload: TokenPayload | undefined, nonce: string, expectedAccountId?: string) {
  if (!payload?.sub || !payload.email || payload.email_verified !== true || payload.nonce !== nonce) {
    throw new CalendarLinkError("IDENTITY", "Google did not return a verified matching sign-in. Start linking again.");
  }
  normalizedEmail(payload.email);
  // login_hint may be an alternate address (including Proton). The signed Google sub is identity.
  if (expectedAccountId && payload.sub !== expectedAccountId) {
    throw new CalendarLinkError("WRONG_ACCOUNT", "You signed in to a different Google account than the one being reconnected. Restart and choose the linked account.");
  }
  return { id: payload.sub, email: payload.email };
}

function sameState(actual: string | null, expected: string) {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}

/**
 * Starts a short-lived callback listener on 127.0.0.1, suitable for a local Desktop OAuth client.
 * The caller presents authorizationUrl in the user's browser and awaits completed. No password is accepted.
 * This is owner setup, not a phone-call handler or a hosted multi-user login service.
 */
export async function startGoogleCalendarLink(
  config: GoogleCalendarConfig,
  options: { email: string; calendarId?: string; timeoutMs?: number; expectedAccountId?: string },
): Promise<CalendarLinkSession> {
  validateConfig(config);
  const email = normalizedEmail(options.email);
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new CalendarLinkError("CONFIG", "Sign-in timeout must be between 1 millisecond and 10 minutes.");
  }
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  let settled = false;
  let claimed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolve!: (value: GoogleCalendarConnection) => void;
  let reject!: (error: CalendarLinkError) => void;
  const completed = new Promise<GoogleCalendarConnection>((yes, no) => { resolve = yes; reject = no; });
  // A caller can attach its UI before awaiting completed without an unhandled rejection on timeout.
  void completed.catch(() => {});
  const server = createServer();
  const finish = (error?: CalendarLinkError, connection?: GoogleCalendarConnection) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    if (error) reject(error); else resolve(connection!);
  };
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", no); yes(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const origin = `http://127.0.0.1:${address.port}`;
    const redirectUri = `${origin}/oauth2callback`;
    const client = oauthClient(config, redirectUri);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline", scope: GOOGLE_CALENDAR_SCOPES,
      prompt: "consent select_account", login_hint: email, state, nonce,
      code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
    });
    server.on("error", () => finish(new CalendarLinkError("LISTENER", "Local Google sign-in listener failed. Restart linking.")));
    server.on("request", (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", origin);
        if (request.method !== "GET" || request.headers.host !== address.address + ":" + address.port || url.pathname !== "/oauth2callback") {
          reply(response, 404, "Not found."); return;
        }
        if (settled || claimed) { reply(response, 409, "This sign-in request has already been used."); return; }
        if (url.searchParams.getAll("state").length !== 1 || !sameState(url.searchParams.get("state"), state)) {
          reply(response, 400, "Sign-in state did not match. Return to the original Google sign-in page."); return;
        }
        claimed = true;
        if (url.searchParams.has("error")) {
          throw new CalendarLinkError("DECLINED", "Google sign-in was cancelled or permission was denied. No calendar was linked.");
        }
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.getAll("code").length !== 1) {
          throw new CalendarLinkError("CALLBACK", "Google did not return a valid authorization code. Restart linking.");
        }
        const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
        if (settled) return;
        if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
          throw new CalendarLinkError("CONSENT", "Google did not grant a reusable sign-in. Restart linking and grant the requested access.");
        }
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
        if (settled) return;
        const account = verifiedAccount(ticket.getPayload(), nonce, options.expectedAccountId);
        const scopes = tokens.scope?.split(" ") ?? (await client.getTokenInfo(tokens.access_token)).scopes;
        if (settled) return;
        if (!scopes.includes(CALENDAR_LIST_SCOPE)) {
          throw new CalendarLinkError("SCOPE", "Google Calendar list permission was not granted. No calendar was linked.");
        }
        client.setCredentials(tokens);
        const calendars = await listCalendars(client, config.apiKey);
        const calendar = !options.calendarId || options.calendarId === "primary"
          ? calendars.find(item => item.primary)
          : calendars.find(item => item.id === options.calendarId);
        if (!calendar) throw new CalendarLinkError("CALENDAR", "The selected calendar is not in this Google account's accessible calendar list.");
        if (settled) return; // A timed-out/cancelled exchange must never save credentials later.
        const record: SavedConnection = { version: 1, clientId: config.clientId, account, calendar, refreshToken: tokens.refresh_token, linkedAt: new Date().toISOString() };
        saveConnection(config, record);
        reply(response, 200, "Google Calendar linked to Mango. You can close this tab and return to the terminal.");
        finish(undefined, publicConnection(config, record, client));
      })().catch(error => {
        const safe = error instanceof CalendarLinkError ? error : new CalendarLinkError("GOOGLE_AUTH", "Google sign-in could not be completed. Check the Desktop OAuth client, consent settings, and network, then retry.");
        if (!response.headersSent && !response.destroyed) reply(response, 400, safe.message);
        finish(safe);
      });
    });
    timer = setTimeout(() => {
      finish(new CalendarLinkError("TIMEOUT", "Google sign-in expired. Start linking again."));
      server.closeAllConnections();
    }, timeoutMs);
    return {
      authorizationUrl, completed,
      cancel() {
        finish(new CalendarLinkError("CANCELLED", "Google sign-in was cancelled. No new calendar connection was saved."));
        server.closeAllConnections();
      },
    };
  } catch {
    server.close();
    server.closeAllConnections();
    throw new CalendarLinkError("LISTENER", "Could not start the local Google sign-in listener.");
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    email: { type: "string" }, calendar: { type: "string", default: "primary" },
    check: { type: "boolean", default: false }, help: { type: "boolean", default: false },
  }});
  if (values.help) {
    console.log("npm run calendar:link -- --email you@example.com [--calendar primary] [--check]\nConfigure GOOGLE_OAUTH_CLIENT_FILE (Desktop app JSON), or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. GOOGLE_API_KEY is optional. Never supply a Google password. --check is offline.");
    return;
  }
  const config = readGoogleCalendarConfig(process.env);
  const email = normalizedEmail(values.email ?? "");
  if (values.check) { console.log("Google Calendar configuration shape is valid. Credentials and account access have not been tested. No connection made."); return; }
  const session = await startGoogleCalendarLink(config, { email, calendarId: values.calendar });
  const cancel = () => session.cancel();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    console.log("Open this Google sign-in URL in your browser on this computer. Choose the requested account and approve calendar-list access:");
    console.log(session.authorizationUrl);
    const connection = await session.completed;
    console.log(`Linked ${connection.account.email} to ${connection.calendar.summary}. Google account ID: ${connection.account.id}`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof CalendarLinkError ? error.message : "Calendar linking failed. Run with --help for configuration instructions.");
    process.exitCode = 1;
  });
}
