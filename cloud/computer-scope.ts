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
 * - what it began stays its own to the end (threadsOf, runsOf, runsBy): a bot can move off the computer (to a
 *   computer of its own, to another workspace) while its runner runs one of its threads or one of its
 *   routines' runs (a chat run, RoutineRun.by), and that thread, the clock and record of the routine whose
 *   run it is (Routine.last.sessionId, or that run's time), the threads that run starts, and its bot's words
 *   and Bops' notes about them in its chat (Message.routine, also once the run's end is recorded, until
 *   another run is) still come from that runner, so the run ends once, with its result. Nothing new for
 *   that bot: no other thread started, no other run recorded, and no thread moved to another bot or chat. So a runner does a run's work only once Bops Cloud has its start
 *   (lib/server/store.ts startLanded): one refused because the move landed first is taken back there, and
 *   the Bops that has the bot now runs it;
 * - how a bot on it is doing on its computer (computerStatus, computerRam, computerNeverReady,
 *   wakeFailed, tailnet) and its Composio session (composio);
 * - its own requests for the user's OK (appApprovals, AppApproval.askedBy its device) of its bots, or of a thread
 *   of its own: added unanswered, and taken out (cancelled, or read once answered). Never a reply: that's the
 *   user's, from a Bops of their own (a person's action), so a computer never says yes to itself, and never
 *   anything of another Bops's request;
 * - when an app account was last used (accounts[].usedAt), a brain's sign-in on this computer
 *   (brains[].signIns for its computer id), news held for later about a bot on it (digest, added only),
 *   which thread last held a screen of it (screenLog), the usage ledger (shown on the account page
 *   only) and the out-of-credit mark (credits).
 * Anything else (bots added, moved or given keys or app access, routines added, edited or taken out,
 * another device's threads, workspaces, logins, channels, phone numbers, Macs' own settings) is refused
 * (403 computer_not_allowed). Its chat messages are only its bots' words and Bops' notes, in its bots'
 * chats (computersMessage: never the user's or another bot's), and the services
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

/** A thread its runner began, by id (threadsOf): its bot, and the chat it's in. */
export type OwnThread = { botId: string; chatId: string };

/**
 * The threads its runner already has in `state` (Session.by its device), by id: still its own after their
 * bot moved off the computer, to their end (writeDenials, computersMessage). Another Bops runs that bot's
 * routines from then on, and waits for such a run to end (lib/server/routines.ts strayRun).
 */
export function threadsOf(state: Blob, device: string): Map<string, OwnThread> {
  const out = new Map<string, OwnThread>();
  if (!device) return out;
  for (const s of listOf(state.sessions)) if (s.by === device && typeof s.botId === "string") out.set(s.id as string, { botId: s.botId, chatId: str(s.chatId) ?? `bot:${s.botId}` });
  return out;
}

/**
 * The routines whose run its runner began and is still going (Routine.last: running, RoutineRun.by its device),
 * by id: their bot, and its chat. Still its own after their bot moved off the computer, as its threads are
 * (threadsOf): a chat run, recorded with no thread while the bot's turn runs, ends there with its result.
 */
export function runsOf(state: Blob, device: string): Map<string, OwnThread> {
  const out = new Map<string, OwnThread>();
  for (const [id, r] of runsBy(state, device)) if (r.status === "running") out.set(id, { botId: r.botId, chatId: r.chatId });
  return out;
}

/** A routine's run its runner recorded (runsBy): its bot and chat, when it began (RoutineRun.at), and how it stands. */
export type OwnRun = OwnThread & { at: number; status?: unknown };

/**
 * The routines whose last run its runner recorded (Routine.last.by its device), by id, whatever that run's
 * status: their bot, its chat, and when that run began. What that run posts in the chat (Message.routine: a
 * chat run's result, its notes and chip, a ping or a "Couldn't send" after it) stays its runner's to write
 * from when it began, its end recorded or not, until another run is (computersMessage): the end may reach
 * Bops Cloud before its words do, and its bot may have moved off the computer meanwhile.
 */
export function runsBy(state: Blob, device: string): Map<string, OwnRun> {
  const out = new Map<string, OwnRun>();
  if (!device) return out;
  for (const r of listOf(state.routines))
    if (isObject(r.last) && r.last.by === device && typeof r.last.at === "number" && typeof r.botId === "string")
      out.set(r.id as string, { botId: r.botId, chatId: `bot:${r.botId}`, at: r.last.at, status: r.last.status });
  return out;
}

/** Its bot's words or Bops' note, from none other (Message.from), when `bot(id)` says which bots are its. */
const saidBy = (m: Blob, bot: (id: unknown) => boolean) => (m.from === undefined || bot(m.from)) && (m.role === "bot" ? bot(m.botId) : m.role === "system" && (m.botId === undefined || bot(m.botId)));

/**
 * Whether its runner may write a message like this one, or change or remove one kept like it: in one of
 * its bots' chats (chatsOn), and its bots' own words (role bot, one of `bots`) or a note from Bops (role
 * system, naming none of the others), never the user's words nor another bot's. Or one about threads of
 * its own (`threads`, threadsOf: a run's chip, its result), each of them, in their chat, said by their bot
 * or Bops, or one of a routine's run of its own (`runs`, runsBy: Message.routine, a chat run's result, chip
 * and notes, posted since that run began, its end recorded or not), in its bot's chat, said by that bot or
 * Bops: that bot may have moved off the computer since the run began. A map with no `at` (runsOf, a run
 * still going) takes any of that routine's.
 */
export function computersMessage(m: Blob, bots: Set<string>, chats: Set<string>, threads?: Map<string, OwnThread>, runs?: Map<string, OwnThread & { at?: number }>): boolean {
  if (chats.has(m.chatId as string) && saidBy(m, (id) => typeof id === "string" && bots.has(id))) return true;
  const run = isObject(m.routine) && typeof m.routine.id === "string" ? runs?.get(m.routine.id) : undefined;
  const ofThatRun = !!run && (run.at === undefined || (typeof m.at === "number" && m.at >= run.at));
  if (run && ofThatRun && m.chatId === run.chatId && saidBy(m, (b) => b === run.botId)) return true;
  const named = [m.resultOf, ...(Array.isArray(m.sessionIds) ? m.sessionIds : [])].filter((x): x is string => typeof x === "string");
  return (
    !!threads &&
    named.length > 0 &&
    named.every((id) => {
      const t = threads.get(id);
      return !!t && m.chatId === t.chatId && saidBy(m, (b) => b === t.botId);
    })
  );
}

/* ---------------- What its bots may use ---------------- */

export type Level = "read" | "act";

/**
 * What a bot may do in an app account (lib/types.ts levelOf): what the user set, else Read & act for the bots of its
 * workspace by default, and of each workspace it's switched on in (`usedIn`: Workspace.loginsOn, usedInOf).
 */
export function levelOf(b: Blob, a: Blob, usedIn?: readonly string[]): Level | null {
  const set = isObject(b.access) && Object.hasOwn(b.access, a.id as string) ? b.access[a.id as string] : undefined;
  if (set === "read" || set === "act") return set;
  const openToTeam = !!a.workspaceId && !a.onlyGiven;
  if (set === "none" || CHANNEL_APPS.has(a.app as string) || !openToTeam) return null;
  return workspaceOf(a) === workspaceOf(b) || !!usedIn?.includes(workspaceOf(b)) ? "act" : null;
}

/** The workspaces an account is switched on in besides its own (lib/types.ts usedIn: Workspace.loginsOn["app:<id>"]). */
export function usedInOf(state: Blob, accountId: string): string[] {
  const key = `app:${accountId}`;
  return listOf(state.workspaces)
    .filter((w) => isObject(w.loginsOn) && Object.hasOwn(w.loginsOn, key) && isObject(w.loginsOn[key]))
    .map((w) => w.id as string);
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
    const usedIn = usedInOf(state, a.id as string);
    for (const b of bots) {
      const level = levelOf(b, a, usedIn);
      if (!level) continue;
      const had = out.get(a.id as string);
      out.set(a.id as string, { app: a.app, level: had?.level === "act" || level === "act" ? "act" : "read" });
    }
  }
  return out;
}

/**
 * Its bots' own inboxes (and the ones each had before: their mail still comes there), and for a bot with
 * no inbox of its own its workspace main bot's, which it sends from (lib/server/routines.ts deliver: a
 * routine's results by email; chat.ts), as linesOn does for texts.
 */
export function inboxesOn(state: Blob, desktopId: string): Set<string> {
  const bots = listOf(state.bots);
  const out = new Set<string>();
  for (const b of botsOn(state, desktopId)) {
    const m = isObject(b.mail) ? b.mail : null;
    if (typeof m?.inboxId === "string") out.add(m.inboxId);
    if (Array.isArray(m?.past)) for (const p of m.past) if (typeof p === "string") out.add(p);
    if (m) continue;
    const main = bots.find((x) => x.isMain && isObject(x.mail) && workspaceOf(x) === workspaceOf(b));
    const inbox = main && isObject(main.mail) ? main.mail.inboxId : undefined;
    if (typeof inbox === "string") out.add(inbox);
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

/** `runs`: its routines' runs still going (runsOf) that the write keeps as that run (their record's time). */
type Ctx = { device: string; desktopId: string; bots: Set<string>; chats: Set<string>; threads: Map<string, OwnThread>; runs: Map<string, OwnThread>; force: Set<string> };
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

/** A thread of one of its bots, in one of their chats (chatsOn): one it may start or change. */
const ofItsBots = (x: Blob, ctx: Ctx) => ctx.bots.has(x.botId as string) && (x.chatId === undefined || ctx.chats.has(x.chatId as string));
/** A thread a routine's run of its own starts (Session.routineId, ctx.runs), of that routine's bot in its chat: the bot may have moved off the computer since that run began. */
const ofItsRun = (x: Blob, ctx: Ctx) => {
  const run = typeof x.routineId === "string" ? ctx.runs.get(x.routineId) : undefined;
  return !!run && x.botId === run.botId && (x.chatId === undefined || x.chatId === run.chatId);
};

/** The thread a routine's run is (Routine.last.sessionId). */
const runOf = (r: Blob) => (isObject(r.last) ? str(r.last.sessionId) : undefined);
/**
 * A routine whose run, as it's kept and as it's written, is its own: a thread of its own of that routine's
 * bot (threadsOf), or the run its runner began (RoutineRun.by), written as that run (its time); its bot
 * moved off the computer while it ran.
 */
const itsRun = (s: Blob, n: Blob, ctx: Ctx) => {
  const id = runOf(s);
  if (id && id === runOf(n) && ctx.threads.get(id)?.botId === s.botId) return true;
  return isObject(s.last) && !!ctx.device && s.last.by === ctx.device && isObject(n.last) && n.last.at === s.last.at;
};

const RULES: Record<string, (stored: unknown, next: unknown, ctx: Ctx) => Kept> = {
  // Its own device's threads, of its bots in their chats, or of a routine's run of its own still going;
  // another's stay as they were. One it has stays its own where it is, its bot moved off the computer or not (threadsOf).
  sessions: (stored, next, ctx) =>
    keepList("sessions", stored, next, ctx, {
      add: (x) => x.by === ctx.device && (ofItsBots(x, ctx) || ofItsRun(x, ctx)),
      remove: (s) => s.by === ctx.device,
      item: (s, n) =>
        s.by === ctx.device && n.by === ctx.device && ((ofItsBots(s, ctx) && ofItsBots(n, ctx)) || (n.botId === s.botId && n.chatId === s.chatId)) ? { value: n, denied: [] } : { value: s, denied: [`sessions.${s.id}`] },
    }),
  // A run of its bots' routines: the clock, a skip that passed going, a pause. Of another bot's, only the
  // clock and record of the run that's its own (itsRun).
  routines: (stored, next, ctx) =>
    keepList("routines", stored, next, ctx, {
      add: () => false,
      remove: () => false,
      item: (s, n) => {
        if (n.botId !== s.botId) return { value: s, denied: [`routines.${s.id}`] };
        if (!ctx.bots.has(s.botId as string)) return itsRun(s, n, ctx) ? onlyFields("routines", s, n, ROUTINE_RUN) : { value: s, denied: [`routines.${s.id}`] };
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
  // Its own requests for the user's OK: added unanswered (for one of its bots, or a thread of its own), and taken
  // out. A reply is never its to write, nor anything of another's request, nor a change to one once made.
  appApprovals: (stored, next, ctx) =>
    keepList("appApprovals", stored, next, ctx, {
      add: (x) =>
        x.askedBy === ctx.device &&
        x.reply === undefined &&
        (ctx.bots.has(x.botId as string) || (typeof x.threadId === "string" && ctx.threads.get(x.threadId)?.botId === x.botId)),
      remove: (s) => s.askedBy === ctx.device,
      item: (s) => ({ value: s, denied: [`appApprovals.${s.id}`] }),
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

/** Its routines' runs still going (runsOf) that `next` still has as that run: a write that records another run starts nothing of that one. */
function runsKept(stored: Blob, next: Blob, device: string): Map<string, OwnThread> {
  const now = byId(next.routines);
  const was = byId(stored.routines);
  const at = (r: Blob | undefined) => (isObject(r?.last) ? r.last.at : undefined);
  return new Map([...runsOf(stored, device)].filter(([id]) => at(now.get(id)) !== undefined && at(now.get(id)) === at(was.get(id))));
}

function keepAll(stored: Blob, next: Blob, scope: Scope, force: Set<string>): { blob: Blob; denied: string[] } {
  const ctx: Ctx = {
    device: scope.device,
    desktopId: scope.desktopId,
    bots: botIdsOn(stored, scope.desktopId),
    chats: chatsOn(stored, scope.desktopId),
    threads: threadsOf(stored, scope.device),
    runs: runsKept(stored, next, scope.device),
    force,
  };
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

/* ---------------- What a computer never reads ---------------- */

/** A workspace without the Preview passwords kept for its members (null: it keeps none). */
function withoutPasswords(w: unknown): Blob | null {
  const seen = isObject(w) && isObject(w.appsForMembers) ? w.appsForMembers : undefined;
  if (!isObject(seen?.apps)) return null;
  let held = false;
  const apps = Object.fromEntries(
    Object.entries(seen.apps).map(([name, app]) => {
      if (!isObject(app) || !Array.isArray(app.sites) || !app.sites.some((s) => isObject(s) && "previewPassword" in s)) return [name, app];
      held = true;
      const sites = app.sites.map((s) => {
        if (!isObject(s) || !("previewPassword" in s)) return s;
        const rest = { ...s };
        delete rest.previewPassword;
        return rest;
      });
      return [name, { ...app, sites }];
    }),
  );
  return held ? { ...(w as Blob), appsForMembers: { ...seen, apps } } : null;
}

/**
 * The state as a computer reads it (cloud/state.ts: GET /v1/state, and a write's 409): without each site's Preview
 * password the owner's Mac keeps for members at Your Apps Write (Workspace.appsForMembers, lib/hosted-apps.ts
 * AppForMembers). A bot runs as root on its computer and a web page can steer it, and a runner never needs them
 * (lib/server/apps-for-members.ts seeApps is the owner's Mac's alone).
 */
export function forComputer(state: Blob): Blob {
  const list = state.workspaces;
  if (!Array.isArray(list) || !list.some((w) => withoutPasswords(w))) return state;
  return { ...state, workspaces: list.map((w) => withoutPasswords(w) ?? w) };
}

/** Whether a computer's write carries a Preview password: refused, never compared, so a right guess isn't told from a wrong one. */
export const carriesPasswords = (state: Blob): boolean => forComputer(state) !== state;

/**
 * A computer's write with what forComputer left out put back from `stored`, the blob it was written over: it may
 * not change workspaces, and sends them as it read them, so when they match the stored ones without the passwords
 * they're the stored ones. Otherwise as sent, and writeDenials refuses "workspaces" as ever.
 */
export function withHeldBack(stored: Blob, next: Blob): Blob {
  if (!Array.isArray(stored.workspaces) || !Array.isArray(next.workspaces)) return next;
  return same(forComputer({ workspaces: stored.workspaces }).workspaces, next.workspaces) ? { ...next, workspaces: stored.workspaces } : next;
}
