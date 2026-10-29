import "server-only";
import type { Issue } from "@/lib/orbit-issues";
import { discordRefOf, gmailReply, gmailThreadIdOf, messagesIn, parseDiscordMessages, parseGmailThread, parseSlackMessages, slackFirst, slackMessagesIn, slackRefOf, slackUserIds } from "@/lib/source-parse";
import { SOURCE_NAME, sourceAppOf, sourceError, type ChatThread, type IssueSource, type MailThread, type SourceApp, type SourceCode } from "@/lib/source-view";
import { levelIn, workspaceOf, type AppAccount, type ReplyDraft } from "@/lib/types";
import { accountTitle, runAs } from "./composio";
import { updateIssue } from "./orbit-issues";
import { onRunner } from "./persist";
import { draftOf, MAX_CHARS, sendCall, TOOLKIT } from "./reply-drafts";
import { bot, getState, stateUser } from "./store";

/*
 * The email or thread an issue came from (and a drafted reply's), read live for the issue's page from the
 * user's own connected account, through Composio, when it opens: Gmail's thread (GMAIL_FETCH_MESSAGE_BY_THREAD_ID),
 * Slack's (SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION, with who's who from SLACK_RETRIEVE_DETAILED_USER_INFORMATION
 * and the channel's name from SLACK_RETRIEVE_CONVERSATION_INFORMATION), a Discord channel's through a Discord bot
 * (DISCORDBOT_LIST_MESSAGES, DISCORDBOT_GET_CHANNEL). Every action and its inputs were checked against Composio's
 * own schemas, read only. Nothing of what's read is kept: not in the state, not on disk, not in Orgo; only in this
 * process's memory for a minute (CACHE_MS), for the signed-in user alone, so the page opening again doesn't read it
 * again. The routes ask that the call comes from the Bops window and that no shared workspace is open
 * (app/api/orbit/issues/[id]/source, app/api/drafts/source).
 *
 * An issue keeps the account its thread was read in when the turn that opened it knew (Issue.accountId); else each
 * of the user's accounts in that app is tried, in the issue's workspace first, and the one that has it is kept here
 * for next time. A reply from the page (replyToIssue) goes the way a drafted one does (reply-drafts.ts sendCall), in
 * that thread, from that account, once, and its history says so.
 */

/** How long a read is kept in memory. */
const CACHE_MS = 60_000;
/** How long a read may take before it's said to be down. */
const READ_MS = 25_000;

export type SourceRef = { app: "gmail"; threadId: string } | { app: "slack"; channel: string; ts: string } | { app: "discord"; channel: string; message?: string };
export type SourceFailure = { error: string; code: SourceCode; status: number };
export type SourceRead = { source: IssueSource } | SourceFailure;

const STATUS: Record<SourceCode, number> = { signed_out: 409, no_account: 409, gone: 404, down: 502, unparsed: 422, unsupported: 422, shared: 403, window: 403, runner: 409 };
const failure = (code: SourceCode, app: SourceApp, account?: string): SourceFailure => ({ code, error: sourceError(code, app, account), status: STATUS[code] });

/** Where an issue's thread is, from where it came from, its id there and its link: none for an app Bops can't show, or an id it can't read. */
export function refOfIssue(i: Pick<Issue, "sourceApp" | "externalId" | "url">): SourceRef | { code: "unsupported" | "unparsed"; app?: SourceApp } {
  const app = sourceAppOf(i.sourceApp);
  if (!app) return { code: "unsupported" };
  if (app === "gmail") {
    const threadId = gmailThreadIdOf(i.externalId, i.url);
    return threadId ? { app, threadId } : { code: "unparsed", app };
  }
  if (app === "slack") {
    const { channel, ts } = slackRefOf(i.externalId, i.url);
    return channel && ts ? { app, channel, ts } : { code: "unparsed", app };
  }
  const { channel, message } = discordRefOf(i.externalId, i.url);
  return channel ? { app, channel, ...(message ? { message } : {}) } : { code: "unparsed", app };
}

const refKey = (r: SourceRef) => (r.app === "gmail" ? `gmail:${r.threadId}` : r.app === "slack" ? `slack:${r.channel}:${r.ts}` : `discord:${r.channel}:${r.message ?? ""}`);

/* ---------------- What's kept, in memory only ---------------- */

type Live = { cache: Map<string, { at: number; source: IssueSource }>; found: Map<string, string>; names: Map<string, { at: number; name: string }>; sending: Set<string>; used: Map<string, number> };
const g = globalThis as unknown as { bopsIssueSource?: Live };
const live: Live = (g.bopsIssueSource ??= { cache: new Map(), found: new Map(), names: new Map(), sending: new Set(), used: new Map() });

/** Everything kept is for the signed-in user alone: another sign in has none of it. */
const who = () => stateUser() ?? "";
function cached(key: string) {
  const hit = live.cache.get(`${who()}\n${key}`);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.source;
  if (hit) live.cache.delete(`${who()}\n${key}`);
  return undefined;
}
function keep(key: string, source: IssueSource) {
  if (live.cache.size >= 30) for (const [k, v] of live.cache) if (Date.now() - v.at >= CACHE_MS || live.cache.size >= 30) live.cache.delete(k);
  live.cache.set(`${who()}\n${key}`, { at: Date.now(), source });
}
/** Forget a read (a reply went, so the thread changed). */
const drop = (key: string) => live.cache.delete(`${who()}\n${key}`);

/** For tests: what's kept, and a clean slate. */
export const sourceKeptForTests = { live, clear: () => (live.cache.clear(), live.found.clear(), live.names.clear(), live.sending.clear(), live.used.clear()) };

/* ---------------- Reading, in one account ---------------- */

type Kind = "gone" | "auth" | "down";
class Fail extends Error {
  readonly kind: Kind;
  constructor(kind: Kind, message: string) {
    super(message);
    this.kind = kind;
  }
}
const AUTH = /\b401\b|unauthori[sz]ed|invalid_auth|not_authed|token_revoked|token_expired|invalid_grant|account_inactive|re-?auth|expired|not active|inactive|no active connection/i;
const GONE = /not.?found|\b404\b|no such|does ?n[o']t exist|unknown (?:channel|message)|thread_not_found|channel_not_found|message_not_found|not_in_channel|is_archived|invalid.{0,20}(?:thread|id\b)/i;
const kindOf = (e: unknown): Kind => {
  if (e instanceof Fail) return e.kind;
  const m = String((e as Error)?.message ?? e);
  return AUTH.test(m) ? "auth" : GONE.test(m) ? "gone" : "down";
};

/** One read action in an account, with a time limit; an app's own "not ok" (Slack's ok: false) as the failure it is. */
async function read(accountId: string, action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Fail("down", `${action} took too long`)), READ_MS)));
  try {
    const data = await Promise.race([runAs(accountId, action, args), late]);
    const d = (data ?? {}) as Record<string, unknown>;
    if (d.ok === false) throw new Error(String(d.error ?? `${action} failed`));
    return d;
  } finally {
    clearTimeout(timer);
  }
}

const isEmail = (s?: string) => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const gmailUrl = (u: unknown) => (typeof u === "string" && /^https:\/\/mail\.google\.com\/[^\s"<>]*$/.test(u) ? u : undefined);
const tokenOf = (d: Record<string, unknown>) => {
  const t = d.nextPageToken ?? d.next_page_token ?? (d.response_data as Record<string, unknown> | undefined)?.nextPageToken;
  return typeof t === "string" && t ? t : undefined;
};

async function readGmail(a: AppAccount, threadId: string): Promise<MailThread> {
  const thread = async (id: string) => {
    const pages = [await read(a.id, "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", { thread_id: id, user_id: "me" })];
    // A long thread comes in pages: three more at most.
    for (let n = 0; n < 3 && tokenOf(pages.at(-1)!); n++) pages.push(await read(a.id, "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", { thread_id: id, user_id: "me", page_token: tokenOf(pages.at(-1)!) }));
    return pages;
  };
  let id = threadId;
  let pages: Record<string, unknown>[] | undefined;
  try {
    pages = await thread(id);
  } catch (e) {
    if (kindOf(e) !== "gone") throw e;
  }
  const none = (p?: Record<string, unknown>[]) => !p || !parseGmailThread({ messages: p.flatMap(messagesIn) }).messages.length;
  if (none(pages)) {
    // A message's id, not its thread's (a bot may give either): its thread.
    const m = await read(a.id, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: threadId, user_id: "me", format: "minimal" }).catch((e) => {
      if (kindOf(e) === "gone") return null;
      throw e;
    });
    const other = (m?.threadId ?? (m?.response_data as Record<string, unknown> | undefined)?.threadId) as string | undefined;
    if (typeof other !== "string" || !/^[0-9a-f]{10,24}$/i.test(other) || other === threadId) throw new Fail("gone", "no such thread");
    id = other;
    pages = await thread(id);
    if (none(pages)) throw new Fail("gone", "no such thread");
  }
  const { subject, messages } = parseGmailThread({ messages: pages!.flatMap(messagesIn) }, isEmail(a.name) ? [a.name!] : []);
  return {
    app: "gmail",
    account: { id: a.id, title: accountTitle(a) },
    threadId: id,
    subject,
    messages: messages.slice(-100),
    ...(gmailReply(messages) ? { reply: gmailReply(messages) } : {}),
    ...(gmailUrl(pages![0].display_url) ? { url: gmailUrl(pages![0].display_url) } : {}),
    ...(tokenOf(pages!.at(-1)!) || messages.length > 100 ? { more: true } : {}),
  };
}

/** People's names in a Slack workspace by id, kept in memory for half an hour; a dozen looked up at most each read. */
async function slackNames(a: AppAccount, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ask: string[] = [];
  for (const id of ids) {
    const hit = live.names.get(`${who()}\n${a.id}\n${id}`);
    if (hit && Date.now() - hit.at < 30 * 60_000) out[id] = hit.name;
    else if (ask.length < 12) ask.push(id);
  }
  const got = await Promise.allSettled(ask.map((user) => read(a.id, "SLACK_RETRIEVE_DETAILED_USER_INFORMATION", { user })));
  got.forEach((r, k) => {
    if (r.status !== "fulfilled") return;
    const u = (r.value.user ?? (r.value.response_data as Record<string, unknown> | undefined)?.user) as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
    const name = (u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || "").trim().slice(0, 80);
    if (!name) return;
    out[ask[k]] = name;
    if (live.names.size > 2000) live.names.clear();
    live.names.set(`${who()}\n${a.id}\n${ask[k]}`, { at: Date.now(), name });
  });
  return out;
}

async function readSlack(a: AppAccount, channel: string, ts: string): Promise<ChatThread> {
  let parent = ts;
  let data = await read(a.id, "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", { channel, ts, limit: 200 });
  // The ts of a reply, not of its thread's first message: the thread's.
  const first = slackFirst(data);
  if (first?.thread_ts && first.thread_ts !== ts && slackMessagesIn(data).length <= 1) {
    parent = first.thread_ts;
    data = await read(a.id, "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", { channel, ts: parent, limit: 200 });
  }
  if (!slackMessagesIn(data).length) throw new Fail("gone", "no such thread");
  const [names, info] = await Promise.all([slackNames(a, slackUserIds(data)), read(a.id, "SLACK_RETRIEVE_CONVERSATION_INFORMATION", { channel }).catch(() => null)]);
  const c = (info?.channel ?? (info?.response_data as Record<string, unknown> | undefined)?.channel) as { name?: string; is_im?: boolean; user?: string } | undefined;
  const dm = !!c?.is_im || channel.startsWith("D");
  const dmWith = dm && c?.user ? (await slackNames(a, [c.user]))[c.user] : undefined;
  const messages = parseSlackMessages(data, names);
  return {
    app: "slack",
    account: { id: a.id, title: accountTitle(a) },
    channel: { id: channel, ...(dm ? { dm: true, ...(dmWith ? { name: dmWith } : {}) } : c?.name ? { name: c.name } : {}) },
    thread: parent,
    messages,
    names,
    channels: c?.name && !dm ? { [channel]: c.name } : {},
    ...(data.has_more === true ? { more: true } : {}),
  };
}

async function readDiscord(a: AppAccount, channel: string, message?: string): Promise<ChatThread> {
  const [data, info] = await Promise.all([
    read(a.id, "DISCORDBOT_LIST_MESSAGES", { channel_id: channel, limit: 50, ...(message ? { around: message } : {}) }),
    read(a.id, "DISCORDBOT_GET_CHANNEL", { channel_id: channel }).catch(() => null),
  ]);
  const { messages, names } = parseDiscordMessages(data);
  if (!messages.length) throw new Fail("gone", "no messages");
  const name = typeof info?.name === "string" ? info.name : undefined;
  return { app: "discord", account: { id: a.id, title: accountTitle(a) }, channel: { id: channel, ...(name ? { name } : {}) }, ...(message ? { message } : {}), messages, names, channels: name ? { [channel]: name } : {} };
}

const readIn = (a: AppAccount, r: SourceRef): Promise<IssueSource> =>
  r.app === "gmail" ? readGmail(a, r.threadId) : r.app === "slack" ? readSlack(a, r.channel, r.ts) : readDiscord(a, r.channel, r.message);

/* ---------------- Which account ---------------- */

/**
 * The user's accounts a thread may be in, in the order they're tried: the one it's known to be in (the issue's,
 * or where it was found before), then the issue's workspace's, then the ones its bot may use, the most recently used first.
 */
function accountsFor(app: SourceApp, opts: { prefer?: (string | undefined)[]; ws?: string; botId?: string }): AppAccount[] {
  const all = (getState().accounts ?? []).filter((a) => a.app === TOOLKIT[app] && !a.id.startsWith("open:"));
  const b = opts.botId ? bot(opts.botId) : undefined;
  const prefer = (opts.prefer ?? []).filter(Boolean) as string[];
  const rank = (a: AppAccount) => {
    const p = prefer.indexOf(a.id);
    return [p < 0 ? prefer.length : p, opts.ws && workspaceOf(a) === opts.ws ? 0 : 1, b && levelIn(getState(), b, a) ? 0 : 1, -(a.usedAt ?? a.at ?? 0)];
  };
  const cmp = (x: number[], y: number[]) => x.map((v, k) => v - y[k]).find((d) => d !== 0) ?? 0;
  return all
    .map((a) => ({ a, r: rank(a) }))
    .sort((x, y) => cmp(x.r, y.r))
    .map((x) => x.a);
}

/**
 * The thread read in the user's own account: `only` that one (a drafted reply's), else each that may have it
 * until one does. None of them has it: signed out when one that could is (or said so), down when the app
 * couldn't be reached, else gone.
 */
export async function readSource(ref: SourceRef, opts: { only?: string; prefer?: (string | undefined)[]; ws?: string; botId?: string } = {}): Promise<SourceRead> {
  const found = live.found.get(`${who()}\n${refKey(ref)}`);
  const all = accountsFor(ref.app, { ...opts, prefer: [...(opts.prefer ?? []), found] }).filter((a) => !opts.only || a.id === opts.only);
  if (!all.length) return failure("no_account", ref.app);
  const active = all.filter((a) => a.status === "active");
  if (!active.length) return failure("signed_out", ref.app, all.length === 1 ? accountTitle(all[0]) : undefined);
  let signedOut: AppAccount | undefined;
  for (const a of active) {
    try {
      const source = await readIn(a, ref);
      if (live.found.size > 500) live.found.clear();
      live.found.set(`${who()}\n${refKey(ref)}`, a.id);
      return { source };
    } catch (e) {
      const kind = kindOf(e);
      if (kind === "auth") signedOut ??= a;
      // Composio (or the app) not answering is the same for every account: said at once.
      else if (kind === "down") {
        console.warn(`[source] ${ref.app}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        return failure("down", ref.app);
      }
    }
  }
  const out = signedOut ?? all.find((a) => a.status !== "active");
  if (out) return failure("signed_out", ref.app, all.length > 1 ? accountTitle(out) : undefined);
  return failure("gone", ref.app);
}

/** An issue's thread (from the memory cache when it was read in the last minute, unless `fresh`). */
export async function readIssueSource(ws: string, issue: Issue, opts: { fresh?: boolean } = {}): Promise<SourceRead> {
  const app = sourceAppOf(issue.sourceApp);
  if (onRunner()) return failure("runner", app ?? "gmail");
  const ref = refOfIssue(issue);
  if ("code" in ref) return ref.code === "unsupported" || !ref.app ? { code: "unsupported", error: "Bops can't show where this came from.", status: 422 } : failure(ref.code, ref.app);
  const key = `issue\n${ws}\n${issue.id}\n${refKey(ref)}`;
  const hit = opts.fresh ? undefined : cached(key);
  if (hit) return { source: hit };
  const r = await readSource(ref, { prefer: [issue.accountId], ws, botId: issue.botId });
  if ("source" in r) keep(key, r.source);
  return r;
}

/** A drafted reply's thread, for its card's Show the email: only in the account the draft goes from. */
export async function readDraftSource(messageId: string, draftId: string): Promise<SourceRead> {
  const d = draftOf(messageId, draftId);
  if (!d) return { code: "gone", error: "That reply isn't here anymore.", status: 404 };
  if (onRunner()) return failure("runner", d.app);
  const ref: SourceRef | null =
    d.app === "gmail" && d.threadId ? { app: "gmail", threadId: d.threadId } : d.app === "slack" && d.channel && d.threadTs ? { app: "slack", channel: d.channel, ts: d.threadTs } : d.app === "discord" && d.channel ? { app: "discord", channel: d.channel, ...(d.messageId ? { message: d.messageId } : {}) } : null;
  if (!ref) return failure("unparsed", d.app);
  const key = `draft\n${d.id}\n${refKey(ref)}`;
  const hit = cached(key);
  if (hit) return { source: hit };
  const r = await readSource(ref, { only: d.accountId });
  if ("source" in r) keep(key, r.source);
  return r;
}

/* ---------------- Replying, from the issue's page ---------------- */

export type ReplyResult = { ok: true; sent: { at: number; to: string }; logged: boolean } | { ok: false; status: number; error: string; code?: SourceCode };

const tidy = (e: unknown) => (String((e as Error)?.message ?? e) || "it didn't go").replace(/\s+/g, " ").trim().slice(0, 300);

/** The action that sends a reply in this thread, and its inputs: as a drafted reply's (reply-drafts.ts sendCall), with Reply all's others for an email. */
export function replyCall(s: IssueSource, text: string, all = false): { action: string; args: Record<string, unknown>; to: string } | { error: string } {
  if (s.app === "gmail") {
    if (!s.reply?.to.email) return { error: "Bops can't tell who to reply to here. Reply in Gmail." };
    const c = sendCall({ app: "gmail", threadId: s.threadId, to: s.reply.to.email }, text);
    const to = all ? s.reply.all.to.map((p) => p.email!).filter(Boolean) : [];
    const cc = all ? s.reply.all.cc.map((p) => p.email!).filter(Boolean) : [];
    return { ...c, args: { ...c.args, ...(to.length ? { extra_recipients: to } : {}), ...(cc.length ? { cc } : {}) }, to: [s.reply.to.email, ...to, ...cc].join(", ") };
  }
  const where = s.channel.name ? `${s.channel.dm ? "" : "#"}${s.channel.name}` : s.channel.id;
  const d: Pick<ReplyDraft, "app" | "channel" | "threadTs" | "messageId"> = s.app === "slack" ? { app: "slack", channel: s.channel.id, threadTs: s.thread } : { app: "discord", channel: s.channel.id, messageId: s.message };
  return { ...sendCall(d, text), to: where };
}

/**
 * The user's reply from an issue's page (POST /api/orbit/issues/{id}/source: the Bops window only, never in a
 * shared workspace or on a computer's runner), their own words only: in the thread as it was read for the page
 * (the last minute's read, else read now), from that account, to the newest message's sender that isn't them
 * (with `all`, everyone else on it too). Sent once: `nonce` is the click's, so the same click never sends twice,
 * and one reply at a time per issue. Then its history says "Replied: …" (`logged` false when memory didn't take it).
 */
export async function replyToIssue(ws: string, issue: Issue, text: string, opts: { all?: boolean; nonce: string }): Promise<ReplyResult> {
  if (onRunner()) return { ok: false, status: 409, error: "Reply from Bops on your Mac." };
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(opts.nonce)) return { ok: false, status: 400, error: "Which click was that? Try again." };
  const words = text.trim();
  if (!words) return { ok: false, status: 400, error: "There's nothing to send." };
  for (const [k, at] of live.used) if (Date.now() - at > 30 * 60_000) live.used.delete(k);
  if (live.used.has(opts.nonce)) return { ok: false, status: 409, error: "It was sent already." };
  const lock = `${who()}\n${ws}\n${issue.id}`;
  if (live.sending.has(lock)) return { ok: false, status: 409, error: "A reply is being sent." };
  live.sending.add(lock);
  live.used.set(opts.nonce, Date.now());
  try {
    const got = await readIssueSource(ws, issue);
    if (!("source" in got)) return { ok: false, status: got.status, error: got.error, code: got.code };
    const s = got.source;
    const name = SOURCE_NAME[s.app];
    if (words.length > MAX_CHARS[s.app]) return { ok: false, status: 400, error: `${name} takes ${MAX_CHARS[s.app]} characters at most.` };
    const a = getState().accounts?.find((x) => x.id === s.account.id);
    if (!a) return { ok: false, status: 410, error: `That ${name} account isn't connected anymore. Connect it again in Logins.` };
    if (a.status !== "active") return { ok: false, status: 409, error: sourceError("signed_out", s.app, accountTitle(a)), code: "signed_out" };
    const call = replyCall(s, words, opts.all);
    if ("error" in call) return { ok: false, status: 409, error: call.error };
    try {
      await runAs(a.id, call.action, call.args);
    } catch (e) {
      // Not sent: the same click may go again.
      live.used.delete(opts.nonce);
      return { ok: false, status: 502, error: `${name} didn't take it: ${tidy(e)}` };
    }
    const ref = refOfIssue(issue);
    if (!("code" in ref)) drop(`issue\n${ws}\n${issue.id}\n${refKey(ref)}`);
    const logged = await updateIssue(ws, issue.id, { replied: words })
      .then((x) => !!x)
      .catch((e: Error) => {
        console.warn(`[source] ${issue.id}: the reply went, its history didn't take it: ${e.message}`);
        return false;
      });
    return { ok: true, sent: { at: Date.now(), to: call.to }, logged };
  } finally {
    live.sending.delete(lock);
  }
}
