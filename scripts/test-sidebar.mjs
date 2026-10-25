// Tests for the sidebar's sections (components/app/sidebar-sections.tsx, Sidebar in sidebar.tsx,
// lib/favorites.ts): what waits on the user goes under the bot it's from (an issue waiting on us under
// the bot that opened it, or the main bot's; urgent alerts under theirs; Setup under the main bot), and
// Needs your attention is first in Favorites with how many things wait, only while something does, even
// with nothing pinned; Favorites shows Issues, Tasks and People until the workspace changes them, its own
// list after that (an empty one hides it), only with Knowledge, in the user's order, with a number only
// when there's something to act on, and pins and moves keep what this build doesn't know; Knowledge's
// chips pin and unpin (All never); the main bot's is a chat row like the others, pinned first, with a
// star on its avatar; a routine's post on a row names its routine; under each bot's row, folded by
// default, its cards (three, the rest behind "Show N more") over its threads, with a chip that counts
// both and says whether something needs you or one is working, open as this Mac remembers it; and a
// search still lists the matching threads flat under Threads.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-sidebar.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

// A window, enough of one (nothing here runs effects: it's rendered to HTML). What this Mac remembers
// is `stored`, which a test fills; a storage that throws is tried too.
const stored = new Map();
let storageThrows = false;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = {
  getItem: (k) => {
    if (storageThrows) throw new Error("no storage");
    return stored.get(k) ?? null;
  },
  setItem: (k, v) => {
    if (storageThrows) throw new Error("no storage");
    stored.set(k, v);
  },
  removeItem: (k) => stored.delete(k),
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { Sidebar } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const S = await import(pathToFileURL(`${root}/components/app/sidebar-sections.tsx`).href);
const F = await import(pathToFileURL(`${root}/lib/favorites.ts`).href);
const Fav = await import(pathToFileURL(`${root}/components/app/favorites.tsx`).href);
const { MemoryPage } = await import(pathToFileURL(`${root}/components/app/memory-categories.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const NOW = Date.now();
const min = (n) => NOW - n * 60_000;

/* ---------------- A workspace ---------------- */

const bot = (id, name, extra = {}) => ({ id, name, color: "#4F7BF7", role: "Helper", ...extra });
const session = (id, botId, extra = {}) => ({ id, botId, chatId: `chat_${botId}`, title: `Thread ${id}`, goal: "", sentVia: "you", host: "cloud", status: "done", replies: [], createdAt: min(100), endedAt: min(90), ...extra });
const asking = (id, botId, endedAt, extra = {}) => session(id, botId, { status: "done", waitingOnYou: true, endedAt, ...extra });
const chat = (id, botIds, kind = "bot") => ({ id, kind, botIds, typing: [], createdAt: min(500) });

function world(over = {}) {
  return {
    account: { user: { id: "u1", name: "Tess Ito", email: "tess@example.com" } },
    workspace: "ws_main",
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }, { id: "ws_two", name: "Two", createdAt: 2 }],
    bots: [bot("boppy", "Sam", { isMain: true }), bot("nova", "Nova"), bot("pip", "Pip"), bot("far", "Far", { workspaceId: "ws_two" })],
    chats: [chat("chat_boppy", ["boppy"]), chat("chat_nova", ["nova"]), chat("chat_pip", ["pip"]), chat("chat_group", ["nova", "pip"], "group"), chat("chat_far", ["far"])],
    routines: [],
    watches: [],
    sessions: [],
    messages: [],
    accounts: [],
    ...over,
  };
}

const render = (state, extra = {}) =>
  renderToStaticMarkup(
    h(Sidebar, {
      state,
      chatId: "chat_nova",
      onOpenChat: noop,
      onOpenThread: noop,
      onCompose: noop,
      onSettings: noop,
      onAccount: noop,
      onSetup: noop,
      onVault: noop,
      onMembers: noop,
      onOpenWatch: noop,
      onOpenMemory: noop,
      onOpenAutopilot: noop,
      ...extra,
    }),
  );

/** Where a mark first shows in the HTML (-1: not there). */
const at = (html, s) => html.indexOf(s);
/** The HTML of one bot's row with its threads. */
const botBlock = (html, botId) => {
  const start = html.indexOf(`data-bot-threads="${botId}"`);
  if (start < 0) return null;
  const next = html.indexOf("data-bot-threads=", start + 10);
  return html.slice(start, next < 0 ? undefined : next);
};
const threadIds = (part) => [...part.matchAll(/data-thread="([^"]+)"/g)].map((m) => m[1]);

/* ---------------- Needs your attention ---------------- */

const issue = (id, extra = {}) => ({ id, ws: "ws_main", status: "waiting_us", priority: "normal", tags: ["Customer"], title: `Issue ${id}`, summary: "", botId: "nova", openedAt: min(60), updatedAt: min(30), ...extra });
const alertOf = (id, botId, level = "now", when = min(2)) => ({ id, botId, site: "Gmail", lookFor: "", display: 99, since: 1, alert: { text: `Alert ${id}`, at: when, ...(level ? { level } : {}) } });

await test("Needs your attention: an issue waiting on us under the bot that opened it (the main bot's when none here did), urgent alerts under theirs, Setup under the main bot", () => {
  const state = world({
    watches: [alertOf("w1", "nova", "now", min(1)), alertOf("w2", "nova", null, min(3)), alertOf("wq", "nova", "quiet"), alertOf("wf", "far")],
    sessions: [asking("s1", "pip", min(5)), asking("quiet", "pip", min(3), { routineId: "r1", answer: "NOTHING", waitingOnYou: true }), asking("s9", "far", min(5))],
  });
  const issues = [
    issue("i1"),
    issue("i2", { priority: "urgent", updatedAt: min(90) }),
    issue("i3", { status: "open" }),
    issue("i4", { status: "done" }),
    issue("i5", { botId: undefined }),
    issue("i6", { botId: "ghost" }),
    issue("i7", { botId: "pip", status: "waiting_them" }),
  ];
  const needs = S.needsByBot(state, issues, ["notifications"]);
  assert.deepEqual(needs.get("nova").issues.map((i) => i.id), ["i2", "i1"], "waiting on us only, urgent first");
  assert.deepEqual(needs.get("nova").alerts.map((w) => w.id), ["w1", "w2"], "level now (or none, from before levels), the newest first; not a quiet one");
  assert.deepEqual(needs.get("boppy").issues.map((i) => i.id), ["i5", "i6"], "no bot, or one that's gone: the main bot's");
  assert.deepEqual(needs.get("boppy").setup, ["notifications"], "Setup under the main bot");
  assert.equal(needs.has("pip"), false, "nothing of Pip's waits on us");
  assert.equal(needs.has("far"), false, "another workspace's alert isn't this one's");
  const a = S.attentionOf(state, needs);
  assert.equal(a.count, 2 + 2 + 2 + 1 + 1, "issues, alerts, setup, and the thread that asked (not a quiet nothing, not another workspace's)");
  assert.deepEqual([...a.bots].sort(), ["boppy", "nova", "pip"], "the bots it opens");
  assert.equal(S.needsByBot(world(), null, []).size, 0, "issues not in yet, and nothing else: nothing at all");
});

await test("Under a bot: what waits on the user from it as cards, then its threads; the chip counts both and, folded, marks it", () => {
  stored.clear();
  const needs = { asks: [], issues: [1, 2, 3, 4].map((n) => issue(`i${n}`, { title: `Customer ${n} needs a reply`, customer: { name: `c${n}@example.com` }, tags: ["Customer", "Bug"] })), alerts: [alertOf("w1", "nova")], setup: [] };
  const props = { user: "u1", ws: "ws_main", botId: "nova", name: "Nova", threads: [session("t1", "nova")], needs, row: (space) => h("div", null, "ROW", space), onOpenThread: noop, onOpenIssue: noop, onOpenWatch: noop, onSetup: noop };
  let html = renderToStaticMarkup(h(S.WithThreads, props));
  assert.match(html, /aria-label="Nova: 5 waiting on you, 1 thread"/, "what waits and the threads");
  assert.match(html, /data-chip-mark="you"[^>]*><\/span>6</, "folded: the count of both, and the mark that something needs you");
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  html = renderToStaticMarkup(h(S.WithThreads, props));
  assert.deepEqual([...html.matchAll(/data-need="([^"]+)"/g)].map((m) => m[1]), [`alert:w1:${min(2)}`, "issue:i1", "issue:i2"], "the alert, then the issues: three, the rest behind Show N more");
  assert.match(html, />Show 2 more</);
  assert.ok(at(html, "data-need=") < at(html, 'data-thread="t1"'), "the cards over the threads");
  assert.match(html, />Customer 1 needs a reply</);
  assert.match(html, />c1@example\.com · 30m · Customer · Bug</, "one line under it: who, when, its tags");
  assert.match(html, /class="truncate text-\[13px\][^"]*">Customer 1 needs a reply</, "the title on one line, cut short");
  assert.match(html, /title="Customer 1 needs a reply\nc1@example\.com · 30m · Customer · Bug"/, "all of it in the tooltip");
  assert.ok(!html.includes("data-chip-mark"), "open: no mark");
  // Only threads: as before, the threads' own mark.
  html = renderToStaticMarkup(h(S.WithThreads, { ...props, needs: undefined, threads: [session("t2", "nova", { status: "running" })] }));
  assert.ok(!html.includes("data-need="), "no cards");
  // Nothing under it: just its row.
  html = renderToStaticMarkup(h(S.WithThreads, { ...props, needs: undefined, threads: [] }));
  assert.ok(!html.includes("data-bot-threads") && !html.includes("aria-expanded"), "no chip");
  stored.clear();
});

await test("Needs your attention: first in Favorites with how many things wait, only while something does, there without any pins too", () => {
  stored.clear();
  let html = render(world({ sessions: [session("s1", "nova")] }));
  assert.equal(at(html, 'data-favorite="attention"'), -1, "nothing waits: no row");
  const waiting = { sessions: [asking("s1", "nova", min(12))], watches: [alertOf("w1", "pip")] };
  html = render(world(waiting));
  const row = at(html, 'data-favorite="attention"');
  assert.ok(row > 0 && row < at(html, 'data-favorite="issues"'), "first in Favorites");
  assert.match(html, /Needs your attention<\/span><span[^>]*>2<\/span>/, "the thread waiting and the alert");
  assert.equal(at(html, 'data-section="needs-you"'), -1, "no section of its own at the top any more");
  // The alert's card is under Pip, once it's open.
  stored.set("bops.threads.open.u1.ws_main.pip", "1");
  assert.ok(botBlock(render(world(waiting)), "pip").includes(`data-need="alert:w1:${min(2)}"`));
  stored.clear();
  // No pins: still there, alone.
  html = render(world({ ...waiting, workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, favorites: [] }] }));
  assert.ok(at(html, 'data-favorite="attention"') > 0 && at(html, 'data-favorite="issues"') === -1, "the row without the pins");
  // While searching, gone with the rest of Favorites.
  assert.equal(at(render(world(waiting), { search: "thread" }), 'data-favorite="attention"'), -1);
});

await test("Needs your attention: what a bot waits on your OK for (wherever its run runs) is a card under it with Deny, Always allow and Allow once, counted once with the thread waiting on it, which says Waiting for your OK; one answered already isn't, nor another workspace's", () => {
  stored.clear();
  const ask = (id, botId, extra = {}) => ({ id, botId, chatId: `chat_${botId}`, askedBy: "dev_runner_c1", action: "Send Email in Gmail (sam@acme.com)", resources: ["dana@acme.example"], preview: "to: dana@acme.example", at: min(4), ...extra });
  // Paused for the OK: queued, holding nothing, its status the request's (lib/types.ts waitsForOk).
  const waits = session("s_ok", "nova", { status: "queued", endedAt: undefined });
  const state = world({ sessions: [waits], appApprovals: [ask("a1", "nova", { threadId: "s_ok" }), ask("a2", "pip"), ask("a3", "pip", { reply: { reply: "once", at: min(1) } }), ask("a4", "far")] });
  const needs = S.needsByBot(state, null, []);
  assert.deepEqual(needs.get("nova").asks.map((x) => [x.ask.id, x.where]), [["a1", "Thread s_ok"]], "for its thread");
  assert.deepEqual(needs.get("pip").asks.map((x) => x.ask.id), ["a2"], "an answered one isn't waiting");
  assert.equal(needs.has("far"), false, "another workspace's isn't this one's");
  assert.equal(S.attentionOf(state, needs).count, 2, "Nova's thread and its request count once, and Pip's request");
  stored.set("bops.threads.open.u1.ws_main.pip", "1");
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const html = render(state);
  const pip = botBlock(html, "pip");
  assert.ok(pip.includes('data-need="ask:a2"'), "under Pip");
  assert.match(pip, />Pip wants to send Email in Gmail \(sam@acme\.com\)</);
  assert.match(pip, />Waiting for your OK · 4m</);
  assert.match(pip, />Deny<\/button><button[^>]*>Always allow<\/button><button[^>]*>Allow once<\/button>/);
  assert.ok(!pip.includes("ask:a3"));
  // Its thread under Nova says it waits on you, from the request alone.
  assert.match(botBlock(html, "nova"), /data-thread="s_ok"[\s\S]*data-tip="Waiting for your OK"/);
  assert.match(html, /Needs your attention<\/span><span[^>]*>2<\/span>/);
  // Answered: the thread's status goes with it, nothing else to clear.
  const answered = render(world({ sessions: [waits], appApprovals: [ask("a1", "nova", { threadId: "s_ok", reply: { reply: "once", at: min(1) } })] }));
  assert.doesNotMatch(botBlock(answered, "nova"), /Waiting for your OK/);
  assert.equal(S.needsByBot({ ...state, shared: { wsId: "ws_main" } }, null, []).size, 0, "in a workspace shared with you, the owner's to answer");
  stored.clear();
});

/* ---------------- The main bot ---------------- */

await test("The main bot: a two-line chat row like every bot's, pinned first, marked only by the star on its avatar", () => {
  stored.clear();
  const role = (state) => ({ ...state, bots: state.bots.map((b) => (b.isMain ? { ...b, role: "Chief of Staff" } : b)) });
  const state = role(world({ messages: [{ id: "m1", chatId: "chat_nova", role: "bot", botId: "nova", text: "Newest", at: min(1) }, { id: "m2", chatId: "chat_boppy", role: "bot", botId: "boppy", text: "Done with the deck", at: min(30) }] }));
  const html = render(state);
  const sam = at(html, ">Sam<");
  assert.ok(sam > 0 && sam < at(html, ">Nova<"), "first, though Nova spoke last");
  assert.match(html, />Sam<\/span><span class="[^"]*">Chief of Staff<\/span>/, "its name with its role chip");
  assert.match(html, />Done with the deck</, "its last message under it");
  assert.match(html, />30m</, "and when");
  assert.ok(html.slice(sam, at(html, ">Nova<")).includes('data-tip="Unread"'), "its unread dot, as on every row");
  assert.equal(html.match(/aria-label="Runs the team"/g)?.length, 1, "one star, on the main bot's avatar");
  assert.ok(at(html, 'aria-label="Runs the team"') < at(html, ">Sam<"), "on its avatar, before the name");
  const avatar = html.slice(html.lastIndexOf('<svg viewBox="0 0 40 40"', at(html, 'aria-label="Runs the team"')));
  assert.ok(!html.includes("width:64px") && avatar.startsWith('<svg viewBox="0 0 40 40" style="width:44px'), "no big card: the same 44px avatar as every row");
  // While searching it lists with the rest, when it matches.
  assert.ok(at(render(state, { search: "deck" }), ">Sam<") > 0, "found by its last message");
  assert.equal(at(render(state, { search: "pip" }), ">Sam<"), -1, "not when it doesn't match");
});

await test("A routine's post on a row says which routine, as the chat does above it; one since deleted says Routine", () => {
  stored.clear();
  const post = (routine) => ({ id: "m1", chatId: "chat_boppy", role: "bot", botId: "boppy", text: "someone@example.com requests cancellation", at: min(5), ...(routine ? { routine } : {}) });
  const routines = [{ id: "r_alerts", title: "Outage and customer alerts" }];
  assert.match(render(world({ routines, messages: [post({ id: "r_alerts" })] })), />Outage and customer alerts: someone@example\.com requests cancellation</, "the routine's name first");
  assert.match(render(world({ messages: [post({ id: "r_gone" })] })), />Routine: someone@example\.com requests cancellation</, "a deleted routine");
  assert.match(render(world({ routines, messages: [post()] })), />someone@example\.com requests cancellation</, "a bot's own reply as before");
});

/* ---------------- Favorites ---------------- */

await test("Favorites: Issues, Tasks and People until the workspace changes them; its own list after, an empty one hides it", () => {
  assert.deepEqual(F.favoritesOf(undefined), ["issues", "todos", "people"]);
  assert.deepEqual(F.favoritesOf({}), ["issues", "todos", "people"], "unset: the defaults");
  assert.deepEqual(F.favoritesOf({ favorites: [] }), [], "an empty list is the user's");
  assert.deepEqual(F.favoritesOf({ favorites: ["events", "gone", "issues", "events"] }), ["events", "issues"], "a kind this build doesn't know is skipped, each once");
  let html = render(world());
  const fav = html.slice(at(html, 'data-section="favorites"'), at(html, "Runs the team"));
  assert.deepEqual([...fav.matchAll(/data-favorite="([^"]+)"/g)].map((m) => m[1]), ["issues", "todos", "people"]);
  assert.match(fav, />Issues<.*>Tasks<.*>People</s);
  assert.match(fav, /aria-expanded="true"[^>]*data-list-heading/, "its heading folds it");
  assert.match(fav, /draggable="true"/, "rows drag to a new place");
  assert.match(fav, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/, "and move with Option and an arrow");
  html = render(world({ workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, favorites: [] }] }));
  assert.equal(at(html, 'data-section="favorites"'), -1, "nothing pinned: no section");
  html = render(world({ workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, favorites: ["skills", "events", "nope"] }] }));
  assert.deepEqual([...html.matchAll(/data-favorite="([^"]+)"/g)].map((m) => m[1]), ["skills", "events"], "the user's order, the unknown skipped");
  assert.equal(at(render(world({ account: undefined })), 'data-section="favorites"'), -1, "no Knowledge (signed out): none");
  assert.equal(at(render(world(), { search: "x" }), 'data-section="favorites"'), -1, "none while searching");
  // Another workspace has its own.
  html = render(world({ workspace: "ws_two", workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, favorites: [] }, { id: "ws_two", name: "Two", createdAt: 2 }] }));
  assert.deepEqual([...html.matchAll(/data-favorite="([^"]+)"/g)].map((m) => m[1]), ["issues", "todos", "people"]);
});

await test("Favorites: pin, unpin and order, keeping a newer Bops's pins; what the server keeps", () => {
  assert.deepEqual(F.toggledFavorite(["issues", "todos"], "events"), ["issues", "todos", "events"], "a new pin goes last");
  assert.deepEqual(F.toggledFavorite(["issues", "todos"], "issues"), ["todos"]);
  assert.deepEqual(F.toggledFavorite(F.storedFavorites({}), "people"), ["issues", "todos"], "unpinning a default saves the rest as the user's");
  assert.deepEqual(F.movedFavorite(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(F.movedFavorite(["a", "b", "c"], "a", null), ["b", "c", "a"], "to the end");
  assert.deepEqual(F.movedFavorite(["a", "b", "c"], "b", "b"), ["a", "b", "c"]);
  const list = ["issues", "future", "todos", "people"];
  assert.deepEqual(F.nudgedFavorite(list, "todos", -1), ["todos", "issues", "future", "people"], "up past the pin shown above it");
  assert.deepEqual(F.nudgedFavorite(list, "issues", 1), ["future", "todos", "issues", "people"], "down past the next shown");
  assert.deepEqual(F.nudgedFavorite(list, "people", 1), list, "the last stays");
  assert.deepEqual(F.nudgedFavorite(list, "issues", -1), list, "the first stays");
  assert.ok(F.nudgedFavorite(list, "issues", 1).includes("future"), "a pin this build skips is kept");
  assert.deepEqual(F.cleanFavorites(["issues", "issues", 3, "Bad Id", "todos", "x".repeat(60)]), ["issues", "todos"]);
  assert.equal(F.cleanFavorites("issues"), null);
  assert.equal(F.cleanFavorites(Array.from({ length: 40 }, (_, i) => `k${i}`)).length, F.MAX_FAVORITES);
});

await test("Favorites: saves go one after another, so the newest list is the one the server keeps", async () => {
  const sent = [];
  const answers = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    sent.push(JSON.parse(init.body).favorites);
    return new Promise((res) => answers.push(() => res({ ok: true, status: 200, json: async () => ({}) })));
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const first = Fav.saveFavorites("ws_main", ["issues", "events"]);
  const second = Fav.saveFavorites("ws_main", ["issues", "events", "companies"]);
  await tick();
  assert.deepEqual(sent, [["issues", "events"]], "the second waits for the first");
  answers[0]();
  await first;
  await tick();
  assert.deepEqual(sent, [["issues", "events"], ["issues", "events", "companies"]], "then it goes");
  answers[1]();
  await second;
  // One that fails doesn't hold the next back.
  globalThis.fetch = () => Promise.reject(new Error("offline"));
  await assert.rejects(Fav.saveFavorites("ws_main", ["people"]));
  globalThis.fetch = fetch;
  assert.equal((await Fav.saveFavorites("ws_main", ["people"])).status, 404, "the next one is sent");
});

await test("Favorites: a number only when there's something to act on", () => {
  const now = new Date(2026, 9, 21, 12);
  const day = (d) => `2026-10-${String(d).padStart(2, "0")}`;
  const item = (category, extra = {}) => ({ category, last: now.getTime(), ...extra });
  const items = [
    item("todos", { when: day(21) }),
    item("todos", { when: day(19) }),
    item("todos", { when: day(25) }),
    item("todos", { when: day(20), done: true }),
    item("todos", { when: day(1) }),
    item("promises"),
    item("events", { when: day(22) }),
    item("events", { when: day(21) }),
    item("events", { when: day(2) }),
    item("people"),
  ];
  assert.equal(F.favoriteCount("issues", null, 4, now), "4 open");
  assert.equal(F.favoriteCount("issues", null, 0, now), null, "none open: no number");
  assert.equal(F.favoriteCount("issues", null, undefined, now), null, "not in yet");
  assert.equal(F.favoriteCount("todos", items, undefined, now), "2 due", "today and overdue, not done, not settled (14 days past), not tomorrow's");
  assert.equal(F.favoriteCount("todos", [item("todos", { when: day(25) }), item("todos")], undefined, now), "2 open", "none due: the open ones");
  assert.equal(F.favoriteCount("promises", items, undefined, now), "1 open");
  assert.equal(F.favoriteCount("events", items, undefined, now), "2 upcoming", "today counts, the past doesn't");
  assert.equal(F.favoriteCount("people", items, undefined, now), null, "never a number for people");
  assert.equal(F.favoriteCount("companies", items, undefined, now), null);
  assert.equal(F.favoriteCount("todos", null, undefined, now), null, "not in yet");
});

await test("Knowledge's chips pin and unpin every kind but All", () => {
  const favorites = { stored: ["issues"], shown: ["issues"], pinned: (id) => id === "issues", toggle: noop, save: noop, can: true };
  const html = renderToStaticMarkup(h(MemoryPage, { snap: null, act: async () => null, forgetting: { undo: null, error: null }, issues: 2, skills: 1, favorites, category: "all", onCategory: noop, onClose: noop }));
  assert.match(html, /aria-label="Remove Issues from Favorites" aria-pressed="true"/);
  assert.match(html, /aria-label="Add Skills to Favorites" aria-pressed="false"/);
  assert.match(html, /aria-label="Add Tasks to Favorites"/);
  assert.match(html, /aria-label="Add People to Favorites"/);
  assert.ok(!html.includes('data-chip="all"'), "All has no pin");
  assert.match(html, /group-hover\/chip:opacity-100/, "shown on hover");
  assert.match(html, /focus-visible:opacity-100/, "and on keyboard focus");
  const none = renderToStaticMarkup(h(MemoryPage, { snap: null, act: async () => null, forgetting: { undo: null, error: null }, issues: 2, category: "all", onCategory: noop, onClose: noop }));
  assert.ok(!none.includes("to Favorites"), "without the app's state, no pins");
});

/* ---------------- Threads under their bot ---------------- */

const busy = () =>
  world({
    sessions: [
      session("n1", "nova", { endedAt: min(30) }),
      session("n2", "nova", { status: "running", createdAt: min(2), endedAt: undefined }),
      session("n3", "nova", { endedAt: min(10) }),
      asking("n4", "nova", min(40)),
      session("n5", "nova", { endedAt: min(5) }),
      session("p1", "pip", { status: "running", endedAt: undefined }),
      session("p2", "pip", { endedAt: min(3) }),
      session("b1", "boppy", { endedAt: min(3) }),
      session("f1", "far", { status: "running" }),
    ],
  });

await test("Threads: under their own bot, folded by default, the chip counts them and says what's going on; no flat Threads list", () => {
  stored.clear();
  const html = render(busy());
  assert.ok(!html.includes(">Threads<"), "no Threads section");
  const nova = botBlock(html, "nova");
  assert.ok(nova.includes(">Nova<"), "Nova's own row");
  assert.match(nova, /aria-expanded="false" aria-label="Nova&#x27;s threads, 5, one needs you"/, "folded; one needs Nova's user");
  assert.match(nova, /data-chip-mark="you"/, "needs you over working");
  assert.deepEqual(threadIds(nova), [], "folded: nothing listed");
  const pip = botBlock(html, "pip");
  assert.match(pip, /data-chip-mark="working"/, "a spinner while one works");
  assert.match(pip, /Pip&#x27;s threads, 2, working/);
  const sam = botBlock(html, "boppy");
  assert.ok(sam && sam.includes("Runs the team") && /aria-label="Sam&#x27;s threads, 1"/.test(sam), "the main bot's row has its chip too");
  assert.ok(!html.includes("Thread f1"), "another workspace's bot isn't here");
  assert.equal(botBlock(html, "far"), null);
  // A group chat has no threads of its own.
  assert.ok(!html.includes('data-bot-threads="chat_group"'));
});

await test("Threads: a bot's row sits in the same place with threads or without, so its first thread doesn't remake the row", () => {
  stored.clear();
  // What's around a bot's row, up to the row itself.
  const around = (html, name) => {
    const i = html.indexOf(`>${name}<`);
    const start = html.lastIndexOf('<div class="flex flex-col"', html.lastIndexOf("<button", i));
    return html.slice(start, html.indexOf("<button", start)).replace(/ data-bot-threads="[^"]*"/, "");
  };
  const none = render(world());
  const one = render(world({ sessions: [session("p1", "pip"), session("b1", "boppy")] }));
  assert.equal(around(none, "Pip"), around(one, "Pip"), "a chat row");
  assert.equal(around(none, "Sam"), around(one, "Sam"), "the main bot's row");
  assert.equal(botBlock(none, "pip"), null, "no threads: no chip");
  assert.match(botBlock(one, "pip"), /Pip&#x27;s threads, 1/);
});

await test("Threads: open as this Mac remembers it per bot, live or needs you first, then newest, three and Show N more", () => {
  stored.clear();
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const html = render(busy());
  const nova = botBlock(html, "nova");
  assert.match(nova, /aria-expanded="true" aria-label="Nova&#x27;s threads, 5"/);
  assert.ok(!/data-chip-mark/.test(nova.slice(0, nova.indexOf("data-thread"))), "open: the chip just counts");
  assert.deepEqual(threadIds(nova), ["n2", "n4", "n5"], "working and waiting first, then the newest");
  assert.match(nova, />Show 2 more</);
  assert.match(nova, /border-l/, "on a thin rule");
  assert.deepEqual(threadIds(botBlock(html, "pip")), [], "Pip's stays folded");
  // No storage at all: it still renders, folded.
  storageThrows = true;
  const bare = render(busy());
  storageThrows = false;
  assert.deepEqual(threadIds(botBlock(bare, "nova")), []);
  stored.clear();
});

await test("Threads: a search still lists the matching ones flat under Threads", () => {
  stored.clear();
  const html = render(busy(), { search: "Thread n" });
  assert.ok(html.includes(">Threads<"), "the Threads heading");
  assert.equal(at(html, "data-bot-threads="), -1, "no chips while searching");
  assert.deepEqual(threadIds(html.slice(at(html, ">Threads<"))), ["n2", "n4", "n5", "n3", "n1"], "flat, in the same order");
});

console.log(`\nsidebar: ${passed} passed`);
