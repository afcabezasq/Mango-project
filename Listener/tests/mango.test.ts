import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MockCall, type BotSessionEnded } from "@guava-ai/guava-sdk";
import { resolveLaunch, loadProfile, type Profile } from "../src/config.ts";
import { createHandlers } from "../src/mango.ts";
import { FileReports, type Reports } from "../src/reports.ts";
import { runChannel } from "../main.ts";

// These tests use SDK command validation, not the network or paid TestSession API.
const personal: Profile = {
  kind: "personal", ownerName: "Alex", organization: "",
  approvedFacts: ["Alex prefers calls after 5 PM Eastern."], instructions: "Take messages.",
};
const business: Profile = {
  kind: "business", ownerName: "Alex", organization: "Example Shop",
  approvedFacts: ["Shop hours are 9 AM to 5 PM Eastern."], instructions: "Take customer requests.",
};
const job = { recipient: "Taylor", objective: "Ask whether a repair appointment is available on Friday." };
const end: BotSessionEnded = { event_type: "bot-session-ended", termination_reason: "user-hangup", dnc: false, pickup: true };

class MemoryReports implements Reports {
  data: Record<string, Record<string, unknown>> = {};
  update(id: string, changes: Record<string, unknown>) {
    this.data[id] = { ...this.data[id], ...changes };
  }
}

test("local startup stays WebRTC even with an owned phone number in the environment", () => {
  assert.equal(resolveLaunch([], { GUAVA_AGENT_NUMBER: "+15555550123" }).mode, "webrtc");
});

test("managed inbound uses its deliberately configured phone number, with explicit mode override", () => {
  const env = { GUAVA_AGENT_NUMBER: "+15555550123", GUAVA_HEALTH_SERVER: "true" };
  assert.equal(resolveLaunch([], env).mode, "phone");
  assert.equal(resolveLaunch(["--mode", "webrtc"], env).mode, "webrtc");
  assert.equal(resolveLaunch([], env).reportsDir, "/tmp/mango-reports");
});

const dial = ["--mode", "outbound", "--from", "+15555550123", "--to", "+15555550124", "--recipient", job.recipient, "--objective", job.objective];
test("outbound refuses missing approval, bad numbers and ambiguous recipient/purpose", () => {
  assert.throws(() => resolveLaunch(dial, {}), /confirm-dial/);
  assert.throws(() => resolveLaunch([...dial, "--confirm-dial", "--to", "911"], {}), /E.164/);
  assert.throws(() => resolveLaunch([...dial, "--confirm-dial", "--from", ""], {}), /owned E.164/);
  assert.throws(() => resolveLaunch([...dial, "--confirm-dial", "--recipient", " "], {}), /recipient/);
  assert.throws(() => resolveLaunch([...dial, "--confirm-dial", "--objective", " "], {}), /objective/);
  assert.deepEqual(resolveLaunch([...dial, "--confirm-dial"], {}).job, job);
});

test("outbound flags cannot silently fall through to another channel", () => {
  assert.throws(() => resolveLaunch(["--to", "+15555550124"], {}), /require --mode outbound/);
  assert.throws(() => resolveLaunch(["--mode", "phone"], {}), /owned E.164/);
  assert.throws(() => resolveLaunch(["--mode", "unknown"], {}), /Mode must/);
});

test("profile validation rejects unexpected shapes before startup", t => {
  const directory = mkdtempSync(join(tmpdir(), "mango-profile-test-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, "profile.json");
  writeFileSync(file, JSON.stringify({ ...personal, approvedFacts: [123] }));
  assert.throws(() => loadProfile(file), /list of text/);
  writeFileSync(file, JSON.stringify(personal));
  assert.deepEqual(loadProfile(file), personal);
});

test("preflight succeeds without credentials, data writes or a server connection", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "main.ts", "--check"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, HOME: "/nonexistent", GUAVA_BASE_URL: "http://127.0.0.1:1", GUAVA_DISABLE_TELEMETRY: "true" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No connection or call made/);
});

test("personal and business calls receive separate approved facts and an AI greeting", async () => {
  for (const [profile, excluded] of [[personal, business], [business, personal]] as const) {
    const call = new MockCall();
    await createHandlers(profile, new MemoryReports()).onCallStart(call);
    const payload = JSON.stringify(call.commands);
    assert.ok(payload.includes(profile.approvedFacts[0]));
    assert.ok(!payload.includes(excluded.approvedFacts[0]));
    const task = call.commands.find(c => c.command_type === "set-task");
    assert.equal(task?.task_id, "secretary");
    assert.ok(task?.action_items.some(i => i.item_type === "say" && i.statement.includes("Mango") && i.statement.includes("AI assistant")));
    assert.match(task!.objective, /cannot book, send messages/);
    assert.ok(task!.action_items.some(i => i.item_type === "field" && i.key === "preferred_time" && i.description?.includes("not a booking")));
  }
});

test("outgoing task/facts are withheld until intended recipient is available", async () => {
  const call = new MockCall();
  const handlers = createHandlers(personal, new MemoryReports(), job);
  await handlers.onCallStart(call);
  let payload = JSON.stringify(call.commands);
  assert.ok(payload.includes("reach_person"));
  assert.ok(!payload.includes(job.objective));
  assert.ok(!payload.includes(personal.approvedFacts[0]));
  assert.match(payload, /Mango/);
  await handlers.onReachPerson(call, "available");
  payload = JSON.stringify(call.commands);
  assert.ok(payload.includes(job.objective));
  assert.ok(payload.includes(personal.approvedFacts[0]));
});

test("wrong recipient ends without revealing the authorized task", async () => {
  const call = new MockCall();
  const reports = new MemoryReports();
  const handlers = createHandlers(personal, reports, job);
  await handlers.onCallStart(call);
  await handlers.onReachPerson(call, "wrong_number");
  const payload = JSON.stringify(call.commands);
  assert.ok(!payload.includes(job.objective));
  assert.ok(!payload.includes(personal.approvedFacts[0]));
  assert.match(payload, /hang up/);
  assert.equal(reports.data[call.id].recipientOutcome, "wrong_number");
});

test("completed call preserves summary and records opt-out without issuing post-call commands", async () => {
  const call = new MockCall();
  const reports = new MemoryReports();
  const handlers = createHandlers(personal, reports);
  await handlers.onCallStart(call);
  call.setField("person_name", "Taylor");
  call.setField("request", "Please review my appointment request.");
  await handlers.onTaskComplete(call);
  const commandCount = call.commands.length;
  await handlers.onSessionEnd(call, { ...end, dnc: true });
  const report = reports.data[call.id];
  assert.equal(report.taskCompleted, true);
  assert.equal(report.status, "ended");
  assert.equal(report.doNotCall, true);
  assert.equal((report.fields as Record<string, unknown>).person_name, "Taylor");
  assert.equal(call.commands.length, commandCount);
});

test("early hangup retains partial fields without pretending the task completed", async () => {
  const call = new MockCall();
  const reports = new MemoryReports();
  const handlers = createHandlers(personal, reports);
  await handlers.onCallStart(call);
  call.setField("person_name", "Taylor");
  await handlers.onSessionEnd(call, end);
  assert.equal(reports.data[call.id].taskCompleted, false);
  const fields = reports.data[call.id].fields as Record<string, unknown>;
  assert.equal(fields.person_name, "Taylor");
  assert.equal(fields.request, null);
});

test("dial failure records its reason without retrying", async () => {
  const call = new MockCall();
  const reports = new MemoryReports();
  await createHandlers(personal, reports, job).onOutboundFailed(call, {
    event_type: "outbound-call-failed", error_code: 486, error_reason: "Busy",
  });
  assert.equal(reports.data[call.id].status, "dial_failed");
  assert.equal(reports.data[call.id].errorReason, "Busy");
  assert.equal(call.commands.length, 0);
});

test("private reports merge updates and keep call IDs out of filesystem paths", t => {
  const parent = mkdtempSync(join(tmpdir(), "mango-report-test-"));
  t.after(() => rmSync(parent, { recursive: true }));
  const directory = join(parent, "private");
  const reports = new FileReports(directory);
  reports.update("../../outside", { taskCompleted: true });
  reports.update("../../outside", { status: "ended" });
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const file = join(directory, files[0]);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).taskCompleted, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "ended");
  assert.deepEqual(readdirSync(parent), ["private"]);
});

test("channel dispatch invokes only the selected SDK method once", async () => {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); };
  const agent = {
    listenWebrtc: record("webrtc"), callLocal: record("local"), chat: record("chat"),
    listenPhone: record("phone"), callPhone: record("outbound"),
  };
  await runChannel(agent, resolveLaunch([], {}));
  assert.deepEqual(calls, [["webrtc"]]);
  calls.length = 0;
  await runChannel(agent, resolveLaunch([...dial, "--confirm-dial"], {}));
  assert.deepEqual(calls, [["outbound", "+15555550123", "+15555550124"]]);
});
