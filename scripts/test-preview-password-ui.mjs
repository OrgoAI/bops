// Tests for a site's Preview password in the window (components/app/preview-password.tsx, and where preview-tab.tsx,
// app-envs.tsx and hosted-apps.tsx put it): beside its Preview link, "Password" with its value and Copy, read once from
// the window's route however many places show it, and again only when the apps list says Bops set a newer one; nothing
// where it asks for none, or Orgo can't tell; Copy writes the clipboard only when pressed; its tab's section with Ask for
// a password (on, with "A new one with each deploy"), New password asked once more in place (no dialog) and the switch,
// each place showing what changed at once; Bops' own preview view gets its cookie put in its session through the Mac
// app (once a value, again with a reload when it changes, waited for before the Preview shows); the tab bar's lock and
// Open in browser, which says the browser asks for it and opens only when pressed. On the Preview line in Your Apps
// (app-envs.tsx), Password, its value and Copy are one piece, never cut short and never drawn over what the line serves;
// the tab's section and the tab bar wrap rather than squeeze. Rendered into a DOM (linkedom) and clicked; the server is a
// stubbed fetch. Nothing a person reads has a dash.
// Usage: node scripts/test-preview-password-ui.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// (As a path, not a URL's: a folder with a space in its name would be %20, then %2520 once made a URL again.)
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

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

// A window, enough of one, with a DOM to render into and click; the server a stubbed fetch (`routes` by path), the
// clipboard and window.open kept, and the Mac app's previewSignIn (desktop/preload.cjs) recording what it's asked.
const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
globalThis.window = globalThis;
globalThis.document = doc;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const copied = [];
Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (t) => void copied.push(t) } });
const opened = [];
globalThis.open = (u, target) => void opened.push([u, target]);
const signIns = [];
globalThis.bopsMac = { previewSignIn: async (ask) => (signIns.push(ask), true) };
const calls = [];
let routes = {};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
  const path = String(url).split("?")[0];
  const answer = routes[path];
  if (!answer) return { ok: false, status: 404, json: async () => ({}) };
  const { status = 200, body } = await (typeof answer === "function" ? answer(String(url), init) : answer);
  return { ok: status < 400, status, json: async () => body };
};

const P = await import(pathToFileURL(`${root}/components/app/preview-password.tsx`).href);
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");

let passed = 0;
let failed = 0;
const test = async (name, f) => {
  try {
    await f();
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n${String(e?.stack ?? e).split("\n").slice(0, 6).join("\n")}`);
    return;
  }
  passed++;
  console.log(`ok - ${name}`);
};
const NO_DASHES = /[‐-―]| - /;
const settle = () => new Promise((r) => setTimeout(r, 5));
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => {
    root.render(el);
    await settle();
  });
  return { box, again: (next) => act(async () => (root.render(next), await settle())), done: async () => (await act(async () => root.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
const button = (el, label) => [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
/** What an element says, its pieces of text one word apart. */
const words = (el) => {
  const out = [];
  const walk = (n) => (n.nodeType === 3 ? out.push(n.textContent.trim()) : [...n.childNodes].forEach(walk));
  walk(el);
  return out.filter(Boolean).join(" ");
};

const URL1 = "https://k7p2qxm4wr3d.orgo.dev";
const PART = "persist:bops-preview-u_1-ws_main-shop";
const ROUTE = "/api/hosted-apps/shop/password";
/** The server's answers: whether it asks for one, the password, its cookie made from it, `at` when it was set (later each check, as the window's copy outlives one). */
let server;
let base = 0;
const preview = (extra = {}) => ({ projectId: "p_pv", url: URL1, label: "k7p2qxm4wr3d", serving: null, live: null, protected: true, passwordAt: server.at, ...extra });
const answer = () => ({ url: URL1, on: server.on, password: server.on ? server.password : null, cookie: server.on ? { name: "__Host-orgo_pass", value: `v1.${server.password}` } : null, at: server.at });
const fresh = (site) => {
  base += 1000;
  server = { on: true, password: "Ab3xY9k", at: base };
  calls.length = 0;
  copied.length = 0;
  opened.length = 0;
  signIns.length = 0;
  routes = {
    [site ?? ROUTE]: (url, init) => {
      if (init.method === "POST") {
        const { action } = JSON.parse(init.body);
        if (action === "off") server.on = false;
        else {
          server.on = true;
          server.password = action === "new" ? "Qm7pRt4" : "Hn5wKz8";
          server.at += 50;
        }
      }
      return { body: answer() };
    },
  };
};
const reads = () => calls.filter((c) => c.method === "GET" && c.url.startsWith(ROUTE));

/** The Preview tab's use of it: its cookie in its session, `ready`, and the lock with its popover. */
function Tab({ preview: p, onRenewed, onReady }) {
  const pass = P.usePreviewTabPassword("ws_main", "shop", undefined, p, PART, onRenewed);
  onReady.current = pass.ready;
  return h("div", null, pass.on && h(P.PreviewLock, { pass, at: `${URL1}/menu` }), h("button", { "data-browser": "", onClick: () => pass.setPopover("browser") }, "Open"));
}

await test("beside a Preview link: Password, its value and Copy, read once from the window's route however many places show it; nothing where it asks for none or Orgo can't tell", async () => {
  fresh();
  const two = h("div", null, h(P.PasswordBeside, { ws: "ws_main", name: "shop", preview: preview() }), h(P.PasswordBeside, { ws: "ws_main", name: "shop", preview: preview() }));
  const m = await mount(two);
  assert.equal(reads().length, 1, "one read for both");
  assert.equal(reads()[0].url, `${ROUTE}?ws=ws_main`);
  const beside = m.box.querySelectorAll("[data-password-beside]");
  assert.equal(beside.length, 2);
  assert.equal(words(beside[0]), "Password Ab3xY9k");
  assert.ok(button(beside[0], "Copy password"));
  assert.equal(copied.length, 0, "nothing copied until Copy is pressed");
  await click(button(beside[0], "Copy password"));
  assert.deepEqual(copied, ["Ab3xY9k"]);
  await m.done();
  fresh();
  for (const p of [preview({ protected: false }), preview({ protected: undefined, passwordAt: undefined }), preview({ url: null }), undefined]) {
    const n = await mount(h(P.PasswordBeside, { ws: "ws_main", name: "shop", preview: p }));
    assert.equal(n.box.innerHTML, "", JSON.stringify(p));
    await n.done();
  }
  assert.equal(reads().length, 0, "nothing read for them");
});

await test("read again only when the list says Bops set a newer one (a deploy went live, say): every place then shows the new one", async () => {
  fresh("/api/hosted-apps/menu/password");
  routes[ROUTE.replace("shop", "menu")] = routes["/api/hosted-apps/menu/password"];
  const first = server.at;
  const el = (at) => h(P.PasswordBeside, { ws: "ws_main", name: "menu", preview: preview({ passwordAt: at }) });
  const m = await mount(el(first));
  await m.again(el(first));
  assert.equal(calls.length, 1);
  server.password = "Zx8cVb2";
  server.at = first + 200;
  await m.again(el(first + 200));
  assert.equal(calls.length, 2, "read again for the newer one");
  assert.equal(words(m.box), "Password Zx8cVb2");
  await m.again(el(first + 200));
  assert.equal(calls.length, 2);
  await m.done();
});

await test("its tab's Password section: the value with Copy, Ask for a password on with \"A new one with each deploy\", New password asked once more in place (no dialog), the switch off and on; each place shows the change at once", async () => {
  fresh();
  const pv = preview();
  const m = await mount(h("div", null, h(P.PasswordSection, { ws: "ws_main", name: "shop", preview: pv }), h(P.PasswordBeside, { ws: "ws_main", name: "shop", preview: pv })));
  const sec = m.box.querySelector("[data-password-section]");
  const sw = sec.querySelector("[data-password-switch]");
  assert.equal(sw.getAttribute("role"), "switch");
  assert.equal(sw.getAttribute("aria-checked"), "true");
  assert.equal(words(sw), "Ask for a password");
  assert.match(words(sec), /^Password Ab3xY9k New password Ask for a password A new one with each deploy\.$/);
  // New password: asked in place first, nothing sent.
  await click(button(sec, "New password"));
  assert.equal(m.box.querySelector('[role="dialog"]'), null, "no dialog");
  assert.match(words(sec), /Make a new password\? People using the old one will need the new one\./);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing sent yet");
  const confirm = [...sec.querySelectorAll("button")].filter((b) => b.textContent.trim() === "New password").at(-1);
  await click(confirm);
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.body), [{ ws: "ws_main", action: "new" }]);
  assert.match(words(sec), /^Password Qm7pRt4 New password/);
  assert.equal(words(m.box.querySelector("[data-password-beside]")), "Password Qm7pRt4", "beside the link too, at once");
  assert.doesNotMatch(words(sec), /Make a new password/, "the question closed");
  // Off: anyone with the link opens it, and nothing shows beside it.
  await click(sw);
  assert.deepEqual(calls.filter((c) => c.method === "POST").at(-1).body, { ws: "ws_main", action: "off" });
  assert.equal(sec.querySelector("[data-password-switch]").getAttribute("aria-checked"), "false");
  assert.match(words(sec), /^Password Anyone with the link can open it\. Ask for a password$/);
  assert.equal(m.box.querySelector("[data-password-beside]"), null);
  // On again: a new one.
  await click(sec.querySelector("[data-password-switch]"));
  assert.deepEqual(calls.filter((c) => c.method === "POST").at(-1).body, { ws: "ws_main", action: "on" });
  assert.match(words(sec), /^Password Hn5wKz8 /);
  for (const t of [words(m.box), "Make a new password? People using the old one will need the new one."]) assert.doesNotMatch(t, NO_DASHES);
  await m.done();
  // An Orgo that can't tell: no section at all.
  const old = await mount(h(P.PasswordSection, { ws: "ws_main", name: "shop", preview: preview({ protected: undefined }) }));
  assert.equal(old.box.innerHTML, "");
  await old.done();
});

await test("no password to show (Orgo keeps only its cookie's check): \"Can't be shown. Make a new one.\" with New password at hand, and Bops' own view still signs in; a key that can't read it says why", async () => {
  fresh();
  routes[ROUTE] = () => ({ body: { ...answer(), password: null } });
  const ready = { current: null };
  const m = await mount(h("div", null, h(P.PasswordSection, { ws: "ws_main", name: "shop", preview: preview() }), h(P.PasswordBeside, { ws: "ws_main", name: "shop", preview: preview() }), h(Tab, { preview: preview(), onRenewed: () => {}, onReady: ready })));
  assert.equal(reads().length, 1);
  assert.equal(words(m.box.querySelector("[data-password-beside]")), "Password Can't be shown. Make a new one.");
  assert.match(words(m.box.querySelector("[data-password-section]")), /^Password Can't be shown\. Make a new one\. New password Ask for a password/);
  assert.equal(button(m.box, "Copy password"), undefined, "nothing to copy");
  assert.deepEqual(signIns, [{ partition: PART, url: URL1, name: "__Host-orgo_pass", value: "v1.Ab3xY9k" }]);
  await m.done();
  fresh();
  const why = "Your Orgo key can't see or change it. Sign in with Orgo again to use one that can.";
  routes[ROUTE] = () => ({ body: { ...answer(), password: null, cookie: null, why } });
  const n = await mount(h(P.PasswordBeside, { ws: "ws_main", name: "shop", preview: preview() }));
  assert.equal(words(n.box), `Password ${why}`);
  await n.again(h(P.PasswordBeside, { ws: "ws_main", name: "shop", preview: preview() }));
  assert.equal(reads().length, 1, "said, never read again in a loop");
  await n.done();
});

await test("a refusal is said under the section; a site's own route is named by `site`", async () => {
  fresh("/api/hosted-apps/shop/password");
  routes[ROUTE] = (url, init) => (init.method === "POST" ? { status: 502, body: { error: "Orgo didn't take that. Try again in a minute." } } : { body: answer() });
  const m = await mount(h(P.PasswordSection, { ws: "ws_main", name: "shop", site: "shop-admin", preview: preview() }));
  assert.equal(reads()[0].url, `${ROUTE}?ws=ws_main&site=shop-admin`);
  await click(m.box.querySelector("[data-password-switch]"));
  assert.deepEqual(calls.at(-1).body, { ws: "ws_main", action: "off", site: "shop-admin" });
  assert.equal(m.box.querySelector('[role="alert"]').textContent, "Orgo didn't take that. Try again in a minute.");
  await m.done();
});


await test("Bops' own preview view: the cookie put in its session through the Mac app once a value (no reload the first time), again with a reload when it changes; ready waits for it", async () => {
  fresh();
  let reloads = 0;
  const ready = { current: null };
  const el = (p) => h(Tab, { preview: p, onRenewed: () => reloads++, onReady: ready });
  const m = await mount(el(preview()));
  assert.deepEqual(signIns, [{ partition: PART, url: URL1, name: "__Host-orgo_pass", value: "v1.Ab3xY9k" }]);
  assert.equal(reloads, 0);
  await act(async () => void (await ready.current()));
  assert.equal(signIns.length, 1, "set already: not again");
  // A deploy went live: the list says a newer one, the cookie is set again and the page loads again with it.
  server.password = "Wd4tNs6";
  server.at += 100;
  await m.again(el(preview()));
  assert.deepEqual(signIns.at(-1), { partition: PART, url: URL1, name: "__Host-orgo_pass", value: "v1.Wd4tNs6" });
  assert.equal(reloads, 1);
  await m.done();
  // Not read yet when Preview is picked: ready reads it and sets it first.
  fresh();
  const n = await mount(el(preview({ passwordAt: server.at + 900 })));
  signIns.length = 0;
  server.password = "Pr9sTx3";
  server.at += 950;
  await act(async () => void (await ready.current()));
  assert.equal(signIns.length, 1);
  await n.done();
  // One that asks for none: nothing set, nothing waited for.
  fresh();
  const o = await mount(el(preview({ protected: false })));
  await act(async () => void (await ready.current()));
  assert.deepEqual(signIns, []);
  await o.done();
});

await test("the tab bar's lock shows the password with Copy; Open in browser says the browser asks for it, copies nothing, and opens only when pressed", async () => {
  fresh();
  const ready = { current: null };
  const m = await mount(h(Tab, { preview: preview(), onRenewed: () => {}, onReady: ready }));
  const lock = m.box.querySelector("[data-preview-lock]");
  assert.ok(lock);
  assert.equal(lock.getAttribute("data-tip"), "Asks for a password");
  await click(lock);
  const pop = m.box.querySelector("[data-preview-pass-popover]");
  assert.equal(pop.getAttribute("data-preview-pass-popover"), "lock");
  assert.equal(words(pop), "This preview asks for a password. Ab3xY9k");
  assert.equal(button(pop, "Open in browser"), undefined);
  await click(lock);
  assert.equal(m.box.querySelector("[data-preview-pass-popover]"), null, "pressed again, it closes");
  await click(m.box.querySelector("[data-browser]"));
  const b = m.box.querySelector("[data-preview-pass-popover]");
  assert.equal(b.getAttribute("data-preview-pass-popover"), "browser");
  assert.equal(words(b), "Your browser asks for this password. Ab3xY9k Open in browser");
  assert.deepEqual(opened, [], "nothing opened yet");
  await click(button(b, "Copy password"));
  assert.deepEqual(copied, ["Ab3xY9k"]);
  await click(button(b, "Open in browser"));
  assert.deepEqual(opened, [[`${URL1}/menu`, "_blank"]]);
  assert.equal(m.box.querySelector("[data-preview-pass-popover]"), null);
  assert.deepEqual(copied, ["Ab3xY9k"], "the clipboard only as Copy wrote it");
  await m.done();
});

const classes = (el) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const placed = (el) => [el, ...el.querySelectorAll("[class]")].filter((x) => classes(x).some((c) => /^(?:@[\w-]+:)?(?:absolute|fixed)$/.test(c)));

await test("on the Preview line in Your Apps: Password, its 7 character value in mono and Copy, one piece where the line says where it is, never cut short; what the line serves a piece of its own after it; nothing placed over anything; while it's read, what's said cut short whole in its tooltip", async () => {
  fresh();
  const E = await import(pathToFileURL(`${root}/components/app/app-envs.tsx`).href);
  const AT = "5e1f0c2".repeat(9).slice(0, 40);
  // (Its Preview as the list says it now: a newer password than the one kept, after fresh(), is read again.)
  const envs = () => {
    const app = { name: "shop", head: AT, updatedAt: base, hosting: { botId: "nova", computerId: "c1" }, serving: null, live: null, preview: preview({ serving: AT, live: { id: "d_1", at: AT, state: "succeeded", when: base, error: null, url: URL1 } }) };
    return h(E.AppEnvs, { compact: true, ws: "ws_main", answer: { enabled: true }, app, sites: [app], local: null, onLocal: () => {}, onChanged: () => {} });
  };
  const m = await mount(envs());
  const line = m.box.querySelector('[data-app-env="preview"]');
  const where = line.querySelector("[data-app-env-where]");
  const beside = line.querySelector("[data-password-beside]");
  const at = line.querySelector("[data-app-env-at]");
  assert.ok(where.contains(beside) && where.querySelector(`a[href="${URL1}"]`), "beside its link, where the line says where it is");
  assert.equal(words(beside), "Password Ab3xY9k");
  const value = beside.querySelector("[data-preview-password]");
  assert.equal(value.textContent.length, 7);
  assert.ok(classes(value).includes("font-mono") && classes(value).includes("whitespace-nowrap") && !classes(value).includes("truncate"), "in mono, never cut short");
  assert.ok(classes(beside).includes("shrink-0") && classes(beside).includes("max-w-full") && !classes(beside).some((c) => /^m[lr]-/.test(c)), "one piece: the line wraps it under the link when they don't fit side by side");
  assert.ok(button(beside, "Copy password"));
  assert.ok(at.parentNode === line && !where.contains(at) && !beside.contains(at) && at.textContent === AT.slice(0, 7) && at.getAttribute("title") === AT, "what it serves, a piece of its own");
  assert.deepEqual(placed(line), [], "nothing placed over anything");
  await m.done();
  // While it's read: what's said instead can be cut short, all of it in its tooltip.
  fresh();
  routes = {};
  const n = await mount(envs());
  const waiting = n.box.querySelector("[data-password-beside]");
  assert.equal(words(waiting), "Password Couldn't read it just now.");
  assert.ok(classes(waiting).includes("min-w-0"));
  const said = waiting.lastElementChild;
  assert.ok(classes(said).includes("min-w-0") && classes(said).includes("truncate") && said.getAttribute("data-tip") === "Couldn't read it just now.");
  await n.done();
});

await test("its tab's Password section wraps New password and the switch, together, under its value in a narrow panel, never squeezing it; the tab bar's tools and widths wrap together under which one it shows", async () => {
  fresh();
  const m = await mount(h(P.PasswordSection, { ws: "ws_main", name: "shop", preview: preview() }));
  const row = m.box.querySelector("[data-password-section]").children[1];
  assert.ok(classes(row).includes("flex-wrap") && classes(row).includes("min-h-8") && !classes(row).includes("h-8"), "a line that wraps");
  const [value, controls] = row.children;
  assert.equal(words(value), "Ab3xY9k");
  assert.ok(classes(value).includes("shrink-0"), "its value never squeezed");
  assert.ok(classes(controls).includes("ml-auto") && controls.querySelector("[data-password-new]") && controls.querySelector("[data-password-switch]"), "New password and the switch together at its end");
  await m.done();
  const tab = readFileSync(`${root}/components/app/preview-tab.tsx`, "utf8");
  assert.match(tab, /<div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-\[#F0F0EE\] px-2\.5 py-1">\n\s*<div role="group" aria-label="Which one to show" data-preview-places/);
  assert.match(tab, /<span data-preview-tools className="ml-auto flex shrink-0 items-center gap-1">\n\s*\{tools && \([^]*aria-label="Width"[^]*<\/div>\n\s*<\/span>\n\s*<\/div>/);
});

await test("where preview-tab.tsx, app-envs.tsx and hosted-apps.tsx put it", async () => {
  const tab = readFileSync(`${root}/components/app/preview-tab.tsx`, "utf8");
  // (In the tab's own session: its site's, and its bot's copy's when it's of one.)
  assert.match(tab, /const partition = previewPartition\(user, ws, name, site, copy\);/);
  assert.match(tab, /const pass = usePreviewTabPassword\(ws, name, site, shown\?\.preview, partition, \(\) => place === "preview" && view\?\.reload\(\)\);/);
  assert.match(tab, /if \(p === "preview"\) await pass\.ready\(\);\n {4}setPicked\(p\);/, "its cookie set before the Preview shows");
  assert.match(tab, /\{place === "preview" && pass\.on && <PreviewLock pass=\{pass\} at=\{at\} \/>\}/);
  assert.match(tab, /onClick=\{\(\) => \(place === "preview" && pass\.on \? pass\.setPopover\("browser"\) : window\.open\(at, "_blank"\)\)\}/);
  const envs = readFileSync(`${root}/components/app/app-envs.tsx`, "utf8");
  assert.match(envs, /<UrlLink url=\{app\.preview\.url\} \/>\n\s*\{\/\*[^*]*\*\/\}\n\s*<PasswordBeside ws=\{ws\} name=\{app\.name\} site=\{site\} preview=\{app\.preview\} \/>/);
  const apps = readFileSync(`${root}/components/app/hosted-apps.tsx`, "utf8");
  assert.match(apps, /<AppAddress url=\{previewSettings\?\.url \?\? view\.preview\?\.url \?\? null\} \/>\n\s*<PasswordSection ws=\{ws\} name=\{app\.name\} site=\{siteName\} preview=\{view\.preview\} \/>/);
});

console.log(`preview password ui: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
