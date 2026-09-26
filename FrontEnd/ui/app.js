/**
 * Mango Voice Agent — Minimal Frontend Logic with Google Calendar & Gmail OAuth
 * Inspired by AppLlama: Focused, tactile, zero clutter.
 */

const state = {
  agentNumber: "+14849622356",
  googleClientId: "",
  googleScopes: "openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
  currentUser: null
};

// DOM Elements
const agentNumberDisplay = document.getElementById("agentNumberDisplay");
const copyBtn = document.getElementById("copyBtn");
const copyBtnText = document.getElementById("copyBtnText");
const userPhoneInput = document.getElementById("userPhoneInput");
const callForm = document.getElementById("callForm");
const callSubmitBtn = document.getElementById("callSubmitBtn");
const ctaText = document.getElementById("ctaText");
const statusToast = document.getElementById("statusToast");
const statusMessage = document.getElementById("statusMessage");
const connectGoogleBtn = document.getElementById("connectGoogleBtn");
const userProfile = document.getElementById("userProfile");
const userAvatar = document.getElementById("userAvatar");
const userName = document.getElementById("userName");
const signOutBtn = document.getElementById("signOutBtn");

let codeClient = null;

// 1. Fetch Backend Config & Auth Status
async function init() {
  try {
    // Check config
    const configRes = await fetch("/api/config");
    if (configRes.ok) {
      const data = await configRes.json();
      if (data.agentNumber) {
        state.agentNumber = data.agentNumber;
        agentNumberDisplay.textContent = state.agentNumber;
      }
      if (data.googleClientId) {
        state.googleClientId = data.googleClientId;
      }
      if (data.googleScopes) {
        state.googleScopes = data.googleScopes;
      }
      initOAuthClient();
    }

    // Check existing server-side auth status
    const authRes = await fetch("/api/auth/status");
    if (authRes.ok) {
      const authData = await authRes.json();
      if (authData.authenticated && authData.user) {
        loginUser(authData.user);
      }
    }
  } catch (err) {
    console.warn("Init fetch warning:", err);
  }
}

// 2. Initialize Google OAuth 2.0 Code Client for Calendar & Gmail Permissions
function initOAuthClient() {
  if (!state.googleClientId || !window.google?.accounts?.oauth2) {
    setTimeout(initOAuthClient, 350);
    return;
  }

  try {
    codeClient = window.google.accounts.oauth2.initCodeClient({
      client_id: state.googleClientId,
      scope: state.googleScopes,
      ux_mode: "popup",
      callback: async (response) => {
        if (response.code) {
          showStatus("Signing in...");
          try {
            const res = await fetch("/api/auth/google/code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: response.code })
            });
            const data = await res.json();
            if (res.ok && data.user) {
              loginUser(data.user);
              showStatus(`Signed in as ${data.user.name || "User"}`);
            } else {
              showStatus(data.error || "Sign-in failed");
            }
          } catch {
            showStatus("Server error during auth");
          }
        } else if (response.error) {
          console.warn("OAuth response error:", response);
          showStatus(response.error_description || "Google authorization cancelled");
        }
      }
    });
  } catch (err) {
    console.error("Failed to initialize Google OAuth Code Client:", err);
  }
}

connectGoogleBtn.addEventListener("click", () => {
  if (codeClient) {
    codeClient.requestCode();
  } else {
    showStatus("Connecting Google...");
    initOAuthClient();
  }
});

function loginUser(user) {
  state.currentUser = user;
  userName.textContent = user.name || "User";
  if (user.picture) {
    userAvatar.src = user.picture;
    userAvatar.style.display = "block";
  } else {
    userAvatar.style.display = "none";
  }

  connectGoogleBtn.style.display = "none";
  userProfile.style.display = "inline-flex";
}

signOutBtn.addEventListener("click", async () => {
  try {
    await fetch("/api/auth/disconnect", { method: "POST" });
  } catch {}

  state.currentUser = null;
  userProfile.style.display = "none";
  connectGoogleBtn.style.display = "inline-flex";
  showStatus("Google disconnected");
});

// 3. Copy Agent Number
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.agentNumber);
    copyBtnText.textContent = "Copied!";
    showStatus("Number copied to clipboard");
    setTimeout(() => {
      copyBtnText.textContent = "Copy";
    }, 2000);
  } catch {
    showStatus("Unable to copy number");
  }
});

// 4. User Phone Input Formatting
userPhoneInput.addEventListener("input", (e) => {
  let val = e.target.value.replace(/\D/g, "");
  if (val.length > 10) val = val.slice(0, 10);
  
  if (val.length > 6) {
    e.target.value = `(${val.slice(0, 3)}) ${val.slice(3, 6)}-${val.slice(6)}`;
  } else if (val.length > 3) {
    e.target.value = `(${val.slice(0, 3)}) ${val.slice(3)}`;
  } else if (val.length > 0) {
    e.target.value = `(${val}`;
  } else {
    e.target.value = "";
  }
});

// 5. Request Call
callForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const rawDigits = userPhoneInput.value.replace(/\D/g, "");
  if (rawDigits.length < 10) {
    showStatus("Please enter a valid 10-digit number");
    return;
  }

  const e164 = `+1${rawDigits}`;
  callSubmitBtn.disabled = true;
  ctaText.textContent = "Calling...";

  try {
    const res = await fetch("/api/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: e164,
        from: state.agentNumber,
        caller: state.currentUser ? state.currentUser.name : "Caller"
      })
    });

    if (res.ok) {
      showStatus(`Mango is calling ${userPhoneInput.value}`);
      ctaText.textContent = "Requested";
      setTimeout(() => {
        ctaText.textContent = "Call Me";
        callSubmitBtn.disabled = false;
      }, 3500);
    } else {
      throw new Error("Failed to dispatch call");
    }
  } catch (err) {
    showStatus("Call request failed. Try calling Mango directly.");
    ctaText.textContent = "Call Me";
    callSubmitBtn.disabled = false;
  }
});

// 6. Minimal Status Feedback
let toastTimer;
function showStatus(msg) {
  clearTimeout(toastTimer);
  statusMessage.textContent = msg;
  statusToast.style.display = "flex";
  toastTimer = setTimeout(() => {
    statusToast.style.display = "none";
  }, 3200);
}

// Start
init();
