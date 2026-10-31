/*
 * Apps a workspace builds and runs on the web. Each app is an Ingot repo (Orgo's own source control, not
 * git: ingot/docs/hosted-api.md) in the central Ingot, under the workspace's Orgo project, where everyone
 * signs in with their Orgo key. A bot works on it on its Bops computer, in a working folder at
 * /workspace/apps/<name> made with `ingot clone`, through its brain (Claude Code, Codex, or Bops agent),
 * committing with `ingot commit` or the Ingot MCP tools; two people committing at once can't overwrite
 * each other (a commit names its base; a stale one is refused and `ingot pull` merges). Several bots of the
 * workspace on its computer can work on it at once, each in a copy of its own (/workspace/apps/<name>.<copy>,
 * appCoders), with a Local of its own for each site; all commit to the same main. Deploying builds
 * one changeset on that computer with orgo-web's deploy runner: first on its Preview, a fixed link of its own
 * (https://<12 letters and digits>.orgo.dev), then, published, on its own domain only.
 * Imported by the window and the Mac server.
 */

import { siteOf, workBot, workspaceOf, type Bot, type BotSite } from "./types";

export type DeployState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "superseded";

/**
 * Where an app is worked on and runs, kept on its workspace (Workspace.hostedApps, by repo name): the bot
 * whose computer holds its working folder and runs its site, and once it was first deployed (or its
 * variables were first saved), its Published deploy project there. `url`: what Bops 0.0.32 and before kept
 * of its address; never written now (Published lives on its domains only), kept as it is when there.
 */
export type AppHosting = {
  botId: string;
  computerId: string;
  projectId?: string;
  url?: string;
  /**
   * Its own site's Preview link's label (https://<preview>.orgo.dev), a copy: Orgo keeps the link itself, found
   * there by its seal (lib/server/app-labels.ts), so this is read only when Orgo has none (its computer gone),
   * or for a name the owner chose ahead (which has no seal).
   */
  preview?: string;
  /** When this Mac last queued a deploy of it (a bot's, or the window's), so a window showing it reads it again. */
  queuedAt?: number;
  /**
   * Its own site's Local's port on its computer as Bops last read it (LocalSite.port: http://localhost:<it>), a
   * hint for a bot's prompt (hostedAppsLine: no computer is asked for one) and for other Macs. Bops 0.0.34 and
   * before neither read nor keep it.
   */
  localPort?: number;
  /**
   * Its own site's Local addresses Bops already told the owner to add to Google sign in (http://localhost:<port>),
   * each told once, in its bot's chat, the first time its Local runs there and the app signs in.
   */
  toldGoogle?: string[];
  /** The owner turned its own site's Preview password off (PreviewSite.protected): Bops sets none for it until they turn it on. */
  passwordOff?: true;
  /**
   * When Bops last set its own site's Preview password, and the Preview deploy live then (null: none yet): one that
   * goes live after it gets a new password. Orgo keeps the password itself.
   */
  passwordSet?: PasswordSet;
  /**
   * More sites of the same repo on the same computer (one repo holding a few apps, each started its own
   * way), in the order they were added. The app's own site is the one above, named as the app; each of
   * these is a deploy project of its own there, with its own name (which its address takes), port and
   * variables. None for an app with one site, as every app had before.
   */
  sites?: AppSiteHosting[];
  /**
   * When its computer went (deleted, or its bot moved to a shared one): its deploy projects went with it,
   * so it needs a new home (a deploy, or a bot working on it, gives it one). Its sites' names stay.
   */
  lost?: number;
  /**
   * Its deploy projects still on a computer it moved off (its bot moved to another computer that one stays
   * up): they serve as they were, with their domains, until Remove app takes them down with the rest.
   */
  behind?: AppProjectBehind[];
  /**
   * The other bots that work on it on its computer, by id, in the order they first did: each in a copy of its own
   * there, /workspace/apps/<name>.<copy> (lib/server/hosted-apps.ts copyFor), with Locals of its own, never the
   * app's own folder, which stays its own bot's (`botId`, unless that bot is listed here: one that had a copy keeps
   * it when the app passes to it). None while only its own bot works on it. They stay on the computer it leaves.
   */
  copies?: string[];
};

/** A site's deploy project left on a computer the app moved off (AppHosting.behind). */
export type AppProjectBehind = { site: string; computerId: string; projectId: string };

/**
 * One more site of an app (AppHosting.sites): its name, and once it was made, its Published deploy project, and its
 * Preview link's label (a copy, as AppHosting.preview); its Local's port and the Local addresses told for Google,
 * as AppHosting.localPort and toldGoogle say of the app's own; its Preview password's, as passwordOff and passwordSet do.
 */
export type AppSiteHosting = { name: string; projectId?: string; url?: string; preview?: string; localPort?: number; toldGoogle?: string[]; passwordOff?: true; passwordSet?: PasswordSet };

/** When Bops set a Preview's password (ms), and the id of the Preview deploy live then (null: none yet). */
export type PasswordSet = { at: number; live: string | null };

/**
 * How many sites an app can have: each is two deploy projects on its computer (Published's and Preview's), and
 * orgo-web takes 10 a computer (PROJECTS_PER_COMPUTER), which other apps on that computer count toward too
 * (Orgo says so then).
 */
export const MAX_SITES = 5;

/* ---------------- Its environments: Local, Preview and Published, all on its computer ---------------- */

/**
 * Where an app runs, all three on its bot's own computer (the one AppHosting names), as Lovable has them:
 * - "local": its working folder (/workspace/apps/<name>) run as a dev server there with hot reload, started
 *   and stopped from Your Apps or by the bot (vm/bin/bops-local); each other bot that works on it has its own
 *   copy's (LocalAnswer.copies), on ports of their own. Not public: each site has a port of its own
 *   on its computer (3000, 3001 and on, never another site's there), and its address is http://localhost:<that
 *   port> everywhere: on the computer's screens, and beside the bot's chat, this Mac forwarding that same port
 *   to the computer over the tailnet (lib/server/local-preview.ts). AUTH_URL is that address there.
 * - "preview": a deploy project of each site on the computer, named with a random 12 character label, at
 *   https://<label>.orgo.dev: one link per site, chosen once and never changed, so Google sign in is set up for
 *   it once. Deploy goes here. Found on Orgo by the label's seal (lib/server/app-labels.ts).
 * - "prod" (Published): each site's own deploy project (AppHosting.projectId), served only on its domains
 *   (Cloudflare first), never on an orgo.dev name Bops shows. Publish puts on it the changeset its Preview serves.
 * Of Local, Bops' state keeps only hints (each site's port, and the addresses told for Google sign in); of
 * Preview, only a copy of its label.
 */
export type AppEnv = "local" | "preview" | "prod";
export const APP_ENVS: readonly AppEnv[] = ["local", "preview", "prod"];
export const isAppEnv = (v: unknown): v is AppEnv => typeof v === "string" && (APP_ENVS as readonly string[]).includes(v);
/** One of them; "staging" (what the builds before this one said) is read as "preview" for one release. */
export const appEnvOf = (v: unknown): AppEnv | undefined => (v === "staging" ? "preview" : isAppEnv(v) ? v : undefined);

/**
 * A site's Preview as Orgo says it: its deploy project on the app's computer (null: none yet), its link (from
 * its public URL, so it shows before its first deploy; null: none yet), its label, what it serves, its newest
 * deploy, and `off` when Orgo turned its link off. `protected`: its link asks for a password (absent: Orgo can't
 * tell); `passwordAt`: when Bops last set that password, so a window showing it reads it again (PreviewPassword).
 */
export type PreviewSite = { projectId: string | null; url: string | null; label: string | null; serving: string | null; live: HostedApp["live"]; off?: true; protected?: boolean; passwordAt?: number };

/**
 * A site's Preview password (GET /api/hosted-apps/[name]/password?ws=&site=, the Bops window's alone): its link, whether
 * it asks for one (null: Orgo can't tell, or there's no link yet), the password, the cookie that opens the link
 * without asking (PASS_COOKIE), which only Bops' own preview view gets (desktop/preview-frames.cjs), and when Bops set
 * it (`at`, as PreviewSite.passwordAt: a window holding an older one reads it again). The password can be null while
 * it asks for one: Orgo kept only the cookie's check of it (a new one shows), or the user's key can't read it (`why`,
 * in words). POST { ws, site?,
 * action: "new" | "on" | "off" } answers it again: a new password (the link stays; people using the old one need the
 * new one), or the password on or off for that site (the owner's choice, kept). A new one comes with each Preview
 * deploy that goes live, too. Never in a bot's chat, and sent to none of the people the workspace is shared with
 * but those the owner gave Your Apps at Write (AppForMembers.sites[].previewPassword).
 */
export type PreviewPassword = { url: string | null; on: boolean | null; password: string | null; cookie: { name: string; value: string } | null; at?: number; why?: string };

/** The cookie orgo-web gives a browser that typed a Preview's password. */
export const PASS_COOKIE = "__Host-orgo_pass";

/** A deploy project of the app's repo on its computer that's no site's Published or Preview (an older Bops's, a test's): listed, never deployed to. */
export type LeftOver = { id: string; name: string; port: number | null; url: string | null };

/**
 * A site's Local as its computer said it last: its dev server's state (starting: its port doesn't answer
 * yet; failed: it stopped by itself, `error` its last words: the last lines of its log, up to LOG_LINES, one a
 * line, the last one last: localWords says it in one), its port, its dev port, the command it runs,
 * when it started. `port` is its address, http://localhost:<port>, the same on its computer and on this Mac
 * (which forwards that same port there): one a site, never another Local's on that computer, assigned there
 * by bops-local. `devPort` is the one it's meant to have, the same once it was assigned (a Local an older
 * bops-local started elsewhere runs on `port` until it starts again), from its second line (BOPS_LOCAL_MORE's
 * dev=; 3000 from a bops-local that doesn't say it). `env`: the names of its own variables
 * (on top of its Preview's, which it reads unless set here). From bops-local's second line (BOPS_LOCAL_MORE),
 * each there only when said: `lastGood`, the changeset its folder was last seen good at (its / answered below
 * 500, its folder clean) and when; `fixes`, Fix it presses since; `auth`, it signs in (next-auth, @auth/* or
 * better-auth in its package.json); `mismatch`, a port its dev server listens on instead of its own.
 */
export type LocalSite = {
  state: "running" | "starting" | "stopped" | "failed";
  port: number | null;
  devPort: number;
  command: string | null;
  since: number | null;
  error: string | null;
  env: string[];
  lastGood?: { at: string; when: number };
  fixes?: number;
  auth?: boolean;
  mismatch?: number;
};

/**
 * GET /api/hosted-apps/[name]/local?ws= : every site's Local, by site name (the app's own named as the app), of the
 * app's own working folder (its own bot's, `bot`, when that bot is still here); and each other bot's that works on it
 * (appCoders), of its own copy, in `copies` (none when only its own bot does).
 * `asleep`: its computer sleeps, so none runs (nothing was asked of it, so it stays asleep); `why`: it
 * couldn't be asked (no computer, Orgo not answering). POST …/local { ws, action: "start" | "stop" | "open"
 * | "preview" | "unpreview" | "fix", site?, bot?, command?, port?, start? } answers it again: start (its command, or
 * the one it had, or the one its folder says; `port` a port of its own, or "auto" for the lowest free one,
 * none for the one it has), stop, open it on its computer's screen (`opened`, on X display `display`: the
 * screen its bot's task on it works on, else a free one), preview it on this Mac (`preview`:
 * http://localhost:<port>/, the same port; refused with `fallback: "screen"` when this Mac can't), or count a
 * Fix it press (`fix`: the owner's only); each of `bot`'s copy (none: the app's own folder's, as for a bot that
 * doesn't work on it).
 */
export type LocalAnswer = { sites: Record<string, LocalSite>; bot?: { id: string; name: string }; copies?: LocalCopy[]; asleep?: true; why?: string; opened?: true; display?: number; preview?: string };

/** A bot's copy of an app on its computer (LocalAnswer.copies): the bot, its name, and its copy's Locals, by site (none started: {}). */
export type LocalCopy = { bot: string; name: string; sites: Record<string, LocalSite> };

/**
 * A bot's Locals of an app in an answer: its copy's, else (none named, the app's own bot, or a bot without a copy
 * there) the app's own folder's.
 */
export const localsOf = (a: LocalAnswer | null | undefined, botId?: string): Record<string, LocalSite> | undefined =>
  !a ? undefined : ((botId ? a.copies?.find((c) => c.bot === botId)?.sites : undefined) ?? a.sites);

/** Every Local in an answer: the app's own folder's, then each copy's. */
export const allLocals = (a: LocalAnswer | null | undefined): LocalSite[] => (a ? [...Object.values(a.sites), ...(a.copies ?? []).flatMap((c) => Object.values(c.sites))] : []);

/**
 * The bots that work on an app of workspace `ws`, each in a working folder of its own on its computer: its own bot
 * first (AppHosting.botId), then AppHosting.copies, then each bot of the workspace whose Works on (siteOf) is a site
 * of it and that works on its computer (workBot), in the workspace's order. Never a bot that's gone, nor any for an
 * app whose computer is gone.
 */
export function appCoders(state: { bots: Bot[]; workspaces?: { id: string; hostedApps?: Record<string, AppHosting>; botSites?: Record<string, BotSite> }[] }, ws: string, name: string): string[] {
  const h = state.workspaces?.find((w) => w.id === ws)?.hostedApps?.[name];
  if (!h || h.lost) return [];
  const team = state.bots.filter((b) => workspaceOf(b) === ws);
  const here = (id: string) => team.some((b) => b.id === id);
  const linked = team.filter((b) => siteOf(state, b)?.app === name && workBot(b, state.bots).computerId === h.computerId).map((b) => b.id);
  return [...new Set([h.botId, ...(h.copies ?? []), ...linked])].filter(here);
}

/**
 * Whether bot `botId` works on an app in a copy of its own (then its id, else undefined: the app's own folder is its,
 * or it doesn't work on the app, appCoders): every bot that works on it but its own bot, and that one too when it had
 * a copy before the app passed to it (AppHosting.copies). Whose Locals the Preview tab and Your Apps show.
 */
export function copyBotOf(state: Parameters<typeof appCoders>[0], ws: string, name: string, botId: string | undefined): string | undefined {
  const h = state.workspaces?.find((w) => w.id === ws)?.hostedApps?.[name];
  if (!botId || !h || (botId === h.botId && !h.copies?.includes(botId))) return undefined;
  return appCoders(state, ws, name).includes(botId) ? botId : undefined;
}

/** How many of a failed Local's last log lines LocalSite.error keeps (the ones that aren't empty), each cut at LOG_LINE. */
export const LOG_LINES = 6;
export const LOG_LINE = 300;

/** A failed Local's last words in one line (LocalSite.error's last), for a tooltip or a sentence. */
export const localWords = (error: string | null | undefined) => error?.split("\n").filter((l) => l.trim()).at(-1) ?? null;

/** A site's Local address: http://localhost:<its port> (its dev port before it ever ran). */
export const localAddress = (x: Pick<LocalSite, "port" | "devPort">) => `http://localhost:${x.port ?? x.devPort}`;

/** The port a Local had when nothing said (before each site had its own), and the first bops-local assigns. */
export const DEV_PORT = 3000;

/**
 * A site's name: one an app could have, short enough to be its deploy project's (orgo-web takes 32
 * characters), as its public address takes it (<name>.orgo.dev).
 */
export const isSiteName = (s: unknown): s is string => isAppName(s) && s.length <= 32;

/**
 * The agent token one of a workspace's computers signs in to Ingot with for it (Workspace.ingotTokens, by
 * computer): minted on the Mac with the user's Orgo key for that computer and workspace alone, and written
 * in the workspace's token file there (lib/server/ingot.ts ensureIngotCli). Kept: its id at Ingot, and the
 * sha256 of that file (to tell it from another), never the token.
 */
export type IngotToken = { id: string; sum: string; at: number };

/** One app as the Apps page shows it (GET /api/hosted-apps). */
export type HostedApp = {
  /** The Ingot repo's name (also the working folder's and the default site name). */
  name: string;
  /** The newest changeset on main (null: nothing committed yet). */
  head: string | null;
  updatedAt: number | null;
  hosting: AppHosting | null;
  /** The changeset its site serves now, as orgo-web says (null: none yet, or it couldn't be read). */
  serving: string | null;
  /** The newest deploy, whatever its state (null: never deployed, or it couldn't be read). */
  live: { id: string; at: string | null; state: DeployState | null; when: number | null; error: string | null; url: string | null } | null;
  /** Ingot can't say now (it isn't answering), so `head` and `updatedAt` aren't known. */
  offline?: true;
  /**
   * Every site of an app with more than one (its own first, then AppHosting.sites in order), each as `live`
   * and `serving` say it of the app's own above. Not there for an app with one site.
   */
  sites?: HostedSite[];
  /** Its own site's Preview (not there when Orgo couldn't be asked). `live`, `serving` and `hosting` above are Published's. */
  preview?: PreviewSite;
  /** Its own site's Published address: https://<its first active domain>, null when it has none (never an orgo.dev name). */
  domain?: string | null;
  /** Its own site's domains on Published's port (to say one is waiting for its DNS). */
  domains?: SiteDomain[];
  /** Projects of its repo on its computer that are no site's (LeftOver). */
  leftOver?: LeftOver[];
};

/**
 * One site of an app as the Apps page shows it: its name, address, what it serves and its newest deploy,
 * and its domains (the ones its computer serves on its port), read with every site's from its computer's
 * list at once; not there when Orgo couldn't say, or wasn't asked (its tab reads them again when it opens).
 */
export type HostedSite = {
  name: string;
  projectId: string | null;
  /** What Bops 0.0.32 kept of its address (never shown for Published now: `domain` is). */
  url: string | null;
  serving: string | null;
  live: HostedApp["live"];
  domains?: SiteDomain[];
  preview?: PreviewSite;
  domain?: string | null;
};

/** One of a site's domains as its app's Sites list shows it: its name and how it's doing (live, or waiting for its DNS). */
export type SiteDomain = { domain: string; status: AppDomainStatus };

/** One changeset, newest first (GET /api/hosted-apps/[name]/commits). `serving`: the site serves this one. */
export type AppCommit = {
  id: string;
  message: string;
  author: string;
  at: number;
  changes: { added: number; modified: number; deleted: number };
  serving: boolean;
};

/**
 * GET /api/hosted-apps/[name]/commits?ws=&before= (the app's log in Ingot). `next`: pass as `before` for
 * older ones. `offline`: Ingot can't be reached now.
 */
export type AppCommitsAnswer = { commits: AppCommit[]; head: string | null; next: string | null; offline?: boolean };

/**
 * GET /api/hosted-apps?ws= . `enabled` false with `why` when deploying can't work here (signed out,
 * self-hosted, or Orgo answers that hosting isn't open to this account); the apps are still listed.
 */
export type HostedAppsAnswer = { enabled: boolean; why?: string; apps: HostedApp[] };

/**
 * POST /api/hosted-apps/[name] with { ws, action }:
 * - "deploy" { at?, botId?, site? }: deploys changeset `at` (default the newest on main) on the app's
 *   computer, or on `botId`'s the first time (or when its computer is gone): every site of it, one after
 *   another, or the one `site` names; answers { app }.
 * - "rollback" { deployment, site? }: puts one of its (or that site's) earlier deploys live again, without a
 *   build; answers { app }.
 * - "addSite" { site }: one more site of it, by name, made on Orgo with its first deploy (or its variables);
 *   "removeSite" { site }: one of those taken off its computer, its domains too. Each answers { app }.
 * DELETE /api/hosted-apps/[name] { ws, repo } removes the app (RemoveAppAnswer): its sites and their domains
 * off its computer, its record from the workspace, and its Ingot repo too only when `repo` is true.
 * GET /api/hosted-apps/[name]/logs?ws=&after=&site= answers the newest deploy's { state, log, next, more }.
 *
 * Every route about one site of it (logs, settings, env, dns, domains) takes `site` the same way, in its
 * query or its body: none names the app's own site, as before there were more. Rollback, logs and settings
 * take `env` the same way ("preview"; none is Published, as before there was a Preview), and env takes `where`
 * ("preview", or "local": Local's own variables, kept on its computer). A deploy goes to the Preview unless it
 * says env "prod" (the window never does: Publish does that). "promote" { site?, at? } (Publish) deploys on
 * Published the changeset the Preview serves (each site's own; `at`, with `site`: the one the window saw,
 * refused when the Preview moved on since, PREVIEW_MOVED; a site with no domain and nothing published yet is
 * refused, NO_DOMAIN). "reapply" { site? }: Published's own commit built again, with its variables now.
 * "removeLeftOver" { project }: one of HostedApp.leftOver taken off its computer. "preview" { site?, label? }:
 * its Preview made now (its link, before any deploy), with `label` when the owner chose it ahead (labelGiven).
 * "restore" { to }: the whole app (every site shares its repo and working folder) put back as it was at changeset
 * `to`, as a new changeset on top of main, its working folder on its computer pulled after; the owner's alone, and
 * refused while a task works on it or its folder has changes nobody committed. Answers { app, restored?, said }
 * (`restored`: the new changeset; none when it's like that already).
 */
export type HostedAppAction =
  | { ws: string; action: "deploy"; at?: string; botId?: string; site?: string; env?: "preview" | "prod" }
  | { ws: string; action: "promote"; at?: string; site?: string }
  | { ws: string; action: "reapply"; site?: string }
  | { ws: string; action: "rollback"; deployment: string; site?: string; env?: "preview" | "prod" }
  | { ws: string; action: "addSite" | "removeSite"; site: string }
  | { ws: string; action: "removeLeftOver"; project: string }
  | { ws: string; action: "preview"; site?: string; label?: string }
  | { ws: string; action: "restore"; to: string };

/**
 * GET /api/hosted-apps/[name]?ws=&restore=<to> (the owner's alone), for Restore's question before it's sent: every
 * changeset on main after `to`, newest first, which a restore to `to` undoes (its first line, who, when), and
 * `blocked`, why it can't be restored now, in words (a task works on it, it's like that now, Ingot isn't answering).
 */
export type AppRestoreConfirm = { later: { id: string; title: string; author: string; at: number }[]; blocked?: string };

/** What removing an app did: `said`, what couldn't be (a domain Orgo kept), in words. */
export type RemoveAppAnswer = { removed: string; repo: boolean; said?: string };

/* ---------------- Its domains and their DNS ---------------- */

/**
 * The record types a domain bought through Orgo can have (orgo-web lib/domains/records.ts). MX has a
 * priority; SRV a priority, a weight and a port.
 */
export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"] as const;
export type DnsType = (typeof DNS_TYPES)[number];

/** What a record of that type takes besides its name and value. */
export const dnsNeeds = (type: string) => ({ priority: type === "MX" || type === "SRV", weight: type === "SRV", port: type === "SRV" });

/** One record of a bought domain's zone. `name` is relative to it ("" for the domain itself, "www", "_dmarc"). */
export type AppDnsRecord = {
  /** Orgo's id for it, made from what it says: any change gives it a new one. */
  id: string;
  type: DnsType;
  name: string;
  fqdn: string;
  value: string;
  priority?: number;
  weight?: number;
  port?: number;
  /** Orgo wrote it so a domain reaches a computer, and keeps it: why, in words (null: the user's own, to change). */
  locked: string | null;
};

/** A record as it's typed to add it, or as it becomes (a change sends all of it). Numbers may come as typed. */
export type AppDnsInput = { type: string; name: string; value: string; priority?: number | string; weight?: number | string; port?: number | string };

/**
 * A domain bought through Orgo that points at the app (or one of its names does), and its DNS records.
 * `id` is the bought domain's at Orgo, what a change names; `serving` is false while its nameservers are
 * someone else's, when the records are kept but don't answer. `error`: the records couldn't be read.
 */
export type AppDnsZone = { id: string; domain: string; serving: boolean; ttl: number | null; records: AppDnsRecord[]; error?: string; renewal?: AppRenewal };

export type AppDomainStatus = "pending" | "verifying" | "active" | "failed" | "disabled";

/** One of the app's domains: one its computer serves on the app's port (orgo-web custom_domains.target_port). */
export type AppDomain = {
  id: string;
  domain: string;
  status: AppDomainStatus;
  /** Its HTTPS certificate: issued once the edge allowed one (an active domain gets it on its first visit). */
  cert: "pending" | "issued";
  /** Bought through Orgo: Orgo writes its records itself, in the zone `zone` (null when it can't be told which). */
  managed: boolean;
  zone: string | null;
  /**
   * One bought elsewhere: the records to set where its DNS is kept (once it's live, only what routes it),
   * and what Orgo found when it looked (none when it couldn't look). Orgo never changes them, so the app
   * shows them greyed, to copy, with Verify. `where`: who keeps its DNS, when Orgo could tell.
   */
  publish: { type: string; name: string; value: string; found?: "ok" | "missing" | "wrong" }[];
  where?: string | null;
  /**
   * One bought elsewhere whose DNS is in the user's own Cloudflare account (the zone it's in, as Cloudflare
   * names it, and its id there), read with the Cloudflare key in their Orgo vault: Bops can set its records
   * there (CloudflarePlan). Not there without that key, or when its zone isn't in that account.
   */
  cloudflare?: { zone: string; zoneId: string };
};

/**
 * GET /api/hosted-apps/[name]/dns?ws= : its public address on orgo.dev, the domains that point at it, and
 * the zones of the ones bought through Orgo (each once, however many of its names point here), each with
 * its renewal when Orgo says it.
 * POST …/dns/records { ws, zone, ...AppDnsInput } adds a record, PATCH …/dns/records/[id] { ws, zone,
 * ...AppDnsInput } changes one (all of it), DELETE …/dns/records/[id] { ws, zone } removes one (`zone`:
 * the AppDnsZone's id). Each answers AppDnsWritten, or { error, field? }, and when the records changed
 * since the window read them, { error, stale: true, zone?, records? } with them as they are now.
 */
export type AppDomainsAnswer = { url: string | null; domains: AppDomain[]; zones: AppDnsZone[] };

/** A zone's records as a change wrote them (a change never moves its nameservers, so `serving` stays as it was). */
export type AppDnsWritten = { zone: string; records: AppDnsRecord[] };

/**
 * Who pays a bought domain's renewal and how it stands (orgo-web presentRegisteredDomain): Orgo renews it
 * itself from the payer's Orgo credits while `on` (auto-renew), `cents` for `years` at a time. `payer`: "you"
 * (the signed-in account), "member" (someone else in the workspace), null while it's off. `expires`: ms.
 * `error`: why the last try failed, in words, while it's retrying.
 */
export type AppRenewal = {
  on: boolean;
  cents: number | null;
  years: number;
  payer: "you" | "member" | null;
  state: "off" | "scheduled" | "renewing" | "retrying" | "expired";
  error: string | null;
  expires: number | null;
};

/* ---------------- Adding an app ---------------- */

/** An app's name: an Ingot repo's (lowercase letters and digits in words joined by hyphens, at most 64). */
export const isAppName = (s: unknown): s is string => typeof s === "string" && s.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

/** A copy's name (its folder is /workspace/apps/<app>.<copy>, its Locals' keys <app>.<copy>--<site>): as an app's, at most 40. */
export const isCopyName = (s: unknown): s is string => isAppName(s) && s.length <= 40;

/** A name as it's typed into Add app: lowercase, spaces and underscores as hyphens (the rest is checked, not changed). */
export const typedAppName = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "-").slice(0, 64);

/**
 * POST /api/hosted-apps { ws, name, what, deploy } (the Apps page's Add app): the workspace's main bot
 * builds it on its computer, as work_on_app does, and puts it live once it has committed when `deploy`.
 * Answers AddAppAnswer: the task, in that bot's chat. A name another app has is a 409.
 */
export type AddAppAsk = { ws: string; name: string; what: string; deploy: boolean };
export type AddAppAnswer = { name: string; botId: string; chatId: string; sessionId: string };

/* ---------------- Its settings, variables and deploys ---------------- */

/**
 * What of an app's deploy project can be changed here (orgo-web PATCH deploy-projects: its name is fixed).
 * Null commands: Orgo finds them. `health`: the path Orgo asks for to tell a new release answers before it
 * puts it live ("/" unless it was changed; not there when Orgo doesn't say).
 */
export type AppProjectSettings = { port: number | null; install: string | null; build: string | null; start: string | null; health?: string };

/** One of its recent deploys (orgo-web DeploymentView). `live`: its release is the one serving now; `canRollback`: it can be put back without a build. */
export type AppDeploy = {
  id: string;
  state: DeployState;
  /** The changeset it built (null: not known yet). */
  at: string | null;
  /** Put back from an earlier one (a rollback), rather than built. */
  rollback: boolean;
  when: number | null;
  error: string | null;
  live: boolean;
  canRollback: boolean;
};

/**
 * GET /api/hosted-apps/[name]/settings?ws=&site= : its address, what can be changed of its deploy project,
 * its variables' names (Orgo never gives their values back), and its recent deploys. `settings` null: no
 * project yet (never deployed, no variables saved), when there's nothing to change but its variables.
 * PATCH …/settings { ws, site?, port?, install?, build?, start?, health? } changes them (answers this again);
 * a new port moves its domains with it. PATCH …/env { ws, site?, env: { NAME: value | null } } sets or
 * removes variables (answers { env } names), making its deploy project first when it has none yet, so its
 * first build has them; their values go to Orgo alone, never into Bops' state or its logs.
 */
export type AppSettingsAnswer = {
  url: string | null;
  settings: AppProjectSettings | null;
  env: string[];
  deploys: AppDeploy[];
  said?: string;
  /** Of the Preview's (env=preview): Published's variables' names, so the window says which the Preview doesn't have. */
  prodEnv?: string[];
};
export type AppSettingsChange = { ws: string; site?: string; env?: "preview" | "prod"; port?: number | string; install?: string; build?: string; start?: string; health?: string };
export type AppEnvChange = { ws: string; site?: string; where?: AppEnv; env: Record<string, string | null> };

/** A variable's name as orgo-web takes it (uppercase shell names); PORT and the shell's own are Orgo's. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const ENV_RESERVED: ReadonlySet<string> = new Set(["PORT", "PATH", "HOME", "BASH_ENV", "ENV", "IFS", "SHELLOPTS", "BASHOPTS", "PS4"]);

/* ---------------- Adding a domain ---------------- */

/**
 * One name a search found (orgo-web GET /api/domains/search): `price` is what buying it costs in Orgo
 * credits, in cents, for `years` (its shortest term), and `renewal` each year after. Only an available one is
 * priced; "premium" ones aren't sold here, "unknown" ones the registry didn't answer for.
 */
export type DomainOffer = { domain: string; status: "available" | "taken" | "premium" | "unknown"; price: number | null; renewal: number | null; years: number | null };

/** GET /api/hosted-apps/[name]/domains/search?ws=&q=&page= : a page of names (`next`: the page after, null when there's none). */
export type DomainSearchAnswer = { results: DomainOffer[]; next: number | null; partial?: boolean };

/** Who a domain is registered to (orgo-web lib/domains/registrant.ts): what the registry requires, as it requires it. */
export const REGISTRANT_FIELDS = [
  { key: "first_name", label: "First name", max: 64 },
  { key: "last_name", label: "Last name", max: 64 },
  { key: "org_name", label: "Organization", optional: true, max: 100 },
  { key: "email", label: "Email", max: 254 },
  { key: "phone", label: "Phone", max: 20 },
  { key: "address1", label: "Address", max: 100 },
  { key: "address2", label: "Address line 2", optional: true, max: 100 },
  { key: "city", label: "City", max: 64 },
  { key: "state", label: "State or region", max: 64 },
  { key: "postal_code", label: "Postal code", max: 16 },
  { key: "country", label: "Country", max: 2 },
] as const satisfies readonly { key: string; label: string; optional?: boolean; max: number }[];
export type RegistrantField = (typeof REGISTRANT_FIELDS)[number]["key"];
export type Registrant = Partial<Record<RegistrantField, string>>;

/**
 * GET /api/hosted-apps/[name]/domains?ws= (the window only): what a domain can be added from. `buy.open`
 * false with why when buying isn't possible here (not open to the account, view only access, a key for one
 * workspace); `owned`: every one of the workspace's bought domains (active ones), each with the names under
 * it that point somewhere already (`inUse`: the app that serves it when it's on this app's computer, else
 * `where`, the computer's name), so one is used as it is, or with a name under it; `contact`: who the user
 * registered their last domain to, as Orgo keeps it, to fill the form (never kept by Bops).
 */
export type AppDomainOptions = { buy: { open: boolean; why?: string }; owned: OwnedDomain[]; contact: Registrant | null; cloudflare?: CloudflareOptions };

/**
 * What Add a domain offers from the user's own Cloudflare account, read with the Cloudflare key in their
 * Orgo vault through Orgo (the key never leaves Orgo): its active domains (zones), the first 200 (`more`:
 * there are others), or why none (`why`: the key is there but Orgo or Cloudflare can't use it now). Not
 * there at all without a Cloudflare key: Add a domain is as it was.
 */
export type CloudflareOptions = { zones: CloudflareZone[]; more?: true; why?: undefined } | { why: string; zones?: undefined };

/**
 * One of the user's Cloudflare domains (a zone): its id there, its name, the Cloudflare account it's in when
 * the key sees more than one, and the names on this app's computer that are it or under it (as OwnedDomain's).
 */
export type CloudflareZone = { id: string; domain: string; account?: string; inUse: OwnedDomain["inUse"] };

/**
 * One line of what Bops would change in Cloudflare for a domain: `op` add, change (the record `was` before),
 * remove, same (set already: nothing to do) or blocked (`note` says why, and nothing is written). `name` in
 * full, `host` as the zone names it (@ for the zone itself). `theirs`: a record Bops didn't set, changed only
 * after the user said so (Replace and add); `stale`: one Bops set for a domain that's gone.
 */
export type CloudflareChange = {
  op: "add" | "change" | "remove" | "same" | "blocked";
  type: string;
  name: string;
  host: string;
  value: string;
  was?: string;
  theirs?: true;
  stale?: true;
  note?: string;
};

/**
 * What Bops would set in Cloudflare for one of the app's domains, before anything is written
 * (GET /api/hosted-apps/[name]/domains/[domainId]/cloudflare?ws=&site=): the zone and its id there, every
 * change, whether one needs the user's OK (`ask`), why it can't be (`blocked`), and the plan's fingerprint,
 * which the apply sends back so only this very plan is written.
 */
export type CloudflarePlan = { zone: string; zoneId: string; domain: string; domainId: string; changes: CloudflareChange[]; ask: boolean; blocked: string | null; fingerprint: string };

/**
 * POST …/domains/[domainId]/cloudflare { ws, site?, plan, replace? }: the plan written in one Cloudflare batch
 * (all of it or none), then Orgo asked to check the domain. Answers it as checked, and how many records were
 * written; refused with { error, code }: STALE with the plan as it is now (`cloudflare`), NEEDS_OK when it
 * replaces records Bops didn't set and `replace` wasn't sent, BLOCKED, NO_EDIT, UNKNOWN (Cloudflare didn't
 * answer, so whether it went in isn't known).
 */
export type CloudflareApplied = AppDomainChecked & { written: number };
export type CloudflareApply = { ws: string; site?: string; plan: string; replace?: true };

/** One of the workspace's bought domains as Add a domain offers it: what points at it or under it already. */
export type OwnedDomain = { id: string; domain: string; inUse: { name: string; app?: string; where?: string }[] };

/**
 * POST /api/hosted-apps/[name]/domains (the window only):
 * - { ws, action: "buy", domain, registrant, price }: buys it for `price` cents of Orgo credits (refused,
 *   with the price now, when it changed), then points it at this app;
 * - { ws, action: "connect", domain } (one the user owns, or a name under one bought through Orgo) or
 *   { ws, action: "connect", zone, subdomain? } (a bought one, by its id, or the name `subdomain` under
 *   it, like www): points it at this app.
 * Answers AppDomainAdded: the app's domains as they are now and the one added. A buy that went through but
 * couldn't be pointed here says so in `error`, with `bought`. Refused: { error, code?, field?, price?,
 * renewal?, years?, available? } (Orgo's code, so the window can ask again at a new price).
 * PATCH …/domains { ws, zone, autoRenew } turns a bought domain's auto-renew on or off (answers { renewal }).
 * POST …/domains/[id] { ws } checks a domain's DNS (answers { domain, said? }), DELETE …/domains/[id] { ws }
 * removes it from the app (answers AppDomainsAnswer).
 */
export type AppDomainAdd = (
  | { ws: string; action: "buy"; domain: string; registrant: Registrant; price: number }
  | { ws: string; action: "connect"; domain?: string; zone?: string; subdomain?: string }
  | { ws: string; action: "cloudflare"; zone: string; subdomain?: string }
) & { site?: string };
/**
 * `cloudflare` and `fresh`: one added from the user's Cloudflare ({ action: "cloudflare", zone, subdomain? },
 * the zone by its Cloudflare id), with what Bops would set there for it; it was just pointed here, so Cancel
 * takes it off again.
 */
export type AppDomainAdded = { domains: AppDomainsAnswer; domain: AppDomain | null; bought?: string; error?: string; cloudflare?: CloudflarePlan; fresh?: true };
export type AppDomainChecked = { domain: AppDomain; said?: string };
/** DELETE …/domains/[id]: its domains as they are now; `said`, what Bops couldn't take off in Cloudflare too, in words. */
export type AppDomainRemoved = AppDomainsAnswer & { said?: string };

/**
 * Search results as a person reads them (as orgo.ai orders them): the exact name typed first, then the ones
 * that can be bought, then the rest, each group in Orgo's order.
 */
export function offersInOrder(results: DomainOffer[], typed: string): DomainOffer[] {
  const exact = typed.trim().toLowerCase();
  const rank = (o: DomainOffer) => (o.domain === exact ? 0 : o.status === "available" && o.price !== null ? 1 : 2);
  return results
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i)
    .map(({ o }) => o);
}

/**
 * A name under a bought domain as it's typed to point it, lowercase ("" for the domain itself): labels of
 * letters, digits and hyphens, 1 to 63 each, no hyphen at either end, joined by dots. Null: it can't be one.
 */
export function subdomainTyped(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase().replace(/\.+$/, "");
  if (!t) return "";
  return t.length <= 200 && t.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ? t : null;
}

/* ---------------- The workspace's domains ---------------- */

/**
 * A name under one of the workspace's bought domains (or the domain itself) that points at a computer: the
 * app that serves it, and its site when that isn't the app's own, when it's one of this workspace's apps;
 * else `where`, the computer's name. `status`: how it's doing there.
 */
export type DomainUse = { name: string; status: AppDomainStatus; app?: string; site?: string; where?: string };

/** A domain the workspace bought through Orgo (orgo-web lists only pending and active ones), with its renewal and what points at it. */
export type WorkspaceDomain = { id: string; domain: string; status: "pending" | "active"; renewal?: AppRenewal; uses: DomainUse[] };

/**
 * GET /api/domains?ws= (Settings, Domains; the window only). `open` false with why: nothing of domains
 * here (not signed in, not on Orgo, closed to the account, Bops on a bot's computer). `buy` and `contact`
 * as in AppDomainOptions; `domains` newest first, as Orgo lists them.
 */
export type WorkspaceDomainsAnswer = { open: boolean; why?: string; buy: { open: boolean; why?: string }; contact: Registrant | null; domains: WorkspaceDomain[] };

/**
 * POST /api/domains { ws, domain, registrant, price }: bought for the workspace at `price` cents of Orgo
 * credits (the price the user saw), pointed nowhere. Answers the list as it is now, and the one bought.
 */
export type WorkspaceDomainBuy = { ws: string; domain: string; registrant: Registrant; price: number };
export type WorkspaceDomainBought = { domains: WorkspaceDomainsAnswer; bought: string };

/**
 * GET /api/domains/[zone]?ws= : one of its bought domains' zone (each record Orgo keeps locked, with why),
 * with its renewal, and what points at it. PATCH /api/domains/[zone] { ws, autoRenew } turns its auto-renew
 * on or off (answers { renewal }). POST /api/domains/[zone]/records { ws, ...AppDnsInput } adds a record,
 * PATCH …/records/[id] { ws, ...AppDnsInput } changes one, DELETE …/records/[id] { ws } removes one; each
 * answers AppDnsWritten, or why not (as the app's own DNS routes do).
 */
export type WorkspaceZoneAnswer = { zone: AppDnsZone; uses: DomainUse[] };

/**
 * What people a workspace is shared with see of its apps on the web, at Your Apps Read or more (Workspace.appsForMembers,
 * lib/server/apps-for-members.ts seeApps), as the owner's Mac last read Ingot and Orgo: never variables, Ingot tokens,
 * keys, deploy logs or a deploy's error text, who a domain is registered to, DNS records, or computer and project ids.
 */
export type AppsForMembers = {
  /** When this Mac last read them: written when something changed, or an hour after the last write. */
  at: number;
  apps: Record<string, AppForMembers>;
  /** The workspace's domains bought through Orgo, for Use a domain: sent to Write only (cloud/ws-slice.ts appsFor). */
  owned?: { id: string; domain: string }[];
};

/** One app as members see it (AppsForMembers.apps). */
export type AppForMembers = {
  /** The newest changeset on main. */
  head: { id: string; message: string; at: number } | null;
  /**
   * Every site, its own first: HostedSite without its project id. `url`: its Published address (its first
   * active domain, or null; never an orgo.dev name), `preview`: its Preview link (null: none yet), where members
   * deploy, with its newest deploy (`previewLive`) and what it serves (`previewServing`). `previewProtected`: that
   * link asks for a password; `previewPassword`: the password, only while someone has Your Apps at Write (Bops
   * Cloud sends it to them alone: cloud/ws-slice.ts appsFor). Never in a bot's chat or prompt.
   */
  sites: {
    name: string;
    url: string | null;
    preview?: string | null;
    previewLive?: { id: string; state: DeployState | null; when: number | null } | null;
    previewServing?: string | null;
    previewProtected?: true;
    previewPassword?: string;
    serving: string | null;
    live: { id: string; state: DeployState | null; when: number | null } | null;
    domains?: SiteDomain[];
  }[];
  /** The newest MEMBER_COMMITS changesets on main (AppCommit without `serving`, which `sites[].serving` says). */
  commits: { id: string; message: string; author: string; at: number; changes: AppCommit["changes"] }[];
  /** The newest MEMBER_DEPLOYS deploys of each site, newest first: AppDeploy without `error`, with where it went (`env`, none: Published's). */
  deploys: (Omit<AppDeploy, "error"> & { site: string; env?: "preview" | "prod" })[];
  /** Each site's settings (AppProjectSettings), by site: sent to Write only. */
  settings?: Record<string, AppProjectSettings>;
  /** What members did to it, newest first, at most MEMBER_ACTS: who, what, and how it went (named as the member). */
  acts?: MemberAppAct[];
};

/** A member's act on an app, as the owner's Mac did it or refused it (lib/server/member-acts.ts). */
export type MemberAppAct = { key: string; userId: string; name: string; act: "deploy" | "rollback" | "settings" | "domain"; site?: string; domain?: string; ok: boolean; said?: string; at: number };

/** How much members are shown: apps, sites of each, changesets, deploys a site, and acts kept. */
export const MEMBER_APPS = 30;
export const MEMBER_COMMITS = 20;
export const MEMBER_DEPLOYS = 10;
export const MEMBER_ACTS_KEPT = 10;

/** An app's sites by name: its own (named as the app), then AppHosting.sites in order. */
export const sitesOfHosting = (h: Pick<AppHosting, "sites">, name: string): string[] => [name, ...(h.sites ?? []).map((s) => s.name)];
