import "server-only";
import { appsLevelOf, permits } from "@/lib/member-access";
import {
  MEMBER_ACTS_KEPT,
  MEMBER_APPS,
  MEMBER_COMMITS,
  MEMBER_DEPLOYS,
  type AppCommitsAnswer,
  type AppDomainOptions,
  type AppForMembers,
  type AppsForMembers,
  type AppSettingsAnswer,
  type HostedApp,
  type MemberAppAct,
  type PreviewPassword,
} from "@/lib/hosted-apps";
import { onRunner } from "./persist";
import { getState, stateReady, stateTooNew, update } from "./store";

/*
 * What the people a workspace is shared with see of its apps on the web (Workspace.appsForMembers), kept by the owner's
 * Mac as it reads them for its own Your Apps page: Bops Cloud can't read Ingot or Orgo for them, so it sends members
 * parts of this (cloud/ws-slice.ts appsFor). Only while someone has Your Apps at Read or more; never a variable's name
 * or value, an Ingot token, a key, a deploy's log or error text, who a domain is registered to, DNS records, or a
 * computer's or deploy project's id. A site's Preview password only while someone has Your Apps at Write (Bops Cloud
 * sends it to them alone), and never in a bot's chat or prompt. Written only when what's shown changed, or an hour
 * after the last write, so an idle workspace changes the synced state at most once an hour.
 */

/** How it reads what it shows: hosted-apps.ts's own (tests give their own). */
export type AppsReaders = {
  list: (wsId: string) => Promise<{ apps: HostedApp[] }>;
  commits: (wsId: string, name: string) => Promise<AppCommitsAnswer>;
  settings: (wsId: string, name: string, site?: string, env?: "preview") => Promise<AppSettingsAnswer>;
  owned: (wsId: string, name: string) => Promise<AppDomainOptions>;
  password: (wsId: string, name: string, site?: string) => Promise<PreviewPassword>;
};

const realReaders = async (): Promise<AppsReaders> => {
  const h = await import("./hosted-apps");
  return {
    list: h.listApps,
    commits: (ws, name) => h.appCommits(ws, name, null),
    settings: (ws, name, site, env) => h.appSettings(ws, name, site, env),
    owned: (ws, name) => h.domainOptions(ws, name),
    password: (ws, name, site) => h.previewPassword(ws, name, site),
  };
};

/** An hour: what's shown is written again at least this often while it's kept, so members see how fresh it is. */
export const FRESH_MS = 3_600_000;
/** While a site's newest deploy is queued or running, it's read again this often. */
export const DEPLOYING_MS = 30_000;

/** Whether anyone the workspace is shared with has Your Apps at Read or more (`level`: at that level or more). */
export const anyoneSeesApps = (wsId: string, level: "read" | "write" = "read") => Object.values(getState().workspaces?.find((w) => w.id === wsId)?.memberAccess ?? {}).some((a) => permits(appsLevelOf(a), level));

/** JSON with every object's keys in order (as cloud/ws-slice.ts canonical), to tell whether what's shown changed. */
const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Each site's Preview password as last read for members, by "<ws>\n<app>\n<site>", with the link and when Bops set it (PreviewSite.passwordAt) then. */
const passwordsRead = new Map<string, { url: string; at: number | undefined; password: string | null }>();

/**
 * A site's Preview password for members with Your Apps at Write (null: none to show: Orgo kept only its cookie's check,
 * or the user's key can't read it), read from Orgo again only once its link or when Bops set it is another.
 */
async function passwordFor(wsId: string, name: string, site: string | undefined, url: string, at: number | undefined, r: AppsReaders): Promise<string | null> {
  const key = `${wsId}\n${name}\n${site ?? name}`;
  const was = passwordsRead.get(key);
  if (was && was.url === url && was.at === at) return was.password;
  const got = await r.password(wsId, name, site).catch(() => null);
  // (Couldn't be read just now: the one read before for that link, and asked again next time.)
  if (!got) return was?.url === url ? was.password : null;
  const password = got.on && got.url === url && typeof got.password === "string" && got.password ? got.password : null;
  // None to show is asked for again next time, not kept until the next deploy.
  if (password) passwordsRead.set(key, { url, at, password });
  else passwordsRead.delete(key);
  return password;
}

/** One app as members see it, from what the page read: the allow list, field by field. */
async function appFor(wsId: string, a: HostedApp, r: AppsReaders, acts: MemberAppAct[] | undefined): Promise<AppForMembers> {
  // (Its address is Published's first active domain, never an orgo.dev name; its Preview's link beside it.)
  const sites = a.sites ?? [{ name: a.name, projectId: null, url: null, serving: a.serving, live: a.live, domain: a.domain ?? null, preview: a.preview, ...(a.domains ? { domains: a.domains } : {}) }];
  const log = await r.commits(wsId, a.name).catch(() => null);
  const commits = (log?.commits ?? []).slice(0, MEMBER_COMMITS).map((c) => ({ id: c.id, message: cut(c.message, 200), author: cut(c.author, 80), at: c.at, changes: c.changes }));
  const head = log?.commits[0] ? { id: log.commits[0].id, message: cut(log.commits[0].message, 200), at: log.commits[0].at } : a.head ? { id: a.head, message: "", at: a.updatedAt ?? 0 } : null;
  const deploys: AppForMembers["deploys"] = [];
  const settings: Record<string, NonNullable<AppSettingsAnswer["settings"]>> = {};
  const passwords: Record<string, string> = {};
  const writers = anyoneSeesApps(wsId, "write");
  for (const s of sites.slice(0, 5)) {
    const site = s.name === a.name ? undefined : s.name;
    // Published's deploys, and the Preview's (members deploy, roll back and change settings there only).
    const [got, pv] = await Promise.all([r.settings(wsId, a.name, site).catch(() => null), s.preview?.projectId ? r.settings(wsId, a.name, site, "preview").catch(() => null) : null]);
    for (const d of got?.deploys.slice(0, MEMBER_DEPLOYS) ?? []) deploys.push({ id: d.id, state: d.state, at: d.at, rollback: d.rollback, when: d.when, live: d.live, canRollback: d.canRollback, site: s.name, env: "prod" });
    for (const d of pv?.deploys.slice(0, MEMBER_DEPLOYS) ?? []) if (!deploys.some((x) => x.id === d.id)) deploys.push({ id: d.id, state: d.state, at: d.at, rollback: d.rollback, when: d.when, live: d.live, canRollback: d.canRollback, site: s.name, env: "preview" });
    const shown = pv?.settings ?? got?.settings;
    if (shown) settings[s.name] = { port: shown.port, install: shown.install, build: shown.build, start: shown.start, ...(shown.health ? { health: shown.health } : {}) };
    // Its Preview's password, while it asks for one and someone has Your Apps at Write.
    const pass = writers && s.preview?.url && s.preview.protected === true ? await passwordFor(wsId, a.name, site, s.preview.url, s.preview.passwordAt, r) : null;
    if (pass) passwords[s.name] = pass;
  }
  return {
    head,
    sites: sites.slice(0, 5).map((s) => ({
      name: s.name,
      url: s.domain ?? null,
      preview: s.preview?.url ?? null,
      ...(s.preview ? { previewLive: s.preview.live ? { id: s.preview.live.id, state: s.preview.live.state, when: s.preview.live.when } : null, previewServing: s.preview.serving } : {}),
      ...(s.preview?.protected === true ? { previewProtected: true as const } : {}),
      ...(passwords[s.name] ? { previewPassword: passwords[s.name] } : {}),
      serving: s.serving,
      live: s.live ? { id: s.live.id, state: s.live.state, when: s.live.when } : null,
      ...(s.domains ? { domains: s.domains.map((d) => ({ domain: d.domain, status: d.status })) } : {}),
    })),
    commits,
    deploys,
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(acts?.length ? { acts: acts.slice(0, MEMBER_ACTS_KEPT) } : {}),
  };
}

const running = new Map<string, Promise<void>>();
const again = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The Your Apps page reads its apps every few seconds while a deploy runs (app/api/hosted-apps), and each read of what
 * members see reads every app's history, sites' settings and the workspace's domains again: from the page, at most once
 * in PAGE_GAP_MS per workspace. A member's act, the 10 minute look and a deploy on its way (DEPLOYING_MS) read as before.
 */
export const PAGE_GAP_MS = 30_000;
const fromPage = new Map<string, number>();
export function seeAppsFromPage(wsId: string, from: HostedApp[], readers?: AppsReaders, now = Date.now): Promise<void> {
  const t = now();
  const last = fromPage.get(wsId);
  if (last !== undefined && t - last < PAGE_GAP_MS) return Promise.resolve();
  fromPage.set(wsId, t);
  return seeApps(wsId, from, readers, now);
}

/**
 * Read the workspace's apps as its Your Apps page does and keep what members are shown (Workspace.appsForMembers): only
 * on the owner's Mac, only while someone has Read or more (else a kept copy goes). `from`: the apps the page just read
 * (no second read). One at a time per workspace. While a site deploys it's read again every DEPLOYING_MS.
 */
export function seeApps(wsId: string, from?: HostedApp[], readers?: AppsReaders, now = Date.now): Promise<void> {
  const was = running.get(wsId);
  if (was) return was;
  const p = see(wsId, from, readers, now).finally(() => running.delete(wsId));
  running.set(wsId, p);
  return p;
}

/** seeApps from a read that starts now: after one already going, which may have read before what changed. */
export function seeAppsAfresh(wsId: string): Promise<void> {
  const was = running.get(wsId);
  return was ? was.catch(() => {}).then(() => seeApps(wsId)) : seeApps(wsId);
}

async function see(wsId: string, from: HostedApp[] | undefined, readers: AppsReaders | undefined, now: () => number) {
  if (onRunner() || !stateReady() || stateTooNew()) return;
  const ws = getState().workspaces?.find((w) => w.id === wsId);
  if (!ws) return;
  if (!anyoneSeesApps(wsId) || !Object.keys(ws.hostedApps ?? {}).length) {
    if (ws.appsForMembers) update((s) => void delete s.workspaces?.find((w) => w.id === wsId)?.appsForMembers);
    return;
  }
  const r = readers ?? (await realReaders());
  const list = from ?? (await r.list(wsId).catch(() => null))?.apps;
  if (!list) return;
  const kept = ws.appsForMembers;
  const apps: Record<string, AppForMembers> = {};
  for (const a of list.filter((x) => x.hosting).slice(0, MEMBER_APPS)) apps[a.name] = await appFor(wsId, a, r, kept?.apps[a.name]?.acts);
  const first = list.find((x) => x.hosting)?.name;
  const opts = first ? await r.owned(wsId, first).catch(() => null) : null;
  const owned = (opts?.owned ?? []).map((d) => ({ id: d.id, domain: d.domain }));
  const next: AppsForMembers = { at: now(), apps, ...(owned.length ? { owned } : {}) };
  const same = kept && canonical({ ...kept, at: 0 }) === canonical({ ...next, at: 0 });
  if (!same || now() - (kept?.at ?? 0) >= FRESH_MS)
    update((s) => {
      const w = s.workspaces?.find((x) => x.id === wsId);
      // Members' acts that landed while this read: kept.
      if (w) w.appsForMembers = { ...next, apps: Object.fromEntries(Object.entries(next.apps).map(([n, a]) => [n, { ...a, ...(w.appsForMembers?.apps[n]?.acts ? { acts: w.appsForMembers.apps[n].acts } : {}) }])) };
    });
  // A deploy on its way (Published's, or a Preview's: where members deploy): looked at again soon, so members see it land.
  clearTimeout(again.get(wsId));
  const going = (d: { state: string | null } | null | undefined) => d?.state === "queued" || d?.state === "running";
  if (Object.values(apps).some((a) => a.sites.some((s) => going(s.live) || going(s.previewLive)))) {
    const t = setTimeout(() => void seeApps(wsId, undefined, readers, now).catch(() => {}), DEPLOYING_MS);
    t.unref?.();
    again.set(wsId, t);
  }
}

/** A member's act on an app, kept on it (newest first, at most MEMBER_ACTS_KEPT), so their window sees how it went and the owner's who did it. */
export function noteMemberAct(wsId: string, app: string, act: MemberAppAct) {
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (!w) return;
    const all = w.appsForMembers ?? { at: 0, apps: {} };
    const a = all.apps[app] ?? { head: null, sites: [], commits: [], deploys: [] };
    w.appsForMembers = { ...all, apps: { ...all.apps, [app]: { ...a, acts: [act, ...(a.acts ?? []).filter((x) => x.key !== act.key)].slice(0, MEMBER_ACTS_KEPT) } } };
  });
}

/** Whether a member's act with this key is kept already (done or refused): the same act again is done once. */
export const actKept = (wsId: string, app: string, key: string) => !!getState().workspaces?.find((w) => w.id === wsId)?.appsForMembers?.apps[app]?.acts?.some((x) => x.key === key);
