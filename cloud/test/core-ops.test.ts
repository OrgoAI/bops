import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { OPS_HANDLES_PATH, OPS_HANDLES_SIGNED, summarize, type AppInboxRow, type InboxRow, type LineRow, type OpsHandles } from "../ops.ts";
import { planSigned } from "../plans.ts";
import { dropUsers, fakeOrgo, newNumber, newUserId, prepareDb, seedUser, startCloud, type Listening } from "./core-fakes.ts";

/**
 * The staff page's view of each user's bot number and email (ops.ts): signed as orgo-web signs it
 * (the same test vector is in orgo-web's lib/ops/bops-handles.test.ts), 404 with no secret, read only,
 * released ones never counted, paused and broken ones counted and called out, the inboxes the Mac made
 * itself found in the app's state, and each user's best number and email shown.
 */

const SECRET = randomBytes(32).toString("base64");
const users: string[] = [];
let orgo: Listening, cloud: Listening;

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  process.env.BOPS_CLOUD_PLAN_SECRET = SECRET;
  cloud = await startCloud();
});

after(async () => {
  await dropUsers(users);
  await Promise.all([cloud?.close(), orgo?.close()]);
  await closeDb();
});

/** The call as orgo-web makes it (lib/ops/bops.ts readBotHandles). */
function ask(opts: { secret?: string; at?: number; signed?: string; headers?: Record<string, string> } = {}) {
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const sig = `sha256=${createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${opts.signed ?? OPS_HANDLES_SIGNED}`).digest("hex")}`;
  return fetch(`${cloud.url}${OPS_HANDLES_PATH}`, { headers: opts.headers ?? { "x-bops-timestamp": ts, "x-bops-signature": sig } }).then(async (r) => ({
    status: r.status,
    json: (await r.json().catch(() => null)) as OpsHandles | null,
  }));
}

const line = (userId: string, over: Partial<{ status: string; plan: boolean; owner: string | null; problem: string | null; createdAt: string }> = {}) => {
  const e164 = newNumber();
  return query(
    `INSERT INTO bops.phone_lines (digits, user_id, number_id, e164, status, plan, owner_number, claimed_at, claimed_via, problem, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END, CASE WHEN $7::text IS NULL THEN NULL ELSE 'call' END, $8, coalesce($9::timestamptz, now()))`,
    [e164.slice(-10), userId, `num_${randomUUID().slice(0, 8)}`, e164, over.status ?? "ready", over.plan ?? false, over.owner ?? null, over.problem ?? null, over.createdAt ?? null],
  ).then(() => e164);
};
const inbox = (userId: string, over: Partial<{ status: string; plan: boolean; problem: string | null; id: string }> = {}) => {
  const id = over.id ?? `boppy@t${randomBytes(4).toString("hex")}.bops.bot`;
  return query("INSERT INTO bops.mail_inboxes (inbox_id, user_id, pod_id, email, plan, status, problem) VALUES ($1, $2, 'pod_x', $1, $3, $4, $5)", [
    id,
    userId,
    over.plan ?? true,
    over.status ?? "ready",
    over.problem ?? null,
  ]).then(() => id);
};
const withState = (userId: string, state: unknown) => query("UPDATE bops.app_state SET state = $2::jsonb WHERE user_id = $1", [userId, JSON.stringify(state)]);
const user = async (what: string) => {
  const id = newUserId(`ops-${what}`);
  users.push(id);
  await seedUser(id);
  return id;
};

test("signed as orgo-web signs it: the shared test vector", () => {
  // orgo-web's lib/ops/bops-handles.test.ts checks the same signature from its side.
  const sig = "sha256=e65457bdfe6cd74486472f0e3d16150373b0e5f7e55d9eb6c92754c3f7e068c1";
  assert.equal(OPS_HANDLES_SIGNED, "GET /v1/internal/ops/handles");
  assert.equal(planSigned("bops-ops-test-secret", "1760000000", Buffer.from(OPS_HANDLES_SIGNED), sig, 1760000000_000), true);
  assert.equal(planSigned("bops-ops-test-secret", "1760000000", Buffer.from(OPS_HANDLES_SIGNED), sig, 1760000000_000 + 6 * 60_000), false, "more than 5 minutes off");
  assert.equal(planSigned("bops-ops-test-secret", "1760000000", Buffer.from(""), sig, 1760000000_000), false, "an empty body isn't this route");
});

test("refused unsigned, signed wrong, too old or for another route; 404 with no secret set", async () => {
  assert.equal((await ask({ headers: {} })).status, 401);
  assert.equal((await ask({ secret: "not-it" })).status, 401);
  assert.equal((await ask({ at: Date.now() - 10 * 60_000 })).status, 401);
  // A signature over a body (a plan notice's), or over nothing, is no good here.
  assert.equal((await ask({ signed: JSON.stringify({ userId: "x", tier: "pro_bops", at: new Date().toISOString() }) })).status, 401);
  assert.equal((await ask({ signed: "" })).status, 401);
  delete process.env.BOPS_CLOUD_PLAN_SECRET;
  try {
    assert.equal((await ask()).status, 404);
  } finally {
    process.env.BOPS_CLOUD_PLAN_SECRET = SECRET;
  }
  assert.equal((await ask()).status, 200);
});

test("each user's number and email from the tables and the app's state, with the counts", async () => {
  // Pro, set up: the plan's number (claimed by its owner) and inbox, both ready.
  const pro = await user("pro");
  const proNumber = await line(pro, { plan: true, owner: "+14155550100" });
  const proInbox = await inbox(pro);
  // Back on Free: the plan's number and inbox paused; an older number given back counts for nothing.
  const paused = await user("paused");
  await line(paused, { status: "released", plan: true });
  const pausedNumber = await line(paused, { status: "paused", plan: true });
  await inbox(paused, { status: "paused" });
  // Broken number; an inbox the Mac made itself before the plan (only in the state), on the main bot.
  const broken = await user("broken");
  const brokenNumber = await line(broken, { status: "broken", plan: true, problem: "AgentPhone said 500" });
  await withState(broken, {
    bots: [
      { id: "b2", isMain: false, email: "sam@other.bops.bot", mail: { inboxId: "sam@other.bops.bot", podId: "p" } },
      { id: "b1", isMain: true, workspaceId: "ws_main", email: "boppy@mine.bops.bot", mail: { inboxId: "boppy@mine.bops.bot", podId: "p" } },
      "not a bot",
    ],
  });
  // A released plan inbox the Mac's last upload still has: neither copy counts.
  const released = await user("released");
  const gone = await inbox(released, { status: "released" });
  await withState(released, { bots: [{ id: "b1", isMain: true, email: gone, mail: { inboxId: gone, podId: "p", plan: true } }] });
  // Nothing at all, and a state that isn't the app's shape.
  const none = await user("none");
  await withState(none, { bots: { not: "a list" } });
  // Two numbers of their own: the ready one shows, and both are counted.
  const two = await user("two");
  await line(two, { status: "setting_up", createdAt: new Date(Date.now() - 60_000).toISOString() });
  const twoReady = await line(two, { createdAt: new Date(Date.now() - 120_000).toISOString() });

  const r = await ask();
  assert.equal(r.status, 200);
  const got = new Map(r.json!.users.map((u) => [u.userId, u]));
  assert.deepEqual(got.get(pro), {
    userId: pro,
    phone: { e164: proNumber, status: "ready", plan: true, ownerClaimed: true, problem: null, count: 1 },
    email: { address: proInbox, status: "ready", plan: true, problem: null, source: "cloud", count: 1 },
  });
  assert.deepEqual(got.get(paused)?.phone, { e164: pausedNumber, status: "paused", plan: true, ownerClaimed: false, problem: null, count: 1 });
  assert.equal(got.get(paused)?.email?.status, "paused");
  assert.deepEqual(got.get(broken), {
    userId: broken,
    phone: { e164: brokenNumber, status: "broken", plan: true, ownerClaimed: false, problem: "AgentPhone said 500", count: 1 },
    email: { address: "boppy@mine.bops.bot", status: "ready", plan: false, problem: null, source: "app", count: 2 },
  });
  assert.deepEqual(got.get(released), { userId: released, phone: null, email: null });
  assert.deepEqual(got.get(none), { userId: none, phone: null, email: null });
  assert.deepEqual(got.get(two)?.phone, { e164: twoReady, status: "ready", plan: false, ownerClaimed: false, problem: null, count: 2 });

  // Other test files share the database, so the counts are checked against the list they came with.
  const list = r.json!.users;
  const c = r.json!.counts;
  assert.equal(c.users, list.length);
  assert.equal(c.withPhone, list.filter((u) => u.phone).length);
  assert.equal(c.withEmail, list.filter((u) => u.email).length);
  assert.equal(c.withBoth, list.filter((u) => u.phone && u.email).length);
  assert.equal(c.neither, list.filter((u) => !u.phone && !u.email).length);
  assert.equal(c.phonePaused, list.filter((u) => u.phone?.status === "paused").length);
  assert.ok(c.phonePaused >= 1 && c.emailPaused >= 1 && c.phoneProblem >= 1);
  // Read only: nothing changed.
  assert.equal((await query("SELECT count(*)::int AS n FROM bops.phone_lines WHERE user_id = ANY($1::text[])", [users])).rows[0].n, 6);
});

test("counts: released never, paused and broken in their own counts too, one number and email per user", () => {
  const at = (s: string) => new Date(s);
  const lines: LineRow[] = [
    { user_id: "a", e164: "+14155550001", status: "ready", plan: true, owner_claimed: true, problem: null, created_at: at("2026-10-01") },
    { user_id: "b", e164: "+14155550002", status: "paused", plan: true, owner_claimed: false, problem: null, created_at: at("2026-10-01") },
    { user_id: "c", e164: "+14155550003", status: "released", plan: true, owner_claimed: false, problem: null, created_at: at("2026-10-01") },
    { user_id: "d", e164: "+14155550004", status: "broken", plan: true, owner_claimed: false, problem: "no agent", created_at: at("2026-10-01") },
    // d's own number, ready, beats the plan's broken one; a plan's beats the user's own at the same standing.
    { user_id: "d", e164: "+14155550005", status: "ready", plan: false, owner_claimed: false, problem: null, created_at: at("2026-09-01") },
    { user_id: "e", e164: "+14155550006", status: "ready", plan: false, owner_claimed: false, problem: null, created_at: at("2026-10-02") },
    { user_id: "e", e164: "+14155550007", status: "ready", plan: true, owner_claimed: false, problem: null, created_at: at("2026-09-02") },
  ];
  const inboxes: InboxRow[] = [
    { user_id: "a", inbox_id: "a@x.bops.bot", email: "a@x.bops.bot", status: "ready", plan: true, problem: null, created_at: at("2026-10-01") },
    { user_id: "b", inbox_id: "b@x.bops.bot", email: "b@x.bops.bot", status: "paused", plan: true, problem: null, created_at: at("2026-10-01") },
    { user_id: "c", inbox_id: "c@x.bops.bot", email: "c@x.bops.bot", status: "released", plan: true, problem: null, created_at: at("2026-10-01") },
  ];
  const app: AppInboxRow[] = [
    // c's released plan inbox, still in the state: not counted. A copy of a's: not counted twice.
    { user_id: "c", inbox_id: "c@x.bops.bot", email: "c@x.bops.bot", is_main: true, workspace_id: "ws_main", paused: false, plan: false },
    { user_id: "a", inbox_id: "a@x.bops.bot", email: "a@x.bops.bot", is_main: true, workspace_id: "ws_main", paused: false, plan: true },
    // f has only state inboxes: the main bot's shows (a second workspace's main bot is not it).
    { user_id: "f", inbox_id: "w2@x.bops.bot", email: "w2@x.bops.bot", is_main: true, workspace_id: "ws_2", paused: false, plan: false },
    { user_id: "f", inbox_id: "main@x.bops.bot", email: "main@x.bops.bot", is_main: true, workspace_id: null, paused: false, plan: false },
    { user_id: "f", inbox_id: "main@x.bops.bot", email: "main@x.bops.bot", is_main: true, workspace_id: null, paused: false, plan: false },
  ];
  const out = summarize(["a", "b", "c", "d", "e", "f", "g"], lines, inboxes, app);
  const by = new Map(out.users.map((u) => [u.userId, u]));
  assert.deepEqual(out.users.map((u) => u.userId), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.equal(by.get("c")?.phone, null);
  assert.equal(by.get("c")?.email, null);
  assert.equal(by.get("d")?.phone?.e164, "+14155550005");
  assert.equal(by.get("d")?.phone?.count, 2);
  assert.equal(by.get("e")?.phone?.e164, "+14155550007");
  assert.equal(by.get("a")?.email?.count, 1);
  assert.deepEqual(by.get("f")?.email, { address: "main@x.bops.bot", status: "ready", plan: false, problem: null, source: "app", count: 2 });
  assert.deepEqual(out.counts, {
    users: 7,
    withPhone: 4, // a, b, d, e
    withEmail: 3, // a, b, f
    withBoth: 2, // a, b
    neither: 2, // c, g
    phonePaused: 1,
    phoneProblem: 0, // d's broken number isn't the one shown
    emailPaused: 1,
    emailProblem: 0,
  });
  // A user the tables or the state know but no account row is still a user.
  assert.equal(summarize([], [lines[0]], [], []).counts.users, 1);
});
