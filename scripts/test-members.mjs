// Tests for the People sheet's server: the route the window calls (app/api/members/route.ts, lib/server/members.ts)
// against a fake orgo-web (its /api/workspaces and member routes, and /api/bops/plan), and the words the sheet shows
// (lib/members.ts, lib/plan-includes.ts peopleShort). The workspace is only ever the user's own "bops" one, found and
// never made, whatever the request names; every call runs on the signed-in key alone; changes come only from the Bops
// window; orgo-web's refusals come back in the app's words (plan refusals as 402 with the plan that has room); Full
// access stays off until it's offered, and off while Bops puts its keys on the computers; an orgo-web that sends no
// seats gets the app's copy of the plan table. Orgo is a fake fetch on a made-up origin, the Keychain a stand-in
// `security` that has nothing, and the state a throwaway file store in a temporary folder: nothing reaches Orgo.
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
assert.deepEqual(ready.seats, { plan: "max_bops", canAdd: true, limit: 5, used: 4, upgrade: null, caps: { pro_bops: 2, max_bops: 5 }, from: "orgo" }, "orgo-web's seats as they are");
assert.equal(ready.seatsError, undefined);
assert.equal(ready.orgoUrl, `https://orgo.test/workspaces?project_id=${WS}`);
assert.equal(ready.host, "orgo");
assert.equal(ready.fullAccess, "not_yet", "Full access isn't offered yet");
assert.ok(!JSON.stringify(ready).includes(KEY), "the key never goes to the window");
// The upgrade orgo-web offers, in the app's words; seats it couldn't read; an orgo-web without times.
list = { ...list, seats: seatsOf({ plan: "pro_bops", limit: 2, used: 4, can_add: false, upgrade_tier: "max_bops" }) };
assert.deepEqual((await get()).body.seats, { plan: "pro_bops", canAdd: false, limit: 2, used: 4, upgrade: "max", caps: { pro_bops: 2, max_bops: 5 }, from: "orgo" });
list = { ...list, seats: seatsOf({ plan: "free_bops", limit: 0, can_add: false, upgrade_tier: "pro_bops", caps: undefined }) };
assert.deepEqual((await get()).body.seats, { plan: "free_bops", canAdd: false, limit: 0, used: 4, upgrade: "plan", caps: { pro_bops: 2, max_bops: 5 }, from: "orgo" });
list = { members: MEMBERS, invites: INVITES, seats: null, seats_error: "PLAN_UNAVAILABLE" };
r = await get();
assert.equal(r.body.seats, null);
assert.equal(r.body.seatsError, "PLAN_UNAVAILABLE", "orgo-web couldn't read the plan: adding people waits");
for (const seats of [null, { product: "orgo", plan: "hacker_v2", limit: 1, used: 0, can_add: true }, { plan: "max_bops" }]) {
  list = { members: MEMBERS, invites: INVITES, seats };
  r = await get();
  assert.deepEqual([r.body.seats, r.body.seatsError], [null, "PLAN_UNAVAILABLE"], `orgo-web's seats it can't use: ${JSON.stringify(seats)}`);
}
assert.ok(!calls.some((c) => c.path === "/api/bops/plan"), "orgo-web's seats are never second-guessed with the app's copy");
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
  calls.slice(n).every((c) => c.path === "/api/workspaces" || c.path.startsWith(`/api/workspaces/${WS}/`) || c.path === "/api/bops/plan"),
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

/* ---------------- 6. The app's copy of the plan table, for an orgo-web without seats ---------------- */

const noSeats = (people, invites) => ({ members: [MEMBERS[0], ...people], invites });
const pending = (email, ms = now + 3 * DAY) => ({ email, role: "member", status: "pending", token: `t-${email}`, expires_at: iso(ms), expired: ms <= now });
const invited = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/invite"));
let bopsPlan = () => json(200, { tier: "free_bops" });
const withPlan = () => ({ ...usual(), "GET /api/bops/plan": () => bopsPlan() });
// Free: no room at all, and the invite is never sent.
list = noSeats([], []);
replies = withPlan();
r = await get();
assert.deepEqual(r.body.seats, { plan: "free_bops", canAdd: false, limit: 0, used: 0, upgrade: "plan", caps: { pro_bops: 2, max_bops: 5 }, from: "app" });
n = invited().length;
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code, r.body.upgrade, r.body.error], [402, "UPGRADE_REQUIRED", "plan", M.WORDS.upgradeRequired]);
assert.equal(invited().length, n, "Free: nobody invited");
// Pro: 1 person and 1 invite waiting fill its 2. An expired invite doesn't count.
bopsPlan = () => json(200, { tier: "pro_bops" });
list = noSeats([MEMBERS[2]], [pending("pat@example.com"), pending("gone@example.com", now - DAY)]);
r = await get();
assert.deepEqual(r.body.seats, { plan: "pro_bops", canAdd: false, limit: 2, used: 2, upgrade: "max", caps: { pro_bops: 2, max_bops: 5 }, from: "app" });
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code, r.body.upgrade, r.body.limit, r.body.used], [402, "SEAT_LIMIT", "max", 2, 2]);
assert.equal(invited().length, n, "no room: nobody invited");
// Sending the waiting one again takes no more room; sending the expired one again needs room it hasn't.
r = await route("POST", { email: "pat@example.com", role: "viewer" });
assert.equal(r.status, 200, "sent again");
assert.equal(invited().length, n + 1);
r = await route("POST", { email: "gone@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code], [402, "SEAT_LIMIT"]);
// Room: one person, nothing waiting.
list = noSeats([MEMBERS[2]], []);
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.equal(r.status, 200);
// Max: 5.
bopsPlan = () => json(200, { tier: "max_bops" });
list = noSeats([MEMBERS[1], MEMBERS[2], MEMBERS[3]], [pending("pat@example.com"), pending("lee@example.com")]);
r = await get();
assert.deepEqual([r.body.seats.limit, r.body.seats.used, r.body.seats.canAdd, r.body.seats.upgrade], [5, 5, false, null]);
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code, r.body.upgrade], [402, "SEAT_LIMIT", null]);
// The plan couldn't be read: never taken for Free or for room. Adding waits.
bopsPlan = () => json(500, { error: "boom" });
list = noSeats([], []);
n = invited().length;
r = await get();
assert.deepEqual([r.body.seats, r.body.seatsError], [null, "PLAN_UNAVAILABLE"]);
r = await route("POST", { email: "new@example.com", role: "viewer" });
assert.deepEqual([r.status, r.body.code], [503, "PLAN_UNAVAILABLE"]);
assert.equal(invited().length, n, "nobody invited without the plan");
// orgo-web's own seats (it holds the workspace to them): the app doesn't second-guess them.
list = { ...noSeats([MEMBERS[2]], [pending("pat@example.com")]), seats: seatsOf({ plan: "pro_bops", limit: 2, used: 2, can_add: false, upgrade_tier: "max_bops" }) };
replies = usual();
r = await route("POST", { email: "pat@example.com", role: "viewer" });
assert.equal(r.status, 200, "orgo-web decides");
console.log("ok - the app's copy of the plan table, only without orgo-web's seats");

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
// Offered (BOPS_MEMBERS_FULL_ACCESS=1), and nothing of Bops' on the computers: on.
process.env.BOPS_MEMBERS_FULL_ACCESS = "1";
assert.equal((await get()).body.fullAccess, "on");
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
  assert.equal((await get()).body.fullAccess, "off", k);
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

process.chdir(tmpdir());
rmSync(scratch, { recursive: true, force: true });
console.log("all passed");
process.exit(0);
