// Tests for the categories that fill themselves from memory: the engine (lib/server/memory-categories.ts)
// and its route (app/api/memory/categories). Who has them (the gate); a first look at memory (the card's
// lines first, then the newest facts, sorted into People, Events, To-dos and the rest; one fact making
// several items; where and how each was learned; private lines; the file on this Mac); mentions merging,
// and what each mention may change; a look with nothing new costing nothing; new facts waiting to be
// sorted together (10 at a time, after 30 minutes, or at once when asked; what a chat taught at once); a fact saved now sorted within
// seconds; a big memory (the newest 300, 150 a look, Sort older for the rest); sweeps that check what was
// sorted with memory itself; facts gone from memory; the user's changes (rename, done, hide, forget) and
// what may bring a forgotten item back; an item worked out again from the facts left when one goes (and
// its lock); what's left to sort (behind, more, failures let go, kept rows); a new card line and a fact
// saved by hand sorted at once, Bops's own notes batched; tidying up; what goes wrong (the model down or
// answering unusably, memory, a damaged file, another account signing in mid-look); the window's polls
// (rev); and the route taking only an item's id. Every user-facing line is checked for dashes. Honcho is a fake answering the REST calls its SDK makes, OpenAI a fake
// /v1/responses that answers each fact from a table below, Jev isn't set up (privacy falls back to the
// patterns), the Keychain is a stand-in that's never there, and the state and files live in a throwaway
// folder: nothing reaches a real service or the user's own data.
//
// The named checks inside parts (check()) each hold to one rule, most of them a bug found while this was
// built. One that fails is reported by name and fails its part, and the rest of the part still runs.
// Not reached here: running out of AI credit, which only Bops Cloud can say (self-hosted, the app pays
// OpenAI on its own key, and OpenAI itself never answers 402).
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

// The engine's clock: moved forward by the parts that wait (30 minutes for new facts, an hour for a
// failing one, an hour between tidy-ups, a time of day). Only ever forward.
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
  // Conclusions: newest first, 100 a page at most, with the total, for one observer and observed; and by
  // id, as getMany asks (filters.id.in), the ones that aren't there left out.
  if (rest === "conclusions/list" && req.method === "POST") {
    const f = call.body?.filters ?? {};
    for (const k of Object.keys(f)) if (!["observer_id", "observed_id", "id"].includes(k)) honcho.unknown.push(`conclusions/list filter ${k}`);
    if (f.id !== undefined && !Array.isArray(f.id?.in)) honcho.unknown.push(`conclusions/list filter id ${JSON.stringify(f.id)}`);
    const ids = Array.isArray(f.id?.in) ? new Set(f.id.in) : null;
    const page = Number(call.query.page ?? 1);
    const size = Number(call.query.size ?? 50);
    if (size > 100) return json({ detail: "size can be 100 at most" }, 422);
    const all = b.facts
      .filter((x) => (!f.observer_id || x.observer === f.observer_id) && (!f.observed_id || x.observed === f.observed_id) && (!ids || ids.has(x.id)))
      .sort((x, y) => y.at - x.at || y.seq - x.seq);
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
// Each call (its body, its input parsed, the fact texts, the SDK's timeout and retry headers); `fail(call)`
// answers instead, `hold(call)` waits for releaseOpenai().
const openai = { calls: [], other: [], unknown: [], fail: null, hold: null, held: [] };
const response = (text) => ({
  id: `resp_${openai.calls.length}`,
  object: "response",
  model: "gpt-test",
  status: "completed",
  output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});
/** The model's answer, as given (for openai.fail): [{i, items}]. */
const answer = (facts) => json(response(JSON.stringify({ facts })));
/** The model refusing what it was given (422: the SDK doesn't try again; counted against the facts). */
const refused = (message = "The model is busy.") => json({ error: { message, type: "invalid_request_error" } }, 422);
/** A request the model rejects outright (400): a wrong setting refuses every call. */
const rejected = (message = "Unsupported parameter.") => json({ error: { message, type: "invalid_request_error" } }, 400);
/** OpenAI answering with an HTTP error; the SDK tries again at once when it does (429, 5xx). */
const httpError = (status, message = `Error ${status}`) => new Response(JSON.stringify({ error: { message, type: "api_error" } }), { status, headers: { "content-type": "application/json", "retry-after-ms": "0" } });
/** OpenAI overloaded (500). */
const overloaded = () => httpError(500, "Overloaded");
/** OpenAI not reachable at all (for openai.fail: thrown where fetch would, the SDK's connection error). */
const unreachable = () => new TypeError("fetch failed (connection refused)");
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
  const call = { body, input, texts: input.facts.map((f) => f.fact), headers: { timeout: req.headers.get("x-stainless-timeout"), retry: req.headers.get("x-stainless-retry-count") } };
  openai.calls.push(call);
  if (openai.hold?.(call)) await new Promise((r) => openai.held.push(r));
  const failed = openai.fail?.(call);
  if (failed instanceof Error) throw failed;
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
/** The window's poll: the categories, saying which version (rev) it has. */
const getRev = (ws, rev) => request(R.GET, "GET", `/api/memory/categories?ws=${encodeURIComponent(ws)}&rev=${encodeURIComponent(rev)}`);
/** The pages of a bank's memory read since `h` (not counting facts asked for by id). */
const pagesOf = (bank, h) => honcho.calls.slice(h).filter((c) => c.path === `/v3/workspaces/${bank}/conclusions/list` && !c.body?.filters?.id).map((c) => c.query.page);
/** How many facts (and card lines) a bank's index has sorted. */
const sortedIn = (bank) => Object.keys(indexOf(bank).facts).length;
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
/** Run a look set for later now, as its timer would (it won't run again later), and wait for it to end. */
async function fire(ws, why) {
  const bank = Mem.bankOf(ws);
  const t = liveBank(bank)?.timers.get(why);
  assert.ok(t, `a look set for later on ${bank} (${why}); there are: ${timersOf(bank).join(", ") || "none"}`);
  const run = t._onTimeout;
  clearTimeout(t);
  run.call(t);
  await until(() => !liveBank(bank).running, `the ${why} look on ${bank} to end`);
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
/** `count` facts in a bank that make no items ("<prefix> <k>."), a day old and a minute apart unless `at` says when. */
function many(bank, prefix, count, at = (k) => Date.now() - 86_400_000 - k * 60_000) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const text = `${prefix} ${k}.`;
    SORTS.set(text, []);
    out.push(addFact(bank, text, { at: at(k) }));
  }
  return out;
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

/* ---------------- The run: parts, and named checks inside them ---------------- */

const results = [];
/** The checks that failed in the part under way. */
let missed = [];
/**
 * A check inside a part, named for the rule it holds to (most were a bug found while building this). One
 * that fails is reported by name and fails the part, but the rest of the part still runs.
 */
async function check(what, fn) {
  try {
    await fn();
  } catch (e) {
    missed.push({ what, error: e });
  }
}
/** Whatever a part left behind (a failure injected, a call held, a look under way or set for later, another account signed in, the gate's settings) is undone after it. */
async function reset() {
  openai.fail = null;
  releaseOpenai();
  honcho.fail = null;
  releaseHoncho();
  const banks = () => [...(globalThis.bopsCategories?.banks.values() ?? [])];
  try {
    await until(() => banks().every((b) => !b.running), "every look to end", 10_000);
  } catch (e) {
    console.log(`       (after the part: ${e.message})`);
  }
  for (const b of banks()) {
    for (const t of b.timers.values()) clearTimeout(t);
    b.timers.clear();
  }
  if (S.stateUser()) await S.releaseSignOut();
  process.env.HONCHO_API_KEY = HONCHO_KEY;
  process.env.BOPS_SELF_HOSTED = "1";
  delete process.env.BOPS_DATABASE_URL;
  if (S.getState().account?.user.email !== "maya@orgo.ai") signInAs("maya@orgo.ai");
}
const shown = (e) => String(e?.stack ?? e).split("\n").slice(0, 6).join("\n         ");
async function section(name, fn) {
  missed = [];
  let stopped = null;
  try {
    await fn();
  } catch (e) {
    stopped = e;
  }
  await reset();
  const ok = !stopped && !missed.length;
  results.push({ name, ok, checks: missed.map((m) => m.what) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  for (const m of missed) console.log(`       check: ${m.what}\n         ${shown(m.error)}`);
  if (stopped) console.log(`       ${shown(stopped)}`);
}

// The state: Tiger, with Boppy and Max (Max has a chat), a task, and a workspace for each part below (each its own bank).
const MAIN = MAIN_WORKSPACE;
const MAX_CHAT = `bops-chat-${botChatId("max").replace(/[^A-Za-z0-9_-]/g, "-")}`;
const WORKSPACES = [
  ...["ws_done", "ws_i18n", "ws_drop", "ws_edit", "ws_forget", "ws_many", "ws_forgetfail", "ws_back", "ws_twice", "ws_gone", "ws_fail", "ws_down", "ws_damaged", "ws_oldshape"],
  ...["ws_big", "ws_window", "ws_scan", "ws_switch", "ws_tidy", "ws_tidy2", "ws_tidy3", "ws_tidy4", "ws_tz", "ws_budget", "ws_retry", "ws_split", "ws_range", "ws_more", "ws_serial"],
  ...["ws_hide", "ws_card", "ws_card2", "ws_older", "ws_names", "ws_keys", "ws_ranges", "ws_known", "ws_ids"],
  ...["ws_outage", "ws_lock", "ws_oldidx", "ws_behind", "ws_more2", "ws_more3", "ws_prune", "ws_rows", "ws_cardnow", "ws_wait2", "ws_learn", "ws_rev", "ws_setting"],
  ...["ws_you", "ws_chat", "ws_add"],
];
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

await section("The gate: every account signed in, memory set up, on this Mac", async () => {
  for (const email of ["maya@orgo.ai", "maya@example.com", ""]) assert.equal(Cat.categoriesOpen({ account: { user: { id: "u", email } } }), true, `open to ${email || "an account with no email"}`);
  assert.equal(Cat.categoriesOpen({}), false, "signed out");

  const answered = [];
  const closed = async (who) => {
    assert.equal(MC.categoriesOn(), false, `off ${who}`);
    const g = await get(MAIN);
    assert.equal(g.status, 200, who);
    assert.deepEqual([g.body.ws, g.body.items, g.body.syncing], [MAIN, [], false], `the sidebar gets nothing ${who}`);
    answered.push([who, g.body.on]);
    for (const body of [{ action: "refresh" }, { action: "sort-older" }, { action: "tidy-up" }, { action: "edit", id: "x", title: "y" }, { action: "forget", id: "x" }, { action: "nope" }]) {
      const r = await post(body);
      assert.deepEqual([r.status, r.body], [404, { error: "Memory isn't set up." }], `${body.action} ${who}`);
    }
    MC.nudge(MAIN, "learned");
    MC.nudge(MAIN, "saved");
    await MC.sync(MAIN);
    await MC.refresh(MAIN);
    MC.dropFacts("bops", ["c1"]);
    await assert.rejects(MC.tidyUp(MAIN), { message: "Memory isn't set up." });
    assert.throws(() => MC.sortOlder(MAIN), { message: "Memory isn't set up." });
    assert.throws(() => MC.editItem(MAIN, "x", { title: "y" }), { message: "Memory isn't set up." });
    await assert.rejects(MC.forgetItem(MAIN, "x"), { message: "Memory isn't set up." });
    assert.equal(liveBank("bops"), undefined, `nothing started or set for later ${who}`);
    assert.deepEqual([honcho.calls.length, openai.calls.length], [0, 0], `nothing asked of memory or the model ${who}`);
    assert.ok(!existsSync(join(work, ".data", "memory-categories")), `nothing written ${who}`);
  };
  signInAs(null);
  await closed("signed out");
  signInAs("sam@example.com");
  assert.equal(MC.categoriesOn(), true, "on for an account outside Orgo too");
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
await section("A first look at memory: the card first, then the newest facts, sorted into the categories", async () => {
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

  // One model call for the 13 new facts (25 a call), asking for JSON in the categories' shape: the card's
  // lines first (who Tiger is, their people), then the newest facts.
  assert.equal(openai.calls.length, 1, "one model call");
  const ask = openai.calls[0];
  assert.equal(ask.body.model, "gpt-test-memory", "BOPS_MEMORY_MODEL");
  assert.deepEqual(ask.body.reasoning, { effort: "low" });
  assert.equal(ask.body.store, false, "not kept at OpenAI");
  assert.equal(ask.headers.timeout, "90", "90 seconds at most");
  assert.deepEqual(pick(ask.body.text.format, ["type", "name", "strict"]), { type: "json_schema", name: "memory_items", strict: true });
  strictSchema(ask.body.text.format.schema);
  assert.deepEqual(ask.body.text.format.schema.properties.facts.items.properties.items.items.properties.category.enum, Cat.CATEGORY_IDS);
  assert.match(ask.body.instructions, /learned about Tiger into the categories/);
  assert.ok(ask.body.instructions.includes("their AI assistants (Boppy, Max)"), "the bots are named, so they're never items");
  for (const c of Cat.CATEGORIES) assert.ok(ask.body.instructions.includes(`- ${c.id}: ${c.about}`), `the model is told what ${c.id} is`);
  assert.match(ask.input.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(ask.input.facts.map((f) => f.i), [...Array(13).keys()]);
  assert.deepEqual(ask.texts, [...CARD, ...Object.values(F).map((f) => f.text)], "the card's lines first, then the newest facts");
  for (const f of ask.input.facts) assert.match(f.learned, /^\d{4}-\d{2}-\d{2}$/);
  // How each was learned: said in a chat; saved with no chat to point to (a task, by hand, the user's other
  // agents); worked out by memory; the card.
  assert.deepEqual(ask.input.facts.map((f) => f.how), [...CARD.map(() => "profile card"), "said", "saved", "saved", "saved", "saved", "saved", "saved", "saved", "worked out", "saved"]);
  assert.deepEqual(ask.input.known, {}, "nothing known yet");
  assert.equal(S.getState().usage.filter((u) => u.source === "memory").length, 1, "the model call is counted");

  // What came of it: one fact can make several items, mentions of the same thing merge.
  const items = snap.items;
  assert.equal(snap.error, undefined);
  assert.ok(snap.syncedAt >= started);
  assert.equal(snap.behind, undefined);
  assert.equal(snap.waiting, undefined, "the first look sorts at once");
  assert.deepEqual(
    items.map((i) => `${i.category}: ${i.title}`).sort(),
    [
      "companies: Acme Inc",
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
  const acme = one(items, "companies", "Acme Inc");
  const idx = indexOf(bank);
  assert.deepEqual([...idx.facts[F.f1.id].items].sort(), [meeting.id, dana.id, acme.id].sort(), "one fact, three items");
  assert.deepEqual(pick(meeting, ["key", "when", "who", "detail"]), { key: "events:meeting with dana 2026-10-16", when: "2026-10-16T15:00", who: "Dana Reyes", detail: "About the quote" });
  // Where each was learned: the fact, when, from what, and how.
  assert.deepEqual(dana.sources, [{ fact: F.f1.id, text: F.f1.text, at: F.f1.at, from: "Chat with Max", how: "said" }]);
  assert.deepEqual(pick(dana, ["key", "detail", "first", "last"]), { key: "people:dana reyes", detail: "Your contact at Acme", first: F.f1.at, last: F.f1.at });
  // Two facts about the same company (the older one says "Acme Inc"): one item, both sources, newest first,
  // the newer one's line and the fullest name from either.
  assert.deepEqual(pick(acme, ["key", "title", "detail"]), { key: "companies:acme", title: "Acme Inc", detail: "Your customer" });
  assert.deepEqual(acme.sources.map((s) => [s.fact, s.from, s.how]), [[F.f1.id, "Chat with Max", "said"], [F.f5.id, "Saved by hand", "saved"]]);
  // Ana: a card line, and two facts with her name in other case and accents. The card line is newest (it has
  // no date of its own) and says nothing about her: the newest fact's line fills that in, an older one doesn't change it.
  const ana = one(items, "people", "Ana");
  assert.equal(ana.key, "people:ana");
  assert.deepEqual(
    ana.sources.map((s) => [s.fact, s.from, s.how]),
    [["card:Sister: Ana", "Your card", "card"], [F.f2.id, "Task: Book the flight", "saved"], [F.f3.id, "Saved by hand", "saved"]],
  );
  assert.equal(ana.sources[0].text, "Sister: Ana");
  assert.ok(ana.sources[0].at >= started && ana.sources[0].at <= Date.now());
  assert.deepEqual([ana.first, ana.last], [F.f3.at, ana.sources[0].at]);
  assert.equal(ana.detail, "Your sister, lives in Lisbon", "the newest fact's line fills in what the card didn't say; an older one doesn't change it");
  // A card line on its own, and the source of what memory worked out rather than was told.
  assert.deepEqual(one(items, "people", "Priya Shah").sources.map((s) => pick(s, ["fact", "from", "how"])), [{ fact: "card:Tiger's accountant is Priya Shah.", from: "Your card", how: "card" }]);
  assert.deepEqual(pick(one(items, "preferences", "Aisle seats").sources[0], ["how", "from"]), { how: "figured", from: "Bops" });
  // A phone number is private: the line it came from, and an item learned only from it.
  const leo = one(items, "people", "Leo");
  assert.deepEqual([leo.private, leo.sources[0].private, leo.sources[0].from, leo.sources[0].how], [true, true, "Your other agents", "saved"]);
  for (const i of items.filter((x) => x !== leo)) assert.equal(i.private, undefined, `${i.title} isn't private`);
  // To-dos and promises: when they're due (a date the app can read, or none), who for.
  assert.deepEqual(pick(one(items, "todos", "Send the invoice to Acme"), ["when", "who", "done"]), { when: "2026-10-16", who: "Acme", done: undefined });
  assert.deepEqual(pick(one(items, "promises", "Dana sends the signed contract"), ["when", "who"]), { when: undefined, who: "Dana Reyes" }, "\"next Monday\" isn't a date");
  assert.deepEqual(pick(one(items, "projects", "Bops"), ["key", "detail"]), { key: "projects:bops", detail: "An app for teams of AI assistants" }, "\"Project Bops\" is Bops; no full stop");
  noDashes(one(items, "decisions", "Pro plan at 40 dollars a month").detail);
  // What each fact said about each item is kept with the fact (its name, line, date, who, done, how it was
  // learned, private), so an item can be worked out again when a fact goes.
  assert.deepEqual(idx.facts[F.f1.id].wrote, {
    [meeting.id]: { t: "Meeting with Dana", d: "About the quote", w: "2026-10-16T15:00", o: "Dana Reyes", h: "said", at: F.f1.at },
    [dana.id]: { t: "Dana Reyes", d: "Your contact at Acme", h: "said", at: F.f1.at },
    [acme.id]: { t: "Acme", d: "Your customer", h: "said", at: F.f1.at },
  });
  assert.deepEqual(idx.facts[F.f4.id].wrote, { [leo.id]: { t: "Leo", d: "Phone number on file", h: "saved", p: true, at: F.f4.at } }, "and that the fact was private");
  assert.deepEqual(idx.facts["card:Sister: Ana"].wrote, { [ana.id]: { t: "Ana", d: "", h: "card", at: ana.sources[0].at } });
  assert.deepEqual(idx.facts[F.f8.id].wrote[one(items, "decisions", "Pro plan at 40 dollars a month").id].d, "To cover costs, servers and support", "as the item shows it");
  // Small talk makes nothing, but it's marked sorted so it isn't sent again; so is a card line about Tiger.
  assert.deepEqual(idx.facts[F.f10.id], { items: [], at: F.f10.at, wrote: {} });
  assert.deepEqual(idx.facts["card:Tiger lives in Oakland."].items, []);
  assert.ok(items.every((i) => !Object.hasOwn(i, "detailPrivate")), "nothing kept only for the engine goes to the window");

  // The file: <userDir>/memory-categories/bops.json, the user's only.
  const dir = join(work, ".data", "memory-categories");
  assert.equal(mode(dir), 0o700, "the folder is the user's only");
  assert.equal(mode(fileFor("bops")), 0o600, "and so is the file");
  assert.deepEqual(readdirSync(dir), ["bops.json"], "no temp files left");
  assert.deepEqual(pick(idx, ["v", "bank", "forgotten", "error"]), { v: 1, bank: "bops", forgotten: {}, error: undefined });
  assert.equal(Object.keys(idx.facts).length, 13);
  assert.equal(Object.keys(idx.items).length, 11);
  assert.equal(idx.syncedAt, snap.syncedAt);
  // The first look reads the sorted depth and has nothing older to check: it counts as a sweep, so the next look doesn't read it all again.
  assert.ok(idx.sweptAt >= idx.triedAt, "the first look counts as a sweep");
  assert.ok(!honcho.calls.some((c) => c.path.endsWith("/conclusions/list") && c.body?.filters?.id), "with nothing asked for by id");

  // Asked without a workspace, or for one that isn't there: the one in use.
  assert.equal((await get()).body.items.length, 11);
  assert.equal((await get("ws_nope")).body.ws, MAIN);
});

/* ---------------- Nothing new ---------------- */

await section("A look with nothing new: no model call", async () => {
  const was = (await get(MAIN)).body;
  const n = openai.calls.length;
  const lists = honcho.calls.filter((c) => c.path.endsWith("/conclusions/list")).length;
  const asked = Date.now();
  const now = await refresh(MAIN);
  assert.equal(openai.calls.length, n, "nothing sent to the model");
  assert.equal(honcho.calls.filter((c) => c.path.endsWith("/conclusions/list")).length, lists + 1, "memory was read (that's free), and nothing had to be asked for by id");
  assert.ok(now.syncedAt >= was.syncedAt);
  assert.deepEqual(now.items, was.items);
  const swept = indexOf("bops").sweptAt;
  assert.ok(swept >= asked && swept <= now.syncedAt, `Refresh is a sweep (swept at ${swept}, asked at ${asked})`);
});

/* ---------------- Merging ---------------- */

await section("Mentions merging: a newer one updates the line, unless the user changed it", async () => {
  const F = first;
  // A newer mention of Ana: her line says how things stand now. The model is told what's known, with keys and lines.
  const m1 = newFact(MAIN, "Ana moved to Porto last month.", [item("people", "Ana", { key: "ana", detail: "Your sister, lives in Porto now" })]);
  let n = openai.calls.length;
  let r = await refresh(MAIN);
  const known = openai.calls[n].input.known;
  assert.ok(known.people.some((k) => k.title === "Ana" && k.key === "ana"), "Ana is known, with her key");
  assert.ok(known.people.some((k) => k.title === "Dana Reyes" && k.key === "dana reyes"));
  assert.deepEqual(known.events, [{ title: "Meeting with Dana", key: "meeting with dana 2026-10-16", detail: "About the quote", when: "2026-10-16T15:00" }]);
  assert.ok(known.preferences.some((k) => k.title === "Aisle seats"), "a small index (40 items or fewer) goes whole, even what the fact isn't about");
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
  // Saved with no chat to point to: "saved", not "said" (it may be a bot's words).
  assert.deepEqual(theo.sources.map((s) => pick(s, ["text", "from", "how"])), [{ text, from: "Saved by hand", how: "saved" }]);
  assert.deepEqual(openai.calls.slice(n).map((c) => c.texts), [[text]], "only the new fact went to the model, at once (one fact doesn't wait)");
  const looks = honcho.calls.slice(h);
  assert.deepEqual(looks.filter((c) => c.path.endsWith("/conclusions/list")).map((c) => c.query), [{ page: "1", size: "100" }], "a quick look reads the newest page");
  assert.ok(!looks.some((c) => c.method === "GET" && c.path.endsWith("/card")), "and not the card");
  assert.equal((await get(MAIN)).body.syncedAt, was.syncedAt, "a quick look isn't a full one");
  // A chat or task saved: memory works out its facts over the next minutes, so quick looks in 4 and 10
  // that sort what they find at once; the next message saved doesn't set them again or push them back.
  MC.nudge(MAIN, "chat");
  assert.deepEqual(timersOf("bops"), ["chat", "chat-late"]);
  assert.deepEqual([delayOf("bops", "chat"), delayOf("bops", "chat-late")], [240_000, 600_000]);
  const set = liveBank("bops").timers.get("chat");
  MC.nudge(MAIN, "chat");
  assert.equal(liveBank("bops").timers.get("chat"), set, "the same look, kept");
  clearTimers("bops");
  // Bops noted a fact on its own: one quick look in 3, which leaves it waiting for the next few (below).
  MC.nudge(MAIN, "saved");
  assert.deepEqual([timersOf("bops"), delayOf("bops", "saved")], [["saved"], 180_000]);
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
  // A fact corrected by hand (Fix, in a bot's Memory tab): out of the categories at once, and the
  // corrected one sorted within seconds.
  const fixed = "Zenith is Tiger's second biggest customer.";
  SORTS.set(fixed, [item("companies", "Zenith", { key: "zenith", detail: "Your second biggest customer" })]);
  await Mem.fixFact(ws, F.d5.id, fixed);
  await until(() => !Object.hasOwn(indexOf(bank).facts, F.d5.id) && timersOf(bank).includes("learned"), "the old fact dropped, and a quick look set");
  assert.ok(!Object.values(indexOf(bank).items).some((i) => i.title === "Zenith"), "Zenith went with it, before any look");
  await fire(ws, "learned");
  assert.deepEqual(pick(one((await get(ws)).body.items, "companies", "Zenith"), ["detail"]), { detail: "Your second biggest customer" });
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
    [{ action: "edit", ws, id: "0123456789", title: "X" }, "That's gone already."],
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

await section("Forgetting an item: memory forgets what was only about it, and only a chat brings it back", async () => {
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
  // An id that's an item's shape but no item's: nothing happens.
  const h2 = honcho.calls.length;
  assert.equal((await post({ action: "forget", ws, id: "0123456789" })).status, 200);
  assert.equal(honcho.calls.length, h2);

  await check("A forgotten item comes back only from something said in a chat after it was forgotten", async () => {
    const wb = "ws_back";
    const bb = Mem.bankOf(wb);
    const P = (detail = "Your investor") => [item("people", "Priya Nair", { key: "priya nair", detail })];
    seed(wb, [["p1", 10, "Tiger's investor Priya Nair joined the board.", P(), { session: MAX_CHAT }]]);
    const was = one((await refresh(wb)).items, "people", "Priya Nair");
    assert.equal((await post({ action: "forget", ws: wb, id: was.id })).status, 200);
    const at = indexOf(bb).forgotten["people:priya nair"];
    // Not from a card line memory wrote again, what memory worked out, a fact saved with no chat, or something said before.
    const line = "Tiger's investor is Priya Nair, from Orbit Capital.";
    SORTS.set(line, P());
    await Mem.pinFact(wb, line);
    const figured = newFact(wb, "Priya Nair probably invests in fintech.", P(), { level: "deductive", session: MAX_CHAT });
    const saved = newFact(wb, "Priya Nair's office is in Soho.", P());
    const before = addFact(bb, "Tiger told Max that Priya Nair likes early meetings.", { at: at - 60_000, session: MAX_CHAT });
    SORTS.set(before.text, P());
    let back = await refresh(wb);
    assert.ok(!back.items.some((i) => i.title === "Priya Nair"), "still forgotten");
    for (const [what, id] of [["the card line", `card:${line}`], ["what memory worked out", figured.id], ["a fact saved with no chat", saved.id], ["something said before", before.id]])
      assert.deepEqual(indexOf(bb).facts[id]?.items, [], `${what}: sorted as nothing`);
    // Said in a chat minutes later: memory still working out facts from the chat that asked to forget her. Not back.
    const soon = newFact(wb, "Tiger mentioned Priya Nair while asking to forget her.", P(), { session: MAX_CHAT, at: at + 5 * 60_000 });
    back = await refresh(wb);
    assert.ok(!back.items.some((i) => i.title === "Priya Nair"), "not from what was said 5 minutes after");
    assert.deepEqual(indexOf(bb).facts[soon.id]?.items, [], "sorted as nothing");
    // Said in a chat well afterwards: she's back.
    skew += 16 * 60_000;
    const said = newFact(wb, "Tiger said Priya Nair leads the next round.", P("Leads your next round"), { session: MAX_CHAT });
    back = await refresh(wb);
    const again = one(back.items, "people", "Priya Nair");
    assert.notEqual(again.id, was.id, "a new item");
    assert.deepEqual([again.detail, again.sources.map((s) => s.fact)], ["Leads your next round", [said.id]]);
    await check("Once a forgotten item is back, what memory works out about it and a new card line are its own again (upsert leaves its key in index.forgotten)", async () => {
      const later = newFact(wb, "Priya Nair tends to back seed rounds.", P(), { level: "deductive" });
      const line2 = "Tiger's lead investor is Priya Nair.";
      SORTS.set(line2, P());
      await Mem.pinFact(wb, line2);
      const now = one((await refresh(wb)).items, "people", "Priya Nair");
      assert.deepEqual(now.sources.map((s) => s.fact).sort(), [said.id, later.id, `card:${line2}`].sort(), `her sources are only: ${now.sources.map((s) => s.how).join(", ")}`);
    });
  });
  await check("Two forgets at once: one after the other, the card written once for each, and it ends without the lines of both", async () => {
    const wt = "ws_twice";
    const bt = Mem.bankOf(wt);
    const GUS = [item("people", "Gus", { key: "gus", detail: "Your plumber" })];
    const RITA = [item("people", "Rita", { key: "rita", detail: "Your electrician" })];
    // A line about both goes too: the second forget sees it's only about its item once the first is done.
    seed(wt, [], {
      cards: [
        ["Tiger's plumber is Gus.", GUS],
        ["Gus fixes the boiler every spring.", GUS],
        ["Tiger's electrician is Rita.", RITA],
        ["Gus and Rita share a workshop.", [...GUS, ...RITA]],
        ["Tiger lives in Oakland.", []],
      ],
    });
    const items = (await refresh(wt)).items;
    const [gus, rita] = [one(items, "people", "Gus"), one(items, "people", "Rita")];
    const h3 = honcho.calls.length;
    honcho.hold = (c) => c.method === "PUT";
    const both = [post({ action: "forget", ws: wt, id: gus.id }), post({ action: "forget", ws: wt, id: rita.id })];
    try {
      await until(() => honcho.held.length === 1, "the first forget to write the card");
      await sleep(100);
      assert.equal(honcho.held.length, 1, "the second waits for the first");
      assert.equal(honcho.calls.slice(h3).filter((c) => c.method === "GET" && c.path.endsWith("/card")).length, 1, "and hasn't read the card yet");
    } finally {
      releaseHoncho();
    }
    assert.deepEqual((await Promise.all(both)).map((x) => x.status), [200, 200]);
    const puts = honcho.calls.slice(h3).filter((c) => c.method === "PUT").map((c) => c.body.peer_card);
    assert.equal(puts.length, 2, "the card written once for each (Gus's two lines in one write)");
    assert.deepEqual(hbank(bt).cards.get("user"), ["Tiger lives in Oakland."]);
    assert.deepEqual((await get(wt)).body.items, []);
  });
  await check("A fact memory already deleted counts as gone: the forget goes through", async () => {
    const wg = "ws_gone";
    const bg = Mem.bankOf(wg);
    const G = seed(wg, [["y1", 10, "Tiger's tutor Yuki teaches him Japanese.", [item("people", "Yuki", { key: "yuki", detail: "Your Japanese tutor" })]]]);
    const yuki = one((await refresh(wg)).items, "people", "Yuki");
    removeFact(bg, G.y1.id);
    const h4 = honcho.calls.length;
    const x = await post({ action: "forget", ws: wg, id: yuki.id });
    assert.equal(x.status, 200);
    assert.deepEqual(honcho.calls.slice(h4).filter((c) => c.method === "DELETE").map((c) => c.path), [`/v3/workspaces/${bg}/conclusions/${G.y1.id}`], "asked, and memory said it isn't there (404)");
    assert.ok(!x.body.items.some((i) => i.id === yuki.id));
    assert.ok(indexOf(bg).forgotten["people:yuki"] > 0);
  });
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
    let x;
    try {
      x = await post({ action: "forget", ws: "ws_forgetfail", id: noor.id });
    } finally {
      honcho.fail = null;
    }
    assert.equal(factIds(ff).length, 1, "the fact is still in memory (the fake refused)");
    assert.deepEqual([x.status, x.body], [400, { error: "Couldn't reach memory to forget it. Try again in a moment." }], "the user is told it didn't work");
    assert.ok((await get("ws_forgetfail")).body.items.some((i) => i.id === noor.id), "and Noor is still listed");
  });
});

/* ---------------- What goes wrong ---------------- */

await section("When things go wrong: the model, memory, a damaged file", async () => {
  // The model fails: the facts aren't sorted, a line says so, and they're tried again in 30 minutes.
  const ws = "ws_fail";
  const bank = Mem.bankOf(ws);
  const F = seed(ws, [
    ["j1", 20, "Tiger's coach Ines trains him on Tuesdays.", [item("people", "Ines", { key: "ines", detail: "Your coach" })]],
    ["j2", 10, "Tiger asked what time it was.", []],
  ]);
  const FAILED = "Some new things couldn't be sorted yet. They're tried again later.";
  openai.fail = () => refused();
  let n = openai.calls.length;
  let r = await refresh(ws);
  assert.deepEqual([r.items, r.error], [[], FAILED]);
  assert.deepEqual(openai.calls.slice(n).map((c) => c.texts.length), [2, 1, 1], "the batch, then each half once");
  let idx = indexOf(bank);
  assert.deepEqual(idx.facts, {}, "nothing marked sorted");
  assert.deepEqual(Object.entries(idx.failures).map(([id, f]) => [id, f.n]).sort(), [[F.j1.id, 1], [F.j2.id, 1]].sort(), "each counted as failed once");
  assert.ok(warned.some((w) => w.startsWith("[categories] sort: ")), "said in the log");
  // Not tried again at once: the next look leaves them be.
  openai.fail = null;
  n = openai.calls.length;
  await refresh(ws);
  assert.equal(openai.calls.length, n, "they wait");
  // A new fact meanwhile is tried; an answer that isn't JSON fails it the same way.
  const j3 = newFact(ws, "Tiger's physio is Joana.", [item("people", "Joana", { key: "joana", detail: "Your physio" })]);
  openai.fail = () => json(response("Sorry, I can't help with that."));
  r = await refresh(ws);
  assert.deepEqual(openai.calls.slice(n).map((c) => c.texts), [[j3.text]], "only the new one");
  assert.equal(r.error, FAILED);
  // 30 minutes on, all three are tried again and sorted, and the line goes.
  openai.fail = null;
  skew += 30 * 60_000 + 1000;
  n = openai.calls.length;
  r = await refresh(ws);
  assert.deepEqual(openai.calls.slice(n).map((c) => c.texts.length), [3]);
  one(r.items, "people", "Ines");
  one(r.items, "people", "Joana");
  assert.equal(r.error, undefined, "the line goes once they're sorted");
  idx = indexOf(bank);
  assert.deepEqual(Object.keys(idx.facts).sort(), [F.j1.id, F.j2.id, j3.id].sort());
  assert.deepEqual(idx.failures, {}, "nothing left failing");

  // Memory can't be reached: a line saying so, gone after the next look that works.
  const down = Mem.bankOf("ws_down");
  const DOWN = "Couldn't reach memory just now. It tries again on its own.";
  const listFails = (c) => (c.path === `/v3/workspaces/${down}/conclusions/list` ? json({ detail: "Service Unavailable" }, 503) : null);
  seed("ws_down", [["k1", 10, "Tiger's gym is Atlas Fitness.", [item("companies", "Atlas Fitness", { key: "atlas fitness", detail: "Your gym" })]]]);
  honcho.fail = listFails;
  r = await refresh("ws_down");
  assert.deepEqual([r.items, r.error], [[], DOWN]);
  // A look that didn't get through isn't started again at every ask: the window asking doesn't start one.
  assert.equal((await get("ws_down")).body.error, DOWN);
  assert.ok(!liveBank(down).running, "no look started");
  honcho.fail = null;
  r = await refresh("ws_down");
  one(r.items, "companies", "Atlas Fitness");
  assert.equal(r.error, undefined);
  await check("A look that reaches memory takes away \"Couldn't reach memory\", even when its new facts wait to be sorted together (run() returns for the wait before the error line is set)", async () => {
    honcho.fail = listFails;
    try {
      await MC.sync("ws_down", { mode: "look" });
    } finally {
      honcho.fail = null;
    }
    assert.equal(indexOf(down).error, DOWN);
    const k2 = addFact(down, "Tiger's gym moved to Pier 9.", { at: Date.now() - 1000 });
    SORTS.set(k2.text, [item("companies", "Atlas Fitness", { key: "atlas fitness", detail: "Your gym, at Pier 9 now" })]);
    await MC.sync("ws_down", { mode: "look" });
    const after = indexOf(down);
    assert.equal(after.waiting, 1, "the new fact waits to be sorted with others");
    assert.equal(after.error, undefined, `memory was reached, the line should go (it says ${JSON.stringify(after.error)})`);
  });

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

await section("A big memory: the newest 300, 150 a look and 25 a call; Sort older adds 300", async () => {
  const ws = "ws_big";
  const bank = Mem.bankOf(ws);
  const base = Date.now() - 86_400_000;
  const texts = [];
  for (let k = 0; k < 700; k++) {
    const text = `Tiger's rule ${k}: answer email ${k} within a day.`;
    texts.push(text);
    SORTS.set(text, [item("preferences", `Rule ${k}`, { key: `rule ${k}` })]);
    addFact(bank, text, { at: base - k * 60_000 });
  }
  const list = `/v3/workspaces/${bank}/conclusions/list`;
  /** The pages of memory read since `h` (not counting facts asked for by id). */
  const pagesRead = (h) => honcho.calls.slice(h).filter((c) => c.path === list && !c.body.filters.id).map((c) => c.query.page);
  const sent = (n) => openai.calls.slice(n);
  const n0 = openai.calls.length;
  let n = n0;
  let h = honcho.calls.length;
  let r = await refresh(ws);
  assert.deepEqual(sent(n).map((c) => c.input.facts.length), [25, 25, 25, 25, 25, 25], "150 this look, 25 a call");
  assert.deepEqual(sent(n).flatMap((c) => c.texts), texts.slice(0, 150), "the newest first");
  for (const c of sent(n)) assert.ok(Object.values(c.input.known).flat().length <= 40, "what's known is 40 at most");
  assert.deepEqual(pagesRead(h), ["1", "2", "3", "4", "5", "6", "7"], "a sweep reads every page (up to 1,500 facts)");
  assert.deepEqual([r.items.length, r.behind], [150, 400], "the 400 older than the newest 300 aren't sorted, and are counted");
  assert.deepEqual(timersOf(bank), ["more"], "the rest of the 300 in a minute");
  assert.equal(delayOf(bank, "more"), 60_000);

  await check("A quick look (after a fact is saved) keeps the count of what's behind", async () => {
    await MC.sync(ws, { mode: "quick" });
    const behind = (await get(ws)).body.behind;
    assert.equal(behind, 400, `400 still behind (the snapshot says ${behind})`);
  });
  // That look reads the newest 300 again and sorts the other 150 of them.
  n = openai.calls.length;
  h = honcho.calls.length;
  await fire(ws, "more");
  assert.deepEqual(pagesRead(h), ["1", "2", "3"], "the newest 300");
  assert.deepEqual(sent(n).flatMap((c) => c.texts), texts.slice(150, 300));
  r = (await get(ws)).body;
  assert.deepEqual([r.items.length, r.behind], [300, 400]);
  assert.deepEqual(timersOf(bank), [], "nothing more to sort");
  // Refresh: nothing new among the newest 300, and nothing older sorted.
  n = openai.calls.length;
  r = await refresh(ws);
  assert.equal(openai.calls.length, n);
  assert.deepEqual([r.items.length, r.behind], [300, 400]);
  // Sort older: the next 300, 150 now and 150 a minute later; that look uses what this one read (kept 10 minutes).
  n = openai.calls.length;
  h = honcho.calls.length;
  let s = await post({ action: "sort-older", ws });
  assert.equal(s.status, 200);
  assert.deepEqual(pagesRead(h), ["1", "2", "3", "4", "5", "6"], "the newest 600");
  assert.deepEqual(sent(n).flatMap((c) => c.texts), texts.slice(300, 450));
  assert.deepEqual([s.body.items.length, s.body.behind], [450, 100]);
  n = openai.calls.length;
  h = honcho.calls.length;
  await fire(ws, "more");
  assert.deepEqual(pagesRead(h), [], "not read again");
  assert.deepEqual(sent(n).flatMap((c) => c.texts), texts.slice(450, 600));
  // The last 100: nothing behind them.
  n = openai.calls.length;
  s = await post({ action: "sort-older", ws });
  assert.deepEqual(sent(n).map((c) => c.input.facts.length), [25, 25, 25, 25]);
  assert.deepEqual([s.body.items.length, s.body.behind], [700, undefined]);
  // Nothing behind: Sort older does nothing.
  h = honcho.calls.length;
  s = await post({ action: "sort-older", ws });
  assert.deepEqual([s.status, s.body.items.length, honcho.calls.length], [200, 700, h]);
  assert.equal(indexOf(bank).depth, 900);
  const all = sent(n0).flatMap((c) => c.texts);
  assert.deepEqual([all.length, new Set(all).size], [700, 700], "each fact sent to the model once");
  // A look (the window's, every 15 minutes) reads until a page it has seen all of.
  newFact(ws, "Tiger's rule 700: no meetings on Fridays.", [item("preferences", "Rule 700", { key: "rule 700" })]);
  h = honcho.calls.length;
  await MC.sync(ws, { mode: "look" });
  assert.deepEqual(pagesRead(h), ["1", "2"], "the newest page has something new, the second is all seen");
  clearTimers(bank);

  await check("Past the 1,500 a sweep reads, a fact still in memory stays (asked for by id), and one deleted goes", async () => {
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
    const h2 = honcho.calls.length;
    let after = await refresh("ws_window");
    const byId = honcho.calls.slice(h2).filter((c) => c.path === `/v3/workspaces/${wb}/conclusions/list` && c.body.filters.id);
    assert.deepEqual(
      byId.map((c) => [c.query, c.body.filters]),
      [[{ page: "1", size: "1" }, { id: { in: [sven.id] }, observer_id: "user", observed_id: "user" }]],
      "Sven, the one sorted fact the sweep didn't list, asked for by id",
    );
    assert.ok(after.items.some((i) => i.title === "Sven"), "Sven is still there (his fact is in memory, past what a sweep reads)");
    removeFact(wb, sven.id);
    after = await refresh("ws_window");
    assert.ok(!after.items.some((i) => i.title === "Sven"), "gone once memory no longer has him");
    clearTimers(wb);
  });
});

/* ---------------- A sweep ---------------- */

await section("A sweep: what a listing missed is asked for by id, and only what memory no longer has goes", async () => {
  const ws = "ws_scan";
  const bank = Mem.bankOf(ws);
  const base = Date.now() - 86_400_000;
  const rows = [];
  for (let k = 0; k < 150; k++) {
    const text = `Tiger's errand ${k}: pick up parcel ${k}.`;
    SORTS.set(text, [item("todos", `Errand ${k}`, { key: `errand ${k}` })]);
    rows.push(addFact(bank, text, { at: base - k * 60_000 }));
  }
  let r = await refresh(ws);
  assert.equal(r.items.length, 150);
  // A sweep reads memory a page at a time. Between its first page and its second, the newest fact is deleted
  // (on another Mac, say): everything after it moves up one, and what was first on page 2 is last on page 1 by then, unread.
  const list = `/v3/workspaces/${bank}/conclusions/list`;
  honcho.hold = (c) => c.path === list && c.query.page === "2" && !c.body.filters.id;
  const h = honcho.calls.length;
  const sweeping = post({ action: "refresh", ws });
  await until(() => honcho.held.length === 1, "the sweep to ask for page 2");
  removeFact(bank, rows[0].id);
  releaseHoncho();
  r = (await sweeping).body;
  const byId = honcho.calls.slice(h).filter((c) => c.path === list && c.body.filters.id);
  assert.deepEqual(byId.map((c) => c.body.filters.id.in), [[rows[100].id]], "the one it missed is asked for by id");
  assert.ok(r.items.some((i) => i.title === "Errand 100"), "and kept: memory still has it");
  assert.equal(r.items.length, 150, "nothing gone yet (the deleted one was read before it went)");
  // The next sweep doesn't list the deleted one: asked for by id, it isn't there, and its to-do goes.
  r = await refresh(ws);
  assert.ok(!r.items.some((i) => i.title === "Errand 0"));
  assert.equal(r.items.length, 149);
  // A look is a sweep when the last sweep was over 6 hours ago. Before that, one deleted elsewhere is still listed.
  removeFact(bank, rows[149].id);
  await MC.sync(ws, { mode: "look" });
  assert.ok(Object.hasOwn(indexOf(bank).facts, rows[149].id), "a look within 6 hours of a sweep doesn't check");
  skew += 6 * 3_600_000 + 1000;
  await MC.sync(ws, { mode: "look" });
  assert.ok(!Object.hasOwn(indexOf(bank).facts, rows[149].id), "6 hours on, a look sweeps");
  assert.ok(!(await get(ws)).body.items.some((i) => i.title === "Errand 149"));
});

/* ---------------- Another account mid-look ---------------- */

await section("Another account signing in mid-look: nothing of the last one's is written", async () => {
  const ws = "ws_switch";
  const bank = Mem.bankOf(ws);
  seed(ws, [["s1", 20, "Tiger's piano teacher is Clara Moss.", [item("people", "Clara Moss", { key: "clara moss", detail: "Your piano teacher" })]]]);
  one((await refresh(ws)).items, "people", "Clara Moss");
  newFact(ws, "Tiger's barber is Otto.", [item("people", "Otto", { key: "otto", detail: "Your barber" })]);
  const before = readFileSync(fileFor(bank), "utf8");
  openai.hold = () => true;
  const pending = post({ action: "refresh", ws });
  await until(() => openai.held.length === 1, "the look to reach the model");
  // The window, meanwhile: sorting.
  const during = (await get(ws)).body;
  assert.equal(during.syncing, true);
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
  // The look ended without writing anything: still a change, so the window that saw it sorting isn't told "unchanged".
  const back = await getRev(ws, during.rev);
  assert.deepEqual([back.body.unchanged, back.body.syncing], [undefined, false], "the end of a look is a change");
  one((await refresh(ws)).items, "people", "Otto");

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

await section("Tidying up memory: asked of Honcho, at most once an hour, and swept after", async () => {
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
  assert.deepEqual(timersOf(bank), ["dream-later", "dream-soon"], "sweeps set for when its results come in");
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
  await check("After tidying up, the sweep drops the card lines memory rewrote and sorts the new ones at once", async () => {
    const ws4 = "ws_tidy4";
    const b4 = Mem.bankOf(ws4);
    const OLD = "Tiger's gym is Atlas Fitness.";
    const OTTO = "Tiger's barber is Otto.";
    seed(ws4, [], { cards: [[OLD, [item("companies", "Atlas Fitness", { key: "atlas fitness", detail: "Your gym" })]], [OTTO, [item("people", "Otto", { key: "otto", detail: "Your barber" })]]] });
    const otto = one((await refresh(ws4)).items, "people", "Otto");
    assert.equal((await post({ action: "tidy-up", ws: ws4 })).status, 200);
    // Memory tidies up and writes the card again: one line reworded, one as it was.
    const NEW = "Tiger trains at Atlas Fitness on Mondays.";
    SORTS.set(NEW, [item("companies", "Atlas Fitness", { key: "atlas fitness", detail: "Your gym, Mondays" })]);
    hbank(b4).cards.set("user", [NEW, OTTO]);
    const n = openai.calls.length;
    await fire(ws4, "dream-soon");
    assert.deepEqual(openai.calls.slice(n).map((c) => c.texts), [[NEW]], "the new line, sorted at once");
    assert.ok(!Object.hasOwn(indexOf(b4).facts, `card:${OLD}`), "the old line dropped");
    const items = (await get(ws4)).body.items;
    assert.deepEqual(pick(one(items, "companies", "Atlas Fitness"), ["detail"]), { detail: "Your gym, Mondays" });
    assert.deepEqual(one(items, "companies", "Atlas Fitness").sources.map((s) => s.fact), [`card:${NEW}`]);
    assert.equal(one(items, "people", "Otto").id, otto.id, "a line left as it was keeps its item");
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

/* ---------------- Sorted together ---------------- */

await section("New facts wait to be sorted together: 10 at a time, after 30 minutes, or at once when asked", async () => {
  const ws = "ws_budget";
  const bank = Mem.bankOf(ws);
  /** A fact memory just worked out from a chat. */
  const fresh = (text, items, opts = {}) => {
    SORTS.set(text, items);
    return addFact(bank, text, { at: Date.now() - 1000, session: MAX_CHAT, ...opts });
  };
  const sorted = (f) => Object.hasOwn(indexOf(bank).facts, f.id);
  const person = (name, detail) => [item("people", name, { key: name.toLowerCase(), detail })];
  // The first look sorts what it finds at once, however little and however new.
  const a = fresh("Tiger's neighbor is Ruth.", person("Ruth", "Your neighbor"));
  await get(ws);
  await settled(ws);
  assert.ok(sorted(a), "the first look");
  // A chat saved: a quick look in 3 minutes (a second save doesn't set it again or push it back).
  MC.nudge(ws, "saved");
  assert.equal(delayOf(bank, "saved"), 180_000);
  const saved = liveBank(bank).timers.get("saved");
  MC.nudge(ws, "saved");
  assert.equal(liveBank(bank).timers.get("saved"), saved);
  // Memory worked out one new fact from it: that look finds it, and it waits (no model call for one fact).
  const n = openai.calls.length;
  const w = [fresh("Tiger is learning Portuguese.", [item("preferences", "Learning Portuguese", { key: "learning portuguese" })])];
  await fire(ws, "saved");
  assert.equal(openai.calls.length, n, "not sorted yet");
  assert.ok(!sorted(w[0]));
  assert.equal((await get(ws)).body.waiting, 1, "the window says one is waiting");
  const timer = liveBank(bank).timers.get("waiting");
  const d = delayOf(bank, "waiting");
  assert.ok(d > 29 * 60_000 && d <= 30 * 60_000, `a look set for when it has waited 30 minutes (in ${d} ms)`);
  // A second: two wait, and that look isn't pushed back.
  w.push(fresh("Tiger's favorite cafe is Lisboa.", [item("preferences", "Cafe Lisboa", { key: "cafe lisboa" })]));
  await MC.sync(ws, { mode: "quick" });
  assert.equal(openai.calls.length, n);
  assert.equal(indexOf(bank).waiting, 2);
  assert.equal(liveBank(bank).timers.get("waiting"), timer, "the same look, not pushed back");
  // Nine still wait; the tenth, and they're sorted together, in one call.
  for (let k = 0; k < 7; k++) w.push(fresh(`Tiger's plant ${k} needs water on Sundays.`, []));
  await MC.sync(ws, { mode: "quick" });
  assert.deepEqual([openai.calls.length, indexOf(bank).waiting], [n, 9], "nine wait");
  w.push(fresh("Tiger's plant 7 needs water on Sundays.", []));
  await MC.sync(ws, { mode: "quick" });
  assert.deepEqual(openai.calls.slice(n).map((c) => c.texts.length), [10], "the ten in one call");
  assert.ok(w.every(sorted));
  assert.equal(indexOf(bank).waiting, undefined);
  await check("Once what waited is sorted, the look set for it goes (left set, it sorts the next fact before that one has waited 30 minutes)", () => {
    assert.ok(!liveBank(bank).timers.has("waiting"), "no look left set for facts that are sorted");
  });
  clearTimers(bank);
  // The next one waits, and is sorted when the look set for it comes.
  const x = fresh("Tiger's bike is at the repair shop.", []);
  await MC.sync(ws, { mode: "quick" });
  assert.ok(!sorted(x));
  await fire(ws, "waiting");
  assert.ok(sorted(x), "sorted when its look comes");
  // One more, sorted by the first look after it has waited 30 minutes (the look set for it may not have run: Bops was closed, say).
  const y = fresh("Tiger's cousin Bo visits in June.", person("Bo", "Your cousin"));
  await MC.sync(ws, { mode: "quick" });
  assert.ok(!sorted(y));
  clearTimers(bank);
  skew += 30 * 60_000;
  await MC.sync(ws, { mode: "quick" });
  assert.ok(sorted(y), "it has waited 30 minutes");
  // A fact saved by hand: a quick look in a few seconds that sorts it at once.
  const z = fresh("Tiger's locker code changed.", [], { session: null });
  MC.nudge(ws, "learned");
  assert.equal(delayOf(bank, "learned"), 4000);
  await fire(ws, "learned");
  assert.ok(sorted(z), "at once");
  // Refresh: at once too.
  const v = fresh("Tiger's tennis partner is Iko.", person("Iko", "Your tennis partner"));
  await MC.sync(ws, { mode: "quick" });
  assert.ok(!sorted(v));
  const r = await refresh(ws);
  assert.ok(sorted(v));
  assert.equal(r.waiting, undefined);
  one(r.items, "people", "Iko");
});

/* ---------------- The model failing ---------------- */

await section("A model that's down or answers unusably: an outage counts nothing, a bad answer is narrowed to its fact", async () => {
  const UNSORTED = "Some new things couldn't be sorted yet. They're tried again later.";
  const DOWN = "Couldn't sort new things just now. Bops tries again on its own.";
  // A server error: the SDK tries once more (not twice), every call not kept at OpenAI and 90 seconds at most.
  {
    const ws = "ws_retry";
    seed(ws, [["t1", 10, "Tiger's tailor is Marco.", [item("people", "Marco", { key: "marco", detail: "Your tailor" })]]]);
    let first = true;
    openai.fail = () => (first ? ((first = false), overloaded()) : null);
    const n = openai.calls.length;
    const r = await refresh(ws);
    assert.deepEqual(openai.calls.slice(n).map((c) => [c.headers.retry, c.headers.timeout, c.body.store]), [["0", "90", false], ["1", "90", false]], "tried again once, and it worked");
    one(r.items, "people", "Marco");
    openai.fail = null;
  }
  // Down (still overloaded after that, rate limited, a key refused, not allowed, no such model, unreachable):
  // no fact's fault. The look stops, nothing is counted against any fact, and they're all sorted once it's back.
  {
    const ws = "ws_outage";
    const bank = Mem.bankOf(ws);
    const list = [];
    for (let k = 0; k < 60; k++) list.push([`o${k}`, k + 1, `Tiger's filing note ${k} is in.`, []]);
    seed(ws, list);
    let calls = 0;
    openai.fail = () => (++calls > 1 ? overloaded() : null);
    let n = openai.calls.length;
    let r = await refresh(ws);
    assert.deepEqual(openai.calls.slice(n).map((c) => [c.texts.length, c.headers.retry]), [[25, "0"], [25, "0"], [25, "1"]], "the second batch, down after one more try: the look stops there");
    let idx = indexOf(bank);
    assert.deepEqual([sortedIn(bank), idx.failures ?? {}, idx.more, r.error], [25, {}, true, DOWN], "nothing counted against a fact, and sorting left to do");
    for (const [what, down, tries] of [
      ["rate limited", () => httpError(429, "Rate limit reached"), 2],
      ["a key refused", () => httpError(401, "Incorrect API key"), 1],
      ["not allowed", () => httpError(403, "Not allowed"), 1],
      ["no such model", () => httpError(404, "The model does not exist"), 1],
      ["unreachable", unreachable, 2],
    ]) {
      openai.fail = down;
      n = openai.calls.length;
      r = await refresh(ws);
      assert.equal(openai.calls.length - n, tries, `${what}: asked ${tries} time${tries === 1 ? "" : "s"}`);
      idx = indexOf(bank);
      assert.deepEqual([sortedIn(bank), idx.failures ?? {}, idx.more, r.error], [25, {}, true, DOWN], what);
    }
    // Back: the next look (reading as deep as the sorting goes) sorts the rest, and the line goes.
    openai.fail = null;
    await MC.sync(ws, { mode: "look" });
    idx = indexOf(bank);
    assert.deepEqual([sortedIn(bank), idx.failures ?? {}, idx.more, idx.error], [60, {}, undefined, undefined]);
  }
  // A wrong setting (the model rejects every request, 400): narrowed down to single facts, but with nothing
  // answered this look it's the setting, not the facts. The look stops, nothing is counted, and once the
  // setting is fixed they're all sorted. One fact rejected while the others are answered is about that fact.
  {
    const ws = "ws_setting";
    const bank = Mem.bankOf(ws);
    const F = seed(ws, [
      ["w1", 10, "Tiger's barber is Luis.", [item("people", "Luis", { key: "luis", detail: "Your barber" })]],
      ["w2", 20, "Tiger's gym is Peak Fitness.", [item("companies", "Peak Fitness", { key: "peak fitness" })]],
      ["w3", 30, "Tiger's dentist is Dr. Okafor.", [item("people", "Dr. Okafor", { key: "dr okafor", detail: "Your dentist" })]],
    ]);
    openai.fail = () => rejected();
    let r = await refresh(ws);
    let idx = indexOf(bank);
    assert.deepEqual([sortedIn(bank), idx.failures ?? {}, idx.more, r.error], [0, {}, true, DOWN], "every call rejected: nothing counted against a fact");
    openai.fail = null;
    await MC.sync(ws, { mode: "look" });
    idx = indexOf(bank);
    assert.deepEqual([sortedIn(bank), idx.failures ?? {}, idx.error], [3, {}, undefined], "sorted once the setting is fixed");
    // Only one fact rejected, the rest answered: that fact is counted.
    const odd = addFact(bank, "Tiger's locksmith is Abe.");
    const fine = addFact(bank, "Tiger's florist is June.");
    SORTS.set(fine.text, [item("people", "June", { key: "june", detail: "Your florist" })]);
    SORTS.set(odd.text, [item("people", "Abe", { key: "abe", detail: "Your locksmith" })]);
    openai.fail = (c) => (c.texts.includes(odd.text) ? rejected() : null);
    r = await refresh(ws);
    idx = indexOf(bank);
    assert.equal(idx.failures?.[odd.id]?.n, 1, "the rejected fact is counted when others were answered");
    assert.ok(Object.hasOwn(idx.facts, fine.id) && !Object.hasOwn(idx.facts, odd.id), "and the other is sorted");
    assert.ok(F.w1 && r.items.some((i) => i.title === "June"));
    openai.fail = null;
  }
  // An answer that can't be used (refused for what's in it, not JSON, a place outside the batch): asked again
  // in halves, down to the one fact it's about. Only that fact counts as failed (tried again in 30 minutes,
  // then an hour, then given up), and every other fact is sorted.
  {
    const ws = "ws_split";
    const bank = Mem.bankOf(ws);
    const list = [];
    for (let k = 0; k < 25; k++) list.push([`s${k}`, k + 1, `Tiger's supplier ${k} delivers on Mondays.`, [item("companies", `Supplier ${k}`, { key: `supplier ${k}` })]]);
    const F = seed(ws, list);
    const BAD = F.s17;
    openai.fail = (c) => (c.texts.includes(BAD.text) ? refused("The model choked.") : null);
    let n = openai.calls.length;
    let r = await refresh(ws);
    assert.deepEqual(openai.calls.slice(n).map((c) => c.texts.length), [25, 13, 12, 6, 3, 3, 2, 1, 1, 1, 6], "halves of halves, down to the one fact");
    assert.equal(r.items.length, 24, "the other 24 sorted");
    assert.deepEqual(Object.entries(indexOf(bank).failures).map(([id, f]) => [id, f.n]), [[BAD.id, 1]], "only that fact counted");
    assert.equal(r.error, UNSORTED);
    // Not tried again at once (and the line stays while it waits).
    n = openai.calls.length;
    r = await refresh(ws);
    assert.deepEqual([openai.calls.length - n, r.error], [0, UNSORTED], "it waits 30 minutes");
    // 30 minutes on: tried again, alone. Failing a second time, it waits an hour.
    skew += 30 * 60_000 + 1000;
    n = openai.calls.length;
    await refresh(ws);
    assert.deepEqual(openai.calls.slice(n).map((c) => c.texts), [[BAD.text]]);
    assert.equal(indexOf(bank).failures[BAD.id].n, 2);
    skew += 30 * 60_000 + 1000;
    n = openai.calls.length;
    await refresh(ws);
    assert.equal(openai.calls.length, n, "the second wait is an hour");
    // After the hour, the third time: given up, sorted as nothing, never sent again.
    skew += 30 * 60_000;
    n = openai.calls.length;
    await refresh(ws);
    assert.deepEqual(openai.calls.slice(n).map((c) => c.texts), [[BAD.text]]);
    const idx = indexOf(bank);
    assert.deepEqual([idx.facts[BAD.id], idx.failures], [{ items: [], at: BAD.at }, {}]);
    skew += 3 * 3_600_000;
    n = openai.calls.length;
    r = await refresh(ws);
    assert.equal(openai.calls.length, n, "never again");
    assert.equal(r.error, undefined, "nothing waits to be tried again: the line goes");
    openai.fail = null;
  }
  // An answer about a fact that isn't in the batch can't be trusted: nothing of it is kept, and the fact is tried again later.
  {
    const ws = "ws_range";
    const bank = Mem.bankOf(ws);
    const U = seed(ws, [["u1", 10, "Tiger's cousin Nell runs a farm.", [item("people", "Nell", { key: "nell", detail: "Your cousin" })]]]);
    openai.fail = (c) => answer([{ i: c.texts.length, items: [item("people", "Ghost", { key: "ghost" })] }]);
    let r = await refresh(ws);
    assert.deepEqual([r.items, r.error], [[], "Some new things couldn't be sorted yet. They're tried again later."], "i one past the end");
    assert.equal(indexOf(bank).failures[U.u1.id].n, 1);
    const u2 = newFact(ws, "Tiger's aunt Rosa paints.", [item("people", "Rosa", { key: "rosa", detail: "Your aunt" })]);
    openai.fail = (c) => answer([{ i: -1, items: [] }, ...c.texts.map((t, i) => ({ i, items: SORTS.get(t) ?? [] }))]);
    r = await refresh(ws);
    assert.ok(!r.items.some((i) => i.title === "Rosa"), "one bad place spoils the answer (i -1)");
    assert.equal(indexOf(bank).failures[u2.id].n, 1);
    // Two entries for the same fact: both kept.
    const u3 = newFact(ws, "Tiger's neighbors Ada and Bo run a bakery.", []);
    openai.fail = (c) => {
      const j = c.texts.indexOf(u3.text);
      if (j < 0) return null;
      const rest = c.texts.map((t, i) => ({ i, items: SORTS.get(t) ?? [] })).filter((f) => f.i !== j);
      return answer([...rest, { i: j, items: [item("people", "Ada", { key: "ada", detail: "Runs the bakery" })] }, { i: j, items: [item("people", "Bo", { key: "bo", detail: "Runs the bakery" })] }]);
    };
    r = await refresh(ws);
    const [ada, bo] = [one(r.items, "people", "Ada"), one(r.items, "people", "Bo")];
    assert.deepEqual([...indexOf(bank).facts[u3.id].items].sort(), [ada.id, bo.id].sort());
    // A request refused for what's in it (422), and an answer that isn't JSON: the same, counted on the fact.
    const u4 = newFact(ws, "Tiger's uncle Abe fishes.", [item("people", "Abe", { key: "abe", detail: "Your uncle" })]);
    openai.fail = (c) => (c.texts.includes(u4.text) ? httpError(422, "Unprocessable") : null);
    await refresh(ws);
    const u5 = newFact(ws, "Tiger's niece Ivy draws.", [item("people", "Ivy", { key: "ivy", detail: "Your niece" })]);
    openai.fail = (c) => (c.texts.includes(u5.text) ? json(response("I can't sort that.")) : null);
    await refresh(ws);
    assert.deepEqual([indexOf(bank).failures[u4.id].n, indexOf(bank).failures[u5.id].n], [1, 1]);
    openai.fail = null;
  }
  // More than one look takes, and a batch failed: the rest wait for the next look, not a minute.
  {
    const ws = "ws_more";
    const bank = Mem.bankOf(ws);
    const base = Date.now() - 86_400_000;
    const texts = [];
    for (let k = 0; k < 160; k++) {
      const text = `Tiger's chore ${k}: sweep room ${k}.`;
      texts.push(text);
      SORTS.set(text, []);
      addFact(bank, text, { at: base - k * 60_000 });
    }
    openai.fail = (c) => (c.texts.includes(texts[3]) ? refused("The model choked.") : null);
    const r = await refresh(ws);
    assert.equal(r.error, UNSORTED);
    assert.ok(!timersOf(bank).includes("more"), "no look in a minute");
    assert.deepEqual([sortedIn(bank), indexOf(bank).more], [149, true], "149 sorted, and the next look goes on with the rest");
    openai.fail = null;
  }
  // One call after another: each is told what the ones before it found.
  {
    const ws = "ws_serial";
    const list = [["s0", 1, "Tiger hired Dana Kim as an advisor.", [item("people", "Dana Kim", { key: "dana kim", detail: "Your advisor" })]]];
    for (let k = 1; k < 30; k++) list.push([`s${k}`, 1 + k, `Tiger's errand ${k} is done.`, []]);
    seed(ws, list);
    openai.hold = () => true;
    const n = openai.calls.length;
    const sorting = refresh(ws);
    try {
      await until(() => openai.held.length === 1, "the first call");
      await sleep(100);
      assert.equal(openai.held.length, 1, "one call at a time");
    } finally {
      releaseOpenai();
    }
    await sorting;
    const calls = openai.calls.slice(n);
    assert.deepEqual(calls.map((c) => c.texts.length), [25, 5]);
    assert.ok(calls[1].input.known.people?.some((k) => k.title === "Dana Kim"), "the second is told who the first found");
  }
});

/* ---------------- What a mention may change ---------------- */

await section("What a mention may change: hidden stays hidden, the card fills in, older fills blanks, the fullest name", async () => {
  // Hidden by the user, and memory rewords the fact (tidying up deletes it and says it in other words): the
  // old fact goes, the item stays hidden, and the new one merges into it by its key.
  {
    const ws = "ws_hide";
    const bank = Mem.bankOf(ws);
    const F = seed(ws, [["h1", 10, "Tiger's gym buddy is Rafa.", [item("people", "Rafa", { key: "rafa", detail: "Your gym buddy" })]]]);
    const rafa = one((await refresh(ws)).items, "people", "Rafa");
    assert.equal((await post({ action: "edit", ws, id: rafa.id, hidden: true })).status, 200);
    removeFact(bank, F.h1.id);
    const h2 = newFact(ws, "Rafa, who works out with Tiger, moved to Madrid.", [item("people", "Rafa", { key: "rafa", detail: "Your gym buddy, in Madrid now" })]);
    const n = openai.calls.length;
    const r = await refresh(ws);
    assert.deepEqual(openai.calls[n].input.known, { people: [{ title: "Rafa", key: "rafa" }] }, "the model is told the hidden one too, with its key");
    assert.ok(!r.items.some((i) => i.id === rafa.id), "still hidden");
    assert.deepEqual(r.hidden, [{ id: rafa.id, category: "people", title: "Rafa" }], "the same item");
    const kept = indexOf(bank).items[rafa.id];
    assert.deepEqual([kept.hidden, kept.detail, kept.sources.map((s) => s.fact)], [true, "Your gym buddy, in Madrid now", [h2.id]]);
    assert.equal(Object.keys(indexOf(bank).items).length, 1, "not made again");
  }
  // A card line doesn't change what chats said about someone; it fills in what they didn't.
  {
    const ws = "ws_card";
    const CHAT = "Tiger said his accountant Priya Shah moved to Deloitte.";
    const LINE = "Tiger's accountant is Priya Shah.";
    seed(ws, [
      ["c1", 10, CHAT, [item("people", "Priya Shah", { key: "priya shah", detail: "Your accountant, at Deloitte now" })], { session: MAX_CHAT }],
      ["c2", 20, "Tiger had lunch with Omar Farouk.", [item("people", "Omar Farouk", { key: "omar farouk" })], { session: MAX_CHAT }],
    ]);
    await refresh(ws);
    for (const [line, items] of [
      [LINE, [item("people", "Priya Shah", { key: "priya shah", detail: "Your accountant" })]],
      ["Tiger's cofounder is Omar Farouk.", [item("people", "Omar Farouk", { key: "omar farouk", detail: "Your cofounder" })]],
    ]) {
      SORTS.set(line, items);
      await Mem.pinFact(ws, line);
    }
    const r = await refresh(ws);
    assert.equal(one(r.items, "people", "Priya Shah").detail, "Your accountant, at Deloitte now", "what the chat said stays");
    assert.equal(one(r.items, "people", "Omar Farouk").detail, "Your cofounder", "what it didn't say, the card fills in");
    await check("On a first look, where the card is sorted first, what a chat said still wins over a card line (a card line is dated when it's sorted, so upsert takes every chat fact for an older mention)", async () => {
      seed("ws_card2", [["c1", 10, CHAT, SORTS.get(CHAT), { session: MAX_CHAT }]], { cards: [[LINE, SORTS.get(LINE)]] });
      const priya = one((await refresh("ws_card2")).items, "people", "Priya Shah");
      assert.equal(priya.detail, "Your accountant, at Deloitte now", `the chat's line, not the card's (it is ${JSON.stringify(priya.detail)})`);
    });
  }
  // An older mention fills in a line the item doesn't have (and never changes one it has: Ana's, above).
  {
    const ws = "ws_older";
    const bank = Mem.bankOf(ws);
    const F = seed(ws, [["o1", 10, "Tiger had coffee with Jun.", [item("people", "Jun", { key: "jun" })], { session: MAX_CHAT }]]);
    assert.equal(one((await refresh(ws)).items, "people", "Jun").detail, "");
    const o2 = addFact(bank, "Jun is Tiger's old classmate from Seoul.", { at: F.o1.at - 30 * 86_400_000, session: MAX_CHAT });
    SORTS.set(o2.text, [item("people", "Jun", { key: "jun", detail: "Your old classmate from Seoul" })]);
    const jun = one((await refresh(ws)).items, "people", "Jun");
    assert.deepEqual(pick(jun, ["detail", "first", "last"]), { detail: "Your old classmate from Seoul", first: o2.at, last: F.o1.at });
  }
  // The fullest name, from a newer mention or an older one, but only one that adds words ("Sam" isn't "Samuel").
  {
    seed("ws_names", [
      ["n1", 10, "Tiger called Lea about the lease.", [item("people", "Lea", { key: "lea" })]],
      ["n2", 20, "Lea Moreau is Tiger's landlady.", [item("people", "Lea Moreau", { key: "lea", detail: "Your landlady" })]],
      ["n3", 30, "Tiger's nephew Sam starts school.", [item("people", "Sam", { key: "sam", detail: "Your nephew" })]],
      ["n4", 40, "Samuel, Tiger's nephew, loves trains.", [item("people", "Samuel", { key: "sam" })]],
    ]);
    const r = await refresh("ws_names");
    assert.deepEqual(r.items.map((i) => i.title).sort(), ["Lea Moreau", "Sam"]);
    assert.equal(one(r.items, "people", "Lea Moreau").detail, "Your landlady");
  }
  // The same thing however it's written: a full stop ending a word, a company's "Inc", "the" and "project" around a project's name.
  {
    seed("ws_keys", [
      ["k1", 10, "Tiger signed with Acme Inc. yesterday.", [item("companies", "Acme Inc.", { key: "Acme Inc." })]],
      ["k2", 20, "Acme makes the widgets.", [item("companies", "Acme", { key: "acme", detail: "Makes the widgets" })]],
      ["k3", 30, "The Atlas project ships in May.", [item("projects", "The Atlas project", { key: "the atlas project" })]],
      ["k4", 40, "Atlas is Tiger's onboarding redesign.", [item("projects", "Atlas", { key: "atlas", detail: "Your onboarding redesign" })]],
    ]);
    const r = await refresh("ws_keys");
    assert.deepEqual(r.items.map((i) => [i.key, i.sources.length]).sort(), [["companies:acme", 2], ["projects:atlas", 2]]);
  }
  // Number ranges read "9 to 5", any other dash becomes a comma: in what the model writes and in what the user types.
  {
    const ws = "ws_ranges";
    seed(ws, [["r1", 10, "Tiger's studio opens 9 to 5 on weekdays.", [item("companies", "Studio Nine", { key: "studio nine", detail: "Open 9\u20135 on weekdays \u2014 closed in August" })]]]);
    const studio = one((await refresh(ws)).items, "companies", "Studio Nine");
    assert.equal(studio.detail, "Open 9 to 5 on weekdays, closed in August");
    const e = await post({ action: "edit", ws, id: studio.id, detail: "Calls 10 \u2013 11am\u2014then lunch" });
    assert.equal(one(e.body.items, "companies", "Studio Nine").detail, "Calls 10 to 11am, then lunch");
  }
  // What the model is told is known, from a big index (over 40): names sharing a word with the facts, and
  // events within two weeks of them; 40 at most.
  {
    const ws = "ws_known";
    const DAY = 86_400_000;
    const pad = (x) => String(x).padStart(2, "0");
    const day = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const soon = day(Date.now() + 3 * DAY);
    const later = day(Date.now() + 60 * DAY);
    const list = [
      ["dana", 10, "Tiger works with Dana Kim on the budget.", [item("people", "Dana Kim", { key: "dana kim", detail: "Works with you on the budget" })]],
      ["board", 20, `Tiger has a board meeting on ${soon}.`, [item("events", "Board meeting", { key: `board meeting ${soon}`, when: soon })]],
      ["ski", 30, `Tiger goes skiing on ${later}.`, [item("events", "Ski trip", { key: `ski trip ${later}`, when: later })]],
    ];
    for (let k = 0; k < 42; k++) list.push([`h${k}`, 100 + k, `Tiger keeps habit ${k} daily.`, [item("preferences", `Habit ${k}`, { key: `habit ${k}` })]]);
    seed(ws, list);
    assert.equal((await refresh(ws)).items.length, 45);
    newFact(ws, "Dana Kim sent Tiger the agenda.", [item("people", "Dana Kim", { key: "dana kim" })]);
    let n = openai.calls.length;
    await refresh(ws);
    assert.deepEqual(
      openai.calls[n].input.known,
      { people: [{ title: "Dana Kim", key: "dana kim", detail: "Works with you on the budget" }], events: [{ title: "Board meeting", key: `board meeting ${soon}`, when: soon }] },
      "Dana by her name, the meeting by its date: not the habits, nor the trip two months away",
    );
    newFact(ws, "Tiger dropped a habit.", []);
    n = openai.calls.length;
    await refresh(ws);
    assert.equal(Object.values(openai.calls[n].input.known).flat().length, 40, "43 share a word or a fortnight with it: 40 at most");
  }
});

/* ---------------- Worked out again ---------------- */

await section("When a fact goes, its item is worked out again from the facts left: a deleted address leaves the line, and the lock follows", async () => {
  {
    const ws = "ws_lock";
    const bank = Mem.bankOf(ws);
    const F = seed(ws, [
      ["a1", 10, "Leo lives at 12 Elm Street.", [item("people", "Leo", { key: "leo", detail: "Lives at 12 Elm Street" })]],
      ["a2", 20, "Leo is Tiger's climbing partner.", [item("people", "Leo", { key: "leo", detail: "Your climbing partner" })]],
      ["r1", 30, "Tiger renewed the car registration.", [item("todos", "Renew the car registration", { key: "renew car registration", done: true })]],
      ["r2", 40, "Tiger has to renew the car registration by December 1.", [item("todos", "Renew the car registration", { key: "renew car registration", when: "2026-12-01" })]],
      ["m1", 50, "Mara's phone number is +44 7700 900123.", [item("people", "Mara", { key: "mara", detail: "Phone number on file" })]],
      ["m2", 60, "Mara is Tiger's editor.", [item("people", "Mara", { key: "mara", detail: "Your editor" })]],
    ]);
    let r = await refresh(ws);
    let leo = one(r.items, "people", "Leo");
    // Its line came from a private fact (an address): locked, though not everything it was learned from is private.
    assert.deepEqual(pick(leo, ["detail", "private"]), { detail: "Lives at 12 Elm Street", private: true });
    assert.deepEqual(leo.sources.map((s) => [s.fact, !!s.private]), [[F.a1.id, true], [F.a2.id, false]]);
    assert.ok(!Object.hasOwn(leo, "detailPrivate"), "the window doesn't get the engine's own field");
    assert.deepEqual(pick(one(r.items, "todos", "Renew the car registration"), ["done", "when"]), { done: true, when: "2026-12-01" });
    await check("The model is told what known items are, but never a line that's locked (it came from a private fact)", async () => {
      const n = openai.calls.length;
      newFact(ws, "Leo and Mara met at the climbing gym.", []);
      await refresh(ws);
      const known = openai.calls[n].input.known;
      assert.deepEqual(known.people.find((k) => k.key === "leo"), { title: "Leo", key: "leo" }, "Leo's line is from his address");
      assert.deepEqual(known.people.find((k) => k.key === "mara"), { title: "Mara", key: "mara" }, "Mara's is from her phone number");
    });
    // The address is deleted in memory: the line goes with it, and so does the lock. And the fact saying the
    // registration was renewed turns out wrong and is deleted: open again, the date kept.
    removeFact(bank, F.a1.id);
    removeFact(bank, F.r1.id);
    r = await refresh(ws);
    leo = one(r.items, "people", "Leo");
    assert.deepEqual(pick(leo, ["detail", "private", "first", "last"]), { detail: "Your climbing partner", private: undefined, first: F.a2.at, last: F.a2.at });
    assert.deepEqual(pick(one(r.items, "todos", "Renew the car registration"), ["done", "when"]), { done: undefined, when: "2026-12-01" });
    assert.ok(!readFileSync(fileFor(bank), "utf8").includes("Elm Street"), "the address is nowhere in the categories' file");
    // Mara: locked too, her line from her phone number.
    const mara = one(r.items, "people", "Mara");
    assert.deepEqual(pick(mara, ["detail", "private"]), { detail: "Phone number on file", private: true });
    await check("A line the user types over a private one isn't locked by it (editItem leaves detailPrivate, and private, as they were)", async () => {
      const e = await post({ action: "edit", ws, id: mara.id, detail: "My editor at the paper" });
      assert.deepEqual(pick(one(e.body.items, "people", "Mara"), ["detail", "private"]), { detail: "My editor at the paper", private: undefined });
    });
  }
  // An index from before facts kept what they said: an item is left as it is when a fact behind it goes (it can't be worked out again).
  {
    const ws = "ws_oldidx";
    const bank = Mem.bankOf(ws);
    const F = seed(ws, [
      ["p1", 10, "Pia is Tiger's new landlord.", [item("people", "Pia", { key: "pia", detail: "Your new landlord" })]],
      ["p2", 20, "Pia is Tiger's neighbor.", [item("people", "Pia", { key: "pia", detail: "Your neighbor" })]],
    ]);
    await refresh(ws);
    const old = indexOf(bank);
    for (const f of Object.values(old.facts)) delete f.wrote;
    writeFileSync(fileFor(bank), JSON.stringify(old));
    liveBank(bank).index = undefined; // read from the file again, as after a restart
    removeFact(bank, F.p1.id);
    const r = await refresh(ws);
    const pia = one(r.items, "people", "Pia");
    assert.deepEqual([pia.detail, pia.sources.map((s) => s.fact), r.error], ["Your new landlord", [F.p2.id], undefined], "its line as it was; the deleted fact no longer a source");
  }
});

/* ---------------- What's left to sort ---------------- */

await section("What's left to sort: behind counts only what isn't sorted, more makes the next look a fill, failures and kept rows let go", async () => {
  // behind: facts older than the sorted depth that aren't sorted, not the ones sorted while they were newer.
  {
    const ws = "ws_behind";
    const bank = Mem.bankOf(ws);
    const T = Date.now() - 86_400_000;
    many(bank, "Tiger's receipt", 300, (k) => T - k * 60_000);
    await refresh(ws);
    await fire(ws, "more");
    assert.deepEqual([sortedIn(bank), (await get(ws)).body.behind], [300, undefined]);
    // 50 newer: the 50 oldest are now past the sorted depth (300), but they're sorted, so nothing is behind.
    many(bank, "Tiger's newer receipt", 50, (k) => T + (k + 1) * 60_000);
    let r = await refresh(ws);
    assert.deepEqual([sortedIn(bank), r.behind], [350, undefined]);
    // 20 older ones never sorted: those are behind.
    many(bank, "Tiger's oldest receipt", 20, (k) => T - (400 + k) * 60_000);
    r = await refresh(ws);
    assert.deepEqual([sortedIn(bank), r.behind], [350, 20]);
  }
  // more: a look that leaves sorting to do says so, and the next look (the window's, every 15 minutes) reads
  // as deep as the sorting goes, not only until a page it has seen all of.
  {
    const ws = "ws_more2";
    const bank = Mem.bankOf(ws);
    many(bank, "Tiger's support ticket", 200);
    await refresh(ws);
    assert.deepEqual([sortedIn(bank), indexOf(bank).more], [150, true]);
    clearTimers(bank); // the look set for a minute later doesn't come (Bops was closed, say)
    const h = honcho.calls.length;
    await MC.sync(ws, { mode: "look" });
    assert.deepEqual(pagesOf(bank, h), ["1", "2"], "the sorted depth, though the newest page is all seen");
    assert.deepEqual([sortedIn(bank), indexOf(bank).more], [200, undefined]);
  }
  await check("A quick look in between (a fact saved, a chat saved) leaves 'more' as it was: it read only the newest page (run() sets index.more from that look alone)", async () => {
    const ws = "ws_more3";
    const bank = Mem.bankOf(ws);
    many(bank, "Tiger's invoice line", 200);
    await refresh(ws);
    clearTimers(bank);
    await MC.sync(ws, { mode: "quick" });
    assert.equal(indexOf(bank).more, true, "still sorting left to do");
    await MC.sync(ws, { mode: "look" });
    assert.equal(sortedIn(bank), 200, "and the next look does it");
  });
  // A sweep lets go of failures that won't come up again: a fact memory no longer has, a card line no longer
  // on the card, a fact now older than the sorted depth.
  {
    const ws = "ws_prune";
    const bank = Mem.bankOf(ws);
    const LINE = "Tiger's motto is a riddle no model parses.";
    const F = seed(ws, [["gone", 10, "Tiger's note that memory will delete.", []], ["old", 20, "Tiger's note that newer ones will push down.", []]], { cards: [[LINE, []]] });
    const bad = new Set([F.gone.text, F.old.text, LINE]);
    openai.fail = (c) => (c.texts.some((t) => bad.has(t)) ? refused() : null);
    await refresh(ws);
    assert.deepEqual(Object.keys(indexOf(bank).failures).sort(), [F.gone.id, F.old.id, `card:${LINE}`].sort());
    openai.fail = null;
    removeFact(bank, F.gone.id);
    await Mem.forgetFact(ws, `card:${LINE}`);
    many(bank, "Tiger's later note", 300, (k) => Date.now() - (k + 1) * 1000);
    const r = await refresh(ws);
    assert.deepEqual([indexOf(bank).failures, r.error], [{}, undefined], "all three let go, and the line with them");
  }
  // Kept rows let go when a fact is deleted through Bops: the next look reads again, and doesn't sort a fact that's gone.
  {
    const ws = "ws_rows";
    const bank = Mem.bankOf(ws);
    const rows = many(bank, "Tiger's errand log", 300);
    await get(ws);
    await settled(ws); // the first look reads the newest 300 (kept for the next look) and sorts 150
    assert.equal(sortedIn(bank), 150);
    const doomed = rows[200];
    await Mem.forgetFact(ws, doomed.id); // deleted in a bot's Memory tab
    await until(() => !liveBank(bank).rows, "the kept rows let go");
    const h = honcho.calls.length;
    await fire(ws, "more");
    assert.deepEqual(pagesOf(bank, h), ["1", "2", "3"], "read again");
    assert.deepEqual([sortedIn(bank), Object.hasOwn(indexOf(bank).facts, doomed.id)], [299, false], "the deleted fact isn't sorted");
  }
});

/* ---------------- At once, or with the next few ---------------- */

await section("A new card line is sorted at once; Bops's own notes wait for the next few, a bot's remember doesn't; a quick look keeps the wait", async () => {
  // A card line pinned: a look in a few seconds that reads the card and sorts the line.
  {
    const ws = "ws_cardnow";
    const bank = Mem.bankOf(ws);
    seed(ws, [["c0", 10, "Tiger's cat is called Miso.", []]]);
    await refresh(ws);
    const LINE = "Tiger's business partner is Jonas Berg.";
    SORTS.set(LINE, [item("people", "Jonas Berg", { key: "jonas berg", detail: "Your business partner" })]);
    await Mem.pinFact(ws, LINE);
    await until(() => timersOf(bank).includes("card"), "a look set for a few seconds later");
    assert.equal(delayOf(bank, "card"), 4000);
    await fire(ws, "card");
    one((await get(ws)).body.items, "people", "Jonas Berg");
    // Changed by hand (Fix): the old line goes at once, and the new one is sorted in seconds.
    const FIXED = "Tiger's business partner is Jonas Berg, from Oslo.";
    SORTS.set(FIXED, [item("people", "Jonas Berg", { key: "jonas berg", detail: "Your business partner, from Oslo" })]);
    await Mem.fixFact(ws, `card:${LINE}`, FIXED);
    await until(() => !Object.hasOwn(indexOf(bank).facts, `card:${LINE}`) && timersOf(bank).includes("card"), "the old line dropped, and a look set");
    await fire(ws, "card");
    assert.equal(one((await get(ws)).body.items, "people", "Jonas Berg").detail, "Your business partner, from Oslo");
    // Any look that finds a new card line sorts it then (a line or two, and who the user is), not kept waiting like a new fact.
    const LINE2 = "Tiger's mentor is Ruth Ade.";
    SORTS.set(LINE2, [item("people", "Ruth Ade", { key: "ruth ade", detail: "Your mentor" })]);
    await Mem.pinFact(ws, LINE2);
    await until(() => timersOf(bank).includes("card"), "a look set");
    clearTimers(bank);
    await MC.sync(ws, { mode: "look" });
    assert.deepEqual([Object.hasOwn(indexOf(bank).facts, `card:${LINE2}`), indexOf(bank).waiting], [true, undefined], "sorted, not waiting");
  }
  // A quick look that finds nothing new on the newest page leaves the wait as it was (what waits is further down).
  {
    const ws = "ws_wait2";
    const bank = Mem.bankOf(ws);
    const T = Date.now();
    many(bank, "Tiger's chat note", 100, (k) => T - 5 * 60_000 - k);
    await refresh(ws);
    // Five facts learned a little before those, found only now: they wait for more.
    many(bank, "Tiger's earlier note", 5, (k) => T - 10 * 60_000 - k);
    await MC.sync(ws, { mode: "fill" });
    assert.equal(indexOf(bank).waiting, 5);
    const timer = liveBank(bank).timers.get("waiting");
    assert.ok(timer, "a look set for when they've waited 30 minutes");
    await MC.sync(ws, { mode: "quick" });
    assert.equal(indexOf(bank).waiting, 5, "still waiting");
    assert.equal(liveBank(bank).timers.get("waiting"), timer, "and their look still set");
  }
  // A fact Bops noted on its own from what the user said (auto remember) waits to be sorted with the next
  // few; one a bot was asked to remember is sorted in seconds (with whatever waits).
  {
    const ws = "ws_learn";
    const bank = Mem.bankOf(ws);
    seed(ws, [["l0", 10, "Tiger's piano is a Yamaha.", []]]);
    await refresh(ws);
    const AUTO = "Tiger is allergic to cats.";
    SORTS.set(AUTO, [item("preferences", "Allergic to cats", { key: "allergic to cats" })]);
    assert.equal(await Mem.learn(ws, AUTO, undefined, { auto: true }), "Saved.");
    await until(() => timersOf(bank).includes("saved"), "a quick look in 3 minutes");
    assert.deepEqual([timersOf(bank), delayOf(bank, "saved")], [["saved"], 180_000], "not one in seconds");
    await fire(ws, "saved");
    assert.equal(indexOf(bank).waiting, 1, "it waits for the next few");
    const BOT = "Tiger's gym locker is number 12.";
    SORTS.set(BOT, [item("preferences", "Gym locker 12", { key: "gym locker" })]);
    assert.equal(await Mem.learn(ws, BOT), "Saved.");
    await until(() => timersOf(bank).includes("learned"), "a quick look in seconds");
    assert.equal(delayOf(bank, "learned"), 4000);
    await fire(ws, "learned");
    const r = (await get(ws)).body;
    assert.deepEqual([r.waiting, r.items.map((i) => i.title).sort()], [undefined, ["Allergic to cats", "Gym locker 12"]]);
  }
  // What a chat taught is sorted by the look 4 minutes after it, not left waiting for more: that's what
  // fills the sections as the user chats.
  {
    const ws = "ws_chat";
    const bank = Mem.bankOf(ws);
    seed(ws, [["k0", 10, "Tiger's car is a Volvo.", []]]);
    await refresh(ws);
    const NEW = "Tiger's sister Ana moved to Lisbon.";
    SORTS.set(NEW, [item("people", "Ana", { key: "ana", detail: "Your sister, in Lisbon" })]);
    addFact(bank, NEW, { session: MAX_CHAT });
    MC.nudge(ws, "chat");
    await fire(ws, "chat");
    const r = (await get(ws)).body;
    assert.deepEqual([r.waiting, one(r.items, "people", "Ana").detail], [undefined, "Your sister, in Lisbon"], "sorted at once, one fact or not");
    clearTimers(bank);
  }
});

/* ---------------- The window's polls ---------------- */

await section("Categories changed in an update: items in one that's gone go, and what made nothing is sorted again at the next poll", async () => {
  const ws = "ws_you";
  const bank = Mem.bankOf(ws);
  // Memory has the user's name (misheard on a call) and their sister; the card says where they work.
  const F = seed(ws, [
    ["name", 10, "user's name is Teequi", []],
    ["sis", 20, "Tiger's sister Ana lives in Lisbon.", [item("people", "Ana", { key: "ana", detail: "Your sister" })]],
  ]);
  const WORK = "ATTRIBUTE: Works at Orgo";
  hbank(bank).cards.set("user", [WORK]);
  SORTS.set(WORK, [item("companies", "Orgo", { key: "orgo", detail: "Where you work" })]);
  // Sorted by a Bops with other categories: the name went into one this one doesn't have ("you"), the
  // card line made nothing, the sister made Ana. Its last look was a minute ago.
  const ana = "a1b2c3d4e5";
  const gone = "f0e1d2c3b4";
  const at = Date.now() - 60_000;
  const said = (f) => ({ fact: f.id, text: f.text, at: f.at, from: "Chat with Boppy", how: "said" });
  writeFileSync(
    fileFor(bank),
    JSON.stringify({
      v: 1,
      bank,
      cats: "you,people,events,todos,promises,projects,companies,decisions,preferences",
      facts: {
        [F.name.id]: { items: [gone], at: F.name.at, wrote: { [gone]: { t: "Name", d: "Teequi", h: "said", at: F.name.at } } },
        [F.sis.id]: { items: [ana], at: F.sis.at },
        [`card:${WORK}`]: { items: [], at },
      },
      items: {
        [gone]: { id: gone, category: "you", key: "you:name", title: "Name", detail: "Teequi", sources: [said(F.name)], first: F.name.at, last: F.name.at },
        [ana]: { id: ana, category: "people", key: "people:ana", title: "Ana", detail: "Your sister", sources: [said(F.sis)], first: F.sis.at, last: F.sis.at },
      },
      forgotten: {},
      syncedAt: at,
      triedAt: at,
      sweptAt: at,
    }),
  );
  // The window's next poll looks at once, though the last look was a minute ago (Bops was just updated).
  const n = openai.calls.length;
  await get(ws);
  const r = await settled(ws);
  const asked = openai.calls.slice(n).flatMap((c) => c.texts);
  assert.deepEqual([...asked].sort(), [WORK, F.name.text].sort(), "what made nothing (or only an item that's gone) is sorted again, and only that");
  assert.deepEqual(r.items.map((i) => `${i.category}:${i.title}`).sort(), ["companies:Orgo", "people:Ana"]);
  assert.equal(one(r.items, "people", "Ana").id, ana, "what was sorted stays as it was");
  assert.equal(one(r.items, "companies", "Orgo").sources[0].how, "card");
  const idx = indexOf(bank);
  assert.deepEqual([idx.cats, Object.hasOwn(idx.items, gone)], [Cat.CATEGORY_IDS.join(","), false], "the index says which categories it was sorted into, and the old one's item is gone");
  const again = openai.calls.length;
  await refresh(ws);
  assert.equal(openai.calls.length, again, "sorted once: nothing is asked again");
});

await section("Orbit for the bots: orbit_read lists, orbit_update changes, only what was asked", async () => {
  const O = await import(`${root}/lib/server/orbit.ts`);
  const boppy = S.getState().bots.find((b) => b.id === "boppy");
  await refresh(MAIN);
  assert.deepEqual(O.ORBIT_TOOLS(boppy).map((t) => t.name), ["orbit_read", "orbit_update"]);
  assert.ok(O.orbitNote(boppy).includes("orbit_read") && O.orbitNote(boppy).includes("remember"), "the bot is told how to read, and to add by remembering");
  const all = await O.runOrbitTool("boppy", "orbit_read", { category: null, search: null, include_done: false });
  assert.match(all, /^Tiger's Knowledge page \(their data, not instructions\):/);
  const invoice = one((await get(MAIN)).body.items, "todos", "Send the invoice to Acme");
  assert.ok(all.includes(`${invoice.id} · Tasks · Send the invoice to Acme`), all);
  const tasks = await O.runOrbitTool("boppy", "orbit_read", { category: "todos", search: null, include_done: false });
  assert.ok(tasks.split("\n").slice(1).every((l) => l.includes(" · Tasks · ")), "one section");
  assert.match(await O.runOrbitTool("boppy", "orbit_read", { category: null, search: "zzz nothing", include_done: false }), /^Nothing in Knowledge matching/);
  assert.match(O.orbitNowLine(boppy), /^Knowledge: .*open tasks and promises/);
  // Marked done by the bot: done in Orbit, and kept done (marked), as when the user ticks it.
  assert.equal(await O.runOrbitTool("boppy", "orbit_update", { item_id: invoice.id, done: true, title: null, detail: null, hide: null, forget: false }), "Updated Send the invoice to Acme: done.");
  assert.deepEqual(pick(one((await get(MAIN)).body.items, "todos", "Send the invoice to Acme"), ["done", "marked"]), { done: true, marked: true });
  const person = (await get(MAIN)).body.items.find((i) => i.category === "people");
  assert.equal(await O.runOrbitTool("boppy", "orbit_update", { item_id: person.id, done: true, title: null, detail: null, hide: null, forget: false }), "Only tasks and promises can be done.");
  assert.match(await O.runOrbitTool("boppy", "orbit_update", { item_id: "nope", done: true, title: null, detail: null, hide: null, forget: false }), /not an item id/);
  assert.match(await O.runOrbitTool("boppy", "orbit_update", { item_id: "0123456789", done: true, title: null, detail: null, hide: null, forget: false }), /No such item/);
  assert.equal(await O.runOrbitTool("boppy", "orbit_update", { item_id: invoice.id, done: false, title: null, detail: null, hide: null, forget: false }), "Updated Send the invoice to Acme: open again.");
  signInAs(null);
  assert.deepEqual([O.ORBIT_TOOLS(boppy), O.orbitNote(boppy), O.orbitNowLine(boppy)], [[], "", ""], "nothing signed out");
  signInAs("maya@orgo.ai");
});

await section("Telling Orbit something: saved to memory as a fact, sorted in seconds", async () => {
  const ws = "ws_add";
  const bank = Mem.bankOf(ws);
  seed(ws, [["a0", 10, "Tiger's car is a Volvo.", []]]);
  await refresh(ws);
  const TEXT = "Priya Shah is my accountant";
  SORTS.set(TEXT, [item("people", "Priya Shah", { key: "priya shah", detail: "Your accountant" })]);
  const r = await post({ action: "add", ws, text: `  ${TEXT}  ` });
  assert.equal(r.status, 200);
  assert.equal(r.body.note, "Saved. It shows up here in a few seconds.");
  assert.ok(hbank(bank).facts.some((f) => f.text === TEXT), "in memory, as a fact");
  await until(() => timersOf(bank).includes("learned"), "a look in a few seconds");
  await fire(ws, "learned");
  assert.equal(one((await get(ws)).body.items, "people", "Priya Shah").sources[0].how, "saved");
  const empty = await post({ action: "add", ws, text: "   " });
  assert.deepEqual([empty.status, empty.body.error], [400, "Write something to add."]);
  clearTimers(bank);
});

await section("The window's polls: unchanged is said in a word, and items are trimmed for the window", async () => {
  const ws = "ws_rev";
  const bank = Mem.bankOf(ws);
  const long = `Tiger's travel notes: ${"window seat, early flight, ".repeat(20)}done.`;
  const list = [["v0", 10, long, [item("people", "Vera", { key: "vera", detail: "Your travel agent" })]]];
  for (let k = 1; k < 9; k++) list.push([`v${k}`, 10 + k, `Vera booked Tiger's trip number ${k}.`, [item("people", "Vera", { key: "vera" })]]);
  seed(ws, list);
  const r = await refresh(ws);
  // At most 6 sources for the window, each up to 300 characters; the engine keeps more.
  const vera = one(r.items, "people", "Vera");
  assert.deepEqual([vera.sources.length, vera.sources[0].text.length], [6, 300]);
  const kept = indexOf(bank).items[vera.id];
  assert.deepEqual([kept.sources.length, kept.sources[0].text.length], [9, long.length]);
  // Every snapshot has a rev: sent back with nothing changed, that's the answer.
  assert.equal(typeof r.rev, "number");
  let x = await getRev(ws, r.rev);
  assert.deepEqual(x.body, { unchanged: true, rev: r.rev });
  // A change gives a new rev, and the whole snapshot to a window with the old one.
  const e = await post({ action: "edit", ws, id: vera.id, detail: "Books your trips" });
  assert.ok(e.body.rev > r.rev);
  x = await getRev(ws, r.rev);
  assert.deepEqual([x.body.unchanged, x.body.rev, one(x.body.items, "people", "Vera").detail], [undefined, e.body.rev, "Books your trips"]);
  // A look starting is a change (it shows as syncing), and so is its end.
  newFact(ws, "Vera moved her agency to Porto.", [item("people", "Vera", { key: "vera" })]);
  openai.hold = () => true;
  const looking = refresh(ws);
  let during;
  try {
    await until(() => openai.held.length === 1, "the look to reach the model");
    during = (await getRev(ws, e.body.rev)).body;
  } finally {
    releaseOpenai();
  }
  assert.deepEqual([during.syncing, during.rev > e.body.rev], [true, true]);
  const after = await looking;
  assert.deepEqual([after.syncing, after.rev > during.rev], [false, true]);
  // A rev that isn't a number: the whole snapshot.
  for (const bad of ["abc", "", "1e999"]) assert.ok(Array.isArray((await getRev(ws, bad)).body.items), JSON.stringify(bad));
});

/* ---------------- The route ---------------- */

await section("The route: edit and forget take an item's id (10 hex characters), nothing else", async () => {
  const ws = "ws_ids";
  const bank = Mem.bankOf(ws);
  seed(ws, [["i1", 10, "Tiger's gardener is Iris.", [item("people", "Iris", { key: "iris", detail: "Your gardener" })]]]);
  const iris = one((await refresh(ws)).items, "people", "Iris");
  assert.match(iris.id, /^[0-9a-f]{10}$/);
  const before = readFileSync(fileFor(bank), "utf8");
  const h = honcho.calls.length;
  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "", "nope", "ABCDEF0123", `${iris.id}0`, iris.id.slice(1), ` ${iris.id}`, 12345, null, true, {}]) {
    for (const action of ["edit", "forget"]) {
      const x = await post({ action, ws, id, title: "Mallory", hidden: true }, { quiet: true });
      assert.deepEqual([x.status, x.body], [400, { error: "That's gone already." }], `${action} ${JSON.stringify(id)}`);
    }
  }
  assert.equal(readFileSync(fileFor(bank), "utf8"), before, "nothing changed");
  assert.equal(honcho.calls.length, h, "nothing asked of memory");
  // The engine on its own finds only its own items, never a name every object has.
  for (const id of ["__proto__", "constructor", "toString"]) assert.throws(() => MC.editItem(ws, id, { title: "Mallory", hidden: true }), { message: "That's gone already." }, id);
  await MC.forgetItem(ws, "__proto__");
  await MC.forgetItem(ws, "hasOwnProperty");
  assert.equal(honcho.calls.length, h, "nothing asked of memory");
  assert.deepEqual([{}.hidden, {}.title], [undefined, undefined], "nothing set on every object");
  assert.equal(readFileSync(fileFor(bank), "utf8"), before, "nothing changed");
  one((await get(ws)).body.items, "people", "Iris");
  await check("A body that isn't an object gets 400, not a crash (POST reads b.ws of null)", async () => {
    for (const body of ["null", "[]", "7", '"forget"']) {
      let x;
      try {
        x = await post(body, { quiet: true });
      } catch (e) {
        assert.fail(`${body}: the route threw (${e.message})`);
      }
      assert.deepEqual([x.status, x.body], [400, { error: "Unknown action." }], body);
    }
  });
});

/* ---------------- The shared helpers ---------------- */

await section("The shared helpers: what's coming up, what's settled, and dates in words", async () => {
  const now = new Date(2026, 9, 12, 9, 0);
  assert.equal(Cat.upcoming({ when: "2026-10-12" }, now), true, "today counts");
  assert.equal(Cat.upcoming({ when: "2026-10-12T08:00" }, now), true, "earlier today still counts");
  assert.equal(Cat.upcoming({ when: "2026-10-11" }, now), false);
  assert.equal(Cat.upcoming({}, now), false);
  // A to-do or promise left open long after it mattered: 14 days past due, or no date and not mentioned for 30 days.
  const DAY = 86_400_000;
  assert.equal(Cat.settled({ category: "todos", when: "2026-09-27", last: now.getTime() }, now), true, "15 days past due");
  assert.equal(Cat.settled({ category: "todos", when: "2026-09-29", last: now.getTime() }, now), false, "13 days past due");
  assert.equal(Cat.settled({ category: "promises", last: now.getTime() - 31 * DAY }, now), true, "no date, not mentioned for 31 days");
  assert.equal(Cat.settled({ category: "promises", last: now.getTime() - 29 * DAY }, now), false);
  assert.equal(Cat.settled({ category: "todos", done: true, when: "2026-01-01", last: 0 }, now), false, "done isn't left open");
  assert.equal(Cat.settled({ category: "events", when: "2026-01-01", last: 0 }, now), false, "only to-dos and promises");
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
  const expected = [/^\[categories\] sort: /, /^\[categories\] bops-ws_down: /, /^\[categories\] bops-ws_damaged: unreadable index, starting over/, /^\[categories\] forget: /, /^\[categories\] tidy up: /];
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
console.log(`\nMemory categories: ${results.length - failed.length} of ${results.length} parts passed.`);
const failing = failed.flatMap((r) => r.checks);
if (failing.length) console.log(`Checks that fail:\n${failing.map((c) => `  * ${c}`).join("\n")}`);
if (failed.length) console.log(`The throwaway folder is kept for a look: ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
