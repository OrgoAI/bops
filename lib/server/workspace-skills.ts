import "server-only";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MAIN_WORKSPACE, procedureKey, workBot, workspaceOf, type Procedure, type ScriptApproval, type SkillKind, type SkillRef, type SkillRisk, type Workspace } from "@/lib/types";
import {
  BUNDLE_LIMITS,
  RISKS,
  bundleSha,
  byteLength,
  checkFolder,
  freeSlug,
  isScript,
  junkReason,
  nextVersion,
  normalizePath,
  parseSkillMd,
  renderSkillMd,
  scanSecrets,
  sha256Hex,
  slugify,
  undeclaredSecrets,
  validateFrontmatter,
  type BundleFile,
  type FolderFile,
  type Problem,
} from "./skill-bundle";
import { bot, getState, update, userDir } from "./store";

/**
 * Skills and apps: a workspace's ways of doing a kind of job (skills) and the tools Bops built that bots
 * run (apps), each a folder in the Agent Skill shape (SKILL.md and its files). On the Mac the folders are
 * the source: <userDir>/workspaces/<id>/skills/<slug>/ and apps/<slug>/, where <id> is the workspace's
 * Orgo project once it has one (else its Bops id). The state keeps what each is (Workspace.skills,
 * Workspace.apps: SkillRef) so the window and the bots' prompts never read a folder to list them.
 *
 * Versions: the folder is what's being worked on (a draft); Publish copies it into
 * .versions/<skills|apps>/<slug>/<version>/ and the bots read that version; Roll back points them at an
 * older one. Scripts run only once someone approved their content (by sha256, so an unchanged script in
 * a new version stays approved). A bot sees only a skill's name and description until it reads one
 * (read_skill), and only the published skills of its own workspace whose bots include it (none named:
 * every bot). When orgo-web has the skills routes and the workspace has its Orgo project, they're kept
 * in step with Orgo (syncSkills); otherwise they stay on this Mac.
 */

/** Skills (and apps) per workspace, as orgo-web allows. */
export const MAX_SKILLS = 500;
/** At most this many are listed in a prompt (the most recently used or changed, when there are more). */
const NOTE_MAX = 15;
const NOTE_LINE_MAX = 220;
/** The most of a file read_skill gives a bot. */
const FILE_CAP = 20_000;

const g = globalThis as unknown as { bopsSkillsRoutes?: Map<string, boolean>; bopsSkillsSync?: Map<string, ReturnType<typeof setTimeout>>; bopsSkillsCopied?: Map<string, string> };

export class SkillError extends Error {
  status: number;
  problems?: Problem[];
  constructor(message: string, status = 400, problems?: Problem[]) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const listKey = (kind: SkillKind) => (kind === "app" ? "apps" : "skills") as "apps" | "skills";

/* ---------------- Where things are ---------------- */

/** The workspace by id, or undefined. */
export const workspaceById = (wsId: string): Workspace | undefined => getState().workspaces?.find((w) => w.id === wsId);

/** Its folder's name: the Orgo project's id once it has one, else its Bops id. Safe as a path either way. */
export const folderKey = (w: Pick<Workspace, "id" | "orgoProjectId">) => (w.orgoProjectId ?? w.id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";

/** <userDir>/workspaces, or null signed out on the Mac app. */
const workspacesRoot = () => {
  const root = userDir();
  return root === null ? null : join(/*turbopackIgnore: true*/ root, "workspaces");
};

/** A workspace's own folder, or null when there's nowhere to keep it. */
export function workspaceDir(wsId: string): string | null {
  const root = workspacesRoot();
  const w = workspaceById(wsId) ?? (wsId === MAIN_WORKSPACE ? { id: MAIN_WORKSPACE } : undefined);
  return root && w ? join(/*turbopackIgnore: true*/ root, folderKey(w)) : null;
}

/** The working folder of a skill or app. */
export function skillDir(wsId: string, kind: SkillKind, slug: string): string | null {
  const ws = workspaceDir(wsId);
  return ws ? join(/*turbopackIgnore: true*/ ws, listKey(kind), slug) : null;
}

const versionDir = (wsId: string, kind: SkillKind, slug: string, version: string) => {
  const ws = workspaceDir(wsId);
  return ws ? join(/*turbopackIgnore: true*/ ws, ".versions", listKey(kind), slug, version) : null;
};

/* ---------------- What's in the state ---------------- */

/** A workspace's skills and apps (both, or one kind), oldest first. */
export function refsOf(wsId: string, kind?: SkillKind): SkillRef[] {
  adoptProcedures();
  const w = workspaceById(wsId);
  if (!w) return [];
  return kind ? [...(w[listKey(kind)] ?? [])] : [...(w.skills ?? []), ...(w.apps ?? [])];
}

export const findRef = (wsId: string, kind: SkillKind, slug: string) => refsOf(wsId, kind).find((r) => r.slug === slug);

/** Change one ref in place (by workspace, kind and slug). */
function patchRef(wsId: string, kind: SkillKind, slug: string, fn: (r: SkillRef) => void) {
  update((s) => {
    const r = s.workspaces?.find((w) => w.id === wsId)?.[listKey(kind)]?.find((x) => x.slug === slug);
    if (r) fn(r);
  });
}

/** Whether a bot has a skill: its workspace's, and either every bot's or named for it. */
const forBot = (r: SkillRef, botId: string) => !r.botIds.length || r.botIds.includes(botId);

/** The skills and apps a bot can use now: its workspace's published ones that are for it. */
export function skillsFor(botId: string, kind?: SkillKind): SkillRef[] {
  const b = bot(botId);
  if (!b) return [];
  return refsOf(workspaceOf(b), kind).filter((r) => r.status === "published" && forBot(r, botId));
}

/** One of a bot's skills or apps: by slug, then the id it had as a procedure, then its name (case, spacing and dashes aside). */
export function findSkill(botId: string, nameOrSlug: string, { drafts = false } = {}): SkillRef | undefined {
  const b = bot(botId);
  if (!b) return undefined;
  const list = drafts ? refsOf(workspaceOf(b)).filter((r) => forBot(r, botId)) : skillsFor(botId);
  const want = nameOrSlug.trim().replace(/^["“']|["”']$/g, "");
  return list.find((r) => r.slug === want) ?? list.find((r) => r.legacyId === want) ?? list.find((r) => r.name === want) ?? list.find((r) => procedureKey(r.name) === procedureKey(want));
}

/** How a routine or a thread names the skill it follows: its old procedure id when it had one (so what named it before still does), else its slug. */
export const skillRefId = (r: SkillRef) => r.legacyId ?? r.slug;

/* ---------------- Files ---------------- */

type ReadTree = { files: FolderFile[]; tooMany: boolean };

/** Every file under `dir`, with paths relative to it. A link is followed only while it stays inside `dir`. */
function readTree(dir: string, max = BUNDLE_LIMITS.files * 4): ReadTree {
  const files: FolderFile[] = [];
  let tooMany = false;
  const top = realpathSync(/*turbopackIgnore: true*/ dir);
  const inside = (p: string) => p === top || p.startsWith(top + sep);
  const walk = (abs: string, depth: number) => {
    if (depth > BUNDLE_LIMITS.pathDepth) return;
    for (const name of readdirSync(/*turbopackIgnore: true*/ abs).sort()) {
      if (files.length >= max) {
        tooMany = true;
        return;
      }
      const full = join(/*turbopackIgnore: true*/ abs, name);
      const rel = relative(top, full).split(sep).join("/");
      let st = lstatSync(/*turbopackIgnore: true*/ full);
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(/*turbopackIgnore: true*/ full);
        } catch {
          files.push({ path: rel, content: null, executable: false, size: 0, link: "outside" });
          continue;
        }
        if (!inside(real)) {
          files.push({ path: rel, content: null, executable: false, size: 0, link: "outside" });
          continue;
        }
        st = statSync(/*turbopackIgnore: true*/ real);
      }
      if (st.isDirectory()) {
        // Junk folders aren't walked into: a node_modules or .git can hold thousands of files.
        if (junkReason(`${rel}/x`)) {
          files.push({ path: rel, content: "", executable: false, size: 0 });
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const executable = (st.mode & 0o111) !== 0;
      if (st.size > BUNDLE_LIMITS.file) {
        files.push({ path: rel, content: "", executable, size: st.size });
        continue;
      }
      const buf = readFileSync(/*turbopackIgnore: true*/ full);
      files.push({ path: rel, content: buf.includes(0) ? null : buf.toString("utf8"), executable, size: st.size });
    }
  };
  walk(top, 0);
  return { files, tooMany };
}

/** Write a bundle into `dir` (made fresh): SKILL.md and its files, scripts executable. */
function writeTree(dir: string, skillMd: string, files: { path: string; content: string; executable: boolean }[]) {
  rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  writeFileSync(join(/*turbopackIgnore: true*/ dir, "SKILL.md"), skillMd);
  for (const f of files) {
    const to = join(/*turbopackIgnore: true*/ dir, f.path);
    if (!resolve(to).startsWith(resolve(dir) + sep)) continue;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.content, { mode: f.executable ? 0o755 : 0o644 });
    if (f.executable) chmodSync(to, 0o755);
  }
}

export type Bundle = { frontmatter: Record<string, unknown>; body: string; skillMd: string; files: BundleFile[] };

/** A folder read as a bundle (SKILL.md split, the rest as files), or null when it isn't there. Junk is left out. */
function readBundle(dir: string | null): Bundle | null {
  if (!dir || !existsSync(/*turbopackIgnore: true*/ join(dir, "SKILL.md"))) return null;
  const { files } = readTree(dir);
  const md = files.find((f) => f.path === "SKILL.md")?.content ?? "";
  const parsed = parseSkillMd(md);
  const rest = files
    .filter((f) => f.path !== "SKILL.md" && f.content !== null && !f.link && !junkReason(f.path))
    .map((f) => ({ path: f.path, content: f.content!, sha256: sha256Hex(f.content!), size: byteLength(f.content!), executable: f.executable }));
  return { frontmatter: parsed.ok ? (parsed.frontmatter ?? {}) : {}, body: parsed.ok ? parsed.body : md, skillMd: md, files: rest };
}

/**
 * What a bot reads: the published version's folder (the working folder when that version isn't on this
 * Mac). A skill moved from a procedure on another Mac (the state came from Bops Cloud, its folder didn't)
 * is written again here from the procedure kept in the state.
 */
function publishedBundle(wsId: string, r: SkillRef): Bundle | null {
  if (r.version) {
    const v = readBundle(versionDir(wsId, r.kind, r.slug, r.version));
    if (v) return v;
  }
  return readBundle(skillDir(wsId, r.kind, r.slug)) ?? fromBackup(wsId, r);
}

/** A skill that was a procedure, its folder made again from the procedure kept in the state (proceduresBackup). */
function fromBackup(wsId: string, r: SkillRef): Bundle | null {
  const p = r.legacyId ? getState().proceduresBackup?.find((x) => x.id === r.legacyId) : undefined;
  const dir = skillDir(wsId, r.kind, r.slug);
  if (!p || !dir) return null;
  const body = procedureBody(p);
  try {
    const md = renderSkillMd(frontmatterOf(r.slug, r.description), body);
    writeTree(dir, md, []);
    if (r.version) writeTree(versionDir(wsId, r.kind, r.slug, r.version)!, renderSkillMd({ ...frontmatterOf(r.slug, r.description), version: r.version }, body), []);
  } catch (e) {
    console.warn(`[skills] writing ${r.slug} again from its procedure: ${(e as Error).message}`);
    return null;
  }
  return readBundle(r.version ? versionDir(wsId, r.kind, r.slug, r.version) : dir);
}

/* ---------------- Checks ---------------- */

type FileIn = { path: string; content: string; executable?: boolean };

/** Files as a save sends them, checked strictly: a bad path, junk, a cap or any secret refuses the whole skill. */
function checkFiles(body: string, files: FileIn[]): { files: BundleFile[]; warnings: Problem[] } {
  const errors: Problem[] = [];
  const out: BundleFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const n = normalizePath(f.path);
    if ("reason" in n) {
      errors.push({ path: String(f.path).slice(0, 200), reason: n.reason });
      continue;
    }
    if (n.path === "SKILL.md") {
      errors.push({ path: n.path, reason: "SKILL.md is the skill itself, not one of its files" });
      continue;
    }
    const junk = junkReason(n.path);
    if (junk) {
      errors.push({ path: n.path, reason: junk });
      continue;
    }
    if (seen.has(n.path)) {
      errors.push({ path: n.path, reason: "path appears twice" });
      continue;
    }
    seen.add(n.path);
    if (typeof f.content !== "string" || f.content.includes("\u0000")) {
      errors.push({ path: n.path, reason: "only text files are kept" });
      continue;
    }
    if (byteLength(f.content) > BUNDLE_LIMITS.file) {
      errors.push({ path: n.path, reason: `file is over ${BUNDLE_LIMITS.file / 1024} KB` });
      continue;
    }
    errors.push(...scanSecrets(n.path, f.content));
    out.push({ path: n.path, content: f.content, sha256: sha256Hex(f.content), size: byteLength(f.content), executable: !!f.executable });
  }
  errors.push(...scanSecrets("SKILL.md", body));
  if (byteLength(body) > BUNDLE_LIMITS.body) errors.push({ path: "SKILL.md", reason: `body is over ${BUNDLE_LIMITS.body / 1024} KB` });
  if (out.length + 1 > BUNDLE_LIMITS.files) errors.push({ path: "", reason: `a skill holds ${BUNDLE_LIMITS.files} files at most` });
  if (out.reduce((n, f) => n + f.size, byteLength(body)) > BUNDLE_LIMITS.total) errors.push({ path: "", reason: `a skill is ${BUNDLE_LIMITS.total / 1024 / 1024} MB at most` });
  if (errors.length) {
    const secret = errors.some((e) => e.reason.startsWith("secret:"));
    throw new SkillError(secret ? "That has a secret in it. Use the key's vault name instead ($NAME, listed in requires_secrets)." : "Some files can't be kept.", secret ? 422 : 400, errors);
  }
  return { files: out, warnings: [] };
}

/** The frontmatter a skill is written with: name (its slug) and description, then what it says of itself. */
function frontmatterOf(slug: string, description: string, extra: Record<string, unknown> = {}) {
  const fm: Record<string, unknown> = { ...extra, name: slug, description };
  delete fm.version;
  return fm;
}

const riskOf = (fm: Record<string, unknown>): SkillRisk | undefined => ((RISKS as readonly unknown[]).includes(fm.risk) ? (fm.risk as SkillRisk) : undefined);
const runsOnOf = (fm: Record<string, unknown>) => (typeof fm.runs_on === "string" ? fm.runs_on : undefined);

/* ---------------- Making and changing them ---------------- */

export type NewSkill = {
  kind?: SkillKind;
  name: string;
  description: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  files?: FileIn[];
  botIds?: string[];
  source?: SkillRef["source"];
  status?: "draft" | "published";
  from?: SkillRef["from"];
  legacyId?: string;
  /** For one from before (a procedure): when it was made and used. */
  times?: { createdAt: number; updatedAt: number; uses?: number; usedAt?: number };
};

/** The bots in a workspace, by id. */
const teamIds = (wsId: string) => new Set(getState().bots.filter((b) => workspaceOf(b) === wsId).map((b) => b.id));

/**
 * A new skill or app in a workspace: written to its folder, and listed. Checked strictly (no secrets,
 * no junk, the caps). A draft unless `status` says published (then its first version is published too).
 */
export function createSkill(wsId: string, input: NewSkill): { ref: SkillRef; warnings: Problem[] } {
  const w = workspaceById(wsId);
  if (!w) throw new SkillError("That workspace is gone.", 404);
  const kind = input.kind ?? "skill";
  const name = cut(oneLine(input.name ?? ""), 120);
  const description = oneLine(input.description ?? "");
  if (!/[\p{L}\p{N}]/u.test(name)) throw new SkillError(`A ${kind} needs a name.`);
  if (!description) throw new SkillError("Say what it does and when to use it.");
  if (description.length > BUNDLE_LIMITS.description) throw new SkillError(`The description is ${BUNDLE_LIMITS.description} characters at most.`);
  if (refsOf(wsId).length >= MAX_SKILLS) throw new SkillError(`A workspace holds ${MAX_SKILLS} skills and apps at most. Delete one to add another.`, 409);
  const body = (input.body ?? "").replace(/\r\n?/g, "\n");
  if (!body.trim()) throw new SkillError(`A ${kind} needs its SKILL.md text.`);
  const extra = input.frontmatter ?? {};
  const problems = validateFrontmatter(extra);
  if (problems.length) throw new SkillError("The frontmatter has a problem.", 400, problems);
  const { files } = checkFiles(body, input.files ?? []);
  const dir0 = workspaceDir(wsId);
  if (!dir0) throw new SkillError("Sign in to keep skills.", 401);
  const fmSlug = typeof extra.name === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(extra.name) ? extra.name : slugify(name);
  const slug = freeSlug(fmSlug, refsOf(wsId, kind).map((r) => r.slug));
  const fm = frontmatterOf(slug, description, extra);
  const skillMd = renderSkillMd(fm, body);
  writeTree(skillDir(wsId, kind, slug)!, skillMd, files);
  const team = teamIds(wsId);
  const now = Date.now();
  const ref: SkillRef = {
    slug,
    kind,
    name,
    description,
    status: "draft",
    botIds: [...new Set(input.botIds ?? [])].filter((id) => team.has(id)),
    source: input.source ?? "bops",
    createdAt: input.times?.createdAt ?? now,
    updatedAt: input.times?.updatedAt ?? now,
    ...(riskOf(fm) ? { risk: riskOf(fm) } : {}),
    ...(runsOnOf(fm) ? { runsOn: runsOnOf(fm) } : {}),
    ...(input.legacyId ? { legacyId: input.legacyId } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.times?.uses ? { uses: input.times.uses } : {}),
    ...(input.times?.usedAt ? { usedAt: input.times.usedAt } : {}),
  };
  update((s) => {
    const ws = s.workspaces?.find((x) => x.id === wsId);
    if (ws) (ws[listKey(kind)] ??= []).push(ref);
  });
  if (input.status === "published") publishSkill(wsId, kind, slug, { version: typeof extra.version === "string" ? extra.version : undefined });
  const warnings = undeclaredSecrets([{ path: "SKILL.md", content: body }, ...files], Array.isArray(fm.requires_secrets) ? (fm.requires_secrets as string[]) : []);
  return { ref: findRef(wsId, kind, slug)!, warnings };
}

export type SkillEdit = { name?: string; description?: string; body?: string; files?: FileIn[]; botIds?: string[] };

/**
 * Change a skill: its name, description or SKILL.md text in its folder (a draft of the next version;
 * the bots keep reading the published one until it's published), or which bots have it.
 */
export function updateSkill(wsId: string, kind: SkillKind, slug: string, edit: SkillEdit): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const dir = skillDir(wsId, kind, slug);
  const now = readBundle(dir);
  const name = edit.name !== undefined ? cut(oneLine(edit.name), 120) : r.name;
  const description = edit.description !== undefined ? oneLine(edit.description) : r.description;
  if (!/[\p{L}\p{N}]/u.test(name)) throw new SkillError(`A ${kind} needs a name.`);
  if (!description) throw new SkillError("Say what it does and when to use it.");
  if (description.length > BUNDLE_LIMITS.description) throw new SkillError(`The description is ${BUNDLE_LIMITS.description} characters at most.`);
  const changesFolder = edit.body !== undefined || edit.files !== undefined || edit.description !== undefined;
  if (changesFolder) {
    const body = (edit.body ?? now?.body ?? "").replace(/\r\n?/g, "\n");
    if (!body.trim()) throw new SkillError(`A ${kind} needs its SKILL.md text.`);
    const files = edit.files ?? now?.files ?? [];
    const checked = checkFiles(body, files);
    const fm = frontmatterOf(slug, description, now?.frontmatter ?? {});
    writeTree(dir!, renderSkillMd(fm, body), checked.files);
  }
  const team = teamIds(wsId);
  patchRef(wsId, kind, slug, (x) => {
    x.name = name;
    x.description = description;
    if (edit.botIds) x.botIds = [...new Set(edit.botIds)].filter((id) => team.has(id));
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/** Give a bot a skill, or take it away. Taking the last named bot away would give it to every bot, so that's refused. */
export function setSkillBot(wsId: string, kind: SkillKind, slug: string, botId: string, on: boolean): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const team = teamIds(wsId);
  if (!team.has(botId)) throw new SkillError("That bot isn't in this workspace.", 404);
  // Every bot has it (none named): taking one away names all the others.
  const now = r.botIds.length ? r.botIds : [...team];
  const next = on ? [...new Set([...now, botId])] : now.filter((x) => x !== botId);
  if (!next.length) throw new SkillError("At least one bot keeps it. Delete it instead.");
  patchRef(wsId, kind, slug, (x) => {
    // Every bot named is the same as none: kept as none, so a new bot gets it too.
    x.botIds = [...team].every((id) => next.includes(id)) ? [] : next;
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/** Publish what's in the folder as a new version (the next patch unless `version` says): its bots read it from now on. */
export function publishSkill(wsId: string, kind: SkillKind, slug: string, opts: { version?: string } = {}): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const b = readBundle(skillDir(wsId, kind, slug));
  if (!b) throw new SkillError(`Its folder is gone from this Mac. Delete it, or import the folder again.`, 404);
  // Checked again: the folder may have been changed in Finder since.
  checkFiles(b.body, b.files);
  const versions = r.versions ?? [];
  const version = opts.version ?? nextVersion(versions.map((v) => v.version));
  if (versions.some((v) => v.version === version)) throw new SkillError(`Version ${version} is already published.`, 409);
  const fm = frontmatterOf(slug, r.description, b.frontmatter);
  const skillMd = renderSkillMd({ ...fm, version }, b.body);
  const sha = bundleSha(skillMd, b.files);
  const last = versions.find((v) => v.version === r.version);
  if (last && last.sha256 === bundleSha(renderSkillMd({ ...fm, version: last.version }, b.body), b.files)) throw new SkillError(`Nothing changed since ${last.version}.`, 409);
  writeTree(versionDir(wsId, kind, slug, version)!, skillMd, b.files);
  patchRef(wsId, kind, slug, (x) => {
    x.versions = [...versions, { version, at: Date.now(), sha256: sha }];
    x.version = version;
    x.status = "published";
    x.risk = riskOf(b.frontmatter) ?? x.risk;
    x.runsOn = runsOnOf(b.frontmatter) ?? x.runsOn;
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/** Point its bots back at an older version (nothing's deleted: rolling forward is another roll back). */
export function rollbackSkill(wsId: string, kind: SkillKind, slug: string, version: string): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  if (!r.versions?.some((v) => v.version === version)) throw new SkillError(`It has no version ${version}.`, 404);
  const dir = versionDir(wsId, kind, slug, version);
  if (!dir || !existsSync(/*turbopackIgnore: true*/ dir)) throw new SkillError(`Version ${version} isn't on this Mac.`, 404);
  // The folder goes back to that version too, so what's worked on next starts from it.
  cpSync(/*turbopackIgnore: true*/ dir, skillDir(wsId, kind, slug)!, { recursive: true, force: true });
  patchRef(wsId, kind, slug, (x) => {
    x.version = version;
    x.status = "published";
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/** Delete a skill or app: its folder and versions on this Mac, and Orgo's copy. */
export async function deleteSkill(wsId: string, kind: SkillKind, slug: string): Promise<boolean> {
  const r = findRef(wsId, kind, slug);
  if (!r) return false;
  update((s) => {
    const ws = s.workspaces?.find((w) => w.id === wsId);
    if (ws) ws[listKey(kind)] = (ws[listKey(kind)] ?? []).filter((x) => x.slug !== slug);
  });
  for (const d of [skillDir(wsId, kind, slug), workspaceDir(wsId) && join(/*turbopackIgnore: true*/ workspaceDir(wsId)!, ".versions", listKey(kind), slug)])
    if (d) rmSync(/*turbopackIgnore: true*/ d, { recursive: true, force: true });
  if (r.remoteId) await remoteDelete(wsId, r.remoteId).catch((e: Error) => console.warn(`[skills] deleting Orgo's copy: ${e.message}`));
  return true;
}

/** A bot is gone: off every skill that named it; one only it had goes with it. */
export function dropBotFromSkills(botId: string, wsId: string) {
  for (const r of refsOf(wsId)) {
    if (!r.botIds.includes(botId)) continue;
    if (r.botIds.length === 1) void deleteSkill(wsId, r.kind, r.slug);
    else patchRef(wsId, r.kind, r.slug, (x) => (x.botIds = x.botIds.filter((id) => id !== botId)));
  }
}

/* ---------------- Reading them ---------------- */

export type SkillFileInfo = { path: string; size: number; sha256: string; executable: boolean; script: boolean; approved: boolean };

const approvedIn = (wsId: string) => new Set((workspaceById(wsId)?.approvals ?? []).map((a) => a.sha256));

/** A skill as the window shows it: its SKILL.md (a version, else what's being worked on), its files, and where its folder is. */
export function skillDetail(wsId: string, kind: SkillKind, slug: string, version?: string) {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const dir = skillDir(wsId, kind, slug);
  const b = version ? readBundle(versionDir(wsId, kind, slug, version)) : readBundle(dir);
  const approved = approvedIn(wsId);
  const files: SkillFileInfo[] = (b?.files ?? []).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, executable: f.executable, script: isScript(f), approved: approved.has(f.sha256) }));
  // What changed in the folder since the version the bots read.
  const pub = r.version ? readBundle(versionDir(wsId, kind, slug, r.version)) : null;
  const changed = !!b && !!pub && !version && (pub.body !== b.body || pub.files.map((f) => `${f.path}:${f.sha256}`).join() !== b.files.map((f) => `${f.path}:${f.sha256}`).join());
  return { ref: r, body: b?.body ?? "", frontmatter: b?.frontmatter ?? {}, files, dir, missing: !b, changed };
}

/** One file's text, for the window (Approve shows the script it approves). */
export function skillFile(wsId: string, kind: SkillKind, slug: string, path: string, version?: string): { path: string; content: string; sha256: string } {
  const n = normalizePath(path);
  if ("reason" in n) throw new SkillError(n.reason);
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const b = version ? readBundle(versionDir(wsId, kind, slug, version)) : readBundle(skillDir(wsId, kind, slug));
  const f = b?.files.find((x) => x.path === n.path);
  if (!f) throw new SkillError("That file isn't in it.", 404);
  return { path: f.path, content: f.content, sha256: f.sha256 };
}

/** Approve a script's content to run in this workspace (by its sha256). Only content that's in one of its skills can be. */
export function approveScript(wsId: string, sha256: string, on = true): ScriptApproval[] {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SkillError("That isn't a script's sha256.");
  const where = refsOf(wsId)
    .flatMap((r) => [readBundle(skillDir(wsId, r.kind, r.slug)), r.version ? readBundle(versionDir(wsId, r.kind, r.slug, r.version)) : null])
    .flatMap((b) => b?.files ?? [])
    .find((f) => f.sha256 === sha256);
  if (on && !where) throw new SkillError("No script in this workspace has that content.", 404);
  update((s) => {
    const ws = s.workspaces?.find((w) => w.id === wsId);
    if (!ws) return;
    const rest = (ws.approvals ?? []).filter((a) => a.sha256 !== sha256);
    ws.approvals = on ? [...rest, { sha256, path: where!.path, at: Date.now() }] : rest;
  });
  return workspaceById(wsId)?.approvals ?? [];
}

/** Where a bot finds its skills on its computer (sessions.ts copies them there). */
export const COMPUTER_SKILLS = "/workspace/capabilities/skills";
export const COMPUTER_APPS = "/workspace/capabilities/apps";

/**
 * read_skill: a skill or app in full for a bot about to do a job (its SKILL.md body and the list of its
 * files, a read counted as a use), or one file of it with `file`. When there's none by that name, it
 * says so and lists the bot's own.
 */
export function readSkill(botId: string, nameOrSlug: string, file?: string | null): string {
  const b = bot(botId);
  if (!b) return "Unknown bot.";
  const r = findSkill(botId, nameOrSlug);
  if (!r) {
    const names = skillsFor(botId).map((x) => `"${x.name}"`);
    const asked = cut(oneLine(nameOrSlug), 80);
    return names.length ? `No skill called "${asked}". Yours are: ${names.join(", ")}.` : `No skill called "${asked}". You have none yet.`;
  }
  const wsId = workspaceOf(b);
  const bundle = publishedBundle(wsId, r);
  if (!bundle) return `"${r.name}" isn't on this Mac right now.`;
  if (file?.trim()) {
    const n = normalizePath(file.trim());
    const f = "reason" in n ? undefined : bundle.files.find((x) => x.path === n.path);
    if (!f) return `"${r.name}" has no file ${cut(oneLine(file), 120)}. Its files: ${bundle.files.map((x) => x.path).join(", ") || "none"}.`;
    return `${r.name}, ${f.path}:\n${f.content.length > FILE_CAP ? `${f.content.slice(0, FILE_CAP)}\n(cut short)` : f.content}`;
  }
  const at = Date.now();
  patchRef(wsId, r.kind, r.slug, (x) => {
    x.uses = (x.uses ?? 0) + 1;
    x.usedAt = at;
  });
  const approved = approvedIn(wsId);
  const base = r.kind === "app" ? COMPUTER_APPS : COMPUTER_SKILLS;
  const files = bundle.files.map((f) => `- ${f.path}${isScript(f) ? (approved.has(f.sha256) ? " (script, approved)" : " (script, not approved yet: ask to have it approved on the Skills page before running it)") : ""}`);
  return [
    `${r.kind === "app" ? "App" : "Skill"}: ${r.name}${r.version ? ` (version ${r.version})` : ""}`,
    bundle.body.trim(),
    files.length ? `Its files (read one with read_skill and file; on your computer they're in ${base}/${r.slug}/):\n${files.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A skill's SKILL.md body as its bot follows it (a routine's, a thread's), without counting a use. Empty when it isn't on this Mac. */
export function skillText(botId: string, r: SkillRef): string {
  const b = bot(botId);
  const bundle = b ? publishedBundle(workspaceOf(b), r) : null;
  return bundle ? `${r.kind === "app" ? "App" : "Skill"}: ${r.name}\n\n${bundle.body.trim()}` : "";
}

/** Count a use of a skill (a thread or a routine's run that follows it, once per run). */
export function countUse(botId: string, r: SkillRef) {
  const b = bot(botId);
  if (!b) return;
  patchRef(workspaceOf(b), r.kind, r.slug, (x) => {
    x.uses = (x.uses ?? 0) + 1;
    x.usedAt = Date.now();
  });
}

/** When it last mattered: read for a job, or changed. */
const lastTouched = (r: SkillRef) => Math.max(r.usedAt ?? 0, r.updatedAt);

/**
 * The list for a bot's prompts: each skill and app it has (name and description), and how to read one.
 * With more than NOTE_MAX, the most recently used or changed. In the order they were made, so a read
 * doesn't reorder the list and the prompt's lead stays cached. Empty when it has none.
 */
export function skillsNote(botId: string): string {
  const all = skillsFor(botId);
  if (!all.length) return "";
  const picked = all.length > NOTE_MAX ? [...all].sort((a, b) => lastTouched(b) - lastTouched(a) || (b.uses ?? 0) - (a.uses ?? 0)).slice(0, NOTE_MAX) : all;
  const shown = [...picked].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  const more = all.length - shown.length;
  const line = (r: SkillRef) => `- ${cut(`${r.name}: ${r.description}`, NOTE_LINE_MAX)}`;
  const skills = shown.filter((r) => r.kind === "skill");
  const apps = shown.filter((r) => r.kind === "app");
  return [
    "Your skills: how your workspace does jobs it was shown before. When a job fits one, read it with read_skill first and follow it; tell the user if a step no longer works.",
    ...skills.map(line),
    ...(apps.length ? ["Apps you can run on your computer (read one with read_skill before running it):", ...apps.map(line)] : []),
    ...(more > 0 ? [`(${more} more. read_skill with a name not listed here gives all their names.)`] : []),
  ].join("\n");
}

/** The tool a bot reads its skills with. */
export const READ_SKILL_TOOL = {
  type: "function" as const,
  name: "read_skill",
  description: "Read one of your skills or apps in full (they're listed under Your skills) before a job it fits, then follow it. With file, read one of its files.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "file"],
    properties: {
      name: { type: "string", description: "Its name, as listed." },
      file: { type: ["string", "null"], description: "One of its files (scripts/check.sh), or null for the skill itself." },
    },
  },
};

/* ---------------- Importing a folder ---------------- */

export type ImportResult = { ref: SkillRef; skipped: Problem[]; warnings: Problem[]; drafted: boolean };

/**
 * A folder on this Mac (picked in Finder) taken in as a new draft: checked the way orgo-web's importer
 * checks one (junk and links out of the folder skipped, a file holding a secret left out and listed by
 * path, line and kind, never its text; no SKILL.md, and README.md or SPEC.md is drafted from).
 */
export function importFolder(wsId: string, folder: string, kind: SkillKind = "skill"): ImportResult {
  if (!workspaceById(wsId)) throw new SkillError("That workspace is gone.", 404);
  let st;
  try {
    st = statSync(/*turbopackIgnore: true*/ folder);
  } catch {
    throw new SkillError("That folder isn't there.", 404);
  }
  if (!st.isDirectory()) throw new SkillError("Pick a folder.");
  const tree = readTree(folder);
  if (tree.tooMany) throw new SkillError(`That folder has more than ${BUNDLE_LIMITS.files * 4} files. Pick the skill's own folder.`);
  const name = folder.split(sep).filter(Boolean).pop() ?? "skill";
  const checked = checkFolder(tree.files, { folderName: name });
  if (!checked.ok) throw new SkillError("That folder can't be imported.", checked.errors.some((e) => e.reason.startsWith("secret:")) ? 422 : 400, [...checked.errors, ...checked.skipped]);
  const extra = { ...checked.frontmatter, name: checked.slugBase };
  const { ref } = createSkill(wsId, {
    kind,
    name: checked.name,
    description: checked.description,
    body: checked.body,
    frontmatter: extra,
    files: checked.files.map((f) => ({ path: f.path, content: f.content, executable: f.executable })),
    source: "import",
    status: "draft",
  });
  return { ref, skipped: checked.skipped, warnings: checked.warnings, drafted: checked.drafted };
}

/* ---------------- Procedures from before ---------------- */

/** A procedure as SKILL.md text: when to use it, its steps, its pitfalls. */
export function procedureBody(p: Pick<Procedure, "name" | "whenToUse" | "steps" | "pitfalls">): string {
  return [`# ${p.name}`, "", "## When to use", "", p.whenToUse, "", "## Steps", "", p.steps, ...(p.pitfalls?.trim() ? ["", "## Pitfalls", "", p.pitfalls] : []), ""].join("\n");
}

let adopting = false;

/**
 * Procedures from before skills (state.procedures) become skills of their bot's workspace, for that bot
 * only and published, keeping their uses; routines and threads that named one still find it (legacyId).
 * What was there is kept: in the state (proceduresBackup) and as procedures-backup.json beside the
 * workspaces' folders. Safe to run again: one already moved isn't moved twice. Nothing happens while
 * there's nowhere to keep the folders (signed out on the Mac).
 */
export function adoptProcedures(): number {
  const list = getState().procedures;
  if (!list?.length || adopting) return 0;
  const root = workspacesRoot();
  if (root === null) return 0;
  adopting = true;
  let moved = 0;
  try {
    mkdirSync(/*turbopackIgnore: true*/ root, { recursive: true });
    const backupFile = join(/*turbopackIgnore: true*/ root, "procedures-backup.json");
    let kept: Procedure[] = [];
    try {
      kept = JSON.parse(readFileSync(/*turbopackIgnore: true*/ backupFile, "utf8"));
    } catch {}
    // What was kept first stays: a procedure by an id already moved (a stale copy from another Mac) doesn't replace it.
    const backup = [...kept, ...list.filter((p) => !kept.some((k) => k.id === p.id))];
    writeFileSync(/*turbopackIgnore: true*/ backupFile, JSON.stringify(backup, null, 1));
    for (const p of list) {
      const b = bot(p.botId);
      if (!b) continue;
      const wsId = workspaceOf(b);
      if (!workspaceById(wsId)) update((s) => void (s.workspaces ??= []).push({ id: wsId, name: wsId === MAIN_WORKSPACE ? "Main" : "Workspace", createdAt: 0 }));
      if ((workspaceById(wsId)?.skills ?? []).some((r) => r.legacyId === p.id)) continue;
      try {
        createSkill(wsId, {
          name: p.name,
          description: p.whenToUse || p.name,
          body: procedureBody(p),
          botIds: [p.botId],
          source: "procedure",
          status: "published",
          legacyId: p.id,
          ...(p.from ? { from: p.from } : {}),
          times: { createdAt: p.createdAt, updatedAt: p.updatedAt, uses: p.uses, usedAt: p.usedAt },
        });
        moved++;
      } catch (e) {
        console.warn(`[skills] procedure ${p.id.slice(0, 12)} kept in the backup only: ${(e as Error).message}`);
      }
    }
    update((s) => {
      const had = s.proceduresBackup ?? [];
      s.proceduresBackup = [...had, ...list.filter((p) => !had.some((k) => k.id === p.id))];
      s.procedures = (s.procedures ?? []).filter((p) => !list.some((x) => x.id === p.id));
    });
  } finally {
    adopting = false;
  }
  return moved;
}

/* ---------------- On a computer ---------------- */

/**
 * What goes in a task's skills folder: the bot's published skills (and apps), each as its folder. On a
 * computer several workspaces' bots share (the free one), the skills of every bot that works there.
 */
function bundlesFor(botIds: string[]): { kind: SkillKind; slug: string; bundle: Bundle; wsId: string }[] {
  const out: { kind: SkillKind; slug: string; bundle: Bundle; wsId: string }[] = [];
  const taken = new Set<string>();
  for (const id of botIds) {
    const b = bot(id);
    if (!b) continue;
    const wsId = workspaceOf(b);
    for (const r of skillsFor(id)) {
      const key = `${r.kind}:${wsId}:${r.slug}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const bundle = publishedBundle(wsId, r);
      if (!bundle) continue;
      // Two workspaces with the same slug on one computer: the later one's folder gets a number.
      const slug = freeSlug(r.slug, out.filter((x) => x.kind === r.kind).map((x) => x.slug));
      out.push({ kind: r.kind, slug, bundle, wsId });
    }
  }
  return out;
}

/**
 * The bots whose work lands on this bot's computer: everyone sharing it (workBot), in the same order
 * whoever asks (so the computer's folders are the same set, named the same, for each of them).
 */
function sharers(botId: string): string[] {
  const bots = getState().bots;
  const me = bot(botId);
  if (!me) return [];
  const host = workBot(me, bots);
  return bots.filter((x) => workBot(x, bots).id === host.id).map((x) => x.id);
}

/**
 * The bot's skills as folders in `dir` for a task on this Mac (made when missing; the task's folder is
 * fresh each run), and its apps beside it (`../apps`). Scripts not approved yet aren't executable.
 */
export function writeSkillFiles(botId: string, dir: string): void {
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  const b = bot(botId);
  if (!b) return;
  const approved = approvedIn(workspaceOf(b));
  for (const x of bundlesFor([botId])) {
    const to = x.kind === "app" ? join(/*turbopackIgnore: true*/ dirname(dir), "apps", x.slug) : join(/*turbopackIgnore: true*/ dir, x.slug);
    writeTree(to, x.bundle.skillMd, x.bundle.files.map((f) => ({ ...f, executable: f.executable && approved.has(f.sha256) })));
  }
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The bot's skills and apps copied to its Orgo computer, fresh: /workspace/capabilities/skills/<slug>/
 * and capabilities/apps/<slug>/ (on a shared computer, every sharer's). Scripts nobody approved yet
 * arrive without their executable bit. Sent in pieces small enough for one bash call each.
 */
export async function copySkillsToComputer(botId: string, computerId: string, bash: (computerId: string, command: string, timeout?: number) => Promise<{ output: string; exit_code: number }>) {
  const team = sharers(botId);
  const bundles = bundlesFor(team);
  // Nothing to copy and nothing copied there before (by this server, or as far as it knows): nothing to clear either.
  const approved = new Set(team.flatMap((id) => [...approvedIn(workspaceOf(bot(id)))]));
  const copied = (g.bopsSkillsCopied ??= new Map());
  const sig = sha256Hex(JSON.stringify(bundles.map((x) => [x.kind, x.slug, x.bundle.skillMd, x.bundle.files.map((f) => [f.path, f.sha256, f.executable && approved.has(f.sha256)])])));
  if ((!bundles.length && !copied.has(computerId)) || copied.get(computerId) === sig) return bundles.length;
  const lines: string[] = [`rm -rf ${COMPUTER_SKILLS} ${COMPUTER_APPS}`, `mkdir -p ${COMPUTER_SKILLS} ${COMPUTER_APPS}`];
  for (const x of bundles) {
    const base = `${x.kind === "app" ? COMPUTER_APPS : COMPUTER_SKILLS}/${x.slug}`;
    for (const f of [{ path: "SKILL.md", content: x.bundle.skillMd, executable: false, sha256: "" }, ...x.bundle.files]) {
      const to = `${base}/${f.path}`;
      lines.push(`mkdir -p ${shQuote(dirname(to))} && printf %s ${shQuote(Buffer.from(f.content).toString("base64"))} | base64 -d > ${shQuote(to)}${f.executable && approved.has(f.sha256) ? ` && chmod 755 ${shQuote(to)}` : ""}`);
    }
  }
  const chunks: string[][] = [[]];
  let size = 0;
  for (const l of lines) {
    if (size + l.length > 200_000 && chunks[chunks.length - 1].length) {
      chunks.push([]);
      size = 0;
    }
    chunks[chunks.length - 1].push(l);
    size += l.length;
  }
  copied.delete(computerId);
  for (const c of chunks) {
    const r = await bash(computerId, ["set -e", ...c].join("\n"), 60);
    if (r.exit_code !== 0) throw new Error(`copying skills: ${r.output.slice(0, 200)}`);
  }
  copied.set(computerId, sig);
  return bundles.length;
}

/* ---------------- Moving a workspace's folder ---------------- */

/**
 * A workspace got its Orgo project: its folder moves from <wsId> to <projectId> (folderKey). When the
 * new one is already there (another Mac synced into it), the two merge by slug: what's already there stays.
 */
export function moveWorkspaceFolder(fromKey: string, toKey: string) {
  const root = workspacesRoot();
  if (!root || fromKey === toKey) return;
  const from = join(/*turbopackIgnore: true*/ root, fromKey);
  const to = join(/*turbopackIgnore: true*/ root, toKey);
  if (!existsSync(/*turbopackIgnore: true*/ from)) return;
  if (!existsSync(/*turbopackIgnore: true*/ to)) {
    mkdirSync(/*turbopackIgnore: true*/ root, { recursive: true });
    renameSync(/*turbopackIgnore: true*/ from, to);
    return;
  }
  for (const sub of ["skills", "apps", join(".versions", "skills"), join(".versions", "apps")]) {
    const a = join(/*turbopackIgnore: true*/ from, sub);
    if (!existsSync(/*turbopackIgnore: true*/ a)) continue;
    for (const slug of readdirSync(/*turbopackIgnore: true*/ a)) {
      const dest = join(/*turbopackIgnore: true*/ to, sub, slug);
      if (existsSync(/*turbopackIgnore: true*/ dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(/*turbopackIgnore: true*/ join(a, slug), dest);
    }
  }
  rmSync(/*turbopackIgnore: true*/ from, { recursive: true, force: true });
}

/* ---------------- In step with Orgo ---------------- */

type RemoteSkill = { id: string; slug: string; name: string; description: string | null; type: string; status: string; bot_ids?: string[]; updated_at: string; current_version?: { version?: string } | null };

const remoteType = (kind: SkillKind) => (kind === "app" ? "software" : "skill");
const localKind = (type: string): SkillKind => (type === "software" || type === "app" ? "app" : "skill");

/** One call to orgo-web's skills routes for a workspace, with the signed-in key. Null when Orgo didn't answer. */
async function skillsCall<T>(projectId: string, path: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {}) {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  return callOrgo<T>(key, `/api/workspaces/${encodeURIComponent(projectId)}/skills${path}`, { ...init, timeoutMs: 20_000 });
}

/** Whether this Orgo has the skills routes, per project (an Orgo without them answers 404 or 405, not JSON with skills). */

const routes = (g.bopsSkillsRoutes ??= new Map());

async function remoteDelete(wsId: string, remoteId: string) {
  const pid = workspaceById(wsId)?.orgoProjectId;
  if (!pid || routes.get(pid) === false) return;
  await skillsCall(pid, `/${encodeURIComponent(remoteId)}`, { method: "DELETE" });
}

/** What a skill's folder sends Orgo: its SKILL.md text and files. */
function payloadOf(wsId: string, r: SkillRef) {
  const b = r.version ? (readBundle(versionDir(wsId, r.kind, r.slug, r.version)) ?? readBundle(skillDir(wsId, r.kind, r.slug))) : readBundle(skillDir(wsId, r.kind, r.slug));
  if (!b) return null;
  return { body: renderSkillMd(frontmatterOf(r.slug, r.description, b.frontmatter), b.body), files: b.files.map((f) => ({ path: f.path, content: f.content, executable: f.executable })) };
}

export type SyncResult = { mode: "local" | "orgo"; pushed: number; pulled: number; failed: number };

/**
 * Keep a workspace's skills in step with Orgo's (GET/POST/PATCH /api/workspaces/{project}/skills), keyed
 * by slug, the later change winning (Orgo's updated_at against this Mac's updatedAt): a skill only here
 * goes to Orgo, one only on Orgo comes here, one changed on both sides takes the later. A workspace with
 * no Orgo project, or an Orgo without the routes, stays local and nothing is sent.
 */
export async function syncSkills(wsId: string): Promise<SyncResult> {
  const res: SyncResult = { mode: "local", pushed: 0, pulled: 0, failed: 0 };
  const pid = workspaceById(wsId)?.orgoProjectId;
  if (!pid || routes.get(pid) === false || !workspaceDir(wsId)) return res;
  const got = await skillsCall<{ skills?: RemoteSkill[] }>(pid, "");
  if (!got || got.status === 401) return res;
  if (got.status === 404 || got.status === 405 || !Array.isArray(got.json.skills)) {
    if (got.status === 404 || got.status === 405) routes.set(pid, false);
    return res;
  }
  routes.set(pid, true);
  res.mode = "orgo";
  const remote = got.json.skills;
  const local = refsOf(wsId);
  for (const r of local) {
    const there = remote.find((x) => (r.remoteId ? x.id === r.remoteId : x.slug === r.slug && localKind(x.type) === r.kind));
    try {
      if (!there) {
        // Only here: made on Orgo with its current text.
        const p = payloadOf(wsId, r);
        if (!p) continue;
        const made = await skillsCall<{ skill?: RemoteSkill }>(pid, "", {
          method: "POST",
          body: { name: r.name, description: r.description, type: remoteType(r.kind), body: p.body, files: p.files, bot_ids: r.botIds, status: r.status, source: "bops", ...(r.version ? { version: r.version } : {}) },
        });
        if (made?.status === 201 && made.json.skill?.id) {
          const id = made.json.skill.id;
          const at = made.json.skill.updated_at;
          patchRef(wsId, r.kind, r.slug, (x) => ((x.remoteId = id), (x.remoteAt = at), (x.syncedAt = Date.now())));
          res.pushed++;
        } else res.failed++;
        continue;
      }
      // Changed on Orgo: its updated_at isn't the one last seen. Changed here: since the two last agreed.
      const remoteAt = Date.parse(there.updated_at) || 0;
      const changedThere = there.updated_at !== r.remoteAt;
      const changedHere = !r.syncedAt || r.updatedAt > r.syncedAt;
      if (!r.remoteId) patchRef(wsId, r.kind, r.slug, (x) => (x.remoteId = there.id));
      if (changedThere && (!changedHere || remoteAt >= r.updatedAt)) {
        if (await pull(wsId, pid, there, r)) res.pulled++;
        else res.failed++;
      } else if (changedHere) {
        const p = await skillsCall<{ skill?: RemoteSkill }>(pid, `/${encodeURIComponent(there.id)}`, { method: "PATCH", body: { name: r.name, description: r.description, bot_ids: r.botIds, status: r.status } });
        const v = r.version && there.current_version?.version !== r.version ? payloadOf(wsId, r) : null;
        if (v) await skillsCall(pid, `/${encodeURIComponent(there.id)}/versions`, { method: "POST", body: { body: v.body, files: v.files, version: r.version } });
        if (p?.status === 200) {
          // What Orgo says now (after the version too), as last seen.
          const now = v ? await skillsCall<{ skills?: RemoteSkill[] }>(pid, "") : null;
          const at = now?.json.skills?.find((x) => x.id === there.id)?.updated_at ?? p.json.skill?.updated_at ?? new Date().toISOString();
          patchRef(wsId, r.kind, r.slug, (x) => ((x.remoteAt = at), (x.syncedAt = Date.now())));
          res.pushed++;
        } else res.failed++;
      }
    } catch (e) {
      res.failed++;
      console.warn(`[skills] sync ${r.slug}: ${(e as Error).message}`);
    }
  }
  // Only on Orgo: brought here.
  for (const x of remote) {
    if (refsOf(wsId).some((r) => r.remoteId === x.id || (r.slug === x.slug && r.kind === localKind(x.type)))) continue;
    if (await pull(wsId, pid, x)) res.pulled++;
    else res.failed++;
  }
  return res;
}

/** Orgo's copy of a skill (its export: SKILL.md and every file) written here, as `into` or as a new one. */
async function pull(wsId: string, pid: string, x: RemoteSkill, into?: SkillRef): Promise<boolean> {
  const ex = await skillsCall<{ files?: Record<string, { content?: string; executable?: boolean }>; version?: string }>(pid, `/${encodeURIComponent(x.id)}/export`);
  if (!ex || ex.status !== 200 || !ex.json.files) return false;
  const md = ex.json.files["SKILL.md"]?.content ?? "";
  const parsed = parseSkillMd(md);
  if (!parsed.ok) return false;
  const files = Object.entries(ex.json.files)
    .filter(([p]) => p !== "SKILL.md")
    .map(([path, f]) => ({ path, content: f.content ?? "", executable: !!f.executable }));
  const kind = localKind(x.type);
  const version = ex.json.version ?? x.current_version?.version;
  try {
    if (into) {
      writeTree(skillDir(wsId, kind, into.slug)!, md, files);
      if (version) writeTree(versionDir(wsId, kind, into.slug, version)!, md, files);
      patchRef(wsId, kind, into.slug, (r) => {
        r.name = x.name;
        r.description = x.description ?? r.description;
        r.botIds = x.bot_ids ?? r.botIds;
        r.status = x.status === "published" ? "published" : "draft";
        if (version) {
          r.version = version;
          if (!r.versions?.some((v) => v.version === version)) r.versions = [...(r.versions ?? []), { version, at: Date.now(), sha256: bundleSha(md, files.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) }))) }];
        }
        r.remoteId = x.id;
        r.remoteAt = x.updated_at;
        r.updatedAt = Date.parse(x.updated_at) || Date.now();
        r.syncedAt = Math.max(Date.now(), r.updatedAt);
      });
      return true;
    }
    const { ref } = createSkill(wsId, {
      kind,
      name: x.name,
      description: x.description ?? x.name,
      body: parsed.body,
      frontmatter: { ...(parsed.frontmatter ?? {}), name: x.slug },
      files,
      botIds: x.bot_ids ?? [],
      source: "orgo",
      status: x.status === "published" ? "published" : "draft",
    });
    patchRef(wsId, kind, ref.slug, (r) => {
      r.remoteId = x.id;
      r.remoteAt = x.updated_at;
      r.updatedAt = Date.parse(x.updated_at) || r.updatedAt;
      r.syncedAt = Math.max(Date.now(), r.updatedAt);
    });
    return true;
  } catch (e) {
    console.warn(`[skills] bringing ${x.slug} from Orgo: ${(e as Error).message}`);
    return false;
  }
}

/** Sync a workspace a moment after a change here (several changes in a row are one sync). */
function queueSync(wsId: string) {
  const pid = workspaceById(wsId)?.orgoProjectId;
  if (!pid || routes.get(pid) === false) return;
  const timers = (g.bopsSkillsSync ??= new Map());
  clearTimeout(timers.get(wsId));
  timers.set(
    wsId,
    setTimeout(() => {
      timers.delete(wsId);
      void syncSkills(wsId).catch((e: Error) => console.warn(`[skills] sync: ${e.message}`));
    }, 1500),
  );
}

/** Whether Orgo has the skills routes for this project, as last seen (undefined: not asked yet). */
export const skillsRoutesSeen = (projectId: string) => routes.get(projectId);
