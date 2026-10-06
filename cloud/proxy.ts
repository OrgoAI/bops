import { request as httpRequest, STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { requireCredit } from "./credit.ts";
import { seal } from "./crypto.ts";
import { objectModel, objectOwner, ownObject, query } from "./db.ts";
import { HttpError, readBody, refuseUpgrade, type Route, type Upgrade } from "./http.ts";
import { recordLine } from "./lines.ts";
import { numberCost, smsSegments } from "./pricing.ts";
import { accountFor, composioUserId, honchoPrefix, ownsWorkspace } from "./session.ts";
import { recordTokens, recordUsage, recordUsageFor } from "./usage.ts";

/**
 * /proxy/<provider>/*: the Mac's calls to OpenAI, AgentPhone, Honcho, Composio and Typesafe, sent on
 * with Orgo's key and kept inside the calling user's own things.
 *
 * - Deny by default: each provider has a list of the routes the app uses (the rules below); anything
 *   else is 403. Paths must be plain (no percent-encoding, no "." or ".." segments, no empty ones),
 *   so the path that's checked is the path that's sent. The query is parsed and sent re-encoded, and
 *   a JSON body is parsed, checked and sent re-serialized, so the provider reads what was checked.
 * - The caller's Authorization and every other header that isn't on a short list (provider keys,
 *   project or account pickers, cookies, forwarding headers) are dropped, and the provider key from
 *   config is added. Bodies up to 25 MB. Answers stream back as they come, server-sent events one
 *   event at a time; an event or answer that makes an object is held only until its owner is
 *   recorded, so the Mac can never name an object before the cloud knows it's theirs.
 * - What keeps users apart, per provider, is at each provider's rules (see README.md).
 * - Routes that spend (a model's answer, a call, a number, a text, a Typesafe call) are refused with
 *   402 once the user's AI credit is used up (credit.ts), before anything is sent on. Reads, hanging
 *   up and turning a call away never are.
 */

const MAX_BODY = 25 * 1024 * 1024;

type Provider = "openai" | "agentphone" | "honcho" | "composio" | "typesafe";

/** A call on its way through: who's asking and where to, and what the rules may check or change before it goes. */
type Call = {
  user: CloudUser;
  method: string;
  /** The path after /proxy/<provider>, split on "/". */
  path: string[];
  /** The path segments the matching rule named (":session" → its value). */
  params: Record<string, string>;
  query: URLSearchParams;
  /** The parsed JSON body, when the provider's bodies are read (undefined: none). */
  json?: unknown;
  /** Added to the request sent on (AgentPhone's X-Sub-Account-Id). */
  headers: Record<string, string>;
  /** Objects already recorded as this user's during this call (a stream names the same turn many times). */
  owned: Set<string>;
  /** The Agents API session a stream belongs to, once known. */
  session?: string;
  /** That session's model, once looked up (null: the cloud never saw it), to price its turns. */
  model?: string | null;
};

type Hook<T> = (call: Call, value: T) => Promise<unknown> | unknown;

/** One allowed route and what happens on it. */
type Rule = {
  method: string;
  pattern: string[];
  /** Params naming objects that must be this user's (bops.cloud_objects); anything else is 404. */
  own?: string[];
  /** Before sending: refuse (HttpError) or change call.json, call.query, call.headers. */
  check?: (call: Call) => Promise<void> | void;
  /** A 2xx JSON answer: record what it makes, and return the body the Mac gets instead (undefined: as it came). */
  json?: Hook<unknown>;
  /** Each event of a 2xx event stream, before it's passed on. */
  event?: Hook<unknown>;
  /** After any 2xx answer has been sent. */
  done?: (call: Call) => Promise<unknown> | unknown;
  /** It spends AI credit: refused (402) when the user has none left, or less than `minCost` (micro-dollars). */
  spends?: true;
  minCost?: (call: Call) => number;
};

/** "GET v1/agents/sessions/:session/events", with what to do on it. "*" as the method is any; "*" at the end of the path is anything below. */
const rule = (route: string, more: Omit<Rule, "method" | "pattern"> = {}): Rule => {
  const [method, path] = route.split(" ");
  return { method, pattern: path.split("/"), ...more };
};

type Spec = {
  name: string;
  key: () => string;
  upstream: () => string;
  auth: (key: string) => Record<string, string>;
  /** How request bodies are handled: read as JSON (checked, re-serialized), the same except file uploads (piped), or piped as is. */
  body: "json" | "json-or-upload" | "pipe";
  /** For every call to this provider, before its route's own check. */
  check?: (call: Call) => Promise<void> | void;
  rules: Rule[];
  /** How long to wait for the provider to start answering. */
  timeoutMs: number;
};

/* ---------------- Paths, queries and bodies ---------------- */

/** A path segment as the cloud passes it on: no "%", "/", "\" or anything else a server might read differently. */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The path below `prefix` and the query of the raw request target (never the normalized one), or 400. */
function target(raw: string | undefined, prefix: string) {
  const url = raw ?? "";
  const q = url.indexOf("?");
  const pathname = q < 0 ? url : url.slice(0, q);
  if (!pathname.startsWith(`${prefix}/`)) throw new HttpError(400, "That path isn't allowed.");
  const path = pathname.slice(prefix.length + 1).split("/");
  if (path.some((s) => !SEGMENT.test(s) || /^\.+$/.test(s))) throw new HttpError(400, "That path isn't allowed.");
  return { path, query: new URLSearchParams(q < 0 ? "" : url.slice(q + 1)) };
}

function matchPath(pattern: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") return path.length > i ? params : null;
    if (i >= path.length) return null;
    if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = path[i];
    else if (pattern[i] !== path[i]) return null;
  }
  return path.length === pattern.length ? params : null;
}

function match(spec: Spec, call: Call): Rule {
  for (const r of spec.rules) {
    if (r.method !== "*" && r.method !== call.method) continue;
    const params = matchPath(r.pattern, call.path);
    if (params) {
      call.params = params;
      return r;
    }
  }
  throw new HttpError(403, `Bops Cloud doesn't pass ${call.method} /${call.path.join("/")} on to ${spec.name}.`);
}

const qs = (query: URLSearchParams) => {
  const s = query.toString();
  return s ? `?${s}` : "";
};

/** A JSON key as the providers' parsers may read it: any case, with or without "_" and "-" (user_id, userId, USER-ID). */
const norm = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

/** A query key the same way, without any "[…]" (user_ids[], toolkit_versions[gmail]). */
const queryKey = (key: string) => norm(key.replace(/\[.*$/, ""));

/** Every query parameter as a key (normalized) and the values in it ("a,b" is two). */
const queryValues = (query: URLSearchParams) => [...query].map(([k, v]) => ({ key: queryKey(k), value: v.split(",").map((x) => x.trim()) }));

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Parts of a body that are free text, schemas, or meant for an app (a tool's arguments, a proxied
 * call's body, a trigger's own settings), never references: what's under these keys is passed on unread.
 */
const FREE_FORM = new Set(["metadata", "parameters", "properties", "schema", "inputschema", "outputschema", "jsonschema", "arguments", "body", "triggerconfig"]);

type Found = { key: string; value: unknown; parent?: Record<string, unknown> };

/** Every key (normalized), its value and the object it's in, anywhere in a JSON body outside the free-form parts. */
function keysIn(value: unknown, out: Found[] = [], depth = 0): Found[] {
  if (depth > 64) throw new HttpError(400, "That body is nested too deeply.");
  if (Array.isArray(value)) for (const v of value) keysIn(v, out, depth + 1);
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) {
      const key = norm(k);
      if (FREE_FORM.has(key)) continue;
      out.push({ key, value: v, parent: value });
      keysIn(v, out, depth + 1);
    }
  return out;
}

/** The ids a reference names: a string, an object's `id`, or every one in a list or map. */
function idsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(idsIn);
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? [id] : Object.values(value).flatMap(idsIn);
  }
  return [];
}

const hasBody = (req: IncomingMessage) => Number(req.headers["content-length"] ?? 0) > 0 || !!req.headers["transfer-encoding"];
const isUpload = (req: IncomingMessage) => /^multipart\//i.test(String(req.headers["content-type"] ?? ""));

/** Any body that isn't a file upload is read as JSON, whatever it says it is (a server may read one with no content type as JSON), and sent on as JSON. */
function parseBody(raw: Buffer): unknown {
  if (!raw.length) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Body isn't JSON");
  }
}

/** The object at `path` in the call's JSON body (made if missing), to set something in it. */
function bodyAt(call: Call, path: string[]): Record<string, unknown> {
  call.json ??= {};
  let o: unknown = call.json;
  for (const k of path) {
    if (!isObject(o)) break;
    o[k] ??= {};
    o = o[k];
  }
  if (!isObject(o)) throw new HttpError(400, "The body should be a JSON object.");
  return o;
}

/** Throw 404 unless the object is this user's: the same answer for someone else's as for one the cloud never saw. */
async function mustOwn(provider: Provider, call: Call, id: string) {
  if ((await objectOwner(provider, id)) !== call.user.id) throw new HttpError(404, "Not found");
}

/** Record an object as this user's (once per call), with the model it runs on when that's known. */
async function own(call: Call, provider: Provider, kind: string, id: string, model?: string) {
  if (call.owned.has(id)) return;
  call.owned.add(id);
  await ownObject(call.user.id, provider, kind, id, model);
}

/** Usage is counted on the side: a failure to count never fails the call. */
const counted = (p: Promise<unknown>) => void p.catch((e: Error) => console.warn(`[proxy] usage: ${e.message}`));

/* ---------------- OpenAI ---------------- */

/**
 * OpenAI keys in a body that name a stored object. The ones a user makes through the cloud must be
 * theirs; the rest (files, vector stores, containers, stored agents, vaults, skills, environment
 * templates, item references, stored reasoning, stored prompts) are never passed through: the app
 * doesn't use them, and in one shared project they'd reach whoever made them.
 */
const OPENAI_OWNED_REFS = new Set(["previousresponseid", "responseid", "conversation", "conversationid", "sessionid"]);
const OPENAI_REFUSED_REFS = new Set(["fileid", "fileids", "vectorstoreid", "vectorstoreids", "agentid", "vaultid", "vaultids", "environmenttemplateid", "skillid", "pluginid", "containerid"]);

async function openaiRefs(call: Call) {
  for (const { key, value, parent } of [...queryValues(call.query), ...keysIn(call.json)] as Found[]) {
    const refused =
      (OPENAI_REFUSED_REFS.has(key) && idsIn(value).length > 0) ||
      (key === "container" && typeof value === "string") ||
      (key === "prompt" && isObject(value) && "id" in value) ||
      (key === "type" && value === "item_reference") ||
      // A reasoning item named by id alone is looked up in storage, like an item reference.
      (key === "type" && value === "reasoning" && typeof parent?.id === "string" && !parent.encrypted_content);
    if (refused) throw new HttpError(403, "Bops Cloud doesn't pass references to stored OpenAI objects through.");
    if (OPENAI_OWNED_REFS.has(key)) for (const id of idsIn(value)) await mustOwn("openai", call, id);
  }
}

type ResponseObject = { id?: unknown; object?: unknown; model?: unknown; usage?: unknown };

/** A response (JSON, or the `response` of a streamed event): its id is the user's, and its tokens are counted when it's done. */
async function recordResponse(call: Call, r: ResponseObject | undefined, done: boolean) {
  if (r?.object !== "response" || typeof r.id !== "string") return;
  await own(call, "openai", "response", r.id);
  if (done) counted(recordTokens(call.user.id, r.id, r.usage, { model: r.model, source: "responses" }));
}

type AgentEvent = {
  type?: string;
  session_id?: unknown;
  session?: { id?: unknown; object?: unknown };
  turn_id?: unknown;
  turn?: { id?: unknown; subagent_id?: unknown; usage?: unknown };
  subagent?: { id?: unknown };
  usage?: unknown;
};

/** The model a new Agents API session is asked for (agent.model in the body that makes it). */
function modelAsked(call: Call): string | undefined {
  const agent = isObject(call.json) ? call.json.agent : undefined;
  return isObject(agent) && typeof agent.model === "string" ? agent.model : undefined;
}

/** The model of the session a turn is in, as recorded when the session was made (null: never seen; priced at the dearest). */
async function turnModel(call: Call, session: string | undefined): Promise<string | undefined> {
  if (call.model === undefined) call.model = modelAsked(call) ?? (session ? await objectModel("openai", session) : null);
  return call.model ?? undefined;
}

/** A finished agent turn's tokens, at its session's model. */
const turnTokens = (call: Call, session: string | undefined, turn: string, usage: unknown) =>
  counted(turnModel(call, session).then((model) => recordTokens(call.user.id, turn, usage, { model, source: "agent" })));

/**
 * An Agents API session event (its own stream, or a session made with stream: true): the session,
 * its turns and its helpers (subagents) become the user's as they're named, and a finished turn's
 * tokens are counted. Only events of the stream's own session count.
 */
async function agentEvent(call: Call, data: unknown) {
  const e = data as AgentEvent;
  if (e.type === "agent.session.created" && e.session?.object === "agent.session" && typeof e.session.id === "string") {
    call.session ??= e.session.id;
    await own(call, "openai", "agent_session", e.session.id, modelAsked(call));
  }
  if (typeof e.session_id === "string" && e.session_id !== call.session) return;
  if (typeof e.turn_id === "string") await own(call, "openai", "agent_turn", e.turn_id);
  if (typeof e.turn?.id === "string") await own(call, "openai", "agent_turn", e.turn.id);
  if (typeof e.turn?.subagent_id === "string") await own(call, "openai", "agent_subagent", e.turn.subagent_id);
  if (e.type === "agent.session.subagent.created" && typeof e.subagent?.id === "string") await own(call, "openai", "agent_subagent", e.subagent.id);
  if (/^agent\.session\.turn\.(completed|failed|cancelled)$/.test(e.type ?? "") && typeof e.turn_id === "string") turnTokens(call, call.session, e.turn_id, e.usage ?? e.turn?.usage);
}

/** Exactly the OpenAI endpoints the app uses (lib/server/chat, sessions, call, phone, memory, watches.ts). */
const openai: Spec = {
  name: "OpenAI",
  key: config.openaiKey,
  upstream: config.upstream.openai,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  body: "json",
  check: openaiRefs,
  timeoutMs: 15 * 60_000,
  rules: [
    rule("POST v1/responses", {
      spends: true,
      json: (call, data) => recordResponse(call, data as ResponseObject, true),
      event: (call, data) => {
        const e = data as { type?: string; response?: ResponseObject };
        return recordResponse(call, e.response, /^response\.(completed|incomplete|failed)$/.test(e.type ?? ""));
      },
    }),
    // A call in the app: the live session it makes is the user's (a phone call's is recorded by /hooks/openai).
    rule("POST v1/live/sessions", {
      spends: true,
      json: async (call, data) => {
        const id = (data as { session?: { id?: unknown } }).session?.id;
        if (typeof id === "string") await own(call, "openai", "live_session", id);
      },
    }),
    rule("POST v1/live/sessions/:live/accept", { own: ["live"], spends: true }),
    rule("POST v1/live/sessions/:live/reject", { own: ["live"] }),
    rule("POST v1/live/sessions/:live/hangup", { own: ["live"] }),
    // A task: the session's model is kept with it, for pricing its turns.
    rule("POST v1/agents/sessions", {
      spends: true,
      json: async (call, data) => {
        const s = data as { id?: unknown; object?: unknown };
        if (s.object === "agent.session" && typeof s.id === "string") await own(call, "openai", "agent_session", s.id, modelAsked(call));
      },
      event: agentEvent,
    }),
    rule("GET v1/agents/sessions/:session/events", {
      own: ["session"],
      event: (call, data) => {
        call.session = call.params.session;
        return agentEvent(call, data);
      },
    }),
    rule("POST v1/agents/sessions/:session/events", { own: ["session"], spends: true }),
    rule("GET v1/agents/sessions/:session/turns/:turn", {
      own: ["session", "turn"],
      json: (call, data) => {
        const t = data as { object?: unknown; status?: unknown; usage?: unknown };
        if (t.object === "agent.session.turn" && ["completed", "failed", "cancelled"].includes(String(t.status))) turnTokens(call, call.params.session, call.params.turn, t.usage);
      },
    }),
    rule("GET v1/agents/sessions/:session/items", { own: ["session"] }),
    rule("GET v1/agents/sessions/:session/subagents", {
      own: ["session"],
      json: async (call, data) => {
        const list = (data as { data?: unknown }).data;
        if (Array.isArray(list))
          for (const s of list as { id?: unknown; object?: unknown }[])
            if (s?.object === "agent.session.subagent" && typeof s.id === "string") await own(call, "openai", "agent_subagent", s.id);
      },
    }),
    rule("GET v1/agents/sessions/:session/subagents/:subagent/items", { own: ["session", "subagent"] }),
  ],
};

/* ---------------- AgentPhone ---------------- */

const hookUrl = () => `${config.publicUrl()}/hooks/agentphone`;
const SUB_ACCOUNT_KEYS = new Set(["subaccountid", "subaccount", "subaccountids"]);

/** Every AgentPhone call acts in the user's own sub-account, whatever the Mac sent. Naming one any other way is refused. */
async function inSubAccount(call: Call) {
  const sub = (await accountFor(call.user.id))?.agentphoneSubAccount;
  if (!sub) throw new HttpError(409, "Your phone isn't set up yet. Restart Bops and try again.");
  if ([...queryValues(call.query), ...keysIn(call.json)].some((x) => SUB_ACCOUNT_KEYS.has(x.key))) throw new HttpError(400, "Bops Cloud picks the AgentPhone sub-account.");
  call.headers["x-sub-account-id"] = sub;
}

type ApNumber = { id: string; phoneNumber: string; type?: unknown };

/** Numbers in an answer that lists or makes them: a number, a list of numbers, or agents with their numbers. */
function numbersIn(data: unknown): ApNumber[] {
  const list: unknown[] = isObject(data) && Array.isArray(data.data) ? data.data : [data];
  return list
    .flatMap((x) => [x, ...(isObject(x) && Array.isArray(x.numbers) ? x.numbers : [])])
    .filter((x): x is ApNumber => isObject(x) && typeof x.id === "string" && typeof x.phoneNumber === "string");
}

/**
 * Record each number as the user's, so a call or text to it finds them. Calls are matched on 10
 * digits, so only US and Canadian (+1) numbers are recorded: another country's number with the same
 * last 10 digits could otherwise take over someone else's. A number that moved accounts moves with it.
 */
async function recordNumbers(call: Call, data: unknown) {
  for (const n of numbersIn(data)) {
    const digits = /^\+?1(\d{10})$/.exec(n.phoneNumber.replace(/[^\d+]/g, ""))?.[1];
    if (!digits) {
      console.warn(`[proxy] ${call.user.id}'s number ${n.id} isn't a US or Canadian number: calls to it can't be routed`);
      continue;
    }
    await query(
      `INSERT INTO bops.cloud_numbers (digits, user_id, number_id, e164) VALUES ($1, $2, $3, $4)
       ON CONFLICT (digits) DO UPDATE SET user_id = EXCLUDED.user_id, number_id = EXCLUDED.number_id, e164 = EXCLUDED.e164, updated_at = now()`,
      [digits, call.user.id, n.id, n.phoneNumber],
    );
  }
}

/**
 * A number bought or attached to an agent is one of the user's lines (bops.phone_lines, lines.ts): a
 * bought one starts its 15 minutes for the first caller to claim it. The app says which bot it's for
 * after (PUT /v1/phone/lines); this is what holds if it never does.
 */
async function recordBought(call: Call, data: unknown) {
  for (const n of numbersIn(data)) await recordLine(call.user.id, n, { open: true }).catch(lineNotKept(call));
}

async function recordAttached(call: Call) {
  const numberId = isObject(call.json) ? (call.json.numberId ?? call.json.number_id) : undefined;
  if (typeof numberId !== "string") return;
  const r = await query<{ e164: string | null; digits: string }>("SELECT e164, digits FROM bops.cloud_numbers WHERE user_id = $1 AND number_id = $2", [call.user.id, numberId]);
  const row = r.rows[0];
  if (row) await recordLine(call.user.id, { id: numberId, phoneNumber: row.e164 ?? `+1${row.digits}` }).catch(lineNotKept(call));
}

/** A line that couldn't be written never fails the Mac's call: AgentPhone did it, and the app's PUT /v1/phone/lines writes it again. */
const lineNotKept = (call: Call) => (e: Error) => console.warn(`[proxy] ${call.user.id}'s line wasn't kept: ${e.message}`);

/** What kind of number a purchase asks for (an iMessage line, and which kind, or a number), to price it. */
function numberAsked(call: Call): { type?: unknown; imessageType?: unknown } {
  const body = isObject(call.json) ? call.json : {};
  return { type: body.type, imessageType: body.imessageType ?? body.imessage_type };
}

/** Keys of a message's pictures in AgentPhone's body (media_url, mediaUrls…). */
const MEDIA_KEYS = new Set(["media", "mediaurl", "mediaurls"]);

/** A text the Mac sent, counted by segment (a picture message as one), at AgentPhone's price. */
function countText(call: Call) {
  const body = isObject(call.json) ? call.json : {};
  const mms = Object.entries(body).some(([k, v]) => MEDIA_KEYS.has(norm(k)) && (Array.isArray(v) ? v.length > 0 : !!v));
  const text = typeof body.body === "string" ? body.body : "";
  counted(recordUsage(call.user.id, "agentphone.sms", mms ? 1 : smsSegments(text), { direction: "out", ...(mms ? { mms: true } : {}) }));
}

/** A webhook registration goes to the cloud's own address, whatever the Mac asked for. */
function webhookToCloud(call: Call) {
  if (!config.publicUrl()) throw new HttpError(503, "This cloud has no public address for webhooks yet.");
  bodyAt(call, []).url = hookUrl();
}

/**
 * An agent webhook's secret stays in the cloud (sealed, in bops.cloud_agents, for that agent and
 * user): the cloud checks each delivery with it. The Mac gets "kept-by-cloud" instead. A webhook
 * already pointing at the cloud has its secret kept when it's read too.
 */
async function keepWebhookSecret(call: Call, data: unknown) {
  if (!isObject(data) || typeof data.secret !== "string") return;
  if (data.secret && (call.method === "POST" || data.url === hookUrl()))
    await query(
      `INSERT INTO bops.cloud_agents (agent_id, user_id, secret_sealed) VALUES ($1, $2, $3)
       ON CONFLICT (agent_id) DO UPDATE SET user_id = EXCLUDED.user_id, secret_sealed = EXCLUDED.secret_sealed, updated_at = now()`,
      [call.params.agent, call.user.id, seal(data.secret)],
    );
  return { ...data, secret: "kept-by-cloud" };
}

/** What the Mac may see of a trunk (that one exists, its id to route a number to it). Never its credentials, which place calls on Orgo's account, or its addresses: where it sends calls is Orgo's OpenAI project. */
const TRUNK_FIELDS = new Set(["id", "name", "provider", "transport", "encrypted", "mediaEncryption", "createdAt"]);

function trunksOnly(_call: Call, data: unknown) {
  const visible = (t: unknown) => (isObject(t) ? Object.fromEntries(Object.entries(t).filter(([k]) => TRUNK_FIELDS.has(k))) : {});
  return { data: isObject(data) && Array.isArray(data.data) ? data.data.map(visible) : [] };
}

/** Exactly the AgentPhone routes the app uses (lib/server/phone.ts). Sub-accounts, registration, account webhooks, trunk changes and calls out are not among them. */
const agentphone: Spec = {
  name: "AgentPhone",
  key: config.agentphoneKey,
  upstream: config.upstream.agentphone,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  body: "json",
  check: inSubAccount,
  timeoutMs: 2 * 60_000,
  rules: [
    rule("GET v1/numbers", { json: recordNumbers }),
    // Buying a number needs credit for its month: an iMessage line's is far more than a number's.
    rule("POST v1/numbers", {
      spends: true,
      minCost: (call) => numberCost(numberAsked(call)),
      json: async (call, data) => {
        await recordNumbers(call, data);
        await recordBought(call, data);
        const n = numbersIn(data)[0];
        const asked = numberAsked(call);
        counted(recordUsage(call.user.id, "agentphone.numbers", 1, { numberId: n?.id, type: n?.type ?? asked.type, ...(asked.imessageType ? { imessageType: asked.imessageType } : {}) }));
      },
    }),
    rule("GET v1/numbers/:number", { json: recordNumbers }),
    rule("GET v1/numbers/:number/messages"),
    rule("PUT v1/numbers/:number/contact-card"),
    rule("DELETE v1/numbers/:number/contact-card"),
    // Where a number's calls go: its agent (voice turns to the agent's webhook, what Bops uses), a SIP trunk, or nowhere.
    rule("PATCH v1/numbers/:number/voice-routing"),
    rule("GET v1/agents", { json: recordNumbers }),
    rule("POST v1/agents", { json: recordNumbers }),
    rule("PATCH v1/agents/:agent", { json: recordNumbers }),
    rule("POST v1/agents/:agent/numbers", {
      json: async (call, data) => {
        await recordNumbers(call, data);
        await recordAttached(call);
      },
    }),
    rule("DELETE v1/agents/:agent/numbers/:number"),
    rule("GET v1/agents/:agent/webhook", { json: keepWebhookSecret }),
    rule("POST v1/agents/:agent/webhook", { check: webhookToCloud, json: keepWebhookSecret }),
    rule("POST v1/messages", { spends: true, done: countText }),
    rule("POST v1/messages/:message/reactions"),
    rule("POST v1/conversations/:conversation/typing"),
    rule("GET v1/register/status"),
    rule("GET v1/sip-trunks", { json: trunksOnly }),
  ],
};

/* ---------------- Honcho ---------------- */

const notYours = (call: Call) =>
  new HttpError(403, `Honcho workspaces through Bops Cloud are named ${honchoPrefix(call.user.id)}-… (yours only).`);

/** Any workspace a Honcho body or query names must be the user's too (the path's is checked by its rule). */
function honchoScope(call: Call) {
  const named = [...queryValues(call.query), ...keysIn(call.json)].filter((x) => x.key === "workspaceid" || x.key === "workspaceids").flatMap((x) => idsIn(x.value));
  if (named.some((w) => !ownsWorkspace(call.user.id, w))) throw notYours(call);
}

function workspaceInPath(call: Call) {
  if (!ownsWorkspace(call.user.id, call.params.workspace)) throw notYours(call);
}

/** Only the user's workspaces, whatever else is in the project: the list is filtered after Honcho answers. */
function ownWorkspacesOnly(call: Call, data: unknown) {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : [];
  const mine = items.filter((w) => isObject(w) && typeof w.id === "string" && ownsWorkspace(call.user.id, w.id));
  return { items: mine, total: mine.length, page: 1, size: mine.length, pages: 1 };
}

/** Honcho: the user's own workspaces, and anything inside them. */
const honcho: Spec = {
  name: "Honcho",
  key: config.honchoKey,
  upstream: config.upstream.honcho,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  body: "json-or-upload",
  check: honchoScope,
  timeoutMs: 5 * 60_000,
  rules: [
    // Get-or-create: the workspace is named in the body.
    rule("POST v3/workspaces", {
      check: (call) => {
        const id = isObject(call.json) ? call.json.id : undefined;
        if (typeof id !== "string" || !ownsWorkspace(call.user.id, id)) throw notYours(call);
      },
    }),
    rule("POST v3/workspaces/list", { json: ownWorkspacesOnly }),
    rule("* v3/workspaces/:workspace", { check: workspaceInPath }),
    rule("* v3/workspaces/:workspace/*", { check: workspaceInPath }),
  ],
};

/* ---------------- Composio ---------------- */

const USER_KEYS = new Set(["userid", "userids", "entityid", "entityids", "entity"]);
const ACCOUNT_KEYS = new Set(["connectedaccountid", "connectedaccountids", "connectedaccounts", "connectedaccount", "connectedauthid"]);
/**
 * Never from a Mac: accounts shared across users, saved session configs, someone's own credentials
 * or auth proxy in place of a connected account, and a trigger's events sent somewhere else.
 */
const COMPOSIO_REFUSED = new Set(["aclconfigforshared", "sessionconfigid", "customauthparams", "customconnectiondata", "proxyconfig", "sharedcredentials", "sealedcredentials", "egressurl"]);

/**
 * Every Composio call acts as the user's own Composio user (bops-<userId>): each user id the call
 * names must be theirs, each connected account it names must be one the cloud saw made for them,
 * and what COMPOSIO_REFUSED names is refused. Tool arguments and a proxied call's body are the
 * user's own business (a Slack tool's user_id is a Slack user) and aren't read.
 */
async function composioScope(call: Call) {
  const me = composioUserId(call.user.id);
  for (const { key, value } of [...queryValues(call.query), ...keysIn(call.json)]) {
    if (USER_KEYS.has(key) && idsIn(value).some((id) => id !== me)) throw new HttpError(403, "Composio calls through Bops Cloud act as you only.");
    if (ACCOUNT_KEYS.has(key)) for (const id of idsIn(value)) await mustOwn("composio", call, id);
    if (COMPOSIO_REFUSED.has(key) || (key === "accounttype" && idsIn(value).some((t) => t !== "PRIVATE")))
      throw new HttpError(403, "Bops Cloud doesn't pass shared accounts, saved configs, other credentials or other event addresses on to Composio.");
  }
}

/** The call must name one of the user's connected accounts (checked as theirs by composioScope): never left for Composio to pick. */
function namesAccount(call: Call) {
  const named = [...queryValues(call.query), ...keysIn(call.json)].some((x) => ACCOUNT_KEYS.has(x.key) && idsIn(x.value).length > 0);
  if (!named) throw new HttpError(400, "Name one of your connected accounts.");
}

/** Auth schemes where each person signs in with their own key or password, never through an OAuth app. */
const OWN_KEY_SCHEME = /^(?!.*OAUTH)[A-Z][A-Z0-9_]{1,40}$/;

/** One of Composio's own answers, asked with the cloud's key (not a Mac's request): null when Composio says there's no such thing. */
async function askComposio(path: string): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(`${config.upstream.composio().replace(/\/+$/, "")}${path}`, {
      headers: { "x-api-key": config.composioKey(), accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach Composio.");
  }
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `Composio answered ${res.status}.`);
  const answer = (await res.json().catch(() => null)) as unknown;
  return isObject(answer) ? answer : null;
}

/** Whether Composio signs people in to an app with its own OAuth app (the toolkit's managed auth schemes). */
async function composioSignsIn(toolkit: string): Promise<boolean> {
  const tk = await askComposio(`/api/v3.1/toolkits/${encodeURIComponent(toolkit)}`);
  if (!tk) throw new HttpError(404, "Composio doesn't know that app.");
  return Array.isArray(tk.composio_managed_auth_schemes) && tk.composio_managed_auth_schemes.length > 0;
}

/**
 * Setting up sign-in for an app, made from the toolkit and a name and nothing else: Composio's own
 * (no credentials of anyone's), or, for an app Composio has no sign-in of its own for, one that asks
 * each person for their own key (a non-OAuth scheme, no credentials of its own). Auth configs serve
 * the whole project, so one made with someone's own OAuth app, credentials or proxy could catch or
 * break other users' sign-ins; and one asking for a key where Composio has its own sign-in would be
 * picked over it for everyone (lib/server/composio.ts authConfigFor prefers a project's own).
 */
async function signInSetupWithoutSecrets(call: Call) {
  const body = isObject(call.json) ? call.json : {};
  const toolkit = isObject(body.toolkit) ? body.toolkit : {};
  const setup = isObject(body.auth_config) ? body.auth_config : {};
  const fields = Object.keys(setup);
  const named = setup.name === undefined || typeof setup.name === "string";
  const name = typeof setup.name === "string" ? { name: setup.name.slice(0, 80) } : {};
  const scheme = setup.authScheme ?? setup.auth_scheme;
  if (typeof toolkit.slug === "string" && SEGMENT.test(toolkit.slug) && named) {
    if (setup.type === "use_composio_managed_auth" && fields.every((k) => k === "type" || k === "name")) {
      call.json = { toolkit: { slug: toolkit.slug }, auth_config: { type: "use_composio_managed_auth", ...name } };
      return;
    }
    const ownKeys =
      setup.type === "use_custom_auth" &&
      fields.every((k) => ["type", "name", "authScheme", "auth_scheme", "credentials"].includes(k)) &&
      typeof scheme === "string" &&
      OWN_KEY_SCHEME.test(scheme) &&
      isObject(setup.credentials) &&
      Object.keys(setup.credentials).length === 0;
    if (ownKeys) {
      if (await composioSignsIn(toolkit.slug)) throw new HttpError(403, "Composio has its own sign-in for this app: Bops uses that one.");
      // Sent the way @composio/core sends it (authScheme), the only spelling Composio is given.
      call.json = { toolkit: { slug: toolkit.slug }, auth_config: { type: "use_custom_auth", authScheme: scheme, credentials: {}, ...name } };
      return;
    }
  }
  throw new HttpError(403, "From Bops, an app's sign-in can only be Composio's own, or one that asks each person for their own key. Ask Orgo to set up this app.");
}

/** A sign-in setup made through the cloud: any user may see and use it, as it holds nobody's secret. */
async function recordSignInSetup(call: Call, data: unknown) {
  const id = isObject(data) && isObject(data.auth_config) ? data.auth_config.id : undefined;
  if (typeof id === "string") await own(call, "composio", "auth_config", id);
}

/** Of these auth config ids, the ones made through the cloud (bops.cloud_objects). */
async function madeThroughCloud(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await query<{ object_id: string }>("SELECT object_id FROM bops.cloud_objects WHERE provider = 'composio' AND kind = 'auth_config' AND object_id = ANY ($1::text[])", [ids]);
  return new Set(r.rows.map((row) => row.object_id));
}

/** Auth configs Composio has said it manages (that never changes for a config), so it's asked once. */
const managedSeen = new Set<string>();

/** Whether Composio manages this auth config's sign-in (its own OAuth apps), asked with the cloud's key. */
async function composioManaged(id: string): Promise<boolean> {
  if (managedSeen.has(id)) return true;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return false;
  const setup = await askComposio(`/api/v3.1/auth_configs/${encodeURIComponent(id)}`);
  if (setup?.is_composio_managed !== true) return false;
  if (managedSeen.size < 10_000) managedSeen.add(id);
  return true;
}

const AUTH_CONFIG_KEYS = new Set(["authconfigid", "authconfigids", "authconfig", "authconfigs"]);

/**
 * Every sign-in setup a call names (to connect an account, or for a session to connect one with)
 * must be one a Mac may use: Composio's own, made through the cloud, or pinned by Orgo
 * (BOPS_COMPOSIO_AUTH_CONFIGS). The same ones GET auth_configs lists.
 */
const usableSignIns = (required: boolean) => async (call: Call) => {
  const named = [...new Set(keysIn(call.json).filter((x) => AUTH_CONFIG_KEYS.has(x.key)).flatMap((x) => idsIn(x.value)))];
  if (required && !named.length) throw new HttpError(400, "Name the app's sign-in setup (auth_config_id).");
  const pinned = new Set(config.composioAuthConfigs());
  const made = await madeThroughCloud(named);
  for (const id of named)
    if (!pinned.has(id) && !made.has(id) && !(await composioManaged(id))) throw new HttpError(403, "That sign-in setup can't be used from Bops. Pick the app again.");
};

/** What a Mac may see of an auth config: which it is and how it signs in. Never its credentials, auth proxy or shared credentials (Orgo's own OAuth apps' secrets). */
const AUTH_CONFIG_FIELDS = new Set(["id", "uuid", "type", "name", "toolkit", "auth_scheme", "is_composio_managed", "status", "created_at", "last_updated_at", "no_of_connections", "expected_input_fields", "restrict_to_following_tools", "tool_access_config", "is_enabled_for_tool_router"]);

/**
 * The project's sign-in setups, only the ones a Mac may use (Composio's own, made through the cloud,
 * or pinned in BOPS_COMPOSIO_AUTH_CONFIGS): any other, made in Composio's dashboard for something
 * else, isn't offered. Each without its credentials.
 */
async function usableAuthConfigsOnly(_call: Call, data: unknown) {
  const items = (isObject(data) && Array.isArray(data.items) ? data.items : []).filter(isObject);
  const pinned = new Set(config.composioAuthConfigs());
  const made = await madeThroughCloud(items.map((a) => a.id).filter((id): id is string => typeof id === "string"));
  const usable = items.filter((a) => typeof a.id === "string" && (a.is_composio_managed === true || pinned.has(a.id) || made.has(a.id)));
  return { ...(isObject(data) ? data : {}), items: usable.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => AUTH_CONFIG_FIELDS.has(k)))) };
}

/**
 * An account's own secrets in Composio's answers (OAuth access, refresh and ID tokens, secrets,
 * passwords, and anything named a key or a key's id: API, access, secret, consumer and service
 * account keys), by key in any spelling. The Mac never needs them (Composio uses them for it), so
 * they aren't handed to it. An app's own name for the account isn't one, so Bops can still show it
 * (and where only an ID token said who it is, Bops asks the app instead).
 */
const SECRET_KEY = /(token|secret|password|passphrase|key|keyid|codeverifier|credentials?|credentialsjson|cookie|authorization)$/;
const MASKED = "masked";

/** A connected-account answer with every secret value masked where it is. */
function masked(value: unknown, depth = 0): unknown {
  if (depth > 64) return MASKED;
  if (Array.isArray(value)) return value.map((v) => masked(v, depth + 1));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(norm(k)) && typeof v === "string" && v ? MASKED : masked(v, depth + 1)]));
}

/** Name the user as the call's Composio user, where the SDK leaves it out (at `path` in the body). */
const asUser = (path: string[]) => (call: Call) => {
  bodyAt(call, path).user_id = composioUserId(call.user.id);
};

/** The connected account an answer made is the user's; the Mac gets the answer with its secrets masked. */
const recordAccount = (field: string) => async (call: Call, data: unknown) => {
  const id = isObject(data) ? data[field] : undefined;
  if (typeof id === "string") await own(call, "composio", "connected_account", id);
  return masked(data);
};

/** These checks, one after the other. */
const both =
  (...checks: ((call: Call) => Promise<void> | void)[]) =>
  async (call: Call) => {
    for (const c of checks) await c(call);
  };

/**
 * Exactly the routes @composio/core uses for what lib/server/composio.ts and channels.ts call: the
 * catalog, sign-in setup, connected accounts (several per app), sessions with search and execute,
 * direct execute and proxy (an app's "who am I", Slack's API), tool info, and Slack triggers (not
 * their live delivery: Bops' Slack app's events come through /hooks/slack instead).
 */
const composio: Spec = {
  name: "Composio",
  key: config.composioKey,
  upstream: config.upstream.composio,
  auth: (key) => ({ "x-api-key": key }),
  body: "json",
  check: composioScope,
  timeoutMs: 5 * 60_000,
  rules: [
    rule("GET api/v3.1/toolkits"),
    rule("GET api/v3.1/toolkits/:toolkit"),
    rule("GET api/v3.1/tools/:tool"),
    rule("GET api/v3.1/auth_configs", { json: usableAuthConfigsOnly }),
    rule("POST api/v3.1/auth_configs", { check: signInSetupWithoutSecrets, json: recordSignInSetup }),
    rule("GET api/v3.1/connected_accounts", {
      check: (call) => {
        for (const k of [...call.query.keys()]) if (USER_KEYS.has(queryKey(k))) call.query.delete(k);
        call.query.set("user_ids", composioUserId(call.user.id));
      },
      json: async (call, data) => {
        const me = composioUserId(call.user.id);
        const items = isObject(data) && Array.isArray(data.items) ? data.items : [];
        const mine = items.filter((a) => isObject(a) && a.user_id === me && typeof a.id === "string") as { id: string }[];
        for (const a of mine) await own(call, "composio", "connected_account", a.id);
        return { ...(isObject(data) ? data : {}), items: mine.map((a) => masked(a)) };
      },
    }),
    // Connecting an account: only with a sign-in setup a Mac may use, and another account in the same app is fine.
    rule("POST api/v3.1/connected_accounts", { check: both(asUser(["connection"]), usableSignIns(true)), json: recordAccount("id") }),
    rule("POST api/v3.1/connected_accounts/link", { check: both(asUser([]), usableSignIns(true)), json: recordAccount("connected_account_id") }),
    rule("GET api/v3.1/connected_accounts/:account", { own: ["account"], json: (_call, data) => masked(data) }),
    rule("DELETE api/v3.1/connected_accounts/:account", { own: ["account"] }),
    rule("POST api/v3.1/tool_router/session", {
      check: both(asUser([]), usableSignIns(false)),
      json: async (call, data) => {
        const id = isObject(data) ? data.session_id : undefined;
        if (typeof id === "string") await own(call, "composio", "tool_router_session", id);
      },
    }),
    rule("GET api/v3.1/tool_router/session/:session", { own: ["session"] }),
    rule("POST api/v3.1/tool_router/session/:session/search", { own: ["session"] }),
    rule("POST api/v3.1/tool_router/session/:session/execute", {
      own: ["session"],
      // Which of the session's accounts to use: only one of the user's.
      check: async (call) => {
        const account = isObject(call.json) ? call.json.account : undefined;
        if (account !== undefined) await mustOwn("composio", call, typeof account === "string" ? account : "");
      },
    }),
    // An app's own API through the user's account (Slack's chat.postMessage and auth.test, an app's "who am I").
    rule("POST api/v3.1/tools/execute/proxy", { check: namesAccount }),
    // One action in one of the user's accounts, or in an app that needs no account.
    rule("POST api/v3.1/tools/execute/:tool", { check: asUser([]) }),
    // Triggers (Slack messages for channels.ts): only on the user's own accounts. Their live delivery
    // (triggers.subscribe, a Pusher channel for the whole project) isn't passed through at all.
    rule("GET api/v3.1/triggers_types/:trigger"),
    rule("GET api/v3.1/trigger_instances/active", {
      check: namesAccount,
      json: (call, data) => {
        const me = composioUserId(call.user.id);
        const items = isObject(data) && Array.isArray(data.items) ? data.items : [];
        return { ...(isObject(data) ? data : {}), items: items.filter((t) => isObject(t) && t.user_id === me) };
      },
    }),
    rule("POST api/v3.1/trigger_instances/:trigger/upsert", {
      check: (call) => {
        namesAccount(call);
        asUser([])(call);
      },
    }),
  ],
};

/* ---------------- Typesafe ---------------- */

const typesafe: Spec = {
  name: "Typesafe",
  key: config.typesafeKey,
  upstream: config.upstream.typesafe,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  body: "pipe",
  timeoutMs: 60_000,
  rules: [rule("POST v1/systemone", { spends: true, done: (call) => counted(recordUsage(call.user.id, "typesafe.calls", 1)) })],
};

const SPECS: Record<Provider, Spec> = { openai, agentphone, honcho, composio, typesafe };

/* ---------------- Sending on ---------------- */

/** Request headers a caller may send on: content negotiation, idempotency, SDK telemetry and OpenAI's beta flags. Never auth, account pickers, cookies or forwarding headers. */
const PASS_REQUEST = new Set([
  "accept", "accept-language", "content-type", "user-agent", "cache-control", "last-event-id", "idempotency-key",
  "openai-beta", "x-request-id", "x-client-request-id", "x-honcho-host", "x-sdk-version", "x-runtime", "x-source", "x-framework",
]);
/** Response headers that stop here: hop-by-hop ones, cookies, and which OpenAI organization and project answered. */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "transfer-encoding", "upgrade", "set-cookie", "openai-organization", "openai-project"]);

function requestHeaders(h: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(h)) if (value !== undefined && (PASS_REQUEST.has(name) || name.startsWith("x-stainless-"))) out[name] = value;
  return out;
}

function responseHeaders(h: IncomingHttpHeaders, drop: string[] = []): OutgoingHttpHeaders {
  const named = String(h.connection ?? "").toLowerCase().split(",").map((s) => s.trim());
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(h)) if (value !== undefined && !DROP_RESPONSE.has(name) && !named.includes(name) && !drop.includes(name)) out[name] = value;
  return out;
}

/** Passes a piped body on, refusing it (413) once it's past `max` bytes. */
const limiter = (max: number) => {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > max ? new HttpError(413, "Request too large") : null, chunk);
    },
  });
};

/** Send the call on and wait for the provider to start answering. The request is dropped if the Mac goes away first. */
function send(spec: Spec, key: string, call: Call, req: IncomingMessage, res: ServerResponse, body: Buffer | IncomingMessage | null): Promise<IncomingMessage> {
  const url = new URL(`${spec.upstream().replace(/\/+$/, "")}/${call.path.join("/")}${qs(call.query)}`);
  // identity: answers must be readable here, to record what they make.
  const headers: OutgoingHttpHeaders = { ...requestHeaders(req.headers), ...spec.auth(key), ...call.headers, "accept-encoding": "identity" };
  if (Buffer.isBuffer(body)) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  } else if (body && req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  return new Promise((resolve, reject) => {
    const up = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: call.method, headers });
    const timer = setTimeout(() => up.destroy(new HttpError(504, `${spec.name} took too long to answer.`)), spec.timeoutMs);
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    up.on("response", (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    up.on("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof HttpError ? e : new HttpError(502, `Couldn't reach ${spec.name}.`));
    });
    if (body && !Buffer.isBuffer(body)) pipeline(body, limiter(MAX_BODY), up).catch((e: Error) => up.destroy(e));
    else up.end(body ?? undefined);
  });
}

/** Write a chunk to the Mac, waiting while it catches up. False once the Mac has gone. */
function write(res: ServerResponse, chunk: Buffer): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (ok: boolean) => {
      res.off("drain", drained);
      res.off("close", closed);
      resolve(ok);
    };
    const drained = () => settle(true);
    const closed = () => settle(false);
    res.once("drain", drained);
    res.once("close", closed);
  });
}

async function readAll(up: IncomingMessage, max: number, name: string) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of up as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(502, `${name}'s answer was too large.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The longest event the cloud reads; past it the rest of the stream is passed on unread (nothing in it is recorded, so nothing in it can be used). */
const MAX_EVENT = 32 * 1024 * 1024;

/** Splits a server-sent event stream into whole events, as raw bytes (passed on unchanged) and the JSON of their data lines. */
class EventSplitter {
  private pending: Buffer = Buffer.alloc(0);
  private reading = true;

  push(chunk: Buffer): { raw: Buffer; data: unknown }[] {
    if (!this.reading) return [{ raw: chunk, data: undefined }];
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: { raw: Buffer; data: unknown }[] = [];
    for (let end = eventEnd(this.pending); end > 0; end = eventEnd(this.pending)) {
      out.push({ raw: this.pending.subarray(0, end), data: eventData(this.pending.subarray(0, end)) });
      this.pending = this.pending.subarray(end);
    }
    if (this.pending.length > MAX_EVENT) {
      out.push({ raw: this.pending, data: undefined });
      this.pending = Buffer.alloc(0);
      this.reading = false;
    }
    return out;
  }

  rest() {
    return this.pending;
  }
}

/** Where the first event in `buf` ends (after its blank line), or -1. */
function eventEnd(buf: Buffer) {
  const ends = (
    [
      ["\n\n", 2],
      ["\r\n\r\n", 4],
      ["\r\r", 2],
    ] as const
  )
    .map(([sep, len]) => {
      const i = buf.indexOf(sep);
      return i < 0 ? -1 : i + len;
    })
    .filter((i) => i > 0);
  return ends.length ? Math.min(...ends) : -1;
}

function eventData(raw: Buffer): unknown {
  const lines = raw
    .toString("utf8")
    .split(/\r\n|\r|\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (!lines.length) return undefined;
  try {
    return JSON.parse(lines.join("\n"));
  } catch {
    return undefined;
  }
}

/** Stream events on as they come, each after the rule has seen it. */
async function streamEvents(rule: Rule, call: Call, up: IncomingMessage, res: ServerResponse, readable: boolean) {
  res.writeHead(up.statusCode ?? 200, responseHeaders(up.headers));
  res.flushHeaders();
  const split = readable ? new EventSplitter() : null;
  try {
    for await (const chunk of up as AsyncIterable<Buffer>) {
      for (const part of split ? split.push(chunk) : [{ raw: chunk, data: undefined }]) {
        if (part.data !== undefined) await Promise.resolve(rule.event!(call, part.data)).catch((e: Error) => console.warn(`[proxy] event: ${e.message}`));
        if (!(await write(res, part.raw))) return void up.destroy();
      }
    }
    const rest = split?.rest();
    if (rest?.length) await write(res, rest);
    res.end();
    await rule.done?.(call);
  } catch {
    res.destroy();
  }
}

/** Read a JSON answer whole, let the rule record from it (or rewrite it), then send it. */
async function answerJson(spec: Spec, rule: Rule, call: Call, up: IncomingMessage, res: ServerResponse, readable: boolean) {
  const raw = await readAll(up, MAX_BODY, spec.name);
  let out = raw;
  if (raw.length) {
    let data: unknown;
    try {
      if (!readable) throw new Error("encoded");
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(502, `${spec.name} answered in a form the cloud can't read.`);
    }
    const changed = await rule.json!(call, data);
    if (changed !== undefined) out = Buffer.from(JSON.stringify(changed));
  }
  res.writeHead(up.statusCode ?? 200, { ...responseHeaders(up.headers, ["content-length"]), "content-length": String(out.length) });
  res.end(out);
  await rule.done?.(call);
}

async function answer(spec: Spec, rule: Rule, call: Call, up: IncomingMessage, res: ServerResponse) {
  const status = up.statusCode ?? 502;
  const ok = status >= 200 && status < 300;
  const encoding = String(up.headers["content-encoding"] ?? "identity").toLowerCase();
  const readable = encoding === "identity";
  if (ok && rule.event && /^text\/event-stream/i.test(String(up.headers["content-type"] ?? ""))) return streamEvents(rule, call, up, res, readable);
  if (ok && rule.json) return answerJson(spec, rule, call, up, res, readable);
  res.writeHead(status, responseHeaders(up.headers));
  try {
    await pipeline(up, res);
  } catch {
    return void res.destroy();
  }
  if (ok) await rule.done?.(call);
}

async function handle(provider: Provider, prefix: string, req: IncomingMessage, res: ServerResponse, user: CloudUser) {
  const spec = SPECS[provider];
  const key = spec.key();
  if (!key) throw new HttpError(503, `${spec.name} isn't set up on this cloud.`);
  const { path, query: q } = target(req.url, prefix);
  const call: Call = { user, method: req.method ?? "GET", path, params: {}, query: q, headers: {}, owned: new Set() };
  const r = match(spec, call);
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw new HttpError(413, "Request too large");
  let body: IncomingMessage | null = null;
  if (hasBody(req)) {
    if (spec.body === "json" || (spec.body === "json-or-upload" && !isUpload(req))) call.json = parseBody(await readBody(req, MAX_BODY));
    else body = req;
  }
  await spec.check?.(call);
  for (const name of r.own ?? []) await mustOwn(provider, call, call.params[name]);
  await r.check?.(call);
  // Last before it's sent: a call that isn't allowed is refused for that, not for the credit.
  if (r.spends) await requireCredit(user.id, r.minCost?.(call));
  const up = await send(spec, key, call, req, res, call.json === undefined ? body : Buffer.from(JSON.stringify(call.json)));
  await answer(spec, r, call, up, res);
}

/* ---------------- The live call sideband (WebSocket) ---------------- */

/**
 * The app's SidebandWS (openai/resources/live/sideband/ws) makes its address from the client's
 * baseURL: <cloud>/proxy/openai/v1 → wss://<cloud>/proxy/openai/v1/live/sessions/<id>/attach. The
 * session must be the user's (recorded when the app made it, or by /hooks/openai when the call came
 * in). The cloud connects to OpenAI first, with its own key, and only then accepts the Mac's upgrade,
 * so a refusal reaches the Mac as an HTTP status.
 */
const sidebands = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

/** Close codes that may be sent on (ws refuses the reserved ones). */
const sendable = (code: number) => ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1000);

/** How long OpenAI says the call has run, from a session.usage.updated event. */
function liveSeconds(data: RawData): number {
  const text = data.toString();
  if (!text.includes("session.usage.updated")) return 0;
  try {
    return Number((JSON.parse(text) as { usage?: { seconds?: unknown } }).usage?.seconds) || 0;
  } catch {
    return 0;
  }
}

type Upstream = { ws: WebSocket; early: [RawData, boolean][]; keep: (data: RawData, binary: boolean) => void };

/** Connect to OpenAI's sideband. What it says before the Mac's side is ready (it speaks first) is kept for the bridge. */
function connectUpstream(url: string, key: string, req: IncomingMessage): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const pass = Object.fromEntries((["user-agent", "openai-beta"] as const).flatMap((h) => (typeof req.headers[h] === "string" ? [[h, req.headers[h] as string]] : [])));
    const ws = new WebSocket(url, { headers: { ...pass, authorization: `Bearer ${key}` }, followRedirects: false, maxPayload: MAX_BODY, handshakeTimeout: 15_000 });
    const early: [RawData, boolean][] = [];
    const keep = (data: RawData, binary: boolean) => void early.push([data, binary]);
    ws.on("message", keep);
    ws.once("open", () => resolve({ ws, early, keep }));
    ws.once("unexpected-response", (request, response) => {
      request.destroy();
      reject(new HttpError(response.statusCode === 404 ? 404 : 502, "OpenAI refused the sideband"));
    });
    // Kept on (not once): an error after the open, before the bridge takes over, mustn't go unhandled.
    ws.on("error", () => reject(new HttpError(502, "Couldn't reach OpenAI")));
  });
}

/** Messages both ways as they are (text or binary); a close on one side closes the other. The call's seconds are counted at the end. */
function bridge(client: WebSocket, { ws: upstream, early, keep }: Upstream, userId: string, sessionId: string) {
  let seconds = 0;
  const toClient = (data: RawData, binary: boolean) => {
    if (!binary) seconds = Math.max(seconds, liveSeconds(data));
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
  };
  upstream.off("message", keep);
  for (const [data, binary] of early.splice(0)) toClient(data, binary);
  upstream.on("message", toClient);
  client.on("message", (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
  });
  if (upstream.readyState !== WebSocket.OPEN) client.close(1011);
  const closeOther = (other: WebSocket) => (code: number, reason: Buffer) => {
    if (other.readyState === WebSocket.OPEN) other.close(sendable(code), reason);
  };
  client.on("close", closeOther(upstream));
  upstream.on("close", (code, reason) => {
    closeOther(client)(code, reason);
    if (seconds) counted(recordUsageFor(userId, "openai.live_seconds", sessionId, seconds));
  });
  client.on("error", () => upstream.terminate());
  upstream.on("error", () => client.terminate());
}

async function attach(req: IncomingMessage, socket: Duplex, head: Buffer, user: CloudUser) {
  const key = config.openaiKey();
  if (!key) throw new HttpError(503, "OpenAI isn't set up on this cloud.");
  const { path, query: q } = target(req.url, "/proxy/openai");
  const params = matchPath(["v1", "live", "sessions", ":live", "attach"], path);
  if (!params) throw new HttpError(404, "Not found");
  if ((await objectOwner("openai", params.live)) !== user.id) throw new HttpError(404, "Not found");
  await openaiRefs({ user, method: "GET", path, params, query: q, headers: {}, owned: new Set() });
  const upstream = await connectUpstream(`${config.upstream.openai().replace(/\/+$/, "").replace(/^http/, "ws")}/${path.join("/")}${qs(q)}`, key, req);
  if (socket.destroyed) return upstream.ws.terminate();
  sidebands.handleUpgrade(req, socket, head, (client) => bridge(client, upstream, user.id, params.live));
}

/* ---------------- Routes ---------------- */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const proxyRoutes = (provider: Provider, prefix: string, path = `${prefix}/*`): Route[] =>
  METHODS.map((method) => ({ method, path, auth: "user", handle: (req, res, { user }) => handle(provider, prefix, req, res, user!) }));

export const routes: Route[] = [
  ...(Object.keys(SPECS) as Provider[]).flatMap((p) => proxyRoutes(p, `/proxy/${p}`)),
  // The Honcho SDK drops any path in its baseURL (its paths start with "/v3/"), so the app's unchanged SDK reaches /v3/… at the cloud's root.
  ...proxyRoutes("honcho", "", "/v3/*"),
];

export const upgrades: Upgrade[] = [
  {
    path: "/proxy/openai/*",
    handle: (req, socket, head, { user }) => {
      // Node takes its own error handler off an upgrading socket: without one, a Mac dropping off mid-handshake would crash the process.
      socket.on("error", () => socket.destroy());
      attach(req, socket, head, user).catch((e: Error) => {
        const status = e instanceof HttpError ? e.status : 502;
        if (!(e instanceof HttpError)) console.warn(`[proxy] sideband: ${e.message}`);
        if (!socket.destroyed) refuseUpgrade(socket, status, STATUS_CODES[status] ?? "Error");
      });
    },
  },
];
