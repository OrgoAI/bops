import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { call, dropUsers, fakeOrgo, keyOf, newUserId, prepareDb, seedUser, startCloud, type Listening } from "./core-fakes.ts";

/**
 * What Orgo tells users (cloud/notices.ts): each live notice once per user until they put it away (on
 * all their Macs), newest first, an "update" one only to apps older than its version, none that ended
 * or hasn't started, and nobody else's dismissal counts.
 */

const alice = newUserId("notices");
const bob = newUserId("notices-bob");
let orgo: Listening, cloud: Listening;
const made: string[] = [];

const post = async (n: { title: string; body?: string; link?: [string, string]; below?: string; starts?: string; ends?: string }) => {
  const r = await query<{ id: string }>(
    `INSERT INTO bops.notices (title, body, link_url, link_label, below_version, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7::timestamptz) RETURNING id::text AS id`,
    [n.title, n.body ?? "A few lines.", n.link?.[0] ?? null, n.link?.[1] ?? null, n.below ?? null, n.starts ?? null, n.ends ?? null],
  );
  made.push(r.rows[0].id);
  return r.rows[0].id;
};
const notices = async (user: string, version?: string) => {
  const r = await call(cloud.url, "GET", "/v1/notices", { key: keyOf(user), headers: version ? { "x-bops-version": version } : {} });
  assert.equal(r.status, 200, r.text);
  // Only this test's own (other rows may be there from someone else's run).
  return (r.json.notices as { id: string; title: string; body: string; link?: { url: string; label: string } }[]).filter((n) => made.includes(n.id));
};

before(async () => {
  await prepareDb();
  await Promise.all([seedUser(alice), seedUser(bob)]);
  orgo = await fakeOrgo();
  cloud = await startCloud();
});

after(async () => {
  if (made.length) await query("DELETE FROM bops.notices WHERE id = ANY($1::bigint[])", [made]);
  await dropUsers([alice, bob]);
  await Promise.all([cloud?.close(), orgo?.close()]);
  await closeDb();
});

test("live notices come newest first, for everyone or only apps older than their version; ended and later ones don't", async () => {
  const everyone = await post({ title: "Maintenance tonight", link: ["https://bops.bot/status", "Status"] });
  const update = await post({ title: "Update Bops", below: "0.0.19", link: ["https://bops.bot", "Download"] });
  await post({ title: "Over", ends: new Date(Date.now() - 60_000).toISOString() });
  await post({ title: "Later", starts: new Date(Date.now() + 3_600_000).toISOString() });
  // An app older than 0.0.19 gets both, newest first, with their links.
  assert.deepEqual(await notices(alice, "0.0.18"), [
    { id: update, title: "Update Bops", body: "A few lines.", link: { url: "https://bops.bot", label: "Download" } },
    { id: everyone, title: "Maintenance tonight", body: "A few lines.", link: { url: "https://bops.bot/status", label: "Status" } },
  ]);
  // 0.0.19 and newer get only the one for everyone (0.0.100 is newer than 0.0.19).
  for (const v of ["0.0.19", "0.0.100", "0.1.0"]) assert.deepEqual((await notices(alice, v)).map((n) => n.id), [everyone], v);
});

test("a notice put away stays away for that user, on any Mac, and only for them", async () => {
  const id = await post({ title: "New: pictures in chat" });
  assert.ok((await notices(alice, "0.0.19")).some((n) => n.id === id));
  const r = await call(cloud.url, "POST", "/v1/notices/dismiss", { key: keyOf(alice), json: { id } });
  assert.equal(r.status, 200, r.text);
  // Twice is fine.
  assert.equal((await call(cloud.url, "POST", "/v1/notices/dismiss", { key: keyOf(alice), json: { id } })).status, 200);
  assert.ok(!(await notices(alice, "0.0.19")).some((n) => n.id === id), "gone for alice");
  assert.ok((await notices(bob, "0.0.19")).some((n) => n.id === id), "still there for bob");
  // A notice that isn't there, or no id, changes nothing.
  assert.equal((await call(cloud.url, "POST", "/v1/notices/dismiss", { key: keyOf(alice), json: { id: "999999999999" } })).status, 200);
  for (const bad of [{}, { id: 7 }, { id: "1; drop" }]) assert.equal((await call(cloud.url, "POST", "/v1/notices/dismiss", { key: keyOf(alice), json: bad })).status, 400, JSON.stringify(bad));
  // Signed out: nothing.
  assert.equal((await call(cloud.url, "GET", "/v1/notices")).status, 401);
});
