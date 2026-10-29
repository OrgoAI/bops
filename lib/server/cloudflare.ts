import "server-only";
import { createHash } from "node:crypto";
import type { CloudflareChange, CloudflarePlan } from "@/lib/hosted-apps";
import { callKey, KeysError, keysProject, vaultNames, type KeyAnswer, type KeyMethod } from "./keys";
import { apiKey } from "./orgo";

/*
 * An app's domains in the user's own Cloudflare account (lib/hosted-apps.ts CloudflarePlan): the Cloudflare
 * key the user keeps in their Orgo vault (CLOUDFLARE_API_TOKEN, for one Orgo workspace or for all) is used
 * only through Orgo's broker (/api/secrets/call, with the user's own Orgo key), which adds it on the way to
 * Cloudflare and takes it out of every answer. Bops never reveals it, never calls Cloudflare itself, and
 * hands the window only what a zone says: its names, record types and values.
 *
 * It's not one of the Keys (keys.ts KEY_PROVIDERS): no bot ever sees it, calls it, or is offered it. Bops
 * reads its domains (zones) and their records at the names a domain needs, says what it would change, and
 * writes only after the user pressed the button that says so: every change for a domain in one Cloudflare
 * batch, all of it or none. A record Bops writes says so in its comment ("Set by Bops for <app>
 * [bops:<Orgo's domain id>]"), which is how it knows its own again (on two Macs too): nothing about any of
 * it is kept in Bops' state. One Bops didn't write is changed only after the user said Replace.
 */

/** The name the key has in the vault. Its zone's and account's ids there are never read: Cloudflare says them itself. */
export const CF_KEY = "CLOUDFLARE_API_TOKEN";

/** Which of the user's Cloudflare keys: the one for this Orgo workspace (the broker prefers it), or the account's (null). */
export type CloudflareScope = { workspaceId: string | null };

/** A zone as the key sees it: its id, its name, and the Cloudflare account it's in. */
export type CfZone = { id: string; name: string; account: { id: string; name: string } | null };

/** A DNS record of a zone, as Cloudflare answers it (`name` in full). */
export type CfRecord = { id: string; type: string; name: string; content: string; proxied?: boolean; comment: string | null };

/** A Cloudflare zone's id: 32 lowercase hex characters, checked before it goes in a path. */
export const ZONE_ID = /^[0-9a-f]{32}$/;
const RECORD_ID = /^[0-9a-f]{32}$/;

/* ---------------- Words ---------------- */

export const CF_WORDS = {
  notReady: "Your Cloudflare key is in your vault, but Orgo can't use it for domains yet.",
  noZones: "Your Cloudflare key doesn't see any active domains. In Cloudflare, let it read your zones and edit their DNS.",
  refused: "Cloudflare turned your key down. It may have expired. Save a new one in your vault as CLOUDFLARE_API_TOKEN.",
  gone: "Your Cloudflare key isn't in your vault anymore.",
  down: "Cloudflare didn't answer just now. Try again in a minute.",
  orgoLimit: "Orgo is limiting calls to Cloudflare right now. Wait a minute, then try again.",
  cfLimit: "Cloudflare is limiting calls right now. Wait a minute, then try again.",
  signIn: "Sign in to Orgo again to use your Cloudflare key.",
  orgoDown: "Bops couldn't reach Orgo. Check the internet and try again.",
  notZone: "That isn't one of your Cloudflare domains.",
  stale: "Something changed in Cloudflare since you looked. Check the changes again.",
  needsOk: "Bops won't replace records it didn't set without your OK.",
  unknown: "Cloudflare didn't answer, so it isn't known whether the records went in. Try again in a minute. Bops looks first, so nothing is set twice.",
  justSet: "Set in Cloudflare. It can take a minute or two to answer.",
  tooLong: "Cloudflare's answer was too long.",
  notIn: (domain: string) => `${domain} isn't in your Cloudflare account.`,
  noEdit: (zone: string) => `Your Cloudflare key can read ${zone} but can't change its DNS. In Cloudflare, let the key edit DNS for ${zone}, then try again. Nothing was changed.`,
  noRead: (zone: string) => `Your Cloudflare key can't read the DNS of ${zone}. In Cloudflare, let it edit DNS for ${zone}.`,
  noTarget: (fqdn: string) => `Orgo didn't say where ${fqdn} should point. Try again in a minute.`,
  otherApp: (type: string, host: string, app: string | null) =>
    app ? `Bops set the ${type} at ${host} for ${app}. Remove that domain from ${app} first.` : `Bops set the ${type} at ${host} for another domain on this computer. Remove that one first.`,
  besideCname: (fqdn: string, type: string) => `${fqdn} has a ${type} record in Cloudflare, so it can't also have the CNAME Orgo needs. Pick another name.`,
  proxy: "Turns off Cloudflare's proxy. Orgo needs DNS only.",
};

/**
 * Why a Cloudflare call didn't go, in words, by what it was: Orgo can't call Cloudflare yet (`notReady`), the
 * key is gone from the vault, Cloudflare turned the key down (`auth`), someone is limiting, nobody answered
 * (`down`: for a write, whether it went in isn't known), a record clashed with one made meanwhile (`clash`).
 */
export class CloudflareError extends Error {
  kind: "notReady" | "gone" | "auth" | "limit" | "down" | "clash" | "signIn" | "other";
  status: number;
  constructor(message: string, kind: CloudflareError["kind"], status: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** Cloudflare's codes for an invalid or refused key, and for a record that clashes with one there (a race). */
const KEY_CODES = new Set([9109, 10000]);
const CLASH_CODES = new Set([81053, 81057, 81058]);

/** Orgo's broker turned the call down, or didn't get it through: in Cloudflare's words for the user. */
function brokerRefused(e: unknown): unknown {
  if (!(e instanceof KeysError)) return e;
  if (e.status === 400 && /no provider/i.test(e.said ?? e.message)) return new CloudflareError(CF_WORDS.notReady, "notReady", 409);
  if (e.status === 404) return new CloudflareError(CF_WORDS.gone, "gone", 404);
  if (e.status === 429) return new CloudflareError(CF_WORDS.orgoLimit, "limit", 429);
  if (e.status === 401) return new CloudflareError(CF_WORDS.signIn, "signIn", 401);
  // A 502 with Orgo's words is the broker not reaching Cloudflare; without, this Mac not reaching Orgo.
  if (e.status === 502 || e.status === 504) return new CloudflareError(e.said ? CF_WORDS.down : CF_WORDS.orgoDown, "down", 502);
  return new CloudflareError("Orgo didn't send that to Cloudflare. Try again.", "other", 502);
}

/** Cloudflare's own words, as a sentence, cut short. */
const clip = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim().slice(0, 200);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** What a Cloudflare answer says, or why it didn't go (the answer is Cloudflare's `{ success, errors, result, result_info }`). */
function readAnswer<T>(a: KeyAnswer): { result: T; info: { total_pages?: number } } {
  if (a.truncated) throw new CloudflareError(CF_WORDS.tooLong, "other", 502);
  const b = (a.body && typeof a.body === "object" ? a.body : {}) as { success?: unknown; errors?: unknown; result?: unknown; result_info?: unknown };
  const errors = (Array.isArray(b.errors) ? b.errors : []).filter((x): x is { code?: unknown; message?: unknown } => !!x && typeof x === "object");
  const codes = errors.map((x) => Number(x.code)).filter(Number.isFinite);
  if (a.status === 401 || a.status === 403 || codes.some((c) => KEY_CODES.has(c))) throw new CloudflareError(CF_WORDS.refused, "auth", 403);
  if (a.status === 429) throw new CloudflareError(CF_WORDS.cfLimit, "limit", 429);
  if (a.status >= 500) throw new CloudflareError(CF_WORDS.down, "down", 502);
  if (a.status >= 400 || b.success === false) {
    if (codes.some((c) => CLASH_CODES.has(c))) throw new CloudflareError(CF_WORDS.stale, "clash", 409);
    const said = errors.map((x) => x.message).find((m): m is string => typeof m === "string" && !!m.trim());
    throw new CloudflareError(said ? `Cloudflare says: ${clip(said)}` : `Cloudflare answered ${a.status}.`, "other", 400);
  }
  const info = (b.result_info && typeof b.result_info === "object" ? b.result_info : {}) as { total_pages?: number };
  return { result: b.result as T, info };
}

/** One Cloudflare call, through Orgo's broker with the user's own Orgo key: the key is added there, never here. */
async function cf<T>(scope: CloudflareScope, method: KeyMethod, path: string, query?: Record<string, unknown> | null, body?: unknown) {
  let a: KeyAnswer;
  try {
    a = await callKey({ name: CF_KEY, method, path, query: query ?? null, body: body ?? null, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) });
  } catch (e) {
    throw brokerRefused(e);
  }
  return readAnswer<T>(a);
}

/* ---------------- Which key, and its zones ---------------- */

/**
 * The Cloudflare key a Bops workspace's app uses, by the vault's names alone (never a value): the one for the
 * workspace's own Orgo project, else the one for the Orgo workspace the app's computer is in (asked only when
 * there's a key for another workspace than this one's), else the account's. Null: no Cloudflare here, so
 * nothing about domains changes. The vault not answering is no Cloudflare too.
 */
export async function cloudflareScope(wsId: string, computerProject: () => Promise<string | undefined>): Promise<CloudflareScope | null> {
  const names = await vaultNames().catch(() => null);
  const rows = (names ?? []).filter((k) => k.name === CF_KEY);
  if (!rows.length) return null;
  const own = keysProject(wsId);
  if (own && rows.some((r) => r.workspaceId === own)) return { workspaceId: own };
  if (rows.some((r) => r.workspaceId && r.workspaceId !== own)) {
    const there = await computerProject().catch(() => undefined);
    if (there && rows.some((r) => r.workspaceId === there)) return { workspaceId: there };
  }
  return rows.some((r) => !r.workspaceId) ? { workspaceId: null } : null;
}

/** How many pages of 50 zones are read at most (200). */
const ZONE_PAGES = 4;
const ZONES_MS = 60_000;
const g = globalThis as unknown as { bopsCfZones?: Map<string, { at: number; zones: CfZone[]; more: boolean }>; bopsCfZonesFailed?: Map<string, { at: number; error: unknown }> };
const zonesKept = (g.bopsCfZones ??= new Map());
/** Why the last read of a key's zones failed, and when: a look within the minute isn't sent again. */
const zonesFailed = (g.bopsCfZonesFailed ??= new Map());

/** Who and which key a zone list is of: the signed-in Orgo key, hashed (only to tell one from another), and the scope. */
const zonesKey = async (scope: CloudflareScope) => `${createHash("sha256").update(await apiKey().catch(() => "")).digest("hex").slice(0, 16)}/${scope.workspaceId ?? ""}`;

/**
 * The key's active zones (the first 200, `more` when there are others), for a minute: read with every Add a
 * domain and every look at the domains, kept in memory only. `kept`: the last ones read however old, when a
 * read fails (a removal still finds the zone its records are in). `look`: for a look at the app's domains
 * (each check while one is watched, every few seconds), a read that failed in the last minute fails the same
 * without asking again, so a key Cloudflare turns down, or Cloudflare down, isn't asked on every tick; what
 * the user pressed (Add a domain, Set it in Cloudflare) always asks.
 */
export async function cfZones(scope: CloudflareScope, { fresh = false, kept = false, look = false } = {}): Promise<{ zones: CfZone[]; more: boolean }> {
  const key = await zonesKey(scope);
  const c = zonesKept.get(key);
  if (!fresh && c && Date.now() - c.at < ZONES_MS) return c;
  const failed = zonesFailed.get(key);
  if (look && !fresh && failed && Date.now() - failed.at < ZONES_MS) throw failed.error;
  try {
    const zones: CfZone[] = [];
    let pages = 1;
    for (let page = 1; page <= Math.min(pages, ZONE_PAGES); page++) {
      const { result, info } = await cf<unknown[]>(scope, "GET", "/zones", { status: "active", per_page: 50, page });
      for (const z of Array.isArray(result) ? result : []) {
        const x = z as { id?: unknown; name?: unknown; status?: unknown; account?: { id?: unknown; name?: unknown } | null };
        if (typeof x.id !== "string" || !ZONE_ID.test(x.id) || typeof x.name !== "string" || (x.status !== undefined && x.status !== "active")) continue;
        const account = x.account && typeof x.account.id === "string" ? { id: x.account.id, name: typeof x.account.name === "string" ? x.account.name : "" } : null;
        zones.push({ id: x.id, name: x.name.toLowerCase().replace(/\.$/, ""), account });
      }
      pages = typeof info.total_pages === "number" && info.total_pages > 0 ? info.total_pages : 1;
    }
    const got = { at: Date.now(), zones, more: pages > ZONE_PAGES };
    zonesKept.set(key, got);
    zonesFailed.delete(key);
    return got;
  } catch (e) {
    zonesFailed.set(key, { at: Date.now(), error: e });
    if (kept && c) return c;
    throw e;
  }
}

/** The zone a name is in: the longest of the key's zones it is, or ends with. */
export function zoneFor(domain: string, zones: CfZone[]): CfZone | undefined {
  const d = domain.toLowerCase().replace(/\.$/, "");
  return zones.filter((z) => d === z.name || d.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
}

/* ---------------- Records ---------------- */

const recordOf = (r: unknown): CfRecord | null => {
  const x = r as { id?: unknown; type?: unknown; name?: unknown; content?: unknown; proxied?: unknown; comment?: unknown };
  if (typeof x?.id !== "string" || typeof x.type !== "string" || typeof x.name !== "string" || typeof x.content !== "string") return null;
  return { id: x.id, type: x.type.toUpperCase(), name: x.name.toLowerCase().replace(/\.$/, ""), content: x.content, ...(typeof x.proxied === "boolean" ? { proxied: x.proxied } : {}), comment: typeof x.comment === "string" ? x.comment : null };
};

/** Every record at each of `names` (in full) in the zone: what a plan is made from. */
export async function recordsAt(scope: CloudflareScope, zoneId: string, names: string[]): Promise<CfRecord[]> {
  if (!ZONE_ID.test(zoneId)) throw new CloudflareError(CF_WORDS.notZone, "other", 404);
  const lists = await Promise.all([...new Set(names)].map((name) => cf<unknown[]>(scope, "GET", `/zones/${zoneId}/dns_records`, { "name.exact": name, per_page: 100 })));
  const seen = new Set<string>();
  return lists
    .flatMap((l) => (Array.isArray(l.result) ? l.result : []))
    .map(recordOf)
    .filter((r): r is CfRecord => !!r && !seen.has(r.id) && !!seen.add(r.id));
}

/** The records Bops set for one of the app's domains (by its comment's tag), and only those. */
export async function ourRecords(scope: CloudflareScope, zoneId: string, domainId: string): Promise<CfRecord[]> {
  if (!ZONE_ID.test(zoneId)) throw new CloudflareError(CF_WORDS.notZone, "other", 404);
  const { result } = await cf<unknown[]>(scope, "GET", `/zones/${zoneId}/dns_records`, { "comment.contains": `[bops:${domainId}]`, per_page: 100 });
  return (Array.isArray(result) ? result : []).map(recordOf).filter((r): r is CfRecord => !!r && ourId(r.comment) === domainId);
}

/** A record as Bops writes it: automatic TTL, DNS only (Orgo checks it points at its own edge), and its comment. */
export type CfWrite = { type: string; name: string; content: string; ttl: 1; proxied?: false; comment: string };
/** One Cloudflare batch: deletes, then patches, then posts, in one transaction (all of it, or none). */
export type CfBatch = { deletes: { id: string }[]; patches: (CfWrite & { id: string })[]; posts: CfWrite[] };
export const batchSize = (b: CfBatch) => b.deletes.length + b.patches.length + b.posts.length;

/** Write one batch: never a record at a time, so one change and many go the same way. Answers how many records it wrote. */
export async function applyBatch(scope: CloudflareScope, zoneId: string, b: CfBatch): Promise<number> {
  if (!ZONE_ID.test(zoneId)) throw new CloudflareError(CF_WORDS.notZone, "other", 404);
  if (!batchSize(b)) return 0;
  if ([...b.deletes, ...b.patches].some((r) => !RECORD_ID.test(r.id))) throw new CloudflareError(CF_WORDS.stale, "clash", 409);
  const body = { ...(b.deletes.length ? { deletes: b.deletes } : {}), ...(b.patches.length ? { patches: b.patches } : {}), ...(b.posts.length ? { posts: b.posts } : {}) };
  await cf<unknown>(scope, "POST", `/zones/${zoneId}/dns_records/batch`, null, body);
  return batchSize(b);
}

/* ---------------- Bops' own records ---------------- */

/** Cloudflare keeps 100 characters of a record's comment on its Free plan. */
const COMMENT_MAX = 100;

/** The comment on every record Bops writes for a domain: what it's for, then its tag (never cut), within Cloudflare's 100. */
export function marker(app: string, domainId: string): string {
  const tag = `[bops:${domainId}]`;
  if (domainId.length > 50) return tag;
  const head = "Set by Bops for ";
  const room = COMMENT_MAX - head.length - 1 - tag.length;
  return `${head}${app.slice(0, Math.max(0, room))} ${tag}`;
}

/** The domain a record's comment says Bops set it for (Orgo's id for it), or null: not Bops'. */
export const ourId = (comment: string | null | undefined): string | null => /\[bops:([\w-]{1,80})\]/.exec(comment ?? "")?.[1] ?? null;

/* ---------------- The plan ---------------- */

/** A record's value as two records are compared: a TXT's quoted strings joined, a CNAME's case and its dot at the end not counted. */
export function valueOf(type: string, v: string): string {
  const t = v.trim();
  if (type === "TXT") {
    const parts = t.match(/"((?:[^"\\]|\\.)*)"/g);
    return t.startsWith('"') && parts ? parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("") : t;
  }
  if (type === "CNAME" || type === "AAAA") return t.toLowerCase().replace(/\.$/, "");
  return t;
}

/** A name as its zone names it: @ for the zone itself. */
export const hostIn = (name: string, zone: string) => (name === zone ? "@" : name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name);

/** A record Orgo asks for (dns_records): its type, its name in full, and its value. */
export type Wanted = { type: string; name: string; value: string };

const ROUTING = new Set(["A", "AAAA", "CNAME"]);

/**
 * What Bops would change in a zone so a domain has the records Orgo asked for (`want`), from what's there
 * at those names now (`found`), never touching another record there:
 * - the TXT that proves it: set already (whoever set it) is left; one of Bops' for this domain with another
 *   value is changed; else one is added, the user's own TXTs there left as they are (Orgo looks for its
 *   value among them); Bops' for a domain that's gone is removed;
 * - what routes it (an A or a CNAME): one there already, the same and DNS only, is left; proxied, it's turned
 *   DNS only; one of Bops' (this domain's, or a gone one's) is changed into it; the user's own is replaced,
 *   and any other A, AAAA or CNAME of theirs there removed, each only with their OK (`theirs`); a CNAME
 *   can't sit beside another record at a name under the zone, so that's blocked (Bops never removes those);
 *   one Bops set for another app on this computer (`here`: its domains by id, with its app) is blocked.
 * Every record Bops writes carries this domain's marker. Pure: answers the plan as the window shows it,
 * and the one batch that writes it.
 */
export function planRecords(o: { zone: { id: string; name: string }; domain: { id: string; name: string }; app: string; want: Wanted[]; found: CfRecord[]; here: Map<string, string | null> }): {
  plan: CloudflarePlan;
  batch: CfBatch;
} {
  const zone = o.zone.name;
  const fqdn = o.domain.name.toLowerCase();
  const note = marker(o.app, o.domain.id);
  // By id, never in the order Cloudflare answered: the same records always make the same plan (and fingerprint).
  const found = [...o.found].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const changes: (CloudflareChange & { ids: string[]; proxied?: boolean })[] = [];
  const batch: CfBatch = { deletes: [], patches: [], posts: [] };
  const write = (w: Wanted): CfWrite => ({ type: w.type, name: w.name, content: w.type === "TXT" ? `"${valueOf("TXT", w.value)}"` : w.value, ttl: 1, ...(w.type === "TXT" ? {} : { proxied: false as const }), comment: note });
  const shown = (r: { type: string; name: string; content?: string; value?: string }) => ({ type: r.type, name: r.name, host: hostIn(r.name, zone), value: r.type === "TXT" ? valueOf("TXT", r.content ?? r.value ?? "") : (r.content ?? r.value ?? "") });
  // Whose a record is: this domain's (Bops'), a gone domain's (Bops', stale), another app's here, or the user's.
  const whose = (r: CfRecord): { kind: "mine" | "stale" | "other" | "theirs"; app?: string } => {
    const id = ourId(r.comment);
    if (!id) return { kind: "theirs" };
    if (id === o.domain.id) return { kind: "mine" };
    if (o.here.has(id)) return { kind: "other", app: o.here.get(id) ?? undefined };
    return { kind: "stale" };
  };
  const blocked = (reason: string, r?: CfRecord) => {
    changes.push({ op: "blocked", ...(r ? shown(r) : { type: "", name: fqdn, host: hostIn(fqdn, zone), value: "" }), note: reason, ids: r ? [r.id] : [] });
  };
  const remove = (r: CfRecord) => {
    const w = whose(r);
    batch.deletes.push({ id: r.id });
    changes.push({ op: "remove", ...shown(r), ...(w.kind === "theirs" ? { theirs: true as const } : {}), ...(w.kind === "stale" ? { stale: true as const } : {}), ids: [r.id] });
  };
  const routing = o.want.filter((w) => ROUTING.has(w.type));
  if (!routing.length) blocked(CF_WORDS.noTarget(fqdn));

  for (const w of o.want.filter((x) => x.type === "TXT")) {
    const at = found.filter((r) => r.name === w.name);
    // A CNAME at the TXT's name can't stay beside it.
    for (const r of at.filter((x) => x.type === "CNAME")) {
      const k = whose(r);
      if (k.kind === "other") blocked(CF_WORDS.otherApp(r.type, hostIn(r.name, zone), k.app ?? null), r);
      else remove(r);
    }
    const txts = at.filter((r) => r.type === "TXT");
    const same = txts.find((r) => valueOf("TXT", r.content) === valueOf("TXT", w.value));
    const mine = txts.filter((r) => r !== same && whose(r).kind === "mine");
    if (same) changes.push({ op: "same", ...shown(w), ids: [same.id] });
    else if (mine.length) {
      const r = mine.shift()!;
      batch.patches.push({ id: r.id, ...write(w) });
      changes.push({ op: "change", ...shown(w), was: valueOf("TXT", r.content), ids: [r.id] });
    } else {
      batch.posts.push(write(w));
      changes.push({ op: "add", ...shown(w), ids: [] });
    }
    for (const r of [...mine, ...txts.filter((x) => whose(x).kind === "stale" && x !== same)]) remove(r);
  }

  for (const w of routing) {
    const at = found.filter((r) => r.name === w.name);
    const routes = at.filter((r) => ROUTING.has(r.type));
    const other = routes.find((r) => whose(r).kind === "other");
    if (other) {
      blocked(CF_WORDS.otherApp(other.type, hostIn(other.name, zone), whose(other).app ?? null), other);
      continue;
    }
    // At the zone itself Cloudflare flattens a CNAME, so it sits beside the zone's MX and TXT.
    const beside = w.type === "CNAME" && w.name !== zone ? at.find((r) => !ROUTING.has(r.type)) : undefined;
    if (beside) {
      blocked(CF_WORDS.besideCname(fqdn, beside.type), beside);
      continue;
    }
    const match = routes.find((r) => r.type === w.type && valueOf(w.type, r.content) === valueOf(w.type, w.value));
    const rest = routes.filter((r) => r !== match);
    if (match && match.proxied !== true) changes.push({ op: "same", ...shown(w), ids: [match.id] });
    else if (match) {
      // Proxied: Cloudflare would answer with its own addresses, and Orgo's check would fail.
      if (whose(match).kind === "theirs") {
        batch.deletes.push({ id: match.id });
        batch.posts.push(write(w));
        changes.push({ op: "change", ...shown(w), was: "proxied", theirs: true, note: CF_WORDS.proxy, ids: [match.id], proxied: true });
      } else {
        batch.patches.push({ id: match.id, ...write(w) });
        changes.push({ op: "change", ...shown(w), was: "proxied", ...(whose(match).kind === "stale" ? { stale: true as const } : {}), note: CF_WORDS.proxy, ids: [match.id], proxied: true });
      }
    } else {
      // Bops' own first (the same type, else another), else the user's of the same type: changed into it.
      const ours = rest.filter((r) => whose(r).kind !== "theirs");
      const into = ours.find((r) => r.type === w.type) ?? ours[0] ?? rest.find((r) => r.type === w.type);
      if (!into) {
        batch.posts.push(write(w));
        changes.push({ op: "add", ...shown(w), ids: [] });
      } else {
        const k = whose(into).kind;
        // The user's is deleted and written fresh (never patched: their comment would look like Bops'), as is another type.
        if (k === "theirs" || into.type !== w.type) {
          batch.deletes.push({ id: into.id });
          batch.posts.push(write(w));
        } else batch.patches.push({ id: into.id, ...write(w) });
        changes.push({
          op: "change",
          ...shown(w),
          was: into.type === w.type ? into.content : `${into.type} ${into.content}`,
          ...(k === "theirs" ? { theirs: true as const } : {}),
          ...(k === "stale" ? { stale: true as const } : {}),
          ids: [into.id],
        });
      }
      for (const r of rest.filter((x) => x !== into)) remove(r);
    }
    if (match) for (const r of rest) remove(r);
  }

  const reason = changes.find((c) => c.op === "blocked")?.note ?? null;
  const shownChanges = reason ? changes.filter((c) => c.op === "blocked") : changes;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([o.zone.id, o.domain.id, changes.map((c) => [c.op, c.type, c.name, c.ids, c.was ?? null, c.value, c.proxied ?? null])]))
    .digest("hex")
    .slice(0, 16);
  const plan: CloudflarePlan = {
    zone,
    zoneId: o.zone.id,
    domain: fqdn,
    domainId: o.domain.id,
    changes: shownChanges.map((c) => {
      const { ids, proxied, ...rest } = c;
      void ids;
      void proxied;
      return rest;
    }),
    ask: !reason && changes.some((c) => c.theirs),
    blocked: reason,
    fingerprint,
  };
  return { plan, batch: reason ? { deletes: [], patches: [], posts: [] } : batch };
}
