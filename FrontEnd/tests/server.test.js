import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";

test("real UI routes validate origin, exchange mocked Google code, store private tokens, and disconnect", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mango-http-test-"));
  fs.mkdirSync(path.join(directory, "ui"));
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  for (const file of ["server.js", "google-connection.js"]) {
    fs.copyFileSync(new URL(`../ui/${file}`, import.meta.url), path.join(directory, "ui", file));
  }
  // Replace only Google's HTTPS transport in the isolated child. Real HTTP routes still run.
  fs.writeFileSync(path.join(directory, "mock-google.mjs"), `
    import https from 'node:https'; import http from 'node:http'; import {EventEmitter} from 'node:events';
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return listen.apply(this, args);
    };
    https.request = (options, callback) => {
      const req = new EventEmitter(); let body = '';
      req.write = text => { body += text; }; req.setTimeout = () => req;
      req.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = 200;
        let data;
        if (options.hostname === 'oauth2.googleapis.com' && new URLSearchParams(body).get('redirect_uri') === 'http://localhost') {
          data = {access_token:'fake-access',refresh_token:'fake-refresh',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/calendar'};
        } else if (options.hostname === 'www.googleapis.com' && options.path === '/oauth2/v3/userinfo') {
          data = {sub:'test-account',email:'test@gmail.com',email_verified:true};
        } else { response.statusCode = 400; data = {}; }
        callback(response); response.emit('data', JSON.stringify(data)); response.emit('end');
      }); return req;
    };
  `);
  const child = spawn(process.execPath, ["--import", path.join(directory, "mock-google.mjs"), path.join(directory, "ui/server.js")], {
    env: { ...process.env, PORT: "0", MANGO_UI_ORIGIN: "http://localhost", GOOGLE_CLIENT_ID: "fake-client", GOOGLE_CLIENT_SECRET: "fake-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("UI test server did not start")), 5000);
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/TEST_PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const url = `http://127.0.0.1:${port}`;
  const headers = { Host: "localhost", Origin: "http://localhost", "X-Requested-With": "XmlHttpRequest", "Content-Type": "application/json" };
  const request = (endpoint, method, requestHeaders, body = "") => new Promise((resolve, reject) => {
    const req = http.request(url + endpoint, { method, headers: requestHeaders }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("UI request timed out")));
    req.end(body);
  });
  const post = (endpoint, extra = {}) => request(endpoint, "POST", { ...headers, ...extra }, '{"code":"fake-code"}');
  assert.equal((await post("/api/auth/google/code", { Origin: "https://wrong.example" })).status, 403);
  assert.equal((await post("/api/auth/google/code", { "X-Requested-With": "" })).status, 403);
  const response = await post("/api/auth/google/code");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.user.sub, "test-account");
  assert.equal(result.hasCalendar, true);
  assert.equal(result.hasGmail, false);
  assert.ok(!JSON.stringify(result).includes("fake-access"));
  const tokenFile = path.join(directory, ".mango-data/google_tokens.json");
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(tokenFile)).clientId, "fake-client");
  const accessResponse = await request('/api/calendar/access-code', 'POST', headers, '{"code":"12345678"}');
  assert.equal(accessResponse.status, 200);
  const accessFile = path.join(directory, '.mango-data/calendar_access.json');
  const accessRecord = JSON.parse(fs.readFileSync(accessFile));
  assert.equal(accessRecord.account, 'test-account');
  assert.equal(accessRecord.hash.length, 64);
  assert.ok(!JSON.stringify(accessRecord).includes('12345678'));
  assert.equal(fs.statSync(accessFile).mode & 0o777, 0o600);
  assert.equal((await request('/api/calendar/access-code', 'POST', headers, '{"code":"123"}')).status, 400);
  assert.equal((await request("/.env", "GET", headers)).status, 404);
  assert.equal((await post("/api/auth/disconnect")).status, 200);
  assert.equal(fs.existsSync(tokenFile), false);
  assert.equal(fs.existsSync(accessFile), false);
});
