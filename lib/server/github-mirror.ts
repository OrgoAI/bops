import "server-only";
import { createHash } from "node:crypto";
import type { GithubMirror } from "@/lib/hosted-apps";
import { ingot, type IngotChange, type IngotFile } from "./ingot";
import { callKey, KeysError, keyProjectFor, listKeys, type KeyAnswer, type KeyMethod, type VaultKey } from "./keys";

/**
 * An app whose production is on GitHub (AppHosting.github): Ingot is where it's worked on and previewed, and
 * Publish carries it across to a folder of a GitHub repo, where that repo's own workflow deploys it.
 *
 * It's a sync of changes, not a copy: each side has its own point the two were last the same at (`last`: an Ingot
 * changeset and a GitHub commit). What changed in Ingot since its point (up to the changeset the Preview serves)
 * goes to GitHub; what changed on GitHub since its point (someone committed there) comes into Ingot first, so
 * Ingot stays the source and nothing done on GitHub is lost. A file both changed, to different bytes, stops it
 * (BOTH_CHANGED) before anything is written. Whatever differed when they were linked stays as it is (a preview's
 * own password file, say), as do the app's `keep` files, symbolic links on GitHub (Ingot has none), and everything
 * outside the folder: the push is one commit on top of the branch, never forced.
 *
 * Every GitHub call goes through Orgo's broker with the owner's GITHUB_TOKEN (keys.ts callKey): the token is in no
 * command, file, log or message. The broker takes 1 MB a request (so a file up to BLOB_MAX goes up), answers 512 KB
 * (a bigger file comes down by GitHub's own short-lived link), and 120 calls a minute (paced below).
 */

const KEY = "GITHUB_TOKEN";
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

export class MirrorError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(message: string, status = 502, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

type GhFile = { sha: string; mode: string; size: number };
type GhSide = { root: string; files: Map<string, GhFile>; links: Set<string> };
type Put = { kind: "put" };
type Del = { kind: "del" };
type Delta = Map<string, Put | Del>;

/** A file's git blob id (what GitHub names it by). */
export const gitSha = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (id: string) => id.slice(0, 7);
const list = (paths: string[], n = 5) => paths.slice(0, n).join(", ") + (paths.length > n ? ` and ${paths.length - n} more` : "");

/** Whether `path` (in the app's folder) is the app's alone: one of `keep`, in a kept folder (ending in /), or always kept. */
export function keptPath(path: string, keep: readonly string[] = []): boolean {
  return [...ALWAYS_KEPT, ...keep].some((k) => (k.endsWith("/") ? path.startsWith(k) : path === k));
}

function jsonOf(a: KeyAnswer): Record<string, unknown> | null {
  const b = typeof a.body === "string" ? (() => { try { return JSON.parse(a.body as string) as unknown; } catch { return null; } })() : a.body;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

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
      throw new MirrorError(e instanceof KeysError ? `GitHub: ${e.message}` : "Orgo didn't reach GitHub. Try again.", e instanceof KeysError && e.status === 404 ? 409 : 502);
    }
  };
  /** A 2xx answer's JSON, whole; else what GitHub said, for `step`. */
  const need = async (step: string, method: KeyMethod, path: string, body?: unknown, query?: Record<string, unknown>) => {
    const r = await call(method, path, body, query);
    const j = jsonOf(r);
    if (r.status === 401 || r.status === 403) throw new MirrorError(`GitHub turned the token down while Bops tried to ${step} (${r.status}). Check the GitHub key in Keys can write to the repo.`, 409);
    if (r.status >= 400 || !j) throw new MirrorError(`GitHub didn't let Bops ${step} (${r.status}${typeof j?.message === "string" ? `: ${j.message.slice(0, 200)}` : ""}).`, 502);
    if (r.truncated) throw new MirrorError(`GitHub's answer was too big for Bops to read while it tried to ${step}.`, 502);
    return j;
  };
  return { call, need };
}

/** The files of `folder` of `repo` at `commit`: each one's blob id, mode and size, and its symbolic links (never touched). */
async function ghSide(gh: ReturnType<typeof github>, repo: string, commit: string, folder: string): Promise<GhSide> {
  const c = await gh.need("read a commit", "GET", `/repos/${repo}/git/commits/${commit}`);
  const root = String((c.tree as { sha?: unknown } | undefined)?.sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(root)) throw new MirrorError("GitHub sent a commit Bops couldn't read.", 502);
  let at = root;
  for (const seg of folder ? folder.split("/") : []) {
    const t = await gh.need("read its folders", "GET", `/repos/${repo}/git/trees/${at}`);
    const e = (t.tree as { path?: unknown; type?: unknown; sha?: unknown }[] | undefined)?.find((x) => x.path === seg && x.type === "tree");
    if (!e || typeof e.sha !== "string") return { root, files: new Map(), links: new Set() };
    at = e.sha;
  }
  const t = await gh.need("read its files", "GET", `/repos/${repo}/git/trees/${at}`, undefined, { recursive: "1" });
  if (t.truncated === true) throw new MirrorError("That folder has more files than GitHub lists at once.", 502);
  const files = new Map<string, GhFile>();
  const links = new Set<string>();
  for (const e of (t.tree as { path?: unknown; type?: unknown; sha?: unknown; mode?: unknown; size?: unknown }[]) ?? []) {
    if (typeof e.path !== "string" || typeof e.sha !== "string") continue;
    if (e.type === "commit" || e.mode === "120000") links.add(e.path);
    else if (e.type === "blob") files.set(e.path, { sha: e.sha, mode: String(e.mode), size: typeof e.size === "number" ? e.size : 0 });
  }
  return { root, files, links };
}

/** What changed from `base` to `now`, for paths `skip` doesn't leave out: each one put (added or changed) or deleted. */
function deltaOf<T>(base: Map<string, T>, now: Map<string, T>, same: (a: T, b: T) => boolean, skip: (p: string) => boolean): Delta {
  const d: Delta = new Map();
  for (const [p, f] of now) if (!skip(p) && (!base.has(p) || !same(base.get(p)!, f))) d.set(p, { kind: "put" });
  for (const p of base.keys()) if (!skip(p) && !now.has(p)) d.set(p, { kind: "del" });
  return d;
}

/** Ingot's files of changeset `at`, by path. */
async function ingotSide(wsId: string, name: string, at: string) {
  const t = await ingot.tree(wsId, name, at);
  if (!t) throw new MirrorError(`Ingot has no changeset ${short(at)} of ${name}.`, 409);
  return new Map(t.map((f) => [f.path, f] as const));
}

/** The bytes of a file of GitHub, checked against its blob id. */
async function ghBytes(gh: ReturnType<typeof github>, repo: string, folder: string, path: string, f: GhFile, commit: string): Promise<Buffer> {
  let b: Buffer;
  if (f.size <= INLINE_DOWN) {
    const j = await gh.need(`read ${path}`, "GET", `/repos/${repo}/git/blobs/${f.sha}`);
    b = Buffer.from(String(j.content ?? ""), "base64");
  } else {
    const full = (folder ? `${folder}/` : "") + path;
    const j = await gh.need(`find ${path}`, "GET", `/repos/${repo}/contents/${full.split("/").map(encodeURIComponent).join("/")}`, undefined, { ref: commit });
    const url = typeof j.download_url === "string" ? j.download_url : "";
    if (!url.startsWith("https://")) throw new MirrorError(`GitHub gave no way to download ${path}.`, 502);
    // GitHub's own short-lived link (it carries its own access): fetched here, never kept or shown.
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5 * 60_000) }).catch(() => null);
    if (!r?.ok) throw new MirrorError(`GitHub didn't send ${path}.`, 502);
    b = Buffer.from(await r.arrayBuffer());
  }
  if (gitSha(b) !== f.sha) throw new MirrorError(`GitHub sent ${path} with other bytes than it listed.`, 502);
  return b;
}

/** The bytes of files of Ingot changeset `at` (from its presigned links), each checked against its blob. */
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

/** The newest commit of `branch` on GitHub. */
async function ghHead(gh: ReturnType<typeof github>, repo: string, branch: string): Promise<string> {
  const r = await gh.call("GET", `/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
  if (r.status === 404) throw new MirrorError(`GitHub has no branch ${branch} in ${repo} (or the GitHub key can't see the repo).`, 409);
  const j = jsonOf(r);
  const sha = (j?.object as { sha?: unknown } | undefined)?.sha;
  if (r.status !== 200 || typeof sha !== "string") throw new MirrorError(`GitHub didn't say where ${branch} is (${r.status}).`, 502);
  return sha;
}

/**
 * Link an app to GitHub: from now on, the two sides are the same as far as the mirror knows at Ingot's newest
 * changeset and the branch's newest commit (what differs between them already stays as it is). Answers `last`.
 */
export async function linkMirror(wsId: string, name: string, cfg: GithubMirror): Promise<NonNullable<GithubMirror["last"]>> {
  const head = await ingot.head(wsId, name);
  if (!head) throw new MirrorError(head === undefined ? `Ingot has no repo ${name}.` : `${name} has nothing committed yet.`, 409);
  const sha = await ghHead(github(wsId), cfg.repo, cfg.branch);
  return { at: head, sha, when: Date.now() };
}

export type MirrorDone = {
  last: NonNullable<GithubMirror["last"]>;
  /** The commit pushed (null: Ingot had nothing new for GitHub), and its page. */
  pushed: { sha: string; url: string; files: number } | null;
  /** How many of GitHub's changes came into Ingot first (as a changeset of their own). */
  brought: number;
  /** In words, for the window and the bot. */
  said: string;
};

/**
 * Publish Ingot changeset `at` (what the Preview serves) to GitHub (see above). Nothing is written while anything
 * would fail: conflicts, a file too big to send, a file GitHub or Ingot won't give. Then GitHub's changes into Ingot,
 * then one commit on GitHub, then its workflow when one is named. `author`: who Ingot's changeset is by.
 */
export async function mirrorPublish(wsId: string, name: string, at: string, cfg: GithubMirror, author: string): Promise<MirrorDone> {
  const last = cfg.last;
  if (!last) throw new MirrorError(`${name} isn't linked to GitHub yet. Link it first, in its Published settings.`, 409, { code: "NOT_LINKED" });
  const gh = github(wsId);
  const folder = cfg.path;
  const prefix = folder ? `${folder}/` : "";
  const keep = cfg.keep ?? [];
  const head = await ghHead(gh, cfg.repo, cfg.branch);
  const theirsNow = await ghSide(gh, cfg.repo, head, folder);
  const theirsBase = last.sha === head ? theirsNow : await ghSide(gh, cfg.repo, last.sha, folder);
  const links = new Set([...theirsNow.links, ...theirsBase.links]);
  const skip = (p: string) => keptPath(p, keep) || links.has(p);
  const oursNow = await ingotSide(wsId, name, at);
  const oursBase = last.at === at ? oursNow : await ingotSide(wsId, name, last.at);
  const ours = deltaOf<IngotFile>(oursBase, oursNow, (a, b) => a.blob === b.blob && a.executable === b.executable, skip);
  const theirs = deltaOf<GhFile>(theirsBase.files, theirsNow.files, (a, b) => a.sha === b.sha && a.mode === b.mode, skip);

  // Ingot's new bytes (to compare with GitHub's, and to send): each checked, none too big to send.
  const puts = [...ours].filter(([, d]) => d.kind === "put").map(([p]) => p);
  const big = puts.filter((p) => (oursNow.get(p)?.size ?? 0) > BLOB_MAX);
  if (big.length) throw new MirrorError(`Too big to send to GitHub through Bops (${Math.round(BLOB_MAX / 1000)} KB a file at most): ${list(big)}. Nothing was published.`, 413, { code: "TOO_BIG", paths: big });
  const bytes = await ingotBytes(wsId, name, at, puts);

  // Both sides changed a file: fine when they came to the same bytes, else it stops here.
  const both: string[] = [];
  for (const [p, d] of ours) {
    const t = theirs.get(p);
    if (!t) continue;
    if (d.kind === "del" && t.kind === "del") {
      ours.delete(p);
      theirs.delete(p);
    } else if (d.kind === "put" && t.kind === "put" && gitSha(bytes.get(p)!) === theirsNow.files.get(p)?.sha) {
      ours.delete(p);
      theirs.delete(p);
    } else both.push(p);
  }
  if (both.length)
    throw new MirrorError(`Both Ingot and GitHub changed ${list(both)} since they were last the same. Bring them together in Ingot first (take GitHub's change into the app, then Publish). Nothing was published.`, 409, { code: "BOTH_CHANGED", paths: both });

  // What comes from GitHub: read now, before anything is written.
  const fromGh: IngotChange[] = [];
  for (const [p, d] of theirs) {
    if (d.kind === "del") fromGh.push({ path: p, delete: true });
    else {
      const f = theirsNow.files.get(p)!;
      const b = await ghBytes(gh, cfg.repo, folder, p, f, head);
      fromGh.push({ path: p, content_base64: b.toString("base64"), executable: f.mode === "100755" });
    }
  }

  // 1. GitHub's changes into Ingot, on top of its newest (in a few commits when they're big). When that newest is
  // the changeset being published, the last of them is Ingot's side of the new point (the same files as GitHub's
  // after the push); else (newer work in Ingot not in this preview) its point stays the published changeset.
  let brought = 0;
  let point: string | null = at;
  if (fromGh.length) {
    const batches: IngotChange[][] = [[]];
    let size = 0;
    for (const c of fromGh) {
      const n = "content_base64" in c ? c.content_base64.length : 0;
      if (size + n > IMPORT_BATCH && batches.at(-1)!.length) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1)!.push(c);
      size += n;
    }
    for (const changes of batches) {
      // Deleting what Ingot doesn't have is no change: only what's there goes.
      for (let tries = 0; ; tries++) {
        const base = await ingot.head(wsId, name);
        if (!base) throw new MirrorError(`Ingot has no repo ${name}.`, 409);
        const there = await ingotSide(wsId, name, base);
        const real = changes.filter((c) => !("delete" in c) || there.has(c.path));
        if (base !== point) point = null;
        if (!real.length) break;
        const r = await ingot.commit(wsId, name, { base, message: `From GitHub: ${real.length === 1 ? real[0].path : `${real.length} files`} changed on ${cfg.repo} ${cfg.branch} (${short(head)})`, changes: real }, author);
        if ("id" in r) {
          brought += real.length;
          if (point) point = r.id;
          break;
        }
        if ("empty" in r) break;
        if (tries >= 2) throw new MirrorError(`Ingot kept moving while Bops brought GitHub's changes in. Publish again.`, 409);
      }
    }
  }

  // 2. Ingot's changes onto GitHub: one commit on top of the branch, its folder only.
  const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  for (const [p, d] of ours) {
    const there = theirsNow.files.get(p);
    if (d.kind === "del") {
      if (there) entries.push({ path: prefix + p, mode: there.mode, type: "blob", sha: null });
      continue;
    }
    const b = bytes.get(p)!;
    const f = oursNow.get(p)!;
    const mode = f.executable ? "100755" : "100644";
    if (there && there.sha === gitSha(b) && there.mode === mode) continue;
    const blob = await gh.need(`send ${p}`, "POST", `/repos/${cfg.repo}/git/blobs`, { content: b.toString("base64"), encoding: "base64" });
    entries.push({ path: prefix + p, mode, type: "blob", sha: String(blob.sha) });
  }
  let pushed: MirrorDone["pushed"] = null;
  let tip = head;
  if (entries.length) {
    const tree = await gh.need("put the files together", "POST", `/repos/${cfg.repo}/git/trees`, { base_tree: theirsNow.root, tree: entries });
    const changed = entries.map((e) => e.path.slice(prefix.length));
    const message = `Publish ${name} from Bops (Ingot ${short(at)})\n\n${changed.slice(0, 20).map((p) => `- ${p}`).join("\n")}${changed.length > 20 ? `\n- and ${changed.length - 20} more` : ""}\n\nIngot-Changeset: ${at}`;
    const commit = await gh.need("make the commit", "POST", `/repos/${cfg.repo}/git/commits`, { message, tree: String(tree.sha), parents: [head] });
    const sha = String(commit.sha);
    const moved = await gh.call("PATCH", `/repos/${cfg.repo}/git/refs/heads/${cfg.branch.split("/").map(encodeURIComponent).join("/")}`, { sha, force: false });
    if (moved.status === 422 || moved.status === 409)
      throw new MirrorError(`Someone pushed to ${cfg.branch} on GitHub while Bops was publishing, so nothing went there. Publish again.`, 409, { code: "GITHUB_MOVED", brought });
    if (moved.status >= 400) throw new MirrorError(`GitHub didn't move ${cfg.branch} to the new commit (${moved.status}). Nothing went live.`, 502, { brought });
    tip = sha;
    pushed = { sha, url: `https://github.com/${cfg.repo}/commit/${sha}`, files: entries.length };
  }

  // 3. Its workflow, when the push doesn't start one by itself.
  let ran = "";
  if (pushed && cfg.dispatch) {
    const r = await gh.call("POST", `/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.dispatch.workflow)}/dispatches`, { ref: cfg.branch, ...(cfg.dispatch.inputs ? { inputs: cfg.dispatch.inputs } : {}) });
    ran = r.status === 204 || r.status === 200 ? ` Started ${cfg.dispatch.workflow} on GitHub.` : ` Couldn't start ${cfg.dispatch.workflow} on GitHub (${r.status}): run it there.`;
  }
  const said = [
    brought ? `Brought ${brought} ${brought === 1 ? "change" : "changes"} from GitHub into Ingot first.` : "",
    pushed ? `Pushed ${pushed.files} ${pushed.files === 1 ? "file" : "files"} to ${cfg.repo} ${cfg.branch} (${short(pushed.sha)}): GitHub deploys it.${ran}` : `GitHub already has everything in this preview, so nothing was pushed.`,
  ]
    .filter(Boolean)
    .join(" ");
  return { last: { at: point ?? at, sha: tip, when: Date.now() }, pushed, brought, said };
}
