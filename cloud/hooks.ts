import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { answerInCloud, botForAgent, calledNumbers, callerOf, numberForAgent, sipHeadersOf, userForCall } from "./calls.ts";
import { config } from "./config.ts";
import { open } from "./crypto.ts";
import { ownObject, query } from "./db.ts";
import { readBody, sendJson, type Route } from "./http.ts";
import { callerVerdict } from "./lines.ts";
import { lineStopped } from "./plans.ts";
import { smsSegments } from "./pricing.ts";
import { CLOUD_CALLER_HEADER, type CallerVerdict } from "./protocol.ts";
import { loadState } from "./state.ts";
import { queueForMac, requestMac, type MacRequest, type MacResponse } from "./tunnel.ts";
import { recordUsageFor } from "./usage.ts";
import { cloudVoiceTurn, endCloudVoiceCall, type VoiceReply } from "./voice.ts";

/**
 * Public webhooks: /hooks/agentphone (texts and call turns for every user's numbers) and
 * /hooks/openai (incoming GPT-Live calls over a SIP trunk, dormant unless trunks are on); Slack's are
 * in slack.ts. Each delivery is proven by the provider's signature, then goes to its user's Mac over
 * the tunnel, or waits for it, or (a call's turn) is answered here. Who sent an AgentPhone delivery
 * is decided here, from bops.phone_lines (lines.ts), and the Mac is told. Owner: edge builder.
 */

/** Webhook bodies are small; anything bigger isn't one. */
const MAX_HOOK = 1024 * 1024;
/** How long a delivery waits on the Mac (AgentPhone gives up at 30 s). */
const MAC_WAIT_MS = 25_000;
/** How long an incoming call waits for the Mac to take it before the cloud answers. */
const CALL_WAIT_MS = 4_000;
/**
 * A call's turn: how long the Mac has to answer before the cloud answers it itself (that has to fit
 * in AgentPhone's 30 s too), and how long before the caller hears a filler while they wait. Tests
 * shorten them.
 */
export const voiceTiming = { macWaitMs: 15_000, fillerAfterMs: 1_500 };
/** What the caller hears while a slow answer is on its way (AgentPhone speaks an interim chunk at once). */
const FILLER = "Mm-hm, one sec.";
/** AgentPhone events the Mac acts on (lib/server/phone.ts agentPhoneEvent), kept while it's away. Call summaries aren't. */
const KEPT = new Set(["agent.message", "agent.reaction"]);
/** What a caller hears on a plan's number that's paused (the plan ended), before the call ends. */
const PAUSED = "This number is paused right now. Goodbye.";
/** The carrier keywords a texted number gets an answer to (STOP, START, HELP and theirs, as lib/server/phone.ts): never a claim on a line. */
const KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke", "start", "unstop", "help", "info"]);

/* ---------------- Signatures ---------------- */

/** AgentPhone's: HMAC-SHA256 of "{timestamp}.{raw body}" as "sha256=<hex>", at most 5 minutes old (as app/api/phone/agentphone/route.ts checks it). */
function agentPhoneSigned(secret: string, timestamp: string, body: Buffer, signature: string, now = Date.now()): boolean {
  if (!timestamp || !(Math.abs(now / 1000 - Number(timestamp)) < 300)) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`);
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * OpenAI's, Standard Webhooks: HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{raw body}" keyed
 * with the base64 secret after "whsec_", sent as a space-separated list of "v1,<base64>"; at most 5
 * minutes off (what the OpenAI SDK's webhooks.unwrap checks).
 */
function openAiSigned(secret: string, headers: IncomingHttpHeaders, body: Buffer, now = Date.now()): boolean {
  const id = one(headers["webhook-id"]);
  const timestamp = one(headers["webhook-timestamp"]);
  const seconds = Number.parseInt(timestamp, 10);
  if (!id || Number.isNaN(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret);
  const want = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
  return one(headers["webhook-signature"])
    .split(" ")
    .some((entry) => {
      if (!entry.startsWith("v1,")) return false;
      const got = Buffer.from(entry.slice(3), "base64");
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

/* ---------------- AgentPhone ---------------- */

type ApEvent = {
  event?: string;
  channel?: string;
  agentId?: string;
  data?: {
    from?: unknown;
    fromNumber?: unknown;
    to?: unknown;
    toNumber?: unknown;
    body?: unknown;
    message?: unknown;
    mediaUrl?: unknown;
    mediaUrls?: unknown;
    senderIdentifier?: unknown;
    group?: { groupId?: unknown } | null;
    [key: string]: unknown;
  };
};

/**
 * A text that came in costs Orgo as one going out does (a segment, or a picture message): it's counted
 * once per delivery (AgentPhone sends one again when it didn't hear back), whether the Mac takes it or not.
 */
function countTextIn(userId: string, event: ApEvent, deliveryId: string) {
  if (event.event !== "agent.message" || event.channel === "voice") return;
  const d = event.data ?? {};
  const mms = (typeof d.mediaUrl === "string" && !!d.mediaUrl) || (Array.isArray(d.mediaUrls) && d.mediaUrls.length > 0);
  const text = typeof d.body === "string" ? d.body : typeof d.message === "string" ? d.message : "";
  recordUsageFor(userId, "agentphone.sms", `in:${deliveryId}`, mms ? 1 : smsSegments(text), { direction: "in", ...(mms ? { mms: true } : {}) }).catch((e: Error) =>
    console.warn(`[hooks] usage: ${e.message}`),
  );
}

/** When the cloud first heard each call (its first turn) and the bot it's for, by user and callId, to count its seconds while it runs. */
const callsHeard = new Map<string, { at: number; bot: Promise<string | undefined> }>();

/**
 * A call through AgentPhone's voice agent costs Orgo by the second, whoever answers its turns (the
 * Mac or the cloud, voice.ts) and whether the number is paused or not (AgentPhone bills it either
 * way): one row per call (its callId), as agentphone.voice_seconds. While it runs, each turn counts
 * the seconds since its first; when AgentPhone says it ended, its own length (durationSeconds, else
 * startedAt to endedAt) stands. recordUsageFor keeps the largest count, so a late or repeated
 * delivery never counts a call twice. The words the bot says are its own model answers, counted as
 * tokens where they're made.
 */
async function countCallSeconds(userId: string, event: ApEvent) {
  const voiceTurn = event.event === "agent.message" && event.channel === "voice";
  if (!voiceTurn && event.event !== "agent.call_ended") return;
  const d = event.data ?? {};
  const callId = text(d.callId) || text(d.call_id);
  if (!callId) return;
  const key = `${userId} ${callId}`;
  const now = Date.now();
  for (const [k, v] of callsHeard) if (now - v.at > 2 * 60 * 60_000) callsHeard.delete(k);
  let heard = callsHeard.get(key);
  if (!heard) {
    const agentId = text(event.agentId);
    const bot = agentId ? loadState(userId).then((saved) => botForAgent(saved?.state, agentId)?.id || undefined, () => undefined) : Promise.resolve(undefined);
    heard = { at: now, bot };
    callsHeard.set(key, heard);
  }
  let seconds = Math.round((now - heard.at) / 1000);
  if (event.event === "agent.call_ended") {
    callsHeard.delete(key);
    const said = Number(d.durationSeconds);
    const span = (Date.parse(text(d.endedAt)) - Date.parse(text(d.startedAt))) / 1000;
    seconds = d.durationSeconds != null && Number.isFinite(said) && said >= 0 ? said : Number.isFinite(span) && span >= 0 ? Math.round(span) : seconds;
  }
  if (seconds <= 0) return;
  const botId = await heard.bot;
  await recordUsageFor(userId, "agentphone.voice_seconds", callId, seconds, { agentId: text(event.agentId), ...(botId ? { botId } : {}) });
}

/** The user an AgentPhone agent belongs to and its webhook secret (sealed in bops.cloud_agents when the Mac registered the webhook). */
async function agentFor(agentId: string): Promise<{ userId: string; secret: string } | null> {
  const r = await query<{ user_id: string; secret_sealed: string | null }>("SELECT user_id, secret_sealed FROM bops.cloud_agents WHERE agent_id = $1", [agentId]);
  const row = r.rows[0];
  if (!row?.secret_sealed) return null;
  try {
    return { userId: row.user_id, secret: open(row.secret_sealed) };
  } catch (e) {
    console.warn(`[hooks] agent ${agentId}: its webhook secret can't be opened: ${(e as Error).message}`);
    return null;
  }
}

const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/**
 * Who sent a text, a tapback or a call's turn (lines.ts callerVerdict): the owner of the line, or
 * anyone else. A call or a one-to-one text may claim a line that has no owner while its 15 minutes
 * run; a tapback, a group text or a carrier keyword (STOP…) never does. Null for other events.
 */
async function verdictFor(userId: string, event: ApEvent): Promise<CallerVerdict | null> {
  if (event.event !== "agent.message" && event.event !== "agent.reaction") return null;
  const d = event.data ?? {};
  const group = !!d.group?.groupId;
  // In a group, it's who sent it that counts (as textIn in lib/server/phone.ts).
  const from = (group && text(d.senderIdentifier)) || text(d.fromNumber) || text(d.from);
  // The line: the number called, else (a delivery that doesn't say) the one the app says this agent has.
  const to = text(d.toNumber) || text(d.to) || (event.agentId ? (numberForAgent((await loadState(userId).catch(() => null))?.state, event.agentId) ?? "") : "");
  const keyword = KEYWORDS.has((text(d.body) || text(d.message)).toLowerCase().replace(/[^a-z]/g, ""));
  const claim = event.event === "agent.message" && !group ? (event.channel === "voice" ? "call" : keyword ? undefined : "text") : undefined;
  return callerVerdict(userId, to, from, claim);
}

/**
 * A text, reaction or call turn for one of a user's numbers. Who sent it is decided first (and a
 * line with no owner may be claimed), and the Mac is told with the delivery (CLOUD_CALLER_HEADER, or
 * `bopsCaller` in one kept for it). With the Mac connected, a text is replayed there as POST
 * /api/phone/agentphone and AgentPhone gets the Mac's answer; with the Mac away (or not answering),
 * it waits for the Mac. A call's turn is answered by the Mac when it can, else here (answerTurn).
 */
const agentphone: Route = {
  method: "POST",
  path: "/hooks/agentphone",
  auth: "public",
  handle: async (req, res) => {
    const body = await readBody(req, MAX_HOOK);
    const event = jsonObject(body) as ApEvent | null;
    const agentId = typeof event?.agentId === "string" ? event.agentId : "";
    const agent = agentId ? await agentFor(agentId) : null;
    if (!event || !agent || !agentPhoneSigned(agent.secret, one(req.headers["x-webhook-timestamp"]), body, one(req.headers["x-webhook-signature"])))
      return sendJson(res, 400, { error: "bad signature" });
    const deliveryId = one(req.headers["x-webhook-id"]) || createHash("sha256").update(body).digest("hex");
    void countCallSeconds(agent.userId, event).catch((e: Error) => console.warn(`[hooks] ${agent.userId}: call seconds: ${e.message}`));
    // A plan's number that's paused (the plan ended) or given back: nothing on it reaches the Mac or is answered, and no text on it is counted (a call's seconds are, above: AgentPhone bills them).
    if (await lineStopped(agent.userId, agentId, text(event.data?.toNumber) || text(event.data?.to)).catch(() => false)) {
      if (event.event === "agent.message" && event.channel === "voice") return sendJson(res, 200, { text: PAUSED, hangup: true } satisfies VoiceReply);
      return sendJson(res, 200, {});
    }
    countTextIn(agent.userId, event, deliveryId);
    const verdict = await verdictFor(agent.userId, event).catch((e: Error) => (console.warn(`[hooks] ${agent.userId}: couldn't tell who's calling: ${e.message}`), null));
    const headers = { ...forwarded(req.headers, /^x-webhook-/), ...(verdict ? { [CLOUD_CALLER_HEADER]: JSON.stringify(verdict) } : {}) };
    const replay: MacRequest = { method: "POST", path: "/api/phone/agentphone", headers, body };
    if (event.event === "agent.message" && event.channel === "voice") return answerTurn(res, agent.userId, event, verdict ?? { owner: false }, replay);
    if (event.event === "agent.call_ended") endCloudVoiceCall(agent.userId, event);
    const answer = await requestMac(agent.userId, replay, MAC_WAIT_MS);
    if (answer) return relay(res, answer);
    if (KEPT.has(event.event ?? "")) {
      // Who sent it is only ever the cloud's word: anything by that name in the delivery itself goes.
      const kept: Record<string, unknown> = { ...event };
      delete kept.bopsCaller;
      if (verdict) kept.bopsCaller = verdict;
      await queueForMac(agent.userId, "agentphone", kept, `agentphone:${deliveryId}`);
    }
    sendJson(res, 200, {});
  },
};

/**
 * A call's turn: the Mac's answer (replayed with the verdict) if it gives one in time, else the
 * cloud's own (voice.ts). A quick answer goes back as JSON; a slow one as NDJSON, with a filler
 * spoken at once ("Mm-hm, one sec.") and the answer as the final chunk. The hello (a turn with
 * nothing said yet) gets no filler: it's always JSON.
 */
async function answerTurn(res: ServerResponse, userId: string, event: ApEvent, verdict: CallerVerdict, replay: MacRequest) {
  const cloudTurn = () => cloudVoiceTurn(userId, event, verdict).catch((e: Error) => (console.warn(`[hooks] ${userId}: a call's turn: ${e.message}`), { text: "Sorry, could you say that again?" }));
  const answer: Promise<{ mac: MacResponse } | { reply: VoiceReply }> = requestMac(userId, replay, voiceTiming.macWaitMs).then(async (mac) =>
    mac && ok(mac.status) ? { mac } : { reply: await cloudTurn() },
  );
  // No filler before the hello: the caller hasn't said anything to wait on.
  const said = typeof event.data?.transcript === "string" && !!event.data.transcript.trim();
  const quick = await Promise.race([answer, ...(said ? [new Promise<null>((r) => setTimeout(() => r(null), voiceTiming.fillerAfterMs))] : [])]);
  if (quick) return "mac" in quick ? relay(res, quick.mac) : sendJson(res, 200, quick.reply);
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  res.write(`${JSON.stringify({ text: FILLER, interim: true })}\n`);
  const done = await answer;
  res.end(`${JSON.stringify("mac" in done ? finalChunk(done.mac) : done.reply)}\n`);
}

/** The Mac's answer to a turn as a final NDJSON chunk: its JSON, or the last chunk of its NDJSON, without `interim`. */
function finalChunk(mac: MacResponse): Record<string, unknown> {
  const lines = mac.body.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of [lines.join(""), ...lines.reverse()]) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const rest = { ...(value as Record<string, unknown>) };
        delete rest.interim;
        return rest;
      }
    } catch {}
  }
  return { text: "Sorry, could you say that again?" };
}

/* ---------------- OpenAI ---------------- */

/** Calls already being handled, by live session id, for a while: OpenAI may deliver an event twice. */
const handling = new Map<string, number>();
function firstDelivery(sessionId: string) {
  const now = Date.now();
  for (const [id, at] of handling) if (now - at > 15 * 60_000) handling.delete(id);
  if (handling.has(sessionId)) return false;
  handling.set(sessionId, now);
  return true;
}

/**
 * Someone is calling a user's number. The live session is recorded as theirs first (so their Mac
 * can accept it through /proxy/openai), then the Mac gets it as POST /api/phone/openai and has 4 s
 * to take it (a 2xx); otherwise the cloud answers it if it's the owner calling, and turns anyone
 * else away (calls.ts). A number no user has is left alone: the OpenAI project may have other
 * webhooks that take it.
 */
async function incomingCall(event: unknown, body: Buffer, headers: Record<string, string>) {
  const sessionId = (event as { data?: { session_id?: unknown } }).data?.session_id;
  if (typeof sessionId !== "string" || !sessionId || !firstDelivery(sessionId)) return;
  const sip = sipHeadersOf(event);
  const userId = await userForCall(sip);
  if (!userId) return console.warn(`[hooks] call ${sessionId}: no Bops user has the number that was called`);
  await ownObject(userId, "openai", "live_session", sessionId);
  // Who's calling, as for AgentPhone's deliveries (lines.ts): the Mac follows it.
  const verdict = await callerVerdict(userId, calledNumbers(sip)[0] ?? "", callerOf(sip), "call").catch(() => null);
  const replay = { ...headers, ...(verdict ? { [CLOUD_CALLER_HEADER]: JSON.stringify(verdict) } : {}) };
  const answer = await requestMac(userId, { method: "POST", path: "/api/phone/openai", headers: replay, body }, CALL_WAIT_MS);
  if (answer && ok(answer.status)) return console.log(`[hooks] call ${sessionId}: ${userId}'s Mac took it`);
  await answerInCloud(userId, event);
}

/** OpenAI's webhooks: answered 200 as soon as the signature checks out; an incoming call is handled after. */
const openai: Route = {
  method: "POST",
  path: "/hooks/openai",
  auth: "public",
  handle: async (req, res) => {
    const secret = config.openaiWebhookSecret();
    if (!secret) return sendJson(res, 503, { error: "not set up" });
    const body = await readBody(req, MAX_HOOK);
    if (!openAiSigned(secret, req.headers, body)) return sendJson(res, 400, { error: "bad signature" });
    const event = jsonObject(body) as { type?: string } | null;
    if (!event) return sendJson(res, 400, { error: "Body isn't JSON" });
    sendJson(res, 200, { ok: true });
    if (event.type === "live.transport.incoming")
      void incomingCall(event, body, forwarded(req.headers, /^webhook-/)).catch((e: Error) => console.warn(`[hooks] incoming call: ${e.stack ?? e.message}`));
    else console.log(`[hooks] openai ${event.type ?? "event"}: nothing to do`);
  },
};

/* ---------------- Pieces ---------------- */

const one = (h: string | string[] | undefined) => (Array.isArray(h) ? (h[0] ?? "") : (h ?? ""));
const ok = (status: number) => status >= 200 && status < 300;

function jsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The headers a replayed webhook keeps: its content type and the provider's own (id, timestamp, signature). Nothing else crosses. */
function forwarded(headers: IncomingHttpHeaders, own: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if ((name === "content-type" || own.test(name)) && typeof value === "string") out[name] = value;
  return out;
}

/** The Mac's answer, passed on as it gave it (status, content type, body). */
function relay(res: ServerResponse, answer: MacResponse) {
  const type = Object.entries(answer.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "application/json";
  res.writeHead(answer.status, { "content-type": type, "content-length": String(answer.body.length), "cache-control": "no-store" });
  res.end(answer.body);
}

export const routes: Route[] = [agentphone, openai];
