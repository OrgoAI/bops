import { isAppAct, MEMBER_ACT_MS, MEMBER_APPS_READ_ONLY, MEMBER_MAX_TEXT, MEMBER_OWNER_ONLY, MEMBER_READ_ONLY, type MemberAct, type MemberAppAct, type SharedWsState, type SharedWsUnchanged } from "@/cloud/protocol";
import { ownerOnlyAsk } from "@/lib/member-access";
import { duePings } from "@/lib/pings";
import { ownerCall, ownerCredit, ownerVoice, sharedWsId, type SharedOpen, type SharedWorkspace } from "@/lib/shared";
import { pairChatId, workspaceOf, type AppApproval, type AppState, type Bot, type Chat, type MemberSaid, type MemberSend, type Message, type Routine, type Session, type ThreadReply, type Watch, type Workspace } from "@/lib/types";
import type { RemoteMood } from "./live-core";

/**
 * A workspace shared with the user, open here (lib/shared.ts), without the server: what's kept of it
 * (SharedCopy), read from Bops Cloud (GET /v1/ws/<project>/state) through `read`, which lib/server/shared.ts
 * wires to the signed-in key, what the user did there for a bot they have at Write that the owner's Bops
 * hasn't written yet (SharedCopy.acting, actWith), and the state the window is shown while it's open
 * (viewState). The copy lives in this object alone: it's never put in the user's state, saved or synced,
 * and it goes the moment the user may no longer see the workspace.
 */

/** One read of the workspace: the HTTP status (0: Bops Cloud didn't answer) and what it said. */
export type ReadResult = { status: number; body?: SharedWsState | SharedWsUnchanged | { error?: string } };
/**
 * `older`: a page of one chat's messages, in place of its newest: the ones before the oldest the copy has
 * (?chat=<id>&before=<its ms>&beforeId=<its id>), so one sharing its millisecond that Bops Cloud puts before it is in the page.
 */
export type Read = (projectId: string, have?: string, older?: { chat: string; before: number; beforeId: string }) => Promise<ReadResult>;

/** The answers that mean the user may no longer see the workspace: their copy goes and they leave it. */
export const GONE = [401, 403, 404, 409];

/** A chat's older messages read so far, oldest first, and whether Bops Cloud has older ones still. */
type Older = { messages: Record<string, unknown>[]; more: boolean };

/**
 * Something the user did in the workspace (MemberAct) that the owner's Bops hasn't written yet: on its way to
 * Bops Cloud ("sending"), there and waiting for the owner's Bops to open ("waiting"), or not sent (`error`).
 * `me`: who they are on it, as their own words show until the owner's copy comes.
 */
export type PendingAct = { key: string; act: MemberAct; at: number; state: MemberSend["state"]; error?: string; me: MemberSaid };
/** What an act waiting past MEMBER_ACT_MS, or one the owner's access no longer lets go, says. */
export const ACT_EXPIRED = "The owner's Bops didn't open in time, so this didn't go.";
export const ACT_ACCESS_CHANGED = "The owner changed your access, so this didn't go.";
/** What one too long to send says (more than MEMBER_MAX_TEXT, or a body Bops Cloud won't take). */
export const ACT_TOO_LONG = "That's too long to send. Make it shorter.";
/** What Bops Cloud says of what only the owner does (MEMBER_OWNER_ONLY): the same words, from the copy. */
const ON_THEIR_MAC = "This runs on the owner's Mac. Only the owner can tell it more.";
const THEIR_LOGINS = "This uses the owner's apps or keys. Only the owner can answer it.";
const LIVE = new Set(["running", "queued", "starting"]);

/** The bots an act touches, as the copy has them: none when what it names is gone. */
function botsOfAct(d: SharedWsState, act: MemberAct): string[] {
  // An app's act touches no bot: Your Apps' level says (refusal, settle).
  if (isAppAct(act)) return [];
  const thread = (id: string) => d.state.sessions.find((x) => x.id === id);
  const ids = (xs: unknown[]) => xs.flatMap((x) => (typeof x === "string" ? [x] : []));
  if (act.act === "chat") {
    const c = d.state.chats.find((x) => x.id === act.chatId);
    return c && Array.isArray(c.botIds) ? ids(c.botIds) : [];
  }
  if (act.act === "answer") return ids([d.state.approvals?.find((x) => x.id === act.askId)?.botId]);
  return ids((act.act === "stop" ? act.sessionIds : [act.sessionId]).map((id) => thread(id)?.botId));
}

/** Whether the copy has what an act did now (the owner's Bops wrote it): their words, by their key; the ask answered; the threads stopped. */
function landed(d: SharedWsState, messages: Record<string, unknown>[], p: PendingAct): boolean {
  const mine = (x: unknown) => !!x && typeof x === "object" && (x as { member?: { ref?: unknown } }).member?.ref === p.key;
  const a = p.act;
  const thread = (id: string) => d.state.sessions.find((x) => x.id === id);
  switch (a.act) {
    case "chat":
      return messages.some((m) => m.chatId === a.chatId && mine(m));
    case "reply": {
      const t = thread(a.sessionId);
      return !t || (Array.isArray(t.replies) && t.replies.some(mine));
    }
    case "answer":
      return !d.state.approvals?.some((x) => x.id === a.askId);
    case "stop":
      return a.sessionIds.every((id) => !LIVE.has(String(thread(id)?.status)));
    case "dismiss": {
      const t = thread(a.sessionId);
      return !t || t.dismissed === true || !LIVE.has(String(t.status));
    }
    // An app's: the owner's Mac kept it on the app, done or refused (its `ok` and `said` show there).
    default:
      return !!d.state.apps?.list.find((x) => x.name === a.app)?.acts?.some((x) => x.key === p.key);
  }
}
type Copy = { open: SharedOpen; data: SharedWsState; older: Map<string, Older> };

/** Whether the window can show it: the workspace, with a chat to open (the window always has one). */
const showable = (d: SharedWsState) => !!d.state?.workspace && Array.isArray(d.state.chats) && d.state.chats.length > 0;

/**
 * The chats of the workspace the user may read, by id: its chats, and every two of its bots' conversation
 * with each other (lib/types.ts pairChatId: there's no chat for one in the owner's state), as Bops Cloud
 * reads them for the user (cloud/ws-slice.ts chatIdsOf) and pages their older messages ("Asked ● Sam"
 * opens one at an exchange that may be older than its newest page).
 */
function chatsOf(d: SharedWsState): Set<string> {
  const out = new Set(d.state.chats.map((c) => String(c.id)));
  const bots = [...new Set(d.state.bots.flatMap((b) => (typeof b.id === "string" ? [b.id] : [])))];
  for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) out.add(pairChatId(bots[i], bots[j]));
  return out;
}

/**
 * The older pages a new read of the newest (`now`) keeps, by chat, with nothing missing between them and
 * it: the messages that slid out of a chat's newest page since `was` (new ones came) join its older pages,
 * and for a chat whose first older page is on its way (`reading`), they wait for it there; what the owner
 * deleted since (`now.gone`) goes from them. A chat's go
 * when the user may no longer see it, when its newest page is all of it now (nothing older is left there),
 * and when that page has none of the previous one's (more came than a page holds while the copy wasn't
 * reading): messages between may be missing, so "Show earlier messages" reads from the newest again.
 */
function olderKept(was: Copy, now: SharedWsState, reading: Iterable<string>): Map<string, Older> {
  const chats = chatsOf(now);
  const out = new Map<string, Older>();
  // What the owner deleted since the copy's read (SharedWsState.gone) goes from the older pages too.
  const gone = new Set(now.gone ?? []);
  const kept = new Map([...was.older].map(([chat, o]) => [chat, gone.size ? { ...o, messages: o.messages.filter((m) => !gone.has(String(m.id))) } : o]));
  for (const chat of reading) if (!kept.has(chat)) kept.set(chat, { messages: [], more: true });
  for (const [chat, o] of kept) {
    if (!chats.has(chat) || !now.more.includes(chat)) continue;
    const page = now.messages.filter((m) => m.chatId === chat);
    const ids = new Set(page.map((m) => m.id));
    const had = was.data.messages.filter((m) => m.chatId === chat);
    if (!had.some((m) => ids.has(m.id))) continue;
    const oldest = Math.min(...page.map((m) => Number(m.at)));
    const seen = new Set(o.messages.map((m) => m.id));
    // Not in the new page and no newer than all of it: slid out. One in its oldest's millisecond came before
    // that one in Bops Cloud's order (cloud/state.ts recentMessages); one newer than it that's gone was removed.
    const slid = had.filter((m) => !ids.has(m.id) && !seen.has(m.id) && !gone.has(String(m.id)) && Number(m.at) <= oldest);
    if (o.messages.length || slid.length) out.set(chat, { messages: [...o.messages, ...slid], more: o.more });
  }
  return out;
}

/**
 * What's kept of the shared workspace open now, and reading it again. `onChange` runs whenever what the
 * window shows of it changed; `onGone` when it went because the user may no longer see it.
 */
export class SharedCopy {
  private copy: Copy | null = null;
  private reading?: Promise<void>;
  /** Asked to read again while a read was on its way: that one may be from before the change, so another follows it. */
  private again = false;
  /** Counts every change to what's kept, so the window's state has a new version each time. */
  rev = 0;
  /** What the user did there that the owner's Bops hasn't written yet, by their key for it (PendingAct). */
  private pending = new Map<string, PendingAct>();
  /** The clock acts are timed by (tests). */
  now: () => number = () => Date.now();
  private read: Read;
  private onChange: () => void;
  private onGone: (w: SharedOpen) => void;

  constructor(read: Read, hooks: { onChange?: () => void; onGone?: (w: SharedOpen) => void } = {}) {
    this.read = read;
    this.onChange = hooks.onChange ?? (() => {});
    this.onGone = hooks.onGone ?? (() => {});
  }

  /** Open `w`: read it first, and keep it only when that worked. The error line otherwise (and its status). */
  async open(w: SharedWorkspace): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const r = await this.read(w.projectId);
    if (r.status !== 200 || !r.body || !("state" in r.body)) {
      const error = r.body && "error" in r.body && typeof r.body.error === "string" ? r.body.error : r.status ? "You can't open this workspace." : "Couldn't reach Bops Cloud. Try again.";
      return { ok: false, status: r.status, error };
    }
    if (!showable(r.body)) return { ok: false, status: 404, error: "This workspace has nothing to show yet." };
    this.copy = { open: { ...w, name: r.body.name || w.name, role: r.body.role, wsId: sharedWsId(w.projectId) }, data: r.body, older: new Map() };
    this.pending.clear();
    this.changed();
    return { ok: true };
  }

  /**
   * Read it again (a "state" event, a reset): only what changed comes back, nothing when the copy is
   * current. One read at a time, and one more after it when asked meanwhile; the user losing access drops
   * the copy, and so does a read with nothing left for them to see (the owner took away their last bot, or
   * the workspace went): the copy never shows what they were given before.
   */
  refresh(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    return (this.reading = (async () => {
      do {
        this.again = false;
        await this.readAgain();
      } while (this.again && this.copy);
    })().finally(() => (this.reading = undefined)));
  }

  private async readAgain() {
    const was = this.copy;
    if (!was) return;
    const r = await this.read(was.open.projectId, `${was.data.hash}.${was.data.seq}`).catch((): ReadResult => ({ status: 0 }));
    if (this.copy !== was) return;
    if (GONE.includes(r.status)) return this.gone();
    if (r.status !== 200 || !r.body || "unchanged" in r.body || !("state" in r.body)) return;
    if (!showable(r.body)) return this.gone();
    const older = olderKept(was, r.body, this.going.keys());
    this.copy = { open: { ...was.open, name: r.body.name || was.open.name, role: r.body.role }, data: r.body, older };
    this.settle();
    this.changed();
  }

  /**
   * What the user did that the copy has now goes (their own copy gives way to the owner's); one whose bots the
   * owner no longer gives them at Write didn't go, and says so.
   */
  private settle() {
    const c = this.copy;
    if (!c) return;
    const messages = this.messagesOf(c);
    const levels = c.data.state.levels ?? {};
    for (const [key, p] of this.pending) {
      if (p.state !== "failed" && landed(c.data, messages, p)) this.pending.delete(key);
      else if (p.state !== "failed" && (isAppAct(p.act) ? c.data.state.apps?.level !== "write" : botsOfAct(c.data, p.act).some((id) => levels[id] !== "write")))
        this.pending.set(key, { ...p, state: "failed", error: ACT_ACCESS_CHANGED });
    }
  }

  /** Something the user does there, shown as theirs at once (`me`) until the owner's Bops writes it: on its way. The same key again (Try again) starts it over. */
  acting(key: string, act: MemberAct, me: MemberSaid) {
    if (!this.copy) return;
    this.pending.set(key, { key, act, at: this.now(), state: "sending", me });
    this.changed();
  }

  /** Bops Cloud took it: on its way to the owner's Bops ("sending"), or waiting for it to open ("waiting"). */
  acted(key: string, state: "sending" | "waiting") {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.set(key, { ...p, state });
    this.changed();
    // Still waiting by then, it says it didn't go (acts): the window's state changes then too.
    const t = setTimeout(() => this.pending.get(key)?.state === "waiting" && this.changed(), MEMBER_ACT_MS + 1000);
    (t as { unref?: () => void }).unref?.();
  }

  /** It didn't go, and why (shown under it, with Try again). */
  failed(key: string, error: string) {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.set(key, { ...p, state: "failed", error });
    this.changed();
  }

  /** Forget one (it went, or the user let it be). */
  forget(key: string) {
    if (this.pending.delete(key)) this.changed();
  }

  /** What's still on its way, as it stands now: one waiting longer than MEMBER_ACT_MS for the owner's Bops didn't go. */
  acts(): PendingAct[] {
    const now = this.now();
    return [...this.pending.values()].map((p) => (p.state !== "failed" && now - p.at > MEMBER_ACT_MS ? { ...p, state: "failed" as const, error: ACT_EXPIRED } : p));
  }

  /** Why the user can't do this here, from the copy (Bops Cloud decides, this only saves a round trip), or null. */
  refusal(act: MemberAct): { status: number; error: string; code?: string } | null {
    const c = this.copy;
    if (!c) return { status: 409, error: "Open the workspace again." };
    if ((act.act === "chat" || act.act === "reply") && act.text.trim().length > MEMBER_MAX_TEXT) return { status: 400, error: ACT_TOO_LONG };
    // An app's: Your Apps at Write, an app they're shown (cloud/members.ts appsTouched says the same, and more).
    if (isAppAct(act)) {
      const apps = c.data.state.apps;
      if (!apps?.list.some((x) => x.name === act.app)) return { status: 404, error: "No such app." };
      if (apps.level !== "write") return { status: 403, error: "You can see these apps. Ask the owner for Write to change them.", code: MEMBER_APPS_READ_ONLY };
      return null;
    }
    const bots = botsOfAct(c.data, act);
    if (!bots.length) return { status: 404, error: "That's gone from the workspace." };
    const levels = c.data.state.levels ?? {};
    if (!bots.every((id) => levels[id] === "write")) return { status: 403, error: "You can watch this bot, not act for it. Ask the owner for Write.", code: MEMBER_READ_ONLY };
    // What only the owner does, whatever the level (cloud/members.ts botsTouched says the same).
    const onMac = (id: unknown) => typeof id === "string" && c.data.state.sessions.some((x) => x.id === id && x.runsOn === "mac");
    if ((act.act === "reply" || act.act === "dismiss") && onMac(act.sessionId)) return { status: 403, error: ON_THEIR_MAC, code: MEMBER_OWNER_ONLY };
    if (act.act === "answer") {
      const a = c.data.state.approvals?.find((x) => x.id === act.askId);
      if (a && ownerOnlyAsk(a.kind)) return { status: 403, error: THEIR_LOGINS, code: MEMBER_OWNER_ONLY };
      if (a && onMac(a.threadId)) return { status: 403, error: ON_THEIR_MAC, code: MEMBER_OWNER_ONLY };
    }
    return null;
  }

  /** Older pages being read, by chat: one at a time each. */
  private going = new Map<string, Promise<boolean>>();

  /**
   * One page more of a chat's older messages ("Show earlier messages"), before the oldest the copy has:
   * Bops Cloud keeps them all, and the first read brought the newest MESSAGES_PER_CHAT. True when some came.
   */
  older(chat: string): Promise<boolean> {
    const going = this.going.get(chat);
    if (going) return going;
    const run = this.readOlder(chat).finally(() => this.going.delete(chat));
    this.going.set(chat, run);
    return run;
  }

  private async readOlder(chat: string, tries = 3): Promise<boolean> {
    const was = this.copy;
    if (!was || !this.moreIn(was).includes(chat)) return false;
    // The oldest it has of the chat (the first in Bops Cloud's order of those in its millisecond).
    const from = this.messagesOf(was)
      .filter((m) => m.chatId === chat && Number.isFinite(Number(m.at)))
      .reduce<Record<string, unknown> | undefined>((a, m) => (!a || Number(m.at) < Number(a.at) ? m : a), undefined);
    if (!from) return false;
    const r = await this.read(was.open.projectId, undefined, { chat, before: Number(from.at), beforeId: String(from.id) }).catch((): ReadResult => ({ status: 0 }));
    const now = this.copy;
    if (!now || now.open.projectId !== was.open.projectId) return false;
    if (GONE.includes(r.status)) {
      this.gone();
      return false;
    }
    if (r.status !== 200 || !r.body || !("state" in r.body) || !chatsOf(now.data).has(chat)) return false;
    // It goes where it was read from: before that message, still in the copy (a read of the newest meanwhile
    // keeps the ones that slid out: olderKept). Not when it went (more came than a page holds): messages between
    // may be missing, so the page is read again, before the oldest the copy has now.
    const mine = this.messagesOf(now).filter((m) => m.chatId === chat);
    if (!mine.some((m) => m.id === from.id)) return tries > 1 ? this.readOlder(chat, tries - 1) : false;
    const have = new Set(mine.map((m) => m.id));
    const page = r.body.messages.filter((m) => m.chatId === chat && !have.has(m.id));
    const had = now.older.get(chat);
    now.older.set(chat, { messages: [...page, ...(had?.messages ?? [])], more: r.body.more.includes(chat) && page.length > 0 });
    this.changed();
    return page.length > 0;
  }

  /** Every message the copy has: each chat's older pages, then the newest (a message in both once, as the newest has it). */
  private messagesOf(c: Copy): Record<string, unknown>[] {
    const newest = new Set(c.data.messages.map((m) => m.id));
    return [...[...c.older.values()].flatMap((o) => o.messages).filter((m) => !newest.has(m.id)), ...c.data.messages];
  }

  /** The chats Bops Cloud has older messages of than the copy: as the newest read said, or the last older page of each. */
  private moreIn(c: Copy): string[] {
    const chats = chatsOf(c.data);
    const out = new Set(c.data.more.filter((x) => !c.older.has(x)));
    for (const [chat, o] of c.older) if (o.more) out.add(chat);
    return [...out].filter((x) => chats.has(x));
  }

  /** Whether a "state" event with this fingerprint needs a read: not when the copy has it already. */
  wants = (hash: unknown) => !this.copy || typeof hash !== "string" || hash !== this.copy.data.hash;

  /** The user may no longer see it (revoked, 403 or 404): the copy goes, and they leave it. */
  gone() {
    const was = this.copy;
    if (!was) return;
    this.copy = null;
    this.pending.clear();
    this.changed();
    this.onGone(was.open);
  }

  /** Leave it (the user switched away, or signed out): the copy goes. */
  close() {
    if (!this.copy) return;
    this.copy = null;
    this.pending.clear();
    this.changed();
  }

  /** The workspace open now, if any. */
  openNow = (): SharedOpen | null => this.copy?.open ?? null;
  /** What's kept of it (tests, viewState): the newest read, with each chat's older pages read since in its messages, and `more` as it stands now. */
  data = (): SharedWsState | null => (this.copy ? { ...this.copy.data, messages: this.messagesOf(this.copy), more: this.moreIn(this.copy) } : null);

  private changed() {
    this.rev++;
    this.onChange();
  }
}

/** What Bops Cloud answered an act (POST /v1/ws/<project>/act): its status (0: it didn't answer) and body. */
export type ActResult = { status: number; body?: { ok?: boolean; macOn?: boolean; error?: string; code?: string } };

/** The words for an act Bops Cloud turned down, plain: its own where it says them, else by its status. */
function actError(r: ActResult): string {
  if (!r.status) return "Couldn't reach Bops Cloud. Try again.";
  if (r.status === 503) return "Can't reach Orgo to check your access. Try again.";
  if (r.status === 404) return "That's gone from the workspace.";
  // Too long for Bops Cloud (its body limit, or more than MEMBER_MAX_TEXT): never its own words for it ("Send {key, act}").
  if (r.status === 413 || r.status === 400) return ACT_TOO_LONG;
  return r.body?.error || "That didn't go. Try again.";
}

/**
 * Do something in the shared workspace open in `copy`, for bots the user has at Write (lib/server/shared.ts actShared
 * sends it to Bops Cloud, `send`): shown as theirs at once, then as Bops Cloud said (on its way, waiting for the owner's
 * Bops to open, or not sent and why). A refusal the copy can tell saves the round trip. Bops Cloud saying they may no
 * longer see the workspace drops the copy, as a read would (GONE); a bot taken down to Read reads it again, so the
 * window closes what's no longer theirs.
 */
export async function actWith(copy: SharedCopy, act: MemberAct, key: string, me: MemberSaid, send: (body: string) => Promise<ActResult>): Promise<{ ok: true; key: string; macOn: boolean } | { ok: false; status: number; error: string; code?: string }> {
  const no = copy.refusal(act);
  if (no) return { ok: false, ...no };
  copy.acting(key, act, me);
  const r = await send(JSON.stringify({ key, act })).catch((): ActResult => ({ status: 0 }));
  if (r.status === 202) {
    copy.acted(key, r.body?.macOn ? "sending" : "waiting");
    void copy.refresh();
    return { ok: true, key, macOn: !!r.body?.macOn };
  }
  const error = actError(r);
  copy.failed(key, error);
  // No access at all (the workspace, not something in it): what a read would drop it for.
  if ((r.status === 404 && r.body?.error === "No such workspace") || r.status === 401) copy.gone();
  else if (r.body?.code === MEMBER_READ_ONLY) void copy.refresh();
  return { ok: false, status: r.status, error, ...(r.body?.code ? { code: r.body.code } : {}) };
}

/**
 * A thread's steps Bops writes itself (getting a computer ready, a key from the vault, looking through the
 * owner's apps): the ones read in the owner's voice. Never a helper's: what it was brought in for is the bot's
 * own words, unquoted, and stays as written.
 */
const BOPS_STEPS = new Set(["setup", "vault", "find_app_actions"]);

/**
 * A line Bops wrote in the chat itself, in the user's voice when it says "you" (a note: "Texted you: …",
 * "You took over from …"): not an email or a text that came or went (someone's words), a fact remembered
 * or a save to the CRM, nor what an app answered.
 */
const bopsLine = (m: Message) => m.role === "system" && typeof m.text === "string" && !m.email && !m.sms && !m.memory && !m.crm && !m.appResult;

/** Bops' own title for the Mac part of a thread ("<title> · on your Mac": sessions.ts), as a shared workspace reads it: that Mac is the owner's. */
const onTheirMac = (text: string) => text.replace(/ · on your Mac\b/g, " · on the owner's Mac");

/**
 * The state the window is shown while a shared workspace is open: the user's own (their account,
 * Settings, the vault sheet: all theirs), with every workspace's bots, chats, threads, routines, watches
 * and messages replaced by the shared one's, under its own id (sharedWsId) so nothing of it is ever
 * taken for the user's own. `moods`: its bots' moods from its stream. Made for each read of the window
 * and never kept: the user's state is untouched.
 */
export function viewState(own: AppState, open: SharedOpen, data: SharedWsState, moods: Record<string, RemoteMood>, acts: PendingAct[] = []): AppState {
  const ws = open.wsId;
  const s = data.state;
  const workspace: Workspace = { id: ws, name: open.name, createdAt: Number(s.workspace?.createdAt) || 0 };
  const bots = s.bots.map((b) => ({ computerStatus: "none", role: "", color: "#0A0A0A", isMain: false, ...b, workspaceId: ws }) as unknown as Bot);
  const ids = new Set(bots.map((b) => b.id));
  const chats = s.chats.map((c) => ({ botIds: [], createdAt: 0, ...c, typing: [], workspaceId: ws }) as unknown as Chat);
  // Bops' own lines in the owner's voice ("Stopped by you", "You approved $42", "Getting a browser ready on
  // your Mac") read as the owner's (ownerVoice): why a thread or a routine's last run stopped, a thread's
  // notes, its status steps (Bops', never what it typed, searched for or ran: those are as they were), the
  // chat's notes. (The Mac part of a thread's work is titled by Bops "<title> · on your Mac": that Mac is the owner's.)
  // What the viewer did that the owner's Bops hasn't written yet (SharedCopy.acts): their replies under the
  // threads, and the threads they stopped saying so, until the copy has the owner's.
  const sendOf = (p: PendingAct): MemberSend => ({ state: p.state, ...(p.error ? { error: p.error } : {}), key: p.key });
  const stopping = new Set(acts.flatMap((p) => (p.act.act === "stop" && p.state !== "failed" ? p.act.sessionIds : [])));
  const sessions = s.sessions.map((x) => {
    const t = { steps: [], replies: [], host: "orgo", ...x } as unknown as Session;
    const mine: ThreadReply[] = acts.flatMap((p) => (p.act.act === "reply" && p.act.sessionId === t.id ? [{ id: `acting_${p.key}`, role: "user" as const, text: p.act.text, at: p.at, member: { ...p.me, ref: p.key }, memberSend: sendOf(p) }] : []));
    return {
      ...t,
      ...(stopping.has(t.id) && !t.stopAsked ? { stopAsked: "Stopping" } : {}),
      ...(typeof t.title === "string" ? { title: onTheirMac(t.title) } : {}),
      ...(typeof t.error === "string" ? { error: ownerVoice(t.error) } : {}),
      replies: [...(Array.isArray(t.replies) ? t.replies : []).map((r) => (typeof r.note === "string" ? { ...r, note: ownerVoice(r.note) } : r)), ...mine],
      steps: (Array.isArray(t.steps) ? t.steps : []).map((st) => (typeof st.detail === "string" && BOPS_STEPS.has(st.tool) ? { ...st, detail: ownerVoice(st.detail, searched(st.detail)) } : st)),
    };
  });
  const routines = (s.routines as unknown as Routine[]).map((r) => (typeof r.last?.error === "string" ? { ...r, last: { ...r.last, error: ownerVoice(r.last.error) } } : r));
  const watches = (s.watches ?? []) as unknown as Watch[];
  // And the owner's calls to a bot (their card: "You: …"), and a bot's line about the owner's credit.
  const messages = (data.messages as unknown as Message[]).map((x) => {
    // A note or chip naming a thread's Mac part names it as its title is shown (onTheirMac).
    const m = (x.role === "system" || x.bops) && typeof x.text === "string" ? { ...x, text: onTheirMac(x.text) } : x;
    return m.role === "system" && m.call && typeof m.text === "string"
      ? { ...m, text: ownerCall(m.text) }
      : bopsLine(m)
        ? { ...m, text: ownerVoice(m.text, wordsIn(m)) }
        : m.role === "bot" && typeof m.text === "string"
          ? // Bops' own line in the bot's voice (Message.bops): the owner's, the title of a thread it names kept as written.
            // So is a watch's heads-up and the digest of what came in (posted as the bot's, unmarked): what's around the news is Bops'.
            { ...m, text: m.bops ? ownerVoice(m.text, titlesIn(m)) : ownerCredit(theirHeadsUp(m)) }
          : m;
  });
  // The viewer's own words on their way to the owner's Bops, in the chats they're in (their own copy, until the owner's comes).
  const chatIds = new Set(chats.map((c) => c.id));
  for (const p of acts)
    if (p.act.act === "chat" && chatIds.has(p.act.chatId))
      messages.push({ id: `acting_${p.key}`, chatId: p.act.chatId, role: "user", text: p.act.text, at: p.at, ...(p.act.replyTo ? { replyTo: p.act.replyTo } : {}), member: { ...p.me, ref: p.key }, memberSend: sendOf(p) });
  // (A watch's heads-up, "Heads up, something new in <window> on your Mac: “…”" or "Heads up, <site> changed. It looks like what
  // you're watching for: …" (watches.ts tell), and the digest, "While you were busy:" (attention.ts flush): the owner's Mac, what
  // the owner watches for, the owner who was busy. The window's title, the news and what's watched for stay as written.)
  function theirHeadsUp(m: Message): string {
    const text = m.text;
    if (/^While you were busy:\n/.test(text)) return text.replace(/^While you were busy:/, "While the owner was busy:");
    if (!m.watch?.id) return text;
    const mac = /^Heads up, something new in ([\s\S]*) on your Mac: (“[\s\S]*”)$/.exec(text);
    if (mac) return `Heads up, something new in ${mac[1]} on the owner's Mac: ${mac[2]}`;
    const page = /^(Heads up, [\s\S]*? changed\. It looks like what) you're watching for: ([\s\S]*)$/.exec(text);
    if (page) return `${page[1]} the owner is watching for: ${page[2]}`;
    return text;
  }
  // (The bot's words a Bops note has in it, kept as written (ownerVoice): the title of any thread it names or
  // shows ("Sent to <title>: …", "You took over from Max · paused <title>"), the question of a thread it names
  // that was texted on (sessions.ts textIfUnanswered: "Texted you: <title> needs you: <its question>"), and
  // what a bot texted on its own (text_me: "Texted you: <its words>"). Longest first, so one inside another
  // isn't cut.)
  function wordsIn(m: Message): string[] {
    const text = m.text;
    const named = new Set([m.resultOf, ...(m.sessionIds ?? [])].filter(Boolean));
    const out: string[] = [];
    for (const t of sessions) {
      if (typeof t.title === "string" && t.title.trim() && text.includes(t.title)) out.push(t.title);
      if (named.has(t.id) && typeof t.answer === "string") {
        const words = t.answer.replace(/\*\*|\[|\]\([^)]*\)/g, "").trim();
        const said = words.length > 300 ? `${words.slice(0, 297)}…` : words;
        if (said && text.includes(said)) out.push(said);
      }
      // Its question as it was texted on, whatever it's answered since (sessions.ts textIfUnanswered: "Texted you: <title> needs you: <question>").
      const head = `Texted you: ${t.title} needs you: `;
      if (named.has(t.id) && typeof t.title === "string" && text.startsWith(head) && text.length > head.length) out.push(text.slice(head.length));
    }
    const texted = /^Texted you: ([\s\S]+)$/.exec(text);
    if (texted && !named.size) out.push(texted[1]);
    // What a thread was sent or moved to the Mac with, every word to its last quote ("Sent to <title>: “Tell Dana “yes” and …”").
    const passed = /^(?:Sent to|Moved) [\s\S]*?: (“[\s\S]*”)$/.exec(text);
    if (passed) out.push(passed[1]);
    // What a watch it's about looks for, and a reminder someone else set up, as they were typed ("Watching <site> · <what it looks for>"):
    // as the note quoted them when it was posted, whatever the watch looks for now (it may have been edited since).
    const w = m.watch?.id ? watches.find((x) => x.id === m.watch!.id) : undefined;
    for (const words of [w?.lookFor, w?.site]) if (typeof words === "string" && words.trim() && text.includes(words)) out.push(words);
    const watching = m.watch?.id ? /^Watching ([\s\S]+?) · ([\s\S]+)$/.exec(text) : null;
    if (watching) out.push(watching[1], watching[2]);
    const stopped = /^Stopped watching ([\s\S]+)$/.exec(text);
    if (stopped) out.push(stopped[1]);
    // A teammate's role as the bot that added it wrote it ("Max added Iris (Handles your inbox) to the team"), an app's title.
    const added = /^[\s\S]+? added [\s\S]+? \(([\s\S]+)\) to the team$/.exec(text);
    if (added) out.push(added[1]);
    const app = /^Didn't change ([^:\n]+): /.exec(text);
    if (app) out.push(app[1]);
    const r = m.routine?.id ? routines.find((x) => x.id === m.routine!.id) : undefined;
    if (typeof r?.reminder === "string" && r.reminder.trim() && text.includes(r.reminder)) out.push(r.reminder);
    return [...new Set(out)].sort((a, b) => b.length - a.length);
  }
  // (What a step looked for, as the bot wrote it, quotes and all: `looked for "<its words>" in your apps`.)
  function searched(detail: string): string[] {
    const q = /^looked for ("[\s\S]*") in your apps$/.exec(detail)?.[1];
    return q ? [q] : [];
  }
  // (The titles of the threads a line names: the bot's words, never Bops'.)
  function titlesIn(m: Message): string[] {
    const ids = new Set([m.resultOf, ...(m.sessionIds ?? [])]);
    return sessions.filter((t) => ids.has(t.id) && typeof t.title === "string" && t.title).map((t) => t.title);
  }
  // The switcher's counts of the user's own workspaces' bots: the window's bots are the shared one's.
  const ownBots: Record<string, number> = {};
  for (const b of own.bots) ownBots[workspaceOf(b)] = (ownBots[workspaceOf(b)] ?? 0) + 1;
  return {
    ...own,
    workspaces: [...(own.workspaces ?? []), workspace],
    workspace: ws,
    bots,
    chats,
    messages,
    sessions,
    routines,
    watches,
    // What the shared one's bots wait on the owner's OK for: answered here only for a bot the viewer has at Write
    // (POST /api/workspaces/shared { act }), sent to the owner's Bops through Bops Cloud; this Bops has none of their
    // asks to answer itself. One the viewer answered stays, with how their answer stands (AppApproval.memberSend: on
    // its way, waiting for the owner's Bops, or not gone and why), until the owner's Bops has it. None of the user's own.
    appApprovals: ((s.approvals ?? []) as unknown as AppApproval[])
      .filter((a) => ids.has(a.botId) && !a.reply)
      .map((a) => {
        const p = acts.filter((x) => x.act.act === "answer" && x.act.askId === a.id).sort((x, y) => y.at - x.at)[0];
        return p ? { ...a, memberSend: sendOf(p) } : a;
      }),
    digest: [],
    takeover: undefined,
    suggest: undefined,
    screens: undefined,
    screenLog: undefined,
    liveMoods: Object.keys(moods).some((id) => ids.has(id)) ? Object.fromEntries(Object.entries(moods).filter(([id]) => ids.has(id))) : undefined,
    shared: {
      ...open,
      ownBots,
      more: data.more,
      levels: s.levels ?? {},
      ...(data.you ? { you: data.you } : {}),
      // Your Apps, when the owner gave it (cloud/ws-slice.ts appsFor), and what the user did to them that hasn't landed.
      ...(s.apps ? { apps: s.apps } : {}),
      ...(s.apps && acts.some((x) => isAppAct(x.act)) ? { appActs: acts.filter((x) => isAppAct(x.act)).map((x) => ({ key: x.key, act: x.act as MemberAppAct, at: x.at, state: x.state, ...(x.error ? { error: x.error } : {}) })) } : {}),
    },
    // What of the user's own is worth a chime meanwhile: their own news still reaches them (lib/pings.ts).
    ownPings: duePings(own),
  };
}
