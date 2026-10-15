// Tests for monitors: the steady form pages are compared in (cloud/page-diff.ts: only what's certainly
// noise out, such as relative times, stamps, timers and ids; slots, prices, counts and ranks kept), and web
// page watches (lib/server/watches.ts, app/api/watches): the first read is how the page is; a page that
// didn't change, or only changed its stamps, costs no model call and writes nothing; lines that were added
// get exactly one judge call (Jev, or one quick OpenAI call when Jev isn't there; up to 200 lines, the rest
// judged at the next read) and a heads-up when they match; a line that went and comes back is new again
// (a status that returns is told again once the user saw the first alert); a page that fails, or a web
// page that comes back with no text, is read less and less often until it answers again (JSON or text
// that's empty is just empty); a paused watch is left alone until it's resumed or checked by hand. Screen
// watches compare pages the same way, with a feed's counts aside too (a clock or a view count on the
// screen is not a change), and a page watch doesn't keep a bot from moving computers the way a screen
// watch does.
//
// The pages come from a local server here, let through safe-fetch with BOPS_FETCH_ALLOW (the real
// lib/server/web-page.ts reads them). Jev and OpenAI are fakes; the state lives in a throwaway folder;
// nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-monitors.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
// A self-hosted install: the state is a file in the working folder, the model is OpenAI on its own key.
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
process.env.OPENAI_API_KEY = "sk-test-monitors";
process.env.BOPS_CHAT_MODEL = "gpt-test-monitors";
// The judge runs on the light model (routing.ts LIGHT).
process.env.BOPS_LIGHT_MODEL = "gpt-test-monitors";
const JEV_KEY = "ts-test-monitors";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-monitors-"));
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
process.chdir(scratch);

// The watches' clock: moved forward by the parts that wait (a page's minutes between reads). Only ever forward.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const wait = (minutes) => void (skew += minutes * 60_000);

// Modules that would start processes when loaded are stand-ins whose exports do nothing. The bot's
// screens (local.ts) answer with the page a part sets in `screen`.
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "local", "mac-windows"]);
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
    const own = name === "local" ? { pageLines: "async (ep) => globalThis.__testScreen(ep)" } : {};
    const source = names.map((n) => `export const ${n} = ${own[n] ?? "function () { return Promise.resolve(); }"};`).join("\n");
    return { format: "module", shortCircuit: true, source };
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* ---------------- The pages: a local server ---------------- */

// What each path answers: { status, type, body }, and how many times each was read.
const pages = new Map();
const hits = new Map();
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  hits.set(path, (hits.get(path) ?? 0) + 1);
  const p = pages.get(path);
  if (!p) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<h1>Not found</h1>");
  }
  if (p.status === "hang") return req.socket.destroy();
  res.writeHead(p.status ?? 200, { "content-type": p.type ?? "text/html; charset=utf-8" });
  res.end(p.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
process.env.BOPS_FETCH_ALLOW = `127.0.0.1:${PORT}`;
const at = (path) => `http://127.0.0.1:${PORT}${path}`;
const html = (title, lines) => `<!doctype html><html><head><title>${title}</title><script>var t = Date.now()</script></head><body>${lines.map((l) => `<p>${l}</p>`).join("")}</body></html>`;
const serve = (path, title, lines, opts = {}) => pages.set(path, { body: html(title, lines), ...opts });
const hitsOf = (path) => hits.get(path) ?? 0;

/* ---------------- Jev and OpenAI: fakes ---------------- */

// Jev: every call's questions and state. `jev.waiting(state)` says how sure it is that a page's new lines
// match (the page judge), `jev.item(state)` which line; `jev.screen` answers a screen's look.
const jev = { calls: [], waiting: () => 0.9, item: () => "l0", screen: { on_target: 1, waiting: 0.9 } };
const isJudge = (c) => "waiting" in c.questions && "added" in (c.state ?? {});
const isScreenRead = (c) => "on_target" in c.questions;
async function jevAnswer(req) {
  const body = JSON.parse(await req.text());
  jev.calls.push(body);
  const answers = {};
  for (const [k, q] of Object.entries(body.questions)) {
    if (k === "level") answers[k] = { type: "choice", choice: "now", confidence: 0.9, probabilities: { now: 0.9 } };
    else if (k === "waiting") answers[k] = { type: "noul", noul: isJudge(body) ? jev.waiting(body.state) : jev.screen.waiting };
    else if (k === "on_target") answers[k] = { type: "noul", noul: jev.screen.on_target };
    else if (k === "item") {
      const choice = isJudge(body) ? jev.item(body.state, q) : "l0";
      answers[k] = { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
    } else answers[k] = { type: "noul", noul: 0 };
  }
  return json({ answers, model: "jev-test", usage: { input_tokens: 120 } });
}

// OpenAI: the page judge's calls (format watch_judgment) and what it answers next; anything else refused.
const openai = { calls: [], other: [], answer: () => ({ matches: true, line: 0 }), fail: null };
const response = (text) => ({
  id: `resp_${openai.calls.length}`,
  object: "response",
  model: "gpt-test-monitors",
  status: "completed",
  output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 200, output_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});
async function openaiAnswer(req) {
  const body = JSON.parse(await req.text());
  if (body.text?.format?.name !== "watch_judgment") {
    openai.other.push(body);
    return json({ error: { message: "not faked", type: "invalid_request_error" } }, 400);
  }
  const input = JSON.parse(body.input);
  openai.calls.push({ body, input });
  if (openai.fail) return json({ error: { message: openai.fail, type: "invalid_request_error" } }, 400);
  return json(response(JSON.stringify(openai.answer(input))));
}

// Everything else is offline (the pages are read with node:http, not fetch).
const offline = [];
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") return openaiAnswer(req);
  if (url.origin === "https://api.typesafe.ai" && url.pathname === "/v1/systemone") return jevAnswer(req);
  offline.push(req.url);
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const PD = await import(`${root}/cloud/page-diff.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const W = await import(`${root}/lib/server/watches.ts`);
const R = await import(`${root}/app/api/watches/route.ts`);
const Bots = await import(`${root}/lib/server/bots.ts`);
const { botChatId, isScreenWatch, PAGE_WATCH_DEFAULT_MIN, PAGE_WATCH_MIN_MIN } = await import(`${root}/lib/types.ts`);
// The loop is the test's to run (one tick: the same look the interval makes), never on its own.
clearInterval(globalThis.__bopsWatches);
const tick = (watchId) => globalThis.__bopsLook(watchId);

/* ---------------- Helpers ---------------- */

/** Everything the user could read (replies, errors, heads-ups, what the bot says), checked for dashes at the end. */
const spoken = [];
// (A "- " starting a line is a list in a bot's note, not a dash.)
const noDashes = (text) => assert.ok(!/[\u2013\u2014]|\S - \S/.test(String(text)), `no dashes: ${text}`);
const failures = [];
let part = "";
/** One named rule inside a part: a failure is reported by name, and the rest of the part still runs. */
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    failures.push(`${part} › ${name}: ${e.message}`);
  }
}
const parts = [];
const test = (name, fn) => parts.push([name, fn]);
const watchOf = (watchId) => S.getState().watches?.find((w) => w.id === watchId);
const headsUps = (watchId) => S.getState().messages.filter((m) => m.watch?.id === watchId);
const request = async (handler, method, path, body) => {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handler(new Request(`http://localhost:3210${path}`, init));
  const out = { status: res.status, body: await res.json() };
  if (out.body?.error) spoken.push(out.body.error);
  return out;
};
const jevOn = () => void (process.env.TYPESAFE_API_KEY = JEV_KEY);
const jevOff = () => void delete process.env.TYPESAFE_API_KEY;
/** Start a page watch for Boppy on a fresh path, with Jev on or off. */
async function pageWatch(path, lines, opts = {}) {
  serve(path, opts.title ?? "Prices", lines);
  const w = await W.startPageWatch("boppy", { url: at(path), lookFor: opts.lookFor ?? "Bitcoin above $86,000", everyMin: opts.everyMin });
  return w.id;
}
const BASE = ["Bitcoin $85,100", "Ethereum $3,050", "Updated 3:45 PM", "Posted 5 minutes ago", "1,204 watching", "Prices refresh every minute"];

S.update((s) => {
  s.owner = { name: "Tiger" };
  s.bots.push({ id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "none", computer: "own" });
  s.chats.push({ id: botChatId("max"), kind: "bot", botIds: ["max"], createdAt: 0, typing: [] });
});
assert.ok(S.getState().bots.some((b) => b.id === "boppy"), "a fresh state has Boppy");

/* ---------------- The steady form (cloud/page-diff.ts) ---------------- */

test("normalizeLine: only what's certainly noise goes; everything else is the judge's", async () => {
  const table = [
    // Relative times, and their stamp word with them.
    ["Posted 5 minutes ago", ""],
    ["2h ago", ""],
    ["just now", ""],
    ["about an hour ago", ""],
    ["updated 3 days ago", ""],
    ["Updated yesterday at 3:45 PM", ""],
    ["yesterday", ""],
    ["Comment from Dana, 12 min ago", "Comment from Dana"],
    ["@jordan · 2h", "@jordan"],
    // Countdowns and timers that tick ("in 2 days" moves once a day, and may be news).
    ["Sale ends in 3 hours", "Sale ends"],
    ["in 3 hours", ""],
    ["Sale ends in 02:15:33", "Sale ends"],
    ["Auction ends in 1:23:45", "Auction ends"],
    ["Market closes in 2:14:59", "Market closes"],
    ["Order within 3 hrs 12 mins", "Order"],
    ["Ends in 3h 12m", "Ends"],
    ["Next refresh in 45 seconds", "Next refresh"],
    ["Time left: 2h 15m", ""],
    ["Elapsed: 01:23:45", ""],
    ["Ends in 1 day 04:13:22", "Ends"],
    ["Sale ends in 2d 04:13:22", "Sale ends"],
    ["Deal of the day: 04:13:22 left", "Deal of the day"],
    ["Ends in: 04:13:22", "Ends"],
    ["Time left: 2d 4h", ""],
    ["Time left: 2 days", "Time left: 2 days"],
    ["5 hr. ago", ""],
    ["1 mo. ago", ""],
    ["Reply from dana · 3 min. ago", "Reply from dana"],
    ["Ships in 2 days", "Ships in 2 days"],
    ["2 days left to apply", "2 days left to apply"],
    ["Sign in as Tiger", "Sign in as Tiger"],
    // A date or time after a word that says it stamps the page, in the forms pages use.
    ["Updated 3:45 PM", ""],
    ["Last updated: 15:45:10", ""],
    ["As of 3:45 PM", ""],
    ["Last updated: October 13, 2026 at 3:45 PM", ""],
    ["Last updated: Mon, 13 Oct 2026 15:45:10 GMT", "Last updated"],
    ["Updated: 13 Oct 2026, 15:45", ""],
    ["Updated Oct 13, 2026, 3:45 PM", ""],
    ["Updated 3:45 PM ET, Oct 13", ""],
    ["Last updated on 13 Oct at 15:45", ""],
    ["Generated on Mon Oct 13 15:45:10 UTC 2026", ""],
    ["Data as of Oct 13, 2026 3:45 PM ET", "Data"],
    ["Prices as of 3:45 PM ET on Oct 13", "Prices"],
    ["Last sync: 3:45 PM", ""],
    ["Last refresh 3:45:10 PM", ""],
    ["Refreshed at 3:45:10 PM", ""],
    ["Current time: Mon 15:45", ""],
    ["Last checked 3:45 PM by the system", "by the system"],
    ["Posted today at 3:45 PM", ""],
    ["Built 2026-10-13 15:45 UTC", ""],
    ["Bitcoin $86,200 · updated 4:40 PM", "Bitcoin $86,200"],
    ["Fetched at 15:45:10", ""],
    ["Retrieved 3:45 PM", ""],
    ["Cached 15:45", ""],
    ["Time now: 15:45", ""],
    ["Page loaded 3:45 PM", "Page"],
    ["Last update: Oct 13, 2026 15:45", ""],
    ["Generated Mon Oct 13 15:45:10 UTC 2026", ""],
    ["Updated 10/13 3:45 PM", ""],
    // A stamp never takes a number that only might be its date: a 4-digit number with a word after it, or a fraction.
    ["Updated Oct 13, 2026 2024 sold", "2024 sold"],
    ["Updated Oct 13 2024 sold", "2024 sold"],
    ["Tickets as of today 1500 remaining", "Tickets 1500 remaining"],
    ["Last updated 15:45 1023 outages reported", "1023 outages reported"],
    ["Status as of 15:45 2500 customers affected", "Status 2500 customers affected"],
    ["As of 3:45 PM, 1500 customers affected", "1500 customers affected"],
    ["Updated today 1500 seats left", "1500 seats left"],
    ["Price as of Oct 13 1299 USD", "Price 1299 USD"],
    ["As of Oct 13 2000 units", "2000 units"],
    ["Updated: Oct 13, 2026, 1500 seats left", "1500 seats left"],
    ["Updated 10/13 1350 USD", "Updated 10/13 1350 USD"],
    ["Updated 10/13/2026 1350 USD", "1350 USD"],
    ["As of 3/4 cup", "As of 3/4 cup"],
    ["Checked 3/4 boxes", "Checked 3/4 boxes"],
    ["Synced 3/5 devices", "Synced 3/5 devices"],
    // A stamp word with no date or time after it stays.
    ["Updated 3 items", "Updated 3 items"],
    ["Posted 12 jobs on Oct 13", "Posted 12 jobs on Oct 13"],
    ["Updated: may require a restart", "Updated: may require a restart"],
    // Full timestamps with seconds, as machines write them.
    ["2026-10-13T15:45:10Z", ""],
    ["Log 2026-10-13 15:45:10 started", "Log started"],
    ["Mon, 13 Oct 2026 15:45:10 +0000", ""],
    ["Tue Oct 13 2026 15:45:10 GMT-0700 (Pacific Daylight Time)", ""],
    ["Loaded Tue Oct 13 2026 15:45:10 GMT+0200", "Loaded"],
    ["10/13/2026, 3:45:10 PM", ""],
    ["13.10.2026, 15:45:10", ""],
    // Ids and cache busters.
    ["app.js?v=a1b2c3d4e5f6a7b8c9d0", "app.js?v="],
    ["Request 550e8400-e29b-41d4-a716-446655440000 done", "Request done"],
    ["Session 9fJ2kq8ZLmP3xT7vQa1B", "Session"],
    // Times and dates that are what's on the page stay: alone on a line, in a table cell, between words.
    ["9:00 AM", "9:00 AM"],
    ["3:45", "3:45"],
    ["Today 3:00 PM", "Today 3:00 PM"],
    ["Prices · 3:45 PM", "Prices · 3:45 PM"],
    ["Sat Oct 18 · 8:10 AM · 4 players · Book", "Sat Oct 18 · 8:10 AM · 4 players · Book"],
    ["UA 123 · Chicago · 16:30", "UA 123 · Chicago · 16:30"],
    ["Kiel · 28:25 · Flensburg", "Kiel · 28:25 · Flensburg"],
    ["Meet at 9:05 a.m. EST", "Meet at 9:05 a.m. EST"],
    ["Departs 16:30", "Departs 16:30"],
    ["Ships 10/14/2026", "Ships 10/14/2026"],
    ["Next available: 11/30/2026 9:00 AM", "Next available: 11/30/2026 9:00 AM"],
    ["Appointment 2026-11-30", "Appointment 2026-11-30"],
    ["Bulletin · 10/13/2026", "Bulletin · 10/13/2026"],
    ["10/13/2026", "10/13/2026"],
    // Counts and ranks stay (a watch may be for them; the judge is told when they aren't news).
    ["1.2K views", "1.2K views"],
    ["Likes: 340", "Likes: 340"],
    ["1,204 watching", "1,204 watching"],
    ["3,401 followers", "3,401 followers"],
    ["Alice · 1,234 votes", "Alice · 1,234 votes"],
    ["123 points by pg 2 hours ago | hide | 45 comments", "123 points by pg | hide | 45 comments"],
    ["3. Bops ships monitors", "3. Bops ships monitors"],
    // Kept as they are.
    ["Bitcoin 86,200", "Bitcoin 86,200"],
    ["$49 / month", "$49 / month"],
    ["Bitcoin $86,200.15 (+2.3%)", "Bitcoin $86,200.15 (+2.3%)"],
    ["-2.3% today", "-2.3% today"],
    ["Dow down 500 points", "Dow down 500 points"],
    ["Version 2.10.15 released", "Version 2.10.15 released"],
    ["internationalization", "internationalization"],
    ["16:9 screen", "16:9 screen"],
    ["Today's deals", "Today's deals"],
    ["  lots   of\tspace  ", "lots of space"],
    ["· | ·", ""],
  ];
  for (const [line, want] of table)
    await check(JSON.stringify(line), () => {
      assert.equal(PD.normalizeLine(line), want);
      assert.equal(PD.normalizeLine(PD.normalizeLine(line)), want, "normalizing twice changes nothing");
    });
  await check("a title loses every date and time", () => {
    assert.equal(PD.normalizeTitle("Inbox 3:45 PM 10/13/2026"), "Inbox");
    assert.equal(PD.normalizeTitle("Inbox 10/13"), "Inbox");
  });
});

test("screenLines: a screen's counts and bare ages are out too, so a feed doesn't cost a read every look", async () => {
  const table = [
    ["123 reactions · 45 comments", "reactions · comments"],
    ["12K views", "views"],
    ["1.2K watching", "watching"],
    ["123 points by pg | hide | 45 comments", "points by pg | hide | comments"],
    ["Likes: 340", "Likes"],
    ["3,401 followers", "followers"],
    ["5 online", "online"],
    ["12 replies · 3 reposts · 1.5M+ shares", "replies · reposts · shares"],
    ["Alice · 1,234 votes", "Alice · votes"],
    ["Dana Smith 2h", "Dana Smith"],
    ["Dana Smith · 2h", "Dana Smith"],
    ["Posted 5 hr. ago", ""],
    // What isn't a count stays: a price, a version, a slot, a message.
    ["Bitcoin $86,200", "Bitcoin $86,200"],
    ["Version 2.10.15 released", "Version 2.10.15 released"],
    ["Sat Oct 18 · 8:10 AM · 4 players · Book", "Sat Oct 18 · 8:10 AM · 4 players · Book"],
    ["Them: are you free at 5?", "Them: are you free at 5?"],
    ["3. Bops ships monitors", "3. Bops ships monitors"],
  ];
  for (const [line, want] of table) await check(JSON.stringify(line), () => assert.deepEqual(PD.screenLines([line]), want ? [want] : []));
  await check("a feed whose counts ticked looks the same; a new post doesn't", () => {
    const feed = (v, c) => ["Dana posted a photo", `${v} views · ${c} comments`, "Sam shared an article", `${c + 4} likes`];
    assert.deepEqual(PD.screenLines(feed(1200, 45)), PD.screenLines(feed(1350, 52)));
    assert.notDeepEqual(PD.screenLines(feed(1200, 45)), PD.screenLines([...feed(1200, 45), "Jordan posted a video"]));
  });
  await check("page watches keep counts", () => assert.equal(PD.normalizeLine("1.2K views"), "1.2K views"));
});

test("pageLinesOf and newLines", async () => {
  const lines = (raw) => PD.pageLinesOf(raw);
  const added = (before, after) => PD.newLines(PD.snapshotOf(lines(before)).digests, lines(after)).map((l) => l.raw);
  await check("empties dropped, each line once as the page has it, in order", () =>
    assert.deepEqual(PD.normalizeLines(["B 1", "Updated 3:45 PM", "A", "B 1", "Updated 2m ago", "A  "]), ["B 1", "A"]));
  await check("only the lines new since before, as the page has them", () =>
    assert.deepEqual(added(["Bitcoin $85,100", "Updated 3:45 PM", "5 min ago"], ["Updated 3:52 PM", "Bitcoin  $86,200", "Bitcoin $85,100", "6 min ago", "Bitcoin  $86,200"]), ["Bitcoin $86,200"]));
  await check("two lines that differ only by a date both stay", () => {
    assert.deepEqual(PD.normalizeLines(["Bulletin 10/14/2026", "Bulletin 10/13/2026"]), ["Bulletin 10/14/2026", "Bulletin 10/13/2026"]);
    assert.notEqual(PD.snapshotOf(lines(["Bulletin 10/14/2026", "Bulletin 10/13/2026"])).hash, PD.snapshotOf(lines(["Bulletin 10/13/2026"])).hash);
    assert.deepEqual(added(["Bulletin 10/13/2026"], ["Bulletin 10/14/2026", "Bulletin 10/13/2026"]), ["Bulletin 10/14/2026"]);
  });
  await check("a new slot, a new departure time, a new score, a count that moved are changes", () => {
    for (const [a, b] of [
      ["9:00 AM", "2:00 PM"],
      ["Sat Oct 18 · 8:10 AM · 4 players · Book", "Sat Oct 18 · 1:30 PM · 4 players · Book"],
      ["UA 123 · Chicago · 16:30", "UA 123 · Chicago · 17:05"],
      ["Kiel · 28:25 · Flensburg", "Kiel · 29:25 · Flensburg"],
      ["Next available: 11/30/2026 9:00 AM", "Next available: 10/21/2026 10:30 AM"],
      ["Departs 16:30", "Departs 17:45"],
      ["Ships in 2 days", "Ships in 5 days"],
      ["9,998 followers", "10,002 followers"],
      ["Alice · 1,234 votes", "Alice · 1,300 votes"],
      ["Them: 9:30", "Them: 10:15"],
      ["Are you free at 3:00?", "Are you free at 5:00?"],
      ["1. Alpha", "1. Bravo"],
    ])
      assert.notEqual(PD.normalizeLine(a), PD.normalizeLine(b), `${a} / ${b}`);
  });
  await check("nothing added when only stamps, ages and timers moved", () => {
    const at = (t, m, left) => ["Bitcoin $85,100", `Updated ${t} PM`, `Posted ${m} minutes ago`, `Last updated: Mon, 13 Oct 2026 ${t}:10 GMT`, `Sale ends in ${left}`, "Prices refresh every minute"];
    assert.deepEqual(added(at("3:45", 5, "02:15:33"), at("3:52", 12, "02:08:01")), []);
  });
  await check("a reordered ranked list has new lines (a rank is what's on the page)", () =>
    assert.deepEqual(added(["1. Alpha", "2. Bravo"], ["1. Bravo", "2. Alpha"]), ["1. Bravo", "2. Alpha"]));
  await check("a line's digest is short and the same each time", () => {
    assert.equal(PD.lineDigest("Bitcoin $86,200"), PD.lineDigest("Bitcoin $86,200"));
    assert.notEqual(PD.lineDigest("Bitcoin $86,200"), PD.lineDigest("Bitcoin $86,201"));
    assert.ok(PD.lineDigest("x".repeat(300)).length <= 12);
  });
});

/* ---------------- Page watches ---------------- */

test("starting a page watch: the first read is the baseline, and refusals say why", async () => {
  jevOn();
  const calls = jev.calls.length;
  const id = await pageWatch("/start", BASE);
  const w = watchOf(id);
  await check("made with no screen, for Boppy", () => {
    assert.equal(w.display, 0);
    assert.equal(w.page.url, at("/start"));
    assert.equal(w.page.everyMin, PAGE_WATCH_DEFAULT_MIN);
    assert.equal(isScreenWatch(w), false);
  });
  await check("the first read is kept as the baseline, in the steady form", () => {
    assert.equal(hitsOf("/start"), 1);
    assert.ok(w.page.hash && w.page.checkedAt);
    assert.ok(w.page.lines.includes("Bitcoin $85,100"));
    assert.ok(!w.page.lines.some((l) => /3:45|minutes ago/.test(l)), "the stamp and the age are out");
    assert.ok(w.page.lines.includes("1,204 watching"), "a count stays");
    assert.ok(!w.page.lines.some((l) => /Date\.now/.test(l)), "no script text");
  });
  await check("no model call to set it up", () => {
    assert.equal(jev.calls.length, calls);
    assert.equal(openai.calls.length, 0);
  });
  const refused = async (args, re, what) => {
    const before = (S.getState().watches ?? []).length;
    await assert.rejects(() => W.startPageWatch("boppy", args), (e) => (spoken.push(e.message), re.test(e.message)), what);
    assert.equal((S.getState().watches ?? []).length, before, `${what}: nothing set up`);
  };
  await check("the same page twice is refused, however it's written", () => refused({ url: at("/start/") }, /already watching/));
  await check("not a web page address", async () => {
    await refused({ url: "ftp://example.com/x" }, /isn't a web page address/, "ftp");
    await refused({ url: "javascript:alert(1)" }, /isn't a web page address/, "javascript:");
    await refused({ url: "mailto:a@b.co" }, /isn't a web page address/, "mailto:");
    await refused({ url: "bitcoin" }, /isn't a web page address/, "a bare word");
  });
  await check("the first read failing refuses it with the reason", async () => {
    pages.set("/broken", { status: 503, body: "<p>Down for maintenance</p>" });
    await refused({ url: at("/broken") }, /^Couldn't read 127\.0\.0\.1: \S/, "a 503");
    await refused({ url: at("/missing") }, /^Couldn't read/, "a 404");
  });
  await check("a private address is refused (safe-fetch), with no fixture let through", async () => {
    await refused({ url: "http://10.0.0.1/" }, /^Couldn't read 10\.0\.0\.1/, "10/8");
  });
  await check("a page with no text is refused", async () => {
    pages.set("/empty", { body: "<html><head><title>App</title></head><body><div id=root></div><script>render()</script></body></html>" });
    await refused({ url: at("/empty") }, /no text Bops can read/, "an empty app shell");
  });
  await check("minutes kept between 5 and a day", async () => {
    serve("/fast", "Fast", ["fast page"]);
    serve("/slow", "Slow", ["slow page"]);
    assert.equal((await W.startPageWatch("boppy", { url: at("/fast"), everyMin: 1 })).page.everyMin, PAGE_WATCH_MIN_MIN);
    assert.equal((await W.startPageWatch("boppy", { url: at("/slow"), everyMin: 5000 })).page.everyMin, 1440);
  });
});

test("the loop: nothing until due; the same page, or only its stamps, costs nothing", async () => {
  jevOn();
  const id = await pageWatch("/loop", BASE);
  const judged = () => jev.calls.filter(isJudge);
  const j0 = judged().length;
  await check("not read again before its minutes are up", async () => {
    wait(29);
    await tick(id);
    assert.equal(hitsOf("/loop"), 1);
  });
  await check("read when due; unchanged, no model call", async () => {
    wait(1);
    assert.equal(await tick(id), "same");
    assert.equal(hitsOf("/loop"), 2);
    assert.equal(judged().length, j0);
  });
  await check("only stamps and ages moved: the same page, no model call", async () => {
    serve("/loop", "Prices", ["Bitcoin $85,100", "Ethereum $3,050", "Updated 4:15 PM", "Posted 35 minutes ago", "1,204 watching", "Prices refresh every minute"]);
    wait(30);
    const hash = watchOf(id).page.hash;
    assert.equal(await tick(id), "same");
    assert.equal(hitsOf("/loop"), 3);
    assert.equal(watchOf(id).page.hash, hash);
    assert.equal(judged().length, j0);
    assert.equal(headsUps(id).length, 0);
  });
  await check("a counter that ticked is the judge's: one call, told what isn't news, no heads-up when it says no", async () => {
    jev.waiting = () => 0.1;
    serve("/loop", "Prices", ["Bitcoin $85,100", "Ethereum $3,050", "Updated 4:45 PM", "Posted 65 minutes ago", "1,388 watching", "Prices refresh every minute"]);
    wait(30);
    assert.equal(await tick(id), "changed");
    const calls = judged().slice(j0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].state.added, "1,388 watching");
    assert.equal(calls[0].state.before, "1,204 watching");
    assert.match(calls[0].questions.waiting.instructions, /a count that ticked \(views, likes, points, comments, watching\), an ad or a banner, the same things in a new order, or a cookie, sign in or error page shown instead of the page \(or the page back after one\) are not news, unless `look_for` is about them\./);
    assert.equal(headsUps(id).length, 0);
  });
  jev.waiting = () => 0.9;
  await check("a line went away, nothing added: nothing written, no model call", async () => {
    const kept = structuredClone(watchOf(id).page);
    serve("/loop", "Prices", ["Bitcoin $85,100", "Updated 5:15 PM", "1,388 watching"]);
    wait(30);
    assert.equal(await tick(id), "same");
    assert.equal(judged().length, j0 + 1);
    assert.deepEqual(watchOf(id).page, kept);
  });
});

test("a real change: exactly one judge call, and a heads-up when it matches", async () => {
  jevOn();
  const id = await pageWatch("/change", BASE);
  const judged = () => jev.calls.filter(isJudge);
  const j0 = judged().length;
  jev.waiting = () => 0.92;
  jev.item = (state) => `l${state.added.split("\n").findIndex((l) => l.includes("Bitcoin"))}`;
  serve("/change", "Prices", ["Bitcoin $86,200", ...BASE.slice(1).map((l) => l.replace("3:45", "3:50")), "New: Solana listed"]);
  wait(30);
  const result = await tick(id);
  await check("one judge call, over the added lines only, with what went from the page", () => {
    const calls = judged().slice(j0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].state.added.split("\n"), ["Bitcoin $86,200", "New: Solana listed"]);
    // The line the new price replaced: a crossing, or a move, can be judged; a price already over the line isn't news.
    assert.equal(calls[0].state.before, "Bitcoin $85,100");
    assert.match(calls[0].questions.waiting.instructions, /Something already true in `before` \(the same item, or the same condition, such as a price already above the line\) is not news\./);
    assert.ok(!("on_target" in calls[0].questions), "no on_target question for a page");
    assert.equal(calls[0].state.look_for, "Bitcoin above $86,000");
  });
  await check("the heads-up in Boppy's chat, with the watch", () => {
    assert.equal(result, "told");
    const m = headsUps(id);
    assert.equal(m.length, 1);
    assert.equal(m[0].chatId, botChatId("boppy"));
    // A page on a bare address is named by its title (lib/watch-sites.ts siteOf); the line it replaced is said with it.
    assert.equal(m[0].text, "Heads up, something new on Prices: “Bitcoin $86,200 (was Bitcoin $85,100)”");
    spoken.push(m[0].text);
    const w = watchOf(id);
    assert.equal(w.alert.text, "Bitcoin $86,200 (was Bitcoin $85,100)");
    assert.deepEqual(w.told, ["Bitcoin $86,200 (was Bitcoin $85,100)"]);
    assert.ok(w.page.lines.includes("Bitcoin $86,200"), "the new page is kept");
  });
  await check("read again unchanged: nothing", async () => {
    wait(30);
    assert.equal(await tick(id), "same");
    assert.equal(judged().length, j0 + 1);
    assert.equal(headsUps(id).length, 1);
  });
  await check("added lines that don't match: one judge call, no heads-up", async () => {
    jev.waiting = () => 0.1;
    serve("/change", "Prices", ["Bitcoin $86,200", "Ethereum $3,100", "Updated 4:30 PM"]);
    wait(30);
    assert.equal(await tick(id), "changed");
    assert.equal(judged().length, j0 + 2);
    assert.equal(headsUps(id).length, 1);
    assert.ok(watchOf(id).alert, "a page's badge stays until the user sees it");
  });
  await check("the same line again with a new stamp: nothing new, not told twice", async () => {
    jev.waiting = () => 0.95;
    jev.item = () => "l0";
    const calls = judged().length;
    serve("/change", "Prices", ["Bitcoin $86,200 · updated 4:40 PM", "Ethereum $3,100"]);
    wait(30);
    assert.equal(await tick(id), "same");
    assert.equal(judged().length, calls);
    assert.equal(headsUps(id).length, 1);
  });
  jev.waiting = () => 0.9;
  jev.item = () => "l0";
});

test("no Jev: one quick OpenAI call judges instead, counted", async () => {
  jevOff();
  const id = await pageWatch("/nojev", BASE, { lookFor: "a new coin listed" });
  const usage = () => (S.getState().usage ?? []).filter((u) => u.source === "decide" && u.model === "gpt-test-monitors").length;
  const u0 = usage();
  const jevCalls = jev.calls.length;
  openai.answer = (input) => ({ matches: true, line: input.added.findIndex((l) => l.includes("listed")) });
  serve("/nojev", "Prices", [...BASE, "Solana listed today"]);
  wait(30);
  const result = await tick(id);
  await check("exactly one OpenAI judge call, low effort, no Jev call", () => {
    assert.equal(openai.calls.length, 1);
    assert.equal(openai.calls[0].body.reasoning.effort, "low");
    assert.equal(openai.calls[0].body.model, "gpt-test-monitors");
    // The line as the page has it.
    assert.deepEqual(openai.calls[0].input.added, ["0: Solana listed today"]);
    assert.equal(openai.calls[0].input.more_added, undefined, "no count of more when all are shown");
    assert.deepEqual(openai.calls[0].input.before, [], "nothing went from the page");
    assert.match(openai.calls[0].body.instructions, /`before` are lines that were on it then and are gone now/);
    assert.equal(jev.calls.length, jevCalls);
    assert.equal(openai.other.length, 0);
  });
  await check("its tokens are counted as a quick check", () => assert.equal(usage(), u0 + 1));
  await check("the heads-up is given (urgency falls back to now)", () => {
    assert.equal(result, "told");
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, something new on Prices: “Solana listed today”");
  });
  await check("the same page again: no call", async () => {
    wait(30);
    assert.equal(await tick(id), "same");
    assert.equal(openai.calls.length, 1);
  });
  await check("no model answers: the page isn't moved on, so the lines are judged next time", async () => {
    openai.fail = "The model is busy.";
    const kept = watchOf(id).page.hash;
    serve("/nojev", "Prices", [...BASE, "Solana listed today", "Cardano listed"]);
    wait(30);
    assert.equal(await tick(id), "changed");
    assert.equal(watchOf(id).page.hash, kept);
    assert.equal(openai.calls.length, 2);
    openai.fail = null;
    openai.answer = (input) => ({ matches: true, line: input.added.findIndex((l) => l.includes("Cardano")) });
    wait(30);
    assert.equal(await tick(id), "told");
    assert.deepEqual(openai.calls[2].input.added, ["0: Cardano listed"]);
    assert.notEqual(watchOf(id).page.hash, kept);
  });
  jevOn();
});

test("failures back off, and the first good read clears them", async () => {
  jevOn();
  const id = await pageWatch("/flaky", BASE);
  const page = () => watchOf(id).page;
  pages.set("/flaky", { status: 500, body: "<p>oops</p>" });
  await check("a failed read is kept on the watch, in plain words", async () => {
    wait(30);
    assert.equal(await tick(id), "failed");
    assert.equal(page().failures, 1);
    assert.match(page().error, /\S/);
    spoken.push(page().error);
    assert.equal(hitsOf("/flaky"), 2);
  });
  await check("the next read waits twice as long", async () => {
    wait(30);
    await tick(id);
    assert.equal(hitsOf("/flaky"), 2, "not after 30 minutes");
    wait(30);
    assert.equal(await tick(id), "failed");
    assert.equal(hitsOf("/flaky"), 3, "after 60");
    assert.equal(page().failures, 2);
  });
  await check("a page that hangs up counts as a failure too", async () => {
    pages.set("/flaky", { status: "hang" });
    wait(120);
    assert.equal(await tick(id), "failed");
    assert.equal(page().failures, 3);
  });
  await check("the gap stops growing at 6 hours", async () => {
    S.update((s) => (s.watches.find((w) => w.id === id).page.failures = 12));
    wait(359);
    await tick(id);
    assert.equal(hitsOf("/flaky"), 4);
    wait(1);
    serve("/flaky", "Prices", BASE);
    assert.equal(await tick(id), "same");
    assert.equal(hitsOf("/flaky"), 5);
  });
  await check("a good read clears the error and the count", () => {
    assert.equal(page().error, undefined);
    assert.equal(page().failures, undefined);
  });
  await check("a page read once a day backs off no sooner than a day", async () => {
    const daily = await pageWatch("/daily", BASE, { everyMin: 1440 });
    pages.set("/daily", { status: 500, body: "x" });
    wait(1440);
    assert.equal(await tick(daily), "failed");
    wait(1439);
    await tick(daily);
    assert.equal(hitsOf("/daily"), 2);
    wait(1);
    await tick(daily);
    assert.equal(hitsOf("/daily"), 3);
  });
});

test("pause, resume and check now", async () => {
  jevOn();
  const id = await pageWatch("/pause", BASE);
  W.setWatchPaused(id, true);
  await check("paused: the loop leaves it alone", async () => {
    assert.equal(watchOf(id).paused, true);
    wait(120);
    assert.equal(await tick(id), undefined);
    assert.equal(hitsOf("/pause"), 1);
  });
  await check("check now reads it at once, paused or not", async () => {
    const r = await W.checkNow(id);
    assert.equal(r.result, "same");
    assert.equal(hitsOf("/pause"), 2);
    assert.equal(r.watch.id, id);
  });
  await check("check now that finds nothing new shows at once: saved, and the window told, whatever the loop did lately", async () => {
    wait(10);
    // The loop told the window it moved on a moment ago (for another watch): that doesn't hold this back.
    globalThis.__bopsPageShown = Date.now();
    const version = S.getVersion();
    const asked = Date.now();
    const r = await W.checkNow(id);
    assert.equal(r.result, "same");
    assert.ok(S.getVersion() > version, "the window is told");
    assert.ok(watchOf(id).page.checkedAt >= asked, "when it was checked is saved");
    assert.equal(r.watch.page.checkedAt, watchOf(id).page.checkedAt);
    assert.equal(r.watch.page.digests, undefined, "what's kept to compare stays on the server");
    assert.equal(r.watch.page.seen, undefined);
    assert.equal(r.watch.page.lines, undefined);
  });
  await check("resumed: it reads at once, and what changed while paused is judged", async () => {
    const judged = jev.calls.filter(isJudge).length;
    const hit = hitsOf("/pause");
    serve("/pause", "Prices", [...BASE, "Bitcoin $86,500"]);
    W.setWatchPaused(id, false);
    assert.equal(watchOf(id).paused, undefined);
    for (let i = 0; i < 100 && hitsOf("/pause") <= hit; i++) await sleep(20);
    await sleep(50);
    assert.equal(hitsOf("/pause"), hit + 1);
    assert.equal(jev.calls.filter(isJudge).length, judged + 1);
  });
  await check("check now on a watch that's gone says so", async () => {
    await assert.rejects(() => W.checkNow("watch_gone"), (e) => (spoken.push(e.message), /isn't being watched/.test(e.message)));
  });
});

test("from chat: where web", async () => {
  jevOn();
  serve("/chat", "Status", ["All systems normal", "Updated 3:45 PM"]);
  const r = await W.watchFromChat("boppy", { where: "web", url: `http://127.0.0.1:${PORT}/chat`, look_for: "an outage", every_minutes: 15, app: null, window: null });
  await check("set up, with the plain answer to relay", () => {
    assert.ok("watch" in r, JSON.stringify(r));
    assert.equal(r.watch.page.everyMin, 15);
    assert.equal(r.said, "Watching Status every 15 minutes for: an outage. Tiger gets a heads-up here when it shows up.");
    spoken.push(r.said);
  });
  await check("asked again: kept, with what was said now", async () => {
    W.setWatchPaused(r.watch.id, true);
    // Written another way: https, a trailing slash.
    const again = await W.watchFromChat("boppy", { where: "web", url: `https://127.0.0.1:${PORT}/chat/`, look_for: "any incident", every_minutes: 60 });
    assert.equal(again.already, true);
    assert.equal(again.watch.id, r.watch.id);
    assert.equal(again.watch.lookFor, "any incident");
    assert.equal(again.watch.page.everyMin, 60);
    assert.equal(again.watch.paused, undefined, "and resumed");
    assert.equal(again.said, "Already watching Status every hour for: any incident. Tiger gets a heads-up here when it shows up.");
  });
  await check("what can't be watched comes back as a reply", async () => {
    const replies = [
      await W.watchFromChat("boppy", { where: "web", url: null }),
      await W.watchFromChat("boppy", { where: "web", url: "mailto:a@b.co" }),
      await W.watchFromChat("boppy", { where: "web", url: at("/missing-too") }),
      // No scheme is https: this server only speaks http, so it can't be read.
      await W.watchFromChat("boppy", { where: "web", url: `127.0.0.1:${PORT}/chat2` }),
    ];
    for (const x of replies) {
      assert.ok("reply" in x, JSON.stringify(x));
      spoken.push(x.reply);
    }
    assert.match(replies[2].reply, /^Couldn't read/);
    assert.match(replies[3].reply, /^Couldn't read 127\.0\.0\.1/);
    assert.equal(hitsOf("/chat2"), 0);
  });
  await check("the bot's note lists it, paused and failing ones too", async () => {
    const note = W.watchesNote(["boppy"], false);
    assert.match(note, new RegExp(`- ${r.watch.id}: the web page Status \\(http://127\\.0\\.0\\.1:${PORT}/chat\\), read every hour · looking for any incident`));
    assert.match(note, /read every day · looking for Bitcoin above \$86,000 · the last 2 reads failed: That page answered 500/);
    spoken.push(note);
  });
  await check("a page watch has no reply to draft", () => {
    assert.throws(() => W.draftReply(r.watch.id), (e) => (spoken.push(e.message), /no screen to reply on/.test(e.message)));
  });
});

test("the route", async () => {
  jevOn();
  serve("/route", "Jobs", ["Senior engineer, Chicago", "Posted 2 days ago"]);
  const made = await request(R.POST, "POST", "/api/watches", { botId: "boppy", page: { url: at("/route"), everyMin: 20 }, lookFor: "a new design job", site: "Jobs board" });
  const id = made.body.watch?.id;
  await check("POST page makes one", () => {
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.watch.site, "Jobs board");
    assert.equal(made.body.watch.page.everyMin, 20);
  });
  await check("POST page without a bot or an address is a 400", async () => {
    assert.equal((await request(R.POST, "POST", "/api/watches", { page: { url: at("/route") } })).status, 400);
    assert.equal((await request(R.POST, "POST", "/api/watches", { botId: "boppy", page: {} })).status, 400);
    assert.equal((await request(R.POST, "POST", "/api/watches", { botId: "boppy", page: { url: at("/route"), everyMin: "often" } })).status, 400);
  });
  await check("POST page that can't be read is a 409 with the reason", async () => {
    const r = await request(R.POST, "POST", "/api/watches", { botId: "boppy", page: { url: at("/nope") } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /^Couldn't read/);
  });
  await check("PATCH check reads it now and says what it found", async () => {
    serve("/route", "Jobs", ["Senior engineer, Chicago", "Product designer, Remote", "Posted 3 days ago"]);
    jev.waiting = () => 0.95;
    jev.item = () => "l0";
    const r = await request(R.PATCH, "PATCH", "/api/watches", { id, action: "check" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result, "told");
    assert.equal(r.body.watch.alert.text, "Product designer, Remote");
  });
  await check("PATCH pause and resume", async () => {
    assert.equal((await request(R.PATCH, "PATCH", "/api/watches", { id, action: "pause" })).body.watch.paused, true);
    assert.equal((await request(R.PATCH, "PATCH", "/api/watches", { id, action: "resume" })).body.watch.paused, undefined);
  });
  await check("PATCH edit changes the minutes too", async () => {
    assert.equal((await request(R.PATCH, "PATCH", "/api/watches", { id, action: "edit", lookFor: "design jobs", everyMin: 2 })).status, 200);
    assert.equal(watchOf(id).page.everyMin, PAGE_WATCH_MIN_MIN);
    assert.equal(watchOf(id).lookFor, "design jobs");
  });
  await check("PATCH on a watch that's gone is a 409", async () => {
    assert.equal((await request(R.PATCH, "PATCH", "/api/watches", { id: "watch_gone", action: "check" })).status, 409);
    assert.equal((await request(R.PATCH, "PATCH", "/api/watches", { id: "watch_gone", action: "pause" })).status, 409);
  });
  await check("DELETE stops it", async () => {
    assert.equal((await request(R.DELETE, "DELETE", `/api/watches?id=${id}`)).status, 200);
    assert.equal(watchOf(id), undefined);
  });
});


test("every line of a page counts, not just its first ones", async () => {
  jevOn();
  // 60 lines of menu, then 180 comments, oldest first: the newest comes last, past what used to be kept.
  const nav = Array.from({ length: 60 }, (_, i) => `Menu item ${i + 1}`);
  const comments = Array.from({ length: 180 }, (_, i) => `Comment ${i + 1}: thanks for the release notes, point ${i + 1}`);
  const id = await pageWatch("/thread", [...nav, ...comments], { lookFor: "a comment from Dana" });
  const judged = () => jev.calls.filter(isJudge);
  const j0 = judged().length;
  jev.waiting = (state) => (state.added.includes("Dana") ? 0.95 : 0.1);
  jev.item = () => "l0";
  serve("/thread", "Prices", [...nav, ...comments, "Comment 181 from Dana: the build is out"]);
  wait(30);
  await check("a comment added at the bottom is a change, judged and told", async () => {
    assert.equal(await tick(id), "told");
    const calls = judged().slice(j0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].state.added.split("\n"), ["Comment 181 from Dana: the build is out"]);
  });
  await check("what's kept is small: a fingerprint a line, and some text", () => {
    const p = watchOf(id).page;
    assert.equal(p.digests.length, 241);
    assert.ok(JSON.stringify(p.digests).length < 241 * 16, `digests ${JSON.stringify(p.digests).length}`);
    assert.ok(p.lines.join("\n").length <= 30_000);
    assert.ok(p.lines.includes("Comment 181 from Dana: the build is out"), "the line just added is kept as text");
  });
  await check("a reply at the bottom of a thread of 1,400 lines (past the 400 a page used to be read as) is found", async () => {
    const long = Array.from({ length: 1400 }, (_, i) => `Reply ${i + 1}: works for me on build ${i + 1}`);
    const thread = await pageWatch("/long-thread", long, { lookFor: "a reply from the maintainer" });
    jev.waiting = (state) => (state.added.includes("maintainer") ? 0.95 : 0.1);
    serve("/long-thread", "Prices", [...long, "maintainer: fixed in v2"]);
    wait(30);
    const calls = judged().length;
    assert.equal(await tick(thread), "told");
    assert.deepEqual(judged().at(-1).state.added.split("\n"), ["maintainer: fixed in v2"]);
    assert.equal(judged().length, calls + 1);
    const p = watchOf(thread).page;
    assert.equal(p.digests.length, 1401);
    assert.ok(JSON.stringify(p.digests).length < 1401 * 16, `digests ${JSON.stringify(p.digests).length}`);
    assert.ok(p.lines.join("\n").length <= 30_000);
  });
  jev.waiting = () => 0.9;
});

test("many new lines: one judge call with up to 200 of them and a count of the rest, which come up at the next read", async () => {
  jevOn();
  const id = await pageWatch("/listings", ["Listings", "Filter by city"], { lookFor: "a loft in Brooklyn" });
  const judged = () => jev.calls.filter(isJudge);
  const j0 = judged().length;
  const items = Array.from({ length: 60 }, (_, i) => (i === 49 ? "Loft in Brooklyn, $2,400" : `Studio ${i + 1} in Queens, $1,${(100 + i).toString()}`));
  jev.waiting = (state) => (state.added.includes("Brooklyn") ? 0.95 : 0.1);
  jev.item = (state) => `l${state.added.split("\n").findIndex((l) => l.includes("Brooklyn"))}`;
  serve("/listings", "Prices", ["Listings", "Filter by city", ...items]);
  wait(30);
  await check("60 new lines: one call with all of them, and the match at line 50 is told", async () => {
    assert.equal(await tick(id), "told");
    const calls = judged().slice(j0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].state.added.split("\n").length, 60);
    assert.equal(calls[0].state.more_added, undefined);
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, something new on Prices: “Loft in Brooklyn, $2,400”");
  });
  const more = Array.from({ length: 250 }, (_, i) => (i === 230 ? "Loft in the Bronx, $1,900" : `Room ${i + 1} in the Bronx, $900`));
  await check("250 new lines: one call with the first 200 and how many more; those 50 aren't kept", async () => {
    jev.waiting = (state) => (state.added.includes("Loft") ? 0.95 : 0.1);
    jev.item = (state) => `l${state.added.split("\n").findIndex((l) => l.includes("Loft"))}`;
    serve("/listings", "Prices", ["Listings", "Filter by city", ...items, ...more]);
    wait(30);
    const before = judged().length;
    assert.equal(await tick(id), "changed");
    const calls = judged().slice(before);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].state.added.split("\n"), more.slice(0, 200));
    assert.equal(calls[0].state.more_added, "50 more new lines, not shown now (they come next read)");
    assert.equal(watchOf(id).page.digests.length, 2 + 60 + 200);
    assert.ok(!watchOf(id).page.digests.includes(PD.lineDigest("Loft in the Bronx, $1,900")));
  });
  await check("the next read judges the 50 left over, and the loft among them is told", async () => {
    wait(30);
    const before = judged().length;
    assert.equal(await tick(id), "told");
    assert.equal(judged().length, before + 1);
    assert.deepEqual(judged().at(-1).state.added.split("\n"), more.slice(200));
    assert.equal(judged().at(-1).state.more_added, undefined);
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, something new on Prices: “Loft in the Bronx, $1,900”");
    assert.equal(watchOf(id).page.digests.length, 2 + 60 + 250);
  });
  await check("then nothing is left over: the same page, no call", async () => {
    wait(30);
    const before = judged().length;
    assert.equal(await tick(id), "same");
    assert.equal(judged().length, before);
  });
  await check("one big update is told once, not once a read", async () => {
    jev.waiting = () => 0.95;
    jev.item = () => "l3";
    const posts = Array.from({ length: 100 }, (_, i) => `Post ${i + 1}: something new`);
    serve("/listings", "Prices", ["Listings", "Filter by city", ...posts, ...items, ...more]);
    const told = headsUps(id).length;
    const reads = [];
    for (let i = 0; i < 3; i++) {
      wait(30);
      reads.push(await tick(id));
    }
    assert.deepEqual(reads, ["told", "same", "same"]);
    assert.equal(headsUps(id).length, told + 1);
  });
  await check("a sure yes with no line picked says the page changed and what it's watched for, quoting no line", async () => {
    jev.waiting = () => 0.95;
    jev.item = () => "none";
    serve("/listings", "Prices", ["Listings", "Filter by city", "Penthouse in Brooklyn, $9,000", "Studio in Queens, $1,000", ...items]);
    wait(30);
    assert.equal(await tick(id), "told");
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, Prices changed. It looks like what you're watching for: a loft in Brooklyn.");
    assert.equal(watchOf(id).alert.text, "Changed: a loft in Brooklyn");
    spoken.push(headsUps(id).at(-1)?.text);
  });
  await check("a long look_for is cut to a few words", async () => {
    W.editWatch(id, "a loft in Brooklyn or Queens with two bedrooms and a balcony under $3,000.");
    S.update((s) => (s.watches.find((w) => w.id === id).alert = undefined));
    serve("/listings", "Prices", ["Listings", "Filter by city", "Duplex in Queens, $2,900"]);
    wait(30);
    assert.equal(await tick(id), "told");
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, Prices changed. It looks like what you're watching for: a loft in Brooklyn or Queens with two…");
  });
  await check("no OpenAI line picked (null): the same plain heads-up", async () => {
    jevOff();
    openai.answer = () => ({ matches: true, line: null });
    S.update((s) => (s.watches.find((w) => w.id === id).alert = undefined));
    serve("/listings", "Prices", ["Listings", "Filter by city", "Loft in Brooklyn, $2,200"]);
    wait(30);
    assert.equal(await tick(id), "told");
    assert.match(headsUps(id).at(-1)?.text, /^Heads up, Prices changed\. It looks like what you're watching for: /);
    openai.answer = () => ({ matches: true, line: 0 });
    jevOn();
  });
  jev.waiting = () => 0.9;
  jev.item = () => "l0";
});

test("what comes and goes: counts ticking, a banner rotating, a reorder, a cookie page, a feed that turns over", async () => {
  jevOn();
  const judged = () => jev.calls.filter(isJudge);
  const stories = Array.from({ length: 12 }, (_, i) => `Story ${i + 1} about databases`);
  const hn = (points) => stories.flatMap((t, i) => [`${i + 1}. ${t}`, `${points + i} points by user${i} 2 hours ago | hide | ${10 + i} comments`]);
  const id = await pageWatch("/hn", [...hn(100), "Banner: spring sale"], { lookFor: "a story about Bops", everyMin: 15 });
  jev.waiting = () => 0.1;
  await check("points and comment counts moved: one judge call over those lines, no heads-up", async () => {
    serve("/hn", "Prices", [...hn(140), "Banner: spring sale"]);
    wait(30);
    const j0 = judged().length;
    assert.equal(await tick(id), "changed");
    assert.equal(judged().length, j0 + 1);
    assert.equal(judged().at(-1).state.added.split("\n").length, 12);
    assert.equal(headsUps(id).length, 0);
  });
  await check("a banner that rotates: each one that comes back is new again, one judge call a read, and no heads-up when it doesn't match", async () => {
    serve("/hn", "Prices", [...hn(140), "Banner: free shipping"]);
    wait(30);
    const j1 = judged().length;
    assert.equal(await tick(id), "changed");
    assert.equal(judged().length, j1 + 1);
    for (const banner of ["Banner: spring sale", "Banner: free shipping"]) {
      serve("/hn", "Prices", [...hn(140), banner]);
      wait(15);
      assert.equal(await tick(id), "changed", banner);
      assert.equal(judged().at(-1).state.added, banner);
    }
    assert.equal(judged().length, j1 + 3);
    assert.equal(headsUps(id).length, 0);
    assert.equal(watchOf(id).page.seen, undefined, "nothing kept of lines that went");
  });
  await check("the same lines in a new order (no rank on them): nothing new, nothing written", async () => {
    const plain = ["Apples", "Pears", "Plums", "Figs"];
    const fruit = await pageWatch("/fruit", plain, { lookFor: "a new fruit" });
    const kept = structuredClone(watchOf(fruit).page);
    serve("/fruit", "Prices", [...plain].reverse());
    wait(30);
    const j = judged().length;
    assert.equal(await tick(fruit), "same");
    assert.equal(judged().length, j);
    assert.deepEqual(watchOf(fruit).page, kept);
  });
  await check("a ranked list reordered: the moved ranks are new lines, for the judge", async () => {
    const ranks = await pageWatch("/ranks", ["1. Alpha", "2. Bravo", "3. Charlie"], { lookFor: "Bravo reaches number 1" });
    jev.waiting = (state) => (state.added.includes("1. Bravo") ? 0.95 : 0.1);
    jev.item = (state) => `l${state.added.split("\n").indexOf("1. Bravo")}`;
    serve("/ranks", "Prices", ["1. Bravo", "2. Alpha", "3. Charlie"]);
    wait(30);
    assert.equal(await tick(ranks), "told");
    assert.deepEqual(judged().at(-1).state.added.split("\n"), ["1. Bravo", "2. Alpha"]);
    // The line it's a new version of: the same words with another number.
    assert.equal(headsUps(ranks).at(-1)?.text, "Heads up, something new on Prices: “1. Bravo (was 2. Bravo)”");
    jev.waiting = () => 0.1;
    jev.item = () => "l0";
  });
  await check("a cookie page served instead: one judge call, and one more when the page is back (the judge is told that isn't news)", async () => {
    serve("/hn", "Prices", ["We use cookies", "Accept all", "Manage settings"]);
    wait(30);
    const j2 = judged().length;
    assert.equal(await tick(id), "changed");
    assert.equal(judged().length, j2 + 1);
    assert.equal(watchOf(id).page.error, undefined, "not a failure");
    serve("/hn", "Prices", [...hn(140), "Banner: spring sale"]);
    wait(30);
    assert.equal(await tick(id), "changed");
    assert.equal(judged().length, j2 + 2);
    assert.equal(judged().at(-1).state.before, "We use cookies\nAccept all\nManage settings");
    assert.match(judged().at(-1).questions.waiting.instructions, /a cookie, sign in or error page shown instead of the page \(or the page back after one\) are not news/);
    assert.equal(headsUps(id).length, 0);
    wait(30);
    assert.equal(await tick(id), "same");
    assert.equal(judged().length, j2 + 2);
  });
  await check("a busy feed whose items all turn over each read: judged every read, never a failure", async () => {
    const chrome = ["Newest posts", "Sort: new", "Filter"];
    const batch = (n) => Array.from({ length: 20 }, (_, i) => [`Post ${n * 20 + i}: a thing happened`, `by user${n * 20 + i}`]).flat();
    const feed = await pageWatch("/feed", [...chrome, ...batch(0)], { lookFor: "a post about Bops" });
    const results = [];
    for (let n = 1; n <= 4; n++) {
      serve("/feed", "Prices", [...chrome, ...batch(n)]);
      wait(30);
      const j = judged().length;
      results.push(await tick(feed));
      assert.equal(judged().length, j + 1, `read ${n}: one call`);
      assert.equal(judged().at(-1).state.added.split("\n").length, 40, `read ${n}: every new post judged`);
    }
    assert.deepEqual(results, ["changed", "changed", "changed", "changed"]);
    assert.equal(watchOf(feed).page.failures, undefined);
    assert.equal(watchOf(feed).page.error, undefined);
  });
  jev.waiting = () => 0.9;
});

test("a line that went and comes back is new again: a status or a restock that recurs is told again", async () => {
  jevOn();
  const judged = () => jev.calls.filter(isJudge);
  const id = await pageWatch("/status-api", ["Acme status", "API · Operational", "Website · Operational"], { lookFor: "an outage", title: "Status" });
  jev.waiting = (state) => (state.added.includes("Outage") ? 0.95 : 0.1);
  jev.item = () => "l0";
  const read = async (api) => {
    serve("/status-api", "Status", ["Acme status", `API · ${api}`, "Website · Operational"]);
    wait(30);
    return tick(id);
  };
  await check("an outage is told", async () => {
    assert.equal(await read("Major Outage"), "told");
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, something new on Status: “API · Major Outage”");
  });
  await check("back to operational: judged (it came back), no heads-up", async () => {
    const j = judged().length;
    assert.equal(await read("Operational"), "changed");
    assert.equal(judged().length, j + 1);
    assert.equal(judged().at(-1).state.added, "API · Operational");
    assert.equal(judged().at(-1).state.already_told, undefined, "the judge isn't told to skip what was told before");
  });
  await check("the same outage again while the first alert still shows: judged, not told twice", async () => {
    const told = headsUps(id).length;
    assert.equal(await read("Major Outage"), "changed");
    assert.equal(headsUps(id).length, told);
    assert.equal(await read("Operational"), "changed");
  });
  await check("the user saw the alert: the next outage, two days later, is told again", async () => {
    W.seenWatch(id);
    assert.equal(watchOf(id).alert, undefined);
    const told = headsUps(id).length;
    wait(2 * 1440);
    const j = judged().length;
    assert.equal(await read("Major Outage"), "told");
    assert.equal(judged().length, j + 1);
    assert.equal(headsUps(id).length, told + 1);
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, something new on Status: “API · Major Outage”");
    assert.deepEqual(watchOf(id).told.slice(-2), ["API · Major Outage", "API · Major Outage"]);
  });
  await check("a restock after a sell out is told again (no number in it, so no \"was\")", async () => {
    const stock = await pageWatch("/stock", ["Widget Pro", "Status: In stock", "Ships free"], { lookFor: "back in stock" });
    jev.waiting = (state) => (state.added.includes("In stock") ? 0.95 : 0.1);
    const set = async (status) => {
      serve("/stock", "Prices", ["Widget Pro", `Status: ${status}`, "Ships free"]);
      wait(30);
      return tick(stock);
    };
    assert.equal(await set("Sold out"), "changed");
    assert.equal(await set("In stock"), "told");
    W.seenWatch(stock);
    assert.equal(await set("Sold out"), "changed");
    assert.equal(await set("In stock"), "told");
    assert.equal(headsUps(stock).length, 2);
    assert.equal(headsUps(stock).at(-1)?.text, "Heads up, something new on Prices: “Status: In stock”");
  });
  await check("a line that blinks out and back between saves is still known: nothing to judge", async () => {
    const blink = await pageWatch("/blink", ["Widget Pro", "Limited offer", "Ships free"], { lookFor: "a price drop" });
    serve("/blink", "Prices", ["Widget Pro", "Ships free"]);
    wait(30);
    assert.equal(await tick(blink), "same", "nothing added: nothing written");
    serve("/blink", "Prices", ["Widget Pro", "Limited offer", "Ships free"]);
    wait(30);
    const j = judged().length;
    assert.equal(await tick(blink), "same");
    assert.equal(judged().length, j);
  });
  jev.waiting = () => 0.9;
  jev.item = () => "l0";
});

test("a long thread whose scores all ticked, with a new reply at the bottom: one call sees every line, and the reply is told", async () => {
  jevOn();
  const judged = () => jev.calls.filter(isJudge);
  const comments = (bump) => Array.from({ length: 100 }, (_, i) => [`Comment ${i + 1}: works on my machine, build ${i + 1}`, `user${i} ${12 + i + bump} points`]).flat();
  const id = await pageWatch("/scores", ["Thread: the release", ...comments(0)], { lookFor: "a reply from the OP", title: "Thread" });
  jev.waiting = (state) => (state.added.includes("OP:") ? 0.95 : 0.1);
  jev.item = (state) => `l${state.added.split("\n").findIndex((l) => l.startsWith("OP:"))}`;
  serve("/scores", "Thread", ["Thread: the release", ...comments(1), "OP: Shipping the fix tonight"]);
  wait(30);
  const j = judged().length;
  assert.equal(await tick(id), "told");
  await check("one call, with all 101 new lines and none left over", () => {
    assert.equal(judged().length, j + 1);
    const added = judged().at(-1).state.added.split("\n");
    assert.equal(added.length, 101);
    assert.equal(added.at(-1), "OP: Shipping the fix tonight");
    assert.equal(judged().at(-1).state.more_added, undefined);
  });
  await check("the reply is told", () => assert.equal(headsUps(id).at(-1)?.text, "Heads up, something new on Thread: “OP: Shipping the fix tonight”"));
  jev.waiting = () => 0.9;
  jev.item = () => "l0";
});

test("a web page that comes back with no text is a failed read, never a new baseline; JSON or text that's empty is just empty", async () => {
  jevOn();
  const judged = () => jev.calls.filter(isJudge);
  const id = await pageWatch("/restock", ["Widget Pro", "Status: sold out"], { lookFor: "back in stock" });
  const kept = structuredClone(watchOf(id).page);
  await check("an empty answer: failed, said plainly, the page kept as it was", async () => {
    pages.set("/restock", { body: "" });
    wait(30);
    assert.equal(await tick(id), "failed");
    const p = watchOf(id).page;
    assert.equal(p.error, "The page came back empty.");
    spoken.push(p.error);
    assert.equal(p.failures, 1);
    assert.deepEqual(p.digests, kept.digests);
    assert.equal(p.hash, kept.hash);
  });
  await check("a shell that draws itself in the browser: the same", async () => {
    pages.set("/restock", { body: "<html><body><div id=root></div><script>render()</script></body></html>" });
    wait(60);
    assert.equal(await tick(id), "failed");
    assert.equal(watchOf(id).page.failures, 2);
  });
  await check("the next real read is judged against the page as it was: the restock is told", async () => {
    jev.waiting = (state) => (state.added.includes("in stock") ? 0.95 : 0.1);
    jev.item = () => "l0";
    serve("/restock", "Prices", ["Widget Pro", "Status: in stock, ships today"]);
    wait(120);
    const j = judged().length;
    assert.equal(await tick(id), "told");
    assert.equal(judged().length, j + 1);
    assert.equal(judged().at(-1).state.before, "Status: sold out");
    assert.equal(watchOf(id).page.error, undefined);
    assert.equal(watchOf(id).page.failures, undefined);
  });
  await check("a watch kept with no lines at all (digests []) judges its next read, it isn't a baseline", async () => {
    S.update((s) => Object.assign(s.watches.find((w) => w.id === id).page, { digests: [], hash: PD.pageHash([]), seen: undefined }));
    serve("/restock", "Prices", ["Widget Pro", "Status: in stock, 3 left"]);
    wait(30);
    const j = judged().length;
    assert.notEqual(await tick(id), "failed");
    assert.equal(judged().length, j + 1);
  });
  await check("a JSON list that empties is the page as it is, not a failure; the next item in it is judged and told", async () => {
    pages.set("/issues.json", { type: "application/json", body: JSON.stringify([{ title: "Issue 1 open" }]) });
    const issues = (await W.startPageWatch("boppy", { url: at("/issues.json"), lookFor: "a new issue" })).id;
    pages.set("/issues.json", { type: "application/json", body: "[]" });
    wait(30);
    assert.notEqual(await tick(issues), "failed");
    assert.equal(watchOf(issues).page.error, undefined);
    assert.equal(watchOf(issues).page.failures, undefined);
    jev.waiting = (state) => (state.added.includes("Issue 2") ? 0.95 : 0.1);
    pages.set("/issues.json", { type: "application/json", body: JSON.stringify([{ title: "Issue 2 open" }]) });
    wait(30);
    assert.equal(await tick(issues), "told");
    assert.equal(headsUps(issues).at(-1)?.text, `Heads up, something new on 127.0.0.1:${PORT}/issues.json: “"title": "Issue 2 open" (was "title": "Issue 1 open")”`);
  });
  await check("an empty JSON list or text file can be watched from the start", async () => {
    pages.set("/none.json", { type: "application/json", body: "[]" });
    pages.set("/none.txt", { type: "text/plain", body: "" });
    const a = await W.startPageWatch("boppy", { url: at("/none.json"), lookFor: "a new issue" });
    const b = await W.startPageWatch("boppy", { url: at("/none.txt"), lookFor: "anything" });
    assert.deepEqual(a.page.digests, []);
    assert.deepEqual(b.page.digests, []);
    wait(30);
    assert.equal(await tick(a.id), "same");
    pages.set("/none.txt", { type: "text/plain", body: "Release 1.0 is out" });
    jev.waiting = () => 0.95;
    assert.equal(await tick(b.id), "told");
  });
  await check("a watch from before every line was kept (no digests) is taken in as it is", async () => {
    S.update((s) => Object.assign(s.watches.find((w) => w.id === id).page, { digests: undefined, hash: undefined }));
    wait(30);
    const j = judged().length;
    assert.equal(await tick(id), "changed");
    assert.equal(judged().length, j);
    assert.ok(watchOf(id).page.digests.length > 0);
  });
  jev.waiting = () => 0.9;
});

test("slots and departures: a time on its own, or in a table cell, is what's on the page", async () => {
  jevOn();
  const judged = () => jev.calls.filter(isJudge);
  const slots = (times) => `<!doctype html><html><head><title>Clinic</title></head><body><h1>Book a visit</h1><p>Pick a time below.</p><h2>Saturday, October 18</h2><ul>${times.map((t) => `<li><button>${t}</button></li>`).join("")}</ul><footer>Example clinic</footer></body></html>`;
  const table = (rows) => `<!doctype html><html><head><title>Tee times</title></head><body><table><tr><th>Day</th><th>Time</th><th>Players</th><th></th></tr>${rows.map((r) => `<tr><td>Sat Oct 18</td><td>${r}</td><td>4 players</td><td>Book</td></tr>`).join("")}</table></body></html>`;
  jev.waiting = (state) => (/2:00 PM|1:30 PM|17:05/.test(state.added) ? 0.95 : 0.1);
  jev.item = () => "l0";
  await check("a new slot button is judged and told", async () => {
    pages.set("/slots", { body: slots(["9:00 AM"]) });
    const w = await W.startPageWatch("boppy", { url: at("/slots"), lookFor: "an afternoon slot opens" });
    assert.ok(w.page.lines.includes("9:00 AM"), "the slot is kept");
    pages.set("/slots", { body: slots(["9:00 AM", "2:00 PM"]) });
    wait(30);
    assert.equal(await tick(w.id), "told");
    assert.equal(judged().at(-1).state.added, "2:00 PM");
    assert.equal(headsUps(w.id).at(-1)?.text, "Heads up, something new on Clinic: “2:00 PM”");
  });
  await check("a new row in a table, different only by its time, is judged and told", async () => {
    pages.set("/tee", { body: table(["8:10 AM"]) });
    const w = await W.startPageWatch("boppy", { url: at("/tee"), lookFor: "an afternoon tee time" });
    pages.set("/tee", { body: table(["8:10 AM", "1:30 PM"]) });
    wait(30);
    assert.equal(await tick(w.id), "told");
    assert.equal(judged().at(-1).state.added, "Sat Oct 18 · 1:30 PM · 4 players · Book");
  });
  await check("a departure that moved is judged, with the time it had", async () => {
    serve("/departures", "Departures", ["Departures", "UA 123 · Chicago · 16:30 · On time"]);
    const w = await W.startPageWatch("boppy", { url: at("/departures"), lookFor: "my flight is delayed" });
    serve("/departures", "Departures", ["Departures", "UA 123 · Chicago · 17:05 · Delayed"]);
    wait(30);
    assert.equal(await tick(w.id), "told");
    assert.equal(judged().at(-1).state.before, "UA 123 · Chicago · 16:30 · On time");
  });
  await check("a status page whose stamp moves every read (in the forms sites use) costs nothing", async () => {
    const status = (t, left) => ["All systems operational", `Last updated: Mon, 13 Oct 2026 ${t}:10 GMT`, `Last updated: October 13, 2026 at ${t} PM`, `Next refresh in ${left} seconds`, "API · Operational"];
    serve("/status", "Status", status("3:45", 45));
    const w = await W.startPageWatch("boppy", { url: at("/status") });
    const j = judged().length;
    for (const [t, left] of [["4:15", 12], ["4:45", 30], ["5:15", 5]]) {
      serve("/status", "Status", status(t, left));
      wait(30);
      assert.equal(await tick(w.id), "same");
    }
    assert.equal(judged().length, j);
  });
  jev.waiting = () => 0.9;
  jev.item = () => "l0";
});

test("an unchanged read writes nothing, and the window still sees it was checked", async () => {
  jevOn();
  const id = await pageWatch("/quiet", BASE);
  const stored = watchOf(id).page.checkedAt;
  wait(30);
  assert.equal(await tick(id), "same");
  await check("not saved", () => assert.equal(watchOf(id).page.checkedAt, stored));
  await check("but shown", () => {
    const shown = W.watchesForApp(S.getState().watches).find((w) => w.id === id);
    assert.ok(shown.page.checkedAt > stored);
    assert.equal(shown.page.digests, undefined, "what's kept to compare stays on the server");
    assert.equal(shown.page.lines, undefined);
  });
  await check("and the next read waits from then", async () => {
    wait(29);
    await tick(id);
    assert.equal(hitsOf("/quiet"), 2);
  });
  await check("saved again once an hour", async () => {
    wait(31);
    await tick(id);
    wait(30);
    assert.equal(await tick(id), "same");
    assert.ok(watchOf(id).page.checkedAt > stored);
  });
});

test("a page watch with no look_for looks for what its address lists", async () => {
  serve("/repo/releases", "Releases", ["v1.0.0", "First release"]);
  serve("/repo/releases/latest", "Latest", ["v1.0.0"]);
  serve("/repo/issues", "Issues", ["Bug one", "Bug two"]);
  serve("/plain", "Plain", ["Some text"]);
  await check("releases, issues, anything else", async () => {
    assert.equal((await W.startPageWatch("boppy", { url: at("/repo/releases") })).lookFor, "a new release");
    assert.equal((await W.startPageWatch("boppy", { url: at("/repo/issues") })).lookFor, "a new issue");
    assert.equal((await W.startPageWatch("boppy", { url: at("/plain") })).lookFor, "anything new on the page");
    assert.equal((await W.startPageWatch("boppy", { url: at("/repo/releases/latest"), lookFor: "a release with ARM builds" })).lookFor, "a release with ARM builds", "what the user said wins");
  });
});

/* ---------------- Screen watches, and moving a bot ---------------- */

test("a screen watch: a clock on the page is not a change", async () => {
  jevOn();
  S.update((s) => {
    s.host = "mac";
    s.watches.push({ id: "watch_screen", botId: "boppy", display: 100, site: "News", lookFor: "a story about Bops", since: 0 });
  });
  let screenLines = ["Top stories", "Bops ships monitors", "Updated 3:45 PM", "12 comments"];
  globalThis.__testScreen = async () => ({ url: "https://news.example/", title: "News 3:45", lines: screenLines });
  const reads = () => jev.calls.filter(isScreenRead).length;
  const r0 = reads();
  await check("the first look reads it", async () => {
    await tick("watch_screen");
    assert.equal(reads(), r0 + 1);
  });
  await check("only the clock and an age moved: no Jev read", async () => {
    screenLines = ["Top stories", "Bops ships monitors", "Updated 3:52 PM", "12 comments", "Posted 9m ago"];
    globalThis.__testScreen = async () => ({ url: "https://news.example/", title: "News 3:52", lines: screenLines });
    skew += 31_000;
    assert.equal(await tick("watch_screen"), "same");
    assert.equal(reads(), r0 + 1);
  });
  await check("a counter that ticked is not read either (a feed's counts would cost a read every look)", async () => {
    const r1 = reads();
    screenLines = ["Top stories", "Bops ships monitors", "Updated 4:05 PM", "15 comments", "Posted 22m ago"];
    skew += 31_000;
    assert.equal(await tick("watch_screen"), "same");
    for (const [views, likes] of [["1.2K", 340], ["1.3K", 352], ["2K", 400]]) {
      screenLines = ["Top stories", "Bops ships monitors", "Updated 4:05 PM", `${views} views · ${likes} likes`, "Posted 22m ago"];
      skew += 31_000;
      await tick("watch_screen");
    }
    assert.equal(reads(), r1 + 1, "read once, when the views line first showed, then not again");
  });
  await check("a new story is read (told a moved count isn't news unless asked)", async () => {
    const r1 = reads();
    screenLines = ["Top stories", "Bops raises a round", "Bops ships monitors", "Updated 4:11 PM"];
    skew += 31_000;
    await tick("watch_screen");
    assert.equal(reads(), r1 + 1);
    assert.match(jev.calls.filter(isScreenRead).at(-1).questions.waiting.instructions, /a count that ticked/);
  });
  await check("a reply that differs from an earlier one only by its time is read", async () => {
    screenLines = ["Top stories", "Bops raises a round", "Bops ships monitors", "Updated 3:59 PM", "Them: 9:30", "Me: what time tomorrow?"];
    skew += 31_000;
    await tick("watch_screen");
    const r1 = reads();
    screenLines = [...screenLines, "Them: 10:15"];
    skew += 31_000;
    await tick("watch_screen");
    assert.equal(reads(), r1 + 1);
  });
  await check("paused: not looked at", async () => {
    const r = reads();
    W.setWatchPaused("watch_screen", true);
    screenLines = ["Top stories", "Another story"];
    skew += 31_000;
    assert.equal(await tick("watch_screen"), undefined);
    assert.equal(reads(), r);
  });
});

test("moving a bot: a page watch doesn't hold it, a screen watch does", async () => {
  await check("a page watch only: Max can move", async () => {
    serve("/max", "Max page", ["Something to watch"]);
    await W.startPageWatch("max", { url: at("/max") });
    assert.deepEqual(await Bots.setComputer("max", "shared"), { ok: true });
  });
  await check("a screen watch: Max can't", async () => {
    S.update((s) => {
      s.bots.find((b) => b.id === "max").computer = "own";
      s.watches.push({ id: "watch_max_screen", botId: "max", display: 100, site: "X", lookFor: "DMs", since: 0 });
    });
    const r = await Bots.setComputer("max", "shared");
    assert.match(r.error ?? "", /is watching a screen/);
  });
});

/* ---------------- Run ---------------- */

for (const [name, fn] of parts) {
  part = name;
  try {
    await fn();
    console.log(`${failures.some((f) => f.startsWith(`${name} ›`)) ? "FAIL" : "ok  "} ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e.message}`);
    console.log(`FAIL ${name}`);
  }
}
part = "after";
await check("nothing the user reads has a dash", () => spoken.forEach(noDashes));
await check("nothing went offline", () => assert.deepEqual(offline, []));
await check("no unhandled rejections", () => assert.deepEqual(rejections, []));
server.close();
// The throwaway folder goes (the state saved there is small, but the disk may not have room to spare).
process.chdir(tmpdir());
rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} failed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
  if (warned.length) console.log(`\nwarnings:\n${warned.slice(-10).map((w) => `  ${w}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nall ${parts.length} parts passed`);
process.exit(0);
