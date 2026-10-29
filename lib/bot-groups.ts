import { sitesOfHosting } from "./hosted-apps";
import { MAIN_WORKSPACE, siteOf, workBot, workspaceOf, type AppState, type Bot, type BotSite, type Workspace } from "./types";

/*
 * Bots that work on one computer, together in the sidebar (components/app/bot-groups.tsx), and the site each bot works
 * on, said under its name. Pure: the sidebar, its rail, the bot's settings page and the tests read them alike.
 *
 * A group is a computer of the open workspace with two or more bots on it besides the main bot: in practice the main
 * bot's, as every bot works on its own computer or the main bot's (lib/types.ts workBot). The main bot keeps its own
 * row on top, never folded away (it runs the team), and its computer's group comes right under it, so it reads as that
 * bot's crew; a bot alone on its computer, or the only one sharing the main bot's, is a row as before. Its name is the
 * owner's (Workspace.computerNames, by computer id), else one from the apps on that computer, else its bot's.
 */

/** How long a computer's name may be. */
export const MAX_COMPUTER_NAME = 40;

/** Every word the groups and the Works on row say (the tests read them all for dashes and the old name). */
export const GROUP_WORDS = {
  computerOf: (name: string) => `${name}'s computer`,
  sharedComputer: "Shared computer",
  bots: (n: number) => `${n} ${n === 1 ? "bot" : "bots"}`,
  apps: (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more`),
  /** The header's own line, on hover: who's on it. */
  on: (name: string, host: string | undefined) => (host ? `${name}: these bots work on ${host}'s computer, with ${host}` : `${name}: these bots work on one computer`),
  rename: (name: string) => `Rename ${name}`,
  nameLabel: "Computer name",
  fold: (name: string) => `Hide ${name}`,
  unfold: (name: string) => `Show ${name}`,
  needsYou: "Something in here needs you",
  saveFailed: "That name didn't save. Try again.",
  // The Works on row (its bot's settings page, Computer)
  worksOn: "Works on",
  none: "None",
  worksOnHint: "The sidebar shows this site under its name.",
  siteGone: "That site is gone. Pick another.",
};

/** One computer's bots, as the sidebar groups them. */
export type BotGroup = {
  /** Its own key (the computer's id; in a shared workspace the one Bops Cloud gave it): what's folded is kept by it. */
  key: string;
  /** The computer's id, the owner's own only: what renaming it keeps the name by. */
  computerId?: string;
  name: string;
  /** The owner named it (Workspace.computerNames). */
  named: boolean;
  /** Its bots shown as its rows: every one on it but the main bot, in the workspace's order. */
  bots: string[];
  /** The bot whose computer it is, when it's one of the workspace's (shown). */
  host?: Pick<Bot, "id" | "name" | "isMain">;
};

type GroupState = Pick<AppState, "bots" | "workspace" | "workspaces" | "host" | "shared">;

const wsOf = (state: Pick<AppState, "workspace" | "workspaces">) => state.workspace ?? state.workspaces?.[0]?.id ?? MAIN_WORKSPACE;
const workspaceIn = (state: Pick<AppState, "workspace" | "workspaces">, id = wsOf(state)) => state.workspaces?.find((w) => w.id === id);

/** A name as it's kept: on one line, its spaces single, at most MAX_COMPUTER_NAME long. Empty: none. */
export const cleanComputerName = (s: unknown): string =>
  typeof s === "string"
    ? [...s]
        .map((ch) => (ch < " " || ch === "\u007f" ? " " : ch))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_COMPUTER_NAME)
        .trim()
    : "";

/** The apps of workspace `ws` on computer `computerId` (Workspace.hostedApps), in the order they were added. */
export const appsOn = (ws: Pick<Workspace, "hostedApps"> | undefined, computerId: string): string[] =>
  Object.entries(ws?.hostedApps ?? {}).flatMap(([name, h]) => (h && h.computerId === computerId && !h.lost ? [name] : []));

/** A computer's name until the owner gives it one: its apps' ("shop", "shop and blog"), else its bot's ("Sam's computer"). */
export function defaultComputerName(ws: Pick<Workspace, "hostedApps"> | undefined, computerId: string | undefined, host: string | undefined): string {
  const apps = computerId ? appsOn(ws, computerId) : [];
  if (apps.length) return GROUP_WORDS.apps(apps);
  return host ? GROUP_WORDS.computerOf(host) : GROUP_WORDS.sharedComputer;
}

/**
 * The open workspace's groups (BotGroup): each computer with two or more bots on it besides the main bot, in the order
 * its first bot comes in `state.bots`. None on a Mac that runs the bots itself (every bot has its own browsers there:
 * lib/screens.ts computerOf), nor for a computer not made yet (nothing to name). In a workspace shared with the user,
 * the groups Bops Cloud said (SharedOpen.groups), as far as the bots shown go.
 */
export function botGroups(state: GroupState): BotGroup[] {
  if (state.shared) return sharedGroups(state);
  if (state.host === "mac") return [];
  const id = wsOf(state);
  const ws = workspaceIn(state, id);
  const team = state.bots.filter((b) => workspaceOf(b) === id);
  const on = new Map<string, Bot[]>();
  for (const b of team) {
    const c = workBot(b, state.bots).computerId;
    if (!c) continue;
    const list = on.get(c);
    if (list) list.push(b);
    else on.set(c, [b]);
  }
  const out: BotGroup[] = [];
  for (const [computerId, bots] of on) {
    const rows = bots.filter((b) => !b.isMain);
    if (rows.length < 2) continue;
    const h = workBot(bots[0], state.bots);
    const host = workspaceOf(h) === id ? h : undefined;
    const own = ws?.computerNames && Object.hasOwn(ws.computerNames, computerId) ? cleanComputerName(ws.computerNames[computerId]) : "";
    out.push({
      key: computerId,
      computerId,
      name: own || defaultComputerName(ws, computerId, h.name),
      named: !!own,
      bots: rows.map((b) => b.id),
      ...(host ? { host: { id: host.id, name: host.name, isMain: host.isMain } } : {}),
    });
  }
  return out;
}

function sharedGroups(state: GroupState): BotGroup[] {
  const shown = new Map(state.bots.map((b) => [b.id, b]));
  return (state.shared?.groups ?? []).flatMap((g) => {
    if (!g || typeof g.key !== "string" || !Array.isArray(g.bots)) return [];
    const rows = g.bots.filter((id) => shown.has(id) && !shown.get(id)!.isMain);
    if (rows.length < 2) return [];
    const host = typeof g.host === "string" ? shown.get(g.host) : undefined;
    const own = cleanComputerName(g.name);
    return [
      {
        key: g.key,
        name: own || (host ? GROUP_WORDS.computerOf(host.name) : GROUP_WORDS.sharedComputer),
        named: !!own,
        bots: rows,
        ...(host ? { host: { id: host.id, name: host.name, isMain: host.isMain } } : {}),
      },
    ];
  });
}

/** Which of `groups` a bot's row is in, by bot id. */
export const groupOfBot = (groups: BotGroup[]): Map<string, BotGroup> => new Map(groups.flatMap((g) => g.bots.map((id) => [id, g] as const)));

/**
 * The rows of the sidebar's list in their order, groups in place: `ids` (its chats in the sidebar's order, the main
 * bot's first) and the bot each is the own chat of (none for a group chat). A group goes right after the main bot's row
 * when that bot is on its computer, else where its first row would be; its rows keep their order among themselves.
 */
export type ListItem<C> = { chat: C } | { group: BotGroup; chats: C[] };
export function groupedList<C>(chats: C[], botOf: (c: C) => string | undefined, groups: BotGroup[], mainId: string | undefined): ListItem<C>[] {
  const of = groupOfBot(groups);
  const inGroup = new Map<BotGroup, C[]>();
  for (const c of chats) {
    const g = of.get(botOf(c) ?? "");
    if (g) inGroup.set(g, [...(inGroup.get(g) ?? []), c]);
  }
  const out: ListItem<C>[] = [];
  const placed = new Set<BotGroup>();
  const place = (g: BotGroup) => {
    if (placed.has(g) || !inGroup.has(g)) return;
    placed.add(g);
    out.push({ group: g, chats: inGroup.get(g)! });
  };
  for (const c of chats) {
    const id = botOf(c);
    const g = of.get(id ?? "");
    if (g) {
      place(g);
      continue;
    }
    out.push({ chat: c });
    // The main bot's own row: its computer's group right under it.
    if (id && id === mainId) for (const x of groups) if (x.host?.id === mainId) place(x);
  }
  return out;
}

/* ---------------- The site a bot works on ---------------- */

/** A site's domains as Orgo says them: the one to show, a live one first, else one waiting for its DNS. Never a failed or turned off one. */
export function shownDomain(list: readonly { domain: string; status: string }[] | undefined): string | null {
  const ok = (list ?? []).filter((d) => d && typeof d.domain === "string" && d.domain);
  return (ok.find((d) => d.status === "active") ?? ok.find((d) => d.status === "pending" || d.status === "verifying"))?.domain ?? null;
}

/** Whether `link` names a site of an app of workspace `ws` (Workspace.hostedApps). */
export function siteExists(ws: Pick<Workspace, "hostedApps"> | undefined, link: BotSite | undefined): boolean {
  const h = link && ws?.hostedApps && Object.hasOwn(ws.hostedApps, link.app) ? ws.hostedApps[link.app] : undefined;
  return !!h && sitesOfHosting(h, link!.app).includes(link!.site);
}

/** Every site of the apps of workspace `ws`, app by app, each app's own site first: what the Works on row lists. */
export const siteChoices = (ws: Pick<Workspace, "hostedApps"> | undefined): BotSite[] =>
  Object.entries(ws?.hostedApps ?? {}).flatMap(([app, h]) => (h ? sitesOfHosting(h, app).map((site) => ({ app, site })) : []));

/** A site as the Works on row lists it: the app, and the site after it when it's another of the app's. */
export const siteName = (link: BotSite) => (link.site === link.app ? link.app : `${link.app} · ${link.site}`);

/**
 * What the sidebar says under a bot's name in place of its role, when it works on a site (siteOf): the site's domain
 * (`domains`, by bot id, as the owner's Mac last read them: components/app/bot-groups.tsx useSiteDomains), else the
 * site's name. In a workspace shared with the user, its domains as Bops Cloud sent its apps (SharedOpen.apps), when
 * the owner gave them Your Apps; the link itself comes only with that. Undefined: none, or its app or site is gone.
 */
export function siteLabel(state: Pick<AppState, "workspace" | "workspaces" | "shared">, b: Pick<Bot, "id" | "workspaceId">, domains?: Record<string, string | null>): string | undefined {
  const link = siteOf(state, b);
  if (!link) return undefined;
  if (state.shared) {
    const app = state.shared.apps?.list.find((a) => a.name === link.app);
    if (!app) return undefined;
    const named = link.site === link.app || (app.siteNames ?? []).includes(link.site) || !!app.sites?.some((s) => s.name === link.site);
    if (!named) return undefined;
    return shownDomain(app.sites?.find((s) => s.name === link.site)?.domains) ?? link.site;
  }
  if (!siteExists(workspaceIn(state, workspaceOf(b)), link)) return undefined;
  return domains?.[b.id] || link.site;
}

/** The open workspace's bots that work on a site, each with it: what useSiteDomains reads the domains of. */
export function linkedBots(state: Pick<AppState, "bots" | "workspace" | "workspaces">): { botId: string; link: BotSite }[] {
  const id = wsOf(state);
  const ws = workspaceIn(state, id);
  return state.bots.flatMap((b) => {
    if (workspaceOf(b) !== id) return [];
    const link = siteOf(state, b);
    return link && siteExists(ws, link) ? [{ botId: b.id, link }] : [];
  });
}
