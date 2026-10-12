// Tests for the categories that fill themselves from memory: the engine (lib/server/memory-categories.ts)
// and its route (app/api/memory/categories). Who has them (the gate), a first look at memory (facts sorted
// into People, Events, To-dos and the rest, one fact making several items, the card, where each item was
// learned, private lines, the file on this Mac), mentions merging, a look with nothing new costing
// nothing, a fact saved now sorted within seconds, facts gone from memory, the user's changes (rename,
// done, hide, forget), tidying up, what goes wrong (the model, memory, a damaged file, another account
// signing in mid-look), and a big memory sorted a run at a time. Every user-facing line is checked for
// dashes. Honcho is a fake answering the REST calls its SDK makes, OpenAI a fake /v1/responses that
// answers each fact from a table below, Jev isn't set up (privacy falls back to the patterns), the
// Keychain is a stand-in that's never there, and the state and files live in a throwaway folder: nothing
// reaches a real service or the user's own data.
//
// The named checks inside sections (check()) each hold to something that was a bug while this was built:
// an account switch mid-forget, older mentions undoing newer ones, names in other alphabets, the UTC day.
// Usage: node --conditions=react-server scripts/test-memory-categories.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
// A self-hosted install: the state is a file in the working folder, memory is Honcho on its own key
// (bank "bops", peer "user" for the first workspace), and the model is OpenAI on its own key.
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
process.env.OPENAI_API_KEY = "sk-test-categories";
process.env.HONCHO_API_KEY = "hc-test-categories";
process.env.BOPS_MEMORY_MODEL = "gpt-test-memory";
const HONCHO_KEY = process.env.HONCHO_API_KEY;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-categories-"));
// The Keychain is never read: `security` is a stand-in that has nothing, and HOME is empty.
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// The engine's clock: moved forward by the tidy-up and date tests (an hour later, a time of day). Only ever forward.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

// Modules that would start processes when loaded are stand-ins whose exports do nothing (as in test-crm.mjs).
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait for `check` to give something truthy (and return it). */
async function until(check, what, ms = 4000) {
  for (const end = realNow() + ms; realNow() < end; await sleep(20)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const iso = (ms) => new Date(ms).toISOString();

/* ---------------- Honcho: a fake of the REST calls the SDK makes ---------------- */

// Each bank (a Honcho workspace): its peers, each peer's card, its facts (conclusions) and the dreams asked for.
// `fail(call)` answers a call instead (a failure), `hold(call)` keeps it waiting until releaseHoncho().
const honcho = { banks: new Map(), calls: [], unknown: [], fail: null, hold: null, held: [], seq: 0 };
function hbank(id) {
  let b = honcho.banks.get(id);
  if (!b) honcho.banks.set(id, (b = { peers: new Set(), cards: new Map(), facts: [], dreams: [] }));
  return b;
}
const asConclusion = (f) => ({ id: f.id, content: f.text, observer_id: f.observer, observed_id: f.observed, session_id: f.session, created_at: iso(f.at), level: f.level, source_ids: null, times_derived: 1 });
function addFact(bank, text, { at = Date.now(), session = null, level = "explicit" } = {}) {
  const seq = ++honcho.seq;
  const f = { id: `c${seq}`, text, at, session, level, seq, observer: "user", observed: "user" };
  hbank(bank).facts.push(f);
  return f;
}
const removeFact = (bank, id) => void (hbank(bank).facts = hbank(bank).facts.filter((f) => f.id !== id));
const factIds = (bank) => hbank(bank).facts.map((f) => f.id);
const releaseHoncho = () => {
  honcho.hold = null;
  for (const r of honcho.held.splice(0)) r();
};

async function honchoAnswer(req, url) {
  const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : undefined, auth: req.headers.get("authorization") };
  honcho.calls.push(call);
  if (honcho.hold?.(call)) await new Promise((r) => honcho.held.push(r));
  const failed = honcho.fail?.(call);
  if (failed) return failed;
  const p = url.pathname.split("/").slice(1);
  const created_at = iso(0);
  if (p[0] !== "v3" || p[1] !== "workspaces") return unknownCall(call);
  // Workspaces and peers: get or create.
  if (p.length === 2 && req.method === "POST") {
    hbank(call.body.id);
    return json({ id: call.body.id, metadata: {}, configuration: {}, created_at });
  }
  const b = hbank(p[2]);
  const rest = p.slice(3).join("/");
  if (rest === "peers" && req.method === "POST") {
    b.peers.add(call.body.id);
    return json({ id: call.body.id, workspace_id: p[2], metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, created_at });
  }
  const card = rest.match(/^peers\/([^/]+)\/card$/);
  if (card && req.method === "GET") return json({ peer_card: b.cards.get(card[1]) ?? null });
  if (card && req.method === "PUT") {
    b.cards.set(card[1], call.body.peer_card);
    return json({ peer_card: call.body.peer_card });
  }
  // Conclusions: newest first, 100 a page at most, for one observer and observed.
  if (rest === "conclusions/list" && req.method === "POST") {
    const f = call.body?.filters ?? {};
    const page = Number(call.query.page ?? 1);
    const size = Number(call.query.size ?? 50);
    if (size > 100) return json({ detail: "size can be 100 at most" }, 422);
    const all = b.facts.filter((x) => (!f.observer_id || x.observer === f.observer_id) && (!f.observed_id || x.observed === f.observed_id)).sort((x, y) => y.at - x.at || y.seq - x.seq);
    return json({ items: all.slice((page - 1) * size, page * size).map(asConclusion), total: all.length, page, size, pages: Math.ceil(all.length / size) });
  }
  if (rest === "conclusions/query" && req.method === "POST") return json([]);
  if (rest === "conclusions" && req.method === "POST") return json(call.body.conclusions.map((c) => asConclusion(addFact(p[2], c.content, { session: c.session_id ?? null }))));
  const one = rest.match(/^conclusions\/([^/]+)$/);
  if (one && req.method === "DELETE") {
    if (!b.facts.some((x) => x.id === one[1])) return json({ detail: "Conclusion not found" }, 404);
    removeFact(p[2], one[1]);
    return new Response(null, { status: 204 });
  }
  if (rest === "schedule_dream" && req.method === "POST") {
    b.dreams.push(call.body);
    return new Response(null, { status: 204 });
  }
  return unknownCall(call);
}
const unknownCall = (call) => (honcho.unknown.push(`${call.method} ${call.path}`), json({ detail: "Not Found" }, 404));

/* ---------------- OpenAI: a fake /v1/responses that sorts each fact from a table ---------------- */

/** What the model says each fact is about, by the fact's text: its answer is a function of what it was asked. */
const SORTS = new Map();
/** One item as the model gives it (every field is required by the schema). */
const item = (category, title, more = {}) => ({ category, title, detail: "", key: "", when: "", who: "", done: false, ...more });
// Each call (its body, its input parsed, the fact texts); `fail(call)` answers instead, `hold(call)` waits for releaseOpenai().
const openai = { calls: [], other: [], unknown: [], fail: null, hold: null, held: [] };
const response = (text) => ({
  id: `resp_${openai.calls.length}`,
  object: "response",
  model: "gpt-test",
  status: "completed",
  output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});
const releaseOpenai = () => {
  openai.hold = null;
  for (const r of openai.held.splice(0)) r();
};
async function openaiAnswer(req) {
  const body = JSON.parse(await req.text());
  if (body.text?.format?.name !== "memory_items") {
    openai.other.push(body);
    return json({ error: { message: "not faked", type: "invalid_request_error" } }, 400);
  }
  const input = JSON.parse(body.input);
  const call = { body, input, texts: input.facts.map((f) => f.fact) };
  openai.calls.push(call);
  if (openai.hold?.(call)) await new Promise((r) => openai.held.push(r));
  const failed = openai.fail?.(call);
  if (failed) return failed;
  // Answered in reverse order: the engine must go by `i`, not by place.
  const facts = [...input.facts].reverse().map((f) => {
    if (!SORTS.has(f.fact)) openai.unknown.push(f.fact);
    return { i: f.i, items: SORTS.get(f.fact) ?? [] };
  });
  return json(response(JSON.stringify({ facts })));
}

// Everything else is offline.
const offline = [];
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") return openaiAnswer(req);
  if (url.origin === "https://api.honcho.dev") return honchoAnswer(req, url);
  offline.push(req.url);
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
// Node says once that package.json has no "type" (it reads the .ts files as modules all the same): not this test's business.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const S = await import(`${root}/lib/server/store.ts`);
const Mem = await import(`${root}/lib/server/memory.ts`);
const MC = await import(`${root}/lib/server/memory-categories.ts`);
const R = await import(`${root}/app/api/memory/categories/route.ts`);
const Cat = await import(`${root}/lib/memory-categories.ts`);
const { botChatId, MAIN_WORKSPACE } = await import(`${root}/lib/types.ts`);

/* ---------------- Helpers ---------------- */

/** Everything the user could read (route errors, error lines, items' lines, where they came from), checked for dashes at the end. */
const spoken = [];
const noDashes = (text) => assert.ok(!/[\u2013\u2014]/.test(String(text)), `no dashes: ${text}`);
const hear = (body) => {
  if (body?.error) spoken.push(body.error);
  for (const i of body?.items ?? []) spoken.push(i.title, i.detail, i.who ?? "", ...i.sources.map((s) => s.from));
};
const request = async (handler, method, path, body, { quiet = false } = {}) => {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await handler(new Request(`http://localhost:3210${path}`, init));
  const out = { status: res.status, body: await res.json() };
  if (!quiet) hear(out.body);
  return out;
};
const get = (ws) => request(R.GET, "GET", `/api/memory/categories${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
const post = (body, opts) => request(R.POST, "POST", "/api/memory/categories", body, opts);
/** Look at memory now (Refresh): the categories after. */
async function refresh(ws) {
  const r = await post({ action: "refresh", ws });
  assert.equal(r.status, 200, `refresh ${ws}: ${JSON.stringify(r.body)}`);
  return r.body;
}
/** The categories once the look under way (one the window started) is done. */
const settled = (ws) =>
  until(async () => {
    const r = await get(ws);
    return r.body.syncing ? null : r.body;
  }, `the look at ${ws} to finish`);
/** The one item with this name in this category. */
function one(items, category, title) {
  const found = items.filter((i) => i.category === category && i.title === title);
  assert.equal(found.length, 1, `one ${category} item called ${title} (there are: ${items.filter((i) => i.category === category).map((i) => i.title).join(", ") || "none"})`);
  return found[0];
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const fileFor = (bank) => join(work, ".data", "memory-categories", `${bank}.json`);
const indexOf = (bank) => JSON.parse(readFileSync(fileFor(bank), "utf8"));
const mode = (p) => statSync(p).mode & 0o777;
/** The engine's own bookkeeping for a bank (it keeps it on globalThis): the look under way and the looks set for later. */
const liveBank = (bank) => globalThis.bopsCategories?.banks.get(bank);
const timersOf = (bank) => [...(liveBank(bank)?.timers.keys() ?? [])].sort();
const delayOf = (bank, why) => liveBank(bank)?.timers.get(why)?._idleTimeout;
function clearTimers(bank) {
  const b = liveBank(bank);
  for (const t of b?.timers.values() ?? []) clearTimeout(t);
  b?.timers.clear();
}
/** Facts in a bank's memory (minutes before `base`), with what the model says of each, and the user's card. */
function seed(ws, list, { base = Date.now() - 86_400_000, cards } = {}) {
  const bank = Mem.bankOf(ws);
  const out = {};
  for (const [name, minutes, text, items, opts = {}] of list) {
    SORTS.set(text, items);
    out[name] = addFact(bank, text, { at: base - minutes * 60_000, ...opts });
  }
  if (cards) {
    hbank(bank).cards.set("user", cards.map(([line]) => line));
    for (const [line, items] of cards) SORTS.set(line, items);
  }
  return out;
}
/** A fact learned after everything so far (newer than any card line already sorted). */
let ahead = 0;
function newFact(ws, text, items, opts = {}) {
  SORTS.set(text, items);
  return addFact(Mem.bankOf(ws), text, { at: Date.now() + ++ahead * 1000, ...opts });
}
/** Every object in a JSON schema closed, with every property required (OpenAI's strict mode). */
function strictSchema(s, where = "schema") {
  if (s.type === "object") {
    assert.equal(s.additionalProperties, false, `${where} is closed`);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${where}: every property required`);
    for (const [k, v] of Object.entries(s.properties)) strictSchema(v, `${where}.${k}`);
  }
  if (s.type === "array") strictSchema(s.items, `${where}[]`);
}

/* ---------------- The run: sections, and checks that fail because of a bug in the engine ---------------- */

const results = [];
/** A check that fails today because of a bug in the engine: reported, not fatal, so the rest still runs. */
/** A check inside a section, named for what it holds to (each was a bug found while building this). */
async function check(what, fn) {
  try {
    await fn();
  } catch (e) {
    e.message = `${what}: ${e.message}`;
    throw e;
  }
}
/** Whatever a section left behind (a failure injected, a call held, another account signed in, the gate's settings) is undone after it. */
async function reset() {
  openai.fail = null;
  releaseOpenai();
  honcho.fail = null;
  releaseHoncho();
  if (S.stateUser()) await S.releaseSignOut();
  process.env.HONCHO_API_KEY = HONCHO_KEY;
  process.env.BOPS_SELF_HOSTED = "1";
  delete process.env.BOPS_DATABASE_URL;
  if (S.getState().account?.user.email !== "maya@orgo.ai") signInAs("maya@orgo.ai");
}
async function section(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`FAIL ${name}\n       ${String(e.stack ?? e).split("\n").slice(0, 6).join("\n       ")}`);
  } finally {
    await reset();
  }
}

// The state: Tiger, with Boppy and Max (Max has a chat), a task, and a workspace for each part below (each its own bank).
const MAIN = MAIN_WORKSPACE;
const MAX_CHAT = `bops-chat-${botChatId("max").replace(/[^A-Za-z0-9_-]/g, "-")}`;
const WORKSPACES = ["ws_done", "ws_i18n", "ws_drop", "ws_edit", "ws_forget", "ws_many", "ws_forgetfail", "ws_fail", "ws_down", "ws_damaged", "ws_oldshape", "ws_big", "ws_window", "ws_switch", "ws_tidy", "ws_tidy2", "ws_tidy3", "ws_tz"];
S.update((s) => {
  s.owner = { name: "Tiger" };
  s.bots.push({ id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "none" });
  s.chats.push({ id: botChatId("max"), kind: "bot", botIds: ["max"], createdAt: 0, typing: [] });
  s.sessions.push({ id: "t_flight", botId: "boppy", chatId: botChatId("boppy"), goal: "Book the flight", title: "Book the flight", status: "done", replies: [], createdAt: 0, sentVia: "you", host: "orgo" });
  for (const id of WORKSPACES) s.workspaces.push({ id, name: id, createdAt: 0 });
});
const signInAs = (email) =>
  S.update((s) => {
    if (email) s.account = { user: { id: "u_maya", email }, signedInAt: 0 };
    else delete s.account;
  });

/* ---------------- Who has them ---------------- */

await section("The gate: @orgo.ai accounts only, signed in, memory set up, on this Mac", async () => {
  assert.equal(Cat.categoriesOpen({ account: { user: { id: "u", email: " Maya@ORGO.AI " } } }), true, "case and spaces don't matter");
  for (const email of ["maya@example.com", "maya@orgo.ai.example.com", "maya@sub.orgo.ai", ""]) assert.equal(Cat.categoriesOpen({ account: { user: { id: "u", email } } }), false, email);
  assert.equal(Cat.categoriesOpen({}), false, "signed out");

  const answered = [];
  const closed = async (who) => {
    assert.equal(MC.categoriesOn(), false, `off ${who}`);
    const g = await get(MAIN);
    assert.equal(g.status, 200, who);
    assert.deepEqual([g.body.ws, g.body.items, g.body.syncing], [MAIN, [], false], `the sidebar gets nothing ${who}`);
    answered.push([who, g.body.on]);
    for (const body of [{ action: "refresh" }, { action: "tidy-up" }, { action: "edit", id: "x", title: "y" }, { action: "forget", id: "x" }, { action: "nope" }]) {
      const r = await post(body);
      assert.deepEqual([r.status, r.body], [404, { error: "Memory isn't set up." }], `${body.action} ${who}`);
    }
    MC.nudge(MAIN, "learned");
    MC.nudge(MAIN, "saved");
    await MC.sync(MAIN);
    await assert.rejects(MC.tidyUp(MAIN), { message: "Memory isn't set up." });
    assert.throws(() => MC.editItem(MAIN, "x", { title: "y" }), { message: "Memory isn't set up." });
    await assert.rejects(MC.forgetItem(MAIN, "x"), { message: "Memory isn't set up." });
    assert.equal(liveBank("bops"), undefined, `nothing started or set for later ${who}`);
    assert.deepEqual([honcho.calls.length, openai.calls.length], [0, 0], `nothing asked of memory or the model ${who}`);
    assert.ok(!existsSync(join(work, ".data", "memory-categories")), `nothing written ${who}`);
  };
  signInAs(null);
  await closed("signed out");
  signInAs("sam@example.com");
  await closed("for an account outside Orgo");
  signInAs("maya@orgo.ai");
  delete process.env.HONCHO_API_KEY;
  assert.equal(Mem.memoryOn(), false);
  await closed("with memory off");
  process.env.HONCHO_API_KEY = HONCHO_KEY;
  // The Mac app signed out: no user's folder to keep anything in.
  delete process.env.BOPS_SELF_HOSTED;
  await closed("in the Mac app signed out");
  process.env.BOPS_SELF_HOSTED = "1";
  // A hosted server (Postgres): never there.
  process.env.BOPS_DATABASE_URL = "postgres://nobody@localhost:1/none";
  await closed("on a hosted server");
  delete process.env.BOPS_DATABASE_URL;
  assert.equal(MC.categoriesOn(), true, "on for maya@orgo.ai, self-hosted, with a Honcho key");

  await check("GET answers on: false wherever the categories are closed (snapshot() answers on: memoryOn())", () => {
    const wrong = answered.filter(([, on]) => on !== false).map(([who]) => who);
    assert.deepEqual(wrong, [], `on: true was answered ${wrong.join(", ")}`);
  });
});

/* ---------------- A first look ---------------- */

let first; // the main bank's facts, for the parts after
await section("A first look at memory: facts sorted into the categories", async () => {
  const bank = Mem.bankOf(MAIN);
  assert.equal(bank, "bops", "self-hosted, the first workspace's bank is bops");
  const F = (first = seed(
    MAIN,
    [
      [
        "f1",
        10,
        "Tiger meets Dana Reyes from Acme on Friday at 3pm about the quote.",
        [
          item("events", "Meeting with Dana", { key: "meeting with dana 2026-10-16", when: "2026-10-16T15:00", who: "Dana Reyes", detail: "About the quote" }),
          item("people", "Dana Reyes", { key: "dana reyes", detail: "Your contact at Acme" }),
          item("companies", "Acme", { key: "acme", detail: "Your customer" }),
        ],
        { session: MAX_CHAT },
      ],
      ["f2", 20, "Tiger's sister Ana lives in Lisbon.", [item("people", "Ana", { key: "Ana", detail: "Your sister, lives in Lisbon" })], { session: "bops-task-t_flight" }],
      ["f3", 30, "ANA prefers texts to calls.", [item("people", "ANA", { key: "ANÁ", detail: "Prefers texts to calls" })]],
      ["f4", 40, "Leo's phone number is +351 912 345 678.", [item("people", "Leo", { key: "leo", detail: "Phone number on file" })], { session: "hermes-7f3a" }],
      [
        "f5",
        50,
        "Tiger needs to send the invoice to Acme by Friday.",
        [item("todos", "Send the invoice to Acme", { key: "send invoice acme", when: "2026-10-16", who: "Acme" }), item("companies", "Acme Inc", { key: "Acme Inc", detail: "Gets your invoice" })],
      ],
      ["f6", 60, "Dana promised to send Tiger the signed contract by Monday.", [item("promises", "Dana sends the signed contract", { key: "dana signed contract", who: "Dana Reyes", when: "next Monday" })]],
      ["f7", 70, "Tiger is building Bops, an app for teams of AI assistants.", [item("projects", "Bops", { key: "Project Bops", detail: "An app for teams of AI assistants." })]],
      ["f8", 80, "Tiger decided to price the Pro plan at 40 dollars a month to cover costs.", [item("decisions", "Pro plan at 40 dollars a month", { key: "pro plan price", detail: "To cover costs \u2014 servers and support" })]],
      ["f9", 90, "Tiger prefers aisle seats on flights.", [item("preferences", "Aisle seats", { key: "aisle seats", detail: "On flights" })], { level: "deductive", session: "bops-chat-gone" }],
      ["f10", 100, "Tiger said good morning.", []],
    ],
    {
      cards: [
        ["Tiger's accountant is Priya Shah.", [item("people", "Priya Shah", { key: "priya shah", detail: "Your accountant" })]],
        ["Tiger lives in Oakland.", []],
        ["Sister: Ana", [item("people", "Ana", { key: "ana" })]],
      ],
    },
  ));
  const CARD = ["Tiger's accountant is Priya Shah.", "Tiger lives in Oakland.", "Sister: Ana"];
  const started = Date.now();
  // The window asking starts the first look; it says so, and the categories come in when it's done.
  let r = await get(MAIN);
  assert.deepEqual(pick(r.body, ["on", "ws", "items", "syncing"]), { on: true, ws: MAIN, items: [], syncing: true });
  const snap = await settled(MAIN);

  // Memory, as the Honcho SDK asks it: the bank and the peer (get or create), the newest facts a page of 100 at a time, the card.
  const calls = honcho.calls.filter((c) => c.path.startsWith("/v3/workspaces"));
  assert.ok(calls.every((c) => c.auth === `Bearer ${HONCHO_KEY}`), "on the Honcho key");
  assert.deepEqual(pick(calls[0], ["method", "path"]), { method: "POST", path: "/v3/workspaces" });
  assert.equal(calls[0].body.id, "bops");
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/v3/workspaces/bops/peers" && c.body.id === "user"), "the user's peer");
  const lists = calls.filter((c) => c.path === "/v3/workspaces/bops/conclusions/list");
  assert.deepEqual(
    lists.map((c) => [c.method, c.query, c.body]),
    [["POST", { page: "1", size: "100" }, { filters: { observer_id: "user", observed_id: "user" } }]],
    "what memory concluded about the user, newest first",
  );
  assert.ok(calls.some((c) => c.method === "GET" && c.path === "/v3/workspaces/bops/peers/user/card"), "the user's card");

  // One model call for 13 new facts (25 a call), asking for JSON in the categories' shape.
  assert.equal(openai.calls.length, 1, "one model call");
  const ask = openai.calls[0];
  assert.equal(ask.body.model, "gpt-test-memory", "BOPS_MEMORY_MODEL");
  assert.deepEqual(ask.body.reasoning, { effort: "low" });
  assert.deepEqual(pick(ask.body.text.format, ["type", "name", "strict"]), { type: "json_schema", name: "memory_items", strict: true });
  strictSchema(ask.body.text.format.schema);
  assert.deepEqual(ask.body.text.format.schema.properties.facts.items.properties.items.items.properties.category.enum, Cat.CATEGORY_IDS);
  assert.match(ask.body.instructions, /learned about Tiger into the categories/);
  assert.ok(ask.body.instructions.includes("their AI assistants (Boppy, Max)"), "the bots are named, so they're never items");
  for (const c of Cat.CATEGORIES) assert.ok(ask.body.instructions.includes(`- ${c.id}: ${c.about}`), `the model is told what ${c.id} is`);
  assert.match(ask.input.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(ask.input.facts.map((f) => f.i), [...Array(13).keys()]);
  assert.deepEqual(ask.texts, [...Object.values(F).map((f) => f.text), ...CARD], "the newest facts first, then the card's lines");
  for (const f of ask.input.facts) assert.match(f.learned, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(ask.input.facts.filter((f) => f.from).map((f) => [f.fact, f.from]), CARD.map((l) => [l, "profile card"]));
  assert.deepEqual(ask.input.known, {}, "nothing known yet");
  assert.equal(S.getState().usage.filter((u) => u.source === "memory").length, 1, "the model call is counted");

  // What came of it: one fact can make several items, mentions of the same thing merge.
  const items = snap.items;
  assert.equal(snap.error, undefined);
  assert.ok(snap.syncedAt >= started);
  assert.equal(snap.behind, undefined);
  assert.deepEqual(
    items.map((i) => `${i.category}: ${i.title}`).sort(),
    [
      "companies: Acme",
      "decisions: Pro plan at 40 dollars a month",
      "events: Meeting with Dana",
      "people: Ana",
      "people: Dana Reyes",
      "people: Leo",
      "people: Priya Shah",
      "preferences: Aisle seats",
      "projects: Bops",
      "promises: Dana sends the signed contract",
      "todos: Send the invoice to Acme",
    ],
  );
  const meeting = one(items, "events", "Meeting with Dana");
  const dana = one(items, "people", "Dana Reyes");
  const acme = one(items, "companies", "Acme");
  const idx = indexOf(bank);
  assert.deepEqual([...idx.facts[F.f1.id].items].sort(), [meeting.id, dana.id, acme.id].sort(), "one fact, three items");
  assert.deepEqual(pick(meeting, ["key", "when", "who", "detail"]), { key: "events:meeting with dana 2026-10-16", when: "2026-10-16T15:00", who: "Dana Reyes", detail: "About the quote" });
  // Where each was learned: the fact, when, from what, and how.
  assert.deepEqual(dana.sources, [{ fact: F.f1.id, text: F.f1.text, at: F.f1.at, from: "Chat with Max", how: "said" }]);
  assert.deepEqual(pick(dana, ["key", "detail", "first", "last"]), { key: "people:dana reyes", detail: "Your contact at Acme", first: F.f1.at, last: F.f1.at });
  // Two facts about the same company (one says "Acme Inc"): one item, both sources, newest first.
  assert.deepEqual(pick(acme, ["key", "title", "detail"]), { key: "companies:acme", title: "Acme", detail: "Your customer" });
  assert.deepEqual(acme.sources.map((s) => [s.fact, s.from]), [[F.f1.id, "Chat with Max"], [F.f5.id, "Saved by hand"]]);
  // Ana: two facts with her name in other case and accents, and a card line. The card line is newest (it has no date).
  const ana = one(items, "people", "Ana");
  assert.equal(ana.key, "people:ana");
  assert.deepEqual(
    ana.sources.map((s) => [s.fact, s.from, s.how]),
    [["card:Sister: Ana", "Your card", "card"], [F.f2.id, "Task: Book the flight", "said"], [F.f3.id, "Saved by hand", "said"]],
  );
  assert.equal(ana.sources[0].text, "Sister: Ana");
  assert.ok(ana.sources[0].at >= started && ana.sources[0].at <= Date.now());
  assert.deepEqual([ana.first, ana.last], [F.f3.at, ana.sources[0].at]);
  assert.equal(ana.detail, "Your sister, lives in Lisbon", "the newest fact's line; an older one doesn't change it");
  // A card line on its own, and the source of what memory worked out rather than was told.
  assert.deepEqual(one(items, "people", "Priya Shah").sources.map((s) => pick(s, ["fact", "from", "how"])), [{ fact: "card:Tiger's accountant is Priya Shah.", from: "Your card", how: "card" }]);
  assert.deepEqual(pick(one(items, "preferences", "Aisle seats").sources[0], ["how", "from"]), { how: "figured", from: "Bops" });
  // A phone number is private: the line it came from, and an item learned only from it.
  const leo = one(items, "people", "Leo");
  assert.deepEqual([leo.private, leo.sources[0].private, leo.sources[0].from], [true, true, "Your other agents"]);
  for (const i of items.filter((x) => x !== leo)) assert.equal(i.private, undefined, `${i.title} isn't private`);
  // To-dos and promises: when they're due (a date the app can read, or none), who for.
  assert.deepEqual(pick(one(items, "todos", "Send the invoice to Acme"), ["when", "who", "done"]), { when: "2026-10-16", who: "Acme", done: undefined });
  assert.deepEqual(pick(one(items, "promises", "Dana sends the signed contract"), ["when", "who"]), { when: undefined, who: "Dana Reyes" }, "\"next Monday\" isn't a date");
  assert.deepEqual(pick(one(items, "projects", "Bops"), ["key", "detail"]), { key: "projects:bops", detail: "An app for teams of AI assistants" }, "\"Project Bops\" is Bops; no full stop");
  noDashes(one(items, "decisions", "Pro plan at 40 dollars a month").detail);
  // Small talk makes nothing, but it's marked sorted so it isn't sent again; so is a card line about Tiger.
  assert.deepEqual(idx.facts[F.f10.id], { items: [], at: F.f10.at });
  assert.deepEqual(idx.facts["card:Tiger lives in Oakland."].items, []);

  // The file: <userDir>/memory-categories/bops.json, the user's only.
  const dir = join(work, ".data", "memory-categories");
  assert.equal(mode(dir), 0o700, "the folder is the user's only");
  assert.equal(mode(fileFor("bops")), 0o600, "and so is the file");
  assert.deepEqual(readdirSync(dir), ["bops.json"], "no temp files left");
  assert.deepEqual(pick(idx, ["v", "bank", "forgotten", "error"]), { v: 1, bank: "bops", forgotten: {}, error: undefined });
  assert.equal(Object.keys(idx.facts).length, 13);
  assert.equal(Object.keys(idx.items).length, 11);
  assert.equal(idx.syncedAt, snap.syncedAt);

  // Asked without a workspace, or for one that isn't there: the one in use.
  assert.equal((await get()).body.items.length, 11);
  assert.equal((await get("ws_nope")).body.ws, MAIN);
});

/* ---------------- Nothing new ---------------- */

await section("A look with nothing new: no model call", async () => {
  const was = (await get(MAIN)).body;
  const n = openai.calls.length;
  const lists = honcho.calls.filter((c) => c.path.endsWith("/conclusions/list")).length;
  const now = await refresh(MAIN);
  assert.equal(openai.calls.length, n, "nothing sent to the model");
  assert.equal(honcho.calls.filter((c) => c.path.endsWith("/conclusions/list")).length, lists + 1, "memory was read (that's free)");
  assert.ok(now.syncedAt >= was.syncedAt);
  assert.deepEqual(now.items, was.items);
});

/* ---------------- Merging ---------------- */

await section("Mentions merging: a newer one updates the line, unless the user changed it", async () => {
  const F = first;
  // A newer mention of Ana: her line says how things stand now. The model is told what's known, with keys.
  const m1 = newFact(MAIN, "Ana moved to Porto last month.", [item("people", "Ana", { key: "ana", detail: "Your sister, lives in Porto now" })]);
  let n = openai.calls.length;
  let r = await refresh(MAIN);
  const known = openai.calls[n].input.known;
  assert.ok(known.people.some((k) => k.title === "Ana" && k.key === "ana"), "Ana is known, with her key");
  assert.ok(known.people.some((k) => k.title === "Dana Reyes" && k.key === "dana reyes"));
  assert.deepEqual(known.events, [{ title: "Meeting with Dana", key: "meeting with dana 2026-10-16", when: "2026-10-16T15:00" }]);
  let ana = one(r.items, "people", "Ana");
  assert.equal(ana.detail, "Your sister, lives in Porto now");
  assert.equal(ana.sources[0].fact, m1.id);
  assert.equal(ana.last, m1.at);
  // An older mention sorted later (a big memory sorts the newest first): one more source, but the line stays.
  const m2 = addFact("bops", "Ana used to live in Madrid.", { at: F.f3.at - 86_400_000 });
  SORTS.set(m2.text, [item("people", "Ana", { key: "ana", detail: "Your sister, lived in Madrid" })]);
  r = await refresh(MAIN);
  ana = one(r.items, "people", "Ana");
  assert.equal(ana.detail, "Your sister, lives in Porto now");
  assert.equal(ana.first, m2.at);
  assert.equal(ana.sources.at(-1).fact, m2.id);
  assert.equal(ana.sources.length, 5);
  // The user's own line stays through newer mentions.
  let e = await post({ action: "edit", id: ana.id, detail: "My big sister" });
  assert.equal(e.status, 200);
  newFact(MAIN, "Ana got a job at a bank.", [item("people", "Ana", { key: "ana", detail: "Your sister, works at a bank" })]);
  r = await refresh(MAIN);
  ana = one(r.items, "people", "Ana");
  assert.deepEqual(pick(ana, ["detail", "edited"]), { detail: "My big sister", edited: true });
  assert.equal(ana.sources.length, 6);
  // A newer mention with a fuller name of the same person: the fuller name.
  newFact(MAIN, "Dana Reyes, whose full name is Dana Reyes Ortiz, buys for Acme.", [item("people", "Dana Reyes Ortiz", { key: "dana reyes", detail: "The buyer at Acme" })]);
  r = await refresh(MAIN);
  const dana = one(r.items, "people", "Dana Reyes Ortiz");
  assert.equal(dana.detail, "The buyer at Acme");
  assert.equal(dana.sources.length, 2);
  // A first name alone: the model is shown what's known, with keys, and uses Priya Shah's key for her (a
  // fact that doesn't say who she is leaves her line as it was). Nothing merges by first name on its own.
  const m5 = newFact(MAIN, "Priya sent Tiger the tax forms.", [item("people", "Priya", { key: "priya shah", detail: "" })]);
  r = await refresh(MAIN);
  assert.ok(openai.calls.at(-1).body.input.includes('"key":"priya shah"'), "the model was told Priya Shah's key");
  assert.ok(!r.items.some((i) => i.title === "Priya"), "not a second Priya");
  let priya = one(r.items, "people", "Priya Shah");
  assert.equal(priya.detail, "Your accountant");
  assert.deepEqual(priya.sources.map((s) => s.fact), [m5.id, "card:Tiger's accountant is Priya Shah."]);
  assert.deepEqual(indexOf("bops").facts[m5.id].items, [priya.id]);
  // Two people who only share a first name stay two (the model gives the new one her own key).
  const m6 = newFact(MAIN, "Priya Das is Tiger's new designer.", [item("people", "Priya Das", { key: "priya das", detail: "Your designer" })]);
  r = await refresh(MAIN);
  assert.equal(one(r.items, "people", "Priya Das").sources[0].fact, m6.id);
  assert.equal(one(r.items, "people", "Priya Shah").detail, "Your accountant");

  await check("An older mention of a to-do with no date doesn't undo a newer one saying it's done", async () => {
    seed("ws_done", [
      ["n1", 10, "Tiger renewed the car insurance.", [item("todos", "Renew the car insurance", { key: "renew car insurance", done: true })]],
      ["n2", 600, "Tiger has to renew the car insurance.", [item("todos", "Renew the car insurance", { key: "renew car insurance", done: false })]],
    ]);
    const done = one((await refresh("ws_done")).items, "todos", "Renew the car insurance").done;
    assert.equal(done, true, `done, as the newest mention says (it is ${done})`);
  });
  await check("People named in other alphabets stay apart (keyOf turns every non Latin name into the same empty key)", async () => {
    seed("ws_i18n", [
      ["i1", 10, "Tiger's colleague Иван runs the Kyiv office.", [item("people", "Иван", { key: "иван", detail: "Your colleague in Kyiv" })]],
      ["i2", 20, "Tiger's friend Мария lives in Sofia.", [item("people", "Мария", { key: "мария", detail: "Your friend in Sofia" })]],
      ["i3", 30, "Tiger's supplier 王伟 ships from Shenzhen.", [item("people", "王伟", { key: "王伟", detail: "Your supplier" })]],
    ]);
    const people = (await refresh("ws_i18n")).items.filter((i) => i.category === "people");
    assert.deepEqual(people.map((i) => i.title).sort(), ["Иван", "Мария", "王伟"].sort(), `three people, not ${people.length} (${people.map((i) => `${i.title}: ${i.sources.length} facts`).join(", ")})`);
  });
});

/* ---------------- A fact saved now ---------------- */

await section("A fact saved now (by hand or a bot) is sorted within seconds", async () => {
  const was = (await get(MAIN)).body;
  const h = honcho.calls.length;
  const n = openai.calls.length;
  const text = "Tiger's brother Theo lives in Porto.";
  SORTS.set(text, [item("people", "Theo", { key: "theo", detail: "Your brother, lives in Porto" })]);
  assert.equal(await Mem.learn(MAIN, text), "Saved.");
  await until(() => timersOf("bops").includes("learned"), "a quick look set for a few seconds later");
  assert.equal(delayOf("bops", "learned") ?? 4000, 4000);
  const theo = await until(async () => (await get(MAIN)).body.items.find((i) => i.title === "Theo"), "Theo in the categories", 10_000);
  assert.deepEqual(theo.sources.map((s) => pick(s, ["text", "from", "how"])), [{ text, from: "Saved by hand", how: "said" }]);
  assert.deepEqual(openai.calls.slice(n).map((c) => c.texts), [[text]], "only the new fact went to the model");
  const looks = honcho.calls.slice(h);
  assert.deepEqual(looks.filter((c) => c.path.endsWith("/conclusions/list")).map((c) => c.query), [{ page: "1", size: "100" }], "a quick look reads the newest page");
  assert.ok(!looks.some((c) => c.method === "GET" && c.path.endsWith("/card")), "and not the card");
  assert.equal((await get(MAIN)).body.syncedAt, was.syncedAt, "a quick look isn't a full one");
  // A chat or task saved: memory works out its facts over minutes, so a quick look in 3 and a full one in 12.
  MC.nudge(MAIN, "saved");
  assert.deepEqual(timersOf("bops"), ["saved-later", "saved-soon"]);
  assert.deepEqual([delayOf("bops", "saved-soon") ?? 180_000, delayOf("bops", "saved-later") ?? 720_000], [180_000, 720_000]);
  clearTimers("bops");
});

/* ---------------- Gone from memory ---------------- */

await section("Facts gone from memory: their items go, unless the user changed them", async () => {
  const ws = "ws_drop";
  const bank = Mem.bankOf(ws);
  const F = seed(
    ws,
    [
      ["d1", 10, "Tiger chose Postgres for the new app.", [item("decisions", "Postgres for the new app", { key: "postgres new app" })]],
      ["d2", 20, "Tiger likes window seats on trains.", [item("preferences", "Window seats on trains", { key: "window seats trains" })]],
      ["d3", 30, "Tiger has to call the plumber.", [item("todos", "Call the plumber", { key: "call plumber" })]],
      ["d4", 40, "Tiger met Omar Haddad from Zenith at the conference.", [item("people", "Omar Haddad", { key: "omar haddad", detail: "Met at the conference" }), item("companies", "Zenith", { key: "zenith" })]],
      ["d5", 50, "Zenith is Tiger's biggest customer.", [item("companies", "Zenith", { key: "zenith", detail: "Your biggest customer" })]],
    ],
    { cards: [["Tiger's dentist is Dr. Kim.", [item("people", "Dr. Kim", { key: "dr. kim", detail: "Your dentist" })]]] },
  );
  let r = await refresh(ws);
  assert.equal(r.items.length, 6);
  const pref = one(r.items, "preferences", "Window seats on trains");
  const todo = one(r.items, "todos", "Call the plumber");
  assert.equal((await post({ action: "edit", ws, id: pref.id, title: "Window seat" })).status, 200);
  assert.equal((await post({ action: "edit", ws, id: todo.id, done: true })).status, 200);
  // Memory drops four facts (deleted elsewhere, or out of date), and a card line is taken off.
  for (const f of [F.d1, F.d2, F.d3, F.d4]) removeFact(bank, f.id);
  await Mem.forgetFact(ws, "card:Tiger's dentist is Dr. Kim.");
  assert.deepEqual(hbank(bank).cards.get("user"), []);
  const n = openai.calls.length;
  r = await refresh(ws);
  assert.equal(openai.calls.length, n, "nothing new to sort");
  assert.deepEqual(r.items.map((i) => `${i.category}: ${i.title}`).sort(), ["companies: Zenith", "preferences: Window seat", "todos: Call the plumber"], "the untouched ones went");
  assert.deepEqual(one(r.items, "companies", "Zenith").sources.map((s) => s.fact), [F.d5.id], "a company learned from two facts keeps the one left");
  assert.deepEqual(pick(one(r.items, "preferences", "Window seat"), ["sources", "edited"]), { sources: [], edited: true }, "renamed: kept");
  assert.deepEqual(pick(one(r.items, "todos", "Call the plumber"), ["sources", "done", "marked"]), { sources: [], done: true, marked: true }, "marked done: kept");
  assert.deepEqual(Object.keys(indexOf(bank).facts), [F.d5.id]);
});

/* ---------------- The user's changes ---------------- */

await section("The user's changes: rename, done, hide, and they stay through later mentions", async () => {
  const ws = "ws_edit";
  const bank = Mem.bankOf(ws);
  seed(ws, [
    [
      "e1",
      30,
      "Tiger works with Nadia Costa at Lumen.",
      [item("people", "Nadia Costa", { key: "nadia costa", detail: "Works with you at Lumen" }), item("companies", "Lumen", { key: "lumen", detail: "Where you work \u2014 the Berlin office" })],
    ],
    ["e2", 20, "Tiger needs to book the venue for the offsite.", [item("todos", "Book the venue for the offsite", { key: "book venue offsite" })]],
    ["e3", 10, "Tiger is working on Atlas, the new onboarding flow.", [item("projects", "Atlas", { key: "atlas", detail: "The new onboarding flow" })]],
  ]);
  let r = await refresh(ws);
  const nadia = one(r.items, "people", "Nadia Costa");
  const venue = one(r.items, "todos", "Book the venue for the offsite");
  const atlas = one(r.items, "projects", "Atlas");
  // Rename.
  let e = await post({ action: "edit", ws, id: nadia.id, title: "Nadia K" });
  assert.equal(e.status, 200);
  assert.deepEqual(pick(one(e.body.items, "people", "Nadia K"), ["detail", "edited"]), { detail: "Works with you at Lumen", edited: true });
  // Done.
  e = await post({ action: "edit", ws, id: venue.id, done: true });
  assert.deepEqual(pick(one(e.body.items, "todos", venue.title), ["done", "marked"]), { done: true, marked: true });
  // Hidden: not shown.
  e = await post({ action: "edit", ws, id: atlas.id, hidden: true });
  assert.ok(!e.body.items.some((i) => i.id === atlas.id), "hidden");
  // Later mentions of all three.
  newFact(ws, "Nadia Costa moved to the design team.", [item("people", "Nadia Costa", { key: "nadia costa", detail: "On the design team" })]);
  newFact(ws, "Tiger still has to book the venue for the offsite.", [item("todos", "Book the venue for the offsite", { key: "book venue offsite", done: false })]);
  newFact(ws, "Atlas launches next week.", [item("projects", "Atlas", { key: "atlas", detail: "Launches next week" })]);
  const n = openai.calls.length;
  r = await refresh(ws);
  assert.ok(openai.calls[n].input.known.people.some((k) => k.title === "Nadia K" && k.key === "nadia costa"), "the model is told the new name and the key it goes by");
  const n2 = one(r.items, "people", "Nadia K");
  assert.deepEqual(pick(n2, ["detail", "edited"]), { detail: "Works with you at Lumen", edited: true }, "the name and line the user gave stay");
  assert.equal(n2.sources.length, 2, "the new mention is one more source");
  assert.ok(!r.items.some((i) => i.title === "Nadia Costa"), "not made again under the old name");
  assert.deepEqual(pick(one(r.items, "todos", venue.title), ["done", "marked"]), { done: true, marked: true }, "still done: the user said so");
  assert.equal(one(r.items, "todos", venue.title).sources.length, 2);
  assert.ok(!r.items.some((i) => i.category === "projects"), "still hidden, not made again");
  assert.deepEqual(
    Object.values(indexOf(bank).items)
      .filter((i) => i.category === "projects")
      .map((i) => [i.id, i.hidden, i.sources.length]),
    [[atlas.id, true, 2]],
  );
  // Shown again; not done after all.
  e = await post({ action: "edit", ws, id: atlas.id, hidden: false });
  assert.equal(one(e.body.items, "projects", "Atlas").sources.length, 2);
  e = await post({ action: "edit", ws, id: venue.id, done: false });
  assert.deepEqual(pick(one(e.body.items, "todos", venue.title), ["done", "marked"]), { done: undefined, marked: true });
  // What can't be done, in plain words; nothing changed by it.
  for (const [body, error] of [
    [{ action: "edit", ws, id: "nope", title: "X" }, "That's gone already."],
    [{ action: "edit", ws, title: "X" }, "That's gone already."],
    [{ action: "edit", ws, id: nadia.id, title: "   " }, "Give it a name."],
    [{ action: "sort-everything", ws }, "Unknown action."],
    ["{not json", "Unknown action."],
  ]) {
    const x = await post(body);
    assert.deepEqual([x.status, x.body], [400, { error }], JSON.stringify(body));
  }
  assert.equal(one((await get(ws)).body.items, "people", "Nadia K").title, "Nadia K");
  // A dash in what the user types, and in what the model says, is taken out.
  e = await post({ action: "edit", ws, id: nadia.id, detail: "Design lead \u2014 Lisbon office" });
  const typed = one(e.body.items, "people", "Nadia K").detail;
  const said = one(e.body.items, "companies", "Lumen").detail;
  noDashes(typed);
  noDashes(said);
  await check("A dash taken out leaves a plain comma, not a space before it (clip() makes 'Design lead , Lisbon office')", () => {
    assert.deepEqual([typed, said], ["Design lead, Lisbon office", "Where you work, the Berlin office"], `got ${JSON.stringify([typed, said])}`);
  });
});

/* ---------------- Forget ---------------- */

await section("Forgetting an item: memory forgets what was only about it, and it doesn't come back", async () => {
  const ws = "ws_forget";
  const bank = Mem.bankOf(ws);
  const F = seed(
    ws,
    [
      [
        "g1",
        40,
        "Tiger has lunch with Priya Nair and Tom Berg from Orbit on Thursday.",
        [
          item("events", "Lunch with Priya and Tom", { key: "lunch priya tom 2026-10-15", when: "2026-10-15T12:30", who: "Priya Nair, Tom Berg" }),
          item("people", "Priya Nair", { key: "priya nair", detail: "Your investor" }),
          item("people", "Tom Berg", { key: "tom berg", detail: "From Orbit" }),
          item("companies", "Orbit", { key: "orbit" }),
        ],
      ],
      ["g2", 30, "Priya Nair is Tiger's investor.", [item("people", "Priya Nair", { key: "priya nair", detail: "Your investor" })]],
      ["g3", 20, "Priya Nair's daughter is called Mila.", [item("people", "Priya Nair", { key: "priya nair" })]],
    ],
    {
      cards: [
        ["Tiger's investor is Priya Nair.", [item("people", "Priya Nair", { key: "priya nair", detail: "Your investor" })]],
        ["Tiger's lawyer is Ben Ode.", [item("people", "Ben Ode", { key: "ben ode", detail: "Your lawyer" })]],
      ],
    },
  );
  let r = await refresh(ws);
  const priya = one(r.items, "people", "Priya Nair");
  assert.deepEqual(priya.sources.map((s) => s.fact).sort(), [F.g1.id, F.g2.id, F.g3.id, "card:Tiger's investor is Priya Nair."].sort());
  const h = honcho.calls.length;
  const f = await post({ action: "forget", ws, id: priya.id });
  assert.equal(f.status, 200);
  const calls = honcho.calls.slice(h);
  assert.deepEqual(
    calls.filter((c) => c.method === "DELETE").map((c) => c.path).sort(),
    [F.g2.id, F.g3.id].map((id) => `/v3/workspaces/${bank}/conclusions/${id}`).sort(),
    "the facts only about her are deleted in memory",
  );
  assert.deepEqual(calls.filter((c) => c.method === "PUT").map((c) => c.body), [{ peer_card: ["Tiger's lawyer is Ben Ode."] }], "and her card line");
  assert.deepEqual(factIds(bank), [F.g1.id], "the lunch, about others too, stays in memory");
  assert.ok(!f.body.items.some((i) => i.id === priya.id));
  for (const t of ["Lunch with Priya and Tom", "Tom Berg", "Orbit", "Ben Ode"]) assert.ok(f.body.items.some((i) => i.title === t), `${t} stays`);
  assert.deepEqual(one(f.body.items, "events", "Lunch with Priya and Tom").sources.map((s) => s.fact), [F.g1.id]);
  const idx = indexOf(bank);
  assert.ok(idx.forgotten["people:priya nair"] > 0, "forgotten, with when");
  assert.ok(!idx.facts[F.g1.id].items.includes(priya.id));
  // The next look doesn't bring her back from what's left.
  const n = openai.calls.length;
  r = await refresh(ws);
  assert.equal(openai.calls.length, n, "nothing new to sort");
  assert.ok(!r.items.some((i) => i.title === "Priya Nair"));
  // An item from a card line alone: the line comes off the card.
  assert.equal((await post({ action: "forget", ws, id: one(r.items, "people", "Ben Ode").id })).status, 200);
  assert.deepEqual(hbank(bank).cards.get("user"), []);
  // One that isn't there: nothing happens.
  const h2 = honcho.calls.length;
  assert.equal((await post({ action: "forget", ws, id: "nope" })).status, 200);
  assert.equal(honcho.calls.length, h2);

  await check("Forgetting someone mentioned more than 12 times forgets every fact only about them (forgetItem goes by item.sources, cut at 12)", async () => {
    const many = Mem.bankOf("ws_many");
    for (let k = 0; k < 14; k++) {
      const text = `Mia Lund called Tiger about bakery order ${k}.`;
      SORTS.set(text, [item("people", "Mia Lund", { key: "mia lund", detail: "Your supplier" })]);
      addFact(many, text, { at: Date.now() - (k + 1) * 60_000 });
    }
    const mia = one((await refresh("ws_many")).items, "people", "Mia Lund");
    assert.equal((await post({ action: "forget", ws: "ws_many", id: mia.id })).status, 200);
    assert.equal(factIds(many).length, 0, `every fact about her forgotten in memory (${factIds(many).length} of 14 left)`);
  });
  await check("Forgetting while memory can't delete says so, and keeps the item (forgetItem swallows the failure)", async () => {
    const ff = Mem.bankOf("ws_forgetfail");
    seed("ws_forgetfail", [["h1", 10, "Tiger's neighbor Noor waters the plants.", [item("people", "Noor", { key: "noor", detail: "Your neighbor" })]]]);
    const noor = one((await refresh("ws_forgetfail")).items, "people", "Noor");
    honcho.fail = (c) => (c.method === "DELETE" ? json({ detail: "Internal Server Error" }, 500) : null);
    const x = await post({ action: "forget", ws: "ws_forgetfail", id: noor.id }, { quiet: true });
    honcho.fail = null;
    assert.equal(factIds(ff).length, 1, "the fact is still in memory (the fake refused)");
    assert.ok(x.status !== 200 || x.body.error, `the user is told it didn't work (got ${x.status})`);
    assert.ok((await get("ws_forgetfail")).body.items.some((i) => i.id === noor.id), "and Noor is still listed");
  });
});

/* ---------------- What goes wrong ---------------- */

await section("When things go wrong: the model, memory, a damaged file", async () => {
  // The model fails: the facts wait, unsorted, with a line saying so; the next look sorts them.
  const ws = "ws_fail";
  const bank = Mem.bankOf(ws);
  const F = seed(ws, [
    ["j1", 20, "Tiger's coach Ines trains him on Tuesdays.", [item("people", "Ines", { key: "ines", detail: "Your coach" })]],
    ["j2", 10, "Tiger asked what time it was.", []],
  ]);
  openai.fail = () => json({ error: { message: "The model is busy.", type: "invalid_request_error" } }, 400);
  let r = await refresh(ws);
  assert.deepEqual([r.items, r.error], [[], "Some new things couldn't be sorted. They're tried again next time."]);
  assert.deepEqual(indexOf(bank).facts, {}, "nothing marked sorted");
  assert.ok(warned.some((w) => w.startsWith("[categories] sort: ")), "said in the log");
  // An answer that isn't JSON: the same.
  openai.fail = () => json(response("Sorry, I can't help with that."));
  r = await refresh(ws);
  assert.deepEqual([r.items, r.error], [[], "Some new things couldn't be sorted. They're tried again next time."]);
  openai.fail = null;
  r = await refresh(ws);
  one(r.items, "people", "Ines");
  assert.equal(r.error, undefined, "the line goes once they're sorted");
  assert.deepEqual(Object.keys(indexOf(bank).facts).sort(), [F.j1.id, F.j2.id].sort());

  // Memory can't be reached: a line saying so, gone after the next look that works.
  const down = Mem.bankOf("ws_down");
  seed("ws_down", [["k1", 10, "Tiger's gym is Atlas Fitness.", [item("companies", "Atlas Fitness", { key: "atlas fitness", detail: "Your gym" })]]]);
  honcho.fail = (c) => (c.path === `/v3/workspaces/${down}/conclusions/list` ? json({ detail: "Service Unavailable" }, 503) : null);
  r = await refresh("ws_down");
  assert.deepEqual([r.items, r.error], [[], "Couldn't reach memory just now. It tries again on its own."]);
  // Never sorted yet, so asking for the categories starts another look: it fails too, and the error stays.
  await until(() => !liveBank(down)?.running, "the look the window started to end");
  assert.equal((await get("ws_down")).body.error, "Couldn't reach memory just now. It tries again on its own.");
  await until(() => !liveBank(down)?.running, "the look the window started to end");
  honcho.fail = null;
  r = await refresh("ws_down");
  one(r.items, "companies", "Atlas Fitness");
  assert.equal(r.error, undefined);

  // A damaged file starts over: everything is sorted again (and the file is whole after).
  const damaged = Mem.bankOf("ws_damaged");
  writeFileSync(fileFor(damaged), '{"v":1,"bank":"bops-ws_damaged","facts":{"c1":');
  seed("ws_damaged", [["l1", 10, "Tiger's landlord is Victor Hale.", [item("people", "Victor Hale", { key: "victor hale", detail: "Your landlord" })]]]);
  await get("ws_damaged");
  assert.ok(warned.some((w) => w.startsWith(`[categories] ${damaged}: unreadable index, starting over`)), "said in the log");
  one((await settled("ws_damaged")).items, "people", "Victor Hale");
  assert.equal(indexOf(damaged).v, 1);
  // One from another version starts over too.
  writeFileSync(fileFor(Mem.bankOf("ws_oldshape")), JSON.stringify({ v: 2, bank: "bops-ws_oldshape", facts: { x: { items: ["i"], at: 1 } }, items: {} }));
  seed("ws_oldshape", [["o1", 10, "Tiger's vet is Dr. Moreau.", [item("people", "Dr. Moreau", { key: "dr. moreau", detail: "Your vet" })]]]);
  one((await refresh("ws_oldshape")).items, "people", "Dr. Moreau");
  assert.equal(indexOf(Mem.bankOf("ws_oldshape")).facts.x, undefined);
});

/* ---------------- A big memory ---------------- */

await section("A big memory: 150 facts a run, 25 a call, the rest counted as behind", async () => {
  const ws = "ws_big";
  const bank = Mem.bankOf(ws);
  const base = Date.now() - 86_400_000;
  const texts = [];
  for (let k = 0; k < 330; k++) {
    const text = `Tiger's rule ${k}: answer email ${k} within a day.`;
    texts.push(text);
    SORTS.set(text, [item("preferences", `Rule ${k}`, { key: `rule ${k}` })]);
    addFact(bank, text, { at: base - k * 60_000 });
  }
  const n = openai.calls.length;
  const h = honcho.calls.length;
  let r = await refresh(ws);
  const runs = openai.calls.slice(n);
  assert.deepEqual(runs.map((c) => c.input.facts.length), [25, 25, 25, 25, 25, 25], "150 this run, 25 a call");
  assert.deepEqual(runs.flatMap((c) => c.texts), texts.slice(0, 150), "the newest first");
  for (const c of runs) assert.ok((c.input.known.preferences ?? []).length <= 30, "what's known is cut short");
  assert.deepEqual(
    honcho.calls.slice(h).filter((c) => c.path === `/v3/workspaces/${bank}/conclusions/list`).map((c) => [c.query.page, c.query.size]),
    [["1", "100"], ["2", "100"], ["3", "100"], ["4", "100"]],
    "every page read",
  );
  assert.equal(r.items.length, 150);
  assert.equal(r.behind, 180);
  assert.ok(timersOf(bank).includes("behind"), "the next run set for soon");
  assert.equal(delayOf(bank, "behind") ?? 60_000, 60_000);

  await check("A quick look (after a fact is saved) keeps the count of what's behind", async () => {
    await MC.sync(ws, { quick: true });
    const behind = (await get(ws)).body.behind;
    assert.equal(behind, 180, `180 still behind (the snapshot says ${behind})`);
  });
  r = await refresh(ws);
  assert.deepEqual([r.items.length, r.behind], [300, 30]);
  r = await refresh(ws);
  assert.deepEqual([r.items.length, r.behind], [330, undefined]);
  const all = openai.calls.slice(n).flatMap((c) => c.texts);
  assert.deepEqual([all.length, new Set(all).size], [330, 330], "each fact sent to the model once");
  clearTimers(bank);

  await check("Past 1,500 facts, one learned at the same moment as the oldest read isn't taken for deleted (f.at >= oldest)", async () => {
    const wb = Mem.bankOf("ws_window");
    const T0 = Date.now() - 7 * 86_400_000;
    const sven = addFact(wb, "Tiger's old friend Sven lives in Oslo.", { at: T0 });
    SORTS.set(sven.text, [item("people", "Sven", { key: "sven", detail: "Your old friend" })]);
    one((await refresh("ws_window")).items, "people", "Sven");
    // 1,500 newer facts, the oldest of them learned at the same moment as Sven's (and listed before it).
    for (let k = 0; k < 1500; k++) {
      const text = `Note ${k} about the weekly report.`;
      SORTS.set(text, []);
      addFact(wb, text, { at: T0 + k * 1000 });
    }
    const after = await refresh("ws_window");
    clearTimers(wb);
    assert.ok(after.items.some((i) => i.title === "Sven"), "Sven is still there (his fact is in memory, past what a look reads)");
  });
});

/* ---------------- Another account mid-look ---------------- */

await section("Another account signing in mid-look: nothing of the last one's is written", async () => {
  const ws = "ws_switch";
  const bank = Mem.bankOf(ws);
  seed(ws, [["s1", 20, "Tiger's piano teacher is Clara Moss.", [item("people", "Clara Moss", { key: "clara moss", detail: "Your piano teacher" })]]]);
  one((await refresh(ws)).items, "people", "Clara Moss");
  newFact(ws, "Tiger's barber is Felix.", [item("people", "Felix", { key: "felix", detail: "Your barber" })]);
  const before = readFileSync(fileFor(bank), "utf8");
  openai.hold = () => true;
  const pending = post({ action: "refresh", ws });
  await until(() => openai.held.length === 1, "the look to reach the model");
  await S.bindSignIn("u_lee");
  assert.equal(MC.categoriesOn(), false, "a fresh state: nobody's account");
  releaseOpenai();
  assert.equal((await pending).status, 200);
  await until(() => !liveBank(bank)?.running, "the look to end");
  assert.equal(readFileSync(fileFor(bank), "utf8"), before, "the index wasn't written");
  assert.ok(!existsSync(join(work, ".data", "users", "u_lee", "memory-categories")), "nothing in the new account's folder");
  assert.ok(!(S.getState().usage ?? []).some((u) => u.source === "memory"), "the model call isn't counted for the new account");
  assert.deepEqual(timersOf(bank), [], "nothing set for later");
  await S.releaseSignOut();
  assert.equal(S.getState().account?.user.email, "maya@orgo.ai");
  assert.equal(MC.categoriesOn(), true);
  one((await refresh(ws)).items, "people", "Felix");

  await check("Another account signing in while an item is forgotten: nothing written to its folder (forgetItem saves without sameState)", async () => {
    honcho.hold = (c) => c.method === "DELETE";
    const forgetting = post({ action: "forget", ws, id: one((await get(ws)).body.items, "people", "Clara Moss").id });
    await until(() => honcho.held.length === 1, "the forget to reach memory");
    await S.bindSignIn("u_kai");
    releaseHoncho();
    await forgetting;
    const leaked = join(work, ".data", "users", "u_kai", "memory-categories");
    const found = existsSync(leaked) ? readdirSync(leaked) : [];
    await S.releaseSignOut();
    assert.deepEqual(found, [], `written in the new account's folder: ${found.join(", ")}`);
  });
  await check("Another account signing in while memory tidies up: nothing written to its folder (tidyUp saves without sameState)", async () => {
    honcho.hold = (c) => c.path.endsWith("/schedule_dream");
    const tidying = post({ action: "tidy-up", ws }, { quiet: true });
    await until(() => honcho.held.length === 1, "the tidy-up to reach memory");
    await S.bindSignIn("u_ivy");
    releaseHoncho();
    await tidying;
    clearTimers(bank);
    const leaked = join(work, ".data", "users", "u_ivy", "memory-categories");
    const found = existsSync(leaked) ? readdirSync(leaked) : [];
    await S.releaseSignOut();
    assert.deepEqual(found, [], `written in the new account's folder: ${found.join(", ")}`);
  });
});

/* ---------------- Tidying up ---------------- */

await section("Tidying up memory: asked of Honcho, at most once an hour", async () => {
  const ws = "ws_tidy";
  const bank = Mem.bankOf(ws);
  await refresh(ws);
  const h = honcho.calls.length;
  let r = await post({ action: "tidy-up", ws });
  assert.equal(r.status, 200);
  assert.deepEqual(
    honcho.calls.slice(h).filter((c) => c.path.endsWith("/schedule_dream")).map((c) => [c.method, c.path, c.body]),
    [["POST", `/v3/workspaces/${bank}/schedule_dream`, { observer: "user", observed: "user", dream_type: "omni" }]],
    "Honcho is asked to dream about the user, as the user",
  );
  assert.ok(Math.abs(r.body.dreamAt - Date.now()) < 5000);
  assert.equal(r.body.dreamReadyAt, r.body.dreamAt + 3_600_000);
  assert.deepEqual(timersOf(bank), ["dream-later", "dream-soon"], "looks set for when its results come in");
  assert.deepEqual([delayOf(bank, "dream-soon") ?? 240_000, delayOf(bank, "dream-later") ?? 900_000], [240_000, 900_000]);
  r = await post({ action: "tidy-up", ws });
  assert.deepEqual([r.status, r.body], [400, { error: "Memory tidied up a little while ago. Try again in 60 minutes." }]);
  skew += 59.5 * 60_000;
  r = await post({ action: "tidy-up", ws });
  assert.deepEqual([r.status, r.body], [400, { error: "Memory tidied up a little while ago. Try again in 1 minute." }]);
  assert.equal(hbank(bank).dreams.length, 1, "refused without asking Honcho");
  skew += 60_000;
  r = await post({ action: "tidy-up", ws });
  assert.equal(r.status, 200, "an hour later, again");
  assert.equal(hbank(bank).dreams.length, 2);
  await settled(ws);
  clearTimers(bank);

  // Memory can't do it: an error, and it can be asked again.
  const b3 = Mem.bankOf("ws_tidy3");
  await refresh("ws_tidy3");
  honcho.fail = (c) => (c.path.endsWith("/schedule_dream") ? json({ detail: "Dreamer unavailable \u2014 queue full" }, 500) : null);
  const failed = await post({ action: "tidy-up", ws: "ws_tidy3" }, { quiet: true });
  honcho.fail = null;
  assert.equal(failed.status, 400);
  assert.equal((await get("ws_tidy3")).body.dreamAt, undefined, "not counted as done");
  assert.deepEqual([hbank(b3).dreams.length, timersOf(b3)], [0, []]);
  await check("A tidy-up memory can't do says so in plain words, not Honcho's own (tidyUp passes its error through)", () => {
    noDashes(failed.body.error);
    assert.ok(!failed.body.error.includes("Dreamer"), `not Honcho's own words: ${failed.body.error}`);
  });
  await check("Two tidy-ups at once make one request to Honcho (tidyUp notes the time only after Honcho answers)", async () => {
    const b2 = Mem.bankOf("ws_tidy2");
    await refresh("ws_tidy2");
    honcho.hold = (c) => c.path.endsWith("/schedule_dream");
    const done = [];
    const asks = [0, 1].map(() => post({ action: "tidy-up", ws: "ws_tidy2" }).then((x) => (done.push(x), x)));
    await until(() => honcho.held.length >= 2 || (honcho.held.length === 1 && done.length === 1), "both asks to arrive");
    releaseHoncho();
    const res = await Promise.all(asks);
    await settled("ws_tidy2");
    clearTimers(b2);
    assert.equal(hbank(b2).dreams.length, 1, `one request to Honcho, not ${hbank(b2).dreams.length}`);
    assert.deepEqual(res.map((x) => x.status).sort(), [200, 400]);
  });
});

/* ---------------- Dates ---------------- */

await section("Dates: the user's own day", async () => {
  await check("'today' and the day a fact was learned are this Mac's day, not UTC's (isoDay uses toISOString)", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      // The next 03:30 UTC: 19:30 or 20:30 the day before in California.
      const now = Date.now();
      const d = new Date(now);
      let target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 30);
      if (target <= now) target += 86_400_000;
      skew += target - now;
      const pad = (x) => String(x).padStart(2, "0");
      const local = (ms) => {
        const x = new Date(ms);
        return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
      };
      const f = newFact("ws_tz", "Tiger has a call with Lena tomorrow at 9am.", [item("events", "Call with Lena", { key: "call with lena" })]);
      f.at = Date.now() - 60_000;
      const n = openai.calls.length;
      await refresh("ws_tz");
      const ask = openai.calls[n];
      assert.equal(ask.input.today, local(Date.now()), `today, as the user sees it (${local(Date.now())}), not ${ask.input.today}`);
      assert.equal(ask.input.facts[0].learned, local(f.at), `the day the fact was learned, as the user saw it (${local(f.at)}), not ${ask.input.facts[0].learned}`);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

/* ---------------- The shared helpers ---------------- */

await section("The shared helpers: what's coming up, and dates in words", async () => {
  const now = new Date(2026, 9, 12, 9, 0);
  assert.equal(Cat.upcoming({ when: "2026-10-12" }, now), true, "today counts");
  assert.equal(Cat.upcoming({ when: "2026-10-12T08:00" }, now), true, "earlier today still counts");
  assert.equal(Cat.upcoming({ when: "2026-10-11" }, now), false);
  assert.equal(Cat.upcoming({}, now), false);
  const day = Cat.whenLabel("2026-10-17", now);
  assert.match(day, /17/);
  assert.ok(!/2026/.test(day), "no year this year");
  assert.match(Cat.whenLabel("2027-01-05", now), /2027/);
  assert.ok(Cat.whenLabel("2026-10-17T15:00", now).startsWith(`${day}, `), "with a time");
  assert.equal(Cat.whenLabel("soon", now), "soon");
  for (const label of [day, Cat.whenLabel("2026-10-17T15:00", now), Cat.whenLabel("2027-01-05", now)]) noDashes(label);
});

/* ---------------- Plain words ---------------- */

await section("Plain words: no dashes in anything the user reads", async () => {
  for (const c of Cat.CATEGORIES) for (const line of [c.label, c.one, c.about, c.empty]) noDashes(line);
  for (const line of spoken) noDashes(line);
  // Every line the engine and the route can show, the ones no test reaches too (out of AI credit is the cloud's
  // alone): nothing in their source has a dash, but clip()'s pattern that takes dashes out.
  for (const file of ["lib/server/memory-categories.ts", "app/api/memory/categories/route.ts", "lib/memory-categories.ts"])
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((line, n) => {
        if (/[\u2013\u2014]/.test(line) && !/\.replace\(\/[^/]*[\u2013\u2014][^/]*\/[gimsuy]*,/.test(line)) assert.fail(`${file}:${n + 1} has a dash: ${line.trim()}`);
      });
  assert.ok(spoken.length > 100, `heard plenty (${spoken.length})`);
});

await section("Nothing unexpected: no stray warnings, network calls, unknown requests or rejections", async () => {
  const expected = [/^\[categories\] sort: /, /^\[categories\] bops-ws_down: /, /^\[categories\] bops-ws_damaged: unreadable index, starting over/, /^\[categories\] forget /, /^\[categories\] tidy up: /];
  assert.deepEqual(
    warned.filter((w) => /^\[(categories|memory)\]/.test(w) && !expected.some((re) => re.test(w))),
    [],
  );
  assert.deepEqual(offline, [], "nothing else reached for");
  assert.deepEqual(honcho.unknown, [], "only the Honcho calls faked here");
  assert.deepEqual(openai.unknown, [], "every fact sent to the model is one this file knows");
  assert.deepEqual(openai.other, [], "no other model calls");
  assert.deepEqual(rejections, []);
});

/* ---------------- The results ---------------- */

const failed = results.filter((r) => !r.ok);
console.log(
  `\nMemory categories: ${results.length - failed.length} of ${results.length} parts passed` +
    ".",
);
if (failed.length) console.log(`The throwaway folder is kept for a look: ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
