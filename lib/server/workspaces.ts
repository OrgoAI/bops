import "server-only";
import { botChatId, MAIN_WORKSPACE, sharesComputer, workspaceOf, type Bot, type OrgoMigration, type Workspace } from "@/lib/types";
import { freeBotId } from "./bots";
import { getState, id, stateEpoch, update } from "./store";
import { ensureInbox } from "./mail";
import {
  bindProject,
  callOrgo,
  collisionNames,
  deleteProject,
  ensureProject,
  moveComputer,
  nameTaken,
  OrgoError,
  ownedWorkspaces,
  perWorkspaceProjects,
  pickMainProject,
  projectComputers,
  renameProject,
  apiKey,
} from "./orgo";
import { folderKey, moveWorkspaceFolder, syncSkills } from "./workspace-skills";

/**
 * Workspaces: separate teams. Each has its own main bot (Boppy by default, who runs it and whose computer the
 * team's computers fork from), its bots, chats and work. The user's Mac and the Vault are shared.
 *
 * On an orgo-web with per workspace projects, each Bops workspace is an Orgo workspace of its own: a project
 * marked product "bops", tied to it by bops_ws_id (Workspace.orgoProjectId). New workspace makes the project,
 * Rename renames it, Delete deletes it once it's empty, and migrateWorkspacesToOrgo moves what was in the one
 * "bops" project into each workspace's own. On an Orgo without them (orgo-web before per workspace projects),
 * a workspace is this app's alone, as it always was: nothing is made, renamed, moved or deleted on Orgo.
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
  let orgoProjectId: string | undefined;
  if ((await perWorkspaceProjects().catch(() => null)) === true) {
    try {
      orgoProjectId = (await ensureProject(ws, { interactive: true, name: clean })).id;
    } catch (e) {
      if (nameTaken(e)) return { error: `You already have an Orgo workspace named ${clean}. Name this one`, code: "name_taken", suggestion: `${clean} (Bops)`.slice(0, NAME_MAX) };
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
    (s.workspaces ??= [{ id: MAIN_WORKSPACE, name: "Main", createdAt: Date.now() }]).push({ id: ws, name: clean, createdAt: Date.now(), ...(orgoProjectId ? { orgoProjectId } : {}) });
    s.bots.push(main);
    s.chats.push({ id: botChatId(mainId), kind: "bot", botIds: [mainId], createdAt: Date.now(), typing: [], workspaceId: ws });
    s.workspace = ws;
  });
  void ensureInbox(mainId).catch((e: Error) => console.warn(`[mail] inbox for ${mainId}: ${e.message}`));
  return { id: ws, chatId: botChatId(mainId), ...(orgoProjectId ? { orgoProjectId } : {}) };
}

/** Bops from before workspaces: if any bot has no workspace, make sure "Main" is listed. */
export function ensureMain() {
  const s = getState();
  if (s.workspaces?.some((w) => w.id === MAIN_WORKSPACE) || !s.bots.some((b) => !b.workspaceId)) return;
  update((x) => {
    x.workspaces = [{ id: MAIN_WORKSPACE, name: "Main", createdAt: 0 }, ...(x.workspaces ?? [])];
  });
}

/**
 * Rename a workspace, and its Orgo workspace when it has one: Orgo first, so a name the user's Orgo already
 * has is said back (`name_taken`) and nothing changes.
 */
export async function renameWorkspace(workspaceId: string, name: string): Promise<{ ok: true } | { error: string; code: "name_taken" | "orgo" }> {
  const clean = name.trim().slice(0, NAME_MAX);
  if (!clean) return { ok: true };
  const w = getState().workspaces?.find((x) => x.id === workspaceId);
  if (!w) return { ok: true };
  if (w.orgoProjectId && (await perWorkspaceProjects().catch(() => null)) === true) {
    try {
      await renameProject(w.orgoProjectId, clean);
    } catch (e) {
      if (nameTaken(e)) return { error: `You already have an Orgo workspace named ${clean}. Pick another name.`, code: "name_taken" };
      if (e instanceof OrgoError && e.status < 500) return { error: e.said || "Orgo didn't rename it.", code: "orgo" };
      return { error: "Couldn't reach Orgo to rename it. Try again.", code: "orgo" };
    }
  }
  update((s) => {
    const x = s.workspaces?.find((y) => y.id === workspaceId);
    if (x) x.name = clean;
  });
  return { ok: true };
}

export function switchWorkspace(workspaceId: string) {
  if (!getState().workspaces?.some((w) => w.id === workspaceId)) throw new Error("no such workspace");
  update((s) => (s.workspace = workspaceId));
}

/** The workspace the user is looking at. */
export const currentWorkspaceId = () => getState().workspace ?? MAIN_WORKSPACE;

/**
 * A deleted workspace's Orgo workspace goes too, but only when nothing is left in it (its team's computers
 * were deleted with it; one Orgo couldn't delete keeps it). Never on an Orgo without per workspace projects.
 */
export async function deleteOrgoProject(w: Pick<Workspace, "id" | "orgoProjectId">) {
  if (!w.orgoProjectId || (await perWorkspaceProjects().catch(() => null)) !== true) return false;
  const left = await projectComputers(w.orgoProjectId).catch(() => null);
  if (!left || left.length) return false;
  await deleteProject(w.orgoProjectId).catch((e: Error) => console.warn(`[workspaces] deleting ${w.id}'s Orgo workspace: ${e.message}`));
  return true;
}

/* ---------------- Moving onto Orgo workspaces ---------------- */

export type MigrationResult =
  /** An Orgo without per workspace projects (or none to tell by yet): nothing was done or sent. */
  | { status: "legacy" }
  | { status: "unreachable" }
  | { status: "done"; moved: number; pending: number; renamed: { wsId: string; from: string; to: string }[] }
  /** Another account signed in meanwhile: it stopped, and the next sign-in goes on. */
  | { status: "stopped" };

class Stopped extends Error {}

const g = globalThis as unknown as { bopsWsMigration?: Promise<MigrationResult> };

/** The steps, in order. Each is saved when done, so a stop goes on from the next one. */
const STEPS = ["bind-main", "bind-others", "members", "moves", "rename-default", "folders", "done"] as const;
type Step = (typeof STEPS)[number];
const after = (m: OrgoMigration | undefined, step: Step) => !!m && STEPS.indexOf(m.step as Step) > STEPS.indexOf(step);

/**
 * Each Bops workspace onto an Orgo workspace of its own (on sign-in, until done; .ops-kit/bops-workspaces/
 * DESIGN.md section 2): bind the default one to the "bops" project, give each other workspace with
 * computers its own project, copy the "bops" project's people to the new ones, move each bot's computer to
 * its workspace's project, rename the default, and move the skills folders. Saved after every step (and
 * every computer moved, logged before the move), so a stop or a crash resumes. A computer Orgo won't move
 * yet (in use, a Mac from the pool, enrolled) stays where it is and is tried again at the next sign-in
 * (`pending`); the free Bops computer never moves. On an Orgo without per workspace projects nothing is
 * written anywhere and the app goes on as before.
 */
export function migrateWorkspacesToOrgo(): Promise<MigrationResult> {
  return (g.bopsWsMigration ??= runMigration()
    .catch((e: unknown): MigrationResult => {
      if (e instanceof Stopped) return { status: "stopped" };
      console.warn(`[workspaces] moving onto Orgo workspaces (goes on at the next sign-in): ${(e as Error).message}`);
      return { status: "unreachable" };
    })
    .finally(() => (g.bopsWsMigration = undefined)));
}

async function runMigration(): Promise<MigrationResult> {
  const before = getState().orgoMigration;
  if (before?.doneAt && !before.pending.length) return { status: "done", moved: before.moves.length, pending: 0, renamed: before.renamed ?? [] };
  let on: boolean | null;
  try {
    on = await perWorkspaceProjects({ fresh: true });
  } catch {
    return { status: "unreachable" };
  }
  if (on !== true) return { status: "legacy" };
  const epoch = stateEpoch();
  const same = () => {
    if (stateEpoch() !== epoch) throw new Stopped();
  };
  const save = (fn: (m: OrgoMigration) => void) => {
    same();
    update((s) => {
      s.orgoMigration ??= { v: 1, step: STEPS[0], moves: [], pending: [], created: [] };
      fn(s.orgoMigration);
    });
  };
  const m = () => getState().orgoMigration;
  ensureMain();
  save(() => {});

  // 1. The default workspace: its stored project, the one tied to it, the Bops one (rule in DESIGN.md 9), or later.
  if (!after(m(), "bind-main")) {
    const owned = await ownedWorkspaces();
    same();
    const main = getState().workspaces?.find((w) => w.id === MAIN_WORKSPACE);
    const kept = main?.orgoProjectId && owned.some((w) => w.id === main.orgoProjectId) ? owned.find((w) => w.id === main.orgoProjectId) : undefined;
    const freeId = kept ? null : await import("./plan").then((p) => p.orgoPlan()).then((p) => p?.freeComputerId ?? null).catch(() => null);
    const pick = kept ?? pickMainProject(owned, freeId);
    if (pick) {
      if (pick.bops_ws_id !== MAIN_WORKSPACE) await callPatch(pick.id, { bops_ws_id: MAIN_WORKSPACE });
      same();
      bindProject(MAIN_WORKSPACE, pick.id);
    }
    save((x) => (x.step = "bind-others"));
  }

  // 2. Every other workspace, in the order they were made: the project tied to it, else one of its own when its team has a computer.
  if (!after(m(), "bind-others")) {
    const owned = await ownedWorkspaces();
    const others = [...(getState().workspaces ?? [])].filter((w) => w.id !== MAIN_WORKSPACE).sort((a, b) => a.createdAt - b.createdAt);
    for (const w of others) {
      same();
      if (w.orgoProjectId && owned.some((p) => p.id === w.orgoProjectId)) continue;
      const tied = owned.find((p) => p.bops_ws_id === w.id);
      if (tied) {
        bindProject(w.id, tied.id);
        continue;
      }
      // A workspace with no computers gets its project with its first one (orgo.ts orgoProjectFor).
      if (!getState().bots.some((b) => workspaceOf(b) === w.id && b.computerId && !sharesComputer(b))) continue;
      const made = await ensureProject(w.id);
      save((x) => {
        if (!x.created.includes(made.id)) x.created.push(made.id);
        if (made.renamed) (x.renamed ??= []).push({ wsId: w.id, from: w.name, to: made.name });
      });
    }
    save((x) => (x.step = "members"));
  }

  // 3. The people of the "bops" project reach every workspace's computers today: each new project gets them too.
  if (!after(m(), "members")) {
    const main = getState().workspaces?.find((w) => w.id === MAIN_WORKSPACE)?.orgoProjectId;
    const key = await apiKey().catch(() => "");
    if (main && key)
      for (const to of m()?.created ?? []) {
        same();
        // orgo-web copies them as they are (role kept, accepted for them, anyone already there skipped). An
        // orgo-web without the route answers 404: nobody is invited by email instead.
        const r = await callOrgo<{ copied?: number }>(key, `/api/workspaces/${encodeURIComponent(to)}/members/copy`, { method: "POST", body: { from: main } });
        if (r && r.status >= 500) throw new Error(`copying people to ${to.slice(0, 8)}: ${r.status}`);
      }
    save((x) => (x.step = "moves"));
  }

  // 4. Each bot's own computer into its workspace's project. The free computer stays (its workspace's main bots share it).
  if (!after(m(), "moves") || m()?.pending.length) {
    await moveComputers(same, save);
    if (!after(m(), "moves")) save((x) => (x.step = "rename-default"));
  }

  // 5. The default workspace's name: "Main" left as it was is "bops" (its project's name); a name the user gave it goes to its project.
  if (!after(m(), "rename-default")) {
    const main = getState().workspaces?.find((w) => w.id === MAIN_WORKSPACE);
    if (main && /^main$/i.test(main.name.trim()))
      update((s) => {
        const x = s.workspaces?.find((w) => w.id === MAIN_WORKSPACE);
        if (x) x.name = "bops";
      });
    else if (main?.orgoProjectId) {
      const owned = await ownedWorkspaces();
      const now = owned.find((w) => w.id === main.orgoProjectId);
      if (now && now.name.trim().toLowerCase() !== main.name.trim().toLowerCase()) {
        const taken = new Set(owned.filter((w) => w.id !== now.id).map((w) => w.name.trim().toLowerCase()));
        for (const n of collisionNames(main.name.trim())) {
          if (taken.has(n.toLowerCase())) continue;
          try {
            await renameProject(now.id, n);
            if (n !== main.name.trim()) save((x) => (x.renamed ??= []).push({ wsId: MAIN_WORKSPACE, from: main.name, to: n }));
            break;
          } catch (e) {
            if (!nameTaken(e)) throw e;
          }
        }
      }
    }
    save((x) => (x.step = "folders"));
  }

  // 6. Skills folders from each workspace's Bops id to its project's (bindProject moves them as it binds; this catches any left).
  if (!after(m(), "folders")) {
    for (const w of getState().workspaces ?? []) if (w.orgoProjectId) moveWorkspaceFolder(w.id, folderKey(w));
    save((x) => {
      x.step = "done";
      x.doneAt = new Date().toISOString();
    });
    for (const w of getState().workspaces ?? []) if (w.orgoProjectId) void syncSkills(w.id).catch((e: Error) => console.warn(`[skills] sync after the move: ${e.message}`));
  }
  const end = m()!;
  return { status: "done", moved: end.moves.length, pending: end.pending.length, renamed: end.renamed ?? [] };
}

/** PATCH a project, saying back only that it failed. */
async function callPatch(projectId: string, body: Record<string, unknown>) {
  const key = await apiKey();
  const r = await callOrgo(key, `/api/workspaces/${encodeURIComponent(projectId)}`, { method: "PATCH", body });
  if (!r || r.status >= 500) throw new Error(`tying ${projectId.slice(0, 8)}: ${r?.status ?? "no answer"}`);
}

/** Where each own computer is on Orgo now, and where it belongs; moved when they differ (DESIGN.md step 6). */
async function moveComputers(same: () => void, save: (fn: (m: OrgoMigration) => void) => void) {
  let moved = 0;
  const key = await apiKey();
  const bots = getState().bots.filter((b) => b.computerId && !sharesComputer(b) && !b.freeComputer);
  for (const b of bots) {
    same();
    const to = getState().workspaces?.find((w) => w.id === workspaceOf(b))?.orgoProjectId;
    const computerId = b.computerId!;
    if (!to) continue;
    const at = await callOrgo<{ project_id?: string; workspace_id?: string }>(key, `/api/computers/${encodeURIComponent(computerId)}`);
    if (!at) throw new Error("Orgo didn't answer");
    // Gone, or not this account's: nothing to move, and nothing made for it.
    if (at.status === 404 || at.status === 403) {
      save((x) => (x.pending = x.pending.filter((p) => p !== computerId)));
      continue;
    }
    if (at.status !== 200) continue;
    const from = at.json.workspace_id ?? at.json.project_id;
    if (!from || from === to) {
      save((x) => (x.pending = x.pending.filter((p) => p !== computerId)));
      continue;
    }
    // Logged before it moves, for a rollback (an entry for one Orgo said no to is taken off again; one whose
    // answer never came stays, since Orgo may have moved it).
    save((x) => {
      const last = x.moves[x.moves.length - 1];
      if (!(last && last.computerId === computerId && last.from === from && last.to === to)) x.moves.push({ computerId, from, to });
    });
    try {
      await moveComputer(computerId, to);
      moved++;
      save((x) => (x.pending = x.pending.filter((p) => p !== computerId)));
    } catch (e) {
      if (e instanceof OrgoError && e.status === 400 && /already in this workspace/i.test(e.said ?? e.message)) {
        save((x) => (x.pending = x.pending.filter((p) => p !== computerId)));
        continue;
      }
      const status = e instanceof OrgoError ? e.status : 0;
      if (status < 400 || status >= 500) throw e;
      save((x) => {
        const i = x.moves.findLastIndex((mv) => mv.computerId === computerId && mv.to === to);
        if (i >= 0) x.moves.splice(i, 1);
        // Busy, a pool Mac, enrolled, moved meanwhile, or not allowed: it stays, and is tried at the next sign-in.
        if ((status === 409 || status === 403) && !x.pending.includes(computerId)) x.pending.push(computerId);
      });
    }
  }
  return moved;
}

/**
 * Undo migrateWorkspacesToOrgo (DESIGN.md section 8): every computer it moved goes back where it was, newest
 * first; the Orgo workspaces it made are deleted when they're empty; each workspace forgets its project
 * (its skills folder goes back to its Bops id). People it copied stay until the owner decides.
 */
export async function revertWorkspaceMigration(): Promise<{ movedBack: number; deleted: number; kept: number }> {
  const mig = getState().orgoMigration;
  if (!mig) return { movedBack: 0, deleted: 0, kept: 0 };
  let movedBack = 0;
  for (const mv of [...mig.moves].reverse()) {
    try {
      await moveComputer(mv.computerId, mv.from);
      movedBack++;
    } catch (e) {
      if (e instanceof OrgoError && e.status === 400 && /already in this workspace/i.test(e.said ?? e.message)) movedBack++;
      else if (!(e instanceof OrgoError && e.status === 404)) throw e;
    }
    update((s) => {
      const list = s.orgoMigration?.moves;
      const i = list?.findLastIndex((y) => y.computerId === mv.computerId && y.from === mv.from && y.to === mv.to) ?? -1;
      if (list && i >= 0) list.splice(i, 1);
    });
  }
  let deleted = 0;
  let kept = 0;
  for (const pid of mig.created) {
    const left = await projectComputers(pid).catch(() => null);
    if (left && !left.length) {
      await deleteProject(pid);
      deleted++;
    } else kept++;
  }
  for (const w of getState().workspaces ?? []) {
    if (!w.orgoProjectId) continue;
    const from = folderKey(w);
    update((s) => {
      const x = s.workspaces?.find((y) => y.id === w.id);
      if (x) delete x.orgoProjectId;
    });
    moveWorkspaceFolder(from, folderKey({ id: w.id }));
  }
  update((s) => {
    delete s.orgoMigration;
    const main = s.workspaces?.find((x) => x.id === MAIN_WORKSPACE);
    // "bops" was "Main" before the move.
    if (main && main.name === "bops") main.name = "Main";
  });
  return { movedBack, deleted, kept };
}

/** What Settings shows of the move: computers Orgo hasn't moved yet, and names changed because Orgo had them. */
export function migrationNotice() {
  const m = getState().orgoMigration;
  return m ? { pending: m.pending.length, renamed: m.renamed ?? [] } : null;
}

