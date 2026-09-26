import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export type Profile = {
  kind: "personal" | "business";
  ownerName: string;
  organization: string;
  approvedFacts: string[];
  instructions: string;
};
export type Job = { recipient: string; objective: string };
export type Launch = {
  mode: "webrtc" | "local" | "chat" | "phone" | "outbound";
  profilePath: string;
  from?: string;
  to?: string;
  job?: Job;
  check: boolean;
  reportsDir: string;
};

export function loadProfile(path: string): Profile {
  const p: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Profile must be an object.");
  const v = p as Record<string, unknown>;
  if (v.kind !== "personal" && v.kind !== "business") throw new Error("Profile kind must be personal or business.");
  for (const key of ["ownerName", "organization", "instructions"]) {
    if (typeof v[key] !== "string") throw new Error(`Profile ${key} must be text.`);
  }
  if (!Array.isArray(v.approvedFacts) || !v.approvedFacts.every(x => typeof x === "string")) {
    throw new Error("Profile approvedFacts must be a list of text facts.");
  }
  return v as Profile;
}

export function resolveLaunch(args: string[], env: NodeJS.ProcessEnv): Launch {
  const managed = ["on", "true", "yes"].includes((env.GUAVA_HEALTH_SERVER ?? "").trim().toLowerCase());
  const { values: v } = parseArgs({ args, options: {
    mode: { type: "string", default: managed && env.GUAVA_AGENT_NUMBER ? "phone" : "webrtc" },
    profile: { type: "string", default: "profiles/personal.json" },
    from: { type: "string" }, to: { type: "string" },
    recipient: { type: "string" }, objective: { type: "string" },
    "confirm-dial": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
  }});
  if (!["webrtc", "local", "chat", "phone", "outbound"].includes(v.mode!)) {
    throw new Error("Mode must be webrtc, local, chat, phone, or outbound.");
  }
  const mode = v.mode as Launch["mode"];
  const from = v.from ?? env.GUAVA_AGENT_NUMBER;
  const phone = (s?: string) => !!s && /^\+[1-9]\d{7,14}$/.test(s);
  if ((mode === "phone" || mode === "outbound") && !phone(from)) {
    throw new Error("Set --from or GUAVA_AGENT_NUMBER to an owned E.164 number (for example +15555550123).");
  }
  if (mode === "outbound") {
    if (!phone(v.to)) throw new Error("Outbound requires --to with an E.164 number.");
    if (!v.recipient?.trim() || !v.objective?.trim()) throw new Error("Outbound requires --recipient and --objective.");
    if (!v["confirm-dial"]) throw new Error("Outbound requires --confirm-dial after the owner authorizes this call and its usage.");
  } else if (v.to || v.recipient || v.objective || v["confirm-dial"]) {
    throw new Error("Outbound options require --mode outbound; no call was made.");
  }
  return {
    mode, profilePath: v.profile!, from, to: v.to,
    job: mode === "outbound" ? { recipient: v.recipient!.trim(), objective: v.objective!.trim() } : undefined,
    check: v.check!,
    reportsDir: env.MANGO_REPORT_DIR ?? (managed ? "/tmp/mango-reports" : ".mango-data"),
  };
}
