import "server-only";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { SkillKind } from "@/lib/types";
import { keptLabel } from "@/lib/skill-labels";
import { onRunner } from "./persist";
import { isVersion, labelOf, normalizePath, parseSkillMd, RISKS, sha256Hex, textOf, type BundleFile } from "./skill-bundle";
import { getState, userDir } from "./store";
import type { Bundle } from "./workspace-skills";

/*
 * A workspace's published skills as Orgo keeps them, read by a computer's runner (BOPS_RUNNER) with its own key, so a
 * chat or a task its bots run there follows the skills the owner or an Admin published, with the owner's Mac off.
 * orgo-web lets a computer's own key read its computer's workspace's published skills, each at its current version, and
 * the approvals with the approver's role (lib/api-keys/runner-scope.ts computerSkillReadScope there); every published
 * one of the workspace, not only its bots': which bot has which is Bops' own rule (lib/skill-labels.ts botHasSkill),
 * kept by workspace-skills.ts as on the Mac (refsOf lays this list over the state's, skillsFor filters).
 *
 * Read at most once a minute a workspace (refreshRunnerSkills: at a chat turn's start, runner-chat.ts, and before a
 * copy to the computer, copySkillsToComputer), each call held to a few seconds, and kept on the computer's disk under
 * userDir()/runner-skills/<project>/ (a version never changes, so one read is read once): the list (index.json) and
 * each version's files. A version no longer listed goes from there. Orgo not answering, an orgo-web from before
 * (403 computer_key) or no Orgo project: the last copy kept stays, and with none, everything is as before (the state's
 * list, and what the owner's Mac last copied to the computer). Never written to the state: a computer may not write a
 * workspace's skills (cloud/computer-scope.ts). Nothing of a skill is logged.
 */

/** A published skill as the runner keeps it: what its ref says, and its files (the version's folder holds them). */
export type RunnerSkill = {
  id: string;
  slug: string;
  kind: SkillKind;
  name: string;
  description: string;
  version: string;
  botIds: string[];
  label?: string;
  risk?: string;
  updatedAt: string;
  files: { path: string; sha256: string; size: number; executable: boolean; binary: boolean }[];
};
/** What a runner keeps of a workspace's: its published skills, and the contents the owner or an Admin approved. */
type Kept = { pid: string; at: number; skills: RunnerSkill[]; approvals: string[] };

const THROTTLE_MS = 60_000;
/** How long one call to Orgo may take, and how long a turn waits for a read (it goes on in the background after). */
const CALL_MS = 5_000;
const WAIT_MS = 8_000;

const g = globalThis as unknown as { bopsRunnerSkills?: Map<string, { kept?: Kept | null; tried: number; going?: Promise<void> }> };
const memo = () => (g.bopsRunnerSkills ??= new Map());
/** A project's entry, made when missing: changed in place, so a read under way and its end see the same one. */
const entry = (pid: string) => {
  let e = memo().get(pid);
  if (!e) memo().set(pid, (e = { tried: 0 }));
  return e;
};

const root = () => {
  const dir = userDir();
  return dir === null ? null : join(/*turbopackIgnore: true*/ dir, "runner-skills");
};
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "_";
const pidDir = (pid: string) => {
  const r = root();
  return r ? join(/*turbopackIgnore: true*/ r, safe(pid)) : null;
};
const versionDir = (pid: string, kind: SkillKind, slug: string, version: string) => {
  const d = pidDir(pid);
  return d && isVersion(version) ? join(/*turbopackIgnore: true*/ d, kind === "app" ? "apps" : "skills", safe(slug), version) : null;
};

/** The copy kept for a project: in memory, else from its index on disk; null when there's none. */
function keptOf(pid: string): Kept | null {
  const m = memo().get(pid);
  if (m && m.kept !== undefined) return m.kept;
  let kept: Kept | null = null;
  const d = pidDir(pid);
  try {
    if (d && existsSync(/*turbopackIgnore: true*/ join(d, "index.json"))) {
      const j = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(d, "index.json"), "utf8")) as Kept;
      if (j && j.pid === pid && Array.isArray(j.skills) && Array.isArray(j.approvals)) kept = j;
    }
  } catch {
    kept = null;
  }
  entry(pid).kept = kept;
  return kept;
}

/** On a runner: a workspace's published skills and the approvals that count, as last read from Orgo; null without one. */
export function runnerOverlay(pid: string): { skills: RunnerSkill[]; approvals: Set<string> } | null {
  if (!onRunner()) return null;
  const kept = keptOf(pid);
  return kept ? { skills: kept.skills, approvals: new Set(kept.approvals) } : null;
}

/** On a runner: a published version's folder as a bundle (SKILL.md split, its files), from the copy kept; null when it isn't there. */
export function runnerBundle(pid: string, kind: SkillKind, slug: string, version: string): Bundle | null {
  if (!onRunner()) return null;
  const x = keptOf(pid)?.skills.find((s) => s.kind === kind && s.slug === slug && s.version === version);
  const dir = versionDir(pid, kind, slug, version);
  if (!x || !dir) return null;
  try {
    const md = readFileSync(/*turbopackIgnore: true*/ join(dir, "SKILL.md"), "utf8");
    const parsed = parseSkillMd(md);
    const files: BundleFile[] = x.files.map((f) => {
      const bytes = readFileSync(/*turbopackIgnore: true*/ join(dir, f.path));
      return f.binary ? { path: f.path, content: null, data: bytes, sha256: f.sha256, size: bytes.length, executable: f.executable } : { path: f.path, content: bytes.toString("utf8"), sha256: f.sha256, size: bytes.length, executable: f.executable };
    });
    if (files.some((f) => sha256Hex(f.data ?? Buffer.from(f.content ?? "", "utf8")) !== f.sha256)) return null;
    return { frontmatter: parsed.ok ? (parsed.frontmatter ?? {}) : {}, body: parsed.ok ? parsed.body : md, skillMd: md, files };
  } catch {
    return null;
  }
}

/** One file of Orgo's export (GET …/skills/{id}/export): its text inline, or its bytes at `url`. */
export type ExportFile = { content?: string; url?: string; sha256?: string; executable?: boolean };

/**
 * A file of Orgo's export as it was stored: its text inline, or its bytes from `url` (a short presigned GET, no key
 * sent: orgo-web gives one for every binary file and for large text). Checked against its sha256; null when it can't
 * be fetched or doesn't match, so nothing half there is ever written.
 */
export async function exportedFile(path: string, f: ExportFile, timeoutMs = 120_000): Promise<{ path: string; content: string | null; data?: Buffer; executable: boolean } | null> {
  let bytes: Buffer;
  if (typeof f.content === "string") bytes = Buffer.from(f.content, "utf8");
  else if (typeof f.url === "string" && /^https?:\/\//.test(f.url)) {
    const res = await fetch(f.url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    if (!res?.ok) return null;
    bytes = Buffer.from(await res.arrayBuffer());
  } else return null;
  if (f.sha256 && sha256Hex(bytes) !== f.sha256) return null;
  const text = typeof f.content === "string" ? f.content : textOf(path, bytes);
  return text !== null ? { path, content: text, executable: !!f.executable } : { path, content: null, data: bytes, executable: !!f.executable };
}

/** A skill of orgo-web's list as a runner reads it. */
type Listed = { id?: unknown; slug?: unknown; name?: unknown; description?: unknown; type?: unknown; status?: unknown; bot_ids?: unknown; updated_at?: unknown; current_version?: { version?: unknown; risk?: unknown; label?: unknown } | null };

const kindOf = (type: unknown): SkillKind => (type === "app" || type === "software" ? "app" : "skill");

/**
 * Read a workspace's published skills from Orgo with this computer's own key (on a runner only, at most once a minute
 * a workspace), and keep them on its disk. A caller waits a few seconds at most; the read goes on after that.
 */
export async function refreshRunnerSkills(wsId: string): Promise<void> {
  if (!onRunner()) return;
  const pid = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
  if (!pid || root() === null) return;
  const m = entry(pid);
  if (!m.going) {
    if (Date.now() - m.tried < THROTTLE_MS) return;
    m.tried = Date.now();
    m.going = readFromOrgo(pid)
      .catch((e: Error) => console.warn(`[runner-skills] reading the workspace's skills: ${e.message}`))
      .finally(() => (m.going = undefined));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([m.going, new Promise<void>((done) => (timer = setTimeout(done, WAIT_MS)))]);
  clearTimeout(timer);
}

async function readFromOrgo(pid: string) {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return;
  const at = `/api/projects/${encodeURIComponent(pid)}/skills`;
  const got = await callOrgo<{ skills?: Listed[] }>(key, at, { timeoutMs: CALL_MS });
  // An orgo-web from before (403 computer_key), another workspace's (404), or Orgo away: what was kept stays.
  if (!got || got.status !== 200 || !Array.isArray(got.json.skills)) return;
  const before = keptOf(pid);
  const skills: RunnerSkill[] = [];
  for (const x of got.json.skills) {
    const version = x?.current_version?.version;
    if (!x || x.status !== "published" || typeof x.id !== "string" || typeof x.slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.slug) || typeof version !== "string" || !isVersion(version)) continue;
    const kind = kindOf(x.type);
    const had = before?.skills.find((s) => s.id === x.id && s.version === version && s.kind === kind && s.slug === x.slug);
    const base = {
      id: x.id,
      slug: x.slug,
      kind,
      name: typeof x.name === "string" ? x.name : x.slug,
      description: typeof x.description === "string" ? x.description : "",
      version,
      botIds: Array.isArray(x.bot_ids) ? x.bot_ids.filter((b): b is string => typeof b === "string") : [],
      ...(typeof x.current_version?.risk === "string" && (RISKS as readonly string[]).includes(x.current_version.risk) ? { risk: x.current_version.risk } : {}),
      updatedAt: typeof x.updated_at === "string" ? x.updated_at : "",
    };
    // A version kept here already: its files and label are as they were (a version never changes).
    if (had && versionDir(pid, kind, x.slug, version) && existsSync(/*turbopackIgnore: true*/ join(versionDir(pid, kind, x.slug, version)!, "SKILL.md"))) {
      skills.push({ ...base, ...(had.label ? { label: had.label } : {}), files: had.files });
      continue;
    }
    const fetched = await fetchVersion(key, at, pid, x.id, kind, x.slug, version);
    if (fetched) skills.push({ ...base, ...(fetched.label ? { label: fetched.label } : {}), files: fetched.files });
    else {
      // Not read now: an older version kept here still serves, until one is.
      const older = before?.skills.find((s) => s.id === x.id);
      if (older) skills.push(older);
    }
  }
  // The approvals that count: the owner's and an Admin's (approved_by_role), never a Member's. None read: as kept.
  const ap = await callOrgo<{ approvals?: { sha256?: unknown; approved_by_role?: unknown }[] }>(key, `${at}/approvals`, { timeoutMs: CALL_MS });
  const approvals =
    ap?.status === 200 && Array.isArray(ap.json.approvals)
      ? ap.json.approvals.filter((a) => typeof a?.sha256 === "string" && /^[0-9a-f]{64}$/.test(a.sha256) && (a.approved_by_role === "owner" || a.approved_by_role === "admin")).map((a) => a.sha256 as string)
      : (before?.approvals ?? []);
  const kept: Kept = { pid, at: Date.now(), skills, approvals };
  const d = pidDir(pid)!;
  mkdirSync(/*turbopackIgnore: true*/ d, { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ join(d, "index.json.tmp"), JSON.stringify(kept), { mode: 0o600 });
  renameSync(/*turbopackIgnore: true*/ join(d, "index.json.tmp"), join(d, "index.json"));
  entry(pid).kept = kept;
  // A version no longer listed goes from this computer.
  for (const s of before?.skills ?? []) if (!skills.some((x) => x.kind === s.kind && x.slug === s.slug && x.version === s.version)) {
    const dir = versionDir(pid, s.kind, s.slug, s.version);
    if (!dir) continue;
    rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
    // Its skill's folder too, once no version is left in it.
    if (existsSync(/*turbopackIgnore: true*/ dirname(dir)) && !readdirSync(/*turbopackIgnore: true*/ dirname(dir)).length) rmSync(/*turbopackIgnore: true*/ dirname(dir), { recursive: true, force: true });
  }
}

/** One version's files from Orgo's export, written under its folder here (fresh); its label as its SKILL.md says it. Null when any of it couldn't be read. */
async function fetchVersion(key: string, at: string, pid: string, id: string, kind: SkillKind, slug: string, version: string): Promise<{ label?: string; files: RunnerSkill["files"] } | null> {
  const { callOrgo } = await import("./orgo");
  const ex = await callOrgo<{ files?: Record<string, ExportFile>; version?: string }>(key, `${at}/${encodeURIComponent(id)}/export`, { timeoutMs: CALL_MS });
  if (!ex || ex.status !== 200 || !ex.json.files || ex.json.version !== version) return null;
  const md = ex.json.files["SKILL.md"]?.content;
  if (typeof md !== "string") return null;
  const parsed = parseSkillMd(md);
  const got = await Promise.all(
    Object.entries(ex.json.files)
      .filter(([p]) => p !== "SKILL.md")
      .map(async ([p, f]) => {
        const n = normalizePath(p);
        return "reason" in n || n.path !== p ? null : exportedFile(p, f, 30_000);
      }),
  );
  if (got.some((f) => f === null)) return null;
  const dir = versionDir(pid, kind, slug, version);
  if (!dir) return null;
  const tmp = `${dir}.tmp`;
  rmSync(/*turbopackIgnore: true*/ tmp, { recursive: true, force: true });
  mkdirSync(/*turbopackIgnore: true*/ tmp, { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ join(tmp, "SKILL.md"), md);
  const files: RunnerSkill["files"] = [];
  for (const f of got as NonNullable<(typeof got)[number]>[]) {
    const to = join(/*turbopackIgnore: true*/ tmp, f.path);
    if (!resolve(to).startsWith(resolve(tmp) + sep)) return null;
    const bytes = f.data ?? Buffer.from(f.content ?? "", "utf8");
    mkdirSync(dirname(to), { recursive: true });
    // Kept, never run from here: a script goes to the computer's skills folder runnable only once approved (shipped).
    writeFileSync(to, bytes, { mode: 0o644 });
    files.push({ path: f.path, sha256: sha256Hex(bytes), size: bytes.length, executable: f.executable, binary: f.content === null });
  }
  rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(/*turbopackIgnore: true*/ tmp, dir);
  const label = parsed.ok ? keptLabel(labelOf(parsed.frontmatter)) : undefined;
  return { ...(label ? { label } : {}), files };
}

/** Tests: forget what's kept in memory (the disk's copy stays) and when each workspace was last read. */
export function runnerSkillsForTests() {
  memo().clear();
}
