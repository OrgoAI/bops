import "server-only";
import { botChatId, freeComputerOnDelete, MAIN_WORKSPACE, sharesComputer, workspaceOf, type Bot, type OrgoMigration, type Workspace } from "@/lib/types";
import { freeBotId } from "./bots";
import { getState, id, stateEpoch, update } from "./store";
import { ensureInbox } from "./mail";
import {
  bindProject,
  bopsAppsGate,
  collisionNames,
  deletePreview as orgoDeletePreview,
  deleteProject,
  ensureProject,
  nameTaken,
  OrgoError,
  ownedWorkspaces,
  perWorkspaceProjects,
  perWorkspaceUnconfirmed,
  pickMainProject,
  projectComputers,
  renameProject,
  tieProject,
  type AppsGateReason,
  type OrgoWorkspace,
} from "./orgo";
import { folderKey, moveWorkspaceFolder, refsOf, syncSkills } from "./workspace-skills";

/**
 * Workspaces: separate teams. Each has its own main bot (Boppy by default, who runs it and whose computer the
 * team's computers fork from), its bots, chats and work. The user's Mac and the Vault are shared.
 *
 * On an orgo-web with per workspace projects, each Bops workspace is an Orgo workspace of its own: a project
 * marked product "bops", tied to it by bops_ws_id (Workspace.orgoProjectId). New workspace makes the project,
 * Rename renames it (and a rename on orgo.ai comes here: syncWorkspaceNames), Delete deletes it with what's in
 * it once the user confirmed the list (deletePreview). migrateWorkspacesToOrgo ties the default workspace to
 * the "bops" project and makes an empty project for every other one; nothing moves (.ops-kit/bops-workspaces/
 * DECISIONS.md). On an Orgo without them (orgo-web before per workspace projects), a workspace is this app's
 * alone, as it always was: nothing is made, renamed or deleted on Orgo.
 */

/** The longest a workspace's name can be. */
const NAME_MAX = 40;

/** A name no other workspace here has: "Acme", else "Acme 2", "Acme 3". */
function freeLocalName(name: string, except?: string) {
  const taken = new Set((getState().workspaces ?? []).filter((w) => w.id !== except).map((w) => w.name.trim().toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const c = `${name.slice(0, NAME_MAX - String(n).length - 1)} ${n}`;
    if (!taken.has(c.toLowerCase())) return c;
  }
}

export type CreateResult = { id: string; chatId: string; orgoProjectId?: string } | { error: string; code: "name_taken"; suggestion: string } | { error: string; code: "orgo"; status: number };

/**
 * A new workspace: its own team, starting with its own Boppy, and the current one from now on. On an
 * orgo-web with per workspace projects its Orgo workspace is made first, under the same name: when the
 * user's Orgo already has a workspace by that name, nothing is made and they're asked for another
 * (`name_taken`, with "<name> (Bops)" to start from). Orgo not answering doesn't stop it: the project is
 * made with its first computer then.
 */
export async function createWorkspace(name: string): Promise<CreateResult> {
  const clean = freeLocalName(name.trim().slice(0, NAME_MAX) || "New workspace");
  const ws = id("ws");
  let made: { id: string; name: string } | undefined;
  if ((await perWorkspaceProjects().catch(() => null)) === true) {
    try {
      made = await ensureProject(ws, { interactive: true, name: clean });
    } catch (e) {
      if (nameTaken(e)) {
        const suggestion = await freeOrgoName(clean);
        return { error: `You already have an Orgo workspace named ${clean}. Try ${suggestion} or another name.`, code: "name_taken", suggestion };
      }
      if (e instanceof OrgoError && e.status >= 400 && e.status < 500) return { error: e.said || "Orgo didn't make the workspace.", code: "orgo", status: e.status };
      console.warn(`[workspaces] Orgo didn't make ${ws}'s workspace yet: ${(e as Error).message}`);
    }
  }
  const mainId = freeBotId("Boppy");
  const main: Bot = {
    id: mainId,
    name: "Boppy",
    role: "Chief of Staff",
    color: "#0A0A0A",
    isMain: true,
    computerStatus: "none",
    workspaceId: ws,
  };
  update((s) => {
    (s.workspaces ??= [{ id: MAIN_WORKSPACE, name: "Main", createdAt: Date.now() }]).push({ id: ws, name: clean, createdAt: Date.now(), ...(made ? { orgoProjectId: made.id, orgoName: made.name } : {}) });
    s.bots.push(main);
    s.chats.push({ id: botChatId(mainId), kind: "bot", botIds: [mainId], createdAt: Date.now(), typing: [], workspaceId: ws });
    s.workspace = ws;
  });
  void ensureInbox(mainId).catch((e: Error) => console.warn(`[mail] inbox for ${mainId}: ${e.message}`));
  return { id: ws, chatId: botChatId(mainId), ...(made ? { orgoProjectId: made.id } : {}) };
}

/** A name to suggest when the user's Orgo has `name`: the first of collisionNames it doesn't have, that fits. */
async function freeOrgoName(name: string): Promise<string> {
  const taken = new Set(((await ownedWorkspaces().catch(() => [])) as { name: string }[]).map((w) => w.name.trim().toLowerCase()));
  const fits = collisionNames(name).slice(1).map((n) => (n.length > NAME_MAX ? `${name.slice(0, NAME_MAX - (n.length - name.length))}${n.slice(name.length)}` : n));
  return fits.find((n) => !taken.has(n.toLowerCase())) ?? fits[0];
}

/** Bops from before workspaces: if any bot has no workspace, make sure "Main" is listed. */
export function ensureMain() {
  const s = getState();
  if (s.workspaces?.some((w) => w.id === MAIN_WORKSPACE) || !s.bots.some((b) => !b.workspaceId)) return;
  update((x) => {
    x.workspaces = [{ id: MAIN_WORKSPACE, name: "Main", createdAt: 0 }, ...(x.workspaces ?? [])];
  });
}

const g = globalThis as unknown as { bopsWsMigration?: Promise<MigrationResult>; bopsWsRenamedAt?: Map<string, number>; bopsWsSync?: Promise<SyncResult | null> };
/** When each workspace was last renamed here: a list Orgo started answering before that is older than the rename. */
const renamedAt = (g.bopsWsRenamedAt ??= new Map());

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isBopsName = (n: string) => sameName(n, "bops");

/** Keep what Orgo said a project is named now (after a rename here): the next sync takes it for no change. */
function noteOrgoName(wsId: string, name: string, updatedAt?: string | null) {
  update((s) => {
    const x = s.workspaces?.find((y) => y.id === wsId);
    if (!x) return;
    x.orgoName = name;
    if (updatedAt) x.orgoUpdatedAt = updatedAt;
  });
}

export type RenameResult = { ok: true; waiting?: AppsGateReason } | { error: string; code: "name_taken" | "orgo" };

/**
 * Rename a workspace, and its Orgo workspace when it has one: Orgo first, so a name the user's Orgo already
 * has is said back (`name_taken`) and nothing changes. The default workspace's project, while it's still
 * named "bops", takes the new name only once every Bops app on the account is new enough (bopsAppsGate):
 * until then the name changes here only, the project keeps "bops" for the older apps, and the result says
 * why (`waiting`); the next sign-in tries again.
 */
export async function renameWorkspace(workspaceId: string, name: string): Promise<RenameResult> {
  const clean = name.trim().slice(0, NAME_MAX);
  if (!clean) return { ok: true };
  const w = getState().workspaces?.find((x) => x.id === workspaceId);
  if (!w) return { ok: true };
  const per = (await perWorkspaceProjects().catch(() => null)) === true;
  let waiting: AppsGateReason | undefined;
  if (per && !w.orgoProjectId && workspaceId !== MAIN_WORKSPACE) {
    // No project of its own yet (made with its first computer): a name the user's Orgo has is asked about now, not changed then.
    const owned = await ownedWorkspaces().catch(() => null);
    if (owned?.some((p) => sameName(p.name, clean))) return { error: `You already have an Orgo workspace named ${clean}. Pick another name.`, code: "name_taken" };
  }
  if (per && w.orgoProjectId) {
    renamedAt.set(workspaceId, Date.now());
    // The default's project still named "bops", to a name that isn't: only when no older app looks for "bops".
    const gated = workspaceId === MAIN_WORKSPACE && isBopsName(w.orgoName ?? "bops") && !isBopsName(clean);
    const gate = gated ? await bopsAppsGate() : null;
    if (gate && !gate.ok) waiting = gate.reason;
    else
      try {
        const r = await renameProject(w.orgoProjectId, clean);
        noteOrgoName(workspaceId, typeof r?.name === "string" ? r.name : clean, r?.updated_at);
      } catch (e) {
        if (nameTaken(e)) return { error: `You already have an Orgo workspace named ${clean}. Pick another name.`, code: "name_taken" };
        if (e instanceof OrgoError && e.status < 500) return { error: e.said || "Orgo didn't rename it.", code: "orgo" };
        return { error: "Couldn't reach Orgo to rename it. Try again.", code: "orgo" };
      }
  }
  update((s) => {
    const x = s.workspaces?.find((y) => y.id === workspaceId);
    if (x) x.name = clean;
    if (workspaceId !== MAIN_WORKSPACE || !s.orgoMigration) return;
    // The default's name waits for the apps (or no longer does).
    if (waiting) s.orgoMigration.defaultRename = { to: clean, reason: waiting, checkedAt: new Date().toISOString() };
    else delete s.orgoMigration.defaultRename;
  });
  return waiting ? { ok: true, waiting } : { ok: true };
}

export function switchWorkspace(workspaceId: string) {
  if (!getState().workspaces?.some((w) => w.id === workspaceId)) throw new Error("no such workspace");
  update((s) => (s.workspace = workspaceId));
}

/** The workspace the user is looking at. */
export const currentWorkspaceId = () => getState().workspace ?? MAIN_WORKSPACE;

/* ---------------- Names from orgo.ai ---------------- */

export type SyncResult = { renamed: { wsId: string; from: string; to: string }[] };

/**
 * A workspace renamed on orgo.ai is renamed here too (at sign-in, and every 10 minutes while the app is
 * open: the sidebar asks). A project whose name differs from the one last seen or set here
 * (Workspace.orgoName) was renamed there: the local name follows it. Never for a list Orgo started on
 * before a rename here (that rename is newer), nor for one older than what was seen (`updated_at`). A
 * default whose project is still "bops" shows as "bops" unless the user named it here (its name then
 * waits for the apps: OrgoMigration.defaultRename). A project gone from the list is left alone. Null on an
 * Orgo without per workspace projects (nothing is called there but the check).
 */
export function syncWorkspaceNames(): Promise<SyncResult | null> {
  return (g.bopsWsSync ??= runSync().finally(() => (g.bopsWsSync = undefined)));
}

async function runSync(): Promise<SyncResult | null> {
  if ((await perWorkspaceProjects().catch(() => null)) !== true) return null;
  const epoch = stateEpoch();
  const started = Date.now();
  const owned = await ownedWorkspaces();
  if (stateEpoch() !== epoch) return null;
  const out: SyncResult["renamed"] = [];
  for (const w of getState().workspaces ?? []) {
    const p = w.orgoProjectId ? owned.find((x) => x.id === w.orgoProjectId) : undefined;
    if (!p || (renamedAt.get(w.id) ?? 0) >= started) continue;
    const seenAt = Date.parse(w.orgoUpdatedAt ?? "");
    const at = Date.parse(p.updated_at ?? "");
    if (Number.isFinite(seenAt) && Number.isFinite(at) && at < seenAt) continue;
    // First sight (tied before names were kept): learnt, never taken for a rename.
    if (w.orgoName === undefined || p.name === w.orgoName) {
      if (w.orgoName === undefined || (p.updated_at && p.updated_at !== w.orgoUpdatedAt)) noteOrgoName(w.id, p.name, p.updated_at);
      continue;
    }
    const from = w.name;
    const to = freeLocalName(p.name.trim().slice(0, NAME_MAX) || from, w.id);
    update((s) => {
      const x = s.workspaces?.find((y) => y.id === w.id);
      if (!x) return;
      x.name = to;
      x.orgoName = p.name;
      if (p.updated_at) x.orgoUpdatedAt = p.updated_at;
      // Renamed on orgo.ai since: that's the name now, and the one waiting here is dropped.
      if (w.id === MAIN_WORKSPACE && s.orgoMigration) delete s.orgoMigration.defaultRename;
    });
    if (to !== from) out.push({ wsId: w.id, from, to });
  }
  return { renamed: out };
}

/* ---------------- Deleting a workspace ---------------- */

/**
 * What deleting a workspace takes with it, for the confirm: the computers (its team's here, and what's in
 * its Orgo workspace), its keys (the ones for This workspace), its skills and its apps, Bops' and Orgo's
 * together, each once. `orgo`: its Orgo workspace goes too. Throws for the default workspace, and when Orgo
 * doesn't say what's in it (nothing is deleted without the user seeing the list).
 */
export type DeletePreview = { id: string; name: string; orgo: boolean; bots: string[]; computers: { id: string; name: string }[]; keys: string[]; skills: string[]; apps: string[] };

export class WorkspaceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_UNDELETABLE = "The default workspace can't be deleted.";

export async function deletePreview(workspaceId: string): Promise<DeletePreview> {
  const w = getState().workspaces?.find((x) => x.id === workspaceId);
  if (!w) throw new WorkspaceError("No such workspace.", 404);
  if (workspaceId === MAIN_WORKSPACE) throw new WorkspaceError(DEFAULT_UNDELETABLE);
  const team = getState().bots.filter((b) => workspaceOf(b) === workspaceId);
  // The free Bops computer stays when another workspace's bots work on it (it passes to one of them), and
  // is said by its name when it goes.
  const free = freeComputerOnDelete(getState().bots, workspaceId);
  const computers = team
    .filter((b) => b.computerId && !sharesComputer(b) && !(free?.kept && b.computerId === free.id))
    .map((b) => ({ id: b.computerId!, name: free && b.computerId === free.id ? "Your free Bops computer" : `${b.name}'s computer` }));
  const keys: string[] = [];
  const skills = refsOf(workspaceId, "skill").map((r) => r.name);
  const apps = refsOf(workspaceId, "app").map((r) => r.name);
  const orgo = !!w.orgoProjectId && (await perWorkspaceProjects().catch(() => null)) === true;
  if (orgo) {
    let there;
    try {
      there = await orgoDeletePreview(w.orgoProjectId!);
    } catch (e) {
      throw new WorkspaceError(`Orgo didn't say what's in ${w.name}, so nothing was deleted. Try again.${e instanceof OrgoError && e.said ? ` (${e.said})` : ""}`, 502);
    }
    for (const c of there.computers) if (!computers.some((x) => x.id === c.id)) computers.push(c);
    // The free computer made in this workspace's project goes with it, whoever else works on it.
    for (const c of computers) if (free && c.id === free.id) c.name = "Your free Bops computer";
    keys.push(...there.keys);
    skills.push(...there.skills);
    apps.push(...there.apps);
    // An orgo-web that only counts them: more there than are named here are still said, never left off.
    const more = (n: number | undefined, named: string[], one: string, many: string) => {
      if (n && n > named.length) named.push(`${n} ${n === 1 ? one : many} on Orgo`);
    };
    more(there.skillCount, skills, "skill", "skills");
    more(there.appCount, apps, "app", "apps");
    // This workspace's keys as this app last listed them (the vault scopes them to its project).
    const { listKeys } = await import("./keys");
    for (const k of await listKeys().catch(() => [])) if (k.workspaceId === w.orgoProjectId) keys.push(k.name);
  }
  const once = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => sameName(x, y)) === i);
  return { id: w.id, name: w.name, orgo, bots: team.map((b) => b.name), computers, keys: once(keys), skills: once(skills), apps: once(apps) };
}

/* ---------------- Moving onto Orgo workspaces ---------------- */

/** What happened to the default workspace's name: its name here, its project's, and why the project kept "bops" when it did. */
export type DefaultName = { local: string; project: string | null; renamed: boolean; reason?: AppsGateReason | "no_project" | "same" | "unchanged" };

export type MigrationResult =
  /** An Orgo without per workspace projects (or none to tell by yet): nothing was done or sent. */
  | { status: "legacy" }
  | { status: "unreachable" }
  | { status: "done"; created: number; renamed: { wsId: string; from: string; to: string }[]; defaultName: DefaultName }
  /** Another account signed in meanwhile: it stopped, and the next sign-in goes on. */
  | { status: "stopped" };

class Stopped extends Error {}

/**
 * The steps, in order. Each is saved when done, so a stop goes on from the next one. A state from the first
 * build (steps "members" and "moves") starts again from the top, which finds what it did and does nothing twice.
 */
const STEPS = ["bind-main", "bind-others", "rename-default", "folders", "done"] as const;
type Step = (typeof STEPS)[number];
const after = (m: OrgoMigration | undefined, step: Step) => !!m && STEPS.indexOf(m.step as Step) > STEPS.indexOf(step);

/**
 * Each Bops workspace onto an Orgo workspace of its own (on sign-in; .ops-kit/bops-workspaces/DECISIONS.md):
 * tie the default one to the "bops" project; give every other workspace an EMPTY project of its own under
 * its name now (a name the user's Orgo already has gets "<name> (Bops)", said in the switcher), the ones
 * whose bots use the free computer too; move nothing (every computer stays where it is, most in the "bops"
 * project); give the default's project the user's name for it once every app on the account is new
 * (renameDefault); move the skills folders. Saved after every step, so a stop or a crash resumes. Once done,
 * each sign-in only tries the default's name again when it waits, and takes renames from orgo.ai
 * (syncWorkspaceNames). On an Orgo without per workspace projects nothing is written anywhere.
 */
export function migrateWorkspacesToOrgo(): Promise<MigrationResult> {
  return (g.bopsWsMigration ??= runMigration()
    .then(async (r) => {
      if (r.status === "done") await syncWorkspaceNames().catch((e: Error) => console.warn(`[workspaces] names from Orgo: ${e.message}`));
      return r;
    })
    .catch((e: unknown): MigrationResult => {
      if (e instanceof Stopped) return { status: "stopped" };
      console.warn(`[workspaces] moving onto Orgo workspaces (goes on at the next sign-in): ${(e as Error).message}`);
      return { status: "unreachable" };
    })
    .finally(() => (g.bopsWsMigration = undefined)));
}

const doneResult = (m: OrgoMigration, defaultName: DefaultName): MigrationResult => ({ status: "done", created: m.created.length, renamed: m.renamed ?? [], defaultName });

async function runMigration(): Promise<MigrationResult> {
  // Undone on this Mac: never again by itself.
  if (getState().orgoMigrationRevertedAt) return { status: "legacy" };
  const epoch = stateEpoch();
  const same = () => {
    if (stateEpoch() !== epoch) throw new Stopped();
  };
  const before = getState().orgoMigration;
  if (before?.doneAt && before.step === "done") {
    // Done: only the default's name may still be waiting for the apps.
    const d = before.defaultRename ? await renameDefault(same) : currentDefault();
    return doneResult(getState().orgoMigration ?? before, d);
  }
  let on: boolean | null;
  try {
    on = await perWorkspaceProjects({ fresh: true });
  } catch {
    return { status: "unreachable" };
  }
  // The list carries `product` but nothing is tied yet: the column may be there without orgo-web's code for it.
  // Tying the default's project finds out (only the code says the tie back); anything else and it stays as before.
  if (on === null && perWorkspaceUnconfirmed()) {
    const owned = await ownedWorkspaces();
    const freeId = await import("./plan").then((p) => p.orgoPlan()).then((p) => p?.freeComputerId ?? null).catch(() => null);
    const pick = pickMainProject(owned, freeId);
    if (pick && (await tieProject(pick.id, MAIN_WORKSPACE))) on = true;
  }
  if (on !== true) return { status: "legacy" };
  const save = (fn: (m: OrgoMigration) => void) => {
    same();
    update((s) => {
      if (!s.orgoMigration || s.orgoMigration.v !== 2) s.orgoMigration = { v: 2, step: STEPS[0], created: s.orgoMigration?.created ?? [], ...(s.orgoMigration?.renamed ? { renamed: s.orgoMigration.renamed } : {}) };
      fn(s.orgoMigration);
    });
  };
  const m = () => getState().orgoMigration;
  ensureMain();
  save(() => {});

  // 1. The default workspace: its stored project, the one tied to it, the Bops one (rule in DESIGN.md 9), or later
  // (no "bops" project yet: it's made with the first computer, as {name:'bops', product:'bops', bops_ws_id:'ws_main'}).
  if (!after(m(), "bind-main")) {
    const owned = await ownedWorkspaces();
    same();
    const main = getState().workspaces?.find((w) => w.id === MAIN_WORKSPACE);
    const kept = main?.orgoProjectId ? owned.find((w) => w.id === main.orgoProjectId) : undefined;
    const freeId = kept ? null : await import("./plan").then((p) => p.orgoPlan()).then((p) => p?.freeComputerId ?? null).catch(() => null);
    const pick = kept ?? pickMainProject(owned, freeId);
    if (pick) {
      // Tied here only once Orgo tied it: a refusal (409 taken, 400) stops the move, to go on at the next sign-in.
      if (pick.bops_ws_id !== MAIN_WORKSPACE && !(await tieProject(pick.id, MAIN_WORKSPACE))) throw new Error(`Orgo didn't tie ${pick.id.slice(0, 8)} to the default workspace`);
      same();
      bindProject(MAIN_WORKSPACE, pick.id, pick.name, pick.updated_at);
    }
    save((x) => (x.step = "bind-others"));
  }

  // 2. Every other workspace, in the order they were made: the project tied to it, else an empty one of its own
  // now, whatever its team has (no computer, its own, or the free one). Nothing is moved into it.
  if (!after(m(), "bind-others")) {
    const owned = await ownedWorkspaces();
    const others = [...(getState().workspaces ?? [])].filter((w) => w.id !== MAIN_WORKSPACE).sort((a, b) => a.createdAt - b.createdAt);
    for (const w of others) {
      same();
      const bound = w.orgoProjectId ? owned.find((p) => p.id === w.orgoProjectId) : undefined;
      if (bound) {
        bindProject(w.id, bound.id, bound.name, bound.updated_at);
        continue;
      }
      const made = await ensureProject(w.id);
      save((x) => {
        if (made.created && !x.created.includes(made.id)) x.created.push(made.id);
        // Its Orgo name isn't its name here ("orgo (Bops)"): said once in the switcher, also after a stop in between.
        if (!sameName(made.name, w.name) && !(x.renamed ?? []).some((r) => r.wsId === w.id)) (x.renamed ??= []).push({ wsId: w.id, from: w.name, to: made.name });
      });
    }
    save((x) => (x.step = "rename-default"));
  }

  // 3. The default workspace's name (renameDefault).
  let defaultName = currentDefault();
  if (!after(m(), "rename-default")) {
    defaultName = await renameDefault(same);
    save((x) => (x.step = "folders"));
  }

  // 4. Skills folders from each workspace's Bops id to its project's (bindProject moves them as it binds; this catches any left).
  if (!after(m(), "folders")) {
    for (const w of getState().workspaces ?? []) if (w.orgoProjectId) moveWorkspaceFolder(w.id, folderKey(w));
    save((x) => {
      x.step = "done";
      x.doneAt = new Date().toISOString();
    });
    for (const w of getState().workspaces ?? []) if (w.orgoProjectId) void syncSkills(w.id).catch((e: Error) => console.warn(`[skills] sync after the move: ${e.message}`));
  }
  return doneResult(m()!, defaultName);
}

/** The default's name as it stands, without asking Orgo. */
function currentDefault(): DefaultName {
  const main = getState().workspaces?.find((w) => w.id === MAIN_WORKSPACE);
  const waits = getState().orgoMigration?.defaultRename;
  return { local: main?.name ?? "", project: main?.orgoName ?? null, renamed: false, reason: (waits?.reason as DefaultName["reason"]) ?? "unchanged" };
}

/**
 * The default workspace's name (DECISIONS.md). "Main" left as it was is "bops" here, its project's name. A
 * name the user gave it here becomes its project's name too, but only once every Bops app on the account is
 * new enough (orgo.ts bopsAppsGate): an older app finds its workspace by the name "bops". Until then the
 * project keeps "bops", Bops shows the user's name, and OrgoMigration.defaultRename says why; the next
 * sign-in tries again. A name the user's Orgo already has gets "<name> (Bops)", said in the switcher.
 */
async function renameDefault(same: () => void): Promise<DefaultName> {
  const main = getState().workspaces?.find((w) => w.id === MAIN_WORKSPACE);
  if (!main) return { local: "", project: null, renamed: false, reason: "no_project" };
  if (/^main$/i.test(main.name.trim()))
    update((s) => {
      const x = s.workspaces?.find((w) => w.id === MAIN_WORKSPACE);
      if (x) x.name = "bops";
    });
  const local = getState().workspaces!.find((w) => w.id === MAIN_WORKSPACE)!.name;
  const wait = (reason: string) =>
    update((s) => {
      if (s.orgoMigration) s.orgoMigration.defaultRename = { to: local, reason, checkedAt: new Date().toISOString() };
    });
  const settled = () =>
    update((s) => {
      if (s.orgoMigration) delete s.orgoMigration.defaultRename;
    });
  let p: OrgoWorkspace | undefined;
  if (main.orgoProjectId) p = (await ownedWorkspaces()).find((x) => x.id === main.orgoProjectId);
  same();
  if (!p) {
    // No "bops" project yet: made under that name with the first computer, and named then at a later sign-in.
    if (isBopsName(local)) settled();
    else wait("no_project");
    return { local, project: null, renamed: false, reason: "no_project" };
  }
  // The user didn't name it, or the project has that name already, or was renamed away from "bops" on orgo.ai
  // (syncWorkspaceNames brings that name here).
  if (isBopsName(local) || sameName(p.name, local) || !isBopsName(p.name)) {
    settled();
    return { local, project: p.name, renamed: false, reason: sameName(p.name, local) ? "same" : "unchanged" };
  }
  const gate = await bopsAppsGate();
  same();
  if (!gate.ok) {
    wait(gate.reason);
    return { local, project: p.name, renamed: false, reason: gate.reason };
  }
  const taken = new Set((await ownedWorkspaces()).filter((x) => x.id !== p.id).map((x) => x.name.trim().toLowerCase()));
  for (const n of collisionNames(local)) {
    if (taken.has(n.toLowerCase())) continue;
    renamedAt.set(MAIN_WORKSPACE, Date.now());
    try {
      const r = await renameProject(p.id, n);
      same();
      noteOrgoName(MAIN_WORKSPACE, typeof r?.name === "string" ? r.name : n, r?.updated_at);
    } catch (e) {
      if (nameTaken(e)) continue;
      throw e;
    }
    update((s) => {
      if (!s.orgoMigration) return;
      delete s.orgoMigration.defaultRename;
      if (n !== local) (s.orgoMigration.renamed ??= []).push({ wsId: MAIN_WORKSPACE, from: local, to: n });
    });
    return { local, project: n, renamed: true, reason: "all_new" };
  }
  wait("no_free_name");
  return { local, project: p.name, renamed: false };
}

/**
 * Undo migrateWorkspacesToOrgo (DESIGN.md section 8): the Orgo workspaces it made are deleted when they're
 * empty (one with something in it stays), the default's project goes back to the name "bops", and each
 * workspace forgets its project (its skills folder goes back to its Bops id). Everything on Orgo first: a
 * delete or rename Orgo refuses throws before anything changes here, so it's never half undone, and running
 * it again goes on (the ones deleted are off the list).
 */
export async function revertWorkspaceMigration(): Promise<{ deleted: number; kept: number }> {
  const mig = getState().orgoMigration;
  if (!mig) return { deleted: 0, kept: 0 };
  let deleted = 0;
  let kept = 0;
  for (const pid of [...mig.created]) {
    const left = await projectComputers(pid).catch((e: unknown) => (e instanceof OrgoError && e.status === 404 ? "gone" : null));
    if (left === null) throw new Error(`Orgo didn't say what's in ${pid.slice(0, 8)}; nothing was undone yet. Try again.`);
    if (left !== "gone" && left.length) {
      kept++;
      continue;
    }
    if (left !== "gone") await deleteProject(pid);
    deleted++;
    update((s) => {
      if (s.orgoMigration) s.orgoMigration.created = s.orgoMigration.created.filter((x) => x !== pid);
    });
  }
  // The default's project goes back to the name "bops", which every app before the move finds it by.
  const mainProject = getState().workspaces?.find((w) => w.id === MAIN_WORKSPACE)?.orgoProjectId;
  if (mainProject) {
    const now = (await ownedWorkspaces()).find((p) => p.id === mainProject);
    // Another project has the name already (any case): it stays, and the apps find that one.
    if (now && !isBopsName(now.name))
      await renameProject(mainProject, "bops").catch((e: Error) => {
        if (!nameTaken(e)) throw e;
        console.warn(`[workspaces] the default's project ${mainProject.slice(0, 8)} keeps its name: ${e.message}`);
      });
  }
  for (const w of getState().workspaces ?? []) {
    if (!w.orgoProjectId) continue;
    const from = folderKey(w);
    update((s) => {
      const x = s.workspaces?.find((y) => y.id === w.id);
      if (!x) return;
      delete x.orgoProjectId;
      delete x.orgoName;
      delete x.orgoUpdatedAt;
    });
    moveWorkspaceFolder(from, folderKey({ id: w.id }));
  }
  update((s) => {
    delete s.orgoMigration;
    // Never run again by itself (bops_ws_id stays tied on Orgo, which has no way to untie): the one "bops" project from now on.
    s.orgoMigrationRevertedAt = new Date().toISOString();
    const main = s.workspaces?.find((x) => x.id === MAIN_WORKSPACE);
    // "bops" was "Main" before the move.
    if (main && main.name === "bops") main.name = "Main";
  });
  return { deleted, kept };
}

/** The user saw the switcher's note about names Orgo already had: it isn't shown again. */
export function dismissRenamedNotice() {
  update((s) => {
    if (s.orgoMigration?.renamed?.length) s.orgoMigration.renamed = [];
  });
}

/** What Settings shows of the move: names changed because Orgo had them, and the default's name waiting for the apps. */
export function migrationNotice() {
  const m = getState().orgoMigration;
  return m ? { renamed: m.renamed ?? [], defaultWaits: m.defaultRename ?? null } : null;
}

/** Delete a workspace's Orgo workspace with everything in it (after the user confirmed deletePreview's list). Throws Orgo's refusal, in its words. */
export async function deleteOrgoWorkspace(w: Pick<Workspace, "id" | "name" | "orgoProjectId">) {
  if (!w.orgoProjectId) return;
  try {
    await deleteProject(w.orgoProjectId);
  } catch (e) {
    // Already gone on Orgo (deleted on orgo.ai): nothing left to delete there.
    if (e instanceof OrgoError && e.status === 404) return;
    const said = e instanceof OrgoError ? e.said || (typeof e.code === "string" ? e.code : "") : "";
    throw new WorkspaceError(`Orgo didn't delete ${w.name}, so it's still here${said ? `: ${said}` : ". Try again."}`, 502);
  }
}
