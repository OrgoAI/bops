/**
 * What a computer's runner may touch of its user's Bops (a runner signed in as its computer: auth.ts
 * CloudUser.computer). The user's state is one blob that every Mac and runner of theirs shares, and the
 * Mac mirrors parts of it to orgo-web on the user's own key: each bot's keys and app access (bops_access),
 * and which computer each bot works on (bops_bots.desktop_id). orgo-web pins a runner's own calls
 * (routines, Orbit, the access log, the vault) to the bots on its computer by exactly those rows. So a
 * computer may write only what its runner's own work changes (writeDenials):
 * - threads (sessions) its own device runs (Session.by), added, changed or taken out;
 * - the run of a routine of a bot on it: its clock (nextRunAt, lastRunAt, last, lateRun, eventsThrough),
 *   skipped times that passed going (never one added), and a routine paused (never one turned on);
 * - how a bot on it is doing on its computer (computerStatus, computerRam, computerNeverReady,
 *   wakeFailed, tailnet) and its Composio session (composio);
 * - when an app account was last used (accounts[].usedAt), a brain's sign-in on this computer
 *   (brains[].signIns for its computer id), news held for later about a bot on it (digest, added only),
 *   which thread last held a screen of it (screenLog), the usage ledger (shown on the account page
 *   only) and the out-of-credit mark (credits).
 * Anything else (bots added, moved or given keys or app access, routines added, edited or taken out,
 * another device's threads, workspaces, logins, channels, phone numbers, Macs' own settings) is refused
 * (403 computer_not_allowed). Its chat messages go only in its bots' chats (chatsOn), and the services
 * it reaches through Bops Cloud are held to its bots too (proxy.ts: their memory banks, app accounts,
 * inboxes and texting lines).
 *
 * Pure, with no imports: Bops Cloud checks with it (state.ts, proxy.ts), a runner keeps to it before it
 * sends (keepAllowed in lib/server/persist-cloud.ts, so a runner never sends what would be refused), and
 * the Mac holds a computer's write to it again when it reads one (the second guard, persist-cloud.ts).
 * Which bot works where follows lib/types.ts workBot exactly (scripts/test-computer-scope.mjs checks).
 */

export type Blob = Record<string, unknown>;
/** The computer (its Orgo id, any case) and its device as the state knows it (cloud/device.ts). */
export type Scope = { desktopId: string; device: string };

const MAIN_WORKSPACE = "ws_main";
/** Connections that put bots somewhere rather than apps they use (lib/types.ts CHANNEL_APPS): no default access. */
const CHANNEL_APPS = new Set(["slackbot"]);

const isObject = (v: unknown): v is Blob => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

/** JSON with every object's keys in order, so the same content compares the same (Postgres' JSONB reorders keys). */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Blob)[k]])) : x)) ?? "undefined";
}
export const same = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);

const listOf = (v: unknown): Blob[] => (Array.isArray(v) ? v.filter((x): x is Blob => isObject(x) && typeof x.id === "string") : []);
const byId = (v: unknown) => new Map(listOf(v).map((x) => [x.id as string, x]));

/* ---------------- Which bots work on a computer (lib/types.ts, the same rules) ---------------- */

const workspaceOf = (b: Blob | undefined) => (b?.workspaceId as string | undefined) ?? MAIN_WORKSPACE;
const sharesComputer = (b: Blob) => (b.isMain ? b.computer === "shared" && !b.computerId : ((b.computer as string | undefined) ?? (b.computerId ? "own" : "shared")) === "shared");
const freeComputerBot = (bots: Blob[], except?: unknown) => bots.find((x) => x.isMain && x.freeComputer && x.computerId && x.id !== except);

/** The bot whose computer `b` works on (lib/types.ts workBot). */
export function workBotOf(b: Blob, bots: Blob[], depth = 0): Blob {
  if (!sharesComputer(b) || depth > 4) return b;
  if (b.isMain) return freeComputerBot(bots, b.id) ?? b;
  const main = bots.find((x) => x.isMain && workspaceOf(x) === workspaceOf(b));
  return main ? workBotOf(main, bots, depth + 1) : b;
}

/** The bots that work on the computer (their own, their main bot's, or the free one), as the state says. */
export function botsOn(state: Blob, desktopId: string): Blob[] {
  const id = lower(desktopId);
  if (!id) return [];
  const bots = listOf(state.bots);
  return bots.filter((b) => lower(workBotOf(b, bots).computerId) === id);
}

export const botIdsOn = (state: Blob, desktopId: string) => new Set(botsOn(state, desktopId).map((b) => b.id as string));

/** The chats its runner may write and read in: its bots' own (bot:<id>), and any chat one of them is in. */
export function chatsOn(state: Blob, desktopId: string): Set<string> {
  const ids = botIdsOn(state, desktopId);
  const out = new Set([...ids].map((id) => `bot:${id}`));
  for (const c of listOf(state.chats)) if (Array.isArray(c.botIds) && c.botIds.some((b) => typeof b === "string" && ids.has(b))) out.add(c.id as string);
  return out;
}

/* ---------------- What its bots may use ---------------- */

export type Level = "read" | "act";

/** What a bot may do in an app account (lib/types.ts levelOf): what the user set, else Read & act for its workspace's bots by default. */
export function levelOf(b: Blob, a: Blob): Level | null {
  const set = isObject(b.access) ? b.access[a.id as string] : undefined;
  if (set === "read" || set === "act") return set;
  const openToTeam = !!a.workspaceId && !a.onlyGiven;
  if (set === "none" || CHANNEL_APPS.has(a.app as string) || !openToTeam || workspaceOf(a) !== workspaceOf(b)) return null;
  return "act";
}

/**
 * The app accounts the computer's bots may use, working ones only (composio.ts accountsOf), by account id
 * ("open:<app>" for an app with no sign-in), with its app and the most any of them (or `botId` alone,
 * when it's one of them) may do there.
 */
export function grantsOn(state: Blob, desktopId: string, botId?: string): Map<string, { app: string; level: Level }> {
  const bots = botsOn(state, desktopId).filter((b) => botId === undefined || b.id === botId);
  const out = new Map<string, { app: string; level: Level }>();
  for (const a of listOf(state.accounts)) {
    if (a.status !== "active" || typeof a.app !== "string") continue;
    for (const b of bots) {
      const level = levelOf(b, a);
      if (!level) continue;
      const had = out.get(a.id as string);
      out.set(a.id as string, { app: a.app, level: had?.level === "act" || level === "act" ? "act" : "read" });
    }
  }
  return out;
}

/** Its bots' own inboxes (and the ones each had before: their mail still comes there). */
export function inboxesOn(state: Blob, desktopId: string): Set<string> {
  const out = new Set<string>();
  for (const b of botsOn(state, desktopId)) {
    const m = isObject(b.mail) ? b.mail : null;
    if (typeof m?.inboxId === "string") out.add(m.inboxId);
    if (Array.isArray(m?.past)) for (const p of m.past) if (typeof p === "string") out.add(p);
  }
  return out;
}

/** The number a bot texts from (lib/server/phone.ts lineOf): its workspace's, when it's the main bot, else its own. */
function lineOf(state: Blob, b: Blob): Blob | undefined {
  if (b.isMain) {
    const w = listOf(state.workspaces).find((x) => x.id === workspaceOf(b));
    if (isObject(w?.line)) return w.line;
  }
  return isObject(b.phoneLine) && b.phone ? b.phoneLine : undefined;
}

/** The lines its bots text the user from (phone.ts textingLine: a bot's own, else its workspace's main bot's), by number and agent. */
export function linesOn(state: Blob, desktopId: string): { numberIds: Set<string>; agentIds: Set<string> } {
  const bots = listOf(state.bots);
  const numberIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const b of botsOn(state, desktopId)) {
    const main = bots.find((x) => x.isMain && workspaceOf(x) === workspaceOf(b));
    const line = lineOf(state, b) ?? (main ? lineOf(state, main) : undefined);
    if (typeof line?.numberId === "string") numberIds.add(line.numberId);
    if (typeof line?.agentId === "string") agentIds.add(line.agentId);
  }
  return { numberIds, agentIds };
}

/** The user's own numbers they verified (lib/server/phone.ts ownerPhones: this user's), as their last 10 digits. */
export function ownerNumbers(state: Blob, userId: string): Set<string> {
  const out = new Set<string>();
  for (const p of Array.isArray(state.ownerPhones) ? state.ownerPhones : []) {
    if (!isObject(p) || typeof p.number !== "string" || !p.verifiedAt || (p.userId !== undefined && p.userId !== userId)) continue;
    out.add(p.number.replace(/\D/g, "").slice(-10));
  }
  return out;
}

/** Honcho ids allow letters, digits, _ and - (lib/server/memory.ts clean). */
const cleanId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 200);

/**
 * The memory banks its bots' workspaces use (lib/server/memory.ts bindingOf, signed in): a workspace's
 * shared one, else its own ("bops" for the default workspace, "bops-<workspace>" for the others). Bops
 * Cloud puts the user's prefix in front (session.ts honchoPrefix).
 */
export function banksOn(state: Blob, desktopId: string): Set<string> {
  const out = new Set<string>();
  for (const b of botsOn(state, desktopId)) {
    const ws = workspaceOf(b);
    const w = listOf(state.workspaces).find((x) => x.id === ws);
    const shared = isObject(w?.memory) ? str(w.memory.bank) : undefined;
    out.add(shared ?? (ws !== MAIN_WORKSPACE ? `bops-${cleanId(ws)}` : "bops"));
  }
  return out;
}

/* ---------------- What it may write ---------------- */

/** A routine's run (lib/server/state-merge.ts CLOCK): what the runner that runs it changes. */
const ROUTINE_RUN = ["nextRunAt", "lastRunAt", "last", "lateRun", "eventsThrough"] as const;
/** How a bot is doing on its computer, and its Composio session (lib/server/sessions.ts, composio.ts). */
const BOT_RUN = ["computerStatus", "computerRam", "computerNeverReady", "wakeFailed", "tailnet", "composio"] as const;
/** Top-level keys a computer may change as it likes: the usage ledger (the account page's) and the out-of-credit mark. */
const FREE = new Set(["usage", "credits"]);

type Ctx = { device: string; desktopId: string; bots: Set<string>; force: Set<string> };
type Kept = { value: unknown; denied: string[] };

/** A field as an object has it: taken from `from` (or gone when it hasn't it). */
function copyField(to: Blob, from: Blob, k: string) {
  if (k in from) to[k] = from[k];
  else delete to[k];
}

/** The keys two objects differ in. */
const differ = (a: Blob, b: Blob) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));

/** A list of things with ids, item by item: `item` says what of a changed one may stay (its allowed copy, and what was refused). Added and removed ones only as `add`/`remove` say. */
function keepList(
  key: string,
  stored: unknown,
  next: unknown,
  ctx: Ctx,
  rules: { add: (x: Blob) => boolean; remove: (x: Blob) => boolean; item: (s: Blob, n: Blob) => { value: Blob; denied: string[] } },
): Kept {
  const was = byId(stored);
  const now = byId(next);
  const out: Blob[] = [];
  const denied: string[] = [];
  for (const x of listOf(next)) {
    const id = x.id as string;
    const s = was.get(id);
    const forced = ctx.force.has(`${key}.${id}`);
    if (!s) {
      if (!forced && rules.add(x)) out.push(x);
      else denied.push(`${key}.${id}`);
    } else if (same(s, x)) out.push(x);
    else if (forced) {
      denied.push(`${key}.${id}`);
      out.push(s);
    } else {
      const r = rules.item(s, x);
      denied.push(...r.denied);
      out.push(r.value);
    }
  }
  for (const [id, s] of was)
    if (!now.has(id)) {
      if (!ctx.force.has(`${key}.${id}`) && rules.remove(s)) continue;
      denied.push(`${key}.${id}`);
      out.push(s);
    }
  return { value: out, denied };
}

/** A changed item: only `fields` may change (plus what `extra` lets through); anything else goes back to how it was, and is refused. */
function onlyFields(key: string, s: Blob, n: Blob, fields: readonly string[], extra?: (v: Blob) => string[]): { value: Blob; denied: string[] } {
  const v: Blob = { ...s };
  for (const f of fields) copyField(v, n, f);
  const denied = (extra?.(v) ?? []).map((f) => `${key}.${s.id}.${f}`);
  for (const f of differ(v, n)) if (!denied.includes(`${key}.${s.id}.${f}`)) denied.push(`${key}.${s.id}.${f}`);
  return { value: v, denied };
}

const RULES: Record<string, (stored: unknown, next: unknown, ctx: Ctx) => Kept> = {
  // Its own device's threads; another's stay as they were.
  sessions: (stored, next, ctx) =>
    keepList("sessions", stored, next, ctx, {
      add: (x) => x.by === ctx.device,
      remove: (s) => s.by === ctx.device,
      item: (s, n) => (s.by === ctx.device && n.by === ctx.device ? { value: n, denied: [] } : { value: s, denied: [`sessions.${s.id}`] }),
    }),
  // A run of its bots' routines: the clock, a skip that passed going, a pause.
  routines: (stored, next, ctx) =>
    keepList("routines", stored, next, ctx, {
      add: () => false,
      remove: () => false,
      item: (s, n) => {
        if (!ctx.bots.has(s.botId as string) || n.botId !== s.botId) return { value: s, denied: [`routines.${s.id}`] };
        return onlyFields("routines", s, n, ROUTINE_RUN, (v) => {
          const refused: string[] = [];
          const was = Array.isArray(s.skips) ? s.skips : [];
          const skips = n.skips === undefined ? [] : Array.isArray(n.skips) ? n.skips : null;
          if (skips && skips.every((x) => was.some((y) => same(x, y)))) copyField(v, n, "skips");
          else if (!same(s.skips, n.skips)) refused.push("skips");
          if (s.enabled === n.enabled || (s.enabled === true && n.enabled === false)) copyField(v, n, "enabled");
          else refused.push("enabled");
          return refused;
        });
      },
    }),
  // How its bots are doing on it.
  bots: (stored, next, ctx) =>
    keepList("bots", stored, next, ctx, {
      add: () => false,
      remove: () => false,
      item: (s, n) => (ctx.bots.has(s.id as string) ? onlyFields("bots", s, n, BOT_RUN) : { value: s, denied: [`bots.${s.id}`] }),
    }),
  // When an account was last used.
  accounts: (stored, next, ctx) =>
    keepList("accounts", stored, next, ctx, { add: () => false, remove: () => false, item: (s, n) => onlyFields("accounts", s, n, ["usedAt"]) }),
  // A brain's sign-in on this computer only.
  brains: (stored, next, ctx) =>
    keepList("brains", stored, next, ctx, {
      add: () => false,
      remove: () => false,
      item: (s, n) => {
        const r = onlyFields("brains", s, n, []);
        const here = (x: unknown) => isObject(x) && lower(x.computerId) === lower(ctx.desktopId);
        const others = (v: unknown) => (Array.isArray(v) ? v.filter((x) => !here(x)) : []);
        if (!same(others(s.signIns), others(n.signIns))) return r;
        copyField(r.value, n, "signIns");
        return { value: r.value, denied: r.denied.filter((d) => d !== `brains.${s.id}.signIns`) };
      },
    }),
  // News held for the user about its bots: added only.
  digest: (stored, next, ctx) => {
    const was = Array.isArray(stored) ? stored : [];
    const now = Array.isArray(next) ? next : [];
    const left = [...was];
    const added: unknown[] = [];
    for (const x of now) {
      const i = left.findIndex((y) => same(x, y));
      if (i >= 0) left.splice(i, 1);
      else added.push(x);
    }
    const ok = added.filter((x) => isObject(x) && ctx.bots.has(x.botId as string));
    return { value: [...was, ...ok], denied: left.length || ok.length < added.length ? ["digest"] : [] };
  },
  // Which thread last held each of its bots' screens ("<bot>:<display>").
  screenLog: (stored, next, ctx) => {
    const was = isObject(stored) ? stored : {};
    const now = isObject(next) ? next : {};
    const out: Blob = {};
    const denied: string[] = [];
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const mine = ctx.bots.has(k.slice(0, k.lastIndexOf(":")));
      const v = same(was[k], now[k]) || mine ? now[k] : was[k];
      if (!same(v, now[k])) denied.push(`screenLog.${k}`);
      if (v !== undefined) out[k] = v;
    }
    return { value: stored === undefined && !Object.keys(out).length ? undefined : out, denied };
  },
};

function keepAll(stored: Blob, next: Blob, scope: Scope, force: Set<string>): { blob: Blob; denied: string[] } {
  const ctx: Ctx = { device: scope.device, desktopId: scope.desktopId, bots: botIdsOn(stored, scope.desktopId), force };
  const blob: Blob = {};
  const denied: string[] = [];
  for (const k of new Set([...Object.keys(stored), ...Object.keys(next)])) {
    let value: unknown;
    if (same(stored[k], next[k])) value = next[k];
    else if (force.has(k)) {
      value = stored[k];
      denied.push(k);
    } else if (FREE.has(k)) value = next[k];
    else if (RULES[k]) {
      const r = RULES[k](stored[k], next[k], ctx);
      value = r.value;
      denied.push(...r.denied);
    } else {
      value = stored[k];
      denied.push(k);
    }
    if (value !== undefined) blob[k] = value;
  }
  return { blob, denied };
}

/**
 * What a computer's write would change that it may not, as paths ("bots.<id>.keys", "routines.<id>",
 * "workspaces"): none when it may write it. `stored` is the blob it was written over (the same version).
 * A user with no state yet can't have one started by a computer: everything is refused.
 */
export function writeDenials(stored: Blob, next: Blob, scope: Scope): string[] {
  if (!Object.keys(stored).length) return Object.keys(next).length ? ["state"] : [];
  return keepAll(stored, next, scope, new Set()).denied;
}

/**
 * `mine` with what the computer may not write put back as it was in `base`: what a runner sends (so it's
 * never refused), and what the Mac takes of a computer's write. `held` says what was put back. `force`:
 * paths Bops Cloud refused anyway ("routines.<id>", "workspaces"), put back too.
 */
export function keepAllowed(base: Blob, mine: Blob, scope: Scope, force: Iterable<string> = []): { blob: Blob; held: string[] } {
  const r = keepAll(base, mine, scope, new Set([...force].map((p) => p.split(".").slice(0, 2).join("."))));
  return { blob: r.blob, held: r.denied };
}
