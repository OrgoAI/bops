// Tests for Orbit in the window (components/app/memory-categories.tsx and orbit-issues.tsx): Forget is
// at once with 5 seconds to undo before anything is sent, a new Forget sends the one before, a failed one
// puts the items back; Delete everywhere's preview is read as sent; issues change at once and go back
// when the server says no; and the sidebar and pages, rendered to HTML, show what they should (Issues
// first with its open count, the blank lines, Select, the issue filters).
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
globalThis.window = globalThis;
globalThis.addEventListener = (k, f) => listeners.set(k, [...(listeners.get(k) ?? []), f]);
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
// Real timers, but Forget's 5 seconds made short: setTimeout of 5000 here runs in 30ms.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, ms, ...a) => realSetTimeout(f, ms === UNDO_MS ? 30 : ms, ...a);
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

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
  await wait(60);
  assert.equal(calls.filter((c) => c.body?.action === "forget").length, 0);
});

await test("after 5 seconds it's sent, with every id, and stays gone", async () => {
  orbitStore.forget("u1", "w1", [
    { id: "aaaaaaaaaa", title: "Priya Shah" },
    { id: "bbbbbbbbbb", title: "Dana Lee" },
  ]);
  assert.equal(orbitStore.forgetting("u1", "w1").undo?.label, "Forgot 2 items");
  await wait(60);
  await settle();
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
  await wait(60);
  await settle();
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
  for (const kind of ["web", "vault", "crm", "memory", "bot", "autopilot", "skills"]) assert.equal(isReading({ id: "t", kind }), true, kind);
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

await test("no em or en dashes in what these files show", async () => {
  for (const f of ["components/app/orbit-issues.tsx", "components/app/memory-categories.tsx", "components/app/autopilot.tsx"]) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    // Strings and JSX text only: the comments may say anything.
    const shown = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/[–—]/.test(shown.replace(/replace\(\/[^)]*\)/g, "")), `${f} shows a dash`);
  }
});

console.log(`\n${passed} passed`);
process.exit(0);
