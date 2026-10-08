import "server-only";
import { randomUUID } from "node:crypto";
import { USAGE_BOT_HEADER } from "@/cloud/protocol";
import type { Bot } from "@/lib/types";
import { cloudOn, cloudProxy, cloudSessionNow } from "./cloud";
import { askOwner } from "./composio";
import { bot, installId, ownerName } from "./store";

/**
 * Business data for bots, through treg (treg.to): one token in front of 3,800+ data endpoints from
 * 100+ providers, each billed per call at the provider's own rate. Bops gives every bot:
 *
 * - business_search: the jobs a business needs most, by name: companies by industry, technology or
 *   place, lookalikes, people by title and company, a company's or person's profile, a work email
 *   (checked before it's handed back), a phone, an email check, a company's news, hiring and funding,
 *   and local businesses on Google Maps. Most are treg's routed endpoints (treg.*): treg tries the
 *   providers that answer that job, cheapest first, and a miss costs nothing.
 * - find_data and get_data: the rest of the catalog (social, SEO, ads, scraping…), searched in plain
 *   words and called by id.
 *
 * Every call goes through `call` below, the one place that talks to treg. Signed in with Orgo, it goes
 * through Bops Cloud (/proxy/treg), which holds the token, tags the call with the user and bot, caps
 * it, and pays it from the user's AI credit at what treg charged. With TREG_TOKEN in this Mac's
 * settings (self-hosting, or trying business data before the cloud has it), treg is reached directly
 * with that token instead, and paid from that token's treg team, not AI credit. The catalog itself
 * (search, an endpoint's details) is open: read from treg directly.
 *
 * What a call may cost: up to CAP at once (treg stops trying providers past it), more only with the
 * user's OK, whatever the bot's "Just do it" says (paying always asks). Endpoints that need an account
 * connected to treg, and long-running jobs (video), aren't offered yet.
 */

const TREG = (process.env.TREG_URL || "https://treg.to").replace(/\/+$/, "");

/** This Mac's own treg token (TREG_TOKEN), which wins over Bops Cloud's. */
const ownToken = () => process.env.TREG_TOKEN?.trim() || "";

/** treg is set up: this Mac's own token, or through Bops Cloud (the session says so). */
export const tregOn = () => !!ownToken() || (cloudOn() && !!cloudSessionNow()?.treg);

/** Whether a bot has business data: treg is on and the user didn't turn it off for this bot. */
export const dataOn = (b: Bot) => tregOn() && !b.dataOff;

/** The most a call may cost without asking, in dollars. */
const CAP = 0.1;
/** The most a call may ever cost, asked or not. */
const MOST = 5;

/* ---------------- Calling treg ---------------- */

type Answer = { status: number; ok: boolean; body: unknown; costMicro: number; callId?: string; servedBy?: string; refusedByTreg: boolean };

/**
 * One call to a catalog endpoint, for a bot, costing at most `maxUsd`. GET input goes in the query;
 * POST input in the body, except what the endpoint takes in its query or path. `exclude`: providers a
 * routed endpoint should skip.
 */
async function call(botId: string, endpoint: string, method: "GET" | "POST", input: unknown, maxUsd: number, queryKeys: string[] = [], exclude?: string): Promise<Answer> {
  const via = ownToken() ? null : cloudProxy("treg");
  if (!via && !ownToken()) throw new Error("Business data isn't set up.");
  const url = new URL(`${via ? via.url : TREG}/call/${encodeURIComponent(endpoint)}`);
  let body: unknown;
  if (method === "GET" || (input && typeof input === "object" && !Array.isArray(input))) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((input as Record<string, unknown>) ?? {})) {
      if (v === null || v === undefined || v === "") continue;
      if (method === "GET" || queryKeys.includes(k)) for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, typeof one === "object" ? JSON.stringify(one) : String(one));
      else rest[k] = v;
    }
    if (method === "POST") body = rest;
  } else body = input;
  const headers: Record<string, string> = {
    "x-treg-route-max-cost": Math.min(maxUsd, MOST).toFixed(6),
    ...(exclude ? { "x-treg-route-exclude": exclude } : {}),
    // A retry after a dropped connection gets treg's stored answer, not a second charge.
    "idempotency-key": randomUUID(),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(via
      ? { authorization: `Bearer ${via.key}`, [USAGE_BOT_HEADER]: botId }
      : { "x-treg-token": ownToken(), "x-treg-meta": `customer=${tag(installId())}, bot=${tag(botId)}` }),
  };
  const send = () => fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(110_000) });
  const r = await send().catch(() => send());
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON: kept as text */
  }
  return {
    status: r.status,
    ok: r.ok,
    body: parsed,
    costMicro: Number(r.headers.get("x-treg-cost-micro")) || 0,
    callId: r.headers.get("x-treg-call-id") ?? undefined,
    servedBy: r.headers.get("x-treg-served-by") ?? undefined,
    refusedByTreg: r.headers.get("x-treg-error") === "1",
  };
}

/** A value treg keeps as a tag: letters, digits and ". _ - :" only. */
const tag = (v: string) => v.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);

const clip = (s: string, n = 14_000) => (s.length > n ? `${s.slice(0, n)}… (cut short)` : s);

/** Keys that are pictures, traffic history or a provider's own bookkeeping: never worth the model's reading. */
const NOISE = /^(image|images|logo|logo_url|logoUrl|favicon|thumbnail|photo|photo_url|avatar|history|raw|_links|credits|tracking|rwg_token|book_online_url|contributor_url|main_image|cid|feature_id)$/i;

/** An answer without the noise: no pictures or history, no empty or "N/A" values, long text and long lists cut. */
function slim(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  if (Array.isArray(v)) {
    const kept = v.map((x) => slim(x, depth + 1)).filter((x) => x !== undefined);
    return kept.length > 12 && kept.every((x) => typeof x !== "object") ? [...kept.slice(0, 12), `…${kept.length - 12} more`] : kept;
  }
  if (v && typeof v === "object" && depth < 12) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (NOISE.test(k) || x === null || x === undefined || x === "" || x === "N/A" || (Array.isArray(x) && !x.length)) continue;
      const s = slim(x, depth + 1);
      if (s !== undefined && !(s && typeof s === "object" && !Array.isArray(s) && !Object.keys(s).length)) out[k] = s;
    }
    return out;
  }
  return v;
}

/** What the bot reads of an answer: a routed endpoint's `output` (not each provider's raw answer) and who served it; else the answer; without the noise, cut to size. */
function readable(a: Answer, what: string) {
  if (!a.ok) return `Failed: ${what} (${a.status}): ${clip(typeof a.body === "string" ? a.body : JSON.stringify(a.body), 600)}`;
  const b = a.body as { output?: unknown; _treg?: { served_by?: unknown } } | null;
  const out = b && typeof b === "object" && "output" in b ? { ...(b._treg?.served_by ? { from: b._treg.served_by } : {}), result: slim(b.output) } : slim(a.body);
  const text = typeof out === "string" ? out : JSON.stringify(out);
  seen(text);
  const cost = a.costMicro ? ` Cost: $${(a.costMicro / 1_000_000).toFixed(4)}.` : "";
  return `${clip(text)}${cost}`;
}

/* ---------------- People the bots found ---------------- */

/**
 * Email addresses that came back from business data (in memory, at most FOUND_MAX): sending to one of
 * them asks the user first even when the bot is set to "Just do it" (mail.ts, composio.ts). Finding
 * someone isn't permission to write to them.
 */
const found = new Set<string>();
const FOUND_MAX = 20_000;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function seen(text: string) {
  for (const m of text.match(EMAIL) ?? []) {
    if (found.size >= FOUND_MAX) found.delete(found.values().next().value!);
    found.add(m.toLowerCase());
  }
}

/** Whether any address in `text` is someone business data found. */
export const foundByBots = (text: string) => (text.match(EMAIL) ?? []).some((m) => found.has(m.toLowerCase()));

/* ---------------- business_search ---------------- */

/** One input the bot may give business_search, flat, so one schema serves every job. */
type Input = {
  query?: string | null;
  name?: string | null;
  domain?: string | null;
  industry?: string | null;
  technology?: string | null;
  title?: string | null;
  keywords?: string[] | null;
  full_name?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
  country?: string | null;
  location?: string | null;
  limit?: number | null;
};

/** One job: its endpoint, what it needs, the bot's input as the endpoint's, the most it may cost (CAP unless said), and providers to skip. */
type Job = { endpoint: string; method: "GET" | "POST"; needs: string; input: (i: Input) => Record<string, unknown>; maxUsd?: number; exclude?: string };

const rows = (i: Input) => Math.min(25, Math.max(1, Math.round(Number(i.limit) || 10)));
const site = (d?: string | null) => d?.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase() || undefined;
const some = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));

/** Each job: the endpoint that does it (from treg's catalog, checked 2026-10-07), what it needs, and how the bot's input becomes the endpoint's. */
const JOBS: Record<string, Job> = {
  companies: {
    endpoint: "treg.companies.search",
    method: "POST",
    needs: "query (a plain description), or industry, technology, name or domain; country (ISO code), limit",
    input: (i) => some({ q: i.query, name: i.name, industry: i.industry, technology: i.technology, domain: site(i.domain), country: i.country, limit: rows(i) }),
  },
  // Tomba's lookalikes are companies with similar names (modal.com → modalshop.com); Ocean.io's are real ones, about $0.16 for ten.
  similar_companies: { endpoint: "treg.companies.similar", method: "POST", needs: "domain", input: (i) => some({ domain: site(i.domain) }), maxUsd: 0.25, exclude: "tomba" },
  people: {
    endpoint: "treg.people.search",
    method: "POST",
    needs: "title and domain (the company's), or query, full_name; keywords, location, country, limit",
    input: (i) => some({ q: i.query, company_domain: site(i.domain), title: i.title, full_name: i.full_name, keywords: i.keywords, location: i.location, country: i.country, limit: rows(i) }),
  },
  company: {
    endpoint: "treg.companies.enrich",
    method: "POST",
    needs: "domain (best), or name, linkedin_url, email",
    input: (i) => some({ domain: site(i.domain), name: i.name, linkedin_url: i.linkedin_url, email: i.email }),
  },
  person: {
    endpoint: "treg.people.enrich",
    method: "POST",
    needs: "email or linkedin_url, or full_name and domain",
    input: (i) => some({ email: i.email, linkedin_url: i.linkedin_url, full_name: i.full_name, domain: site(i.domain) }),
  },
  work_email: {
    endpoint: "treg.people.email.find",
    method: "POST",
    needs: "full_name and domain (the company's), or linkedin_url",
    input: (i) => some({ full_name: i.full_name, domain: site(i.domain), linkedin_url: i.linkedin_url }),
  },
  phone: {
    endpoint: "treg.people.phone.find",
    method: "POST",
    needs: "linkedin_url (best), or email, or full_name and domain",
    input: (i) => some({ linkedin_url: i.linkedin_url, email: i.email, full_name: i.full_name, domain: site(i.domain) }),
  },
  check_email: { endpoint: "treg.people.email.verify", method: "POST", needs: "email", input: (i) => some({ email: i.email?.trim() }) },
  news: { endpoint: "treg.companies.news", method: "POST", needs: "domain; limit", input: (i) => some({ domain: site(i.domain), limit: rows(i) }) },
  hiring: {
    endpoint: "predictleads.companies.job_openings",
    method: "GET",
    needs: "domain; limit",
    input: (i) => some({ company_id_or_domain: site(i.domain), active_only: true, limit: rows(i) }),
  },
  funding: { endpoint: "aviato.companies.funding_rounds", method: "GET", needs: "domain", input: (i) => some({ website: site(i.domain), perPage: 10, page: 0 }) },
  places: {
    endpoint: "treg.google.serp.maps",
    method: "POST",
    needs: "query (what and where: \"dentists in Austin, TX\"); country (ISO code)",
    input: (i) => some({ q: i.query, country: i.country?.toLowerCase() }),
  },
};

const ABOUT: Record<keyof typeof JOBS, string> = {
  companies: "companies by description, industry, technology or country",
  similar_companies: "companies like one you name (about $0.16 for ten)",
  people: "people by title at a company, or by role, skills and place",
  company: "one company's profile: size, industry, location, links",
  person: "one person's profile: title, company, location, links",
  work_email: "a person's work email, checked that it can receive mail",
  phone: "a person's work phone or direct dial",
  check_email: "whether an email address can receive mail",
  news: "a company's recent news",
  hiring: "a company's open jobs (a hiring signal)",
  funding: "a company's funding rounds",
  places: "local businesses on Google Maps, with address, phone, rating and website",
};

const STR = (description: string) => ({ type: ["string", "null"], description });

/** The three tools a bot with business data gets (dataOn). */
export const DATA_TOOLS = (b: Bot) => {
  if (!dataOn(b)) return [];
  const owner = ownerName();
  return [
    {
      type: "function" as const,
      name: "business_search",
      description: `Look up business data from 100+ data providers: ${Object.entries(ABOUT)
        .map(([job, about]) => `${job} (${about})`)
        .join("; ")}. Fill only the fields that job uses: ${Object.entries(JOBS)
        .map(([job, j]) => `${job}: ${j.needs}`)
        .join("; ")}. Give the inputs you actually have (a LinkedIn URL or the company's domain beats a name). Most lookups cost under a cent and a miss is free.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["job"],
        properties: {
          job: { type: "string", enum: Object.keys(JOBS) },
          query: STR("Plain words: \"Series A fintech in New York\", \"dentists in Austin, TX\"."),
          name: STR("A company's name."),
          domain: STR("A company's website domain, e.g. stripe.com."),
          industry: STR("An industry, e.g. \"fintech\"."),
          technology: STR("A technology the company uses, e.g. \"HubSpot\"."),
          title: STR("A job title or role, e.g. \"Head of Marketing\"."),
          keywords: { type: ["array", "null"], items: { type: "string" }, description: "Skills or topics a person must match." },
          full_name: STR("A person's full name."),
          email: STR("An email address."),
          linkedin_url: STR("A LinkedIn profile or company URL."),
          country: STR("A two-letter country code, e.g. US."),
          location: STR("A place, e.g. \"London, United Kingdom\"."),
          limit: { type: ["integer", "null"], description: "How many results, 1 to 25 (10 if null). Most providers charge per result." },
        },
      },
      strict: false,
    },
    {
      type: "function" as const,
      name: "find_data",
      description: `Search the rest of the business data catalog (3,800+ endpoints: social profiles and posts, SEO and search results, ads libraries, reviews, app stores, web scraping…) for a job business_search doesn't do. It answers with each endpoint's id, price per call, how often it works, and its inputs. Then call get_data.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", description: "The job in plain words: \"tiktok profile followers\", \"backlinks for a domain\"." } },
      },
      strict: false,
    },
    {
      type: "function" as const,
      name: "get_data",
      description: `Call one endpoint from find_data by its exact id, with its inputs. Up to $${CAP.toFixed(2)} a call runs at once; a dearer one asks ${owner} first, with its price.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["endpoint_id", "input"],
        properties: {
          endpoint_id: { type: "string", description: "The exact id from find_data, e.g. anyapi.tiktok.user.profile." },
          input: { type: "object", description: "Its inputs, as find_data listed them (query, path and body inputs all here, by name)." },
        },
      },
      strict: false,
    },
  ];
};

/** Names of the data tools, for the places that pass tool calls on (chat.ts, computer-task.ts, composio.ts threadApps). */
export const DATA_TOOL_NAMES = new Set(["business_search", "find_data", "get_data"]);

/** business_search: one job, its answer for the bot. A work email is checked before it's handed back. */
export async function businessSearch(botId: string, job: string, input: Input): Promise<string> {
  const b = bot(botId);
  if (!b || !dataOn(b)) return "You don't have business data.";
  const j = JOBS[job];
  if (!j) return `Unknown job ${job}. Use one of: ${Object.keys(JOBS).join(", ")}.`;
  const args = j.input(input);
  if (!Object.keys(args).some((k) => !["limit", "country", "active_only", "perPage", "page"].includes(k))) return `${job} needs ${j.needs}.`;
  const a = await call(botId, j.endpoint, j.method, args, j.maxUsd ?? CAP, [], j.exclude);
  if (job !== "work_email" || !a.ok) return readable(a, job);
  const email = (a.body as { output?: { email?: unknown } } | null)?.output?.email;
  if (typeof email !== "string" || !email) return readable(a, job);
  const check = await call(botId, JOBS.check_email.endpoint, "POST", { email }, CAP).catch(() => null);
  const status = check?.ok ? (check.body as { output?: { status?: unknown } } | null)?.output?.status : undefined;
  const found = readable(a, job);
  const checked = check ? check.costMicro : 0;
  return `${found}\nChecked: ${typeof status === "string" ? status : "couldn't tell"}${checked ? ` (check cost $${(checked / 1_000_000).toFixed(4)})` : ""}. Only send to an address that checked out as valid or deliverable.`;
}

/* ---------------- find_data, get_data ---------------- */

/** One catalog endpoint, as the open catalog describes it. */
type Endpoint = {
  id: string;
  name?: string;
  summary?: string;
  provider?: string;
  method?: string;
  kind?: string;
  scope?: string;
  async?: unknown;
  platform_eligible?: boolean;
  superseded_by?: string | null;
  cost?: { usd?: number; unit?: string; type?: string };
  observed?: { ok_rate?: number | null; samples?: number };
  input?: { body?: Record<string, unknown> | unknown[]; queryParams?: Record<string, unknown>; query?: Record<string, unknown>; pathParams?: Record<string, unknown> };
};

/** What Bops lets a bot call: on treg's own keys (no account connected to treg), not a long-running job, not replaced by a newer one. */
const callable = (e: Endpoint) => ["data", "routed", "utility"].includes(e.kind ?? "") && e.scope !== "own_account" && !e.async && e.platform_eligible !== false && !e.superseded_by;

const endpoints = new Map<string, { at: number; e: Endpoint | null }>();

async function endpointOf(id: string): Promise<Endpoint | null> {
  const hit = endpoints.get(id);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.e;
  const r = await fetch(`${TREG}/catalog/endpoints/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok && r.status !== 404) throw new Error(`treg's catalog answered ${r.status}`);
  const data = r.ok ? ((await r.json()) as { endpoint?: Endpoint; usd_per_call?: number }) : null;
  const e = data?.endpoint?.id === id ? { ...data.endpoint, cost: { ...data.endpoint.cost, usd: data.usd_per_call ?? data.endpoint.cost?.usd } } : null;
  if (endpoints.size > 2_000) endpoints.clear();
  endpoints.set(id, { at: Date.now(), e });
  return e;
}

const price = (e: Endpoint) => {
  const usd = Number(e.cost?.usd) || 0;
  return usd ? `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}${e.cost?.unit && e.cost.unit !== "call" ? ` per ${e.cost.unit}` : ""}` : "free";
};

/** An endpoint's inputs, short: name, type, required, a note or example. */
function inputsOf(e: Endpoint) {
  const fields = (o: unknown, where: string) =>
    o && typeof o === "object" && !Array.isArray(o)
      ? Object.entries(o as Record<string, { type?: string; required?: boolean; note?: string; example?: unknown }>).map(([k, v]) => ({
          name: k,
          in: where,
          type: v?.type,
          ...(v?.required ? { required: true } : {}),
          ...(v?.note ? { note: String(v.note).slice(0, 160) } : {}),
          ...(v?.example !== undefined ? { example: v.example } : {}),
        }))
      : [];
  return [...fields(e.input?.pathParams, "path"), ...fields(e.input?.queryParams ?? e.input?.query, "query"), ...fields(e.input?.body, "body")];
}

/** find_data: the open catalog's search, only what Bops can call, cut down to what the model needs. */
export async function findData(botId: string, query: string): Promise<string> {
  const b = bot(botId);
  if (!b || !dataOn(b)) return "You don't have business data.";
  if (!query.trim()) return "Say what the job is.";
  const url = new URL(`${TREG}/catalog/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "12");
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return `Failed: the catalog answered ${r.status}.`;
  const results = ((await r.json()) as { results?: Endpoint[] }).results ?? [];
  const ok = results.filter(callable).slice(0, 6);
  if (!ok.length) return "Nothing in the catalog does that. Try other words, or do it on a computer.";
  return clip(
    JSON.stringify(
      ok.map((e) => ({
        id: e.id,
        what: e.summary ?? e.name,
        price: price(e),
        ...(e.observed?.ok_rate != null && e.observed.samples ? { works: `${Math.round(e.observed.ok_rate * 100)}% of ${e.observed.samples} calls` } : {}),
        ...(e.kind === "routed" ? { routed: "tries several providers, cheapest first" } : {}),
        inputs: inputsOf(e),
      })),
    ),
  );
}

/** get_data: one endpoint by id. Up to CAP runs at once; a dearer one waits for the user's OK (and `onAsk` lets a chat turn go on meanwhile). */
export async function getData(botId: string, endpointId: string, input: unknown, where: { chatId?: string; sessionId?: string }, onAsk?: (ask: Promise<string>) => void): Promise<string> {
  const b = bot(botId);
  if (!b || !dataOn(b)) return "You don't have business data.";
  const e = await endpointOf(endpointId.trim());
  if (!e) return `No endpoint ${endpointId}. Use find_data to get the exact id.`;
  if (!callable(e)) return `${endpointId} can't be used from Bops yet (it needs an account of its own, or it's a long-running job). Use find_data for another.`;
  const method = e.method?.toUpperCase() === "GET" ? "GET" : "POST";
  const queryKeys = [...Object.keys(e.input?.pathParams ?? {}), ...Object.keys(e.input?.queryParams ?? e.input?.query ?? {})];
  const usd = Number(e.cost?.usd) || 0;
  const run = (max: number) => call(botId, e.id, method, input ?? {}, max, queryKeys).then((a) => readable(a, e.id));
  if (usd <= CAP) return run(CAP);
  if (usd > MOST) return `${e.id} costs ${price(e)} a call, more than Bops allows. Use find_data for another.`;
  const owner = ownerName();
  const ask = askOwner({
    botId,
    app: "data",
    action: e.id,
    // The card reads "<bot> wants to: <title>".
    title: `${(e.summary ?? e.name ?? `Use ${e.id}`).replace(/[.\s]+$/, "")} (about ${price(e)})`,
    detail: `${e.id} on treg, about ${price(e)} from your AI credit.\n\n${clip(JSON.stringify(input ?? {}, null, 1), 1200)}`,
    ...where,
  }).then((yes) => (yes ? run(Math.min(MOST, usd * 1.5 + 0.01)) : `Not approved: ${owner} said no. Don't do it.`));
  if (onAsk) {
    onAsk(ask);
    return `This one costs about ${price(e)}, so ${owner} has to OK it first. Bops is showing them the details. Tell them in one short line, and don't call it again.`;
  }
  return ask;
}

/** A data tool call by name, for the places that pass tool calls on. */
export function runDataTool(botId: string, name: string, args: Record<string, unknown>, where: { chatId?: string; sessionId?: string }, onAsk?: (ask: Promise<string>) => void): Promise<string> {
  if (name === "business_search") return businessSearch(botId, String(args.job ?? ""), args as Input);
  if (name === "find_data") return findData(botId, String(args.query ?? ""));
  return getData(botId, String(args.endpoint_id ?? ""), args.input, where, onAsk);
}

/** What a bot is told about its business data, for its chat, tasks and calls (skills.ts style). */
export function dataNote(b: Bot, mode: "chat" | "task" | "call", opts: { tools?: boolean } = {}) {
  if (!dataOn(b)) return "";
  const owner = ownerName();
  if (mode === "call") return `You can look up companies, people, work emails, phones and company news: on a call, delegate it; your delegate has business_search.`;
  if (mode === "task" && opts.tools === false)
    return `Business data (business_search) can't be reached from this computer in this task. If a step needs companies, people or contact details, say so in your answer: in your chat, ${owner} can have you look them up.`;
  return [
    `Business data: business_search looks up companies (by description, industry, technology, country, or like one you name), people (by title at a company, or by role and place), a company's or person's profile, a work email (checked before you get it), a phone, whether an email can receive mail, a company's news, open jobs and funding, and local businesses on Google Maps.`,
    `Use it before searching the web or browsing LinkedIn for these: it's faster, surer, and costs cents. Give it the inputs you have; a company's domain or a LinkedIn URL beats a name. For a list (companies, then the right person at each, then their email), go one step at a time and keep only the rows that fit.`,
    `find_data and get_data reach the rest of the catalog (social profiles and posts, SEO, ads libraries, reviews, app stores, scraping): search, then call by exact id.`,
    `Finding someone isn't permission to contact them: never email, text or message a person you found this way without ${owner}'s OK for that send, even if you're set to "Just do it". Never guess an email address: use one that checked out.`,
    mode === "chat" ? `Use these yourself, right here in the chat, for a few lookups; a long list (dozens of rows) is a task.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
