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
  }
}
