// Tests for the People sheet's server: the route the window calls (app/api/members/route.ts, lib/server/members.ts)
// against a fake orgo-web (its /api/workspaces and member routes, and /api/bops/plan), and the words the sheet shows
// (lib/members.ts, lib/plan-includes.ts peopleShort). The workspace is only ever the user's own "bops" one, found and
// never made, whatever the request names; every call runs on the signed-in key alone; changes come only from the Bops
// window; orgo-web's refusals come back in the app's words (plan refusals as 402 with the plan that has room); Full
// access stays off until it's offered, and off while Bops puts its keys on the computers (which the sheet says
// whenever someone has Full access); nobody is added without orgo-web's seats (an orgo-web from before its plan
// rule sends none). Orgo is a fake fetch on a made-up origin, the Keychain a stand-in `security` that has nothing,
// and the state a throwaway file store in a temporary folder: nothing reaches Orgo.
// Usage: node --conditions=react-server scripts/test-members.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A file store, loaded at once and always ready (lib/server/persist.ts); the Mac app's ways (state in Bops Cloud)
// once it's loaded, below.
process.env.BOPS_SELF_HOSTED = "1";
for (const k of [
  "ORGO_API_KEY",
  "BOPS_ORGO_WORKSPACE",
  "BOPS_DATABASE_URL",
  "TAILSCALE_AUTH_KEY",
  "BOPS_COMPUTER_TOOL",
  "BOPS_UI_TOKEN",
  "BOPS_MEMBERS_FULL_ACCESS",
  "AGENTMAIL_API_KEY",
  "OPENAI_API_KEY",
])
  delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
// The Mac app's server listens on this Mac only (desktop/main.cjs): bot computers can't reach it.
process.env.HOSTNAME = "127.0.0.1";
process.env.BOPS_TELEMETRY = "0";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-members-"));
// A `security` that has nothing, first on the PATH: nothing here reads this Mac's Keychain.
mkdirSync(join(scratch, "bin"));
writeFileSync(join(scratch, "bin", "security"), "#!/bin/sh\nexit 44\n");
chmodSync(join(scratch, "bin", "security"), 0o755);
process.env.PATH = `${join(scratch, "bin")}:${process.env.PATH}`;
// Modules that would start processes when loaded are stand-ins whose exports do nothing (as in test-plan.mjs).
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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
process.chdir(scratch);
const KEY = "sk_test_members_key_0123456789";
globalThis.bopsOrgoKey = KEY;

/* ---------------- A fake orgo-web ---------------- */

const calls = [];
/** orgo-web's answers by "METHOD /path"; anything else is a 404. */
let replies = {};
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (not the fake Orgo: ${url})`);
  const text = req.body ? await req.text() : "";
  const call = { method: req.method, path: url.pathname, search: url.search, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined };
  calls.push(call);
  const reply = replies[`${call.method} ${call.path}`];
  return (reply && (await reply(call))) ?? json(404, { error: "Not found" });
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const offline = () => {
  throw new TypeError("fetch failed");
};

const R = await import(`${root}/app/api/members/route.ts`);
const M = await import(`${root}/lib/members.ts`);
const P = await import(`${root}/lib/plan-includes.ts`);
const A = await import(`${root}/cloud/analytics-rules.ts`);
const T = await import(`${root}/cloud/protocol.ts`);
// Loaded: now it's the Mac app, whose state lives in Bops Cloud.
delete process.env.BOPS_SELF_HOSTED;

/** Every error the route said, to hold them all to the app's words. */
const said = new Set();
const route = async (method, body, { query = "", headers = {} } = {}) => {
  const req = new Request(`http://localhost:3210/api/members${query}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await R[method](req);
  const out = { status: res.status, body: await res.json() };
  if (typeof out.body.error === "string") said.add(out.body.error);
  return out;
};
const get = (query = "") => route("GET", undefined, { query });
const noDashes = (text) => assert.ok(!/[–—]/.test(text), `no dashes: ${text}`);
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

const WS = "6b0d3c1e-1111-4000-8000-00000000b0b5";
const OTHERS = [
  // Someone else's "bops" workspace the user is in, and another of the user's own.
  { id: "ws-shared-bops", name: "bops", role: "member", member_count: 4 },
  { id: "ws-work", name: "Work", role: "owner", member_count: 9 },
];
const WORKSPACES = { workspaces: [...OTHERS, { id: WS, name: " Bops ", role: "owner", member_count: 4 }] };
const now = Date.now();
const MEMBERS = [
  { id: "u-owner", alt: "Alex Rivera", role: "owner", email: "alex@example.com" },
  { id: "u-sam", alt: "Sam Park", role: "admin", email: "sam@example.com" },
  { id: "u-jamie", alt: "Jamie Chen", role: "member", email: "jamie@example.com" },
  { id: "u-guest", alt: "Brave Lion", role: "member" },
];
const INVITES = [
  { id: "invite-old@example.com", email: "old@example.com", alt: "old@example.com", role: "admin", status: "pending", token: "tok-old", created_at: iso(now - 9 * DAY), expires_at: iso(now - 2 * DAY), expired: true },
  { id: "invite-pat@example.com", email: "pat@example.com", alt: "pat@example.com", role: "member", status: "pending", token: "tok-pat", created_at: iso(now - DAY), expires_at: iso(now + 6 * DAY), expired: false },
];
const seatsOf = (over = {}) => ({ product: "bops", plan: "max_bops", plan_name: "Max", basis: "bops_plan", limit: 5, used: 4, members: 3, pending: 1, can_add: true, upgrade_tier: null, caps: { pro_bops: 2, max_bops: 5 }, ...over });
let list = { members: MEMBERS, invites: INVITES, seats: seatsOf() };
const usual = () => ({
  "GET /api/workspaces": () => json(200, WORKSPACES),
  [`GET /api/workspaces/${WS}/members`]: () => json(200, list),
  [`POST /api/workspaces/${WS}/invite`]: (c) =>
    json(200, {
      success: true,
      message: "Invitation sent successfully",
      email: c.body.email,
      permission: c.body.permission === "viewer" ? "member" : "admin",
      is_new_user: false,
      accept_url: `https://orgo.test/accept-invite?token=t-new&project_id=${WS}`,
      email_sent: true,
    }),
  [`DELETE /api/workspaces/${WS}/invite`]: () => json(200, { success: true }),
  [`PATCH /api/workspaces/${WS}/members`]: () => json(200, { success: true }),
  [`DELETE /api/workspaces/${WS}/members`]: () => json(200, { success: true }),
});
const memberCalls = () => calls.filter((c) => c.path.startsWith("/api/workspaces/"));
let n;
let r;

/* ---------------- 1. The workspace: the user's own "bops", found, never made ---------------- */

replies = usual();
r = await get();
assert.equal(r.status, 200);
assert.equal(r.body.state, "ready");
assert.deepEqual(
  calls.map((c) => `${c.method} ${c.path}`),
  ["GET /api/workspaces", `GET /api/workspaces/${WS}/members`],
  "the owned workspace named bops (any case, trimmed), not the shared one or another of theirs",
);
assert.ok(
  calls.every((c) => c.auth === `Bearer ${KEY}`),
  "asked with the signed-in key",
);
// The user owns none: nothing to show, and none is made.
replies["GET /api/workspaces"] = () => json(200, { workspaces: OTHERS });
assert.deepEqual((await get()).body, { state: "no_computers" });
replies["GET /api/workspaces"] = () => json(200, { workspaces: [] });
assert.deepEqual((await get()).body, { state: "no_computers" });
n = calls.length;
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code], [409, "NO_COMPUTERS"]);
assert.ok(!calls.some((c) => c.method === "POST" && c.path === "/api/workspaces"), "a workspace is never made");
assert.ok(!calls.slice(n).some((c) => c.path.includes("/invite")), "nobody invited");
console.log("ok - the user's own bops workspace, found and never made");

/* ---------------- 2. Orgo's list in the sheet's shape ---------------- */

replies = usual();
r = await get();
const ready = r.body;
assert.deepEqual(ready.you, { id: "u-owner", name: "Alex Rivera", email: "alex@example.com" }, "the user first");
assert.deepEqual(
  ready.people.map((p) => [p.id, p.name, p.email ?? null, p.role, p.guest]),
  [
    ["u-guest", "Brave Lion", null, "viewer", true],
    ["u-jamie", "Jamie Chen", "jamie@example.com", "viewer", false],
    ["u-sam", "Sam Park", "sam@example.com", "admin", false],
  ],
  "everyone else by name: Orgo's member is View only, and no email is a guest",
);
assert.deepEqual(
  ready.invites.map((i) => [i.email, i.role, i.expired, typeof i.expiresAt]),
  [
    ["pat@example.com", "viewer", false, "number"],
    ["old@example.com", "admin", true, "number"],
  ],
  "invites newest first, with when they expire",
);
assert.equal(ready.invites[0].link, `https://orgo.test/accept-invite?token=tok-pat&project_id=${WS}`, "the accept link on Orgo's origin");
assert.equal(ready.invites[0].expiresAt, Date.parse(INVITES[1].expires_at));
assert.deepEqual(ready.seats, { plan: "max_bops", canAdd: true, limit: 5, used: 4, upgrade: null, caps: { pro_bops: 2, max_bops: 5 } }, "orgo-web's seats as they are");
assert.equal(ready.seatsError, undefined);
assert.equal(ready.orgoUrl, `https://orgo.test/workspaces?project_id=${WS}`);
assert.equal(ready.host, "orgo");
assert.equal(ready.fullAccess, "not_yet", "Full access isn't offered yet");
assert.equal(ready.keysOnComputers, false, "nothing of Bops' on the computers");
assert.ok(!JSON.stringify(ready).includes(KEY), "the key never goes to the window");
// The upgrade orgo-web offers, in the app's words; seats it couldn't read; an orgo-web without times.
list = { ...list, seats: seatsOf({ plan: "pro_bops", limit: 2, used: 4, can_add: false, upgrade_tier: "max_bops" }) };
assert.deepEqual((await get()).body.seats, { plan: "pro_bops", canAdd: false, limit: 2, used: 4, upgrade: "max", caps: { pro_bops: 2, max_bops: 5 } });
list = { ...list, seats: seatsOf({ plan: "free_bops", limit: 0, can_add: false, upgrade_tier: "pro_bops", caps: undefined }) };
assert.deepEqual((await get()).body.seats, { plan: "free_bops", canAdd: false, limit: 0, used: 4, upgrade: "plan", caps: { pro_bops: 2, max_bops: 5 } });
list = { members: MEMBERS, invites: INVITES, seats: null, seats_error: "PLAN_UNAVAILABLE" };
r = await get();
assert.equal(r.body.seats, null);
assert.equal(r.body.seatsError, "PLAN_UNAVAILABLE", "orgo-web couldn't read the plan: adding people waits");
for (const seats of [null, { product: "orgo", plan: "hacker_v2", limit: 1, used: 0, can_add: true }, { plan: "max_bops" }]) {
  list = { members: MEMBERS, invites: INVITES, seats };
  r = await get();
  assert.deepEqual([r.body.seats, r.body.seatsError], [null, "PLAN_UNAVAILABLE"], `orgo-web's seats it can't use: ${JSON.stringify(seats)}`);
}
assert.ok(!calls.some((c) => c.path === "/api/bops/plan"), "the app never reads the plan to stand in for orgo-web's seats");
list = { members: MEMBERS, invites: INVITES.map((i) => ({ id: i.id, email: i.email, alt: i.alt, role: i.role, status: i.status, token: i.token })), seats: seatsOf() };
assert.deepEqual(
  (await get()).body.invites.map((i) => [i.expiresAt, i.expired]),
  [
    [null, false],
    [null, false],
  ],
  "no times from an older orgo-web",
);
// Orgo turned the key down, or didn't answer.
replies[`GET /api/workspaces/${WS}/members`] = () => json(401, { error: "Invalid API key" });
assert.deepEqual((await get()).body, { state: "signed_out", why: "rejected" });
replies = { ...usual(), "GET /api/workspaces": () => json(401, { error: "Invalid API key" }) };
assert.deepEqual((await get()).body, { state: "signed_out", why: "rejected" });
replies = { ...usual(), "GET /api/workspaces": offline };
r = await get();
assert.deepEqual([r.status, r.body.code, r.body.error], [502, "UNREACHABLE", M.WORDS.unreachable]);
replies = { ...usual(), [`GET /api/workspaces/${WS}/members`]: () => json(500, { error: "boom" }) };
r = await get();
assert.deepEqual([r.status, r.body.code, r.body.error], [502, "ORGO_ERROR", M.WORDS.orgoLoadError]);
console.log("ok - the list, the seats and the states");

/* ---------------- 3. A workspace id from the request is never used ---------------- */

list = { members: MEMBERS, invites: INVITES, seats: seatsOf() };
replies = usual();
n = calls.length;
const elsewhere = { workspace_id: "ws-work", project_id: "ws-work", workspaceId: "ws-work", workspace: "ws-work", id: "ws-work" };
await get("?workspace_id=ws-work&project_id=ws-work&id=ws-work");
r = await route("POST", { ...elsewhere, email: "new@example.com", role: "viewer" }, { query: "?workspace_id=ws-work" });
assert.equal(r.status, 200);
r = await route("PATCH", { ...elsewhere, memberId: "u-jamie", role: "viewer" });
assert.equal(r.status, 200);
r = await route("DELETE", { ...elsewhere, memberId: "u-jamie" });
assert.equal(r.status, 200);
r = await route("DELETE", { ...elsewhere, email: "pat@example.com" });
assert.equal(r.status, 200);
const touched = memberCalls().slice(0);
assert.ok(calls.length > n);
assert.ok(
  calls.slice(n).every((c) => c.path === "/api/workspaces" || c.path.startsWith(`/api/workspaces/${WS}/`)),
  `only the user's bops workspace: ${calls
    .slice(n)
    .map((c) => c.path)
    .join(", ")}`,
);
assert.ok(!touched.some((c) => c.path.includes("ws-work")));
console.log("ok - a workspace id from the request is never used");

/* ---------------- 4. Inviting, sending again, changing, removing, cancelling ---------------- */

replies = usual();
n = calls.length;
r = await route("POST", { email: "  New.Person@Example.COM ", role: "viewer" });
assert.deepEqual(r, { status: 200, body: { email: "new.person@example.com", role: "viewer", emailSent: true } }, "no link when Orgo emailed it");
const sent = calls.slice(n).find((c) => c.method === "POST");
assert.deepEqual(sent.body, { email: "new.person@example.com", permission: "viewer" }, "Orgo's invite words: viewer");
assert.equal(sent.path, `/api/workspaces/${WS}/invite`);
// The email didn't go out: the link comes back for the user to send.
replies[`POST /api/workspaces/${WS}/invite`] = (c) =>
  json(200, { success: true, email: c.body.email, permission: "member", email_sent: false, accept_url: `https://orgo.test/accept-invite?token=t2&project_id=${WS}` });
r = await route("POST", { email: "pat@example.com", role: "viewer" });
assert.deepEqual(r.body, { email: "pat@example.com", role: "viewer", emailSent: false, link: `https://orgo.test/accept-invite?token=t2&project_id=${WS}` }, "sent again, and its link");
replies = usual();
// Checked before Orgo is asked: the shape, the user's own email, someone who has access, the role.
n = calls.length;
for (const [body, status, code] of [
  [{ email: "not an email", role: "viewer" }, 400, "BAD_EMAIL"],
  [{ email: "a@b", role: "viewer" }, 400, "BAD_EMAIL"],
  [{ email: "x".repeat(250) + "@example.com", role: "viewer" }, 400, "BAD_EMAIL"],
  [{ email: "new@example.com", role: "owner" }, 400, "BAD_ROLE"],
  [{ email: "new@example.com" }, 400, "BAD_ROLE"],
]) {
  r = await route("POST", body);
  assert.deepEqual([r.status, r.body.code], [status, code], JSON.stringify(body));
}
assert.equal(calls.length, n, "nothing asked of Orgo");
r = await route("POST", { email: "ALEX@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code, r.body.error], [400, "SELF", M.WORDS.self]);
r = await route("POST", { email: "jamie@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code, r.body.error], [409, "ALREADY_IN", "jamie@example.com already has access."]);
assert.ok(!calls.slice(n).some((c) => c.method === "POST"), "neither was sent to Orgo");
// Access: Orgo's words for it are member and admin.
n = calls.length;
r = await route("PATCH", { memberId: "u-sam", role: "viewer" });
assert.deepEqual(r, { status: 200, body: { ok: true } });
assert.deepEqual(calls.at(-1).body, { memberId: "u-sam", role: "member" });
assert.equal(calls.at(-1).method, "PATCH");
for (const body of [{ memberId: "u-sam" }, { memberId: "../u-sam", role: "viewer" }, { memberId: "", role: "viewer" }, { role: "viewer" }]) {
  r = await route("PATCH", body);
  assert.deepEqual([r.status, r.body.code], [400, "BAD_REQUEST"], JSON.stringify(body));
}
// Removing someone, and cancelling an invite.
r = await route("DELETE", { memberId: "u-jamie" });
assert.deepEqual(r, { status: 200, body: { ok: true } });
assert.deepEqual([calls.at(-1).method, calls.at(-1).path, calls.at(-1).body], ["DELETE", `/api/workspaces/${WS}/members`, { memberId: "u-jamie" }]);
r = await route("DELETE", { email: " Pat@Example.com " });
assert.deepEqual(r, { status: 200, body: { ok: true } });
assert.deepEqual([calls.at(-1).method, calls.at(-1).path, calls.at(-1).body], ["DELETE", `/api/workspaces/${WS}/invite`, { email: "pat@example.com" }]);
n = calls.length;
for (const body of [{}, { memberId: "a/b" }, { memberId: "u-jamie/../x", email: "pat@example.com" }, { email: "nope" }]) {
  r = await route("DELETE", body);
  assert.deepEqual([r.status, r.body.code], [400, "BAD_REQUEST"], JSON.stringify(body));
}
assert.equal(calls.length, n);
console.log("ok - invite, send again, change access, remove and cancel");

/* ---------------- 5. orgo-web's refusals, in the app's words ---------------- */

const refusals = [
  // [orgo-web's answer, where (invite or PATCH), the route's status, code, extra]
  [() => json(403, { error: "x", code: "UPGRADE_REQUIRED", upgradeTier: "pro_bops" }), "invite", 402, "UPGRADE_REQUIRED", { upgrade: "plan", error: M.WORDS.upgradeRequired }],
  [() => json(403, { error: "x", code: "SEAT_LIMIT", limit: 2, used: 2, upgradeTier: "max_bops" }), "invite", 402, "SEAT_LIMIT", { upgrade: "max", limit: 2, used: 2 }],
  [() => json(403, { error: "x", code: "SEAT_LIMIT", limit: 5, used: 5, upgradeTier: null }), "invite", 402, "SEAT_LIMIT", { upgrade: null, limit: 5, used: 5 }],
  [() => json(403, { error: "x", code: "WORKSPACE_PLAN_REQUIRED" }), "invite", 402, "UPGRADE_REQUIRED", { upgrade: "plan" }],
  [() => json(503, { error: "x", code: "PLAN_UNAVAILABLE" }), "invite", 503, "PLAN_UNAVAILABLE", { error: M.WORDS.planUnavailableShort }],
  [() => json(429, { error: "x", code: "INVITE_RATE_LIMITED" }), "invite", 429, "INVITE_RATE_LIMITED", { error: M.WORDS.rateLimited }],
  [() => json(400, { error: "User is already a member of this project" }), "invite", 409, "ALREADY_IN", { error: "new@example.com already has access." }],
  [() => json(400, { error: "You cannot invite yourself to the project" }), "invite", 400, "SELF", {}],
  [() => json(400, { error: "Valid email address is required" }), "invite", 400, "BAD_EMAIL", {}],
  // /invite's 401: only "Invalid API key" is the key; its gate's other refusals came as 401 too.
  [() => json(401, { error: "Invalid API key" }), "invite", 401, "SIGNED_OUT", { why: "rejected", error: M.WORDS.rejected }],
  [() => json(401, { error: "This workspace is view-only. Ask the owner for write access (workspace_read_only)." }), "invite", 403, "NOT_OWNER", { error: M.WORDS.notOwner }],
  [() => json(401, { error: "Service temporarily unavailable. The database is not accepting requests. Retry shortly." }), "invite", 403, "NOT_OWNER", {}],
  [() => json(403, { error: "Only project owners can invite members" }), "invite", 403, "NOT_OWNER", {}],
  [offline, "invite", 502, "UNREACHABLE", { error: M.WORDS.unreachable }],
  [() => json(500, { error: "boom" }), "invite", 502, "ORGO_ERROR", { error: M.WORDS.orgoError }],
  [() => new Response("<html>", { status: 502 }), "invite", 502, "ORGO_ERROR", {}],
  [() => json(404, { error: "Member not found" }), "patch", 404, "GONE", { error: M.WORDS.gone }],
  [() => json(401, { error: "Unauthorized" }), "patch", 401, "SIGNED_OUT", { why: "rejected" }],
  [() => json(403, { error: "Only project owners can change roles" }), "patch", 403, "NOT_OWNER", {}],
  [offline, "patch", 502, "UNREACHABLE", {}],
];
for (const [answer, where, status, code, extra] of refusals) {
  replies = usual();
  if (where === "invite") replies[`POST /api/workspaces/${WS}/invite`] = answer;
  else replies[`PATCH /api/workspaces/${WS}/members`] = answer;
  r = where === "invite" ? await route("POST", { email: "new@example.com", role: "viewer" }) : await route("PATCH", { memberId: "u-jamie", role: "viewer" });
  assert.equal(r.status, status, `${where} ${code}`);
  assert.equal(r.body.code, code, `${where} ${code}`);
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(r.body[k], v, `${where} ${code} ${k}`);
  assert.ok(typeof r.body.error === "string" && r.body.error, `${code} says why`);
}
// The invite list or plan refusing the whole thing: cancel and remove too.
replies = { ...usual(), [`DELETE /api/workspaces/${WS}/invite`]: () => json(401, { error: "Invalid API key" }) };
r = await route("DELETE", { email: "pat@example.com" });
assert.deepEqual([r.status, r.body.code], [401, "SIGNED_OUT"]);
replies = { ...usual(), [`DELETE /api/workspaces/${WS}/members`]: () => json(400, { error: "Cannot remove the project owner" }) };
r = await route("DELETE", { memberId: "u-owner" });
assert.deepEqual([r.status, r.body.code], [502, "ORGO_ERROR"]);
console.log("ok - orgo-web's refusals in the app's words");

/* ---------------- 6. Nobody is added without orgo-web's seats ---------------- */

// An orgo-web from before its plan rule sends the list with no seats: nothing there holds the workspace to a plan,
// and its timeline shows View only the commands the bots run. Nobody is added from Bops then, not even by sending a
// waiting invite again, and the app never reads the plan to guess for it. Taking access away still works.
const noSeats = (people, invites) => ({ members: [MEMBERS[0], ...people], invites });
const pending = (email, ms = now + 3 * DAY) => ({ email, role: "member", status: "pending", token: `t-${email}`, expires_at: iso(ms), expired: ms <= now });
const invited = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/invite"));
replies = { ...usual(), "GET /api/bops/plan": () => json(200, { tier: "max_bops" }) };
list = noSeats([MEMBERS[1], MEMBERS[2]], [pending("pat@example.com")]);
n = calls.length;
const before = invited().length;
r = await get();
assert.equal(r.status, 200);
assert.deepEqual([r.body.state, r.body.seats, r.body.seatsError], ["ready", null, "ORGO_NOT_READY"], "no seats from orgo-web: adding waits for it");
assert.deepEqual(
  r.body.people.map((p) => p.id),
  ["u-jamie", "u-sam"],
  "who has access still shows",
);
for (const [body, what] of [
  [{ email: "new@example.com", role: "viewer" }, "a new invite"],
  [{ email: "pat@example.com", role: "viewer" }, "a waiting invite sent again"],
  [{ email: "Lee@Example.com", role: "viewer" }, "another address"],
]) {
  r = await route("POST", body);
  assert.deepEqual([r.status, r.body.code, r.body.error], [503, "ORGO_NOT_READY", M.WORDS.orgoNotReadyShort], what);
}
assert.equal(invited().length, before, "nobody invited");
r = await route("PATCH", { memberId: "u-sam", role: "viewer" });
assert.equal(r.status, 200, "moving someone to View only");
r = await route("DELETE", { memberId: "u-jamie" });
assert.equal(r.status, 200, "removing someone");
r = await route("DELETE", { email: "pat@example.com" });
assert.equal(r.status, 200, "cancelling an invite");
assert.ok(!calls.slice(n).some((c) => c.path === "/api/bops/plan"), "the plan is never read to stand in for orgo-web's seats");
// seats_error alone: orgo-web's rule couldn't read the plan. Adding waits too, and says why.
list = { ...noSeats([], []), seats_error: "PLAN_UNAVAILABLE" };
r = await get();
assert.deepEqual([r.body.seats, r.body.seatsError], [null, "PLAN_UNAVAILABLE"]);
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code, r.body.error], [503, "PLAN_UNAVAILABLE", M.WORDS.planUnavailableShort]);
assert.equal(invited().length, before, "nobody invited without the plan");
// orgo-web's own seats: it decides (here, a waiting invite sent again with every seat taken).
list = { ...noSeats([MEMBERS[2]], [pending("pat@example.com")]), seats: seatsOf({ plan: "pro_bops", limit: 2, used: 2, can_add: false, upgrade_tier: "max_bops" }) };
replies = usual();
r = await route("POST", { email: "pat@example.com", role: "viewer" });
assert.equal(r.status, 200, "orgo-web decides");
assert.equal(invited().length, before + 1);
console.log("ok - nobody is added without orgo-web's seats");

/* ---------------- 7. Full access ---------------- */

list = { members: MEMBERS, invites: INVITES, seats: seatsOf() };
replies = usual();
// Not offered yet: View only only, and moving someone to View only always works.
n = invited().length;
r = await route("POST", { email: "new@example.com", role: "admin" });
assert.deepEqual([r.status, r.body.code, r.body.error], [409, "FULL_ACCESS_NOT_YET", M.WORDS.fullAccessNotYet]);
r = await route("PATCH", { memberId: "u-jamie", role: "admin" });
assert.deepEqual([r.status, r.body.code], [409, "FULL_ACCESS_NOT_YET"]);
assert.equal(invited().length, n);
assert.equal(calls.at(-1).method === "PATCH", false, "nothing changed on Orgo");
// Bops' own keys on the computers are said even while Full access isn't offered: people added on orgo.ai can have it.
for (const [k, v] of [
  ["HOSTNAME", "0.0.0.0"],
  ["TAILSCALE_AUTH_KEY", "tskey-auth-example"],
  ["BOPS_COMPUTER_TOOL", "0"],
]) {
  const was = process.env[k];
  process.env[k] = v;
  r = await get();
  assert.deepEqual([r.body.fullAccess, r.body.keysOnComputers], ["not_yet", true], k);
  if (was === undefined) delete process.env[k];
  else process.env[k] = was;
}
// Offered (BOPS_MEMBERS_FULL_ACCESS=1), and nothing of Bops' on the computers: on.
process.env.BOPS_MEMBERS_FULL_ACCESS = "1";
r = await get();
assert.deepEqual([r.body.fullAccess, r.body.keysOnComputers], ["on", false]);
r = await route("POST", { email: "new@example.com", role: "admin" });
assert.equal(r.status, 200);
assert.deepEqual(calls.filter((c) => c.method === "POST").at(-1).body, { email: "new@example.com", permission: "admin" }, "Orgo's invite words: admin");
r = await route("PATCH", { memberId: "u-jamie", role: "admin" });
assert.equal(r.status, 200);
assert.deepEqual(calls.at(-1).body, { memberId: "u-jamie", role: "admin" });
// Off while Bops puts keys of its own on the computers: listening beyond this Mac, Tailscale's key, the executor's.
for (const [k, v] of [
  ["HOSTNAME", "0.0.0.0"],
  ["TAILSCALE_AUTH_KEY", "tskey-auth-example"],
  ["BOPS_COMPUTER_TOOL", "0"],
]) {
  const was = process.env[k];
  process.env[k] = v;
  r = await get();
  assert.deepEqual([r.body.fullAccess, r.body.keysOnComputers], ["off", true], k);
  n = calls.length;
  r = await route("POST", { email: "new@example.com", role: "admin" });
  assert.deepEqual([r.status, r.body.code], [409, "FULL_ACCESS_OFF"], k);
  r = await route("PATCH", { memberId: "u-jamie", role: "admin" });
  assert.deepEqual([r.status, r.body.code], [409, "FULL_ACCESS_OFF"], k);
  assert.equal(calls.length, n, `${k}: Orgo isn't asked`);
  r = await route("POST", { email: "new@example.com", role: "viewer" });
  assert.equal(r.status, 200, `${k}: View only still works`);
  r = await route("PATCH", { memberId: "u-sam", role: "viewer" });
  assert.equal(r.status, 200, `${k}: moving someone to View only still works`);
  if (was === undefined) delete process.env[k];
  else process.env[k] = was;
}
delete process.env.BOPS_MEMBERS_FULL_ACCESS;
assert.equal(M.FULL_ACCESS_IN_BOPS, false, "this release adds people with View only");
console.log("ok - Full access: not yet, on, and off while Bops' keys are on the computers");

/* ---------------- 8. Only the Bops window, only the signed-in key, only Bops Cloud ---------------- */

replies = usual();
process.env.BOPS_UI_TOKEN = "window-token-0123456789abcdef";
n = calls.length;
for (const [method, body] of [
  ["POST", { email: "new@example.com", role: "viewer" }],
  ["PATCH", { memberId: "u-jamie", role: "viewer" }],
  ["DELETE", { memberId: "u-jamie" }],
  ["DELETE", { email: "pat@example.com" }],
]) {
  r = await route(method, body);
  assert.deepEqual([r.status, r.body.code, r.body.error], [403, "WINDOW_ONLY", M.WORDS.windowOnly], method);
  r = await route(method, body, { headers: { "x-bops-window": "window-token-0123456789abcdeX" } });
  assert.equal(r.status, 403, `${method}: the wrong token`);
}
assert.equal(calls.length, n, "nothing asked of Orgo");
r = await route("DELETE", { email: "pat@example.com" }, { headers: { "x-bops-window": "window-token-0123456789abcdef" } });
assert.equal(r.status, 200, "the window's own token");
r = await route("DELETE", { email: "pat@example.com" }, { headers: { cookie: "a=b; bops_window=window-token-0123456789abcdef" } });
assert.equal(r.status, 200, "the window's cookie");
assert.equal((await get()).status, 200, "reading isn't a change (proxy.ts holds reads to the window)");
delete process.env.BOPS_UI_TOKEN;
// No signed-in key: ORGO_API_KEY (a self-hoster's) and the Orgo CLI's login are never used.
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Date.now();
process.env.ORGO_API_KEY = "sk_live_not_the_users_0123456789";
n = calls.length;
assert.deepEqual((await get()).body, { state: "signed_out", why: "no_key" });
assert.deepEqual((await get("?count=1")).body, { state: "signed_out" });
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code, r.body.why], [401, "SIGNED_OUT", "no_key"]);
r = await route("DELETE", { memberId: "u-jamie" });
assert.equal(r.status, 401);
assert.equal(calls.length, n, "no key, no call");
delete process.env.ORGO_API_KEY;
globalThis.bopsOrgoKey = KEY;
// Self-hosted (and hosted): people are added on orgo.ai, and Orgo isn't asked.
process.env.BOPS_SELF_HOSTED = "1";
n = calls.length;
assert.deepEqual((await get()).body, { state: "self_hosted", orgoUrl: "https://orgo.test/workspaces" });
assert.deepEqual((await get("?count=1")).body, { state: "self_hosted" });
for (const [method, body] of [
  ["POST", { email: "new@example.com", role: "viewer" }],
  ["PATCH", { memberId: "u-jamie", role: "viewer" }],
  ["DELETE", { memberId: "u-jamie" }],
]) {
  r = await route(method, body);
  assert.deepEqual([r.status, r.body.code], [409, "SELF_HOSTED"], method);
}
assert.equal(calls.length, n, "self-hosted: nothing asked of Orgo");
delete process.env.BOPS_SELF_HOSTED;
console.log("ok - only the Bops window, the signed-in key and Bops Cloud");

/* ---------------- 9. The count on the button ---------------- */

replies = usual();
// Read again by the list above; a change forgets it.
await route("DELETE", { email: "pat@example.com" });
n = calls.length;
assert.deepEqual((await get("?count=1")).body, { count: 3 }, "member_count less the user");
assert.deepEqual(
  calls.slice(n).map((c) => c.path),
  ["/api/workspaces"],
);
n = calls.length;
assert.deepEqual((await get("?count=1")).body, { count: 3 });
assert.equal(calls.length, n, "kept for 30 seconds");
await route("PATCH", { memberId: "u-jamie", role: "viewer" });
await route("DELETE", { memberId: "u-guest" });
n = calls.length;
await get("?count=1");
assert.ok(calls.length > n, "a removal is counted again");
// The sheet's own read sets it too.
list = { members: MEMBERS.slice(0, 2), invites: [], seats: seatsOf() };
await get();
n = calls.length;
assert.deepEqual((await get("?count=1")).body, { count: 1 });
assert.equal(calls.length, n);
// An orgo-web without member_count: counted from the list.
await route("DELETE", { memberId: "u-guest" });
replies["GET /api/workspaces"] = () => json(200, { workspaces: [{ id: WS, name: "bops", role: "owner" }] });
list = { members: MEMBERS, invites: [], seats: seatsOf() };
assert.deepEqual((await get("?count=1")).body, { count: 3 });
await route("DELETE", { memberId: "u-guest" });
replies["GET /api/workspaces"] = () => json(200, { workspaces: [] });
assert.deepEqual((await get("?count=1")).body, { state: "no_computers" });
replies["GET /api/workspaces"] = offline;
assert.deepEqual((await get("?count=1")).body, { state: "unknown" });
// Another user's key: never the last one's count.
replies = usual();
list = { members: MEMBERS, invites: [], seats: seatsOf() };
await get();
globalThis.bopsOrgoKey = "sk_test_someone_else_0123456789";
n = calls.length;
await get("?count=1");
assert.ok(calls.length > n, "asked again for another key");
assert.ok(calls.slice(n).every((c) => c.auth === "Bearer sk_test_someone_else_0123456789"));
globalThis.bopsOrgoKey = KEY;
console.log("ok - the count on the People button");

/* ---------------- 10. A kept workspace id that's gone ---------------- */

replies = { ...usual(), "GET /api/workspaces/ws-gone/members": () => json(403, { error: "You do not have access to this workspace." }) };
globalThis.bopsOrgoWorkspace = Promise.resolve("ws-gone");
n = calls.length;
r = await get();
assert.equal(r.body.state, "ready");
assert.deepEqual(
  calls.slice(n).map((c) => c.path),
  ["/api/workspaces/ws-gone/members", "/api/workspaces", `/api/workspaces/${WS}/members`],
  "bopsWorkspace's id first, then looked up again once",
);
// A change always looks it up now, never on a kept id.
n = calls.length;
await route("DELETE", { memberId: "u-guest" });
assert.deepEqual(
  calls.slice(n).map((c) => c.path),
  ["/api/workspaces", `/api/workspaces/${WS}/members`],
);
globalThis.bopsOrgoWorkspace = undefined;
console.log("ok - a kept workspace id that's gone is looked up again");

/* ---------------- 10b. Access to the workspace's bots ---------------- */

// Kept on the Bops workspace whose sheet it is (the one findBopsWorkspace is asked for: here the default), by email or
// a guest's "user:<id>", once Orgo has the invite or the change; never a key the window sent; gone with the person.
const S = await import(`${root}/lib/server/store.ts`);
const W = await import(`${root}/lib/server/workspaces.ts`);
const sheetWs = () => S.getState().workspace ?? "ws_main";
/** Each entry's levels (when it was set, MemberAccess.at and invite, is checked on its own below). */
const levels = (map) => map && Object.fromEntries(Object.entries(map).map(([k, a]) => [k, { others: a.others, bots: a.bots }]));
const rawKept = () => S.getState().workspaces?.find((w) => w.id === sheetWs())?.memberAccess;
const kept = () => levels(rawKept());
const NONE = { others: "none", bots: {} };
/** Each person's bot levels as the sheet reads them (Your Apps, also there, is checked on its own below). */
const botsOnly = (a) => a && { others: a.others, bots: a.bots };
const accessOf = (body) => Object.fromEntries([...body.people.map((p) => [p.id, botsOnly(p.access)]), ...body.invites.map((i) => [i.email, botsOnly(i.access)])]);
const appsLevels = (body) => Object.fromEntries([...body.people.map((p) => [p.id, p.access.apps]), ...body.invites.map((i) => [i.email, i.access.apps])]);
replies = usual();
list = { members: MEMBERS, invites: INVITES, seats: seatsOf() };
assert.equal(kept(), undefined, "nothing kept yet");
r = await get();
assert.deepEqual(accessOf(r.body), { "u-guest": NONE, "u-jamie": NONE, "u-sam": NONE, "pat@example.com": NONE, "old@example.com": NONE }, "nobody kept: no bot for anyone");
// Inviting with access: kept once Orgo has the invite, cleaned (a level that isn't one is none, a bot at `others`' level
// isn't named, ids that couldn't be a bot's are dropped).
n = calls.length;
r = await route("POST", {
  email: " Lee@Example.COM ",
  role: "viewer",
  access: { others: "read", bots: { boppy: "write", otto: "none", rook: "read", iris: "admin", ["x".repeat(81)]: "write", "": "write" } },
});
assert.equal(r.status, 200);
assert.deepEqual(r.body, { email: "lee@example.com", role: "viewer", emailSent: true }, "the answer is as before");
assert.deepEqual(kept(), { "lee@example.com": { others: "read", bots: { boppy: "write", otto: "none", iris: "none" } } }, "kept by email, cleaned");
assert.ok(
  calls.slice(n).every((c) => !JSON.stringify(c.body ?? {}).includes("boppy")),
  "bot access never goes to Orgo",
);
// The sheet reads it back on the invite.
list = { ...list, invites: [...INVITES, pending("lee@example.com")] };
r = await get();
assert.deepEqual(accessOf(r.body)["lee@example.com"], { others: "read", bots: { boppy: "write", otto: "none", iris: "none" } });
assert.deepEqual(accessOf(r.body)["pat@example.com"], NONE);
// Sent again without access: what was kept stays. Sent again with it: replaced.
r = await route("POST", { email: "lee@example.com", role: "viewer" });
assert.equal(r.status, 200);
assert.deepEqual(kept()["lee@example.com"], { others: "read", bots: { boppy: "write", otto: "none", iris: "none" } }, "a resend keeps it");
r = await route("POST", { email: "lee@example.com", role: "viewer", access: { others: "none", bots: { boppy: "read" } } });
assert.deepEqual(kept()["lee@example.com"], { others: "none", bots: { boppy: "read" } }, "a resend with access replaces it");
// A new invite without access keeps nothing (an entry from before, from someone removed while Orgo didn't list, goes).
W.setMemberAccess(sheetWs(), "kim@example.com", { others: "write", bots: {} });
r = await route("POST", { email: "kim@example.com", role: "viewer" });
assert.equal(r.status, 200);
assert.equal(kept()["kim@example.com"], undefined, "a new invite without access: they see no bot");
// Access that shows no bot is no entry.
r = await route("POST", { email: "kim@example.com", role: "viewer", access: { others: "none", bots: { boppy: "none" } } });
assert.equal(r.status, 200);
assert.ok(!Object.hasOwn(kept(), "kim@example.com"), "no empty entries");
// Orgo turned the invite down: nothing kept.
replies[`POST /api/workspaces/${WS}/invite`] = () => json(429, { error: "x", code: "INVITE_RATE_LIMITED" });
r = await route("POST", { email: "ray@example.com", role: "viewer", access: { others: "read", bots: {} } });
assert.equal(r.status, 429);
assert.equal(kept()["ray@example.com"], undefined, "kept only once Orgo has the invite");
replies = usual();
// Access that isn't access: turned down before Orgo is asked.
n = calls.length;
for (const access of ["write", ["read"], null, 7]) {
  r = await route("POST", { email: "ray@example.com", role: "viewer", access });
  assert.deepEqual([r.status, r.body.code], [400, "BAD_ACCESS"], JSON.stringify(access));
}
assert.equal(calls.length, n, "nothing asked of Orgo");
// An invite still waiting gets other bots without being sent again (the team chart's Make it theirs): kept as the invite's,
// from when it was first kept; one Orgo doesn't list as waiting is gone.
const sentBefore = calls.filter((c) => c.method === "POST").length;
const lee = kept()["lee@example.com"];
const leeAt = rawKept()["lee@example.com"].at;
await new Promise((res) => setTimeout(res, 5));
r = await route("PATCH", { invite: "Lee@example.com", access: { others: "none", bots: { rook: "read" } } });
assert.deepEqual(r, { status: 200, body: { ok: true } });
assert.deepEqual(kept()["lee@example.com"], { others: "none", bots: { rook: "read" } });
assert.deepEqual([rawKept()["lee@example.com"].invite, rawKept()["lee@example.com"].at], [true, leeAt], "still the invite's, from when it was sent");
assert.equal(calls.filter((c) => c.method === "POST").length, sentBefore, "not sent again");
r = await route("PATCH", { invite: "nobody@example.com", access: { others: "none", bots: { rook: "read" } } });
assert.deepEqual([r.status, r.body.code], [404, "GONE"]);
r = await route("PATCH", { invite: "lee@example.com", access: "write" });
assert.deepEqual([r.status, r.body.code], [400, "BAD_ACCESS"]);
r = await route("PATCH", { invite: "lee@example.com", access: lee });
assert.deepEqual(kept()["lee@example.com"], lee, "put back");
console.log("ok - bot access: invite, send again, cleaned");

/* ---------------- 10c. Your Apps: a level of its own on each entry ---------------- */
{
  const raw = (k) => rawKept()[k];
  r = await get();
  assert.ok(Object.values(appsLevels(r.body)).every((v) => v === undefined || v === "none" || v === "read" || v === "write"), "the sheet reads a level, or none set yet");
  // Sent with the bots: kept. A save that sends only bots keeps the level that was there.
  W.setMemberAccess(sheetWs(), "ann@example.com", { others: "none", bots: { boppy: "read" }, apps: "write" });
  assert.equal(raw("ann@example.com").apps, "write");
  W.setMemberAccess(sheetWs(), "ann@example.com", { others: "none", bots: { boppy: "write" } });
  assert.deepEqual([raw("ann@example.com").apps, raw("ann@example.com").bots], ["write", { boppy: "write" }], "kept when none is sent");
  // Never a level nobody picked: one not sent and not kept stays unset (the sheet says "not set"; giveAppsRead gives Read once).
  W.setMemberAccess(sheetWs(), "bo@example.com", { others: "read", bots: {} });
  assert.equal("apps" in raw("bo@example.com"), false);
  W.setMemberAccess(sheetWs(), "bo@example.com", { others: "write", bots: {} });
  assert.equal("apps" in raw("bo@example.com"), false, "a later save of the bots doesn't make it None");
  // Your Apps comes with a bot: with no bot, no entry (a Bops from before would delete it, and nothing of the workspace opens for them).
  W.setMemberAccess(sheetWs(), "cy@example.com", { others: "none", bots: {}, apps: "read" });
  assert.equal(raw("cy@example.com"), undefined, "only Your Apps: no entry");
  W.setMemberAccess(sheetWs(), "cy@example.com", { others: "none", bots: { boppy: "read" }, apps: "read" });
  assert.equal(raw("cy@example.com").apps, "read");
  W.setMemberAccess(sheetWs(), "cy@example.com", { others: "none", bots: {}, apps: "read" });
  assert.equal(raw("cy@example.com"), undefined, "every bot taken away: the entry goes, Your Apps with it");
  // Through the route: a level that isn't one is left out, and the kept one stays.
  r = await route("PATCH", { invite: "lee@example.com", access: { ...lee, apps: "write" } });
  assert.equal(r.status, 200);
  assert.equal(raw("lee@example.com").apps, "write");
  r = await route("PATCH", { invite: "lee@example.com", access: { ...lee, apps: "admin" } });
  assert.equal(raw("lee@example.com").apps, "write", "not a level: the one kept stays");
  r = await get();
  assert.equal(appsLevels(r.body)["lee@example.com"], "write", "the sheet reads it back");
  // Everyone already shared with: Read once, marked; a second run, or an entry a Bops from before rewrote later, gets nothing.
  S.update((st) => {
    const w = st.workspaces.find((x) => x.id === sheetWs());
    delete w.appsScopeAt;
    w.memberAccess = { ...w.memberAccess, "old@example.com": { others: "read", bots: {}, at: 5 }, "ann@example.com": { ...w.memberAccess["ann@example.com"], apps: "none" } };
  });
  const gave = W.giveAppsRead(1234);
  assert.ok(gave >= 1);
  assert.deepEqual([raw("old@example.com").apps, raw("old@example.com").at], ["read", 5], "Read, its `at` kept (still the same membership)");
  assert.equal(raw("ann@example.com").apps, "none", "an entry with a level is never touched");
  assert.equal(S.getState().workspaces.find((x) => x.id === sheetWs()).appsScopeAt, 1234);
  S.update((st) => void (st.workspaces.find((x) => x.id === sheetWs()).memberAccess["old@example.com"] = { others: "read", bots: {}, at: 6 }));
  assert.equal(W.giveAppsRead(), 0, "once only");
  assert.equal(raw("old@example.com").apps, undefined);
  W.setMemberAccess(sheetWs(), "old@example.com", null);
  for (const k of ["ann@example.com", "bo@example.com"]) W.setMemberAccess(sheetWs(), k, null);
}
console.log("ok - Your Apps: kept, kept when not sent, never None unpicked, only with a bot, Read once for everyone already here");

// Changing: access only, by the member as Orgo lists them; never a key the window sent.
n = calls.length;
r = await route("PATCH", { memberId: "u-jamie", email: "sam@example.com", key: "sam@example.com", access: { others: "none", bots: { boppy: "read" } } });
assert.deepEqual(r, { status: 200, body: { ok: true } });
assert.deepEqual(
  calls.slice(n).map((c) => `${c.method} ${c.path}`),
  ["GET /api/workspaces", `GET /api/workspaces/${WS}/members`],
  "access only: Orgo's list read, no role sent",
);
assert.deepEqual(kept()["jamie@example.com"], { others: "none", bots: { boppy: "read" } }, "kept under the member's own email");
assert.equal(kept()["sam@example.com"], undefined, "never the window's key");
// A guest has no email: kept by their user id.
r = await route("PATCH", { memberId: "u-guest", access: { others: "read", bots: {} } });
assert.equal(r.status, 200);
assert.deepEqual(kept()["user:u-guest"], { others: "read", bots: {} });
r = await get();
assert.deepEqual(accessOf(r.body)["u-guest"], { others: "read", bots: {} }, "a guest's, read back by id");
assert.deepEqual(accessOf(r.body)["u-jamie"], { others: "none", bots: { boppy: "read" } }, "a member's, read back by email");
assert.deepEqual(accessOf(r.body)["u-sam"], NONE);
// Orgo's email in another case reads the same entry.
list = { ...list, members: MEMBERS.map((m) => (m.id === "u-jamie" ? { ...m, email: "Jamie@Example.com" } : m)) };
assert.deepEqual(accessOf((await get()).body)["u-jamie"], { others: "none", bots: { boppy: "read" } }, "by email, any case");
list = { ...list, members: MEMBERS };
// Role and access together: the role goes to Orgo first, and access is kept only once Orgo took it.
r = await route("PATCH", { memberId: "u-sam", role: "viewer", access: { others: "write", bots: {} } });
assert.equal(r.status, 200);
assert.deepEqual([calls.at(-1).method, calls.at(-1).body], ["PATCH", { memberId: "u-sam", role: "member" }]);
assert.deepEqual(kept()["sam@example.com"], { others: "write", bots: {} });
replies[`PATCH /api/workspaces/${WS}/members`] = () => json(403, { error: "Only project owners can change roles" });
r = await route("PATCH", { memberId: "u-sam", role: "viewer", access: { others: "none", bots: { otto: "read" } } });
assert.deepEqual([r.status, r.body.code], [403, "NOT_OWNER"]);
assert.deepEqual(kept()["sam@example.com"], { others: "write", bots: {} }, "Orgo turned the role down: access unchanged");
replies = usual();
// Someone Orgo doesn't list, the user, or access that isn't access.
n = calls.length;
r = await route("PATCH", { memberId: "u-nobody", access: { others: "read", bots: {} } });
assert.deepEqual([r.status, r.body.code, r.body.error], [404, "GONE", M.WORDS.gone]);
r = await route("PATCH", { memberId: "u-nobody", role: "viewer", access: { others: "read", bots: {} } });
assert.deepEqual([r.status, r.body.code], [404, "GONE"]);
assert.ok(!calls.slice(n).some((c) => c.method === "PATCH"), "no role sent for someone not there");
assert.ok(!Object.keys(kept()).some((k) => k.includes("nobody")), "nothing kept for them");
r = await route("PATCH", { memberId: "u-owner", access: { others: "read", bots: {} } });
assert.deepEqual([r.status, r.body.code], [400, "SELF"], "the user always has every bot");
n = calls.length;
for (const [body, code] of [
  [{ memberId: "u-jamie", access: "write" }, "BAD_ACCESS"],
  [{ memberId: "u-jamie", access: null }, "BAD_ACCESS"],
  [{ memberId: "u-jamie", role: "owner", access: { others: "read", bots: {} } }, "BAD_REQUEST"],
  [{ memberId: "u-jamie", role: null }, "BAD_REQUEST"],
  [{ access: { others: "read", bots: {} } }, "BAD_REQUEST"],
]) {
  r = await route("PATCH", body);
  assert.deepEqual([r.status, r.body.code], [400, code], JSON.stringify(body));
}
assert.equal(calls.length, n, "nothing asked of Orgo");
// Access that shows no bot: their entry goes.
r = await route("PATCH", { memberId: "u-guest", access: { others: "none", bots: { boppy: "none" } } });
assert.equal(r.status, 200);
assert.ok(!Object.hasOwn(kept(), "user:u-guest"), "no empty entries");
// An entry kept by their id from before Orgo listed their email never shows through once it's kept by email.
W.setMemberAccess(sheetWs(), "user:u-jamie", { others: "write", bots: {} });
r = await route("PATCH", { memberId: "u-jamie", access: { others: "none", bots: {} } });
assert.equal(r.status, 200);
assert.ok(!Object.hasOwn(kept(), "user:u-jamie") && !Object.hasOwn(kept(), "jamie@example.com"));
assert.deepEqual(accessOf((await get()).body)["u-jamie"], NONE, "no bot");
console.log("ok - bot access: changed by the member Orgo lists, alone or with the role");

// Removing and cancelling: their entries go once Orgo did it.
W.setMemberAccess(sheetWs(), "jamie@example.com", { others: "read", bots: {} });
W.setMemberAccess(sheetWs(), "user:u-guest", { others: "read", bots: {} });
W.setMemberAccess(sheetWs(), "user:u-sam", { others: "read", bots: {} });
replies[`DELETE /api/workspaces/${WS}/members`] = () => json(400, { error: "Cannot remove the project owner" });
r = await route("DELETE", { memberId: "u-jamie" });
assert.equal(r.status, 502);
assert.ok(Object.hasOwn(kept(), "jamie@example.com"), "Orgo didn't remove them: kept");
replies = usual();
n = calls.length;
r = await route("DELETE", { memberId: "u-jamie" });
assert.equal(r.status, 200);
assert.deepEqual(
  calls.slice(n).map((c) => `${c.method} ${c.path}`),
  ["GET /api/workspaces", `GET /api/workspaces/${WS}/members`, `DELETE /api/workspaces/${WS}/members`],
  "who they are read before they go",
);
assert.ok(!Object.hasOwn(kept(), "jamie@example.com"), "a member's goes");
r = await route("DELETE", { memberId: "u-guest" });
assert.ok(!Object.hasOwn(kept(), "user:u-guest"), "a guest's goes");
r = await route("DELETE", { memberId: "u-sam" });
assert.ok(!Object.hasOwn(kept(), "sam@example.com") && !Object.hasOwn(kept(), "user:u-sam"), "by email and by id");
// Orgo doesn't give the list: the removal still goes, and what's kept by their id with it.
W.setMemberAccess(sheetWs(), "jamie@example.com", { others: "read", bots: {} });
W.setMemberAccess(sheetWs(), "user:u-jamie", { others: "read", bots: {} });
replies[`GET /api/workspaces/${WS}/members`] = () => json(500, { error: "boom" });
r = await route("DELETE", { memberId: "u-jamie" });
assert.equal(r.status, 200, "never held back");
assert.ok(!Object.hasOwn(kept(), "user:u-jamie"));
replies = usual();
W.setMemberAccess(sheetWs(), "jamie@example.com", null);
// Cancelling an invite.
r = await route("DELETE", { email: " Lee@Example.com " });
assert.equal(r.status, 200);
assert.deepEqual(kept(), {}, "nobody left: the map stays, empty, so two Macs' changes to it still go together");
// Nothing kept: removing someone asks Orgo no more than before.
n = calls.length;
r = await route("DELETE", { memberId: "u-jamie" });
assert.equal(r.status, 200);
assert.deepEqual(
  calls.slice(n).map((c) => `${c.method} ${c.path}`),
  ["GET /api/workspaces", `DELETE /api/workspaces/${WS}/members`],
);
// Forgetting what isn't kept changes nothing (no version, nothing to sync).
const version = S.getVersion();
W.setMemberAccess(sheetWs(), "nobody@example.com", null);
W.setMemberAccess(sheetWs(), "kim@example.com", { others: "none", bots: {} });
assert.equal(S.getVersion(), version);
W.setMemberAccess(sheetWs(), "kim@example.com", { others: "read", bots: {} });
const after = S.getVersion();
W.setMemberAccess(sheetWs(), "kim@example.com", { others: "read", bots: {} });
assert.equal(S.getVersion(), after, "the same again: nothing changes");
W.setMemberAccess(sheetWs(), "kim@example.com", null);
assert.deepEqual(kept(), {});
assert.throws(() => W.setMemberAccess("ws_not_there", "kim@example.com", { others: "read", bots: {} }), /no such workspace/);
console.log("ok - bot access: gone when they're removed or their invite is cancelled");

/* ---------------- 10c. Bot access kept where it's read, and only for who's there ---------------- */

replies = usual();
const on = (wsId) => levels(S.getState().workspaces.find((w) => w.id === wsId)?.memberAccess);
// Someone Orgo no longer lists (removed or gone on orgo.ai, left on their own, an invite cancelled there) is forgotten
// when the sheet reads who's there, so coming back any way never brings their old bots; everyone listed keeps theirs.
for (const k of ["jamie@example.com", "user:u-guest", "pat@example.com", "old@example.com", "gone@example.com", "user:u-left"]) W.setMemberAccess("ws_main", k, { others: "read", bots: {} });
r = await get();
assert.deepEqual(Object.keys(on("ws_main")).sort(), ["jamie@example.com", "old@example.com", "pat@example.com", "user:u-guest"], "an invite that ran out is still listed");
assert.deepEqual(accessOf(r.body)["u-jamie"], { others: "read", bots: {} });
// One kept while Orgo was being asked is newer than its list: it stays until a read that doesn't list them.
replies[`GET /api/workspaces/${WS}/members`] = () => (W.setMemberAccess("ws_main", "new@example.com", { others: "read", bots: {} }), json(200, list));
await get();
assert.ok(Object.hasOwn(on("ws_main"), "new@example.com"), "kept while the list was on its way");
replies = usual();
await get();
assert.ok(!Object.hasOwn(on("ws_main"), "new@example.com"));
// A list that doesn't say who's invited forgets nobody.
W.setMemberAccess("ws_main", "gone@example.com", { others: "read", bots: {} });
replies[`GET /api/workspaces/${WS}/members`] = () => json(200, { members: MEMBERS, seats: seatsOf() });
await get();
assert.ok(Object.hasOwn(on("ws_main"), "gone@example.com"));
replies = usual();
await get();
assert.ok(!Object.hasOwn(on("ws_main"), "gone@example.com"));
console.log("ok - bot access: forgotten once Orgo no longer lists them");

// Cancelling an invite whose email is a member's now (they joined by a link, or the row was stale): theirs stays.
list = { ...list, members: [...MEMBERS, { id: "u-pat", alt: "Pat Doe", role: "member", email: "Pat@Example.com" }] };
r = await route("DELETE", { email: "pat@example.com" });
assert.equal(r.status, 200);
assert.deepEqual(on("ws_main")["pat@example.com"], { others: "read", bots: {} }, "a member's, though the invite had the email too");
list = { ...list, members: MEMBERS };
r = await route("DELETE", { email: "pat@example.com" });
assert.ok(!Object.hasOwn(on("ws_main"), "pat@example.com"), "an invite's alone goes");
// Orgo doesn't give the list: an invite's goes, never held back by what Orgo can't say.
W.setMemberAccess("ws_main", "pat@example.com", { others: "read", bots: {} });
replies[`GET /api/workspaces/${WS}/members`] = () => json(500, { error: "boom" });
r = await route("DELETE", { email: "pat@example.com" });
assert.equal(r.status, 200);
assert.ok(!Object.hasOwn(on("ws_main"), "pat@example.com"));
replies = usual();
console.log("ok - bot access: a cancelled invite's goes, never a member's with the same email");

// A bot it can't name (an id too long) set below `others`: turned down, never kept as shown.
r = await route("PATCH", { memberId: "u-jamie", access: { others: "read", bots: { ["x".repeat(81)]: "none" } } });
assert.deepEqual([r.status, r.body.code], [400, "BAD_ACCESS"]);
assert.deepEqual(on("ws_main")["jamie@example.com"], { others: "read", bots: {} }, "unchanged");

// A bot deleted goes from everyone's access: one made later with its name gets its id, and starts hidden.
const Bt = await import(`${root}/lib/server/bots.ts`);
const Rm = await import(`${root}/lib/server/remove.ts`);
const Ac = await import(`${root}/lib/member-access.ts`);
assert.equal((await Bt.createBot("Otto", "Ops", "ws_main")).botId, "otto");
W.setMemberAccess("ws_main", "jamie@example.com", { others: "none", bots: { boppy: "read", otto: "read" } });
W.setMemberAccess("ws_main", "user:u-guest", { others: "none", bots: { otto: "write" } });
await Rm.deleteBot("otto");
assert.deepEqual(on("ws_main")["jamie@example.com"], { others: "none", bots: { boppy: "read" } });
assert.ok(!Object.hasOwn(on("ws_main"), "user:u-guest"), "an entry left showing no bot goes");
assert.equal((await Bt.createBot("Otto", "Ops", "ws_main")).botId, "otto", "the same id again");
// A bot never gets an id that names the user (a tapback's "owner", how a chat says them).
// Nor one that names a routine (who started a thread: Session.sentVia "routine").
for (const [name, id] of [["Owner", "owner-2"], ["You", "you-2"], ["User", "user-2"], ["Routine", "routine-2"]]) {
  const named = await Bt.createBot(name, "Ops", "ws_main");
  assert.equal(named.botId, id);
  await Rm.deleteBot(named.botId);
}
assert.equal(Ac.levelOf(on("ws_main")["jamie@example.com"], "otto"), "none", "the new Otto is hidden from them");
await Rm.deleteBot("otto");
// A long name is cut as a rename cuts it, so its id is one access can name.
const long = await Bt.createBot("L".repeat(90), "Ops", "ws_main");
assert.equal(S.getState().bots.find((b) => b.id === long.botId).name.length, 40);
await Rm.deleteBot(long.botId);
console.log("ok - bot access: a deleted bot's goes with it");

// A bot deleted from a group that stays: its lines there stay its own. One made later with its name gets another id,
// so what the old one said, which someone it was hidden from never saw, never shows to them as the new one's.
{
  const { botsOf, handedByOthers, sharedMessages, sharedSlice } = await import(`${root}/cloud/ws-slice.ts`);
  const sam = await Bt.createBot("Sam", "Ops", "ws_main");
  const vera = await Bt.createBot("Vera", "Money", "ws_main");
  S.update((st) => {
    st.chats.push({ id: "grp_money", kind: "group", botIds: ["boppy", sam.botId, vera.botId], title: "Money", createdAt: 1, typing: [], workspaceId: "ws_main" });
    st.messages.push(
      { id: "gm1", chatId: "grp_money", role: "user", text: "@Vera what's on my card statement?", at: 1 },
      { id: "gm2", chatId: "grp_money", role: "bot", botId: vera.botId, text: "Card ending 4242: $3,120", at: 2, reactions: [{ by: vera.botId, type: "like", at: 3 }] },
      { id: "gm3", chatId: "grp_money", role: "bot", botId: "boppy", text: "Noted", at: 4, asked: [{ botId: vera.botId, question: "Balance?", answer: "$212" }] },
    );
  });
  W.setMemberAccess("ws_main", "ava@example.com", { others: "read", bots: { [vera.botId]: "none" } });
  await Rm.deleteBot(vera.botId);
  assert.deepEqual(S.getState().chats.find((c) => c.id === "grp_money").botIds, ["boppy", sam.botId], "the group stays");
  assert.equal(S.getState().messages.find((m) => m.id === "gm2")?.botId, vera.botId, "and its history, the old Vera's line still hers");
  const again = await Bt.createBot("Vera", "Money", "ws_main");
  assert.equal(again.botId, `${vera.botId}-2`, "another id while what she said is kept");
  const ava = sharedSlice(S.getState(), "ws_main", { role: "member", id: "u-ava", email: "ava@example.com" });
  const bots = botsOf(ava);
  assert.ok(bots.has(again.botId), "the new Vera is shown to Ava (every bot, new ones too)");
  const read = sharedMessages(S.getState().messages, bots, handedByOthers(S.getState(), bots));
  assert.ok(!read.some((m) => m.id === "gm2"), "the old Vera's answer never shows as the new one's");
  assert.equal(read.find((m) => m.id === "gm3")?.asked, undefined, "nor what she answered when asked");
  for (const id of [again.botId, sam.botId]) await Rm.deleteBot(id);
  W.setMemberAccess("ws_main", "ava@example.com", null);
  S.update((st) => {
    st.chats = st.chats.filter((c) => c.id !== "grp_money");
    st.messages = st.messages.filter((m) => m.chatId !== "grp_money");
  });
}
console.log("ok - a deleted bot's lines in a group that stays never read as a new bot's with its name");

// News held for later (attention.ts): the main bot's "While you were busy" says whose watch each line came from, so a
// member given Boppy alone reads its own line and nothing of what another bot's watch found (cloud/ws-slice.ts).
{
  const At = await import(`${root}/lib/server/attention.ts`);
  const { botsOf, handedByOthers, sharedMessages, sharedSlice } = await import(`${root}/cloud/ws-slice.ts`);
  const vera = await Bt.createBot("Vera", "Money", "ws_main");
  At.holdForLater({ botId: vera.botId, text: "Bank: “Withdrawal of $4,800, balance $212”" });
  At.holdForLater({ botId: "boppy", text: "Inbox: “Dana wrote back”" });
  S.update((st) => {
    for (const h of st.digest) h.at -= 21 * 60_000;
  });
  At.flush();
  const posted = S.getState().messages.at(-1);
  assert.deepEqual([posted.chatId, posted.botId], ["bot:boppy", "boppy"], "one message, from the main bot, as before");
  assert.equal(posted.text, "While you were busy:\n• Bank: “Withdrawal of $4,800, balance $212”\n• Inbox: “Dana wrote back”", "the owner reads all of it");
  assert.deepEqual(posted.held.map((h) => h.botId), [vera.botId, "boppy"]);
  assert.deepEqual(S.getState().digest, []);
  W.setMemberAccess("ws_main", "ava@example.com", { others: "none", bots: { boppy: "read" } });
  const bots = botsOf(sharedSlice(S.getState(), "ws_main", { role: "member", id: "u-ava", email: "ava@example.com" }));
  const read = sharedMessages(S.getState().messages, bots, handedByOthers(S.getState(), bots)).find((m) => m.id === posted.id);
  assert.equal(read?.text, "While you were busy:\n• Inbox: “Dana wrote back”", "Ava reads Boppy's line alone");
  W.setMemberAccess("ws_main", "ava@example.com", null);
  await Rm.deleteBot(vera.botId);
  S.update((st) => void (st.messages = st.messages.filter((m) => m.id !== posted.id)));
}
console.log("ok - the digest of news held for later shows a member only the lines of bots they were given");

// What a bot waits on the owner's OK for (lib/server/permission.ts), shared in the owner's state: someone given that bot
// sees it read only (never which device asked, the reply, nor what resumes its run), one of a bot not given them
// nothing, and one answered already nothing; and they never reply: their own Bops has none of the owner's requests to
// answer (replyToAsk says so, the approvals route 409), and the window shows the card inert (chat-view.tsx).
{
  const { sharedSlice } = await import(`${root}/cloud/ws-slice.ts`);
  const P = await import(`${root}/lib/server/permission.ts`);
  const Ap = await import(`${root}/app/api/apps/approvals/route.ts`);
  const vera = await Bt.createBot("Vera", "Money", "ws_main");
  const resume = { engine: "responses", responseId: "resp_books", callId: "call_books", call: { name: "use_app", arguments: "{}" } };
  const ask = (id, botId, reply) => ({ id, botId, chatId: `bot:${botId}`, threadId: "ses_books", askedBy: "dev_runner_c1", action: "Send an email", resources: ["books@acme.example"], preview: "to: books@acme.example", at: 5, resume, ...(reply ? { reply } : {}) });
  const owner = { ...S.getState(), appApprovals: [ask("apr_boppy", "boppy"), ask("apr_vera", vera.botId), ask("apr_done", "boppy", { reply: "once", by: "dev_mac", at: 6 })] };
  W.setMemberAccess("ws_main", "ava@example.com", { others: "none", bots: { boppy: "read" } });
  const slice = sharedSlice(owner, "ws_main", { role: "member", id: "u-ava", email: "ava@example.com" });
  assert.deepEqual(
    slice.approvals,
    [{ id: "apr_boppy", botId: "boppy", chatId: "bot:boppy", threadId: "ses_books", action: "Send an email", resources: ["books@acme.example"], preview: "to: books@acme.example", at: 5 }],
    "Boppy's, unanswered, read only: Vera's isn't hers, the answered one is done",
  );
  assert.equal(sharedSlice({ ...owner, appApprovals: [] }, "ws_main", { role: "member", id: "u-ava", email: "ava@example.com" }).approvals, undefined, "none waiting: nothing added");
  const before = JSON.stringify(S.getState().appApprovals ?? []);
  assert.equal(P.replyToAsk("apr_boppy", "once"), "That isn't waiting on you anymore.", "her own Bops has no such request to answer");
  const res = await Ap.POST(new Request("http://localhost:3210/api/apps/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "apr_boppy", reply: "always" }) }));
  assert.equal(res.status, 409, "the route turns it down");
  assert.equal(JSON.stringify(S.getState().appApprovals ?? []), before, "nothing written");
  assert.equal(owner.appApprovals[0].reply, undefined, "the owner's request still waits on the owner");
  W.setMemberAccess("ws_main", "ava@example.com", null);
  await Rm.deleteBot(vera.botId);
}
console.log("ok - a member sees what a bot of theirs waits on the owner's OK for, read only, and can't answer it");

// A message kept "between us" deleted: the bots' answers to it stay kept out of a procedure's draft (procedures.ts knew them by it).
const msg = (id, role, secret) => ({ id, chatId: "bot:boppy", role, text: id, at: 1, ...(secret ? { secret: true } : {}) });
S.update((st) => st.messages.push(msg("q", "user", true), msg("a1", "bot"), { ...msg("x", "bot"), chatId: "bot:other" }, msg("a2", "bot"), msg("next", "user"), msg("a3", "bot")));
Rm.deleteMessage("q");
const msgNow = (id) => S.getState().messages.find((m) => m.id === id);
assert.deepEqual(["a1", "a2", "x", "next", "a3"].map((id) => !!msgNow(id).secret), [true, true, false, false, false]);
Rm.deleteMessage("next");
assert.equal(msgNow("a3").secret, undefined, "deleting one that isn't kept marks nothing");
S.update((st) => void (st.messages = st.messages.filter((m) => !["a1", "a2", "x", "a3"].includes(m.id))));
console.log("ok - a message kept between us deleted: the answers to it stay kept");

// A bot from before whose id is "owner" writes into memory as itself (bops-owner), never as the owner, whose
// words go in as the bank's own peer (memory.ts OWNER_WHO).
{
  const Mem = await import(`${root}/lib/server/memory.ts`);
  assert.equal(Mem.memoryPeerOf("ws_main", "owner"), "bops-owner");
  assert.notEqual(Mem.memoryPeerOf("ws_main", Mem.OWNER_WHO), "bops-owner");
  assert.ok(!/^bops-/.test(Mem.memoryPeerOf("ws_main", Mem.OWNER_WHO)), "the owner's is the bank's own peer");
}

// A bot from before whose id is "you" (or "routine": freeBotId gives no new bot either) hands one on: its id in
// sentVia is the word that names the owner there, so the thread says it's a bot's (Session.sentViaBot), and what
// carries it on to the Mac says so too. The owner's own task and a routine's run, as always.
{
  const X = await import(`${root}/lib/server/sessions.ts`);
  const T = await import(`${root}/lib/types.ts`);
  const threadNow = (id) => S.getState().sessions.find((x) => x.id === id);
  // (It leads Kid on the team chart, lib/chain.ts: work goes only down a line.)
  S.update((st) => {
    st.bots.push({ id: "you", name: "You", role: "Helper", color: "#60A5FA", isMain: false, computerStatus: "none" }, { id: "kid", name: "Kid", role: "Helper", color: "#60A5FA", isMain: false, computerStatus: "none" });
    st.workspaces.find((w) => w.id === "ws_main").chain = { bots: { kid: { lead: "you" } } };
  });
  const handed = X.startSession({ botId: "kid", goal: "Send every payroll report to the accountant.", title: "Payroll", chatId: "bot:you", sentVia: "you", viaBot: true, where: "cloud", fresh: true });
  // Never up the chart, whatever path starts it: the last check refuses in the words the bot reads.
  assert.throws(() => X.startSession({ botId: "boppy", goal: "Do the payroll.", title: "Up", chatId: "bot:you", sentVia: "you", viaBot: true, where: "cloud", fresh: true }), /^Error: Not handed off: Boppy isn't under You on the org chart\.$/);
  assert.deepEqual([handed.sentVia, handed.sentViaBot, T.ownerSent(handed), T.sentByBot(handed)], ["you", true, false, "you"]);
  assert.equal(threadNow(handed.id)?.sentViaBot, true, "as the state keeps it");
  const mine = X.startSession({ botId: "boppy", goal: "Check the invoices", title: "Invoices", chatId: "bot:boppy", where: "cloud", fresh: true });
  assert.deepEqual([mine.sentVia, mine.sentViaBot, T.ownerSent(mine), T.sentByBot(mine)], ["you", undefined, true, undefined]);
  const run = X.startSession({ botId: "boppy", goal: "Morning brief", title: "Brief", chatId: "bot:boppy", sentVia: "routine", where: "cloud", fresh: true });
  const byRoutineBot = X.startSession({ botId: "boppy", goal: "Morning brief two", title: "Brief two", chatId: "bot:boppy", sentVia: "routine", viaBot: true, where: "cloud", fresh: true });
  assert.deepEqual([run.sentViaBot, T.routineSent(run), byRoutineBot.sentViaBot, T.routineSent(byRoutineBot)], [undefined, true, true, false]);
  // A bot whose id names neither: nothing to say.
  const byHelper = X.startSession({ botId: "boppy", goal: "Help out", title: "Help", chatId: "bot:boppy", sentVia: "helper", viaBot: true, where: "cloud", fresh: true });
  assert.deepEqual([byHelper.sentVia, byHelper.sentViaBot, T.sentByBot(byHelper)], ["helper", undefined, "helper"]);
  // Moved to the Mac: still the bot's, even once the chart has changed since (it carries on a thread already handed).
  const hadMac = S.getState().mac;
  S.update((st) => {
    st.mac = { ready: true };
    st.workspaces.find((w) => w.id === "ws_main").chain = { bots: { kid: { takesWork: false } } };
  });
  const moved = X.moveToMac(handed.id);
  assert.notEqual(moved.id, handed.id);
  assert.deepEqual([moved.sentVia, moved.sentViaBot], ["you", true]);
  // Bops Cloud shows a member the bot that handed it on, as it does for any bot's (cloud/ws-slice.ts).
  const { sliceOf } = await import(`${root}/cloud/ws-slice.ts`);
  assert.equal(sliceOf(S.getState(), "ws_main").sessions.find((x) => x.id === handed.id)?.sentViaBot, true);
  // A routine's run that a computer's runner began, paused there for the user's OK, moved to the Mac by the user: the
  // run is the Mac's now, so its end there is that run's end (that time of the routine done, never due again for the
  // move), and the move stops the paused run (its request rejected as stopped; the Mac thread asks again for what it needs).
  const routineRun = X.startSession({ botId: "boppy", goal: "Book a table for 4 tonight", title: "Book a table", chatId: "bot:boppy", sentVia: "routine", where: "cloud", fresh: true, routineId: "rtn_moved" });
  S.update((st) => {
    Object.assign(st.sessions.find((x) => x.id === routineRun.id), { by: "dev_runner_c1", status: "queued" });
    st.routines.push({ id: "rtn_moved", botId: "boppy", title: "Book a table", goal: "Book a table for 4 tonight", schedule: { kind: "once", at: 1 }, enabled: false, lastRunAt: 2, last: { at: 2, status: "running", sessionId: routineRun.id, by: "dev_runner_c1" } });
    (st.appApprovals ??= []).push({ id: "apr_moved", botId: "boppy", threadId: routineRun.id, routineId: "rtn_moved", askedBy: "dev_runner_c1", action: "Send an email", resources: ["table@bistro.example"], preview: "to: table@bistro.example", at: 3, resume: { engine: "responses", responseId: "resp_t", callId: "call_t", call: { name: "use_app", arguments: "{}" } } });
  });
  const movedRun = X.moveToMac(routineRun.id);
  const r = S.getState().routines.find((x) => x.id === "rtn_moved");
  assert.deepEqual([r.last.sessionId, r.last.by, r.enabled, r.nextRunAt], [movedRun.id, undefined, false, undefined], "the Mac's run now, and never due again for the move");
  assert.deepEqual([S.getState().appApprovals.find((a) => a.id === "apr_moved")?.reply?.reply, S.getState().appApprovals.find((a) => a.id === "apr_moved")?.reply?.reason], ["reject", "stopped"], "its paused run on the computer stopped");
  S.update((st) => void (st.appApprovals = st.appApprovals.filter((a) => a.id !== "apr_moved")));
  for (const id of [handed.id, mine.id, run.id, byRoutineBot.id, byHelper.id, moved.id, routineRun.id, movedRun.id]) X.stopSession(id, "test over");
  S.update((st) => {
    st.mac = hadMac;
    st.sessions = st.sessions.filter((x) => ![handed.id, mine.id, run.id, byRoutineBot.id, byHelper.id, moved.id, routineRun.id, movedRun.id].includes(x.id));
    st.routines = st.routines.filter((x) => x.id !== "rtn_moved");
    st.bots = st.bots.filter((b) => b.id !== "you");
  });
}

// A thread a bot started for a message kept between us (marked once Jev's check is back, after the answer
// started it) is kept between us too, and so is what's said about it later, its result after the owner's
// next message included. That keeps them out of the shared memory and a procedure's draft only: Bops Cloud
// shows all of it to someone the owner gave the bot (cloud/ws-slice.ts), and nothing of it to anyone else.
{
  const Mem = await import(`${root}/lib/server/memory.ts`);
  const { botsOf, handedByOthers, sharedMessages, sharedSlice } = await import(`${root}/cloud/ws-slice.ts`);
  const ask = "Between us, find what senior engineers earn in Austin";
  S.update((st) => {
    st.sessions.push({ id: "s_pay", botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: "Austin pay", goal: ask, host: "orgo", status: "running", steps: [], replies: [], createdAt: 1 });
    st.sessions.push({ id: "s_lunch", botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: "Lunch", goal: "Book lunch", host: "orgo", status: "running", steps: [], replies: [], createdAt: 1 });
    st.messages.push(msg("ask", "user"), { ...msg("on it", "bot"), botId: "boppy", sessionIds: ["s_pay"] });
  });
  Mem.rememberMessage("ws_main", "bot:boppy", "ask", ask);
  const threadNow = (id) => S.getState().sessions.find((x) => x.id === id);
  assert.deepEqual([msgNow("ask").secret, msgNow("on it").secret, threadNow("s_pay").secret, threadNow("s_lunch").secret], [true, true, true, undefined]);
  S.addMessage({ chatId: "bot:boppy", role: "user", text: "Also book lunch Friday" });
  const result = S.addMessage({ chatId: "bot:boppy", role: "bot", botId: "boppy", text: "About $180k", resultOf: "s_pay", sessionIds: ["s_pay"] });
  const lunch = S.addMessage({ chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Booked", resultOf: "s_lunch", sessionIds: ["s_lunch"] });
  assert.deepEqual([msgNow(result.id).secret, msgNow(lunch.id).secret], [true, undefined], "its result, after the owner's next message");
  assert.deepEqual(S.getState().sessions.filter((x) => x.secret).map((x) => x.id), ["s_pay"]);
  const given = sharedSlice(S.getState(), "ws_main", { role: "member", id: "u-jamie", email: "jamie@example.com" });
  assert.deepEqual(given.sessions.filter((x) => ["s_pay", "s_lunch"].includes(x.id)).map((x) => x.id), ["s_pay", "s_lunch"], "a member given Boppy sees the thread kept between us");
  const bots = botsOf(given);
  const read = sharedMessages(S.getState().messages, bots, handedByOthers(S.getState(), bots)).map((m) => m.id);
  for (const id of ["ask", "on it", result.id, lunch.id]) assert.ok(read.includes(id), `${id}: the owner's request, the answer and both results`);
  const other = sharedSlice(S.getState(), "ws_main", { role: "member", id: "u-guest" });
  assert.ok(!other.sessions.some((x) => x.id === "s_pay"), "someone not given Boppy sees none of it");
  S.update((st) => {
    st.sessions = st.sessions.filter((x) => !["s_pay", "s_lunch"].includes(x.id));
    st.messages = st.messages.filter((m) => m.chatId !== "bot:boppy" || (!["ask", "on it", result.id, lunch.id].includes(m.id) && m.text !== "Also book lunch Friday"));
  });
}
console.log("ok - a thread started for a message kept between us is kept between us, and its result too, and a member given the bot sees it all");

// Two Macs: one takes the last person away while the other adds someone. The map stays (empty), so the two go
// together entry by entry, whichever merges last.
const G = await import(`${root}/lib/server/state-merge.ts`);
S.update((st) => void st.workspaces.push({ id: "ws_merge", name: "Merge", createdAt: 1 }));
const mergeWs = (blob) => blob.workspaces.find((w) => w.id === "ws_merge").memberAccess;
W.setMemberAccess("ws_merge", "kim@example.com", { others: "read", bots: {} });
const was = structuredClone({ workspaces: S.getState().workspaces });
W.setMemberAccess("ws_merge", "kim@example.com", null);
const mine = structuredClone({ workspaces: S.getState().workspaces });
assert.deepEqual(mergeWs(mine), {});
const theirs = structuredClone(was);
mergeWs(theirs)["bob@example.com"] = { others: "none", bots: { boppy: "read" } };
assert.deepEqual(mergeWs(G.merge3(was, mine, theirs)), { "bob@example.com": { others: "none", bots: { boppy: "read" } } });
assert.deepEqual(mergeWs(G.merge3(was, theirs, mine)), { "bob@example.com": { others: "none", bots: { boppy: "read" } } });
S.update((st) => void (st.workspaces = st.workspaces.filter((w) => w.id !== "ws_merge")));
console.log("ok - bot access: two Macs' changes go together");

// The open workspace has no Orgo workspace of its own (an Orgo without them, or the move to them undone): the sheet
// lists the default's "bops" people, so their access is kept on the default, where Bops Cloud reads it.
S.update((st) => {
  st.workspaces.push({ id: "ws_two", name: "Two", createdAt: 1 });
  st.workspace = "ws_two";
  st.orgoMigrationRevertedAt = Date.now();
});
r = await get();
assert.equal(r.body.wsId, "ws_main", "the sheet says whose bots it offers");
assert.deepEqual(accessOf(r.body)["u-jamie"], { others: "none", bots: { boppy: "read" } }, "read from the default");
r = await route("PATCH", { memberId: "u-guest", access: { others: "read", bots: {} } });
assert.equal(r.status, 200);
assert.deepEqual(on("ws_main")["user:u-guest"], { others: "read", bots: {} });
assert.equal(on("ws_two"), undefined, "never the open one");
r = await route("DELETE", { memberId: "u-guest" });
assert.equal(r.status, 200);
assert.ok(!Object.hasOwn(on("ws_main"), "user:u-guest"), "and forgotten there when they're removed");
// Tied to the Orgo workspace the sheet lists: kept on it.
S.update((st) => void (st.workspaces.find((w) => w.id === "ws_two").orgoProjectId = WS));
r = await get();
assert.equal(r.body.wsId, "ws_two");
r = await route("PATCH", { memberId: "u-guest", access: { others: "write", bots: {} } });
assert.deepEqual(on("ws_two")["user:u-guest"], { others: "write", bots: {} });
assert.ok(!Object.hasOwn(on("ws_main"), "user:u-guest"));
S.update((st) => {
  st.workspaces = st.workspaces.filter((w) => w.id !== "ws_two");
  st.workspace = undefined;
  delete st.orgoMigrationRevertedAt;
});
console.log("ok - bot access: kept on the workspace whose people the sheet lists");

/* ---------------- 11. The words ---------------- */

const caps = { pro_bops: 2, max_bops: 5 };
const words = (plan, limit, used, withAccess, invited) => P.peopleShort({ plan, limit, used, caps }, { withAccess, invited });
assert.deepEqual(words("free_bops", 0, 0, 0, 0), { text: "Free doesn't include adding people. Pro includes 2, and Max up to 5.", upgrade: "plan" });
assert.deepEqual(words("free_bops", 0, 2, 2, 0), { text: "Free doesn't include adding people. The 2 people who have access keep it.", upgrade: "plan" });
assert.deepEqual(words("free_bops", 0, 2, 1, 1), { text: "Free doesn't include adding people. The 1 person who has access keeps it.", upgrade: "plan" });
assert.equal(words("pro_bops", 2, 1, 1, 0), null, "room");
assert.deepEqual(words("pro_bops", 2, 2, 2, 0), { text: "Pro includes 2 people, and you have 2. Max includes up to 5.", upgrade: "max" });
assert.deepEqual(words("pro_bops", 2, 2, 1, 1), { text: "Pro includes 2 people, and you have 2. Max includes up to 5.", upgrade: "max", note: "Or cancel an invite below to make room." });
assert.deepEqual(words("pro_bops", 2, 4, 4, 0), { text: "Pro includes 2 people, and you have 4 from before. They keep access, but to add someone, upgrade to Max or remove people.", upgrade: "max" });
assert.equal(words("max_bops", 5, 3, 3, 0), null);
assert.deepEqual(words("max_bops", 5, 5, 4, 1), { text: "Max includes up to 5 people, and you have 5. Remove someone or cancel an invite to add someone else.", upgrade: null });
assert.deepEqual(words("max_bops", 5, 5, 5, 0), { text: "Max includes up to 5 people, and you have 5. Remove someone to add someone else.", upgrade: null });
assert.deepEqual(words("max_bops", 5, 6, 6, 0), { text: "Max includes up to 5 people, and you have 6 from before. They keep access, but to add someone, remove people first.", upgrade: null });
assert.equal(words("max_bops", null, 40, 40, 0), null, "no limit");
assert.equal(P.peopleAside({ plan: "pro_bops", limit: 2, used: 1, caps }), "1 of 2 people");
assert.equal(P.peopleAside({ plan: "max_bops", limit: null, used: 9, caps }), null);
assert.deepEqual(
  [T.BOPS_TIERS.free_bops.people, T.BOPS_TIERS.pro_bops.people, T.BOPS_TIERS.max_bops.people],
  [0, 2, 5],
  "the app's copy of the caps",
);
assert.deepEqual(P.PEOPLE_CAPS, { pro_bops: 2, max_bops: 5 });
assert.deepEqual(
  P.PLAN_CARDS.map((c) => c.lines.at(-1).text === "No extra computers" ? c.lines.at(-2).text : c.lines.at(-1).text),
  ["No sharing with other people", "Share your bots' computers with 2 people", "Share your bots' computers with up to 5 people"],
);
assert.deepEqual(
  ["a@example.com", " A@Example.COM ", "a@b", "a b@example.com", "@example.com", "a@example.c", 7, null].map(M.emailOf),
  ["a@example.com", "a@example.com", null, null, null, null, null, null],
);
// No dashes anywhere the sheet or its route speak.
for (const v of Object.values(M.WORDS)) noDashes(typeof v === "function" ? v("alex@example.com") : v);
for (const v of [...Object.values(M.ROLE_LINES), ...Object.values(M.ROLE_NAMES)]) noDashes(v);
for (const plan of ["free_bops", "pro_bops", "max_bops"])
  for (let used = 0; used <= 7; used++)
    for (let invited = 0; invited <= used; invited++) {
      const w = words(plan, plan === "free_bops" ? 0 : caps[plan], used, used - invited, invited);
      if (w) for (const t of [w.text, w.note ?? ""]) noDashes(t);
    }
for (const card of P.PLAN_CARDS) for (const line of card.lines) noDashes(line.text);
for (const e of said) noDashes(e);
assert.ok(said.size >= 15, `the route's words were all checked (${said.size})`);
// The sheet's own words.
const sheet = readFileSync(join(root, "components/app/members.tsx"), "utf8");
for (const m of sheet.matchAll(/"([^"\n]{12,})"|`([^`\n]{12,})`|>([^<>{}\n]{12,})</g)) noDashes(m[1] ?? m[2] ?? m[3]);
console.log("ok - the words");

/* ---------------- 12. No emails in usage events ---------------- */

for (const [event, props] of [
  ["bops_member_invited", { role: "viewer", resend: false, delivered: true }],
  ["bops_member_access_changed", { to_role: "admin" }],
  ["bops_member_removed", { invite: true }],
  ["bops_member_refused", { code: "SEAT_LIMIT" }],
]) {
  assert.deepEqual(A.cleanProperties(event, { ...props, email: "alex@example.com", name: "Alex", member_id: "u-jamie" }, "mac_server"), props, `${event}: nothing personal leaves`);
  assert.equal(A.cleanProperties(event, props, "app"), null, `${event} is the Mac server's`);
}
assert.deepEqual(A.cleanProperties("bops_members_opened", { people: 3, email: "alex@example.com" }, "app"), { people: 3 });
assert.deepEqual(A.cleanProperties("bops_upgrade_clicked", { surface: "members" }, "app"), { surface: "members" });
const server = readFileSync(join(root, "lib/server/members.ts"), "utf8");
const tracked = [...server.matchAll(/trackServerEvent\(([^;]*)\);/g)].map((m) => m[1]);
assert.deepEqual(
  tracked.map((t) => /^"(\w+)"/.exec(t)?.[1]).sort(),
  ["bops_member_access_changed", "bops_member_invited", "bops_member_refused", "bops_member_removed"],
  "every change is counted",
);
for (const t of tracked) assert.ok(!/email|name|memberId|people\b/i.test(t), `no email, name or id in ${t}`);
assert.ok(!/console\.(log|info|warn|error)\([^)]*email/i.test(server), "no email logged");
console.log("ok - no emails in usage events");

/* ---------------- Someone else can use the workspace (no Bops runner there: runner-install.ts) ---------------- */

{
  const S = await import(`${root}/lib/server/members.ts`);
  replies = usual();
  const others = (members, invites = []) => {
    list = { members, invites, seats: seatsOf() };
    return S.othersCanUse(KEY, WS);
  };
  const [owner, sam, jamie, guest] = MEMBERS;
  assert.equal(await others([owner]), false, "the owner alone");
  assert.equal(await others([owner, sam]), true, "Full access");
  assert.equal(await others([owner, jamie]), true, "View only counts too");
  assert.equal(await others([owner, guest]), true, "and a guest");
  assert.equal(await others([owner], [INVITES[1]]), true, "an invite still open");
  assert.equal(await others([owner], [INVITES[0]]), false, "an expired one doesn't");
  replies = { ...usual(), [`GET /api/workspaces/${WS}/members`]: () => json(500, { error: "down" }) };
  assert.equal(await S.othersCanUse(KEY, WS), null, "Orgo didn't say");
  list = { members: MEMBERS, invites: INVITES, seats: seatsOf() };
  replies = usual();
}
console.log("ok - someone else can use the workspace: any other member, or an invite still open");

/* ---------------- Bot access forgotten without the sheet (runner-install.ts's look) ---------------- */

{
  const S = await import(`${root}/lib/server/members.ts`);
  const St = await import(`${root}/lib/server/store.ts`);
  replies = usual();
  list = { members: MEMBERS, invites: INVITES, seats: seatsOf() };
  const had = St.getState().workspaces.find((w) => w.id === "ws_main").orgoProjectId;
  St.update((st) => void (st.workspaces.find((w) => w.id === "ws_main").orgoProjectId = WS));
  const on = () => levels(St.getState().workspaces.find((w) => w.id === "ws_main").memberAccess ?? {});
  const read = { others: "read", bots: {} };
  // Dana was removed on orgo.ai (or from a Mac still on v0.0.29, or left): the People sheet is never opened.
  W.setMemberAccess("ws_main", "dana@example.com", read);
  W.setMemberAccess("ws_main", "jamie@example.com", read);
  await S.forgetGoneMembers(KEY);
  assert.ok(!Object.hasOwn(on(), "dana@example.com"), "forgotten at the Mac's look, so coming back never brings her bots");
  assert.deepEqual(on()["jamie@example.com"], read, "someone Orgo lists keeps theirs");
  // The look's members check reads the same list: it forgets too.
  W.setMemberAccess("ws_main", "dana@example.com", read);
  assert.equal(await S.othersCanUse(KEY, WS), true);
  assert.ok(!Object.hasOwn(on(), "dana@example.com"), "forgotten by the members check");
  // A list Orgo didn't give forgets nobody.
  W.setMemberAccess("ws_main", "dana@example.com", read);
  replies = { ...usual(), [`GET /api/workspaces/${WS}/members`]: () => json(500, { error: "down" }) };
  await S.forgetGoneMembers(KEY);
  assert.deepEqual(on()["dana@example.com"], read, "kept while Orgo can't say");
  replies = usual();
  W.setMemberAccess("ws_main", "dana@example.com", null);
  W.setMemberAccess("ws_main", "jamie@example.com", null);
  St.update((st) => {
    const w = st.workspaces.find((x) => x.id === "ws_main");
    if (had === undefined) delete w.orgoProjectId;
    else w.orgoProjectId = had;
  });
}
console.log("ok - bot access: forgotten at the Mac's look too, whether or not the sheet is opened");

/* ---------------- Bot access is for the membership it was set in ---------------- */

{
  const St = await import(`${root}/lib/server/store.ts`);
  replies = usual();
  const raw = () => St.getState().workspaces.find((w) => w.id === sheetWs()).memberAccess ?? {};
  const read = { others: "read", bots: {} };
  const dana = (joined) => ({ id: "u-dana", alt: "Dana Lee", role: "member", email: "dana@example.com", ...(joined ? { joined_at: iso(joined) } : {}) });
  // Set with an invite: said so, and when.
  const t0 = Date.now();
  r = await route("POST", { email: "dana@example.com", role: "viewer", access: read });
  assert.equal(r.status, 200);
  assert.equal(raw()["dana@example.com"].invite, true, "set with an invite");
  assert.ok(raw()["dana@example.com"].at >= t0 && raw()["dana@example.com"].at <= Date.now(), "and when");
  // Sent again without access a few days on: what was kept is the new invite's, its 7 days from now.
  St.update((st) => void (st.workspaces.find((w) => w.id === sheetWs()).memberAccess["dana@example.com"].at = t0 - 5 * DAY));
  list = { members: MEMBERS, invites: [...INVITES, pending("dana@example.com")], seats: seatsOf() };
  r = await route("POST", { email: "dana@example.com", role: "viewer" });
  assert.equal(r.status, 200);
  assert.ok(raw()["dana@example.com"].at >= t0, "renewed with the invite sent again");
  // Say that was 6 days ago, and she took it a day later: the sheet's read ties what was set with it to that membership.
  const sent = t0 - 6 * DAY;
  St.update((st) => void (st.workspaces.find((w) => w.id === sheetWs()).memberAccess["dana@example.com"].at = sent));
  const joined = sent + DAY;
  list = { members: [...MEMBERS, dana(joined)], invites: INVITES, seats: seatsOf() };
  r = await get();
  assert.deepEqual(accessOf(r.body)["u-dana"], read, "hers; the sheet never shows when it was set");
  assert.deepEqual(raw()["dana@example.com"], { ...read, at: joined }, "tied to the membership her invite began (Your Apps left unset: none was picked)");
  // Removed on orgo.ai, invited back there days later and in again, with no Mac on this Bops looking in between:
  // Orgo lists her as joined after it was set, so it's forgotten, at the sheet's read and at the Mac's look alike.
  list = { members: [...MEMBERS, dana(joined + 3 * DAY)], invites: INVITES, seats: seatsOf() };
  r = await get();
  assert.equal(raw()["dana@example.com"], undefined, "coming back never brings her old bots");
  assert.deepEqual(accessOf(r.body)["u-dana"], NONE);
  const Sv = await import(`${root}/lib/server/members.ts`);
  const had = St.getState().workspaces.find((w) => w.id === sheetWs()).orgoProjectId;
  St.update((st) => void (st.workspaces.find((w) => w.id === sheetWs()).orgoProjectId = WS));
  W.setMemberAccess(sheetWs(), "dana@example.com", read, { at: joined });
  await Sv.forgetGoneMembers(KEY);
  assert.equal(raw()["dana@example.com"], undefined, "the Mac's look forgets it too");
  St.update((st) => {
    const w = st.workspaces.find((x) => x.id === sheetWs());
    if (had === undefined) delete w.orgoProjectId;
    else w.orgoProjectId = had;
  });
  // Set in the sheet since she came back: hers.
  W.setMemberAccess(sheetWs(), "dana@example.com", null);
  r = await route("PATCH", { memberId: "u-dana", access: read });
  assert.equal(r.status, 200);
  assert.equal(raw()["dana@example.com"].invite, undefined, "set for a member");
  await get();
  assert.deepEqual(levels(raw())["dana@example.com"], read, "kept");
  // An orgo-web that doesn't say when anyone joined: kept while listed, as before.
  W.setMemberAccess(sheetWs(), "dana@example.com", read, { at: 1 });
  list = { members: [...MEMBERS, dana()], invites: INVITES, seats: seatsOf() };
  await get();
  assert.deepEqual(levels(raw())["dana@example.com"], read);
  W.setMemberAccess(sheetWs(), "dana@example.com", null);
  list = { members: MEMBERS, invites: INVITES, seats: seatsOf() };
}
console.log("ok - bot access: only for the membership it was set in, so someone removed and back never finds their old bots");

process.chdir(tmpdir());
rmSync(scratch, { recursive: true, force: true });
console.log("all passed");
process.exit(0);
