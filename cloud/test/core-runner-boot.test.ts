import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { CLOUD_ALL_MIN_VERSION, CLOUD_SELF_MIN_VERSION, RUNNER_EXPOSED, RUNNER_FULL_ACCESS, RUNNER_LISTENS_UNKNOWN, RUNNER_OWNER_ONLY } from "../protocol.ts";
import { BOOT_EVERY_MS, BOOT_KEEPER_GONE_MS, BOOT_PATH, BOOT_RETRY_MS, bootKeeper, setBootUpdatesGate, signBoot } from "../runner-boot.ts";
import { dropUsers, fakeProvider, newUserId, prepareDb, seedUser, type Got } from "./core-fakes.ts";

/**
 * Bops Cloud asking orgo-web to put the keeper on a bot's computer that never got one (cloud/runner-boot.ts bootKeeper):
 * off unless BOPS_RUNNER_BOOT=on and BOPS_CLOUD_BOOT_SECRET is set; only for a computer whose bots are of one workspace
 * where cloudSelf holds (the owner's switch says cloud and their last Mac is at CLOUD_SELF_MIN_VERSION); never for one
 * whose keeper asked within 24 hours, whose runner the owner's Mac keeps down, or someone else can use unless the Mac
 * would keep the asking runner there (cloudRecord's rule); at most once a computer in 6 hours (bops.runner_keeper.boot_at,
 * taken in one statement), given back for 15 minutes after an answer that isn't final; the cheap checks before the
 * owner's state; signed as orgo-web checks it. orgo-web is a fake on localhost.
 */

/** lib/types.ts RUNNER_NO_SIGN_IN, word for word (Bops Cloud doesn't import the app's types). */
const NO_SIGN_IN = "it couldn't sign in on its computer";
const SECRET = "core-boot-secret-0123456789abcdef0123"; // gitleaks:allow (made up for this test)
const users: string[] = [];
let orgo: Awaited<ReturnType<typeof fakeProvider>>;
/** What the fake orgo-web answers the boot with (status and body). */
let answer: { status: number; json: unknown } = { status: 200, json: { ran: true, why: "started" } };
/** Run by the fake orgo-web before it answers, if set. */
let onAsk: (() => Promise<void>) | null = null;
const boots = () => orgo.got.filter((g) => g.path === BOOT_PATH);

before(async () => {
  await prepareDb();
  orgo = await fakeProvider(async () => {
    await onAsk?.();
    return { status: answer.status, json: answer.json };
  });
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
});

beforeEach(() => {
  process.env.BOPS_RUNNER_BOOT = "on";
  process.env.BOPS_CLOUD_BOOT_SECRET = SECRET;
  answer = { status: 200, json: { ran: true, why: "started" } };
  onAsk = null;
  orgo.got.length = 0;
});

afterEach(() => {
  delete process.env.BOPS_RUNNER_BOOT;
  delete process.env.BOPS_CLOUD_BOOT_SECRET;
  setBootUpdatesGate();
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
 * cloud, their last Mac at `mac`. `also`: more bots. `acme`: more on Acme as the state has it (its members, chatOn).
 * `runner`: the owner's record of the runner on Max's computer.
 */
async function owner(
  o: { mac?: string | null; mode?: "cloud" | "mac" | null; also?: Record<string, unknown>[]; desktop?: string; acme?: Record<string, unknown>; runner?: Record<string, unknown> } = {},
) {
  const id = newUserId("boot");
  users.push(id);
  const desktop = o.desktop ?? desktopId();
  await seedUser(id);
  const state = {
    workspaces: [{ id: "ws_main", name: "Main" }, { id: "ws_acme", name: "Acme", ...o.acme }, { id: "ws_beta", name: "Beta" }],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true },
      { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: desktop },
      { id: "dana", name: "Dana", workspaceId: "ws_acme" },
      ...(o.also ?? []),
    ],
    ...(o.runner ? { runners: { [desktop]: o.runner } } : {}),
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

test("only a computer that never had a keeper: never one whose keeper asked within 24 hours, however slow its looks", async () => {
  const o = await owner();
  await query("INSERT INTO bops.runner_keeper (user_id, desktop_id, keeper, asked_at) VALUES ($1, $2, '0.0.55', now() - interval '1 hour')", [o.id, o.desktop.toLowerCase()]);
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "hadKeeper" });
  // Past KEEPER_LIVE_MS (2 hours) but within a keeper's slowest look: still there, never booted over.
  for (const h of [3, 7, 23]) {
    await query("UPDATE bops.runner_keeper SET asked_at = now() - make_interval(hours => $2) WHERE user_id = $1", [o.id, h]);
    assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "hadKeeper" }, `${h} hours ago`);
  }
  assert.equal((await rowOf(o.id, o.desktop))?.boot_at, null, "nothing taken");
  assert.equal(boots().length, 0);
  // Gone past BOOT_KEEPER_GONE_MS: asked, the keeper's columns as they were.
  await query("UPDATE bops.runner_keeper SET asked_at = now() - make_interval(secs => $2) WHERE user_id = $1", [o.id, BOOT_KEEPER_GONE_MS / 1000 + 60]);
  assert.equal((await bootKeeper(o.id, o.desktop)).asked, true);
  const row = await rowOf(o.id, o.desktop);
  assert.equal(row?.keeper, "0.0.55", "the keeper's columns as they were");
  assert.ok(row?.boot_at);
});

test("never where the owner's Mac keeps the runner down: being stopped, or failed for a reason a runner connecting doesn't outlive", async () => {
  const at = Date.now() - 60_000;
  for (const error of [RUNNER_FULL_ACCESS, RUNNER_OWNER_ONLY, RUNNER_EXPOSED, RUNNER_LISTENS_UNKNOWN, NO_SIGN_IN, "something not named"]) {
    const o = await owner({ runner: { status: "failed", error, at } });
    assert.deepEqual(await bootKeeper(o.id, o.desktop, "identity"), { asked: false, why: "keptDown" }, error);
  }
  const failedBare = await owner({ runner: { status: "failed", at } });
  assert.deepEqual(await bootKeeper(failedBare.id, failedBare.desktop, "identity"), { asked: false, why: "keptDown" }, "failed, no reason");
  const stopping = await owner({ runner: { status: "stopping", at } });
  assert.deepEqual(await bootKeeper(stopping.id, stopping.desktop, "identity"), { asked: false, why: "keptDown" });
  assert.equal(boots().length, 0);
  // Failed for a passing reason (RUNNER_FAILED_PASSING), being set up, or running: asked.
  for (const runner of [{ status: "failed", error: "its computer didn't answer", at }, { status: "installing", at }, { status: "running", version: "0.0.54", at }]) {
    const o = await owner({ runner });
    assert.equal((await bootKeeper(o.id, o.desktop, "identity")).asked, true, JSON.stringify(runner));
  }
});

test("on a computer someone else can use, only for a runner the Mac would keep there: on its identity, chat through Bops Cloud, no key Bops gave", async () => {
  const members = { memberAccess: { "sam@example.com": { others: "none", bots: { max: "write" }, computer: "use" } } };
  const team = { ...members, chatOn: "cloud" };
  // A runner from before on the computer's key (a staff owner's team computer): refused, as cloudRecord refuses its record.
  const keyed = await owner({ acme: team });
  assert.deepEqual(await bootKeeper(keyed.id, keyed.desktop, "key"), { asked: false, why: "shared" });
  // A wake: no runner to say what it signs in with.
  const woke = await owner({ acme: team });
  assert.deepEqual(await bootKeeper(woke.id, woke.desktop), { asked: false, why: "shared" });
  // On its identity, but Acme's chat not kept in the cloud (chatOn mac, or never said), or its record bound to a key Bops gave.
  for (const acme of [{ ...members, chatOn: "mac" }, members, { ...members, chatAuto: true, chatOn: "mac" }]) {
    const o = await owner({ acme });
    assert.deepEqual(await bootKeeper(o.id, o.desktop, "identity"), { asked: false, why: "shared" }, JSON.stringify(acme));
  }
  const bound = await owner({ acme: team, runner: { status: "running", version: "0.0.54", keyMade: true, at: Date.now() } });
  assert.deepEqual(await bootKeeper(bound.id, bound.desktop, "identity"), { asked: false, why: "shared" });
  // Members nowhere, but the record says shared: the same.
  const said = await owner({ runner: { status: "running", version: "0.0.54", shared: true, at: Date.now() } });
  assert.deepEqual(await bootKeeper(said.id, said.desktop, "key"), { asked: false, why: "shared" });
  assert.equal(boots().length, 0);
  // What the Mac keeps: on its identity, Acme's chat in the cloud (chosen, or by itself while the Mac wasn't chosen).
  for (const acme of [team, { ...members, chatAuto: true }]) {
    const o = await owner({ acme });
    assert.equal((await bootKeeper(o.id, o.desktop, "identity")).asked, true, JSON.stringify(acme));
  }
  // A computer only the owner uses: whatever it signs in with, and after a wake.
  for (const auth of ["key", null] as const) {
    const o = await owner();
    assert.equal((await bootKeeper(o.id, o.desktop, auth)).asked, true, String(auth));
  }
  assert.equal(boots().length, 4);
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

/** How long ago the computer's ask was taken (boot_at), in seconds. */
const bootAgo = async (userId: string, desktop: string) =>
  Number((await query<{ s: string }>("SELECT extract(epoch FROM now() - boot_at) AS s FROM bops.runner_keeper WHERE user_id = $1 AND desktop_id = $2", [userId, desktop.toLowerCase()])).rows[0]?.s);

test("an answer that isn't final gives the ask back: asked again 15 minutes on, not 6 hours; a final one keeps the 6 hours", async () => {
  const retryIn = (BOOT_EVERY_MS - BOOT_RETRY_MS) / 1000;
  const cases: { answer: typeof answer | null; final: boolean }[] = [
    { answer: { status: 503, json: { error: "database" } }, final: false },
    { answer: { status: 401, json: { error: "bad_signature" } }, final: false },
    { answer: { status: 404, json: { error: "not_found" } }, final: false },
    { answer: { status: 400, json: { error: "bad_request" } }, final: false },
    { answer: { status: 200, json: { ran: false, why: "not_running" } }, final: false },
    { answer: { status: 200, json: { ran: false, why: "unreachable" } }, final: false },
    { answer: { status: 200, json: { ran: false, why: "paused" } }, final: false },
    { answer: { status: 200, json: { ran: false, why: "something new" } }, final: false },
    { answer: { status: 200, json: "not an answer" }, final: false },
    { answer: null, final: false },
    { answer: { status: 200, json: { ran: true, why: "started" } }, final: true },
    ...["too_soon", "not_eligible", "not_bops", "no_node", "no_tools", "failed", "deleted", "not_owner"].map((why) => ({ answer: { status: 200, json: { ran: false, why } }, final: true })),
  ];
  for (const c of cases) {
    const o = await owner();
    const label = JSON.stringify(c.answer);
    if (c.answer) answer = c.answer;
    else process.env.BOPS_ORGO_ORIGIN = "http://127.0.0.1:9";
    try {
      assert.equal((await bootKeeper(o.id, o.desktop)).asked, true, label);
    } finally {
      process.env.BOPS_ORGO_ORIGIN = orgo.url;
    }
    const ago = await bootAgo(o.id, o.desktop);
    if (c.final) assert.ok(ago >= 0 && ago < 60, `${label}: kept for 6 hours (${ago})`);
    else assert.ok(Math.abs(ago - retryIn) < 60, `${label}: given back (${ago})`);
    // Right after: waits either way.
    answer = { status: 200, json: { ran: true, why: "started" } };
    assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "recent" }, label);
    // 15 minutes on: asked again only when it wasn't final.
    await query("UPDATE bops.runner_keeper SET boot_at = boot_at - make_interval(secs => $2) WHERE user_id = $1", [o.id, BOOT_RETRY_MS / 1000 + 60]);
    assert.equal((await bootKeeper(o.id, o.desktop)).asked, !c.final, label);
  }
});

test("an ask given back never undoes a later one's", async () => {
  const o = await owner();
  // While orgo-web is asked (and answers 503), the computer's boot_at moves on, as another ask taking it would.
  const later = new Date(Date.now() + 5_000);
  answer = { status: 503, json: { error: "database" } };
  onAsk = async () => void (await query("UPDATE bops.runner_keeper SET boot_at = $2 WHERE user_id = $1", [o.id, later]));
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: true, status: 503, ran: null, why: null });
  assert.equal((await rowOf(o.id, o.desktop))?.boot_at?.getTime(), later.getTime(), "the later ask's boot_at stays");
});

test("the cheap checks come first: a computer asked lately, or with a keeper, is skipped before anything of the owner's state is read", async () => {
  // No bot works on these computers: had the state been read first, it'd say noBot.
  const o = await owner();
  const recent = desktopId();
  const kept = desktopId();
  await query("INSERT INTO bops.runner_keeper (user_id, desktop_id, boot_at) VALUES ($1, $2, now() - interval '1 hour')", [o.id, recent.toLowerCase()]);
  await query("INSERT INTO bops.runner_keeper (user_id, desktop_id, keeper, asked_at) VALUES ($1, $2, '0.0.55', now() - interval '5 hours')", [o.id, kept.toLowerCase()]);
  assert.deepEqual(await bootKeeper(o.id, recent), { asked: false, why: "recent" });
  assert.deepEqual(await bootKeeper(o.id, kept), { asked: false, why: "hadKeeper" });
  assert.deepEqual(await bootKeeper(o.id, desktopId()), { asked: false, why: "noBot" });
  // The owner's last Mac too old: before the row and the state.
  const old = await owner({ mac: CLOUD_ALL_MIN_VERSION });
  await query("INSERT INTO bops.runner_keeper (user_id, desktop_id, boot_at) VALUES ($1, $2, now())", [old.id, old.desktop.toLowerCase()]);
  assert.deepEqual(await bootKeeper(old.id, old.desktop), { asked: false, why: "notCloudSelf" });
});

test("the runner updates gate (BOPS_RUNNER_UPDATES once K2 is in) stops boots, nothing taken", async () => {
  const o = await owner();
  const asked: string[] = [];
  setBootUpdatesGate((id) => {
    asked.push(id);
    return false;
  });
  assert.deepEqual(await bootKeeper(o.id, o.desktop), { asked: false, why: "updatesOff" });
  assert.deepEqual(asked, [o.id]);
  assert.equal(await rowOf(o.id, o.desktop), undefined, "nothing taken");
  setBootUpdatesGate(async () => true);
  assert.equal((await bootKeeper(o.id, o.desktop)).asked, true);
  assert.equal(boots().length, 1);
});
