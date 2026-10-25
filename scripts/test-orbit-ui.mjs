// Tests for Orbit in the window (components/app/memory-categories.tsx and orbit-issues.tsx): Forget is
// at once with 5 seconds to undo before anything is sent, a new Forget sends the one before, a failed one
// puts the items back; Delete everywhere's preview is read as sent; issues change at once and go back
// when the server says no; and the sidebar and pages, rendered to HTML, show what they should (Issues
// first with its open count, the blank lines, Select, the issue filters). And an issue's tags, rendered into
// a DOM (linkedom), clicked and typed in: + Tag's picker over the page with every workspace tag, the ones on
// the issue checked in place, a click turning one off and on, typing to filter, Create tag for a new name
// (sent as new, refused with why), the keys (Up, Down, Enter, Esc and Tab, focus back on + Tag), a click
// outside, an issue's 6 at most; and the list's tag filter as the same picker, one tag at a time.
//
// Nothing reaches a server: fetch is a fake that answers like app/api/memory/categories and
// app/api/orbit/issues. The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-orbit-ui.mjs   (not with --conditions=react-server: these are client components)
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

/* ---------------- A window, enough of one ---------------- */

const listeners = new Map();
// The ones added to be heard first (capture), as a browser keeps them apart.
const captured = new Set();
globalThis.window = globalThis;
globalThis.addEventListener = (k, f, o) => {
  listeners.set(k, [...(listeners.get(k) ?? []), f]);
  if (o === true || o?.capture) captured.add(f);
};
globalThis.removeEventListener = (k, f) => listeners.set(k, (listeners.get(k) ?? []).filter((g) => g !== f));
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.matchMedia = () => ({ matches: false });

/** The fake server: what was asked, and how to answer. */
const calls = [];
let answer = () => ({ status: 404, body: { error: "no" } });
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url: String(url), method: init.method ?? "GET", body, keepalive: !!init.keepalive });
  const a = await answer(String(url), init.method ?? "GET", body);
  return { ok: a.status < 400, status: a.status, json: async () => a.body };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

const item = (id, category, title, extra = {}) => ({ id, category, key: title.toLowerCase(), title, detail: "", sources: [{ fact: `f-${id}`, text: `${title} fact`, at: Date.now(), from: "Chat with Max", how: "said" }], first: 1, last: Date.now(), ...extra });
let items = [item("aaaaaaaaaa", "people", "Priya Shah"), item("bbbbbbbbbb", "people", "Dana Lee"), item("cccccccccc", "todos", "Send receipts")];
const snap = () => ({ on: true, ws: "w1", rev: Math.random(), items: items.map((i) => ({ ...i })), syncing: false, syncedAt: Date.now() });

const { orbitStore, MemoryPage, groupsOf } = await import(pathToFileURL(`${root}/components/app/memory-categories.tsx`).href);
const { issueStore, issueOrder, isOpen } = await import(pathToFileURL(`${root}/components/app/orbit-issues.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  calls.length = 0;
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

/* ---------------- Forget, with Undo ---------------- */

const UNDO_MS = 5_000;
// Real timers, but Forget's 5 seconds pass only when a test says so (fiveSecondsPass), never on their own:
// a short real timer raced settle() and, on a busy machine, sent a Forget before the test looked.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const held = new Map();
globalThis.setTimeout = (f, ms, ...a) => {
  if (ms !== UNDO_MS) return realSetTimeout(f, ms, ...a);
  const handle = { held: true };
  held.set(handle, () => f(...a));
  return handle;
};
globalThis.clearTimeout = (t) => (held.has(t) ? held.delete(t) : realClearTimeout(t));
const fiveSecondsPass = async () => {
  const due = [...held.values()];
  held.clear();
  for (const f of due) f();
  await settle();
};

answer = (url, method, body) => {
  if (url.startsWith("/api/memory/categories") && method === "GET") return { status: 200, body: snap() };
  if (url === "/api/memory/categories" && body?.action === "forget") {
    items = items.filter((i) => !body.ids.includes(i.id));
    return { status: 200, body: snap() };
  }
  return { status: 404, body: { error: "no" } };
};

const stop = orbitStore.watch("u1", "w1", () => {});
await settle();

await test("the first read shows the workspace's items", async () => {
  assert.equal(orbitStore.view("u1", "w1")?.items.length, 3);
});

await test("Forget hides at once and sends nothing for 5 seconds", async () => {
  orbitStore.forget("u1", "w1", [{ id: "aaaaaaaaaa", title: "Priya Shah" }]);
  assert.deepEqual(orbitStore.view("u1", "w1").items.map((i) => i.id), ["bbbbbbbbbb", "cccccccccc"]);
  assert.equal(orbitStore.forgetting("u1", "w1").undo?.label, "Forgot Priya Shah");
  await settle();
  assert.equal(calls.filter((c) => c.body?.action === "forget").length, 0);
});

await test("Undo brings it back and it's never sent", async () => {
  orbitStore.undo("u1", "w1");
  assert.equal(orbitStore.view("u1", "w1").items.length, 3);
  assert.equal(orbitStore.forgetting("u1", "w1").undo, null);
  await fiveSecondsPass();
  assert.equal(calls.filter((c) => c.body?.action === "forget").length, 0);
});

await test("after 5 seconds it's sent, with every id, and stays gone", async () => {
  orbitStore.forget("u1", "w1", [
    { id: "aaaaaaaaaa", title: "Priya Shah" },
    { id: "bbbbbbbbbb", title: "Dana Lee" },
  ]);
  assert.equal(orbitStore.forgetting("u1", "w1").undo?.label, "Forgot 2 items");
  await fiveSecondsPass();
  const sent = calls.filter((c) => c.body?.action === "forget");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { action: "forget", ids: ["aaaaaaaaaa", "bbbbbbbbbb"], ws: "w1" });
  assert.equal(orbitStore.forgetting("u1", "w1").undo, null);
  assert.deepEqual(orbitStore.view("u1", "w1").items.map((i) => i.id), ["cccccccccc"]);
});

await test("a new Forget sends the one waiting before it", async () => {
  orbitStore.forget("u1", "w1", [{ id: "cccccccccc", title: "Send receipts" }]);
  orbitStore.forget("u1", "w1", [{ id: "dddddddddd", title: "Another" }]);
  await settle();
  const sent = calls.filter((c) => c.body?.action === "forget");
  assert.deepEqual(sent.map((c) => c.body.ids), [["cccccccccc"]]);
  assert.equal(orbitStore.forgetting("u1", "w1").undo?.label, "Forgot Another");
  orbitStore.undo("u1", "w1");
});

await test("one that fails comes back, and the page is told why", async () => {
  const was = answer;
  answer = (url, method, body) => (body?.action === "forget" ? { status: 500, body: { error: "Memory said no." } } : was(url, method, body));
  // Relearned, and read again as Bops comes to the front.
  items = [item("aaaaaaaaaa", "people", "Priya Shah"), item("bbbbbbbbbb", "people", "Dana Lee")];
  for (const f of listeners.get("focus") ?? []) f();
  await settle();
  const before = orbitStore.view("u1", "w1").items.map((i) => i.id);
  assert.equal(before.length, 2);
  orbitStore.forget("u1", "w1", [{ id: before[0], title: "x" }]);
  assert.equal(orbitStore.view("u1", "w1").items.length, before.length - 1);
  await fiveSecondsPass();
  assert.deepEqual(orbitStore.view("u1", "w1").items.map((i) => i.id), before);
  assert.equal(orbitStore.forgetting("u1", "w1").error, "Memory said no.");
  answer = was;
});

await test("Bops closing sends the Forget still waiting, with keepalive", async () => {
  const id = orbitStore.view("u1", "w1").items[0].id;
  orbitStore.forget("u1", "w1", [{ id, title: "x" }]);
  for (const f of listeners.get("pagehide") ?? []) f();
  await settle();
  const sent = calls.filter((c) => c.body?.action === "forget");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].keepalive, true);
  assert.deepEqual(sent[0].body.ids, [id]);
});

await test("Delete everywhere's preview: the chats by name, and what else came from each", async () => {
  const was = answer;
  answer = (url, method, body) =>
    body?.action === "deleteEverywhere" && body.preview
      ? { status: 200, body: { sessions: [{ id: "s1", name: "Chat with Max", at: 5, alsoFor: ["Dana Lee"] }, { id: "s2", title: "Call with Priya", sharedWith: [{ title: "Acme" }] }, { name: "no id" }] } }
      : was(url, method, body);
  const got = await orbitStore.preview("w1", "aaaaaaaaaa");
  assert.deepEqual(got, [
    { id: "s1", name: "Chat with Max", at: 5, alsoFor: ["Dana Lee"] },
    { id: "s2", name: "Call with Priya", at: undefined, alsoFor: ["Acme"] },
  ]);
  assert.deepEqual(calls.at(-1).body, { action: "deleteEverywhere", id: "aaaaaaaaaa", preview: true, ws: "w1" });
  answer = () => ({ status: 400, body: { error: "That's gone already." } });
  assert.equal(await orbitStore.preview("w1", "aaaaaaaaaa"), "That's gone already.");
  answer = was;
});
stop();

/* ---------------- Issues ---------------- */

const issue = (id, extra = {}) => ({ id, ws: "w1", status: "open", priority: "normal", tags: [], title: `Issue ${id}`, openedAt: 1000, updatedAt: 1000, ...extra });
let issues = [issue("issue-1", { priority: "urgent", customer: { name: "Acme" }, sourceApp: "gmail" }), issue("issue-2", { status: "done" }), issue("issue-3", { status: "waiting_them", updatedAt: 5000 })];
answer = (url, method, body) => {
  if (url.startsWith("/api/orbit/issues?ws=w1") && method === "GET") return { status: 200, body: { issues, tags: ["Customer", "Outage"] } };
  const m = url.match(/^\/api\/orbit\/issues\/([^?]+)\?ws=w1$/);
  if (m && method === "PATCH") {
    if (body.status === "waiting_us") return { status: 409, body: { error: "Changed elsewhere." } };
    issues = issues.map((i) => (i.id === decodeURIComponent(m[1]) ? { ...i, ...body, ws: "w1", history: [{ at: 1, who: "Max", text: "Opened" }] } : i));
    return { status: 200, body: { issue: issues.find((i) => i.id === decodeURIComponent(m[1])) } };
  }
  if (m && method === "GET") {
    const found = issues.find((i) => i.id === decodeURIComponent(m[1]));
    return found ? { status: 200, body: { issue: { ...found, history: [{ at: 2, who: "Plain support queue", text: "Reply drafted: Hi Acme", kind: "draft" }] } } } : { status: 404, body: { error: "That issue is gone." } };
  }
  if (m && method === "DELETE") {
    issues = issues.filter((i) => i.id !== decodeURIComponent(m[1]));
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "no" } };
};
calls.length = 0;
const stopIssues = issueStore.watch("u1", "w1", () => {});
await settle();
const firstIssueRead = calls.some((c) => c.url === "/api/orbit/issues?ws=w1" && c.method === "GET");

await test("issues are read for the workspace, in order: open first, urgent first", async () => {
  const list = issueStore.list("u1", "w1");
  assert.deepEqual([...list.issues].sort(issueOrder).map((i) => i.id), ["issue-1", "issue-3", "issue-2"]);
  assert.equal(list.issues.filter(isOpen).length, 2);
  assert.ok(firstIssueRead, "read with the workspace");
});

await test("an issue opened from the list gets its history from its own answer", async () => {
  assert.equal(issueStore.list("u1", "w1").issues.find((i) => i.id === "issue-3").history, undefined, "the list carries none");
  await issueStore.loadHistory("u1", "w1", "issue-3");
  assert.equal(calls.at(-1).url, "/api/orbit/issues/issue-3?ws=w1");
  assert.equal(calls.at(-1).method, "GET");
  assert.equal(issueStore.list("u1", "w1").issues.find((i) => i.id === "issue-3").history?.[0]?.text, "Reply drafted: Hi Acme");
});

await test("a status change shows at once and then as the server has it (with history)", async () => {
  const p = issueStore.update("u1", "w1", "issue-1", { status: "done" });
  assert.equal(issueStore.list("u1", "w1").issues.find((i) => i.id === "issue-1").status, "done");
  assert.equal(await p, null);
  const i1 = issueStore.list("u1", "w1").issues.find((i) => i.id === "issue-1");
  assert.equal(i1.status, "done");
  assert.equal(i1.history?.[0]?.who, "Max");
  assert.deepEqual(calls.at(-1).body, { status: "done", ws: "w1" });
  assert.equal(calls.at(-1).method, "PATCH");
});

await test("a change the server refuses goes back, with its reason", async () => {
  const err = await issueStore.update("u1", "w1", "issue-3", { status: "waiting_us" });
  assert.equal(err, "Changed elsewhere.");
  assert.equal(issueStore.list("u1", "w1").issues.find((i) => i.id === "issue-3").status, "waiting_them");
});

await test("a note shows in the history at once, said by You", async () => {
  const p = issueStore.update("u1", "w1", "issue-3", { note: "Called them" });
  assert.equal(issueStore.list("u1", "w1").issues.find((i) => i.id === "issue-3").history.at(-1).text, "Called them");
  await p;
});

await test("Delete removes it from the list once the server says so", async () => {
  assert.equal(await issueStore.remove("u1", "w1", "issue-2"), null);
  assert.ok(!issueStore.list("u1", "w1").issues.some((i) => i.id === "issue-2"));
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(calls.at(-1).url, "/api/orbit/issues/issue-2?ws=w1");
});
stopIssues();

/* ---------------- What the screens show ---------------- */

const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const forgetting = { undo: null, error: null, forget: noop, undoForget: noop, dismiss: noop, preview: async () => [] };
await test("a kind's page: All, then Issues with its open count, then the kinds; Select, every item; Undo once something is forgotten", async () => {
  const s = { on: true, ws: "w1", items: [item("aaaaaaaaaa", "people", "Priya Shah")], syncing: false };
  let t = text(renderToStaticMarkup(h(MemoryPage, { snap: s, act: async () => null, forgetting, issues: 3, category: "people", onCategory: noop, onClose: noop })));
  assert.match(t, /All 1 Issues 3 People 1/);
  assert.match(t, /Select/);
  assert.match(t, /Priya Shah/);
  assert.ok(!t.includes("Undo"));
  t = text(renderToStaticMarkup(h(MemoryPage, { snap: s, act: async () => null, forgetting: { ...forgetting, undo: { label: "Forgot Dana Lee", ids: ["x"] } }, issues: 3, category: "people", onCategory: noop, onClose: noop })));
  assert.match(t, /Forgot Dana Lee Undo/);
});

await test("All: every kind on one page, Issues still a chip", async () => {
  const s = { on: true, ws: "w1", items: [item("aaaaaaaaaa", "people", "Priya Shah"), item("bbbbbbbbbb", "todos", "Send the receipts")], syncing: false };
  const t = text(renderToStaticMarkup(h(MemoryPage, { snap: s, act: async () => null, forgetting, issues: 0, category: "all", onCategory: noop, onClose: noop })));
  assert.match(t, /All 2 Issues 0 People 1/);
  assert.match(t, /Priya Shah/);
  assert.match(t, /Send the receipts/);
  assert.match(t, /Select/);
});

await test("Skills and Apps, kinds in Knowledge: Skills chip after Issues with its count (Apps chip hidden for now), each its own page in the tab, and not in All", async () => {
  const { MemoryView } = await import(pathToFileURL(`${root}/components/app/memory-categories.tsx`).href);
  const s = { on: true, ws: "w1", items: [item("aaaaaaaaaa", "people", "Priya Shah")], syncing: false };
  let t = text(renderToStaticMarkup(h(MemoryPage, { snap: s, act: async () => null, forgetting, issues: 3, skills: 2, apps: 1, category: "all", onCategory: noop, onClose: noop })));
  assert.match(t, /All 1 Issues 3 Skills 2 People 1/);
  assert.ok(!/Standup post/.test(t), "All lists what memory learned, not the skills");
  // Without the count (no state), no chip.
  t = text(renderToStaticMarkup(h(MemoryPage, { snap: s, act: async () => null, forgetting, issues: 3, category: "all", onCategory: noop, onClose: noop })));
  assert.ok(!/Skills|Apps/.test(t));
  // Opened on Skills: the Skills page with Knowledge's chips under its title, Skills the one picked.
  const ref = (kind, slug, name, extra = {}) => ({ kind, slug, name, description: `${name}, step by step`, version: 1, status: "published", botIds: [], updatedAt: 1, ...extra });
  const state = {
    account: { user: { id: "u1" } },
    workspaces: [{ id: "w1", name: "Main", skills: [ref("skill", "standup-post", "Standup post", { status: "draft" })], apps: [ref("app", "invoice-total", "Invoice total")] }],
    currentWorkspace: "w1",
    bots: [{ id: "boppy", name: "Boppy", isMain: true, workspaceId: "w1" }],
  };
  const html = renderToStaticMarkup(h(MemoryView, { state, user: "u1", ws: "w1", category: "skills", onCategory: noop, onClose: noop }));
  t = text(html);
  assert.match(t, /^ ?Skills How this workspace/);
  assert.match(t, /All Issues Skills 1 · 1 draft People/, "the drafts waiting to be published, as the old sidebar row said");
  assert.match(html, /aria-pressed="true"[^>]*>Skills/);
  assert.match(t, /Standup post/);
  assert.ok(!/Invoice total/.test(t), "apps are on their own page");
  assert.match(t, /Draft/);
  // Knowledge has no Apps (Apps are the apps bots make, from the footer): no chip, and no page for them here.
  assert.ok(!/>Apps</.test(html), "no Apps chip in Knowledge");
  // No drafts: only the count.
  const published = { ...state, workspaces: [{ ...state.workspaces[0], skills: [ref("skill", "standup-post", "Standup post")] }] };
  t = text(renderToStaticMarkup(h(MemoryView, { state: published, user: "u1", ws: "w1", category: "skills", onCategory: noop, onClose: noop })));
  assert.match(t, /Skills 1 People/);
  assert.ok(!/draft/.test(t));
  // No account (self-hosted, or signed out): Skills still opens, without Knowledge's other kinds.
  t = text(renderToStaticMarkup(h(MemoryView, { state: { ...state, account: undefined }, ws: "w1", category: "skills", onCategory: noop, onClose: noop })));
  assert.match(t, /Standup post/);
  assert.ok(!/Issues/.test(t), "no chips without an account");
});

await test("Routines in the footer: a round button, with how many monitors have news", async () => {
  const { AutopilotButton } = await import(pathToFileURL(`${root}/components/app/autopilot.tsx`).href);
  const base = { bots: [{ id: "boppy", name: "Boppy", isMain: true }], routines: [], watches: [], sessions: [], messages: [] };
  let html = renderToStaticMarkup(h(AutopilotButton, { state: base, onOpen: noop }));
  assert.match(html, /aria-label="Routines"/);
  assert.ok(!/bg-highlighter/.test(html), "no badge without news");
  const watch = (id, alert) => ({ id, botId: "boppy", site: "acme.example", lookFor: "a price drop", alert, page: { url: "https://acme.example" } });
  html = renderToStaticMarkup(h(AutopilotButton, { state: { ...base, watches: [watch("w1", { at: 1, text: "Down 10%" }), watch("w2", undefined)] }, onOpen: noop }));
  assert.match(html, /aria-label="Routines, 1 with news"/);
  assert.match(text(html), / 1 /);
  assert.match(html, /title="Routines: a monitor has news"/);
});

await test("Routines in the footer opens at the monitor with news", async () => {
  const { AutopilotButton } = await import(pathToFileURL(`${root}/components/app/autopilot.tsx`).href);
  const watch = (id, alert, since) => ({ id, botId: "boppy", site: "acme.example", lookFor: "a price drop", alert, since, page: { url: "https://acme.example" } });
  const state = { bots: [{ id: "boppy", name: "Boppy", isMain: true }], routines: [], sessions: [], messages: [], watches: [watch("w1", undefined, 3), watch("w2", { at: 1, text: "Down 10%" }, 1)] };
  const opened = [];
  AutopilotButton({ state, onOpen: (o) => opened.push(o) }).props.onClick();
  assert.deepEqual(opened, [{ section: "monitors", focus: "w2" }]);
  opened.length = 0;
  AutopilotButton({ state: { ...state, watches: [watch("w1", undefined, 3)] }, onOpen: (o) => opened.push(o) }).props.onClick();
  assert.deepEqual(opened, [{ section: "monitors", focus: undefined }], "no news: no row to go to");
});

await test("a new Needs you leaves Routines, Skills and the other pages you're reading", async () => {
  const { isReading } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  for (const kind of ["web", "vault", "crm", "memory", "bot", "autopilot"]) assert.equal(isReading({ id: "t", kind }), true, kind);
  for (const kind of ["computer", "new", "mac"]) assert.equal(isReading({ id: "t", kind }), false, kind);
  assert.equal(isReading(undefined), false);
});

await test("Knowledge opened again: a search on Issues goes to All", async () => {
  const { memoryAgain } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  const tab = (category) => ({ id: "t", kind: "memory", ws: "w1", category });
  assert.equal(memoryAgain(tab("issues"), { query: "Priya" }, 1).category, "all", "Issues doesn't search");
  assert.equal(memoryAgain(tab("issues"), { query: "Priya" }, 1).query, "Priya");
  assert.equal(memoryAgain(tab("people"), { query: "Priya" }, 1).category, "people", "a kind that searches stays");
  assert.equal(memoryAgain(tab("issues"), {}, 1).category, "issues", "opened again with nothing asked: where it was");
  assert.equal(memoryAgain(tab("all"), { category: "issues", focus: "i1" }, 2).category, "issues");
  assert.equal(memoryAgain(tab("issues"), { category: "todos", query: "x" }, 2).category, "todos", "the kind asked for wins");
});

await test("groupsOf still orders a category", async () => {
  const g = groupsOf("todos", [item("aaaaaaaaaa", "todos", "A", { done: true }), item("bbbbbbbbbb", "todos", "B")]);
  assert.deepEqual(g.map((x) => x.label), ["Open", "Done"]);
});

/* ---------------- Tags on an issue, picked in a DOM ---------------- */

// A DOM to render into, click and type in (linkedom), with what these need of a browser: focus that moves and
// the element that has it, a window's size, and keys and typing as React hears them.
const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
const focused = { on: null };
win.HTMLElement.prototype.focus = function () {
  focused.on = this;
};
win.HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(doc, "activeElement", { configurable: true, get: () => (focused.on?.isConnected ? focused.on : doc.body) });
globalThis.document = doc;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
// Typing as React hears it: by the input event, when the document says it has one (linkedom's doesn't), in a
// text field (a field with no type is one, as in a browser; linkedom says none).
doc.oninput = null;
Object.defineProperty(win.HTMLInputElement.prototype, "type", {
  configurable: true,
  get() {
    return this.getAttribute("type") || "text";
  },
  set(v) {
    this.setAttribute("type", v);
  },
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { IssuesPage } = await import(pathToFileURL(`${root}/components/app/orbit-issues.tsx`).href);

async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  return { box, done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
/** A key pressed where focus is: the event, to see whether it was taken. */
const press = async (key, el = doc.activeElement) => {
  const e = new win.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "key", { value: key });
  await act(async () => {
    el.dispatchEvent(e);
    await settle();
  });
  return e;
};
/**
 * A key as the whole window hears it: the window's capture listeners first, then the page (React), then the
 * window's others unless something stopped it. What the app's own Esc (bops-app.tsx) and an issue's hear.
 */
const pressInWindow = async (key, el = doc.activeElement) => {
  const e = new win.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "key", { value: key });
  let stopped = false;
  const stop = e.stopPropagation;
  e.stopPropagation = function () {
    stopped = true;
    return stop.call(this);
  };
  const heard = { key, target: el, get defaultPrevented() { return e.defaultPrevented; }, preventDefault: () => e.preventDefault(), stopPropagation: () => (stopped = true) };
  const on = (first) => (listeners.get("keydown") ?? []).filter((f) => captured.has(f) === first);
  await act(async () => {
    for (const f of on(true)) f(heard);
    if (!stopped) el.dispatchEvent(e);
    if (!stopped) for (const f of on(false)) f(heard);
    await settle();
  });
  return e;
};
/** A scroll, as the window's scroll listeners hear it (they listen in capture, so every one in the page). */
const scrollOf = (target) =>
  act(async () => {
    for (const f of listeners.get("scroll") ?? []) f({ target });
    await settle();
  });
/** Typing into a field: its value as the browser sets it, then the input event React listens for. */
const type = (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
const picker = () => doc.querySelector('body > [role="dialog"]');
const options = () => [...(picker()?.querySelectorAll('[role="option"]') ?? [])];
const optionsSaid = () => options().map((o) => `${o.textContent}${o.getAttribute("aria-selected") === "true" ? " ✓" : ""}`);
const option = (name) => options().find((o) => o.getAttribute("data-tag") === name);
const chips = (box) => [...box.querySelectorAll('button[aria-label^="Remove "]')].map((b) => b.getAttribute("aria-label").slice(7));
const plusOf = (box) => [...box.querySelectorAll("button")].find((b) => b.textContent === "+ Tag");

const WS_TAGS = ["Customer", "Outage", "Bug", "Office", "FYI"];
let tagged = [];
let refuse = null;
answer = (url, method, body) => {
  if (url.startsWith("/api/orbit/issues?ws=w9") && method === "GET") return { status: 200, body: { issues: tagged, tags: WS_TAGS } };
  const m = url.match(/^\/api\/orbit\/issues\/([^?]+)\?ws=w9$/);
  const at = m && tagged.find((i) => i.id === decodeURIComponent(m[1]));
  if (at && method === "GET") return { status: 200, body: { issue: { ...at, history: [] } } };
  if (at && method === "PATCH") {
    const no = refuse?.(body);
    if (no) return no;
    tagged = tagged.map((i) => (i === at ? { ...i, tags: body.tags ?? i.tags } : i));
    return { status: 200, body: { issue: { ...tagged.find((i) => i.id === at.id), history: [] } } };
  }
  return { status: 404, body: { error: "no" } };
};
const opened = (id, user = "u9") => h(IssuesPage, { user, ws: "w9", focus: id, tags: WS_TAGS, nav: null, onClose: noop });
const patches = () => calls.filter((c) => c.method === "PATCH").map((c) => c.body);

await test("an issue's + Tag opens a Bops picker over the page, not a datalist: every workspace tag, the ones on it checked in place", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer", "Outage"] })];
  const m = await mount(opened("issue-9", "u9a"));
  try {
    const plus = plusOf(m.box);
    assert.equal(plus.getAttribute("aria-haspopup"), "dialog");
    assert.equal(plus.getAttribute("aria-expanded"), "false");
    plus.getBoundingClientRect = () => ({ left: 300, right: 350, top: 272, bottom: 300, width: 50, height: 28 });
    await click(plus);
    assert.equal(plus.getAttribute("aria-expanded"), "true");
    assert.ok(!doc.querySelector("datalist"), "no datalist, nor the browser's own box");
    const pop = picker();
    assert.ok(pop && !m.box.contains(pop), "in the body, over everything, so the issue's scrolling page can't cut it off");
    assert.match(pop.className, /\bfixed\b/);
    assert.match(pop.className, /rounded-xl bg-white shadow-\[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040\]/, "the app's small menu look");
    assert.deepEqual([pop.style.left, pop.style.top, pop.style.bottom], ["300px", "306px", ""], "under + Tag");
    assert.deepEqual(optionsSaid(), ["Customer ✓", "Outage ✓", "Bug", "Office", "FYI"], "every tag, the ones on it checked, where they are");
    assert.equal(options().filter((o) => o.querySelector("svg path[d^='M2.5 6.2']")).length, 2, "a check mark on each picked one");
    const field = pop.querySelector("input");
    assert.equal(doc.activeElement, field, "focus in its search field");
    assert.equal(field.getAttribute("role"), "combobox");
    assert.equal(field.getAttribute("aria-expanded"), "true");
    const list = pop.querySelector('[role="listbox"]');
    assert.equal(field.getAttribute("aria-controls"), list.id);
    assert.equal(list.getAttribute("aria-multiselectable"), "true");
    assert.equal(field.getAttribute("aria-activedescendant"), options()[0].id, "the first row is the active one");
    assert.equal(field.getAttribute("maxlength") ?? field.getAttribute("maxLength"), "30", "30 characters at most, as before");
    assert.deepEqual(chips(m.box), ["Customer", "Outage"], "the chips stay as they are");
  } finally {
    await m.done();
  }
});

await test("clicking a tag takes it off the issue and puts it back (the chips' own change), and the picker stays open", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer", "Outage"] })];
  const m = await mount(opened("issue-9", "u9b"));
  try {
    await click(plusOf(m.box));
    calls.length = 0;
    await click(option("Outage"));
    assert.deepEqual(patches(), [{ tags: ["Customer"], ws: "w9" }]);
    assert.deepEqual(chips(m.box), ["Customer"]);
    assert.deepEqual(optionsSaid(), ["Customer ✓", "Outage", "Bug", "Office", "FYI"], "still listed, unchecked");
    await click(option("Outage"));
    assert.deepEqual(patches().at(-1), { tags: ["Customer", "Outage"], ws: "w9" });
    assert.deepEqual(chips(m.box), ["Customer", "Outage"]);
    await click(option("Bug"));
    assert.deepEqual(chips(m.box), ["Customer", "Outage", "Bug"]);
    assert.ok(picker(), "open for the next one");
    // A chip's x still takes one off.
    await click(m.box.querySelector('button[aria-label="Remove Bug"]'));
    assert.deepEqual(patches().at(-1), { tags: ["Customer", "Outage"], ws: "w9" });
  } finally {
    await m.done();
  }
});

await test("typing filters; a name that's no tag yet gets Create tag, which adds it (sent as new) and checks it", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer"] })];
  const m = await mount(opened("issue-9", "u9c"));
  try {
    await click(plusOf(m.box));
    const field = picker().querySelector("input");
    await type(field, "o");
    assert.deepEqual(optionsSaid(), ["Customer ✓", "Outage", "Office"], "the tags with an o");
    await type(field, "OUT");
    assert.deepEqual(optionsSaid(), ["Outage"], "any case");
    await type(field, "Outage");
    assert.ok(!picker().querySelector("[data-make]"), "no Create tag for a tag there is");
    await type(field, "billing");
    assert.deepEqual(optionsSaid(), ["Create tag “Billing”"], "named as it'll be kept");
    calls.length = 0;
    await press("Enter");
    assert.deepEqual(patches(), [{ tags: ["Customer", "Billing"], newTags: ["Billing"], ws: "w9" }]);
    assert.deepEqual(chips(m.box), ["Customer", "Billing"]);
    assert.equal(field.value, "", "the field is clear for the next");
    assert.deepEqual(optionsSaid(), ["Customer ✓", "Outage", "Bug", "Office", "FYI", "Billing ✓"]);
    // Clicked, the same.
    await type(field, "Vip list");
    await click(picker().querySelector("[data-make]"));
    assert.deepEqual(patches().at(-1), { tags: ["Customer", "Billing", "Vip list"], newTags: ["Vip list"], ws: "w9" });
    // Too long or too many words for a tag: no Create tag, and why.
    await type(field, "one two three four");
    assert.deepEqual(optionsSaid(), []);
    assert.match(picker().textContent, /A tag's name is a word or up to 3, 24 characters at most\./);
    await type(field, "zzz");
    assert.deepEqual(optionsSaid(), ["Create tag “Zzz”"]);
  } finally {
    await m.done();
  }
});

await test("keys: Down and Up move the active row, Enter turns it on or off, Esc closes it and only it, with focus back on + Tag", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer"] })];
  const m = await mount(opened("issue-9", "u9d"));
  try {
    const plus = plusOf(m.box);
    await click(plus);
    const field = picker().querySelector("input");
    const active = () => doc.getElementById(field.getAttribute("aria-activedescendant"))?.getAttribute("data-tag");
    assert.equal(active(), "Customer");
    await press("ArrowDown");
    assert.equal(active(), "Outage");
    await press("ArrowDown");
    await press("ArrowUp");
    assert.equal(active(), "Outage");
    await press("ArrowUp");
    await press("ArrowUp");
    assert.equal(active(), "FYI", "round to the last");
    calls.length = 0;
    await press("Enter");
    assert.deepEqual(patches(), [{ tags: ["Customer", "FYI"], ws: "w9" }]);
    await press("Enter");
    assert.deepEqual(patches().at(-1), { tags: ["Customer"], ws: "w9" }, "Enter again: off");
    await type(field, "bu");
    assert.equal(active(), "Bug", "typing starts at the first match");
    await press("Enter");
    assert.deepEqual(chips(m.box), ["Customer", "Bug"]);
    const esc = await press("Escape");
    assert.ok(esc.defaultPrevented, "taken, so the issue doesn't go back to the list");
    assert.equal(picker(), null);
    assert.equal(doc.activeElement, plus, "back on + Tag");
    assert.equal(plus.getAttribute("aria-expanded"), "false");
    assert.ok(m.box.querySelector('button[aria-label="Back to issues"]'), "still on the issue");
    // Tab closes it too, back on + Tag.
    await click(plus);
    assert.ok(picker());
    await press("Tab");
    assert.equal(picker(), null);
    assert.equal(doc.activeElement, plus);
  } finally {
    await m.done();
  }
});

await test("a click outside closes it; + Tag again closes it too", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: [] })];
  const m = await mount(opened("issue-9", "u9e"));
  try {
    const plus = plusOf(m.box);
    await click(plus);
    assert.ok(picker());
    await act(async () => void m.box.querySelector("span").dispatchEvent(new win.Event("pointerdown", { bubbles: true })));
    assert.equal(picker(), null, "closed by a click on the page");
    await click(plus);
    // A click in it doesn't.
    await act(async () => void picker().querySelector("input").dispatchEvent(new win.Event("pointerdown", { bubbles: true })));
    assert.ok(picker());
    await act(async () => void plus.dispatchEvent(new win.Event("pointerdown", { bubbles: true })));
    await click(plus);
    assert.equal(picker(), null, "+ Tag shuts it");
  } finally {
    await m.done();
  }
});

await test("with an issue's 6 tags: the others can't be added and it says why, no Create tag; taking one off still works", async () => {
  const six = ["Customer", "Outage", "Bug", "Office", "FYI", "Billing"];
  tagged = [issue("issue-9", { ws: "w9", tags: six })];
  const m = await mount(opened("issue-9", "u9f"));
  try {
    await click(plusOf(m.box));
    assert.match(picker().textContent, /An issue has 6 tags at most\. Take one off to add another\./);
    await type(picker().querySelector("input"), "Refunds");
    assert.deepEqual(optionsSaid(), [], "no Create tag");
    await type(picker().querySelector("input"), "");
    calls.length = 0;
    await click(option("Billing"));
    assert.deepEqual(patches(), [{ tags: six.slice(0, 5), ws: "w9" }]);
    assert.ok(!/6 tags at most/.test(picker().textContent), "room again");
  } finally {
    await m.done();
  }
});

await test("a new tag the server refuses comes off again, and why shows in the picker", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer"] })];
  refuse = (body) => (body.newTags ? { status: 400, body: { error: "A workspace has 8 tags of its own at most, and this one has 8. Pick one of its tags." } } : null);
  const m = await mount(opened("issue-9", "u9g"));
  try {
    await click(plusOf(m.box));
    const field = picker().querySelector("input");
    await type(field, "Refunds");
    await press("Enter");
    assert.deepEqual(chips(m.box), ["Customer"], "back as it was");
    const alert = picker().querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? "", /8 tags of its own at most/);
    assert.equal(m.box.querySelectorAll('[role="alert"]').length, 0, "said once, in the picker");
    assert.equal(field.value, "Refunds", "the name stays typed, to change or pick another");
    assert.deepEqual(optionsSaid(), ["Create tag “Refunds”"], "and Create tag with it, to try again");
  } finally {
    refuse = null;
    await m.done();
  }
});

await test("the issues list's tag filter: a pill like the others opening the same picker, one tag at a time, focus back on it", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer"], title: "Acme down" }), issue("issue-8", { ws: "w9", tags: ["Bug"], title: "Login bug" })];
  const m = await mount(h(IssuesPage, { user: "u9h", ws: "w9", tags: WS_TAGS, nav: null, onClose: noop }));
  try {
    assert.ok(!m.box.querySelector('select[aria-label="Tag"]'), "not a native select");
    const pill = m.box.querySelector('button[aria-label="Tag: Any tag"]');
    assert.ok(pill, "a pill saying Any tag");
    assert.equal(pill.textContent, "Any tag");
    // Each filter pill has a down mark that says it opens (drawn as an svg: the data URL background never was).
    for (const p of [m.box.querySelector('select[aria-label="Status"]'), pill, m.box.querySelector('select[aria-label="Priority"]')]) {
      const mark = [...p.parentElement.children].find((c) => c.tagName.toLowerCase() === "svg");
      assert.ok(mark?.querySelector('path[d="M3 4.5l3 3 3-3"]'), `${p.getAttribute("aria-label")} has its down mark`);
      assert.match(mark.getAttribute("class"), /pointer-events-none absolute right-2\.5/, "in its right padding, clicks going through to the pill");
    }
    assert.doesNotMatch(m.box.innerHTML, /bg-\[url\(/, "no background Tailwind can't make (it had spaces in it)");
    await click(pill);
    assert.equal(picker().querySelector('[role="listbox"]').getAttribute("aria-multiselectable"), null);
    assert.deepEqual(optionsSaid(), ["Any tag ✓", "Customer", "Outage", "Bug", "Office", "FYI"]);
    assert.ok(!picker().querySelector("[data-make]"));
    await click(option("Bug"));
    assert.equal(picker(), null, "a pick closes it");
    assert.equal(doc.activeElement, m.box.querySelector('button[aria-label="Tag: Bug"]'), "focus back on the pill");
    assert.match(m.box.textContent, /Login bug/);
    assert.doesNotMatch(m.box.textContent, /Acme down/);
    // From the keys: typed, Enter, and Any tag again.
    await click(m.box.querySelector('button[aria-label="Tag: Bug"]'));
    assert.equal(doc.getElementById(picker().querySelector("input").getAttribute("aria-activedescendant")).getAttribute("data-tag"), "Bug", "starts on the one picked");
    await type(picker().querySelector("input"), "cust");
    await press("Enter");
    assert.ok(m.box.querySelector('button[aria-label="Tag: Customer"]'));
    assert.match(m.box.textContent, /Acme down/);
    await click(m.box.querySelector('button[aria-label="Tag: Customer"]'));
    await type(picker().querySelector("input"), "any");
    await press("Enter");
    assert.ok(m.box.querySelector('button[aria-label="Tag: Any tag"]'));
    assert.match(m.box.textContent, /Acme down.*Login bug|Login bug.*Acme down/);
  } finally {
    await m.done();
  }
});

await test("a scroll that moves + Tag closes the picker (never riding up over the tab bar); its own list scrolling, or another, doesn't", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer"] })];
  const m = await mount(opened("issue-9", "u9j"));
  const chat = doc.createElement("div");
  doc.body.appendChild(chat);
  try {
    const plus = plusOf(m.box);
    await click(plus);
    await scrollOf(picker().querySelector('[role="listbox"]'));
    assert.ok(picker(), "its own list scrolling keeps it");
    await scrollOf(chat);
    assert.ok(picker(), "something else scrolling (a chat streaming beside it) keeps it");
    calls.length = 0;
    await type(picker().querySelector("input"), "bu");
    // The issue's page scrolls (the wheel over it): closed, focus back on + Tag, and keys typed after change nothing.
    const page = plus.closest(".overflow-y-auto");
    assert.ok(page?.contains(plus), "+ Tag's scrolling page");
    await scrollOf(page);
    assert.ok(!picker(), "closed by the page's scroll");
    assert.equal(plus.getAttribute("aria-expanded"), "false");
    assert.ok(doc.activeElement === plus, "focus back on + Tag, not left in a field no one sees");
    await press("Enter");
    assert.deepEqual(patches(), [], "no tag changed out of sight");
    assert.deepEqual(chips(m.box), ["Customer"]);
    // The window's own scroll closes it too.
    await click(plus);
    assert.ok(picker());
    await scrollOf(doc);
    assert.ok(!picker(), "closed by the window's scroll");
  } finally {
    chat.remove();
    await m.done();
  }
});

await test("Esc on the picker, then Esc again, goes back to the list, and the app's Esc doesn't close the Knowledge tab", async () => {
  // The app's Esc (bops-app.tsx escTab), listening since before the issue opened: closes the tab unless taken.
  let tabClosed = 0;
  const appEsc = (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && !doc.querySelector('[role="dialog"]')) tabClosed++;
  };
  globalThis.addEventListener("keydown", appEsc);
  tagged = [issue("issue-9", { ws: "w9", tags: ["Customer"] })];
  const m = await mount(opened("issue-9", "u9k"));
  const elsewhere = doc.createElement("button");
  doc.body.appendChild(elsewhere);
  try {
    const plus = plusOf(m.box);
    await click(plus);
    await pressInWindow("Escape");
    assert.ok(!picker(), "the picker closes");
    assert.ok(doc.activeElement === plus, "focus on + Tag");
    assert.ok(m.box.querySelector('button[aria-label="Back to issues"]'), "still on the issue");
    assert.equal(tabClosed, 0);
    await pressInWindow("Escape");
    assert.ok(!m.box.querySelector('button[aria-label="Back to issues"]'), "back to the list");
    assert.ok(m.box.querySelector('button[aria-label="Tag: Any tag"]'));
    assert.equal(tabClosed, 0, "the tab stays");
    await m.done();
    // Focus somewhere else in the window (the chat, the sidebar): the issue stays, the app's Esc has it.
    const n = await mount(opened("issue-9", "u9k2"));
    try {
      elsewhere.focus();
      await pressInWindow("Escape");
      assert.ok(n.box.querySelector('button[aria-label="Back to issues"]'), "the issue stays");
      assert.equal(tabClosed, 1, "the app's Esc heard it");
      // On nothing (a click on the page's words): back to the list.
      focused.on = null;
      await pressInWindow("Escape", doc.body);
      assert.ok(!n.box.querySelector('button[aria-label="Back to issues"]'), "back to the list");
      assert.equal(tabClosed, 1);
    } finally {
      await n.done();
    }
  } finally {
    globalThis.removeEventListener("keydown", appEsc);
    elsewhere.remove();
  }
});

await test("near the bottom of the window it opens above its anchor", async () => {
  tagged = [issue("issue-9", { ws: "w9", tags: [] })];
  const m = await mount(opened("issue-9", "u9i"));
  try {
    const plus = plusOf(m.box);
    plus.getBoundingClientRect = () => ({ left: 1190, right: 1240, top: 700, bottom: 728, width: 50, height: 28 });
    await click(plus);
    assert.deepEqual([picker().style.left, picker().style.top, picker().style.bottom], [`${1200 - 232 - 8}px`, "", "106px"], "over it, inside the window");
  } finally {
    await m.done();
  }
});

await test("no em or en dashes in what these files show", async () => {
  for (const f of ["components/app/orbit-issues.tsx", "components/app/memory-categories.tsx", "components/app/autopilot.tsx", "components/app/skills.tsx"]) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    // Strings and JSX text only: the comments may say anything.
    const shown = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/[–—]/.test(shown.replace(/replace\(\/[^)]*\)/g, "")), `${f} shows a dash`);
  }
});

console.log(`\n${passed} passed`);
process.exit(0);
