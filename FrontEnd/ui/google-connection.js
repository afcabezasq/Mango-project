import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, pbkdf2Sync } from "node:crypto";

export function calendarAccessRecord(account, code) {
  if (!account || !/^[0-9]{8,12}$/.test(code)) throw new Error("Use an 8 to 12 digit access code.");
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(code, Buffer.from(salt, "hex"), 210000, 32, "sha256").toString("hex");
  return { account, salt, hash };
}

export function connectionRecord(tokens, user, clientId, previous = null, now = Date.now()) {
  if (!tokens.access_token || !user.sub || !user.email || user.email_verified !== true) {
    throw new Error("Google did not return a verified account.");
  }
  const sameAccount = previous?.user?.sub === user.sub && previous?.clientId === clientId;
  return {
    tokens: { ...tokens, refresh_token: tokens.refresh_token || (sameAccount ? previous.tokens.refresh_token : undefined) },
    user: { sub: user.sub, name: user.name, email: user.email, picture: user.picture },
    clientId, scopes: tokens.scope || (sameAccount ? previous.scopes : ""),
    updatedAt: new Date(now).toISOString(), expiresAt: now + Number(tokens.expires_in || 0) * 1000,
  };
}

export function connectionStatus(record) {
  const scopes = new Set((record.scopes || "").split(" "));
  return {
    authenticated: Boolean(record.user?.sub && record.tokens?.access_token), user: record.user,
    hasCalendar: scopes.has("https://www.googleapis.com/auth/calendar"),
    hasGmail: scopes.has("https://www.googleapis.com/auth/gmail.modify") || scopes.has("https://www.googleapis.com/auth/gmail.send"),
  };
}

export function saveConnection(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
