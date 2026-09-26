import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OAuth2Client, LoginTicket, type TokenPayload } from "google-auth-library";
import {
  startGoogleCalendarLink, loadGoogleCalendarConnection, readGoogleCalendarConfig,
  CALENDAR_LIST_SCOPE, CalendarLinkError, type GoogleCalendarConfig, type CalendarLinkSession,
} from "../src/google-calendar.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "mango-calendar-test-"));
  const sessions: CalendarLinkSession[] = [];
  t.after(() => { sessions.forEach(session => session.cancel()); rmSync(directory, { recursive: true }); });
  const config: GoogleCalendarConfig = {
    clientId: "test-client.apps.googleusercontent.com", clientSecret: "fake-client-secret",
    apiKey: "fake-api-key", storageDirectory: directory,
  };
  let email = "person@company.example";
  let subject = "google-user-123";
  let authUrl: URL;
  let exchanged = 0;
  const requests: Array<Record<string, unknown>> = [];
  const originalGenerate = OAuth2Client.prototype.generateAuthUrl;
  t.mock.method(OAuth2Client.prototype, "generateAuthUrl", function(this: OAuth2Client, options: Parameters<OAuth2Client["generateAuthUrl"]>[0]) {
    authUrl = new URL(originalGenerate.call(this, options));
    return authUrl.toString();
  });
  t.mock.method(OAuth2Client.prototype, "getToken", async (options: { codeVerifier: string; redirect_uri: string }) => {
    exchanged++;
    assert.equal(createHash("sha256").update(options.codeVerifier).digest("base64url"), authUrl.searchParams.get("code_challenge"));
    assert.equal(options.redirect_uri, authUrl.searchParams.get("redirect_uri"));
    return { tokens: {
      id_token: "fake-id-token", access_token: "fake-access-token", refresh_token: "fake-refresh-token",
      expiry_date: Date.now() + 3600_000, scope: `openid email ${CALENDAR_LIST_SCOPE}`,
    }};
  });
  const verified = t.mock.method(OAuth2Client.prototype, "verifyIdToken", async (options: { audience: string }) => {
    assert.equal(options.audience, config.clientId);
    return new LoginTicket("", {
      iss: "https://accounts.google.com", aud: config.clientId, sub: subject, email, email_verified: true,
      nonce: authUrl.searchParams.get("nonce"), iat: 1, exp: 9999999999,
    } as TokenPayload);
  });
  t.mock.method(OAuth2Client.prototype, "request", async function(this: OAuth2Client, options: Record<string, unknown>) {
    assert.equal(this.apiKey, undefined, "API key must not disable the OAuth refresh path");
    assert.ok(this.credentials.refresh_token);
    assert.equal(options.url, "https://www.googleapis.com/calendar/v3/users/me/calendarList");
    assert.equal(options.method, "GET");
    assert.deepEqual(options.headers, { "X-Goog-Api-Key": "fake-api-key" });
    requests.push(options);
    const page = (options.params as Record<string, unknown>).pageToken;
    return { data: page ? {
      items: [{ id: "shared-calendar", summary: "Team", accessRole: "reader" }],
    } : {
      items: [{ id: "primary-calendar", summary: "Personal", primary: true, timeZone: "America/New_York", accessRole: "owner" }],
      nextPageToken: "page-2",
    }};
  });
  return {
    config, directory, requests, verified,
    setIdentity(nextEmail: string, nextSubject = subject) { email = nextEmail; subject = nextSubject; },
    exchanged: () => exchanged,
    async start(extra: { email?: string; calendarId?: string; timeoutMs?: number; expectedAccountId?: string } = {}) {
      const session = await startGoogleCalendarLink(config, { email: "person@company.example", ...extra });
      sessions.push(session);
      return session;
    },
  };
}

function callback(session: CalendarLinkSession, parameters: Record<string, string> = {}) {
  const auth = new URL(session.authorizationUrl);
  const url = new URL(auth.searchParams.get("redirect_uri")!);
  url.searchParams.set("state", auth.searchParams.get("state")!);
  url.searchParams.set("code", "fake-code");
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

test("an API key alone fails clearly before any sign-in starts", async () => {
  assert.throws(() => readGoogleCalendarConfig({ GOOGLE_API_KEY: "fake-key" }), /OAuth client ID and client secret/);
  await assert.rejects(startGoogleCalendarLink({ clientId: "", clientSecret: "" }, { email: "person@example.com" }), /API key alone/);
});

test("non-Gmail email is accepted with explicit Google consent and PKCE", async t => {
  const f = fixture(t);
  const session = await f.start();
  const url = new URL(session.authorizationUrl);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("login_hint"), "person@company.example");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("scope"), `openid email ${CALENDAR_LIST_SCOPE}`);
  assert.ok(!session.authorizationUrl.includes(f.config.clientSecret));
  assert.ok(!session.authorizationUrl.includes(f.config.apiKey!));
  session.cancel();
  await assert.rejects(session.completed, /cancelled/);
});

test("successful sign-in links a selected calendar across pages and saves only private credentials", async t => {
  const f = fixture(t);
  const session = await f.start({ calendarId: "shared-calendar" });
  const response = await fetch(callback(session));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const connection = await session.completed;
  assert.equal(connection.account.email, "person@company.example");
  assert.equal(connection.calendar.id, "shared-calendar");
  assert.equal(f.requests.length, 2);
  assert.equal(f.exchanged(), 1);
  const files = readdirSync(f.directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const file = join(f.directory, files[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = readFileSync(file, "utf8");
  assert.ok(saved.includes("fake-refresh-token"));
  for (const secret of ["fake-access-token", "fake-id-token", "fake-api-key", "fake-client-secret"]) assert.ok(!saved.includes(secret));
  assert.ok(!JSON.stringify(connection).includes("fake-refresh-token"));
  const restored = loadGoogleCalendarConnection(f.config, connection.account.id);
  assert.equal((await restored.listCalendars()).length, 2);
});

test("wrong state, duplicate state and non-ASCII state never exchange a code", async t => {
  const f = fixture(t);
  const session = await f.start();
  for (const state of ["wrong", "é".repeat(43)]) {
    assert.equal((await fetch(callback(session, { state }))).status, 400);
  }
  const duplicate = callback(session);
  duplicate.searchParams.append("state", "extra");
  assert.equal((await fetch(duplicate)).status, 400);
  assert.equal(f.exchanged(), 0);
  assert.equal((await fetch(callback(session))).status, 200);
  await session.completed;
});

test("reconnecting the wrong Google account never saves or queries a calendar", async t => {
  const f = fixture(t);
  f.setIdentity("someone-else@company.example");
  const session = await f.start({ expectedAccountId: "previously-linked-google-id" });
  assert.equal((await fetch(callback(session))).status, 400);
  await assert.rejects(session.completed, (error: unknown) => error instanceof CalendarLinkError && error.code === "WRONG_ACCOUNT");
  assert.equal(f.requests.length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("Proton sign-in address is a hint; Google's verified canonical account owns the link", async t => {
  const f = fixture(t);
  f.setIdentity("canonical-primary@gmail.com", "stable-google-account-id");
  const session = await f.start({ email: "someone@proton.me" });
  assert.equal(new URL(session.authorizationUrl).searchParams.get("login_hint"), "someone@proton.me");
  await fetch(callback(session));
  const connection = await session.completed;
  assert.equal(connection.account.id, "stable-google-account-id");
  assert.equal(connection.account.email, "canonical-primary@gmail.com");
});

test("a Gmail account links its primary calendar and can restore the connection", async t => {
  const f = fixture(t);
  f.setIdentity("someone@gmail.com");
  const session = await f.start({ email: "someone@gmail.com" });
  assert.equal(new URL(session.authorizationUrl).searchParams.get("login_hint"), "someone@gmail.com");
  assert.equal((await fetch(callback(session))).status, 200);
  const connection = await session.completed;
  assert.equal(connection.account.email, "someone@gmail.com");
  assert.equal(connection.calendar.id, "primary-calendar");
  const restored = loadGoogleCalendarConnection(f.config, connection.account.id);
  assert.equal((await restored.listCalendars()).length, 2);
});

test("a Google account whose primary address is Proton links normally", async t => {
  const f = fixture(t);
  f.setIdentity("someone@proton.me");
  const session = await f.start({ email: "someone@proton.me" });
  await fetch(callback(session));
  assert.equal((await session.completed).account.email, "someone@proton.me");
});

test("failed identity verification never exposes the provider error or tokens", async t => {
  const f = fixture(t);
  f.verified.mock.mockImplementation(async () => { throw new Error("fake-refresh-token should not be logged"); });
  const session = await f.start();
  const response = await fetch(callback(session));
  assert.ok(!(await response.text()).includes("fake-refresh-token"));
  await assert.rejects(session.completed, (error: unknown) => error instanceof CalendarLinkError && !error.message.includes("fake-refresh-token"));
  assert.deepEqual(readdirSync(f.directory), []);
});

test("a mismatched sign-in nonce is rejected before accessing calendars", async t => {
  const f = fixture(t);
  f.verified.mock.mockImplementation(async () => new LoginTicket("", {
    iss: "https://accounts.google.com", aud: f.config.clientId, sub: "google-user-123",
    email: "person@company.example", email_verified: true, nonce: "another-session", iat: 1, exp: 9999999999,
  }));
  const session = await f.start();
  await fetch(callback(session));
  await assert.rejects(session.completed, (error: unknown) => error instanceof CalendarLinkError && error.code === "IDENTITY");
  assert.equal(f.requests.length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("partial consent without calendar permission does not save a connection", async t => {
  const f = fixture(t);
  t.mock.method(OAuth2Client.prototype, "getToken", async () => ({ tokens: {
    id_token: "fake-id-token", access_token: "fake-access-token", refresh_token: "fake-refresh-token", scope: "openid email",
  }}));
  const session = await f.start();
  await fetch(callback(session));
  await assert.rejects(session.completed, (error: unknown) => error instanceof CalendarLinkError && error.code === "SCOPE");
  assert.equal(f.requests.length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("cancelling an in-flight token exchange prevents a late credential write", async t => {
  const f = fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const enteredExchange = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(OAuth2Client.prototype, "getToken", async () => {
    entered();
    await gate;
    return { tokens: {
      id_token: "fake-id-token", access_token: "fake-access-token", refresh_token: "fake-refresh-token", scope: `openid email ${CALENDAR_LIST_SCOPE}`,
    }};
  });
  const session = await f.start();
  const response = fetch(callback(session)).catch(() => undefined);
  await enteredExchange;
  session.cancel();
  await assert.rejects(session.completed, /cancelled/);
  release();
  await response;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("consent denial needs a matching state and closes the listener", async t => {
  const f = fixture(t);
  const session = await f.start();
  await fetch(callback(session, { error: "access_denied" }));
  await assert.rejects(session.completed, /permission was denied/);
  assert.equal(f.exchanged(), 0);
  await assert.rejects(fetch(callback(session)), /fetch failed/);
});

test("timeout and explicit cancellation save nothing and close their listeners", async t => {
  const f = fixture(t);
  const session = await f.start({ timeoutMs: 15 });
  await assert.rejects(session.completed, /expired/);
  await assert.rejects(fetch(callback(session)), /fetch failed/);
  const second = await f.start();
  second.cancel();
  await assert.rejects(second.completed, /cancelled/);
  assert.equal(f.exchanged(), 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("separate users have separate stored connections and cannot be loaded under another client", async t => {
  const f = fixture(t);
  const first = await f.start();
  await fetch(callback(first));
  await first.completed;
  f.setIdentity("another@another-company.example", "google-user-456");
  const second = await f.start({ email: "another@another-company.example" });
  await fetch(callback(second));
  await second.completed;
  assert.equal(readdirSync(f.directory).length, 2);
  assert.equal(loadGoogleCalendarConnection(f.config, "google-user-123").account.email, "person@company.example");
  assert.equal(loadGoogleCalendarConnection(f.config, "google-user-456").account.email, "another@another-company.example");
  assert.throws(() => loadGoogleCalendarConnection({ ...f.config, clientId: "different-client" }, "google-user-123"), /No valid private/);
});
