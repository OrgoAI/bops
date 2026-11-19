// Tests for what the owner's Mac follows when a bot's name, call voice or place to work changed on another Bops (Bops
// Cloud, for a teammate in a workspace where everything goes through the cloud: cloud/change-apply.ts), as the owner's
// own route follows its own change (lib/server/bot-follow.ts): a new name its email, phone agents, channels and desktop,
// a new call voice its phone agents' voice, a new place to work Orgo's copy of its routines. Seeded the first time
// (nothing follows); a change that came in, or that was made while this Mac was closed (kept beside the user's state on
// this Mac), follows once; one made through this Mac's own route (change-acts.ts doChange calls it) never follows again;
// a new bot is no change; nothing on a computer's runner.
//
// The state is a throwaway file store in a temporary folder (BOPS_SELF_HOSTED), every other address a fake that answers
// nothing useful, and modules that would start processes are stand-ins: nothing reaches a real service. What follows is
// recorded, not done. The people and bots are made up.
// Usage: node --conditions=react-server scripts/test-bot-follow.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    // Each call is recorded (globalThis.__standIns: [module, export, the first argument's id]), so a test can see the desktop dressed or not.
    return {
      format: "module",
      shortCircuit: true,
      source: names.map((n) => `export const ${n} = function (...a) { (globalThis.__standIns ??= []).push([${JSON.stringify(name)}, ${JSON.stringify(n)}, a[0]?.id]); return Promise.resolve(); };`).join("\n"),
    };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-bot-follow-"));
process.chdir(scratch);
process.env.HOME = scratch;
globalThis.bopsOrgoKey = "sk_test_bot_follow";
globalThis.fetch = async () => new Response(JSON.stringify({ error: "Not here" }), { status: 404, headers: { "content-type": "application/json" } });

const S = await import(`${root}/lib/server/store.ts`);
const F = await import(`${root}/lib/server/bot-follow.ts`);
const CA = await import(`${root}/lib/server/change-acts.ts`);
const { userDataDir } = await import(`${root}/lib/server/user-paths.ts`);

let passed = 0;
let failed = 0;
const test = async (name, f) => {
  try {
    await f();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}\n  ${e.stack?.split("\n").slice(1, 3).join("\n  ")}`);
  }
};
const later = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const WS = "ws_acme";
const OURS = ["nova", "max", "ivy"];
const file = () => join(userDataDir(S.stateUser() || null), "bot-fields.json");

/** What followed, in order: [what, botId]. */
const done = [];
const effects = { rename: (b) => done.push(["name", b.id, b.name]), voice: (id) => done.push(["voice", id]), runsOn: (id) => done.push(["runsOn", id]) };
/** This Mac (as the Mac app is) with nothing followed in memory; `fresh`: and nothing kept on it either. */
const mac = (fresh = false) => {
  if (fresh) rmSync(file(), { force: true });
  F.resetBotFollow({ effects, here: () => true });
  done.length = 0;
};
/** The owner's bots: Nova, Acme's chief; Max on his own computer; Ivy with a voice of her own on calls. */
const load = () =>
  S.update((s) => {
    s.workspaces = [{ id: "ws_main", name: "Main", createdAt: 0 }, { id: WS, name: "Acme", createdAt: 1, botSettings: { ivy: { callVoice: "sage" } } }];
    s.bots = [
      ...s.bots.filter((b) => !OURS.includes(b.id)),
      { id: "nova", name: "Nova", role: "Chief", color: "#000", isMain: true, workspaceId: WS, computerStatus: "none" },
      { id: "max", name: "Max", role: "Ops", color: "#000", isMain: false, workspaceId: WS, computerId: "c-max", computerStatus: "none", runsOn: "cloud" },
      { id: "ivy", name: "Ivy", role: "Calls", color: "#000", isMain: false, workspaceId: WS, computerStatus: "none" },
    ];
  });
/** A change from another Bops, merged in as persist-cloud.ts does (straight into the state), then heard (store.ts arrival watchers). */
const arrives = (f) => {
  f(S.getState());
  F.followBotFields();
};
const botIn = (id) => S.getState().bots.find((b) => b.id === id);
const acme = () => S.getState().workspaces.find((w) => w.id === WS);

await test("the first time, it's only noted (seeded) and kept on this Mac: nothing follows", () => {
  mac(true);
  load();
  F.followBotFields();
  assert.deepEqual(done, []);
  assert.ok(existsSync(file()), "kept beside the user's state");
  assert.equal(JSON.parse(readFileSync(file(), "utf8")).max.name, "Max");
  F.followBotFields();
  assert.deepEqual(done, [], "nothing changed: nothing follows");
});

await test("a new name, call voice or place to work that came in follows once, each as the route follows it (a name sets the voice too)", () => {
  mac(true);
  load();
  F.followBotFields();
  arrives((s) => (s.bots.find((b) => b.id === "max").name = "Maxine"));
  assert.deepEqual(done, [["name", "max", "Maxine"]]);
  F.followBotFields();
  assert.deepEqual(done.length, 1, "once");
  done.length = 0;
  arrives(() => (acme().botSettings.ivy.callVoice = "coral"));
  assert.deepEqual(done, [["voice", "ivy"]]);
  done.length = 0;
  arrives((s) => (s.bots.find((b) => b.id === "max").runsOn = "auto"));
  assert.deepEqual(done, [["runsOn", "max"]]);
  done.length = 0;
  // A new name and a new voice at once: the name's follow sets the voice (phone.ts renameAgents), so only it.
  arrives((s) => {
    s.bots.find((b) => b.id === "ivy").name = "Ivy Two";
    acme().botSettings.ivy.callVoice = "ash";
  });
  assert.deepEqual(done, [["name", "ivy", "Ivy Two"]]);
  done.length = 0;
  // A voice back to the one picked for its name (none set): a change too.
  arrives(() => delete acme().botSettings.ivy.callVoice);
  assert.deepEqual(done, [["voice", "ivy"]]);
});

await test("a change made while this Mac was closed follows as the state loads; a new bot, or one gone, is no change", async () => {
  mac(true);
  load();
  F.followBotFields();
  // Closed: memory goes. Bops Cloud renamed Max meanwhile, and the state loads with it.
  mac();
  load();
  S.update((s) => {
    s.bots.find((b) => b.id === "max").name = "Max Ops";
    s.bots.push({ id: "rex", name: "Rex", role: "New", color: "#000", isMain: false, workspaceId: WS, computerStatus: "none" });
  });
  // As it loads (store.ts watchLoads runs it soon after; startBotFollow watches for it).
  F.startBotFollow();
  await later();
  assert.deepEqual(done, [["name", "max", "Max Ops"]], "Rex's making did what it needs");
  done.length = 0;
  arrives((s) => (s.bots = s.bots.filter((b) => b.id !== "rex")));
  assert.deepEqual(done, []);
  S.update((s) => (s.bots = s.bots.filter((b) => b.id !== "rex")));
});

await test("a change through this Mac's own route follows there, never again as one that came in", async () => {
  mac(true);
  load();
  F.followBotFields();
  // change-acts.ts doChange calls the owner's own route (app/api/bots/route.ts PATCH), as for a teammate's change the Mac does.
  await CA.doChange(WS, { method: "PATCH", path: "/api/bots", body: { botId: "max", name: "Max Here", callVoice: "verse", runsOn: "auto" } }, { userId: "u_sam", name: "Sam" }, "k-route-1");
  await later();
  assert.equal(botIn("max").name, "Max Here", "the route did it");
  F.followBotFields();
  assert.deepEqual(done, [], "followed there already");
  // Kept on this Mac too: closed and opened again, still nothing.
  mac();
  F.followBotFields();
  assert.deepEqual(done, []);
});

await test("nothing on a computer's runner (or a server): never noted, nothing follows", () => {
  mac(true);
  F.resetBotFollow({ effects, here: () => false });
  load();
  F.followBotFields();
  arrives((s) => (s.bots.find((b) => b.id === "max").name = "Runner Max"));
  F.followedHere("max");
  assert.deepEqual(done, []);
  assert.equal(existsSync(file()), false);
});

await test("a new name dresses its bot's desktop from this Mac, unless Bops Cloud dresses the workspace's desktops (cloudDoes.desktop): then its computer does", async () => {
  mac(true);
  load();
  F.followBotFields();
  const dressed = () => (globalThis.__standIns ?? []).filter(([m, n]) => m === "desktop" && n === "applyDesktop").map(([, , id]) => id);
  globalThis.__standIns = [];
  // Through the owner's own route (app/api/bots/route.ts PATCH, as a teammate's change the Mac does): Max has a computer.
  await CA.doChange(WS, { method: "PATCH", path: "/api/bots", body: { botId: "max", name: "Max Desk" } }, { userId: "u_sam", name: "Sam" }, "k-desk-1");
  await later();
  assert.deepEqual(dressed(), ["max"], "no mirror: as before");
  globalThis.__standIns = [];
  acme().cloudDoes = { desktop: true };
  await CA.doChange(WS, { method: "PATCH", path: "/api/bots", body: { botId: "max", name: "Max Cloud" } }, { userId: "u_sam", name: "Sam" }, "k-desk-2");
  await later();
  assert.equal(botIn("max").name, "Max Cloud", "renamed all the same");
  assert.deepEqual(dressed(), [], "its computer dresses it");
  // Followed as a change that came in (Bops Cloud's for a teammate), with the real follow: the same.
  F.resetBotFollow({ here: () => true });
  F.followBotFields();
  arrives((s) => (s.bots.find((b) => b.id === "max").name = "Max Follows"));
  await later();
  assert.deepEqual(dressed(), [], "nor as one that came in");
  // Another part of cloudDoes is no part of it.
  acme().cloudDoes = { texts: true, routines: true };
  arrives((s) => (s.bots.find((b) => b.id === "max").name = "Max Again"));
  await later();
  assert.deepEqual(dressed(), ["max"]);
  delete acme().cloudDoes;
  globalThis.__standIns = [];
});

await test("fieldChanges: by bot, a field at a time; a bot new or gone isn't one", () => {
  const was = { max: { name: "Max", callVoice: null, runsOn: "cloud" }, ivy: { name: "Ivy", callVoice: "sage", runsOn: null } };
  assert.deepEqual(F.fieldChanges(was, was), []);
  assert.deepEqual(F.fieldChanges(was, { max: { name: "Max", callVoice: "ash", runsOn: "auto" }, rex: { name: "Rex", callVoice: null, runsOn: null } }), [{ botId: "max", name: false, callVoice: true, runsOn: true }]);
});

console.log(`\nbot follow: ${passed} passed, ${failed} failed`);
await later(200);
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
