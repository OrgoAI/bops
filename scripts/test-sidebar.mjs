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
// both and says whether something needs you or one is working, open as this Mac remembers it; its threads
// inline only while one waits on someone (first of all) or works, each with its time and its state in
// words, the rest folded under one "N done" line that opens them, held in place while the pointer or focus
// is in the sidebar; and a search still lists the matching threads flat under Threads.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-sidebar.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
  const props = { user: "u1", ws: "ws_main", botId: "nova", name: "Nova", threads: [session("t1", "nova", { status: "running", endedAt: undefined })], needs, row: (space) => h("div", null, "ROW", space), onOpenThread: noop, onOpenIssue: noop, onOpenWatch: noop, onSetup: noop };
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

await test("A request for your OK says its thread's plain title, as the thread's row does", () => {
  stored.clear();
  const waits = session("s_run", "nova", { status: "queued", endedAt: undefined, title: "Run Trail Guides Local" });
  const ok = { id: "a9", botId: "nova", chatId: "chat_nova", askedBy: "dev_runner_c1", action: "Send Email in Gmail (sam@acme.com)", resources: ["dana@acme.example"], preview: "to: dana@acme.example", at: min(4), threadId: "s_run" };
  const state = world({ sessions: [waits], appApprovals: [ok] });
  assert.deepEqual(S.needsByBot(state, null, []).get("nova").asks.map((x) => x.where), ["Run Trail Guides on its computer"]);
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const nova = botBlock(render(state), "nova");
  assert.ok(nova.includes('data-need="ask:a9"'), "the card under Nova");
  assert.match(nova, /Run Trail Guides on its computer/);
  assert.doesNotMatch(nova, /Run Trail Guides Local/, "never the stored title beside the plain one");
  stored.clear();
});

/* ---------------- The main bot ---------------- */

await test("A shared workspace's empty chat: its bot's role once, as the line under the name, never again as a chip beside it", () => {
  stored.clear();
  const shared = { projectId: "p9", name: "Acme", owner: "dana@acme.example", role: "member", wsId: "ws_main" };
  const state = world({ shared, bots: world().bots.map((b) => (b.isMain ? { ...b, role: "Chief of Staff" } : b)) });
  const html = render(state);
  assert.equal(html.match(/>Chief of Staff</g)?.length, 1, "said once");
  assert.doesNotMatch(html, /data-row-line="role"[^>]*>Chief of Staff</, "and not as the chip");
});

await test("The main bot: a two-line chat row like every bot's, pinned first, marked only by the star on its avatar", () => {
  stored.clear();
  const role = (state) => ({ ...state, bots: state.bots.map((b) => (b.isMain ? { ...b, role: "Chief of Staff" } : b)) });
  const state = role(world({ messages: [{ id: "m1", chatId: "chat_nova", role: "bot", botId: "nova", text: "Newest", at: min(1) }, { id: "m2", chatId: "chat_boppy", role: "bot", botId: "boppy", text: "Done with the deck", at: min(30) }] }));
  const html = render(state);
  const sam = at(html, ">Sam<");
  assert.ok(sam > 0 && sam < at(html, ">Nova<"), "first, though Nova spoke last");
  assert.match(html, />Sam<\/span><span data-row-line="role"[^>]*>Chief of Staff<\/span>/, "its name with its role chip");
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

await test("A bot's reply on its row is the plain text the chat shows: a link's words, not its address or brackets; no **, backticks, # or bullets", async () => {
  const reply = (text, extra = {}) => ({ id: "m1", chatId: "chat_boppy", role: "bot", botId: "boppy", text, at: min(5), ...extra });
  /** The row's last-message line: the text after the chat's name and time, up to the end of its span. */
  const line = (html) => html.match(/data-row-line[\s\S]*?<span class="min-w-0 flex-1 truncate[^"]*">([^<]*)<\/span>/)?.[1];
  const said = "Back to how it was: [Open the live site](https://trailguides.example.com/live). **Yellow** buttons, `look.ts` restored.";
  assert.equal(line(render(world({ messages: [reply(said)] }))), "Back to how it was: Open the live site. Yellow buttons, look.ts restored.");
  assert.equal(line(render(world({ messages: [reply("## Done\n- [The preview](https://trailguides.example.com/preview)\n* **Live** next")] }))), "Done\nThe preview\nLive next");
  assert.equal(line(render(world({ messages: [reply("Run this:\n```bash\nnpm run dev\n```")] }))), "Run this:\nnpm run dev\n");
  // A routine's post and a group chat's say whose first, then the same plain words.
  assert.equal(line(render(world({ routines: [{ id: "r1", title: "Morning check" }], messages: [reply(said, { routine: { id: "r1" } })] }))), "Morning check: Back to how it was: Open the live site. Yellow buttons, look.ts restored.");
  const group = world({ messages: [{ ...reply(said), chatId: "chat_group", botId: "nova" }] });
  assert.match(render(group, { chatId: "chat_boppy" }), />Nova: Back to how it was: Open the live site\. Yellow buttons, look\.ts restored\.</);
  // The same words as the chat's own bubble (chat-view.tsx Rich), tags and spacing aside.
  const { Rich } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
  const words = (s) => s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  assert.equal(words(line(render(world({ messages: [reply(said)] })))), words(renderToStaticMarkup(h(Rich, { text: said, botId: "boppy" }))));
  // A chat that ends on calls with a key says what its line in the chat says (keys.tsx ApiCalls), never "Called GitHub GET /repos/...".
  const call = (id, s, path, label = "GitHub") => ({ id, chatId: "chat_boppy", role: "system", text: `Called ${label} GET ${path}`, at: min(10) + s * 1000 });
  const reads = [1, 2, 3].map((n) => call(`c${n}`, n, `/repos/acme/site/contents/form-${n}.tsx`));
  assert.equal(line(render(world({ messages: [reply("Done."), ...reads] }))), "Looked at 3 files on GitHub");
  assert.equal(line(render(world({ messages: [...reads, call("s1", 4, "/v1/customers", "Stripe")] }))), "Looked at something on Stripe", "the run it ends on, another service's");
  const failed = { id: "f1", chatId: "chat_boppy", role: "system", text: "Boppy couldn't call it: GitHub answered 404", appResult: { action: "GitHub GET /repos/acme/site/contents/x.tsx", ok: false, output: "" }, at: min(1) };
  assert.equal(line(render(world({ messages: [...reads, failed] }))), "Boppy couldn&#x27;t call it: GitHub answered 404", "a failed one says why, as its note does");
  // A table: its first row's words after its columns' names, never its pipes; the chat's own bubble draws the table.
  const table = "| Client | Status |\n|---|---|\n| Acme | **Done** |\n| Beta | Waiting |";
  assert.equal(line(render(world({ messages: [reply(table)] }))), "Client: Acme · Status: Done");
  const bubble = renderToStaticMarkup(h(Rich, { text: table, botId: "boppy" }));
  assert.match(bubble, /<table[\s\S]*>Client<[\s\S]*>Status<[\s\S]*>Acme<[\s\S]*>Done<[\s\S]*>Beta</, "a real table in the chat, the same cells");
  // A person's message is shown as they wrote it, as the chat shows it.
  assert.equal(line(render(world({ messages: [{ id: "m2", chatId: "chat_boppy", role: "user", text: "Use **bold** [here](https://trailguides.example.com)", at: min(4) }] }))), "You: Use **bold** [here](https://trailguides.example.com)");
  // So is a text or an email someone sent, and a note: the chat shows them raw (TextCard, EmailCard, SystemNote), not as a bot's words.
  const inbound = (id, text, extra) => ({ id, chatId: "chat_boppy", role: "system", text, at: min(3), ...extra });
  const sms = { sms: { dir: "in", from: "+15551234567", to: "+15557654321" } };
  assert.equal(line(render(world({ messages: [inbound("t1", "# 4521 is your code", sms)] }))), "# 4521 is your code");
  assert.equal(line(render(world({ messages: [inbound("t2", "+ 1 for yes\n- or no", sms)] }))), "+ 1 for yes\n- or no");
  assert.equal(line(render(world({ messages: [inbound("e1", "**Invoice** [view](https://trailguides.example.com/i)", { email: { from: "alex@example.com", to: "boppy@example.com", subject: "Invoice" } })] }))), "**Invoice** [view](https://trailguides.example.com/i)");
  assert.equal(line(render(world({ messages: [inbound("n1", "* Boppy saved `look.ts`")] }))), "* Boppy saved `look.ts`");
});

await test("A thread's row says its title in plain words (an app's copy on its computer, not Local), the stored title as it was", () => {
  const t = session("t9", "nova", { title: "Run Trail Guides Local" });
  const html = render(world({ sessions: [t] }), { search: "trail" });
  assert.match(html, /data-thread="t9"[^>]*>(?:(?!<\/button>)[\s\S])*>Run Trail Guides on its computer</);
  assert.equal(t.title, "Run Trail Guides Local");
});

await test("A thread's title is the same plain title wherever it shows: the bot's menu says it, and no component shows one raw", async () => {
  const { BotMenu } = await import(pathToFileURL(`${root}/components/app/bot-menu.tsx`).href);
  const menu = (sessions) => renderToStaticMarkup(h(BotMenu, { state: world({ sessions }), bot: world().bots.find((b) => b.id === "nova"), x: 10, y: 10, onClose: noop, actions: { onChat: noop, onCall: noop, onComputer: noop, onProfile: noop, onNewTask: noop } }));
  assert.match(menu([session("t1", "nova", { title: "Run Trail Guides Local", status: "running", endedAt: undefined })]), /Working on Run Trail Guides on its computer/);
  assert.match(menu([asking("t2", "nova", min(5), { title: "Open the brochure on localhost:3101" })]), /Needs you: Open the brochure on its computer/);
  // Every thread title a component shows goes through plainTitle; the two uses that aren't shown are named.
  const notShown = [/\.title\.toLowerCase\(\)\.includes\(q\)/, /const said = \[s\.title/];
  const raw = [];
  for (const f of readdirSync(`${root}/components/app`).filter((x) => x.endsWith(".tsx")))
    readFileSync(`${root}/components/app/${f}`, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // The line without its plainTitle(...) calls (parentheses balanced), so only a title left outside one counts.
        let shown = line;
        for (let at = shown.indexOf("plainTitle("); at >= 0; at = shown.indexOf("plainTitle(")) {
          let depth = 0;
          let end = at + "plainTitle".length;
          for (; end < shown.length; end++) if (shown[end] === "(") depth++;
          else if (shown[end] === ")" && --depth === 0) break;
          shown = shown.slice(0, at) + shown.slice(end + 1);
        }
        if (/\b(?:s|session|asking|thread|onScreen|leftBy|i\.session|current\.session|working\[0\]|t\.left)\.title\b|infoOn\([^)]*\)!?\.(?:left!?\.)?title\b|sessions\.find\(.*\)\??\.title\b/.test(shown) && !notShown.some((r) => r.test(line))) raw.push(`${f}:${i + 1}`);
      });
  assert.deepEqual(raw, [], "a thread title shown without plainTitle");
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

await test("Favorites in a workspace shared with the user: none of Knowledge's kinds (Knowledge is the owner's), Needs your attention still first", () => {
  const shared = { projectId: "p9", name: "Acme", owner: "dana@acme.example", role: "admin", wsId: "ws_main", levels: { nova: "write" } };
  let html = render(world({ shared }));
  assert.equal(at(html, 'data-section="favorites"'), -1, "nothing waiting: no section");
  html = render(world({ shared, sessions: [asking("t1", "nova", min(5))] }));
  const fav = html.slice(at(html, 'data-section="favorites"'));
  assert.ok(at(fav, 'data-favorite="attention"') > 0, "what waits on them stays");
  assert.deepEqual([...fav.matchAll(/data-favorite="([^"]+)"/g)].map((m) => m[1]), ["attention"], "no Issues, Tasks or People");
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

await test("Threads: open as this Mac remembers it per bot; inline only what waits on someone (first of all) or works, each with its time and its state in words; the rest folded under one line with the count and the latest", () => {
  stored.clear();
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const html = render(busy());
  const nova = botBlock(html, "nova");
  assert.match(nova, /aria-expanded="true" aria-label="Nova&#x27;s threads, 5"/);
  assert.ok(!/data-chip-mark/.test(nova.slice(0, nova.indexOf("data-thread"))), "open: the chip just counts");
  assert.deepEqual(threadIds(nova), ["n4", "n2"], "waiting first of all, then working; the done ones folded away");
  assert.match(nova, /data-thread="n4"(?:(?!<\/button>)[\s\S])*>40m<(?:(?!<\/button>)[\s\S])*<\/button>/, "the waiting one: when it stopped");
  assert.match(nova, /data-thread="n2"(?:(?!<\/button>)[\s\S])*>2m<(?:(?!<\/button>)[\s\S])*<\/button>/, "the working one: when it began");
  assert.match(nova, /data-thread="n4"(?:(?!<\/button>)[\s\S])*role="img" aria-label="Needs you"/, "its state in words, not a glyph only");
  assert.match(nova, /data-thread="n2"(?:(?!<\/button>)[\s\S])*role="img" aria-label="Working on it"/);
  assert.match(nova, /<button(?=[^>]*data-done-line="true")(?=[^>]*aria-expanded="false")[^>]*>(?:(?!<\/button>)[\s\S])*>3 done · last 5m ago</, "one quiet line: how many, and when the newest stopped");
  assert.ok(at(nova, 'data-thread="n2"') < at(nova, "data-done-line"), "under the inline ones");
  assert.doesNotMatch(nova, /Show \d+ more/, "two inline: nothing more to show");
  assert.match(nova, /border-l/, "on a thin rule");
  assert.deepEqual(threadIds(botBlock(html, "pip")), [], "Pip's stays folded");
  // Nothing done: no line. Only done: just the line.
  stored.set("bops.threads.open.u1.ws_main.pip", "1");
  const pipOnly = (sessions) => botBlock(render(world({ sessions })), "pip");
  assert.ok(!pipOnly([session("p1", "pip", { status: "running", endedAt: undefined })]).includes("data-done-line"));
  const onlyDone = pipOnly([session("p2", "pip", { endedAt: min(3) }), session("p3", "pip", { status: "failed", error: "Stopped by you", endedAt: min(7) })]);
  assert.deepEqual(threadIds(onlyDone), [], "stopped by the user counts as done: nothing waits on it");
  assert.match(onlyDone, />2 done · last 3m ago</);
  // No storage at all: it still renders, folded.
  storageThrows = true;
  const bare = render(busy());
  storageThrows = false;
  assert.deepEqual(threadIds(botBlock(bare, "nova")), []);
  stored.clear();
});

await test("Threads: waiting on the user's OK sorts first too, and four inline show three and Show 1 more", () => {
  stored.clear();
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const sessions = [
    session("w1", "nova", { status: "running", createdAt: min(1), endedAt: undefined }),
    session("w2", "nova", { status: "running", createdAt: min(2), endedAt: undefined }),
    session("ok", "nova", { status: "queued", createdAt: min(30), endedAt: undefined }),
    asking("q1", "nova", min(50)),
  ];
  const ask = { id: "a1", botId: "nova", chatId: "chat_nova", askedBy: "dev_runner_c1", action: "Send Email in Gmail (sam@acme.com)", resources: [], preview: "", at: min(4), threadId: "ok" };
  const nova = botBlock(render(world({ sessions, appApprovals: [ask] })), "nova");
  assert.deepEqual(threadIds(nova), ["ok", "q1", "w1"], "both waiting ones first (the newer first), then the working");
  assert.match(nova, />Show 1 more</);
  stored.clear();
});

await test("Threads: a search lists one waiting for your OK first too, before newer working ones, never cut off by them", () => {
  stored.clear();
  const run = (id, n) => session(id, "nova", { status: "running", createdAt: min(n), endedAt: undefined });
  const ask = { id: "a1", botId: "nova", chatId: "chat_nova", askedBy: "dev_runner_c1", action: "Send Email in Gmail (sam@acme.com)", resources: [], preview: "", at: min(4), threadId: "ok" };
  const html = render(world({ sessions: [run("ok", 30), ...[1, 2, 3, 4, 5, 6].map((n) => run(`w${n}`, n))], appApprovals: [ask] }), { search: "Thread" });
  assert.deepEqual(threadIds(html.slice(at(html, ">Threads<"))), ["ok", "w1", "w2", "w3", "w4", "w5"]);
});

await test("Threads: a search still lists the matching ones flat under Threads", () => {
  stored.clear();
  const html = render(busy(), { search: "Thread n" });
  assert.ok(html.includes(">Threads<"), "the Threads heading");
  assert.equal(at(html, "data-bot-threads="), -1, "no chips while searching");
  assert.deepEqual(threadIds(html.slice(at(html, ">Threads<"))), ["n4", "n2", "n5", "n3", "n1"], "flat, in the same order: waiting, working, then the newest");
  assert.match(html.slice(at(html, ">Threads<")), /data-thread="n5"(?:(?!<\/button>)[\s\S])*>5m</, "each with its time");
});

/* ---------------- The workspace menu's Team chart row ---------------- */

await test("the workspace menu has a Team chart row for the open workspace, the owner's own only", async () => {
  const { WorkspaceSwitcher } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
  const menu = (state, onTeamChart = noop) => renderToStaticMarkup(h(WorkspaceSwitcher, { state, opened: true, sharedList: [], onTeamChart }));
  assert.match(menu(world()), /data-team-chart-row="true"[^>]*>[\s\S]*?Org chart<span[^>]*>[^<]*<\/span><\/button>/);
  // Through the sidebar too.
  assert.match(render(world(), { workspaces: true, onTeamChart: noop }), /data-team-chart-row/);
  // A workspace shared with the user open: never.
  const shared = world({ shared: { projectId: "p9", name: "Acme", owner: "dana@acme.example", role: "member", wsId: "shared_p9" } });
  assert.ok(!menu(shared).includes("data-team-chart-row"));
  // Nowhere to open it: no row.
  assert.ok(!renderToStaticMarkup(h(WorkspaceSwitcher, { state: world(), opened: true, sharedList: [] })).includes("data-team-chart-row"));
});

/* ---------------- Threads, clicked and held (a DOM) ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
// Whether focus came from the keyboard is the browser's to say (:focus-visible, which linkedom doesn't know): a test sets it.
let keyboard = true;
const matches = win.Element.prototype.matches;
win.Element.prototype.matches = function (selector) {
  return selector === ":focus-visible" ? keyboard : matches.call(this, selector);
};
globalThis.document = doc;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const settle = () => new Promise((r) => setTimeout(r, 5));
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(el), await settle()));
  return { box, render: (x) => act(async () => (r.render(x), await settle())), done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const fire = (el, type, init = {}) => act(async () => (el.dispatchEvent(Object.assign(new win.Event(type, { bubbles: true }), init)), await settle()));
/** The threads listed inline (not in the done list), and the done list's, in order. */
const inlineOf = (box) => [...box.querySelectorAll("[data-thread]")].filter((e) => !e.closest("[data-done-list]")).map((e) => e.getAttribute("data-thread"));
const doneOf = (box) => [...box.querySelectorAll("[data-done-list] [data-thread]")].map((e) => e.getAttribute("data-thread"));
const doneLine = (box) => box.querySelector("[data-done-line]");
const threadProps = (threads, extra = {}) => ({ user: "u1", ws: "ws_main", botId: "nova", name: "Nova", threads, row: (space) => h("div", null, "ROW", space), onOpenThread: noop, onOpenIssue: noop, onOpenWatch: noop, onSetup: noop, ...extra });

await test("Threads: the done line opens the done ones, newest first, and shuts them again", async () => {
  stored.clear();
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const v = await mount(h(S.WithThreads, threadProps(busy().sessions.filter((s) => s.botId === "nova"))));
  assert.deepEqual(inlineOf(v.box), ["n4", "n2"]);
  assert.deepEqual(doneOf(v.box), [], "folded: not even rendered");
  assert.equal(doneLine(v.box).getAttribute("aria-expanded"), "false");
  await fire(doneLine(v.box), "click");
  assert.equal(doneLine(v.box).getAttribute("aria-expanded"), "true");
  assert.deepEqual(doneOf(v.box), ["n5", "n3", "n1"], "open: newest first");
  assert.equal(v.box.querySelector("[data-done-list]").closest("[inert]"), null, "within reach");
  await fire(doneLine(v.box), "click");
  assert.equal(doneLine(v.box).getAttribute("aria-expanded"), "false");
  assert.ok(v.box.querySelector("[data-done-list]").closest("[inert]"), "shut: out of reach");
  await v.done();
  stored.clear();
});

await test("Threads: held, a thread that finishes keeps its place and changes its mark, a new one joins at the end; let go, it folds into done", async () => {
  stored.clear();
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const base = [session("w1", "nova", { status: "running", createdAt: min(3), endedAt: undefined }), asking("q1", "nova", min(20)), session("d1", "nova", { endedAt: min(30) })];
  const v = await mount(h(S.WithThreads, threadProps(base, { still: false })));
  assert.deepEqual(inlineOf(v.box), ["q1", "w1"]);
  await v.render(h(S.WithThreads, threadProps(base, { still: true })));
  const later = [...base.map((s) => (s.id === "w1" ? { ...s, status: "done", endedAt: Date.now() } : s)), session("n9", "nova", { status: "running", createdAt: Date.now(), endedAt: undefined })];
  await v.render(h(S.WithThreads, threadProps(later, { still: true })));
  assert.deepEqual(inlineOf(v.box), ["q1", "w1", "n9"], "w1 where it was, the new one at the end");
  const w1 = v.box.querySelector('[data-thread="w1"]');
  assert.equal(w1.querySelector('[aria-label="Working on it"]'), null, "its spinner gone: it changed form in place");
  assert.match(doneLine(v.box).textContent, /^1 done/, "not counted as done yet");
  // A second arrival, newer, goes after the first; the first starting to wait on the user doesn't move it either.
  const more = [...later, session("n10", "nova", { status: "running", createdAt: Date.now() + 1, endedAt: undefined })];
  await v.render(h(S.WithThreads, threadProps(more, { still: true })));
  await fire([...v.box.querySelectorAll("button")].find((b) => b.textContent === "Show 1 more"), "click");
  assert.deepEqual(inlineOf(v.box), ["q1", "w1", "n9", "n10"], "each arrival at the end, once");
  const asks = more.map((s) => (s.id === "n9" ? { ...s, status: "done", endedAt: Date.now(), waitingOnYou: true } : s));
  await v.render(h(S.WithThreads, threadProps(asks, { still: true })));
  assert.deepEqual(inlineOf(v.box), ["q1", "w1", "n9", "n10"], "a change of state stays in place");
  await v.render(h(S.WithThreads, threadProps(asks, { still: false })));
  assert.deepEqual(inlineOf(v.box), ["n9", "q1", "n10"], "let go: it settles, the waiting ones first, the finished one folded");
  assert.match(doneLine(v.box).textContent, /^2 done · last just now$/);
  await v.done();
  stored.clear();
});

await test("Threads: the sidebar holds them while the keyboard's focus or the pointer is in its list (not a click's focus), and lets go when they leave", async () => {
  stored.clear();
  stored.set("bops.threads.open.u1.ws_main.nova", "1");
  const base = world({ sessions: [session("w1", "nova", { status: "running", createdAt: min(3), endedAt: undefined }), session("d1", "nova", { endedAt: min(30) })] });
  const finished = { ...base, sessions: base.sessions.map((s) => (s.id === "w1" ? { ...s, status: "done", endedAt: Date.now() } : s)) };
  const bar = (state) =>
    h(Sidebar, { state, chatId: "chat_nova", onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onMembers: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop });
  const v = await mount(bar(base));
  const nova = () => v.box.querySelector('[data-bot-threads="nova"]');
  assert.deepEqual(inlineOf(nova()), ["w1"]);
  // Focus comes into the list (a row, from the keyboard): held.
  keyboard = true;
  await fire(nova().querySelector('[data-thread="w1"]'), "focusin");
  await v.render(bar(finished));
  assert.deepEqual(inlineOf(nova()), ["w1"], "focus in: it stays");
  await fire(nova().querySelector('[data-thread="w1"]'), "focusout", { relatedTarget: null });
  assert.deepEqual(inlineOf(nova()), [], "focus gone: it folds");
  // A click's focus (the chip that opened the list) holds nothing once the pointer has gone.
  await v.render(bar(base));
  keyboard = false;
  await fire(nova().querySelector("button[aria-expanded]"), "focusin");
  await v.render(bar(finished));
  assert.deepEqual(inlineOf(nova()), [], "a click's focus: it folds");
  keyboard = true;
  // The pointer comes in: held, until it leaves.
  await v.render(bar(base));
  const list = nova().closest(".overflow-y-auto");
  await fire(list, "pointerover", { relatedTarget: null, pointerId: 1 });
  await v.render(bar(finished));
  assert.deepEqual(inlineOf(nova()), ["w1"], "pointer in: it stays");
  await fire(list, "pointerout", { relatedTarget: doc.body, pointerId: 1 });
  assert.deepEqual(inlineOf(nova()), [], "pointer gone: it folds");
  await v.done();
  stored.clear();
});

console.log(`\nsidebar: ${passed} passed`);
