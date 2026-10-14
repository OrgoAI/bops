// Tests for monitors: the steady form pages are compared in (cloud/page-diff.ts: times, relative dates,
// ids and counters out; prices and other numbers kept), and web page watches (lib/server/watches.ts,
// app/api/watches): the first read is how the page is; a page that didn't change, or only changed its
// times, costs no model call; lines that were added get exactly one judge call (Jev, or one quick OpenAI
// call when Jev isn't there) and a heads-up when they match; a page that fails is read less and less
// often until it answers again; a paused watch is left alone until it's resumed or checked by hand.
// Screen watches compare pages the same way (a clock on the screen is not a change), and a page watch
// doesn't keep a bot from moving computers the way a screen watch does.
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

test("normalizeLine: times, dates, ids and counters out; prices and numbers kept", async () => {
  const table = [
    // Clock times.
    ["Updated 3:45 PM", "Updated"],
    ["Last updated: 15:45:10", "Last updated"],
    // A time that's what's on the page (a meeting, a departure, a score) stays; one that stamps it goes.
    ["Meet at 9:05 a.m. EST", "Meet at 9:05 a.m. EST"],
    ["Departs 16:30", "Departs 16:30"],
    ["Kiel 28:25 Flensburg", "Kiel 28:25 Flensburg"],
    ["As of 3:45 PM", "As of"],
    ["Prices · 3:45 PM", "Prices"],
    ["3:45", ""],
    // Relative times.
    ["Posted 5 minutes ago", ""],
    ["2h ago", ""],
    ["just now", ""],
    ["about an hour ago", ""],
    ["Updated yesterday at 3:45 PM", ""],
    ["updated 3 days ago", ""],
    ["Comment from Dana, 12 min ago", "Comment from Dana"],
    ["@jordan · 2h", "@jordan"],
    ["Sale ends in 3 hours", "Sale ends"],
    // ISO and numeric dates, timestamps.
    ["2026-10-13T15:45:10Z", ""],
    ["Built 2026-10-13 15:45 UTC", "Built"],
    ["Ships 10/14/2026", "Ships 10/14/2026"],
    ["Next available: 11/30/2026 9:00 AM", "Next available: 11/30/2026 9:00 AM"],
    ["Appointment 2026-11-30", "Appointment 2026-11-30"],
    ["Bulletin · 10/13/2026", "Bulletin"],
    ["10/13/2026", ""],
    ["Log 2026-10-13 15:45:10 started", "Log started"],
    ["Ships in 2 days", "Ships in 2 days"],
    ["2 days left to apply", "2 days left to apply"],
    // Ids and cache busters.
    ["app.js?v=a1b2c3d4e5f6a7b8c9d0", "app.js?v="],
    ["Request 550e8400-e29b-41d4-a716-446655440000 done", "Request done"],
    ["Session 9fJ2kq8ZLmP3xT7vQa1B", "Session"],
    // Counters next to their word.
    ["1.2K views", "views"],
    ["Likes: 340", "Likes"],
    ["1,204 watching", "watching"],
    ["about an hour ago · 12 comments", "comments"],
    // Counts people watch for stay on a line of their own, and go in a feed's line about a post.
    ["3,401 followers", "3,401 followers"],
    ["12,345 stars", "12,345 stars"],
    ["123 points by pg 2 hours ago | hide | 45 comments", "points by pg | hide | comments"],
    ["@dana · 1,204 followers", "@dana · followers"],
    ["Viewed 1,204 times", "Viewed"],
    ["1,234 users online", "users online"],
    ["4.5 stars", "4.5 stars"],
    // A rank in front moves as the list reorders.
    ["3. Bops ships monitors", "Bops ships monitors"],
    // Kept as they are.
    ["Bitcoin 86,200", "Bitcoin 86,200"],
    ["$49 / month", "$49 / month"],
    ["Bitcoin $86,200.15 (+2.3%)", "Bitcoin $86,200.15 (+2.3%)"],
    ["-2.3% today", "-2.3%"],
    ["Dow down 500 points", "Dow down 500 points"],
    ["3 new replies", "3 new replies"],
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
});

test("normalizeLines and addedLines", async () => {
  await check("empties dropped, each line once, in order", () =>
    assert.deepEqual(PD.normalizeLines(["B 1", "3:45 PM", "A", "B 1", "Updated 2m ago", "A  "]), ["B 1", "A"]));
  await check("only the lines new since before, as the page has them", () =>
    assert.deepEqual(PD.addedLines(["Bitcoin $85,100", "Updated 3:45 PM", "5 min ago"], ["Updated 3:52 PM", "Bitcoin  $86,200", "Bitcoin $85,100", "6 min ago", "Bitcoin  $86,200"]), ["Bitcoin $86,200"]));
  await check("before may already be in the steady form", () =>
    assert.deepEqual(PD.addedLines(PD.normalizeLines(["Hi 1,204 watching", "x"]), ["Hi 1,300 watching", "x", "y"], { normalized: true }), ["y"]));
  await check("lines already in the steady form aren't normalized again (that would take more out)", () => {
    const kept = PD.snapshotLines(["Episode 12 1.2K views", "Other"]).lines;
    assert.deepEqual(kept, ["Episode 12 views", "Other"]);
    assert.deepEqual(PD.addedLines(kept, ["Episode 12 1.3K views", "Other2"], { normalized: true }), ["Other2"]);
  });
  await check("two lines that differ only by a date both stay", () => {
    assert.deepEqual(PD.normalizeLines(["Bulletin 10/14/2026", "Bulletin 10/13/2026"]), ["Bulletin 10/14/2026", "Bulletin 10/13/2026"]);
    const kept = PD.snapshotOf(PD.pageLinesOf(["Bulletin 10/13/2026"]));
    const now = PD.snapshotOf(PD.pageLinesOf(["Bulletin 10/14/2026", "Bulletin 10/13/2026"]));
    assert.notEqual(now.hash, kept.hash, "a new bulletin changes the page");
    assert.deepEqual(PD.pageDiff(kept.digests, [], PD.pageLinesOf(["Bulletin 10/14/2026", "Bulletin 10/13/2026"])).added.map((l) => l.raw), ["Bulletin 10/14/2026"]);
  });
  await check("a new slot, a new departure time, a new score are changes", () => {
    for (const [a, b] of [
      ["Next available: 11/30/2026 9:00 AM", "Next available: 10/21/2026 10:30 AM"],
      ["Departs 16:30", "Departs 17:45"],
      ["Kiel 28:25 Flensburg", "Kiel 29:25 Flensburg"],
      ["Ships in 2 days", "Ships in 5 days"],
      ["9,998 followers", "10,002 followers"],
      ["Them: 9:30", "Them: 10:15"],
      ["Are you free at 3:00?", "Are you free at 5:00?"],
    ])
      assert.notEqual(PD.normalizeLine(a), PD.normalizeLine(b), `${a} / ${b}`);
  });
  await check("nothing added when only times moved", () => assert.deepEqual(PD.addedLines(BASE, BASE.map((l) => l.replace("3:45", "3:52").replace("5 minutes", "6 minutes"))), []));
  await check("snapshotLines keeps the first lines that fit, and the raw lines with them", () => {
    const s = PD.snapshotLines(["a 1", "b 2", "3:45", "c 3", "d 4"], 3, 100);
    assert.deepEqual(s.lines, ["a 1", "b 2", "c 3"]);
    assert.deepEqual(s.raw, ["a 1", "b 2", "c 3"]);
    assert.deepEqual(PD.snapshotLines(["aaaa", "bbbb", "cccc"], 10, 10).lines, ["aaaa", "bbbb"], "and stops at the size cap");
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
    assert.ok(w.page.lines.includes("Updated"), "the time is out");
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

test("the loop: nothing until due; the same page, or only its times, costs nothing", async () => {
  jevOn();
  const id = await pageWatch("/loop", BASE);
  const judged = () => jev.calls.filter(isJudge).length;
  const j0 = judged();
  await check("not read again before its minutes are up", async () => {
    wait(29);
    await tick(id);
    assert.equal(hitsOf("/loop"), 1);
  });
  await check("read when due; unchanged, no model call", async () => {
    wait(1);
    assert.equal(await tick(id), "same");
    assert.equal(hitsOf("/loop"), 2);
    assert.equal(judged(), j0);
  });
  await check("only times, ages and counters changed: the same page, no model call", async () => {
    serve("/loop", "Prices", ["Bitcoin $85,100", "Ethereum $3,050", "Updated 4:15 PM", "Posted 35 minutes ago", "1,388 watching", "Prices refresh every minute"]);
    wait(30);
    const hash = watchOf(id).page.hash;
    assert.equal(await tick(id), "same");
    assert.equal(hitsOf("/loop"), 3);
    assert.equal(watchOf(id).page.hash, hash);
    assert.equal(judged(), j0);
    assert.equal(headsUps(id).length, 0);
  });
  await check("a line went away, nothing added: kept, no model call", async () => {
    serve("/loop", "Prices", ["Bitcoin $85,100", "Updated 4:45 PM"]);
    wait(30);
    assert.equal(await tick(id), "changed");
    assert.equal(judged(), j0);
    assert.ok(!watchOf(id).page.lines.includes("Ethereum $3,050"));
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
    // A page on a bare address is named by its title (lib/watch-sites.ts siteOf).
    assert.equal(m[0].text, "Heads up, something new on Prices: “Bitcoin $86,200”");
    spoken.push(m[0].text);
    const w = watchOf(id);
    assert.equal(w.alert.text, "Bitcoin $86,200");
    assert.deepEqual(w.told, ["Bitcoin $86,200"]);
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
  await check("the same thing again, in other times: not told twice", async () => {
    jev.waiting = () => 0.95;
    jev.item = () => "l0";
    // (A time as its own part of the line stamps it; "at 4:40 PM" between words would be what's on the page.)
    serve("/change", "Prices", ["Bitcoin $86,200 · 4:40 PM", "Ethereum $3,100"]);
    wait(30);
    assert.equal(await tick(id), "changed");
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
    // The line as the page has it ("today" is only taken out to compare).
    assert.deepEqual(openai.calls[0].input.added, ["0: Solana listed today"]);
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
  await check("resumed: it reads at once, and what changed while paused is judged", async () => {
    const judged = jev.calls.filter(isJudge).length;
    serve("/pause", "Prices", [...BASE, "Bitcoin $86,500"]);
    W.setWatchPaused(id, false);
    assert.equal(watchOf(id).paused, undefined);
    for (let i = 0; i < 100 && hitsOf("/pause") < 3; i++) await sleep(20);
    await sleep(50);
    assert.equal(hitsOf("/pause"), 3);
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
    assert.ok(p.lines.join("\n").length <= 8_000);
    assert.ok(p.lines.includes("Comment 181 from Dana: the build is out"), "the line just added is kept as text");
  });
  jev.waiting = () => 0.9;
});

test("more new lines than one judge call takes: judged in turn, none lost", async () => {
  jevOn();
  const id = await pageWatch("/listings", ["Listings", "Filter by city"], { lookFor: "a loft in Brooklyn" });
  const judged = () => jev.calls.filter(isJudge);
  const j0 = judged().length;
  const items = Array.from({ length: 60 }, (_, i) => (i === 49 ? "Loft in Brooklyn, $2,400" : `Studio ${i + 1} in Queens, $1,${(100 + i).toString()}`));
  jev.waiting = (state) => (state.added.includes("Brooklyn") ? 0.95 : 0.1);
  jev.item = (state) => `l${state.added.split("\n").findIndex((l) => l.includes("Brooklyn"))}`;
  serve("/listings", "Prices", ["Listings", "Filter by city", ...items]);
  wait(30);
  await check("the match at line 50 is judged in the second call and told", async () => {
    assert.equal(await tick(id), "told");
    const calls = judged().slice(j0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].state.added.split("\n").length, 40);
    assert.equal(calls[1].state.added.split("\n").length, 20);
    assert.equal(headsUps(id).at(-1)?.text, "Heads up, something new on Prices: “Loft in Brooklyn, $2,400”");
  });
  await check("past three calls, the rest waits for the next read (not taken in unjudged)", async () => {
    const more = Array.from({ length: 150 }, (_, i) => `Room ${i + 1} in the Bronx, $900`);
    jev.waiting = () => 0.1;
    serve("/listings", "Prices", ["Listings", "Filter by city", ...items, ...more]);
    wait(30);
    const before = judged().length;
    assert.equal(await tick(id), "changed");
    assert.equal(judged().length - before, 3, "three calls, 120 lines");
    wait(30);
    const next = judged().length;
    assert.equal(await tick(id), "changed");
    const left = judged().slice(next);
    assert.equal(left.length, 1);
    assert.deepEqual(left[0].state.added.split("\n"), more.slice(120), "the 30 left over");
  });
  jev.waiting = () => 0.9;
  jev.item = () => "l0";
});

test("what comes and goes isn't news: points ticking, a banner coming back, a cookie page", async () => {
  jevOn();
  const judged = () => jev.calls.filter(isJudge).length;
  const stories = Array.from({ length: 12 }, (_, i) => `Story ${i + 1} about databases`);
  const hn = (points) => stories.flatMap((t, i) => [`${i + 1}. ${t}`, `${points + i} points by user${i} 2 hours ago | hide | ${10 + i} comments`]);
  const id = await pageWatch("/hn", [...hn(100), "Banner: spring sale"], { lookFor: "a story about Bops" });
  const j0 = judged();
  await check("only points and comment counts moved: the same page, no judge call", async () => {
    serve("/hn", "Prices", [...hn(140), "Banner: spring sale"]);
    wait(30);
    assert.equal(await tick(id), "same");
    assert.equal(judged(), j0);
  });
  await check("a banner that goes and comes back isn't new", async () => {
    serve("/hn", "Prices", [...hn(140), "Banner: free shipping"]);
    wait(30);
    await tick(id);
    const j1 = judged();
    serve("/hn", "Prices", [...hn(140), "Banner: spring sale"]);
    wait(30);
    assert.equal(await tick(id), "changed");
    assert.equal(judged(), j1, "no judge call for the banner that came back");
  });
  await check("a cookie page served instead is kept out, and the page after it isn't all new", async () => {
    const kept = watchOf(id).page.hash;
    serve("/hn", "Prices", ["We use cookies", "Accept all", "Manage settings"]);
    wait(30);
    assert.equal(await tick(id), "failed");
    assert.equal(watchOf(id).page.hash, kept);
    assert.match(watchOf(id).page.error, /looked like something else/);
    spoken.push(watchOf(id).page.error);
    serve("/hn", "Prices", [...hn(150), "Banner: spring sale"]);
    wait(60);
    const j2 = judged();
    assert.equal(await tick(id), "same");
    assert.equal(judged(), j2);
    assert.equal(watchOf(id).page.error, undefined);
  });
  await check("a page that really changed is taken in after a few reads", async () => {
    const other = Array.from({ length: 12 }, (_, i) => `Totally new layout line ${i + 1}`);
    serve("/hn", "Prices", other);
    for (let i = 0; i < 2; i++) {
      wait(240);
      assert.equal(await tick(id), "failed");
    }
    wait(480);
    assert.notEqual(await tick(id), "failed");
    assert.equal(watchOf(id).page.odd, undefined);
  });
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
  await check("only the clock and a counter moved: no Jev read", async () => {
    screenLines = ["Top stories", "Bops ships monitors", "Updated 3:52 PM", "15 comments"];
    globalThis.__testScreen = async () => ({ url: "https://news.example/", title: "News 3:52", lines: screenLines });
    skew += 31_000;
    assert.equal(await tick("watch_screen"), "same");
    assert.equal(reads(), r0 + 1);
  });
  await check("a new story is read", async () => {
    screenLines = ["Top stories", "Bops raises a round", "Bops ships monitors", "Updated 3:59 PM"];
    skew += 31_000;
    await tick("watch_screen");
    assert.equal(reads(), r0 + 2);
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
