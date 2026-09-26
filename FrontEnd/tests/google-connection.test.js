import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectionRecord, connectionStatus, saveConnection } from "../ui/google-connection.js";

test("UI stores the verified identity, expiry and scope contract consumed by Python", () => {
  const record = connectionRecord({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600,
    scope: "openid email https://www.googleapis.com/auth/calendar" },
    { sub: "account-id", email: "user@proton.me", email_verified: true }, "client-id", null, 1000);
  assert.equal(record.user.sub, "account-id");
  assert.equal(record.expiresAt, 3601000);
  assert.equal(record.clientId, "client-id");
  const status = connectionStatus(record);
  assert.equal(status.hasCalendar, true);
  assert.equal(status.hasGmail, false);
  assert.ok(!JSON.stringify(status).includes("fake-access"));
});

test("refresh token reuse is limited to the same verified account and client", () => {
  const user = { sub: "one", email: "user@gmail.com", email_verified: true };
  const previous = connectionRecord({ access_token: "old", refresh_token: "private-refresh" }, user, "client");
  assert.equal(connectionRecord({ access_token: "new" }, user, "client", previous).tokens.refresh_token, "private-refresh");
  assert.equal(connectionRecord({ access_token: "new" }, { ...user, sub: "two" }, "client", previous).tokens.refresh_token, undefined);
  assert.equal(connectionRecord({ access_token: "new" }, user, "other-client", previous).tokens.refresh_token, undefined);
  assert.throws(() => connectionRecord({ access_token: "new" }, { ...user, email_verified: false }, "client"));
});

test("token persistence is private and atomic", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mango-ui-test-"));
  try {
    const file = path.join(temporary, "data/google_tokens.json");
    saveConnection(file, { tokens: { access_token: "fake-token" } });
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["google_tokens.json"]);
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
});
