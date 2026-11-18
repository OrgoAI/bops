// Parity between a teammate's "change" act as Bops Cloud does it itself in a workspace where everything goes through
// the cloud (cloud/change-apply.ts applyChange) and as the owner's Mac does it (lib/server/change-acts.ts doChange, which
// calls the owner's own routes in this process: app/api/bots/route.ts and app/api/workspaces/route.ts PATCH), on the same
// state: a bot's effort, Just do it, business data, an app account's access, Replies to others (its "Send an email" rule
// and Never), its voice on calls, answering calls, a sequence, its name (trimmed, 40 at most, another bot's of the
// workspace refused, its own again fine), where it works ("cloud", "auto"); the workspace's org chart, and a computer's
// name, or one app's group on it, by the key a member's window sends (SharedGroup.key). Kept by its key
// (Workspace.changesDone: the same key again changes nothing) and said in the owner's chat as theirs, in the same words.
// Refused alike: a bot of another workspace, a field the route doesn't list. Refused by Bops Cloud alone (409
// cloud_not_yet), as it doesn't do them yet: a bot set to the owner's Mac (every bot here works on its own computer), a
// bot's own computer and email, which site a bot works on, and the main workspace's rename while its Orgo project is
// still "bops".
//
// Not compared: what the routes also start on the Mac (a rename's inbox, phone agents, channels and desktop, the voice
// on its line, Orgo's copy of its routines), which the cloud leaves to the owner's Mac (it follows them as the change
// comes in or as it opens: lib/server/bot-follow.ts, scripts/test-bot-follow.mjs; with it closed, the cloud's line says
// so, checked here); and a workspace's rename and where its chat is answered, which go through orgo-web and Bops
// Cloud's switch (cloud/members.ts asks those itself).
//
// The state is a throwaway file store in a temporary folder (BOPS_SELF_HOSTED), every other address a fake that answers
// nothing useful, and modules that would start processes are stand-ins: nothing reaches a real service. The people and
// bots are made up.
// Usage: node --conditions=react-server scripts/test-cloud-change-apply.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-change-apply-"));
process.chdir(scratch);
process.env.HOME = scratch;
globalThis.bopsOrgoKey = "sk_test_change_apply";
// Nothing the routes start on the side (a rename's inbox, a line's voice, Orgo's routines) reaches anything.
globalThis.fetch = async () => new Response(JSON.stringify({ error: "Not here" }), { status: 404, headers: { "content-type": "application/json" } });

const S = await import(`${root}/lib/server/store.ts`);
const CA = await import(`${root}/lib/server/change-acts.ts`);
const A = await import(`${root}/cloud/change-apply.ts`);
const { groupKeyOf } = await import(`${root}/cloud/group-key.ts`);
const { THIS_WS } = await import(`${root}/cloud/change-routes.ts`);

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
const clone = (v) => structuredClone(v);
/** As the state is kept and synced: JSON (a field set to undefined in memory is no field). */
const asSaved = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const WS = "ws_acme";
const SAM = { userId: "u_sam", name: "Sam" };

/** The owner's state: Acme, whose chief is Nova; Max on his own computer working on demo-app, Ivy on hers; Zed in another workspace. */
const fixture = () => ({
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 0, orgoName: "bops" },
    {
      id: WS,
      name: "Acme",
      createdAt: 1,
      orgoProjectId: "p-acme",
      memberAccess: { "sam@example.com": { others: "none", bots: { max: "write" } } },
      hostedApps: { "demo-app": { botId: "max", computerId: "c-max" } },
      botSites: { max: { app: "demo-app", site: "demo-app" } },
      botSettings: { ivy: { answersCalls: false } },
    },
  ],
  bots: [
    { id: "nova", name: "Nova", isMain: true, workspaceId: WS, computerId: "c-nova" },
    { id: "max", name: "Max", workspaceId: WS, computerId: "c-max", autoApprove: true, permissions: [{ action: "Call Stripe", resource: "*", effect: "allow" }] },
    { id: "ivy", name: "Ivy", workspaceId: WS, computerId: "c-ivy" },
    { id: "zed", name: "Zed", workspaceId: "ws_main" },
  ],
});
const OURS = ["nova", "max", "ivy", "zed"];

/** The fixture loaded on the owner's Mac, the change done there as change-acts.ts does it, and what it kept and said. */
async function onMac(fx, call, key) {
  S.update((s) => {
    s.workspaces = clone(fx.workspaces);
    s.bots = [...s.bots.filter((b) => !OURS.includes(b.id)), ...clone(fx.bots)];
    s.messages = [];
  });
  await CA.doChange(WS, call, SAM, key);
  await later();
  const st = clone(S.getState());
  return { state: st, done: st.workspaces.find((w) => w.id === WS)?.changesDone?.find((d) => d.key === key), said: st.messages.filter((m) => m.role === "system") };
}
/** The same change by Bops Cloud: the state, the note, or why not. */
function inCloud(fx, call, key, o) {
  try {
    const r = A.applyChange(clone(fx), WS, call, SAM, key, Date.now(), o);
    return r ? { state: r.blob, said: r.said } : { same: true };
  } catch (e) {
    return { refused: { status: e.status, message: e.message, code: e.extra?.code } };
  }
}
const bot = (st, id) => st.bots.find((b) => b.id === id);
const ws = (st) => st.workspaces.find((w) => w.id === WS);
const BOT_FIELDS = ["name", "effort", "runsOn", "autoApprove", "dataOff", "access", "permissions"];
const botOf = (st, id) => asSaved(Object.fromEntries(BOT_FIELDS.map((k) => [k, bot(st, id)?.[k]])));
const settingsOf = (st, id) => asSaved(ws(st)?.botSettings?.[id]);
const doneOf = (d) => d && { key: d.key, by: d.by, ok: d.ok, ...(d.error ? { error: d.error } : {}) };
const botCall = (body) => ({ method: "PATCH", path: "/api/bots", body: { botId: "max", ...body } });
const wsCall = (body) => ({ method: "PATCH", path: "/api/workspaces", body: { id: THIS_WS, ...body } });

/** Both sides on one change: the same bot, its settings, the result kept and the note said. */
async function bothBot(body, key, id = "max", fx = fixture()) {
  const mac = await onMac(fx, botCall(body), key);
  const cloud = inCloud(fx, botCall(body), key);
  assert.ok(cloud.state, `${key}: the cloud did it (${JSON.stringify(cloud.refused)})`);
  assert.deepEqual(botOf(cloud.state, id), botOf(mac.state, id), `${key}: the bot`);
  assert.deepEqual(settingsOf(cloud.state, id), settingsOf(mac.state, id), `${key}: its settings`);
  assert.deepEqual(doneOf(ws(cloud.state).changesDone.find((d) => d.key === key)), doneOf(mac.done), `${key}: kept by its key`);
  assert.equal(cloud.said?.text, mac.said.at(-1)?.text, `${key}: said as theirs`);
  assert.equal(cloud.said?.chatId, mac.said.at(-1)?.chatId, `${key}: in the bot's chat`);
  return { mac, cloud };
}

await test("a bot's settings: effort, Just do it, business data, an app account's access, where it works, on both", async () => {
  const { mac } = await bothBot({ effort: "high" }, "k-effort");
  assert.deepEqual([bot(mac.state, "max").effort, mac.done.ok, mac.said.at(-1).text], ["high", true, "Sam changed Max's settings"], "the Mac did it, and said so");
  await bothBot({ effort: "nonsense" }, "k-effort-x");
  await bothBot({ autoApprove: false }, "k-auto-off");
  await bothBot({ autoApprove: true, dataOff: true }, "k-auto-on");
  await bothBot({ dataOff: false }, "k-data-off");
  await bothBot({ access: { account: "gmail-work", level: "read" } }, "k-access-1");
  await bothBot({ access: { account: "gmail-work", level: null } }, "k-access-2");
  await bothBot({ runsOn: "cloud" }, "k-runs-cloud");
  await bothBot({ runsOn: "auto" }, "k-runs-auto");
});

await test("Replies to others, its voice on calls, answering calls and a sequence: the bot's rules and its settings on the workspace, on both", async () => {
  for (const [key, othersMail] of [
    ["k-mail-never", "never"],
    ["k-mail-ask", "ask"],
    ["k-mail-allow", "allow"],
  ]) {
    const { cloud } = await bothBot({ othersMail }, key);
    assert.equal(settingsOf(cloud.state, "max")?.mailNever, othersMail === "never" ? true : undefined, key);
    assert.deepEqual(bot(cloud.state, "max").permissions.at(-1), { action: "Send an email", resource: "*", effect: othersMail === "allow" ? "allow" : "ask" }, key);
  }
  await bothBot({ callVoice: "ash" }, "k-voice");
  await bothBot({ callVoice: null }, "k-voice-null");
  await bothBot({ answersCalls: false }, "k-calls-off");
  await bothBot({ answersCalls: true }, "k-calls-on", "ivy", fixture());
  await bothBot({ sequence: { id: "othersMail", on: false } }, "k-seq-off");
  // The last of a bot's settings gone: none kept for it, on both.
  const fx = fixture();
  ws(fx).botSettings.max = { sequencesOff: { othersCalls: true } };
  await bothBot({ sequence: { id: "othersCalls", on: true } }, "k-seq-on", "max", fx);
});

await test("a bot's name: trimmed, 40 at most, its own again fine; another bot's of the workspace refused, on both", async () => {
  await bothBot({ name: "  Maxine  " }, "k-name-1");
  await bothBot({ name: "M".repeat(55) }, "k-name-2");
  await bothBot({ name: "Max" }, "k-name-3");
  for (const [key, name] of [
    ["k-name-dup", "ivy"],
    ["k-name-empty", "   "],
  ]) {
    const mac = await onMac(fixture(), botCall({ name }), key);
    const cloud = inCloud(fixture(), botCall({ name }), key);
    assert.deepEqual([mac.done?.ok, cloud.refused?.status], [false, 400], key);
    assert.equal(cloud.refused.message, mac.done.error, `${key}: the route's own words`);
    assert.equal(botOf(mac.state, "max").name, "Max");
  }
  // Another workspace's bot may have the name.
  await bothBot({ name: "Zed" }, "k-name-zed");
});

await test("the org chart: kept as cleanChain keeps it, stamped, on both", async () => {
  const chain = { sideways: "closed", bots: { max: { lead: "ivy" }, ivy: { lead: "max" }, zed: { lead: "max" }, nova: { lead: "max" } } };
  const mac = await onMac(fixture(), wsCall({ chain }), "k-chain");
  const cloud = inCloud(fixture(), wsCall({ chain }), "k-chain");
  const unstamped = (c) => asSaved({ ...c, at: 0 });
  assert.deepEqual(unstamped(ws(cloud.state).chain), unstamped(ws(mac.state).chain));
  assert.equal(typeof ws(cloud.state).chain.at, "number");
  assert.deepEqual(doneOf(ws(cloud.state).changesDone[0]), doneOf(mac.done));
  assert.equal(cloud.said.text, mac.said.at(-1).text, "said in the chief's chat");
  assert.equal(cloud.said.chatId, mac.said.at(-1).chatId);
});

await test("a computer's name, and one app's group on it, by the key a member's window sends, on both; a computer none of its bots work on refused", async () => {
  for (const [key, nameKey, name] of [
    ["k-comp-1", "c-max", "Front desk"],
    ["k-comp-2", "c-max/demo-app", "  Shop   team "],
    ["k-comp-3", "c-ivy", ""],
  ]) {
    const body = { computerName: { computer: groupKeyOf(WS, nameKey), name } };
    const mac = await onMac(fixture(), wsCall(body), key);
    const cloud = inCloud(fixture(), wsCall(body), key);
    assert.ok(cloud.state, `${key}: ${JSON.stringify(cloud.refused)}`);
    assert.deepEqual(asSaved(ws(cloud.state).computerNames), asSaved(ws(mac.state).computerNames), key);
    assert.deepEqual(doneOf(ws(cloud.state).changesDone[0]), doneOf(mac.done), key);
    assert.equal(cloud.said.text, mac.said.at(-1).text, key);
  }
  // A name kept goes back to the default with an empty one.
  const fx = fixture();
  ws(fx).computerNames = { "c-max": "Front desk" };
  const mac = await onMac(fx, wsCall({ computerName: { computer: groupKeyOf(WS, "c-max"), name: "" } }), "k-comp-4");
  const cloud = inCloud(fx, wsCall({ computerName: { computer: groupKeyOf(WS, "c-max"), name: "" } }), "k-comp-4");
  assert.deepEqual([asSaved(ws(cloud.state).computerNames), asSaved(ws(mac.state).computerNames)], [undefined, undefined]);
  const body = { computerName: { computer: groupKeyOf(WS, "c-zed"), name: "Nope" } };
  const no = await onMac(fixture(), wsCall(body), "k-comp-no");
  const refused = inCloud(fixture(), wsCall(body), "k-comp-no");
  assert.deepEqual([no.done.ok, refused.refused.status, refused.refused.message], [false, 404, no.done.error]);
});

await test("refused alike: a bot of another workspace, a field the route doesn't list, a workspace that isn't this one", async () => {
  for (const [key, call] of [
    ["k-other-ws", { method: "PATCH", path: "/api/bots", body: { botId: "zed", effort: "high" } }],
    ["k-persona", botCall({ persona: "Be brief" })],
    ["k-ws-other", { method: "PATCH", path: "/api/workspaces", body: { id: "ws_main", chain: {} } }],
    ["k-delete", { method: "DELETE", path: "/api/bots", body: { botId: "max" } }],
  ]) {
    const mac = await onMac(fixture(), call, key);
    const cloud = inCloud(fixture(), call, key);
    assert.equal(mac.done?.ok, false, key);
    assert.ok(cloud.refused, `${key}: refused in the cloud`);
    assert.equal(cloud.refused.message, mac.done.error, `${key}: in the same words`);
    assert.deepEqual(botOf(mac.state, "zed"), botOf(fixture(), "zed"));
  }
});

await test("the same key again: done already, nothing changes (the Mac's doChange returns, the cloud answers null)", async () => {
  const fx = fixture();
  const first = A.applyChange(clone(fx), WS, botCall({ effort: "low" }), SAM, "k-again", 1);
  assert.equal(A.applyChange(first.blob, WS, botCall({ effort: "high" }), SAM, "k-again", 2), null);
  const mac = await onMac(first.blob, botCall({ effort: "high" }), "k-again");
  assert.equal(bot(mac.state, "max").effort, "low", "the Mac does nothing either");
  assert.equal(mac.said.length, 0);
  // Kept results are the newest CHANGES_KEPT.
  let st = fixture();
  for (let i = 0; i < A.CHANGES_KEPT + 3; i++) st = A.applyChange(st, WS, botCall({ effort: i % 2 ? "low" : "high" }), SAM, `k-many-${i}`, i).blob;
  assert.equal(ws(st).changesDone.length, A.CHANGES_KEPT);
  assert.equal(ws(st).changesDone.at(-1).key, `k-many-${A.CHANGES_KEPT + 2}`);
});

await test("what Bops Cloud doesn't do yet is refused in words (409 cloud_not_yet), nothing changed", () => {
  const notYet = (call, words) => {
    const r = inCloud(fixture(), call, "k-not-yet");
    assert.deepEqual(r.refused, { status: 409, message: words, code: "cloud_not_yet" });
  };
  notYet(botCall({ runsOn: "mac" }), "This workspace runs in the cloud, so its bots work on their own computers.");
  notYet(botCall({ computer: "own" }), "A bot's own computer and email can't be set up from the cloud yet.");
  notYet(botCall({ email: true }), "A bot's own computer and email can't be set up from the cloud yet.");
  notYet(botCall({ site: { app: "demo-app" } }), A.SITE_NOT_FROM_CLOUD);
  assert.equal(A.SITE_NOT_FROM_CLOUD, "Which site a bot works on can't be changed from the cloud yet.");
  // The main workspace while its Orgo project is still "bops" (older apps find it by that name).
  const main = A.applyChange.bind(null);
  assert.throws(
    () => main(fixture(), "ws_main", { method: "PATCH", path: "/api/workspaces", body: { id: THIS_WS, name: "Home" } }, SAM, "k-main", 1, { renamed: { name: "Home", orgoName: "Home" } }),
    (e) => e.status === 409 && e.message === "The main workspace can't be renamed from the cloud yet." && e.extra?.code === "cloud_not_yet",
  );
  assert.equal(A.renameRefused(fixture(), "ws_main", "bops"), null, "its name kept: nothing to hold");
  assert.equal(A.renameRefused(fixture(), WS, "Acme Two"), null);
  // Another workspace's rename: the state part once orgo-web said its name (cloud/members.ts asks it first), as the Mac keeps one.
  const renamed = A.applyChange(fixture(), WS, wsCall({ name: "  Acme Two " }), SAM, "k-rename", 1, { renamed: { name: "Acme Two", orgoName: "Acme Two", updatedAt: "2026-11-18T00:00:00Z" } });
  assert.deepEqual([ws(renamed.blob).name, ws(renamed.blob).orgoName, ws(renamed.blob).orgoUpdatedAt], ["Acme Two", "Acme Two", "2026-11-18T00:00:00Z"]);
  assert.equal(renamed.said.text, "Sam renamed the workspace");
  // Where its chat is answered: only once Bops Cloud's switch was set (cloud/members.ts setRouting), "cloud" or "mac"
  // as the switch sends it ("auto" from an older window).
  assert.equal(inCloud(fixture(), wsCall({ chat: "mac" }), "k-chat").refused.status, 400);
  const chat = A.applyChange(fixture(), WS, wsCall({ chat: "mac" }), SAM, "k-chat", 1, { chatDone: true });
  assert.equal(chat.said.text, "Sam changed where the chat is answered");
  assert.equal(A.applyChange(fixture(), WS, wsCall({ chat: "cloud" }), SAM, "k-chat2", 1, { chatDone: true }).said.text, "Sam changed where the chat is answered");
  assert.throws(() => A.applyChange(fixture(), WS, wsCall({ chat: "elsewhere" }), SAM, "k-chat3", 1, { chatDone: true }), /"cloud" or "mac"/);
});

await test("with the owner's Mac closed, a new name or call voice says what follows once its Bops opens, for a bot with a phone or channels; nothing more with it on, or without them", () => {
  const fx = fixture();
  fx.owner = { name: "Alex" };
  const max = fx.bots.find((b) => b.id === "max");
  const said = (f, body, o) => A.applyChange(f, WS, botCall(body), SAM, `k-follow-${Math.random()}`, 1, o).said.text;
  // No phone, no channels: nothing to follow (the line names it as it's named now).
  assert.equal(said(clone(fx), { name: "Maxine" }, { macOn: false }), "Sam changed Maxine's settings");
  max.phoneLine = { numberId: "n1", agentId: "ag1" };
  assert.equal(said(clone(fx), { name: "Maxine" }, { macOn: false }), "Sam changed Maxine's settings. Its name on calls follows when Alex's Bops next opens.");
  fx.channels = [{ id: "ch1", kind: "telegram", botId: "max" }];
  assert.equal(said(clone(fx), { name: "Maxine" }, { macOn: false }), "Sam changed Maxine's settings. Its phone and channel names follow when Alex's Bops next opens.");
  assert.equal(said(clone(fx), { name: "Maxine" }, { macOn: true }), "Sam changed Maxine's settings", "the Mac follows it as it comes in");
  assert.equal(said(clone(fx), { name: "Maxine" }), "Sam changed Maxine's settings", "unsaid: as before");
  assert.equal(said(clone(fx), { callVoice: "ash" }, { macOn: false }), "Sam changed Max's settings. Its calls take the new voice when Alex's Bops next opens.");
  assert.equal(said(clone(fx), { effort: "high" }, { macOn: false }), "Sam changed Max's settings", "nothing to follow");
  // The same name again: no change, nothing follows.
  assert.equal(said(clone(fx), { name: "Max" }, { macOn: false }), "Sam changed Max's settings");
  // Channels only.
  delete max.phoneLine;
  assert.equal(said(clone(fx), { name: "Maxine" }, { macOn: false }), "Sam changed Maxine's settings. Its channel names follow when Alex's Bops next opens.");
});

console.log(`\ncloud change apply: ${passed} passed, ${failed} failed`);
await later(200);
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
