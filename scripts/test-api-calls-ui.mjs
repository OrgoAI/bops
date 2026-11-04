// Tests for a bot's calls with one of the user's keys in the chat (components/app/keys.tsx apiCallOf, ApiCalls, chat-view.tsx):
// calls to one service in a row, by the same bot, all reads or all changes, say one plain line with how many ("Looked at
// 6 files on GitHub", "Boppy changed a file on GitHub"), no path and no monospace in it; a single call says it too, its
// path on hover; a call to another service, a failed one or a quarter of an hour between them starts a new line; the
// line opens the list of what was called, each path whole. The .tsx files are compiled with the TypeScript in
// node_modules as they load, rendered to HTML, and clicked in a linkedom DOM.
// Usage: node scripts/test-api-calls-ui.mjs   (not with --conditions=react-server: these are client components)
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

// A window, enough of one (nothing here runs effects: it's rendered to HTML, then clicked in a DOM).
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

/* ---------------- A chat with calls in it ---------------- */

const file = (n) => `/repos/acme/site/contents/src/components/form-section-${n}.tsx`;
/** A GET's note, as keys.ts callApi leaves it ("Called GitHub GET /path"); `s` seconds into the chat. */
const read = (id, s, path = file(id), label = "GitHub") => ({ id, chatId: "bot:boppy", role: "system", text: `Called ${label} GET ${path}`, at: T + s * 1000 });
/** An approved write's note: who made it, what it called (appResult). */
const wrote = (id, s, path = file(id), method = "PUT") => ({ id, chatId: "bot:boppy", role: "system", text: `Boppy: Called GitHub ${method} ${path}`, appResult: { action: `GitHub ${method} ${path}`, ok: true, output: "{}" }, at: T + s * 1000 });
const failed = (id, s, path = file(id)) => ({ id, chatId: "bot:boppy", role: "system", text: "Boppy couldn't call it: GitHub answered 404", appResult: { action: `GitHub GET ${path}`, ok: false, output: "Not Found", unasked: true, read: true }, at: T + s * 1000 });
const said = (id, s, text, role = "bot") => ({ id, chatId: "bot:boppy", role, ...(role === "bot" ? { botId: "boppy" } : {}), text, at: T + s * 1000 });

const stateWith = (messages, sessions = []) => ({
  bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" }],
  chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
  messages,
  sessions,
  routines: [],
  watches: [],
  appApprovals: [],
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
});
const chat = (messages, sessions) => {
  const state = stateWith(messages, sessions);
  return renderToStaticMarkup(h(ChatView, { state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop }));
};
/** Each call line's words, in order. */
const lines = (html) => [...html.matchAll(/<button[^>]*data-api-calls[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

await test("six reads of one service in a row: one line with how many, no path and no monospace in it", () => {
  const html = chat([said("u1", 0, "Yes, go ahead.", "user"), said("b1", 5, "Done."), ...[1, 2, 3, 4, 5, 6].map((n) => read(`r${n}`, 5 + n))]);
  assert.deepEqual(lines(html), ["Looked at 6 files on GitHub"]);
  const line = html.match(/<button[^>]*data-api-calls[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(line, /font-mono/, "the line is in the chat's own words, not code");
  assert.doesNotMatch(html, /\/repos\/acme/, "no path until it's opened");
  assert.doesNotMatch(html, /Called GitHub/, "no raw note rows");
});

await test("a change says Changed, by whom; a single read says it too, its path on hover", () => {
  assert.deepEqual(lines(chat([wrote("w1", 1)])), ["Boppy changed a file on GitHub"]);
  assert.deepEqual(lines(chat([wrote("w1", 1), wrote("w2", 2, file("w2"), "POST")])), ["Boppy changed 2 files on GitHub"]);
  const one = chat([read("r1", 1)]);
  assert.deepEqual(lines(one), ["Looked at a file on GitHub"]);
  assert.match(one, /<button(?=[^>]*data-api-calls)(?=[^>]*title="GET \/repos\/acme\/site\/contents\/src\/components\/form-section-r1\.tsx")/, "the path on hover");
  // Something that isn't a file (a branch's ref, a list of repos): said as what it is not.
  assert.deepEqual(lines(chat([read("r1", 1), read("r2", 2, "/repos/acme/site/git/ref/heads/main")])), ["Looked at 2 things on GitHub"]);
  assert.deepEqual(lines(chat([read("s1", 1, "/v1/customers", "Stripe")])), ["Looked at something on Stripe"]);
  // A GET the user said yes to changed something: only a call that changes something asks (a Slack GET that posts).
  const posted = { id: "p1", chatId: "bot:boppy", role: "system", text: "Boppy: Called Slack GET /chat.postMessage", appResult: { action: "Slack GET /chat.postMessage", ok: true, output: "{}" }, at: T };
  assert.deepEqual(lines(chat([posted])), ["Boppy changed something on Slack"]);
});

await test("another service, a change among reads, a failed write or a quarter of an hour between them starts a new line", () => {
  assert.deepEqual(lines(chat([read("r1", 1), read("r2", 2), read("s1", 3, "/v1/customers", "Stripe"), read("r3", 4)])), ["Looked at 2 files on GitHub", "Looked at something on Stripe", "Looked at a file on GitHub"]);
  assert.deepEqual(lines(chat([read("r1", 1), wrote("w1", 2), read("r2", 3)])), ["Looked at a file on GitHub", "Boppy changed a file on GitHub", "Looked at a file on GitHub"]);
  // A read the bot made on its own that didn't work (a file that isn't there) is one of its reads, said quietly: no red
  // note in the chat for it. A write someone said yes to that failed keeps its own note, with why.
  const looked = chat([read("r1", 1), failed("f1", 2), read("r2", 3)]);
  assert.deepEqual(lines(looked), ["Looked at 3 files on GitHub, 1 didn&#x27;t work"]);
  assert.doesNotMatch(looked, /couldn&#x27;t call/, "no red note for a read");
  // One that starts the run, or stands alone: quiet too. Two that failed: said as two.
  assert.deepEqual(lines(chat([failed("f1", 1), read("r1", 2)])), ["Looked at 2 files on GitHub, 1 didn&#x27;t work"]);
  assert.deepEqual(lines(chat([failed("f1", 1)])), ["Looked at a file on GitHub, 1 didn&#x27;t work"]);
  assert.deepEqual(lines(chat([failed("f1", 1), failed("f2", 2)])), ["Looked at 2 files on GitHub, 2 didn&#x27;t work"]);
  // A call that changes something but wasn't asked about (an Always allow), a GET that posts: never quiet.
  const posted = { id: "sp", chatId: "bot:boppy", role: "system", text: "Boppy couldn't call it: Slack answered 400", appResult: { action: "Slack GET /chat.postMessage", ok: false, output: "invalid", unasked: true }, at: T + 2000 };
  assert.match(chat([read("r1", 1), posted]), /Boppy couldn&#x27;t call Slack/, "an unasked write that failed keeps its red note");
  const failedWrite = { id: "fw", chatId: "bot:boppy", role: "system", text: "Boppy couldn't call it: GitHub answered 409", appResult: { action: `GitHub PUT ${file("fw")}`, ok: false, output: "Conflict" }, at: T + 2000 };
  const broken = chat([read("r1", 1), failedWrite, read("r2", 3)]);
  assert.deepEqual(lines(broken), ["Looked at a file on GitHub", "Looked at a file on GitHub"]);
  assert.match(broken, /Boppy couldn&#x27;t call GitHub/, "a failed write keeps its own note, with why");
  assert.deepEqual(lines(chat([read("r1", 1), read("r2", 16 * 60)])), ["Looked at a file on GitHub", "Looked at a file on GitHub"]);
  assert.deepEqual(lines(chat([read("r1", 1), said("b1", 2, "Here it is."), read("r2", 3)])), ["Looked at a file on GitHub", "Looked at a file on GitHub"], "a message between them");
  // A thread's chip under a call ends its line there: nothing after it folds above the chip.
  const thread = [{ id: "t1", botId: "boppy", chatId: "bot:boppy", title: "Check the form", goal: "", sentVia: "you", host: "cloud", status: "done", replies: [], steps: [], createdAt: T }];
  const chipped = (m) => ({ ...m, sessionIds: ["t1"] });
  const first = chat([chipped(read("r1", 1)), read("r2", 2)], thread);
  assert.deepEqual(lines(first), ["Looked at a file on GitHub", "Looked at a file on GitHub"], "a chip on the first");
  assert.ok(first.indexOf("Check the form") < first.lastIndexOf("data-api-calls"), "the chip before the next line");
  assert.deepEqual(lines(chat([read("r1", 1), chipped(read("r2", 2)), read("r3", 3)], thread)), ["Looked at a file on GitHub", "Looked at a file on GitHub", "Looked at a file on GitHub"], "a chip on a middle one");
});

await test("a bot's reply keeps its buttons (Go on) through the notes after it, until someone answers", () => {
  const stopped = { ...said("b1", 1, "I checked the setup but haven't changed it yet."), options: ["Go on"] };
  const goOn = (html) => /<button[^>]*>Go on<\/button>/.test(html);
  assert.ok(goOn(chat([stopped])), "on the newest");
  assert.ok(goOn(chat([stopped, read("r1", 2)])), "a note after it doesn't take the button away");
  assert.ok(!goOn(chat([stopped, read("r1", 2), said("u1", 3, "go on", "user")])), "an answer does");
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

await test("the line opens the list of what was called, each method and path whole, and shuts it again", async () => {
  const calls = [1, 2, 3].map((n) => K.apiCallOf(read(`r${n}`, n))).concat(K.apiCallOf(read("r4", 4, "/repos/acme/site/git/ref/heads/main")));
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(h(K.ApiCalls, { calls })), await settle()));
  const line = box.querySelector("[data-api-calls]");
  assert.equal(line.getAttribute("aria-expanded"), "false");
  assert.equal(line.textContent.trim(), "Looked at 4 things on GitHub");
  await click(line);
  assert.equal(line.getAttribute("aria-expanded"), "true");
  const shown = [...box.querySelectorAll("[data-api-call]")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(shown, [...[1, 2, 3].map((n) => `GET ${file(`r${n}`)}`), "GET /repos/acme/site/git/ref/heads/main"]);
  for (const e of box.querySelectorAll("[data-api-call]")) assert.doesNotMatch(e.className, /truncate/, "never cut mid-path");
  assert.equal(box.querySelector("[data-api-call]").closest("[inert]"), null, "within reach");
  await click(line);
  assert.equal(line.getAttribute("aria-expanded"), "false");
  await act(async () => r.unmount());
  box.remove();
});

await test("a read that didn't work says why in the opened list, as words anyone can read (not only on hover)", async () => {
  const calls = [K.apiCallOf(read("r1", 1)), K.apiCallOf(failed("f1", 2))];
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(h(K.ApiCalls, { calls })), await settle()));
  await click(box.querySelector("[data-api-calls]"));
  const shown = [...box.querySelectorAll("[data-api-call]")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(shown, [`GET ${file("r1")}`, `GET ${file("f1")} · didn't work: GitHub answered 404`]);
  await act(async () => r.unmount());
  box.remove();
});

await test("a long block of code in a reply folds behind a quiet line that opens it; a short one shows as it is", async () => {
  const { Rich } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
  const long = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join("\n");
  const short = "npm run build\nnpm start";
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(h(Rich, { text: `Here's what changed:\n\`\`\`ts\n${long}\n\`\`\`\nAnd to run it:\n\`\`\`\n${short}\n\`\`\`` })), await settle()));
  const fold = box.querySelector("[data-code-fold]");
  assert.ok(fold, "the long one folds");
  assert.equal(fold.textContent.trim(), "40 lines of code");
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.ok(!box.textContent.includes("const line20"), "its lines out of sight until opened");
  assert.equal([...box.querySelectorAll("pre")].map((p) => p.textContent).join("|"), short, "the short one shows as it is");
  await click(fold);
  assert.equal(fold.getAttribute("aria-expanded"), "true");
  assert.ok(box.textContent.includes("const line20"), "opened: all of it");
  await act(async () => r.unmount());
  box.remove();
  // 15 lines show, 16 fold, whatever the line endings.
  const lines = (n, nl) => Array.from({ length: n }, (_, i) => `line ${i}`).join(nl);
  for (const [n, nl, folded] of [[15, "\n", false], [16, "\n", true], [15, "\r\n", false], [16, "\r\n", true]]) {
    const b2 = doc.createElement("div");
    doc.body.appendChild(b2);
    const r2 = createRoot(b2);
    await act(async () => (r2.render(h(Rich, { text: `Here:${nl}\`\`\`${nl}${lines(n, nl)}${nl}\`\`\`` })), await settle()));
    const f2 = b2.querySelector("[data-code-fold]");
    assert.equal(!!f2, folded, `${n} lines, ${JSON.stringify(nl)}`);
    if (f2) assert.equal(f2.textContent.trim(), `${n} lines of code`);
    await act(async () => r2.unmount());
    b2.remove();
  }
});

console.log(`\napi calls ui: ${passed} passed`);
