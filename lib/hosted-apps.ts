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
 * whose computer holds its working folder and runs its site, and once it was first deployed, the deploy
 * project there and its public URL.
 */
export type AppHosting = {
  botId: string;
  computerId: string;
  projectId?: string;
  url?: string;
  /** When this Mac last queued a deploy of it (a bot's, or the window's), so a window showing it reads it again. */
  queuedAt?: number;
};

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
};

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
 * - "deploy" { at?, botId? }: deploys changeset `at` (default the newest on main) on the app's computer,
 *   or on `botId`'s the first time; answers { app }.
 * GET /api/hosted-apps/[name]/logs?ws=&after= answers the newest deploy's { state, log, next, more }.
 */
export type HostedAppAction = { ws: string; action: "deploy"; at?: string; botId?: string };

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
export type AppDnsZone = { id: string; domain: string; serving: boolean; ttl: number | null; records: AppDnsRecord[]; error?: string };

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
   * One bought elsewhere, not live yet: the records to set where its DNS is kept, and what Orgo found
   * when it looked (none when it couldn't look). `where`: who keeps its DNS, when Orgo could tell.
   */
  publish: { type: string; name: string; value: string; found?: "ok" | "missing" | "wrong" }[];
  where?: string | null;
};

/**
 * GET /api/hosted-apps/[name]/dns?ws= : its public address on orgo.dev, the domains that point at it, and
 * the zones of the ones bought through Orgo (each once, however many of its names point here).
 * POST …/dns/records { ws, zone, ...AppDnsInput } adds a record, PATCH …/dns/records/[id] { ws, zone,
 * ...AppDnsInput } changes one (all of it), DELETE …/dns/records/[id] { ws, zone } removes one (`zone`:
 * the AppDnsZone's id). Each answers AppDnsWritten, or { error, field? }, and when the records changed
 * since the window read them, { error, stale: true, zone?, records? } with them as they are now.
 */
export type AppDomainsAnswer = { url: string | null; domains: AppDomain[]; zones: AppDnsZone[] };

/** A zone's records as a change wrote them (a change never moves its nameservers, so `serving` stays as it was). */
export type AppDnsWritten = { zone: string; records: AppDnsRecord[] };
