import "server-only";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GithubMirror } from "@/lib/hosted-apps";
import { ingot, type IngotChange, type IngotFile } from "./ingot";
import { callKey, KeysError, keyProjectFor, listKeys, type KeyAnswer, type KeyMethod, type VaultKey } from "./keys";
import { onRunner } from "./persist";
import { userDir } from "./store";

/**
 * An app whose production is on GitHub (AppHosting.github): Ingot is where it's worked on and previewed, and Publish
 * carries it to a folder of a GitHub repo, where that repo's own workflow deploys it.
 *
 * One point says where the two were last the same: `last.sha`, the GitHub commit Publish last pushed or brought in
 * (and `last.ingot`, the Ingot changeset that matches it). Everything is compared by what's in the files, against
 * GitHub's folder at that commit (the base):
 * - Ingot's changes: the files of the changeset the Preview serves that differ from the base (a file brought in from
 *   GitHub never counts: it's the same as GitHub's). A preview older than `last.ingot` is refused (PREVIEW_BEHIND),
 *   so what came from GitHub is never pushed back undone.
 * - GitHub's changes: its folder now against the base. They come into Ingot first, so Ingot stays the source and
 *   nothing done on GitHub is lost.
 * - A file both changed, to anything but the same bytes and mode, stops it (BOTH_CHANGED) before anything is written;
 *   so does newer work in Ingot (main past the preview) on a file GitHub changed. Bring in GitHub's changes
 *   (mirrorPull) takes GitHub's version of those, on the owner's word.
 * Never touched: anything outside the folder (a repo's secrets and workflows), the app's `keep` paths (either way),
 * GitHub's symbolic links and submodules (Ingot has none), .ingotignore. The push is one commit on top of the branch,
 * never forced. A folder gone from GitHub (FOLDER_GONE), or most of it deleted on either side (MASS_DELETE), stops it.
 * Link (linkMirror) sets the point, only when GitHub has no file Ingot lacks or has otherwise: files only Ingot has
 * (a new client's own folder in a shared repo) are Ingot's changes, and go up with the first Publish.
 *
 * Every GitHub call goes through Orgo's broker with the owner's GITHUB_TOKEN (keys.ts callKey): the token is in no
 * command, file, log or message. The broker takes 1 MB a request (a file up to BLOB_MAX goes up), answers 512 KB (a
 * bigger file comes down by GitHub's own short-lived link), and 120 calls a minute (paced below). Ingot names files
 * by sha256 and GitHub by its git blob id: a table of the two (gitIds) means each Ingot file is read once to learn it.
 */

const KEY = "GITHUB_TOKEN";
/** The key a bot needs, given by the owner in Keys, to publish an app to GitHub (Orgo's broker calls GitHub with it). */
export const GITHUB_KEY = KEY;
/** Orgo refusing a computer's own sign in a key its bot wasn't given (403): said as that, in plain words. */
const NO_KEY_HERE = "The bot publishing it has no GitHub key for this app, so nothing went to GitHub. Give it the GitHub key in Keys, then publish again.";
/** The most bytes of one file sent up (base64 in a broker request of at most 1 MB). */
export const BLOB_MAX = 700_000;
/** A file up to this many bytes comes down in the broker's answer (base64 in at most 512 KB); bigger, by GitHub's link. */
const INLINE_DOWN = 350_000;
/** Ingot gets what came from GitHub in commits of about this many bytes. */
const IMPORT_BATCH = 8 * 1024 * 1024;
/** Calls a minute to GitHub through the broker, under its 120. */
const PACE = 100;
/** Always Ingot's alone: what it leaves out of a repo. */
const ALWAYS_KEPT = [".ingotignore"];
/** A side deleting at least this share of the folder's files (and MASS_MIN of them) stops it. */
const MASS_SHARE = 0.5;
const MASS_MIN = 20;

export class MirrorError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(message: string, status = 502, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** A file as git names it: its blob id, mode (100644, 100755) and size. */
type GitFile = { sha: string; mode: string; size: number };
type Files = Map<string, GitFile>;
type GhSide = { root: string; files: Files; links: Set<string>; present: boolean };

/** A file's git blob id (what GitHub names it by). */
export const gitSha = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (id: string) => id.slice(0, 7);
const list = (paths: string[], n = 5) => paths.slice(0, n).join(", ") + (paths.length > n ? ` and ${paths.length - n} more` : "");
const modeOf = (executable: boolean) => (executable ? "100755" : "100644");
/** The same file (bytes and mode), or both missing. */
const same = (a: GitFile | undefined, b: GitFile | undefined) => (!a && !b) || (!!a && !!b && a.sha === b.sha && a.mode === b.mode);

/** Whether `path` (in the app's folder) is left alone either way: one of `keep`, in a kept folder (ending in /), or always kept. */
export function keptPath(path: string, keep: readonly string[] = []): boolean {
  return [...ALWAYS_KEPT, ...keep].some((k) => (k.endsWith("/") ? path.startsWith(k) : path === k));
}

/* ---------------- Ingot's files as git names them ---------------- */

const g = globalThis as { __bopsGitIds?: { file: string | null; map: Map<string, string> } };

/** sha256 to git blob id, of every Ingot file this Mac has read (kept in the user's folder: content never changes). */
function gitIds() {
  const file = (() => {
    const d = userDir();
    return d ? join(/*turbopackIgnore: true*/ d, "github-mirror-ids.json") : null;
  })();
  if (!g.__bopsGitIds || g.__bopsGitIds.file !== file) {
    let map = new Map<string, string>();
    try {
      if (file) map = new Map(Object.entries(JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Record<string, string>));
    } catch {
      /* none yet */
    }
    g.__bopsGitIds = { file, map };
  }
  return g.__bopsGitIds;
}

function saveIds() {
  const ids = gitIds();
  if (!ids.file) return;
  try {
    mkdirSync(join(/*turbopackIgnore: true*/ ids.file, ".."), { recursive: true });
    const tmp = `${ids.file}.tmp`;
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(Object.fromEntries(ids.map)));
    renameSync(/*turbopackIgnore: true*/ tmp, ids.file);
  } catch {
    /* only a cache */
  }
}

/** The bytes of files of Ingot changeset `at` (its presigned links), each checked against its blob. */
async function ingotBytes(wsId: string, name: string, at: string, paths: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!paths.length) return out;
  const m = await ingot.manifest(wsId, name, at);
  if (!m) throw new MirrorError(`Ingot has no changeset ${short(at)} of ${name}.`, 409);
  const byPath = new Map(m.map((f) => [f.path, f] as const));
  const want = [...paths];
  const one = async () => {
    for (let p = want.shift(); p !== undefined; p = want.shift()) {
      const f = byPath.get(p);
      if (!f) throw new MirrorError(`Ingot lists no ${p} at ${short(at)}.`, 502);
      const r = await fetch(f.url, { cache: "no-store", signal: AbortSignal.timeout(5 * 60_000) }).catch(() => null);
      if (!r?.ok) throw new MirrorError(`Ingot didn't send ${p}.`, 502);
      const b = Buffer.from(await r.arrayBuffer());
      if (sha256(b) !== f.blob) throw new MirrorError(`Ingot sent ${p} with other bytes than it listed.`, 502);
      out.set(p, b);
    }
  };
  await Promise.all([one(), one(), one(), one()]);
  return out;
}

/** Ingot changeset `at`'s files that `skip` leaves in, as git names them (each file not seen before read once), and its tree. */
async function ingotSide(wsId: string, name: string, at: string, skip: (p: string) => boolean): Promise<{ files: Files; tree: Map<string, IngotFile> }> {
  const t = await ingot.tree(wsId, name, at);
  if (!t) throw new MirrorError(`Ingot has no changeset ${short(at)} of ${name}.`, 409);
  const tree = new Map(t.filter((f) => !skip(f.path)).map((f) => [f.path, f] as const));
  const ids = gitIds();
  const unknown = [...tree.values()].filter((f) => !ids.map.has(f.blob)).map((f) => f.path);
  if (unknown.length) {
    const got = await ingotBytes(wsId, name, at, unknown);
    for (const [p, b] of got) ids.map.set(tree.get(p)!.blob, gitSha(b));
    saveIds();
  }
  const files: Files = new Map([...tree].map(([p, f]) => [p, { sha: ids.map.get(f.blob)!, mode: modeOf(f.executable), size: f.size }] as const));
  return { files, tree };
}

/* ---------------- GitHub ---------------- */

function jsonOf(a: KeyAnswer): unknown {
  return typeof a.body === "string" ? (() => { try { return JSON.parse(a.body as string) as unknown; } catch { return null; } })() : a.body;
}
const objOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** GitHub's API with the owner's key, through Orgo's broker, paced. */
function github(wsId: string) {
  let project: string | undefined | null = null;
  const sent: number[] = [];
  const call = async (method: KeyMethod, path: string, body?: unknown, query?: Record<string, unknown>) => {
    if (project === null) project = keyProjectFor(await listKeys().catch(() => [] as VaultKey[]), wsId, KEY);
    const now = Date.now();
    while (sent.length && now - sent[0] > 60_000) sent.shift();
    if (sent.length >= PACE) await sleep(60_000 - (now - sent[0]) + 50);
    sent.push(Date.now());
    try {
      return await callKey({ name: KEY, method, path, body: body ?? null, query: query ?? null, workspaceId: project });
    } catch (e) {
      // (On a bot's computer, Orgo calls only the keys its bots were given: one it wasn't is a 403.)
      if (onRunner() && e instanceof KeysError && e.status === 403) throw new MirrorError(NO_KEY_HERE, 409, { code: "NO_GITHUB_KEY" });
      throw new MirrorError(e instanceof KeysError ? `GitHub: ${e.message}` : "Orgo didn't reach GitHub. Try again.", e instanceof KeysError && e.status === 404 ? 409 : 502);
    }
  };
  /** A 2xx answer's JSON, whole (an object, or an array with `array`); else what GitHub said, for `step`. */
  const need = async (step: string, method: KeyMethod, path: string, body?: unknown, query?: Record<string, unknown>, array = false) => {
    const r = await call(method, path, body, query);
    const j = jsonOf(r);
    const said = typeof objOf(j)?.message === "string" ? `: ${String(objOf(j)!.message).slice(0, 200)}` : "";
    if (r.status === 401 || r.status === 403) throw new MirrorError(`GitHub turned the key down while Bops tried to ${step} (${r.status}${said}). Check the GitHub key in Keys can write to the repo.`, 409);
    if (r.status >= 400 || !(array ? Array.isArray(j) : objOf(j))) throw new MirrorError(`GitHub didn't let Bops ${step} (${r.status}${said}).`, 502);
    if (r.truncated) throw new MirrorError(`GitHub's answer was too big for Bops to read while it tried to ${step}.`, 502);
    return j as Record<string, unknown>;
  };
  return { call, need };
}
type GitHub = ReturnType<typeof github>;
const segs = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** The newest commit of `branch` on GitHub. */
async function ghHead(gh: GitHub, repo: string, branch: string): Promise<string> {
  const r = await gh.call("GET", `/repos/${repo}/git/ref/heads/${segs(branch)}`);
  if (r.status === 404) throw new MirrorError(`GitHub has no branch ${branch} in ${repo} (or the GitHub key can't see the repo).`, 409);
  const sha = (objOf(objOf(jsonOf(r))?.object) ?? {}).sha;
  if (r.status !== 200 || typeof sha !== "string") throw new MirrorError(`GitHub didn't say where ${branch} is (${r.status}).`, 502);
  return sha;
}

/** The files of `folder` of `repo` at `commit` (blob id, mode, size), its symbolic links and submodules (never touched), and whether the folder is there. */
async function ghSide(gh: GitHub, repo: string, commit: string, folder: string): Promise<GhSide> {
  const c = await gh.need("read a commit", "GET", `/repos/${repo}/git/commits/${commit}`);
  const root = String(objOf(c.tree)?.sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(root)) throw new MirrorError("GitHub sent a commit Bops couldn't read.", 502);
  let at = root;
  for (const seg of folder ? folder.split("/") : []) {
    const t = await gh.need("read its folders", "GET", `/repos/${repo}/git/trees/${at}`);
    const e = (t.tree as { path?: unknown; type?: unknown; sha?: unknown }[] | undefined)?.find((x) => x.path === seg);
    if (!e || e.type !== "tree" || typeof e.sha !== "string") return { root, files: new Map(), links: new Set(), present: false };
    at = e.sha;
  }
  const t = await gh.need("read its files", "GET", `/repos/${repo}/git/trees/${at}`, undefined, { recursive: "1" });
  if (t.truncated === true) throw new MirrorError("That folder has more files than GitHub lists at once.", 502);
  const files: Files = new Map();
  const links = new Set<string>();
  for (const e of (t.tree as { path?: unknown; type?: unknown; sha?: unknown; mode?: unknown; size?: unknown }[]) ?? []) {
    if (typeof e.path !== "string" || typeof e.sha !== "string") continue;
    if (e.type === "commit" || e.mode === "120000") links.add(e.path);
    else if (e.type === "blob") files.set(e.path, { sha: e.sha, mode: e.mode === "100755" ? "100755" : "100644", size: typeof e.size === "number" ? e.size : 0 });
  }
  return { root, files, links, present: true };
}

/**
 * The bytes of a file of GitHub at `commit`, checked against its blob id: a small one inline; a bigger one by its own
 * entry (over 1 MB GitHub sends its download link alone, small whatever the folder), else by its folder's listing
 * (up to 1 MB its own entry carries the bytes, too big for the broker's answer).
 */
async function ghBytes(gh: GitHub, repo: string, folder: string, path: string, f: GitFile, commit: string): Promise<Buffer> {
  const check = (b: Buffer) => {
    if (gitSha(b) !== f.sha) throw new MirrorError(`GitHub sent ${path} with other bytes than it listed.`, 502);
    return b;
  };
  if (f.size <= INLINE_DOWN) {
    const j = await gh.need(`read ${path}`, "GET", `/repos/${repo}/git/blobs/${f.sha}`);
    return check(Buffer.from(String(j.content ?? ""), "base64"));
  }
  const full = (folder ? `${folder}/` : "") + path;
  let url = "";
  const own = await gh.call("GET", `/repos/${repo}/contents/${segs(full)}`, undefined, { ref: commit });
  const o = own.status === 200 && !own.truncated ? objOf(jsonOf(own)) : null;
  if (o && o.sha === f.sha && o.encoding === "base64" && typeof o.content === "string" && o.content) return check(Buffer.from(o.content, "base64"));
  if (o && o.sha === f.sha && typeof o.download_url === "string") url = o.download_url;
  else {
    const dir = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
    const base = full.slice(full.lastIndexOf("/") + 1);
    const j = (await gh.need(`find ${path}`, "GET", `/repos/${repo}/contents/${segs(dir)}`, undefined, { ref: commit }, true)) as unknown as { name?: unknown; sha?: unknown; download_url?: unknown }[];
    const e = j.find((x) => x.name === base && x.sha === f.sha);
    url = typeof e?.download_url === "string" ? e.download_url : "";
  }
  if (!url.startsWith("https://")) throw new MirrorError(`GitHub gave no way to download ${path}.`, 502);
  // GitHub's own short-lived link (it carries its own access): fetched here, never kept or shown.
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5 * 60_000) }).catch(() => null);
  if (!r?.ok) throw new MirrorError(`GitHub didn't send ${path}.`, 502);
  return check(Buffer.from(await r.arrayBuffer()));
}

/** Each path whose file differs from `base` to `now` (added, changed, mode, or deleted), with what it is now (undefined: deleted). */
function changes(base: Files, now: Files): Map<string, GitFile | undefined> {
  const d = new Map<string, GitFile | undefined>();
  for (const [p, f] of now) if (!same(base.get(p), f)) d.set(p, f);
  for (const p of base.keys()) if (!now.has(p)) d.set(p, undefined);
  return d;
}

/** Most of a folder's files deleted by one side: stop, it's more likely a mistake than a change. */
function massDelete(base: Files, d: Map<string, GitFile | undefined>, side: string) {
  const gone = [...d.values()].filter((f) => !f).length;
  if (gone >= MASS_MIN && gone >= base.size * MASS_SHARE)
    throw new MirrorError(`${side} deleted ${gone} of the folder's ${base.size} files since they were last the same. That looks like a mistake, so nothing was published.`, 409, { code: "MASS_DELETE" });
}

/** Whether Ingot changeset `mark` is `at` or one of its ancestors (`at`'s own history, a page at a time; merges included). */
async function atOrAfter(wsId: string, name: string, at: string, mark: string): Promise<boolean> {
  if (at === mark) return true;
  let before: string | undefined;
  for (let page = 0; page < 10; page++) {
    const log = await ingot.log(wsId, name, { at, limit: 200, ...(before ? { before } : {}) });
    if (!log) return false;
    if (log.changesets.some((c) => c.id === mark)) return true;
    if (!log.next) return false;
    before = log.next;
  }
  return false;
}

/* ---------------- Link, Publish, Bring in ---------------- */

/**
 * Link an app to its GitHub folder: Ingot's newest changeset and the branch's newest commit, when GitHub has no file
 * (but `keep` paths and GitHub's links) that Ingot lacks or has otherwise. Else LINK_DIFFERS, with those paths: make them
 * the same (or keep them), then link. Files only Ingot has are Ingot's changes from the point on: the first Publish puts
 * them there (`ingotOnly`), as it puts all of a folder not on GitHub yet, which links to an empty one.
 */
export async function linkMirror(wsId: string, name: string, cfg: GithubMirror): Promise<NonNullable<GithubMirror["last"]>> {
  return (await linkAndSay(wsId, name, cfg)).last;
}

/** Link (linkMirror), and what it found in words: where, and the files only Ingot has, which go up with the next Publish. */
export async function linkAndSay(wsId: string, name: string, cfg: GithubMirror): Promise<{ last: NonNullable<GithubMirror["last"]>; ingotOnly: string[]; said: string }> {
  const head = await ingot.head(wsId, name);
  if (!head) throw new MirrorError(head === undefined ? `Ingot has no repo ${name}.` : `${name} has nothing committed yet.`, 409);
  const gh = github(wsId);
  const sha = await ghHead(gh, cfg.repo, cfg.branch);
  const theirs = await ghSide(gh, cfg.repo, sha, cfg.path);
  let ingotOnly: string[] = [];
  if (theirs.present) {
    const skip = (p: string) => keptPath(p, cfg.keep) || theirs.links.has(p);
    const ours = await ingotSide(wsId, name, head, skip);
    const base = new Map([...theirs.files].filter(([p]) => !skip(p)));
    const d = changes(base, ours.files);
    // Only Ingot has it: Ingot's change, for the first Publish. GitHub has it (alone, or otherwise): it stops.
    ingotOnly = [...d.keys()].filter((p) => !base.has(p)).sort();
    const differ = [...d.keys()].filter((p) => base.has(p)).sort();
    if (differ.length)
      throw new MirrorError(`Ingot and GitHub differ in ${list(differ)}. Make them the same first (or add them to the files left alone), then link.`, 409, { code: "LINK_DIFFERS", paths: differ.slice(0, 50), count: differ.length });
  }
  const where = `${cfg.repo} ${cfg.branch}${cfg.path ? `, folder ${cfg.path}` : ""}`;
  const said = [
    `Linked ${name} to GitHub ${where} at ${short(sha)}.`,
    ingotOnly.length ? `${ingotOnly.length === 1 ? "1 file only Ingot has" : `${ingotOnly.length} files only Ingot has`} (${list(ingotOnly)}) ${ingotOnly.length === 1 ? "goes" : "go"} to GitHub with the next Publish.` : "",
    !theirs.present ? `GitHub has no ${cfg.path ? `${cfg.path}/ ` : ""}folder yet, so the next Publish puts all of it there.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { last: { sha, ingot: head, keep: cfg.keep ?? [], when: Date.now() }, ingotOnly, said };
}

export type MirrorDone = {
  last: NonNullable<GithubMirror["last"]>;
  /** The commit pushed (null: Ingot had nothing new for GitHub), and its page. */
  pushed: { sha: string; url: string; files: number } | null;
  /** How many of GitHub's changes came into Ingot first. */
  brought: number;
  /** Files GitHub's version was taken of (mirrorPull only). */
  took?: string[];
  /** In words, for the window and the bot. */
  said: string;
};

/** GitHub's changes into Ingot on top of its newest: in batches, again on top when someone committed meanwhile. The changeset it ends at. */
async function bringIn(
  wsId: string,
  name: string,
  cfg: GithubMirror,
  author: string,
  gh: GitHub,
  head: string,
  theirs: Map<string, GitFile | undefined>,
  check: (headFiles: Files) => void,
): Promise<{ to: string | null; brought: number }> {
  if (!theirs.size) return { to: null, brought: 0 };
  const skip = (p: string) => !theirs.has(p);
  const want: IngotChange[] = [];
  for (const [p, f] of theirs) {
    if (!f) want.push({ path: p, delete: true });
    else want.push({ path: p, content_base64: (await ghBytes(gh, cfg.repo, cfg.path, p, f, head)).toString("base64"), executable: f.mode === "100755" });
  }
  let to: string | null = null;
  let brought = 0;
  let left = want;
  let stale = 0;
  while (left.length) {
    const base = await ingot.head(wsId, name);
    if (!base) throw new MirrorError(`Ingot has no repo ${name}.`, 409);
    const there = await ingotSide(wsId, name, base, skip);
    check(there.files);
    // Only what Ingot doesn't have that way already.
    const real = left.filter((c) => ("delete" in c ? there.files.has(c.path) : !same(there.files.get(c.path), theirs.get(c.path))));
    if (!real.length) {
      to = base;
      break;
    }
    const batch: IngotChange[] = [];
    let size = 0;
    for (const c of real) {
      const n = "content_base64" in c ? c.content_base64.length : 0;
      if (batch.length && size + n > IMPORT_BATCH) break;
      batch.push(c);
      size += n;
    }
    // A big batch takes a while to send (Ingot's own limit for a write is 10 minutes).
    const r = await ingot.commit(wsId, name, { base, message: `From GitHub: ${real.length === 1 ? real[0].path : `${real.length} files`} changed on ${cfg.repo} ${cfg.branch} (${short(head)})`, changes: batch }, author, undefined, Math.min(600_000, 15_000 + Math.ceil(size / 250)));
    if ("id" in r) {
      brought += batch.length;
      to = r.id;
      left = real.slice(batch.length);
      stale = 0;
    } else if ("empty" in r) left = real.slice(batch.length);
    else if (++stale > 2) throw new MirrorError("Ingot kept moving while Bops brought GitHub's changes in. Publish again.", 409);
  }
  return { to: to ?? (await ingot.head(wsId, name)) ?? null, brought };
}

/**
 * Both sides' folders and what changed on GitHub since the point, the folder checked to be there. GitHub's links (and
 * submodules) are left alone while they're links; one that became a file, or went, since the point is GitHub's
 * change (`unlinked`: Ingot's copy never counts as Ingot's); a file that became one is left alone (`linked`).
 */
async function readGithub(gh: GitHub, cfg: GithubMirror) {
  const last = cfg.last!;
  // Linked with other paths left alone (one taken off the list since): the point says nothing of those. Link again.
  const keep = cfg.keep ?? [];
  if ((last.keep ?? []).some((k) => !keep.includes(k)))
    throw new MirrorError("What's left alone changed since it was linked to GitHub, so link it again first (Link checks both sides have the same files). Nothing was published.", 409, { code: "RELINK" });
  const head = await ghHead(gh, cfg.repo, cfg.branch);
  const now = await ghSide(gh, cfg.repo, head, cfg.path);
  const base = last.sha === head ? now : await ghSide(gh, cfg.repo, last.sha, cfg.path);
  if (base.present && !now.present)
    throw new MirrorError(`${cfg.path}/ isn't a folder on ${cfg.branch} of ${cfg.repo} any more (moved or deleted?). Fix it on GitHub, or change the folder and link again. Nothing was published.`, 409, { code: "FOLDER_GONE" });
  const kept = (p: string) => keptPath(p, keep);
  const skip = (p: string) => kept(p) || now.links.has(p);
  const filtered = (x: GhSide) => new Map([...x.files].filter(([p]) => !skip(p)));
  const baseFiles = filtered(base);
  const nowFiles = filtered(now);
  const theirs = changes(baseFiles, nowFiles);
  const unlinked = new Set([...base.links].filter((p) => !now.links.has(p) && !kept(p)));
  for (const p of unlinked) if (!now.files.has(p)) theirs.set(p, undefined);
  const linked = [...now.links].filter((p) => !base.links.has(p) && !kept(p) && base.files.has(p));
  return { head, now, base, baseFiles, nowFiles, skip, theirs, unlinked, linked };
}

/**
 * Publish Ingot changeset `at` (what the Preview serves) to GitHub (see above). Nothing is written while anything
 * would fail: the preview behind the point, conflicts, a file too big to send, one GitHub or Ingot won't give. Then
 * GitHub's changes into Ingot, one commit on GitHub, and its workflow when one is named. `author`: who Ingot's
 * changeset is by.
 */
export async function mirrorPublish(wsId: string, name: string, at: string, cfg: GithubMirror, author: string): Promise<MirrorDone> {
  const last = cfg.last;
  if (!last) throw new MirrorError(`${name} isn't linked to GitHub yet. Link it first, from Technical details in Your Apps.`, 409, { code: "NOT_LINKED" });
  if (!(await atOrAfter(wsId, name, at, last.ingot)))
    throw new MirrorError("The preview is older than what GitHub has (its changes came into Ingot since). Deploy the newest to the preview first, then publish.", 409, { code: "PREVIEW_BEHIND" });
  const gh = github(wsId);
  const { head, now, base, baseFiles, skip, theirs, unlinked, linked } = await readGithub(gh, cfg);
  const oursNow = await ingotSide(wsId, name, at, skip);
  const ours = changes(baseFiles, oursNow.files);
  // A link on GitHub that became a file or went: GitHub's to say; Ingot's copy of it was never Ingot's change.
  for (const p of unlinked) ours.delete(p);
  massDelete(baseFiles, theirs, "GitHub");
  massDelete(baseFiles, ours, "Ingot");

  // Both changed a file: fine when to the same bytes and mode (nothing to carry either way), else it stops. A file
  // GitHub made a link of, which Ingot changed, too: the link is left alone, so Ingot's change would go nowhere.
  const both: string[] = [];
  if (linked.length) {
    const was = (await ingotSide(wsId, name, at, (p) => !linked.includes(p))).files;
    for (const p of linked) if (!same(was.get(p), base.files.get(p))) both.push(p);
  }
  for (const p of [...ours.keys()]) {
    if (!theirs.has(p)) continue;
    if (same(ours.get(p), theirs.get(p))) {
      ours.delete(p);
      theirs.delete(p);
    } else both.push(p);
  }
  // Newer work in Ingot (main past the preview) on a file GitHub changed: never written over.
  const newer = (headFiles: Files) => {
    for (const [p, f] of theirs) if (!unlinked.has(p) && !same(headFiles.get(p), baseFiles.get(p)) && !same(headFiles.get(p), f) && !both.includes(p)) both.push(p);
    if (both.length)
      throw new MirrorError(`Both Ingot and GitHub changed ${list(both)} since they were last the same. Bring in GitHub's changes (from Technical details in Your Apps) to take GitHub's version, then make Ingot's change again. Nothing was published.`, 409, { code: "BOTH_CHANGED", paths: both });
  };
  const ingotHead = await ingot.head(wsId, name);
  newer(theirs.size && ingotHead && ingotHead !== at ? (await ingotSide(wsId, name, ingotHead, (p) => !theirs.has(p))).files : oursNow.files);

  // What goes up: none too big, each read and checked now.
  const puts = [...ours].filter(([, f]) => f).map(([p]) => p);
  const big = puts.filter((p) => (ours.get(p)?.size ?? 0) > BLOB_MAX);
  if (big.length) throw new MirrorError(`Too big to send to GitHub through Bops (${Math.round(BLOB_MAX / 1000)} KB a file at most): ${list(big)}. Nothing was published.`, 413, { code: "TOO_BIG", paths: big });
  const bytes = await ingotBytes(wsId, name, at, puts);

  // 1. GitHub's changes into Ingot (checked again against whatever is on top then).
  const { to, brought } = await bringIn(wsId, name, cfg, author, gh, head, theirs, newer);
  const keep = cfg.keep ?? [];
  try {
    return await pushUp(wsId, name, at, cfg, gh, { head, now, ours, bytes, to, brought, keep });
  } catch (e) {
    // GitHub's changes are in Ingot now: the point moves to them (GitHub's commit they were read at, and Ingot's
    // changeset with them in), so the next Publish neither brings them in again nor takes them for Ingot's.
    if (!brought || !to) throw e;
    const err = e instanceof MirrorError ? e : new MirrorError("Orgo didn't reach GitHub. Try again.", 502);
    err.extra = { ...err.extra, last: { sha: head, ingot: to, keep, when: Date.now() } };
    throw err;
  }
}

/** Publish's second half: Ingot's changes onto GitHub, one commit on top of the branch, its folder only; then its workflow. Nothing throws once the branch moved. */
async function pushUp(
  wsId: string,
  name: string,
  at: string,
  cfg: GithubMirror,
  gh: GitHub,
  x: { head: string; now: GhSide; ours: Map<string, GitFile | undefined>; bytes: Map<string, Buffer>; to: string | null; brought: number; keep: string[] },
): Promise<MirrorDone> {
  const { head, now, ours, bytes, to, brought, keep } = x;
  const prefix = cfg.path ? `${cfg.path}/` : "";
  // 2. Ingot's changes onto GitHub: one commit on top of the branch, its folder only.
  const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  for (const [p, f] of ours) {
    const there = now.files.get(p);
    if (!f) {
      if (there) entries.push({ path: prefix + p, mode: there.mode, type: "blob", sha: null });
      continue;
    }
    if (same(there, f)) continue;
    const blob = await gh.need(`send ${p}`, "POST", `/repos/${cfg.repo}/git/blobs`, { content: bytes.get(p)!.toString("base64"), encoding: "base64" });
    entries.push({ path: prefix + p, mode: f.mode, type: "blob", sha: String(blob.sha) });
  }
  let pushed: MirrorDone["pushed"] = null;
  let tip = head;
  if (entries.length) {
    const tree = await gh.need("put the files together", "POST", `/repos/${cfg.repo}/git/trees`, { base_tree: now.root, tree: entries });
    const changed = entries.map((e) => e.path.slice(prefix.length));
    const message = `Publish ${name} from Bops (Ingot ${short(at)})\n\n${changed.slice(0, 20).map((p) => `- ${p}`).join("\n")}${changed.length > 20 ? `\n- and ${changed.length - 20} more` : ""}\n\nIngot-Changeset: ${at}`;
    const commit = await gh.need("make the commit", "POST", `/repos/${cfg.repo}/git/commits`, { message, tree: String(tree.sha), parents: [head] });
    const sha = String(commit.sha);
    // An answer lost on the way (the broker timed out) may still have moved it: GitHub is asked where it is.
    const moved = await gh.call("PATCH", `/repos/${cfg.repo}/git/refs/heads/${segs(cfg.branch)}`, { sha, force: false }).catch(async (e) => {
      if ((await ghHead(gh, cfg.repo, cfg.branch).catch(() => null)) === sha) return { status: 200 } as KeyAnswer;
      throw e;
    });
    if (moved.status === 422 || moved.status === 409)
      throw new MirrorError(`Someone pushed to ${cfg.branch} on GitHub while Bops was publishing, so nothing went there. Publish again.`, 409, { code: "GITHUB_MOVED", brought });
    if (moved.status >= 400) throw new MirrorError(`GitHub didn't move ${cfg.branch} to the new commit (${moved.status}). Nothing went live.`, 502, { brought });
    tip = sha;
    pushed = { sha, url: `https://github.com/${cfg.repo}/commit/${sha}`, files: entries.length };
  }

  // 3. Its workflow, when the push doesn't start one by itself.
  let ran = "";
  if (pushed && cfg.dispatch) {
    const r = await gh.call("POST", `/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.dispatch.workflow)}/dispatches`, { ref: cfg.branch, ...(cfg.dispatch.inputs ? { inputs: cfg.dispatch.inputs } : {}) }).catch(() => null);
    ran = r && (r.status === 204 || r.status === 200) ? ` Started ${cfg.dispatch.workflow} on GitHub.` : ` Couldn't start ${cfg.dispatch.workflow} on GitHub${r ? ` (${r.status})` : ""}: run it there.`;
  }
  const said = [
    brought ? `Brought ${brought} ${brought === 1 ? "change" : "changes"} from GitHub into Ingot first.` : "",
    pushed ? `Pushed ${pushed.files} ${pushed.files === 1 ? "file" : "files"} to ${cfg.repo} ${cfg.branch} (${short(pushed.sha)}): GitHub deploys it.${ran}` : "GitHub already has everything in this preview, so nothing was pushed.",
    brought ? "Deploy the newest to the preview to see GitHub's changes there." : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Ingot's side of the point: what came in from GitHub, when it did (a later preview has it); else what was published.
  return { last: { sha: tip, ingot: to ?? at, keep, when: Date.now() }, pushed, brought, said };
}

/**
 * Bring in GitHub's changes, on the owner's word: everything that changed in the folder on GitHub since the point
 * comes into Ingot on top of its newest, GitHub's version winning where both changed a file (Ingot's is in its
 * history), and the point moves to the branch's newest. What only Ingot changed stays, for the next Publish.
 */
export async function mirrorPull(wsId: string, name: string, cfg: GithubMirror, author: string): Promise<MirrorDone> {
  if (!cfg.last) throw new MirrorError(`${name} isn't linked to GitHub yet. Link it first, from Technical details in Your Apps.`, 409, { code: "NOT_LINKED" });
  const gh = github(wsId);
  const { head, baseFiles, theirs, unlinked } = await readGithub(gh, cfg);
  massDelete(baseFiles, theirs, "GitHub");
  const ingotHead = await ingot.head(wsId, name);
  if (!ingotHead) throw new MirrorError(`Ingot has no repo ${name}.`, 409);
  const headFiles = (await ingotSide(wsId, name, ingotHead, (p) => !theirs.has(p))).files;
  const took = [...theirs.keys()].filter((p) => !unlinked.has(p) && !same(headFiles.get(p), baseFiles.get(p)) && !same(headFiles.get(p), theirs.get(p))).sort();
  const { to, brought } = await bringIn(wsId, name, cfg, author, gh, head, theirs, () => {});
  const said = brought
    ? `Brought ${brought} ${brought === 1 ? "change" : "changes"} from GitHub into Ingot.${took.length ? ` Took GitHub's version of ${list(took)} (Ingot's is in its history: make that change again).` : ""} Deploy the newest to the preview to see them there.`
    : "Ingot has everything GitHub has already.";
  return { last: { sha: head, ingot: to ?? ingotHead, keep: cfg.keep ?? [], when: Date.now() }, pushed: null, brought, took, said };
}
