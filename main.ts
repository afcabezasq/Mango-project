import { pathToFileURL } from "node:url";
import { getDefaultLogger, type Agent } from "@guava-ai/guava-sdk";
import { loadProfile, resolveLaunch, type Launch } from "./src/config.ts";
import { FileReports } from "./src/reports.ts";
import { buildMango } from "./src/mango.ts";

export async function runChannel(agent: Pick<Agent, "listenWebrtc" | "callLocal" | "chat" | "listenPhone" | "callPhone">, config: Launch) {
  switch (config.mode) {
    case "phone": return agent.listenPhone(config.from!);
    case "outbound": return agent.callPhone(config.from!, config.to!);
    case "local": return agent.callLocal();
    case "chat": return agent.chat();
    case "webrtc": return agent.listenWebrtc();
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Mango — AI secretary\n
guava run . -- --mode webrtc --profile profiles/personal.json
Modes: webrtc (local default), local, chat, phone, outbound
Phone: set GUAVA_AGENT_NUMBER or --from to your owned E.164 number.
Managed hosting with a configured phone number defaults to inbound phone mode.
Outbound also requires --to, --recipient, --objective, and --confirm-dial.
--check validates configuration offline; it never connects or calls.
MANGO_REPORT_DIR sets the private call-report directory.
Configure an owner/organization in your profile before outgoing calls.`);
    return;
  }
  const config = resolveLaunch(process.argv.slice(2), process.env);
  const profile = loadProfile(config.profilePath);
  if (config.job && !profile.ownerName.trim() && !profile.organization.trim()) {
    throw new Error("Configure ownerName or organization in the profile before making an outgoing call.");
  }
  if (config.check) {
    console.log(`Configuration OK: Mango / ${profile.kind} / ${config.mode}. No connection or call made.`);
    return;
  }
  const reports = new FileReports(config.reportsDir);
  getDefaultLogger().info(`Starting Mango: ${profile.kind}, ${config.mode}. Reports: ${config.reportsDir}`);
  await runChannel(buildMango(profile, reports, config.job), config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "Mango could not start.");
    process.exitCode = 1;
  });
}
