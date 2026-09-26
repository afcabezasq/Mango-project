# Mango FrontEnd

The Mango frontend is a lightweight dashboard for connecting Google Calendar / Gmail via OAuth, displaying the voice agent line, and initiating calls.

---

## 🚀 How to Run

### Option 1: Via npm (Recommended)
From either the repository root or the `FrontEnd/` folder:

```bash
cd FrontEnd
npm run ui
```

> **Note**: Do not run `npm run app.js` — `app.js` is client-side browser JavaScript, not an npm script. The npm script defined in `package.json` is `npm run ui`.

### Option 2: Direct Node.js Command
The UI server uses native Node.js HTTP/HTTPS modules with no required npm runtime dependencies:

```bash
# From FrontEnd directory:
node server.js

# Or directly:
node ui/server.js
```

The web dashboard will be available at:
👉 **http://localhost:3000** (or the port specified in `PORT`)

---

## ⚙️ Environment Variables

The server automatically loads configuration from `.env` in the project root or inside `FrontEnd/`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Local HTTP port for the web server |
| `GOOGLE_CLIENT_ID` | `""` | Google OAuth Client ID for Calendar & Gmail access |
| `GOOGLE_CLIENT_SECRET` | `""` | Google OAuth Client Secret for code exchange |
| `GOOGLE_SCOPES` | `openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send` | OAuth scopes requested |
| `MANGO_AGENT_NUMBER` | `+14849622356` | Voice agent phone number displayed in UI |

---

## 📁 Directory Structure

```text
FrontEnd/
├── package.json       # Scripts (npm run ui)
├── server.js          # Entrypoint proxying to ui/server.js
├── README.md          # Documentation
└── ui/
    ├── index.html     # HTML structure
    ├── styles.css     # CSS styling (dark mode, glassmorphism)
    ├── app.js         # Client-side UI logic & Google OAuth client
    ├── server.js      # Node.js static file & API server
    └── assets/        # Visual assets and icons
```

---

## 🔌 API Endpoints

- `GET /` — Serves `index.html` and static assets.
- `GET /api/config` — Returns client-safe config (`googleClientId`, `googleScopes`, `agentNumber`).
- `GET /api/auth/status` — Checks if Google tokens exist in `.mango-data/google_tokens.json`.
- `POST /api/auth/google/code` — Exchanges Google authorization code for access & refresh tokens.
- `POST /api/auth/disconnect` — Clears stored Google tokens.
- `POST /api/call` — Dispatches an outbound call request to the specified phone number.
