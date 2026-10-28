import "server-only";
import { appsOpen } from "@/lib/apps-access";
import { botChatId, live as isLive, routineSent, workBot, workspaceOf, type Session, type Workspace } from "@/lib/types";
import { DNS_TYPES, dnsNeeds, ENV_NAME, ENV_RESERVED, isSiteName, MAX_SITES, REGISTRANT_FIELDS } from "@/lib/hosted-apps";
import type {
  AddAppAnswer,
  AppCommit,
  AppCommitsAnswer,
  AppDeploy,
  AppDnsInput,
  AppDnsRecord,
  AppDnsWritten,
  AppDnsZone,
  AppDomain,
  AppDomainAdded,
  AppDomainChecked,
  AppDomainOptions,
  AppDomainsAnswer,
  AppHosting,
  AppProjectBehind,
  AppRenewal,
  AppSettingsAnswer,
  DeployState,
  DomainOffer,
  DomainSearchAnswer,
  HostedApp,
  HostedAppsAnswer,
  HostedSite,
  Registrant,
  RemoveAppAnswer,
  SiteDomain,
} from "@/lib/hosted-apps";
import {
  deployedAt,
  deploys,
  domains,
  OrgoError,
  OrgoTimeout,
  type OrgoBoughtDomain,
  type OrgoBoughtList,
  type OrgoCustomDomain,
  type OrgoDeployment,
  type OrgoDeployProject,
  type OrgoDnsRecord,
  type OrgoRecordInput,
  type OrgoZone,
} from "./orgo";
import { loadOrgoKey } from "./orgo-auth";
import { selfHosted } from "./persist";
import { appFolder, authorOf, dropToken, ensureIngotCli, hasToken, ingot, INGOT_MCP, IngotError, ingotWorkspace, isRepoName, msOf, NO_PROJECT, readyFolder, repoNameFor, stillOurs, SWAPPED, type IngotRepo } from "./ingot";
import { addMessage, bot, flushState, getState, ownerName, sameState, session, update } from "./store";

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
 *
 * An app can run as more than one site (AppHosting.sites: one repo holding a few apps, each started its
 * own way): each is a deploy project of its own on the same computer, from the same repo, with its own
 * name, port, variables and domains. Deploy deploys them all, one after another (Orgo builds one at a time
 * on a computer), or one of them. The app's own site is the one named as the app, and every route about
 * one site names it by `site`, none meaning the app's own, so an app with one site is as it always was.
 * An app can be removed (its sites and their domains off its computer, its record dropped, its repo
 * deleted too only when asked); one whose computer is gone (appsComputerGone) keeps its record, marked lost,
 * until a deploy or a bot's work on it gives it a new home.
 */

/**
 * A request about the workspace's apps turned down, in plain words, with the HTTP status the routes answer.
 * `extra` goes along in the answer for the window: the field a DNS record got wrong, or the records as
 * they are now when they changed since the window read them.
 */
export class HostedAppError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Work on an app is the account's that began it (`ours`: store.ts sameState): once another account's state came
 * in meanwhile, it stops before its next Orgo or Ingot call or write (ingot.ts stillOurs), with a 409.
 */
function held(ours: () => boolean) {
  if (!ours()) throw new HostedAppError(SWAPPED, 409);
}

const g = globalThis as unknown as {
  bopsHostingProbes?: Map<string, { at: number; why?: string }>;
  /** Work under way on each app ("<wsId>/<name>"): what it is, and when it's done (withApp). */
  bopsAppWork?: Map<string, { kind: AppWork; done: Promise<void> }>;
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

/* ---------------- Work on one app, one at a time ---------------- */

/**
 * What's under way on an app: a deploy being sent, variables or settings saved before a site's first deploy
 * (each may make a deploy project), one of its sites being removed, or the app.
 */
type AppWork = "deploy" | "first" | "removeSite" | "remove";
const underWay = (g.bopsAppWork ??= new Map<string, { kind: AppWork; done: Promise<void> }>());
const BUSY_WORDS: Record<AppWork, string> = {
  deploy: "A deploy of it is being sent. Wait for it, then try again.",
  first: "Its settings are being saved. Wait for them, then try again.",
  removeSite: "One of its sites is being removed. Wait for it, then try again.",
  remove: "It's being removed.",
};
const removing = (k: AppWork) => k === "remove" || k === "removeSite";

/**
 * Do `fn` for an app with nothing else under way on it: a deploy, or a first save of its settings or
 * variables, waits for the one before it (each makes a site's deploy project when it has none, and two at
 * once would make two); a removal is refused while any of them is under way, and any of them while it's
 * being removed (a deploy sent as it goes would leave a site on the web that nothing here keeps). What's
 * under way is this Mac's, kept as the server runs.
 */
async function withApp<T>(wsId: string, name: string, kind: AppWork, fn: () => Promise<T>): Promise<T> {
  const key = `${wsId}/${name}`;
  for (let now = underWay.get(key); now; now = underWay.get(key)) {
    if (removing(kind) || removing(now.kind)) throw new HostedAppError(BUSY_WORDS[now.kind], 409);
    await now.done;
  }
  let done = () => {};
  underWay.set(key, { kind, done: new Promise<void>((r) => (done = r)) });
  try {
    return await fn();
  } finally {
    underWay.delete(key);
    done();
  }
}

/** Refused while the app is being removed (what needs no wait for a deploy). */
function notRemoving(wsId: string, name: string) {
  if (underWay.get(`${wsId}/${name}`)?.kind === "remove") throw new HostedAppError(BUSY_WORDS.remove, 409);
}

/* ---------------- Its sites, and its computer gone ---------------- */

const NO_SITE = "There's no site by that name in this app.";

/**
 * One site of an app as the rest of this file works with it: the app's record with that site's deploy
 * project and URL in place of its own, and the site's name (the app's, for its own).
 */
type SiteHosting = AppHosting & { site: string };

/** The site `site` names of an app (none: its own); one the app doesn't have is a 404. */
function siteIn(h: AppHosting, name: string, site?: unknown): SiteHosting {
  if (site === undefined || site === null || site === "" || site === name) return { ...h, site: name };
  const s = typeof site === "string" ? h.sites?.find((x) => x.name === site) : undefined;
  if (!s) throw new HostedAppError(NO_SITE, 404);
  const { projectId: _project, url: _url, ...rest } = h;
  void _project;
  void _url;
  return { ...rest, ...(s.projectId ? { projectId: s.projectId } : {}), ...(s.url ? { url: s.url } : {}), site: s.name };
}

/** An app's record for one of its sites (undefined: no such app). */
const hostingAt = (wsId: string, name: string, site?: unknown): SiteHosting | undefined => {
  const h = hostingOf(wsId, name);
  return h && siteIn(h, name, site);
};

/** Every site of an app, its own first, then the others in the order they were added. */
const sitesOf = (h: AppHosting, name: string): SiteHosting[] => [siteIn(h, name), ...(h.sites ?? []).map((s) => siteIn(h, name, s.name))];

/** A site's deploy project and URL, as one change keeps them. */
type SiteKept = { projectId?: string; url?: string };
const keptOf = (x: SiteKept): SiteKept => ({ ...(x.projectId ? { projectId: x.projectId } : {}), ...(x.url ? { url: x.url } : {}) });

/**
 * Keep what of one site changed: its deploy project and URL, as `fn` answers them from what's kept now. A
 * site removed meanwhile (or the app) stays removed.
 */
function keepSite(wsId: string, name: string, site: string, fn: (s: SiteKept) => SiteKept) {
  keepHosting(wsId, name, (h) => {
    if (!h) return h;
    if (site === name) {
      const { projectId, url, ...rest } = h;
      return { ...rest, ...keptOf(fn({ projectId, url })) };
    }
    if (!h.sites?.some((x) => x.name === site)) return h;
    return { ...h, sites: h.sites.map((x) => (x.name === site ? { name: x.name, ...keptOf(fn(x)) } : x)) };
  });
}

/**
 * The app's record as it moves to `botId` and its computer: on the computer it's on already (not lost),
 * all it has stays, the bot changed; on another one, only its sites' names come along (their deploy
 * projects, variables and domains are the old computer's). The deploy projects it leaves on a computer
 * that's still there serve on as they were, so they're kept (behind) for Remove app to take down; the
 * ones on the computer it moves to are its again (makeProject finds them by name), so they aren't.
 */
function movedTo(h: AppHosting | undefined, name: string, botId: string, computerId: string): AppHosting {
  const left: AppProjectBehind[] = [...(h?.behind ?? [])];
  const stays = !!h && !h.lost && h.computerId === computerId;
  if (h && !h.lost && !stays)
    for (const s of sitesOf(h, name)) if (s.projectId) left.push({ site: s.site, computerId: h.computerId, projectId: s.projectId });
  const behind = left.filter((x, i) => x.computerId !== computerId && left.findIndex((y) => y.projectId === x.projectId) === i);
  const more = behind.length ? { behind } : {};
  if (stays) return { botId, computerId, ...keptOf(h), ...(h.sites?.length ? { sites: h.sites } : {}), ...more };
  return { botId, computerId, ...(h?.sites?.length ? { sites: h.sites.map((x) => ({ name: x.name })) } : {}), ...more };
}

/**
 * A bot's own computer was deleted (sessions.ts resetComputer: its bot moved to a shared one, or it was
 * reset or removed; or found gone): every workspace's apps on it keep their records, with their sites'
 * names, marked as needing a new home (lost), never left pointing at a computer that's gone. Their deploy
 * projects and addresses went with it, so they're forgotten. Its Ingot tokens go with the sweep
 * (ingot.ts sweepTokens).
 */
export function appsComputerGone(computerId: string) {
  // (Still some bot's: the free computer another bot holds.)
  if (getState().bots.some((b) => b.computerId === computerId)) return;
  update((st) => {
    for (const w of st.workspaces ?? [])
      for (const [name, h] of Object.entries(w.hostedApps ?? {})) {
        // (Its projects left behind on that computer went with it too.)
        const behind = (h.behind ?? []).filter((x) => x.computerId !== computerId);
        const { behind: _had, ...rest } = h;
        void _had;
        const was: AppHosting = behind.length ? { ...rest, behind } : rest;
        if (h.computerId !== computerId || h.lost) {
          if (behind.length !== (h.behind?.length ?? 0)) w.hostedApps = { ...w.hostedApps, [name]: was };
          continue;
        }
        w.hostedApps = { ...w.hostedApps, [name]: { ...movedTo({ ...was, lost: 1 }, name, h.botId, h.computerId), lost: Date.now() } };
      }
  });
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

/** One site as the Apps page shows it, before Orgo is asked (or when it can't be). */
const siteBase = (s: SiteHosting): HostedSite => ({ name: s.site, projectId: s.projectId ?? null, url: s.url ?? null, serving: null, live: null });

/** Every custom domain of a computer, as Orgo lists them (null: it couldn't say, or not in time). */
type DomainsOn = (computerId: string) => Promise<OrgoCustomDomain[] | null>;

/**
 * How long one read of the Apps page waits for a computer's custom domains. They only add to its sites'
 * lines, so a list that's slow or failing (each read of it tried again, up to a minute each) never holds the
 * page up, nor the read every few seconds while a deploy runs: past this they're unsaid.
 */
const SITE_DOMAINS_MS = 4000;

/** What `p` answers, or null once `ms` pass first (it goes on, its answer then unheard). */
const within = <T>(p: Promise<T | null>, ms: number) =>
  new Promise<T | null>((done) => {
    const t = setTimeout(() => done(null), ms);
    const end = (v: T | null) => {
      clearTimeout(t);
      done(v);
    };
    p.then(end, () => end(null));
  });

/**
 * The custom domains of each computer, read once for one read of the Apps page however many apps and sites
 * it has (one call a computer, never one a site), for a few seconds at most (SITE_DOMAINS_MS): each site's
 * are then the ones on its port.
 */
function domainsReader(): DomainsOn {
  const read = new Map<string, Promise<OrgoCustomDomain[] | null>>();
  return (computerId) => {
    let list = read.get(computerId);
    if (!list) read.set(computerId, (list = within(domains.ofComputer(computerId).then((l) => l.domains ?? [], () => null), SITE_DOMAINS_MS)));
    return list;
  };
}

/**
 * A site's domains as its app's Sites list shows them: the computer's custom domains on its deploy
 * project's port (orgo-web keeps both unique per computer, as appTarget finds them), each by its name and
 * how it's doing. A project that doesn't say its port has none.
 */
const siteDomains = (all: OrgoCustomDomain[], port: unknown): SiteDomain[] =>
  typeof port === "number" ? all.filter((d) => d.target_port === port).map((d) => ({ domain: d.domain, status: d.status })) : [];

/**
 * One app as the Apps page shows it: its newest changeset as Ingot says (`on`: the workspace's repos, null
 * when Ingot can't say now), and each site's newest deploy and what it serves, as orgo-web says (a URL
 * Orgo gives that isn't kept yet is kept). Orgo isn't asked when deploying can't work here (`why`), nor of
 * a site never made there; `closed` hears why Orgo says hosting isn't open. An app with more sites has each
 * one's domains too (the ones on its port), from its computer's custom domains read once (`domainsOn`),
 * so its tab shows every site's at a glance; one with one site asks nothing more, as before.
 */
async function appView(
  wsId: string,
  name: string,
  h: AppHosting,
  on: IngotRepo[] | null,
  why: string | undefined,
  ours: () => boolean,
  closed: (why: string) => void,
  domainsOn: DomainsOn,
): Promise<HostedApp> {
  const repo = on?.find((r) => r.name === name);
  const base: HostedApp = { name, head: repo?.head ?? null, updatedAt: msOf(repo?.updated_at), hosting: h, serving: null, live: null, ...(on ? {} : { offline: true as const }) };
  let read = false;
  const all = sitesOf(h, name);
  // (Read alongside the sites' projects, not after them; a list that can't be read leaves their domains unsaid.)
  const custom = !why && all.length > 1 && all.some((s) => s.projectId) ? domainsOn(h.computerId) : Promise.resolve(null);
  const views = await Promise.all(
    all.map(async (s): Promise<HostedSite> => {
      if (why || !s.projectId) return siteBase(s);
      const [got, list] = await Promise.all([deploys.project(s.computerId, s.projectId).catch(() => null), custom]);
      held(ours);
      if (!got?.enabled) {
        if (got) closed(got.why);
        return siteBase(s);
      }
      read = true;
      const url = got.value.url;
      if (url && url !== s.url) keepSite(wsId, name, s.site, (x) => ({ ...x, url }));
      const d = newest(got.value);
      const at = url ?? s.url ?? null;
      return { name: s.site, projectId: s.projectId, url: at, live: d ? liveOf(d, at) : null, serving: servingOf(got.value), ...(list ? { domains: siteDomains(list, got.value.port) } : {}) };
    }),
  );
  // (Its record read again once Orgo was: a URL may have been kept meanwhile.)
  return { ...base, hosting: read ? (hostingOf(wsId, name) ?? h) : h, live: views[0].live, serving: views[0].serving, ...(views.length > 1 ? { sites: views } : {}) };
}

/**
 * GET /api/hosted-apps: the workspace's apps (Workspace.hostedApps), each with its newest changeset as
 * Ingot says (`offline` when Ingot can't say now), and its newest deploy and what its site serves, as
 * orgo-web says (every site's, for one with more than one). `enabled` false with why when deploying can't
 * work here; the apps are listed all the same.
 */
export async function listApps(wsId: string): Promise<HostedAppsAnswer> {
  const ours = sameState();
  const ws = workspace(wsId);
  if (!ws) throw new HostedAppError("That workspace is gone.", 404);
  const kept = Object.entries(ws.hostedApps ?? {}).filter(([name]) => isRepoName(name));
  const why = await closedHere();
  held(ours);
  const on = kept.length ? await reposOf(wsId) : [];
  held(ours);
  let closed: string | undefined;
  const domainsOn = domainsReader();
  const apps = await Promise.all(kept.map(([name, h]) => appView(wsId, name, h, on, why, ours, (w) => (closed = w), domainsOn)));
  apps.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name));
  if (why) return { enabled: false, why, apps };
  held(ours);
  if (!closed && !kept.some(([name, h]) => sitesOf(h, name).some((x) => x.projectId))) closed = await probe(wsId);
  return closed ? { enabled: false, why: closed, apps } : { enabled: true, apps };
}

/** One app as it is now, as the Apps page lists it (after a change to its sites). */
async function appNow(wsId: string, name: string, ours: () => boolean): Promise<HostedApp> {
  const h = hostingOf(wsId, name);
  if (!h) throw new HostedAppError(NO_APP, 404);
  const why = await closedHere();
  held(ours);
  const on = await reposOf(wsId);
  held(ours);
  return appView(wsId, name, hostingOf(wsId, name) ?? h, on, why, ours, () => {}, domainsReader());
}

/** How many files a changeset's changes list (Ingot gives the paths, or how many). */
const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" && v >= 0 ? Math.floor(v) : 0);

/**
 * GET /api/hosted-apps/[name]/commits: the app's changesets on main, newest first (older than `before`),
 * from Ingot, each marked when its site serves it. `offline` only when Ingot can't be reached: no computer
 * is asked, so one asleep changes nothing.
 */
export async function appCommits(wsId: string, name: string, before: string | null): Promise<AppCommitsAnswer> {
  const ours = sameState();
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
  held(ours);
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
 * Make a site's deploy project on the computer the app is worked on (source "ingot", the repo as
 * "<project>/<name>"), and keep it. It names no changeset: one there would be built by every deploy that
 * names none after it, and those build the newest on main. A project already there for this repo that's
 * this site's (orgo-web's ingot_repo and its name: a deploy sent twice, or one this Mac lost track of) is
 * the one, never one another site of it keeps; the app's own site, when it has no others, takes any of the
 * repo's, as before there were more. A new one gets a name and a port no other project there has; one Orgo
 * still finds taken (an app on the computer itself has it) moves on to the next. `env`: variables to make
 * it with, so its first build has them (changeEnv; one found there gets them on their own).
 */
async function makeProject(wsId: string, name: string, h: SiteHosting, ours: () => boolean, env?: Record<string, string>): Promise<SiteHosting> {
  const keep = (p: OrgoDeployProject): SiteHosting => {
    keepSite(wsId, name, h.site, () => ({ projectId: p.id, ...(p.url ? { url: p.url } : {}) }));
    const { projectId: _project, url: _url, ...rest } = h;
    void _project;
    void _url;
    return { ...rest, projectId: p.id, ...(p.url ? { url: p.url } : {}) };
  };
  const repo = ingotRepo(wsId, name);
  const there = await deploys.projects(h.computerId).catch((e: unknown) => Promise.reject(refused(e)));
  held(ours);
  if (!there.enabled) throw new HostedAppError(there.why, 403);
  const projects = there.value.projects ?? [];
  const all = hostingOf(wsId, name) ?? h;
  const others = new Set(sitesOf(all, name).flatMap((x) => (x.site !== h.site && x.projectId ? [x.projectId] : [])));
  const ofRepo = projects.filter((p) => p.source === "ingot" && p.ingot_repo?.toLowerCase() === repo && !others.has(p.id));
  // Its name, or its name with the number a taken one got (deployName).
  const names9 = Array.from({ length: 9 }, (_, k) => deployName(h.site, k + 1));
  const named = (p: OrgoDeployProject) => names9.includes(p.name);
  const mine = ofRepo.find(named) ?? (h.site === name && !all.sites?.length ? ofRepo[0] : undefined);
  if (mine) {
    if (env && Object.keys(env).length) {
      const r = await deploys.env(h.computerId, mine.id, env).catch((e: unknown) => Promise.reject(settingsRefused(e)));
      held(ours);
      if (!r.enabled) throw new HostedAppError(r.why, 403);
    }
    return keep(mine);
  }
  const names = new Set(projects.map((p) => p.name));
  const ports = new Set(projects.map((p) => p.port));
  let n = 1;
  let port = FIRST_PORT;
  for (let tries = 0; ; tries++) {
    while (names.has(deployName(h.site, n))) n++;
    while (ports.has(port)) port++;
    const project = deployName(h.site, n);
    const made = await deploys.create(h.computerId, { repo, name: project, port, ...(env ? { env } : {}) }).catch((e: unknown) => e as Error);
    held(ours);
    if (made instanceof OrgoError && tries < 5 && made.code === "NAME_TAKEN") names.add(project);
    else if (made instanceof OrgoError && tries < 5 && made.code === "PORT_TAKEN") ports.add(port);
    else if (made instanceof OrgoError && (made.code === "PROJECT_LIMIT" || made.code === "SERVICE_LIMIT"))
      throw new HostedAppError(`${bot(h.botId)?.name ?? "That bot"}'s computer already runs as many apps as one computer can.`, 409);
    else if (made instanceof OrgoError && made.code === "INVALID_ENV") throw settingsRefused(made);
    else if (made instanceof Error) throw refused(made);
    else if (!made.enabled) throw new HostedAppError(made.why, 403);
    else return keep(made.value);
  }
}

/** Orgo no longer has the project (removed there, or its computer is gone). */
const gone = (e: unknown) => e instanceof OrgoError && e.status === 404 && (!e.code || e.code === "NOT_FOUND");

/**
 * Deploy changeset `at` of an app (the newest on main by default) on the computer it's worked on: every
 * site of it, one after another (Orgo builds one at a time on a computer, so each is queued in turn), or
 * the one `site` names. The first time, a site's deploy project is made there and kept (on `botId`'s
 * computer, or the main bot's, when the workspace has no record of the app yet, or its computer is gone:
 * then its bot's, when it's still here). A project Orgo no longer has is made again. A computer with no
 * token of the workspace's yet gets one first (ensureIngotCli), as the deploy runner exports the repo
 * there with it. Answers the app as it is now, with the deploys Orgo queued (`deployment`: the first). A
 * site that can't be deployed stops the rest, saying which went (`partial`, when some did). One deploy of
 * an app at a time: another waits for it, and none goes while the app is being removed (withApp).
 */
export async function deployApp(
  wsId: string,
  name: string,
  opts: { at?: string; botId?: string; site?: unknown; ours?: () => boolean } = {},
): Promise<{ app: HostedApp; deployment: OrgoDeployment; deployed: { site: string; deployment: OrgoDeployment; url: string | null }[] }> {
  const ours = opts.ours ?? sameState();
  held(ours);
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  if (!isRepoName(name)) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  if (opts.at !== undefined && !CHANGESET.test(opts.at)) throw new HostedAppError("That isn't a changeset of it.", 400);
  const was = hostingOf(wsId, name);
  if (was && opts.site !== undefined) siteIn(was, name, opts.site);
  return withApp(wsId, name, "deploy", () => sendDeploys(wsId, name, opts, ours));
}

const MOVED = "It moved to another computer as this was sent. Deploy it again.";

/** deployApp, with nothing else under way on the app (withApp). */
async function sendDeploys(
  wsId: string,
  name: string,
  opts: { at?: string; botId?: string; site?: unknown },
  ours: () => boolean,
): Promise<{ app: HostedApp; deployment: OrgoDeployment; deployed: { site: string; deployment: OrgoDeployment; url: string | null }[] }> {
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  let h = hostingOf(wsId, name);
  if (!h || h.lost) {
    // A lost one goes to its bot's computer now, when it has one in this workspace (moved to a shared one), else the main bot's.
    const its = h?.lost ? bot(h.botId) : undefined;
    const b = opts.botId ? bot(opts.botId) : its && workspaceOf(its) === wsId && computerOf(its.id) ? its : mainBot(wsId);
    if (!b || workspaceOf(b) !== wsId) throw new HostedAppError("That bot isn't in this workspace.", 404);
    const computerId = computerOf(b.id);
    if (!computerId) throw new HostedAppError(`${b.name} has no computer yet, so there's nothing of ${name} to deploy.`, 409);
    const home = movedTo(h, name, b.id, computerId);
    keepHosting(wsId, name, () => home);
    h = home;
  }
  const kept = h;
  if (!hasToken(wsId, kept.computerId))
    await ensureIngotCli(kept.computerId, wsId, { botId: kept.botId }).catch((e: unknown) =>
      Promise.reject(e instanceof IngotError ? new HostedAppError(`Couldn't set Ingot up on the app's computer: ${e.message}`, e.offline ? 503 : 502) : e),
    );
  held(ours);
  const todo = opts.site !== undefined ? [siteIn(hostingOf(wsId, name) ?? kept, name, opts.site)] : sitesOf(hostingOf(wsId, name) ?? kept, name);
  const deployed: { site: string; deployment: OrgoDeployment; url: string | null }[] = [];
  const queue = (x: SiteHosting) => deploys.deploy(x.computerId, x.projectId!, opts.at).catch((e: unknown) => e as Error);
  /** The app's record as it is now: one removed, whose computer went, or that moved meanwhile stops the rest. */
  const still = () => {
    const now = hostingOf(wsId, name);
    if (!now) throw new HostedAppError(NO_APP, 404);
    if (now.lost) throw new HostedAppError(LOST, 409);
    if (now.computerId !== kept.computerId) throw new HostedAppError(MOVED, 409);
    return now;
  };
  for (const one of todo) {
    try {
      // (Its project as kept now: one its variables made meanwhile, say. A site removed meanwhile is skipped.)
      const now = still();
      if (one.site !== name && !now.sites?.some((x) => x.name === one.site)) continue;
      const cur = siteIn(now, name, one.site);
      let s = cur.projectId ? cur : await makeProject(wsId, name, cur, ours);
      still();
      let got = await queue(s);
      held(ours);
      if (gone(got)) {
        // The project is gone on Orgo: made again on the same computer.
        s = await makeProject(wsId, name, { ...s, projectId: undefined }, ours);
        got = await queue(s);
        held(ours);
      }
      if (got instanceof Error) throw refused(got);
      if (!got.enabled) throw new HostedAppError(got.why, 403);
      deployed.push({ site: s.site, deployment: got.value, url: s.url ?? null });
    } catch (e) {
      // The ones that went are deploying, whatever stopped the rest: the window reads the app again.
      if (deployed.length && ours()) keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
      const mine = e instanceof HostedAppError;
      if ((mine && e.message === SWAPPED) || todo.length === 1 || (!mine && !deployed.length)) throw e;
      const went = deployed.map((d) => d.site);
      // (Not ours, as an OrgoTimeout: in words with the rest, as Orgo said it.)
      const words = mine ? e.message : String((e as Error)?.message || "Orgo didn't answer").replace(/\.?$/, ".");
      throw new HostedAppError(
        `${went.length ? `Deploying ${went.join(" and ")}, but not ${one.site}` : `Didn't deploy ${one.site}`}: ${words}`,
        mine ? e.status : 502,
        { ...(mine ? e.extra : {}), ...(went.length ? { partial: true } : {}) },
      );
    }
  }
  if (!deployed.length) throw new HostedAppError(NO_SITE, 404);
  const app = await queued(wsId, name, kept, new Map(deployed.map((d) => [d.site, d.deployment])), opts.at);
  return { app, deployment: deployed[0].deployment, deployed: deployed.map((d) => ({ ...d, url: app.sites?.find((x) => x.name === d.site)?.url ?? (d.site === name ? (app.hosting?.url ?? null) : d.url) })) };
}

/**
 * The app as it is once this Mac queued a deploy of it (`done`: each site's, of changeset `at` when one was
 * named): a window showing it reads it again (a bot's deploy changes nothing else it watches). What a site
 * deployed now serves meanwhile isn't in this answer: the window keeps what it read last (null here). Of
 * an app with more sites, the ones not deployed now are as Orgo says.
 */
async function queued(wsId: string, name: string, h: AppHosting, done: Map<string, OrgoDeployment>, at?: string): Promise<HostedApp> {
  keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
  const now = hostingOf(wsId, name) ?? h;
  const repo = (await reposOf(wsId))?.find((r) => r.name === name);
  const head = repo?.head ?? null;
  const views = await Promise.all(
    sitesOf(now, name).map(async (s): Promise<HostedSite> => {
      const d = done.get(s.site);
      if (d) return { ...siteBase(s), live: { ...liveOf(d, s.url ?? null), at: deployedAt(d) ?? at ?? head, state: d.state ?? "queued", when: msOf(d.created_at) ?? Date.now() } };
      const p = s.projectId ? await deploys.project(s.computerId, s.projectId).catch(() => null) : null;
      if (!p?.enabled) return siteBase(s);
      const url = p.value.url ?? s.url ?? null;
      const n = newest(p.value);
      return { ...siteBase(s), url, serving: servingOf(p.value), live: n ? liveOf(n, url) : null };
    }),
  );
  return { name, head, updatedAt: msOf(repo?.updated_at), hosting: now, serving: views[0].serving, live: views[0].live, ...(views.length > 1 ? { sites: views } : {}) };
}

/** A log cursor the window hands back: the deploy it's for and the last line read ("<deployId>:<n>"), or a bare line number. */
function cursorOf(after: string | null): { id?: string; n: number } {
  const m = /^(?:([\w-]{1,80}):)?(\d{1,9})$/.exec(after ?? "");
  return m ? { id: m[1], n: Number(m[2]) } : { n: 0 };
}

/**
 * GET /api/hosted-apps/[name]/logs: the newest deploy's build log after `after` (of `site`, or the app's own
 * site), from orgo-web's record (it never wakes the computer). A cursor from an older deploy reads the
 * newest one from its start.
 */
export async function appLog(wsId: string, name: string, after: string | null, site?: unknown): Promise<{ state: DeployState | null; log: string; next: string | null; more: boolean }> {
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingAt(wsId, name, site) : undefined;
  if (!h) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  const none = { state: null, log: "", next: null, more: false };
  if (!h.projectId) return none;
  const p = await deploys.project(h.computerId, h.projectId).catch((e: unknown) => Promise.reject(refused(e)));
  held(ours);
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  const d = newest(p.value);
  if (!d) return none;
  const at = cursorOf(after);
  const from = at.id && at.id !== d.id ? 0 : at.n;
  const l = await deploys.logs(h.computerId, d.id, from).catch((e: unknown) => Promise.reject(refused(e)));
  if (!l.enabled) throw new HostedAppError(l.why, 403);
  return { state: l.value.state ?? d.state, log: l.value.log ?? "", next: `${d.id}:${Number(l.value.next) || from}`, more: !!l.value.more };
}

/* ---------------- Its settings, variables and deploys ---------------- */

const NO_APP = "There's no app by that name in this workspace.";

/**
 * A site's deploy project (the app's own, or the one `site` names) as orgo-web has it now, read for whatever
 * is asked of it (its computer and project are the ones this Mac keeps for the app, never ones the window
 * names). Null when it has none yet (never deployed, no variables saved).
 */
async function projectOf(wsId: string, name: string, ours: () => boolean, site?: unknown): Promise<{ h: SiteHosting & { projectId: string }; p: OrgoDeployProject } | null> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingAt(wsId, name, site) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (!h.projectId) return null;
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const p = await deploys.project(h.computerId, h.projectId).catch((e: unknown) => Promise.reject(refused(e)));
  held(ours);
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  return { h: { ...h, projectId: h.projectId }, p: p.value };
}

/** How many of its deploys the page lists. */
const DEPLOYS_SHOWN = 10;

const deployOf = (d: OrgoDeployment): AppDeploy => ({
  id: d.id,
  state: d.state,
  at: deployedAt(d),
  rollback: d.trigger === "rollback",
  when: msOf(d.finished_at ?? d.created_at),
  error: d.error ?? null,
  live: !!d.release_live,
  canRollback: !!d.can_rollback && d.state === "succeeded",
});

const settingsOf = (p: OrgoDeployProject, url: string | null): AppSettingsAnswer => ({
  url: p.url ?? url,
  settings: {
    port: typeof p.port === "number" ? p.port : null,
    install: p.install_cmd ?? null,
    build: p.build_cmd ?? null,
    start: p.start_cmd ?? null,
    ...(typeof p.health_path === "string" ? { health: p.health_path } : {}),
  },
  env: [...new Set((p.env_keys ?? []).filter((k) => typeof k === "string"))].sort(),
  deploys: [...(p.deployments ?? [])]
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
    .slice(0, DEPLOYS_SHOWN)
    .map(deployOf),
});

/**
 * GET /api/hosted-apps/[name]/settings: its address, its port, commands and health check, its variables'
 * names, and its recent deploys, from its deploy project at orgo-web (of `site`, or the app's own site; the
 * computer is never asked). Before its first deploy, none (`settings` null): saving some makes its project.
 */
export async function appSettings(wsId: string, name: string, site?: unknown): Promise<AppSettingsAnswer> {
  const got = await projectOf(wsId, name, sameState(), site);
  if (!got) return { url: hostingAt(wsId, name, site)?.url ?? null, settings: null, env: [], deploys: [] };
  return settingsOf(got.p, got.h.url ?? null);
}

/** Orgo's refusals of a settings change, in Bops' words where they name a field (its own words otherwise). */
function settingsRefused(e: unknown) {
  if (!(e instanceof OrgoError)) return e;
  const status = e.status >= 400 && e.status < 500 ? e.status : 502;
  if (e.code === "PORT_TAKEN") return new HostedAppError("Another app on this computer uses that port. Pick another.", 409, { field: "port" });
  if (e.code === "INVALID_PORT") return new HostedAppError(e.said ?? "Use a port from 1 to 65535.", 400, { field: "port" });
  if (e.code === "INVALID_COMMAND") return new HostedAppError(e.said ?? "Orgo can't take that command.", 400);
  if (e.code === "INVALID_HEALTH_PATH") return new HostedAppError(e.said ?? HEALTH_WORDS, 400, { field: "health" });
  if (e.code === "INVALID_ENV") return new HostedAppError(e.said ?? "Orgo can't take that variable.", 400);
  if (e.code === "NOT_FOUND") return new HostedAppError("Orgo doesn't have this app's deploy any more. Deploy it again.", 404);
  if (e.code === "workspace_read_only") return new HostedAppError("Your access to this workspace is view only, so its apps aren't yours to change.", status);
  return refused(e);
}

/** A command as it's typed to change it ("" for one Orgo finds itself), checked as orgo-web checks it. */
function commandOf(v: unknown, what: string): string {
  if (typeof v !== "string") throw new HostedAppError(`Type the ${what} command, or leave it empty for Orgo to find it.`, 400, { field: what });
  const cmd = v.trim();
  if (cmd.length > 4000) throw new HostedAppError(`The ${what} command can be 4000 characters at most.`, 400, { field: what });
  if (cmd.includes("\0")) throw new HostedAppError(`The ${what} command can't have that character in it.`, 400, { field: what });
  return cmd;
}

const HEALTH_WORDS = "The health check path starts with /, like /health, with no spaces or quotes.";

/**
 * The health check's path as it's typed to change it ("" for "/", orgo-web's default), checked as orgo-web
 * checks it (lib/deploys/config.ts checkHealthPath).
 */
function healthOf(v: unknown): string {
  if (typeof v !== "string") throw new HostedAppError(HEALTH_WORDS, 400, { field: "health" });
  const path = v.trim() || "/";
  if (!path.startsWith("/") || path.length > 256 || /[\s\0'"`\\]/.test(path)) throw new HostedAppError(HEALTH_WORDS, 400, { field: "health" });
  return path;
}

/**
 * PATCH /api/hosted-apps/[name]/settings: its port, its install, build and start commands, and its health
 * check's path, changed on its deploy project (of `site`, or the app's own site: orgo-web builds its live
 * release again for a new port, and moves its public URL). Its domains serve its port, so each one on the old
 * port is moved to the new one; one that can't be is said. One with no project yet (never deployed) gets it
 * made now and changed (nothing deployed), so its first build has them (firstSettings).
 */
export async function changeSettings(
  wsId: string,
  name: string,
  c: { port?: unknown; install?: unknown; build?: unknown; start?: unknown; health?: unknown },
  site?: unknown,
): Promise<AppSettingsAnswer> {
  const patch: { port?: number; install_cmd?: string; build_cmd?: string; start_cmd?: string; health_path?: string } = {};
  if (c.port !== undefined && c.port !== null && c.port !== "") {
    const n = typeof c.port === "number" ? c.port : typeof c.port === "string" && /^\s*\d{1,5}\s*$/.test(c.port) ? Number(c.port) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HostedAppError("Use a port from 1 to 65535.", 400, { field: "port" });
    patch.port = n;
  }
  if (c.install !== undefined) patch.install_cmd = commandOf(c.install, "install");
  if (c.build !== undefined) patch.build_cmd = commandOf(c.build, "build");
  if (c.start !== undefined) patch.start_cmd = commandOf(c.start, "start");
  if (c.health !== undefined) patch.health_path = healthOf(c.health);
  if (!Object.keys(patch).length) throw new HostedAppError("There's nothing to change.", 400);
  const ours = sameState();
  const got = await projectOf(wsId, name, ours, site);
  if (!got) return withApp(wsId, name, "first", () => firstSettings(wsId, name, site, patch, ours));
  const { h, p } = got;
  const was = typeof p.port === "number" ? p.port : null;
  held(ours);
  const r = await deploys.change(h.computerId, h.projectId, patch).catch((e: unknown) => Promise.reject(settingsRefused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  const now = typeof r.value.port === "number" ? r.value.port : null;
  let said: string | undefined;
  if (was !== null && now !== null && now !== was) {
    // Orgo builds the live release again for the new port: the window reads the app again.
    keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
    const list = await domains.ofComputer(h.computerId).catch(() => null);
    held(ours);
    const left: string[] = [];
    for (const d of list?.domains?.filter((x) => x.target_port === was) ?? []) {
      held(ours);
      const moved = await domains.move(h.computerId, d.id, now).then(
        () => true,
        () => false,
      );
      if (!moved) left.push(d.domain);
    }
    held(ours);
    if (!list) said = `Its port is ${now} now. Couldn't read its domains to move them too, so any on port ${was} still point there.`;
    else if (left.length) said = `Its port is ${now} now, but ${left.join(", ")} still ${left.length === 1 ? "points" : "point"} at port ${was}. Remove ${left.length === 1 ? "it" : "them"} and add ${left.length === 1 ? "it" : "them"} again.`;
  }
  return { ...settingsOf(r.value, h.url ?? null), ...(said ? { said } : {}) };
}

/**
 * Settings saved before a site's first deploy (with nothing else under way on the app: withApp): its deploy
 * project made now on the app's computer (nothing deployed) and changed, so its first build has them (a
 * second site from the same repo is started its own way). One made meanwhile, by a deploy sent as they were,
 * is changed the same. An app whose computer is gone has nowhere to keep them until it has a new home.
 */
async function firstSettings(wsId: string, name: string, site: unknown, patch: Parameters<typeof deploys.change>[2], ours: () => boolean): Promise<AppSettingsAnswer> {
  const h = hostingAt(wsId, name, site);
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (h.lost) throw new HostedAppError(LOST, 409);
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const made = h.projectId ? h : await makeProject(wsId, name, h, ours);
  // The window reads the app again: it has a deploy project now.
  if (!h.projectId) keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
  const r = await deploys.change(made.computerId, made.projectId!, patch).catch((e: unknown) => Promise.reject(settingsRefused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  return settingsOf(r.value, made.url ?? null);
}

/** How many variables a project can have (orgo-web MAX_ENV_VARS), and how long a value can be. */
const MAX_ENV = 64;
const MAX_ENV_VALUE = 8192;

/**
 * PATCH /api/hosted-apps/[name]/env: variables set (a value) or removed (null) on its deploy project (of
 * `site`, or the app's own site); the rest stay. One with no project yet (never deployed) gets it made now,
 * with them (nothing deployed), so its first build has them. The values are the user's secrets: they go to
 * orgo-web alone, as they came, and nothing here keeps, logs or says one (a refusal names the variable,
 * never its value). Answers their names.
 */
export async function changeEnv(wsId: string, name: string, env: unknown, site?: unknown): Promise<{ env: string[] }> {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new HostedAppError("Name a variable to set or remove.", 400);
  const entries = Object.entries(env as Record<string, unknown>);
  if (!entries.length) throw new HostedAppError("Name a variable to set or remove.", 400);
  if (entries.length > MAX_ENV) throw new HostedAppError(`An app can have ${MAX_ENV} variables at most.`, 400);
  const out: Record<string, string | null> = {};
  for (const [k, v] of entries) {
    const shown = k.replace(/[^\w]/g, "").slice(0, 40) || "That";
    if (!ENV_NAME.test(k)) throw new HostedAppError(`${shown} can't be a variable's name. Use capital letters, digits and underscores, not starting with a digit.`, 400, { field: "name" });
    if (ENV_RESERVED.has(k)) throw new HostedAppError(`${k} is set by Orgo, so it can't be changed here.`, 400, { field: "name" });
    if (v !== null && typeof v !== "string") throw new HostedAppError(`${k}'s value has to be text.`, 400, { field: "value" });
    if (typeof v === "string" && (v.length > MAX_ENV_VALUE || v.includes("\0"))) throw new HostedAppError(`${k}'s value is too long, or has a character Orgo can't keep.`, 400, { field: "value" });
    out[k] = v;
  }
  const ours = sameState();
  const got = await projectOf(wsId, name, ours, site);
  if (!got) return { env: await withApp(wsId, name, "first", () => firstEnv(wsId, name, site, out, ours)) };
  held(ours);
  return { env: await envOn(got.h.computerId, got.h.projectId, out, ours) };
}

/** Variables set and removed on a deploy project: the names Orgo keeps now. */
async function envOn(computerId: string, projectId: string, out: Record<string, string | null>, ours: () => boolean): Promise<string[]> {
  const r = await deploys.env(computerId, projectId, out).catch((e: unknown) => Promise.reject(settingsRefused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  return [...new Set((r.value.env_keys ?? []).filter((x) => typeof x === "string"))].sort();
}

/**
 * Variables saved before a site's first deploy (with nothing else under way on the app: withApp): its
 * deploy project made now on the app's computer, with them (a removal of one it doesn't have yet is nothing
 * to send), so the first build has them. One made meanwhile, by a deploy sent as they were, gets them as any
 * does. An app whose computer is gone has nowhere to keep them until it has a new home. Answers the names
 * Orgo keeps.
 */
async function firstEnv(wsId: string, name: string, site: unknown, out: Record<string, string | null>, ours: () => boolean): Promise<string[]> {
  const h = hostingAt(wsId, name, site);
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (h.lost) throw new HostedAppError(LOST, 409);
  if (h.projectId) return envOn(h.computerId, h.projectId, out, ours);
  const set = Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => e[1] !== null));
  if (!Object.keys(set).length) return [];
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const made = await makeProject(wsId, name, h, ours, set);
  // The window reads the app again: it has a deploy project now.
  keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
  const p = await deploys.project(made.computerId, made.projectId!).catch(() => null);
  held(ours);
  return p?.enabled ? [...new Set((p.value.env_keys ?? []).filter((x) => typeof x === "string"))].sort() : Object.keys(set).sort();
}

const LOST = "Its computer is gone, so it needs a new home first: deploy it, or ask a bot to work on it.";

/** Orgo's refusals of a rollback, in Bops' words. */
function rollbackRefused(e: unknown) {
  if (!(e instanceof OrgoError)) return e;
  if (e.code === "ALREADY_LIVE") return new HostedAppError("That one is live now.", 409);
  if (e.code === "NOT_ROLLBACKABLE") return new HostedAppError("Only a deploy that went live can be put back.", 409);
  if (e.code === "NOT_FOUND") return new HostedAppError("Orgo doesn't have that deploy any more.", 404);
  if (e.code === "CHANGED") return new HostedAppError("Orgo couldn't queue that just now. Try again.", 409);
  return refused(e);
}

/**
 * POST /api/hosted-apps/[name] "rollback": one of the app's earlier deploys put live again without a build
 * (only one of its own recent deploys that Orgo says can be: it went live, and its release is still on the
 * computer). Answers the app as it is now, with the rollback queued.
 */
export async function rollbackApp(wsId: string, name: string, deployment: unknown, site?: unknown): Promise<{ app: HostedApp }> {
  if (typeof deployment !== "string" || !/^[\w-]{1,80}$/.test(deployment)) throw new HostedAppError("That isn't one of its deploys.", 400);
  const ours = sameState();
  const got = await projectOf(wsId, name, ours, site);
  if (!got) throw new HostedAppError("It hasn't been deployed yet.", 409);
  const d = (got.p.deployments ?? []).find((x) => x.id === deployment);
  if (!d) throw new HostedAppError("That isn't one of its recent deploys.", 404);
  if (d.release_live) throw new HostedAppError("That one is live now.", 409);
  if (!d.can_rollback || d.state !== "succeeded") throw new HostedAppError("That one can't be put back: only a deploy that went live, and is still on its computer, can.", 409);
  held(ours);
  const r = await deploys.rollback(got.h.computerId, deployment).catch((e: unknown) => Promise.reject(rollbackRefused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  return { app: await queued(wsId, name, got.h, new Map([[got.h.site, r.value]]), deployedAt(d) ?? undefined) };
}

/* ---------------- Its domains and their DNS ---------------- */

/** A bought domain's id at Orgo, as a change names the zone it goes to. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A record's id at Orgo: 16 characters of base64url, made from what the record says. */
const RECORD_ID = /^[A-Za-z0-9_-]{16}$/;

const NOT_HERE = "That domain doesn't point at this app, so its DNS isn't changed here.";
const STALE = "That record changed since it was read. Here are the records as they are now, so try again.";

/** Orgo's DNS refusals by code, in Bops' words (Orgo's own are kept where they name the field or the name that's wrong). */
const DNS_WORDS: Record<string, string> = {
  RECORD_EXISTS: "That record is there already.",
  RECORD_CONFLICT: "A CNAME needs its name to itself. Use another name.",
  ZONE_BUSY: "Another change to this domain is still saving. Try again in a moment.",
  RATE_LIMITED: "That's as many DNS changes as Orgo takes in an hour. Try again later.",
  DOMAIN_PENDING: "This domain is still being registered. Try again in a few minutes.",
  DOMAINS_NOT_ENABLED: "DNS for domains bought through Orgo isn't open to your Orgo account yet.",
  DOMAIN_NOT_FOUND: "Orgo doesn't have that domain in this workspace any more.",
  REGISTRAR_UNAVAILABLE: "Orgo couldn't reach its DNS just now. Try again.",
  DNS_WRITE_FAILED: "Orgo couldn't save the records just now. Try again.",
  DOMAINS_UNAVAILABLE: "Domains aren't working on Orgo just now. Try again later.",
  workspace_read_only: "Your access to this workspace is view only. Ask its owner for full access to change its domains.",
};

/** Orgo turned a domains call down: in plain words, with Orgo's status (a 5xx is a 502 here), and the field to fix when it said. */
function dnsRefused(e: unknown) {
  if (!(e instanceof OrgoError)) return e;
  const a = e.answer ?? {};
  const who = typeof a.computer_name === "string" && a.computer_name ? a.computer_name : "a computer";
  const status = e.status >= 400 && e.status < 500 ? e.status : 502;
  // Orgo's words for a record it can't take say what to type ("Enter an IPv4 address, like 203.0.113.10.").
  if (e.code === "INVALID_RECORD") return new HostedAppError(e.said ?? "Orgo can't take that record as it is.", 400, typeof a.field === "string" ? { field: a.field } : undefined);
  if (e.code === "RECORD_CONFLICT" && e.said) return new HostedAppError(e.said, status, { field: "name" });
  if (e.code === "NAME_MANAGED") return new HostedAppError(`Orgo points that name at ${who}, so it can't have this record too. Use another name.`, status, { field: "name" });
  if (e.code === "RECORD_MANAGED") return new HostedAppError(`Orgo keeps that record so a domain reaches ${who}, so it isn't changed here.`, status);
  const words = e.code ? DNS_WORDS[e.code] : undefined;
  return words ? new HostedAppError(words, status) : refused(e);
}

/**
 * The app as far as its domains go, from Orgo: the computer's custom domains (every one, and `mine`, the
 * ones on its deploy project's port), its public URL, and the bought domains (zones) that one of `mine`
 * is or is under, by id, each with its name; `zoneOf` says which zone each of `mine` is in. Null when the
 * app was never deployed (no project, so no port for a domain to serve).
 */
type Target = {
  h: SiteHosting;
  /** The workspace's Orgo project, which a bought domain's DNS is reached under. */
  project: string | undefined;
  url: string | null;
  /** The port its deploy project listens on, which its domains serve (null: Orgo didn't say). */
  port: number | null;
  /** The workspace's bought domains, when they were read for it. */
  bought?: OrgoBoughtList;
  all: OrgoCustomDomain[];
  mine: OrgoCustomDomain[];
  zones: Map<string, string>;
  zoneOf: Map<string, string>;
};

async function appTarget(wsId: string, name: string, ours: () => boolean, site?: unknown): Promise<Target | null> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingAt(wsId, name, site) : undefined;
  if (!h) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  if (!h.projectId) return null;
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const [p, list] = await Promise.all([
    deploys.project(h.computerId, h.projectId).catch((e: unknown) => Promise.reject(refused(e))),
    domains.ofComputer(h.computerId).catch((e: unknown) => Promise.reject(dnsRefused(e))),
  ]);
  held(ours);
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  const port = typeof p.value.port === "number" ? p.value.port : null;
  const all = list.domains ?? [];
  // A custom domain serves one port of its computer, and each deploy project there listens on its own
  // (orgo-web keeps both unique per computer), so the app's domains are the ones on its port. Nothing at
  // Orgo ties a domain to a project otherwise. A project that doesn't say its port has none of them.
  const mine = port === null ? [] : all.filter((d) => d.target_port === port);
  // A bought domain is connected only to a computer in its own Orgo workspace, and a computer two Bops
  // workspaces share is in one of them only: so its zone is under the computer's workspace, asked when
  // there's a bought one to read (else, or when Orgo doesn't say, this workspace's).
  const here = workspace(wsId)?.orgoProjectId;
  const project = mine.some((d) => d.managed) ? ((await domains.workspaceOf(h.computerId).catch(() => null)) ?? here) : here;
  held(ours);
  // Orgo doesn't say which bought domain a custom domain is in: it's the workspace's bought domain whose
  // name it is, or ends with (the longest one, as orgo-web matches it). The computer's list has them
  // when custom domains are open to this account; else the workspace's own list does.
  let owned = list.owned_domains;
  let bought: OrgoBoughtList | undefined;
  if (!owned && project && mine.some((d) => d.managed)) {
    bought = (await domains.bought(project).catch(() => null)) ?? undefined;
    owned = bought?.domains?.filter((d) => d.status === "active").map(({ id, domain }) => ({ id, domain }));
    held(ours);
  }
  const zones = new Map<string, string>();
  const zoneOf = new Map<string, string>();
  for (const d of mine) {
    const fqdn = d.domain.toLowerCase();
    const z = d.managed
      ? (owned ?? []).filter((o) => fqdn === o.domain.toLowerCase() || fqdn.endsWith(`.${o.domain.toLowerCase()}`)).sort((a, b) => b.domain.length - a.domain.length)[0]
      : undefined;
    if (!z) continue;
    zones.set(z.id.toLowerCase(), z.domain);
    zoneOf.set(d.id, z.id.toLowerCase());
  }
  return { h, project, url: p.value.url ?? h.url ?? null, port, bought, all, mine, zones, zoneOf };
}

/**
 * Why a record Orgo keeps is Orgo's: it wrote it so one of the computer's domains reaches its computer
 * (the A at that name, or the TXT that proves it, _orgo-verify before it). Changing it is changing that
 * domain, never its records.
 */
function lockedWhy(t: Target, r: OrgoDnsRecord): string | null {
  const m = r.managed;
  if (!m) return null;
  const named = t.all.find((d) => d.id === m.custom_domain_id)?.domain ?? (r.type === "TXT" ? r.fqdn.replace(/^_orgo-verify\./, "") : r.fqdn);
  const to = t.mine.some((d) => d.id === m.custom_domain_id) ? "this app" : m.computer_id === t.h.computerId ? "another app on this computer" : (m.computer_name ?? "another computer");
  return `Orgo set this so ${named} reaches ${to}.`;
}

const recordsOf = (t: Target, records: OrgoDnsRecord[] | undefined): AppDnsRecord[] =>
  (records ?? [])
    .filter((r) => (DNS_TYPES as readonly string[]).includes(r.type))
    .map((r) => ({
      id: r.id,
      type: r.type as AppDnsRecord["type"],
      name: r.name,
      fqdn: r.fqdn,
      value: r.value,
      ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
      ...(typeof r.weight === "number" ? { weight: r.weight } : {}),
      ...(typeof r.port === "number" ? { port: r.port } : {}),
      locked: lockedWhy(t, r),
    }));

const zoneView = (t: Target, id: string, domain: string, z: OrgoZone): AppDnsZone => ({
  id,
  domain: z.domain || domain,
  serving: z.serving ?? z.nameservers?.mode === "orgo",
  ttl: typeof z.ttl_seconds === "number" ? z.ttl_seconds : null,
  records: recordsOf(t, z.records),
});

/** A zone's records as Orgo has them; one that can't be read says why, and the rest of the app's domains still show. */
async function readZone(t: Target, id: string, domain: string): Promise<AppDnsZone> {
  const none: AppDnsZone = { id, domain, serving: false, ttl: null, records: [] };
  if (!t.project) return { ...none, error: NO_PROJECT };
  try {
    return zoneView(t, id, domain, await domains.zone(t.project, id));
  } catch (e) {
    const r = dnsRefused(e);
    return { ...none, error: r instanceof HostedAppError ? r.message : "Couldn't read its DNS records just now." };
  }
}

/** Who keeps the DNS of each domain bought elsewhere, by its id, as Orgo's last look said (null: it couldn't tell). */
const keptAt = new Map<string, string | null>();

/**
 * One of the app's domains. One bought elsewhere has the records to set where its DNS is kept, with what
 * Orgo found when it looked: one look each time it's read while it waits (Orgo allows 30 a minute), and
 * once it's live, one look in all, or one on Verify (`look`). A look that fails leaves them as Orgo says
 * to set them. A live one no longer needs its TXT (it proved the domain is theirs), so only what routes it.
 */
async function domainOf(t: Target, d: OrgoCustomDomain, look = false): Promise<AppDomain> {
  const base: AppDomain = { id: d.id, domain: d.domain, status: d.status, cert: d.cert_status === "issued" ? "issued" : "pending", managed: !!d.managed, zone: t.zoneOf.get(d.id) ?? null, publish: [] };
  if (d.managed || d.status === "disabled") return base;
  const live = d.status === "active";
  const needed = (r: { type: string }) => !live || r.type !== "TXT";
  const asSaid = (d.dns_records ?? []).filter(needed).map((r) => ({ type: r.type, name: r.host || r.name, value: r.value }));
  if (live && !look && keptAt.has(d.id)) return { ...base, publish: asSaid, where: keptAt.get(d.id) ?? null };
  const check = await domains.check(t.h.computerId, d.id).catch(() => null);
  if (check) keptAt.set(d.id, check.provider?.name ?? null);
  const publish = check?.records?.length ? check.records.filter(needed).map((r) => ({ type: r.type, name: r.host || r.name, value: r.value, found: r.status })) : asSaid;
  return { ...base, publish, where: check ? (check.provider?.name ?? null) : (keptAt.get(d.id) ?? null) };
}

/**
 * GET /api/hosted-apps/[name]/dns: its public URL, the domains that point at it (its computer's custom
 * domains on its port: of `site`, or the app's own site), and for the ones bought through Orgo, their zones
 * (read once each), every record marked the user's or Orgo's (with why). From orgo-web alone: the computer
 * is never asked.
 */
export async function appDomains(wsId: string, name: string, site?: unknown): Promise<AppDomainsAnswer> {
  return domainsNow(wsId, name, sameState(), site);
}

/**
 * The app's domains as appDomains reads them, for the account the work began on; each zone with its renewal
 * (the workspace's bought domains, read once, when the target didn't read them already).
 */
async function domainsNow(wsId: string, name: string, ours: () => boolean, site?: unknown): Promise<AppDomainsAnswer> {
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  if (!t) return { url: hostingAt(wsId, name, site)?.url ?? null, domains: [], zones: [] };
  const boughtList = t.bought ? Promise.resolve(t.bought) : t.zones.size && t.project ? domains.bought(t.project).catch(() => null) : Promise.resolve(null);
  const [zones, list, bought] = await Promise.all([Promise.all([...t.zones].map(([id, domain]) => readZone(t, id, domain))), Promise.all(t.mine.map((d) => domainOf(t, d))), boughtList]);
  const renewalFor = (id: string) => renewalOf(bought?.domains?.find((b) => b.id.toLowerCase() === id));
  return { url: t.url, domains: list, zones: zones.map((z) => withRenewal(z, renewalFor(z.id))) };
}

const withRenewal = (z: AppDnsZone, renewal: AppRenewal | undefined): AppDnsZone => (renewal ? { ...z, renewal } : z);

/** Why a renewal's last try failed, in words (orgo-web renewal_error). */
const RENEW_WORDS: Record<string, string> = {
  insufficient_credits: "The last try to renew it found too few credits. Add credits, or pay from yours.",
  no_payer: "No one is set to pay for it. Turn auto-renew on to pay from your credits.",
  registry_refused: "The registry turned the last try down. Orgo tries again.",
};

/** A bought domain's renewal as the window shows it (undefined: this Orgo doesn't say, before it renewed domains). */
function renewalOf(b: OrgoBoughtDomain | undefined): AppRenewal | undefined {
  if (!b || typeof b.auto_renew !== "boolean") return undefined;
  const state = b.renewal_state ?? (b.auto_renew ? "scheduled" : "off");
  return {
    on: b.auto_renew,
    cents: typeof b.renewal_cents === "number" ? b.renewal_cents : null,
    years: typeof b.renewal_years === "number" && b.renewal_years > 0 ? b.renewal_years : 1,
    payer: b.renewal_paid_by === "you" || b.renewal_paid_by === "member" ? b.renewal_paid_by : null,
    state,
    error: state === "retrying" && b.renewal_error ? (RENEW_WORDS[b.renewal_error] ?? RENEW_WORDS.registry_refused) : null,
    expires: msOf(b.expires_at),
  };
}

/** A record as a request has it, any field of any type (inputOf checks them). */
type Typed = { [K in keyof AppDnsInput]?: unknown };

/** A record as the window typed it, as orgo-web takes it: its type checked here, the rest by Orgo (which says what's wrong with it). */
function inputOf(r: Typed): OrgoRecordInput {
  const type = typeof r?.type === "string" ? r.type.trim().toUpperCase() : "";
  if (!(DNS_TYPES as readonly string[]).includes(type)) throw new HostedAppError("Pick a type: A, AAAA, CNAME, MX, TXT or SRV.", 400, { field: "type" });
  const text = (v: unknown, most: number) => (typeof v === "string" ? v.slice(0, most) : "");
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? v.trim().slice(0, 12) : undefined);
  const needs = dnsNeeds(type);
  return {
    type,
    name: text(r.name, 300).trim(),
    value: text(r.value, 1024),
    ...(needs.priority ? { priority: num(r.priority) } : {}),
    ...(needs.weight ? { weight: num(r.weight) } : {}),
    ...(needs.port ? { port: num(r.port) } : {}),
  };
}

/**
 * A change to the zone `zone`, sent only when it's the zone of a domain that points at this app (read
 * from Orgo again for each change: never a bought domain the window merely names). A record that changed
 * since it was read (Orgo's ids are what a record says) is refused with the records as they are now.
 */
async function changeZone(
  wsId: string,
  name: string,
  zone: unknown,
  recordId: string | null,
  send: (project: string, id: string) => Promise<{ records: OrgoDnsRecord[] }>,
  site?: unknown,
): Promise<AppDnsWritten> {
  if (recordId !== null && !RECORD_ID.test(recordId)) throw new HostedAppError("That isn't a record of this domain.", 400);
  const asked = typeof zone === "string" && UUID.test(zone) ? zone.toLowerCase() : null;
  if (!asked) throw new HostedAppError(NOT_HERE, 404);
  const ours = sameState();
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  const domain = t?.zones.get(asked);
  if (!t || !domain) throw new HostedAppError(NOT_HERE, 404);
  if (!t.project) throw new HostedAppError(NO_PROJECT, 409);
  const project = t.project;
  try {
    return { zone: asked, records: recordsOf(t, (await send(project, asked)).records) };
  } catch (e) {
    if (!(e instanceof OrgoError && e.code === "RECORD_NOT_FOUND")) throw dnsRefused(e);
    held(ours);
    const now = await domains.zone(project, asked).catch(() => null);
    throw new HostedAppError(STALE, 404, { stale: true, ...(now ? { zone: asked, records: zoneView(t, asked, domain, now).records } : {}) });
  }
}

/** POST /api/hosted-apps/[name]/dns/records: a record added to the zone of a domain that points at the app. */
export async function addRecord(wsId: string, name: string, zone: unknown, r: Typed, site?: unknown): Promise<AppDnsWritten> {
  const input = inputOf(r);
  return changeZone(wsId, name, zone, null, (project, id) => domains.addRecord(project, id, input), site);
}

/** PATCH /api/hosted-apps/[name]/dns/records/[recordId]: one of its records changed (`r` is all of it, as it becomes). */
export async function changeRecord(wsId: string, name: string, zone: unknown, recordId: string, r: Typed, site?: unknown): Promise<AppDnsWritten> {
  const input = inputOf(r);
  return changeZone(wsId, name, zone, recordId, (project, id) => domains.changeRecord(project, id, recordId, input), site);
}

/** DELETE /api/hosted-apps/[name]/dns/records/[recordId]: one of its records removed. */
export async function removeRecord(wsId: string, name: string, zone: unknown, recordId: string, site?: unknown): Promise<AppDnsWritten> {
  return changeZone(wsId, name, zone, recordId, (project, id) => domains.removeRecord(project, id, recordId), site);
}

/* ---------------- Adding a domain: one bought now, one the user owns, one the workspace bought ---------------- */

const NO_ADDRESS = "Put it live once first: a domain needs its address to point at.";
const NOT_MINE = "That domain doesn't point at this app.";
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The Orgo workspace the app's computer is in: the one whose bought domains it can serve, and where one is bought for it. */
async function computerProject(t: Target, wsId: string, ours: () => boolean): Promise<string | undefined> {
  const id = (await domains.workspaceOf(t.h.computerId).catch(() => null)) ?? workspace(wsId)?.orgoProjectId;
  held(ours);
  return id ?? undefined;
}

/** The registrant as the window typed it: only the fields the registry takes, each as text, cut to its length (Orgo checks the rest). */
function registrantOf(r: unknown): Record<string, string> {
  const typed = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of REGISTRANT_FIELDS) {
    const v = typed[f.key];
    if (typeof v === "string" && v.trim()) out[f.key] = v.trim().slice(0, f.max);
  }
  return out;
}

/** Who Orgo says the user last registered a domain to, as the form takes it (only the fields it has, as text). */
function contactOf(c: unknown): Registrant | null {
  if (!c || typeof c !== "object") return null;
  const out: Registrant = {};
  for (const f of REGISTRANT_FIELDS) {
    const v = (c as Record<string, unknown>)[f.key];
    if (typeof v === "string" && v.trim()) out[f.key] = v.trim().slice(0, f.max);
  }
  return Object.keys(out).length ? out : null;
}

const BUY_CLOSED = "Buying domains isn't open to your Orgo account yet.";
const BUY_NEEDS = "Buying a domain needs full access to this workspace, signed in with your own Orgo account.";

/**
 * GET /api/hosted-apps/[name]/domains (the window only): what a domain can be added from: whether one can be
 * bought here (open to the account, full access, the person's own key: Orgo's can_buy), the workspace's bought
 * domains nothing points at yet, and who the user last registered one to, to fill the form. That contact goes
 * to the window alone: nothing here keeps it.
 */
export async function domainOptions(wsId: string, name: string, site?: unknown): Promise<AppDomainOptions> {
  const ours = sameState();
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  if (!t) return { buy: { open: false, why: NO_ADDRESS }, owned: [], contact: null };
  const project = await computerProject(t, wsId, ours);
  if (!project) return { buy: { open: false, why: NO_PROJECT }, owned: [], contact: null };
  const list = await domains.bought(project).catch((e: unknown) => e as Error);
  held(ours);
  if (list instanceof Error) {
    if (list instanceof OrgoError && list.code === "DOMAINS_NOT_ENABLED") return { buy: { open: false, why: BUY_CLOSED }, owned: [], contact: null };
    const r = dnsRefused(list);
    return { buy: { open: false, why: r instanceof HostedAppError ? r.message : "Couldn't reach Orgo's domains just now." }, owned: [], contact: null };
  }
  const owned = (list.domains ?? []).filter((d) => d.status === "active" && !(d.pointed ?? []).length).map(({ id, domain }) => ({ id, domain }));
  const open = !!list.registrar && list.can_buy !== false;
  return { buy: open ? { open } : { open, why: list.registrar ? BUY_NEEDS : BUY_CLOSED }, owned, contact: open ? contactOf(list.last_contact) : null };
}

/** A search's words: a name, or a domain to look for (orgo-web checks the rest). */
const QUERY = /^[a-z0-9][a-z0-9.-]{0,252}$/i;

/** Orgo's refusals of a search or a buy, by code, in Bops' words (with the facts the window asks again with). */
function buyRefused(e: unknown, domain = "That domain") {
  if (e instanceof OrgoTimeout || e instanceof TypeError)
    return new HostedAppError(`Orgo didn't answer in time, so it isn't known whether ${domain} was bought. Look again in a minute: it shows up under your domains if it was.`, 504, { code: "NO_ANSWER" });
  if (!(e instanceof OrgoError)) return e;
  const a = e.answer ?? {};
  const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const status = e.status >= 400 && e.status < 600 ? e.status : 502;
  const fail = (text: string, extra: Record<string, unknown> = {}) => new HostedAppError(text, status, { code: e.code, ...extra });
  switch (e.code) {
    case "INSUFFICIENT_CREDITS": {
      const price = cents(a.price_cents);
      const have = cents(a.available_cents);
      return fail(
        price !== null && have !== null
          ? `${domain} costs ${money(price)} and your Orgo credits cover ${money(have)}. Add ${money(Math.max(0, price - have))} or more in credits, then buy it.`
          : `Your Orgo credits don't cover ${domain}. Add credits, then buy it.`,
        { price, available: have },
      );
    }
    case "PRICE_CHANGED": {
      const price = cents(a.price_cents);
      return fail(price !== null ? `The price of ${domain} is ${money(price)} now. Check it, then buy it.` : `The price of ${domain} changed. Search again to see it.`, {
        price,
        renewal: cents(a.renewal_cents_per_year),
        years: cents(a.min_years),
      });
    }
    case "REGISTRATION_UNKNOWN":
      return fail(`The registry hasn't confirmed ${domain} yet. It shows up under your domains once it does, and you can point it here then.`);
    case "DOMAIN_TAKEN":
      return fail(`${domain} was bought through Orgo already. Pick another.`);
    case "DOMAIN_UNAVAILABLE":
      return fail(`${domain} isn't available any more. Pick another.`);
    case "INVALID_DOMAIN":
      return fail("Pick a domain from the search.");
    case "INVALID_REGISTRANT":
      return fail(e.said ?? "Orgo can't take who it's registered to as it is.", typeof a.field === "string" ? { field: a.field } : {});
    case "TLD_NOT_SOLD":
      return fail(e.said ?? "Orgo doesn't sell domains with that ending.");
    case "REGISTRATION_FAILED":
      return fail(e.said ?? "The registry turned it down. Nothing was charged. Try again.");
    case "REGISTRAR_UNAVAILABLE":
      return fail("Domains aren't answering on Orgo just now. Nothing was charged. Try again shortly.");
    case "SEARCH_UNAVAILABLE":
      return fail("Domain search isn't answering just now. Try again shortly.");
    case "INVALID_QUERY":
      return fail("Type a name with letters, numbers or hyphens.", { field: "q" });
    case "ACCOUNT_KEY_REQUIRED":
      return fail("Buying a domain needs your own Orgo sign in, not a key for one workspace. Sign in with Orgo again.");
    case "workspace_read_only":
      return fail("Your access to this workspace is view only, so you can't buy domains for it.");
    case "DOMAINS_NOT_ENABLED":
      return fail(BUY_CLOSED);
    case "DOMAINS_UNAVAILABLE":
    case "unavailable":
      return fail("Domains aren't working on Orgo just now. Nothing was charged. Try again later.");
    case "rate_limited":
      return fail(e.said ?? "That's as many as Orgo allows for now. Try again later.");
    default:
      return refused(e);
  }
}

/**
 * GET /api/hosted-apps/[name]/domains/search (the window only): names to buy for `q`, a page of endings at a
 * time, each with its price in Orgo credits for its shortest term and each year after (orgo-web's search;
 * nothing is held or bought).
 */
export async function searchDomains(wsId: string, name: string, q: unknown, page: unknown, site?: unknown): Promise<DomainSearchAnswer> {
  const words = typeof q === "string" ? q.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "") : "";
  if (!words) throw new HostedAppError("Type a name to look for.", 400, { field: "q" });
  if (!QUERY.test(words)) throw new HostedAppError("Type a name with letters, numbers or hyphens.", 400, { field: "q" });
  const n = typeof page === "number" ? page : typeof page === "string" && /^\d{1,3}$/.test(page) ? Number(page) : 0;
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  if (!(isRepoName(name) && hostingAt(wsId, name, site))) throw new HostedAppError(NO_APP, 404);
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const r = await domains.search(words, n).catch((e: unknown) => Promise.reject(buyRefused(e)));
  held(ours);
  const STATUSES = ["available", "taken", "premium", "unknown"] as const;
  const results = (r.results ?? [])
    .filter((o) => typeof o?.domain === "string")
    .map((o): DomainOffer => {
      const status = (STATUSES as readonly string[]).includes(o.status) ? (o.status as DomainOffer["status"]) : "unknown";
      const priced = status === "available" && typeof o.price_cents === "number";
      return {
        domain: o.domain.toLowerCase(),
        status: status === "available" && !priced ? "unknown" : status,
        price: priced ? o.price_cents : null,
        renewal: priced && typeof o.renewal_cents_per_year === "number" ? o.renewal_cents_per_year : null,
        years: priced && typeof o.min_years === "number" ? o.min_years : null,
      };
    });
  return { results, next: typeof r.next_page === "number" ? r.next_page : null, ...(r.registrar_error ? { partial: true } : {}) };
}

/** A domain as it's typed to point here: lowercase, without a scheme, a path or a dot at its end. */
function domainTyped(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return d.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(d) ? d : null;
}

/** Orgo's refusals of pointing a domain at the app, in Bops' words. */
function connectRefused(e: unknown) {
  if (!(e instanceof OrgoError)) return e;
  const status = e.status >= 400 && e.status < 500 ? e.status : 502;
  if (e.code === "INVALID_DOMAIN") return new HostedAppError(e.said ?? "Type a domain like app.example.com.", 400, { field: "domain" });
  if (e.code === "CUSTOM_DOMAINS_NOT_ENABLED") return new HostedAppError("Domains of its own aren't open to your Orgo account yet.", status);
  if (e.code === "REGISTERED_DOMAIN_NOT_FOUND") return new HostedAppError("That isn't one of this workspace's domains.", status);
  if (e.status === 409 && !e.code) return new HostedAppError("That domain is on another Orgo computer already.", 409, { field: "domain" });
  if (e.status === 403 && !e.code && e.said) return new HostedAppError(`Orgo says: ${e.said}`, 403);
  if (e.code === "NAME_IN_USE" || e.code === "INVALID_SUBDOMAIN" || e.code === "CUSTOM_DOMAINS_UNSUPPORTED" || e.code === "UPGRADE_REQUIRED" || e.code === "HOSTING_BLOCKED")
    return new HostedAppError(e.said ? `Orgo says: ${e.said}` : "Orgo can't point that domain here.", status);
  return dnsRefused(e);
}

/** Point a domain at the app's port on its computer, as `body` names it; answers its domains as they are now, with that one. */
async function pointHere(wsId: string, name: string, t: Target, body: { domain: string } | { registered_domain_id: string; subdomain: string }, ours: () => boolean): Promise<AppDomainAdded> {
  if (t.port === null) throw new HostedAppError("Orgo doesn't say which port this app listens on, so no domain can point at it.", 409);
  held(ours);
  const c = await domains.connect(t.h.computerId, body, t.port).catch((e: unknown) => Promise.reject(connectRefused(e)));
  held(ours);
  const now = await domainsNow(wsId, name, ours, t.h.site);
  return { domains: now, domain: now.domains.find((d) => d.id === c.id) ?? null };
}

/**
 * POST /api/hosted-apps/[name]/domains "connect": a domain pointed at the app (its computer serves it on
 * the app's port): one the user owns, typed (Orgo answers the records to set where its DNS is kept; one
 * under a domain bought through Orgo, Orgo writes itself), or one of the workspace's bought domains, by id
 * (one it has, read again here, never only the window's word).
 */
export async function connectDomain(wsId: string, name: string, ask: { domain?: unknown; zone?: unknown }, site?: unknown): Promise<AppDomainAdded> {
  const ours = sameState();
  const typed = ask.zone === undefined ? domainTyped(ask.domain) : null;
  if (ask.zone === undefined && !typed) throw new HostedAppError("Type a domain like app.example.com.", 400, { field: "domain" });
  const zone = ask.zone !== undefined ? (typeof ask.zone === "string" && UUID.test(ask.zone) ? ask.zone.toLowerCase() : null) : undefined;
  if (zone === null) throw new HostedAppError("That isn't one of this workspace's domains.", 404);
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  if (!t) throw new HostedAppError(NO_ADDRESS, 409);
  if (typed) {
    const there = t.all.find((d) => d.domain.toLowerCase() === typed);
    if (there) throw new HostedAppError(t.mine.includes(there) ? "That domain points at this app already." : "That domain points at another app on this computer. Remove it there first.", 409, { field: "domain" });
    return pointHere(wsId, name, t, { domain: typed }, ours);
  }
  const project = await computerProject(t, wsId, ours);
  const list = project ? await domains.bought(project).catch((e: unknown) => Promise.reject(dnsRefused(e))) : null;
  held(ours);
  const b = list?.domains?.find((d) => d.id.toLowerCase() === zone && d.status === "active");
  if (!b) throw new HostedAppError("That isn't one of this workspace's domains.", 404);
  if (t.all.some((d) => d.domain.toLowerCase() === b.domain.toLowerCase())) throw new HostedAppError(`${b.domain} points at an app on this computer already.`, 409);
  return pointHere(wsId, name, t, { registered_domain_id: b.id, subdomain: "" }, ours);
}

/**
 * POST /api/hosted-apps/[name]/domains "buy": a domain bought for the workspace, charged to the user's Orgo
 * credits at `price`, the price in cents they saw and agreed to (Orgo refuses it with the new one when it
 * changed: nothing is bought then), then pointed at this app. Only after the user pressed Buy, and only once:
 * nothing here sends it again. Bought but not pointed here (Orgo couldn't, or another account signed in
 * meanwhile, when nothing more goes): the domain stays the workspace's, and it says so.
 */
export async function buyDomain(wsId: string, name: string, ask: { domain?: unknown; registrant?: unknown; price?: unknown }, site?: unknown): Promise<AppDomainAdded> {
  const domain = domainTyped(ask.domain);
  if (!domain) throw new HostedAppError("Pick a domain from the search.", 400);
  if (typeof ask.price !== "number" || !Number.isInteger(ask.price) || ask.price < 0) throw new HostedAppError("Pick a domain from the search to see its price first.", 400);
  const registrant = registrantOf(ask.registrant);
  const ours = sameState();
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  if (!t) throw new HostedAppError(NO_ADDRESS, 409);
  if (t.port === null) throw new HostedAppError("Orgo doesn't say which port this app listens on, so no domain can point at it.", 409);
  const project = await computerProject(t, wsId, ours);
  if (!project) throw new HostedAppError(NO_PROJECT, 409);
  held(ours);
  const bought = await domains.buy(project, domain, registrant, ask.price).catch((e: unknown) => Promise.reject(buyRefused(e, domain)));
  // Bought (or the workspace's already, which Orgo doesn't charge for again). From here on, another account
  // signing in stops it: the domain stays where it was bought.
  held(ours);
  try {
    return { ...(await pointHere(wsId, name, t, { registered_domain_id: bought.id, subdomain: "" }, ours)), bought: bought.domain };
  } catch (e) {
    if (e instanceof HostedAppError && e.message === SWAPPED) throw e;
    const why = e instanceof HostedAppError ? e.message : "Orgo didn't answer.";
    held(ours);
    const now = await domainsNow(wsId, name, ours, t.h.site).catch(() => null);
    return {
      domains: now ?? { url: t.url, domains: [], zones: [] },
      domain: null,
      bought: bought.domain,
      error: `Bought ${bought.domain}, but it isn't pointed at this app yet: ${why.replace(/\s*Try again[^.]*\.?$/, "").replace(/\.$/, "")}. It's under your domains not in use: press Use there to try again.`,
    };
  }
}

/** One of the app's domains, read again for a change (a domain id the window names is only ever one of these). */
async function mineOf(wsId: string, name: string, domainId: string, ours: () => boolean, site?: unknown): Promise<{ t: Target; d: OrgoCustomDomain }> {
  if (!UUID.test(domainId) && !/^[\w-]{1,80}$/.test(domainId)) throw new HostedAppError(NOT_MINE, 404);
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  const d = t?.mine.find((x) => x.id === domainId);
  if (!t || !d) throw new HostedAppError(NOT_MINE, 404);
  return { t, d };
}

/**
 * POST /api/hosted-apps/[name]/domains/[domainId]: Orgo asked to check one of its domains now (verify), which
 * turns it on once its DNS answers. While it doesn't yet, it answers how it is (for one bought elsewhere, the
 * records to set with what Orgo found of each) and why, in words.
 */
export async function checkDomain(wsId: string, name: string, domainId: string, site?: unknown): Promise<AppDomainChecked> {
  const ours = sameState();
  const { t, d } = await mineOf(wsId, name, domainId, ours, site);
  if (d.status === "active") {
    // Live already: one bought elsewhere is looked at again, to say whether what routes it is still set.
    const now = await domainOf(t, d, !d.managed);
    if (d.managed || !now.publish.some((r) => r.found)) return { domain: now };
    const at = now.where ? `at ${now.where}` : "where its DNS is kept";
    const off = now.publish.filter((r) => r.found !== "ok").map((r) => r.type);
    return { domain: now, said: off.length ? `Its ${off.join(" and ")} record ${at} isn't set as shown, so it may not reach this app.` : `Its records ${at} are set right.` };
  }
  if (d.status === "disabled") return { domain: await domainOf(t, d), said: "Orgo turned this domain off. Ask Orgo support to turn it back on." };
  held(ours);
  try {
    const r = await domains.verify(t.h.computerId, d.id);
    held(ours);
    const status = r?.status === "active" ? "active" : "verifying";
    return { domain: await domainOf(t, { ...d, status }) };
  } catch (e) {
    if (e instanceof HostedAppError) throw e;
    if (!(e instanceof OrgoError)) throw e;
    held(ours);
    if (e.status === 409 && (e.code === "TXT_NOT_FOUND" || e.code === "DNS_NOT_POINTED")) {
      const said = d.managed
        ? "Orgo set its records. They can take a few minutes to answer."
        : e.code === "TXT_NOT_FOUND"
          ? "The records aren't there yet. New ones can take a few minutes to show up."
          : `${d.domain} doesn't point at Orgo yet. New records can take a few minutes to show up.`;
      return { domain: await domainOf(t, { ...d, status: "verifying" }), said };
    }
    if (e.status === 409 && e.answer?.status === "disabled") return { domain: await domainOf(t, { ...d, status: "disabled" }), said: "Orgo turned this domain off. Ask Orgo support to turn it back on." };
    if (e.status === 403 && !e.code && e.said) throw new HostedAppError(`Orgo says: ${e.said}`, 403);
    throw connectRefused(e);
  }
}

/**
 * DELETE /api/hosted-apps/[name]/domains/[domainId]: one of its domains taken off the app (a bought one's
 * records Orgo wrote for it go too; the domain itself stays the workspace's). Answers its domains as they are now.
 */
export async function removeDomain(wsId: string, name: string, domainId: string, site?: unknown): Promise<AppDomainsAnswer> {
  const ours = sameState();
  const { t, d } = await mineOf(wsId, name, domainId, ours, site);
  held(ours);
  const gone = await domains.remove(t.h.computerId, d.id).then(
    () => null,
    (e: unknown) => e,
  );
  held(ours);
  // Gone already is gone.
  if (gone && !(gone instanceof OrgoError && gone.status === 404)) {
    if (gone instanceof OrgoError && gone.status === 409) throw new HostedAppError("Orgo turned this domain off, so only Orgo support can remove it.", 409);
    throw connectRefused(gone);
  }
  return domainsNow(wsId, name, ours, t.h.site);
}

/**
 * PATCH /api/hosted-apps/[name]/domains: a bought domain's auto-renew turned on (its renewals are paid from
 * the user's Orgo credits from then on) or off, for a domain that points at this app only (`zone`: its id).
 */
export async function setAutoRenew(wsId: string, name: string, zone: unknown, on: unknown, site?: unknown): Promise<{ renewal: AppRenewal | null }> {
  if (typeof on !== "boolean") throw new HostedAppError("Say whether it renews.", 400);
  const asked = typeof zone === "string" && UUID.test(zone) ? zone.toLowerCase() : null;
  if (!asked) throw new HostedAppError(NOT_HERE, 404);
  const ours = sameState();
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  if (!t || !t.zones.has(asked)) throw new HostedAppError(NOT_HERE, 404);
  if (!t.project) throw new HostedAppError(NO_PROJECT, 409);
  held(ours);
  const r = await domains.autoRenew(t.project, asked, on).catch((e: unknown) => {
    if (e instanceof OrgoError && e.code === "ACCOUNT_KEY_REQUIRED") return Promise.reject(new HostedAppError("Changing auto-renew needs your own Orgo sign in, not a key for one workspace.", 403));
    if (e instanceof OrgoError && e.code === "workspace_read_only") return Promise.reject(new HostedAppError("Your access to this workspace is view only, so its renewals aren't yours to change.", 403));
    if (e instanceof OrgoError && e.code === "INVALID_AUTO_RENEW") return Promise.reject(new HostedAppError("Say whether it renews.", 400));
    return Promise.reject(dnsRefused(e));
  });
  held(ours);
  return { renewal: renewalOf(r?.domain) ?? null };
}

/* ---------------- Adding and removing a site, and removing an app ---------------- */

/**
 * POST /api/hosted-apps/[name] "addSite": one more site of the app, by name (one its public address can
 * take, not the app's nor another site's), from the same repo on the same computer. Only its name is kept
 * now: its deploy project is made with its first deploy, or when its variables are first saved, with its own
 * port (the next one free there). Answers the app as it is now.
 */
export async function addSite(wsId: string, name: string, site: unknown): Promise<{ app: HostedApp }> {
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  const typed = typeof site === "string" ? site.trim() : "";
  if (!typed) throw new HostedAppError("Give it a name.", 400, { field: "site" });
  if (!isSiteName(typed)) throw new HostedAppError("Use lowercase letters, numbers and single hyphens, 32 at most, like shop-admin.", 400, { field: "site" });
  if (typed === name || h.sites?.some((x) => x.name === typed)) throw new HostedAppError(`${name} has a site called ${typed} already. Pick another name.`, 409, { field: "site" });
  if (1 + (h.sites?.length ?? 0) >= MAX_SITES) throw new HostedAppError(`An app can have ${MAX_SITES} sites at most, as many as one computer runs.`, 409, { field: "site" });
  notRemoving(wsId, name);
  keepHosting(wsId, name, (x) => x && { ...x, sites: [...(x.sites ?? []).filter((y) => y.name !== typed), { name: typed }] });
  return { app: await appNow(wsId, name, ours) };
}

/**
 * One site taken off its computer: the domains there on its port first (a bought one's records Orgo wrote
 * go with it; the domain itself stays the workspace's), then its deploy project (its runner, releases and
 * public URL). One Orgo has no more is gone already. Answers the domains Orgo wouldn't remove (one it turned
 * off), which are said; any other refusal stops it, nothing kept changed.
 */
async function takeDown(s: SiteHosting, ours: () => boolean): Promise<string[]> {
  if (!s.projectId || s.lost) return [];
  const p = await deploys.project(s.computerId, s.projectId).catch((e: unknown) => e as Error);
  held(ours);
  if (gone(p)) return [];
  if (p instanceof Error) throw refused(p);
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  const port = typeof p.value.port === "number" ? p.value.port : null;
  const left: string[] = [];
  if (port !== null) {
    const list = await domains.ofComputer(s.computerId).catch((e: unknown) => Promise.reject(dnsRefused(e)));
    held(ours);
    for (const d of (list.domains ?? []).filter((x) => x.target_port === port)) {
      const r = await domains.remove(s.computerId, d.id).then(
        () => null,
        (e: unknown) => e,
      );
      held(ours);
      if (!r || (r instanceof OrgoError && r.status === 404)) continue;
      if (r instanceof OrgoError && r.status === 409) left.push(d.domain);
      else throw connectRefused(r);
    }
  }
  const r = await deploys.remove(s.computerId, s.projectId).catch((e: unknown) => e as Error);
  held(ours);
  if (r instanceof Error && !gone(r)) throw refused(r);
  if (!(r instanceof Error) && !r.enabled) throw new HostedAppError(r.why, 403);
  return left;
}

/** What a removal says of the domains Orgo kept (turned off, so only Orgo support can remove them). */
const keptDomains = (left: string[]) =>
  left.length ? `${left.join(", ")} ${left.length === 1 ? "is" : "are"} still on its computer: Orgo turned ${left.length === 1 ? "it" : "them"} off, so only Orgo support can remove ${left.length === 1 ? "it" : "them"}.` : undefined;

/**
 * POST /api/hosted-apps/[name] "removeSite": one of the app's other sites (never its own: that goes with the
 * app) taken off its computer, its domains there too (takeDown), and dropped from the app. Not while a deploy
 * of it is being sent (withApp). Answers the app as it is now, and what Orgo kept.
 */
export async function removeSite(wsId: string, name: string, site: unknown): Promise<{ app: HostedApp; said?: string }> {
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (typeof site !== "string" || !site) throw new HostedAppError(NO_SITE, 404);
  if (site === name) throw new HostedAppError("The app's own site goes only with the app. Remove the app instead.", 400);
  siteIn(h, name, site);
  // (Never while a deploy is being sent: it would make the site's project again, with nothing here to keep it.)
  const said = await withApp(wsId, name, "removeSite", async () => {
    const now = hostingOf(wsId, name);
    if (!now) throw new HostedAppError(NO_APP, 404);
    const s = siteIn(now, name, site);
    if (s.projectId && !s.lost) {
      const why = await closedHere();
      held(ours);
      if (why) throw new HostedAppError(why, 403);
    }
    const left = keptDomains(await takeDown(s, ours));
    keepHosting(wsId, name, (x) => {
      if (!x) return x;
      const { sites, ...rest } = x;
      const others = (sites ?? []).filter((y) => y.name !== s.site);
      return others.length ? { ...rest, sites: others } : rest;
    });
    return left;
  });
  return { app: await appNow(wsId, name, ours), ...(said ? { said } : {}) };
}

/**
 * DELETE /api/hosted-apps/[name] (the window only, asked once more there): the app removed from the
 * workspace. Each of its sites is taken off its computer first, its domains there too (takeDown; nothing of
 * one whose computer is gone is left to remove), each forgotten as it goes, so one Orgo turns down stops
 * it there and pressing it again picks up where it stopped. Then its Ingot repo is deleted, all its history
 * with it, only when `repo` is true (the owner ticked it): else the code stays in Ingot. Then its record
 * goes (keepHosting: its computer's token too, once no app of the workspace is on it). Its projects left on
 * a computer it moved off (behind) are taken down the same. Not while a task is at work on it (the task
 * would make its record again), nor while a deploy of it is being sent or a first save makes a project
 * (withApp).
 */
export async function removeApp(wsId: string, name: string, ask: { repo?: unknown }): Promise<RemoveAppAnswer> {
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  const repo = ask.repo === true;
  const busy = getState().sessions.find((x) => x.app?.wsId === wsId && x.app.name === name && isLive(x));
  if (busy) throw new HostedAppError(`${bot(busy.botId)?.name ?? "A bot"} is working on it now. Stop that task first, then remove it.`, 409);
  // (Never while a deploy is being sent: it would go on to put sites on the web with nothing here to keep them.)
  return withApp(wsId, name, "remove", () => takeAppDown(wsId, name, repo, ours));
}

/** removeApp, with nothing else under way on the app (withApp). */
async function takeAppDown(wsId: string, name: string, repo: boolean, ours: () => boolean): Promise<RemoveAppAnswer> {
  const h = hostingOf(wsId, name);
  if (!h) throw new HostedAppError(NO_APP, 404);
  const sites = h.lost ? [] : sitesOf(h, name).filter((x) => x.projectId);
  // Its projects on a computer it moved off, still serving there (movedTo).
  const behind = h.behind ?? [];
  if (sites.length || behind.length || repo) {
    const why = await closedHere();
    held(ours);
    if (why) throw new HostedAppError(why, 403);
  }
  const left: string[] = [];
  for (const s of sites) {
    left.push(...(await takeDown(s, ours)));
    keepSite(wsId, name, s.site, () => ({}));
  }
  // (One whose computer is gone since went with it: Orgo has neither.)
  const gone404 = (e: unknown) => (e instanceof HostedAppError && e.status === 404 ? [] : Promise.reject(e));
  for (const b of behind) {
    left.push(...(await takeDown({ botId: h.botId, computerId: b.computerId, projectId: b.projectId, site: b.site }, ours).catch(gone404)));
    keepHosting(wsId, name, (x) => {
      if (!x) return x;
      const { behind: had, ...rest } = x;
      const still = (had ?? []).filter((y) => y.projectId !== b.projectId);
      return still.length ? { ...rest, behind: still } : rest;
    });
  }
  if (repo) {
    held(ours);
    await ingot.deleteRepo(wsId, name).catch((e: unknown) =>
      Promise.reject(e instanceof IngotError ? new HostedAppError(`${sites.length || behind.length ? "Its sites are off the web, but its code wasn't deleted" : "Its code wasn't deleted"}: ${e.message}`, e.offline ? 503 : 502) : e),
    );
    held(ours);
    listed.delete(wsId);
  }
  keepHosting(wsId, name, () => undefined);
  const said = keptDomains(left);
  return { removed: name, repo, ...(said ? { said } : {}) };
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
 * isn't on Orgo yet can't have apps (Ingot keeps its repos under its Orgo project). `deploy`: the user asked
 * for it to go live too, which Bops does itself once the task has committed (deployAfterTask), so the task is
 * told that rather than to have them deploy it.
 */
export function appWork(botId: string, a: { app: string | null; name: string | null; change: string; deploy?: boolean }): { goal: string; title: string; name: string } {
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
  // (One whose computer is gone is any bot's to give a new home.)
  if (h && other && !h.lost && workspaceOf(other) === wsId && h.computerId !== computerId)
    throw new HostedAppError(`${name} is on ${other.name}'s computer, so it's ${other.name}'s to work on.`, 409);
  // Its record: this bot and its computer (a bot that's gone hands it on; another computer's projects don't come along, its sites' names do).
  if (computerId && (!h || h.lost || h.computerId !== computerId || !bot(h.botId))) keepHosting(wsId, name, (x) => movedTo(x, name, botId, computerId));
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
    a.deploy
      ? `4. Say what you changed. ${owner} asked for it to go live too: once you've committed and this task ends, Bops deploys its newest commit itself and tells them where it's live, so don't tell them to deploy it. If you couldn't commit it, say why.`
      : `4. Say what you changed. ${owner} puts it live from the Apps page, or by asking me.`,
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
 * made again. A task asked to put the app live too notes the app's newest commit the first time (keepFrom).
 * Answers what was done, for the task's steps (undefined: the task isn't on an app). Throws IngotError when it
 * can't be made ready.
 */
export async function readyAppForTask(sessionId: string, computerId: string, signal?: AbortSignal): Promise<string | undefined> {
  const s = session(sessionId);
  const a = taskApp(s);
  if (!s || !a) return undefined;
  const ours = sameState();
  await ensureIngotCli(computerId, a.wsId, { signal, botId: s.botId });
  stillOurs(ours);
  const h = hostingOf(a.wsId, a.name);
  if (!h || h.lost || h.computerId !== computerId) {
    if (h) console.warn(`[hosted-apps] ${a.name} moves from ${h.computerId} to ${computerId}: ${h.lost ? "its computer is gone" : "its bot's computer is another one now"}`);
    keepHosting(a.wsId, a.name, (x) => movedTo(x, a.name, s.botId, computerId));
  }
  await ingot.createRepo(a.wsId, a.name, authorOf(s.botId), signal);
  stillOurs(ours);
  listed.delete(a.wsId);
  let said: string;
  try {
    said = await readyFolder(computerId, a.wsId, a.name, signal);
  } catch (e) {
    if (!(e instanceof IngotError && e.refused)) throw e;
    stillOurs(ours);
    console.warn(`[hosted-apps] ${computerId}: Ingot turned its token away, so it gets a new one`);
    await ensureIngotCli(computerId, a.wsId, { signal, botId: s.botId, renew: true });
    stillOurs(ours);
    said = await readyFolder(computerId, a.wsId, a.name, signal);
  }
  await keepFrom(sessionId, a, ours, signal);
  return said;
}

/** The task's own record of its app (Session.app), to change in place inside update(). */
const appOfTask = (st: { sessions: Session[] }, sessionId: string) => st.sessions.find((x) => x.id === sessionId)?.app;

/**
 * A task asked to put its app live after (Session.app.deployAfter), as it first starts with that ask: the app's
 * newest commit now (null: nothing committed yet), which a new commit is told from as it ends (deployAfterTask).
 * Left unset when Ingot can't say now; one read is never read again (the run after an answer, a restart).
 */
async function keepFrom(sessionId: string, a: { wsId: string; name: string }, ours: () => boolean, signal?: AbortSignal) {
  const now = session(sessionId)?.app;
  if (!now?.deployAfter || now.from !== undefined) return;
  const head = await ingot.head(a.wsId, a.name, signal).catch(() => undefined);
  stillOurs(ours);
  if (head === undefined) return;
  update((st) => {
    const x = appOfTask(st, sessionId);
    if (x?.deployAfter && x.from === undefined) x.from = head;
  });
}

/**
 * work_on_app's deploy for the task doing the work: one asked of a task already on that app (sessions.ts
 * foldInto, or one Jev found doing the same job) puts it live after, too. Only ever set here, never taken
 * off: an ask for more on it that doesn't say deploy still ends with the deploy an earlier one asked for.
 */
export function askDeploy(sessionId: string, app: { wsId: string; name: string }) {
  const x = session(sessionId)?.app;
  if (!x || x.wsId !== app.wsId || x.name !== app.name || x.deployAfter) return;
  update((st) => {
    const y = appOfTask(st, sessionId);
    if (y) y.deployAfter = true;
  });
}

/**
 * POST /api/hosted-apps (the Apps page's Add app): a new app, built by the workspace's main bot on its
 * computer, as work_on_app starts one (appWork, then a task through the normal task path), and put live once
 * it has committed when `deploy`. Its name is refused when it isn't one an Ingot repo can have, or another app
 * of the workspace, or a repo in its Ingot workspace, has it; while Ingot isn't answering, as it can't be told
 * free. A line in the bot's chat says it's making it, with the task's chip.
 */
export async function addApp(wsId: string, ask: { name?: unknown; what?: unknown; deploy?: unknown }): Promise<AddAppAnswer> {
  const ours = sameState();
  const ws = workspace(wsId);
  if (!ws) throw new HostedAppError("That workspace is gone.", 404);
  const name = typeof ask.name === "string" ? ask.name.trim() : "";
  if (!name) throw new HostedAppError("Give it a name.", 400, { field: "name" });
  if (!isRepoName(name)) throw new HostedAppError("Use lowercase letters, numbers and single hyphens for its name, like recipe-box.", 400, { field: "name" });
  const what = typeof ask.what === "string" ? ask.what.trim().slice(0, 4000) : "";
  if (!what) throw new HostedAppError("Say what it should be.", 400, { field: "what" });
  if (!ws.orgoProjectId) throw new HostedAppError(NO_PROJECT, 409);
  const taken = () => new HostedAppError(`There's an app called ${name} in this workspace already. Pick another name.`, 409, { field: "name" });
  if (ws.hostedApps?.[name]) throw taken();
  const b = mainBot(wsId);
  if (!b) throw new HostedAppError("This workspace has no main bot to build it.", 409);
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  listed.delete(wsId);
  const repos = await reposOf(wsId);
  const { startSession } = await import("./sessions");
  held(ours);
  if (!repos) throw new HostedAppError("Ingot isn't answering, so I can't tell whether that name is free. Try again in a minute.", 503);
  if (repos.some((r) => r.name === name) || workspace(wsId)?.hostedApps?.[name]) throw taken();
  const deploy = ask.deploy === true;
  // From here on it's all at once: nothing waits between keeping the app and starting its task.
  const w = appWork(b.id, { app: null, name, change: what, deploy });
  const app = { wsId, name: w.name };
  const chatId = botChatId(b.id);
  const task = startSession({ botId: b.id, goal: w.goal, title: w.title, chatId, sentVia: "you", where: "cloud", app: deploy ? { ...app, deployAfter: true } : app });
  // Asked of a task already on the app (sessions.ts foldInto): that one puts it live after, too.
  if (deploy) askDeploy(task.id, app);
  if (getState().chats.some((c) => c.id === task.chatId))
    addMessage({
      chatId: task.chatId,
      role: "bot",
      botId: b.id,
      text: `Making ${w.name} on my computer. ${deploy ? "I'll put it live once it's built." : "Put it live from the Apps page once it's built."}`,
      sessionIds: [task.id],
      appNote: true,
      bops: true,
    });
  return { name: w.name, botId: b.id, chatId: task.chatId, sessionId: task.id };
}

/**
 * A task on an app asked to put it live too (Session.app.deployAfter) ended a run (sessions.ts, also for one
 * whose computer couldn't be set up): done with a commit newer than the one it started from (or with any,
 * when Ingot couldn't say), Bops deploys the app's newest commit itself, as deploy_app does, and posts how it
 * went in its chat as the bot, under the task's chip. Done with nothing new committed, or not done, it says the
 * app isn't live yet, and the ask stays for the task's next run (an answer to its question, Try again). The ask
 * is taken off the task, and saved, before Orgo is asked: a task picked up again, moved or rerun after a
 * restart never deploys it twice for one ask. Nothing for a task that moved on to another thread, nor while its
 * brain waits on the user (signing in there, its plan's limit); sessions.ts doesn't call it for a run the user
 * stopped (Stop, a takeover, its terminal). Another account's state coming in meanwhile stops it, saying nothing.
 */
export async function deployAfterTask(sessionId: string): Promise<void> {
  const s = session(sessionId);
  const a = taskApp(s);
  if (!s || !a || !s.app?.deployAfter || s.replacedBy || (s.status === "done" && s.brainRun?.waits)) return;
  const ours = sameState();
  const say = (text: string) => {
    if (ours()) addMessage({ chatId: s.chatId, role: "bot", botId: s.botId, text, sessionIds: [s.id], appNote: true, bops: true });
  };
  if (s.status !== "done") return say(`Didn't put ${a.name} live: the task didn't finish. If it picks up again and commits its change, I'll deploy it then.`);
  // Its newest commit now (null: nothing committed; undefined: Ingot can't say, so the task's own word, done, goes).
  const head = await ingot.head(a.wsId, a.name).then(
    (x) => x ?? null,
    () => undefined,
  );
  if (!ours()) return;
  const now = session(sessionId)?.app;
  if (!now?.deployAfter) return;
  if (head === null || (head !== undefined && head === now.from))
    return say(`Didn't put ${a.name} live: the task committed nothing new to it. If it commits its change when it picks up again, I'll deploy it then.`);
  let mine = false;
  update((st) => {
    const x = appOfTask(st, sessionId);
    if (!x?.deployAfter) return;
    delete x.deployAfter;
    if (head !== undefined) x.from = head;
    mine = true;
  });
  if (!mine) return;
  await flushState(5000).catch(() => false);
  if (!ours()) return;
  say(await deployForBot(s.botId, a.name, null, ours).catch((e: Error) => `Not deployed: ${e.message}`));
}

/** How many pages of an app's log (200 each) a short id is looked for in. */
const LOOK_PAGES = 10;

/**
 * The whole id of a changeset of an app from what a bot gave: a whole one, or its start (4 to 63 hex, as
 * `ingot commit` and `ingot log` print it), looked up on main in Ingot. Refused when it's no changeset of
 * the app's, or the start of more than one, or Ingot can't be reached to look.
 */
async function wholeId(wsId: string, name: string, at: string, ours: () => boolean): Promise<string> {
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
    held(ours);
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
 * put on the web, in words for the model, with its public URL when there is one. `ours`: the state the work
 * began on, when it began before this call (deployAfterTask).
 */
export async function deployForBot(botId: string, app: string, at: string | null, ours = sameState()): Promise<string> {
  const b = bot(botId);
  if (!b) return "That bot is gone.";
  const wsId = workspaceOf(b);
  const name = appNamed(wsId, app);
  if (!name) return `There's no app called "${app.slice(0, 80)}" in this workspace.`;
  try {
    const id = at ? await wholeId(wsId, name, at, ours) : undefined;
    const { app: now, deployed } = await deployApp(wsId, name, { ...(id ? { at: id } : {}), botId, ours });
    const where = now.hosting ? bot(now.hosting.botId)?.name : undefined;
    const url = now.hosting?.url;
    const what = id ? `${name} at ${short(id)}` : `the newest commit of ${name}`;
    if (deployed.length > 1) {
      const each = deployed.map((d) => (d.url ? `${d.site} at ${d.url}` : `${d.site} (its address comes once this first deploy is live)`));
      return `Deploying ${what} to its ${deployed.length} sites${where ? ` on ${where}'s computer` : ""}, one after another: ${each.join("; ")}. Each is live in a few minutes, as Orgo builds them one at a time.`;
    }
    return `Deploying ${what}${where ? ` on ${where}'s computer` : ""}. ${url ? `It's live at ${url} in a minute or two.` : "It gets its public address once this first deploy is live, and the Apps page shows it then."}`;
  } catch (e) {
    // (Some of its sites went, which its words say first: not "Not deployed".)
    if (e instanceof HostedAppError) return e.extra?.partial ? e.message : `Not deployed: ${e.message}`;
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
  const where = (x: { url?: string; projectId?: string }) => (x.url ? `live at ${x.url}` : x.projectId ? "deployed, no address yet" : "not on the web yet");
  const one = ([name, h]: [string, AppHosting]) => {
    const on = h.botId !== botId ? bot(h.botId)?.name : undefined;
    if (h.lost) return `${name} (its computer is gone, so it needs a new home: deploy_app or work_on_app gives it one)`;
    const more = h.sites?.length ? `, and its other sites from the same repo, deployed with it: ${h.sites.map((x) => `${x.name} ${where(x)}`).join(", ")}` : "";
    return `${name} (${where(h)}${more}${on ? `, on ${on}'s computer` : ""})`;
  };
  return `Your workspace's apps on the web, each an Ingot repo (work_on_app to build or change one, deploy_app to put it live): ${apps.map(one).join("; ")}.`;
}
