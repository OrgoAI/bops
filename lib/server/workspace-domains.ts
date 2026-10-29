import "server-only";
import type { AppDnsWritten, AppDnsZone, AppDomainStatus, AppRenewal, DomainSearchAnswer, DomainUse, WorkspaceDomain, WorkspaceDomainBought, WorkspaceDomainsAnswer, WorkspaceZoneAnswer } from "@/lib/hosted-apps";
import {
  BUY_CLOSED,
  BUY_NEEDS,
  buyFailed,
  buyingOnce,
  closedHere,
  computerOf,
  contactOf,
  dnsRefused,
  DOMAINS_UNREACHED,
  domainsProjectOf,
  domainTyped,
  held,
  HostedAppError,
  inputOf,
  mainBot,
  portsOn,
  RECORD_ID,
  recordsOf,
  registrantOf,
  renewalOf,
  renewRefused,
  searchOrgo,
  searchWords,
  STALE,
  UUID,
  workspace,
  zoneView,
  type LockOf,
  type Typed,
} from "./hosted-apps";
import { domains, OrgoError, type OrgoBoughtDomain, type OrgoBoughtList, type OrgoDnsRecord } from "./orgo";
import { onRunner } from "./persist";
import { sameState } from "./store";

/*
 * A workspace's domains, as Settings shows them (components/app/workspace-domains.tsx): every domain the
 * workspace bought through Orgo, each with its renewal, the apps and sites its names serve, and its DNS
 * records; a domain searched for and bought there, without an app, pointed nowhere. All of it with the
 * Mac's own Orgo sign in, from this Mac: no computer is asked or woken. A zone id the window names is never
 * taken on its word: every change reads the workspace's list from Orgo first, and acts only on an active
 * domain in it. The registrant goes from the window to Orgo in the one request that buys, never kept or
 * logged here; who the user registered their last one to (`contact`) goes only to the window.
 *
 * Bops on a bot's computer (persist.ts onRunner) has no domains: orgo-web refuses every domain call there
 * (its permissions keep them off a computer's key), so nothing is asked of Orgo and it says so. Only an
 * @orgo.ai account reaches any of this (the routes, lib/apps-access.ts).
 */

const RUNNER = "Domains are changed from the Bops app on your Mac.";
const NOT_ON_ORGO = "This workspace isn't on Orgo yet, so it can't have domains.";
const NOT_OURS = "That isn't one of this workspace's domains.";
const SIGN_IN = "Sign in with Orgo to see this workspace's domains.";
const PENDING = "This domain is still being registered. Try again in a few minutes.";

const UNREACHED_CHANGE = "Couldn't reach Orgo just now.";

const STATUSES: readonly AppDomainStatus[] = ["pending", "verifying", "active", "failed", "disabled"];

/**
 * Orgo turned a domains call down, in plain words (dnsRefused); one that never got an answer Bops can read
 * (a dropped connection, a timeout, an answer that isn't JSON) is `words`, never Node's own.
 */
const plainly = (e: unknown, words: string) => {
  const r = dnsRefused(e);
  return r instanceof HostedAppError ? r : new HostedAppError(words, 502);
};

/** Before any Orgo call: Bops on the Mac (not a bot's computer), the workspace there, and signed in with Orgo. */
async function ready(wsId: string, ours: () => boolean): Promise<void> {
  if (onRunner()) throw new HostedAppError(RUNNER, 403);
  if (!workspace(wsId)) throw new HostedAppError("That workspace is gone.", 404);
  const closed = await closedHere();
  held(ours);
  if (closed) throw new HostedAppError(SIGN_IN, 403);
}

/**
 * The Orgo workspace a Bops workspace's domains are listed and bought under: the one its main bot's
 * computer is in, as an app's tab asks it of the app's computer (domainsProjectOf), so both read and buy
 * into the same one; else its own project. Null: not on Orgo yet (no call made when there's no computer to
 * ask about). Orgo not answering is said (DOMAINS_UNREACHED), never taken for not on Orgo.
 */
async function domainsProject(wsId: string, ours: () => boolean): Promise<string | null> {
  const m = mainBot(wsId);
  return (await domainsProjectOf(wsId, m ? computerOf(m.id) : undefined, ours)) ?? null;
}

/** Who a name serves, as a line says it: the app, the app and its site, or the computer. */
const servedBy = (u: DomainUse | undefined, fallback: string) => (u?.app ? (u.site ? `${u.app}, site ${u.site}` : u.app) : (u?.where ?? fallback));

/**
 * Who serves each name pointed under the domains `list`: for each computer one is on that one of the
 * workspace's apps lives on (its own, or one it left a site behind on), that computer's custom domains (name
 * to port) and its deploy projects (port to app and site), read once each, all at once, never waking it.
 * Anything not found there, or on a computer of none of its apps, is `where`, the computer's name. Also
 * each custom domain's name by its id, for the records Orgo keeps for them.
 */
async function usesOf(wsId: string, list: OrgoBoughtDomain[], ours: () => boolean): Promise<{ uses: Map<string, DomainUse[]>; byCustomId: Map<string, string> }> {
  const apps = Object.values(workspace(wsId)?.hostedApps ?? {});
  const theirs = new Set(apps.flatMap((h) => [h.computerId, ...(h.behind ?? []).map((b) => b.computerId)]));
  const asked = [...new Set(list.flatMap((b) => (b.pointed ?? []).map((p) => p.computer_id)))].filter((c) => theirs.has(c));
  const read = new Map(
    await Promise.all(
      asked.map(async (c) => {
        const [custom, ports] = await Promise.all([domains.ofComputer(c).then((l) => l.domains ?? [], () => null), portsOn(wsId, c)]);
        return [c, { custom, ports }] as const;
      }),
    ),
  );
  held(ours);
  const uses = new Map<string, DomainUse[]>();
  const byCustomId = new Map<string, string>();
  for (const b of list)
    uses.set(
      b.id.toLowerCase(),
      (b.pointed ?? []).map((p): DomainUse => {
        const name = p.domain.toLowerCase();
        const status = (STATUSES as readonly string[]).includes(p.status) ? (p.status as AppDomainStatus) : "pending";
        const on = read.get(p.computer_id);
        const d = on?.custom?.find((x) => x.domain.toLowerCase() === name);
        if (d) byCustomId.set(d.id, name);
        const served = d ? on?.ports?.get(d.target_port) : undefined;
        return served ? { name, status, app: served.app, ...(served.site ? { site: served.site } : {}) } : { name, status, where: p.computer_name ?? "another computer" };
      }),
    );
  return { uses, byCustomId };
}

/** Settings' lock: a record Orgo keeps is Orgo's so one of the domain's names reaches what serves it (its app and site, or its computer). */
const workspaceLock =
  (uses: DomainUse[], byCustomId: Map<string, string>): LockOf =>
  (r: OrgoDnsRecord) => {
    const m = r.managed;
    if (!m) return null;
    const named = byCustomId.get(m.custom_domain_id) ?? (r.type === "TXT" ? r.fqdn.replace(/^_orgo-verify\./, "") : r.fqdn);
    return `Orgo set this so ${named} reaches ${servedBy(
      uses.find((u) => u.name === named.toLowerCase()),
      m.computer_name ?? "another computer",
    )}.`;
  };

/** The list as Settings shows it, from Orgo's (newest first, as Orgo lists them): each with its renewal, and an active one with its uses. */
async function answerOf(wsId: string, list: OrgoBoughtList, ours: () => boolean): Promise<WorkspaceDomainsAnswer> {
  const rows = (list.domains ?? []).filter((d) => d.status === "active" || d.status === "pending");
  const { uses } = await usesOf(
    wsId,
    rows.filter((d) => d.status === "active"),
    ours,
  );
  const open = !!list.registrar && list.can_buy !== false;
  return {
    open: true,
    buy: open ? { open } : { open, why: list.registrar ? BUY_NEEDS : BUY_CLOSED },
    contact: open ? contactOf(list.last_contact) : null,
    domains: rows.map((b) => domainOf(b, b.status === "active" ? (uses.get(b.id.toLowerCase()) ?? []) : [])),
  };
}

const domainOf = (b: OrgoBoughtDomain, uses: DomainUse[]): WorkspaceDomain => {
  const renewal = renewalOf(b);
  return { id: b.id.toLowerCase(), domain: b.domain.toLowerCase(), status: b.status === "pending" ? "pending" : "active", ...(renewal ? { renewal } : {}), uses };
};

/** Nothing of domains here, and why. */
const closed = (why: string): WorkspaceDomainsAnswer => ({ open: false, why, buy: { open: false, why }, contact: null, domains: [] });

/**
 * GET /api/domains?ws= : every domain the workspace bought (pending ones too: Orgo settles a few of them
 * as it lists them), each with its renewal and what its names serve; whether one can be bought here, and
 * who the user registered their last one to (only when one can be). Closed with why, before Orgo is asked
 * when it can be told here.
 */
export async function workspaceDomains(wsId: string): Promise<WorkspaceDomainsAnswer> {
  const ours = sameState();
  try {
    await ready(wsId, ours);
  } catch (e) {
    if (e instanceof HostedAppError && e.status === 403) return closed(e.message);
    throw e;
  }
  const project = await domainsProject(wsId, ours);
  if (!project) return closed(NOT_ON_ORGO);
  const list = await domains.bought(project).catch((e: unknown) => e as Error);
  held(ours);
  if (list instanceof Error) {
    if (list instanceof OrgoError && list.code === "DOMAINS_NOT_ENABLED") return closed(BUY_CLOSED);
    throw plainly(list, DOMAINS_UNREACHED);
  }
  if (list.enabled === false || list.registrar === false) return closed(BUY_CLOSED);
  return answerOf(wsId, list, ours);
}

/** GET /api/domains/search?ws=&q=&page= : names to buy for the workspace, no app needed (nothing held or bought). */
export async function searchForWorkspace(wsId: string, q: unknown, page: unknown): Promise<DomainSearchAnswer> {
  const asked = searchWords(q, page);
  const ours = sameState();
  await ready(wsId, ours);
  return searchOrgo(asked.words, asked.page, ours);
}

/**
 * POST /api/domains: a domain bought for the workspace, charged to the user's Orgo credits at `price`, the
 * price in cents they saw on the step that says it (Orgo refuses it with the new one when it changed:
 * nothing is bought then). Everything is checked before Orgo is asked: no price, no buy. Sent once (a
 * second one while it's out is refused, buyingOnce), never again by itself, and pointed nowhere. Answers
 * the list as it is now (the bought one alone in it, when it can't be read).
 */
export async function buyForWorkspace(wsId: string, ask: { domain?: unknown; registrant?: unknown; price?: unknown }): Promise<WorkspaceDomainBought> {
  const domain = domainTyped(ask.domain);
  if (!domain) throw new HostedAppError("Pick a domain from the search.", 400);
  const price = ask.price;
  if (typeof price !== "number" || !Number.isInteger(price) || price < 0) throw new HostedAppError("Pick a domain from the search to see its price first.", 400);
  const registrant = registrantOf(ask.registrant);
  const ours = sameState();
  await ready(wsId, ours);
  const project = await domainsProject(wsId, ours);
  if (!project) throw new HostedAppError(NOT_ON_ORGO, 409);
  held(ours);
  const bought = await buyingOnce(project, domain, () => domains.buy(project, domain, registrant, price)).catch((e: unknown) => Promise.reject(buyFailed(e, domain)));
  // Bought (or the workspace's already, which Orgo doesn't charge for again): whatever comes now, it's said.
  const alone: WorkspaceDomainsAnswer = { open: true, buy: { open: true }, contact: null, domains: [domainOf(bought, [])] };
  const list = ours() ? await domains.bought(project).catch(() => null) : null;
  const now = list && ours() ? await answerOf(wsId, list, ours).catch(() => null) : null;
  return { domains: now && now.domains.some((d) => d.domain === bought.domain.toLowerCase()) ? now : alone, bought: bought.domain.toLowerCase() };
}

/**
 * One of the workspace's active bought domains, by the id the window names, read again from Orgo (never
 * the window's word), with the Orgo workspace it's under.
 */
async function ownZone(wsId: string, zone: unknown, ours: () => boolean): Promise<{ project: string; b: OrgoBoughtDomain; list: OrgoBoughtList }> {
  const asked = typeof zone === "string" && UUID.test(zone) ? zone.toLowerCase() : null;
  if (!asked) throw new HostedAppError(NOT_OURS, 404);
  await ready(wsId, ours);
  const project = await domainsProject(wsId, ours);
  if (!project) throw new HostedAppError(NOT_ON_ORGO, 409);
  const list = await domains.bought(project).catch((e: unknown) => Promise.reject(plainly(e, DOMAINS_UNREACHED)));
  held(ours);
  const b = list.domains?.find((d) => d.id.toLowerCase() === asked);
  if (b?.status === "pending") throw new HostedAppError(PENDING, 409);
  if (!b || b.status !== "active") throw new HostedAppError(NOT_OURS, 404);
  return { project, b, list };
}

/**
 * GET /api/domains/[zone]?ws= : one of its domains' zone, every record Orgo keeps locked with why (the app,
 * and site, or computer a name of it reaches), with its renewal, and what points at it. A zone that can't
 * be read says why, with what points at it all the same.
 */
export async function workspaceZone(wsId: string, zone: string): Promise<WorkspaceZoneAnswer> {
  const ours = sameState();
  const { project, b } = await ownZone(wsId, zone, ours);
  const id = b.id.toLowerCase();
  const { uses, byCustomId } = await usesOf(wsId, [b], ours);
  const mine = uses.get(id) ?? [];
  let z: AppDnsZone;
  try {
    z = zoneView(id, b.domain, await domains.zone(project, id), workspaceLock(mine, byCustomId));
  } catch (e) {
    const r = dnsRefused(e);
    z = { id, domain: b.domain, serving: false, ttl: null, records: [], error: r instanceof HostedAppError ? r.message : "Couldn't read its DNS records." };
  }
  held(ours);
  const renewal = renewalOf(b);
  return { zone: renewal ? { ...z, renewal } : z, uses: mine };
}

/** PATCH /api/domains/[zone] { autoRenew }: one of its domains' auto-renew on (its renewals paid from the user's credits from then on) or off. */
export async function autoRenewIn(wsId: string, zone: unknown, on: unknown): Promise<{ renewal: AppRenewal | null }> {
  if (typeof on !== "boolean") throw new HostedAppError("Say whether it renews.", 400);
  const ours = sameState();
  const { project, b } = await ownZone(wsId, zone, ours);
  held(ours);
  const r = await domains.autoRenew(project, b.id, on).catch((e: unknown) => {
    const why = renewRefused(e);
    return Promise.reject(why instanceof HostedAppError ? why : new HostedAppError(UNREACHED_CHANGE, 502));
  });
  held(ours);
  return { renewal: renewalOf(r?.domain) ?? null };
}

/**
 * A change to the zone of one of its active domains (any of them, whether an app uses it or not), read
 * from Orgo again first. A record that changed since it was read is refused with the records as they are now.
 */
async function changeOwnZone(wsId: string, zone: unknown, recordId: string | null, send: (project: string, id: string) => Promise<{ records: OrgoDnsRecord[] }>): Promise<AppDnsWritten> {
  if (recordId !== null && !RECORD_ID.test(recordId)) throw new HostedAppError("That isn't a record of this domain.", 400);
  const ours = sameState();
  const { project, b } = await ownZone(wsId, zone, ours);
  const id = b.id.toLowerCase();
  const { uses, byCustomId } = await usesOf(wsId, [b], ours);
  const lock = workspaceLock(uses.get(id) ?? [], byCustomId);
  held(ours);
  try {
    return { zone: id, records: recordsOf((await send(project, id)).records, lock) };
  } catch (e) {
    if (!(e instanceof OrgoError && e.code === "RECORD_NOT_FOUND")) throw plainly(e, UNREACHED_CHANGE);
    held(ours);
    const now = await domains.zone(project, id).catch(() => null);
    throw new HostedAppError(STALE, 404, { stale: true, ...(now ? { zone: id, records: zoneView(id, b.domain, now, lock).records } : {}) });
  }
}

/** POST /api/domains/[zone]/records: a record added to one of its domains' zone. */
export async function addWorkspaceRecord(wsId: string, zone: unknown, r: Typed): Promise<AppDnsWritten> {
  const input = inputOf(r);
  return changeOwnZone(wsId, zone, null, (project, id) => domains.addRecord(project, id, input));
}

/** PATCH /api/domains/[zone]/records/[recordId]: one of its records changed (`r` is all of it, as it becomes). */
export async function changeWorkspaceRecord(wsId: string, zone: unknown, recordId: string, r: Typed): Promise<AppDnsWritten> {
  const input = inputOf(r);
  return changeOwnZone(wsId, zone, recordId, (project, id) => domains.changeRecord(project, id, recordId, input));
}

/** DELETE /api/domains/[zone]/records/[recordId]: one of its records removed. */
export async function removeWorkspaceRecord(wsId: string, zone: unknown, recordId: string): Promise<AppDnsWritten> {
  return changeOwnZone(wsId, zone, recordId, (project, id) => domains.removeRecord(project, id, recordId));
}
