import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { CLOUD_ALL_MIN_VERSION, CLOUD_SELF_MIN_VERSION } from "../protocol.ts";
import { BOOT_EVERY_MS, BOOT_PATH, bootKeeper, signBoot } from "../runner-boot.ts";
import { dropUsers, fakeProvider, newUserId, prepareDb, seedUser, type Got } from "./core-fakes.ts";

/**
 * Bops Cloud asking orgo-web to put the keeper on a bot's computer that never got one (cloud/runner-boot.ts bootKeeper):
 * off unless BOPS_RUNNER_BOOT=on and BOPS_CLOUD_BOOT_SECRET is set; only for a computer whose bots are of one workspace
 * where cloudSelf holds (the owner's switch says cloud and their last Mac is at CLOUD_SELF_MIN_VERSION); never while its
 * keeper asked within 2 hours; at most once a computer in 6 hours (bops.runner_keeper.boot_at, taken in one statement);
 * signed as orgo-web checks it. orgo-web is a fake on localhost.
 */

const SECRET = "core-boot-secret-0123456789abcdef0123"; // gitleaks:allow (made up for this test)
const users: string[] = [];
let orgo: Awaited<ReturnType<typeof fakeProvider>>;
/** What the fake orgo-web answers the boot with (status and body). */
let answer: { status: number; json: unknown } = { status: 200, json: { ran: true, why: "started" } };
const boots = () => orgo.got.filter((g) => g.path === BOOT_PATH);

before(async () => {
  await prepareDb();
  orgo = await fakeProvider(() => ({ status: answer.status, json: answer.json }));
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
});

beforeEach(() => {
  process.env.BOPS_RUNNER_BOOT = "on";
  process.env.BOPS_CLOUD_BOOT_SECRET = SECRET;
  answer = { status: 200, json: { ran: true, why: "started" } };
  orgo.got.length = 0;
});

afterEach(() => {
  delete process.env.BOPS_RUNNER_BOOT;
  delete process.env.BOPS_CLOUD_BOOT_SECRET;
});

after(async () => {
  await query("DELETE FROM bops.cloud_accounts WHERE user_id = ANY($1::text[])", [users]);
  await dropUsers(users);
  await orgo.close();
  await closeDb();
});

/** A computer id as Orgo has it, upper case in the state as a Mac may write it. */
const desktopId = () => randomUUID().toUpperCase();

/**
 * An owner whose bot Max works on a computer of its own in workspace Acme (and Dana there with it), Acme switched to the
 * cloud, their last Mac at `mac`. `also`: more bots.
 */
async function owner(o: { mac?: string | null; mode?: "cloud" | "mac" | null; also?: Record<string, unknown>[]; desktop?: string } = {}) {
  const id = newUserId("boot");
  users.push(id);
  const desktop = o.desktop ?? desktopId();
  await seedUser(id);
  const state = {
    workspaces: [{ id: "ws_main", name: "Main" }, { id: "ws_acme", name: "Acme" }, { id: "ws_beta", name: "Beta" }],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true },
      { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: desktop },
      { id: "dana", name: "Dana", workspaceId: "ws_acme" },
      ...(o.also ?? []),
    ],
  };
  await query("UPDATE bops.app_state SET state = $2::jsonb WHERE user_id = $1", [id, JSON.stringify(state)]);
  if (o.mac !== null) await query("UPDATE bops.cloud_accounts SET app_version = $2 WHERE user_id = $1", [id, o.mac ?? CLOUD_SELF_MIN_VERSION]);
  if (o.mode !== null) await query("INSERT INTO bops.chat_routing (user_id, ws_id, mode) VALUES ($1, 'ws_acme', $2)", [id, o.mode ?? "cloud"]);
  return { id, desktop };
}

const rowOf = async (userId: string, desktop: string) =>
  (await query<{ keeper: string | null; asked_at: Date | null; boot_at: Date | null }>("SELECT keeper, asked_at, boot_at FROM bops.runner_keeper WHERE user_id = $1 AND desktop_id = $2", [userId, desktop.toLowerCase()])).rows[0];

test("off by default: unset, or anything but on, asks nothing and keeps nothing", async () => {
  const o = await owner();
  for (const v of [undefined, "1", "true", "ON", "off"]) {
    if (v === undefined) delete process.env.BOPS_RUNNER_BOOT;
    else process.env.BOPS_RUNNER_BOOT = v;
    assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "off" }, String(v));
  }
  assert.equal(boots().length, 0);
  assert.equal(await rowOf(o.id, o.desktop), undefined);
});

test("on with no BOPS_CLOUD_BOOT_SECRET: nothing asked", async () => {
  const o = await owner();
  delete process.env.BOPS_CLOUD_BOOT_SECRET;
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "unset" });
  assert.equal(boots().length, 0);
});

test("only for a computer whose bots are of one workspace where cloudSelf holds", async () => {
  // No bot works there.
  const none = await owner();
  assert.deepEqual(await bootKeeper(none.id, desktopId()), { asked: false, why: "noBot" });
  // Bots of two workspaces on it (Beta's own bot on Max's computer).
  const shared = desktopId();
  const two = await owner({ desktop: shared, also: [{ id: "bea", name: "Bea", isMain: true, workspaceId: "ws_beta", computerId: shared }] });
  assert.deepEqual(await bootKeeper(two.id, two.desktop), { asked: false, why: "manyWorkspaces" });
  // Not cloudSelf: Acme on the Mac, no switch at all, the owner's last Mac at CLOUD_ALL but not CLOUD_SELF, or never seen.
  for (const o of [{ mode: "mac" as const }, { mode: null }, { mac: CLOUD_ALL_MIN_VERSION }, { mac: null }]) {
    const x = await owner(o);
    assert.deepEqual(await bootKeeper(x.id, x.desktop), { asked: false, why: "notCloudSelf" }, JSON.stringify(o));
  }
  assert.equal(boots().length, 0);
  // All of it: asked.
  const ok = await owner();
  assert.deepEqual(await bootKeeper(ok.id, ok.desktop), { asked: true, status: 200, ran: true, why: "started" });
  assert.equal(boots().length, 1);
});

test("never while its keeper asked Bops Cloud within 2 hours", async () => {
  const o = await owner();
  await query("INSERT INTO bops.runner_keeper (user_id, desktop_id, keeper, asked_at) VALUES ($1, $2, '0.0.55', now() - interval '1 hour')", [o.id, o.desktop.toLowerCase()]);
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "keeperLive" });
  assert.equal((await rowOf(o.id, o.desktop))?.boot_at, null, "nothing taken");
  await query("UPDATE bops.runner_keeper SET asked_at = now() - interval '3 hours' WHERE user_id = $1", [o.id]);
  assert.equal((await bootKeeper(o.id, o.desktop)).asked, true);
  const row = await rowOf(o.id, o.desktop);
  assert.equal(row?.keeper, "0.0.55", "the keeper's columns as they were");
  assert.ok(row?.boot_at);
});

test("signed as orgo-web checks it: the exact body, its time, the boot secret", async () => {
  const o = await owner();
  const before = Math.floor(Date.now() / 1000);
  await bootKeeper(o.id, o.desktop);
  const [g] = boots() as Got[];
  assert.equal(g.method, "POST");
  assert.equal(g.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(g.body.toString("utf8")), { userId: o.id, desktopId: o.desktop.toLowerCase() });
  const ts = String(g.headers["x-bops-timestamp"]);
  assert.ok(Number(ts) >= before && Number(ts) <= before + 5, "now");
  const want = `sha256=${createHmac("sha256", SECRET).update(`${ts}.`).update(g.body).digest("hex")}`;
  assert.equal(g.headers["x-bops-signature"], want);
  assert.equal(signBoot(SECRET, ts, g.body.toString("utf8")), want);
  // Never the wake's secret, never anything but the two ids.
  assert.notEqual(g.headers["x-bops-signature"], signBoot("another-secret", ts, g.body.toString("utf8")));
  assert.deepEqual(Object.keys(JSON.parse(g.body.toString("utf8"))).sort(), ["desktopId", "userId"]);
});

test("at most once a computer in 6 hours, however many ask at once; then again", async () => {
  const o = await owner();
  const all = await Promise.all(Array.from({ length: 6 }, () => bootKeeper(o.id, o.desktop)));
  assert.equal(all.filter((x) => x.asked).length, 1);
  assert.ok(all.filter((x) => !x.asked).every((x) => x.why === "recent"));
  assert.equal(boots().length, 1);
  const row = await rowOf(o.id, o.desktop);
  assert.deepEqual([row?.keeper, row?.asked_at], [null, null], "a row kept only for boot_at");
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "recent" });
  // Just under 6 hours: still waits. Past: asked again.
  await query("UPDATE bops.runner_keeper SET boot_at = now() - make_interval(secs => $2) WHERE user_id = $1", [o.id, BOOT_EVERY_MS / 1000 - 60]);
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "recent" });
  await query("UPDATE bops.runner_keeper SET boot_at = now() - make_interval(secs => $2) WHERE user_id = $1", [o.id, BOOT_EVERY_MS / 1000 + 60]);
  assert.equal((await bootKeeper(o.id, o.desktop)).asked, true);
  assert.equal(boots().length, 2);
  // Another computer of the same owner is its own.
  const other = desktopId();
  await query("UPDATE bops.app_state SET state = jsonb_set(state, '{bots,2}', $2::jsonb) WHERE user_id = $1", [o.id, JSON.stringify({ id: "dana", name: "Dana", workspaceId: "ws_acme", computer: "own", computerId: other })]);
  assert.equal((await bootKeeper(o.id, other)).asked, true);
});

test("what orgo-web says is kept as it said it, and nothing it says throws", async () => {
  const o = await owner();
  answer = { status: 200, json: { desktopId: o.desktop.toLowerCase(), ran: false, why: "not_running" } };
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: true, status: 200, ran: false, why: "not_running" });
  for (const status of [401, 404, 503]) {
    const x = await owner();
    answer = { status, json: { error: "no" } };
    assert.deepEqual(await bootKeeper(x.id, x.desktop), { asked: true, status, ran: null, why: null });
  }
  // orgo-web not there at all.
  const gone = await owner();
  process.env.BOPS_ORGO_ORIGIN = "http://127.0.0.1:9";
  try {
    assert.deepEqual(await bootKeeper(gone.id, gone.desktop), { asked: true, status: 0, ran: null, why: null });
  } finally {
    process.env.BOPS_ORGO_ORIGIN = orgo.url;
  }
});
