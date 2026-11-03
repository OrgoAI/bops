import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { WebSocket } from "ws";
import { clearAuthCache } from "../auth.ts";
import { resetBrowser, runnerConnected, viewersOf } from "../browser.ts";
import { closeDb } from "../db.ts";
import { resetMembers } from "../members.ts";
import { BROWSER_NEEDS_COMPUTER, BROWSER_NEEDS_WRITE, type BrowserToRunner, type RunnerToBrowser } from "../protocol.ts";
import { listen, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * The bot's browser in Bops Cloud (browser.ts): who may watch a bot's browser and take control of it. The owner, and a
 * member the owner gave Write on that bot and Use its computer; a member without Use its computer, a member at Read, a
 * member who doesn't see the bot and someone who isn't in the workspace are refused, each saying why (or nothing, for
 * what they don't see), on the stream and on every act. What the runner on the bot's computer sends reaches the viewers
 * it's for, and what they ask reaches the runner with who asked, as Bops Cloud vouches for them. Pointer events and what
 * the bot is doing reach viewers; a stream of only the latter (a Watch chip's) isn't watching. The owner's take goes
 * over a member's control; a member's never does. orgo-web is a fake.
 */

let orgo: Listening;
let cloud: Listening;
const owner = newUserId("owner");
const writer = newUserId("writer");
const noComputer = newUserId("no-computer");
const reader = newUserId("reader");
const hidden = newUserId("hidden");
const outsider = newUserId("outsider");
const admin = newUserId("admin");
const PROJECT = "22222222-3333-4444-5555-666666666666";
const DESKTOP = "0f0e0d0c-0b0a-4908-8706-050403020100";
const keyOf = (id: string) => `key-${id}`;
const COMPUTER_KEY = `computer-${owner}`;

before(async () => {
  await prepareDb();
  // orgo-web: who each key is (the computer's key is that computer's, of the owner's account), and their role in the workspace.
  const member = (computerUse: boolean) => ({ role: "member", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme", computerUse });
  const roles: Record<string, unknown> = {
    [owner]: { role: "owner", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" },
    [writer]: member(true),
    [noComputer]: member(false),
    [reader]: member(true),
    [hidden]: member(true),
    // An Admin (Orgo's role): no entry of their own in the owner's state, every bot and its computer all the same.
    [admin]: { role: "admin", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" },
  };
  orgo = await listen(
    createServer((req, res) => {
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      if (req.url === "/api/user/profile") {
        if (key === COMPUTER_KEY) return json(200, { id: owner, api_key: { scope: "computer", computer_id: DESKTOP } });
        const id = /^key-(.+)$/.exec(key)?.[1];
        return id ? json(200, { id, email: `${id}@example.com`, full_name: id.split("-")[1] }) : json(401, { error: "no" });
      }
      const project = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(req.url ?? "")?.[1];
      const id = /^key-(.+)$/.exec(key)?.[1];
      if (project === PROJECT && id && roles[id]) return json(200, roles[id]);
      json(404, { error: "Not found" });
    }),
  );
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  cloud = await startCloud();
});

const at = Date.now();
const state = {
  workspaces: [
    {
      id: "ws_acme",
      name: "Acme",
      memberAccess: {
        [`${writer}@example.com`]: { others: "none", bots: { max: "write" }, computer: "use", at },
        [`${noComputer}@example.com`]: { others: "none", bots: { max: "write" }, at },
        [`${reader}@example.com`]: { others: "none", bots: { max: "read" }, computer: "use", at },
        [`${hidden}@example.com`]: { others: "none", bots: { dana: "write" }, computer: "use", at },
      },
    },
  ],
  bots: [
    { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: DESKTOP, computerStatus: "ready" },
    { id: "dana", name: "Dana", workspaceId: "ws_acme" },
  ],
};

beforeEach(() => {
  clearAuthCache();
  resetMembers({ state: async () => state });
  resetBrowser({ state: async (account) => (account === owner ? state : {}) });
});

after(async () => {
  resetBrowser();
  await cloud.close();
  await orgo.close();
  await closeDb();
});

/** A viewer's stream: its status, and (open) the events as they come, until closed. */
async function watch(userId: string, project: string | null = PROJECT, bot = "max", only = "") {
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}/v1/browser/watch?bot=${bot}${project ? `&project=${project}` : ""}${only ? `&only=${only}` : ""}`, { headers: { Authorization: `Bearer ${keyOf(userId)}` }, signal: ctl.signal });
  const events: { t: string; [k: string]: unknown }[] = [];
  if (!res.ok) return { status: res.status, body: (await res.json()) as { error: string; code?: string }, events, close: () => ctl.abort() };
  void (async () => {
    let buf = "";
    try {
      for await (const chunk of res.body!) {
        buf += Buffer.from(chunk).toString();
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const data = /^data: (.*)$/m.exec(buf.slice(0, i))?.[1];
          buf = buf.slice(i + 2);
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch {}
  })();
  return { status: res.status, body: null, events, close: () => ctl.abort() };
}

const act = (userId: string, body: Record<string, unknown>) =>
  fetch(`${cloud.url}/v1/browser/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(userId)}`, "content-type": "application/json" }, body: JSON.stringify({ project: PROJECT, bot: "max", ...body }) }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as { error?: string; code?: string },
  }));

/** The runner on the bot's computer, signed in as that computer. */
async function runner() {
  const got: BrowserToRunner[] = [];
  const ws = new WebSocket(`${cloud.url.replace("http", "ws")}/v1/browser/runner`, { headers: { Authorization: `Bearer ${COMPUTER_KEY}` } });
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise((ok, no) => (ws.once("open", ok), ws.once("error", no)));
  await until(() => runnerConnected(owner, DESKTOP), "the runner to be connected");
  return { got, send: (m: RunnerToBrowser) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

test("the owner and a member with Write and Use its computer watch the bot's browser, and see what its runner sends", async () => {
  const r = await runner();
  const mine = await watch(owner, null);
  const theirs = await watch(writer);
  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);
  await until(() => theirs.events.find((e) => e.t === "computer"), "the stream to say the computer is there");
  assert.deepEqual(theirs.events[0], { t: "computer", connected: true });
  // The runner hears who watches, by their Orgo id and name.
  const w = await until(() => r.got.findLast((m) => m.t === "watch" && m.viewers.length === 2), "the runner to hear both");
  assert.deepEqual(w.t === "watch" && w.viewers.map((v) => v.id).sort(), [owner, writer].sort());
  r.send({ t: "page", bots: ["max"], url: "https://example.com/", title: "Example", back: null });
  r.send({ t: "frame", bots: ["max"], data: "AAAA", meta: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } });
  r.send({ t: "control", bots: ["max"], by: { id: writer, name: "writer" } });
  await until(() => theirs.events.some((e) => e.t === "control") && mine.events.some((e) => e.t === "control"), "control to reach both");
  assert.deepEqual(theirs.events.find((e) => e.t === "page"), { t: "page", url: "https://example.com/", title: "Example", back: null });
  assert.equal(theirs.events.find((e) => e.t === "frame")?.data, "AAAA");
  assert.equal(theirs.events.find((e) => e.t === "control")?.you, true, "the member is told it's them");
  assert.equal(mine.events.find((e) => e.t === "control")?.you, false, "the owner is told it's someone else");
  // A refusal goes only to whoever it's for.
  r.send({ t: "refused", bots: ["max"], to: writer, why: "Take over first." });
  await until(() => theirs.events.some((e) => e.t === "refused"), "the refusal");
  assert.ok(!mine.events.some((e) => e.t === "refused"));
  mine.close();
  theirs.close();
  await until(() => viewersOf(owner, "max") === 0, "both streams to end");
  const left = await until(() => r.got.findLast((m) => m.t === "watch"), "the runner to hear they left");
  assert.deepEqual(left.t === "watch" && left.viewers, [], "nobody watches: the runner stops capturing");
  r.close();
});

test("a member without Use its computer, a member at Read, one who doesn't see the bot and an outsider are refused, saying why", async () => {
  const no = await watch(noComputer);
  assert.equal(no.status, 403);
  assert.equal(no.body?.code, BROWSER_NEEDS_COMPUTER);
  assert.match(no.body!.error, /takes Use its computer, which the owner hasn't turned on for you/);
  const read = await watch(reader);
  assert.equal(read.status, 403);
  assert.equal(read.body?.code, BROWSER_NEEDS_WRITE);
  assert.match(read.body!.error, /takes Write on Max, and the owner gave you Read/);
  const notTheirs = await watch(hidden);
  assert.equal(notTheirs.status, 404, "a bot they don't see is no bot at all");
  const out = await watch(outsider);
  assert.equal(out.status, 404, "not in the workspace: no such workspace");
  // Nor their own account's bot of that id: someone else's computer isn't theirs to watch.
  const own = await watch(outsider, null);
  assert.equal(own.status, 404);
  assert.equal(viewersOf(owner, "max"), 0);
});

test("only someone who may watch takes control or sends input, and the runner hears who did", async () => {
  const r = await runner();
  for (const who of [noComputer, reader, hidden, outsider]) {
    const take = await act(who, { act: "take" });
    assert.ok([403, 404].includes(take.status), `${who} can't take control (${take.status})`);
    const input = await act(who, { act: "input", method: "Input.insertText", params: { text: "hi" } });
    assert.ok([403, 404].includes(input.status), `${who} can't send input (${input.status})`);
  }
  assert.ok(!r.got.some((m) => m.t !== "watch"), "nothing of theirs reached the runner");
  assert.equal((await act(writer, { act: "take" })).status, 202);
  assert.equal((await act(writer, { act: "input", method: "Input.insertText", params: { text: "hi" } })).status, 202);
  const outside = await act(writer, { act: "input", method: "Runtime.evaluate", params: { expression: "document.cookie" } });
  assert.equal(outside.status, 400, "a method outside the allowlist never reaches the runner");
  assert.equal((await act(writer, { act: "release" })).status, 202);
  await until(() => r.got.filter((m) => m.t !== "watch").length === 3, "the three acts");
  assert.deepEqual(
    r.got.filter((m) => m.t !== "watch"),
    [
      { t: "take", bot: "max", who: { id: writer, name: "writer" } },
      { t: "input", bot: "max", who: { id: writer, name: "writer" }, method: "Input.insertText", params: { text: "hi" } },
      { t: "release", bot: "max", who: { id: writer, name: "writer" } },
    ],
  );
  r.close();
  await until(() => !runnerConnected(owner, DESKTOP), "the runner to go");
  const offline = await act(writer, { act: "take" });
  assert.equal(offline.status, 409, "no runner: its computer isn't connected");
  assert.match(offline.body.error!, /Max's computer isn't connected right now/);
});

test("pointers and what the bot is doing reach viewers; an activity-only stream hears only that and isn't watching; the owner's take goes over", async () => {
  const r = await runner();
  const chip = await watch(writer, PROJECT, "max", "activity");
  assert.equal(chip.status, 200);
  r.send({ t: "activity", bots: ["max"], step: "browsing", waiting: false, signIn: null });
  await until(() => chip.events.find((e) => e.t === "activity"), "the chip to hear the bot browsing");
  assert.deepEqual(chip.events.find((e) => e.t === "activity"), { t: "activity", step: "browsing", waiting: false, signIn: null });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.ok(!r.got.some((m) => m.t === "watch"), "an activity-only stream isn't watching: the runner captures nothing for it");
  // Someone who starts watching hears what the bot is doing at once, then pointers, labelled for them.
  const mine = await watch(owner, null);
  await until(() => mine.events.find((e) => e.t === "activity"), "the owner to hear it on arriving");
  const w = await until(() => r.got.findLast((m) => m.t === "watch"), "the runner to hear who watches");
  assert.deepEqual(w.t === "watch" && w.viewers.map((v) => v.id), [owner], "the owner watches; the chip's stream isn't counted");
  r.send({ t: "pointer", bots: ["max"], kind: "down", x: 12.5, y: 40, by: { id: owner, name: "owner" } });
  r.send({ t: "pointer", bots: ["max"], kind: "move", x: 30, y: 41, by: null });
  r.send({ t: "pointer", bots: ["max"], kind: "click" as "down", x: 1, y: 1, by: null });
  r.send({ t: "frame", bots: ["max"], data: "AAAA", meta: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } });
  // A sign-in the bot asks for: only an http or https page.
  r.send({ t: "activity", bots: ["max"], step: "idle", waiting: true, signIn: "javascript:alert(1)" });
  await until(() => mine.events.filter((e) => e.t === "activity").length === 2 && mine.events.some((e) => e.t === "frame"), "the owner's events");
  assert.deepEqual(
    mine.events.filter((e) => e.t === "pointer"),
    [
      { t: "pointer", kind: "down", x: 12.5, y: 40, by: { id: owner, name: "owner" }, you: true },
      { t: "pointer", kind: "move", x: 30, y: 41, by: null, you: false },
    ],
    "the owner's own press says it's theirs, the bot's move is the bot's, a kind it doesn't know goes nowhere",
  );
  assert.deepEqual(mine.events.filter((e) => e.t === "activity").at(-1), { t: "activity", step: "idle", waiting: true, signIn: null });
  assert.deepEqual([...new Set(chip.events.map((e) => e.t))].sort(), ["activity", "computer"], "the chip's stream: no frame, no pointer");
  // The owner's take goes over whoever has control; a member's doesn't.
  assert.equal((await act(writer, { act: "take" })).status, 202);
  const ownerTake = await fetch(`${cloud.url}/v1/browser/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(owner)}`, "content-type": "application/json" }, body: JSON.stringify({ bot: "max", act: "take" }) });
  assert.equal(ownerTake.status, 202);
  await until(() => r.got.filter((m) => m.t === "take").length === 2, "both takes");
  assert.deepEqual(
    r.got.filter((m) => m.t === "take"),
    [
      { t: "take", bot: "max", who: { id: writer, name: "writer" } },
      { t: "take", bot: "max", who: { id: owner, name: "owner" }, over: true },
    ],
  );
  chip.close();
  mine.close();
  r.close();
  await until(() => !runnerConnected(owner, DESKTOP), "the runner to go");
});

test("an Admin with no entry of their own watches and takes over, as Bops Cloud's roles give it (viewerAccess, computerUseOf); never over a member", async () => {
  assert.ok(!Object.keys(state.workspaces[0].memberAccess).some((k) => k.startsWith(admin)), "no per-person entry");
  const r = await runner();
  const theirs = await watch(admin);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  const w = await until(() => r.got.findLast((m) => m.t === "watch" && m.viewers.some((v) => v.id === admin)), "the runner to hear the Admin watch");
  assert.ok(w);
  assert.equal((await act(admin, { act: "take" })).status, 202);
  assert.equal((await act(admin, { act: "input", method: "Input.insertText", params: { text: "hi" } })).status, 202);
  await until(() => r.got.some((m) => m.t === "input"), "the Admin's input");
  assert.deepEqual(r.got.find((m) => m.t === "take"), { t: "take", bot: "max", who: { id: admin, name: "admin" } }, "an Admin's take: not over a member (the owner's alone)");
  theirs.close();
  r.close();
  await until(() => !runnerConnected(owner, DESKTOP), "the runner to go");
});

test("a viewer who leaves while they're being checked is never counted as watching", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  resetBrowser({ state: async (account) => (await held, account === owner ? state : {}) });
  const ctl = new AbortController();
  const asked = fetch(`${cloud.url}/v1/browser/watch?bot=max`, { headers: { Authorization: `Bearer ${keyOf(owner)}` }, signal: ctl.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  ctl.abort();
  await asked;
  await new Promise((r) => setTimeout(r, 100));
  release();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(viewersOf(owner, "max"), 0, "nobody watches: the runner would capture for no one");
});

test("only a computer opens the runner's socket", async () => {
  const ws = new WebSocket(`${cloud.url.replace("http", "ws")}/v1/browser/runner`, { headers: { Authorization: `Bearer ${keyOf(owner)}` } });
  const status = await new Promise<number>((ok) => {
    ws.on("unexpected-response", (_req, res) => ok(res.statusCode ?? 0));
    ws.on("open", () => ok(101));
  });
  assert.equal(status, 403, "the owner's own key isn't a computer");
});
