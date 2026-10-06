// Tests for Bops on Orgo's plans: reading the user's plan from Orgo (lib/server/plan.ts) for every plan
// key, today's and older ones, room or none for another computer and the words for it (lib/orgo-plans.ts),
// the size Bops makes computers at so a plan runs out of computers before memory, Orgo's refusals (a
// custom deal's too), the first task's copy of the main bot's computer falling back to the main bot's
// when the plan has no room, computers made one at a time, the plan read again after Bops makes or
// deletes a computer, and setting a computer up (lib/server/sessions.ts): a broken one replaced, and
// nothing done in another user's state. Orgo is a fake fetch on a made-up origin and the state a
// throwaway file store in a temporary folder: nothing reaches Orgo, and no key is read from the Keychain.
// Usage: node --conditions=react-server scripts/test-plan.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Orgo is the fake below, on its own origin; the state goes to a throwaway file store, with mail, OpenAI and the tailnet off.
for (const k of ["ORGO_API_KEY", "BOPS_ORGO_WORKSPACE", "BOPS_ORGO_TEMPLATE", "BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "BOPS_MAIL_DOMAIN", "OPENAI_API_KEY", "TAILSCALE_AUTH_KEY"])
  delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded (Codex, the relay's agent) or that Node can't load (the
// desktop look draws the mascot's JSX, mirror.ts has parameter properties) are stand-ins here: each of
// their exports does nothing. The computer setup tested below only calls them in passing.
const STAND_INS = new Set(["codex", "relay", "desktop", "mirror"]);
// The server modules import "@/lib/…" and "./store" (no extension), the way Next resolves them.
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
// The file store writes to .data/ under the working folder: a temporary one, removed at the end.
const scratch = mkdtempSync(join(tmpdir(), "bops-test-plan-"));
process.chdir(scratch);
// Signed in already: the key is in memory, so the Keychain is never asked (lib/server/orgo-auth.ts).
globalThis.bopsOrgoKey = "sk_test_one";

/* ---------------- A fake Orgo ---------------- */

const calls = [];
/** Orgo's answers by "METHOD /path", then `route` for paths with an id in them; anything else is a 404. */
let replies = {};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://orgo.test") throw new Error(`not the fake Orgo: ${url}`);
  const call = { method: init.method ?? "GET", path: url.pathname, query: url.search, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  const reply = replies[`${call.method} ${call.path}`] ?? replies.route;
  return (reply && (await reply(call))) ?? json(404, { error: "Not found" });
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const asked = (method, path) => calls.filter((c) => c.method === method && c.path === path).length;
const WORKSPACES = { "GET /api/workspaces": () => json(200, { workspaces: [{ id: "ws_other", name: "bops", role: "member" }, { id: "ws_bops", name: "Bops", role: "owner" }] }) };
/** Each plan's memory in GB (orgo-web lib/subscription-tiers.ts maxRamPerUser), with 8 GB for each computer in use. */
const POOL = { free: 4, hacker_v2: 8, startup_v2: 32, scale_v2: 128, hacker: 20, developer: 20, team: 80, startup: 200, scale: 200, max: 200, enterprise: 2000 };
const memoryOf = (tier, inUse) => {
  const total = POOL[tier];
  return { total, used: 8 * inUse, newMax: Math.max(0, Math.min(64, total - 8 * inUse)) };
};
/** Orgo's answers for an account on a plan: GET /api/user/subscription's key (and deal), GET /api/billing/compute-limits' counts. */
const answers = (tier, max, used, over = {}) => {
  const m = memoryOf(tier, used);
  return {
    ...WORKSPACES,
    "GET /api/user/subscription": () => json(200, { tier, requiresPayment: false, createdAt: null, integrations: false, planLimits: over.deal ?? null }),
    "GET /api/billing/compute-limits": () =>
      json(200, { max_cpu: 4, max_ram_gb: m.newMax, max_disk_gb: 40, account_ram_budget_gb: m.total, account_ram_used_gb: m.used, addon_ram_gb: 0, addon_vcpu: 0, max_computers: max, computers_used: used, os_limits: null, os_used: null }),
    ...over.replies,
  };
};
/** The account is on that plan now: what Bops read about the last one is forgotten. */
const onPlan = (...plan) => {
  replies = answers(...plan);
  L.forgetPlan();
};

const P = await import(`${root}/lib/orgo-plans.ts`);
const T = await import(`${root}/lib/types.ts`);
const sharesComputerOf = (b) => T.sharesComputer(b);
const workBotOf = (b) => T.workBot(b, S.getState().bots);
const L = await import(`${root}/lib/server/plan.ts`);
const O = await import(`${root}/lib/server/orgo.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const B = await import(`${root}/lib/server/bots.ts`);
const plain = (x) => JSON.parse(JSON.stringify(x));
const noDashes = (text) => assert.ok(!/[—–]/.test(text), `no dashes: ${text}`);
let n;

/* ---------------- Reading the plan, for every plan key ---------------- */

for (const [tier, max, used, name] of [
  ["hacker_v2", 1, 0, "Hacker"],
  ["startup_v2", 4, 2, "Startup"],
  ["scale_v2", 16, 5, "Scale"],
  ["free", 0, 0, "Free"],
  // Older plans keep their names (some the same as today's) and their bigger counts.
  ["hacker", 5, 1, "Hacker"],
  ["developer", 5, 0, "Developer"],
  ["team", 10, 3, "Team"],
  ["startup", 25, 4, "Startup"],
  ["scale", 25, 9, "Scale"],
  ["max", 25, 0, "Max"],
]) {
  onPlan(tier, max, used);
  assert.deepEqual(plain(await L.orgoPlan({ fresh: true })), { tier, name, computers: max, inUse: used, memory: memoryOf(tier, used) }, tier);
}
// Asked with the user's own key, about their own "bops" workspace (not one they're a member of).
assert.equal(calls.at(-1).auth, "Bearer sk_test_one");
assert.equal(calls.find((c) => c.path === "/api/billing/compute-limits").query, "?workspace_id=ws_bops");
// Orgo's count is the one that counts: bought computers on top, an Enterprise deal, an Orgo admin.
onPlan("hacker_v2", 3, 1);
assert.equal((await L.orgoPlan({ fresh: true })).computers, 3, "Hacker plus 2 bought computers");
onPlan("enterprise", 2, 2, { deal: { maxDesktops: 2 } });
assert.deepEqual(plain(await L.orgoPlan({ fresh: true })), { tier: "enterprise", name: "Enterprise", computers: 2, inUse: 2, memory: memoryOf("enterprise", 2), deal: true });
onPlan("free", 1_000_000, 4);
assert.deepEqual(plain(await L.orgoPlan({ fresh: true })), { computers: 1_000_000, inUse: 4, memory: memoryOf("free", 4) }, "Orgo says free when it couldn't look the plan up: not Free with computers");
// No counts from Orgo (it didn't answer, or it's older than max_computers): the plan's own number, a deal's
// first, and nothing in use known, so nothing is held back on it.
for (const [tier, deal, computers] of [["hacker_v2", null, 1], ["hacker", null, 5], ["team", null, 10], ["enterprise", { maxDesktops: 3 }, 3], ["free", null, 0]]) {
  onPlan(tier, 0, 0, { deal, replies: { "GET /api/billing/compute-limits": () => json(503, { error: "Compute limits are unavailable" }) } });
  const p = await L.orgoPlan({ fresh: true });
  assert.deepEqual(plain(p), { tier, name: P.planName(tier), computers, ...(deal ? { deal: true } : {}) }, tier);
  assert.equal(P.planShort(p), undefined, `${tier}: unknown in use holds nothing back`);
}
onPlan("hacker_v2", 1, 1, { replies: { "GET /api/billing/compute-limits": () => json(200, { max_cpu: 1, max_ram_gb: 8 }) } });
assert.equal((await L.orgoPlan({ fresh: true })).inUse, undefined, "an Orgo without the counts");
// The plan's key didn't come back: Orgo's counts still do.
onPlan("hacker_v2", 1, 1, { replies: { "GET /api/user/subscription": () => json(500, { error: "x" }) } });
assert.deepEqual(plain(await L.orgoPlan({ fresh: true })), { computers: 1, inUse: 1, memory: memoryOf("hacker_v2", 1) });
// Nothing came back, or nobody is signed in: no plan, and no call for the latter.
onPlan("hacker_v2", 1, 1, { replies: { "GET /api/user/subscription": () => json(500, {}), "GET /api/billing/compute-limits": () => json(500, {}) } });
assert.equal(await L.orgoPlan({ fresh: true }), null);
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Date.now();
n = calls.length;
assert.equal(await L.orgoPlan({ fresh: true }), null);
assert.equal(calls.length, n, "signed out: Orgo isn't asked");
globalThis.bopsOrgoKey = "sk_test_one";
// Read by any workspace the user owns when there's no "bops" one yet, and none is made for it: an account
// that never used the cloud has nothing new in it.
onPlan("hacker_v2", 1, 0, { replies: { "GET /api/workspaces": () => json(200, { workspaces: [{ id: "ws_shared", name: "bops", role: "member" }, { id: "ws_mine", name: "Personal", role: "owner" }] }) } });
await L.orgoPlan({ fresh: true });
assert.equal(calls.filter((c) => c.path === "/api/billing/compute-limits").at(-1).query, "?workspace_id=ws_mine");
onPlan("hacker_v2", 1, 0, { replies: { "GET /api/workspaces": () => json(200, { workspaces: [{ id: "ws_shared", name: "Team", role: "member" }] }) } });
n = asked("GET", "/api/billing/compute-limits");
assert.deepEqual(plain(await L.orgoPlan({ fresh: true })), { tier: "hacker_v2", name: "Hacker", computers: 1 }, "owns no workspace: the plan's own count");
assert.equal(asked("GET", "/api/billing/compute-limits"), n);
assert.equal(asked("POST", "/api/workspaces"), 0, "reading the plan never makes a workspace");

/* ---------------- Room or none, and the words for it ---------------- */

const hacker = (inUse) => ({ tier: "hacker_v2", name: "Hacker", computers: 1, inUse });
const startup = (inUse) => ({ tier: "startup_v2", name: "Startup", computers: 4, inUse });
assert.equal(P.planShort(null), undefined);
assert.equal(P.planShort({ computers: 1 }), undefined, "in use unknown");
assert.equal(P.planShort({ tier: "free", name: "Free", computers: 0, inUse: 0 }), "none");
assert.equal(P.planShort(hacker(0)), null);
assert.equal(P.planShort(hacker(1)), "count");
assert.equal(P.planShort(hacker(0), 2), "count", "a copy, and the main bot's computer first");
assert.equal(P.planShort(startup(2), 2), null);
assert.equal(P.planShort(startup(3), 2), "count");
assert.equal(P.planShort(hacker(2)), "count", "over the plan after a downgrade");
// With the memory each computer needs: the plan's memory left must hold them, and one computer may have that much.
const startupGb = (inUse, used, newMax = Math.min(64, 32 - used)) => ({ ...startup(inUse), memory: { total: 32, used, newMax } });
assert.equal(P.planShort(startupGb(1, 8), 1, 8), null);
assert.equal(P.planShort(startupGb(2, 32), 1, 8), "memory", "the plan's memory is used up");
assert.equal(P.planShort(startupGb(2, 24), 1, 16), "memory", "a 16 GB copy, with 8 GB left");
assert.equal(P.planShort(startupGb(1, 8), 2, 16), "memory", "the main bot's computer and a copy, 16 GB each, in 24 GB");
assert.equal(P.planShort(startupGb(1, 8), 2, 8), null);
assert.equal(P.planShort(startupGb(1, 8, 4), 1, 8), "size", "a deal allows 4 GB a computer");
assert.equal(P.planShort(startupGb(1, 8), 1, 0), "memory", "none of Orgo's sizes fits");
assert.equal(P.planShort(startupGb(4, 32), 1, 8), "count", "the count first");

const texts = [
  // The example: the bots' one computer is the Hacker plan's one.
  [P.planShortText("count", hacker(1), { bops: 1 }), "Your Orgo Hacker plan includes 1 computer, and it's in use. Orgo Startup includes 4."],
  [P.planShortText("count", hacker(1), { bops: 0 }), "Your Orgo Hacker plan includes 1 computer, and it's in use outside Bops. Orgo Startup includes 4."],
  [P.planShortText("count", hacker(2), { bops: 1 }), "Your Orgo Hacker plan includes 1 computer, and 2 are in use, 1 of them outside Bops. Orgo Startup includes 4."],
  [P.planShortText("count", startup(4), { bops: 1 }), "Your Orgo Startup plan includes 4 computers, and all 4 are in use, 3 of them outside Bops. Orgo Scale includes 16."],
  [P.planShortText("count", startup(4), { bops: 4 }), "Your Orgo Startup plan includes 4 computers, and all 4 are in use. Orgo Scale includes 16."],
  [P.planShortText("count", { tier: "scale_v2", name: "Scale", computers: 16, inUse: 16 }, { bops: 16 }), "Your Orgo Scale plan includes 16 computers, and all 16 are in use. Delete one, or add computers on Orgo."],
  // Older plans: the next plan up is the one with more computers than they have, not the next name.
  [P.planShortText("count", { tier: "hacker", name: "Hacker", computers: 5, inUse: 5 }, { bops: 5 }), "Your Orgo Hacker plan includes 5 computers, and all 5 are in use. Orgo Scale includes 16."],
  [P.planShortText("count", { tier: "team", name: "Team", computers: 10, inUse: 10 }, { bops: 2 }), "Your Orgo Team plan includes 10 computers, and all 10 are in use, 8 of them outside Bops. Orgo Scale includes 16."],
  // Enterprise is a deal of its own: no plan Orgo sells is the next one up.
  [P.planShortText("count", { tier: "enterprise", name: "Enterprise", computers: 2, inUse: 2 }), "Your Orgo Enterprise plan includes 2 computers, and both are in use. Delete one, or add computers on Orgo."],
  // Computers bought on top of Hacker: Startup has more.
  [P.planShortText("count", { tier: "hacker_v2", name: "Hacker", computers: 2, inUse: 2 }, { bops: 1 }), "Your Orgo Hacker plan includes 2 computers, and both are in use, 1 of them outside Bops. Orgo Startup includes 4."],
  // A custom deal on Hacker: moving up doesn't change it, so Orgo is asked.
  [P.planShortText("count", { tier: "hacker_v2", name: "Hacker", computers: 2, inUse: 2, deal: true }, { bops: 1 }), "Your Orgo Hacker plan includes 2 computers, and both are in use, 1 of them outside Bops. Delete one, or ask Orgo to change your plan."],
  [P.planShortText("memory", { tier: "hacker_v2", name: "Hacker", computers: 2, inUse: 1, deal: true }), "Your Orgo Hacker plan doesn't have the memory left for another computer. Delete a computer, or ask Orgo to change your plan."],
  [P.planShortText("count", null), "Every computer your Orgo plan includes is in use. Delete one, or add computers on Orgo."],
  [P.planShortText("none", { tier: "free", name: "Free", computers: 0, inUse: 0 }), "Your Orgo Free plan doesn't include cloud computers. Orgo Hacker includes 1."],
  [P.planShortText("none", null), "Your Orgo plan doesn't include cloud computers. Orgo Hacker includes 1."],
  [P.planShortText("memory", startup(2)), "Your Orgo Startup plan doesn't have the memory left for another computer. Orgo Scale has more."],
  [P.planShortText("size", hacker(1), { main: "Boppy" }), "Your Orgo Hacker plan doesn't allow another computer as big as Boppy's."],
  [P.planShortText("disk", startup(1), { main: "Boppy" }), "Your Orgo Startup plan doesn't allow a computer with as much disk as Boppy's."],
];
for (const [got, want] of texts) {
  assert.equal(got, want);
  noDashes(got);
}
assert.deepEqual(P.planFix("count", hacker(1)), { label: "Upgrade to Orgo Startup", tab: "plan" });
assert.deepEqual(P.planFix("none", { name: "Free", computers: 0, inUse: 0 }), { label: "Upgrade to Orgo Hacker", tab: "plan" });
assert.deepEqual(P.planFix("count", { name: "Scale", computers: 16, inUse: 16 }), { label: "Add capacity on Orgo", tab: "usage" });
assert.deepEqual(P.planFix("count", { ...hacker(1), deal: true }), { label: "See your plan on Orgo", tab: "usage" });
assert.deepEqual(P.planFix("size", hacker(1)), { label: "See Orgo's plans", tab: "plan" });
assert.deepEqual(P.planFix("disk", startup(1)), { label: "Add capacity on Orgo", tab: "usage" });
assert.deepEqual([0, 1, 4, 5, 10, 16, 25].map((c) => P.planUp({ computers: c })?.name), ["Hacker", "Startup", "Scale", "Scale", "Scale", undefined, undefined]);
assert.equal(P.planUp({ tier: "enterprise", computers: 2 }), undefined);
assert.equal(P.planUp({ tier: "hacker_v2", computers: 2, deal: true }), undefined, "a deal sets the count, whatever the plan");

// A bot of its own takes one more computer, and the main bot's first when that has none yet.
const team = (mainComputer, main = {}) => [
  { id: "boppy", name: "Boppy", isMain: true, computerStatus: "none", ...(mainComputer ? { computerId: "c-main" } : {}), ...main },
  { id: "nova", name: "Nova", isMain: false, computerStatus: "none", computer: "shared" },
];
assert.equal(P.ownComputerShort(hacker(0), team(false), "ws_main").text, "Your Orgo Hacker plan includes 1 computer, and Boppy's computer needs it. Orgo Startup includes 4.");
assert.equal(P.ownComputerShort(hacker(1), team(true), "ws_main").text, "Your Orgo Hacker plan includes 1 computer, and it's in use. Orgo Startup includes 4.");
assert.equal(P.ownComputerShort(startup(1), team(true), "ws_main"), null, "room for a copy");
assert.equal(P.ownComputerShort(startup(3), team(false), "ws_main").text, "Your Orgo Startup plan includes 4 computers, and 3 are in use outside Bops, so Boppy's computer needs the last one. Orgo Scale includes 16.");
assert.equal(P.ownComputerShort({ computers: 1 }, team(false), "ws_main"), null, "in use unknown: Orgo decides");
// A copy is as big as the main bot's computer: a 16 GB one (made before Bops sized them) needs 16 GB left.
assert.equal(P.ownComputerShort(startupGb(2, 24), team(true, { computerRam: 16 }), "ws_main").text, "Your Orgo Startup plan doesn't have the memory left for another computer. Orgo Scale has more.");
assert.equal(P.ownComputerShort(startupGb(2, 16), team(true, { computerRam: 16 }), "ws_main"), null, "16 GB left: it fits");
assert.equal(P.ownComputerShort(startupGb(2, 24), team(true, { computerRam: 8 }), "ws_main"), null, "an 8 GB one fits");
assert.equal(P.mainComputerShort(hacker(0), team(false), "ws_main"), null);
assert.equal(P.mainComputerShort({ name: "Free", computers: 0, inUse: 0 }, team(false), "ws_main").short, "none");
assert.equal(P.bopsComputers([{ computerId: "a" }, { computerId: "a" }, { computerId: "b" }, {}]), 2, "bots that share count once");
// The Computer tab: a computer made already whose setup didn't finish is set up again, which takes no more
// room, so its Set up button stays though the plan is full. One not made yet needs the room.
const halfSetUp = team(true, { computerStatus: "error" });
assert.equal(P.mainComputerShort(hacker(1), halfSetUp, "ws_main").short, "count", "a new one: no room");
assert.equal(P.setupShort(hacker(1), halfSetUp, halfSetUp[0]), null, "the one it has: set up again");
assert.equal(P.setupShort(hacker(1), team(false), team(false)[0]).short, "count");
const novaHalfSetUp = { ...team(true)[1], computer: "own", computerId: "c-nova", computerStatus: "error" };
assert.equal(P.setupShort(startup(4), [team(true)[0], novaHalfSetUp], novaHalfSetUp), null);
assert.equal(P.setupShort(startup(4), team(true), { ...team(true)[1], computer: "own" }).short, "count");

/* ---------------- The size Bops makes computers at ---------------- */

// The plan's memory split across its computers, in Orgo's sizes: 8 GB on every plan Orgo sells, so the
// count runs out first (Startup's 32 GB holds its 4 computers; at the template's 16 GB it would hold 2).
const fresh = (tier, computers) => ({ tier, computers, inUse: 0, memory: memoryOf(tier, 0) });
for (const [tier, computers, want] of [
  ["hacker_v2", 1, 8],
  ["startup_v2", 4, 8],
  ["scale_v2", 16, 8],
  ["hacker", 5, 4],
  ["developer", 5, 4],
  ["team", 10, 8],
  ["startup", 25, 8],
  ["max", 25, 8],
  // Enterprise's thousand computers can't all fit its memory at any size: Orgo sizes it, from the template.
  ["enterprise", 1000, undefined],
])
  assert.equal(P.computerRam(fresh(tier, computers)), want, tier);
assert.equal(P.computerRam({ tier: "startup_v2", computers: 4, inUse: 0 }), undefined, "memory unknown: Orgo sizes it");
assert.equal(P.computerRam({ computers: 4, inUse: 0, memory: { total: 128, used: 0, newMax: 64 } }), 16, "a deal with memory to spare: the template's 16");
assert.equal(P.computerRam({ computers: 4, inUse: 3, memory: { total: 32, used: 26, newMax: 6 } }), 4, "less when that's all a new computer can have now");
assert.equal(P.computerRam({ computers: 4, inUse: 0, memory: { total: 32, used: 0, newMax: 4 } }), 4, "a deal's limit per computer");
assert.equal(P.computerRam({ computers: 4, inUse: 3, memory: { total: 32, used: 30, newMax: 2 } }), 0, "not even the smallest fits");
assert.equal(P.mainComputerShort({ ...startup(3), memory: { total: 32, used: 30, newMax: 2 } }, team(false), "ws_main").short, "memory");

/* ---------------- Orgo's refusals ---------------- */

const refused = (status, code, error = "x") => new O.OrgoError(`Orgo POST /computers → ${status}: ${error}`, status, code, error);
for (const [e, want] of [
  [refused(403, "UPGRADE_REQUIRED", "Creating a computer requires a paid plan. Upgrade to launch your first computer."), "none"],
  [refused(403, "VM_SLOT_ADDON", "Computer limit reached. Add a slot or delete a computer."), "count"],
  [refused(403, "PLAN_LIMIT", "Your plan allows 2 computer(s), and you have 2. Delete one, or contact us to change your plan."), "count"],
  // A custom deal's other limits are PLAN_LIMIT too: its memory, its most for one computer, its computers of one kind.
  [refused(403, "PLAN_LIMIT", "Your plan allows 32GB of RAM across your computers. They use 32GB, and this 8GB one would need 40GB. Pick a smaller size, delete or shrink a computer, or contact us to change your plan."), "memory"],
  [refused(403, "PLAN_LIMIT", "This computer asks for 16GB RAM, but your plan allows 8GB per computer. Pick a smaller size, or contact us to change your plan."), "size"],
  [refused(403, "PLAN_LIMIT", "Your plan allows 1 Linux computer, and you have 1. Delete one, or contact us to change your plan."), "count"],
  [refused(403, "PLAN_LIMIT", "Your plan doesn't include Windows computers. Contact us to add them to your plan."), "count"],
  [refused(403, "PLAN_LIMIT", "Your plan doesn't include computers. Contact us to change your plan."), "none"],
  [refused(403, "CHANGE_PLAN"), "count"],
  [refused(403, "DESKTOP_LIMIT", "Computer limit reached. You have 5/5. Your grace period lets you keep existing computers, but you can't create new ones until you upgrade or delete some."), "count"],
  [refused(403, "DESKTOP_LIMIT", "RAM limit exceeded. You are using 20GB/20GB; this 4GB computer would put you at 24GB."), "memory"],
  [refused(403, undefined, "Computer limit reached. You have 5/5. Your grace period lets you keep existing computers, but you can't create new ones until you upgrade or delete some."), "count"],
  [refused(403, "RAM_ADDON", "Not enough account RAM: your 2 computers already use 32GB of your 32GB pool, and this 16GB one would need 48GB."), "memory"],
  [refused(403, "RAM_ADDON", "This computer asks for 16GB RAM, but your plan allows 8GB per computer."), "size"],
  [refused(403, "VCPU_ADDON"), "size"],
  [refused(403, "PER_COMPUTER_RAM_CAP"), "size"],
  [refused(403, "DISK_QUOTA_EXCEEDED"), "disk"],
  [refused(400, "disk_exceeds_quota"), "disk"],
  [refused(409, "NOT_FORKABLE"), null],
  [refused(409, "HOURLY_QUOTE_REQUIRED"), null],
  [refused(403, "NOT_A_MEMBER"), null],
  [refused(400, "INVALID_BILLING_MODE"), null],
  [refused(500, undefined), null],
  [new Error("Computer limit reached"), null],
])
  assert.equal(L.planRefusal(e), want, e.message);

/* ---------------- The main bot's computer ---------------- */

const main = () => S.bot("boppy");
const URL_PLAN = "https://orgo.test/account?tab=plan";
// Free: said plainly, and Orgo isn't asked to make one.
onPlan("free", 0, 0);
await assert.rejects(L.makeMainComputer(main(), "boppy-a"), (e) => {
  assert.ok(e instanceof L.PlanLimit);
  assert.equal(e.message, "Your Orgo Free plan doesn't include cloud computers. Orgo Hacker includes 1.");
  assert.deepEqual(e.link, { label: "Upgrade to Orgo Hacker", url: URL_PLAN });
  return true;
});
assert.equal(asked("POST", "/api/computers"), 0);
// Hacker with its one computer free: made at the plan's 8 GB; its vCPUs are the template's, as far as the plan allows.
onPlan("hacker_v2", 1, 0, { replies: { "POST /api/computers": () => json(201, { id: "c-main", name: "boppy-b", status: "creating" }) } });
assert.deepEqual(plain(await L.makeMainComputer(main(), "boppy-b")), { id: "c-main", name: "boppy-b", status: "creating" });
assert.deepEqual(calls.at(-1).body, { workspace_id: "ws_bops", name: "boppy-b", template_ref: "system/bops-base@0.1.8", ram: 8 });
// Startup and Scale too: 8 GB, so their 4 and 16 computers fit their memory.
for (const [tier, max] of [["startup_v2", 4], ["scale_v2", 16]]) {
  onPlan(tier, max, 0, { replies: { "POST /api/computers": () => json(201, { id: "c-x", name: "boppy-x", status: "creating" }) } });
  await L.makeMainComputer(main(), "boppy-x");
  assert.equal(calls.at(-1).body.ram, 8, tier);
}
// The one computer is in use elsewhere in the account: said with the numbers, no POST.
onPlan("hacker_v2", 1, 1);
n = asked("POST", "/api/computers");
await assert.rejects(L.makeMainComputer(main(), "boppy-c"), { message: "Your Orgo Hacker plan includes 1 computer, and it's in use outside Bops. Orgo Startup includes 4." });
assert.equal(asked("POST", "/api/computers"), n);
// A "no room" read within the minute is checked with Orgo before it's said: the computer that filled the
// plan was deleted on Orgo's site since.
onPlan("hacker_v2", 1, 1);
await L.orgoPlan();
replies = answers("hacker_v2", 1, 0, { replies: { "POST /api/computers": () => json(201, { id: "c-main", name: "boppy-g", status: "creating" }) } });
assert.equal((await L.makeMainComputer(main(), "boppy-g")).id, "c-main");
// The numbers had room, but Orgo turns it down (another computer was made meanwhile): Orgo's answer, in plain words.
let limitsRead = 0;
onPlan("hacker_v2", 1, 0, {
  replies: {
    "GET /api/billing/compute-limits": () => json(200, { max_computers: 1, computers_used: limitsRead++ ? 1 : 0 }),
    "POST /api/computers": () => json(403, { error: "Computer limit reached. Add a slot or delete a computer.", code: "VM_SLOT_ADDON", canManageCapacity: true }),
  },
});
await assert.rejects(L.makeMainComputer(main(), "boppy-d"), (e) => e instanceof L.PlanLimit && e.message === "Your Orgo Hacker plan includes 1 computer, and it's in use outside Bops. Orgo Startup includes 4.");
assert.equal(limitsRead, 2, "read again after the refusal");
// Anything else goes up as it was.
onPlan("hacker_v2", 1, 0, { replies: { "POST /api/computers": () => json(500, { error: "boom" }) } });
await assert.rejects(L.makeMainComputer(main(), "boppy-e"), (e) => e instanceof O.OrgoError && !(e instanceof L.PlanLimit) && e.status === 500);

/* ---------------- The first task's computer of its own: the fallback ---------------- */

// The main bot has its computer; Nova is meant to have its own, and has a task waiting for it.
S.update((s) => {
  const boppy = s.bots.find((b) => b.id === "boppy");
  boppy.computerId = "c-main";
  boppy.computerStatus = "ready";
  s.bots.push({ id: "nova", name: "Nova", role: "Research", color: "#2EC4B6", isMain: false, computerStatus: "cloning", computer: "own" });
  s.chats.push({ id: "bot:nova", kind: "bot", botIds: ["nova"], createdAt: Date.now(), typing: [] });
  s.sessions.push({ id: "ses_1", botId: "nova", chatId: "bot:nova", sentVia: "you", title: "Lisbon flights", goal: "Find flights to Lisbon", host: "orgo", status: "queued", steps: [], replies: [], createdAt: Date.now(), runsOn: "cloud" });
});
const nova = () => S.bot("nova");
const lastNote = () => S.getState().messages.filter((m) => m.chatId === "bot:nova").at(-1);
const ownAgain = () => S.update(() => Object.assign(nova(), { computer: "own", computerStatus: "cloning" }));
const FORK = { "GET /api/computers/c-main": () => json(200, { id: "c-main", instance_details: { id: "inst-main" } }) };
const copies = () => asked("POST", "/api/computers/inst-main/fork") + asked("POST", "/api/computers/c-main/clone");
/** What a bot says when it works on Boppy's computer after all: why, the link, and how to give it its own again. */
const sharing = (why, link) => `I'll work on Boppy's computer instead of one of my own. ${why} ${link} Once your Orgo plan has room, you can switch me to Its own under Computer in my Details.`;

// No room by the plan's numbers: no copy is asked for, Nova works on Boppy's computer, its chat says why
// with the link, and its task waits there, still queued, for a screen on Boppy's computer.
onPlan("hacker_v2", 1, 1, { replies: FORK });
assert.equal(await L.makeOwnComputer(nova(), main(), "nova-a"), null);
assert.equal(copies(), 0);
assert.deepEqual({ computer: nova().computer, status: nova().computerStatus }, { computer: "shared", status: "none" });
assert.deepEqual({ role: lastNote().role, botId: lastNote().botId }, { role: "bot", botId: "nova" });
assert.equal(lastNote().text, sharing("Your Orgo Hacker plan includes 1 computer, and it's in use. Orgo Startup includes 4.", `[Upgrade to Orgo Startup](${URL_PLAN})`));
noDashes(lastNote().text);
assert.equal(S.session("ses_1").status, "queued", "the task still runs, on Boppy's computer");

// Room by the numbers, but Orgo turns the fork down for the plan: no clone (it would be turned down too),
// the plan is read again, and Nova shares.
ownAgain();
limitsRead = 0;
onPlan("startup_v2", 4, 1, {
  replies: {
    ...FORK,
    "GET /api/billing/compute-limits": () => json(200, { max_computers: 4, computers_used: limitsRead++ ? 4 : 1 }),
    "POST /api/computers/inst-main/fork": () => json(403, { error: "Computer limit reached. Add a slot or delete a computer.", code: "VM_SLOT_ADDON" }),
  },
});
n = copies();
assert.equal(await L.makeOwnComputer(nova(), main(), "nova-b"), null);
assert.equal(copies() - n, 1, "one fork, no clone");
assert.equal(limitsRead, 2);
assert.equal(nova().computer, "shared");
assert.equal(lastNote().text, sharing("Your Orgo Startup plan includes 4 computers, and all 4 are in use, 3 of them outside Bops. Orgo Scale includes 16.", `[Upgrade to Orgo Scale](${URL_PLAN})`));
assert.equal(S.session("ses_1").status, "queued");

// The plan's memory is used up (Orgo's RAM_ADDON for the pool): the same, in those words.
ownAgain();
onPlan("startup_v2", 4, 2, { replies: { ...FORK, "POST /api/computers/inst-main/fork": () => json(403, { error: "Not enough account RAM: your 2 computers already use 32GB of your 32GB pool.", code: "RAM_ADDON" }) } });
assert.equal(await L.makeOwnComputer(nova(), main(), "nova-c"), null);
assert.equal(lastNote().text, sharing("Your Orgo Startup plan doesn't have the memory left for another computer. Orgo Scale has more.", `[Upgrade to Orgo Scale](${URL_PLAN})`));

// The main bot's computer is 16 GB (made before Bops sized them) and the plan has 8 GB left: Bops says so
// without asking Orgo for a copy it would turn down, and keeps the size for the app to check by.
ownAgain();
onPlan("startup_v2", 4, 2, {
  replies: {
    "GET /api/computers/c-main": () => json(200, { id: "c-main", status: "running", ram: 16, instance_details: { id: "inst-main" } }),
    "GET /api/billing/compute-limits": () => json(200, { max_computers: 4, computers_used: 2, account_ram_budget_gb: 32, account_ram_used_gb: 24, max_ram_gb: 8 }),
  },
});
n = copies();
assert.equal(await L.makeOwnComputer(nova(), main(), "nova-m"), null);
assert.equal(copies(), n, "no copy asked for");
assert.equal(main().computerRam, 16);
assert.equal(nova().computer, "shared");
assert.equal(lastNote().text, sharing("Your Orgo Startup plan doesn't have the memory left for another computer. Orgo Scale has more.", `[Upgrade to Orgo Scale](${URL_PLAN})`));

// A custom deal's limit the numbers don't show (its Linux computers): Orgo's own words, and no plan to move up to.
ownAgain();
onPlan("enterprise", 10, 2, {
  deal: { maxDesktops: 10 },
  replies: { ...FORK, "POST /api/computers/inst-main/fork": () => json(403, { error: "Your plan allows 2 Linux computers, and you have 2. Delete one, or contact us to change your plan.", code: "PLAN_LIMIT", upgradeTier: "enterprise" }) },
});
assert.equal(await L.makeOwnComputer(nova(), main(), "nova-os"), null);
assert.equal(lastNote().text, sharing("Your plan allows 2 Linux computers, and you have 2. Delete one, or ask Orgo to change your plan.", "[See your plan on Orgo](https://orgo.test/account?tab=usage)"));
noDashes(lastNote().text);

// A fork that can't happen for another reason falls back to a clone, as before; a clone turned down for the plan shares too.
ownAgain();
onPlan("startup_v2", 4, 1, {
  replies: {
    ...FORK,
    "POST /api/computers/inst-main/fork": () => json(409, { error: "This computer must be running to fork (a fork copies its live memory).", code: "NOT_FORKABLE" }),
    "POST /api/computers/c-main/clone": () => json(403, { error: "Computer limit reached. Add a slot or delete a computer.", code: "VM_SLOT_ADDON" }),
  },
});
n = copies();
assert.equal(await L.makeOwnComputer(nova(), main(), "nova-d"), null);
assert.equal(copies() - n, 2, "a fork, then a clone");
assert.equal(nova().computer, "shared");

// A fork that fails for anything else falls back to a clone, which makes the computer; Nova keeps its own.
ownAgain();
onPlan("startup_v2", 4, 1, {
  replies: {
    ...FORK,
    "POST /api/computers/inst-main/fork": () => json(500, { error: "insufficient memory on host" }),
    "POST /api/computers/c-main/clone": () => json(201, { id: "c-nova", name: "nova-e", status: "creating" }),
  },
});
const notes = S.getState().messages.length;
assert.equal((await L.makeOwnComputer(nova(), main(), "nova-e")).id, "c-nova");
assert.deepEqual(calls.at(-1).body, { name: "nova-e" });
assert.equal(nova().computer, "own");
assert.equal(S.getState().messages.length, notes, "nothing to say");
// ...and when both fail, the error is Orgo's, as before (not the plan's).
onPlan("startup_v2", 4, 1, { replies: { ...FORK, "POST /api/computers/inst-main/fork": () => json(500, { error: "insufficient memory" }), "POST /api/computers/c-main/clone": () => json(500, { error: "boom" }) } });
await assert.rejects(L.makeOwnComputer(nova(), main(), "nova-f"), { message: "the cloud server it has to share with the main bot's computer is full right now" });

// Orgo can't be asked about the plan: nothing holds the copy back, and Orgo decides.
onPlan("startup_v2", 4, 4, {
  replies: {
    ...FORK,
    "GET /api/user/subscription": () => json(503, {}),
    "GET /api/billing/compute-limits": () => json(503, {}),
    "POST /api/computers/inst-main/fork": () => json(201, { id: "c-nova-2", name: "Boppy (fork)", status: "creating" }),
  },
});
assert.equal((await L.makeOwnComputer(nova(), main(), "nova-g")).id, "c-nova-2");

/* ---------------- Its own computer, offered only with room ---------------- */

// Idle on the shared computer (a bot at work can't switch).
S.patchSession("ses_1", { status: "done" });
S.update(() => Object.assign(nova(), { computer: "shared", computerStatus: "none", computerId: undefined }));
S.update(() => (main().computerRam = undefined));
onPlan("hacker_v2", 1, 1);
assert.deepEqual(await B.setComputer("nova", "own"), { error: "Your Orgo Hacker plan includes 1 computer, and it's in use. Orgo Startup includes 4." });
assert.equal(nova().computer, "shared", "stays on the shared computer");
let made = await B.createBot("Iris", "Inbox", undefined, true);
assert.equal(made.note, "Iris works on Boppy's computer. Your Orgo Hacker plan includes 1 computer, and it's in use. Orgo Startup includes 4.");
assert.equal(S.bot(made.botId).computer, "shared");
onPlan("startup_v2", 4, 1);
made = await B.createBot("Rook", "Recruiting", undefined, true);
assert.equal(made.note, undefined);
assert.equal(S.bot(made.botId).computer, "own");
// A new bot shares by default, with no question for Orgo.
n = calls.length;
made = await B.createBot("Penny", "Finance");
assert.equal(S.bot(made.botId).computer, "shared");
assert.equal(calls.length, n);

/* ---------------- Kept a minute, read again after Bops makes or deletes a computer ---------------- */

const limitsAsked = () => asked("GET", "/api/billing/compute-limits");
onPlan("startup_v2", 4, 1, {
  replies: {
    "POST /api/computers": () => json(201, { id: "c-new", name: "x", status: "creating" }),
    "GET /api/computers/c-new": () => json(200, { id: "c-new", workspace_id: "ws_bops", instance_details: { id: "inst-new" } }),
    "DELETE /api/computers/c-new": () => json(200, { ok: true }),
    "POST /api/computers/inst-new/fork": () => json(201, { id: "c-fork", name: "x (fork)", status: "creating" }),
    "POST /api/computers/c-new/clone": () => json(201, { id: "c-clone", name: "y", status: "creating" }),
  },
});
L.forgetPlan();
n = limitsAsked();
await Promise.all([L.orgoPlan(), L.orgoPlan()]);
assert.equal(limitsAsked() - n, 1, "two at once share one read");
await L.orgoPlan();
assert.equal(limitsAsked() - n, 1, "kept");
for (const [what, act] of [
  ["create", () => O.orgo.create("x")],
  ["fork", () => O.orgo.fork("c-new")],
  ["clone", () => O.orgo.clone("c-new", "y")],
  ["delete", () => O.orgo.remove("c-new")],
]) {
  const before = limitsAsked();
  await act();
  await L.orgoPlan();
  await L.orgoPlan();
  assert.equal(limitsAsked() - before, 1, `read again once after a ${what}`);
}
// A minute later, read again.
const now = Date.now;
Date.now = () => now() + 61_000;
n = limitsAsked();
await L.orgoPlan();
assert.equal(limitsAsked() - n, 1, "a minute on");
Date.now = now;
// Another Orgo account signed in: its own plan, on its own key.
globalThis.bopsOrgoKey = "sk_test_two";
n = limitsAsked();
await L.orgoPlan();
assert.equal(limitsAsked() - n, 1);
assert.equal(calls.at(-1).auth, "Bearer sk_test_two");
globalThis.bopsOrgoKey = "sk_test_one";
// A read that got nothing isn't kept: the next look asks again.
onPlan("startup_v2", 4, 1, { replies: { "GET /api/user/subscription": () => json(503, {}), "GET /api/billing/compute-limits": () => json(503, {}) } });
assert.equal(await L.orgoPlan(), null);
replies = answers("startup_v2", 4, 1);
assert.equal((await L.orgoPlan()).inUse, 1, "asked again");

/* ---------------- One at a time, and a plan's computers all fit ---------------- */

/**
 * An Orgo account that counts the way Orgo does: its computers and their memory, and Orgo's check on a
 * create, fork or clone. The check counts what's there when the call arrives, and the new computer is
 * there `slow` ms later, with no lock between (orgo-web lib/plan-limits.ts).
 */
function account(tier, computers, pool, rows = [], slow = 30) {
  let made = 0;
  const used = () => rows.reduce((sum, r) => sum + r.ram, 0);
  const add = async (ram) => {
    if (rows.length >= computers) return json(403, { error: "Computer limit reached. Add a slot or delete a computer.", code: "VM_SLOT_ADDON" });
    if (used() + ram > pool) return json(403, { error: `Not enough account RAM: your ${rows.length} computers already use ${used()}GB of your ${pool}GB pool.`, code: "RAM_ADDON" });
    await new Promise((r) => setTimeout(r, slow));
    const row = { id: `c-${tier}-${++made}`, ram };
    rows.push(row);
    return json(201, { id: row.id, name: row.id, status: "running" });
  };
  return {
    rows,
    replies: {
      ...WORKSPACES,
      "GET /api/user/subscription": () => json(200, { tier, planLimits: null }),
      "GET /api/billing/compute-limits": () =>
        json(200, { max_computers: computers, computers_used: rows.length, account_ram_budget_gb: pool, account_ram_used_gb: used(), max_ram_gb: Math.max(0, Math.min(64, pool - used())) }),
      // Without a size, the template's 16 GB as far as one computer may have (orgo-web lib/computer-create-gate.ts).
      "POST /api/computers": (c) => add(c.body.ram ?? Math.min(16, 64, pool)),
      route: (c) => {
        const [, id, what] = c.path.match(/^\/api\/computers\/([^/]+)(?:\/(\w+))?$/) ?? [];
        const row = rows.find((r) => r.id === id || `inst-${r.id}` === id);
        if (!row) return undefined;
        if (c.method === "GET" && !what) return json(200, { id: row.id, status: "running", ram: row.ram, workspace_id: "ws_bops", instance_details: { id: `inst-${row.id}` } });
        // A fork or clone is as big as what it copies.
        if (c.method === "POST" && (what === "fork" || what === "clone")) return add(row.ram);
        return undefined;
      },
    },
  };
}
const ownBot = (id) => {
  S.update((s) => s.bots.push({ id, name: id[0].toUpperCase() + id.slice(1), role: "Helper", color: "#5B8CFF", isMain: false, computer: "own", computerStatus: "cloning" }));
  return S.bot(id);
};
const posts = (since) => calls.slice(since).filter((c) => c.method === "POST").length;

// Startup: the main bot's computer and three copies, 8 GB each, fill its 4 computers and its 32 GB
// together, and a fifth is said to have no room. (At the template's 16 GB, Orgo turns the third down.)
let acct = account("startup_v2", 4, 32);
replies = acct.replies;
L.forgetPlan();
S.update(() => Object.assign(main(), { computerId: undefined, computerRam: undefined }));
const first = await L.makeMainComputer(main(), "boppy-s");
S.update(() => Object.assign(main(), { computerId: first.id, computerStatus: "ready" }));
for (const id of ["ana", "ben", "cy"]) {
  const copy = await L.makeOwnComputer(ownBot(id), main(), `${id}-1`);
  assert.ok(copy, `${id} gets its own`);
  S.update(() => (S.bot(id).computerId = copy.id));
}
assert.deepEqual(acct.rows.map((r) => r.ram), [8, 8, 8, 8], "4 computers of 8 GB: the plan's 32 GB");
n = calls.length;
assert.equal(await L.makeOwnComputer(ownBot("dee"), main(), "dee-1"), null, "a fifth: no room");
assert.equal(posts(n), 0, "not asked of Orgo");
assert.equal(S.bot("dee").computer, "shared");
assert.match(S.getState().messages.filter((m) => m.chatId === "bot:dee").at(-1)?.text ?? "", /Your Orgo Startup plan includes 4 computers, and all 4 are in use\. Orgo Scale includes 16\./);
const template = account("startup_v2", 4, 32);
replies = template.replies;
for (const name of ["t1", "t2", "t3"]) await fetch("https://orgo.test/api/computers", { method: "POST", body: JSON.stringify({ name }) });
assert.deepEqual(template.rows.map((r) => r.ram), [16, 16], "the template's size: 2 of Startup's 4");

// Two bots get their own computers in one turn, with room for one more: Bops asks for one copy at a time,
// so the second sees the plan full rather than slip past Orgo's count with the first.
acct = account("startup_v2", 4, 32, [{ id: "c-m", ram: 8 }, { id: "c-o1", ram: 8 }, { id: "c-o2", ram: 8 }], 50);
replies = acct.replies;
L.forgetPlan();
S.update(() => Object.assign(main(), { computerId: "c-m", computerRam: 8 }));
n = calls.length;
const both = await Promise.all([L.makeOwnComputer(ownBot("eve"), main(), "eve-1"), L.makeOwnComputer(ownBot("fay"), main(), "fay-1")]);
assert.equal(posts(n), 1, "one copy asked for");
assert.equal(acct.rows.length, 4, "the plan's 4, not 5");
assert.ok(both[0] && both[1] === null);
assert.equal(S.bot("fay").computer, "shared");
// Two workspaces' main bots make their first computers at once on Hacker: one is made, the other told why.
acct = account("hacker_v2", 1, 8, [], 50);
replies = acct.replies;
L.forgetPlan();
const mains = await Promise.allSettled([L.makeMainComputer(main(), "ws1-main"), L.makeMainComputer(main(), "ws2-main")]);
assert.deepEqual(mains.map((r) => r.status), ["fulfilled", "rejected"]);
assert.ok(mains[1].reason instanceof L.PlanLimit);
assert.equal(acct.rows.length, 1, "the plan's 1, not 2");

/* ---------------- Setting a computer up ---------------- */

const X = await import(`${root}/lib/server/sessions.ts`);
/** Orgo for these: Hacker with room; Bops' computers by id, with a status, and screens that come up or don't. */
const upComputers = new Map();
let upMade = 0;
let status = "running";
let screensUp = false;
replies = {
  ...answers("hacker_v2", 1, 0),
  "POST /api/computers": (c) => {
    const id = `c-up-${++upMade}`;
    upComputers.set(id, c.body.ram ?? 16);
    return json(201, { id, name: c.body.name, status: "creating" });
  },
  route: (c) => {
    const [, id, what] = c.path.match(/^\/api\/computers\/([^/]+)(?:\/(\w+))?$/) ?? [];
    if (!upComputers.has(id)) return undefined;
    if (c.method === "GET" && !what) return json(200, { id, status, ram: upComputers.get(id), workspace_id: "ws_bops" });
    if (c.method === "DELETE" && !what) return upComputers.delete(id), json(200, { ok: true });
    if (c.method === "GET" && what === "screens")
      return screensUp ? json(200, { screens: [99, 100, 101, 102].map((d) => ({ id: `s${d}`, display: `:${d}`, width: 1280, height: 960, default: d === 99 })) }) : json(404, { error: "No screens yet" });
    if (c.method === "POST" && what === "bash") return json(200, { output: "", exit_code: 0 });
    // Its disk: the plan's default, and at most 50 GB on this plan.
    if (c.method === "GET" && what === "resize") return json(200, { current_disk_gb: 20, max_disk_gb: 50 });
    if (c.method === "PATCH" && what === "resize") return json(200, { ok: true });
    return undefined;
  },
};
L.forgetPlan();
S.update((s) => {
  Object.assign(main(), { computerId: undefined, computerRam: undefined, computerStatus: "none" });
  for (const x of s.sessions) if (x.status === "queued") x.status = "done";
});
const task = (id) => S.update((s) => s.sessions.push({ id, botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: `Task ${id}`, goal: "Look something up", host: "orgo", status: "queued", steps: [], replies: [], createdAt: Date.now(), runsOn: "cloud" }));
const said = (id) => S.getState().messages.find((m) => m.resultOf === id)?.text;

// Made, but its setup fails the first time: the computer is kept for one more try, and the task says so.
task("ses_up1");
await X.ensureComputer("boppy");
assert.deepEqual({ id: main().computerId, status: main().computerStatus, ram: main().computerRam }, { id: "c-up-1", status: "error", ram: 8 });
assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/api/computers").at(-1).body.ram, 8);
assert.equal(asked("DELETE", "/api/computers/c-up-1"), 0);
assert.equal(S.session("ses_up1").status, "failed");
assert.equal(said("ses_up1"), "I couldn't start Task ses_up1: Boppy's computer couldn't be set up (Orgo GET /computers/c-up-1/screens → 404: No screens yet). The next task tries again.");
// Its one more try fails too: deleted, so it stops using up the plan, and the next task makes a new one.
task("ses_up2");
n = asked("POST", "/api/computers");
await X.ensureComputer("boppy");
assert.equal(asked("POST", "/api/computers"), n, "the same computer tried again, none made");
assert.equal(asked("DELETE", "/api/computers/c-up-1"), 1);
assert.deepEqual({ id: main().computerId, status: main().computerStatus }, { id: undefined, status: "error" });
assert.match(said("ses_up2"), /\(Orgo GET \/computers\/c-up-1\/screens → 404: No screens yet\)\. Bops deleted it, and the next task makes a new one\.$/);
// The next one comes up.
screensUp = true;
await X.ensureComputer("boppy");
assert.deepEqual({ id: main().computerId, status: main().computerStatus, ram: main().computerRam }, { id: "c-up-2", status: "ready", ram: 8 });
assert.deepEqual(
  calls.filter((c) => c.method === "PATCH" && c.path === "/api/computers/c-up-2/resize").map((c) => c.body),
  [{ disk_size_gb: 50 }],
  "its disk grows to the plan's most (under Bops' 120 GB)",
);
// Orgo says a new one is stopped: deleted right away, without waiting out the three minutes for it to run.
S.update(() => Object.assign(main(), { computerId: undefined, computerStatus: "none" }));
status = "stopped";
task("ses_up3");
const t0 = Date.now();
await X.ensureComputer("boppy");
assert.ok(Date.now() - t0 < 2500, "no wait");
assert.equal(asked("DELETE", "/api/computers/c-up-3"), 1);
assert.equal(main().computerId, undefined);
assert.equal(said("ses_up3"), "I couldn't start Task ses_up3: Boppy's computer couldn't be set up (Orgo says it's stopped). Bops deleted it, and the next task makes a new one.");
status = "running";
// Deleted on Orgo's site after its setup failed, with the plan read while it was there: Orgo is asked
// again and a new one made, rather than the user told their plan is full.
S.update(() => Object.assign(main(), { computerId: "c-deleted", computerStatus: "error" }));
replies["GET /api/billing/compute-limits"] = () => json(200, { max_computers: 1, computers_used: 1, account_ram_budget_gb: 8, account_ram_used_gb: 8, max_ram_gb: 0 });
L.forgetPlan();
await L.orgoPlan();
replies["GET /api/billing/compute-limits"] = answers("hacker_v2", 1, 0)["GET /api/billing/compute-limits"];
await X.ensureComputer("boppy");
assert.deepEqual({ id: main().computerId, status: main().computerStatus }, { id: "c-up-4", status: "ready" });

// Another user's state is swapped in (a hosted server) while Bops waits on Orgo for this one's computer:
// nothing about it lands in theirs, though their main bot and its task have the same ids.
const box = globalThis.__bops2;
const ours = box.state;
const swap = (to) => {
  box.state = to;
  box.swaps = (box.swaps ?? 0) + 1;
};
let theirs;
S.update(() => Object.assign(main(), { computerId: undefined, computerStatus: "none" }));
task("ses_up5");
replies["POST /api/computers"] = () => {
  swap((theirs = JSON.parse(JSON.stringify(ours))));
  return json(403, { error: "Computer limit reached. Add a slot or delete a computer.", code: "VM_SLOT_ADDON" });
};
await X.ensureComputer("boppy");
assert.equal(S.getState(), theirs);
assert.equal(S.session("ses_up5").status, "queued", "their task is left alone");
assert.equal(S.getState().messages.length, ours.messages.length, "nothing said in their chats");
// Nor is a copy's "no room" note put in their chat.
swap(ours);
S.patchSession("ses_up5", { status: "done" });
S.update(() => Object.assign(main(), { computerId: "c-main", computerStatus: "ready" }));
ownAgain();
replies = {
  ...answers("hacker_v2", 1, 1),
  ...FORK,
  "GET /api/billing/compute-limits": () => {
    if (S.getState() === ours) swap((theirs = JSON.parse(JSON.stringify(ours))));
    return answers("hacker_v2", 1, 1)["GET /api/billing/compute-limits"]();
  },
};
L.forgetPlan();
assert.equal(await L.makeOwnComputer(nova(), main(), "nova-x"), null);
assert.equal(S.getState().messages.length, ours.messages.length, "no note in their chats");
swap(ours);

/* ---------------- The free Bops computer ---------------- */

/**
 * Orgo with free Bops computers (orgo-web's bops_free): compute-limits names the user's free one (null
 * while there's none, and it isn't counted in use), and a create with bops_free makes it when there's
 * none, at the template's size whatever the plan. Otherwise a create is on the plan as before: none on
 * Free, and up to the plan's count.
 */
function freeOrgo(tier, computers, { free = null, inUse = 0 } = {}) {
  const o = { free, inUse, made: 0, alive: new Set(free ? [free] : []) };
  o.replies = {
    ...WORKSPACES,
    "GET /api/user/subscription": () => json(200, { tier, planLimits: null }),
    "GET /api/billing/compute-limits": () =>
      json(200, { max_computers: computers, computers_used: o.inUse, account_ram_budget_gb: POOL[tier], account_ram_used_gb: 8 * o.inUse, max_ram_gb: Math.max(0, Math.min(64, POOL[tier] - 8 * o.inUse)), bops_free_computer_id: o.free && o.alive.has(o.free) ? o.free : null }),
    "POST /api/computers": (c) => {
      if (c.body.bops_free && !(o.free && o.alive.has(o.free))) {
        o.free = `c-free-${++o.made}`;
        o.alive.add(o.free);
        return json(201, { id: o.free, name: c.body.name, status: "creating" });
      }
      if (!computers) return json(403, { error: "Creating a computer requires a paid plan. Upgrade to launch your first computer.", code: "UPGRADE_REQUIRED" });
      if (o.inUse >= computers) return json(403, { error: "Computer limit reached. Add a slot or delete a computer.", code: "VM_SLOT_ADDON" });
      o.inUse++;
      const id = `c-plan-${++o.made}`;
      o.alive.add(id);
      return json(201, { id, name: c.body.name, status: "creating" });
    },
    route: (c) => {
      const [, id, what] = c.path.match(/^\/api\/computers\/([^/]+)(?:\/(\w+))?$/) ?? [];
      if (!o.alive.has(id)) return undefined;
      if (c.method === "GET" && !what) return json(200, { id, status: "running", ram: id.startsWith("c-free") ? 16 : 8, workspace_id: "ws_bops" });
      if (c.method === "DELETE" && !what) return o.alive.delete(id), json(200, { ok: true });
      if (c.method === "GET" && what === "screens") return json(200, { screens: [99, 100, 101, 102].map((d) => ({ id: `s${d}`, display: `:${d}`, width: 1280, height: 960, default: d === 99 })) });
      if (c.method === "POST" && what === "bash") return json(200, { output: "", exit_code: 0 });
      // The free one stays at its size: Orgo says its most is what it has, so Bops never grows it.
      if (c.method === "GET" && what === "resize") return json(200, id.startsWith("c-free") ? { current_disk_gb: 20, max_disk_gb: 20 } : { current_disk_gb: 20, max_disk_gb: 50 });
      if (c.method === "PATCH" && what === "resize") return json(200, { ok: true });
      return undefined;
    },
  };
  replies = o.replies;
  L.forgetPlan();
  return o;
}
const freePlan = (inUse = 0, freeComputerId = null) => ({ tier: "free", name: "Free", computers: 0, inUse, freeComputerId });
// A fresh team in the main workspace, and a second workspace with its own main bot (Kai) and a bot (Lu).
S.update((s) => {
  s.sessions = s.sessions.filter((x) => !["ses_1", "ses_up5"].includes(x.id));
  for (const x of s.sessions) if (T.live(x)) x.status = "done";
  s.bots = s.bots.filter((b) => b.id === "boppy");
  Object.assign(s.bots[0], { computerId: undefined, computerRam: undefined, computerStatus: "none", freeComputer: undefined });
  s.workspaces = [{ id: "ws_main", name: "Main", createdAt: 1 }, { id: "ws_two", name: "Two", createdAt: 2 }];
  s.bots.push({ id: "kai", name: "Kai", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_two" });
  s.bots.push({ id: "lu", name: "Lu", role: "Research", color: "#2EC4B6", isMain: false, computerStatus: "none", computer: "shared", workspaceId: "ws_two" });
  s.chats.push({ id: "bot:kai", kind: "bot", botIds: ["kai"], createdAt: Date.now(), typing: [], workspaceId: "ws_two" });
});
const kai = () => S.bot("kai");

// Read from Orgo: the free one's id, null while there's none; missing (as before) from an Orgo without them.
freeOrgo("free", 0, { free: "c-free-0" });
assert.equal((await L.orgoPlan({ fresh: true })).freeComputerId, "c-free-0");
freeOrgo("free", 0);
assert.deepEqual(plain(await L.orgoPlan({ fresh: true })), { tier: "free", name: "Free", computers: 0, inUse: 0, memory: { total: 4, used: 0, newMax: 4 }, freeComputerId: null });

// The words: on Free with a free Bops computer, "none" is about any more than that one. Nothing stands in
// the main bot's way, and a bot's own copy of it takes one computer, not two.
assert.equal(P.planShortText("none", freePlan()), "Your Orgo Free plan doesn't include computers besides your free Bops one. Orgo Hacker includes 1.");
noDashes(P.planShortText("none", freePlan()));
assert.equal(P.mainComputerShort(freePlan(), team(false), "ws_main"), null, "Free: the main bot gets the free one");
assert.equal(P.setupShort(freePlan(), team(false), team(false)[0]), null);
assert.equal(P.ownComputerShort(freePlan(), team(false), "ws_main").text, "Your Orgo Free plan doesn't include computers besides your free Bops one. Orgo Hacker includes 1.");
assert.equal(P.ownComputerShort({ ...hacker(0), freeComputerId: null }, team(false), "ws_main"), null, "Hacker: the main bot's is free, so a copy fits its one computer");
assert.equal(P.ownComputerShort({ ...hacker(0), freeComputerId: "c-f", memory: { total: 8, used: 0, newMax: 8 } }, team(true, { freeComputer: true }), "ws_main").text, "Your Orgo Hacker plan doesn't have the memory left for another computer. Orgo Startup has more.", "a copy of the free one is 16 GB");
assert.equal(P.bopsComputers([{ computerId: "c-f", freeComputer: true }, { computerId: "c-own" }]), 1, "the free one isn't on the plan");

// Free: the main bot's computer is the free Bops computer, from Orgo's template, at the template's size.
let fo = freeOrgo("free", 0);
const madeFree = await L.makeMainComputer(main(), "boppy-free");
assert.deepEqual(plain(madeFree), { id: "c-free-1", free: true });
assert.deepEqual(calls.filter((c) => c.method === "POST" && c.path === "/api/computers").at(-1).body, { workspace_id: "ws_bops", name: "boppy-free", template_ref: "system/bops-base@0.1.8", bops_free: true });
assert.deepEqual({ id: main().computerId, free: main().freeComputer }, { id: "c-free-1", free: true });
// Another workspace's main bot on Free: no second free one (none is asked for), it works on the free one
// with its team, and its chat says why.
n = asked("POST", "/api/computers");
assert.equal(await L.makeMainComputer(kai(), "kai-a"), null);
assert.equal(asked("POST", "/api/computers"), n);
assert.deepEqual({ computer: kai().computer, status: kai().computerStatus, shares: sharesComputerOf(kai()) }, { computer: "shared", status: "none", shares: true });
assert.equal(workBotOf(kai()).id, "boppy");
assert.equal(workBotOf(S.bot("lu")).id, "boppy", "its team with it");
const kaiNote = S.getState().messages.filter((m) => m.chatId === "bot:kai").at(-1).text;
assert.equal(kaiNote, `I'll work on your free Bops computer, which Boppy has, instead of one of my own. Your Orgo Free plan doesn't include computers besides your free Bops one. Orgo Hacker includes 1. [Upgrade to Orgo Hacker](${URL_PLAN}) Once your Orgo plan has room, you can switch me to Its own under Computer in my Details.`);
noDashes(kaiNote);
assert.equal(P.bopsComputers(S.getState().bots), 0);
// Its own, offered once the plan has room: refused on Free, and on Hacker it goes (its team with it).
assert.deepEqual(await B.setComputer("kai", "own"), { error: "Your Orgo Free plan doesn't include computers besides your free Bops one. Orgo Hacker includes 1." });
assert.deepEqual(await B.setComputer("boppy", "shared"), { error: "Boppy runs the team, so the computer is its own" });
fo = freeOrgo("hacker_v2", 1, { free: "c-free-1" });
assert.deepEqual(await B.setComputer("kai", "own"), { ok: true });
assert.deepEqual({ computer: kai().computer, shares: sharesComputerOf(kai()) }, { computer: undefined, shares: false });
assert.equal(workBotOf(S.bot("lu")).id, "kai");
// Then its own is on the plan, at the plan's size: never a second free one.
const kaiOwn = await L.makeMainComputer(kai(), "kai-b");
assert.deepEqual([kaiOwn.id, kaiOwn.free], ["c-plan-1", undefined]);
assert.deepEqual(calls.at(-1).body, { workspace_id: "ws_bops", name: "kai-b", template_ref: "system/bops-base@0.1.8", ram: 8 });
S.update(() => Object.assign(kai(), { computerId: undefined, computer: undefined }));

// The free one is on Orgo, but no bot here has it (this Mac's state is new): the main bot takes it up again.
S.update(() => Object.assign(main(), { computerId: undefined, freeComputer: undefined }));
fo = freeOrgo("free", 0, { free: "c-free-7" });
n = asked("POST", "/api/computers");
assert.deepEqual(plain(await L.makeMainComputer(main(), "boppy-again")), { id: "c-free-7", free: true });
assert.equal(asked("POST", "/api/computers"), n);
assert.equal(main().freeComputer, true);
// Two main bots at once, with none made yet: one free computer, and the other shares it.
S.update(() => Object.assign(main(), { computerId: undefined, freeComputer: undefined }));
fo = freeOrgo("free", 0);
const atOnce = await Promise.all([L.makeMainComputer(main(), "boppy-1"), L.makeMainComputer(kai(), "kai-1")]);
assert.deepEqual(plain(atOnce), [{ id: "c-free-1", free: true }, null]);
assert.equal(asked("POST", "/api/computers") - n, 1);
assert.equal(kai().computer, "shared");

// Set up end to end: made free, never grown past its size; deleted on Orgo's site, Bops makes it again.
S.update(() => {
  Object.assign(main(), { computerId: undefined, freeComputer: undefined, computerStatus: "none" });
  Object.assign(kai(), { computer: undefined, computerStatus: "none" });
});
fo = freeOrgo("free", 0);
await X.ensureComputer("boppy");
assert.deepEqual({ id: main().computerId, status: main().computerStatus, free: main().freeComputer, ram: main().computerRam }, { id: "c-free-1", status: "ready", free: true, ram: 16 });
assert.equal(asked("PATCH", "/api/computers/c-free-1/resize"), 0, "its disk stays as Orgo has it");
fo.alive.delete("c-free-1");
S.update(() => (main().computerStatus = "error"));
await X.ensureComputer("boppy");
assert.deepEqual({ id: main().computerId, status: main().computerStatus, free: main().freeComputer }, { id: "c-free-2", status: "ready", free: true });
assert.equal(fo.inUse, 0, "nothing on the plan");
// Kai's turn on Free: it shares, and its task's computer is Boppy's.
await X.ensureComputer("kai");
assert.equal(kai().computer, "shared");
assert.equal(workBotOf(kai()).id, "boppy");

console.log(`all plan tests passed (${calls.length} fake Orgo calls, none to the network)`);
// Gone before the store's next save could make the folder again.
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
