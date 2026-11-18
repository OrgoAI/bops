import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { RELEASE_MAX_BYTES, type RunnerRelease } from "../protocol.ts";
import { checkReleases, forgetReleases, latestRelease, loadReleases, RELEASE_KEYS, RELEASE_MAX_TEXT, releaseOf, verifyRelease } from "../runner-release.ts";
import { listen, prepareDb, type Listening } from "./core-fakes.ts";

/**
 * Signed runner releases (cloud/runner-release.ts): latest.json is `{payload, sig, keyId}`, and only a payload signed by a
 * release key Bops Cloud has built in, saying a well-formed release, is one. Bops Cloud reads it without following a
 * redirect and with a cap, keeps each new one (bops.runner_releases), and a version it hadn't seen tells every runner once.
 * Every key here is made for the test, at run time: none is the release key.
 */

/** A throwaway release key, and another one. */
const mine = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const pem = (k: KeyObject) => k.export({ type: "spki", format: "pem" }).toString();
const KEYS = { t1: pem(mine.publicKey) };

/** Versions no real release has, so the rows this file keeps are its own. */
const V1 = "70.0.1";
const V2 = "70.0.2";
const releaseOfV = (version: string, buildId = "BuildAbc_1", more: Partial<RunnerRelease> = {}): RunnerRelease => ({
  kind: "bops-runner",
  version,
  buildId,
  name: `bops-server-${version}-${buildId}.tgz`,
  sha256: "a".repeat(64),
  size: 150 * 1024 * 1024,
  released: "2026-11-18T20:00:00.000Z",
  stateLevel: 4,
  ...more,
});
/** latest.json for `payload` (any object, or text as is), signed with `key` as `keyId`. */
const signed = (payload: unknown, key: KeyObject = mine.privateKey, keyId = "t1") => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return JSON.stringify({ payload: text, sig: sign(null, Buffer.from(text, "utf8"), key).toString("base64"), keyId });
};

/**
 * latest.json served on localhost: what each path answers (a status, headers, and a body sent whole, or `chunks` of 1 KB
 * streamed with no length said), and how many times each was asked.
 */
type Answer = { status: number; headers: Record<string, string>; body?: string; chunks?: number };
let site: Listening;
const answers = new Map<string, Answer>();
const hits = new Map<string, number>();

before(async () => {
  await prepareDb();
  site = await listen(
    createServer((req, res) => {
      const path = req.url ?? "/";
      hits.set(path, (hits.get(path) ?? 0) + 1);
      const a = answers.get(path);
      if (!a) return void res.writeHead(404).end();
      res.writeHead(a.status, a.headers);
      for (let i = 0; i < (a.chunks ?? 0); i++) res.write("y".repeat(1024));
      res.end(a.body);
    }),
  );
});

beforeEach(async () => {
  forgetReleases();
  answers.clear();
  hits.clear();
  await query("DELETE FROM bops.runner_releases WHERE version LIKE '70.%'");
});

after(async () => {
  forgetReleases();
  await query("DELETE FROM bops.runner_releases WHERE version LIKE '70.%'");
  await site.close();
  await closeDb();
});

const serve = (path: string, body: string) => answers.set(path, { status: 200, headers: { "content-type": "application/json" }, body });

test("the release key built in is Orgo's r1, an ed25519 public key, and the only one", () => {
  assert.deepEqual(Object.keys(RELEASE_KEYS), ["r1"]);
  const k = createPublicKey(RELEASE_KEYS.r1);
  assert.equal(k.asymmetricKeyType, "ed25519");
  assert.equal(k.type, "public");
  assert.match(RELEASE_KEYS.r1, /MCowBQYDK2VwAyEAOnXNLbg1J\+CrDAspBAmssN\/uaC\+mJDB3RvCQM8qrMH0=/);
  assert.ok(Object.isFrozen(RELEASE_KEYS), "nothing adds a key at run time");
});

test("a release signed by a known key and well formed is one, as signed", () => {
  const r = releaseOfV(V1);
  assert.deepEqual(verifyRelease(signed(r), KEYS), r);
  // Its exact text is what was signed: the same release laid out otherwise is still that release.
  assert.deepEqual(verifyRelease(signed(JSON.stringify(r, null, 2)), KEYS), r);
});

test("a bad signature, a key it doesn't know or one that isn't ed25519 is no release", () => {
  const r = releaseOfV(V1);
  const good = JSON.parse(signed(r)) as { payload: string; sig: string; keyId: string };
  // The payload changed after it was signed.
  assert.equal(verifyRelease(JSON.stringify({ ...good, payload: good.payload.replace(V1, V2) }), KEYS), null);
  // Signed by another key under a known keyId.
  assert.equal(verifyRelease(signed(r, other.privateKey, "t1"), KEYS), null);
  // A keyId it doesn't have, and the built-in key for a release a test key signed.
  assert.equal(verifyRelease(signed(r, mine.privateKey, "t2"), KEYS), null);
  assert.equal(verifyRelease(signed(r, mine.privateKey, "r1")), null, "RELEASE_KEYS is the default, and r1 didn't sign it");
  assert.equal(verifyRelease(signed(r, mine.privateKey, "toString"), KEYS), null, "only the keys' own ids");
  // A signature that isn't one (wrong length, not base64), or none.
  assert.equal(verifyRelease(JSON.stringify({ ...good, sig: good.sig.slice(4) }), KEYS), null);
  assert.equal(verifyRelease(JSON.stringify({ ...good, sig: "not base64 at all" }), KEYS), null);
  assert.equal(verifyRelease(JSON.stringify({ payload: good.payload, keyId: "t1" }), KEYS), null);
  // A key that isn't ed25519 in the list is no key.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal(verifyRelease(signed(r, mine.privateKey, "rsa"), { rsa: pem(rsa.publicKey) }), null);
  // Not JSON, not an object, too long.
  assert.equal(verifyRelease("{", KEYS), null);
  assert.equal(verifyRelease("[]", KEYS), null);
  assert.equal(verifyRelease(signed(r).padEnd(RELEASE_MAX_TEXT + 1, " "), KEYS), null);
});

test("signed but not a well-formed release: the wrong kind or name, too big, a bad version, build, hash, time or state level", () => {
  const bad = (more: Partial<RunnerRelease> | Record<string, unknown>) => verifyRelease(signed({ ...releaseOfV(V1), ...more }), KEYS);
  assert.equal(bad({ kind: "bops-app" }), null, "kind");
  assert.equal(bad({ name: `bops-server-${V2}-BuildAbc_1.tgz` }), null, "a name of another version");
  assert.equal(bad({ name: `bops-server-${V1}-Other.tgz` }), null, "a name of another build");
  assert.equal(bad({ name: `bops-server-${V1}-BuildAbc_1.tar.gz` }), null, "not a bundle's name");
  assert.equal(bad({ name: `../bops-server-${V1}-BuildAbc_1.tgz` }), null, "a path");
  assert.equal(bad({ size: RELEASE_MAX_BYTES + 1 }), null, "over 400 MB");
  assert.ok(bad({ size: RELEASE_MAX_BYTES }), "400 MB is fine");
  assert.equal(bad({ size: 0 }), null);
  assert.equal(bad({ size: 1.5 }), null);
  assert.equal(bad({ size: "150" }), null);
  for (const version of ["70.0", "v70.0.1", "70.0.1.2", "70.0.x", 70]) assert.equal(verifyRelease(signed({ ...releaseOfV(V1), version, name: `bops-server-${version}-BuildAbc_1.tgz` }), KEYS), null, `version ${version}`);
  assert.equal(verifyRelease(signed({ ...releaseOfV(V1), buildId: "no spaces", name: `bops-server-${V1}-no spaces.tgz` }), KEYS), null, "build");
  assert.equal(bad({ sha256: "A".repeat(64) }), null, "hash in lowercase hex");
  assert.equal(bad({ sha256: "a".repeat(63) }), null);
  assert.equal(bad({ released: "yesterday" }), null, "released");
  assert.equal(bad({ released: 1_700_000_000_000 }), null);
  for (const stateLevel of [0, 10_000, -1, 4.5, "4"]) assert.equal(bad({ stateLevel }), null, `stateLevel ${stateLevel}`);
  assert.ok(bad({ stateLevel: 9999 }));
  assert.ok(bad({ stateLevel: 1 }));
  // A payload that isn't JSON, or isn't an object, signed all the same.
  assert.equal(verifyRelease(signed("not json"), KEYS), null);
  assert.equal(verifyRelease(signed("[1]"), KEYS), null);
});

test("a redirect is never followed, and an answer that isn't 200 or is too long is no release", async () => {
  serve("/real.json", signed(releaseOfV(V1)));
  answers.set("/latest.json", { status: 302, headers: { location: `${site.url}/real.json` } });
  let nudged = 0;
  assert.equal(await checkReleases({ url: `${site.url}/latest.json`, keys: KEYS, nudge: () => nudged++ }), null);
  assert.equal(hits.get("/real.json") ?? 0, 0, "never asked where it pointed");
  assert.equal(latestRelease(), null);
  // 404, and a body past the cap (said, or not said and streamed).
  assert.equal(await checkReleases({ url: `${site.url}/missing.json`, keys: KEYS }), null);
  serve("/said-long.json", "x".repeat(RELEASE_MAX_TEXT + 1));
  assert.equal(await checkReleases({ url: `${site.url}/said-long.json`, keys: KEYS }), null);
  answers.set("/streamed.json", { status: 200, headers: { "content-type": "application/json" }, chunks: 70 });
  assert.equal(await checkReleases({ url: `${site.url}/streamed.json`, keys: KEYS }), null);
  // Signed by a key it doesn't know: no release either, and nothing kept.
  serve("/unknown.json", signed(releaseOfV(V1), other.privateKey));
  assert.equal(await checkReleases({ url: `${site.url}/unknown.json`, keys: KEYS }), null);
  assert.equal(nudged, 0);
  assert.equal((await query("SELECT 1 FROM bops.runner_releases WHERE version LIKE '70.%'")).rowCount, 0);
});

test("a new version is kept and known, and every runner is told once; the same again, an older one or another build of it signed later tells nobody", async () => {
  let nudged = 0;
  const look = (path: string) => checkReleases({ url: `${site.url}${path}`, keys: KEYS, nudge: () => nudged++ });
  serve("/v1.json", signed(releaseOfV(V1)));
  const first = await look("/v1.json");
  assert.deepEqual(first, { version: V1, buildId: "BuildAbc_1", stateLevel: 4, releasedAt: Date.parse("2026-11-18T20:00:00.000Z") });
  assert.equal(nudged, 1);
  assert.deepEqual(latestRelease(), first);
  assert.deepEqual(releaseOf(V1), first);
  assert.equal(releaseOf(V2), null);
  const row = (await query<{ build_id: string; state_level: number; released_at: Date }>("SELECT build_id, state_level, released_at FROM bops.runner_releases WHERE version = $1", [V1])).rows[0];
  assert.deepEqual([row.build_id, row.state_level, row.released_at.toISOString()], ["BuildAbc_1", 4, "2026-11-18T20:00:00.000Z"]);
  // The same release again (every 10 minutes): nobody told again.
  await look("/v1.json");
  assert.equal(nudged, 1);
  // A newer one: told once.
  serve("/v2.json", signed(releaseOfV(V2, "BuildDef_2", { stateLevel: 5 })));
  await look("/v2.json");
  await look("/v2.json");
  assert.equal(nudged, 2);
  assert.equal(latestRelease()?.version, V2);
  assert.equal(releaseOf(V1)?.buildId, "BuildAbc_1", "an older one stays known");
  // latest.json back on the older one (a release taken back): known as it was, nobody told, the newest stays.
  await look("/v1.json");
  assert.equal(nudged, 2);
  assert.equal(latestRelease()?.version, V2);
  // Another build of a version it knows, signed again later: kept in its place, but it's no new version.
  const later = "2026-11-18T21:00:00.000Z";
  serve("/v2b.json", signed(releaseOfV(V2, "BuildGhi_3", { stateLevel: 5, released: later })));
  await look("/v2b.json");
  assert.equal(nudged, 2);
  assert.equal(releaseOf(V2)?.buildId, "BuildGhi_3");
  assert.equal(latestRelease()?.buildId, "BuildGhi_3");
  // Read back after a restart: the same releases, the same newest.
  forgetReleases();
  assert.equal(latestRelease(), null);
  await loadReleases();
  assert.equal(latestRelease()?.version, V2);
  assert.equal(releaseOf(V2)?.buildId, "BuildGhi_3");
  assert.equal(releaseOf(V1)?.buildId, "BuildAbc_1");
});

test("an older signing of a version known, served again (a stale cache, or a file someone kept), never takes the place of the one signed later: in memory, in the table, after a restart, or with nothing known yet", async () => {
  let nudged = 0;
  const look = (path: string) => checkReleases({ url: `${site.url}${path}`, keys: KEYS, nudge: () => nudged++ });
  const kept = async () => (await query<{ build_id: string; released_at: Date }>("SELECT build_id, released_at FROM bops.runner_releases WHERE version = $1", [V2])).rows[0];
  serve("/old.json", signed(releaseOfV(V2, "BuildDef_2")));
  serve("/new.json", signed(releaseOfV(V2, "BuildGhi_3", { released: "2026-11-18T21:00:00.000Z" })));
  serve("/tie.json", signed(releaseOfV(V2, "BuildJkl_4", { released: "2026-11-18T21:00:00.000Z" })));
  await look("/old.json");
  await look("/new.json");
  assert.equal(nudged, 1);
  const GHI = { version: V2, buildId: "BuildGhi_3", stateLevel: 4, releasedAt: Date.parse("2026-11-18T21:00:00.000Z") };
  assert.deepEqual(releaseOf(V2), GHI);
  // The older one served again, then another build signed at the same time: neither replaces it.
  assert.deepEqual(await look("/old.json"), GHI);
  assert.deepEqual(await look("/tie.json"), GHI);
  assert.deepEqual(releaseOf(V2), GHI);
  assert.deepEqual(latestRelease(), GHI);
  assert.deepEqual([(await kept()).build_id, (await kept()).released_at.toISOString()], ["BuildGhi_3", "2026-11-18T21:00:00.000Z"]);
  // After a restart, the same.
  forgetReleases();
  await loadReleases();
  assert.deepEqual(releaseOf(V2), GHI);
  // Nothing known here (another Bops Cloud kept it, or the read at start failed): the older one read now isn't written
  // over the table's, and the table's is known instead; the same release read again is known too.
  forgetReleases();
  assert.deepEqual(await look("/old.json"), GHI);
  assert.deepEqual(releaseOf(V2), GHI);
  assert.equal((await kept()).build_id, "BuildGhi_3");
  forgetReleases();
  assert.deepEqual(await look("/new.json"), GHI);
  assert.deepEqual(latestRelease(), GHI);
  // A row with no time it was signed (kept before that was known) is replaced by any signed one.
  await query("UPDATE bops.runner_releases SET released_at = NULL WHERE version = $1", [V2]);
  forgetReleases();
  await loadReleases();
  assert.equal(releaseOf(V2)?.releasedAt, null);
  assert.equal((await look("/old.json"))?.buildId, "BuildDef_2");
  assert.equal((await kept()).build_id, "BuildDef_2");
});
