"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { DNS_TYPES, dnsNeeds } from "@/lib/hosted-apps";
import type {
  AddAppAnswer,
  AppCommit,
  AppCommitsAnswer,
  AppDnsInput,
  AppDnsRecord,
  AppDnsWritten,
  AppDnsZone,
  AppDomain,
  AppDomainsAnswer,
  AppDomainStatus,
  AppHosting,
  AppRenewal,
  AppSettingsAnswer,
  DeployState,
  HostedApp,
  HostedAppAction,
  HostedAppsAnswer,
  HostedSite,
  RemoveAppAnswer,
  SiteDomain,
} from "@/lib/hosted-apps";
import { botChatId, workspaceOf, type AppState } from "@/lib/types";
import { AddAppForm, AddDomain, AppAddress, AppDeploys, AppEnd, AppSettingsSection, checkDomain, readSettings, removeDomain, RenewalLine } from "./app-settings";
import { PencilIcon, rowIconBtn, rowTrashBtn, TrashIcon } from "./apps";
import { InlineConfirm, undash } from "./side-group";
import { ago, post } from "./ui";

/*
 * Apps the workspace runs on the web (lib/hosted-apps.ts), in Bops' right panel. Each one is an Ingot repo,
 * worked on on a bot's Bops computer. The Apps page's "On the web" list has one line per app: its state, its public
 * address, the short id of the changeset its site serves, and Deploy; and Add app, which has the workspace's
 * main bot build one (app-settings.tsx). An app's tab is one page: its title line (name, address, "Work on
 * it": its bot's chat with words typed in, Deploy); its Address on orgo.dev; its Domains (each with how it's
 * doing, Check again and Remove; Add a domain: bought now, the user's own, or one the workspace bought; the
 * DNS records of the ones bought through Orgo, to add to, change and remove, Orgo's own locked, and their
 * renewal; the DNS of one bought elsewhere greyed out, as Orgo can't change it: the records to set where
 * it's kept, and Verify); its Settings (port, commands, variables by name); its Deploys (Roll back to an earlier one, and
 * the newest one's log, folded); and its History from Ingot, newest first, where any changeset can be
 * deployed. The list is read again every few seconds while a deploy waits or runs, whenever this Mac queues
 * a deploy (appsStamp), and otherwise when the window comes back into focus. The history is read again when
 * the app's newest changeset or deploy changes, its domains when its project or address does, and its
 * settings when its project or newest deploy does; all when the window comes back into focus, never on a
 * timer (but a domain just pointed here that Orgo writes the records of, checked every few seconds until it's live).
 *
 * An app with more than one site (one repo holding a few apps, lib/hosted-apps.ts AppHosting.sites) has
 * them in a list under its title, one line each: its state, its name, its domains (each with how it's doing),
 * or its address on orgo.dev while it has none, and Deploy this site; a line pressed picks that site. Every
 * site's domains come with the list (its computer's read once for all of them; a read that couldn't get them
 * leaves the lines as they were), the list read again when another site is picked, and the picked one's
 * line says them as its Domains section has them. The title's Deploy deploys them all. Its Address, Domains, Settings and Deploys are the picked site's (AppSite says
 * which to every call they make); its History is the app's, each changeset marked Live on the sites that
 * serve it. At its end (AppEnd): Add a site, Remove the picked one, and Remove app. One whose computer is
 * gone says it needs a new home.
 */

/**
 * The site of an app that what's under it is about (its name), for every call they make (`site` in its
 * query or body); undefined: the app's own, as for an app with one site, when nothing more is sent.
 */
export const AppSite = createContext<string | undefined>(undefined);

/** `site` as a query part, or nothing for the app's own. */
export const siteQuery = (site?: string) => (site ? `&site=${encodeURIComponent(site)}` : "");

/** Open an app on the web in its tab (bops-app.tsx), by its Ingot repo's name; null where there's no panel. */
export const OpenHostedApp = createContext<((ws: string, name: string) => void) | null>(null);

/** Open the task Add app started (bops-app.tsx: its thread, else its bot's chat); null where there's no window. */
export const OpenAppTask = createContext<((a: AddAppAnswer) => void) | null>(null);

/** How often the list (and a running deploy's log) is read again while a deploy waits or runs. */
const POLL_MS = 3000;

/** The newest deploy's log as GET /api/hosted-apps/[name]/logs answers it: what came after `after`, and where to read on from. */
export type DeployLogAnswer = { state: DeployState | null; log: string; next: string | number | null; more: boolean };

export const deploying = (a: Pick<HostedApp, "live">) => a.live?.state === "queued" || a.live?.state === "running";

/** Any site of it deploying (the app's own, for one with one site). */
export const anyDeploying = (a: Pick<HostedApp, "live" | "sites">) => deploying(a) || !!a.sites?.some(deploying);

/**
 * The app as one of its sites has it (`site`: its name), for what's shown of that site: its newest deploy,
 * what it serves, and its deploy project and address in its hosting. The app itself for its own site.
 */
export function siteView(a: HostedApp, site: HostedSite | undefined): HostedApp {
  if (!site || site.name === a.name) return a;
  const { projectId: _project, url: _url, ...rest } = a.hosting ?? { botId: "", computerId: "" };
  void _project;
  void _url;
  return { ...a, live: site.live, serving: site.serving, hosting: a.hosting && { ...rest, ...(site.projectId ? { projectId: site.projectId } : {}), ...(site.url ? { url: site.url } : {}) } };
}

/** Its public address: the newest deploy's, else the one kept from the first. */
export const urlOf = (a: HostedApp) => a.live?.url ?? a.hosting?.url ?? null;

/** What it says where its address would be, when it has none: live with no address yet, or not on the web yet. */
export const noAddress = (a: Pick<HostedApp, "serving" | "live">, never = "Not on the web yet") => (a.serving || a.live?.state === "succeeded" ? "No address yet" : never);

/** A changeset's short id, as its line shows it (all of it in the tooltip). */
export const short = (id: string) => id.slice(0, 7);

/** Where a workspace's apps are worked on and run, by repo name, as the app's state has it (Workspace.hostedApps). */
const hostingIn = (state: Pick<AppState, "workspaces"> | null | undefined, ws: string): Record<string, AppHosting> =>
  state?.workspaces?.find((w) => w.id === ws)?.hostedApps ?? {};

/**
 * What of a workspace's apps changes in the app's state when this Mac deploys one (where it runs, its
 * site, a deploy queued): the list is read again whenever it does, so the page follows a bot's deploy
 * while the window keeps its focus.
 */
export const appsStamp = (state: Pick<AppState, "workspaces"> | null | undefined, ws: string) =>
  Object.entries(hostingIn(state, ws))
    .map(
      ([name, h]) =>
        `${name}:${h.botId}:${h.computerId}:${h.projectId ?? ""}:${h.url ?? ""}:${h.queuedAt ?? ""}` +
        // Its other sites, and its computer gone, only when it has them (an app with one site's is as it was).
        (h.sites?.length ? `:${h.sites.map((x) => `${x.name}=${x.projectId ?? ""}=${x.url ?? ""}`).join("|")}` : "") +
        (h.lost ? `:lost${h.lost}` : ""),
    )
    .sort()
    .join(",");

/**
 * "Work on it": the bot to ask (the one whose computer holds its working folder, else the workspace's main
 * bot, the first of them in this workspace with a chat to put the words in) and the words, to finish and
 * send. Null when none has a chat.
 */
export function workOn(state: Pick<AppState, "workspaces" | "bots" | "chats"> | null | undefined, ws: string, app: Pick<HostedApp, "name" | "hosting">) {
  if (!state) return null;
  const main = state.bots.find((b) => b.isMain && workspaceOf(b) === ws)?.id;
  for (const id of [app.hosting?.botId, hostingIn(state, ws)[app.name]?.botId, main]) {
    const bot = id ? state.bots.find((b) => b.id === id && workspaceOf(b) === ws) : undefined;
    if (bot && state.chats.some((c) => c.id === botChatId(bot.id))) return { botId: bot.id, name: bot.name, text: `Change the app “${app.name}”: ` };
  }
  return null;
}

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export const PULSE = "animate-pulse bg-highlighter shadow-[0_0_0_1.5px_var(--c-0a0a0a)]";
export const STATES: Record<DeployState, { word: string; dot: string }> = {
  queued: { word: "Waiting to deploy", dot: PULSE },
  running: { word: "Deploying", dot: PULSE },
  succeeded: { word: "Live", dot: "bg-[#2BB673]" },
  failed: { word: "Failed", dot: "bg-[#B42318]" },
  cancelled: { word: "Deploy stopped", dot: "bg-[color:var(--c-9a9a98)]" },
  superseded: { word: "Deploy replaced", dot: "bg-[color:var(--c-9a9a98)]" },
};

const NEVER = { word: "Not on the web yet", dot: "shadow-[inset_0_0_0_1.5px_var(--c-c9c9c6)]" };

/** What its newest deploy says, in a word and a dot, and in full for the tooltip (the changeset it built, when, and why it failed). */
export function stateOf(a: Pick<HostedApp, "live">) {
  // (A state this build doesn't know reads as none.)
  const s = (a.live?.state && STATES[a.live.state]) || NEVER;
  const facts = [s.word, a.live?.at ? short(a.live.at) : null, a.live?.when ? ago(a.live.when) : null].filter(Boolean).join(" · ");
  return { ...s, tip: a.live?.error ? `${facts}: ${a.live.error}` : facts };
}

/**
 * Apps a deploy is being sent for, from any list or tab in this window: none of their Deploy buttons can be
 * pressed again until it's answered (a second press would queue two deploys).
 */
const sending = new Set<string>();
const sendingHeard = new Set<() => void>();
let sendingAt = 0;
function setSending(name: string, on: boolean) {
  if (on) sending.add(name);
  else sending.delete(name);
  sendingAt++;
  for (const f of sendingHeard) f();
}
/** Whether a deploy of the app is being sent from this window now (read with useSending, to hear it change). */
export const isSending = (name: string) => sending.has(name);
/** Read again whenever a deploy starts or stops being sent anywhere in the window. */
export const useSending = () =>
  useSyncExternalStore(
    (f) => (sendingHeard.add(f), () => void sendingHeard.delete(f)),
    () => sendingAt,
    () => 0,
  );

/**
 * Why Deploy can't be pressed for it now (undefined: it can). `at`: a changeset picked from its history, not
 * the newest. `site`: Deploy for that site alone (else every site of it).
 */
export function whyNot(answer: Pick<HostedAppsAnswer, "enabled" | "why">, a: HostedApp, at?: string, site?: HostedSite) {
  if (!answer.enabled) return answer.why || "Deploying isn't open here.";
  if (!at && !a.head) return "Nothing is committed yet.";
  if (site ? deploying(site) : anyDeploying(a)) return "A deploy is running. Wait for it to finish.";
  if (sending.has(a.name)) return "A deploy is being sent. Wait for it.";
  return undefined;
}

const json = async <T,>(url: string): Promise<T | null> => {
  const r = await fetch(url, { cache: "no-store" }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as T | null) : null;
};

const at = (name: string) => `/api/hosted-apps/${encodeURIComponent(name)}`;

/** The workspace's apps (null: they couldn't be read). */
export async function readApps(ws: string): Promise<HostedAppsAnswer | null> {
  const a = await json<HostedAppsAnswer>(`/api/hosted-apps?ws=${encodeURIComponent(ws)}`);
  return a && Array.isArray(a.apps) ? a : null;
}

/**
 * An app's changesets, newest first, from Ingot: the newest page, or the one older than `before` (null:
 * they couldn't be read; `offline`: Ingot can't be reached now).
 */
export async function readCommits(ws: string, name: string, before?: string | null): Promise<AppCommitsAnswer | null> {
  const a = await json<AppCommitsAnswer>(`${at(name)}/commits?ws=${encodeURIComponent(ws)}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
  return a && Array.isArray(a.commits) ? a : null;
}

/** The newest deploy's log after `after` (null: from the start), of `site` (none: the app's own). */
export const readLog = (ws: string, name: string, after: string | number | null, site?: string) =>
  json<DeployLogAnswer>(`${at(name)}/logs?ws=${encodeURIComponent(ws)}${after === null ? "" : `&after=${encodeURIComponent(String(after))}`}${siteQuery(site)}`);

/**
 * Deploy (the newest changeset, or `at`), roll back, add or remove a site: the app as it is now, or why not
 * (`said`: what a removal couldn't do).
 */
export async function act(name: string, body: HostedAppAction): Promise<{ app?: HostedApp; error?: string; field?: string; said?: string }> {
  const r = await post(at(name), body).catch(() => null);
  const answer = ((await r?.json().catch(() => null)) ?? {}) as { app?: HostedApp; error?: string; field?: unknown; said?: string };
  if (!r?.ok) {
    const error = answer.error || (body.action === "deploy" ? "Couldn't deploy it. Try again." : "Couldn't do that. Try again.");
    return typeof answer.field === "string" ? { error, field: answer.field } : { error };
  }
  return typeof answer.said === "string" ? { app: answer.app, said: answer.said } : { app: answer.app };
}

/** The app removed from the workspace (its Ingot repo too when `repo`), or why not. */
export async function removeApp(ws: string, name: string, repo: boolean): Promise<{ ok?: RemoveAppAnswer; error?: string }> {
  const r = await post(at(name), { ws, repo }, "DELETE").catch(() => null);
  const answer = ((await r?.json().catch(() => null)) ?? {}) as RemoveAppAnswer & { error?: string };
  return r?.ok ? { ok: answer } : { error: undash(answer.error || "Couldn't remove it. Try again.") };
}

/** Its domains and their DNS (of `site`: none, the app's own), or why they couldn't be read (null: the server didn't say). */
export async function readDomains(ws: string, name: string, site?: string): Promise<{ answer?: AppDomainsAnswer; error?: string | null }> {
  const r = await fetch(`${at(name)}/dns?ws=${encodeURIComponent(ws)}${siteQuery(site)}`, { cache: "no-store" }).catch(() => null);
  const j = (await r?.json().catch(() => null)) as (Partial<AppDomainsAnswer> & { error?: unknown }) | null;
  if (r?.ok && j && Array.isArray(j.domains) && Array.isArray(j.zones)) return { answer: { url: j.url ?? null, domains: j.domains, zones: j.zones } };
  return { error: typeof j?.error === "string" ? j.error : null };
}

/** A change to one of its zones (`zone`: its id): a record added, one changed (all of it, as it becomes), or one removed. `site`: of that site. */
export type DnsChange = { ws: string; zone: string; site?: string } & ({ action: "add"; record: AppDnsInput } | { action: "change"; id: string; record: AppDnsInput } | { action: "remove"; id: string });

/**
 * What a change answered: the zone's records as written, or why not (`field`: the one to fix), with the
 * records as they are now (`now`) when they changed since they were read.
 */
export type DnsChanged = { written?: AppDnsWritten; error?: string; field?: string; now?: AppDnsWritten };

export async function changeDns(name: string, c: DnsChange): Promise<DnsChanged> {
  const url = `${at(name)}/dns/records${c.action === "add" ? "" : `/${encodeURIComponent(c.id)}`}`;
  const r = await post(url, { ...(c.action === "remove" ? {} : c.record), ws: c.ws, zone: c.zone, ...(c.site ? { site: c.site } : {}) }, c.action === "add" ? "POST" : c.action === "change" ? "PATCH" : "DELETE").catch(() => null);
  const j = ((await r?.json().catch(() => null)) ?? {}) as Partial<AppDnsWritten> & { error?: unknown; field?: unknown; stale?: unknown };
  const records = typeof j.zone === "string" && Array.isArray(j.records) ? { zone: j.zone, records: j.records } : null;
  if (r?.ok && records) return { written: records };
  return {
    error: undash(typeof j.error === "string" && j.error ? j.error : "Couldn't change the DNS. Try again."),
    ...(typeof j.field === "string" ? { field: j.field } : {}),
    ...(j.stale && records ? { now: records } : {}),
  };
}

/** Calls `f` whenever the window comes back into focus, until what it answers is called. */
const whenFocused = (f: () => void) => {
  window.addEventListener("focus", f);
  return () => window.removeEventListener("focus", f);
};

/** The last list read for each workspace, so the page or a tab opened again shows it at once (and reads it again). */
const lastRead = new Map<string, HostedAppsAnswer>();

/**
 * The workspace's apps, read again every few seconds while one deploys, whenever `stamp` (appsStamp)
 * changes, else when the window is focused again.
 */
function useHostedApps(ws: string, stamp = "") {
  const [got, setGot] = useState<{ ws: string; answer: HostedAppsAnswer | null; failed: boolean } | null>(null);
  const answer = (got?.ws === ws ? got.answer : null) ?? lastRead.get(ws) ?? null;
  const failed = got?.ws === ws && got.failed && !answer;
  const busy = !!answer?.apps.some(anyDeploying);
  useEffect(() => {
    let stop = false;
    const read = async () => {
      const r = await readApps(ws);
      if (stop) return;
      // (Its sites' domains a read didn't get, Orgo's list of them not read this time, are what was there.)
      const now = r && withKeptDomains(r, lastRead.get(ws));
      if (now) lastRead.set(ws, now);
      // One that couldn't be read keeps what was there.
      setGot((g) => ({ ws, answer: now ?? (g?.ws === ws ? g.answer : null), failed: !r }));
    };
    void read();
    if (busy) {
      const t = setInterval(read, POLL_MS);
      return () => {
        stop = true;
        clearInterval(t);
      };
    }
    const off = whenFocused(() => void read());
    return () => {
      stop = true;
      off();
    };
  }, [ws, busy, stamp]);
  /**
   * The list as `f` changes it, from the one read or changed last (lastRead, here or in another view of the
   * workspace: never the one this rendered with, so a read that landed since is kept). Nothing when `f`
   * leaves it as it was.
   */
  const change = (f: (base: HostedAppsAnswer) => HostedAppsAnswer) => {
    const base = lastRead.get(ws) ?? answer ?? { enabled: true, apps: [] };
    const next = f(base);
    if (next === base) return;
    lastRead.set(ws, next);
    setGot({ ws, answer: next, failed: false });
  };
  /**
   * An app as a deploy answered it: shown at once, and read again from then on while its deploy runs. What
   * it serves meanwhile, and its sites' domains, if that answer doesn't say, is what was read last.
   */
  const put = (app: HostedApp) =>
    change((base) => {
      const was = base.apps.find((a) => a.name === app.name);
      const now = keptDomains(
        {
          ...app,
          serving: app.serving ?? was?.serving ?? null,
          ...(app.sites ? { sites: app.sites.map((x) => ({ ...x, serving: x.serving ?? was?.sites?.find((y) => y.name === x.name)?.serving ?? null })) } : {}),
        },
        was,
      );
      return { ...base, apps: was ? base.apps.map((a) => (a.name === app.name ? now : a)) : [...base.apps, now] };
    });
  /**
   * One site's domains as its tab has them (its Domains section's, of the site picked): its line in the
   * Sites list says them at once (a domain added, removed or gone live).
   */
  const putDomains = (name: string, site: string, domains: SiteDomain[]) => change((base) => withSiteDomains(base, name, site, domains));
  /** An app removed: gone from the list at once (the server's next read agrees). */
  const drop = (name: string) => change((base) => ({ ...base, apps: base.apps.filter((a) => a.name !== name) }));
  return { answer, failed, put, drop, putDomains };
}

/**
 * An app as read again, or as a deploy answered it, with each site's domains it doesn't say (Orgo's list of
 * them not read this time) kept from what was there (`was`) while it's the same deploy project: a read that
 * couldn't get them leaves each line as it was, never its orgo.dev address in their place. The app itself
 * when there's nothing to keep.
 */
export function keptDomains(app: HostedApp, was: HostedApp | undefined): HostedApp {
  if (!app.sites || !was?.sites) return app;
  let kept = false;
  const sites = app.sites.map((x) => {
    const y = x.domains || !x.projectId ? undefined : was.sites?.find((s) => s.name === x.name && s.projectId === x.projectId);
    if (!y?.domains) return x;
    kept = true;
    return { ...x, domains: y.domains };
  });
  return kept ? { ...app, sites } : app;
}

/** The list as read again (`next`), with what each app's read didn't say of its sites' domains kept from the one before (keptDomains). */
export function withKeptDomains(next: HostedAppsAnswer, was: HostedAppsAnswer | undefined): HostedAppsAnswer {
  if (!was) return next;
  const apps = next.apps.map((a) => keptDomains(a, was.apps.find((x) => x.name === a.name)));
  return apps.some((a, i) => a !== next.apps[i]) ? { ...next, apps } : next;
}

/**
 * The list with one site's domains as they were read (`site`: its name, the app's own too), or the list as
 * it was when they're what it says already, or the app has no such site (one with one site has no Sites list).
 */
export function withSiteDomains(answer: HostedAppsAnswer, name: string, site: string, domains: SiteDomain[]): HostedAppsAnswer {
  const a = answer.apps.find((x) => x.name === name);
  const was = a?.sites?.find((x) => x.name === site);
  if (!a || !was || (was.domains && JSON.stringify(was.domains) === JSON.stringify(domains))) return answer;
  const now = { ...a, sites: a.sites?.map((x) => (x === was ? { ...x, domains } : x)) };
  return { ...answer, apps: answer.apps.map((x) => (x === a ? now : x)) };
}

/** An app's domains as its Sites list says them: each one's name and how it's doing. */
export const siteDomainsOf = (a: AppDomainsAnswer): SiteDomain[] => a.domains.map((d) => ({ domain: d.domain, status: d.status }));

/**
 * A deploy being sent: `busy(key, name)` for the button that sent it (it says Deploying…), while the app's
 * other buttons, here and in any other view, wait (sending). Why the last one couldn't be sent.
 */
function useDeploy(onChanged: (app: HostedApp) => void) {
  useSending();
  const [pressed, setPressed] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ name: string; text: string } | null>(null);
  const run = async (key: string, name: string, body: HostedAppAction) => {
    if (sending.has(name)) return;
    setSending(name, true);
    setPressed((p) => ({ ...p, [name]: key }));
    setError(null);
    const r = await act(name, body);
    setSending(name, false);
    setPressed(({ [name]: _done, ...rest }) => (void _done, rest));
    if (r.app) onChanged(r.app);
    else if (r.error) setError({ name, text: r.error });
  };
  const busy = (key: string, name: string) => pressed[name] === key && sending.has(name);
  return { busy, error, run };
}

function StateDot({ app }: { app: Pick<HostedApp, "live"> }) {
  const s = stateOf(app);
  return <span data-tip={s.tip} className={`size-2 shrink-0 rounded-full ${s.dot}`} />;
}

/**
 * Deploy, or "Deploy this one": pressed only when `why` is empty, else greyed with why in its tooltip
 * (on what holds it: a disabled button gets no pointer events in some browsers). A press never reaches
 * the row it's on.
 */
function DeployButton({ why, busy, onClick, label = "Deploy", primary }: { why?: string; busy: boolean; onClick: () => void; label?: string; primary?: boolean }) {
  const look = primary
    ? "rounded-full bg-ink px-3 py-1 font-semibold text-white disabled:bg-[color:var(--c-e6e6e3)] disabled:text-[color:var(--c-9a9a98)]"
    : "rounded-full px-2.5 py-1 font-medium text-ink shadow-[0_0_0_1px_var(--c-e2e2df)] hover:bg-white disabled:text-[color:var(--c-9a9a98)] disabled:shadow-[0_0_0_1px_var(--c-ececea)]";
  return (
    <span data-tip={why} onClick={(e) => e.stopPropagation()} className="flex shrink-0">
      <button disabled={!!why || busy} onClick={onClick} className={`whitespace-nowrap text-[12px] leading-4 ${look}`}>
        {busy ? "Deploying…" : label}
      </button>
    </span>
  );
}

export function UrlLink({ url }: { url: string }) {
  // It opens in the browser (the Mac app sends a new window's address there), never on the row under it.
  return (
    <a href={url} target="_blank" rel="noreferrer" title={url} onClick={(e) => e.stopPropagation()} className="min-w-0 shrink-[2] truncate font-mono text-[11.5px] leading-4 text-[color:var(--c-6b6b6b)] hover:text-ink hover:underline">
      {bare(url)}
    </a>
  );
}

/** Copies `url` (or any text: a DNS record's value), saying so for a moment. */
export function CopyLink({ url, label = "Copy link" }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        void navigator.clipboard
          ?.writeText(url)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {})
      }
      aria-label={copied ? "Copied" : label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-[color:var(--c-6b6b6b)] hover:bg-black/[0.05] hover:text-ink"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 14 14">
          <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M9.5 2.6A1.6 1.6 0 0 0 8 2H3.6A1.6 1.6 0 0 0 2 3.6V8a1.6 1.6 0 0 0 .6 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

export const QUIET = "text-[12.5px] leading-[18px] text-[color:var(--c-9a9a98)]";
/** What an app whose computer is gone says of it. */
const lostTip = (a: Pick<HostedApp, "sites">) =>
  `Its computer is gone, and ${a.sites && a.sites.length > 1 ? "its sites went" : "its site went"} with it. Deploy puts it on the web again, or ask a bot to work on it.`;
export const PROBLEM = "truncate text-[12px] leading-4 text-[#B42318]";

/**
 * The Apps page's "On the web" list (made-apps.tsx MadeAppsHome), read from the server (again when this
 * Mac queues a deploy: appsStamp).
 */
export function HostedApps({ state, ws }: { state?: Pick<AppState, "workspaces" | "bots"> | null; ws: string }) {
  const { answer, failed, put } = useHostedApps(ws, appsStamp(state, ws));
  const started = useContext(OpenAppTask);
  const builder = state?.bots?.find((b) => b.isMain && workspaceOf(b) === ws)?.name ?? null;
  return <HostedAppsList ws={ws} answer={answer} failed={failed} onChanged={put} builder={builder} onStarted={started ?? undefined} />;
}

/**
 * One line per app: its state, name, public address (opened in the browser), the short id of the changeset
 * its site serves, and Deploy (the newest changeset). The rest of the line opens its tab. Nothing until
 * it's read, one quiet line when there are none, and nothing at all when there are none and deploying
 * isn't open here (no invitation to make a site that can't go on the web). Add app, in its title (and
 * beside the line that says there are none): a form, and the workspace's main bot (`builder`) builds it;
 * `onStarted` opens that task.
 */
export function HostedAppsList({
  ws,
  answer,
  failed,
  onChanged,
  builder,
  onStarted,
}: {
  ws: string;
  answer: HostedAppsAnswer | null;
  failed?: boolean;
  onChanged: (app: HostedApp) => void;
  builder?: string | null;
  onStarted?: (a: AddAppAnswer) => void;
}) {
  const open = useContext(OpenHostedApp);
  const { busy, error, run } = useDeploy(onChanged);
  const [adding, setAdding] = useState(false);
  const wrong = error && answer?.apps.find((a) => a.name === error.name);
  if (answer && !answer.enabled && !answer.apps.length) return null;
  const why = answer && !answer.enabled ? answer.why || "Apps can't go on the web from here." : undefined;
  const addButton = answer && !adding && (
    <span data-tip={why} className="flex shrink-0">
      <button
        data-add-app
        disabled={!!why}
        onClick={() => setAdding(true)}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_var(--c-e2e2df)] hover:bg-[color:var(--c-f6f6f4)] disabled:text-[color:var(--c-9a9a98)] disabled:shadow-[0_0_0_1px_var(--c-ececea)]"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M5 1.5v7M1.5 5h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Add app
      </button>
    </span>
  );
  return (
    <div data-hosted-apps className="flex flex-col gap-1">
      <div className="flex min-h-7 items-center gap-2">
        <span className="text-[12px] font-semibold leading-4 text-[color:var(--c-6b6b6b)]">On the web</span>
        <span className="flex-1" />
        {!!answer?.apps.length && addButton}
      </div>
      {adding && (
        <AddAppForm
          ws={ws}
          builder={builder}
          onCancel={() => setAdding(false)}
          onStarted={(a) => {
            setAdding(false);
            onStarted?.(a);
          }}
        />
      )}
      {!answer ? (
        failed && <span className={QUIET}>Couldn&apos;t read them just now.</span>
      ) : !answer.apps.length ? (
        !adding && (
          <div data-no-apps className="flex flex-wrap items-center gap-2">
            <span className={QUIET}>Ask a bot to make a website, or add one here.</span>
            {addButton}
          </div>
        )
      ) : (
        <div className="-mx-2 flex flex-col">
          {answer.apps.map((a) => {
            const url = urlOf(a);
            return (
              <div
                key={a.name}
                data-hosted-app={a.name}
                data-state={a.live?.state ?? "none"}
                onClick={() => open?.(ws, a.name)}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-[color:var(--c-f6f6f4)]"
              >
                <StateDot app={a} />
                {/* The row's button for the keyboard: its press comes up to the row. */}
                <button title={a.name} className="min-w-0 shrink truncate text-left text-[13px] font-medium leading-4 text-ink">
                  {a.name}
                </button>
                {a.hosting?.lost ? (
                  <span data-lost data-tip={lostTip(a)} className="shrink-0 text-[12px] leading-4 text-[color:var(--c-9a9a98)]">
                    Needs a new home
                  </span>
                ) : url ? (
                  <UrlLink url={url} />
                ) : (
                  <span className="shrink-0 text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{noAddress(a, "Not deployed yet")}</span>
                )}
                {a.sites && (
                  <span data-site-count data-tip={a.sites.map((x) => x.name).join(", ")} className="shrink-0 text-[12px] leading-4 text-[color:var(--c-9a9a98)]">
                    {a.sites.length} sites
                  </span>
                )}
                <span className="flex-1" />
                {a.serving && (
                  <span data-serving title={`Its site serves ${a.serving}`} className="shrink-0 font-mono text-[11px] leading-[14px] text-[color:var(--c-6b6b6b)]">
                    {short(a.serving)}
                  </span>
                )}
                <DeployButton why={whyNot(answer, a)} busy={busy(a.name, a.name)} onClick={() => void run(a.name, a.name, { ws, action: "deploy" })} />
              </div>
            );
          })}
        </div>
      )}
      {wrong && (
        <span className={PROBLEM} title={error.text}>
          {wrong.name}: {error.text}
        </span>
      )}
    </div>
  );
}

/**
 * An app's tab: read with the list (so it shows at once from the Apps page, and again when this Mac queues
 * a deploy: appsStamp), and its history. `onAsk`: a bot's chat with words typed in (bops-app.tsx askBot),
 * for "Work on it".
 */
export function HostedAppTab({
  state,
  ws,
  name,
  onAsk,
}: {
  state?: (Pick<AppState, "workspaces" | "bots" | "chats"> & Partial<Pick<AppState, "account">>) | null;
  ws: string;
  name: string;
  onAsk?: (botId: string, text?: string) => void;
}) {
  // The site picked, of one with more than one (none: its own); one removed since is its own again.
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // (Read again when another site is picked too: the lines of the others then say what Orgo says now, a
  // domain the one left was checking gone live, say.)
  const { answer, failed, put, drop, putDomains } = useHostedApps(ws, `${appsStamp(state, ws)}\n${picked ?? ""}`);
  const app = answer?.apps.find((a) => a.name === name);
  // Removed here: what its removal said of the domains Orgo kept (null: nothing), shown where it was.
  const [removed, setRemoved] = useState<{ said: string | null } | null>(null);
  const site = picked && picked !== name && app?.sites?.some((x) => x.name === picked) ? picked : undefined;
  const shown = app && siteView(app, app.sites?.find((x) => x.name === site));
  // Read again when a commit or a deploy moves it on (any site's).
  const moves = [app, ...(app?.sites ?? [])].map((x) => `${x?.live?.id ?? ""}:${x?.live?.state ?? ""}:${x?.serving ?? ""}`).join(",");
  const { history, older } = useHistory(ws, name, `${app?.head ?? ""}:${moves}`);
  // Its domains, again when its first deploy makes its project or gives it its address (the picked site's).
  const dns = useDomains(ws, name, site, `${shown?.hosting?.projectId ?? ""}:${shown ? (urlOf(shown) ?? "") : ""}`);
  // Its settings and recent deploys, again when a deploy moves it on (the picked site's).
  const settings = useSettings(ws, name, site, `${shown?.hosting?.projectId ?? ""}:${shown?.live?.id ?? ""}:${shown?.live?.state ?? ""}`);
  // The picked site's domains as its Domains section has them (just read, or changed there), on its line in
  // the Sites list too: again after each read of the list, so one that began before a change and lands after
  // it never puts back what was there.
  const fresh = dns.fresh;
  useEffect(() => {
    if (fresh) putDomains(name, site ?? name, siteDomainsOf(fresh));
    // Its domains and the list decide it (one that says them already is left as it was, so this ends there).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, answer]);
  if (!answer || !app)
    return (
      <div data-app-gone className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center text-[13px] text-[color:var(--c-6b6b6b)]">
        {removed ? `Removed ${name}.` : answer ? "This app isn't here any more." : failed ? "Couldn't read this app. Try again in a moment." : ""}
        {removed?.said && <span className="max-w-[420px] text-[12.5px] leading-[18px] text-[#B42318]">{removed.said}</span>}
      </div>
    );
  const ask = onAsk && workOn(state, ws, app);
  return (
    <HostedAppView
      ws={ws}
      answer={answer}
      app={app}
      history={history}
      older={older}
      work={ask ? { name: ask.name, go: () => onAsk(ask.botId, ask.text) } : null}
      onChanged={put}
      onRemoved={(said) => {
        setRemoved({ said: said ?? null });
        drop(app.name);
      }}
      site={site}
      onSite={(x) => setPicked(x === app.name ? undefined : x)}
      domains={dns.domains}
      domainsFailed={dns.failed}
      onDns={dns.put}
      onDomains={dns.set}
      onDomain={dns.putDomain}
      onRenewal={dns.putRenewal}
      settings={settings.answer}
      onSettings={settings.put}
      email={state?.account?.user.email ?? null}
    />
  );
}

/** The last read of each app's settings, so its tab opened again shows them at once (and reads them again). */
const settingsRead = new Map<string, AppSettingsAnswer>();

/**
 * An app's settings and recent deploys (null: being read, or they couldn't be), read again when `stamp`
 * changes and when the window comes back into focus. `put`: as a change answered them. Never a variable's
 * value: Orgo answers names only.
 */
function useSettings(ws: string, name: string, site: string | undefined, stamp: string) {
  const key = `${ws}\n${name}\n${site ?? ""}`;
  const [got, setGot] = useState<{ key: string; answer: AppSettingsAnswer | null } | null>(null);
  const answer = (got?.key === key ? got.answer : null) ?? settingsRead.get(key) ?? null;
  useEffect(() => {
    let stop = false;
    const read = () =>
      void readSettings(ws, name, site).then((r) => {
        if (stop) return;
        if (r.ok) settingsRead.set(key, r.ok);
        setGot((g) => ({ key, answer: r.ok ?? (g?.key === key ? g.answer : null) }));
      });
    read();
    const off = whenFocused(read);
    return () => {
      stop = true;
      off();
    };
  }, [key, ws, name, site, stamp]);
  const put = (a: AppSettingsAnswer) => {
    settingsRead.set(key, a);
    setGot({ key, answer: a });
  };
  return { answer, put };
}

/** The last read of each app's domains, so its tab opened again shows them at once (and reads them again). */
const domainsRead = new Map<string, AppDomainsAnswer>();

/**
 * An app's domains (null: being read), read again when `stamp` changes and when the window comes back into
 * focus. One read that fails keeps what was there; `failed` is why, while there's nothing. `put`: a zone's
 * records as a change wrote them.
 */
function useDomains(ws: string, name: string, site: string | undefined, stamp: string) {
  const key = `${ws}\n${name}\n${site ?? ""}`;
  const [got, setGot] = useState<{ key: string; answer: AppDomainsAnswer | null; error: string | null } | null>(null);
  // (`fresh`: as this tab read or changed them, never what was kept from before.)
  const fresh = got?.key === key ? got.answer : null;
  const domains = fresh ?? domainsRead.get(key) ?? null;
  const failed = !domains && got?.key === key ? got.error : null;
  useEffect(() => {
    let stop = false;
    const read = () =>
      void readDomains(ws, name, site).then((r) => {
        if (stop) return;
        if (r.answer) domainsRead.set(key, r.answer);
        setGot((g) => ({ key, answer: r.answer ?? (g?.key === key ? g.answer : null), error: r.answer ? null : (r.error ?? "Couldn't read its domains just now.") }));
      });
    read();
    const off = whenFocused(read);
    return () => {
      stop = true;
      off();
    };
  }, [key, ws, name, site, stamp]);
  const change = (f: (a: AppDomainsAnswer) => AppDomainsAnswer) =>
    setGot((g) => {
      const base = (g?.key === key ? g.answer : null) ?? domainsRead.get(key);
      if (!base) return g;
      const next = f(base);
      domainsRead.set(key, next);
      return { key, answer: next, error: null };
    });
  const put = (w: AppDnsWritten) => change((base) => ({ ...base, zones: base.zones.map((z) => (z.id === w.zone ? { ...z, records: w.records } : z)) }));
  /** All of them as a change answered them (a domain added or removed). */
  const set = (a: AppDomainsAnswer) => {
    domainsRead.set(key, a);
    setGot({ key, answer: a, error: null });
  };
  /** One domain as a check answered it. */
  const putDomain = (d: AppDomain) => change((base) => ({ ...base, domains: base.domains.map((x) => (x.id === d.id ? d : x)) }));
  /** A bought domain's renewal as a change answered it. */
  const putRenewal = (zone: string, r: AppRenewal) => change((base) => ({ ...base, zones: base.zones.map((z) => (z.id === zone ? { ...z, renewal: r } : z)) }));
  return { domains, fresh, failed, put, set, putDomain, putRenewal };
}

/**
 * The history after a newer read of its newest page (`fresh`): that page, and the older pages read before
 * under it when the page reaches into them (else the newest page alone, with its own `next`).
 */
export function withNewest(fresh: AppCommitsAnswer, was: AppCommitsAnswer | null | false): AppCommitsAnswer {
  if (!was || was.offline || fresh.offline || !fresh.commits.length) return fresh;
  const last = fresh.commits[fresh.commits.length - 1].id;
  const i = was.commits.findIndex((c) => c.id === last);
  return i < 0 ? fresh : { ...fresh, commits: [...fresh.commits, ...was.commits.slice(i + 1)], next: was.next };
}

/** The history with an older page read (`page`, from `before` = the history's `next`) under it. */
export function withOlder(was: AppCommitsAnswer, page: AppCommitsAnswer): AppCommitsAnswer {
  const seen = new Set(was.commits.map((c) => c.id));
  return { ...was, commits: [...was.commits, ...page.commits.filter((c) => !seen.has(c.id))], next: page.next };
}

/** Reading older changesets: while one is read, whether the last one failed, and the press that reads it. */
type Older = { reading: boolean; failed: boolean; go: () => void };

/**
 * An app's changesets (null: being read; false: they couldn't be), read again when `stamp` changes and
 * when the window comes back into focus. One read that fails keeps what was there. `older`: the next page.
 */
function useHistory(ws: string, name: string, stamp: string) {
  const [history, setHistory] = useState<AppCommitsAnswer | null | false>(null);
  const [paging, setPaging] = useState({ reading: false, failed: false });
  useEffect(() => {
    let stop = false;
    const read = () =>
      void readCommits(ws, name).then((r) => {
        if (!stop) setHistory((was) => (r ? withNewest(r, was) : was || false));
      });
    read();
    const off = whenFocused(read);
    return () => {
      stop = true;
      off();
    };
  }, [ws, name, stamp]);
  const go = () => {
    if (!history || !history.next || paging.reading) return;
    const before = history.next;
    setPaging({ reading: true, failed: false });
    void readCommits(ws, name, before).then((page) => {
      setPaging({ reading: false, failed: !page || !!page.offline });
      // (Only onto the history it was read from: a newer read since starts from the newest page again.)
      if (page && !page.offline) setHistory((was) => (was && was.next === before ? withOlder(was, page) : was));
    });
  };
  return { history, older: { ...paging, go } satisfies Older };
}

/** A commit's message as its line shows it: the first line. */
const firstLine = (message: string) => message.split("\n", 1)[0].trim();

/**
 * An app: its state, name, address (open, copy), "Work on it" (`work`: its bot's chat with words typed in,
 * when there's one to ask) and Deploy (the newest changeset); then one page, in order: its Address, its
 * Domains, its Settings and variables (once it was deployed), its Deploys with the newest one's log, folded;
 * and its history, newest first, one line per changeset (short id, message, author, when, files added,
 * changed and deleted), the one its site serves marked Live and any other deployable from its line ("Deploy
 * this one", shown as the line is pointed at), older ones a page at a time; while Ingot can't be reached,
 * one quiet line instead. A section with nothing to show isn't there (but its settings and variables, before
 * its first deploy where deploying is open, so its first build has them). Then its end (AppEnd): Add a site,
 * Remove app.
 *
 * One with more sites has a list of them first (SiteLine: one line each, its state, name and domains, or its
 * address on orgo.dev while it has none, and Deploy this site), a line pressed picking it (`site`, told to
 * `onSite`; kept here when no one listens); the sections under it, to Deploys, are
 * that site's (AppSite: made again for each one picked, so nothing typed follows to another), the title's
 * Deploy deploys them all, as its history's "Deploy this one to all" does, and its history marks each
 * changeset Live on the sites that serve it. One whose computer is gone says it needs a new home.
 */
export function HostedAppView({
  ws,
  answer,
  app,
  history,
  older,
  work,
  onChanged,
  onRemoved = () => {},
  site,
  onSite,
  domains = null,
  domainsFailed = null,
  onDns = () => {},
  onDomains = () => {},
  onDomain = () => {},
  onRenewal = () => {},
  settings = null,
  onSettings = () => {},
  email = null,
}: {
  ws: string;
  answer: Pick<HostedAppsAnswer, "enabled" | "why">;
  app: HostedApp;
  /** null: being read; false: it couldn't be. */
  history: AppCommitsAnswer | null | false;
  older?: Older;
  work?: { name: string; go: () => void } | null;
  onChanged: (app: HostedApp) => void;
  /** It was removed from the workspace (`said`: the domains Orgo kept on its computer). */
  onRemoved?: (said?: string) => void;
  /** The site picked, of one with more than one (none: its own), and who hears another picked. */
  site?: string;
  onSite?: (site: string) => void;
  /** Its domains and their DNS (null: being read), and why they couldn't be read while there are none. */
  domains?: AppDomainsAnswer | null;
  domainsFailed?: string | null;
  /** A zone's records as a change wrote them. */
  onDns?: (w: AppDnsWritten) => void;
  /** Its domains as a change answered them (one added or removed), one as a check did, a bought one's renewal. */
  onDomains?: (a: AppDomainsAnswer) => void;
  onDomain?: (d: AppDomain) => void;
  onRenewal?: (zone: string, r: AppRenewal) => void;
  /** Its settings, variables' names and recent deploys (null: being read, or never deployed). */
  settings?: AppSettingsAnswer | null;
  onSettings?: (a: AppSettingsAnswer) => void;
  /** The signed-in account's email, to fill who a domain bought here is registered to. */
  email?: string | null;
}) {
  const { busy, error, run } = useDeploy(onChanged);
  const [mine, setMine] = useState<string | undefined>(undefined);
  const sites = app.sites;
  const current = sites?.find((x) => x.name === (onSite ? site : mine)) ?? sites?.[0];
  const pick = (x: string) => (onSite ? onSite(x) : setMine(x));
  // The picked site's name for every call under it (none: the app's own), and the app as that site has it.
  const siteName = current && current.name !== app.name ? current.name : undefined;
  const view = siteView(app, current);
  const lost = !!app.hosting?.lost;
  const url = urlOf(app);
  const online = history && !history.offline ? history : null;
  // What its site serves, as the list read last says (it's read again while a deploy runs), else as the history does.
  const serving = app.serving ?? (sites ? null : online?.commits.find((c) => c.serving)?.id) ?? null;
  /** The sites that serve a changeset, of one with more than one. */
  const servedBy = (id: string) => sites?.filter((x) => x.serving === id).map((x) => x.name) ?? [];
  // What a deploy waiting or running builds (the newest, when it doesn't say): any site's.
  const going = new Set([app, ...(sites ?? [])].filter(deploying).map((x) => x.live?.at ?? online?.head ?? app.head));
  /** The end of a changeset's line: Live (its site serves it; the ones that do, of more), Deploying, else "Deploy this one". */
  const end = (c: AppCommit) => {
    const on = sites ? servedBy(c.id) : c.id === serving ? [app.name] : [];
    if (on.length)
      return (
        <span
          data-live
          title={sites ? `Live on ${on.join(", ")}` : undefined}
          className="flex min-w-0 max-w-[180px] shrink-0 items-center gap-1 rounded-full bg-[#EAF7EF] px-2 py-0.5 text-[11px] font-medium leading-4 text-[#1E7A4C]"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-[#2BB673]" />
          <span className="truncate">{sites && on.length < sites.length ? `Live on ${on.join(", ")}` : "Live"}</span>
        </span>
      );
    if (going.has(c.id))
      return (
        <span data-going className="flex shrink-0 items-center gap-1 rounded-full bg-[color:var(--c-f2f2f0)] px-2 py-0.5 text-[11px] font-medium leading-4 text-[color:var(--c-3a3a38)]">
          <span className={`size-1.5 rounded-full ${PULSE}`} />
          Deploying
        </span>
      );
    return (
      // Shown as its line is pointed at or reached with the keyboard, so the history reads as a list.
      <span className="flex shrink-0 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
        <DeployButton label={sites ? "Deploy this one to all" : "Deploy this one"} why={whyNot(answer, app, c.id)} busy={busy(c.id, app.name)} onClick={() => void run(c.id, app.name, { ws, action: "deploy", at: c.id })} />
      </span>
    );
  };
  return (
    <div data-hosted-tab={app.name} className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--c-f0f0ee)] px-4">
        <StateDot app={app} />
        <span title={app.name} className="min-w-0 shrink truncate text-[13px] font-semibold leading-4 text-ink">
          {app.name}
        </span>
        {url ? (
          <>
            <UrlLink url={url} />
            <CopyLink url={url} />
          </>
        ) : (
          <span className="shrink-0 text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{lost ? "Needs a new home" : noAddress(app)}</span>
        )}
        <span className="flex-1" />
        {work && (
          <button
            onClick={work.go}
            data-tip={`Opens ${work.name}'s chat with this typed, not sent`}
            className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_var(--c-e2e2df)] hover:bg-[color:var(--c-f6f6f4)]"
          >
            Work on it
          </button>
        )}
        <DeployButton primary label={sites ? "Deploy all" : "Deploy"} why={whyNot(answer, app)} busy={busy("newest", app.name)} onClick={() => void run("newest", app.name, { ws, action: "deploy" })} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-3">
        {lost && (
          <span data-lost className={QUIET}>
            {lostTip(app)}
          </span>
        )}
        {sites && current && (
          <div data-sites className="flex flex-col">
            <span className="pb-1 text-[12px] font-semibold leading-4 text-[color:var(--c-6b6b6b)]">Sites</span>
            <div className="-mx-2 flex flex-col gap-0.5">
              {sites.map((x) => (
                <SiteLine
                  key={x.name}
                  site={x}
                  picked={x.name === current.name}
                  lost={lost}
                  onPick={() => pick(x.name)}
                  deploy={
                    <DeployButton
                      label="Deploy this site"
                      why={whyNot(answer, app, undefined, x)}
                      busy={busy(`site:${x.name}`, app.name)}
                      onClick={() => void run(`site:${x.name}`, app.name, { ws, action: "deploy", site: x.name })}
                    />
                  }
                />
              ))}
            </div>
          </div>
        )}
        {(view.live?.state === "failed" || error) && (
          <div className="flex flex-col gap-1">
            {view.live?.state === "failed" && (
              <span className={PROBLEM} title={view.live.error ?? undefined}>
                The last deploy failed{view.live.error ? `: ${view.live.error}` : "."}
              </span>
            )}
            {error && (
              <span className={PROBLEM} title={error.text}>
                {error.text}
              </span>
            )}
          </div>
        )}
        {/* Made again for each site picked: what was typed for one (its settings, a variable, a domain) never follows to another. */}
        <AppSite.Provider key={siteName ?? app.name} value={siteName}>
          <AppAddress url={domains?.url ?? settings?.url ?? urlOf(view)} />
          <Domains ws={ws} app={view} answer={domains} failed={domainsFailed} onDns={onDns} onDomains={onDomains} onDomain={onDomain} onRenewal={onRenewal} email={email} />
          {/* Before its first deploy, there to set where deploying is open (the first save makes its project). */}
          {settings && (settings.settings || (!lost && answer.enabled)) && <AppSettingsSection ws={ws} name={app.name} answer={settings} onSaved={onSettings} />}
          {/* One log per deploy: a deploy that ends keeps its log open where it was. */}
          <AppDeploys ws={ws} app={view} deploys={settings?.deploys ?? []} onChanged={onChanged} log={view.live && <DeployLog key={`${siteName ?? ""}:${view.live.id}`} ws={ws} name={app.name} live={view.live} />} />
        </AppSite.Provider>
        <div data-history className="flex flex-col">
          <span className="pb-1 text-[12px] font-semibold leading-4 text-[color:var(--c-6b6b6b)]">History</span>
          {history === null ? (
            <span className={QUIET}>Reading it…</span>
          ) : history === false ? (
            <span className={QUIET}>Couldn&apos;t read the history just now.</span>
          ) : history.offline ? (
            <span data-offline className={QUIET}>
              Ingot isn&apos;t answering just now, so the history isn&apos;t here.
            </span>
          ) : !history.commits.length ? (
            <span className={QUIET}>No commits yet.</span>
          ) : (
            <>
              <div className="-mx-2 flex flex-col">
                {history.commits.map((c) => (
                  <CommitLine key={c.id} commit={c} serving={sites ? servedBy(c.id).length > 0 : c.id === serving} end={end(c)} />
                ))}
              </div>
              {history.next && older && (
                <button
                  data-older
                  onClick={older.go}
                  disabled={older.reading}
                  className="-mx-2 mt-0.5 h-7 self-start rounded-lg px-2 text-[12px] leading-4 text-[color:var(--c-6b6b6b)] hover:bg-[color:var(--c-f6f6f4)] hover:text-ink disabled:text-[color:var(--c-9a9a98)] disabled:hover:bg-transparent"
                >
                  {older.reading ? "Reading…" : older.failed ? "Couldn't read older ones. Try again" : "Show older"}
                </button>
              )}
            </>
          )}
        </div>
        <AppEnd ws={ws} app={app} site={siteName} onChanged={onChanged} onRemoved={onRemoved} onPicked={pick} />
      </div>
    </div>
  );
}

/**
 * One site of an app with more, on its line in the Sites list: its state, its name, then its domains (each
 * one's name with a dot for how it's doing: live, or waiting for its DNS, the word in its tooltip), or its
 * address on orgo.dev while it has none (or they couldn't be read), else that it isn't on the web yet
 * (nothing, when its computer is gone: `lost`, the title says it needs a new home); and at its end Deploy
 * this site (`deploy`). Pressed anywhere on it but that, it's the one picked (`onPick`). In a narrow panel
 * its domains wrap under its name, past its dot.
 */
function SiteLine({ site: x, picked, lost, onPick, deploy }: { site: HostedSite; picked: boolean; lost: boolean; onPick: () => void; deploy: ReactNode }) {
  const url = x.live?.url ?? x.url;
  return (
    <div data-site-line={x.name} className={`relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-1 ${picked ? "bg-[color:var(--c-f2f2f0)] shadow-[0_0_0_1px_var(--c-e2e2df)]" : "hover:bg-[color:var(--c-f6f6f4)]"}`}>
      {/* (Its press covers all of its line, its padding too, under Deploy this site.) */}
      <button data-site={x.name} aria-pressed={picked} onClick={onPick} className="flex min-w-0 flex-1 items-start gap-2 py-1 text-left after:absolute after:inset-0 after:rounded-lg">
        <span className="flex h-4 shrink-0 items-center">
          <StateDot app={x} />
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`max-w-full truncate text-[12.5px] leading-4 text-ink ${picked ? "font-semibold" : "font-medium"}`}>{x.name}</span>
          {x.domains?.length ? (
            x.domains.map((d) => {
              // (A state this build doesn't know reads as waiting.)
              const s = DOMAIN_STATES[d.status] ?? DOMAIN_STATES.pending;
              return (
                <span key={d.domain} data-site-domain={d.domain} data-domain-state={d.status} data-tip={s.word} className="flex min-w-0 max-w-full items-center gap-1">
                  <span role="img" aria-label={s.word} className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
                  <span className="truncate font-mono text-[11.5px] leading-4 text-[color:var(--c-6b6b6b)]">{d.domain}</span>
                </span>
              );
            })
          ) : url ? (
            <span data-site-address className="min-w-0 max-w-full truncate font-mono text-[11.5px] leading-4 text-[color:var(--c-6b6b6b)]">
              {bare(url)}
            </span>
          ) : lost ? null : (
            <span className="text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{noAddress(x)}</span>
          )}
        </span>
      </button>
      <span className="relative flex shrink-0">{deploy}</span>
    </div>
  );
}

/**
 * One changeset: its short id (all of it in the tooltip), its message's first line (all of it in the
 * tooltip), who and when, how many files it added, changed and deleted, and how its line ends (`end`).
 */
function CommitLine({ commit: c, serving, end }: { commit: AppCommit; serving: boolean; end: ReactNode }) {
  const message = firstLine(c.message);
  return (
    <div data-commit={c.id} data-serving={serving || undefined} className="group flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-[color:var(--c-f6f6f4)]">
      <span title={c.id} className="w-[52px] shrink-0 font-mono text-[11.5px] leading-4 text-[color:var(--c-6b6b6b)]">
        {short(c.id)}
      </span>
      <span title={c.message} className={`min-w-0 flex-1 truncate text-[12.5px] leading-4 ${message ? "text-ink" : "text-[color:var(--c-9a9a98)]"}`}>
        {message || "No message"}
      </span>
      <span title={c.author} className="max-w-[110px] shrink-0 truncate text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">
        {c.author}
      </span>
      <span title={new Date(c.at).toLocaleString()} className="w-8 shrink-0 text-right text-[12px] leading-4 text-[color:var(--c-9a9a98)]">
        {ago(c.at)}
      </span>
      <Changes changes={c.changes} />
      {end}
    </div>
  );
}

/** Files added, changed and deleted, as +2 ~1 -1 (the ones with none left out), in words in the tooltip. */
function Changes({ changes }: { changes?: AppCommit["changes"] | null }) {
  const { added = 0, modified = 0, deleted = 0 } = changes ?? {};
  const parts = [
    { n: added, mark: "+", word: "added", look: "text-[#1E7A4C]" },
    { n: modified, mark: "~", word: "changed", look: "text-[color:var(--c-6b6b6b)]" },
    { n: deleted, mark: "-", word: "deleted", look: "text-[#B42318]" },
  ].filter((p) => p.n > 0);
  if (!parts.length) return null;
  const files = added + modified + deleted;
  const tip = `${files} ${files === 1 ? "file" : "files"}: ${parts.map((p) => `${p.n} ${p.word}`).join(", ")}`;
  return (
    <span data-changes title={tip} className="flex shrink-0 gap-1 font-mono text-[11px] leading-4">
      {parts.map((p) => (
        <span key={p.mark} className={p.look}>
          {p.mark}
          {p.n}
        </span>
      ))}
    </span>
  );
}

/**
 * The newest deploy's log, folded. Opened, it's read from the start, then on from where it got to
 * (`next`): at once while there's more, every few seconds while the deploy waits or runs. A read that
 * fails is tried again then too (a few times in a row at most), and says so under what was read.
 */
function DeployLog({ ws, name, live }: { ws: string; name: string; live: NonNullable<HostedApp["live"]> }) {
  const site = useContext(AppSite);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<{ text: string; state: DeployState | null; failed: boolean } | null>(null);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!open) return;
    let stop = false;
    let after: string | number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let state: DeployState | null = live.state;
    let misses = 0;
    const read = async () => {
      const first = after === null;
      const r = await readLog(ws, name, after, site);
      if (stop) return;
      if (!r) {
        setLog((l) => ({ text: first ? "" : (l?.text ?? ""), state: l?.state ?? null, failed: true }));
        if (++misses < 10 && (state === "queued" || state === "running")) timer = setTimeout(read, POLL_MS);
        return;
      }
      misses = 0;
      state = r.state;
      after = r.next ?? after;
      setLog((l) => ({ text: (first ? "" : (l?.text ?? "")) + (r.log ?? ""), state: r.state, failed: false }));
      if (r.more || r.state === "queued" || r.state === "running") timer = setTimeout(read, r.more ? 250 : POLL_MS);
    };
    void read();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // The deploy's state as it opened is where reading starts; the reads say it from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ws, name, site]);
  // The newest line stays in sight as more comes.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log?.text]);
  const state = (open && log?.state) || live.state;
  const facts = [live.at ? short(live.at) : null, state ? STATES[state]?.word : null, live.when ? ago(live.when) : null].filter(Boolean).join(" · ");
  return (
    <div data-deploy-log className="flex flex-col gap-1.5">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="-mx-2 flex h-8 items-center gap-2 rounded-lg px-2 text-left hover:bg-[color:var(--c-f6f6f4)]">
        <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 text-[color:var(--c-6b6b6b)] transition-transform ${open ? "rotate-90" : ""}`}>
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="shrink-0 text-[12px] font-semibold leading-4 text-[color:var(--c-6b6b6b)]">Deploy log</span>
        <span className="min-w-0 truncate text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{facts}</span>
      </button>
      {open && (
        <pre ref={box} className="max-h-[320px] min-h-[64px] overflow-auto whitespace-pre-wrap break-all rounded-xl bg-[color:var(--c-f6f6f4)] px-3 py-2.5 font-mono text-[11px] leading-[16px] text-[color:var(--c-3a3a38)]">
          {log?.text || (!log ? "Reading it…" : log.failed ? "Couldn't read the log." : "Nothing logged yet.")}
        </pre>
      )}
      {open && log?.text && log.failed && <span className={QUIET}>Couldn&apos;t read more of the log.</span>}
    </div>
  );
}

/* ---------------- Its domains and their DNS ---------------- */

const DOMAIN_STATES: Record<AppDomainStatus, { word: string; dot: string }> = {
  pending: { word: "Waiting for its DNS", dot: PULSE },
  verifying: { word: "Checking its DNS", dot: PULSE },
  active: { word: "Live", dot: "bg-[#2BB673]" },
  failed: { word: "Couldn't be verified", dot: "bg-[#B42318]" },
  disabled: { word: "Turned off by Orgo", dot: "bg-[color:var(--c-9a9a98)]" },
};

/** A domain's state in a word, and in full for its dot's tooltip (its HTTPS certificate, once it's live). */
function domainState(d: AppDomain) {
  // (A state this build doesn't know reads as waiting.)
  const s = DOMAIN_STATES[d.status] ?? DOMAIN_STATES.pending;
  const cert = d.status !== "active" ? null : d.cert === "issued" ? "its HTTPS certificate is issued" : "its HTTPS certificate comes with its first visit";
  return { ...s, tip: cert ? `${s.word} · ${cert}` : s.word };
}

/** What Orgo found of a record to set, when it looked. */
const FOUND = { ok: { word: "Found", look: "text-[#1E7A4C]" }, missing: { word: "Not there yet", look: "text-[color:var(--c-9a9a98)]" }, wrong: { word: "Says something else", look: "text-[#B42318]" } };

/** A record's name as it's shown: @ for the domain itself. */
const atName = (name: string) => name || "@";

export const PILL = "rounded-full px-3 py-1 text-[12px] font-medium leading-4 disabled:opacity-50";
/** Shown as its line is pointed at or reached with the keyboard, so the records read as a list. */
const ON_HOVER = "flex shrink-0 items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none";

/** How often, and how many times, Orgo is asked to check a domain just pointed here whose records it writes itself. */
const CHECK_MS = 4000;
const CHECKS = 30;

/**
 * Its domains: each domain that points at it (its computer serves it on the app's port) with how it's
 * doing, and Remove (asked once more first); one bought elsewhere has its DNS greyed out under it (the
 * records to set where it's kept, each value to copy, and Verify). Add a domain (AddDomain) under
 * them, once it's on the web. Then the DNS records of each one bought through Orgo (DnsZone), with its
 * renewal. A domain just pointed here whose records Orgo writes itself is checked every few seconds until
 * it's live (a couple of minutes at most), its line saying so. Each line is one 32px line, so what's read
 * comes in under it a line at a time.
 */
function Domains({
  ws,
  app,
  answer,
  failed,
  onDns,
  onDomains,
  onDomain,
  onRenewal,
  email,
}: {
  ws: string;
  app: HostedApp;
  answer: AppDomainsAnswer | null;
  failed: string | null;
  onDns: (w: AppDnsWritten) => void;
  onDomains: (a: AppDomainsAnswer) => void;
  onDomain: (d: AppDomain) => void;
  onRenewal: (zone: string, r: AppRenewal) => void;
  email?: string | null;
}) {
  const site = useContext(AppSite);
  // Never deployed: no project, so no port for a domain to serve. Nothing to read.
  const deployed = !!app.hosting?.projectId;
  const none = !deployed || (answer && !answer.domains.length);
  const [adding, setAdding] = useState(false);
  const [watching, setWatching] = useState<string[]>([]);
  const [said, setSaid] = useState<Record<string, string | null>>({});
  const say = (id: string, text: string | null) => setSaid((x) => ({ ...x, [id]: text }));
  const watched = watching.join(",");
  useEffect(() => {
    if (!watched) return;
    let stop = false;
    let tries = 0;
    const ids = watched.split(",");
    const t = setInterval(() => {
      tries++;
      for (const id of ids)
        void checkDomain(ws, app.name, id, site).then((r) => {
          if (stop || !r.ok) return;
          onDomain(r.ok.domain);
          const over = r.ok.domain.status === "active" || r.ok.domain.status === "failed" || r.ok.domain.status === "disabled";
          say(id, over ? (r.ok.said ?? null) : null);
          if (over) setWatching((w) => w.filter((x) => x !== id));
        });
      if (tries >= CHECKS) {
        setWatching([]);
        for (const id of ids) say(id, "Orgo is still checking it. It goes live once its DNS answers, usually within a few minutes.");
      }
    }, CHECK_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // What's watched decides it; the answers go through what this renders with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, ws, app.name, site]);
  return (
    <div data-domains className="flex flex-col">
      <span className="pb-1 text-[12px] font-semibold leading-4 text-[color:var(--c-6b6b6b)]">Domains</span>
      {!none && (
        <div className="-mx-2 flex flex-col">
          {answer?.domains.map((d) => (
            <DomainLine key={d.id} ws={ws} name={app.name} d={d} checking={watching.includes(d.id)} said={said[d.id] ?? null} onSaid={(t) => say(d.id, t)} onDomain={onDomain} onDomains={onDomains} />
          ))}
        </div>
      )}
      {none ? (
        <span data-no-domains className={`flex h-8 items-center ${QUIET}`}>
          It has no domain of its own yet.
        </span>
      ) : (
        !answer && <span className={`flex h-8 items-center ${QUIET}`}>{failed ?? "Reading them…"}</span>
      )}
      {deployed &&
        answer &&
        (adding ? (
          <AddDomain
            ws={ws}
            name={app.name}
            email={email}
            onClose={() => setAdding(false)}
            onAdded={(all, d) => {
              onDomains(all);
              // One Orgo writes the records of goes live in a minute or two: checked until it is.
              if (d && d.managed && d.status !== "active") setWatching((w) => [...w.filter((x) => x !== d.id), d.id]);
            }}
          />
        ) : (
          <button
            data-add-domain
            onClick={() => setAdding(true)}
            className="-mx-2 mt-0.5 flex h-7 items-center gap-1.5 self-start rounded-lg px-2 text-[12px] leading-4 text-[color:var(--c-6b6b6b)] hover:bg-[color:var(--c-f6f6f4)] hover:text-ink"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M5 1.5v7M1.5 5h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            Add a domain
          </button>
        ))}
      {!none && answer?.zones.map((z) => <DnsZone key={z.id} ws={ws} name={app.name} zone={z} onDns={onDns} onRenewal={onRenewal} />)}
    </div>
  );
}

/**
 * One domain: its state, its name (a link once it's live), who keeps its DNS, and on its line's end Check
 * again (one bought through Orgo, while it isn't live) and Remove; what the last check said. One bought
 * elsewhere has its DNS greyed out under it (OutsideDns), as Orgo can't change it: the records to set
 * there, each value to copy, and Verify.
 */
function DomainLine({
  ws,
  name,
  d,
  checking,
  said,
  onSaid,
  onDomain,
  onDomains,
}: {
  ws: string;
  name: string;
  d: AppDomain;
  checking: boolean;
  said: string | null;
  onSaid: (text: string | null) => void;
  onDomain: (d: AppDomain) => void;
  onDomains: (a: AppDomainsAnswer) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<"check" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const site = useContext(AppSite);
  const s = domainState(d);
  const check = () => {
    setBusy("check");
    setError(null);
    void checkDomain(ws, name, d.id, site).then((r) => {
      setBusy(null);
      if (!r.ok) return setError(r.no.error);
      onDomain(r.ok.domain);
      onSaid(r.ok.said ? undash(r.ok.said) : r.ok.domain.status === "active" ? null : "Not there yet. New records can take a few minutes to show up.");
    });
  };
  const remove = () => {
    setBusy("remove");
    setError(null);
    void removeDomain(ws, name, d.id, site).then((r) => {
      setBusy(null);
      if (!r.ok) return setError(r.no.error);
      setRemoving(false);
      onDomains(r.ok);
    });
  };
  const waits = d.status !== "active" && d.status !== "disabled";
  return (
    <>
      <div data-domain={d.domain} data-status={d.status} className="group flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 hover:bg-[color:var(--c-f6f6f4)]">
        <span data-tip={s.tip} className={`size-2 shrink-0 rounded-full ${checking ? PULSE : s.dot}`} />
        {d.status === "active" ? (
          <UrlLink url={`https://${d.domain}`} />
        ) : (
          <span title={d.domain} className="min-w-0 shrink truncate font-mono text-[11.5px] leading-4 text-ink">
            {d.domain}
          </span>
        )}
        <span className="min-w-0 shrink truncate text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">{checking ? "Checking its DNS…" : s.word}</span>
        <span className="flex-1" />
        {/* In a narrow panel these give way (cut short) before the buttons do. */}
        {d.managed ? (
          <span className="min-w-0 shrink-[3] truncate text-[12px] leading-4 text-[color:var(--c-9a9a98)]">Bought through Orgo</span>
        ) : (
          d.status !== "disabled" && <span className="min-w-0 shrink-[3] truncate text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{d.where ? `DNS at ${d.where}` : "DNS outside Orgo"}</span>
        )}
        {d.managed && waits && !checking && (
          <button data-check onClick={check} disabled={!!busy} className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_var(--c-e2e2df)] hover:bg-white disabled:text-[color:var(--c-9a9a98)]">
            {busy === "check" ? "Checking…" : "Check again"}
          </button>
        )}
        {d.status !== "disabled" && (
          <span className={ON_HOVER}>
            <button
              aria-label={`Remove ${d.domain}`}
              data-tip="Remove"
              disabled={!!busy}
              onClick={() => {
                setRemoving(true);
                setError(null);
              }}
              className={rowTrashBtn}
            >
              <TrashIcon />
            </button>
          </span>
        )}
      </div>
      {removing && (
        <div className="px-2 pb-1" onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}>
          <InlineConfirm
            text={`Remove ${d.domain} from this app?${d.managed ? " The domain stays yours." : ""}`}
            action="Remove"
            doing="Removing…"
            busy={busy === "remove"}
            onConfirm={remove}
            onCancel={() => {
              setRemoving(false);
              setError(null);
            }}
          />
        </div>
      )}
      {/* Bought through Orgo, but Orgo didn't say which of the workspace's bought domains it's in (DNS isn't
          open to the account, its list couldn't be read, the computer moved workspace): no zone to show, so why. */}
      {d.managed && !d.zone && (
        <span data-no-zone={d.domain} className="mb-1 ml-6 text-[12px] leading-[18px] text-[color:var(--c-9a9a98)]">
          Couldn&apos;t read its DNS records.
        </span>
      )}
      {!d.managed && d.status !== "disabled" && <OutsideDns d={d} busy={busy === "check"} disabled={!!busy} onVerify={check} />}
      {(said || error) && (
        <span role={error ? "alert" : undefined} className={`mb-1 ml-6 text-[12px] leading-[18px] ${error ? "text-[#B42318]" : "text-[color:var(--c-6b6b6b)]"}`}>
          {error ?? said}
        </span>
      )}
    </>
  );
}

/**
 * The DNS of a domain bought elsewhere, greyed out: Orgo can't change it, so it's only the records to set
 * where it's kept (once it's live, what routes it there), each value to copy, with what Orgo found of each,
 * and Verify, which looks again (and turns it live once they answer).
 */
function OutsideDns({ d, busy, disabled, onVerify }: { d: AppDomain; busy: boolean; disabled: boolean; onVerify: () => void }) {
  // Who keeps it is on the domain's line already.
  const there = d.where ? `at ${d.where}` : "where its DNS is kept";
  const said = d.status === "active" ? `Orgo doesn't change its DNS.${d.publish.length ? ` This is what's set ${there}.` : ""}` : `Orgo can't set these. Add them ${there}, then Verify.`;
  return (
    <div data-publish={d.domain} data-outside-dns className="mb-1 ml-6 flex min-w-0 flex-col rounded-lg bg-[color:var(--c-f6f6f4)] px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] leading-[18px] text-[color:var(--c-9a9a98)]">{said}</span>
        <button data-verify onClick={onVerify} disabled={disabled} className="shrink-0 whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_var(--c-e2e2df)] hover:bg-[#FBFBFA] disabled:text-[color:var(--c-9a9a98)]">
          {busy ? "Verifying…" : "Verify"}
        </button>
      </div>
      {d.publish.map((r, i) => (
        <div key={i} className="flex h-7 min-w-0 items-center gap-2">
          <span className="w-[46px] shrink-0 font-mono text-[11.5px] leading-4 text-[color:var(--c-9a9a98)]">{r.type}</span>
          <span title={r.name} className="w-[112px] min-w-0 shrink truncate font-mono text-[11.5px] leading-4 text-[color:var(--c-6b6b6b)]">
            {r.name}
          </span>
          <span title={r.value} className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-4 text-[color:var(--c-6b6b6b)]">
            {r.value}
          </span>
          <CopyLink url={r.value} label={`Copy the ${r.type} value`} />
          {r.found && FOUND[r.found] && <span className={`shrink-0 text-[12px] leading-4 ${FOUND[r.found].look}`}>{FOUND[r.found].word}</span>}
        </div>
      ))}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A record's value as its line shows it: an MX's priority before it, an SRV's priority, weight and port too. */
const valueOf = (r: AppDnsRecord) => [r.priority, r.weight, r.port, r.value].filter((x) => x !== undefined).join(" ");
const numbersOf = (r: AppDnsRecord) =>
  [r.priority !== undefined ? `priority ${r.priority}` : null, r.weight !== undefined ? `weight ${r.weight}` : null, r.port !== undefined ? `port ${r.port}` : null].filter(Boolean).join(", ");

/** The record a change wrote: the one in the zone as written that wasn't in it before (a record's id is what it says). */
const changedIn = (w: AppDnsWritten, before: AppDnsRecord[]) => w.records.find((x) => !before.some((b) => b.id === x.id))?.id ?? null;
/** The user's record after the one removed, else the one before it, as the records were when it was asked. */
const nextTo = (before: AppDnsRecord[], id: string) => {
  const mine = before.filter((x) => !x.locked);
  const i = mine.findIndex((x) => x.id === id);
  return i < 0 ? null : ((mine[i + 1] ?? mine[i - 1])?.id ?? null);
};

/**
 * A bought domain's DNS records, one 32px line each (type, name, value): Orgo's locked, with why in the
 * lock's tooltip; the user's changed in place or removed (asked once more first) from their line. Add
 * record under them. A change's answer is the zone as written, which replaces what's shown (every
 * record's id is what it says, so ids change with it); one that changed since it was read comes back as
 * it is now, with why. While its nameservers aren't Orgo's, the records are kept but don't answer, and it
 * says so. As a form or a question closes, focus goes back where it was asked (a record's Change or
 * Remove, or Add record); a record removed, to the next one.
 */
function DnsZone({ ws, name, zone, onDns, onRenewal = () => {} }: { ws: string; name: string; zone: AppDnsZone; onDns: (w: AppDnsWritten) => void; onRenewal?: (zone: string, r: AppRenewal) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const site = useContext(AppSite);
  const box = useRef<HTMLDivElement>(null);
  // The record's Change or Remove, by its id, else Add record (it's gone, or it was asked there). Called
  // once what closed is off the page, so focus never falls to the page (where the next Esc is the app's).
  const focusOn = (id: string | null, which: "Change" | "Remove" = "Change") => {
    const line = id ? [...(box.current?.querySelectorAll("[data-record]") ?? [])].find((el) => el.getAttribute("data-record") === id) : null;
    (line?.querySelector<HTMLElement>(`button[aria-label^="${which} "]`) ?? box.current?.querySelector<HTMLElement>("[data-add-record]"))?.focus();
  };
  const send = async (c: DnsChange) => {
    const before = zone.records;
    setBusy(true);
    setError(null);
    const r = await changeDns(name, site ? { ...c, site } : c);
    const why = { text: r.error ?? "Couldn't change the DNS. Try again.", ...(r.field ? { field: r.field } : {}) };
    // Focus moves on only from the form or the question (or the page): put somewhere else meanwhile, it stays there.
    const at = document.activeElement;
    const here = !at || at === document.body || !!box.current?.contains(at);
    const closed = r.written ?? r.now;
    if (!closed) {
      // Refused: the form or the question stays, with why.
      setBusy(false);
      setError(why);
      return;
    }
    flushSync(() => {
      setBusy(false);
      onDns(closed);
      setEditing(null);
      setRemoving(null);
      if (!r.written) setError(why);
    });
    if (!here) return;
    // Written: the record changed, the next one after a remove, Add record after an add. Changed since it
    // was read: Add record, with why just under it.
    focusOn(!r.written ? null : c.action === "change" ? (changedIn(r.written, before) ?? c.id) : c.action === "remove" ? nextTo(before, c.id) : null);
  };
  const open = (id: string | null) => {
    setEditing(id);
    setRemoving(null);
    setError(null);
  };
  const form = (start?: AppDnsRecord) => (
    <DnsRecordForm
      start={start}
      domain={zone.domain}
      busy={busy}
      error={error}
      onTyped={() => setError(null)}
      onCancel={() => {
        flushSync(() => open(null));
        focusOn(start?.id ?? null);
      }}
      onSave={(record) => void send(start ? { ws, zone: zone.id, action: "change", id: start.id, record } : { ws, zone: zone.id, action: "add", record })}
    />
  );
  // The question is open under a record still there (else why goes under the zone).
  const asking = !!removing && zone.records.some((r) => r.id === removing);
  return (
    <div ref={box} data-zone={zone.domain} className="mt-3 flex flex-col">
      <div className="flex h-6 items-center gap-2">
        <span className="min-w-0 truncate text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">
          DNS records for <span className="font-medium text-ink">{zone.domain}</span>
        </span>
        {!zone.serving && !zone.error && (
          <span data-not-serving data-tip="Its nameservers aren't Orgo's, so these records are kept but don't answer on the internet." className="shrink-0 text-[12px] leading-4 text-[#B54708]">
            Not answering
          </span>
        )}
        {zone.ttl !== null && <span className="shrink-0 text-[12px] leading-4 text-[color:var(--c-9a9a98)]">TTL {zone.ttl}s</span>}
      </div>
      <RenewalLine ws={ws} name={name} zone={zone} onRenewal={onRenewal} />
      {zone.error ? (
        <span className={`flex h-8 items-center ${QUIET}`}>{zone.error}</span>
      ) : (
        <>
          <div className="-mx-2 flex flex-col">
            {zone.records.map((r) =>
              editing === r.id && !r.locked ? (
                <div key={r.id} className="px-2 py-1">
                  {form(r)}
                </div>
              ) : (
                <div key={r.id} className="flex flex-col">
                  <RecordLine
                    r={r}
                    busy={busy}
                    onEdit={() => open(r.id)}
                    onRemove={() => {
                      open(null);
                      setRemoving(r.id);
                    }}
                  />
                  {removing === r.id && (
                    <div
                      className="flex flex-col gap-1 px-2 pb-1"
                      // Esc closes the question and only that (the app's Esc would close what's beside the tab).
                      onKeyDown={(e) => {
                        if (e.key === "Escape") e.stopPropagation();
                      }}
                    >
                      <InlineConfirm
                        // While its nameservers aren't Orgo's, the record isn't answering to stop.
                        text={`Remove the ${r.type} record at ${atName(r.name)}?${zone.serving ? " It stops answering in a minute or two." : ""}`}
                        action="Remove"
                        doing="Removing…"
                        busy={busy}
                        onConfirm={() => void send({ ws, zone: zone.id, action: "remove", id: r.id })}
                        onCancel={() => {
                          // Why it was refused goes with it.
                          flushSync(() => {
                            setRemoving(null);
                            setError(null);
                          });
                          focusOn(r.id, "Remove");
                        }}
                      />
                      {error && (
                        <span role="alert" className="px-1 text-[12px] leading-4 text-[#B42318]">
                          {error.text}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
          {editing === "new" ? (
            <div className="mt-1">{form()}</div>
          ) : (
            <button
              data-add-record
              onClick={() => open("new")}
              disabled={busy}
              className="-mx-2 mt-0.5 flex h-7 items-center gap-1.5 self-start rounded-lg px-2 text-[12px] leading-4 text-[color:var(--c-6b6b6b)] hover:bg-[color:var(--c-f6f6f4)] hover:text-ink disabled:text-[color:var(--c-9a9a98)]"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M5 1.5v7M1.5 5h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              Add record
            </button>
          )}
          {error && !editing && !asking && (
            <span role="alert" className="pt-1 text-[12px] leading-4 text-[#B42318]">
              {error.text}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** One record: its type, name (@ for the domain itself) and value; at its end, Orgo's lock (why in its tooltip), or Change and Remove. */
function RecordLine({ r, busy, onEdit, onRemove }: { r: AppDnsRecord; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const numbers = numbersOf(r);
  return (
    <div data-record={r.id} data-locked={r.locked ? "true" : undefined} className="group flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-[color:var(--c-f6f6f4)]">
      <span className="w-[46px] shrink-0 font-mono text-[11.5px] leading-4 text-[color:var(--c-6b6b6b)]">{r.type}</span>
      <span title={r.fqdn} className="w-[112px] shrink-0 truncate font-mono text-[11.5px] leading-4 text-ink">
        {atName(r.name)}
      </span>
      <span title={numbers ? `${r.value} (${numbers})` : r.value} className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-4 text-ink">
        {valueOf(r)}
      </span>
      {r.locked ? (
        <span role="img" data-tip={r.locked} aria-label={r.locked} className="flex size-7 shrink-0 items-center justify-center text-[color:var(--c-9a9a98)]">
          <LockIcon />
        </span>
      ) : (
        <span className={ON_HOVER}>
          <button aria-label={`Change the ${r.type} record at ${atName(r.name)}`} data-tip="Change" disabled={busy} onClick={onEdit} className={rowIconBtn}>
            <PencilIcon />
          </button>
          <button aria-label={`Remove the ${r.type} record at ${atName(r.name)}`} data-tip="Remove" disabled={busy} onClick={onRemove} className={rowTrashBtn}>
            <TrashIcon />
          </button>
        </span>
      )}
    </div>
  );
}

const VALUE_HINT: Record<string, string> = { A: "203.0.113.10", AAAA: "2001:db8::1", CNAME: "app.example.com", MX: "mail.example.com", TXT: "Text", SRV: "sip.example.com" };

/**
 * A record to add, or one to change (`start`, all of it sent as it becomes): its type, name and value, and
 * the numbers its type takes (an MX's priority; an SRV's priority, weight and port, each named in its
 * tooltip, as a filled field has no placeholder). The field Orgo said is wrong is ringed in red, with why
 * under the form. Esc cancels, except while it saves.
 */
export function DnsRecordForm({
  start,
  domain,
  busy,
  error,
  onTyped,
  onSave,
  onCancel,
}: {
  start?: AppDnsRecord;
  domain: string;
  busy: boolean;
  error: { text: string; field?: string } | null;
  onTyped: () => void;
  onSave: (r: AppDnsInput) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<string>(start?.type ?? "A");
  const [name, setName] = useState(start ? atName(start.name) : "");
  const [value, setValue] = useState(start?.value ?? "");
  const [priority, setPriority] = useState(start?.priority !== undefined ? String(start.priority) : "");
  const [weight, setWeight] = useState(start?.weight !== undefined ? String(start.weight) : "");
  const [port, setPort] = useState(start?.port !== undefined ? String(start.port) : "");
  const needs = dnsNeeds(type);
  const field = (f: string, extra = "") =>
    `h-8 rounded-full bg-[color:var(--c-f7f7f6)] px-3 font-mono text-[12px] outline-none ${error?.field === f ? "shadow-[0_0_0_1.5px_#B42318]" : "shadow-[0_0_0_1px_var(--c-e6e6e3)] focus:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]"} ${extra}`;
  const typed = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    if (error) onTyped();
  };
  return (
    <form
      data-record-form={start?.id ?? "new"}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        onSave({
          type,
          name: name.trim(),
          value,
          ...(needs.priority ? { priority: priority.trim() } : {}),
          ...(needs.weight ? { weight: weight.trim() } : {}),
          ...(needs.port ? { port: port.trim() } : {}),
        });
      }}
      onKeyDown={(e) => {
        // Closes the form, and keeps the tab as it is (the app's Esc would close the panel). Not while it
        // saves: the change can't be called back, so the form stays to say how it went.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onCancel();
        }
      }}
      className="flex flex-col gap-2 rounded-[12px] bg-[color:var(--c-fcfcfb)] p-2.5 shadow-[0_0_0_1px_var(--c-ececea)]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative flex">
          <select
            aria-label="Type"
            aria-invalid={error?.field === "type" || undefined}
            value={type}
            onChange={typed(setType)}
            className={`h-8 appearance-none rounded-full bg-white pl-3 pr-7 font-mono text-[12px] text-ink outline-none hover:bg-[color:var(--c-fcfcfb)] ${error?.field === "type" ? "shadow-[0_0_0_1.5px_#B42318]" : "shadow-[0_0_0_1px_var(--c-e6e6e3)] focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]"}`}
          >
            {DNS_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <svg width="10" height="10" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden>
            <path d="M3 4.5l3 3 3-3" fill="none" stroke="#6B6B6B" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <input
          aria-label="Name"
          aria-invalid={error?.field === "name" || undefined}
          data-tip={`Its name under ${domain}: @ for ${domain} itself, www for www.${domain}`}
          value={name}
          onChange={typed(setName)}
          placeholder="@ or www"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className={field("name", "w-[112px]")}
        />
        <input
          aria-label="Value"
          aria-invalid={error?.field === "value" || undefined}
          value={value}
          onChange={typed(setValue)}
          placeholder={VALUE_HINT[type] ?? ""}
          autoComplete="off"
          spellCheck={false}
          className={field("value", "min-w-[140px] flex-1")}
        />
        {needs.priority && (
          <input aria-label="Priority" aria-invalid={error?.field === "priority" || undefined} data-tip="Priority" value={priority} onChange={typed(setPriority)} placeholder="Priority" inputMode="numeric" className={field("priority", "w-[76px]")} />
        )}
        {needs.weight && <input aria-label="Weight" aria-invalid={error?.field === "weight" || undefined} data-tip="Weight" value={weight} onChange={typed(setWeight)} placeholder="Weight" inputMode="numeric" className={field("weight", "w-[76px]")} />}
        {needs.port && <input aria-label="Port" aria-invalid={error?.field === "port" || undefined} data-tip="Port" value={port} onChange={typed(setPort)} placeholder="Port" inputMode="numeric" className={field("port", "w-[76px]")} />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !value.trim()} className={`${PILL} bg-ink text-white disabled:opacity-40`}>
          {busy ? "Saving…" : start ? "Save" : "Add"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${PILL} bg-[color:var(--c-f2f2f0)] hover:bg-[color:var(--c-eaeae7)]`}>
          Cancel
        </button>
        {error && (
          <span role="alert" className="min-w-0 text-[12px] leading-4 text-[#B42318]">
            {error.text}
          </span>
        )}
      </div>
    </form>
  );
}
