/**
 * What each metered use (usage.ts) costs Orgo, in micro-dollars (1 cent = 10,000): AI credit is spent
 * at cost, so $1 of credit is $1 of what OpenAI, AgentPhone, Twilio or Typesafe charge. A row's cost
 * is rounded up to a whole micro-dollar. Every price is one named constant here, so it can change in
 * one place.
 *
 * Where each price comes from (checked 2026-10-06):
 * - OpenAI tokens: developers.openai.com/api/docs/pricing. gpt-6.1-sol: $2.00 input, $0.10 cached
 *   input, $2.50 cache writes, $10.00 output per 1M tokens; gpt-6-astra: $10.00, $1.00, $12.50,
 *   $50.00. Reasoning is billed as output. One response past 272K input tokens is billed at the
 *   long-context rates (input, cached and cache writes twice, output half as much again). That rule is
 *   per model request, so it's applied to a Responses API row (one response) and never to an agent
 *   turn's row, which sums many requests. A model not listed here, or an agent turn whose session's
 *   model the cloud never saw, is priced at gpt-6-astra's (the dearest), and logged.
 * - OpenAI's web search tool: $10.00 per 1K calls (search content tokens are in the turn's tokens).
 *   Only search actions are tool calls (the web search guide); opening a page or finding in one isn't.
 * - Images (gpt-image-2.5-flare, gpt-image-2.5-sunburst; the models page of each): $5.00 text input,
 *   $1.25 cached text input, $8.00 image input, $2.00 cached image input, $30.00 image output per 1M
 *   tokens, the same for both. An answer that didn't say what it used is priced at IMAGE_UNREPORTED
 *   an image, and logged.
 * - Transcription (gpt-transcribe): $0.0045 a minute of audio, by the second.
 * - GPT-Live (gpt-live-1): $0.05 a minute of audio, by the second. A call over a SIP trunk adds the
 *   SIP leg (61.7 a second, from an internal estimate, not yet checked against an invoice).
 * - AgentPhone: agentphone.ai/pricing. $3 a number a month; an iMessage line by kind ($150 receive
 *   only, $250 sends too); 2 cents a text segment and 3 cents a picture message, in or out; 13 cents a
 *   minute of a call through the webhook voice agent (what Bops uses), billed by the second. The words
 *   the bot says on a call are its own model answers, counted as tokens.
 * - Typesafe Jev (jev-latest is jev-1.13.0): $0.042 per 1M input tokens, output free (Typesafe's
 *   models page, as orgo-web's lib/credits-shared.ts has it).
 * - Twilio Verify: a texted code is the SMS ($0.0083) and the verification ($0.05), charged when it's
 *   sent; an emailed one, the verification.
 * - Composio and Honcho: counted, at $0 for now (Composio's price is still being agreed; Honcho's
 *   isn't set yet).
 * - treg: each call at what treg charged for it (its X-Treg-Cost-Micro: the provider's own rate, 0%
 *   markup; misses on per-success endpoints, failed calls and replays are free), kept in the row's
 *   detail as `costMicro`. No price table here: treg settles it per call.
 */

type Rates = { input: number; cached: number; cacheWrite: number; output: number };

/** Per token, in micro-dollars: uncached input, cached input, input written to the cache, output (reasoning is part of output). */
const MODELS: { model: RegExp; rates: Rates }[] = [
  { model: /^gpt-6\.1-sol(-\d{4}-\d{2}-\d{2})?$/, rates: { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10 } },
  { model: /^gpt-6-astra(-\d{4}-\d{2}-\d{2})?$/, rates: { input: 10, cached: 1, cacheWrite: 12.5, output: 50 } },
];
const DEAREST: Rates = { input: 10, cached: 1, cacheWrite: 12.5, output: 50 };

/** Past this many input tokens in one model request, input costs twice as much and output half as much again. */
const LONG_CONTEXT = 272_000;

/** A web search the agent ran (a search action of the web search tool). */
export const WEB_SEARCH_CALL = 10_000;
/** Per token, in micro-dollars, for each image model: text input (cached), image input (cached), output. */
const IMAGE_MODELS: { model: RegExp; rates: { text: number; textCached: number; image: number; imageCached: number; output: number } }[] = [
  { model: /^gpt-image-2\.5-(flare|sunburst)(-\d{4}-\d{2}-\d{2})?$/, rates: { text: 5, textCached: 1.25, image: 8, imageCached: 2, output: 30 } },
];
/** An image whose answer didn't say how many tokens it took: about a large one at high quality. */
export const IMAGE_UNREPORTED = 250_000;
/** A second of gpt-transcribe audio ($0.0045 a minute). */
const TRANSCRIBE_SECOND = 4_500 / 60;
/** A second of GPT-Live audio ($0.05 a minute). */
const LIVE_AUDIO_SECOND = 50_000 / 60;
/** A second of a SIP trunk's leg, on top of the audio, for a call that came over one. */
const SIP_LEG_SECOND = 61.7;
/** A minute of a call through AgentPhone's webhook voice agent, billed by the second. */
const VOICE_WEBHOOK_MINUTE = 130_000;
/** A month of a number; an iMessage line that only receives, or one that sends too. */
const NUMBER = 3_000_000;
const IMESSAGE_INBOUND = 150_000_000;
const IMESSAGE_OUTBOUND = 250_000_000;
/** A text, per segment (in or out); a picture message, each. */
const SMS_SEGMENT = 20_000;
const MMS = 30_000;
/** Per Jev token, by model: input, and output (free). */
const JEV: { model: RegExp; input: number; output: number }[] = [{ model: /^jev(-latest|-1\.13(\.\d+)?)$/, input: 0.042, output: 0 }];
const JEV_DEAREST = { input: 0.042, output: 0 };
const VERIFY_SMS = 58_300;
const VERIFY_EMAIL = 50_000;
/** One Composio call (a tool run in an app, or a call to an app's own API through Composio). Negotiable: $0 until it's agreed. */
export const COMPOSIO_CALL = 0;
/** One Honcho call that does work (a memory question, a search, messages saved). $0 until its price is set. */
export const HONCHO_CALL = 0;

/**
 * What a running agent turn is held at, a second, by its session's model (turn-guard.ts): OpenAI says
 * what a turn used only once it's over, so until then the cloud holds this much of the user's credit
 * for it. Measured on 2026-10-06 from 68 finished turns (cost over their running time): gpt-6-astra
 * $0.78 a minute typically, $2.60 at the 90th percentile, $3.33 at the most; gpt-6.1-sol $0.20, $0.33,
 * $0.43. A session is held at `most` (above the most seen) until one of its turns has finished, then
 * at half again what its own turns cost, never below `least` (the 90th percentile: a session's cheap
 * first turn mustn't let a dearer one run far past what's left). A model not listed is held as
 * gpt-6-astra.
 */
const TURN_HOLD: { model: RegExp; most: number; least: number }[] = [
  { model: /^gpt-6\.1-sol(-\d{4}-\d{2}-\d{2})?$/, most: 500_000 / 60, least: 330_000 / 60 },
  { model: /^gpt-6-astra(-\d{4}-\d{2}-\d{2})?$/, most: 4_000_000 / 60, least: 2_600_000 / 60 },
];

/** A running turn's hold at `model`, in micro-dollars a second: where a session starts, and the least its own turns may lower it to. */
export function turnHold(model: unknown): { most: number; least: number } {
  const found = typeof model === "string" ? TURN_HOLD.find((m) => m.model.test(model)) : undefined;
  return found ?? TURN_HOLD[1];
}

/** Models already logged as unknown (once each, not on every turn). */
const unknownSeen = new Set<string>();

function warnUnknown(name: string, as: string) {
  if (unknownSeen.has(name) || unknownSeen.size >= 1_000) return;
  unknownSeen.add(name);
  console.warn(`[pricing] no price for ${name}: priced as ${as}`);
}

function ratesFor(model: unknown): Rates {
  const found = typeof model === "string" ? MODELS.find((m) => m.model.test(model)) : undefined;
  if (found) return found.rates;
  warnUnknown(typeof model === "string" && model ? model : "(no model)", "gpt-6-astra");
  return DEAREST;
}

const n = (x: unknown) => Math.max(0, Number(x) || 0);

/**
 * An OpenAI answer's tokens (usage.ts recordTokens' detail): input, of which cached and written to the
 * cache, and output. `source` "agent" is an agent turn (many model requests, so never long context).
 */
export function tokenCost(detail: Record<string, unknown>): number {
  const r = ratesFor(detail.model);
  const input = n(detail.input);
  const cached = Math.min(n(detail.cached), input);
  const written = Math.min(n(detail.cacheWrite), input - cached);
  const output = n(detail.output);
  const long = detail.source !== "agent" && input > LONG_CONTEXT;
  const inputCost = ((input - cached - written) * r.input + cached * r.cached + written * r.cacheWrite) * (long ? 2 : 1);
  return inputCost + output * r.output * (long ? 1.5 : 1);
}

/** Whether the cloud knows an image model's price (only those are let through: proxy.ts). */
export const imageModelPriced = (model: unknown) => typeof model === "string" && IMAGE_MODELS.some((m) => m.model.test(model));

/**
 * An image answer's tokens (usage.ts recordImages' detail): text and image input, of each how much was
 * cached, and output; or, when the answer didn't say, how many images it made (`unreported`).
 */
export function imageCost(detail: Record<string, unknown>): number {
  if (n(detail.unreported)) return n(detail.unreported) * IMAGE_UNREPORTED;
  const found = typeof detail.model === "string" ? IMAGE_MODELS.find((m) => m.model.test(detail.model as string)) : undefined;
  if (!found) warnUnknown(typeof detail.model === "string" && detail.model ? detail.model : "(no image model)", "gpt-image-2.5-flare");
  const r = (found ?? IMAGE_MODELS[0]).rates;
  const text = n(detail.text);
  const image = n(detail.image);
  const textCached = Math.min(n(detail.textCached), text);
  const imageCached = Math.min(n(detail.imageCached), image);
  return (text - textCached) * r.text + textCached * r.textCached + (image - imageCached) * r.image + imageCached * r.imageCached + n(detail.output) * r.output;
}

/** A Jev answer's tokens (detail: model, input, output), at its model's price. */
export function jevCost(detail: Record<string, unknown>): number {
  const found = typeof detail.model === "string" ? JEV.find((m) => m.model.test(detail.model as string)) : undefined;
  if (!found) warnUnknown(typeof detail.model === "string" && detail.model ? detail.model : "(no Jev model)", "jev-1.13.0");
  const r = found ?? JEV_DEAREST;
  return n(detail.input) * r.input + n(detail.output) * r.output;
}

/** A number's price: an iMessage line by kind (an unknown kind at the dearer), else a number's. */
export function numberCost(detail: { type?: unknown; imessageType?: unknown }): number {
  if (detail.type !== "imessage") return NUMBER;
  return detail.imessageType === "inbound" ? IMESSAGE_INBOUND : IMESSAGE_OUTBOUND;
}

/** Whether a web search call is billed: a search is; opening a page or finding in one isn't. An action not named is taken as a search. */
export const webSearchBilled = (action: unknown) => action !== "open_page" && action !== "find_in_page";

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

/**
 * What `units` of `kind` cost Orgo, in whole micro-dollars (rounded up). Kinds without a price cost
 * nothing (agentphone.plan_numbers: a plan's number is included; call.minutes: no longer written,
 * the seconds of each call are instead).
 */
export function costOf(kind: string, units: number, detail: Record<string, unknown> = {}): number {
  const u = n(units);
  let micros = 0;
  if (kind === "openai.tokens") micros = tokenCost(detail);
  else if (kind === "openai.web_search") micros = webSearchBilled(detail.action) ? u * WEB_SEARCH_CALL : 0;
  else if (kind === "openai.images") micros = imageCost(detail);
  else if (kind === "openai.transcribe_seconds") micros = u * TRANSCRIBE_SECOND;
  else if (kind === "openai.live_seconds") micros = u * (LIVE_AUDIO_SECOND + (detail.transport === "webrtc" ? 0 : SIP_LEG_SECOND));
  else if (kind === "agentphone.voice_seconds") micros = (u * VOICE_WEBHOOK_MINUTE) / 60;
  else if (kind === "agentphone.numbers") micros = u * numberCost(detail);
  else if (kind === "agentphone.sms") micros = u * (detail.mms ? MMS : SMS_SEGMENT);
  else if (kind === "typesafe.tokens") micros = jevCost(detail);
  else if (kind === "verify.sms") micros = u * VERIFY_SMS;
  else if (kind === "verify.email") micros = u * VERIFY_EMAIL;
  else if (kind === "composio.calls") micros = u * COMPOSIO_CALL;
  else if (kind === "honcho.calls") micros = u * HONCHO_CALL;
  else if (kind === "treg.calls") micros = n(detail.costMicro);
  // Tenths of a micro-dollar (cached tokens) are summed in floating point: a hair over a whole one isn't rounded up.
  return Math.ceil(Math.round(micros * 1000) / 1000);
}
