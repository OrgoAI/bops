/**
 * What each metered use (usage.ts) costs Orgo, in micro-dollars (1 cent = 10,000): AI credit is spent
 * at cost, so $1 of credit is $1 of what OpenAI, AgentPhone, Twilio or Typesafe charge. A row's cost
 * is rounded up to a whole micro-dollar.
 *
 * Where each price comes from:
 * - OpenAI tokens: the model pages (gpt-6.1-sol, gpt-6-astra), with a response past 272K input tokens
 *   at the long-context rates. A model not listed here, or an agent turn whose session's model the
 *   cloud never saw, is priced at gpt-6-astra's (the dearest), and logged.
 * - A call run on the Mac: gpt-live-1's audio per second, plus the SIP leg (not yet checked against
 *   an invoice). A call the cloud answers: an estimate per minute (live audio, SIP and the backend's
 *   tokens).
 * - AgentPhone: agentphone.ai/pricing. A number a month; an iMessage line by kind (receive-only, or
 *   send and receive); a text per segment, a picture message as one.
 * - Typesafe: an estimate per call (its body is piped through, so its tokens aren't seen).
 * - Twilio Verify: a texted code is the SMS ($0.0083) and the verification ($0.05), charged when it's
 *   sent; an emailed one, the verification.
 */

type Rates = { input: number; cached: number; output: number };

/** Per token, in micro-dollars: uncached input, cached input, output (reasoning is part of output). */
const MODELS: { model: RegExp; rates: Rates }[] = [
  { model: /^gpt-6\.1-sol(-\d{4}-\d{2}-\d{2})?$/, rates: { input: 2, cached: 0.1, output: 10 } },
  { model: /^gpt-6-astra(-\d{4}-\d{2}-\d{2})?$/, rates: { input: 10, cached: 1, output: 50 } },
];
const DEAREST: Rates = { input: 10, cached: 1, output: 50 };

/** Past this many input tokens in one response, input costs twice as much and output half as much again. */
const LONG_CONTEXT = 272_000;

/** Per second of a call the Mac runs: gpt-live-1 (833.3) and the SIP leg (61.7). */
const LIVE_SECOND = 895;
/** Per minute of a call the cloud answers. */
const CLOUD_CALL_MINUTE = 65_000;
/** A month of a number; an iMessage line that only receives, or one that sends too. */
const NUMBER = 3_000_000;
const IMESSAGE_INBOUND = 150_000_000;
const IMESSAGE_OUTBOUND = 250_000_000;
/** A text, per segment (in or out); a picture message, each. */
const SMS_SEGMENT = 20_000;
const MMS = 30_000;
const TYPESAFE_CALL = 200;
const VERIFY_SMS = 58_300;
const VERIFY_EMAIL = 50_000;

/** Models already logged as unknown (once each, not on every turn). */
const unknownSeen = new Set<string>();

function ratesFor(model: unknown): Rates {
  const found = typeof model === "string" ? MODELS.find((m) => m.model.test(model)) : undefined;
  if (found) return found.rates;
  const name = typeof model === "string" && model ? model : "(no model)";
  if (!unknownSeen.has(name) && unknownSeen.size < 1_000) {
    unknownSeen.add(name);
    console.warn(`[pricing] no price for ${name}: priced as gpt-6-astra`);
  }
  return DEAREST;
}

const n = (x: unknown) => Math.max(0, Number(x) || 0);

/** An OpenAI answer's tokens (usage.ts recordTokens' detail): input, of which cached, and output. */
export function tokenCost(detail: Record<string, unknown>): number {
  const r = ratesFor(detail.model);
  const input = n(detail.input);
  const cached = Math.min(n(detail.cached), input);
  const output = n(detail.output);
  const long = input > LONG_CONTEXT;
  const inputCost = ((input - cached) * r.input + cached * r.cached) * (long ? 2 : 1);
  return inputCost + output * r.output * (long ? 1.5 : 1);
}

/** A number's price: an iMessage line by kind (an unknown kind at the dearer), else a number's. */
export function numberCost(detail: { type?: unknown; imessageType?: unknown }): number {
  if (detail.type !== "imessage") return NUMBER;
  return detail.imessageType === "inbound" ? IMESSAGE_INBOUND : IMESSAGE_OUTBOUND;
}

/**
 * How many segments a text goes out (or comes in) as: one of up to 160 characters (70 when it has a
 * character outside GSM-7, such as an emoji), and past that, parts of 153 (or 67).
 */
export function smsSegments(text: string): number {
  const chars = [...text];
  if (!chars.length) return 1;
  const gsm = chars.every((ch) => GSM7.has(ch));
  const [one, part] = gsm ? [160, 153] : [70, 67];
  // GSM-7's extension characters take two places.
  const size = gsm ? chars.reduce((s, ch) => s + (GSM7_EXTENDED.has(ch) ? 2 : 1), 0) : chars.length;
  return size <= one ? 1 : Math.ceil(size / part);
}

const GSM7 = new Set([
  ..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ..."^{}\\[~]|€\f",
]);
const GSM7_EXTENDED = new Set([..."^{}\\[~]|€\f"]);

/** What `units` of `kind` cost Orgo, in whole micro-dollars (rounded up). Kinds without a price cost nothing. */
export function costOf(kind: string, units: number, detail: Record<string, unknown> = {}): number {
  const u = n(units);
  let micros = 0;
  if (kind === "openai.tokens") micros = tokenCost(detail);
  else if (kind === "openai.live_seconds") micros = u * LIVE_SECOND;
  else if (kind === "call.minutes") micros = u * CLOUD_CALL_MINUTE;
  else if (kind === "agentphone.numbers") micros = u * numberCost(detail);
  else if (kind === "agentphone.sms") micros = u * (detail.mms ? MMS : SMS_SEGMENT);
  else if (kind === "typesafe.calls") micros = u * TYPESAFE_CALL;
  else if (kind === "verify.sms") micros = u * VERIFY_SMS;
  else if (kind === "verify.email") micros = u * VERIFY_EMAIL;
  // Tenths of a micro-dollar (cached tokens) are summed in floating point: a hair over a whole one isn't rounded up.
  return Math.ceil(Math.round(micros * 1000) / 1000);
}
