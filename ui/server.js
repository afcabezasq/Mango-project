// @ts-check
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const UI_STATIC_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, ".mango-data");
const TOKENS_FILE = path.join(DATA_DIR, "google_tokens.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = parsedUrl.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
        res.end(JSON.stringify({
          authenticated: true,
          user: tokenData.user || null,
          hasCalendar: true,
          hasGmail: true
        }));
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
          redirect_uri: "postmessage",
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
          console.error("Google token error:", tokenResp.data);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to exchange authorization code", details: tokenResp.data }));
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

        const user = userResp.status === 200 ? userResp.data : {
          name: "Google User",
          email: ""
        };

        const tokenRecord = {
          tokens,
          user: {
            name: user.name,
            email: user.email,
            picture: user.picture
          },
          scopes: tokens.scope,
          updatedAt: new Date().toISOString()
        };

        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokenRecord, null, 2), "utf8");
        console.log(`[Mango] Google OAuth connected for ${user.email} with Calendar & Gmail permissions!`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          user: tokenRecord.user,
          hasCalendar: true,
          hasGmail: true
        }));
      } catch (err) {
        console.error("Auth exchange failure:", err);
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

server.listen(PORT, () => {
  console.log(`Mango UI running at http://localhost:${PORT}`);
});
