import "server-only";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KEEPER_CONF, KEEPER_CONF_FILE, KEEPER_DIR, KEEPER_HOLD } from "@/vm/runner-steps.mjs";
import { cloudUrl } from "./cloud-url";
import { orgoOrigin } from "./orgo-auth";

/**
 * The computer's keeper (vm/bin/bops-runner-keeper.mjs), put in place by its runner: a runner from CLOUD_SELF_MIN_VERSION
 * on writes its own bundle's copy of the keeper and its steps (vm/, traced into the bundle: next.config.ts), keeper.json
 * (where Orgo and Bops Cloud are, as this runner has them, and where releases are) and the keeper's supervisord program
 * whenever what's there differs, then has supervisord read it again and restarts the keeper when it ran. So every
 * computer the owner's Mac sets a runner up on gets a keeper with no step of its own, a keeper that's gone or broken
 * comes back with the next runner, and a runner the keeper updated brings the keeper its own new version.
 *
 * Never while the keeper is judging the build it just put in place (KEEPER_DIR/judging under 10 minutes old) or works
 * on the runner (KEEPER_HOLD under 5 minutes old), nor on a computer pinned to the owner's own build (KEEPER_DIR/pin: a
 * dev Mac's runner, which the keeper leaves alone).
 */

/** Where releases are, when keeper.json doesn't say already (the template's, or orgo-web's for a computer it set up). */
export const KEEPER_RELEASES = "https://bops.bot/download/runner/";
/** It looks a minute after the runner starts, then every 10 minutes until the keeper is as this runner's. */
export const KEEPER_FIRST_MS = 60_000;
export const KEEPER_EVERY_MS = 10 * 60_000;
const JUDGING_MS = 10 * 60_000;
const HOLD_MS = 5 * 60_000;
/** As the keeper reads keeper.json (vm/bin/bops-runner-keeper.mjs readConfig). */
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/;
const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i;

type Sh = (script: string) => Promise<string>;
/** Tests: where the computer's files are (a folder standing in for its root), its commands, the clock, this build's vm/. */
export type KeeperFilesOptions = { at?: (p: string) => string; sh?: Sh; now?: () => number; vm?: string };

const run: Sh = (script) => new Promise((ok) => execFile("sh", ["-c", script], { timeout: 60_000 }, (_e, out) => ok(String(out ?? ""))));
const ageOf = (p: string, now: number) => {
  try {
    return now - statSync(p).mtimeMs;
  } catch {
    return Infinity;
  }
};

/**
 * Put the keeper in place when it differs from this runner's own: "written" (and supervisord told), "same", or why not
 * now ("pinned", "judging", "busy", "missing": this build has no keeper of its own). Never throws for a file it couldn't
 * read; a write that fails throws (looked at again in 10 minutes).
 */
export async function ensureKeeper(o: KeeperFilesOptions = {}): Promise<"written" | "same" | "pinned" | "judging" | "busy" | "missing"> {
  const at = o.at ?? ((p: string) => p);
  const sh = o.sh ?? run;
  const now = (o.now ?? Date.now)();
  const vm = o.vm ?? join(process.cwd(), "vm");
  const dir = at(KEEPER_DIR);
  if (existsSync(`${dir}/pin`)) return "pinned";
  if (ageOf(`${dir}/judging`, now) < JUDGING_MS) return "judging";
  if (ageOf(at(KEEPER_HOLD), now) < HOLD_MS) return "busy";
  let keeper: Buffer, steps: Buffer;
  try {
    keeper = readFileSync(join(vm, "bin/bops-runner-keeper.mjs"));
    steps = readFileSync(join(vm, "runner-steps.mjs"));
  } catch {
    return "missing";
  }
  // Where releases are: as keeper.json says already (a staging template's own, say), else Orgo's.
  let releases = KEEPER_RELEASES;
  try {
    const r = (JSON.parse(await readFile(`${dir}/keeper.json`, "utf8")) as { releases?: unknown }).releases;
    if (typeof r === "string" && r.length <= 200 && ORIGIN.test(r) && !LOOPBACK_URL.test(r)) releases = r;
  } catch {}
  const json = `${JSON.stringify({ orgo: orgoOrigin(), cloud: cloudUrl(), releases }, null, 2)}\n`;
  const want: [string, Buffer | string, number][] = [
    [`${dir}/keeper.mjs`, keeper, 0o755],
    [`${dir}/runner-steps.mjs`, steps, 0o644],
    [`${dir}/keeper.json`, json, 0o644],
    [at(KEEPER_CONF_FILE), KEEPER_CONF, 0o644],
  ];
  const same = async (p: string, body: Buffer | string) => {
    const had = await readFile(p).catch(() => null);
    return !!had && had.equals(Buffer.isBuffer(body) ? body : Buffer.from(body));
  };
  const differ: typeof want = [];
  for (const w of want) if (!(await same(w[0], w[1]))) differ.push(w);
  if (!differ.length) return "same";
  const ran = /RUNNING|STARTING/.test(await sh("supervisorctl status bops-keeper 2>/dev/null; true"));
  for (const [p, body, mode] of differ) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(`${p}.next`, body, { mode });
    await chmod(`${p}.next`, mode);
    await rename(`${p}.next`, p);
  }
  await sh("supervisorctl reread >/dev/null 2>&1; supervisorctl update >/dev/null 2>&1; true");
  if (ran) await sh("supervisorctl restart bops-keeper >/dev/null 2>&1; true");
  console.info("[runner] its computer's keeper is put in place from this build");
  return "written";
}

const g = globalThis as unknown as { __bopsKeeperCheck?: ReturnType<typeof setTimeout> };

/** A minute after the runner starts, then every 10 minutes until the keeper there is this runner's (ensureKeeper). */
export function startKeeperCheck(o: KeeperFilesOptions = {}) {
  if (g.__bopsKeeperCheck) return;
  const look = async () => {
    const done = await ensureKeeper(o).then(
      (r) => r === "written" || r === "same" || r === "missing",
      (e: Error) => (console.warn(`[runner] putting its computer's keeper in place: ${e.message}`), false),
    );
    g.__bopsKeeperCheck = done ? undefined : setTimeout(() => void look(), KEEPER_EVERY_MS);
    g.__bopsKeeperCheck?.unref?.();
  };
  g.__bopsKeeperCheck = setTimeout(() => void look(), KEEPER_FIRST_MS);
  g.__bopsKeeperCheck.unref?.();
}
