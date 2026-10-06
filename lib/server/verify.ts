import "server-only";
import type { VerifyCheckBody, VerifyErrorBody, VerifyStartBody } from "@/cloud/protocol";
import { cloudFetch, cloudOn, cloudSessionNow } from "./cloud";

/**
 * Proving a mobile number or an email address is the user's: a 6-digit code sent to it (Twilio
 * Verify), typed back into Settings, How your bots reach you. Only a number verified this way counts
 * as the user (lib/server/phone.ts); an address proved this way joins their own addresses
 * (lib/server/owner-email.ts).
 *
 * - Signed in with Orgo, codes go out through Bops Cloud (cloudVerifyApi), which holds the Twilio
 *   credentials, keeps its own limits for every user, and says in the session which channels it
 *   sends. Its errors carry Twilio's code, so they read the same here.
 * - Self-hosting, credentials are TWILIO_VERIFY_SERVICE_SID plus an API key (TWILIO_API_KEY_SID and
 *   TWILIO_API_KEY_SECRET), or the account's TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (server
 *   secrets). They're never logged or sent to the app. The Verify service sets the code length (6).
 * - Two channels: "sms" texts the code to a number, "email" emails it to an address. A code proves
 *   only the recipient it went to, so a pending code is kept per install, channel and recipient, and
 *   one channel's code can never be checked as the other's.
 * - Twilio identifies a pending verification by its recipient, so a check names the same `To` as the
 *   send. The verification's sid stays on the server (here, and as verification_ref in Postgres): the
 *   app only ever sends the recipient and the code.
 * - A code can only be checked for a recipient this server sent one to, and sends are limited per
 *   recipient (each channel on its own), and per install and per server across both channels (below),
 *   on top of Twilio's own limits: every send costs money, a text or an email alike.
 * - Texts only go to the countries in BOPS_VERIFY_COUNTRIES (calling codes, comma separated; "1"
 *   when unset, and even then not the Caribbean area codes that share +1): international and
 *   premium ranges are where texts get pumped for money.
 * - Emails only go out when the Verify service has an email sender attached (a SendGrid "Email
 *   Integration"); without one Twilio takes the request and nothing arrives. emailCodesOn() reads
 *   that from the service (its mailer_sid) and keeps the answer 10 minutes; BOPS_VERIFY_EMAIL=0
 *   turns email codes off, =1 skips the check (when the service is known to have a sender). A send
 *   the service refuses for its setup turns email codes off for 10 minutes too.
 * - Who asks for a recipient's code owns that attempt: while one install (on a hosted server, one
 *   user) has a code out for it, nobody else can start or check one for it, so they can't use up its
 *   tries. (Twilio keys a verification by its recipient only, so this has to be done here.)
 * - "Send again" is another send to the same recipient: Twilio reuses the verification in progress
 *   (and its code). A channel never moves on to another (no voice call, no email for a number).
 */

/** How a code goes out: texted to a number, or emailed to an address. */
export type Channel = "sms" | "email";

/** A verification as Twilio returns it (the fields used here). */
export type Verification = { sid: string; status: "pending" | "approved" | "canceled" | "max_attempts_reached" | "deleted" | "failed" | "expired" | (string & {}) };
/** An error from Twilio: the HTTP status, Twilio's error code (60200…), and Retry-After when sent. */
export type VerifyError = Error & { statusCode?: number; code?: number; retryAfter?: number };

/** The Verify calls used here, so a test can hand in a stub and nothing is ever texted or emailed. */
export type VerifyApi = {
  create(to: string, channel: Channel): Promise<Verification>;
  check(to: string, code: string): Promise<Verification>;
  /** The Verify service itself: the email sender attached to it, if any. */
  service(): Promise<{ mailerSid: string | null }>;
};

export const CODE_LENGTH = 6;
/** Between two texts to one number. */
export const RESEND_MS = 30_000;
/** Between two emails to one address: email is slower to arrive, and a second code only adds to the pile. */
export const EMAIL_RESEND_MS = 60_000;
const resendMs = (channel: Channel) => (channel === "email" ? EMAIL_RESEND_MS : RESEND_MS);
const HOUR = 3_600_000;
/** Sends to one recipient from one install, to one recipient from anyone (per channel), from one install, and from this server (both channels), in an hour. */
const PER_SLOT_HOUR = 5;
const PER_RECIPIENT_HOUR = 8;
const PER_INSTALL_HOUR = 12;
const PER_SERVER_HOUR = 30;
/** Code checks for one install's attempt at a recipient in an hour (Twilio ends a verification after 5 wrong codes too). */
const CHECKS_HOUR = 15;
/** How long emailCodesOn() keeps its answer, and how long a refused email send keeps email codes off. */
const EMAIL_CHECK_MS = 10 * 60_000;

/**
 * NANP area codes outside the US and Canada (Caribbean and Atlantic islands): +1, but billed as
 * international and a common target for SMS pumping. Allowed only when BOPS_VERIFY_COUNTRIES names
 * one outright ("1876").
 */
const NANP_ABROAD = new Set(["242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758", "767", "784", "809", "829", "849", "868", "869", "876"]);

/** Whether a code may be texted to this E.164 number (see BOPS_VERIFY_COUNTRIES above). */
export function textableCountry(e164: string): boolean {
  const d = e164.replace(/\D/g, "");
  const allowed = (process.env.BOPS_VERIFY_COUNTRIES ?? "1")
    .split(",")
    .map((x) => x.replace(/\D/g, ""))
    .filter(Boolean);
  if (!allowed.some((p) => d.startsWith(p))) return false;
  if (d.startsWith("1") && NANP_ABROAD.has(d.slice(1, 4))) return allowed.includes(d.slice(0, 4));
  return true;
}

type Pending = { id: string; channel: Channel; recipient: string; at: number; expiresAt: number; consentAt: number };
/** Pending codes are kept per install (on a hosted server, per user), channel and recipient (an E.164 number, or a lowercased address). */
const slot = (install: string, channel: Channel, recipient: string) => `${install}|${channel}:${recipient}`;
/**
 * `consent` is when the user agreed to texts for a number they're verifying, per install and number:
 * kept apart from the pending code, so a code that expires or runs out of tries can be sent again
 * without asking again. Gone once the number is verified or removed. Texts only: email asks no OK.
 */
type Box = {
  /** A test's stub (setVerifyApiForTests); otherwise each call goes to Bops Cloud or Twilio, whichever is in use then. */
  api?: VerifyApi;
  pending: Map<string, Pending>;
  consent: Map<string, number>;
  sends: Map<string, number[]>;
  checks: Map<string, number[]>;
  /** Whether codes can be emailed, and when that was found (emailCodesOn), or when a send turned them off. */
  email?: { on: boolean; at: number };
  /** The service check in flight, shared by everyone asking at once. */
  emailCheck?: Promise<boolean>;
};
const g = globalThis as unknown as { bopsVerify?: Box };
// Kept across dev reloads, so a code sent before an edit can still be checked after it.
const box: Box = (g.bopsVerify ??= { pending: new Map(), consent: new Map(), sends: new Map(), checks: new Map() });
box.consent ??= new Map();
// Codes pending from before channels existed (a dev reload) can't be checked anymore: let them go.
for (const [k, p] of box.pending) if (!p.channel) box.pending.delete(k);

/** Basic auth for Twilio: an API key (preferred), else the account's own token. */
function twilioAuth(): string | null {
  const e = process.env;
  const [user, pass] = e.TWILIO_API_KEY_SID && e.TWILIO_API_KEY_SECRET ? [e.TWILIO_API_KEY_SID, e.TWILIO_API_KEY_SECRET] : [e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN];
  return user && pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` : null;
}

/** Twilio Verify on this server's own credentials (self-hosting). */
const twilioOn = () => !!process.env.TWILIO_VERIFY_SERVICE_SID && !!twilioAuth();

/**
 * Whether codes go out on a channel from here: a test's stub, Bops Cloud when its session says it
 * sends them, or this server's own Twilio Verify. Email also needs a sender (emailCodesOn).
 */
const channelOn = (channel: Channel) => !!box.api || (cloudOn() ? !!cloudSessionNow()?.verify[channel] : twilioOn());

/** Whether codes can be texted from here. */
export const verifyOn = () => channelOn("sms");

/**
 * POST a form to the Verify service (or, with no form, GET it: `path` "" is the service itself);
 * errors carry Twilio's status, code and Retry-After. One retry on a 5xx or dropped connection.
 */
async function twilio<T = Verification>(path: string, form: Record<string, string> | null, fetchImpl: typeof fetch = fetch, attempt = 0): Promise<T> {
  const auth = twilioAuth();
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!auth || !service) throw new Error("not set up");
  let res: Response;
  try {
    res = await fetchImpl(`https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}${path ? `/${path}` : ""}`, {
      method: form ? "POST" : "GET",
      headers: form ? { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" } : { Authorization: auth },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (attempt < 1) return twilio<T>(path, form, fetchImpl, attempt + 1);
    throw e;
  }
  if (res.status >= 500 && attempt < 1) return twilio<T>(path, form, fetchImpl, attempt + 1);
  const body = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!res.ok) {
    const err = new Error(`Twilio ${res.status} ${body.code ?? ""}`.trim()) as VerifyError;
    err.statusCode = res.status;
    err.code = body.code;
    const ra = Number(res.headers.get("retry-after"));
    if (ra > 0) err.retryAfter = ra;
    throw err;
  }
  return body;
}

/** The real Verify calls; `fetchImpl` lets a test check the wire shape without reaching Twilio. */
export const twilioVerifyApi = (fetchImpl: typeof fetch = fetch): VerifyApi => ({
  create: (to, channel) => twilio("Verifications", { To: to, Channel: channel }, fetchImpl),
  check: (to, code) => twilio("VerificationCheck", { To: to, Code: code }, fetchImpl),
  service: async () => ({ mailerSid: (await twilio<{ mailer_sid?: string | null }>("", null, fetchImpl)).mailer_sid || null }),
});

/** POST /v1/verify/start or /check on Bops Cloud; a refusal becomes an error like Twilio's (HTTP status, Twilio's code, Retry-After). */
async function viaCloud(step: "start" | "check", body: VerifyStartBody | VerifyCheckBody, fetchImpl: typeof fetch): Promise<Verification> {
  const res = await cloudFetch(`/v1/verify/${step}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, fetchImpl);
  const answer = (await res.json().catch(() => ({}))) as Partial<Verification & VerifyErrorBody>;
  if (!res.ok) {
    const err = new Error(`Bops Cloud ${res.status} ${answer.code ?? ""}`.trim()) as VerifyError;
    err.statusCode = res.status;
    if (typeof answer.code === "number") err.code = answer.code;
    const ra = Number(answer.retryAfter ?? res.headers.get("retry-after"));
    if (ra > 0) err.retryAfter = ra;
    throw err;
  }
  return answer as Verification;
}

/** Codes through Bops Cloud, as the signed-in user. It has an email sender when its session says it emails codes. */
export const cloudVerifyApi = (fetchImpl: typeof fetch = fetch): VerifyApi => ({
  create: (to, channel) => viaCloud("start", { to, channel }, fetchImpl),
  check: (to, code) => viaCloud("check", { to, code }, fetchImpl),
  service: async () => ({ mailerSid: cloudSessionNow()?.verify.email ? "bops-cloud" : null }),
});

function api(): VerifyApi {
  if (box.api) return box.api;
  if (cloudOn()) return cloudVerifyApi();
  if (!twilioOn()) throw new Error("not set up");
  return twilioVerifyApi();
}

/** For tests: a stub in place of Twilio or Bops Cloud (null puts the real one back), and a clean slate. */
export function setVerifyApiForTests(stub: VerifyApi | null) {
  box.api = stub ?? undefined;
  box.pending.clear();
  box.consent.clear();
  box.sends.clear();
  box.checks.clear();
  box.email = undefined;
  box.emailCheck = undefined;
}

/** "(555) 123-4567", "1 555 123 4567", "+44 20 7946 0958" → E.164, or "" when it isn't a phone number. US numbers may leave out the +1. */
export function toE164(input: string): string {
  const d = input.replace(/[^\d+]/g, "");
  const e164 = d.startsWith("+") ? `+${d.slice(1).replace(/\+/g, "")}` : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : "";
  return /^\+\d{10,15}$/.test(e164) ? e164 : "";
}

/** The times in the last hour, after dropping older ones. */
function recent(map: Map<string, number[]>, key: string, now: number) {
  const times = (map.get(key) ?? []).filter((t) => now - t < HOUR);
  map.set(key, times);
  return times;
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
const status = (e: unknown) => (e as VerifyError).statusCode;
const errCode = (e: unknown) => (e as VerifyError).code;
const retryAfter = (e: unknown) => (e as VerifyError).retryAfter;
/** What's safe to log: the HTTP status and Twilio's error code, never the credentials, the recipient or the code. */
const logLine = (e: unknown) => {
  const x = e as VerifyError;
  return x.statusCode ? `${x.statusCode} ${x.code ?? ""}`.trim() : (x.message ?? "unknown error");
};
/** Twilio Verify's codes for "this number can't be texted": invalid, landline, blocked by geo permissions or fraud guard. */
const UNTEXTABLE = new Set([60200, 60205, 60410, 60605, 21211, 21614]);
/** Twilio Verify's code for an address it won't email (an invalid `To`); every other refusal of an email is the service's setup. */
const UNMAILABLE = new Set([60200]);
/** Too many sends or checks for this recipient (Twilio's own limits). */
const TOO_MANY = new Set([60203, 60202, 60212]);
/** How long a Twilio verification lives (the Verify service default). */
const TTL_MS = 10 * 60_000;

/** The words that change with the channel. */
const said = (channel: Channel) => (channel === "email" ? { from: "the email", recipient: "address" } : { from: "the text", recipient: "number" });
/** The answer when codes can't go out on a channel at all here. */
const notSetUp = (channel: Channel) => (channel === "email" ? "Adding another email by code isn't available yet." : "Checking numbers by text isn't set up on this server.");
const EMAIL_FAILED = "Couldn't email a code right now. Try again later, or text your bots instead.";

/**
 * Whether codes can be emailed from here: Verify is set up, BOPS_VERIFY_EMAIL isn't 0, and the
 * service has an email sender attached (its mailer_sid; BOPS_VERIFY_EMAIL=1 takes that as given).
 * The answer is kept 10 minutes. A check that fails counts as no, for those 10 minutes too, and so
 * does a send the service refused (startVerification): Settings never offers a code that can't arrive.
 */
export async function emailCodesOn(now = Date.now()): Promise<boolean> {
  const forced = process.env.BOPS_VERIFY_EMAIL?.trim();
  if (forced === "0" || !channelOn("email")) return false;
  if (box.email && now - box.email.at < EMAIL_CHECK_MS) return box.email.on;
  if (forced === "1") return true;
  return (box.emailCheck ??= (async () => {
    let on = false;
    try {
      on = !!(await api().service()).mailerSid;
    } catch (e) {
      console.warn(`[verify] couldn't read the service's email setup: ${logLine(e)}`);
    }
    box.email = { on, at: now };
    return on;
  })().finally(() => (box.emailCheck = undefined)));
}

export type StartResult =
  | { ok: true; recipient: string; resendInSec: number; expiresAt: number }
  | { ok: false; error: string; retryInSec?: number };

/**
 * Send a code to `to` (an E.164 number for "sms", a lowercased address for "email"). `install` is
 * who's asking (this install, or on a hosted server its user), for the per-install limit.
 * `consentAt` is when they agreed to texts, kept with a texted code.
 */
export async function startVerification(channel: Channel, to: string, install: string, consentAt: number, now = Date.now()): Promise<StartResult> {
  const words = said(channel);
  if (!channelOn(channel)) return { ok: false, error: notSetUp(channel) };
  if (channel === "sms" && !textableCountry(to)) return { ok: false, error: "Codes can only be texted to US and Canadian mobile numbers for now." };
  if (channel === "email" && !(await emailCodesOn(now))) return { ok: false, error: notSetUp(channel) };
  const key = slot(install, channel, to);
  const held = heldByOther(channel, to, install, now);
  if (held) return { ok: false, error: `Someone else is checking this ${words.recipient} right now. Try again in a few minutes.`, retryInSec: Math.ceil((held.expiresAt - now) / 1000) };
  const last = box.pending.get(key);
  const resend = resendMs(channel);
  if (last && now - last.at < resend) return { ok: false, error: "A code is on its way. You can send another in a moment.", retryInSec: Math.ceil((resend - (now - last.at)) / 1000) };
  const wait = (times: number[]) => HOUR - (now - times[0]);
  const forSlot = recent(box.sends, `s:${key}`, now);
  const forRecipient = recent(box.sends, `n:${channel}:${to}`, now);
  if (forSlot.length >= PER_SLOT_HOUR || forRecipient.length >= PER_RECIPIENT_HOUR) {
    const w = wait(forSlot.length >= PER_SLOT_HOUR ? forSlot : forRecipient);
    return { ok: false, error: `That's a lot of codes for one ${words.recipient}. Try again in ${minutes(w)} min.`, retryInSec: Math.ceil(w / 1000) };
  }
  // Every send costs money, a text or an email alike: one count per install and one for the server, across both channels.
  const forInstall = recent(box.sends, `i:${install}`, now);
  if (forInstall.length >= PER_INSTALL_HOUR)
    return { ok: false, error: `Too many codes sent in the last hour. Try again in ${minutes(wait(forInstall))} min.`, retryInSec: Math.ceil(wait(forInstall) / 1000) };
  const forServer = recent(box.sends, "all", now);
  if (forServer.length >= PER_SERVER_HOUR) {
    console.warn(`[verify] server send cap reached (${PER_SERVER_HOUR} an hour)`);
    return { ok: false, error: `Too many codes sent in the last hour. Try again in ${minutes(wait(forServer))} min.`, retryInSec: Math.ceil(wait(forServer) / 1000) };
  }
  // Counted before the send: a send that fails at Twilio may still have cost a text.
  for (const t of [forSlot, forRecipient, forInstall, forServer]) t.push(now);
  let v: Verification;
  try {
    v = await api().create(to, channel);
  } catch (e) {
    const s = status(e);
    if (TOO_MANY.has(errCode(e) ?? 0) || s === 429) {
      const wait = retryAfter(e) ?? 600;
      return { ok: false, error: `Too many codes were sent to this ${words.recipient}. Try again in ${minutes(wait * 1000)} min.`, retryInSec: wait };
    }
    // Bops Cloud keeps one verified owner per number or address across all its users.
    if (s === 409) return { ok: false, error: `That ${words.recipient} is already verified on another Bops account.` };
    if (channel === "email") {
      if (UNMAILABLE.has(errCode(e) ?? 0)) return { ok: false, error: "That doesn't look like an email address." };
      if (s && s >= 400 && s < 500) {
        // The service won't email codes (no sender attached, a template that isn't active, the channel
        // turned off): don't offer it again for a while. Settings shows it as not available.
        box.email = { on: false, at: now };
        console.warn(`[verify] email send refused (${logLine(e)}): email codes off for ${EMAIL_CHECK_MS / 60_000} min`);
        return { ok: false, error: EMAIL_FAILED };
      }
    } else if (UNTEXTABLE.has(errCode(e) ?? 0) || s === 400) return { ok: false, error: "That number can't get a text. Check it and try again." };
    console.warn(`[verify] send failed: ${logLine(e)}`);
    if (channel === "sms" && (s === 401 || s === 403 || s === 404)) return { ok: false, error: "Checking numbers by text isn't working on this server right now." };
    return { ok: false, error: "Couldn't send a code right now. Try again in a minute." };
  }
  if (v.status !== "pending") {
    console.warn(`[verify] send ${v.status}`);
    return { ok: false, error: `Couldn't send a code to that ${words.recipient}.` };
  }
  // A resend reuses the verification in progress, so it keeps the first send's expiry.
  const expiresAt = last && last.id === v.sid ? last.expiresAt : now + TTL_MS;
  box.pending.set(key, { id: v.sid, channel, recipient: to, at: now, expiresAt, consentAt });
  if (channel === "sms") box.consent.set(key, consentAt);
  return { ok: true, recipient: to, resendInSec: resend / 1000, expiresAt };
}

export type CheckResult =
  | { ok: true; ref: string; consentAt: number }
  | { ok: false; error: string; attemptsLeft?: number; restart?: boolean };

/** Check the code the user typed for `to`. On success the pending code is gone and `ref` is Twilio's verification sid. */
export async function checkVerification(channel: Channel, to: string, install: string, code: string, now = Date.now()): Promise<CheckResult> {
  const words = said(channel);
  if (!channelOn(channel)) return { ok: false, error: notSetUp(channel) };
  const key = slot(install, channel, to);
  const p = box.pending.get(key);
  if (!p) return { ok: false, error: `Send a code to this ${words.recipient} first.`, restart: true };
  const digitsOnly = code.replace(/\D/g, "");
  if (digitsOnly.length !== CODE_LENGTH) return { ok: false, error: `Enter the ${CODE_LENGTH}-digit code from ${words.from}.` };
  if (now > p.expiresAt) {
    box.pending.delete(key);
    return { ok: false, error: "That code has expired. Send a new one.", restart: true };
  }
  const tries = recent(box.checks, key, now);
  if (tries.length >= CHECKS_HOUR) return { ok: false, error: `Too many tries. Wait ${minutes(HOUR - (now - tries[0]))} min and send a new code.`, restart: true };
  tries.push(now);
  let r: Verification;
  try {
    r = await api().check(to, digitsOnly);
  } catch (e) {
    const s = status(e);
    if (s === 404) {
      // Finished at Twilio (expired, used up, approved, or never there): only a new code can verify it now.
      box.pending.delete(key);
      return { ok: false, error: "That code can't be used anymore. Send a new one.", restart: true };
    }
    if (s === 409) {
      box.pending.delete(key);
      return { ok: false, error: `That ${words.recipient} is already verified on another Bops account.`, restart: true };
    }
    if (errCode(e) === 60202) {
      box.pending.delete(key);
      return { ok: false, error: "Too many wrong codes. Send a new one.", restart: true };
    }
    if (s === 429) return { ok: false, error: `Too many tries. Wait ${minutes((retryAfter(e) ?? 600) * 1000)} min and try again.` };
    if (s === 400) return { ok: false, error: `Enter the ${CODE_LENGTH}-digit code from ${words.from}.` };
    console.warn(`[verify] check failed: ${logLine(e)}`);
    return { ok: false, error: "Couldn't check the code right now. Try again in a minute." };
  }
  if (r.status === "approved") {
    box.pending.delete(key);
    box.consent.delete(key);
    box.checks.delete(key);
    return { ok: true, ref: r.sid ?? p.id, consentAt: p.consentAt };
  }
  // A wrong code leaves the verification pending (Twilio allows 5 tries before it ends it).
  if (r.status === "pending") return { ok: false, error: "That code isn't right." };
  box.pending.delete(key);
  if (r.status === "expired") return { ok: false, error: "That code has expired. Send a new one.", restart: true };
  if (r.status === "max_attempts_reached") return { ok: false, error: "Too many wrong codes. Send a new one.", restart: true };
  return { ok: false, error: "That code can't be used anymore. Send a new one.", restart: true };
}

/** Another install's (or user's) unexpired code for this recipient, if there is one. */
function heldByOther(channel: Channel, to: string, install: string, now: number) {
  for (const [k, p] of box.pending) if (p.channel === channel && p.recipient === to && k !== slot(install, channel, to) && p.expiresAt > now) return p;
  return undefined;
}

/** When the user agreed to texts for a number they're verifying (a resend keeps that consent, even after the code ran out). */
export function pendingConsentAt(e164: string, install: string): number | undefined {
  return box.consent.get(slot(install, "sms", e164));
}

/** A pending code for this recipient is no longer wanted (the number or address was removed). */
export function forgetVerification(channel: Channel, to: string, install: string) {
  box.pending.delete(slot(install, channel, to));
  box.consent.delete(slot(install, channel, to));
}

/** The recipients on a channel with a code out, and when another may be sent (for Settings after a reload). Never the code or Twilio's ids. */
export function pendingVerifications(channel: Channel, install: string, now = Date.now()) {
  return [...box.pending.entries()]
    .filter(([k, p]) => k.startsWith(`${install}|${channel}:`) && p.expiresAt > now)
    .map(([, p]) => ({ channel, recipient: p.recipient, resendInSec: Math.max(0, Math.ceil((resendMs(channel) - (now - p.at)) / 1000)), expiresAt: p.expiresAt }));
}
