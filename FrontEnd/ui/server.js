// @ts-check
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectionRecord, connectionStatus, saveConnection } from "./google-connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

// Load .env file from project root or local ui folder
const envPath = fs.existsSync(path.join(ROOT_DIR, ".env")) 
  ? path.join(ROOT_DIR, ".env") 
  : path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
      process.env[key] = val;
    }
  }
}

const PORT = process.env.PORT || 3000;
const UI_ORIGIN = process.env.MANGO_UI_ORIGIN || `http://localhost:${PORT}`;
const UI_STATIC_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, ".mango-data");
const TOKENS_FILE = path.join(DATA_DIR, "google_tokens.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

/**
 * Universal HTTPS request helper for Node 16+ without external packages
 */
function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Google request timed out")));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // This single-account dashboard and token store are local to the operator's machine.
  if (req.headers.host !== new URL(UI_ORIGIN).host ||
      (req.headers.origin && req.headers.origin !== UI_ORIGIN) ||
      (req.method === "POST" && (req.headers.origin !== UI_ORIGIN || req.headers["x-requested-with"] !== "XmlHttpRequest"))) {
    res.writeHead(403).end("Request origin rejected");
    return;
  }
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = parsedUrl.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", UI_ORIGIN);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Config endpoint
  if (pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      googleScopes: process.env.GOOGLE_SCOPES || "openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
      agentNumber: process.env.MANGO_AGENT_NUMBER || "+14849622356"
    }));
    return;
  }

  // 2. Auth status endpoint
  if (pathname === "/api/auth/status") {
    if (fs.existsSync(TOKENS_FILE)) {
      try {
        const tokenData = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(connectionStatus(tokenData)));
        return;
      } catch {}
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authenticated: false }));
    return;
  }

  // 3. OAuth Code Exchange for Google Calendar & Gmail
  if (pathname === "/api/auth/google/code" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const { code } = JSON.parse(body || "{}");
        if (!code) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing authorization code" }));
          return;
        }

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

        const tokenPostData = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: UI_ORIGIN,
          grant_type: "authorization_code"
        }).toString();

        const tokenResp = await httpsRequest({
          hostname: "oauth2.googleapis.com",
          path: "/token",
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(tokenPostData)
          }
        }, tokenPostData);

        if (tokenResp.status !== 200 || !tokenResp.data.access_token) {
          console.error("Google token exchange failed");
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to exchange authorization code" }));
          return;
        }

        const tokens = tokenResp.data;

        // Fetch user profile info
        const userResp = await httpsRequest({
          hostname: "www.googleapis.com",
          path: "/oauth2/v3/userinfo",
          method: "GET",
          headers: {
            "Authorization": `Bearer ${tokens.access_token}`
          }
        });

        if (userResp.status !== 200) throw new Error("Could not verify Google account");
        let previous = null;
        if (fs.existsSync(TOKENS_FILE)) {
          try { previous = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); } catch {}
        }
        const tokenRecord = connectionRecord(tokens, userResp.data, clientId, previous);
        saveConnection(TOKENS_FILE, tokenRecord);
        console.log("[Mango] Google account connected");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          ...connectionStatus(tokenRecord)
        }));
      } catch (err) {
        console.error("Google authentication processing failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication processing failed" }));
      }
    });
    return;
  }

  // 4. Disconnect Google account
  if (pathname === "/api/auth/disconnect" && req.method === "POST") {
    if (fs.existsSync(TOKENS_FILE)) {
      fs.unlinkSync(TOKENS_FILE);
    }
    console.log("[Mango] Google account disconnected.");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 5. Outbound call dispatch endpoint
  if (pathname === "/api/call" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        console.log(`[Mango] Outbound call to ${payload.to} requested.`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          message: `Call scheduled to ${payload.to}`,
          to: payload.to
        }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // 6. Static file serving from ui/
  if (pathname === "/") pathname = "/index.html";
  if (!["/index.html", "/app.js", "/styles.css"].includes(pathname) && !pathname.startsWith("/assets/")) {
    res.writeHead(404).end("Not found");
    return;
  }
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(UI_STATIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mango UI running at http://localhost:${PORT}`);
});
