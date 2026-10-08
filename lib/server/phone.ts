import "server-only";
import { planRoom } from "./plan-room";
import { openaiClient } from "./openai-client";
import { SidebandWS } from "openai/resources/live/sideband/ws";
import type { LiveTransportIncomingWebhookEvent } from "openai/resources/webhooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallerVerdict, CloudCallPayload } from "@/cloud/protocol";
import { botChatId, live, TAPBACKS, workspaceOf, type Bot, type Tapback, type WorkspaceLine } from "@/lib/types";
import { callEnded, callStarted } from "./attention";
import { delegate, endCall, rememberVoices, voiceFor, voicePrompt } from "./call";
import { appHeaders } from "./app-version";
import { CloudError, cloudOn, cloudProxy, cloudSession, cloudSessionNow, noteOutOfCredit } from "./cloud";
import { installId } from "./mail";
import { onPostgres } from "./persist";
import { ownerPhoneTable } from "./persist-pg";
import { forgetOwnerNumber, syncCloudLines, tellCloudLine } from "./phone-lines";
import { saveUpload } from "./uploads";
import { addMessage, bot, getState, ofThisUser, ownerName, patchSession, react, sameState, stateEpoch, stateReady, stateUser, update, userDir } from "./store";
import { recordCallMinutes, recordUsage } from "./usage";
import { checkVerification, forgetVerification, pendingConsentAt, pendingVerifications, startVerification, toE164, verifyOn } from "./verify";

/**
 * Phone numbers for Bops (AgentPhone), for texting and calling from any phone.
 *
 * - **One number per workspace** (the product model): it belongs to the workspace's main bot (its
 *   coordinator, e.g. Sam). People always text that number; the main bot keeps the conversation,
 *   does what it can, hands specialist work to the right bot, and the replies, results and failures
 *   go back from that same number. Specialists have no numbers of their own.
 *   `Workspace.line` holds it (number, the AgentPhone agent it's attached to, which account, and the
 *   agent it came from, for rollback). `assignWorkspaceLine` moves an existing number onto a Bops
 *   agent whose webhook is Bops; `releaseWorkspaceLine` puts it back.
 * - A bot can also have a number of its own (`Bot.phoneLine`, SMS, in the Bops sub-account): the
 *   earlier per-bot model, kept as a fallback.
 *
 * - **Numbers** live in the "Bops" AgentPhone sub-account (AGENTPHONE_SUB_ACCOUNT), apart from the user's
 *   other agents. Each bot has an AgentPhone agent with its number attached; the number carries
 *   `externalId` bops-<install>-<bot>, so it's found again.
 * - **Texts** come in on AgentPhone's webhook (api.bops.bot/hooks/agentphone, through the Fly relay,
 *   signed). One from the user's own number is the user talking: it goes into the bot's chat as their
 *   message and the bot's answer goes back by text. Anyone else's is dropped (STOP, START and HELP
 *   still get the reply carriers require).
 * - **Calls** go to the number's AgentPhone agent (voice mode "webhook"; every number Bops makes or
 *   assigns has its calls routed there, and lineUpkeep puts back one that isn't). AgentPhone hears the
 *   caller and sends each turn to the same webhook; phone-voice.ts answers it as the bot: the owner
 *   gets the whole bot (work goes through `delegate()`, as on a call in the app), anyone else a bot
 *   that only takes a message. The GPT-Live path over a SIP trunk (incomingCall, below) is kept for a
 *   number someone routes to a trunk by hand.
 * - **Who the user is:** the numbers they verified with a texted code in Settings, and, on Bops
 *   Cloud, whoever the cloud says owns the line (bops.phone_lines: the first phone to call or text a
 *   new number in its 15 minutes; phone-lines.ts). On Bops Cloud the cloud decides it for every call
 *   and text and this Mac follows (CallerVerdict).
 * - **On Bops Cloud** (signed in with Orgo; lib/server/cloud.ts) AgentPhone is reached through the
 *   cloud, always in the user's own sub-account. Both webhooks arrive at the cloud, which checks them
 *   and passes them to this Mac over its tunnel (lib/server/cloud-tunnel.ts), and the cloud answers
 *   calls while the Mac is away (cloudCall, below).
 */

const AP = "https://api.agentphone.ai/v1";
const openai = openaiClient({ maxRetries: 0 });

export const phoneOn = () => (cloudOn() ? !!cloudSessionNow()?.agentphone : !!process.env.AGENTPHONE_API_KEY);

/**
 * The webhook secrets that may sign a delivery: the Bops sub-account's webhook, and each agent
 * webhook Bops made for a workspace number (kept server-side in .data, never in app state).
 */
const secretsFile = () => {
  const dir = userDir();
  return dir ? join(dir, "phone-secrets.json") : null;
};
const agentSecrets = (): Record<string, string> => {
  const file = secretsFile();
  return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};
export const hookSecrets = () => [process.env.AGENTPHONE_WEBHOOK_SECRET, ...Object.values(agentSecrets())].filter((x): x is string => !!x);
/** Where AgentPhone delivers: Bops Cloud's address for the user (their session), or BOPS_AGENTPHONE_HOOK_URL (api.bops.bot, the Fly relay in edge/). */
const hookUrl = async () => (cloudOn() ? ((await cloudSession()).agentphone?.hookUrl ?? "") : (process.env.BOPS_AGENTPHONE_HOOK_URL ?? ""));
/** What Bops Cloud sends back in place of a webhook's secret, which it keeps: never a secret to check deliveries with. */
const KEPT_BY_CLOUD = "kept-by-cloud";
/** Replies are written to the chat instead of sent (for checking routing without texting anyone). */
const dryRun = () => process.env.BOPS_PHONE_DRY_RUN === "1";

type Live = { handled: Set<string>; calls: Set<string>; queues: Map<string, Promise<void>> };
const g = globalThis as unknown as { bopsPhone?: Live };
const state: Live = (g.bopsPhone ??= { handled: new Set(), calls: new Set(), queues: new Map() });
// Kept across code reloads; a field added since is filled in.
state.queues ??= new Map();

/**
 * A bot's phone events one at a time, in order: two texts landing together would otherwise have the
 * bot answer the newer one twice and never the older.
 */
function inLine(botId: string, work: () => Promise<void>) {
  const next = (state.queues.get(botId) ?? Promise.resolve()).then(work, work).catch((err: Error) => console.warn(`[phone] ${err.message}`));
  state.queues.set(botId, next);
  return next;
}

/**
 * An AgentPhone call, in the Bops sub-account unless `scope` is "parent" (the main account). Through
 * Bops Cloud it's always in the user's own sub-account, whichever scope is asked for.
 */
async function ap<T>(method: string, path: string, body?: unknown, scope: "sub" | "parent" = "sub"): Promise<T> {
  const via = cloudProxy("agentphone");
  const res = await fetch(via ? `${via.url}/v1${path}` : `${AP}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${via ? via.key : process.env.AGENTPHONE_API_KEY}`,
      "Content-Type": "application/json",
      ...(via ? appHeaders() : {}),
      ...(!via && scope === "sub" && process.env.AGENTPHONE_SUB_ACCOUNT ? { "X-Sub-Account-Id": process.env.AGENTPHONE_SUB_ACCOUNT } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as T & { detail?: string; error?: string | { message?: string }; code?: unknown };
  if (!res.ok) {
    // AgentPhone's own words, or Bops Cloud's (a string, with its code: out of AI credit is 402).
    const said = typeof json.error === "string" ? json.error : (json.error?.message ?? json.detail ?? `AgentPhone ${res.status}`);
    if (!via) throw new Error(said);
    const e = new CloudError(said, res.status, typeof json.code === "string" ? json.code : undefined);
    noteOutOfCredit(e);
    throw e;
  }
  return json;
}

/* ---------------- Numbers ---------------- */

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
/** "+15551234567" → "+1 (555) 123-4567". */
export const prettyPhone = (e164: string) => {
  const d = e164.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e164;
};
/** A phone number anywhere in a string (a SIP header like "<sip:+15551234567@…>"). */
const numberIn = (s: string) => /(\+?\d[\d\s().-]{8,}\d)/.exec(s)?.[1]?.replace(/[^\d+]/g, "") ?? "";

/** Numbers in BOPS_OWNER_PHONES: a self-hosting override that counts as the user without a texted code. Don't set it on a hosted server. */
const envOwnerPhones = () => (process.env.BOPS_OWNER_PHONES ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** The numbers saved in Settings that are the signed-in user's (ofThisUser: another Orgo account signed in here doesn't inherit them). */
const savedPhones = () => (getState().ownerPhones ?? []).filter(ofThisUser);

/**
 * The user's own numbers: the ones they added in Settings (How your bots reach you) and verified
 * with a texted code (with their OK to get texts), plus BOPS_OWNER_PHONES. A text or call from one
 * is the user, and only these get texts meant for the user. A number saved but not verified counts
 * as anyone else.
 */
export const ownerPhones = () => [...new Set([...savedPhones().filter((p) => p.verifiedAt).map((p) => p.number), ...envOwnerPhones()])];

/** Whether a number is one of the user's verified ones (see ownerPhones). */
export const isOwner = (n: string) => !!n && ownerPhones().some((o) => digits(o) === digits(n));

/** Who sent a delivery, as Bops Cloud said (CLOUD_CALLER_HEADER, or `bopsCaller` in a kept one); undefined when it didn't say. */
export function verdictOf(x: unknown): CallerVerdict | undefined {
  let v = x;
  if (typeof v === "string")
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  const o = v as { owner?: unknown; claimed?: unknown } | null;
  if (!o || typeof o.owner !== "boolean") return undefined;
  return { owner: o.owner, ...(o.claimed === "call" || o.claimed === "text" ? { claimed: o.claimed } : {}) };
}

/** Whether a delivery is from the user: what Bops Cloud said when it said, else (self-hosting) one of their verified numbers. */
export const fromOwner = (n: string, verdict?: CallerVerdict) => (verdict ? verdict.owner : isOwner(n));

/**
 * A number just claimed one of the bots' lines (the first to call or text it in its 15 minutes, as
 * Bops Cloud decided): it's one of the user's own numbers now, and the bot's chat says so.
 */
export function linkClaimed(number: string, via: "call" | "text", b: Bot) {
  const e164 = toE164(number);
  if (!e164) return;
  const userId = getState().account?.user.id;
  const at = Date.now();
  if (!savedPhones().some((p) => p.verifiedAt && digits(p.number) === digits(e164)))
    update((s) => {
      s.ownerPhones = [...(s.ownerPhones ?? []).filter((p) => digits(p.number) !== digits(e164) || !ofThisUser(p)), { number: e164, consentAt: at, verifiedAt: at, claimedVia: via, ...(userId ? { userId } : {}) }];
    });
  const line = lineOf(b);
  addMessage({
    chatId: botChatId(b.id),
    role: "system",
    text: `Linked your phone ${prettyPhone(e164)} to ${line ? `${b.name}'s number ${prettyPhone(line.phone)}` : b.name}: it ${via === "call" ? "called" : "texted"} first, so calls and texts from it count as you now.`,
  });
  callLog({ event: "line claimed", bot: b.id, from: e164, via });
}

/** Who's asking, for the verification limits and pending codes: on a hosted server the signed-in user, else this install. */
const verifier = () => (onPostgres() ? `u:${getState().account?.user.id ?? "nobody"}` : `i:${installId()}`);

/**
 * Settings (How your bots reach you), step one: the user enters their mobile and agrees to texts,
 * and a code is texted to it. Nothing is saved until the code comes back (checkOwnerPhone). On a
 * hosted server, a number another user already verified is refused here, before a text is paid for.
 */
export async function startOwnerPhone(number: string, consent: boolean) {
  const e164 = toE164(number);
  if (!e164) return { ok: false as const, error: "That doesn't look like a phone number." };
  // A resend, or a number saved before verification existed, already has the user's OK to texts; a new one needs the box ticked.
  const prior = pendingConsentAt(e164, verifier()) ?? savedPhones().find((p) => digits(p.number) === digits(e164))?.consentAt;
  if (!consent && !prior) return { ok: false as const, error: "Tick the box to agree to texts first." };
  if (onPostgres()) {
    const user = getState().account?.user.id;
    const table = ownerPhoneTable();
    if (!user || !table) return { ok: false as const, error: "Sign in first." };
    const taken = await table.takenByOther(user, e164).catch((e: Error) => (console.warn(`[phone] owner_phones: ${e.message}`), null));
    if (taken === null) return { ok: false as const, error: "Couldn't check that number right now. Try again in a minute." };
    if (taken) return { ok: false as const, error: "That number is already verified on another Bops account." };
  }
  return startVerification("sms", e164, verifier(), consent ? Date.now() : prior!);
}

/**
 * Step two: the code the user typed. Right, and the number is theirs: saved with when they agreed to
 * texts and when it was verified (and, on a hosted server, claimed in bops.owner_phones first, so
 * two accounts can never both have it).
 */
export async function checkOwnerPhone(number: string, code: string) {
  const e164 = toE164(number);
  if (!e164) return { ok: false as const, error: "That doesn't look like a phone number." };
  const r = await checkVerification("sms", e164, verifier(), code);
  if (!r.ok) return r;
  if (onPostgres()) {
    const user = getState().account?.user.id;
    const table = ownerPhoneTable();
    if (!user || !table) return { ok: false as const, error: "Sign in first.", restart: true };
    const claimed = await table.claim(user, e164, r.consentAt, r.ref).catch((e: Error) => (console.warn(`[phone] owner_phones: ${e.message}`), null));
    if (!claimed) return { ok: false as const, error: "Couldn't save the number right now. Send a new code and try again.", restart: true };
    if (!claimed.ok) return { ok: false as const, error: "That number is already verified on another Bops account.", restart: true };
  }
  const verifiedAt = Date.now();
  const userId = getState().account?.user.id;
  update((s) => {
    s.ownerPhones = [...(s.ownerPhones ?? []).filter((p) => digits(p.number) !== digits(e164)), { number: e164, consentAt: r.consentAt, verifiedAt, ...(userId ? { userId } : {}) }];
  });
  return { ok: true as const };
}

/** One of the signed-in user's numbers no longer counts as them (and a code out for it is dropped). */
export async function removeOwnerPhone(number: string) {
  const saved = savedPhones().filter((p) => digits(p.number) === digits(number));
  update((s) => {
    s.ownerPhones = (s.ownerPhones ?? []).filter((p) => digits(p.number) !== digits(number) || !ofThisUser(p));
  });
  const e164 = toE164(number);
  if (e164) forgetVerification("sms", e164, verifier());
  const user = getState().account?.user.id;
  const table = ownerPhoneTable();
  if (onPostgres() && user && table)
    for (const p of saved) await table.release(user, p.number).catch((e: Error) => console.warn(`[phone] owner_phones: couldn't release a number: ${e.message}`));
  // On Bops Cloud it stops counting as the user there too: off every line it owns, and out of the cloud's own list.
  if (cloudOn()) await forgetOwnerNumber(e164 || number).catch((e: Error) => console.warn(`[phone] couldn't remove the number in Bops Cloud: ${e.message}`));
}

type ApNumber = { id: string; phoneNumber: string; agentId?: string | null; externalId?: string | null; outboundSms?: string; voiceRouting?: { method: string } };

/** A number AgentPhone has for sale (GET /numbers/available). */
type ApAvailable = { phoneNumber?: string; city?: string; state?: string; areaCode?: string };
/** Numbers for sale in one area code and city, as the app offers them ("628 · San Francisco, CA"). */
export type NumberOption = { areaCode: string; city: string; state: string; count: number };

const AREA_CODE = /^[2-9]\d{2}$/;
/** The area code numbers are bought in when none is picked: BOPS_PHONE_AREA, else 415. */
const defaultArea = () => (AREA_CODE.test(process.env.BOPS_PHONE_AREA ?? "") ? process.env.BOPS_PHONE_AREA! : "415");

/** The area code of the user's own mobile (a US or Canadian one), to search near them first. */
export function homeArea(): string | undefined {
  const n = ownerPhone();
  const d = n?.replace(/\D/g, "") ?? "";
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d.length === 10 ? d : "";
  return AREA_CODE.test(ten.slice(0, 3)) ? ten.slice(0, 3) : undefined;
}

/**
 * Numbers for sale near an area code (the user's own mobile's, else BOPS_PHONE_AREA or 415, when
 * none is given), grouped by area code and city, the asked code first, then the most numbers: up to
 * 8. AgentPhone answers an area code with none left with numbers nearby (415 gets 628s); one with
 * none at all nearby gets numbers anywhere in the US (`anywhere`). Nothing is bought: a number is bought by area
 * code (ensurePhone), AgentPhone has no buying one exact number.
 */
export async function searchNumbers(areaCode?: string): Promise<{ areaCode: string; options: NumberOption[]; anywhere: boolean }> {
  if (!phoneOn()) throw new Error("Phones aren't set up here yet.");
  const asked = areaCode?.trim() || homeArea() || defaultArea();
  if (!AREA_CODE.test(asked)) throw new Error("An area code is 3 digits, like 415.");
  const find = async (code?: string) =>
    (await ap<{ data?: ApAvailable[] }>("GET", `/numbers/available?${new URLSearchParams({ country: "US", ...(code ? { areaCode: code } : {}), limit: "30" })}`)).data ?? [];
  let found = await find(asked);
  const anywhere = !found.length;
  if (anywhere) found = await find();
  const groups = new Map<string, NumberOption>();
  for (const n of found) {
    const code = n.areaCode ?? digits(n.phoneNumber ?? "").slice(0, 3);
    if (!AREA_CODE.test(code)) continue;
    const city = n.city?.trim() ?? "";
    const state = n.state?.trim() ?? "";
    const key = `${code}|${city.toLowerCase()}|${state.toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { areaCode: code, city, state, count: 1 });
  }
  const options = [...groups.values()].sort((a, b) => Number(b.areaCode === asked) - Number(a.areaCode === asked) || b.count - a.count).slice(0, 8);
  return { areaCode: asked, options, anywhere };
}

/**
 * A bot's own number: found again by its tag, or bought (about $3 a month) in the area code picked
 * (searchNumbers), else BOPS_PHONE_AREA (415 unless set), with an AgentPhone agent for it. Through
 * Bops Cloud an area code with none left moves on to one nearby. Only when asked: numbers cost money.
 */
export async function ensurePhone(botId: string, areaCode?: string) {
  const b = bot(botId);
  if (!b || !phoneOn()) throw new Error("phone isn't set up");
  const area = areaCode?.trim() || defaultArea();
  if (!AREA_CODE.test(area)) throw new Error("An area code is 3 digits, like 415.");
  const tag = `bops-${installId()}-${b.id}`;
  const epoch = stateEpoch();
  const numbers = await ap<{ data: ApNumber[] }>("GET", "/numbers?limit=100");
  let number = numbers.data.find((n) => n.externalId === tag);
  let agentId = number?.agentId ?? undefined;
  const madeAgent = !agentId;
  if (!agentId) agentId = (await ap<{ id: string }>("POST", "/agents", { name: `${b.name} (Bops)`, description: tag, voiceMode: "webhook", enableMessaging: true })).id;
  if (!number) {
    number = await ap<ApNumber>("POST", "/numbers", { country: "US", areaCode: area, type: "sms", externalId: tag, agentId }).catch((e: Error) => {
      if (/no numbers available/i.test(e.message)) e.message = `No ${area} numbers are left. Search again and pick another area code.`;
      throw e;
    });
    recordUsage("phone.number", { botId }, epoch);
  } else if (!number.agentId) await ap("POST", `/agents/${agentId}/numbers`, { numberId: number.id });
  // On Bops Cloud a number's texts and calls come through its agent's own webhook, whose secret the
  // cloud keeps (it checks each delivery with it and knows whose it is); self-hosting has the sub-account's.
  if (cloudOn()) await ap("POST", `/agents/${agentId}/webhook`, { url: await hookUrl(), contextLimit: 10, timeout: 30 });
  await callsToAgent(number.id, agentId, "sub", !madeAgent);
  const line = { numberId: number.id, agentId };
  update((s) => {
    const x = s.bots.find((y) => y.id === botId);
    if (x) {
      x.phone = number!.phoneNumber;
      x.phoneLine = line;
    }
  });
  // The user is told to call or text it now: the first phone that does is theirs (Bops Cloud keeps who).
  await tellCloudLine({ numberId: number.id, botId: b.id, open: true }).catch((e: Error) => console.warn(`[phone] couldn't tell Bops Cloud about ${b.name}'s number: ${e.message}`));
  return number.phoneNumber;
}

/**
 * A Bops number's calls go to its agent, which hands each turn to Bops (voice mode "webhook"): never
 * to a SIP trunk, never ignored. Set outright after a number is made or assigned (`agentToo`: also
 * set the agent's voice mode, for an agent Bops didn't just make that way). A failure is logged, not
 * thrown: the number works for texts, and lineUpkeep tries again at the next start.
 */
async function callsToAgent(numberId: string, agentId: string, scope: "sub" | "parent", agentToo = true) {
  try {
    if (agentToo) await ap("PATCH", `/agents/${agentId}`, { voiceMode: "webhook" }, scope);
    await ap("PATCH", `/numbers/${numberId}/voice-routing`, { method: "agent" }, scope);
  } catch (e) {
    console.warn(`[phone] number ${numberId}: calls aren't routed to its agent yet: ${(e as Error).message}`);
  }
}

type ApAgentVoice = { id: string; voiceMode?: string | null };

/**
 * Once a start: each of the bots' numbers takes calls through its agent (one from before, or one
 * whose calls someone pointed at a SIP trunk or at nothing, is put back), and Bops Cloud knows which
 * bot each line is for. Answers what it changed.
 */
export async function lineUpkeep() {
  const fixed: string[] = [];
  if (!phoneOn()) return fixed;
  const lines = [
    ...(getState().workspaces ?? []).flatMap((w) => (w.line ? [{ numberId: w.line.numberId, agentId: w.line.agentId, scope: w.line.scope }] : [])),
    ...getState().bots.flatMap((b) => (b.phoneLine ? [{ ...b.phoneLine, scope: "sub" as const }] : [])),
  ];
  for (const scope of ["sub", "parent"] as const) {
    const mine = lines.filter((l) => l.scope === scope);
    if (!mine.length) continue;
    const numbers = (await ap<{ data: ApNumber[] }>("GET", "/numbers?limit=100", undefined, scope).catch(() => null))?.data ?? [];
    const agents = (await ap<{ data: ApAgentVoice[] }>("GET", "/agents?limit=100", undefined, scope).catch(() => null))?.data ?? [];
    for (const l of mine) {
      const n = numbers.find((x) => x.id === l.numberId);
      const a = agents.find((x) => x.id === l.agentId);
      if (!n) continue;
      const agentToo = !!a?.voiceMode && a.voiceMode !== "webhook";
      if (n.voiceRouting?.method === "agent" && !agentToo) continue;
      await callsToAgent(l.numberId, l.agentId, scope, agentToo);
      fixed.push(`${n.phoneNumber}: ${n.voiceRouting?.method ?? "unknown"} → agent${agentToo ? ` (voice mode ${a?.voiceMode} → webhook)` : ""}`);
    }
  }
  if (fixed.length) callLog({ event: "calls routed to agents", fixed });
  await syncCloudLines();
  return fixed;
}

/** A bot's text, plain: links written out, no markdown (a text shows it raw). */
const plain = (t: string) =>
  t
    .replace(/\n*Open: \[[^\]]*\]\(\/api\/pages\/[^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 $2")
    .replace(/\[([^\]]+)\]\((?:\/|~\/|file:)[^)]*\)/g, "$1 (in Bops)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();

/** Texted STOP (and not START since): no bot texts this number. */
const optedOut = (n: string) => (getState().smsOptOut ?? []).includes(digits(n));

type Line = Pick<WorkspaceLine, "phone" | "numberId" | "agentId" | "type" | "scope">;

/** The workspace's number, when this bot is its main bot. */
export function workspaceLine(b: Bot): WorkspaceLine | undefined {
  if (!b.isMain) return undefined;
  return getState().workspaces?.find((w) => w.id === workspaceOf(b))?.line;
}

/** The number a bot texts from: its workspace's (main bot), else its own (fallback). */
export function lineOf(b: Bot): Line | undefined {
  const ws = workspaceLine(b);
  if (ws) return ws;
  if (b.phoneLine && b.phone) return { ...b.phoneLine, phone: b.phone, type: "sms", scope: "sub" };
  return undefined;
}

/** Which bot (and number) an AgentPhone agent's event is for: a workspace's main bot, or a bot's own number. */
export function routeFor(agentId?: string): { b: Bot; line: Line } | undefined {
  if (!agentId) return undefined;
  for (const w of getState().workspaces ?? []) {
    if (w.line?.agentId !== agentId) continue;
    const main = getState().bots.find((x) => x.isMain && workspaceOf(x) === w.id);
    if (main) return { b: main, line: w.line };
  }
  const own = getState().bots.find((x) => x.phoneLine?.agentId === agentId);
  return own ? { b: own, line: lineOf(own)! } : undefined;
}

/**
 * Text someone from a bot's number. Never to a number that texted STOP (except the one
 * confirmation). An SMS number can't send until Orgo's carrier registration (A2P 10DLC) is
 * approved; an iMessage number can.
 */
export async function sendText(botId: string, to: string, body: string, opts: { evenIfStopped?: boolean; replyToAp?: string; tag?: string } = {}) {
  const b = bot(botId);
  const line = b && lineOf(b);
  if (!b || !line) throw new Error("no phone number");
  // A plan's number that's paused (the plan ended): Bops Cloud refuses its texts too (cloud/proxy.ts).
  if (b.phoneLine?.paused && b.phoneLine.numberId === line.numberId) throw new Error("the number is paused while the account is on Free, so no texts go out from it");
  if (optedOut(to) && !opts.evenIfStopped) throw new Error("they texted STOP, so no more texts to them");
  const text = plain(body).slice(0, 1500);
  if (dryRun()) {
    addMessage({ chatId: botChatId(b.id), role: "system", text: `[dry run] would text ${prettyPhone(to)} from ${prettyPhone(line.phone)} (${line.type})${opts.replyToAp ? " as a threaded reply" : ""}: ${text}` });
    return;
  }
  // iMessage threads a reply under the message it answers (an inline reply in Bops).
  const replyTo = opts.replyToAp && line.type === "imessage" ? { reply_to_message_id: opts.replyToAp } : {};
  const sent = await ap<{ id?: string; status?: string; conversation_id?: string }>("POST", "/messages", { agent_id: line.agentId, number_id: line.numberId, to_number: to, body: text, ...replyTo }, line.scope);
  // The Bops message it came from remembers its phone-side id (for tapbacks on it, and replies to it).
  if (opts.tag && sent.id) tagPhone(opts.tag, { apId: sent.id, conversationId: sent.conversation_id });
  // AgentPhone accepts a text first and delivers it after: a failure only shows up a moment later,
  // so look again and say so in the chat when it didn't go through.
  if (sent.id) setTimeout(() => void checkDelivered(b, line, sent.id!, to), 10_000);
}

function tagPhone(messageId: string, phone: { apId?: string; conversationId?: string; from?: string }) {
  update((s) => {
    const m = s.messages.find((x) => x.id === messageId);
    if (m) m.phone = { ...m.phone, ...phone };
  });
}

/** A tapback on a phone message (iMessage only): the classic six, or an emoji on newer lines. */
async function tapbackOut(line: Line, apId: string, r: { type?: Tapback; emoji?: string }, chatId?: string) {
  const reaction = r.type ?? r.emoji;
  if (line.type !== "imessage" || !reaction) return;
  if (dryRun()) {
    if (chatId) addMessage({ chatId, role: "system", text: `[dry run] would tapback "${reaction}" on the text ${apId}` });
    return;
  }
  await ap("POST", `/messages/${apId}/reactions`, { reaction }, line.scope).catch((err: Error) => console.warn(`[phone] tapback: ${err.message}`));
}

/** "…is typing" in the conversation while the bot works (iMessage, best effort; it fades by itself). */
function typing(line: Line, conversationId?: string) {
  if (line.type !== "imessage" || !conversationId || dryRun()) return () => {};
  const ping = () => void ap("POST", `/conversations/${conversationId}/typing`, {}, line.scope).catch(() => {});
  ping();
  const t = setInterval(ping, 4000);
  return () => clearInterval(t);
}

async function checkDelivered(b: Bot, line: Line, messageId: string, to: string) {
  const recent = await ap<{ data?: { id: string; status?: string; failureReason?: string | null }[] }>("GET", `/numbers/${line.numberId}/messages?limit=20`, undefined, line.scope).catch(() => null);
  const m = recent?.data?.find((x) => x.id === messageId);
  if (m?.status === "failed")
    addMessage({ chatId: botChatId(b.id), role: "system", text: `${b.name}'s text to ${prettyPhone(to)} didn't go through (${line.type}): ${m.failureReason ?? "it couldn't be delivered"}` });
}

/** The number a bot texts the user through: its own line, or its workspace's (via the main bot). */
export function textingLine(b: Bot): { from: Bot; line: Line } | undefined {
  const own = lineOf(b);
  if (own) return { from: b, line: own };
  const main = getState().bots.find((x) => x.isMain && workspaceOf(x) === workspaceOf(b));
  const ws = main && lineOf(main);
  return main && ws ? { from: main, line: ws } : undefined;
}

/** Where the user gets texts: the number they last texted from, else their first verified number. Never an unverified one. */
export function ownerPhone(): string | undefined {
  const last = [...getState().messages].reverse().find((m) => m.via === "sms" && m.phone?.from);
  // Only while it's still one of their verified numbers: a removed one gets nothing more.
  return last?.phone?.from && isOwner(last.phone.from) ? last.phone.from : ownerPhones()[0];
}

/**
 * The text_me tool: a text to the user (only them, so no approval) from the workspace's number. A
 * specialist's text goes out from the coordinator's number with its name on it ("Max: …").
 */
export async function textOwner(botId: string, body: string) {
  const b = bot(botId);
  const via = b && textingLine(b);
  const to = ownerPhone();
  if (!b || !via) return "There's no phone number to text from yet.";
  if (!to) return `${ownerName()} hasn't added a verified mobile number yet (Settings, How your bots reach you).`;
  const text = via.from.id === b.id ? body : `${b.name}: ${body}`;
  const m = addMessage({ chatId: botChatId(b.id), role: "system", text: `Texted you: ${body}` });
  await sendText(via.from.id, to, text, { tag: m.id });
  return `Texted ${ownerName()} from ${prettyPhone(via.line.phone)}.`;
}

/**
 * A thread started from the user's text finished (or failed): its result goes back to them from the same
 * number, from the coordinator, naming the bot that did it when it wasn't the coordinator.
 */
export function textResult(s: { textBack?: { botId: string; to: string }; botId: string }, text: string) {
  // Only to a number that's still the user's (verified; it may have been removed since they texted).
  if (!s.textBack || !isOwner(s.textBack.to)) return;
  const by = s.botId !== s.textBack.botId ? bot(s.botId)?.name : undefined;
  void sendText(s.textBack.botId, s.textBack.to, by ? `${by}: ${text}` : text).catch((err: Error) =>
    addMessage({ chatId: botChatId(s.textBack!.botId), role: "system", text: `Couldn't text this result back to you: ${err.message}` }),
  );
}

/* ---------------- Texts in ---------------- */

export type ApEvent = {
  event?: string;
  channel?: string;
  agentId?: string;
  data?: {
    callId?: string;
    call_id?: string;
    id?: string;
    messageId?: string;
    message_id?: string;
    conversationId?: string;
    conversation_id?: string;
    body?: string;
    message?: string;
    fromNumber?: string;
    toNumber?: string;
    from?: string;
    to?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    transcript?: string;
    reactionType?: string;
    replyTo?: string | { messageId?: string; id?: string } | null;
    reply_to_message_id?: string;
    group?: { groupId?: string; groupName?: string | null } | null;
    senderIdentifier?: string;
  };
};

/**
 * One AgentPhone webhook delivery that isn't a call's turn (the webhook route answers those through
 * phone-voice.ts): texts are handled after the webhook has been answered. `verdict` is who sent it,
 * as Bops Cloud decided (bops.phone_lines); without one (self-hosting), the verified numbers here.
 */
export function agentPhoneEvent(e: ApEvent, deliveryId: string, verdict?: CallerVerdict): Record<string, unknown> {
  const to = routeFor(e.agentId);
  // A call's turn handed over late (the call is long over): nobody to speak to.
  if (e.channel === "voice") return { ok: true };
  if (to && e.event === "agent.message") void inLine(to.b.id, () => textIn(to.b, to.line, e, deliveryId, verdict));
  if (to && e.event === "agent.reaction") tapbackIn(e, verdict);
  return { ok: true };
}

const apIdOf = (d: NonNullable<ApEvent["data"]>) => d.id ?? d.messageId ?? d.message_id;
const replyToOf = (d: NonNullable<ApEvent["data"]>) =>
  typeof d.replyTo === "string" ? d.replyTo : (d.replyTo?.messageId ?? d.replyTo?.id ?? d.reply_to_message_id ?? undefined);

/** Someone tapbacked one of the bot's texts: the same tapback on that message in Bops. */
function tapbackIn(e: ApEvent, verdict?: CallerVerdict) {
  const d = e.data ?? {};
  const target = getState().messages.find((m) => m.phone?.apId && m.phone.apId === (d.messageId ?? d.message_id));
  if (!target || !d.reactionType) return;
  const from = d.fromNumber ?? d.from ?? "";
  const r = (TAPBACKS as readonly string[]).includes(d.reactionType) ? { type: d.reactionType as Tapback } : { emoji: d.reactionType };
  if (fromOwner(from, verdict)) react(target.id, "owner", r);
}

async function textIn(b: Bot, line: Line, e: ApEvent, deliveryId: string, verdict?: CallerVerdict) {
  const d = e.data ?? {};
  const apId = apIdOf(d);
  const conversationId = d.conversationId ?? d.conversation_id;
  const key = apId ?? deliveryId;
  if (state.handled.has(key) || getState().messages.some((m) => m.sms?.id === key || (!!apId && m.phone?.apId === apId))) return;
  state.handled.add(key);
  const from = d.fromNumber ?? d.from ?? "";
  const body = (d.body ?? d.message ?? "").trim();
  // The standard keywords first (carriers require them to work): STOP and its variants, START, HELP.
  const keyword = body.toLowerCase().replace(/[^a-z]/g, "");
  if (STOP_WORDS.has(keyword) || START_WORDS.has(keyword) || HELP_WORDS.has(keyword)) return keywordIn(b, from, keyword);
  // Bots only talk to their owner by phone: a text from anyone else is dropped (it never reaches
  // the bot or the chat). In a group, it's who sent it that counts. On Bops Cloud the cloud says who
  // it is; a first text to a new line in its 15 minutes makes the sender the owner.
  const sender = d.group?.groupId ? (d.senderIdentifier ?? from) : from;
  if (!fromOwner(sender, verdict)) {
    callLog({ event: "text ignored", bot: b.id, from: sender, why: "not the owner" });
    return;
  }
  if (verdict?.claimed === "text") {
    linkClaimed(sender, "text", b);
    await sendText(b.id, sender, "Linked. Texts and calls from this phone count as you now.").catch(() => {});
  }
  const images = await picsOf([...(d.mediaUrls ?? []), ...(d.mediaUrl ? [d.mediaUrl] : [])]);
  const chatId = botChatId(b.id);
  // An iMessage group the number is in: shown in the chat, never answered one-to-one (that would
  // start a separate thread with whoever wrote). Answering groups is a later step.
  if (d.group?.groupId) {
    const who = d.senderIdentifier ?? from;
    addMessage({ chatId, role: "system", text: `${body || "(a picture)"}`, images: images.length ? images : undefined, sms: { dir: "in", from: `${who} in "${d.group.groupName ?? "a group"}"`, to: line.phone, id: key } });
    return;
  }
  // The user texting: their message in the chat, and the answer back to their phone.
  const { handleMessage } = await import("./chat");
  // An inline reply in iMessage stays one in Bops: the message it answers, found by its phone id.
  const parentAp = replyToOf(d);
  const parent = parentAp ? getState().messages.find((m) => m.chatId === chatId && m.phone?.apId === parentAp) : undefined;
  const stopTyping = typing(line, conversationId);
  let mine: Awaited<ReturnType<typeof handleMessage>>;
  try {
    mine = await handleMessage(chatId, body || "(a picture)", parent?.id, images.length ? images : undefined, "sms", { apId, conversationId, from });
  } finally {
    stopTyping();
  }
  if (!mine) return;
  // Work it started (its own threads, or a teammate's it handed off) texts its result back too.
  for (const t of getState().sessions.filter((x) => x.chatId === chatId && x.createdAt >= mine.at && !x.textBack)) patchSession(t.id, { textBack: { botId: b.id, to: from } });
  // The bot's answer, as it gave it in Bops: each message its own bubble, threaded where it was an
  // inline reply, and a tapback as a tapback (never a filler text in its place).
  const replies = getState().messages.filter((m) => m.chatId === chatId && m.role === "bot" && m.botId === b.id && m.at >= mine.at);
  const failed = (err: Error) =>
    addMessage({ chatId, role: "system", text: `Couldn't text this back to you: ${/regist/i.test(err.message) ? "texting from this number waits on carrier approval" : err.message}` });
  for (const r of replies) {
    const rootAp = r.replyTo ? getState().messages.find((m) => m.id === r.replyTo)?.phone?.apId : undefined;
    await sendText(b.id, from, r.text, { replyToAp: rootAp, tag: r.id }).catch(failed);
  }
  const tapback = getState().messages.find((m) => m.id === mine.id)?.reactions?.find((x) => x.by === b.id);
  if (tapback && apId) await tapbackOut(line, apId, tapback, chatId);
  // Nothing said and nothing reacted (rare): a short acknowledgement, so the text isn't left hanging.
  if (!replies.length && !tapback) await sendText(b.id, from, "Got it.").catch(failed);
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke"]);
const START_WORDS = new Set(["start", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);
/** The HELP reply carriers require; the contact is BOPS_SUPPORT_EMAIL. */
const helpText = () =>
  `Bops by Orgo: texts from your Bops assistants. Msg & data rates may apply. Reply STOP to opt out.${process.env.BOPS_SUPPORT_EMAIL ? ` Help: ${process.env.BOPS_SUPPORT_EMAIL}` : ""}`;

/** STOP: no more texts to that number (one confirmation); START: texts again; HELP: what this is and how to stop. */
async function keywordIn(b: Bot, from: string, keyword: string) {
  const chatId = botChatId(b.id);
  const n = digits(from);
  let reply: string;
  if (STOP_WORDS.has(keyword)) {
    update((s) => void (s.smsOptOut = [...new Set([...(s.smsOptOut ?? []), n])]));
    reply = "Bops by Orgo: you're unsubscribed and won't get more texts. Reply START to resubscribe.";
    addMessage({ chatId, role: "system", text: `${prettyPhone(from)} texted STOP: no more texts to that number until they text START` });
  } else if (START_WORDS.has(keyword)) {
    update((s) => void (s.smsOptOut = (s.smsOptOut ?? []).filter((x) => x !== n)));
    reply = "Bops by Orgo: you're subscribed again. Reply STOP to opt out, HELP for help.";
    addMessage({ chatId, role: "system", text: `${prettyPhone(from)} texted START: texts to that number are back on` });
  } else reply = helpText();
  await sendText(b.id, from, reply, { evenIfStopped: true }).catch(() => {});
}

/** Pictures in a text, saved like attached images. */
async function picsOf(urls: string[]) {
  const out: { id: string; type: string }[] = [];
  for (const url of urls.slice(0, 4)) {
    try {
      const res = await fetch(url);
      const type = (res.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) continue;
      out.push(saveUpload(`data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`));
    } catch {}
  }
  return out;
}

/* ---------------- Catching up ---------------- */

/**
 * Texts that came in while Bops couldn't be reached (asleep, offline, a network change): AgentPhone
 * retries only after 5 and 30 minutes, so Bops also looks itself, every 2 minutes and at start, at each workspace number's latest messages. Only ones newer than the
 * number's assignment and not already handled; a late retry of the same text is then skipped.
 */
export async function phoneCatchUp() {
  const found: string[] = [];
  if (!phoneOn()) return found;
  for (const w of getState().workspaces ?? []) {
    const line = w.line;
    const main = line && getState().bots.find((b) => b.isMain && workspaceOf(b) === w.id);
    if (!line || !main) continue;
    const recent = await ap<{ data?: { id: string; body?: string; from_?: string; fromNumber?: string; to?: string; direction?: string; channel?: string; receivedAt?: string }[] }>(
      "GET",
      `/numbers/${line.numberId}/messages?limit=20`,
      undefined,
      line.scope,
    ).catch(() => null);
    const missed = (recent?.data ?? [])
      .filter((m) => m.direction === "inbound" && Date.parse(m.receivedAt ?? "") > line.at)
      .filter((m) => !state.handled.has(m.id) && !getState().messages.some((x) => x.phone?.apId === m.id || x.sms?.id === m.id))
      // Texts from before messages carried their phone id: the same words, texted, within 2 minutes.
      .filter((m) => !getState().messages.some((x) => x.via === "sms" && x.text.trim() === (m.body ?? "").trim() && Math.abs(x.at - Date.parse(m.receivedAt ?? "")) < 120_000))
      .reverse();
    for (const m of missed) {
      found.push(`${m.id} ${m.body ?? ""}`.slice(0, 60));
      const e: ApEvent = { event: "agent.message", channel: m.channel, agentId: line.agentId, data: { id: m.id, message: m.body, fromNumber: m.from_ ?? m.fromNumber, toNumber: m.to } };
      void inLine(main.id, () => textIn(main, line, e, m.id));
    }
  }
  return found;
}

const gp = globalThis as unknown as { bopsPhoneCatchUp?: ReturnType<typeof setInterval>; bopsPhoneTick?: () => Promise<unknown>; bopsPhoneUpkeepFor?: string };
// The missed texts, and on Bops Cloud each bot's voice, which the cloud answers its calls in while the Mac is away.
gp.bopsPhoneTick = () => (stateReady() ? Promise.all([phoneCatchUp(), cloudOn() ? rememberVoices() : null]) : Promise.resolve());
/**
 * Started by the state route (like mail): one timer, and for each user whose state comes in (a start,
 * or another account signing in on this Mac) a look right away and their numbers' upkeep (lineUpkeep).
 */
export function startPhone() {
  if (!phoneOn() || !stateReady()) return;
  gp.bopsPhoneCatchUp ??= setInterval(() => void gp.bopsPhoneTick?.().catch(() => {}), 2 * 60_000);
  const who = stateUser() ?? "";
  if (gp.bopsPhoneUpkeepFor === who) return;
  gp.bopsPhoneUpkeepFor = who;
  void gp.bopsPhoneTick?.().catch(() => {});
  void lineUpkeep().catch((e: Error) => console.warn(`[phone] numbers' upkeep: ${e.message}`));
}

/* ---------------- Calls ---------------- */

const header = (e: LiveTransportIncomingWebhookEvent, name: string) =>
  e.data.sip_headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/**
 * Someone is calling a bot's number (OpenAI's `live.transport.incoming`). Answer with GPT-Live set
 * up as the in-app call is, then run the call from here over the sideband.
 */
export async function incomingCall(e: LiveTransportIncomingWebhookEvent, verdict?: CallerVerdict) {
  const sessionId = e.data.session_id;
  if (state.calls.has(sessionId)) return;
  state.calls.add(sessionId);
  const headers = e.data.sip_headers.map((h) => ({ name: h.name, value: h.value }));
  callLog({ sessionId, event: "incoming", headers });
  try {
    const b = calledBot(e);
    // The caller: From, else P-Asserted-Identity (some carriers put the real number there).
    const from = numberIn(header(e, "From")) || numberIn(header(e, "P-Asserted-Identity"));
    if (!b) {
      callLog({ sessionId, event: "rejected", why: "no bot has the number that was called" });
      await openai.live.sessions.reject(sessionId, { status_code: 404 }).catch(() => {});
      return;
    }
    // Bots only take calls from their owner (on Bops Cloud, whoever the cloud says): anyone else is turned away before it connects.
    if (!fromOwner(from, verdict)) {
      callLog({ sessionId, event: "rejected", bot: b.id, from, why: "not the owner" });
      await openai.live.sessions.reject(sessionId, { status_code: 403 }).catch(() => {});
      return;
    }
    await openai.live.sessions.accept(sessionId, {
      session: {
        type: "live",
        model: "gpt-live-1",
        instructions: await voicePrompt(b),
        audio: { output: { voice: await voiceFor(b) } },
        delegation: { type: "client" },
      },
    } as never);
    callLog({ sessionId, event: "accepted", bot: b.id, from });
    if (verdict?.claimed) linkClaimed(from, verdict.claimed, b);
    runCall(b, sessionId, from);
  } catch (err) {
    // Out of AI credit: the cloud turns the call away instead (its own check), and the chat shows why.
    noteOutOfCredit(err);
    callLog({ sessionId, event: "error", error: (err as Error).message });
    throw err;
  }
}

/**
 * Which bot a call is for. The trunk dials OpenAI's address (sip:proj_…@sip.api.openai.com), so the
 * number that was called may not be in To: look for a known number in every header, To first. If
 * none is there and exactly one bot's number sends calls to OpenAI, it's that one.
 */
function calledBot(e: LiveTransportIncomingWebhookEvent): Bot | undefined {
  const known: { digits: string; bot: Bot }[] = [];
  for (const w of getState().workspaces ?? []) {
    const main = getState().bots.find((x) => x.isMain && workspaceOf(x) === w.id);
    if (w.line && main) known.push({ digits: digits(w.line.phone), bot: main });
  }
  for (const b of getState().bots) if (b.phone && b.phoneLine) known.push({ digits: digits(b.phone), bot: b });
  const values = [header(e, "To"), ...e.data.sip_headers.filter((h) => !/^from$/i.test(h.name)).map((h) => h.value)];
  for (const v of values) {
    const hit = known.find((k) => v.replace(/\D/g, "").includes(k.digits));
    if (hit) return hit.bot;
  }
  // Only bots' own numbers can send calls to OpenAI (iMessage lines can't be trunked).
  const trunked = getState().bots.filter((b) => b.phone && b.phoneLine);
  return trunked.length === 1 ? trunked[0] : undefined;
}

/** An OpenAI webhook event arrived (any type), for the call log. */
export const logWebhook = (type: string, id?: string) => callLog({ event: "webhook", type, id });

/** Each incoming call (its SIP headers or turns) and what Bops did, kept on this Mac in the user's folder (.data/users/<id>/phone-calls.jsonl) to debug calls. */
export function callLog(entry: Record<string, unknown>) {
  const dir = userDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "phone-calls.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {}
}

/** The call, from Bops' side: the greeting, the transcript, what the user asks for done, and the note after. */
function runCall(b: Bot, sessionId: string, from: string) {
  // The account whose call this is: after a sign-out or another account's sign-in, nothing of it lands in the new one.
  const ours = sameState();
  const sb = new SidebandWS(openai, { session_id: sessionId });
  const transcript: { who: string; text: string }[] = [];
  let heard = "";
  let startedAt = 0;
  let closed = false;
  const say = (content: string, delegationId: string | null) => sb.send({ type: "session.commentary.append", delegation_id: delegationId, content } as never);
  const turn = (who: string, delta: string) => {
    const last = transcript.at(-1);
    if (last?.who === who) last.text += delta;
    else transcript.push({ who, text: delta });
  };
  const followUp = async (delegationId: string, threadId: string) => {
    for (let i = 0; i < 120 && !closed; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const t = getState().sessions.find((x) => x.id === threadId);
      if (!t || live(t)) continue;
      if (!closed) say(t.status === "done" ? `"${t.title}" is done: ${t.answer ?? "finished"}` : `"${t.title}" didn't finish: ${t.error ?? "it stopped"}`, delegationId);
      return;
    }
  };
  sb.on("event", (ev) => {
    const event = ev as { type: string; delta?: string; delegation?: { id: string; target?: string } };
    // Everything but the word-by-word transcript and the audio itself goes in the call log (the transcript goes in at the end).
    if (!event.type.endsWith(".delta") && !event.type.endsWith("audio.append")) callLog({ sessionId, event: `sideband ${event.type}`, data: JSON.stringify(ev).slice(0, 800) });
    if (event.type === "session.started") {
      startedAt = Date.now();
      callStarted(b.id);
      // The bot speaks first, the way anyone picks up a call (the same words as in the app).
      say(`You just picked up the call. Say only: "Hello? Can you hear me?" Then wait for ${ownerName()}.`, null);
    } else if (event.type === "session.input_transcript.delta" && event.delta) {
      turn("owner", event.delta);
      heard += event.delta;
    } else if (event.type === "session.output_transcript.delta" && event.delta) {
      turn("bot", event.delta);
    } else if (event.type === "session.delegation.created" && event.delegation?.target === "client") {
      const id = event.delegation.id;
      const request = heard.trim();
      heard = "";
      if (!ours()) return say("I can't do that right now.", id);
      void delegate(b.id, request)
        .then((r) => {
          say(r.result, id);
          for (const t of r.sessionIds) void followUp(id, t);
        })
        .catch(() => say("I couldn't reach my computer just now.", id));
    } else if (event.type === "session.closed") {
      finish();
    }
  });
  sb.on("close", () => finish());
  sb.on("error", (err) => {
    console.warn(`[phone] call ${sessionId}: ${err.message}`);
    callLog({ sessionId, event: "sideband error", error: err.message });
  });

  function finish() {
    if (closed) return;
    closed = true;
    if (!ours()) {
      try {
        sb.close();
      } catch {}
      callEnded();
      return;
    }
    const seconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    // Every phone call's minutes, the user's and anyone else's (endCall counts only calls in the app).
    recordCallMinutes(b.id, seconds);
    callLog({ sessionId, event: "ended", seconds: Math.round(seconds), transcript: transcript.map((t) => `${t.who}: ${t.text.trim()}`).join("\n").slice(0, 4000) });
    try {
      sb.close();
    } catch {}
    callEnded();
    endCall(b.id, seconds, transcript, from);
  }
}

/**
 * A call Bops Cloud answered while this Mac was away (asleep, off or offline), handed over by the
 * tunnel once it's back, as a message in the bot's chat with the call as text. The owner's (the cloud
 * decided who that is): their note. Anyone else's (the bot only took a message, cloud/voice.ts): the
 * message they left, with a chime. A first call that claimed the line makes that number the user's
 * here too. The cloud hands an event over again if its acknowledgment was lost: it's added once.
 */
export function cloudCall(p: CloudCallPayload, eventId: string) {
  const key = `cloud-call:${eventId}`;
  if (getState().messages.some((m) => m.sms?.id === key)) return;
  const b = bot(p.botId) ?? getState().bots.find((x) => x.isMain);
  if (!b) return;
  const seconds = Math.max(0, Math.round((Date.parse(p.endedAt) - Date.parse(p.startedAt)) / 1000)) || 0;
  if (p.owner !== true) {
    const m = p.message;
    const left = m
      ? `someone called and left a message${m.name ? ` (${m.name})` : ""}: "${m.text}"${m.callback ? ` Reach them at ${m.callback}.` : ""}`
      : "someone called and didn't leave a message.";
    addMessage({
      chatId: botChatId(b.id),
      role: "system",
      text: `While your Mac was away, ${left}${p.transcript?.trim() ? `\n\n${p.transcript.trim().slice(0, 6000)}` : ""}`,
      sms: { dir: "in", from: p.from ?? "", to: lineOf(b)?.phone ?? b.phone ?? "", id: key },
      call: { seconds, phone: p.from },
      ...(m ? { ping: true } : {}),
    });
    return;
  }
  if (p.claimed === "call") linkClaimed(p.from, "call", b);
  const said = p.message?.text ? ` called: "${p.message.text}"` : " called.";
  addMessage({
    chatId: botChatId(b.id),
    role: "system",
    text: `While your Mac was away, you${said}${p.transcript?.trim() ? `\n\n${p.transcript.trim().slice(0, 6000)}` : ""}`,
    sms: { dir: "in", from: p.from ?? "", to: lineOf(b)?.phone ?? b.phone ?? "", id: key },
    call: { seconds, phone: p.from },
  });
}

/** After a rename: the bot's AgentPhone agents carry its new name (its own number's, and its workspace number's). */
export async function renameAgents(botId: string) {
  const b = bot(botId);
  if (!b || !phoneOn()) return;
  if (b.phoneLine?.agentId) await ap("PATCH", `/agents/${b.phoneLine.agentId}`, { name: `${b.name} (Bops)` });
  const ws = getState().workspaces?.find((w) => w.id === workspaceOf(b));
  if (b.isMain && ws?.line?.agentId) await ap("PATCH", `/agents/${ws.line.agentId}`, { name: `Bops · ${ws.name} (${b.name})` }, ws.line.scope);
}

/* ---------------- A workspace's number ---------------- */

type ApAgent = { id: string; name: string; description?: string | null; numbers?: { id: string; phoneNumber: string }[] };

/**
 * Make an existing AgentPhone number the workspace's number: a Bops agent (made once per workspace,
 * tagged bops-<install>-ws-<workspace>) gets the number, and the agent's webhook is Bops. The agent
 * it came from (with its webhook) is left exactly as it was, minus the number, and remembered for
 * rollback. Only the one number named is touched; it must be found exactly once.
 */
export async function assignWorkspaceLine(workspaceId: string, phoneNumber: string, scope: "parent" | "sub") {
  const ws = getState().workspaces?.find((w) => w.id === workspaceId);
  const main = getState().bots.find((b) => b.isMain && workspaceOf(b) === workspaceId);
  if (!ws || !main) throw new Error("no such workspace, or it has no main bot");
  const url = await hookUrl();
  if (!url) throw new Error(cloudOn() ? "Bops Cloud didn't say where texts go" : "BOPS_AGENTPHONE_HOOK_URL isn't set");
  const numbers = (await ap<{ data: (ApNumber & { type?: string })[] }>("GET", "/numbers?limit=100", undefined, scope)).data.filter((n) => digits(n.phoneNumber) === digits(phoneNumber));
  if (numbers.length !== 1) throw new Error(`expected exactly one ${phoneNumber} in that account, found ${numbers.length}`);
  const number = numbers[0];
  const tag = `bops-${installId()}-ws-${workspaceId}`;
  const agents = (await ap<{ data: ApAgent[] }>("GET", "/agents?limit=100", undefined, scope)).data;
  const previousId = number.agentId ?? null;
  const previous = previousId ? agents.find((a) => a.id === previousId) : undefined;
  const previousHook = previousId ? await ap<{ url?: string } | null>("GET", `/agents/${previousId}/webhook`, undefined, scope).catch(() => null) : null;
  let agent = agents.find((a) => a.description === tag);
  const madeAgent = !agent;
  if (!agent) agent = await ap<ApAgent>("POST", "/agents", { name: `Bops · ${ws.name} (${main.name})`, description: tag, voiceMode: "webhook", enableMessaging: true }, scope);
  if (previousId && previousId !== agent.id) await ap("DELETE", `/agents/${previousId}/numbers/${number.id}`, undefined, scope);
  if (previousId !== agent.id) await ap("POST", `/agents/${agent.id}/numbers`, { numberId: number.id }, scope);
  const hook = await ap<{ secret?: string; url?: string }>("POST", `/agents/${agent.id}/webhook`, { url, contextLimit: 10, timeout: 30 }, scope);
  await callsToAgent(number.id, agent.id, scope, !madeAgent);
  // Through Bops Cloud the secret stays there (its deliveries come over the tunnel): only a real one is kept here.
  const secrets = secretsFile();
  if (hook.secret && hook.secret !== KEPT_BY_CLOUD && !cloudOn() && secrets) {
    mkdirSync(dirname(secrets), { recursive: true });
    writeFileSync(secrets, JSON.stringify({ ...agentSecrets(), [agent.id]: hook.secret }, null, 2), { mode: 0o600 });
  }
  const line: WorkspaceLine = {
    phone: number.phoneNumber,
    numberId: number.id,
    agentId: agent.id,
    type: number.type === "imessage" ? "imessage" : "sms",
    scope,
    // Keep what was there before the first assignment (re-running this mustn't overwrite it with the Bops agent).
    previous: ws.line?.numberId === number.id && ws.line.previous ? ws.line.previous : { agentId: previousId, webhookUrl: previousHook?.url ?? null },
    at: Date.now(),
  };
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === workspaceId);
    if (w) w.line = line;
  });
  await tellCloudLine({ numberId: number.id, botId: main.id, workspaceId, open: true }).catch((e: Error) => console.warn(`[phone] couldn't tell Bops Cloud about ${ws.name}'s number: ${e.message}`));
  return { line, agent: { id: agent.id, name: agent.name }, previous: previous ? { id: previous.id, name: previous.name, webhook: previousHook?.url ?? null } : null };
}

/**
 * The iMessage contact card on a workspace's number: its main bot's name, so a phone shows "Sam"
 * (iMessage shares it with the people it texts). No photo yet: that needs a public image URL.
 * Undo with DELETE /v1/numbers/{id}/contact-card (no card was set before).
 */
export async function setLineCard(workspaceId: string) {
  const line = getState().workspaces?.find((w) => w.id === workspaceId)?.line;
  const main = getState().bots.find((b) => b.isMain && workspaceOf(b) === workspaceId);
  if (!line || !main) throw new Error("that workspace has no number or main bot");
  if (line.type !== "imessage") return null;
  return ap<Record<string, unknown>>("PUT", `/numbers/${line.numberId}/contact-card`, { firstName: main.name, displayName: main.name }, line.scope);
}

/** Undo `assignWorkspaceLine`: the number goes back to the agent it came from, and the workspace has no number. */
export async function releaseWorkspaceLine(workspaceId: string) {
  const ws = getState().workspaces?.find((w) => w.id === workspaceId);
  const line = ws?.line;
  if (!line) throw new Error("that workspace has no number");
  await ap("DELETE", `/agents/${line.agentId}/numbers/${line.numberId}`, undefined, line.scope);
  if (line.previous?.agentId) await ap("POST", `/agents/${line.previous.agentId}/numbers`, { numberId: line.numberId }, line.scope);
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === workspaceId);
    if (w) delete w.line;
  });
  return { restoredTo: line.previous?.agentId ?? null };
}

/** The live AgentPhone side of a workspace's number, read back (for checking a cutover). */
export async function checkWorkspaceLine(workspaceId: string) {
  const line = getState().workspaces?.find((w) => w.id === workspaceId)?.line;
  if (!line) throw new Error("that workspace has no number");
  const number = (await ap<{ data: ApNumber[] }>("GET", "/numbers?limit=100", undefined, line.scope)).data.find((n) => n.id === line.numberId);
  const hook = await ap<{ url?: string; status?: string }>("GET", `/agents/${line.agentId}/webhook`, undefined, line.scope);
  const previousHook = line.previous?.agentId ? await ap<{ url?: string; status?: string }>("GET", `/agents/${line.previous.agentId}/webhook`, undefined, line.scope).catch(() => null) : null;
  return {
    number: number && { phone: number.phoneNumber, agentId: number.agentId, attachedToBops: number.agentId === line.agentId },
    bopsWebhook: { url: hook?.url, status: hook?.status, isBops: hook?.url === (await hookUrl()) },
    previousAgent: line.previous?.agentId ? { id: line.previous.agentId, webhook: previousHook?.url ?? null, unchanged: (previousHook?.url ?? null) === (line.previous.webhookUrl ?? null) } : null,
  };
}

/* ---------------- For Settings and the profile ---------------- */

/** The user's numbers for Settings: each saved one (verified or still to verify), then BOPS_OWNER_PHONES ones not saved. */
function ownerList() {
  const saved = savedPhones().map((p) => ({
    number: p.number,
    pretty: prettyPhone(p.number),
    consentAt: p.consentAt,
    verifiedAt: p.verifiedAt,
    claimedVia: p.claimedVia,
    fromEnv: envOwnerPhones().some((n) => digits(n) === digits(p.number)),
  }));
  const env = envOwnerPhones()
    .filter((n) => !saved.some((p) => digits(p.number) === digits(n)))
    .map((n) => ({ number: n, pretty: prettyPhone(n), consentAt: undefined, verifiedAt: undefined, fromEnv: true }));
  return [...saved, ...env];
}

export async function phoneStatus() {
  // What the Bops plan holds now, so the app says why a number or an email isn't on offer (lib/plan-includes.ts).
  const room = planRoom();
  if (!phoneOn()) return { on: false as const, room };
  const reg = await ap<{ campaign_status?: string; message?: string }>("GET", "/register/status").catch(() => null);
  return {
    on: true as const,
    texting: reg?.campaign_status ?? "unknown",
    textingNote: reg?.message,
    // Every number takes calls through its agent (phone-voice.ts).
    calls: "agent" as const,
    owners: ownerList(),
    // Whether numbers can be added and removed here: this server can text a code, and isn't a hosted
    // one (those can't tell their user from anyone else yet; /api/phone/verify/start). If not, only
    // BOPS_OWNER_PHONES can say who the user is.
    verify: verifyOn() && !onPostgres(),
    pending: pendingVerifications("sms", verifier()).map((p) => ({ number: p.recipient, pretty: prettyPhone(p.recipient), resendInSec: p.resendInSec, expiresAt: p.expiresAt })),
    workspaces: (getState().workspaces ?? []).map((w) => {
      const main = getState().bots.find((b) => b.isMain && workspaceOf(b) === w.id);
      // The number its calls go to: the workspace's line, else the main bot's own number.
      const reach = w.line?.phone ?? (main?.phone && main.phoneLine ? main.phone : undefined);
      return { id: w.id, name: w.name, main: main?.name ?? null, mainId: main?.id ?? null, line: w.line ? { phone: prettyPhone(w.line.phone), type: w.line.type } : null, call: reach ? prettyPhone(reach) : null };
    }),
    lines: getState()
      .bots.filter((b) => b.phone)
      .map((b) => ({ bot: b.name, phone: prettyPhone(b.phone!) })),
    // With Bops Cloud's plan limits on, Free gets no number (the cloud refuses the purchase): the app shows why instead of "Get a number".
    planNeeded: planNeededForNumber(),
    // Each plan's numbers and emails (Free none, Pro 1, Max 5) and how many the user has: the app says why when there's no room.
    room,
  };
}

/** Whether a number needs Pro or Max here: Bops Cloud holds Free to its plan (CloudSession.plan) and the user is on Free. */
export const planNeededForNumber = () => {
  const plan = cloudOn() ? cloudSessionNow()?.plan : undefined;
  return !!plan?.limits && plan.tier === "free_bops";
};
