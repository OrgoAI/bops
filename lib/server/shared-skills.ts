import "server-only";
import { sharedSkillsWho } from "@/lib/shared";
import { keptLabel } from "@/lib/skill-labels";
import type { SkillKind, SkillRef, SkillRisk } from "@/lib/types";
import { orgoHeaders } from "./app-version";
import { apiKey } from "./orgo";
import { orgoOrigin } from "./orgo-auth";
import { sharedSkillsOpen } from "./shared";
import { RISKS, type Problem } from "./skill-bundle";
import { folderPayload, localKind, remoteType, SkillError } from "./workspace-skills";

/*
 * Skills in a workspace shared with the user (Knowledge, Skills), for an Admin there (lib/shared.ts sharedSkillsWho: a
 * Member with Memory and skills next). Its skills are kept in Orgo (orgo-web's /api/projects/<id>/skills routes), the copy
 * everyone reads while the owner's Mac is off, and orgo-web lets the owner and an Admin list, read, publish, roll back,
 * delete and approve with their own Orgo key, so none of it waits for the owner's Mac: this Bops calls orgo-web with the
 * user's own key, as Keys does (shared-keys.ts), and the owner's Mac brings the change in on its next sync
 * (workspace-skills.ts syncSkills, every few minutes). Never a change act, never the user's own workspaces: `ws` in a
 * request is ignored, and a skill is found by its slug in the shared workspace's own list.
 *
 * What an Admin does here: list and read every skill (its SKILL.md, its files, its versions), publish a draft (orgo-web's
 * PATCH status), import a folder from this Mac as a new draft, update one from a folder (its next version, published at
 * once, after they said so), roll back, delete, give a skill that names its bots to one more or one fewer, and approve or
 * take back a script (orgo-web takes an approval only from a person: this Bops's sign in with Orgo is theirs). Labels,
 * which bots have which label (Who has what) and a bot's proposed changes stay the owner's, in their own window. Bodies
 * and files are never logged here.
 */

/** The line for what stays the owner's in a shared workspace (labels, Who has what, a bot's proposals). */
export const SHARED_OWNER_ONLY = "In a shared workspace, only its owner changes this.";
/** What a Member without the power reads (the Knowledge page shows them nothing to press). */
export const SHARED_SKILLS_WHO = "Only the owner or an Admin can change this workspace's skills.";
/** What the page says on an orgo-web without the skills routes (a 404 that isn't JSON). */
export const SKILLS_NOT_ON_ORGO = "Orgo can't keep this workspace's skills yet.";
const NOT_SIGNED_IN = "Sign in to Orgo to work on this workspace's skills.";
/** A skill that names no bots goes to every bot with its label, and which bot has which label is the owner's to say. */
export const BY_LABEL = "It goes to every bot with its label, and only the owner picks which bots have a label. Ask them, or give it its own bots in their Skills.";

/** orgo-web's refusals by their code, in the window's words (its own words for any other). */
const SAID: Record<string, { status: number; words: string }> = {
  workspace_read_only: { status: 403, words: SHARED_SKILLS_WHO },
  session_required: { status: 403, words: "Orgo takes an approval only from you, signed in to Bops with Orgo. Sign out, then sign in again." },
  secret_found: { status: 422, words: "That looks like a secret. Keep keys in Logins, not in a skill." },
  invalid_bundle: { status: 400, words: "Some of its files can't be kept. Fix the ones listed and try again." },
  unchanged: { status: 409, words: "Nothing changed since the version in use." },
  version_exists: { status: 409, words: "That version is published already." },
  stale_skill: { status: 409, words: "Someone changed it just now. Look at it again, then try again." },
  skill_limit: { status: 409, words: "This workspace holds 500 skills at most. Delete one to add another." },
  storage_quota: { status: 413, words: "That's more than the storage the owner's plan includes." },
  too_large: { status: 413, words: "That's too large to send to Orgo." },
  unknown_sha: { status: 404, words: "Orgo doesn't have that script yet. Try again in a minute." },
  version_not_found: { status: 404, words: "That version isn't there anymore." },
  busy: { status: 503, words: "Orgo is busy. Try again in a minute." },
};

type Json = Record<string, unknown>;

/**
 * One call to the shared workspace's skills routes on orgo-web, with the user's own Orgo key. `skill`: the call is about
 * one skill, so a 404 says the skill is gone rather than the workspace. Never logs what it sent or got.
 */
async function orgoSkills<T>(projectId: string, path: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; skill?: boolean; timeoutMs?: number } = {}): Promise<T> {
  let key: string;
  try {
    key = await apiKey();
  } catch {
    throw new SkillError(NOT_SIGNED_IN, 401);
  }
  let res: Response;
  try {
    res = await fetch(`${orgoOrigin()}/api/projects/${encodeURIComponent(projectId)}/skills${path}`, {
      method: init.method ?? "GET",
      headers: { ...orgoHeaders(), Authorization: `Bearer ${key}`, Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch {
    throw new SkillError("Bops couldn't reach Orgo. Check the internet and try again.", 502);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: unknown; code?: unknown; problems?: unknown }) | null;
  if (res.ok && json) return json;
  if (res.status === 401) throw new SkillError(NOT_SIGNED_IN, 401);
  const problems = Array.isArray(json?.problems) ? (json.problems as Problem[]).filter((p) => p && typeof p.path === "string" && typeof p.reason === "string").slice(0, 100) : undefined;
  const said = typeof json?.code === "string" && Object.hasOwn(SAID, json.code) ? SAID[json.code] : undefined;
  if (said) throw new SkillError(said.words, said.status, problems);
  // No such route (an orgo-web before it answers a page, not JSON); or the skill, or the user's place in the workspace, gone.
  if (res.status === 404) {
    if (!json) throw new SkillError(SKILLS_NOT_ON_ORGO, 503);
    throw new SkillError(init.skill ? "That skill isn't there anymore." : "This workspace isn't shared with you anymore.", 404);
  }
  throw new SkillError(json && typeof json.error === "string" && json.error ? json.error : `Orgo answered ${res.status}.`, res.ok ? 502 : res.status, problems);
}

/** The shared workspace open now, when the user may work on its skills there; else why not (none open: 409; not theirs: 403). */
function scope() {
  const open = sharedSkillsOpen();
  if (!open) throw new SkillError("Open the workspace again.", 409);
  if (!sharedSkillsWho(open)) throw new SkillError(SHARED_SKILLS_WHO, 403);
  return open;
}

/** A skill as orgo-web's list says it (GET …/skills): `current_version.label` is what its SKILL.md says of its label. */
type RemoteSkill = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  bot_ids?: string[];
  label?: string | null;
  created_at?: string;
  updated_at: string;
  current_version?: { version?: string; risk?: string | null; label?: string } | null;
};

/** A skill of orgo-web's as the page lists one (SkillRef): published at its current version, else a draft. */
function refOf(x: RemoteSkill): SkillRef {
  const published = x.status === "published";
  // A label column of orgo-web's when it keeps one, else the one its current version's SKILL.md gives it.
  const label = keptLabel(typeof x.label === "string" ? x.label : x.current_version?.label);
  const risk = x.current_version?.risk;
  return {
    slug: x.slug,
    kind: localKind(x.type),
    name: x.name,
    description: x.description ?? "",
    ...(label ? { label } : {}),
    labelBy: "skill",
    status: published ? "published" : "draft",
    ...(published && x.current_version?.version ? { version: x.current_version.version } : {}),
    ...(risk && (RISKS as readonly string[]).includes(risk) ? { risk: risk as SkillRisk } : {}),
    botIds: Array.isArray(x.bot_ids) ? x.bot_ids.filter((id): id is string => typeof id === "string") : [],
    source: "orgo",
    createdAt: Date.parse(x.created_at ?? "") || 0,
    updatedAt: Date.parse(x.updated_at) || 0,
    remoteId: x.id,
    remoteAt: x.updated_at,
  };
}

async function listed(projectId: string): Promise<RemoteSkill[]> {
  const got = await orgoSkills<{ skills?: unknown }>(projectId, "");
  return Array.isArray(got.skills) ? (got.skills.filter((x) => !!x && typeof x === "object" && typeof (x as RemoteSkill).id === "string" && typeof (x as RemoteSkill).slug === "string") as RemoteSkill[]) : [];
}

/**
 * GET /api/skills in a shared workspace: its skills and apps as orgo-web lists them now (newest first, as the page shows
 * them), always kept in Orgo. Nothing of the user's own workspaces.
 */
export async function sharedSkillsList() {
  const open = scope();
  const refs = (await listed(open.projectId)).map(refOf).sort((a, b) => b.updatedAt - a.updatedAt);
  return { skills: refs.filter((r) => r.kind === "skill"), apps: refs.filter((r) => r.kind === "app"), labels: [] as string[], labelInfo: [], sync: null, orgo: true, shared: true };
}

/** One of the shared workspace's skills by its kind and slug, as orgo-web lists it now. */
async function findRemote(projectId: string, kind: SkillKind, slug: string): Promise<RemoteSkill> {
  const x = slug ? (await listed(projectId)).find((s) => s.slug === slug && localKind(s.type) === kind) : undefined;
  if (!x) throw new SkillError(`That ${kind} isn't there anymore.`, 404);
  return x;
}

/** A file orgo-web lists for a version (GET …/skills/{id}). */
type RemoteFile = { path: string; sha256: string; size_bytes: number; executable: boolean; media_type?: string; approved?: boolean };

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|x-sh|x-python|x-shellscript|sql|graphql))/i;
/** Script kinds by name: what Bops counts as a script (skill-bundle.ts isScript) without its first line to read. */
const SCRIPT_NAMES = /\.(sh|bash|zsh|fish|py|rb|pl|php|js|mjs|cjs|ts|ps1|command)$/i;
const isTextFile = (f: RemoteFile) => TEXT_TYPES.test(f.media_type ?? "text/plain");

/**
 * Bops' isScript (executable, under scripts/, or a #! line) as far as orgo-web's list says: its bit, its folder, and a
 * script's kind of name or type. One whose first line alone makes it a script shows when it's read (the window looks).
 */
const scriptish = (f: RemoteFile) => f.executable || f.path.startsWith("scripts/") || SCRIPT_NAMES.test(f.path) || /x-(sh|python|shellscript)/i.test(f.media_type ?? "");

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const versionQuery = (v: string | undefined) => (v ? `?version=${encodeURIComponent(v)}` : "");

/**
 * POST /api/skills in a shared workspace (`{action, kind, slug, ...}`, its `ws` ignored): what the user does to one of its
 * skills, done in orgo-web with their own key. Anything else answers SHARED_OWNER_ONLY.
 */
export async function sharedSkillAct(b: Json): Promise<Json> {
  const open = scope();
  const pid = open.projectId;
  const kind: SkillKind = b.kind === "app" ? "app" : "skill";
  const slug = str(b.slug) ?? "";
  switch (b.action) {
    case "detail": {
      const x = await findRemote(pid, kind, slug);
      const version = str(b.version);
      const got = await orgoSkills<{ version?: { version?: string; body?: string; frontmatter?: Json; files?: RemoteFile[] } | null; versions?: unknown }>(pid, `/${encodeURIComponent(x.id)}${versionQuery(version)}`, { skill: true });
      const v = got.version ?? null;
      const versions = Array.isArray(got.versions) ? got.versions.filter((y): y is string => typeof y === "string") : [];
      const ref = refOf(x);
      return {
        ref: { ...ref, versions: versions.map((y) => ({ version: y, at: 0, sha256: "" })) },
        body: v?.body ?? "",
        frontmatter: v?.frontmatter ?? {},
        files: (v?.files ?? []).map((f) => ({ path: f.path, size: f.size_bytes, sha256: f.sha256, executable: f.executable, script: scriptish(f), approved: !!f.approved, binary: !isTextFile(f) })),
        dir: null,
        missing: !v,
        changed: false,
        shared: true,
      };
    }
    case "file": {
      const x = await findRemote(pid, kind, slug);
      const path = str(b.path) ?? "";
      if (!path || path.split("/").some((p) => p === ".." || p === "")) throw new SkillError("That file isn't in it.", 404);
      const f = await orgoSkills<{ path?: string; sha256?: string; size_bytes?: number; content?: string; url?: string }>(pid, `/${encodeURIComponent(x.id)}/files/${path.split("/").map(encodeURIComponent).join("/")}${versionQuery(str(b.version))}`, { skill: true });
      // Text up to 1 MB comes inline; a binary or larger file only as a link, which isn't shown here.
      if (typeof f.content === "string") return { path: f.path ?? path, content: f.content, sha256: f.sha256 ?? "" };
      return { path: f.path ?? path, content: null, sha256: f.sha256 ?? "", binary: true, size: f.size_bytes ?? 0 };
    }
    case "publish": {
      const x = await findRemote(pid, kind, slug);
      if (x.status === "published") throw new SkillError("It's published already. To change it, update it from a folder.", 409);
      const got = await orgoSkills<{ skill?: RemoteSkill }>(pid, `/${encodeURIComponent(x.id)}`, { method: "PATCH", body: { status: "published", if_updated_at: x.updated_at }, skill: true });
      return { ref: refOf({ ...x, ...(got.skill ?? {}), status: "published" }) };
    }
    case "rollback": {
      const x = await findRemote(pid, kind, slug);
      const version = str(b.version) ?? "";
      if (!/^\d+\.\d+\.\d+/.test(version)) throw new SkillError("A version looks like 1.2.0.");
      const got = await orgoSkills<{ skill?: RemoteSkill }>(pid, `/${encodeURIComponent(x.id)}/rollback`, { method: "POST", body: { version }, skill: true });
      return { ref: refOf({ ...x, ...(got.skill ?? {}) }) };
    }
    case "delete": {
      const x = await findRemote(pid, kind, slug);
      await orgoSkills(pid, `/${encodeURIComponent(x.id)}`, { method: "DELETE", skill: true });
      return { ok: true };
    }
    case "bot": {
      const botId = str(b.botId);
      if (!botId || typeof b.on !== "boolean") throw new SkillError("Which bot, and on or off?");
      if (!open.botIds.includes(botId)) throw new SkillError("That bot isn't in this workspace.", 404);
      const x = await findRemote(pid, kind, slug);
      const now = Array.isArray(x.bot_ids) ? x.bot_ids : [];
      // One that names no bots follows its label (lib/skill-labels.ts botHasSkill): whose label is the owner's to say.
      if (!now.length) throw new SkillError(BY_LABEL, 403);
      const next = b.on ? [...new Set([...now, botId])] : now.filter((id) => id !== botId);
      if (!next.length) throw new SkillError("At least one bot keeps it. Delete it instead.");
      const got = await orgoSkills<{ skill?: RemoteSkill }>(pid, `/${encodeURIComponent(x.id)}`, { method: "PATCH", body: { bot_ids: next, if_updated_at: x.updated_at }, skill: true });
      return { ref: refOf({ ...x, ...(got.skill ?? {}), bot_ids: got.skill?.bot_ids ?? next }) };
    }
    case "approve": {
      const sha256 = str(b.sha256) ?? "";
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SkillError("That isn't a script's sha256.");
      const path = str(b.path)?.slice(0, 512);
      if (b.on === false) await orgoSkills(pid, `/approvals?sha256=${sha256}`, { method: "DELETE" }).catch((e: unknown) => {
        // Not approved there (anymore): nothing to take back.
        if (!(e instanceof SkillError && e.status === 404)) throw e;
      });
      else await orgoSkills(pid, "/approvals", { method: "POST", body: { sha256, ...(path ? { path_hint: path } : {}) } });
      return { ok: true };
    }
    case "import": {
      const path = str(b.path);
      if (!path || !path.startsWith("/")) throw new SkillError("Pick a folder.");
      if (slug) {
        // Update from folder: the folder is its next version, published in Orgo at once (the window asked first).
        const x = await findRemote(pid, kind, slug);
        const f = folderPayload(path, slug);
        const got = await orgoSkills<{ skill?: RemoteSkill; version?: { version?: string } }>(pid, `/${encodeURIComponent(x.id)}/versions`, { method: "POST", body: { body: f.skillMd, files: f.files }, skill: true, timeoutMs: 120_000 });
        const version = got.version?.version ?? got.skill?.current_version?.version;
        return { ref: refOf({ ...x, ...(got.skill ?? {}), status: "published", ...(version ? { current_version: { ...(x.current_version ?? {}), version } } : {}) }), skipped: f.skipped, warnings: f.warnings, drafted: f.drafted, published: true };
      }
      // A new one: a draft in Orgo, to read and publish here.
      const f = folderPayload(path);
      const got = await orgoSkills<{ skill?: RemoteSkill }>(pid, "", { method: "POST", body: { name: f.name, description: f.description, type: remoteType(kind), body: f.skillMd, files: f.files, status: "draft", source: "import" }, timeoutMs: 120_000 });
      if (!got.skill?.id) throw new SkillError("Orgo didn't say what it saved. Look in Skills again.", 502);
      return { ref: refOf(got.skill), skipped: f.skipped, warnings: f.warnings, drafted: f.drafted };
    }
    default:
      throw new SkillError(SHARED_OWNER_ONLY, 403);
  }
}
