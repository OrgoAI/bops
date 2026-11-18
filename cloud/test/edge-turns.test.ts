import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { clearAuthCache } from "../auth.ts";
import { closeDb, db, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { closeAll } from "../live.ts";
import { resetMembers } from "../members.ts";
import {
  APP_BUSY_WORDS,
  APP_CLAIM_BUSY,
  APP_LEASE_MS,
  CLOUD_ALL_MIN_VERSION,
  CLOUD_SELF_MIN_VERSION,
  COMPUTER_NOT_READY,
  DELETE_CODE_MS,
  GITHUB_ACTS_MIN_VERSION,
  GITHUB_KEY_LINE,
  RUNNER_FULL_ACCESS,
  RUNNER_OWNER_ONLY,
  type MemberActPayload,
  type SharedWsState,
  type TurnJob,
  type TurnMember,
} from "../protocol.ts";
import { forgetReleases, rememberRelease } from "../runner-release.ts";
import { howIWork } from "../style.ts";
import {
  APP_JOB_DEADLINE_MS,
  closeRunners,
  JOB_OLD_RUNNER,
  JOB_UPDATING,
  jobDeadline,
  keeperLive,
  NO_CHAT_COMPUTER,
  noteTrouble,
  nudgeUpdates,
  recordRunner,
  resetTurns,
  runnerVersionOf,
  sweepTurns,
  takeAppJob,
  takeChatJob,
  turnById,
  TURN_DEADLINE_MS,
  turnTiming,
} from "../turns.ts";
import { connectMac, dropUsers, keyOf, listen, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * Chat through Bops Cloud (cloud/turns.ts, members.ts): in a workspace switched to it, a member's message in a one bot
 * chat is written by Bops Cloud at once with their stamp, every viewer (the owner's devices and the member's) hears it
 * and then the bot's answer on the stream they already watch, and the answer is owed to the runner on the bot's
 * computer, which claims it (only its own, one at a time per chat), stamps its rows by Bops Cloud's clock and says it's
 * done. A computer with no runner listening is woken through orgo-web (one wake at a time per computer; refused for one
 * billed by the hour unless the owner allowed it, with a note). Without Use its computer the message stays with a note
 * and nothing runs. A removed member's turns end and their runner hears it. A lost runner's turn is owed again only
 * before it did anything that can't be done twice, and its late rows are refused. orgo-web is a fake on localhost.
 */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const PLAN_SECRET = "edge-turns-plan-secret-0123456789abcdef"; // gitleaks:allow (made up for this test)
const WAKE_SECRET = "edge-turns-wake-secret-0123456789abcdef"; // gitleaks:allow (made up for this test)
const roles: Record<string, unknown> = {};
/** What orgo-web's bops-role says of a member besides who they are (computerUse: Use its computer, kept there). */
const orgoSays = (member: string, project: string, more: Record<string, unknown>) => void (roles[`${member} ${project}`] = { ...(roles[`${member} ${project}`] as Record<string, unknown>), ...more });
/** What the fake orgo-web answers a wake with, by desktop (default: running), and each wake it was asked for. */
const wakeAnswers = new Map<string, (n: number) => Promise<Record<string, unknown>> | Record<string, unknown>>();
const wakes: { userId: string; desktopId: string; allowHourly: boolean; signed: boolean }[] = [];
/** Each project's own keys as orgo-web's bops-keys lists them (names), or the status it answers; none: 404. */
const liveKeys: Record<string, string[] | number> = {};
/** A bops-role answer held until the test lets it go, by "<user> <project>": what orgo-web said before a notice, back after it. */
const held = new Map<string, { until: Promise<void>; reached: boolean }>();

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
/** What Ingot's fake was asked to delete, and how it answers. */
const ingotDeletes: { project: string; app: string; key: string }[] = [];
const ingotAnswer: { status: number; body?: unknown } = { status: 204 };
const readAll = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

/** orgo-web, faked: profiles (`key-<user>`; `orgo_vm_<user>~<desktop>` a computer's identity, `ckey-<user>~<desktop>` its key), bops-role from `roles`, and the signed wake. */
async function fakeOrgo(): Promise<Listening> {
  return listen(
    createServer(async (req, res) => {
      const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const body = await readAll(req);
      if (req.url === "/api/internal/bops/wake") {
        const ts = String(req.headers["x-bops-timestamp"] ?? "");
        const signed = req.headers["x-bops-signature"] === `sha256=${createHmac("sha256", WAKE_SECRET).update(`${ts}.`).update(body).digest("hex")}`;
        const b = JSON.parse(body.toString()) as { userId: string; desktopId: string; allowHourly: boolean };
        wakes.push({ ...b, signed });
        const n = wakes.filter((w) => w.desktopId === b.desktopId).length;
        return json(res, 200, { desktopId: b.desktopId, ...(await (wakeAnswers.get(b.desktopId) ?? (() => ({ state: "running" })))(n)) });
      }
      // Ingot's repos (BOPS_INGOT_URL is this fake too): a repo deleted with someone's own key (members.ts deleteCodeHere).
      const repo = /^\/api\/v1\/w\/([^/]+)\/repos\/([^/]+)$/.exec(req.url ?? "");
      if (repo && req.method === "DELETE") {
        ingotDeletes.push({ project: repo[1], app: repo[2], key });
        return json(res, ingotAnswer.status, ingotAnswer.status === 204 ? undefined : ingotAnswer.body ?? {});
      }
      const keysOf = /^\/api\/projects\/([^/]+)\/bops-keys$/.exec(req.url ?? "")?.[1];
      if (keysOf) {
        const k = liveKeys[keysOf];
        return k === undefined || typeof k === "number" ? json(res, typeof k === "number" ? k : 404, {}) : json(res, 200, { keys: k.map((name) => ({ name, updated_at: null })) });
      }
      const project = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(req.url ?? "")?.[1];
      let m: RegExpExecArray | null;
      const hold = project && (m = /^key-(.+)$/.exec(key)) ? held.get(`${m[1]} ${project}`) : undefined;
      if (hold) {
        hold.reached = true;
        await hold.until;
      }
      if (project && (m = /^key-(.+)$/.exec(key))) return roles[`${m[1]} ${project}`] ? json(res, 200, roles[`${m[1]} ${project}`]) : json(res, 404, {});
      if (req.url !== "/api/user/profile") return json(res, 404, {});
      if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com`, name: m[1].startsWith("edge-writer") ? "Wren" : undefined });
      if ((m = /^orgo_vm_([^~]+)~([^~]+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: null, principal: { kind: "vm_identity", desktop_id: m[2], expires_at: new Date(Date.now() + 3600_000).toISOString() } });
      // A computer's own key (`ckey-<user>~<desktop>`), bound to its computer.
      if ((m = /^ckey-([^~]+)~([^~]+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: { scope: "computer", computer_id: m[2] } });
      json(res, 401, { error: "no" });
    }),
  );
}

before(async () => {
  process.env.BOPS_CLOUD_PLAN_SECRET = PLAN_SECRET;
  process.env.BOPS_CLOUD_WAKE_SECRET = WAKE_SECRET;
  await prepareDb();
  orgo = await fakeOrgo();
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  process.env.BOPS_INGOT_URL = `${orgo.url}/`;
  cloud = await startCloud();
  resetMembers();
  resetTurns();
  turnTiming.wakeAgainMs = 300;
});

after(async () => {
  closeAll();
  closeRunners();
  await cloud.close();
  await orgo.close();
  await query("DELETE FROM bops.cloud_limits WHERE key LIKE 'member:act:edge-%'");
  await query("DELETE FROM bops.cloud_pending WHERE user_id = ANY($1::text[])", [users]);
  await query("DELETE FROM bops.cloud_accounts WHERE user_id = ANY($1::text[])", [users]);
  await dropUsers(users);
  await closeDb();
});

const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};
/** The Bops the owner's Mac says it runs on every call (inCloudAll: CLOUD_ALL_MIN_VERSION). */
let macAt = "0.0.36";
const own = (userId: string, device = "mac-o", version = macAt) => ({
  Authorization: `Bearer ${keyOf(userId)}`,
  "x-bops-user": userId,
  "x-bops-protocol": "2",
  "x-bops-device": device,
  "x-bops-version": version,
  "content-type": "application/json",
});
const vm = (userId: string, desktop: string) => `orgo_vm_${userId}~${desktop}`;

/** An owner whose workspace Acme is switched to chat through Bops Cloud: Max (and Dana, on Max's computer), Zed on the owner's Mac. */
async function setup(opts: { cloud?: boolean } = {}) {
  const owner = user("owner");
  const writer = user("writer");
  const noUse = user("nouse");
  const project = randomUUID();
  const desktop = randomUUID();
  for (const m of [writer, noUse]) roles[`${m} ${project}`] = { role: "member", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  roles[`${owner} ${project}`] = { role: "owner", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  const state = {
    owner: { name: "Tara" },
    workspaces: [
      { id: "ws_main", name: "Main" },
      {
        id: "ws_acme",
        name: "Acme",
        memberAccess: {
          [`${writer}@example.com`]: { others: "none", bots: { max: "write", dana: "write", zed: "write" }, computer: "use" },
          [`${noUse}@example.com`]: { others: "none", bots: { max: "write" } },
        },
      },
    ],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true },
      { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: desktop.toUpperCase() },
      { id: "dana", name: "Dana", workspaceId: "ws_acme" },
      { id: "zed", name: "Zed", workspaceId: "ws_acme", runsOn: "mac" },
    ],
    chats: [
      { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" },
      { id: "bot:dana", kind: "bot", botIds: ["dana"], workspaceId: "ws_acme" },
      { id: "bot:zed", kind: "bot", botIds: ["zed"], workspaceId: "ws_acme" },
      { id: "team", kind: "group", botIds: ["max", "dana"], workspaceId: "ws_acme" },
    ],
  };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: own(owner), body: JSON.stringify({ base: 0, state }) })).status, 200);
  if (opts.cloud !== false) {
    const r = await fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers: own(owner), body: JSON.stringify({ wsId: "ws_acme", mode: "cloud" }) });
    assert.equal(r.status, 200);
  }
  return { owner, writer, noUse, project, desktop, device: deviceIdOf(owner, desktop) };
}

type Ev = { type: string; data: Record<string, unknown> };
/** An SSE stream's events as they come (`first`: the event that says it's open; `headers`: more to send, a runner's version). */
async function stream(path: string, key: string, first: string, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}${path}`, { headers: { Authorization: `Bearer ${key}`, ...headers }, signal: ctl.signal });
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  const got: Ev[] = [];
  void (async () => {
    let text = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body!) {
        text += dec.decode(chunk as Uint8Array, { stream: true });
        for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
          const block = text.slice(0, i);
          text = text.slice(i + 2);
          const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
          if (field("event")) got.push({ type: field("event")!, data: JSON.parse(field("data") ?? "{}") as Record<string, unknown> });
        }
      }
    } catch {}
  })();
  await until(() => got.some((g) => g.type === first), `${path} to open`);
  return { got, of: (type: string) => got.filter((g) => g.type === type), close: () => ctl.abort() };
}

const act = (member: string, project: string, key: string, a: Record<string, unknown>) =>
  fetch(`${cloud.url}/v1/ws/${project}/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(member)}`, "content-type": "application/json" }, body: JSON.stringify({ key, act: a }) });
const runner = (owner: string, desktop: string, path: string, body?: unknown) =>
  fetch(`${cloud.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${vm(owner, desktop)}`, "x-bops-user": owner, "x-bops-protocol": "2", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const writeAs = (owner: string, desktop: string, upsert: Record<string, unknown>[]) => runner(owner, desktop, "/v1/messages", { upsert, remove: [] });
const messages = async (owner: string) =>
  ((await (await fetch(`${cloud.url}/v1/messages?after=0`, { headers: own(owner) })).json()) as { messages: { id: string; json: Record<string, unknown> }[] }).messages.map((m) => m.json);
const turnsOf = async (owner: string) => (await query<{ id: string; state: string; note: string | null }>("SELECT id, state, note FROM bops.chat_turns WHERE user_id = $1 ORDER BY created_at", [owner])).rows;
const membersChanged = (projectId: string, userId: string) => {
  const body = JSON.stringify({ projectId, userId });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${cloud.url}/v1/internal/members-changed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": `sha256=${createHmac("sha256", PLAN_SECRET).update(`${ts}.${body}`).digest("hex")}` },
    body,
  });
};


/** A note Bops Cloud writes in the chat (some just after the response): its words once it's there. */
async function noteOf(owner: string, id: string): Promise<string | undefined> {
  await until(async () => (await messages(owner)).some((m) => m.id === id), `the note ${id}`);
  return (await messages(owner)).find((m) => m.id === id)?.text as string | undefined;
}
test("a member's message is written by Bops Cloud at once, both viewers hear it and the bot's answer, and the computer's runner answers it on Bops Cloud's clock", async () => {
  const s = await setup();
  const ownerLive = await stream("/v1/live?ws=ws_acme", keyOf(s.owner), "snapshot");
  const memberLive = await stream(`/v1/live?project=${s.project}`, keyOf(s.writer), "snapshot");
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");

  const r = await act(s.writer, s.project, "key-first-0001", { act: "chat", chatId: "bot:max", text: "find three leads" });
  assert.equal(r.status, 202);
  const answer = (await r.json()) as { stored: boolean; macOn: boolean; messageId: string; turn: string };
  assert.deepEqual([answer.stored, answer.macOn, answer.messageId, answer.turn], [true, true, `msg_m_${s.writer}_key-first-0001`, `turn_msg_m_${s.writer}_key-first-0001`]);
  // In Postgres now, stamped as orgo-web vouched for them: no Mac took part.
  const row = (await messages(s.owner)).find((m) => m.id === answer.messageId)!;
  assert.deepEqual(row.member, { userId: s.writer, email: `${s.writer}@example.com`, name: "Wren", ref: "key-first-0001" });
  assert.equal(row.role, "user");
  // Both viewers hear it was written, and that an answer is coming, with the bot thinking.
  for (const v of [ownerLive, memberLive]) {
    await until(() => v.of("state").some((e) => typeof e.data.seq === "number"), "the message's state event");
    await until(() => v.of("turn").some((e) => e.data.state === "owed" && e.data.chatId === "bot:max"), "the turn owed");
    await until(() => v.of("mood").some((e) => e.data.botId === "max" && e.data.mood === "thinking"), "Max thinking");
  }
  // The runner hears it, claims it, and gets Bops Cloud's clock and who said it.
  const ev = await until(() => box.of("turn").find((e) => e.data.id === answer.turn), "the runner's turn event");
  assert.equal(ev.data.messageId, answer.messageId);
  const c = await runner(s.owner, s.desktop, `/v1/runner/turns/${answer.turn}/claim`, {});
  assert.equal(c.status, 200);
  const claim = (await c.json()) as { now: number; turn: { humanAt: number; member: { userId: string; ref: string; projectId: string } } };
  assert.ok(Math.abs(claim.now - Date.now()) < 5000);
  assert.deepEqual([claim.turn.member.userId, claim.turn.member.ref, claim.turn.member.projectId], [s.writer, "key-first-0001", s.project]);
  assert.equal(claim.turn.humanAt, row.at);
  await until(() => memberLive.of("turn").some((e) => e.data.state === "thinking"), "thinking on the member's stream");
  // A clock that lags after a nap: its answer still comes after the question.
  const w = await writeAs(s.owner, s.desktop, [{ id: "a1", chatId: "bot:max", role: "bot", botId: "max", text: "Here are three leads.", at: (row.at as number) - 60_000, turn: answer.turn }]);
  assert.equal(w.status, 200, await w.text());
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${answer.turn}/done`, { state: "done", react: "like" })).status, 200);
  const all = await messages(s.owner);
  const reply = all.find((m) => m.id === "a1")!;
  assert.equal(reply.at, (row.at as number) + 1, "stamped right after the question");
  assert.deepEqual((all.find((m) => m.id === answer.messageId)!.reactions as { by: string; type: string }[]).map((x) => [x.by, x.type]), [["max", "like"]], "its tapback, written by Bops Cloud");
  assert.equal((await turnById(s.owner, answer.turn))?.state, "done");
  for (const v of [ownerLive, memberLive]) await until(() => v.of("turn").some((e) => e.data.state === "done"), "done on every stream");
  // The member reads both from the workspace's state: their words and the bot's answer.
  const read = (await (await fetch(`${cloud.url}/v1/ws/${s.project}/state`, { headers: { Authorization: `Bearer ${keyOf(s.writer)}` } })).json()) as { messages: { id: string }[] };
  assert.deepEqual(read.messages.map((m) => m.id), [answer.messageId, "a1"]);
  // No Mac took part: nothing waits for one.
  assert.equal((await query("SELECT 1 FROM bops.cloud_pending WHERE user_id = $1", [s.owner])).rowCount, 0);
  for (const v of [ownerLive, memberLive, box]) v.close();
});

test("the same key again adds nothing, a turn is claimed once and only by its own computer, and one chat answers one at a time", async () => {
  const s = await setup();
  const other = randomUUID();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const first = (await (await act(s.writer, s.project, "key-same-00001", { act: "chat", chatId: "bot:max", text: "one" })).json()) as { messageId: string; turn: string };
  const again = (await (await act(s.writer, s.project, "key-same-00001", { act: "chat", chatId: "bot:max", text: "one" })).json()) as { messageId: string; turn: string };
  assert.deepEqual(again, { ...first, ok: true, macOn: true, stored: true });
  const second = (await (await act(s.writer, s.project, "key-same-00002", { act: "chat", chatId: "bot:max", text: "two" })).json()) as { turn: string };
  assert.equal((await turnsOf(s.owner)).length, 2);
  // Another computer of the owner's can't see it; the second of the chat waits for the first.
  assert.equal((await runner(s.owner, other, `/v1/runner/turns/${first.turn}/claim`, {})).status, 404);
  const busy = await runner(s.owner, s.desktop, `/v1/runner/turns/${second.turn}/claim`, {});
  assert.deepEqual([busy.status, ((await busy.json()) as { code: string }).code], [409, "busy"]);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${first.turn}/claim`, {})).status, 200);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${first.turn}/claim`, {})).status, 409, "never twice");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${second.turn}/claim`, {})).status, 409, "not while the first runs");
  // The first done: the second goes to the runner (again), and it's taken.
  const before = box.of("turn").filter((e) => e.data.id === second.turn).length;
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${first.turn}/done`, { state: "done" })).status, 200);
  await until(() => box.of("turn").filter((e) => e.data.id === second.turn).length > before, "the next turn of the chat");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${second.turn}/claim`, {})).status, 200);
  // A computer can't speak for the member (no stamp of its own), nor write a turn's answer it doesn't hold.
  const forged = await writeAs(s.owner, s.desktop, [{ id: "f1", chatId: "bot:max", role: "bot", botId: "max", text: "hi", at: Date.now(), member: { userId: s.writer, name: "Wren", ref: "x" } }]);
  assert.equal(forged.status, 403);
  const notHers = await writeAs(s.owner, s.desktop, [{ id: "f2", chatId: "bot:max", role: "bot", botId: "max", text: "hi", at: Date.now(), turn: first.turn.replace("0001", "9999") }]);
  assert.equal(notHers.status, 403);
  box.close();
});

test("a runner that goes quiet: owed again before it acted, ended with a note after, and its late rows are refused", async () => {
  const s = await setup();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const a = (await (await act(s.writer, s.project, "key-lost-00001", { act: "chat", chatId: "bot:max", text: "check the inbox" })).json()) as { turn: string; messageId: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  await query("UPDATE bops.chat_turns SET lease_until = now() - interval '1 second' WHERE user_id = $1 AND id = $2", [s.owner, a.turn]);
  await sweepTurns();
  assert.equal((await turnById(s.owner, a.turn))?.state, "owed", "nothing was done yet: owed again");
  await until(() => box.of("turn-cancel").some((e) => e.data.id === a.turn), "the old claim cancelled");
  // What the old claim writes now is refused; the turn is given out again.
  assert.equal((await writeAs(s.owner, s.desktop, [{ id: "late1", chatId: "bot:max", role: "bot", botId: "max", text: "late", at: Date.now(), turn: a.turn }])).status, 403);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  // It did something that can't be done twice (an email sent), then went quiet: never run again.
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "tools" })).status, 200);
  await query("UPDATE bops.chat_turns SET lease_until = now() - interval '1 second' WHERE user_id = $1 AND id = $2", [s.owner, a.turn]);
  await sweepTurns();
  const t = await turnById(s.owner, a.turn);
  assert.deepEqual([t?.state, t?.note], ["failed", "midway"]);
  const note = (await messages(s.owner)).find((m) => m.id === `${a.messageId}_note`);
  assert.equal(note?.text, "Max stopped partway through this answer. Send it again to try once more.");
  assert.equal(note?.role, "system");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "tools" })).status, 409, "the runner hears it's over");
  box.close();
});

test("a turn paused for an OK keeps no lease and isn't swept, and ends when the runner says so", async () => {
  const s = await setup();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const a = (await (await act(s.writer, s.project, "key-pause-0001", { act: "chat", chatId: "bot:max", text: "send it" })).json()) as { turn: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "paused" })).status, 400, "a pause names its ask");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "paused", approvalId: "ask1" })).status, 200);
  await sweepTurns();
  assert.deepEqual([(await turnById(s.owner, a.turn))?.state, (await turnById(s.owner, a.turn))?.approvalId], ["paused", "ask1"]);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "done" })).status, 200);
  assert.equal((await turnById(s.owner, a.turn))?.state, "done");
  box.close();
});

test("without Use its computer the message stays with a note, nothing is woken, and no turn is owed", async () => {
  const s = await setup();
  const before = wakes.length;
  const r = await act(s.noUse, s.project, "key-nouse-0001", { act: "chat", chatId: "bot:max", text: "run this" });
  assert.equal(r.status, 202);
  const a = (await r.json()) as { stored: boolean; turn?: string; messageId: string };
  assert.deepEqual([a.stored, a.turn], [true, undefined]);
  const all = await messages(s.owner);
  assert.ok(all.some((m) => m.id === a.messageId));
  assert.equal(all.find((m) => m.id === `${a.messageId}_note`)?.text, `Tara hasn't let ${s.noUse} use Max's computer, so Max won't answer this.`);
  assert.equal((await turnsOf(s.owner)).length, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(wakes.length, before);
  // A group: written here too, and handed to the owner's Mac to answer (one answerer per group comes later).
  const g = (await (await act(s.writer, s.project, "key-group-0001", { act: "chat", chatId: "team", text: "all of you" })).json()) as { messageId: string; turn?: string };
  assert.equal(g.turn, undefined, "a group isn't owed here yet");
  assert.ok((await messages(s.owner)).some((m) => m.id === g.messageId && (m.member as { userId: string }).userId === s.writer));
  const waiting = await query<{ payload: { stored: boolean; messageId: string } }>("SELECT payload FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'member'", [s.owner]);
  assert.deepEqual(waiting.rows.map((r) => [r.payload.stored, r.payload.messageId]), [[true, g.messageId]]);
  assert.equal((await noteOf(s.owner, `${g.messageId}_note`)), "Tara's Mac answers in this group, so the bots will answer once Tara opens Bops.");
});

test("a computer with no runner is woken once however many turns wait, they go to the runner as it connects, and a refusal ends them with a note", async () => {
  const s = await setup();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  wakeAnswers.set(s.desktop, async () => {
    await held;
    return { state: "woke" };
  });
  const a = (await (await act(s.writer, s.project, "key-wake-00001", { act: "chat", chatId: "bot:max", text: "a" })).json()) as { turn: string };
  const b = (await (await act(s.writer, s.project, "key-wake-00002", { act: "chat", chatId: "bot:dana", text: "b" })).json()) as { turn: string };
  await until(() => wakes.some((w) => w.desktopId === s.desktop), "the wake");
  await new Promise((r) => setTimeout(r, 100));
  const asked = wakes.filter((w) => w.desktopId === s.desktop);
  assert.equal(asked.length, 1, "one wake for both");
  assert.deepEqual([asked[0].userId, asked[0].allowHourly, asked[0].signed], [s.owner, false, true]);
  release();
  await until(async () => (await turnById(s.owner, a.turn))?.state === "waking", "waking");
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  await until(() => [a.turn, b.turn].every((id) => box.of("turn").some((e) => e.data.id === id)), "both turns on the runner's stream");
  box.close();

  // Billed by the hour, and the owner hasn't allowed it: refused with a note. Allowed: the ask says so.
  const h = await setup();
  wakeAnswers.set(h.desktop, () => ({ state: "hourly" }));
  const c = (await (await act(h.writer, h.project, "key-hourly-001", { act: "chat", chatId: "bot:max", text: "c" })).json()) as { turn: string; messageId: string };
  await until(async () => (await turnById(h.owner, c.turn))?.state === "failed", "refused");
  await until(async () => (await messages(h.owner)).some((m) => m.id === `${c.messageId}_note`), "the note");
  assert.equal((await noteOf(h.owner, `${c.messageId}_note`)), "Max's computer is paid by the hour, and Tara hasn't let messages wake it, so Max can't answer this.");
  assert.equal((await fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers: own(h.owner), body: JSON.stringify({ wsId: "ws_acme", allowHourly: true }) })).status, 200);
  wakeAnswers.set(h.desktop, () => ({ state: "stopped" }));
  await act(h.writer, h.project, "key-hourly-002", { act: "chat", chatId: "bot:max", text: "d" });
  await until(() => wakes.some((w) => w.desktopId === h.desktop && w.allowHourly), "an ask that allows it");
});

test("a member removed: what they're owed ends at once, and the runner holding it hears it", async () => {
  const s = await setup();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const a = (await (await act(s.writer, s.project, "key-gone-00001", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string };
  const b = (await (await act(s.writer, s.project, "key-gone-00002", { act: "chat", chatId: "bot:dana", text: "y" })).json()) as { turn: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  delete roles[`${s.writer} ${s.project}`];
  assert.equal((await membersChanged(s.project, s.writer)).status, 204);
  await until(async () => (await turnById(s.owner, a.turn))?.state === "expired" && (await turnById(s.owner, b.turn))?.state === "expired", "both ended");
  await until(() => box.of("turn-cancel").some((e) => e.data.id === a.turn), "the runner told");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${b.turn}/claim`, {})).status, 410);
  assert.equal((await writeAs(s.owner, s.desktop, [{ id: "after", chatId: "bot:max", role: "bot", botId: "max", text: "z", at: Date.now(), turn: a.turn }])).status, 403, "nothing more for it");
  box.close();
});

test("orgo-web's word on Use its computer is the one Bops Cloud goes by: its no wins over the owner's state, its yes stands where that never set it, and the owner turning it off still ends a turn", async () => {
  const s = await setup();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const view = async (member: string) =>
    ((await (await fetch(`${cloud.url}/v1/ws/${s.project}/state`, { headers: { Authorization: `Bearer ${keyOf(member)}` } })).json()) as { state: { computer?: string } }).state.computer;
  // The writer's entry says "use", but orgo-web (which keeps it) says no; the other's was never set, and orgo-web says yes.
  orgoSays(s.writer, s.project, { computerUse: false });
  orgoSays(s.noUse, s.project, { computerUse: true });
  const before = wakes.length;
  const no = (await (await act(s.writer, s.project, "key-orgo-no-01", { act: "chat", chatId: "bot:max", text: "run it" })).json()) as { turn?: string; messageId: string };
  assert.equal(no.turn, undefined, "nothing owed");
  assert.equal((await noteOf(s.owner, `${no.messageId}_note`)), "Tara hasn't let Wren use Max's computer, so Max won't answer this.");
  assert.equal(await view(s.writer), undefined, "their window says they can't");
  // orgo-web's yes: owed, claimed, and beating on the computer, though the owner's state never set it.
  const yes = (await (await act(s.noUse, s.project, "key-orgo-yes-1", { act: "chat", chatId: "bot:max", text: "run it" })).json()) as { turn: string; messageId: string };
  assert.ok(yes.turn, "owed to the computer");
  assert.equal((await query<{ member: { computerUse?: boolean } }>("SELECT member FROM bops.chat_turns WHERE user_id = $1 AND id = $2", [s.owner, yes.turn])).rows[0].member.computerUse, true, "orgo-web's word goes with the turn");
  const c = await runner(s.owner, s.desktop, `/v1/runner/turns/${yes.turn}/claim`, {});
  assert.equal(c.status, 200, await c.clone().text());
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${yes.turn}/beat`, { phase: "model" })).status, 200);
  assert.equal(await view(s.noUse), "use");
  assert.equal(wakes.length, before, "the runner was listening: nothing woken");
  // The owner's Mac turns it off (orgo-web first, then its copy): the copy alone ends the turn before orgo-web's notice lands.
  await ownerChanges(s.owner, (st) => {
    const acme = st.workspaces.find((w) => w.id === "ws_acme")!;
    acme.memberAccess![`${s.noUse}@example.com`] = { ...acme.memberAccess![`${s.noUse}@example.com`], computer: "none" };
  });
  await until(async () => (await turnById(s.owner, yes.turn))?.state === "failed", "ended on the owner's write");
  await until(() => box.of("turn-cancel").some((e) => e.data.id === yes.turn), "the runner told");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${yes.turn}/beat`, { phase: "model" })).status, 409);
  box.close();
});

test("an Admin with no entry: their message is owed to the computer and claimed with the role; made a member with no entry, the turn's next beat is refused", async () => {
  const s = await setup();
  const admin = user("admin");
  roles[`${admin} ${s.project}`] = { role: "admin", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme", computerUse: false };
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const r = (await (await act(admin, s.project, "key-admin-01", { act: "chat", chatId: "bot:max", text: "Plan the launch" })).json()) as { turn?: string; messageId: string };
  assert.ok(r.turn, "owed to the computer, with no entry and orgo-web's column at no");
  const row = (await query<{ member: { role?: string } }>("SELECT member FROM bops.chat_turns WHERE user_id = $1 AND id = $2", [s.owner, r.turn])).rows[0];
  assert.equal(row.member.role, "admin", "the role goes with the turn");
  const c = await runner(s.owner, s.desktop, `/v1/runner/turns/${r.turn}/claim`, {});
  assert.equal(c.status, 200, await c.clone().text());
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${r.turn}/beat`, { phase: "model" })).status, 200);
  // Made a member on orgo.ai: the notice ends what's owed to them.
  roles[`${admin} ${s.project}`] = { role: "member", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme" };
  assert.equal((await membersChanged(s.project, admin)).status, 204);
  await until(async () => (await turnById(s.owner, r.turn!))?.state === "expired", "ended on the notice");
  await until(() => box.of("turn-cancel").some((e) => e.data.id === r.turn), "the runner told");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${r.turn}/beat`, { phase: "model" })).status, 409);
  box.close();
});

/** A Bops whose own writes keep an Admin's How I work that Bops Cloud kept (CLOUD_PERSONA_MIN_VERSION), as the owner's Mac says it on each call. */
const NEW_MAC = "0.0.42";
/** The owner's last Mac said `version` (NEW_MAC), as their account keeps it (cloud/app-version.ts; /v1/session makes the row, which these owners never called). */
const macSaid = (owner: string, version = NEW_MAC) =>
  query("INSERT INTO bops.cloud_accounts (user_id, app_version) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET app_version = EXCLUDED.app_version", [owner, version]);
/** The owner's state as their Mac reads it from Bops Cloud (persist-cloud.ts load). */
const ownersState = async (owner: string) => (await (await fetch(`${cloud.url}/v1/state`, { headers: own(owner, "mac-o", NEW_MAC) })).json()) as { version: number; state: { bots: Record<string, unknown>[] } };
const botOf = (state: { bots: Record<string, unknown>[] }, id: string) => state.bots.find((b) => b.id === id)!;

test("an Admin's How I work with the owner's Mac shut: Bops Cloud keeps it at once, the bot's next turn on its computer has it, nothing waits ten minutes, and the owner's Mac reads it as it opens", async (t) => {
  const s = await setup();
  const admin = user("admin");
  roles[`${admin} ${s.project}`] = { role: "admin", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme" };
  // The owner's own words on Max, and their last Mac new enough to take an Admin's How I work (ADMIN_PUBLISH_MIN_VERSION): shut now (no tunnel).
  const head = await ownersState(s.owner);
  botOf(head.state, "max").persona = "Sign off as Tara.";
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: own(s.owner, "mac-o", NEW_MAC), body: JSON.stringify({ base: head.version, state: head.state }) })).status, 200);
  await macSaid(s.owner);
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  t.after(() => box.close());

  const r = await act(admin, s.project, "key-persona-01", { act: "persona", botId: "max", text: "Keep replies short.", was: "Sign off as Tara." });
  assert.equal(r.status, 202, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, macOn: true, stored: true }, "kept now: their window says Saved once its copy has it");
  // Nothing waits for the owner's Mac, so nothing is dropped at MEMBER_ACT_MS.
  assert.equal((await query("SELECT 1 FROM bops.cloud_pending WHERE user_id = $1", [s.owner])).rowCount, 0);

  // The bot's next turn on its computer: the runner claims it and reads the bot as it makes the turn's instructions (lib/server/chat.ts persona: personaOf, howIWork).
  const chat = (await (await act(admin, s.project, "key-persona-chat", { act: "chat", chatId: "bot:max", text: "Plan the launch" })).json()) as { turn?: string };
  assert.ok(chat.turn, "owed to the computer");
  await until(() => box.of("turn").some((e) => e.data.id === chat.turn), "the runner's turn event");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${chat.turn}/claim`, {})).status, 200);
  const onComputer = botOf(((await (await runner(s.owner, s.desktop, "/v1/state")).json()) as { state: { bots: Record<string, unknown>[] } }).state, "max");
  const by = onComputer.personaBy as { name: string; ownerText?: string };
  assert.deepEqual([onComputer.persona, by.name, by.ownerText], ["Keep replies short.", admin, "Sign off as Tara."], "the Admin's words, named as theirs; the owner's own kept for work on their Mac");
  assert.match(howIWork("Tara", onComputer.persona as string, false, by.name), new RegExp(`How ${admin}, an Admin of Tara's workspace, wants you to work[\\s\\S]*Keep replies short\\.`));

  // The owner's Mac opens: the state it loads has the Admin's words, and the chat says who changed them.
  const opened = botOf((await ownersState(s.owner)).state, "max");
  assert.deepEqual([opened.persona, (opened.personaBy as { name: string }).name], ["Keep replies short.", admin]);
  assert.equal(await noteOf(s.owner, `msg_persona_${admin}_key-persona-01`), `${admin} changed how Max works`);
  // Sent again (a lost answer): nothing changes, no second note.
  const v = (await ownersState(s.owner)).version;
  assert.equal((await act(admin, s.project, "key-persona-01", { act: "persona", botId: "max", text: "Keep replies short.", was: "Sign off as Tara." })).status, 202);
  assert.equal((await ownersState(s.owner)).version, v);
});

test("an Admin's How I work for an owner whose last Mac is older than CLOUD_PERSONA_MIN_VERSION waits for that Mac as before, even with it shut: Bops Cloud never writes it, so that Mac's next save can't put the owner's words back over it", async () => {
  const s = await setup();
  const admin = user("admin");
  roles[`${admin} ${s.project}`] = { role: "admin", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme" };
  // 0.0.41 takes an Admin's How I work (ADMIN_PUBLISH_MIN_VERSION), but merges its own later write of the bot without keeping one Bops Cloud kept.
  await macSaid(s.owner, "0.0.41");
  const r = await act(admin, s.project, "key-oldmac-01", { act: "persona", botId: "max", text: "Keep replies short.", was: "" });
  assert.equal(r.status, 202, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, macOn: false }, "queued for the owner's Mac, as before");
  assert.equal((await query("SELECT 1 FROM bops.cloud_pending WHERE user_id = $1", [s.owner])).rowCount, 1, "one act waiting for it");
  const kept = (await query<{ state: { bots: Record<string, unknown>[] } }>("SELECT state FROM bops.app_state WHERE user_id = $1", [s.owner])).rows[0].state;
  assert.equal(botOf(kept, "max").persona, undefined, "never written by Bops Cloud");
  assert.equal((await messages(s.owner)).some((m) => m.id === `msg_persona_${admin}_key-oldmac-01`), false, "nor said in the chat");
});

test("an Admin's later How I work wins over an earlier one, one begun from older words is refused, and a Member or a demoted Admin never changes it, with the owner's Mac shut", async () => {
  const s = await setup();
  const admin = user("admin");
  roles[`${admin} ${s.project}`] = { role: "admin", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme" };
  await macSaid(s.owner);
  const persona = (key: string, text: string, was: string, who = admin) => act(who, s.project, key, { act: "persona", botId: "max", text, was });
  assert.equal((await persona("key-later-01", "Keep replies short.", "")).status, 202);
  assert.equal((await persona("key-later-02", "Answer in French.", "Keep replies short.")).status, 202);
  // Begun from the words before the first: someone saved since, so it's refused and the newer words stay.
  const stale = await persona("key-later-03", "Use bullet points.", "");
  assert.deepEqual([stale.status, ((await stale.json()) as { error: string }).error], [409, "Changed by someone else. Here's the latest."]);
  const max = botOf((await ownersState(s.owner)).state, "max");
  assert.deepEqual([max.persona, (max.personaBy as { ownerText?: string }).ownerText], ["Answer in French.", undefined], "the later edit; the owner had no words of their own");
  // A Member with Write on Max: an Admin's alone.
  const m = await persona("key-later-04", "Mine", "Answer in French.", s.writer);
  assert.deepEqual([m.status, ((await m.json()) as { code: string }).code], [403, "admin_only"]);
  // Made a Member on orgo.ai since (asked afresh as it's taken), or removed: refused, nothing written.
  roles[`${admin} ${s.project}`] = { role: "member", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme" };
  clearAuthCache();
  assert.equal((await persona("key-later-05", "Demoted", "Answer in French.")).status, 403);
  delete roles[`${admin} ${s.project}`];
  assert.equal((await persona("key-later-06", "Removed", "Answer in French.")).status, 404);
  assert.equal(botOf((await ownersState(s.owner)).state, "max").persona, "Answer in French.");
  assert.equal((await query("SELECT 1 FROM bops.cloud_pending WHERE user_id = $1", [s.owner])).rowCount, 0, "nothing queued for the Mac either");
});

test("an Admin removed while their How I work is on its way: orgo-web's notice that lands before it's written refuses it, and nothing is kept", async () => {
  const s = await setup();
  const admin = user("admin");
  roles[`${admin} ${s.project}`] = { role: "admin", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme" };
  await macSaid(s.owner);
  let release = () => {};
  const hold = { until: new Promise<void>((r) => (release = r)), reached: false };
  held.set(`${admin} ${s.project}`, hold);
  const sent = act(admin, s.project, "key-race-01", { act: "persona", botId: "max", text: "Too late", was: "" });
  await until(() => hold.reached, "orgo-web asked");
  assert.equal((await membersChanged(s.project, admin)).status, 204);
  held.delete(`${admin} ${s.project}`);
  release();
  // orgo-web's answer from before the notice still says Admin (and so does asking again): the notice refuses it all the same.
  assert.equal((await sent).status, 404);
  assert.equal(botOf((await ownersState(s.owner)).state, "max").persona, undefined);
  assert.equal((await messages(s.owner)).some((m) => m.id === `msg_persona_${admin}_key-race-01`), false);
});

test("an Admin's How I work with the owner's Mac on, or in a workspace whose chat stays on the Mac, waits for that Mac as before", async (c) => {
  const s = await setup();
  const admin = user("admin");
  roles[`${admin} ${s.project}`] = { role: "admin", ownerUserId: s.owner, bopsWsId: "ws_acme", name: "Acme" };
  await macSaid(s.owner);
  const mac = await connectMac(cloud.url, s.owner, { headers: { "x-bops-version": NEW_MAC } });
  c.after(() => mac.ws.close());
  const on = await act(admin, s.project, "key-macon-01", { act: "persona", botId: "max", text: "Keep replies short.", was: "" });
  assert.deepEqual((await on.json()) as Record<string, unknown>, { ok: true, macOn: true }, "handed to the owner's Mac, which saves it as its own Save does");
  await until(() => mac.frames.some((f) => f.t === "event" && (f.payload as MemberActPayload).key === "key-macon-01"), "the Mac's event");
  assert.equal(botOf((await ownersState(s.owner)).state, "max").persona, undefined, "never written by Bops Cloud while the Mac is on");
  mac.ws.close();
  await mac.closed;
  await until(async () => (await query("SELECT 1 FROM bops.cloud_pending WHERE user_id = $1 AND delivered_at IS NULL", [s.owner])).rowCount === 0, "the Mac's ack");
  const t = await setup({ cloud: false });
  roles[`${admin} ${t.project}`] = { role: "admin", ownerUserId: t.owner, bopsWsId: "ws_acme", name: "Acme" };
  await macSaid(t.owner);
  const off = await act(admin, t.project, "key-macoff-01", { act: "persona", botId: "max", text: "Keep replies short.", was: "" });
  assert.deepEqual((await off.json()) as Record<string, unknown>, { ok: true, macOn: false });
  assert.equal((await query("SELECT 1 FROM bops.cloud_pending WHERE user_id = $1", [t.owner])).rowCount, 1);
});

test("Use its computer turned off in orgo-web: its notice ends what's owed and running for them, and what they say next stays with a note", async () => {
  const s = await setup();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  orgoSays(s.writer, s.project, { computerUse: true });
  const a = (await (await act(s.writer, s.project, "key-orgo-off-1", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string };
  const b = (await (await act(s.writer, s.project, "key-orgo-off-2", { act: "chat", chatId: "bot:dana", text: "y" })).json()) as { turn: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  // Turned off there (the owner's state still says "use"), and orgo-web tells Bops Cloud.
  orgoSays(s.writer, s.project, { computerUse: false });
  assert.equal((await membersChanged(s.project, s.writer)).status, 204);
  await until(async () => (await turnById(s.owner, a.turn))?.state === "expired" && (await turnById(s.owner, b.turn))?.state === "expired", "both ended");
  await until(() => box.of("turn-cancel").some((e) => e.data.id === a.turn), "the runner told");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "model" })).status, 409);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${b.turn}/claim`, {})).status, 410);
  const next = (await (await act(s.writer, s.project, "key-orgo-off-3", { act: "chat", chatId: "bot:max", text: "z" })).json()) as { turn?: string; messageId: string };
  assert.equal(next.turn, undefined);
  assert.equal((await noteOf(s.owner, `${next.messageId}_note`)), "Tara hasn't let Wren use Max's computer, so Max won't answer this.");
  box.close();
});

test("Use its computer taken away after the message: the runner's claim is refused, and the chat says why", async () => {
  const s = await setup();
  const a = (await (await act(s.writer, s.project, "key-taken-0001", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string; messageId: string };
  const head = (await (await fetch(`${cloud.url}/v1/state`, { headers: own(s.owner) })).json()) as { version: number; state: { workspaces: { id: string; memberAccess?: Record<string, Record<string, unknown>> }[] } };
  const acme = head.state.workspaces.find((w) => w.id === "ws_acme")!;
  acme.memberAccess![`${s.writer}@example.com`].computer = "none";
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: own(s.owner), body: JSON.stringify({ base: head.version, state: head.state }) })).status, 200);
  const c = await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {});
  assert.deepEqual([c.status, ((await c.json()) as { code: string }).code], [410, "over"]);
  assert.equal((await turnById(s.owner, a.turn))?.state, "failed");
  assert.equal((await noteOf(s.owner, `${a.messageId}_note`)), "Tara hasn't let Wren use Max's computer, so Max won't answer this.");
});

test("the owner's own message goes through Bops Cloud too, only in a one bot chat of a switched workspace", async () => {
  const s = await setup();
  const send = (chatId: string, body: Record<string, unknown>) => fetch(`${cloud.url}/v1/chats/${chatId}/send`, { method: "POST", headers: own(s.owner), body: JSON.stringify(body) });
  const r = await send("bot:max", { key: "owner-key-0001", text: "hello Max" });
  assert.equal(r.status, 200);
  const a = (await r.json()) as { message: Record<string, unknown>; turn: string };
  assert.deepEqual([a.message.id, a.message.role, a.message.member, a.turn], ["msg_o_owner-key-0001", "user", undefined, "turn_msg_o_owner-key-0001"]);
  const again = (await (await send("bot:max", { key: "owner-key-0001", text: "hello Max" })).json()) as { turn: string };
  assert.equal(again.turn, a.turn);
  assert.equal((await turnsOf(s.owner)).length, 1);
  for (const [chat, why] of [["team", "a group"], ["bot:zed", "a bot on the Mac"], ["bot:boppy", "a workspace not switched"]] as const) {
    const no = await send(chat, { key: "owner-key-0002", text: "hi" });
    assert.deepEqual([no.status, ((await no.json()) as { code: string }).code], [409, "chat_not_in_cloud"], why);
  }
  // A computer can't send as the owner.
  assert.equal((await runner(s.owner, s.desktop, "/v1/chats/bot:max/send", { key: "owner-key-0003", text: "hi" })).status, 403);  // As a Mac sends it (lib/server/cloud-chat.ts encodes the chat id: "bot%3Amax"): the same chat.
  const enc = await send(encodeURIComponent("bot:max"), { key: "owner-key-0001e", text: "hello again" });
  assert.equal(enc.status, 200, await enc.clone().text());
  assert.equal(((await enc.json()) as { message: { chatId: string } }).message.chatId, "bot:max");
  // Not a chat id once decoded: no such route.
  assert.equal((await send("bot%2Fmax", { key: "owner-key-0001f", text: "x" })).status, 404);
});

test("an owner whose Mac is older than CLOUD_ALL_MIN_VERSION, as before: a bot on the owner's Mac has Bops Cloud write the message, the Mac is handed it to answer, and the chat says so while the Mac is away", async () => {
  const s = await setup();
  const r = await act(s.writer, s.project, "key-onmac-0001", { act: "chat", chatId: "bot:zed", text: "on the Mac" });
  const a = (await r.json()) as { messageId: string; turn?: string };
  assert.equal(a.turn, undefined);
  const waiting = await query<{ payload: { stored: boolean; messageId: string } }>("SELECT payload FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'member'", [s.owner]);
  assert.deepEqual([waiting.rows[0]?.payload.stored, waiting.rows[0]?.payload.messageId], [true, a.messageId]);
  assert.equal((await noteOf(s.owner, `${a.messageId}_note`)), "Zed works on Tara's Mac, so Zed will answer once Tara opens Bops.");
});

test("with the switch off nothing changes: the act waits for the owner's Mac as before", async () => {
  const s = await setup({ cloud: false });
  const a = (await (await act(s.writer, s.project, "key-off-000001", { act: "chat", chatId: "bot:max", text: "old way" })).json()) as { stored?: boolean };
  assert.equal(a.stored, undefined);
  assert.equal((await query("SELECT 1 FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'member'", [s.owner])).rowCount, 1);
  assert.equal((await messages(s.owner)).length, 0);
  clearAuthCache();
});

/** The owner's state now, changed by `change`, written back (as their Mac does). */
async function ownerChanges(owner: string, change: (state: { workspaces: { id: string; chatOn?: string; memberAccess?: Record<string, Record<string, unknown>> }[] }) => void, headers = own(owner)) {
  const head = (await (await fetch(`${cloud.url}/v1/state`, { headers: own(owner) })).json()) as { version: number; state: { workspaces: { id: string; memberAccess?: Record<string, Record<string, unknown>> }[] } };
  change(head.state);
  const r = await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers, body: JSON.stringify({ base: head.version, state: head.state }) });
  assert.equal(r.status, 200, await r.text());
}

test("Use its computer turned off while a turn runs: its next beat is refused, the runner hears turn-cancel, and the chat says why", async () => {
  const s = await setup();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const a = (await (await act(s.writer, s.project, "key-run-off-01", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string; messageId: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "model" })).status, 200);
  await ownerChanges(s.owner, (st) => (st.workspaces.find((w) => w.id === "ws_acme")!.memberAccess![`${s.writer}@example.com`].computer = "none"));
  // The owner's write itself ends it (recheckTurns), and a beat that comes after is refused.
  await until(async () => (await turnById(s.owner, a.turn))?.state === "failed", "ended on the owner's write");
  await until(() => box.of("turn-cancel").some((e) => e.data.id === a.turn), "the runner told");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "model" })).status, 409);
  assert.equal((await noteOf(s.owner, `${a.messageId}_note`)), "Tara hasn't let Wren use Max's computer, so Max won't answer this.");
  assert.equal((await writeAs(s.owner, s.desktop, [{ id: "after-off", chatId: "bot:max", role: "bot", botId: "max", text: "z", at: Date.now(), turn: a.turn }])).status, 403, "nothing more for it");
  box.close();
});

test("a beat checks the member again even when no write told Bops Cloud (a state written another way)", async () => {
  const s = await setup();
  const a = (await (await act(s.writer, s.project, "key-beat-chk01", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  // Write taken away straight in the table (no PUT, so no recheck): the beat is what catches it.
  await query(`UPDATE bops.app_state SET state = jsonb_set(state, '{workspaces,1,memberAccess}', '{}'::jsonb) WHERE user_id = $1`, [s.owner]);
  const b = await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "tools" });
  assert.deepEqual([b.status, ((await b.json()) as { code: string }).code], [409, "over"]);
  const t = await turnById(s.owner, a.turn);
  assert.deepEqual([t?.state, t?.note, t?.claimedBy], ["failed", "gone", null]);
});

test("a paused turn: a beat never wakes it, it goes on only through resume for its own OK, and not once its member lost Use its computer", async () => {
  const s = await setup();
  const a = (await (await act(s.writer, s.project, "key-pz-000001", { act: "chat", chatId: "bot:max", text: "send it" })).json()) as { turn: string; messageId: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "paused", approvalId: "ask-pz" })).status, 200);
  // A beat that was on its way lands after the pause: refused, the turn stays paused (no lease, never swept as midway).
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "tools" })).status, 409);
  await sweepTurns();
  assert.equal((await turnById(s.owner, a.turn))?.state, "paused");
  // Only for the OK its pause named, and only from its own computer.
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/resume`, { approvalId: "another" })).status, 409);
  assert.equal((await runner(s.owner, randomUUID(), `/v1/runner/turns/${a.turn}/resume`, { approvalId: "ask-pz" })).status, 409);
  const r = await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/resume`, { approvalId: "ask-pz" });
  assert.equal(r.status, 200);
  const back = (await r.json()) as { now: number; humanAt: number };
  assert.ok(Math.abs(back.now - Date.now()) < 5000);
  assert.equal((await turnById(s.owner, a.turn))?.state, "claimed");
  assert.equal((await turnById(s.owner, a.turn))?.phase, "tools");
  // Paused again, then Use its computer turned off: the OK answered later never resumes it.
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "paused", approvalId: "ask-pz2" })).status, 200);
  await query(`UPDATE bops.app_state SET state = jsonb_set(state, '{workspaces,1,memberAccess,${s.writer}@example.com,computer}', '"none"'::jsonb) WHERE user_id = $1`, [s.owner]);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/resume`, { approvalId: "ask-pz2" })).status, 409);
  assert.deepEqual([(await turnById(s.owner, a.turn))?.state, (await turnById(s.owner, a.turn))?.note], ["failed", "noUse"]);
});

test("a pause from a member who lost Use its computer meanwhile is refused, and the turn ends", async () => {
  const s = await setup();
  const a = (await (await act(s.writer, s.project, "key-pz-lost-01", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  await query(`UPDATE bops.app_state SET state = jsonb_set(state, '{workspaces,1,memberAccess,${s.writer}@example.com,computer}', '"none"'::jsonb) WHERE user_id = $1`, [s.owner]);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "paused", approvalId: "ask-x" })).status, 409);
  assert.equal((await turnById(s.owner, a.turn))?.state, "failed");
});

test("a lost done after the answer was written: the sweep ends the turn done, never owes it again (no second answer)", async () => {
  const s = await setup();
  const a = (await (await act(s.writer, s.project, "key-lostdone01", { act: "chat", chatId: "bot:max", text: "hi" })).json()) as { turn: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.equal((await writeAs(s.owner, s.desktop, [{ id: "ans-1", chatId: "bot:max", role: "bot", botId: "max", text: "Hello!", at: Date.now(), turn: a.turn }])).status, 200);
  await query("UPDATE bops.chat_turns SET lease_until = now() - interval '1 second' WHERE user_id = $1 AND id = $2", [s.owner, a.turn]);
  await sweepTurns();
  assert.equal((await turnById(s.owner, a.turn))?.state, "done");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 410);
});

test("a turn owed to a runner that listens is offered again by the sweep when its first offer was missed", async () => {
  const s = await setup();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const a = (await (await act(s.writer, s.project, "key-offer-0001", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string };
  await until(() => box.of("turn").some((e) => e.data.id === a.turn), "the first offer");
  const n = box.of("turn").filter((e) => e.data.id === a.turn).length;
  await query("UPDATE bops.chat_turns SET updated_at = now() - interval '1 minute' WHERE user_id = $1 AND id = $2", [s.owner, a.turn]);
  await sweepTurns();
  await until(() => box.of("turn").filter((e) => e.data.id === a.turn).length > n, "offered again");
  box.close();
});

test("a computer orgo-web says is running whose runner never connects (one from before this build): its turns end with a plain note, not a wait for the deadline", async () => {
  const s = await setup();
  wakeAnswers.set(s.desktop, () => ({ state: "running" }));
  const a = (await (await act(s.writer, s.project, "key-norunner01", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string; messageId: string };
  await until(async () => (await turnById(s.owner, a.turn))?.state === "failed", "ended", 15_000);
  assert.equal((await turnById(s.owner, a.turn))?.note, "noRunner");
  await until(async () => (await messages(s.owner)).some((m) => m.id === `${a.messageId}_note`), "the note");
  assert.equal((await noteOf(s.owner, `${a.messageId}_note`)), "Max's computer is on, but it can't answer chats yet. Tara needs to open the updated Bops once to set it up.");
});

test("turning chat to Bops Cloud waits for a Bops new enough; an older Mac's save that drops the switch has it put back", async () => {
  const s = await setup({ cloud: false });
  const on = (headers: Record<string, string>) => fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers, body: JSON.stringify({ wsId: "ws_acme", mode: "cloud" }) });
  const old = await on(own(s.owner, "mac-o", "0.0.35"));
  assert.deepEqual([old.status, ((await old.json()) as { code: string }).code], [409, "chat_needs_update"]);
  assert.equal((await on(own(s.owner))).status, 200);
  // An older Bops saves the state without Workspace.chatOn: Bops Cloud keeps the switch on it.
  await ownerChanges(s.owner, (st) => delete st.workspaces.find((w) => w.id === "ws_acme")!.chatOn, own(s.owner, "mac-old", "0.0.35"));
  const now = (await (await fetch(`${cloud.url}/v1/state`, { headers: own(s.owner) })).json()) as { state: { workspaces: { id: string; chatOn?: string }[] } };
  assert.equal(now.state.workspaces.find((w) => w.id === "ws_acme")?.chatOn, "cloud");
});

test("without Use its computer, a member can't tell work on the bot's computer more or answer its asks; Stop still goes", async () => {
  const s = await setup({ cloud: false });
  await ownerChanges(s.owner, (st) => {
    const full = st as unknown as { sessions: unknown[]; appApprovals: unknown[] };
    full.sessions = [{ id: "t1", botId: "max", chatId: "bot:max", title: "Run", status: "running", replies: [] }];
    full.appApprovals = [
      { id: "ask-t", botId: "max", chatId: "bot:max", threadId: "t1", action: "Send an email", kind: "email", at: 1 },
      { id: "ask-c", botId: "max", chatId: "bot:max", action: "Run a command", kind: "brain", at: 1 },
    ];
  });
  for (const [k, a] of [
    ["key-nc-reply01", { act: "reply", sessionId: "t1", text: "do more" }],
    ["key-nc-dism001", { act: "dismiss", sessionId: "t1" }],
    ["key-nc-comp001", { act: "compact", sessionId: "t1" }],
    ["key-nc-answ001", { act: "answer", askId: "ask-t", reply: "once" }],
    ["key-nc-answ002", { act: "answer", askId: "ask-c", reply: "once" }],
  ] as const) {
    const r = await act(s.noUse, s.project, k, a);
    assert.deepEqual([r.status, ((await r.json()) as { code: string }).code], [403, "member_no_computer"], a.act);
  }
  assert.equal((await act(s.noUse, s.project, "key-nc-stop001", { act: "stop", sessionIds: ["t1"] })).status, 202);
  assert.equal((await act(s.writer, s.project, "key-nc-reply02", { act: "reply", sessionId: "t1", text: "do more" })).status, 202, "with it, as before");
});

/* ---------------- An app's GitHub production, from a shared workspace's Your Apps ---------------- */

const SHA = "a".repeat(40);
const INGOT = "b".repeat(64);
/** The owner's state as their Mac reads it from Bops Cloud, whole (ownersState, with apps). */
type Full = { version: number; state: { workspaces: { id: string; hostedApps?: Record<string, Record<string, unknown>>; appsForMembers?: { apps: Record<string, { acts?: Record<string, unknown>[] }> } }[] } };
const fullState = async (owner: string) => (await (await fetch(`${cloud.url}/v1/state`, { headers: own(owner, "mac-o", GITHUB_ACTS_MIN_VERSION) })).json()) as Full;
const acme = (f: Full) => f.state.workspaces.find((w) => w.id === "ws_acme")!;
const actsOn = async (owner: string, app = "site") => acme(await fullState(owner)).appsForMembers?.apps[app]?.acts ?? [];
/** What a member reads of the workspace, as a Bops that says its version (the GitHub acts are shown only to one at GITHUB_ACTS_MIN_VERSION). */
const readAs = async (who: string, project: string, version = GITHUB_ACTS_MIN_VERSION) =>
  (await (await fetch(`${cloud.url}/v1/ws/${project}/state`, { headers: { Authorization: `Bearer ${keyOf(who)}`, "x-bops-version": version } })).json()) as SharedWsState;

/**
 * A workspace of Orgo's team (its owner's email, as orgo-web says it, opens Your Apps) whose app "site" publishes to GitHub
 * (linked), at home on Max's computer, with a runner there the owner's Mac saw running (`runner`: its version; null: none),
 * Max given the GitHub key (`keyed`), and the owner's last Mac at `mac`. An Admin; Sam, a Member with Your Apps at Write and
 * App secrets; Ivy, at Write without the switch. The owner's Mac is shut (no tunnel).
 */
async function setupGithub(o: { runner?: string | null; keyed?: boolean; mac?: string } = {}) {
  const owner = user("owner");
  const admin = user("admin");
  const sam = user("secrets");
  const ivy = user("noswitch");
  const project = randomUUID();
  const desktop = randomUUID();
  const said = { ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme", ownerEmail: "owner@orgo.ai" };
  roles[`${owner} ${project}`] = { role: "owner", ...said };
  roles[`${admin} ${project}`] = { role: "admin", ...said };
  for (const m of [sam, ivy]) roles[`${m} ${project}`] = { role: "member", ...said };
  const DESKTOP = desktop.toUpperCase();
  const state = {
    owner: { name: "Tara" },
    workspaces: [
      { id: "ws_main", name: "Main" },
      {
        id: "ws_acme",
        name: "Acme",
        memberAccess: {
          [`${sam}@example.com`]: { others: "none", bots: { max: "read" }, apps: "write", can: { appSecrets: true } },
          [`${ivy}@example.com`]: { others: "none", bots: { max: "read" }, apps: "write" },
        },
        hostedApps: {
          site: {
            botId: "max",
            computerId: DESKTOP,
            projectId: "proj-1",
            url: "https://site.orgo.dev",
            github: { repo: "example-org/web", branch: "main", path: "formula", keep: ["proxy.ts"], last: { sha: SHA, ingot: INGOT, keep: ["proxy.ts"], when: 7 } },
          },
        },
        appsForMembers: { at: 10, apps: { site: { head: null, sites: [], commits: [], deploys: [] } } },
      },
    ],
    bots: [{ id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: DESKTOP, ...(o.keyed === false ? {} : { keys: ["GITHUB_TOKEN"] }) }],
    chats: [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" }],
    ...(o.runner === null ? {} : { runners: { [DESKTOP]: { status: "running", version: o.runner ?? GITHUB_ACTS_MIN_VERSION, buildId: "b1", by: "mac-o", at: 1 } } }),
  };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: own(owner, "mac-o", GITHUB_ACTS_MIN_VERSION), body: JSON.stringify({ base: 0, state }) })).status, 200);
  await macSaid(owner, o.mac ?? GITHUB_ACTS_MIN_VERSION);
  return { owner, admin, sam, ivy, project, desktop, device: deviceIdOf(owner, desktop) };
}
const pendingFor = async (owner: string) => (await query<{ payload: MemberActPayload }>("SELECT payload FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'member'", [owner])).rows.map((r) => r.payload);

test("an Admin's Bring in with the owner's Mac shut: owed to the app's own computer as a job (nothing waits for the Mac), Your Apps shows it going, the runner claims it with the job and its result is kept on the app", async (t) => {
  const s = await setupGithub();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  t.after(() => box.close());
  const r = await act(s.admin, s.project, "key-ghpull-01", { act: "githubPull", app: "site" });
  assert.equal(r.status, 202, await r.clone().text());
  const a = (await r.json()) as { turn: string };
  assert.deepEqual(a, { ok: true, macOn: true, stored: true, computer: true, turn: `turn_msg_job_${s.admin}_key-ghpull-01` });
  assert.deepEqual(await pendingFor(s.owner), [], "nothing waits for the owner's Mac");
  // Said in the app's bot's chat, as Bops' own; the turn carries the job and who asked, with the role.
  assert.equal(await noteOf(s.owner, `msg_job_${s.admin}_key-ghpull-01`), `${s.admin} asked Max's computer to bring in GitHub's changes to site.`);
  const row = (await query<{ member: { job?: unknown; role?: string; ref: string }; desktop_id: string }>("SELECT member, desktop_id FROM bops.chat_turns WHERE user_id = $1 AND id = $2", [s.owner, a.turn])).rows[0];
  assert.deepEqual([row.member.job, row.member.role, row.member.ref, row.desktop_id], [{ act: "githubPull", app: "site" }, "admin", "key-ghpull-01", s.desktop]);
  // Your Apps: going, named as theirs; and the GitHub part is theirs to use.
  const seen = await readAs(s.admin, s.project);
  assert.equal(seen.state.appGithub, true);
  const site = seen.state.apps!.list.find((x) => x.name === "site")!;
  assert.deepEqual(site.github?.linked, { sha: SHA, ingot: INGOT, when: 7 });
  assert.deepEqual(site.acts?.map((x) => [x.key, x.act, x.going, x.name]), [["key-ghpull-01", "githubPull", true, s.admin]]);
  // A Bops from before the GitHub acts is shown none of it.
  const old = await readAs(s.admin, s.project, "0.0.51");
  assert.deepEqual([old.state.apps!.list[0].acts, old.state.appGithub], [[], true], "(the owner's Mac takes them: the flag stays; the old window never reads it)");
  // The runner hears it and claims it, with the job; its row in the chat (Bops' own, about an app) is the turn's.
  await until(() => box.of("turn").some((e) => e.data.id === a.turn), "the job's turn event");
  const c = await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {});
  assert.equal(c.status, 200, await c.clone().text());
  const claim = (await c.json()) as { turn: { member: { job: unknown; name: string } } };
  assert.deepEqual(claim.turn.member.job, { act: "githubPull", app: "site" });
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/beat`, { phase: "tools" })).status, 200);
  const w = await writeAs(s.owner, s.desktop, [{ id: "job-row-1", chatId: "bot:max", role: "bot", botId: "max", text: "Brought 2 changes from GitHub into Ingot.", at: Date.now(), turn: a.turn, appNote: true, bops: true }]);
  assert.equal(w.status, 200, await w.text());
  // Its own state write moves only the point (computer-scope.ts hostingChangeAllowed): never where it publishes.
  const mine = (await (await runner(s.owner, s.desktop, "/v1/state")).json()) as Full;
  const moved = JSON.parse(JSON.stringify(mine)) as Full;
  acme(moved).hostedApps!.site.github = { ...(acme(moved).hostedApps!.site.github as Record<string, unknown>), last: { sha: "c".repeat(40), ingot: "d".repeat(64), keep: ["proxy.ts"], when: 9 } };
  const putAs = (body: Full) => fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: { Authorization: `Bearer ${vm(s.owner, s.desktop)}`, "x-bops-user": s.owner, "x-bops-protocol": "2", "content-type": "application/json" }, body: JSON.stringify({ base: body.version, state: body.state }) });
  const elsewhere = JSON.parse(JSON.stringify(mine)) as Full;
  acme(elsewhere).hostedApps!.site.github = { ...(acme(elsewhere).hostedApps!.site.github as Record<string, unknown>), repo: "example-org/other" };
  assert.equal((await putAs(elsewhere)).status, 403, "a runner never points it elsewhere");
  assert.equal((await putAs(moved)).status, 200, "its point, it may");
  // Its end, with how it went: kept on the app in place of going.
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "done", job: { ok: true, said: "Brought 2 changes from GitHub into Ingot." } })).status, 200);
  assert.equal((await turnById(s.owner, a.turn))?.state, "done");
  const kept = (await actsOn(s.owner))[0];
  assert.deepEqual([kept.key, kept.act, kept.ok, kept.going, kept.said, kept.name], ["key-ghpull-01", "githubPull", true, undefined, "Brought 2 changes from GitHub into Ingot.", s.admin]);
  assert.equal((acme(await fullState(s.owner)).hostedApps!.site.github as { last: { sha: string } }).last.sha, "c".repeat(40));
  // The same key again: the same turn, nothing new.
  const again = (await (await act(s.admin, s.project, "key-ghpull-01", { act: "githubPull", app: "site" })).json()) as { turn: string };
  assert.equal(again.turn, a.turn);
  assert.equal((await turnsOf(s.owner)).length, 1);
});

test("Save and link from a Member with App secrets: a new destination needs a GitHub key of the workspace's own; with it Bops Cloud keeps the setting (its point dropped, as Link must run again), says so, and owes the Link to the computer", async () => {
  const s = await setupGithub();
  const elsewhere = { repo: "example-org/other", branch: "main", path: "clients/acme" };
  // The workspace sees GitHub only through the owner's own key: refused, nothing written.
  liveKeys[s.project] = ["STRIPE_SECRET_KEY"];
  const before = (await fullState(s.owner)).version;
  const no = await act(s.sam, s.project, "key-ghset-001", { act: "github", app: "site", github: elsewhere, link: true });
  assert.deepEqual([no.status, ((await no.json()) as { code: string; error: string }).error], [403, GITHUB_KEY_LINE]);
  assert.equal((await fullState(s.owner)).version, before);
  // A key of its own (This workspace, in Keys): kept now, by Bops Cloud, the owner's Mac shut.
  liveKeys[s.project] = ["GITHUB_TOKEN"];
  const r = await act(s.sam, s.project, "key-ghset-002", { act: "github", app: "site", github: elsewhere, link: true });
  assert.equal(r.status, 202, await r.clone().text());
  assert.equal(((await r.json()) as { computer?: boolean }).computer, true, "its Link owed to the computer");
  const now = acme(await fullState(s.owner)).hostedApps!.site.github;
  assert.deepEqual(now, { ...elsewhere }, "the new destination, its point gone (a new folder needs a new Link)");
  assert.equal((await query<{ writer: string }>("SELECT writer FROM bops.app_state WHERE user_id = $1", [s.owner])).rows[0].writer, "cloud");
  assert.equal(await noteOf(s.owner, `msg_github_${s.sam}_key-ghset-002`), `${s.sam} set site to publish to GitHub example-org/other, main, folder clients/acme.`);
  assert.equal(await noteOf(s.owner, `msg_job_${s.sam}_key-ghset-002`), `${s.sam} asked Max's computer to link site to GitHub.`);
  assert.deepEqual((await actsOn(s.owner)).map((x) => [x.key, x.act, x.going]), [["key-ghset-002", "githubLink", true]], "one row for the act, going");
  delete liveKeys[s.project];
});

test("an Admin's setting with the same folder keeps its point, more left alone is fine without a key of the workspace's own, and null puts it back on Orgo", async () => {
  const s = await setupGithub();
  const same = { repo: "example-org/web", branch: "main", path: "formula", keep: ["proxy.ts", "clients/acme/"] };
  const r = await act(s.admin, s.project, "key-ghkeep-01", { act: "github", app: "site", github: same });
  assert.equal(r.status, 202, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, macOn: true, stored: true });
  assert.deepEqual(acme(await fullState(s.owner)).hostedApps!.site.github, { ...same, last: { sha: SHA, ingot: INGOT, keep: ["proxy.ts"], when: 7 } }, "the point holds");
  assert.deepEqual((await actsOn(s.owner)).map((x) => [x.act, x.ok, x.going]), [["github", true, undefined]]);
  // Sent again (a lost answer): nothing changes.
  const v = (await fullState(s.owner)).version;
  assert.equal((await act(s.admin, s.project, "key-ghkeep-01", { act: "github", app: "site", github: same })).status, 202);
  assert.equal((await fullState(s.owner)).version, v);
  // A path left alone taken off the list: its point goes (its Link was made with it left alone).
  assert.equal((await act(s.admin, s.project, "key-ghkeep-02", { act: "github", app: "site", github: { ...same, keep: ["clients/acme/"] } })).status, 202);
  assert.equal((acme(await fullState(s.owner)).hostedApps!.site.github as { last?: unknown }).last, undefined);
  // Back to Publish on Orgo.
  assert.equal((await act(s.admin, s.project, "key-ghkeep-03", { act: "github", app: "site", github: null })).status, 202);
  assert.equal(acme(await fullState(s.owner)).hostedApps!.site.github, undefined);
  assert.equal(await noteOf(s.owner, `msg_github_${s.admin}_key-ghkeep-03`), `${s.admin} set site to publish on Orgo again.`);
  // Bring in with nothing linked now: refused, as their window says it.
  const pull = await act(s.admin, s.project, "key-ghkeep-04", { act: "githubPull", app: "site" });
  assert.deepEqual([pull.status, ((await pull.json()) as { code: string }).code], [409, "not_linked"]);
});

test("who may: a Member without App secrets or the owner's last Mac older is refused; a runner older than the gate, or none, leaves it to the owner's Mac; only the key missing with that Mac off is said at once", async () => {
  const s = await setupGithub();
  const r1 = await act(s.ivy, s.project, "key-ghwho-001", { act: "githubPull", app: "site" });
  assert.deepEqual([r1.status, ((await r1.json()) as { code: string }).code], [403, "admin_only"]);
  assert.equal((await readAs(s.ivy, s.project)).state.appGithub, undefined, "no GitHub part for her");
  assert.equal((await readAs(s.sam, s.project)).state.appGithub, true);
  // The owner's last Mac older than the GitHub acts.
  const o = await setupGithub({ mac: "0.0.51" });
  const r2 = await act(o.admin, o.project, "key-ghwho-002", { act: "githubLink", app: "site" });
  assert.deepEqual([r2.status, ((await r2.json()) as { code: string }).code], [409, "owner_bops_old"]);
  assert.equal((await readAs(o.admin, o.project)).state.appGithub, undefined);
  // The app's computer's runner older than the gate: the owner's Mac does it when it opens (MEMBER_ACT_MS), as theirs.
  const old = await setupGithub({ runner: "0.0.51" });
  const r3 = await act(old.sam, old.project, "key-ghwho-003", { act: "githubPull", app: "site" });
  assert.equal(r3.status, 202);
  assert.deepEqual(await r3.json(), { ok: true, macOn: false });
  assert.deepEqual((await pendingFor(old.owner)).map((p) => [p.act, p.key, p.member.userId]), [[{ act: "githubPull", app: "site" }, "key-ghwho-003", old.sam]]);
  assert.equal((await turnsOf(old.owner)).length, 0, "no job for a runner from before");
  // No runner there at all: the same.
  const none = await setupGithub({ runner: null });
  assert.equal((await act(none.admin, none.project, "key-ghwho-004", { act: "githubLink", app: "site" })).status, 202);
  assert.equal((await pendingFor(none.owner)).length, 1);
  // A runner at the gate, but no bot on its computer was given the GitHub key, and the owner's Mac shut: said now.
  const nokey = await setupGithub({ keyed: false });
  const r5 = await act(nokey.admin, nokey.project, "key-ghwho-005", { act: "githubPull", app: "site" });
  const b5 = (await r5.json()) as { code: string; error: string };
  assert.deepEqual([r5.status, b5.code], [409, "github_no_key"]);
  assert.match(b5.error, /^Max's computer has no GitHub key, so it can't do this while the owner's Mac is off\. Give Max the GitHub key in Keys, then try again\.$/);
  assert.equal((await pendingFor(nokey.owner)).length, 0);
});

test("a job's end its computer never says is kept on the app too: a runner from before (done, no result), a computer that can't wake, and App secrets taken away meanwhile", async () => {
  // A runner that says it's at the gate but answers like one from before: done with no result is never a success.
  const s = await setupGithub();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  const a = (await (await act(s.sam, s.project, "key-ghend-001", { act: "githubLink", app: "site" })).json()) as { turn: string };
  await until(() => box.of("turn").some((e) => e.data.id === a.turn), "the job's turn event");
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "done" })).status, 200);
  assert.deepEqual((await actsOn(s.owner)).map((x) => [x.ok, x.said, x.going]), [[false, JOB_OLD_RUNNER, undefined]]);
  // App secrets turned off for Sam in Team before the computer took it: the job ends, and Your Apps says why.
  const b = (await (await act(s.sam, s.project, "key-ghend-002", { act: "githubPull", app: "site" })).json()) as { turn: string };
  await ownerChanges(s.owner, (st) => void (st.workspaces.find((w) => w.id === "ws_acme")!.memberAccess![`${s.sam}@example.com`].can = {}), own(s.owner, "mac-o", GITHUB_ACTS_MIN_VERSION));
  await until(async () => (await turnById(s.owner, b.turn))?.state === "failed", "ended as they may no longer");
  await until(async () => (await actsOn(s.owner))[0]?.going === undefined, "kept on the app");
  assert.deepEqual((await actsOn(s.owner)).slice(0, 1).map((x) => [x.key, x.ok, x.said]), [["key-ghend-002", false, "Who can do this changed, so it didn't go."]]);
  box.close();
  // A computer that can't wake (stopped): the chat's note, and the act says why.
  const w = await setupGithub();
  wakeAnswers.set(w.desktop, () => ({ state: "stopped" }));
  const c = (await (await act(w.admin, w.project, "key-ghend-003", { act: "githubPull", app: "site" })).json()) as { turn: string };
  await until(async () => (await turnById(w.owner, c.turn))?.state === "failed", "ended: it can't wake", 15_000);
  await until(async () => (await actsOn(w.owner))[0]?.going === undefined, "kept on the app");
  assert.deepEqual((await actsOn(w.owner)).map((x) => [x.ok, x.said]), [[false, "Max's computer is stopped. Tara can start it again."]]);
});

/* ---------------- Everything through the cloud: the plumbing (no workspace behaves differently yet) ---------------- */

/** A call from a computer's runner that says which Bops it runs (none: one that doesn't say). */
const runnerOn = (owner: string, desktop: string, version: string | null, path: string, body?: unknown) =>
  fetch(`${cloud.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${vm(owner, desktop)}`, "x-bops-user": owner, "x-bops-protocol": "2", "content-type": "application/json", ...(version ? { "x-bops-version": version } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const seenOf = async (owner: string) => (await query<{ desktop_id: string; device_id: string; version: string }>("SELECT desktop_id, device_id, version FROM bops.runner_seen WHERE user_id = $1", [owner])).rows;
/** The owner's state as it is in Postgres (what takeAppJob and runnerVersionOf read). */
const blobOf = async (owner: string) => (await query<{ state: Record<string, unknown> }>("SELECT state FROM bops.app_state WHERE user_id = $1", [owner])).rows[0].state;
/** A job turn owed to Max's computer, written as Bops Cloud writes one (takeAppJob), for kinds nothing owes yet. */
async function oweJob(s: { owner: string; desktop: string; device: string }, id: string, member: Omit<TurnMember, "job">, job: TurnJob, chatId = "bot:max") {
  await query(
    `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
     VALUES ($1, $2, $3, $4, 'max', 'ws_acme', $5::jsonb, $6, $7, 'owed', now() + make_interval(secs => $8), $9)`,
    [s.owner, id, `msg_${id}`, chatId, JSON.stringify({ ...member, job }), s.desktop, s.device, jobDeadline(job) / 1000, Date.now()],
  );
  return id;
}

test("a runner's own word on its Bops is kept as it connects and stays once it goes; one that says none, or nonsense, keeps nothing", async () => {
  const s = await setupGithub();
  const quiet = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  quiet.close();
  const junk = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "latest" });
  junk.close();
  assert.deepEqual(await seenOf(s.owner), [], "nothing said, nothing kept");
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.53" });
  await until(async () => (await seenOf(s.owner)).length === 1, "kept as it connected");
  assert.deepEqual(await seenOf(s.owner), [{ desktop_id: s.desktop.toLowerCase(), device_id: s.device, version: "0.0.53" }]);
  // Gone: its presence goes, what it runs stays.
  box.close();
  await until(async () => (await query("SELECT 1 FROM bops.runner_presence WHERE user_id = $1", [s.owner])).rowCount === 0, "the runner gone");
  assert.deepEqual((await seenOf(s.owner)).map((x) => x.version), ["0.0.53"]);
  // Upgraded and back: one row, the newer word.
  const again = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  await until(async () => (await seenOf(s.owner))[0]?.version === CLOUD_ALL_MIN_VERSION, "its newer word");
  again.close();
  assert.equal((await seenOf(s.owner)).length, 1);
});

test("runnerVersionOf: the newer of the owner's Mac's record and the runner's own word; a record that isn't running (being set up again, failed, being stopped) since it last said is no runner, and so is no record", async () => {
  const s = await setupGithub({ runner: "0.0.53" });
  const DESKTOP = s.desktop.toUpperCase();
  const blob = await blobOf(s.owner);
  assert.equal(await runnerVersionOf(null, s.owner, blob, s.desktop), "0.0.53", "the Mac's record alone");
  // It said it runs a newer one (an upgrade the Mac's record doesn't have yet): that.
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  box.close();
  await until(async () => (await seenOf(s.owner)).length === 1, "its word kept");
  assert.equal(await runnerVersionOf(null, s.owner, blob, DESKTOP), CLOUD_ALL_MIN_VERSION, "its own newer word, any case of the id");
  // Its word older than the Mac's record: the record.
  await query("UPDATE bops.runner_seen SET version = '0.0.50' WHERE user_id = $1", [s.owner]);
  assert.equal(await runnerVersionOf(null, s.owner, blob, s.desktop), "0.0.53");
  await query("UPDATE bops.runner_seen SET version = $2 WHERE user_id = $1", [s.owner, CLOUD_ALL_MIN_VERSION]);
  const seenAt = (await query<{ at: Date }>("SELECT seen_at AS at FROM bops.runner_seen WHERE user_id = $1", [s.owner])).rows[0].at.getTime();
  const record = (status: string, at: number) => ({ ...blob, runners: { [DESKTOP]: { status, version: "0.0.53", buildId: "b1", by: "mac-o", at } } });
  // The Mac's record says it failed, or is being stopped, after the runner last said: no runner.
  assert.equal(await runnerVersionOf(null, s.owner, record("failed", seenAt + 60_000), s.desktop), null, "a failed record newer than its word");
  assert.equal(await runnerVersionOf(null, s.owner, record("stopping", seenAt + 60_000), s.desktop), null);
  // Being set up again after the runner last said (a retry after it failed, or a reinstall after a stop): no runner either.
  assert.equal(await runnerVersionOf(null, s.owner, record("installing", seenAt + 60_000), s.desktop), null, "an installing record newer than its word");
  // At the same moment, or with no time on it: taken as newer, so no runner.
  assert.equal(await runnerVersionOf(null, s.owner, record("installing", seenAt), s.desktop), null);
  assert.equal(await runnerVersionOf(null, s.owner, { ...blob, runners: { [DESKTOP]: { status: "failed", version: "0.0.53", buildId: "b1", by: "mac-o" } } }, s.desktop), null, "a record with no time");
  // One that failed, was being stopped or set up before the runner said it runs: its word.
  assert.equal(await runnerVersionOf(null, s.owner, record("failed", seenAt - 60_000), s.desktop), CLOUD_ALL_MIN_VERSION, "a failed record older than its word");
  assert.equal(await runnerVersionOf(null, s.owner, record("stopping", seenAt - 60_000), s.desktop), CLOUD_ALL_MIN_VERSION);
  assert.equal(await runnerVersionOf(null, s.owner, record("installing", seenAt - 60_000), s.desktop), CLOUD_ALL_MIN_VERSION);
  // A record that says running, whenever: the newer of the two.
  assert.equal(await runnerVersionOf(null, s.owner, record("running", seenAt + 60_000), s.desktop), CLOUD_ALL_MIN_VERSION);
  // No record of a runner there (the Mac forgets one only after taking it down): none, whatever it said before.
  assert.equal(await runnerVersionOf(null, s.owner, { ...blob, runners: {} }, s.desktop), null);
  // No word and no record: none.
  const none = await setupGithub({ runner: null });
  assert.equal(await runnerVersionOf(null, none.owner, await blobOf(none.owner), none.desktop), null);
});

test("an app's GitHub job goes to its computer when the runner there said it runs a new enough Bops, though the owner's Mac's record of it is older", async (t) => {
  const s = await setupGithub({ runner: "0.0.51" });
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": GITHUB_ACTS_MIN_VERSION });
  t.after(() => box.close());
  await until(async () => (await seenOf(s.owner)).length === 1, "its word kept");
  const r = await act(s.sam, s.project, "key-seen-0001", { act: "githubPull", app: "site" });
  assert.equal(r.status, 202, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, macOn: true, stored: true, computer: true, turn: `turn_msg_job_${s.sam}_key-seen-0001` });
  assert.deepEqual(await pendingFor(s.owner), [], "nothing waits for the owner's Mac");
});

test("an app's GitHub job keeps the rule from before: the owner's Mac's record of the runner must say running, so one being set up again, failed or being stopped leaves it to the Mac, whatever the runner said before or since", async () => {
  /** A runner on Max's computer that said 0.0.53 as it connected and went, then the owner's Mac's record of it as `status`, `ago` ms after it said (less than 0: before). */
  const after = async (status: string, ago: number) => {
    const s = await setupGithub();
    const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.53" });
    await until(async () => (await seenOf(s.owner)).length === 1, "its word kept");
    box.close();
    await until(async () => (await query("SELECT 1 FROM bops.runner_presence WHERE user_id = $1", [s.owner])).rowCount === 0, "the runner gone");
    const seenAt = (await query<{ at: Date }>("SELECT seen_at AS at FROM bops.runner_seen WHERE user_id = $1", [s.owner])).rows[0].at.getTime();
    const runners = { [s.desktop.toUpperCase()]: { status, version: "0.0.53", buildId: "b2", by: "mac-o", at: seenAt + ago } };
    await ownerChanges(s.owner, (st) => void ((st as unknown as { runners: unknown }).runners = runners), own(s.owner, "mac-o", GITHUB_ACTS_MIN_VERSION));
    return s;
  };
  for (const [status, ago] of [["installing", 60_000], ["installing", -60_000], ["failed", -60_000], ["stopping", -60_000]] as const) {
    const s = await after(status, ago);
    const r = await act(s.sam, s.project, "key-asbefore-01", { act: "githubPull", app: "site" });
    assert.equal(r.status, 202, await r.clone().text());
    assert.deepEqual(await r.json(), { ok: true, macOn: false }, `${status} ${ago > 0 ? "after" : "before"} its word: the owner's Mac does it when it opens`);
    assert.deepEqual((await pendingFor(s.owner)).map((p) => [p.act, p.key]), [[{ act: "githubPull", app: "site" }, "key-asbefore-01"]]);
    assert.equal((await turnsOf(s.owner)).length, 0, "nothing owed to a computer whose runner isn't running");
  }
  // Running again (the Mac's record says so): its computer, as before.
  const s = await after("running", 60_000);
  const r = await act(s.sam, s.project, "key-asbefore-02", { act: "githubPull", app: "site" });
  assert.equal(((await r.json()) as { computer?: boolean }).computer, true);
});

test("how long a job waits for its computer, by kind: what's removed, goes on Published or reaches GitHub keeps a chat turn's ten minutes; the rest half an hour", () => {
  assert.equal(TURN_DEADLINE_MS, 10 * 60_000);
  assert.equal(APP_JOB_DEADLINE_MS, 30 * 60_000);
  const short: TurnJob[] = [
    { act: "githubLink", app: "site" },
    { act: "githubPull", app: "site" },
    { act: "remove", app: "site" },
    { act: "remove", app: "site", repo: true },
    { act: "removeSite", app: "site", site: "docs" },
    { act: "removeLeftOver", app: "site", leftOver: "site-old" },
    { act: "deploy", app: "site", env: "prod" },
    { act: "rollback", app: "site", deployment: "d1", env: "prod" },
  ];
  const long: TurnJob[] = [
    { act: "deploy", app: "site" },
    { act: "rollback", app: "site", deployment: "d1" },
    { act: "settings", app: "site", port: 3000 },
    { act: "domain", app: "site", zone: "z1" },
    { act: "compactChat" },
  ];
  for (const j of short) assert.equal(jobDeadline(j), TURN_DEADLINE_MS, j.act);
  for (const j of long) assert.equal(jobDeadline(j), APP_JOB_DEADLINE_MS, j.act);
});

test("a job only a newer runner knows, claimed by an older one (0.0.53, or one that doesn't say): 410 with the words why, the turn ends, and Your Apps says so; one at CLOUD_ALL_MIN_VERSION takes it, with its half hour", async (t) => {
  const s = await setupGithub({ runner: CLOUD_ALL_MIN_VERSION });
  // A runner listens there, so nothing owed wakes the computer meanwhile.
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  t.after(() => box.close());
  const deploy = (key: string) =>
    takeAppJob({
      account: s.owner,
      wsId: "ws_acme",
      job: { act: "deploy", app: "site" },
      id: `msg_job_${s.admin}_${key}`,
      member: { userId: s.admin, email: `${s.admin}@example.com`, name: "Ada", ref: key, projectId: s.project, role: "admin" },
      words: (bot) => `Ada asked ${bot}'s computer to deploy site.`,
      check: () => {},
    });
  const taken = await deploy("key-old-0001");
  assert.equal(taken.where, "computer");
  const id = taken.where === "computer" ? taken.turn.id : "";
  assert.deepEqual((await actsOn(s.owner)).map((x) => [x.key, x.act, x.going]), [["key-old-0001", "deploy", true]]);
  // Claimed by a runner on 0.0.53: refused with why, never run.
  const old = await runnerOn(s.owner, s.desktop, "0.0.53", `/v1/runner/turns/${id}/claim`, {});
  assert.equal(old.status, 410);
  const words = "Max's computer took this on an older Bops. Try again once it's updated.";
  assert.deepEqual(await old.json(), { error: words, code: "over" });
  assert.deepEqual([(await turnById(s.owner, id))?.state, (await turnById(s.owner, id))?.note], ["failed", "oldRunner"]);
  assert.deepEqual((await actsOn(s.owner)).map((x) => [x.key, x.ok, x.said, x.going]), [["key-old-0001", false, words, undefined]], "Your Apps says why");
  // A runner that doesn't say which Bops it runs is one from before too.
  const quiet = await deploy("key-old-0002");
  const quietId = quiet.where === "computer" ? quiet.turn.id : "";
  assert.equal((await runnerOn(s.owner, s.desktop, null, `/v1/runner/turns/${quietId}/claim`, {})).status, 410);
  // A chat's job (no app): refused the same, and nothing is kept on an app.
  const before = (await fullState(s.owner)).version;
  const compact = await oweJob(s, "turn_compact_old", { userId: s.admin, email: `${s.admin}@example.com`, name: "Ada", ref: "key-old-0003", projectId: s.project, role: "admin" }, { act: "compactChat" });
  const c = await runnerOn(s.owner, s.desktop, "0.0.53", `/v1/runner/turns/${compact}/claim`, {});
  assert.deepEqual([c.status, ((await c.json()) as { error: string }).error], [410, words]);
  assert.deepEqual([(await turnById(s.owner, compact))?.state, (await turnById(s.owner, compact))?.note], ["failed", "oldRunner"]);
  assert.equal((await fullState(s.owner)).version, before, "no app to say it on, so the state is as it was");
  // A runner at CLOUD_ALL_MIN_VERSION takes the same kind, and it waits half an hour, not a chat turn's ten minutes.
  const fresh = await deploy("key-old-0004");
  const freshId = fresh.where === "computer" ? fresh.turn.id : "";
  const left = (await turnById(s.owner, freshId))!.deadline - Date.now();
  assert.ok(left > 29 * 60_000 && left <= 30 * 60_000, `about half an hour (${left} ms)`);
  const ok = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${freshId}/claim`, {});
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(((await ok.json()) as { turn: { member: { job: unknown } } }).turn.member.job, { act: "deploy", app: "site" });
  // Its end, as a 0.0.54 runner that can't do it yet says it: kept on the app as not done, in its words.
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${freshId}/done`, { state: "done", job: { ok: false, said: "This computer's Bops doesn't know how to do that yet." } })).status, 200);
  assert.deepEqual((await actsOn(s.owner)).filter((x) => x.key === "key-old-0004").map((x) => [x.ok, x.said, x.going]), [[false, "This computer's Bops doesn't know how to do that yet.", undefined]]);
  // A GitHub job still goes to a runner that doesn't say (one from 0.0.52 on, before it said).
  const gh = (await (await act(s.admin, s.project, "key-old-0005", { act: "githubLink", app: "site" })).json()) as { turn: string };
  assert.equal((await runnerOn(s.owner, s.desktop, null, `/v1/runner/turns/${gh.turn}/claim`, {})).status, 200);
});

test("who may still have a job done, by kind: Your Apps at Write for a deploy, and the power of Publish for Published; an Admin for a remove; Write on every bot of the chat to compact it", async () => {
  const s = await setupGithub({ runner: CLOUD_ALL_MIN_VERSION });
  const who = (u: string, role?: "admin") => ({ userId: u, email: `${u}@example.com`, name: u, ref: `key-${u.slice(-8)}`, projectId: s.project, ...(role ? { role } : {}) });
  let n = 0;
  /** Owed, then claimed by a new enough runner: its status, and the claim let go so the chat's next can go. */
  const claimOf = async (member: Omit<TurnMember, "job">, job: TurnJob) => {
    const id = await oweJob(s, `turn_who_${++n}`, { ...member, ref: `${member.ref}-${n}` }, job);
    const r = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${id}/claim`, {});
    if (r.status === 200) assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${id}/done`, { state: "done", job: { ok: false, said: "Not now." } })).status, 200);
    return r.status;
  };
  // Ivy: Your Apps at Write, no App secrets, Max at Read.
  assert.equal(await claimOf(who(s.ivy), { act: "deploy", app: "site" }), 200, "a Preview deploy: Your Apps at Write");
  assert.equal(await claimOf(who(s.ivy), { act: "settings", app: "site", port: 3000 }), 200);
  assert.equal(await claimOf(who(s.ivy), { act: "domain", app: "site", zone: "z1" }), 200);
  assert.equal(await claimOf(who(s.ivy), { act: "deploy", app: "site", env: "prod" }), 410, "Publish needs App secrets");
  assert.equal(await claimOf(who(s.ivy), { act: "rollback", app: "site", deployment: "d1", env: "prod" }), 410);
  assert.equal(await claimOf(who(s.ivy), { act: "githubPull", app: "site" }), 410, "as today");
  // Sam: App secrets too.
  assert.equal(await claimOf(who(s.sam), { act: "deploy", app: "site", env: "prod" }), 200);
  assert.equal(await claimOf(who(s.sam), { act: "remove", app: "site" }), 410, "a remove is an Admin's");
  assert.equal(await claimOf(who(s.sam), { act: "removeSite", app: "site", site: "docs" }), 410);
  assert.equal(await claimOf(who(s.admin, "admin"), { act: "remove", app: "site", repo: true }), 200);
  assert.equal(await claimOf(who(s.admin, "admin"), { act: "removeLeftOver", app: "site", leftOver: "site-old" }), 200);
  // Compacting a chat: Write on every bot of it (Max is at Read for Sam and Ivy).
  assert.equal(await claimOf(who(s.sam), { act: "compactChat" }), 410);
  assert.equal(await claimOf(who(s.admin, "admin"), { act: "compactChat" }), 200);
  // Taken off Your Apps: a deploy owed meanwhile ends as they may no longer.
  await ownerChanges(s.owner, (st) => void (st.workspaces.find((w) => w.id === "ws_acme")!.memberAccess![`${s.ivy}@example.com`].apps = "read"), own(s.owner, "mac-o", GITHUB_ACTS_MIN_VERSION));
  assert.equal(await claimOf(who(s.ivy), { act: "deploy", app: "site" }), 410);
});

/* ---------------- Where everything goes through the cloud (turns.ts allCloud) ---------------- */

/** `fn` as an owner whose Mac runs CLOUD_ALL_MIN_VERSION, so everything in a workspace switched to the cloud goes there. */
async function inCloudAll(fn: () => Promise<void>) {
  macAt = CLOUD_ALL_MIN_VERSION;
  try {
    await fn();
  } finally {
    macAt = "0.0.36";
  }
}
/** setup, for an owner whose last Mac said CLOUD_ALL_MIN_VERSION (inside inCloudAll). */
async function setupAll() {
  const s = await setup();
  await query("INSERT INTO bops.cloud_accounts (user_id, app_version) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET app_version = $2", [s.owner, CLOUD_ALL_MIN_VERSION]);
  return s;
}
/** A runner's call, as one that says it runs `version` (none: says nothing). */
const runnerOf =
  (version: string | null) =>
  (owner: string, desktop: string, path: string, body?: unknown) =>
    fetch(`${cloud.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${vm(owner, desktop)}`, "x-bops-user": owner, "x-bops-protocol": "2", "content-type": "application/json", ...(version ? { "x-bops-version": version } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
const newRunner = runnerOf(CLOUD_ALL_MIN_VERSION);
const sendAs = (owner: string, chatId: string, body: Record<string, unknown>) => fetch(`${cloud.url}/v1/chats/${encodeURIComponent(chatId)}/send`, { method: "POST", headers: own(owner), body: JSON.stringify(body) });
type Blob = { workspaces: { id: string; memberAccess?: Record<string, Record<string, unknown>>; chatTrouble?: { note: string; botId?: string } }[]; bots: Record<string, unknown>[]; chats: Record<string, unknown>[]; runners?: Record<string, unknown> };
/** The owner's state changed by `change` (bots, chats, runners too), written back as their Mac does. */
const stateChanges = (owner: string, change: (st: Blob) => void) => ownerChanges(owner, (st) => change(st as unknown as Blob));
const acmeOf = async (owner: string) => ((await (await fetch(`${cloud.url}/v1/state`, { headers: own(owner) })).json()) as { state: Blob }).state.workspaces.find((w) => w.id === "ws_acme")!;
/** Rex on a computer of his own, Ivy with none, the groups "split" (Max and Rex) and "lonely" (Max and Ivy), and Wren at Write on all. */
const moreBots = (st: Blob, writer: string, d2: string) => {
  st.bots.push({ id: "rex", name: "Rex", workspaceId: "ws_acme", computer: "own", computerId: d2 }, { id: "ivy", name: "Ivy", workspaceId: "ws_acme", computer: "own" });
  st.chats.push(
    { id: "bot:rex", kind: "bot", botIds: ["rex"], workspaceId: "ws_acme" },
    { id: "bot:ivy", kind: "bot", botIds: ["ivy"], workspaceId: "ws_acme" },
    { id: "split", kind: "group", botIds: ["max", "rex"], workspaceId: "ws_acme" },
    { id: "lonely", kind: "group", botIds: ["max", "ivy"], workspaceId: "ws_acme" },
  );
  const bots = st.workspaces.find((w) => w.id === "ws_acme")!.memberAccess![`${writer}@example.com`].bots as Record<string, string>;
  Object.assign(bots, { rex: "write", ivy: "write" });
};
/** Write taken away (or given) on one of Wren's bots straight in the table: no state write, so nothing rechecks it but a claim or a beat. */
const levelInTable = (owner: string, writer: string, bot: string, level: string) =>
  query("UPDATE bops.app_state SET state = jsonb_set(state, $2::text[], to_jsonb($3::text)) WHERE user_id = $1", [owner, ["workspaces", "1", "memberAccess", `${writer}@example.com`, "bots", bot], level]);
const OLD_WORDS = "Max's computer runs an older Bops. The owner's Bops updates it the next time it opens.";

test("answered on its computer in a cloud workspace: a bot set to work on the owner's Mac has its turn owed to its own computer, nothing is handed to the Mac, and its runner claims it", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const a = (await (await act(s.writer, s.project, "key-all-zed001", { act: "chat", chatId: "bot:zed", text: "hi Zed" })).json()) as { turn?: string; messageId: string };
    assert.ok(a.turn, "owed to Zed's computer");
    const t = await turnById(s.owner, a.turn!);
    assert.deepEqual([t?.botId, t?.desktopId, t?.isGroup, t?.minVersion], ["zed", s.desktop, false, null]);
    assert.deepEqual(await pendingFor(s.owner), [], "nothing for the owner's Mac");
    assert.ok(!(await messages(s.owner)).some((m) => m.id === `${a.messageId}_note`), "no note: it's answered");
    const c = await newRunner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {});
    assert.equal(c.status, 200, await c.clone().text());
    assert.equal(((await c.json()) as { turn: { botId: string; group?: true } }).turn.group, undefined);
  });
});

test("a group whose bots share one computer is owed to it as one turn and claimed by a runner that runs groups; a split group, or one with a bot with no computer, gets its note and nothing waits for the Mac", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
    const a = (await (await act(s.writer, s.project, "key-all-grp001", { act: "chat", chatId: "team", text: "hi team" })).json()) as { turn?: string; messageId: string };
    assert.ok(a.turn);
    const t = await turnById(s.owner, a.turn!);
    assert.deepEqual([t?.botId, t?.desktopId, t?.isGroup, t?.minVersion], ["max", s.desktop, true, CLOUD_ALL_MIN_VERSION]);
    await until(() => box.of("turn").some((e) => e.data.id === a.turn), "offered to the runner");
    const c = await newRunner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {});
    assert.equal(c.status, 200, await c.clone().text());
    assert.equal(((await c.json()) as { turn: { group?: true } }).turn.group, true);
    // Each of its bots' rows carries the turn, from the computer that holds it.
    const at = Date.now();
    const rows = [
      { id: "grp-max-1", chatId: "team", role: "bot", botId: "max", text: "hi", at, turn: a.turn },
      { id: "grp-dana-1", chatId: "team", role: "bot", botId: "dana", text: "hello", at, turn: a.turn },
    ];
    assert.equal((await writeAs(s.owner, s.desktop, rows)).status, 200);
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "done" })).status, 200);
    box.close();

    const d2 = randomUUID();
    await stateChanges(s.owner, (st) => moreBots(st, s.writer, d2));
    const split = (await (await act(s.writer, s.project, "key-all-split1", { act: "chat", chatId: "split", text: "both of you" })).json()) as { turn?: string; messageId: string };
    assert.equal(split.turn, undefined);
    assert.equal(await noteOf(s.owner, `${split.messageId}_note`), "A group's bots work on different computers, so that group can't answer in the cloud yet.");
    const lonely = (await (await act(s.writer, s.project, "key-all-lone01", { act: "chat", chatId: "lonely", text: "you two" })).json()) as { turn?: string; messageId: string };
    assert.equal(lonely.turn, undefined);
    assert.equal(await noteOf(s.owner, `${lonely.messageId}_note`), "Ivy has no computer, so Ivy can't answer in the cloud. Give Ivy a computer in Ivy's settings.");
    const ivy = (await (await act(s.writer, s.project, "key-all-ivy001", { act: "chat", chatId: "bot:ivy", text: "Ivy?" })).json()) as { turn?: string; messageId: string };
    assert.equal(ivy.turn, undefined);
    assert.equal(await noteOf(s.owner, `${ivy.messageId}_note`), "Ivy has no computer, so Ivy can't answer in the cloud. Give Ivy a computer in Ivy's settings.");
    assert.deepEqual(await pendingFor(s.owner), [], "nothing waits for the owner's Mac");
    // A chat they don't have is none, never queued for the Mac.
    assert.equal((await act(s.writer, s.project, "key-all-none01", { act: "chat", chatId: "bot:boppy", text: "x" })).status, 404);
    assert.deepEqual(await pendingFor(s.owner), []);
  });
});

test("a group turn: a member without Write on every bot is refused at claim and at a beat", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const a = (await (await act(s.writer, s.project, "key-all-gw0001", { act: "chat", chatId: "team", text: "x" })).json()) as { turn: string };
    await levelInTable(s.owner, s.writer, "dana", "read");
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 410);
    assert.deepEqual([(await turnById(s.owner, a.turn))?.state, (await turnById(s.owner, a.turn))?.note], ["failed", null]);
    await levelInTable(s.owner, s.writer, "dana", "write");
    const b = (await (await act(s.writer, s.project, "key-all-gw0002", { act: "chat", chatId: "team", text: "y" })).json()) as { turn: string };
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${b.turn}/claim`, {})).status, 200);
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${b.turn}/beat`, { phase: "model" })).status, 200);
    await levelInTable(s.owner, s.writer, "dana", "read");
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${b.turn}/beat`, { phase: "model" })).status, 409);
    assert.deepEqual([(await turnById(s.owner, b.turn))?.state, (await turnById(s.owner, b.turn))?.note], ["failed", "gone"]);
  });
});

test("reacts on a group's turn: its bots' tapbacks on the message are written by Bops Cloud; one for a bot elsewhere, not in the chat, or not a tapback is left out", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const a = (await (await act(s.writer, s.project, "key-all-rx0001", { act: "chat", chatId: "team", text: "good news" })).json()) as { turn: string; messageId: string };
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
    // Dana moves to a computer of her own meanwhile: hers is no longer this computer's to say.
    await stateChanges(s.owner, (st) => void Object.assign(st.bots.find((b) => b.id === "dana")!, { computer: "own", computerId: randomUUID() }));
    const reacts = [
      { botId: "max", type: "love" },
      { botId: "dana", type: "like" },
      { botId: "boppy", type: "laugh" },
      { botId: "max", type: "wave" },
    ];
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "done", reacts })).status, 200);
    const m = await until(async () => (await messages(s.owner)).find((x) => x.id === a.messageId && Array.isArray(x.reactions)), "the tapbacks written");
    assert.deepEqual((m.reactions as { by: string; type: string }[]).map((r) => [r.by, r.type]), [["max", "love"]]);
    // A second group turn, both bots here: both written, and never more than eight.
    const b = (await (await act(s.writer, s.project, "key-all-rx0002", { act: "chat", chatId: "team", text: "more news" })).json()) as { turn?: string; messageId: string };
    assert.equal(b.turn, undefined, "Dana elsewhere now: the group is split");
    await stateChanges(s.owner, (st) => void Object.assign(st.bots.find((b) => b.id === "dana")!, { computer: undefined, computerId: undefined }));
    const c = (await (await act(s.writer, s.project, "key-all-rx0003", { act: "chat", chatId: "team", text: "and again" })).json()) as { turn: string; messageId: string };
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${c.turn}/claim`, {})).status, 200);
    const many = [{ botId: "dana", type: "laugh" }, ...Array.from({ length: 9 }, () => ({ botId: "boppy", type: "like" })), { botId: "max", type: "like" }];
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${c.turn}/done`, { state: "done", reacts: many })).status, 200);
    const n = await until(async () => (await messages(s.owner)).find((x) => x.id === c.messageId && Array.isArray(x.reactions)), "the second's tapbacks");
    assert.deepEqual((n.reactions as { by: string; type: string }[]).map((r) => [r.by, r.type]), [["dana", "laugh"]], "only the first eight are read");
  });
});

test("a runner below CLOUD_ALL_MIN_VERSION: a group's message gets NOTES.old and no turn; a claim by an older runner is refused with the same words; the workspace says so until a new enough runner connects", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const record = (version: string) => ({ status: "running", version, buildId: "b1", by: "mac-o", at: Date.now(), auth: "identity" });
    await stateChanges(s.owner, (st) => void (st.runners = { [s.desktop]: record("0.0.53") }));
    const a = (await (await act(s.writer, s.project, "key-all-old001", { act: "chat", chatId: "team", text: "x" })).json()) as { turn?: string; messageId: string };
    assert.equal(a.turn, undefined);
    assert.equal(await noteOf(s.owner, `${a.messageId}_note`), OLD_WORDS);
    const trouble = await until(async () => (await acmeOf(s.owner)).chatTrouble, "the workspace says so");
    assert.deepEqual([trouble.note, trouble.botId], ["old", "max"]);
    // One bot's chat is fine on that runner.
    assert.ok(((await (await act(s.writer, s.project, "key-all-old002", { act: "chat", chatId: "bot:max", text: "y" })).json()) as { turn?: string }).turn);
    // The Mac says it's newer now: owed; but the runner that claims says it's older.
    await stateChanges(s.owner, (st) => void (st.runners = { [s.desktop]: record(CLOUD_ALL_MIN_VERSION) }));
    const b = (await (await act(s.writer, s.project, "key-all-old003", { act: "chat", chatId: "team", text: "z" })).json()) as { turn: string; messageId: string };
    assert.ok(b.turn);
    for (const older of [runnerOf("0.0.53"), runnerOf(null)]) {
      const c = await older(s.owner, s.desktop, `/v1/runner/turns/${b.turn}/claim`, {});
      if (c.status === 410 && (await turnById(s.owner, b.turn))?.note === "old") {
        assert.equal(((await c.json()) as { error: string }).error, OLD_WORDS);
        break;
      }
    }
    assert.deepEqual([(await turnById(s.owner, b.turn))?.state, (await turnById(s.owner, b.turn))?.note], ["failed", "old"]);
    assert.equal(await noteOf(s.owner, `${b.messageId}_note`), OLD_WORDS);
    // An old runner connecting leaves it said; a new enough one clears it.
    const old = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.53" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await acmeOf(s.owner)).chatTrouble?.note, "old");
    old.close();
    const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
    await until(async () => (await acmeOf(s.owner)).chatTrouble === undefined, "cleared by a new enough runner");
    box.close();
    assert.deepEqual(await pendingFor(s.owner), []);
  });
});

test("the owner's send: with all, a group, a bot set to work on the Mac and a bot with no computer are taken (a turn, or the note); without all, or with the owner's last Mac older, CHAT_NOT_IN_CLOUD as before", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    await stateChanges(s.owner, (st) => moreBots(st, s.writer, randomUUID()));
    const code = async (r: Response) => [r.status, ((await r.json()) as { code?: string }).code];
    for (const chat of ["team", "bot:zed", "bot:ivy"]) assert.deepEqual(await code(await sendAs(s.owner, chat, { key: `own-no-all-${chat.replace(":", "-")}`, text: "hi" })), [409, "chat_not_in_cloud"], `${chat} without all`);
    const team = (await (await sendAs(s.owner, "team", { key: "own-all-team01", text: "hi team", all: true })).json()) as { turn?: string; message: { id: string } };
    assert.ok(team.turn);
    assert.equal((await turnById(s.owner, team.turn!))?.isGroup, true);
    const zed = (await (await sendAs(s.owner, "bot:zed", { key: "own-all-zed001", text: "hi Zed", all: true })).json()) as { turn?: string };
    assert.equal((await turnById(s.owner, zed.turn!))?.desktopId, s.desktop);
    const ivy = (await (await sendAs(s.owner, "bot:ivy", { key: "own-all-ivy001", text: "hi Ivy", all: true })).json()) as { turn?: string; message: { id: string } };
    assert.equal(ivy.turn, undefined);
    assert.equal(await noteOf(s.owner, `${ivy.message.id}_note`), "Ivy has no computer, so Ivy can't answer in the cloud. Give Ivy a computer in Ivy's settings.");
    const split = (await (await sendAs(s.owner, "split", { key: "own-all-split1", text: "both", all: true })).json()) as { turn?: string; message: { id: string } };
    assert.equal(split.turn, undefined);
    assert.equal(await noteOf(s.owner, `${split.message.id}_note`), "A group's bots work on different computers, so that group can't answer in the cloud yet.");
    // The owner's last Mac older (another Mac of theirs said so): as before, even with all.
    await query("UPDATE bops.cloud_accounts SET app_version = '0.0.53' WHERE user_id = $1", [s.owner]);
    assert.deepEqual(await code(await sendAs(s.owner, "team", { key: "own-all-team02", text: "again", all: true })), [409, "chat_not_in_cloud"]);
    assert.deepEqual(await pendingFor(s.owner), []);
  });
});

/** A member's chat message (Wren's, at Write on Max, Dana and Zed): its turn, if one is owed, and its message id. */
const said = async (s: { writer: string; project: string }, key: string, chatId: string, text = "hi") =>
  (await (await act(s.writer, s.project, key, { act: "chat", chatId, text })).json()) as { turn?: string; messageId: string };
const claimOf = async (owner: string, desktop: string, turn: string) => {
  const r = await newRunner(owner, desktop, `/v1/runner/turns/${turn}/claim`, {});
  const t = await turnById(owner, turn);
  return [r.status, t?.state, t?.note];
};
const MOVED_ZED = "Zed moved to another computer before it could answer. Send it again.";

test("a group's turn with a bot set to work on the Mac is claimed only while everything still goes through the cloud, as that bot's own turn is: the switch turned off, or the owner's last Mac older, and both are refused, the chat naming that bot", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    await stateChanges(s.owner, (st) => void st.chats.push({ id: "mixed", kind: "group", botIds: ["max", "zed"], workspaceId: "ws_acme" }));
    // In the cloud: claimed.
    const a = await said(s, "key-mix-00001", "mixed");
    assert.equal((await turnById(s.owner, a.turn!))?.isGroup, true);
    assert.deepEqual(await claimOf(s.owner, s.desktop, a.turn!), [200, "claimed", null]);
    assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "done" })).status, 200);
    for (const off of ["switch", "older"] as const) {
      const g = await said(s, `key-mix-g-${off}`, "mixed");
      const z = await said(s, `key-mix-z-${off}`, "bot:zed");
      assert.ok(g.turn && z.turn, off);
      if (off === "switch") assert.equal((await fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers: own(s.owner), body: JSON.stringify({ wsId: "ws_acme", mode: "mac" }) })).status, 200);
      else await query("UPDATE bops.cloud_accounts SET app_version = '0.0.53' WHERE user_id = $1", [s.owner]);
      for (const t of [g, z]) {
        assert.deepEqual(await claimOf(s.owner, s.desktop, t.turn!), [410, "failed", "moved"], `${off}: ${t.turn}`);
        assert.equal(await noteOf(s.owner, `${t.messageId}_note`), MOVED_ZED);
      }
      // Back as it was, for the next.
      if (off === "switch") assert.equal((await fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers: own(s.owner), body: JSON.stringify({ wsId: "ws_acme", mode: "cloud" }) })).status, 200);
    }
  });
});

test("a group's turn refused at claim as the group is split now, or a bot of it has no computer, says that (naming that bot); a bot moved says it moved", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const dana = (more: Record<string, unknown>) => stateChanges(s.owner, (st) => void Object.assign(st.bots.find((b) => b.id === "dana")!, more));
    // Dana on a computer of her own before the claim: split.
    const a = await said(s, "key-grp-split1", "team");
    await dana({ computer: "own", computerId: randomUUID() });
    assert.deepEqual(await claimOf(s.owner, s.desktop, a.turn!), [410, "failed", "groupSplit"]);
    assert.equal(await noteOf(s.owner, `${a.messageId}_note`), "A group's bots work on different computers, so that group can't answer in the cloud yet.");
    // Dana with no computer at all: named, not Max.
    await dana({ computer: undefined, computerId: undefined });
    const b = await said(s, "key-grp-nocom1", "team");
    assert.ok(b.turn);
    await dana({ computer: "own", computerId: undefined });
    assert.deepEqual(await claimOf(s.owner, s.desktop, b.turn!), [410, "failed", "groupNoComputer"]);
    assert.equal(await noteOf(s.owner, `${b.messageId}_note`), "Dana has no computer, so Dana can't answer in the cloud. Give Dana a computer in Dana's settings.");
    // The whole group on another computer: moved, as before.
    await dana({ computer: undefined, computerId: undefined });
    const c = await said(s, "key-grp-moved1", "team");
    assert.ok(c.turn);
    await stateChanges(s.owner, (st) => void (st.bots.find((x) => x.id === "max")!.computerId = randomUUID()));
    assert.deepEqual(await claimOf(s.owner, s.desktop, c.turn!), [410, "failed", "moved"]);
    assert.equal(await noteOf(s.owner, `${c.messageId}_note`), "Max moved to another computer before it could answer. Send it again.");
  });
});

test("a teammate's OK for a chat's ask a bot set to work on the Mac made on its own computer (everything through the cloud): answered by Bops Cloud with the owner's Mac shut, and only with Use its computer; an older owner's waits for the Mac as before", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const ask = (id: string) => ({ id, botId: "zed", chatId: "bot:zed", action: "Run a command", kind: "brain", at: 1, askedBy: s.device, resume: { engine: "chat", cloudTurn: `turn_${id}` } });
    await ownerChanges(s.owner, (st) => {
      (st as unknown as { appApprovals: unknown[] }).appApprovals = [ask("ask-zed1"), ask("ask-zed2")];
      Object.assign(st.workspaces.find((w) => w.id === "ws_acme")!.memberAccess![`${s.noUse}@example.com`].bots as Record<string, string>, { zed: "write" });
    });
    // Without Use its computer: refused, as for a bot with a computer of its own.
    const r = await act(s.noUse, s.project, "key-zed-ok-nc1", { act: "answer", askId: "ask-zed1", reply: "once" });
    assert.deepEqual([r.status, ((await r.json()) as { code: string }).code], [403, "member_no_computer"]);
    // With it: written now, nothing for the Mac.
    const ok = await act(s.writer, s.project, "key-zed-ok-0001", { act: "answer", askId: "ask-zed1", reply: "once" });
    assert.deepEqual([ok.status, ((await ok.json()) as { macOn?: boolean }).macOn], [202, true]);
    const full = (await (await fetch(`${cloud.url}/v1/state`, { headers: own(s.owner) })).json()) as { state: { appApprovals: { id: string; reply?: { reply: string; by: string } }[] } };
    const reply = full.state.appApprovals.find((a) => a.id === "ask-zed1")?.reply;
    assert.deepEqual([reply?.reply, reply?.by], ["once", "cloud"]);
    assert.deepEqual(await pendingFor(s.owner), []);
    // The owner's last Mac older: Zed answers on the Mac there, so the answer waits for it, as before.
    await query("UPDATE bops.cloud_accounts SET app_version = '0.0.53' WHERE user_id = $1", [s.owner]);
    assert.equal((await act(s.writer, s.project, "key-zed-ok-0002", { act: "answer", askId: "ask-zed2", reply: "once" })).status, 202);
    assert.deepEqual((await pendingFor(s.owner)).map((p) => (p.act as { askId?: string }).askId), ["ask-zed2"]);
  });
});

test("trouble said of a computer goes once no bot of the workspace works on it (a new computer given), or once the computer its bot works on now answers; another computer answering leaves it", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const trouble = async () => (await acmeOf(s.owner)).chatTrouble;
    await noteTrouble(s.owner, s.desktop, "deleted", "max");
    assert.equal((await until(trouble, "said"))?.note, "deleted");
    const d2 = randomUUID();
    const other = await stream("/v1/runner/live", vm(s.owner, d2), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await trouble())?.note, "deleted", "a computer it isn't about");
    other.close();
    // Max given a new computer (Dana and Zed with him): none on the deleted one now.
    await stateChanges(s.owner, (st) => void (st.bots.find((b) => b.id === "max")!.computerId = d2.toUpperCase()));
    await until(async () => (await trouble()) === undefined, "cleared: about no bot's computer");
    // Said of Dana on Max's computer; Dana then on her own (Max's still in use): it stays until Dana's answers.
    await noteTrouble(s.owner, d2, "stopped", "dana");
    assert.equal((await until(async () => ((await trouble())?.botId === "dana" ? await trouble() : undefined), "said of Dana"))?.note, "stopped");
    const d3 = randomUUID();
    await stateChanges(s.owner, (st) => void Object.assign(st.bots.find((b) => b.id === "dana")!, { computer: "own", computerId: d3 }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await trouble())?.note, "stopped");
    const hers = await stream("/v1/runner/live", vm(s.owner, d3), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
    await until(async () => (await trouble()) === undefined, "cleared by Dana's computer answering");
    hers.close();
  });
});

test("a member's message and a claim read the owner's Mac's version on their own transaction: with one connection of the pool free, neither waits for a second", async () => {
  await inCloudAll(async () => {
    const s = await setupAll();
    const held = await Promise.all(Array.from({ length: 9 }, () => db().connect()));
    try {
      const at = Date.now();
      const r = await act(s.writer, s.project, "key-pool-00001", { act: "chat", chatId: "bot:zed", text: "hi Zed" });
      assert.equal(r.status, 202, await r.clone().text());
      const z = (await r.json()) as { turn?: string };
      assert.ok(z.turn);
      // A bot set to work on the Mac: the claim asks allCloud under the lock.
      assert.equal((await newRunner(s.owner, s.desktop, `/v1/runner/turns/${z.turn}/claim`, {})).status, 200);
      assert.ok(Date.now() - at < 8000, "never waited on the pool");
    } finally {
      for (const c of held) c.release();
    }
  });
});

/* ---------------- A teammate's compact of a chat, as a job on a bot's computer ---------------- */

/**
 * A workspace whose chats a teammate compacts on a bot's computer (takeChatJob): Max, the main bot, on its computer with a
 * runner at CLOUD_ALL_MIN_VERSION; Lee, on a computer of its own whose runner is at `lee` (none: null); the group "team"
 * with Lee first, then Max; Lee's own chat. An Admin (Ada), and Sam, a Member with Write on both. The owner's Mac is shut.
 */
async function setupChat(o: { lee?: string | null } = {}) {
  const owner = user("owner");
  const admin = user("admin");
  const sam = user("writer");
  const project = randomUUID();
  const desktop = randomUUID();
  const leeDesktop = randomUUID();
  const said = { ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  roles[`${owner} ${project}`] = { role: "owner", ...said };
  roles[`${admin} ${project}`] = { role: "admin", ...said };
  roles[`${sam} ${project}`] = { role: "member", ...said };
  const [D, L] = [desktop.toUpperCase(), leeDesktop.toUpperCase()];
  const record = (version: string) => ({ status: "running", version, buildId: "b1", by: "mac-o", at: 1 });
  const state = {
    owner: { name: "Tara" },
    workspaces: [
      { id: "ws_main", name: "Main" },
      { id: "ws_acme", name: "Acme", memberAccess: { [`${sam}@example.com`]: { others: "none", bots: { max: "write", lee: "write" }, computer: "use" } } },
    ],
    bots: [
      { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: D },
      { id: "lee", name: "Lee", workspaceId: "ws_acme", computer: "own", computerId: L },
    ],
    chats: [
      { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" },
      { id: "bot:lee", kind: "bot", botIds: ["lee"], workspaceId: "ws_acme" },
      { id: "team", kind: "group", botIds: ["lee", "max"], workspaceId: "ws_acme" },
    ],
    runners: { [D]: record(CLOUD_ALL_MIN_VERSION), ...(o.lee === null ? {} : { [L]: record(o.lee ?? "0.0.53") }) },
  };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: own(owner, "mac-o", GITHUB_ACTS_MIN_VERSION), body: JSON.stringify({ base: 0, state }) })).status, 200);
  await macSaid(owner, CLOUD_ALL_MIN_VERSION);
  const who = (u: string, name: string, key: string, role?: "admin"): TurnMember => ({ userId: u, email: `${u}@example.com`, name, ref: key, projectId: project, ...(role ? { role } : {}) });
  /** A teammate's compact of a chat (Ada's, unless `as` says), as members.ts takes it. */
  const compact = (key: string, chatId = "team", as = who(admin, "Ada", key, "admin")) =>
    takeChatJob({ account: owner, wsId: "ws_acme", chatId, id: `msg_job_${as.userId}_${key}`, member: as, check: () => {} });
  return { owner, admin, sam, project, desktop, leeDesktop, device: deviceIdOf(owner, desktop), who, compact };
}
/** A chat job's end line (finish, jobsOver), once it's there. */
const lineOf = async (owner: string, messageId: string, ms = 5000) => {
  await until(async () => (await messages(owner)).some((m) => m.id === `${messageId}_done`), `the line of ${messageId}`, ms);
  return (await messages(owner)).find((m) => m.id === `${messageId}_done`)!;
};
const stateVersion = async (owner: string) => (await query<{ version: number }>("SELECT version FROM bops.app_state WHERE user_id = $1", [owner])).rows[0].version;

test("a chat's compact goes to the first bot of the chat whose computer's runner is new enough: none is 409 with the words, a retry adds nothing, and it waits behind the chat's answers", async (t) => {
  const s = await setupChat();
  // A runner listens on Max's computer, so nothing owed wakes it meanwhile.
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  // An answer owed in the chat first.
  await query(
    `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
     VALUES ($1, 'turn_first', 'msg_first', 'team', 'max', 'ws_acme', NULL, $2, $3, 'owed', now() + interval '10 minutes', $4)`,
    [s.owner, s.desktop, s.device, Date.now()],
  );
  const before = await stateVersion(s.owner);
  const taken = await s.compact("key-cc-0001");
  assert.equal(taken.fresh, true);
  // Lee comes first in the chat, but its runner is older than the gate: Max's computer.
  assert.deepEqual([taken.turn.chatId, taken.turn.botId, taken.turn.desktopId, taken.turn.targetDevice, taken.turn.member?.job], ["team", "max", s.desktop, s.device, { act: "compactChat" }]);
  const left = taken.turn.deadline - Date.now();
  assert.ok(left > 29 * 60_000 && left <= 30 * 60_000, `about half an hour (${left} ms)`);
  assert.equal(await stateVersion(s.owner), before, "nothing written on the owner's state");
  // The same act again: the same turn, nothing more.
  const again = await s.compact("key-cc-0001");
  assert.deepEqual([again.fresh, again.turn.id], [false, taken.turn.id]);
  assert.equal((await turnsOf(s.owner)).length, 2);
  // One at a time in the chat: it waits behind the answer owed there first.
  const busy = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${taken.turn.id}/claim`, {});
  assert.deepEqual([busy.status, ((await busy.json()) as { code: string }).code], [409, "busy"]);
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, "/v1/runner/turns/turn_first/claim", {})).status, 200);
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, "/v1/runner/turns/turn_first/done", { state: "done" })).status, 200);
  const ok = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${taken.turn.id}/claim`, {});
  assert.equal(ok.status, 200, await ok.clone().text());
  const claimed = ((await ok.json()) as { turn: { chatId: string; botId: string; member: { job: unknown; ref: string } } }).turn;
  assert.deepEqual([claimed.chatId, claimed.botId, claimed.member.job, claimed.member.ref], ["team", "max", { act: "compactChat" }, "key-cc-0001"]);
  // None of a chat's bots has a runner new enough (Lee's own chat): 409, saying why of the first with a computer (its
  // runner too old), as a thread's act says it, and nothing owed.
  await assert.rejects(s.compact("key-cc-0002", "bot:lee"), { status: 409, message: "Lee's computer needs a newer Bops before it can do this. It updates the next time Tara opens Bops.", extra: { code: COMPUTER_NOT_READY } });
  assert.equal(NO_CHAT_COMPUTER, "No bot in this chat has a computer to compact it.");
  assert.equal((await turnsOf(s.owner)).length, 2, "nothing owed");
  assert.deepEqual(await pendingFor(s.owner), [], "nothing waits for the owner's Mac");
  // Lee's runner new enough: Lee's own computer, first in the chat.
  const l = await setupChat({ lee: CLOUD_ALL_MIN_VERSION });
  const lee = await stream("/v1/runner/live", vm(l.owner, l.leeDesktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => lee.close());
  const onLee = await l.compact("key-cc-0003");
  assert.deepEqual([onLee.turn.botId, onLee.turn.desktopId], ["lee", l.leeDesktop]);
  // No runner there at all: the next bot with one; a chat of none of them: refused.
  const none = await setupChat({ lee: null });
  const mx = await stream("/v1/runner/live", vm(none.owner, none.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => mx.close());
  assert.equal((await none.compact("key-cc-0004")).turn.botId, "max");
  await assert.rejects(none.compact("key-cc-0005", "bot:lee"), { status: 409, message: "Lee's computer isn't set up yet. Tara's Bops sets it up the next time it opens.", extra: { code: COMPUTER_NOT_READY } });
});

test("a chat's compact none of whose bots can do it says why of the first with a computer (down, no runner, an older one), and that none has one only when none has", async () => {
  const s = await setupChat();
  const why = async (edit: Parameters<typeof ownerChanges>[1], key: string) => {
    await ownerChanges(s.owner, edit, own(s.owner, "mac-o", GITHUB_ACTS_MIN_VERSION));
    return s.compact(key, "bot:max").then(
      () => assert.fail("taken"),
      (e: { status: number; message: string; extra?: { code?: string } }) => [e.status, e.extra?.code, e.message],
    );
  };
  const D = s.desktop.toUpperCase();
  const runners = (st: unknown) => st as { runners: Record<string, Record<string, unknown>> };
  // Found down by the owner's Mac.
  assert.deepEqual(await why((st) => void (runners(st).runners[D].down = { status: "stopped", at: 1 }), "key-cc-0301"), [409, COMPUTER_NOT_READY, "Max's computer isn't running, so it can't compact this chat. Tara can start it again."]);
  // An older runner.
  assert.deepEqual(await why((st) => void (runners(st).runners[D] = { status: "running", version: "0.0.53", buildId: "b1", by: "mac-o", at: 1 }), "key-cc-0302"), [
    409,
    COMPUTER_NOT_READY,
    "Max's computer needs a newer Bops before it can do this. It updates the next time Tara opens Bops.",
  ]);
  // No runner yet.
  assert.deepEqual(await why((st) => void delete runners(st).runners[D], "key-cc-0303"), [409, COMPUTER_NOT_READY, "Max's computer isn't set up yet. Tara's Bops sets it up the next time it opens."]);
  // No computer at all.
  assert.deepEqual(await why((st) => void (st as unknown as { bots: { computerId?: string }[] }).bots.forEach((b) => delete b.computerId), "key-cc-0304"), [409, COMPUTER_NOT_READY, NO_CHAT_COMPUTER]);
  assert.equal((await turnsOf(s.owner)).length, 0, "nothing owed");
});

test("a chat's compact ends with its line in the chat, stamped as theirs so their window sees it land: Compacted by them, or why it didn't go; the owner's state is as it was", async (t) => {
  const s = await setupChat();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  const before = await stateVersion(s.owner);
  const end = async (key: string, done: Record<string, unknown>) => {
    const { turn } = await s.compact(key);
    assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${turn.id}/claim`, {})).status, 200);
    assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${turn.id}/done`, done)).status, 200);
    return turn;
  };
  const ok = await end("key-cc-0101", { state: "done", job: { ok: true, said: "Compacted" } });
  const line = await lineOf(s.owner, ok.messageId);
  assert.deepEqual(
    { chatId: line.chatId, role: line.role, text: line.text, compacted: line.compacted, member: line.member },
    { chatId: "team", role: "system", text: "Compacted by Ada", compacted: true, member: { userId: s.admin, email: `${s.admin}@example.com`, name: "Ada", ref: "key-cc-0101" } },
  );
  assert.ok(typeof line.at === "number" && line.at >= ok.humanAt);
  // Ada reads it in the chat, by her act's key (her window's landed()).
  const read = (await (await fetch(`${cloud.url}/v1/ws/${s.project}/state`, { headers: { Authorization: `Bearer ${keyOf(s.admin)}` } })).json()) as { messages: { id: string; member?: { ref: string } }[] };
  assert.ok(read.messages.some((m) => m.id === line.id && m.member?.ref === "key-cc-0101"), "in Ada's view of the chat");
  // Not compacted, as the computer said why.
  const no = await end("key-cc-0102", { state: "done", job: { ok: false, said: "Nothing new to compact." } });
  const noLine = await lineOf(s.owner, no.messageId);
  assert.deepEqual([noLine.text, noLine.compacted, (noLine.member as { ref: string }).ref], ["Couldn't compact this chat: Nothing new to compact.", undefined, "key-cc-0102"]);
  // Failed with a note: the line says it, and no other note goes in the chat.
  const failed = await end("key-cc-0103", { state: "failed", note: "The model didn't answer." });
  assert.equal((await lineOf(s.owner, failed.messageId)).text, "Couldn't compact this chat: The model didn't answer.");
  assert.ok(!(await messages(s.owner)).some((m) => m.id === `${failed.messageId}_note`));
  // Done with no result (a runner that answers as one from before): never said as compacted.
  const old = await end("key-cc-0104", { state: "done" });
  assert.equal((await lineOf(s.owner, old.messageId)).text, "Couldn't compact this chat: Max's computer took this on an older Bops. Try again once it's updated.");
  // One line each, and plain words.
  for (const id of [ok, no, failed, old].map((x) => `${x.messageId}_done`)) assert.equal((await messages(s.owner)).filter((m) => m.id === id).length, 1);
  assert.ok((await messages(s.owner)).every((m) => !/[–—]| - |Orbit/.test(String(m.text ?? ""))));
  assert.equal(await stateVersion(s.owner), before, "nothing on the owner's state: its summary is the runner's to write");
});

test("a chat's compact that ends without its computer saying is said in its line too: a computer that can't wake, a runner from before, and Write taken away meanwhile", async (t) => {
  // A computer that can't wake (stopped): the line says why, and the chat's note of an answer doesn't go in.
  const s = await setupChat();
  wakeAnswers.set(s.desktop, () => ({ state: "stopped" }));
  const a = await s.compact("key-cc-0201");
  const stopped = await lineOf(s.owner, a.turn.messageId, 15_000);
  assert.deepEqual([stopped.text, (stopped.member as { ref: string }).ref], ["Couldn't compact this chat: Max's computer is stopped. Tara can start it again.", "key-cc-0201"]);
  assert.equal((await turnById(s.owner, a.turn.id))?.note, "stopped");
  assert.ok(!(await messages(s.owner)).some((m) => m.id === `${a.turn.messageId}_note`), "no note of an answer");
  // Claimed by a runner from before: 410, and the line says so.
  const o = await setupChat();
  const box = await stream("/v1/runner/live", vm(o.owner, o.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  const b = await o.compact("key-cc-0202");
  assert.equal((await runnerOn(o.owner, o.desktop, "0.0.53", `/v1/runner/turns/${b.turn.id}/claim`, {})).status, 410);
  assert.equal((await lineOf(o.owner, b.turn.messageId)).text, "Couldn't compact this chat: Max's computer took this on an older Bops. Try again once it's updated.");
  // Sam's, and Sam taken down to Read on Lee before it ran: it ends, and the line says who may changed.
  const c = await o.compact("key-cc-0203", "team", o.who(o.sam, "Sam", "key-cc-0203"));
  await ownerChanges(o.owner, (st) => void (st.workspaces.find((w) => w.id === "ws_acme")!.memberAccess![`${o.sam}@example.com`].bots = { max: "write", lee: "read" }), own(o.owner, "mac-o", GITHUB_ACTS_MIN_VERSION));
  const gone = await lineOf(o.owner, c.turn.messageId);
  assert.deepEqual([gone.text, (gone.member as { name: string }).name, (gone.member as { ref: string }).ref], ["Couldn't compact this chat: Who can do this changed, so it didn't go.", "Sam", "key-cc-0203"]);
  assert.equal((await turnById(o.owner, c.turn.id))?.state, "failed");
});

test("a chat's compact runs on a bot's computer, so it needs Use its computer: one taken without it (as orgo-web said) is refused at its claim, and one whose Use its computer the owner turned off meanwhile ends; each line says why", async (t) => {
  const o = await setupChat();
  const box = await stream("/v1/runner/live", vm(o.owner, o.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  // orgo-web said Sam may not use the bots' computers as it was taken: refused at the claim, the line says why, as theirs.
  const a = await o.compact("key-cc-0401", "team", { ...o.who(o.sam, "Sam", "key-cc-0401"), computerUse: false });
  assert.equal((await runnerOn(o.owner, o.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn.id}/claim`, {})).status, 410);
  const refused = await lineOf(o.owner, a.turn.messageId);
  assert.deepEqual([refused.text, (refused.member as { ref: string }).ref], ["Couldn't compact this chat: Tara hasn't let Sam use Max's computer.", "key-cc-0401"]);
  assert.ok(!(await messages(o.owner)).some((m) => m.id === `${a.turn.messageId}_note`), "its own line, no other note");
  // Allowed as it was taken, then the owner turned Use its computer off for Sam: it ends, saying why.
  const b = await o.compact("key-cc-0402", "team", { ...o.who(o.sam, "Sam", "key-cc-0402"), computerUse: true });
  await ownerChanges(o.owner, (st) => void (st.workspaces.find((w) => w.id === "ws_acme")!.memberAccess![`${o.sam}@example.com`].computer = "none"), own(o.owner, "mac-o", GITHUB_ACTS_MIN_VERSION));
  assert.equal((await lineOf(o.owner, b.turn.messageId)).text, "Couldn't compact this chat: Tara hasn't let Sam use Max's computer.");
  assert.equal((await turnById(o.owner, b.turn.id))?.state, "failed");
  // An Admin always may.
  const c = await o.compact("key-cc-0403");
  assert.equal((await runnerOn(o.owner, o.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${c.turn.id}/claim`, {})).status, 200);
});

/* ---------------- Your Apps on the app's own computer, with everything through the cloud ---------------- */

/** The owner's state as their Mac at CLOUD_ALL_MIN_VERSION reads it (every call of theirs here says that version, so it stays the one kept). */
type AllState = { version: number; state: { workspaces: Record<string, unknown>[] } };
const cloudOwn = (owner: string) => own(owner, "mac-o", CLOUD_ALL_MIN_VERSION);
const allOf = async (owner: string) => (await (await fetch(`${cloud.url}/v1/state`, { headers: cloudOwn(owner) })).json()) as AllState;
const acmeAll = async (owner: string) => (await allOf(owner)).state.workspaces.find((w) => w.id === "ws_acme") as Record<string, unknown> & { hostedApps?: Record<string, Record<string, unknown>>; appsForMembers?: { apps: Record<string, { acts?: Record<string, unknown>[] }> }; appsRemoved?: Record<string, unknown>[]; previewPasswords?: Record<string, unknown> };
const appActs = async (owner: string, app = "site") => (await acmeAll(owner)).appsForMembers?.apps[app]?.acts ?? [];
/** A member's act from a window that says its version (none: one from before it said). */
const actFrom = (member: string, project: string, key: string, a: Record<string, unknown>, version?: string) =>
  fetch(`${cloud.url}/v1/ws/${project}/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(member)}`, "content-type": "application/json", ...(version ? { "x-bops-version": version } : {}) }, body: JSON.stringify({ key, act: a }) });
/** A member's act from a window at CLOUD_ALL_MIN_VERSION, which shows a job going on its computer. */
const cact = (member: string, project: string, key: string, a: Record<string, unknown>) => actFrom(member, project, key, a, CLOUD_ALL_MIN_VERSION);
const viewsOf = async (owner: string) => (await query<{ app: string }>("SELECT app FROM bops.app_views WHERE user_id = $1 ORDER BY app", [owner])).rows.map((r) => r.app);

/**
 * A workspace of Orgo's team switched to the cloud, with the owner's last Mac at CLOUD_ALL_MIN_VERSION (so everything goes
 * through the cloud: turns.ts allCloud), its Mac shut. App "site" (and its site "docs") at home on Max's computer, with a
 * left over there, and a runner on it (`runner`; null: none). An Admin; Sam, a Member at Your Apps Write with Remove apps on;
 * Ivy, at Write without it. `app`: more of the app's record (lost, behind, github); `bot`: more of Max (no computer).
 */
async function setupCloudApps(o: { runner?: string | null; app?: Record<string, unknown>; bot?: Record<string, unknown>; mac?: string; cloud?: boolean } = {}) {
  const owner = user("owner");
  const admin = user("admin");
  const sam = user("remover");
  const ivy = user("appwriter");
  const project = randomUUID();
  const desktop = randomUUID();
  const said = { ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme", ownerEmail: "owner@orgo.ai" };
  roles[`${owner} ${project}`] = { role: "owner", ...said };
  roles[`${admin} ${project}`] = { role: "admin", ...said };
  for (const m of [sam, ivy]) roles[`${m} ${project}`] = { role: "member", ...said };
  const DESKTOP = desktop.toUpperCase();
  const state = {
    owner: { name: "Tara" },
    workspaces: [
      { id: "ws_main", name: "Main" },
      {
        id: "ws_acme",
        name: "Acme",
        memberAccess: {
          [`${sam}@example.com`]: { others: "none", bots: { max: "read" }, apps: "write", can: { removeApps: true } },
          [`${ivy}@example.com`]: { others: "none", bots: { max: "read" }, apps: "write" },
        },
        hostedApps: { site: { botId: "max", computerId: DESKTOP, projectId: "proj-1", sites: [{ name: "docs", projectId: "proj-2" }], ...o.app } },
        appsForMembers: {
          at: 10,
          apps: {
            site: {
              head: null,
              sites: [],
              commits: [],
              deploys: [{ id: "dep-1", state: "ready", at: null, rollback: false, when: 1, live: false, canRollback: true, site: "site", env: "preview" }],
              leftOver: [{ name: "site-old", port: 3100 }],
            },
          },
        },
        previewPasswords: { "site/site": { url: "https://abcdefghijkl.orgo.dev", password: "Abc2345", at: 1 }, "site/docs": { url: "https://mnopqrstuvwx.orgo.dev", password: "Def2345", at: 1 } },
      },
    ],
    bots: [{ id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: DESKTOP, keys: ["GITHUB_TOKEN"], ...o.bot }],
    chats: [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" }],
    ...(o.runner === null ? {} : { runners: { [DESKTOP]: { status: "running", version: o.runner ?? CLOUD_ALL_MIN_VERSION, buildId: "b1", by: "mac-o", at: 1 } } }),
  };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: cloudOwn(owner), body: JSON.stringify({ base: 0, state }) })).status, 200);
  if (o.cloud !== false) assert.equal((await fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers: cloudOwn(owner), body: JSON.stringify({ wsId: "ws_acme", mode: "cloud" }) })).status, 200);
  await macSaid(owner, o.mac ?? CLOUD_ALL_MIN_VERSION);
  return { owner, admin, sam, ivy, project, desktop, device: deviceIdOf(owner, desktop) };
}
/** A member's read of the workspace from a window at `version` (CLOUD_ALL_MIN_VERSION). */
const readFrom = async (who: string, project: string, version = CLOUD_ALL_MIN_VERSION) =>
  (await (await fetch(`${cloud.url}/v1/ws/${project}/state`, { headers: { Authorization: `Bearer ${keyOf(who)}`, "x-bops-version": version } })).json()) as SharedWsState;
/** The app's computer's runner, at CLOUD_ALL_MIN_VERSION: claims a job and says how it went. */
async function runJob(s: { owner: string; desktop: string }, turn: string, job: Record<string, unknown>) {
  const c = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${turn}/claim`, {});
  assert.equal(c.status, 200, await c.clone().text());
  const d = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${turn}/done`, { state: "done", job });
  assert.equal(d.status, 200, await d.clone().text());
}

test("A Member's Update preview in a cloud workspace with the owner's Mac shut is owed as a deploy job: no cloud_pending row, a going row, the result kept", async (t) => {
  const s = await setupCloudApps();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  // From a window before CLOUD_ALL_MIN_VERSION (0.0.53, or one that doesn't say): it can't show a job going on its
  // computer, so it's said at once in plain words, nothing owed and nothing left to the owner's Mac.
  for (const v of [undefined, "0.0.53"]) {
    const old = await actFrom(s.ivy, s.project, "key-cdep-0000", { act: "deploy", app: "site" }, v);
    assert.deepEqual([old.status, await old.json()], [409, { error: "Update Bops to change apps in this workspace.", code: "viewer_bops_old" }]);
  }
  assert.deepEqual([await pendingFor(s.owner), (await turnsOf(s.owner)).length], [[], 0]);
  const r = await cact(s.ivy, s.project, "key-cdep-0001", { act: "deploy", app: "site" });
  assert.equal(r.status, 202, await r.clone().text());
  const a = (await r.json()) as { turn: string };
  assert.deepEqual(a, { ok: true, macOn: true, stored: true, cloud: true, turn: `turn_msg_job_${s.ivy}_key-cdep-0001` });
  assert.deepEqual(await pendingFor(s.owner), [], "no cloud_pending row");
  assert.equal(await noteOf(s.owner, `msg_job_${s.ivy}_key-cdep-0001`), `${s.ivy} asked Max's computer to deploy site.`);
  const row = (await query<{ member: { job?: unknown }; deadline: Date }>("SELECT member, deadline FROM bops.chat_turns WHERE user_id = $1 AND id = $2", [s.owner, a.turn])).rows[0];
  assert.deepEqual(row.member.job, { act: "deploy", app: "site" });
  const left = row.deadline.getTime() - Date.now();
  assert.ok(left > 29 * 60_000 && left <= 30 * 60_000, `a Preview deploy waits half an hour (${left} ms)`);
  assert.deepEqual((await appActs(s.owner)).map((x) => [x.key, x.act, x.going]), [["key-cdep-0001", "deploy", true]]);
  // Their window at CLOUD_ALL_MIN_VERSION: it going, and what its computer does; one from before sees no going row of a kind it'd read as done.
  const seen = await readFrom(s.ivy, s.project);
  assert.deepEqual(seen.state.appJobs, ["deploy", "rollback", "settings", "domain", "remove", "removeSite", "removeLeftOver"]);
  assert.equal(seen.state.appRemove, undefined, "no Remove apps for Ivy");
  assert.deepEqual(seen.state.apps!.list[0].acts?.map((x) => [x.act, x.going]), [["deploy", true]]);
  const old = await readFrom(s.ivy, s.project, "0.0.53");
  assert.deepEqual([old.state.apps!.list[0].acts, old.state.appJobs], [[], undefined]);
  assert.equal((await readFrom(s.sam, s.project)).state.appRemove, true, "Sam has Remove apps");
  assert.equal((await readFrom(s.admin, s.project)).state.appRemove, true, "an Admin always");
  // The runner hears it, claims it with the job, and its result is kept on the app.
  await until(() => box.of("turn").some((e) => e.data.id === a.turn), "the job's turn event");
  await runJob(s, a.turn, { ok: true, said: "Deployed site to its Preview." });
  const kept = (await appActs(s.owner))[0];
  assert.deepEqual([kept.key, kept.act, kept.ok, kept.going, kept.said], ["key-cdep-0001", "deploy", true, undefined, "Deployed site to its Preview."]);
  assert.deepEqual((await readFrom(s.ivy, s.project, "0.0.53")).state.apps!.list[0].acts?.map((x) => [x.act, x.ok]), [["deploy", true]], "done, an older window reads it too");
  // A Publish, a site's settings: owed the same way, with what the act row needs to say it.
  const pub = await actFrom(s.admin, s.project, "key-cdep-0002", { act: "deploy", app: "site", env: "prod" }, CLOUD_ALL_MIN_VERSION);
  assert.equal(pub.status, 202, await pub.clone().text());
  assert.equal(await noteOf(s.owner, `msg_job_${s.admin}_key-cdep-0002`), `${s.admin} asked Max's computer to publish site.`);
  assert.deepEqual((await appActs(s.owner)).map((x) => [x.act, x.env, x.going]).slice(0, 1), [["deploy", "prod", true]]);
  assert.deepEqual(await pendingFor(s.owner), []);
});

test("in a cloud workspace no home, no computer, no runner or an old runner gives 409 at once, nothing queued; a second job on the app waits for the first; a kind turned off is said", async () => {
  const words = async (s: { project: string; ivy: string; owner: string }, key: string, a: Record<string, unknown> = { act: "deploy", app: "site" }) => {
    const r = await cact(s.ivy, s.project, key, a);
    const b = (await r.json()) as { code?: string; error?: string };
    assert.deepEqual(await pendingFor(s.owner), [], `${key}: nothing waits for the owner's Mac`);
    return [r.status, b.code, b.error];
  };
  const lost = await setupCloudApps({ app: { lost: 5 } });
  assert.deepEqual(await words(lost, "key-cref-0001"), [409, "computer_not_ready", "site lost its computer, so nothing can run it from here."]);
  const none = await setupCloudApps({ bot: { computerId: undefined } });
  assert.deepEqual(await words(none, "key-cref-0002"), [409, "computer_not_ready", "Max has no computer of its own, so site can't change from here. Give Max a computer in Max's settings."]);
  const noRunner = await setupCloudApps({ runner: null });
  assert.deepEqual(await words(noRunner, "key-cref-0003"), [409, "computer_not_ready", "Max's computer is on, but its Bops isn't set up yet. Tara needs to open the updated Bops once."]);
  const old = await setupCloudApps({ runner: "0.0.53" });
  assert.deepEqual(await words(old, "key-cref-0004"), [409, "computer_not_ready", "Max's computer runs an older Bops that can't do this yet. It updates the next time Tara opens Bops."]);
  for (const x of [lost, none, noRunner, old]) assert.equal((await turnsOf(x.owner)).length, 0, "no job owed");
  // A computer the owner's Mac last found down: owed all the same (its wake says why it can't run).
  const down = await setupCloudApps();
  await ownerChanges(down.owner, (st) => void ((st as unknown as { runners: Record<string, Record<string, unknown>> }).runners[down.desktop.toUpperCase()].down = true), cloudOwn(down.owner));
  const first = await cact(down.ivy, down.project, "key-cref-0005", { act: "deploy", app: "site" });
  assert.equal(first.status, 202, await first.clone().text());
  // Its computer still on that one: a second job on the same app is said at once, never queued behind it.
  assert.deepEqual(await words(down, "key-cref-0006", { act: "settings", app: "site", port: 3001 }), [409, "not_waiting", "Its computer is still on the last one. Try again once it's done."]);
  assert.equal((await cact(down.ivy, down.project, "key-cref-0005", { act: "deploy", app: "site" })).status, 202, "the same act again finds its job");
  assert.equal((await turnsOf(down.owner)).length, 1);
  // The kill switch: a kind left out of BOPS_APP_JOBS is refused, and its button hidden.
  const off = await setupCloudApps();
  process.env.BOPS_APP_JOBS = "deploy";
  try {
    assert.deepEqual(await words(off, "key-cref-0007", { act: "settings", app: "site", port: 3001 }), [409, "cloud_not_yet", "Max's computer can't do this from the cloud yet."]);
    assert.deepEqual((await readFrom(off.ivy, off.project)).state.appJobs, ["deploy"]);
    assert.equal((await readFrom(off.admin, off.project)).state.appRemove, undefined, "no remove from the cloud: no Remove buttons");
  } finally {
    delete process.env.BOPS_APP_JOBS;
  }
  // A remove of an app with a copy left on another computer: its computer's runner can't reach that one.
  const behind = await setupCloudApps({ app: { behind: [{ site: "site", computerId: "OTHER-COMPUTER", projectId: "proj-9" }] } });
  const b = await cact(behind.admin, behind.project, "key-cref-0008", { act: "remove", app: "site" });
  assert.deepEqual([b.status, ((await b.json()) as { error: string }).error], [409, "site still runs an old copy on another computer, so it can't be removed from here yet."]);
});

test("in a cloud workspace each refusal says its own reason: the app lost its computer, no bot works on it, its bot moved to another computer, or (a remove) a copy is left on another computer even once it lost its own", async () => {
  const words = async (s: { project: string; admin: string; owner: string }, key: string, a: Record<string, unknown> = { act: "deploy", app: "site" }) => {
    const r = await cact(s.admin, s.project, key, a);
    const b = (await r.json()) as { code?: string; error?: string };
    assert.deepEqual([await pendingFor(s.owner), (await turnsOf(s.owner)).length], [[], 0], `${key}: nothing owed or queued`);
    return [r.status, b.code, b.error];
  };
  const lost = await setupCloudApps({ app: { lost: 5 } });
  assert.deepEqual(await words(lost, "key-cwhy-0001"), [409, "computer_not_ready", "site lost its computer, so nothing can run it from here."]);
  const noBot = await setupCloudApps({ app: { botId: undefined } });
  assert.deepEqual(await words(noBot, "key-cwhy-0002"), [409, "computer_not_ready", "No bot works on site, so nothing can run it from here."]);
  // Live on its old computer, its bot on another one now: it didn't lose its computer.
  const moved = await setupCloudApps({ app: { computerId: "OLD-COMPUTER" } });
  assert.deepEqual(await words(moved, "key-cwhy-0003"), [409, "computer_not_ready", "Max works on another computer now, so site can't change from here until it's deployed there."]);
  // Lost, with a copy still serving on another computer: that copy is what keeps it from going.
  const behind = await setupCloudApps({ app: { lost: 5, behind: [{ site: "site", computerId: "OTHER-COMPUTER", projectId: "proj-9" }] } });
  assert.deepEqual(await words(behind, "key-cwhy-0004", { act: "remove", app: "site" }), [409, "not_waiting", "site still runs an old copy on another computer, so it can't be removed from here yet."]);
});

test("in a cloud workspace an app of a bot set to work on the owner's Mac is done on that bot's computer: owed, claimed and run there (never refused as moved); a GitHub key only that bot holds isn't one its computer can use", async (t) => {
  const s = await setupCloudApps({ bot: { runsOn: "mac" } });
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  const r = await cact(s.ivy, s.project, "key-cmac-b001", { act: "deploy", app: "site" });
  assert.equal(r.status, 202, await r.clone().text());
  const a = (await r.json()) as { turn: string };
  assert.equal((await turnById(s.owner, a.turn))?.desktopId, s.desktop.toLowerCase(), "owed to its bot's computer");
  await runJob(s, a.turn, { ok: true, said: "Deployed site to its Preview." });
  assert.equal((await turnById(s.owner, a.turn))?.state, "done");
  const kept = (await appActs(s.owner))[0];
  assert.deepEqual([kept.key, kept.ok, kept.going, kept.said], ["key-cmac-b001", true, undefined, "Deployed site to its Preview."]);
  // Publish of the app on GitHub: the only bot with the GitHub key works on the Mac, so its computer's runner has none
  // (lib/server/hosted-apps.ts githubKeyHere). Said at once, nothing owed.
  const github = { repo: "example-org/web", branch: "main", path: "", last: { sha: SHA, ingot: INGOT, keep: [], when: 7 } };
  const k = await setupCloudApps({ app: { github, sites: undefined }, bot: { runsOn: "mac" } });
  const p = await cact(k.admin, k.project, "key-cmac-b002", { act: "deploy", app: "site", env: "prod" });
  const pb = (await p.json()) as { code: string; error: string };
  assert.deepEqual([p.status, pb.code, pb.error], [409, "github_no_key", "Max's computer has no GitHub key, so it can't do this. Give Max the GitHub key in Keys, then try again."]);
  const l = await cact(k.admin, k.project, "key-cmac-b003", { act: "githubLink", app: "site" });
  assert.deepEqual([l.status, ((await l.json()) as { code: string }).code], [409, "github_no_key"]);
  assert.deepEqual([await pendingFor(k.owner), (await turnsOf(k.owner)).length], [[], 0]);
});

test("a domain job's end keeps the domain its computer pointed, by name, when it's a bare hostname (never a link of its choosing)", async (t) => {
  const s = await setupCloudApps();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  const one = (await (await cact(s.ivy, s.project, "key-cdom-0001", { act: "domain", app: "site", zone: "zone-1", subdomain: "shop" })).json()) as { turn: string };
  await runJob(s, one.turn, { ok: true, said: "Pointed shop.example.com at site.", domain: "Shop.Example.com" });
  const kept = (await appActs(s.owner))[0];
  assert.deepEqual([kept.key, kept.act, kept.domain, kept.ok], ["key-cdom-0001", "domain", "shop.example.com", true]);
  assert.equal((await readFrom(s.ivy, s.project)).state.apps!.list[0].acts?.[0].domain, "shop.example.com", "shown: Ivy pointed shop.example.com at it");
  // Anything but a bare hostname: the row says a domain, unnamed.
  const two = (await (await cact(s.ivy, s.project, "key-cdom-0002", { act: "domain", app: "site", zone: "zone-1" })).json()) as { turn: string };
  await runJob(s, two.turn, { ok: true, said: "Pointed a domain at site.", domain: "https://evil.example/login" });
  const plain = (await appActs(s.owner))[0];
  assert.deepEqual([plain.key, plain.domain, plain.ok], ["key-cdom-0002", undefined, true]);
});

test("in a cloud workspace a GitHub Link never queues for the owner's Mac, and a Publish of a GitHub app with no key there is said at once", async () => {
  const github = { repo: "example-org/web", branch: "main", path: "", last: { sha: SHA, ingot: INGOT, keep: [], when: 7 } };
  const s = await setupCloudApps({ app: { github, sites: undefined }, runner: "0.0.51" });
  // Save and link, the runner older than the GitHub acts: the setting is kept, the Link said, nothing waits for the Mac.
  const r = await cact(s.admin, s.project, "key-cgh-00001", { act: "github", app: "site", github: { repo: "example-org/web", branch: "main", path: "" }, link: true });
  const body = (await r.json()) as { code: string; error: string };
  assert.deepEqual([r.status, body.code], [409, "computer_not_ready"]);
  assert.deepEqual(await pendingFor(s.owner), [], "never queued");
  assert.equal((await turnsOf(s.owner)).length, 0);
  const l = await cact(s.admin, s.project, "key-cgh-00002", { act: "githubLink", app: "site" });
  assert.equal(l.status, 409);
  assert.deepEqual(await pendingFor(s.owner), []);
  // Where it publishes alone, kept here: said as the cloud's (the window never says it went to the owner's Bops).
  const set = await cact(s.admin, s.project, "key-cgh-00005", { act: "github", app: "site", github: { repo: "example-org/web", branch: "main", path: "" } });
  assert.deepEqual([set.status, await set.json()], [202, { ok: true, macOn: true, stored: true, cloud: true }]);
  // Publish of an app on GitHub, no bot on its computer given the GitHub key: said, without the owner's Mac in it.
  const k = await setupCloudApps({ app: { github, sites: undefined }, bot: { keys: [] } });
  const p = await cact(k.admin, k.project, "key-cgh-00003", { act: "deploy", app: "site", env: "prod" });
  const pb = (await p.json()) as { code: string; error: string };
  assert.deepEqual([p.status, pb.code, pb.error], [409, "github_no_key", "Max's computer has no GitHub key, so it can't do this. Give Max the GitHub key in Keys, then try again."]);
  // A Preview deploy of it needs no key.
  assert.equal((await cact(k.ivy, k.project, "key-cgh-00004", { act: "deploy", app: "site" })).status, 202);
  assert.deepEqual(await pendingFor(k.owner), []);
});

test("a finished remove drops the app's record, what members saw, its passwords and its view, and keeps a removal row; a stale copy can't make it again; an Admin deletes its code with their own key", async (t) => {
  const s = await setupCloudApps();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  await query("INSERT INTO bops.app_views (user_id, ws_id, app, view, view_at) VALUES ($1, 'ws_acme', 'site', '{}'::jsonb, now())", [s.owner]);
  // Who may: Ivy hasn't Remove apps; Sam has it, but its code too is an Admin's.
  const ivy = await cact(s.ivy, s.project, "key-crm-00001", { act: "remove", app: "site" });
  assert.deepEqual([ivy.status, ((await ivy.json()) as { error: string }).error], [403, "The owner or an Admin can let you remove apps in Team."]);
  const samCode = await cact(s.sam, s.project, "key-crm-00002", { act: "remove", app: "site", repo: true });
  assert.equal(samCode.status, 403);
  const r = await actFrom(s.admin, s.project, "key-crm-00003", { act: "remove", app: "site", repo: true }, CLOUD_ALL_MIN_VERSION);
  assert.equal(r.status, 202, await r.clone().text());
  const a = (await r.json()) as { turn: string };
  assert.equal(await noteOf(s.owner, `msg_job_${s.admin}_key-crm-00003`), `${s.admin} asked Max's computer to remove site.`);
  const left = (await turnById(s.owner, a.turn))!.deadline - Date.now();
  assert.ok(left > 9 * 60_000 && left <= 10 * 60_000, `a remove waits a chat turn's ten minutes (${left} ms)`);
  await runJob(s, a.turn, { ok: true, said: "Took site off the web.", removed: "app" });
  const ws = await acmeAll(s.owner);
  assert.equal(ws.hostedApps?.site, undefined, "its record");
  assert.equal(ws.appsForMembers?.apps.site, undefined, "what members saw, and its acts");
  assert.equal(ws.previewPasswords, undefined, "its passwords");
  assert.deepEqual(await viewsOf(s.owner), [], "its view");
  assert.deepEqual(
    ws.appsRemoved?.map((x) => [x.key, x.app, x.ok, x.said, x.codeLeft, x.name]),
    [["key-crm-00003", "site", true, "Took site off the web.", true, s.admin]],
  );
  const shown = await readFrom(s.sam, s.project);
  assert.deepEqual(shown.state.apps!.removed?.map((x) => [x.key, x.app, x.codeLeft]), [["key-crm-00003", "site", true]], "said in Your Apps");
  assert.equal((await readFrom(s.sam, s.project, "0.0.53")).state.apps!.removed, undefined, "not to a window from before");
  // The runner's own write from before it was done, bringing the app back: refused (the name was removed moments ago).
  const mine = (await (await runner(s.owner, s.desktop, "/v1/state")).json()) as AllState;
  const back = JSON.parse(JSON.stringify(mine)) as AllState;
  (back.state.workspaces.find((w) => w.id === "ws_acme") as { hostedApps: Record<string, unknown> }).hostedApps = { site: { botId: "max", computerId: s.desktop.toUpperCase() } };
  const put = await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: { Authorization: `Bearer ${vm(s.owner, s.desktop)}`, "x-bops-user": s.owner, "x-bops-protocol": "2", "content-type": "application/json" }, body: JSON.stringify({ base: back.version, state: back.state }) });
  assert.equal(put.status, 403, "a removed app isn't made again from a stale copy");
  // Its code: a Member never; an Admin with their own key, once.
  assert.equal((await cact(s.sam, s.project, "key-crm-00004", { act: "deleteCode", app: "site" })).status, 403);
  ingotAnswer.status = 409;
  ingotAnswer.body = { message: "the repo is locked" };
  const no = await cact(s.admin, s.project, "key-crm-00005", { act: "deleteCode", app: "site" });
  assert.deepEqual([no.status, await no.json()], [202, { ok: true, macOn: true, stored: true }]);
  assert.deepEqual((await acmeAll(s.owner)).appsRemoved?.map((x) => [x.said, x.codeLeft]), [["Took site off the web. Its code wasn't deleted: the repo is locked", true]]);
  // Ingot refusing with no words of its own (or only its code for it): plain words, never its status or code.
  for (const [status, body, line] of [
    [403, {}, "Ingot didn't allow it."],
    [401, { error: "forbidden" }, "Ingot didn't allow it."],
    [409, {}, "Ingot couldn't delete it now."],
    [400, { error: "bad_request" }, "Ingot didn't delete it."],
  ] as const) {
    ingotAnswer.status = status;
    ingotAnswer.body = body;
    assert.equal((await cact(s.admin, s.project, `key-crm-0${status}`, { act: "deleteCode", app: "site" })).status, 202);
    assert.deepEqual((await acmeAll(s.owner)).appsRemoved?.map((x) => [x.said, x.codeLeft]), [[`Took site off the web. Its code wasn't deleted: ${line}`, true]], `${status}`);
  }
  // Ingot not answering: 502 in Bops Cloud's own words (a 503 would read as Orgo not checking their access), nothing kept.
  ingotAnswer.status = 503;
  const down = await cact(s.admin, s.project, "key-crm-00503", { act: "deleteCode", app: "site" });
  assert.deepEqual([down.status, await down.json()], [502, { error: "Ingot isn't answering. Try again.", code: "ingot_down" }]);
  ingotAnswer.status = 204;
  delete ingotAnswer.body;
  const yes = await cact(s.admin, s.project, "key-crm-00006", { act: "deleteCode", app: "site" });
  assert.equal(yes.status, 202);
  assert.deepEqual((await acmeAll(s.owner)).appsRemoved?.map((x) => [x.said, x.codeLeft]), [["Took site off the web. Its code was deleted too.", undefined]]);
  // Each time with the Admin's own key: the lock, the four refusals, Ingot down, then deleted.
  assert.deepEqual(
    ingotDeletes.filter((d) => d.project === s.project.toLowerCase()).map((d) => [d.app, d.key]),
    Array.from({ length: 7 }, () => ["site", `key-${s.admin}`]),
    "with the Admin's own key",
  );
  // Nothing left to delete: no such app.
  assert.equal((await cact(s.admin, s.project, "key-crm-00007", { act: "deleteCode", app: "site" })).status, 404);
  // Its code left, but removed over a day ago: not offered any more, and said plainly if asked; the same once an app of
  // that name is made again (its code in Ingot is the new one's). Ingot is never asked.
  const asked = ingotDeletes.length;
  const row = (at: number) => ({ key: "key-crm-00003", userId: s.admin, name: s.admin, app: "site", ok: true, said: "Took site off the web.", codeLeft: true, at });
  await ownerChanges(s.owner, (st) => void ((st.workspaces.find((w) => w.id === "ws_acme") as Record<string, unknown>).appsRemoved = [row(Date.now() - DELETE_CODE_MS - 60_000)]), cloudOwn(s.owner));
  assert.deepEqual((await readFrom(s.admin, s.project)).state.apps!.removed?.map((x) => [x.key, x.codeLeft]), [["key-crm-00003", undefined]], "no Delete its code");
  const late = await cact(s.admin, s.project, "key-crm-00008", { act: "deleteCode", app: "site" });
  assert.deepEqual([late.status, ((await late.json()) as { error: string }).error], [409, "It was removed more than a day ago, so its code can't be deleted from here."]);
  await ownerChanges(
    s.owner,
    (st) => {
      const w = st.workspaces.find((x) => x.id === "ws_acme") as Record<string, unknown>;
      w.appsRemoved = [row(Date.now() - 60_000)];
      w.hostedApps = { site: { botId: "max", computerId: s.desktop.toUpperCase() } };
    },
    cloudOwn(s.owner),
  );
  assert.deepEqual((await readFrom(s.admin, s.project)).state.apps!.removed?.map((x) => [x.key, x.codeLeft]), [["key-crm-00003", undefined]], "made again: no Delete its code");
  const again = await cact(s.admin, s.project, "key-crm-00009", { act: "deleteCode", app: "site" });
  assert.deepEqual([again.status, ((await again.json()) as { error: string }).error], [409, "site is in this workspace again, so the old one's code can't be deleted from here."]);
  assert.equal(ingotDeletes.length, asked, "Ingot never asked");
});

test("a finished removeSite drops the site and its password; a remove of an app that lost its computer is done by Bops Cloud itself; a demoted Admin's remove ends", async (t) => {
  const s = await setupCloudApps();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  // Its own site is never removed this way; another of its sites is, by a Member with Remove apps.
  assert.equal((await cact(s.sam, s.project, "key-crs-00001", { act: "removeSite", app: "site", site: "site" })).status, 400);
  assert.equal((await cact(s.sam, s.project, "key-crs-00002", { act: "removeSite", app: "site", site: "nope" })).status, 404);
  const r = (await (await cact(s.sam, s.project, "key-crs-00003", { act: "removeSite", app: "site", site: "docs" })).json()) as { turn: string };
  assert.equal(await noteOf(s.owner, `msg_job_${s.sam}_key-crs-00003`), `${s.sam} asked Max's computer to remove docs from site.`);
  await runJob(s, r.turn, { ok: true, said: "Took docs off the web.", removed: "site" });
  const ws = await acmeAll(s.owner);
  assert.equal(ws.hostedApps?.site.sites, undefined, "its only other site gone");
  assert.deepEqual(Object.keys(ws.previewPasswords ?? {}), ["site/site"]);
  assert.deepEqual((await appActs(s.owner)).map((x) => [x.act, x.site, x.ok, x.said]), [["removeSite", "docs", true, "Took docs off the web."]]);
  // A left over, by the name its view shows: a name it hasn't is no such one.
  assert.equal((await cact(s.sam, s.project, "key-crs-00004", { act: "removeLeftOver", app: "site", leftOver: "nope" })).status, 404);
  const lo = (await (await cact(s.sam, s.project, "key-crs-00005", { act: "removeLeftOver", app: "site", leftOver: "site-old" })).json()) as { turn: string };
  assert.equal(await noteOf(s.owner, `msg_job_${s.sam}_key-crs-00005`), `${s.sam} asked Max's computer to remove the left over site-old.`);
  await runJob(s, lo.turn, { ok: true, said: "Removed site-old." });
  assert.deepEqual((await appActs(s.owner)).map((x) => [x.act, x.leftOver, x.ok]).slice(0, 1), [["removeLeftOver", "site-old", true]]);
  // An app whose computer is gone, nothing left elsewhere: Bops Cloud takes it out itself, no job.
  const lost = await setupCloudApps({ app: { lost: 5 } });
  const l = await cact(lost.sam, lost.project, "key-crs-00006", { act: "remove", app: "site" });
  assert.deepEqual([l.status, await l.json()], [202, { ok: true, macOn: true, stored: true, cloud: true }]);
  assert.equal((await acmeAll(lost.owner)).hostedApps?.site, undefined);
  assert.deepEqual((await acmeAll(lost.owner)).appsRemoved?.map((x) => [x.key, x.ok, x.codeLeft]), [["key-crs-00006", true, undefined]]);
  assert.equal((await turnsOf(lost.owner)).length, 0);
  // An Admin's remove owed, then they're made a Member: orgo-web's notice ends it, and the runner's claim is refused.
  const d = await setupCloudApps();
  const owed = (await (await cact(d.admin, d.project, "key-crs-00007", { act: "remove", app: "site" })).json()) as { turn: string };
  roles[`${d.admin} ${d.project}`] = { role: "member", ownerUserId: d.owner, bopsWsId: "ws_acme", name: "Acme", ownerEmail: "owner@orgo.ai" };
  assert.equal((await membersChanged(d.project, d.admin)).status, 204);
  await until(async () => (await turnById(d.owner, owed.turn))?.state !== "owed", "ended on the notice");
  assert.equal((await runnerOn(d.owner, d.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${owed.turn}/claim`, {})).status !== 200, true);
  assert.ok((await acmeAll(d.owner)).hostedApps?.site, "the app stays");
});

test("in a workspace still on the owner's Mac, a remove waits for that Mac as before, once it's new enough; the GitHub and deploy acts are as they were", async () => {
  const s = await setupCloudApps({ cloud: false });
  const r = await act(s.sam, s.project, "key-cmac-0001", { act: "remove", app: "site" });
  assert.deepEqual([r.status, await r.json()], [202, { ok: true, macOn: false }]);
  assert.deepEqual((await pendingFor(s.owner)).map((p) => [p.act, p.key]), [[{ act: "remove", app: "site" }, "key-cmac-0001"]]);
  assert.equal((await turnsOf(s.owner)).length, 0);
  assert.equal((await act(s.ivy, s.project, "key-cmac-0002", { act: "deploy", app: "site" })).status, 202);
  assert.equal((await pendingFor(s.owner)).length, 2, "a deploy waits for the Mac too");
  assert.equal((await readFrom(s.admin, s.project)).state.appRemove, true, "the owner's Mac removes");
  assert.equal((await readFrom(s.admin, s.project)).state.appJobs, undefined);
  // The owner's last Mac older: a remove is refused (it would drop it), and no Remove buttons.
  const old = await setupCloudApps({ cloud: false, mac: "0.0.53" });
  const o = await act(old.admin, old.project, "key-cmac-0003", { act: "remove", app: "site" });
  assert.deepEqual([o.status, ((await o.json()) as { code: string }).code], [409, "owner_bops_old"]);
  assert.equal((await readFrom(old.admin, old.project)).state.appRemove, undefined);
  // A switched workspace whose owner's Mac is older isn't everything through the cloud: as before, never a job for its acts.
  const half = await setupCloudApps({ mac: "0.0.53" });
  assert.equal((await act(half.ivy, half.project, "key-cmac-0004", { act: "deploy", app: "site" })).status, 202);
  assert.equal((await turnsOf(half.owner)).length, 0);
  assert.equal((await pendingFor(half.owner)).length, 1);
});

/* ---------------- One lease per app, and the app jobs' lane ---------------- */

/** The owner's Mac (device "mac-o", at `version`) on app `app`'s lease (cloud/app-lease.ts). */
const leaseOf = (owner: string, op: "take" | "renew" | "free", nonce: string, version = CLOUD_ALL_MIN_VERSION, app = "site", kind = "deploy") =>
  fetch(`${cloud.url}/v1/apps/lease`, { method: "POST", headers: own(owner, "mac-o", version), body: JSON.stringify({ op, ws: "ws_acme", app, kind, holder: `mac:mac-o:${nonce}` }) });
const leasesOf = async (owner: string) => (await query<{ app: string; holder: string; device_id: string; kind: string; until: Date }>("SELECT app, holder, device_id, kind, until FROM bops.app_leases WHERE user_id = $1 ORDER BY app", [owner])).rows;
/** A turn the sweep offers again now (owed past OFFER_AGAIN_S). */
const owedAWhile = (owner: string, id: string) => query("UPDATE bops.chat_turns SET updated_at = now() - interval '1 minute' WHERE user_id = $1 AND id = $2", [owner, id]);
/** An answer owed in Max's chat (the owner's own: no member), after whatever's owed there already. */
const oweAnswer = async (s: { owner: string; desktop: string; device: string }, id: string) => {
  await query(
    `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
     VALUES ($1, $2, $3, 'bot:max', 'max', 'ws_acme', NULL, $4, $5, 'owed', now() + interval '10 minutes', $6)`,
    [s.owner, id, `msg_${id}`, s.desktop, s.device, Date.now()],
  );
  return id;
};
const offers = (box: { of: (type: string) => Ev[] }, id: string) => box.of("turn").filter((e) => e.data.id === id).length;

test("an app's job waits on its app's lease: owed as before (takeAppJob doesn't look), its claim 409 busy while the owner's Mac holds it and offered again, claimed once it's free; then the job holds it, its beat renews it and its done frees it", async (t) => {
  const s = await setupCloudApps();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  assert.equal((await leaseOf(s.owner, "take", "aaaa0001")).status, 200);
  const r = await cact(s.ivy, s.project, "key-lease-0001", { act: "deploy", app: "site" });
  assert.equal(r.status, 202, await r.clone().text());
  const a = (await r.json()) as { turn: string };
  assert.equal(a.turn, `turn_msg_job_${s.ivy}_key-lease-0001`);
  await until(() => offers(box, a.turn) > 0, "the job's turn event");
  const busy = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/claim`, {});
  assert.deepEqual([busy.status, await busy.json()], [409, { error: APP_CLAIM_BUSY, code: "busy" }]);
  assert.equal(APP_CLAIM_BUSY, "Another change to this app comes first.");
  assert.equal((await turnById(s.owner, a.turn))?.state, "owed", "nothing changed");
  assert.deepEqual((await leasesOf(s.owner)).map((l) => l.holder), ["mac:mac-o:aaaa0001"]);
  // The sweep offers it again; still held, still waiting.
  const before = offers(box, a.turn);
  await owedAWhile(s.owner, a.turn);
  await sweepTurns();
  await until(() => offers(box, a.turn) > before, "offered again");
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/claim`, {})).status, 409);
  // Freed: claimed, and now the job's (held by the computer that claimed it).
  assert.equal((await leaseOf(s.owner, "free", "aaaa0001")).status, 200);
  const ok = await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/claim`, {});
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual((await leasesOf(s.owner)).map((l) => [l.app, l.holder, l.device_id, l.kind]), [["site", `job:${a.turn}`, s.device, "deploy"]]);
  // The Mac meanwhile: refused, the job's, in its words.
  const mac = await leaseOf(s.owner, "take", "bbbb0002");
  assert.deepEqual([mac.status, ((await mac.json()) as { by: string; error: string }).by], [409, "job"]);
  assert.equal(APP_BUSY_WORDS.job("site"), "A change to site is still going on its computer. Try again once it's done.");
  // Its beat keeps it.
  await query("UPDATE bops.app_leases SET until = now() + interval '5 seconds' WHERE user_id = $1", [s.owner]);
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/beat`, { phase: "tools" })).status, 200);
  assert.ok((await leasesOf(s.owner))[0].until.getTime() > Date.now() + APP_LEASE_MS - 5_000, "renewed");
  // Its end frees it, and the Mac takes it.
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/done`, { state: "done", job: { ok: true, said: "Deployed site to its Preview." } })).status, 200);
  assert.deepEqual(await leasesOf(s.owner), []);
  assert.equal((await leaseOf(s.owner, "take", "bbbb0002")).status, 200);
});

test("a job's lease goes when its runner goes quiet (the sweep owes it again), and with a failed end", async (t) => {
  const s = await setupCloudApps();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  const a = (await (await cact(s.ivy, s.project, "key-lease-0002", { act: "deploy", app: "site" })).json()) as { turn: string };
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.equal((await leasesOf(s.owner)).length, 1);
  await query("UPDATE bops.chat_turns SET lease_until = now() - interval '1 second' WHERE user_id = $1 AND id = $2", [s.owner, a.turn]);
  await sweepTurns();
  assert.equal((await turnById(s.owner, a.turn))?.state, "owed", "owed again (it did nothing yet)");
  assert.deepEqual(await leasesOf(s.owner), [], "the sweep freed it");
  // Claimed again, then a failed end: freed too.
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.equal((await leasesOf(s.owner)).length, 1);
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${a.turn}/done`, { state: "failed", note: "Orgo didn't answer." })).status, 200);
  assert.deepEqual(await leasesOf(s.owner), []);
});

test("a GitHub job takes its app's lease too, in a workspace still on the owner's Mac: owed while the Mac holds it, claimed once it's freed", async (t) => {
  const s = await setupGithub();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello");
  t.after(() => box.close());
  assert.equal((await leaseOf(s.owner, "take", "aaaa0001", GITHUB_ACTS_MIN_VERSION)).status, 200);
  const r = await act(s.admin, s.project, "key-lease-gh01", { act: "githubPull", app: "site" });
  assert.equal(r.status, 202, await r.clone().text());
  const a = (await r.json()) as { turn: string };
  const busy = await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {});
  assert.deepEqual([busy.status, ((await busy.json()) as { code: string }).code], [409, "busy"]);
  assert.equal((await leaseOf(s.owner, "free", "aaaa0001", GITHUB_ACTS_MIN_VERSION)).status, 200);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  assert.deepEqual((await leasesOf(s.owner)).map((l) => [l.holder, l.kind]), [[`job:${a.turn}`, "deploy"]]);
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/done`, { state: "done", job: { ok: true, said: "Brought 2 changes from GitHub into Ingot." } })).status, 200);
  assert.deepEqual(await leasesOf(s.owner), []);
});

test("the app jobs' lane: a job owed on its app's lease doesn't hold an answer in that chat, and an answer running doesn't hold a job; each lane's next is offered as one ends, and by the sweep", async (t) => {
  const s = await setupCloudApps();
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": CLOUD_ALL_MIN_VERSION });
  t.after(() => box.close());
  const claim = (id: string) => runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${id}/claim`, {});
  // The owner's Mac holds the app: the job is owed, first in the chat.
  assert.equal((await leaseOf(s.owner, "take", "aaaa0001")).status, 200);
  const job = ((await (await cact(s.ivy, s.project, "key-lane-0001", { act: "deploy", app: "site" })).json()) as { turn: string }).turn;
  const first = await oweAnswer(s, "turn_lane_answer1");
  const second = await oweAnswer(s, "turn_lane_answer2");
  // An answer after it isn't held by it (before, one at a time in the chat held it for the job's half hour).
  assert.equal((await claim(job)).status, 409);
  assert.equal((await claim(first)).status, 200, "the answer goes on");
  const held = await claim(second);
  assert.deepEqual([held.status, ((await held.json()) as { error: string }).error], [409, "Another answer in this chat comes first."], "answers still one at a time");
  // The sweep offers each lane's oldest: the job and the next answer alike.
  for (const id of [job, second]) await owedAWhile(s.owner, id);
  const was = { job: offers(box, job), second: offers(box, second) };
  await sweepTurns();
  await until(() => offers(box, job) > was.job && offers(box, second) > was.second, "each lane's oldest offered again");
  // The first answer ends: its lane's next goes to the runner (not only the chat's oldest, the job).
  const n = offers(box, second);
  assert.equal((await claim(second)).status, 409);
  assert.equal((await runnerOn(s.owner, s.desktop, CLOUD_ALL_MIN_VERSION, `/v1/runner/turns/${first}/done`, { state: "done" })).status, 200);
  await until(() => offers(box, second) > n, "the next answer offered");
  assert.equal((await claim(second)).status, 200);
  // An answer running doesn't hold a job: freed, the job is claimed beside it.
  assert.equal((await leaseOf(s.owner, "free", "aaaa0001")).status, 200);
  const ok = await claim(job);
  assert.equal(ok.status, 200, await ok.clone().text());
  // App jobs are still one at a time in their lane: another of the chat's (another app's) waits for it.
  const next = await oweJob(s, "turn_lane_job2", { userId: s.admin, email: `${s.admin}@example.com`, name: "Ada", ref: "key-lane-0002", projectId: s.project, role: "admin" }, { act: "deploy", app: "other" });
  const lane = await claim(next);
  assert.deepEqual([lane.status, ((await lane.json()) as { error: string }).error], [409, "Another answer in this chat comes first."]);
});

/* ---------------- Runners that set up and update themselves (CLOUD_SELF_MIN_VERSION) ---------------- */

const SELF = CLOUD_SELF_MIN_VERSION;
/** The signed releases Bops Cloud knows here, as if read from latest.json (runner-release.ts): 0.0.54 and SELF. */
function signedReleases() {
  forgetReleases();
  rememberRelease({ version: "0.0.54", buildId: "Build54", stateLevel: 4, releasedAt: Date.now() - 86_400_000 });
  rememberRelease({ version: SELF, buildId: "Build55", stateLevel: 4, releasedAt: Date.now() });
}
/** `fn` as an owner whose Mac runs `mac` (SELF) on every call, with the signed releases known; none known after. */
async function inSelf(fn: () => Promise<void>, mac = SELF) {
  macAt = mac;
  signedReleases();
  try {
    await fn();
  } finally {
    macAt = "0.0.36";
    forgetReleases();
  }
}
/** setup, for an owner whose last Mac said `mac` (inside inSelf, with the same). */
async function setupSelf(mac = SELF) {
  const s = await setup();
  await macSaid(s.owner, mac);
  return s;
}
/** A computer's own key, bound to it (the fake orgo-web's `ckey-`). */
const ckey = (userId: string, desktop: string) => `ckey-${userId}~${desktop}`;
/** The owner's record of the runner on `desktop` (AppState.runners, any case), with the key it's under; undefined: none. */
async function recordOf(owner: string, desktop: string): Promise<(Record<string, unknown> & { key: string }) | undefined> {
  const runners = ((await blobOf(owner)).runners ?? {}) as Record<string, Record<string, unknown>>;
  const key = Object.keys(runners).find((k) => k.toLowerCase() === desktop.toLowerCase());
  return key ? { key, ...runners[key] } : undefined;
}
/** The computer's keeper asked Bops Cloud `ago` (POST /v1/runner/keeper, as K2's route keeps it). */
const keeperAsked = (owner: string, desktop: string, ago = "1 minute") =>
  query(
    `INSERT INTO bops.runner_keeper (user_id, desktop_id, keeper, answer, why, asked_at) VALUES ($1, $2, '0.0.55', 'nothing', 'upToDate', now() - $3::interval)
     ON CONFLICT (user_id, desktop_id) DO UPDATE SET asked_at = EXCLUDED.asked_at`,
    [owner, desktop.toLowerCase(), ago],
  );
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a runner's build and what it signs in with are kept as it connects; past the newest signed release nothing new is kept, and with none known as before", async () => {
  const s = await setup();
  forgetReleases();
  type Seen = { version: string; build_id: string | null; auth: string | null };
  const seen = async () => (await query<Seen>("SELECT version, build_id, auth FROM bops.runner_seen WHERE user_id = $1", [s.owner])).rows[0];
  // On its computer's identity, with its build.
  let box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.54", "x-bops-build": "Build54" });
  await until(async () => (await seen())?.build_id === "Build54", "kept with its build");
  assert.deepEqual(await seen(), { version: "0.0.54", build_id: "Build54", auth: "identity" });
  box.close();
  // On its computer's key, saying a build that isn't one: none kept.
  box = await stream("/v1/runner/live", ckey(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.54", "x-bops-build": "not a build!" });
  await until(async () => (await seen())?.auth === "key", "on its key");
  assert.deepEqual(await seen(), { version: "0.0.54", build_id: null, auth: "key" });
  box.close();
  // No signed release known yet: whatever it says is kept, as before.
  box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.60", "x-bops-build": "Build60" });
  await until(async () => (await seen())?.version === "0.0.60", "kept as before");
  box.close();
  signedReleases();
  try {
    // The newest signed is SELF: one that says it runs a newer one has nothing new kept.
    box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.56", "x-bops-build": "Build56" });
    await pause(300);
    box.close();
    assert.deepEqual(await seen(), { version: "0.0.60", build_id: "Build60", auth: "identity" });
    // At the newest, or below it: kept.
    box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": SELF, "x-bops-build": "Build55" });
    await until(async () => (await seen())?.version === SELF, "at the newest");
    box.close();
    box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.53" });
    await until(async () => (await seen())?.version === "0.0.53", "below it");
    box.close();
    assert.deepEqual(await seen(), { version: "0.0.53", build_id: null, auth: "identity" });
  } finally {
    forgetReleases();
  }
  // The owner's Mac is at 0.0.36 here: no record of it was written whatever it said.
  assert.equal(await recordOf(s.owner, s.desktop), undefined);
});

test("a runner of a signed release that connects with no record: Bops Cloud writes one by cloud, shared where its workspace has members, once; an unsigned build, a computer no bot works on, or an owner whose Mac is older gets nothing", async () => {
  await inSelf(async () => {
    const s = await setupSelf();
    const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": SELF, "x-bops-build": "Build55" });
    const rec = await until(async () => await recordOf(s.owner, s.desktop), "its record written");
    // Under the bot's computer id as the state has it (the runner looks it up so).
    assert.deepEqual(rec, { key: s.desktop.toUpperCase(), status: "running", version: SELF, buildId: "Build55", auth: "identity", by: "cloud", at: rec.at, shared: true });
    assert.ok(Math.abs((rec.at as number) - Date.now()) < 10_000);
    box.close();
    // The same again changes nothing, and writes nothing.
    const v = await stateVersion(s.owner);
    const again = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": SELF, "x-bops-build": "Build55" });
    await pause(300);
    again.close();
    assert.equal(await stateVersion(s.owner), v, "written only on a change");
    // An unsigned build of a signed version, a version none signed, or a computer no bot of theirs works on: nothing.
    const t = await setupSelf();
    assert.equal(await recordRunner(t.owner, t.desktop, { version: SELF, buildId: "Unsigned", auth: "identity" }), false);
    assert.equal(await recordRunner(t.owner, t.desktop, { version: "0.0.53", buildId: "Build53", auth: "identity" }), false);
    assert.equal(await recordRunner(t.owner, randomUUID(), { version: SELF, buildId: "Build55", auth: "identity" }), false);
    assert.equal(await recordOf(t.owner, t.desktop), undefined);
    // A bot of a workspace with no members on a computer of its own: no `shared`; on its key, said so.
    const d2 = randomUUID();
    await stateChanges(t.owner, (st) => void st.bots.push({ id: "nova", name: "Nova", workspaceId: "ws_main", computer: "own", computerId: d2 }));
    assert.equal(await recordRunner(t.owner, d2, { version: SELF, buildId: "Build55", auth: "key" }), true);
    const mine = (await recordOf(t.owner, d2))!;
    assert.deepEqual(mine, { key: d2, status: "running", version: SELF, buildId: "Build55", auth: "key", by: "cloud", at: mine.at });
  });
  // An owner whose last Mac is older than CLOUD_SELF_MIN_VERSION: exactly as today, nothing written.
  await inSelf(async () => {
    const old = await setupSelf("0.0.54");
    const box = await stream("/v1/runner/live", vm(old.owner, old.desktop), "hello", { "x-bops-version": SELF, "x-bops-build": "Build55" });
    await until(async () => (await seenOf(old.owner)).length === 1, "its word kept, as today");
    await pause(200);
    box.close();
    assert.equal(await recordOf(old.owner, old.desktop), undefined);
    assert.equal(await recordRunner(old.owner, old.desktop, { version: SELF, buildId: "Build55", auth: "identity" }), false);
    assert.equal(await recordOf(old.owner, old.desktop), undefined);
  }, "0.0.54");
});

test("a record there already: an older running one caught up (who set it up, its key and shared kept, upgrading dropped once reached), the same version's other build only when Bops Cloud wrote it, a failed one from before the connect running again; being set up, being stopped, failed as shared or owner only, failed since, or newer, left as they are", async () => {
  await inSelf(async () => {
    const s = await setupSelf();
    const D = s.desktop.toUpperCase();
    const put = (rec: Record<string, unknown>) => stateChanges(s.owner, (st) => void (st.runners = { [D]: rec }));
    const said = { version: SELF, buildId: "Build55", auth: "identity" as const };
    const at = () => Date.now() - 60_000;
    const base = { status: "running", version: "0.0.54", buildId: "Build54", by: "mac-o", at: at(), keyMade: true, keyId: "key_1", shared: true, auth: "key" };
    /** A record as kept, without the key it's under. */
    const without = (r: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => k !== "key"));
    // Older, being upgraded to this one by the Mac: caught up, its upgrade done.
    await put({ ...base, upgrading: { version: SELF, buildId: "Build55", by: "mac-o", at: at() } });
    assert.equal(await recordRunner(s.owner, s.desktop, said), true);
    let r = (await recordOf(s.owner, s.desktop))!;
    assert.deepEqual(r, { key: D, ...base, version: SELF, buildId: "Build55", auth: "identity", at: r.at });
    assert.ok((r.at as number) > base.at);
    // Being upgraded to a newer one still: caught up, the upgrade kept.
    await put({ ...base, upgrading: { version: "0.0.56", buildId: "Build56", by: "mac-o", at: at() } });
    assert.equal(await recordRunner(s.owner, s.desktop, said), true);
    r = (await recordOf(s.owner, s.desktop))!;
    assert.deepEqual([r.version, r.buildId, (r.upgrading as { version: string }).version, r.by], [SELF, "Build55", "0.0.56", "mac-o"]);
    // The same version, another build: the Mac's own stays (its installPlan keeps it); Bops Cloud's is caught up.
    await put({ ...base, version: SELF, buildId: "Other" });
    assert.equal(await recordRunner(s.owner, s.desktop, said), false);
    assert.equal((await recordOf(s.owner, s.desktop))!.buildId, "Other");
    await put({ ...base, version: SELF, buildId: "Other", by: "cloud" });
    assert.equal(await recordRunner(s.owner, s.desktop, said), true);
    assert.deepEqual(without(await recordOf(s.owner, s.desktop)), { ...base, version: SELF, buildId: "Build55", by: "cloud", auth: "identity", at: (await recordOf(s.owner, s.desktop))!.at });
    // The same version and build, or a newer one: nothing written.
    const v = await stateVersion(s.owner);
    assert.equal(await recordRunner(s.owner, s.desktop, said), false);
    assert.equal(await stateVersion(s.owner), v);
    await put({ ...base, version: "0.0.56", buildId: "Build56" });
    assert.equal(await recordRunner(s.owner, s.desktop, said), false);
    assert.equal((await recordOf(s.owner, s.desktop))!.version, "0.0.56");
    // Failed for another reason before this connect: running again, by cloud, its key kept.
    await put({ status: "failed", version: SELF, buildId: "Build55", by: "mac-o", at: at(), error: "it didn't answer on its computer", keyMade: true, keyId: "key_1" });
    assert.equal(await recordRunner(s.owner, s.desktop, said), true);
    r = (await recordOf(s.owner, s.desktop))!;
    assert.deepEqual(r, { key: D, status: "running", version: SELF, buildId: "Build55", keyMade: true, keyId: "key_1", auth: "identity", by: "cloud", at: r.at, shared: true });
    // Left as they are: failed since the connect, failed as shared or owner only, being set up, being stopped.
    for (const rec of [
      { status: "failed", version: SELF, buildId: "Build55", by: "mac-o", at: Date.now() + 60_000, error: "it didn't answer on its computer" },
      { status: "failed", version: SELF, buildId: "Build55", by: "mac-o", at: at(), error: RUNNER_FULL_ACCESS },
      { status: "failed", version: SELF, buildId: "Build55", by: "mac-o", at: at(), error: RUNNER_OWNER_ONLY },
      { status: "installing", version: SELF, buildId: "Build55", by: "mac-o", at: at() },
      { status: "stopping", version: "0.0.54", buildId: "Build54", by: "mac-o", at: at() },
    ]) {
      await put(rec);
      assert.equal(await recordRunner(s.owner, s.desktop, said), false, `${rec.status} ${"error" in rec ? rec.error : ""}`);
      assert.deepEqual(without(await recordOf(s.owner, s.desktop)), rec);
    }
  });
});

test("an app's job in a cloud workspace goes to a computer whose runner set itself up: with no record it's refused, the runner's connect writes one by cloud, and then the job is owed", async (t) => {
  signedReleases();
  t.after(() => forgetReleases());
  const s = await setupCloudApps({ runner: null, mac: SELF });
  const before = await cact(s.ivy, s.project, "key-self-0001", { act: "deploy", app: "site" });
  assert.deepEqual([before.status, ((await before.json()) as { error: string }).error], [409, "Max's computer is on, but its Bops isn't set up yet. Tara needs to open the updated Bops once."]);
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": SELF, "x-bops-build": "Build55" });
  t.after(() => box.close());
  const rec = await until(async () => await recordOf(s.owner, s.desktop), "its record written");
  assert.deepEqual([rec.status, rec.by, rec.version], ["running", "cloud", SELF]);
  const r = await cact(s.ivy, s.project, "key-self-0002", { act: "deploy", app: "site" });
  assert.equal(r.status, 202, await r.clone().text());
  const a = (await r.json()) as { turn: string };
  await until(() => box.of("turn").some((e) => e.data.id === a.turn), "the job's turn event");
  await runJob(s, a.turn, { ok: true, said: "Deployed site to its Preview." });
});

test("every runner listening hears update once when a new release is out", async () => {
  const a = await setup();
  const b = await setup();
  const one = await stream("/v1/runner/live", vm(a.owner, a.desktop), "hello");
  const two = await stream("/v1/runner/live", vm(b.owner, b.desktop), "hello");
  nudgeUpdates();
  for (const box of [one, two]) await until(() => box.of("update").length === 1, "update heard");
  await pause(100);
  assert.deepEqual([one.of("update"), two.of("update")], [[{ type: "update", data: {} }], [{ type: "update", data: {} }]]);
  one.close();
  two.close();
});

test("while a computer's keeper is live (it asked within 2 hours, the owner's Mac at CLOUD_SELF_MIN_VERSION) a runner too old is said to be updating its Bops and told once to look now; else today's words", async (t) => {
  const s = await setupCloudApps({ runner: "0.0.53", mac: SELF });
  const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.53" });
  t.after(() => box.close());
  const words = async (key: string) => {
    const r = await cact(s.ivy, s.project, key, { act: "deploy", app: "site" });
    const b = (await r.json()) as { code?: string; error?: string };
    return [r.status, b.code, b.error];
  };
  const OLD = [409, "computer_not_ready", "Max's computer runs an older Bops that can't do this yet. It updates the next time Tara opens Bops."];
  const UPDATING = "Max's computer is updating its Bops. Try again in a few minutes.";
  // No keeper, or one that last asked 3 hours ago: today's words, and the runner isn't told.
  assert.deepEqual(await words("key-upd-0001"), OLD);
  await keeperAsked(s.owner, s.desktop, "3 hours");
  assert.equal(await keeperLive(s.owner, s.desktop), false);
  assert.deepEqual(await words("key-upd-0002"), OLD);
  assert.equal(box.of("update").length, 0);
  // Asked a minute ago: updating, and told once.
  await keeperAsked(s.owner, s.desktop);
  assert.equal(await keeperLive(s.owner, s.desktop.toUpperCase()), true, "any case of its id");
  assert.deepEqual(await words("key-upd-0003"), [409, "computer_not_ready", UPDATING]);
  await until(() => box.of("update").length === 1, "told to look now");
  await pause(100);
  assert.equal(box.of("update").length, 1, "once");
  assert.equal((await turnsOf(s.owner)).length, 0, "nothing owed");
  // A job claimed by a runner too old for it: 410 with those words, its note says so, and the runner is told again.
  const admin = { userId: s.admin, email: `${s.admin}@example.com`, name: "Ann", ref: "key-upd-0004", projectId: s.project, role: "admin" as const };
  const id = await oweJob(s, "turn_upd_job", admin, { act: "deploy", app: "site" });
  const c = await runnerOn(s.owner, s.desktop, "0.0.53", `/v1/runner/turns/${id}/claim`, {});
  assert.deepEqual([c.status, await c.json()], [410, { error: UPDATING, code: "over" }]);
  assert.deepEqual([(await turnById(s.owner, id))?.state, (await turnById(s.owner, id))?.note], ["failed", "updating"]);
  await until(() => box.of("update").length === 2, "told again");
  // A GitHub job a runner from before took and answered nothing to: Your Apps says it's updating (not JOB_OLD_RUNNER), and it's told.
  const gh = await takeAppJob({ account: s.owner, wsId: "ws_acme", job: { act: "githubLink", app: "site" }, id: "msg_job_upd_gh", member: { ...admin, ref: "key-upd-0005" }, words: (bot) => `Ann asked ${bot}'s computer to link site.`, check: () => {}, min: GITHUB_ACTS_MIN_VERSION, needsKey: true, cloud: true });
  assert.equal(gh.where, "computer");
  const ghId = gh.where === "computer" ? gh.turn.id : "";
  assert.equal((await runnerOn(s.owner, s.desktop, null, `/v1/runner/turns/${ghId}/claim`, {})).status, 200);
  assert.equal((await runnerOn(s.owner, s.desktop, null, `/v1/runner/turns/${ghId}/done`, { state: "done" })).status, 200);
  assert.deepEqual((await appActs(s.owner)).filter((x) => x.key === "key-upd-0005").map((x) => [x.ok, x.said]), [[false, JOB_UPDATING]]);
  await until(() => box.of("update").length === 3, "told once more");
  // The owner's last Mac older: today's words, keeper or not, and nobody told.
  await macSaid(s.owner, "0.0.54");
  assert.equal(await keeperLive(s.owner, s.desktop), false);
  assert.deepEqual(await words("key-upd-0006"), OLD);
  await pause(100);
  assert.equal(box.of("update").length, 3);
});

test("a group's message to a runner too old while its keeper is live: the chat and the workspace say it's updating its Bops, it's told once, and a new enough runner clears it", async () => {
  await inSelf(async () => {
    const s = await setupSelf();
    await stateChanges(s.owner, (st) => void (st.runners = { [s.desktop]: { status: "running", version: "0.0.53", buildId: "b1", by: "mac-o", at: Date.now(), auth: "identity" } }));
    await keeperAsked(s.owner, s.desktop);
    const box = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": "0.0.53" });
    const a = (await (await act(s.writer, s.project, "key-self-grp01", { act: "chat", chatId: "team", text: "x" })).json()) as { turn?: string; messageId: string };
    assert.equal(a.turn, undefined);
    assert.equal(await noteOf(s.owner, `${a.messageId}_note`), "Max's computer is updating its Bops. Send it again in a few minutes.");
    const trouble = await until(async () => (await acmeOf(s.owner)).chatTrouble, "the workspace says so");
    assert.deepEqual([trouble.note, trouble.botId], ["updating", "max"]);
    await until(() => box.of("update").length === 1, "told to look now");
    box.close();
    // Updated: it connects at SELF, its record is caught up, and the workspace's trouble goes.
    const fresh = await stream("/v1/runner/live", vm(s.owner, s.desktop), "hello", { "x-bops-version": SELF, "x-bops-build": "Build55" });
    await until(async () => (await acmeOf(s.owner)).chatTrouble === undefined, "cleared by the updated runner");
    const rec = (await recordOf(s.owner, s.desktop))!;
    assert.deepEqual([rec.version, rec.buildId, rec.by], [SELF, "Build55", "mac-o"]);
    fresh.close();
  });
});

test("a computer orgo-web says is running whose runner never connects: setting up its Bops while its keeper is live, shared with the team where its runner couldn't be set up for that, and today's note for an owner whose Mac is older", async () => {
  const ended = async (s: { owner: string; writer: string; project: string; desktop: string }, key: string) => {
    wakeAnswers.set(s.desktop, () => ({ state: "running" }));
    const a = (await (await act(s.writer, s.project, key, { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string; messageId: string };
    await until(async () => (await turnById(s.owner, a.turn))?.state === "failed", "ended", 15_000);
    return { note: (await turnById(s.owner, a.turn))?.note, words: await noteOf(s.owner, `${a.messageId}_note`) };
  };
  await inSelf(async () => {
    const s = await setupSelf();
    await keeperAsked(s.owner, s.desktop);
    assert.deepEqual(await ended(s, "key-self-set01"), { note: "settingUp", words: "Max's computer is setting up its Bops, so Max can't answer yet. Send it again in a few minutes." });
    assert.equal((await until(async () => (await acmeOf(s.owner)).chatTrouble, "said on the workspace")).note, "settingUp");
    // Its runner couldn't be set up there: someone else can use it (keeper or not).
    const sh = await setupSelf();
    await stateChanges(sh.owner, (st) => void (st.runners = { [sh.desktop.toUpperCase()]: { status: "failed", version: SELF, buildId: "Build55", by: "mac-o", at: Date.now(), error: RUNNER_FULL_ACCESS, shared: true } }));
    assert.deepEqual(await ended(sh, "key-self-shr01"), { note: "sharedOff", words: "Max's computer is shared with the team, and Orgo doesn't let Bops run on it yet, so Max can't answer in the cloud." });
    assert.equal((await until(async () => (await acmeOf(sh.owner)).chatTrouble, "said on the workspace")).note, "sharedOff");
  });
  await inSelf(async () => {
    const o = await setupSelf("0.0.54");
    await keeperAsked(o.owner, o.desktop);
    await stateChanges(o.owner, (st) => void (st.runners = { [o.desktop.toUpperCase()]: { status: "failed", version: SELF, buildId: "Build55", by: "mac-o", at: Date.now(), error: RUNNER_FULL_ACCESS } }));
    assert.deepEqual(await ended(o, "key-self-old01"), { note: "noRunner", words: "Max's computer is on, but it can't answer chats yet. Tara needs to open the updated Bops once to set it up." });
  }, "0.0.54");
});
