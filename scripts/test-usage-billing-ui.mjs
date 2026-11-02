// Tests for what the account sheet's Your plan shows (components/app/account.tsx PlanAndCredit) for each way of
// paying for Bops (lib/bops-billing.ts): billed by use (the Orgo balance, Add credit on Orgo, one card, no
// Bops plan), given a month more of a plan (that plan's credit, the day it ends, then what they'll pay), and
// Bops' own plans while orgo-web still bills by them; never Free for an answer that didn't say. Every word
// plain: no dashes, never Orbit.
//
// Rendered into a DOM (linkedom) against a fake GET /api/account: nothing reaches a server. The .tsx files are
// compiled with the TypeScript in node_modules as they load. The people and amounts are made up.
// Usage: node scripts/test-usage-billing-ui.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

process.env.NEXT_PUBLIC_BOPS_BRAINS = "1";
// A path, not a URL's: a checkout under a folder with a space in its name works too.
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

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollIntoView = () => {};
win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", clipboard: { writeText: async () => {} } } });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.EventSource = class {
  close() {}
};

/** GET /api/account, as each test sets it. */
let account = null;
const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("/api/account/credit")) return json({ off: true });
  if (u.startsWith("/api/account")) return json(structuredClone(account));
  return json({}, 404);
};
const opened = [];
globalThis.open = (url) => void opened.push(url);

const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PlanAndCredit } = await import(pathToFileURL(`${root}/components/app/account.tsx`).href);

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const words = (box) => [box.textContent, ...[...box.querySelectorAll("[aria-label],[data-tip],[title]")].flatMap((e) => ["aria-label", "data-tip", "title"].map((a) => e.getAttribute(a)))].filter(Boolean).join("\n");
async function show(info) {
  account = info;
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(h(PlanAndCredit, { state: { account: { user: { id: "u_ava", email: "ava@fernway.example" } }, bots: [], workspaces: [] } }));
    await settle();
  });
  const text = words(box);
  assert.doesNotMatch(text, /[\u2013\u2014]|Orbit/, "no dashes, never Orbit");
  return {
    box,
    text,
    done: async () => {
      await act(async () => r.unmount());
      box.remove();
    },
  };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true, cancelable: true }));
    await settle();
  });
const button = (box, label) => [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const base = { user: { id: "u_ava", email: "ava@fernway.example" }, orgo: { status: "ok" }, links: { billing: "https://orgo.test/account?tab=plan", usage: "https://orgo.test/account?tab=usage" }, reach: [] };
const usage = (over = {}) => ({ balanceCents: 412, computer: { size: "Large", hourlyCents: 11, asleepFree: true }, numberMonthlyCents: 300, topUpUrl: "https://orgo.test/settings/billing", ...over });

await test("billed by use: the Orgo balance, Add credit on Orgo, and one card in plain words; no Bops plan to buy", async () => {
  const m = await show({ ...base, bops: { billing: "usage", tier: null, name: "Pay as you go", priceCents: 0, usage: usage() } });
  assert.match(m.text, /\$4\.12/);
  assert.match(m.text, /Orgo credit left/);
  assert.match(m.text, /Pay only for what you use/);
  assert.match(m.text, /Your computer: \$0\.11 an hour while it works, free while it sleeps/);
  assert.match(m.text, /AI at Orgo's rate/);
  assert.match(m.text, /New Orgo accounts start with \$5 of credit/);
  assert.match(m.text, /A phone number for \$3 a month/);
  assert.doesNotMatch(m.text, /\bPro\b|\bMax\b|Upgrade|AI credit|10 hours/);
  assert.equal(button(m.box, "Upgrade to Pro"), undefined);
  await click(button(m.box, "Add credit on Orgo"));
  assert.deepEqual(opened, ["https://orgo.test/settings/billing"], "Orgo's own top up, in the browser");
  await m.done();
});

await test("billed by use with too little to wake the computer: it says the computer stays asleep", async () => {
  const m = await show({ ...base, bops: { billing: "usage", tier: null, name: "Pay as you go", priceCents: 0, usage: usage({ balanceCents: 7 }) } });
  assert.match(m.text, /You're out of Orgo credit, so your bots are paused and your computer stays asleep\. Add credit to keep them going\./);
  await m.done();
});

await test("billed by use with no answer from orgo-web: Bops Cloud's word stands, the card shows, no balance made up, never Free", async () => {
  const m = await show({ ...base, bops: null, billing: "usage" });
  assert.match(m.text, /Pay only for what you use/);
  assert.doesNotMatch(m.text, /Orgo credit left|Free|\bPro\b/);
  await m.done();
});

await test("a month more of Pro: that plan's credit, the day it ends in plain words, what comes after, and no upgrades", async () => {
  const ends = Date.parse("2026-12-03T17:00:00Z");
  const m = await show({
    ...base,
    bops: { billing: "plan", tier: "pro_bops", name: "Pro", priceCents: 2000, status: "active", cancelAtPeriodEnd: true, periodEnd: Date.parse("2026-11-20T00:00:00Z"), extensionEndsAt: ends, credit: { leftMicros: 12_000_000, planLeftMicros: 12_000_000, freeLeftMicros: 0 } },
  });
  assert.match(m.text, /Pro\. Your current plan stays as it is until Dec 3, then you pay only for what you use\./);
  assert.match(m.text, /\$12 of \$20 left/, "the plan's monthly credit from the plan table");
  assert.match(m.text, /From Dec 3/);
  assert.match(m.text, /Pay only for what you use/);
  assert.doesNotMatch(m.text, /Upgrade|Manage plan|Ends Nov/, "nothing renews or is bought meanwhile");
  await m.done();
});

await test("Bops' own plans while orgo-web still bills by them: the three cards, the user's marked; none marked when Orgo didn't say", async () => {
  let m = await show({ ...base, bops: { billing: "plan", tier: "pro_bops", name: "Pro", priceCents: 2000, status: "active", credit: { leftMicros: 1, planLeftMicros: 1, freeLeftMicros: 0 } } });
  assert.match(m.text, /Free.*Pro.*Max/s);
  assert.ok(button(m.box, "Manage plan"));
  assert.ok(button(m.box, "Upgrade to Max"));
  assert.doesNotMatch(m.text, /Pay only for what you use/);
  await m.done();
  m = await show({ ...base, bops: null });
  assert.equal(m.text.match(/Current/g), null, "no plan marked, never Free");
  await m.done();
});

console.log(`usage billing ui: ${passed} passed`);
process.exit(0);
