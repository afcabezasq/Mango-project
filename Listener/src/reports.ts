import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface Reports {
  update(sessionId: string, changes: Record<string, unknown>): void;
}

/** Local reports contain contact details; never put this directory in Git. */
export class FileReports implements Reports {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  update(sessionId: string, changes: Record<string, unknown>): void {
    const name = createHash("sha256").update(sessionId).digest("hex") + ".json";
    const path = join(this.directory, name);
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const report = { ...previous, ...changes, sessionId, updatedAt: new Date().toISOString() };
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }

    if (changes.taskCompleted && report.fields && typeof report.fields === "object") {
      const f = report.fields as Record<string, string>;
      if (f.request) {
        const callerName = f.person_name || "Caller";
        const callerPhone = f.callback_number ? ` (${f.callback_number})` : "";
        const callerVal = `${callerName}${callerPhone}`;

        sendTaskToSupabase(callerVal, f.request);
      }
    }
  }
}

function sendTaskToSupabase(caller: string, task: string): void {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || "https://ddiotzmdaugryfrfdxxr.supabase.co";
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_SRljIma0oj5744D5ggKQ7A_3IoLAp6D";
    const payload = JSON.stringify({
      caller,
      task,
      date: new Date().toISOString(),
      status: "pending"
    });

    if (typeof fetch === "function") {
      fetch(`${supabaseUrl}/rest/v1/tasks`, {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: payload
      }).catch(err => console.error("[Reports] Failed to sync task to Supabase:", err));
      return;
    }

    import("node:https").then(https => {
      const url = new URL(`${supabaseUrl}/rest/v1/tasks`);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Prefer": "return=minimal"
        }
      });
      req.on("error", err => console.error("[Reports] Failed to sync task to Supabase:", err));
      req.write(payload);
      req.end();
    }).catch(err => console.error("[Reports] Failed to import https:", err));
  } catch (err) {
    console.error("[Reports] Error syncing to Supabase:", err);
  }
}


