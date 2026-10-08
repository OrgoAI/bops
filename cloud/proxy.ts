import { trackCloudEvent } from "./analytics.ts";
import { request as httpRequest, STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { bearer, type CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { creditLeft, creditsOn, outOfCredit, requireCredit } from "./credit.ts";
import { seal } from "./crypto.ts";
import { objectInfo, objectOwner, ownObject, query, sessionUsed } from "./db.ts";
import { HttpError, readBody, refuseUpgrade, type Route, type Upgrade } from "./http.ts";
import { recordLine } from "./lines.ts";
import { refuseSecondPlanNumber, requireRoomForNumber, sendingStopped } from "./plans.ts";
import { imageModelPriced, numberCost, smsSegments } from "./pricing.ts";
import { PLAN_REQUIRED, USAGE_APP_HEADER, USAGE_BOT_HEADER, USAGE_SOURCE_HEADER } from "./protocol.ts";
import { accountFor, composioUserId, honchoPrefix, ownsWorkspace } from "./session.ts";
import { admitTurn, follow, userStopped, verdict, watchSession, type Start } from "./turn-guard.ts";
import { isWebSearch, liveSecondsOf, recordImages, recordJev, recordTokens, recordTranscription, recordTreg, recordUsage, recordUsageFor, recordWebSearch } from "./usage.ts";

/**
 * /proxy/<provider>/*: the Mac's calls to OpenAI, AgentPhone, Honcho, Composio, Typesafe and treg, sent on
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
 * - Routes that spend (a model's answer, a call, a number, a text, a Typesafe call, a message to a
 *   task) are refused with 402 once the user's AI credit is used up (credit.ts), before anything is
 *   sent on. Reads, hanging up, turning a call away and cancelling a task never are. A task's turns
 *   are held to the credit while they run, and stopped when it's used up (turn-guard.ts); an in-app
 *   call is hung up when it is.
 * - What each call used is recorded once (usage.ts): tokens by response or turn, web searches by
 *   item, Jev's tokens, Composio's and Honcho's calls. The Mac says which bot and what kind of work a
 *   call is for (x-bops-bot, x-bops-source: read here, never sent on), and an agent session keeps the
 *   bot it was made for.
 */

const MAX_BODY = 25 * 1024 * 1024;

type Provider = "openai" | "agentphone" | "honcho" | "composio" | "typesafe" | "treg";

/** A call on its way through: who's asking and where to, and what the rules may check or change before it goes. */
type Call = {
  user: CloudUser;
  /** The caller's Orgo key, only to ask orgo-web about their plan (plans.ts); never sent on to a provider. */
  orgoKey: string;
  method: string;
  /** The path after /proxy/<provider>, split on "/". */
  path: string[];
  /** The path segments the matching rule named (":session" → its value). */
  params: Record<string, string>;
  query: URLSearchParams;
  /** The parsed JSON body, when the provider's bodies are read (undefined: none). */
  json?: unknown;
  /** A file upload on a route that takes one (Rule.upload): read whole, sent on as it came, and its fields as parsed. */
  upload?: { body: Buffer; fields: FormData };
  /** Added to the request sent on (AgentPhone's X-Sub-Account-Id). */
  headers: Record<string, string>;
  /** Objects already recorded as this user's during this call (a stream names the same turn many times). */
  owned: Set<string>;
  /** The Agents API session a stream belongs to, once known. */
  session?: string;
  /** That session's model, once looked up (null: the cloud never saw it), to price its turns. */
  model?: string | null;
  /** That session's bot, once looked up. */
  sessionBot?: string | null;
  /** A turn this call starts, let through by turn-guard.ts admitTurn: given back if the call fails. */
  start?: Start;
  /** Given back once the call is over and what it cost is recorded (a treg call's hold on the credit: tregCall). */
  release?: () => void;
  /** What the call's cost is being recorded by, waited for before `release`. */
  recording?: Promise<unknown>;
  /** The bot the Mac says this call is for (x-bops-bot), what kind of work (x-bops-source), and the app (x-bops-app, Composio), for counting it. */
  bot?: string;
  source?: string;
  app?: string;
  /** The Mac's own request headers, for a rule that reads one it doesn't send on (treg's x-treg-route-max-cost). */
  asked: IncomingHttpHeaders;
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
  /** Each event of a 2xx event stream, before it's passed on: return the event the Mac gets instead (undefined: as it came). */
  event?: Hook<unknown>;
  /** After any 2xx answer has been sent. */
  done?: (call: Call) => Promise<unknown> | unknown;
  /** Right before it's sent on, past every check and the credit: what must happen even when the Mac goes away before the answer. */
  before?: (call: Call) => Promise<unknown> | unknown;
  /** A 2xx event stream the Mac follows: called as it starts; what it returns is called once the Mac stops following it. */
  follow?: (call: Call) => () => void;
  /** It spends AI credit: refused (402) when the user has none left, or less than `minCost` (micro-dollars). An agent turn is let through by turn-guard.ts admitTurn instead. */
  spends?: true;
  minCost?: (call: Call) => number | Promise<number>;
  /** A refused answer (its status and body): change the request and return true to send it again (at most 12 times). */
  retry?: (call: Call, status: number, body: string) => boolean;
  /**
   * The provider bills it whether the Mac waits or not (a model's answer, a Jev call): when the Mac
   * goes away first, the answer is still read to the end and recorded, just not sent anywhere.
   */
  readToEnd?: true;
  /** It takes a file upload (multipart): read whole (MAX_BODY at most), so its fields can be checked (Call.upload), and sent on as it came. */
  upload?: true;
  /** Any answer, 2xx or not, as it starts: what its headers say (treg's cost and call id). */
  headers?: (call: Call, status: number, headers: IncomingHttpHeaders) => void;
  /** A refusal (status 400 or more), read whole: what the Mac gets instead ({status, body}), or undefined to pass it on as it came. */
  refused?: (call: Call, status: number, headers: IncomingHttpHeaders, body: Buffer) => { status: number; body: Record<string, unknown> } | undefined;
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

/** A file upload, read whole, with its fields parsed (a body that isn't one is refused, 400). */
async function readUpload(req: IncomingMessage): Promise<NonNullable<Call["upload"]>> {
  const body = await readBody(req, MAX_BODY);
  try {
    return { body, fields: await new Response(body, { headers: { "content-type": String(req.headers["content-type"]) } }).formData() };
  } catch {
    throw new HttpError(400, "That file upload can't be read.");
  }
}

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

/** Record an object as this user's (once per call), with the model it runs on and the bot it's for when those are known. */
async function own(call: Call, provider: Provider, kind: string, id: string, model?: string, botId?: string) {
  if (call.owned.has(id)) return;
  call.owned.add(id);
  await ownObject(call.user.id, provider, kind, id, model, botId);
}

/** Usage is counted on the side: a failure to count never fails the call. */
const counted = (p: Promise<unknown>) => void p.catch((e: Error) => console.warn(`[proxy] usage: ${e.message}`));

/** A file upload's one text field `name` (undefined: not there). Sent twice, it's refused: the provider might read the other. */
function formField(call: Call, name: string): string | undefined {
  const all = call.upload?.fields.getAll(name) ?? [];
  if (all.length > 1) throw new HttpError(400, `${name} is given more than once.`);
  if (all[0] !== undefined && typeof all[0] !== "string") throw new HttpError(400, `${name} should be text.`);
  return all[0];
}

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

/**
 * The tools a Responses call may have: the app's own (its functions, the computer, web search, which the
 * cloud counts: recordResponse). Hosted tools priced on their own (image generation, code interpreter, file
 * search) or that reach elsewhere (remote MCP servers) aren't passed through: the cloud couldn't count them.
 */
const RESPONSES_TOOLS = new Set(["function", "computer", "web_search", "web_search_preview"]);
function responsesTools(call: Call) {
  const tools = isObject(call.json) && Array.isArray(call.json.tools) ? call.json.tools : [];
  for (const t of tools) {
    const type = isObject(t) ? t.type : undefined;
    if (typeof type !== "string" || !RESPONSES_TOOLS.has(type)) throw new HttpError(403, `Bops Cloud doesn't pass ${typeof type === "string" ? `the ${type} tool` : "that tool"} through.`);
  }
}

/** The sizes and qualities the app asks for (lib/server/images.ts), one picture at a time: an answer stays small enough to read whole, and count. */
const IMAGE_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024"]);
const IMAGE_QUALITIES = new Set(["low", "medium", "high"]);
function imageAsk(n: unknown, size: unknown, quality: unknown) {
  if (n !== undefined && Number(n) !== 1) throw new HttpError(400, "Bops Cloud makes one image at a time.");
  if (!IMAGE_SIZES.has(String(size))) throw new HttpError(400, "Bops Cloud makes images at 1024x1024, 1024x1536 or 1536x1024.");
  if (!IMAGE_QUALITIES.has(String(quality))) throw new HttpError(400, "Bops Cloud makes images at low, medium or high quality.");
}

type ResponseObject = { id?: unknown; object?: unknown; model?: unknown; usage?: unknown; output?: unknown };

/**
 * A response (JSON, or the `response` of a streamed event): its id is the user's, and its tokens are
 * counted when it's done, and so are its web searches (a task on the computer tool searches in Responses).
 */
async function recordResponse(call: Call, r: ResponseObject | undefined, done: boolean) {
  if (r?.object !== "response" || typeof r.id !== "string") return;
  await own(call, "openai", "response", r.id);
  if (!done) return;
  counted(recordTokens(call.user.id, r.id, r.usage, { model: r.model, source: call.source ?? "responses", botId: call.bot }));
  for (const item of Array.isArray(r.output) ? r.output : []) if (isWebSearch(item)) counted(recordWebSearch(call.user.id, item, call.bot));
}

type AgentEvent = {
  type?: string;
  session_id?: unknown;
  session?: { id?: unknown; object?: unknown };
  turn_id?: unknown;
  turn?: { id?: unknown; subagent_id?: unknown; usage?: unknown };
  subagent?: { id?: unknown };
  item?: unknown;
  usage?: unknown;
};

/** The model a new Agents API session is asked for (agent.model in the body that makes it; any other call's body says nothing about it). */
function modelAsked(call: Call): string | undefined {
  if (call.method !== "POST" || call.path.join("/") !== "v1/agents/sessions") return undefined;
  const agent = isObject(call.json) ? call.json.agent : undefined;
  return isObject(agent) && typeof agent.model === "string" ? agent.model : undefined;
}

/**
 * The model and bot of the session a turn is in, as recorded when the session was made (a model never
 * seen is priced at the dearest; a bot never said isn't anyone's).
 */
async function turnInfo(call: Call, session: string | undefined): Promise<{ model?: string; botId?: string }> {
  if (call.model === undefined || call.sessionBot === undefined) {
    const kept = session ? await objectInfo("openai", session) : { model: null, botId: null };
    call.model = modelAsked(call) ?? kept.model;
    call.sessionBot = kept.botId ?? (modelAsked(call) ? (call.bot ?? null) : null);
  }
  return { model: call.model ?? undefined, botId: call.sessionBot ?? undefined };
}

/** A finished agent turn's tokens, at its session's model, for its session's bot. */
const turnTokens = (call: Call, session: string | undefined, turn: string, usage: unknown) =>
  counted(turnInfo(call, session).then(({ model, botId }) => recordTokens(call.user.id, turn, usage, { model, source: "agent", botId })));

/** A web search the agent ran (a web_search_call item, seen in a session's stream or a list of its items), for the session's bot (usage.ts recordWebSearch). */
async function countWebSearch(call: Call, session: string | undefined, item: unknown) {
  if (!isWebSearch(item)) return;
  const { botId } = await turnInfo(call, session);
  counted(recordWebSearch(call.user.id, item, botId));
}

/** Every web search in a list of a session's items (or a helper's). */
async function webSearchesIn(call: Call, data: unknown) {
  const list = isObject(data) && Array.isArray(data.data) ? data.data : [];
  for (const item of list) await countWebSearch(call, call.params.session, item);
}

/**
 * An Agents API session event (its own stream, or a session made with stream: true): the session,
 * its turns and its helpers (subagents) become the user's as they're named, and a finished turn's
 * tokens are counted. Only events of the stream's own session count. A turn the cloud stopped for
 * want of AI credit (turn-guard.ts) reaches the Mac as failed, with why, so the app says so; one it
 * stopped only to see what it had spent, and set going again, passes as it came.
 */
async function agentEvent(call: Call, data: unknown): Promise<unknown> {
  const e = data as AgentEvent;
  if (e.type === "agent.session.created" && e.session?.object === "agent.session" && typeof e.session.id === "string") {
    call.session ??= e.session.id;
    await own(call, "openai", "agent_session", e.session.id, modelAsked(call), call.bot);
    watchSession(call.user.id, e.session.id, modelAsked(call), call.bot);
    call.start?.session(e.session.id);
  }
  if (typeof e.session_id === "string" && e.session_id !== call.session) return;
  if (typeof e.turn_id === "string") await own(call, "openai", "agent_turn", e.turn_id);
  if (typeof e.turn?.id === "string") await own(call, "openai", "agent_turn", e.turn.id);
  if (typeof e.turn?.subagent_id === "string") await own(call, "openai", "agent_subagent", e.turn.subagent_id);
  if (e.type === "agent.session.subagent.created" && typeof e.subagent?.id === "string") await own(call, "openai", "agent_subagent", e.subagent.id);
  // The turn's own count first: the event's `usage` is only the root agent's during the turn, which for a helper's turn isn't the helper's.
  if (/^agent\.session\.turn\.(completed|failed|cancelled)$/.test(e.type ?? "") && typeof e.turn_id === "string") turnTokens(call, call.session, e.turn_id, e.turn?.usage ?? e.usage);
  if (e.type === "agent.session.turn.item.done") await countWebSearch(call, call.session, e.item);
  if (e.type === "agent.session.turn.cancelled" && typeof e.turn_id === "string" && call.session && !e.turn?.subagent_id) {
    const why = await verdict(call.session, e.turn_id);
    if (why) return { ...e, type: "agent.session.turn.failed", turn: { ...(e.turn ?? {}), status: "failed", error: why } };
  }
  return undefined;
}

/** The events posted to a task (POST …/events): anything but a cancel is work, which starts a turn. */
const postsWork = (call: Call) => {
  const list = isObject(call.json) && Array.isArray(call.json.events) ? call.json.events : [];
  return !list.length || list.some((ev) => !isObject(ev) || ev.type !== "agent.session.input.cancel");
};

/** Exactly the OpenAI endpoints the app uses (lib/server/chat, sessions, call, phone, memory, watches, images, transcribe.ts). */
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
      readToEnd: true,
      check: responsesTools,
      json: (call, data) => recordResponse(call, data as ResponseObject, true),
      event: (call, data) => {
        const e = data as { type?: string; response?: ResponseObject };
        return recordResponse(call, e.response, /^response\.(completed|incomplete|failed)$/.test(e.type ?? ""));
      },
    }),
    // The chat's mic: a recording made text. Only gpt-transcribe (its price is known), answered as JSON (so its seconds are read), not streamed.
    rule("POST v1/audio/transcriptions", {
      upload: true,
      spends: true,
      readToEnd: true,
      check: (call) => {
        if (!call.upload) throw new HttpError(400, "Send the recording as a file upload.");
        if (formField(call, "model") !== "gpt-transcribe") throw new HttpError(400, "Bops Cloud only transcribes with gpt-transcribe.");
        if (!["json", undefined].includes(formField(call, "response_format"))) throw new HttpError(400, "Ask for a JSON answer.");
        if (!["false", undefined].includes(formField(call, "stream"))) throw new HttpError(400, "Bops Cloud doesn't stream transcriptions.");
      },
      json: (call, data) => counted(recordTranscription(call.user.id, isObject(data) ? data : {}, { model: "gpt-transcribe", botId: call.bot })),
    }),
    // A bot's picture, made or edited (an edit sends the pictures it starts from as a file upload). Only image models whose price is known; never streamed.
    rule("POST v1/images/generations", {
      spends: true,
      readToEnd: true,
      check: (call) => {
        const body = isObject(call.json) ? call.json : {};
        if (!imageModelPriced(body.model)) throw new HttpError(400, "Bops Cloud only makes images with gpt-image-2.5-flare or gpt-image-2.5-sunburst.");
        if (body.stream) throw new HttpError(400, "Bops Cloud doesn't stream images.");
        imageAsk(body.n, body.size, body.quality);
      },
      json: (call, data) => counted(recordImages(call.user.id, isObject(data) ? data : {}, { model: isObject(call.json) ? call.json.model : undefined, botId: call.bot })),
    }),
    rule("POST v1/images/edits", {
      upload: true,
      spends: true,
      readToEnd: true,
      check: (call) => {
        if (!call.upload) throw new HttpError(400, "Send the images as a file upload.");
        if (!imageModelPriced(formField(call, "model"))) throw new HttpError(400, "Bops Cloud only edits images with gpt-image-2.5-flare or gpt-image-2.5-sunburst.");
        if (!["false", undefined].includes(formField(call, "stream"))) throw new HttpError(400, "Bops Cloud doesn't stream images.");
        imageAsk(formField(call, "n"), formField(call, "size"), formField(call, "quality"));
      },
      json: (call, data) => counted(recordImages(call.user.id, isObject(data) ? data : {}, { model: formField(call, "model"), botId: call.bot })),
    }),
    // A call in the app: the live session it makes is the user's (a phone call's is recorded by /hooks/openai).
    // Its audio goes from the browser to OpenAI, so the cloud listens on the session's sideband for its seconds (watchLive).
    rule("POST v1/live/sessions", {
      spends: true,
      json: async (call, data) => {
        const id = (data as { session?: { id?: unknown } }).session?.id;
        if (typeof id !== "string") return;
        await own(call, "openai", "live_session", id);
        const transport = isObject(call.json) && isObject(call.json.transport) ? call.json.transport.type : undefined;
        if (transport === "webrtc") watchLive(call.user.id, id, call.bot);
      },
    }),
    rule("POST v1/live/sessions/:live/accept", { own: ["live"], spends: true }),
    rule("POST v1/live/sessions/:live/reject", { own: ["live"] }),
    rule("POST v1/live/sessions/:live/hangup", { own: ["live"] }),
    // A task: the session's model and bot are kept with it, for pricing its turns and counting them for the bot.
    // Its turns are held to the user's credit while they run (turn-guard.ts): it needs room for the first few seconds of one
    // (admitTurn: 402, 403 or 429), and it's read to the end, so a session made for a Mac that went away is still the user's, and watched.
    rule("POST v1/agents/sessions", {
      readToEnd: true,
      check: async (call) => void (call.start = await admitTurn(call.user.id, undefined, modelAsked(call))),
      json: async (call, data) => {
        const s = data as { id?: unknown; object?: unknown };
        if (s.object !== "agent.session" || typeof s.id !== "string") return;
        await own(call, "openai", "agent_session", s.id, modelAsked(call), call.bot);
        watchSession(call.user.id, s.id, modelAsked(call), call.bot);
        call.start?.session(s.id);
      },
      event: agentEvent,
    }),
    rule("GET v1/agents/sessions/:session/events", {
      own: ["session"],
      // The cloud sets a stopped task going again only while the Mac follows it (turn-guard.ts).
      follow: (call) => follow(call.params.session),
      event: (call, data) => {
        call.session = call.params.session;
        return agentEvent(call, data);
      },
    }),
    // A message to a task: held to the user's credit while it runs (turn-guard.ts), and read back once it's done (reconcile.ts),
    // both from before it's sent, so a Mac that hangs up can't skip them. Cancelling never needs credit, and is the user's Stop.
    rule("POST v1/agents/sessions/:session/events", {
      own: ["session"],
      check: async (call) => {
        if (postsWork(call)) call.start = await admitTurn(call.user.id, call.params.session, (await turnInfo(call, call.params.session)).model);
      },
      before: async (call) => {
        counted(sessionUsed(call.params.session));
        if (!postsWork(call)) return userStopped(call.params.session);
        const { model, botId } = await turnInfo(call, call.params.session);
        watchSession(call.user.id, call.params.session, model, botId);
      },
    }),
    rule("GET v1/agents/sessions/:session/turns/:turn", {
      own: ["session", "turn"],
      json: (call, data) => {
        const t = data as { object?: unknown; status?: unknown; usage?: unknown };
        if (t.object === "agent.session.turn" && ["completed", "failed", "cancelled"].includes(String(t.status))) turnTokens(call, call.params.session, call.params.turn, t.usage);
      },
    }),
    rule("GET v1/agents/sessions/:session/items", { own: ["session"], json: webSearchesIn }),
    // Whether a turn is running (lib/server/sessions.ts steeredOn: a reply that came as a turn ended may have started another).
    rule("GET v1/agents/sessions/:session", { own: ["session"] }),
    rule("GET v1/agents/sessions/:session/subagents", {
      own: ["session"],
      json: async (call, data) => {
        const list = (data as { data?: unknown }).data;
        if (Array.isArray(list))
          for (const s of list as { id?: unknown; object?: unknown }[])
            if (s?.object === "agent.session.subagent" && typeof s.id === "string") await own(call, "openai", "agent_subagent", s.id);
      },
    }),
    rule("GET v1/agents/sessions/:session/subagents/:subagent/items", { own: ["session", "subagent"], json: webSearchesIn }),
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
/**
 * A number is bought by area code (the app searches first, GET v1/numbers/available, but there's no
 * buying one exact number), and an area code with none left is refused ("No numbers available in
 * area code 415"). Then the next one nearby is asked for, and in the end any US number (no area code).
 */
const NEARBY_AREA_CODES = ["415", "628", "650", "510", "408", "669", "925", "707", "916", "213", "310", "323", "818", "206", "503", "720", "512", "646", "917"];
const areaTried = new WeakMap<Call, string[]>();

function anotherAreaCode(call: Call, status: number, body: string): boolean {
  const ask = call.json as { areaCode?: unknown } | undefined;
  if (status >= 500 || !ask || typeof ask !== "object" || !/no numbers available/i.test(body)) return false;
  const tried = areaTried.get(call) ?? [];
  if (typeof ask.areaCode !== "string" || !ask.areaCode) return false;
  tried.push(ask.areaCode);
  areaTried.set(call, tried);
  const next = NEARBY_AREA_CODES.find((c) => !tried.includes(c));
  if (next) ask.areaCode = next;
  else delete ask.areaCode;
  console.log(`[proxy] ${call.user.id}: no numbers left in ${tried.at(-1)}, asking for ${next ?? "any area code"}`);
  return true;
}

async function recordBought(call: Call, data: unknown) {
  for (const n of numbersIn(data)) {
    const kept = await recordLine(call.user.id, n, { open: true }).then(
      () => true,
      (e: unknown) => {
        lineNotKept(call)(e as Error);
        return false;
      },
    );
    if (kept) trackCloudEvent(call.user.id, "bops_phone_number_added", { added_via: "app" }, { once: n.id });
  }
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

/** A text out from a plan's number that's paused (the plan ended) or given back is refused, as calls and texts to it go unanswered (plans.ts). */
async function notFromPausedNumber(call: Call) {
  const body = isObject(call.json) ? call.json : {};
  const id = (x: unknown) => (typeof x === "string" ? x : "");
  if (await sendingStopped(call.user.id, id(body.number_id ?? body.numberId), id(body.agent_id ?? body.agentId)))
    throw new HttpError(402, "This number is paused while you're on Free. Upgrade to text from it again.", { code: PLAN_REQUIRED, upgrade: true });
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
    // Numbers for sale (by area code, or anywhere in the country): read only, nothing bought, so no credit asked. Before "v1/numbers/:number", which it would otherwise be taken for.
    rule("GET v1/numbers/available"),
    // Buying a number needs credit for its month: an iMessage line's is far more than a number's. With
    // plan limits on, a number is bought only while the plan has room for it (Free none, Pro 1, Max 5,
    // the main bot's from the plan included; plans.ts), and the main bot's own purchase never makes a
    // second next to the plan's.
    rule("POST v1/numbers", {
      check: async (call) => {
        await requireRoomForNumber(call.user.id, call.orgoKey);
        await refuseSecondPlanNumber(call.user.id, isObject(call.json) ? (call.json.externalId ?? call.json.external_id) : undefined);
      },
      spends: true,
      retry: anotherAreaCode,
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
    rule("POST v1/messages", { check: notFromPausedNumber, spends: true, done: countText }),
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

/**
 * Honcho calls that do work, counted by route at Honcho's price (pricing.ts, $0 until it's set): a
 * question about the user (a peer's chat), a search, and messages saved. Reads and setup aren't.
 */
function countHoncho(call: Call) {
  if (call.method !== "POST") return;
  const last = call.path.at(-1);
  // Messages saved, or a file uploaded as messages; a list of them (messages/list) is a read.
  const route = last === "chat" ? "chat" : last === "search" ? "search" : last === "messages" || (last === "upload" && call.path.at(-2) === "messages") ? "messages" : undefined;
  if (route) counted(recordUsage(call.user.id, "honcho.calls", 1, { route, ...(call.bot ? { botId: call.bot } : {}) }));
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
    rule("* v3/workspaces/:workspace/*", { check: workspaceInPath, done: countHoncho }),
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

/**
 * A tool run through Composio (an action in an app, a session's tool, or a call to an app's own API),
 * counted once it's answered, by tool, app and bot (the Mac's x-bops-app and x-bops-bot; a session's
 * tool is for the bot the session was made for), at Composio's price (pricing.ts: $0 while it's negotiated).
 */
const countComposio = (tool: (call: Call) => string) => (call: Call) =>
  counted(
    (async () => {
      const botId = call.bot ?? (call.params.session ? (await objectInfo("composio", call.params.session)).botId : null);
      await recordUsage(call.user.id, "composio.calls", 1, { tool: tool(call), ...(call.app ? { app: call.app } : {}), ...(botId ? { botId } : {}) });
    })(),
  );

/** The tool a session's execute names (tool_slug in its body). */
const sessionTool = (call: Call) => {
  const body = isObject(call.json) ? call.json : {};
  const slug = body.tool_slug ?? body.toolSlug ?? body.slug;
  return typeof slug === "string" ? slug.slice(0, 120) : "session";
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
        if (typeof id === "string") await own(call, "composio", "tool_router_session", id, undefined, call.bot);
      },
    }),
    rule("GET api/v3.1/tool_router/session/:session", { own: ["session"] }),
    rule("POST api/v3.1/tool_router/session/:session/search", { own: ["session"] }),
    rule("POST api/v3.1/tool_router/session/:session/execute", {
      own: ["session"],
      done: countComposio(sessionTool),
      // Which of the session's accounts to use: only one of the user's.
      check: async (call) => {
        const account = isObject(call.json) ? call.json.account : undefined;
        if (account !== undefined) await mustOwn("composio", call, typeof account === "string" ? account : "");
      },
    }),
    // An app's own API through the user's account (Slack's chat.postMessage and auth.test, an app's "who am I").
    rule("POST api/v3.1/tools/execute/proxy", { check: namesAccount, done: countComposio(() => "proxy") }),
    // One action in one of the user's accounts, or in an app that needs no account.
    rule("POST api/v3.1/tools/execute/:tool", { check: asUser([]), done: countComposio((call) => call.params.tool) }),
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

/**
 * Jev, Typesafe's decision model: each answer's input tokens at its model's price (Typesafe's answer
 * says both; when it doesn't, the tokens are estimated from the question's size). Its answer is read
 * to the end even when the Mac stopped waiting (decide() gives up at 8 s): Typesafe bills it anyway.
 */
const typesafe: Spec = {
  name: "Typesafe",
  key: config.typesafeKey,
  upstream: config.upstream.typesafe,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  body: "json",
  timeoutMs: 60_000,
  rules: [
    rule("POST v1/systemone", {
      spends: true,
      readToEnd: true,
      json: (call, data) => {
        const bytes = call.json === undefined ? 0 : Buffer.byteLength(JSON.stringify(call.json));
        counted(recordJev(call.user.id, isObject(data) ? data : {}, bytes, { botId: call.bot }));
      },
    }),
  ],
};

/* ---------------- treg ---------------- */

/** What one treg catalog endpoint is, as the cloud checks a call to it (GET /catalog/endpoints/{id}, open). */
type TregEndpoint = { method: string; scope: string; kind: string; async: boolean; usd: number; eligible: boolean };

/** treg's catalog entries, by endpoint id, for an hour (null: no such endpoint). */
const tregCatalog = new Map<string, { at: number; entry: TregEndpoint | null }>();
const TREG_CATALOG_TTL = 60 * 60_000;

/** The kinds of catalog endpoint bots may call: a provider's data, treg's routed ones (several providers behind one), and free helpers. Never a team's own tools or another team's hub tools. */
const TREG_KINDS = new Set(["data", "routed", "utility"]);

async function tregEndpoint(id: string): Promise<TregEndpoint | null> {
  const hit = tregCatalog.get(id);
  if (hit && Date.now() - hit.at < TREG_CATALOG_TTL) return hit.entry;
  const r = await fetch(`${config.upstream.treg().replace(/\/+$/, "")}/catalog/endpoints/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!r || (!r.ok && r.status !== 404)) throw new HttpError(502, "Couldn't reach treg's catalog.");
  const data = r.ok ? ((await r.json().catch(() => null)) as { endpoint?: Record<string, unknown>; usd_per_call?: unknown } | null) : null;
  const e = data?.endpoint;
  const entry: TregEndpoint | null =
    e && e.id === id
      ? {
          method: String(e.method ?? "GET").toUpperCase(),
          scope: String(e.scope ?? ""),
          kind: String(e.kind ?? ""),
          async: !!e.async,
          usd: Math.max(0, Number(data?.usd_per_call ?? (e.cost as { usd?: unknown } | undefined)?.usd) || 0),
          // On treg's platform keys (a team's own key answers at no cost to the user, on Orgo's provider bill), and not replaced.
          eligible: e.platform_eligible !== false && !e.superseded_by,
        }
      : null;
  if (tregCatalog.size > 5_000) tregCatalog.clear();
  tregCatalog.set(id, { at: Date.now(), entry });
  return entry;
}

/** The most one treg call may cost, in dollars, when the Mac doesn't say (x-treg-route-max-cost), and the most it may ever say. */
const TREG_CALL_CAP = 0.1;
const TREG_CALL_MOST = 5;
/** treg calls a user may have on their way at once. */
const TREG_AT_ONCE = 3;
/**
 * Each user's treg calls on their way: how many, and the most they may cost together (micro-dollars).
 * Held against the user's credit until each is counted, so calls at once can't spend past it (each was
 * capped at the whole of what's left), nor past Orgo's treg balance.
 */
const tregHeld = new Map<string, { n: number; micros: number }>();

/** Each user's treg calls being capped, one at a time, so each sees the holds of the ones before it. */
const tregTurns = new Map<string, Promise<unknown>>();

/**
 * A treg call's cap (dollars): what it asked, at most what's left of the user's credit once their other
 * calls on their way are paid for, held until it's counted (Call.release, given back by handle). At most
 * TREG_AT_ONCE at a time per user.
 */
function holdForTreg(call: Call, asked: number): Promise<number> {
  const user = call.user.id;
  const decide = async () => {
    const held = tregHeld.get(user) ?? { n: 0, micros: 0 };
    if (held.n >= TREG_AT_ONCE) throw new HttpError(429, "Too many business data lookups at once. Try again in a moment.");
    const cap = creditsOn() ? Math.min(asked, Math.max(0, (await creditLeft(user)) - held.micros) / 1_000_000) : asked;
    if (cap <= 0) throw held.n > 0 ? new HttpError(429, "Your other business data lookups are using what's left of your AI credit. Try again in a moment.") : outOfCredit();
    const mine = Math.ceil(cap * 1_000_000);
    held.n += 1;
    held.micros += mine;
    tregHeld.set(user, held);
    let given = false;
    call.release = () => {
      if (given) return;
      given = true;
      held.n -= 1;
      held.micros -= mine;
      if (held.n <= 0 && tregHeld.get(user) === held) tregHeld.delete(user);
    };
    return cap;
  };
  const turn = (tregTurns.get(user) ?? Promise.resolve()).then(decide, decide);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  tregTurns.set(user, settled);
  void settled.then(() => tregTurns.get(user) === settled && tregTurns.delete(user));
  return turn;
}

/** A value treg keeps as a tag (X-Treg-Meta): letters, digits, ". _ - :" only, at most 128, never like an email. */
const tregTag = (v: string) => v.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);

/**
 * A call to one catalog endpoint: it must be in treg's catalog (data, routed or a free helper), on
 * treg's own keys (never one that needs an account connected to treg: those would be Orgo's team's),
 * and not a long-running job. It's tagged with the user and bot (X-Treg-Meta, set here, never by the
 * Mac) and capped (X-Treg-Route-Max-Cost): what the Mac asked, at most TREG_CALL_MOST and what's left
 * of the user's credit.
 */
async function tregCall(call: Call) {
  const id = call.params.endpoint;
  const e = await tregEndpoint(id);
  if (!e || !TREG_KINDS.has(e.kind)) throw new HttpError(404, `${id} isn't in treg's catalog.`);
  if (e.scope === "own_account") throw new HttpError(403, `${id} needs an account connected to treg, which Bops doesn't offer yet.`);
  if (e.async) throw new HttpError(403, `${id} is a long-running job, which Bops doesn't run through treg yet.`);
  if (!e.eligible) throw new HttpError(403, `${id} isn't available to Bops (it's replaced, or not on treg's own keys).`);
  if (e.method !== call.method) throw new HttpError(405, `${id} takes ${e.method}.`);
  const said = Number([call.asked["x-treg-route-max-cost"]].flat()[0]);
  const cap = await holdForTreg(call, Math.min(Number.isFinite(said) && said > 0 ? said : TREG_CALL_CAP, TREG_CALL_MOST));
  call.headers["x-treg-route-max-cost"] = cap.toFixed(6);
  // One token for every user: their replay keys must never meet (treg keeps replays by team and key).
  const replay = [call.asked["idempotency-key"]].flat()[0];
  if (replay) call.headers["idempotency-key"] = `${tregTag(call.user.id)}:${String(replay).slice(0, 200)}`;
  // Providers a routed endpoint should skip (treg.ts: ones whose answers don't fit a job).
  const skip = [call.asked["x-treg-route-exclude"]].flat()[0];
  if (skip && /^[a-z0-9_-]+(, ?[a-z0-9_-]+)*$/.test(skip)) call.headers["x-treg-route-exclude"] = skip;
  call.headers["x-treg-meta"] = [`customer=${tregTag(call.user.id)}`, ...(call.bot ? [`bot=${tregTag(call.bot)}`] : [])].join(", ");
}

/** What treg's own refusals may say to a user: its estimate against the cap is fine; anything about Orgo's balance or limits isn't. */
function tregRefused(call: Call, status: number, headers: IncomingHttpHeaders, body: Buffer) {
  if (headers["x-treg-error"] !== "1") return undefined;
  let error: unknown;
  try {
    // treg puts its code at the top or under `detail` ({"detail": {"error": "route_max_cost", …}}).
    const said = JSON.parse(body.toString("utf8")) as { error?: unknown; detail?: { error?: unknown } };
    error = said.error ?? said.detail?.error;
  } catch {
    /* not JSON: treated as Orgo's own trouble below */
  }
  if (status === 402 && error === "route_max_cost") return undefined;
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 410 || status === 422) return undefined;
  // Orgo's treg balance or daily cap (402/429), or treg itself out of room: never passed on (it names Orgo's balance and a top-up link).
  console.warn(`[proxy] treg refused ${call.params.endpoint} for ${call.user.id}: ${status} ${String(error ?? body.toString("utf8").slice(0, 200))}`);
  return { status: 503, body: { error: "Business data isn't available right now. Try again in a little while.", code: "treg_unavailable" } };
}

/** Count a treg call, once by its call id, at what treg said it cost. A call it refused before the provider (X-Treg-Error) has no id and costs nothing. */
function countTreg(call: Call, _status: number, headers: IncomingHttpHeaders) {
  const callId = [headers["x-treg-call-id"]].flat()[0];
  if (!callId) return;
  const cost = Number([headers["x-treg-cost-micro"]].flat()[0]) || 0;
  const servedBy = [headers["x-treg-served-by"]].flat()[0];
  call.recording = recordTreg(call.user.id, callId, cost, { botId: call.bot, endpoint: call.params.endpoint, ...(servedBy ? { servedBy } : {}) });
  counted(call.recording);
}

const TREG_CALL: Omit<Rule, "method" | "pattern"> = {
  check: tregCall,
  spends: true,
  // Billed whether the Mac waits or not, so its answer is read to the end and counted.
  readToEnd: true,
  minCost: async (call) => Math.min((await tregEndpoint(call.params.endpoint))?.usd ?? 0, TREG_CALL_CAP) * 1_000_000,
  headers: countTreg,
  refused: tregRefused,
};

/**
 * treg (treg.to): the bots' business data (lib/server/treg.ts). Only calls to its catalog's endpoints
 * by id (/call/<endpoint-id>): never a team's own tools (/call/<tool>/<path>, or a URL), a hub tool,
 * or anything about Orgo's treg team (its balance, keys, members, budgets). The Mac reads the open
 * catalog (search, an endpoint's details) from treg directly.
 */
const treg: Spec = {
  name: "treg",
  key: config.tregToken,
  upstream: config.upstream.treg,
  auth: (key) => ({ "x-treg-token": key }),
  body: "json",
  timeoutMs: 2 * 60_000,
  rules: [rule("GET call/:endpoint", TREG_CALL), rule("POST call/:endpoint", TREG_CALL)],
};

const SPECS: Record<Provider, Spec> = { openai, agentphone, honcho, composio, typesafe, treg };

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

/** Send the call on and wait for the provider to start answering. The request is dropped if the Mac goes away first, unless the rule reads its answer to the end. */
function send(spec: Spec, key: string, call: Call, req: IncomingMessage, res: ServerResponse, body: Buffer | IncomingMessage | null, readToEnd = false): Promise<IncomingMessage> {
  const url = new URL(`${spec.upstream().replace(/\/+$/, "")}/${call.path.join("/")}${qs(call.query)}`);
  // identity: answers must be readable here, to record what they make.
  const headers: OutgoingHttpHeaders = { ...requestHeaders(req.headers), ...spec.auth(key), ...call.headers, "accept-encoding": "identity" };
  if (Buffer.isBuffer(body)) {
    // A file upload goes as it came (its content type names its boundary); anything else read here is JSON.
    if (!call.upload) headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  } else if (body && req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  return new Promise((resolve, reject) => {
    const up = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: call.method, headers });
    const timer = setTimeout(() => up.destroy(new HttpError(504, `${spec.name} took too long to answer.`)), spec.timeoutMs);
    res.on("close", () => {
      if (!res.writableFinished && !readToEnd) up.destroy();
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

/** An event as sent, with other data (and its `event:` line, if it had one, naming the new type). Its other lines stay. */
function withData(raw: Buffer, data: unknown): Buffer {
  const lines = raw.toString("utf8").split(/\r\n|\r|\n/).filter((l) => l && !l.startsWith("data:"));
  const type = isObject(data) && typeof data.type === "string" ? data.type : undefined;
  const kept = lines.map((l) => (l.startsWith("event:") && type ? `event: ${type}` : l));
  return Buffer.from(`${[...kept, `data: ${JSON.stringify(data)}`].join("\n")}\n\n`);
}

/** Stream events on as they come, each after the rule has seen it (and as it says, when it changes one). */
async function streamEvents(rule: Rule, call: Call, up: IncomingMessage, res: ServerResponse, readable: boolean) {
  res.writeHead(up.statusCode ?? 200, responseHeaders(up.headers));
  res.flushHeaders();
  // Followed until the Mac goes away (seen at once, even while an event is held) or the stream ends.
  const unfollow = rule.follow?.(call);
  if (unfollow) {
    if (res.destroyed) unfollow();
    else res.once("close", unfollow);
  }
  const split = readable ? new EventSplitter() : null;
  let gone = false;
  try {
    for await (const chunk of up as AsyncIterable<Buffer>) {
      for (const part of split ? split.push(chunk) : [{ raw: chunk, data: undefined }]) {
        let raw = part.raw;
        if (part.data !== undefined) {
          const instead = await Promise.resolve(rule.event!(call, part.data)).catch((e: Error) => void console.warn(`[proxy] event: ${e.message}`));
          if (instead !== undefined) raw = withData(part.raw, instead);
        }
        if (gone || (await write(res, raw))) continue;
        // The Mac went away: a rule that reads to the end (a model's answer, billed either way) reads the rest unsent, to record it.
        if (!rule.readToEnd) return void up.destroy();
        gone = true;
      }
    }
    if (!gone) {
      const rest = split?.rest();
      if (rest?.length) await write(res, rest);
      res.end();
    }
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
  // The Mac went away while it was read (a rule that reads to the end): recorded, with nobody to send it to.
  if (res.destroyed) {
    await rule.done?.(call);
    return;
  }
  res.writeHead(up.statusCode ?? 200, { ...responseHeaders(up.headers, ["content-length"]), "content-length": String(out.length) });
  res.end(out);
  await rule.done?.(call);
}

async function answer(spec: Spec, rule: Rule, call: Call, up: IncomingMessage, res: ServerResponse) {
  const status = up.statusCode ?? 502;
  const ok = status >= 200 && status < 300;
  rule.headers?.(call, status, up.headers);
  // A hold on the credit (a treg call's) goes back once what the call cost is recorded, before the Mac
  // hears back: its next call finds the room.
  if (call.release) {
    await call.recording?.catch(() => {});
    call.release();
  }
  if (!ok && rule.refused) {
    const raw = await readAll(up, MAX_BODY, spec.name);
    const instead = rule.refused(call, status, up.headers, raw);
    const out = instead ? Buffer.from(JSON.stringify(instead.body)) : raw;
    const headers = instead ? { "content-type": "application/json" } : responseHeaders(up.headers, ["content-length"]);
    res.writeHead(instead?.status ?? status, { ...headers, "content-length": String(out.length) });
    return void res.end(out);
  }
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

/** A bot id or a kind of work as the Mac names them: plain and short, else not kept. */
const USAGE_TAG = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Which bot, kind of work and app the Mac says a call is for (x-bops-bot, x-bops-source, x-bops-app), for counting it. Never sent on (not in PASS_REQUEST). */
function usageHeaders(req: IncomingMessage): Pick<Call, "bot" | "source" | "app"> {
  const one = (name: string) => {
    const v = req.headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    return s && USAGE_TAG.test(s) ? s : undefined;
  };
  const bot = one(USAGE_BOT_HEADER);
  const source = one(USAGE_SOURCE_HEADER);
  const app = one(USAGE_APP_HEADER);
  return { ...(bot ? { bot } : {}), ...(source && MAC_SOURCES.has(source) ? { source } : {}), ...(app ? { app } : {}) };
}

/**
 * The kinds of work the Mac may name (lib/server/usage.ts usageTags). Never "agent", "phone" or
 * "responses": those are the cloud's own, and "agent" is priced as a summed turn (never at
 * long-context rates, pricing.ts), so a Mac that said it would pay less for one long answer.
 */
const MAC_SOURCES = new Set(["chat", "session", "memory", "call", "decide"]);

async function handle(provider: Provider, prefix: string, req: IncomingMessage, res: ServerResponse, user: CloudUser) {
  const spec = SPECS[provider];
  const key = spec.key();
  if (!key) throw new HttpError(503, `${spec.name} isn't set up on this cloud.`);
  const { path, query: q } = target(req.url, prefix);
  const call: Call = { user, orgoKey: bearer(req), method: req.method ?? "GET", path, params: {}, query: q, headers: {}, owned: new Set(), asked: req.headers, ...usageHeaders(req) };
  const r = match(spec, call);
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw new HttpError(413, "Request too large");
  let body: IncomingMessage | null = null;
  if (hasBody(req)) {
    if (r.upload && isUpload(req)) call.upload = await readUpload(req);
    else if (spec.body === "json" || (spec.body === "json-or-upload" && !isUpload(req))) call.json = parseBody(await readBody(req, MAX_BODY));
    else body = req;
  }
  try {
    await sendOn(provider, spec, key, r, call, req, res, user, body);
  } finally {
    // What the call held on the user's credit (a treg call) goes back once what it cost is recorded.
    if (call.release) await call.recording?.catch(() => {});
    call.release?.();
  }
}

/** handle's work once the request is read: its checks, the credit, and sending it on and answering. */
async function sendOn(provider: Provider, spec: Spec, key: string, r: Rule, call: Call, req: IncomingMessage, res: ServerResponse, user: CloudUser, body: IncomingMessage | null) {
  await spec.check?.(call);
  for (const name of r.own ?? []) await mustOwn(provider, call, call.params[name]);
  await r.check?.(call);
  // Last before it's sent: a call that isn't allowed is refused for that, not for the credit.
  if (r.spends) await requireCredit(user.id, await r.minCost?.(call));
  await r.before?.(call);
  // A turn that doesn't start gives back what was set aside for it (turn-guard.ts admitTurn).
  let up: IncomingMessage;
  try {
    up = await send(spec, key, call, req, res, call.upload?.body ?? (call.json === undefined ? body : Buffer.from(JSON.stringify(call.json))), r.readToEnd);
  } catch (e) {
    call.start?.release();
    throw e;
  }
  // A rule may ask again with a changed request (another area code when one has no numbers left).
  for (let tries = 0; r.retry && call.json !== undefined && (up.statusCode ?? 502) >= 400 && tries < 12; tries++) {
    const raw = await readAll(up, MAX_BODY, spec.name);
    if (!r.retry(call, up.statusCode ?? 502, raw.toString("utf8"))) {
      res.writeHead(up.statusCode ?? 502, { ...responseHeaders(up.headers, ["content-length"]), "content-length": String(raw.length) });
      return void res.end(raw);
    }
    up = await send(spec, key, call, req, res, Buffer.from(JSON.stringify(call.json)), r.readToEnd);
  }
  if ((up.statusCode ?? 502) >= 300) call.start?.release();
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

/** How long OpenAI says the call has run, from a sideband message (usage.ts liveSecondsOf). */
const liveSeconds = (data: RawData) => liveSecondsOf(data.toString());

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
    if (seconds) counted(recordUsageFor(userId, "openai.live_seconds", sessionId, seconds, { transport: "sip" }));
  });
  client.on("error", () => upstream.terminate());
  upstream.on("error", () => client.terminate());
}

/** The in-app calls the cloud is listening to (watchLive), so one is never counted twice. Tests shorten the timings. */
const listening = new Set<string>();
export const liveWatch = { maxMs: 2 * 60 * 60_000, recordEveryMs: 30_000, retryMs: 2_000, tries: 3 };

/**
 * A call in the app (GPT-Live over WebRTC): its audio goes from the browser straight to OpenAI, so
 * nothing of it passes through the cloud. The cloud attaches to the session's sideband with its own
 * key as a listener only (it never sends anything) and counts the seconds OpenAI reports
 * (session.usage.updated, and session.closed's final count) as openai.live_seconds, by the session's
 * id, every 30 seconds or so: once that leaves the user's AI credit used up, the cloud hangs the call
 * up. A call the Mac attaches a sideband to itself (a phone call) is counted by the bridge instead.
 */
function watchLive(userId: string, sessionId: string, botId: string | undefined, attempt = 1) {
  const key = config.openaiKey();
  if (!key || (attempt === 1 && listening.has(sessionId))) return;
  listening.add(sessionId);
  let seconds = 0;
  let recorded = 0;
  let lastAt = 0;
  let opened = false;
  let ended = false;
  const record = () => {
    if (seconds <= recorded) return;
    recorded = seconds;
    lastAt = Date.now();
    counted(recordUsageFor(userId, "openai.live_seconds", sessionId, seconds, { transport: "webrtc", ...(botId ? { botId } : {}) }).then(() => (ended ? undefined : hangUpWhenOut(userId, sessionId))));
  };
  const url = `${config.upstream.openai().replace(/\/+$/, "").replace(/^http/, "ws")}/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` }, followRedirects: false, maxPayload: MAX_BODY, handshakeTimeout: 15_000 });
  const limit = setTimeout(() => ws.close(), liveWatch.maxMs);
  limit.unref?.();
  ws.on("open", () => (opened = true));
  ws.on("message", (data, binary) => {
    if (binary) return;
    seconds = Math.max(seconds, liveSeconds(data));
    if (data.toString().includes("session.closed") || Date.now() - lastAt >= liveWatch.recordEveryMs) record();
  });
  ws.on("close", () => {
    clearTimeout(limit);
    ended = true;
    record();
    // It couldn't attach yet (the call is still connecting): a few more tries, then it's left uncounted, and logged.
    if (!opened && attempt < liveWatch.tries) setTimeout(() => watchLive(userId, sessionId, botId, attempt + 1), liveWatch.retryMs).unref?.();
    else {
      listening.delete(sessionId);
      if (!opened) console.warn(`[proxy] ${userId}'s call ${sessionId}: couldn't listen for its seconds`);
    }
  });
  ws.on("error", () => {});
}

/** Hang up an in-app call whose seconds used up the user's AI credit (with the cloud's key: the call's audio never passes through it). */
async function hangUpWhenOut(userId: string, sessionId: string) {
  if (!creditsOn() || (await creditLeft(userId)) > 0) return;
  const res = await fetch(`${config.upstream.openai().replace(/\/+$/, "")}/v1/live/sessions/${encodeURIComponent(sessionId)}/hangup`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiKey()}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  await res.body?.cancel().catch(() => {});
  console.log(`[proxy] ${userId}'s call ${sessionId}: out of AI credit, hung up (${res.status})`);
}

async function attach(req: IncomingMessage, socket: Duplex, head: Buffer, user: CloudUser) {
  const key = config.openaiKey();
  if (!key) throw new HttpError(503, "OpenAI isn't set up on this cloud.");
  const { path, query: q } = target(req.url, "/proxy/openai");
  const params = matchPath(["v1", "live", "sessions", ":live", "attach"], path);
  if (!params) throw new HttpError(404, "Not found");
  if ((await objectOwner("openai", params.live)) !== user.id) throw new HttpError(404, "Not found");
  await openaiRefs({ user, orgoKey: "", method: "GET", path, params, query: q, headers: {}, owned: new Set(), asked: {} });
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
