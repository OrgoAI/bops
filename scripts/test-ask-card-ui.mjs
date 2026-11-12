// Tests for a bot's ask to call a service with one of the user's keys, as its card and the sidebar show it
// (components/app/chat-view.tsx AppApprovalCard, components/app/keys.tsx ApiAsk, components/app/sidebar-sections.tsx
// AskCard, lib/permission.ts askHeadline and apiFacts): with the bot's reason in plain words (AppApproval.reason) the
// headline is "<Bot> wants to: <reason>", who asked for it is kept, and under it one line Bops itself says from the
// service and the method, never from the bot ("GitHub · adds or changes something", "deletes something"), so a reason
// can't hide a delete or another service. The method, path and body fold under Details, closed until it's opened. A
// change to files says its size beside Details, closed, and opens above it to every line it changes, file by file.
// Without a reason the headline is as before. The buttons are as before, Allow once the primary. The .tsx files are
// compiled with the TypeScript in node_modules as they load, rendered to HTML, and clicked in a linkedom DOM.
// Usage: node scripts/test-ask-card-ui.mjs   (not with --conditions=react-server: these are client components)
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

// A window, enough of one (nothing here runs effects until the DOM part).
globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3210" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.fetch = async () => Response.json({ ok: true });
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

const { ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { Sidebar } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const K = await import(pathToFileURL(`${root}/components/app/keys.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const T = 1_700_000_000_000;
const REASON = "Save the new button colour as a draft";
const PATH = "/repos/acme/site/git/blobs";

/** An ask to call a service with a key, as keys.ts callApi opens it; `over` changes any of it. */
const ask = (over = {}) => ({
  id: "apr1",
  botId: "boppy",
  chatId: "bot:boppy",
  action: "Call GitHub",
  resources: [`POST ${PATH}`],
  preview: 'body: {\n "content": "aGVsbG8=",\n "encoding": "base64"\n}',
  kind: "api",
  api: { key: "GITHUB_TOKEN", label: "GitHub", method: "POST", path: PATH },
  askedFor: "Sam",
  at: T,
  ...over,
});
const stateWith = (approvals) => ({
  bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" }],
  chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
  messages: [{ id: "u1", chatId: "bot:boppy", role: "user", text: "Make the button orange.", at: T - 1000 }],
  sessions: [],
  routines: [],
  watches: [],
  appApprovals: approvals,
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
});
const chat = (approvals) => {
  const state = stateWith(approvals);
  return renderToStaticMarkup(h(ChatView, { state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop }));
};
/** The sidebar, with the ask Max (not the main bot) made under Max, its threads open (as the user left them). */
const sidebar = (approvals) => {
  const state = stateWith(approvals.map((a) => ({ ...a, botId: "max", chatId: "bot:max" })));
  state.bots.push({ id: "max", name: "Max", role: "Research", color: "#2EC4B6", isMain: false, computerStatus: "none" });
  state.chats.push({ id: "bot:max", kind: "bot", botIds: ["max"], createdAt: 1, typing: [] });
  const was = localStorage.getItem;
  localStorage.getItem = (k) => (/^bops\.threads\.open\..*\.max$/.test(k) ? "1" : null);
  try {
    const props = { chatId: "bot:boppy", onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {} };
    const html = renderToStaticMarkup(h(Sidebar, { ...props, state }));
    const at = html.indexOf('data-need="ask:apr1"');
    return at < 0 ? "" : html.slice(html.lastIndexOf("<", at));
  } finally {
    localStorage.getItem = was;
  }
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
/** The markup of the card's one element marked `attr`. */
const marked = (html, attr) => html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>([\\s\\S]*?)</[a-z]+>`))?.[1];

/* ---------------- Rendered ---------------- */

await test("a reason heads the card in plain words, who asked for it is kept, and the facts line says the service and the kind of change", () => {
  const html = chat([ask({ reason: REASON })]);
  assert.match(text(html), new RegExp(`Boppy wants to: ${REASON}`));
  assert.doesNotMatch(text(html), /wants to call GitHub/, "the reason, not the action, heads it");
  assert.equal(text(marked(html, "data-asked-for") ?? ""), "Sam asked for it");
  assert.equal(text(marked(html, "data-ask-facts") ?? ""), "GitHub · adds or changes something");
});

await test("the method, path and body fold under Details, closed", () => {
  const html = chat([ask({ reason: REASON })]);
  const details = html.match(/<button[^>]*data-ask-details[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(details, "a Details button");
  assert.match(details, /aria-expanded="false"/);
  assert.match(text(details), /^Details$/);
  // What's under it is there, but shut: inert and hidden until Details opens it.
  const fold = html.slice(html.indexOf(details) + details.length);
  assert.match(fold, /^<div inert="" aria-hidden="true"/, "the fold right under it, shut");
  const shut = fold.slice(0, fold.indexOf("data-ask-buttons"));
  assert.match(shut, new RegExp(`>POST<[\\s\\S]*${PATH}`), "the method and path inside");
  assert.match(shut, /aGVsbG8=/, "and the body");
  const before = html.slice(0, html.indexOf(details));
  assert.ok(!before.includes(PATH), "no path above Details");
});

await test("without a reason the old headline shows, with the facts line", () => {
  const html = chat([ask()]);
  assert.match(text(html), /Boppy wants to call GitHub/);
  assert.doesNotMatch(text(html), /wants to:/);
  assert.equal(text(marked(html, "data-ask-facts") ?? ""), "GitHub · adds or changes something");
});

await test("a delete says it deletes something, and another service says its own name, whatever the reason says", () => {
  const del = chat([ask({ reason: REASON, api: { key: "GITHUB_TOKEN", label: "GitHub", method: "DELETE", path: "/repos/acme/site/git/refs/heads/main" }, resources: ["DELETE /repos/acme/site/git/refs/heads/main"] })]);
  assert.equal(text(marked(del, "data-ask-facts") ?? ""), "GitHub · deletes something");
  const other = chat([ask({ reason: "Save a draft on GitHub", action: "Call Stripe", api: { key: "STRIPE_SECRET_KEY", label: "Stripe", method: "POST", path: "/v1/refunds" }, resources: ["POST /v1/refunds"] })]);
  assert.equal(text(marked(other, "data-ask-facts") ?? ""), "Stripe · adds or changes something");
  // A query sent as a POST (GraphQL) or a GET that asks (Slack) can do anything: said so.
  const gql = chat([ask({ reason: "Look at the open issues", action: "Call Linear", api: { key: "LINEAR_API_KEY", label: "Linear", method: "POST", path: "/graphql" }, resources: ["POST /graphql"] })]);
  assert.equal(text(marked(gql, "data-ask-facts") ?? ""), "Linear · may add, change or delete something");
  const slack = chat([ask({ reason: "Read the channel", action: "Call Slack", api: { key: "SLACK_BOT_TOKEN", label: "Slack", method: "GET", path: "/chat.delete" }, resources: ["GET /chat.delete"] })]);
  assert.equal(text(marked(slack, "data-ask-facts") ?? ""), "Slack · may add, change or delete something");
});

await test("the buttons are as before: Deny, Always allow, Allow once the primary", () => {
  const html = chat([ask({ reason: REASON })]);
  const row = html.match(/<div[^>]*data-ask-buttons[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.deepEqual([...row.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]), ["Deny", "Always allow", "Allow once", "Tell the bot what to do instead"]);
  assert.match(row, /<button[^>]*class="[^"]*bg-ink text-white[^"]*"[^>]*>Allow once</);
});

await test("the sidebar's card has the same headline, and the old one without a reason, over the same facts line", () => {
  const card = sidebar([ask({ reason: REASON })]);
  assert.ok(card.length > 0, "the card under Max");
  assert.match(text(card), new RegExp(`^Max wants to: ${REASON} GitHub · adds or changes something Waiting`), "Bops' own line under the bot's words");
  assert.match(text(sidebar([ask()])), /^Max wants to call GitHub GitHub · adds or changes something/);
  // A reason that says it only reads can't hide a delete there either.
  const del = sidebar([ask({ reason: "Look at the open issues", api: { key: "GITHUB_TOKEN", label: "GitHub", method: "DELETE", path: "/repos/acme/site" }, resources: ["DELETE /repos/acme/site"] })]);
  assert.equal(text(marked(del, "data-ask-facts") ?? ""), "GitHub · deletes something");
});

await test("a change to files in one go: the facts line counts the files and names the branch; closed, one quiet line beside Details says its size; above Details, each file by name with what happens to it, its size and every line it changes", () => {
  const change = { repo: "acme/site", branch: "site/orange-buttons", base: "main", at: "4de5457", files: [{ path: "src/look.ts", op: "change", bytes: 59 }, { path: "src/notes.md", op: "add", bytes: 17 }, { path: "old.css", op: "delete" }] };
  const preview = 'acme/site, branch site/orange-buttons\nNew branch site/orange-buttons, from main.\n\nsrc/look.ts: changed, 59 B\nat line 2\n-   accent: "#FFD400",\n+   accent: "#F15B3B",\n\nsrc/notes.md: added, 17 B\n+ Buttons: orange.\n\nold.css: deleted';
  const html = chat([ask({ reason: "Make the buttons the logo's orange", api: { key: "GITHUB_TOKEN", label: "GitHub", method: "POST", path: "/repos/acme/site/git/commits", change }, preview, resources: change.files.map((f) => f.path) })]);
  assert.match(text(html), /Boppy wants to: Make the buttons the logo's orange/);
  const facts = html.match(/<span[^>]*data-ask-facts[^>]*>[\s\S]*?<\/span>/)[0];
  assert.equal(text(facts), "GitHub · changes 2 files and deletes 1 in acme/site, on site/orange-buttons", "the repository too: Bops', never the reason's");
  assert.match(facts, /text-\[#B42318\]/, "a delete in the colour for it");
  assert.equal(text(marked(html, "data-change-size") ?? ""), "3 files · 3 lines changed", "its size, closed, from Bops' own words");
  const rows = [...html.matchAll(/<div[^>]*data-change-file[^>]*><div[^>]*>([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
  assert.deepEqual(rows, ["src/look.ts changed · 59 B", "src/notes.md added · 17 B", "old.css deleted"]);
  // What it opens comes before Details and is shut: a card docked at the bottom grows upward, so Details stays put.
  const at = html.indexOf("data-ask-details");
  const diff = html.indexOf("data-change-diff");
  assert.ok(diff > 0 && diff < at, "the lines above Details");
  assert.match(html.slice(0, diff), /inert=""[^<]*>(?:(?!data-ask-details)[\s\S])*$/, "shut: inert until Details opens it");
  const region = html.slice(html.lastIndexOf("<div", diff), at);
  assert.match(region, /role="region"/);
  assert.match(region, /aria-label="What changes"/);
  assert.match(region, /tabindex="0"/, "reachable by keyboard");
  assert.match(region, /class="[^"]*max-h-\[clamp\(7\.5rem,calc\(45vh-16rem\),320px\)\][^"]*overflow-y-auto/, "one scroll area, inside the dock, never past the window");
  assert.ok(!region.includes("/repos/acme/site/git/commits"), "no method and path for a change");
  assert.match(text(region), /New branch site\/orange-buttons, from main\./, "a new branch's base");
  assert.ok(!text(region).includes("acme/site, branch site/orange-buttons"), "the repository and branch once, in the facts line");
  assert.match(text(region), /src\/look\.ts changed · 59 B at line 2 - accent: "#FFD400", \+ accent: "#F15B3B", src\/notes\.md added · 17 B \+ Buttons: orange\. old\.css deleted/);
  assert.match(region, /bg-\[#FEF3F2\][^>]*>[\s\S]*?accent: &quot;#FFD400&quot;/, "a line taken out, in the app's diff tint (skill-proposals.tsx)");
  assert.match(region, /bg-\[#ECFDF3\][^>]*>[\s\S]*?accent: &quot;#F15B3B&quot;/, "a line put in, likewise");
});

await test("an older Bops's words: its lines as they came, the size in files alone when they can't be counted, and words in another shape shown whole", () => {
  const change = { repo: "acme/site", branch: "main", at: "4de5457", files: [{ path: "src/a.txt", op: "change", bytes: 90 }] };
  const cut = K.changeOf(change, "src/a.txt: changed, 90 B\nat line 3\n- x\n+ y\n  and 4 more lines");
  assert.deepEqual(cut.files[0].map((r) => r.note ?? `${r.t} ${r.s}`), ["at line 3", "- x", "+ y", "  and 4 more lines"]);
  assert.equal(K.changeSize(change, cut), "1 file", "not counted from a cut list");
  assert.equal(K.changeOf(change, "something else entirely"), null);
  // A task's card: the bot's words last, labelled (repo-change.ts), set apart from the diff, which still reads.
  const task = K.changeOf(change, "acme/site, branch main\n\nsrc/a.txt: changed, 90 B\n- x\n+ y\n\nIn the bot's words: Make it orange");
  assert.equal(task?.files.length, 1);
  assert.equal(task?.changed, 2);
  assert.equal(task?.said, "Make it orange");
  const html = chat([ask({ api: { key: "GITHUB_TOKEN", label: "GitHub", method: "POST", path: "/repos/acme/site/git/commits", change }, preview: "something else entirely" })]);
  assert.match(html.slice(html.indexOf("data-change-diff")), /<pre[^>]*>something else entirely<\/pre>/);
  assert.equal(K.changeSize({ ...change, files: [...change.files, { path: "b", op: "delete" }] }, K.changeOf(change, "acme/site, branch main\n\nsrc/a.txt: changed, 90 B\n- x\n+ y")), "2 files · 2 lines changed");
});

await test("a picture from the chat in a change: the thumbnail of the copy that goes in, its name, size and pixel size, and no lines; none in a shared workspace's window, which can't open the owner's pictures yet", () => {
  const change = { repo: "acme/site", branch: "site/favicon", base: "main", files: [{ path: "public/favicon.png", op: "add", bytes: 908, image: { id: "img_logo1", w: 512, h: 384 } }, { path: "README.md", op: "change", bytes: 20 }] };
  const a = ask({ reason: "Use our logo as the site's tab icon", api: { key: "GITHUB_TOKEN", label: "GitHub", method: "POST", path: "/repos/acme/site/git/commits", change }, preview: "public/favicon.png: added, 908 B, 512 × 384, picture 1 from the chat\n\nREADME.md: changed, 20 B\n+ Logo: the new one." });
  const rows = [...chat([a]).matchAll(/<div[^>]*data-change-file[^>]*>([\s\S]*?)<\/div><\/div>/g)].map((m) => m[1]);
  assert.match(rows[0], /<img data-change-image="true" src="\/api\/uploads\/img_logo1" alt="public\/favicon\.png, as it goes in"[^>]*\/><span[^>]*>public\/favicon\.png<\/span>/, "the thumbnail, then its path");
  assert.match(text(rows[0]), /added · 908 B · 512 × 384$/, "its size and pixel size");
  assert.doesNotMatch(rows[0], /<pre/, "no lines for a picture");
  assert.doesNotMatch(rows[1], /<img/, "a text file has none");
  globalThis.bopsViewOnly = { line: "You can watch this bot." };
  try {
    assert.doesNotMatch(chat([a]), /data-change-image/);
  } finally {
    globalThis.bopsViewOnly = undefined;
  }
});

/* ---------------- Opened ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
globalThis.document = doc;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const settle = () => new Promise((r) => setTimeout(r, 5));
const click = (el) => act(async () => (el.dispatchEvent(new win.Event("click", { bubbles: true })), await settle()));

await test("Details opens to the method and path whole, and shuts again", async () => {
  const a = ask({ reason: REASON });
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(h(K.ApiAsk, { ask: K.apiAskOf(a), detail: a.preview, botName: "Boppy" })), await settle()));
  const details = box.querySelector("[data-ask-details]");
  assert.equal(details.getAttribute("aria-expanded"), "false");
  const path = [...box.querySelectorAll("span")].find((e) => e.textContent === PATH);
  assert.ok(path?.closest("[inert]"), "shut: out of reach");
  await click(details);
  assert.equal(details.getAttribute("aria-expanded"), "true");
  assert.equal(path.closest("[inert]"), null, "open: within reach");
  await click(details);
  assert.equal(details.getAttribute("aria-expanded"), "false");
  await act(async () => r.unmount());
  box.remove();
});

await test("a change opens to every line in full, however many and however long, in one labelled scroll area; Details stays below it, says so, and shuts it again", async () => {
  const long = `const look = "${"a".repeat(400)}";`;
  const body = Array.from({ length: 300 }, (_, i) => `+ line ${i + 1}`).join("\n");
  const change = { repo: "acme/site", branch: "main", at: "4de5457", files: [{ path: "src/list.txt", op: "add", bytes: 3700 }] };
  const a = ask({ api: { key: "GITHUB_TOKEN", label: "GitHub", method: "POST", path: "/repos/acme/site/git/commits", change }, preview: `acme/site, branch main\n\nsrc/list.txt: added, 3.6 KB\n${body}\n+ ${long}` });
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(h(K.ApiAsk, { ask: K.apiAskOf(a), detail: a.preview, botName: "Boppy" })), await settle()));
  const details = box.querySelector("[data-ask-details]");
  const region = box.querySelector("[data-change-diff]");
  assert.equal(box.querySelector("[data-change-size]").textContent, "1 file · 301 lines changed");
  assert.deepEqual([...box.querySelectorAll("[data-change-diff], [data-ask-details]")].map((e) => (e === details ? "Details" : "lines")), ["lines", "Details"], "Details below what it opens");
  assert.ok(region.closest("[inert]"), "shut: out of reach");
  await click(details);
  assert.equal(details.getAttribute("aria-expanded"), "true");
  assert.equal(region.closest("[inert]"), null, "open: within reach");
  assert.deepEqual([region.getAttribute("role"), region.getAttribute("aria-label"), region.getAttribute("tabindex")], ["region", "What changes", "0"]);
  const lines = [...region.querySelectorAll("pre > div")].map((d) => d.textContent);
  assert.equal(lines.length, 301, "every line");
  assert.deepEqual([lines[0], lines[299], lines[300]], ["+line 1", "+line 300", `+${long}`], "each whole");
  await click(details);
  assert.equal(details.getAttribute("aria-expanded"), "false");
  await act(async () => r.unmount());
  box.remove();
});

console.log(`\nask card ui: ${passed} passed`);
