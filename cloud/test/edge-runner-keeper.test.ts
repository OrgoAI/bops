import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { refreshAppPolicy } from "../app-version.ts";
import { clearAuthCache } from "../auth.ts";
import { closeDb, ensureUserRow, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { CLOUD_SELF_MIN_VERSION, type KeeperAsk } from "../protocol.ts";
import { resetKeeper } from "../runner-keeper.ts";
import type { KnownRelease } from "../runner-release.ts";
import { noteTrouble } from "../turns.ts";
import { dropUsers, keyOf, listen, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * A computer's keeper asking Bops Cloud whether it may set up or update its runner (POST /v1/runner/keeper,
 * cloud/runner-keeper.ts), against Postgres: only a computer's own credential asks, and only about itself; each ask is
 * kept (bops.runner_keeper), nothing for an owner whose last Mac is older than CLOUD_SELF_MIN_VERSION; the answer is
 * only what to do, why and when to ask again, never a place or a version; it goes through with block_below set; and the
 * halts (for everyone or one owner), the slots (per owner and in all) and a reply being answered there. Also the
 * workspace's trouble when the keeper says the account's bots work on the Mac. orgo-web is a fake on localhost.
 */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/** orgo-web's profile: `key-<user>` is the user (an id made with "orgo" is Orgo's staff, @orgo.ai); `orgo_vm_<user>~<desktop>` that computer's identity. */
function profile(req: IncomingMessage, res: ServerResponse) {
  const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (req.url !== "/api/user/profile") return json(res, 404, {});
  const email = (id: string) => (id.startsWith("edge-orgo") ? `${id}@orgo.ai` : `${id}@example.com`);
  let m: RegExpExecArray | null;
  if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: email(m[1]) });
  if ((m = /^orgo_vm_([^~]+)~([^~]+)$/.exec(key)))
    return json(res, 200, { id: m[1], email: email(m[1]), api_key: null, principal: { kind: "vm_identity", desktop_id: m[2], expires_at: new Date(Date.now() + 3600_000).toISOString() } });
  json(res, 401, { error: "no" });
}

before(async () => {
  await prepareDb();
  orgo = await listen(createServer(profile));
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  process.env.BOPS_RUNNER_UPDATES = "on";
  process.env.BOPS_RUNNER_UPDATE_SLOTS = "1000";
  process.env.BOPS_RUNNER_OWNER_SLOTS = "1000";
  process.env.BOPS_RUNNER_SOAK_MIN = "60";
  cloud = await startCloud();
});

after(async () => {
  resetKeeper();
  for (const k of ["BOPS_RUNNER_UPDATES", "BOPS_RUNNER_UPDATE_SLOTS", "BOPS_RUNNER_OWNER_SLOTS", "BOPS_RUNNER_SOAK_MIN"]) delete process.env[k];
  await cloud.close();
  await orgo.close();
  await query("DELETE FROM bops.cloud_accounts WHERE user_id = ANY($1::text[])", [users]);
  await dropUsers(users);
  await closeDb();
});

/** A release only these tests know, signed a while ago (past the soak), with its own build so its halts are its own. */
const release = (buildId = `Build${randomUUID().slice(0, 8)}`, more: Partial<KnownRelease> = {}): KnownRelease => ({ version: "70.0.2", buildId, stateLevel: 4, releasedAt: Date.now() - 3 * 3600_000, ...more });
let REL = release();
const use = (r: KnownRelease) => {
  REL = r;
  resetKeeper({ release: () => REL });
};

/** A keeper's ask about an older runner there (70.0.1), on a Bops computer nobody else uses, having read REL. */
const ask = (more: Partial<KeeperAsk> = {}): KeeperAsk => ({
  keeper: "1",
  runner: { version: "70.0.1", buildId: "BuildOld_1", up: true },
  latest: { version: REL.version, buildId: REL.buildId },
  busy: false,
  key: false,
  runsOn: "cloud",
  computer: { shared: false, bops: true },
  ...more,
});

/**
 * An owner (`staff`: Orgo's own) whose Mac is at `mac`, with Max working on a computer of its own in workspace Acme,
 * switched to the cloud. Their Mac said its version and state level as it wrote the state.
 */
async function owner(o: { staff?: boolean; mac?: string; cloud?: boolean } = {}) {
  const id = newUserId(o.staff ? "orgo-keep" : "keep");
  users.push(id);
  const mac = o.mac ?? CLOUD_SELF_MIN_VERSION;
  const desktop = randomUUID();
  await ensureUserRow(id);
  await query("INSERT INTO bops.cloud_accounts (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  const headers = { Authorization: `Bearer ${keyOf(id)}`, "x-bops-user": id, "x-bops-protocol": "2", "x-bops-device": "mac-o", "x-bops-version": mac, "x-bops-state-level": "4", "content-type": "application/json" };
  const state = {
    owner: { name: "Sam" },
    workspaces: [{ id: "ws_main", name: "Main" }, { id: "ws_acme", name: "Acme" }],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true },
      { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: desktop },
    ],
  };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers, body: JSON.stringify({ base: 0, state }) })).status, 200);
  if (o.cloud !== false) assert.equal((await fetch(`${cloud.url}/v1/chat-routing`, { method: "POST", headers, body: JSON.stringify({ wsId: "ws_acme", mode: "cloud" }) })).status, 200);
  // What the Mac said is kept on the side: waited for, so nothing later writes over what a test sets.
  await until(async () => (await query<{ v: string | null }>("SELECT app_version AS v FROM bops.cloud_accounts WHERE user_id = $1", [id])).rows[0]?.v === mac, "the Mac's version kept");
  await query("UPDATE bops.cloud_accounts SET app_version = $2, state_level = 4 WHERE user_id = $1", [id, mac]);
  return { id, desktop };
}

const keeper = (userId: string, desktop: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${cloud.url}/v1/runner/keeper`, {
    method: "POST",
    headers: { Authorization: `Bearer orgo_vm_${userId}~${desktop}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const answer = async (userId: string, desktop: string, body: unknown = ask()) => {
  const r = await keeper(userId, desktop, body);
  assert.equal(r.status, 200, `${r.status}: ${await r.clone().text()}`);
  return (await r.json()) as Record<string, unknown>;
};
type Row = { keeper: string; runner: string | null; staff: boolean; runs_on: string | null; answer: string; why: string; go_at: Date | null; outcome: string | null; outcome_of: string | null; outcome_at: Date | null; asked_at: Date };
const rowOf = async (userId: string, desktop: string) =>
  (await query<Row>("SELECT keeper, runner, staff, runs_on, answer, why, go_at, outcome, outcome_of, outcome_at, asked_at FROM bops.runner_keeper WHERE user_id = $1 AND desktop_id = $2", [userId, desktop.toLowerCase()])).rows[0];

test("only a computer's own credential asks: the owner's key is 403, and a computer's ask is about itself alone", async () => {
  use(release());
  const o = await owner({ staff: true });
  const mine = await fetch(`${cloud.url}/v1/runner/keeper`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(o.id)}`, "x-bops-version": CLOUD_SELF_MIN_VERSION, "x-bops-state-level": "4", "content-type": "application/json" }, body: JSON.stringify(ask()) });
  assert.equal(mine.status, 403, "the owner's own key (their Mac)");
  assert.equal(await rowOf(o.id, o.desktop), undefined, "nothing kept");
  // A body that names another computer isn't an ask at all.
  const other = randomUUID();
  assert.equal((await keeper(o.id, o.desktop, { ...ask(), desktopId: other })).status, 400);
  // Its own computer, from its token: kept for it, and for no other.
  assert.deepEqual(await answer(o.id, o.desktop.toUpperCase()), { do: "update", why: "ok", retryS: 60 });
  assert.ok(await rowOf(o.id, o.desktop), "kept by its own computer id, lowercased");
  assert.equal(await rowOf(o.id, other), undefined);
  // A computer no bot of theirs works on is told so, about itself.
  const stray = randomUUID();
  assert.equal((await answer(o.id, stray)).why, "noBot");
});

test("each ask is kept: what it found, where Orgo said the bots work, the answer, when it last said go, and the last outcome until another", async () => {
  use(release());
  const o = await owner({ staff: true });
  await answer(o.id, o.desktop, ask({ runsOn: "mac" }));
  let row = await rowOf(o.id, o.desktop);
  assert.deepEqual([row.keeper, row.runner, row.staff, row.runs_on, row.answer, row.why, row.go_at, row.outcome], ["1", "70.0.1-BuildOld_1", true, "mac", "nothing", "accountMac", null, null]);
  const first = row.asked_at.getTime();
  await answer(o.id, o.desktop);
  row = await rowOf(o.id, o.desktop);
  assert.deepEqual([row.runs_on, row.answer, row.why], ["cloud", "update", "ok"]);
  assert.ok(row.go_at, "go said: when");
  assert.ok(row.asked_at.getTime() >= first);
  const go = row.go_at!.getTime();
  // How it went, kept past the next asks that say nothing of it; a "nothing" keeps when go was last said.
  await answer(o.id, o.desktop, ask({ runner: { version: REL.version, buildId: REL.buildId, up: true }, outcome: { kind: "updated", version: REL.version, buildId: REL.buildId } }));
  row = await rowOf(o.id, o.desktop);
  assert.deepEqual([row.answer, row.why, row.outcome, row.outcome_of, row.runner], ["nothing", "upToDate", "updated", `${REL.version}-${REL.buildId}`, `${REL.version}-${REL.buildId}`]);
  assert.equal(row.go_at!.getTime(), go);
  const at = row.outcome_at!.getTime();
  await answer(o.id, o.desktop, ask({ runner: { version: REL.version, buildId: REL.buildId, up: true } }));
  row = await rowOf(o.id, o.desktop);
  assert.deepEqual([row.outcome, row.outcome_of, row.outcome_at!.getTime()], ["updated", `${REL.version}-${REL.buildId}`, at]);
  // A first one: install, with no runner said.
  await query("DELETE FROM bops.runner_keeper WHERE user_id = $1", [o.id]);
  assert.deepEqual(await answer(o.id, o.desktop, ask({ runner: null })), { do: "install", why: "ok", retryS: 60 });
  row = await rowOf(o.id, o.desktop);
  assert.deepEqual([row.runner, row.answer], [null, "install"]);
  assert.ok(row.go_at);
});

test("an owner whose last Mac is at 0.0.54: answered ownerMac and nothing kept, whatever the keeper says", async () => {
  use(release());
  const o = await owner({ staff: true, mac: "0.0.54" });
  for (const body of [ask(), ask({ runner: null }), ask({ runsOn: "mac" }), ask({ outcome: { kind: "rolledBack", version: REL.version, buildId: REL.buildId } })])
    assert.deepEqual(await answer(o.id, o.desktop, body), { do: "nothing", why: "ownerMac", retryS: 7200 });
  assert.equal(await rowOf(o.id, o.desktop), undefined, "no row");
  assert.equal(((await query("SELECT count(*)::int AS n FROM bops.runner_keeper WHERE user_id = $1", [o.id])).rows[0] as { n: number }).n, 0);
  // Nor once the Mac moves on, until it asks again.
  await query("UPDATE bops.cloud_accounts SET app_version = $2 WHERE user_id = $1", [o.id, CLOUD_SELF_MIN_VERSION]);
  assert.equal((await answer(o.id, o.desktop)).do, "update");
});

test("the answer is what to do, why and when to ask again: never a place, a version or anything else", async () => {
  use(release());
  const o = await owner({ staff: true });
  for (const body of [ask(), ask({ runner: null }), ask({ runsOn: "mac" }), ask({ latest: null })]) {
    const r = await keeper(o.id, o.desktop, body);
    const text = await r.text();
    const a = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(a).sort(), ["do", "retryS", "why"]);
    assert.ok(!/https?:|\/\/|\d+\.\d+\.\d+|tgz|sha|Build/i.test(text), text);
  }
});

test("it goes through with block_below set: an old keeper or runner is how a computer gets new", async () => {
  use(release());
  const o = await owner({ staff: true });
  const was = (await query<{ b: string | null }>("SELECT block_below AS b FROM bops.app_policy WHERE id")).rows[0]?.b ?? null;
  await query("UPDATE bops.app_policy SET block_below = '99.0.0', updated_at = now() WHERE id");
  await refreshAppPolicy();
  try {
    // Another call of the same computer is refused, so the block is on.
    const head = await fetch(`${cloud.url}/v1/state/head`, { headers: { Authorization: `Bearer orgo_vm_${o.id}~${o.desktop}`, "x-bops-user": o.id, "x-bops-protocol": "2", "x-bops-version": "70.0.1" } });
    assert.equal(head.status, 426);
    // The keeper with no version of its own, and a runner's old one.
    assert.equal((await keeper(o.id, o.desktop, ask())).status, 200);
    assert.equal((await keeper(o.id, o.desktop, ask(), { "x-bops-version": "0.0.40" })).status, 200);
  } finally {
    await query("UPDATE bops.app_policy SET block_below = $1, updated_at = now() WHERE id", [was]);
    await refreshAppPolicy();
  }
});

test("a body over 4 KB is 413 and one that isn't an ask is 400, and nothing is kept of either", async () => {
  use(release());
  const o = await owner({ staff: true });
  const big = JSON.stringify({ ...ask(), pad: "x".repeat(5000) });
  assert.equal((await keeper(o.id, o.desktop, big)).status, 413);
  for (const body of ["not json", "[]", JSON.stringify({ ...ask(), busy: "no" }), JSON.stringify({ ...ask(), url: "https://example.com/r.tgz" })]) assert.equal((await keeper(o.id, o.desktop, body)).status, 400, body);
  assert.equal(await rowOf(o.id, o.desktop), undefined);
});

/** `n` computers of a new owner (each with a bot on it), their keepers having said they rolled REL back. */
async function rolledBack(n: number, staff: boolean) {
  const o = await owner({ staff });
  for (let i = 0; i < n; i++) {
    const desktop = i === 0 ? o.desktop : randomUUID();
    if (i > 0) await addComputer(o.id, desktop);
    await answer(o.id, desktop, ask({ outcome: { kind: "rolledBack", version: REL.version, buildId: REL.buildId, why: "it didn't answer on its computer" } }));
  }
  return o;
}
/** Another bot of the owner's, Ann, on a computer of its own in Acme. */
async function addComputer(userId: string, desktop: string) {
  const s = (await query<{ state: Record<string, unknown>; version: number }>("SELECT state, version FROM bops.app_state WHERE user_id = $1", [userId])).rows[0];
  const bots = [...(s.state.bots as unknown[]), { id: `ann-${desktop.slice(0, 6)}`, name: "Ann", workspaceId: "ws_acme", computerId: desktop }];
  await query("UPDATE bops.app_state SET state = $2::jsonb WHERE user_id = $1", [userId, JSON.stringify({ ...s.state, bots })]);
}

test("halts: 2 rollbacks of one owner halt the build for that owner alone; 2 on staff computers, or from 3 owners, for everyone", async () => {
  // One owner (not staff) whose 2 computers rolled it back: halted for them, and only them.
  use(release());
  const a = await rolledBack(2, false);
  const third = randomUUID();
  await addComputer(a.id, third);
  // (Past the soak for them too: a staff computer updated to it.)
  const s = await owner({ staff: true });
  await answer(s.id, s.desktop, ask({ runner: { version: REL.version, buildId: REL.buildId, up: true }, outcome: { kind: "updated", version: REL.version, buildId: REL.buildId } }));
  assert.equal((await answer(a.id, third)).why, "halted", "that owner's third computer");
  const b = await owner({ staff: false });
  assert.deepEqual(await answer(b.id, b.desktop), { do: "update", why: "ok", retryS: 60 }, "another owner");
  // Another build: 2 rollbacks on staff computers (one owner's two) halt it for everyone, staff too.
  use(release());
  await rolledBack(2, true);
  const c = await owner({ staff: false });
  assert.equal((await answer(c.id, c.desktop)).why, "halted");
  const d = await owner({ staff: true });
  assert.equal((await answer(d.id, d.desktop)).why, "halted");
  // Another: one rollback each from 3 owners, none staff: for everyone.
  use(release());
  for (let i = 0; i < 2; i++) await rolledBack(1, false);
  const e = await owner({ staff: true });
  assert.equal((await answer(e.id, e.desktop)).do, "update", "2 owners: not yet");
  await rolledBack(1, false);
  assert.equal((await answer(e.id, e.desktop)).why, "halted", "3 owners");
  // A rollback a day old counts no more.
  await query("UPDATE bops.runner_keeper SET outcome_at = now() - interval '25 hours' WHERE outcome_of = $1", [`${REL.version}-${REL.buildId}`]);
  assert.equal((await answer(e.id, e.desktop)).do, "update");
});

test("slots: BOPS_RUNNER_OWNER_SLOTS per owner and BOPS_RUNNER_UPDATE_SLOTS in all, per 15 minutes; a computer's own go doesn't count against it", async () => {
  use(release());
  const o = await owner({ staff: true });
  const more = [randomUUID(), randomUUID()];
  for (const d of more) await addComputer(o.id, d);
  process.env.BOPS_RUNNER_OWNER_SLOTS = "2";
  try {
    assert.equal((await answer(o.id, o.desktop)).do, "update");
    assert.equal((await answer(o.id, o.desktop)).do, "update", "asked again: its own go isn't another's slot");
    assert.equal((await answer(o.id, more[0])).do, "update");
    assert.deepEqual(await answer(o.id, more[1]), { do: "nothing", why: "slots", retryS: 300 }, "the owner's 2 taken");
    assert.equal((await answer(o.id, more[1], ask({ runner: null }))).why, "slots", "a first one too");
    // Another owner isn't held by these.
    const b = await owner({ staff: true });
    assert.equal((await answer(b.id, b.desktop)).do, "update");
    // In all: as many as were given lately, plus this one.
    const given = ((await query<{ n: number }>("SELECT count(*)::int AS n FROM bops.runner_keeper WHERE go_at > now() - interval '15 minutes'")).rows[0]).n;
    process.env.BOPS_RUNNER_UPDATE_SLOTS = String(given + 1);
    const c = await owner({ staff: true });
    assert.equal((await answer(c.id, c.desktop)).do, "update", "the last one");
    const d = await owner({ staff: true });
    assert.equal((await answer(d.id, d.desktop)).why, "slots", "none left for anyone");
    // 15 minutes on, they're free again.
    await query("UPDATE bops.runner_keeper SET go_at = now() - interval '16 minutes' WHERE go_at > now() - interval '15 minutes'");
    assert.equal((await answer(d.id, d.desktop)).do, "update");
  } finally {
    process.env.BOPS_RUNNER_OWNER_SLOTS = "1000";
    process.env.BOPS_RUNNER_UPDATE_SLOTS = "1000";
  }
});

test("a reply being answered on the computer holds its update; a first set up and other computers aren't held by it", async () => {
  use(release());
  const o = await owner({ staff: true });
  await query(
    `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, desktop_id, target_device, state, deadline, human_at)
     VALUES ($1, $2, 'm1', 'bot:max', 'max', 'ws_acme', $3, $4, 'claimed', now() + interval '10 minutes', 1)`,
    [o.id, `t-${randomUUID().slice(0, 8)}`, o.desktop, deviceIdOf(o.id, o.desktop)],
  );
  assert.deepEqual(await answer(o.id, o.desktop), { do: "nothing", why: "claimed", retryS: 120 });
  const other = randomUUID();
  await addComputer(o.id, other);
  assert.equal((await answer(o.id, other)).do, "update");
  await query("UPDATE bops.chat_turns SET state = 'done' WHERE user_id = $1", [o.id]);
  assert.equal((await answer(o.id, o.desktop)).do, "update");
});

test("the account on This Mac, as the keeper said: a cloud workspace whose computer has no runner says so (accountMac); for an owner at 0.0.54, as before", async () => {
  use(release());
  const o = await owner({ staff: true });
  assert.equal((await answer(o.id, o.desktop, ask({ runner: null, runsOn: "mac" }))).why, "accountMac");
  await noteTrouble(o.id, o.desktop, "noRunner", "max");
  const trouble = async (id: string) => (await query<{ t: string | null }>("SELECT trouble AS t FROM bops.chat_routing WHERE user_id = $1 AND ws_id = 'ws_acme'", [id])).rows[0]?.t;
  assert.equal(await trouble(o.id), "accountMac");
  // Orgo set to the cloud again: the next trouble is what it is.
  await answer(o.id, o.desktop, ask({ runner: null }));
  await noteTrouble(o.id, o.desktop, "noRunner", "max");
  assert.notEqual(await trouble(o.id), "accountMac");
  // An owner whose Mac is older: nothing kept of the keeper, the trouble as before.
  clearAuthCache();
  const old = await owner({ staff: true, mac: "0.0.54" });
  assert.equal((await answer(old.id, old.desktop, ask({ runner: null, runsOn: "mac" }))).why, "ownerMac");
  await noteTrouble(old.id, old.desktop, "noRunner", "max");
  assert.equal(await trouble(old.id), "noRunner");
});
