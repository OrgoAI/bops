import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { closeAll } from "../live.ts";
import { resetMembers } from "../members.ts";
import { autoRoute, closeRunners, resetTurns, revertAuto, sweepTurns, turnTiming } from "../turns.ts";
import { dropUsers, keyOf, listen, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * Chat through Bops Cloud by default (cloud/turns.ts autoRoute): a workspace nobody chose for moves to Bops Cloud by
 * itself once the owner's Mac set up a runner on its bots' computer, saw it running, and that runner connected; back
 * to the Mac when its runner is taken down or fails, or its computer can't answer a turn; never a choice the owner or
 * staff made, either way, even when they race. The owner's Bops reads the switch on its state at once. Members'
 * messages in a workspace that may move are written by Bops Cloud first, so no move ever drops one. orgo-web is a
 * fake on localhost.
 */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const PLAN_SECRET = "edge-auto-plan-secret-0123456789abcdef"; // gitleaks:allow (made up for this test)
const WAKE_SECRET = "edge-auto-wake-secret-0123456789abcdef"; // gitleaks:allow (made up for this test)
const roles: Record<string, unknown> = {};
/** What the fake orgo-web answers a wake with, by desktop (default: running). */
const wakeAnswers = new Map<string, () => Record<string, unknown>>();

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const readAll = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

async function fakeOrgo(): Promise<Listening> {
  return listen(
    createServer(async (req, res) => {
      const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const body = await readAll(req);
      if (req.url === "/api/internal/bops/wake") {
        const b = JSON.parse(body.toString()) as { desktopId: string };
        return json(res, 200, { desktopId: b.desktopId, ...(wakeAnswers.get(b.desktopId) ?? (() => ({ state: "running" })))() });
      }
      const project = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(req.url ?? "")?.[1];
      let m: RegExpExecArray | null;
      if (project && (m = /^key-(.+)$/.exec(key))) return roles[`${m[1]} ${project}`] ? json(res, 200, roles[`${m[1]} ${project}`]) : json(res, 404, {});
      if (req.url !== "/api/user/profile") return json(res, 404, {});
      if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com` });
      if ((m = /^orgo_vm_([^~]+)~([^~]+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: null, principal: { kind: "vm_identity", desktop_id: m[2], expires_at: new Date(Date.now() + 3600_000).toISOString() } });
      json(res, 401, { error: "no" });
    }),
  );
}

before(async () => {
  process.env.BOPS_CLOUD_PLAN_SECRET = PLAN_SECRET;
  process.env.BOPS_CLOUD_WAKE_SECRET = WAKE_SECRET;
  process.env.BOPS_CHAT_AUTO = "on";
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
const own = (userId: string, version = "0.0.38", device = "mac-o") => ({
  Authorization: `Bearer ${keyOf(userId)}`,
  "x-bops-user": userId,
  "x-bops-protocol": "2",
  "x-bops-device": device,
  "x-bops-version": version,
  "content-type": "application/json",
});
const vm = (userId: string, desktop: string) => `orgo_vm_${userId}~${desktop}`;
const runnerState = (version = "0.0.37", more: Record<string, unknown> = {}) => ({ status: "running", version, buildId: "b1", by: "mac-o", at: 1, auth: "identity", ...more });

type Ws = { id: string; chatOn?: string; chatAuto?: boolean };
type State = { workspaces: Ws[]; runners?: Record<string, unknown>; bots: Record<string, unknown>[] };

/** An owner with Acme: Max on its own computer (the Mac set up its runner unless `runner` is false), a member at Write with Use its computer. */
async function setup(opts: { runner?: boolean } = {}) {
  const owner = user("owner");
  const writer = user("writer");
  const project = randomUUID();
  const desktop = randomUUID();
  roles[`${writer} ${project}`] = { role: "member", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  const state = {
    owner: { name: "Tara" },
    workspaces: [
      { id: "ws_main", name: "Main" },
      { id: "ws_acme", name: "Acme", memberAccess: { [`${writer}@example.com`]: { others: "none", bots: { max: "write" }, computer: "use" } } },
    ],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true },
      { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: desktop.toUpperCase() },
    ],
    chats: [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" }],
    ...(opts.runner !== false ? { runners: { [desktop]: runnerState() } } : {}),
  };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: own(owner), body: JSON.stringify({ base: 0, state }) })).status, 200);
  // The account as Bops Cloud made it at the Mac's first session, with the version that Mac said (one with the switch).
  await query("INSERT INTO bops.cloud_accounts (user_id, app_version) VALUES ($1, '0.0.38') ON CONFLICT (user_id) DO UPDATE SET app_version = '0.0.38'", [owner]);
  return { owner, writer, project, desktop };
}

/** A runner's stream, as a runner of `version` opens it (none: one from before that says nothing). */
async function listenAs(owner: string, desktop: string, version: string | null = "0.0.37") {
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}/v1/runner/live`, {
    headers: { Authorization: `Bearer ${vm(owner, desktop)}`, "x-bops-user": owner, "x-bops-protocol": "2", ...(version ? { "x-bops-version": version } : {}) },
    signal: ctl.signal,
  });
  assert.equal(res.status, 200);
  const got: string[] = [];
  void (async () => {
    try {
      for await (const chunk of res.body!) got.push(new TextDecoder().decode(chunk as Uint8Array));
    } catch {}
  })();
  await until(() => got.join("").includes("event: hello"), "the runner's stream to open");
  return { got, close: () => ctl.abort() };
}

const rowOf = async (owner: string, ws = "ws_acme") =>
  (await query<{ mode: string; set_by: string | null; allow_hourly: boolean }>("SELECT mode, set_by, allow_hourly FROM bops.chat_routing WHERE user_id = $1 AND ws_id = $2", [owner, ws])).rows[0];
const stateOf = async (owner: string) => (await (await fetch(`${cloud.url}/v1/state`, { headers: own(owner) })).json()) as { version: number; state: State };
const acmeOf = async (owner: string) => (await stateOf(owner)).state.workspaces.find((w) => w.id === "ws_acme")!;
/** The owner's state changed by `change`, written back as their Mac does. Returns the version it was answered with. */
async function ownerChanges(owner: string, change: (st: State) => void, headers = own(owner)): Promise<number> {
  const head = await stateOf(owner);
  change(head.state);
  const r = await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers, body: JSON.stringify({ base: head.version, state: head.state }) });
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { version: number }).version;
}
const routeAs = (owner: string, body: Record<string, unknown>, headers = own(owner)) => fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers, body: JSON.stringify({ wsId: "ws_acme", ...body }) });
function staff(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${cloud.url}/v1/internal/chat-routing`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": `sha256=${createHmac("sha256", PLAN_SECRET).update(`${ts}.${raw}`).digest("hex")}` },
    body: raw,
  });
}
const act = (member: string, project: string, key: string, a: Record<string, unknown>) =>
  fetch(`${cloud.url}/v1/ws/${project}/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(member)}`, "content-type": "application/json" }, body: JSON.stringify({ key, act: a }) });
const pendingOf = async (owner: string) => (await query<{ payload: { stored?: boolean; messageId?: string } }>("SELECT payload FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'member'", [owner])).rows.map((r) => r.payload);
const cloudNow = async (owner: string) => (await rowOf(owner))?.mode === "cloud";

test("a workspace moves to Bops Cloud by itself once the runner the Mac set up connects: a turn is owed for a member's message, and the Mac reads the switch", async () => {
  const s = await setup();
  // Nobody chose, and its runner hasn't connected yet: still the Mac's, and the state says it may move.
  assert.equal(await rowOf(s.owner), undefined);
  assert.deepEqual([(await acmeOf(s.owner)).chatOn, (await acmeOf(s.owner)).chatAuto], [undefined, true]);
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved to Bops Cloud");
  assert.deepEqual(await rowOf(s.owner), { mode: "cloud", set_by: "auto", allow_hourly: false });
  assert.deepEqual([(await acmeOf(s.owner)).chatOn, (await acmeOf(s.owner)).chatAuto], ["cloud", true]);
  // A member's message now: written by Bops Cloud, its answer owed to the computer, nothing for the Mac.
  const a = (await (await act(s.writer, s.project, "key-auto-00001", { act: "chat", chatId: "bot:max", text: "hi" })).json()) as { turn?: string };
  assert.ok(a.turn);
  assert.deepEqual(await pendingOf(s.owner), []);
  box.close();
});

test("a runner that connects before the Mac marks it running: the Mac's write that does moves it; one from before chat through Bops Cloud never does", async () => {
  const s = await setup({ runner: false });
  const box = await listenAs(s.owner, s.desktop);
  await autoRoute(s.owner);
  assert.equal(await rowOf(s.owner), undefined, "no runner the Mac saw running");
  await ownerChanges(s.owner, (st) => void (st.runners = { [s.desktop]: runnerState() }));
  await until(() => cloudNow(s.owner), "moved on the Mac's write");
  box.close();

  const old = await setup({ runner: false });
  const quiet = await listenAs(old.owner, old.desktop, null);
  await ownerChanges(old.owner, (st) => void (st.runners = { [old.desktop]: runnerState("0.0.35") }));
  await autoRoute(old.owner);
  assert.equal(await rowOf(old.owner), undefined, "a runner before 0.0.36 never moves it");
  quiet.close();
});

test("the owner's or staff's choice stands: never moved by itself, either way, and the Mac's save that drops it has it put back", async () => {
  const s = await setup();
  assert.equal((await routeAs(s.owner, { mode: "mac" })).status, 200);
  assert.deepEqual([(await acmeOf(s.owner)).chatOn, (await acmeOf(s.owner)).chatAuto], ["mac", undefined]);
  const box = await listenAs(s.owner, s.desktop);
  await autoRoute(s.owner);
  assert.deepEqual(await rowOf(s.owner), { mode: "mac", set_by: "owner", allow_hourly: false });
  await ownerChanges(s.owner, (st) => delete st.workspaces.find((w) => w.id === "ws_acme")!.chatOn, own(s.owner, "0.0.36", "mac-old"));
  assert.equal((await acmeOf(s.owner)).chatOn, "mac");
  box.close();

  // Staff's cloud with its runner taken down: stays (as before this change).
  const t = await setup();
  assert.equal((await staff({ userId: t.owner, wsId: "ws_acme", mode: "cloud" })).status, 200);
  await ownerChanges(t.owner, (st) => delete st.runners);
  await autoRoute(t.owner);
  assert.deepEqual(await rowOf(t.owner), { mode: "cloud", set_by: "staff", allow_hourly: false });
});

test("the owner's switch back on gives the choice back: Bops Cloud moves it once its runner answers", async () => {
  const s = await setup();
  assert.equal((await routeAs(s.owner, { mode: "mac" })).status, 200);
  const box = await listenAs(s.owner, s.desktop);
  assert.equal((await routeAs(s.owner, { mode: "auto" })).status, 200);
  await until(() => cloudNow(s.owner), "moved once the choice was given back");
  assert.equal((await rowOf(s.owner))?.set_by, "auto");
  box.close();
});

test("where Bops Cloud doesn't move workspaces for the owner yet, the switch back on is refused and the Mac's stays the choice", async () => {
  const s = await setup({ runner: false });
  assert.equal((await routeAs(s.owner, { mode: "mac" })).status, 200);
  delete process.env.BOPS_CHAT_AUTO;
  try {
    const r = await routeAs(s.owner, { mode: "auto" });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { code?: string }).code, "chat_auto_off");
    assert.deepEqual(await rowOf(s.owner), { mode: "mac", set_by: "owner", allow_hourly: false });
    assert.equal((await staff({ userId: s.owner, wsId: "ws_acme", mode: "auto" })).status, 409);
    // No row at all: none made.
    const t = await setup({ runner: false });
    assert.equal((await routeAs(t.owner, { mode: "auto" })).status, 409);
    assert.equal(await rowOf(t.owner), undefined);
  } finally {
    process.env.BOPS_CHAT_AUTO = "on";
  }
});

test("taken down or failed on the Mac's write, it goes back to the Mac; back up and connected, to Bops Cloud again", async () => {
  const s = await setup();
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  await ownerChanges(s.owner, (st) => void (st.runners = { [s.desktop]: runnerState("0.0.37", { status: "failed", error: "it stopped on its computer" }) }));
  await until(async () => !(await cloudNow(s.owner)), "back to the Mac");
  assert.deepEqual(await rowOf(s.owner), { mode: "mac", set_by: "auto", allow_hourly: false });
  assert.deepEqual([(await acmeOf(s.owner)).chatOn, (await acmeOf(s.owner)).chatAuto], [undefined, true]);
  // Set up again: the Mac marks it running, and its runner (still connected) answers.
  await ownerChanges(s.owner, (st) => void (st.runners = { [s.desktop]: runnerState() }));
  await until(() => cloudNow(s.owner), "to Bops Cloud again");
  await ownerChanges(s.owner, (st) => delete st.runners);
  await until(async () => !(await cloudNow(s.owner)), "back with no runner");
  box.close();
});

test("a computer that's on with no runner coming goes back to the Mac after its turns end, and to Bops Cloud again once its runner connects", async () => {
  const s = await setup();
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  box.close();
  await until(async () => (await query("SELECT 1 FROM bops.runner_presence WHERE user_id = $1", [s.owner])).rowCount === 0, "the runner gone");
  // It naps: nothing moves.
  await autoRoute(s.owner);
  assert.equal(await cloudNow(s.owner), true);
  wakeAnswers.set(s.desktop, () => ({ state: "running" }));
  const a = (await (await act(s.writer, s.project, "key-auto-nr001", { act: "chat", chatId: "bot:max", text: "x" })).json()) as { turn: string };
  await until(async () => (await query<{ note: string }>("SELECT note FROM bops.chat_turns WHERE user_id = $1 AND id = $2", [s.owner, a.turn])).rows[0]?.note === "noRunner", "the turn ended", 15_000);
  await until(async () => !(await cloudNow(s.owner)), "back to the Mac");
  // The next message is written first and handed to the Mac to answer: nothing is lost.
  const b = (await (await act(s.writer, s.project, "key-auto-nr002", { act: "chat", chatId: "bot:max", text: "y" })).json()) as { turn?: string; messageId: string; stored: boolean };
  assert.deepEqual([b.turn, b.stored], [undefined, true]);
  assert.ok((await pendingOf(s.owner)).some((p) => p.stored && p.messageId === b.messageId));
  const again = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "to Bops Cloud again once it connects");
  again.close();
  wakeAnswers.delete(s.desktop);
});

test("a computer that can't be woken (billed by the hour) goes back to the Mac and stays there a while, even when its runner connects", async () => {
  const s = await setup();
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  box.close();
  await until(async () => (await query("SELECT 1 FROM bops.runner_presence WHERE user_id = $1", [s.owner])).rowCount === 0, "the runner gone");
  wakeAnswers.set(s.desktop, () => ({ state: "hourly" }));
  await act(s.writer, s.project, "key-auto-hr001", { act: "chat", chatId: "bot:max", text: "x" });
  await until(async () => (await rowOf(s.owner))?.set_by === "auto-held", "held on the Mac");
  assert.equal((await rowOf(s.owner))?.mode, "mac");
  const again = await listenAs(s.owner, s.desktop);
  await autoRoute(s.owner);
  assert.equal(await cloudNow(s.owner), false);
  again.close();
  wakeAnswers.delete(s.desktop);
});

test("a restart of Bops Cloud leaves a moved workspace as it is, and its runner connecting again proves it once more", async () => {
  const s = await setup();
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  box.close();
  closeRunners();
  resetTurns();
  await autoRoute(s.owner);
  assert.equal(await cloudNow(s.owner), true);
  // Its runner fails and is set up again: not to Bops Cloud until it connects since the start.
  await ownerChanges(s.owner, (st) => void (st.runners = { [s.desktop]: runnerState("0.0.37", { status: "failed" }) }));
  await until(async () => !(await cloudNow(s.owner)), "back to the Mac");
  await ownerChanges(s.owner, (st) => void (st.runners = { [s.desktop]: runnerState() }));
  await autoRoute(s.owner);
  assert.equal(await cloudNow(s.owner), false, "not proved since the start");
  const again = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "to Bops Cloud once it connects");
  again.close();
});

test("an owner whose last Mac is older than chat through Bops Cloud, or outside the canary, isn't moved", async () => {
  const s = await setup();
  // The Mac at 0.0.35 calls (a runner's call never counts: only a Mac's).
  await fetch(`${cloud.url}/v1/state/head`, { headers: own(s.owner, "0.0.35", "mac-old") });
  await until(async () => (await query("SELECT 1 FROM bops.cloud_accounts WHERE user_id = $1 AND app_version = '0.0.35'", [s.owner])).rowCount === 1, "the old Mac's version kept");
  const box = await listenAs(s.owner, s.desktop);
  await autoRoute(s.owner);
  assert.equal(await rowOf(s.owner), undefined);
  assert.equal((await query("SELECT app_version FROM bops.cloud_accounts WHERE user_id = $1", [s.owner])).rows[0].app_version, "0.0.35", "the runner's call didn't say it");
  box.close();

  // A Mac that keeps to chat through Bops Cloud but has no switch (0.0.37): the owner couldn't choose it back, so not moved.
  const w = await setup();
  await ownerChanges(w.owner, () => {}, own(w.owner, "0.0.37", "mac-old"));
  await until(async () => (await query("SELECT 1 FROM bops.cloud_accounts WHERE user_id = $1 AND app_version = '0.0.37'", [w.owner])).rowCount === 1, "the 0.0.37 Mac's version kept");
  const wbox = await listenAs(w.owner, w.desktop);
  await autoRoute(w.owner);
  assert.equal(await rowOf(w.owner), undefined, "a Mac without the switch");
  wbox.close();

  const t = await setup();
  const u = await setup();
  process.env.BOPS_CHAT_AUTO = `${u.owner}`;
  try {
    const one = await listenAs(t.owner, t.desktop);
    const two = await listenAs(u.owner, u.desktop);
    await until(() => cloudNow(u.owner), "the canary's moved");
    await autoRoute(t.owner);
    assert.equal(await rowOf(t.owner), undefined, "not in the canary");
    process.env.BOPS_CHAT_AUTO = "off";
    // Off: nothing more moves there, and what moved goes back as before when it can't answer.
    await ownerChanges(u.owner, (st) => delete st.runners);
    await until(async () => !(await cloudNow(u.owner)), "back with moves off");
    one.close();
    two.close();
  } finally {
    process.env.BOPS_CHAT_AUTO = "on";
  }
});

test("racing: the owner choosing the Mac while a runner connects always ends on the Mac, as the owner's choice", async () => {
  for (let i = 0; i < 20; i++) {
    const s = await setup();
    const [box] = await Promise.all([listenAs(s.owner, s.desktop), routeAs(s.owner, { mode: "mac" })]);
    await autoRoute(s.owner);
    assert.deepEqual(await rowOf(s.owner), { mode: "mac", set_by: "owner", allow_hourly: false }, `round ${i}`);
    assert.equal((await acmeOf(s.owner)).chatOn, "mac");
    box.close();
  }
});

test("saying only whether a message may wake a computer billed by the hour chooses nothing: it still moves, and keeps what the owner said", async () => {
  const s = await setup();
  assert.equal((await routeAs(s.owner, { allowHourly: true })).status, 200);
  assert.deepEqual(await rowOf(s.owner), { mode: "mac", set_by: null, allow_hourly: true });
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  assert.deepEqual(await rowOf(s.owner), { mode: "cloud", set_by: "auto", allow_hourly: true });
  box.close();
});

test("a member's message in a workspace still on the Mac is written first and handed to the Mac, so a move meanwhile never drops it", async () => {
  const s = await setup({ runner: false });
  const a = (await (await act(s.writer, s.project, "key-auto-mac01", { act: "chat", chatId: "bot:max", text: "on the Mac" })).json()) as { turn?: string; messageId: string; stored: boolean };
  assert.deepEqual([a.turn, a.stored], [undefined, true]);
  assert.ok((await pendingOf(s.owner)).some((p) => p.stored && p.messageId === a.messageId));
  // The Mac's away: the chat says the Mac answers it for now.
  const read = async () => ((await (await fetch(`${cloud.url}/v1/messages?after=0`, { headers: own(s.owner) })).json()) as { messages: { id: string; json: { text: string } }[] }).messages;
  const note = await until(async () => (await read()).find((m) => m.id === `${a.messageId}_note`), "the note");
  assert.equal(note.json.text, "Tara's Mac answers Max for now, so Max will answer once Tara opens Bops.");
});

test("the Mac's save without the switch on it gets one more version, Bops Cloud's, so the Mac reads it", async () => {
  const s = await setup();
  const head = await stateOf(s.owner);
  const answered = await ownerChanges(s.owner, (st) => delete st.workspaces.find((w) => w.id === "ws_acme")!.chatAuto);
  const now = await stateOf(s.owner);
  assert.deepEqual([answered, now.version], [head.version + 1, head.version + 2]);
  assert.equal(now.state.workspaces.find((w) => w.id === "ws_acme")?.chatAuto, true);
  // Its next save with the switch as it is: one version, nothing more.
  const next = await ownerChanges(s.owner, (st) => void (st.workspaces[0].chatAuto = true));
  assert.equal((await stateOf(s.owner)).version, next);
});

test("BOPS_CHAT_AUTO=revert sends every workspace Bops Cloud moved back to the Mac, with the switch on the owner's state", async () => {
  const s = await setup();
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  const t = await setup();
  assert.equal((await staff({ userId: t.owner, wsId: "ws_acme", mode: "cloud" })).status, 200);
  process.env.BOPS_CHAT_AUTO = "revert";
  try {
    assert.ok((await revertAuto()) >= 1);
    assert.deepEqual(await rowOf(s.owner), { mode: "mac", set_by: "auto", allow_hourly: false });
    assert.deepEqual([(await acmeOf(s.owner)).chatOn, (await acmeOf(s.owner)).chatAuto], [undefined, undefined]);
    assert.equal((await rowOf(t.owner))?.mode, "cloud", "staff's stays");
    await autoRoute(s.owner);
    assert.equal(await cloudNow(s.owner), false, "and nothing moves there again");
  } finally {
    process.env.BOPS_CHAT_AUTO = "on";
  }
  box.close();
});

const runner = (owner: string, desktop: string, path: string, body?: unknown) =>
  fetch(`${cloud.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${vm(owner, desktop)}`, "x-bops-user": owner, "x-bops-protocol": "2", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const turnOf = async (owner: string, id: string) => (await query<{ state: string; note: string | null }>("SELECT state, note FROM bops.chat_turns WHERE user_id = $1 AND id = $2", [owner, id])).rows[0];
const readAllMessages = async (owner: string) =>
  ((await (await fetch(`${cloud.url}/v1/messages?after=0`, { headers: own(owner) })).json()) as { messages: { id: string; json: { text: string } | null }[] }).messages;

test("a turn that ran out of time behind a longer answer in its chat, its runner listening, never moves the workspace back", async () => {
  const s = await setup();
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  const a = (await (await act(s.writer, s.project, "key-auto-long1", { act: "chat", chatId: "bot:max", text: "a long task" })).json()) as { turn: string };
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${a.turn}/claim`, {})).status, 200);
  const b = (await (await act(s.writer, s.project, "key-auto-long2", { act: "chat", chatId: "bot:max", text: "and then" })).json()) as { turn: string };
  // One at a time in a chat: the second waits behind the first past its deadline.
  assert.equal((await runner(s.owner, s.desktop, `/v1/runner/turns/${b.turn}/claim`, {})).status, 409);
  await query("UPDATE bops.chat_turns SET deadline = now() - interval '1 second' WHERE user_id = $1 AND id = $2", [s.owner, b.turn]);
  await sweepTurns();
  assert.deepEqual(await turnOf(s.owner, b.turn), { state: "expired", note: "late" });
  await autoRoute(s.owner);
  assert.deepEqual(await rowOf(s.owner), { mode: "cloud", set_by: "auto", allow_hourly: false });
  box.close();
});

test("moved back to the Mac while a member's turn waits on its computer: the Mac is handed the message to answer, and the owner's own says to send it again", async () => {
  const s = await setup();
  const box = await listenAs(s.owner, s.desktop);
  await until(() => cloudNow(s.owner), "moved");
  box.close();
  await until(async () => (await query("SELECT 1 FROM bops.runner_presence WHERE user_id = $1", [s.owner])).rowCount === 0, "the runner gone");
  // Its computer takes a while to come back: the turns keep waiting on it.
  wakeAnswers.set(s.desktop, () => ({ state: "storage", expectedSeconds: 30 }));
  try {
    const a = (await (await act(s.writer, s.project, "key-auto-hb001", { act: "chat", chatId: "bot:max", text: "while it wakes" })).json()) as { turn: string; messageId: string };
    const o = await fetch(`${cloud.url}/v1/chats/${encodeURIComponent("bot:max")}/send`, { method: "POST", headers: own(s.owner), body: JSON.stringify({ key: "key-auto-hbown", text: "mine too" }) });
    assert.equal(o.status, 200);
    const mine = ((await o.json()) as { turn: string }).turn;
    await until(async () => (await turnOf(s.owner, a.turn))?.state === "waking", "waking");
    // Its runner fails on the Mac meanwhile: back to the Mac, with what waited.
    await ownerChanges(s.owner, (st) => void (st.runners = { [s.desktop]: runnerState("0.0.37", { status: "failed" }) }));
    await until(async () => !(await cloudNow(s.owner)), "back to the Mac");
    assert.deepEqual(await turnOf(s.owner, a.turn), { state: "expired", note: null });
    assert.deepEqual(await turnOf(s.owner, mine), { state: "failed", note: "toMac" });
    const pending = await pendingOf(s.owner);
    assert.equal(pending.filter((p) => p.stored && p.messageId === a.messageId).length, 1, "the Mac answers the member's message");
    const all = await readAllMessages(s.owner);
    const note = all.find((m) => m.id === `${a.messageId}_note`)?.json?.text;
    assert.equal(note, "Tara's Mac answers Max for now, so Max will answer once Tara opens Bops.");
    assert.equal(all.find((m) => m.id === "msg_o_key-auto-hbown_note")?.json?.text, "Tara's Mac answers Max for now, and Max hadn't started on this yet. Send it again.");
    assert.ok(!all.some((m) => /can't answer chats yet|didn't wake up/.test(m.json?.text ?? "")), "no failure note");
  } finally {
    wakeAnswers.delete(s.desktop);
  }
});
