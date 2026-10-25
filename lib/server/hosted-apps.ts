import "server-only";
import { appsOpen } from "@/lib/apps-access";
import { routineSent, workBot, workspaceOf, type Session, type Workspace } from "@/lib/types";
import type { AppCommit, AppCommitsAnswer, AppHosting, DeployState, HostedApp, HostedAppsAnswer } from "@/lib/hosted-apps";
import { deployedAt, deploys, OrgoError, type OrgoDeployment, type OrgoDeployProject } from "./orgo";
import { loadOrgoKey } from "./orgo-auth";
import { selfHosted } from "./persist";
import { appFolder, authorOf, dropToken, ensureIngotCli, hasToken, ingot, INGOT_MCP, IngotError, ingotWorkspace, isRepoName, msOf, NO_PROJECT, readyFolder, repoNameFor, type IngotRepo } from "./ingot";
import { bot, getState, ownerName, session, update } from "./store";

/**
 * Apps a workspace builds and runs on the web (lib/hosted-apps.ts). Each one is an Ingot repo in the
 * central Ingot, under the workspace's Orgo project (ingot.ts), kept on the workspace by name
 * (Workspace.hostedApps: the bot that works on it and its computer, and its deploy project and URL once
 * deployed). This Mac reads and makes repos there itself, with the user's Orgo key: no computer is asked.
 *
 * A bot works on one through work_on_app (chat.ts): a task on its computer, on whatever brain the bot has
 * (Claude Code, Codex, or Bops agent), in the app's working folder /workspace/apps/<name>. As the task
 * starts, the folder is made ready there (readyAppForTask: the ingot command and its config there, with
 * the computer's own agent token for the workspace, the repo made if it's new, then `ingot clone` or
 * `ingot pull`), and a brain's thread gets Ingot's MCP tools (appMcp). The task commits with `ingot
 * commit`, or plain git (`ingot setup-git` made `ingot credential` git's helper there); two commits at
 * once can't overwrite each other (a stale one is refused, and `ingot pull` merges). Every repo is named
 * in full ("<project>/<name>"), as a computer may work for more than one workspace. Once no app of the
 * workspace is on a computer, its token there is revoked (keepHosting).
 *
 * Deploying builds one changeset on that computer with orgo-web's deploy runner (orgo.ts deploys, source
 * "ingot", exported there with the computer's token for the workspace): the first deploy makes the app's deploy
 * project there, every one after it queues a changeset (the newest on main by default, an older one to go
 * back to it). The site is public at its URL.
 */

/** A request about the workspace's apps turned down, in plain words, with the HTTP status the routes answer. */
export class HostedAppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const g = globalThis as unknown as {
  bopsHostingProbes?: Map<string, { at: number; why?: string }>;
  /** Each workspace's repos as Ingot listed them last, and when: the Apps page reads them every few seconds while a deploy runs. */
  bopsIngotListed?: Map<string, { at: number; repos: IngotRepo[] }>;
};

/** A changeset's id: the sha256 of its canonical JSON. */
const CHANGESET = /^[0-9a-f]{64}$/;

const workspace = (wsId: string): Workspace | undefined => getState().workspaces?.find((w) => w.id === wsId);
const hostingOf = (wsId: string, name: string): AppHosting | undefined => workspace(wsId)?.hostedApps?.[name];
const mainBot = (wsId: string) => getState().bots.find((b) => b.isMain && workspaceOf(b) === wsId);

/** The Orgo computer a bot's work runs on (its own, or the one it shares). */
const computerOf = (botId: string) => {
  const b = bot(botId);
  return b ? workBot(b, getState().bots).computerId : undefined;
};

/**
 * Keep where an app is worked on and runs (Workspace.hostedApps), or drop it (`fn` answers undefined). The
 * computer it leaves, when no app of the workspace is on it anymore, has its token revoked (best effort).
 */
function keepHosting(wsId: string, name: string, fn: (h: AppHosting | undefined) => AppHosting | undefined) {
  let left: string | undefined;
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (!w) return;
    const was = w.hostedApps?.[name]?.computerId;
    const next = fn(w.hostedApps?.[name]);
    if (next) w.hostedApps = { ...(w.hostedApps ?? {}), [name]: next };
    else if (w.hostedApps?.[name]) {
      const { [name]: _gone, ...rest } = w.hostedApps;
      void _gone;
      w.hostedApps = rest;
    }
    if (was && !Object.values(w.hostedApps ?? {}).some((h) => h.computerId === was)) left = was;
  });
  if (left) void dropToken(wsId, left);
}

/* ---------------- Reading Ingot ---------------- */

const LIST_MS = 5000;
const listed = (g.bopsIngotListed ??= new Map());

/** The workspace's repos, or null when Ingot can't say now (it isn't answering, the workspace isn't on Orgo yet, no one is signed in). */
async function reposOf(wsId: string): Promise<IngotRepo[] | null> {
  const kept = listed.get(wsId);
  if (kept && Date.now() - kept.at < LIST_MS) return kept.repos;
  const repos = await ingot.repos(wsId).catch(() => null);
  if (repos) listed.set(wsId, { at: Date.now(), repos });
  return repos;
}

/* ---------------- Whether deploying can work ---------------- */

/** Why deploying can't work from this Bops before Orgo is asked (undefined: it can, as far as Bops knows). */
async function closedHere(): Promise<string | undefined> {
  if (await loadOrgoKey().catch(() => null)) return undefined;
  return selfHosted() ? "This Bops runs on its own Orgo key. Sign in with Orgo to put apps on the web." : "Sign in with Orgo to put apps on the web.";
}

/** Orgo's answer to a probe of the workspace's main computer, kept a minute: whether hosting is open to this account. */
const probes = (g.bopsHostingProbes ??= new Map<string, { at: number; why?: string }>());
const PROBE_MS = 60_000;

/**
 * Whether hosting is open to this account, asked of the workspace's main computer (a minute's answer is
 * kept). Undefined: open, or it couldn't be told (no computer yet, Orgo not answering): a deploy says then.
 */
async function probe(wsId: string): Promise<string | undefined> {
  const m = mainBot(wsId);
  const computerId = m ? computerOf(m.id) : undefined;
  if (!computerId) return undefined;
  const kept = probes.get(computerId);
  if (kept && Date.now() - kept.at < PROBE_MS) return kept.why;
  const got = await deploys.projects(computerId).catch(() => null);
  if (!got) return undefined;
  const why = got.enabled ? undefined : got.why;
  probes.set(computerId, { at: Date.now(), why });
  return why;
}

/* ---------------- The Apps page ---------------- */

/** Its newest deploy, as orgo-web lists them. */
const newest = (p: OrgoDeployProject): OrgoDeployment | undefined =>
  [...(p.deployments ?? []), ...(p.current ? [p.current] : [])].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0];

const liveOf = (d: OrgoDeployment, url: string | null): NonNullable<HostedApp["live"]> => ({
  id: d.id,
  at: deployedAt(d),
  state: (d.state ?? null) as DeployState | null,
  when: msOf(d.finished_at ?? d.created_at),
  error: d.error ?? null,
  url,
});

/** The changeset a project's site serves now: its live deploy's, as Orgo says. */
const servingOf = (p: OrgoDeployProject) => deployedAt(p.current);

/**
 * GET /api/hosted-apps: the workspace's apps (Workspace.hostedApps), each with its newest changeset as
 * Ingot says (`offline` when Ingot can't say now), and its newest deploy and what its site serves, as
 * orgo-web says. `enabled` false with why when deploying can't work here; the apps are listed all the same.
 */
export async function listApps(wsId: string): Promise<HostedAppsAnswer> {
  const ws = workspace(wsId);
  if (!ws) throw new HostedAppError("That workspace is gone.", 404);
  const kept = Object.entries(ws.hostedApps ?? {}).filter(([name]) => isRepoName(name));
  const why = await closedHere();
  const on = kept.length ? await reposOf(wsId) : [];
  let closed: string | undefined;
  const apps = await Promise.all(
    kept.map(async ([name, h]): Promise<HostedApp> => {
      const repo = on?.find((r) => r.name === name);
      const base: HostedApp = { name, head: repo?.head ?? null, updatedAt: msOf(repo?.updated_at), hosting: h, serving: null, live: null, ...(on ? {} : { offline: true as const }) };
      if (why || !h.projectId) return base;
      const got = await deploys.project(h.computerId, h.projectId).catch(() => null);
      if (!got?.enabled) {
        if (got) closed = got.why;
        return base;
      }
      const url = got.value.url;
      if (url && url !== h.url) keepHosting(wsId, name, (x) => x && { ...x, url });
      const d = newest(got.value);
      return { ...base, hosting: hostingOf(wsId, name) ?? h, live: d ? liveOf(d, url ?? h.url ?? null) : null, serving: servingOf(got.value) };
    }),
  );
  apps.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name));
  if (why) return { enabled: false, why, apps };
  if (!closed && !kept.some(([, h]) => h.projectId)) closed = await probe(wsId);
  return closed ? { enabled: false, why: closed, apps } : { enabled: true, apps };
}

/** How many files a changeset's changes list (Ingot gives the paths, or how many). */
const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" && v >= 0 ? Math.floor(v) : 0);

/**
 * GET /api/hosted-apps/[name]/commits: the app's changesets on main, newest first (older than `before`),
 * from Ingot, each marked when its site serves it. `offline` only when Ingot can't be reached: no computer
 * is asked, so one asleep changes nothing.
 */
export async function appCommits(wsId: string, name: string, before: string | null): Promise<AppCommitsAnswer> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  if (before && !CHANGESET.test(before)) throw new HostedAppError("That isn't a changeset of it.", 400);
  if (!workspace(wsId)?.orgoProjectId) throw new HostedAppError(NO_PROJECT, 409);
  let log: Awaited<ReturnType<typeof ingot.log>>;
  let head: string | null | undefined;
  try {
    [log, head] = await Promise.all([ingot.log(wsId, name, before ? { before } : {}), ingot.head(wsId, name)]);
  } catch (e) {
    if (e instanceof IngotError && e.offline) return { commits: [], head: null, next: null, offline: true };
    if (e instanceof IngotError) throw new HostedAppError(e.message, 502);
    throw e;
  }
  // No such repo yet (its first task hasn't started): nothing committed.
  if (!log) return { commits: [], head: null, next: null };
  const p = h.projectId ? await deploys.project(h.computerId, h.projectId).catch(() => null) : null;
  const serving = p?.enabled ? servingOf(p.value) : null;
  const commits = log.changesets.map(
    (c): AppCommit => ({
      id: c.id,
      message: typeof c.message === "string" ? c.message : "",
      author: c.author?.name || c.author?.id || "",
      at: msOf(c.at) ?? 0,
      changes: { added: count(c.changes?.added), modified: count(c.changes?.modified), deleted: count(c.changes?.deleted) },
      serving: c.id === serving,
    }),
  );
  return { commits, head: head ?? null, next: log.next };
}

/* ---------------- Deploying ---------------- */

/** Orgo turned a deploy call down: its own words when it said why (a paid plan needed, hosting blocked), else ours. */
const refused = (e: unknown) =>
  e instanceof OrgoError ? new HostedAppError(e.said ? `Orgo says: ${e.said}` : "Orgo didn't take that. Try again in a minute.", e.status >= 400 && e.status < 500 ? e.status : 502) : e;

/**
 * A deploy project's name on Orgo, which its public URL takes: the repo's name, cut to the 32 characters
 * Orgo allows, with a number after it (`n` from 2) when that name is taken on the computer.
 */
function deployName(name: string, n = 1): string {
  const tail = n > 1 ? `-${n}` : "";
  return `${name.slice(0, 32 - tail.length).replace(/-+$/, "") || "app"}${tail}`;
}

/** The first port an app's project listens on; each project on a computer takes the next one free. */
const FIRST_PORT = 3000;

/** An app's Ingot repo as orgo-web's deploy runner takes it: "<project>/<name>" (409 when the workspace isn't on Orgo yet). */
function ingotRepo(wsId: string, name: string): string {
  try {
    return `${ingotWorkspace(wsId)}/${name}`;
  } catch (e) {
    throw e instanceof IngotError ? new HostedAppError(e.message, 409) : e;
  }
}

/**
 * Make the app's deploy project on the computer it's worked on (source "ingot", the repo as
 * "<project>/<name>"), and keep it. It names no changeset: one there would be built by every deploy that names none after it, and
 * those build the newest on main. A project already there for this repo (orgo-web's ingot_repo: a deploy
 * sent twice, or one this Mac lost track of) is the one. A new one gets a name and a port no other project
 * there has; one Orgo still finds taken (an app on the computer itself has it) moves on to the next.
 */
async function makeProject(wsId: string, name: string, h: AppHosting): Promise<AppHosting> {
  const keep = (p: OrgoDeployProject) => {
    const next: AppHosting = { botId: h.botId, computerId: h.computerId, projectId: p.id, ...(p.url ? { url: p.url } : {}) };
    keepHosting(wsId, name, () => next);
    return next;
  };
  const repo = ingotRepo(wsId, name);
  const there = await deploys.projects(h.computerId).catch((e: unknown) => Promise.reject(refused(e)));
  if (!there.enabled) throw new HostedAppError(there.why, 403);
  const projects = there.value.projects ?? [];
  const mine = projects.find((p) => p.source === "ingot" && p.ingot_repo?.toLowerCase() === repo);
  if (mine) return keep(mine);
  const names = new Set(projects.map((p) => p.name));
  const ports = new Set(projects.map((p) => p.port));
  let n = 1;
  let port = FIRST_PORT;
  for (let tries = 0; ; tries++) {
    while (names.has(deployName(name, n))) n++;
    while (ports.has(port)) port++;
    const project = deployName(name, n);
    const made = await deploys.create(h.computerId, { repo, name: project, port }).catch((e: unknown) => e as Error);
    if (made instanceof OrgoError && tries < 5 && made.code === "NAME_TAKEN") names.add(project);
    else if (made instanceof OrgoError && tries < 5 && made.code === "PORT_TAKEN") ports.add(port);
    else if (made instanceof OrgoError && (made.code === "PROJECT_LIMIT" || made.code === "SERVICE_LIMIT"))
      throw new HostedAppError(`${bot(h.botId)?.name ?? "That bot"}'s computer already runs as many apps as one computer can.`, 409);
    else if (made instanceof Error) throw refused(made);
    else if (!made.enabled) throw new HostedAppError(made.why, 403);
    else return keep(made.value);
  }
}

/** Orgo no longer has the project (removed there, or its computer is gone). */
const gone = (e: unknown) => e instanceof OrgoError && e.status === 404 && (!e.code || e.code === "NOT_FOUND");

/**
 * Deploy changeset `at` of an app (the newest on main by default) on the computer it's worked on: the first
 * time, its deploy project is made there and kept (on `botId`'s computer, or the main bot's, when the
 * workspace has no record of the app yet). A project Orgo no longer has is made again. A computer with no
 * token of the workspace's yet gets one first (ensureIngotCli), as the deploy runner exports the repo
 * there with it. Answers the app as it is now, with the deploy Orgo queued.
 */
export async function deployApp(wsId: string, name: string, opts: { at?: string; botId?: string } = {}): Promise<{ app: HostedApp; deployment: OrgoDeployment }> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  if (!isRepoName(name)) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  if (opts.at !== undefined && !CHANGESET.test(opts.at)) throw new HostedAppError("That isn't a changeset of it.", 400);
  const why = await closedHere();
  if (why) throw new HostedAppError(why, 403);
  let h = hostingOf(wsId, name);
  if (!h) {
    const b = opts.botId ? bot(opts.botId) : mainBot(wsId);
    if (!b || workspaceOf(b) !== wsId) throw new HostedAppError("That bot isn't in this workspace.", 404);
    const computerId = computerOf(b.id);
    if (!computerId) throw new HostedAppError(`${b.name} has no computer yet, so there's nothing of ${name} to deploy.`, 409);
    h = { botId: b.id, computerId };
    keepHosting(wsId, name, () => h);
  }
  if (!hasToken(wsId, h.computerId))
    await ensureIngotCli(h.computerId, wsId, { botId: h.botId }).catch((e: unknown) =>
      Promise.reject(e instanceof IngotError ? new HostedAppError(`Couldn't set Ingot up on the app's computer: ${e.message}`, e.offline ? 503 : 502) : e),
    );
  if (!h.projectId) h = await makeProject(wsId, name, h);
  const queue = (x: AppHosting) => deploys.deploy(x.computerId, x.projectId!, opts.at).catch((e: unknown) => e as Error);
  let got = await queue(h);
  if (gone(got)) {
    // The project is gone on Orgo: made again on the same computer.
    h = await makeProject(wsId, name, { botId: h.botId, computerId: h.computerId });
    got = await queue(h);
  }
  if (got instanceof Error) throw refused(got);
  if (!got.enabled) throw new HostedAppError(got.why, 403);
  const d = got.value;
  // A window showing the app reads it again (a bot's deploy changes nothing else it watches).
  keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
  const now = hostingOf(wsId, name) ?? h;
  const repo = (await reposOf(wsId))?.find((r) => r.name === name);
  // What it serves meanwhile isn't in this answer: the window keeps what it read last (null here).
  const app: HostedApp = {
    name,
    head: repo?.head ?? null,
    updatedAt: msOf(repo?.updated_at),
    hosting: now,
    serving: null,
    live: { ...liveOf(d, now.url ?? null), at: deployedAt(d) ?? opts.at ?? repo?.head ?? null, state: d.state ?? "queued", when: msOf(d.created_at) ?? Date.now() },
  };
  return { app, deployment: d };
}

/** A log cursor the window hands back: the deploy it's for and the last line read ("<deployId>:<n>"), or a bare line number. */
function cursorOf(after: string | null): { id?: string; n: number } {
  const m = /^(?:([\w-]{1,80}):)?(\d{1,9})$/.exec(after ?? "");
  return m ? { id: m[1], n: Number(m[2]) } : { n: 0 };
}

/**
 * GET /api/hosted-apps/[name]/logs: the newest deploy's build log after `after`, from orgo-web's record (it
 * never wakes the computer). A cursor from an older deploy reads the newest one from its start.
 */
export async function appLog(wsId: string, name: string, after: string | null): Promise<{ state: DeployState | null; log: string; next: string | null; more: boolean }> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  const none = { state: null, log: "", next: null, more: false };
  if (!h.projectId) return none;
  const p = await deploys.project(h.computerId, h.projectId).catch((e: unknown) => Promise.reject(refused(e)));
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  const d = newest(p.value);
  if (!d) return none;
  const at = cursorOf(after);
  const from = at.id && at.id !== d.id ? 0 : at.n;
  const l = await deploys.logs(h.computerId, d.id, from).catch((e: unknown) => Promise.reject(refused(e)));
  if (!l.enabled) throw new HostedAppError(l.why, 403);
  return { state: l.value.state ?? d.state, log: l.value.log ?? "", next: `${d.id}:${Number(l.value.next) || from}`, more: !!l.value.more };
}

/* ---------------- What a bot does with them ---------------- */

/** One of the workspace's apps by its name, or the name its words make ("Recipe Box": recipe-box). */
function appNamed(wsId: string, words: string): string | undefined {
  const apps = workspace(wsId)?.hostedApps ?? {};
  const want = words.trim().replace(/^["“']|["”']$/g, "");
  if (isRepoName(want) && apps[want]) return want;
  const made = repoNameFor(want);
  return apps[made] ? made : undefined;
}

/**
 * Who a bot's git commit (or a pull's merge) is from, as git's -c options in shell words: its name, and an
 * address that's no one's, as git wants both to commit (Ingot names what's pushed after the computer's
 * token, as it does its other writes).
 */
function gitAs(botId: string): string {
  const name = (bot(botId)?.name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim() || "Bops";
  return `-c user.name='${name.replace(/'/g, `'\\''`)}' -c user.email=${botId.replace(/[^A-Za-z0-9_.]/g, "") || "bops"}@bops.invalid`;
}

/** A changeset's short id, as the Apps page shows it. */
const short = (id: string) => id.slice(0, 7);

/**
 * work_on_app (chat.ts): the task a bot starts on its computer to build or change an app, by name (a new
 * one's from its words). The app is kept on the workspace with the bot and its computer (the task keeps
 * the computer as it starts when the bot has none yet). An app another bot of the workspace works on, on
 * another computer, is refused: its working folder and its site are on that computer. A workspace that
 * isn't on Orgo yet can't have apps (Ingot keeps its repos under its Orgo project).
 */
export function appWork(botId: string, a: { app: string | null; name: string | null; change: string }): { goal: string; title: string; name: string } {
  const b = bot(botId);
  if (!b) throw new HostedAppError("That bot is gone.", 404);
  const wsId = workspaceOf(b);
  const project = workspace(wsId)?.orgoProjectId;
  if (!project) throw new HostedAppError(NO_PROJECT, 409);
  const change = a.change.trim();
  if (!change) throw new HostedAppError("Say what to build or change.");
  let name: string;
  if (a.app?.trim()) {
    const found = appNamed(wsId, a.app);
    if (!found) throw new HostedAppError(`There's no app called "${a.app.trim().slice(0, 80)}" in this workspace.`, 404);
    name = found;
  } else {
    const words = (a.name ?? "").trim();
    if (!words) throw new HostedAppError("A new app needs its name.");
    name = repoNameFor(words);
  }
  const repo = ingotRepo(wsId, name);
  const computerId = computerOf(botId);
  const h = hostingOf(wsId, name);
  const other = h && h.botId !== botId ? bot(h.botId) : undefined;
  if (h && other && workspaceOf(other) === wsId && h.computerId !== computerId)
    throw new HostedAppError(`${name} is on ${other.name}'s computer, so it's ${other.name}'s to work on.`, 409);
  // Its record: this bot and its computer (a bot that's gone hands it on; another computer's project doesn't come along).
  if (computerId && (!h || h.computerId !== computerId || !bot(h.botId)))
    keepHosting(wsId, name, (x) => ({ botId, computerId, ...(x && x.computerId === computerId && x.projectId ? { projectId: x.projectId, ...(x.url ? { url: x.url } : {}) } : {}) }));
  const owner = ownerName();
  const dir = appFolder(name);
  const git = `git ${gitAs(botId)}`;
  const goal = [
    `Work on ${owner}'s app ${name}. It's the Ingot repo ${repo} (Ingot is Orgo's source control; name it in full wherever a command takes a repo), and its working folder on this computer is ${dir}: Bops cloned it there, or pulled the newest into it, as this task started.`,
    `What to do: ${change}`,
    "1. Make the change in that folder. An app that runs a server listens on the port in $PORT, which Orgo sets when it deploys it; a plain site needs only an index.html. Keep secrets out of the folder: .env files are never committed.",
    "2. Run it there to check it works (for a plain site, python3 -m http.server in the folder), look at it with curl or in the browser, then stop it.",
    `3. Commit it from the folder: ingot commit -m "<what changed, in one clear line>" (or the Ingot tools' repo_commit). If Ingot says the commit is stale, someone committed first: run ingot pull, fix any file it lists between its <<<<<<< yours and >>>>>>> theirs markers, check it again, and commit again.`,
    `Plain git works too, if you'd rather, in a clone of its own (never inside ${dir}): git clone "$(ingot git-url ${repo})" ${dir}-git, make the change and commit there (${git} commit), and git push origin HEAD:main. Ingot's credential helper is set up on this computer already, so git asks no password. A push refused as stale means someone committed first: ${git} pull --no-rebase, fix any file it lists as a conflict, ${git} commit, then push again. Both ways land on the same history.`,
    `4. Say what you changed. ${owner} puts it live from the Apps page, or by asking me.`,
  ].join("\n");
  return { goal, title: `Work on ${name}`, name };
}

/**
 * The app a task works on (Session.app, which only work_on_app sets), or undefined. Never on a routine's
 * run or a task someone outside Bops started, nor for an account apps aren't open to (lib/apps-access.ts).
 */
export function taskApp(s: Session | undefined): { wsId: string; name: string } | undefined {
  const b = s && bot(s.botId);
  if (!s?.app || !appsOpen(getState()) || !b || routineSent(s) || s.routineId || s.fromOutside || workspaceOf(b) !== s.app.wsId || !isRepoName(s.app.name)) return undefined;
  return s.app;
}

/**
 * Ingot's MCP tools for a brain's thread (sessions.ts brainTools), on a task that works on an app only,
 * with the app's workspace as the one a repo named without it is in (INGOT_WORKSPACE: root's config has
 * none, as the computer may work for more than one).
 */
export function appMcp(sessionId: string): Record<string, unknown> {
  const s = session(sessionId);
  const a = taskApp(s);
  if (!a) return {};
  let workspace: string;
  try {
    workspace = ingotWorkspace(a.wsId);
  } catch {
    return {};
  }
  return { ingot: { ...INGOT_MCP, args: [...INGOT_MCP.args], env: { INGOT_WORKSPACE: workspace } } };
}

/**
 * As a task on an app starts on its computer (sessions.ts): the ingot command and its config there, with
 * the computer's own token (ensureIngotCli), the app's repo made in Ingot when it's new, by the task's bot
 * (from this Mac), and its working folder cloned or brought to the newest main (readyFolder). The app is
 * kept on that computer. A token Ingot turned away there is replaced, the old one revoked, and the folder
 * made again. Answers what was done, for the task's steps (undefined: the task isn't on an app). Throws
 * IngotError when it can't be made ready.
 */
export async function readyAppForTask(sessionId: string, computerId: string, signal?: AbortSignal): Promise<string | undefined> {
  const s = session(sessionId);
  const a = taskApp(s);
  if (!s || !a) return undefined;
  await ensureIngotCli(computerId, a.wsId, { signal, botId: s.botId });
  const h = hostingOf(a.wsId, a.name);
  if (!h || h.computerId !== computerId) {
    if (h) console.warn(`[hosted-apps] ${a.name} moves from ${h.computerId} to ${computerId}: its bot's computer is another one now`);
    keepHosting(a.wsId, a.name, () => ({ botId: s.botId, computerId }));
  }
  await ingot.createRepo(a.wsId, a.name, authorOf(s.botId), signal);
  listed.delete(a.wsId);
  try {
    return await readyFolder(computerId, a.wsId, a.name, signal);
  } catch (e) {
    if (!(e instanceof IngotError && e.refused)) throw e;
    console.warn(`[hosted-apps] ${computerId}: Ingot turned its token away, so it gets a new one`);
    await ensureIngotCli(computerId, a.wsId, { signal, botId: s.botId, renew: true });
    return readyFolder(computerId, a.wsId, a.name, signal);
  }
}

/** How many pages of an app's log (200 each) a short id is looked for in. */
const LOOK_PAGES = 10;

/**
 * The whole id of a changeset of an app from what a bot gave: a whole one, or its start (4 to 63 hex, as
 * `ingot commit` and `ingot log` print it), looked up on main in Ingot. Refused when it's no changeset of
 * the app's, or the start of more than one, or Ingot can't be reached to look.
 */
async function wholeId(wsId: string, name: string, at: string): Promise<string> {
  if (CHANGESET.test(at)) return at;
  if (!/^[0-9a-f]{4,63}$/.test(at) || !hostingOf(wsId, name)) throw new HostedAppError("That isn't a changeset of it.", 400);
  const failed = (e: unknown) =>
    Promise.reject(
      e instanceof IngotError ? new HostedAppError(e.offline ? `Ingot isn't answering, so I can't look up which changeset ${at} is. Use its whole id.` : e.message, e.offline ? 503 : 502) : e,
    );
  let found: string | undefined;
  let before: string | undefined;
  for (let page = 0; page < LOOK_PAGES; page++) {
    const log = await ingot.log(wsId, name, { limit: 200, ...(before ? { before } : {}) }).catch(failed);
    for (const c of log?.changesets ?? []) {
      if (!c.id.startsWith(at) || c.id === found) continue;
      if (found) throw new HostedAppError(`${at} is the start of more than one changeset of it. Use more of its id.`, 400);
      found = c.id;
    }
    if (!log?.next) break;
    before = log.next;
  }
  if (!found) throw new HostedAppError("That isn't a changeset of it.", 400);
  return found;
}

/**
 * deploy_app, for a bot: changeset `at` of an app (the newest on main when null; its short id works too)
 * put on the web, in words for the model, with its public URL when there is one.
 */
export async function deployForBot(botId: string, app: string, at: string | null): Promise<string> {
  const b = bot(botId);
  if (!b) return "That bot is gone.";
  const wsId = workspaceOf(b);
  const name = appNamed(wsId, app);
  if (!name) return `There's no app called "${app.slice(0, 80)}" in this workspace.`;
  try {
    const id = at ? await wholeId(wsId, name, at) : undefined;
    const { app: now } = await deployApp(wsId, name, { ...(id ? { at: id } : {}), botId });
    const where = now.hosting ? bot(now.hosting.botId)?.name : undefined;
    const url = now.hosting?.url;
    const what = id ? `${name} at ${short(id)}` : `the newest commit of ${name}`;
    return `Deploying ${what}${where ? ` on ${where}'s computer` : ""}. ${url ? `It's live at ${url} in a minute or two.` : "It gets its public address once this first deploy is live, and the Apps page shows it then."}`;
  } catch (e) {
    if (e instanceof HostedAppError) return `Not deployed: ${e.message}`;
    throw e;
  }
}

/**
 * The workspace's apps for a bot's prompt, with where each is on the web (work_on_app, deploy_app). Empty
 * when it has none.
 */
export function hostedAppsLine(botId: string): string {
  const b = bot(botId);
  const apps = Object.entries((b && workspace(workspaceOf(b))?.hostedApps) ?? {}).filter(([name]) => isRepoName(name));
  if (!apps.length) return "";
  const one = ([name, h]: [string, AppHosting]) => {
    const on = h.botId !== botId ? bot(h.botId)?.name : undefined;
    return `${name} (${h.url ? `live at ${h.url}` : h.projectId ? "deployed, no address yet" : "not on the web yet"}${on ? `, on ${on}'s computer` : ""})`;
  };
  return `Your workspace's apps on the web, each an Ingot repo (work_on_app to build or change one, deploy_app to put it live): ${apps.map(one).join("; ")}.`;
}
