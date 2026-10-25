// Tests for Settings, Where routines run (components/app/runs-on.tsx): Cloud and This Mac, a line each,
// nothing picked until Bops says which (nor when Orgo didn't answer, which it says), the one Orgo keeps picked; an Orgo that can't keep it yet shows
// This Mac with "Cloud isn't available yet." and Cloud can't be picked; in the Cloud, each computer of the
// workspace's bots once (a bot that shares is on its main bot's), with how its runner is: Running, Asleep,
// Setting up, Stopping, Couldn't start and why, or not set up yet; a pick calls back; no dashes anywhere.
// And Settings, Your bots' computers (components/app/bot-computers.tsx), in every mode: under each bot that
// has its own computer, whether that computer holds its own Orgo key (from /api/runs-on/keys: its prefix
// and when it was used, with Manage in Orgo; none says No Orgo key only when its runner counts on one;
// nothing when Orgo couldn't say, as for a 405 or a timeout, or hasn't yet), nothing extra for a bot that
// works on another bot's computer, and none of it under Where routines run; asked of Bops only, never of
// Orgo from the window.
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
const B = await import(pathToFileURL(`${root}/components/app/bot-computers.tsx`).href);
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
  assert.match(t, /^Where routines run Cloud Tasks keep running when your Mac is closed\. This Mac Only while Bops is open on this Mac\.$/, t);
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
  // Stopped, frozen or broken (Orgo's status, /api/runs-on down): never "Running" while its routines run on the Mac.
  const down = text(render({ state: state({ runners }), info: { runsOn: "cloud", missing: false, asleep: [], down: { [C1]: "frozen" } } }));
  assert.match(down, /Boppy's computer Its computer is frozen\. Its routines wait until it's back\./, down);
  assert.ok(!down.includes("Boppy's computer Running"), down);
});

await test("each runner in plain words, never a dash", () => {
  const x = (status, more = {}) => ({ status, version: "1", buildId: "b", by: "d", at: 1, ...more });
  assert.deepEqual(R.runnerNow(undefined, false), { text: "Not set up yet", dot: "bg-[#C9C9C6]" });
  assert.equal(R.runnerNow(x("running"), false).text, "Running");
  assert.equal(R.runnerNow(x("running"), true).text, "Asleep");
  assert.equal(R.runnerNow(x("running"), false, "stopped").text, "Its computer is stopped. Its routines wait until it's back.");
  assert.equal(R.runnerNow(x("running"), false, "error").text, "Its computer is broken. Its routines wait until it's back.");
  assert.equal(R.runnerNow(x("installing"), false, "frozen").text, "Setting up", "only a runner that's up says its computer is down");
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

/* ---------------- Your bots' computers: each computer's own Orgo key ---------------- */

const MANAGE = "https://orgo.test/settings/api-keys";
const running = { status: "running", version: "0.0.30", buildId: "b1", by: "dev_1", at: 1 };
const CLOUD = { runsOn: "cloud", missing: false, asleep: [] };
const ownKey = (more = {}) => ({ keyId: "key_1", prefix: "sk_live_ab12", name: "Computer key for boppy", createdAt: Date.now() - 86_400_000, lastUsed: Date.now() - 2 * 60_000, expiresAt: null, ...more });
const list = (props) => renderToStaticMarkup(h(B.BotComputersList, { padded: true, keys: null, ...props }));

await test("Your bots' computers: has its own Orgo key, with its prefix and when it was used, and Manage in Orgo", () => {
  const html = list({ state: state({ runners: { [C1]: running } }), keys: { keys: { [C1]: ownKey() }, manage: MANAGE } });
  const t = text(html);
  // Max works on Boppy's computer: nothing extra. Ace is another workspace's.
  assert.equal(t, "Your bots' computers Boppy Ready Own Orgo key sk_live_ab12… · used 2m ago Manage in Orgo Max Works on Boppy's computer Iris Ready");
  assert.match(html, /<a href="https:\/\/orgo\.test\/settings\/api-keys" target="_blank" rel="noreferrer"[^>]*>Manage in Orgo<\/a>/, "opens Orgo's Settings, API keys outside the app");
  assert.match(html, /data-tip="Computer key for boppy"/, "its name on hover");
  assert.ok(!DASHES.test(t), t);
  // Never used, used a while ago, just now, expired, and a prefix Orgo didn't give.
  assert.equal(B.keyLine(ownKey({ lastUsed: null }), running), "Own Orgo key sk_live_ab12… · never used");
  assert.equal(B.keyLine(ownKey({ lastUsed: Date.now() - 5_000 }), running), "Own Orgo key sk_live_ab12… · used just now");
  assert.equal(B.keyLine(ownKey({ lastUsed: Date.now() - 3 * 3_600_000 }), running), "Own Orgo key sk_live_ab12… · used 3h ago");
  assert.match(B.keyLine(ownKey({ lastUsed: Date.now() - 3 * 86_400_000 }), running), /^Own Orgo key sk_live_ab12… · used on \w+/);
  assert.equal(B.keyLine(ownKey({ expiresAt: Date.now() - 1 }), running), "Own Orgo key sk_live_ab12… · expired");
  assert.equal(B.keyLine(ownKey({ prefix: "", lastUsed: null }), undefined), "Own Orgo key · never used");
});

await test("in every mode: routines on This Mac, no runner, and bots in browsers on this Mac", () => {
  const keys = { keys: { [C2]: ownKey({ lastUsed: null }) }, manage: MANAGE };
  assert.match(text(list({ state: state(), keys })), /Iris Ready Own Orgo key sk_live_ab12… · never used Manage in Orgo$/);
  assert.match(text(list({ state: state({ host: "mac" }), keys })), /Max Uses this Mac Iris Uses this Mac Own Orgo key sk_live_ab12… · never used Manage in Orgo$/);
  // A main bot on another main bot's free computer works on that one: nothing extra.
  const free = state({ bots: [{ id: "boppy", name: "Boppy", color: "#0A0A0A", isMain: true, computer: "own", computerId: C1, computerStatus: "ready", freeComputer: true }, { id: "kai", name: "Kai", color: "#00AAFF", isMain: true, computer: "shared", computerStatus: "ready", workspaceId: "ws_main" }] });
  assert.equal(text(list({ state: free, keys: { keys: { [C1]: ownKey() }, manage: MANAGE } })), "Your bots' computers Boppy Ready Own Orgo key sk_live_ab12… · used 2m ago Manage in Orgo Kai Works on Boppy's computer");
});

await test("none (404): nothing, or No Orgo key only when that computer's runner counts on one", () => {
  const runners = { [C1]: running, [C2]: { ...running, status: "failed", error: "no server bundle" } };
  const t = text(list({ state: state({ runners }), keys: { keys: { [C1]: null, [C2]: null }, manage: MANAGE } }));
  assert.equal(t, "Your bots' computers Boppy Ready No Orgo key Max Works on Boppy's computer Iris Ready");
  // Not set up, being set up or stopped, or stopped before its key: nothing. Couldn't start for want of it: it says so.
  assert.equal(B.keyLine(null, undefined), null);
  for (const status of ["installing", "stopping"]) assert.equal(B.keyLine(null, { ...running, status }), null, status);
  for (const error of ["it couldn't sign in on its computer", "Orgo didn't give its computer its key"]) assert.equal(B.keyLine(null, { ...running, status: "failed", error }), "No Orgo key", error);
  assert.match(text(list({ state: state({ runners: { [C2]: { ...running, status: "failed", error: "it couldn't sign in on its computer" } } }), keys: { keys: { [C2]: null }, manage: MANAGE } })), /Iris Ready No Orgo key$/);
});

await test("a runner on its computer's Orgo identity: said above the key line while the computer still holds a key, and No Orgo key never shown for it", () => {
  const onIdentity = { ...running, auth: "identity" };
  const t = text(list({ state: state({ runners: { [C1]: onIdentity } }), keys: { keys: { [C1]: ownKey() }, manage: MANAGE } }));
  assert.equal(t, "Your bots' computers Boppy Ready Orgo identity (this computer only) Own Orgo key sk_live_ab12… · used 2m ago Manage in Orgo Max Works on Boppy's computer Iris Ready");
  assert.ok(!DASHES.test(t), t);
  assert.equal(text(list({ state: state({ runners: { [C1]: onIdentity } }), keys: { keys: { [C1]: null }, manage: MANAGE } })), "Your bots' computers Boppy Ready Orgo identity (this computer only) Max Works on Boppy's computer Iris Ready", "no key, and none needed");
  assert.equal(B.keyLine(null, onIdentity), null);
  // On its key, or not up: no identity line.
  assert.ok(!text(list({ state: state({ runners: { [C1]: { ...running, auth: "key" } } }) })).includes("Orgo identity"));
  assert.ok(!text(list({ state: state({ runners: { [C1]: { ...onIdentity, status: "stopping" } } }) })).includes("Orgo identity"));
  assert.equal(B.IDENTITY_LINE, "Orgo identity (this computer only)");
});

await test("Orgo couldn't say (a 405, a timeout, unreachable: left out) or hasn't answered yet: nothing, and the rows as before", () => {
  const runners = { [C1]: running };
  const before = text(list({ state: state({ runners }) }));
  assert.equal(before, "Your bots' computers Boppy Ready Max Works on Boppy's computer Iris Ready");
  assert.equal(before, text(list({ state: state({ runners }), keys: { keys: {}, manage: MANAGE } })));
  assert.equal(B.keyLine(undefined, running), null);
});

await test("one place only: Where routines run says nothing of keys, and the window asks Bops only, never Orgo", () => {
  assert.ok(!/Orgo key/.test(text(render({ state: state({ runners: { [C1]: running } }), info: CLOUD }))));
  assert.ok(!readFileSync(`${root}/components/app/runs-on.tsx`, "utf8").includes("runs-on/keys"));
  const src = readFileSync(`${root}/components/app/bot-computers.tsx`, "utf8");
  const urls = [...src.matchAll(/fetch\(\s*([`"'])([^`"']*)/g)].map((m) => m[2]);
  assert.ok(urls.length >= 1 && urls.every((u) => u.startsWith("/api/runs-on/keys?ids=")), urls.join(" "));
});

console.log(`runs on ui: ${passed} passed`);
