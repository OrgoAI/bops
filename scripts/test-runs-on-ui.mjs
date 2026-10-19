// Tests for Settings, Where routines run (components/app/runs-on.tsx): Cloud and This Mac, a line each,
// nothing picked until Bops says which (nor when Orgo didn't answer, which it says), the one Orgo keeps picked; an Orgo that can't keep it yet shows
// This Mac with "Cloud isn't available yet." and Cloud can't be picked; in the Cloud, each computer of the
// workspace's bots once (a bot that shares is on its main bot's), with how its runner is: Running, Asleep,
// Setting up, Stopping, Couldn't start and why, or not set up yet; a pick calls back; no dashes anywhere.
//
// Nothing reaches a server. The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-runs-on-ui.mjs   (not with --conditions=react-server: these are client components)
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

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const R = await import(pathToFileURL(`${root}/components/app/runs-on.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const DASHES = /[–—]|\s-\s/;
const noop = () => {};

const C1 = "aaaaaaaa-0000-4000-8000-000000000001";
const C2 = "aaaaaaaa-0000-4000-8000-000000000002";
const C3 = "aaaaaaaa-0000-4000-8000-000000000003";
const state = (o = {}) => ({
  host: "orgo",
  workspace: "ws_main",
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 0 }],
  bots: [
    { id: "boppy", name: "Boppy", color: "#0A0A0A", isMain: true, computer: "own", computerId: C1, computerStatus: "ready" },
    { id: "max", name: "Max", color: "#E9FF3B", isMain: false, computerStatus: "none" },
    { id: "iris", name: "Iris", color: "#FF8800", isMain: false, computer: "own", computerId: C2, computerStatus: "ready" },
    { id: "ace", name: "Ace", color: "#00AAFF", isMain: true, computer: "own", computerId: C3, computerStatus: "ready", workspaceId: "ws_acme" },
  ],
  chats: [],
  messages: [],
  sessions: [],
  routines: [],
  ...o,
});
const render = (props) => renderToStaticMarkup(h(R.RunsOnChoice, { busy: false, error: null, onPick: noop, ...props }));
// The cards, in order: whether each is picked (its radio's dot) and whether it can be picked.
const cards = (html) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attrs, inner]) => ({ name: text(inner).split(" ")[0] === "This" ? "This Mac" : text(inner).split(" ")[0], picked: inner.includes("bg-highlighter"), disabled: /\sdisabled=""/.test(attrs) }));

await test("Cloud and This Mac, a line each; nothing picked until Bops says which", () => {
  const html = render({ state: state(), info: null });
  const t = text(html);
  assert.match(t, /^Where routines run Cloud Keeps working when your Mac is closed\. This Mac Only while Bops is open on this Mac\.$/, t);
  assert.deepEqual(cards(html), [
    { name: "Cloud", picked: false, disabled: true },
    { name: "This Mac", picked: false, disabled: true },
  ]);
  assert.ok(!DASHES.test(t), t);
});

await test("in the Cloud: Cloud picked, and each computer of the workspace's bots once, with its runner", () => {
  const now = Date.now();
  const runners = {
    [C1]: { status: "running", version: "0.0.30", buildId: "b1", by: "dev_1", at: now },
    [C2]: { status: "failed", version: "0.0.30", buildId: "b1", by: "dev_1", error: "no server bundle", at: now },
    [C3]: { status: "running", version: "0.0.30", buildId: "b1", by: "dev_1", at: now },
  };
  const html = render({ state: state({ runners }), info: { runsOn: "cloud", missing: false, asleep: [] } });
  assert.deepEqual(cards(html), [
    { name: "Cloud", picked: true, disabled: false },
    { name: "This Mac", picked: false, disabled: false },
  ]);
  const t = text(html);
  // Max shares Boppy's computer: one row for it. Ace's is another workspace's.
  assert.match(t, /Boppy's computer Running Iris's computer Couldn't start: no server bundle$/, t);
  assert.ok(!t.includes("Max's computer") && !t.includes("Ace"), t);
  assert.ok(!DASHES.test(t), t);
  // Asleep, till a routine wakes it.
  assert.match(text(render({ state: state({ runners }), info: { runsOn: "cloud", missing: false, asleep: [C1] } })), /Boppy's computer Asleep/);
});

await test("each runner in plain words, never a dash", () => {
  const x = (status, more = {}) => ({ status, version: "1", buildId: "b", by: "d", at: 1, ...more });
  assert.deepEqual(R.runnerNow(undefined, false), { text: "Not set up yet", dot: "bg-[#C9C9C6]" });
  assert.equal(R.runnerNow(x("running"), false).text, "Running");
  assert.equal(R.runnerNow(x("running"), true).text, "Asleep");
  assert.equal(R.runnerNow(x("installing"), false).text, "Setting up");
  assert.equal(R.runnerNow(x("stopping"), false).text, "Stopping");
  assert.equal(R.runnerNow(x("failed"), false).text, "Couldn't start");
  const why = R.runnerNow(x("failed", { error: "someone else has Full access — so it stays on the Mac" }), false).text;
  assert.equal(why, "Couldn't start: someone else has Full access, so it stays on the Mac");
  assert.ok(!DASHES.test(why), why);
  // In the Cloud with none set up yet: it says so.
  assert.match(text(render({ state: state(), info: { runsOn: "cloud", missing: false, asleep: [] } })), /Boppy's computer Not set up yet Iris's computer Not set up yet$/);
});

await test("on This Mac: This Mac picked; no computers, but a runner still being stopped shows", () => {
  const html = render({ state: state(), info: { runsOn: "mac", missing: false, asleep: [] } });
  assert.deepEqual(
    cards(html).map((c) => c.picked),
    [false, true],
  );
  assert.ok(!text(html).includes("computer"), text(html));
  const stopping = text(render({ state: state({ runners: { [C2]: { status: "stopping", version: "1", buildId: "b", by: "d", at: Date.now() } } }), info: { runsOn: "mac", missing: false, asleep: [] } }));
  assert.match(stopping, /This Mac Only while Bops is open on this Mac\. Iris's computer Stopping$/, stopping);
});

await test("an Orgo that can't keep it yet: This Mac, Cloud can't be picked, and it says so", () => {
  const html = render({ state: state(), info: { runsOn: "mac", missing: true, asleep: [] } });
  assert.deepEqual(cards(html), [
    { name: "Cloud", picked: false, disabled: true },
    { name: "This Mac", picked: true, disabled: false },
  ]);
  const t = text(html);
  assert.ok(t.endsWith("Cloud isn't available yet."), t);
  assert.ok(!t.includes("computer"), "no runners to show");
});

await test("Orgo didn't answer: neither picked (never This Mac by default), and it says so", () => {
  const runners = { [C1]: { status: "running", version: "0.0.30", buildId: "b1", by: "dev_1", at: Date.now() } };
  const html = render({ state: state({ runners }), info: { runsOn: null, missing: false, asleep: [] } });
  assert.deepEqual(cards(html), [
    { name: "Cloud", picked: false, disabled: false },
    { name: "This Mac", picked: false, disabled: false },
  ]);
  const t = text(html);
  assert.match(t, /on this Mac\. Couldn't reach Orgo\. Try again\. Boppy's computer Running$/, t);
  assert.ok(!DASHES.test(t), t);
});

await test("busy: neither can be picked; an error shows under the cards", () => {
  const html = render({ state: state(), info: { runsOn: "cloud", missing: false, asleep: [] }, busy: true, error: "Couldn't reach Orgo. Try again in a moment." });
  assert.ok(cards(html).every((c) => c.disabled));
  assert.match(text(html), /on this Mac\. Couldn't reach Orgo\. Try again in a moment\. Boppy's computer/);
});

await test("a pick calls back with the card's choice (React's click, from the element tree)", () => {
  const picked = [];
  const el = R.RunsOnChoice({ state: state(), info: { runsOn: "cloud", missing: false, asleep: [] }, busy: false, error: null, onPick: (to) => picked.push(to) });
  const find = (n, out = []) => {
    if (!n || typeof n !== "object") return out;
    if (Array.isArray(n)) n.forEach((c) => find(c, out));
    else {
      if (n.type === "button") out.push(n);
      find(n.props?.children, out);
    }
    return out;
  };
  const [cloud, mac] = find(el);
  cloud.props.onClick();
  mac.props.onClick();
  assert.deepEqual(picked, ["mac"], "the one picked already does nothing");
});

console.log(`runs on ui: ${passed} passed`);
