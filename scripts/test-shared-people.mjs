// Tests for an Admin's People sheet and settings of a workspace shared with them (app/api/workspaces/shared/people,
// settings and wake; lib/server/shared-people.ts): against a fake orgo-web and a fake Bops Cloud (its /v1/ws/<id>/people,
// routing and wake), with the open shared workspace a stand-in (lib/server/shared.ts sharedAdminOpen). The project is
// always the open shared workspace's, never one the request names; every call runs on the viewer's own key; orgo-web's
// "only the owner" reads as "Only the owner can add or change people for now."; each change goes to orgo-web and Bops
// Cloud in the owner's sheet's order (an Admin made a Member gets back their Member entry); removing someone takes their
// bots first; the owner is never invited, changed or removed; changes come only from the Bops window. Made up people.
// Usage: node --conditions=react-server scripts/test-shared-people.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.BOPS_SELF_HOSTED = "1";
for (const k of ["ORGO_API_KEY", "BOPS_ORGO_WORKSPACE", "BOPS_DATABASE_URL", "TAILSCALE_AUTH_KEY", "BOPS_COMPUTER_TOOL", "BOPS_UI_TOKEN", "AGENTMAIL_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
process.env.HOSTNAME = "127.0.0.1";
process.env.BOPS_TELEMETRY = "0";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-shared-people-"));
mkdirSync(join(scratch, "bin"));
writeFileSync(join(scratch, "bin", "security"), "#!/bin/sh\nexit 44\n");
chmodSync(join(scratch, "bin", "security"), 0o755);
process.env.PATH = `${join(scratch, "bin")}:${process.env.PATH}`;

const PROJECT = "7c7c7c7c-1111-4000-8000-000000000001";
const ADMIN_KEY = "sk_test_admin_viewer_key_000000";
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
// The open shared workspace, as lib/server/shared.ts gives it: its project and the viewer's own key, and Bops Cloud's routes.
const SHARED = `
export function sharedAdminOpen(o = {}) {
  const g = globalThis.__shared;
  if (!g.open || (!o.anyRole && g.role !== "admin")) return null;
  return { projectId: ${JSON.stringify(PROJECT)}, key: ${JSON.stringify(ADMIN_KEY)}, you: "u-ada", botIds: ["max", "ivy"], cloud: (m, p, b) => g.cloud(m, p, b), refresh: async () => void g.refreshed++ };
}
export const sharedOpen = () => !!globalThis.__shared.open;
`;
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
    if (name === "shared") return { format: "module", shortCircuit: true, source: SHARED };
    if (!name || !STAND_INS.has(name)) return next(url, context);
    return { format: "module", shortCircuit: true, source: "export {};" };
  },
});
process.chdir(scratch);
globalThis.bopsOrgoKey = "sk_test_the_users_own_key_not_used";

/* ---------------- Fakes: orgo-web, Bops Cloud ---------------- */

/** Every call to orgo-web and to Bops Cloud, in order: what the order of each change is checked by. */
const calls = [];
let replies = {};
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (not the fake Orgo: ${url})`);
  const text = req.body ? await req.text() : "";
  const call = { to: "orgo", method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined };
  calls.push(call);
  const reply = replies[`${call.method} ${call.path}`];
  return (reply && (await reply(call))) ?? json(404, { error: "Not found" });
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
let cloudReplies = {};
globalThis.__shared = {
  open: true,
  role: "admin",
  refreshed: 0,
  cloud: async (method, path, body) => {
    calls.push({ to: "cloud", method, path, body });
    const r = cloudReplies[`${method} ${path}`];
    return r ? r(body) : { status: 404, json: {} };
  },
};

const MEMBERS = [
  { id: "u-owner", alt: "Olive Owner", role: "owner", email: "olive@example.com" },
  { id: "u-ada", alt: "Ada Admin", role: "admin", email: "ada@example.com", bopsComputerUse: true },
  { id: "u-bo", alt: "Bo Admin", role: "admin", email: "bo@example.com", bopsComputerUse: true },
  { id: "u-cy", alt: "Cy Member", role: "member", email: "cy@example.com", bopsComputerUse: false },
];
const INVITES = [{ email: "dee@example.com", role: "viewer", status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString() }];
const SEATS = { product: "bops", plan: "pro_bops", can_add: true, limit: 5, used: 4, caps: { pro_bops: 5, max_bops: 10 } };
const membersPath = `/api/workspaces/${PROJECT}/members`;
const invitePath = `/api/workspaces/${PROJECT}/invite`;
function fresh(o = {}) {
  calls.length = 0;
  globalThis.__shared.open = true;
  globalThis.__shared.role = o.role ?? "admin";
  replies = {
    [`GET ${membersPath}`]: () => json(200, { members: MEMBERS, invites: INVITES, seats: SEATS, ...(o.can === false ? {} : { can: { managePeople: true } }) }),
    [`POST ${invitePath}`]: () => (o.inviteStatus ? json(o.inviteStatus, { error: "Only the owner can invite people" }) : json(200, { success: true, email_sent: true })),
    [`PATCH ${invitePath}`]: () => json(200, { success: true }),
    [`DELETE ${invitePath}`]: () => json(200, { success: true }),
    [`PATCH ${membersPath}`]: (c) => json(200, { success: true, ...(c.body.bopsComputerUse !== undefined ? { bopsComputerUse: c.body.bopsComputerUse } : {}) }),
    [`DELETE ${membersPath}`]: () => json(200, { success: true }),
    [`PATCH /api/projects/${PROJECT}`]: () => json(200, { success: true }),
  };
  cloudReplies = {
    "GET people": () => ({ status: 200, json: { entries: { "cy@example.com": { others: "none", bots: { max: "write" }, computer: "none" } } } }),
    "POST people": () => ({ status: 200, json: { ok: true } }),
    "PATCH routing": () => ({ status: 200, json: { ok: true, cloud: false, allowHourly: false } }),
    "POST wake": () => ({ status: 200, json: { ok: true, state: "woke" } }),
  };
}

const Caps = await import(`${root}/lib/server/cloud-caps.ts`);
const R = await import(`${root}/app/api/workspaces/shared/people/route.ts`);
const S = await import(`${root}/app/api/workspaces/shared/settings/route.ts`);
const W = await import(`${root}/app/api/workspaces/shared/wake/route.ts`);
const M = await import(`${root}/lib/members.ts`);
delete process.env.BOPS_SELF_HOSTED;
const caps = (list) => Caps.resetCloudCaps({ health: async () => ({ ok: true, macs: 0, caps: list }) });
caps(["roles", "admin_powers"]);

const call = async (mod, method, body, headers = {}) => {
  const req = new Request("http://localhost:3210/api/workspaces/shared/people", { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await mod[method](req);
  return { status: res.status, body: await res.json() };
};
const people = (method, body, headers) => call(R, method, body, headers);
const shape = () => calls.map((c) => `${c.to} ${c.method} ${c.path}`);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${e.stack ?? e}`);
  }
}

await check("reading: the open shared workspace's people, with the viewer's own key, the bots each Member has from Bops Cloud, and the owner as the owner", async () => {
  fresh();
  const r = await people("GET");
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "ready");
  assert.ok(calls.filter((c) => c.to === "orgo").every((c) => c.auth === `Bearer ${ADMIN_KEY}` && c.path.includes(PROJECT)), "the viewer's key, the open project");
  assert.deepEqual(r.body.you, { id: "u-owner", name: "Olive Owner", email: "olive@example.com" }, "the owner's row");
  assert.deepEqual(r.body.shared, { me: "u-ada", can: true });
  const cy = r.body.people.find((p) => p.id === "u-cy");
  assert.deepEqual([cy.role, cy.access.bots], ["viewer", { max: "write" }]);
  assert.equal(r.body.people.find((p) => p.id === "u-ada").role, "admin");
  assert.equal(r.body.seats.limit, 5, "the owner's seats");
  // An orgo-web from before (no `can`), or a Bops Cloud without admin powers: read only, saying why.
  fresh({ can: false });
  assert.deepEqual((await people("GET")).body.shared, { me: "u-ada", can: false, line: M.ADMIN_SHEET_WORDS.notOwnerOnly });
  caps(["roles"]);
  fresh();
  const old = await people("GET");
  assert.deepEqual(old.body.shared, { me: "u-ada", can: false, line: M.ADMIN_SHEET_WORDS.notYet });
  assert.ok(!calls.some((c) => c.to === "cloud"), "never asks an older Bops Cloud");
  caps(["roles", "admin_powers"]);
  // Not an Admin, or nothing open: no sheet.
  fresh({ role: "member" });
  assert.equal((await people("GET")).status, 409);
});

await check("inviting a Member: orgo-web first, on the owner's seats, then the bots their invite gives (never Use its computer); never the owner", async () => {
  fresh();
  const r = await people("POST", { email: "Eve@Example.com", role: "viewer", access: { others: "none", bots: { max: "write" }, computer: "use" }, projectId: "someone-else" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(shape(), [`orgo GET ${membersPath}`, "cloud GET people", `orgo POST ${invitePath}`, "cloud POST people"]);
  assert.deepEqual(calls[2].body, { email: "eve@example.com", permission: "viewer" });
  assert.deepEqual(calls[3].body, { who: { invite: "eve@example.com" }, access: { others: "none", bots: { max: "write" }, computer: "none" } });
  // An Admin's invite: nothing kept (they have every bot).
  fresh();
  await people("POST", { email: "fay@example.com", role: "admin" });
  assert.ok(!calls.some((c) => c.to === "cloud" && c.method === "POST"));
  // The owner's own email: never.
  fresh();
  const own = await people("POST", { email: "olive@example.com", role: "viewer" });
  assert.deepEqual([own.status, own.body.error], [400, M.ADMIN_SHEET_WORDS.ownersEmail]);
  assert.ok(!calls.some((c) => c.method === "POST"));
  // orgo-web says only the owner: in the sheet's words.
  fresh({ inviteStatus: 403 });
  const no = await people("POST", { email: "gus@example.com", role: "viewer" });
  assert.deepEqual([no.status, no.body.error], [403, M.ADMIN_SHEET_WORDS.notOwnerOnly]);
  // While orgo-web doesn't let them: nothing goes out.
  fresh({ can: false });
  const ro = await people("POST", { email: "gus@example.com", role: "viewer" });
  assert.equal(ro.status, 403);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

await check("an Admin made a Member gets back their Member entry (else Read on every bot), Use its computer off in orgo-web first; making someone an Admin keeps nothing", async () => {
  // Bops Cloud keeps Bo's entry from before they were an Admin (one bot at Read): that's what goes back, unchanged.
  fresh();
  cloudReplies["GET people"] = () => ({ status: 200, json: { entries: { "bo@example.com": { others: "none", bots: { ivy: "read" }, at: 1_700_000_000_000 } } } });
  const back = await people("PATCH", { memberId: "u-bo", role: "viewer" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(shape().slice(2), [`orgo PATCH ${membersPath}`, `orgo PATCH ${membersPath}`, "cloud POST people"]);
  assert.deepEqual(calls[3].body, { memberId: "u-bo", bopsComputerUse: false });
  assert.deepEqual(calls[4].body, { who: { memberId: "u-bo" }, access: { others: "none", bots: { ivy: "read" }, computer: "none" } }, "their own entry, not Read on every bot");
  // An entry with Use its computer keeps it on in orgo-web.
  fresh();
  cloudReplies["GET people"] = () => ({ status: 200, json: { entries: { "bo@example.com": { others: "none", bots: { max: "write" }, computer: "use" } } } });
  await people("PATCH", { memberId: "u-bo", role: "viewer" });
  assert.deepEqual(shape().slice(2), [`orgo PATCH ${membersPath}`, "cloud POST people"]);
  assert.deepEqual(calls[3].body.access, { others: "none", bots: { max: "write" }, computer: "use" });
  // None kept for them: Read on every bot, as an invite starts.
  fresh();
  cloudReplies["GET people"] = () => ({ status: 200, json: { entries: {} } });
  const r = await people("PATCH", { memberId: "u-bo", role: "viewer" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(shape().slice(2), [`orgo PATCH ${membersPath}`, `orgo PATCH ${membersPath}`, "cloud POST people"]);
  assert.deepEqual(calls[2].body, { memberId: "u-bo", role: "member" });
  assert.deepEqual(calls[3].body, { memberId: "u-bo", bopsComputerUse: false });
  assert.deepEqual(calls[4].body, { who: { memberId: "u-bo" }, access: { others: "none", bots: { max: "read", ivy: "read" }, apps: "read", computer: "none" } });
  fresh();
  await people("PATCH", { memberId: "u-cy", role: "admin" });
  assert.deepEqual(shape().slice(2), [`orgo PATCH ${membersPath}`]);
  // The owner: never.
  fresh();
  assert.equal((await people("PATCH", { memberId: "u-owner", role: "viewer" })).status, 400);
  assert.ok(!calls.some((c) => c.method === "PATCH"));
  // Their own role: never (after it their key could set neither their bots nor Use its computer). Leave stays theirs.
  fresh();
  const self = await people("PATCH", { memberId: "u-ada", role: "viewer" });
  assert.deepEqual([self.status, self.body.error], [400, M.ADMIN_SHEET_WORDS.ownRole]);
  assert.ok(!calls.some((c) => c.method === "PATCH" || c.method === "POST"));
  // An Admin's invite made a Member: what's kept for it, else Read on every bot.
  fresh();
  replies[`GET ${membersPath}`] = () => json(200, { members: MEMBERS, invites: [{ ...INVITES[0], email: "fay@example.com", role: "admin" }], seats: SEATS, can: { managePeople: true } });
  cloudReplies["GET people"] = () => ({ status: 200, json: { entries: { "fay@example.com": { others: "none", bots: { max: "read" }, invite: true } } } });
  await people("PATCH", { invite: "fay@example.com", role: "viewer" });
  assert.deepEqual(shape().slice(2), [`orgo PATCH ${invitePath}`], "their kept entry stands: nothing written over it");
  fresh();
  replies[`GET ${membersPath}`] = () => json(200, { members: MEMBERS, invites: [{ ...INVITES[0], email: "fay@example.com", role: "admin" }], seats: SEATS, can: { managePeople: true } });
  cloudReplies["GET people"] = () => ({ status: 200, json: { entries: {} } });
  await people("PATCH", { invite: "fay@example.com", role: "viewer" });
  assert.deepEqual(shape().slice(2), [`orgo PATCH ${invitePath}`, "cloud POST people"]);
  assert.deepEqual(calls.at(-1).body.access.bots, { max: "read", ivy: "read" });
});

await check("a Member's bots and Use its computer: orgo-web first for Use its computer, then the bots on Bops Cloud; an Admin's bots aren't picked", async () => {
  fresh();
  const r = await people("PATCH", { memberId: "u-cy", access: { others: "none", bots: { max: "write", ivy: "read" }, computer: "use" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(shape().slice(2), [`orgo PATCH ${membersPath}`, "cloud POST people"]);
  assert.deepEqual(calls[2].body, { memberId: "u-cy", bopsComputerUse: true });
  assert.deepEqual(calls[3].body.access.computer, "use");
  // Taken down to Read everywhere: Use its computer goes too (it comes with Write).
  fresh();
  await people("PATCH", { memberId: "u-cy", access: { others: "none", bots: { max: "read" } } });
  assert.deepEqual(calls.at(-1).body, { who: { memberId: "u-cy" }, access: { others: "none", bots: { max: "read" }, computer: "none" } });
  fresh();
  assert.equal((await people("PATCH", { memberId: "u-bo", access: { others: "read", bots: {} } })).status, 409);
  // A waiting invite's bots: Bops Cloud only.
  fresh();
  await people("PATCH", { invite: "dee@example.com", access: { others: "read", bots: {} } });
  assert.deepEqual(shape().slice(2), ["cloud POST people"]);
  assert.deepEqual(calls[2].body.who, { invite: "dee@example.com" });
});

await check("removing someone takes their bots first, then their access; cancelling an invite the same; leaving is always theirs; never the owner", async () => {
  fresh();
  const r = await people("DELETE", { memberId: "u-cy" });
  assert.equal(r.status, 200);
  assert.deepEqual(shape().slice(2), ["cloud POST people", `orgo DELETE ${membersPath}`]);
  assert.deepEqual(calls[2].body, { who: { memberId: "u-cy" }, access: null });
  fresh();
  await people("DELETE", { email: "dee@example.com" });
  assert.deepEqual(shape().slice(2), ["cloud POST people", `orgo DELETE ${invitePath}`]);
  fresh();
  assert.equal((await people("DELETE", { memberId: "u-owner" })).status, 400);
  assert.ok(!calls.some((c) => c.method === "DELETE"));
  // Leaving, even while they may not change people.
  fresh({ can: false });
  assert.equal((await people("DELETE", { memberId: "u-ada" })).status, 200);
  assert.ok(shape().includes(`orgo DELETE ${membersPath}`));
});

await check("the workspace's name (orgo-web, which every Bops follows) and where its chat is answered (Bops Cloud); waking a computer (Bops Cloud)", async () => {
  fresh();
  const n = await call(S, "PATCH", { name: "  Brand Team  " });
  assert.equal(n.status, 200);
  assert.deepEqual([calls[0].path, calls[0].body, calls[0].auth], [`/api/projects/${PROJECT}`, { name: "Brand Team" }, `Bearer ${ADMIN_KEY}`]);
  fresh();
  assert.equal((await call(S, "PATCH", { chat: "mac" })).status, 200);
  assert.deepEqual(calls[0], { to: "cloud", method: "PATCH", path: "routing", body: { mode: "mac" } });
  assert.equal((await call(S, "PATCH", { allowHourly: true })).status, 400, "never the hourly bill");
  fresh();
  const w = await call(W, "POST", { botId: "max" });
  assert.deepEqual([w.status, w.body], [200, { ok: true, state: "woke" }]);
  assert.equal((await call(W, "POST", { botId: "someone-elses" })).status, 404);
  // A Member may ask too (Bops Cloud decides by Use its computer).
  fresh({ role: "member" });
  assert.equal((await call(W, "POST", { botId: "max" })).status, 200);
});

await check("changes come only from the Bops window", async () => {
  process.env.BOPS_UI_TOKEN = "window-token-0123456789";
  for (const [mod, method] of [[R, "POST"], [R, "PATCH"], [R, "DELETE"], [S, "PATCH"], [W, "POST"]]) {
    fresh();
    const r = await call(mod, method, { memberId: "u-cy" });
    assert.deepEqual([r.status, r.body.code], [403, "WINDOW_ONLY"]);
    assert.equal(calls.length, 0);
  }
  const ok = await call(R, "DELETE", { memberId: "u-cy" }, { "x-bops-window": "window-token-0123456789" });
  assert.equal(ok.status, 200);
  delete process.env.BOPS_UI_TOKEN;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
