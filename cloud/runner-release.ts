import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { olderThan } from "./app-version.ts";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { RELEASE_MAX_BYTES, type RunnerRelease } from "./protocol.ts";

/**
 * Signed runner releases (protocol.ts RunnerRelease, CLOUD_SELF_MIN_VERSION). Orgo's release signs each runner bundle it
 * ships with a release key and publishes `{payload, sig, keyId}` at bops.bot/download/runner/latest.json. Bops Cloud reads
 * it every 10 minutes (startReleases), keeps each release it can verify (bops.runner_releases), and knows them by version
 * (latestRelease, releaseOf):
 *
 * - a runner that says it runs a version newer than the newest known has nothing new kept of it (cloud/turns.ts runnerLive);
 * - the owner's record of a runner is written only for a version and build that match a signed release (turns.ts recordRunner);
 * - a release it hadn't seen tells every runner that listens to look for an update now (`update`: turns.ts nudgeUpdates).
 *
 * Bops Cloud never hands out a release, a place to fetch one or a key: each computer's keeper reads and checks
 * latest.json itself, against the same keys built into it (vm/runner-steps.mjs), and Bops Cloud only says whether it may.
 * Its keys come from this file alone, never from the environment.
 */

/**
 * The public keys releases are signed with, by keyId (ed25519, SPKI PEM). Only these: a release under any other keyId is
 * no release. To rotate, ship the next key here (and in the keeper's copy) a release before signing with it.
 */
export const RELEASE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  r1: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAOnXNLbg1J+CrDAspBAmssN/uaC+mJDB3RvCQM8qrMH0=\n-----END PUBLIC KEY-----\n",
});

/** The most of latest.json Bops Cloud reads. */
export const RELEASE_MAX_TEXT = 64 * 1024;
/** How often it's read again, and how long a read may take. */
export const RELEASE_POLL_MS = 10 * 60_000;
const READ_MS = 10_000;

/** bops-server-<version>-<BUILD_ID>.tgz, as lib/server/runner-install.ts names a bundle. */
const BUNDLE_NAME = /^bops-server-(\d+\.\d+\.\d+)-([A-Za-z0-9_-]{1,64})\.tgz$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const BUILD = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** An ed25519 signature (64 bytes), base64. */
const SIG = /^[A-Za-z0-9+/]{86}==$/;
/** When it was signed: ISO 8601, UTC. */
const RELEASED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keyObjects = new Map<string, KeyObject | null>();
/** A key as Node reads it: an ed25519 public key, or null for anything else. */
function keyOf(pem: string): KeyObject | null {
  if (!keyObjects.has(pem)) {
    let k: KeyObject | null = null;
    try {
      const made = createPublicKey(pem);
      k = made.asymmetricKeyType === "ed25519" ? made : null;
    } catch {}
    keyObjects.set(pem, k);
  }
  return keyObjects.get(pem) ?? null;
}

/**
 * The release latest.json's text says, or null when it isn't one: `{payload, sig, keyId}` with `keyId` one of `keys`
 * (RELEASE_KEYS; another set only in tests), `sig` that key's ed25519 signature over `payload`'s bytes, and `payload` a
 * RunnerRelease: kind "bops-runner", version x.y.z, its bundle's name agreeing with its version and build, a sha256, a
 * size of at most RELEASE_MAX_BYTES, when it was signed, and a state level from 1 to 9999.
 */
export function verifyRelease(text: string, keys: Readonly<Record<string, string>> = RELEASE_KEYS): RunnerRelease | null {
  if (typeof text !== "string" || text.length > RELEASE_MAX_TEXT) return null;
  let outer: unknown;
  try {
    outer = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(outer)) return null;
  const { payload, sig, keyId } = outer;
  if (typeof payload !== "string" || typeof sig !== "string" || typeof keyId !== "string" || !SIG.test(sig)) return null;
  const key = Object.hasOwn(keys, keyId) ? keyOf(keys[keyId]) : null;
  if (!key) return null;
  let signed = false;
  try {
    signed = verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sig, "base64"));
  } catch {
    return null;
  }
  if (!signed) return null;
  let p: unknown;
  try {
    p = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(p)) return null;
  const { kind, version, buildId, name, sha256, size, released, stateLevel } = p;
  if (kind !== "bops-runner") return null;
  if (typeof version !== "string" || !VERSION.test(version) || typeof buildId !== "string" || !BUILD.test(buildId)) return null;
  const m = typeof name === "string" ? BUNDLE_NAME.exec(name) : null;
  if (!m || m[1] !== version || m[2] !== buildId) return null;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > RELEASE_MAX_BYTES) return null;
  if (typeof released !== "string" || !RELEASED.test(released) || !Number.isFinite(Date.parse(released))) return null;
  if (typeof stateLevel !== "number" || !Number.isInteger(stateLevel) || stateLevel < 1 || stateLevel > 9999) return null;
  return { kind, version, buildId, name: name as string, sha256, size, released, stateLevel };
}

/** A signed release as Bops Cloud knows it (bops.runner_releases). `releasedAt`: when it was signed (ms), if known. */
export type KnownRelease = { version: string; buildId: string; stateLevel: number; releasedAt: number | null };

/** Every release read, by version, and the newest of them. */
const known = new Map<string, KnownRelease>();
let newest: KnownRelease | null = null;

/** The newest signed release Bops Cloud knows (by version), or null: none read yet. */
export const latestRelease = (): KnownRelease | null => newest;
/** The signed release of `version`, or null: none Bops Cloud knows. */
export const releaseOf = (version: string): KnownRelease | null => known.get(version) ?? null;

/** Keep a release known (read from latest.json or the table); the newest moves only up. */
export function rememberRelease(r: KnownRelease): void {
  known.set(r.version, r);
  if (!newest || !olderThan(r.version, newest.version)) newest = r;
}

/** For tests: no release known, as before any was read. */
export function forgetReleases(): void {
  known.clear();
  newest = null;
}

type ReleaseRow = { version: string; build_id: string; state_level: number; released_at: Date | null };
/** The releases kept (bops.runner_releases), all or that of `version`, as Bops Cloud knows them; never one that isn't well formed. */
async function keptReleases(version?: string): Promise<KnownRelease[]> {
  const sql = "SELECT version, build_id, state_level, released_at FROM bops.runner_releases";
  const r = version === undefined ? await query<ReleaseRow>(sql) : await query<ReleaseRow>(`${sql} WHERE version = $1`, [version]);
  return r.rows.filter((x) => VERSION.test(x.version) && BUILD.test(x.build_id)).map((x) => ({ version: x.version, buildId: x.build_id, stateLevel: x.state_level, releasedAt: x.released_at?.getTime() ?? null }));
}

/** Every release kept, known again (at start: one read before a restart still counts). */
export async function loadReleases(): Promise<void> {
  for (const r of await keptReleases()) rememberRelease(r);
}

/** The text at `url`, or why not: 200 only (a redirect is never followed), at most RELEASE_MAX_TEXT, within READ_MS. */
async function readText(url: string): Promise<{ text: string } | { why: string }> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(READ_MS), headers: { accept: "application/json" } });
  } catch (e) {
    return { why: `not read (${(e as Error).name})` };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { why: `answered ${res.status}` };
  }
  const said = Number(res.headers.get("content-length"));
  if (Number.isFinite(said) && said > RELEASE_MAX_TEXT) {
    await res.body?.cancel().catch(() => {});
    return { why: "too long" };
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > RELEASE_MAX_TEXT) {
        await reader.cancel().catch(() => {});
        return { why: "too long" };
      }
      chunks.push(value);
    }
  } catch (e) {
    return { why: `not read (${(e as Error).name})` };
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/** Why the last read didn't give a release, so it's said once, not every 10 minutes. */
let lastWhy = "";
const say = (why: string) => {
  if (why && why !== lastWhy) console.warn(`[releases] latest.json ${why}`);
  lastWhy = why;
};

/**
 * Read latest.json once (`url`: BOPS_RUNNER_RELEASES), and keep the release it says when it's signed (verifyRelease,
 * with `keys`: RELEASE_KEYS but in tests): written to bops.runner_releases, and known at once. A version signed again
 * replaces the one kept only when it was signed later (`released`): an older signing of it served again (a stale cache,
 * or someone replaying a file they kept, whose signature never expires) changes nothing, here or in the table, and the
 * one kept is known instead. One whose version Bops Cloud hadn't seen and that is the newest now calls `nudge` once
 * (turns.ts nudgeUpdates). The release now known for the version read (null: none, or not signed). Never throws.
 */
export async function checkReleases(o: { url?: string; keys?: Readonly<Record<string, string>>; nudge?: () => void } = {}): Promise<KnownRelease | null> {
  const url = o.url ?? config.runnerReleases();
  const got = await readText(url);
  if ("why" in got) {
    say(got.why);
    return null;
  }
  const r = verifyRelease(got.text, o.keys);
  if (!r) {
    say("isn't a signed release");
    return null;
  }
  const was = known.get(r.version);
  const release: KnownRelease = { version: r.version, buildId: r.buildId, stateLevel: r.stateLevel, releasedAt: Date.parse(r.released) };
  const older = !!was && was.releasedAt !== null && release.releasedAt! <= was.releasedAt;
  const same = !!was && was.buildId === release.buildId && was.stateLevel === release.stateLevel && was.releasedAt === release.releasedAt;
  say(older && !same ? `is ${r.version} (${r.buildId}) signed ${r.released}, no later than the one kept (${was!.buildId})` : "");
  if (was && (same || older)) return was;
  let kept: KnownRelease | undefined;
  try {
    const wrote = await query(
      `INSERT INTO bops.runner_releases AS k (version, build_id, state_level, released_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO UPDATE SET build_id = EXCLUDED.build_id, state_level = EXCLUDED.state_level, released_at = EXCLUDED.released_at
       WHERE k.released_at IS NULL OR k.released_at < EXCLUDED.released_at`,
      [release.version, release.buildId, release.stateLevel, new Date(release.releasedAt!)],
    );
    // Not written: the table has a signing of it as late or later (kept by another Bops Cloud, or before a restart whose read failed).
    kept = wrote.rowCount ? release : (await keptReleases(release.version))[0];
  } catch (e) {
    console.warn(`[releases] keeping ${release.version}: ${(e as Error).message}`);
    return null;
  }
  if (!kept) return null;
  rememberRelease(kept);
  if (!was && newest === kept) {
    console.info(`[releases] ${kept.version} (${kept.buildId}) is out`);
    o.nudge?.();
  }
  return kept;
}

/**
 * Read the releases kept, then latest.json now and every RELEASE_POLL_MS (BOPS_RUNNER_RELEASES "off": never), telling
 * every runner that listens of a new one (`nudge`). Returns the stop.
 */
export function startReleases(nudge: () => void): () => void {
  let running = false;
  const look = async () => {
    if (running || config.runnerReleases() === "off") return;
    running = true;
    try {
      await checkReleases({ nudge });
    } finally {
      running = false;
    }
  };
  void loadReleases()
    .catch((e: Error) => console.warn(`[releases] reading those kept: ${e.message}`))
    .finally(() => void look());
  const t = setInterval(() => void look(), RELEASE_POLL_MS);
  t.unref?.();
  return () => clearInterval(t);
}
