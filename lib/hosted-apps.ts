/*
 * Apps a workspace builds and runs on the web. Each app is an Ingot repo (Orgo's own source control, not
 * git: ingot/docs/hosted-api.md) in the central Ingot, under the workspace's Orgo project, where everyone
 * signs in with their Orgo key. A bot works on it on its Bops computer, in a working folder at
 * /workspace/apps/<name> made with `ingot clone`, through its brain (Claude Code, Codex, or Bops agent),
 * committing with `ingot commit` or the Ingot MCP tools; two people committing at once can't overwrite
 * each other (a commit names its base; a stale one is refused and `ingot pull` merges). Deploying builds
 * one changeset on that computer with orgo-web's deploy runner, at a public URL (<name>.orgo.dev).
 * Imported by the window and the Mac server.
 */

export type DeployState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "superseded";

/**
 * Where an app is worked on and runs, kept on its workspace (Workspace.hostedApps, by repo name): the bot
 * whose computer holds its working folder and runs its site, and once it was first deployed (or its
 * variables were first saved), the deploy project there and its public URL.
 */
export type AppHosting = {
  botId: string;
  computerId: string;
  projectId?: string;
  url?: string;
  /** When this Mac last queued a deploy of it (a bot's, or the window's), so a window showing it reads it again. */
  queuedAt?: number;
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
};

/** A site's deploy project left on a computer the app moved off (AppHosting.behind). */
export type AppProjectBehind = { site: string; computerId: string; projectId: string };

/** One more site of an app (AppHosting.sites): its name, and once it was made, its deploy project and public URL. */
export type AppSiteHosting = { name: string; projectId?: string; url?: string };

/**
 * How many sites an app can have: as many deploy projects as one computer takes (orgo-web
 * PROJECTS_PER_COMPUTER), which other apps on that computer count toward too (Orgo says so then).
 */
export const MAX_SITES = 5;

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
};

/**
 * One site of an app as the Apps page shows it: its name, address, what it serves and its newest deploy,
 * and its domains (the ones its computer serves on its port), read with every site's from its computer's
 * list at once; not there when Orgo couldn't say, or wasn't asked (its tab reads them again when it opens).
 */
export type HostedSite = { name: string; projectId: string | null; url: string | null; serving: string | null; live: HostedApp["live"]; domains?: SiteDomain[] };

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
 * query or its body: none names the app's own site, as before there were more.
 */
export type HostedAppAction =
  | { ws: string; action: "deploy"; at?: string; botId?: string; site?: string }
  | { ws: string; action: "rollback"; deployment: string; site?: string }
  | { ws: string; action: "addSite" | "removeSite"; site: string };

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
export type AppSettingsAnswer = { url: string | null; settings: AppProjectSettings | null; env: string[]; deploys: AppDeploy[]; said?: string };
export type AppSettingsChange = { ws: string; site?: string; port?: number | string; install?: string; build?: string; start?: string; health?: string };
export type AppEnvChange = { ws: string; site?: string; env: Record<string, string | null> };

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
 * workspace); `owned`: the workspace's bought domains nothing points at yet, to use as they are; `contact`:
 * who the user registered their last domain to, as Orgo keeps it, to fill the form (never kept by Bops).
 */
export type AppDomainOptions = { buy: { open: boolean; why?: string }; owned: { id: string; domain: string }[]; contact: Registrant | null };

/**
 * POST /api/hosted-apps/[name]/domains (the window only):
 * - { ws, action: "buy", domain, registrant, price }: buys it for `price` cents of Orgo credits (refused,
 *   with the price now, when it changed), then points it at this app;
 * - { ws, action: "connect", domain } (one the user owns, or a name under one bought through Orgo) or
 *   { ws, action: "connect", zone } (a bought one, by its id): points it at this app.
 * Answers AppDomainAdded: the app's domains as they are now and the one added. A buy that went through but
 * couldn't be pointed here says so in `error`, with `bought`. Refused: { error, code?, field?, price?,
 * renewal?, years?, available? } (Orgo's code, so the window can ask again at a new price).
 * PATCH …/domains { ws, zone, autoRenew } turns a bought domain's auto-renew on or off (answers { renewal }).
 * POST …/domains/[id] { ws } checks a domain's DNS (answers { domain, said? }), DELETE …/domains/[id] { ws }
 * removes it from the app (answers AppDomainsAnswer).
 */
export type AppDomainAdd = ({ ws: string; action: "buy"; domain: string; registrant: Registrant; price: number } | { ws: string; action: "connect"; domain?: string; zone?: string }) & { site?: string };
export type AppDomainAdded = { domains: AppDomainsAnswer; domain: AppDomain | null; bought?: string; error?: string };
export type AppDomainChecked = { domain: AppDomain; said?: string };
