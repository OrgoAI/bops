import "server-only";
import { randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { SlackLinkIn, SlackLinksBody, SlackLinksResult } from "@/cloud/protocol";
import { pictureName } from "@/lib/mascot";
import { botChatId, pairCodeLive, PAIR_CODE_MS, type Bot, type ChannelKind, type ChannelLink, type ChannelPlace, type Message } from "@/lib/types";
import { cloudJson, cloudOn, cloudSession, cloudSessionNow } from "./cloud";
import { deleteSecret, getSecret, setSecret } from "./keychain";
import { composio, composioUser, publicUrl, runAs } from "./composio";
import { addMessage, bot, getState, id, ownerName, patchSession, update, watchChanges } from "./store";
import { saveUpload } from "./uploads";

/**
 * Bots where the user's team already talks: Slack channels, Telegram and Discord. Like texting a bot's
 * number, a message there is the user talking to the bot: it shows in the bot's chat in Bops, and the
 * answer (and later, the result of work it started) goes back to the same place.
 *
 * - Telegram and Discord: each bot gets its own bot account there, which the user makes (BotFather,
 *   Discord's developer portal) and pastes the token of. So it shows up as "Boppy", with its own name.
 *   Its token lives in the Keychain. Bops talks to them directly: Telegram by long polling, Discord over
 *   its gateway. Neither needs Bops to be reachable from the internet.
 * - Slack: Bops' own Slack app (slack/manifest.json), connected as a Composio account (the "slackbot"
 *   app, in the Vault), and the channels each bot is in. Its events come to Bops Cloud, which passes
 *   this Mac the ones for its bots over the tunnel, or keeps them a day while it's away; this Mac
 *   tells the cloud where its bots are (PUT /v1/slack/links: syncSlackLinks, below). Self-hosted, the
 *   self-hoster's own Slack app sends them to their front door (edge/, BOPS_SLACK_SIGNING_SECRET), or
 *   without one Composio's Slack app sends them over a live connection (triggers.subscribe).
 *
 * Bots take requests only from the user, as on the phone: the first time, the user sends the bot its
 * pairing code there, and from then on only that account counts as them. Only the code itself pairs
 * (the whole message), only while nobody is paired, and only while it's fresh: an hour, and fewer than
 * five wrong codes (pairCodeLive in lib/types.ts); then the user gets a new one in Bops. In a group or
 * channel the bot answers when it's mentioned or replied to; everyone else's messages are left alone.
 */

type Live = {
  telegram: Map<string, AbortController>;
  discord: Map<string, { ws?: WebSocket; beat?: ReturnType<typeof setInterval>; stop: boolean; seq: number | null }>;
  slack?: boolean;
  /** Telling Bops Cloud where the bots are in Slack: what it last took, the next try, one at a time. */
  slackLinks?: { sent?: string; chain: Promise<unknown>; failures: number; retryAt?: number; timer?: ReturnType<typeof setTimeout>; soon?: ReturnType<typeof setTimeout> };
  /** Who's been told the bot only takes requests from its owner, so they're told once. */
  toldOff: Set<string>;
  /** Slack threads a bot answered in: a reply there is to the bot, without mentioning it again. */
  slackThreads: Set<string>;
  seen: Set<string>;
};
const g = globalThis as unknown as { bopsChannels?: Live };
const live: Live = (g.bopsChannels ??= { telegram: new Map(), discord: new Map(), toldOff: new Set(), slackThreads: new Set(), seen: new Set() });

const secretOf = (linkId: string) => `channel:${linkId}`;
const linkOf = (linkId: string) => getState().channels?.find((l) => l.id === linkId);
const linksOf = (kind: ChannelKind) => (getState().channels ?? []).filter((l) => l.kind === kind);
const newCode = () => String(randomInt(100000, 1000000));
/** A new pairing code, its clock started and no wrong codes yet. */
const freshCode = () => ({ pairCode: newCode(), pairCodeAt: Date.now(), pairTries: 0 });
const patchLink = (linkId: string, patch: Partial<ChannelLink>) =>
  update((s) => {
    const l = s.channels?.find((x) => x.id === linkId);
    if (l) Object.assign(l, patch);
  });

function addLink(link: Omit<ChannelLink, "id" | "pairCode" | "status" | "at">) {
  const made: ChannelLink = { ...link, id: id("ch"), ...freshCode(), status: "live", at: Date.now() };
  update((s) => (s.channels ??= []).push(made));
  return made;
}

/** Take a bot out of a channel (its Telegram or Discord bot stops listening; its token leaves the Keychain). */
export async function removeLink(linkId: string) {
  const l = linkOf(linkId);
  if (!l) return;
  live.telegram.get(linkId)?.abort();
  live.telegram.delete(linkId);
  const d = live.discord.get(linkId);
  if (d) {
    d.stop = true;
    if (d.beat) clearInterval(d.beat);
    d.ws?.close();
    live.discord.delete(linkId);
  }
  if (l.kind !== "slack") await deleteSecret(secretOf(linkId));
  update((s) => void (s.channels = (s.channels ?? []).filter((x) => x.id !== linkId)));
}

/**
 * A fresh pairing code (and forget who was paired), for when the wrong account paired, the user changed
 * accounts, or the code ran out (an hour, or too many wrong codes).
 */
export function repair(linkId: string) {
  update((s) => {
    const l = s.channels?.find((x) => x.id === linkId);
    if (!l) return;
    Object.assign(l, freshCode(), { owner: undefined, ownerName: undefined });
    // Slack: the direct message was with whoever paired; the next person's is their own.
    if (l.slack) l.slack = { ...l.slack, dm: undefined };
  });
}

/** Start every channel's listener. Safe to call again: running ones are left alone. */
export function startChannels() {
  for (const l of linksOf("telegram")) if (!live.telegram.has(l.id)) void pollTelegram(l.id);
  for (const l of linksOf("discord")) if (!live.discord.has(l.id)) void connectDiscord(l.id);
  // Signed in with Orgo, Slack's events come through Bops Cloud (which never passes Composio's live
  // trigger feed on): it hears where the bots are instead.
  if (cloudOn()) void syncSlackLinks().catch(() => {});
  else if (linksOf("slack").length && !ownSlackApp()) void listenSlack();
}

/**
 * Bops' own Slack app is set up, so its events come straight to Bops: signed in with Orgo, Bops
 * Cloud takes them for it (CloudSession.slack: at Orgo, the "Bops" app); self-hosted, the
 * self-hoster's own app (slack/setup.mjs), signed with BOPS_SLACK_SIGNING_SECRET.
 */
export const ownSlackApp = () => (cloudOn() ? !!cloudSessionNow()?.slack : !!process.env.BOPS_SLACK_SIGNING_SECRET);

/* ---------------- A message in ---------------- */

type Incoming = {
  /** The chat or channel there, the message, and the thread it's in (Slack). */
  chat: string;
  messageId: string;
  thread?: string;
  fromId: string;
  fromName: string;
  text: string;
  /** A one-to-one chat with the bot, not a group or channel. */
  direct: boolean;
  /** Mentioned, or replied to, in a group or channel. */
  mentioned: boolean;
  imageUrls?: { url: string; type?: string; headers?: Record<string, string> }[];
};

/** A message that's a code and nothing else (digits, spaces allowed: "123 456"), as the code. */
const codeIn = (text: string) => {
  const t = text.replace(/\s+/g, "");
  return /^\d{4,10}$/.test(t) ? t : null;
};
const sameCode = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The link whose live pairing code this message is (only the code, sent directly or with a mention), if any. */
export const codeFor = (links: ChannelLink[], text: string) => {
  const code = codeIn(text);
  return code ? links.find((l) => pairCodeLive(l) && sameCode(code, l.pairCode)) : undefined;
};

/**
 * Someone wrote to the bot: pairing, the user (who it answers), or someone else (left alone).
 * `pool`: the links a code may be for (Slack's bots share one app, so a code there may be any of
 * theirs); Telegram and Discord bots have accounts of their own, so only this link's.
 */
async function messageIn(linkId: string, m: Incoming, pool?: ChannelLink[]) {
  const l = linkOf(linkId);
  const b = l && bot(l.botId);
  if (!l || !b) return;
  const key = `${linkId}:${m.chat}:${m.messageId}`;
  if (live.seen.has(key)) return;
  live.seen.add(key);

  // Pairing: the code proves it's the user. Until then, the code is all the bot answers.
  if (m.direct || m.mentioned) {
    const candidates = (pool ?? [l]).map((x) => linkOf(x.id)).filter((x): x is ChannelLink => !!x);
    const match = codeFor(candidates, m.text);
    if (match) return paired(match, m);
    // A wrong code, from someone not paired here: it counts against every code it could have been.
    const open = candidates.filter((x) => !x.owner);
    if (codeIn(m.text) && open.length && !candidates.some((x) => x.owner === m.fromId)) wrongCode(open.map((x) => x.id));
  }
  const place: ChannelPlace = { linkId, chat: m.chat, messageId: m.messageId, thread: m.thread, from: m.fromId };
  if (!l.owner || m.fromId !== l.owner) {
    if (!m.direct) return;
    const told = `${linkId}:${m.fromId}`;
    if (live.toldOff.has(told)) return;
    live.toldOff.add(told);
    await send(
      l,
      place,
      l.owner
        ? `Hi, I'm ${b.name}, ${ownerName()}'s assistant. I only take requests from ${ownerName()}.`
        : `Hi, I'm ${b.name}. To pair with me, send me the code shown in Bops (on my profile, under "Where to find ${b.name}"), and nothing else.`,
    );
    return;
  }
  // Slack: the direct message with the person paired, once they write there (they may have paired in a channel).
  if (l.slack && m.direct && l.slack.dm !== m.chat) patchLink(l.id, { slack: { ...l.slack, dm: m.chat } });
  if (!m.direct && !m.mentioned) return;
  const text = m.text.trim();
  if (!text && !m.imageUrls?.length) return;

  const images = await picsOf(m.imageUrls ?? []);
  const chatId = botChatId(b.id);
  const { handleMessage } = await import("./chat");
  const stopTyping = typing(l, m.chat);
  let mine: Awaited<ReturnType<typeof handleMessage>>;
  try {
    mine = await handleMessage(chatId, text || "(a picture)", undefined, images.length ? images : undefined, l.kind, undefined, place);
  } finally {
    stopTyping();
  }
  if (!mine) return;
  // Work it started (its own threads, or a teammate's it handed off) reports back here too.
  for (const t of getState().sessions.filter((x) => x.chatId === chatId && x.createdAt >= mine.at && !x.channelBack && !x.textBack)) patchSession(t.id, { channelBack: place });
  const replies = getState().messages.filter((x) => x.chatId === chatId && x.role === "bot" && x.botId === b.id && x.at >= mine.at);
  const failed = (err: Error) => addMessage({ chatId, role: "system", text: `Couldn't send this back to ${KIND_NAME[l.kind]}: ${err.message}` });
  for (const r of replies) await send(l, place, r.text).catch(failed);
  if (!replies.length) {
    const tapback = getState().messages.find((x) => x.id === mine.id)?.reactions?.find((x) => x.by === b.id);
    await (tapback ? react(l, place, tapback.emoji ?? TAPBACK_EMOJI[tapback.type ?? "like"] ?? "👍") : send(l, place, "Got it.")).catch(failed);
  }
}

/** The right code: that account is the user's there from now on (Slack: and the direct message it came in, theirs). */
async function paired(l: ChannelLink, m: Incoming) {
  const b = bot(l.botId);
  if (!b) return;
  update((s) => {
    const x = s.channels?.find((y) => y.id === l.id);
    if (!x) return;
    // The code is used up; the next one is made when the user asks to pair again.
    Object.assign(x, { owner: m.fromId, ownerName: m.fromName }, freshCode());
    if (x.slack && m.direct) x.slack = { ...x.slack, dm: m.chat };
  });
  live.toldOff.delete(`${l.id}:${m.fromId}`);
  addMessage({ chatId: botChatId(b.id), role: "system", text: `${b.name} is paired with ${m.fromName} on ${KIND_NAME[l.kind]}. It takes requests from that account there now.` });
  const place: ChannelPlace = { linkId: l.id, chat: m.chat, messageId: m.messageId, thread: m.thread, from: m.fromId };
  await send(linkOf(l.id) ?? l, place, `Hi ${m.fromName.split(" ")[0]}, it's ${b.name}. We're paired: talk to me here like you do in Bops.${m.direct ? "" : " In a group, mention me or reply to me."}`);
}

/** A wrong code: counted on each link it could have been for (PAIR_CODE_TRIES of them and the code stops working). */
function wrongCode(linkIds: string[]) {
  update((s) => {
    for (const x of s.channels ?? []) if (linkIds.includes(x.id) && !x.owner) x.pairTries = (x.pairTries ?? 0) + 1;
  });
}

const KIND_NAME: Record<ChannelKind, string> = { slack: "Slack", telegram: "Telegram", discord: "Discord" };
const TAPBACK_EMOJI: Record<string, string> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };

/* ---------------- Each bot as itself ---------------- */

/**
 * A bot's picture (its mascot, as drawn in Bops), from the set rendered ahead of time (pictureName in
 * lib/mascot.ts), at Bops' public address: Bops Cloud's, or a self-hoster's front door (edge/). A
 * color without a picture gets the Bops logo.
 */
export const mascotUrl = (b: Bot) => {
  const name = pictureName(b);
  return name ? `${publicUrl()}/mascot/${name}.png` : `${publicUrl()}/brand/bops-512.png`;
};

/**
 * One of those pictures as a file ("mascot/blob-2EC4B6.jpg"), for Telegram's and Discord's profile
 * pictures: from edge/public when this checkout has it (the Mac app doesn't ship edge/), else from the
 * public address that serves it. Null when neither has it: the bot keeps the service's own picture.
 */
async function pictureFile(path: string): Promise<Buffer | null> {
  try {
    const local = `${process.cwd()}/edge/public/${path}`;
    if (existsSync(local)) return readFileSync(local);
    const res = await fetch(`${publicUrl()}/${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok || !/^image\//.test(res.headers.get("content-type") ?? "")) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Telegram: the bot account takes the bot's name and picture (best effort: the link works without). */
async function dressTelegram(token: string, b: Bot) {
  await tg(token, "setMyName", { name: b.name }).catch(() => {});
  await tg(token, "setMyShortDescription", { short_description: `${b.name}, ${ownerName()}'s assistant on Bops.` }).catch(() => {});
  // Telegram takes a JPEG; the logo has none, so a bot without a picture keeps Telegram's.
  const name = pictureName(b);
  const pic = name ? await pictureFile(`mascot/${name}.jpg`) : null;
  if (!pic) return;
  const form = new FormData();
  form.set("photo", JSON.stringify({ type: "static", photo: "attach://pic" }));
  form.set("pic", new Blob([new Uint8Array(pic)], { type: "image/jpeg" }), "mascot.jpg");
  await fetch(`${TELEGRAM()}/bot${token}/setMyProfilePhoto`, { method: "POST", body: form }).catch(() => {});
}

/** Discord: the bot user takes the bot's name and picture. Discord limits name changes, so the picture goes on its own if the name can't. */
async function dressDiscord(token: string, b: Bot) {
  const name = pictureName(b);
  const pic = await pictureFile(name ? `mascot/${name}.png` : "brand/bops-512.png");
  if (!pic) return void (await dc(token, "PATCH", "/users/@me", { username: b.name }).catch(() => {}));
  const avatar = `data:image/png;base64,${pic.toString("base64")}`;
  await dc(token, "PATCH", "/users/@me", { username: b.name, avatar }).catch(() => dc(token, "PATCH", "/users/@me", { avatar }).catch(() => {}));
}

/** A bot was renamed in Bops: its Telegram and Discord accounts follow. */
export async function renameInChannels(botId: string) {
  const b = bot(botId);
  if (!b) return;
  for (const l of (getState().channels ?? []).filter((x) => x.botId === botId)) {
    const token = l.kind === "slack" ? null : await getSecret(secretOf(l.id));
    if (!token) continue;
    if (l.kind === "telegram") await tg(token, "setMyName", { name: b.name }).catch(() => {});
    if (l.kind === "discord") {
      await dc(token, "PATCH", "/users/@me", { username: b.name }).catch(() => {});
      patchLink(l.id, { handle: b.name });
    }
  }
}

/** Slack apps that can't post under another name (Composio's own app lacks chat:write.customize). */
const plainSlack = new Set<string>();

/**
 * A Slack message from the bot, as itself: its name and mascot on the message, through our own
 * Slack app (it has chat:write.customize). Composio's shared app can't, so there the bot's name
 * leads the message when more than one bot shares the app.
 */
async function slackPost(l: ChannelLink, channel: string, text: string, thread?: string) {
  const b = bot(l.botId);
  const accountId = l.slack!.accountId;
  if (b && !plainSlack.has(accountId)) {
    const r = (await composio()
      .tools.proxyExecute({
        endpoint: "/chat.postMessage",
        method: "POST",
        connectedAccountId: accountId,
        body: { channel, markdown_text: text, username: b.name, icon_url: mascotUrl(b), ...(thread ? { thread_ts: thread } : {}) },
      })
      .catch((e: Error) => ({ data: { ok: false, error: e.message } }))) as unknown as { data?: { ok?: boolean; error?: string } };
    if (r.data?.ok) return;
    if (!/missing_scope|not_allowed_token_type|invalid_arguments/.test(r.data?.error ?? "")) throw new Error(`Slack: ${r.data?.error ?? "couldn't post"}`);
    plainSlack.add(accountId);
  }
  const shared = linksOf("slack").filter((x) => x.slack?.accountId === accountId).length > 1;
  await runAs(accountId, "SLACKBOT_SEND_MESSAGE", { channel, markdown_text: shared && b ? `*${b.name}:* ${text}` : text, ...(thread ? { thread_ts: thread } : {}) });
}

/**
 * A thread started from a channel finished (or failed): its result goes back there, naming the bot
 * that did it when it wasn't the one asked.
 */
export function channelResult(s: { channelBack?: ChannelPlace; botId: string }, text: string) {
  const l = s.channelBack && linkOf(s.channelBack.linkId);
  if (!l || !s.channelBack) return;
  const by = s.botId !== l.botId ? bot(s.botId)?.name : undefined;
  void send(l, s.channelBack, by ? `${by}: ${text}` : text).catch((err: Error) =>
    addMessage({ chatId: botChatId(l.botId), role: "system", text: `Couldn't post this result to ${KIND_NAME[l.kind]}: ${err.message}` }),
  );
}

/** Images sent with a message, saved like attachments (the bot sees them; at most 4). */
async function picsOf(urls: NonNullable<Incoming["imageUrls"]>) {
  const out: NonNullable<Message["images"]> = [];
  for (const u of urls.slice(0, 4)) {
    try {
      const res = await fetch(u.url, { headers: u.headers });
      let type = (res.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
      if (!/^image\//.test(type)) type = u.type ?? (/\.png$/i.test(u.url) ? "image/png" : /\.webp$/i.test(u.url) ? "image/webp" : "image/jpeg");
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) continue;
      out.push(saveUpload(`data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`));
    } catch {}
  }
  return out;
}

/** Split a long answer at paragraph or line breaks, under the service's limit. */
function chunks(text: string, max: number) {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf("\n\n", max), rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Post the bot's words there: in a group, as a reply to what it's answering (Slack: in its thread). */
async function send(l: ChannelLink, p: ChannelPlace, text: string) {
  if (l.kind === "telegram") {
    const token = await tokenOf(l);
    for (const [i, part] of chunks(text, 4000).entries())
      await tg(token, "sendMessage", { chat_id: p.chat, text: part, ...(i === 0 && p.messageId && !isDirectChat(p.chat) ? { reply_parameters: { message_id: Number(p.messageId), allow_sending_without_reply: true } } : {}) });
  } else if (l.kind === "discord") {
    const token = await tokenOf(l);
    for (const [i, part] of chunks(text, 1900).entries())
      await dc(token, "POST", `/channels/${p.chat}/messages`, { content: part, allowed_mentions: { parse: [] }, ...(i === 0 && p.messageId && p.thread !== "dm" ? { message_reference: { message_id: p.messageId, fail_if_not_exists: false } } : {}) });
  } else {
    const thread = p.thread ?? (p.chat.startsWith("D") ? undefined : p.messageId);
    if (thread) live.slackThreads.add(`${p.chat}:${thread}`);
    for (const part of chunks(text, 3500)) await slackPost(l, p.chat, part, thread);
  }
}

/** A tapback, as the service's own reaction. */
async function react(l: ChannelLink, p: ChannelPlace, emoji: string) {
  if (!p.messageId) return;
  if (l.kind === "telegram") {
    const ok = ["👍", "❤", "👎", "😁", "🤔", "🔥", "🙏", "👌"];
    const e = emoji.replace("❤️", "❤").replace("😂", "😁").replace("❓", "🤔").replace("‼️", "🔥");
    await tg(await tokenOf(l), "setMessageReaction", { chat_id: p.chat, message_id: Number(p.messageId), reaction: [{ type: "emoji", emoji: ok.includes(e) ? e : "👍" }] });
  } else if (l.kind === "discord") {
    await dc(await tokenOf(l), "PUT", `/channels/${p.chat}/messages/${p.messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  } else {
    const name: Record<string, string> = { "❤️": "heart", "👍": "+1", "👎": "-1", "😂": "joy", "‼️": "bangbang", "❓": "question" };
    await runAs(l.slack!.accountId, "SLACKBOT_ADD_REACTION_TO_AN_ITEM", { channel: p.chat, timestamp: p.messageId, name: name[emoji] ?? "+1" });
  }
}

/** "Typing…" there while the bot works on its answer (Slack has none for apps). */
function typing(l: ChannelLink, chat: string) {
  if (l.kind === "slack") return () => {};
  const beat = async () => {
    const token = await tokenOf(l).catch(() => null);
    if (!token) return;
    if (l.kind === "telegram") await tg(token, "sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    else await dc(token, "POST", `/channels/${chat}/typing`).catch(() => {});
  };
  void beat();
  const t = setInterval(() => void beat(), l.kind === "telegram" ? 4500 : 8000);
  return () => clearInterval(t);
}

async function tokenOf(l: ChannelLink) {
  const t = await getSecret(secretOf(l.id));
  if (!t) throw new Error(`${KIND_NAME[l.kind]} token is missing from the Keychain`);
  return t;
}

/* ---------------- Telegram ---------------- */

const isDirectChat = (chat: string) => !chat.startsWith("-");

/** Telegram's Bot API (BOPS_TELEGRAM_API points elsewhere: a proxy, or a stand-in for tests). */
const TELEGRAM = () => process.env.BOPS_TELEGRAM_API || "https://api.telegram.org";

async function tg<T = unknown>(token: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${TELEGRAM()}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
  if (!j.ok) throw Object.assign(new Error(j.description ?? `Telegram ${method} failed (${res.status})`), { code: j.error_code ?? res.status });
  return j.result as T;
}

/** Add a bot to Telegram: the token of a bot the user made with @BotFather. */
export async function linkTelegram(botId: string, token: string) {
  const b = bot(botId);
  if (!b) throw new Error("No such bot");
  const t = token.trim();
  if (!/^\d{5,}:[\w-]{30,}$/.test(t)) throw new Error("That doesn't look like a bot token. BotFather sends one like 123456789:AAH…");
  const me = await tg<{ id: number; username: string; is_bot: boolean }>(t, "getMe").catch((e: Error) => {
    throw new Error(/unauthorized/i.test(e.message) ? "Telegram says that token isn't valid. Copy it again from BotFather." : e.message);
  });
  const taken = linksOf("telegram").find((l) => l.telegram?.userId === me.id);
  if (taken) throw new Error(`@${me.username} is already ${bot(taken.botId)?.name ?? "another bot"}'s`);
  for (const l of linksOf("telegram").filter((x) => x.botId === botId)) await removeLink(l.id);
  // Long polling and a webhook can't both be on; and its profile says whose it is.
  await tg(t, "deleteWebhook", { drop_pending_updates: false }).catch(() => {});
  await dressTelegram(t, b);
  const made = addLink({ kind: "telegram", botId, handle: `@${me.username}`, telegram: { userId: me.id, username: me.username } });
  await setSecret(secretOf(made.id), t);
  void pollTelegram(made.id);
  return made;
}

type TgMessage = {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number }[];
  entities?: { type: string; offset: number; length: number; user?: { id: number } }[];
  caption_entities?: { type: string; offset: number; length: number }[];
  reply_to_message?: { from?: { id: number } };
};

async function pollTelegram(linkId: string) {
  const ctl = new AbortController();
  live.telegram.set(linkId, ctl);
  let offset = 0;
  let wait = 0;
  while (!ctl.signal.aborted && linkOf(linkId)) {
    const l = linkOf(linkId)!;
    try {
      const token = await tokenOf(l);
      const updates = await tg<{ update_id: number; message?: TgMessage }[]>(token, "getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, ctl.signal);
      if (l.status !== "live") patchLink(linkId, { status: "live", error: undefined });
      wait = 0;
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) void telegramIn(linkId, token, u.message).catch((e: Error) => console.warn(`[telegram] ${e.message}`));
      }
    } catch (e) {
      if (ctl.signal.aborted) break;
      const code = (e as { code?: number }).code;
      if (code === 401 || code === 404) {
        patchLink(linkId, { status: "error", error: "Telegram stopped accepting the token (it was revoked in BotFather?). Add the bot again with a new token." });
        break;
      }
      // 409: another Bops (or app) is reading this bot's messages. Back off and try again.
      wait = Math.min(60_000, (wait || 2000) * 2);
      if (code === 409) patchLink(linkId, { status: "error", error: "Something else is reading this bot's messages (another Bops?)." });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (live.telegram.get(linkId) === ctl) live.telegram.delete(linkId);
}

async function telegramIn(linkId: string, token: string, m: TgMessage) {
  const l = linkOf(linkId);
  if (!l?.telegram || !m.from || m.from.is_bot) return;
  const raw = m.text ?? m.caption ?? "";
  const handle = `@${l.telegram.username}`;
  const mentioned = raw.toLowerCase().includes(handle.toLowerCase()) || m.reply_to_message?.from?.id === l.telegram.userId;
  // Pairing from the t.me link arrives as "/start 123456"; strip the bot's handle and commands' own syntax.
  const text = raw.replace(new RegExp(handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "").replace(/^\/start\b/, "").trim();
  const photo = m.photo?.length ? m.photo[m.photo.length - 1] : undefined;
  let imageUrls: Incoming["imageUrls"];
  if (photo) {
    const f = await tg<{ file_path?: string }>(token, "getFile", { file_id: photo.file_id }).catch(() => null);
    if (f?.file_path) imageUrls = [{ url: `${TELEGRAM()}/file/bot${token}/${f.file_path}` }];
  }
  await messageIn(linkId, {
    chat: String(m.chat.id),
    messageId: String(m.message_id),
    fromId: String(m.from.id),
    fromName: [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "you",
    text,
    direct: m.chat.type === "private",
    mentioned,
    imageUrls,
  });
}

/* ---------------- Discord ---------------- */

/** Discord's API (BOPS_DISCORD_API points elsewhere: a proxy, or a stand-in for tests). */
const DISCORD = () => process.env.BOPS_DISCORD_API || "https://discord.com/api/v10";

async function dc<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DISCORD()}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://bops.bot, 1)" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const j = (await res.json().catch(() => ({}))) as T & { message?: string; retry_after?: number };
  if (res.status === 429 && j.retry_after) {
    await new Promise((r) => setTimeout(r, Math.ceil(j.retry_after! * 1000)));
    return dc(token, method, path, body);
  }
  if (!res.ok) throw Object.assign(new Error(j.message ?? `Discord ${method} ${path} failed (${res.status})`), { code: res.status });
  return j;
}

/** What a bot needs in a server: see channels, read history, send (and in threads), react, embed links, attach files. */
const DISCORD_PERMISSIONS = String(2 ** 10 + 2 ** 11 + 2 ** 16 + 2 ** 6 + 2 ** 14 + 2 ** 15 + 2 ** 38);
export const discordInvite = (appId: string) => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${DISCORD_PERMISSIONS}`;

/** Add a bot to Discord: the token of a bot application the user made in Discord's developer portal. */
export async function linkDiscord(botId: string, token: string) {
  const b = bot(botId);
  if (!b) throw new Error("No such bot");
  const t = token.trim().replace(/^Bot\s+/i, "");
  if (t.length < 50) throw new Error("That doesn't look like a bot token. In the developer portal: your app → Bot → Reset Token, then copy it.");
  const me = await dc<{ id: string; username: string; bot?: boolean }>(t, "GET", "/users/@me").catch((e: Error & { code?: number }) => {
    throw new Error(e.code === 401 ? "Discord says that token isn't valid. Reset it in the developer portal and copy the new one." : e.message);
  });
  const app = await dc<{ id: string; flags?: number }>(t, "GET", "/oauth2/applications/@me");
  // Without the Message Content intent, the bot sees that a message came but not what it says.
  if (!((app.flags ?? 0) & ((1 << 18) | (1 << 19))))
    throw new Error("Turn on Message Content Intent first: developer portal → your app → Bot → Privileged Gateway Intents. Then try again.");
  const taken = linksOf("discord").find((l) => l.discord?.userId === me.id);
  if (taken) throw new Error(`${me.username} is already ${bot(taken.botId)?.name ?? "another bot"}'s`);
  for (const l of linksOf("discord").filter((x) => x.botId === botId)) await removeLink(l.id);
  await dressDiscord(t, b);
  const made = addLink({ kind: "discord", botId, handle: b.name, discord: { userId: me.id, appId: app.id, username: me.username } });
  await setSecret(secretOf(made.id), t);
  void connectDiscord(made.id);
  return made;
}

/** The gateway: identify, keep the heartbeat, and take MESSAGE_CREATE. Reconnects on its own. */
async function connectDiscord(linkId: string, attempt = 0) {
  const l = linkOf(linkId);
  if (!l?.discord) return;
  const state = live.discord.get(linkId) ?? { stop: false, seq: null };
  live.discord.set(linkId, state);
  if (state.stop) return;
  let token: string;
  try {
    token = await tokenOf(l);
  } catch (e) {
    patchLink(linkId, { status: "error", error: (e as Error).message });
    return;
  }
  const again = (why?: string, fatal = false) => {
    if (state.beat) clearInterval(state.beat);
    state.ws = undefined;
    if (fatal || state.stop || !linkOf(linkId)) {
      if (fatal) patchLink(linkId, { status: "error", error: why });
      return;
    }
    setTimeout(() => void connectDiscord(linkId, attempt + 1), Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
  };
  let url = "wss://gateway.discord.gg";
  try {
    url = (await dc<{ url: string }>(token, "GET", "/gateway/bot")).url;
  } catch (e) {
    if ((e as { code?: number }).code === 401) return again("Discord stopped accepting the token. Add the bot again with a new one.", true);
  }
  const ws = new WebSocket(`${url}/?v=10&encoding=json`);
  state.ws = ws;
  const sendWs = (op: number, d: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op, d }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { op: number; d: unknown; s: number | null; t: string | null };
    if (msg.s !== null) state.seq = msg.s;
    if (msg.op === 10) {
      const interval = (msg.d as { heartbeat_interval: number }).heartbeat_interval;
      setTimeout(() => sendWs(1, state.seq), Math.random() * interval);
      state.beat = setInterval(() => sendWs(1, state.seq), interval);
      // Guilds, guild messages, direct messages, message content.
      sendWs(2, { token, intents: 1 | (1 << 9) | (1 << 12) | (1 << 15), properties: { os: "macos", browser: "bops", device: "bops" } });
    } else if (msg.op === 1) sendWs(1, state.seq);
    else if (msg.op === 7 || msg.op === 9) ws.close(4900);
    else if (msg.op === 0 && msg.t === "READY") {
      attempt = 0;
      patchLink(linkId, { status: "live", error: undefined });
    } else if (msg.op === 0 && msg.t === "MESSAGE_CREATE") void discordIn(linkId, token, msg.d as DcMessage).catch((e: Error) => console.warn(`[discord] ${e.message}`));
  };
  ws.onclose = (ev) => {
    if (ev.code === 4004) return again("Discord stopped accepting the token. Add the bot again with a new one.", true);
    if (ev.code === 4014) return again("Turn on Message Content Intent in Discord's developer portal (your app → Bot), then add the bot again.", true);
    again();
  };
  ws.onerror = () => {};
}

type DcMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  content: string;
  mentions?: { id: string }[];
  referenced_message?: { author?: { id: string } } | null;
  attachments?: { url: string; content_type?: string }[];
};

async function discordIn(linkId: string, token: string, m: DcMessage) {
  const l = linkOf(linkId);
  if (!l?.discord || m.author.bot) return;
  const me = l.discord.userId;
  const mentioned = !!m.mentions?.some((x) => x.id === me) || m.referenced_message?.author?.id === me;
  const text = m.content.replace(new RegExp(`<@!?${me}>`, "g"), "").trim();
  await messageIn(linkId, {
    chat: m.channel_id,
    messageId: m.id,
    // Direct messages answer without quoting; "dm" marks them for send().
    thread: m.guild_id ? undefined : "dm",
    fromId: m.author.id,
    fromName: m.author.global_name || m.author.username,
    text,
    direct: !m.guild_id,
    mentioned,
    imageUrls: (m.attachments ?? []).filter((a) => /^image\//.test(a.content_type ?? "")).map((a) => ({ url: a.url, type: a.content_type })),
  });
  void token;
}

/* ---------------- Slack (through Composio) ---------------- */

/** Slack channels the Slack app can see, for picking where a bot goes. */
export async function slackChannels(accountId: string) {
  const out: { id: string; name: string; private: boolean; member: boolean }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = (await runAs(accountId, "SLACKBOT_LIST_ALL_CHANNELS", { limit: 200, exclude_archived: true, types: "public_channel,private_channel", ...(cursor ? { cursor } : {}) })) as {
      channels?: { id: string; name: string; is_private?: boolean; is_member?: boolean }[];
      response_metadata?: { next_cursor?: string };
    };
    for (const c of r.channels ?? []) out.push({ id: c.id, name: c.name, private: !!c.is_private, member: !!c.is_member });
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Who the Slack app is there (its workspace, its bot user), from Slack's auth.test through Composio.
 * Without the workspace no message could be matched to the bot, so no answer is a failure.
 */
async function slackIdentity(accountId: string) {
  const r = (await composio()
    .tools.proxyExecute({ endpoint: "/auth.test", method: "POST", connectedAccountId: accountId })
    .catch((e: Error) => {
      throw new Error(`Couldn't ask Slack which workspace this is: ${e.message}`);
    })) as unknown as { data?: { ok?: boolean; error?: string; user_id?: string; team?: string; team_id?: string; bot_id?: string } };
  const d = r.data ?? {};
  if (d.ok !== true || !d.team_id) throw new Error(`Slack wouldn't say which workspace this is${d.error ? ` (${d.error})` : ""}. Add Bops to Slack again.`);
  // Only a bot token's answer names the bot (it has bot_id); a person's token would name the person,
  // and then mentioning them would count as mentioning the bot.
  return { team: d.team, team_id: d.team_id, user_id: d.bot_id ? d.user_id : undefined };
}

/** Add a bot to Slack through the user's Slack app account (Composio's "slackbot"), into these channels. */
export async function linkSlack(botId: string, accountId: string, channels: { id: string; name: string }[]) {
  const b = bot(botId);
  const account = getState().accounts?.find((a) => a.id === accountId && a.app === "slackbot");
  if (!b || !account) throw new Error("Connect Slack first");
  // Signed in with Orgo, Slack's events reach Bops only through Bops Cloud's Slack app.
  if (cloudOn() && !(await cloudSession()).slack) throw new Error("Slack isn't available in Bops yet. Try again later.");
  const existing = linksOf("slack").find((l) => l.botId === botId && l.slack?.accountId === accountId);
  // Which workspace it is comes first: without it the bot could never be found there, so a failure saves nothing.
  const who = existing?.slack?.teamId ? null : await slackIdentity(accountId);
  // The app can join public channels itself; a private one needs /invite from someone in it.
  for (const c of channels) await runAs(accountId, "SLACKBOT_JOIN_AN_EXISTING_CONVERSATION", { channel: c.id }).catch(() => null);
  // With our own Slack app, Slack sends its events to Bops Cloud or the self-hoster's front door
  // (BOPS_SLACK_SIGNING_SECRET checks them). With Composio's shared app, Composio watches the messages:
  // set that up first, so a failure saves nothing.
  if (!ownSlackApp()) {
    await ensureSlackTriggers(accountId);
    void listenSlack();
  }
  if (existing) {
    const before = existing.slack!;
    patchLink(existing.id, { slack: { ...before, channels }, status: "live", error: undefined });
    // Bops Cloud routes a channel's messages only once it knows the bot is there: a refusal saves nothing.
    await syncSlackLinks({ now: true }).catch((e: Error) => {
      patchLink(existing.id, { slack: { ...(linkOf(existing.id)?.slack ?? before), channels: before.channels } });
      throw new Error(`Bops Cloud didn't take the change: ${e.message}`);
    });
    return linkOf(existing.id)!;
  }
  const made = addLink({ kind: "slack", botId, handle: who?.team ?? account.name ?? "Slack", slack: { accountId, teamId: who?.team_id, botUserId: who?.user_id, channels } });
  await syncSlackLinks({ now: true }).catch((e: Error) => {
    update((s) => void (s.channels = (s.channels ?? []).filter((x) => x.id !== made.id)));
    throw new Error(`Bops Cloud couldn't add ${b.name} to Slack: ${e.message}`);
  });
  return linkOf(made.id) ?? made;
}

/** Composio watches the Slack app's channel messages and direct messages for Bops (once per Slack account). */
async function ensureSlackTriggers(accountId: string) {
  const user = composioUser();
  const active = await composio().triggers.listActive({ connectedAccountIds: [accountId] }).catch(() => ({ items: [] as { triggerName: string }[] }));
  const have = new Set(active.items.map((t) => t.triggerName));
  for (const slug of ["SLACKBOT_CHANNEL_MESSAGE_RECEIVED", "SLACKBOT_DIRECT_MESSAGE_RECEIVED"])
    if (!have.has(slug)) await composio().triggers.create(user, slug, { connectedAccountId: accountId, triggerConfig: slug.includes("CHANNEL") ? { is_bot_message: false } : {} });
}

/** Listen to Composio's Slack events (one live connection for every Slack link). */
async function listenSlack() {
  if (live.slack) return;
  live.slack = true;
  await composio()
    .triggers.subscribe(
      (e) => void slackIn(e as unknown as SlackEvent).catch((err: Error) => console.warn(`[slack] ${err.message}`)),
      { userId: composioUser() },
      () => (live.slack = false),
    )
    .catch(() => (live.slack = false));
}

type SlackEvent = {
  triggerSlug: string;
  metadata?: { connectedAccount?: { id?: string } };
  payload?: { channel?: string; channel_type?: string; user?: string; text?: string; ts?: string; thread_ts?: string; bot_id?: string; subtype?: string; files?: { mimetype?: string; url_private?: string }[] };
};

async function slackIn(e: SlackEvent) {
  const accountId = e.metadata?.connectedAccount?.id;
  const links = linksOf("slack").filter((l) => l.slack?.accountId === accountId && bot(l.botId));
  if (accountId && e.payload) await slackMessage(links, e.payload, false);
}

/**
 * The workspaces a Slack event belongs to: its own (team_id) and those of the app's installations it
 * was sent through (authorizations), which differ only in a channel shared between two workspaces.
 * The same rule Bops Cloud routes by (teamsOf in cloud/slack.ts).
 */
export function slackTeams(envelope: { team_id?: unknown; authorizations?: unknown }): string[] {
  const through = Array.isArray(envelope.authorizations) ? envelope.authorizations.map((a) => (a as { team_id?: unknown } | null)?.team_id) : [];
  return [...new Set([envelope.team_id, ...through].filter((t): t is string => typeof t === "string" && /^[A-Z0-9]{2,40}$/.test(t)))];
}

/**
 * A delivery from Bops' own Slack app (its whole event_callback envelope), already proven to be
 * Slack's: by its signature here, or by Bops Cloud (replayed over the tunnel, or kept for this Mac
 * while it was away). Handled after the answer, as Slack wants one within 3 seconds.
 */
export function slackDelivery(envelope: unknown) {
  const e = envelope as { type?: unknown; team_id?: unknown; authorizations?: unknown; event?: SlackPayload & { type?: string } } | null;
  if (!e || typeof e !== "object" || e.type !== "event_callback" || !e.event || typeof e.event !== "object") return;
  const teams = slackTeams(e);
  if (teams.length) void slackEventIn(teams, e.event).catch((err: Error) => console.warn(`[slack] ${err.message}`));
}

/** A message event straight from Slack (our own Slack app): which links it's for comes from its workspaces. */
export async function slackEventIn(teams: string[], event: SlackPayload & { type?: string }) {
  if (event.type !== "message" && event.type !== "app_mention") return;
  const links = linksOf("slack").filter((l) => !!l.slack?.teamId && teams.includes(l.slack.teamId) && bot(l.botId));
  // app_mention repeats a channel message the app also gets as "message"; the message one is enough.
  if (event.type === "message") await slackMessage(links, event, true);
}

type SlackPayload = NonNullable<SlackEvent["payload"]>;

/**
 * A Slack message for one of the bots. `ownApp`: it came from our own Slack app's events, which only
 * carry the app's own conversations; Composio's direct-message event also sees the user's other DMs,
 * so then only the user's one-to-one with the app counts (learned from the pairing message).
 */
async function slackMessage(links: ChannelLink[], p: SlackPayload, ownApp: boolean) {
  if (!links.length || !p.channel || !p.ts || !p.user || p.bot_id || (p.subtype && p.subtype !== "file_share" && p.subtype !== "thread_broadcast")) return;
  const accountId = links[0].slack!.accountId;
  const text = p.text ?? "";
  const words = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const direct = p.channel_type === "im" || p.channel.startsWith("D");
  // Which bot: the one whose pairing code it is, else the one named, else (DMs) one paired with them or
  // the main one, else the channel's. Its direct message is recorded only once it's proven to be the
  // user's (messageIn: from the person paired, or with the right code), never a stranger's.
  let pick: ChannelLink | undefined;
  let pool: ChannelLink[];
  if (direct) {
    const own = links.find((l) => l.slack?.dm === p.channel);
    const coded = codeFor(links, words);
    const theirs = links.filter((l) => l.owner === p.user);
    pick = coded ?? byName(links, text) ?? theirs.find((l) => bot(l.botId)?.isMain) ?? theirs[0] ?? links.find((l) => bot(l.botId)?.isMain) ?? links[0];
    if (!ownApp) {
      // Composio's trigger also sees the person's other direct messages: only the one with the app counts, learned from the code.
      if (!own && links.some((l) => l.slack?.dm)) return;
      if (!own && !coded) return;
    }
    pool = links;
  } else {
    const here = links.filter((l) => l.slack?.channels.some((c) => c.id === p.channel));
    if (!here.length) return;
    pick = codeFor(here, words) ?? byName(here, text) ?? (here.length === 1 ? here[0] : here.find((l) => bot(l.botId)?.isMain) ?? here[0]);
    pool = here;
  }
  const l = pick;
  const b = bot(l.botId)!;
  const atApp = !!l.slack?.botUserId && text.includes(`<@${l.slack.botUserId}>`);
  const inThread = !!p.thread_ts && live.slackThreads.has(`${p.channel}:${p.thread_ts}`);
  const named = new RegExp(`\\b${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  await messageIn(l.id, {
    chat: p.channel,
    messageId: p.ts,
    thread: p.thread_ts,
    fromId: p.user,
    fromName: (await slackName(accountId, p.user)) ?? "you",
    text: words,
    direct,
    mentioned: atApp || inThread || named,
    // Slack's files need the app's token, which only Composio has: pictures from Slack aren't passed on yet.
  }, pool);
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byName = (links: ChannelLink[], text: string) => links.find((l) => new RegExp(`\\b${escaped(bot(l.botId)?.name ?? "\uFFFF")}\\b`, "i").test(text));

const slackNames = new Map<string, string>();
async function slackName(accountId: string, user: string) {
  if (slackNames.has(user)) return slackNames.get(user);
  const r = (await runAs(accountId, "SLACKBOT_RETRIEVE_DETAILED_USER_INFORMATION", { user }).catch(() => null)) as { user?: { real_name?: string; name?: string } } | null;
  const name = r?.user?.real_name || r?.user?.name;
  if (name) slackNames.set(user, name);
  return name;
}

/* ---------------- Bops Cloud: where the bots are in Slack ---------------- */

const SLACK_CHANNEL = /^[CG][A-Z0-9]{2,40}$/;
const SLACK_DM = /^D[A-Z0-9]{2,40}$/;
const SLACK_PERSON = /^[UW][A-Z0-9]{2,40}$/;

/**
 * What Bops Cloud is told (SlackLinksBody in cloud/protocol.ts), one entry per Slack account its bots
 * are in: their channels, the direct message with the person paired (only ever recorded from them, or
 * with the right code), the Slack people they're paired with, and whether a code is waiting. The cloud
 * passes this Mac only the events these name, within the account's own workspace.
 */
export function slackLinksBody(now = Date.now()): SlackLinksBody {
  const accounts = new Map<string, ChannelLink[]>();
  for (const l of linksOf("slack")) if (l.slack?.accountId) accounts.set(l.slack.accountId, [...(accounts.get(l.slack.accountId) ?? []), l]);
  const links = [...accounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountId, ls]): SlackLinkIn => ({
      accountId,
      channels: [...new Set(ls.flatMap((l) => l.slack!.channels.map((c) => c.id)))].filter((c) => SLACK_CHANNEL.test(c)).sort(),
      dm: ls.map((l) => l.slack!.dm).find((d): d is string => !!d && SLACK_DM.test(d)) ?? null,
      owners: [...new Set(ls.map((l) => l.owner).filter((o): o is string => !!o && SLACK_PERSON.test(o)))].sort(),
      pairing: ls.some((l) => pairCodeLive(l, now)),
    }));
  return { links };
}

const slackSync = () => (live.slackLinks ??= { chain: Promise.resolve(), failures: 0 });

/**
 * Tell Bops Cloud where the bots are in Slack (PUT /v1/slack/links), when that changed since it last
 * took it: a link, its channels, a pairing, or a code running out. Nothing when the app isn't on the
 * cloud, or the cloud doesn't take Slack's events. One at a time; after a failure it waits (5 seconds,
 * doubling, up to 10 minutes) unless `now` (a bot being added, which waits for the answer).
 */
export function syncSlackLinks(opts: { now?: boolean } = {}): Promise<void> {
  if (!cloudOn()) return Promise.resolve();
  const sync = slackSync();
  // Nothing to tell: no bot in Slack, and nothing told before (most users never ask the cloud at all).
  if (!linksOf("slack").length && sync.sent === undefined) return Promise.resolve();
  if (!opts.now && sync.retryAt && Date.now() < sync.retryAt) return Promise.resolve();
  const run = sync.chain.then(() => pushSlackLinks());
  sync.chain = run.catch(() => {});
  return run;
}

async function pushSlackLinks() {
  const sync = slackSync();
  const session = await cloudSession();
  if (!session.slack) return;
  const now = Date.now();
  const body = JSON.stringify(slackLinksBody(now));
  const key = `${session.userId}\n${body}`;
  if (sync.sent !== key) {
    try {
      await cloudJson<SlackLinksResult>("/v1/slack/links", { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    } catch (e) {
      sync.failures++;
      sync.retryAt = Date.now() + Math.min(600_000, 5000 * 2 ** (sync.failures - 1));
      console.warn(`[slack] Bops Cloud didn't take where the bots are: ${(e as Error).message}`);
      throw e;
    }
    sync.sent = key;
    sync.failures = 0;
    sync.retryAt = undefined;
  }
  // A pairing code that runs out changes what the cloud should hear: check again then.
  if (sync.timer) clearTimeout(sync.timer);
  const next = Math.min(...linksOf("slack").filter((l) => pairCodeLive(l, now)).map((l) => (l.pairCodeAt ?? l.at) + PAIR_CODE_MS));
  if (Number.isFinite(next)) {
    sync.timer = setTimeout(() => void syncSlackLinks().catch(() => {}), Math.max(1000, next - now + 1000));
    sync.timer.unref?.();
  }
}

// Any change might be one the cloud should hear (a link, a pairing, a channel): checked a moment later,
// once for a burst of changes, and sent only if what it would be told changed.
watchChanges("slack-links", () => {
  if (!cloudOn()) return;
  const sync = slackSync();
  if (sync.soon) return;
  sync.soon = setTimeout(() => {
    sync.soon = undefined;
    void syncSlackLinks().catch(() => {});
  }, 500);
  sync.soon.unref?.();
});

/** The bot's links, for its profile. */
export const linksFor = (b: Bot) => (getState().channels ?? []).filter((l) => l.botId === b.id);
