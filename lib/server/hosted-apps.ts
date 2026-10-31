import "server-only";
import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appsOpen } from "@/lib/apps-access";
import { botChatId, live as isLive, routineSent, siteBotOf, siteOf, workBot, workspaceOf, type Session, type Workspace } from "@/lib/types";
import { appCoders, appEnvOf, copyBotOf, DEV_PORT, DNS_TYPES, dnsNeeds, ENV_NAME, ENV_RESERVED, isCopyName, isSiteName, localAddress, localsOf, localWords, LOG_LINE, LOG_LINES, MAX_SITES, offersInOrder, PASS_COOKIE, REGISTRANT_FIELDS, subdomainTyped } from "@/lib/hosted-apps";
import { screenMap } from "@/lib/screens";
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
  AppDomainRemoved,
  AppDomainsAnswer,
  AppHosting,
  AppProjectBehind,
  AppRenewal,
  AppRestoreConfirm,
  AppSettingsAnswer,
  CloudflareApplied,
  CloudflareOptions,
  CloudflarePlan,
  DeployState,
  DomainOffer,
  DomainSearchAnswer,
  HostedApp,
  HostedAppsAnswer,
  HostedSite,
  LocalAnswer,
  LocalCopy,
  LocalSite,
  OwnedDomain,
  PasswordSet,
  PreviewPassword,
  Registrant,
  RemoveAppAnswer,
  LeftOver,
  PreviewSite,
  SiteDomain,
} from "@/lib/hosted-apps";
import {
  computerAsleepError,
  deployedAt,
  deploys,
  domains,
  orgo,
  OrgoError,
  OrgoTimeout,
  publicUrls,
  type OrgoPublicUrl,
  type OrgoPublicUrls,
  type OrgoBoughtDomain,
  type OrgoBoughtList,
  type OrgoCustomDomain,
  type OrgoDeployment,
  type OrgoDeployProject,
  type OrgoDnsRecord,
  type OrgoDomainOffer,
  type OrgoRecordInput,
  type OrgoZone,
} from "./orgo";
import { loadOrgoKey, orgoOrigin } from "./orgo-auth";
import {
  applyBatch,
  batchSize,
  CF_WORDS,
  cfZones,
  CloudflareError,
  cloudflareScope,
  hostIn,
  ourId,
  ourRecords,
  planRecords,
  recordsAt,
  ZONE_ID,
  zoneFor,
  type CfZone,
  type CloudflareScope,
  type Wanted,
} from "./cloudflare";
import { onRunner, selfHosted } from "./persist";
import { isLabelOf, labelGiven, newLabel } from "./app-labels";
import { appFolder, authorOf, byBots, changesTo, dropToken, ensureIngotCli, folderChanges, hasToken, ingot, INGOT_BIN, INGOT_MCP, IngotError, ingotWorkspace, isRepoName, msOf, NO_PROJECT, readyFolder, repoNameFor, stillOurs, SWAPPED, type IngotChange, type IngotChangeset, type IngotRepo } from "./ingot";
import { addMessage, bot, flushState, getState, ownerName, sameState, session, update } from "./store";
import { tailnetUp } from "./tailnet";
import { closeForward, ForwardError, forwardOf, macPortBusy, openForward, type Carrier } from "./local-preview";
import { SshError, sshTunnel } from "./computer-ssh";
import { sharedOpen } from "./shared";

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
 *
 * Several bots of the workspace that work on its computer can work on one app at once (lib/hosted-apps.ts
 * appCoders), each in its own chat: its own bot in its working folder, as it always was, and each other one in a
 * copy of its own beside it, /workspace/apps/<name>.<copy> (copyFor; AppHosting.copies), made ready for its task
 * as the folder is (cloned the first time, else pulled: main merged into what it hasn't committed). Each commits to
 * main with `ingot commit`; one refused as stale pulls and commits again, and a conflict is that bot's to fix in its
 * own copy, so nothing uncommitted in one copy ever touches another. Each copy's sites have Locals of their own on
 * ports of their own (bops-local's <name>.<copy>--<site>), seen beside that bot's chat. The app keeps one home
 * computer and one Preview and one Published a site, deployed from main as ever.
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
export function held(ours: () => boolean) {
  if (!ours()) throw new HostedAppError(SWAPPED, 409);
}

const g = globalThis as unknown as {
  bopsHostingProbes?: Map<string, { at: number; why?: string }>;
  /** Work under way on each app ("<wsId>/<name>"): what it is, and when it's done (withApp). */
  bopsAppWork?: Map<string, { kind: AppWork; done: Promise<void> }>;
  /** Each workspace's repos as Ingot listed them last, and when: the Apps page reads them every few seconds while a deploy runs. */
  bopsIngotListed?: Map<string, { at: number; repos: IngotRepo[] }>;
  /** Domains being bought now ("<project>/<domain>"), from the app's tab or Settings: a second buy of one waits for none, it's refused (buyingOnce). */
  bopsDomainBuys?: Set<string>;
  /** Preview passwords being set now, by "<computer>/<public URL>" (passwordNow): a second ask waits for the first. */
  bopsPasswordsSetting?: Map<string, Promise<boolean | undefined>>;
  /** Until when a link Orgo turned a password down for isn't asked again, by the same key (passwordNow). */
  bopsPasswordRefused?: Map<string, number>;
};

/** A changeset's id: the sha256 of its canonical JSON. */
const CHANGESET = /^[0-9a-f]{64}$/;

/* (Exported pieces below are also used by workspace-domains.ts, Settings' Domains.) */

export const workspace = (wsId: string): Workspace | undefined => getState().workspaces?.find((w) => w.id === wsId);
const hostingOf = (wsId: string, name: string): AppHosting | undefined => workspace(wsId)?.hostedApps?.[name];
export const mainBot = (wsId: string) => getState().bots.find((b) => b.isMain && workspaceOf(b) === wsId);

/** The Orgo computer a bot's work runs on (its own, or the one it shares). */
export const computerOf = (botId: string) => {
  const b = bot(botId);
  return b ? workBot(b, getState().bots).computerId : undefined;
};

/**
 * Keep where an app is worked on and runs (Workspace.hostedApps), or drop it (`fn` answers undefined). The
 * computer it leaves, when no app of the workspace is on it anymore, has its token revoked (best effort).
 */
function keepHosting(wsId: string, name: string, fn: (h: AppHosting | undefined) => AppHosting | undefined) {
  let left: string | undefined;
  let moved: AppHosting | undefined;
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (!w) return;
    const prev = w.hostedApps?.[name];
    const was = prev?.computerId;
    const next = fn(w.hostedApps?.[name]);
    // Moved off a computer that's still there: its Preview projects there are kept with its Published ones (previewLeft).
    if (prev && next && !prev.lost && !next.lost && prev.computerId !== next.computerId) moved = prev;
    if (next) w.hostedApps = { ...(w.hostedApps ?? {}), [name]: next };
    else if (w.hostedApps?.[name]) {
      const { [name]: _gone, ...rest } = w.hostedApps;
      void _gone;
      w.hostedApps = rest;
    }
    if (was && !Object.values(w.hostedApps ?? {}).some((h) => h.computerId === was)) left = was;
  });
  if (left) void dropToken(wsId, left);
  if (moved) void previewLeft(wsId, name, moved).catch(() => {});
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
 * project, URL and Preview label copy in place of its own, and the site's name (the app's, for its own).
 */
type SiteHosting = AppHosting & { site: string };

/** The site `site` names of an app (none: its own); one the app doesn't have is a 404. */
function siteIn(h: AppHosting, name: string, site?: unknown): SiteHosting {
  if (site === undefined || site === null || site === "" || site === name) return { ...h, site: name };
  const s = typeof site === "string" ? h.sites?.find((x) => x.name === site) : undefined;
  if (!s) throw new HostedAppError(NO_SITE, 404);
  const { projectId: _project, url: _url, preview: _preview, passwordOff: _off, passwordSet: _set, ...rest } = h;
  void _project;
  void _url;
  void _preview;
  void _off;
  void _set;
  return { ...rest, ...keptOf(s), site: s.name };
}

/** An app's record for one of its sites (undefined: no such app). */
const hostingAt = (wsId: string, name: string, site?: unknown): SiteHosting | undefined => {
  const h = hostingOf(wsId, name);
  return h && siteIn(h, name, site);
};

/** Every site of an app, its own first, then the others in the order they were added. */
const sitesOf = (h: AppHosting, name: string): SiteHosting[] => [siteIn(h, name), ...(h.sites ?? []).map((s) => siteIn(h, name, s.name))];

/**
 * A site's Published deploy project, the URL an older Bops kept of it (never written now: Published lives on its
 * domains), its Preview label's copy, and its Preview password's choice and when it was set, as one change keeps them.
 */
type SiteKept = { projectId?: string; url?: string; preview?: string; passwordOff?: true; passwordSet?: PasswordSet };
const keptOf = (x: SiteKept): SiteKept => ({
  ...(x.projectId ? { projectId: x.projectId } : {}),
  ...(x.url ? { url: x.url } : {}),
  ...(x.preview ? { preview: x.preview } : {}),
  ...(x.passwordOff ? { passwordOff: true as const } : {}),
  ...(x.passwordSet ? { passwordSet: x.passwordSet } : {}),
});
/**
 * What a site's record keeps of its Local (heardLocals): its port there (only while it stays on that computer:
 * `port`) and the addresses told for Google sign in (Google's list doesn't change with the computer).
 */
const localKept = (x: { localPort?: number; toldGoogle?: string[] }, port = true) => ({
  ...(port && x.localPort ? { localPort: x.localPort } : {}),
  ...(x.toldGoogle?.length ? { toldGoogle: x.toldGoogle } : {}),
});

/**
 * Keep what of one site changed: its deploy project, URL, Preview label and password's, as `fn` answers them from
 * what's kept now. A site removed meanwhile (or the app) stays removed.
 */
function keepSite(wsId: string, name: string, site: string, fn: (s: SiteKept) => SiteKept) {
  keepHosting(wsId, name, (h) => {
    if (!h) return h;
    if (site === name) {
      const { projectId, url, preview, passwordOff, passwordSet, ...rest } = h;
      return { ...rest, ...keptOf(fn({ projectId, url, preview, passwordOff, passwordSet })) };
    }
    if (!h.sites?.some((x) => x.name === site)) return h;
    return { ...h, sites: h.sites.map((x) => (x.name === site ? { name: x.name, ...localKept(x), ...keptOf(fn(x)) } : x)) };
  });
}

/**
 * The app's record as it moves to `botId` and its computer: on the computer it's on already (not lost),
 * all it has stays, the bot changed (its other bots' copies too: one that had a copy keeps working in it); on
 * another one, only its sites' names, their Preview labels and whether the
 * owner turned their Preview password off come along (their deploy projects, variables and domains are the old
 * computer's; the Preview's link moves with its next deploy, with a password of its own: ensurePreview). The
 * deploy projects it leaves on a computer that's still there serve on as they were, so they're kept (behind) for
 * Remove app to take down; the ones on the computer it moves to are its again (prodIn and previewIn find them),
 * so they aren't.
 */
function movedTo(h: AppHosting | undefined, name: string, botId: string, computerId: string): AppHosting {
  const left: AppProjectBehind[] = [...(h?.behind ?? [])];
  const stays = !!h && !h.lost && h.computerId === computerId;
  if (h && !h.lost && !stays)
    for (const s of sitesOf(h, name)) if (s.projectId) left.push({ site: s.site, computerId: h.computerId, projectId: s.projectId });
  const behind = left.filter((x, i) => x.computerId !== computerId && left.findIndex((y) => y.projectId === x.projectId) === i);
  const more = behind.length ? { behind } : {};
  if (stays) return { botId, computerId, ...keptOf(h), ...localKept(h), ...(h.sites?.length ? { sites: h.sites } : {}), ...(h.copies?.length ? { copies: h.copies } : {}), ...more };
  return {
    botId,
    computerId,
    ...(h?.preview ? { preview: h.preview } : {}),
    ...(h?.passwordOff ? { passwordOff: true as const } : {}),
    ...(h ? localKept(h, false) : {}),
    ...(h?.sites?.length ? { sites: h.sites.map((x) => ({ name: x.name, ...(x.preview ? { preview: x.preview } : {}), ...(x.passwordOff ? { passwordOff: true as const } : {}), ...localKept(x, false) })) } : {}),
    ...more,
  };
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

/* ---------------- The bots that work on it, each in a copy of its own ---------------- */

/**
 * A bot's copy's name (its folder /workspace/apps/<name>.<copy>, its Locals bops-local's <name>.<copy>--<site>): its
 * id when that can be one (lib/hosted-apps.ts isCopyName: bots.ts freeBotId makes them so), else "b" and 12 hex
 * digits of its id's sha256.
 */
export const copyName = (botId: string) => (isCopyName(botId) ? botId : `b${createHash("sha256").update(botId).digest("hex").slice(0, 12)}`);

/**
 * Whether bot `botId` works on an app in a copy of its own rather than in its working folder: every bot but the app's
 * own (AppHosting.botId), and that one too when it had a copy before the app passed to it (AppHosting.copies).
 */
const ownCopy = (h: AppHosting, botId: string) => botId !== h.botId || !!h.copies?.includes(botId);

/**
 * The copy of an app a bot's Locals are in (copyName), or undefined for the app's own working folder: its own bot's,
 * and the one a bot that doesn't work on it (lib/hosted-apps.ts appCoders, copyBotOf) acts on, as before there were
 * copies.
 */
function copyFor(wsId: string, name: string, botId: string | undefined): string | undefined {
  return copyBotOf(getState(), wsId, name, botId) ? copyName(botId!) : undefined;
}

/** What bops-local takes for an app's working folder (its Locals' keys start with it): its name, or <name>.<copy>. */
const localWord = (name: string, copy?: string) => (copy ? `${name}.${copy}` : name);

/** The key of a site's Local's forward on this Mac (local-preview.ts): of the app's own folder, or of `copyBot`'s copy. */
const fwdKey = (wsId: string, name: string, site: string, copyBot?: string) => `${wsId}/${name}/${site}${copyBot ? `/${copyBot}` : ""}`;

/** A bot's task on an app works in a copy of its own from now on (AppHosting.copies), once its first one starts there. */
function keepCopy(wsId: string, name: string, botId: string) {
  keepHosting(wsId, name, (h) => (h && !h.lost && !h.copies?.includes(botId) ? { ...h, copies: [...(h.copies ?? []), botId] } : h));
}

/** A bot taken off an app's copies (gone, or working on another app now). */
function dropCopy(wsId: string, name: string, botId: string) {
  keepHosting(wsId, name, (h) => {
    if (!h?.copies?.includes(botId)) return h;
    const { copies, ...rest } = h;
    const left = copies.filter((x) => x !== botId);
    return left.length ? { ...rest, copies: left } : rest;
  });
}

/**
 * Locals of an app forgotten on its computer (bops-local forget: stopped, their files gone, their ports free): bot
 * `botId`'s copy's, or (none) its own folder's alone, and their previews on this Mac closed; best effort, never waking
 * a computer that sleeps. Folders stay: one may hold work nobody committed.
 */
async function forgetCopy(wsId: string, name: string, h: AppHosting, botId: string | undefined, ours: () => boolean) {
  for (const s of sitesOf(h, name)) closeForward(fwdKey(wsId, name, s.site, botId));
  if (await asleepNow(h.computerId).catch(() => true)) return;
  held(ours);
  await localTool(h.computerId, ours);
  await localBash(h.computerId, `${LOCAL_BIN} forget ${botId ? localWord(name, copyName(botId)) : `${name} only`}`, 60, ours);
  localRead.delete(`${wsId}/${name}`);
}

/**
 * A bot being deleted (remove.ts deleteBot), while it's still here: each app of its workspace it works on, on a
 * computer that stays (not its own, which goes with it), has the Locals of its folder (its copy, or the app's own
 * folder for the app's own bot) forgotten there, best effort; the folder stays, as it may hold work nobody committed.
 * It's taken off the app's copies, and the app stays with the bots that work on it still.
 */
export async function appsBotGone(botId: string): Promise<void> {
  const b = bot(botId);
  if (!b) return;
  const wsId = workspaceOf(b);
  const ours = sameState();
  for (const [name, h] of Object.entries(workspace(wsId)?.hostedApps ?? {})) {
    if (!isRepoName(name) || h.lost || h.computerId === b.computerId || !appCoders(getState(), wsId, name).includes(botId)) continue;
    const copy = ownCopy(h, botId);
    dropCopy(wsId, name, botId);
    await forgetCopy(wsId, name, h, copy ? botId : undefined, ours).catch((e: Error) => console.warn(`[hosted-apps] ${name}: ${b.name}'s Locals: ${e.message}`));
  }
}

/**
 * A bot that stopped working on an app (bot-groups.ts setBotSite: its Works on now another app's site, or none), not
 * the app's own bot (its folder is the app's): its copy's Locals there stopped and forgotten, best effort (its folder
 * stays), and it's taken off the app's copies. A task asked of it on the app later makes its copy ready again.
 */
export async function botLeftApp(botId: string, wsId: string, name: string): Promise<void> {
  const h = hostingOf(wsId, name);
  if (!h || h.lost || !isRepoName(name) || botId === h.botId) return;
  const ours = sameState();
  dropCopy(wsId, name, botId);
  await forgetCopy(wsId, name, h, botId, ours);
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

/** How old a list of the workspace's repos can be and still be said to a bot (reposAtHand). */
const AT_HAND_MS = 30 * 60_000;

/**
 * The workspace's repos as Bops last read them (reposOf), when that was in the last half hour, without asking Ingot:
 * what a bot's note says of them (hostedAppsLine) and what work_on_app takes by name (appWork), neither of which
 * waits on Ingot. Undefined when there's no such list at hand.
 */
function reposAtHand(wsId: string): IngotRepo[] | undefined {
  const kept = listed.get(wsId);
  return kept && Date.now() - kept.at < AT_HAND_MS ? kept.repos : undefined;
}

/**
 * As a bot's turn starts (chat.ts), the workspace's repos are read again from Ingot in the background when the list
 * kept is older than a few seconds, so the turn's note (hostedAppsLine) has them by the time it's written. Never
 * waited on: Ingot slow or down only means the note says nothing of them. Nothing for a workspace not on Orgo yet.
 */
export function readReposAhead(botId: string) {
  const b = bot(botId);
  const wsId = b ? workspaceOf(b) : undefined;
  if (wsId && workspace(wsId)?.orgoProjectId) void reposOf(wsId);
}

/* ---------------- Whether deploying can work ---------------- */

/** Why deploying can't work from this Bops before Orgo is asked (undefined: it can, as far as Bops knows). */
export async function closedHere(): Promise<string | undefined> {
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

/** The app's record as the window gets it: without the addresses an older Bops kept (Published shows its domains only). */
const shownHosting = (h: AppHosting): AppHosting => {
  const { url: _url, sites, ...rest } = h;
  void _url;
  return { ...rest, ...(sites ? { sites: sites.map(({ url: _u, ...x }) => (void _u, x)) } : {}) };
};

/**
 * One app as the Apps page shows it: its newest changeset as Ingot says (`on`: the workspace's repos, null
 * when Ingot can't say now), and each site's Published (found on its computer: prodIn, its record rewritten
 * when it names another) with its newest deploy, what it serves and its domains (its address is its first
 * active domain, never an orgo.dev name), and each site's Preview (its fixed link, what it serves), as orgo-web
 * says, with the app's left overs. Orgo isn't asked when deploying can't work here (`why`); `closed` hears why
 * Orgo says hosting isn't open. The computer's lists (projects, public URLs, custom domains) are read once for
 * one read of the page, however many apps and sites are on it.
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
  projectsOn: ProjectsOn = projectsReader(),
  urlsOn: UrlsOn = urlsReader(),
): Promise<HostedApp> {
  const repo = on?.find((r) => r.name === name);
  const base: HostedApp = { name, head: repo?.head ?? null, updatedAt: msOf(repo?.updated_at), hosting: shownHosting(h), serving: null, live: null, ...(on ? {} : { offline: true as const }) };
  let read = false;
  const all = sitesOf(h, name);
  // (Read alongside, not after; a list that can't be read leaves what it says unsaid.)
  const custom = why || h.lost ? Promise.resolve(null) : domainsOn(h.computerId);
  const found = why ? null : await previewsOf(wsId, name, h, projectsOn, urlsOn, ours).catch(() => null);
  held(ours);
  const views = await Promise.all(
    all.map(async (s): Promise<HostedSite> => {
      // (Its lists read: Published is what prodIn finds there, never a Preview its record may name. Unread: its record's.)
      const id = found ? found.places.get(s.site)?.prod?.id : s.projectId;
      const none = { ...siteBase(s), url: null, domain: null };
      if (why || !id || s.lost) return none;
      const [got, list] = await Promise.all([deploys.project(s.computerId, id).catch(() => null), custom]);
      held(ours);
      if (!got?.enabled) {
        if (got) closed(got.why);
        return none;
      }
      read = true;
      // (Found on its computer under another id than its record's: the record follows, so every Mac deploys the same one.)
      if (id !== s.projectId && ours()) keepSite(wsId, name, s.site, (x) => ({ ...x, projectId: id }));
      const domain = list ? firstDomain(list, got.value.port) : null;
      const d = newest(got.value);
      return { name: s.site, projectId: id, url: null, live: d ? liveOf(d, domain) : null, serving: servingOf(got.value), domain, ...(list ? { domains: siteDomains(list, got.value.port) } : {}) };
    }),
  );
  const withPreview = found ? views.map((v) => ({ ...v, preview: found.previews.get(v.name) ?? previewView(undefined) })) : views;
  // (Its record read again once Orgo was: a project or a label may have been kept meanwhile.)
  return {
    ...base,
    hosting: shownHosting(read || found ? (hostingOf(wsId, name) ?? h) : h),
    live: views[0].live,
    serving: views[0].serving,
    domain: views[0].domain ?? null,
    ...(views[0].domains ? { domains: views[0].domains } : {}),
    ...(withPreview.length > 1 ? { sites: withPreview } : {}),
    ...(withPreview[0].preview ? { preview: withPreview[0].preview } : {}),
    ...(found?.leftOver.length ? { leftOver: found.leftOver } : {}),
  };
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
  const projectsOn = projectsReader();
  const urlsOn = urlsReader();
  const apps = await Promise.all(kept.map(([name, h]) => appView(wsId, name, h, on, why, ours, (w) => (closed = w), domainsOn, projectsOn, urlsOn)));
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

/** The first port a new deploy project takes (Published's and Preview's): 3000 to 3099 are Local's (vm/bin/bops-local). */
const FIRST_PORT = 3100;

/** Ports a computer keeps for itself (orgo-web checkDeployPort), and Bops' own on the Mac: never one an app's project takes. */
const keptPort = (p: number) => p === 22 || p === 3210 || p === 3389 || p === 8080 || p === 9000 || (p >= 5900 && p <= 5999) || (p >= 6080 && p <= 6099);

/**
 * The first port from 3100 that no deploy project and no public URL on the computer has (a project on a
 * URL's port would take that URL as its own), nor any of `skip`.
 */
function freePort(projects: OrgoDeployProject[], urls: OrgoPublicUrl[], skip: Iterable<number> = []): number {
  const used = new Set<number>([...projects.flatMap((p) => (typeof p.port === "number" ? [p.port] : [])), ...urls.map((u) => u.port), ...skip]);
  let port = FIRST_PORT;
  while (used.has(port) || keptPort(port)) port++;
  return port;
}

/** The ports the computer's custom domains point at (best effort): a new project there would serve another app's domain. */
const domainPorts = (computerId: string) => domains.ofComputer(computerId).then((l) => (l.domains ?? []).map((d) => d.target_port).filter((x): x is number => typeof x === "number"), () => [] as number[]);

/** An app's Ingot repo as orgo-web's deploy runner takes it: "<project>/<name>" (409 when the workspace isn't on Orgo yet). */
function ingotRepo(wsId: string, name: string): string {
  try {
    return `${ingotWorkspace(wsId)}/${name}`;
  } catch (e) {
    throw e instanceof IngotError ? new HostedAppError(e.message, 409) : e;
  }
}

/** A deploy project that builds the app's repo. */
const ofRepo = (p: OrgoDeployProject, repo: string) => p.source === "ingot" && p.ingot_repo?.toLowerCase() === repo;

/* ---------------- Published (Prod): each site's own project, on its domains only ---------------- */

/**
 * The names a site's Staging project had in the builds before this one (<site>-staging, then -2 to -9 when
 * taken): such a project is a left over now (leftOversOf), never a site's Published.
 */
export function stagingName(site: string, n = 1): string {
  const base = site.length <= 22 ? site : `${site.slice(0, 17).replace(/-+$/, "")}-${createHash("sha256").update(site).digest("hex").slice(0, 4)}`;
  return `${base}-staging${n > 1 ? `-${n}` : ""}`;
}
export const isOldStaging = (project: string, site: string) => Array.from({ length: 9 }, (_, k) => stagingName(site, k + 1)).includes(project);

/** A name no site can have: one that ends as an old Staging project's does, so a legacy Published is never taken for one. */
const STAGING_LIKE = /-staging(-[2-9])?$/;

/** Whether a name is one of the app's sites' Preview labels (sealed for any site, or a site's own copy). */
const previewLike = (h: AppHosting, name: string, repo: string, label: string) =>
  sitesOf(h, name).some((x) => isLabelOf("preview", label, repo, x.site) || (!!x.preview && x.preview === label));

/**
 * A site's Published project among its computer's (`projects`, oldest first as orgo-web lists them), found the
 * same from any Mac: the oldest of the repo named with a Published label sealed for this site; else the one its
 * record names (Bops 0.0.32's and before: the live sites keep theirs), or one named as 0.0.32 named them
 * (deployName), when it's no site's Preview, no old Staging, and no other site's Published. Never the repo's
 * first project as such (that may be a Preview or a left over). Undefined: none, so ensureProd makes one.
 */
function prodIn(projects: OrgoDeployProject[], h: AppHosting, name: string, site: string, repo: string): OrgoDeployProject | undefined {
  const mine = projects.filter((p) => ofRepo(p, repo));
  const marked = mine.find((p) => isLabelOf("prod", p.name, repo, site));
  if (marked) return marked;
  const sites = sitesOf(h, name).map((x) => x.site);
  const fits = (p: OrgoDeployProject) =>
    !previewLike(h, name, repo, p.name) && !sites.some((x) => isOldStaging(p.name, x)) && !sites.some((x) => x !== site && isLabelOf("prod", p.name, repo, x));
  const record = siteIn(h, name, site).projectId;
  const byRecord = record ? mine.find((p) => p.id === record && fits(p)) : undefined;
  if (byRecord) return byRecord;
  const names = Array.from({ length: 9 }, (_, k) => deployName(site, k + 1));
  return mine.find((p) => names.includes(p.name) && fits(p));
}

/** The computer's deploy projects now, for a change (Orgo's refusals in words). */
async function projectsNow(computerId: string, ours: () => boolean): Promise<OrgoDeployProject[]> {
  const there = await deploys.projects(computerId).catch((e: unknown) => Promise.reject(refused(e)));
  held(ours);
  if (!there.enabled) throw new HostedAppError(there.why, 403);
  return there.value.projects ?? [];
}

/** The computer's public URLs now (none when public URLs aren't open there: a Preview's link then can't be made, said when it's tried). */
async function urlsNow(computerId: string, ours: () => boolean): Promise<{ urls: OrgoPublicUrl[]; list: OrgoPublicUrls | null }> {
  const r = await publicUrls.list(computerId).catch((e: unknown) => Promise.reject(refused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  return { urls: r.value.enabled ? (r.value.public_urls ?? []) : [], list: r.value };
}

/**
 * A site's Published project on the app's computer (prodIn), its record rewritten to it when it names another,
 * or made now when there's none (nothing deployed): named with a random Published label sealed for the site,
 * on the first port free from 3100, and with no public URL of its own (a Published site lives on its domains;
 * an orgo-web that doesn't know that flag gives it a random one, never shown). Made before a site's Preview is,
 * before a domain is connected, and on its first Local start, so a Bops 0.0.32 deploying it (which takes the
 * repo's oldest project when its record names none) always finds Published's. `env`: variables to make it
 * with, or to set on the one found.
 */
async function ensureProd(wsId: string, name: string, s: SiteHosting, ours: () => boolean, env?: Record<string, string>): Promise<SiteHosting & { projectId: string }> {
  const repo = ingotRepo(wsId, name);
  const projects = await projectsNow(s.computerId, ours);
  const all = hostingOf(wsId, name) ?? s;
  const found = prodIn(projects, all, name, s.site, repo);
  const keep = (id: string): SiteHosting & { projectId: string } => {
    if (id !== siteIn(all, name, s.site).projectId) keepSite(wsId, name, s.site, (x) => ({ ...x, projectId: id }));
    return { ...s, projectId: id };
  };
  if (found) {
    if (env && Object.keys(env).length) {
      const r = await deploys.env(s.computerId, found.id, env).catch((e: unknown) => Promise.reject(settingsRefused(e)));
      held(ours);
      if (!r.enabled) throw new HostedAppError(r.why, 403);
    }
    return keep(found.id);
  }
  const [urls, taken] = await Promise.all([urlsNow(s.computerId, ours).then((x) => x.urls, () => [] as OrgoPublicUrl[]), domainPorts(s.computerId)]);
  held(ours);
  const names = new Set(projects.map((p) => p.name));
  const ports: number[] = [...taken];
  for (let tries = 0; ; tries++) {
    let label = newLabel("prod", repo, s.site);
    while (names.has(label)) label = newLabel("prod", repo, s.site);
    const port = freePort(projects, urls, ports);
    const made = await deploys.create(s.computerId, { repo, name: label, port, publicUrl: false, ...(env && Object.keys(env).length ? { env } : {}) }).catch((e: unknown) => e as Error);
    held(ours);
    if (made instanceof OrgoError && tries < 5 && made.code === "NAME_TAKEN") names.add(label);
    else if (made instanceof OrgoError && tries < 5 && made.code === "PORT_TAKEN") ports.push(port);
    else if (made instanceof OrgoError && (made.code === "PROJECT_LIMIT" || made.code === "SERVICE_LIMIT"))
      throw new HostedAppError(`${bot(s.botId)?.name ?? "That bot"}'s computer already runs as many apps as one computer can. Remove a site or a left over first.`, 409);
    else if (made instanceof OrgoError && made.code === "INVALID_ENV") throw settingsRefused(made);
    else if (made instanceof Error) throw refused(made);
    else if (!made.enabled) throw new HostedAppError(made.why, 403);
    else {
      // The window reads the app again: it has a deploy project now.
      keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
      return keep(made.value.id);
    }
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
  opts: { at?: string; botId?: string; site?: unknown; ours?: () => boolean; env?: "preview" | "prod" } = {},
): Promise<{ app: HostedApp; deployment: OrgoDeployment; deployed: { site: string; deployment: OrgoDeployment; url: string | null }[]; said?: string }> {
  const ours = opts.ours ?? sameState();
  held(ours);
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  if (!isRepoName(name)) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  if (opts.at !== undefined && !CHANGESET.test(opts.at)) throw new HostedAppError("That isn't a changeset of it.", 400);
  const was = hostingOf(wsId, name);
  if (was && opts.site !== undefined) siteIn(was, name, opts.site);
  // (Published only through Publish and Apply variables, which name what it builds: promoteApp, reapplyApp.)
  return withApp(wsId, name, "deploy", () => (opts.env === "prod" ? sendDeploys(wsId, name, opts, ours) : sendPreview(wsId, name, opts, ours)));
}

const MOVED = "It moved to another computer as this was sent. Deploy it again.";

/**
 * Where a deploy of an app goes (Prod's or Staging's, both on its computer): the computer it's on, or for one
 * not kept yet, or whose computer is gone, its bot's (when that one's still in this workspace) or `botId`'s
 * or the main bot's, kept now; with Ingot set up there first when the workspace has no token on it yet (the
 * deploy runner exports the repo with it).
 */
async function homeFor(wsId: string, name: string, opts: { botId?: string }, ours: () => boolean): Promise<AppHosting> {
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
  return kept;
}

/** The app's record as it is now, for a deploy under way: one removed, whose computer went, or that moved meanwhile stops the rest. */
function stillOn(wsId: string, name: string, kept: AppHosting): AppHosting {
  const now = hostingOf(wsId, name);
  if (!now) throw new HostedAppError(NO_APP, 404);
  if (now.lost) throw new HostedAppError(LOST, 409);
  if (now.computerId !== kept.computerId) throw new HostedAppError(MOVED, 409);
  return now;
}

/**
 * What stopped a deploy of several sites partway (`one`, after the ones that `went`), as the window and the bot
 * read it: the rest isn't sent. `to`: where (" to Staging"), said after the sites' names.
 */
function partly(e: unknown, todo: number, went: string[], one: string, to = ""): unknown {
  const mine = e instanceof HostedAppError;
  if ((mine && e.message === SWAPPED) || todo === 1 || (!mine && !went.length)) return e;
  // (Not ours, as an OrgoTimeout: in words with the rest, as Orgo said it.)
  const words = mine ? e.message : String((e as Error)?.message || "Orgo didn't answer").replace(/\.?$/, ".");
  return new HostedAppError(
    `${went.length ? `Deploying ${went.join(" and ")}${to}, but not ${one}` : `Didn't deploy ${one}${to}`}: ${words}`,
    mine ? e.status : 502,
    { ...(mine ? e.extra : {}), ...(went.length ? { partial: true } : {}) },
  );
}

/** deployApp, with nothing else under way on the app (withApp). */
async function sendDeploys(
  wsId: string,
  name: string,
  opts: { at?: string; botId?: string; site?: unknown },
  ours: () => boolean,
): Promise<{ app: HostedApp; deployment: OrgoDeployment; deployed: { site: string; deployment: OrgoDeployment; url: string | null }[] }> {
  const kept = await homeFor(wsId, name, opts, ours);
  const todo = opts.site !== undefined ? [siteIn(hostingOf(wsId, name) ?? kept, name, opts.site)] : sitesOf(hostingOf(wsId, name) ?? kept, name);
  const deployed: { site: string; deployment: OrgoDeployment; url: string | null }[] = [];
  const queue = (x: SiteHosting) => deploys.deploy(x.computerId, x.projectId!, opts.at).catch((e: unknown) => e as Error);
  const still = () => stillOn(wsId, name, kept);
  for (const one of todo) {
    try {
      // (Its project as kept now: one its variables made meanwhile, say. A site removed meanwhile is skipped.)
      const now = still();
      if (one.site !== name && !now.sites?.some((x) => x.name === one.site)) continue;
      const cur = siteIn(now, name, one.site);
      let s: SiteHosting = await ensureProd(wsId, name, cur, ours);
      still();
      let got = await queue(s);
      held(ours);
      if (gone(got)) {
        // The project is gone on Orgo: found again, or made again, on the same computer.
        s = await ensureProd(wsId, name, { ...s, projectId: undefined }, ours);
        got = await queue(s);
        held(ours);
      }
      if (got instanceof Error) throw refused(got);
      if (!got.enabled) throw new HostedAppError(got.why, 403);
      deployed.push({ site: s.site, deployment: got.value, url: null });
    } catch (e) {
      // The ones that went are deploying, whatever stopped the rest: the window reads the app again.
      if (deployed.length && ours()) keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
      throw partly(e, todo.length, deployed.map((d) => d.site), one.site);
    }
  }
  if (!deployed.length) throw new HostedAppError(NO_SITE, 404);
  const app = await queued(wsId, name, kept, new Map(deployed.map((d) => [d.site, d.deployment])), opts.at);
  // (Published's address: its first active domain, never an orgo.dev name.)
  return { app, deployment: deployed[0].deployment, deployed: deployed.map((d) => ({ ...d, url: (d.site === name ? app.domain : app.sites?.find((x) => x.name === d.site)?.domain) ?? null })) };
}

/**
 * The app as it is once this Mac queued a deploy of it on Published (`done`: each site's, of changeset `at`):
 * a window showing it reads it again. What a site deployed now serves meanwhile isn't in this answer: the
 * window keeps what it read last (null here). Of an app with more sites, the ones not deployed now are as
 * Orgo says, and every site's Preview too.
 */
async function queued(wsId: string, name: string, h: AppHosting, done: Map<string, OrgoDeployment>, at?: string): Promise<HostedApp> {
  keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
  const now = hostingOf(wsId, name) ?? h;
  const ours = sameState();
  const app = await appView(wsId, name, now, await reposOf(wsId), undefined, ours, () => {}, domainsReader());
  const head = app.head;
  const mark = (v: HostedSite): HostedSite => {
    const d = done.get(v.name);
    return d ? { ...v, live: { ...liveOf(d, v.domain ?? null), at: deployedAt(d) ?? at ?? head, state: d.state ?? "queued", when: msOf(d.created_at) ?? Date.now() } } : v;
  };
  const own = mark({ name, projectId: app.hosting?.projectId ?? null, url: null, serving: app.serving, live: app.live, domain: app.domain ?? null });
  return { ...app, live: own.live, ...(app.sites ? { sites: app.sites.map(mark) } : {}) };
}

/* ---------------- Preview: one deploy project of each site, at a fixed link of its own ---------------- */

/** The app's Ingot repo as its projects name it, or null when the workspace isn't on Orgo yet (nothing of it can be on one). */
const repoOrNull = (wsId: string, name: string) => {
  try {
    return ingotRepo(wsId, name);
  } catch {
    return null;
  }
};

/** How long one read of the Apps page waits for a computer's lists (projects, public URLs): past it, Previews are unsaid. */
const READ_MS = 5000;

/** Each computer's deploy projects, read once for one read of the Apps page however many apps and sites are on it (null: Orgo couldn't say in time). */
type ProjectsOn = (computerId: string) => Promise<OrgoDeployProject[] | null>;
function projectsReader(): ProjectsOn {
  const read = new Map<string, Promise<OrgoDeployProject[] | null>>();
  return (computerId) => {
    let list = read.get(computerId);
    if (!list) read.set(computerId, (list = within(deploys.projects(computerId).then((r) => (r.enabled ? (r.value.projects ?? []) : null), () => null), READ_MS)));
    return list;
  };
}

/** Each computer's public URLs, read once for one read of the Apps page (null: Orgo couldn't say in time; none when they aren't open there). */
type UrlsOn = (computerId: string) => Promise<OrgoPublicUrl[] | null>;
function urlsReader(): UrlsOn {
  const read = new Map<string, Promise<OrgoPublicUrl[] | null>>();
  return (computerId) => {
    let list = read.get(computerId);
    if (!list) read.set(computerId, (list = within(publicUrls.list(computerId).then((r) => (r.enabled ? (r.value.enabled ? (r.value.public_urls ?? []) : []) : null), () => null), READ_MS)));
    return list;
  };
}

/**
 * The label a site's Preview is known by besides its seal: its state copy (one sealed for it, or a name the owner
 * chose ahead, which has no seal); or, that copy lost (a Bops 0.0.32 kept its whole record), for an app with one
 * site, the one project of its repo named like a chosen name (12 letters and digits, the first a letter) that's
 * no Published, with a public URL of the same name: found again, so its link never changes.
 */
function knownLabel(s: SiteHosting, all: AppHosting, name: string, repo: string, projects: OrgoDeployProject[], urls: OrgoPublicUrl[]): string | undefined {
  const copy = s.preview;
  if (copy && (isLabelOf("preview", copy, repo, s.site) || labelGiven(copy) === copy)) return copy;
  if (sitesOf(all, name).length !== 1) return undefined;
  const legacy = Array.from({ length: 9 }, (_, k) => deployName(s.site, k + 1));
  return projects.find(
    (p) =>
      ofRepo(p, repo) &&
      labelGiven(p.name) === p.name &&
      p.id !== s.projectId &&
      !legacy.includes(p.name) &&
      !isLabelOf("prod", p.name, repo, s.site) &&
      urls.some((u) => u.label === p.name),
  )?.name;
}

/** A site's Preview as found on its computer: its public URL (the link), its deploy project, and its label. */
type PreviewFound = { url?: OrgoPublicUrl; project?: OrgoDeployProject; label: string };

/**
 * A site's Preview among its computer's projects and public URLs, found by its label's seal (or `known`):
 * the oldest marked URL, with the project named as it (maybe none: made again); else the oldest marked project
 * (its link made again). Any other marked one (two Macs at once) is a left over; nothing is deleted on its own.
 */
function previewIn(projects: OrgoDeployProject[], urls: OrgoPublicUrl[], repo: string, site: string, known?: string): PreviewFound | undefined {
  const is = (label: string) => isLabelOf("preview", label, repo, site) || (!!known && label === known);
  const us = urls.filter((u) => is(u.label)).sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
  const ps = projects.filter((p) => ofRepo(p, repo) && is(p.name));
  if (us[0]) return { url: us[0], project: ps.find((p) => p.name === us[0].label), label: us[0].label };
  if (ps[0]) return { project: ps[0], label: ps[0].name };
  return undefined;
}

/**
 * A site's Preview as the window shows it (`p`: its project as read on its own, with its deploys; `pass`: whether its
 * link asks for a password now, and when Bops set it last).
 */
const previewView = (f: PreviewFound | undefined, p?: OrgoDeployProject | null, pass?: { on?: boolean; at?: number }): PreviewSite => {
  const project = p ?? f?.project;
  if (!f) return { projectId: null, url: null, label: null, serving: null, live: null };
  const url = f.url?.url ?? null;
  const d = project ? newest(project) : undefined;
  return {
    projectId: project?.id ?? null,
    url,
    label: f.label,
    serving: project ? servingOf(project) : null,
    live: d ? liveOf(d, url) : null,
    ...(f.url?.disabled ? { off: true as const } : {}),
    ...(typeof pass?.on === "boolean" ? { protected: pass.on } : {}),
    ...(pass?.at ? { passwordAt: pass.at } : {}),
  };
};

/** What a site's Preview and Published are on its computer, read from its lists once. */
type SitePlaces = { prod?: OrgoDeployProject; preview?: PreviewFound };

/** Every site's Published and Preview of an app on its computer, from its lists (prodIn, previewIn). */
function placesOf(h: AppHosting, name: string, repo: string, projects: OrgoDeployProject[], urls: OrgoPublicUrl[]): Map<string, SitePlaces> {
  const out = new Map<string, SitePlaces>();
  for (const s of sitesOf(h, name)) out.set(s.site, { prod: prodIn(projects, h, name, s.site, repo), preview: previewIn(projects, urls, repo, s.site, knownLabel(s, h, name, repo, projects, urls)) });
  return out;
}

/**
 * The app's left overs on its computer (HostedApp.leftOver): projects of its repo that are no site's Published or
 * Preview and not ones it left on another computer, and marked Preview URLs that are no site's. They come from an
 * older Bops (a <site>-staging, a <site> made when its record lost Published's id) or two Macs at once. Bops never
 * deploys to them, and removes one only when the user says so (removeLeftOver).
 */
function leftOversOf(h: AppHosting, name: string, repo: string, projects: OrgoDeployProject[], urls: OrgoPublicUrl[], places: Map<string, SitePlaces>): LeftOver[] {
  const used = new Set<string>();
  const usedUrls = new Set<string>();
  for (const x of places.values()) {
    if (x.prod) used.add(x.prod.id);
    if (x.preview?.project) used.add(x.preview.project.id);
    if (x.preview?.url) usedUrls.add(x.preview.url.id);
  }
  for (const b of h.behind ?? []) used.add(b.projectId);
  const out: LeftOver[] = [];
  for (const p of projects) {
    if (!ofRepo(p, repo) || used.has(p.id)) continue;
    const own = urls.find((u) => u.port === p.port);
    if (own) usedUrls.add(own.id);
    out.push({ id: p.id, name: p.name, port: typeof p.port === "number" ? p.port : null, url: own?.url ?? p.url ?? null });
  }
  for (const u of urls) if (!usedUrls.has(u.id) && previewLike(h, name, repo, u.label)) out.push({ id: `url:${u.id}`, name: u.label, port: u.port, url: u.url });
  return out;
}

/**
 * Every site's Preview of an app, by site, as the Apps page shows it, and its left overs: found in its computer's
 * lists, then each Preview project read on its own (the list carries only the computer's newest few deploys, so
 * what one serves is read from its own), and its password as it should be (passwordNow: one set when its link has
 * none, a new one once another deploy went live there). Null when Orgo couldn't say.
 */
async function previewsOf(
  wsId: string,
  name: string,
  h: AppHosting,
  on: ProjectsOn,
  urlsOn: UrlsOn,
  ours: () => boolean = () => true,
): Promise<{ previews: Map<string, PreviewSite>; places: Map<string, SitePlaces>; leftOver: LeftOver[] } | null> {
  const repo = repoOrNull(wsId, name);
  if (!repo || h.lost) return null;
  const [list, urls] = await Promise.all([on(h.computerId), urlsOn(h.computerId)]);
  if (!list) return null;
  const places = placesOf(h, name, repo, list, urls ?? []);
  const previews = new Map<string, PreviewSite>();
  await Promise.all(
    sitesOf(h, name).map(async (s) => {
      const f = places.get(s.site)?.preview;
      const got = f?.project ? await within(deploys.project(h.computerId, f.project.id).then((r) => (r.enabled ? r.value : null), () => null), READ_MS) : null;
      const live = (got ?? f?.project)?.current?.id ?? null;
      const on = f?.url && ours() ? await within(passwordNow(wsId, name, s.site, h.computerId, f.url, live, ours), READ_MS) : undefined;
      previews.set(s.site, previewView(f, got, { on: on ?? f?.url?.protected, at: passwordAtOf(wsId, name, s.site) }));
    }),
  );
  // (Its own label kept as a copy, once, when Orgo says one its record doesn't have.)
  for (const s of sitesOf(h, name)) {
    const label = places.get(s.site)?.preview?.label;
    if (label && label !== s.preview && urls && ours()) keepSite(wsId, name, s.site, (x) => ({ ...x, preview: label }));
  }
  return { previews, places, leftOver: urls ? leftOversOf(h, name, repo, list, urls, places) : [] };
}

/** The variables a new Preview project starts with, so its sign in is at its own link (each the user's to change after). */
const seedsFor = (url: string, given?: Record<string, string>): Record<string, string> => ({
  AUTH_URL: url,
  NEXTAUTH_URL: url,
  BETTER_AUTH_URL: url,
  AUTH_TRUST_HOST: "true",
  ...(given ?? {}),
});

/** The sign in variables a project has none of yet (AUTH_URL, NEXTAUTH_URL, BETTER_AUTH_URL), set to `url`; never one the user set. */
async function seedAuth(computerId: string, p: OrgoDeployProject, url: string, ours: () => boolean) {
  const has = new Set(p.env_keys ?? []);
  if (has.has("AUTH_URL") || has.has("NEXTAUTH_URL") || has.has("BETTER_AUTH_URL")) return;
  const r = await deploys.env(computerId, p.id, seedsFor(url)).catch(() => null);
  held(ours);
  void r;
}

const PREVIEW_WORDS = {
  urlLimit: "Its computer has as many public links as Orgo allows. Remove a site or a left over first.",
  accountLimit: (n: unknown) => `Your Orgo account has as many public links as it allows${typeof n === "number" ? ` (${n})` : ""}.`,
  noLink: "Couldn't get a link for its preview. Try again in a minute.",
  changed: (url: string) => `Its preview link changed to ${url}, as the old one was taken. Add it to Google sign in.`,
  noRoom: (bot: string, site: string) => `${bot}'s computer has no room for ${site}'s preview: it runs as many deploys as Orgo allows. Remove a site or a left over first.`,
};

/** A public URL create Orgo turned down for good (caps, not open here), in words; undefined for one to try again with another name or port. */
function linkRefused(e: unknown): HostedAppError | undefined {
  if (!(e instanceof OrgoError)) return undefined;
  if (e.code === "PUBLIC_URL_LIMIT") return new HostedAppError(PREVIEW_WORDS.urlLimit, 409, { code: e.code });
  if (e.code === "PUBLIC_URL_ACCOUNT_LIMIT") return new HostedAppError(PREVIEW_WORDS.accountLimit(e.answer?.limit), 409, { code: e.code });
  if (e.code === "LABEL_TAKEN" || e.code === "INVALID_LABEL" || e.code === "PORT_TAKEN") return undefined;
  return refused(e) as HostedAppError;
}

/**
 * A site's Preview on the app's computer, made when it has none (with nothing else under way on the app:
 * withApp), after its Published project (`prod`, made first: ensureProd). Its link comes first: a public URL
 * with its label (made before the project, so orgo-web's first deploy adopts it and never owns it: removing
 * the project leaves it), then the project, named with the same label, on the URL's port. Found again by its
 * seal, so one half gone heals: a URL with no project gets the project again on its port; a project with no URL
 * gets its URL again with its name. One on another computer of the workspace (the app moved) moves here with its
 * label; else its state copy's label is used again; else a new one. A label someone took meanwhile gets a new one,
 * said in `said` (the user adds the new link to Google sign in). `given`: a name the owner chose ahead, used when
 * the site has no Preview yet (once it has one, its name never changes). `env`: the user's variables to make it
 * with, on top of the sign in seeds (seedsFor). Its link has a password once it's there (passwordNow), unless the
 * owner turned it off.
 */
async function ensurePreview(
  wsId: string,
  name: string,
  prod: SiteHosting & { projectId: string },
  ours: () => boolean,
  opts: { env?: Record<string, string>; given?: string } = {},
): Promise<{ project: OrgoDeployProject; url: OrgoPublicUrl; said?: string; made: boolean }> {
  const repo = ingotRepo(wsId, name);
  const c = prod.computerId;
  const projects = await projectsNow(c, ours);
  const { urls } = await urlsNow(c, ours);
  const all = hostingOf(wsId, name) ?? prod;
  const s = siteIn(all, name, prod.site);
  const found = previewIn(projects, urls, repo, prod.site, knownLabel(s, all, name, repo, projects, urls));
  const prodPort = projects.find((p) => p.id === prod.projectId)?.port;
  // (Never Published's port, nor one a custom domain points at: a project there would serve that domain.)
  const skip = [...(typeof prodPort === "number" ? [prodPort] : []), ...(await domainPorts(c))];
  held(ours);
  const fromProd = projects.find((p) => p.id === prod.projectId);
  const keepLabel = (label: string) => {
    if (siteIn(hostingOf(wsId, name) ?? all, name, prod.site).preview !== label) keepSite(wsId, name, prod.site, (x) => ({ ...x, preview: label }));
  };
  if (opts.given && found && found.label !== opts.given)
    throw new HostedAppError(`Its preview is at ${found.url?.url ?? found.label} already, and its link never changes.`, 409, { code: "PREVIEW_NAMED" });
  /** What it answers, its link's password set first when it has none (best effort). */
  const locked = async <T extends { project: OrgoDeployProject; url: OrgoPublicUrl }>(r: T): Promise<T> => {
    await passwordNow(wsId, name, prod.site, c, r.url, r.project.current?.id ?? null, ours);
    return r;
  };
  /** Its project made on `port` with `label`, seeded, built as Published builds (a legacy Published's commands copied once). */
  const makeProject = async (label: string, url: OrgoPublicUrl): Promise<OrgoDeployProject | "name" | "port"> => {
    const env = seedsFor(url.url, opts.env);
    const made = await deploys.create(c, { repo, name: label, port: url.port, env }).catch((e: unknown) => e as Error);
    held(ours);
    if (made instanceof OrgoError && made.code === "NAME_TAKEN") return "name";
    if (made instanceof OrgoError && made.code === "PORT_TAKEN") return "port";
    if (made instanceof OrgoError && (made.code === "PROJECT_LIMIT" || made.code === "SERVICE_LIMIT")) throw new HostedAppError(PREVIEW_WORDS.noRoom(bot(prod.botId)?.name ?? "That bot", prod.site), 409, { code: made.code });
    if (made instanceof OrgoError && made.code === "INVALID_ENV") throw settingsRefused(made);
    if (made instanceof Error) throw refused(made);
    if (!made.enabled) throw new HostedAppError(made.why, 403);
    // Published's commands set by hand (a legacy one's, or ones saved before its first deploy): its Preview builds the same way to start with.
    if (fromProd) {
      const patch: Parameters<typeof deploys.change>[2] = {};
      if (fromProd.install_cmd) patch.install_cmd = fromProd.install_cmd;
      if (fromProd.build_cmd) patch.build_cmd = fromProd.build_cmd;
      if (fromProd.start_cmd) patch.start_cmd = fromProd.start_cmd;
      if (typeof fromProd.health_path === "string" && fromProd.health_path !== "/") patch.health_path = fromProd.health_path;
      if (Object.keys(patch).length) {
        const r = await deploys.change(c, made.value.id, patch).catch(() => null);
        held(ours);
        if (r?.enabled) return r.value;
      }
    }
    return made.value;
  };
  /** Its project made on its URL's port, the URL moved to a free port when an app on the computer holds that one. */
  const projectOn = async (label: string, url: OrgoPublicUrl): Promise<OrgoDeployProject> => {
    let u = url;
    const used = [...skip];
    for (let tries = 0; tries < 5; tries++) {
      const p = await makeProject(label, u);
      if (p === "name") {
        // Only its own, from a try that stopped halfway: read again and taken as it is.
        const again = (await projectsNow(c, ours)).find((x) => x.name === label && ofRepo(x, repo));
        if (again) return again;
        throw new HostedAppError(PREVIEW_WORDS.noLink, 409);
      }
      if (p !== "port") return p;
      used.push(u.port);
      const port = freePort(projects, urls, used);
      const moved = await publicUrls.port(c, u.id, port).catch((e: unknown) => Promise.reject(refused(e)));
      held(ours);
      if (!moved.enabled) throw new HostedAppError(moved.why, 403);
      u = moved.value;
    }
    throw new HostedAppError(PREVIEW_WORDS.noLink, 409);
  };
  // Both there: it's made.
  if (found?.url && found.project) {
    keepLabel(found.label);
    return locked({ project: found.project, url: found.url, made: false });
  }
  // Its link there, its project gone (removed on Orgo's own pages): made again on the link's port.
  if (found?.url) {
    const project = await projectOn(found.label, found.url);
    keepLabel(found.label);
    return locked({ project, url: found.url, made: true });
  }
  let said: string | undefined;
  // Its project there, its link gone: made again with the project's name.
  if (found?.project) {
    const p = found.project;
    const r = await publicUrls.create(c, typeof p.port === "number" ? p.port : freePort(projects, urls, skip), p.name).catch((e: unknown) => e as Error);
    held(ours);
    if (!(r instanceof Error) && r.enabled) {
      keepLabel(p.name);
      return locked({ project: p, url: r.value, made: true });
    }
    if (!(r instanceof Error)) throw new HostedAppError(r.why, 403);
    const no = linkRefused(r);
    if (no) throw no;
    // Its name taken meanwhile: that project is a left over now, and a new pair is made below with a new label.
    said = "changed";
  }
  // None on this computer: its label chosen, then its link and its project made.
  let label: string | undefined = opts.given;
  let fromOld = false;
  if (!label && !said) {
    const moved = await previewElsewhere(wsId, name, all, prod.site, repo, c, ours);
    if (moved) {
      label = moved.label;
      fromOld = true;
    }
  }
  if (!label && !said && s.preview && (isLabelOf("preview", s.preview, repo, prod.site) || labelGiven(s.preview) === s.preview)) {
    label = s.preview;
    fromOld = true;
  }
  const ports = [...skip];
  for (let tries = 0; tries < 6; tries++) {
    const l = label ?? newLabel("preview", repo, prod.site);
    const port = freePort(projects, urls, ports);
    const r = await publicUrls.create(c, port, l).catch((e: unknown) => e as Error);
    held(ours);
    if (!(r instanceof Error) && !r.enabled) throw new HostedAppError(r.why, 403);
    if (r instanceof Error) {
      const no = linkRefused(r);
      if (no) throw no;
      if (r instanceof OrgoError && r.code === "PORT_TAKEN") {
        // (The same label on the next port: a name is spent only once it's taken.)
        ports.push(port);
        label = l;
      } else {
        // Taken, or a name Orgo keeps: a new one (a name chosen ahead is said, as its link isn't that one).
        if (label && (fromOld || opts.given)) said = "changed";
        if (opts.given && r instanceof OrgoError && r.code === "LABEL_TAKEN") throw new HostedAppError(`The name ${opts.given} is taken on Orgo. Pick another.`, 409, { code: "LABEL_TAKEN" });
        if (opts.given) throw new HostedAppError(`Orgo can't take ${opts.given} as a link's name. Pick another.`, 400, { code: "INVALID_LABEL" });
        label = undefined;
      }
      continue;
    }
    const url = r.value;
    const project = await projectOn(l, url).catch(async (e: unknown) => {
      // (Its link, new and never shown, isn't left behind for a project that couldn't be made.)
      if (!(e instanceof HostedAppError && e.message === SWAPPED)) await publicUrls.remove(c, url.id).catch(() => null);
      throw e;
    });
    keepLabel(l);
    return locked({ project, url, made: true, ...(said ? { said: PREVIEW_WORDS.changed(url.url) } : {}) });
  }
  throw new HostedAppError(PREVIEW_WORDS.noLink, 409);
}

/**
 * A site's Preview link left on another computer of the workspace (the app moved: the computers it left first,
 * then every other one its bots use), moved here with its label: removed there, then made here at once. If this
 * computer can't take it, it's put back there. Undefined: none, or it couldn't be moved (a new one is made).
 */
async function previewElsewhere(wsId: string, name: string, h: AppHosting, site: string, repo: string, here: string, ours: () => boolean): Promise<{ label: string } | undefined> {
  const others = [
    ...new Set([
      ...(h.behind ?? []).map((b) => b.computerId),
      ...getState()
        .bots.filter((b) => workspaceOf(b) === wsId)
        .flatMap((b) => computerOf(b.id) ?? []),
    ]),
  ].filter((x) => x !== here);
  const s = siteIn(h, name, site);
  for (const c of others) {
    const r = await publicUrls.list(c).catch(() => null);
    held(ours);
    if (!r?.enabled || !r.value.enabled) continue;
    const u = (r.value.public_urls ?? []).find((x) => isLabelOf("preview", x.label, repo, site) || (!!s.preview && x.label === s.preview));
    if (!u || u.disabled) continue;
    const gone = await publicUrls.remove(c, u.id).catch(() => null);
    held(ours);
    if (!gone?.enabled) continue;
    return { label: u.label };
  }
  return undefined;
}

/**
 * deployApp to the Preview (with nothing else under way on the app: withApp): changeset `at` (the newest on main
 * by default) of every site, one after another, or the one `site` names, each on its Preview project on the app's
 * computer (made the first time, after Published's: ensureProd, ensurePreview). Published is never touched.
 * Answers the app as it is now, and each site's link.
 */
async function sendPreview(
  wsId: string,
  name: string,
  opts: { at?: string; botId?: string; site?: unknown },
  ours: () => boolean,
): Promise<{ app: HostedApp; deployment: OrgoDeployment; deployed: { site: string; deployment: OrgoDeployment; url: string | null }[]; said?: string }> {
  const kept = await homeFor(wsId, name, opts, ours);
  const base = hostingOf(wsId, name) ?? kept;
  const todo = (opts.site !== undefined ? [siteIn(base, name, opts.site)] : sitesOf(base, name)).map((x) => x.site);
  const deployed: { site: string; deployment: OrgoDeployment; url: string | null }[] = [];
  const said: string[] = [];
  for (const site of todo) {
    try {
      const now = stillOn(wsId, name, kept);
      if (site !== name && !now.sites?.some((x) => x.name === site)) continue;
      const prod = await ensureProd(wsId, name, siteIn(now, name, site), ours);
      stillOn(wsId, name, kept);
      let pv = await ensurePreview(wsId, name, prod, ours);
      if (pv.said) said.push(pv.said);
      stillOn(wsId, name, kept);
      if (!pv.made) await seedAuth(prod.computerId, pv.project, pv.url.url, ours);
      let got = await deploys.deploy(prod.computerId, pv.project.id, opts.at).catch((e: unknown) => e as Error);
      held(ours);
      if (gone(got)) {
        // Its Preview project is gone on Orgo: made again, on its link's port.
        pv = await ensurePreview(wsId, name, prod, ours);
        got = await deploys.deploy(prod.computerId, pv.project.id, opts.at).catch((e: unknown) => e as Error);
        held(ours);
      }
      if (got instanceof Error) throw refused(got);
      if (!got.enabled) throw new HostedAppError(got.why, 403);
      deployed.push({ site, deployment: got.value, url: pv.url.url });
    } catch (e) {
      if (deployed.length && ours()) keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
      throw partly(e, todo.length, deployed.map((d) => d.site), site, " to its preview");
    }
  }
  if (!deployed.length) throw new HostedAppError(NO_SITE, 404);
  keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
  const app = await appNow(wsId, name, ours);
  return { app, deployment: deployed[0].deployment, deployed, ...(said.length ? { said: said.join(" ") } : {}) };
}

/**
 * A site's Preview project as orgo-web has it now (null: none yet), read for what's asked of it (logs, settings,
 * variables, a rollback), with Published's project as the computer lists it (for its variables' names).
 */
async function previewOf(
  wsId: string,
  name: string,
  ours: () => boolean,
  site?: unknown,
): Promise<{ h: SiteHosting & { projectId: string }; p: OrgoDeployProject; prod: OrgoDeployProject | undefined } | null> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingAt(wsId, name, site) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (h.lost) return null;
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const repo = ingotRepo(wsId, name);
  const list = await projectsNow(h.computerId, ours);
  const { urls } = await urlsNow(h.computerId, ours).catch(() => ({ urls: [] as OrgoPublicUrl[] }));
  const all = hostingOf(wsId, name) ?? h;
  const found = previewIn(list, urls, repo, h.site, knownLabel(h, all, name, repo, list, urls));
  if (!found?.project) return null;
  const p = await deploys.project(h.computerId, found.project.id).catch((e: unknown) => Promise.reject(refused(e)));
  held(ours);
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  return { h: { ...h, projectId: found.project.id, ...(found.url ? { url: found.url.url } : {}) }, p: p.value, prod: prodIn(list, all, name, h.site, repo) };
}

/* ---------------- Its Preview's password ---------------- */

/*
 * Each site's Preview asks for a password (orgo-web's gate on its public URL: a browser without its cookie gets a
 * password page first), unless the owner turned it off for that site (AppHosting.passwordOff). Bops sets one as soon
 * as the link exists or is found without one, on any Mac (passwordNow: ensurePreview, and each read of the Apps page),
 * and a new one once each Preview deploy goes live (its live deploy is another than the one the last was set with:
 * AppHosting.passwordSet); a deploy that fails or stops leaves it as it was, and Published never has one. Orgo keeps
 * the password: Bops keeps only the owner's choice and when it set one. A link Orgo can't tell about (`protected`
 * absent: an orgo-web from before passwords) is left alone, and one Orgo can't put a password on yet (503
 * PASSWORD_UNAVAILABLE, before its migration) or that the user's key can't change (403) is left alone for an hour,
 * so nothing is tried again and again. The password is the owner's to see beside the link, in the window alone
 * (PreviewPassword), and members' the owner gave Your Apps at Write (lib/server/apps-for-members.ts): never in a
 * bot's chat or prompt.
 */

/** A Preview password's characters: letters and digits, without the ones that look alike (0, O, o, 1, l, I). */
const PASSWORD_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // gitleaks:allow (an alphabet, not a key)
export const PASSWORD_LENGTH = 7;

/** A new Preview password: PASSWORD_LENGTH random characters of PASSWORD_ABC, case sensitive, at least one a letter and one a digit. */
export function newPassword(rand: (n: number) => number = (n) => randomInt(n)): string {
  const ok = (p: string) => /[A-Za-z]/.test(p) && /[2-9]/.test(p);
  let p = "";
  for (let tries = 0; tries < 100 && !ok(p); tries++) p = Array.from({ length: PASSWORD_LENGTH }, () => PASSWORD_ABC[rand(PASSWORD_ABC.length)]).join("");
  // (A random source that never gives both: a letter and a digit put first.)
  return ok(p) ? p : `a2${p.slice(2)}`;
}

const settingPassword = (g.bopsPasswordsSetting ??= new Map<string, Promise<boolean | undefined>>());
const passwordRefused = (g.bopsPasswordRefused ??= new Map<string, number>());
/**
 * How long after Orgo turned a password down it isn't asked again (each read of the Apps page would ask): a few
 * minutes, or an hour when it can't take one yet (PASSWORD_UNAVAILABLE) or the key can't change it (403).
 */
const PASSWORD_AGAIN_MS = 5 * 60_000;
const PASSWORD_LATER_MS = 60 * 60_000;
/** Orgo can't put a password on a link yet: before its migration (503 PASSWORD_UNAVAILABLE), or the user's key can't (403). */
const passwordUnavailable = (e: unknown) => e instanceof OrgoError && ((e.status === 503 && e.code === "PASSWORD_UNAVAILABLE") || e.status === 403);

/** A site's record as kept now (undefined: the app or the site is gone, or it's lost its computer). */
const siteNow = (wsId: string, name: string, site: string, computerId: string) => {
  const h = hostingOf(wsId, name);
  return h && !h.lost && h.computerId === computerId ? sitesOf(h, name).find((x) => x.site === site) : undefined;
};

/** One change to a Preview link's password at a time (by its computer and URL): `fn` waits for any under way, then what reads ask meanwhile waits for it. */
async function onePassword<T extends boolean | undefined>(key: string, fn: () => Promise<T>, meanwhile: boolean | undefined): Promise<T> {
  for (let was = settingPassword.get(key); was; was = settingPassword.get(key)) await was.catch(() => undefined);
  const run = fn();
  const shown = run.catch(() => meanwhile);
  settingPassword.set(key, shown);
  try {
    return await run;
  } finally {
    if (settingPassword.get(key) === shown) settingPassword.delete(key);
  }
}

/**
 * A site's Preview password as it should be now, from its link as Orgo listed it (`url`) and the deploy live on its
 * Preview (`live`: its project's current one, null: none): one set when Orgo says the link has none, a new one when
 * another deploy went live since the last was set (passwordSet), the record kept. Nothing when the owner turned it
 * off, Orgo can't tell, Orgo turned its link off, or Orgo turned a set down lately (PASSWORD_AGAIN_MS, or
 * PASSWORD_LATER_MS). Answers whether the link asks for one now (undefined: Orgo can't tell). Best effort: it never
 * throws.
 */
async function passwordNow(wsId: string, name: string, site: string, computerId: string, url: OrgoPublicUrl, live: string | null, ours: () => boolean): Promise<boolean | undefined> {
  const key = `${computerId}/${url.id}`;
  const was = settingPassword.get(key);
  if (was) return was;
  if (typeof url.protected !== "boolean") return undefined;
  const s = siteNow(wsId, name, site, computerId);
  if (!s || s.passwordOff || url.disabled || !ours()) return url.protected;
  if (url.protected) {
    // (One set before Bops kept when: taken as set for what's live now.)
    if (!s.passwordSet) keepSite(wsId, name, site, (x) => ({ ...x, passwordSet: { at: Date.now(), live } }));
    if (!s.passwordSet || !live || s.passwordSet.live === live) return true;
  }
  const until = passwordRefused.get(key);
  if (until && Date.now() < until) return url.protected;
  return onePassword(
    key,
    async () => {
      // (Read again: the owner may have turned it off meanwhile.)
      if (siteNow(wsId, name, site, computerId)?.passwordOff) return url.protected;
      const r = await publicUrls.setPassword(computerId, url.id, newPassword()).catch((e: unknown) => e as Error);
      if (!ours()) return url.protected;
      if (r instanceof Error || !r.enabled || r.value.protected === false) {
        passwordRefused.set(key, Date.now() + (passwordUnavailable(r) ? PASSWORD_LATER_MS : PASSWORD_AGAIN_MS));
        return url.protected;
      }
      passwordRefused.delete(key);
      keepSite(wsId, name, site, (x) => ({ ...x, passwordSet: { at: Date.now(), live } }));
      return true;
    },
    url.protected,
  );
}

/** When Bops last set a site's Preview password (PreviewSite.passwordAt), as kept now. */
const passwordAtOf = (wsId: string, name: string, site: string) => {
  const h = hostingOf(wsId, name);
  return h ? sitesOf(h, name).find((x) => x.site === site)?.passwordSet?.at : undefined;
};

/** A site's Preview link as Orgo lists it now, with the deploy live on it (null: none); null when it has no link yet. */
async function previewLinkOf(wsId: string, name: string, ours: () => boolean, site?: unknown): Promise<{ h: SiteHosting; url: OrgoPublicUrl; live: string | null } | null> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingAt(wsId, name, site) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (h.lost) return null;
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const repo = ingotRepo(wsId, name);
  const list = await projectsNow(h.computerId, ours);
  const { urls } = await urlsNow(h.computerId, ours);
  const found = previewIn(list, urls, repo, h.site, knownLabel(h, hostingOf(wsId, name) ?? h, name, repo, list, urls));
  if (!found?.url) return null;
  // (Its live deploy as its project says it on its own, as the Apps page reads it.)
  const p = found.project ? await within(deploys.project(h.computerId, found.project.id).then((r) => (r.enabled ? r.value : null), () => null), READ_MS) : null;
  held(ours);
  return { h, url: found.url, live: (p ?? found.project)?.current?.id ?? null };
}

/**
 * A Preview's password as the window gets it: read from Orgo when its link asks for one (`on`), with the cookie that
 * opens it, and when Bops set it (`at`). A key that can't read it (403: one without write on computers) gets none,
 * with why, never an error to ask again about; Orgo may keep only the cookie's check of an older one (password null).
 */
async function passwordAnswer(computerId: string, url: OrgoPublicUrl, on: boolean | undefined, at: number | undefined, ours: () => boolean): Promise<PreviewPassword> {
  const when = at ? { at } : {};
  if (!on) return { url: url.url, on: on ?? null, password: null, cookie: null, ...when };
  const r = await publicUrls.password(computerId, url.id).catch((e: unknown) => (e instanceof OrgoError && e.status === 403 ? null : Promise.reject(refused(e))));
  held(ours);
  if (!r) return { url: url.url, on: true, password: null, cookie: null, why: PASSWORD_WORDS.key, ...when };
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  const c = r.value.cookie;
  return {
    url: url.url,
    on: true,
    password: typeof r.value.password === "string" ? r.value.password : null,
    cookie: c?.name === PASS_COOKIE && typeof c.value === "string" && c.value ? { name: PASS_COOKIE, value: c.value } : null,
    ...when,
  };
}

/**
 * GET /api/hosted-apps/[name]/password: a site's Preview password and the cookie that opens its link (PreviewPassword),
 * as it should be first (passwordNow: set when it has none, a new one once another deploy went live). Nothing for a
 * site with no link yet.
 */
export async function previewPassword(wsId: string, name: string, site?: unknown): Promise<PreviewPassword> {
  const ours = sameState();
  const got = await previewLinkOf(wsId, name, ours, site);
  if (!got) return { url: null, on: null, password: null, cookie: null };
  const on = await passwordNow(wsId, name, got.h.site, got.h.computerId, got.url, got.live, ours);
  held(ours);
  return passwordAnswer(got.h.computerId, got.url, on, passwordAtOf(wsId, name, got.h.site), ours);
}

const PASSWORD_WORDS = {
  none: "It has no preview link yet. Deploy a preview first.",
  cant: "Orgo can't put a password on its preview yet.",
  off: "Its password is off. Turn it on first.",
  key: "Your Orgo key can't see or change it. Sign in with Orgo again to use one that can.",
};

/**
 * POST /api/hosted-apps/[name]/password: a site's Preview password made new ("new": the link stays, a browser with
 * the old one asks again), or turned on (a new one) or off for that site, the owner's choice kept on its record.
 * Answers PreviewPassword. Refused while the app is being removed, for a site with no link yet, and where Orgo can't
 * put one on it.
 */
export async function changePreviewPassword(wsId: string, name: string, action: unknown, site?: unknown): Promise<PreviewPassword> {
  const ours = sameState();
  if (action !== "new" && action !== "on" && action !== "off") throw new HostedAppError("What should happen to its password?", 400);
  notRemoving(wsId, name);
  const got = await previewLinkOf(wsId, name, ours, site);
  if (!got) throw new HostedAppError(PASSWORD_WORDS.none, 409);
  const { h, url, live } = got;
  if (typeof url.protected !== "boolean") throw new HostedAppError(PASSWORD_WORDS.cant, 409);
  if (action === "new" && h.passwordOff) throw new HostedAppError(PASSWORD_WORDS.off, 409);
  const key = `${h.computerId}/${url.id}`;
  const on = await onePassword(
    key,
    async () => {
      const r = await publicUrls
        .setPassword(h.computerId, url.id, action === "off" ? null : newPassword())
        .catch((e: unknown) =>
          Promise.reject(
            e instanceof OrgoError && e.status === 503 && e.code === "PASSWORD_UNAVAILABLE"
              ? new HostedAppError(PASSWORD_WORDS.cant, 409)
              : e instanceof OrgoError && e.status === 403
                ? new HostedAppError(PASSWORD_WORDS.key, 403)
                : refused(e),
          ),
        );
      held(ours);
      if (!r.enabled) throw new HostedAppError(r.why, 403);
      passwordRefused.delete(key);
      keepSite(wsId, name, h.site, ({ passwordOff: _off, passwordSet: _set, ...x }) => {
        void _off;
        void _set;
        return action === "off" ? { ...x, passwordOff: true } : { ...x, passwordSet: { at: Date.now(), live } };
      });
      return action !== "off";
    },
    url.protected,
  );
  return passwordAnswer(h.computerId, url, on, passwordAtOf(wsId, name, h.site), ours);
}

/** Why Publish is refused for a site with no domain that never served (Published lives on its domains only). */
const NO_DOMAIN = "Connect a domain first. Published sites live only on their own domain.";

/**
 * Whether a site's Published can be published to: it has a domain on its port (pending is enough: its certificate
 * comes once its DNS points at the edge), or it served something before (a legacy one, live with no domain).
 */
function domainReady(p: OrgoDeployProject | undefined, all: OrgoCustomDomain[]): boolean {
  if (p && (servingOf(p) || (p.deployments ?? []).some((d) => d.state === "succeeded"))) return true;
  const port = p?.port;
  return typeof port === "number" && all.some((d) => d.target_port === port && d.status !== "failed" && d.status !== "disabled");
}

/**
 * POST /api/hosted-apps/[name] "promote" (Publish): Published gets what the Preview serves, each site its own
 * Preview's changeset (every site with a Preview that serves one, or the one `site` names), built on its
 * Published project with its own variables and settings, one site after another. A site with no domain that
 * never served is refused (NO_DOMAIN). `at` (with a site): the changeset the window saw on the Preview; the
 * Preview serving another one since is refused (PREVIEW_MOVED), nothing sent. Its sign in variables are set to
 * its domain when it has none of them (never one the user set).
 */
export async function promoteApp(wsId: string, name: string, opts: { site?: unknown; at?: unknown; ours?: () => boolean } = {}): Promise<{ app: HostedApp; promoted: { site: string; at: string; domain: string | null }[]; said?: string }> {
  const ours = opts.ours ?? sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (opts.at !== undefined && (typeof opts.at !== "string" || !CHANGESET.test(opts.at))) throw new HostedAppError("That isn't a changeset of it.", 400);
  if (opts.site !== undefined) siteIn(h, name, opts.site);
  return withApp(wsId, name, "deploy", async () => {
    const now = hostingOf(wsId, name);
    if (!now) throw new HostedAppError(NO_APP, 404);
    if (now.lost) throw new HostedAppError(LOST, 409);
    const why = await closedHere();
    held(ours);
    if (why) throw new HostedAppError(why, 403);
    const sites = opts.site !== undefined ? [siteIn(now, name, opts.site).site] : sitesOf(now, name).map((x) => x.site);
    const read = await previewsOf(wsId, name, now, (c) => projectsNow(c, ours).catch(() => null), (c) => urlsNow(c, ours).then((x) => x.urls, () => null), ours);
    held(ours);
    if (!read) throw new HostedAppError("Couldn't read its preview just now. Try again in a minute.", 502);
    const plan = sites.map((site) => ({ site, at: read.previews.get(site)?.serving ?? null }));
    const ready = plan.filter((x): x is { site: string; at: string } => !!x.at);
    if (!ready.length) throw new HostedAppError(sites.length === 1 && sites[0] !== name ? `${sites[0]}'s preview isn't live yet, so there's nothing to publish.` : "The preview isn't live yet. Deploy a preview first.", 409, { code: "NO_PREVIEW" });
    if (opts.at !== undefined && opts.site !== undefined && ready[0].at !== opts.at) throw new HostedAppError("The preview changed since you looked. Look again.", 409, { code: "PREVIEW_MOVED" });
    // Each site's domain: one with none that never served isn't published (its domains are read once, for all).
    const all = await domains.ofComputer(now.computerId).then((l) => l.domains ?? [], () => null);
    held(ours);
    const promoted: { site: string; at: string; domain: string | null }[] = [];
    const noDomain: string[] = [];
    let app: HostedApp | undefined;
    for (const x of ready) {
      try {
        const prod = await ensureProd(wsId, name, siteIn(hostingOf(wsId, name) ?? now, name, x.site), ours);
        const p = (await projectsNow(prod.computerId, ours)).find((y) => y.id === prod.projectId);
        if (all && !domainReady(p, all)) {
          noDomain.push(x.site);
          continue;
        }
        const domain = all && typeof p?.port === "number" ? firstDomain(all, p.port) : null;
        // Sign in at its own domain, when nothing says where yet.
        const named = domain ?? (all && typeof p?.port === "number" ? all.find((d) => d.target_port === p.port && d.status !== "failed" && d.status !== "disabled")?.domain : undefined);
        if (p && named) await seedAuth(prod.computerId, p, named.startsWith("https://") ? named : `https://${named}`, ours);
        app = (await sendDeploys(wsId, name, { at: x.at, site: x.site }, ours)).app;
        promoted.push({ ...x, domain });
      } catch (e) {
        if (!promoted.length || (e instanceof HostedAppError && e.message === SWAPPED)) throw e;
        const words = e instanceof HostedAppError ? e.message : "Orgo didn't answer.";
        throw new HostedAppError(`Publishing ${promoted.map((p) => p.site).join(" and ")}, but not ${x.site}: ${words}`, e instanceof HostedAppError ? e.status : 502, { partial: true });
      }
    }
    if (!promoted.length && noDomain.length) throw new HostedAppError(NO_DOMAIN, 409, { code: "NO_DOMAIN", sites: noDomain });
    const left = plan.filter((x) => !x.at).map((x) => x.site);
    const said = [
      left.length ? `${left.join(", ")} ${left.length === 1 ? "has" : "have"} no preview live, so ${left.length === 1 ? "it stays" : "they stay"} as published before.` : "",
      noDomain.length ? `${noDomain.join(", ")} ${noDomain.length === 1 ? "has" : "have"} no domain yet, so ${noDomain.length === 1 ? "it isn't" : "they aren't"} published. Connect one first.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { app: app ?? (await appNow(wsId, name, ours)), promoted, ...(said ? { said } : {}) };
  });
}

/** A site's Published address: https://<the first active domain on its port>, or null. */
const firstDomain = (all: OrgoCustomDomain[], port: unknown): string | null => {
  const d = typeof port === "number" ? all.find((x) => x.target_port === port && x.status === "active") : undefined;
  return d ? `https://${d.domain}` : null;
};

/**
 * POST /api/hosted-apps/[name] "reapply" (Apply variables, the owner's, in the window only): the changeset a
 * site's Published serves now, built again on it, so its variables as they are now apply (Publish takes only the
 * Preview's changeset, which it may serve already). Refused when it serves nothing.
 */
export async function reapplyApp(wsId: string, name: string, opts: { site?: unknown } = {}): Promise<{ app: HostedApp }> {
  const ours = sameState();
  const got = await projectOf(wsId, name, ours, opts.site);
  const at = got ? servingOf(got.p) : null;
  if (!got || !at) throw new HostedAppError("Nothing is published yet.", 409, { code: "NOT_PUBLISHED" });
  return withApp(wsId, name, "deploy", async () => ({ app: (await sendDeploys(wsId, name, { at, site: got.h.site }, ours)).app }));
}

/**
 * POST /api/hosted-apps/[name] "preview" { site?, label? } (the owner's, in the window only): a site's Preview
 * made now, its link before any deploy (after its Published project), with `label` when the owner chose its name
 * ahead (12 lowercase letters and digits, the first a letter: one they registered in Google sign in already).
 * Once a site has its Preview, its name never changes: another name is refused. Answers the app, and the link.
 */
export async function makePreview(wsId: string, name: string, ask: { site?: unknown; label?: unknown } = {}): Promise<{ app: HostedApp; url: string; said?: string }> {
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  const given = ask.label === undefined || ask.label === null || ask.label === "" ? undefined : labelGiven(ask.label);
  if (given === null) throw new HostedAppError("A preview's name is 12 lowercase letters and digits, starting with a letter.", 400, { field: "label" });
  siteIn(h, name, ask.site);
  return withApp(wsId, name, "deploy", async () => {
    const kept = await homeFor(wsId, name, {}, ours);
    const now = stillOn(wsId, name, kept);
    const prod = await ensureProd(wsId, name, siteIn(now, name, ask.site), ours);
    const pv = await ensurePreview(wsId, name, prod, ours, given ? { given } : {});
    keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
    return { app: await appNow(wsId, name, ours), url: pv.url.url, ...(pv.said ? { said: pv.said } : {}) };
  });
}

/**
 * A site's Preview projects on a computer the app left (its bot moved to another one that stays up): kept with
 * its Published ones left there (AppHosting.behind, which Remove app takes down, and which a Bops 0.0.32 knows
 * too), read after the move, never holding it up. Their links move with the next Preview deploy (ensurePreview).
 */
async function previewLeft(wsId: string, name: string, was: AppHosting) {
  if (was.lost) return;
  const repo = repoOrNull(wsId, name);
  if (!repo) return;
  const [list, urls] = await Promise.all([
    deploys.projects(was.computerId).then((r) => (r.enabled ? (r.value.projects ?? []) : null), () => null),
    publicUrls.list(was.computerId).then((r) => (r.enabled && r.value.enabled ? (r.value.public_urls ?? []) : []), () => []),
  ]);
  if (!list) return;
  const left = sitesOf(was, name).flatMap((s) => {
    const p = previewIn(list, urls, repo, s.site, knownLabel(s, was, name, repo, list, urls))?.project;
    return p ? [{ site: s.site, computerId: was.computerId, projectId: p.id }] : [];
  });
  if (!left.length) return;
  keepHosting(wsId, name, (x) => {
    if (!x || x.computerId === was.computerId) return x;
    const behind = [...(x.behind ?? []), ...left.filter((l) => !x.behind?.some((b) => b.projectId === l.projectId))];
    return { ...x, behind };
  });
}

/**
 * POST /api/hosted-apps/[name] "removeLeftOver" { project } (the owner's, in the window only, asked once more
 * there): one of the app's left overs taken off its computer (a project, its own URL with it; or a Preview link,
 * "url:<id>"). Only one the app's lists say is a left over now, never one a site has.
 */
export async function removeLeftOver(wsId: string, name: string, project: unknown): Promise<{ app: HostedApp }> {
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (typeof project !== "string" || !/^(?:url:)?[\w-]{1,80}$/.test(project)) throw new HostedAppError("That isn't one of its left overs.", 404);
  return withApp(wsId, name, "removeSite", async () => {
    const now = hostingOf(wsId, name);
    if (!now || now.lost) throw new HostedAppError(NO_APP, 404);
    const why = await closedHere();
    held(ours);
    if (why) throw new HostedAppError(why, 403);
    const repo = ingotRepo(wsId, name);
    const list = await projectsNow(now.computerId, ours);
    const { urls } = await urlsNow(now.computerId, ours);
    const x = leftOversOf(now, name, repo, list, urls, placesOf(now, name, repo, list, urls)).find((l) => l.id === project);
    if (!x) throw new HostedAppError("That isn't one of its left overs.", 404);
    if (x.id.startsWith("url:")) {
      const r = await publicUrls.remove(now.computerId, x.id.slice(4)).catch((e: unknown) => e as Error);
      held(ours);
      if (r instanceof Error && !(r instanceof OrgoError && r.status === 404)) throw refused(r);
    } else {
      await takeDown(wsId, { botId: now.botId, computerId: now.computerId, projectId: x.id, site: name }, ours);
      // (A link Bops made for it, which its project doesn't own, goes with it.)
      const u = urls.find((y) => y.label === x.name);
      if (u) await publicUrls.remove(now.computerId, u.id).catch(() => null);
    }
    held(ours);
    keepHosting(wsId, name, (y) => y && { ...y, queuedAt: Date.now() });
    return { app: await appNow(wsId, name, ours) };
  });
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
export async function appLog(wsId: string, name: string, after: string | null, site?: unknown, env?: unknown): Promise<{ state: DeployState | null; log: string; next: string | null; more: boolean }> {
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingAt(wsId, name, site) : undefined;
  if (!h) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  const none = { state: null, log: "", next: null, more: false };
  const got = appEnvOf(env) === "preview" ? await previewOf(wsId, name, ours, site) : await projectOf(wsId, name, ours, site);
  if (!got) return none;
  const project = got.p;
  const d = newest(project);
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
  if (h.lost) return null;
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  // Published as its computer's list says it (prodIn: never a Preview its record may name); unread, its record's.
  const repo = repoOrNull(wsId, name);
  const list = repo ? await deploys.projects(h.computerId).then((r) => (r.enabled ? (r.value.projects ?? []) : null), () => null) : null;
  held(ours);
  const id = list && repo ? prodIn(list, hostingOf(wsId, name) ?? h, name, h.site, repo)?.id : h.projectId;
  if (!id) return null;
  const p = await deploys.project(h.computerId, id).catch((e: unknown) => Promise.reject(refused(e)));
  held(ours);
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  return { h: { ...h, projectId: id }, p: p.value };
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

/** A project's settings as the window shows them; `url`: its address (a Preview's link; Published's first active domain, or null). */
const settingsOf = (p: OrgoDeployProject, url: string | null): AppSettingsAnswer => ({
  url,
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
export async function appSettings(wsId: string, name: string, site?: unknown, env?: unknown): Promise<AppSettingsAnswer> {
  const ours = sameState();
  if (appEnvOf(env) === "preview") {
    const got = await previewOf(wsId, name, ours, site);
    if (got) return { ...settingsOf(got.p, got.h.url ?? null), prodEnv: envNames(got.prod) };
    // No Preview yet: Published's variables' names, to say what the Preview won't have.
    const prod = await projectOf(wsId, name, ours, site).catch(() => null);
    return { url: null, settings: null, env: [], deploys: [], prodEnv: envNames(prod?.p) };
  }
  const got = await projectOf(wsId, name, ours, site);
  if (!got) return { url: null, settings: null, env: [], deploys: [] };
  return settingsOf(got.p, await publishedAt(got.h.computerId, got.p.port));
}

/** Published's address on its computer: https://<its first active domain on `port`>, or null (none, or Orgo didn't say). */
const publishedAt = (computerId: string, port: unknown) => domains.ofComputer(computerId).then((l) => firstDomain(l.domains ?? [], port), () => null);

/** A project's variables' names, as Orgo answers them (never their values). */
const envNames = (p: OrgoDeployProject | undefined | null) => [...new Set((p?.env_keys ?? []).filter((k) => typeof k === "string"))].sort();

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
  env?: unknown,
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
  if (appEnvOf(env) === "preview") return previewSettings(wsId, name, site, patch, ours);
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
  return { ...settingsOf(r.value, await publishedAt(h.computerId, r.value.port)), ...(said ? { said } : {}) };
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
  const made = await ensureProd(wsId, name, h, ours);
  const r = await deploys.change(made.computerId, made.projectId, patch).catch((e: unknown) => Promise.reject(settingsRefused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  return settingsOf(r.value, null);
}

/**
 * Settings changed on a site's Preview project (its own: Published's stay as they are; it has no domains to move),
 * made first when it has none (after Published's), with nothing else under way on the app.
 */
async function previewSettings(wsId: string, name: string, site: unknown, patch: Parameters<typeof deploys.change>[2], ours: () => boolean): Promise<AppSettingsAnswer> {
  const got = await previewOf(wsId, name, ours, site);
  const project = got ? { computerId: got.h.computerId, id: got.p.id, url: got.h.url ?? null } : await withApp(wsId, name, "first", () => firstPreview(wsId, name, site, ours));
  const r = await deploys.change(project.computerId, project.id, patch).catch((e: unknown) => Promise.reject(settingsRefused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  return { ...settingsOf(r.value, project.url), prodEnv: envNames(got?.prod) };
}

/**
 * A site's Preview made before its first deploy (its settings or variables saved first, with nothing else under
 * way on the app: withApp), after Published's (ensureProd); one made meanwhile is the one. `env`: the user's
 * variables to make it with (on top of the sign in seeds).
 */
async function firstPreview(wsId: string, name: string, site: unknown, ours: () => boolean, env?: Record<string, string>): Promise<{ computerId: string; id: string; url: string | null; made: boolean }> {
  const h = hostingAt(wsId, name, site);
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (h.lost) throw new HostedAppError(LOST, 409);
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const prod = await ensureProd(wsId, name, h, ours);
  const pv = await ensurePreview(wsId, name, prod, ours, env ? { env } : {});
  if (pv.made) keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
  return { computerId: prod.computerId, id: pv.project.id, url: pv.url.url, made: pv.made };
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
export async function changeEnv(wsId: string, name: string, env: unknown, site?: unknown, where?: unknown): Promise<{ env: string[] }> {
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
  if (where === "local") return { env: await changeLocalEnv(wsId, name, out, site, ours) };
  if (appEnvOf(where) === "preview") {
    const got = await previewOf(wsId, name, ours, site);
    if (got) return { env: await envOn(got.h.computerId, got.p.id, out, ours) };
    const set = Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => e[1] !== null));
    if (!Object.keys(set).length) return { env: [] };
    const made = await withApp(wsId, name, "first", () => firstPreview(wsId, name, site, ours, set));
    // (One found there, made meanwhile, gets them on its own.)
    return { env: made.made ? Object.keys(set).sort() : await envOn(made.computerId, made.id, out, ours) };
  }
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
  const set = Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => e[1] !== null));
  if (!Object.keys(set).length) return [];
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  // (Found there, made meanwhile: it gets them on its own. Else made with them.)
  const made = await ensureProd(wsId, name, h, ours, set);
  const p = await deploys.project(made.computerId, made.projectId).catch(() => null);
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
export async function rollbackApp(wsId: string, name: string, deployment: unknown, site?: unknown, env?: unknown): Promise<{ app: HostedApp }> {
  if (typeof deployment !== "string" || !/^[\w-]{1,80}$/.test(deployment)) throw new HostedAppError("That isn't one of its deploys.", 400);
  const ours = sameState();
  const preview = appEnvOf(env) === "preview";
  const got = preview ? await previewOf(wsId, name, ours, site) : await projectOf(wsId, name, ours, site);
  if (!got) throw new HostedAppError("It hasn't been deployed yet.", 409);
  const d = (got.p.deployments ?? []).find((x) => x.id === deployment);
  if (!d) throw new HostedAppError("That isn't one of its recent deploys.", 404);
  if (d.release_live) throw new HostedAppError("That one is live now.", 409);
  if (!d.can_rollback || d.state !== "succeeded") throw new HostedAppError("That one can't be put back: only a deploy that went live, and is still on its computer, can.", 409);
  held(ours);
  const r = await deploys.rollback(got.h.computerId, deployment).catch((e: unknown) => Promise.reject(rollbackRefused(e)));
  held(ours);
  if (!r.enabled) throw new HostedAppError(r.why, 403);
  // (The Preview's rollback: the app as Orgo has it now, the rollback queued there; Published's, as a deploy's answer.)
  if (preview) {
    keepHosting(wsId, name, (x) => x && { ...x, queuedAt: Date.now() });
    return { app: await appNow(wsId, name, ours) };
  }
  return { app: await queued(wsId, name, got.h, new Map([[got.h.site, r.value]]), deployedAt(d) ?? undefined) };
}

/* ---------------- Its domains and their DNS ---------------- */

/** A bought domain's id at Orgo, as a change names the zone it goes to. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A record's id at Orgo: 16 characters of base64url, made from what the record says. */
export const RECORD_ID = /^[A-Za-z0-9_-]{16}$/;

const NOT_HERE = "That domain doesn't point at this app, so its DNS isn't changed here.";
export const STALE = "That record changed since it was read. Here are the records as they are now, so try again.";

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
export function dnsRefused(e: unknown) {
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

/**
 * (`make`: a domain is being connected, so a site with no Published project yet gets it made now, nothing
 * deployed: ensureProd. A domain needs only its port. Without it, a site with none answers null.)
 */
async function appTarget(wsId: string, name: string, ours: () => boolean, site?: unknown, make = false): Promise<Target | null> {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const at = isRepoName(name) ? hostingAt(wsId, name, site) : undefined;
  if (!at) throw new HostedAppError("There's no app by that name in this workspace.", 404);
  if (at.lost) {
    if (make) throw new HostedAppError(LOST, 409);
    return null;
  }
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  const found = await projectOf(wsId, name, ours, site);
  const h: SiteHosting & { projectId: string } | null = found
    ? found.h
    : make
      ? await withApp(wsId, name, "first", () => ensureProd(wsId, name, hostingAt(wsId, name, site) ?? at, ours))
      : null;
  if (!h) return null;
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
  // (Its address: its first active domain, never the orgo.dev name its project may have.)
  return { h, project, url: firstDomain(all, port), port, bought, all, mine, zones, zoneOf };
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

/** Why a record is Orgo's, in words, or null for one of the user's own: the app's tab says it of its app, Settings of the workspace's. */
export type LockOf = (r: OrgoDnsRecord) => string | null;

/** A zone's records as the window shows them, each locked as `lock` says (only the types Bops shows). */
export const recordsOf = (records: OrgoDnsRecord[] | undefined, lock: LockOf): AppDnsRecord[] =>
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
      locked: lock(r),
    }));

export const zoneView = (id: string, domain: string, z: OrgoZone, lock: LockOf): AppDnsZone => ({
  id,
  domain: z.domain || domain,
  serving: z.serving ?? z.nameservers?.mode === "orgo",
  ttl: typeof z.ttl_seconds === "number" ? z.ttl_seconds : null,
  records: recordsOf(z.records, lock),
});

/** The app's tab's lock: why a record is Orgo's, said of this app (lockedWhy). */
const appLock = (t: Target): LockOf => (r) => lockedWhy(t, r);

/** A zone's records as Orgo has them; one that can't be read says why, and the rest of the app's domains still show. */
async function readZone(t: Target, id: string, domain: string): Promise<AppDnsZone> {
  const none: AppDnsZone = { id, domain, serving: false, ttl: null, records: [] };
  if (!t.project) return { ...none, error: NO_PROJECT };
  try {
    return zoneView(id, domain, await domains.zone(t.project, id), appLock(t));
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
async function domainOf(t: Target, d: OrgoCustomDomain, look = false, cfZonesNow?: CfZone[] | null | Promise<CfZone[] | null>): Promise<AppDomain> {
  const base: AppDomain = { id: d.id, domain: d.domain, status: d.status, cert: d.cert_status === "issued" ? "issued" : "pending", managed: !!d.managed, zone: t.zoneOf.get(d.id) ?? null, publish: [] };
  if (d.managed || d.status === "disabled") return { ...base, ...cloudflareOf(d, await cfZonesNow) };
  // (The user's Cloudflare zones, when they're still being read, alongside Orgo's look.)
  const [out, zones] = await Promise.all([outsideOf(t, d, base, look), cfZonesNow]);
  return { ...out, ...cloudflareOf(d, zones) };
}

/** One bought elsewhere whose zone is in the user's Cloudflare account (`zones`, the key's, read once for the look): Bops can set its records there. */
const cloudflareOf = (d: OrgoCustomDomain, zones: CfZone[] | null | undefined): Pick<AppDomain, "cloudflare"> => {
  if (d.managed || d.status === "disabled" || !zones) return {};
  const z = zoneFor(d.domain, zones);
  return z ? { cloudflare: { zone: z.name, zoneId: z.id } } : {};
};

/** domainOf for one bought elsewhere: the records to set where its DNS is kept, with what Orgo's look found. */
async function outsideOf(t: Target, d: OrgoCustomDomain, base: AppDomain, look: boolean): Promise<AppDomain> {
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
export async function appDomains(wsId: string, name: string, site?: unknown, { cloudflare = false }: { cloudflare?: boolean } = {}): Promise<AppDomainsAnswer> {
  return domainsNow(wsId, name, sameState(), site, cloudflare);
}

/**
 * The app's domains as appDomains reads them, for the account the work began on; each zone with its renewal
 * (the workspace's bought domains, read once, when the target didn't read them already). `cloudflare`: each
 * one in the user's Cloudflare says so (AppDomain.cloudflare), read with their key: only for the Bops window.
 */
async function domainsNow(wsId: string, name: string, ours: () => boolean, site?: unknown, cloudflare = true): Promise<AppDomainsAnswer> {
  const t = await appTarget(wsId, name, ours, site);
  held(ours);
  if (!t) return { url: null, domains: [], zones: [] };
  const boughtList = t.bought ? Promise.resolve(t.bought) : t.zones.size && t.project ? domains.bought(t.project).catch(() => null) : Promise.resolve(null);
  // The user's Cloudflare zones, read alongside (only when one of its domains is outside Orgo, a few seconds at most).
  const [zones, list, bought, cfNow] = await Promise.all([
    Promise.all([...t.zones].map(([id, domain]) => readZone(t, id, domain))),
    Promise.all(t.mine.map((d) => domainOf(t, d))),
    boughtList,
    cloudflare ? cfZonesForLook(t, wsId, ours) : null,
  ]);
  const renewalFor = (id: string) => renewalOf(bought?.domains?.find((b) => b.id.toLowerCase() === id));
  return { url: t.url, domains: list.map((x, i) => ({ ...x, ...cloudflareOf(t.mine[i], cfNow) })), zones: zones.map((z) => withRenewal(z, renewalFor(z.id))) };
}

const withRenewal = (z: AppDnsZone, renewal: AppRenewal | undefined): AppDnsZone => (renewal ? { ...z, renewal } : z);

/** Why a renewal's last try failed, in words (orgo-web renewal_error). */
const RENEW_WORDS: Record<string, string> = {
  insufficient_credits: "The last try to renew it found too few credits. Add credits, or pay from yours.",
  no_payer: "No one is set to pay for it. Turn auto-renew on to pay from your credits.",
  registry_refused: "The registry turned the last try down. Orgo tries again.",
};

/** A bought domain's renewal as the window shows it (undefined: this Orgo doesn't say, before it renewed domains). */
export function renewalOf(b: OrgoBoughtDomain | undefined): AppRenewal | undefined {
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
export type Typed = { [K in keyof AppDnsInput]?: unknown };

/** A record as the window typed it, as orgo-web takes it: its type checked here, the rest by Orgo (which says what's wrong with it). */
export function inputOf(r: Typed): OrgoRecordInput {
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
    return { zone: asked, records: recordsOf((await send(project, asked)).records, appLock(t)) };
  } catch (e) {
    if (!(e instanceof OrgoError && e.code === "RECORD_NOT_FOUND")) throw dnsRefused(e);
    held(ours);
    const now = await domains.zone(project, asked).catch(() => null);
    throw new HostedAppError(STALE, 404, { stale: true, ...(now ? { zone: asked, records: zoneView(asked, domain, now, appLock(t)).records } : {}) });
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

/**
 * A site with no Published project yet, as Add a domain reads it: its computer's custom domains (for what's in use
 * there), and none of its own. Null when its computer is gone.
 */
async function bareTarget(wsId: string, name: string, ours: () => boolean, site?: unknown): Promise<Target | null> {
  const h = hostingAt(wsId, name, site);
  if (!h || h.lost) return null;
  const list = await domains.ofComputer(h.computerId).catch(() => null);
  held(ours);
  return { h, project: workspace(wsId)?.orgoProjectId, url: null, port: null, all: list?.domains ?? [], mine: [], zones: new Map(), zoneOf: new Map() };
}
const NOT_MINE = "That domain doesn't point at this app.";
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Orgo didn't say which workspace a computer is in (it didn't answer, or not in a way that says). */
export const DOMAINS_UNREACHED = "Couldn't reach Orgo's domains just now.";

/**
 * The Orgo workspace a Bops workspace's domains are listed, bought and pointed from, the same for an app's
 * tab and for Settings: the one `computerId` is in (the app's computer, or for Settings the main bot's),
 * whose bought domains are the ones it can serve. Else the workspace's own project: when there's no computer
 * to ask about, Orgo doesn't say, or the computer isn't the user's to ask about any more (404 or 403: a new
 * one goes into the workspace's own project). The move onto Orgo workspaces (workspaces.ts) gave each
 * workspace an empty project of its own and moved no computer, so most stay in "bops": that project alone
 * would list none of the domains its apps use. Undefined: neither (not on Orgo yet). Orgo not answering is
 * DOMAINS_UNREACHED, never taken for no workspace: a buy then would go into the wrong one.
 */
export async function domainsProjectOf(wsId: string, computerId: string | undefined, ours: () => boolean): Promise<string | undefined> {
  const here = workspace(wsId)?.orgoProjectId;
  if (!computerId) return here;
  const id = await domains
    .workspaceOf(computerId)
    .catch((e: unknown) => (e instanceof OrgoError && (e.status === 404 || e.status === 403) ? null : Promise.reject(new HostedAppError(DOMAINS_UNREACHED, 502))));
  held(ours);
  return id ?? here;
}

/** The Orgo workspace the app's computer is in: the one whose bought domains it can serve, and where one is bought for it. */
const computerProject = (t: Target, wsId: string, ours: () => boolean) => domainsProjectOf(wsId, t.h.computerId, ours);

/** The registrant as the window typed it: only the fields the registry takes, each as text, cut to its length (Orgo checks the rest). */
export function registrantOf(r: unknown): Record<string, string> {
  const typed = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of REGISTRANT_FIELDS) {
    const v = typed[f.key];
    if (typeof v === "string" && v.trim()) out[f.key] = v.trim().slice(0, f.max);
  }
  return out;
}

/** Who Orgo says the user last registered a domain to, as the form takes it (only the fields it has, as text). */
export function contactOf(c: unknown): Registrant | null {
  if (!c || typeof c !== "object") return null;
  const out: Registrant = {};
  for (const f of REGISTRANT_FIELDS) {
    const v = (c as Record<string, unknown>)[f.key];
    if (typeof v === "string" && v.trim()) out[f.key] = v.trim().slice(0, f.max);
  }
  return Object.keys(out).length ? out : null;
}

export const BUY_CLOSED = "Buying domains isn't open to your Orgo account yet.";
export const BUY_NEEDS = "Buying a domain needs full access to this workspace, signed in with your own Orgo account.";

/**
 * Which of the workspace's apps (and which site of it) each port of a computer serves, from its deploy
 * projects, read once (never waking it): an app's own project, one of its sites', or one it left behind
 * there. Null: Orgo couldn't say (or deploys aren't open to the account).
 */
export async function portsOn(wsId: string, computerId: string): Promise<Map<number, { app: string; site?: string }> | null> {
  const got = await deploys.projects(computerId).catch(() => null);
  if (!got?.enabled) return null;
  const apps = Object.entries(workspace(wsId)?.hostedApps ?? {});
  const out = new Map<number, { app: string; site?: string }>();
  for (const p of got.value.projects ?? []) {
    if (typeof p.port !== "number") continue;
    for (const [app, h] of apps) {
      const site =
        h.computerId === computerId && h.projectId === p.id
          ? app
          : h.computerId === computerId
            ? h.sites?.find((x) => x.projectId === p.id)?.name
            : h.behind?.find((x) => x.computerId === computerId && x.projectId === p.id)?.site;
      if (site) out.set(p.port, site === app ? { app } : { app, site });
    }
  }
  return out;
}

/**
 * GET /api/hosted-apps/[name]/domains (the window only): what a domain can be added from: whether one can be
 * bought here (open to the account, full access, the person's own key: Orgo's can_buy), every one of the
 * workspace's bought domains with the names that point at it or under it already (each with the app that
 * serves it, when it's on this app's computer, else that computer's name), and who the user last registered
 * one to, to fill the form. That contact goes to the window alone: nothing here keeps it.
 */
export async function domainOptions(wsId: string, name: string, site?: unknown): Promise<AppDomainOptions> {
  const ours = sameState();
  // (A site with no Published project yet: offered all the same, its domains on its computer read for what's in use; connecting one makes it.)
  const t = (await appTarget(wsId, name, ours, site)) ?? (await bareTarget(wsId, name, ours, site));
  held(ours);
  if (!t) return { buy: { open: false, why: LOST }, owned: [], contact: null };
  // The user's own Cloudflare domains, read alongside (a few seconds at most), with every answer below.
  const cf = within(cloudflareOptions(wsId, name, t, ours), CF_OPTIONS_MS);
  const and = async (o: AppDomainOptions, bought: { domain: string }[] = []): Promise<AppDomainOptions> => {
    const c = await cf;
    held(ours);
    if (!c) return o;
    // One of the workspace's bought domains is under Your domains, where Orgo keeps its DNS.
    const theirs = new Set(bought.map((b) => b.domain.toLowerCase()));
    return { ...o, cloudflare: c.zones ? { ...c, zones: c.zones.filter((z) => !theirs.has(z.domain)) } : c };
  };
  const project = await computerProject(t, wsId, ours).catch((e: unknown) => (e instanceof HostedAppError && e.message === DOMAINS_UNREACHED ? e : Promise.reject(e)));
  if (project instanceof HostedAppError) return and({ buy: { open: false, why: project.message }, owned: [], contact: null });
  if (!project) return and({ buy: { open: false, why: NO_PROJECT }, owned: [], contact: null });
  const list = await domains.bought(project).catch((e: unknown) => e as Error);
  held(ours);
  if (list instanceof Error) {
    if (list instanceof OrgoError && list.code === "DOMAINS_NOT_ENABLED") return and({ buy: { open: false, why: BUY_CLOSED }, owned: [], contact: null });
    const r = dnsRefused(list);
    return and({ buy: { open: false, why: r instanceof HostedAppError ? r.message : "Couldn't reach Orgo's domains just now." }, owned: [], contact: null });
  }
  const active = (list.domains ?? []).filter((d) => d.status === "active");
  // A name on this app's computer is served by the app on its port: this one, or another of the workspace's
  // there (its deploy projects read once, only when one is on another port).
  const here = (p: { domain: string; computer_id: string }) => p.computer_id === t.h.computerId && t.all.find((d) => d.domain.toLowerCase() === p.domain.toLowerCase());
  const onAnother = (p: { domain: string; computer_id: string }) => {
    const x = here(p);
    return !!x && x.target_port !== t.port;
  };
  const others = active.some((d) => (d.pointed ?? []).some(onAnother)) ? await portsOn(wsId, t.h.computerId) : null;
  held(ours);
  const owned: OwnedDomain[] = active.map(({ id, domain, pointed }) => ({
    id,
    domain,
    inUse: (pointed ?? []).map((p) => {
      const x = here(p);
      const app = x ? (x.target_port === t.port ? name : others?.get(x.target_port)?.app) : undefined;
      return app ? { name: p.domain.toLowerCase(), app } : { name: p.domain.toLowerCase(), where: p.computer_name ?? "another computer" };
    }),
  }));
  const open = !!list.registrar && list.can_buy !== false;
  return and({ buy: open ? { open } : { open, why: list.registrar ? BUY_NEEDS : BUY_CLOSED }, owned, contact: open ? contactOf(list.last_contact) : null }, active);
}

/** A search's words: a name, or a domain to look for (orgo-web checks the rest). */
export const QUERY = /^[a-z0-9][a-z0-9.-]{0,252}$/i;

/** Where the window sends the user to add Orgo credits (orgo.ai Settings, Billing), opened in the browser. */
export const topUpUrl = () => `${orgoOrigin()}/settings/billing#credits`;

/**
 * A buy that went out and came back with nothing Bops can read as Orgo's answer: whether it was bought
 * isn't known (orgo-web's registration can still be going), so never "Try again" (NO_ANSWER: the window
 * reads the domains again). `timedOut`: no answer at all within the buy's time.
 */
const buyNotKnown = (domain: string, timedOut: boolean) =>
  new HostedAppError(
    `${timedOut ? "Orgo didn't answer in time" : "Orgo's answer didn't come through"}, so it isn't known whether ${domain} was bought. Look again in a minute: it shows up under your domains if it was.`,
    504,
    { code: "NO_ANSWER" },
  );

/**
 * Why a buy didn't go, from an app's tab or Settings: buyRefused's words for each of Orgo's refusals, and
 * NO_ANSWER for anything that leaves it unknown whether it went through: no answer in time, a connection
 * dropped, a 5xx without Orgo's code (a proxy or a restart in front of orgo-web answers so, mid
 * registration too), or an answer that can't be read. Bops' own refusals (BUYING) are as they are.
 */
export function buyFailed(e: unknown, domain: string, here = false) {
  if (e instanceof HostedAppError) return e;
  if (e instanceof OrgoTimeout || e instanceof TypeError) return buyNotKnown(domain, true);
  if (!(e instanceof OrgoError) || (e.status >= 500 && !e.code)) return buyNotKnown(domain, false);
  return buyRefused(e, domain, here);
}

/**
 * Orgo's refusals of a search or a buy, by code, in Bops' words (with the facts the window asks again
 * with). `here`: a buy from an app's tab, which can point the domain at that app once it's bought. A buy
 * goes through buyFailed first.
 */
export function buyRefused(e: unknown, domain = "That domain", here = false) {
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
        { price, available: have, topUp: topUpUrl() },
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
      return fail(`The registry hasn't confirmed ${domain} yet. It shows up under your domains once it does${here ? ", and you can point it here then" : ""}.`);
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

/** A search's words as typed (a scheme or a path dropped), checked before Orgo is asked; and its page. */
export function searchWords(q: unknown, page: unknown): { words: string; page: number } {
  const words = typeof q === "string" ? q.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "") : "";
  if (!words) throw new HostedAppError("Type a name to look for.", 400, { field: "q" });
  if (!QUERY.test(words)) throw new HostedAppError("Type a name with letters, numbers or hyphens.", 400, { field: "q" });
  return { words, page: typeof page === "number" ? page : typeof page === "string" && /^\d{1,3}$/.test(page) ? Number(page) : 0 };
}

/**
 * Orgo's search for `words`, a page of endings, as the window shows it (offersOf, in offersInOrder's
 * order). Nothing is held or bought. Orgo not answering (or with something that can't be read) is said as
 * search not answering, never a buy's words nor Node's.
 */
export async function searchOrgo(words: string, page: number, ours: () => boolean): Promise<DomainSearchAnswer> {
  const r = await domains.search(words, page).catch((e: unknown) => {
    const why = e instanceof OrgoError ? buyRefused(e) : null;
    return Promise.reject(why instanceof HostedAppError ? why : new HostedAppError("Domain search isn't answering just now. Try again shortly.", 504));
  });
  held(ours);
  return { results: offersInOrder(offersOf(r.results), words), next: typeof r.next_page === "number" ? r.next_page : null, ...(r.registrar_error ? { partial: true } : {}) };
}

/** Orgo's search results as the window takes them: only an available one with a price is priced (one without is "unknown"). */
export function offersOf(results: OrgoDomainOffer[] | undefined): DomainOffer[] {
  const STATUSES = ["available", "taken", "premium", "unknown"] as const;
  return (results ?? [])
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
}

/**
 * GET /api/hosted-apps/[name]/domains/search (the window only): names to buy for `q`, a page of endings at a
 * time, each with its price in Orgo credits for its shortest term and each year after (orgo-web's search;
 * nothing is held or bought).
 */
export async function searchDomains(wsId: string, name: string, q: unknown, page: unknown, site?: unknown): Promise<DomainSearchAnswer> {
  const asked = searchWords(q, page);
  const ours = sameState();
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  if (!(isRepoName(name) && hostingAt(wsId, name, site))) throw new HostedAppError(NO_APP, 404);
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  return searchOrgo(asked.words, asked.page, ours);
}

/** Domains being bought now, by "<project>/<domain>" (one Bops server, so one set). */
const buying = (g.bopsDomainBuys ??= new Set<string>());

/**
 * A buy of `domain` for the Orgo workspace `project`, once at a time: a second one while it's out (a
 * double tap, or the app's tab and Settings at once) is refused at once, nothing sent to Orgo (409
 * BUYING). Orgo's own pending row refuses one from elsewhere. Nothing here sends a buy again.
 */
export async function buyingOnce<T>(project: string, domain: string, run: () => Promise<T>): Promise<T> {
  const key = `${project}/${domain}`;
  if (buying.has(key)) throw new HostedAppError(`${domain} is being bought already. Wait for it.`, 409, { code: "BUYING" });
  buying.add(key);
  try {
    return await run();
  } finally {
    buying.delete(key);
  }
}

/** A domain as it's typed to point here: lowercase, without a scheme, a path or a dot at its end. */
export function domainTyped(v: unknown): string | null {
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
async function pointHere(
  wsId: string,
  name: string,
  t: Target,
  body: { domain: string } | { registered_domain_id: string; subdomain: string },
  ours: () => boolean,
  full?: string,
): Promise<AppDomainAdded> {
  return (await pointedHere(wsId, name, t, body, ours, full)).added;
}

/** pointHere, with the custom domain as Orgo made it (its records to set, in full). */
async function pointedHere(
  wsId: string,
  name: string,
  t: Target,
  body: { domain: string } | { registered_domain_id: string; subdomain: string },
  ours: () => boolean,
  full?: string,
): Promise<{ added: AppDomainAdded; c: OrgoCustomDomain }> {
  if (t.port === null) throw new HostedAppError("Orgo doesn't say which port this app listens on, so no domain can point at it.", 409);
  held(ours);
  const sub = "subdomain" in body && !!body.subdomain;
  const c = await domains.connect(t.h.computerId, body, t.port).catch((e: unknown) => {
    // A name under a bought domain Orgo turns down: said of that name, its field marked.
    if (sub && e instanceof OrgoError && e.code === "INVALID_SUBDOMAIN") return Promise.reject(new HostedAppError(BAD_NAME, 400, { field: "subdomain" }));
    if (sub && e instanceof OrgoError && (e.code === "NAME_IN_USE" || (e.status === 409 && !e.code))) return Promise.reject(new HostedAppError(`${full ?? "That name"} is in use already. Pick another name.`, 409, { field: "subdomain" }));
    return Promise.reject(connectRefused(e));
  });
  held(ours);
  const now = await domainsNow(wsId, name, ours, t.h.site);
  return { added: { domains: now, domain: now.domains.find((d) => d.id === c.id) ?? null }, c };
}

const BAD_NAME = "Type a name like www or shop.";

/**
 * POST /api/hosted-apps/[name]/domains "connect": a domain pointed at the app (its computer serves it on
 * the app's port): one the user owns, typed (Orgo answers the records to set where its DNS is kept; one
 * under a domain bought through Orgo, Orgo writes itself), or one of the workspace's bought domains, by id
 * (one it has, read again here, never only the window's word), or the name `subdomain` under it (www,
 * shop), checked before Orgo is asked and never one that points somewhere already.
 */
export async function connectDomain(wsId: string, name: string, ask: { domain?: unknown; zone?: unknown; subdomain?: unknown }, site?: unknown): Promise<AppDomainAdded> {
  const ours = sameState();
  const typed = ask.zone === undefined ? domainTyped(ask.domain) : null;
  if (ask.zone === undefined && !typed) throw new HostedAppError("Type a domain like app.example.com.", 400, { field: "domain" });
  const zone = ask.zone !== undefined ? (typeof ask.zone === "string" && UUID.test(ask.zone) ? ask.zone.toLowerCase() : null) : undefined;
  if (zone === null) throw new HostedAppError("That isn't one of this workspace's domains.", 404);
  const sub = ask.subdomain === undefined || ask.subdomain === null ? "" : subdomainTyped(ask.subdomain);
  if (sub === null) throw new HostedAppError(BAD_NAME, 400, { field: "subdomain" });
  const t = await appTarget(wsId, name, ours, site, true);
  held(ours);
  if (!t) throw new HostedAppError(LOST, 409);
  if (typed) {
    const there = t.all.find((d) => d.domain.toLowerCase() === typed);
    if (there) throw new HostedAppError(t.mine.includes(there) ? "That domain points at this app already." : "That domain points at another app on this computer. Remove it there first.", 409, { field: "domain" });
    // Cloudflare first: one whose zone is in the user's Cloudflare goes in from there, with what Bops would set
    // for it (its plan, set on their word); only one that isn't gets the records to copy where its DNS is kept.
    const cf = await within(cfZoneOfTyped(t, wsId, typed, ours).catch(() => null), CF_LOOK_MS);
    held(ours);
    if (cf) return connectFromCloudflare(wsId, name, { zone: cf.id, subdomain: cf.sub }, site);
    return pointHere(wsId, name, t, { domain: typed }, ours);
  }
  const project = await computerProject(t, wsId, ours);
  const list = project ? await domains.bought(project).catch((e: unknown) => Promise.reject(dnsRefused(e))) : null;
  held(ours);
  const b = list?.domains?.find((d) => d.id.toLowerCase() === zone && d.status === "active");
  if (!b) throw new HostedAppError("That isn't one of this workspace's domains.", 404);
  const full = sub ? `${sub}.${b.domain.toLowerCase()}` : b.domain.toLowerCase();
  const field = sub ? { field: "subdomain" } : undefined;
  // On this computer already (this app, or another one here), or on another computer: nothing is sent.
  const onHere = t.all.find((d) => d.domain.toLowerCase() === full);
  if (onHere) {
    const other = onHere.target_port === t.port ? name : (await portsOn(wsId, t.h.computerId))?.get(onHere.target_port)?.app;
    held(ours);
    throw new HostedAppError(`${full} is on ${other ?? "another app on this computer"} already.`, 409, field);
  }
  const elsewhere = (b.pointed ?? []).find((p) => p.domain.toLowerCase() === full);
  if (elsewhere) throw new HostedAppError(`${full} is on ${elsewhere.computer_name ?? "another computer"} already.`, 409, field);
  return pointHere(wsId, name, t, { registered_domain_id: b.id, subdomain: sub }, ours, full);
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
  const t = await appTarget(wsId, name, ours, site, true);
  held(ours);
  if (!t) throw new HostedAppError(LOST, 409);
  if (t.port === null) throw new HostedAppError("Orgo doesn't say which port this app listens on, so no domain can point at it.", 409);
  const project = await computerProject(t, wsId, ours);
  if (!project) throw new HostedAppError(NO_PROJECT, 409);
  held(ours);
  const price = ask.price;
  const bought = await buyingOnce(project, domain, () => domains.buy(project, domain, registrant, price)).catch((e: unknown) => Promise.reject(buyFailed(e, domain, true)));
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
      error: `Bought ${bought.domain}, but it isn't pointed at this app yet: ${why.replace(/\s*Try again[^.]*\.?$/, "").replace(/\.$/, "")}. It's under Your domains: press Use there to try again.`,
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
  // The user's Cloudflare zones read alongside Orgo's check, never holding it up (cfZonesForLook never fails).
  return checkMine(t, d, ours, d.managed ? null : cfZonesForLook(t, wsId, ours));
}

/**
 * checkDomain of one read already (`t`, `d`), each answer with `zones` (the user's Cloudflare ones, for
 * AppDomain.cloudflare, or the read of them under way). `justSet`: Bops just set its records in Cloudflare, so
 * a check that doesn't find them yet says they take a minute or two there, never that they aren't set.
 */
async function checkMine(t: Target, d: OrgoCustomDomain, ours: () => boolean, zones: CfZone[] | null | Promise<CfZone[] | null>, justSet = false): Promise<AppDomainChecked> {
  const of = async (x: OrgoCustomDomain, look = false) => domainOf(t, x, look, zones);
  if (d.status === "active") {
    // Live already: one bought elsewhere is looked at again, to say whether what routes it is still set.
    const now = await of(d, !d.managed);
    if (d.managed || !now.publish.some((r) => r.found)) return { domain: now };
    const at = now.where ? `at ${now.where}` : "where its DNS is kept";
    const off = now.publish.filter((r) => r.found !== "ok").map((r) => r.type);
    if (justSet) return { domain: now, said: off.length ? CF_WORDS.justSet : `Its records ${at} are set right.` };
    return { domain: now, said: off.length ? `Its ${off.join(" and ")} record ${at} isn't set as shown, so it may not reach this app.` : `Its records ${at} are set right.` };
  }
  if (d.status === "disabled") return { domain: await of(d), said: "Orgo turned this domain off. Ask Orgo support to turn it back on." };
  held(ours);
  try {
    const r = await domains.verify(t.h.computerId, d.id);
    held(ours);
    const status = r?.status === "active" ? "active" : "verifying";
    return { domain: await of({ ...d, status }) };
  } catch (e) {
    if (e instanceof HostedAppError) throw e;
    if (!(e instanceof OrgoError)) throw e;
    held(ours);
    if (e.status === 409 && (e.code === "TXT_NOT_FOUND" || e.code === "DNS_NOT_POINTED")) {
      const said = d.managed
        ? "Orgo set its records. They can take a few minutes to answer."
        : justSet
          ? CF_WORDS.justSet
          : e.code === "TXT_NOT_FOUND"
            ? "The records aren't there yet. New ones can take a few minutes to show up."
            : `${d.domain} doesn't point at Orgo yet. New records can take a few minutes to show up.`;
      return { domain: await of({ ...d, status: "verifying" }), said };
    }
    if (e.status === 409 && e.answer?.status === "disabled") return { domain: await of({ ...d, status: "disabled" }), said: "Orgo turned this domain off. Ask Orgo support to turn it back on." };
    if (e.status === 403 && !e.code && e.said) throw new HostedAppError(`Orgo says: ${e.said}`, 403);
    throw connectRefused(e);
  }
}

/**
 * DELETE /api/hosted-apps/[name]/domains/[domainId]: one of its domains taken off the app (a bought one's
 * records Orgo wrote for it go too; the domain itself stays the workspace's). One in the user's Cloudflare:
 * once Orgo took it off, the records Bops set for it there go too (only those: by their tag), and when
 * they can't, `said` names them, to remove there. Answers its domains as they are now.
 */
export async function removeDomain(wsId: string, name: string, domainId: string, site?: unknown): Promise<AppDomainRemoved> {
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
  const left = d.managed ? undefined : await cloudflareCleaned(cfScopeOnce(wsId, t.h.computerId, ours), d, ours);
  const said = left && `Removed from this app. ${cfLeftWords([left])}`;
  const now = await domainsNow(wsId, name, ours, t.h.site);
  return said ? { ...now, said } : now;
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
  const r = await domains.autoRenew(t.project, asked, on).catch((e: unknown) => Promise.reject(renewRefused(e)));
  held(ours);
  return { renewal: renewalOf(r?.domain) ?? null };
}

/** Orgo's refusals of turning auto-renew on or off, in Bops' words. */
export function renewRefused(e: unknown) {
  if (e instanceof OrgoError && e.code === "ACCOUNT_KEY_REQUIRED") return new HostedAppError("Changing auto-renew needs your own Orgo sign in, not a key for one workspace.", 403);
  if (e instanceof OrgoError && e.code === "workspace_read_only") return new HostedAppError("Your access to this workspace is view only, so its renewals aren't yours to change.", 403);
  if (e instanceof OrgoError && e.code === "INVALID_AUTO_RENEW") return new HostedAppError("Say whether it renews.", 400);
  return dnsRefused(e);
}

/* ---------------- Its domains in the user's own Cloudflare ---------------- */

/** How long Add a domain waits for the user's Cloudflare domains, and a look at the app's domains for their zones: past it, they're unsaid. */
const CF_OPTIONS_MS = 5000;
const CF_LOOK_MS = 4000;

/** The Cloudflare key this app's domains use (cloudflare.ts cloudflareScope): its computer's Orgo workspace asked only when that decides it. */
const cfScopeOf = (t: Target, wsId: string, ours: () => boolean) => cloudflareScope(wsId, () => domainsProjectOf(wsId, t.h.computerId, ours));

/**
 * The user's Cloudflare zones, for a look at the app's domains: only when one of them is bought elsewhere,
 * for a few seconds at most; none when there's no key or they can't be read (each domain is as it was then;
 * a read that failed is said again for a minute, never asked again on every check). Never fails.
 */
async function cfZonesForLook(t: Target, wsId: string, ours: () => boolean): Promise<CfZone[] | null> {
  if (!t.mine.some((d) => !d.managed && d.status !== "disabled")) return null;
  return within(
    (async () => {
      const scope = await cfScopeOf(t, wsId, ours);
      return scope ? (await cfZones(scope, { look: true })).zones : null;
    })(),
    CF_LOOK_MS,
  );
}

/** Cloudflare's refusals as the routes answer them, in words; `zone` and `phase` say which ones are about reading or changing its DNS. */
const CF_CODES: Record<CloudflareError["kind"], string> = {
  notReady: "CF_NOT_READY",
  gone: "CF_KEY_GONE",
  auth: "CF_REFUSED",
  limit: "CF_LIMITED",
  down: "CF_DOWN",
  clash: "STALE",
  signIn: "CF_SIGN_IN",
  other: "CF_SAYS",
};
function cfRefused(e: unknown, zone?: string, phase?: "read" | "write"): unknown {
  if (!(e instanceof CloudflareError)) return e;
  if (e.kind === "auth" && zone && phase === "read") return new HostedAppError(CF_WORDS.noRead(zone), 403, { code: "NO_READ" });
  if (e.kind === "auth" && zone && phase === "write") return new HostedAppError(CF_WORDS.noEdit(zone), 403, { code: "NO_EDIT" });
  // A write that went out and got no answer: whether it went in isn't known.
  if (e.kind === "down" && phase === "write") return new HostedAppError(CF_WORDS.unknown, 504, { code: "UNKNOWN" });
  return new HostedAppError(e.message, e.status, { code: CF_CODES[e.kind] });
}

/**
 * What Add a domain offers from the user's Cloudflare: each of the key's active zones, with the names on this
 * app's computer that are it or under it (the app that serves each, as Your domains says it), the account's
 * name on each when there's more than one, or why none. Undefined: no Cloudflare key, so nothing changes.
 */
async function cloudflareOptions(wsId: string, name: string, t: Target, ours: () => boolean): Promise<CloudflareOptions | null> {
  const scope = await cfScopeOf(t, wsId, ours);
  if (!scope) return null;
  let got: { zones: CfZone[]; more: boolean };
  try {
    got = await cfZones(scope);
  } catch (e) {
    return { why: e instanceof CloudflareError ? e.message : CF_WORDS.down };
  }
  if (!got.zones.length) return { why: CF_WORDS.noZones };
  const accounts = new Set(got.zones.map((z) => z.account?.id ?? ""));
  const inZone = (z: CfZone) => t.all.filter((d) => zoneFor(d.domain, got.zones)?.id === z.id);
  const others = got.zones.some((z) => inZone(z).some((d) => d.target_port !== t.port)) ? await portsOn(wsId, t.h.computerId) : null;
  return {
    zones: got.zones.map((z) => ({
      id: z.id,
      domain: z.name,
      ...(accounts.size > 1 && z.account?.name ? { account: z.account.name } : {}),
      inUse: inZone(z).map((d) => {
        const app = d.target_port === t.port ? name : others?.get(d.target_port)?.app;
        return app ? { name: d.domain.toLowerCase(), app } : { name: d.domain.toLowerCase(), where: "another app on this computer" };
      }),
    })),
    ...(got.more ? { more: true as const } : {}),
  };
}

/** The zone of the user's Cloudflare a typed domain is in (its id there, and the name under it: "" for the zone itself), or null: no key, or not one of its zones. */
async function cfZoneOfTyped(t: Target, wsId: string, typed: string, ours: () => boolean): Promise<{ id: string; sub: string } | null> {
  const scope = await cfScopeOf(t, wsId, ours);
  if (!scope) return null;
  const z = zoneFor(typed, (await cfZones(scope)).zones);
  if (!z) return null;
  return { id: z.id, sub: typed === z.name ? "" : typed.slice(0, -(z.name.length + 1)) };
}

/** The key, and the zone of the user's Cloudflare one of the app's domains is in (never the window's word: the key's zones, read again). */
async function cfZoneOf(t: Target, wsId: string, d: OrgoCustomDomain, ours: () => boolean): Promise<{ scope: CloudflareScope; z: CfZone }> {
  if (d.managed) throw new HostedAppError(`Orgo keeps the DNS of ${d.domain} itself.`, 409);
  const scope = await cfScopeOf(t, wsId, ours);
  held(ours);
  if (!scope) throw new HostedAppError(CF_WORDS.gone, 404, { code: "CF_KEY_GONE" });
  const { zones } = await cfZones(scope).catch((e: unknown) => Promise.reject(cfRefused(e)));
  held(ours);
  const z = zoneFor(d.domain, zones);
  if (!z) throw new HostedAppError(CF_WORDS.notIn(d.domain), 404);
  return { scope, z };
}

/**
 * What Bops would set in Cloudflare for one of the app's domains (cloudflare.ts planRecords): the records Orgo
 * asks for (its own list for the domain, in full; once it's live, only what routes it), against what's at those
 * names in the zone now. Another domain on this computer is named by its app (its deploy projects read only then).
 */
async function planFor(t: Target, wsId: string, name: string, d: OrgoCustomDomain, z: CfZone, scope: CloudflareScope, ours: () => boolean) {
  const live = d.status === "active";
  const inZone = (n: string) => n === z.name || n.endsWith(`.${z.name}`);
  const want: Wanted[] = (d.dns_records ?? [])
    .filter((r) => !live || r.type.toUpperCase() !== "TXT")
    .map((r) => ({ type: r.type.toUpperCase(), name: (r.name || "").toLowerCase().replace(/\.$/, ""), value: r.value }))
    .filter((w) => w.name && w.value && inZone(w.name));
  const found = await recordsAt(scope, z.id, want.map((w) => w.name)).catch((e: unknown) => Promise.reject(cfRefused(e, z.name, "read")));
  held(ours);
  const tagged = new Set(found.map((r) => ourId(r.comment)).filter((id): id is string => !!id && id !== d.id));
  const named = t.all.filter((x) => x.id !== d.id && tagged.has(x.id));
  const ports = named.some((x) => x.target_port !== t.port) ? await portsOn(wsId, t.h.computerId) : null;
  held(ours);
  const here = new Map<string, string | null>(t.all.filter((x) => x.id !== d.id).map((x) => [x.id, x.target_port === t.port ? name : (ports?.get(x.target_port)?.app ?? null)]));
  return planRecords({ zone: { id: z.id, name: z.name }, domain: { id: d.id, name: d.domain }, app: name, want, found, here });
}

/**
 * POST /api/hosted-apps/[name]/domains "cloudflare": one of the user's Cloudflare domains (by its id there,
 * found again among the key's zones), or the name `subdomain` under it, pointed at the app as one the user
 * owns (Orgo answers the records to set), and what Bops would set in Cloudflare for it (`cloudflare`; `fresh`:
 * Cancel takes it off again). A name on this computer already is refused before Orgo is asked. Nothing is
 * written in Cloudflare here: that's the user's Add on the plan (cloudflareApply). The plan not read (Cloudflare
 * not answering): the domain is added all the same, said in `error`, and its line offers Set it in Cloudflare.
 */
export async function connectFromCloudflare(wsId: string, name: string, ask: { zone?: unknown; subdomain?: unknown }, site?: unknown): Promise<AppDomainAdded> {
  const ours = sameState();
  const zoneId = typeof ask.zone === "string" && ZONE_ID.test(ask.zone) ? ask.zone : null;
  if (!zoneId) throw new HostedAppError(CF_WORDS.notZone, 404);
  const sub = ask.subdomain === undefined || ask.subdomain === null ? "" : subdomainTyped(ask.subdomain);
  if (sub === null) throw new HostedAppError(BAD_NAME, 400, { field: "subdomain" });
  const t = await appTarget(wsId, name, ours, site, true);
  held(ours);
  if (!t) throw new HostedAppError(LOST, 409);
  const scope = await cfScopeOf(t, wsId, ours);
  held(ours);
  if (!scope) throw new HostedAppError(CF_WORDS.gone, 404, { code: "CF_KEY_GONE" });
  const { zones } = await cfZones(scope).catch((e: unknown) => Promise.reject(cfRefused(e)));
  held(ours);
  const z = zones.find((x) => x.id === zoneId);
  if (!z) throw new HostedAppError(CF_WORDS.notZone, 404);
  const full = sub ? `${sub}.${z.name}` : z.name;
  const field = sub ? { field: "subdomain" } : undefined;
  if (domainTyped(full) !== full) throw new HostedAppError(BAD_NAME, 400, { field: "subdomain" });
  const onHere = t.all.find((d) => d.domain.toLowerCase() === full);
  if (onHere) {
    const other = onHere.target_port === t.port ? name : (await portsOn(wsId, t.h.computerId))?.get(onHere.target_port)?.app;
    held(ours);
    throw new HostedAppError(`${full} is on ${other ?? "another app on this computer"} already.`, 409, field);
  }
  const { added, c } = await pointedHere(wsId, name, t, { domain: full }, ours).catch((e: unknown) =>
    Promise.reject(e instanceof HostedAppError && e.status === 409 && e.extra?.field === "domain" ? new HostedAppError(`${full} is on another Orgo computer already.`, 409, field) : e),
  );
  if (c.managed) return added;
  try {
    const { plan } = await planFor(t, wsId, name, c, z, scope, ours);
    return { ...added, cloudflare: plan, fresh: true };
  } catch (e) {
    if (e instanceof HostedAppError && e.message === SWAPPED) throw e;
    return { ...added, error: e instanceof HostedAppError || e instanceof CloudflareError ? e.message : CF_WORDS.down };
  }
}

/** GET /api/hosted-apps/[name]/domains/[domainId]/cloudflare: what Bops would set in Cloudflare for one of its domains, read now. Nothing is written. */
export async function cloudflarePlan(wsId: string, name: string, domainId: string, site?: unknown): Promise<CloudflarePlan> {
  const ours = sameState();
  const { t, d } = await mineOf(wsId, name, domainId, ours, site);
  const { scope, z } = await cfZoneOf(t, wsId, d, ours);
  return (await planFor(t, wsId, name, d, z, scope, ours)).plan;
}

/**
 * POST /api/hosted-apps/[name]/domains/[domainId]/cloudflare { plan, replace? }: the plan the user saw written,
 * only if it's still the plan (Cloudflare read again, and planned again: anything changed since is STALE, with
 * the plan as it is now, and nothing is written), only with their OK when it replaces a record Bops didn't set
 * (`replace`, which only Replace and add sends), never when it's blocked. All of it in one Cloudflare batch,
 * then Orgo asked to check the domain (records just set can take a minute to answer: said so). Sent again after
 * a failure, it finds its own records and writes no second copy.
 */
export async function cloudflareApply(wsId: string, name: string, domainId: string, ask: { plan?: unknown; replace?: unknown }, site?: unknown): Promise<CloudflareApplied> {
  if (typeof ask.plan !== "string" || !/^[0-9a-f]{16}$/.test(ask.plan)) throw new HostedAppError("Look at the changes first.", 400);
  const ours = sameState();
  const { t, d } = await mineOf(wsId, name, domainId, ours, site);
  const { scope, z } = await cfZoneOf(t, wsId, d, ours);
  const now = await planFor(t, wsId, name, d, z, scope, ours);
  held(ours);
  if (now.plan.fingerprint !== ask.plan) throw new HostedAppError(CF_WORDS.stale, 409, { code: "STALE", cloudflare: now.plan });
  if (now.plan.blocked) throw new HostedAppError(now.plan.blocked, 409, { code: "BLOCKED", cloudflare: now.plan });
  if (now.plan.ask && ask.replace !== true) throw new HostedAppError(CF_WORDS.needsOk, 409, { code: "NEEDS_OK", cloudflare: now.plan });
  let written = 0;
  if (batchSize(now.batch)) {
    try {
      written = await applyBatch(scope, z.id, now.batch);
    } catch (e) {
      // A record made there meanwhile clashed: nothing went in, so the plan as it is now.
      if (e instanceof CloudflareError && e.kind === "clash") {
        held(ours);
        const again = await planFor(t, wsId, name, d, z, scope, ours).catch(() => null);
        throw new HostedAppError(CF_WORDS.stale, 409, { code: "STALE", ...(again ? { cloudflare: again.plan } : {}) });
      }
      throw cfRefused(e, z.name, "write");
    }
  }
  held(ours);
  return { ...(await checkMine(t, d, ours, [z], true)), written };
}

/**
 * What Bops couldn't take off in the user's Cloudflare for a domain gone from the app: its records there, by
 * type and name in full, and the zone they're in when it's known. `sure`: they were read, so they're Bops'
 * own; else they're the ones Orgo asked for, which Bops may or may not have set there.
 */
type CfLeft = { records: { type: string; name: string }[]; zone: string | null; sure: boolean };

/**
 * "Bops couldn't reach Cloudflare, so remove TXT _orgo-verify.shop and CNAME shop there.": what's left there,
 * as a list in words (each as its zone names it when they're all in one, else in full). Not sure they're
 * Bops' own: "If it set … there, remove them."
 */
function cfLeftWords(lefts: CfLeft[]): string | undefined {
  const rs = lefts.flatMap((l) => l.records);
  if (!rs.length) return undefined;
  const zones = new Set(lefts.map((l) => l.zone));
  const zone = zones.size === 1 ? [...zones][0] : null;
  const w = rs.map((r) => `${r.type} ${zone ? hostIn(r.name, zone) : r.name}`);
  const list = w.length < 2 ? w[0] : `${w.slice(0, -1).join(", ")} and ${w.at(-1)}`;
  return lefts.every((l) => l.sure) ? `Bops couldn't reach Cloudflare, so remove ${list} there.` : `Bops couldn't reach Cloudflare. If it set ${list} there, remove ${rs.length === 1 ? "it" : "them"}.`;
}

/** The Cloudflare key a computer's domains use (cfScopeOf), read once however many of them go; null: none, or the vault not answering. */
const cfScopeOnce = (wsId: string, computerId: string, ours: () => boolean) => {
  let p: Promise<CloudflareScope | null> | undefined;
  return () => (p ??= cloudflareScope(wsId, () => domainsProjectOf(wsId, computerId, ours)).catch(() => null));
};

/**
 * Once Orgo took one of an app's domains off (Remove on its line, Remove site, Remove app), the records Bops
 * set for it in the user's Cloudflare go too: only the ones its tag says are this domain's, in one batch.
 * When that can't be done, what's left there (CfLeft): the records read, else the ones Orgo asked for in the
 * zone it's in, else (the key's zones not read now, nor kept from before) in full.
 */
async function cloudflareCleaned(scopeOf: () => Promise<CloudflareScope | null>, d: OrgoCustomDomain, ours: () => boolean): Promise<CfLeft | undefined> {
  const scope = await scopeOf();
  held(ours);
  if (!scope) return undefined;
  const zones = await cfZones(scope, { kept: true }).catch(() => null);
  held(ours);
  const asked = () => (d.dns_records ?? []).map((r) => ({ type: r.type.toUpperCase(), name: (r.name || "").toLowerCase().replace(/\.$/, "") })).filter((r) => r.name);
  const z = zones ? zoneFor(d.domain, zones.zones) : undefined;
  if (!z) {
    // Its zone not one of the key's: nothing of it there. The key's zones not read: whether it is isn't known.
    if (zones) return undefined;
    const records = asked();
    return records.length ? { records, zone: null, sure: false } : undefined;
  }
  let found: { type: string; name: string }[] | null = null;
  try {
    const mine = await ourRecords(scope, z.id, d.id);
    found = mine;
    held(ours);
    await applyBatch(scope, z.id, { deletes: mine.map((r) => ({ id: r.id })), patches: [], posts: [] });
    return undefined;
  } catch (e) {
    if (e instanceof HostedAppError && e.message === SWAPPED) throw e;
    const records = found ?? asked();
    return records.length ? { records, zone: z.name, sure: !!found } : undefined;
  }
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
  if (STAGING_LIKE.test(typed)) throw new HostedAppError("A site's name can't end in staging. Pick another name.", 400, { field: "site" });
  if (typed === name || h.sites?.some((x) => x.name === typed)) throw new HostedAppError(`${name} has a site called ${typed} already. Pick another name.`, 409, { field: "site" });
  if (1 + (h.sites?.length ?? 0) >= MAX_SITES) throw new HostedAppError(`An app can have ${MAX_SITES} sites at most, as many as one computer runs.`, 409, { field: "site" });
  notRemoving(wsId, name);
  keepHosting(wsId, name, (x) => x && { ...x, sites: [...(x.sites ?? []).filter((y) => y.name !== typed), { name: typed }] });
  return { app: await appNow(wsId, name, ours) };
}

/**
 * One site taken off its computer: the domains there on its port first (a bought one's records Orgo wrote
 * go with it; the domain itself stays the workspace's; one in the user's Cloudflare, the records Bops set
 * for it there too, cloudflareCleaned), then its deploy project (its runner, releases and public URL). One
 * Orgo has no more is gone already. Answers the domains Orgo wouldn't remove (one it turned off), and what
 * Bops couldn't take off in Cloudflare, which are said; any other refusal stops it, nothing kept changed.
 */
async function takeDown(wsId: string, s: SiteHosting, ours: () => boolean): Promise<TakenDown> {
  const none: TakenDown = { left: [], cf: [] };
  if (!s.projectId || s.lost) return none;
  const p = await deploys.project(s.computerId, s.projectId).catch((e: unknown) => e as Error);
  held(ours);
  if (gone(p)) return none;
  if (p instanceof Error) throw refused(p);
  if (!p.enabled) throw new HostedAppError(p.why, 403);
  const port = typeof p.value.port === "number" ? p.value.port : null;
  const left: string[] = [];
  const cf: CfLeft[] = [];
  const scopeOf = cfScopeOnce(wsId, s.computerId, ours);
  if (port !== null) {
    const list = await domains.ofComputer(s.computerId).catch((e: unknown) => Promise.reject(dnsRefused(e)));
    held(ours);
    for (const d of (list.domains ?? []).filter((x) => x.target_port === port)) {
      const r = await domains.remove(s.computerId, d.id).then(
        () => null,
        (e: unknown) => e,
      );
      held(ours);
      if (r instanceof OrgoError && r.status === 409) left.push(d.domain);
      else if (r && !(r instanceof OrgoError && r.status === 404)) throw connectRefused(r);
      // Off Orgo (or gone already): one in the user's Cloudflare, what Bops set for it there too.
      else if (!d.managed) {
        const x = await cloudflareCleaned(scopeOf, d, ours);
        if (x) cf.push(x);
      }
    }
  }
  const r = await deploys.remove(s.computerId, s.projectId).catch((e: unknown) => e as Error);
  held(ours);
  if (r instanceof Error && !gone(r)) throw refused(r);
  if (!(r instanceof Error) && !r.enabled) throw new HostedAppError(r.why, 403);
  return { left, cf };
}

/** What takeDown couldn't take off: the domains Orgo kept, and what's left in the user's Cloudflare. */
type TakenDown = { left: string[]; cf: CfLeft[] };

/**
 * The Previews of some of an app's sites (`sites`) taken off its computer: each one's project (found by its
 * label, so whichever Mac made it), then its link, there and on every computer it left (behind): once gone,
 * anyone may take its name, so the user removes it from Google sign in too (the window says so). One whose
 * computer is gone went with it.
 */
async function previewDown(wsId: string, name: string, h: AppHosting, sites: string[], ours: () => boolean): Promise<TakenDown> {
  const out: TakenDown = { left: [], cf: [] };
  const repo = repoOrNull(wsId, name);
  if (h.lost || !repo) return out;
  // (Hosting not open to the account: it never had one.)
  const list = await projectsNow(h.computerId, ours).catch((e: unknown) => (e instanceof HostedAppError && (e.status === 404 || e.status === 403) ? [] : Promise.reject(e)));
  const { urls } = await urlsNow(h.computerId, ours).catch(() => ({ urls: [] as OrgoPublicUrl[] }));
  const behind = [...new Set((h.behind ?? []).map((b) => b.computerId))].filter((c) => c !== h.computerId);
  for (const site of sites) {
    const s = siteIn(h, name, site);
    const f = previewIn(list, urls, repo, site, knownLabel(s, h, name, repo, list, urls));
    if (f?.project) {
      const x = await takeDown(wsId, { botId: h.botId, computerId: h.computerId, projectId: f.project.id, site }, ours);
      out.left.push(...x.left);
      out.cf.push(...x.cf);
    }
    if (f?.url) {
      await publicUrls.remove(h.computerId, f.url.id).catch(() => null);
      held(ours);
    }
    for (const c of behind) {
      const r = await publicUrls.list(c).catch(() => null);
      held(ours);
      const u = r?.enabled && r.value.enabled ? r.value.public_urls?.find((x) => isLabelOf("preview", x.label, repo, site) || (!!s.preview && x.label === s.preview)) : undefined;
      if (u) await publicUrls.remove(c, u.id).catch(() => null);
    }
  }
  return out;
}

/** What a removal says of the domains Orgo kept (turned off, so only Orgo support can remove them), and of what's left in Cloudflare. */
const keptDomains = ({ left, cf }: TakenDown) =>
  [
    left.length ? `${left.join(", ")} ${left.length === 1 ? "is" : "are"} still on its computer: Orgo turned ${left.length === 1 ? "it" : "them"} off, so only Orgo support can remove ${left.length === 1 ? "it" : "them"}.` : undefined,
    cfLeftWords(cf),
  ]
    .filter(Boolean)
    .join(" ") || undefined;

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
    // Its Preview first (its project, then its link), then its Published (with its domains).
    const staged = await previewDown(wsId, name, now, [s.site], ours);
    const prod = await takeDown(wsId, s, ours);
    const left = keptDomains({ left: [...staged.left, ...prod.left], cf: [...staged.cf, ...prod.cf] });
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
 * a computer it moved off (behind) are taken down the same. Its Locals there are stopped and forgotten, and its
 * working folder goes with its repo (forgetLocals), and its previews on this Mac close. Not while a task is at
 * work on it (the task would make its record again), nor while a deploy of it is being sent or a first save
 * makes a project (withApp).
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
  const left: TakenDown = { left: [], cf: [] };
  const add = (x: TakenDown) => void (left.left.push(...x.left), left.cf.push(...x.cf));
  // Every site's Preview first (found on its computer by its label), then each site's Published.
  // (Not when Bops can't reach Orgo's hosting at all, signed out: then nothing of it can be read, and it never had a Preview from here.)
  if (!h.lost && (sites.length || behind.length || repo || !(await closedHere()))) add(await previewDown(wsId, name, h, sitesOf(h, name).map((x) => x.site), ours));
  for (const s of sites) {
    add(await takeDown(wsId, s, ours));
    keepSite(wsId, name, s.site, () => ({}));
  }
  // (One whose computer is gone since went with it: Orgo has neither.)
  const gone404 = (e: unknown): TakenDown | Promise<never> => (e instanceof HostedAppError && e.status === 404 ? { left: [], cf: [] } : Promise.reject(e));
  for (const b of behind) {
    add(await takeDown(wsId, { botId: h.botId, computerId: b.computerId, projectId: b.projectId, site: b.site }, ours).catch(gone404));
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
  // Its Locals on its computer and on any it moved off: best effort, so one that can't be reached never keeps it.
  for (const c of new Set([...(h.lost ? [] : [h.computerId]), ...behind.map((b) => b.computerId)])) await forgetLocals(wsId, name, c, repo, ours).catch(() => {});
  held(ours);
  localRead.delete(`${wsId}/${name}`);
  keepHosting(wsId, name, () => undefined);
  closeForward(`${wsId}/${name}/`);
  const said = keptDomains(left);
  return { removed: name, repo, ...(said ? { said } : {}) };
}

/* ---------------- Local: its working folder run as a dev server on its computer ---------------- */

/** Where bops-local goes on a computer (vm/bin/bops-local), and this Bops' copy of it. */
export const LOCAL_BIN = "/usr/local/bin/bops-local";
const localScript = () => readFileSync(process.env.BOPS_LOCAL_SCRIPT || join(/*turbopackIgnore: true*/ process.cwd(), "vm/bin/bops-local"));
/** A bops-local's version, from its BOPS_LOCAL_VERSION line (0: one from before it had one). */
export const localVersion = (body: string) => Number(/^BOPS_LOCAL_VERSION=(\d{1,6})$/m.exec(body)?.[1] ?? 0);
/**
 * The computers whose bops-local this Bops found as new as its own, or put there, and when: looked at again after
 * LOCAL_TOOL_MS, or as soon as an older one answers (localBash), since an older Mac (v0.0.32 to v0.0.34) puts its
 * own back whenever the file there isn't the same as its own.
 */
const localChecked = new Map<string, { version: number; at: number }>();
const LOCAL_TOOL_MS = 3 * 60_000;

/**
 * bops-local on the app's computer, at least as new as this Bops has it: put there when it's missing or older
 * (one quick command), never over a newer one another Mac put there (a newer one still takes what this Bops
 * asks of it), so Macs on different builds never swap it back and forth.
 */
async function localTool(computerId: string, ours: () => boolean) {
  const body = localScript();
  const version = localVersion(body.toString("utf8"));
  const kept = localChecked.get(computerId);
  if (kept?.version === version && Date.now() - kept.at < LOCAL_TOOL_MS) return;
  const r = await orgo.bash(
    computerId,
    [
      "# bops-local install",
      `have=$(grep -m1 -oE '^BOPS_LOCAL_VERSION=[0-9]+' ${LOCAL_BIN} 2>/dev/null | cut -d= -f2)`,
      `if [ ! -x ${LOCAL_BIN} ] || [ "\${have:-0}" -lt ${version} ]; then`,
      `  printf %s ${body.toString("base64")} | base64 -d > ${LOCAL_BIN}.new && chmod 755 ${LOCAL_BIN}.new && mv -f ${LOCAL_BIN}.new ${LOCAL_BIN} || { echo BOPS_LOCAL_FAIL=install; exit 1; }`,
      "fi",
      "echo BOPS_LOCAL_TOOL=ok",
    ].join("\n"),
    30,
  );
  held(ours);
  if (!/BOPS_LOCAL_TOOL=ok/.test(r.output)) throw new HostedAppError("Couldn't set Local up on its computer. Try again in a minute.", 502);
  localChecked.set(computerId, { version, at: Date.now() });
}

/**
 * Whether bops-local's answer is an older one's, put back on its computer since this Bops last looked (localTool):
 * it refuses what only a newer one takes (usage: mark, forget only; bad-port: auto; bad-screen: a screen; bad-name: a
 * copy's <name>.<copy>, which Bops checks before it asks), or says a Local without the BOPS_LOCAL_MORE line a newer one
 * says after every BOPS_LOCAL line.
 */
const olderLocal = (output: string) => /^BOPS_LOCAL_FAIL=(?:usage|bad-port|bad-screen|bad-name)$/m.test(output) || (/^BOPS_LOCAL \S/m.test(output) && !/^BOPS_LOCAL_MORE /m.test(output));

/**
 * bops-local commands (`script`) on the app's computer, run once localTool put it there: when an older one
 * answers (olderLocal), this Bops' is put back and they're run once more, that answer the one that stands.
 */
async function localBash(computerId: string, script: string, timeout: number, ours: () => boolean) {
  const r = await orgo.bash(computerId, script, timeout);
  held(ours);
  if (!olderLocal(r.output)) return r;
  localChecked.delete(computerId);
  await localTool(computerId, ours);
  const again = await orgo.bash(computerId, script, timeout);
  held(ours);
  return again;
}

/**
 * An app's Locals on a computer (`computerId`) as it's removed: every site's stopped and forgotten there, every bot's
 * copy's too (bops-local forget: their files go, so their ports are free for the next app's), and its working folder
 * and every copy of it too when its repo went (`folder`), each only when it's this workspace's repo's: one that isn't
 * an Ingot working folder may hold work, and another workspace's app by the same name (the computer works for both)
 * is left as it is, Locals and all. Never on a computer that sleeps: it isn't woken for this.
 */
async function forgetLocals(wsId: string, name: string, computerId: string, folder: boolean, ours: () => boolean) {
  if (!isRepoName(name) || (await asleepNow(computerId).catch(() => true))) return;
  held(ours);
  const repo = repoOrNull(wsId, name);
  const dir = appFolder(name);
  const state = `${dir}/.ingot/state.json`;
  const field = (k: string, file = state) => `$(sed -n 's/^ *"${k}": "\\([a-z0-9-]*\\)".*/\\1/p' ${file} 2> /dev/null | head -n 1)`;
  await localTool(computerId, ours);
  await localBash(
    computerId,
    [
      `# bops-local forget ${name}`,
      `there=""; [ ! -f ${state} ] || there="${field("workspace")}/${field("repo")}"`,
      `if [ -n "\${there%%/*}" ] && [ "\${there%%/*}" != local ] && [ "$there" != '${repo ?? "-"}' ]; then echo BOPS_LOCAL_OTHER=1; exit 0; fi`,
      `${LOCAL_BIN} forget ${name}`,
      // (Its bots' copies, each its repo's: a folder of the same name that isn't, or a git clone beside it, stays.)
      ...(folder && repo ? [`for d in ${dir}.*; do s="$d/.ingot/state.json"; if [ -f "$s" ] && [ "${field("workspace", '"$s"')}/${field("repo", '"$s"')}" = '${repo}' ]; then rm -rf "$d" && echo "BOPS_LOCAL_COPY=gone"; fi; done`] : []),
      ...(folder && repo ? [`if [ "$there" = '${repo}' ]; then rm -rf ${dir} && echo BOPS_LOCAL_FOLDER=gone; fi`] : []),
    ].join("\n"),
    60,
    ours,
  );
}

/** bops-local's refusals, in words (port-held and port-taken say their port: localFailed). */
const LOCAL_WORDS: Record<string, string> = {
  "no-folder": "Its working folder isn't on its computer yet. Ask its bot to work on it first.",
  "no-command": "Bops couldn't tell how to run it. Type the command that starts it.",
  "no-port": "No port from 3000 to 3099 is free on its computer.",
  "bad-port": "Use a port from 1024 to 65535.",
  "bad-screen": "Couldn't open it on that screen.",
  busy: "Its computer is busy starting another Local. Try again in a moment.",
  "not-started": "Start it first.",
  "no-browser": "Couldn't open it on its computer's screen. Open its screen and go to it there.",
  "bad-env": "Couldn't save its variables there. Try again.",
  "bad-name": "There's no site by that name in this app.",
  "bad-command": "Bops can't run that command.",
  write: "Couldn't write to its computer. Try again.",
};

const unb64 = (v: string) => (v === "-" ? null : Buffer.from(v, "base64").toString("utf8"));

/** How long a Local's state is kept before its computer is asked again (the window asks every few seconds while one starts). */
const LOCAL_MS = 4000;
const localRead = new Map<string, { at: number; answer: LocalAnswer }>();
/**
 * Whether this Mac reaches an app's computer over the tailnet, kept 30 seconds (each look waits up to 2.5): its
 * address there, from the bot whose computer it is (workBot: one that shares another's has no record of its own).
 */
const reachRead = new Map<string, { at: number; ip: string | null }>();
async function tailnetIp(h: AppHosting): Promise<string | null> {
  const b = bot(h.botId);
  const own = b && workBot(b, getState().bots);
  const c = own?.computerId === h.computerId ? own : getState().bots.find((x) => x.computerId === h.computerId);
  if (!c?.tailnet) return null;
  const kept = reachRead.get(c.id);
  if (kept && Date.now() - kept.at < 30_000) return kept.ip;
  const ip = (await tailnetUp(c)) ? c.tailnet.ip : null;
  reachRead.set(c.id, { at: Date.now(), ip });
  return ip;
}

/** A port as a bops-local line says it (1024 to 65535), else undefined. */
const portIn = (v: string | undefined) => {
  const n = v && /^\d{1,5}$/.test(v) ? Number(v) : NaN;
  return n >= 1024 && n <= 65535 ? n : undefined;
};

/**
 * What a BOPS_LOCAL_MORE line says of a Local (bops-local's second line, after its BOPS_LOCAL one), each only
 * when said and well formed: dev=<its port>, good=<changeset>:<when, seconds>, fixes=<n>, auth=<0|1>,
 * mismatch=<port>. A key it doesn't know (a newer bops-local's) is passed over.
 */
function moreOf(words: string): Partial<Pick<LocalSite, "devPort">> & Pick<LocalSite, "lastGood" | "fixes" | "auth" | "mismatch"> {
  const out: ReturnType<typeof moreOf> = {};
  for (const w of words.trim().split(/\s+/)) {
    const at = w.indexOf("=");
    const [k, v] = at > 0 ? [w.slice(0, at), w.slice(at + 1)] : [w, ""];
    if (k === "dev" && portIn(v)) out.devPort = portIn(v);
    else if (k === "good") {
      const m = /^([0-9a-f]{4,64}):(\d{1,12})$/.exec(v);
      if (m) out.lastGood = { at: m[1], when: Number(m[2]) * 1000 };
    } else if (k === "fixes" && /^\d{1,6}$/.test(v)) out.fixes = Number(v);
    else if (k === "auth" && (v === "0" || v === "1")) out.auth = v === "1";
    else if (k === "mismatch" && portIn(v)) out.mismatch = portIn(v);
  }
  return out;
}

/**
 * An app's Locals from bops-local's lines (`output`), by site: its sites' only, the newest line of each
 * standing; its own folder's (<name>--<site>) in `sites`, each other bot's that works on it (appCoders) in `copies`,
 * in their order, from its copy's (<name>.<copy>--<site>: one no bot of it has now is passed over), every such bot
 * there, its copy's Locals or none. Its BOPS_LOCAL line is v0.0.34's word for word; its BOPS_LOCAL_MORE line, when its
 * bops-local writes one, adds what it says (moreOf), its dev port among it (3000 from a bops-local that doesn't say
 * it). `bot`: whose the app's own folder is, while that bot is here.
 */
function localsFrom(output: string, h: AppHosting, name: string, wsId: string): Pick<LocalAnswer, "sites" | "bot" | "copies"> {
  const sites = new Set(sitesOf(h, name).map((x) => x.site));
  const coders = appCoders(getState(), wsId, name);
  const copies: LocalCopy[] = coders.filter((id) => ownCopy(h, id)).map((id) => ({ bot: id, name: bot(id)?.name ?? id, sites: {} }));
  const byWord = new Map<string, Record<string, LocalSite>>([[name, {}], ...copies.map((c) => [localWord(name, copyName(c.bot)), c.sites] as const)]);
  const more = new Map<string, string>();
  for (const m of output.matchAll(/^BOPS_LOCAL_MORE ([a-z0-9.-]+)--([a-z0-9-]+)((?: \S+)*)$/gm)) more.set(`${m[1]}--${m[2]}`, m[3]);
  for (const m of output.matchAll(/^BOPS_LOCAL (\S+)--(\S+) (running|starting|failed|stopped) (\S+) (\S+) (\S+) (\S+) (\S+)$/gm)) {
    const [, word, site, state, port, since, cmd, err, env] = m;
    const out = byWord.get(word);
    if (!out || !sites.has(site)) continue;
    const n = /^\d{1,5}$/.test(port) ? Number(port) : null;
    const said = moreOf(more.get(`${word}--${site}`) ?? "");
    out[site] = {
      state: state as LocalSite["state"],
      port: n,
      command: unb64(cmd),
      since: /^\d+$/.test(since) ? Number(since) * 1000 : null,
      // (Its log's last lines, as Fix it shows them; localWords says the last in one.)
      error: state === "failed" ? (unb64(err)?.split("\n").map((l) => l.trimEnd().slice(0, LOG_LINE)).filter((l) => l.trim()).slice(-LOG_LINES).join("\n").slice(-1500) || "It stopped.") : null,
      env: env === "-" ? [] : env.split(",").filter((x) => ENV_NAME.test(x)),
      ...said,
      devPort: said.devPort ?? DEV_PORT,
    };
  }
  const own = bot(h.botId) && !ownCopy(h, h.botId) ? { id: h.botId, name: bot(h.botId)!.name } : undefined;
  return { sites: byWord.get(name)!, ...(own ? { bot: own } : {}), ...(copies.length ? { copies } : {}) };
}

/**
 * Each of an app's open forwards (local-preview.ts) kept on its Local's port, each copy's too: the same port on this
 * Mac as on its computer, so one that moved (a Local started before ports were one a site, started again) moves here
 * too (one through SSH, through a tunnel to that port: carryTo); closed once it stopped.
 */
function followForwards(wsId: string, name: string, a: Pick<LocalAnswer, "sites" | "copies">) {
  const each = [...Object.entries(a.sites).map(([site, x]) => [fwdKey(wsId, name, site), x] as const), ...(a.copies ?? []).flatMap((c) => Object.entries(c.sites).map(([site, x]) => [fwdKey(wsId, name, site, c.bot), x] as const))];
  for (const [key, x] of each) {
    const f = forwardOf(key);
    if (!f) continue;
    if (x.state !== "running" && x.state !== "starting") closeForward(key);
    else if (f.via === "ssh") {
      if (x.port && x.port !== f.port) void carryTo(wsId, name, key, x.port);
    } else if (x.port && x.port !== f.macPort) {
      closeForward(key);
      void openForward({ key, app: name, macPort: x.port, host: f.host, port: x.port }).catch(() => {});
    } else if (x.port && x.port !== f.port) void openForward({ key, app: name, macPort: f.macPort, host: f.host, port: x.port }).catch(() => {});
  }
}

/** Forwards being moved to a tunnel to their Local's new port (carryTo), by key. */
const carrying = new Set<string>();

/**
 * A forward through SSH moved with its Local to `port`: a tunnel to that port, then the forward on the same port
 * here through it, once (one move at a time a forward). One closed meanwhile (its tab, Stop, the app removed)
 * stays closed; one that can't move closes.
 */
async function carryTo(wsId: string, name: string, key: string, port: number) {
  if (carrying.has(key)) return;
  carrying.add(key);
  try {
    const h = hostingOf(wsId, name);
    const t = h && !h.lost ? await sshTunnel(h.computerId, port).catch(() => null) : null;
    if (!t || !forwardOf(key)) {
      t?.carrier.close();
      if (!t) closeForward(key);
      return;
    }
    closeForward(key);
    await openForward({ key, app: name, macPort: port, host: t.host, port, carrier: t.carrier }).catch(() => {});
  } finally {
    carrying.delete(key);
  }
}

/**
 * What bops-local said went wrong (BOPS_LOCAL_FAIL), in words; undefined when nothing did. Its port held by
 * something else there, or another Local's (BOPS_LOCAL_HELD: the port, and whose: a site's, or a bot's copy's of
 * workspace `wsId`), says which: it never moves.
 */
const localFailed = (output: string, wsId?: string) => {
  const code = /^BOPS_LOCAL_FAIL=(\S+)$/m.exec(output)?.[1];
  if (!code) return undefined;
  const [, port, word, other] = /^BOPS_LOCAL_HELD=(\d{1,5})(?: ([a-z0-9.-]+)--([a-z0-9-]+))?$/m.exec(output) ?? [];
  if (code === "port-held" && port)
    return `Something else on its computer is using port ${port}, so its Local can't start there. Stop that, or clear its port to get a free one.`;
  const copyOf = word?.includes(".") ? getState().bots.find((b) => workspaceOf(b) === wsId && copyName(b.id) === word.slice(word.indexOf(".") + 1)) : undefined;
  const whose = copyOf ? `the Local of ${copyOf.name}'s copy` : other && !word?.includes(".") ? `${other}'s Local's` : "another Local's";
  if (code === "port-taken" && port) return `Port ${port} is ${whose} on its computer. Pick another, or clear its port to get a free one.`;
  return LOCAL_WORDS[code] ?? "Local didn't do that. Try again.";
};

/** The app's record for Local: its computer (one whose computer is gone has nowhere to run). */
function localHome(wsId: string, name: string): AppHosting {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (h.lost) throw new HostedAppError(LOST, 409);
  return h;
}

/** Whether the app's computer sleeps now, asked of Orgo (which never wakes it for this): then nothing of Local runs. */
async function asleepNow(computerId: string): Promise<boolean> {
  const c = await orgo.computer(computerId).catch((e: unknown) => e as Error);
  if (computerAsleepError(c)) return true;
  if (c instanceof Error) throw new HostedAppError("Couldn't reach its computer just now. Try again in a minute.", 502);
  return c.status !== "running";
}

/**
 * The bot a site of an app's own working folder is worked on by: the one whose Works on (lib/types.ts siteOf) is that
 * site and that has no copy of its own (copyFor), else the app's own bot (its hosting record's).
 */
function siteBot(wsId: string, name: string, site: string): string | undefined {
  const b = siteBotOf(getState(), wsId, name, site);
  return b && !copyFor(wsId, name, b.id) ? b.id : hostingOf(wsId, name)?.botId;
}

/** A site's name as a person reads it: the app's, for its own. */
const siteWord = (name: string, site: string) => (site === name ? name : site);

/** How many Local addresses told for Google a site keeps (the newest). */
const TOLD_KEPT = 20;

/**
 * What Bops keeps of the Locals it just read from their computer: each site's port as a hint on its hosting
 * record (localPort, its own folder's: a bot's prompt says its address without asking the computer, and other Macs
 * see it), written only when it changed; and for a site whose app signs in (auth), running at an address it was never
 * told for (its own folder's Local or a copy's), a note in the chat of the bot whose Local it is with the two lines to
 * add to Google sign in, once an address (the site's toldGoogle, its copies' addresses with its own; and never when
 * that chat has it already: an older Mac rebuilds a site's record without toldGoogle, while a chat keeps its
 * messages). Nothing once another account's state came in.
 */
function heardLocals(wsId: string, name: string, a: Pick<LocalAnswer, "sites" | "copies">, ours: () => boolean) {
  const h = hostingOf(wsId, name);
  if (!ours() || !h || h.lost) return;
  // What changes of one site's record (none: nothing), and the addresses to tell Google of, each with the bot of the copy it's of (none: its own folder's).
  const fresh = (site: string, kept: { localPort?: number; toldGoogle?: string[] }) => {
    const x = a.sites[site];
    const told = [...(kept.toldGoogle ?? [])];
    const tell: { address: string; copyBot?: string }[] = [];
    for (const [y, copyBot] of [[x, undefined] as const, ...(a.copies ?? []).map((c) => [c.sites[site], c.bot] as const)]) {
      if (!y?.port || y.auth !== true || (y.state !== "running" && y.state !== "starting") || told.includes(localAddress(y))) continue;
      told.push(localAddress(y));
      tell.push({ address: localAddress(y), ...(copyBot ? { copyBot } : {}) });
    }
    if ((!x?.port || x.port === kept.localPort) && !tell.length) return undefined;
    return { patch: { ...(x?.port ? { localPort: x.port } : {}), ...(tell.length ? { toldGoogle: told.slice(-TOLD_KEPT) } : {}) }, tell };
  };
  if (!sitesOf(h, name).some((s) => fresh(s.site, s.site === name ? h : (h.sites?.find((y) => y.name === s.site) ?? {})))) return;
  const told: { site: string; address: string; copyBot?: string }[] = [];
  keepHosting(wsId, name, (now) => {
    if (!now || now.lost) return now;
    const own = fresh(name, now);
    for (const t of own?.tell ?? []) told.push({ site: name, ...t });
    const more = now.sites?.map((y) => {
      const f = fresh(y.name, y);
      for (const t of f?.tell ?? []) told.push({ site: y.name, ...t });
      return f ? { ...y, ...f.patch } : y;
    });
    return { ...now, ...(own?.patch ?? {}), ...(more ? { sites: more } : {}) };
  });
  for (const t of told) {
    const botId = t.copyBot ?? siteBot(wsId, name, t.site);
    const chatId = botId && bot(botId) ? botChatId(botId) : undefined;
    if (!botId || !chatId || !getState().chats.some((c) => c.id === chatId)) continue;
    const text = `${siteWord(name, t.site)}'s Local is at ${t.address}. If it signs in with Google, add these two lines to its OAuth client in Google Cloud (Credentials), once:\nAuthorized JavaScript origins: ${t.address}\nAuthorized redirect URIs: ${t.address}/api/auth/callback/google`;
    if (getState().messages.some((m) => m.chatId === chatId && m.appNote && m.text === text)) continue;
    addMessage({ chatId, role: "bot", botId, text, appNote: true, bops: true });
  }
}

/**
 * GET /api/hosted-apps/[name]/local: every site's Local as its computer says now (bops-local status), of its own
 * folder and of each copy of it (localsFrom), read only while the computer runs: asleep, nothing runs there, and it
 * isn't woken to say so. Kept a few seconds.
 */
export async function localStatus(wsId: string, name: string, { fresh = false }: { fresh?: boolean } = {}): Promise<LocalAnswer> {
  const ours = sameState();
  const h = localHome(wsId, name);
  const key = `${wsId}/${name}`;
  const kept = localRead.get(key);
  if (!fresh && kept && Date.now() - kept.at < LOCAL_MS) return kept.answer;
  const why = await closedHere();
  held(ours);
  if (why) return { sites: {}, why };
  const asleep = await asleepNow(h.computerId).catch((e: unknown) => e as Error);
  held(ours);
  if (asleep instanceof Error) return { sites: {}, why: asleep.message };
  if (asleep) return remember(key, { sites: {}, asleep: true });
  await localTool(h.computerId, ours);
  const r = await localBash(h.computerId, `${LOCAL_BIN} status ${name}`, 30, ours).catch(() => null);
  held(ours);
  if (!r) return { sites: {}, why: "Couldn't reach its computer just now. Try again in a minute." };
  const all = localsFrom(r.output, h, name, wsId);
  followForwards(wsId, name, all);
  heardLocals(wsId, name, all, ours);
  return remember(key, all);
}

const remember = (key: string, answer: LocalAnswer) => {
  localRead.set(key, { at: Date.now(), answer });
  return answer;
};

/** A Local's command as it's typed: one line or more of shell, 2000 characters at most. */
function localCommand(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !v.trim() || v.length > 2000 || v.includes("\0")) throw new HostedAppError("Type the command that starts it, 2000 characters at most.", 400, { field: "command" });
  return v.trim();
}

/**
 * A Local's port as it's typed (where its dev command listens, and its address here and on its computer): 1024
 * to 65535, never Bops' own 3210; "auto", the lowest free one there (its port field cleared); none, the one it has.
 */
function devPortOf(v: unknown): number | "auto" | undefined {
  if (v === "auto") return "auto";
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{1,5}\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new HostedAppError("Use a port from 1024 to 65535.", 400, { field: "port" });
  if (n === 3210) throw new HostedAppError("Bops uses 3210 on this Mac. Pick another.", 400, { field: "port" });
  return n;
}

const LOCAL_ACTIONS = new Set(["start", "stop", "open", "preview", "unpreview", "fix"]);

/**
 * The screen a site's Local opens on, as its X display: the one a live task on the app works on in the same folder
 * (`copyBot`'s copy, or its own folder: a task of a bot without a copy; the site's own first), else a free screen of
 * its computer (lib/screens.ts screenMap), else none, said so.
 */
function screenFor(wsId: string, name: string, site: string, h: AppHosting, copyBot?: string): number {
  const st = getState();
  const on = st.sessions.filter((s) => isLive(s) && s.display !== undefined && s.app?.wsId === wsId && s.app.name === name && computerOf(s.botId) === h.computerId && (copyFor(wsId, name, s.botId) ? s.botId : undefined) === copyBot);
  const task = on.find((s) => (s.app?.site ?? name) === site) ?? on[0];
  if (task?.display !== undefined) return task.display;
  const free = screenMap(st, h.botId).find((x) => x.kind === "free");
  if (free) return free.display;
  throw new HostedAppError("No screen on its computer is free right now. Open preview shows it here, or try again once a task there is done.", 409, { code: "NO_SCREEN" });
}

/**
 * POST /api/hosted-apps/[name]/local: a site's Local (`site`, none the app's own) started (on its computer, from
 * its working folder: `command`, else the one it ran last, else its site's start command, else what its folder
 * says; on its port: `port`, else the one it has, else the lowest free there, as "auto" asks too; with its
 * Preview's variables, its sign in addresses made its own address, its own on top), stopped, opened on a screen
 * of its computer (its Chrome there, at its address: screenFor), previewed on this Mac (`preview`:
 * http://localhost:<port>/, this Mac's same port forwarded to its computer over the tailnet, local-preview.ts;
 * `start`: started first when it isn't running), its preview closed (`unpreview`), or a Fix it press counted
 * (`fix`, the owner's: bops-local mark fix). Start, open and preview are the user's doing, so they wake an asleep
 * computer; stop and fix never do (nothing runs on one asleep). A site's first start makes its Published project
 * first when it has none (ensureProd: so an older Bops deploying it never makes one on the port Local holds).
 * Answers every site's Local as it is then.
 */
export async function localAct(wsId: string, name: string, ask: { action?: unknown; site?: unknown; bot?: unknown; command?: unknown; port?: unknown; start?: unknown }): Promise<LocalAnswer> {
  const ours = sameState();
  const h = localHome(wsId, name);
  const site = siteIn(h, name, ask.site).site;
  if (typeof ask.action !== "string" || !LOCAL_ACTIONS.has(ask.action)) throw new HostedAppError("Start it, stop it, or open it.", 400);
  const action = ask.action as "start" | "stop" | "open" | "preview" | "unpreview" | "fix";
  // Whose copy's Local (none: its own folder's, as for a bot that doesn't work on it).
  if (ask.bot !== undefined && ask.bot !== null && ask.bot !== "" && (typeof ask.bot !== "string" || !bot(ask.bot) || workspaceOf(bot(ask.bot)) !== wsId))
    throw new HostedAppError("There's no bot by that name in this workspace.", 404);
  const copy = copyFor(wsId, name, typeof ask.bot === "string" ? ask.bot : undefined);
  const copyBot = copy ? (ask.bot as string) : undefined;
  const word = localWord(name, copy);
  const key = `${wsId}/${name}`;
  const fwd = fwdKey(wsId, name, site, copyBot);
  if (action === "unpreview") {
    closeForward(fwd);
    return localRead.get(key)?.answer ?? { sites: {} };
  }
  if (action === "preview") return previewLocal(wsId, name, site, ask.start === true, ours, copyBot);
  const command = action === "start" ? localCommand(ask.command) : undefined;
  const dev = action === "start" ? devPortOf(ask.port) : undefined;
  notRemoving(wsId, name);
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  if (action === "stop") closeForward(fwd);
  if ((action === "stop" || action === "fix") && (await asleepNow(h.computerId))) return remember(key, { sites: {}, asleep: true });
  held(ours);
  const display = action === "open" ? screenFor(wsId, name, site, h, copyBot) : undefined;
  await localTool(h.computerId, ours);
  let line = action === "fix" ? `${LOCAL_BIN} mark ${word} ${site} fix` : `${LOCAL_BIN} ${action} ${word} ${site}${display !== undefined ? ` ${display}` : ""}`;
  if (action === "start") {
    // Its Preview (for its variables and its link) and the site's Published start command, from the computer's lists (unsaid when Orgo can't say).
    const repo = repoOrNull(wsId, name);
    let list = await deploys.projects(h.computerId).then((r) => (r.enabled ? (r.value.projects ?? []) : null), () => null);
    const urls = await publicUrls.list(h.computerId).then((r) => (r.enabled && r.value.enabled ? (r.value.public_urls ?? []) : []), () => [] as OrgoPublicUrl[]);
    held(ours);
    const s = siteIn(h, name, site);
    let prod = list && repo ? prodIn(list, h, name, site, repo) : undefined;
    // Its first start: Published's project made first (best effort: Local runs whatever Orgo says).
    if (list && repo && !prod) {
      const made = await withApp(wsId, name, "first", () => ensureProd(wsId, name, s, ours)).catch(() => null);
      held(ours);
      if (made) {
        list = await deploys.projects(h.computerId).then((r) => (r.enabled ? (r.value.projects ?? []) : list), () => list);
        prod = list?.find((p) => p.id === made.projectId);
      }
    }
    const pv = list && repo ? previewIn(list, urls, repo, site, knownLabel(s, h, name, repo, list, urls)) : undefined;
    const b = (v: string | null | undefined) => (v ? Buffer.from(v).toString("base64") : "-");
    line += ` ${b(command)} ${b(site !== name ? prod?.start_cmd : null)} ${pv?.project?.name ?? "-"} ${b(pv?.url?.url)} ${dev ?? "-"}`;
  }
  const r = await localBash(h.computerId, `${line}\n${LOCAL_BIN} status ${name}`, 60, ours).catch((e: unknown) => e as Error);
  held(ours);
  if (r instanceof Error) throw new HostedAppError("Couldn't reach its computer just now. Try again in a minute.", r instanceof OrgoTimeout ? 504 : 502);
  const failed = localFailed(r.output, wsId);
  if (failed) throw new HostedAppError(failed, 409);
  const all = localsFrom(r.output, h, name, wsId);
  followForwards(wsId, name, all);
  heardLocals(wsId, name, all, ours);
  const answer = remember(key, all);
  return action === "open" && /^BOPS_LOCAL_OPENED=1$/m.test(r.output) ? { ...answer, opened: true, ...(display !== undefined ? { display } : {}) } : answer;
}

/** Why a preview on this Mac can't open, so it opens on the computer's screen instead (the window does that). */
const ON_SCREEN = {
  tailnet: "This Mac can't reach its computer, so it opens on its screen.",
  refused: "Orgo didn't turn on SSH for its computer, so it opens on its screen.",
  noAddress: "Its computer has no SSH address yet, so it opens on its screen.",
  noAnswer: "Its computer's SSH didn't answer, so it opens on its screen.",
  stopped: "Start it first.",
};

/** A preview that opens on its computer's screen instead, saying why (an SshError's why, in words). */
const onScreen = (why: SshError["why"] | "tailnet") =>
  new HostedAppError(why === "refused" ? ON_SCREEN.refused : why === "no-address" ? ON_SCREEN.noAddress : why === "no-answer" ? ON_SCREEN.noAnswer : ON_SCREEN.tailnet, 409, {
    fallback: "screen",
    code: why === "tailnet" ? "NO_TAILNET" : "NO_SSH",
  });

/**
 * How this Mac reaches a site's Local on its computer, for its forward (`key`) to `port` there: over the tailnet
 * when the computer is on it (straight to its address); else through the computer's SSH (computer-ssh.ts), the
 * owner's own (never on a computer's runner, nor while a workspace shared with the user is open), once that port of
 * this Mac is free. Undefined: its forward goes through SSH to that port already. Refused with `fallback: "screen"`
 * and why when neither can.
 */
async function reachLocal(h: AppHosting, key: string, port: number, ours: () => boolean): Promise<{ host: string; carrier?: Carrier } | undefined> {
  const ip = await tailnetIp(h);
  held(ours);
  if (ip) return { host: ip };
  const open = forwardOf(key);
  if (open?.via === "ssh" && open.macPort === port && open.port === port) return undefined;
  if (onRunner() || sharedOpen()) throw onScreen("tailnet");
  if (await macPortBusy(port)) {
    const busy = new ForwardError(port);
    throw new HostedAppError(busy.message, 409, { fallback: "screen", code: busy.code });
  }
  const t = await sshTunnel(h.computerId, port).catch((e: unknown) => {
    if (!(e instanceof SshError)) return Promise.reject(e);
    console.warn(`[ssh] ${h.computerId}: ${e.message}`);
    return Promise.reject(onScreen(e.why));
  });
  if (!ours()) t.carrier.close();
  held(ours);
  return t;
}

/**
 * A site's Local (of `copyBot`'s copy, or of its own folder) previewed on this Mac: started first when asked and it isn't running, then this Mac's
 * localhost:<port> forwarded to the same port of its computer (over the tailnet, else through its SSH: reachLocal),
 * so its address is the same on both. Refused with `fallback: "screen"` when this Mac can't reach the computer or
 * that port of this Mac is in use.
 */
async function previewLocal(wsId: string, name: string, site: string, start: boolean, ours: () => boolean, copyBot?: string): Promise<LocalAnswer> {
  const h = localHome(wsId, name);
  let answer = await localStatus(wsId, name, { fresh: true });
  held(ours);
  const mine = (a: LocalAnswer) => localsOf(a, copyBot)?.[site];
  const up = (a: LocalAnswer) => !!mine(a) && (mine(a)!.state === "running" || mine(a)!.state === "starting");
  if (!up(answer) && start) answer = await localAct(wsId, name, { action: "start", site, ...(copyBot ? { bot: copyBot } : {}) });
  const x = mine(answer);
  if (!x || !up(answer) || !x.port) throw new HostedAppError(answer.asleep ? "Its computer is asleep." : ON_SCREEN.stopped, 409, { code: "NOT_STARTED" });
  const key = fwdKey(wsId, name, site, copyBot);
  const reach = await reachLocal(h, key, x.port, ours);
  try {
    if (reach) {
      // (Its forward on another port, from before its Local moved, goes: one a site.)
      if ((forwardOf(key)?.macPort ?? x.port) !== x.port) closeForward(key);
      await openForward({ key, app: name, macPort: x.port, host: reach.host, port: x.port, carrier: reach.carrier });
    }
  } catch (e) {
    if (e instanceof ForwardError) throw new HostedAppError(e.message, 409, { fallback: "screen", code: e.code });
    throw e;
  }
  return { ...answer, preview: `${localAddress(x)}/` };
}

/**
 * PATCH …/env { where: "local" }: Local's own variables set (a value) or removed (null) on its computer
 * (bops-local env: a file there only root reads, outside its repo), on top of Staging's, which it reads unless
 * set here. The values go to the computer alone, on stdin, never on a command line; nothing here keeps or says
 * one. Answers its own variables' names. They apply the next time it starts.
 */
async function changeLocalEnv(wsId: string, name: string, out: Record<string, string | null>, site: unknown, ours: () => boolean): Promise<string[]> {
  const h = localHome(wsId, name);
  const s = siteIn(h, name, site).site;
  const why = await closedHere();
  held(ours);
  if (why) throw new HostedAppError(why, 403);
  await localTool(h.computerId, ours);
  const changes = Buffer.from(JSON.stringify(out)).toString("base64");
  const r = await localBash(h.computerId, `printf %s ${changes} | ${LOCAL_BIN} env ${name} ${s}`, 30, ours).catch(() => null);
  held(ours);
  if (!r) throw new HostedAppError("Couldn't reach its computer just now. Try again in a minute.", 502);
  const failed = localFailed(r.output, wsId);
  if (failed) throw new HostedAppError(failed, 409);
  localRead.delete(`${wsId}/${name}`);
  const names = /^BOPS_LOCAL_ENV=(\S+)$/m.exec(r.output)?.[1] ?? "-";
  return names === "-" ? [] : names.split(",").filter((x) => ENV_NAME.test(x));
}

/* ---------------- What a bot does with them ---------------- */

/**
 * The site a bot works on by default (its Works on, Workspace.botSites: lib/types.ts siteOf), when it names one of
 * the workspace's apps and a site of it: work_on_app, local_app, deploy_app and Publish take it when they name none.
 */
export function botSite(botId: string): { app: string; site: string } | undefined {
  const b = bot(botId);
  const x = b ? siteOf(getState(), b) : undefined;
  if (!b || !x || typeof x.app !== "string" || typeof x.site !== "string") return undefined;
  const h = workspace(workspaceOf(b))?.hostedApps?.[x.app];
  return h && sitesOf(h, x.app).some((s) => s.site === x.site) ? { app: x.app, site: x.site } : undefined;
}

/** The site of `name` a bot's call is about: the one it named, else the bot's own (botSite) when it's of this app. */
const siteFor = (botId: string, name: string, site?: string) => site ?? (botSite(botId)?.app === name ? botSite(botId)?.site : undefined);

/** The name `words` mean of those `has` knows: as written when it's one, else the name they make ("Recipe Box": recipe-box). */
function nameIn(words: string, has: (name: string) => boolean): string | undefined {
  const want = words.trim().replace(/^["“']|["”']$/g, "");
  if (isRepoName(want) && has(want)) return want;
  const made = repoNameFor(want);
  return has(made) ? made : undefined;
}

/** One of the workspace's apps by its name, or the name its words make ("Recipe Box": recipe-box). */
function appNamed(wsId: string, words: string): string | undefined {
  const apps = workspace(wsId)?.hostedApps ?? {};
  return nameIn(words, (name) => !!apps[name]);
}

/** A repo in the workspace's Ingot by its name, or the name its words make, from the list Bops last read (reposAtHand). */
function repoNamed(wsId: string, words: string): string | undefined {
  const names = new Set((reposAtHand(wsId) ?? []).map((r) => r.name));
  return nameIn(words, (name) => names.has(name));
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
 * told that rather than to have them deploy it. A repo in the workspace's Ingot that isn't one of its apps yet (its
 * code put there some other way) is taken by its name as an app: it gets its first home on this bot's computer, as
 * a new app does, under the repo's own name, and the task clones it (readyAppForTask: Ingot already has the repo).
 */
export function appWork(botId: string, a: { app: string | null; name: string | null; change: string; deploy?: boolean }): { goal: string; title: string; name: string; site: string } {
  const b = bot(botId);
  if (!b) throw new HostedAppError("That bot is gone.", 404);
  const wsId = workspaceOf(b);
  const project = workspace(wsId)?.orgoProjectId;
  if (!project) throw new HostedAppError(NO_PROJECT, 409);
  const change = a.change.trim();
  if (!change) throw new HostedAppError("Say what to build or change.");
  let name: string;
  if (a.app?.trim()) {
    const found = appNamed(wsId, a.app) ?? repoNamed(wsId, a.app);
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
  // Its folder: the app's own for its own bot, else a copy of its own (readyAppForTask makes it ready as the task starts).
  const now = hostingOf(wsId, name);
  const copy = now && !now.lost && ownCopy(now, botId) ? copyName(botId) : undefined;
  const dir = appFolder(name, copy);
  const word = localWord(name, copy);
  const others = now ? appCoders(getState(), wsId, name).filter((x) => x !== botId).length > 0 || !!copy : false;
  const git = `git ${gitAs(botId)}`;
  const site = siteFor(botId, name) ?? name;
  const goal = [
    copy
      ? `Work on ${owner}'s app ${name}. It's the Ingot repo ${repo} (Ingot is Orgo's source control; name it in full wherever a command takes a repo), and your working folder on this computer is ${dir}, a copy of your own: Bops cloned it there, or pulled the newest main into it (merged with what you hadn't committed), as this task started.`
      : `Work on ${owner}'s app ${name}. It's the Ingot repo ${repo} (Ingot is Orgo's source control; name it in full wherever a command takes a repo), and its working folder on this computer is ${dir}: Bops cloned it there, or pulled the newest into it, as this task started.`,
    `What to do: ${change}`,
    WHERE_THINGS_ARE(owner),
    "1. Make the change in that folder. An app that runs a server listens on the port in $PORT, which Orgo sets when it deploys it and bops-local sets for its Local; a plain site needs only an index.html. Keep secrets out of the folder: .env files are never committed. Read its own address from AUTH_URL (or NEXTAUTH_URL) rather than writing one in: Bops sets it to its Local's address for its Local, its preview link for its Preview, and its domain once published.",
    `2. Run it as its Local and leave it running: bops-local start ${word} ${site} (it runs its dev script, else its start script, with hot reload, and prints a BOPS_LOCAL line whose fourth word is its port). ${owner} watches it live in Bops beside this chat while you save. Check each change with curl -i http://127.0.0.1:<that port>/. If it fails, bops-local status ${word} and /root/.bops/local/${word}--${site}.log say why. Don't run another server on that port, and don't stop its Local when you're done.`,
    `3. Commit it from the folder: ingot commit -m "<what changed, in one clear line>" (or the Ingot tools' repo_commit). ${SYNC_WORDS}`,
    ...(others ? [OTHERS_WORDS(name)] : []),
    `Plain git works too, if you'd rather, in a clone of its own (never inside ${dir}): git clone "$(ingot git-url ${repo})" ${dir}-git, make the change and commit there (${git} commit), and git push origin HEAD:main. Ingot's credential helper is set up on this computer already, so git asks no password. A push refused as stale means someone committed first: ${git} pull --no-rebase, fix any file it lists as a conflict, ${git} commit, then push again. Both ways land on the same history.`,
    a.deploy
      ? `4. Say what you changed. ${owner} asked for a link too: once you've committed and this task ends, Bops deploys its newest commit to its preview itself and tells them where, so don't tell them to deploy it. If you couldn't commit it, say why.`
      : `4. Say what you changed. ${owner} sees it in its Local now; it goes on the web when they ask, as a preview link first.`,
  ].join("\n");
  return { goal, title: `Work on ${name}`, name, site };
}

/* ---------------- How a working folder syncs: through main alone ---------------- */

/*
 * Every working folder of an app (its own, and each bot's copy) is a clone of its own (`ingot clone`, its own
 * .ingot/state.json and base: never a git worktree, nor a copy of another folder's files), and syncs with the others
 * only through main in the central Ingot: as a task starts, Bops readies it (readyWorkFolder: cloned the first time,
 * else `ingot pull`, a three way merge of what it hasn't committed with main's newest, the parts both changed left
 * between conflict markers); the bot commits from it with `ingot commit` (onto main's newest only: refused as stale,
 * nothing written, when main moved on since its base, and while a pull's conflicts are still there), and when it's
 * stale pulls, fixes any conflict in its own folder, and commits again (SYNC_WORDS). This is the one place that says
 * and does it, so landing a bot's work another way later (on a ref of its own, merged on Ingot) changes only this.
 */

/**
 * An app's working folder (`copy`: a bot's copy of it) made ready on its computer for a task (ingot.ts readyFolder),
 * with the computer's token ready: one Ingot turned away is replaced (the old one revoked) and the folder made again.
 * Says what was done, for the task's steps; throws IngotError when it can't be.
 */
async function readyWorkFolder(computerId: string, wsId: string, name: string, botId: string, ours: () => boolean, opts: { signal?: AbortSignal; copy?: string } = {}): Promise<string> {
  try {
    return await readyFolder(computerId, wsId, name, opts.signal, opts.copy);
  } catch (e) {
    if (!(e instanceof IngotError && e.refused)) throw e;
    stillOurs(ours);
    console.warn(`[hosted-apps] ${computerId}: Ingot turned its token away, so it gets a new one`);
    await ensureIngotCli(computerId, wsId, { signal: opts.signal, botId, renew: true });
    stillOurs(ours);
    return readyFolder(computerId, wsId, name, opts.signal, opts.copy);
  }
}

/** How a bot's commit lands (its task's goal, and what bots read of the apps: hostedAppsLine): fixed words. */
const SYNC_WORDS =
  "If Ingot says the commit is stale, someone committed first: run ingot pull, fix any file it lists between its <<<<<<< yours and >>>>>>> theirs markers, check it again, and commit again. Stale is when Ingot says main has moved on: nothing of yours was written, and the pull merges the new main into your folder. A commit is refused while a conflict is still there.";

/** For a task on an app other bots work on too (each in a copy of its own): fixed words but its name. */
const OTHERS_WORDS = (name: string) =>
  `Other bots work on ${name} at the same time, each in a copy of its own beside this folder, with Locals of its own: work only in your folder and on your Local, never in theirs. Your changes reach them only through main, and theirs reach you when you pull. A conflict in your folder is yours to fix there.`;

/**
 * The four places an app's site is, as a coding task's goal says them (appWork): fixed words, no real address
 * (bops-local prints its Local's, and a prompt's note lists them: hostedAppsLine), so the goal reads the same
 * for every app.
 */
const WHERE_THINGS_ARE = (owner: string) =>
  [
    `Where things are, in the words to use with ${owner}:`,
    "Screen: the screen of this computer this task works on (screen 1 to 4). Open pages only in your own screen's Chrome, never in another screen's.",
    "Local: this site's dev server on this computer, with hot reload, at http://localhost:<its port>. Its address is the one bops-local prints, and it stays the same: the same on this computer's screens and in Bops beside this chat, and Bops sets AUTH_URL to it. Never start, stop or restart another site's Local, and never kill a process on a port that isn't your site's.",
    "Preview: its fixed link, https://<12 letters and digits>.orgo.dev, to test and share (Bops deploys it there).",
    `Published: its own domain, only when ${owner} publishes it.`,
    `When you tell ${owner} where to look, say the place and its address: its Local, http://localhost:<its port>.`,
  ].join("\n");

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
 * (from this Mac), and the task's bot's working folder cloned or brought to the newest main (readyWorkFolder):
 * the app's own for its own bot, else a copy of the bot's own (kept on AppHosting.copies from then on). The app is
 * kept on that computer. A token Ingot turned away there is replaced, the old one revoked, and the folder
 * made again. The app's newest commit is noted as the task first runs (keepHeads: what its changes are told from,
 * and for a task asked to put it live too, what a new commit is told from).
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
  // Another bot than the app's own works in a copy of its own from its first task on it.
  const now = hostingOf(a.wsId, a.name);
  const copy = now && ownCopy(now, s.botId) ? copyName(s.botId) : undefined;
  if (copy) keepCopy(a.wsId, a.name, s.botId);
  await ingot.createRepo(a.wsId, a.name, authorOf(s.botId), signal);
  stillOurs(ours);
  listed.delete(a.wsId);
  const said = await readyWorkFolder(computerId, a.wsId, a.name, s.botId, ours, { signal, copy });
  await keepHeads(sessionId, a, ours, signal);
  return said;
}

/** The task's own record of its app (Session.app), to change in place inside update(). */
const appOfTask = (st: { sessions: Session[] }, sessionId: string) => st.sessions.find((x) => x.id === sessionId)?.app;

/**
 * The app's newest commit (null: nothing committed yet), read once as a task on it first runs, for what's kept of
 * it on the task: `startHead`, what the changes it makes are told from (every task on an app); and for a task asked
 * to put it live after (Session.app.deployAfter, as it first starts with that ask), `from`, which a new commit is
 * told from as it ends (deployAfterTask). Left unset when Ingot can't say now; one read is never read again (the run
 * after it, a restart, an answer to its question).
 */
async function keepHeads(sessionId: string, a: { wsId: string; name: string }, ours: () => boolean, signal?: AbortSignal) {
  const now = session(sessionId)?.app;
  const wantFrom = !!now?.deployAfter && now.from === undefined;
  if (!now || (now.startHead !== undefined && !wantFrom)) return;
  const head = await ingot.head(a.wsId, a.name, signal).catch(() => undefined);
  stillOurs(ours);
  if (head === undefined) return;
  update((st) => {
    const x = appOfTask(st, sessionId);
    if (!x) return;
    if (x.startHead === undefined) x.startHead = head;
    if (x.deployAfter && x.from === undefined) x.from = head;
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
  const app = { wsId, name: w.name, site: w.site };
  const chatId = botChatId(b.id);
  const task = startSession({ botId: b.id, goal: w.goal, title: w.title, chatId, sentVia: "you", where: "cloud", app: deploy ? { ...app, deployAfter: true } : app });
  // Asked of a task already on the app (sessions.ts foldInto): that one puts it live after, too.
  if (deploy) askDeploy(task.id, app);
  if (getState().chats.some((c) => c.id === task.chatId))
    addMessage({
      chatId: task.chatId,
      role: "bot",
      botId: b.id,
      text: `Making ${w.name} on my computer. ${deploy ? "I'll deploy a preview of it once it's built." : "Watch it with Preview at the top of this chat once it runs."}`,
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
  say(await deployForBot(s.botId, a.name, null, ours, "preview").catch((e: Error) => `Not deployed: ${e.message}`));
}

const previewedAt = new Map<string, number>();

/**
 * A task on an app ended a run with its work done (sessions.ts, where deployAfterTask is called): the Local of
 * the site it worked on (Session.app.site, else the app's own), in its bot's folder (its copy, or the app's own),
 * is started when it isn't running and its folder
 * has something to run. Its chat says where to watch it, the place and its address, as the bot (once per task),
 * or, when its dev server opened on a port of its own (mismatch: one that ignores $PORT), that it isn't there and
 * what to do; a task asked to deploy says how that went instead. Then it's checked (after it's said: a first page
 * can take a minute and more to build), all the same for a task asked to deploy and never on a mismatch: when its
 * / answers below 500 and its working folder has nothing uncommitted, bops-local keeps the folder's changeset as
 * its last good one (mark good: what Fix it's loop breaker goes back to). Nothing for a routine's run, one
 * another account's state came in on, or one that ended any other way.
 */
export async function previewAfterTask(sessionId: string): Promise<void> {
  const s = session(sessionId);
  const a = taskApp(s);
  if (!s || !a || s.status !== "done" || s.replacedBy || s.brainRun?.waits) return;
  // (Asked to deploy: deployAfterTask says how that went, read before it takes the ask off.)
  const quiet = !!s.app?.deployAfter;
  // (Once a run: the paths a run ends by may each call it.)
  const was = previewedAt.get(sessionId);
  if (was && Date.now() - was < 60_000) return;
  previewedAt.set(sessionId, Date.now());
  const ours = sameState();
  const h = hostingOf(a.wsId, a.name);
  if (!h || h.lost) return;
  const site = s.app?.site && sitesOf(h, a.name).some((x) => x.site === s.app?.site) ? s.app.site : a.name;
  // (The task's bot's own: its copy's, or the app's own folder's.)
  const copy = copyFor(a.wsId, a.name, s.botId);
  const copyBot = copy ? s.botId : undefined;
  const now = await localStatus(a.wsId, a.name, { fresh: true }).catch(() => null);
  if (!ours() || !now || now.asleep || now.why) return;
  let x: LocalSite | undefined = localsOf(now, copyBot)?.[site];
  if (!x || (x.state !== "running" && x.state !== "starting")) {
    const r = await localAct(a.wsId, a.name, { action: "start", ...(site !== a.name ? { site } : {}), ...(copyBot ? { bot: copyBot } : {}) }).catch(() => null);
    if (!ours()) return;
    x = localsOf(r, copyBot)?.[site];
  }
  if (!x?.port || (x.state !== "running" && x.state !== "starting")) return;
  if (!quiet && ours())
    addMessage({
      chatId: s.chatId,
      role: "bot",
      botId: s.botId,
      text: x.mismatch
        ? `${siteWord(a.name, site)}'s dev server opened on port ${x.mismatch} instead of its own port, ${x.port}, so its Local isn't at ${localAddress(x)}. Its dev command has to use $PORT: press Fix it in Preview at the top of this chat, or ask me.`
        : `${siteWord(a.name, site)}'s Local is running at ${localAddress(x)}. Open it with Preview at the top of this chat.`,
      sessionIds: [s.id],
      appNote: true,
      bops: true,
    });
  // (A dev server on a port of its own, one that ignores $PORT, never answers on its: nothing to check.)
  if (!x.mismatch) await markIfGood(a.wsId, a.name, site, x.port, ours, copy).catch(() => {});
}

/**
 * A site's Local (of a bot's copy, `copy`, or of the app's own folder) checked on its computer after a task (previewAfterTask): its / asked on its port until it
 * answers (a first page can take a while to build), its working folder's base changeset read (.ingot/state.json)
 * and whether anything there is uncommitted (`ingot status`). Answering below 500 with a clean folder at a
 * changeset: bops-local mark good with it. Says whether it did.
 */
async function markIfGood(wsId: string, name: string, site: string, port: number, ours: () => boolean, copy?: string): Promise<boolean> {
  const h = localHome(wsId, name);
  const dir = appFolder(name, copy);
  const word = localWord(name, copy);
  const r = await orgo.bash(
    h.computerId,
    [
      `# bops-local check ${word} ${site}`,
      "export HOME=~root",
      `cd ${dir} 2>/dev/null || exit 0`,
      "code=000",
      `for _ in $(seq 1 15); do code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://127.0.0.1:${port}/ 2>/dev/null); [ "\${code:-000}" != 000 ] && break; sleep 2; done`,
      'echo "BOPS_CHECK_HTTP=${code:-000}"',
      `echo "BOPS_CHECK_BASE=$(sed -n 's/^ *"base": "\\([0-9a-f]*\\)".*/\\1/p' .ingot/state.json 2>/dev/null | head -n 1)"`,
      `if ${INGOT_BIN} status 2>/dev/null | grep -qx 'nothing to commit, the folder matches its base'; then echo BOPS_CHECK_CLEAN=1; fi`,
    ].join("\n"),
    90,
  );
  held(ours);
  const code = Number(/^BOPS_CHECK_HTTP=(\d{3})$/m.exec(r.output)?.[1] ?? 0);
  const base = /^BOPS_CHECK_BASE=([0-9a-f]{64})$/m.exec(r.output)?.[1];
  if (!(code >= 100 && code < 500) || !base || !/^BOPS_CHECK_CLEAN=1$/m.test(r.output)) return false;
  await localTool(h.computerId, ours);
  const m = await localBash(h.computerId, `${LOCAL_BIN} mark ${word} ${site} good ${base}`, 30, ours);
  if (!/^BOPS_LOCAL_MARKED=1$/m.test(m.output)) return false;
  localRead.delete(`${wsId}/${name}`);
  return true;
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
 * deploy_app, for a bot: changeset `at` of an app (the newest on main when null; its short id works too) on its
 * Preview, in words for the model, with its fixed link. `where` prod (only when the owner's own words asked to
 * publish it: chat.ts) is Publish: what the Preview serves goes on its domain; an `at` that isn't what the
 * Preview serves is refused (it goes on the Preview first, to look at). `ours`: the state the work began on, when
 * it began before this call (deployAfterTask).
 */
export async function deployForBot(botId: string, app: string, at: string | null, ours = sameState(), where: "preview" | "prod" = "preview"): Promise<string> {
  const b = bot(botId);
  if (!b) return "That bot is gone.";
  const wsId = workspaceOf(b);
  const name = appNamed(wsId, app);
  if (!name) return `There's no app called "${app.slice(0, 80)}" in this workspace.`;
  const site = siteFor(botId, name);
  try {
    const id = at ? await wholeId(wsId, name, at, ours) : undefined;
    if (where !== "prod") return await previewForBot(wsId, name, id, botId, ours, site);
    // Publish: what the Preview serves, never a commit it doesn't.
    if (id) {
      const h = hostingOf(wsId, name);
      const read = h ? await previewsOf(wsId, name, h, (c) => projectsNow(c, ours).catch(() => null), (c) => urlsNow(c, ours).then((x) => x.urls, () => null), ours) : null;
      const serving = read?.previews.get(site ?? name)?.serving ?? null;
      if (serving !== id)
        return serving
          ? `Not published: Publish puts what its preview serves (${short(serving)}). Deploy ${short(id)} to its preview first, look at it, then publish.`
          : `Not published: its preview isn't live yet. Deploy ${short(id)} to its preview first, look at it, then publish.`;
    }
    const promoted = await promoteApp(wsId, name, { ours, ...(site ? { site } : {}) });
    const what = promoted.promoted.map((x) => `${x.site === name ? name : x.site} at ${short(x.at)}`).join(", ");
    const on = promoted.promoted.flatMap((x) => (x.domain ? [x.domain.replace(/^https:\/\//, "")] : []));
    return `Publishing ${what}, what its preview serves${on.length ? `, on ${on.join(" and ")}. It's live there in a minute or two.` : ". It's live on its domain once its DNS points at Orgo."}${promoted.said ? ` ${promoted.said}` : ""}`;
  } catch (e) {
    if (e instanceof HostedAppError && e.extra?.code === "NO_DOMAIN") {
      const sites = (e.extra?.sites as string[] | undefined) ?? [name];
      return `Not published: ${sites.join(" and ")} ${sites.length === 1 ? "has" : "have"} no domain yet. Connect one in Your Apps (Published, Domain, From Cloudflare), then say publish again.`;
    }
    // (Some of its sites went, which its words say first: not "Not deployed".)
    if (e instanceof HostedAppError) return e.extra?.partial ? e.message : `Not ${where === "prod" ? "published" : "deployed"}: ${e.message}`;
    throw e;
  }
}

/** deployForBot to the Preview: in words for the model, with each site's fixed link, and whether it asks for a password (never the password). */
async function previewForBot(wsId: string, name: string, id: string | undefined, botId: string, ours: () => boolean, site?: string): Promise<string> {
  const { app: now, deployed, said } = await deployApp(wsId, name, { ...(id ? { at: id } : {}), botId, ours, env: "preview", ...(site ? { site } : {}) });
  const on = now.hosting ? bot(now.hosting.botId)?.name : undefined;
  const what = id ? `${name} at ${short(id)}` : `the newest commit of ${name}`;
  // (Whether its link asks for one, as Orgo said in the read after the deploy.)
  const pv = (x: string) => (x === name ? now.preview : now.sites?.find((y) => y.name === x)?.preview);
  const locked = deployed.some((d) => pv(d.site)?.protected === true);
  const after = `${locked ? "It asks for a password, a new one once this deploy is live, shown beside its Preview link in Bops. " : ""}Say publish, or press Publish in Your Apps, to put it on its domain once it looks right.`;
  const more = said ? ` ${said}` : "";
  if (deployed.length > 1) {
    const each = deployed.map((d) => (d.url ? `${d.site} at ${d.url}` : d.site));
    return `Deploying a preview of ${what}${on ? ` on ${on}'s computer` : ""}, one site after another: ${each.join("; ")}. Each link stays the same for every preview, so add them to Google sign in once if the app uses it. ${after}${more}`;
  }
  const url = deployed[0]?.url;
  return `Deploying a preview of ${what}${on ? ` on ${on}'s computer` : ""}. ${url ? `It's at ${url} in a minute or two. That link stays the same for every preview, so add it to Google sign in once if the app uses it.` : "Its link shows in Your Apps."} ${after}${more}`;
}

/**
 * local_app, for a bot: an app's Local (its working folder run as a dev server on its computer: the bot's own copy's
 * when it works on the app in one) started, stopped or read, in words for the model: the place and its address, http://localhost:<its port>, the same on
 * its computer's screens and beside this chat; a dev server listening on another port than its own, said so.
 */
export async function localForBot(botId: string, app: string, action: "start" | "stop" | "status", site?: string, port?: number): Promise<string> {
  const b = bot(botId);
  if (!b) return "That bot is gone.";
  const wsId = workspaceOf(b);
  const name = appNamed(wsId, app);
  if (!name) return `There's no app called "${app.slice(0, 80)}" in this workspace.`;
  const owner = ownerName();
  site = siteFor(botId, name, site);
  const who = siteWord(name, site ?? name);
  // (Its own: its copy's, when it works on the app in one.)
  const copy = copyFor(wsId, name, botId);
  const word = localWord(name, copy);
  try {
    const r = action === "status" ? await localStatus(wsId, name, { fresh: true }) : await localAct(wsId, name, { action, ...(site ? { site } : {}), ...(port ? { port } : {}), ...(copy ? { bot: botId } : {}) });
    const x = localsOf(r, copy ? botId : undefined)?.[site ?? name];
    // Its dev server ignores $PORT: where it listens instead, and what to change.
    const mismatch = x?.mismatch && x.port ? ` Its dev server listens on ${x.mismatch} instead of its own port, ${x.port}: make its dev command use $PORT (or --port ${x.port}), then start it again.` : "";
    if (action === "stop") return `Stopped ${who}'s Local.`;
    if (action === "status") {
      if (r.asleep) return `${who}'s Local is stopped: its computer is asleep.`;
      return `${who}'s Local is ${x?.state ?? "stopped"}${x && (x.state === "running" || x.state === "starting") ? ` at ${localAddress(x)}` : ""}.${mismatch}`;
    }
    if (!x || x.state === "failed") return `${who}'s Local didn't start${x?.error ? `: ${localWords(x.error)}` : "."} Its log is /root/.bops/local/${word}--${site ?? name}.log on its computer.`;
    return `${who}'s Local ${x.state === "running" ? "is running" : "is starting (a first start installs what it needs)"} at ${localAddress(x)} on its computer, with hot reload: that address stays the same, on its computer's screens and in the Preview tab beside this chat, where ${owner} sees it (Preview at the top of the chat opens it). It isn't on the web.${mismatch}`;
  } catch (e) {
    if (e instanceof HostedAppError) return `Not done: ${e.message}`;
    throw e;
  }
}

/**
 * The workspace's apps for a bot's prompt, with where each is: its Preview's link (its state copy: no Orgo call
 * in a prompt; that it asks for a password, never the password), whether it's published (Bops shows no orgo.dev
 * name for Published), and the bot's own copy of it when it works on it in one (with how copies sync: SYNC_WORDS,
 * once any app has more bots working on it). Then the repos in its Ingot
 * that aren't apps yet (code put there some other way: work_on_app takes one by name), from the list Bops last read
 * (reposAtHand), never asked of Ingot here: with no list at hand, nothing is said of them. Empty when it has neither.
 */
export function hostedAppsLine(botId: string): string {
  const b = bot(botId);
  const wsId = b ? workspaceOf(b) : undefined;
  const hosted = (wsId ? workspace(wsId)?.hostedApps : undefined) ?? {};
  const apps = Object.entries(hosted).filter(([name]) => isRepoName(name));
  const loose = ((wsId ? reposAtHand(wsId) : undefined) ?? []).map((r) => r.name).filter((name) => !hosted[name]);
  const repos = loose.length
    ? `In your workspace's Ingot but not on a computer yet: ${loose.slice(0, 20).join(", ")}${loose.length > 20 ? `, and ${loose.length - 20} more` : ""} (work_on_app with its name as app gives it one).`
    : "";
  if (!apps.length) return repos;
  const base = previewBase();
  // Each site's Local address from the hint Bops keeps as it reads one (localPort: no computer is asked here).
  const where = (x: { preview?: string; projectId?: string; localPort?: number; passwordOff?: true }) =>
    `${x.localPort ? `Local at http://localhost:${x.localPort}; ` : ""}${x.preview ? `preview at https://${x.preview}.${base}${x.passwordOff ? ", with no password" : ""}` : "no preview yet"}; ${x.projectId ? "published on its domain once it has one" : "not published yet"}`;
  // (An app this bot works on in a copy of its own: its copy's folder, and no address of the app's own Local, which isn't its.)
  const one = ([name, h]: [string, AppHosting]) => {
    const on = h.botId !== botId ? bot(h.botId)?.name : undefined;
    if (h.lost) return `${name} (its computer is gone, so it needs a new home: deploy_app or work_on_app gives it one)`;
    const copy = wsId ? copyFor(wsId, name, botId) : undefined;
    const at = (x: Parameters<typeof where>[0]) => where(copy ? { ...x, localPort: undefined } : x);
    const more = h.sites?.length ? `, and its other sites from the same repo: ${h.sites.map((x) => `${x.name} (${at(x)})`).join(", ")}` : "";
    const mine = copy ? `; you work on it in a copy of your own, ${appFolder(name, copy)}, whose Local bops-local start ${localWord(name, copy)} <site> runs` : "";
    return `${name} (${at(h)}${more}${on ? `; on ${on}'s computer` : ""}${mine})`;
  };
  const owner = ownerName();
  const shared = apps.some(([name, h]) => !h.lost && wsId && appCoders(getState(), wsId, name).length > 1);
  const copies = shared ? ` When more bots work on one app, each works in a copy of its own with Locals of its own, and all commit to the same main: ${SYNC_WORDS} Never change another bot's copy.` : "";
  return `Your workspace's apps on the web, each an Ingot repo (work_on_app builds or changes one, local_app runs it, deploy_app deploys it): ${apps.map(one).join("; ")}. Each runs three ways on its bot's computer: Local, the live view while you work (its working folder as a dev server with hot reload, each site at its own http://localhost:<port>, the same on its computer's screens and beside this chat, where ${owner} watches it); Preview, a fixed link of its own to share and to test sign in (deploy_app puts changes there), which asks for a password unless ${owner} turned it off (${owner} sees it beside the Preview link in Bops; you never have it, so never write one in this chat or ask for it, and check your work on Local); and Published, only on its own domain (deploy_app with where prod, only when ${owner}'s own words ask to publish it). Say the place and its address when you point ${owner} at one.${copies}${repos ? ` ${repos}` : ""}`;
}

/** The domain Orgo's public links are under: orgo.dev, or staging.orgo.dev when this Bops uses Orgo's staging. */
const previewBase = () => (/staging/.test(orgoOrigin()) ? "staging.orgo.dev" : "orgo.dev");

/* ---------------- What a task changed, and Restore ---------------- */

/** A changeset's message as a card and Restore's question show it: its first line, 200 characters at most. */
const firstLine = (message: unknown) => (typeof message === "string" ? (message.trim().split("\n")[0] ?? "").trim().slice(0, 200) : "");

/** Who Ingot says made a changeset, in its words ("Boppy on bops-boppy via Alex"). */
const authorName = (c: IngotChangeset) => c.author?.name || c.author?.id || "";

/**
 * The changesets on main after `id` (every one for null: the app had none then), newest first, read a page of 200 at
 * a time (LOOK_PAGES at most), or null when `id` isn't among them (it's no changeset of the app's on main, or one too
 * far back to read) or there's no such repo. IngotError when Ingot can't say.
 */
async function laterThan(wsId: string, name: string, id: string | null, ours: () => boolean): Promise<IngotChangeset[] | null> {
  const out: IngotChangeset[] = [];
  let before: string | undefined;
  for (let page = 0; page < LOOK_PAGES; page++) {
    const log = await ingot.log(wsId, name, { limit: 200, ...(before ? { before } : {}) });
    held(ours);
    if (!log) return null;
    for (const c of log.changesets) {
      if (c.id === id) return out;
      out.push(c);
    }
    if (!log.next) return id === null ? out : null;
    before = log.next;
  }
  return null;
}

/**
 * The bots a task's changesets on its app are named after (ingot.ts byBots): its own, and the workspace's bot whose
 * computer it works on when that's another's (the computer's token is named after that one: ingot.ts tokenName).
 */
function committersOf(botId: string, wsId: string): string[] {
  const computerId = computerOf(botId);
  const there = computerId ? getState().bots.find((x) => x.computerId === computerId && workspaceOf(x) === wsId) : undefined;
  return there && there.id !== botId ? [botId, there.id] : [botId];
}

/** Tasks whose card is being made now (the paths a run ends by may each call changeCardAfterTask). */
const carding = new Set<string>();

/**
 * A task on an app ended a run (sessions.ts, where deployAfterTask is called; done or not, what it committed is on
 * main either way): when it knows where the app was as it first ran (Session.app.startHead) and its bot committed
 * since, one card in its chat as the bot (Message.appChange, appNote: a shared workspace never shows it), told from
 * the newest card this task posted before (a later run's card has that run's changes only), else from startHead, to
 * the bot's newest changeset: its first line and short id, how many changesets that is in all (someone else's in
 * between too: Restore to before this change undoes them as well) and whose. Its text says it for an older Bops,
 * which shows only that: "Changed recipe-box: A search box (a1b2c3d)". None when the bot committed nothing since,
 * none twice for one changeset, and none once another account's state came in meanwhile, or while Ingot can't say.
 */
export async function changeCardAfterTask(sessionId: string): Promise<void> {
  const s = session(sessionId);
  const a = taskApp(s);
  const start = s?.app?.startHead;
  if (!s || !a || start === undefined || s.replacedBy || carding.has(sessionId)) return;
  carding.add(sessionId);
  try {
    const ours = sameState();
    const cards = () => getState().messages.filter((m) => m.appChange && m.sessionIds?.includes(sessionId));
    const from = cards().at(-1)?.appChange?.to ?? start;
    const later = await laterThan(a.wsId, a.name, from, ours).catch(() => null);
    if (!ours() || !later) return;
    const at = later.findIndex((c) => byBots(c, committersOf(s.botId, a.wsId)));
    if (at < 0) return;
    const newest = later[at];
    if (cards().some((m) => m.appChange?.to === newest.id)) return;
    const all = later.slice(at);
    const title = firstLine(newest.message) || "a change";
    addMessage({
      chatId: s.chatId,
      role: "bot",
      botId: s.botId,
      text: `Changed ${a.name}: ${title} (${short(newest.id)})${all.length > 1 ? `, the newest of ${all.length} changes` : ""}`,
      sessionIds: [s.id],
      appNote: true,
      bops: true,
      appChange: { ws: a.wsId, app: a.name, from, to: newest.id, title, count: all.length, authors: [...new Set(all.map(authorName).filter(Boolean))] },
    });
  } finally {
    carding.delete(sessionId);
  }
}

/** Files a package manager installs from: when Restore changes one, each Local that runs starts again (bops-local start installs first). */
const DEPS = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;

/** Apps being restored now ("<wsId>/<name>"): a second Restore of one waits for none, it's refused. */
const restoring = new Set<string>();

/** Why an app can't be restored while a task works on it (its folder would be pulled under it), in words; undefined when none does. */
function workedOn(wsId: string, name: string): string | undefined {
  const t = getState().sessions.find((x) => isLive(x) && x.app?.wsId === wsId && x.app.name === name);
  return t ? `${bot(t.botId)?.name ?? "A bot"} is working on ${name} now. Restore it once that task ends.` : undefined;
}

/** The app and the changeset to put it back to, checked, for Restore and its question. */
function restoreHome(wsId: string, name: string, to: unknown): { h: AppHosting; to: string } {
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const h = isRepoName(name) ? hostingOf(wsId, name) : undefined;
  if (!h) throw new HostedAppError(NO_APP, 404);
  if (typeof to !== "string" || !CHANGESET.test(to)) throw new HostedAppError("That isn't a changeset of it.", 400);
  if (!workspace(wsId)?.orgoProjectId) throw new HostedAppError(NO_PROJECT, 409);
  return { h, to };
}

/** Ingot couldn't do it: in its words, else (it isn't answering) in ours, with the status the routes answer. */
const restoreRefused = (e: unknown) =>
  e instanceof IngotError ? new HostedAppError(e.offline ? "Ingot isn't answering, so it can't be restored just now. Try again in a minute." : e.message, e.offline ? 503 : 502) : e;

/**
 * GET /api/hosted-apps/[name]?restore=<to>, for Restore's question in the window (AppRestoreConfirm): every changeset
 * on main after `to`, newest first, with its first line, who made it and when, which restoring to `to` undoes; and
 * `blocked` when it can't be restored now: a task works on it, it's at `to` now, Ingot isn't answering. Ingot only:
 * no computer is asked.
 */
export async function restoreConfirm(wsId: string, name: string, to: unknown): Promise<AppRestoreConfirm> {
  const ours = sameState();
  const { to: id } = restoreHome(wsId, name, to);
  let later: IngotChangeset[] | null;
  try {
    later = await laterThan(wsId, name, id, ours);
  } catch (e) {
    if (e instanceof IngotError && e.offline) return { later: [], blocked: "Ingot isn't answering, so it can't be restored just now. Try again in a minute." };
    throw restoreRefused(e);
  }
  if (!later) throw new HostedAppError("That isn't a changeset of it.", 404);
  const list = later.map((c) => ({ id: c.id, title: firstLine(c.message), author: authorName(c), at: msOf(c.at) ?? 0 }));
  const busy = workedOn(wsId, name);
  if (busy) return { later: list, blocked: busy };
  return list.length ? { later: list } : { later: list, blocked: `${name} is at ${short(id)} now, so there's nothing to restore.` };
}

/**
 * POST /api/hosted-apps/[name] { action: "restore", to }, the owner's alone (the route refuses a shared workspace):
 * the whole app (every site shares its repo and working folder) put back as it was at changeset `to`, as a NEW
 * changeset on top of main ("Restore <app> to <short id>", by Bops: authorOf), so its history stays one line and
 * nothing is lost. Ingot makes it itself from the two changesets' files (ingot.ts changesTo: what `to` has that
 * main's newest hasn't, or has with other bytes or another executable bit, and what main's has that `to` hasn't,
 * deleted), naming blobs it has already, so no file goes from here or from the computer. Refused while a task works
 * on the app (its folder would be pulled under it), and, before anything is committed, while its working folder on
 * its computer has changes nobody committed (ingot.ts folderChanges, by the computer's bash as for bops-local: the
 * computer is woken for it, as for Start), so no one's work is lost. Main moved as it was committed (Ingot's stale):
 * made again once from main's newest, and said; moved again, refused, saying so. Already like that (nothing to
 * change, or Ingot's empty): said, nothing committed. Then the folder is pulled (ingot pull, with the computer's
 * token ready), so Local reloads, and when package.json or a lockfile changed, each site's Local that runs starts
 * again (bops-local start installs first). Each card of the app's whose change it put back (Message.appChange with
 * `from` = `to`) says Restored. Answers the app, the new changeset, and what was done in words.
 */
export async function restoreApp(wsId: string, name: string, to: unknown): Promise<{ app: HostedApp; restored?: string; said: string }> {
  const ours = sameState();
  const { h, to: want } = restoreHome(wsId, name, to);
  notRemoving(wsId, name);
  const busy = workedOn(wsId, name);
  if (busy) throw new HostedAppError(busy, 409);
  const key = `${wsId}/${name}`;
  if (restoring.has(key)) throw new HostedAppError(`${name} is being restored already.`, 409);
  restoring.add(key);
  try {
    return await restoreTo(wsId, name, h, want, ours);
  } finally {
    restoring.delete(key);
  }
}

async function restoreTo(wsId: string, name: string, h: AppHosting, want: string, ours: () => boolean): Promise<{ app: HostedApp; restored?: string; said: string }> {
  const failed = (e: unknown) => Promise.reject(restoreRefused(e));
  const wanted = await ingot.tree(wsId, name, want).catch(failed);
  held(ours);
  if (!wanted) throw new HostedAppError("That isn't a changeset of it.", 404);
  /** Main's newest now and what makes its files `to`'s. */
  const planOn = async (head: string | null | undefined): Promise<{ head: string; changes: IngotChange[] }> => {
    if (!head) throw new HostedAppError("That isn't a changeset of it.", 404);
    const now = await ingot.tree(wsId, name, head).catch(failed);
    held(ours);
    if (!now) throw new HostedAppError("That isn't a changeset of it.", 404);
    return { head, changes: changesTo(now, wanted) };
  };
  let plan = await planOn(await ingot.head(wsId, name).catch(failed));
  held(ours);
  const already = async () => ({ app: await appNow(wsId, name, ours), said: `${name} is as it was at ${short(want)} already, so there was nothing to restore.` });
  if (!plan.changes.length) return already();
  // Its working folder first: nothing is committed while it has changes nobody committed.
  const unread = (e: unknown) =>
    Promise.reject(e instanceof IngotError ? new HostedAppError(e.message, 502) : new HostedAppError("Couldn't reach its computer just now, so its working folder couldn't be checked. Try again in a minute.", e instanceof OrgoTimeout ? 504 : 502));
  const folder = h.lost ? ({ there: false } as const) : await folderChanges(h.computerId, wsId, name).catch(unread);
  held(ours);
  if (folder.there && folder.changed.length) {
    const some = folder.changed.slice(0, 3).join(", ");
    const more = folder.changed.length > 3 ? ` and ${folder.changed.length - 3} more` : "";
    throw new HostedAppError(`${name}'s working folder on its computer has changes nobody committed (${some}${more}), so it wasn't restored. Ask its bot to commit them, or to put them back, first.`, 409, { changed: folder.changed.slice(0, 20) });
  }
  // The commit, made once more from main's newest when someone committed as it went.
  let made: string | undefined;
  let moved = false;
  for (;;) {
    const r = await ingot.commit(wsId, name, { base: plan.head, message: `Restore ${name} to ${short(want)}`, changes: plan.changes }, authorOf(undefined)).catch(failed);
    held(ours);
    if ("id" in r) {
      made = r.id;
      break;
    }
    if ("empty" in r) return already();
    if (moved || !r.stale) throw new HostedAppError(`Someone committed to ${name} twice as it was being restored, so it wasn't. Look at its history, then try again.`, 409);
    moved = true;
    plan = await planOn(r.stale);
    if (!plan.changes.length) return already();
  }
  listed.delete(wsId);
  update((st) => {
    for (const m of st.messages) if (m.appChange && m.appChange.ws === wsId && m.appChange.app === name && m.appChange.from === want) m.appChange.restored = true;
  });
  const said = [`Restored ${name} to ${short(want)}, as a new change (${short(made)}).`];
  if (moved) said.push("Someone committed to it as it was being restored, so that change is undone too.");
  if (folder.there) said.push(...(await pullRestored(wsId, name, h, plan.changes, ours)));
  return { app: await appNow(wsId, name, ours), restored: made, said: said.join(" ") };
}

/**
 * After a restore: the app's working folder on its computer pulled (readyFolder, with the computer's token ready; a
 * token Ingot turned away replaced, as a task's start does), so Local reloads; and when the restore changed what a
 * package manager installs from (DEPS), each site's Local that runs started again, which installs first. What
 * couldn't be done, in words: the restore itself stands either way, and the bot's next task pulls it as it starts.
 */
async function pullRestored(wsId: string, name: string, h: AppHosting, changes: IngotChange[], ours: () => boolean): Promise<string[]> {
  try {
    await ensureIngotCli(h.computerId, wsId, { botId: h.botId });
    stillOurs(ours);
    await readyWorkFolder(h.computerId, wsId, name, h.botId, ours);
  } catch (e) {
    held(ours);
    return [`Its working folder on its computer didn't get it yet (${(e as Error).message}), so its Local shows it once its bot's next task starts.`];
  }
  held(ours);
  if (!changes.some((c) => DEPS.test(c.path))) return [];
  const now = await localStatus(wsId, name, { fresh: true }).catch(() => null);
  held(ours);
  const running = Object.entries(now?.sites ?? {}).filter(([, x]) => x.state === "running" || x.state === "starting");
  for (const [site] of running) {
    await localAct(wsId, name, { action: "start", site }).catch(() => null);
    held(ours);
  }
  return running.length ? ["What it installs changed, so its Local is starting again with a fresh install."] : [];
}
