import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where each Orgo user's things on this Mac go. Bops keeps the state itself in Bops Cloud
 * (persist-cloud.ts), but some things stay on the Mac: images attached in chat, pages bots made,
 * memory reviews, phone secrets and call logs (.data/users/<id>/), and each bot's Chrome profile and
 * the bots' workspace (~/.bops/users/<id>/, ~/.bops/chrome/<id>/). Each user's are their own, so
 * another account signed in on this Mac never sees them. Without a user (a self-hosted install
 * running on its own key) they're where they always were: .data/ and ~/.bops/.
 */

// The build's file tracer follows file paths it can't resolve (folder names only known at run time:
// users/<id>, legacy/<time>) to the whole project, and took .git, envs/ and docs/ into the app. So
// such calls carry /*turbopackIgnore: true*/, and the release refuses a build that ships anything
// but the server (scripts/release.sh).
const cwd = process.cwd.bind(process);
export const dataRoot = () => join(cwd(), ".data");
/** The one state file every build before this one kept, whoever was signed in. */
export const legacyStateFile = () => join(dataRoot(), "state.json");

/** A user id as a folder name. */
export const scopeOf = (userId: string) => userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";

export const userDataDir = (userId: string | null) => (userId ? join(dataRoot(), "users", scopeOf(userId)) : dataRoot());
export const bopsHome = () => join(homedir(), ".bops");
export const userBopsHome = (userId: string | null) => (userId ? join(bopsHome(), "users", scopeOf(userId)) : bopsHome());
/** Each bot's Chrome profiles (one per screen) live under here. */
export const chromeRoot = () => join(bopsHome(), "chrome");
export const userChromeDir = (userId: string | null) => (userId ? join(chromeRoot(), scopeOf(userId)) : chromeRoot());

/** What lived in .data beside state.json and was the same person's: it moves with the state. */
const BESIDE = ["uploads", "pages", "memory-reviews.json", "phone-secrets.json", "phone-calls.jsonl"];

/**
 * Whose a state file from before is, if that's sure: the one Orgo user it names anywhere (who was
 * signed in, whose cloud backup it was, whose account the bots' computers are in, who verified a
 * number or an address). None, or more than one (another account signed in on this Mac and its
 * work mixed in), is nobody's for sure.
 */
export function legacyOwner(raw: unknown): string | null {
  const s = (raw ?? {}) as {
    account?: { user?: { id?: unknown } };
    cloudUser?: unknown;
    computersOf?: unknown;
    ownerPhones?: { userId?: unknown }[];
    ownerEmails?: { userId?: unknown }[];
  };
  const ids = new Set<string>();
  const add = (v: unknown) => typeof v === "string" && v && ids.add(v);
  add(s.account?.user?.id);
  add(s.cloudUser);
  add(s.computersOf);
  for (const p of Array.isArray(s.ownerPhones) ? s.ownerPhones : []) add(p?.userId);
  for (const e of Array.isArray(s.ownerEmails) ? s.ownerEmails : []) add(e?.userId);
  return ids.size === 1 ? [...ids][0] : null;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Move the state file from before and what was beside it into `dir` (the file as `name`). The state
 * file goes last: if the app stops halfway, it's still there at the next start, which finishes the move.
 */
function moveBundle(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  for (const f of BESIDE) {
    const from = join(dataRoot(), f);
    const to = join(/*turbopackIgnore: true*/ dir, f);
    if (existsSync(/*turbopackIgnore: true*/ from) && !existsSync(/*turbopackIgnore: true*/ to)) renameSync(/*turbopackIgnore: true*/ from, to);
  }
  rmSync(`${legacyStateFile()}.tmp`, { force: true });
  renameSync(legacyStateFile(), join(dir, name));
}

/** The bots' Chrome profiles and workspace from before (~/.bops/chrome/<bot>-<port>, ~/.bops/workspace) go with their user's state. */
function moveHome(owner: string) {
  try {
    const chrome = userChromeDir(owner);
    for (const name of existsSync(chromeRoot()) ? readdirSync(chromeRoot()) : [])
      if (/^[A-Za-z0-9_]+-\d{4,5}$/.test(name) && !existsSync(join(chrome, name))) {
        mkdirSync(chrome, { recursive: true });
        renameSync(join(chromeRoot(), name), join(chrome, name));
      }
    const workspace = join(bopsHome(), "workspace");
    const theirs = join(userBopsHome(owner), "workspace");
    if (existsSync(workspace) && !existsSync(theirs)) {
      mkdirSync(userBopsHome(owner), { recursive: true });
      renameSync(workspace, theirs);
    }
  } catch (e) {
    console.warn(`[store] moving the bots' Chrome profiles and workspace from before: ${(e as Error).message}`);
  }
}

export type LegacyMove = { owner: string | null; to: string };

/**
 * The first start of a build that keeps each user's state apart: the one state file from before goes
 * to the user it's surely the user of, with what was beside it, and is gone from where every account
 * on this Mac read it. `name` is what it's called there: "legacy-state.json", to be uploaded to the
 * cloud at their next sign-in (persist-cloud.ts), or "state.json", their file on a self-hosted
 * install. A file that's nobody's for sure is kept aside in .data/legacy/<time>/ when `asideUnknown`
 * (it's never uploaded for whoever signs in), else left where it is. Null when there's nothing to move.
 */
export function moveLegacyState(name: string, asideUnknown: boolean): LegacyMove | null {
  // `next build` imports the server to collect each route's data, in several workers at once: moving
  // the file then would race (and move the build machine's own state). It happens at the app's start.
  if (process.env.NEXT_PHASE === "phase-production-build") return null;
  const file = legacyStateFile();
  if (!existsSync(file)) return null;
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Unreadable: nobody's for sure.
  }
  const owner = legacyOwner(raw);
  if (owner) {
    const dir = userDataDir(owner);
    // Already one waiting there (it can't really happen): this one is kept aside instead, not over it.
    if (!existsSync(join(dir, name))) {
      moveHome(owner);
      moveBundle(dir, name);
      return { owner, to: join(dir, name) };
    }
  } else if (!asideUnknown) return null;
  const aside = join(dataRoot(), "legacy", stamp());
  moveBundle(aside, "state.json");
  return { owner: null, to: join(aside, "state.json") };
}
