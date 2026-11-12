import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { clearAuthCache } from "../auth.ts";
import { closeDb, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { closeAll } from "../live.ts";
import { resetMembers } from "../members.ts";
import { GITHUB_ACTS_MIN_VERSION, GITHUB_KEY_LINE, type MemberActPayload, type SharedWsState } from "../protocol.ts";
import { howIWork } from "../style.ts";
import { closeRunners, JOB_OLD_RUNNER, resetTurns, sweepTurns, turnById, turnTiming } from "../turns.ts";
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

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const readAll = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

/** orgo-web, faked: profiles (`key-<user>`; `orgo_vm_<user>~<desktop>` a computer's identity), bops-role from `roles`, and the signed wake. */
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
const own = (userId: string, device = "mac-o", version = "0.0.36") => ({
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
/** An SSE stream's events as they come (`first`: the event that says it's open). */
async function stream(path: string, key: string, first: string) {
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
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

test("a bot on the owner's Mac: Bops Cloud writes the message, the Mac is handed it to answer, and the chat says so while the Mac is away", async () => {
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
