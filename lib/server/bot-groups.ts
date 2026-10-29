import "server-only";
import { cleanComputerName, shownDomain, siteExists } from "@/lib/bot-groups";
import { siteOf, workBot, workspaceOf, type AppState, type BotSite } from "@/lib/types";
import { deploys, domains } from "./orgo";
import { bot, getState, update } from "./store";

/*
 * The owner's names for their computers (Workspace.computerNames) and the site each bot works on (Workspace.botSites),
 * kept on the workspace (lib/types.ts BotSite says why there and not on the bot), and the domains the sidebar shows for
 * those sites (botSiteDomains). Only the owner's own window changes them (app/api/workspaces, app/api/bots).
 */

export class GroupError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The computers workspace `wsId`'s bots work on (lib/types.ts workBot), by id. */
const computersOf = (s: AppState, wsId: string) => new Set(s.bots.filter((b) => workspaceOf(b) === wsId).flatMap((b) => workBot(b, s.bots).computerId ?? []));

/**
 * Name one of workspace `wsId`'s computers (one its bots work on), or, with an empty name, give it its default back
 * (lib/bot-groups.ts defaultComputerName). Answers the name kept ("" for the default).
 */
export function setComputerName(wsId: string, computerId: unknown, name: unknown): string {
  const s = getState();
  const w = s.workspaces?.find((x) => x.id === wsId);
  if (!w) throw new GroupError("That workspace is gone.", 404);
  if (typeof computerId !== "string" || !computersOf(s, wsId).has(computerId)) throw new GroupError("None of this workspace's bots work on that computer.", 404);
  if (name !== undefined && name !== null && typeof name !== "string") throw new GroupError("Say its name.", 400);
  const kept = cleanComputerName(name);
  update((st) => {
    const x = st.workspaces?.find((y) => y.id === wsId);
    if (!x) return;
    const all = { ...(x.computerNames ?? {}) };
    if (kept) all[computerId] = kept;
    else delete all[computerId];
    if (Object.keys(all).length) x.computerNames = all;
    else delete x.computerNames;
  });
  return kept;
}

/** A link as the bots API takes it: { app, site }, or null for none. */
export function linkFrom(v: unknown): BotSite | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== "object") return undefined;
  const { app, site } = v as Record<string, unknown>;
  if (typeof app !== "string" || !app) return undefined;
  return { app, site: typeof site === "string" && site ? site : app };
}

/** Bot `botId` works on site `link` of one of its workspace's apps, or (null) on none. */
export function setBotSite(botId: string, link: BotSite | null) {
  const b = bot(botId);
  if (!b) throw new GroupError("no such bot", 404);
  const wsId = workspaceOf(b);
  const s = getState();
  const w = s.workspaces?.find((x) => x.id === wsId);
  if (link && !siteExists(w, link)) throw new GroupError("There's no site by that name in this workspace's apps.", 404);
  if (!w) {
    if (link) throw new GroupError("That workspace is gone.", 404);
    return;
  }
  update((st) => {
    const x = st.workspaces?.find((y) => y.id === wsId);
    if (!x) return;
    const all = { ...(x.botSites ?? {}) };
    if (link) all[botId] = { app: link.app, site: link.site };
    else delete all[botId];
    if (Object.keys(all).length) x.botSites = all;
    else delete x.botSites;
  });
}

/** A deleted bot's site goes with it (called inside update()). */
export function forgetBotSite(s: AppState, botId: string, wsId: string) {
  const w = s.workspaces?.find((x) => x.id === wsId);
  if (!w?.botSites || !Object.hasOwn(w.botSites, botId)) return;
  const { [botId]: _gone, ...rest } = w.botSites;
  void _gone;
  if (Object.keys(rest).length) w.botSites = rest;
  else delete w.botSites;
}

/* ---------------- The domains the sidebar shows ---------------- */

/** How long a read is kept, and how long one waits for Orgo: they only change what a row says under a name. */
const KEPT_MS = 5 * 60_000;
const WAIT_MS = 4000;
const MISSED_MS = 30_000;

const g = globalThis as typeof globalThis & { bopsSiteDomains?: Map<string, { at: number; links: string; value: Promise<Record<string, string | null>> }> };
const kept = (g.bopsSiteDomains ??= new Map());

const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((done) => {
    const t = setTimeout(() => done(null), ms);
    p.then(
      (v) => (clearTimeout(t), done(v)),
      () => (clearTimeout(t), done(null)),
    );
  });

/**
 * The domain each of workspace `wsId`'s bots that works on a site shows (lib/bot-groups.ts shownDomain), by bot id:
 * null for a site with none, or one Orgo couldn't say now. Read from Orgo once a computer however many sites are on it
 * (its deploy projects, for each site's port, and its custom domains, each on a port), kept KEPT_MS for the same links (a
 * read Orgo didn't answer, a short while).
 */
export function botSiteDomains(wsId: string): Promise<Record<string, string | null>> {
  const s = getState();
  const w = s.workspaces?.find((x) => x.id === wsId);
  const links = s.bots.flatMap((b) => {
    if (workspaceOf(b) !== wsId) return [];
    const link = siteOf(s, b);
    return link && siteExists(w, link) ? [{ botId: b.id, link }] : [];
  });
  const key = JSON.stringify(links);
  const was = kept.get(wsId);
  if (was && was.links === key && Date.now() - was.at < KEPT_MS) return was.value;
  const at = Date.now();
  const value = readDomains(w?.hostedApps ?? {}, links).then(({ out, whole }) => {
    // One Orgo didn't answer is asked again sooner.
    const now = kept.get(wsId);
    if (!whole && now?.at === at) now.at = at - KEPT_MS + MISSED_MS;
    return out;
  });
  kept.set(wsId, { at, links: key, value });
  return value;
}

type Hostings = NonNullable<NonNullable<AppState["workspaces"]>[number]["hostedApps"]>;

async function readDomains(apps: Hostings, links: { botId: string; link: BotSite }[]): Promise<{ out: Record<string, string | null>; whole: boolean }> {
  const out: Record<string, string | null> = {};
  const where = links.map(({ botId, link }) => {
    const h = apps[link.app];
    const projectId = link.site === link.app ? h.projectId : h.sites?.find((x) => x.name === link.site)?.projectId;
    out[botId] = null;
    return { botId, computerId: h.computerId, projectId };
  });
  const computers = [...new Set(where.filter((x) => x.projectId).map((x) => x.computerId))];
  const read = new Map(
    await Promise.all(
      computers.map(async (c) => {
        const [projects, list] = await Promise.all([
          within(deploys.projects(c).then((r) => (r.enabled ? (r.value.projects ?? []) : [])), WAIT_MS),
          within(domains.ofComputer(c).then((r) => r.domains ?? []), WAIT_MS),
        ]);
        return [c, { projects, list }] as const;
      }),
    ),
  );
  for (const x of where) {
    const got = read.get(x.computerId);
    const port = got?.projects?.find((p) => p.id === x.projectId)?.port;
    if (typeof port !== "number" || !got?.list) continue;
    out[x.botId] = shownDomain(got.list.filter((d) => d.target_port === port));
  }
  return { out, whole: [...read.values()].every((x) => x.projects && x.list) };
}
