import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { clearAuthCache } from "../auth.ts";
import { closeDb, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { closeAll } from "../live.ts";
import { resetMembers } from "../members.ts";
import { closeRunners, resetTurns, sweepTurns, turnById, turnTiming } from "../turns.ts";
import { dropUsers, keyOf, listen, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

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
      const project = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(req.url ?? "")?.[1];
      let m: RegExpExecArray | null;
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
