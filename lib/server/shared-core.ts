import type { SharedWsState, SharedWsUnchanged } from "@/cloud/protocol";
import { duePings } from "@/lib/pings";
import { ownerCall, ownerCredit, ownerVoice, sharedWsId, type SharedOpen, type SharedWorkspace } from "@/lib/shared";
import { pairChatId, workspaceOf, type AppApproval, type AppState, type Bot, type Chat, type Message, type Routine, type Session, type Watch, type Workspace } from "@/lib/types";
import type { RemoteMood } from "./live-core";

/**
 * A workspace shared with the user, open here read only (lib/shared.ts), without the server: what's
 * kept of it (SharedCopy), read from Bops Cloud (GET /v1/ws/<project>/state) through `read`, which
 * lib/server/shared.ts wires to the signed-in key, and the state the window is shown while it's open
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
 * and for a chat whose first older page is on its way (`reading`), they wait for it there. A chat's go
 * when the user may no longer see it, when its newest page is all of it now (nothing older is left there),
 * and when that page has none of the previous one's (more came than a page holds while the copy wasn't
 * reading): messages between may be missing, so "Show earlier messages" reads from the newest again.
 */
function olderKept(was: Copy, now: SharedWsState, reading: Iterable<string>): Map<string, Older> {
  const chats = chatsOf(now);
  const out = new Map<string, Older>();
  const kept = new Map(was.older);
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
    const slid = had.filter((m) => !ids.has(m.id) && !seen.has(m.id) && Number(m.at) <= oldest);
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
    this.changed();
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
    this.changed();
    this.onGone(was.open);
  }

  /** Leave it (the user switched away, or signed out): the copy goes. */
  close() {
    if (!this.copy) return;
    this.copy = null;
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
export function viewState(own: AppState, open: SharedOpen, data: SharedWsState, moods: Record<string, RemoteMood>): AppState {
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
  const sessions = s.sessions.map((x) => {
    const t = { steps: [], replies: [], host: "orgo", ...x } as unknown as Session;
    return {
      ...t,
      ...(typeof t.title === "string" ? { title: onTheirMac(t.title) } : {}),
      ...(typeof t.error === "string" ? { error: ownerVoice(t.error) } : {}),
      replies: (Array.isArray(t.replies) ? t.replies : []).map((r) => (typeof r.note === "string" ? { ...r, note: ownerVoice(r.note) } : r)),
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
    // What the shared one's bots wait on the owner's OK for: shown, never answered here (the owner's alone,
    // from a Bops of their own: this Bops has none of their asks to answer). None of the user's own.
    appApprovals: ((s.approvals ?? []) as unknown as AppApproval[]).filter((a) => ids.has(a.botId) && !a.reply),
    digest: [],
    takeover: undefined,
    suggest: undefined,
    screens: undefined,
    screenLog: undefined,
    liveMoods: Object.keys(moods).some((id) => ids.has(id)) ? Object.fromEntries(Object.entries(moods).filter(([id]) => ids.has(id))) : undefined,
    shared: { ...open, ownBots, more: data.more },
    // What of the user's own is worth a chime meanwhile: their own news still reaches them (lib/pings.ts).
    ownPings: duePings(own),
  };
}
