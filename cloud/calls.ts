import { WebSocket, type RawData } from "ws";
import { config } from "./config.ts";
import { hasCredit } from "./credit.ts";
import { query } from "./db.ts";
import { callerVerdict } from "./lines.ts";
import type { CloudCallPayload } from "./protocol.ts";
import { loadState } from "./state.ts";
import { queueForMac } from "./tunnel.ts";
import { recordUsage } from "./usage.ts";

/**
 * Answering the owner's GPT-Live call (a number routed to a SIP trunk to OpenAI) in the cloud when
 * their Mac is away (asleep, off, offline, or too slow to take it): the bot picks up in its voice,
 * says the computer it works on is offline, takes a note of anything they want done, says goodbye
 * and hangs up. The Mac hears about it when it's back (a "call" event). Dormant: Bops' numbers send
 * calls to their AgentPhone agents now (voice.ts answers those turns), and trunks are made only with
 * BOPS_SIP_TRUNKS=1. Here bots take calls only from their owner, as the app does (lib/server/phone.ts
 * incomingCall): who that is comes from bops.phone_lines (lines.ts), and anyone else, a withheld
 * number too, is turned away before the call connects. Owner: edge builder.
 *
 * It mirrors how the app answers a call (lib/server/phone.ts incomingCall and runCall: accept the
 * live session, then run it over the sideband WebSocket), with plain fetch and ws: the cloud ships
 * without the OpenAI SDK. GPT-Live has no tools of its own, so take_message and end_call belong to
 * its Responses backend (delegation "responses"): GPT-Live delegates, the backend calls a tool, the
 * cloud answers it over the sideband (response.item.create, then response.create).
 */

/** How long after end_call the line stays open (for the goodbye to be heard), and the longest call. Tests shorten them. */
export const timing = { hangupAfterMs: 4_000, maxCallMs: 10 * 60_000 };

/** The Responses model behind the call's two tools: the app's chat model, thinking lightly (lib/server/chat.ts). */
const BACKEND_MODEL = "gpt-6.1-sol";
/** Enough for a long call's transcript; the Mac shows it in the bot's chat. */
const MAX_TRANSCRIPT = 20_000;

type SipHeader = { name: string; value: string };
type Line = { phone: string; numberId: string; agentId: string };
export type Bot = {
  id: string;
  name: string;
  isMain?: boolean;
  workspaceId?: string;
  phone?: string;
  phoneLine?: { numberId: string; agentId: string };
  /** The voice the app picked for it and kept (lib/server/call.ts voiceFor). */
  voice?: unknown;
  /** The owner's app accounts it may use, by account id: "read" or "act". */
  access?: Record<string, unknown>;
};
/** One of the owner's app accounts, connected through Composio (AppAccount in lib/types.ts). */
type Account = { id: string; app: string; appName?: unknown; name?: unknown; label?: unknown; status?: unknown };
/** A bot added to Slack, Telegram or Discord (ChannelLink in lib/types.ts). */
type Channel = { kind: string; botId: string; handle?: unknown };
type CallMessage = NonNullable<CloudCallPayload["message"]>;

/**
 * The parts of the app's state (lib/types.ts AppState) a call reads, with every list there even when
 * an older app left one out. Never who the owner is: that's bops.phone_lines (lines.ts).
 */
export type State = {
  owner: string | null;
  bots: Bot[];
  workspaces: { id: string; line?: Line }[];
  accounts: Account[];
  channels: Channel[];
};

export function view(raw: unknown): State {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = <T>(x: unknown, ok: (item: T) => boolean) => (Array.isArray(x) ? (x as T[]).filter((item) => item && typeof item === "object" && ok(item)) : []);
  const owner = s.owner as { name?: unknown } | undefined;
  return {
    owner: typeof owner?.name === "string" && owner.name.trim() ? owner.name.trim() : null,
    bots: list<Bot>(s.bots, (b) => typeof b.id === "string" && typeof b.name === "string"),
    workspaces: list<State["workspaces"][number]>(s.workspaces, (w) => typeof w.id === "string"),
    accounts: list<Account>(s.accounts, (a) => typeof a.id === "string" && typeof a.app === "string"),
    channels: list<Channel>(s.channels, (l) => typeof l.kind === "string" && typeof l.botId === "string"),
  };
}

/* ---------------- Numbers and who is who ---------------- */

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
/** The phone numbers in a SIP header value ("<sip:+15551234567@…>"), by their last 10 digits. */
const numbersIn = (value: string) =>
  [...value.matchAll(PHONE)]
    .map((m) => m[0].replace(/\D/g, ""))
    .filter((d) => d.length >= 10)
    .map((d) => d.slice(-10));
const header = (headers: SipHeader[], name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
/** The first phone number in a header value, as written there (numberIn in lib/server/phone.ts). */
const numberIn = (value: string) => /(\+?\d[\d\s().-]{8,}\d)/.exec(value)?.[1]?.replace(/[^\d+]/g, "") ?? "";
/** The caller: From, else P-Asserted-Identity, where some carriers put the real number (incomingCall in lib/server/phone.ts). */
export const callerOf = (headers: SipHeader[]) => numberIn(header(headers, "From")) || numberIn(header(headers, "P-Asserted-Identity"));

/**
 * Headers that name the caller or the way the call came, never the number that was called. The app
 * skips only From, because it knows just its own numbers; across every user's numbers, the caller's
 * own number (in P-Asserted-Identity, say) could be another Bops user's and must not route there.
 */
const NOT_CALLED = /^(from|p-asserted-identity|p-preferred-identity|remote-party-id|contact|referred-by|via|call-id)$/i;

/** Numbers in the SIP headers that may be the one that was called, in order: To first, then the rest as sent. */
export function calledNumbers(headers: SipHeader[]): string[] {
  const to = headers.filter((h) => /^to$/i.test(h.name));
  const rest = headers.filter((h) => !/^to$/i.test(h.name) && !NOT_CALLED.test(h.name));
  return [...new Set([...to, ...rest].flatMap((h) => numbersIn(h.value)))];
}

/** The SIP headers of an incoming call event, the well-formed ones. */
export const sipHeadersOf = (event: unknown): SipHeader[] => {
  const list = (event as { data?: { sip_headers?: unknown } } | null)?.data?.sip_headers;
  return Array.isArray(list) ? list.filter((h): h is SipHeader => !!h && typeof h.name === "string" && typeof h.value === "string") : [];
};

/** Whose call this is: the first number in the SIP headers (To first) that is in a user's sub-account (bops.cloud_numbers). */
export async function userForCall(headers: SipHeader[]): Promise<string | null> {
  const candidates = calledNumbers(headers);
  if (!candidates.length) return null;
  const r = await query<{ digits: string; user_id: string }>("SELECT digits, user_id FROM bops.cloud_numbers WHERE digits = ANY($1::text[])", [candidates]);
  const users = new Map(r.rows.map((row) => [row.digits, row.user_id]));
  return candidates.map((d) => users.get(d)).find((u) => u !== undefined) ?? null;
}

const workspaceOf = (b: Bot) => b.workspaceId ?? "ws_main";
const mainBot = (s: State, workspaceId: string) => s.bots.find((b) => b.isMain && workspaceOf(b) === workspaceId);

/** Which bot an AgentPhone agent's events are for: a workspace's main bot, or a bot's own number (routeFor in lib/server/phone.ts). */
export function botForAgent(state: unknown, agentId: string): Bot | undefined {
  const s = view(state);
  for (const w of s.workspaces) {
    const main = w.line?.agentId === agentId ? mainBot(s, w.id) : undefined;
    if (main) return main;
  }
  return s.bots.find((b) => b.phoneLine?.agentId === agentId);
}

/** The number an AgentPhone agent has, by the app's last state upload: its workspace's line, or its bot's own number. Only to find a line, never who owns it. */
export function numberForAgent(state: unknown, agentId: string): string | undefined {
  const s = view(state);
  const w = s.workspaces.find((x) => x.line?.agentId === agentId);
  if (typeof w?.line?.phone === "string") return w.line.phone;
  const b = s.bots.find((x) => x.phoneLine?.agentId === agentId);
  return typeof b?.phone === "string" ? b.phone : undefined;
}

/**
 * Which bot a call is for (calledBot in lib/server/phone.ts), and the number that was called: the
 * first known number in the SIP headers, To first; if none is there and exactly one bot's own number
 * takes calls, that one.
 */
function calledBot(s: State, headers: SipHeader[]): { bot: Bot; number: string } | undefined {
  const known = new Map<string, Bot>();
  const add = (phone: string, b: Bot) => {
    const d = digits(phone);
    if (d.length === 10 && !known.has(d)) known.set(d, b);
  };
  for (const w of s.workspaces) {
    const main = mainBot(s, w.id);
    if (typeof w.line?.phone === "string" && main) add(w.line.phone, main);
  }
  const trunked = s.bots.filter((b): b is Bot & { phone: string } => typeof b.phone === "string" && !!b.phone && !!b.phoneLine);
  for (const b of trunked) add(b.phone, b);
  for (const d of calledNumbers(headers)) if (known.has(d)) return { bot: known.get(d)!, number: d };
  return trunked.length === 1 ? { bot: trunked[0], number: trunked[0].phone } : undefined;
}

/**
 * The bot's voice: the one the app picked for it and kept on the bot (voiceFor in lib/server/call.ts,
 * a woman's voice for a woman's name), so it sounds the same as on the Mac. A bot the app hasn't
 * picked one for yet gets what the app picks for a name that could be either: a man's voice, chosen
 * by the bot's id, the same on every call.
 */
const MALE_VOICES = ["cedar", "ash", "echo", "ballad", "verse"];
const VOICES = new Set([...MALE_VOICES, "marin", "coral", "shimmer", "sage"]);
function voiceFor(b: Bot) {
  if (typeof b.voice === "string" && VOICES.has(b.voice)) return b.voice;
  if (b.isMain && (b.name === "Boppy" || b.name === "Sam")) return "cedar";
  return MALE_VOICES[[...b.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % MALE_VOICES.length];
}

/* ---------------- What the bot is told ---------------- */

type Call = { userId: string; sessionId: string; s: State; bot: Bot; from: string };

const CHANNEL_NAMES: Record<string, string> = { slack: "Slack", telegram: "Telegram", discord: "Discord" };
const clip = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
/** "a", "a and b", "a, b and c". */
export const and = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));

/**
 * What the bot can do once the computer is back, from the user's last state upload: the owner's
 * apps it may use, each account with how much it may do there ("Gmail (Work · ann@acme.com: read &
 * act)", as appList in lib/server/composio.ts writes it), and where it's been added in Slack,
 * Telegram and Discord (lib/server/channels.ts). It can't use any of them on this call, but it knows
 * them, so it can say what it will do and note it.
 */
export function skillsOf(s: State, b: Bot) {
  const apps = new Map<string, { name: string; accounts: string[] }>();
  for (const a of s.accounts) {
    const level = b.access?.[a.id];
    if (a.status !== "active" || (level !== "read" && level !== "act")) continue;
    const app = apps.get(a.app) ?? { name: clip(a.appName, 60) || a.app, accounts: [] };
    const title = [clip(a.label, 40), clip(a.name, 80)].filter(Boolean).join(" · ") || app.name;
    if (!a.id.startsWith("open:")) app.accounts.push(`${title}: ${level === "read" ? "read only" : "read & act"}`);
    apps.set(a.app, app);
  }
  const places = s.channels.filter((l) => l.botId === b.id && Object.hasOwn(CHANNEL_NAMES, l.kind));
  return {
    apps: [...apps.values()].slice(0, 30).map((x) => (x.accounts.length ? `${x.name} (${x.accounts.join("; ")})` : x.name)),
    places: places.map((l) => `${CHANNEL_NAMES[l.kind]}${clip(l.handle, 60) ? ` (${clip(l.handle, 60)})` : ""}`),
    kinds: new Set(places.map((l) => l.kind)),
  };
}

/**
 * GPT-Live's instructions: who it is, that the computer is offline, what it can do once it's back
 * (its apps and where it's in Slack, Telegram and Discord), that it's answering from Bops Cloud and
 * which messages wait for the computer meanwhile, take a note, then goodbye. Texts wait in Bops Cloud
 * and Slack messages there for a day; Telegram keeps a bot's messages a day; the Mac's Discord
 * connection starts afresh and never sees what was sent while it was away. So the bot steers them to
 * a note on the call or a text.
 */
function frontPrompt(c: Call) {
  const { apps, places, kinds } = skillsOf(c.s, c.bot);
  const theirs = c.s.owner ? `${c.s.owner}'s` : "their";
  return [
    `You are ${c.bot.name}, an AI assistant, on a call with ${c.s.owner ? `${c.s.owner}, who you work for` : "the person you work for"}. The computer you work on is offline right now, so you can't do tasks or look anything up until it's back.`,
    ...(apps.length ? [`When it's back you can use ${theirs} apps again: ${apps.join(", ")}.`] : []),
    ...(places.length ? [`You're also in ${and(places)}, where ${c.s.owner ?? "they"} can message you.`] : []),
    ...(apps.length || places.length ? ["Until then, anything they want done there is a note for later."] : []),
    `You're answering from Bops Cloud: texts sent to you meanwhile wait there for the computer${kinds.has("slack") ? ", and Slack messages for up to a day" : ""}.`,
    ...(kinds.has("telegram") ? ["Telegram messages wait at Telegram for up to a day."] : []),
    ...(kinds.has("discord") ? ["Discord messages sent before the computer is back are missed."] : []),
    ...(places.length ? ["So if they want to send you something, take it as a note on this call, or ask them to text you."] : []),
    "Be warm and brief: one or two short sentences at a time.",
    "If they want something done, save it as a note for later by delegating it as a message. When they're done, say a short goodbye and delegate ending the call.",
  ].join("\n\n");
}

/** The backend's instructions: the two things it's delegated, and a short line back for the bot to say. */
function backendPrompt(c: Call) {
  return [
    `You help ${c.bot.name}, an AI assistant on a phone call with ${c.s.owner ?? "the person it works for"} while the computer it works on is offline.`,
    "When asked to take a message or a note, call take_message with what they want done or passed on, using only what they said.",
    "When asked to end the call, call end_call.",
    `Then reply with one short sentence ${c.bot.name} can say, like "Got it, I'll do that when the computer's back."`,
  ].join("\n");
}

/** The first words, said as the bot picks up (the app's runCall does the same with its own greeting). */
function greeting(c: Call) {
  const words = `Hi${c.s.owner ? ` ${c.s.owner}` : ""}, it's ${c.bot.name}. Your computer is offline, so I can only take a note right now.`;
  return `You just picked up the call. Say only: "${words}" Then wait.`;
}

const nullableString = (description: string) => ({ type: ["string", "null"], description });
const TOOLS = [
  {
    type: "function",
    name: "take_message",
    description: "Save a note of what the person the assistant works for wants done or passed on, for when the computer is back.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: nullableString("Who it's from or for, if they said. Null if not."),
        text: { type: "string", description: "The note, in a sentence or two." },
        callback: nullableString("A number or an email it's about, if they gave one. Null if not."),
      },
      required: ["name", "text", "callback"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "Hang up. Only after the goodbye.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
];

function sessionFor(c: Call) {
  return {
    type: "live",
    model: "gpt-live-1",
    instructions: frontPrompt(c),
    audio: { output: { voice: voiceFor(c.bot) } },
    delegation: {
      type: "responses",
      responses: { model: BACKEND_MODEL, instructions: backendPrompt(c), tools: TOOLS, parallel_tool_calls: false, reasoning: { effort: "low" } },
    },
  };
}

/* ---------------- The call ---------------- */

/** A Live session control (accept, reject, hangup) on OpenAI's REST API; throws unless OpenAI says yes. */
async function control(sessionId: string, action: "accept" | "reject" | "hangup", body?: unknown) {
  const res = await fetch(`${config.upstream.openai()}/v1/live/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey()}`, Accept: "*/*", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${action} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * Answer the call (OpenAI's live.transport.incoming event) and run it to the end: the bot whose
 * number was called, from the user's last state upload, takes the owner's note. Anyone but the owner
 * (bops.phone_lines: the line's owner, or one of the user's verified numbers; the first caller in a
 * new line's 15 minutes claims it) is turned away before it connects (403), as the app does, and so
 * is the owner once their AI credit is used up (402): a call costs credit, and the app says why.
 * Resolves once the call is over and the Mac's event is queued. Does nothing more if accepting
 * fails: the Mac may have taken the call after all.
 */
export async function answerInCloud(userId: string, event: unknown): Promise<void> {
  const sessionId = (event as { data?: { session_id?: unknown } } | null)?.data?.session_id;
  if (typeof sessionId !== "string" || !sessionId) return;
  if (!config.openaiKey()) return console.warn(`[calls] ${sessionId}: no OPENAI_API_KEY, can't answer`);
  const headers = sipHeadersOf(event);
  const s = view((await loadState(userId))?.state);
  const called = calledBot(s, headers);
  const refuse = (status_code: number) => control(sessionId, "reject", { status_code }).catch((e: Error) => console.warn(`[calls] ${sessionId}: ${e.message}`));
  if (!called) {
    console.warn(`[calls] ${sessionId}: none of ${userId}'s bots has the number that was called`);
    return refuse(404);
  }
  const { bot } = called;
  const from = callerOf(headers);
  // Bots take calls only from their owner: anyone else hears nothing and leaves no message.
  if (!(await callerVerdict(userId, called.number, from, "call")).owner) {
    console.log(`[calls] ${sessionId}: turned away, not from one of ${userId}'s verified numbers`);
    return refuse(403);
  }
  if (!(await hasCredit(userId))) {
    console.log(`[calls] ${sessionId}: turned away, ${userId} is out of AI credit`);
    return refuse(402);
  }
  const call: Call = { userId, sessionId, s, bot, from };
  try {
    await control(sessionId, "accept", { session: sessionFor(call) });
  } catch (e) {
    return console.warn(`[calls] ${sessionId}: not answered: ${(e as Error).message}`);
  }
  console.log(`[calls] ${sessionId}: ${bot.name} answered for ${userId}`);
  await report(call, await converse(call));
}

type Turn = { who: "Caller" | "Bot"; text: string };
type CallRecord = { acceptedAt: number; startedAt: number; endedAt: number; turns: Turn[]; message?: CallMessage };
type ToolCall = { type?: string; call_id?: string; name?: string; arguments?: string };
type LiveEvent = { type?: string; delta?: string; error?: { message?: string }; event?: { type?: string; item?: ToolCall } };

/**
 * The call over the sideband: the greeting once the session starts, the transcript as it comes,
 * the tools answered, and a hangup after end_call or at the time limit. Resolves when it's over.
 */
function converse(c: Call): Promise<CallRecord> {
  return new Promise((resolve) => {
    const record: CallRecord = { acceptedAt: Date.now(), startedAt: 0, endedAt: 0, turns: [] };
    const answered = new Set<string>();
    let closed = false;
    let hungUp = false;
    let goodbye: ReturnType<typeof setTimeout> | undefined;
    const limit = setTimeout(() => void hangUp(), timing.maxCallMs);
    const ws = new WebSocket(`${config.upstream.openai().replace(/^http/, "ws")}/v1/live/sessions/${encodeURIComponent(c.sessionId)}/attach`, {
      headers: { Authorization: `Bearer ${config.openaiKey()}` },
    });
    const send = (e: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
    };

    function finish() {
      if (record.endedAt) return;
      record.endedAt = Date.now();
      clearTimeout(limit);
      clearTimeout(goodbye);
      ws.close();
      // The sideband went away with the call still up: nobody can take a message on it, so end it.
      if (closed) resolve(record);
      else void hangUp().finally(() => resolve(record));
    }

    async function hangUp() {
      if (hungUp) return;
      hungUp = true;
      await control(c.sessionId, "hangup").catch((e: Error) => console.warn(`[calls] ${c.sessionId}: ${e.message}`));
      // The session's end comes over the sideband; if it doesn't, stop waiting for it.
      setTimeout(finish, 5_000).unref();
    }

    function turn(who: Turn["who"], delta: string) {
      const last = record.turns.at(-1);
      if (last?.who === who) last.text += delta;
      else record.turns.push({ who, text: delta });
    }

    function tool(item: ToolCall) {
      if (item.type !== "function_call" || !item.call_id || answered.has(item.call_id)) return;
      answered.add(item.call_id);
      let output: string;
      if (item.name === "take_message") {
        record.message = messageFrom(item.arguments, record.message);
        output = record.message ? "Saved." : "Nothing was saved: the message was empty.";
      } else if (item.name === "end_call") {
        output = "Hanging up.";
        goodbye ??= setTimeout(() => void hangUp(), timing.hangupAfterMs);
      } else output = `There's no tool called ${item.name}.`;
      send({ type: "response.item.create", item: { type: "function_call_output", call_id: item.call_id, output } });
      send({ type: "response.create" });
    }

    ws.on("message", (data: RawData) => {
      let e: LiveEvent;
      try {
        e = JSON.parse(String(data)) as LiveEvent;
      } catch {
        return;
      }
      if (e.type === "session.started" && !record.startedAt) {
        record.startedAt = Date.now();
        send({ type: "session.commentary.append", delegation_id: null, content: greeting(c) });
      } else if (e.type === "session.input_transcript.delta" && e.delta) turn("Caller", e.delta);
      else if (e.type === "session.output_transcript.delta" && e.delta) turn("Bot", e.delta);
      else if (e.type === "response.event" && e.event?.type === "response.output_item.done" && e.event.item) tool(e.event.item);
      else if (e.type === "error") console.warn(`[calls] ${c.sessionId}: ${e.error?.message ?? "error"}`);
      else if (e.type === "session.closed") {
        closed = true;
        finish();
      }
    });
    ws.on("close", finish);
    ws.on("error", (e) => console.warn(`[calls] ${c.sessionId}: sideband: ${e.message}`));
  });
}

/** take_message's arguments as the message so far: a later call replaces the text and keeps a name or callback said before. */
function messageFrom(args: string | undefined, before?: CallMessage): CallMessage | undefined {
  let a: { name?: unknown; text?: unknown; callback?: unknown };
  try {
    a = JSON.parse(args || "{}") as typeof a;
  } catch {
    return before;
  }
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  const text = str(a.text);
  if (!text) return before;
  const name = str(a.name) ?? before?.name;
  const callback = str(a.callback) ?? before?.callback;
  return { text, ...(name ? { name } : {}), ...(callback ? { callback } : {}) };
}

/* ---------------- After the call ---------------- */

/** The call goes to the Mac (kept until it's back), and its minutes are counted. */
async function report(c: Call, r: CallRecord) {
  const startedAt = r.startedAt || r.acceptedAt;
  const transcript = r.turns
    .filter((t) => t.text.trim())
    .map((t) => `${t.who}: ${t.text.trim()}`)
    .join("\n")
    .slice(0, MAX_TRANSCRIPT);
  const payload: CloudCallPayload = {
    botId: c.bot.id,
    from: c.from,
    owner: true,
    ...(r.message ? { message: r.message } : {}),
    transcript,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(r.endedAt).toISOString(),
  };
  const warn = (what: string) => (e: Error) => console.warn(`[calls] ${c.sessionId}: ${what}: ${e.message}`);
  await queueForMac(c.userId, "call", payload, `call:${c.sessionId}`).catch(warn("couldn't keep the call for the Mac"));
  const minutes = Math.round(((r.endedAt - startedAt) / 60_000) * 100) / 100;
  await recordUsage(c.userId, "call.minutes", minutes, { botId: c.bot.id, sessionId: c.sessionId, answeredBy: "cloud" }).catch(warn("couldn't count the minutes"));
}
